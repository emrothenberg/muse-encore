/*
 * SPDX-License-Identifier: GPL-3.0-only
 * MuseEncore — port of MuseScore Studio (https://github.com/musescore/MuseScore)
 * Copyright (C) 2021-2026 MuseScore Limited and others
 *
 * Port of src/engraving/dom/score.h/.cpp and masterscore.h/.cpp (read & layout relevant parts, the undo/layout
 * hooks; the editing commands are in ../editing; no playback)
 */

import type { FBox } from './box'
import type { SystemDivider, SystemDividerType } from './systemdivider'
import { Fraction } from '../types/fraction'
import type { PropertyValue } from '../types/propertyvalue'
import { DPI, ElementType, INCH, Key, StaffGroup, TextStyleType, VOICES, staff2track, type staff_idx_t, type track_idx_t } from '../types/types'
import { Sid } from '../style/styledef'
import { SymId } from '../types/symid'
import { MStyle } from '../style/style'
import { DefaultStyle } from '../style/defaultstyle'
import { engravingFonts, type EngravingFont } from '../infrastructure/engravingfont'
import { EngravingObject } from './engravingobject'
import { itemFactories, type EngravingItem } from './engravingitem'
import { MeasureBaseList, type MeasureBase } from './measurebase'
import { SegmentType, type Segment } from './segment'
import { TimeSigMap, TimeSigFrac, BeatType, SigEvent } from './sig'
import { Pid } from './property'
import type { Measure } from './measure'
import type { ChordRest } from './chordrest'
import type { Chord } from './chord'
import { ShowAnchors } from './showanchors'
import { dragPositionToMeasure, dragPositionToSegment, moveDownWhenAddingStaves, searchTieNote } from './utils'
import type { Staff } from './staff'
import type { Part } from './part'
import type { System } from './system'
import type { Page } from './page'
import type { Spanner, SpannerSegment } from './spanner'
import type { Harmony } from './harmony'
import type { Note } from './note'
import type { Text } from './text'
import { SystemLocks, type SystemLock } from './systemlock'
import { ChordList } from './chordlist'
import { ScoreOrder } from './scoreorder'
import type { TimeSig } from './timesig'
import { KeyList, KeySigEvent } from './key'
import { Transpose } from '../editing/transpose'
import { Interval } from './interval'
import { ElementPattern, NotePattern, Selection, SelectType, SelState } from './select'
import { SelectionFilter } from './selectionfilter'
import { PointF, type RectF } from '../../framework/draw/types/geometry'
import { DurationType, INVALID_STRING_INDEX, NoteHeadGroup, nidx, type CapoParams } from '../types/types'
import { NoteType } from './chordrest'
import { Tpc } from './pitchspelling'
import type { Rest } from './rest'
import { CHORD_REST_OR_TIME_TICK_TYPE } from './segment'
import { y2pitch } from './utils'
import { TranslatableString } from '../../framework/global/types/translatablestring'
import { TConv } from '../types/typesconv'
import { InputState, type NoteEntryMethod } from './input'
import type { UndoCommand, UndoStack } from '../editing/undo'
import { UpdateMode, type CmdState } from '../editing/cmdstate'
import type { EditData } from '../editing/editdata'
import { EIDRegister } from '../infrastructure/eidregister'
import type { Excerpt } from './excerpt'
import { SynthesizerState } from './synthesizerstate'
import { type TempoMap, TEMPO_PRECISION } from './tempo'
import type { RepeatList } from './repeatlist'
import { Constants } from '../types/constants'
import { RealIsEqual, RealIsNull, RealRound } from '../../framework/global/realfn'
import type { GradualTempoChange } from './gradualtempochange'
import type { TempoText } from './tempotext'
import type { Fermata } from './fermata'
import type { Breath } from './breath'
import type { StaffTextBase } from './stafftextbase'
import { ShadowNote } from './shadownote'

export enum LayoutMode {
    PAGE, FLOAT, LINE, SYSTEM, HORIZONTAL_FIXED,
}

export enum Pad {
    NOTE00,
    NOTE0,
    NOTE1,
    NOTE2,
    NOTE4,
    NOTE8,
    NOTE16,
    NOTE32,
    NOTE64,
    NOTE128,
    NOTE256,
    NOTE512,
    NOTE1024,
    //--------------------
    REST,
    DOT,
    DOT2,
    DOT3,
    DOT4,
}

/** C++ struct Position (a note input position) */
export class Position {
    segment: Segment | null = null
    staffIdx: staff_idx_t = nidx
    line = 0
    fret = -1 // INVALID_FRET_INDEX
    pos = new PointF()
}

/** C++ struct NoteInputParams */
export interface NoteInputParams {
    step: number
    drumPitch: number
}

/**
 * Simplified replacement of the C++ SpannerMap (an interval tree):
 * spanners are kept in a list ordered by start tick.
 * Spanners with the same start tick are kept in the order they were first added (C++ std::multimap: the order of
 * insertion): a spanner added again (undo of a removal) gets its former place back, so undo restores the layout
 * exactly (in C++ it goes to the end of the spanners with that tick).
 */
export class SpannerMap {
    private m_spanners: Spanner[] = []
    private static s_nextSeq = 0
    private static s_seq = new WeakMap<Spanner, number>()

    addSpanner(s: Spanner): void {
        let seq = SpannerMap.s_seq.get(s)
        if (seq === undefined) {
            seq = SpannerMap.s_nextSeq++
            SpannerMap.s_seq.set(s, seq)
        }
        const t = s.tick().ticks()
        let i = this.m_spanners.length
        while (i > 0) {
            const p = this.m_spanners[i - 1]
            const pt = p.tick().ticks()
            if (pt > t || (pt === t && (SpannerMap.s_seq.get(p) ?? 0) > seq)) {
                --i
            } else {
                break
            }
        }
        this.m_spanners.splice(i, 0, s)
    }

    removeSpanner(s: Spanner): boolean {
        const i = this.m_spanners.indexOf(s)
        if (i >= 0) {
            this.m_spanners.splice(i, 1)
            return true
        }
        return false
    }

    /** all spanners overlapping [start, stop] (inclusive like the C++ interval tree query) */
    findOverlapping(start: number, stop: number, excludeCollisions = false): Spanner[] {
        return this.m_spanners.filter(s => {
            const t1 = s.tick().ticks()
            const t2 = s.tick2().ticks()
            if (excludeCollisions) {
                return t1 < stop && t2 > start
            }
            return t1 <= stop && t2 >= start
        })
    }

    findContained(start: number, stop: number): Spanner[] {
        return this.m_spanners.filter(s => s.tick().ticks() >= start && s.tick2().ticks() <= stop)
    }

    all(): readonly Spanner[] { return this.m_spanners }
    clear(): void { this.m_spanners = [] }
}

export enum LoopBoundaryType {
    Unknown = -1,
    LoopIn = 0,
    LoopOut = 1,
}

function markInstrumentsAsPrimary(parts: readonly Part[]): void {
    const instrumentCount = new Map<string /*instrumentId*/, number /*count*/>()

    for (const part of parts) {
        const instrument = part.instrument()
        if (!instrument) {
            continue
        }

        const count = (instrumentCount.get(instrument.id()) ?? 0) + 1
        instrumentCount.set(instrument.id(), count)

        instrument.setIsPrimary(count % 2 !== 0)
    }
}

function roundTempo(bps: number): number {
    return RealRound(bps, TEMPO_PRECISION)
}

/** set by compat/dummyelement.ts (C++ Score::dummy()->system(); avoids a circular import) */
export const scoreDummyHooks: { system?: (score: Score) => System } = {}

/** C++ renderer()->layoutScore(): set by rendering/score/scorerenderer.ts */
export const scoreRendererHooks: {
    layoutScore?: (score: Score, st: Fraction, et: Fraction) => void
    /** C++ renderer()->layoutItem(item) */
    layoutItem?: (item: EngravingItem) => void
} = {}

export class Score extends EngravingObject {
    protected m_style: MStyle
    private m_systemLocks = new SystemLocks()
    private m_systemDividers = new Map<number, [SystemDivider | null, SystemDivider | null]>() // list of system dividers (left and right) indexed by system
    protected m_eidRegister = new EIDRegister() // used of the master score only
    protected m_staves: Staff[] = []
    protected m_parts: Part[] = []
    protected m_systemObjectStaves: Staff[] = []
    protected m_measures = new MeasureBaseList()
    protected m_systems: System[] = []
    protected m_pages: Page[] = []
    protected m_spanner = new SpannerMap()
    protected m_unmanagedSpanners = new Set<Spanner>()
    private m_chordList = new ChordList()
    protected m_metaTags = new Map<string, string>()
    protected m_engravingFont: EngravingFont | null = null
    protected m_noteHeadWidth: number | null = null

    protected m_mscVersion = 470
    private m_resetAutoplace = false
    private m_resetCrossBeams = false
    protected m_fileDivision = 480
    protected m_pageNumberOffset = 0
    protected m_layoutMode = LayoutMode.PAGE
    protected m_reflowWidth = 0
    protected m_showInvisible = true
    protected m_showUnprintable = true
    protected m_showFrames = true
    protected m_showPageborders = false
    protected m_showSoundFlags = true
    protected m_markIrregularMeasures = true
    protected m_showInstrumentNames = true
    protected m_printing = false
    protected m_scoreOrder = new ScoreOrder()
    protected m_isOpen = false
    protected m_synthesizerState = new SynthesizerState()
    private m_masterScore: import('./masterscore').MasterScore | null = null // the master score of a part (excerpt) score
    private m_excerpt: Excerpt | null = null
    private m_selection: Selection
    private m_selectionFilter = new SelectionFilter()
    private m_selectionChanged = false // C++ m_updateState.selectionChanged
    private m_showAnchors = new ShowAnchors()
    private m_is = new InputState()
    private m_shadowNote: ShadowNote | null = null
    protected m_updatesLocked = false
    protected m_needSetUpTempoMap = false

    /** C++ Score(MasterScore* parent, const MStyle& s) with parent: a part (excerpt) score */
    /**
     * C++ Score(MasterScore* parent, bool forcePartStyle = true) for a part score: most style settings are inherited from
     * the master score (TODO(port): DefaultStyle::defaultStyleForParts, the style file for parts of the preferences)
     */
    constructor(parent: import('./masterscore').MasterScore | null = null, forcePartStyle = true) {
        super(ElementType.SCORE, null)
        this.m_masterScore = parent
        this.m_score = this
        this.m_style = DefaultStyle.defaultStyle().clone()
        this.m_selection = new Selection(this)
        if (parent) {
            // inherit most style settings from parent
            this.m_style = parent.style().clone()

            // but borrow defaultStyle page layout settings
            for (const i of [Sid.pageWidth, Sid.pageHeight, Sid.pagePrintableWidth, Sid.pageEvenLeftMargin,
                Sid.pageOddLeftMargin, Sid.pageEvenTopMargin, Sid.pageEvenBottomMargin, Sid.pageOddTopMargin,
                Sid.pageOddBottomMargin, Sid.pageTwosided, Sid.spatium]) {
                this.m_style.set(i, DefaultStyle.defaultStyle().value(i))
            }
            // and force some style settings that just make sense for parts
            if (forcePartStyle) {
                this.m_style.set(Sid.concertPitch, false)
                this.m_style.set(Sid.createMultiMeasureRests, true)
                this.m_style.set(Sid.dividerLeft, false)
                this.m_style.set(Sid.dividerRight, false)
            }
        }
        // update style values
        this.m_style.precomputeValues()
        if (parent) {
            this.checkChordList()
            this.m_synthesizerState = parent.m_synthesizerState
            this.m_mscVersion = parent.m_mscVersion
        }
    }

    override score(): Score { return this }
    isMaster(): boolean { return false }
    override masterScore(): import('./masterscore').MasterScore {
        return this.m_masterScore ?? this as unknown as import('./masterscore').MasterScore
    }

    excerpt(): Excerpt | null { return this.m_excerpt }
    /** the name of the excerpt (part) of this score */
    name(): string { return this.m_excerpt ? this.m_excerpt.name() : '' }
    setExcerpt(e: Excerpt | null): void { this.m_excerpt = e }

    synthesizerState(): SynthesizerState { return this.m_synthesizerState }

    isOpen(): boolean { return this.m_isOpen }
    setIsOpen(open: boolean): void { this.m_isOpen = open }

    override style(): MStyle { return this.m_style }
    /** overlap: only the values of `s` that are not its defaults are set (C++ setStyle(const MStyle&, bool overlap)) */
    setStyle(s: MStyle, overlap = false): void {
        if (!overlap) {
            this.m_style = s.clone() // C++ copies the style
            this.styleChanged()
            return
        }
        for (let sid = Sid.NOSTYLE + 1; sid < Sid.STYLES; sid++) {
            if (!s.isDefault(sid as Sid)) {
                this.m_style.set(sid as Sid, s.value(sid as Sid))
            }
        }
        this.styleChanged()
    }

