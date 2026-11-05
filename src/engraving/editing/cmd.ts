/*
 * SPDX-License-Identifier: GPL-3.0-only
 * MuseEncore — port of MuseScore Studio (https://github.com/musescore/MuseScore)
 * Copyright (C) 2021-2026 MuseScore Limited and others
 *
 * Port of src/engraving/editing/cmd.cpp: the command frame (Score::startCmd, endCmd, undoRedo, update), the
 * selection commands (Score::move, Score::selectMove) and the editing commands of cmd.cpp. They are added to Score
 * by this module (module augmentation), so it must be imported before they are used. CmdState is in cmdstate.ts.
 *
 * TODO(port): setPlayNote, the commands next/prev-system, next/prev-frame, next/prev-section, top-staff and
 * empty-trailing-measure.
 */

import { figuredBassHooks } from '../dom/figuredbass'
import { AccidentalRole, AccidentalVal, ClefType, DirectionV, DurationType, ElementType, Key, NoteHeadGroup, ParenthesesMode, StaffGroup, VOICES, nidx, track2staff, trackZeroVoice, type track_idx_t } from '../types/types'
import { Fraction } from '../types/fraction'
import { PointF } from '../../framework/draw/types/geometry'
import { TranslatableString } from '../../framework/global/types/translatablestring'
import { Sid } from '../style/styledef'
import { MScore, MsError, UpDownMode } from '../dom/mscore'
import { Score, Position, type NoteInputParams } from '../dom/score'
import { SelectType } from '../dom/select'
import { SelectionFilter } from '../dom/selectionfilter'
import { ElementsSelectionFilterTypes } from '../dom/selectionfilter' // (import of the copy/paste section)
import { SegmentType } from '../dom/segment'
import { TimeSigFrac } from '../dom/sig'
import { nextChordRest, noteIsBefore, prevChordRest, type Chord } from '../dom/chord'
import { NoteEntryMethod, NoteVal, type InputState } from '../dom/input'
import { TDuration, toDurationList, toRhythmicDurationList } from '../dom/durationtype'
import { AccidentalType } from '../dom/accidentaldata'
import { Accidental, AccidentalBracket } from '../dom/accidental'
import { Factory } from '../dom/factory'
import { Pid, PropertyFlags } from '../dom/property'
import { ClefInfo } from '../dom/clefinfo'
import { StringData } from '../dom/stringdata'
import { PITCH_DELTA_OCTAVE, Prefer, STEP_DELTA_OCTAVE, Tpc, pitch2tpc, pitchIsValid, step2tpc, tpc2alter, tpc2step } from '../dom/pitchspelling'
import { absStepFromLine, actualTicks, line2pitch, noteValToLine, relStep, step2pitch } from '../dom/utils'
import { scoreDummy } from '../compat/dummyelement'
import { Transpose } from './transpose'
import { ChangeProperty } from './editproperty'
import { ChangePitch } from './editnote'
import { InsertMeasureOptions } from './edit'
import { EditChord } from './editchord'
import '../dom/navigate'
import '../dom/noteentry'
import type { EditData } from './editdata'
import type { SymId } from '../types/symid'
import type { Tuplet } from '../dom/tuplet'
import type { EngravingItem } from '../dom/engravingitem'
import type { DurationElement } from '../dom/durationelement'
import type { ChordRest } from '../dom/chordrest'
import type { Note } from '../dom/note'
import type { Rest } from '../dom/rest'
import type { Box } from '../dom/box'
import type { Segment } from '../dom/segment'
import type { Measure } from '../dom/measure'
import type { Tie } from '../dom/tie'
import type { Beam } from '../dom/beam'
import type { Slur } from '../dom/slur'
import type { Clef } from '../dom/clef'
import type { TimeSig } from '../dom/timesig'
import { EditSystemLocks } from './editsystemlocks'

declare module '../dom/score' {
    interface Score {
        /** Start a GUI command by clearing the redraw area and starting a user-visible undo. */
        startCmd(actionName?: TranslatableString): void
        /** End a GUI command by (if not rollback) ending a user-visible undo and (always) updating the redraw area. */
        endCmd(rollback?: boolean, layoutAllParts?: boolean): void
        undoRedo(undo: boolean, ed?: EditData | null): void
        /** layout & update */
        update(resetCmdState?: boolean, layoutAllParts?: boolean): void

        cmdResetAllPositions(undoable?: boolean): void
        resetAutoplace(): void
        resetCrossBeams(): void

        /** move current selection */
        move(cmd: string): EngravingItem | null
        selectMove(cmd: string): EngravingItem | null

        // ---- the editing commands of cmd.cpp ----
        setNoteRest(segment: Segment, track: track_idx_t, nval: NoteVal, sd: Fraction, stemDirection?: DirectionV,
            forceAccidental?: boolean, articulationIds?: ReadonlySet<SymId>, rhythmic?: boolean,
            externalInputState?: InputState | null): Segment | null
        /** C++ changeCRlen(ChordRest*, const TDuration&) and changeCRlen(ChordRest*, const Fraction&, bool) */
        changeCRlen(cr: ChordRest, d: TDuration | Fraction, fillWithRest?: boolean): void
        createCRSequence(f: Fraction, cr: ChordRest, tick: Fraction): void
        makeGap(segment: Segment, track: track_idx_t, sd: Fraction, tuplet: Tuplet | null, keepChord?: boolean): Fraction
        makeGapVoice(seg: Segment, track: track_idx_t, len: Fraction, tick: Fraction): boolean
        splitGapToMeasureBoundaries(cr: ChordRest, gap: Fraction): Fraction[]
        upDown(up: boolean, mode: UpDownMode): void
        upDownDelta(pitchDelta: number): void
        toggleAccidental(at: AccidentalType): void
        applyAccidentalToInputNotes(accidentalType: AccidentalType): void
        changeAccidental(idx: AccidentalType): void
        /** C++ changeAccidental(Note*, AccidentalType) (renamed: no overloads in TS) */
        changeNoteAccidental(note: Note, accidental: AccidentalType): void
        resolveNoteInputParams(noteIdx: number, addFlag: boolean): NoteInputParams | null
        /** C++ cmdAddPitch(const NoteInputParams&, bool, bool) and cmdAddPitch(int note, bool, bool) */
        cmdAddPitch(params: NoteInputParams | number, addFlag: boolean, insert: boolean): void
        cmdIncDecDuration(nSteps: number, stepDotted?: boolean): void
        cmdToggleVisible(): void
        cmdMoveRest(rest: Rest, dir: DirectionV): void
        cmdSetVisible(): void
        cmdUnsetVisible(): void
        cmdPitchUp(): void
        cmdPitchDown(): void
        cmdPitchUpOctave(): void
        cmdPitchDownOctave(): void
        addInterval(val: number, nl: readonly Note[]): void
        expandVoice(s?: Segment | null, track?: track_idx_t): void
        cmdAddBracket(): void
        cmdToggleParenthesesOnNotes(): void
        /** C++ cmdAddParenthesesToNotes(std::list<Note*>&) and cmdAddParenthesesToNotes() (the selected notes) */
        cmdAddParenthesesToNotes(notes?: Note[]): void
        cmdRemoveParenthesesFromNotes(notes?: Note[]): void
        /** C++ cmdToggleParentheses() and cmdToggleParentheses(EngravingItem*) */
        cmdToggleParentheses(el?: EngravingItem): void
        cmdAddBraces(): void

    }
}

Score.prototype.startCmd = function (this: Score, actionName: TranslatableString = new TranslatableString()): void {
    if (this.undoStack().isLocked()) {
        return
    }

    if (this.undoStack().hasActiveCommand()) {
        // C++: LOGD("Score::startCmd(): cmd already active")
        return
    }

    MScore.setError(MsError.MS_NO_ERROR)

    this.cmdState().reset()

    // Start collecting low-level undo operations for a
    // user-visible undo action.
    this.undoStack().beginMacro(this, actionName)
}

Score.prototype.undoRedo = function (this: Score, undo: boolean, ed: EditData | null = null): void {
    // TODO(port): readOnly()

    //! NOTE: the order of operations is very important here
    //! 1. for the undo operation, the list of changed elements is available before undo()
    //! 2. for the redo operation, the list of changed elements will be available after redo()
    this.cmdState().reset()
    if (undo) {
        this.undoStack().undo(ed)
    } else {
        this.undoStack().redo(ed)
    }
    // TODO(port): not all undo commands of the port trigger the layout of their range yet (C++ setProperty()
    // implementations call triggerLayout()): without a range the whole score is laid out
    if (!this.cmdState().layoutRange()) {
        this.setLayoutAll()
    }

    this.update(false)
    this.masterScore().setPlaylistDirty() // TODO: flag all individual operations
    this.updateSelection()

    // TODO(port): changesChannel().send(buildScoreChanges(...)) (the UI relayouts/repaints everything)
}

Score.prototype.endCmd = function (this: Score, rollback = false, layoutAllParts = false): void {
    if (this.undoStack().isLocked()) {
        return
    }

    if (!this.undoStack().hasActiveCommand()) {
        // C++: LOGW() << "no command active"
        this.update()
        return
    }

    if (MScore.errorValue() !== MsError.MS_NO_ERROR && !MScore.errorIsWarning()) {
        rollback = true
    }

    // a rolled back command that changed something must be laid out too (see below)
    const changedSomething = !this.undoStack().activeCommand()!.empty()
    if (rollback) {
        this.undoStack().activeCommand()!.unwind()
    }

    // TODO(port): not all undo commands of the port trigger the layout of their range yet (C++ setProperty()
    // implementations call triggerLayout()): without a range a command that changed something lays out the whole score
    if (changedSomething && !this.cmdState().layoutRange()) {
        this.setLayoutAll()
    }

    this.update(false, layoutAllParts)

    const isCurrentCommandEmpty = this.undoStack().activeCommand()!.empty() // nothing to undo?
    this.undoStack().endMacro(isCurrentCommandEmpty)

    if (this.dirty()) {
        this.masterScore().setPlaylistDirty() // TODO: flag individual operations
    }

    this.cmdState().reset()

    // TODO(port): changesChannel().send(changes)
}

Score.prototype.update = function (this: Score, resetCmdState = true, layoutAllParts = false): void {
    if (this.updatesLocked()) {
        return
    }

    const ms = this.masterScore()
    const cs = ms.cmdState()
    // (deletePostponed(): elements are garbage collected)
    if (cs.layoutRange()) {
        const scores = ms.scoreList()
        for (const s of scores) {
            if (s !== this && !s.isOpen() && scores.length > 1 && !layoutAllParts) {
                continue
            }
            s.doLayoutRange(cs.startTick(), cs.endTick())
        }
    }

    if (this.needSetUpTempoMap()) {
        this.setUpTempoMap()
        this.setNeedSetUpTempoMap(false)
    }

    // C++: the views are updated (MuseScoreView::updateAll / dataChanged); the port's UI repaints after a command
    if (resetCmdState) {
        cs.reset()
    }

    for (const score of ms.scoreList()) {
        const sel = score.selection()
        if (sel.isRange() && !sel.isLocked()) {
            sel.updateSelectedElements()
        }
    }
}

function resetElementPosition(e: EngravingItem): void {
    if (e.generated()) {
        return
    }

    e.undoResetProperty(Pid.AUTOPLACE)
    e.undoResetProperty(Pid.OFFSET)
    e.undoResetProperty(Pid.LEADING_SPACE)
    e.setOffsetChanged(false)
    if (e.isSpanner()) {
        e.undoResetProperty(Pid.OFFSET2)
    }
}

function resetBeamOffSet(e: EngravingItem): void {
    // Reset completely cross staff beams from MU1&2
    if (e.isBeam() && (e as Beam).fullCross()) {
        e.reset()
    }
}

Score.prototype.cmdResetAllPositions = function (this: Score, undoable = true): void {
    if (undoable) {
        this.startCmd(new TranslatableString('undoableAction', 'Reset all positions'))
    }
    this.resetAutoplace()
    if (undoable) {
        this.endCmd()
    }
}

Score.prototype.resetAutoplace = function (this: Score): void {
    this.scanElements(resetElementPosition)
}

Score.prototype.resetCrossBeams = function (this: Score): void {
    this.scanElements(resetBeamOffSet)
}

Score.prototype.move = function (this: Score, cmd: string): EngravingItem | null {
    let cr: ChordRest | null = null
    let box: Box | null = null
    if (this.noteEntryMode()) {
        // if selection exists and is grace note, use it
        // otherwise use chord/rest at input position
        // also use it if we are moving to next chord
        // to catch up with the cursor and not move the selection by 2 positions
        cr = this.selection().cr()
        if (cr && (cr.isGrace() || cmd === 'next-chord' || cmd === 'prev-chord')) {
            // keep it
        } else {
            cr = this.inputState().cr()
        }
    } else if (this.selection().activeCR()) {
        cr = this.selection().activeCR()
    } else {
        cr = this.selection().lastChordRest()
    }

    // no chord/rest found? look for another type of element,
    // but commands [empty-trailing-measure] and [top-staff] don't
    // necessarily need an active selection for appropriate functioning
    if (!cr && cmd !== 'empty-trailing-measure' && cmd !== 'top-staff') {
        if (this.selection().elements().length === 0) {
            return null
        }
        // retrieve last element of section list
        let el: EngravingItem | null = this.selection().elements()[this.selection().elements().length - 1]
        let trg: EngravingItem | null = null

        // get parent of element and process accordingly:
        // trg is the element to select on "next-chord" cmd
        // cr is the ChordRest to move from on other cmd's
        const track = el.track() // keep note of element track
        if (!el.isBox()) {
            el = el.parentItem()
        }
        // element with no parent (eg, a newly-added line) - no way to find context
        if (!el) {
            return null
        }
        switch (el.type()) {
        case ElementType.NOTE: // a note is a valid target
            trg = el
            cr = (el as unknown as Note).chord()
            break
        case ElementType.CHORD: // a chord or a rest are valid targets
        case ElementType.REST:
        case ElementType.MMREST:
            trg = el
            cr = trg as unknown as ChordRest
            break
        case ElementType.SEGMENT: { // from segment go to top chordrest in segment
            let seg: Segment | null = el as unknown as Segment
            // if segment is not chord/rest or grace, move to next chord/rest or grace segment
            if (!seg.isChordRestType()) {
                seg = seg.next1(SegmentType.ChordRest)
                if (!seg) { // if none found, return failure
                    return null
                }
            }
            // segment for sure contains chords/rests,
            const size = seg.elist().length
            // if segment has a chord/rest in original element track, use it
            if (track < size && seg.element(track)) {
                trg = seg.element(track)
                cr = trg as unknown as ChordRest
                break
            }
            // if not, get topmost chord/rest
            for (let i = 0; i < size; i++) {
                if (seg.element(i)) {
                    trg = seg.element(i)
                    cr = trg as unknown as ChordRest
                    break
                }
            }
            break
        }
        case ElementType.HBOX:
        case ElementType.VBOX:
        case ElementType.TBOX:
        case ElementType.FBOX:
            box = el as unknown as Box
            break
        default: // on anything else, return failure
            return null
        }

        // if something found and command is forward, the element found is the destination
        if (trg && cmd === 'next-chord') {
            // if chord, go to topmost note
            if (trg.isChord()) {
                trg = (trg as unknown as Chord).upNote()
            }
            this.select(trg, SelectType.SINGLE, 0)
            return trg
        }
        // if no chordrest and no box (frame) found, do nothing
        if (!cr && !box) {
            return null
        }
        // if some chordrest found, continue with default processing
    }

    let el: EngravingItem | null = null
    const is = this.inputState()
    const ois = this.noteEntryMode() ? is.segment() : null
    const oim = ois ? ois.measure() : null

    if (cmd === 'next-chord' && cr) {
        // note input cursor
        if (this.noteEntryMode()) {
            is.moveToNextInputPos()
        }

        // selection "cursor"
        // find next chordrest, which might be a grace note
        // this may override note input cursor
        el = nextChordRest(cr)

        // Skip gap rests if we're not in note entry mode...
        while (!this.noteEntryMode() && el && el.isRest() && (el as unknown as Rest).isGap()) {
            el = nextChordRest(el as unknown as ChordRest)
        }
        if (el && this.noteEntryMode()) {
            // do not use if not in original or new measure (don't skip measures)
            const m = (el as unknown as ChordRest).measure()
            const nis = is.segment()
            const nim = nis ? nis.measure() : null
            if (m !== oim && m !== nim) {
                el = cr
            } else if (cr && nis === cr.segment()) {
                // do not use if new input segment is current cr
                // this means input cursor just caught up to current selection
                el = cr
            }
        } else if (!el) {
            el = cr
        }
    } else if (cmd === 'prev-chord' && cr) {
        // note input cursor
        if (this.noteEntryMode() && is.segment()) {
            const m = is.segment()!.measure()
            let s = is.segment()!.prev1(SegmentType.ChordRest)
            const track = is.track()
            for (; s; s = s.prev1(SegmentType.ChordRest)) {
                if (s.element(track) || (s.measure() !== m && s.rtick().isZero())) {
                    if (s.element(track)) {
                        if (s.element(track)!.isRest() && (s.element(track) as unknown as Rest).isGap()) {
                            continue
                        }
                    }
                    break
                }
            }
            is.moveInputPos(s as unknown as EngravingItem)
        }

        // selection "cursor"
        // find previous chordrest, which might be a grace note
        // this may override note input cursor
        el = prevChordRest(cr)

        // Skip gap rests if we're not in note entry mode...
        while (!this.noteEntryMode() && el && el.isRest() && (el as unknown as Rest).isGap()) {
            el = prevChordRest(el as unknown as ChordRest)
        }
        if (el && this.noteEntryMode()) {
            // do not use if not in original or new measure (don't skip measures)
            const m = (el as unknown as ChordRest).measure()
            const nis = is.segment()
            const nim = nis ? nis.measure() : null
            if (m !== oim && m !== nim) {
                el = cr
            } else if (cr && nis === cr.segment()) {
                // do not use if new input segment is current cr
                // this means input cursor just caught up to current selection
                el = cr
            }
        } else if (!el) {
            el = cr
        }
    } else if (cmd === 'next-measure') {
        const next = box ? box.nextMeasure() : null
        if (next && next.first()) {
            el = next.first()!.nextChordRest(0, false)
        }
        if (cr) {
            el = this.nextMeasure(cr)
        }
        if (el && this.noteEntryMode()) {
            is.moveInputPos(el)
        }
    } else if (cmd === 'prev-measure') {
        const prev = box ? box.prevMeasure() : null
        if (prev && prev.first()) {
            el = prev.first()!.nextChordRest(0, false)
        }
        if (cr) {
            el = this.prevMeasure(cr)
        }
        if (el && this.noteEntryMode()) {
            is.moveInputPos(el)
        }
    } else if (cmd === 'next-track' && cr) {
        el = this.nextTrack(cr)
        if (this.noteEntryMode()) {
            is.moveInputPos(el)
        }
    } else if (cmd === 'prev-track' && cr) {
        el = this.prevTrack(cr)
        if (this.noteEntryMode()) {
            is.moveInputPos(el)
        }
    }
    // TODO(port): next/prev-system, next/prev-frame, next/prev-section, top-staff, empty-trailing-measure

    if (el) {
        if (el.isChord()) {
            el = (el as unknown as Chord).upNote() // originally downNote
        }
        // TODO(port): setPlayNote(true) (playback)
        if (this.noteEntryMode()) {
            // if cursor moved into a gap, selection cannot follow
            // only select & play el if it was not already selected (does not normally happen)
            if (is.cr() || !el.selected()) {
                this.select(el, SelectType.SINGLE, 0)
            }
            // C++: view->moveCursor() (the view draws the cursor at inputState().segment())
        } else {
            this.select(el, SelectType.SINGLE, 0)
        }
    }
    return el
}

