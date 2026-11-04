/*
 * SPDX-License-Identifier: GPL-3.0-only
 * MuseEncore — port of MuseScore Studio (https://github.com/musescore/MuseScore)
 * Copyright (C) 2021-2026 MuseScore Limited and others
 *
 * Port of the MIDI 1.0 channel voice messages of src/framework/midi/midievent.h (muse::midi::Event; here MidiEvent, the
 * DOM has a global Event). The browser's MIDI API delivers MIDI 1.0 bytes only, so there are no MIDI 2.0 messages.
 */

export enum Opcode {
    NoteOff = 0x8,
    NoteOn = 0x9,
    PolyPressure = 0xA,
    ControlChange = 0xB,
    ProgramChange = 0xC,
    ChannelPressure = 0xD,
    PitchBend = 0xE,
}

export class MidiEvent {
    constructor(
        private readonly m_opcode: Opcode,
        private readonly m_channel: number,
        private readonly m_data1: number,
        private readonly m_data2: number,
    ) {}

    /**
     * C++ Event::fromMidi10Bytes + toMIDI20 (all ports convert like this): a note on with velocity 0 is a note off.
     * null for what is not a complete channel voice message (system messages, e.g. the clock and active sensing)
     */
    static fromMidi10Bytes(bytes: ArrayLike<number>): MidiEvent | null {
        if (bytes.length < 2) {
            return null
        }
        const status = bytes[0]
        if (status < 0x80 || status >= 0xF0) {
            return null
        }
        let opcode = (status >> 4) as Opcode
        const isTwoBytes = opcode === Opcode.ProgramChange || opcode === Opcode.ChannelPressure
        if (!isTwoBytes && bytes.length < 3) {
            return null
        }
        const data2 = isTwoBytes ? 0 : bytes[2] & 0x7F
        if (opcode === Opcode.NoteOn && data2 === 0) {
            opcode = Opcode.NoteOff
        }
        return new MidiEvent(opcode, status & 0x0F, bytes[1] & 0x7F, data2)
    }

    opcode(): Opcode { return this.m_opcode }
    channel(): number { return this.m_channel }
    /** the pitch of a note on or off */
    note(): number { return this.m_data1 }
    velocity7(): number { return this.m_data2 }
    /** the controller number of a control change */
    index(): number { return this.m_data1 }
    /** the value of a control change */
    data(): number { return this.m_data2 }
    /** the value of a pitch bend: 0..16383, 8192 is no bend */
    pitchBend14(): number { return this.m_data1 | (this.m_data2 << 7) }
}
