/*
 * SPDX-License-Identifier: GPL-3.0-only
 * MuseEncore — port of MuseScore Studio (https://github.com/musescore/MuseScore)
 * Copyright (C) 2021-2026 MuseScore Limited and others
 *
 * Port of src/notation/internal/notationinteraction.h/.cpp: hit testing, select, keyboard navigation of the
 * selection, the editing commands (startEdit/apply around the Score commands), undo/redo, and of
 * notationselectionrange.cpp.
 *
 * The copy/paste, text editing and drag sections are at the end of the class.
 *
 * TODO(port): showItem (the UI scrolls to selectionBounds()), playback, moveElementSelection (next/prev-element:
 * Score::nextElement/prevElement), moveStringSelection, anchor lines, drop of dragged palette items / mime data.
 */

import { NotationConfiguration } from './notationconfiguration'
import '../../engraving/editing/spell'
import { SplitJoinMeasure } from '../../engraving/editing/splitjoinmeasure'
import { HDuration, Voicing } from '../../engraving/dom/realizedharmony'
import { Prefer } from '../../engraving/dom/pitchspelling'
import { EditTimeTickAnchors, MoveElementAnchors } from '../../engraving/dom/anchors'
import type { MuseScoreView } from '../../engraving/editing/mscoreview'
import type { SoundFlag } from '../../engraving/dom/soundflag'
import { LineF, PointF, RectF } from '../../framework/draw/types/geometry'
import { DirectionV, DurationType, ElementType, LayoutBreakType, VOICES, nidx, type staff_idx_t, type track_idx_t, type voice_idx_t } from '../../engraving/types/types'
import type { Rest } from '../../engraving/dom/rest'
import { Pad } from '../../engraving/dom/score'
import { NoteEntryMethod, type InputState } from '../../engraving/dom/input'
import { AccidentalType } from '../../engraving/dom/accidentaldata'
import { Pid, PropertyFlags, propertyUserName } from '../../engraving/dom/property'
import type { UpDownMode } from '../../engraving/dom/mscore'
import type { TDuration } from '../../engraving/dom/durationtype'
import type { PropertyValue } from '../../engraving/types/propertyvalue'
import '../../engraving/editing/edit'
import '../../engraving/dom/noteentry'
import { SelState, SelectType } from '../../engraving/dom/select'
import { SegmentType } from '../../engraving/dom/segment'
import { nextChordRest, prevChordRest, type Chord } from '../../engraving/dom/chord'
import '../../engraving/dom/navigate'
import '../../engraving/editing/cmd'
import { ScoreRangeUtilities } from '../utilities/scorerangeutilities'
import { BracketsType } from '../notationtypes'
import { NotationUndoStack, Notification } from './notationundostack'
import { NotationNoteInput } from './notationnoteinput'
import { TranslatableString } from '../../framework/global/types/translatablestring'
import { EngravingConfiguration } from '../../engraving/internal/engravingconfiguration'
import { Brush, BrushStyle, Pen, PenStyle } from '../../framework/draw/types/drawtypes'
import { PainterPath } from '../../framework/draw/types/painterpath'
import type { Painter } from '../../framework/draw/painter'
import type { Score } from '../../engraving/dom/score'
import type { EngravingItem } from '../../engraving/dom/engravingitem'
import type { Page } from '../../engraving/dom/page'
import type { Measure } from '../../engraving/dom/measure'
import type { Staff } from '../../engraving/dom/staff'
import type { Segment } from '../../engraving/dom/segment'
import type { ChordRest } from '../../engraving/dom/chordrest'
import type { Note } from '../../engraving/dom/note'
import type { NoteDot } from '../../engraving/dom/notedot'
import type { KeySig } from '../../engraving/dom/keysig'
import type { TimeSig } from '../../engraving/dom/timesig'
// (imports of the palette section)
import { staff2track, track2staff } from '../../engraving/types/types'
import { Factory } from '../../engraving/dom/factory'
import { filterTargetElements } from '../../engraving/dom/utils'
import { scoreDummy } from '../../engraving/compat/dummyelement'
import { EditData, KeyboardModifier } from '../../engraving/editing/editdata'
import type { Selection } from '../../engraving/dom/select'
import type { LayoutBreak } from '../../engraving/dom/layoutbreak'
import type { Spanner, SpannerSegment } from '../../engraving/dom/spanner'
import type { Hairpin } from '../../engraving/dom/hairpin'
import type { Clef } from '../../engraving/dom/clef'
// (imports of the copy/paste, editing and drag sections)
import { Fraction } from '../../engraving/types/fraction'
import { FontStyle, LyricsSyllabic, TextStyleType, trackZeroVoice } from '../../engraving/types/types'
import { MScore, MsError } from '../../engraving/dom/mscore'
import { XmlReader } from '../../engraving/rw/xmlreader'
import { MimeData, clipboard } from '../../framework/global/clipboard'
import { Grip, KeyboardKey, MouseButton } from '../../engraving/editing/editdata'
import { RemoveText, TextEditData } from '../../engraving/editing/textedit'
import { SelectTextType, TextCursorMoveMode, TextCursorMoveOperation, VerticalAlignment, textBaseRenderer, type TextBase } from '../../engraving/dom/textbase'
import { HarmonyType, type Harmony } from '../../engraving/dom/harmony'
import { Lyrics } from '../../engraving/dom/lyrics'
import { Lasso } from '../../engraving/dom/lasso'
import { segmentsAreAdjacent } from '../../engraving/dom/utils'
import { EditModeRenderer } from '../../engraving/rendering/editmode/editmoderenderer'
import { Color } from '../../framework/draw/types/color'
import { mtrc } from '../../framework/global/translation'
import { isVerticalBoxTextStyle } from '../notationtypes'
import type { ElementGroup } from '../../engraving/dom/elementgroup'
import type { TBox } from '../../engraving/dom/box'
import type { FretDiagram } from '../../engraving/dom/fret'
import type { MeasureBase } from '../../engraving/dom/measurebase'
import { InsertMeasureOptions } from '../../engraving/editing/edit'
import { AddBoxesTarget, BoxType } from '../notationtypes'
import { readType } from '../../engraving/dom/paste'
import { ActionIconType, type ActionIcon } from '../../engraving/dom/actionicon'
import type { StaffLines } from '../../engraving/dom/stafflines'
import { RWRegister } from '../../engraving/rw/rwregister'
import { SingleLayout } from '../../engraving/rendering/single/singlelayout'
// (imports of the note input section)
import { Constants } from '../../engraving/types/constants'
import { NoteHeadGroup, type BeamMode } from '../../engraving/types/types'
import { Sid } from '../../engraving/style/styledef'
import { Note as NoteInputNote } from '../../engraving/dom/note'
import { Tuplet } from '../../engraving/dom/tuplet'
import { TDuration as TDurationValue } from '../../engraving/dom/durationtype'
import { MScore as NoteInputMScore, MsError as NoteInputMsError } from '../../engraving/dom/mscore'
import { ScoreRenderer } from '../../engraving/rendering/score/scorerenderer'
import { NoteType as GraceNoteType } from '../../engraving/dom/chordrest'
import { isNotesIntervalValid, type TupletOptions } from '../notationtypes'
import { ShadowNote } from '../../engraving/dom/shadownote'
import type { Slur } from '../../engraving/dom/slur'
import type { OttavaType } from '../../engraving/dom/ottava'
import type { HairpinType } from '../../engraving/dom/hairpin'
import { Position } from '../../engraving/dom/score'
import { Accidental } from '../../engraving/dom/accidental'
import { NoteVal } from '../../engraving/dom/input'
import { noteValToAccidentalVal, noteValToLine } from '../../engraving/dom/utils'
import { TDraw } from '../../engraving/rendering/score/tdraw'
import type { PaintOptions } from '../../engraving/rendering/paintoptions'
import type { SymId } from '../../engraving/types/symid'
import { ArticulationsUpdateMode, flipArticulations, splitArticulations } from '../../engraving/dom/articulation'
import { PlacementV, type TransposeDirection } from '../../engraving/types/types'
import { Transpose } from '../../engraving/editing/transpose'
import { ChangeDrumset } from '../../engraving/editing/editpart'
import { Instrument } from '../../engraving/dom/instrument'
import type { InstrumentChange } from '../../engraving/dom/instrchange'
import type { InstrumentTemplate } from '../../engraving/dom/instrtemplate'
import type { TransposeOptions } from '../notationtypes'
import { EditSystemLocks } from '../../engraving/editing/editsystemlocks'
import { AddRemoveSystemLockType } from '../notationtypes'

/** C++ NotationInteraction::ShadowNoteParams */
/** C++ static accidentalType(const InputState&, const NoteVal&, int line) of notationinteraction.cpp */
function previewAccidentalType(is: InputState, nval: NoteVal, line: number): AccidentalType {
    if (is.rest()) {
        return AccidentalType.NONE
    }

    const accVal = is.accidentalType() !== AccidentalType.NONE
        ? Accidental.subtype2value(is.accidentalType())
        : noteValToAccidentalVal(nval, is.staff()!, is.tick())

    const segment = is.segment()!
    const [existingAccVal, error] = segment.measure().findAccidentalAtLine(segment, is.staffIdx(), line)

    if (!error && accVal !== existingAccVal) {
        const type = Accidental.value2subtype(accVal)
        return type === AccidentalType.NONE ? AccidentalType.NATURAL : type
    }

    return AccidentalType.NONE
}

interface ShadowNoteParams {
    duration: TDuration
    accidentalType: AccidentalType
    articulationIds: ReadonlySet<SymId>
    position: Position
}

export enum MoveDirection {
    Undefined, Left, Right, Up, Down,
}

export enum MoveSelectionType {
    Undefined, EngravingItem, Chord, Measure, Track, Frame, System, String,
}

export enum ExpandSelectionMode {
    BeginSystem, EndSystem, BeginScore, EndScore,
}

export interface HitMeasureData {
    measure: Measure | null
    staff: Staff | null
}

/** C++ activeCr() */
function activeCr(score: Score): ChordRest | null {
    let cr = score.selection().activeCR()
    if (!cr) {
        cr = score.selection().lastChordRest()
        if (!cr && score.noteEntryMode()) {
            cr = score.inputState().cr()
        }
    }
    return cr
}

let s_selectInstrumentProvider: (() => InstrumentTemplate | null) | null = null

/** the instrument of an added instrument change (MuseScore's select instrument dialog); see selectInstrument() */
export function setSelectInstrumentProvider(provider: (() => InstrumentTemplate | null) | null): void {
    s_selectInstrumentProvider = provider
}

export class NotationInteraction {
    private m_score: Score
    private m_notationChanged = new Notification()
    private m_selectionChanged = new Notification()
    private m_lastElementHit: EngravingItem | null = null // C++ NotationSelection::m_lastElementHit
    private m_noteInputStateChanged = new Notification()
    private m_undoStack: NotationUndoStack
    private m_noteInput: NotationNoteInput

    constructor(score: Score) {
        this.m_score = score
        this.m_undoStack = new NotationUndoStack(() => this.m_score, this.m_notationChanged)
        this.m_noteInput = new NotationNoteInput(() => this.m_score, this, this.m_undoStack)

        this.m_noteInput.stateChanged().onNotify(() => {
            if (!this.m_noteInput.isNoteInputMode()) {
                this.hideShadowNote()
            }
        })

        this.m_undoStack.stackChanged().onNotify(() => {
            this.notifyAboutSelectionChangedIfNeed()
            this.notifyAboutNoteInputStateChanged()
        })
    }

    score(): Score { return this.m_score }
    noteInput(): NotationNoteInput { return this.m_noteInput }
    undoStack(): NotationUndoStack { return this.m_undoStack }

    /** C++ INotation::notationChanged(): the score changed (relayout done), the view must be repainted */
    notationChanged(): Notification { return this.m_notationChanged }
    selectionChanged(): Notification { return this.m_selectionChanged }
    noteInputStateChanged(): Notification { return this.m_noteInputStateChanged }

    /** returns true (C++ sends selectionChanged) if the score's selection changed since the last notification */
    notifyAboutSelectionChangedIfNeed(): boolean {
        if (!this.score().selectionChanged()) {
            return false
        }

        this.score().setSelectionChanged(false)
        this.m_selectionChanged.notify()
        return true
    }

    notifyAboutNotationChanged(): void {
        this.m_notationChanged.notify()
    }

    notifyAboutNoteInputStateChanged(): void {
        this.m_noteInputStateChanged.notify()
    }

    // ---------------------------------------------------------------------------------
    // editing frame (every command: startEdit(), the Score command, apply())
    // ---------------------------------------------------------------------------------

    startEdit(actionName: TranslatableString = new TranslatableString()): void {
        this.m_undoStack.prepareChanges(actionName)
    }

    apply(): void {
        this.m_undoStack.commitChanges()
        this.notifyAboutNotationChanged()
    }

    rollback(): void {
        this.m_undoStack.rollbackChanges()
    }

    undo(): void {
        this.m_undoStack.undo(this.m_editData)
    }

    redo(): void {
        this.m_undoStack.redo(this.m_editData)
    }

    /** C++ showItem(): the view scrolls to the item; here the UI scrolls to selectionBounds() after a command */
    showItem(_el: EngravingItem | null): void {}

    /** C++ checkAndShowError(): shows MScore's last error (MScoreErrorsController); TODO(port): error messages */
    checkAndShowError(): void {}

    // =================================================================================================================
    //   note input: the shadow note, slurs, tuplets, lines, grace notes, beams, intervals (section of the note input
    //   port; notationinteraction.cpp)
    // =================================================================================================================

    private m_shadowNoteChanged = new Notification()

    shadowNote(): ShadowNote {
        return this.score().shadowNote()
    }

    /** returns true if the shadow note is shown (C++ sends shadowNoteChanged(visible)) */
    showShadowNoteForPosition(pos: PointF): boolean {
        const inputState = this.score().inputState()
        const shadowNote = this.score().shadowNote()

        const position = this.score().getPosition(pos, inputState.voice())
        if (!position) {
            shadowNote.setVisible(false)
            this.m_shadowNoteChanged.notify()
            return false
        }

        const params: ShadowNoteParams = {
            duration: inputState.duration(),
            accidentalType: inputState.accidentalType(),
            articulationIds: inputState.articulationIds(),
            position,
        }

        const show = this.doShowShadowNote(shadowNote, params)
        this.m_shadowNoteChanged.notify()
        return show
    }

    private doShowShadowNote(shadowNote: ShadowNote, params: ShadowNoteParams): boolean {
        const position = params.position

        const inputState = this.score().inputState()
        const staff = this.score().staff(position.staffIdx)!

        let segment = position.segment!
        let segmentSkylineTopY = 0
        let segmentSkylineBottomY = 0

        const shadowNoteActualSegment = position.segment!.prev1enabled()
        if (shadowNoteActualSegment) {
            segment = shadowNoteActualSegment
            segmentSkylineTopY = shadowNoteActualSegment.elementsTopOffsetFromSkyline(position.staffIdx)
            segmentSkylineBottomY = shadowNoteActualSegment.elementsBottomOffsetFromSkyline(position.staffIdx)
        }

        const tick = segment.tick()
        const mag = staff.staffMag(tick)

        const instr = staff.part().instrument(tick)

        // in any empty measure, pos will be right next to barline
        // so pad this by barNoteDistance
        const relX = position.pos.x() - position.segment!.measure().canvasPos().x()
        position.pos.setX(position.pos.x() - Math.min(relX - this.score().style().styleMM(Sid.barNoteDistance) * mag, 0.0))

        let noteheadGroup = NoteHeadGroup.HEAD_NORMAL
        const noteHead = params.duration.headType()

        const line = position.line
        let voice = 0
        let drumNotePitch = -1

        if (instr.useDrumset()) {
            const ds = instr.drumset()!

            const noteInputPitch = inputState.drumNote()

            if (ds.isValid(noteInputPitch) && ds.line(noteInputPitch) === line) {
                noteheadGroup = ds.noteHead(noteInputPitch)
                voice = ds.voice(noteInputPitch)
                drumNotePitch = noteInputPitch
            } else {
                const pitch = ds.defaultPitchForLine(line)
                if (ds.isValid(pitch)) {
                    noteheadGroup = ds.noteHead(pitch)
                    voice = ds.voice(pitch)
                    drumNotePitch = pitch
                }
                if (drumNotePitch < 0) {
                    shadowNote.setVisible(false)
                    return false
                }
            }
        } else {
            voice = inputState.voice()
        }

        shadowNote.setVisible(true)
        shadowNote.mutldata().setMag(mag)
        shadowNote.setTick(tick)
        shadowNote.setStaffIdx(position.staffIdx)
        shadowNote.setVoice(voice)
        shadowNote.setLineIndex(line)

        // C++: configuration()->noteInputPreviewColor() (default: the selection color, so the highlight color is used)
        shadowNote.setColor(EngravingConfiguration.highlightSelectionColor(voice))

        let symNotehead: SymId

        if (inputState.rest()) {
            const rest = Factory.createItem(ElementType.REST, scoreDummy(this.score()).segment()) as unknown as Rest
            rest.setDurationType(params.duration)
            rest.setTicks(params.duration.fraction())
            symNotehead = rest.getSymbol(params.duration.type(), 0, staff.lines(position.segment!.tick()))
            shadowNote.setState(symNotehead, params.duration, true, segmentSkylineTopY, segmentSkylineBottomY)
        } else {
            if (noteheadGroup === NoteHeadGroup.HEAD_CUSTOM) {
                symNotehead = instr.drumset()!.noteHeads(drumNotePitch, noteHead)
            } else {
                symNotehead = NoteInputNote.noteHeadSym(0, noteheadGroup, noteHead)
            }

            shadowNote.setState(symNotehead, params.duration, false, segmentSkylineTopY, segmentSkylineBottomY,
                params.accidentalType, params.articulationIds)
        }

        ScoreRenderer.layoutItem(shadowNote)

        shadowNote.setPos(position.pos)

        return true
    }

    /** C++ NotationInteraction::previewNotes */
    private previewNotes(): ShadowNoteParams[] {
        const result: ShadowNoteParams[] = []

        const is = this.score().inputState()
        if (!is.isValid()) {
            return result
        }

        const segment = is.segment()!
        const staffIdx = is.staffIdx()
        const staff = this.score().staff(staffIdx)
        const system = segment.system()
        const sysStaff = system ? system.staff(staffIdx) : null
        const measure = segment.measure()

        if (!staff || !sysStaff || !measure) {
            return result
        }

        const tick = is.tick()
        const measurePos = measure.canvasPos()
        const lineDist = staff.staffType(tick).lineDistance().val()
            * (staff.isTabStaff(tick) ? 1 : 0.5)
            * staff.staffMag(tick)
            * this.score().style().spatium()

        const nvals = is.rest() ? [new NoteVal()] : is.notes()

        for (const nval of nvals) {
            const line = noteValToLine(nval, staff, tick)
            const y = sysStaff.y() + line * lineDist

            const position = new Position()
            position.segment = segment
            position.staffIdx = staffIdx
            position.line = line
            position.pos = new PointF(segment.x(), y).plus(measurePos)

            result.push({
                duration: is.rest() ? is.duration() : new TDurationValue(),
                accidentalType: previewAccidentalType(is, nval, line),
                articulationIds: new Set<SymId>(),
                position,
            })
        }

        result.sort((p1, p2) => p1.position.line - p2.position.line)

        return result
    }

    /** C++ NotationInteraction::shouldDrawInputPreview */
    shouldDrawInputPreview(): boolean {
        return this.m_noteInput.isNoteInputMode() && this.m_noteInput.usingNoteInputMethod(NoteEntryMethod.BY_DURATION)
    }

    /** C++ NotationInteraction::drawInputPreview: the notes of the next input at the cursor (input by duration) */
    drawInputPreview(painter: Painter, opt: PaintOptions): void {
        const paramsList = this.previewNotes()
        if (paramsList.length === 0) {
            return
        }

        const previewList = paramsList.map((params) => {
            const preview = new ShadowNote(this.score())
            this.doShowShadowNote(preview, params)
            return preview
        })

        const is = this.score().inputState()
        const isUp = !is.rest() && previewList[0].computeUp()
        let isLeft = isUp
        let prevLine = Number.MAX_SAFE_INTEGER

        const correctNotePositionIfNeed = (note: ShadowNote): void => {
            if (paramsList.length === 1) {
                return
            }

            const conflict = Math.abs(prevLine - note.lineIndex()) < 2
            prevLine = note.lineIndex()

            if (conflict || isUp !== isLeft) {
                isLeft = !isLeft
            }

            if (isUp === isLeft) {
                return
            }

            const noteheadBbox = note.symBbox(note.noteheadSymbol())

            if (isLeft) {
                note.move(new PointF(-noteheadBbox.width(), 0))
            } else {
                note.move(new PointF(noteheadBbox.width(), 0))
            }
        }

        for (const note of isUp ? [...previewList].reverse() : previewList) {
            correctNotePositionIfNeed(note)
            TDraw.drawItem(note, painter, opt)
        }
    }

    hideShadowNote(): void {
        this.score().shadowNote().setVisible(false)
        this.m_shadowNoteChanged.notify()
    }

    /** in canvas coordinates; empty if there is no visible shadow note */
    shadowNoteRect(): RectF {
        const note = this.score().shadowNote()
        if (!note.visible() || !note.isValid()) {
            return new RectF()
        }

        const rect = note.canvasBoundingRect()

        let penWidth = note.style().styleMM(Sid.stemWidth)
        if (note.ledgerLinesVisible()) {
            const w = note.style().styleMM(Sid.ledgerLineWidth)
            penWidth = Math.max(penWidth, w)
        }

        penWidth *= note.mag()
        return rect.adjusted(-penWidth, -penWidth, penWidth, penWidth)
    }

    shadowNoteChanged(): Notification { return this.m_shadowNoteChanged }

    addSlurToSelection(): void {
        if (this.score().selection().isNone()) {
            return
        }

        // Calls `startEdit` internally
        this.doAddSlur()
    }

    /** NOTE Copied from ScoreView::cmdAddSlur */
    doAddSlur(slurTemplate: Slur | null = null): void {
        this.startEdit(new TranslatableString('undoableAction', 'Add slur'))

        let firstChordRest: ChordRest | null = null
        let secondChordRest: ChordRest | null = null
        const sel = this.score().selection()
        const el = sel.uniqueElements()

        if (sel.isRange()) {
            const startTrack = staff2track(sel.staffStart())
            const endTrack = staff2track(sel.staffEnd())
            for (let track = startTrack; track < endTrack; ++track) {
                firstChordRest = null
                secondChordRest = null
                for (let e of el) {
                    if (e.track() !== track) {
                        continue
                    }
                    if (e.isNote()) {
                        e = (e as unknown as Note).chord()
                    }
                    if (!e.isChord()) {
                        continue
                    }
                    const cr = e as unknown as ChordRest
                    if (!firstChordRest || firstChordRest.tick().gt(cr.tick())) {
                        firstChordRest = cr
                    }
                    if (!secondChordRest || secondChordRest.tick().lt(cr.tick())) {
                        secondChordRest = cr
                    }
                }

                const firstCrTrill = !!firstChordRest && firstChordRest.isChord() && (firstChordRest as unknown as Chord).isTrillCueNote()
                const secondCrTrill = !!secondChordRest && secondChordRest.isChord() && (secondChordRest as unknown as Chord).isTrillCueNote()

                if (firstChordRest && (firstChordRest !== secondChordRest) && !(firstCrTrill || secondCrTrill)) {
                    this.doAddSlurBetween(firstChordRest, secondChordRest, slurTemplate)
                }
            }
        } else if (sel.isSingle()) {
            const element = sel.element()!
            if (element.isNote() && !(element as unknown as Note).isTrillCueNote()) {
                this.doAddSlurBetween((element as unknown as Note).chord(), null, slurTemplate)
            }
            // TODO(port): hammer-on/pull-off templates on a selected slur segment
        } else {
            let firstItem: EngravingItem | null = null
            let secondItem: EngravingItem | null = null
            for (let e of el) {
                if (e.isNote()) {
                    e = (e as unknown as Note).chord()
                }

                const meas = e.findMeasure()
                const header = !!meas && meas.header() && e.tick().eq(meas.tick())

                if (!e.isChord() && !e.isBarLine() && !header) {
                    continue
                }

                if (!firstItem || e.isBefore(firstItem)) {
                    firstItem = e
                }
                if (!secondItem || secondItem.isBefore(e)) {
                    secondItem = e
                }
            }

            if (firstChordRest === secondItem && (!firstItem || firstItem.isChordRest())) {
                // TODO(port): ChordRestNavigateOptions disableOverRepeats
                secondItem = nextChordRest(firstItem as unknown as ChordRest | null)
            }

            const firstCrTrill = !!firstItem && firstItem.isChord() && (firstItem as unknown as Chord).isTrillCueNote()
            const secondCrTrill = !!secondItem && secondItem.isChord() && (secondItem as unknown as Chord).isTrillCueNote()

            if (firstItem && secondItem && (firstItem.isChordRest() || secondItem.isChordRest()) && !(firstCrTrill || secondCrTrill)) {
                this.doAddSlurBetween(firstItem, secondItem, slurTemplate)
            }
        }

        this.apply()
    }