Score.prototype.selectMove = function (this: Score, cmd: string): EngravingItem | null {
    let cr: ChordRest | null
    if (this.selection().activeCR()) {
        cr = this.selection().activeCR()
    } else {
        cr = this.selection().lastChordRest()
    }
    if (!cr && this.noteEntryMode()) {
        cr = this.inputState().cr()
    }
    if (!cr) {
        return null
    }

    let el: ChordRest | null = null
    // TODO(port): ChordRestNavigateOptions.skipMeasureRepeatRests = false
    if (cmd === 'select-next-chord') {
        el = nextChordRest(cr, true)
    } else if (cmd === 'select-prev-chord') {
        el = prevChordRest(cr, true)
    } else if (cmd === 'select-next-measure') {
        el = this.nextMeasure(cr, true, true)
    } else if (cmd === 'select-prev-measure') {
        el = this.prevMeasure(cr, true)
    } else if (cmd === 'select-begin-line') {
        const measure = cr.segment().measure().system()!.firstMeasure()
        if (!measure) {
            return null
        }
        el = measure.first()!.nextChordRest(cr.track())
    } else if (cmd === 'select-end-line') {
        const measure = cr.segment().measure().system()!.lastMeasure()
        if (!measure) {
            return null
        }
        el = measure.last()!.nextChordRest(cr.track(), true)
    } else if (cmd === 'select-begin-score') {
        const measure = this.firstMeasureMM()
        if (!measure) {
            return null
        }
        el = measure.first()!.nextChordRest(cr.track())
    } else if (cmd === 'select-end-score') {
        const measure = this.lastMeasureMM()
        if (!measure) {
            return null
        }
        el = measure.last()!.nextChordRest(cr.track(), true)
    } else if (cmd === 'select-staff-above') {
        el = this.upStaff(cr)
    } else if (cmd === 'select-staff-below') {
        el = this.downStaff(cr)
    }
    if (el) {
        this.select(el, SelectType.RANGE, el.staffIdx())
    }
    return el
}

// ---------------------------------------------------------------------------------------------------------------------
//   editing commands of cmd.cpp
// ---------------------------------------------------------------------------------------------------------------------

Score.prototype.expandVoice = function (this: Score, s?: Segment | null, track?: track_idx_t): void {
    if (s === undefined) {
        s = this.inputState().segment()
        track = this.inputState().track()
    }
    if (!s) {
        // C++: LOGD("expand voice: no segment")
        return
    }
    const tr = track!
    if (s.element(tr)) {
        return
    }

    // find previous segment with cr in this track
    let ps: Segment | null
    for (ps = s; ps; ps = ps.prev(SegmentType.ChordRest)) {
        if (ps.element(tr)) {
            break
        }
    }
    if (ps) {
        const cr = ps.element(tr) as unknown as ChordRest
        const tick = cr.endTick()
        if (tick.gt(s.tick())) {
            // previous cr extends past current segment
            // C++: LOGD("expandVoice: cannot insert element here")
            return
        }
        if (cr.isChord()) {
            // previous cr ends on or before current segment
            // for chords, move ps to just after cr ends
            // so we can fill any gap that might exist
            // but don't move ps if previous cr is a rest
            // this will be combined with any new rests needed to fill up to s->tick() below
            ps = ps.measure().undoGetSegment(SegmentType.ChordRest, tick)
        }
    }
    //
    // fill up to s->tick() with rests
    //
    const m = s.measure()
    const stick = ps ? ps.tick() : m.tick()
    const stretch = this.staff(track2staff(tr))!.timeStretch(stick)
    let ticks = s.tick().minus(stick)
    if (ticks.isNotZero()) {
        this.setRest(stick, tr, ticks.times(stretch), false, null)
    }

    //
    // fill from s->tick() until next chord/rest in measure
    //
    let ns: Segment | null
    for (ns = s.next(SegmentType.ChordRest); ns; ns = ns.next(SegmentType.ChordRest)) {
        if (ns.element(tr)) {
            break
        }
    }
    ticks = ns ? ns.tick().minus(s.tick()) : m.ticks().minus(s.rtick())
    if (ticks.eq(m.ticks())) {
        this.addRest(s, tr, new TDuration(DurationType.V_MEASURE), null)
    } else {
        this.setRest(s.tick(), tr, ticks.times(stretch), false, null)
    }
}

Score.prototype.addInterval = function (this: Score, val: number, nl: readonly Note[]): void {
    const is = this.inputState()
    // Prepare note selection in case there are not selected tied notes and sort them
    const tmpnl: Note[] = []
    const _nl = [...nl]
    const selIsList = this.selection().isList()
    const selIsSingle = selIsList && _nl.length === 1
    const shouldSelectFirstNote = selIsSingle && !!_nl[0].tieFor()

    _nl.sort((a, b) => (a.tick().lt(b.tick()) ? -1 : a.tick().gt(b.tick()) ? 1 : 0))

    for (const currNote of _nl) {
        for (let n: Note | null = currNote; n && !tmpnl.includes(n); n = n.tieFor() ? n.tieFor()!.endNote() : null) {
            if (selIsList && n.selected()) {
                this.deselect(n)
            }
            tmpnl.push(n)
        }
    }

    let prevTied: Note | null = null
    const notesToSelect: EngravingItem[] = []
    const deltaLine = val < 0 ? val + 1 : val - 1
    const accidental = is.noteEntryMode() && is.accidentalType() !== AccidentalType.NONE
    const useOctaveRule = (deltaLine % STEP_DELTA_OCTAVE === 0) && !accidental // Both octaves and unison

    for (const on of tmpnl) {
        const chord = on.chord()
        const tick = chord.tick()
        const nval = new NoteVal()
        let forceAccidental = false
        let noteValid = false
        if (on.staff() && on.staff()!.isDrumStaff(tick)) {
            // For drum staves: Don't calculate the new note based on pitch, but choose one using lines
            const ds = on.staff()!.part().instrument(tick).drumset()!
            nval.pitch = ds.defaultPitchForLine(on.line() - deltaLine)
            nval.headGroup = ds.noteHead(nval.pitch)
            noteValid = ds.isValid(nval.pitch) && nval.headGroup !== NoteHeadGroup.HEAD_INVALID
        } else {
            if (useOctaveRule) {
                const octaves = Math.trunc(deltaLine / STEP_DELTA_OCTAVE)
                nval.pitch = on.pitch() + octaves * PITCH_DELTA_OCTAVE
                nval.tpc1 = on.tpc1()
                nval.tpc2 = on.tpc2()
            } else {
                const line = on.line() - deltaLine
                const estaff = this.staff(chord.vStaffIdx())!
                const clef = estaff.clef(tick)
                const key = estaff.key(tick)
                let ntpc: number
                if (accidental) {
                    const acci = Accidental.subtype2value(is.accidentalType())
                    const step = absStepFromLine(line, clef)
                    const octave = Math.trunc(step / 7)
                    nval.pitch = step2pitch(step) + octave * PITCH_DELTA_OCTAVE + acci
                    forceAccidental = (nval.pitch === line2pitch(line, clef, key))
                    ntpc = step2tpc(step % STEP_DELTA_OCTAVE, acci)
                } else {
                    nval.pitch = line2pitch(line, clef, key)
                    ntpc = pitch2tpc(nval.pitch, key, Prefer.NEAREST)
                }

                const v = estaff.transpose(tick)
                if (v.isZero()) {
                    nval.tpc1 = nval.tpc2 = ntpc
                } else {
                    if (this.style().styleB(Sid.concertPitch)) {
                        v.flip()
                        nval.tpc1 = ntpc
                        nval.tpc2 = Transpose.transposeTpc(ntpc, v, true)
                    } else {
                        nval.pitch += v.chromatic
                        nval.tpc2 = ntpc
                        nval.tpc1 = Transpose.transposeTpc(ntpc, v, true)
                    }
                }
            }
            noteValid = pitchIsValid(nval.pitch)
        }

        if (!noteValid) {
            notesToSelect.push(on)
            continue
        }

        const note = Factory.createItem(ElementType.NOTE, chord) as Note
        note.setParent(chord)
        note.setTrack(chord.track())
        note.setNval(nval, tick)
        this.undoAddElement(note)

        if (forceAccidental) {
            const a = Factory.createItem(ElementType.ACCIDENTAL, note) as Accidental
            a.setAccidentalType(is.accidentalType())
            a.setRole(AccidentalRole.USER)
            a.setParent(note)
            this.undoAddElement(a)
        }
        if (on.tieBack() && prevTied) {
            const tie = prevTied.tieFor()!
            tie.setEndNote(note)
            tie.setTick2(note.tick())
            note.setTieBack(tie)
            this.undoAddElement(tie)
            prevTied = null
        }

        const tieFor = on.tieFor()
        if (tieFor) {
            const tie = (tieFor.isLaissezVib()
                ? Factory.createItem(ElementType.LAISSEZ_VIB, scoreDummy(this).note())
                : Factory.createItem(ElementType.TIE, scoreDummy(this))) as Tie
            tie.setStartNote(note)
            tie.setTick(note.tick())
            tie.setTrack(note.track())
            note.setTieFor(tie)
            prevTied = note
        }

        // TODO(port): setPlayNote(true)
        if (selIsList && note) {
            notesToSelect.push(note)
        }
    }
    if (is.noteEntryMode()) {
        is.setAccidentalType(AccidentalType.NONE)
    }
    if (notesToSelect.length === 0) {
        return
    }
    if (shouldSelectFirstNote) {
        this.select(notesToSelect[0], SelectType.SINGLE, 0)
    } else {
        this.select(notesToSelect, SelectType.ADD, 0)
    }
    if (is.cr() === _nl[0].chord() && selIsSingle) {
        is.moveToNextInputPos()
    }
}

Score.prototype.createCRSequence = function (this: Score, f: Fraction, cr: ChordRest, t: Fraction): void {
    let tick = t
    const measure = cr.measure()
    let ocr: ChordRest | null = null
    for (const d of toDurationList(f, true)) {
        const ncr = cr.clone() as ChordRest
        ncr.setDurationType(d)
        ncr.setTicks(d.fraction())
        this.undoAddCR(ncr, measure, measure.tick().plus(tick))
        if (cr.isChord() && ocr) {
            const nc = ncr as Chord
            const oc = ocr as Chord
            for (let i = 0; i < oc.notes().length; ++i) {
                const on = oc.notes()[i]
                const nn = nc.notes()[i]
                const tie = Factory.createItem(ElementType.TIE, scoreDummy(this)) as Tie
                tie.setStartNote(on)
                tie.setEndNote(nn)
                tie.setTick(tie.startNote()!.tick())
                tie.setTick2(tie.endNote()!.tick())
                tie.setTrack(cr.track())
                on.setTieFor(tie)
                nn.setTieBack(tie)
                this.undoAddElement(tie)
            }
        }

        tick = tick.plus(ncr.actualTicks())
        ocr = ncr
    }
}

/**
 * pitch == -1  -> set rest; "sd" is in local (stretched) time; returns the segment of the last created note/rest
 */
Score.prototype.setNoteRest = function (this: Score, segment: Segment, track: track_idx_t, nval: NoteVal, sd: Fraction,
    stemDirection: DirectionV = DirectionV.AUTO, forceAccidental = false, articulationIds: ReadonlySet<SymId> = new Set(),
    rhythmic = false, externalInputState: InputState | null = null): Segment | null {
    // C++: assert(segment->segmentType() == SegmentType::ChordRest)
    const is = externalInputState ?? this.inputState()

    const isRest = nval.isRest()
    let tick = segment.tick()
    let nr: EngravingItem | null = null
    let tie: Tie | null = null
    let cr = segment.element(track) as unknown as ChordRest | null
    let tuplet: Tuplet | null = cr ? cr.tuplet() : null
    let measure: Measure | null = null
    const targetIsRest = !!cr && cr.isRest()
    let seg: Segment = segment
    for (;;) {
        if (track % VOICES) {
            this.expandVoice(seg, track)
        }
        if (targetIsRest && !cr!.isRest()) {
            this.undoRemoveElement(cr)
            seg = this.addRest(seg, track, new TDuration(cr!.ticks()), cr!.tuplet()).segment()
        }
        // the returned gap ends at the measure boundary or at tuplet end
        const dd = this.makeGap(seg, track, sd, tuplet)

        if (dd.isZero()) {
            // C++: LOGD("cannot get gap at %d type: %d/%d", ...)
            break
        }

        measure = seg.measure()
        const timeStretch = this.staff(track2staff(track))!.timeStretch(tick)
        let dl: TDuration[]
        if (rhythmic) {
            dl = toRhythmicDurationList(dd, isRest, seg.rtick().times(timeStretch), this.sigmap().timesig(tick).nominal(),
                measure, 1, timeStretch)
        } else {
            dl = toDurationList(dd, true)
        }
        const n = dl.length
        for (let i = 0; i < n; ++i) {
            const d = dl[i]
            let ncr: ChordRest
            let addTie: Tie | null = null
            if (isRest) {
                ncr = Factory.createItem(ElementType.REST, scoreDummy(this).segment()) as Rest
                nr = ncr
                nr.setTrack(track)
                ncr.setDurationType(d)
                ncr.setTicks(d.isMeasure() ? measure.ticks().times(timeStretch) : d.fraction())
            } else {
                const note = Factory.createItem(ElementType.NOTE, scoreDummy(this).chord()) as Note
                nr = note

                if (tie) {
                    tie.setEndNote(note)
                    note.setTieBack(tie)
                    addTie = tie
                }
                const chord = Factory.createItem(ElementType.CHORD, scoreDummy(this).segment()) as Chord
                chord.setTrack(track)
                chord.setDurationType(d)
                chord.setTicks(d.fraction())
                chord.setStemDirection(stemDirection)
                chord.add(note)
                if (cr && cr.isChord()) {
                    const graceNotes = [...(cr as Chord).graceNotes()]
                    for (const grace of graceNotes) {
                        this.undoChangeParent(grace, chord, chord.staffIdx())
                    }
                }
                note.setNval(nval, tick)
                if (forceAccidental) {
                    const tpc = this.style().styleB(Sid.concertPitch) ? nval.tpc1 : nval.tpc2
                    const alter = tpc2alter(tpc)
                    const at = Accidental.value2subtype(alter)
                    const a = Factory.createItem(ElementType.ACCIDENTAL, note) as Accidental
                    a.setAccidentalType(at)
                    a.setRole(AccidentalRole.USER)
                    note.add(a)
                }

                ncr = chord
                if (i + 1 < n) {
                    tie = Factory.createItem(ElementType.TIE, scoreDummy(this)) as Tie
                    tie.setStartNote(note)
                    tie.setTick(tie.startNote()!.tick())
                    tie.setTrack(track)
                    note.setTieFor(tie)
                }
            }
            if (tuplet) {
                ncr.setTuplet(tuplet)
            }
            tuplet = null
            this.undoAddCR(ncr, measure, tick)
            if (addTie) {
                this.undoAddElement(addTie)
            }
            // TODO(port): setPlayNote(true)
            seg = ncr.segment()
            tick = tick.plus(ncr.actualTicks())

            if (articulationIds.size) {
                if (ncr.isChord()) {
                    (ncr as Chord).updateArticulations(articulationIds)
                }
            }
        }

        sd = sd.minus(dd)
        if (sd.isZero()) {
            break
        }

        const nseg = this.tick2segment(tick, false, SegmentType.ChordRest)
        if (!nseg) {
            // C++: LOGD("reached end of score")
            break
        }
        seg = nseg

        cr = seg.element(track) as unknown as ChordRest | null
        // if the cr was too big for the tuplet, get the next tuplet so we can spill into that one
        tuplet = cr && cr.tuplet() ? cr.tuplet() : null
        if (!cr) {
            if (track % VOICES) {
                cr = this.addRest(seg, track, new TDuration(DurationType.V_MEASURE), null)
            } else {
                // C++: LOGD("no rest in voice 0")
                break
            }
        }
        //
        //  Note does not fit on current measure, create Tie to
        //  next part of note
        if (!isRest) {
            tie = Factory.createItem(ElementType.TIE, scoreDummy(this)) as Tie
            tie.setStartNote(nr as Note)
            tie.setTick(tie.startNote()!.tick())
            tie.setTrack(nr!.track())
            ;(nr as Note).setTieFor(tie)
        }
    }
    if (tie) {
        this.connectTies()
    }
    if (nr) {
        const slur = is.slur()
        if (slur && nr.isNote()) {
            // If the start element was the same as the end element when the slur was created,
            // the end grip of the front slur segment was given an x-offset of 3.0 * spatium().
            // Now that the slur is about to be given a new end element, this should be reset.
            // TODO(port): slur->frontSegment()->reset() (user offsets of slur segments)
            //
            // extend slur
            //
            const chord = (nr as Note).chord()
            slur.undoChangeProperty(Pid.SPANNER_TICKS, chord.tick().minus(slur.tick()))
            for (const se of slur.linkList()) {
                const sl = se as unknown as Slur
                for (const ee of chord.linkList()) {
                    const e = ee as EngravingItem
                    if (e.score() === sl.score() && e.track() === sl.track2()) {
                        sl.score().undoChangeSpannerElements(sl, sl.startElement(), e)
                        break
                    }
                }
            }
        }
        if (externalInputState) {
            is.setTrack(nr.track())
            cr = nr.isRest() ? nr as unknown as ChordRest : (nr as Note).chord()
            is.setLastSegment(is.segment())
            is.setSegment(cr.segment())
        } else {
            this.select(nr, SelectType.SINGLE, 0)
        }
    }
    return seg
}

/**
 * make time gap at tick by removing/shortening chord/rest; if keepChord, the chord at tick is not removed;
 * "sd" is in local (stretched) time; gap does not exceed measure or scope of tuplet;
 * return size of actual gap in local time
 */
