/*
 * SPDX-License-Identifier: GPL-3.0-only
 * MuseEncore — port of MuseScore Studio (https://github.com/musescore/MuseScore)
 * Copyright (C) 2021-2026 MuseScore Limited and others
 *
 * The MIDI input port of the browser (the Web MIDI API), the counterpart of C++ CoreMidiInPort, AlsaMidiInPort and
 * WinMidiInPort (IMidiInPort). Differences that the browser's API requires:
 * - there must be permission to use MIDI devices. Asking needs a user gesture in some browsers and should not happen
 *   by itself on every visit: init() connects only if the permission was given before, requestAccess() asks;
 * - some browsers do not have the API (Safari) or only in secure contexts: accessState() is then 'unsupported';
 * - no system exclusive messages (they need a permission of their own), so no MMC of the MIDI remote;
 * - the browser reports changes of the devices (statechange): no polling like C++ MidiDevicesListener;
 * - MIDI 1.0 only.
 */

import { MidiEvent } from '../../../midievent'
import { NONE_DEVICE_ID, type MidiDevice, type MidiDeviceID } from '../../../miditypes'

export type MidiAccessState = 'unsupported' | 'prompt' | 'denied' | 'granted'

/** the part of `navigator` the port uses (tests pass a fake one) */
export interface MidiNavigator {
    requestMIDIAccess?: (options?: MIDIOptions) => Promise<MIDIAccess>
    permissions?: Pick<Permissions, 'query'>
}

export class WebMidiInPort {
    private m_navigator: MidiNavigator
    private m_access: MIDIAccess | null = null
    private m_state: MidiAccessState
    private m_devices: MidiDevice[] = [{ id: NONE_DEVICE_ID, name: '' }]
    private m_deviceId: MidiDeviceID = ''
    private m_input: MIDIInput | null = null
    private m_requesting: Promise<boolean> | null = null
    private m_accessStateChanged = new Set<() => void>()
    private m_availableDevicesChanged = new Set<() => void>()
    private m_deviceChanged = new Set<() => void>()
    private m_eventReceived = new Set<(tick: number, event: MidiEvent) => void>()

    constructor(nav: MidiNavigator = navigator as unknown as MidiNavigator) {
        this.m_navigator = nav
        this.m_state = typeof nav.requestMIDIAccess === 'function' ? 'prompt' : 'unsupported'
    }

    /** reads the permission and, if it was given before, connects without asking */
    async init(): Promise<void> {
        if (this.m_state === 'unsupported') {
            return
        }
        let status: PermissionStatus
        try {
            status = await this.m_navigator.permissions!.query({ name: 'midi' as PermissionName })
        } catch {
            return // the browser does not know this permission: requestAccess() still can ask
        }
        const update = (): void => {
            if (status.state === 'granted') {
                void this.requestAccess()
            } else if (!this.m_access) {
                this.setAccessState(status.state === 'denied' ? 'denied' : 'prompt')
            } else if (status.state === 'denied') {
                this.releaseAccess()
            }
        }
        status.addEventListener?.('change', update)
        update()
    }

    accessState(): MidiAccessState {
        return this.m_state
    }

    onAccessStateChanged(listener: () => void): () => void {
        this.m_accessStateChanged.add(listener)
        return () => this.m_accessStateChanged.delete(listener)
    }

    /** gets access to the MIDI devices: the browser may ask the user (so to be called from a user gesture) */
    requestAccess(): Promise<boolean> {
        if (this.m_access) {
            return Promise.resolve(true)
        }
        if (this.m_state === 'unsupported') {
            return Promise.resolve(false)
        }
        this.m_requesting ??= this.m_navigator.requestMIDIAccess!({ sysex: false }).then((access) => {
            this.m_access = access
            access.onstatechange = () => this.updateDevices()
            this.setAccessState('granted')
            this.updateDevices()
            return true
        }, () => {
            this.setAccessState('denied')
            return false
        }).finally(() => {
            this.m_requesting = null
        })
        return this.m_requesting
    }

    private releaseAccess(): void {
        if (this.m_access) {
            this.m_access.onstatechange = null
        }
        this.m_access = null
        this.disconnectInput()
        this.m_deviceId = ''
        this.setAccessState('denied')
        this.updateDevices()
        this.notify(this.m_deviceChanged)
    }

    private setAccessState(state: MidiAccessState): void {
        if (state !== this.m_state) {
            this.m_state = state
            this.notify(this.m_accessStateChanged)
        }
    }

    private notify(listeners: Set<() => void>): void {
        for (const l of [...listeners]) {
            l()
        }
    }

    // -----------------------------------------------------------------------------------------------------------------
    //   IMidiInPort
    // -----------------------------------------------------------------------------------------------------------------

    availableDevices(): readonly MidiDevice[] {
        return this.m_devices
    }

    onAvailableDevicesChanged(listener: () => void): () => void {
        this.m_availableDevicesChanged.add(listener)
        return () => this.m_availableDevicesChanged.delete(listener)
    }

    /** connects a device; NONE_DEVICE_ID or '' disconnects. false if there is no such device */
    connect(deviceId: MidiDeviceID): boolean {
        this.disconnectInput()
        let ok = true
        if (deviceId && deviceId !== NONE_DEVICE_ID) {
            const input = this.m_access?.inputs.get(deviceId)
            if (input) {
                this.m_input = input
                input.onmidimessage = (e: MIDIMessageEvent) => {
                    const event = e.data ? MidiEvent.fromMidi10Bytes(e.data) : null
                    if (event) {
                        for (const l of [...this.m_eventReceived]) {
                            l(e.timeStamp, event)
                        }
                    }
                }
                // C++ reports a failure of the connection only in the log
                input.open().catch(() => {})
            } else {
                ok = false
            }
        }
        this.m_deviceId = ok ? deviceId : ''
        this.notify(this.m_deviceChanged)
        return ok
    }

    private disconnectInput(): void {
        const input = this.m_input
        if (input) {
            this.m_input = null
            input.onmidimessage = null
            input.close().catch(() => {})
        }
    }

    deviceID(): MidiDeviceID {
        return this.m_deviceId
    }

    isConnected(): boolean {
        return this.m_input !== null
    }

    onDeviceChanged(listener: () => void): () => void {
        this.m_deviceChanged.add(listener)
        return () => this.m_deviceChanged.delete(listener)
    }

    /** the channel voice messages of the connected device (tick: the time stamp of the browser in ms) */
    onEventReceived(listener: (tick: number, event: MidiEvent) => void): () => void {
        this.m_eventReceived.add(listener)
        return () => this.m_eventReceived.delete(listener)
    }

    private updateDevices(): void {
        const devices: MidiDevice[] = [{ id: NONE_DEVICE_ID, name: '' }]
        this.m_access?.inputs.forEach((input) => {
            if (input.state !== 'disconnected') {
                devices.push({ id: input.id, name: input.name ?? input.id })
            }
        })
        const changed = devices.length !== this.m_devices.length
            || devices.some((d, i) => d.id !== this.m_devices[i].id || d.name !== this.m_devices[i].name)
        if (changed) {
            this.m_devices = devices
            this.notify(this.m_availableDevicesChanged)
        }
    }
}
