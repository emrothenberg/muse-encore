/*
 * SPDX-License-Identifier: GPL-3.0-only
 * The MIDI input of the editor: MuseScore's MidiInputOutputController (the connection of the configured device, the
 * events to the MIDI remote and the current notation), the "midi-on" and MIDI input pitch actions of PlaybackController
 * and the configuration (settings.midi = NotationConfiguration, MidiConfiguration, MidiRemoteConfiguration).
 *
 * Differences that the browser requires:
 * - the access needs the user's permission and is asked for only by "Enable MIDI input" (a page should not ask by
 *   itself): "midi-on" is checked if the setting is on and there is access;
 * - unlike an application, several tabs get the events of a device: only the visible tab that had the focus last takes
 *   them; a note off goes to where its note on went, so that no note stays on;
 * - nothing happens behind a dialog or during the playalong (which listens to the microphone), and while a MIDI mapping
 *   is being assigned the score does not get the event (in C++ it does).
 */
import { useSyncExternalStore } from 'react'
import {
    ALL_MIDI_ACTIONS, MidiRemote, NONE_DEVICE_ID, Opcode, WebMidiInPort, midiEventReceived, setMidiInputConfiguration, type MidiAccessState, type MidiControlsMapping, type MidiDevice, type MidiEvent,
} from '../../src/index'
import { actionDefinition, actionsChanged, isActionChecked, registerAction, triggerAction } from '../actions/actions'
import { webtr } from '../i18n'
import { playalongState } from '../playalong/playalongcontroller'
import { stopHeldPreviewNotes } from '../playback/playbackcontroller'
import { currentScore, setStatus } from '../scoreview'
import { settings, updateSettings } from '../settings'

const midi = (): ReturnType<typeof settings>['midi'] => settings().midi

const port = new WebMidiInPort()

const remote = new MidiRemote(
    { advanceToNextNoteOnKeyRelease: () => midi().advanceToNextNoteOnKeyRelease },
    action => triggerAction(action),
)
remote.setMidiMappings(midi().mappings)

// ---------------------------------------------------------------------------------
//   the state for the UI
// ---------------------------------------------------------------------------------

export interface MidiState {
    access: MidiAccessState
    devices: readonly MidiDevice[]
    /** the connected device (AudioMidiPreferencesModel::midiInputDeviceId) */
    deviceId: string
}

let state: MidiState = { access: port.accessState(), devices: port.availableDevices(), deviceId: port.deviceID() }
const listeners = new Set<() => void>()

function publish(): void {
    state = { access: port.accessState(), devices: port.availableDevices(), deviceId: port.deviceID() }
    for (const l of listeners) {
        l()
    }
    actionsChanged()
}

export function useMidiState(): MidiState {
    return useSyncExternalStore((l) => {
        listeners.add(l)
        return () => listeners.delete(l)
    }, () => state)
}

// ---------------------------------------------------------------------------------
//   the connection (MidiInputOutputController::checkConnection)
// ---------------------------------------------------------------------------------

/** the id of the configured device; the browser may give a device a new id, so its name is the second choice */
function preferredDeviceId(devices: readonly MidiDevice[]): string {
    const { inputDeviceId, inputDeviceName } = midi()
    if (!inputDeviceId || inputDeviceId === NONE_DEVICE_ID || devices.some(d => d.id === inputDeviceId)) {
        return inputDeviceId
    }
    return devices.find(d => d.name && d.name === inputDeviceName)?.id ?? ''
}

function checkInputConnection(): void {
    const devices = port.availableDevices()
    const contains = (id: string): boolean => devices.some(d => d.id === id)
    const preferred = preferredDeviceId(devices)
    const current = port.deviceID()
    const first = devices.find(d => d.id !== NONE_DEVICE_ID)?.id ?? NONE_DEVICE_ID

    if (preferred && preferred !== current && contains(preferred)) {
        port.connect(preferred)
        return
    }
    if (contains(current)) {
        // not in C++ (it looks at the devices at the start): a device plugged in later, without a device chosen
        if (!preferred && current === NONE_DEVICE_ID && first !== NONE_DEVICE_ID) {
            port.connect(first)
        }
        return
    }
    // "" makes MuseScore select the first available device
    port.connect(first)
}

/** AudioMidiPreferencesModel::inputDeviceSelected */
export function inputDeviceSelected(id: string): void {
    updateSettings('midi', { inputDeviceId: id, inputDeviceName: port.availableDevices().find(d => d.id === id)?.name ?? '' })
    port.connect(id)
}

// ---------------------------------------------------------------------------------
//   the events
// ---------------------------------------------------------------------------------

const TAB_CHANNEL = 'musescoreweb:midi-input'
const tabChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(TAB_CHANNEL) : null
let s_lastFocusedTab = true
tabChannel?.addEventListener('message', () => { s_lastFocusedTab = false })
function tabFocused(): void {
    s_lastFocusedTab = true
    tabChannel?.postMessage('focused')
}
window.addEventListener('focus', tabFocused)
if (document.hasFocus()) {
    tabFocused()
}

let s_shiftPressed = false
window.addEventListener('keydown', (e) => { s_shiftPressed = e.shiftKey }, true)
window.addEventListener('keyup', (e) => { s_shiftPressed = e.shiftKey }, true)
window.addEventListener('blur', () => { s_shiftPressed = false })

