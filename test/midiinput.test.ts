// SPDX-License-Identifier: GPL-3.0-only
// The MIDI input: the bytes of a device through WebMidiInPort, MidiRemote and NotationMidiInput to the score, with a fake
// device for the browser's API and a recording playback controller (the sound).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    createScore, defaultNewScoreOptions, executeAction, midiEventReceived, MidiEvent, MidiRemote, NONE_DEVICE_ID, Opcode, RemoteEventType, setMidiInputConfiguration, setPlaybackController, undo, WebMidiInPort,
    INFINITE_DURATION, type ControllerChangeEvent, type IPlaybackController, type MasterScore, type MidiNavigator, type PlayParams,
} from '../src/index'
import { SegmentType } from '../src/engraving/dom/segment'
import { NoteEntryMethod, type NoteVal } from '../src/engraving/dom/input'
import type { Chord } from '../src/engraving/dom/chord'
import type { ChordRest } from '../src/engraving/dom/chordrest'
import type { Measure } from '../src/engraving/dom/measure'
import type { EngravingItem } from '../src/engraving/dom/engravingitem'
import type { Note } from '../src/engraving/dom/note'
import { initFonts } from './helpers'

const noteOn = (p: number, v = 100): MidiEvent => MidiEvent.fromMidi10Bytes([0x90, p, v])!
const noteOff = (p: number): MidiEvent => MidiEvent.fromMidi10Bytes([0x80, p, 0])!

function contents(m: Measure): string[] {
    const res: string[] = []
    for (let s = m.first(SegmentType.ChordRest); s; s = s.next(SegmentType.ChordRest)) {
        const e = s.element(0) as unknown as ChordRest | null
        if (e) {
            const f = e.ticks().reduced()
            res.push(`${e.isChord() ? (e as unknown as Chord).notes().map(n => n.pitch()).join('+') : 'r'}:${f.numerator()}/${f.denominator()}`)
        }
    }
    return res
}

function newScore(id = 'piano'): MasterScore {
    return createScore({ ...defaultNewScoreOptions(), instruments: [{ id }], measures: 4 })
}

function selectFirstRest(score: MasterScore): void {
    score.select(score.firstMeasure()!.first(SegmentType.ChordRest)!.element(0))
}

/** sends events to the score like a device and lets the processing timer (20 ms) run */
function play(score: MasterScore, ...events: MidiEvent[]): void {
    for (const e of events) {
        midiEventReceived(score, e)
    }
    vi.advanceTimersByTime(20)
}

interface Played { pitches: number[]; velocities: number[]; params: PlayParams }

describe('MidiEvent', () => {
    it('reads MIDI 1.0 messages; a note on with velocity 0 is a note off; system messages are ignored', () => {
        expect(MidiEvent.fromMidi10Bytes([0x91, 60, 64])!.opcode()).toBe(Opcode.NoteOn)
        expect(MidiEvent.fromMidi10Bytes([0x91, 60, 64])!.channel()).toBe(1)
        expect(MidiEvent.fromMidi10Bytes([0x90, 60, 0])!.opcode()).toBe(Opcode.NoteOff)
        expect(MidiEvent.fromMidi10Bytes([0xB0, 64, 127])!.index()).toBe(64)
        expect(MidiEvent.fromMidi10Bytes([0xE0, 0x00, 0x40])!.pitchBend14()).toBe(8192)
        expect(MidiEvent.fromMidi10Bytes([0xF8])).toBeNull()
        expect(MidiEvent.fromMidi10Bytes([0xFE])).toBeNull()
        expect(MidiEvent.fromMidi10Bytes([0xF0, 1, 2, 0xF7])).toBeNull()
        expect(MidiEvent.fromMidi10Bytes([0x90, 60])).toBeNull()
    })
})

