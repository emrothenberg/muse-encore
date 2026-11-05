/*
 * SPDX-License-Identifier: GPL-3.0-only
 * MuseEncore — port of MuseScore Studio (https://github.com/musescore/MuseScore)
 * Copyright (C) 2021-2026 MuseScore Limited and others
 *
 * Port of src/notation/internal/notationmidiinput.h/.cpp. The events of a MIDI device arrive with onMidiEventReceived;
 * onNoteOns (not in MuseScore) enters the notes detected from the microphone: they have no note offs, and the notes
 * added to the score are not played (the instrument is heard).
 */

import { TranslatableString } from '../../framework/global/types/translatablestring'
import { MidiEvent, Opcode } from '../../framework/midi/midievent'
import { MODWHEEL_CONTROLLER, SUSTAIN_PEDAL_CONTROLLER } from '../../framework/midi/miditypes'
import { NoteEntryMethod, NoteVal } from '../../engraving/dom/input'
import { scoreDummy } from '../../engraving/compat/dummyelement'
import { Factory } from '../../engraving/dom/factory'
import { ElementType } from '../../engraving/types/types'
import type { Chord } from '../../engraving/dom/chord'
import type { Score } from '../../engraving/dom/score'
import type { Note } from '../../engraving/dom/note'
import type { EngravingItem } from '../../engraving/dom/engravingitem'
import { ControllerChangeType, INFINITE_DURATION, playbackController, type ControllerChangeEvent, type PlayParams } from '../../playback/iplaybackcontroller'
import '../../engraving/editing/edit'
import type { NotationInteraction } from './notationinteraction'
import type { NotationUndoStack } from './notationundostack'

/** C++ NotationConfiguration::delayBetweenNotesInRealTimeModeMilliseconds() (default) */
export const REALTIME_DELAY_MS = 750

const PROCESS_INTERVAL = 20

/** what NotationMidiInput asks NotationConfiguration, the dispatcher and QGuiApplication for (set by the application) */
export interface MidiInputConfiguration {
    startNoteInputAtSelectedNoteRestWhenPressingMidiKey(): boolean
    useMidiVelocityAndDurationDuringNoteInput(): boolean
    isPlayPreviewNotesInInputByDuration(): boolean
    delayBetweenNotesInRealTimeModeMilliseconds(): number
    midiUseWrittenPitch(): boolean
    isMetronomeEnabled(): boolean
    /** C++ dispatcher()->dispatch("metronome") */
    toggleMetronome(): void
    /** C++ QGuiApplication::queryKeyboardModifiers() & Qt::ShiftModifier (a browser can not ask for it) */
    isShiftPressed(): boolean
}

/** the defaults of NotationConfiguration */
let s_configuration: MidiInputConfiguration = {
    startNoteInputAtSelectedNoteRestWhenPressingMidiKey: () => true,
    useMidiVelocityAndDurationDuringNoteInput: () => true,
    isPlayPreviewNotesInInputByDuration: () => true,
    delayBetweenNotesInRealTimeModeMilliseconds: () => REALTIME_DELAY_MS,
    midiUseWrittenPitch: () => true,
    isMetronomeEnabled: () => false,
    toggleMetronome: () => {},
    isShiftPressed: () => false,
}

export function setMidiInputConfiguration(configuration: Partial<MidiInputConfiguration>): void {
    s_configuration = { ...s_configuration, ...configuration }
}

function configuration(): MidiInputConfiguration {
    return s_configuration
}

function makeNoteOnParams(infiniteDuration: boolean): PlayParams {
    return { flushSound: !infiniteDuration, duration: infiniteDuration ? INFINITE_DURATION : undefined, midiEvent: true }
}

function makeNoteOffParams(): PlayParams {
    return { flushSound: false, duration: 0, midiEvent: true }
}