Score.prototype.makeGap = function (this: Score, segment: Segment, track: track_idx_t, _sd: Fraction, tuplet: Tuplet | null,
    keepChord = false): Fraction {
    // C++: assert(_sd.numerator())

    const measure = segment.measure()
    const stf = this.staff(track2staff(track))!
    let accumulated = new Fraction(0, 1)
    let sd = _sd

    //
    // remember first segment which should
    // not be deleted (it may contain other elements we want to preserve)
    //
    const firstSegment = segment
    const firstSegmentEnd = firstSegment.tick().plus(firstSegment.ticks())
    let nextTick = segment.tick()

    for (let seg: Segment | null = firstSegment; seg; seg = seg.next(SegmentType.ChordRest)) {
        //
        // voices != 0 may have gaps:
        //
        const cr = seg.element(track) as unknown as ChordRest | null
        const timeStretch = stf.timeStretch(seg.tick())
        if (!cr) {
            if (seg.tick().lt(nextTick)) {
                continue
            }
            const seg1 = seg.next(SegmentType.ChordRest)
            const tick2 = seg1 ? seg1.tick() : seg.measure().endTick()
            let td = tick2.minus(seg.tick())
            td = td.div(actualTicks(new Fraction(1, 1), tuplet, timeStretch))
            if (td.gt(sd)) {
                td = sd
            }
            accumulated = accumulated.plus(td)
            sd = sd.minus(td)
            if (sd.isZero()) {
                break
            }
            nextTick = tick2
            continue
        }
        if (seg.tick().gt(nextTick)) {
            // there was a gap
            let td = seg.tick().minus(nextTick)
            td = td.div(actualTicks(new Fraction(1, 1), tuplet, timeStretch))
            if (td.gt(sd)) {
                td = sd
            }
            accumulated = accumulated.plus(td)
            sd = sd.minus(td)
            if (sd.isZero()) {
                break
            }
        }
        //
        // limit to tuplet level
        //
        if (tuplet) {
            let tupletEnd = true
            let t = cr.tuplet()
            while (t) {
                if (cr.tuplet() === tuplet) {
                    tupletEnd = false
                    break
                }
                t = t.tuplet()
            }
            if (tupletEnd) {
                break
            }
        }
        let td = cr.ticks()

        // remove tremolo between 2 notes, if present
        if (cr.isChord()) {
            const c = cr as Chord
            if (c.tremoloTwoChord()) {
                this.undoRemoveElement(c.tremoloTwoChord())
            }
        }
        let ltuplet = cr.tuplet()
        if (ltuplet !== tuplet) {
            //
            // Current location points to the start of a (nested)tuplet.
            // We have to remove the complete tuplet.

            // get top level tuplet
            while (ltuplet!.tuplet()) {
                ltuplet = ltuplet!.tuplet()
            }

            // get last segment of tuplet, drilling down to leaf nodes as necessary
            let t = ltuplet!
            while (t.elements()[t.elements().length - 1].isTuplet()) {
                t = t.elements()[t.elements().length - 1] as unknown as Tuplet
            }
            seg = (t.elements()[t.elements().length - 1] as unknown as ChordRest).segment()

            // now delete the full tuplet
            td = ltuplet!.ticks()
            this.cmdDeleteTuplet(ltuplet!, false)
            tuplet = null
        } else {
            if (seg !== firstSegment || !keepChord) {
                this.undoRemoveElement(cr)
            }
            // even if there was a tuplet, we didn't remove it
            ltuplet = null
        }
        nextTick = nextTick.plus(actualTicks(td, tuplet, timeStretch))
        if (sd.lt(td)) {
            //
            // we removed too much
            //
            accumulated = _sd
            const rd = td.minus(sd)
            let tick = cr.tick().plus(actualTicks(sd, tuplet, timeStretch))

            let dList: TDuration[]
            if (tuplet) {
                dList = toDurationList(rd, false)
                dList.reverse()
            } else {
                const timeSig = stf.timeSig(tick)
                const refTimeSig = timeSig ? TimeSigFrac.from(timeSig.sig()) : this.sigmap().timesig(tick).nominal()
                const rTickStart = tick.minus(measure.tick()).times(stf.timeStretch(tick))
                dList = toRhythmicDurationList(rd, true, rTickStart, refTimeSig, measure, 0, stf.timeStretch(tick))
            }
            if (dList.length === 0) {
                break
            }

            for (const d of dList) {
                if (ltuplet) {
                    // take care not to recreate tuplet we just deleted
                    const r = this.setRest(tick, track, d.fraction(), false, null, false)!
                    tick = tick.plus(r.actualTicks())
                } else {
                    tick = tick.plus(this.addClone(cr, tick, d).actualTicks())
                }
            }
            break
        }
        accumulated = accumulated.plus(td)
        sd = sd.minus(td)
        if (sd.isZero()) {
            break
        }
    }

    const t1 = firstSegmentEnd
    const t2 = firstSegment.tick().plus(actualTicks(accumulated, tuplet, stf.timeStretch(firstSegment.tick())))
    if (t1.lt(t2)) {
        // Delete annotations that require an anchor to the previous segment
        const s1 = this.tick2rightSegment(t1)
        const s2 = this.tick2rightSegment(t2)
        if (s1 && s2 && s2.tick().gt(s1.tick())) {
            for (let s: Segment | null = s1; s && s !== s2; s = s.next1()) {
                const annotations = [...s.annotations()] // make a copy since we alter the list
                for (const annotation of annotations) {
                    if (!annotation.systemFlag() && !annotation.allowTimeAnchor() && annotation.track() === track) {
                        this.deleteItem(annotation)
                    }
                }
            }
        }

        const filter = new SelectionFilter()
        this.deleteSlursFromRange(t1, t2, track, track + 1, filter)
    }

    return accumulated
}

Score.prototype.makeGapVoice = function (this: Score, seg: Segment, track: track_idx_t, len: Fraction, tick: Fraction): boolean {
    let cr = seg.element(track) as unknown as ChordRest | null
    if (!cr) {
        // check if we are in the middle of a chord/rest
        let seg1 = seg.prev(SegmentType.ChordRest)
        for (;;) {
            if (!seg1) {
                // C++: if (!(track % VOICES)) LOGD("no segment before tick %d", tick.ticks())
                // this happens only for voices other than voice 1
                this.expandVoice(seg, track)
                return this.makeGapVoice(seg, track, len, tick)
            }
            if (seg1.element(track)) {
                break
            }
            seg1 = seg1.prev(SegmentType.ChordRest)
        }
        const cr1 = seg1.element(track) as unknown as ChordRest
        const srcF = cr1.ticks()
        const dstF = tick.minus(cr1.tick()).times(cr1.staff()!.timeStretch(cr1.tick()))
        const dList = toDurationList(dstF, true)
        if (dList.length === 0) {
            // C++: LOGD("Could not make durations for: %d/%d", ...)
            return false
        }
        const n = dList.length
        this.undoChangeChordRestLen(cr1, dList[0])
        if (n > 1) {
            let crtick = cr1.endTick()
            const measure = this.tick2measure(crtick)!
            if (cr1.isChord()) {
                // split Chord
                let c = cr1 as Chord
                for (let i = 1; i < n; ++i) {
                    const d = dList[i]
                    const c2 = this.addChord(crtick, d, c, true, c.tuplet())!
                    c = c2
                    seg1 = c.segment()
                    crtick = crtick.plus(c.actualTicks())
                }
            } else {
                // split Rest
                const r = cr1 as Rest
                for (let i = 1; i < n; ++i) {
                    const d = dList[i]
                    const r2 = r.clone() as Rest
                    r2.setTicks(d.fraction())
                    r2.setDurationType(d)
                    this.undoAddCR(r2, measure, crtick)
                    seg1 = r2.segment()
                    crtick = crtick.plus(r2.actualTicks())
                }
            }
        }
        this.setRest(tick, track, srcF.minus(dstF), true, null)
        for (;;) {
            seg1 = seg1!.next1(SegmentType.ChordRest)
            if (!seg1) {
                // C++: LOGD("no segment")
                return false
            }
            if (seg1.element(track)) {
                cr = seg1.element(track) as unknown as ChordRest
                break
            }
        }
    }

    for (;;) {
        if (!cr) {
            // C++: LOGD("cannot make gap")
            return false
        }
        const l = this.makeGap(cr.segment(), cr.track(), len, null)
        if (l.isZero()) {
            // C++: LOGD("returns zero gap")
            return false
        }
        len = len.minus(l)
        if (len.isZero()) {
            break
        }
        // go to next cr
        let m = cr.measure().nextMeasure()
        if (!m) {
            // C++: LOGD("EOS reached")
            const options = new InsertMeasureOptions()
            options.createEmptyMeasures = false
            this.insertMeasure(ElementType.MEASURE, null, options)
            m = cr.measure().nextMeasure()
            if (!m) {
                // C++: LOGD("===EOS reached")
                return true
            }
        }
        // first segment in measure was removed, have to recreate it
        const s = m.undoGetSegment(SegmentType.ChordRest, m.tick())
        const t = cr.track()
        cr = s.element(t) as unknown as ChordRest | null
        if (!cr) {
            this.addRest(s, t, new TDuration(DurationType.V_MEASURE), null)
            cr = s.element(t) as unknown as ChordRest | null
        }
    }
    return true
}

/** cr - start of gap; gap - gap len in local (stretched) time */
Score.prototype.splitGapToMeasureBoundaries = function (this: Score, cr: ChordRest, gap: Fraction): Fraction[] {
    const flist: Fraction[] = []

    const tuplet = cr.tuplet()
    if (tuplet) {
        let rest = tuplet.elementsDuration()
        for (const de of tuplet.elements()) {
            if ((de as unknown) === cr) {
                break
            }
            rest = rest.minus((de as unknown as DurationElement).ticks())
        }
        if (rest.lt(gap)) {
            // C++: LOGD("does not fit in tuplet")
        } else {
            flist.push(gap)
        }
        return flist
    }

    let s: Segment | null = cr.segment()
    while (gap.gt(new Fraction(0, 1))) {
        let m: Measure | null = s!.measure()
        const timeStretch = cr.staff()!.timeStretch(s!.tick())
        const rest = m.ticks().minus(s!.rtick()).times(timeStretch)
        if (rest.ge(gap)) {
            flist.push(gap)
            return flist
        }
        flist.push(rest)
        gap = gap.minus(rest)
        m = m.nextMeasure()
        if (!m) {
            return flist
        }
        s = m.first(SegmentType.ChordRest)
    }
    return flist
}

/** dstF is in local (stretched) time */
Score.prototype.changeCRlen = function (this: Score, cr: ChordRest, d: TDuration | Fraction, fillWithRest = true): void {
    let dstF: Fraction
    if (d instanceof TDuration) {
        // C++ changeCRlen(ChordRest*, const TDuration&)
        if (d.type() === DurationType.V_MEASURE) {
            dstF = cr.measure().stretchedLen(cr.staff()!)
        } else {
            dstF = d.fraction()
        }
    } else {
        dstF = d
    }

    if (cr.isMeasureRepeat()) {
        // it is not clear what should this
        // operation mean for measure repeats.
        return
    }
    const srcF = cr.ticks()
    if (srcF.eq(dstF)) {
        if (cr.isFullMeasureRest()) {
            this.undoChangeChordRestLen(cr, new TDuration(dstF))
        }
        return
    }

    //keep selected element if any
    const selElement = this.selection().isSingle() ? this.getSelectedElement() : null

    const track = cr.track()
    const tuplet = cr.tuplet()

    if (srcF.gt(dstF)) {
        //
        // make shorter and fill with rest
        //
        this.deselectAll()
        if (cr.isChord()) {
            //
            // remove ties and tremolo between 2 notes
            //
            const c = cr as Chord
            if (c.tremoloTwoChord()) {
                this.undoRemoveElement(c.tremoloTwoChord())
            }
            for (const n of c.notes()) {
                const tie = n.tieFor()
                if (tie) {
                    // TODO(port): tie->undoRemoveTiesFromJumpPoints() (ties over repeats)
                    this.undoRemoveElement(tie)
                }
                for (const sp of [...n.spannerFor()]) {
                    if (sp.isGlissando() || sp.isGuitarBend()) {
                        this.undoRemoveElement(sp)
                    }
                }
            }
        }
        const timeStretch = cr.staff()!.timeStretch(cr.tick())
        const dList = toDurationList(dstF, true)
        if (dList.length === 0) {
            // C++: LOGD("Could not make durations for: %d/%d", ...)
            return
        }
        this.undoChangeChordRestLen(cr, dList[0])
        let tick2 = cr.tick()
        for (let i = 1; i < dList.length; ++i) {
            tick2 = tick2.plus(actualTicks(dList[i - 1].ticks(), tuplet, timeStretch))
            const d2 = dList[i]
            this.setRest(tick2, track, d2.fraction(), d2.dots() > 0, tuplet)
        }
        if (fillWithRest) {
            this.setRest(cr.endTick(), track, srcF.minus(dstF), false, tuplet)
        }

        if (selElement) {
            this.select(selElement, SelectType.SINGLE, 0)
        }
        return
    }

    //
    // make longer
    //
    // split required len into Measures
    const flist = this.splitGapToMeasureBoundaries(cr, dstF)
    if (flist.length === 0) {
        return
    }

    this.deselectAll()
    let elementToSelect: EngravingItem | null = null

    let tick = cr.tick()
    let cr1: ChordRest | null = cr
    let oc: Chord | null = null
    let s: Segment | null = cr.segment()

    let first = true
    for (const f2 of flist) {
        if (!cr1) {
            this.expandVoice(s!, track)
            cr1 = s!.element(track) as unknown as ChordRest
        }

        this.makeGap(cr1.segment(), cr1.track(), f2, tuplet, first)

        if (cr.isRest()) {
            const timeStretch = cr1.staff()!.timeStretch(cr1.tick())
            let r: Rest | null = cr as Rest
            if (first) {
                const dList = toDurationList(f2, true)
                this.undoChangeChordRestLen(cr, dList[0])
                let tick2 = cr.tick()
                for (let i = 1; i < dList.length; ++i) {
                    tick2 = tick2.plus(actualTicks(dList[i - 1].ticks(), tuplet, timeStretch))
                    const d2 = dList[i]
                    this.setRest(tick2, track, d2.fraction(), d2.dots() > 0, tuplet)
                }
            } else {
                r = this.setRest(tick, track, f2, false, tuplet)
            }
            if (first) {
                elementToSelect = r
                first = false
            }
            tick = tick.plus(actualTicks(f2, tuplet, timeStretch))
        } else {
            const dList = toDurationList(f2, true)
            const measure = this.tick2measure(tick)!
            const etick = measure.tick()

            if ((tick.minus(etick).ticks() % dList[0].ticks().ticks()) === 0) {
                for (const du of dList) {
                    if (oc) {
                        const cc: Chord = oc
                        oc = this.addChord(tick, du, cc, true, tuplet)
                    } else {
                        this.undoChangeChordRestLen(cr, du)
                        oc = cr as Chord
                    }
                    if (oc && first) {
                        elementToSelect = selElement ?? oc
                        first = false
                    }
                    if (oc) {
                        tick = tick.plus(oc.actualTicks())
                    }
                }
            } else {
                for (let i = dList.length; i > 0; --i) { // loop probably needs to be in this reverse order
                    if (oc) {
                        const cc: Chord = oc
                        oc = this.addChord(tick, dList[i - 1], cc, true, tuplet)
                    } else {
                        this.undoChangeChordRestLen(cr, dList[i - 1])
                        oc = cr as Chord
                    }
                    if (first) {
                        elementToSelect = selElement
                        first = false
                    }
                    tick = tick.plus(oc!.actualTicks())
                }
            }
        }
        const m = cr1.measure()
        const m1 = m.nextMeasure()
        if (!m1) {
            break
        }
        s = m1.first(SegmentType.ChordRest)
        cr1 = s ? s.element(track) as unknown as ChordRest | null : null
    }
    this.connectTies()

    if (elementToSelect) {
        if (this.canReselectItem(elementToSelect)) {
            this.select(elementToSelect, SelectType.SINGLE, 0)
        }
    }
}

function upDownChromatic(up: boolean, pitch: number, n: Note, key: Key, tpc1: number, tpc2: number):
    { newPitch: number; newTpc1: number; newTpc2: number } | null {
    const concertPitch = n.concertPitch()
    const noteAccVal = tpc2alter(concertPitch ? tpc1 : tpc2)
    let accState = AccidentalVal.NATURAL
    const m = n.findMeasure()
    if (m) {
        accState = m.findAccidental(n)
    }
    let newPitch: number
    let newTpc1: number
    let newTpc2: number
    if (up && pitch < 127) {
        newPitch = pitch + 1
        if (concertPitch) {
            if (tpc1 > Tpc.TPC_A + key && noteAccVal >= accState) {
                newTpc1 = tpc1 - 5 // up semitone diatonic
            } else {
                newTpc1 = tpc1 + 7 // up semitone chromatic
            }
            newTpc2 = n.transposeTpc(newTpc1)
        } else {
            if (tpc2 > Tpc.TPC_A + key && noteAccVal >= accState) {
                newTpc2 = tpc2 - 5 // up semitone diatonic
            } else {
                newTpc2 = tpc2 + 7 // up semitone chromatic
            }
            newTpc1 = n.transposeTpc(newTpc2)
        }
    } else if (!up && pitch > 0) {
        newPitch = pitch - 1
        if (concertPitch) {
            if (tpc1 > Tpc.TPC_C + key || noteAccVal > accState) {
                newTpc1 = tpc1 - 7 // down semitone chromatic
            } else {
                newTpc1 = tpc1 + 5 // down semitone diatonic
            }
            newTpc2 = n.transposeTpc(newTpc1)
        } else {
            if (tpc2 > Tpc.TPC_C + key || noteAccVal > accState) {
                newTpc2 = tpc2 - 7 // down semitone chromatic
            } else {
                newTpc2 = tpc2 + 5 // down semitone diatonic
            }
            newTpc1 = n.transposeTpc(newTpc2)
        }
    } else {
        return null
    }
    return { newPitch, newTpc1, newTpc2 }
}

