// SPDX-License-Identifier: GPL-3.0-only
// Selection like MuseScore's notation view: clicks (single, ctrl = add, shift = range), measures, keyboard navigation,
// status bar text, drawing in the selection colors.
import { beforeAll, describe, expect, it } from 'vitest'
import {
    clearSelection, createScore, defaultNewScoreOptions, drawPageSvg, firstMeasureBounds, hasSelection, hitTest, moveSelection, selectAll,
    selectAt, selectionBounds, selectionInfo, setTranslator, type MasterScore,
} from '../src/index'
import { DPI } from '../src/engraving/types/types'
import { SegmentType } from '../src/engraving/dom/segment'
import { SelState } from '../src/engraving/dom/select'
import type { Chord } from '../src/engraving/dom/chord'
import type { EngravingItem } from '../src/engraving/dom/engravingitem'
import type { Measure } from '../src/engraving/dom/measure'
import type { Note } from '../src/engraving/dom/note'
import { VTEST, hasSubmodule, initFonts, openScore } from './helpers'

const NO_MODS = { shift: false, ctrl: false, alt: false }

/** the SVG's lines sorted: selected elements are painted last (elementLessThan), which only changes the order */
function sortedLines(svg: string): string[] {
    return svg.split('\n').sort()
}

/** the center of an element in inches from its page's top left */
function center(e: EngravingItem): { x: number; y: number } {
    const c = e.pageBoundingRect().center()
    return { x: c.x() / DPI, y: c.y() / DPI }
}

/** a point on the empty staff space of a measure (between the second and third staff line, near the right end) */
function measurePoint(m: Measure, staffIdx = 0): { x: number; y: number } {
    const sys = m.system()!
    const x = m.pagePos().x() + m.ldata().bbox().width() - 0.5 * m.spatium()
    const y = sys.pagePos().y() + sys.staff(staffIdx)!.y() + 1.5 * m.spatium()
    return { x: x / DPI, y: y / DPI }
}

function firstChord(score: MasterScore, measure: Measure, track = 0): Chord {
    for (let s = measure.first(SegmentType.ChordRest); s; s = s.next(SegmentType.ChordRest)) {
        const e = s.element(track)
        if (e && e.isChord()) {
            return e as unknown as Chord
        }
    }
    throw new Error('no chord')
}

