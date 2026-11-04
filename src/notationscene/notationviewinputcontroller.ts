/*
 * SPDX-License-Identifier: GPL-3.0-only
 * MuseEncore — port of MuseScore Studio (https://github.com/musescore/MuseScore)
 * Copyright (C) 2021-2026 MuseScore Limited and others
 *
 * Port of the selection part of the mouse handling of
 * src/notationscene/qml/MuseScore/NotationScene/notationviewinputcontroller.cpp (mousePressEvent and
 * mouseReleaseEvent of a left click without dragging) and the selection key actions of
 * src/notationscene/internal/notationactioncontroller.cpp.
 *
 * The mouse and key events of the editing (drag of elements and grips, lasso, text editing, double/triple click)
 * are in the section at the end of the class.
 *
 * TODO(port): context menu, Alt+click paste, drag of ranges/elements to other
 * applications.
 */

import { NotationConfiguration } from '../notation/internal/notationconfiguration'
import { playbackController } from '../playback/iplaybackcontroller'
import { nidx, type staff_idx_t } from '../engraving/types/types'
import { SelectType } from '../engraving/dom/select'
import { ExpandSelectionMode, MoveDirection, MoveSelectionType, NotationInteraction } from '../notation/internal/notationinteraction'
import type { PointF } from '../framework/draw/types/geometry'
import type { EngravingItem } from '../engraving/dom/engravingitem'
// (imports of the editing section)
import { PointF as PointFValue } from '../framework/draw/types/geometry'
import { ElementType } from '../engraving/types/types'
import { SelectTextType } from '../engraving/dom/textbase'
import { NoteEntryMethod } from '../engraving/dom/input'
import { KeyboardKey, KeyboardModifier, MouseButton } from '../engraving/editing/editdata'
import { DragMode, type HitElementContext, type NotationKeyEvent } from '../notation/internal/notationinteraction'
import type { Note } from '../engraving/dom/note'

export interface KeyboardModifiers {
    shift: boolean
    ctrl: boolean
    alt: boolean
}

function seekAllowed(element: EngravingItem | null): boolean {
    if (!element) {
        return false
    }

    switch (element.type()) {
    case ElementType.NOTE:
    case ElementType.REST:
    case ElementType.MMREST:
    case ElementType.MEASURE:
    case ElementType.BAR_LINE:
        return true
    default:
        return false
    }
}

export class NotationViewInputController {
    private m_interaction: NotationInteraction

    constructor(interaction: NotationInteraction) {
        this.m_interaction = interaction
    }

    viewInteraction(): NotationInteraction { return this.m_interaction }

    /**
     * a left click (mouse press and release at the same position) at logicPos (canvas coordinates);
     * hitWidth: C++ configuration()->selectionProximity() * 0.5 / currentScaling()
     */
    leftClick(logicPos: PointF, hitWidth: number, modifiers: { shift: boolean; ctrl: boolean }): void {
        const interaction = this.viewInteraction()

        // mousePressEvent
        const hitElement = interaction.hitElement(logicPos, hitWidth)
        const hitStaff = interaction.hitStaff(logicPos)
        const hitStaffIndex = hitStaff ? hitStaff.idx() : nidx

        // note enter mode
        if (interaction.noteInput().isNoteInputMode()) {
            this.handleClickInNoteInputMode(logicPos, modifiers)
            return
        }

        let shouldSelectOnLeftClickRelease = false

        // Drag outgoing: range (the press only starts a possible drag of the range)
        let consumed = false
        if (!hitElement || hitElement.isMeasure()) {
            const selection = interaction.score().selection()
            if (selection.isRange() && interaction.rangeContainsPoint(logicPos)) {
                consumed = true
            }
        }

        if (!consumed) {
            // mousePress_considerSelect
            shouldSelectOnLeftClickRelease = this.mousePressConsiderSelect(logicPos, hitWidth, hitElement, hitStaffIndex, modifiers)
        }

        // mouseReleaseEvent
        if (!modifiers.ctrl && !modifiers.shift) {
            if (!hitElement) {
                interaction.clearSelection()
            }
        }

        // handleLeftClickRelease
        if (!modifiers.ctrl && !modifiers.shift && hitElement && shouldSelectOnLeftClickRelease) {
            interaction.select([hitElement], SelectType.SINGLE, hitStaffIndex)
        }
    }

