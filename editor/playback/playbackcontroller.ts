/*
 * SPDX-License-Identifier: GPL-3.0-only
 * The playback (MuseScore's PlaybackController, src/playback/internal/playbackcontroller.cpp): the playback actions
 * (play, pause, stop, rewind, loop, loop markers, metronome, count-in, repeats, chord symbols, pan, hearing notes
 * while editing), the play position, the tempo multiplier, and the notes heard while editing (playElements,
 * playNotes). The events come from the library (notationPlayback(score).renderMidiEvents()), the sound from the
 * synthesizer (synthesizer.ts). It is the library's IPlaybackController (setPlaybackController): the notation scene
 * seeks and plays elements through it like in MuseScore.
 * Not in MuseScore: the mute button (the browser's sound output; kept in the settings).
 */
import { useSyncExternalStore } from 'react'
import {
    BoundaryTick, ControllerChangeType, CTRL_PROGRAM, INFINITE_DURATION, LoopBoundaryType, ME_CONTROLLER, ME_NOTEON, ME_PITCHBEND, findAndSelectChordRest,
    notationPlayback, rangeSelectionPartIds, selectionPlaybackInfo, setPlaybackController, type EngravingItem,
    type ControllerChangeEvent, type IPlaybackController, type MasterScore, type Score, type MeasureBeat, type NoteVal, type PlayParams, type PlaybackChannel,
    type PlaybackMidiEvent, type Segment,
} from '../../src/index'
import { actionsChanged, registerAction } from '../actions/actions'
import { ICON_CODES } from '../actions/uiactiondata'
import { currentScore, onScoreViewChanged, scoreViewState, selectionChanged } from '../scoreview'
import { settings, updateSettings, type PlaybackSettings } from '../settings'
import { Player, type PlayerEvent } from '../../shared/playback/player'
import { SpessaSynthesizer } from '../../shared/playback/spessasynth'
import { appSoundFontUrl } from '../../shared/playback/soundfont'
import { NullSynthesizer, type LoadProgress, type SynthChannelSetup, type Synthesizer } from '../../shared/playback/synthesizer'

// ---------------------------------------------------------------------------------
//   the state shown by the UI (playback toolbar, cursor)
// ---------------------------------------------------------------------------------

export interface PlaybackState {
    playing: boolean
    /** the sounds are being loaded: the progress 0..1 (NaN: unknown), null when not loading */
    loading: number | null
    /** the sounds could not be loaded */
    error: string
    /** the play position in seconds and its tick of the score */
    position: number
    tick: number
    totalTime: number
    beat: MeasureBeat
    /** the tempo at the play position (quarter notes per minute, multiplied) */
    tempo: number
    tempoMultiplier: number
    loopEnabled: boolean
    muted: boolean
    /** counts the changes of the loop boundaries (the view draws the markers) */
    loopVersion: number
}

let state: PlaybackState = {
    playing: false, loading: null, error: '', position: 0, tick: 0, totalTime: 0,
    beat: { measureIndex: 0, maxMeasureIndex: 0, beat: 0, maxBeatIndex: 0 }, tempo: 120, tempoMultiplier: 1,
    loopEnabled: false, muted: settings().playback.muted, loopVersion: 0,
}
const listeners = new Set<() => void>()

function publish(patch: Partial<PlaybackState>): void {
    if (Object.entries(patch).every(([k, v]) => state[k as keyof PlaybackState] === v)) {
        return
    }
    const actionStateChanged = 'playing' in patch || 'loopEnabled' in patch || 'muted' in patch
    state = { ...state, ...patch }
    for (const l of listeners) {
        l()
    }
    if (actionStateChanged) {
        actionsChanged()
    }
}

export function playbackState(): PlaybackState {
    return state
}

