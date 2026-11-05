/*
 * SPDX-License-Identifier: GPL-3.0-only
 * The default synthesizer: SpessaSynth (spessasynth_lib, Apache-2.0), a SoundFont2/SF3 synthesizer in an
 * AudioWorklet, with MuseScore's MS Basic.sf3. The AudioContext is created on the first use; events are scheduled on
 * the audio clock (SpessaSynth's `time` option). Channels above 16 are added to the synthesizer as needed.
 */
import { WorkletSynthesizer } from 'spessasynth_lib'
import processorUrl from 'spessasynth_lib/dist/spessasynth_processor.min.js?url'
import { loadSoundFont } from './soundfont'
import type { LoadProgress, SynthChannelSetup, Synthesizer } from './synthesizer'

const CC_BANK_MSB = 0
const CC_BANK_LSB = 32
const CC_VOLUME = 7
const CC_PAN = 10
const CC_REVERB = 91
const CC_CHORUS = 93

/**
 * the URL of SpessaSynth's worklet processor: a library build (the viewer package) inlines it as a data: URL, which
 * not every browser accepts for a worklet module: it is passed as a blob: URL then
 */
async function workletUrl(): Promise<string> {
    if (!processorUrl.startsWith('data:')) {
        return processorUrl
    }
    return URL.createObjectURL(await (await fetch(processorUrl)).blob())
}

export class SpessaSynthesizer implements Synthesizer {
    readonly id = 'spessasynth'
    private m_context: AudioContext | null = null
    private m_synth: WorkletSynthesizer | null = null
    private m_gain: GainNode | null = null
    private m_loading: Promise<void> | null = null
    private m_loaded = false
    private m_muted = false
    /**
     * the channels of the synthesizer in the worklet: SpessaSynth's own count (channelCount) is not reliable, its
     * "channelAdded" event adds another channel to the list of the main thread for each added channel
     */
    private m_channelCount = 16

    /** soundFontUrl: the URL of MS Basic.sf3 (soundfont.ts) */
    constructor(private readonly m_soundFontUrl: string) {}

    private context(): AudioContext {
        this.m_context ??= new AudioContext({ latencyHint: 'interactive' })
        return this.m_context
    }

    currentTime(): number {
        return this.m_context ? this.m_context.currentTime : performance.now() / 1000
    }

    outputLatency(): number {
        const c = this.m_context
        return c ? (c.outputLatency || 0) + (c.baseLatency || 0) : 0
    }

    isLoaded(): boolean { return this.m_loaded }

    load(onProgress?: (p: LoadProgress) => void): Promise<void> {
        this.m_loading ??= (async () => {
            const ctx = this.context()
            const [soundFont] = await Promise.all([loadSoundFont(this.m_soundFontUrl, onProgress), workletUrl().then(url => ctx.audioWorklet.addModule(url))])
            const synth = new WorkletSynthesizer(ctx)
            this.m_gain = ctx.createGain()
            this.m_gain.gain.value = this.m_muted ? 0 : 1
            synth.connect(this.m_gain)
            this.m_gain.connect(ctx.destination)
            await synth.soundBankManager.addSoundBank(soundFont, 'main')
            await synth.isReady
            this.m_synth = synth
            this.m_loaded = true
        })()
        this.m_loading.catch(() => { this.m_loading = null })
        return this.m_loading
    }

    async resume(): Promise<void> {
        const ctx = this.context()
        if (ctx.state !== 'running') {
            await ctx.resume()
        }
    }

    isRunning(): boolean {
        return this.m_context?.state === 'running'
    }

    private opts(time?: number): { time: number } | undefined {
        return time !== undefined ? { time } : undefined
    }

    private ensureChannel(channel: number): WorkletSynthesizer | null {
        const s = this.m_synth
        if (!s) {
            return null
        }
        while (this.m_channelCount <= channel) {
            s.addNewChannel()
            ++this.m_channelCount
        }
        return s
    }

    setupChannel(channel: number, setup: SynthChannelSetup, time?: number): void {
        const s = this.ensureChannel(channel)
        if (!s) {
            return
        }
        const o = this.opts(time)
        s.midiChannels[channel]?.setDrums(setup.drum)
        if (!setup.drum) {
            // fluid_synth_bank_select of MuseScore 4's Fluid synth: the soundfont bank of the sound mapping
            s.controllerChange(channel, CC_BANK_MSB, setup.bank & 0x7f, o)
            s.controllerChange(channel, CC_BANK_LSB, 0, o)
        }
        s.programChange(channel, setup.program & 0x7f, o)
        // the MIDI renderer's pitch bends are for a range of 12 semitones (PitchWheelSpecs::mAmplitude)
        s.pitchWheelRange(channel, 12, o)
        s.controllerChange(channel, CC_VOLUME, setup.volume & 0x7f, o)
        s.controllerChange(channel, CC_PAN, setup.pan & 0x7f, o)
        s.controllerChange(channel, CC_REVERB, setup.reverb & 0x7f, o)
        s.controllerChange(channel, CC_CHORUS, setup.chorus & 0x7f, o)
    }

    noteOn(channel: number, pitch: number, velocity: number, time?: number): void {
        this.ensureChannel(channel)?.noteOn(channel, pitch, velocity, this.opts(time))
    }

    noteOff(channel: number, pitch: number, time?: number): void {
        this.ensureChannel(channel)?.noteOff(channel, pitch, this.opts(time))
    }

    controller(channel: number, controller: number, value: number, time?: number): void {
        this.ensureChannel(channel)?.controllerChange(channel, controller as never, value, this.opts(time))
    }

    programChange(channel: number, program: number, time?: number): void {
        this.ensureChannel(channel)?.programChange(channel, program & 0x7f, this.opts(time))
    }

    pitchBend(channel: number, value: number, time?: number): void {
        this.ensureChannel(channel)?.pitchWheel(channel, value, this.opts(time))
    }

    stopAll(force = false): void {
        this.m_synth?.stopAll(force)
    }

    setMuted(muted: boolean): void {
        this.m_muted = muted
        if (this.m_gain && this.m_context) {
            this.m_gain.gain.setTargetAtTime(muted ? 0 : 1, this.m_context.currentTime, 0.01)
        }
    }
}
