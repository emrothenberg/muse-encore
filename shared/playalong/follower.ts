/*
 * SPDX-License-Identifier: GPL-3.0-only
 * The score following of the playalong (not in MuseScore): from the notes heard (grouped into chords) it finds the
 * measure the player is in. The expected notes are the events of the measures in the played order (repeats unrolled,
 * playalongMeasures). Probabilistic alignment (Viterbi, max-product): every event near the current measure has a log
 * score for "the last chord played was this event". A new chord moves each position to the next event (the normal
 * case), further ahead (missed notes: a penalty per event, more for skipping the end of a measure), keeps it (an extra
 * or wrong note, or the same chord again), or jumps to the start of a measure near it (practice mode: also back). The
 * chord's similarity to the event (tolerant: octave errors, notes a semitone off, partial chords, a learned tuning
 * offset) and its timing (the tempo is estimated from the matches; much too early is unlikely, late is fine) are
 * added. The measure shown changes when a position in another measure is clearly better than the best one in the
 * current measure, so single wrong notes do not move it, while missed notes do not block it.
 * Pure logic without the DOM (tested in test/playalong.test.ts).
 */
import type { PlayalongMeasure } from '../../src/index'

export type PlayalongMode = 'follow' | 'practice'

/** an expected event in the played order */
interface FlatEvent {
    measure: number
    /** in the played order */
    utick: number
    pitches: number[]
}

// log scores of the transitions
/** missed events: per event skipped */
const SKIP = -1.2
/** events skipped at the end of a measure when going into the next one (its end should be played) */
const SKIP_MEASURE_END = -3.5
/** the most events skipped at once; when the time since the last chord fits (the timing match from TIME_SKIP_MATCH on) */
const MAX_SKIP = 4
const MAX_TIME_SKIP = 64
const TIME_SKIP_MATCH = 0.3
/** skipping events (and the end of a measure, jumps ahead) is cheaper by this part when the time fits */
const TIME_SKIP_DISCOUNT = 0.75
/** the most measures ahead the time since the last chord can reach */
const MAX_TIME_AHEAD_MEASURES = 16
/** the chord belongs to no event (an extra or wrong note): the position stays */
const STAY = -1
const INSERT_EMISSION = Math.log(0.1)
/** the same chord again (repeated, or detected twice) */
const REPEAT = -1.5
/** a jump to the start of a measure: base and per measure of distance (in the played order) */
const JUMP = -5
const JUMP_PER_MEASURE = -1
/** the restart of the current measure (practice mode) */
const RESTART = -4
/** the floor of the similarity of a chord to an event (a chord that does not fit at all) */
const EMISSION_FLOOR = 0.02
/** the weight of the timing fit */
const TIMING_WEIGHT = 1.5
/** a position in another measure must be better by this than the best one in the current measure */
const SWITCH_MARGIN = 1.5
const JUMP_SWITCH_MARGIN = 3
/** positions worse than the best by more than this are dropped */
const PRUNE = -40
/** the measures around the current one that are considered: back (practice mode only) and ahead */
const PRACTICE_BACK_MEASURES = 3
const AHEAD_MEASURES = 2
/** lost (the best position does not move for chords): the measures ahead grow by one per chord up to this */
const MAX_AHEAD_MEASURES = 8
/** matches needed to know the tempo; the recent ones it is estimated from */
const TEMPO_MIN_SAMPLES = 3
const TEMPO_SAMPLES = 8
/** a match from this similarity on is used for the tempo; for the tuning offset (a step ahead) */
const GOOD_MATCH = 0.6
const TUNING_MATCH = 0.3


/** how well a played pitch matches an expected one (transposed by the tuning offset) */
function pitchSimilarity(played: number, expected: number): number {
    const d = Math.abs(played - expected)
    if (d === 0) {
        return 1
    }
    if (d % 12 === 0) {
        return 0.35 // octave errors of the detection (overtones): alone not enough, supports a chord
    }
    if (d === 1) {
        return 0.45 // out of tune, or a neighbouring wrong note
    }
    return 0
}

/**
 * how well a played chord matches an event: its best note, more if it covers more of the expected notes, less if it
 * has more notes that are not expected
 */