    /** C++ doAddSlur(EngravingItem* firstItem, EngravingItem* secondItem, const Slur* slurTemplate) */
    private doAddSlurBetween(firstItem: EngravingItem, secondItem: EngravingItem | null, slurTemplate: Slur | null): void {
        const meas = firstItem ? firstItem.findMeasure() : null
        const header = !!meas && meas.header() && firstItem.tick().eq(meas.tick()) && !firstItem.isChordRest()

        if (firstItem && secondItem
            && ((firstItem.isBarLine() !== secondItem.isBarLine()) || (header && secondItem.isChordRest()))) {
            // TODO(port): partial slurs (incoming/outgoing over a repeat bar line: undoSetIncoming/undoSetOutgoing)
            return
        }

        const firstChordRest = firstItem as unknown as ChordRest
        const secondChordRest = secondItem as unknown as ChordRest | null

        let slur = firstChordRest.slur(secondChordRest)
        if (!slur || slur.slurDirection() !== DirectionV.AUTO) {
            slur = this.score().addSlur(firstChordRest, secondChordRest, slurTemplate)
        }
        // TODO(port): replacing an existing slur with a hammer-on/pull-off

        if (this.m_noteInput.isNoteInputMode()) {
            this.m_noteInput.addSlur(slur)
        } else if (!secondItem) {
            const segment = slur.frontSegment()
            this.select([segment], SelectType.SINGLE)
            // TODO(port): startEditGrip(segment, Grip::END)
        }
    }

    addOttavaToSelection(type: OttavaType): void {
        if (this.score().selection().isNone()) {
            return
        }

        this.startEdit(new TranslatableString('undoableAction', 'Add ottava'))
        this.score().cmdAddOttava(type)
        this.apply()
    }

    addHairpinsToSelection(type: HairpinType): void {
        if (this.score().selection().isNone()) {
            return
        }

        this.startEdit(new TranslatableString('undoableAction', 'Add hairpin'))
        const hairpins = this.score().addHairpins(type)
        this.apply()

        if (!this.noteInput().isNoteInputMode() && hairpins.length === 1) {
            const segment = hairpins[0].frontSegment()
            if (segment) {
                this.select([segment], SelectType.SINGLE)
            }
            // TODO(port): startEditGrip(segment, Grip::END)
        }
    }

    canAddTupletToSelectedChordRests(): boolean {
        for (const chordRest of this.score().getSelectedChordRests()) {
            if (chordRest.isGrace() || (chordRest.isChord() && (chordRest as unknown as Chord).isTrillCueNote())) {
                continue
            }

            if (chordRest.durationType().lt(new TDurationValue(DurationType.V_512TH))
                && !chordRest.durationType().equals(new TDurationValue(DurationType.V_MEASURE))) {
                return false
            }
        }

        return true
    }

    addTupletToSelectedChordRests(options: TupletOptions): void {
        if (this.score().selection().isNone()) {
            return
        }

        this.startEdit(new TranslatableString('undoableAction', 'Add tuplet'))

        for (const chordRest of this.score().getSelectedChordRests()) {
            if (!chordRest.isGrace() && !(chordRest.isChord() && (chordRest as unknown as Chord).isTrillCueNote())) {
                let ratio = options.ratio
                if (options.autoBaseLen) {
                    ratio = new Fraction(ratio.numerator(), Tuplet.computeTupletDenominator(ratio.numerator(), chordRest.ticks()))
                }
                this.score().addTuplet(chordRest, ratio, options.numberType, options.bracketType)
            }
        }

        this.apply()
    }

    addBeamToSelectedChordRests(mode: BeamMode): void {
        if (this.score().selection().isNone()) {
            return
        }

        this.startEdit(new TranslatableString('undoableAction', 'Set beam type'))
        this.score().cmdSetBeamMode(mode)
        this.apply()
    }

    addGraceNotesToSelectedNotes(type: GraceNoteType): void {
        if (this.score().selection().isNone()) {
            return
        }

        let denominator = 1

        switch (type) {
        case GraceNoteType.GRACE4:
        case GraceNoteType.INVALID:
        case GraceNoteType.NORMAL:
            denominator = 1
            break
        case GraceNoteType.ACCIACCATURA:
        case GraceNoteType.APPOGGIATURA:
        case GraceNoteType.GRACE8_AFTER:
            denominator = 2
            break
        case GraceNoteType.GRACE16:
        case GraceNoteType.GRACE16_AFTER:
            denominator = 4
            break
        case GraceNoteType.GRACE32:
        case GraceNoteType.GRACE32_AFTER:
            denominator = 8
            break
        }

        this.startEdit(new TranslatableString('undoableAction', 'Add grace note'))
        this.score().cmdAddGrace(type, Constants.DIVISION / denominator)
        this.apply()
    }

    addIntervalToSelectedNotes(interval: number): void {
        if (!isNotesIntervalValid(interval)) {
            return
        }

        let notes: Note[] = []

        const score = this.score()
        if (score.selection().isRange()) {
            const hasMultiNoteChords = score.selection().rangeContainsMultiNoteChords()
            for (const chordRest of score.getSelectedChordRests()) {
                if (!chordRest.isChord()) {
                    continue
                }
                const chord = chordRest as unknown as Chord
                const nl = chord.notes()
                if (interval > 0) {
                    for (let noteIdx = nl.length; noteIdx > 0; --noteIdx) {
                        if (score.selectionFilter().canSelectNoteIdx(noteIdx - 1, nl.length, hasMultiNoteChords)) {
                            notes.push(nl[noteIdx - 1])
                            break
                        }
                    }
                } else {
                    for (let noteIdx = 0; noteIdx < nl.length; ++noteIdx) {
                        if (score.selectionFilter().canSelectNoteIdx(noteIdx, nl.length, hasMultiNoteChords)) {
                            notes.push(nl[noteIdx])
                            break
                        }
                    }
                }
            }
        } else {
            notes = score.selection().noteList()
        }

        if (!notes.length) {
            NoteInputMScore.setError(NoteInputMsError.NO_NOTE_SELECTED)
            this.checkAndShowError()
            return
        }

        this.startEdit(new TranslatableString('undoableAction', 'Add interval'))
        score.addInterval(interval, notes)
        this.apply()
    }

    addLaissezVibToSelection(): void {
        // Calls `startEdit` internally
        this.score().cmdToggleLaissezVib()

        this.notifyAboutNotationChanged()
    }

    /** C++ toggleArticulation(SymId): the palette's toggle of an articulation (bowing actions) */
    toggleArticulation(symId: SymId): void {
        this.startEdit(new TranslatableString('undoableAction', 'Toggle articulation'))
        this.score().toggleArticulation(symId)
        this.apply()
    }

    toggleArticulationForSelection(articulationSymbolId: SymId): void {
        if (this.score().selection().isNone()) {
            return
        }

        const notes = this.score().selection().noteList()
        if (!notes.length) {
            // no notes, but maybe they have an articulation selected. we should use that chord
            const e = this.score().selection().element()
            if (e && e.isArticulationFamily()) {
                const c = e.explicitParent() as unknown as Chord | null
                if (c) {
                    notes.unshift(...c.notes())
                }
            }
        }

        const updateMode = this.notesHaveActiculation(notes, articulationSymbolId)
            ? ArticulationsUpdateMode.Remove : ArticulationsUpdateMode.Insert

        const chords = new Set<Chord>()
        for (const note of notes) {
            if (note.isTrillCueNote()) {
                return
            }
            chords.add(note.chord())
        }

        this.startEdit(new TranslatableString('undoableAction', 'Toggle articulation'))
        for (const chord of chords) {
            chord.updateArticulations(new Set([articulationSymbolId]), updateMode)
        }
        this.apply()
    }

    private notesHaveActiculation(notes: readonly Note[], articulationSymbolId: SymId): boolean {
        for (const note of notes) {
            const chord = note.chord()

            let chordArticulations = chord.articulationSymbolIds()
            chordArticulations = flipArticulations(chordArticulations, PlacementV.ABOVE)
            chordArticulations = splitArticulations(chordArticulations)

            if (!chordArticulations.has(articulationSymbolId)) {
                return false
            }
        }

        return true
    }

    // =================================================================================================================
    //   (end of the note input section)
    // =================================================================================================================

    // ---------------------------------------------------------------------------------
    // editing commands
    // ---------------------------------------------------------------------------------

    /** C++ execute(&Score::f, ..., actionName) */
    private execute(f: () => void, actionName: TranslatableString): void {
        this.startEdit(actionName)
        f()
        this.apply()
    }

    toggleLayoutBreakAvailable(): boolean {
        return !this.score().selection().isNone() && !this.isTextEditingStarted()
    }

    toggleLayoutBreak(breakType: LayoutBreakType): void {
        this.startEdit(new TranslatableString('undoableAction', 'Toggle layout break'))
        this.score().cmdToggleLayoutBreak(breakType)
        this.apply()
    }

    addBracketsToSelection(type: BracketsType): void {
        if (this.score().selection().isNone()) {
            return
        }

        switch (type) {
        case BracketsType.Brackets:
            this.startEdit(new TranslatableString('undoableAction', 'Add brackets'))
            this.score().cmdAddBracket()
            this.apply()
            break
        case BracketsType.Braces:
            this.startEdit(new TranslatableString('undoableAction', 'Add braces'))
            this.score().cmdAddBraces()
            this.apply()
            break
        case BracketsType.Parentheses:
            this.startEdit(new TranslatableString('undoableAction', 'Add parentheses'))
            this.score().cmdToggleParentheses()
            this.apply()
            break
        }
    }

    toggleVisible(): void {
        this.startEdit(new TranslatableString('undoableAction', 'Toggle visible'))
        this.score().cmdToggleVisible()
        this.apply()
    }

    movePitch(d: MoveDirection, mode: UpDownMode): void {
        if (d !== MoveDirection.Up && d !== MoveDirection.Down) {
            return
        }

        const el = this.score().selection().element()
        if (el && el.isRest()) {
            this.startEdit(new TranslatableString('undoableAction', 'Change vertical position'))
            this.score().cmdMoveRest(el as unknown as Rest, d === MoveDirection.Up ? DirectionV.UP : DirectionV.DOWN)
        } else {
            this.startEdit(new TranslatableString('undoableAction', 'Change pitch'))
            this.score().upDown(d === MoveDirection.Up, mode)
        }

        this.apply()
    }

    deleteSelection(): void {
        if (this.score().selection().isNone()) {
            return
        }

        this.startEdit(new TranslatableString('undoableAction', 'Delete'))

        if (this.isTextEditingStarted()) {
            const textBase = this.m_editData.element as unknown as TextBase
            if (!textBase.deleteSelectedText(this.m_editData)) {
                this.m_editData.key = KeyboardKey.Key_Backspace
                this.m_editData.modifiers = 0
                textBase.edit(this.m_editData)
            }
        } else {
            this.doEndEditElement()
            this.resetGripEdit()
            this.score().cmdDeleteSelection()
        }

        this.checkAndShowError()
        this.apply()
        this.resetHitElementContext()
    }

    flipSelection(): void {
        if (this.score().selection().isNone()) {
            return
        }

        this.startEdit(new TranslatableString('undoableAction', 'Flip direction'))
        this.score().cmdFlip()
        this.apply()

        this.updateGripAnchorLines()
    }

    addTieToSelection(): void {
        // Calls `startEdit` internally
        this.score().cmdToggleTie()

        // TODO(port): select and edit a new tie with jump points (repeats)
        this.notifyAboutNotationChanged()
    }

    addTiedNoteToChord(): void {
        // Calls `startEdit` internally
        this.score().cmdAddTie(true)

        this.notifyAboutNotationChanged()
    }

    putRestToSelection(): void {
        const is = this.score().inputState()
        if (!is.duration().isValid() || is.duration().isZero() || is.duration().isMeasure()) {
            is.setDuration(DurationType.V_QUARTER)
        }

        if (!this.m_noteInput.isNoteInputMode()) {
            this.m_noteInput.startNoteInput(NotationConfiguration.defaultNoteInputMethod())
        }

        if (is.usingNoteEntryMethod(NoteEntryMethod.BY_DURATION) || is.usingNoteEntryMethod(NoteEntryMethod.RHYTHM)) {
            this.m_noteInput.padNote(Pad.REST)
        } else if (is.usingNoteEntryMethod(NoteEntryMethod.REPITCH)) {
            const cr = is.cr()
            if (cr) {
                const duration = cr.durationType()
                if (duration.isValid() && !duration.isZero()) {
                    if (duration.isMeasure()) {
                        is.moveToNextInputPos()
                    } else {
                        this.putRest(duration)
                    }
                }
            }
        } else {
            this.putRest(is.duration())
        }
    }

    putRest(duration: TDuration): void {
        if (this.score().selection().isNone()) {
            return
        }

        // Calls `startEdit` internally
        this.score().cmdEnterRest(duration)

        this.notifyAboutNotationChanged()
    }

    toggleAccidentalForSelection(type: AccidentalType): void {
        if (this.score().selection().isNone()) {
            return
        }

        let accidentalAlreadyAdded = false
        for (const item of this.score().selection().elements()) {
            if (!item.isNote()) {
                continue
            }

            if ((item as unknown as Note).accidentalType() !== type) {
                accidentalAlreadyAdded = false
                break
            }

            accidentalAlreadyAdded = true
        }

        this.startEdit(new TranslatableString('undoableAction', 'Toggle accidental'))

        if (accidentalAlreadyAdded) {
            this.score().changeAccidental(AccidentalType.NONE)
        } else {
            this.score().changeAccidental(type)
        }

        this.apply()
    }

    changeAccidental(accidental: AccidentalType): void {
        this.execute(() => this.score().changeAccidental(accidental), new TranslatableString('undoableAction', 'Add accidental'))
    }

    /**
     * C++ selectInstrument(): MuseScore asks for the new instrument with its instrument dialog (synchronously); here
     * the instrument comes from the select instrument provider (setSelectInstrumentProvider), e.g. the instrument the
     * app asked for before the command. Without one (or null) the instrument change is not added.
     */
    selectInstrument(instrumentChange: InstrumentChange | null): boolean {
        if (!instrumentChange) {
            return false
        }

        const templ = s_selectInstrumentProvider ? s_selectInstrumentProvider() : null
        if (!templ) {
            return false
        }

        const newInstrument = Instrument.fromTemplate(templ)
        instrumentChange.setInit(true)
        instrumentChange.setupInstrument(newInstrument)

        if (newInstrument.useDrumset()) {
            this.cleanupDrumsetChanges(instrumentChange)
        }

        return true
    }

    private cleanupDrumsetChanges(instrumentChange: InstrumentChange | null): void {
        const part = instrumentChange ? instrumentChange.part() : null
        const newInstrument = instrumentChange ? instrumentChange.instrument() : null
        if (!part || !newInstrument) {
            return
        }

        for (const otherInst of part.instruments().values()) {
            if (!otherInst || otherInst === newInstrument) {
                continue
            }

            // If the following conditional is true, it means that we're trying to change to a drumset that already exists for this part. Due to the fact
            // that we don't create new tracks for identical instruments in a given part, the knock-on effect is that the new drumset won't have a chance
            // to load a MuseSampler patch (see usage of shouldLoadDrumset in PlaybackController). The following logic resolves this by copying the patch
            // from the existing drumset into the new one...
            if (otherInst.drumset() && newInstrument.id() === otherInst.id()) {
                this.score().undo(new ChangeDrumset(newInstrument, otherInst.drumset()!, part))
                return
            }
        }
    }

    transpose(options: TransposeOptions): boolean {
        this.startEdit(new TranslatableString('undoableAction', 'Transposition'))

        const ok = Transpose.transpose(this.score(), options.mode, options.direction, options.key, options.interval,
            options.needTransposeKeys, options.needTransposeChordNames, options.needTransposeDoubleSharpsFlats)

        this.apply()

        return ok
    }

    transposeSemitone(steps: number): void {
        this.startEdit(new TranslatableString('undoableAction', 'Transpose semitone'))
        Transpose.transposeSemitone(this.score(), steps)
        this.apply()
    }

    transposeDiatonicAlterations(direction: TransposeDirection): void {
        this.startEdit(new TranslatableString('undoableAction', 'Transpose diatonically'))
        Transpose.transposeDiatonicAlterations(this.score(), direction)
        this.apply()
    }

    toggleDotsForSelection(dots: Pad): void {
        if (dots < Pad.DOT || dots > Pad.DOT4) {
            return
        }

        if (this.score().selection().isNone()) {
            return
        }

        this.startEdit(new TranslatableString('undoableAction', 'Toggle augmentation dots'))
        this.score().padToggle(dots, true /*toggleForSelectionOnly*/)
        this.apply()
    }

    increaseDecreaseDuration(steps: number, stepByDots: boolean): void {
        if (this.score().selection().isNone()) {
            return
        }

        this.startEdit(steps > 0 // negative: increase, positive: decrease
            ? new TranslatableString('undoableAction', 'Decrease duration')
            : new TranslatableString('undoableAction', 'Increase duration'))
        this.score().cmdIncDecDuration(steps, stepByDots)
        this.apply()
    }

    changeSelectedElementsVoice(voiceIndex: voice_idx_t): void {
        if (this.score().selection().isNone()) {
            return
        }

        if (voiceIndex >= VOICES) {
            return
        }

        this.startEdit(new TranslatableString('undoableAction', 'Change voice'))
        this.score().changeSelectedElementsVoice(voiceIndex)
        this.apply()
    }

    /**
     * C++ AbstractInspectorModel::setPropertyValue: sets the property of the items (a styled property becomes
     * unstyled) as one undoable command "Edit <property>". The value is in element units.
     */
    changeProperty(items: readonly EngravingItem[], pid: Pid, value: PropertyValue): void {
        if (!items.length) {
            return
        }

        this.startEdit(new TranslatableString('undoableAction', 'Edit %1').arg(propertyUserName(pid)))

        for (const item of items) {
            let ps = item.propertyFlags(pid)

            if (ps === PropertyFlags.STYLED) {
                ps = PropertyFlags.UNSTYLED
            }

            item.undoChangeProperty(pid, value, ps)
        }

        this.apply()
    }

    /** C++ AbstractInspectorModel::resetPropertyValue */
    resetProperty(items: readonly EngravingItem[], pid: Pid): void {
        if (!items.length) {
            return
        }

        this.startEdit(new TranslatableString('undoableAction', 'Reset %1').arg(propertyUserName(pid)))

        for (const item of items) {
            item.undoResetProperty(pid)
        }

        this.apply()
    }

    // ---------------------------------------------------------------------------------
    // hit testing (positions in canvas coordinates)
    // ---------------------------------------------------------------------------------

    point2page(p: PointF, useNearestPage = false): Page | null {
        if (this.score().linearMode()) {
            return this.score().pages().length ? this.score().pages()[0] : null
        }

        let shortestDistance = Number.MAX_VALUE
        let nearestPage: Page | null = null
        for (const page of this.score().pages()) {
            const pageRect = page.ldata().bbox().translated(page.pos())
            if (pageRect.contains(p)) {
                return page
            } else if (useNearestPage) {
                const d = rectDistanceTo(pageRect, p)
                if (d < shortestDistance) {
                    shortestDistance = d
                    nearestPage = page
                }
            }
        }
        return nearestPage
    }

    elementsAt(p: PointF): EngravingItem[] {
        const page = this.point2page(p)
        if (!page) {
            return []
        }

        const el = page.itemsAt(p.minus(page.pos()))
        if (el.length === 0) {
            return []
        }

        sortByElementIsLess(el)

        return el
    }

    elementAt(p: PointF): EngravingItem | null {
        const el = this.elementsAt(p)
        return el.length === 0 || el[el.length - 1].isPage() ? null : el[el.length - 1]
    }

    hitElement(pos: PointF, width: number): EngravingItem | null {
        const elements = this.hitElements(pos, width)
        if (elements.length === 0) {
            return null
        }
        this.m_lastElementHit = elements[elements.length - 1] // C++ m_selection->onElementHit()
        return elements[elements.length - 1]
    }

    /** C++ NotationSelection::lastElementHit() */
    lastElementHit(): EngravingItem | null { return this.m_lastElementHit }

    hitStaff(pos: PointF): Staff | null {
        return this.hitMeasure(pos).staff
    }

    hitElements(pos: PointF, width: number): EngravingItem[] {
        const page = this.point2page(pos)
        if (!page) {
            return []
        }

        const hitElements: EngravingItem[] = []

        const posOnPage = pos.minus(page.pos())

        if (this.isTextEditingStarted()) {
            const editW = width * 2
            const editHitRect = new RectF(posOnPage.x() - editW, posOnPage.y() - editW, 2.0 * editW, 2.0 * editW)
            if (this.m_editData.element!.intersects(editHitRect)) {
                hitElements.push(this.m_editData.element!)
                return hitElements
            }
        }

        const hitRect = new RectF(posOnPage.x() - width, posOnPage.y() - width, 3.0 * width, 3.0 * width)

        const potentiallyHitElements = page.items(hitRect)

        const canHitElement = (element: EngravingItem): boolean => {
            if (!element.selectable() || element.isPage()) {
                return false
            }

            if (element.isSoundFlag()) {
                return !(element as SoundFlag).shouldHide()
            } else if (!element.isInteractionAvailable()) {
                return false
            }

            return true
        }

        for (const element of potentiallyHitElements) {
            if (!canHitElement(element)) {
                continue
            }

            if (element.hitShapeContains(posOnPage)) {
                hitElements.push(element)
            }
        }

        if (hitElements.length === 0 || (hitElements.length === 1 && hitElements[0].isMeasure())) {
            //
            // if no relevant element hit, look nearby
            //
            for (const element of potentiallyHitElements) {
                if (!canHitElement(element)) {
                    continue
                }

                if (element.hitShapeIntersects(hitRect)) {
                    hitElements.push(element)
                }
            }
        }

        if (hitElements.length) {
            sortByElementIsLess(hitElements)
        } else {
            const measure = this.hitMeasure(pos).measure
            if (measure) {
                hitElements.push(measure)
            }
        }

        return hitElements
    }

    hitMeasure(pos: PointF): HitMeasureData {
        const res = this.score().pos2measure(pos)

        const result: HitMeasureData = { measure: null, staff: null }
        if (res && res.measure.staffLines(res.staffIdx).canvasHitShape().contains(pos)) {
            result.measure = res.measure
            result.staff = this.score().staff(res.staffIdx)
        }

        return result
    }

    static elementIsLess(e1: EngravingItem, e2: EngravingItem): boolean {
        if (e1.selectable() && !e2.selectable()) {
            return false
        }
        if (!e1.selectable() && e2.selectable()) {
            return true
        }
        if (e1.isNote() && (e2.isStem() || e2.isHook())) {
            return false
        }
        if (e2.isNote() && (e1.isStem() || e1.isHook())) {
            return true
        }
        if (e1.isStem() && e2.isHook()) {
            return false
        }
        if (e2.isStem() && e1.isHook()) {
            return true
        }
        if (e1.isText() && e2.isBox()) {
            return false
        }
        if (e1.isBox() && e2.isText()) {
            return true
        }
        if (e1.isImage() && e2.isBox()) {
            return false
        }
        if (e1.isBox() && e2.isImage()) {
            return true
        }
        if ((e1.isHarmony() || e1.isFretDiagram()) && e2.isFBox()) {
            return false
        }
        if (e1.isFBox() && (e2.isHarmony() || e2.isFretDiagram())) {
            return true
        }
        if (e1.z() === e2.z()) {
            // same stacking order, prefer non-hidden elements
            if (e1.type() === e2.type()) {
                if (e1.isNoteDot()) {
                    const n1 = e1 as unknown as NoteDot
                    const n2 = e2 as unknown as NoteDot
                    if (n1.note() && n1.note()!.hidden()) {
                        return false
                    } else if (n2.note() && n2.note()!.hidden()) {
                        return true
                    }
                } else if (e1.isNote()) {
                    const n1 = e1 as unknown as Note
                    const n2 = e2 as unknown as Note
                    if (n1.hidden()) {
                        return false
                    } else if (n2.hidden()) {
                        return true
                    }
                }
            }
            // different types, or same type but nothing hidden - use track
            return e1.track() < e2.track()
        }

        // default case, use stacking order
        return e1.z() < e2.z()
    }

    // ---------------------------------------------------------------------------------
    // selection
    // ---------------------------------------------------------------------------------