/** Increment/decrement pitch of note by one or by an octave. */
Score.prototype.upDown = function (this: Score, up: boolean, mode: UpDownMode): void {
    const el = this.selection().uniqueNotes()

    el.sort((a, b) => up ? a.string() - b.string() : b.string() - a.string())

    for (const oNote of el) {
        const tick = oNote.chord().tick()
        const staff = oNote.staff()!
        const part = staff.part()
        const key = staff.key(tick)
        const tpc1 = oNote.tpc1()
        const tpc2 = oNote.tpc2()
        const pitch = oNote.pitch()
        const pitchOffset = staff.pitchOffset(tick)
        let newTpc1 = tpc1 // default to unchanged
        let newTpc2 = tpc2 // default to unchanged
        let newPitch = pitch // default to unchanged
        let string = oNote.string()
        let fret = oNote.fret()
        const applyChromatic = (): void => {
            const r = upDownChromatic(up, pitch, oNote, key, tpc1, tpc2)
            if (r) {
                newPitch = r.newPitch
                newTpc1 = r.newTpc1
                newTpc2 = r.newTpc2
            }
        }

        let staffGroup = staff.staffType(oNote.chord().tick()).group()
        // if not tab, check for instrument instead of staffType (for pitched to unpitched instrument changes)
        if (staffGroup !== StaffGroup.TAB) {
            staffGroup = staff.part().instrument(oNote.tick()).useDrumset() ? StaffGroup.PERCUSSION : StaffGroup.STANDARD
        }

        switch (staffGroup) {
        case StaffGroup.PERCUSSION: {
            const ds = part.instrument(tick).drumset()
            if (ds) {
                newPitch = up ? ds.nextPitch(pitch) : ds.prevPitch(pitch)
                newTpc1 = pitch2tpc(newPitch, Key.C, Prefer.NEAREST)
                newTpc2 = newTpc1
            }
            break
        }
        case StaffGroup.TAB: {
            const stringData = part.stringData(tick, staff.idx())!
            switch (mode) {
            case UpDownMode.OCTAVE: { // move same note to next string, if possible
                const stt = staff.staffType(tick)
                string = stt.physStringToVisual(string)
                string += (up ? -1 : 1)
                if (string < 0 || string >= stringData.strings()) {
                    return // no next string to move to
                }
                string = stt.visualStringToPhys(string)
                fret = stringData.fretForStaff(pitch, string, staff, tick)
                if (fret === -1) { // can't have that note on that string
                    return
                }
                // newPitch and newTpc remain unchanged
                break
            }

            case UpDownMode.DIATONIC: // increase / decrease the pitch,
                // letting the algorithm to choose fret & string
                applyChromatic()
                break

            case UpDownMode.CHROMATIC: { // increase / decrease the fret without changing the string
                // compute new fret
                if (!stringData.frets()) {
                    // C++: LOGD("upDown tab chromatic: no frets?")
                    return
                }
                fret += (up ? 1 : -1)
                if (fret < 0 || fret > stringData.frets()) {
                    // C++: LOGD("upDown tab in-string: out of fret range")
                    return
                }
                // update pitch and tpc's and check it matches stringData
                applyChromatic()
                if (newPitch + pitchOffset !== stringData.getPitchAt(string, fret, staff, oNote.tick())
                    && !oNote.bendBack()) {
                    // oh-oh: something went very wrong!
                    // C++: LOGD("upDown tab in-string: pitch mismatch")
                    return
                }
                // store the fretting change before undoChangePitch() chooses
                // a fretting of its own liking!
                oNote.undoChangeProperty(Pid.FRET, fret)
                break
            }
            }
            break
        }
        case StaffGroup.STANDARD:
            switch (mode) {
            case UpDownMode.OCTAVE:
                if (up) {
                    if (pitch < 116) {
                        newPitch = pitch + 12
                    }
                } else {
                    if (pitch > 11) {
                        newPitch = pitch - 12
                    }
                }
                // newTpc remains unchanged
                break

            case UpDownMode.CHROMATIC:
                applyChromatic()
                break

            case UpDownMode.DIATONIC: {
                const firstTiedNote = oNote.firstTiedNote()
                const newLine = firstTiedNote.line() + (up ? -1 : 1)
                const vStaff = this.score().staff(firstTiedNote.chord().vStaffIdx())!

                let [accOffs, error] = firstTiedNote.chord().measure().findAccidentalAtLine(
                    firstTiedNote.chord().segment(), firstTiedNote.chord().vStaffIdx(), newLine)
                if (error) {
                    accOffs = Accidental.subtype2value(AccidentalType.NONE)
                }
                const nStep = absStepFromLine(newLine, vStaff.clef(tick))
                const octave = Math.trunc(nStep / 7)
                const testPitch = step2pitch(nStep) + octave * 12 + accOffs

                if (testPitch <= 127 && testPitch > 0) {
                    newPitch = testPitch
                    newTpc1 = newTpc2 = step2tpc(nStep % 7, accOffs)
                    if (firstTiedNote.concertPitch()) {
                        newTpc2 = firstTiedNote.transposeTpc(newTpc1)
                    } else {
                        newPitch += vStaff.transpose(tick).chromatic
                        newTpc1 = firstTiedNote.transposeTpc(newTpc2)
                    }
                }
                break
            }
            }
            break
        }

        if ((oNote.pitch() !== newPitch) || (oNote.tpc1() !== newTpc1) || oNote.tpc2() !== newTpc2) {
            // remove accidental if present to make sure
            // user added accidentals are removed here
            // unless it's an octave change
            // in this case courtesy accidentals are preserved
            // because they're now harder to be re-entered due to the revised note-input workflow
            if (mode !== UpDownMode.OCTAVE) {
                for (const e of oNote.linkList()) {
                    const ln = e as unknown as Note
                    if (ln.accidental()) {
                        this.doUndoRemoveElement(ln.accidental()!)
                    }
                }
            }
            this.undoChangePitch(oNote, newPitch, newTpc1, newTpc2)
            if (mode === UpDownMode.DIATONIC) {
                const sd = part.stringData(tick, staff.idx())
                if (sd) {
                    const r = sd.convertPitch(newPitch, StringData.pitchOffsetAt(staff, tick))
                    string = r.string
                    fret = r.fret
                }
                this.undoChangeFretting(oNote, newPitch, string, fret, newTpc1, newTpc2)
            }
        } else if (staff.staffType(tick).group() === StaffGroup.TAB) {
            // store fret change only if undoChangePitch has not been called,
            // as undoChangePitch() already manages fret changes, if necessary
            let refret = false
            if (oNote.string() !== string) {
                oNote.undoChangeProperty(Pid.STRING, string)
                refret = true
            }
            if (oNote.fret() !== fret) {
                oNote.undoChangeProperty(Pid.FRET, fret)
                refret = true
            }
            if (refret) {
                const stringData = part.stringData(tick, staff.idx())
                stringData?.fretChords(oNote.chord())
            }
        }

        // TODO(port): setPlayNote(true) (play new note with velocity 80 for 0.3 sec)
    }
    this.setSelectionChanged(true)
}

/** Add the delta to the pitch of note. */
Score.prototype.upDownDelta = function (this: Score, pitchDelta: number): void {
    while (pitchDelta > 0) {
        this.upDown(true, UpDownMode.CHROMATIC)
        pitchDelta--
    }

    while (pitchDelta < 0) {
        this.upDown(false, UpDownMode.CHROMATIC)
        pitchDelta++
    }
}

Score.prototype.toggleAccidental = function (this: Score, at: AccidentalType): void {
    const is = this.inputState()
    let applyNaturalToInputNotes = false
    if (is.accidentalType() === at && at !== AccidentalType.NONE) {
        at = AccidentalType.NONE // NONE also means "search for previous accidental and use it if found"
        applyNaturalToInputNotes = true
    }

    if (this.noteEntryMode()) {
        is.setAccidentalType(at)
        is.setRest(false)

        if (is.notes().length) {
            this.applyAccidentalToInputNotes(applyNaturalToInputNotes ? AccidentalType.NATURAL : at)
        }
    } else {
        if (this.selection().isNone()) {
            is.setAccidentalType(at)
            is.setDuration(DurationType.V_QUARTER)
            is.setRest(false)
        } else {
            this.changeAccidental(at)
        }
    }
}

Score.prototype.applyAccidentalToInputNotes = function (this: Score, accidentalType: AccidentalType): void {
    const is = this.inputState()
    const notes: NoteVal[] = []

    const pos = new Position()
    pos.segment = is.segment()
    pos.staffIdx = is.staffIdx()

    for (const oldVal of is.notes()) {
        pos.line = noteValToLine(oldVal, is.staff()!, is.tick())

        const newVal = this.noteValForPosition(pos, accidentalType)

        if (!newVal) {
            notes.push(oldVal)
        } else {
            notes.push(newVal)
        }
    }

    is.setNotes(notes)
}

/** Change accidental to subtype idx for all selected notes. */
Score.prototype.changeAccidental = function (this: Score, idx: AccidentalType): void {
    for (const item of [...this.selection().elements()]) {
        switch (item.type()) {
        case ElementType.ACCIDENTAL: {
            const accidental = item as unknown as Accidental
            if (accidental.accidentalType() === idx) {
                this.changeNoteAccidental(accidental.note()!, AccidentalType.NONE)
            } else {
                this.changeNoteAccidental(accidental.note()!, idx)
            }
            break
        }
        case ElementType.NOTE:
            this.changeNoteAccidental(item as unknown as Note, idx)
            break
        default:
            break
        }
    }
}

/** C++ changeAccidental2(): C++ also computes the new string and fret of tablature notes here (unused) */
function changeAccidental2(n: Note, pitch: number, tpc: number): void {
    const score = n.score()
    const chord = n.chord()
    const st = chord.staff()!

    let tpc1: number
    let tpc2 = n.transposeTpc(tpc)
    if (n.style().styleB(Sid.concertPitch)) {
        tpc1 = tpc
    } else {
        tpc1 = tpc2
        tpc2 = tpc
    }

    if (!st.isTabStaff(chord.tick())) {
        //
        // handle ties
        //
        if (n.tieBack()) {
            if (pitch !== n.pitch()) {
                score.undoRemoveElement(n.tieBack())
                if (n.tieFor()) {
                    score.undoRemoveElement(n.tieFor())
                }
            }
        } else {
            let nn: Note | null = n
            while (nn && nn.tieFor()) {
                nn = nn.tieFor()!.endNote()
                if (nn) {
                    score.undo(new ChangePitch(nn, pitch, tpc1, tpc2))
                }
            }
        }
    }
    score.undoChangePitch(n, pitch, tpc1, tpc2)
}

/** Change accidental to subtype accidental for note note. */
Score.prototype.changeNoteAccidental = function (this: Score, note: Note, accidental: AccidentalType): void {
    const chord = note ? note.chord() : null
    if (!chord) {
        return
    }
    const segment = chord.segment()
    if (!segment) {
        return
    }
    const measure = segment.measure()
    if (!measure) {
        return
    }
    const tick = segment.tick()
    const estaff = this.staff(chord.staffIdx() + chord.staffMove())
    if (!estaff) {
        return
    }
    const clef = estaff.clef(tick)
    if (clef === ClefType.TAB
        || clef === ClefType.TAB4
        || clef === ClefType.TAB_SERIF
        || clef === ClefType.TAB4_SERIF) {
        return
    }
    let step = ClefInfo.pitchOffset(clef) - note.line()
    while (step < 0) {
        step += 7
    }
    step %= 7
    //
    // accidental change may result in pitch change
    //
    const acc2 = measure.findAccidental(note)
    const acc = (accidental === AccidentalType.NONE) ? acc2 : Accidental.subtype2value(accidental)

    let pitch = line2pitch(note.line(), clef, Key.C) + acc
    if (!note.concertPitch()) {
        pitch += note.transposition()
    }

    const tpc = step2tpc(step, acc)

    let forceRemove = false
    let forceAdd = false

    // delete accidental
    // both for this note and for any linked notes
    if (accidental === AccidentalType.NONE) {
        forceRemove = true
    } else if (acc === acc2 || (pitch === note.pitch() && !Accidental.isMicrotonal(note.accidentalType()))
        || Accidental.isMicrotonal(accidental)) {
        // precautionary or microtonal accidental
        // either way, we display it unconditionally
        // both for this note and for any linked notes
        forceAdd = true
    }

    for (const se of note.linkList()) {
        const ln = se as unknown as Note
        if (ln.concertPitch() !== note.concertPitch()) {
            continue
        }
        const lns = ln.score()
        const a = ln.accidental()
        if (forceRemove) {
            if (a) {
                lns.undoRemoveElement(a)
            }
            if (ln.tieBack()) {
                continue
            }
        } else if (forceAdd) {
            if (a) {
                this.undoRemoveElement(a)
            }
            const a1 = Factory.createItem(ElementType.ACCIDENTAL, ln) as Accidental
            a1.setParent(ln)
            a1.setAccidentalType(accidental)
            a1.setRole(AccidentalRole.USER)
            lns.undoAddElement(a1)
        } else if (a && Accidental.isMicrotonal(a.accidentalType())) {
            lns.undoRemoveElement(a)
        }
        changeAccidental2(ln, pitch, tpc)
    }
    // TODO(port): setPlayNote(true)
    this.setSelectionChanged(true)
}

Score.prototype.cmdIncDecDuration = function (this: Score, nSteps: number, stepDotted = false): void {
    const sel = this.selection()
    if (sel.isRange()) {
        // TODO(port): range selections (copy the range as mime data, deleteRange and pasteStaff with the scale)
        return
    } else if (sel.isList()) {
        const notes = sel.noteList()
        const crs = [...this.getSelectedChordRests()]
        crs.sort((a, b) => (b.tick().lt(a.tick()) ? -1 : b.tick().gt(a.tick()) ? 1 : 0))

        for (const cr of crs) {
            // if measure rest is selected as input, then the correct initialDuration will be the
            // duration of the measure's time signature, else is just the ChordRest's duration
            let initialDuration = cr.durationType()
            if (initialDuration.equals(DurationType.V_MEASURE)) {
                initialDuration = new TDuration(cr.measure().timesig(), true)

                if (initialDuration.fraction().lt(cr.measure().timesig()) && nSteps > 0) {
                    // Duration already shortened by truncation; shorten one step less
                    --nSteps
                }
            }

            const newDuration = stepDotted ? initialDuration.shiftRetainDots(nSteps, stepDotted) : initialDuration.shift(nSteps)
            if (!newDuration.isValid()) {
                continue
            }

            if (cr.isGrace()) {
                this.undoChangeChordRestLen(cr, newDuration)
            } else {
                this.changeCRlen(cr, newDuration)
            }
        }
        for (const n of notes) {
            if (this.canReselectItem(n)) {
                this.select(n, SelectType.ADD)
            }
        }
        const is = this.inputState()
        if (is.noteEntryMode()) {
            const cr = crs.length === 1 ? crs[0] : null
            if (!cr) {
                // (At time of writing) it shouldn't be possible to have more than
                // one CR selected during note entry...
                return
            }
            is.setDuration(cr.durationType())
            this.nextInputPos(cr, false)
        }
    }
}

Score.prototype.cmdMoveRest = function (this: Score, rest: Rest, dir: DirectionV): void {
    let pos = rest.offset().clone()
    const d = rest.spatium() * rest.staffType()!.lineDistance().val()
    if (dir === DirectionV.UP) {
        pos = new PointF(pos.x(), pos.y() - d)
    } else if (dir === DirectionV.DOWN) {
        pos = new PointF(pos.x(), pos.y() + d)
    }
    rest.undoChangeProperty(Pid.OFFSET, pos)
}

Score.prototype.cmdPitchUp = function (this: Score): void {
    const el = this.selection().element()
    if (el && el.isLyrics()) {
        // TODO(port): cmdMoveLyrics(toLyrics(el), DirectionV::UP)
    } else if (el && (el.isArticulationFamily() || el.isTextBase())) {
        el.undoChangeProperty(Pid.OFFSET, el.offset().plus(new PointF(0.0, -MScore.nudgeStep * el.spatium())), PropertyFlags.UNSTYLED)
    } else if (el && el.isRest()) {
        this.cmdMoveRest(el as unknown as Rest, DirectionV.UP)
    } else {
        this.upDown(true, UpDownMode.CHROMATIC)
    }
}

Score.prototype.cmdPitchDown = function (this: Score): void {
    const el = this.selection().element()
    if (el && el.isLyrics()) {
        // TODO(port): cmdMoveLyrics(toLyrics(el), DirectionV::DOWN)
    } else if (el && (el.isArticulationFamily() || el.isTextBase())) {
        el.undoChangeProperty(Pid.OFFSET, el.offset().plus(new PointF(0.0, MScore.nudgeStep * el.spatium())), PropertyFlags.UNSTYLED)
    } else if (el && el.isRest()) {
        this.cmdMoveRest(el as unknown as Rest, DirectionV.DOWN)
    } else {
        this.upDown(false, UpDownMode.CHROMATIC)
    }
}

Score.prototype.cmdPitchUpOctave = function (this: Score): void {
    const el = this.selection().element()
    if (el && (el.isArticulationFamily() || el.isTextBase())) {
        el.undoChangeProperty(Pid.OFFSET, el.offset().plus(new PointF(0.0, -MScore.nudgeStep10 * el.spatium())), PropertyFlags.UNSTYLED)
    } else {
        this.upDown(true, UpDownMode.OCTAVE)
    }
}

Score.prototype.cmdPitchDownOctave = function (this: Score): void {
    const el = this.selection().element()
    if (el && (el.isArticulationFamily() || el.isTextBase())) {
        el.undoChangeProperty(Pid.OFFSET, el.offset().plus(new PointF(0.0, MScore.nudgeStep10 * el.spatium())), PropertyFlags.UNSTYLED)
    } else {
        this.upDown(false, UpDownMode.OCTAVE)
    }
}

Score.prototype.cmdSetVisible = function (this: Score): void {
    for (const e of this.selection().elements()) {
        this.undo(new ChangeProperty(e, Pid.VISIBLE, true))
    }
}

Score.prototype.cmdUnsetVisible = function (this: Score): void {
    for (const e of this.selection().elements()) {
        this.undo(new ChangeProperty(e, Pid.VISIBLE, false))
    }
}

/** C++ resolveNoteInputParams(int note, bool addFlag, NoteInputParams& out): null if C++ returns false */
Score.prototype.resolveNoteInputParams = function (this: Score, note: number, addFlag: boolean): NoteInputParams | null {
    const is = this.inputState()

    //! NOTE: Drumset params should be defined explicitly (see NotationViewInputController::tryPercussionShortcut)
    if (!is.isValid() || is.drumset()) {
        return null
    }

    let octave = 4

    const tab = [0, 2, 4, 5, 7, 9, 11]

    // if adding notes, add above the upNote of the current chord
    const el = this.selection().element()
    if (addFlag && el && el.isNote()) {
        const chord = (el as unknown as Note).chord()
        const n = chord.upNote()
        const tpc = n.tpc()
        octave = Math.trunc((n.epitch() - tpc2alter(tpc)) / PITCH_DELTA_OCTAVE)
        if (note <= tpc2step(tpc)) {
            octave++
        }
    } else {
        let curPitch = 60
        if (is.segment()) {
            const staff = this.staff(Math.trunc(is.track() / VOICES))!
            const st = SegmentType.ChordRest | SegmentType.Clef | SegmentType.HeaderClef
            let seg = is.segment()!.prev1(st)
            while (seg) {
                if (seg.isChordRestType()) {
                    const p = seg.element(is.track())
                    if (p && p.isChord()) {
                        const n = (p as unknown as Chord).downNote()
                        // forget any accidental and/or adjustment due to key signature
                        curPitch = n.epitch() - tpc2alter(n.tpc())
                        break
                    }
                } else if (seg.isClefType() || seg.isHeaderClefType()) {
                    const p = seg.element(trackZeroVoice(is.track())) // clef on voice 1
                    if (p && p.isClef()) {
                        const clef = p as unknown as Clef
                        // check if it's an actual change or just a courtesy
                        const ctb = staff.clef(clef.tick().minus(Fraction.eps()))
                        if (ctb !== clef.clefType() || clef.tick().isZero()) {
                            curPitch = line2pitch(4, clef.clefType(), Key.C) // C 72 for treble clef
                            break
                        }
                    }
                }
                seg = seg.prev1MM(st)
            }
            octave = Math.trunc(curPitch / 12)
        }

        const delta = octave * 12 + tab[note] - curPitch
        if (delta > 6) {
            --octave
        } else if (delta < -6) {
            ++octave
        }
    }

    return { step: octave * 7 + note, drumPitch: -1 }
}

