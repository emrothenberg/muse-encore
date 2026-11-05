/*
 * SPDX-License-Identifier: GPL-3.0-only
 * The viewer's playalong (not in MuseScore; the editor's is editor/playalong/playalongcontroller.ts): follows the score
 * measure by measure in the played order while the user plays. The notes come from the MIDI input if it is on and a device
 * is connected, else from the microphone (the note detection is loaded on the first start). Nothing is entered or
 * calibrated here, and all parts are followed (a viewer has no selection).
 */
import { playalongMeasures, type MasterScore, type PlayalongMeasure } from '../../src/index'
import { createNoteDetector, type NoteDetector } from '../../shared/notedetection/notedetector'
import { ChordGrouper, PlayalongFollower } from '../../shared/playalong/follower'

export interface ViewerPlayalongState {
    active: boolean
    status: 'off' | 'loading' | 'listening' | 'error'
    error: string
    /** the measure followed: its raw tick and number (-1, 0: none), its index in the played order and the neighbors' raw ticks */
    index: number
    tick: number
    number: number
    prevTick: number
    nextTick: number
    count: number
    practice: boolean
    /** the pitches of the last chord played */
    heard: number[]
}

const NO_MEASURE = { index: -1, tick: -1, number: 0, prevTick: -1, nextTick: -1, count: 0 }

/** the note detection has one worker per page: only one viewer listens at a time */
let s_listening: ViewerPlayalong | null = null

export class ViewerPlayalong {
    private m_state: ViewerPlayalongState
    private m_score: MasterScore | null = null
    private m_measures: PlayalongMeasure[] = []
    private m_follower: PlayalongFollower | null = null
    private m_detector: NoteDetector | null = null
    private m_microphoneOn = false
    /** counts the starts of the microphone: one that was stopped meanwhile does not continue */
    private m_session = 0
    private readonly m_grouper = new ChordGrouper((pitches, time) => {
        this.m_follower?.onChord(pitches, time)
        this.showMeasure({ heard: pitches })
    })

    /** onChange: the state changed; useMidi: the notes come from the MIDI input */
    constructor(private readonly m_baseUrl: string, private readonly m_useMidi: () => boolean, practice: boolean,
                private readonly m_onChange: (state: ViewerPlayalongState) => void) {
        this.m_state = { active: false, status: 'off', error: '', ...NO_MEASURE, practice, heard: [] }
    }

    state(): ViewerPlayalongState {
        return this.m_state
    }

    private publish(patch: Partial<ViewerPlayalongState>): void {
        this.m_state = { ...this.m_state, ...patch }
        this.m_onChange(this.m_state)
    }

    private showMeasure(patch: Partial<ViewerPlayalongState> = {}): void {
        const m = this.m_follower ? this.m_measures[this.m_follower.measure()] : undefined
        this.publish({
            ...patch,
            ...(m ? {
                index: m.index, tick: m.tick, number: m.number, prevTick: this.m_measures[m.index - 1]?.tick ?? -1,
                nextTick: this.m_measures[m.index + 1]?.tick ?? -1, count: this.m_measures.length,
            } : NO_MEASURE),
        })
    }

    /** another score is shown (or none): the playalong ends */
    setScore(score: MasterScore | null): void {
        this.stop()
        this.m_score = score
    }

    /** starts following at the measure containing a raw tick */
    start(tick: number): void {
        if (!this.m_score || this.m_state.active) {
            return
        }
        this.m_measures = playalongMeasures(this.m_score, null)
        const start = this.m_measures.find(m => tick >= m.tick && tick < m.tick + m.ticks)?.index ?? 0
        this.m_follower = new PlayalongFollower(this.m_measures, this.m_state.practice ? 'practice' : 'follow', start)
        this.m_grouper.clear()
        this.showMeasure({ active: true, status: 'loading', error: '', heard: [] })
        this.inputChanged()
    }

    stop(): void {
        this.m_grouper.clear()
        this.m_follower = null
        this.stopMicrophone()
        this.publish({ active: false, status: 'off', error: '', heard: [], ...NO_MEASURE })
    }

    /** the MIDI input was switched or its device came or went: takes the notes from where they are now */
    inputChanged(): void {
        if (!this.m_state.active) {
            return
        }
        if (this.m_useMidi()) {
            if (this.m_microphoneOn) {
                this.stopMicrophone()
                this.m_grouper.clear() // another clock
            }
            this.publish({ status: 'listening', error: '' })
        } else if (!this.m_microphoneOn) {
            this.m_grouper.clear() // another clock
            this.publish({ status: 'loading', error: '' })
            void this.startMicrophone()
        }
    }

    /** a key of the MIDI input was pressed (time in seconds) */
    midiNoteOn(pitch: number, time: number): void {
        if (this.m_state.active && this.m_useMidi()) {
            this.m_grouper.add(pitch, time)
        }
    }

    private async startMicrophone(): Promise<void> {
        const session = ++this.m_session
        this.m_microphoneOn = true
        if (s_listening !== this) {
            s_listening?.stop()
            s_listening = this
        }
        try {
            this.m_detector ??= await createNoteDetector({ baseUrl: this.m_baseUrl })
            if (session !== this.m_session) {
                return
            }
            await this.m_detector.start(note => this.m_grouper.add(note.pitch, note.time))
            if (session !== this.m_session) {
                await this.m_detector.stop()
                return
            }
            this.publish({ status: 'listening' })
        } catch (e) {
            if (session !== this.m_session) {
                return
            }
            console.error(e)
            const error = e instanceof DOMException && e.name === 'NotAllowedError' ? 'The microphone may not be used' : (e as Error).message
            this.stop()
            this.publish({ status: 'error', error })
        }
    }

    private stopMicrophone(): void {
        ++this.m_session
        this.m_microphoneOn = false
        if (s_listening === this) {
            s_listening = null
        }
        void this.m_detector?.stop()
    }

    /** the previous (-1) or next (+1) measure in the played order */
    step(delta: -1 | 1): void {
        if (!this.m_follower) {
            return
        }
        if (delta > 0) {
            this.m_follower.next()
        } else {
            this.m_follower.prev()
        }
        this.m_grouper.clear()
        this.showMeasure()
    }

    togglePractice(): void {
        const practice = !this.m_state.practice
        this.m_follower?.setMode(practice ? 'practice' : 'follow')
        this.publish({ practice })
    }

    dispose(): void {
        this.stop()
    }
}