export function chordSimilarity(played: readonly number[], expected: readonly number[], offset = 0): number {
    if (!played.length || !expected.length) {
        return 0
    }
    let best = 0
    let covered = 0
    for (const x of expected) {
        let bx = 0
        for (const p of played) {
            bx = Math.max(bx, pitchSimilarity(p + offset, x))
        }
        best = Math.max(best, bx)
        if (bx >= 1) {
            ++covered
        }
    }
    // notes played that are not expected (not even in another octave or a semitone off): less likely the same event
    let fitting = 0
    for (const p of played) {
        if (expected.some(x => [0, 1, 11].includes(((p + offset - x) % 12 + 12) % 12))) {
            ++fitting
        }
    }
    return best * (0.75 + 0.25 * covered / expected.length) * (0.7 + 0.3 * fitting / played.length)
}


export class PlayalongFollower {
    private readonly measures: readonly PlayalongMeasure[]
    private readonly events: FlatEvent[] = []
    /** the first event of each measure (or of the next measure with events) */
    private readonly measureFirstEvent: number[] = []
    /** the event after the last one of each measure */
    private readonly measureEndEvent: number[] = []
    private m_mode: PlayalongMode
    private m_measure = 0
    /** the log scores of the positions (the event of the last chord); null: no chord since the position was set */
    private scores: Map<number, number> | null = null
    /** the best position (event) after the last chord, and for how many chords it has not changed */
    private best = -1
    private bestUnchanged = 0
    /** the time of the last chord (-1: none) */
    private lastChordTime = -1
    /** the best position after the last chord and its time (for the tempo) */
    private lastBest = -1
    private lastBestTime = -1
    /** recent seconds per tick */
    private tempoSamples: number[] = []
    /** the tuning offset in semitones added to the played pitches */
    private m_offset = 0
    /** the differences expected - played of the recent good matches */
    private recentDiffs: number[] = []

    constructor(measures: readonly PlayalongMeasure[], mode: PlayalongMode = 'follow', startMeasure = 0) {
        this.measures = measures
        this.m_mode = mode
        for (const m of measures) {
            this.measureFirstEvent.push(this.events.length)
            for (const e of m.events) {
                this.events.push({ measure: m.index, utick: m.utick + e.tick - m.tick, pitches: e.pitches })
            }
            this.measureEndEvent.push(this.events.length)
        }
        this.setMeasure(startMeasure)
    }

    /** the measure (index in the played order) the player is in */
    measure(): number {
        return this.m_measure
    }

    mode(): PlayalongMode {
        return this.m_mode
    }

    setMode(mode: PlayalongMode): void {
        this.m_mode = mode
    }

    tuningOffset(): number {
        return this.m_offset
    }

    /** the estimated tempo in quarter notes per minute (null: not known yet) */
    tempo(): number | null {
        const spt = this.secondsPerTick()
        return spt ? 60 / (spt * 480) : null
    }

    /** goes to a measure (manually): the next chord is expected at its start */
    setMeasure(index: number): void {
        this.m_measure = Math.max(0, Math.min(index, this.measures.length - 1))
        this.scores = null
        this.lastBest = -1
        this.best = -1
        this.bestUnchanged = 0
    }

    next(): void {
        this.setMeasure(this.m_measure + 1)
    }

    prev(): void {
        this.setMeasure(this.m_measure - 1)
    }

