/*
 * SPDX-License-Identifier: GPL-3.0-only
 * MuseEncore — port of MuseScore Studio (https://github.com/musescore/MuseScore)
 * Copyright (C) 2021-2026 MuseScore Limited and others
 *
 * Port of src/notation/internal/notationplayback.h/.cpp without the mpe PlaybackModel: loop boundaries, play position
 * <-> time, tempo, beats, the total play time.
 * Deviation: MuseScore 4 renders the sound with its PlaybackModel (mpe events for Muse Sounds / FluidSynth). Here the
 * events come from MuseScore's MIDI renderer (compat/midi, used by the MIDI export): renderMidiEvents(), the metronome
 * and count-in clicks (PlaybackEventsRenderer::renderMetronome / renderCountIn, as wood block notes of a GM drum kit)
 * and the preview notes of triggerEventsForItems().
 */

import { Fraction } from '../../engraving/types/fraction'
import { Constants } from '../../engraving/types/constants'
import { VOICES } from '../../engraving/types/types'
import { CompatMidiRender } from '../../engraving/compat/midi/compatmidirender'
import { Context, HarmonyChannelSetting } from '../../engraving/compat/midi/compatmidirenderinternal'
import { EventsHolder } from '../../engraving/compat/midi/event'
import { ME_CONTROLLER, ME_NOTEON, ME_PITCHBEND } from '../../engraving/compat/midi/midicoreevent'
import type { Chord } from '../../engraving/dom/chord'
import type { Dynamic } from '../../engraving/dom/dynamic'
import type { EngravingItem } from '../../engraving/dom/engravingitem'
import type { Harmony } from '../../engraving/dom/harmony'
import type { MasterScore } from '../../engraving/dom/masterscore'
import type { Measure } from '../../engraving/dom/measure'
import type { Note } from '../../engraving/dom/note'
import { LoopBoundaryType } from '../../engraving/dom/score'
import { ticks_beat } from '../../engraving/dom/sig'
import type { NoteVal } from '../../engraving/dom/input'
import type { Segment } from '../../engraving/dom/segment'
import { InstrChannel } from '../../engraving/dom/instrument'
import { PlaybackSetupDataResolver } from '../../engraving/playback/playbacksetupdataresolver'
import { articulationSounds, findPrograms, type MidiProgram } from '../../framework/audio/fluidsynth/soundmapping'

const PLAYBACK_TAIL_SECS = 3

/** INotationPlayback::BoundaryTick */
export enum BoundaryTick {
    FirstScoreTick = 0,
    SelectedNoteTick,
    LastScoreTick,
}

/** notationtypes.h LoopBoundaries */
export interface LoopBoundaries {
    loopInTick: Fraction
    loopOutTick: Fraction
    enabled: boolean
}

/** types.h MeasureBeat */
export interface MeasureBeat {
    measureIndex: number
    maxMeasureIndex: number
    beat: number
    maxBeatIndex: number
}

/** a MIDI event of the playback: a note on (velocity 0: note off), controller or pitch bend */
export interface PlaybackMidiEvent {
    /** the tick in the unrolled score (repeats played) */
    utick: number
    /** seconds from the start */
    time: number
    /** ME_NOTEON, ME_CONTROLLER (dataA CTRL_PROGRAM: program change) or ME_PITCHBEND */
    type: number
    /** the synthesizer channel (synthChannel(): instrument channel and voice) */
    channel: number
    dataA: number
    dataB: number
    /** the staff that produced the event */
    staffIdx: number
}

/** the sound of a synthesizer channel: a voice of a MuseScore channel (InstrChannel) */
export interface PlaybackChannel {
    /** synthChannel(instrumentChannel, voice) */
    channel: number
    /** the MuseScore channel (InstrChannel::channel(), an index of the MIDI mapping) */
    instrumentChannel: number
    voice: number
    /** MIDI port and channel of the MIDI mapping (port * 16 + channel = the channel of a MIDI device) */
    midiPort: number
    midiChannel: number
    /** the soundfont preset (bank 128: drum kits) */
    program: number
    bank: number
    volume: number
    pan: number
    reverb: number
    chorus: number
    drum: boolean
    partId: string
    /** the name of the instrument channel ("normal", "pizzicato", "harmony", ...) */
    name: string
    /** the part is not played (Layout panel visibility, range playback of other parts) */
    muted: boolean
}

