/*
 * SPDX-License-Identifier: GPL-3.0-only
 * MuseEncore — port of MuseScore Studio (https://github.com/musescore/MuseScore)
 * Copyright (C) 2021-2026 MuseScore Limited and others
 *
 * Port of the editing and note input actions of src/notationscene/internal/notationactioncontroller.cpp (the action
 * codes of MuseScore's notationuiactions.cpp with their handlers and enabled conditions) and of the checked states of
 * src/notationscene/qml/MuseScore/NotationScene/noteinputbarmodel.cpp (NoteInputBarModel::updateState).
 *
 * The C++ controller registers its handlers in the ActionsDispatcher; here dispatch(code) runs them.
 *
 * TODO(port): text/lyrics/grip editing and nudging, tablature (string selection, TAB pad
 * notes), copy/paste, MIDI input (real-time input uses the note name keys). The dialogs (tuplet-dialog, select-dialog,
 * insert-measures, staff-properties, ...) are registered by the app.
 */

import type { Harmony } from '../engraving/dom/harmony'
import { playbackController } from '../playback/iplaybackcontroller'
import { DurationType, StaffGroup, VoiceAssignment, type voice_idx_t } from '../engraving/types/types'
import { InputState, NoteEntryMethod } from '../engraving/dom/input'
import { Pid } from '../engraving/dom/property'
import { AccidentalType } from '../engraving/dom/accidentaldata'
import { UpDownMode } from '../engraving/dom/mscore'
import { Pad } from '../engraving/dom/score'
import { AddBoxesTarget, BoxType, BracketsType, FilterElementsOptions, NoteAddingMode, NoteName } from '../notation/notationtypes'
import { NotationElements } from '../notation/internal/notationelements'
import { SelectType } from '../engraving/dom/select'
import { MoveDirection, MoveSelectionType, type NotationInteraction } from '../notation/internal/notationinteraction'
import type { NotationNoteInput } from '../notation/internal/notationnoteinput'
import type { Score } from '../engraving/dom/score'
import type { EngravingItem } from '../engraving/dom/engravingitem'
import type { ChordRest } from '../engraving/dom/chordrest'
// (imports of the editing section; Fraction and ElementType: see the note input section)
import { TextStyleType } from '../engraving/types/types'
import { PointF } from '../framework/draw/types/geometry'
import { PastingType, isVerticalBoxTextStyle } from '../notation/notationtypes'

interface ActionEntry {
    run: () => void
    enabled?: () => boolean
}

const STRETCH_STEP = 0.1

const UNDO_ACTION_CODE = 'action://notation/undo'
const REDO_ACTION_CODE = 'action://notation/redo'

/** NotationUiActions::actionDurationType */
const DURATION_ACTIONS: ReadonlyMap<string, DurationType> = new Map([
    ['note-longa', DurationType.V_LONG],
    ['note-breve', DurationType.V_BREVE],
    ['pad-note-1', DurationType.V_WHOLE],
    ['pad-note-2', DurationType.V_HALF],
    ['pad-note-4', DurationType.V_QUARTER],
    ['pad-note-8', DurationType.V_EIGHTH],
    ['pad-note-16', DurationType.V_16TH],
    ['pad-note-32', DurationType.V_32ND],
    ['pad-note-64', DurationType.V_64TH],
    ['pad-note-128', DurationType.V_128TH],
    ['pad-note-256', DurationType.V_256TH],
    ['pad-note-512', DurationType.V_512TH],
    ['pad-note-1024', DurationType.V_1024TH],
])

const PAD_NOTE_ACTIONS: readonly [string, Pad][] = [
    ['note-longa', Pad.NOTE00],
    ['note-breve', Pad.NOTE0],
    ['pad-note-1', Pad.NOTE1],
    ['pad-note-2', Pad.NOTE2],
    ['pad-note-4', Pad.NOTE4],
    ['pad-note-8', Pad.NOTE8],
    ['pad-note-16', Pad.NOTE16],
    ['pad-note-32', Pad.NOTE32],
    ['pad-note-64', Pad.NOTE64],
    ['pad-note-128', Pad.NOTE128],
    ['pad-note-256', Pad.NOTE256],
    ['pad-note-512', Pad.NOTE512],
    ['pad-note-1024', Pad.NOTE1024],
    ['pad-dot', Pad.DOT],
    ['pad-dot2', Pad.DOT2],
    ['pad-dot3', Pad.DOT3],
    ['pad-dot4', Pad.DOT4],
    ['pad-rest', Pad.REST],
]

/** NotationUiActions::actionDotCount */
const DOT_ACTIONS: ReadonlyMap<string, number> = new Map([['pad-dot', 1], ['pad-dot2', 2], ['pad-dot3', 3], ['pad-dot4', 4]])

/** NotationUiActions::actionAccidentalType */
const ACCIDENTAL_ACTIONS: ReadonlyMap<string, AccidentalType> = new Map([
    ['flat2', AccidentalType.FLAT2],
    ['flat', AccidentalType.FLAT],
    ['nat', AccidentalType.NATURAL],
    ['sharp', AccidentalType.SHARP],
    ['sharp2', AccidentalType.SHARP2],
])

/** NotationUiActions::actionVoice */
const VOICE_ACTIONS: ReadonlyMap<string, voice_idx_t> = new Map([['voice-1', 0], ['voice-2', 1], ['voice-3', 2], ['voice-4', 3]])

/** NoteInputBarModel NOTE_INPUT_METHOD_ACTIONS */
const NOTE_INPUT_METHOD_ACTIONS: ReadonlyMap<string, NoteEntryMethod> = new Map([
    ['note-input-by-note-name', NoteEntryMethod.BY_NOTE_NAME],
    ['note-input-by-duration', NoteEntryMethod.BY_DURATION],
    ['note-input-rhythm', NoteEntryMethod.RHYTHM],
    ['note-input-repitch', NoteEntryMethod.REPITCH],
    ['note-input-realtime-auto', NoteEntryMethod.REALTIME_AUTO],
    ['note-input-realtime-manual', NoteEntryMethod.REALTIME_MANUAL],
    ['note-input-timewise', NoteEntryMethod.TIMEWISE],
])

const NOTE_NAMES: readonly [string, NoteName][] = [
    ['c', NoteName.C], ['d', NoteName.D], ['e', NoteName.E], ['f', NoteName.F], ['g', NoteName.G], ['a', NoteName.A],
    ['b', NoteName.B],
]

// (constants and imports of the note input section)
import { Fraction } from '../engraving/types/fraction'
import { BeamMode, ElementType, LayoutBreakType } from '../engraving/types/types'
import { Sid } from '../engraving/style/styledef'
import { TranslatableString } from '../framework/global/types/translatablestring'
import { NoteType as GraceNoteType } from '../engraving/dom/chordrest'
import { TupletBracketType, TupletNumberType } from '../engraving/dom/tuplet'
import { HairpinType } from '../engraving/dom/hairpin'
import { OttavaType } from '../engraving/dom/ottava'
import { MAX_NOTES_INTERVAL, MIN_NOTES_INTERVAL, TupletOptions, isNotesIntervalValid } from '../notation/notationtypes'
import { NotationMidiInput } from '../notation/internal/notationmidiinput'
import { SymId } from '../engraving/types/symid'
import { PlacementV, TransposeDirection } from '../engraving/types/types'
import { flipArticulations, splitArticulations } from '../engraving/dom/articulation'
import type { Chord } from '../engraving/dom/chord'
import type { Note } from '../engraving/dom/note'

/** NotationUiActions::actionArticulationSymbolId */
const ARTICULATION_ACTIONS: ReadonlyMap<string, SymId> = new Map([
    ['add-marcato', SymId.articMarcatoAbove],
    ['add-sforzato', SymId.articAccentAbove],
    ['add-tenuto', SymId.articTenutoAbove],
    ['add-staccato', SymId.articStaccatoAbove],
])

