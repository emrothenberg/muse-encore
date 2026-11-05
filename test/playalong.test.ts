// SPDX-License-Identifier: GPL-3.0-only
// Playalong: the measures in the played order and the score following (shared/playalong/follower.ts).
import { describe, expect, it } from 'vitest'
import { DEMOS, hasSubmodule, openScore } from './helpers'
import { playalongMeasureBounds, playalongMeasures, type PlayalongMeasure } from '../src/index'
import { ChordGrouper, chordSimilarity, PlayalongFollower } from '../shared/playalong/follower'

/** measures with one note per beat: the pitches of each measure */
function measures(...pitches: number[][]): PlayalongMeasure[] {
    return pitches.map((ps, index) => ({
        index, tick: index * 1920, utick: index * 1920, ticks: 1920, number: index + 1, repeatSegment: 0,
        events: ps.map((p, i) => ({ tick: index * 1920 + i * 480, pitches: [p] })),
    }))
}

// four different measures (C major scale fragments), then the first again
const SCORE = measures([60, 62, 64, 65], [67, 69, 71, 72], [72, 71, 69, 67], [65, 64, 62, 60], [60, 64, 67, 72], [48, 55, 52, 53])

function play(f: PlayalongFollower, ...pitches: number[]): void {
    for (const p of pitches) {
        f.onChord([p])
    }
}