    /**
     * controlModifier: C++ checks QGuiApplication::keyboardModifiers() == Qt::ControlModifier in doSelect (ctrl+click
     * on a selected element deselects it)
     */
    /** selects the chord/rest at tick in the last selected staff and voice (pause-and-select) */
    findAndSelectChordRest(tick: Fraction): void {
        const startSeg = this.score().tick2leftSegment(tick, /*useMMrest*/ false, SegmentType.ChordRest)
        if (!startSeg || !startSeg.isChordRestType()) {
            return
        }

        const selection = this.score().selection()
        let lastSelectedStaffIdx = 0
        let lastSelectedVoiceIdx = 0
        if (selection.isRange()) {
            lastSelectedStaffIdx = selection.staffStart()
        } else if (selection.elements().length) {
            const lastSelectedItem = selection.elements()[selection.elements().length - 1]
            if (lastSelectedItem) {
                lastSelectedStaffIdx = lastSelectedItem.staffIdx()
                lastSelectedVoiceIdx = lastSelectedItem.voice()
            }
        }

        // startSeg could be a CR segment in any staff. The idea of this method is to select the CR in the last selected
        // staff (or the top staff if none was selected). The following outer loop iterates backwards through previous CR
        // segments until a valid CR is found in the desired staff...
        let toSelect: EngravingItem | null = null
        for (let currSeg: Segment | null = startSeg; currSeg && !toSelect; currSeg = currSeg.prev(SegmentType.ChordRest)) {
            toSelect = currSeg.element(staff2track(lastSelectedStaffIdx, lastSelectedVoiceIdx))
            if (toSelect && toSelect.isChordRest()) {
                break
            }
            toSelect = null
            // Inner loop: Couldn't find a valid CR in the last selected voice - try other voices in the same staff...
            for (let currVoice = 0; currVoice < VOICES; ++currVoice) {
                if (currVoice === lastSelectedVoiceIdx) {
                    // Already tried this...
                    continue
                }
                toSelect = currSeg.element(staff2track(lastSelectedStaffIdx, currVoice))
                if (toSelect && toSelect.isChordRest()) {
                    break
                }
                toSelect = null
            }
        }

        if (!toSelect) {
            return
        }

        const itemsToSelect: EngravingItem[] = toSelect.isChord() ? [...(toSelect as unknown as Chord).notes()] : [toSelect]

        this.select(itemsToSelect, SelectType.REPLACE)
    }

    select(elements: readonly EngravingItem[], type: SelectType, staffIndex: staff_idx_t = 0, controlModifier = false): boolean {
        const selection = this.score().selection()
        const oldSelectedElements = [...selection.elements()]
        const oldSelectionState = selection.state()

        const oldStartTick = selection.tickStart()
        const oldEndTick = selection.tickEnd()

        const oldStartStaff = selection.staffStart()
        const oldEndStaff = selection.staffEnd()

        this.doSelect(elements, type, staffIndex, controlModifier)

        let rangeChanged = false
        if (selection.isRange()) {
            const ticksChanged = !oldStartTick.eq(selection.tickStart()) || !oldEndTick.eq(selection.tickEnd())
            const stavesChanged = oldStartStaff !== selection.staffStart() || oldEndStaff !== selection.staffEnd()
            rangeChanged = ticksChanged || stavesChanged
        }

        const elementsChanged = oldSelectedElements.length !== selection.elements().length
            || oldSelectedElements.some((e, i) => e !== selection.elements()[i])
        if (rangeChanged || oldSelectionState !== selection.state() || elementsChanged) {
            return this.notifyAboutSelectionChangedIfNeed()
        } else {
            this.score().setSelectionChanged(false)
        }
        return false
    }

    private doSelect(elements: readonly EngravingItem[], type: SelectType, staffIndex: staff_idx_t, controlModifier: boolean): void {
        if (this.needEndTextEditing(elements)) {
            this.endEditText()
        } else if (this.needEndElementEditing(elements)) {
            this.endEditElement()
        }

        if (elements.length === 1 && type === SelectType.ADD && controlModifier) {
            if (this.score().selection().isRange()) {
                this.score().selection().setState(SelState.LIST)
            }

            if (elements[0].selected()) {
                this.score().deselect(elements[0])
                return
            }
        }

        if (type === SelectType.REPLACE) {
            this.score().deselectAll()
            type = SelectType.ADD
        }

        if (type === SelectType.SINGLE && elements.length === 1) {
            const element = elements[0]
            let segment: Segment | null = null

            if (element.isKeySig()) {
                segment = (element as unknown as KeySig).segment()
            } else if (element.isTimeSig()) {
                segment = (element as unknown as TimeSig).segment()
            }

            if (segment) {
                this.selectElementsWithSameTypeOnSegment(element.type(), segment)
                return
            }
        }

        this.score().select(elements, type, staffIndex)
    }

    private selectElementsWithSameTypeOnSegment(elementType: ElementType, segment: Segment): void {
        this.score().deselectAll()

        const elementsToSelect: EngravingItem[] = []

        for (let track: track_idx_t = 0; track < this.score().ntracks(); track += VOICES) {
            const element = segment.element(track)
            if (element && element.type() === elementType) {
                elementsToSelect.push(element)
            }
        }

        this.score().select(elementsToSelect, SelectType.ADD)
    }

    selectAll(): boolean {
        if (this.isTextEditingStarted()) {
            const textBase = this.m_editData.element as unknown as TextBase
            textBase.selectAll(textBase.cursorFromEditData(this.m_editData))
            this.notifyAboutTextEditingChanged()
            return true
        }
        this.score().cmdSelectAll()

        return this.notifyAboutSelectionChangedIfNeed()
    }

    selectFirstElement(frame = true): boolean {
        const element = this.score().firstElement(frame)
        if (element) {
            return this.select([element], SelectType.SINGLE, element.staffIdx())
        }
        return false
    }

    selectLastElement(): boolean {
        const element = this.score().lastElement()
        if (element) {
            return this.select([element], SelectType.SINGLE, element.staffIdx())
        }
        return false
    }

    clearSelection(): boolean {
        if (this.isEditingElement()) {
            this.endEditElement()
        }

        if (this.isDragStarted()) {
            this.doEndDrag()
            this.rollback()
            this.notifyAboutNotationChanged()
        }

        if (this.score().selection().isNone()) {
            return false
        }

        this.score().deselectAll()

        const changed = this.notifyAboutSelectionChangedIfNeed()

        this.setHitElementContext({ element: null, staff: null })
        return changed
    }

    /** Left/Right of the notation view (Score::move: next/prev-chord, measure, track) */
    moveSelection(d: MoveDirection, type: MoveSelectionType): boolean {
        if (type === MoveSelectionType.EngravingItem) {
            return this.moveElementSelection(d)
        }

        if (type === MoveSelectionType.String) {
            // TODO(port): moveStringSelection
            return false
        }

        const typeToString = (t: MoveSelectionType): string => {
            switch (t) {
            case MoveSelectionType.Chord: return 'chord'
            case MoveSelectionType.Measure: return 'measure'
            case MoveSelectionType.Track: return 'track'
            case MoveSelectionType.Frame: return 'frame'
            case MoveSelectionType.System: return 'system'
            default: return ''
            }
        }

        let cmd = ''
        if (d === MoveDirection.Left) {
            cmd = 'prev-'
        } else if (d === MoveDirection.Right) {
            cmd = 'next-'
        }

        cmd += typeToString(type)

        this.score().move(cmd)

        return this.notifyAboutSelectionChangedIfNeed()
    }

    /** Alt+Left/Right (next-element/prev-element) */
    moveElementSelection(d: MoveDirection): boolean {
        let el = this.score().selection().element()
        if (!el && this.score().selection().elements().length) {
            el = this.score().selection().elements()[this.score().selection().elements().length - 1]
        }

        // TODO(port): text editing (navigateToNearText), horizontal layouts (skip VBoxes)
        const isLeftDirection = MoveDirection.Left === d

        let toEl: EngravingItem | null = null

        if (el) {
            // TODO(port): Score::prevElement() / nextElement()
            return false
        } else {
            // Nothing currently selected (e.g. because user pressed Esc or clicked on
            // an empty region of the page). Try to restore previous selection.
            const cr = this.score().selection().currentCR()
            if (cr) {
                el = cr.isChord() ? (cr as unknown as Chord).upNote() : cr
            }
            if (el) {
                toEl = el // Restoring previous selection.
            } else {
                toEl = isLeftDirection ? this.score().lastElement() : this.score().firstElement()
            }
        }

        if (!toEl) {
            return false
        }

        return this.select([toEl], SelectType.REPLACE)
    }

    /** shift+arrows: extend the range */
    addToSelection(d: MoveDirection, type: MoveSelectionType): boolean {
        const cr = activeCr(this.score())
        if (!cr) {
            return false
        }
        let el: ChordRest | null = null
        switch (type) {
        case MoveSelectionType.Chord: {
            // ChordRestNavigateOptions.skipGrace = true
            if (d === MoveDirection.Right) {
                el = nextChordRest(cr, true)
            } else {
                el = prevChordRest(cr, true)
            }
            break
        }
        case MoveSelectionType.Measure:
            if (d === MoveDirection.Right) {
                el = this.score().nextMeasure(cr, true, true)
            } else {
                el = this.score().prevMeasure(cr, true)
            }
            break
        case MoveSelectionType.Track:
            if (d === MoveDirection.Up) {
                el = this.score().upStaff(cr)
            } else {
                el = this.score().downStaff(cr)
            }
            break
        default:
            break
        }

        if (el) {
            return this.select([el], SelectType.RANGE, el.staffIdx())
        }
        return false
    }

    expandSelection(mode: ExpandSelectionMode): boolean {
        const cr = activeCr(this.score())
        if (!cr) {
            return false
        }
        let el: ChordRest | null = null
        switch (mode) {
        case ExpandSelectionMode.BeginSystem: {
            const measure = cr.segment().measure().system()!.firstMeasure()
            if (measure) {
                el = measure.first()!.nextChordRest(cr.track())
            }
            break
        }
        case ExpandSelectionMode.EndSystem: {
            const measure = cr.segment().measure().system()!.lastMeasure()
            if (measure) {
                el = measure.last()!.nextChordRest(cr.track(), true)
            }
            break
        }
        case ExpandSelectionMode.BeginScore: {
            const measure = this.score().firstMeasureMM()
            if (measure) {
                el = measure.first()!.nextChordRest(cr.track())
            }
            break
        }
        case ExpandSelectionMode.EndScore: {
            const measure = this.score().lastMeasureMM()
            if (measure) {
                el = measure.last()!.nextChordRest(cr.track(), true)
            }
            break
        }
        }

        if (el) {
            return this.select([el], SelectType.RANGE, el.staffIdx())
        }
        return false
    }

    /** Alt+Up/Down (up-chord/down-chord) */
    moveChordNoteSelection(d: MoveDirection): boolean {
        const current = this.score().selection().element()
        if (!current || !(current.isNote() || current.isRest())) {
            return false
        }

        const chordElem = d === MoveDirection.Up ? this.score().upAlt(current) : this.score().downAlt(current)

        if (!chordElem || chordElem === current) {
            return false
        }

        return this.select([chordElem], SelectType.SINGLE, chordElem.staffIdx())
    }

    /** Ctrl+Alt+Up/Down (top-chord/bottom-chord) */
    selectTopOrBottomOfChord(d: MoveDirection): boolean {
        const current = this.score().selection().element()
        if (!current || !current.isNote()) {
            return false
        }

        const note = current as unknown as Note
        const target = d === MoveDirection.Up ? this.score().upAltCtrl(note) : this.score().downAltCtrl(note)

        if (target === current) {
            return false
        }

        return this.select([target], SelectType.SINGLE)
    }

    /**
     * C++ drawSelectionRange (painted by the notation view after the score). The painter draws in canvas coordinates;
     * scaling: device pixels per canvas unit (C++ currentScaling(painter)).
     */
    drawSelectionRange(painter: Painter, scaling: number): void {
        const selection = this.score().selection()
        if (!selection.isRange()) {
            return
        }

        painter.setBrush(BrushStyle.NoBrush)

        const selectionColor = EngravingConfiguration.selectionColor()
        let penWidth = 3.0 / scaling
        const minPenWidth = 0.20 * selection.startSegment()!.measure().spatium() // measureRange().startMeasure
        penWidth = Math.max(penWidth, minPenWidth)

        const pen = new Pen(selectionColor, penWidth, PenStyle.SolidLine)
        painter.setPen(pen)

        const rangeArea = this.rangeBoundingArea()
        for (const rect of rangeArea) {
            const path = new PainterPath()
            path.addRoundedRect(rect, 4, 4)

            const fillColor = selectionColor.clone()
            fillColor.setAlpha(10)
            painter.fillPath(path, new Brush(fillColor))
            painter.drawPath(path)
        }
    }

    // ---------------------------------------------------------------------------------
    // NotationSelectionRange
    // ---------------------------------------------------------------------------------

    /** the rectangles of a range selection (canvas coordinates), C++ NotationSelectionRange::boundingArea */
    rangeBoundingArea(): RectF[] {
        const selection = this.score().selection()
        if (!selection.isRange()) {
            return []
        }
        return ScoreRangeUtilities.boundingArea(this.score(), this.rangeStartSegment(), this.rangeEndSegment(),
            selection.staffStart(), selection.staffEnd())
    }

    rangeContainsPoint(point: PointF): boolean {
        return this.rangeBoundingArea().some(area => area.contains(point))
    }

    /** When `item` is a Measure, use `staffIdx` to query whether a specific staff is contained in the selection. */
    rangeContainsItem(item: EngravingItem, staffIdx: staff_idx_t): boolean {
        const selection = this.score().selection()
        const itemTick = item.tick()
        const selectionStartTick = selection.tickStart()
        const selectionEndTick = selection.tickEnd()

        if (itemTick.lt(selectionStartTick) || itemTick.ge(selectionEndTick)) {
            return false
        }

        if (item.isMeasure()) {
            if (staffIdx !== nidx) {
                return selection.staffStart() <= staffIdx && staffIdx < selection.staffEnd()
            }

            return true
        }

        const itemTrack = item.track()
        const selectionStartTrack = VOICES * selection.staffStart()
        const selectionEndTrack = VOICES * (selection.staffEnd() - 1) + VOICES

        return itemTrack >= selectionStartTrack && itemTrack < selectionEndTrack
    }

    private rangeStartSegment(): Segment | null {
        let startSegment = this.score().selection().startSegment()

        if (!startSegment) {
            return null
        }

        if (!startSegment.enabled()) {
            startSegment = startSegment.next1MMenabled()
            if (!startSegment) {
                return null
            }
        }

        if (!startSegment.measure().system()) {
            const mmr = startSegment.measure().coveringMMRestOrThis()
            if (!mmr || mmr.system()) {
                return null
            }
            startSegment = mmr.first(SegmentType.ChordRest)
        }

        return startSegment
    }

    private rangeEndSegment(): Segment | null {
        let endSegment = this.score().selection().endSegment()

        if (endSegment && !endSegment.enabled()) {
            endSegment = endSegment.next1MMenabled()
        }

        if (!endSegment) {
            endSegment = this.score().lastSegmentMM()
        }

        return endSegment
    }

    // =================================================================================================================
    //   palette elements and drop (applyPaletteElement, applyPaletteElementToList/Range, drop): filled by the palette
    //   drop port; the other editing methods go above this section
    // =================================================================================================================

    /**
     * Applies a palette element to the selection (C++ Palette::applyPaletteElement). modifiers: KeyboardModifier
     * flags (editing/editdata.ts), e.g. Control to apply a key/time signature to one staff only, Shift to add a
     * drum note to the chord. Returns false if there is no selection.
     */
    applyPaletteElement(element: EngravingItem, modifiers = 0): boolean {
        const score = this.score()

        // make a copy of selection state before applying the operation
        if (score.selection().isNone()) {
            return false
        }
        const sel = paletteSelection(score.selection())

        this.startEdit(new TranslatableString('undoableAction', 'Apply palette element: %1').arg(element.typeUserName().translated()))

        try {
            if (sel.isList()) {
                this.applyPaletteElementToList(element, score, sel, modifiers)
            } else if (sel.isRange()) {
                this.applyPaletteElementToRange(element, score, sel, modifiers)
            }
        } catch (err) {
            // the port throws for not ported parts (e.g. rewriting measures for a new time signature)
            this.rollback()
            throw err
        }

        score.setSelectionChanged(true)
        this.apply()
        this.notifyAboutSelectionChangedIfNeed()

        this.checkAndShowError()

        return true
    }

    private applyPaletteElementToList(element: EngravingItem, score: Score, sel: PaletteSelection, modifiers: number): void {

        const cr1 = sel.firstChordRest()
        const cr2 = sel.lastChordRest()
        let addSingle = false // add a single line only
        if (cr1 && cr2 === cr1) {
            // one chordrest selected, ok to add line
            addSingle = true
        } else if (sel.elements().length === 2 && cr1 && cr2 && cr1 !== cr2) {
            // two chordrests selected
            // must be on same staff in order to add line, except for slur
            if (element.isSlur() || cr1.staffIdx() === cr2.staffIdx()) {
                addSingle = true
            }
        }

        // TODO(port): drum notes from the drumset palette in note input (isEntryDrumStaff() && element->isChord()),
        // action icons (system lock, parentheses), glissandos/bends between two notes (applyLineNoteToNote)

        if (element.isLayoutBreak()) {
            score.cmdToggleLayoutBreak((element as unknown as LayoutBreak).layoutBreakType())
            return
        }

        if (element.isSlur()) {
            this.doAddSlur(element as unknown as Slur)
            return
        }

        if (element.isSLine() && !element.isGlissando() && !element.isGuitarBend() && addSingle) {
            const startSegment = cr1!.segment()
            let endSegment: Segment | null
            if (element.type() === ElementType.PEDAL && cr2 !== cr1) {
                endSegment = cr2!.segment().nextCR(cr2!.track())
            } else {
                // Ensure that list-selection results in the same endSegment as range selection
                endSegment = cr2!.nextSegmentAfterCR(SegmentType.ChordRest | SegmentType.EndBarLine | SegmentType.Clef)
            }
            const spanner = element.clone() as unknown as Spanner
            spanner.setScore(score)
            spanner.styleChanged()
            if (spanner.isHairpin()) {
                score.addHairpin(spanner as unknown as Hairpin, cr1!, cr2)
                // TODO(port): select the front segment and start editing it
            } else {
                const firstStaffOnly = isSystemTextLine(element) && !(modifiers & KeyboardModifier.ControlModifier)
                const targetStaff = firstStaffOnly ? 0 : cr1!.staffIdx()
                score.cmdAddSpanner(spanner, targetStaff, startSegment, endSegment, (modifiers & KeyboardModifier.ControlModifier) !== 0)
            }
            // TODO(port): setInitialTrackAndVoiceAssignment (voice assignment of spanners)
            return
        }

        if (element.isArticulationFamily() && sel.elements().length === 1) {
            // understand adding an articulation to another articulation as adding it to the chord it's attached to
            const e = sel.elements()[0]
            if (e.isArticulationFamily()) {
                const p = e.explicitParent()
                if (p && p.isChord()) {
                    this.applyDropPaletteElement(score, (p as unknown as Chord).notes()[0], element, modifiers)
                }
            } else {
                this.applyDropPaletteElement(score, e, element, modifiers)
            }
            return
        }

        if ((element.isClef() || element.isTimeSig() || element.isKeySig()) && score.noteEntryMode()) {
            // in note input mode place clef / time sig / key sig before cursor
            let e: EngravingItem | null = score.inputState().cr()
            if (!e) {
                e = sel.elements()[0]
            } else if (e.isChord()) {
                e = (e as unknown as Chord).notes()[0]
            }
            this.applyDropPaletteElement(score, e, element, modifiers)
            return
        }

        const { elements: targetElements } = filterTargetElements(sel, element)

        for (const target of targetElements) {
            this.applyDropPaletteElement(score, target, element, modifiers)
        }
    }

    private applyPaletteElementToRange(element: EngravingItem, score: Score, sel: PaletteSelection, modifiers: number): void {
        const elementType = element.type()

        const { elements: targetElements, unique: isMeasureAnchoredElement } = filterTargetElements(sel, element)
        if (isMeasureAnchoredElement) {
            if (elementType === ElementType.BAR_LINE) {
                // In a range selection, add barlines to all selected measures
                for (const target of targetElements) {
                    this.applyDropPaletteElement(score, target.findMeasure(), element, modifiers, target.track())
                }
            } else {
                for (const target of targetElements) {
                    this.applyDropPaletteElement(score, target, element, modifiers)
                }
            }
            return
        }

        if (elementType === ElementType.LAYOUT_BREAK) {
            score.cmdToggleLayoutBreak((element as unknown as LayoutBreak).layoutBreakType())
            return
        }

        if (element.isClef() || element.isKeySig() || element.isTimeSig()) {
            const m1 = sel.startSegment()!.measure()
            let m2: Measure | null = sel.endSegment() ? sel.endSegment()!.measure() : null
            if (m2 === m1 && sel.startSegment()!.rtick().isZero()) {
                m2 = null // don't restore original if one full measure selected
            } else if (m2) {
                m2 = m2.nextMeasureMM()
            }
            // Clefs always apply to every selected staff, key and time signatures only when added locally
            const applyToEachStaff = element.isClef() || (modifiers & KeyboardModifier.ControlModifier) !== 0
            const staffIdx1 = sel.staffStart()
            const staffIdx2 = applyToEachStaff ? sel.staffEnd() : staffIdx1 + 1
            for (let i = staffIdx1; i < staffIdx2; ++i) {
                // For clefs, use mid-measure changes if appropriate
                // Mid-measure key signature changes are done via list selections
                let e1: EngravingItem | null = null
                let e2: EngravingItem | null = null
                if (element.isClef()) {
                    if (sel.startSegment()!.isChordRestType() && sel.startSegment()!.rtick().isNotZero()) {
                        const cr = sel.startSegment()!.nextChordRest(staff2track(i))
                        e1 = cr && cr.isChord() ? (cr as unknown as Chord).upNote() : cr
                    }
                    if (sel.endSegment() && sel.endSegment()!.segmentType() === SegmentType.ChordRest) {
                        const cr = sel.endSegment()!.nextChordRest(staff2track(i))
                        e2 = cr && cr.isChord() ? (cr as unknown as Chord).upNote() : cr
                    }
                }
                // restore clef/keysig/timesig that was in effect at end of selection
                if (m2 || e2) {
                    const staff = score.staff(i)!
                    const tick2 = sel.endSegment()!.tick()
                    let oelement: EngravingItem | null = null
                    switch (elementType) {
                    case ElementType.CLEF: {
                        const oclef = Factory.createItem(ElementType.CLEF, scoreDummy(score)) as Clef
                        oclef.setClefType(staff.clef(tick2))
                        oelement = oclef
                        break
                    }
                    case ElementType.KEYSIG: {
                        const okeysig = Factory.createItem(ElementType.KEYSIG, scoreDummy(score)) as KeySig
                        okeysig.setKeySigEvent(staff.keySigEvent(tick2))
                        const ck = okeysig.concertKey()
                        okeysig.setKey(ck)
                        oelement = okeysig
                        break
                    }
                    case ElementType.TIMESIG: {
                        const otimesig = Factory.createItem(ElementType.TIMESIG, scoreDummy(score)) as TimeSig
                        otimesig.setFrom(staff.timeSig(tick2)!)
                        oelement = otimesig
                        break
                    }
                    default:
                        break
                    }
                    if (oelement) {
                        if (e2) {
                            this.applyDropPaletteElement(score, e2, oelement, modifiers)
                        } else {
                            this.applyDropPaletteElement(score, m2, oelement, modifiers, staff2track(i))
                        }
                    }
                }
                // apply new clef/keysig/timesig
                if (e1) {
                    this.applyDropPaletteElement(score, e1, element, modifiers)
                } else {
                    this.applyDropPaletteElement(score, m1, element, modifiers, staff2track(i))
                }
            }
            return
        }

        if (element.isSlur()) {
            this.doAddSlur(element as unknown as Slur)
            return
        }

        if (element.isSLine() && elementType !== ElementType.GLISSANDO) {
            const startSegment = sel.startSegment()!
            const endSegment = sel.endSegment()
            const firstStaffOnly = isSystemTextLine(element) && !(modifiers & KeyboardModifier.ControlModifier)
            const startStaff = firstStaffOnly ? 0 : sel.staffStart()
            const endStaff = firstStaffOnly ? 1 : sel.staffEnd()
            for (let i = startStaff; i < endStaff; ++i) {
                const spanner = element.clone() as unknown as Spanner
                spanner.setScore(score)
                spanner.styleChanged()
                score.cmdAddSpanner(spanner, i, startSegment, endSegment, (modifiers & KeyboardModifier.ControlModifier) !== 0)
                // TODO(port): setInitialTrackAndVoiceAssignment
                this.selectAndStartEditIfNeeded(spanner)
            }
            return
        }

        if (element.isTextBase() && !element.isFingering() && !element.isSticking()) {
            const firstSegment = sel.startSegment()!
            const firstStaffIndex = sel.staffStart()
            const lastStaffIndex = sel.staffEnd()

            // A text should only be added at the start of the selection
            // There shouldn't be a text at each element
            if (element.systemFlag()) {
                this.applyDropPaletteElement(score, firstSegment.firstElementForNavigation(0), element, modifiers)
            } else {
                for (let staff = firstStaffIndex; staff < lastStaffIndex; staff++) {
                    this.applyDropPaletteElement(score, firstSegment.firstElementForNavigation(staff), element, modifiers)
                }
            }
            return
        }

        // TODO(port): action icons (system lock, parentheses, bends)

        const track1 = staff2track(sel.staffStart())
        const track2 = staff2track(sel.staffEnd())
        const startSegment = sel.startSegment()
        const endSegment = sel.endSegment() // keep it, it could change during the loop

        const rangeContainsMultiNoteChords = sel.rangeContainsMultiNoteChords()

        const applyDropPaletteElementToChord = (chord: Chord): void => {
            const notes = [...chord.notes()]
            const totalNotesInChord = notes.length
            for (let noteIdx = 0; noteIdx < totalNotesInChord; ++noteIdx) {
                const note = notes[noteIdx]
                if (!note || !score.selectionFilter().canSelectNoteIdx(noteIdx, totalNotesInChord, rangeContainsMultiNoteChords)) {
                    continue
                }
                this.applyDropPaletteElement(score, note, element, modifiers)
                if (!element.isAccidental() && !element.isNoteHead() && !element.isGlissando() && !element.isChordLine()) {
                    // Only need to apply to one note...
                    break
                }
            }
        }

        for (let s: Segment | null = startSegment; s && s !== endSegment; s = s.next1()) {
            for (let track = track1; track < track2; ++track) {
                const e = s.element(track)
                if (!e || !score.selectionFilter().canSelect(e) || !score.selectionFilter().canSelectVoice(track)) {
                    continue
                }
                if (!e.isChord()) {
                    // do not apply articulation or fermata to barline in a range selection
                    if (!e.isBarLine() || !element.isArticulationOrFermata()) {
                        this.applyDropPaletteElement(score, e, element, modifiers)
                    }
                    continue
                }

                applyDropPaletteElementToChord(e as unknown as Chord)
            }
            if (!element.placeMultiple()) {
                break
            }
        }
    }