const TUPLET_ACTIONS: readonly [string, number][] = [
    ['duplet', 2], ['triplet', 3], ['quadruplet', 4], ['quintuplet', 5], ['sextuplet', 6], ['septuplet', 7], ['octuplet', 8],
    ['nonuplet', 9],
]

const GRACE_NOTE_ACTIONS: readonly [string, GraceNoteType][] = [
    ['acciaccatura', GraceNoteType.ACCIACCATURA],
    ['appoggiatura', GraceNoteType.APPOGGIATURA],
    ['grace4', GraceNoteType.GRACE4],
    ['grace16', GraceNoteType.GRACE16],
    ['grace32', GraceNoteType.GRACE32],
    ['grace8after', GraceNoteType.GRACE8_AFTER],
    ['grace16after', GraceNoteType.GRACE16_AFTER],
    ['grace32after', GraceNoteType.GRACE32_AFTER],
]

const BEAM_ACTIONS: readonly [string, BeamMode][] = [
    ['beam-auto', BeamMode.AUTO],
    ['beam-none', BeamMode.NONE],
    ['beam-break-left', BeamMode.BEGIN],
    ['beam-break-inner-8th', BeamMode.BEGIN16],
    ['beam-break-inner-16th', BeamMode.BEGIN32],
    ['beam-join', BeamMode.MID],
]

let s_actionCodes: string[] | null = null

const DONT_PLAY_CHORD = false

enum PlayMode {
    NoPlay,
    PlayNote,
    PlayChord,
}

export class NotationActionController {
    private m_interaction: NotationInteraction
    private m_actions = new Map<string, ActionEntry>()

    /** C++ NotationConfiguration::defaultNoteInputMethod() */
    defaultNoteInputMethod = NoteEntryMethod.BY_NOTE_NAME
    /** C++ NotationConfiguration::isPlayPreviewNotesInInputByDuration() */
    isPlayPreviewNotesInInputByDuration = true

    constructor(interaction: NotationInteraction) {
        this.m_interaction = interaction
        this.init()
    }