    /** returns m_shouldSelectOnLeftClickRelease */
    private mousePressConsiderSelect(logicClickPos: PointF, hitWidth: number, hitElement: EngravingItem | null,
        hitStaff: staff_idx_t, modifiers: { shift: boolean; ctrl: boolean }): boolean {
        if (!hitElement) {
            return false
        }

        const interaction = this.viewInteraction()

        if (modifiers.ctrl) {
            const overlappingHitElements = interaction.hitElements(logicClickPos, hitWidth)
            if (overlappingHitElements.length > 1) {
                this.cycleOverlappingHitElements(overlappingHitElements, hitStaff)
                return false
            }
        }

        let selectType = SelectType.SINGLE
        if (modifiers.shift) {
            selectType = SelectType.RANGE
        } else if (modifiers.ctrl) {
            selectType = SelectType.ADD
        } else {
            const selection = interaction.score().selection()

            if (selection.isRange()
                && (interaction.rangeContainsItem(hitElement, hitStaff) || interaction.rangeContainsPoint(logicClickPos))) {
                return true
            } else if (hitElement.selected()) {
                return selection.elements().length > 1
            }
        }

        interaction.select([hitElement], selectType, hitStaff, modifiers.ctrl && !modifiers.shift)
        return false
    }

    private cycleOverlappingHitElements(hitElements: readonly EngravingItem[], hitStaffIndex: staff_idx_t): void {
        const numHitElements = hitElements.length
        let currTop = numHitElements - 1
        let e: EngravingItem | null = hitElements[currTop]
        const selectedAtPosition = new Set<EngravingItem>()
        let found = false

        // e is the topmost element in stacking order,
        // but we want to replace it with "first non-measure element after a selected element"
        // (if such an element exists)
        for (let i = 0; i <= numHitElements; ++i) {
            if (found) {
                e = hitElements[currTop]
                if (!e.isMeasure()) {
                    break
                }
            } else if (hitElements[currTop].selected()) {
                found = true
                selectedAtPosition.add(hitElements[currTop])
                e = null
            }
            currTop = (currTop + 1) % numHitElements
        }

        if (e && !e.selected()) {
            for (const selectedElem of selectedAtPosition) {
                selectedElem.score().deselect(selectedElem)
            }
            this.viewInteraction().select([e], SelectType.ADD, hitStaffIndex, true)
        }
    }

    /** a left click in note input mode puts a note (Shift: replace, Ctrl: insert); TODO(port): right click removes */
    private handleClickInNoteInputMode(logicPos: PointF, modifiers: { shift: boolean; ctrl: boolean }): void {
        // C++ dispatches "put-note" (NotationActionController::putNote)
        this.viewInteraction().noteInput().putNote(logicPos, modifiers.shift, modifiers.ctrl)
    }

    // ---- note input: the shadow note and the right click (section of the note input port) ----

    /**
     * a right click in note input mode at logicPos: C++ handleClickInNoteInputMode dispatches "remove-note"
     * (NotationNoteInput::removeNote). Returns false outside of note input mode (the context menu, not ported).
     */
    rightClick(logicPos: PointF): boolean {
        const noteInput = this.viewInteraction().noteInput()
        if (!noteInput.isNoteInputMode()) {
            return false
        }
        noteInput.removeNote(logicPos)
        return true
    }

    /** C++ hoverMoveEvent: shows the shadow note at the mouse position in note input mode; returns true if it is shown */
    hoverMove(logicPos: PointF): boolean {
        const interaction = this.viewInteraction()
        if (!interaction.noteInput().isNoteInputMode()) {
            return false
        }

        // TODO(port): the shadow note popup (percussion), locking the x position while it is open
        return interaction.showShadowNoteForPosition(logicPos)
    }

    /** C++ hoverLeaveEvent */
    hoverLeave(): void {
        this.viewInteraction().hideShadowNote()
    }

