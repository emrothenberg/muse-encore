/*
 * SPDX-License-Identifier: GPL-3.0-only
 * MuseEncore — port of MuseScore Studio (https://github.com/musescore/MuseScore)
 * Copyright (C) 2021-2026 MuseScore Limited and others
 *
 * Public API of the playback: the MIDI events of a score (CompatMidiRender) with their times, the conversions between
 * score ticks, played (unrolled) ticks and seconds, the playback cursor and the loop markers, the notes to preview
 * while editing, and the playback controller interface the notation scene calls (seek, play elements).
 * Rectangles are in inches from the top left of their page, like the other view APIs (noteInputCursorBounds).
 */

import { DPI } from '../engraving/types/types'
import type { Score } from '../engraving/dom/score'
import type { MasterScore } from '../engraving/dom/masterscore'
import type { EngravingItem } from '../engraving/dom/engravingitem'
import { PointF, type RectF } from '../framework/draw/types/geometry'
import { LoopBoundaryType } from '../engraving/dom/score'
import { NotationPlayback } from '../notation/internal/notationplayback'
import { PlaybackCursor } from '../notationscene/playbackcursor'
import { LoopMarker, LOOP_MARKER_COLOR } from '../notationscene/loopmarker'

export { NotationPlayback, BoundaryTick, findBeat, METRONOME_CHANNEL_NAME } from '../notation/internal/notationplayback'
export type {
    LoopBoundaries, MeasureBeat, PlaybackChannel, PlaybackEvents, PlaybackMidiEvent, PreviewNote,
} from '../notation/internal/notationplayback'
export { LoopBoundaryType } from '../engraving/dom/score'
export { ControllerChangeType, INFINITE_DURATION, setPlaybackController, playbackController, type ControllerChangeEvent, type IPlaybackController, type PlayParams } from './iplaybackcontroller'
export type { EngravingItem } from '../engraving/dom/engravingitem'
export type { NoteVal } from '../engraving/dom/input'
export type { Segment } from '../engraving/dom/segment'
export {
    ME_CONTROLLER, ME_NOTEON, ME_PITCHBEND, CTRL_PROGRAM, CTRL_SUSTAIN, CTRL_VOLUME, CTRL_PANPOT, CTRL_EXPRESSION,
    CTRL_BREATH, CTRL_ALL_NOTES_OFF, CTRL_REVERB_SEND, CTRL_CHORUS_SEND,
} from '../engraving/compat/midi/midicoreevent'

export interface PlaybackPageRect {
    page: number
    x: number
    y: number
    width: number
    height: number
}

const s_playbacks = new WeakMap<MasterScore, NotationPlayback>()

/** the NotationPlayback of a score (C++ masterNotation->playback()) */
export function notationPlayback(score: Score): NotationPlayback {
    // a part's playback is the playback of its master score
    const master = score.masterScore()
    let p = s_playbacks.get(master)
    if (!p) {
        p = new NotationPlayback(master)
        s_playbacks.set(master, p)
    }
    return p
}

function canvasRectToPage(score: Score, r: RectF): PlaybackPageRect | null {
    if (!r.isValid() || r.isNull()) {
        return null
    }
    const pages = score.pages()
    const cy = r.y() + r.height() / 2
    const cx = r.x() + r.width() / 2
    for (let i = 0; i < pages.length; ++i) {
        const page = pages[i]
        const pr = page.ldata().bbox().translated(page.pos())
        if (pr.contains(new PointF(cx, cy)) || (cx >= pr.left() && cx <= pr.right() && r.y() <= pr.bottom() && r.bottom() >= pr.top())) {
            const p = page.pos()
            return { page: i, x: (r.x() - p.x()) / DPI, y: (r.y() - p.y()) / DPI, width: r.width() / DPI, height: r.height() / DPI }
        }
    }
    return null
}

/** the playback cursor at a (raw) tick of the score: PlaybackCursor::resolveCursorRectByTick */
export function playbackCursorBounds(score: Score, tick: number): PlaybackPageRect | null {
    return canvasRectToPage(score, new PlaybackCursor(score).resolveCursorRectByTick(tick))
}

export interface LoopMarkerGeometry {
    page: number
    /** inches from the top left of the page */
    x: number
    top: number
    bottom: number
    triangle: { x: number; y: number }[]
    lineWidth: number
    color: string
}

/** the loop in/out markers to draw (none while the loop is disabled) */
export function loopMarkers(score: Score): LoopMarkerGeometry[] {
    const playback = notationPlayback(score)
    const boundaries = playback.loopBoundaries()
    if (!boundaries.enabled || playback.loopBoundariesIsNull()) {
        return []
    }
    const result: LoopMarkerGeometry[] = []
    for (const [type, tick] of [[LoopBoundaryType.LoopIn, boundaries.loopInTick], [LoopBoundaryType.LoopOut, boundaries.loopOutTick]] as const) {
        const marker = new LoopMarker(type, score)
        marker.setVisible(true)
        marker.updatePosition(tick)
        const g = marker.geometry()
        const pr = g ? canvasRectToPage(score, marker.rect()) : null
        if (!g || !pr) {
            continue
        }
        const p = score.pages()[pr.page].pos()
        result.push({
            page: pr.page,
            x: (g.x - p.x()) / DPI,
            top: (g.top - p.y()) / DPI,
            bottom: (g.bottom - p.y()) / DPI,
            triangle: g.triangle.map(pt => ({ x: (pt.x() - p.x()) / DPI, y: (pt.y() - p.y()) / DPI })),
            lineWidth: g.lineWidth / DPI,
            color: `#${LOOP_MARKER_COLOR.r.toString(16).padStart(2, '0')}${LOOP_MARKER_COLOR.g.toString(16).padStart(2, '0')}${LOOP_MARKER_COLOR.b.toString(16).padStart(2, '0')}`,
        })
    }
    return result
}

/** the tick (raw) of an element: NotationPlayback::playPositionTickByElement uses it */
export function elementTick(element: EngravingItem): number {
    return element.tick().ticks()
}

/** the elements selected now (for "play from selection") and the start tick of a range selection (or -1) */
export function selectionPlaybackInfo(score: Score): { elements: EngravingItem[]; rangeStartTick: number; rangeEndTick: number; isNone: boolean } {
    const sel = score.selection()
    return {
        elements: [...sel.elements()],
        rangeStartTick: sel.isRange() ? sel.tickStart().ticks() : -1,
        rangeEndTick: sel.isRange() ? sel.tickEnd().ticks() : -1,
        isNone: sel.isNone(),
    }
}

/** the parts of a range selection (C++ selectionRange()->selectedParts()), their ids */
export function rangeSelectionPartIds(score: Score): string[] {
    const sel = score.selection()
    if (!sel.isRange()) {
        return []
    }
    const ids: string[] = []
    for (let i = sel.staffStart(); i < sel.staffEnd(); ++i) {
        const id = score.staff(i)?.part().id()
        if (id && !ids.includes(id)) {
            ids.push(id)
        }
    }
    return ids
}

/** the number of systems with staves on a page (AbstractNotationPaintView::needAdjustCanvasVerticallyWhilePlayback) */
export function pageSystemCount(score: Score, pageIdx: number): number {
    const page = score.pages()[pageIdx]
    return page ? page.systems().filter(s => s.staves().length > 0).length : 0
}
