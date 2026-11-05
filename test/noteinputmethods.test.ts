// SPDX-License-Identifier: GPL-3.0-only
// Note input methods (re-pitch, insert, real-time, rhythm), tuplets, slurs, hairpins, ottavas, grace notes, beams,
// intervals and full-measure rests through MuseScore's actions (executeAction), each undone and redone: undo restores
// the SVG of all pages exactly, redo repeats the change.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
    createScore, defaultNewScoreOptions, drawPageSvg, enterMidiNotes, executeAction, isActionChecked, isActionEnabled, NotationConfiguration, redo, undo, type MasterScore,
} from '../src/index'
import { SegmentType } from '../src/engraving/dom/segment'
import { SelectType } from '../src/engraving/dom/select'
import { NoteEntryMethod } from '../src/engraving/dom/input'
import type { Chord } from '../src/engraving/dom/chord'
import type { ChordRest } from '../src/engraving/dom/chordrest'
import type { Measure } from '../src/engraving/dom/measure'
import type { Tuplet } from '../src/engraving/dom/tuplet'
import type { Slur } from '../src/engraving/dom/slur'
import { initFonts, scoreHash as hashWithSelection } from './helpers'

/** selected items are painted last: the hash without a selection */
function scoreHash(score: MasterScore): string {
    const sel = [...score.selection().elements()]
    score.select(null)
    const h = hashWithSelection(score)
    if (sel.length) {
        score.select(sel, SelectType.ADD)
    }
    return h
}

/** the chords/rests of a track of a measure: "72:1/4", "r:1/8", "3:72:1/8" (tuplet ratio numerator first) */
function contents(m: Measure, track = 0): string[] {
    const res: string[] = []
    for (let s = m.first(SegmentType.ChordRest); s; s = s.next(SegmentType.ChordRest)) {
        const e = s.element(track) as unknown as ChordRest | null
        if (!e) {
            continue
        }
        const f = e.ticks().reduced()
        const d = `${f.numerator()}/${f.denominator()}`
        const t = e.tuplet() ? `${e.tuplet()!.ratio().numerator()}:` : ''
        if (e.isChord()) {
            res.push(`${t}${(e as unknown as Chord).notes().map(n => n.pitch()).join('+')}:${d}`)
        } else {
            res.push(`${t}r:${d}`)
        }
    }
    return res
}

function run(score: MasterScore, ...codes: string[]): void {
    for (const code of codes) {
        expect(executeAction(score, code), code).toBe(true)
    }
}

/** undo `n` commands: the rendering is `before` again; redo: `after` again */
function checkUndoRedo(score: MasterScore, n: number, before: string, after: string): void {
    for (let i = 0; i < n; ++i) {
        expect(undo(score)).toBe(true)
    }
    expect(scoreHash(score)).toBe(before)
    for (let i = 0; i < n; ++i) {
        expect(redo(score)).toBe(true)
    }
    expect(scoreHash(score)).toBe(after)
}

function newScore(measures = 4): MasterScore {
    return createScore({ ...defaultNewScoreOptions(), instruments: [{ id: 'flute' }], measures })
}

function selectFirstRest(score: MasterScore, m: Measure = score.firstMeasure()!): void {
    score.select(m.first(SegmentType.ChordRest)!.element(0), SelectType.SINGLE, 0)
}