export function onPlaybackStateChanged(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

export function usePlaybackState(): PlaybackState {
    return useSyncExternalStore(onPlaybackStateChanged, playbackState)
}

const pb = (): PlaybackSettings => settings().playback
const setPb = (patch: Partial<PlaybackSettings>): void => updateSettings('playback', patch)

// ---------------------------------------------------------------------------------
//   the synthesizer
// ---------------------------------------------------------------------------------

/**
 * ?synth=none: no sound (no audio device); ?synth=spessasynth: SpessaSynth. The default: SpessaSynth if the browser
 * has Web Audio, no sound in automated browsers (navigator.webdriver: the end-to-end tests)
 */
function createSynthesizer(): Synthesizer {
    const param = new URLSearchParams(location.search).get('synth')
    const webAudio = typeof AudioContext !== 'undefined' && typeof AudioWorkletNode !== 'undefined'
    if (param === 'none' || !webAudio || (navigator.webdriver && param !== 'spessasynth')) {
        return new NullSynthesizer()
    }
    return new SpessaSynthesizer(appSoundFontUrl(import.meta.env.BASE_URL))
}

const synth = createSynthesizer()
synth.setMuted(pb().muted)
const player = new Player(synth)
player.metronomeEnabled = pb().metronome

/** for tests: the synthesizer (the null synthesizer records its events) */
;(window as unknown as { __museencorePlayback?: unknown }).__museencorePlayback = { synth, player, state: () => state }

let loading: Promise<boolean> | null = null

/** loads the sounds (once); false if they could not be loaded */
function ensureSynthLoaded(): Promise<boolean> {
    if (synth.isLoaded()) {
        return Promise.resolve(true)
    }
    loading ??= (async () => {
        publish({ loading: NaN, error: '' })
        try {
            await synth.load((p: LoadProgress) => publish({ loading: p.total ? p.loaded / p.total : NaN }))
            publish({ loading: null })
            return true
        } catch (e) {
            loading = null
            publish({ loading: null, error: (e as Error).message })
            return false
        }
    })()
    return loading
}

/** the audio output may only start from a user gesture: called by the actions and the clicks that play */
function resumeAudio(): void {
    void synth.resume().catch(() => {})
}

// ---------------------------------------------------------------------------------
//   the events of the score
// ---------------------------------------------------------------------------------

let s_score: Score | null = null
let s_dirty = true
let s_channels: PlaybackChannel[] = []
let s_metronomeChannel = 0
let s_tempoMultiplier = 1
let s_removeLoopListener: (() => void) | null = null

function currentPlayback(): ReturnType<typeof notationPlayback> | null {
    const score = currentScore()
    return score ? notationPlayback(score) : null
}

function channelSetup(c: PlaybackChannel): SynthChannelSetup {
    return { program: c.program, bank: c.bank, drum: c.drum, volume: c.volume, pan: c.pan, reverb: c.reverb, chorus: c.chorus }
}

function toPlayerEvent(e: PlaybackMidiEvent): PlayerEvent | null {
    switch (e.type) {
    case ME_NOTEON:
        return { time: e.time, channel: e.channel, type: e.dataB ? 'on' : 'off', a: e.dataA, b: e.dataB }
    case ME_CONTROLLER:
        if (e.dataA === CTRL_PROGRAM) {
            return { time: e.time, channel: e.channel, type: 'cc', a: CTRL_PROGRAM, b: e.dataB }
        }
        return { time: e.time, channel: e.channel, type: 'cc', a: e.dataA, b: e.dataB }
    case ME_PITCHBEND:
        return { time: e.time, channel: e.channel, type: 'pb', a: e.dataA + e.dataB * 128, b: 0 }
    default:
        return null
    }
}

/** another score is shown: its events are rendered when needed */
function switchScore(): void {
    const score = currentScore()
    if (score === s_score) {
        return
    }
    s_removeLoopListener?.()
    s_score = score
    s_dirty = true
    s_channels = []
    s_removeLoopListener = score ? notationPlayback(score).onLoopBoundariesChanged(() => {
        updateLoop()
        publish({ loopVersion: state.loopVersion + 1 })
    }) : null
}

/**
 * the sounds of the channels and the play time without rendering the events: the preview notes and seeking while
 * stopped need no events (the MIDI renderer also sets the notes' play events, CompatMidiRender::createPlayEvents,
 * which the status bar shows: only when playing, like after a MIDI export in MuseScore)
 */
function updateChannels(): void {
    switchScore()
    const score = currentScore()
    if (!score || !s_dirty) {
        return
    }
    const playback = notationPlayback(score)
    playback.playRepeats = pb().playRepeats
    if (playback.tempoMultiplier() !== s_tempoMultiplier) {
        playback.setTempoMultiplier(s_tempoMultiplier)
    }
    s_channels = playback.channels()
    s_metronomeChannel = s_channels.reduce((m, c) => Math.max(m, c.channel + 1), 0)
    player.setDuration(playback.totalPlayTime())
}

/** renders the events of the score again if it changed since (C++: the playback model follows the score changes) */
function updateEvents(): void {
    switchScore()
    const score = currentScore()
    if (!score || !s_dirty) {
        return
    }
    s_dirty = false
    const playback = notationPlayback(score)
    playback.playRepeats = pb().playRepeats
    playback.playChordSymbols = pb().playChordSymbols
    if (playback.tempoMultiplier() !== s_tempoMultiplier) {
        playback.setTempoMultiplier(s_tempoMultiplier)
    }
    const rendered = playback.renderMidiEvents()
    s_channels = rendered.channels
    s_metronomeChannel = s_channels.reduce((m, c) => Math.max(m, c.channel + 1), 0)

    const events: PlayerEvent[] = []
    for (const e of rendered.events) {
        const pe = toPlayerEvent(e)
        if (pe) {
            events.push(pe)
        }
    }
    for (const e of playback.metronomeEvents()) {
        events.push({ time: e.time, channel: s_metronomeChannel, type: e.dataB ? 'on' : 'off', a: e.dataA, b: e.dataB, metronome: true })
    }
    events.sort((a, b) => a.time - b.time)

    const setups = new Map<number, SynthChannelSetup>()
    for (const c of s_channels) {
        setups.set(c.channel, channelSetup(c))
    }
    const metronome = playback.metronomeProgram()
    setups.set(s_metronomeChannel, {
        program: metronome.program, bank: metronome.bank, drum: metronome.bank >= 128, volume: 100, pan: 64, reverb: 0, chorus: 0,
    })

    // the play position stays at its tick (the times change with the tempo)
    const tick = state.tick
    const wasPlaying = player.isPlaying()
    player.setEvents(events, rendered.totalPlayTime, setups)
    updateMutedChannels()
    publish({ totalTime: rendered.totalPlayTime })
    updateLoop()
    if (wasPlaying || player.position() > 0) {
        const pos = playback.playedTickToSec(playback.playPositionTickByRawTick(tick))
        if (Math.abs(pos - player.position()) > 0.05) {
            player.seek(pos)
        }
    }
    updatePosition()
}

/** the parts that are not played: invisible ones; with a range selection the parts of other staves (range playback) */
function updateMutedChannels(): void {
    const score = currentScore()
    const rangeParts = score && !scoreViewState().noteInput ? rangeSelectionPartIds(score) : []
    const muted = new Set<number>()
    for (const c of s_channels) {
        if (c.muted || (rangeParts.length && !rangeParts.includes(c.partId))) {
            muted.add(c.channel)
        }
    }
    player.mutedChannels = muted
}

// ---------------------------------------------------------------------------------
//   the play position
// ---------------------------------------------------------------------------------

let s_frame = 0
const positionListeners = new Set<(tick: number, playing: boolean) => void>()

/** the view moves the playback cursor (each frame while playing) */
export function onPlaybackPosition(listener: (tick: number, playing: boolean) => void): () => void {
    positionListeners.add(listener)
    return () => positionListeners.delete(listener)
}

function updatePosition(): void {
    const playback = currentPlayback()
    if (!playback) {
        return
    }
    const position = player.position()
    const tick = playback.secToTick(position)
    const playing = player.isPlaying()
    publish({
        position, tick, playing, beat: playback.beat(tick), tempo: playback.multipliedTempo(tick),
        tempoMultiplier: playback.tempoMultiplier(),
    })
    for (const l of positionListeners) {
        l(tick, playing)
    }
}

function frame(): void {
    s_frame = 0
    updatePosition()
    if (player.isPlaying()) {
        s_frame = requestAnimationFrame(frame)
    }
}

function startFrames(): void {
    if (!s_frame) {
        s_frame = requestAnimationFrame(frame)
    }
}

player.onEnded = (): void => {
    updatePosition()
}

// ---------------------------------------------------------------------------------
//   PlaybackController
// ---------------------------------------------------------------------------------

function isPlayAllowed(): boolean {
    const score = currentScore()
    return !!score && scoreViewState().hasScore
}

function isPlaying(): boolean {
    return player.isPlaying()
}

function totalPlayTime(): number {
    return state.totalTime
}

function seek(secs: number): void {
    player.seek(secs)
    updatePosition()
}

function seekRawTick(tick: number): void {
    const playback = currentPlayback()
    if (!playback || state.tick === tick) {
        return
    }
    updateChannels()
    seek(playback.playedTickToSec(playback.playPositionTickByRawTick(tick)))
}

/** PlaybackController::playbackStartSecs: the loop start, else 0 */
function playbackStartSecs(): number {
    const playback = currentPlayback()
    if (!playback) {
        return 0
    }
    const loop = playback.loopBoundaries()
    if (loop.enabled) {
        // Convert from raw ticks (visual tick != playback tick due to repeats etc)
        return playback.playedTickToSec(playback.playPositionTickByRawTick(loop.loopInTick.ticks()))
    }
    return 0
}

async function play(): Promise<void> {
    resumeAudio()
    if (!(await ensureSynthLoaded())) {
        return
    }
    updateEvents()
    if (isLoopEnabled()) {
        seek(playbackStartSecs())
    }
    startPlayer()
}

/** the player starts (after the count-in clicks if enabled) */
function startPlayer(): void {
    const playback = currentPlayback()
    if (!playback) {
        return
    }
    let delay = 0
    if (pb().countIn) {
        const countIn = playback.countInEvents(state.tick)
        const now = synth.currentTime() + 0.05
        for (const e of countIn.events) {
            if (e.dataB) {
                synth.noteOn(s_metronomeChannel, e.dataA, e.dataB, now + e.time)
            } else {
                synth.noteOff(s_metronomeChannel, e.dataA, now + e.time)
            }
        }
        delay = countIn.duration + 0.05
    }
    player.play(delay)
    publish({ playing: true })
    startFrames()
}

function pause(select = false): void {
    if (!isPlaying()) {
        return
    }
    player.pause()
    updatePosition()
    if (select) {
        const score = currentScore()
        if (score) {
            findAndSelectChordRest(score, state.tick)
            selectionChanged(true)
        }
    }
}

function stop(): void {
    player.stop()
    updatePosition()
}

function resume(): void {
    resumeAudio()
    startPlayer()
}

function togglePlay(): void {
    if (!isPlayAllowed()) {
        return
    }
    if (isPlaying()) {
        pause()
    } else if (state.position > 0) {
        updateEvents()
        const pos = player.position()
        if (pos >= totalPlayTime() - 1e-6) {
            seek(playbackStartSecs())
        }
        resume()
    } else {
        void play()
    }
}

function playFromSelection(): void {
    const score = currentScore()
    const playback = currentPlayback()
    if (!score || !playback) {
        return
    }
    const sel = selectionPlaybackInfo(score)
    let startTick = 0
    if (!sel.isNone) {
        startTick = sel.rangeStartTick >= 0 ? sel.rangeStartTick : Math.min(...sel.elements.map(e => e.tick().ticks()))
    }
    const loop = playback.loopBoundaries()
    if (loop.enabled) {
        if (startTick < loop.loopInTick.ticks() || startTick > loop.loopOutTick.ticks()) {
            startTick = loop.loopInTick.ticks()
        }
    }
    resumeAudio()
    void ensureSynthLoaded().then((ok) => {
        if (!ok) {
            return
        }
        updateEvents()
        seek(playback.playedTickToSec(playback.playPositionTickByRawTick(startTick)))
        if (!isPlaying()) {
            startPlayer()
        }
    })
}

function rewind(): void {
    const startSecs = playbackStartSecs()
    seek(Math.max(startSecs, Math.min(0, totalPlayTime())))
}

function isLoopEnabled(): boolean {
    return !!currentPlayback()?.isLoopEnabled()
}

function updateLoop(): void {
    const playback = currentPlayback()
    if (!playback) {
        return
    }
    const boundaries = playback.loopBoundaries()
    if (!boundaries.enabled) {
        player.resetLoop()
        publish({ loopEnabled: false })
        return
    }
    const from = playback.playedTickToSec(playback.playPositionTickByRawTick(boundaries.loopInTick.ticks()))
    const to = playback.playedTickToSec(playback.playPositionTickByRawTick(boundaries.loopOutTick.ticks()))
    player.setLoop(from, to)
    publish({ loopEnabled: playback.isLoopEnabled() })
}

function enableLoop(): void {
    currentPlayback()?.setLoopBoundariesEnabled(true)
    updateLoop()
}

function disableLoop(): void {
    player.resetLoop()
    currentPlayback()?.setLoopBoundariesEnabled(false)
    updateLoop()
}

function toggleLoopPlayback(): void {
    const score = currentScore()
    const playback = currentPlayback()
    if (!score || !playback) {
        return
    }
    if (isLoopEnabled()) {
        disableLoop()
        return
    }
    const sel = selectionPlaybackInfo(score)
    if (!playback.loopBoundariesIsNull() && sel.rangeStartTick < 0) {
        enableLoop()
        return
    }

    let loopInTick = 0
    let loopOutTick = 0

    if (!sel.isNone) {
        if (sel.rangeStartTick >= 0) {
            loopInTick = sel.rangeStartTick
            loopOutTick = sel.rangeEndTick
        } else {
            // C++ selectionRange()->startTick()/endTick() of a list selection
            loopInTick = Math.min(...sel.elements.map(e => e.tick().ticks()))
            loopOutTick = Math.max(...sel.elements.map(e => e.tick().ticks()))
        }
    }

    if (loopInTick <= 0) {
        loopInTick = BoundaryTick.FirstScoreTick
    }

    if (loopOutTick <= 0) {
        loopOutTick = BoundaryTick.LastScoreTick
    }

    addLoopBoundaryToTick(LoopBoundaryType.LoopIn, loopInTick)
    addLoopBoundaryToTick(LoopBoundaryType.LoopOut, loopOutTick)
}

function addLoopBoundary(type: LoopBoundaryType): void {
    if (isPlaying()) {
        addLoopBoundaryToTick(type, state.tick)
    } else {
        addLoopBoundaryToTick(type, BoundaryTick.SelectedNoteTick)
    }
}

function addLoopBoundaryToTick(type: LoopBoundaryType, tick: number): void {
    const playback = currentPlayback()
    if (playback) {
        playback.addLoopBoundary(type, tick)
        enableLoop()
    }
}

function setTempoMultiplier(multiplier: number): void {
    if (Math.abs(multiplier - s_tempoMultiplier) < 1e-9) {
        return
    }
    s_tempoMultiplier = multiplier
    s_dirty = true
    updateEvents()
    publish({ tempoMultiplier: multiplier })
}

export function tempoMultiplier(): number {
    return s_tempoMultiplier
}

/** PlaybackToolBarModel::setPlayTime / setPlayPosition: the "rewind" to a time */
export function rewindTo(secs: number): void {
    const start = playbackStartSecs()
    seek(Math.max(start, Math.min(secs, totalPlayTime())))
}

/** PlaybackToolBarModel::rewindToBeat */
export function rewindToBeat(measureIndex: number, beatIndex: number): void {
    rewindTo(beatToSecs(measureIndex, beatIndex))
}

function beatToSecs(measureIndex: number, beatIndex: number): number {
    const playback = currentPlayback()
    if (!playback) {
        return 0
    }
    const tick = playback.beatToRawTick(measureIndex, beatIndex)
    return playback.playedTickToSec(playback.playPositionTickByRawTick(tick))
}

export { setTempoMultiplier, isPlayAllowed, ensureSynthLoaded }

// ---------------------------------------------------------------------------------
//   the notes heard while editing (PlaybackController::playElements / playNotes)
// ---------------------------------------------------------------------------------

/**
 * plays notes now for a time (the preview); the sounds are loaded first if needed. INFINITE_DURATION: the note on only,
 * duration 0: the note off only. A MIDI event is no user gesture: until a gesture has started the audio output its
 * notes are not played (they would all sound at that moment).
 */
function playPreview(notes: { channel: number; pitch: number; velocity: number; duration: number }[], flushSound: boolean, midiEvent = false): void {
    if (!notes.length) {
        return
    }
    resumeAudio()
    void ensureSynthLoaded().then((ok) => {
        if (!ok) {
            return
        }
        if (midiEvent && !synth.isRunning()) {
            return
        }
        updateChannels()
        const now = synth.currentTime()
        if (flushSound && !isPlaying()) {
            synth.stopAll(false)
        }
        for (const c of new Set(notes.map(n => n.channel))) {
            const setup = s_channels.find(x => x.channel === c)
            if (setup) {
                synth.setupChannel(c, channelSetup(setup), now)
            }
        }
        for (const n of notes) {
            if (n.duration > 0) {
                synth.noteOn(n.channel, n.pitch, n.velocity, now)
            }
            if (n.duration !== INFINITE_DURATION) {
                synth.noteOff(n.channel, n.pitch, now + n.duration)
            }
        }
    })
}

/** the notes of a MIDI device that was disconnected while its keys were held */
export function stopHeldPreviewNotes(): void {
    if (!isPlaying()) {
        synth.stopAll(false)
    }
}

const MODWHEEL_CONTROLLER = 1
const SUSTAIN_PEDAL_CONTROLLER = 64

const controller: IPlaybackController = {
    isPlaying,
    isLoopEnabled,
    currentBeat: () => state.beat,
    reset: stop,

    playElements(elements: readonly EngravingItem[], params: PlayParams = {}, isMidi = false): void {
        const playback = currentPlayback()
        if (!playback || !pb().playNotesWhenEditing || (isMidi && !pb().playNotesOnMidiInput)) {
            return
        }
        const elementsForPlaying = elements.filter((e) => {
            if (!e || !e.isPlayable()) {
                return false
            }
            if (e.isChord() && !pb().playChordWhenEditing) {
                return false
            }
            if (e.isHarmony() && !pb().playHarmonyWhenEditing) {
                return false
            }
            return true
        })
        const duration = params.duration ?? pb().notePlayDuration / 1000
        playPreview(playback.triggerEventsForItems(elementsForPlaying, duration, pb().playPreviewNotesWithScoreDynamics),
            params.flushSound ?? true, params.midiEvent)
    },

    playNotes(notes: readonly NoteVal[], staffIdx: number, segment: Segment, params: PlayParams = {}): void {
        const playback = currentPlayback()
        // the notation scene calls it where C++ checks NotationConfiguration::isPlayPreviewNotesInInputByDuration
        // (the library's action controller assumes true; the preference is here)
        if (!playback || !pb().playNotesWhenEditing || !pb().playPreviewNotesInInputByDuration) {
            return
        }
        const duration = params.duration ?? pb().notePlayDuration / 1000
        playPreview(playback.previewNotesForNoteVals(notes, staffIdx, segment, duration), params.flushSound ?? true, params.midiEvent)
    },

    playMetronome(tick: number): void {
        void tick
        playPreview([{ channel: s_metronomeChannel, pitch: 77, velocity: 80, duration: 0.1 }], false)
    },

    triggerControllers(list: readonly ControllerChangeEvent[], staffIdx: number, tick: number): void {
        const channel = currentPlayback()?.channelOfStaff(staffIdx, tick) ?? -1
        if (channel < 0 || !synth.isLoaded()) {
            return
        }
        for (const cc of list) {
            if (cc.type === ControllerChangeType.PitchBend) {
                synth.pitchBend(channel, Math.round(cc.val * 16383))
            } else {
                synth.controller(channel, cc.type === ControllerChangeType.Modulation ? MODWHEEL_CONTROLLER : SUSTAIN_PEDAL_CONTROLLER, Math.round(cc.val * 127))
            }
        }
    },

    seekElement(element: EngravingItem | null): void {
        const playback = currentPlayback()
        if (!playback || !element) {
            return
        }
        updateChannels()
        seek(playback.playedTickToSec(playback.playPositionTickByElement(element)))
    },

    seekBeat(measureIndex: number, beatIndex: number): void {
        seek(beatToSecs(measureIndex, beatIndex))
    },
}

setPlaybackController(controller)

// ---------------------------------------------------------------------------------
//   score changes and selection
// ---------------------------------------------------------------------------------

let s_scoreVersion = -1
let s_selectionVersion = -1
let s_changeTimer = 0

onScoreViewChanged(() => {
    const v = scoreViewState()
    if (currentScore() !== s_score) {
        player.stop()
        player.resetLoop()
        player.setEvents([], 0, new Map())
        switchScore()
        publish({ playing: false, position: 0, tick: 0, totalTime: 0, loopEnabled: false, loopVersion: state.loopVersion + 1 })
        updatePosition()
    }
    if (v.scoreVersion !== s_scoreVersion) {
        s_scoreVersion = v.scoreVersion
        s_dirty = true
        // while playing the changes are heard soon; otherwise the events are rendered when needed
        if (player.isPlaying()) {
            clearTimeout(s_changeTimer)
            s_changeTimer = window.setTimeout(updateEvents, 250)
        }
        publish({ loopVersion: state.loopVersion + 1 })
    }
    if (v.selectionVersion !== s_selectionVersion) {
        s_selectionVersion = v.selectionVersion
        onSelectionChanged()
    }
})

/** PlaybackController::onSelectionChanged: a range selection is played (its parts, from its start) */
function onSelectionChanged(): void {
    const score = currentScore()
    if (!score) {
        return
    }
    updateMutedChannels()
    const sel = selectionPlaybackInfo(score)
    if (sel.rangeStartTick >= 0) {
        player.resetLoop()
        seekRawTick(sel.rangeStartTick)
    } else {
        updateLoop()
    }
}

// ---------------------------------------------------------------------------------
//   the actions (PlaybackController::init, PlaybackUiActions)
// ---------------------------------------------------------------------------------

function toggleSetting(key: keyof PlaybackSettings, after?: () => void): void {
    setPb({ [key]: !pb()[key] } as Partial<PlaybackSettings>)
    after?.()
    actionsChanged()
}

export function setMuted(muted: boolean): void {
    setPb({ muted })
    synth.setMuted(muted)
    publish({ muted })
}

export function registerPlaybackActions(): void {
    const allowed = isPlayAllowed
    registerAction('play', { run: togglePlay, enabled: allowed, context: 'notation' })
    registerAction('play-from-selection', { run: playFromSelection, enabled: allowed, context: 'notation' })
    registerAction('pause', { run: () => pause(false), enabled: allowed, context: 'notation' })
    registerAction('pause-and-select', { run: () => pause(true), enabled: allowed, context: 'notation' })
    registerAction('stop', { run: stop, enabled: allowed, context: 'notation' })
    registerAction('rewind', { run: rewind, enabled: allowed, context: 'notation' })
    registerAction('loop', { run: toggleLoopPlayback, enabled: allowed, checked: isLoopEnabled, context: 'notation' })
    registerAction('loop-in', { run: () => addLoopBoundary(LoopBoundaryType.LoopIn), enabled: allowed, context: 'notation' })
    registerAction('loop-out', { run: () => addLoopBoundary(LoopBoundaryType.LoopOut), enabled: allowed, context: 'notation' })
    registerAction('repeat', { run: () => toggleSetting('playRepeats', () => { s_dirty = true; updateEvents() }), checked: () => pb().playRepeats })
    registerAction('play-chord-symbols', { run: () => toggleSetting('playChordSymbols', () => { s_dirty = true; updateEvents() }), checked: () => pb().playChordSymbols })
    registerAction('pan', { run: () => toggleSetting('pan'), checked: () => pb().pan })
    // MuseScore's advanced setting "application/playback/smoothPan" (NotationSceneConfiguration::isSmoothPanning)
    registerAction('smooth-pan', { run: () => toggleSetting('smoothPan'), checked: () => pb().smoothPan }, {
        title: ['notation', 'Smooth panning'], description: [null, 'Continuous view (horizontal): the score moves smoothly with the playback cursor'],
        checkable: true,
    })
    registerAction('metronome', {
        run: () => toggleSetting('metronome', () => { player.metronomeEnabled = pb().metronome }),
        checked: () => pb().metronome,
    })
    registerAction('countin', { run: () => toggleSetting('countIn'), checked: () => pb().countIn })
    registerAction('toggle-hear-playback-when-editing', { run: () => toggleSetting('playNotesWhenEditing'), checked: () => pb().playNotesWhenEditing })
    // the sound output of the browser (not in MuseScore)
    registerAction('playback-mute', { run: () => setMuted(!pb().muted), checked: () => pb().muted }, {
        title: [null, 'Mute'], description: [null, 'Mute the sound output'], icon: ICON_CODES.AUDIO, checkable: true,
    })
}
