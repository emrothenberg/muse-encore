// SPDX-License-Identifier: GPL-3.0-only
/**
 * C++ notationscene/qml/MuseScore/NotationScene/notationruler.cpp: the ruler above the staff that replaces the note
 * input cursor in the input by duration mode. The position of a line between two segments keeps C++'s `i % dist`.
 */
import type { Painter } from '../framework/draw/painter'
import { AlignmentFlag } from '../framework/draw/types/drawtypes'
import { Font, FontType } from '../framework/draw/types/font'
import { PointF, RectF } from '../framework/draw/types/geometry'
import { nidx } from '../engraving/types/types'
import type { InputState } from '../engraving/dom/input'
import type { Segment } from '../engraving/dom/segment'
import { ticks_beat } from '../engraving/dom/sig'
import { EngravingConfiguration } from '../engraving/internal/engravingconfiguration'

/** C++ muse::ui::IconCode::Code::DURATION_CURSOR */
const DURATION_CURSOR = 0xF492

enum LineType {
    CurrentPosition,
    MainBeat,
    Subdivision,
}

export class NotationRuler {
    static paint(painter: Painter, state: InputState): void {
        if (!state.isValid()) {
            return
        }

        const staff = state.staff()
        const currSegment = state.segment()!
        const system = currSegment.system()
        const measure = currSegment.measure()
        const sysStaff = system ? system.staff(state.staffIdx()) : null
        const timeSig = staff ? staff.timeSig(state.tick()) : null

        if (!measure || !sysStaff || !timeSig) {
            return
        }

        const measurePos = measure.canvasPos()
        const inputTicks = state.tick().ticks()
        const measureTicks = measure.tick().ticks()
        const ticksBeat = ticks_beat(timeSig.denominator())
        const subdivisionTicks = Math.trunc(ticksBeat / 2)

        const lineToSegment = new Map<number, Segment>()

        for (let segment = measure.first(); segment; segment = segment.next()) {
            if (!segment.isChordRestType()) {
                continue
            }

            const segmentTicks = segment.tick().ticks()
            if (segmentTicks % subdivisionTicks !== 0) {
                continue // this segment does not correspond to any line
            }

            lineToSegment.set(Math.trunc((segmentTicks - measureTicks) / subdivisionTicks), segment)
        }

        // the keys in the order of C++'s std::map
        const lines = [...lineToSegment.keys()].sort((a, b) => a - b)

        const lineCount = timeSig.numerator() * 2
        const spatium = staff!.score().style().spatium()
        const aboveStaffSpacing = spatium * 2
        const lineY = measurePos.y() + sysStaff.y() - aboveStaffSpacing

        let prevAccurateLine = nidx
        let currentPositionPainted = false

        for (let i = 0; i < lineCount; ++i) {
            const lineTicks = measureTicks + subdivisionTicks * i
            let lineX = 0.0

            const segment = lineToSegment.get(i)
            if (segment) {
                lineX = measurePos.x() + segment.x()
                prevAccurateLine = i
            } else if (prevAccurateLine !== nidx) {
                const prev = lineToSegment.get(prevAccurateLine)!
                const nextLine = lines[lines.indexOf(prevAccurateLine) + 1]

                if (nextLine !== undefined) {
                    const dist = nextLine - prevAccurateLine
                    const segmentWidth = (lineToSegment.get(nextLine)!.x() - prev.x()) / dist
                    lineX = measurePos.x() + prev.x() + segmentWidth * (i % dist)
                } else {
                    const dist = lineCount - prevAccurateLine
                    const segmentWidth = (measure.width() - prev.x()) / dist
                    lineX = measurePos.x() + prev.x() + segmentWidth * (i % dist)
                }
            } else {
                continue // C++ UNREACHABLE
            }

            const type = NotationRuler.lineType(lineTicks, inputTicks, i)
            NotationRuler.paintLine(painter, type, new PointF(lineX, lineY), spatium, state.voice())
            currentPositionPainted ||= type === LineType.CurrentPosition
        }

        if (!currentPositionPainted) {
            const lineX = measurePos.x() + currSegment.x()
            NotationRuler.paintLine(painter, LineType.CurrentPosition, new PointF(lineX, lineY), spatium, state.voice())
        }
    }

    private static lineType(lineTicks: number, inputTicks: number, lineIdx: number): LineType {
        if (lineTicks === inputTicks) {
            return LineType.CurrentPosition
        }

        return lineIdx % 2 === 0 ? LineType.MainBeat : LineType.Subdivision
    }

    private static paintLine(painter: Painter, type: LineType, point: PointF, spatium: number, voiceIdx: number): void {
        const rect = new RectF()
        const color = EngravingConfiguration.selectionColor(voiceIdx)

        switch (type) {
        case LineType.CurrentPosition:
            rect.setHeight(spatium * 4)
            rect.setWidth(spatium * 2)
            rect.setX(point.x() - rect.width() / 2)
            color.setAlpha(192)
            break
        case LineType.MainBeat:
            rect.setHeight(spatium * 2)
            rect.setWidth(spatium / 6)
            rect.setX(point.x())
            color.setAlpha(192)
            break
        case LineType.Subdivision:
            rect.setHeight(spatium)
            rect.setWidth(spatium / 6)
            rect.setX(point.x())
            color.setAlpha(128)
            break
        }

        rect.setY(point.y() - rect.height())

        if (type === LineType.CurrentPosition) {
            const font = new Font(EngravingConfiguration.iconsFontFamily(), FontType.Icon)
            font.setPointSizeF(spatium / 6)

            painter.setPen(color)
            painter.setFont(font)
            painter.drawTextInRect(rect, AlignmentFlag.AlignHCenter | AlignmentFlag.AlignBottom, String.fromCharCode(DURATION_CURSOR))
        } else {
            painter.fillRect(rect, color)
        }
    }
}