    /**
     * the selection key actions of MuseScore's notation view without note input (shortcuts.xml); key like
     * KeyboardEvent.key. Returns true if the key is one of these actions.
     */
    keyAction(key: string, mods: KeyboardModifiers): boolean {
        const interaction = this.viewInteraction()
        const { shift, ctrl, alt } = mods

        switch (key) {
        case 'Escape':
            if (shift || ctrl || alt) {
                return false
            }
            // notation-escape (NotationActionController::resetState)
            if (!interaction.score().selection().isNone()) {
                interaction.clearSelection()
            }
            return true
        case 'a':
        case 'A':
            if (ctrl && !shift && !alt) {
                interaction.selectAll() // notation-select-all
                return true
            }
            return false
        case 'ArrowLeft':
        case 'ArrowRight': {
            const d = key === 'ArrowLeft' ? MoveDirection.Left : MoveDirection.Right
            if (shift && !alt) {
                // select-next/prev-chord, Ctrl: select-next/prev-measure
                interaction.addToSelection(d, ctrl ? MoveSelectionType.Measure : MoveSelectionType.Chord)
                return true
            }
            if (alt && !shift && !ctrl) {
                // next-element/prev-element
                interaction.moveSelection(d, MoveSelectionType.EngravingItem)
                return true
            }
            if (!shift && !alt) {
                // notation-move-right/left, Ctrl: notation-move-right/left-quickly
                this.move(d, ctrl)
                return true
            }
            return false
        }
        case 'ArrowUp':
        case 'ArrowDown': {
            const d = key === 'ArrowUp' ? MoveDirection.Up : MoveDirection.Down
            if (shift && !ctrl && !alt) {
                interaction.addToSelection(d, MoveSelectionType.Track) // select-staff-above/below
                return true
            }
            if (alt && !shift && !ctrl) {
                interaction.moveChordNoteSelection(d) // up-chord/down-chord
                return true
            }
            if (alt && ctrl && !shift) {
                interaction.selectTopOrBottomOfChord(d) // top-chord/bottom-chord
                return true
            }
            if (!shift && !alt && !ctrl && interaction.score().selection().isNone()) {
                // pitch-up/down without a selection (NotationActionController::move)
                return this.move(d, false)
            }
            // TODO(port): pitch-up/down (+ctrl: octave), alt+shift: diatonic, ctrl+shift: move-up/down (editing)
            return false
        }
        case 'Home':
        case 'End': {
            const begin = key === 'Home'
            if (shift) {
                // select-begin/end-line, Ctrl: select-begin/end-score
                interaction.expandSelection(ctrl
                    ? (begin ? ExpandSelectionMode.BeginScore : ExpandSelectionMode.EndScore)
                    : (begin ? ExpandSelectionMode.BeginSystem : ExpandSelectionMode.EndSystem))
                return true
            }
            if (ctrl && !alt) {
                // first-element/last-element
                if (begin) {
                    interaction.selectFirstElement(false)
                } else {
                    interaction.selectLastElement()
                }
                return true
            }
            return false
        }
        default:
            return false
        }
    }

    /** NotationActionController::move (without playback, text and grip editing, note input) */
    private move(direction: MoveDirection, quickly: boolean): boolean {
        const interaction = this.viewInteraction()

        const previousSelectionExists = !!interaction.score().selection().currentCR()
        if (interaction.score().selection().isNone() && previousSelectionExists) {
            // Try to restore the previous selection...
            interaction.moveSelection(direction, MoveSelectionType.EngravingItem)
            return true
        }

        switch (direction) {
        case MoveDirection.Up:
        case MoveDirection.Down:
            if (interaction.score().selection().isNone()) {
                interaction.selectFirstElement(false)
                return true
            }
            // TODO(port): lyrics, nudge, movePitch
            return false
        case MoveDirection.Right:
        case MoveDirection.Left: {
            // TODO(port): nudge text elements, grips
            if (interaction.score().selection().isNone()) {
                interaction.selectFirstElement(false)
            }
            interaction.moveSelection(direction, quickly ? MoveSelectionType.Measure : MoveSelectionType.Chord)
            return true
        }
        default:
            return false
        }
    }

    // =================================================================================================================
    //   mouse and keyboard events (mousePressEvent, mouseMoveEvent, mouseReleaseEvent, mouseDoubleClickEvent,
    //   keyPressEvent, shortcutOverrideEvent, inputMethodEvent): selection, element and text editing, drag, lasso
    // =================================================================================================================

    private m_mouseDownInfo: MouseDownInfo = { dragAction: DragAction.Nothing, physicalBeginPoint: { x: 0, y: 0 }, logicalBeginPoint: new PointFValue() }
    private m_shouldSelectOnLeftClickRelease = false
    private m_shouldStartEditOnLeftClickRelease = false
    private m_hitElementWasAlreadySingleSelected = false
    private m_isCanvasDragged = false
    private m_tripleClickPending = false
    private m_notesBeingDragged: EngravingItem[] = []
    private m_hitWidth = 1