    /** C++ applyDropPaletteElement (Palette applyDrop) */
    private applyDropPaletteElement(score: Score, target: EngravingItem | null, e: EngravingItem, modifiers: number,
        track: track_idx_t = nidx): void {
        if (!target) {
            return
        }

        // TODO(port): the EditData of text editing
        const dropData = new EditData()

        dropData.modifiers = modifiers
        dropData.dropElement = e
        dropData.track = (track === nidx) ? target.track() : track

        if (target.acceptDrop(dropData)) {
            // use same code path as drag&drop
            // TODO(port): C++ copies the element through its mime data (write + read); the port clones it
            const dropElement = e.clone()
            dropElement.setScore(score)
            dropElement.setParent(scoreDummy(score))
            dropElement.setSelected(false)
            dropElement.styleChanged() // update to local style
            dropData.dropElement = dropElement

            const el = target.drop(dropData)

            if (el && el.isInstrumentChange()) {
                if (!this.selectInstrument(el as unknown as InstrumentChange)) {
                    this.rollback()
                    return
                }
            }

            // TODO(port): voice assignment (setInitialTrackAndVoiceAssignment), fretboard diagrams
            // (doFinishAddFretboardDiagram)

            if (el && !score.inputState().noteEntryMode()) {
                this.selectAndStartEditIfNeeded(el)
            }

            dropData.dropElement = null
        }
    }

    selectAndStartEditIfNeeded(element: EngravingItem): void {
        if (element.isSpanner() && (element as unknown as Spanner).spannerSegments().length) {
            element = (element as unknown as Spanner).spannerSegments()[0]
        }

        this.select([element], SelectType.SINGLE)

        if (element.needStartEditingAfterSelecting()) {
            this.startEditElement(element)
        }
    }

    // =================================================================================================================
    //   drop of an element (a palette cell dragged onto the score): startDropSingle, updateDropSingle, dropSingle,
    //   endDrop (C++ "Copied from ScoreView::dragEnterEvent" etc.). The view calls them with canvas positions.
    //   TODO(port): drop of ranges (startDropRange/updateDropRange/dropRange: outgoing drags of a selection), images
    //   (startDropImage), the time tick anchors shown while dragging (EditTimeTickAnchors, hideAnchors)
    // =================================================================================================================

    private m_dropData: ElementDropData | null = null
    private m_anchorLines: LineF[] = []
    private m_currentDropPage: Page | null = null
    /** C++ m_droppableTree: the page elements accepting the drop (nearestNeighbor searches them) */
    private m_droppableItems: EngravingItem[] = []
    private m_dropChanged = new Notification()

    dropChanged(): Notification { return this.m_dropChanged }
    private notifyAboutDropChanged(): void { this.m_dropChanged.notify() }

    /** the element being dropped (null if no drop is in progress) */
    dropElement(): EngravingItem | null { return this.m_dropData?.ed.dropElement ?? null }
    /** the current drop target (highlighted) */
    dropTargetItem(): EngravingItem | null { return this.m_dropData?.dropTarget ?? null }
    anchorLines(): readonly LineF[] { return this.m_anchorLines }

    setAnchorLines(anchorList: LineF[]): void {
        this.m_anchorLines = anchorList.map(l => l.clone())
    }

    resetAnchorLines(): void {
        this.m_anchorLines = []
    }

    // outgoing drag of an element (Shift+Ctrl+drag: an element dragged to a palette). C++ creates a QDrag with the
    // mime data; here the view does the drag with the mime data of outgoingDrag()

    private m_outgoingDrag: OutgoingDrag | null = null

    isOutgoingDragElementAllowed(element: EngravingItem | null): boolean {
        if (!element) {
            return false
        }

        switch (element.type()) {
        case ElementType.MEASURE:
        case ElementType.NOTE:
        case ElementType.VBOX:
        case ElementType.HBOX:
        case ElementType.TBOX:
        case ElementType.FBOX:
        // TODO: Bends & NoteLines can't be copy-dragged until corresponding SingleLayout::layout and SingleDraw::draw methods have been implemented
        case ElementType.GUITAR_BEND:
        case ElementType.GUITAR_BEND_SEGMENT:
        case ElementType.GUITAR_BEND_HOLD:
        case ElementType.GUITAR_BEND_HOLD_SEGMENT:
        case ElementType.GUITAR_BEND_TEXT:
        case ElementType.NOTELINE:
        case ElementType.NOTELINE_SEGMENT:
            return false
        default: return true
        }
    }

    /** hotSpot: the position of the pointer relative to the element's top left corner (canvas units) */
    startOutgoingDragElement(element: EngravingItem, hotSpot: PointF): void {
        if (this.isDragStarted()) {
            this.endOutgoingDrag()
        }

        let mimeData: string
        if (element.isSpannerSegment()) {
            const s = (element as unknown as SpannerSegment).spanner()!
            mimeData = s.mimeData()
        } else {
            mimeData = element.mimeData()
        }

        // TODO(port): the drag pixmap (the element drawn at the screen's resolution): the view draws the drag image
        this.m_outgoingDrag = { mimeData, hotSpot: hotSpot.clone(), element }
    }

    isOutgoingDragStarted(): boolean {
        return this.m_outgoingDrag !== null
    }

    /** the started outgoing drag (mime data of mimeSymbolFormat) */
    outgoingDrag(): OutgoingDrag | null {
        return this.m_outgoingDrag
    }

    endOutgoingDrag(): void {
        this.m_outgoingDrag = null
    }

    /** edata: the element's mime data (EngravingItem::mimeData, mimeSymbolFormat) */
    startDropSingle(edata: string): boolean {
        this.resetDropData()

        const edd: ElementDropData = { ed: new EditData(), dropTarget: null, dropRect: new RectF() }
        // C++ EditData(&m_scoreCallbacks): ScoreCallbacks forwards the view callbacks to the interaction
        edd.ed.view = this.scoreCallbacks()
        this.m_dropData = edd

        const e = new XmlReader(edata)
        const dragOffset = { v: new PointF() }
        const duration = { v: new Fraction(0, 1) } // dummy
        const type = readType(e, dragOffset, duration)
        edd.ed.dragOffset = dragOffset.v

        const el = type === ElementType.INVALID ? null : Factory.createItem(type, scoreDummy(this.score()))
        if (el) {
            if (type === ElementType.BAR_LINE || type === ElementType.BRACKET) {
                const spatium = this.score().style().spatium()
                el.setHeight(spatium * 5)
            }
            edd.ed.dropElement = el

            RWRegister.reader().readItem(edd.ed.dropElement, e)

            SingleLayout.layoutItem(edd.ed.dropElement) // C++ engravingRenderer(): the ISingleRenderer
            return true
        }

        this.resetDropData()
        return false
    }

    /** modifiers: KeyboardModifier flags; returns true if the drop is accepted at pos */
    updateDropSingle(pos: PointF, modifiers: number): boolean {
        if (!this.m_dropData) {
            return false
        }

        const edd = this.m_dropData

        const dropElem = edd.ed.dropElement
        if (!dropElem) {
            return false
        }

        switch (dropElem.type()) {
        case ElementType.BRACKET:
        case ElementType.GRADUAL_TEMPO_CHANGE:
        case ElementType.JUMP:
        case ElementType.KEYSIG:
        case ElementType.LAYOUT_BREAK:
        case ElementType.MARKER:
        case ElementType.MEASURE_REPEAT:
        case ElementType.MEASURE_NUMBER:
        case ElementType.TIMESIG:
        case ElementType.SPACER:
        case ElementType.STAFFTYPE_CHANGE:
        case ElementType.STRING_TUNINGS:
        case ElementType.VOLTA: {
            edd.ed.modifiers = modifiers
            return this.prepareDropMeasureAnchorElement(pos)
        }
        case ElementType.PEDAL:
        case ElementType.LET_RING:
        case ElementType.VIBRATO:
        case ElementType.PALM_MUTE:
        case ElementType.OTTAVA:
        case ElementType.TRILL:
        case ElementType.HAIRPIN:
        case ElementType.TEXTLINE:
        case ElementType.WHAMMY_BAR: {
            edd.ed.modifiers = modifiers
            return this.prepareDropTimeAnchorElement(pos)
        }
        case ElementType.IMAGE:
        case ElementType.SYMBOL:
        case ElementType.FSYMBOL:
        case ElementType.DYNAMIC:
        case ElementType.CLEF:
        case ElementType.BAR_LINE:
        case ElementType.ARPEGGIO:
        case ElementType.CHORD_BRACKET:
        case ElementType.BREATH:
        case ElementType.GLISSANDO:
        case ElementType.ARTICULATION:
        case ElementType.TAPPING:
        case ElementType.FERMATA:
        case ElementType.CHORDLINE:
        case ElementType.BEND:
        case ElementType.ACCIDENTAL:
        case ElementType.TEXT:
        case ElementType.FINGERING:
        case ElementType.TEMPO_TEXT:
        case ElementType.ORNAMENT:
        case ElementType.EXPRESSION:
        case ElementType.STAFF_TEXT:
        case ElementType.SYSTEM_TEXT:
        case ElementType.TRIPLET_FEEL:
        case ElementType.PLAYTECH_ANNOTATION:
        case ElementType.CAPO:
        case ElementType.NOTEHEAD:
        case ElementType.TREMOLO_SINGLECHORD:
        case ElementType.TREMOLO_TWOCHORD:
        case ElementType.STAFF_STATE:
        case ElementType.INSTRUMENT_CHANGE:
        case ElementType.REHEARSAL_MARK:
        case ElementType.CHORD:
        case ElementType.SLUR:
        case ElementType.HAMMER_ON_PULL_OFF:
        case ElementType.HARMONY:
        case ElementType.BAGPIPE_EMBELLISHMENT:
        case ElementType.AMBITUS:
        case ElementType.TREMOLOBAR:
        case ElementType.FIGURED_BASS:
        case ElementType.LYRICS:
        case ElementType.FRET_DIAGRAM:
        case ElementType.HARP_DIAGRAM: {
            return this.prepareDropStandardElement(pos, modifiers)
        }
        //! NOTE: See Measure::acceptDrop
        case ElementType.ACTION_ICON: {
            switch ((dropElem as unknown as ActionIcon).actionType()) {
            case ActionIconType.VFRAME:
            case ActionIconType.HFRAME:
            case ActionIconType.TFRAME:
            case ActionIconType.FFRAME:
            case ActionIconType.MEASURE:
            case ActionIconType.SYSTEM_LOCK:
            case ActionIconType.STAFF_TYPE_CHANGE: {
                edd.ed.modifiers = modifiers
                return this.prepareDropMeasureAnchorElement(pos)
            }
            // Other action icons (e.g parenthesis) can be dragged normally
            default: return this.prepareDropStandardElement(pos, modifiers)
            }
        }
        default:
            break
        }

        return false
    }

    /** modifiers: KeyboardModifier flags; returns true if the element was dropped */
    dropSingle(pos: PointF, modifiers: number): boolean {
        if (!this.m_dropData) {
            return false
        }

        const edd = this.m_dropData

        if (!edd.ed.dropElement) {
            return false
        }

        if (edd.ed.dropElement.score() !== this.score()) {
            return false
        }

        let accepted = false

        // If the drop position hasn't been set already through isDropAccepted's helper methods, use the mouse position
        if (edd.ed.pos.isNull()) {
            edd.ed.pos = pos.clone()
        }

        edd.ed.modifiers = modifiers
        edd.ed.dropElement.styleChanged()

        let systemStavesOnly = false
        let applyUserOffset = false

        this.startEdit(new TranslatableString('undoableAction', 'Drop element: %1').arg(edd.ed.dropElement.typeUserName().translated()))
        const et = edd.ed.dropElement.type()
        switch (et) {
        case ElementType.TEXTLINE:
        case ElementType.VOLTA:
        case ElementType.GRADUAL_TEMPO_CHANGE:
        case ElementType.OTTAVA:
        case ElementType.TRILL:
        case ElementType.PEDAL:
        case ElementType.LET_RING:
        case ElementType.VIBRATO:
        case ElementType.PALM_MUTE:
        case ElementType.HAIRPIN:
        case ElementType.WHAMMY_BAR: {
            if (et === ElementType.TEXTLINE) {
                systemStavesOnly = edd.ed.dropElement.systemFlag()
            }
            if (et === ElementType.TEXTLINE || et === ElementType.VOLTA || et === ElementType.GRADUAL_TEMPO_CHANGE) {
                // voltas drop to system staves by default, or closest staff if Control is held
                systemStavesOnly = systemStavesOnly || !(edd.ed.modifiers & KeyboardModifier.ControlModifier)
            }
            const spanner = edd.ed.dropElement as unknown as Spanner
            this.score().cmdAddSpannerAtPos(spanner, pos, systemStavesOnly)
            this.score().setUpdateAll()
            accepted = true
            break
        }
        case ElementType.SYMBOL:
        case ElementType.FSYMBOL:
        case ElementType.IMAGE:
            applyUserOffset = true
            accepted = this.doDropTextBaseAndSymbols(pos, applyUserOffset)
            break
        case ElementType.DYNAMIC:
        case ElementType.HARMONY:
            accepted = this.doDropTextBaseAndSymbols(pos, applyUserOffset)
            break
        case ElementType.FRET_DIAGRAM:
            accepted = this.doDropTextBaseAndSymbols(pos, applyUserOffset)
            // TODO(port): doFinishAddFretboardDiagram (a chord symbol for the diagram)
            break
        case ElementType.HBOX:
        case ElementType.VBOX:
        case ElementType.KEYSIG:
        case ElementType.CLEF:
        case ElementType.TIMESIG:
        case ElementType.BAR_LINE:
        case ElementType.ARPEGGIO:
        case ElementType.CHORD_BRACKET:
        case ElementType.BREATH:
        case ElementType.GLISSANDO:
        case ElementType.MEASURE_NUMBER:
        case ElementType.BRACKET:
        case ElementType.ARTICULATION:
        case ElementType.TAPPING:
        case ElementType.FERMATA:
        case ElementType.CHORDLINE:
        case ElementType.BEND:
        case ElementType.ACCIDENTAL:
        case ElementType.TEXT:
        case ElementType.FINGERING:
        case ElementType.TEMPO_TEXT:
        case ElementType.ORNAMENT:
        case ElementType.EXPRESSION:
        case ElementType.STAFF_TEXT:
        case ElementType.SYSTEM_TEXT:
        case ElementType.TRIPLET_FEEL:
        case ElementType.PLAYTECH_ANNOTATION:
        case ElementType.CAPO:
        case ElementType.STRING_TUNINGS:
        case ElementType.NOTEHEAD:
        case ElementType.TREMOLO_SINGLECHORD:
        case ElementType.TREMOLO_TWOCHORD:
        case ElementType.LAYOUT_BREAK:
        case ElementType.MARKER:
        case ElementType.STAFF_STATE:
        case ElementType.INSTRUMENT_CHANGE:
        case ElementType.REHEARSAL_MARK:
        case ElementType.JUMP:
        case ElementType.MEASURE_REPEAT:
        case ElementType.ACTION_ICON:
        case ElementType.NOTE:
        case ElementType.CHORD:
        case ElementType.SPACER:
        case ElementType.BAGPIPE_EMBELLISHMENT:
        case ElementType.AMBITUS:
        case ElementType.TREMOLOBAR:
        case ElementType.FIGURED_BASS:
        case ElementType.LYRICS:
        case ElementType.HARP_DIAGRAM:
        case ElementType.STAFFTYPE_CHANGE:
            accepted = this.doDropStandard()
            break
        case ElementType.SLUR:
        case ElementType.HAMMER_ON_PULL_OFF: {
            const el = this.dropTarget(edd.ed)
            const dropElement = edd.ed.dropElement as unknown as Slur
            if (el && el.isNote() && (el as unknown as Note).chord()) {
                this.doAddSlurBetween((el as unknown as Note).chord(), null, dropElement)
                accepted = true
            }
            break
        }
        default:
            this.resetDropData()
            break
        }

        if (this.m_dropData) {
            this.m_dropData.ed.dropElement = null
            this.m_dropData.ed.pos = new PointF()
            this.m_dropData.ed.modifiers = 0
        }

        this.setDropTarget(null) // this also resets dropRectangle and dropAnchor
        this.apply()

        if (accepted) {
            this.notifyAboutDropChanged()
        }

        this.checkAndShowError()

        return accepted
    }

    /** NOTE: Helper method for dropSingle. Handles drop logic for majority of elements (returns "accepted") */
    private doDropStandard(): boolean {
        if (!this.m_dropData) {
            return false
        }

        const edd = this.m_dropData

        const el = edd.dropTarget ? edd.dropTarget : this.dropTarget(edd.ed)
        if (!el) {
            if (!this.dropCanvas(edd.ed.dropElement!)) {
                // C++: LOGD("cannot drop %s(%p) to canvas")
                this.resetDropData()
            }
            return false
        }

        const dropElement = el.drop(edd.ed)

        if (dropElement && dropElement.isInstrumentChange()) {
            if (!this.selectInstrument(dropElement as unknown as InstrumentChange)) {
                this.rollback()
                return true // Really?
            }
        }

        if (dropElement) {
            if (!this.score().noteEntryMode()) {
                this.selectAndStartEditIfNeeded(dropElement)
            }
        }
        return true
    }

    /** NOTE: Helper method for dropSingle. Handles drop logic for text base items & symbols (returns "accepted") */
    private doDropTextBaseAndSymbols(pos: PointF, applyUserOffset: boolean): boolean {
        if (!this.m_dropData) {
            return false
        }

        const edd = this.m_dropData

        let el: EngravingItem | null = edd.dropTarget ? edd.dropTarget : this.elementAt(pos)
        if (!el || el.isStaffLines()) {
            const res = this.score().pos2measure(pos)
            el = res?.measure ?? null
            if (res && el && el.isMeasure()) {
                edd.ed.dropElement!.setTrack(staff2track(res.staffIdx))
                edd.ed.dropElement!.setParent(res.segment)

                if (applyUserOffset) {
                    edd.ed.dropElement!.setOffset(res.offset)
                }

                this.score().undoAddElement(edd.ed.dropElement!)
            } else {
                // C++: LOGD("cannot drop here")
                this.resetDropData()
            }
        } else {
            if (!el.acceptDrop(edd.ed)) {
                // C++: LOGD("drop %s onto %s not accepted")
                return false
            }
            edd.ed.pos = pos.clone()
            const dropElement = el.drop(edd.ed)
            if (dropElement) {
                this.selectAndStartEditIfNeeded(dropElement)
            }
        }

        return true
    }

    /** C++ Copied from ScoreView::dragLeaveEvent */
    endDrop(): void {
        this.score().hideAnchors()
        this.score().setUpdateAll()
        this.setDropTarget(null, /*notify=*/ false)
        this.resetDropData()
        this.notifyAboutDragChanged()
    }

    /** C++ Copied from ScoreView::dropCanvas */
    private dropCanvas(e: EngravingItem): boolean {
        if (e.isActionIcon()) {
            switch ((e as unknown as ActionIcon).actionType()) {
            case ActionIconType.VFRAME:
                this.score().insertBox(ElementType.VBOX, null)
                break
            case ActionIconType.HFRAME:
                this.score().insertBox(ElementType.HBOX, null)
                break
            case ActionIconType.TFRAME:
                this.score().insertBox(ElementType.TBOX, null)
                break
            case ActionIconType.FFRAME:
                this.score().insertBox(ElementType.FBOX, null)
                break
            case ActionIconType.MEASURE:
                this.score().insertMeasure(ElementType.MEASURE)
                break
            default:
                return false
            }
            return true
        }
        return false
    }

    /** C++ Copied from ScoreView::getDropTarget */
    private dropTarget(ed: EditData): EngravingItem | null {
        const el = this.elementsAt(ed.pos)
        let fallbackMeasure: Measure | null = null
        for (const e of el) {
            if (e.isStaffLines()) {
                fallbackMeasure = (e as unknown as StaffLines).measure()
                continue
            }
            if (e.acceptDrop(ed)) {
                return e
            }
        }
        if (fallbackMeasure && fallbackMeasure.acceptDrop(ed)) {
            return fallbackMeasure
        }
        return null
    }

    private prepareDropStandardElement(pos: PointF, modifiers: number): boolean {
        if (!this.m_dropData) {
            return false
        }

        const edd = this.m_dropData

        const page = this.point2page(pos, true)
        if (!page) {
            return false
        }

        // Update the tree when starting a new drag (ed.pos hasn't been set yet), if the modifier changed, or when crossing a page
        if (edd.ed.pos.isNull() || edd.ed.modifiers !== modifiers || page !== this.m_currentDropPage) {
            this.m_currentDropPage = page
            edd.ed.modifiers = modifiers

            this.m_droppableItems = page.elements().filter(elem => elem.acceptDrop(edd.ed))
        }

        const posInPage = new PointF(pos.x() - page.pos().x(), pos.y() - page.pos().y())
        const targetElem = nearestNeighbor(this.m_droppableItems, posInPage)
        const dropElem = edd.ed.dropElement

        if (!targetElem || !dropElem) {
            return false
        }

        // Clefs are a special case somewhere between a measure anchored and standard element (hence why
        // we handle it here instead of dragMeasureAnchorElement). They can be applied to individual items
        // but we should switch targets to the whole measure if the target element is the first in the measure...
        if (dropElem.isClef() && targetElem.rtick().eq(new Fraction(0, 1))) {
            const targetMeasure = targetElem.findMeasure()
            if (targetMeasure && dropElem.type() !== targetElem.type()) {
                this.setDropTarget(targetMeasure, true)

                const measureRect = targetMeasure.staffPageBoundingRect(targetElem.staffIdx())
                measureRect.adjust(page.x(), page.y(), page.x(), page.y())
                edd.ed.pos = measureRect.center()
                edd.ed.track = trackZeroVoice(targetElem.track())
                this.setAnchorLines([new LineF(pos, measureRect.topLeft())])

                return targetMeasure.acceptDrop(edd.ed)
            }
        }

        this.setDropTarget(targetElem, true)
        edd.ed.pos = targetElem.canvasBoundingRect().center()
        this.setAnchorLines([new LineF(pos, targetElem.canvasBoundingRect().center())])

        return true
    }

    /** C++ Copied from ScoreView::dragMeasureAnchorElement */
    private prepareDropMeasureAnchorElement(pos: PointF): boolean {
        if (!this.m_dropData) {
            return false
        }

        const edd = this.m_dropData

        const dropElem = edd.ed.dropElement
        const page = this.point2page(pos)
        if (!dropElem || !page) {
            return false
        }

        const res = this.score().pos2measure(pos)
        let staffIdx = res ? res.staffIdx : 0

        //! NOTE: Should match Measure::acceptDrop
        switch (dropElem.type()) {
        case ElementType.VOLTA:
        case ElementType.GRADUAL_TEMPO_CHANGE:
        case ElementType.KEYSIG:
        case ElementType.TIMESIG:
            // If ctrl is pressed, break and target a specific staff
            if (edd.ed.modifiers & KeyboardModifier.ControlModifier) {
                break
            }
            staffIdx = 0 // Target all staves
            break
        case ElementType.JUMP:
        case ElementType.LAYOUT_BREAK:
        case ElementType.MARKER:
        case ElementType.MEASURE_NUMBER:
        case ElementType.VBOX:
        case ElementType.TBOX:
        case ElementType.FBOX:
        case ElementType.HBOX:
            // Target all staves
            staffIdx = 0
            break
        default: break
        }

        // Apart from STAFF_TYPE_CHANGE, measure anchored action icons are applied to all staves
        if (dropElem.isActionIcon() && (dropElem as unknown as ActionIcon).actionType() !== ActionIconType.STAFF_TYPE_CHANGE) {
            staffIdx = 0
        }

        const mb = res?.measure ?? null
        if (mb && mb.isMeasure()) {
            const targetMeasure = mb
            this.setDropTarget(targetMeasure, true)
            edd.ed.track = staff2track(staffIdx)

            const measureRect = targetMeasure.staffPageBoundingRect(staffIdx)
            measureRect.adjust(page.x(), page.y(), page.x(), page.y())
            edd.ed.pos = measureRect.center()

            const dropAccepted = targetMeasure.acceptDrop(edd.ed)
            if (dropAccepted) {
                this.setAnchorLines([new LineF(pos, measureRect.topLeft())])
            }

            return dropAccepted
        }
        this.setDropTarget(null)
        return false
    }