    /**
     * a chord was played (the notes that started together) at a time in seconds (without a time the timing is not
     * used); returns true if the measure changed
     */
    onChord(pitches: readonly number[], time?: number): boolean {
        if (!pitches.length || !this.events.length) {
            return false
        }
        const before = this.m_measure
        const practice = this.m_mode === 'practice'
        // around the measure shown and the best position (the measure shown follows it with a delay); further ahead
        // when lost
        const anchor = this.best >= 0 ? this.events[this.best].measure : this.m_measure
        const low = Math.min(anchor, this.m_measure)
        const ahead = Math.min(MAX_AHEAD_MEASURES, AHEAD_MEASURES + Math.max(0, this.bestUnchanged - 1))
        const fromMeasure = practice ? this.measureWithEvents(low, -PRACTICE_BACK_MEASURES) : low
        let toMeasure = this.measureWithEvents(Math.max(anchor, this.m_measure), ahead)
        const spt = this.secondsPerTick()
        if (spt && time !== undefined && this.best >= 0 && this.lastChordTime >= 0) {
            // as far as the time since the last chord reaches
            const utick = this.events[this.best].utick + (time - this.lastChordTime) * 1.3 / spt
            while (toMeasure + 1 < this.measures.length && this.measures[toMeasure + 1].utick <= utick
                && toMeasure - anchor < MAX_TIME_AHEAD_MEASURES) {
                ++toMeasure
            }
        }
        const from = this.measureFirstEvent[fromMeasure]
        const to = this.measureEndEvent[toMeasure]
        const dt = time !== undefined && this.lastChordTime >= 0 ? time - this.lastChordTime : undefined

        const emission = new Map<number, number>()
        const emit = (e: number): number => {
            let v = emission.get(e)
            if (v === undefined) {
                v = Math.log(EMISSION_FLOOR + this.similarity(pitches, e))
                emission.set(e, v)
            }
            return v
        }
        const next = new Map<number, number>()
        const relax = (e: number, v: number): void => {
            if (e >= from && e < to && v > (next.get(e) ?? -Infinity)) {
                next.set(e, v)
            }
        }
        // jumps to the measure starts near a measure (in follow mode only ahead)
        const jumps = (m: number, score: number, after: number): void => {
            const last = Math.min(toMeasure, this.measureWithEvents(m, ahead))
            for (let j = Math.max(fromMeasure, practice ? this.measureWithEvents(m, -PRACTICE_BACK_MEASURES) : m + 1); j <= last; ++j) {
                const e = this.measureFirstEvent[j]
                if (e >= this.measureEndEvent[j] || (e > after && e <= after + MAX_SKIP + 1)) {
                    continue // no events, or reached by skipping
                }
                let cost = j === m && e <= after ? RESTART : JUMP + JUMP_PER_MEASURE * Math.max(0, this.measuresWithEventsBetween(m, j) - 1)
                if (e > after && after >= 0 && dt !== undefined) {
                    // ahead as far as the time since the last chord says
                    cost *= 1 - TIME_SKIP_DISCOUNT * this.timeMatch(after, e, dt)
                }
                relax(e, score + cost + emit(e))
            }
        }

        if (!this.scores) {
            // the start of the measure set (events missed at its start are skipped)
            const first = this.measureFirstEvent[this.m_measure]
            for (let k = 0; k <= MAX_SKIP && first + k < this.events.length; ++k) {
                relax(first + k, SKIP * k + emit(first + k))
            }
            jumps(this.m_measure, 0, first - 1)
        } else {
            for (const [s, score] of this.scores) {
                // an extra note, or the same chord again
                relax(s, score + Math.max(STAY + INSERT_EMISSION, REPEAT + emit(s)))
                // ahead: the next event, or further (missed events); when the time since the last chord fits skipping
                // events (missed notes, or measures the detection did not keep up with), skipping is cheaper and may go
                // further
                for (let k = 1; s + k < this.events.length && s + k < to; ++k) {
                    const e = s + k
                    const tm = dt !== undefined ? this.timeMatch(s, e, dt) : 0
                    if (k > MAX_SKIP + 1) {
                        // further only as far as the time reaches
                        if (k > MAX_TIME_SKIP || dt === undefined || !this.secondsPerTick() || this.expectedTime(s, e) > dt * 1.5) {
                            break
                        }
                        if (tm < TIME_SKIP_MATCH) {
                            continue
                        }
                    }
                    let cost = SKIP * (k - 1) * (1 - TIME_SKIP_DISCOUNT * tm)
                    if (k > 1 && this.events[e].measure !== this.events[s].measure && this.events[s + 1].measure === this.events[s].measure) {
                        cost += SKIP_MEASURE_END * (1 - TIME_SKIP_DISCOUNT * tm)
                    }
                    if (dt !== undefined) {
                        cost += TIMING_WEIGHT * Math.log(Math.max(0.05, this.timingFit(s, e, dt)))
                    }
                    relax(e, score + cost + emit(e))
                }
                jumps(this.events[s].measure, score, s)
            }
        }
        if (time !== undefined) {
            this.lastChordTime = time
        }
        if (!next.size) {
            return false
        }

        // normalize, prune, the best position
        let max = -Infinity
        let best = -1
        for (const [e, v] of next) {
            if (v > max) {
                max = v
                best = e
            }
        }
        const previousBest = this.best
        this.bestUnchanged = best === previousBest ? this.bestUnchanged + 1 : 0
        this.best = best
        const scores = new Map<number, number>()
        for (const [e, v] of next) {
            if (v - max > PRUNE) {
                scores.set(e, v - max)
            }
        }
        this.scores = scores

        // the measure shown: another one if it is clearly better
        const bestMeasure = this.events[best].measure
        if (bestMeasure !== this.m_measure) {
            let inCurrent = -Infinity
            for (const [e, v] of scores) {
                if (this.events[e].measure === this.m_measure) {
                    inCurrent = Math.max(inCurrent, v)
                }
            }
            const margin = bestMeasure === this.m_measure + 1 ? SWITCH_MARGIN : JUMP_SWITCH_MARGIN
            if (-inCurrent >= margin) {
                this.m_measure = bestMeasure
            }
        }

        // the tuning offset from the steps ahead (also from notes a semitone off), the tempo from good matches
        const sim = this.similarity(pitches, best)
        if (previousBest >= 0 && best === previousBest + 1 && sim >= TUNING_MATCH) {
            this.learnOffset(pitches, this.events[best].pitches)
        }
        if (sim >= GOOD_MATCH) {
            if (this.lastBest >= 0 && best > this.lastBest && time !== undefined) {
                this.learnTempo(this.events[best].utick - this.events[this.lastBest].utick, time - this.lastBestTime)
            }
            this.lastBest = best
            this.lastBestTime = time ?? -1
        }
        return this.m_measure !== before
    }