    /** hitWidth: C++ hitWidth() = configuration()->selectionProximity() * 0.5 / currentScaling() */
    mousePressEvent(event: ViewMouseEvent, hitWidth: number): void {
        const logicPos = event.logicPos
        const button = event.button
        this.m_hitWidth = hitWidth

        this.m_mouseDownInfo = {
            dragAction: DragAction.Other,
            physicalBeginPoint: { ...event.physicalPos },
            logicalBeginPoint: logicPos.clone(),
        }

        this.m_shouldStartEditOnLeftClickRelease = false

        // When using MiddleButton, just start moving the canvas
        if (button === MouseButton.MiddleButton) {
            return
        }

        const interaction = this.viewInteraction()

        const context: HitElementContext = {
            element: interaction.hitElement(logicPos, hitWidth),
            staff: interaction.hitStaff(logicPos),
        }
        interaction.setHitElementContext(context)

        const hitElement = context.element
        const hitStaffIndex = context.staff ? context.staff.idx() : nidx

        // note enter mode
        if (interaction.noteInput().isNoteInputMode()) {
            this.handleClickInNoteInputMode(logicPos, { shift: event.shift, ctrl: event.ctrl })
            return
        }

        // triple click
        if (this.m_tripleClickPending) {
            if (interaction.isTextEditingStarted()) {
                interaction.selectText(SelectTextType.All)
                return
            }
        }

        if (playbackController()?.isPlaying()) {
            playbackController()!.seekElement(hitElement)
            return
        }

        const ctx: ClickContext = {
            logicClickPos: logicPos,
            hitElement,
            hitStaff: hitStaffIndex,
            isHitGrip: interaction.isHitGrip(logicPos),
            event,
        }

        // Grip
        let consumed = this.mousePressConsiderGrip(ctx)
        if (consumed) {
            return
        }

        // End editing
        if (!ctx.hitElement) {
            interaction.endEditElement()
        }

        // Drag outgoing: element
        consumed = this.mousePressConsiderDragOutgoingElement(ctx)
        if (consumed) {
            return
        }

        // Drag outgoing: range
        consumed = this.mousePressConsiderDragOutgoingRange(ctx)
        if (consumed) {
            return
        }

        // TODO(port): Alt+click to paste range (startDropRange)

        // Select
        this.mousePressConsiderSelectCtx(ctx)

        // Seek
        this.mousePressSeekSelection(ctx)

        // Misc
        if (button === MouseButton.LeftButton) {
            this.handleLeftClick(ctx)
        } else if (button === MouseButton.RightButton) {
            this.m_mouseDownInfo.dragAction = DragAction.Nothing // C++ handleRightClick (context menu)
        }
    }

    private mousePressConsiderGrip(ctx: ClickContext): boolean {
        const interaction = this.viewInteraction()
        if (ctx.isHitGrip && ctx.event.button === MouseButton.LeftButton) {
            interaction.startEditGrip(ctx.logicClickPos)
            return true
        } else if (interaction.isGripEditStarted()) {
            interaction.endEditGrip()
        }

        return false
    }

    private mousePressConsiderSelectCtx(ctx: ClickContext): void {
        if (!ctx.hitElement) {
            return
        }

        const interaction = this.viewInteraction()

        this.m_hitElementWasAlreadySingleSelected = ctx.hitElement === interaction.score().selection().element()

        if (ctx.event.button === MouseButton.LeftButton) {
            if (ctx.event.ctrl) {
                const overlappingHitElements = interaction.hitElements(ctx.logicClickPos, this.m_hitWidth)
                if (overlappingHitElements.length > 1) {
                    this.cycleOverlappingHitElements(overlappingHitElements, ctx.hitStaff)
                    return
                }
            }
        } else if (ctx.event.button === MouseButton.RightButton) {
            if (ctx.hitElement.selected()) {
                return
            }
        }

        let selectType = SelectType.SINGLE
        if (ctx.event.shift) {
            selectType = SelectType.RANGE
        } else if (ctx.event.ctrl) {
            selectType = SelectType.ADD
        } else {
            const selection = interaction.score().selection()

            if (selection.isRange()
                && (interaction.rangeContainsItem(ctx.hitElement, ctx.hitStaff) || interaction.rangeContainsPoint(ctx.logicClickPos))) {
                this.m_shouldSelectOnLeftClickRelease = true
                return
            } else if (ctx.hitElement.selected()) {
                if (selection.elements().length > 1) {
                    this.m_shouldSelectOnLeftClickRelease = true
                }
                return
            }
        }

        interaction.select([ctx.hitElement], selectType, ctx.hitStaff, ctx.event.ctrl && !ctx.event.shift)
    }

