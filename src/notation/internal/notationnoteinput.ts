/*
 * SPDX-License-Identifier: GPL-3.0-only
 * MuseEncore — port of MuseScore Studio (https://github.com/musescore/MuseScore)
 * Copyright (C) 2021-2026 MuseScore Limited and others
 *
 * Port of src/notation/internal/notationnoteinput.h/.cpp
 *
 * TODO(port): accessibility announcements, the view rectangle for the start position (setGetViewRectFunc is kept),
 * the canvas orientation of cursorRect (the port's pages are always laid out like
 * MuseScore's horizontal page view: the page position is added).
 */

import { NotationConfiguration } from './notationconfiguration'
import { PointF, RectF } from '../../framework/draw/types/geometry'
import { TranslatableString } from '../../framework/global/types/translatablestring'
import { Fraction } from '../../engraving/types/fraction'
import { DurationType, ElementType, StaffGroup, VOICES, nidx, track2staff, trackZeroVoice, type track_idx_t, type voice_idx_t } from '../../engraving/types/types'
import { Sid } from '../../engraving/style/styledef'
import { SelectType } from '../../engraving/dom/select'
import { SegmentType, type Segment } from '../../engraving/dom/segment'
import { TDuration } from '../../engraving/dom/durationtype'
import { NoteEntryMethod, NoteVal, type InputState } from '../../engraving/dom/input'
import { AccidentalType } from '../../engraving/dom/accidentaldata'
import { UpDownMode } from '../../engraving/dom/mscore'
import { Position, type NoteInputParams, type Pad, type Score } from '../../engraving/dom/score'
import { PITCH_DELTA_OCTAVE, clampPitch } from '../../engraving/dom/pitchspelling'
import { noteValToLine, relStep } from '../../engraving/dom/utils'
import '../../engraving/editing/cmd'
import '../../engraving/editing/edit'
import '../../engraving/dom/noteentry'
import { NoteAddingMode, type TupletOptions } from '../notationtypes'
import { Tuplet } from '../../engraving/dom/tuplet'
import { ArticulationsUpdateMode, updateArticulationIds } from '../../engraving/dom/articulation'
import { Notification, type NotationUndoStack } from './notationundostack'
import type { EngravingItem } from '../../engraving/dom/engravingitem'
import type { ChordRest } from '../../engraving/dom/chordrest'
import type { Chord } from '../../engraving/dom/chord'
import type { Note } from '../../engraving/dom/note'
import type { Rest } from '../../engraving/dom/rest'
import type { Staff } from '../../engraving/dom/staff'
import { StringData } from '../../engraving/dom/stringdata'
import type { Page } from '../../engraving/dom/page'
import type { Slur } from '../../engraving/dom/slur'
import type { SymId } from '../../engraving/types/symid'
import type { NotationInteraction } from './notationinteraction'

export { NoteEntryMethod as NoteInputMethod }

export function nameOfNoteInputMethod(method: NoteEntryMethod): TranslatableString {
    switch (method) {
    case NoteEntryMethod.UNKNOWN: break
    case NoteEntryMethod.BY_NOTE_NAME: return new TranslatableString('noteInputMethod', 'Input by note name mode')
    case NoteEntryMethod.BY_DURATION: return new TranslatableString('noteInputMethod', 'Input by duration mode')
    case NoteEntryMethod.REPITCH: return new TranslatableString('noteInputMethod', 'Re-pitch existing notes mode')
    case NoteEntryMethod.RHYTHM: return new TranslatableString('noteInputMethod', 'Rhythm-only input mode')
    case NoteEntryMethod.REALTIME_AUTO: return new TranslatableString('noteInputMethod', 'Metronome real-time input mode')
    case NoteEntryMethod.REALTIME_MANUAL: return new TranslatableString('noteInputMethod', 'Pedal real-time input mode')
    case NoteEntryMethod.TIMEWISE: return new TranslatableString('noteInputMethod', 'Insert mode (grow measures)')
    }

    return new TranslatableString('noteInputMethod', 'Unknown note input mode')
}