    /** the measure `count` measures with events after (negative: before) measure m (measures without events are passed) */
    private measureWithEvents(m: number, count: number): number {
        const step = Math.sign(count)
        let left = Math.abs(count)
        let j = m
        while (left > 0 && j + step >= 0 && j + step < this.measures.length) {
            j += step
            if (this.measureEndEvent[j] > this.measureFirstEvent[j]) {
                --left
            }
        }
        // the measures without events after it too (the events of the next one are reached by skipping)
        while (step > 0 && j + 1 < this.measures.length && this.measureEndEvent[j + 1] === this.measureFirstEvent[j + 1]) {
            ++j
        }
        return j
    }

    /** the distance of a jump from measure a to b in measures with events */
    private measuresWithEventsBetween(a: number, b: number): number {
        let n = 0
        for (let j = Math.min(a, b) + 1; j <= Math.max(a, b); ++j) {
            if (this.measureEndEvent[j] > this.measureFirstEvent[j]) {
                ++n
            }
        }
        return n
    }

    private similarity(pitches: readonly number[], eventIdx: number): number {
        return chordSimilarity(pitches, this.events[eventIdx].pitches, this.m_offset)
    }

    /** the seconds from event s to event e at the estimated tempo */
    private expectedTime(s: number, e: number): number {
        return (this.events[e].utick - this.events[s].utick) * (this.secondsPerTick() ?? 0)
    }

    /** how well `dt` seconds fit the step from event s to e (on time: 1; 0 while the tempo is not known) */
    private timeMatch(s: number, e: number, dt: number): number {
        const expected = this.expectedTime(s, e)
        if (expected <= 0 || dt <= 0) {
            return 0
        }
        const r = Math.log(dt / expected)
        return Math.exp(-r * r / (2 * 0.35 * 0.35))
    }

    private secondsPerTick(): number | null {
        if (this.tempoSamples.length < TEMPO_MIN_SAMPLES) {
            return null
        }
        const sorted = [...this.tempoSamples].sort((a, b) => a - b)
        return sorted[Math.floor(sorted.length / 2)]
    }

