/*
 * SPDX-License-Identifier: GPL-3.0-only
 * The synthesizer of the sound output of the editor and the viewer (MuseScore: the audio engine with FluidSynth and MS Basic.sf3, or Muse
 * Sounds). Pluggable: SpessaSynth (an AudioWorklet SoundFont synthesizer, spessasynth.ts) by default; the null
 * synthesizer keeps the clock and records the events without sound (no audio device, tests: ?synth=none).
 * Channels are MIDI channels of the synthesizer (any number); events can be scheduled on the synthesizer's clock.
 */

export interface SynthChannelSetup {
    /** the soundfont preset (fluid_synth_bank_select + program change); bank 128: a drum kit */
    program: number
    bank: number
    drum: boolean
    volume: number
    pan: number
    reverb: number
    chorus: number
}

export interface LoadProgress {
    loaded: number
    /** 0 if unknown */
    total: number
}

export interface Synthesizer {
    readonly id: string
    /** the clock of scheduled events, in seconds */
    currentTime(): number
    /** seconds between scheduling an event at currentTime() and hearing it */
    outputLatency(): number
    /** loads the sounds (the soundfont); called on the first use */
    load(onProgress?: (p: LoadProgress) => void): Promise<void>
    isLoaded(): boolean
    /** starts the audio output; must be called from a user gesture (autoplay policy) */
    resume(): Promise<void>
    /** the audio output runs: until then the clock stands and what is scheduled would sound later, all at once */
    isRunning(): boolean
    setupChannel(channel: number, setup: SynthChannelSetup, time?: number): void
    noteOn(channel: number, pitch: number, velocity: number, time?: number): void
    noteOff(channel: number, pitch: number, time?: number): void
    controller(channel: number, controller: number, value: number, time?: number): void
    programChange(channel: number, program: number, time?: number): void
    /** 0..16383, 8192: no bend */
    pitchBend(channel: number, value: number, time?: number): void
    /** stops all sounds now (force: without release) */
    stopAll(force?: boolean): void
    setMuted(muted: boolean): void
}

export interface SynthLogEntry {
    type: 'noteOn' | 'noteOff' | 'controller' | 'pitchBend' | 'setup' | 'stopAll'
    channel: number
    a: number
    b: number
    time: number
}

/**
 * no sound: the clock is the page's clock; the events are counted and the last ones kept (for tests and as the
 * fallback without Web Audio)
 */
export class NullSynthesizer implements Synthesizer {
    readonly id = 'none'
    private m_muted = false
    private m_loaded = false
    readonly log: SynthLogEntry[] = []
    noteOnCount = 0

    currentTime(): number { return performance.now() / 1000 }
    outputLatency(): number { return 0 }
    async load(): Promise<void> { this.m_loaded = true }
    isLoaded(): boolean { return this.m_loaded }
    async resume(): Promise<void> {}
    isRunning(): boolean { return true }

    private record(type: SynthLogEntry['type'], channel: number, a: number, b: number, time?: number): void {
        this.log.push({ type, channel, a, b, time: time ?? this.currentTime() })
        if (this.log.length > 2000) {
            this.log.splice(0, this.log.length - 2000)
        }
    }

    setupChannel(channel: number, setup: SynthChannelSetup, time?: number): void { this.record('setup', channel, setup.program, setup.bank, time) }
    noteOn(channel: number, pitch: number, velocity: number, time?: number): void {
        if (!this.m_muted) {
            this.noteOnCount++
        }
        this.record('noteOn', channel, pitch, velocity, time)
    }
    noteOff(channel: number, pitch: number, time?: number): void { this.record('noteOff', channel, pitch, 0, time) }
    controller(channel: number, controller: number, value: number, time?: number): void { this.record('controller', channel, controller, value, time) }
    programChange(channel: number, program: number, time?: number): void { this.record('controller', channel, 0x81, program, time) }
    pitchBend(channel: number, value: number, time?: number): void { this.record('pitchBend', channel, value, 0, time) }
    stopAll(): void { this.record('stopAll', -1, 0, 0) }
    setMuted(muted: boolean): void { this.m_muted = muted }
    muted(): boolean { return this.m_muted }
}
