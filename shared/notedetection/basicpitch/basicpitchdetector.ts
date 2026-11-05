/*
 * SPDX-License-Identifier: GPL-3.0-only
 * The NoteDetector on Spotify's basic-pitch (Apache-2.0, see LICENSE; inference.ts, notes.ts, audioinput.ts and
 * transcriber.ts are taken from basic-pitch-ts and its live microphone demo). The detection runs in a Web Worker
 * (worker.ts); here, on the main thread, only the audio input is created (Web Audio is not available in workers): its
 * recorder worklet sends the audio directly to the worker. The model (model/) is served at <base>/basic-pitch/
 * (vite-plugin-basicpitch.ts).
 */
import { DEFAULT_NOTE_DETECTOR_SETTINGS, type DetectedNote, type DetectionUpdate, type NoteDetector, type NoteDetectorOptions, type NoteDetectorSettings, type NoteDetectorStats } from '../notedetector'
import { AudioInput } from './audioinput'
import type { FromWorker, ToWorker } from './worker'
import workerUrl from './worker?worker&url'

let s_worker: Worker | null = null

/** the worker (once: it keeps the model loaded) */
function worker(): Worker {
    if (!s_worker) {
        // a script of another origin (the viewer package from a CDN) cannot be a worker itself, but a worker can import it
        const url = new URL(workerUrl, import.meta.url)
        s_worker = new Worker(url.origin === location.origin ? url
            : URL.createObjectURL(new Blob([`import ${JSON.stringify(url.href)}`], { type: 'text/javascript' })), { type: 'module' })
    }
    return s_worker
}

export class BasicPitchDetector implements NoteDetector {
    private readonly options: NoteDetectorOptions
    private m_settings: NoteDetectorSettings
    private input: AudioInput | null = null
    private active: number[] = []
    private m_stats: NoteDetectorStats = { processingMs: 0, latency: 0, updates: 0, rejected: 0, overtones: 0, floorDb: 0 }
    private listener: ((event: MessageEvent<FromWorker>) => void) | null = null
    private errorListener: (() => void) | null = null

    constructor(options: NoteDetectorOptions) {
        this.options = options
        this.m_settings = { ...DEFAULT_NOTE_DETECTOR_SETTINGS, ...options.settings }
    }

    configure(settings: Partial<NoteDetectorSettings>): void {
        this.m_settings = { ...this.m_settings, ...settings }
        if (this.input) {
            const msg: ToWorker = { type: 'settings', settings: this.m_settings }
            s_worker?.postMessage(msg)
        }
    }

    async start(onNote: (note: DetectedNote) => void, onUpdate?: (update: DetectionUpdate) => void): Promise<void> {
        await this.stop()
        const w = worker()
        const channel = new MessageChannel()
        const ready = new Promise<void>((resolve, reject) => {
            this.listener = (event: MessageEvent<FromWorker>): void => {
                const msg = event.data
                if (msg.type === 'ready') {
                    resolve()
                } else if (msg.type === 'error') {
                    reject(new Error(msg.message))
                } else if (msg.type === 'update') {
                    this.active = msg.active
                    this.m_stats = msg.stats
                    onUpdate?.({ time: msg.time, raw: msg.raw, floorDb: msg.stats.floorDb })
                    for (const note of msg.notes) {
                        onNote(note)
                    }
                }
            }
            w.addEventListener('message', this.listener)
            // the worker's script could not be loaded (no message would ever come)
            this.errorListener = (): void => reject(new Error('The note detection could not be loaded'))
            w.addEventListener('error', this.errorListener)
        })
        const input = new AudioInput(() => {}, this.options.keepMicrophone)
        this.input = input
        try {
            await input.start(this.options.input ?? 'microphone', channel.port1)
            if (this.input !== input) {
                throw new DOMException('stopped while starting', 'AbortError')
            }
            const modelUrl = new URL(`${this.options.baseUrl}basic-pitch/model.json`, location.href).href
            const msg: ToWorker = { type: 'start', modelUrl, sampleRate: input.sampleRate!, port: channel.port2, settings: this.m_settings }
            w.postMessage(msg, [channel.port2])
            await ready
        } catch (e) {
            // the microphone is not kept for a start that failed
            await input.stop(true)
            // stopped meanwhile: this.input may already be the input of a newer start
            if (this.input === input) {
                await this.stop()
            }
            throw e
        }
    }

    async stop(): Promise<void> {
        const msg: ToWorker = { type: 'stop' }
        s_worker?.postMessage(msg)
        if (this.listener) {
            s_worker?.removeEventListener('message', this.listener)
            this.listener = null
        }
        if (this.errorListener) {
            s_worker?.removeEventListener('error', this.errorListener)
            this.errorListener = null
        }
        const input = this.input
        this.input = null
        this.active = []
        this.m_stats = { processingMs: 0, latency: 0, updates: 0, rejected: 0, overtones: 0, floorDb: 0 }
        await input?.stop()
    }

    activePitches(): number[] {
        return this.active
    }

    stats(): NoteDetectorStats {
        return { ...this.m_stats }
    }
}