    /** how well `dt` seconds fit the step from event `s` to `e`: 1 if on time or late, less if (much) too early */
    private timingFit(s: number, e: number, dt: number): number {
        const spt = this.secondsPerTick()
        if (!spt) {
            return 1
        }
        const expected = (this.events[e].utick - this.events[s].utick) * spt
        if (expected <= 0 || dt >= expected * 0.8) {
            return 1
        }
        const r = Math.log(Math.max(dt, 0.01) / (expected * 0.8))
        return Math.exp(-r * r / (2 * 0.4 * 0.4))
    }

    /** a sample of the tempo (not across pauses: outliers are left out) */
    private learnTempo(ticks: number, dt: number): void {
        const spt = this.secondsPerTick()
        if (ticks > 0 && dt > 0.03 && (!spt || (dt / ticks > spt / 2.5 && dt / ticks < spt * 2.5))) {
            this.tempoSamples.push(dt / ticks)
            if (this.tempoSamples.length > TEMPO_SAMPLES) {
                this.tempoSamples.shift()
            }
        }
    }

    /** an instrument that sounds a semitone (or two) off: the offset recent matches agree on */
    private learnOffset(played: readonly number[], expected: readonly number[]): void {
        let diff: number | null = null
        for (const p of played) {
            for (const x of expected) {
                const d = x - p
                if (Math.abs(d - this.m_offset) <= 1 && (diff === null || Math.abs(d - this.m_offset) < Math.abs(diff - this.m_offset))) {
                    diff = d
                }
            }
        }
        if (diff === null) {
            return
        }
        this.recentDiffs.push(diff)
        if (this.recentDiffs.length > 12) {
            this.recentDiffs.shift()
        }
        // the last four agree, or most of the recent ones
        const last4 = this.recentDiffs.slice(-4)
        if (last4.length === 4 && last4[0] !== this.m_offset && Math.abs(last4[0]) <= 2 && last4.every(d => d === last4[0])) {
            this.m_offset = last4[0]
            this.recentDiffs = []
            return
        }
        if (this.recentDiffs.length < 8) {
            return
        }
        const counts = new Map<number, number>()
        for (const d of this.recentDiffs) {
            counts.set(d, (counts.get(d) ?? 0) + 1)
        }
        for (const [d, n] of counts) {
            if (d !== this.m_offset && Math.abs(d) <= 2 && n >= this.recentDiffs.length * 0.75) {
                this.m_offset = d
                this.recentDiffs = []
                return
            }
        }
    }
}

/**
 * groups the detected notes into chords: notes starting within `window` seconds belong together. The detection
 * reports them in batches, so a chord is complete when a later note arrives or after `flushDelay` ms.
 */
export class ChordGrouper {
    private pitches: number[] = []
    private start = 0
    /** the start of the last chord reported */
    private lastStart = -Infinity
    private timer: ReturnType<typeof setTimeout> | null = null
    private readonly onChord: (pitches: number[], time: number) => void
    private readonly window: number
    private readonly flushDelay: number

    constructor(onChord: (pitches: number[], time: number) => void, window = 0.1, flushDelay = 150) {
        this.onChord = onChord
        this.window = window
        this.flushDelay = flushDelay
    }

    add(pitch: number, time: number): void {
        // reported after a later chord was processed already: too late, it would confuse the timing
        if (time < this.lastStart - this.window / 2) {
            return
        }
        if (this.pitches.length && time - this.start > this.window) {
            this.flush()
        }
        if (!this.pitches.length) {
            this.start = time
        }
        if (!this.pitches.includes(pitch)) {
            this.pitches.push(pitch)
        }
        if (this.timer !== null) {
            clearTimeout(this.timer)
        }
        this.timer = setTimeout(() => this.flush(), this.flushDelay)
    }

    flush(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer)
            this.timer = null
        }
        if (this.pitches.length) {
            const p = this.pitches
            this.pitches = []
            this.lastStart = this.start
            this.onChord(p, this.start)
        }
    }

    clear(): void {
        this.lastStart = -Infinity
        if (this.timer !== null) {
            clearTimeout(this.timer)
            this.timer = null
        }
        this.pitches = []
    }
}