function noteInputMethodAvailable(method: NoteEntryMethod, staff: Staff | null, tick: Fraction): boolean {
    if (method === NoteEntryMethod.BY_DURATION) {
        return !!staff && !staff.isTabStaff(tick)
    }

    return true
}

function segmentContentRect(segment: Segment, track: track_idx_t): RectF {
    let result = new RectF()

    const el = segment.element(track)
    if (!el) {
        return result
    }

    if (el.isChord()) {
        const chord = el as unknown as Chord
        for (const note of chord.notes()) {
            result = result.united(note.ldata().bbox().translated(note.pos()))
        }

        const hook = chord.hook()
        if (hook) {
            result = result.united(hook.ldata().bbox().translated(hook.pos()))
        }
    } else if (el.isRest() && !(el as unknown as Rest).isFullMeasureRest()) {
        result = result.united(el.ldata().bbox())
    }

    return result
}

export class NotationNoteInput {
    private m_getScore: () => Score
    private m_interaction: NotationInteraction
    private m_undoStack: NotationUndoStack
    private m_getViewRectFunc: (() => RectF) | null = null

    private m_noteInputStarted = new Notification()
    private m_noteInputEnded = new Notification()
    private m_noteAdded = new Notification()
    private m_stateChanged = new Notification()

    constructor(getScore: () => Score, interaction: NotationInteraction, undoStack: NotationUndoStack) {
        this.m_getScore = getScore
        this.m_interaction = interaction
        this.m_undoStack = undoStack

        this.m_interaction.selectionChanged().onNotify(() => {
            if (!this.isNoteInputMode()) {
                this.updateInputState()
            } else if (this.shouldSetupInputNote()) {
                const is = this.state()
                const prevStaffIdx = track2staff(is.prevTrack())

                if (prevStaffIdx !== is.staffIdx()) {
                    this.setupInputNote()
                }
            }
        })
    }

    isNoteInputMode(): boolean {
        return this.score().inputState().noteEntryMode()
    }

    state(): InputState {
        return this.score().inputState()
    }

    //! NOTE Copied from `void ScoreView::startNoteEntry()`
    startNoteInput(method: NoteEntryMethod = NoteEntryMethod.BY_NOTE_NAME, focusNotation = true): void {
        if (this.isNoteInputMode()) {
            return
        }

        const el = this.resolveNoteInputStartPosition()
        if (!el) {
            return
        }

        this.m_interaction.select([el], SelectType.SINGLE, 0)

        const is = this.score().inputState()

        const d = is.duration()
        if (!d.isValid() || d.isZero() || d.type() === DurationType.V_MEASURE) {
            is.setDuration(new TDuration(DurationType.V_QUARTER))
        }
        is.setAccidentalType(AccidentalType.NONE)

        is.setRest(false)
        is.setNoteEntryMode(true)

        const staff = this.score().staff(Math.trunc(is.track() / VOICES))

        if (noteInputMethodAvailable(method, staff, is.tick())) {
            is.setNoteEntryMethod(method)
        } else {
            is.setNoteEntryMethod(NoteEntryMethod.BY_NOTE_NAME) // fallback
        }

        if (this.shouldSetupInputNote()) {
            this.setupInputNote()
        }

        switch (staff!.staffType(is.tick()).group()) {
        case StaffGroup.STANDARD:
            break
        case StaffGroup.TAB: {
            let strg = 0 // assume topmost string as current string
            // if entering note entry with a note selected and the note has a string
            // set InputState::_string to note physical string
            if (el.isNote()) {
                strg = (el as unknown as Note).string()
            }
            is.setString(strg)
            break
        }
        case StaffGroup.PERCUSSION:
            break
        }

        this.notifyAboutNoteInputStarted(focusNotation)
        this.notifyAboutStateChanged()

        this.m_interaction.showItem(el)
        // TODO(port): accessibilityController()->announce(nameOfNoteInputMethod(method).translated())
    }