export interface PlaybackEvents {
    events: PlaybackMidiEvent[]
    channels: PlaybackChannel[]
    /** seconds, including the tail of 3 s (NotationPlayback::totalPlayTime) */
    totalPlayTime: number
    /** the unrolled ticks of the score */
    endUtick: number
}

/** a note to play now (preview): its synthesizer channel, pitch and velocity */
export interface PreviewNote {
    channel: number
    pitch: number
    velocity: number
    /** seconds */
    duration: number
}

/** the MuseScore channel of the metronome (after the channels of the score) */
export const METRONOME_CHANNEL_NAME = 'metronome'
/**
 * the ArticulationType of the sound of an instrument channel; the channels of the MIDI renderer replace the
 * articulations of the mpe events (ChannelMap::resolveChannelForEvent)
 */
const CHANNEL_ARTICULATIONS: ReadonlyMap<string, string> = new Map([
    ['pizzicato', 'Pizzicato'],
    ['mute', 'Mute'],
    [InstrChannel.PALM_MUTE_NAME, 'PalmMute'],
    ['tremolo', 'Tremolo16th'],
    ['jazz', 'JazzTone'],
    ['harmonics', 'Harmonic'],
    ['flageoletti', 'Harmonic'],
    ['distortion', 'Distortion'],
    ['overdriven', 'Overdrive'],
    ['slap', 'Slap'],
    ['pop', 'Pop'],
])

/** the drum kits are in bank 128 of the soundfont */
const PERCUSSION_BANK = 128

/**
 * the synthesizer channel of a voice of a MuseScore channel: like MuseScore 4's Fluid synth (ChannelMap of
 * soundmapping.h) each voice has its own channel (the articulations have their MuseScore channels), so that the pitch
 * bends and pedals of a voice do not affect the others
 */
export function synthChannel(instrumentChannel: number, voice: number): number {
    return instrumentChannel * VOICES + voice
}

const HIGH_WOOD_BLOCK = 76 // pitchLevel(PitchClass::E, 5)
const LOW_WOOD_BLOCK = 77 // pitchLevel(PitchClass::F, 5)
const METRONOME_VELOCITY = 80 // dynamicLevelFromType(mpe::DynamicType::mf)

/** C++ findBeat (dom/utils.cpp) */
export function findBeat(score: MasterScore, tick: number): MeasureBeat {
    const measureBeat: MeasureBeat = { measureIndex: 0, maxMeasureIndex: 0, beat: 0, maxBeatIndex: 0 }
    if (!score.firstMeasure()) {
        return measureBeat
    }

    const [measureIndex, beatIndex, ticks] = score.sigmap().tickValues(tick)
    measureBeat.measureIndex = measureIndex

    const timeSig = score.sigmap().timesig(Fraction.fromTicks(tick)).timesig()
    const ticksB = ticks_beat(timeSig.denominator())

    measureBeat.beat = beatIndex + Math.fround(ticks / ticksB)
    measureBeat.maxMeasureIndex = score.measures().size() - 1
    measureBeat.maxBeatIndex = timeSig.numerator() - 1

    return measureBeat
}

export class NotationPlayback {
    private m_loopBoundaries: LoopBoundaries = { loopInTick: new Fraction(0, 1), loopOutTick: new Fraction(0, 1), enabled: false }
    private m_loopBoundariesChanged = new Set<() => void>()
    private m_removeLoopListener: (() => void) | null = null

    /** NotationConfiguration::isPlayRepeatsEnabled */
    playRepeats = true
    /** NotationConfiguration::isPlayChordSymbolsEnabled */
    playChordSymbols = true

    constructor(private m_score: MasterScore) {
        this.m_removeLoopListener = m_score.onLoopBoundaryTickChanged(() => this.updateLoopBoundaries())
    }

    score(): MasterScore { return this.m_score }