    /** C++ Copied from ScoreView::dragTimeAnchorElement */
    private prepareDropTimeAnchorElement(pos: PointF): boolean {
        if (!this.m_dropData) {
            return false
        }

        const edd = this.m_dropData

        const res = this.score().pos2measure(pos)
        const staffIdx = res ? res.staffIdx : 0
        const track = staff2track(staffIdx)

        if (res && res.measure.isMeasure() && res.segment.element(track)) {
            const m = res.measure
            const s = m.system()!
            const y = s.staff(staffIdx)!.y() + s.pos().y() + s.page()!.pos().y()
            const anchor = new PointF(res.segment.canvasBoundingRect().x(), y)
            this.setAnchorLines([new LineF(pos, anchor)])
            edd.ed.dropElement!.setTrack(track)
            this.notifyAboutDragChanged()
            return true
        }

        this.setDropTarget(null)

        return false
    }

    /** C++ Copied from ScoreView::setDropTarget */
    setDropTarget(item: EngravingItem | null, notify = true): void {
        if (!this.m_dropData) {
            return
        }

        const edd = this.m_dropData

        if (edd.dropTarget !== item) {
            if (edd.dropTarget) {
                edd.dropTarget.setDropTarget(false)
                edd.ed.track = nidx
                edd.dropTarget = null
            }

            edd.dropTarget = item
            if (edd.dropTarget) {
                edd.dropTarget.setDropTarget(true)
                edd.ed.track = edd.dropTarget.track()
            }
        }

        this.resetAnchorLines()

        if (edd.dropRect.isValid()) {
            edd.dropRect = new RectF()
        }

        if (notify) {
            this.notifyAboutDragChanged()
        }
    }

    /** NOTE: Copied from ScoreView::setDropRectangle */
    setDropRect(rect: RectF): void {
        if (!this.m_dropData) {
            return
        }

        const edd = this.m_dropData

        if (edd.dropRect.equals(rect)) {
            return
        }

        edd.dropRect = rect.clone()

        if (edd.dropTarget) {
            edd.dropTarget.setDropTarget(false)
        } else if (this.m_anchorLines.length) {
            this.resetAnchorLines()
        }

        this.notifyAboutDragChanged()
    }

    private resetDropData(): void {
        // C++ deletes the drop element (setDropTarget(nullptr) resets the drop target before)
        this.m_dropData?.dropTarget?.setDropTarget(false)
        this.m_dropData = null
        this.m_droppableItems = []
        this.m_currentDropPage = null
    }

    /** the drop rectangle (C++ NotationInteraction::drawDrop; drop ranges are not ported) */
    drawDrop(painter: Painter): void {
        if (this.m_dropData) {
            const edd = this.m_dropData

            if (edd.dropRect.isValid()) {
                const c = EngravingConfiguration.selectionColor()
                c.setAlpha(80) // NotationConfiguration::dropRectColor
                painter.fillRect(edd.dropRect, c)
            }
        }
    }

    drawAnchorLines(painter: Painter, scaling: number): void {
        if (!this.m_anchorLines.length) {
            return
        }

        const dropAnchorColor = EngravingConfiguration.formattingColor()
        const pen = new Pen(dropAnchorColor, 2.0 / scaling, PenStyle.DotLine)

        for (const anchor of this.m_anchorLines) {
            painter.setPen(pen)
            painter.drawLine(anchor)

            const d = 4.0 / scaling
            const rect = new RectF(-d, -d, 2 * d, 2 * d)

            painter.setBrush(new Brush(dropAnchorColor))
            painter.setNoPen()
            rect.moveCenter(anchor.p1())
            painter.drawEllipse(rect)
            rect.moveCenter(anchor.p2())
            painter.drawEllipse(rect)
        }
    }

    // =================================================================================================================
    //   copy/paste (copySelection, pasteSelection, swapSelection, repeatSelection): the clipboard is the application's
    //   in-memory clipboard (framework/global/clipboard.ts, C++ QApplication::clipboard()); the UI synchronizes it
    // =================================================================================================================

    copySelection(): void {
        if (!this.score().selection().canCopy()) {
            this.checkAndShowError()
            return
        }

        if (this.isTextEditingStarted()) {
            this.m_editData.element!.editCopy(this.m_editData)
            const ted = this.m_editData.getData(this.m_editData.element) as TextEditData
            if (ted.selectedText.length) {
                const mimeData = new MimeData()
                mimeData.setData(TextEditData.mimeRichTextFormat, ted.selectedText)
                mimeData.setText(ted.selectedPlainText)
                clipboard().setMimeData(mimeData)
            }
        } else {
            const mimeData = this.selectionQMimeData()
            if (!mimeData) {
                return
            }
            clipboard().setMimeData(mimeData)
        }
    }

    /** C++ NotationSelection::qMimeData() */
    selectionQMimeData(): MimeData | null {
        const mimeType = this.score().selection().mimeType()
        if (!mimeType) {
            return null
        }

        const mimeData = new MimeData()
        mimeData.setData(mimeType, this.score().selection().mimeData())
        return mimeData
    }

    repeatSelection(): void {
        const selection = this.score().selection()
        if (this.score().noteEntryMode() && selection.isSingle()) {
            // Single selections require special handling in note entry mode...
            const el = selection.element()
            if (!el || this.score().inputState().endOfScore()) {
                return
            }
            let c: Chord | null = null
            if (el.isNote()) {
                c = (el as unknown as Note).chord()
            } else if (el.isRest()) {
                let prevSegment = (el as unknown as Rest).segment().prev1WithElemsOnTrack(el.track())

                // Looking for the previous Chord
                while (prevSegment) {
                    if (prevSegment.element(el.track())!.isChord()) {
                        c = prevSegment.element(el.track()) as unknown as Chord
                        break
                    }
                    prevSegment = prevSegment.prev1WithElemsOnTrack(el.track())
                }
            }
            if (c) {
                this.startEdit(new TranslatableString('undoableAction', 'Repeat selection'))
                for (const note of c.notes()) {
                    const nval = note.noteVal()
                    this.score().addPitch(nval, note !== c.notes()[0])
                }
                this.apply()
            }
            return
        }

        //! NOTE: Ideally we would use our copy-paste logic for this case, but this isn't
        //! fully compatible with list selections right now...
        if (selection.isList() && selection.noteList().length) {
            const firstTick = selection.tickStart()
            const lastTick = selection.tickEnd()
            // Only "single-tick" list selections are currently supported...
            if (!firstTick.eq(lastTick)) {
                MScore.setError(MsError.CANNOT_REPEAT_SELECTION)
                this.checkAndShowError()
                return
            }
            this.startEdit(new TranslatableString('undoableAction', 'Repeat selection'))
            if (!this.score().cmdRepeatListSelection()) {
                this.rollback()
                MScore.setError(MsError.CANNOT_REPEAT_SELECTION)
                return
            }
            this.apply()
            return
        }

        // If a list selection with no notes is a rest, convert to a range selection
        if (selection.isList()) {
            const cr = this.score().getSelectedChordRest()
            if (!cr) {
                MScore.setError(MsError.CANNOT_REPEAT_SELECTION)
                this.checkAndShowError()
                return
            }
            this.score().select([cr], SelectType.RANGE)
        }

        // Use copy-paste logic for range selections...
        if (!selection.isRange() || !selection.canCopy()) {
            MScore.setError(MsError.CANNOT_REPEAT_SELECTION)
            this.checkAndShowError()
            return
        }

        const xml = new XmlReader(selection.mimeData())
        const dStaff = selection.staffStart()
        let endSegment = selection.endSegment()

        if (endSegment && endSegment.segmentType() !== SegmentType.ChordRest) {
            endSegment = endSegment.next1(SegmentType.ChordRest)
        }
        if (!endSegment) {
            return
        }
        for (let track = staff2track(dStaff); track < staff2track(dStaff + 1); ++track) {
            const e = endSegment.element(track)
            if (!e) {
                continue
            }
            this.startEdit(new TranslatableString('undoableAction', 'Repeat selection'))
            const cr = e as unknown as ChordRest
            if (!this.score().pasteStaff(xml, cr.segment(), cr.staffIdx())) {
                this.rollback()
                this.checkAndShowError()
                return
            }
            this.apply()

            this.showItem(cr)
            break
        }
    }

    pasteSelection(scale: Fraction = new Fraction(1, 1)): void {
        this.startEdit(new TranslatableString('undoableAction', 'Paste'))

        let succeeded = true
        if (this.isTextEditingStarted()) {
            this.pasteIntoTextEdit()
        } else {
            const mimeData = clipboard().mimeData()
            succeeded = this.score().cmdPaste(mimeData, scale)
            this.m_editData.element = null
        }

        if (succeeded) {
            this.apply()
            const pastedElement = this.score().selection().element()
            if (pastedElement) {
                this.selectAndStartEditIfNeeded(pastedElement)
            }
        } else {
            this.rollback()
        }

        this.checkAndShowError()
    }

    private pasteIntoTextEdit(): void {
        const mimeData = clipboard().mimeData()
        const textBase = this.m_editData.element as unknown as TextBase
        if (mimeData.hasFormat(TextEditData.mimeRichTextFormat)) {
            const txt = mimeData.data(TextEditData.mimeRichTextFormat)
            textBase.paste(this.m_editData, txt)
            return
        }

        let clipboardText = mimeData.text()
        let textForPaste = clipboardText
        if ((!clipboardText.startsWith('<') || !clipboardText.includes('>')) && textBase.isLyrics()) {
            textForPaste = extractSyllable(clipboardText)
        }

        textBase.paste(this.m_editData, textForPaste)

        if (textForPaste.length === 0 || !textBase.isLyrics()) {
            return
        }

        if (textForPaste.endsWith('-')) {
            this.navigateToNextSyllable()
        } else if (textForPaste.endsWith('_')) {
            this.addMelisma()
        } else {
            this.navigateToLyrics(false, false, false)
        }

        clipboardText = clipboardText.substring(clipboardText.indexOf(textForPaste) + textForPaste.length)
        clipboard().setText(clipboardText)
    }

    swapSelection(): void {
        if (!this.score().selection().canCopy()) {
            return
        }

        // Store the old selection...
        const selection = this.score().selection()
        const oldSelection = selection.mimeData()

        // Paste using contents of clipboard...
        this.pasteSelection()

        // Save old selection to clipboard...
        const mimeData = new MimeData()
        mimeData.setData(selection.mimeType(), oldSelection)
        clipboard().setMimeData(mimeData)
    }

    // =================================================================================================================
    //   element and text editing (edit mode): startEditElement / editElement / endEditElement, text editing, adding
    //   texts, lyrics and chord symbol navigation, nudging
    // =================================================================================================================

    private m_editData = new EditData()
    private m_hitElementContext: HitElementContext = { element: null, staff: null }
    private m_textEditingStarted = new Notification()
    private m_textEditingChanged = new Notification()
    private m_textEditingEnded = new Notification()
    private m_isEditingElementChanged = new Notification()

    editData(): EditData { return this.m_editData }

    textEditingStarted(): Notification { return this.m_textEditingStarted }
    textEditingChanged(): Notification { return this.m_textEditingChanged }
    textEditingEnded(): Notification { return this.m_textEditingEnded }
    isEditingElementChanged(): Notification { return this.m_isEditingElementChanged }

    private notifyAboutTextEditingStarted(): void { this.m_textEditingStarted.notify() }
    private notifyAboutTextEditingChanged(): void { this.m_textEditingChanged.notify() }
    private notifyAboutTextEditingEnded(): void { this.m_textEditingEnded.notify() }

    hitElementContext(): HitElementContext { return this.m_hitElementContext }
    setHitElementContext(context: HitElementContext): void { this.m_hitElementContext = context }
    resetHitElementContext(): void { this.setHitElementContext({ element: null, staff: null }) }

    contextItem(): EngravingItem | null {
        const item = this.score().selection().element()
        return item ? item : this.hitElementContext().element
    }

    isTextSelected(): boolean {
        const selectedElement = this.score().selection().element()
        if (!selectedElement) {
            return false
        }
        return selectedElement.isTextBase()
    }

    isTextEditingStarted(): boolean {
        const element = this.m_editData.element
        return !!element && element.isTextBase() && (element as unknown as TextBase).cursor().editing()
    }

    textEditingAllowed(element: EngravingItem | null): boolean {
        return !!element && element.isEditable() && (element.isTextBase() || element.isTBox())
    }

    /** C++ startEditText(EngravingItem*, const PointF& cursorPos) */
    startEditText(element: EngravingItem | null, cursorPos: PointF = new PointF()): void {
        if (!element) {
            return
        }

        if (element.isTBox()) {
            element = (element as unknown as TBox).text()
        }

        if (element !== this.score().selection().element()) {
            this.select([element], SelectType.SINGLE)
        }

        this.m_editData.clear()
        this.m_editData.element = element
        this.m_editData.startMove = bindCursorPosToText(cursorPos, this.m_editData.element)

        this.m_editData.element.startEdit(this.m_editData)

        this.m_isEditingElementChanged.notify()
        this.notifyAboutTextEditingStarted()
        this.notifyAboutTextEditingChanged()
    }

    /** C++ private startEditText(TextBase*): selects the text and puts the cursor at its end */
    private startEditTextAtEnd(text: TextBase): void {
        this.doEndEditElement()
        this.select([text], SelectType.SINGLE)

        //! NOTE: Copied from ScoreView::cmdAddText
        const measure = text.findMeasure()
        if (measure && measure.hasMMRest() && text.links()) {
            const mmRest = measure.mmRest()
            for (const link of text.links()!) {
                const linkedText = link as unknown as TextBase
                if (text !== linkedText && linkedText.findMeasure() === mmRest) {
                    text = linkedText
                    break
                }
            }
        }

        this.startEditText(text, new PointF())
        text.cursor().moveCursorToEnd()
    }

    /**
     * C++ editText(QInputMethodEvent*): the committed text of the input method (and keys typed into the text edit
     * field), or the preedit string of a composition
     */
    editText(commitString: string, preeditString = ''): void {
        if (!this.isTextEditingStarted()) {
            return
        }

        const text = this.m_editData.element as unknown as TextBase
        const cursor = text.cursor()

        // remove preedit string
        let n = this.m_editData.preeditString.length
        while (n--) {
            if (cursor.movePosition(TextCursorMoveOperation.Left)) {
                const curLine = cursor.curLine()
                curLine.remove(cursor.column(), cursor)
                text.triggerLayout()
                text.setTextInvalid()
            }
        }

        if (commitString.length) {
            this.score().startCmd(new TranslatableString('undoableAction', 'Edit text'))
            text.insertText(this.m_editData, commitString)
            this.score().endCmd()
            this.m_editData.preeditString = ''
        } else {
            this.m_editData.preeditString = preeditString

            if (preeditString.length) {
                cursor.updateCursorFormat()
                text.editInsertText(cursor, preeditString)
                text.setTextInvalid()
                textBaseRenderer.layoutText1(text)
                this.score().update()
            }
        }

        this.notifyAboutTextEditingChanged()
    }

    private needStartEditGrip(event: NotationKeyEvent): boolean {
        if (!this.m_editData.element || !this.m_editData.element.hasGrips()) {
            return false
        }

        if (this.isGripEditStarted()) {
            return false
        }

        return [KeyboardKey.Key_Left, KeyboardKey.Key_Right, KeyboardKey.Key_Up, KeyboardKey.Key_Down].includes(event.key)
    }

    private handleKeyPress(event: NotationKeyEvent): boolean {
        const editElem = this.m_editData.element
        if (!editElem) {
            return false
        }

        if (editElem.isTextBase() && this.doTextEdit(event, editElem as unknown as TextBase)) {
            return true
        }

        //: Means: an editing operation triggered by a keystroke
        this.startEdit(new TranslatableString('undoableAction', 'Keystroke edit'))

        if (editElem.edit(this.m_editData)) {
            this.apply()
            return true
        } else {
            this.rollback()
        }

        if (event.modifiers & KeyboardModifier.AltModifier) {
            return false
        }

        const vRaster = editElem.isBeam() ? 4 : MScore.vRaster()
        const hRaster = editElem.isBeam() ? 4 : MScore.hRaster()

        switch (event.key) {
        case KeyboardKey.Key_Tab:
            if (!editElem.hasGrips()) {
                return false
            }
            editElem.nextGrip(this.m_editData)
            this.notifyAboutNotationChanged()
            return true
        case KeyboardKey.Key_Backtab:
            if (!editElem.hasGrips()) {
                return false
            }
            editElem.prevGrip(this.m_editData)
            this.notifyAboutNotationChanged()
            return true
        case KeyboardKey.Key_Left:
            this.m_editData.delta = new PointF(-nudgeDistanceRaster(this.m_editData, hRaster), 0)
            break
        case KeyboardKey.Key_Right:
            this.m_editData.delta = new PointF(nudgeDistanceRaster(this.m_editData, hRaster), 0)
            break
        case KeyboardKey.Key_Up:
            this.m_editData.delta = new PointF(0, -nudgeDistanceRaster(this.m_editData, vRaster))
            break
        case KeyboardKey.Key_Down:
            this.m_editData.delta = new PointF(0, nudgeDistanceRaster(this.m_editData, vRaster))
            break
        default:
            return false
        }

        this.m_editData.evtDelta = this.m_editData.delta.clone()
        this.m_editData.moveDelta = this.m_editData.delta.clone()
        this.m_editData.hRaster = hRaster !== 0
        this.m_editData.vRaster = vRaster !== 0
        // C++ assigns the raster values to the bool members (always true here)

        this.m_editData.isEditMode = this.isEditingElement()

        //: Means: an editing operation triggered by a keystroke
        this.startEdit(new TranslatableString('undoableAction', 'Keystroke edit'))

        if (this.m_editData.curGrip !== Grip.NO_GRIP && this.m_editData.curGrip < this.m_editData.grips) {
            this.m_editData.pos = this.m_editData.grip[this.m_editData.curGrip].center().plus(this.m_editData.delta)

            editElem.startDragGrip(this.m_editData)
            editElem.dragGrip(this.m_editData)
            editElem.endDragGrip(this.m_editData)
        } else {
            editElem.startDrag(this.m_editData)
            editElem.drag(this.m_editData)
            editElem.endDrag(this.m_editData)
        }

        this.apply()
        return true
    }

    private doTextEdit(event: NotationKeyEvent, tb: TextBase): boolean {
        //: Means: an editing operation triggered by a keystroke
        this.startEdit(new TranslatableString('undoableAction', 'Keystroke edit'))

        if (!tb.edit(this.m_editData)) {
            this.rollback()
            return false
        }

        this.apply()

        // Replace newly added straight quotes with curly ones in a separate undo action...
        const isSingleQuoteInput = event.text === '\''
        const isDoubleQuoteInput = event.text === '"'
        if (!isSingleQuoteInput && !isDoubleQuoteInput) {
            return true
        }

        const ted = this.m_editData.getData(tb) as TextEditData | null
        const cursor = ted ? ted.cursor() : null
        if (!cursor) {
            return true
        }

        let useCloseQuote = false // Use close if there's a non-space before the newly inputted quote

        const row = cursor.row()
        const col = cursor.column()
        if (col > 1) {
            const prev = cursor.extractText(row, col - 2, row, col - 1)
            useCloseQuote = prev.length > 0 && !/\s/.test(prev[0])
        }

        //: Means: an editing operation triggered by a keystroke
        this.startEdit(new TranslatableString('undoableAction', 'Keystroke edit'))

        cursor.movePosition(TextCursorMoveOperation.Left)
        this.score().undo(new RemoveText(cursor, event.text), this.m_editData)

        //: Single open quotation mark
        const singleOpenQuote = mtrc('notation', '‘')
        //: Single close quotation mark
        const singleCloseQuote = mtrc('notation', '’')
        //: Double open quotation mark
        const doubleOpenQuote = mtrc('notation', '“')
        //: Double close quotation mark
        const doubleCloseQuote = mtrc('notation', '”')

        const replacement = isSingleQuoteInput
            ? (useCloseQuote ? singleCloseQuote : singleOpenQuote)
            : (useCloseQuote ? doubleCloseQuote : doubleOpenQuote)

        tb.insertText(this.m_editData, replacement)
        this.apply()

        return true
    }

    endEditText(): void {
        if (!this.isTextEditingStarted()) {
            return
        }

        this.doEndEditElement()

        this.m_isEditingElementChanged.notify()
        this.notifyAboutTextEditingEnded()

        this.notifyAboutTextEditingChanged()
        this.notifyAboutSelectionChangedIfNeed()
    }

    changeTextCursorPosition(newCursorPos: PointF): void {
        if (!this.isTextEditingStarted() || !this.m_editData.element) {
            return
        }

        this.m_editData.startMove = bindCursorPosToText(newCursorPos, this.m_editData.element)

        const textEl = this.m_editData.element as unknown as TextBase

        textEl.mousePress(this.m_editData)
        if (this.m_editData.buttons === MouseButton.MiddleButton) {
            const txt = clipboard().text()
            textEl.paste(this.m_editData, txt)
        }

        this.notifyAboutTextEditingChanged()
    }

    selectText(type: SelectTextType): void {
        if (!this.isTextEditingStarted()) {
            return
        }

        const text = this.m_editData.element as unknown as TextBase
        text.select(this.m_editData, type)
        text.endHexState(this.m_editData)
        text.setPrimed(false)

        this.notifyAboutTextEditingChanged()
    }

    editedText(): TextBase | null {
        const e = this.m_editData.element
        return e && e.isTextBase() ? e as unknown as TextBase : null
    }

    isEditingElement(): boolean {
        return this.m_editData.element !== null
    }

    startEditElement(element: EngravingItem | null): void {
        if (!element || !element.isEditable()) {
            return
        }

        if (this.isEditingElement()) {
            return
        }

        if (element.isTextBase()) {
            this.startEditText(element)
        } else if (element.hasGrips() && !element.isImage()) {
            this.startEditGripFor(element, element.defaultGrip())
        } else {
            element.startEdit(this.m_editData)
            this.m_editData.element = element
        }

        this.m_isEditingElementChanged.notify()
    }

    changeEditElement(newElement: EngravingItem): void {
        if (this.m_editData.element === newElement) {
            return
        }

        const currentGrip = this.m_editData.curGrip
        const gripEditStarted = this.isGripEditStarted()

        this.doEndEditElement()

        if (gripEditStarted) {
            this.startEditGripFor(newElement, currentGrip)
        } else {
            this.startEditElement(newElement)
        }
    }

    /**
     * C++ isEditAllowed(QKeyEvent*) (the shortcut override): true if the key goes to the edited element (e.g. typing
     * into a text), false if it is a shortcut
     */
    isEditAllowed(event: NotationKeyEvent): boolean {
        if (!this.m_editData.element) {
            return false
        }

        const editData = this.m_editData.clone()
        editData.modifiers = event.modifiers
        editData.key = event.key
        editData.s = event.text

        if (editData.element!.isEditAllowed(editData)) {
            return true
        }

        if (event.modifiers & KeyboardModifier.AltModifier) {
            return false
        }

        if (editData.element!.isTextBase()) {
            return false
        }

        const navigationKeys = [KeyboardKey.Key_Left, KeyboardKey.Key_Right, KeyboardKey.Key_Up, KeyboardKey.Key_Down]

        if (editData.element!.hasGrips()) {
            navigationKeys.push(KeyboardKey.Key_Tab, KeyboardKey.Key_Backtab)
        }

        return navigationKeys.includes(event.key)
    }

    /** C++ editElement(QKeyEvent*); returns true if the key was handled (C++ event->accept()) */
    editElement(event: NotationKeyEvent): boolean {
        if (!this.m_editData.element) {
            return false
        }

        this.m_editData.modifiers = event.modifiers

        if (this.isDragStarted()) {
            return false // ignore all key strokes while dragging
        }

        this.m_editData.key = event.key
        this.m_editData.s = event.text

        // TODO(port): brackets (they get deleted during layout with their system: restore the selected bracket)
        if (this.m_editData.element.isHarmony()) {
            if (this.isTextEditingStarted() && (event.key === KeyboardKey.Key_Return || event.key === KeyboardKey.Key_Enter)) {
                this.endEditText()
                return true
            }
        }

        if (this.needStartEditGrip(event)) {
            this.m_editData.curGrip = this.m_editData.element.defaultGrip()
        }

        // C++ m_editData = EditData(&m_scoreCallbacks)
        this.m_editData.view ??= this.scoreCallbacks()

        let accepted = false
        if (this.handleKeyPress(event)) {
            if (this.isGripEditStarted()) {
                this.updateGripAnchorLines()
            }
            accepted = true
        }

        if (this.isTextEditingStarted()) {
            this.notifyAboutTextEditingChanged()
        }
        return accepted
    }