describe('note input methods and line/tuplet commands', () => {
    beforeAll(async () => {
        await initFonts()
    })

    it('re-pitch mode changes the pitches of the existing notes and keeps the rhythm', () => {
        const score = newScore()
        const m1 = score.firstMeasure()!
        selectFirstRest(score)
        run(score, 'note-input', 'pad-note-8', 'note-c', 'note-d', 'pad-note-4', 'note-e', 'note-f', 'note-g', 'note-input')
        expect(contents(m1)).toEqual(['72:1/8', '74:1/8', '76:1/4', '77:1/4', '79:1/4'])
        const before = scoreHash(score)

        score.select(m1.first(SegmentType.ChordRest)!.element(0) as unknown as Chord, SelectType.SINGLE, 0)
        score.select((m1.first(SegmentType.ChordRest)!.element(0) as unknown as Chord).upNote(), SelectType.SINGLE, 0)
        run(score, 'note-input-repitch')
        expect(score.inputState().noteEntryMethod()).toBe(NoteEntryMethod.REPITCH)
        expect(isActionChecked(score, 'note-input-repitch')).toBe(true)
        run(score, 'note-a', 'note-b', 'note-c')
        expect(contents(m1)).toEqual(['69:1/8', '71:1/8', '72:1/4', '77:1/4', '79:1/4'])
        run(score, 'note-input')
        const after = scoreHash(score)
        expect(after).not.toBe(before)
        checkUndoRedo(score, 3, before, after)
    })

    it('insert mode (timewise) and insert-<note> make the measure longer', () => {
        const score = newScore()
        const m1 = score.firstMeasure()!
        selectFirstRest(score)
        run(score, 'note-input', 'note-c', 'note-d', 'note-e', 'note-f')
        expect(contents(m1)).toEqual(['72:1/4', '74:1/4', '76:1/4', '77:1/4'])
        const before = scoreHash(score)

        // select D and insert a G before it
        score.select((m1.first(SegmentType.ChordRest)!.next(SegmentType.ChordRest)!.element(0) as unknown as Chord).upNote(),
            SelectType.SINGLE, 0)
        run(score, 'insert-g')
        expect(m1.ticks().reduced().toString()).toBe('5/4')
        expect(contents(m1)).toEqual(['72:1/4', '67:1/4', '74:1/4', '76:1/4', '77:1/4'])

        run(score, 'toggle-insert-mode')
        expect(score.inputState().noteEntryMethod()).toBe(NoteEntryMethod.TIMEWISE)
        run(score, 'note-a')
        expect(m1.ticks().reduced().toString()).toBe('3/2')
        run(score, 'toggle-insert-mode', 'note-input')
        expect(score.inputState().noteEntryMethod()).toBe(NoteEntryMethod.BY_NOTE_NAME)
        const after = scoreHash(score)
        checkUndoRedo(score, 2, before, after)
    })

    it('real-time (manual) input: realtime-advance moves the cursor by one input duration (filling with rests)', () => {
        const score = newScore()
        const m1 = score.firstMeasure()!
        selectFirstRest(score)
        const before = scoreHash(score)
        run(score, 'note-input-realtime-manual')
        expect(isActionEnabled(score, 'realtime-advance')).toBe(true)
        // C++: a note entered with the note name keys (putNote) moves the cursor like in the other modes
        run(score, 'note-c')
        expect(score.inputState().tick().ticks()).toBe(480)
        // C++: the advance comes 100 ms after the metronome tick
        vi.useFakeTimers()
        run(score, 'realtime-advance')
        expect(score.inputState().tick().ticks()).toBe(480)
        vi.advanceTimersByTime(100)
        expect(score.inputState().tick().ticks()).toBe(960)
        run(score, 'note-e', 'realtime-advance')
        vi.advanceTimersByTime(600)
        vi.useRealTimers()
        expect(score.inputState().tick().ticks()).toBe(1920)
        expect(contents(m1)).toEqual(['72:1/4', 'r:1/4', '76:1/4', 'r:1/4'])
        run(score, 'note-input')
        const after = scoreHash(score)
        checkUndoRedo(score, 4, before, after)
    })

    it('rhythm-only input enters notes on the middle line with the duration keys', () => {
        const score = newScore()
        const m1 = score.firstMeasure()!
        selectFirstRest(score)
        run(score, 'note-input-rhythm', 'pad-note-4', 'pad-note-4', 'pad-note-2')
        expect(contents(m1)).toEqual(['71:1/4', '71:1/4', '71:1/2'])
        run(score, 'note-input')
    })

    it('enters a triplet in note input and on a selection (Ctrl+3)', () => {
        const score = newScore()
        const m1 = score.firstMeasure()!
        selectFirstRest(score)
        const before = scoreHash(score)
        run(score, 'note-input', 'pad-note-4', 'triplet')
        expect(score.inputState().duration().fraction().toString()).toBe('1/8')
        run(score, 'note-c', 'note-d', 'note-e', 'note-f')
        expect(contents(m1)).toEqual(['3:72:1/8', '3:74:1/8', '3:76:1/8', '77:1/8', 'r:1/8', 'r:1/2'])
        run(score, 'note-input')
        const tuplet = (m1.first(SegmentType.ChordRest)!.element(0) as unknown as ChordRest).tuplet() as Tuplet
        expect(tuplet.elements().length).toBe(3)
        const after = scoreHash(score)
        expect(after).not.toBe(before)
        checkUndoRedo(score, 5, before, after)

        // on a selected quarter rest of measure 2: a quintuplet of 16ths
        const m2 = m1.nextMeasure()!
        selectFirstRest(score, m2)
        run(score, 'pad-note-4')
        score.select(m2.first(SegmentType.ChordRest)!.element(0), SelectType.SINGLE, 0)
        run(score, 'note-input')
        run(score, 'note-input')
        score.select(m2.first(SegmentType.ChordRest)!.element(0), SelectType.SINGLE, 0)
        const before2 = scoreHash(score)
        run(score, 'quintuplet')
        expect(contents(m2).slice(0, 5)).toEqual(['5:r:1/16', '5:r:1/16', '5:r:1/16', '5:r:1/16', '5:r:1/16'])
        const after2 = scoreHash(score)
        checkUndoRedo(score, 1, before2, after2)
    })

    it('adds a slur to a selected note and extends it while entering notes', () => {
        const score = newScore()
        const m1 = score.firstMeasure()!
        selectFirstRest(score)
        run(score, 'note-input', 'note-c', 'note-d', 'note-e', 'note-f', 'note-input')
        const before = scoreHash(score)
        const c1 = m1.first(SegmentType.ChordRest)!.element(0) as unknown as Chord
        const c2 = m1.first(SegmentType.ChordRest)!.next(SegmentType.ChordRest)!.element(0) as unknown as Chord
        score.select(c1.upNote(), SelectType.SINGLE, 0)
        run(score, 'add-slur')
        const slurs = [...score.spanner()].filter(s => s.isSlur()) as unknown as Slur[]
        expect(slurs.length).toBe(1)
        expect(slurs[0].startElement()).toBe(c1)
        expect(slurs[0].endElement()).toBe(c2)
        expect(score.selection().element()?.isSlurSegment()).toBe(true)
        const after = scoreHash(score)
        expect(after).not.toBe(before)
        checkUndoRedo(score, 1, before, after)

        // in note input: S starts a slur at the last note, the next notes extend it, S again ends it
        const m2 = m1.nextMeasure()!
        selectFirstRest(score, m2)
        const before2 = scoreHash(score)
        run(score, 'note-input', 'note-g')
        run(score, 'add-slur')
        expect(isActionChecked(score, 'add-slur')).toBe(true)
        run(score, 'note-a', 'note-b')
        run(score, 'add-slur')
        expect(isActionChecked(score, 'add-slur')).toBe(false)
        run(score, 'note-c', 'note-input')
        const slur2 = ([...score.spanner()].filter(s => s.isSlur()) as unknown as Slur[]).find(s => s.tick().eq(m2.tick()))!
        expect(slur2.tick2().ticks() - slur2.tick().ticks()).toBe(2 * 480)
        const after2 = scoreHash(score)
        checkUndoRedo(score, 5, before2, after2)
    })

    it('adds hairpins and ottavas to a range and to single notes', () => {
        const score = newScore()
        const m1 = score.firstMeasure()!
        selectFirstRest(score)
        run(score, 'note-input', 'note-c', 'note-d', 'note-e', 'note-f', 'note-g', 'note-a', 'note-input')
        const before = scoreHash(score)
        score.select(m1, SelectType.RANGE, 0)
        run(score, 'add-hairpin')
        score.select((m1.first(SegmentType.ChordRest)!.element(0) as unknown as Chord).upNote(), SelectType.SINGLE, 0)
        run(score, 'add-hairpin-reverse')
        score.select(m1.nextMeasure()!, SelectType.RANGE, 0)
        run(score, 'add-8va')
        const types = [...score.spanner()].map(s => s.typeName()).sort()
        expect(types).toEqual(['HairPin', 'HairPin', 'Ottava'])
        const after = scoreHash(score)
        checkUndoRedo(score, 3, before, after)
    })

    it('toggles articulations on a selection and for the next notes in note input', () => {
        const score = newScore()
        const m1 = score.firstMeasure()!
        selectFirstRest(score)
        run(score, 'note-input', 'note-c', 'note-d', 'note-input')
        const before = scoreHash(score)
        const c1 = m1.first(SegmentType.ChordRest)!.element(0) as unknown as Chord
        score.select(c1.upNote(), SelectType.SINGLE, 0)
        run(score, 'add-staccato')
        expect(isActionChecked(score, 'add-staccato')).toBe(true)
        run(score, 'add-sforzato', 'add-marcato') // marcato replaces the accent
        expect(c1.articulations().map(a => a.typeName())).toEqual(['Articulation', 'Articulation'])
        expect(isActionChecked(score, 'add-sforzato')).toBe(false)
        expect(isActionChecked(score, 'add-marcato')).toBe(true)
        run(score, 'add-staccato') // removes it again
        expect(c1.articulations().length).toBe(1)
        const after = scoreHash(score)
        checkUndoRedo(score, 4, before, after)

        // in note input: the articulation is added to the next notes
        const m2 = m1.nextMeasure()!
        selectFirstRest(score, m2)
        run(score, 'note-input', 'add-tenuto')
        expect(isActionChecked(score, 'add-tenuto')).toBe(true)
        run(score, 'note-e', 'note-f', 'add-tenuto', 'note-g', 'note-input')
        const chords = [0, 1, 2].map(i => {
            let s = m2.first(SegmentType.ChordRest)!
            for (let k = 0; k < i; ++k) {
                s = s.next(SegmentType.ChordRest)!
            }
            return s.element(0) as unknown as Chord
        })
        expect(chords.map(c => c.articulations().length)).toEqual([1, 1, 0])
    })

    it('shows the shadow note at the mouse position in note input mode and removes notes with a right click', async () => {
        const { showShadowNote, hideShadowNote, rightClickAt, drawShadowNote, pageSize } = await import('../src/index')
        const score = newScore()
        const m1 = score.firstMeasure()!
        selectFirstRest(score)
        expect(showShadowNote(score, 0, 1, 1)).toBeNull() // not in note input mode
        run(score, 'note-input', 'note-c', 'note-d')
        // the position of the second note (D) on the page, in inches
        const c2 = m1.first(SegmentType.ChordRest)!.next(SegmentType.ChordRest)!.element(0) as unknown as Chord
        const page = score.pages()[0]
        const p = c2.upNote().canvasPos().minus(page.pos())
        const DPI = 1200
        const r = showShadowNote(score, 0, (p.x() + 10) / DPI, p.y() / DPI)
        expect(r).not.toBeNull()
        expect(r!.page).toBe(0)
        expect(Math.abs(r!.x * DPI - p.x())).toBeLessThan(100)
        expect(score.shadowNote().visible()).toBe(true)
        const size = pageSize(score, 0)
        expect(r!.width).toBeLessThan(size.width)
        // drawing it onto a canvas (2D context stub)
        const calls: string[] = []
        const ctx = new Proxy({}, { get: (_t, k) => typeof k === 'string' && !['canvas'].includes(k) ? (...a: unknown[]) => { calls.push(k); return a } : undefined }) as never
        drawShadowNote(score, 0, ctx, { dpi: 100 })
        expect(calls.length).toBeGreaterThan(0)

        const before = scoreHash(score)
        expect(rightClickAt(score, 0, (p.x() + 10) / DPI, p.y() / DPI)).toBe(true)
        expect(contents(m1)[1]).toBe('r:1/4')
        expect(undo(score)).toBe(true)
        expect(scoreHash(score)).toBe(before)
        expect(hideShadowNote(score)).toBe(true)
        expect(score.shadowNote().visible()).toBe(false)
    })

    it('adds grace notes, changes beams and adds intervals and full-measure rests', () => {
        const score = newScore()
        const m1 = score.firstMeasure()!
        selectFirstRest(score)
        run(score, 'note-input', 'pad-note-8', 'note-c', 'note-d', 'note-e', 'note-f', 'note-input')
        const before = scoreHash(score)
        const c1 = m1.first(SegmentType.ChordRest)!.element(0) as unknown as Chord
        score.select(c1.upNote(), SelectType.SINGLE, 0)
        run(score, 'acciaccatura')
        expect(c1.graceNotes().length).toBe(1)
        score.select(c1.upNote(), SelectType.SINGLE, 0)
        run(score, 'interval3')
        expect(c1.notes().map(n => n.pitch())).toEqual([72, 76])
        score.select(m1, SelectType.RANGE, 0)
        run(score, 'beam-none')
        const m2 = m1.nextMeasure()!
        selectFirstRest(score, m2)
        run(score, 'note-input', 'note-c', 'note-input')
        score.select(m2.first(SegmentType.ChordRest)!.next(SegmentType.ChordRest)!.element(0), SelectType.SINGLE, 0)
        const after = scoreHash(score)
        checkUndoRedo(score, 4, before, after)
    })
})