/** insert note or add note to chord */
Score.prototype.cmdAddPitch = function (this: Score, paramsOrStep: NoteInputParams | number, addFlag: boolean, insert: boolean): void {
    const is = this.inputState()
    let step: number
    if (typeof paramsOrStep !== 'number') {
        // C++ cmdAddPitch(const NoteInputParams&, bool, bool)
        const params = paramsOrStep
        if (!is.isValid()) {
            // C++: LOGD("cannot enter notes here (no chord rest at current position)")
            return
        }

        is.setRest(false)

        const ds = is.drumset()
        if (ds) {
            is.setDrumNote(params.drumPitch)
            is.setVoice(ds.voice(params.drumPitch))
        }
        step = params.step
    } else {
        step = paramsOrStep
    }

    insert = insert || is.usingNoteEntryMethod(NoteEntryMethod.TIMEWISE)
    const pos = new Position()
    if (addFlag) {
        const el = this.selection().element()
        if (el && el.isNote()) {
            const selectedNote = el as unknown as Note
            const chord = selectedNote.chord()
            const seg = chord.segment()
            pos.segment = seg
            pos.staffIdx = chord.vStaffIdx()
            const clef = this.staff(pos.staffIdx)!.clef(seg.tick())
            pos.line = relStep(step, clef)
            const nval = this.noteValForPosition(pos, is.accidentalType())
            if (!nval) {
                return
            }
            let forceAccidental = false
            if (is.accidentalType() !== AccidentalType.NONE) {
                const nval2 = this.noteValForPosition(pos, AccidentalType.NONE)
                forceAccidental = !!nval2 && (nval.pitch === nval2.pitch)
            }
            if (is.usingNoteEntryMethod(NoteEntryMethod.REPITCH)) {
                this.addPitchToChord(nval, chord, /* externalInputState */ null, forceAccidental)
            } else {
                this.addNote(chord, nval, forceAccidental, is.articulationIds())
            }
            is.setAccidentalType(AccidentalType.NONE)
            return
        }
    }

    pos.segment = is.segment()
    pos.staffIdx = Math.trunc(is.track() / VOICES)
    const clef = this.staff(pos.staffIdx)!.clef(pos.segment!.tick())
    pos.line = relStep(step, clef)

    if (is.usingNoteEntryMethod(NoteEntryMethod.REPITCH)) {
        this.repitchNote(pos, !addFlag)
    } else {
        if (insert) {
            this.insertChordByInsertingTime(pos)
        } else {
            this.putNote(pos, !addFlag)
        }
    }
    is.setAccidentalType(AccidentalType.NONE)
}

Score.prototype.cmdToggleVisible = function (this: Score): void {
    let allVisible = true

    for (const item of this.selection().elements()) {
        if (!item.visible()) {
            allVisible = false
            break
        }
    }

    const newVisible = !allVisible

    for (const item of [...this.selection().elements()]) {
        this.undoChangeVisible(item, newVisible)
    }
}

//---------------------------------------------------------
//   cmdAddBracket
//---------------------------------------------------------

Score.prototype.cmdAddBracket = function (this: Score): void {
    for (const el of this.selection().elements()) {
        if (el.isAccidental()) {
            el.undoChangeProperty(Pid.ACCIDENTAL_BRACKET, AccidentalBracket.BRACKET)
        }
    }
}

//---------------------------------------------------------
//   cmdToggleParenthesesOnNotes
//---------------------------------------------------------

/** C++ std::set<Note*, NoteComparator>::insert: sorted by noteIsBefore, unison notes kept (in insertion order) */
function insertNoteSorted(set: Note[], note: Note): void {
    if (set.includes(note)) {
        return
    }
    let i = 0
    while (i < set.length && !noteIsBefore(note, set[i])) {
        ++i
    }
    set.splice(i, 0, note)
}

function getNotesByChord(notes: readonly Note[]): Map<Chord, Note[]> {
    // Return map of notes by chord
    // Include all notes between highest and lowest in each chord
    const notesByChord = new Map<Chord, Note[]>()
    for (const noteToAdd of notes) {
        const chord = noteToAdd.chord()
        const set = notesByChord.get(chord)

        if (!set) {
            notesByChord.set(chord, [noteToAdd])
            continue
        }

        // Add all notes between last note and this one
        const prevNote = set[set.length - 1]

        const firstNote = noteIsBefore(noteToAdd, prevNote) ? noteToAdd : prevNote
        const secondNote = firstNote === noteToAdd ? prevNote : noteToAdd

        const chordNotes = chord.notes()
        const firstNoteIt = chordNotes.indexOf(firstNote)
        const secondNoteIt = chordNotes.indexOf(secondNote)

        for (let i = firstNoteIt; i <= secondNoteIt; ++i) {
            insertNoteSorted(set, chordNotes[i])
        }
    }

    return notesByChord
}

Score.prototype.cmdToggleParenthesesOnNotes = function (this: Score): void {
    const notes = this.selection().uniqueNotes(nidx, false)

    let add = false

    for (const note of notes) {
        if (note.getProperty(Pid.HAS_PARENTHESES) === ParenthesesMode.NONE) {
            add = true
            break
        }
    }

    if (add) {
        this.cmdAddParenthesesToNotes(notes)
    } else {
        this.cmdRemoveParenthesesFromNotes(notes)
    }
}

Score.prototype.cmdAddParenthesesToNotes = function (this: Score, notes?: Note[]): void {
    const notesByChord = getNotesByChord(notes ?? this.selection().uniqueNotes(nidx, false))

    for (const [chord, noteVec] of notesByChord) {
        for (const note of noteVec) {
            // User has overriden generated parentheses
            note.undoChangeProperty(Pid.HIDE_GENERATED_PARENTHESES, true)
            note.undoChangeProperty(Pid.HAS_PARENTHESES, ParenthesesMode.BOTH)
        }

        EditChord.removeChordParentheses(chord, noteVec)
        EditChord.addChordParentheses(chord, noteVec)
    }
}

Score.prototype.cmdRemoveParenthesesFromNotes = function (this: Score, notes?: Note[]): void {
    const notesByChord = getNotesByChord(notes ?? this.selection().uniqueNotes(nidx, false))

    for (const [chord, noteVec] of notesByChord) {
        for (const note of noteVec) {
            note.undoChangeProperty(Pid.HAS_PARENTHESES, ParenthesesMode.NONE)

            // User has overriden generated parentheses
            note.undoChangeProperty(Pid.HIDE_GENERATED_PARENTHESES, true)
        }

        EditChord.removeChordParentheses(chord, noteVec)
    }
}

//---------------------------------------------------------
//   cmdToggleParentheses
//---------------------------------------------------------

Score.prototype.cmdToggleParentheses = function (this: Score, el?: EngravingItem): void {
    if (el) {
        if (el.isAccidental()) {
            el.undoChangeProperty(Pid.ACCIDENTAL_BRACKET, AccidentalBracket.PARENTHESIS)
        } else if (el.type() === ElementType.TIMESIG) {
            (el as TimeSig).setLargeParentheses(true)
        } else {
            const p = el.leftParen() || el.rightParen() ? ParenthesesMode.NONE : ParenthesesMode.BOTH
            el.undoChangeProperty(Pid.HAS_PARENTHESES, p)
        }
        return
    }

    this.cmdToggleParenthesesOnNotes()

    for (const e of [...this.selection().elements()]) {
        if (e.isNote()) {
            continue
        }
        this.cmdToggleParentheses(e)
    }
}

//---------------------------------------------------------
//   cmdAddBraces
//---------------------------------------------------------

Score.prototype.cmdAddBraces = function (this: Score): void {
    for (const el of this.selection().elements()) {
        if (el.isAccidental()) {
            el.undoChangeProperty(Pid.ACCIDENTAL_BRACKET, AccidentalBracket.BRACE)
        }
    }
}

// =====================================================================================================================
//   cmd.cpp functions for drop / palette elements (cmdInsertClef, toggleArticulation, ...): this section is filled
//   by the palette drop port; the editing commands go above it
// =====================================================================================================================

// (imports of this section; ES imports are hoisted; the others are the ones at the top of the file)
import { BarLineType, LayoutBreakType } from '../types/types'
import { splitArticulation } from '../rw/compat/compatconversions'
import type { Articulation } from '../dom/articulation'
import type { MeasureBase } from '../dom/measurebase'
import type { BarLine } from '../dom/barline'
import type { Spanner } from '../dom/spanner'

declare module '../dom/score' {
    interface Score {
        canInsertClef(type: ClefType): boolean
        /** C++ cmdInsertClef(ClefType) (at the input position) and cmdInsertClef(Clef*, ChordRest*) (insert clef before cr) */
        cmdInsertClef(clefOrType: Clef | ClefType, cr?: ChordRest): void
        /** Toggle attribute attr for all selected notes/rests. */
        toggleArticulation(attr: SymId): void
        /** returns false if the articulation was removed (or could not be added) */
        toggleArticulation(el: EngravingItem, a: Articulation): boolean
        /** Like toggleArticulation, but for ornaments. */
        toggleOrnament(attr: SymId): void
        cmdToggleLayoutBreak(type: LayoutBreakType): void
        /**
         * C++ cmdAddSpanner(Spanner*, const PointF&, bool): drop VOLTA, OTTAVA, TRILL, PEDAL, DYNAMIC, HAIRPIN, LET_RING,
         * VIBRATO and TEXTLINE at a canvas position
         */
        cmdAddSpannerAtPos(spanner: Spanner, pos: PointF, systemStavesOnly?: boolean): void
        /** C++ cmdAddSpanner(Spanner*, staff_idx_t, Segment*, Segment*, bool): used when applying a spanner to a selection */
        cmdAddSpanner(spanner: Spanner, staffIdx: number, startSegment: Segment, endSegment: Segment | null,
            ctrlModifier?: boolean): void
    }
}

Score.prototype.canInsertClef = function (this: Score, type: ClefType): boolean {
    if (type === ClefType.INVALID) {
        return false
    }

    const staff = this.staff(Math.trunc(this.inputState().track() / VOICES))
    const cr = this.inputState().cr()

    return !!staff && !!cr
}

Score.prototype.cmdInsertClef = function (this: Score, clefOrType: Clef | ClefType, cr?: ChordRest): void {
    if (typeof clefOrType === 'number') {
        const is = this.inputState()
        this.undoChangeClef(this.staff(Math.trunc(is.track() / VOICES))!, is.cr()!, clefOrType)
        return
    }
    this.undoChangeClef(cr!.staff()!, cr!, clefOrType.clefType())
}

function toggleArticulationOf(score: Score, el: EngravingItem, a: Articulation): boolean {
    let c: Chord
    if (el.isNote()) {
        c = (el as unknown as Note).chord()
    } else if (el.isChord()) {
        c = el as unknown as Chord
    } else {
        return false
    }
    const oa = c.hasArticulation(a)
    if (oa) {
        score.undoRemoveElement(oa)
        return false
    }

    const tap = c.tapping()
    if (tap) {
        // If we got here it means that the user is entering a tap
        // of different hand, so replace the old one
        score.undoRemoveElement(tap)
    }

    if (!a.isDouble()) {
        a.setParent(c)
        a.setTrack(c.track())
        score.undoAddElement(a)
        return true
    }

    // Split the new articulation into "sub-components", only add the unique ones (not present in the chord)...
    const newSubComponentIds = splitArticulation(a.symId())
    for (const id of newSubComponentIds) {
        const articCopy = a.clone() as Articulation
        articCopy.setSymId(id)

        if (!c.hasArticulation(articCopy)) {
            articCopy.setParent(c)
            articCopy.setTrack(c.track())
            score.undoAddElement(articCopy)
        }
    }
    return true
}

function toggleArticulationOrOrnament(score: Score, attr: SymId, type: ElementType): void {
    const set = new Set<Chord>()
    for (const el of [...score.selection().elements()]) {
        if (el.isNote() || el.isChord()) {
            let cr: Chord | null = null
            // apply articulation on a given chord only once
            if (el.isNote()) {
                cr = (el as unknown as Note).chord()
                if (set.has(cr)) {
                    continue
                }
            }
            const na = Factory.createItem(type, scoreDummy(score).chord()) as Articulation
            na.setSymId(attr)
            toggleArticulationOf(score, el, na)

            if (cr) {
                set.add(cr)
            }
        }
    }
}

Score.prototype.toggleArticulation = function (this: Score, a1: SymId | EngravingItem, a2?: Articulation): boolean | undefined {
    if (typeof a1 === 'number') {
        toggleArticulationOrOrnament(this, a1, ElementType.ARTICULATION)
        return undefined
    }
    return toggleArticulationOf(this, a1, a2!)
} as Score['toggleArticulation']

Score.prototype.toggleOrnament = function (this: Score, attr: SymId): void {
    toggleArticulationOrOrnament(this, attr, ElementType.ORNAMENT)
}

Score.prototype.cmdToggleLayoutBreak = function (this: Score, type: LayoutBreakType): void {
    // find measure(s)
    const mbl: MeasureBase[] = []
    let allNoBreaks = true // NOBREAK is not removed unless every measure in selection already has one
    if (this.selection().isRange()) {
        const range = this.selection().measureRange()
        if (!range || !range.m1 || !range.m2) {
            return
        }
        const startMeasure = range.m1
        const endMeasure = range.m2
        if (type === LayoutBreakType.NOBREAK) {
            // add throughout the selection
            // or remove if already on every measure
            if (startMeasure === endMeasure) {
                mbl.push(startMeasure)
                allNoBreaks = startMeasure.noBreak()
            } else {
                for (let m: Measure | null = startMeasure; m; m = m.nextMeasureMM()) {
                    if (m === endMeasure) {
                        break
                    }
                    mbl.push(m)
                    if (!m.noBreak()) {
                        allNoBreaks = false
                    }
                }
            }
        } else {
            // toggle break on the last measure of the range
            mbl.push(endMeasure)
            // if more than one measure selected,
            // also toggle break *before* the range (to try to fit selection on a single line)
            if (startMeasure !== endMeasure && startMeasure.prev()) {
                mbl.push(startMeasure.prev()!)
            }
        }
    } else {
        let mb: MeasureBase | null = null
        for (const el of this.selection().elements()) {
            switch (el.type()) {
            case ElementType.HBOX:
            case ElementType.VBOX:
            case ElementType.TBOX:
            case ElementType.FBOX:
                mb = el as unknown as MeasureBase
                break
            default: {
                // find measure
                let measure = el.findMeasure()
                // for start repeat, attach break to previous measure
                if (measure && el.isBarLine()) {
                    const bl = el as unknown as BarLine
                    if (bl.barLineType() === BarLineType.START_REPEAT) {
                        measure = measure.prevMeasure()
                    }
                }
                // if measure is mmrest, then propagate to last original measure
                if (measure) {
                    mb = measure.isMMRest() ? measure.mmRestLast() : measure
                }

                if (mb) {
                    allNoBreaks = mb.noBreak()
                }
            }
            }
        }
        if (mb) {
            mbl.push(mb)
        }
    }

    if (type === LayoutBreakType.NOBREAK && !allNoBreaks) {
        for (const mb of mbl) {
            if (mb.systemLock()) {
                return
            }
        }
    }

    // toggle the breaks
    for (const mb of mbl) {
        let val = false
        switch (type) {
        case LayoutBreakType.LINE:
            val = !mb.lineBreak()
            if (val) {
                EditSystemLocks.removeSystemLocksOnAddLayoutBreak(this, type, mb)
            }
            mb.undoSetBreak(val, type)
            // remove page break if appropriate
            if (val && mb.pageBreak()) {
                mb.undoSetBreak(false, LayoutBreakType.PAGE)
            }
            break
        case LayoutBreakType.PAGE:
            val = !mb.pageBreak()
            if (val) {
                EditSystemLocks.removeSystemLocksOnAddLayoutBreak(this, type, mb)
            }
            mb.undoSetBreak(val, type)
            // remove line break if appropriate
            if (val && mb.lineBreak()) {
                mb.undoSetBreak(false, LayoutBreakType.LINE)
            }
            break
        case LayoutBreakType.SECTION:
            val = !mb.sectionBreak()
            if (val) {
                EditSystemLocks.removeSystemLocksOnAddLayoutBreak(this, type, mb)
            }
            mb.undoSetBreak(val, type)
            break
        case LayoutBreakType.NOBREAK:
            mb.undoSetBreak(!allNoBreaks, type)
            // remove other breaks if appropriate
            if (!mb.noBreak()) {
                if (mb.pageBreak()) {
                    mb.undoSetBreak(false, LayoutBreakType.PAGE)
                } else if (mb.lineBreak()) {
                    mb.undoSetBreak(false, LayoutBreakType.LINE)
                } else if (mb.sectionBreak()) {
                    mb.undoSetBreak(false, LayoutBreakType.SECTION)
                }
            }
            break
        default:
            break
        }
    }
}

Score.prototype.cmdAddSpannerAtPos = function (this: Score, spanner: Spanner, pos: PointF, systemStavesOnly = false): void {
    const res = this.pos2measure(pos)
    let staffIdx = res ? res.staffIdx : spanner.staffIdx()
    if (systemStavesOnly) {
        staffIdx = 0
    }
    // ignore if we do not have a measure
    if (!res || !res.measure.isMeasure()) {
        // C++: LOGD("cmdAddSpanner: cannot put object here"); delete spanner
        return
    }
    const segment = res.segment
    const mb = res.measure

    // all spanners live in voice 0 (except slurs/ties)
    const track = staffIdx === nidx ? nidx : staffIdx * VOICES

    spanner.setTrack(track)
    spanner.setTrack2(track)

    if (spanner.anchor() === 0 /* Spanner::Anchor::SEGMENT */) {
        spanner.setTick(segment.tick())
        const tick2 = Fraction.min(segment.measure().endTick(), this.lastMeasure()!.endTick())
        spanner.setTick2(tick2)
    } else { // Anchor::MEASURE, Anchor::CHORD, Anchor::NOTE
        spanner.setTick(mb.tick())
        spanner.setTick2(mb.endTick())
    }
    spanner.eraseSpannerSegments()

    const ctrlModifier = spanner.isTextLineBase() && spanner.systemFlag() && !systemStavesOnly // isSystemTextLine(spanner)
    this.undoAddElement(spanner, true /*addToLinkedStaves*/, ctrlModifier)
}

Score.prototype.cmdAddSpanner = function (this: Score, spanner: Spanner, staffIdx: number, startSegment: Segment,
    endSegment: Segment | null, ctrlModifier = false): void {
    const track = staffIdx * VOICES
    spanner.setTrack(track)
    spanner.setTrack2(track)
    for (const ss of spanner.spannerSegments()) {
        ss.setTrack(track)
    }

    const isMeasureAnchor = spanner.anchor() === 1 /* Spanner::Anchor::MEASURE */
    const tick1 = isMeasureAnchor ? startSegment.measure().tick() : startSegment.tick()
    spanner.setTick(tick1)

    let tick2: Fraction
    if (!endSegment) {
        tick2 = this.lastSegment()!.tick()
    } else if (endSegment === startSegment) {
        tick2 = startSegment.measure().last()!.tick()
    } else {
        tick2 = endSegment.tick()
    }
    if (isMeasureAnchor) {
        const endMeasure = this.tick2measureMM(tick2)!
        if (!endMeasure.tick().eq(tick2)) {
            tick2 = endMeasure.endTick()
        }
    }

    spanner.setTick2(tick2)
    this.undoAddElement(spanner, true, ctrlModifier)
}