    private mousePressConsiderDragOutgoingElement(ctx: ClickContext): boolean {
        if (ctx.event.button !== MouseButton.LeftButton || !(ctx.event.shift && ctx.event.ctrl && !ctx.event.alt)) {
            return false
        }

        if (!ctx.hitElement || !this.viewInteraction().isOutgoingDragElementAllowed(ctx.hitElement)) {
            return false
        }

        this.viewInteraction().select([ctx.hitElement], SelectType.SINGLE, ctx.hitStaff)
        playbackController()?.seekElement(ctx.hitElement)
        this.m_mouseDownInfo.dragAction = DragAction.DragOutgoingElement

        return true
    }

    private mousePressConsiderDragOutgoingRange(ctx: ClickContext): boolean {
        if (ctx.event.button !== MouseButton.LeftButton) {
            return false
        }

        if (!ctx.hitElement || ctx.hitElement.isMeasure()) {
            const selection = this.viewInteraction().score().selection()

            if (selection.isRange() && this.viewInteraction().rangeContainsPoint(ctx.logicClickPos)) {
                // TODO(port): the drag of the range to other applications (startOutgoingDragRange)
                this.m_mouseDownInfo.dragAction = DragAction.DragOutgoingRange
                return true
            }
        }

        return false
    }

    /** C++ mousePress_seekSelection */
    private mousePressSeekSelection(ctx: ClickContext): void {
        const selection = this.viewInteraction().score().selection()
        const elements = selection.elements()
        if (elements.length === 0) {
            return
        }

        if (!selection.isRange()) {
            playbackController()?.seekElement(elements[elements.length - 1])
            return
        }

        let elementToSeek = ctx.hitElement

        for (const element of elements) {
            if (!element || element === elementToSeek) {
                continue
            }

            if (!seekAllowed(element)) {
                continue
            }

            if (elementToSeek && elementToSeek.tick().le(element.tick())) {
                continue
            }

            elementToSeek = element
        }

        playbackController()?.seekElement(elementToSeek)
    }

    private handleLeftClick(ctx: ClickContext): void {
        const interaction = this.viewInteraction()
        if (!ctx.hitElement || !ctx.hitElement.selected()) {
            return
        }

        // If it is the only selected element, start editing if needed
        if (ctx.hitElement === interaction.score().selection().element()
            && ctx.hitElement.needStartEditingAfterSelecting()) {
            interaction.startEditElement(ctx.hitElement)
        }

        if (ctx.hitElement.isPlayable()) {
            playbackController()?.playElements([ctx.hitElement])
        }

        if (interaction.isTextSelected()) {
            this.updateTextCursorPosition()
        }
    }

    startTextEditingAllowed(): boolean {
        const interaction = this.viewInteraction()
        return interaction.isTextSelected() && !interaction.isTextEditingStarted()
    }

    private updateTextCursorPosition(): void {
        if (this.viewInteraction().isTextEditingStarted()) {
            this.viewInteraction().changeTextCursorPosition(this.m_mouseDownInfo.logicalBeginPoint)
            // TODO(port): text style popup
        }
    }