    /** C++ m_scoreCallbacks (ScoreCallbacks): the view callbacks of EditData::view() */
    private scoreCallbacks(): MuseScoreView {
        return {
            setDropRectangle: (rect) => this.setDropRect(rect),
            setDropTarget: (item) => this.setDropTarget(item, false),
            changeEditElement: (e) => this.changeEditElement(e),
        }
    }

    /**
     * C++ updateTimeTickAnchors(QKeyEvent*) (keyPress: event->type() == KeyPress): the anchors are shown while Shift is
     * held with an anchorable selection
     */
    updateTimeTickAnchors(keyPress: boolean): void {
        const selectedElement = this.score().selection().element()
        if (selectedElement && selectedElement.allowTimeAnchor() && keyPress && !this.isTextEditingStarted()) {
            EditTimeTickAnchors.updateAnchors(selectedElement)
            this.updateDragAnchorLines()
        } else {
            this.score().hideAnchors()
            this.resetAnchorLines()
        }

        this.score().update()
        this.notifyAboutNotationChanged()
    }

    /** C++ moveElementAnchors(QKeyEvent*): Shift(+Alt)+Left/Right moves the selected element to another beat */
    moveElementAnchors(event: NotationKeyEvent): void {
        const element = this.score().selection().element()
        if (!element) {
            return
        }

        this.startEdit(new TranslatableString('undoableAction', 'Move element anchors'))

        MoveElementAnchors.moveElementAnchors(element, event.key, event.modifiers)

        this.apply()

        this.updateDragAnchorLines()
    }

    endEditElement(): void {
        if (!this.m_editData.element) {
            return
        }

        if (this.isTextEditingStarted()) {
            this.endEditText()
            return
        }

        if (this.isDragStarted()) {
            this.doEndDrag()
            this.rollback()
        }

        this.doEndEditElement()
        this.resetAnchorLines()

        this.m_isEditingElementChanged.notify()
        this.notifyAboutNotationChanged()
    }

    doEndEditElement(): void {
        if (this.m_editData.element) {
            this.m_editData.element.endEdit(this.m_editData)
        }
        this.m_editData.clear()
    }

    private needEndTextEditing(newSelectedElements: readonly EngravingItem[]): boolean {
        if (!this.isTextEditingStarted()) {
            return false
        }

        if (newSelectedElements.length === 0) {
            return false
        }

        if (newSelectedElements.length > 1) {
            return true
        }

        // TODO(port): sound flags of staff texts (SoundFlag)

        return newSelectedElements[0] !== this.m_editData.element
    }

    private needEndElementEditing(newSelectedElements: readonly EngravingItem[]): boolean {
        if (!this.isEditingElement()) {
            return false
        }

        if (newSelectedElements.length !== 1) {
            return true
        }

        return newSelectedElements[0] !== this.score().selection().element()
    }

    private resetGripEdit(): void {
        this.m_editData.grips = 0
        this.m_editData.curGrip = Grip.NO_GRIP
        this.m_editData.grip = []

        this.resetAnchorLines()
    }

    // ---------------------------------------------------------------------------------
    //   adding texts (Ctrl+T etc.: NotationActionController::addText)
    // ---------------------------------------------------------------------------------

    addTextToTopFrame(type: TextStyleType): void {
        this.addText(type)
    }

    canAddTextToItem(type: TextStyleType, item: EngravingItem | null): boolean {
        if (isVerticalBoxTextStyle(type)) {
            return !!item && item.isVBox()
        }

        if (type === TextStyleType.FRAME) {
            return !!item && item.isBox()
        }

        const harmonyTypes = [TextStyleType.HARMONY_A, TextStyleType.HARMONY_ROMAN, TextStyleType.HARMONY_NASHVILLE]

        const isHarmony = harmonyTypes.includes(type)
        if (isHarmony && item && item.isFretDiagram()) {
            return true
        }

        const needSelectNoteOrRestTypes = [
            TextStyleType.SYSTEM,
            TextStyleType.STAFF,
            TextStyleType.DYNAMICS,
            TextStyleType.EXPRESSION,
            TextStyleType.REHEARSAL_MARK,
            TextStyleType.INSTRUMENT_CHANGE,
            TextStyleType.FINGERING,
            TextStyleType.LH_GUITAR_FINGERING,
            TextStyleType.RH_GUITAR_FINGERING,
            TextStyleType.STRING_NUMBER,
            TextStyleType.STICKING,
            TextStyleType.HARMONY_A,
            TextStyleType.HARMONY_ROMAN,
            TextStyleType.HARMONY_NASHVILLE,
            TextStyleType.LYRICS_ODD,
            TextStyleType.TEMPO,
        ]

        if (needSelectNoteOrRestTypes.includes(type)) {
            const requiredElementTypes = [
                ElementType.NOTE,
                ElementType.REST,
                ElementType.MMREST,
                ElementType.MEASURE_REPEAT,
                ElementType.CHORD,
            ]

            return !!item && requiredElementTypes.includes(item.type())
        }

        return true
    }

    addTextToItem(type: TextStyleType, item: EngravingItem | null): void {
        if (!this.score().firstMeasure()) {
            // C++: LOGE() << "Need to create measure"
            return
        }

        if (!this.canAddTextToItem(type, item)) {
            MScore.setError(MsError.NO_NOTE_REST_SELECTED)
            this.checkAndShowError()
            return
        }

        this.addText(type, item)
    }

    addText(type: TextStyleType, item: EngravingItem | null = null): void {
        if (this.m_noteInput.isNoteInputMode()) {
            this.m_noteInput.endNoteInput()
        }

        this.startEdit(new TranslatableString('undoableAction', 'Add text'))
        const text = this.score().addText(type, item)

        if (!text) {
            this.rollback()
            return
        }

        if (text.isInstrumentChange()) {
            if (!this.selectInstrument(text as unknown as InstrumentChange)) {
                this.rollback()
                return
            }
        }

        // TODO(port): setInitialTrackAndVoiceAssignment (voice assignment of texts)

        this.apply()
        this.showItem(text)

        if (!text.isInstrumentChange()) {
            this.startEditTextAtEnd(text)
        }

        if (text.isRehearsalMark() || text.isTempoText()) {
            text.cursor().selectWord()
        }
    }

    // ---------------------------------------------------------------------------------
    //   text styles (text-b, text-i, ...)
    // ---------------------------------------------------------------------------------

    private toggleFontStyle(style: FontStyle): void {
        if (!this.m_editData.element || !this.m_editData.element.isTextBase()) {
            return
        }
        const text = this.m_editData.element as unknown as TextBase
        const currentStyle = text.getProperty(Pid.FONT_STYLE) as number
        this.score().startCmd(new TranslatableString('undoableAction', 'Format text'))
        text.undoChangeProperty(Pid.FONT_STYLE, currentStyle ^ style, PropertyFlags.UNSTYLED)
        this.score().endCmd()
        this.notifyAboutTextEditingChanged()
    }

    private toggleVerticalAlignment(align: VerticalAlignment): void {
        if (!this.m_editData.element || !this.m_editData.element.isTextBase()) {
            return
        }
        const text = this.m_editData.element as unknown as TextBase
        const currentAlign = text.getProperty(Pid.TEXT_SCRIPT_ALIGN) as number

        let actionName: TranslatableString
        switch (align) {
        case VerticalAlignment.AlignSubScript:
            actionName = new TranslatableString('undoableAction', 'Toggle subscript')
            break
        case VerticalAlignment.AlignSuperScript:
            actionName = new TranslatableString('undoableAction', 'Toggle superscript')
            break
        default:
            actionName = new TranslatableString('undoableAction', 'Toggle subscript/superscript')
            break
        }

        this.score().startCmd(actionName)
        text.undoChangeProperty(Pid.TEXT_SCRIPT_ALIGN, currentAlign === align ? VerticalAlignment.AlignNormal : align,
            PropertyFlags.UNSTYLED)
        this.score().endCmd()
        this.notifyAboutTextEditingChanged()
    }

    toggleBold(): void { this.toggleFontStyle(FontStyle.Bold) }
    toggleItalic(): void { this.toggleFontStyle(FontStyle.Italic) }
    toggleUnderline(): void { this.toggleFontStyle(FontStyle.Underline) }
    toggleStrike(): void { this.toggleFontStyle(FontStyle.Strike) }
    toggleSubScript(): void { this.toggleVerticalAlignment(VerticalAlignment.AlignSubScript) }
    toggleSuperScript(): void { this.toggleVerticalAlignment(VerticalAlignment.AlignSuperScript) }

    // ---------------------------------------------------------------------------------
    //   nudging (arrow keys on a selected text or articulation), moving lyrics
    // ---------------------------------------------------------------------------------

    moveLyrics(d: MoveDirection): void {
        const el = this.score().selection().element()
        if (!el || !el.isLyrics()) {
            return
        }
        this.startEdit(new TranslatableString('undoableAction', 'Move lyrics'))
        // C++ Score::cmdMoveLyrics(lyrics, toDirection(d))
        const lyrics = el as unknown as Lyrics
        const verse = lyrics.verse() + (d === MoveDirection.Up ? -1 : 1)
        if (verse >= 0) {
            lyrics.undoChangeProperty(Pid.VERSE, verse)
        }
        this.apply()
    }

    nudge(d: MoveDirection, quickly: boolean): void {
        const el = this.score().selection().element()
        if (!el || !(el.isTextBase() || el.isArticulationFamily())) {
            return
        }

        this.startEdit(new TranslatableString('undoableAction', 'Nudge element'))

        let step = quickly ? MScore.nudgeStep10 : MScore.nudgeStep
        step = step * el.spatium()

        switch (d) {
        case MoveDirection.Undefined:
            this.rollback()
            return
        case MoveDirection.Left:
            el.undoChangeProperty(Pid.OFFSET, el.offset().minus(new PointF(step, 0.0)), PropertyFlags.UNSTYLED)
            break
        case MoveDirection.Right:
            el.undoChangeProperty(Pid.OFFSET, el.offset().plus(new PointF(step, 0.0)), PropertyFlags.UNSTYLED)
            break
        case MoveDirection.Up:
            el.undoChangeProperty(Pid.OFFSET, el.offset().minus(new PointF(0.0, step)), PropertyFlags.UNSTYLED)
            break
        case MoveDirection.Down:
            el.undoChangeProperty(Pid.OFFSET, el.offset().plus(new PointF(0.0, step)), PropertyFlags.UNSTYLED)
            break
        }

        this.apply()

        this.notifyAboutDragChanged()
    }

    nudgeAnchors(d: MoveDirection): void {
        if (!this.m_editData.element) {
            return
        }

        this.startEdit(new TranslatableString('undoableAction', 'Nudge'))
        const vRaster = 0 // C++ getVRaster(): 0 unless snapping to the grid
        const hRaster = 0

        switch (d) {
        case MoveDirection.Left:
            this.m_editData.delta = new PointF(-nudgeDistanceRaster(this.m_editData, hRaster), 0)
            break
        case MoveDirection.Right:
            this.m_editData.delta = new PointF(nudgeDistanceRaster(this.m_editData, hRaster), 0)
            break
        case MoveDirection.Up:
            this.m_editData.delta = new PointF(0, -nudgeDistanceRaster(this.m_editData, vRaster))
            break
        case MoveDirection.Down:
            this.m_editData.delta = new PointF(0, nudgeDistanceRaster(this.m_editData, vRaster))
            break
        default:
            this.rollback()
            return
        }

        this.m_editData.evtDelta = this.m_editData.delta.clone()
        this.m_editData.moveDelta = this.m_editData.delta.clone()
        this.m_editData.hRaster = false
        this.m_editData.vRaster = false

        const element = this.m_editData.element
        if (this.m_editData.curGrip !== Grip.NO_GRIP && this.m_editData.curGrip < this.m_editData.grips) {
            this.m_editData.pos = this.m_editData.grip[this.m_editData.curGrip].center().plus(this.m_editData.delta)

            element.startDragGrip(this.m_editData)
            element.dragGrip(this.m_editData)
            element.endDragGrip(this.m_editData)
        } else {
            element.startDrag(this.m_editData)
            element.drag(this.m_editData)
            element.endDrag(this.m_editData)
        }

        this.apply()
    }

    // ---------------------------------------------------------------------------------
    //   lyrics navigation (Space, -, _, Enter, Up/Down while editing lyrics)
    // ---------------------------------------------------------------------------------

    /** C++ navigateToLyrics(bool back, bool moveOnly, bool end); Copied from ScoreView::lyricsTab */
    navigateToLyrics(back: boolean, moveOnly: boolean, end: boolean): void {
        if (!this.m_editData.element || !this.m_editData.element.isLyrics()) {
            // C++: LOGW("nextLyric called with invalid current element")
            return
        }
        const lyrics = this.m_editData.element as unknown as Lyrics
        const track = lyrics.track()
        let segment: Segment | null = lyrics.segment()
        const verse = lyrics.verse()
        const placement = lyrics.placement()
        const pFlags = lyrics.propertyFlags(Pid.PLACEMENT)
        const fStyle = lyrics.fontStyle()
        const fFlags = lyrics.propertyFlags(Pid.FONT_STYLE)
        const styleType = lyrics.textStyleType()

        let nextSegment: Segment | null = segment
        if (back) {
            // search prev chord
            while ((nextSegment = nextSegment!.prev1(SegmentType.ChordRest))) {
                const el = nextSegment.element(track)
                if (!el) {
                    continue
                }
                if (el.isChord()) {
                    break
                } else if (el.isRest()) {
                    const nextLyrics = (el as unknown as ChordRest).lyricsVerse(verse, placement)
                    if (nextLyrics) {
                        break
                    }
                }
            }
        } else {
            // search next chord
            while ((nextSegment = nextSegment!.next1(SegmentType.ChordRest))) {
                const el = nextSegment.element(track)
                if (!el) {
                    continue
                }
                if (el.isChord()) {
                    break
                } else if (el.isRest()) {
                    const nextLyrics = (el as unknown as ChordRest).lyricsVerse(verse, placement)
                    if (nextLyrics) {
                        break
                    }
                }
            }
        }
        if (!nextSegment) {
            return
        }

        this.endEditText()

        // look for the lyrics we are moving from; may be the current lyrics or a previous one
        // if we are skipping several chords with spaces
        let fromLyrics: Lyrics | null = null
        if (!back) {
            while (segment) {
                const cr = segment.element(track) as unknown as ChordRest | null
                if (cr) {
                    fromLyrics = cr.lyricsVerse(verse, placement)
                    if (fromLyrics) {
                        break
                    }
                }
                segment = segment.prev1(SegmentType.ChordRest)
            }
        }

        let cr = nextSegment.element(track) as unknown as ChordRest | null
        if (!cr) {
            return
        }
        let nextLyrics = cr.lyricsVerse(verse, placement)

        let newLyrics = false
        if (!nextLyrics) {
            nextLyrics = Factory.createItem(ElementType.LYRICS, cr) as Lyrics
            nextLyrics.setTrack(track)
            cr = nextSegment.element(track) as unknown as ChordRest
            nextLyrics.setParent(cr)
            nextLyrics.setVerse(verse)
            nextLyrics.setTextStyleType(styleType)
            nextLyrics.setPlacement(placement)
            nextLyrics.setPropertyFlags(Pid.PLACEMENT, pFlags)
            nextLyrics.setSyllabic(LyricsSyllabic.SINGLE)
            nextLyrics.setFontStyle(fStyle)
            nextLyrics.setPropertyFlags(Pid.FONT_STYLE, fFlags)
            newLyrics = true
        }

        this.score().startCmd(new TranslatableString('undoableAction', 'Navigate to lyrics'))
        if (fromLyrics && !moveOnly) {
            switch (nextLyrics.syllabic()) {
            // as we arrived at nextLyrics by a [Space], it can be the beginning
            // of a multi-syllable, but cannot have syllabic dashes before
            case LyricsSyllabic.SINGLE:
            case LyricsSyllabic.BEGIN:
                break
            case LyricsSyllabic.END:
                nextLyrics.undoChangeProperty(Pid.SYLLABIC, LyricsSyllabic.SINGLE)
                break
            case LyricsSyllabic.MIDDLE:
                nextLyrics.undoChangeProperty(Pid.SYLLABIC, LyricsSyllabic.BEGIN)
                break
            }
            // as we moved away from fromLyrics by a [Space], it can be
            // the end of a multi-syllable, but cannot have syllabic dashes after
            switch (fromLyrics.syllabic()) {
            case LyricsSyllabic.SINGLE:
            case LyricsSyllabic.END:
                break
            case LyricsSyllabic.BEGIN:
                fromLyrics.undoChangeProperty(Pid.SYLLABIC, LyricsSyllabic.SINGLE)
                break
            case LyricsSyllabic.MIDDLE:
                fromLyrics.undoChangeProperty(Pid.SYLLABIC, LyricsSyllabic.END)
                break
            }
            // for the same reason, it cannot have a melisma
            const separator = fromLyrics.separator() as unknown as { isEndMelisma(): boolean } | null
            if (separator && !separator.isEndMelisma()) {
                fromLyrics.undoChangeProperty(Pid.LYRIC_TICKS, Fraction.fromTicks(0))
            }
        }

        if (newLyrics) {
            this.score().undoAddElement(nextLyrics)
        }
        this.score().endCmd()
        this.score().select([nextLyrics], SelectType.SINGLE, 0)
        this.score().setLayoutAll()

        this.startEditText(nextLyrics, new PointF())

        const cursor = nextLyrics.cursor()
        if (end) {
            nextLyrics.selectAll(cursor)
        } else if (!newLyrics) {
            cursor.movePosition(TextCursorMoveOperation.End, TextCursorMoveMode.MoveAnchor)
            cursor.movePosition(TextCursorMoveOperation.Start, TextCursorMoveMode.KeepAnchor)
        }

        this.showItem(nextLyrics)
    }

    /** C++ navigateToLyrics(MoveDirection, bool moveOnly) */
    navigateToLyricsDirection(direction: MoveDirection, moveOnly: boolean): void {
        this.navigateToLyrics(direction === MoveDirection.Left, moveOnly, false)
    }

    /** Copied from ScoreView::lyricsMinus; TODO(port): partial lyrics dashes at repeats */
    navigateToNextSyllable(): void {
        if (!this.m_editData.element || !this.m_editData.element.isLyrics()) {
            return
        }
        const lyrics = this.m_editData.element as unknown as Lyrics
        const track = lyrics.track()
        let toLyricTrack = track
        let segment: Segment | null = lyrics.segment()
        const verse = lyrics.verse()
        const placement = lyrics.placement()
        const pFlags = lyrics.propertyFlags(Pid.PLACEMENT)
        const fStyle = lyrics.fontStyle()
        const fFlags = lyrics.propertyFlags(Pid.FONT_STYLE)
        const styleType = lyrics.textStyleType()

        // search next chord
        let nextSegment: Segment | null = segment
        while ((nextSegment = nextSegment!.next1(SegmentType.ChordRest))) {
            let el = nextSegment.element(track)
            if (!el || !el.isChord()) {
                const strack = trackZeroVoice(track)
                const etrack = strack + VOICES
                for (let t = strack; t < etrack; ++t) {
                    el = nextSegment.element(t)
                    if (el && el.isChord() && (el as unknown as Chord).lyricsVerse(verse, placement)) {
                        toLyricTrack = t
                        break
                    }
                }
            }

            if (el && el.isChord()) {
                break
            }
        }

        if (!segmentsAreAdjacent(segment, nextSegment)) {
            nextSegment = null
        }

        if (!nextSegment) {
            // TODO(port): dashes at repeats without end syllable, partial dashes (hasPrecedingRepeat/hasFollowingRepeat)
            return
        }

        this.endEditText()

        // look for the lyrics we are moving from; may be the current lyrics or a previous one
        // we are extending with several dashes
        let fromLyrics: Lyrics | null = null
        const curSeg = segment
        while (segment && segmentsAreAdjacent(segment, curSeg)) {
            const cr = segment.element(track) as unknown as ChordRest | null
            if (!cr) {
                segment = segment.prev1(SegmentType.ChordRest)
                continue
            }
            fromLyrics = cr.lyricsVerse(verse, placement)
            if (fromLyrics) {
                break
            }
            segment = segment.prev1(SegmentType.ChordRest)
        }

        this.score().startCmd(new TranslatableString('undoableAction', 'Navigate to next syllable'))
        let cr = nextSegment.element(toLyricTrack) as unknown as ChordRest | null
        let toLyrics = cr ? cr.lyricsVerse(verse, placement) : null

        if (!toLyrics && !cr) {
            this.score().endCmd()
            return
        }

        // If no lyrics in current track, check others
        if (!toLyrics) {
            const strack = trackZeroVoice(track)
            const etrack = strack + VOICES
            for (let t = strack; t < etrack; ++t) {
                if (t === track) {
                    continue
                }
                cr = nextSegment.element(t) as unknown as ChordRest | null
                if (cr) {
                    toLyrics = cr.lyricsVerse(verse, placement)
                    if (toLyrics) {
                        break
                    }
                }
            }
        }

        // Make sure we end up with either the cr of toLyrics or cr on correct track
        cr = !toLyrics ? nextSegment.element(track) as unknown as ChordRest : cr

        // TODO(port): disallow dashes between non-adjacent repeat sections (findPreviousRepeatMeasures)

        const newLyrics = !toLyrics
        if (!toLyrics) {
            const toLyricsChord = cr!
            toLyrics = Factory.createItem(ElementType.LYRICS, toLyricsChord) as Lyrics
            toLyrics.setTrack(track)
            toLyrics.setParent(toLyricsChord)

            toLyrics.setVerse(verse)
            toLyrics.setTextStyleType(styleType)

            toLyrics.setPlacement(placement)
            toLyrics.setPropertyFlags(Pid.PLACEMENT, pFlags)
            toLyrics.setSyllabic(LyricsSyllabic.END)
            toLyrics.setFontStyle(fStyle)
            toLyrics.setPropertyFlags(Pid.FONT_STYLE, fFlags)
        } else {
            // as we arrived at toLyrics by a dash, it cannot be initial or isolated
            if (toLyrics.syllabic() === LyricsSyllabic.BEGIN) {
                toLyrics.undoChangeProperty(Pid.SYLLABIC, LyricsSyllabic.MIDDLE)
            } else if (toLyrics.syllabic() === LyricsSyllabic.SINGLE) {
                toLyrics.undoChangeProperty(Pid.SYLLABIC, LyricsSyllabic.END)
            }
        }

        if (fromLyrics) {
            // as we moved away from fromLyrics by a dash,
            // it can have syll. dashes before and after but cannot be isolated or terminal
            switch (fromLyrics.syllabic()) {
            case LyricsSyllabic.BEGIN:
            case LyricsSyllabic.MIDDLE:
                break
            case LyricsSyllabic.SINGLE:
                fromLyrics.undoChangeProperty(Pid.SYLLABIC, LyricsSyllabic.BEGIN)
                break
            case LyricsSyllabic.END:
                fromLyrics.undoChangeProperty(Pid.SYLLABIC, LyricsSyllabic.MIDDLE)
                break
            }
            // for the same reason, it cannot have a melisma
            fromLyrics.undoChangeProperty(Pid.LYRIC_TICKS, new Fraction(0, 1))
        }

        if (newLyrics) {
            this.score().undoAddElement(toLyrics)
        }

        this.score().endCmd()
        this.score().select([toLyrics], SelectType.SINGLE, 0)
        this.score().setLayoutAll()

        this.startEditText(toLyrics, new PointF())

        toLyrics.selectAll(toLyrics.cursor())
        this.showItem(toLyrics)
    }

    /** Copied from ScoreView::lyricsUpDown */
    navigateToLyricsVerse(direction: MoveDirection): void {
        if (!this.m_editData.element || !this.m_editData.element.isLyrics()) {
            return
        }
        let lyrics = this.m_editData.element as unknown as Lyrics
        const track = lyrics.track()
        const cr = lyrics.chordRest()
        let verse = lyrics.verse()
        const placement = lyrics.placement()
        const pFlags = lyrics.propertyFlags(Pid.PLACEMENT)
        const fStyle = lyrics.fontStyle()
        const fFlags = lyrics.propertyFlags(Pid.FONT_STYLE)
        const styleType = lyrics.textStyleType()

        if (direction === MoveDirection.Up) {
            if (verse === 0) {
                return
            }
            --verse
        } else {
            ++verse
            if (verse > cr.lastVerse(placement)) {
                return
            }
        }

        this.endEditText()

        let l = cr.lyricsVerse(verse, placement)
        if (!l) {
            l = Factory.createItem(ElementType.LYRICS, cr) as Lyrics
            l.setTrack(track)
            l.setParent(cr)
            l.setVerse(verse)
            l.setTextStyleType(styleType)
            l.setPlacement(placement)
            l.setPropertyFlags(Pid.PLACEMENT, pFlags)
            l.setFontStyle(fStyle)
            l.setPropertyFlags(Pid.FONT_STYLE, fFlags)

            this.score().startCmd(new TranslatableString('undoableAction', 'Navigate to verse'))
            this.score().undoAddElement(l)
            this.score().endCmd()
        }

        this.score().select([l], SelectType.SINGLE, 0)
        this.startEditText(l, new PointF())

        lyrics = this.m_editData.element as unknown as Lyrics

        this.score().setLayoutAll()
        this.score().update()

        lyrics.selectAll(lyrics.cursor())
        this.showItem(lyrics)
    }