// =====================================================================================================================
//   copy/paste: makeGap1 (cmd.cpp), used by the paste of a staff list (Read460::pasteStaff)
// =====================================================================================================================

declare module '../dom/score' {
    interface Score {
        /**
         * make time gap for each voice starting at tick+voiceOffset[voice] by removing/shortening chord/rest
         * - cr is top level (not part of a tuplet)
         * - do not stop at measure end
         * - len and voiceOffset are in local (stretched) time
         * voiceOffset: invalid fractions (Fraction(1, 0)) for voices without elements
         */
        makeGap1(baseTick: Fraction, staffIdx: number, len: Fraction, voiceOffset: readonly Fraction[]): boolean
    }
}

Score.prototype.makeGap1 = function (this: Score, baseTick: Fraction, staffIdx: number, len: Fraction,
    voiceOffset: readonly Fraction[]): boolean {
    const m = this.tick2measure(baseTick)
    if (!m) {
        // C++: LOGD() << "No measure to paste at tick " << baseTick.toString()
        return false
    }

    const strack = staffIdx * VOICES
    for (let track = strack; track < strack + VOICES; track++) {
        if (!voiceOffset[track - strack].isValid()) {
            continue
        }
        const tick = baseTick.plus(actualTicks(voiceOffset[track - strack], null, this.staff(staffIdx)!.timeStretch(baseTick)))
        const tm = this.tick2measure(tick)!
        if ((track % VOICES) && !tm.hasVoices(staffIdx)) {
            continue
        }

        const newLen = len.minus(voiceOffset[track - strack])

        if (newLen.gt(new Fraction(0, 1))) {
            const endTick = tick.plus(actualTicks(newLen, null, this.staff(staffIdx)!.timeStretch(tick)))

            const filter = new SelectionFilter()
            // chord symbols can exist without chord/rest so they should not be removed
            filter.setFiltered(ElementsSelectionFilterTypes.CHORD_SYMBOL, false)

            this.deleteAnnotationsFromRange(this.tick2rightSegment(tick), this.tick2rightSegment(endTick), track, track + 1, filter)
            this.deleteOrShortenOutSpannersFromRange(tick, endTick, track, track + 1, filter)
        }

        const seg = tm.undoGetSegment(SegmentType.ChordRest, tick)
        const result = this.makeGapVoice(seg, track, newLen, tick)
        if (track === strack && !result) { // makeGap failed for first voice
            return false
        }
    }
    return true
}


// =====================================================================================================================
//   cmd.cpp functions of the note input methods and of grace notes (realtimeAdvance, setGraceNote, cmdAddGrace)
// =====================================================================================================================

// (imports of this section; ES imports are hoisted)
import { NoteType as GraceNoteType } from '../dom/chordrest'

declare module '../dom/score' {
    interface Score {
        /**
         * advances the real-time input by one input duration (the "realtime-advance" action of the real-time note
         * input methods); the keys still held are tied to the previous chord.
         */
        realtimeAdvance(allowTransposition: boolean): void
        /**
         * Create a grace note in front of a normal note.
         * ch is the chord of the normal note, pitch the pitch of the grace note, type the grace note type,
         * len the visual duration of the grace note (1/16 or 1/32) in ticks
         */
        setGraceNote(ch: Chord, pitch: number, type: GraceNoteType, len: number): Note
        /** adds grace note of specified type to selected notes */
        cmdAddGrace(graceType: GraceNoteType, duration: number): void
    }
}

Score.prototype.realtimeAdvance = function (this: Score, allowTransposition: boolean): void {
    const is = this.inputState()
    if (!is.noteEntryMode()) {
        return
    }

    const ticks2measureEnd = is.segment()!.measure().ticks().minus(is.segment()!.rtick())
    if (!is.cr() || (!is.cr()!.ticks().eq(is.duration().fraction()) && is.duration().fraction().lt(ticks2measureEnd))) {
        this.setNoteRest(is.segment()!, is.track(), new NoteVal(), is.duration().fraction(), DirectionV.AUTO)
    }

    const prevCR = is.cr()!
    if (is.endOfScore()) {
        // C++ appendMeasures(1)
        const options = new InsertMeasureOptions()
        options.createEmptyMeasures = false
        this.insertMeasure(ElementType.MEASURE, null, options)
    }

    is.moveToNextInputPos()

    const midiPitches = this.activeMidiPitches()
    if (!midiPitches.length) {
        this.setNoteRest(is.segment()!, is.track(), new NoteVal(), is.duration().fraction(), DirectionV.AUTO)
    } else {
        const prevChord = prevCR.isChord() ? prevCR as unknown as Chord : null
        let partOfChord = false
        for (const ev of midiPitches) {
            this.addTiedMidiPitch(ev.pitch, partOfChord, prevChord, allowTransposition)
            partOfChord = true
        }
    }

    if (prevCR.measure() !== is.segment()!.measure()) {
        // just advanced across barline. Now simplify tied notes.
        this.score().regroupNotesAndRests(prevCR.measure().tick(), is.segment()!.measure().tick(), is.track())
    }
}

Score.prototype.setGraceNote = function (this: Score, ch: Chord, pitch: number, type: GraceNoteType, len: number): Note {
    const chord = Factory.createItem(ElementType.CHORD, scoreDummy(this).segment()) as unknown as Chord
    const note = Factory.createItem(ElementType.NOTE, chord) as unknown as Note

    // allow grace notes to be added to other grace notes
    // by really adding to parent chord
    if (ch.noteType() !== GraceNoteType.NORMAL) {
        ch = ch.explicitParent() as unknown as Chord
    }

    chord.setTrack(ch.track())
    chord.setParent(ch)
    chord.add(note)

    // find corresponding note within chord and use its tpc information
    // if no note with same pitch found, derive tpc from pitch / key
    const n = ch.findNote(pitch)
    if (n) {
        note.setNval(n.noteVal(), ch.tick())
    } else {
        note.setPitch(pitch)
        note.setTpcFromPitch()
    }

    const d = new TDuration()
    d.setVal(len)
    chord.setDurationType(d)
    chord.setTicks(d.fraction())
    chord.setNoteType(type)
    chord.setShowStemSlashInAdvance()
    chord.mutldata().setMag(ch.staff()!.staffMag(chord.tick()) * this.style().styleD(Sid.graceNoteMag))

    this.undoAddElement(chord)
    return note
}

Score.prototype.cmdAddGrace = function (this: Score, graceType: GraceNoteType, duration: number): void {
    const copyOfElements = [...this.selection().elements()]
    for (const e of copyOfElements) {
        if (e.isNote()) {
            const n = e as unknown as Note
            const graceNote = this.setGraceNote(n.chord(), n.pitch(), graceType, duration)
            this.select(graceNote, SelectType.SINGLE, 0)
        }
    }
}

// FiguredBass::regenerateText calls score()->startCmd()/endCmd() (dom -> editing)
figuredBassHooks.startCmd = (score, name) => (score as Score).startCmd(name)
figuredBassHooks.endCmd = (score) => (score as Score).endCmd()

// =====================================================================================================================
//   Tools (cmd.cpp): cmdExplode, cmdImplode
// =====================================================================================================================

import { CloneVoice } from './editvoicing'
import { XmlReader as ToolsXmlReader } from '../rw/xmlreader'

declare module '../dom/score' {
    interface Score {
        /** explodes contents of top selected staff into subsequent staves */
        cmdExplode(): boolean
        /** implodes contents of selected staves into top staff; for single staff, merge voices */
        cmdImplode(): boolean
    }
}

Score.prototype.cmdExplode = function (this: Score): boolean {
    const srcStaff = this.selection().staffStart()
    let lastStaff = this.selection().staffEnd()
    const srcTrack = srcStaff * VOICES

    // reset selection to top staff only
    // force complete measures
    let startSegment = this.selection().startSegment()!
    let endSegment = this.selection().endSegment()
    const startMeasure = startSegment.measure()
    let endMeasure: Measure
    if (!endSegment) {
        endMeasure = this.lastMeasure()!
    } else if (endSegment.tick().eq(endSegment.measure().tick())) {
        endMeasure = endSegment.measure().prevMeasure() ? endSegment.measure().prevMeasure()! : this.firstMeasure()!
    } else {
        endMeasure = endSegment.measure()
    }

    const lTick = endMeasure.endTick()
    let voice = false

    for (let m: Measure | null = startMeasure; m && !m.tick().eq(lTick); m = m.nextMeasure()) {
        if (m.hasVoices(srcStaff)) {
            voice = true
            break
        }
    }
    if (!voice) {
        // force complete measures
        this.deselectAll()
        this.select(startMeasure, SelectType.RANGE, srcStaff)
        this.select(endMeasure, SelectType.RANGE, srcStaff)
        startSegment = this.selection().startSegment()!
        endSegment = this.selection().endSegment()
        if (srcStaff === lastStaff - 1) {
            // only one staff was selected up front - determine number of staves
            // loop through all chords looking for maximum number of notes
            let n = 0
            for (let s: Segment | null = startSegment; s && s !== endSegment; s = s.next1()) {
                const e = s.element(srcTrack)
                if (e && e.isChord()) {
                    const c = e as unknown as Chord
                    n = Math.max(n, c.notes().length)
                    for (const graceChord of c.graceNotes()) {
                        n = Math.max(n, graceChord.notes().length)
                    }
                }
            }
            lastStaff = Math.min(this.nstaves(), srcStaff + n)
        }

        // Check that all source and dest measures have the same time stretch - allows explode within a local time signature,
        // but don't yet support it between differing local time signatures.
        let timeStretch = new Fraction(1, 0)
        for (let m: Measure | null = startMeasure; m && m.tick().le(endMeasure.tick()); m = m.nextMeasure()) {
            for (let staffIdx = srcStaff; staffIdx < lastStaff; ++staffIdx) {
                const mTimeStretch = this.staff(staffIdx)!.timeStretch(m.tick())
                if (!timeStretch.isValid()) {
                    timeStretch = mTimeStretch
                } else if (!timeStretch.eq(mTimeStretch)) {
                    MScore.setError(MsError.CANNOT_EXPLODE_IMPLODE_LOCAL_TIMESIG)
                    return false
                }
            }
        }

        const mimeData = this.selection().mimeData()
        // copy to all destination staves
        const firstCRSegment = startMeasure.tick2segment(startMeasure.tick())!
        for (let i = 1; srcStaff + i < lastStaff; ++i) {
            const track = (srcStaff + i) * VOICES
            const cr = firstCRSegment.element(track) as unknown as ChordRest | null
            if (cr) {
                const e = new ToolsXmlReader(mimeData)
                this.pasteStaff(e, cr.segment(), cr.staffIdx())
            }
        }

        const doExplode = (c: Chord, lastStaff: number, srcStaff: number, i: number): void => {
            const notes = [...c.notes()]
            const nnotes = notes.length
            // keep note "i" from top, which is backwards from nnotes - 1
            // reuse notes if there are more instruments than notes
            const stavesPerNote = Math.max(Math.trunc((lastStaff - srcStaff) / nnotes), 1)
            const keepIndex = Math.max(nnotes - 1 - Math.trunc(i / stavesPerNote), 0)
            const keepNote = c.notes()[keepIndex]
            for (const n of notes) {
                if (n !== keepNote) {
                    this.undoRemoveElement(n)
                }
            }
        }

        // loop through each staff removing all but one note from each chord
        for (let i = 0; srcStaff + i < lastStaff; ++i) {
            const track = (srcStaff + i) * VOICES
            for (let s: Segment | null = startSegment; s && s !== endSegment; s = s.next1()) {
                const e = s.element(track)
                if (e && e.isChord()) {
                    const c = e as unknown as Chord // chord, laststaff, srcstaff
                    doExplode(c, lastStaff, srcStaff, i)
                    for (const graceChord of c.graceNotes()) {
                        doExplode(graceChord, lastStaff, srcStaff, i)
                    }
                }
            }
        }
    } else {
        const sTracks: track_idx_t[] = []
        const dTracks: track_idx_t[] = []
        if (srcStaff === lastStaff - 1) {
            lastStaff = Math.min(this.nstaves(), srcStaff + VOICES)
        }

        for (let i = 0; i < VOICES; i++) {
            sTracks[i] = nidx
            dTracks[i] = nidx
        }
        let full = 0

        for (let seg: Segment | null = startSegment; seg && seg.tick().lt(lTick); seg = seg.next1()) {
            for (let i = srcTrack; i < srcTrack + VOICES && full !== VOICES; i++) {
                let t = true
                for (let j = 0; j < VOICES; j++) {
                    if (i === sTracks[j]) {
                        t = false
                        break
                    }
                }

                if (!seg.measure().hasVoice(i) || seg.measure().isOnlyRests(i) || !t) {
                    continue
                }
                sTracks[full] = i

                for (let j = srcTrack + full * VOICES; j < lastStaff * VOICES; j++) {
                    if (i === j) {
                        dTracks[full] = j
                        break
                    }
                    for (let m: Measure | null = seg.measure(); m && m.tick().lt(lTick); m = m.nextMeasure()) {
                        if (!m.hasVoice(j) || (m.hasVoice(j) && m.isOnlyRests(j))) {
                            dTracks[full] = j
                        } else {
                            dTracks[full] = nidx
                            break
                        }
                    }
                    if (dTracks[full] !== nidx) {
                        break
                    }
                }
                full++
            }
        }

        if (full <= 0) {
            return false
        }
        lastStaff = track2staff(dTracks[full - 1]) + 1

        // Check that all source and dest measures have the same time stretch - allows explode within a local time signature,
        // but don't yet support it between differing local time signatures.
        let timeStretch = new Fraction(1, 0)
        for (let m: Measure | null = startMeasure; m && m.tick().le(endMeasure.tick()); m = m.nextMeasure()) {
            for (let staffIdx = srcStaff; staffIdx < lastStaff; ++staffIdx) {
                const mTimeStretch = this.staff(staffIdx)!.timeStretch(m.tick())
                if (!timeStretch.isValid()) {
                    timeStretch = mTimeStretch
                } else if (!timeStretch.eq(mTimeStretch)) {
                    MScore.setError(MsError.CANNOT_EXPLODE_IMPLODE_LOCAL_TIMESIG)
                    return false
                }
            }
        }

        for (let i = srcTrack, j = 0; i < lastStaff * VOICES && j < VOICES; i += VOICES, j++) {
            const strack = sTracks[j % VOICES]
            const dtrack = dTracks[j % VOICES]
            if (strack !== nidx && strack !== dtrack && dtrack !== nidx) {
                this.undo(new CloneVoice(startSegment, lTick, startSegment, strack, dtrack, nidx, false))
            }
        }
    }

    // select exploded region
    this.deselectAll()
    this.select(startMeasure, SelectType.RANGE, srcStaff)
    this.select(endMeasure, SelectType.RANGE, lastStaff - 1)

    return true
}

Score.prototype.cmdImplode = function (this: Score): boolean {
    const dstStaff = this.selection().staffStart()
    const endStaff = this.selection().staffEnd()
    const dstTrack = dstStaff * VOICES
    const startTrack = dstStaff * VOICES
    const endTrack = endStaff * VOICES
    const startSegment = this.selection().startSegment()!
    const endSegment = this.selection().endSegment()
    const startMeasure = startSegment.measure()
    const endMeasure = endSegment ? endSegment.measure() : this.lastMeasure()!
    const startTick = startSegment.tick()
    const endTick = endSegment ? endSegment.tick() : this.lastMeasure()!.endTick()

    // Check that all source and dest measures have the same time stretch - allows implode within a local time signature,
    // but don't yet support it between differing local time signatures.
    let timeStretch = new Fraction(1, 0)
    for (let m: Measure | null = startMeasure; m && m.tick().le(endMeasure.tick()); m = m.nextMeasure()) {
        for (let staffIdx = dstStaff; staffIdx < endStaff; ++staffIdx) {
            const mTimeStretch = this.staff(staffIdx)!.timeStretch(m.tick())
            if (!timeStretch.isValid()) {
                timeStretch = mTimeStretch
            } else if (!timeStretch.eq(mTimeStretch)) {
                MScore.setError(MsError.CANNOT_EXPLODE_IMPLODE_LOCAL_TIMESIG)
                return false
            }
        }
    }

    // if single staff selected, combine voices
    // otherwise combine staves
    if (dstStaff === endStaff - 1) {
        // loop through segments adding notes to chord on top staff
        for (let s: Segment | null = startSegment; s && s !== endSegment; s = s.next1()) {
            if (!s.isChordRestType()) {
                continue
            }
            const dst = s.element(dstTrack)
            if (dst && dst.isChord()) {
                const dstChord = dst as unknown as Chord
                // see if we are tying in to this chord
                let tied: Chord | null = null
                for (const n of dstChord.notes()) {
                    if (n.tieBackNonPartial()) {
                        tied = n.tieBack()!.startNote()!.chord()
                        break
                    }
                }
                // loop through each subsequent staff (or track within staff)
                // looking for notes to add
                for (let srcTrack = startTrack + 1; srcTrack < endTrack; srcTrack++) {
                    const src = s.element(srcTrack)
                    if (src && src.isChord()) {
                        const srcChord = src as unknown as Chord
                        // when combining voices, skip if not same duration
                        if (!srcChord.ticks().eq(dstChord.ticks())) {
                            continue
                        }
                        // add notes
                        for (const n of [...srcChord.notes()]) {
                            const nv = new NoteVal(n.pitch())
                            nv.tpc1 = n.tpc1()
                            // skip duplicates
                            if (dstChord.findNote(nv.pitch)) {
                                continue
                            }
                            const forceAccidental = !!n.accidental() && n.accidental()!.role() === AccidentalRole.USER
                            const nn = this.addNote(dstChord, nv, forceAccidental)
                            // move articulations
                            for (const artic of [...srcChord.articulations()]) {
                                if (dstChord.hasArticulation(artic)) {
                                    continue
                                }
                                this.undoChangeParent(artic, dstChord, dstChord.staffIdx())
                            }
                            // add tie to this note if original chord was tied
                            if (tied) {
                                // find note to tie to
                                for (const tn of tied.notes()) {
                                    if (nn.pitch() === tn.pitch() && nn.tpc() === tn.tpc() && !tn.tieFor()) {
                                        // found note to tie
                                        const tie = Factory.createItem(ElementType.TIE, scoreDummy(this)) as Tie
                                        tie.setStartNote(tn)
                                        tie.setEndNote(nn)
                                        tie.setTick(tie.startNote()!.tick())
                                        tie.setTick2(tie.endNote()!.tick())
                                        tie.setTrack(tn.track())
                                        this.undoAddElement(tie)
                                    }
                                }
                            }
                        }
                    }
                    // delete chordrest from source track if possible
                    if (src && src.voice()) {
                        this.undoRemoveElement(src)
                    }
                }
            } else if (dst) {
                // TODO - use first voice that actually has a note and implode remaining voices on it?
                // see https://musescore.org/en/node/174111
                // destination track has something, but it isn't a chord
                // remove rests from other voices if in "voice mode"
                for (let i = 1; i < VOICES; ++i) {
                    const e = s.element(dstTrack + i)
                    if (e && e.isRest()) {
                        this.undoRemoveElement(e)
                    }
                }
            }
        }
        // delete orphaned spanners (TODO: figure out solution to reconnect orphaned spanners to their cloned notes)
        this.checkSpanner(startTick, endTick)
    } else {
        const tracks: track_idx_t[] = []
        for (let i = 0; i < VOICES; i++) {
            tracks[i] = nidx
        }
        let full = 0

        // identify tracks to combine, storing the source track numbers in tracks[]
        // first four non-empty tracks to win
        for (let track = startTrack; track < endTrack && full < VOICES; ++track) {
            let m: Measure | null = startMeasure
            do {
                if (m!.hasVoice(track) && !m!.isOnlyRests(track)) {
                    tracks[full++] = track
                    break
                }
            } while ((m !== endMeasure) && (m = m!.nextMeasure()))
        }

        // clone source tracks into destination
        for (let i = dstTrack; i < dstTrack + VOICES; i++) {
            const strack = tracks[i % VOICES]
            if (strack !== nidx && strack !== i) {
                this.undo(new CloneVoice(startSegment, endTick, startSegment, strack, i, i, false))
            }
        }
    }

    // select destination staff only
    this.deselectAll()
    this.select(startMeasure, SelectType.RANGE, dstStaff)
    this.select(endMeasure, SelectType.RANGE, dstStaff)

    return true
}