    private init(): void {
        //! NOTE For historical reasons, the name of the action does not match what needs to be done
        this.registerAction('action://notation/cancel', () => this.resetState())

        this.registerAction('note-input', () => this.toggleNoteInput(), () => this.startNoteInputAllowed())
        for (const [code, method] of NOTE_INPUT_METHOD_ACTIONS) {
            this.registerAction(code, () => this.toggleNoteInputMethod(method), () => this.startNoteInputAllowed())
        }

        for (const [code, pad] of PAD_NOTE_ACTIONS) {
            this.registerAction(code, () => this.padNote(pad))
        }

        for (const [n, name] of NOTE_NAMES) {
            this.registerNoteAction(`note-${n}`, name, NoteAddingMode.NextChord)
            this.registerNoteAction(`chord-${n}`, name, NoteAddingMode.CurrentChord)
            this.registerNoteAction(`insert-${n}`, name, NoteAddingMode.InsertChord)
        }

        for (const [code, type] of ACCIDENTAL_ACTIONS) {
            this.registerAction(code, () => this.toggleAccidental(type))
            this.registerAction(`${code}-post`, () => this.withPlayMode(PlayMode.PlayNote, () => this.interaction().changeAccidental(type)))
        }

        this.registerAction('rest', () => this.interaction().putRestToSelection())

        this.registerAction('toggle-visible', () => this.interaction().toggleVisible(), () => this.isToggleVisibleAllowed())
        this.registerAction('concert-pitch', () => this.toggleConcertPitch())

        this.registerAction('notation-move-right', () => this.move(MoveDirection.Right, false))
        this.registerAction('notation-move-left', () => this.move(MoveDirection.Left, false))
        this.registerAction('notation-move-right-quickly', () => this.move(MoveDirection.Right, true), () => this.measureNavigationAvailable())
        this.registerAction('notation-move-left-quickly', () => this.move(MoveDirection.Left, true), () => this.measureNavigationAvailable())
        this.registerAction('pitch-up', () => this.move(MoveDirection.Up, false))
        this.registerAction('pitch-down', () => this.move(MoveDirection.Down, false))
        this.registerAction('pitch-up-octave', () => this.move(MoveDirection.Up, true))
        this.registerAction('pitch-down-octave', () => this.move(MoveDirection.Down, true))
        this.registerAction('up-chord', () => this.moveWithinChord(MoveDirection.Up), () => this.hasSelection())
        this.registerAction('down-chord', () => this.moveWithinChord(MoveDirection.Down), () => this.hasSelection())
        this.registerAction('top-chord', () => this.selectTopOrBottomOfChord(MoveDirection.Up), () => this.hasSelection())
        this.registerAction('bottom-chord', () => this.selectTopOrBottomOfChord(MoveDirection.Down), () => this.hasSelection())

        this.registerAction('double-duration', () => this.doubleNoteInputDuration())
        this.registerAction('half-duration', () => this.halveNoteInputDuration())
        this.registerAction('inc-duration-dotted', () => this.interaction().increaseDecreaseDuration(-1, true))
        this.registerAction('dec-duration-dotted', () => this.interaction().increaseDecreaseDuration(1, true))

        this.registerAction('action://notation/delete', () => this.interaction().deleteSelection(), () => this.hasSelection())

        this.registerAction('flip', () => this.interaction().flipSelection(), () => this.hasSelection())
        this.registerAction('tie', () => this.addTie())
        this.registerAction('chord-tie', () => this.chordTie())

        this.registerAction(UNDO_ACTION_CODE, () => this.interaction().undo(), () => this.canUndo())
        this.registerAction(REDO_ACTION_CODE, () => this.interaction().redo(), () => this.canRedo())

        this.registerAction('notation-select-all', () => this.interaction().selectAll())
        this.registerAction('select-similar', () => this.selectAllSimilarElements(), () => this.hasSelection())
        this.registerAction('select-similar-staff', () => this.selectAllSimilarElementsInStaff(), () => this.hasSelection())
        this.registerAction('select-similar-range', () => this.selectAllSimilarElementsInRange(), () => this.hasSelection())
        this.registerAction('insert-measure', () => this.addBoxes(BoxType.Measure, 1, AddBoxesTarget.BeforeSelection),
            () => this.hasSelection())
        this.registerAction('append-measure', () => this.addBoxes(BoxType.Measure, 1, AddBoxesTarget.AtEndOfScore))
        // insert-measures, insert-measures-after-selection, insert-measures-at-start-of-score, append-measures
        // (addMeasures with the number of measures of SelectMeasuresCountDialog) are registered by the app

        this.registerAction('insert-hbox', () => this.addBoxes(BoxType.Horizontal, 1, AddBoxesTarget.BeforeSelection))
        this.registerAction('insert-vbox', () => this.addBoxes(BoxType.Vertical, 1, AddBoxesTarget.BeforeSelection))
        this.registerAction('insert-textframe', () => this.addBoxes(BoxType.Text, 1, AddBoxesTarget.BeforeSelection))
        this.registerAction('insert-fretframe', () => this.addBoxes(BoxType.Fret, 1, AddBoxesTarget.BeforeSelection))
        this.registerAction('append-hbox', () => this.addBoxes(BoxType.Horizontal, 1, AddBoxesTarget.AtEndOfScore))
        this.registerAction('append-vbox', () => this.addBoxes(BoxType.Vertical, 1, AddBoxesTarget.AtEndOfScore))
        this.registerAction('append-textframe', () => this.addBoxes(BoxType.Text, 1, AddBoxesTarget.AtEndOfScore))
        this.registerAction('append-fretframe', () => this.addBoxes(BoxType.Fret, 1, AddBoxesTarget.AtEndOfScore))

        this.registerAction('add-fretboard-diagram', () => this.interaction().addFretboardDiagram())

        // the Tools menu (realize-chord-symbols, openRealizeChordSymbolsDialog, is registered by the app)
        this.registerAction('split-measure', () => this.interaction().splitSelectedMeasure())
        this.registerAction('join-measures', () => this.interaction().joinSelectedMeasures())
        for (const [code, v1, v2] of [
            ['voice-x12', 0, 1], ['voice-x13', 0, 2], ['voice-x14', 0, 3], ['voice-x23', 1, 2], ['voice-x24', 1, 3], ['voice-x34', 2, 3],
        ] as const) {
            this.registerAction(code, () => this.interaction().swapVoices(v1, v2))
        }
        this.registerAction('explode', () => this.interaction().explodeSelectedStaff())
        this.registerAction('implode', () => this.interaction().implodeSelectedStaff())
        this.registerAction('time-delete', () => this.interaction().removeSelectedRange())
        this.registerAction('del-empty-measures', () => this.interaction().removeEmptyTrailingMeasures())
        this.registerAction('slash-fill', () => this.interaction().fillSelectionWithSlashes())
        this.registerAction('slash-rhythm', () => this.interaction().replaceSelectedNotesWithSlashes())
        this.registerAction('pitch-spell', () => this.interaction().spellPitches())
        this.registerAction('pitch-spell-sharps', () => this.interaction().spellPitchesWithSharps())
        this.registerAction('pitch-spell-flats', () => this.interaction().spellPitchesWithFlats())
        this.registerAction('reset-groupings', () => this.interaction().regroupNotesAndRests())
        this.registerAction('resequence-rehearsal-marks', () => this.interaction().resequenceRehearsalMarks())
        this.registerAction('copy-lyrics-to-clipboard', () => this.interaction().copyLyrics())
        this.registerAction('enh-both', () => this.interaction().changeEnharmonicSpelling(true))
        this.registerAction('enh-current', () => this.interaction().changeEnharmonicSpelling(false))

        // select-dialog (openSelectionMoreOptions) is registered by the app, which shows the dialogs (createSelectDialog)
        this.registerAction('first-element', () => this.withPlayMode(PlayMode.PlayChord, () => this.interaction().selectFirstElement(false)))
        this.registerAction('last-element', () => this.withPlayMode(PlayMode.PlayChord, () => this.interaction().selectLastElement()))

        this.registerAction('pitch-up-diatonic', () => this.movePitchDiatonic(MoveDirection.Up))
        this.registerAction('pitch-down-diatonic', () => this.movePitchDiatonic(MoveDirection.Down))

        this.registerAction('transpose-up', () => this.withPlayMode(PlayMode.PlayNote, () => this.interaction().transposeSemitone(1)))
        this.registerAction('transpose-down', () => this.withPlayMode(PlayMode.PlayNote, () => this.interaction().transposeSemitone(-1)))
        this.registerAction('pitch-up-diatonic-alterations', () => this.withPlayMode(PlayMode.PlayNote,
            () => this.interaction().transposeDiatonicAlterations(TransposeDirection.UP)))
        this.registerAction('pitch-down-diatonic-alterations', () => this.withPlayMode(PlayMode.PlayNote,
            () => this.interaction().transposeDiatonicAlterations(TransposeDirection.DOWN)))

        for (const [code, voice] of VOICE_ACTIONS) {
            this.registerAction(code, () => this.changeVoice(voice))
        }

        this.registerAction('add-brackets', () => this.interaction().addBracketsToSelection(BracketsType.Brackets))
        this.registerAction('add-parentheses', () => this.interaction().addBracketsToSelection(BracketsType.Parentheses))
        this.registerAction('add-braces', () => this.interaction().addBracketsToSelection(BracketsType.Braces))

        const toggleLayoutBreakAvailable = (): boolean => this.interaction().toggleLayoutBreakAvailable()
        this.registerAction('system-break', () => this.interaction().toggleLayoutBreak(LayoutBreakType.LINE), toggleLayoutBreakAvailable)
        this.registerAction('page-break', () => this.interaction().toggleLayoutBreak(LayoutBreakType.PAGE), toggleLayoutBreakAvailable)
        this.registerAction('section-break', () => this.interaction().toggleLayoutBreak(LayoutBreakType.SECTION), toggleLayoutBreakAvailable)

        this.registerAction('apply-system-lock', () => this.interaction().applySystemLock())
        this.registerAction('move-measure-to-prev-system', () => this.interaction().moveMeasureToPrevSystem())
        this.registerAction('move-measure-to-next-system', () => this.interaction().moveMeasureToNextSystem())
        this.registerAction('toggle-system-lock', () => this.interaction().toggleSystemLock())
        this.registerAction('toggle-score-lock', () => this.interaction().toggleScoreLock())
        this.registerAction('make-into-system', () => this.interaction().makeIntoSystem())

        // the Format menu (edit-style, page-settings, measures-per-system, load-style and save-style open dialogs:
        // registered by the app)
        this.registerAction('stretch-', () => this.addStretch(-STRETCH_STEP))
        this.registerAction('stretch+', () => this.addStretch(STRETCH_STEP))
        this.registerAction('reset-stretch', () => this.resetStretch())
        this.registerAction('reset-text-style-overrides', () => this.interaction().resetTextStyleOverrides())
        this.registerAction('reset-beammode', () => this.resetBeamMode())
        this.registerAction('reset', () => this.interaction().resetShapesAndPosition(), () => this.hasSelection())
        this.registerAction('reset-to-default-layout', () => this.interaction().resetToDefaultLayout())

        this.initEditingActions()
        this.initNoteInputActions()
    }

    /** the action codes of the controller (independent of a score: the handlers are only registered) */
    static actionCodes(): string[] {
        s_actionCodes ??= new NotationActionController(null as unknown as NotationInteraction).actionCodes()
        return s_actionCodes
    }

    /** the actions that have a checked state (the buttons of the note input toolbar, NoteInputBarModel) */
    static isCheckableAction(code: string): boolean {
        return code === 'note-input' || NOTE_INPUT_METHOD_ACTIONS.has(code) || DOT_ACTIONS.has(code) || DURATION_ACTIONS.has(code)
            || ACCIDENTAL_ACTIONS.has(code) || VOICE_ACTIONS.has(code) || code === 'tie' || code === 'pad-rest' || code === 'add-slur'
            || ARTICULATION_ACTIONS.has(code) || code === 'lv' || code === 'concert-pitch'
    }

    interaction(): NotationInteraction { return this.m_interaction }
    private noteInput(): NotationNoteInput { return this.m_interaction.noteInput() }
    private score(): Score { return this.m_interaction.score() }

    /** the action codes this controller handles */
    actionCodes(): string[] { return [...this.m_actions.keys()] }

    isActionAvailable(code: string): boolean { return this.m_actions.has(code) }

    /** C++ canReceiveAction(): the action is registered and enabled */
    canReceiveAction(code: string): boolean {
        if (!this.m_actions.has(code)) {
            return false
        }

        if (code === UNDO_ACTION_CODE) {
            return this.canUndo()
        }

        if (code === REDO_ACTION_CODE) {
            return this.canRedo()
        }

        // Actions other than undo and redo can only be handled when the current
        // notation contains at least one part.
        if (!this.score().parts().length) {
            return false
        }

        return this.m_actions.get(code)!.enabled?.() ?? true
    }

    /** runs the action if it can be received; returns true if it ran */
    dispatch(code: string): boolean {
        if (!this.canReceiveAction(code)) {
            return false
        }
        this.m_actions.get(code)!.run()
        return true
    }

    // ---------------------------------------------------------------------------------
    // the handlers
    // ---------------------------------------------------------------------------------