    addBoxes(boxType: BoxType, count: number, target: AddBoxesTarget): void {
        let beforeBoxIndex = -1
        let moveSignaturesClefs = target !== AddBoxesTarget.AfterSelection
        let selectedItem: EngravingItem | null = null
        let selectedItemMeasure: MeasureBase | null = null

        switch (target) {
        case AddBoxesTarget.AfterSelection:
        case AddBoxesTarget.BeforeSelection: {
            const selection = this.score().selection()
            if (selection.isNone()) {
                MScore.setError(MsError.NO_MEASURE_SELECTED)
                this.checkAndShowError()
                return
            }

            if (selection.isRange()) {
                const range = selection.measureRange()
                const startMeasureIndex = range ? range.m1.index() : 0
                const endMeasureIndex = range && range.m2 ? range.m2.index() + 1 : 0

                beforeBoxIndex = target === AddBoxesTarget.BeforeSelection
                    ? startMeasureIndex
                    : endMeasureIndex
                break
            }

            const elements = selection.elements()
            if (elements.length === 0) {
                // This would contradict the fact that selection()->isNone() == false at this point
                MScore.setError(MsError.NO_MEASURE_SELECTED)
                this.checkAndShowError()
                return
            }

            for (const item of elements) {
                const itemMeasure = item.findMeasureBase()
                if (!itemMeasure) {
                    continue
                }

                const itemMeasureIndex = itemMeasure.index()
                if (itemMeasureIndex < 0) {
                    continue
                }

                if (target === AddBoxesTarget.BeforeSelection) {
                    if (beforeBoxIndex < 0 || itemMeasureIndex < beforeBoxIndex) {
                        beforeBoxIndex = itemMeasureIndex
                        selectedItem = item
                        selectedItemMeasure = itemMeasure
                    }
                } else {
                    if (itemMeasureIndex + 1 > beforeBoxIndex) {
                        beforeBoxIndex = itemMeasureIndex + 1
                        selectedItem = item
                        selectedItemMeasure = itemMeasure
                    }
                }
            }

            const selectedIsValid = selectedItem && selectedItemMeasure
            const selectedItemType = selectedIsValid ? selectedItem!.type() : ElementType.INVALID

            // special cases for "between measures elements"
            switch (selectedItemType) {
            case ElementType.CLEF:
            case ElementType.BAR_LINE:
            case ElementType.TIMESIG:
            case ElementType.KEYSIG: {
                const itemTick = selectedItem!.tick()
                const measureTick = selectedItemMeasure!.tick()
                const measureLastTick = measureTick.plus(selectedItemMeasure!.ticks())

                if (itemTick.eq(measureTick)) {
                    if (target === AddBoxesTarget.AfterSelection) {
                        beforeBoxIndex -= 1
                    }
                    moveSignaturesClefs = target === AddBoxesTarget.AfterSelection
                } else if (itemTick.eq(measureLastTick)) {
                    if (target === AddBoxesTarget.BeforeSelection) {
                        beforeBoxIndex += 1
                    }
                    moveSignaturesClefs = target === AddBoxesTarget.AfterSelection
                }
                break
            }
            default: break
            }

            if (beforeBoxIndex < 0) {
                MScore.setError(MsError.NO_MEASURE_SELECTED)
                this.checkAndShowError()
                return
            }
            break
        }
        case AddBoxesTarget.AtStartOfScore: {
            const firstMeasure = this.score().firstMeasure()
            beforeBoxIndex = firstMeasure ? firstMeasure.index() : -1
            break
        }
        case AddBoxesTarget.AtEndOfScore:
            beforeBoxIndex = -1
            break
        }

        this.addBoxesAt(boxType, count, beforeBoxIndex, moveSignaturesClefs)
    }

    /** C++ addBoxes(BoxType, int count, int beforeBoxIndex, bool moveSignaturesClef) (renamed: no overloads in TS) */
    addBoxesAt(boxType: BoxType, count: number, beforeBoxIndex: number, moveSignaturesClef: boolean): void {
        if (count < 1) {
            return
        }

        const boxTypeToElementType = (boxType: BoxType): ElementType => {
            switch (boxType) {
            case BoxType.Horizontal: return ElementType.HBOX
            case BoxType.Vertical: return ElementType.VBOX
            case BoxType.Text: return ElementType.TBOX
            case BoxType.Fret: return ElementType.FBOX
            case BoxType.Measure: return ElementType.MEASURE
            case BoxType.Unknown: return ElementType.INVALID
            }

            return ElementType.INVALID
        }

        const elementType = boxTypeToElementType(boxType)
        if (elementType === ElementType.INVALID) {
            return
        }

        const boxTypeDescription = (boxType: BoxType): TranslatableString => {
            switch (boxType) {
            case BoxType.Horizontal: return new TranslatableString('undoableAction', 'Add horizontal frame')
            case BoxType.Vertical: return new TranslatableString('undoableAction', 'Add vertical frame')
            case BoxType.Text: return new TranslatableString('undoableAction', 'Add text frame')
            case BoxType.Fret: return new TranslatableString('undoableAction', 'Add fretboard diagram legend')
            case BoxType.Measure: return new TranslatableString('undoableAction', 'Add %Ln measure(s)', '', count)
            case BoxType.Unknown: break
            }

            return new TranslatableString()
        }

        this.startEdit(boxTypeDescription(boxType))

        const beforeBox = beforeBoxIndex >= 0 ? this.score().measure(beforeBoxIndex) : null

        const options = new InsertMeasureOptions()
        options.createEmptyMeasures = false
        options.moveSignaturesClef = moveSignaturesClef
        options.needDeselectAll = false
        options.cloneBoxToAllParts = boxType !== BoxType.Fret

        for (let i = 0; i < count; ++i) {
            this.score().insertMeasure(elementType, beforeBox, options)
        }

        this.apply()

        const indexOfFirstAddedMeasure = beforeBoxIndex >= 0 ? beforeBoxIndex : this.score().measures().size() - count
        const firstAddedMeasure = this.score().measure(indexOfFirstAddedMeasure)
        this.doSelect([firstAddedMeasure!], SelectType.REPLACE, 0, false)
        this.showItem(firstAddedMeasure)

        // For other box types, it makes little sense to select them all
        if (boxType === BoxType.Measure) {
            this.doSelect([this.score().measure(indexOfFirstAddedMeasure + count - 1)!], SelectType.RANGE, 0, false)
        }

        this.notifyAboutSelectionChangedIfNeed()
    }

    // ---------------------------------------------------------------------------------
    //   Tools menu (split/join measures, voices, explode/implode, chord symbols, slashes, spelling, ...)
    // ---------------------------------------------------------------------------------

    splitSelectedMeasure(): void {
        let selectedElement = this.score().selection().element()
        if (!selectedElement) {
            return
        }

        if (!selectedElement.isNote() && !selectedElement.isRest()) {
            return
        }

        if (selectedElement.isNote()) {
            selectedElement = (selectedElement as unknown as Note).chord()
        }

        const chordRest = selectedElement as unknown as ChordRest

        this.startEdit(new TranslatableString('undoableAction', 'Split measure'))
        SplitJoinMeasure.splitMeasure(this.score().masterScore(), chordRest.tick())
        this.apply()

        this.checkAndShowError()
    }

    joinSelectedMeasures(): void {
        if (!this.score().selection().isRange()) {
            return
        }

        const measureRange = this.score().selection().measureRange()!

        this.startEdit(new TranslatableString('undoableAction', 'Join measures'))
        SplitJoinMeasure.joinMeasures(this.score().masterScore(), measureRange.m1.tick(), measureRange.m2!.tick())
        this.apply()

        this.checkAndShowError()
    }

    swapVoices(voiceIndex1: voice_idx_t, voiceIndex2: voice_idx_t): void {
        if (this.score().selection().isNone()) {
            return
        }

        if (voiceIndex1 === voiceIndex2) {
            return
        }

        if (voiceIndex1 < 0 || voiceIndex1 >= VOICES || voiceIndex2 < 0 || voiceIndex2 >= VOICES) {
            return
        }

        this.startEdit(new TranslatableString('undoableAction', 'Swap voices'))
        this.score().cmdExchangeVoice(voiceIndex1, voiceIndex2)
        this.apply()
    }

    explodeSelectedStaff(): void {
        if (!this.score().selection().isRange()) {
            return
        }

        this.startEdit(new TranslatableString('undoableAction', 'Explode'))
        if (this.score().cmdExplode()) {
            this.apply()
        } else {
            this.rollback()
        }

        this.checkAndShowError()
    }

    implodeSelectedStaff(): void {
        if (!this.score().selection().isRange()) {
            return
        }

        this.startEdit(new TranslatableString('undoableAction', 'Implode'))
        if (this.score().cmdImplode()) {
            this.apply()
        } else {
            this.rollback()
        }

        this.checkAndShowError()
    }

    realizeSelectedChordSymbols(literal = true, voicing: Voicing = Voicing.INVALID, durationType: HDuration = HDuration.INVALID): void {
        if (this.score().selection().isNone()) {
            return
        }

        this.startEdit(new TranslatableString('undoableAction', 'Realize chord symbols'))
        this.score().cmdRealizeChordSymbols(literal, voicing, durationType)
        this.apply()
    }

    removeSelectedRange(): void {
        if (this.score().selection().isNone()) {
            return
        }

        this.startEdit(new TranslatableString('undoableAction', 'Delete range'))
        this.score().cmdTimeDelete()
        this.apply()
    }

    removeEmptyTrailingMeasures(): void {
        this.startEdit(new TranslatableString('undoableAction', 'Remove empty trailing measures'))
        this.score().cmdRemoveEmptyTrailingMeasures()
        this.apply()
    }

    fillSelectionWithSlashes(): void {
        if (this.score().selection().isNone()) {
            return
        }

        this.startEdit(new TranslatableString('undoableAction', 'Fill with slashes'))
        this.score().cmdSlashFill()
        this.apply()
    }

    replaceSelectedNotesWithSlashes(): void {
        if (this.score().selection().isNone()) {
            return
        }

        this.startEdit(new TranslatableString('undoableAction', 'Toggle rhythmic slash notation'))
        this.score().cmdSlashRhythm()
        this.apply()
    }

    changeEnharmonicSpelling(both: boolean): void {
        this.startEdit(new TranslatableString('undoableAction', 'Change enharmonic spelling'))
        this.score().changeEnharmonicSpelling(both)
        this.apply()
    }

    spellPitches(): void {
        this.startEdit(new TranslatableString('undoableAction', 'Optimize enharmonic spelling'))
        this.score().spell()
        this.apply()
    }

    spellPitchesWithSharps(): void {
        this.startEdit(new TranslatableString('undoableAction', 'Respell pitches with sharps'))
        this.score().spellWithSharpsOrFlats(Prefer.SHARPS)
        this.apply()
    }

    spellPitchesWithFlats(): void {
        this.startEdit(new TranslatableString('undoableAction', 'Respell pitches with flats'))
        this.score().spellWithSharpsOrFlats(Prefer.FLATS)
        this.apply()
    }

    regroupNotesAndRests(): void {
        this.startEdit(new TranslatableString('undoableAction', 'Regroup rhythms'))
        this.score().cmdResetNoteAndRestGroupings()
        this.apply()
    }

    // ---- the Format menu ----

    addStretch(value: number): void {
        this.startEdit(value >= 0
            ? new TranslatableString('undoableAction', 'Increase layout stretch')
            : new TranslatableString('undoableAction', 'Decrease layout stretch'))
        this.score().cmdAddStretch(value)
        this.apply()
    }

    resetStretch(): void {
        this.startEdit(new TranslatableString('undoableAction', 'Reset layout stretch'))
        this.score().resetUserStretch()
        this.apply()
    }

    resetTextStyleOverrides(): void {
        this.startEdit(new TranslatableString('undoableAction', 'Reset text style overrides'))
        this.score().cmdResetTextStyleOverrides()
        this.apply()
    }

    resetBeamMode(): void {
        this.startEdit(new TranslatableString('undoableAction', 'Reset beams'))
        this.score().cmdResetBeamMode()
        this.apply()
    }

    resetShapesAndPosition(): void {
        const resetItem = (item: EngravingItem): void => {
            item.reset()

            if (item.isSpanner()) {
                for (const spannerSegment of (item as Spanner).spannerSegments()) {
                    spannerSegment.reset()
                }
            }
        }

        this.startEdit(new TranslatableString('undoableAction', 'Reset shapes and positions'))

        const element = this.score().selection().element()
        if (element) {
            resetItem(element)
        } else {
            for (const item of [...this.score().selection().elements()]) {
                resetItem(item)
            }
        }

        this.apply()
    }

    resetToDefaultLayout(): void {
        this.startEdit(new TranslatableString('undoableAction', 'Reset to default layout'))
        this.score().cmdResetToDefaultLayout()
        this.apply()
    }

    // ---- system locks ----

    addRemoveSystemLocks(intervalType: AddRemoveSystemLockType, interval: number): void {
        interval = intervalType === AddRemoveSystemLockType.MeasuresInterval ? interval : 0
        const afterEachSystem = intervalType === AddRemoveSystemLockType.AfterEachSystem

        this.startEdit(new TranslatableString('undoableAction', 'Measures per system'))
        EditSystemLocks.addRemoveSystemLocks(this.score(), interval, afterEachSystem)
        this.apply()
    }

    applySystemLock(): void {
        this.startEdit(new TranslatableString('undoableAction', 'Apply system lock to selection'))
        EditSystemLocks.applyLockToSelection(this.score())
        this.apply()
    }

    moveMeasureToPrevSystem(): void {
        const m = this.score().selection().endMeasureBase()
        if (!m) {
            return
        }
        this.startEdit(new TranslatableString('undoableAction', 'Move measure to previous system'))
        EditSystemLocks.moveMeasureToPrevSystem(this.score(), m)
        this.apply()
    }

    moveMeasureToNextSystem(): void {
        const m = this.score().selection().startMeasureBase()
        if (!m) {
            return
        }
        this.startEdit(new TranslatableString('undoableAction', 'Move measure to next system'))
        EditSystemLocks.moveMeasureToNextSystem(this.score(), m)
        this.apply()
    }

    toggleSystemLock(): void {
        this.startEdit(new TranslatableString('undoableAction', 'Lock/unlock selected system(s)'))
        EditSystemLocks.toggleSystemLock(this.score(), this.score().selection().selectedSystems())
        this.apply()
    }

    toggleScoreLock(): void {
        this.startEdit(new TranslatableString('undoableAction', 'Lock/unlock all systems'))
        EditSystemLocks.toggleScoreLock(this.score())
        this.apply()
    }

    makeIntoSystem(): void {
        const first = this.score().selection().startMeasureBase()
        const last = this.score().selection().endMeasureBase()
        if (!first || !last) {
            return
        }

        this.startEdit(new TranslatableString('undoableAction', 'Create system from selection'))
        EditSystemLocks.makeIntoSystem(this.score(), first, last)
        this.apply()
    }

    resequenceRehearsalMarks(): void {
        this.startEdit(new TranslatableString('undoableAction', 'Resequence rehearsal marks'))
        this.score().cmdResequenceRehearsalMarks()
        this.apply()
    }

    copyLyrics(): void {
        const text = this.score().extractLyrics()
        clipboard().setText(text)
    }

    addFretboardDiagram(): void {
        const score = this.score()

        const selection = score.selection()
        const filteredElements: EngravingItem[] = []

        if (selection && !selection.isNone()) {
            let selectedElements: readonly EngravingItem[]

            const element = selection.element()
            if (element) {
                selectedElements = [element]
            } else {
                selectedElements = selection.elements()
            }

            for (const element of selectedElements) {
                if (!element || !element.isHarmony()) {
                    continue
                }

                if (!element.explicitParent()!.isFretDiagram()) {
                    filteredElements.push(element)
                }
            }
        }

        if (filteredElements.length === 0) {
            MScore.setError(MsError.NO_NOTE_REST_HARMONY_SELECTED)
            this.checkAndShowError()
            return
        }

        this.startEdit(new TranslatableString('undoableAction', 'Add fretboard diagram'))

        let lastAddedDiagram: FretDiagram | null = null
        const created: FretDiagram[] = []

        for (const element of filteredElements) {
            const diagram = Factory.createItem(ElementType.FRET_DIAGRAM, scoreDummy(score).segment()) as unknown as FretDiagram
            diagram.setTrack(element.track())

            const harmony = element as unknown as Harmony
            diagram.updateDiagram(harmony.harmonyName())

            diagram.setParent(harmony.parent())
            score.undoAddElement(diagram)
            created.push(diagram)
            lastAddedDiagram = diagram
        }

        for (let i = created.length - 1; i >= 0; --i) {
            const diagram = created[i]
            const harmony = filteredElements[i]

            score.undoChangeParent(harmony, diagram, track2staff(filteredElements[i].track()))
        }

        this.apply()

        if (lastAddedDiagram) {
            this.select([lastAddedDiagram], SelectType.SINGLE)
        }
    }

    addFiguredBass(): void {
        const REQUIRED_TYPES = [
            ElementType.NOTE,
            ElementType.FIGURED_BASS,
            ElementType.REST,
        ]

        if (!this.score().selection().elementsSelected(REQUIRED_TYPES)) {
            MScore.setError(MsError.NO_NOTE_FIGUREDBASS_SELECTED)
            this.checkAndShowError()
            return
        }

        this.startEdit(new TranslatableString('undoableAction', 'Add figured bass'))
        const figuredBass = this.score().addFiguredBass()

        if (figuredBass) {
            this.apply()
            this.startEditText(figuredBass, new PointF())
            this.notifyAboutSelectionChangedIfNeed()
        } else {
            this.rollback()
        }
    }

    /** Copied from ScoreView::lyricsUnderscore; TODO(port): partial melisma lines at repeats */
    addMelisma(): void {
        if (!this.m_editData.element || !this.m_editData.element.isLyrics()) {
            return
        }
        const lyrics = this.m_editData.element as unknown as Lyrics
        const track = lyrics.track()
        let segment: Segment | null = lyrics.segment()
        const verse = lyrics.verse()
        const placement = lyrics.placement()
        const pFlags = lyrics.propertyFlags(Pid.PLACEMENT)
        const fStyle = lyrics.fontStyle()
        const fFlags = lyrics.propertyFlags(Pid.FONT_STYLE)
        const endTick = segment.tick() // a previous melisma cannot extend beyond this point
        this.endEditText()

        // search next chord
        let nextSegment: Segment | null = segment
        while ((nextSegment = nextSegment!.next1(SegmentType.ChordRest))) {
            const el = nextSegment.element(track)
            if (el && el.isChord()) {
                break
            }
        }

        if (!segmentsAreAdjacent(segment, nextSegment)) {
            nextSegment = null
        }

        // look for the lyrics we are moving from; may be the current lyrics or a previous one
        // we are extending with several underscores
        const curSeg = segment
        let fromLyrics: Lyrics | null = null
        while (segment && segmentsAreAdjacent(segment, curSeg)) {
            const cr = segment.element(track) as unknown as ChordRest | null
            if (cr) {
                fromLyrics = cr.lyricsVerse(verse, placement)
                if (fromLyrics) {
                    break
                }
                // TODO(port): a partial melisma to extend (PartialLyricsLine)
            }
            segment = segment.prev1(SegmentType.ChordRest)
            // if the segment has a rest in this track, stop going back
            const e = segment ? segment.element(track) : null
            if (e && !e.isChord()) {
                break
            }
        }

        // one-chord melisma?
        // if still at melisma initial chord and there is a valid next chord (if not,
        // there will be no melisma anyway), set a temporary melisma duration
        if (fromLyrics === lyrics && nextSegment) {
            this.score().startCmd(new TranslatableString('undoableAction', 'Enter lyrics extension line'))
            lyrics.undoChangeProperty(Pid.LYRIC_TICKS, Lyrics.TEMP_MELISMA_TICKS)
            this.score().setLayoutAll()
            this.score().endCmd()
        }

        if (!nextSegment) {
            this.score().startCmd(new TranslatableString('undoableAction', 'Enter lyrics extension line'))
            if (fromLyrics) {
                switch (fromLyrics.syllabic()) {
                case LyricsSyllabic.SINGLE:
                case LyricsSyllabic.END:
                    break
                default:
                    fromLyrics.undoChangeProperty(Pid.SYLLABIC, LyricsSyllabic.END)
                    break
                }
                const initialCR = lyrics.chordRest()
                if (fromLyrics.segment().tick().lt(endTick)
                    || (endTick.plus(initialCR.actualTicks()).eq(segment!.measure().endTick()) && initialCR.hasFollowingJumpItem())) {
                    const t = endTick.minus(fromLyrics.segment().tick())
                    const ticks = t.gt(Lyrics.TEMP_MELISMA_TICKS) ? t : Lyrics.TEMP_MELISMA_TICKS
                    fromLyrics.undoChangeProperty(Pid.LYRIC_TICKS, ticks)
                }
            }

            // TODO(port): incoming partial melisma after a repeat (PartialLyricsLine)

            if (fromLyrics) {
                this.score().select([fromLyrics], SelectType.SINGLE, 0)
            }
            this.score().setLayoutAll()
            this.score().endCmd()
            return
        }

        // if a place for a new lyrics has been found, create a lyrics there
        const nextCR = nextSegment.element(track) as unknown as ChordRest

        // TODO(port): disallow melisma lines between non-adjacent repeat sections (findPreviousRepeatMeasures)

        this.score().startCmd(new TranslatableString('undoableAction', 'Enter lyrics extension line'))
        let toLyrics = nextCR.lyricsVerse(verse, placement)
        const newLyrics = toLyrics === null
        if (!toLyrics) {
            toLyrics = Factory.createItem(ElementType.LYRICS, nextCR) as Lyrics
            toLyrics.setTrack(track)
            toLyrics.setParent(nextCR)

            toLyrics.setVerse(verse)
            const styleType = toLyrics.isEven() ? TextStyleType.LYRICS_EVEN : TextStyleType.LYRICS_ODD
            toLyrics.setTextStyleType(styleType)

            toLyrics.setPlacement(placement)
            toLyrics.setPropertyFlags(Pid.PLACEMENT, pFlags)
            toLyrics.setSyllabic(LyricsSyllabic.SINGLE)
            toLyrics.setFontStyle(fStyle)
            toLyrics.setPropertyFlags(Pid.FONT_STYLE, fFlags)
        } else if (toLyrics.syllabic() === LyricsSyllabic.MIDDLE) {
            // as we arrived at toLyrics by an underscore, it cannot have syllabic dashes before
            toLyrics.undoChangeProperty(Pid.SYLLABIC, LyricsSyllabic.BEGIN)
        } else if (toLyrics.syllabic() === LyricsSyllabic.END) {
            toLyrics.undoChangeProperty(Pid.SYLLABIC, LyricsSyllabic.SINGLE)
        }

        if (fromLyrics) {
            // as we moved away from fromLyrics by an underscore,
            // it can be isolated or terminal but cannot have dashes after
            switch (fromLyrics.syllabic()) {
            case LyricsSyllabic.SINGLE:
            case LyricsSyllabic.END:
                break
            default:
                fromLyrics.undoChangeProperty(Pid.SYLLABIC, LyricsSyllabic.END)
                break
            }
            // for the same reason, if it has a melisma, this cannot extend beyond toLyrics
            if (fromLyrics.segment().tick().lt(endTick)) {
                fromLyrics.undoChangeProperty(Pid.LYRIC_TICKS, endTick.minus(fromLyrics.segment().tick()))
            }
        }
        this.score().endCmd()

        this.score().startCmd(new TranslatableString('undoableAction', 'Enter lyrics extension line'))
        if (newLyrics) {
            this.score().undoAddElement(toLyrics)
        }
        this.score().endCmd()

        this.score().select([toLyrics], SelectType.SINGLE, 0)
        this.startEditText(toLyrics, new PointF())

        toLyrics.selectAll(toLyrics.cursor())
    }