describe('WebMidiInPort', () => {
    function fakeInput(id: string, name: string): MIDIInput & { send(bytes: number[]): void } {
        const input = {
            id, name, state: 'connected', onmidimessage: null as ((e: unknown) => void) | null,
            open: async () => input, close: async () => input,
            send(bytes: number[]) { input.onmidimessage?.({ data: new Uint8Array(bytes), timeStamp: 1 }) },
        }
        return input as unknown as MIDIInput & { send(bytes: number[]): void }
    }

    function fakeNavigator(state: string, inputs: MIDIInput[]): { nav: MidiNavigator; access: MIDIAccess; request: ReturnType<typeof vi.fn> } {
        const access = { inputs: new Map(inputs.map(i => [i.id, i])), onstatechange: null } as unknown as MIDIAccess
        const request = vi.fn(async () => {
            if (state === 'denied') {
                throw new DOMException('denied', 'NotAllowedError')
            }
            return access
        })
        const nav = {
            requestMIDIAccess: request,
            permissions: { query: async () => ({ state, addEventListener: () => {} }) as unknown as PermissionStatus },
        } as MidiNavigator
        return { nav, access, request }
    }

    it('without the API (Safari) the access is unsupported and nothing fails', async () => {
        const port = new WebMidiInPort({})
        await port.init()
        expect(port.accessState()).toBe('unsupported')
        expect(await port.requestAccess()).toBe(false)
        expect(port.availableDevices().map(d => d.id)).toEqual([NONE_DEVICE_ID])
    })

    it('does not ask at the start; asks with requestAccess; lists and connects devices', async () => {
        const a = fakeInput('a', 'Keyboard A')
        const { nav, request } = fakeNavigator('prompt', [a, fakeInput('b', 'Keyboard B')])
        const port = new WebMidiInPort(nav)
        await port.init()
        expect(request).not.toHaveBeenCalled()
        expect(port.accessState()).toBe('prompt')

        expect(await port.requestAccess()).toBe(true)
        expect(request).toHaveBeenCalledWith({ sysex: false })
        expect(port.accessState()).toBe('granted')
        expect(port.availableDevices().map(d => d.name)).toEqual(['', 'Keyboard A', 'Keyboard B'])

        const events: MidiEvent[] = []
        port.onEventReceived((_t, e) => events.push(e))
        expect(port.connect('a')).toBe(true)
        a.send([0x90, 60, 100])
        a.send([0xF8]) // the clock
        expect(events.map(e => e.note())).toEqual([60])

        expect(port.connect('missing')).toBe(false)
        expect(port.isConnected()).toBe(false)
        a.send([0x90, 62, 100])
        expect(events.length).toBe(1)
    })

    it('connects at the start if the permission was given before; a refusal is reported; device changes are', async () => {
        const granted = fakeNavigator('granted', [])
        const port = new WebMidiInPort(granted.nav)
        const changed = vi.fn()
        port.onAvailableDevicesChanged(changed)
        await port.init()
        await vi.waitFor(() => expect(port.accessState()).toBe('granted'))
        expect(granted.request).toHaveBeenCalledTimes(1)

        ;(granted.access.inputs as unknown as Map<string, MIDIInput>).set('c', fakeInput('c', 'New'))
        granted.access.onstatechange!({} as MIDIConnectionEvent)
        expect(changed).toHaveBeenCalledTimes(1)
        expect(port.availableDevices().map(d => d.name)).toEqual(['', 'New'])

        const denied = new WebMidiInPort(fakeNavigator('denied', []).nav)
        await denied.init()
        expect(denied.accessState()).toBe('denied')
        expect(await denied.requestAccess()).toBe(false)
    })
})