describe('playalong follower', () => {
    it('follows the measures', () => {
        const f = new PlayalongFollower(SCORE)
        play(f, 60, 62, 64, 65)
        expect(f.measure()).toBe(0)
        play(f, 67)
        expect(f.measure()).toBe(1)
        play(f, 69, 71, 72, 72, 71)
        expect(f.measure()).toBe(2)
    })

    it('tolerates missed, wrong and out of tune notes and octave errors', () => {
        const f = new PlayalongFollower(SCORE)
        // a wrong note, 62 missed
        play(f, 60, 66, 64, 65)
        expect(f.measure()).toBe(0)
        // 69 an octave higher, 71 out of tune
        play(f, 67, 81, 70, 72)
        expect(f.measure()).toBe(1)
    })

    it('matches chords partly', () => {
        expect(chordSimilarity([60, 64], [60, 64, 67])).toBeGreaterThan(chordSimilarity([60], [60, 64, 67]))
        expect(chordSimilarity([61], [60])).toBeGreaterThan(0)
        expect(chordSimilarity([66], [60])).toBe(0)
        const f = new PlayalongFollower(measures([60], [65]).map(m => ({ ...m, events: m.events.map(e => ({ ...e, pitches: [e.pitches[0], e.pitches[0] + 4, e.pitches[0] + 7] })) })))
        f.onChord([60, 67])
        f.onChord([69, 72])
        expect(f.measure()).toBe(1)
    })

    it('does not go back in follow mode, does in practice mode', () => {
        const f = new PlayalongFollower(SCORE, 'follow', 2)
        play(f, 72, 71, 69, 67, 72, 71, 69, 67, 67, 69, 71)
        expect(f.measure()).toBe(2)

        const p = new PlayalongFollower(SCORE, 'practice', 2)
        play(p, 72, 71, 69, 67, 65)
        expect(p.measure()).toBe(3)
        // back to the start of measure 2 (repeating the previous measure): after some chords
        play(p, 72, 71)
        expect(p.measure()).toBe(3)
        play(p, 69, 67, 65)
        expect(p.measure()).toBe(3)
        // back to measure 1
        play(p, 67, 69)
        expect(p.measure()).toBe(3)
        play(p, 71)
        expect(p.measure()).toBe(1)
    })

    it('skips measures forward when confirmed, only near the current measure', () => {
        // measures without common notes
        const distinct = measures([60, 62, 64, 65], [67, 69, 71, 72], [74, 76, 77, 79], [81, 83, 84, 86], [88, 89, 91, 93], [48, 50, 52, 53])
        const f = new PlayalongFollower(distinct, 'practice')
        play(f, 60, 62)
        // measures far away are not considered
        play(f, 48, 50, 52, 53)
        expect(f.measure()).toBe(0)
        // continues in measure 2
        play(f, 74, 76)
        expect(f.measure()).toBe(0)
        play(f, 77)
        expect(f.measure()).toBe(2)
        // a single matching note does not jump
        const g = new PlayalongFollower(distinct, 'practice')
        play(g, 60, 62, 74, 64, 65)
        expect(g.measure()).toBe(0)
    })

    it('reaches the next measure after the end of the measure (repeated measures)', () => {
        const same = measures([60, 64, 67, 72], [60, 64, 67, 72], [60, 64, 67, 72], [65, 69, 74, 77])
        const f = new PlayalongFollower(same)
        play(f, 60, 64, 67)
        expect(f.measure()).toBe(0)
        play(f, 72)
        expect(f.measure()).toBe(0)
        play(f, 60)
        expect(f.measure()).toBe(1)
        // half of the measure missed: three chords of the next measure needed
        const g = new PlayalongFollower(same, 'follow', 2)
        play(g, 60, 64, 65, 69)
        expect(g.measure()).toBe(2)
        play(g, 74)
        expect(g.measure()).toBe(3)
    })

    it('uses the timing: not much too early into the next measure', () => {
        const same = measures([60, 64, 67, 72], [60, 64, 67, 72], [72, 67, 64, 60])
        const f = new PlayalongFollower(same)
        // quarter notes at 60 bpm (1 s each): the tempo is learned
        ;[60, 64, 67, 72].forEach((p, i) => f.onChord([p], i))
        expect(f.tempo()).toBeCloseTo(60)
        // the next measure's first note 0.2 s later: far too early, not taken as the next measure
        f.onChord([60], 3.2)
        expect(f.measure()).toBe(0)
        // on time
        f.onChord([60], 4)
        expect(f.measure()).toBe(1)
        // late is fine (a pause)
        f.onChord([64], 9)
        f.onChord([67], 10)
        f.onChord([72], 11)
        f.onChord([72], 20)
        expect(f.measure()).toBe(2)
    })

    it('learns a tuning offset', () => {
        const f = new PlayalongFollower(measures([60, 62, 64, 67], [69, 67, 64, 62], [60, 64, 67, 72]))
        // everything a semitone low: learned from four steps
        play(f, 59, 61, 63, 66, 68)
        expect(f.tuningOffset()).toBe(1)
        play(f, 66)
        expect(f.measure()).toBe(1)
        play(f, 63, 61, 59)
        expect(f.measure()).toBe(2)
    })

    it('goes to the next and previous measure manually', () => {
        const f = new PlayalongFollower(SCORE)
        f.next()
        f.next()
        expect(f.measure()).toBe(2)
        f.prev()
        expect(f.measure()).toBe(1)
        play(f, 67, 69)
        expect(f.measure()).toBe(1)
    })

    it('groups notes into chords', async () => {
        const chords: number[][] = []
        const g = new ChordGrouper(c => chords.push(c), 0.1, 10)
        g.add(60, 1.0)
        g.add(64, 1.05)
        g.add(67, 1.3)
        await new Promise(r => setTimeout(r, 30))
        expect(chords).toEqual([[60, 64], [67]])
    })
})

describe.runIf(hasSubmodule)('playalong measures', () => {
    it('unrolls the repeats', async () => {
        const score = await openScore(`${DEMOS}/Unclaimed_Gift.mscx`)
        const ms = playalongMeasures(score)
        const numbers = ms.map(m => m.number)
        // a measure played twice appears twice, in the played order
        expect(ms.length).toBeGreaterThan(new Set(numbers).size)
        expect(ms.every((m, i) => i === 0 || m.utick > ms[i - 1].utick)).toBe(true)
        expect(ms.some(m => m.events.length > 0)).toBe(true)
        expect(playalongMeasureBounds(score, ms[0].tick)).toMatchObject({ page: 0 })
    })
})