    private resolveNoteInputStartPosition(): EngravingItem | null {
        let topLeftChordRest: ChordRest | null = null
        const score = this.score()

        if (score.selection().isNone() && this.m_getViewRectFunc) {
            // no selection
            // choose page in current view (favor top left quadrant if possible)
            // select first (top/left) chordrest of that page in current view
            // or, CR at last selected position if that is in view
            const viewRect = this.m_getViewRectFunc()
            const topLeft = viewRect.topLeft()

            const points: PointF[] = [
                topLeft.plus(new PointF(viewRect.width() * 0.25, viewRect.height() * 0.25)),
                topLeft,
                viewRect.bottomLeft(),
                viewRect.topRight(),
                viewRect.bottomRight(),
            ]

            let page: Page | null = null
            for (const point of points) {
                page = score.searchPage(point)
                if (page) {
                    break
                }
            }

            if (page) {
                let tlY = 0.0
                let tlTick = new Fraction(0, 1)
                const pageRect = page.ldata().bbox().translated(page.pos())
                const intersect = viewRect.intersected(pageRect).translated(page.pos().neg())
                const el = page.items(intersect)

                let lastSelected: ChordRest | null = score.selection().currentCR()

                if (lastSelected && lastSelected.voice()) {
                    // if last selected CR was not in voice 1,
                    // find CR in voice 1 instead
                    const track = trackZeroVoice(lastSelected.track())
                    const s = lastSelected.segment()
                    if (s) {
                        lastSelected = s.nextChordRest(track, true)
                    }
                }

                for (const e of el) {
                    // loop through visible elements
                    // looking for the CR in voice 1 with earliest tick and highest staff position
                    // but stop if we find the last selected CR
                    const et = e.type()
                    if (et === ElementType.NOTE || et === ElementType.REST) {
                        if (e.voice()) {
                            continue
                        }
                        let cr: ChordRest | null
                        if (et === ElementType.NOTE) {
                            cr = e.parentItem() as unknown as ChordRest | null
                            if (!cr) {
                                continue
                            }
                        } else {
                            cr = e as unknown as ChordRest
                        }
                        if (cr === lastSelected) {
                            topLeftChordRest = cr
                            break
                        }
                        // compare ticks rather than x position
                        // to make sure we favor earlier rather than later systems
                        // even though later system might have note farther to left
                        let crTick: Fraction
                        if (cr.segment()) {
                            crTick = cr.segment().tick()
                        } else {
                            continue
                        }
                        // compare staff Y position rather than note Y position
                        // to be sure we do not reject earliest note
                        // just because it is lower in pitch than subsequent notes
                        let crY: number
                        if (cr.measure() && cr.measure().system()) {
                            crY = cr.measure().system()!.staffYpage(cr.staffIdx())
                        } else {
                            continue
                        }
                        if (topLeftChordRest) {
                            if (crTick.le(tlTick) && crY <= tlY) {
                                topLeftChordRest = cr
                                tlTick = crTick
                                tlY = crY
                            }
                        } else {
                            topLeftChordRest = cr
                            tlTick = crTick
                            tlY = crY
                        }
                    }
                }
            }
        }

        let el: EngravingItem | null = topLeftChordRest ?? score.selection().element()
        if (!el) {
            el = score.selection().firstChordRest()
        }

        const is = score.inputState()

        if (!el) {
            const segment = is.lastSegment()
            if (segment) {
                el = segment.element(is.track())
            }
        }

        if (!el || (!el.isChordRest() && !el.isNote())) {
            // if no note/rest is selected, start with voice 0
            const track = is.track() === nidx ? 0 : Math.trunc(is.track() / VOICES) * VOICES
            // try to find an appropriate measure to start in
            const tick = el ? el.tick() : new Fraction(0, 1)
            el = score.searchNote(tick, track)
            if (!el) {
                el = score.searchNote(new Fraction(0, 1), track)
            }
        }

        if (!el) {
            return null
        }

        if (el.isChord()) {
            const c = el as unknown as Chord
            let note = c.selectedNote()
            if (!note) {
                note = c.upNote()
            }
            el = note
        }

        return el
    }

    private shouldSetupInputNote(): boolean {
        return this.usingNoteInputMethod(NoteEntryMethod.BY_DURATION)
            || this.usingNoteInputMethod(NoteEntryMethod.RHYTHM)
    }

