/*
 * SPDX-License-Identifier: GPL-3.0-only
 * MuseEncore — port of MuseScore Studio (https://github.com/musescore/MuseScore)
 * Copyright (C) 2021-2026 MuseScore Limited and others
 *
 * Port of the device types of src/framework/midi/miditypes.h.
 */

export type MidiDeviceID = string

export interface MidiDevice {
    id: MidiDeviceID
    /** the name the device reports; '' for NONE_DEVICE_ID (the application shows its translated "No device") */
    name: string
}

export const NONE_DEVICE_ID = '-1'

export const MODWHEEL_CONTROLLER = 1
export const SUSTAIN_PEDAL_CONTROLLER = 64