describe('MidiRemote', () => {
    const mapped = (advance = true): { remote: MidiRemote; actions: string[] } => {
        const actions: string[] = []
        const remote = new MidiRemote({ advanceToNextNoteOnKeyRelease: () => advance }, a => actions.push(a))
        remote.setMidiMappings([
            { action: 'play', event: { type: RemoteEventType.Note, value: 36 } },
            { action: 'realtime-advance', event: { type: RemoteEventType.Controller, value: 64 } },
        ])
        return { remote, actions }
    }

    it('runs the action of a key or controller and passes the other events further', () => {
        const { remote, actions } = mapped()
        expect(remote.process(noteOn(36))).toBe(true)
        expect(remote.process(noteOn(37))).toBe(false)
        expect(actions).toEqual(['play'])
    })

    it('a release is only a command for the real-time advance, if "Advance to next note on key release" is on', () => {
        const on = mapped(true)
        expect(on.remote.process(noteOff(36))).toBe(false)
        expect(on.remote.process(MidiEvent.fromMidi10Bytes([0xB0, 64, 0])!)).toBe(true)
        expect(on.actions).toEqual(['realtime-advance'])

        const off = mapped(false)
        expect(off.remote.process(MidiEvent.fromMidi10Bytes([0xB0, 64, 0])!)).toBe(false)
        expect(off.remote.process(MidiEvent.fromMidi10Bytes([0xB0, 64, 127])!)).toBe(true)
    })

    it('does nothing while a mapping is assigned', () => {
        const { remote, actions } = mapped()
        remote.setIsSettingMode(true)
        expect(remote.process(noteOn(36))).toBe(false)
        expect(actions).toEqual([])
    })
})