    engravingFont(): EngravingFont {
        if (!this.m_engravingFont) {
            this.m_engravingFont = engravingFonts().fontByName(this.m_style.styleSt(Sid.musicalSymbolFont))
        }
        return this.m_engravingFont
    }

    setEngravingFont(f: EngravingFont | null): void { this.m_engravingFont = f }

    /** set by styleChanged() in C++; computed on demand here */
    noteHeadWidth(): number {
        if (this.m_noteHeadWidth === null) {
            this.m_noteHeadWidth = this.engravingFont().width(SymId.noteheadBlack,
                this.m_style.spatium() / this.m_style.defaultSpatium())
        }
        return this.m_noteHeadWidth
    }
    setNoteHeadWidth(n: number | null): void { this.m_noteHeadWidth = n }

    override styleChanged(): void {
        this.m_engravingFont = null
        this.m_noteHeadWidth = null
        this.m_style.precomputeValues()
    }

    mscVersion(): number { return this.m_mscVersion }
    setMscVersion(v: number): void { this.m_mscVersion = v }

    /** the positions of all elements are reset after the next layout (resetAutoplace) */
    setResetAutoplace(): void { this.m_resetAutoplace = true }
    /** the cross staff beams of MuseScore 1/2 are reset after the next layout (resetCrossBeams) */
    setResetCrossBeams(): void { this.m_resetCrossBeams = true }

    fileDivision(t: number): number {
        return Math.trunc((t * 480 + Math.trunc(this.m_fileDivision / 2)) / this.m_fileDivision)
    }
    setFileDivision(t: number): void { this.m_fileDivision = t }

    pageNumberOffset(): number { return this.m_pageNumberOffset }
    setPageNumberOffset(v: number): void { this.m_pageNumberOffset = v }

    layoutMode(): LayoutMode { return this.m_layoutMode }
    setLayoutMode(m: LayoutMode): void { this.m_layoutMode = m }
    lineMode(): boolean { return this.m_layoutMode === LayoutMode.LINE }
    linearMode(): boolean { return this.m_layoutMode === LayoutMode.LINE || this.m_layoutMode === LayoutMode.HORIZONTAL_FIXED }
    floatMode(): boolean { return this.m_layoutMode === LayoutMode.FLOAT }
    pageMode(): boolean { return this.m_layoutMode === LayoutMode.PAGE }

    /**
     * Not in MuseScore: the page width (in pixels) of the "fit to window" view, a continuous vertical view
     * (LayoutMode.SYSTEM) whose systems are as wide as the window and ignore the system and page breaks;
     * 0 = the normal vertical view (page width of the style, with breaks)
     */
    reflowWidth(): number { return this.m_reflowWidth }
    setReflowWidth(w: number): void { this.m_reflowWidth = w }

    isShowInvisible(): boolean { return this.m_showInvisible }
    setShowInvisible(v: boolean): void { this.m_showInvisible = v }
    showUnprintable(): boolean { return this.m_showUnprintable }
    setShowUnprintable(v: boolean): void { this.m_showUnprintable = v }
    showFrames(): boolean { return this.m_showFrames }
    setShowFrames(v: boolean): void { this.m_showFrames = v }
    showPageborders(): boolean { return this.m_showPageborders }
    setShowPageborders(v: boolean): void { this.m_showPageborders = v }
    showSoundFlags(): boolean { return this.m_showSoundFlags }
    setShowSoundFlags(v: boolean): void { this.m_showSoundFlags = v }
    markIrregularMeasures(): boolean { return this.m_markIrregularMeasures }
    setMarkIrregularMeasures(v: boolean): void { this.m_markIrregularMeasures = v }
    showInstrumentNames(): boolean { return this.m_showInstrumentNames }
    setShowInstrumentNames(v: boolean): void { this.m_showInstrumentNames = v }
    printing(): boolean { return this.m_printing }
    setPrinting(v: boolean): void { this.m_printing = v }

    // ---------------------------------------------------------------------------------
    // undo, command state and layout (the commands' startCmd/endCmd/update are in editing/cmd.ts)
    // ---------------------------------------------------------------------------------

    undoStack(): UndoStack { return this.masterScore().undoStack() }
    activeMidiPitches(): import('./masterscore').MidiInputEvent[] { return this.masterScore().activeMidiPitches() }
    cmdState(): CmdState { return this.masterScore().cmdState() }

    /** C++ Score::undo(UndoCommand*, EditData*): performs the command and records it in the active macro */
    undo(cmd: UndoCommand, ed: EditData | null = null): void {
        this.undoStack().pushAndPerform(cmd, ed)
    }

    dirty(): boolean { return !this.undoStack().isClean() }

    setUpdateAll(): void { this.masterScore().cmdState().setUpdateMode(UpdateMode.UpdateAll) }

    setLayoutAll(staff: staff_idx_t = nidx, e: EngravingItem | null = null): void {
        const cs = this.cmdState()
        cs.setTick(new Fraction(0, 1))
        cs.setTick(Fraction.max())

        if (e && e.score() === this.masterScore()) {
            // TODO: map staff number properly
            const startStaff = staff === nidx ? 0 : staff
            const endStaff = staff === nidx ? (this.nstaves() - 1) : staff
            cs.setStaff(startStaff)
            cs.setStaff(endStaff)

            cs.setElement(e)
        }
    }

    setLayout(t: Fraction, staff: staff_idx_t, e: EngravingItem | null = null): void {
        const cs = this.cmdState()
        if (t.ge(new Fraction(0, 1))) {
            cs.setTick(t)
        }

        if (e && e.score() === this.masterScore()) {
            // TODO: map staff number properly
            cs.setStaff(staff)
            cs.setElement(e)
        }
    }

    /** C++ setLayout(tick1, tick2, staff1, staff2, e) (renamed: no overloads in TS) */
    setLayoutRange(tick1: Fraction, tick2: Fraction, staff1: staff_idx_t, staff2: staff_idx_t, e: EngravingItem | null = null): void {
        const cs = this.cmdState()
        if (tick1.ge(new Fraction(0, 1))) {
            cs.setTick(tick1)
        }
        if (tick2.ge(new Fraction(0, 1))) {
            cs.setTick(tick2)
        }

        if (e && e.score() === this.masterScore()) {
            // TODO: map staff number properly
            cs.setStaff(staff1)
            cs.setStaff(staff2)

            cs.setElement(e)
        }
    }

    lockUpdates(locked: boolean): void { this.m_updatesLocked = locked }
    updatesLocked(): boolean { return this.m_updatesLocked }
    setNeedSetUpTempoMap(v: boolean): void { this.m_needSetUpTempoMap = v }
    needSetUpTempoMap(): boolean { return this.m_needSetUpTempoMap }

    /** do a complete (re-) layout */
    doLayout(): void {
        this.doLayoutRange(new Fraction(0, 1), new Fraction(-1, 1))
    }

    doLayoutRange(st: Fraction, et: Fraction): void {
        let start = st
        let end = et

        for (const spanner of this.spannerMap().findOverlapping(st.ticks(), et.ticks())) {
            if (!spanner.staff()?.visible()) {
                continue
            }
            start = st.lt(spanner.tick()) ? st : spanner.tick()
            end = et.gt(spanner.tick2()) ? et : spanner.tick2()
        }

        this.m_engravingFont = null
        this.m_noteHeadWidth = null

        // TODO(port): LayoutFlag::REBUILD_MIDI_MAPPING (playback)

        if (!Score.partialLayout) {
            start = new Fraction(0, 1)
            end = new Fraction(-1, 1)
        }
        scoreRendererHooks.layoutScore!(this, start, end)

        if (this.m_resetAutoplace) {
            this.m_resetAutoplace = false
            this.resetAutoplace()
        }

        if (this.m_resetCrossBeams) {
            this.m_resetCrossBeams = false
            this.resetCrossBeams()
        }
    }

    /** lay out only the changed range like C++ (false: the whole score, e.g. to compare the results) */
    static partialLayout = true

    // ---------------------------------------------------------------------------------
    // note input
    // ---------------------------------------------------------------------------------

    inputState(): InputState { return this.m_is }
    setInputState(st: InputState): void { this.m_is = st.clone() }
    /** the shadow note of note input (C++ m_shadowNote, created in the constructor; here on first use) */
    shadowNote(): ShadowNote {
        this.m_shadowNote ??= new ShadowNote(this)
        return this.m_shadowNote
    }
    noteEntryMode(): boolean { return this.m_is.noteEntryMode() }
    usingNoteEntryMethod(m: NoteEntryMethod): boolean { return this.m_is.usingNoteEntryMethod(m) }

    // selection (score.cpp; TODO(port): accessibility focus, refresh rectangles)

    selection(): Selection { return this.m_selection }
    selectionFilter(): SelectionFilter { return this.m_selectionFilter }
    selectionEmpty(): boolean { return this.m_selection.staffStart() === this.m_selection.staffEnd() }
    selectionChanged(): boolean { return this.m_selectionChanged }

    /** C++ dragPosition(pos, &staffIdx, &seg, spacingFactor, allowTimeAnchor): the staff and segment at pos */
    dragPosition(pos: PointF, staffIdx: staff_idx_t, seg: Segment | null, spacingFactor: number,
        allowTimeAnchor: boolean): { staffIdx: staff_idx_t; seg: Segment | null } {
        const r = dragPositionToMeasure(pos, this, null, staffIdx, spacingFactor)
        if (!r) {
            return { staffIdx, seg }
        }

        return { staffIdx: r.staffIdx, seg: dragPositionToSegment(pos, r.measure, r.staffIdx, seg, spacingFactor, allowTimeAnchor) ?? seg }
    }

    hideAnchors(): void { this.m_showAnchors.reset() }
    setShowAnchors(showAnchors: ShowAnchors): void { this.m_showAnchors = showAnchors }
    showAnchors(): ShowAnchors { return this.m_showAnchors }
    setSelectionChanged(val: boolean): void { this.m_selectionChanged = val }
    deselectAll(): void { this.m_selection.deselectAll() }
    updateSelection(): void { this.m_selection.update() }
    getSelectedElement(): EngravingItem | null { return this.m_selection.element() }

    deselect(el: EngravingItem): void {
        this.m_selection.remove(el)
        this.setSelectionChanged(true)
        this.m_selection.update()
    }

    // ---- lasso selection (score.cpp: lassoSelect, lassoSelectEnd) ----

    /** selects the elements whose bounding box is in bbox (canvas coordinates) */
    lassoSelect(bbox: RectF): void {
        this.select(null, SelectType.SINGLE, 0)
        const fr = bbox.normalized()
        for (const page of this.pages()) {
            const pr = page.ldata().bbox()
            const frr = fr.translated(page.pos().times(-1))
            if (pr.right() < frr.left()) {
                continue
            }
            if (pr.left() > frr.right()) {
                break
            }

            const items = page.items(frr)
            const itemsToSelect: EngravingItem[] = []

            for (const item of items) {
                if (frr.contains(item.pageBoundingRect())) {
                    if (!item.isMeasure() && item.selectable()) {
                        itemsToSelect.push(item)
                    }
                }
            }

            this.select(itemsToSelect, SelectType.ADD, 0)
        }
    }

    lassoSelectEnd(): void {
        let noteRestCount = 0
        let startSegment: Segment | null = null
        let endSegment: Segment | null = null
        let startStaff = 0x7fffffff
        let endStaff = 0
        let endCR: ChordRest | null = null

        if (this.m_selection.elements().length === 0) {
            this.m_selection.setState(SelState.NONE)
            return
        }
        this.m_selection.setState(SelState.LIST)

        for (let e of this.m_selection.elements()) {
            if (!e.isNote() && !e.isRest()) {
                continue
            }
            ++noteRestCount
            if (e.isNote()) {
                e = e.parentItem()!
            }
            const seg = (e as unknown as ChordRest).segment()
            if (!startSegment || seg.lessThan(startSegment)) {
                startSegment = seg
            }
            if (!endSegment || endSegment.lessThan(seg)) { // C++ *seg > *endSegment
                endSegment = seg
                endCR = e as unknown as ChordRest
            }
            const idx = e.staffIdx()
            if (idx < startStaff) {
                startStaff = idx
            }
            if (idx > endStaff) {
                endStaff = idx
            }
        }
        if (noteRestCount > 0) {
            endSegment = endCR!.nextSegmentAfterCR(SegmentType.ChordRest | SegmentType.EndBarLine | SegmentType.Clef)
            this.m_selection.setRange(startSegment, endSegment, startStaff, endStaff + 1)
            if (!this.m_selection.isRange()) {
                this.m_selection.setState(SelState.RANGE)
            }
            this.m_selection.updateSelectedElements()
        }
    }