    private resetState(): void {
        if (playbackController()?.isPlaying()) {
            playbackController()!.reset()
        }

        if (this.noteInput().isNoteInputMode()) {
            this.toggleNoteInput()
            return
        }

        const interaction = this.interaction()
        if (interaction.isGripEditStarted()) {
            // Exit grip edit but leave element selected
            interaction.endEditElement()
            return
        }

        if (interaction.isTextEditingStarted()) {
            interaction.endEditElement()
            return
        } else if (interaction.isEditingElement()) {
            interaction.endEditElement()
        }

        if (!this.score().selection().isNone()) {
            this.interaction().clearSelection()
        }
    }

    private addStretch(value: number): void {
        if (!this.score().selection().isRange()) {
            return
        }

        this.interaction().addStretch(value)
    }

    private resetStretch(): void {
        if (!this.score().selection().isRange()) {
            return
        }

        this.interaction().resetStretch()
    }

    private resetBeamMode(): void {
        const selection = this.score().selection()
        if (selection.isNone() || selection.isRange()) {
            this.interaction().resetBeamMode()
        }
    }

    private toggleNoteInput(): void {
        const noteInput = this.noteInput()
        if (noteInput.isNoteInputMode()) {
            noteInput.endNoteInput()
            return
        }

        // If the Braille panel or Note Input toolbar has focus, stay there.
        noteInput.startNoteInput(this.defaultNoteInputMethod, /*focusNotation*/ false)
    }

    private toggleNoteInputMethod(method: NoteEntryMethod): void {
        const noteInput = this.noteInput()
        if (!noteInput.isNoteInputMode()) {
            noteInput.startNoteInput(method)
        } else if (noteInput.usingNoteInputMethod(method)) {
            this.toggleNoteInput()
        } else {
            noteInput.setNoteInputMethod(method)
        }
    }

    private handleNoteAction(note: NoteName, addingMode: NoteAddingMode): void {
        this.startNoteInput()

        const addFlag = addingMode === NoteAddingMode.CurrentChord
        const params = this.score().resolveNoteInputParams(note, addFlag)
        if (!params) {
            // C++: LOGE() << "Could not resolve note input params"
            return
        }

        const noteInput = this.noteInput()

        if (addingMode === NoteAddingMode.NextChord) {
            if (noteInput.usingNoteInputMethod(NoteEntryMethod.BY_DURATION)) {
                noteInput.setRestMode(false)
                noteInput.setInputNote(params)

                if (this.isPlayPreviewNotesInInputByDuration) {
                    this.playInputNotes()
                }
                return
            }
        }

        noteInput.addNote(params, addingMode)

        this.seekAndPlaySelectedElement()
    }

    /** C++ playbackController()->playNotes(state.notes(), state.staffIdx(), state.segment()) */
    private playInputNotes(): void {
        const state = this.score().inputState()
        const segment = state.segment()
        if (segment) {
            playbackController()?.playNotes(state.notes(), state.staffIdx(), segment)
        }
    }

    private seekSelectedElement(): void {
        if (playbackController()?.isLoopEnabled()) {
            return
        }

        const element = this.score().selection().element()
        if (!element) {
            return
        }

        playbackController()?.seekElement(element)
    }

    private playSelectedElement(playChord: boolean): void {
        let element = this.score().selection().element()
        if (!element) {
            return
        }

        if (playChord) {
            element = element.elementBase()
        }

        playbackController()?.playElements([element])

        // C++ currentNotationScore()->setPlayChord(false), setPlayNote(false)
    }

    private seekAndPlaySelectedElement(playChord = true): void {
        this.seekSelectedElement()
        this.playSelectedElement(playChord)
    }

    private padNote(pad: Pad): void {
        const interaction = this.interaction()
        const noteInput = this.noteInput()

        if (this.score().selection().isNone()) {
            if (!noteInput.isNoteInputMode() && !this.startNoteInputAllowed()) {
                return
            }

            this.startNoteInput()
        }

        if (pad >= Pad.DOT && pad <= Pad.DOT4) {
            if (!noteInput.isNoteInputMode() || !noteInput.addAccidentalDotsArticulationsToNextNoteEntered) {
                interaction.toggleDotsForSelection(pad)
                return
            }
        }

        noteInput.padNote(pad)

        if (noteInput.usingNoteInputMethod(NoteEntryMethod.BY_DURATION)
            || noteInput.usingNoteInputMethod(NoteEntryMethod.RHYTHM)) {
            this.seekAndPlaySelectedElement()
        }
    }

    private toggleAccidental(type: AccidentalType): void {
        const interaction = this.interaction()
        const noteInput = this.noteInput()

        if (this.score().selection().isNone()) {
            if (!noteInput.isNoteInputMode() && !this.startNoteInputAllowed()) {
                return
            }

            this.startNoteInput()
        }

        if (noteInput.isNoteInputMode() && noteInput.addAccidentalDotsArticulationsToNextNoteEntered) {
            noteInput.setAccidental(type)
        } else {
            interaction.toggleAccidentalForSelection(type)
            this.seekAndPlaySelectedElement()
        }
    }

    private doubleNoteInputDuration(): void {
        if (this.noteInput().isNoteInputMode()) {
            this.noteInput().doubleNoteInputDuration()
        } else {
            this.interaction().increaseDecreaseDuration(-1, false)
        }
    }

    private halveNoteInputDuration(): void {
        if (this.noteInput().isNoteInputMode()) {
            this.noteInput().halveNoteInputDuration()
        } else {
            this.interaction().increaseDecreaseDuration(1, false)
        }
    }

    private move(direction: MoveDirection, quickly: boolean): void {
        const interaction = this.interaction()

        const previousSelectionExists = !!this.score().selection().currentCR()
        if (this.score().selection().isNone() && previousSelectionExists) {
            // Try to restore the previous selection...
            interaction.moveSelection(direction, MoveSelectionType.EngravingItem)
            this.seekAndPlaySelectedElement(true)
            return
        }

        const noteInput = this.noteInput()

        const selectedElement = this.score().selection().element()
        let playChord = false

        switch (direction) {
        case MoveDirection.Up:
        case MoveDirection.Down:
            if (!quickly && selectedElement && selectedElement.isLyrics()) {
                interaction.moveLyrics(direction)
            } else if (selectedElement && (selectedElement.isTextBase() || selectedElement.isArticulationFamily())) {
                interaction.nudge(direction, quickly)
            } else if (selectedElement && selectedElement.hasGrips() && interaction.isGripEditStarted()) {
                interaction.nudgeAnchors(direction)
            } else if (noteInput.isNoteInputMode() && noteInput.usingNoteInputMethod(NoteEntryMethod.BY_DURATION)) {
                this.moveInputNotes(direction === MoveDirection.Up, quickly ? UpDownMode.OCTAVE : UpDownMode.DIATONIC)
                return
            } else if (noteInput.isNoteInputMode() && noteInput.state().staffGroup() === StaffGroup.TAB) {
                if (quickly) {
                    interaction.movePitch(direction, UpDownMode.OCTAVE)
                }
                interaction.moveSelection(direction, MoveSelectionType.String)
                return
            } else if (this.score().selection().isNone()) {
                interaction.selectFirstElement(false)
            } else {
                interaction.movePitch(direction, quickly ? UpDownMode.OCTAVE : UpDownMode.CHROMATIC)
            }
            break
        case MoveDirection.Right:
        case MoveDirection.Left:
            if (playbackController()?.isPlaying()) {
                const beat = playbackController()!.currentBeat()
                let targetBeatIdx = Math.trunc(beat.beat)
                let targetMeasureIdx = beat.measureIndex
                const increment = (direction === MoveDirection.Right ? 1 : -1)

                if (quickly) {
                    targetBeatIdx = 0
                    targetMeasureIdx += increment
                    if (targetMeasureIdx > beat.maxMeasureIndex) {
                        targetMeasureIdx = beat.maxMeasureIndex
                    } else if (targetMeasureIdx < 0) {
                        targetMeasureIdx = 0
                    }
                } else {
                    targetBeatIdx += increment
                    if (targetBeatIdx > beat.maxBeatIndex) {
                        targetBeatIdx = 0
                        targetMeasureIdx += 1
                    } else if (targetBeatIdx < 0) {
                        targetMeasureIdx -= 1

                        // Set target beat to max beat of previous bar
                        const timeSigMap = this.score().masterScore().sigmap()
                        const targetBarStartTick = timeSigMap.bar2tick(targetMeasureIdx, 0)
                        targetBeatIdx = timeSigMap.timesig(Fraction.fromTicks(targetBarStartTick)).timesig().numerator() - 1
                    }
                }

                playbackController()!.seekBeat(targetMeasureIdx, targetBeatIdx)
                return
            }

            if (interaction.isTextEditingStarted() && this.textNavigationAvailable()) {
                this.navigateToTextElementInNearMeasure(direction)
                return
            }

            if (selectedElement && selectedElement.isTextBase()) {
                interaction.nudge(direction, quickly)
            } else if (selectedElement && selectedElement.hasGrips() && interaction.isGripEditStarted()) {
                interaction.nudgeAnchors(direction)
            } else {
                if (this.score().selection().isNone()) {
                    interaction.selectFirstElement(false)
                }
                interaction.moveSelection(direction, quickly ? MoveSelectionType.Measure : MoveSelectionType.Chord)
                playChord = true
            }
            break
        case MoveDirection.Undefined:
            break
        }

        this.seekAndPlaySelectedElement(playChord)
    }