describe('selection in a new score', () => {
    let score: MasterScore

    beforeAll(async () => {
        await initFonts()
        score = createScore({ ...defaultNewScoreOptions(), instruments: [{ id: 'piano' }], measures: 8 })
    })

    it('selects a measure with a click on empty staff space, extends with shift-click', () => {
        clearSelection(score)
        const m2 = score.firstMeasure()!.nextMeasure()!
        const p = measurePoint(m2)
        expect(hitTest(score, 0, p.x, p.y)?.type).toBe('Measure')

        expect(selectAt(score, 0, p.x, p.y, 'single')).toBe(true)
        const sel = score.selection()
        expect(sel.state()).toBe(SelState.RANGE)
        expect(sel.tickStart().ticks()).toBe(m2.tick().ticks())
        expect(sel.tickEnd().ticks()).toBe(m2.endTick().ticks())
        expect(sel.staffStart()).toBe(0)
        expect(sel.staffEnd()).toBe(1)
        expect(selectionInfo(score)).toMatch(/^Range selection; Start measure: 2; Start beat: 1; End measure: 2; End beat: \d/)

        // the rest of the measure is selected
        const rest = m2.first(SegmentType.ChordRest)!.element(0)!
        expect(rest.selected()).toBe(true)

        // shift-click on measure 4 of the lower staff
        const m4 = m2.nextMeasure()!.nextMeasure()!
        const p4 = measurePoint(m4, 1)
        expect(selectAt(score, 0, p4.x, p4.y, 'range')).toBe(true)
        expect(sel.tickStart().ticks()).toBe(m2.tick().ticks())
        expect(sel.tickEnd().ticks()).toBe(m4.endTick().ticks())
        expect(sel.staffEnd()).toBe(2)
        expect(selectionInfo(score)).toMatch(/^Range selection; Start measure: 2; .*End measure: 4/)

        // the range frame is reported (one per system) together with the elements
        const bounds = selectionBounds(score)
        expect(bounds.length).toBeGreaterThan(1)
        expect(bounds.every(b => b.page === 0 && b.width > 0 && b.height > 0)).toBe(true)
    })

    it('the bounds of the first measure are the frame of its selection on all staves', () => {
        clearSelection(score)
        const m1 = score.firstMeasure()!
        const top = measurePoint(m1)
        const bottom = measurePoint(m1, 1)
        selectAt(score, 0, top.x, top.y, 'single')
        selectAt(score, 0, bottom.x, bottom.y, 'range')
        const frame = selectionBounds(score)[0]
        clearSelection(score)

        const b = firstMeasureBounds(score)!
        const margin = 0.03 // of the selection frame's pen
        expect(b.page).toBe(0)
        // from the measure's beginning: with the clef and time signature, which the frame starts after
        expect(b.x).toBeCloseTo(m1.pagePos().x() / DPI, 5)
        expect(b.x).toBeLessThan(frame.x)
        expect(b.x + b.width).toBeCloseTo(frame.x + frame.width - margin, 5)
        expect(b.y).toBeCloseTo(frame.y + margin, 5)
        expect(b.height).toBeCloseTo(frame.height - 2 * margin, 5)
    })

    it('clicking outside of the staves deselects; Escape and Ctrl+A', () => {
        const m1 = score.firstMeasure()!
        const p = measurePoint(m1)
        selectAt(score, 0, p.x, p.y, 'single')
        expect(hasSelection(score)).toBe(true)

        // far below the last system
        expect(hitTest(score, 0, 0.2, 10.9)).toBeNull()
        expect(selectAt(score, 0, 0.2, 10.9, 'single')).toBe(true)
        expect(hasSelection(score)).toBe(false)
        expect(selectionInfo(score)).toBe('')

        selectAll(score)
        expect(score.selection().isRange()).toBe(true)
        expect(score.selection().staffEnd()).toBe(2)
        // like MuseScore: the end of a range at the end of the score is the end bar line segment (tick of "measure 9")
        expect(selectionInfo(score)).toBe('Range selection; Start measure: 1; Start beat: 1; End measure: 9; End displayed measure: 8; End beat: 1')

        expect(moveSelection(score, 'Escape', NO_MODS)).toBe(true)
        expect(hasSelection(score)).toBe(false)

        expect(moveSelection(score, 'a', { shift: false, ctrl: true, alt: false })).toBe(true)
        expect(score.selection().isRange()).toBe(true)
        clearSelection(score)
    })

    it('keyboard: arrows move a single selection, Ctrl+arrows by measure, Shift+arrows extend a range', () => {
        const m1 = score.firstMeasure()!
        const rest1 = m1.first(SegmentType.ChordRest)!.element(0)!
        const c = center(rest1)
        selectAt(score, 0, c.x, c.y, 'single')
        expect(score.selection().element()).toBe(rest1)
        expect(selectionInfo(score)).toBe('Rest(s); Duration: Measure; Voice: 1; Measure: 1; Beat: 1; Staff 1 (Piano)')

        expect(moveSelection(score, 'ArrowRight', NO_MODS)).toBe(true)
        expect(score.selection().element()!.findMeasure()).toBe(m1.nextMeasure())
        expect(moveSelection(score, 'ArrowLeft', NO_MODS)).toBe(true)
        expect(score.selection().element()).toBe(rest1)
        expect(moveSelection(score, 'ArrowRight', { shift: false, ctrl: true, alt: false })).toBe(true)
        expect(score.selection().element()!.findMeasure()).toBe(m1.nextMeasure())

        // Alt+Down: the rest of the lower staff
        expect(moveSelection(score, 'ArrowDown', { shift: false, ctrl: false, alt: true })).toBe(true)
        expect(score.selection().element()!.staffIdx()).toBe(1)

        // Shift+Right: a range of two measures
        expect(moveSelection(score, 'ArrowRight', { shift: true, ctrl: false, alt: false })).toBe(true)
        expect(score.selection().isRange()).toBe(true)
        expect(selectionInfo(score)).toMatch(/^Range selection; Start measure: 2; Start beat: 1; End measure: 3/)
        // Shift+Up: extend to the upper staff
        expect(moveSelection(score, 'ArrowUp', { shift: true, ctrl: false, alt: false })).toBe(true)
        expect(score.selection().staffStart()).toBe(0)
        expect(score.selection().staffEnd()).toBe(2)

        expect(moveSelection(score, 'x', NO_MODS)).toBe(false)
        clearSelection(score)
    })
})