    dispose(): void {
        this.m_removeLoopListener?.()
    }

    /** the MIDI events of the whole score, ordered by time (TODO(port): mpe PlaybackModel) */
    renderMidiEvents(): PlaybackEvents {
        const score = this.m_score
        const events = new EventsHolder()
        const ctx = new Context()
        ctx.eachStringHasChannel = false
        ctx.instrumentsHaveEffects = false
        ctx.harmonyChannelSetting = this.playChordSymbols ? HarmonyChannelSetting.DEFAULT : HarmonyChannelSetting.DISABLED
        ctx.sndController = CompatMidiRender.getControllerForSnd(score, -1)
        ctx.useDefaultArticulations = false
        ctx.applyCaesuras = false
        ctx.eachVoiceHasChannel = true
        ctx.renderMidiActions = false
        // the lookup channels (instrument channel + voice) are numbered after the instrument channels: events of an
        // instrument channel without lookup channels (spanners of a staff without notes, chord symbols) are told apart
        let instrumentChannels = score.midiMapping().length
        for (const part of score.parts()) {
            for (const instr of part.instruments().values()) {
                for (const c of instr.channels()) {
                    instrumentChannels = Math.max(instrumentChannels, c.channel() + 1)
                }
            }
        }
        ctx.channels.maxChannel = instrumentChannels

        if (score.firstMeasure()) {
            CompatMidiRender.renderScore(score, events, ctx, this.playRepeats)
        }

        const toSynthChannel = new Map<number, number>()
        for (const [instrumentChannel, lookups] of ctx.channels.channelsMap) {
            for (const [lookupData, channel] of lookups) {
                toSynthChannel.set(channel, synthChannel(instrumentChannel, lookupData.voice))
            }
        }
        const channelOf = (e: { channel(): number }): number => toSynthChannel.get(e.channel()) ?? synthChannel(e.channel(), 0)

        const repeatList = score.repeatList(this.playRepeats)
        const out: PlaybackMidiEvent[] = []
        for (const map of events.channels()) {
            for (const [utick, e] of map) {
                const type = e.type()
                if (type === ME_NOTEON) {
                    // C++ ExportMidi: a duplicated note off is ignored, a restrike turns the note off first
                    if (e.discard() && e.velo() === 0) {
                        continue
                    }
                    if (e.discard() && e.velo() > 0) {
                        out.push({ utick, time: 0, type, channel: channelOf(e), dataA: e.pitch(), dataB: 0, staffIdx: e.getOriginatingStaff() })
                    }
                } else if (type !== ME_CONTROLLER && type !== ME_PITCHBEND) {
                    continue
                }
                out.push({ utick, time: 0, type, channel: channelOf(e), dataA: e.dataA(), dataB: e.dataB(), staffIdx: e.getOriginatingStaff() })
            }
        }
        for (const e of out) {
            e.time = repeatList.utick2utime(e.utick)
        }
        // stable sort: the events of a channel keep the order of the renderer (C++ multimap)
        out.sort((a, b) => a.utick - b.utick)

        const endUtick = repeatList.ticks()
        const used = new Set(out.map(e => e.channel))
        const channels = this.channels().filter(c => used.has(c.channel))
        return { events: out, channels, totalPlayTime: this.totalPlayTime(), endUtick }
    }

