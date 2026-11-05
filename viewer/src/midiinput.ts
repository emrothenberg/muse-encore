/*
 * SPDX-License-Identifier: GPL-3.0-only
 * The viewer's MIDI input: the connection of the configured device on the library's WebMidiInPort, like the editor's
 * editor/midi/midicontroller.ts, whose rules it keeps: the browser is asked for the access only by "Enable MIDI input"
 * (with the permission from an earlier visit it connects silently), and the input is on if the setting is on and there
 * is access. The events only go to the playalong (a viewer has nothing to enter notes into).
 */
import { NONE_DEVICE_ID, Opcode, WebMidiInPort, type MidiAccessState, type MidiDevice } from '../../src/index'

export interface ViewerMidiSettings {
    enabled: boolean
    /** the device chosen ('': the first one, NONE_DEVICE_ID: none) and its name (the browser may give it a new id) */
    deviceId: string
    deviceName: string
}

export class ViewerMidiInput {
    private readonly m_port = new WebMidiInPort()

    /** onChange: the settings, the access or the devices changed; onNoteOn: time in seconds */
    constructor(private m_settings: ViewerMidiSettings, private readonly m_onChange: () => void,
                onNoteOn: (pitch: number, time: number) => void) {
        const port = this.m_port
        port.onAccessStateChanged(m_onChange)
        port.onDeviceChanged(m_onChange)
        port.onAvailableDevicesChanged(() => {
            this.checkConnection()
            m_onChange()
        })
        port.onEventReceived((tick, event) => {
            if (this.m_settings.enabled && event.opcode() === Opcode.NoteOn) {
                onNoteOn(event.note(), tick / 1000)
            }
        })
        void port.init()
    }

    settings(): ViewerMidiSettings {
        return this.m_settings
    }

    accessState(): MidiAccessState {
        return this.m_port.accessState()
    }

    /** the devices to choose from (the first one is "none") */
    devices(): readonly MidiDevice[] {
        return this.m_port.availableDevices()
    }

    deviceId(): string {
        return this.m_port.deviceID()
    }

    /** the setting is on and there is access */
    isOn(): boolean {
        return this.m_settings.enabled && this.m_port.accessState() === 'granted'
    }

    /** the notes of a device arrive */
    isReceiving(): boolean {
        return this.isOn() && this.m_port.isConnected()
    }

    /** the text why the browser gives no access; '' if there is none to tell */
    accessProblem(): string {
        const access = this.m_port.accessState()
        if (access === 'unsupported') {
            return 'This browser does not support MIDI devices.'
        }
        return access === 'denied' ? 'Access to MIDI devices is blocked. Allow it in the site settings of your browser.' : ''
    }

    /** on asks the browser for the access if needed (so to be called from a user gesture) */
    setEnabled(enabled: boolean): void {
        this.m_settings = { ...this.m_settings, enabled }
        this.m_onChange()
        if (enabled) {
            void this.m_port.requestAccess().then(() => this.m_onChange())
        }
    }

    selectDevice(id: string): void {
        const deviceName = this.m_port.availableDevices().find(d => d.id === id)?.name ?? ''
        this.m_settings = { ...this.m_settings, deviceId: id, deviceName }
        this.m_port.connect(id)
    }

    /** the device chosen, else (a device plugged in later too) the first one */
    private checkConnection(): void {
        const devices = this.m_port.availableDevices()
        const { deviceId, deviceName } = this.m_settings
        const chosen = deviceId === NONE_DEVICE_ID ? deviceId
            : devices.find(d => d.id === deviceId)?.id ?? devices.find(d => d.name && d.name === deviceName)?.id
        const target = chosen ?? devices.find(d => d.id !== NONE_DEVICE_ID)?.id ?? NONE_DEVICE_ID
        if (target !== this.m_port.deviceID()) {
            this.m_port.connect(target)
        }
    }

    dispose(): void {
        this.m_port.connect(NONE_DEVICE_ID)
    }
}