    private moveInputNotes(up: boolean, mode: UpDownMode): void {
        this.noteInput().setRestMode(false)
        this.noteInput().moveInputNotes(up, mode)

        if (this.isPlayPreviewNotesInInputByDuration) {
            this.playInputNotes()
        }
    }

    private movePitchDiatonic(direction: MoveDirection): void {
        const noteInput = this.noteInput()
        if (noteInput.isNoteInputMode() && noteInput.usingNoteInputMethod(NoteEntryMethod.BY_DURATION)) {
            this.moveInputNotes(direction === MoveDirection.Up, UpDownMode.DIATONIC)
            return
        }

        this.interaction().movePitch(direction, UpDownMode.DIATONIC)
        this.seekAndPlaySelectedElement(true)
    }

    private moveWithinChord(direction: MoveDirection): void {
        this.interaction().moveChordNoteSelection(direction)
        this.seekAndPlaySelectedElement(DONT_PLAY_CHORD)
    }

    private selectTopOrBottomOfChord(direction: MoveDirection): void {
        this.interaction().selectTopOrBottomOfChord(direction)
        this.seekAndPlaySelectedElement(DONT_PLAY_CHORD)
    }

    private changeVoice(voiceIndex: voice_idx_t): void {
        const interaction = this.interaction()
        const noteInput = this.noteInput()

        if (this.score().selection().isNone()) {
            if (!noteInput.isNoteInputMode() && !this.startNoteInputAllowed()) {
                return
            }

            this.startNoteInput()
        }

        noteInput.setCurrentVoice(voiceIndex)

        if (!noteInput.isNoteInputMode()) {
            interaction.changeSelectedElementsVoice(voiceIndex)
        }
    }

    private addTie(): void {
        const noteInput = this.noteInput()
        if (noteInput.isNoteInputMode()) {
            noteInput.addTie()
            this.seekAndPlaySelectedElement(true)
        } else {
            this.interaction().addTieToSelection()
        }
    }

    private chordTie(): void {
        const noteInput = this.noteInput()
        if (noteInput.isNoteInputMode()) {
            noteInput.addTie() // C++ NotationNoteInput::addTie() is also used for chord-tie in note input
            this.seekAndPlaySelectedElement(true)
        } else {
            this.interaction().addTiedNoteToChord()
        }
    }

    // ---------------------------------------------------------------------------------
    // enabled conditions
    // ---------------------------------------------------------------------------------

    /** C++ also requires the notation (or the note input toolbar) to have the focus */
    startNoteInputAllowed(): boolean {
        return !this.isEditingElement()
    }

    private startNoteInput(): void {
        this.noteInput().startNoteInput(this.defaultNoteInputMethod)
    }

    isNoteInputMode(): boolean { return this.noteInput().isNoteInputMode() }
    hasSelection(): boolean { return !this.score().selection().isNone() }
    toggleConcertPitch(): void {
        const toggle = !this.score().style().styleB(Sid.concertPitch)

        const actionName = toggle
            ? new TranslatableString('undoableAction', 'Display concert pitch')
            : new TranslatableString('undoableAction', 'Display transposed')

        this.interaction().undoStack().prepareChanges(actionName)
        // NotationStyle::setStyleValue(StyleId::concertPitch)
        this.score().cmdConcertPitchChanged(toggle)
        this.interaction().undoStack().commitChanges()
    }

    canUndo(): boolean { return this.interaction().undoStack().canUndo() }
    canRedo(): boolean { return this.interaction().undoStack().canRedo() }

    private isEditingElement(): boolean { return this.interaction().isEditingElement() }

    private isToggleVisibleAllowed(): boolean {
        return !this.interaction().isTextEditingStarted()
    }

    private measureNavigationAvailable(): boolean {
        return !this.isEditingElement() || this.textNavigationAvailable()
    }

    private noteInputActionAllowed(): boolean {
        if (!this.isNoteInputMode() && !this.startNoteInputAllowed()) {
            return false
        }

        return !this.isTablatureStaff()
    }

    private isTablatureStaff(): boolean {
        return this.score().inputState().staffGroup() === StaffGroup.TAB
    }

    // ---------------------------------------------------------------------------------
    // checked states (NoteInputBarModel::updateState)
    // ---------------------------------------------------------------------------------

    isActionChecked(code: string): boolean {
        if (!this.score().parts().length) { // C++ isInputAllowed()
            return false
        }

        if (code === 'concert-pitch') { // NotationStatusBarModel::updateConcertPitchItem
            return this.score().style().styleB(Sid.concertPitch)
        }

        const is = this.score().inputState()

        if (code === 'note-input') {
            return this.isNoteInputMode()
        }

        const method = NOTE_INPUT_METHOD_ACTIONS.get(code)
        if (method !== undefined) {
            return this.isNoteInputMode() && is.noteEntryMethod() === method
        }

        const dots = DOT_ACTIONS.get(code)
        if (dots !== undefined) {
            return is.duration().dots() === dots
        }

        const durationType = DURATION_ACTIONS.get(code)
        if (durationType !== undefined) {
            return this.resolveCurrentDurationType() === durationType
        }

        const accidentalType = ACCIDENTAL_ACTIONS.get(code)
        if (accidentalType !== undefined) {
            return is.accidentalType() === accidentalType
        }

        const articulation = ARTICULATION_ACTIONS.get(code)
        if (articulation !== undefined) {
            return this.resolveCurrentArticulations().has(articulation)
        }

        const voice = VOICE_ACTIONS.get(code)
        if (voice !== undefined) {
            return this.resolveCurrentVoiceIndex() === voice
        }

        switch (code) {
        case 'tie': {
            const tiedNotes = this.score().cmdTieNoteList(this.score().selection(), false)
            let checked = tiedNotes.length > 0
            for (const note of tiedNotes) {
                if (!note.tieFor() || note.laissezVib()) {
                    checked = false
                    break
                }
            }
            return checked
        }
        case 'pad-rest':
            return this.resolveRestSelected()
        case 'add-slur':
            return !!is.slur()
        case 'lv':
            return this.resolveLvChecked()
        default:
            return false
        }
    }