    /**
     * the sounds of the synthesizer channels (the voices of the MuseScore channels of all instruments of all parts):
     * the presets of MuseScore 4's Fluid synth (PlaybackSetupDataResolver + soundmapping.h), not the bank and program
     * of the channel
     */
    channels(): PlaybackChannel[] {
        const score = this.m_score
        const result: PlaybackChannel[] = []
        for (const part of score.parts()) {
            for (const instr of part.instruments().values()) {
                const setupData = PlaybackSetupDataResolver.resolveSetupData(instr)
                const standardProgram = findPrograms(setupData)[0]
                const articulations = articulationSounds(setupData)
                for (const c of instr.channels()) {
                    let preset: MidiProgram
                    if (c.name() === InstrChannel.HARMONY_NAME) {
                        preset = findPrograms(PlaybackSetupDataResolver.resolveChordSymbolsSetupData(instr))[0]
                    } else {
                        const articulation = articulations.get(CHANNEL_ARTICULATIONS.get(c.name()) ?? '')
                        preset = articulation ? { bank: articulation[0], program: articulation[1] } : standardProgram
                    }
                    const idx = c.channel()
                    const mapping = score.midiMapping()[idx]
                    for (let voice = 0; voice < VOICES; ++voice) {
                        result.push({
                            channel: synthChannel(idx, voice),
                            instrumentChannel: idx,
                            voice,
                            midiPort: mapping ? mapping.port() : 0,
                            midiChannel: mapping ? mapping.channel() : idx % 16,
                            program: preset.program,
                            bank: preset.bank,
                            volume: c.volume(),
                            pan: c.pan(),
                            reverb: c.reverb(),
                            chorus: c.chorus(),
                            drum: preset.bank >= PERCUSSION_BANK,
                            partId: part.id(),
                            name: c.name(),
                            muted: !part.show(),
                        })
                    }
                }
            }
        }
        result.sort((a, b) => a.channel - b.channel)
        return result
    }

    /** the preset of the metronome (resolveMetronomeSetupData) */
    metronomeProgram(): MidiProgram {
        return findPrograms(PlaybackSetupDataResolver.resolveMetronomeSetupData())[0]
    }

    /** PlaybackEventsRenderer::renderMetronome for all measures of the repeat list (note on/off pairs; channel -1) */
    metronomeEvents(): PlaybackMidiEvent[] {
        const score = this.m_score
        const repeatList = score.repeatList(this.playRepeats)
        const out: PlaybackMidiEvent[] = []
        for (const rs of repeatList) {
            const tickPositionOffset = rs.utick - rs.tick
            for (const measure of rs.measureList()) {
                this.renderMetronome(measure, tickPositionOffset, out)
            }
        }
        for (const e of out) {
            e.time = repeatList.utick2utime(e.utick)
        }
        return out
    }

    private renderMetronome(measure: Measure, ticksPositionOffset: number, result: PlaybackMidiEvent[]): void {
        const score = this.m_score
        const measureStartTick = measure.tick().ticks()
        const measureEndTick = measure.endTick().ticks()

        const timeSignatureFraction = score.sigmap().timesig(measureStartTick).nominal()
        const bps = score.tempomap().multipliedTempo(measureStartTick)

        const step = timeSignatureFraction.isBeatedCompound(bps)
            ? timeSignatureFraction.beatTicks() : timeSignatureFraction.dUnitTicks()

        let startTick = measureStartTick
        let rtick = 0

        if (measure.isAnacrusis()) {
            const remainingTicks = measure.ticks().ticks() % step
            startTick += remainingTicks
            rtick = remainingTicks + timeSignatureFraction.ticksPerMeasure() - measure.ticks().ticks()
        }

        const ticksPerBeat = Math.trunc(timeSignatureFraction.ticks() / timeSignatureFraction.numerator())
        for (let tick = startTick; tick < measureEndTick; tick += step, rtick += step) {
            const beatType = timeSignatureFraction.rtick2beatType(rtick)
            const pitch = beatType === 0 /* BeatType::DOWNBEAT */ ? HIGH_WOOD_BLOCK : LOW_WOOD_BLOCK
            const utick = tick + ticksPositionOffset
            result.push({ utick, time: 0, type: ME_NOTEON, channel: -1, dataA: pitch, dataB: METRONOME_VELOCITY, staffIdx: -1 })
            result.push({ utick: utick + ticksPerBeat, time: 0, type: ME_NOTEON, channel: -1, dataA: pitch, dataB: 0, staffIdx: -1 })
        }
    }