// =====================================================================================================================
//   Tools (cmd.cpp): cmdSlashFill, cmdSlashRhythm, cmdResetNoteAndRestGroupings, cmdResequenceRehearsalMarks,
//   cmdRemoveEmptyTrailingMeasures
// =====================================================================================================================

import { Position as ToolsPosition } from '../dom/score'
import type { RehearsalMark } from '../dom/rehearsalmark'
import type { Rest as ToolsRest } from '../dom/rest'
import { NoteType as ToolsNoteType } from '../dom/chordrest'

declare module '../dom/score' {
    interface Score {
        /** fills selected region with slashes */
        cmdSlashFill(): void
        /** converts rhythms in selected region to slashes */
        cmdSlashRhythm(): void
        cmdResetNoteAndRestGroupings(): void
        cmdResequenceRehearsalMarks(): void
        cmdRemoveEmptyTrailingMeasures(): void
    }
}

Score.prototype.cmdSlashFill = function (this: Score): void {
    const startStaff = this.selection().staffStart()
    const endStaff = this.selection().staffEnd()
    let startSegment = this.selection().startSegment()
    if (!startSegment) { // empty score?
        return
    }

    let endSegment = this.selection().endSegment()

    // operate on measures underlying mmrests
    if (startSegment && startSegment.measure() && startSegment.measure().isMMRest()) {
        startSegment = startSegment.measure().mmRestFirst()!.first()
    }
    if (endSegment && endSegment.measure() && endSegment.measure().isMMRest()) {
        endSegment = endSegment.measure().mmRestLast()!.last()
    }

    const endTick = endSegment ? endSegment.tick() : this.lastSegment()!.tick().plus(Fraction.eps())
    let firstSlash: Chord | null = null
    let lastSlash: Chord | null = null

    // loop through staves in selection
    for (let staffIdx = startStaff; staffIdx < endStaff; ++staffIdx) {
        const track = staffIdx * VOICES
        let voice = nidx
        // loop through segments adding slashes on each beat
        for (let s: Segment | null = startSegment; s && s.tick().lt(endTick); s = s.next1()) {
            if (s.segmentType() !== SegmentType.ChordRest) {
                continue
            }
            // determine beat type based on time signature
            const d = s.measure().timesig().denominator()
            const n = (d > 4 && s.measure().timesig().numerator() % 3 === 0) ? 3 : 1
            const f = new Fraction(n, d)
            // skip over any leading segments before next (first) beat
            if (s.rtick().ticks() % f.ticks()) {
                continue
            }
            // determine voice to use - first available voice for this measure / staff
            if (voice === nidx || s.rtick().isZero()) {
                const needGap: boolean[] = []
                for (voice = 0; voice < VOICES; ++voice) {
                    needGap[voice] = false
                    const cr = s.element(track + voice) as unknown as ChordRest | null
                    // no chordrest == treat as ordinary rest for purpose of determining availability of voice
                    // but also, we will need to make a gap for this voice if we do end up choosing it
                    if (!cr) {
                        needGap[voice] = true
                    } else if (cr.isChord()) {
                        // chord == keep looking for an available voice
                        continue
                    } else if (cr.durationType().type() === DurationType.V_MEASURE) {
                        // full measure rest == OK to use voice
                        break
                    }
                    // no chordrest or ordinary rest == OK to use voice
                    // if there are nothing but rests for duration of measure / selection
                    let ok = true
                    for (let ns = s.next(SegmentType.ChordRest); ns && ns !== endSegment; ns = ns.next(SegmentType.ChordRest)) {
                        const ncr = ns.element(track + voice) as unknown as ChordRest | null
                        if (ncr && ncr.isChord()) {
                            ok = false
                            break
                        }
                    }
                    if (ok) {
                        break
                    }
                }
                // no available voices, just use voice 0
                if (voice === VOICES) {
                    voice = 0
                }
                // no cr was found in segment for this voice, so make gap
                if (needGap[voice]) {
                    this.makeGapVoice(s, track + voice, f, s.tick())
                }
            }
            // construct note
            let line = 0
            let error = false
            let nv: NoteVal | null = new NoteVal()
            const staff = this.staff(staffIdx)!
            if (staff.staffType(s.tick()).group() === StaffGroup.TAB) {
                line = Math.trunc(staff.lines(s.tick()) / 2)
            } else {
                line = staff.middleLine(s.tick()) // staff(staffIdx)->lines() - 1;
            }
            if (staff.staffType(s.tick()).group() === StaffGroup.PERCUSSION) {
                nv.pitch = 0
                nv.headGroup = NoteHeadGroup.HEAD_SLASH
            } else {
                const p = new ToolsPosition()
                p.segment = s
                p.staffIdx = staffIdx
                p.line = line
                p.fret = -1 // INVALID_FRET_INDEX
                this.inputState().setRest(false) // needed for tab
                nv = this.noteValForPosition(p, AccidentalType.NONE)
                error = !nv
            }
            if (error) {
                continue
            }
            // insert & turn into slash
            s = this.setNoteRest(s, track + voice, nv!, f)!
            const c = s.element(track + voice) as unknown as Chord | null
            if (c && c.isChord()) {
                if (c.links()) {
                    for (const e of c.links()!) {
                        const lc = e as unknown as Chord
                        lc.setSlash(true, true)
                    }
                } else {
                    c.setSlash(true, true)
                }
            }
            lastSlash = c
            if (!firstSlash) {
                firstSlash = c
            }
        }
    }

    // re-select the slashes
    this.deselectAll()
    if (firstSlash && lastSlash) {
        this.select(firstSlash, SelectType.RANGE)
        this.select(lastSlash, SelectType.RANGE)
    }
}

Score.prototype.cmdSlashRhythm = function (this: Score): void {
    const chords = new Set<Chord>()
    // loop through all notes in selection
    for (const e of [...this.selection().elements()]) {
        if (e.voice() >= 2 && e.isRest()) {
            const r = e as unknown as ToolsRest
            if (r.links()) {
                for (const se of r.links()!) {
                    const lr = se as unknown as ToolsRest
                    lr.setAccent(!lr.accent())
                }
            } else {
                r.setAccent(!r.accent())
            }
            continue
        } else if (e.isNote()) {
            const n = e as unknown as Note
            if (n.noteType() !== ToolsNoteType.NORMAL) {
                continue
            }
            const c = n.chord()
            // check for duplicates (chords with multiple notes)
            if (chords.has(c)) {
                continue
            }
            chords.add(c)
            // toggle slash setting
            c.setSlash(!c.slash(), false)
        }
    }
}

Score.prototype.cmdResetNoteAndRestGroupings = function (this: Score): void {
    const noSelection = this.selection().isNone()
    if (noSelection) {
        this.cmdSelectAll()
    } else if (!this.selection().isRange()) {
        return // no system or staff selected
    }

    // save selection values because selection changes during grouping
    const sTick = this.selection().tickStart()
    const eTick = this.selection().tickEnd()
    const sStaff = this.selection().staffStart()
    const eStaff = this.selection().staffEnd()

    for (let staff = sStaff; staff < eStaff; staff++) {
        const sTrack = staff * VOICES
        const eTrack = sTrack + VOICES
        for (let track = sTrack; track < eTrack; track++) {
            if (this.selectionFilter().canSelectVoice(track)) {
                this.regroupNotesAndRests(sTick, eTick, track)
            }
        }
    }

    if (noSelection) {
        this.deselectAll()
        return
    }

    // Reset selection to original selection
    this.selection().setRangeTicks(sTick, eTick, sStaff, eStaff)
    this.selection().updateSelectedElements()
}

Score.prototype.cmdResequenceRehearsalMarks = function (this: Score): void {
    const noSelection = !this.selection().isRange()

    if (noSelection) {
        this.cmdSelectAll()
    } else if (!this.selection().isRange()) {
        return
    }

    let last: RehearsalMark | null = null
    for (let s = this.selection().startSegment(); s && s !== this.selection().endSegment(); s = s.next1()) {
        for (const e of s.annotations()) {
            if (e.type() === ElementType.REHEARSAL_MARK) {
                const rm = e as unknown as RehearsalMark
                if (rm.isTopSystemObject()) {
                    if (last) {
                        const rmText = this.nextRehearsalMarkText(last, rm)
                        for (const le of rm.linkList()) {
                            le.undoChangeProperty(Pid.TEXT, rmText)
                        }
                    }
                    last = rm
                }
            }
        }
    }

    if (noSelection) {
        this.deselectAll()
    }
}

Score.prototype.cmdRemoveEmptyTrailingMeasures = function (this: Score): void {
    const mScore = this.masterScore()
    const beginMeasure = mScore.firstTrailingMeasure()
    if (beginMeasure) {
        mScore.deleteMeasures(beginMeasure, mScore.lastMeasure()!)
    }
}

// =====================================================================================================================
//   Score::lyrics, extractLyrics (score.cpp): "Copy lyrics to clipboard"
// =====================================================================================================================

import type { Lyrics as ToolsLyrics } from '../dom/lyrics'
import { LyricsSyllabic as ToolsLyricsSyllabic } from '../types/types'

declare module '../dom/score' {
    interface Score {
        /** the lyrics of the score in reading order (repeats expanded, verse by verse) */
        lyrics(): ToolsLyrics[]
        extractLyrics(): string
    }
}

function lyricsOfVerse(cr: ChordRest, verse: number): ToolsLyrics | null {
    for (const l of cr.lyrics()) {
        if (l.verse() === verse) {
            return l
        }
    }
    return null
}

Score.prototype.lyrics = function (this: Score): ToolsLyrics[] {
    const result: ToolsLyrics[] = []
    this.masterScore().setExpandRepeats(true)
    const st = SegmentType.ChordRest
    for (let track = 0; track < this.ntracks(); track++) {
        let maxLyrics = 1
        for (let m = this.firstMeasure(); m; m = m.nextMeasure()) {
            m.setPlaybackCount(0)
        }
        // follow the repeat segments
        const rlist = this.repeatList()
        for (const rs of rlist) {
            const startTick = Fraction.fromTicks(rs.tick)
            const endTick = Fraction.fromTicks(rs.endTick())
            for (let m = this.tick2measure(startTick); m; m = m.nextMeasure()) {
                const playCount = m.playbackCount()
                for (let seg = m.first(st); seg; seg = seg.next(st)) {
                    const cr = seg.element(track) as unknown as ChordRest | null
                    if (!cr || cr.lyrics().length === 0) {
                        continue
                    }
                    if (cr.lyrics().length > maxLyrics) {
                        maxLyrics = cr.lyrics().length
                    }
                    if (playCount > cr.lyrics().length) {
                        continue
                    }
                    const l = lyricsOfVerse(cr, playCount)
                    if (!l) {
                        continue
                    }
                    result.push(l)
                }
                m.setPlaybackCount(m.playbackCount() + 1)
                if (m.endTick().ge(endTick)) {
                    break
                }
            }
        }
        // consider remaining lyrics
        for (let lyricsNumber = 0; lyricsNumber < maxLyrics; lyricsNumber++) {
            for (let m = this.firstMeasure(); m; m = m.nextMeasure()) {
                const playCount = m.playbackCount()
                if (lyricsNumber < playCount) {
                    continue
                }
                for (let seg = m.first(st); seg; seg = seg.next(st)) {
                    const cr = seg.element(track) as unknown as ChordRest | null
                    if (!cr || cr.lyrics().length === 0) {
                        continue
                    }
                    if (cr.lyrics().length > maxLyrics) {
                        maxLyrics = cr.lyrics().length
                    }
                    if (lyricsNumber > cr.lyrics().length) {
                        continue
                    }
                    const l = lyricsOfVerse(cr, lyricsNumber)
                    if (!l) {
                        continue
                    }
                    result.push(l)
                }
            }
        }
    }
    return result
}

Score.prototype.extractLyrics = function (this: Score): string {
    let result = ''
    const list = this.lyrics()
    for (const l of list) {
        const lyric = l.plainText().trim()
        const ls = l.syllabic()
        if (ls === ToolsLyricsSyllabic.SINGLE || ls === ToolsLyricsSyllabic.END) {
            result += lyric + ' '
        } else if (ls === ToolsLyricsSyllabic.BEGIN || ls === ToolsLyricsSyllabic.MIDDLE) {
            result += lyric
        }
    }
    return result.trim()
}

// =====================================================================================================================
//   Realize chord symbols (cmd.cpp: setChord, cmdRealizeChordSymbols)
// =====================================================================================================================

import { HDuration, Voicing } from '../dom/realizedharmony'
import { toDurationList as realizeDurationList } from '../dom/durationtype'
import type { Harmony as RealizeHarmony } from '../dom/harmony'
import type { Tuplet as RealizeTuplet } from '../dom/tuplet'

declare module '../dom/score' {
    interface Score {
        /**
         * Realize selected chord symbols into notes on the staff. If a voicing and duration type are specified, the
         * harmony voicing settings will be overridden by the passed parameters. Otherwise, the settings set on the
         * harmony object will be used.
         */
        cmdRealizeChordSymbols(literal?: boolean, voicing?: Voicing, durationType?: HDuration): void
    }
}

/** 'dur' is in local (stretched) time; returns the segment of the last created chord */
function setChord(score: Score, segment: Segment, track: track_idx_t, chordTemplate: Chord, dur: Fraction): Segment {
    let tick = segment.tick()
    let nr: Chord | null = null // current added chord used so we can select the last added chord and so we can apply ties
    const tie: (Tie | null)[] = chordTemplate.notes().map(() => null) // keep pointer to a tie for each note in the chord in case we need to tie notes
    let cr = segment.element(track) as unknown as ChordRest | null // chord rest under the segment for the specified track

    let addTie = false

    let measure: Measure | null = null
    // keep creating chords and tieing them until we created the full duration asked for (dur)
    for (;;) {
        if (track % VOICES) {
            score.expandVoice(segment, track)
        }

        const t: RealizeTuplet | null = cr ? cr.tuplet() : null
        let tDur = segment.ticks()
        let seg = segment.next()

        // we need to get a correct subduration so that makeGap can function properly
        // since makeGap() takes "normal" duration rather than actual length
        while (seg) {
            if (seg.segmentType() === SegmentType.ChordRest) {
                // design choice made to keep multiple notes across a tuplet as tied single notes rather than combining them
                // since it's arguably more readable, but the other code is still here (commented)
                const testCr = seg.element(track) as unknown as ChordRest | null

                if (testCr && testCr.tuplet()) { // stop on tuplet
                    break
                }
                tDur = tDur.plus(seg.ticks())
            }
            if (tDur.ge(dur)) { // do not go further than the duration asked for
                tDur = dur
                break
            }
            seg = seg.next() // iterate only across measure (hence usage of next() rather than next1())
        }
        if (t) {
            tDur = tDur.times(t.ratio()) // scale by tuplet ratio to get "normal" length rather than actual length when dealing with tuplets
        }
        // the returned gap ends at the measure boundary or at tuplet end
        const dd = score.makeGap(segment, track, tDur, t)

        if (dd.isZero()) {
            break // cannot get gap
        }

        measure = segment.measure()
        const dl = realizeDurationList(dd, true)
        const n = dl.length
        // add chord, tieing when necessary within measure
        for (let i = 0; i < n; ++i) {
            const d = dl[i]

            // create new chord from template and add it
            const chord = chordTemplate.clone() as Chord // Factory::copyChord
            nr = chord

            chord.setTrack(track)
            chord.setDurationType(d)
            chord.setTicks(d.fraction())
            chord.setTuplet(t)
            score.undoAddCR(chord, measure, tick)
            // if there is something to tie, complete tie backwards
            // and add the tie to score
            const notes = [...chord.notes()]
            if (addTie) {
                for (let j = 0; j < notes.length; ++j) {
                    tie[j]!.setEndNote(notes[j])
                    notes[j].setTieBack(tie[j])
                    score.undoAddElement(tie[j]!)
                }
                addTie = false
            }
            // if we're not the last element in the duration list,
            // set tie forward
            if (i + 1 < n) {
                for (let j = 0; j < notes.length; ++j) {
                    tie[j] = Factory.createItem(ElementType.TIE, scoreDummy(score)) as Tie
                    tie[j]!.setStartNote(notes[j])
                    tie[j]!.setTick(tie[j]!.startNote()!.tick())
                    tie[j]!.setTrack(track)
                    notes[j].setTieFor(tie[j])
                    addTie = true
                }
            }
            // TODO(port): score->setPlayChord(true) (the realized chord is played after the command)
            segment = chord.segment()
            tick = tick.plus(chord.actualTicks())
        }

        // subtract the duration already realized and move on
        if (t) {
            dur = dur.minus(dd.div(t.ratio()))
        } else {
            dur = dur.minus(dd)
        }
        // we are done when there is no duration left to realize
        if (dur.isZero()) {
            break
        }

        // go to next segment unless we are at the score (which means we will just be done there)
        const nseg = score.tick2segment(tick, false, SegmentType.ChordRest)
        if (!nseg) {
            break // reached end of score
        }

        // it is possible that the next measure's ticks have not been computed yet. compute them now
        if (nseg.ticks().isZero()) {
            nseg.measure().computeTicks()
        }

        segment = nseg

        cr = segment.element(track) as unknown as ChordRest | null

        if (!cr) {
            if (track % VOICES) {
                cr = score.addRest(segment, track, new TDuration(DurationType.V_MEASURE), null)
            } else {
                break // no rest in voice 0
            }
        }
        //
        //  Note does not fit on current measure, create Tie to
        //  next part of note
        const notes = nr!.notes()
        for (let i = 0; i < notes.length; ++i) {
            tie[i] = Factory.createItem(ElementType.TIE, scoreDummy(score)) as Tie
            tie[i]!.setStartNote(notes[i])
            tie[i]!.setTick(tie[i]!.startNote()!.tick())
            tie[i]!.setTrack(notes[i].track())
            notes[i].setTieFor(tie[i])
        }
    }
    if (tie.length) {
        score.connectTies()
    }
    if (nr) {
        score.select(nr, SelectType.SINGLE, 0)
    }
    return segment
}