describe.runIf(hasSubmodule)('selection of notes', () => {
    let score: MasterScore

    beforeAll(async () => {
        score = await openScore(`${VTEST}/accidental-1.mscx`)
    })

    it('a click on a note selects it, with MuseScore\'s status text', () => {
        clearSelection(score)
        const m1 = score.firstMeasure()!
        const note = firstChord(score, m1).upNote()
        const c = center(note)
        expect(hitTest(score, 0, c.x, c.y)).toEqual({ type: 'Note', name: 'Note(s)' })
        expect(selectAt(score, 0, c.x, c.y, 'single')).toBe(true)
        expect(score.selection().element()).toBe(note)
        expect(note.selected()).toBe(true)
        expect(selectionInfo(score)).toMatch(/^Note; Pitch: [A-G][♭♯]*\d; Duration: Quarter; Voice: 1; Measure: 1; Beat: 1; Staff 1 \(Piano\)$/)
        // clicking it again changes nothing
        expect(selectAt(score, 0, c.x, c.y, 'single')).toBe(false)

        const b = selectionBounds(score)
        expect(b).toHaveLength(1)
        expect(b[0].x).toBeLessThan(c.x)
        expect(b[0].x + b[0].width).toBeGreaterThan(c.x)
    })

    it('ctrl-click adds (list selection), ctrl-click on a selected element removes it', () => {
        clearSelection(score)
        const m1 = score.firstMeasure()!
        const n1 = firstChord(score, m1).upNote()
        const n2 = firstChord(score, m1.nextMeasure()!).upNote()
        const c1 = center(n1)
        const c2 = center(n2)
        selectAt(score, 0, c1.x, c1.y, 'single')
        expect(selectAt(score, 0, c2.x, c2.y, 'add')).toBe(true)
        expect(score.selection().state()).toBe(SelState.LIST)
        expect(score.selection().elements()).toEqual([n1, n2])
        expect(selectionInfo(score)).toBe('List selection')

        expect(selectAt(score, 0, c1.x, c1.y, 'add')).toBe(true)
        expect(score.selection().elements()).toEqual([n2])
        expect(n1.selected()).toBe(false)
    })

    it('shift-click extends a note to a range; arrows go to the next chord', () => {
        clearSelection(score)
        const m1 = score.firstMeasure()!
        const chord = firstChord(score, m1)
        const c1 = center(chord.upNote())
        selectAt(score, 0, c1.x, c1.y, 'single')
        const n2 = firstChord(score, m1.nextMeasure()!).upNote()
        const c2 = center(n2)
        expect(selectAt(score, 0, c2.x, c2.y, 'range')).toBe(true)
        expect(score.selection().isRange()).toBe(true)
        expect(score.selection().tickStart().ticks()).toBe(0)
        expect(n2.selected()).toBe(true)
        expect(chord.upNote().selected()).toBe(true)

        selectAt(score, 0, c1.x, c1.y, 'single') // inside the range: selects the note (on release)
        expect(score.selection().element()).toBe(chord.upNote())
        expect(moveSelection(score, 'ArrowRight', NO_MODS)).toBe(true)
        const next = score.selection().element() as Note
        expect(next.isNote()).toBe(true)
        expect(next.chord().tick().gt(chord.tick())).toBe(true)
        expect(next).toBe(next.chord().upNote())
    })

    it('draws selected elements in the voice color when not printing; printing is unchanged', () => {
        clearSelection(score)
        const unselectedPrint = drawPageSvg(score, 0)
        const unselectedView = drawPageSvg(score, 0, { printing: false })
        expect(unselectedView).not.toContain('#0065bf')

        const note = firstChord(score, score.firstMeasure()!).upNote()
        const c = center(note)
        selectAt(score, 0, c.x, c.y, 'single')
        expect(drawPageSvg(score, 0, { printing: false })).toContain('#0065bf')
        expect(sortedLines(drawPageSvg(score, 0))).toEqual(sortedLines(unselectedPrint))

        // a range is drawn with its frame (selection color, translucent fill)
        selectAll(score)
        const svg = drawPageSvg(score, 0, { printing: false })
        expect(svg).toContain('rgba(0,101,191,')
        expect(sortedLines(drawPageSvg(score, 0))).toEqual(sortedLines(unselectedPrint))
        clearSelection(score)
        expect(drawPageSvg(score, 0, { printing: false })).toBe(unselectedView)
    })

    it('translates the status text with MuseScore\'s contexts', () => {
        const seen: string[] = []
        setTranslator((context, key) => {
            seen.push(`${context}|${key}`)
            return key === 'Note(s)' ? 'Note' : null
        })
        try {
            const note = firstChord(score, score.firstMeasure()!).upNote()
            const c = center(note)
            selectAt(score, 0, c.x, c.y, 'single')
            selectionInfo(score)
            expect(hitTest(score, 0, c.x, c.y)?.name).toBe('Note')
        } finally {
            setTranslator(null)
        }
        expect(seen).toContain('engraving|%1; Pitch: %2; Duration: %3%4%5')
        expect(seen).toContain('engraving|Measure: %1')
        expect(seen).toContain('notation|Staff %1')
        expect(seen).toContain('engraving|Quarter')
        clearSelection(score)
    })
})