    /**
     * PlaybackEventsRenderer::renderCountIn: the clicks before playing from tick (raw tick of the score);
     * times relative to the start of the count-in; the count-in duration in seconds
     */
    countInEvents(startTick: number): { events: PlaybackMidiEvent[]; duration: number } {
        const score = this.m_score
        const result: PlaybackMidiEvent[] = []
        const measure = score.tick2measure(Fraction.fromTicks(startTick))
        if (!measure) {
            return { events: result, duration: 0 }
        }

        const measureStartTick = measure.tick().ticks()
        const timeSignatureFraction = score.sigmap().timesig(measureStartTick).nominal()
        const bps = score.tempomap().multipliedTempo(measureStartTick)
        const ticksPerMeasure = timeSignatureFraction.ticksPerMeasure()

        const step = timeSignatureFraction.isBeatedCompound(bps)
            ? timeSignatureFraction.beatTicks() : timeSignatureFraction.dUnitTicks()

        const durationFromTempoAndTicks = (ticks: number): number => ticks / (bps * Constants.DIVISION)
        const stepDuration = durationFromTempoAndTicks(step)

        // Add extra clicks if...
        let endTick = ticksPerMeasure + (startTick - measureStartTick) // ... not starting playback at beginning of measure
        let remainingTicks = 0

        if (measure.isAnacrusis()) { // ... measure is incomplete (anacrusis)
            const measureTicks = measure.ticks().ticks()
            endTick += ticksPerMeasure - measureTicks
            remainingTicks = measureTicks % step
        }

        const measureBeat = findBeat(score, startTick)
        const closestMainBeatTick = score.sigmap().bar2tick(measureBeat.measureIndex, Math.ceil(measureBeat.beat))
        remainingTicks += closestMainBeatTick - startTick

        const ticksPerBeat = Math.trunc(timeSignatureFraction.ticks() / timeSignatureFraction.numerator())
        const beatDuration = durationFromTempoAndTicks(ticksPerBeat)
        let eventTimestamp = 0

        for (let tick = 0; tick < endTick; tick += step) {
            const rtick = tick % ticksPerMeasure
            const beatType = timeSignatureFraction.rtick2beatType(rtick)
            const pitch = beatType === 0 /* BeatType::DOWNBEAT */ ? HIGH_WOOD_BLOCK : LOW_WOOD_BLOCK
            result.push({ utick: -1, time: eventTimestamp, type: ME_NOTEON, channel: -1, dataA: pitch, dataB: METRONOME_VELOCITY, staffIdx: -1 })
            result.push({ utick: -1, time: eventTimestamp + beatDuration, type: ME_NOTEON, channel: -1, dataA: pitch, dataB: 0, staffIdx: -1 })
            eventTimestamp += stepDuration
        }

        let countInDuration = eventTimestamp
        if (remainingTicks > 0) {
            countInDuration -= durationFromTempoAndTicks(remainingTicks)
        }
        return { events: result, duration: countInDuration }
    }

    /**
     * the notes of the items (notes, chords, chord symbols) to play now (C++ triggerEventsForItems: PlaybackModel);
     * duration in seconds
     */
    triggerEventsForItems(items: readonly EngravingItem[], duration: number, useScoreDynamics = false): PreviewNote[] {
        const result: PreviewNote[] = []
        const natural = 80 // mpe::DynamicType::Natural
        let velocity = natural
        if (useScoreDynamics && items.length) {
            velocity = this.dynamicVelocityAt(items[0]) ?? natural
        }
        const addNote = (note: Note): void => {
            if (!note.play()) {
                return
            }
            const chord = note.chord()
            const instr = chord.part()!.instrument(chord.tick())
            const c = instr.channel(note.subchannel()) ?? instr.channel(0)
            if (!c) {
                return
            }
            const pitch = Math.min(Math.max(note.ppitch(), 0), 127)
            // C++ PlaybackModel: the velocity of a MIDI key instead of the dynamics (RenderingContext::userVelocityFraction)
            const noteVelocity = note.userVelocity() > 0 ? note.userVelocity() : velocity
            result.push({ channel: synthChannel(c.channel(), note.voice()), pitch, velocity: noteVelocity, duration })
        }
        for (const item of items) {
            if (item.isNote()) {
                addNote(item as unknown as Note)
            } else if (item.isChord()) {
                for (const n of (item as unknown as Chord).notes()) {
                    addNote(n)
                }
            } else if (item.isHarmony()) {
                const h = item as unknown as Harmony
                const c = h.part()?.harmonyChannel()
                if (!h.isRealizable() || !c) {
                    continue
                }
                for (const [pitch] of h.getRealizedHarmony().notes()) {
                    result.push({ channel: synthChannel(c.channel(), 0), pitch, velocity, duration })
                }
            }
        }
        return result
    }