    /** returns what the view has to do: move the canvas by the logical delta, or nothing */
    mouseMoveEvent(event: ViewMouseEvent): { moveCanvas: PointF | null } {
        const none = { moveCanvas: null }
        if (this.m_mouseDownInfo.dragAction === DragAction.Nothing) {
            return none
        }

        const interaction = this.viewInteraction()
        const dx = event.physicalPos.x - this.m_mouseDownInfo.physicalBeginPoint.x
        const dy = event.physicalPos.y - this.m_mouseDownInfo.physicalBeginPoint.y

        const isDragStarted = this.m_isCanvasDragged || interaction.isDragStarted()
        if (!isDragStarted) {
            // only start drag operations after a minimum of movement:
            const canStartDrag = Math.abs(dx) + Math.abs(dy) > 4
            if (!canStartDrag) {
                return none
            }
        }

        switch (this.m_mouseDownInfo.dragAction) {
        case DragAction.DragOutgoingElement: {
            // C++ QDrag::exec takes over the mouse events; here the view continues the drag (outgoingDrag())
            if (!isDragStarted && !interaction.isOutgoingDragStarted()) {
                const element = interaction.hitElementContext().element!
                const hotSpot = this.m_mouseDownInfo.logicalBeginPoint.minus(element.canvasBoundingRect().topLeft())

                interaction.startOutgoingDragElement(element, hotSpot)
            }
            return none
        }
        case DragAction.DragOutgoingRange:
            return none // TODO(port): startOutgoingDragRange
        case DragAction.Other:
            break
        default:
            return none
        }

        const logicPos = event.logicPos

        const isNoteEnterMode = interaction.noteInput().isNoteInputMode()
        const isMiddleButton = (event.buttons & MouseButton.MiddleButton) !== 0
        const isDragObjectsAllowed = !(isNoteEnterMode || isMiddleButton)
        if (isDragObjectsAllowed) {
            const hitElement = interaction.hitElementContext().element

            // drag element
            if ((hitElement && (hitElement.isMovable() || interaction.isEditingElement())) || interaction.isGripEditStarted()) {
                if (hitElement && !interaction.isDragStarted()) {
                    this.startDragElements(hitElement.type(), hitElement.offset(), event.modifiers)
                }

                if (interaction.isGripEditStarted() && !interaction.isDragStarted()) {
                    const selectedElement = interaction.score().selection().element()
                    const type = selectedElement ? selectedElement.type() : ElementType.INVALID
                    this.startDragElements(type, selectedElement ? selectedElement.offset() : new PointFValue(), event.modifiers)
                }

                let mode = DragMode.BothXY
                if (event.shift) {
                    mode = DragMode.OnlyY
                } else if (event.ctrl) {
                    mode = DragMode.OnlyX
                }

                const oldPitches = this.pitchesBeingDragged()
                interaction.drag(this.m_mouseDownInfo.logicalBeginPoint, logicPos, mode, event.modifiers)

                if (oldPitches.length && oldPitches.join() !== this.pitchesBeingDragged().join()) {
                    playbackController()?.playElements(this.m_notesBeingDragged)
                }

                return none
            } else if (hitElement === null && event.shift) {
                if (!interaction.isDragStarted()) {
                    interaction.startDrag([], new PointFValue(), () => false, event.modifiers)
                }
                interaction.drag(this.m_mouseDownInfo.logicalBeginPoint, logicPos, DragMode.BothXY, event.modifiers)

                return none
            }
        }

        // move canvas
        if (!isNoteEnterMode || isMiddleButton) {
            const logicalDragDelta = logicPos.minus(this.m_mouseDownInfo.logicalBeginPoint)
            this.m_isCanvasDragged = true
            return { moveCanvas: logicalDragDelta }
        }
        return none
    }

    private startDragElements(elementsType: ElementType, elementsOffset: PointF, modifiers: number): void {
        if (elementsType === ElementType.INVALID) {
            return
        }

        const interaction = this.viewInteraction()
        const elements = interaction.score().selection().elements()
        if (elements.length === 0) {
            return
        }

        const isFilterType = interaction.score().selection().isRange()
        const isDraggable = (element: EngravingItem | null): boolean => {
            return !!element && element.selected() && (!isFilterType || elementsType === element.type())
        }

        interaction.startDrag(elements, elementsOffset, isDraggable, modifiers)

        if (!interaction.isDragStarted()) {
            return
        }

        for (const item of elements) {
            if (item.isNote()) {
                this.m_notesBeingDragged.push(item)
            }
        }
    }

    private pitchesBeingDragged(): number[] {
        return this.m_notesBeingDragged.map(item => (item as unknown as Note).pitch())
    }