    private setupInputNote(): void {
        const is = this.score().inputState()
        const selectedItem = this.score().selection().element()

        if (selectedItem && selectedItem.isNote()) {
            is.setNotes([(selectedItem as unknown as Note).noteVal()])
            return
        }

        const tick = is.tick()
        const staff = is.staff()!
        let nval = new NoteVal()

        if (staff.isTabStaff(tick)) {
            const stringData = staff.part().stringData(tick, is.staffIdx())
            if (stringData) {
                nval.fret = 0
                nval.string = is.string()
                nval.pitch = stringData.getPitch(nval.string, nval.fret, StringData.pitchOffsetAtStaff(staff))
            }
        } else if (staff.isDrumStaff(tick)) {
            const drumset = is.drumset()
            if (drumset) {
                nval.pitch = is.drumNote()

                if (nval.pitch < 0) {
                    nval.pitch = drumset.nextPitch(nval.pitch)
                }

                if (drumset.isValid(nval.pitch)) {
                    nval.headGroup = drumset.noteHead(nval.pitch)
                }
            }
        } else {
            nval = this.noteValForLine(staff.middleLine(tick))
        }

        if (nval.pitch > 0) {
            is.setNotes([nval])
        }
    }

    private noteValForLine(line: number): NoteVal {
        const is = this.score().inputState()

        const pos = new Position()
        pos.segment = is.segment()
        pos.staffIdx = is.staffIdx()
        pos.line = line

        // C++ logs an error if no note value is found for the position
        return this.score().noteValForPosition(pos, is.accidentalType()) ?? new NoteVal()
    }

    endNoteInput(resetState = false): void {
        if (!this.isNoteInputMode()) {
            return
        }

        const is = this.score().inputState()
        is.setNoteEntryMode(false)

        const slur = is.slur()
        if (slur) {
            const el = slur.spannerSegments()
            if (el.length) {
                el[0].setSelected(false)
            }
            is.setSlur(null)
        }

        if (resetState) {
            is.setTrack(nidx)
            is.setString(-1)
            is.setSegment(null)
            is.setNotes([])
        }

        this.notifyAboutNoteInputEnded()
        this.updateInputState()
        // TODO(port): accessibilityController()->announce("Normal mode")
    }

    noteInputStarted(): Notification { return this.m_noteInputStarted }
    noteInputEnded(): Notification { return this.m_noteInputEnded }

    usingNoteInputMethod(method: NoteEntryMethod): boolean {
        return this.score().usingNoteEntryMethod(method)
    }

    setNoteInputMethod(method: NoteEntryMethod): void {
        const is = this.score().inputState()
        if (is.usingNoteEntryMethod(method)) {
            return
        }

        if (!noteInputMethodAvailable(method, is.staff(), is.tick())) {
            return
        }

        is.setNoteEntryMethod(method)
        if (this.shouldSetupInputNote()) {
            this.setupInputNote()
        }

        this.notifyAboutStateChanged()
    }

    addNote(params: NoteInputParams, addingMode: NoteAddingMode): void {
        this.m_interaction.hideShadowNote()

        const addToUpOnCurrentChord = addingMode === NoteAddingMode.CurrentChord
        const insertNewChord = addingMode === NoteAddingMode.InsertChord

        if (addToUpOnCurrentChord) {
            this.startEdit(new TranslatableString('undoableAction', 'Add note to chord'))
        } else if (insertNewChord) {
            this.startEdit(new TranslatableString('undoableAction', 'Insert note'))
        } else {
            this.startEdit(new TranslatableString('undoableAction', 'Enter note'))
        }
        this.score().cmdAddPitch(params, addToUpOnCurrentChord, insertNewChord)

        this.apply()

        if (this.shouldSetupInputNote()) {
            this.setupInputNote()
        }

        this.notifyNoteAddedChanged()
        this.notifyAboutStateChanged()

        this.m_interaction.checkAndShowError()
        this.m_interaction.showItem(this.state().cr())
    }