    /**
     * the velocity of the last dynamic before the item on its staff (C++ PlaybackContext::appliableDynamicLevel;
     * TODO(port): hairpins)
     */
    private dynamicVelocityAt(item: EngravingItem): number | null {
        const staffIdx = item.staffIdx()
        const tick = item.tick()
        const first = this.m_score.firstMeasure()
        if (!first) {
            return null
        }
        let result: number | null = null
        for (let s = first.first(); s && s.tick().le(tick); s = s.next1()) {
            for (const e of s.annotations()) {
                if (e.isDynamic() && e.staffIdx() === staffIdx) {
                    const v = (e as unknown as Dynamic).velocity()
                    if (v > 0) {
                        result = Math.min(Math.max(v, 1), 127)
                    }
                }
            }
        }
        return result
    }

    /**
     * the notes of the note input to play now (C++ PlaybackController::playNotes creates temporary notes on the
     * segment with these note values and plays them)
     */
    /** the synthesizer channel of a staff at a tick (the sound of the note input); -1 if there is none */
    channelOfStaff(staffIdx: number, tick: number): number {
        const staff = this.m_score.staff(staffIdx)
        const f = Fraction.fromTicks(tick)
        const instr = staff?.part().instrument(f)
        const c = staff && instr ? instr.channel(staff.channel(f, 0)) ?? instr.channel(0) : null
        return c ? synthChannel(c.channel(), 0) : -1
    }

    previewNotesForNoteVals(notes: readonly NoteVal[], staffIdx: number, segment: Segment, duration: number): PreviewNote[] {
        const staff = this.m_score.staff(staffIdx)
        if (!staff) {
            return []
        }
        const tick = segment.tick()
        const instr = staff.part().instrument(tick)
        const c = instr.channel(staff.channel(tick, 0)) ?? instr.channel(0)
        if (!c) {
            return []
        }
        const result: PreviewNote[] = []
        for (const nval of notes) {
            if (nval.pitch < 0) {
                continue
            }
            const pitch = Math.min(Math.max(nval.pitch + staff.pitchOffset(tick), 0), 127)
            result.push({ channel: synthChannel(c.channel(), 0), pitch, velocity: nval.velocityOverride > 0 ? nval.velocityOverride : 80, duration })
        }
        return result
    }

    // ------------------------------------------------------------------------------------------------------------
    //   positions and times (NotationPlayback)
    // ------------------------------------------------------------------------------------------------------------

    totalPlayTime(): number {
        const lastTick = this.m_score.repeatList(this.playRepeats).ticks()
        return this.m_score.repeatList(this.playRepeats).utick2utime(lastTick) + PLAYBACK_TAIL_SECS
    }

    playedTickToSec(tick: number): number {
        return this.m_score.repeatList(this.playRepeats).utick2utime(tick)
    }

    secToPlayedTick(sec: number): number {
        return this.m_score.repeatList(this.playRepeats).utime2utick(sec)
    }

    secToTick(sec: number): number {
        const utick = this.secToPlayedTick(sec)
        return this.m_score.repeatList(this.playRepeats).utick2tick(utick)
    }

    playPositionTickByRawTick(tick: number): number {
        return this.m_score.repeatList(this.playRepeats).tick2utick(tick)
    }

    playPositionTickByElement(element: EngravingItem): number {
        return this.playPositionTickByRawTick(element.tick().ticks())
    }

    // ------------------------------------------------------------------------------------------------------------
    //   loop boundaries
    // ------------------------------------------------------------------------------------------------------------