    mouseReleaseEvent(event: ViewMouseEvent): void {
        if (this.m_mouseDownInfo.dragAction === DragAction.Nothing) {
            return
        }

        const interaction = this.viewInteraction()
        const noteInput = interaction.noteInput()
        const hitElement = interaction.hitElementContext().element

        const onlyCtrl = event.ctrl && !event.shift && !event.alt
        const onlyShift = event.shift && !event.ctrl && !event.alt
        if (!onlyCtrl && !onlyShift) {
            if (!hitElement && !this.m_isCanvasDragged && !interaction.isGripEditStarted()
                && !interaction.isDragStarted() && !noteInput.isNoteInputMode()) {
                interaction.clearSelection()
            }
        }

        if (event.button === MouseButton.LeftButton && !event.shift && !event.ctrl && !event.alt) {
            this.handleLeftClickRelease(event)
        }

        this.m_isCanvasDragged = false
        interaction.endOutgoingDrag()

        if (interaction.isDragStarted()) {
            interaction.endDrag()
            // TODO(port): dynamic popup after dragging the grip of a hairpin
        }

        this.m_mouseDownInfo.dragAction = DragAction.Nothing
        this.m_notesBeingDragged = []
    }

    private handleLeftClickRelease(event: ViewMouseEvent): void {
        const interaction = this.viewInteraction()
        if (interaction.noteInput().isNoteInputMode() || playbackController()?.isPlaying()) {
            return
        }

        if (this.m_shouldStartEditOnLeftClickRelease) {
            // C++ dispatches "edit-element" with the position
            const element = interaction.score().selection().element()
            if (element) {
                if (interaction.textEditingAllowed(element)) {
                    interaction.startEditText(element, this.m_mouseDownInfo.logicalBeginPoint)
                } else {
                    interaction.startEditElement(element)
                }
            }
            this.m_shouldStartEditOnLeftClickRelease = false
            return
        }

        const ctx = interaction.hitElementContext()
        if (!ctx.element) {
            return
        }

        if (event.physicalPos.x !== this.m_mouseDownInfo.physicalBeginPoint.x
            || event.physicalPos.y !== this.m_mouseDownInfo.physicalBeginPoint.y) {
            return
        }

        if (this.m_shouldSelectOnLeftClickRelease) {
            this.m_shouldSelectOnLeftClickRelease = false
            const staffIndex = ctx.staff ? ctx.staff.idx() : nidx

            interaction.select([ctx.element], SelectType.SINGLE, staffIndex)

            if (ctx.element.needStartEditingAfterSelecting()) {
                interaction.startEditElement(ctx.element)
                return
            }
        }

        if (!this.m_hitElementWasAlreadySingleSelected) {
            return
        }

        // Same element clicked again while it was already selected.
        // Either toggle popup or start text editing.

        if (interaction.textEditingAllowed(ctx.element)) {
            if (!interaction.isTextEditingStarted()) {
                interaction.startEditText(ctx.element, this.m_mouseDownInfo.logicalBeginPoint)
            }
        }
        // TODO(port): else togglePopupForItemIfSupports
    }

    /** the UI resets the triple click state after the double click interval (C++ QTimer) */
    mouseDoubleClickEvent(event: ViewMouseEvent): void {
        const interaction = this.viewInteraction()
        if (interaction.noteInput().isNoteInputMode()) {
            return
        }

        this.m_tripleClickPending = true

        if (interaction.isTextEditingStarted()) {
            interaction.selectText(SelectTextType.Word)
            return
        }

        const hitElement = interaction.hitElementContext().element
        if (!hitElement) {
            return
        }

        if (interaction.textEditingAllowed(hitElement)) {
            interaction.startEditText(hitElement, this.m_mouseDownInfo.logicalBeginPoint)
            return
        }

        const noModifier = !event.shift && !event.ctrl && !event.alt
        let selectType: SelectType | null = null
        if (noModifier) {
            selectType = SelectType.REPLACE
        } else if (event.ctrl && !event.shift && !event.alt) {
            selectType = SelectType.ADD
        }

        switch (hitElement.type()) {
        case ElementType.INSTRUMENT_NAME:
            if (noModifier) {
                this.m_shouldStartEditOnLeftClickRelease = true
            }
            break
        case ElementType.MEASURE:
            if (noModifier) {
                // C++ dispatches "note-input" at the position
                interaction.noteInput().startNoteInput(NotationConfiguration.defaultNoteInputMethod())
            }
            break
        case ElementType.NOTE: {
            if (selectType === null) {
                break // Unsupported modifier(s)...
            }
            const chord = (hitElement as unknown as Note).chord()
            const notes = chord.notes()
            if (selectType === SelectType.ADD && notes.every(n => n.selected())) {
                for (const n of notes) {
                    n.score().deselect(n)
                }
            } else {
                interaction.select(notes, selectType)
            }
            break
        }
        default: break
        }
    }