    padNote(pad: Pad): void {
        this.m_interaction.hideShadowNote()

        this.startEdit(new TranslatableString('undoableAction', 'Pad note'))
        this.score().padToggle(pad)
        this.apply()

        this.notifyAboutStateChanged()

        this.m_interaction.checkAndShowError()
    }

    putNote(pos: PointF, replace: boolean, insert: boolean): boolean {
        this.startEdit(new TranslatableString('undoableAction', 'Enter note'))
        const ret = this.score().putNote(pos, replace, insert)
        this.apply()

        if (ret) {
            if (this.shouldSetupInputNote()) {
                this.setupInputNote()
            }
        }

        this.notifyNoteAddedChanged()
        this.notifyAboutStateChanged()

        this.m_interaction.checkAndShowError()

        return ret
    }

    removeNote(pos: PointF): void {
        const inputState = this.score().inputState()
        const restMode = inputState.rest()

        this.startEdit(new TranslatableString('undoableAction', 'Delete note'))
        inputState.setRest(!restMode)
        this.score().putNote(pos, false, false)
        inputState.setRest(restMode)
        this.apply()

        this.notifyAboutStateChanged()

        this.m_interaction.checkAndShowError()
    }

    setInputNote(params: NoteInputParams): void {
        const is = this.score().inputState()
        if (!is.isValid()) {
            return
        }
        const staff = is.staff()!
        const tick = is.tick()

        let nval = new NoteVal()

        if (staff.isDrumStaff(tick)) {
            const drumset = is.drumset()
            if (drumset && drumset.isValid(params.drumPitch)) {
                nval.pitch = params.drumPitch
                nval.headGroup = drumset.noteHead(params.drumPitch)
            }
        } else {
            nval = this.noteValForLine(relStep(params.step, staff.clef(tick)))
        }

        if (nval.pitch > 0) {
            this.setInputNotes([nval])
        }
    }

    setInputNotes(notes: readonly NoteVal[]): void {
        const is = this.score().inputState()

        if (is.notes().length === notes.length && is.notes().every((n, i) => n.equals(notes[i]))) {
            return
        }

        if (notes.length) {
            const drumset = is.drumset()
            if (drumset) {
                const pitch = notes[0].pitch
                is.setDrumNote(pitch)
                is.setVoice(drumset.voice(pitch))
            }
        }

        is.setNotes(notes)
        this.notifyAboutStateChanged()
    }

    moveInputNotes(up: boolean, mode: UpDownMode): void {
        const is = this.score().inputState()
        if (!is.isValid()) {
            return
        }

        is.setAccidentalType(AccidentalType.NONE)

        const staff = is.staff()!
        const tick = is.tick()

        const notes: NoteVal[] = []

        for (const val of is.notes()) {
            let newVal = new NoteVal()

            if (staff.isDrumStaff(tick)) {
                const drumset = is.drumset()
                if (drumset) {
                    newVal.pitch = up ? drumset.nextPitch(val.pitch) : drumset.prevPitch(val.pitch)

                    if (drumset.isValid(newVal.pitch)) {
                        newVal.headGroup = drumset.noteHead(newVal.pitch)
                        notes.push(newVal)
                    }
                }
                continue
            }

            switch (mode) {
            case UpDownMode.CHROMATIC:
                newVal.pitch = val.pitch + (up ? 1 : -1)
                break
            case UpDownMode.DIATONIC: {
                const oldLine = noteValToLine(val, staff, tick)
                const newLine = oldLine + (up ? -1 : 1)
                newVal = this.noteValForLine(newLine)
                break
            }
            case UpDownMode.OCTAVE:
                newVal = val.clone()
                newVal.pitch += up ? PITCH_DELTA_OCTAVE : -PITCH_DELTA_OCTAVE
                break
            }

            newVal.pitch = clampPitch(newVal.pitch)
            notes.push(newVal)
        }

        this.setInputNotes(notes)
    }

    setRestMode(rest: boolean): void {
        const is = this.score().inputState()
        if (is.rest() === rest) {
            return
        }

        is.setRest(rest)
        this.notifyAboutStateChanged()
    }

    setAccidental(accidentalType: AccidentalType): void {
        this.score().toggleAccidental(accidentalType)

        this.notifyAboutStateChanged()

        this.m_interaction.checkAndShowError()
    }