    private resolveCurrentVoiceIndex(): number {
        const INVALID_VOICE = -1

        if (this.isNoteInputMode()) {
            return this.score().inputState().voice()
        }

        const selection = this.score().selection()
        if (selection.isNone()) {
            return INVALID_VOICE
        }

        const selectedElements = selection.elements()
        if (!selectedElements.length) {
            return INVALID_VOICE
        }

        let voice = INVALID_VOICE
        for (const element of selectedElements) {
            if (element.hasVoiceAssignmentProperties()) {
                const voiceAssignment = element.getProperty(Pid.VOICE_ASSIGNMENT)
                if (voiceAssignment === VoiceAssignment.ALL_VOICE_IN_INSTRUMENT || voiceAssignment === VoiceAssignment.ALL_VOICE_IN_STAFF) {
                    return INVALID_VOICE
                }
            }
            const elementVoice = element.voice()
            if (elementVoice !== voice && voice !== INVALID_VOICE) {
                return INVALID_VOICE
            }

            voice = element.voice()
        }

        return voice
    }

    private resolveRestSelected(): boolean {
        if (this.isNoteInputMode()) {
            return this.score().inputState().rest()
        }

        const selection = this.score().selection()
        if (selection.isNone() || selection.isRange()) {
            return false
        }

        return selection.elements().every(e => e.isRest())
    }

    private resolveCurrentDurationType(): DurationType {
        const INVALID_DURATION_TYPE = DurationType.V_INVALID

        if (this.isNoteInputMode()) {
            return this.score().inputState().duration().type()
        }

        const selection = this.score().selection()
        if (selection.isNone() || selection.isRange()) {
            return INVALID_DURATION_TYPE
        }

        const selectedElements = selection.elements()
        if (!selectedElements.length) {
            return INVALID_DURATION_TYPE
        }

        let result = INVALID_DURATION_TYPE
        let isFirstElement = true
        for (const element of selectedElements) {
            const chordRest = elementToChordRest(element)
            if (!chordRest) {
                continue
            }

            if (isFirstElement) {
                result = chordRest.durationType().type()
                isFirstElement = false
            } else if (result !== chordRest.durationType().type()) {
                return INVALID_DURATION_TYPE
            }
        }

        return result
    }

    /** C++ addMeasures(actionData, target) with the number of measures (the app asks for it) */
    addMeasures(count: number, target: AddBoxesTarget): void {
        this.addBoxes(BoxType.Measure, count, target)
    }

    private addBoxes(boxType: BoxType, count: number, target: AddBoxesTarget): void {
        this.interaction().addBoxes(boxType, count, target)
    }

    private selectAllSimilarElements(): void {
        const notationElements = this.currentNotationElements()
        const interaction = this.interaction()

        const selectedElement = this.score().selection().element()
        if (!selectedElement) {
            return
        }

        const options = this.elementsFilterOptions(selectedElement)
        const elements = notationElements.elements(options)
        if (elements.length === 0) {
            return
        }

        interaction.clearSelection()

        interaction.select(elements, SelectType.ADD)
    }

    private selectAllSimilarElementsInStaff(): void {
        const notationElements = this.currentNotationElements()
        const interaction = this.interaction()

        const selectedElement = this.score().selection().element()
        if (!selectedElement) {
            return
        }

        const options = this.elementsFilterOptions(selectedElement)
        options.staffStart = selectedElement.staffIdx()
        options.staffEnd = options.staffStart + 1

        const elements = notationElements.elements(options)
        if (elements.length === 0) {
            return
        }

        interaction.clearSelection()

        interaction.select(elements, SelectType.ADD)
    }

    private selectAllSimilarElementsInRange(): void {
        const lastHit = this.interaction().lastElementHit()
        if (!lastHit) {
            return
        }

        const score = this.score()
        score.selectSimilarInRange(lastHit)
        if (score.selectionChanged()) {
            this.interaction().notifyAboutSelectionChangedIfNeed()
        }
    }

    /** C++ currentNotationElements() */
    private currentNotationElements(): NotationElements {
        return new NotationElements(this.score())
    }

    private elementsFilterOptions(element: EngravingItem): FilterElementsOptions {
        const options = new FilterElementsOptions()
        options.elementType = element.type()

        if (element.isNote()) {
            const note = element as unknown as Note
            if (note.chord().isGrace()) {
                options.subtype = -1
            } else {
                options.subtype = element.subtype()
            }
        } else if (element.isHairpinSegment() || element.isHarmony()) {
            options.subtype = element.subtype()
            options.bySubtype = true
        }

        return options
    }

    /** C++ registerAction(code, handler, PlayMode): the handler, then seekSelectedElement and playSelectedElement */
    private withPlayMode(playMode: PlayMode, handler: () => void): void {
        handler()

        this.seekSelectedElement()

        if (playMode !== PlayMode.NoPlay) {
            this.playSelectedElement(playMode === PlayMode.PlayChord)
        }
    }

    private registerAction(code: string, run: () => void, enabled?: () => boolean): void {
        this.m_actions.set(code, { run, enabled })
    }

    private registerNoteAction(code: string, noteName: NoteName, addingMode: NoteAddingMode): void {
        this.registerAction(code, () => this.handleNoteAction(noteName, addingMode), () => this.noteInputActionAllowed())
    }

    // =================================================================================================================
    //   copy/paste, text editing and element editing actions
    // =================================================================================================================

    private initEditingActions(): void {
        this.registerAction('action://notation/copy', () => this.interaction().copySelection(), () => this.hasSelection())
        this.registerAction('action://notation/cut', () => this.cutSelection(), () => this.hasSelection())
        this.registerAction('action://notation/paste', () => this.pasteSelection(PastingType.Default))
        this.registerAction('notation-paste-half', () => this.pasteSelection(PastingType.Half))
        this.registerAction('notation-paste-double', () => this.pasteSelection(PastingType.Double))
        this.registerAction('notation-paste-special', () => this.pasteSelection(PastingType.Special))
        this.registerAction('notation-swap', () => this.interaction().swapSelection(), () => this.hasSelection())
        this.registerAction('repeat-sel', () => {
            this.interaction().repeatSelection()
            this.seekAndPlaySelectedElement(true)
        })

        this.registerAction('next-text-element', () => this.navigateToTextElement(MoveDirection.Right, NEAR_NOTE_OR_REST),
            () => this.textNavigationAvailable())
        this.registerAction('prev-text-element', () => this.navigateToTextElement(MoveDirection.Left, NEAR_NOTE_OR_REST),
            () => this.textNavigationAvailable())
        this.registerAction('next-word', () => this.navigateToTextElement(MoveDirection.Right, NEAR_NOTE_OR_REST, false),
            () => this.textNavigationAvailable())
        this.registerAction('next-beat-TEXT', () => this.navigateToTextElement(MoveDirection.Right),
            () => this.textNavigationByBeatsAvailable())
        this.registerAction('prev-beat-TEXT', () => this.navigateToTextElement(MoveDirection.Left),
            () => this.textNavigationByBeatsAvailable())

        this.registerAction('next-lyric-verse', () => this.interaction().navigateToLyricsVerse(MoveDirection.Down), () => this.isEditingLyrics())
        this.registerAction('prev-lyric-verse', () => this.interaction().navigateToLyricsVerse(MoveDirection.Up), () => this.isEditingLyrics())
        this.registerAction('next-syllable', () => this.interaction().navigateToNextSyllable(), () => this.isEditingLyrics())
        this.registerAction('add-melisma', () => this.interaction().addMelisma(), () => this.isEditingLyrics())
        this.registerAction('add-lyric-verse', () => this.interaction().addLyricsVerse(), () => this.isEditingLyrics())

        const TEXT_ACTIONS: [string, TextStyleType][] = [
            ['title-text', TextStyleType.TITLE],
            ['subtitle-text', TextStyleType.SUBTITLE],
            ['composer-text', TextStyleType.COMPOSER],
            ['poet-text', TextStyleType.LYRICIST],
            ['part-text', TextStyleType.INSTRUMENT_EXCERPT],
            ['frame-text', TextStyleType.FRAME],
            ['system-text', TextStyleType.SYSTEM],
            ['staff-text', TextStyleType.STAFF],
            ['expression-text', TextStyleType.EXPRESSION],
            ['rehearsalmark-text', TextStyleType.REHEARSAL_MARK],
            ['instrument-change-text', TextStyleType.INSTRUMENT_CHANGE],
            ['sticking-text', TextStyleType.STICKING],
            ['fingering-text', TextStyleType.FINGERING],
            ['chord-text', TextStyleType.HARMONY_A],
            ['roman-numeral-text', TextStyleType.HARMONY_ROMAN],
            ['nashville-number-text', TextStyleType.HARMONY_NASHVILLE],
            ['lyrics', TextStyleType.LYRICS_ODD],
            ['tempo', TextStyleType.TEMPO],
        ]
        for (const [code, type] of TEXT_ACTIONS) {
            this.registerAction(code, () => this.addText(type))
        }

        this.registerAction('figured-bass', () => this.interaction().addFiguredBass())

        this.registerAction('edit-element', () => this.startEditSelectedElement())
        this.registerAction('edit-text', () => this.startEditSelectedText())

        this.registerAction('text-b', () => this.interaction().toggleBold(), () => this.isEditingText())
        this.registerAction('text-i', () => this.interaction().toggleItalic(), () => this.isEditingText())
        this.registerAction('text-u', () => this.interaction().toggleUnderline(), () => this.isEditingText())
        this.registerAction('text-s', () => this.interaction().toggleStrike(), () => this.isEditingText())
        this.registerAction('text-sub', () => this.interaction().toggleSubScript(), () => this.isEditingText())
        this.registerAction('text-sup', () => this.interaction().toggleSuperScript(), () => this.isEditingText())
    }