describe('MIDI note input (enterMidiNotes: the notes detected from the microphone)', () => {
    beforeAll(async () => {
        await initFonts()
    })

    it('enters notes and chords at the input position, undoable', () => {
        const score = newScore()
        const m1 = score.firstMeasure()!
        selectFirstRest(score)
        run(score, 'note-input', 'pad-note-4')
        const before = scoreHash(score)
        expect(enterMidiNotes(score, [72])).toBe(true)
        expect(enterMidiNotes(score, [72, 76, 79])).toBe(true)
        expect(enterMidiNotes(score, [74])).toBe(true)
        expect(contents(m1)).toEqual(['72:1/4', '72+76+79:1/4', '74:1/4', 'r:1/4'])
        const after = scoreHash(score)
        checkUndoRedo(score, 5, before, after)
        // outside of note input nothing is entered
        run(score, 'note-input')
        expect(enterMidiNotes(score, [60])).toBe(false)
    })

    it('spells with the accidental of the input state, transposing instruments get the sounding pitch', () => {
        const score = createScore({ ...defaultNewScoreOptions(), instruments: [{ id: 'bb-trumpet' }], measures: 2 })
        expect(score.noteVal(61, 0, false).pitch).toBe(61)
        // written pitch input (allowTransposition): the sounding pitch is a major second lower
        expect(score.noteVal(62, 0, true).pitch).toBe(60)
    })

    it('input by duration: a note name sets the pitch, a duration enters the note', () => {
        const score = newScore()
        const m = score.firstMeasure()!
        selectFirstRest(score)
        run(score, 'note-input-by-duration')
        const before = scoreHash(score)

        run(score, 'note-c') // only the pitch of the next input: the score is unchanged
        expect(score.inputState().notes().length).toBe(1)
        expect(contents(m)[0]).toBe('r:1/1')
        const pitch = score.inputState().notes()[0].pitch
        expect(pitch % 12).toBe(0)

        run(score, 'pad-note-4', 'pad-note-8') // two notes of the same pitch
        expect(contents(m).slice(0, 2)).toEqual([`${pitch}:1/4`, `${pitch}:1/8`])
        expect(score.inputState().tick().ticks()).toBe(720)

        run(score, 'pitch-up-diatonic') // moves the pitch of the next input, not the entered note
        const up = score.inputState().notes()[0].pitch
        expect(up).toBeGreaterThan(pitch)
        expect(contents(m).slice(0, 2)).toEqual([`${pitch}:1/4`, `${pitch}:1/8`])

        run(score, 'pad-note-8') // the moved pitch is entered
        expect(contents(m)[2]).toBe(`${up}:1/8`)

        run(score, 'pad-rest', 'pad-note-4') // the rest mode enters a rest with the duration
        expect(contents(m)[3]).toBe('r:1/4')

        undo(score)
        undo(score)
        undo(score)
        undo(score)
        expect(scoreHash(score)).toBe(before)
    })

    it('input by duration: the ruler above the staff or, by the preference, the cursor on the staff', () => {
        const score = newScore()
        const svg = (): string => drawPageSvg(score, 0, { printing: false })
        selectFirstRest(score)
        const printed = drawPageSvg(score, 0)
        const selected = new Set(svg().split('\n'))
        run(score, 'note-input-by-note-name')
        // what the note input cursor paints (without glyphs: the ids of the glyphs depend on the drawing)
        const cursorLines = svg().split('\n').filter(l => !selected.has(l) && !l.includes('xlink:href') && l.includes('<'))
        expect(cursorLines.length).toBeGreaterThan(0)

        run(score, 'note-input-by-duration')
        const ruler = svg()
        expect(cursorLines.filter(l => ruler.includes(l))).toEqual([])
        NotationConfiguration.setUseNoteInputCursorInInputByDuration(true)
        try {
            const onStaff = svg()
            expect(onStaff).not.toBe(ruler)
            expect(cursorLines.filter(l => !onStaff.includes(l))).toEqual([])
        } finally {
            NotationConfiguration.setUseNoteInputCursorInInputByDuration(false)
        }
        expect(svg()).toBe(ruler)
        expect(drawPageSvg(score, 0)).toBe(printed) // printing: neither of them

        // the preview of the next input: its pitch moves it, it is not printed and does not change the score
        run(score, 'note-c')
        const previewC = svg()
        expect(previewC).not.toBe(ruler)
        run(score, 'pitch-up-diatonic')
        expect(svg()).not.toBe(previewC)
        expect(drawPageSvg(score, 0)).toBe(printed)
    })

    it('the default input mode: note-input and a note name start it; a method action still chooses its own', () => {
        NotationConfiguration.setDefaultNoteInputMethod(NoteEntryMethod.BY_DURATION)
        try {
            const score = newScore()
            selectFirstRest(score)
            run(score, 'note-input')
            expect(score.inputState().noteEntryMethod()).toBe(NoteEntryMethod.BY_DURATION)
            expect(isActionChecked(score, 'note-input-by-duration')).toBe(true)
            run(score, 'note-input')
            expect(score.noteEntryMode()).toBe(false)

            // a note name starts the default mode: only the pitch of the next input
            selectFirstRest(score)
            run(score, 'note-d')
            expect(score.inputState().noteEntryMethod()).toBe(NoteEntryMethod.BY_DURATION)
            expect(contents(score.firstMeasure()!)[0]).toBe('r:1/1')
            run(score, 'note-input')

            selectFirstRest(score)
            run(score, 'note-input-by-note-name')
            expect(score.inputState().noteEntryMethod()).toBe(NoteEntryMethod.BY_NOTE_NAME)
        } finally {
            NotationConfiguration.setDefaultNoteInputMethod(NoteEntryMethod.BY_NOTE_NAME)
        }
    })

    it('a dot goes to the next note entered or, by the preference, to the previous note', () => {
        const dotted = (): string[] => {
            const score = newScore()
            selectFirstRest(score)
            run(score, 'note-input', 'pad-note-4', 'note-c', 'pad-dot', 'note-d')
            return contents(score.firstMeasure()!).slice(0, 2).map(c => c.split(':')[1])
        }
        expect(dotted()).toEqual(['1/4', '3/8'])
        NotationConfiguration.setAddAccidentalDotsArticulationsToNextNoteEntered(false)
        try {
            expect(dotted()).toEqual(['3/8', '1/4'])
        } finally {
            NotationConfiguration.setAddAccidentalDotsArticulationsToNextNoteEntered(true)
        }
    })

    it('an accidental goes to the next note entered or, by the preference, to the previous note', () => {
        const pitches = (): number[] => {
            const score = newScore()
            selectFirstRest(score)
            run(score, 'note-input', 'pad-note-4', 'note-c', 'flat', 'note-d')
            return contents(score.firstMeasure()!).slice(0, 2).map(c => Number(c.split(':')[0]) % 12)
        }
        expect(pitches()).toEqual([0, 1]) // C, D flat
        NotationConfiguration.setAddAccidentalDotsArticulationsToNextNoteEntered(false)
        try {
            expect(pitches()).toEqual([11, 2]) // C flat, D
        } finally {
            NotationConfiguration.setAddAccidentalDotsArticulationsToNextNoteEntered(true)
        }
    })

    it('the input by duration takes the pitches for the next input', () => {
        const score = newScore()
        selectFirstRest(score)
        run(score, 'note-input-by-duration')
        expect(enterMidiNotes(score, [67, 71])).toBe(true)
        expect(score.inputState().notes().map(n => n.pitch)).toEqual([67, 71])
    })
})