    setArticulation(articulationSymbolId: SymId): void {
        const inputState = this.score().inputState()
        const articulations = updateArticulationIds(inputState.articulationIds(), articulationSymbolId, ArticulationsUpdateMode.Remove)
        inputState.setArticulationIds(articulations)

        this.notifyAboutStateChanged()

        this.m_interaction.checkAndShowError()
    }

    setDrumNote(note: number): void {
        const is = this.score().inputState()
        if (is.drumNote() === note) {
            return
        }

        is.setDrumNote(note)
        if (this.shouldSetupInputNote()) {
            this.setupInputNote()
        }

        this.notifyAboutStateChanged()
    }

    setCurrentVoice(voiceIndex: voice_idx_t): void {
        const inputState = this.score().inputState()
        if (voiceIndex >= VOICES || voiceIndex === inputState.voice()) {
            return
        }

        inputState.setVoice(voiceIndex)
        this.notifyAboutStateChanged()
    }

    setCurrentTrack(trackIndex: track_idx_t): void {
        this.score().inputState().setTrack(trackIndex)
        this.notifyAboutStateChanged()
    }

    /** the note input cursor in canvas coordinates (empty if not in note input mode) */
    cursorRect(): RectF {
        if (!this.isNoteInputMode()) {
            return new RectF()
        }

        const score = this.score()
        const inputState = score.inputState()
        const segment = inputState.segment()
        if (!segment) {
            return new RectF()
        }

        const system = segment.measure().system()
        if (!system) {
            return new RectF()
        }

        const track = inputState.track() === nidx ? 0 : inputState.track()
        const staffIdx = track2staff(track)

        const staff = score.staff(staffIdx)
        if (!staff) {
            return new RectF()
        }

        const globalSpatium = score.style().spatium()

        const staffType = staff.staffType(inputState.tick())
        const isTabStaff = staffType.isTabStaff()
        const localSpatium = staffType.spatium()

        const defaultWidth = score.noteHeadWidth() * localSpatium / globalSpatium

        const contentRect = segmentContentRect(segment, track)
        let x = contentRect.x() + segment.pagePos().x()

        const barNoteDist = score.style().styleMM(Sid.barNoteDistance)
        if (segment.x() < barNoteDist) {
            x += barNoteDist - segment.x()
        }

        let y = system.staffCanvasYpage(staffIdx)
        let w = contentRect.width() > 0 ? contentRect.width() : defaultWidth
        let h = 0.0

        let sideMargin: number

        if (isTabStaff) {
            const minWidth = 2.0 * globalSpatium
            sideMargin = Math.max(0.3 * globalSpatium, 0.5 * (minWidth - w))
        } else {
            sideMargin = 0.5 * globalSpatium
        }

        // Don't extend further to the left than the center between the current and previous segment
        const prevSeg = segment.prev1WithElemsOnTrack(track, SegmentType.ChordRest)
        if (prevSeg && prevSeg.measure() === segment.measure()) {
            const prevSegContentRect = segmentContentRect(prevSeg, track)
            if (prevSegContentRect.width() > 0) {
                const centerBetweenPrevSegRightAndCurrSegLeft = (prevSeg.pagePos().x() + prevSegContentRect.right() + x) * 0.5
                sideMargin = Math.min(sideMargin, x - centerBetweenPrevSegRightAndCurrSegLeft)
            }
        }

        x -= sideMargin
        w += 2 * sideMargin

        const yOffset = staffType.yoffset().val() * localSpatium
        y += yOffset

        const inputStateStringsCount = inputState.string()
        const instrumentStringsCount = staff.part().instrument().stringData()?.strings() ?? 0

        const lineDist = staffType.lineDistance().val() * localSpatium

        if (isTabStaff && inputStateStringsCount >= 0 && inputStateStringsCount <= instrumentStringsCount) {
            h = lineDist
            y += staffType.physStringToYOffset(inputStateStringsCount) * localSpatium
            y -= (staffType.onLines() ? lineDist * 0.5 : lineDist)
        } else {
            const skylineMargin = 0.75 * localSpatium
            const lines = staffType.lines()

            h = (lines - 1) * lineDist + 2 * skylineMargin
            y -= skylineMargin
        }

        // C++: translated by the page position for the horizontal canvas orientation (the port's view)
        return new RectF(x, y, w, h).translated(system.page()!.pos())
    }