function takesEvents(): boolean {
    return s_lastFocusedTab
        && document.visibilityState === 'visible'
        && document.body.dataset.view === 'score'
        && !document.querySelector('dialog[open]')
        && !(playalongState().active && playalongState().mode !== 'noteinput')
}

/** the keys whose note on was taken (key: channel and pitch) */
const s_keysTaken = new Set<number>()

function isTaken(event: MidiEvent): boolean {
    const key = event.channel() * 128 + event.note()
    if (event.opcode() === Opcode.NoteOff) {
        return s_keysTaken.delete(key)
    }
    if (!takesEvents()) {
        return false
    }
    if (event.opcode() === Opcode.NoteOn) {
        s_keysTaken.add(key)
    }
    return true
}

let s_mappingListener: ((event: MidiEvent) => void) | null = null

/** EditMidiMappingModel::load: the events of the device go to the listener; returns the end */
export function startMappingEdit(listener: (event: MidiEvent) => void): () => void {
    s_mappingListener = listener
    remote.setIsSettingMode(true)
    return () => {
        s_mappingListener = null
        remote.setIsSettingMode(false)
    }
}

function onMidiEventReceived(event: MidiEvent): void {
    if (s_mappingListener) {
        if (event.opcode() === Opcode.NoteOn || event.opcode() === Opcode.ControlChange) {
            s_mappingListener(event)
        }
        return
    }

    if (!midi().inputEnabled || !isTaken(event)) {
        return
    }

    if (midi().useRemoteControl && remote.process(event)) {
        return // the event is a command
    }

    const score = currentScore()
    if (score) {
        midiEventReceived(score, event)
    }
}

// ---------------------------------------------------------------------------------
//   the MIDI mappings
// ---------------------------------------------------------------------------------

/** MidiDeviceMappingModel::load: the actions that can be mapped and exist here */
export function mappableActions(): readonly string[] {
    return ALL_MIDI_ACTIONS.filter(a => actionDefinition(a))
}

export function setMidiMappings(mappings: readonly MidiControlsMapping[]): void {
    remote.setMidiMappings(mappings)
    updateSettings('midi', { mappings: [...remote.midiMappings()] })
}

// ---------------------------------------------------------------------------------
//   Enable MIDI input
// ---------------------------------------------------------------------------------

export function isMidiInputOn(): boolean {
    return midi().inputEnabled && port.accessState() === 'granted'
}

/** the text why the browser gives no access; '' if there is none to tell */
export function midiAccessProblem(access: MidiAccessState): string {
    if (access === 'unsupported') {
        return webtr('This browser does not support MIDI devices.')
    }
    return access === 'denied' ? webtr('Access to MIDI devices is blocked. Allow it in the site settings of your browser.') : ''
}

/** the toggle of "midi-on" and of the Preferences: on asks the browser for the access if needed */
export function setMidiInputOn(on: boolean): void {
    updateSettings('midi', { inputEnabled: on })
    actionsChanged()
    if (on) {
        void port.requestAccess().then((ok) => {
            if (!ok) {
                setStatus(midiAccessProblem(port.accessState()), true)
            }
        })
    }
}

let s_registered = false

/** registers the actions and connects if the browser has the permission from an earlier visit */
export function initMidiInput(): void {
    if (s_registered) {
        return
    }
    s_registered = true

    setMidiInputConfiguration({
        startNoteInputAtSelectedNoteRestWhenPressingMidiKey: () => midi().startNoteInputWhenPressingKey,
        useMidiVelocityAndDurationDuringNoteInput: () => midi().useMidiVelocityAndDuration,
        isPlayPreviewNotesInInputByDuration: () => settings().playback.playPreviewNotesInInputByDuration,
        delayBetweenNotesInRealTimeModeMilliseconds: () => midi().realtimeDelay,
        midiUseWrittenPitch: () => midi().useWrittenPitch,
        isMetronomeEnabled: () => isActionChecked('metronome'),
        toggleMetronome: () => { triggerAction('metronome') },
        isShiftPressed: () => s_shiftPressed,
    })

    registerAction('midi-on', {
        run: () => setMidiInputOn(!isMidiInputOn()),
        enabled: () => port.accessState() !== 'unsupported',
        checked: isMidiInputOn,
    })
    const setUseWrittenPitch = (use: boolean): void => updateSettings('midi', { useWrittenPitch: use })
    registerAction('midi-input-written-pitch', { run: () => setUseWrittenPitch(true), checked: () => midi().useWrittenPitch })
    registerAction('midi-input-sounding-pitch', { run: () => setUseWrittenPitch(false), checked: () => !midi().useWrittenPitch })

    port.onAccessStateChanged(publish)
    port.onDeviceChanged(() => {
        // the note offs of the keys held on the old device will not come
        if (s_keysTaken.size) {
            s_keysTaken.clear()
            currentScore()?.activeMidiPitches().splice(0)
            stopHeldPreviewNotes()
        }
        publish()
    })
    port.onAvailableDevicesChanged(() => {
        checkInputConnection()
        publish()
    })
    port.onEventReceived((_tick, event) => onMidiEventReceived(event))
    void port.init()
}