export class NotationMidiInput {
    private m_getScore: () => Score
    private m_notationInteraction: NotationInteraction
    private m_undoStack: NotationUndoStack
    private m_dispatch: (action: string) => void
    private m_eventsQueue: MidiEvent[] = []
    private m_processTimer: ReturnType<typeof setTimeout> | null = null
    private m_realtimeTimer: ReturnType<typeof setInterval> | null = null
    private m_extendNoteTimer: ReturnType<typeof setTimeout> | null = null
    private m_allowRealtimeRests = true
    private m_shouldDisableMetronome = false
    private m_holdingNotesInInputByDuration = false
    /** C++ m_playingNotes: by the pitch of the note */
    private m_playingNotes = new Map<number, { isPreview: boolean; note: Note }>()

    constructor(getScore: () => Score, notationInteraction: NotationInteraction, undoStack: NotationUndoStack, dispatch: (action: string) => void) {
        this.m_getScore = getScore
        this.m_notationInteraction = notationInteraction
        this.m_undoStack = undoStack
        this.m_dispatch = dispatch
    }

    onMidiEventReceived(event: MidiEvent): void {
        const opcode = event.opcode()
        if (opcode === Opcode.NoteOn || opcode === Opcode.NoteOff || opcode === Opcode.ControlChange || opcode === Opcode.PitchBend) {
            this.m_eventsQueue.push(event)

            if (this.m_processTimer === null) {
                this.m_processTimer = setTimeout(() => this.doProcessEvents(), PROCESS_INTERVAL)
            }
        }
    }

    onRealtimeAdvance(): void {
        if (!this.isNoteInputMode()) {
            return
        }

        if (this.isRealtimeManual()) {
            this.m_allowRealtimeRests = true
            this.enableMetronome()
            this.doRealtimeAdvance()
        } else if (this.isRealtimeAuto()) {
            if (this.isRealtimeTimerActive()) {
                this.stopRealtime()
                this.disableMetronome()
            } else {
                this.m_allowRealtimeRests = true
                this.enableMetronome()
                this.runRealtime()
            }
        }
    }

    /** the timer of the automatic real-time mode runs */
    isRealtimeTimerActive(): boolean {
        return this.m_realtimeTimer !== null
    }

    private score(): Score {
        return this.m_getScore()
    }

    private doProcessEvents(): void {
        const events = this.m_eventsQueue
        this.m_eventsQueue = []
        this.m_processTimer = null

        const sc = this.score()
        if (!events.length || !sc || sc.nstaves() === 0) {
            return
        }

        const notesOn: Note[] = []
        const notesOff: number[] = []
        const controllers = new Map<Opcode, MidiEvent>()

        this.startNoteInputIfNeed(events)
        const isNoteInput = this.isNoteInputMode()
        const isSoundPreview = !isNoteInput

        if (isNoteInput && this.isInputByDuration()) {
            this.addNoteEventsToInputState(events)
            return
        }

        const useDurationAndVelocity = isSoundPreview || configuration().useMidiVelocityAndDurationDuringNoteInput()

        events.forEach((event, i) => {
            const opcode = event.opcode()

            if (opcode === Opcode.ControlChange || opcode === Opcode.PitchBend) {
                controllers.set(opcode, event) // keep only last received to prevent spam
                return
            }

            const note = isNoteInput ? this.addNoteToScore(event) : this.makePreviewNote(event)
            if (note) {
                if (useDurationAndVelocity) {
                    note.setUserVelocity(event.velocity7())
                    this.m_playingNotes.set(note.pitch(), { isPreview: isSoundPreview, note })
                }
                notesOn.push(note)
            }

            const chord = i !== 0
            const noteOn = opcode === Opcode.NoteOn
            if (!chord && noteOn && !this.isRealtimeTimerActive() && this.isRealtimeAuto()) {
                this.startExtendNoteTimer()
                this.enableMetronome()
                this.doRealtimeAdvance()
            }

            const noteOff = opcode === Opcode.NoteOff
            if (useDurationAndVelocity && noteOff) {
                notesOff.push(event.note())
            }
        })

        if (controllers.size) {
            this.triggerControllers(controllers)
        }

        if (notesOn.length) {
            if (isNoteInput) {
                playbackController()?.seekElement(notesOn[0], !useDurationAndVelocity /*flushSound*/)
            }

            playbackController()?.playElements(notesOn as unknown as EngravingItem[], makeNoteOnParams(useDurationAndVelocity), true)
        }

        if (notesOff.length) {
            this.releasePlayingNotes(notesOff)
        }

        if (isNoteInput) {
            this.m_notationInteraction.notifyAboutNotationChanged()
        }
    }