    private cutSelection(): void {
        const interaction = this.interaction()
        interaction.copySelection()
        interaction.deleteSelection()
    }

    private pasteSelection(type: PastingType): void {
        const scale = this.resolvePastingScale(type)
        this.interaction().pasteSelection(scale)
        this.seekAndPlaySelectedElement(DONT_PLAY_CHORD)
    }

    private resolvePastingScale(type: PastingType): Fraction {
        const DEFAULT_SCALE = new Fraction(1, 1)

        switch (type) {
        case PastingType.Default: return DEFAULT_SCALE
        case PastingType.Half: return new Fraction(1, 2)
        case PastingType.Double: return new Fraction(2, 1)
        case PastingType.Special: {
            let scale = DEFAULT_SCALE
            const duration = this.noteInput().state().duration().fraction()

            if (duration.isValid() && !duration.isZero()) {
                scale = duration.times(4).reduced()
            }

            return scale
        }
        }

        return DEFAULT_SCALE
    }

    private addText(type: TextStyleType): void {
        const interaction = this.interaction()

        let item: EngravingItem | null = null

        const sel = this.score().selection()
        if (sel.isRange()) {
            const startSegment = sel.startSegment()
            item = startSegment ? startSegment.firstElementForNavigation(sel.staffStart()) : null
        } else {
            item = interaction.contextItem()
        }

        if (isVerticalBoxTextStyle(type)) {
            if (!item || !item.isVBox()) {
                interaction.addTextToTopFrame(type)
                return
            }
        }

        interaction.addTextToItem(type, item)
    }

    private startEditSelectedElement(cursorPos: PointF = new PointF()): void {
        const interaction = this.interaction()
        const element = this.score().selection().element()
        if (!element) {
            return
        }

        // TODO(port): instrument names (staff properties dialog), element popups, header/footer texts (style dialog)

        if (interaction.textEditingAllowed(element)) {
            interaction.startEditText(element, cursorPos)
        } else {
            interaction.startEditElement(element)
        }
    }

    private startEditSelectedText(cursorPos: PointF = new PointF()): void {
        const interaction = this.interaction()
        const element = this.score().selection().element()

        if (interaction.textEditingAllowed(element)) {
            interaction.startEditText(element, cursorPos)
        }
    }

    private navigateToTextElement(direction: MoveDirection, nearNoteOrRest = false, moveOnly = true): void {
        const element = this.score().selection().element()
        if (!element) {
            return
        }

        if (element.isLyrics()) {
            this.interaction().navigateToLyricsDirection(direction, moveOnly)
        } else if (element.isHarmony()) {
            const chordSymbol = this.editedChordSymbol()

            // otherwise, chord symbol will be deleted when navigating away from it
            const canPlay = !!chordSymbol && chordSymbol.harmonyName() !== ''

            this.interaction().navigateToNearHarmony(direction, nearNoteOrRest)

            if (canPlay) {
                playbackController()?.playElements([chordSymbol!])
            }
        } else {
            // TODO(port): figured bass, navigateToNearText (fingering, sticking)
        }
    }

    private navigateToTextElementInNearMeasure(direction: MoveDirection): void {
        const element = this.score().selection().element()
        if (!element) {
            return
        }

        if (element.isHarmony()) {
            const chordSymbol = this.editedChordSymbol()

            // otherwise, chord symbol will be deleted when navigating away from it
            const canPlay = !!chordSymbol && chordSymbol.harmonyName() !== ''

            this.interaction().navigateToHarmonyInNearMeasure(direction)

            if (canPlay) {
                playbackController()?.playElements([chordSymbol!])
            }
        }
        // TODO(port): figured bass
    }

    private editedChordSymbol(): Harmony | null {
        const text = this.interaction().editedText()
        if (!text || !text.isHarmony()) {
            return null
        }

        return text as unknown as Harmony
    }

    isEditingText(): boolean {
        return this.interaction().isTextEditingStarted()
    }

    isEditingLyrics(): boolean {
        const interaction = this.interaction()
        const e = this.score().selection().element()
        return interaction.isTextEditingStarted() && !!e && e.isLyrics()
    }

    textNavigationAvailable(): boolean {
        return this.resolveTextNavigationAvailable(TextNavigationType.NearNoteOrRest)
    }

    private textNavigationByBeatsAvailable(): boolean {
        return this.resolveTextNavigationAvailable(TextNavigationType.NearBeat)
    }

    private resolveTextNavigationAvailable(type: TextNavigationType): boolean {
        if (!this.isEditingText()) {
            return false
        }

        const allowedElementsForTextNavigation = [
            ElementType.LYRICS, ElementType.HARMONY, ElementType.FIGURED_BASS, ElementType.STICKING, ElementType.FINGERING,
        ]
        const allowedElementsForBeatsNavigation = [ElementType.HARMONY]
        const allowedElementsForFractionNavigation = [ElementType.HARMONY, ElementType.FIGURED_BASS]

        const element = this.score().selection().element()
        const elementType = element ? element.type() : ElementType.INVALID

        switch (type) {
        case TextNavigationType.NearNoteOrRest:
            return allowedElementsForTextNavigation.includes(elementType)
        case TextNavigationType.NearBeat:
            return allowedElementsForBeatsNavigation.includes(elementType)
        case TextNavigationType.Fraction:
            return allowedElementsForFractionNavigation.includes(elementType)
        }

        return false
    }

    // =================================================================================================================
    //   note input methods, tuplets, slurs, lines, grace notes, beams, intervals (section of the note input port)
    // =================================================================================================================

    private m_midiInput: NotationMidiInput | null = null