    addTuplet(options: TupletOptions): void {
        const inputState = this.score().inputState()

        this.startEdit(new TranslatableString('undoableAction', 'Add tuplet'))
        this.score().expandVoice()
        const chordRest = inputState.cr()
        if (chordRest) {
            let ratio = options.ratio
            if (options.autoBaseLen) {
                ratio = new Fraction(ratio.numerator(), Tuplet.computeTupletDenominator(ratio.numerator(), inputState.ticks()))
            }
            this.score().changeCRlen(chordRest, inputState.duration())
            this.score().addTuplet(chordRest, ratio, options.numberType, options.bracketType)
        }
        this.apply()

        this.notifyAboutStateChanged()
    }

    addSlur(slur: Slur | null): void {
        const inputState = this.score().inputState()
        inputState.setSlur(slur)

        if (slur) {
            const slurSpannerSegments = slur.spannerSegments()
            if (slurSpannerSegments.length) {
                slurSpannerSegments[0].setSelected(true)
            }
        }

        this.notifyAboutStateChanged()
    }

    resetSlur(): void {
        const inputState = this.score().inputState()
        const slur = inputState.slur()
        if (!slur) {
            return
        }

        this.score().deselect(slur)

        this.addSlur(null)
    }

    addTie(): void {
        // Calls `startEdit` internally
        this.score().cmdAddTie()

        this.notifyAboutStateChanged()
        this.m_interaction.checkAndShowError()
    }

    addLaissezVib(): void {
        // Calls `startEdit` internally
        this.score().cmdToggleLaissezVib()

        this.notifyAboutStateChanged()
        this.m_interaction.checkAndShowError()
    }

    noteAdded(): Notification { return this.m_noteAdded }
    stateChanged(): Notification { return this.m_stateChanged }

    setGetViewRectFunc(func: (() => RectF) | null): void {
        this.m_getViewRectFunc = func
    }

    doubleNoteInputDuration(): void {
        this.startEdit(new TranslatableString('undoableAction', 'Double note input duration'))
        this.score().cmdIncDecDuration(-1, false) // TODO(port): cmdPadNoteIncreaseTAB (tablature)
        this.apply()

        this.notifyAboutStateChanged()
        this.m_interaction.checkAndShowError()
    }

    halveNoteInputDuration(): void {
        this.startEdit(new TranslatableString('undoableAction', 'Halve note input duration'))
        this.score().cmdIncDecDuration(1, false) // TODO(port): cmdPadNoteDecreaseTAB (tablature)
        this.apply()

        this.notifyAboutStateChanged()
        this.m_interaction.checkAndShowError()
    }

    private score(): Score { return this.m_getScore() }

    private startEdit(actionName: TranslatableString): void {
        this.m_undoStack.prepareChanges(actionName)
    }

    private apply(): void {
        this.m_undoStack.commitChanges()
        this.m_interaction.notifyAboutNotationChanged()

        const chordRest = this.score().inputState().cr()
        if (chordRest) {
            this.m_interaction.showItem(chordRest)
        }
    }

    updateInputState(): void {
        const is = this.score().inputState()
        is.update(this.score().selection())

        if (!NotationConfiguration.addAccidentalDotsArticulationsToNextNoteEntered()) {
            is.setAccidentalType(AccidentalType.NONE)
            is.setDots(0)
            is.setArticulationIds([])
        }

        this.notifyAboutStateChanged()
    }

    private notifyAboutStateChanged(): void { this.m_stateChanged.notify() }
    private notifyNoteAddedChanged(): void { this.m_noteAdded.notify() }
    private notifyAboutNoteInputStarted(_focusNotation: boolean): void { this.m_noteInputStarted.notify() }
    private notifyAboutNoteInputEnded(): void { this.m_noteInputEnded.notify() }
}