    private startNoteInputIfNeed(events: readonly MidiEvent[]): void {
        if (this.isNoteInputMode()) {
            return
        }

        if (configuration().startNoteInputAtSelectedNoteRestWhenPressingMidiKey()) {
            if (this.score().selection().elementsSelected([ElementType.NOTE, ElementType.REST])
                && events.some(e => e.opcode() === Opcode.NoteOn)) {
                this.m_dispatch('note-input')
            }
        }
    }

    private addNoteEventsToInputState(events: readonly MidiEvent[]): void {
        const noteInput = this.m_notationInteraction.noteInput()
        const state = noteInput.state()
        const staffIdx = state.staffIdx()
        const useWrittenPitch = configuration().midiUseWrittenPitch()
        const playPreviewNotes = configuration().isPlayPreviewNotesInInputByDuration()
        const useVelocityAndDuration = playPreviewNotes && configuration().useMidiVelocityAndDurationDuringNoteInput()

        let notesOn: NoteVal[] = []
        const notesOff: NoteVal[] = []

        if (this.m_holdingNotesInInputByDuration) {
            notesOn = [...state.notes()]
        }

        const controllers = new Map<Opcode, MidiEvent>()

        for (const event of events) {
            const opcode = event.opcode()

            if (opcode === Opcode.NoteOn) {
                const nval = this.score().noteVal(event.note(), staffIdx, useWrittenPitch)
                nval.velocityOverride = event.velocity7()
                notesOn.push(nval)
                this.m_holdingNotesInInputByDuration = true
            } else if (opcode === Opcode.NoteOff) {
                if (useVelocityAndDuration) {
                    notesOff.push(this.score().noteVal(event.note(), staffIdx, useWrittenPitch))
                }
                this.m_holdingNotesInInputByDuration = false
            } else if (opcode === Opcode.ControlChange || opcode === Opcode.PitchBend) {
                if (playPreviewNotes) {
                    controllers.set(opcode, event) // keep only last received to prevent spam
                }
            }
        }

        if (controllers.size) {
            this.triggerControllers(controllers)
        }

        const segment = state.segment()
        if (notesOff.length && segment) {
            playbackController()?.playNotes(notesOff, staffIdx, segment, makeNoteOffParams())
        }

        const current = state.notes()
        if (notesOn.length && !(notesOn.length === current.length && notesOn.every((n, i) => n.equals(current[i])))) {
            noteInput.setRestMode(false)
            noteInput.setInputNotes(notesOn)

            if (playPreviewNotes && segment) {
                playbackController()?.playNotes(notesOn, staffIdx, segment, makeNoteOnParams(useVelocityAndDuration))
            }
            this.m_notationInteraction.notifyAboutNotationChanged()
        }
    }

    private addNoteToScore(e: MidiEvent): Note | null {
        const sc = this.score()
        const pitch = e.note()

        const active = sc.activeMidiPitches()
        for (let i = active.length - 1; i >= 0; --i) {
            if (active[i].pitch === pitch) {
                active.splice(i, 1)
            }
        }

        const is = sc.inputState()
        if (!is.noteEntryMode() || !is.isValid()) {
            return null
        }

        this.m_undoStack.prepareChanges(new TranslatableString('undoableAction', 'Enter note'))
        let note: Note | null = null
        try {
            if (e.opcode() === Opcode.NoteOff) {
                if (this.isRealtime()) {
                    const cr = is.cr()
                    const n = cr?.isChord() ? (cr as unknown as Chord).findNote(pitch) : null
                    if (n) {
                        sc.deleteItem(n.tieBack())
                        sc.deleteItem(n)
                    }
                }
                return null
            }

            let chord = active.length !== 0

            // holding shift while inputting midi will add the new pitch to the prior existing chord
            if (configuration().isShiftPressed()) {
                const cr = is.lastSegment()?.element(is.track())
                if (cr && cr.isChord()) {
                    chord = true
                }
            }

            note = sc.addMidiPitch(pitch, chord, configuration().midiUseWrittenPitch())

            active.push({ pitch, chord, velocity: e.velocity7() })
        } finally {
            this.m_undoStack.commitChanges()
        }

        const cr = is.cr()
        if (cr) {
            this.m_notationInteraction.showItem(cr)
        }

        return note
    }

