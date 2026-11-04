/*
 * SPDX-License-Identifier: GPL-3.0-only
 * MuseEncore — port of MuseScore Studio (https://github.com/musescore/MuseScore)
 * Copyright (C) 2021-2026 MuseScore Limited and others
 *
 * Port of the parts of src/playback/iplaybackcontroller.h that the notation scene uses (play and seek elements while
 * editing). The implementation with the sound output is the application's (editor/playback): it is set with
 * setPlaybackController() (C++: dependency injection, modularity::ioc()).
 */

import type { EngravingItem } from '../engraving/dom/engravingitem'
import type { NoteVal } from '../engraving/dom/input'
import type { Segment } from '../engraving/dom/segment'
import type { MeasureBeat } from '../notation/internal/notationplayback'

/** C++ mpe::INFINITE_DURATION: play the note on only (a duration of 0: the note off only) */
export const INFINITE_DURATION = Infinity

export interface PlayParams {
    /** seconds; undefined: NotationConfiguration::notePlayDurationMilliseconds */
    duration?: number
    flushSound?: boolean
    /** caused by a MIDI event, which is no user gesture: the browser may not have started the sound output */
    midiEvent?: boolean
}

/** C++ mpe::ControllerChangeEvent::Type */
export enum ControllerChangeType {
    Modulation,
    SustainPedalOnOff,
    PitchBend,
}

/** C++ mpe::ControllerChangeEvent */
export interface ControllerChangeEvent {
    type: ControllerChangeType
    /** 0..1 */
    val: number
}

export interface IPlaybackController {
    isPlaying(): boolean
    /** C++ masterNotation->playback()->isLoopEnabled() (NotationActionController::seekSelectedElement) */
    isLoopEnabled(): boolean
    currentBeat(): MeasureBeat
    reset(): void
    playElements(elements: readonly EngravingItem[], params?: PlayParams, isMidi?: boolean): void
    playNotes(notes: readonly NoteVal[], staffIdx: number, segment: Segment, params?: PlayParams): void
    playMetronome(tick: number): void
    triggerControllers(list: readonly ControllerChangeEvent[], staffIdx: number, tick: number): void
    seekElement(element: EngravingItem | null, flushSound?: boolean): void
    seekBeat(measureIndex: number, beatIndex: number, flushSound?: boolean): void
}

let s_playbackController: IPlaybackController | null = null

/** C++ inject<IPlaybackController>: null if the application has no sound output */
export function playbackController(): IPlaybackController | null {
    return s_playbackController
}

export function setPlaybackController(controller: IPlaybackController | null): void {
    s_playbackController = controller
}