Score.prototype.cmdRealizeChordSymbols = function (this: Score, literal = true, voicing: Voicing = Voicing.INVALID,
    durationType: HDuration = HDuration.INVALID): void {
    // Create copy, because setChord selects newly created chord and thus
    // modifies selection().elements() while we're iterating over it
    const elist = [...this.selection().elements()]

    for (const e of elist) {
        if (!e.isHarmony()) {
            continue
        }
        const h = e as unknown as RealizeHarmony
        if (!h.isRealizable()) {
            continue
        }
        const r = h.getRealizedHarmony()
        let seg = (h.explicitParent()!.isSegment() ? h.explicitParent() : h.explicitParent()!.explicitParent()) as unknown as Segment
        const tick = seg.tick()
        const duration = r.getActualDuration(tick.ticks(), durationType).times(h.staff()!.timeStretch(tick))
        const concertPitch = this.style().styleB(Sid.concertPitch)

        const chord = Factory.createItem(ElementType.CHORD, scoreDummy(this).segment()) as Chord // chord template
        chord.setTrack(h.track()) // set track so notes have a track to sit on

        // create chord from notes
        let notes: readonly [number, number][]
        if (voicing === Voicing.INVALID || durationType === HDuration.INVALID) {
            notes = r.notes() // no override, just use notes from realize harmony
        } else {
            // generate notes list based on overridden settings
            let offset = 0
            const interval = h.staff()!.part()!.instrument(h.tick()).transpose()
            if (!concertPitch) {
                offset = interval.chromatic
            }
            notes = r.generateNotes(h.rootTpc(), h.bassTpc(), literal, voicing, offset)
        }

        for (const [pitch, tpc] of notes) {
            const note = Factory.createItem(ElementType.NOTE, chord) as Note
            const nval = new NoteVal()
            nval.pitch = pitch
            if (concertPitch) {
                nval.tpc1 = tpc
            } else {
                nval.tpc2 = tpc
            }
            chord.add(note) // add note first to set track and such
            note.setNval(nval, tick)
        }

        if (!seg.isChordRestType()) {
            const newCrSeg = seg.measure().undoGetSegment(SegmentType.ChordRest, seg.tick())
            newCrSeg.setTicks(seg.ticks())
            seg = newCrSeg
        }

        setChord(this, seg, h.track(), chord, duration) // add chord using template
    }
}

import { BeamMode, staff2track } from '../types/types'
import type { LayoutBreak } from '../dom/layoutbreak'

declare module '../dom/score' {
    interface Score {
        resetUserStretch(): void
        cmdAddStretch(val: number): void
        cmdResetToDefaultLayout(): void
        cmdResetBeamMode(): void
        cmdResetTextStyleOverrides(): void
        cmdResetAllStyles(exceptTheseOnes?: ReadonlySet<Sid>): void
        /** Removes system/page breaks and spacers */
        cmdResetMeasuresLayout(): void
    }
}

// ---------------------------------------------------------
//   the Format menu (cmd.cpp)
// ---------------------------------------------------------

function resetTextProperties(e: EngravingItem): void {
    if (e.generated() || !e.isTextBase()) {
        return
    }

    for (const pid of TEXT_STYLE_TO_RESET) {
        // TODO: use undoResetProperty: https://github.com/musescore/MuseScore/issues/16516
        // But for now, we'll use resetPropety since undoResetProperty leads to various problems
        e.resetProperty(pid)
    }
}

const TEXT_STYLE_TO_RESET: readonly Pid[] = [
    Pid.FONT_FACE,
    Pid.FONT_SIZE,
    Pid.FONT_STYLE,
    Pid.SIZE_SPATIUM_DEPENDENT,
    Pid.FRAME_TYPE,
    Pid.TEXT_LINE_SPACING,
    Pid.FRAME_FG_COLOR,
    Pid.FRAME_BG_COLOR,
    Pid.FRAME_WIDTH,
    Pid.FRAME_PADDING,
    Pid.FRAME_ROUND,
    Pid.ALIGN,
]

Score.prototype.resetUserStretch = function (this: Score): void {
    let m1: Measure | null = null
    let m2: Measure | null = null
    // retrieve span of selection
    const s1 = this.selection().startSegment()
    const s2 = this.selection().endSegment()
    // if either segment is not returned by the selection
    // (for instance, no selection) fall back to first/last measure
    if (!s1) {
        m1 = this.firstMeasureMM()
    } else {
        m1 = s1.measure()
    }
    if (!s2) {
        m2 = this.lastMeasureMM()
    } else {
        m2 = s2.measure()
    }
    if (!m1 || !m2) { // should not happen!
        return
    }

    for (let m: Measure | null = m1; m; m = m.nextMeasureMM()) {
        m.undoChangeProperty(Pid.USER_STRETCH, 1.0)
        if (m === m2) {
            break
        }
    }
}

Score.prototype.cmdAddStretch = function (this: Score, val: number): void {
    if (!this.selection().isRange()) {
        return
    }
    const startTick = this.selection().tickStart()
    const endTick = this.selection().tickEnd()
    for (let m = this.firstMeasureMM(); m; m = m.nextMeasureMM()) {
        if (m.tick().lt(startTick)) {
            continue
        }
        if (m.tick().ge(endTick)) {
            break
        }
        let stretch = m.userStretch()
        stretch += val
        if (stretch < 0) {
            stretch = 0
        }
        m.undoChangeProperty(Pid.USER_STRETCH, stretch)
    }
}

Score.prototype.cmdResetToDefaultLayout = function (this: Score): void {
    const dontResetTheseStyles = new Set<Sid>([
         Sid.lyricsPlacement, Sid.repeatBarTips, Sid.startBarlineSingle, Sid.startBarlineMultiple, Sid.dividerLeft,
         Sid.dividerRightY, Sid.useStraightNoteFlags, Sid.mrNumberSeries, Sid.mrNumberEveryXMeasures,
         Sid.mrNumberSeriesWithParentheses, Sid.oneMeasureRepeatShow1, Sid.fourMeasureRepeatShowExtenders,
         Sid.useWideBeams, Sid.hairpinPlacement, Sid.pedalPlacement, Sid.trillPlacement, Sid.vibratoPlacement,
         Sid.harmonyPlacement, Sid.romanNumeralPlacement, Sid.nashvilleNumberPlacement, Sid.harmonyVoiceLiteral,
         Sid.harmonyVoicing, Sid.harmonyDuration, Sid.capoPosition, Sid.fretNumPos, Sid.fretPlacement, Sid.fretStrings,
         Sid.fretFrets, Sid.fretNut, Sid.fretOrientation, Sid.showPageNumber, Sid.showPageNumberOne,
         Sid.pageNumberOddEven, Sid.showMeasureNumber, Sid.showMeasureNumberOne, Sid.measureNumberInterval,
         Sid.measureNumberSystem, Sid.measureNumberPlacementMode, Sid.genClef, Sid.hideTabClefAfterFirst, Sid.genKeysig,
         Sid.genCourtesyTimesig, Sid.genCourtesyKeysig, Sid.genCourtesyClef, Sid.swingRatio, Sid.swingUnit,
         Sid.chordSymbolSpelling, Sid.automaticCapitalization, Sid.lowerCaseMinorChords, Sid.lowerCaseBassNotes,
         Sid.allCapsNoteNames, Sid.chordStyle, Sid.chordsXmlFile, Sid.chordDescriptionFile, Sid.concertPitch,
         Sid.createMultiMeasureRests, Sid.minEmptyMeasures, Sid.hideEmptyStaves, Sid.dontHideStavesInFirstSystem,
         Sid.enableIndentationOnFirstSystem, Sid.firstSystemIndentationValue, Sid.hideInstrumentNameIfOneInstrument,
         Sid.gateTime, Sid.tenutoGateTime, Sid.staccatoGateTime, Sid.slurGateTime, Sid.sectionPause, Sid.showHeader,
         Sid.headerFirstPage, Sid.headerOddEven, Sid.evenHeaderL, Sid.evenHeaderC, Sid.evenHeaderR, Sid.oddHeaderL,
         Sid.oddHeaderC, Sid.oddHeaderR, Sid.showFooter, Sid.footerFirstPage, Sid.footerOddEven, Sid.evenFooterL,
         Sid.evenFooterC, Sid.evenFooterR, Sid.oddFooterL, Sid.oddFooterC, Sid.oddFooterR, Sid.tupletOutOfStaff,
         Sid.tupletDirection, Sid.tupletBracketType, Sid.dynamicsPlacement, Sid.textLinePlacement,
         Sid.harpPedalDiagramPlacement, Sid.harpPedalTextDiagramPlacement, Sid.expressionPlacement, Sid.tupletNumberType,
         Sid.mmRestShowMeasureNumberRange, Sid.mmRestRangeBracketType, Sid.mmRestRangeVPlacement, Sid.staffTextPlacement,
         Sid.repeatLeftPlacement, Sid.repeatRightPlacement, Sid.instrumentChangePlacement, Sid.stickingPlacement,
         Sid.letRingPlacement, Sid.palmMutePlacement, Sid.pageWidth, Sid.pageHeight, Sid.pagePrintableWidth,
         Sid.pageEvenTopMargin, Sid.pageEvenBottomMargin, Sid.pageEvenLeftMargin, Sid.pageOddTopMargin,
         Sid.pageOddBottomMargin, Sid.pageOddLeftMargin, Sid.pageTwosided, Sid.spatium, Sid.concertPitch,
         Sid.createMultiMeasureRests,
    ])

    const resetPositionAndTextProperties = (e: EngravingItem): void => {
        resetElementPosition(e)
        resetTextProperties(e)
    }

    this.cmdResetMeasuresLayout()
    this.scanElements(resetPositionAndTextProperties)
    this.cmdResetAllStyles(dontResetTheseStyles)
    EditSystemLocks.undoRemoveAllLocks(this)
}

Score.prototype.cmdResetBeamMode = function (this: Score): void {
    const noSelection = this.selection().isNone()
    if (noSelection) {
        this.cmdSelectAll()
    } else if (!this.selection().isRange()) {
        // C++ LOGD("no system or staff selected")
        return
    }

    const firstCr = this.selection().firstChordRest()
    if (!firstCr) {
        // C++ LOGD("no chord/rest in selection")
        return
    }

    const trackStart = staff2track(this.selection().staffStart())
    const trackEnd = staff2track(this.selection().staffEnd())
    const endTick = this.selection().tickEnd()

    for (let seg: Segment | null = firstCr.segment(); seg && seg.tick().lt(endTick); seg = seg.next1(SegmentType.ChordRest)) {
        for (let track = trackStart; track < trackEnd; ++track) {
            const cr = seg.element(track) as ChordRest | null
            if (!cr) {
                continue
            }
            if (cr.isChord()) {
                if (cr.beamMode() !== BeamMode.AUTO) {
                    cr.undoChangeProperty(Pid.BEAM_MODE, BeamMode.AUTO)
                }
            } else if (cr.isRest()) {
                if (cr.beamMode() !== BeamMode.NONE) {
                    cr.undoChangeProperty(Pid.BEAM_MODE, BeamMode.NONE)
                }
            }
        }
    }

    if (noSelection) {
        this.deselectAll()
    }
}

Score.prototype.cmdResetTextStyleOverrides = function (this: Score): void {
    this.scanElements(resetTextProperties)
}

Score.prototype.cmdResetAllStyles = function (this: Score, exceptTheseOnes: ReadonlySet<Sid> = new Set()): void {
    const stylesToReset = new Set<Sid>()

    for (let idx = Sid.NOSTYLE + 1; idx < Sid.STYLES; idx++) {
        const styleId = idx as Sid
        if (!exceptTheseOnes.has(styleId)) {
            stylesToReset.add(styleId)
        }
    }

    this.score().resetStyleValues(stylesToReset)
}

// Removes system/page breaks and spacers
Score.prototype.cmdResetMeasuresLayout = function (this: Score): void {
    const itemsToRemove: EngravingItem[] = []

    for (let mb = this.first(); mb; mb = mb.next()) {
        if (mb.isMeasure()) {
            mb.undoResetProperty(Pid.USER_STRETCH)

            for (const staff of (mb as Measure).mstaves()) {
                const down = staff.vspacerDown()
                if (down) {
                    itemsToRemove.push(down)
                }
                const up = staff.vspacerUp()
                if (up) {
                    itemsToRemove.push(up)
                }
            }
        }

        if (!mb.lineBreak() && !mb.pageBreak()) {
            continue
        }

        for (const item of mb.el()) {
            if (item.isLayoutBreak() && !(item as LayoutBreak).isSectionBreak()) {
                itemsToRemove.push(item)
            }
        }
    }

    for (const item of itemsToRemove) {
        this.undoRemoveElement(item)
    }
}

import { GuitarBend } from '../dom/guitarbend'
import { SLine } from '../dom/line'
import { SpannerAnchor } from '../dom/spanner'
import { GuitarBendType } from '../types/types'
import { Constants } from '../types/constants'

declare module '../dom/score' {
    interface Score {
        /** C++ Score::addGuitarBend(GuitarBendType type, Note* note, Note* endNote = nullptr) */
        addGuitarBend(type: GuitarBendType, note: Note, endNote?: Note | null): GuitarBend | null
    }
}

Score.prototype.addGuitarBend = function (this: Score, type: GuitarBendType, note: Note, endNote: Note | null = null): GuitarBend | null {
    if (note.isPreBendOrDiveStart()) {
        if (type === GuitarBendType.BEND && note.staffType()!.isTabStaff()) {
            const preBend = note.bendFor()
            const mainNote = preBend ? preBend.endNote() : null
            if (mainNote) {
                return this.addGuitarBend(type, mainNote, null)
            }
        }
        return null
    }

    if (note.isGraceBendStart() && type !== GuitarBendType.PRE_BEND) {
        return null
    }

    const bendBack = note.bendBack()
    if (bendBack && !bendBack.isDive()
        && (type === GuitarBendType.PRE_BEND || type === GuitarBendType.GRACE_NOTE_BEND)) {
        return null
    }

    const bendForNote = note.bendFor()
    if (bendForNote && !bendForNote.isDive()
        && (type === GuitarBendType.BEND || type === GuitarBendType.SLIGHT_BEND)) {
        return null
    }

    if (type === GuitarBendType.DIP) {
        for (const n of note.chord().notes()) {
            const bendFor = n.bendFor()
            if (bendFor && bendFor.bendType() === GuitarBendType.DIP) {
                return null // Only one dip per chord
            }
        }
    }

    const chord = note.chord()
    const isDive = type >= GuitarBendType.DIVE && type <= GuitarBendType.SCOOP

    if (type === GuitarBendType.BEND || type === GuitarBendType.DIVE) {
        for (const sp of note.spannerFor()) {
            if ((sp.isGuitarBend() && (sp as GuitarBend).isDive() === isDive) || sp.isGlissando()) {
                return null
            }
        }

        if (!endNote) {
            endNote = SLine.guessFinalNote(note)
        }

        let suitableEndNote = !!endNote
        if (endNote) {
            for (const sp of endNote.spannerBack()) {
                if (sp.isTie() || sp.isGlissando() || (sp.isGuitarBend() && (sp as GuitarBend).isDive() === isDive)) {
                    suitableEndNote = false
                    break
                }
            }
        }

        if (!suitableEndNote) {
            endNote = GuitarBend.createEndNote(note, type)
        }

        if (!endNote) {
            return null
        }
    }

    const bend = new GuitarBend(scoreDummy(this).note())
    bend.setAnchor(SpannerAnchor.NOTE)
    bend.setTick(chord.tick())
    bend.setTrack(chord.track())

    if (type === GuitarBendType.BEND || type === GuitarBendType.DIVE) {
        bend.setBendType(chord.isGrace() && type === GuitarBendType.BEND ? GuitarBendType.GRACE_NOTE_BEND : type)
        bend.setStartElement(note)
        bend.setTick2(endNote!.tick())
        bend.setTrack2(endNote!.track())
        bend.setEndElement(endNote!)
        bend.setParent(note)
        if (type === GuitarBendType.BEND) {
            GuitarBend.fixNotesFrettingForStandardBend(note, endNote!)
        }
    } else {
        bend.setBendType(type)
        bend.setTick2(chord.tick())
        bend.setTrack2(chord.track())

        if (type === GuitarBendType.PRE_BEND || type === GuitarBendType.GRACE_NOTE_BEND || type === GuitarBendType.PRE_DIVE) {
            const gracesBefore = chord.graceNotesBefore()

            // Create grace note
            const graceNote = gracesBefore.empty()
                ? this.setGraceNote(chord, note.pitch(), GraceNoteType.APPOGGIATURA, Math.trunc(Constants.DIVISION / 2))
                : this.addNote(gracesBefore.back(), note.noteVal())
            graceNote.transposeDiatonic(type === GuitarBendType.PRE_DIVE ? 1 : -1, true, false)
            GuitarBend.fixNotesFrettingForGraceBend(graceNote, note)

            const graceChord = graceNote.chord()
            for (const item of graceChord.linkList()) {
                const linkedGrace = item as Chord
                linkedGrace.setNoStem(true)
                linkedGrace.setBeamMode(BeamMode.NONE)
            }

            // Add bend
            bend.setParent(graceNote)
            bend.setStartElement(graceNote)
            bend.setEndElement(note)
        } else if (type === GuitarBendType.SLIGHT_BEND || type === GuitarBendType.DIP || type === GuitarBendType.SCOOP) {
            bend.setParent(note)
            bend.setStartElement(note)
            // Slight bends don't end on another note
            bend.setEndElement(note)
        }
    }

    const startChord = bend.startNote()!.chord()
    if (startChord.isGrace()) {
        for (const item of startChord.linkList()) {
            const linkedGrace = item as Chord
            if (linkedGrace.staffType()!.isTabStaff()) {
                linkedGrace.setNoStem(true)
                linkedGrace.setBeamMode(BeamMode.NONE)
            }
        }
    }

    this.undoAddElement(bend)

    const overlapping = bend.overlappingBendOrDive()
    if (overlapping) {
        const halfBendAmount = Math.trunc(overlapping.bendAmountInQuarterTones() / 2) // C++ integer division
        if (bend.isDive()) {
            bend.undoChangeProperty(Pid.GUITAR_BEND_AMOUNT, halfBendAmount)
        } else {
            overlapping.undoChangeProperty(Pid.GUITAR_BEND_AMOUNT, halfBendAmount)
        }
    }

    return bend
}