    /** staffIdx is valid, if element is of type MEASURE */
    select(item: EngravingItem | null | readonly (EngravingItem | null)[], type = SelectType.SINGLE, staffIdx: staff_idx_t = 0): void {
        const items = Array.isArray(item) ? item : [item as EngravingItem | null]
        for (const it of items) {
            this.doSelect(it, type, staffIdx)
        }
        // C++: onFocusedItemChanged(m_selection.elements().back()) (accessibility)
    }

    private doSelect(e: EngravingItem | null, type: SelectType, staffIdx: staff_idx_t): void {
        switch (type) {
        case SelectType.SINGLE:
            this.selectSingle(e, staffIdx)
            break
        case SelectType.ADD:
            this.selectAdd(e!)
            break
        case SelectType.RANGE:
            this.selectRange(e!, staffIdx)
            break
        case SelectType.REPLACE:
            break
        }
        this.setSelectionChanged(true)
    }

    /** staffIdx is valid, if element is of type MEASURE */
    private selectSingle(e: EngravingItem | null, staffIdx: staff_idx_t): void {
        let selState = this.m_selection.state()
        this.deselectAll()
        if (!e) {
            selState = SelState.NONE
        } else {
            if (e.isMeasure()) {
                this.doSelect((e as unknown as Measure).coveringMMRestOrThis(), SelectType.RANGE, staffIdx)
                return
            }
            this.m_selection.add(e)
            this.m_is.setTrack(e.track())
            selState = SelState.LIST
            if (e.isNote()) {
                e = e.parentItem()!
            }
            if (e.isChordRest()) {
                this.m_is.setLastSegment(this.m_is.segment())
                this.m_is.setSegment((e as unknown as ChordRest).segment())
            }
        }
        this.m_selection.setActiveSegment(null)
        this.m_selection.setActiveTrack(0)

        this.m_selection.setState(selState)
    }

    private selectAdd(e: EngravingItem): void {
        let selState = this.m_selection.state()

        if (this.m_selection.isRange()) {
            this.doSelect(e, SelectType.SINGLE, 0)
            return
        }

        if (e.isMeasure()) {
            const m = (e as unknown as Measure).coveringMMRestOrThis()
            const tick = m.tick()
            if (this.m_selection.isNone()) {
                this.m_selection.setRange(m.tick2segment(tick), m === this.lastMeasureMM() ? null : m.last(), 0, this.nstaves())
                selState = SelState.RANGE
                this.m_selection.updateSelectedElements()
            }
        } else if (!this.m_selection.elements().includes(e)) {
            selState = SelState.LIST
            this.m_selection.add(e)
        }

        this.m_selection.setState(selState)
    }

    /** staffIdx is valid, if element is of type MEASURE */
    private selectRange(e: EngravingItem, staffIdx: staff_idx_t): void {
        if (this.m_selection.isSingle()) {
            if (!e.isMeasureBase() && !e.isNote() && !e.isChordRest()) {
                // Try to select similar in range
                if (this.trySelectSimilarInRange(e)) {
                    return
                }
            }

            // Try to extend single selection into range selection
            if (this.tryExtendSingleSelectionToRange(e, staffIdx)) {
                return
            }
        }

        if (e.isMeasure()) {
            const m = (e as unknown as Measure).coveringMMRestOrThis()
            const startSegment = m.first(SegmentType.ChordRest)
            const endSegment = m === this.lastMeasureMM() ? null : m.last()
            const tick = m.tick()
            const etick = tick.plus(m.ticks())

            if (this.m_selection.isRange()) {
                // Extend existing range selection
                this.m_selection.extendRangeSelection(startSegment, endSegment, staffIdx, tick, etick)
            } else {
                // Create new range selection
                if (!this.m_selection.isNone()) {
                    this.deselectAll()
                }
                this.m_selection.setRange(startSegment, endSegment, staffIdx, staffIdx + 1)
            }

            this.m_selection.updateSelectedElements()
            this.m_selection.setActiveTrack(staffIdx * VOICES)
            return
        }

        if (this.m_selection.isRange()) {
            // Extend existing range selection
            const startSegment = findElementStartSegment(this, e)
            if (startSegment) {
                const endSegment = findElementEndSegment(this, e, this.m_selection.endSegment())
                const elementStaffIdx = e.staffIdx()
                if (endSegment && elementStaffIdx !== nidx) {
                    const tick = startSegment.tick()
                    const etick = endSegment.tick()

                    this.m_selection.extendRangeSelection(startSegment, endSegment, elementStaffIdx, tick, etick)
                    this.m_selection.updateSelectedElements()

                    this.m_selection.setActiveTrack(e.track())
                    return
                }
            }
        }

        if (e.isNote() || e.isChordRest()) {
            // Create new range selection
            if (!this.m_selection.isNone()) {
                this.deselectAll()
            }

            const cr = (e.isNote() ? e.parentItem() : e) as unknown as ChordRest

            const st = SegmentType.ChordRest | SegmentType.EndBarLine | SegmentType.Clef
            this.m_selection.setRange(cr.segment(), cr.nextSegmentAfterCR(st), cr.staffIdx(), cr.staffIdx() + 1)
            this.m_selection.updateSelectedElements()

            this.m_selection.setActiveTrack(cr.track())
            return
        }

        // Nothing worked; just select the new element
        this.doSelect(e, SelectType.SINGLE, staffIdx)
    }

    private trySelectSimilarInRange(e: EngravingItem): boolean {
        const selectedElement = this.m_selection.element()
        if (!selectedElement || e.type() !== selectedElement.type()) {
            return false
        }

        let idx1 = selectedElement.staffIdx()
        let idx2 = e.staffIdx()

        if (idx1 === nidx || idx2 === nidx) {
            return false
        }

        if (idx2 < idx1) {
            [idx1, idx2] = [idx2, idx1]
        }

        let t1 = selectedElement.tick()
        let t2 = e.tick()
        if (t1.gt(t2)) {
            [t1, t2] = [t2, t1]
        }

        const s1 = this.tick2segmentMM(t1, true, SegmentType.ChordRest)
        let s2 = this.tick2segmentMM(t2, true, SegmentType.ChordRest)
        if (s2) {
            s2 = s2.next1MM(SegmentType.ChordRest)
        }

        if (!s1) {
            return false
        }

        this.m_selection.setRange(s1, s2, idx1, idx2 + 1)
        this.selectSimilarInRange(e)
        if (selectedElement.track() === e.track()) {
            // limit to this voice only
            const list = [...this.m_selection.elements()]
            for (const el of list) {
                if (el.track() !== e.track()) {
                    this.m_selection.remove(el)
                }
            }
        }

        return true
    }

    private tryExtendSingleSelectionToRange(newElement: EngravingItem, staffIdx: staff_idx_t): boolean {
        const selectedElement = this.m_selection.element()
        if (!selectedElement) {
            return false
        }

        let startSegment = findElementStartSegment(this, selectedElement)
        if (!startSegment) {
            return false
        }

        let endSegment = findElementEndSegment(this, selectedElement, startSegment)

        let startStaffIdx = selectedElement.staffIdx()
        if (startStaffIdx === nidx) {
            return false
        }

        let endStaffIdx = startStaffIdx + 1
        let activeTrack = newElement.track()
        let activeSegmentIsStart = false

        if (newElement.isMeasure()) {
            const m = (newElement as unknown as Measure).coveringMMRestOrThis()
            const tick = m.tick()

            if (tick.lt(startSegment.tick())) {
                startSegment = m.first(SegmentType.ChordRest)!
                activeSegmentIsStart = true
            }
            if (m === this.lastMeasureMM()) {
                endSegment = null
            } else if (endSegment && tick.plus(m.ticks()).gt(endSegment.tick())) {
                endSegment = m.last()
            }

            startStaffIdx = Math.min(startStaffIdx, staffIdx)
            endStaffIdx = Math.max(endStaffIdx, staffIdx + 1)

            activeTrack = staffIdx * VOICES
        } else {
            const newStartSegment = findElementStartSegment(this, newElement)
            if (newStartSegment && newStartSegment.tick().lt(startSegment.tick())) {
                startSegment = newStartSegment
                activeSegmentIsStart = true
            }

            const newEndSegment = findElementEndSegment(this, newElement, newStartSegment)
            if (endSegment && (!newEndSegment || newEndSegment.tick().gt(endSegment.tick()))) {
                endSegment = newEndSegment
            }

            const newStaffIdx = newElement.staffIdx()
            if (newStaffIdx !== nidx) {
                startStaffIdx = Math.min(startStaffIdx, newStaffIdx)
                endStaffIdx = Math.max(endStaffIdx, newStaffIdx + 1)
            }
        }

        this.m_selection.setRange(startSegment, endSegment, startStaffIdx, endStaffIdx)
        this.m_selection.updateSelectedElements()

        this.m_selection.setActiveTrack(activeTrack)
        this.m_selection.setActiveSegment(activeSegmentIsStart ? startSegment : endSegment)

        return true
    }

    static collectMatch(p: ElementPattern, e: EngravingItem): void {
        if (p.type !== ElementType.INVALID && p.type !== e.type()) {
            return
        }

        if (p.type === ElementType.NOTE) {
            if (p.subtype < 0) {
                if (!(e as unknown as Note).chord().isGrace()) {
                    return
                }
            } else if ((e as unknown as Note).chord().isGrace() || p.subtype !== e.subtype()) {
                return
            }
        } else if (p.subtypeValid && p.subtype !== e.subtype()) {
            return
        }

        if (p.staffStart !== nidx
            && (p.staffStart > e.staffIdx() || p.staffEnd <= e.staffIdx())) {
            return
        }

        if (p.voice !== nidx && p.voice !== e.voice()) {
            return
        }

        if (p.system) {
            let ee: EngravingItem | null = e
            do {
                if (ee.isSystem()) {
                    if (p.system !== (ee as unknown as System)) {
                        return
                    }
                    break
                }
                ee = ee.parentItem()
            } while (ee)
        }

        if (e.isRest() && !p.durationTicks.eq(new Fraction(-1, 1))) {
            const r = e as unknown as Rest
            if (!p.durationTicks.eq(r.actualTicks())) {
                return
            }
        }

        if (p.measure) {
            let eMeasure = e.findMeasure()
            if (!eMeasure && e.isSpannerSegment()) {
                const s = (e as unknown as SpannerSegment).spanner()
                if (s) {
                    const se = s.startElement()
                    if (se) {
                        const mse = se.findMeasure()
                        if (mse) {
                            eMeasure = mse
                        }
                    }
                }
            }
            if (p.measure !== eMeasure) {
                return
            }
        }

        if (p.beat.isValid() && !p.beat.eq(e.beat())) {
            return
        }

        p.el.push(e)
    }

    static collectNoteMatch(p: NotePattern, e: EngravingItem): void {
        if (!e.isNote()) {
            return
        }
        const n = e as unknown as Note
        if (p.noteType !== NoteType.INVALID && p.noteType !== n.noteType()) {
            return
        }
        if (p.pitch !== -1 && p.pitch !== n.pitch()) {
            return
        }
        if (p.string !== INVALID_STRING_INDEX && p.string !== n.string()) {
            return
        }
        if (p.tpc !== Tpc.TPC_INVALID && p.tpc !== n.tpc()) {
            return
        }
        if (p.notehead !== NoteHeadGroup.HEAD_INVALID && p.notehead !== n.headGroup()) {
            return
        }
        if (p.durationType.type() !== DurationType.V_INVALID && !p.durationType.equals(n.chord().actualDurationType())) {
            return
        }
        if (!p.durationTicks.eq(new Fraction(-1, 1)) && !p.durationTicks.eq(n.chord().actualTicks())) {
            return
        }
        if (p.staffStart !== nidx
            && (p.staffStart > e.staffIdx() || p.staffEnd <= e.staffIdx())) {
            return
        }
        if (p.voice !== nidx && p.voice !== e.voice()) {
            return
        }
        if (p.system && p.system !== n.chord().segment()!.system()) {
            return
        }
        if (p.measure && p.measure !== n.findMeasure()) {
            return
        }
        if (p.beat.isValid() && !p.beat.eq(n.beat())) {
            return
        }
        p.el.push(n)
    }

    selectSimilar(e: EngravingItem, sameStaff: boolean): void {
        const score = e.score()

        const pattern = new ElementPattern()
        pattern.type = e.type()
        pattern.subtype = 0
        pattern.subtypeValid = false
        if (e.isNote()) {
            if ((e as unknown as Note).chord().isGrace()) {
                pattern.subtype = -1 // hack
            } else {
                pattern.subtype = e.subtype()
            }
        } else if (e.isHairpinSegment() || e.isHarmony()) {
            pattern.subtype = e.subtype()
            pattern.subtypeValid = true
        }
        pattern.staffStart = sameStaff ? e.staffIdx() : nidx
        pattern.staffEnd = sameStaff ? e.staffIdx() + 1 : nidx
        pattern.voice = nidx

        score.scanElements(item => Score.collectMatch(pattern, item))

        score.select(null, SelectType.SINGLE, 0)
        score.select(pattern.el, SelectType.ADD, 0)
    }