    /** C++ currentNotationMidiInput() (the Notation owns it in C++) */
    midiInput(): NotationMidiInput {
        this.m_midiInput ??= new NotationMidiInput(() => this.score(), this.interaction(), this.interaction().undoStack(), code => this.dispatch(code))
        return this.m_midiInput
    }

    private initNoteInputActions(): void {
        this.registerAction('realtime-advance', () => this.realtimeAdvance(), () => this.isNoteInputMode())
        this.registerAction('toggle-insert-mode', () => this.toggleNoteInputInsert(), () => !this.isEditingElement())

        for (const [code, n] of TUPLET_ACTIONS) {
            this.registerAction(code, () => this.putTupletCount(n), () => this.noteOrRestSelected())
        }
        // "custom-tuplet" (TupletOptions as action data): putTuplet(); "tuplet-dialog" (TupletDialog) is registered by
        // the app, which shows the dialog

        this.registerAction('add-slur', () => this.addSlur())

        this.registerAction('add-8va', () => this.interaction().addOttavaToSelection(OttavaType.OTTAVA_8VA))
        this.registerAction('add-8vb', () => this.interaction().addOttavaToSelection(OttavaType.OTTAVA_8VB))
        this.registerAction('add-hairpin', () => this.interaction().addHairpinsToSelection(HairpinType.CRESC_HAIRPIN),
            () => this.noteOrRestSelected())
        this.registerAction('add-hairpin-reverse', () => this.interaction().addHairpinsToSelection(HairpinType.DIM_HAIRPIN),
            () => this.noteOrRestSelected())

        for (const [code, type] of GRACE_NOTE_ACTIONS) {
            this.registerAction(code, () => this.interaction().addGraceNotesToSelectedNotes(type))
        }

        for (const [code, mode] of BEAM_ACTIONS) {
            this.registerAction(code, () => this.interaction().addBeamToSelectedChordRests(mode))
        }

        this.registerAction('full-measure-rest', () => this.interactionExecute(() => this.score().cmdFullMeasureRest(),
            new TranslatableString('undoableAction', 'Enter full-measure rest')))
        this.registerAction('set-visible', () => this.interactionExecute(() => this.score().cmdSetVisible(),
            new TranslatableString('undoableAction', 'Make element(s) visible')))
        this.registerAction('unset-visible', () => this.interactionExecute(() => this.score().cmdUnsetVisible(),
            new TranslatableString('undoableAction', 'Make element(s) invisible')))

        for (const [code, id] of ARTICULATION_ACTIONS) {
            this.registerAction(code, () => this.toggleArticulation(id))
        }
        this.registerAction('add-up-bow', () => this.interaction().toggleArticulation(SymId.stringsUpBow))
        this.registerAction('add-down-bow', () => this.interaction().toggleArticulation(SymId.stringsDownBow))
        this.registerAction('lv', () => this.addLaissezVib())

        for (let i = MIN_NOTES_INTERVAL; i <= MAX_NOTES_INTERVAL; ++i) {
            if (isNotesIntervalValid(i)) {
                this.registerAction(`interval${i}`, () => this.withPlayMode(PlayMode.PlayChord, () => this.interaction().addIntervalToSelectedNotes(i)))
            }
        }
    }

    /** C++ Interaction::execute(&Score::f, actionName) */
    private interactionExecute(f: () => void, actionName: TranslatableString): void {
        this.interaction().startEdit(actionName)
        f()
        this.interaction().apply()
    }

    private realtimeAdvance(): void {
        this.midiInput().onRealtimeAdvance()
    }

    private toggleNoteInputInsert(): void {
        if (!this.noteInput().usingNoteInputMethod(NoteEntryMethod.TIMEWISE)) {
            this.toggleNoteInputMethod(NoteEntryMethod.TIMEWISE)
        } else {
            this.toggleNoteInputMethod(NoteEntryMethod.BY_NOTE_NAME)
        }
    }

    /** C++ putTuplet(const TupletOptions&) */
    putTuplet(options: TupletOptions): void {
        const interaction = this.interaction()
        const noteInput = this.noteInput()

        if (!interaction.canAddTupletToSelectedChordRests()) {
            // TODO(port): interactive()->error("Cannot create tuplet", "Note value is too short")
            return
        }

        if (noteInput.isNoteInputMode()) {
            noteInput.addTuplet(options)
        } else {
            interaction.addTupletToSelectedChordRests(options)
        }
    }

    /** C++ putTuplet(int tupletCount) */
    private putTupletCount(tupletCount: number): void {
        const options = new TupletOptions()
        options.ratio = new Fraction(tupletCount, 2)
        options.autoBaseLen = true
        // get the bracket type from score style settings
        const style = this.score().style()
        options.bracketType = style.styleI(Sid.tupletBracketType) as TupletBracketType
        options.numberType = style.styleI(Sid.tupletNumberType) as TupletNumberType

        this.putTuplet(options)
    }

    private addSlur(): void {
        const noteInput = this.noteInput()
        if (noteInput.isNoteInputMode() && noteInput.state().slur()) {
            noteInput.resetSlur()
        } else {
            this.interaction().addSlurToSelection()
        }
    }

    private toggleArticulation(articulationSymbolId: SymId): void {
        const interaction = this.interaction()
        const noteInput = this.noteInput()

        if (this.score().selection().isNone()) {
            if (!noteInput.isNoteInputMode() && !this.startNoteInputAllowed()) {
                return
            }

            this.startNoteInput()
        }

        if (noteInput.isNoteInputMode() && noteInput.addAccidentalDotsArticulationsToNextNoteEntered) {
            noteInput.setArticulation(articulationSymbolId)
        } else {
            interaction.toggleArticulationForSelection(articulationSymbolId)
        }
    }

    private addLaissezVib(): void {
        const noteInput = this.noteInput()
        if (noteInput.isNoteInputMode()) {
            noteInput.addLaissezVib()
            this.seekAndPlaySelectedElement(true)
        } else {
            this.interaction().addLaissezVibToSelection()
        }
    }

    /** NoteInputBarModel::resolveCurrentArticulations */
    private resolveCurrentArticulations(): Set<SymId> {
        if (this.isNoteInputMode()) {
            return splitArticulations(this.score().inputState().articulationIds())
        }

        const selection = this.score().selection()
        if (selection.isNone()) {
            return new Set()
        }

        const chordArticulations = (chord: Chord): Set<SymId> => {
            return splitArticulations(flipArticulations(chord.articulationSymbolIds(), PlacementV.ABOVE))
        }

        let result = new Set<SymId>()
        let isFirstNote = true
        for (const element of selection.elements()) {
            if (!element.isNote()) {
                continue
            }

            const note = element as unknown as Note
            if (isFirstNote) {
                result = chordArticulations(note.chord())
                isFirstNote = false
            } else {
                const currentNoteArticulations = chordArticulations(note.chord())
                result = new Set([...result].filter(id => currentNoteArticulations.has(id)))
            }
        }

        return result
    }

    /** NoteInputBarModel::updateLvState: the selected notes with a tie are laissez vibrer */
    private resolveLvChecked(): boolean {
        const tiedNotes = this.score().selection().noteList().filter(n => n.tieFor())
        return tiedNotes.length > 0 && tiedNotes.every(n => n.laissezVib())
    }

    noteOrRestSelected(): boolean {
        if (this.isNoteInputMode()) {
            return true
        }

        return this.score().selection().elements().some(e => e.type() === ElementType.NOTE || e.type() === ElementType.REST)
    }

    // =================================================================================================================
    //   (end of the note input section)
    // =================================================================================================================
}

/** NoteInputBarModel::elementToChordRest */
function elementToChordRest(element: EngravingItem | null): ChordRest | null {
    return InputState.chordRest(element)
}

enum TextNavigationType {
    NearNoteOrRest,
    NearBeat,
    Fraction,
}

const NEAR_NOTE_OR_REST = true
