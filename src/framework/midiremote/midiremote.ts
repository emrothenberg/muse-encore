/*
 * SPDX-License-Identifier: GPL-3.0-only
 * MuseEncore — port of MuseScore Studio (https://github.com/musescore/MuseScore)
 * Copyright (C) 2021-2026 MuseScore Limited and others
 *
 * Port of src/framework/midiremote: midiremotetypes.h, internal/midiremote.cpp (the actions of MIDI keys and controllers)
 * and allMidiActions() of mididevicemappingmodel.cpp. The mappings are stored by the application (C++: midi_mappings.xml).
 * TODO(port): MMC (play, pause, stop, locate): it comes as system exclusive messages, which need a permission of their
 * own in the browser.
 */

import { MidiEvent, Opcode } from '../midi/midievent'

export enum RemoteEventType {
    Undefined = 0,
    Note,
    Controller,
}

export interface RemoteEvent {
    type: RemoteEventType
    value: number
}

export interface MidiControlsMapping {
    action: string
    event: RemoteEvent
}

export function noRemoteEvent(): RemoteEvent {
    return { type: RemoteEventType.Undefined, value: -1 }
}

export function isValidRemoteEvent(e: RemoteEvent): boolean {
    return e.type !== RemoteEventType.Undefined && e.value !== -1
}

export function remoteEventFromMidiEvent(midiEvent: MidiEvent): RemoteEvent {
    const opcode = midiEvent.opcode()
    if (opcode === Opcode.NoteOff || opcode === Opcode.NoteOn) {
        return { type: RemoteEventType.Note, value: midiEvent.note() }
    }
    if (opcode === Opcode.ControlChange) {
        return { type: RemoteEventType.Controller, value: midiEvent.index() }
    }
    return noRemoteEvent()
}

const sameEvent = (a: RemoteEvent, b: RemoteEvent): boolean => a.type === b.type && a.value === b.value

const REALTIME_ADVANCE_ACTION_NAME = 'realtime-advance'

/** C++ allMidiActions(): the actions that can be mapped */
export const ALL_MIDI_ACTIONS: readonly string[] = [
    'rewind', 'loop', 'play', 'stop', 'note-input',
    'pad-note-1', 'pad-note-2', 'pad-note-4', 'pad-note-8', 'pad-note-16', 'pad-note-32', 'pad-note-64',
    'action://notation/undo', 'rest', 'pad-rest', 'tie', 'pad-dot', 'pad-dot2', 'realtime-advance',
]

export interface MidiRemoteConfiguration {
    /** IMidiRemoteConfiguration::advanceToNextNoteOnKeyRelease */
    advanceToNextNoteOnKeyRelease(): boolean
}

export class MidiRemote {
    private m_midiMappings: MidiControlsMapping[] = []
    private m_isSettingMode = false

    constructor(private m_configuration: MidiRemoteConfiguration, private m_dispatch: (action: string) => void) {}

    midiMappings(): readonly MidiControlsMapping[] {
        return this.m_midiMappings
    }

    setMidiMappings(midiMappings: readonly MidiControlsMapping[]): void {
        this.m_midiMappings = midiMappings.filter(m => m.action && isValidRemoteEvent(m.event))
    }

    setIsSettingMode(arg: boolean): void {
        this.m_isSettingMode = arg
    }

    isSettingMode(): boolean {
        return this.m_isSettingMode
    }

    /** true if the event was a command; otherwise it is passed further (C++: Ret::Code::Undefined) */
    process(ev: MidiEvent): boolean {
        if (this.needIgnoreEvent(ev)) {
            return false
        }

        const event = remoteEventFromMidiEvent(ev)
        for (const midiMapping of this.m_midiMappings) {
            if (sameEvent(midiMapping.event, event)) {
                this.m_dispatch(midiMapping.action)
                return true
            }
        }
        return false
    }

    private needIgnoreEvent(event: MidiEvent): boolean {
        if (this.isSettingMode()) {
            return true
        }

        const opcode = event.opcode()
        if (opcode !== Opcode.NoteOn && opcode !== Opcode.NoteOff && opcode !== Opcode.ControlChange) {
            return true
        }

        const release = opcode === Opcode.NoteOff || (opcode === Opcode.ControlChange && event.data() === 0)
        if (release) {
            if (!this.m_configuration.advanceToNextNoteOnKeyRelease()) {
                return true
            }

            const realtimeEvent = this.remoteEvent(REALTIME_ADVANCE_ACTION_NAME)
            if (!isValidRemoteEvent(realtimeEvent) || !sameEvent(remoteEventFromMidiEvent(event), realtimeEvent)) {
                return true
            }
        }

        return false
    }

    private remoteEvent(action: string): RemoteEvent {
        return this.m_midiMappings.find(m => m.action === action)?.event ?? noRemoteEvent()
    }
}