    private makePreviewNote(e: MidiEvent): Note | null {
        if (e.opcode() === Opcode.NoteOff) {
            return null
        }

        const score = this.score()
        const inputState = score.inputState()
        const seg = inputState.lastSegment() ?? scoreDummy(score).segment()

        const chord = Factory.createItem(ElementType.CHORD, seg) as unknown as Chord
        chord.setParent(seg)

        const cr = inputState.cr()
        const staffIdx = cr ? cr.staffIdx() : 0
        // C++ sets the staff of the note only: the sound of the note is found through the chord here
        chord.setStaffIdx(staffIdx)

        const note = Factory.createItem(ElementType.NOTE, chord) as unknown as Note
        note.setParent(chord)
        note.setStaffIdx(staffIdx)

        note.setNval(score.noteVal(e.note(), staffIdx, configuration().midiUseWrittenPitch()))

        return note
    }

    private triggerControllers(events: ReadonlyMap<Opcode, MidiEvent>): void {
        const controllers: ControllerChangeEvent[] = []

        for (const [opcode, e] of events) {
            if (opcode === Opcode.PitchBend) {
                controllers.push({ type: ControllerChangeType.PitchBend, val: e.pitchBend14() / 16383 })
            } else if (e.index() === MODWHEEL_CONTROLLER) {
                controllers.push({ type: ControllerChangeType.Modulation, val: e.data() / 127 })
            } else if (e.index() === SUSTAIN_PEDAL_CONTROLLER) {
                controllers.push({ type: ControllerChangeType.SustainPedalOnOff, val: e.data() / 127 })
            }
        }

        const is = this.score().inputState()
        playbackController()?.triggerControllers(controllers, is.staffIdx(), is.tick().ticks())
    }

    private releasePlayingNotes(pitches: readonly number[]): void {
        const notesOff: Note[] = []

        const staffIdx = this.score().inputState().staffIdx()
        const useWrittenPitch = configuration().midiUseWrittenPitch()

        for (const pitch of pitches) {
            const nval = this.score().noteVal(pitch, staffIdx, useWrittenPitch)

            const playing = this.m_playingNotes.get(nval.pitch)
            if (!playing) {
                continue
            }

            playing.note.setUserVelocity(0)
            notesOff.push(playing.note)
            this.m_playingNotes.delete(nval.pitch)
        }

        playbackController()?.playElements(notesOff as unknown as EngravingItem[], makeNoteOffParams(), true)
    }

    private enableMetronome(): void {
        if (configuration().isMetronomeEnabled()) {
            return
        }

        configuration().toggleMetronome()
        this.m_shouldDisableMetronome = true
    }

    private disableMetronome(): void {
        if (!this.m_shouldDisableMetronome) {
            return
        }

        configuration().toggleMetronome()
        this.m_shouldDisableMetronome = false
    }

    private runRealtime(): void {
        this.stopRealtime()
        this.m_realtimeTimer = setInterval(() => this.doRealtimeAdvance(), configuration().delayBetweenNotesInRealTimeModeMilliseconds())
    }

    stopRealtime(): void {
        if (this.m_realtimeTimer !== null) {
            clearInterval(this.m_realtimeTimer)
            this.m_realtimeTimer = null
        }
    }

    private startExtendNoteTimer(): void {
        if (this.m_extendNoteTimer !== null) {
            clearTimeout(this.m_extendNoteTimer)
        }
        this.m_extendNoteTimer = setTimeout(() => {
            this.m_extendNoteTimer = null
            this.doExtendCurrentNote()
        }, configuration().delayBetweenNotesInRealTimeModeMilliseconds())
    }