    /** Copied from ScoreView::lyricsReturn */
    addLyricsVerse(): void {
        if (!this.m_editData.element || !this.m_editData.element.isLyrics()) {
            return
        }
        const oldLyrics = this.m_editData.element as unknown as Lyrics
        const fStyle = oldLyrics.fontStyle()
        const fFlags = oldLyrics.propertyFlags(Pid.FONT_STYLE)

        this.endEditText()

        this.score().startCmd(new TranslatableString('undoableAction', 'Add lyrics verse'))
        const newVerse = oldLyrics.verse() + 1

        const lyrics = Factory.createItem(ElementType.LYRICS, oldLyrics.chordRest()) as Lyrics
        lyrics.setTrack(oldLyrics.track())
        lyrics.setParent(oldLyrics.chordRest())
        lyrics.setPlacement(oldLyrics.placement())
        lyrics.setPropertyFlags(Pid.PLACEMENT, oldLyrics.propertyFlags(Pid.PLACEMENT))

        lyrics.setVerse(newVerse)
        const styleType = lyrics.isEven() ? TextStyleType.LYRICS_EVEN : TextStyleType.LYRICS_ODD
        lyrics.setTextStyleType(styleType)

        lyrics.setFontStyle(fStyle)
        lyrics.setPropertyFlags(Pid.FONT_STYLE, fFlags)

        this.score().undoAddElement(lyrics)
        this.score().endCmd()

        this.score().select([lyrics], SelectType.SINGLE, 0)
        this.startEditText(lyrics, new PointF())
    }

    // ---------------------------------------------------------------------------------
    //   chord symbol navigation (Space, Shift+Space, Tab while editing a chord symbol)
    // ---------------------------------------------------------------------------------

    private editedHarmony(): Harmony | null {
        const e = this.m_editData.element
        if (!e || !e.isHarmony()) {
            return null
        }
        const harmony = e as unknown as Harmony
        if (!harmony.parent() || (!harmony.parent()!.isSegment() && !harmony.parent()!.isFretDiagram())) {
            return null
        }
        return harmony
    }

    private harmonySegment(harmony: Harmony | null): Segment | null {
        if (!harmony || !harmony.parent()) {
            return null
        }

        const parent = harmony.parent()!
        let segment = parent.isSegment() ? parent as unknown as Segment : null
        if (!segment && parent.isFretDiagram()) {
            segment = (parent as unknown as FretDiagram).segment()
        }

        return segment
    }

    private findHarmonyInSegment(segment: Segment, track: track_idx_t, textStyleType: TextStyleType): Harmony | null {
        for (const e of segment.annotations()) {
            if (!e.isHarmony() && !e.isFretDiagram()) {
                continue
            }

            let harmony = e.isHarmony() ? e as unknown as Harmony : null
            if (e.isFretDiagram()) {
                harmony = (e as unknown as FretDiagram).harmony()
            }

            if (!harmony) {
                continue
            }

            if (harmony.track() === track && harmony.textStyleType() === textStyleType) {
                return harmony
            }
        }

        return null
    }

    private createHarmony(segment: Segment, track: track_idx_t, type: HarmonyType): Harmony {
        const harmony = Factory.createItem(ElementType.HARMONY, scoreDummy(this.score()).segment()) as Harmony
        harmony.setScore(this.score())
        harmony.setParent(segment)
        harmony.setTrack(track)
        harmony.setHarmonyType(type)

        return harmony
    }

    /** Copied from ScoreView::harmonyBeatsTab */
    navigateToNearHarmony(direction: MoveDirection, nearNoteOrRest: boolean): void {
        const harmony = this.editedHarmony()
        if (!harmony) {
            return
        }

        let segment = this.harmonySegment(harmony)
        if (!segment) {
            return
        }

        let measure: Measure | null = segment.measure()
        const tick = segment.tick()
        const track = harmony.track()
        const backDirection = direction === MoveDirection.Left

        if (backDirection && tick.eq(measure.tick())) {
            // previous bar, if any
            measure = measure.prevMeasure()
            if (!measure) {
                return
            }
        }

        const f = measure.ticks()
        const ticksPerBeat = Math.trunc(f.ticks()
            / ((f.numerator() > 3 && (f.numerator() % 3) === 0 && f.denominator() > 4) ? f.numerator() / 3 : f.numerator()))
        const tickInBar = tick.minus(measure.tick())
        const newTick = measure.tick().plus(Fraction.fromTicks(
            Math.trunc((tickInBar.ticks() + (backDirection ? -1 : ticksPerBeat)) / ticksPerBeat) * ticksPerBeat))

        this.endEditText()

        this.startEdit(new TranslatableString('undoableAction', 'Navigate to next chord symbol'))

        // look for next/prev beat, note, rest or chord
        for (;;) {
            segment = backDirection ? segment!.prev1(SegmentType.ChordRest) : segment!.next1(SegmentType.ChordRest)

            if (!segment || (backDirection ? segment.tick().lt(newTick) : segment.tick().gt(newTick))) {
                // no segment or moved past the beat - create new segment
                if (!backDirection && newTick.ge(measure.tick().plus(f))) {
                    // next bar, if any
                    measure = measure.nextMeasure()
                    if (!measure) {
                        this.rollback()
                        return
                    }
                }

                segment = measure.undoGetSegment(SegmentType.ChordRest, newTick)
                break
            }

            if (segment.tick().eq(newTick)) {
                break
            }

            if (nearNoteOrRest) {
                const minTrack = trackZeroVoice(track)
                const maxTrack = minTrack + VOICES - 1
                if (segment.hasAnnotationOrElement(ElementType.HARMONY, minTrack, maxTrack)) {
                    break
                }
            }
        }

        let nextHarmony = this.findHarmonyInSegment(segment, track, harmony.textStyleType())
        if (!nextHarmony) {
            nextHarmony = this.createHarmony(segment, track, harmony.harmonyType())
            this.score().undoAddElement(nextHarmony)
        }

        this.apply()
        this.startEditTextAtEnd(nextHarmony)
        this.showItem(nextHarmony)
    }

    /** Copied from ScoreView::harmonyTab */
    navigateToHarmonyInNearMeasure(direction: MoveDirection): void {
        const harmony = this.editedHarmony()
        if (!harmony) {
            return
        }

        let segment = this.harmonySegment(harmony)
        if (!segment) {
            return
        }

        // moving to next/prev measure
        let measure: Measure | null = segment.measure()
        if (measure) {
            measure = direction === MoveDirection.Left ? measure.prevMeasure() : measure.nextMeasure()
        }

        if (!measure) {
            return
        }

        segment = measure.findSegment(SegmentType.ChordRest, measure.tick())
        if (!segment) {
            return
        }

        const track = harmony.track()

        this.doEndEditElement()

        let nextHarmony = this.findHarmonyInSegment(segment, track, harmony.textStyleType())
        if (!nextHarmony) {
            nextHarmony = this.createHarmony(segment, track, harmony.harmonyType())

            this.startEdit(new TranslatableString('undoableAction', 'Navigate to next chord symbol'))
            this.score().undoAddElement(nextHarmony)
            this.apply()
        }

        this.startEditTextAtEnd(nextHarmony)
        this.showItem(nextHarmony)
    }

    // =================================================================================================================
    //   drag (elements, grips, lasso): startDrag / drag / endDrag, startEditGrip
    // =================================================================================================================

    private m_dragData = new DragData()
    private m_lasso: Lasso | null = null
    private m_dragChanged = new Notification()

    dragChanged(): Notification { return this.m_dragChanged }
    private notifyAboutDragChanged(): void { this.m_dragChanged.notify() }

    isDragStarted(): boolean {
        if (this.m_dragData.dragGroups.length > 0) {
            return true
        }

        if (this.m_lasso && !this.m_lasso.isEmpty()) {
            return true
        }

        return false
    }

    /** modifiers: C++ QGuiApplication::keyboardModifiers() (KeyboardModifier flags) */
    startDrag(elems: readonly EngravingItem[], eoffset: PointF, isDraggable: (e: EngravingItem) => boolean, modifiers = 0): void {
        this.m_dragData.reset()
        this.m_dragData.elements = [...elems]
        this.m_dragData.elementOffset = eoffset.clone()
        this.m_editData.modifiers = modifiers

        for (const e of this.m_dragData.elements) {
            let draggable = isDraggable(e)

            if (!draggable && e.isSpanner()) {
                const s = e as unknown as Spanner
                draggable = s.spannerSegments().length > 0 && isDraggable(s.spannerSegments()[0])
            }

            if (!draggable) {
                continue
            }

            const g = e.getDragGroup(isDraggable)
            if (g && g.enabled()) {
                this.m_dragData.dragGroups.push(g)
            }
        }

        this.startEdit(new TranslatableString('undoableAction', 'Drag element(s)', undefined, this.m_dragData.elements.length))

        // TODO(port): m_scoreCallbacks.setSelectionProximity (used by the drop of elements)

        if (this.isGripEditStarted()) {
            this.m_editData.element!.startDragGrip(this.m_editData)
            return
        }

        this.m_dragData.ed.modifiers = modifiers
        for (const group of this.m_dragData.dragGroups) {
            group.startDrag(this.m_dragData.ed)
        }
    }

    private doDragLasso(pt: PointF): void {
        if (!this.m_lasso) {
            this.m_lasso = new Lasso(this.score())
        }

        const r = new RectF()
        r.setCoords(this.m_dragData.beginMove.x(), this.m_dragData.beginMove.y(), pt.x(), pt.y())
        this.m_lasso.mutldata().setBbox(r.normalized())
        this.score().lassoSelect(this.m_lasso.ldata().bbox())
        this.score().update()
    }

    private endLasso(): void {
        if (!this.m_lasso) {
            return
        }

        this.m_lasso.mutldata().setBbox(new RectF())
        this.score().lassoSelectEnd()
        this.score().update()
    }

    /** the lasso rectangle (canvas coordinates) while it is dragged, null otherwise */
    lassoRect(): RectF | null {
        return this.m_lasso && !this.m_lasso.isEmpty() ? this.m_lasso.ldata().bbox().clone() : null
    }

    drag(fromPos: PointF, toPos: PointF, mode: DragMode, modifiers = 0): void {
        // C++ m_dragData.ed = EditData(&m_scoreCallbacks): the view callbacks of the dragged items
        this.m_dragData.ed.view ??= this.scoreCallbacks()
        if (this.m_dragData.beginMove.isNull()) {
            this.m_dragData.beginMove = fromPos.clone()
            this.m_dragData.ed.pos = fromPos.clone()
        }

        const normalizedBegin = this.m_dragData.beginMove.minus(this.m_dragData.elementOffset)
        const delta = toPos.minus(normalizedBegin)
        const evtDelta = toPos.minus(this.m_dragData.ed.pos)
        const moveDelta = delta.minus(this.m_dragData.elementOffset)

        const constrainDirection = !(this.isGripEditStarted() && this.m_editData.element && this.m_editData.element.isBarLine())
        if (constrainDirection) {
            switch (mode) {
            case DragMode.BothXY:
                break
            case DragMode.OnlyX:
                delta.setY(this.m_dragData.ed.delta.y())
                moveDelta.setY(this.m_dragData.ed.moveDelta.y())
                evtDelta.setY(0.0)
                break
            case DragMode.OnlyY:
                delta.setX(this.m_dragData.ed.delta.x())
                moveDelta.setX(this.m_dragData.ed.moveDelta.x())
                evtDelta.setX(0.0)
                break
            }
        }

        this.m_dragData.ed.lastPos = this.m_dragData.ed.pos.clone()

        this.m_dragData.ed.hRaster = false // C++ configuration()->isSnappedToGrid(Horizontal)
        this.m_dragData.ed.vRaster = false
        this.m_dragData.ed.delta = delta
        this.m_dragData.ed.moveDelta = moveDelta
        this.m_dragData.ed.evtDelta = evtDelta
        this.m_dragData.ed.pos = toPos.clone()
        this.m_dragData.ed.modifiers = modifiers

        this.m_dragData.ed.isEditMode = this.isEditingElement()

        if (this.isTextEditingStarted()) {
            this.m_editData.pos = toPos.clone()
            ;(this.m_editData.element as unknown as TextBase).dragTo(this.m_editData)

            this.notifyAboutTextEditingChanged()
            return
        }

        if (this.isGripEditStarted()) {
            this.m_dragData.ed.curGrip = this.m_editData.curGrip
            this.m_dragData.ed.delta = evtDelta
            this.m_dragData.ed.moveDelta = this.m_dragData.ed.delta.minus(this.m_dragData.elementOffset)
            this.m_dragData.ed.addData(this.m_editData.getData(this.m_editData.element))
            this.m_editData.element!.dragGrip(this.m_dragData.ed)

            // TODO(port): dynamics: addHairpinOnGripDrag
        } else {
            for (const group of this.m_dragData.dragGroups) {
                group.drag(this.m_dragData.ed)
            }
        }

        this.score().update()

        if (this.isGripEditStarted()) {
            if (this.m_editData.element!.isDynamic() && !this.m_editData.isStartEndGrip()) {
                this.updateDragAnchorLines()
            } else {
                this.updateGripAnchorLines()
            }
        } else {
            this.updateDragAnchorLines()
        }

        if (this.m_dragData.elements.length === 0) {
            this.doDragLasso(toPos)
        }

        this.notifyAboutDragChanged()
    }

    doEndDrag(): void {
        if (this.isGripEditStarted()) {
            this.m_editData.element!.endDragGrip(this.m_editData)
            this.m_editData.element!.endEdit(this.m_editData)
        } else {
            for (const group of this.m_dragData.dragGroups) {
                group.endDrag(this.m_dragData.ed)
            }
            if (this.m_lasso && !this.m_lasso.isEmpty()) {
                this.endLasso()
            }
        }

        this.m_dragData.reset()

        if (this.m_dropData) {
            this.setDropTarget(null, false)
        } else {
            this.resetAnchorLines()
        }
    }

    endDrag(): void {
        this.doEndDrag()
        this.apply()

        if (this.m_editData.isHairpinDragCreatedFromDynamic) {
            // Merge the two actions of hairpin creation + hairpin drag
            this.m_undoStack.mergeCommands(this.m_undoStack.currentStateIndex() - 2)
        }

        this.notifyAboutDragChanged()
        this.checkAndShowError()
    }

    isGripEditStarted(): boolean {
        return !!this.m_editData.element && this.m_editData.curGrip !== Grip.NO_GRIP
    }

    isHitGrip(pos: PointF): boolean {
        return !!this.score().selection().element() && findGrip(this.m_editData.grip, pos) !== -1
    }

    /** C++ startEditGrip(const PointF& pos) */
    startEditGrip(pos: PointF): void {
        const grip = findGrip(this.m_editData.grip, pos)
        if (grip === -1) {
            return
        }
        this.startEditGripFor(this.score().selection().element()!, grip as Grip)
    }

    /** C++ startEditGrip(EngravingItem*, Grip) */
    startEditGripFor(element: EngravingItem, grip: Grip): void {
        if (this.m_editData.element === element && this.m_editData.curGrip === grip) {
            return
        }

        this.m_editData.element = element
        this.m_editData.curGrip = grip

        this.updateGripAnchorLines()
        this.m_editData.element.startEdit(this.m_editData)

        this.notifyAboutNotationChanged()
    }

    updateGripAnchorLines(): void {
        if (!this.m_editData.element) {
            return
        }

        const lines: LineF[] = []
        const anchorLinesGrip = this.m_editData.curGrip === Grip.NO_GRIP
            ? this.m_editData.element.defaultGrip() : this.m_editData.curGrip
        const anchorLines = this.m_editData.element.gripAnchorLines(anchorLinesGrip)

        for (const line of anchorLines) {
            if (!line.p1().equals(line.p2())) {
                lines.push(line)
            }
        }

        this.setAnchorLines(lines)
    }

    updateDragAnchorLines(): void {
        const anchorLines: LineF[] = []
        for (const e of this.score().selection().elements()) {
            anchorLines.push(...e.dragAnchorLines())
        }

        this.setAnchorLines(anchorLines)
    }

    endEditGrip(): void {
        if (this.m_editData.curGrip === Grip.NO_GRIP) {
            return
        }

        this.m_editData.curGrip = Grip.NO_GRIP
        this.notifyAboutNotationChanged()
    }

    // =================================================================================================================
    //   painting of the edit mode (C++ drawTextEditMode, drawGripPoints, drawLasso of the notation view)
    // =================================================================================================================

    /** EditModeRenderer::drawTextBase: the text cursor, the selected text and the frame of the edited text */
    drawTextEditMode(painter: Painter, scaling: number, opt: PaintOptions): void {
        if (!this.isTextEditingStarted()) {
            return
        }

        EditModeRenderer.drawItem(this.m_editData.element!, painter, this.m_editData, scaling, opt)
    }

    /** the grips of the edited element (grip edit); C++ also updates EditData.grip for the hit test of the grips */
    drawGripPoints(painter: Painter, scaling: number, opt: PaintOptions): void {
        if (this.isDragStarted() && !this.isGripEditStarted()) {
            return
        }

        const editedElement = this.m_editData.element
        // TODO(port): dynamics: grips of the selected dynamic (findAdjacentHairpins)

        const gripsCount = editedElement ? editedElement.gripsCount() : 0

        if (gripsCount === 0) {
            return
        }

        this.updateGrips(scaling)
        EditModeRenderer.drawItem(editedElement!, painter, this.m_editData, scaling, opt)
    }

    /** fills EditData.grip (canvas coordinates) for the given view scaling (C++ part of drawGripPoints) */
    updateGrips(scaling: number): void {
        const editedElement = this.m_editData.element
        const gripsCount = editedElement ? editedElement.gripsCount() : 0
        this.m_editData.grips = gripsCount
        this.m_editData.grip = []
        if (!gripsCount) {
            return
        }

        const DEFAULT_GRIP_SIZE = 8
        const gripSize = DEFAULT_GRIP_SIZE / scaling
        const newRect = new RectF(-gripSize / 2, -gripSize / 2, gripSize, gripSize)

        const page = editedElement!.findAncestor(ElementType.PAGE) as unknown as EngravingItem | null
        const pageOffset = page ? page.pos() : editedElement!.pos()

        for (let i = 0; i < gripsCount; ++i) {
            this.m_editData.grip.push(newRect.translated(pageOffset))
        }

        editedElement!.updateGrips(this.m_editData)
    }

    /** TDraw::draw(const Lasso*): always 2 pixel width */
    drawLasso(painter: Painter, scaling: number): void {
        if (!this.m_lasso || this.m_lasso.isEmpty()) {
            return
        }

        const ldata = this.m_lasso.ldata()
        painter.setBrush(new Brush(LASSO_COLOR))
        const w = 2.0 / scaling
        painter.setPen(new Pen(EngravingConfiguration.selectionColor(), w))
        painter.drawRect(ldata.bbox())
    }
}

/** a copy of the selection state (C++ copies the Selection in applyPaletteElement: the drops change the selection) */
export interface PaletteSelection {
    isList(): boolean
    isRange(): boolean
    elements(): readonly EngravingItem[]
    startSegment(): Segment | null
    endSegment(): Segment | null
    staffStart(): staff_idx_t
    staffEnd(): staff_idx_t
    firstChordRest(): ChordRest | null
    lastChordRest(): ChordRest | null
    rangeContainsMultiNoteChords(): boolean
}

function paletteSelection(sel: Selection): PaletteSelection {
    const isList = sel.isList()
    const isRange = sel.isRange()
    const elements = [...sel.elements()]
    const startSegment = sel.startSegment()
    const endSegment = sel.endSegment()
    const staffStart = sel.staffStart()
    const staffEnd = sel.staffEnd()
    const firstChordRest = sel.firstChordRest()
    const lastChordRest = sel.lastChordRest()
    const multiNoteChords = sel.rangeContainsMultiNoteChords()
    return {
        isList: () => isList,
        isRange: () => isRange,
        elements: () => elements,
        startSegment: () => startSegment,
        endSegment: () => endSegment,
        staffStart: () => staffStart,
        staffEnd: () => staffEnd,
        firstChordRest: () => firstChordRest,
        lastChordRest: () => lastChordRest,
        rangeContainsMultiNoteChords: () => multiNoteChords,
    }
}

/** C++ isSystemTextLine() of textlinebase.h */
function isSystemTextLine(element: EngravingItem | null): boolean {
    return !!element && element.isTextLineBase() && element.systemFlag()
}

/** std::sort(..., NotationInteraction::elementIsLess) */
function sortByElementIsLess(el: EngravingItem[]): void {
    el.sort((a, b) => NotationInteraction.elementIsLess(a, b) ? -1 : NotationInteraction.elementIsLess(b, a) ? 1 : 0)
}

/** RectF::distanceTo (muse geometry) */
function rectDistanceTo(r: RectF, p: PointF): number {
    const dx = Math.max(r.left() - p.x(), 0, p.x() - r.right())
    const dy = Math.max(r.top() - p.y(), 0, p.y() - r.bottom())
    return Math.sqrt(dx * dx + dy * dy)
}

// =====================================================================================================================
//   copy/paste, editing and drag: types and helpers
// =====================================================================================================================

/** C++ INotationInteraction::HitElementContext */
export interface HitElementContext {
    element: EngravingItem | null
    staff: Staff | null
}

export enum DragMode {
    BothXY,
    OnlyX,
    OnlyY,
}

/** a key press for the edited element (C++ QKeyEvent): the Qt key (editing/editdata.ts KeyboardKey), KeyboardModifier flags, the text */
export interface NotationKeyEvent {
    key: number
    modifiers: number
    text: string
}

/** C++ NotationInteraction::DragData */
class DragData {
    beginMove = new PointF()
    elementOffset = new PointF()
    ed = new EditData()
    dragGroups: ElementGroup[] = []
    elements: EngravingItem[] = []

    reset(): void {
        this.beginMove = new PointF()
        this.elementOffset = new PointF()
        this.ed = new EditData()
        this.dragGroups = []
    }
}

/** C++ EngravingConfiguration::lassoColor() ("#00323200": transparent) */
const LASSO_COLOR = new Color(0x32, 0x32, 0x00, 0)

function nudgeDistance(editData: EditData): number {
    const spatium = editData.element!.spatium()

    if (editData.element!.isBeam()) {
        if (editData.modifiers & KeyboardModifier.ControlModifier) {
            return spatium
        } else if (editData.modifiers & KeyboardModifier.AltModifier) {
            return spatium * 4
        }

        return spatium * 0.25
    }

    if (editData.modifiers & KeyboardModifier.ControlModifier) {
        return spatium * MScore.nudgeStep10
    } else if (editData.modifiers & KeyboardModifier.AltModifier) {
        return spatium * MScore.nudgeStep50
    }

    return spatium * MScore.nudgeStep
}

/** C++ nudgeDistance(const EditData&, double raster) */
function nudgeDistanceRaster(editData: EditData, raster: number): number {
    let distance = nudgeDistance(editData)
    if (raster > 0) {
        raster = editData.element!.spatium() / raster
        if (distance < raster) {
            distance = raster
        }
    }

    return distance
}

function bindCursorPosToText(cursorPos: PointF, text: EngravingItem | null): PointF {
    if (cursorPos.isNull() || !text || !text.isTextBase()) {
        return new PointF()
    }

    const bbox = text.canvasBoundingRect()
    return new PointF(
        cursorPos.x() < bbox.left() ? bbox.left()
            : cursorPos.x() >= bbox.right() ? bbox.right() - 1 : cursorPos.x(),
        cursorPos.y() < bbox.top() ? bbox.top()
            : cursorPos.y() >= bbox.bottom() ? bbox.bottom() - 1 : cursorPos.y())
}

function findGrip(grips: readonly RectF[], canvasPos: PointF): number {
    if (grips.length === 0) {
        return -1
    }
    const align = grips[0].width() / 2
    for (let i = 0; i < grips.length; ++i) {
        if (grips[i].adjusted(-align, -align, align, align).contains(canvasPos)) {
            return i
        }
    }
    return -1
}

/** the first syllable of a text pasted into lyrics */
function extractSyllable(text: string): string {
    let t = text.replace(/(\r|\n)+/g, '\n')
    if (t.startsWith('\n')) {
        t = t.replaceAll('\n', '')
    }

    const textPos = t.search(/\S/)
    if (textPos === -1) {
        return ''
    }

    const separators = /(_| |-|\n)/g
    separators.lastIndex = textPos
    const match = separators.exec(t)
    let splitPos: number
    if (!match) {
        splitPos = t.length
    } else {
        splitPos = match.index + match[0].length
    }

    return t.substring(textPos, splitPos)
}

/** the drag of an element to other places (C++ m_outgoingDrag: a QDrag with the element's mime data) */
export interface OutgoingDrag {
    /** mimeSymbolFormat data */
    mimeData: string
    hotSpot: PointF
    element: EngravingItem
}

/** C++ NotationInteraction::ElementDropData */
interface ElementDropData {
    ed: EditData
    dropTarget: EngravingItem | null
    dropRect: RectF
}

/**
 * C++ BspTree::nearestNeighbor: the item whose page bounding rectangle's center is nearest to pos (page coordinates).
 * Deviation: a linear search instead of the BSP tree (the same result up to items at equal distances).
 */
function nearestNeighbor(items: readonly EngravingItem[], pos: PointF): EngravingItem | null {
    let nn: EngravingItem | null = null
    let bestDistance = Number.MAX_VALUE
    for (const item of items) {
        const itemPos = item.pageBoundingRect().center()
        const currDistance = Math.sqrt((pos.x() - itemPos.x()) ** 2 + (pos.y() - itemPos.y()) ** 2)
        if (currDistance < bestDistance) {
            nn = item
            bestDistance = currDistance
        }
    }
    return nn
}