    selectSimilarInRange(e: EngravingItem): void {
        const score = e.score()

        const pattern = new ElementPattern()
        pattern.type = e.type()
        pattern.subtype = 0
        pattern.subtypeValid = false
        if (e.isNote()) {
            if ((e as unknown as Note).chord().isGrace()) {
                pattern.subtype = -1 // hack
            } else {
                pattern.subtype = e.subtype()
            }
            pattern.subtypeValid = true
        } else if (e.isHairpinSegment() || e.isHarmony()) {
            pattern.subtype = e.subtype()
            pattern.subtypeValid = true
        }
        pattern.staffStart = this.selection().staffStart()
        pattern.staffEnd = this.selection().staffEnd()
        pattern.voice = nidx

        score.scanElementsInRange(item => Score.collectMatch(pattern, item))

        score.select(null, SelectType.SINGLE, 0)
        score.select(pattern.el, SelectType.ADD, 0)
    }

    scanElementsInRange(func: (item: EngravingItem) => void): void {
        const startSeg = this.m_selection.startSegment()
        for (let s = startSeg; s && s !== this.m_selection.endSegment(); s = s.next1()) {
            s.scanElements(func)
            const m = s.measure()
            if (m && s === m.first()) {
                const mmr = m.mmRest()
                if (mmr) {
                    mmr.scanElements(func)
                }
            }
        }

        const handledSpanners = new Set<Spanner>()
        for (const e of this.m_selection.elements()) {
            if (!e.isSpannerSegment()) {
                continue
            }
            const spanner = (e as unknown as SpannerSegment).spanner()!
            if (!handledSpanners.has(spanner)) {
                handledSpanners.add(spanner)
                for (const ss of spanner.spannerSegments()) {
                    ss.scanElements(func)
                }
            }
        }
    }

    cmdSelectAll(): void {
        if (this.m_measures.size() === 0) {
            return
        }
        this.deselectAll()
        const first = this.firstMeasureMM()
        if (!first) {
            return
        }
        const last = this.lastMeasureMM()!
        this.selectRange(first, 0)
        this.selectRange(last, this.nstaves() - 1)
    }

    getTextStyleUserName(tid: TextStyleType): TranslatableString {
        if (tid >= TextStyleType.USER1 && tid <= TextStyleType.USER12) {
            const idx = tid - TextStyleType.USER1
            const sid = [Sid.user1Name, Sid.user2Name, Sid.user3Name, Sid.user4Name, Sid.user5Name, Sid.user6Name,
                Sid.user7Name, Sid.user8Name, Sid.user9Name, Sid.user10Name, Sid.user11Name, Sid.user12Name]
            const userName = this.style().styleSt(sid[idx])
            if (userName) {
                return TranslatableString.untranslatable(userName)
            }
        }
        return TConv.userNameTextStyleType(tid)
    }

    // position -> score (score.cpp)

    /**
     * Return measure for canvas relative position p (C++ out parameters: rst, pitch, seg, offset are returned).
     */
    pos2measure(p: PointF): { measure: Measure; staffIdx: staff_idx_t; pitch: number; segment: Segment; offset: PointF } | null {
        const m = this.searchMeasure(p)
        if (!m) {
            return null
        }

        const s = m.system()!
        const y = p.y() - s.canvasPos().y()

        const i = s.searchStaff(y)

        // search for segment + offset
        const pppp = p.minus(m.canvasPos())
        const strack = i * VOICES
        if (!this.staff(i)) {
            return null
        }
        const etrack = VOICES + strack

        const segment = m.searchSegment(pppp.x(), SegmentType.ChordRest, strack, etrack)
        if (segment) {
            const sstaff = m.system()!.staves()[i]
            const s1 = this.m_staves[i]
            const tick = segment.tick()
            const clef = s1.clef(tick)
            const pitch = y2pitch(pppp.y() - sstaff.bbox().y(), clef, s1.spatium(tick))
            const offset = pppp.minus(new PointF(segment.x(), sstaff.bbox().y()))
            return { measure: m, staffIdx: i, pitch, segment, offset }
        }

        return null
    }

    /** p is in canvas coordinates */
    searchPage(p: PointF): Page | null {
        if (this.layoutMode() === LayoutMode.LINE) {
            return this.m_pages.length ? this.m_pages[0] : null
        }

        for (const page of this.m_pages) {
            const r = page.ldata().bbox().translated(page.pos())
            if (r.contains(p)) {
                return page
            }
        }

        return null
    }

    /**
     * Returns list of systems as there may be more than one system in a row
     * pos: Position in canvas coordinates; preferredSystem: if not null, will give more space to the given system
     * when searching it by its coordinate.
     */
    searchSystem(pos: PointF, preferredSystem: System | null = null, spacingFactor = 0.5, preferredSpacingFactor = 0.75): System[] {
        const systems: System[] = []
        const page = this.searchPage(pos)
        if (!page) {
            return systems
        }
        const y = pos.y() - page.pos().y() // transform to page relative
        const sl = page.systems()
        let y2: number
        const n = sl.length
        for (let i = 0; i < n; ++i) {
            const s = sl[i]
            if (!s.firstMeasure()) {
                continue
            }
            let ns: System | null = null // next system row
            let ii = i + 1
            for (; ii < n; ++ii) {
                ns = sl[ii]
                if (ns.y() !== s.y()) {
                    break
                }
            }
            if (ii === n || !ns) {
                y2 = page.height()
            } else {
                let currentSpacingFactor: number
                const sy2 = s.y() + s.ldata().bbox().height()
                if (s === preferredSystem) {
                    currentSpacingFactor = preferredSpacingFactor
                } else if (ns === preferredSystem) {
                    currentSpacingFactor = 1.0 - preferredSpacingFactor
                } else {
                    currentSpacingFactor = spacingFactor
                }
                y2 = sy2 + (ns.y() - sy2) * currentSpacingFactor
            }
            if (y < y2) {
                systems.push(s)
                for (let iii = i + 1; iii < n; ++iii) {
                    if (sl[iii].y() !== s.y()) {
                        break
                    }
                    systems.push(sl[iii])
                }
                return systems
            }
        }
        return systems
    }

    /** p: Position in canvas coordinates; preferredSystem: if not null, will give more space to measures in this system */
    searchMeasure(p: PointF, preferredSystem: System | null = null, spacingFactor = 0.5, preferredSpacingFactor = 0.75): Measure | null {
        const systems = this.searchSystem(p, preferredSystem, spacingFactor, preferredSpacingFactor)
        for (const system of systems) {
            const x = p.x() - system.canvasPos().x()
            for (const mb of system.measures()) {
                if (mb.isMeasure() && x < (mb.x() + mb.ldata().bbox().width())) {
                    return mb as unknown as Measure
                }
            }
        }
        return null
    }

    // meta tags

    metaTag(name: string): string { return this.m_metaTags.get(name) ?? '' }
    setMetaTag(name: string, value: string): void { this.m_metaTags.set(name, value) }
    metaTags(): ReadonlyMap<string, string> { return this.m_metaTags }
    setMetaTags(tags: ReadonlyMap<string, string>): void { this.m_metaTags = new Map(tags) }

    // parts & staves

    parts(): Part[] { return this.m_parts }
    appendPart(part: Part): void {
        part.setScore(this)
        this.assignIdIfNeed(part)
        this.m_parts.push(part)
        markInstrumentsAsPrimary(this.m_parts)
    }

    insertPart(part: Part | null, targetPartIdx: number): void {
        if (!part) {
            return
        }

        part.setScore(this)
        this.assignIdIfNeed(part)

        if (targetPartIdx < this.m_parts.length) {
            this.m_parts.splice(targetPartIdx, 0, part)
        } else {
            this.m_parts.push(part)
        }

        this.masterScore().rebuildMidiMapping()
        this.masterScore().setInstrumentsChanged(true)
        markInstrumentsAsPrimary(this.m_parts)
    }

    removePart(part: Part): void {
        let index = this.m_parts.indexOf(part)

        if (index === -1) {
            index = this.m_parts.findIndex(p => p.id() === part.id())
        }

        this.m_parts.splice(index, 1)
        markInstrumentsAsPrimary(this.m_parts)

        if (this.m_excerpt) {
            const excerptParts = this.m_excerpt.parts()
            const i = excerptParts.findIndex(p => p.id() === part.id())
            if (i >= 0) {
                excerptParts.splice(i, 1)
                markInstrumentsAsPrimary(excerptParts)
            }
        }

        this.masterScore().rebuildMidiMapping()
        this.masterScore().setInstrumentsChanged(true)
    }

    /** C++ Score::assignIdIfNeed(Part&/Staff&); TODO(port): ids are numbered here, not muse::ID random-ish values */
    assignIdIfNeed(object: Part | Staff): void {
        if (object.id() && object.id() !== '0') { // C++ ID::isValid(): != 0
            return
        }
        const list: readonly (Part | Staff)[] = object.isStaff() ? this.m_staves : this.m_parts
        let id = 1
        for (const o of list) {
            id = Math.max(id, (parseInt(o.id(), 10) || 0) + 1)
        }
        object.setId(String(id))
    }

    staves(): Staff[] { return this.m_staves }
    nstaves(): number { return this.m_staves.length }
    ntracks(): number { return this.m_staves.length * VOICES }
    staff(n: number): Staff | null { return n >= 0 && n < this.m_staves.length ? this.m_staves[n] : null }
    staffIdx(staff: Staff): staff_idx_t { return this.m_staves.indexOf(staff) }

    /** links the measures to the measures of the (master) score (scorefile.cpp) */
    linkMeasures(score: Score): void {
        let mbMaster = score.first()
        for (let mb = this.first(); mb; mb = mb.next()) {
            if (!mb.isMeasure()) {
                continue
            }
            while (mbMaster && !mbMaster.isMeasure()) {
                mbMaster = mbMaster.next()
            }
            if (!mbMaster) {
                // C++: LOGD("Measures in MasterScore and Score are not in sync.")
                break
            }
            mb.linkTo(mbMaster)
            mbMaster = mbMaster.next()
        }
    }

    /** the master score and the scores of its excerpts */
    scoreList(): Score[] {
        const root = this.masterScore()
        const scores: Score[] = [root]
        for (const ex of root.excerpts()) {
            const s = ex.excerptScore()
            if (s) {
                scores.push(s)
            }
        }
        return scores
    }

    setPlaylistDirty(): void {
        this.masterScore().setPlaylistDirty()
    }

    staffById(staffId: string): Staff | null {
        for (const staff of this.m_staves) {
            if (staff.id() === staffId) {
                return staff
            }
        }

        return null
    }

    /** C++ Score::staffIdx(const Part*): index of the first staff of the part */
    staffIdxOfPart(part: Part): staff_idx_t {
        let idx = 0
        for (const p of this.m_parts) {
            if (p === part) {
                break
            }
            idx += p.nstaves()
        }
        return idx
    }

    insertStaff(staff: Staff | null, ridx: staff_idx_t): void {
        if (!staff || !staff.part()) {
            return
        }

        this.assignIdIfNeed(staff)
        staff.part().insertStaff(staff, ridx)

        const idx = this.staffIdxOfPart(staff.part()) + ridx
        this.m_staves.splice(idx, 0, staff)

        for (const s of staff.score().spanner()) {
            if (!moveDownWhenAddingStaves(s, idx)) {
                continue
            }
            if (s.staffIdx() >= idx) {
                let t = s.track() + VOICES
                if (t >= this.ntracks()) {
                    t = this.ntracks() - 1
                }
                s.setTrack(t)
                for (const ss of s.spannerSegments()) {
                    ss.setTrack(t)
                }
                if (s.track2() !== nidx) {
                    t = s.track2() + VOICES
                    s.setTrack2(t < this.ntracks() ? t : s.track())
                }
            }
        }

        this.updateStavesNumberForSystems()
    }

    updateStavesNumberForSystems(): void {
        for (const system of this.m_systems) {
            if (!system.firstMeasure()) {
                continue
            }

            system.adjustStavesNumber(this.nstaves())
        }
    }

    removeStaff(staff: Staff): void {
        const idx = staff.idx()
        for (const s of staff.score().spanner()) {
            if (s.staffIdx() > idx) {
                let t = s.track() >= VOICES ? s.track() - VOICES : 0
                s.setTrack(t)
                for (const ss of s.spannerSegments()) {
                    ss.setTrack(t)
                }
                if (s.track2() !== nidx) {
                    t = s.track2() - VOICES
                    s.setTrack2(t >= 0 ? t : s.track()) // C++: unsigned underflow -> nidx
                }
            }
        }

        const isSystemObjectStaff = staff.isSystemObjectStaff()
        this.m_staves.splice(this.m_staves.indexOf(staff), 1)
        staff.part().removeStaff(staff)

        if (isSystemObjectStaff) {
            this.removeSystemObjectStaff(staff)
        }

        this.updateStavesNumberForSystems()
    }