    private doRealtimeAdvance(): void {
        if (!this.isRealtime() || !this.isNoteInputMode() || (!this.m_allowRealtimeRests && this.score().activeMidiPitches().length === 0)) {
            if (this.isRealtimeTimerActive()) {
                this.stopRealtime()
            }

            this.disableMetronome()

            this.m_allowRealtimeRests = true
            return
        }

        const is = this.score().inputState()
        playbackController()?.playMetronome(is.tick().ticks())

        setTimeout(() => {
            // C++ advances here even after the end of the note input (then Score::realtimeAdvance does nothing)
            if (!this.isNoteInputMode()) {
                return
            }
            this.m_undoStack.prepareChanges(new TranslatableString('undoableAction', 'Realtime advance'))
            this.score().realtimeAdvance(configuration().midiUseWrittenPitch())
            this.m_undoStack.commitChanges()
            this.m_notationInteraction.notifyAboutNotationChanged()
        }, 100)

        if (this.isRealtimeManual()) {
            const metronomeDuration = 500
            setTimeout(() => this.disableMetronome(), metronomeDuration)
        }
    }

    private doExtendCurrentNote(): void {
        if (!this.isNoteInputMode() || this.isRealtimeTimerActive()) {
            return
        }

        this.m_allowRealtimeRests = false
        this.runRealtime()
        this.doRealtimeAdvance()
    }

    /**
     * the notes detected from the microphone (not in MuseScore): notes played together (the first one starts a new
     * chord, the others are added to it); returns the notes added. Only in note input mode.
     */
    onNoteOns(pitches: readonly number[]): Note[] {
        const sc = this.score()
        if (!sc || sc.nstaves() === 0 || !pitches.length || !this.isNoteInputMode()) {
            return []
        }

        if (this.isInputByDuration()) {
            const noteInput = this.m_notationInteraction.noteInput()
            const staffIdx = noteInput.state().staffIdx()
            noteInput.setRestMode(false)
            const notes = pitches.map(p => sc.noteVal(p, staffIdx, false))
            noteInput.setInputNotes(notes)
            const segment = noteInput.state().segment()
            if (segment) {
                playbackController()?.playNotes(notes, staffIdx, segment)
            }
            return []
        }

        const is = sc.inputState()
        const notesOn: Note[] = []
        pitches.forEach((pitch, i) => {
            if (!is.noteEntryMode() || !is.isValid()) {
                return
            }
            this.m_undoStack.prepareChanges(new TranslatableString('undoableAction', 'Enter note'))
            const note = sc.addMidiPitch(pitch, i !== 0, false)
            this.m_undoStack.commitChanges()
            const cr = is.cr()
            if (cr) {
                this.m_notationInteraction.showItem(cr)
            }
            if (note) {
                notesOn.push(note)
            }
            if (i === 0 && !this.isRealtimeTimerActive() && this.isRealtimeAuto()) {
                this.startExtendNoteTimer()
                this.enableMetronome()
                this.doRealtimeAdvance()
            }
        })

        if (notesOn.length) {
            playbackController()?.seekElement(notesOn[0], true /*flushSound*/)
            this.m_notationInteraction.notifyAboutNotationChanged()
        }
        return notesOn
    }

    private noteInputMethod(): NoteEntryMethod {
        return this.m_notationInteraction.noteInput().state().noteEntryMethod()
    }

    private isRealtime(): boolean {
        return this.isRealtimeAuto() || this.isRealtimeManual()
    }

    private isRealtimeAuto(): boolean {
        return this.noteInputMethod() === NoteEntryMethod.REALTIME_AUTO
    }

    private isRealtimeManual(): boolean {
        return this.noteInputMethod() === NoteEntryMethod.REALTIME_MANUAL
    }

    private isInputByDuration(): boolean {
        return this.noteInputMethod() === NoteEntryMethod.BY_DURATION
    }

    private isNoteInputMode(): boolean {
        return this.m_notationInteraction.noteInput().isNoteInputMode()
    }
}