    resetTripleClick(): void {
        this.m_tripleClickPending = false
    }

    /**
     * C++ shortcutOverrideEvent: true if the key goes to the view (editing of the selected element, Enter to start
     * text editing) instead of being a shortcut
     */
    shortcutOverrideEvent(event: NotationKeyEvent): boolean {
        const key = event.key

        const editTextKeysFound = key === KeyboardKey.Key_Return || key === KeyboardKey.Key_Enter
        if (editTextKeysFound && this.startTextEditingAllowed()) {
            return true
        }

        const interaction = this.viewInteraction()
        if (interaction.isEditingElement()) {
            return interaction.isEditAllowed(event)
        }

        if (this.isAnchorEditingEvent(event)) {
            return true
        }

        // TODO(port): percussion shortcuts (tryPercussionShortcut)
        return false
    }

    /** Shift(+Alt)+Left/Right with a selected element that can be anchored to beats */
    isAnchorEditingEvent(event: NotationKeyEvent): boolean {
        const anchorEditingKeyCombo = (event.key === KeyboardKey.Key_Left || event.key === KeyboardKey.Key_Right)
            && (event.modifiers & KeyboardModifier.ShiftModifier) !== 0
        const selectedItem = this.viewInteraction().score().selection().element()
        return !!selectedItem && selectedItem.allowTimeAnchor() && anchorEditingKeyCombo
    }

    /** C++ keyPressEvent; returns true if the key was handled */
    keyPressEvent(event: NotationKeyEvent): boolean {
        const interaction = this.viewInteraction()
        if (this.startTextEditingAllowed() && (event.key === KeyboardKey.Key_Return || event.key === KeyboardKey.Key_Enter)) {
            // C++ dispatches "edit-text"
            const element = interaction.score().selection().element()
            if (interaction.textEditingAllowed(element)) {
                interaction.startEditText(element, new PointFValue())
            }
            return true
        } else if (interaction.isEditingElement()) {
            const accepted = interaction.editElement(event)
            if (event.key === KeyboardKey.Key_Shift) {
                interaction.updateTimeTickAnchors(true)
            }
            return accepted
        } else if (event.key === KeyboardKey.Key_Shift) {
            interaction.updateTimeTickAnchors(true)
            return false
        } else if (this.isAnchorEditingEvent(event)) {
            interaction.moveElementAnchors(event)
            return true
        }
        return false
    }

    /** C++ keyReleaseEvent: releasing Shift hides the anchors */
    keyReleaseEvent(event: NotationKeyEvent): void {
        if (event.key !== KeyboardKey.Key_Shift) {
            return
        }

        this.viewInteraction().editElement(event)
        this.viewInteraction().updateTimeTickAnchors(false)
    }

    /** C++ inputMethodEvent: committed text or the preedit string of a composition */
    inputMethodEvent(commitString: string, preeditString: string): void {
        if (this.viewInteraction().isTextEditingStarted()) {
            this.viewInteraction().editText(commitString, preeditString)
        }
    }
}

/** a mouse event of the view: position in canvas coordinates, view pixels (for the drag threshold), buttons, modifiers */
export interface ViewMouseEvent {
    logicPos: PointF
    physicalPos: { x: number; y: number }
    /** the button of a press/release (editing/editdata.ts MouseButton) */
    button: MouseButton
    /** the pressed buttons (MouseButton flags) */
    buttons: number
    shift: boolean
    ctrl: boolean
    alt: boolean
    /** KeyboardModifier flags */
    modifiers: number
}

enum DragAction {
    Nothing,
    Other,
    DragOutgoingElement,
    DragOutgoingRange,
    PasteRangeOnRelease,
}

interface MouseDownInfo {
    dragAction: DragAction
    physicalBeginPoint: { x: number; y: number }
    logicalBeginPoint: PointF
}

interface ClickContext {
    logicClickPos: PointF
    hitElement: EngravingItem | null
    hitStaff: staff_idx_t
    isHitGrip: boolean
    event: ViewMouseEvent
}