    private updateLoopBoundaries(): void {
        const newBoundaries: LoopBoundaries = {
            loopInTick: this.m_score.loopInTick(),
            loopOutTick: this.m_score.loopOutTick(),
            enabled: this.m_loopBoundaries.enabled,
        }

        if (!newBoundaries.loopInTick.eq(this.m_loopBoundaries.loopInTick) || !newBoundaries.loopOutTick.eq(this.m_loopBoundaries.loopOutTick)) {
            this.m_loopBoundaries = newBoundaries
            this.notifyLoopBoundariesChanged()
        }
    }

    addLoopBoundary(boundaryType: LoopBoundaryType, tick: number): void {
        const first = this.m_score.firstMeasure()
        const last = this.m_score.lastMeasure()
        if (!first || !last) {
            return
        }

        if (tick === BoundaryTick.FirstScoreTick) {
            tick = first.tick().ticks()
        } else if (tick === BoundaryTick.LastScoreTick) {
            tick = last.endTick().ticks()
        }

        switch (boundaryType) {
        case LoopBoundaryType.LoopIn:
            this.addLoopIn(tick)
            break
        case LoopBoundaryType.LoopOut:
            this.addLoopOut(tick)
            break
        case LoopBoundaryType.Unknown:
            break
        }
    }

    private addLoopIn(_tick: number): void {
        const score = this.m_score
        let tick = Fraction.fromTicks(_tick)

        if (_tick === BoundaryTick.SelectedNoteTick) {
            tick = score.pos()
        }

        if (tick.ge(score.loopOutTick())) { // If In pos >= Out pos, reset Out pos to end of score
            score.setLoopOutTick(score.lastMeasure()!.endTick())
        }

        score.setLoopInTick(tick)
    }

    private addLoopOut(_tick: number): void {
        const score = this.m_score
        let tick = Fraction.fromTicks(_tick)

        if (_tick === BoundaryTick.SelectedNoteTick) {
            tick = score.pos().plus(score.inputState().ticks())
        }

        if (tick.le(score.loopInTick())) { // If Out pos <= In pos, reset In pos to beginning of score
            score.setLoopInTick(new Fraction(0, 1))
        } else {
            if (tick.gt(score.lastMeasure()!.endTick())) {
                tick = score.lastMeasure()!.endTick()
            }
        }

        score.setLoopOutTick(tick)
    }

    setLoopBoundariesEnabled(enabled: boolean): void {
        if (this.m_loopBoundaries.enabled === enabled) {
            return
        }

        this.m_loopBoundaries = { ...this.m_loopBoundaries, enabled }
        this.notifyLoopBoundariesChanged()
    }

    isLoopEnabled(): boolean {
        const b = this.m_loopBoundaries
        return !(b.loopInTick.isZero() && b.loopOutTick.isZero()) && b.enabled
    }

    loopBoundaries(): LoopBoundaries { return this.m_loopBoundaries }

    loopBoundariesIsNull(): boolean {
        return this.m_loopBoundaries.loopInTick.isZero() && this.m_loopBoundaries.loopOutTick.isZero()
    }

    onLoopBoundariesChanged(listener: () => void): () => void {
        this.m_loopBoundariesChanged.add(listener)
        return () => this.m_loopBoundariesChanged.delete(listener)
    }

    private notifyLoopBoundariesChanged(): void {
        for (const l of [...this.m_loopBoundariesChanged]) {
            l()
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    //   tempo and beats
    // ------------------------------------------------------------------------------------------------------------

    /** the tempo (rounded beats per minute of a quarter note) at a raw tick */
    multipliedTempo(tick: number): number {
        return Math.round(this.m_score.tempomap().multipliedTempo(tick) * 60)
    }

    beat(tick: number): MeasureBeat {
        return findBeat(this.m_score, tick)
    }

    beatToRawTick(measureIndex: number, beatIndex: number): number {
        return this.m_score.sigmap().bar2tick(measureIndex, beatIndex)
    }

    tempoMultiplier(): number {
        return this.m_score.tempomap().tempoMultiplier()
    }

    setTempoMultiplier(multiplier: number): void {
        if (!this.m_score.tempomap().setTempoMultiplier(multiplier)) {
            return
        }

        this.m_score.masterScore().updateRepeatListTempo()
    }
}
