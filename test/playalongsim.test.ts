// SPDX-License-Identifier: GPL-3.0-only
// Playalong: the score following on real scores played with simulated detection errors (missed notes, octave errors,
// extra notes, timing jitter): it keeps up and never runs ahead of the player.
import { describe, expect, it } from 'vitest'
import { DEMOS, hasSubmodule, openScore } from './helpers'
import { playalongMeasures, type PlayalongMeasure } from '../src/index'
import { PlayalongFollower, type PlayalongMode } from '../shared/playalong/follower'

/** a seeded random generator (the results are reproducible) */
function rng(seed: number): () => number {
    return () => {
        seed = (seed * 1664525 + 1013904223) >>> 0
        return seed / 2 ** 32
    }
}

interface Noise {
    drop: number
    octave: number
    extra: number
    jitter: number
    /** every n-th measure nothing is detected (the detection did not keep up) */
    lostMeasureEvery?: number
}

const CLEAN: Noise = { drop: 0, octave: 0, extra: 0, jitter: 0.01 }
const NOISY: Noise = { drop: 0.25, octave: 0.08, extra: 0.15, jitter: 0.04 }

/** plays the measures (indices in the played order) at 120 bpm: the chords as the detection would report them */
function perform(ms: PlayalongMeasure[], order: number[], noise: Noise): { pitches: number[]; time: number; measure: number }[] {
    const r = rng(7)
    const spt = 0.5 / 480
    const out: { pitches: number[]; time: number; measure: number }[] = []
    let t = 0
    order.forEach((mi, n) => {
        const m = ms[mi]
        const lost = !!noise.lostMeasureEvery && n % noise.lostMeasureEvery === noise.lostMeasureEvery - 1
        for (const e of lost ? [] : m.events) {
            const pitches: number[] = []
            for (const p of e.pitches) {
                if (r() >= noise.drop) {
                    pitches.push(r() < noise.octave ? p + 12 : p)
                }
            }
            if (r() < noise.extra) {
                pitches.push(40 + Math.floor(r() * 40))
            }
            if (pitches.length) {
                out.push({ pitches, time: t + (e.tick - m.tick) * spt + (r() - 0.5) * 2 * noise.jitter, measure: mi })
            }
        }
        t += m.ticks * spt
    })
    return out
}

/** the part of the chords after which the measure shown is right, how far it runs ahead at most, the last measure */
function follow(ms: PlayalongMeasure[], order: number[], noise: Noise, mode: PlayalongMode): { exact: number; maxAhead: number; final: number } {
    const played = perform(ms, order, noise)
    const f = new PlayalongFollower(ms, mode, order[0])
    let exact = 0
    let maxAhead = 0
    for (const p of played) {
        f.onChord(p.pitches, p.time)
        exact += f.measure() === p.measure ? 1 : 0
        maxAhead = Math.max(maxAhead, f.measure() - p.measure)
    }
    return { exact: exact / played.length, maxAhead, final: f.measure() }
}

describe.runIf(hasSubmodule)('playalong simulation', () => {
    // piano scores (both hands) and a lead sheet (melody only: few notes, the hardest)
    const cases: [string, number, number][] = [['Reunion.mscz', 0.95, 0.9], ['goldberg.mscz', 0.95, 0.85], ['Triumph.mscz', 0.95, 0.6], ['Unclaimed_Gift.mscx', 0.95, 0.5]]
    for (const [file, cleanExact, noisyExact] of cases) {
        it(file, async () => {
            const ms = playalongMeasures(await openScore(`${DEMOS}/${file}`))
            const straight = [...Array(Math.min(ms.length, 40)).keys()]
            const last = straight[straight.length - 1]
            for (const mode of ['follow', 'practice'] as const) {
                const clean = follow(ms, straight, CLEAN, mode)
                expect(clean.exact).toBeGreaterThanOrEqual(cleanExact)
                expect(clean.maxAhead).toBe(0)
                expect(clean.final).toBeGreaterThanOrEqual(last - 1)
                const noisy = follow(ms, straight, NOISY, mode)
                expect(noisy.exact).toBeGreaterThanOrEqual(noisyExact)
                expect(noisy.maxAhead).toBe(0)
                expect(noisy.final).toBeGreaterThanOrEqual(last - 5)
            }
            // practice: measures repeated, and back one measure
            const practice: number[] = []
            for (const i of straight) {
                practice.push(i)
                if (i % 4 === 3) {
                    practice.push(i)
                }
                if (i % 7 === 6) {
                    practice.push(i - 1, i)
                }
            }
            // whole measures not detected: it catches up
            const lost = follow(ms, straight, { ...NOISY, lostMeasureEvery: 5 }, 'follow')
            expect(lost.maxAhead).toBe(0)
            expect(lost.final).toBeGreaterThanOrEqual(last - 5)
            const repeats = follow(ms, practice, NOISY, 'practice')
            expect(repeats.exact).toBeGreaterThanOrEqual(0.6)
            expect(repeats.final).toBeGreaterThanOrEqual(last - 6)
        }, 60000)
    }
})