    sortSystemObjects(dst: readonly staff_idx_t[]): void {
        const moveTo: staff_idx_t[] = []
        for (const staff of this.m_systemObjectStaves) {
            const oldStaffIdx = staff.idx()
            let newStaffIfx = oldStaffIdx < dst.length ? dst[oldStaffIdx] : nidx

            if (moveTo.includes(newStaffIfx)) {
                newStaffIfx = nidx
            }

            moveTo.push(newStaffIfx)
        }

        const isSystemTextLine = (e: EngravingItem): boolean => e.isTextLineBase() && e.systemFlag()

        for (let i = 0; i < this.m_systemObjectStaves.length; i++) {
            if (moveTo[i] === this.m_systemObjectStaves[i].idx()) {
                // this sysobj staff doesn't move
                continue
            } else {
                // move all system objects from systemObjectStaves[i] to _staves[moveTo[i]]
                const track = staff2track(this.m_systemObjectStaves[i].idx())
                for (let mb = this.measures().first(); mb; mb = mb.next()) {
                    if (!mb.isMeasure()) {
                        continue
                    }

                    const m = mb as unknown as Measure
                    for (const e of [...m.el()]) {
                        if ((e.isJump() || e.isMarker()) && e.isLinked() && e.track() === track) {
                            if (moveTo[i] === nidx) {
                                // delete this clone
                                m.remove(e)
                                e.unlink()
                            } else {
                                e.setTrack(staff2track(this.m_staves[moveTo[i]].idx()))
                            }
                        }
                    }

                    for (let s = m.first(); s; s = s.next()) {
                        if (s.isChordRestType() || s.annotations().length) {
                            const annotations = [...s.annotations()] // make a copy since we alter the list
                            for (const e of annotations) {
                                if (e.isRehearsalMark() || e.isSystemText() || e.isTripletFeel() || e.isTempoText() || isSystemTextLine(e)) {
                                    if (e.track() === track && e.isLinked()) {
                                        if (moveTo[i] === nidx) {
                                            s.removeAnnotation(e)
                                            e.unlink()
                                        } else {
                                            e.setTrack(staff2track(this.m_staves[moveTo[i]].idx()))
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // update systemObjectStaves with the correct staff
                if (moveTo[i] === nidx) {
                    this.m_systemObjectStaves.splice(i, 1)
                    moveTo.splice(i, 1)
                } else {
                    this.m_systemObjectStaves[i] = this.m_staves[moveTo[i]]
                }
            }
        }
    }

    cmdConcertPitchChanged(flag: boolean): void {
        if (flag === this.style().styleB(Sid.concertPitch)) {
            return
        }

        this.undoChangeStyleVal(Sid.concertPitch, flag) // change style flag

        for (const staff of this.m_staves) {
            if (staff.staffType(new Fraction(0, 1)).group() === StaffGroup.PERCUSSION) { // TODO
                continue
            }
            // if this staff has no transposition, and no instrument changes, we can skip it
            let interval = staff.part().instrument().transpose().clone() //tick?
            if (interval.isZero() && staff.part().instruments().size() === 1) {
                continue
            }
            if (!flag) {
                interval.flip()
            }

            const staffIdx = staff.idx()
            const startTrack = staffIdx * VOICES
            const endTrack = startTrack + VOICES

            Transpose.transposeKeys(this, staffIdx, staffIdx + 1, new Fraction(0, 1), this.lastSegment()!.tick(), !flag)

            for (let segment = this.firstSegment(SegmentType.ChordRest); segment; segment = segment.next1(SegmentType.ChordRest)) {
                interval = staff.transpose(segment.tick()).clone()
                if (!flag) {
                    interval.flip()
                }
                for (const e of segment.annotations()) {
                    if (!e.isHarmony() || (e.track() < startTrack) || (e.track() >= endTrack)) {
                        continue
                    }
                    const h = e as unknown as Harmony
                    for (const se of h.linkList()) {
                        // don't transpose all links
                        // just ones resulting from mmrests
                        const he = se as Harmony
                        if (he.staff() === h.staff()) {
                            Transpose.undoTransposeHarmony(this, he, interval)
                        }
                    }
                }
            }
        }
    }

    sortStaves(dst: readonly staff_idx_t[]): void {
        this.sortSystemObjects(dst)
        for (const s of this.m_systems) {
            s.destroy() // C++ muse::DeleteAll(systems())
        }
        this.m_systems.length = 0 //??
        this.m_parts.length = 0
        let curPart: Part | null = null
        const dl: Staff[] = []
        for (const idx of dst) {
            const staff = this.m_staves[idx]
            if (staff.part() !== curPart) {
                curPart = staff.part()
                curPart.clearStaves()
                this.m_parts.push(curPart)
            }
            curPart.appendStaff(staff)
            dl.push(staff)
        }
        this.m_staves = dl

        for (let m = this.firstMeasure(); m; m = m.nextMeasure()) {
            m.sortStaves(dst)
            if (m.hasMMRest()) {
                m.mmRest()!.sortStaves(dst)
            }
        }
        for (const sp of this.m_spanner.all()) {
            const voice = sp.voice()
            const staffIdx = sp.staffIdx()
            const idx = dst.indexOf(staffIdx)
            if (idx !== -1 && !sp.isTopSystemObject()) {
                sp.setTrack(idx * VOICES + voice)
                if (sp.track2() !== nidx) {
                    sp.setTrack2(idx * VOICES + (sp.track2() % VOICES)) // at least keep the voice...
                }
            }
        }
        this.setLayoutAll()
        markInstrumentsAsPrimary(this.m_parts)
    }

    /** staves which are not linked to another staff (of this score) */
    uniqueStaves(): staff_idx_t[] {
        const sl: staff_idx_t[] = []

        for (let staffIdx = 0; staffIdx < this.nstaves(); ++staffIdx) {
            const s = this.staff(staffIdx)!
            const links = s.links()
            if (links) {
                let alreadyInList = false
                for (const idx of sl) {
                    if (links.includes(this.staff(idx)!)) {
                        alreadyInList = true
                        break
                    }
                }
                if (alreadyInList) {
                    continue
                }
            }
            sl.push(staffIdx)
        }
        return sl
    }

    isSpannerStartEnd(tick: Fraction, track: track_idx_t): boolean {
        for (const s of this.m_spanner.all()) {
            if (s.track() !== track) {
                continue
            }
            if (s.tick().eq(tick) || s.tick2().eq(tick)) {
                return true
            }
        }
        return false
    }

    insertTime(tick: Fraction, len: Fraction): void {
        for (const staff of this.staves()) {
            staff.insertTime(tick, len)
        }
        for (const part of this.parts()) {
            part.insertTime(tick, len)
        }
        // TODO(port): automation (playback)
    }

    /** the key list of the first pitched staff (intersection with the other staves), normalized to concert pitch */
    keyList(): KeyList {
        // find the keylist of the first pitched staff
        let tmpKeymap = new KeyList()
        let firstStaff: Staff | null = null
        let isFirstStaff = true
        for (const s of this.masterScore().staves()) {
            if (!s.isDrumStaff(new Fraction(0, 1))) {
                const km = s.keyList()
                if (isFirstStaff) {
                    isFirstStaff = false
                    for (const [k, v] of km.entries()) {
                        tmpKeymap.set(k, v)
                    }
                    firstStaff = s
                    continue
                }

                // in terms of ticks, tmpKeymap = intersection(tmpKeymap, km)
                // note that if every single staff has a custom local keysig on this tick,
                // we will just copy the one from the top staff.
                const kl = new KeyList()
                for (const [k, v] of tmpKeymap.entries()) {
                    if (km.has(k)) {
                        kl.set(k, v)
                    }
                }
                tmpKeymap = kl
            }
        }
        let normalizedC = Key.C
        const needNormalize = !!firstStaff && !this.masterScore().style().styleB(Sid.concertPitch)
            && (firstStaff.part().instrument().transpose().chromatic !== 0 || firstStaff.part().instruments().size() > 1)
        // normalize the keyevents to concert pitch if necessary
        const nkl = new KeyList()
        for (const [k, v] of tmpKeymap.entries()) {
            if (firstStaff && !v.forInstrumentChange()) {
                const key = v.clone()
                if (needNormalize) {
                    key.setKey(key.concertKey())
                }
                nkl.set(k, key)
            }
        }
        if (needNormalize) {
            const interval = firstStaff!.part().instrument().transpose().chromatic
            normalizedC = Transpose.transposeKey(normalizedC, Interval.fromChromatic(interval))
        }

        // create initial keyevent for transposing instrument if necessary
        if (nkl.empty() || nkl.keyAt(0) !== 0) {
            const ke = nkl.get(0) ?? new KeySigEvent()
            ke.setConcertKey(normalizedC)
            nkl.set(0, ke)
        }

        return nkl
    }

    scoreOrder(): ScoreOrder {
        const order = this.m_scoreOrder.clone()
        order.customized = !order.isScoreOrderOfScore(this)
        return order
    }

    setScoreOrder(order: ScoreOrder): void { this.m_scoreOrder = order }

    setBracketsAndBarlines(): void {
        this.scoreOrder().setBracketsAndBarlines(this)
    }

    /** C++ Score::updateCapo(): the capo map of the staves from the Capo elements. TODO(port): realized harmonies */
    updateCapo(ignoreNotationUpdate = false): void {
        const fm = this.firstMeasure()
        if (!fm) {
            return
        }

        for (let s = fm.first(SegmentType.ChordRest); s; s = s.next1(SegmentType.ChordRest)) {
            const segmentTick = s.tick()

            for (const e of s.annotations()) {
                if (!e.isCapo()) {
                    continue
                }

                for (const staff of e.staff()!.staffList()) {
                    staff.insertCapoParams(segmentTick, (e as unknown as { params(): CapoParams }).params(), ignoreNotationUpdate)
                }
            }
        }
    }

    /** C++ Score::updateSwing(): the swing maps of the staves from the staff texts with swing settings */
    updateSwing(): void {
        for (const s of this.m_staves) {
            s.clearSwingMap()
        }
        const fm = this.firstMeasure()
        if (!fm) {
            return
        }
        for (let s = fm.first(SegmentType.ChordRest); s; s = s.next1(SegmentType.ChordRest)) {
            for (const e of s.annotations()) {
                if (!e.isStaffTextBase()) {
                    continue
                }
                const st = e as unknown as StaffTextBase
                if (st.xmlText() === '') {
                    continue
                }
                const staff = st.staff()!
                if (!st.swing()) {
                    continue
                }
                const sp = { swingRatio: st.swingParameters().swingRatio, swingUnit: st.swingParameters().swingUnit }
                if (st.systemFlag()) {
                    for (const sta of this.m_staves) {
                        sta.insertIntoSwingMap(s.tick(), sp)
                    }
                } else {
                    staff.insertIntoSwingMap(s.tick(), sp)
                }
            }
        }
    }

    /** C++ Score::updateChannel(): the channel lists of the staves and the subchannels of the notes */
    updateChannel(): void {
        for (const s of this.staves()) {
            for (let i = 0; i < VOICES; ++i) {
                s.clearChannelList(i)
            }
        }
        const fm = this.firstMeasure()
        if (!fm) {
            return
        }
        for (let s = fm.first(SegmentType.ChordRest); s; s = s.next1(SegmentType.ChordRest)) {
            for (const e of s.annotations()) {
                if (e.isInstrumentChange()) {
                    for (const staff of e.part()!.staves()) {
                        for (let voice = 0; voice < VOICES; ++voice) {
                            staff.insertIntoChannelList(voice, s.tick(), 0)
                        }
                    }
                    continue
                }
                if (!e.isStaffTextBase()) {
                    continue
                }
                const st = e as unknown as StaffTextBase
                for (let voice = 0; voice < VOICES; ++voice) {
                    const an = st.channelName(voice)
                    if (an === '') {
                        continue
                    }
                    const staff = this.staff(st.staffIdx())!
                    const a = staff.part().instrument(s.tick()).channelIdx(an)
                    if (a !== -1) {
                        staff.insertIntoChannelList(voice, s.tick(), a)
                    }
                }
            }
        }

        for (const spanner of this.spanner()) {
            if (spanner.isPalmMute()) {
                (spanner as unknown as { setChannel(): void }).setChannel()
            }
            if (spanner.isVolta()) {
                (spanner as unknown as { setChannel(): void }).setChannel()
            }
        }

        for (let s = fm.first(SegmentType.ChordRest); s; s = s.next1(SegmentType.ChordRest)) {
            for (const st of this.staves()) {
                const strack = st.idx() * VOICES
                const etrack = strack + VOICES
                for (let track = strack; track < etrack; ++track) {
                    const e = s.element(track)
                    if (!e) {
                        continue
                    }
                    if (!e.isChord()) {
                        continue
                    }
                    const c = e as unknown as Chord
                    let channel = st.channel(c.tick(), c.voice())
                    const instr = c.part()!.instrument(c.tick())
                    if (channel >= instr.channels().length) {
                        channel = 0
                    }
                    for (const note of c.notes()) {
                        if (note.hidden()) {
                            continue
                        }
                        note.setSubchannel(channel)
                    }
                }
            }
        }
    }

    /**
     * update measure ticks, the tempo map and the time signature map; this is needed after inserting or removing a
     * measure, changing the sigmap or inserting/deleting time.
     */
    setUpTempoMap(): void {
        let tick = new Fraction(0, 1)
        const fm = this.firstMeasure()
        if (!fm) {
            return
        }

        for (const staff of this.m_staves) {
            staff.clearTimeSig()
        }

        if (this.isMaster()) {
            this.tempomap().clear()
            this.sigmap().clear()
            this.sigmap().addSig(0, new SigEvent(fm.ticks(), fm.timesig(), 0))
        }
        const anacrusisMeasures: Measure[] = []

        const tempoPrimo: { value: number | null } = { value: null }

        for (let mb = this.first(); mb; mb = mb.next()) {
            if (!mb.isMeasure()) {
                mb.setTick(tick)
                continue
            }
            const m = mb as Measure
            const mtick = m.tick()
            const diff = tick.minus(mtick)
            const measureTicks = m.ticks()
            m.moveTicks(diff)
            if (m.mmRest()) {
                m.mmRest()!.moveTicks(diff)
            }
            if (m.isAnacrusis()) {
                anacrusisMeasures.push(m)
            }

            this.rebuildTempoAndTimeSigMaps(m, tempoPrimo)

            tick = tick.plus(measureTicks)
        }

        this.m_measures.updateTickIndex()

        if (this.isMaster()) {
            for (const spannerItem of this.spanner()) {
                if (!spannerItem || !spannerItem.isGradualTempoChange() || !spannerItem.playSpanner()) {
                    continue
                }

                const tempoChange = spannerItem as unknown as GradualTempoChange

                const tickPositionFrom = tempoChange.tick().ticks()
                const currentBps = this.tempomap().tempo(tickPositionFrom)
                const newBps = currentBps * tempoChange.tempoChangeFactor()

                const totalTicks = tempoChange.ticks().ticks()
                const stepsCount = Math.max(8, Math.trunc(totalTicks / Constants.DIVISION))
                const tempoCurve = TConv.easingValueCurve(totalTicks, stepsCount, newBps - currentBps, tempoChange.easingMethod())

                for (const [pos, value] of tempoCurve) {
                    const tick2 = tickPositionFrom + pos

                    if (!this.tempomap().has(tick2)) {
                        this.tempomap().setTempo(tick2, roundTempo(currentBps + value))
                    }
                }
            }

            if (this.tempomap().empty()) {
                this.tempomap().setTempo(0, Constants.DEFAULT_TEMPO)
            }
        }

        this.masterScore().updateRepeatListTempo()
        if (anacrusisMeasures.length) {
            this.fixAnacrusisTempo(anacrusisMeasures)
        }
        this.m_needSetUpTempoMap = false
    }

    /** C++ Score::rebuildTempoAndTimeSigMaps: updates the tempo map and the time signature map for a measure */
    rebuildTempoAndTimeSigMaps(measure: Measure, tempoPrimo: { value: number | null } = { value: null }): void {
        if (this.isMaster()) {
            // Reset tempo to set correct time stretch for fermata.
            const startTick = measure.tick()
            this.resetTempoRange(startTick, measure.endTick())

            // Implement section break rest
            for (let mb = measure.prev(); mb && mb.endTick().eq(startTick); mb = mb.prev()) {
                if (mb.pause()) {
                    this.tempomap().setPause(startTick.ticks(), mb.pause())
                }
            }

            // Add pauses from the end of the previous measure (at measure->tick()):
            for (let s = measure.first(); s && s.tick().eq(startTick); s = s.prev1()) {
                if (!s.isBreathType()) {
                    continue
                }
                let length = 0.0
                for (const e of s.elist()) {
                    if (e && e.isBreath()) {
                        length = Math.max(length, (e as unknown as Breath).pause())
                    }
                }
                if (!RealIsNull(length)) {
                    this.tempomap().setPause(startTick.ticks(), length)
                }
            }
        }

        for (let segment = measure.first(); segment; segment = segment.next()) {
            if (segment.isBreathType()) {
                if (!this.isMaster()) {
                    continue
                }
                let length = 0.0
                const tick = segment.tick()
                // find longest pause
                for (let i = 0, n = this.ntracks(); i < n; ++i) {
                    const e = segment.element(i)
                    if (e && e.isBreath()) {
                        length = Math.max(length, (e as unknown as Breath).pause())
                    }
                }
                if (!RealIsNull(length)) {
                    this.tempomap().setPause(tick.ticks(), length)
                }
            } else if (segment.isTimeSigType()) {
                for (let staffIdx = 0; staffIdx < this.m_staves.length; ++staffIdx) {
                    const ts = segment.element(staffIdx * VOICES) as TimeSig | null
                    if (ts) {
                        this.staff(staffIdx)!.addTimeSig(ts)
                    }
                }
            } else if (segment.isChordRestType() || segment.isTimeTickType()) {
                if (!this.isMaster()) {
                    continue
                }
                let stretch = 0.0
                for (const e of segment.annotations()) {
                    if (e.isFermata() && (e as unknown as Fermata).play()) {
                        stretch = Math.max(stretch, (e as unknown as Fermata).timeStretch())
                    } else if (e.isTempoText()) {
                        const tt = e as unknown as TempoText

                        if (!tt.playTempoText()) {
                            continue
                        }

                        if (tt.isNormal() && !tt.isRelative() && tempoPrimo.value === null) {
                            tempoPrimo.value = roundTempo(tt.tempo())
                        } else if (tt.isRelative()) {
                            tt.updateRelative()
                        }

                        const ticks = tt.segment().tick().ticks()
                        if (tt.isATempo() && tt.followText()) {
                            // this will effectively reset the tempo to the previous one
                            // when a progressive change was active
                            this.tempomap().setTempo(ticks, this.tempomap().tempo(ticks))
                        } else if (tt.isTempoPrimo() && tt.followText()) {
                            this.tempomap().setTempo(ticks, tempoPrimo.value !== null ? tempoPrimo.value : Constants.DEFAULT_TEMPO)
                        } else {
                            this.tempomap().setTempo(ticks, roundTempo(tt.tempo()))
                        }
                    }
                }

                if (!RealIsNull(stretch) && !RealIsEqual(stretch, 1.0)) {
                    const otempo = this.tempomap().tempo(segment.tick().ticks())
                    const ntempo = roundTempo(otempo / stretch)
                    this.tempomap().setTempo(segment.tick().ticks(), ntempo)

                    let tempoEndTick: Fraction

                    let nextActiveSegment = segment.next1()
                    while (nextActiveSegment && !nextActiveSegment.isActive()) {
                        nextActiveSegment = nextActiveSegment.next1()
                    }

                    if (nextActiveSegment) {
                        tempoEndTick = nextActiveSegment.tick()
                    } else {
                        tempoEndTick = segment.tick().plus(segment.ticks())
                    }

                    const etick = tempoEndTick.minus(Fraction.eps())
                    if (!this.tempomap().has(etick.ticks())) {
                        this.tempomap().setTempo(etick.ticks(), otempo)
                    }
                }
            }
        }

        // update time signature map
        // create event if measure len and time signature are different
        // even if they are equivalent 4/4 vs 2/2
        // also check if nominal time signature has changed

        if (this.isMaster()) {
            const m = measure
            const mTicks = m.isMMRest() ? m.mmRestFirst()!.ticks() : m.ticks() // for time signature the underlying measure length matters for MM rests

            const pm = measure.prevMeasure()
            // prevMeasure() doesn't return MM rest so we don't handle it here

            if (pm && (!mTicks.identical(pm.ticks()) || !m.timesig().identical(pm.timesig()))) {
                this.sigmap().addSig(m.tick().ticks(), new SigEvent(mTicks, m.timesig(), m.no()))
            }
        }
    }

    fixAnacrusisTempo(measures: Measure[]): void {
        const getTempoTextIfExist = (m: Measure): TempoText | null => {
            for (let s = m.first(); s; s = s.next()) {
                if (s.isChordRestType()) {
                    for (const e of s.annotations()) {
                        if (e.isTempoText() && (e as unknown as TempoText).playTempoText()) {
                            return e as unknown as TempoText
                        }
                    }
                }
            }
            return null
        }

        for (const measure of measures) {
            if (getTempoTextIfExist(measure)) {
                continue
            }
            const nextMeasure = measure.nextMeasure()
            if (nextMeasure) {
                const tt = getTempoTextIfExist(nextMeasure)
                if (tt) {
                    this.tempomap().setTempo(measure.tick().ticks(), roundTempo(tt.tempo()))
                }
            }
        }
    }

    setUpTempoMapLater(): void { this.m_needSetUpTempoMap = true }

    //   setTempo
    //    convenience function to access TempoMap
    setTempo(tick: Fraction, tempo: number): void {
        this.tempomap().setTempo(tick.ticks(), roundTempo(tempo))
        this.masterScore().setPlaylistDirty()
    }

    removeTempo(tick: Fraction): void {
        this.tempomap().delTempo(tick.ticks())
        this.masterScore().setPlaylistDirty()
    }

    resetTempo(): void {
        this.resetTempoRange(new Fraction(0, 1), new Fraction(0x7fffffff, 1))
    }

    /** Reset tempo and timesig maps in the given range. Start tick included, end tick excluded. */
    resetTempoRange(tick1: Fraction, tick2: Fraction): void {
        const zeroInRange = (tick1.le(new Fraction(0, 1)) && tick2.gt(new Fraction(0, 1)))
        this.tempomap().clearRange(tick1.ticks(), tick2.ticks())
        if (zeroInRange) {
            this.tempomap().setTempo(0, Constants.DEFAULT_TEMPO)
        }
        this.sigmap().clearRange(tick1.ticks(), tick2.ticks())
        if (zeroInRange) {
            const m = this.firstMeasure()
            if (m) {
                this.sigmap().addSig(0, new SigEvent(m.ticks(), m.timesig(), 0))
            }
        }
    }

    setPause(tick: Fraction, seconds: number): void {
        this.tempomap().setPause(tick.ticks(), seconds)
        this.masterScore().setPlaylistDirty()
    }

    tempo(tick: Fraction): number {
        return this.tempomap().tempo(tick.ticks())
    }

    multipliedTempo(tick: Fraction): number {
        return this.tempomap().multipliedTempo(tick.ticks())
    }

    autoUpdateSpatium(): void {
        const breathingSpace = 2.5 // allow breathing space between staves
        const minStaffHeight = 2.0 // never make staff smaller than 2.0 mm
        const maxStaffHeight = 7.0 // never make staff bigger than 7.0 mm (default value)

        let availableHeight = (this.style().styleD(Sid.pageHeight)
                               - this.style().styleD(Sid.pageOddTopMargin)
                               - this.style().styleD(Sid.pageOddBottomMargin)) * DPI // convert from inches to DPI
        const titleHeight = (!this.measures().empty() && this.measures().first()!.isVBox()) ? this.measures().first()!.height() : 0.0
        availableHeight -= titleHeight
        const totalNeededSpaces = 4 * this.m_staves.length * breathingSpace
        let targetSpatium = availableHeight / totalNeededSpaces

        let resultingStaffHeight = 4 * targetSpatium / DPI * INCH // conversion from DPI to mm
        resultingStaffHeight = Math.round(resultingStaffHeight * 10) / 10 // round to nearest 0.1 mm
        if (resultingStaffHeight > maxStaffHeight) {
            return
        }
        if (resultingStaffHeight < minStaffHeight) {
            resultingStaffHeight = minStaffHeight
        }

        targetSpatium = (resultingStaffHeight / 4) * DPI / INCH

        this.style().setSpatium(targetSpatium)
        this.styleChanged() // C++ createPaddingTable(); the padding table is computed by the layout here
    }

    appendStaff(staff: Staff): void {
        this.assignIdIfNeed(staff)
        staff.part().appendStaff(staff)
        this.m_staves.push(staff)
    }

    allStavesInvisible(): boolean {
        return !this.m_staves.some(s => s.show())
    }

    visibleStavesCount(): number {
        return this.m_staves.filter(s => s.show()).length
    }

    systemObjectStaves(): Staff[] { return this.m_systemObjectStaves }
    systemObjectStavesWithTopStaff(): Staff[] {
        const result: Staff[] = []
        const topStaff = this.staff(0)
        if (topStaff) {
            result.push(topStaff)
        }
        return [...result, ...this.m_systemObjectStaves]
    }
    clearSystemObjectStaves(): void { this.m_systemObjectStaves = [] }
    addSystemObjectStaff(staff: Staff): void {
        if (!this.m_systemObjectStaves.includes(staff)) {
            this.m_systemObjectStaves.push(staff)
        }
    }
    removeSystemObjectStaff(staff: Staff): void {
        const i = this.m_systemObjectStaves.indexOf(staff)
        if (i >= 0) {
            this.m_systemObjectStaves.splice(i, 1)
        }
    }

    // measures

    measures(): MeasureBaseList { return this.m_measures }
    first(): MeasureBase | null { return this.m_measures.first() }
    last(): MeasureBase | null { return this.m_measures.last() }

    /** C++ Score::findFretBox() (edit.cpp) */
    findFretBox(): FBox | null {
        for (let measure = this.first(); measure; measure = measure.next()) {
            if (measure.isFBox()) {
                return measure as unknown as FBox
            }
        }

        return null
    }

    /** C++ Score::rebuildFretBox() (edit.cpp) */
    rebuildFretBox(): void {
        const fretBox = this.findFretBox()
        if (!fretBox) {
            return
        }

        fretBox.setNeedsRebuild(true)
        fretBox.triggerLayout()
    }

    firstMeasure(): Measure | null {
        let mb = this.m_measures.first()
        while (mb && !mb.isMeasure()) {
            mb = mb.next()
        }
        return mb as unknown as Measure | null
    }

    firstMeasureMM(): Measure | null {
        const m = this.firstMeasure()
        if (m && this.style().styleB(Sid.createMultiMeasureRests) && m.hasMMRest()) {
            return m.mmRest()
        }
        return m
    }

    /** C++ dummy()->system(): parent for newly created elements */
    dummySystem(): System { return scoreDummyHooks.system!(this) }

    chordList(): ChordList { return this.m_chordList }

    /** the user offsets etc. of all elements follow a new spatium (C++ Score::spatiumChanged) */
    spatiumChanged(oldValue: number, newValue: number): void {
        this.scanElements(e => e.spatiumChanged(oldValue, newValue))
        // C++: m_layoutOptions.noteHeadWidth = ...; createPaddingTable() (the padding table is computed by the layout)
        this.setNoteHeadWidth(null)
    }

    /** C++ Score::checkChordList() (dom/utils.cpp) */
    checkChordList(): void {
        this.m_chordList.checkChordList(this.style())
    }

    firstSegment(segType: SegmentType): Segment | null {
        const m = this.firstMeasure()
        if (!m) {
            return null
        }
        let seg = m.first()
        if (seg && !(seg.segmentType() & segType)) {
            seg = seg.next1(segType)
        }
        return seg
    }

    lastSegment(): Segment | null {
        const m = this.lastMeasure()
        return m ? m.last() : null
    }

    measure(idx: number): MeasureBase | null {
        let mb = this.m_measures.first()
        for (let i = 0; i < idx; ++i) {
            mb = mb!.next()
            if (!mb) {
                return null
            }
        }
        return mb
    }

    crMeasure(idx: number): Measure | null {
        let i = -1
        for (let mb = this.m_measures.first(); mb; mb = mb.next()) {
            if (mb.isMeasure()) {
                ++i
                if (i === idx) {
                    return mb as unknown as Measure
                }
            }
        }
        return null
    }

    lastMeasure(): Measure | null {
        let mb = this.m_measures.last()
        while (mb && !mb.isMeasure()) {
            mb = mb.prev()
        }
        return mb as unknown as Measure | null
    }

    lastMeasureMM(): Measure | null {
        const m = this.lastMeasure()
        return m ? m.coveringMMRestOrThis() : null
    }

    endTick(): Fraction {
        const m = this.lastMeasure()
        return m ? m.endTick() : new Fraction(0, 1)
    }

    addMeasure(m: MeasureBase, pos: MeasureBase | null): void {
        m.setNext(pos)
        this.m_measures.add(m)
    }

    /** return Measure for tick; create measures (with the time signature of the sigmap) if there is no measure for this tick */
    getCreateMeasure(tick: Fraction): Measure {
        const last = this.lastMeasure()
        if (!last || last.endTick().le(tick)) {
            let lastTick = last ? last.endTick() : new Fraction(0, 1)
            while (tick.ge(lastTick)) {
                const m = itemFactories.createItem!(ElementType.MEASURE, this.dummySystem()) as Measure // Factory::createMeasure
                const ts = this.sigmap().timesig(lastTick).timesig()
                m.setTick(lastTick)
                m.setTimesig(ts)
                m.setTicks(ts)
                this.measures().append(m)
                lastTick = lastTick.plus(m.ticks())
            }
        }
        return this.tick2measure(tick)!
    }

    tick2measure(tick: Fraction): Measure | null {
        if (tick.eq(new Fraction(-1, 1))) { // special number
            return this.lastMeasure()
        }
        if (tick.le(new Fraction(0, 1))) {
            return this.firstMeasure()
        }
        return this.m_measures.measureByTick(tick.ticks())
    }

    tick2measureMM(t: Fraction): Measure | null {
        if (t.eq(new Fraction(-1, 1))) {
            return this.lastMeasureMM()
        }
        const measure = this.m_measures.measureByTick(t.ticks())
        if (!measure) {
            return null
        }
        return measure.coveringMMRestOrThis()
    }

    tick2measureBase(tick: Fraction): MeasureBase | null {
        for (const mb of this.m_measures.measureBasesAtTick(tick.ticks())) {
            const st = mb.tick()
            const l = mb.ticks()
            if (tick.ge(st) && tick.lt(st.plus(l))) {
                return mb
            }
        }
        return null
    }

    tick2segment(t: Fraction, first = false, st: SegmentType = SegmentType.All, useMMrest = false): Segment | null {
        let tick = t
        let m: Measure | null
        if (useMMrest) {
            m = this.tick2measureMM(tick)
            if (m && m.isMMRest() && !tick.eq(m.endTick())) {
                tick = m.tick()
            }
        } else {
            m = this.tick2measure(tick)
        }
        if (!m) {
            return null
        }
        for (let segment = m.first(st); segment;) {
            const t1 = segment.tick()
            const nsegment = segment.next(st)
            if (tick.eq(t1)) {
                if (first) {
                    return segment
                } else if (!nsegment || tick.lt(nsegment.tick())) {
                    return segment
                }
            }
            segment = nsegment
        }
        return null
    }

    findCR(t: Fraction, track: track_idx_t): ChordRest | null {
        let tick = t
        const m = this.tick2measureMM(tick)
        if (!m) {
            return null
        }
        // attach to first rest all spanner when mmRest
        if (m.isMMRest()) {
            tick = m.tick()
        }
        let s = m.first(SegmentType.ChordRest)
        for (let ns = s; ; ns = ns.next(SegmentType.ChordRest)) {
            if (!ns || ns.tick().gt(tick)) {
                break
            }
            const el = ns.element(track)
            if (el && el.isRest() && (el as unknown as { isGap(): boolean }).isGap()) {
                continue
            } else if (el) {
                s = ns
            }
        }
        if (!s) {
            return null
        }
        const el = s.element(track)
        if (el && el.isRest() && (el as unknown as { isGap(): boolean }).isGap()) {
            return null
        }
        return el as unknown as ChordRest | null
    }

    tick2segmentMM(tick: Fraction, first = false, st: SegmentType = SegmentType.All): Segment | null {
        return this.tick2segment(tick, first, st, true)
    }

    tick2leftSegment(tick: Fraction, useMMrest = false, segType: SegmentType = SegmentType.ChordRest): Segment | null {
        const m = useMMrest ? this.tick2measureMM(tick) : this.tick2measure(tick)
        if (!m) {
            return null
        }
        let ps: Segment | null = null
        for (let s = m.first(segType); s; s = s.next(segType)) {
            if (tick.lt(s.tick())) {
                return ps
            } else if (tick.eq(s.tick())) {
                return s
            }
            ps = s
        }
        return ps
    }

    tick2rightSegment(tick: Fraction, useMMrest = false, segType: SegmentType = SegmentType.ChordRest): Segment | null {
        const m = useMMrest ? this.tick2measureMM(tick) : this.tick2measure(tick)
        if (!m) {
            return null
        }
        for (let s = m.first(segType); s; s = s.next1(segType)) {
            if (tick.le(s.tick())) {
                return s
            }
        }
        return null
    }

    tick2beatType(tick: Fraction): BeatType {
        const m = this.tick2measure(tick)!
        const msrTick = m.tick()
        const timeSig: TimeSigFrac = this.sigmap().timesig(msrTick).nominal()
        let rtick = tick.minus(msrTick).ticks()
        if (m.isAnacrusis()) { // measure is incomplete (anacrusis)
            rtick += timeSig.ticksPerMeasure() - m.ticks().ticks()
        }
        return timeSig.rtick2beatType(rtick)
    }

    // systems & pages

    systems(): System[] { return this.m_systems }
    setSystems(s: System[]): void { this.m_systems = s }
    pages(): Page[] { return this.m_pages }
    setPages(p: Page[]): void { this.m_pages = p }
    npages(): number { return this.m_pages.length }
    pageIdx(page: Page): number { return this.m_pages.indexOf(page) }

    // spanners

    spannerMap(): SpannerMap { return this.m_spanner }
    spanner(): readonly Spanner[] { return this.m_spanner.all() }
    unmanagedSpanners(): Set<Spanner> { return this.m_unmanagedSpanners }

    addSpanner(s: Spanner, computeStartEnd = true): void {
        this.m_spanner.addSpanner(s)
        s.added()
        if (computeStartEnd) {
            s.computeStartElement()
            s.computeEndElement()
        }
    }

    removeSpanner(s: Spanner): void {
        this.m_spanner.removeSpanner(s)
        s.removed()

        const startElement = s.startElement()
        const startChord = startElement && startElement.isChord() ? startElement as unknown as Chord : null
        if (startChord) {
            startChord.removeStartingSpanner(s)
        }

        const endElement = s.endElement()
        const endChord = endElement && endElement.isChord() ? endElement as unknown as Chord : null
        if (endChord) {
            endChord.removeEndingSpanner(s)
        }
    }

    // ---------------------------------------------------------
    //   checkSpanner
    //    check for spanners that are not attached to anything (C++: editing/edit.cpp)
    // ---------------------------------------------------------

    checkSpanner(_startTick: Fraction, _endTick: Fraction, removeOrphans = true): void {
        const spannersToRemove: Spanner[] = []
        const spannersToShorten: Spanner[] = []
        const lastTick = this.lastMeasure()!.endTick()

        for (const s of [...this.m_spanner.all()]) {
            if (s.isSlur()) {
                let seg = this.tick2segmentMM(s.tick(), false, SegmentType.ChordRest)
                if (!seg || !seg.element(s.track())) {
                    spannersToRemove.push(s)
                } else {
                    seg = this.tick2segmentMM(s.tick2(), false, SegmentType.ChordRest)
                    if (!seg || !seg.element(s.track2())) {
                        spannersToRemove.push(s)
                    }
                }
            } else {
                // remove spanner if there is no start element
                s.computeStartElement()
                if (!s.startElement()) {
                    spannersToRemove.push(s)
                } else if (s.tick2().gt(lastTick)) {
                    spannersToShorten.push(s)
                } else {
                    s.computeEndElement()
                }
            }
        }
        if (removeOrphans) {
            for (const s of spannersToRemove) {
                this.removeSpanner(s)
            }
        }
        for (const s of spannersToShorten) { // shorten spanners that extended past end of score
            s.setTicks(lastTick.minus(s.tick()))
            s.computeEndElement()
        }
    }

    // ---------------------------------------------------------
    //   connectTies
    //    Rebuild tie connections.
    // ---------------------------------------------------------

    connectTies(silent = false): void {
        const tracks = this.nstaves() * VOICES
        const m = this.firstMeasure()
        if (!m) {
            return
        }
        const connectTiesForChord = (c: Chord): void => {
            for (const n of c.notes()) {
                // connect a tie without end note
                if (n.laissezVib()) {
                    continue
                }
                const tie = n.tieFor()
                // TODO(port): tie->updatePossibleJumpPoints()
                if (tie && !tie.isPartialTie() && !tie.endNote()) {
                    const nnote = searchTieNote(n)
                    if (!nnote) {
                        if (!silent) {
                            n.setTieFor(null)
                        }
                    } else {
                        tie.setEndNote(nnote)
                        nnote.setTieBack(tie)
                    }
                }
                // TODO(port): connect a glissando without initial note (old files)
                // spanner with no end element can happen during copy/paste
                for (const spanner of [...n.spannerFor()]) {
                    if (!spanner.endElement()) {
                        n.removeSpannerFor(spanner)
                    }
                }
            }
        }

        const st = SegmentType.ChordRest
        for (let s = m.first(st); s; s = s.next1(st)) {
            for (let track = 0; track < tracks; ++track) {
                const e = s.element(track)
                if (!e || !e.isChord()) {
                    continue
                }
                const c = e as unknown as Chord
                connectTiesForChord(c)
                for (const gc of c.graceNotes()) {
                    connectTiesForChord(gc)
                }
            }
        }
    }

    addUnmanagedSpanner(s: Spanner): void { this.m_unmanagedSpanners.add(s) }
    removeUnmanagedSpanner(s: Spanner): void { this.m_unmanagedSpanners.delete(s) }

    // other

    /** find last chord/rest on staff that ends before tick */
    findChordRestEndingBeforeTickInStaff(tick: Fraction, staffIdx: staff_idx_t): ChordRest | null {
        return this.findChordRestEndingBeforeTickInStaffAndVoice(tick, staffIdx, false, 0)
    }

    findChordRestEndingBeforeTickInTrack(tick: Fraction, trackIdx: track_idx_t): ChordRest | null {
        const m = this.tick2measureMM(tick.minus(Fraction.eps()))
        if (!m) {
            return null
        }
        for (let s = m.last(SegmentType.ChordRest); s; s = s.prev(SegmentType.ChordRest)) {
            const cr = s.element(trackIdx) as ChordRest | null
            if (cr && cr.endTick().le(tick)) {
                return cr
            }
        }
        return null
    }

    /** find last chord/rest on staff and voice that ends before tick (optionally in any voice) */
    findChordRestEndingBeforeTickInStaffAndVoice(tick: Fraction, staffIdx: staff_idx_t, forceVoice: boolean, voice: number): ChordRest | null {
        let ptick = tick.minus(Fraction.eps())
        const m = this.tick2measureMM(ptick)
        if (!m) {
            return null
        }
        // attach to first rest all spanner when mmRest
        if (m.isMMRest()) {
            ptick = m.tick()
        }
        let s = m.first(SegmentType.ChordRest)
        const strack = forceVoice ? staffIdx * VOICES + voice : staffIdx * VOICES
        const etrack = forceVoice ? strack + 1 : strack + VOICES
        let actualTrack = strack
        let lastTick = new Fraction(-1, 1)
        for (let ns = s; ; ns = ns.next(SegmentType.ChordRest)) {
            if (!ns || ns.tick().gt(ptick)) {
                break
            }
            // found a segment; now find longest cr on this staff that does not overlap tick
            for (let t = strack; t < etrack; ++t) {
                const cr = ns.element(t) as ChordRest | null
                if (cr && (!forceVoice || voice === cr.voice())) {
                    const endTick = cr.endTick()
                    if (endTick.ge(lastTick) && endTick.le(tick)) {
                        s = ns
                        actualTrack = t
                        lastTick = endTick
                    }
                }
            }
        }
        return s ? s.element(actualTrack) as ChordRest | null : null
    }

    systemLocks(): SystemLocks { return this.m_systemLocks }

    systemDividers(): ReadonlyMap<number, [SystemDivider | null, SystemDivider | null]> { return this.m_systemDividers }

    systemDivider(systemIdx: number, type: SystemDividerType): SystemDivider | null {
        const d = this.m_systemDividers.get(systemIdx)
        return d ? d[type] : null
    }

    addSystemDivider(systemIdx: number, divider: SystemDivider): void {
        if (!this.m_systemDividers.has(systemIdx)) {
            this.m_systemDividers.set(systemIdx, [null, null])
        }

        this.m_systemDividers.get(systemIdx)![divider.dividerType()] = divider
    }
    addSystemLock(lock: SystemLock): void { this.m_systemLocks.add(lock) }
    eidRegister(): EIDRegister { return this.masterScore().m_eidRegister }

    sigmap(): TimeSigMap { return this.masterScore().sigmap() }
    tempomap(): TempoMap { return this.masterScore().tempomap() }

    loopInTick(): Fraction { return this.loopBoundaryTick(LoopBoundaryType.LoopIn) }
    loopOutTick(): Fraction { return this.loopBoundaryTick(LoopBoundaryType.LoopOut) }
    setLoopInTick(tick: Fraction): void { this.setLoopBoundaryTick(LoopBoundaryType.LoopIn, tick) }
    setLoopOutTick(tick: Fraction): void { this.setLoopBoundaryTick(LoopBoundaryType.LoopOut, tick) }
    loopBoundaryTick(type: LoopBoundaryType): Fraction { return this.masterScore().loopBoundaryTick(type) }
    setLoopBoundaryTick(type: LoopBoundaryType, tick: Fraction): void { this.masterScore().setLoopBoundaryTick(type, tick) }
    repeatList(expandRepeats?: boolean, updateTies = true): RepeatList {
        const ms = this.masterScore()
        return ms.repeatList(expandRepeats ?? ms.expandRepeats(), updateTies)
    }

    getText(tid: TextStyleType): Text | null {
        const m = this.first()
        if (m && m.isVBox()) {
            for (const e of m.el()) {
                if (e.isText() && (e as Text).textStyleType() === tid) {
                    return e as Text
                }
            }
        }
        return null
    }

    override scanElements(func: (item: EngravingItem) => void): void {
        for (let mb = this.first(); mb; mb = mb.next()) {
            mb.scanElements(func)
            if (mb.isMeasure()) {
                const mmr = (mb as Measure).mmRest()
                if (mmr) {
                    mmr.scanElements(func)
                }
            }
        }
        for (const page of this.m_pages) {
            for (const s of page.systems()) {
                s.scanElements(func)
            }
            func(page)
        }
    }

    override getProperty(_pid: Pid): PropertyValue { return undefined }
    override setProperty(_pid: Pid, _v: PropertyValue): boolean { return false }

    addElement(element: EngravingItem): void {
        const parent = element.parentItem()
        element.triggerLayout()
        const et = element.type()
        if (et === ElementType.MEASURE
            || (et === ElementType.HBOX && !(parent && parent.isVBox()))
            || et === ElementType.VBOX
            || et === ElementType.TBOX
            || et === ElementType.FBOX) {
            this.measures().add(element as unknown as MeasureBase)
            return
        }
        if (parent) {
            parent.add(element)
        }
        switch (et) {
        case ElementType.BEAM: {
            const b = element as unknown as { elements(): ChordRest[] }
            for (const cr of b.elements()) {
                cr.setBeam(element as never)
            }
            break
        }
        case ElementType.SLUR:
        case ElementType.HAMMER_ON_PULL_OFF:
        case ElementType.VOLTA:
        case ElementType.TRILL:
        case ElementType.VIBRATO:
        case ElementType.PEDAL:
        case ElementType.TEXTLINE:
        case ElementType.HAIRPIN:
        case ElementType.LET_RING:
        case ElementType.GRADUAL_TEMPO_CHANGE:
        case ElementType.PALM_MUTE:
        case ElementType.WHAMMY_BAR:
        case ElementType.RASGUEADO:
        case ElementType.HARMONIC_MARK:
        case ElementType.PICK_SCRAPE:
        case ElementType.PARTIAL_LYRICSLINE:
        case ElementType.OTTAVA: {
            const spanner = element as unknown as Spanner
            if (et === ElementType.TEXTLINE && spanner.anchor() === 3 /* Spanner::Anchor::NOTE */) {
                break
            }
            this.addSpanner(spanner)
            for (const ss of spanner.spannerSegments()) {
                if (ss.system()) {
                    ss.system()!.add(ss)
                }
            }
            if (et === ElementType.OTTAVA) {
                spanner.staff()?.updateOttava()
            }
            break
        }
        case ElementType.CHORD: {
            const tick = element.tick()
            for (const s of this.m_spanner.findOverlapping(tick.ticks(), tick.ticks())) {
                if (s.track() !== element.track() || !s.isSlur()) {
                    continue
                }
                if (!s.startElement() && s.tick().eq(tick)) {
                    s.setStartElement(element)
                }
                if (!s.endElement() && s.tick2().eq(tick)) {
                    s.setEndElement(element)
                }
            }
            break
        }
        case ElementType.HARMONY:
        case ElementType.FRET_DIAGRAM:
            if (element.part()) {
                element.part()!.updateHarmonyChannels(true)
            }
            break
        default:
            break
        }
    }

    removeElement(element: EngravingItem): void {
        let parent = element.parentItem()
        element.triggerLayout()
        const et = element.type()
        const parentIsVBox = !!parent && parent.isVBox()
        if (et === ElementType.MEASURE
            || (et === ElementType.HBOX && !parentIsVBox)
            || et === ElementType.VBOX
            || et === ElementType.TBOX
            || et === ElementType.FBOX) {
            // TODO(port): remove measure from its system/page
            this.measures().remove(element as unknown as MeasureBase)
            return
        }
        if (et === ElementType.BEAM) { // beam parent does not survive layout
            element.resetExplicitParent()
            parent = null
        }
        if (parent) {
            parent.remove(element)
        }
        switch (et) {
        case ElementType.BEAM:
            for (const cr of (element as unknown as { elements(): ChordRest[] }).elements()) {
                cr.setBeam(null)
            }
            break
        case ElementType.SLUR:
        case ElementType.HAMMER_ON_PULL_OFF:
        case ElementType.VOLTA:
        case ElementType.TRILL:
        case ElementType.VIBRATO:
        case ElementType.PEDAL:
        case ElementType.LET_RING:
        case ElementType.GRADUAL_TEMPO_CHANGE:
        case ElementType.PALM_MUTE:
        case ElementType.WHAMMY_BAR:
        case ElementType.RASGUEADO:
        case ElementType.HARMONIC_MARK:
        case ElementType.PICK_SCRAPE:
        case ElementType.TEXTLINE:
        case ElementType.HAIRPIN:
        case ElementType.PARTIAL_LYRICSLINE: {
            const spanner = element as unknown as Spanner
            if (et === ElementType.TEXTLINE && spanner.anchor() === 3 /* Spanner::Anchor::NOTE */) {
                break
            }
            // the segments stay in their systems (like C++) until these are laid out again
            spanner.triggerLayout()
            this.removeSpanner(spanner)
            break
        }
        case ElementType.OTTAVA: {
            const o = element as unknown as Spanner
            o.triggerLayout()
            this.removeSpanner(o)
            o.staff()?.updateOttava()
            break
        }
        case ElementType.CHORD:
        case ElementType.REST:
        case ElementType.MMREST: {
            const cr = element as unknown as ChordRest
            if (cr.beam()) {
                cr.beam()!.remove(cr)
            }
            for (const lyr of cr.lyrics()) {
                lyr.removeFromScore()
            }
            // TODO: check for tuplet?
            break
        }
        case ElementType.HARMONY:
        case ElementType.FRET_DIAGRAM:
            if (element.part()) {
                element.part()!.updateHarmonyChannels(true, true)
            }
            break
        default:
            break
        }
    }
}

function findElementStartSegment(score: Score, e: EngravingItem): Segment | null {
    const ancestor = e.findAncestor(ElementType.SEGMENT) as Segment | null
    if (ancestor) {
        if (ancestor.isSegType(CHORD_REST_OR_TIME_TICK_TYPE)) {
            return ancestor
        }
    }

    return score.tick2segmentMM(e.tick(), true, CHORD_REST_OR_TIME_TICK_TYPE)
}

/**
 * Returns `null` when the end segment is the end of the score; returns `def` if no end segment is found.
 */
function findElementEndSegment(score: Score, e: EngravingItem, def: Segment | null): Segment | null {
    let cr: ChordRest | null = null

    if (e.isNote()) {
        cr = e.parentItem() as unknown as ChordRest
    } else if (e.isChordRest()) {
        cr = e as unknown as ChordRest
    } else {
        const c = e.findAncestor(ElementType.CHORD)
        if (c) {
            cr = c as unknown as ChordRest
        } else {
            const r = e.findAncestor(ElementType.REST)
            if (r) {
                cr = r as unknown as ChordRest
            }
        }
    }

    if (cr) {
        return cr.nextSegmentAfterCR(SegmentType.ChordRest | SegmentType.EndBarLine | SegmentType.Clef)
    }

    if (e.isSpanner() || e.isSpannerSegment()) {
        const sp = e.isSpanner() ? e as unknown as Spanner : (e as unknown as SpannerSegment).spanner()!
        return score.tick2segmentMM(sp.tick2(), true, CHORD_REST_OR_TIME_TICK_TYPE)
    }

    const seg = e.findAncestor(ElementType.SEGMENT) as Segment | null
    if (seg) {
        if (seg.isSegType(CHORD_REST_OR_TIME_TICK_TYPE)) {
            // https://github.com/musescore/MuseScore/pull/25821#issuecomment-2617369881
            return seg.nextCR(e.track(), true)
        } else {
            // Strictly speaking redundant, but more efficient than `tick2segmentMM`
            const crSegAtSameTick = seg.measure().findSegmentR(CHORD_REST_OR_TIME_TICK_TYPE, seg.rtick())
            if (crSegAtSameTick) {
                return crSegAtSameTick
            }
        }
    }

    const tick = e.tick()
    if (tick.eq(score.endTick())) {
        return null
    }

    const seg2 = score.tick2segmentMM(tick, true, CHORD_REST_OR_TIME_TICK_TYPE)
    if (seg2) {
        return seg2
    }

    return def
}