describe('NotationMidiInput', () => {
    let played: Played[]
    let notesPlayed: { pitches: number[]; params: PlayParams }[]
    let metronome: number[]
    let controllers: { type: number; val: number }[]
    let metronomeOn: boolean

    beforeAll(async () => {
        await initFonts()
    })

    beforeEach(() => {
        vi.useFakeTimers()
        played = []
        notesPlayed = []
        metronome = []
        controllers = []
        metronomeOn = false
        setPlaybackController({
            isPlaying: () => false,
            isLoopEnabled: () => false,
            reset: () => {},
            playElements: (elements: readonly EngravingItem[], params: PlayParams = {}) => {
                const notes = elements as unknown as Note[]
                played.push({ pitches: notes.map(n => n.ppitch()), velocities: notes.map(n => n.userVelocity()), params })
            },
            playNotes: (notes: readonly NoteVal[], _staffIdx: number, _segment: unknown, params: PlayParams = {}) => { notesPlayed.push({ pitches: notes.map(n => n.pitch), params }) },
            playMetronome: (tick: number) => { metronome.push(tick) },
            triggerControllers: (list: readonly ControllerChangeEvent[]) => { controllers.push(...list) },
            seekElement: () => {},
            seekBeat: () => {},
        } as unknown as IPlaybackController)
        setMidiInputConfiguration({
            startNoteInputAtSelectedNoteRestWhenPressingMidiKey: () => true,
            useMidiVelocityAndDurationDuringNoteInput: () => true,
            isPlayPreviewNotesInInputByDuration: () => true,
            midiUseWrittenPitch: () => true,
            isMetronomeEnabled: () => metronomeOn,
            toggleMetronome: () => { metronomeOn = !metronomeOn },
            isShiftPressed: () => false,
            delayBetweenNotesInRealTimeModeMilliseconds: () => 750,
        })
    })

    afterEach(() => {
        vi.useRealTimers()
        setPlaybackController(null)
    })

    it('step-time input: released keys give single notes, keys held together a chord; the undo removes them', () => {
        const score = newScore()
        const m1 = score.firstMeasure()!
        selectFirstRest(score)
        expect(executeAction(score, 'note-input')).toBe(true)
        expect(executeAction(score, 'pad-note-4')).toBe(true)

        play(score, noteOn(60), noteOff(60))
        play(score, noteOn(62))
        play(score, noteOff(62))
        // a chord: in one batch and with a later key while the first is held
        play(score, noteOn(64), noteOn(67))
        play(score, noteOn(72))
        play(score, noteOff(64), noteOff(67), noteOff(72))
        expect(contents(m1)).toEqual(['60:1/4', '62:1/4', '64+67+72:1/4', 'r:1/4'])
        expect(score.activeMidiPitches()).toEqual([])

        undo(score)
        expect(contents(m1).slice(0, 2)).toEqual(['60:1/4', '62:1/4'])
    })

    it('a pressed key begins the note input at the selected rest; without a selection or with the setting off it only sounds', () => {
        const score = newScore()
        const m1 = score.firstMeasure()!

        play(score, noteOn(60))
        expect(score.inputState().noteEntryMode()).toBe(false)
        expect(played[0].pitches).toEqual([60])
        expect(played[0].velocities).toEqual([100])
        expect(played[0].params.duration).toBe(INFINITE_DURATION)
        expect(contents(m1)).toEqual(['r:1/1'])
        play(score, noteOff(60))
        expect(played[1].params.duration).toBe(0)
        expect(played[1].pitches).toEqual([60])

        setMidiInputConfiguration({ startNoteInputAtSelectedNoteRestWhenPressingMidiKey: () => false })
        selectFirstRest(score)
        play(score, noteOn(62), noteOff(62))
        expect(score.inputState().noteEntryMode()).toBe(false)

        setMidiInputConfiguration({ startNoteInputAtSelectedNoteRestWhenPressingMidiKey: () => true })
        selectFirstRest(score)
        play(score, noteOn(64), noteOff(64))
        expect(score.inputState().noteEntryMode()).toBe(true)
        expect(contents(m1)[0]).toMatch(/^64:/)
    })

    it('plays with the velocity and until the release, or with the default duration if the setting is off', () => {
        const score = newScore()
        selectFirstRest(score)
        executeAction(score, 'note-input')
        played = []
        play(score, noteOn(60, 33))
        expect(played[0].velocities).toEqual([33])
        expect(played[0].params.duration).toBe(INFINITE_DURATION)
        played = []
        play(score, noteOff(60))
        expect(played[0].params.duration).toBe(0)
        expect(played[0].velocities).toEqual([0])

        setMidiInputConfiguration({ useMidiVelocityAndDurationDuringNoteInput: () => false })
        played = []
        play(score, noteOn(62, 33))
        expect(played[0].params.duration).toBeUndefined()
        expect(played[0].params.flushSound).toBe(true)
        expect(played[0].velocities).toEqual([0])
        play(score, noteOff(62))
        expect(played.length).toBe(1)
    })

    it('written pitch: the key is the written note on a transposing staff; sounding pitch: the note that sounds', () => {
        const written = newScore('bb-trumpet')
        selectFirstRest(written)
        executeAction(written, 'note-input')
        executeAction(written, 'pad-note-4')
        play(written, noteOn(62), noteOff(62))
        expect(contents(written.firstMeasure()!)[0]).toBe('60:1/4')

        setMidiInputConfiguration({ midiUseWrittenPitch: () => false })
        const sounding = newScore('bb-trumpet')
        selectFirstRest(sounding)
        executeAction(sounding, 'note-input')
        executeAction(sounding, 'pad-note-4')
        play(sounding, noteOn(62), noteOff(62))
        expect(contents(sounding.firstMeasure()!)[0]).toBe('62:1/4')
    })

    it('shift adds the key to the previous chord', () => {
        const score = newScore()
        selectFirstRest(score)
        executeAction(score, 'note-input')
        executeAction(score, 'pad-note-4')
        play(score, noteOn(60), noteOff(60))
        setMidiInputConfiguration({ isShiftPressed: () => true })
        play(score, noteOn(64), noteOff(64))
        expect(contents(score.firstMeasure()!)[0]).toBe('60+64:1/4')
    })

    it('input by duration: the keys are the pitches of the next note, kept while held', () => {
        const score = newScore()
        selectFirstRest(score)
        executeAction(score, 'note-input-by-duration')
        expect(score.inputState().noteEntryMethod()).toBe(NoteEntryMethod.BY_DURATION)
        play(score, noteOn(60))
        play(score, noteOn(64))
        expect(score.inputState().notes().map(n => n.pitch)).toEqual([60, 64])
        expect(notesPlayed.at(-1)!.params.duration).toBe(INFINITE_DURATION)
        play(score, noteOff(60), noteOff(64))
        expect(notesPlayed.at(-1)!.params.duration).toBe(0)
        expect(notesPlayed.at(-1)!.pitches).toEqual([60, 64])
        expect(score.inputState().notes().map(n => n.pitch)).toEqual([60, 64])
        // a new key after the release replaces them
        play(score, noteOn(67))
        expect(score.inputState().notes().map(n => n.pitch)).toEqual([67])
    })

    it('real-time (manual): a held key is tied over the advance; the release removes it from the next position', () => {
        const score = newScore()
        const m1 = score.firstMeasure()!
        selectFirstRest(score)
        executeAction(score, 'note-input-realtime-manual')
        executeAction(score, 'pad-note-4')

        play(score, noteOn(60))
        expect(contents(m1)[0]).toBe('60:1/4')
        expect(executeAction(score, 'realtime-advance')).toBe(true)
        expect(metronome.length).toBe(1)
        expect(metronomeOn).toBe(true)
        vi.advanceTimersByTime(100)
        expect(contents(m1).slice(0, 2)).toEqual(['60:1/4', '60:1/4'])
        const first = m1.first(SegmentType.ChordRest)!.element(0) as unknown as Chord
        expect(first.notes()[0].tieFor()).toBeTruthy()

        // the metronome goes off after the tick
        vi.advanceTimersByTime(400)
        expect(metronomeOn).toBe(false)

        play(score, noteOff(60))
        executeAction(score, 'realtime-advance')
        vi.advanceTimersByTime(100)
        expect(first.notes()[0].tieFor()).toBeFalsy()
        expect(contents(m1)[0]).toBe('60:1/4')
        expect(contents(m1)[1]).toMatch(/^r:/)
        expect(score.activeMidiPitches()).toEqual([])
    })

    it('real-time (metronome): the first key starts the advance, which goes on while the key is held and ends after it', () => {
        const score = newScore()
        const m1 = score.firstMeasure()!
        selectFirstRest(score)
        executeAction(score, 'note-input-realtime-auto')
        executeAction(score, 'pad-note-4')
        const startTick = score.inputState().tick().ticks()

        play(score, noteOn(60))
        expect(metronomeOn).toBe(true)
        vi.advanceTimersByTime(100)
        expect(score.inputState().tick().ticks()).toBe(startTick + 480)
        expect(contents(m1).slice(0, 2)).toEqual(['60:1/4', '60:1/4'])

        // held: the extend timer starts the interval
        vi.advanceTimersByTime(750)
        expect(score.inputState().tick().ticks()).toBe(startTick + 960)
        expect(contents(m1).slice(0, 3)).toEqual(['60:1/4', '60:1/4', '60:1/4'])

        // released: no more advances, the metronome is off
        play(score, noteOff(60))
        const tick = score.inputState().tick().ticks()
        vi.advanceTimersByTime(3000)
        expect(score.inputState().tick().ticks()).toBe(tick)
        expect(metronomeOn).toBe(false)
    })

    it('the sustain pedal, modulation and pitch bend reach the sound (the last of a batch), other controllers do not', () => {
        const score = newScore()
        play(score, MidiEvent.fromMidi10Bytes([0xB0, 64, 127])!, MidiEvent.fromMidi10Bytes([0xB0, 64, 0])!)
        expect(controllers.length).toBe(1)
        expect(controllers[0].val).toBe(0)
        controllers = []
        play(score, MidiEvent.fromMidi10Bytes([0xE0, 0x7F, 0x7F])!)
        expect(controllers[0].val).toBe(1)
        controllers = []
        play(score, MidiEvent.fromMidi10Bytes([0xB0, 7, 100])!)
        expect(controllers).toEqual([])
    })
})
