/*
 * SPDX-License-Identifier: GPL-3.0-only
 * MuseEncore Editor: the score view (plain DOM code taken over from the web viewer, ../viewer): shows the pages of
 * the open score (horizontally, vertically or as two-page spreads), zoom, navigation, printing. The app (app.tsx)
 * opens and closes scores through showScore() / clearScore() and gets the user's commands through the handlers.
 * Keyboard shortcuts follow MuseScore Studio (src/app/configs/data/shortcuts.xml) where they make sense.
 */
/// <reference types="vite/client" />
import { showScoreContextMenu } from './components/ScoreContextMenu'
import { isInstrumentChangeSymbol, withSelectedInstrument } from './dialogs/instrumentchoice'
import { useSyncExternalStore } from 'react'
import {
    clearSelection, drawPage, drawPageSvg, setCanLayoutIcons, hasSelection, initEngravingFonts, isModified, isTwoSided, moveSelection,
    firstMeasureBounds, noteInputCursorBounds, noteInputState, onImageDecoded, onNotationChanged, pageCount, pageSize, scoreTitle, selectAll, selectionBounds, selectionInfo,
    SvgGlyphDefs, type MasterScore, type Score, currentNotation, onCurrentNotationChanged, setViewMode as setScoreViewMode, type ViewMode, drawContinuousPanel,
    // copy/paste, text editing, drag
    CLIPBOARD_FORMATS, clipboardContents, executeAction, isActionEnabled, isDragging, setClipboardContents, setClipboardImage, textEditingInfo,
    viewInputText, viewKeyPress, viewMouseDoubleClick, viewMouseMove, viewMousePress, viewMouseRelease, viewResetTripleClick,
    viewKeyRelease, viewShortcutOverride, type ViewKeyEvent, type ViewPointerEvent,
    // drag and drop of palette cells onto the score
    viewDragEnter, viewDragLeave, viewDragMove, viewDrop, type OutgoingElementDrag, type ViewDragEvent,
} from '../src/index'
import { NotationConfiguration, NoteEntryMethod, drawShadowNote, hideShadowNote, rightClickAt, scoreBaseName, showShadowNote } from '../src/index'
import { setShortcutOverride } from './actions/actions'
import { ELEMENT_DROP_EVENT, dragData, setDragData, type ElementDropDetail } from './dragcontroller'
import { onSettingsChanged, settings as appSettings, updateSettings, type ViewSettings } from './settings'

/** commands of the score view that the app handles */
export const handlers = {
    openFile: (_file: File): void => {},
}

// ---------------------------------------------------------------------------------
//   elements
// ---------------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

export const viewport = $<HTMLElement>('viewport')
const pagesDiv = $<HTMLDivElement>('pages')
const helpDialog = $<HTMLDialogElement>('help-dialog')

// ---------------------------------------------------------------------------------
//   the state shown by the React UI (toolbar, tabs, status bar)
// ---------------------------------------------------------------------------------

export interface ScoreViewState {
    hasScore: boolean
    /** file name without extension (like MuseScore's tab) and the score title as tooltip */
    title: string
    tooltip: string
    /** "1 / 4", "2–3 / 4" */
    pageText: string
    canPrev: boolean
    canNext: boolean
    zoom: number
    fitMode: FitMode | null
    orientation: 'horizontal' | 'vertical'
    spread: boolean
    /** page view or one of the continuous views */
    viewMode: ViewMode
    spreadAvailable: boolean
    fullscreen: boolean
    status: string
    statusError: boolean
    /** the selection's accessibility info (MuseScore's status bar); '' without a selection */
    selection: string
    /** the score was changed since it was opened or saved (its undo stack is not clean) */
    modified: boolean
    /** note input mode is on */
    noteInput: boolean
    /** counts the selection changes (for the panels: the Properties panel shows the selection) */
    selectionVersion: number
    /** counts the scores shown and their changes (command, undo, redo): the toolbars and panels update their states */
    scoreVersion: number
}

let viewState: ScoreViewState = {
    hasScore: false, title: '', tooltip: '', pageText: '–', canPrev: false, canNext: false, zoom: 100, fitMode: null,
    orientation: 'horizontal', spread: false, viewMode: 'page', spreadAvailable: false, fullscreen: false, status: '', statusError: false,
    selection: '', modified: false, noteInput: false, selectionVersion: 0, scoreVersion: 0,
}
const viewListeners = new Set<() => void>()

function publish(patch: Partial<ScoreViewState>): void {
    if (Object.entries(patch).every(([k, v]) => viewState[k as keyof ScoreViewState] === v)) {
        return
    }
    viewState = { ...viewState, ...patch }
    for (const l of viewListeners) {
        l()
    }
}

export function scoreViewState(): ScoreViewState {
    return viewState
}

export function onScoreViewChanged(listener: () => void): () => void {
    viewListeners.add(listener)
    return () => viewListeners.delete(listener)
}

export function useScoreView(): ScoreViewState {
    return useSyncExternalStore(onScoreViewChanged, scoreViewState)
}

/** the score of the current notation: the master score or an open part (C++ currentNotation) */
export function currentScore(): Score | null {
    return score
}

/** the master score of the open project (C++ currentMasterNotation; saving, playback, the Parts dialog) */
export function currentMasterScore(): MasterScore | null {
    return master
}

// ---------------------------------------------------------------------------------
//   state
// ---------------------------------------------------------------------------------

/** MuseScore's zoom steps (NotationViewInputController::ZOOM_LEVELS) */
export const ZOOM_LEVELS = [5, 10, 15, 25, 50, 75, 100, 150, 200, 400, 800, 1600]
const MIN_ZOOM = ZOOM_LEVELS[0]
const MAX_ZOOM = ZOOM_LEVELS[ZOOM_LEVELS.length - 1]
const CSS_DPI = 96 // CSS pixels per inch at 100%
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024 // larger pages are drawn as tiles of the visible part
const MAX_CANVAS_SIZE = 16384 // also pages longer than this (continuous views)

const FIT_MODES = ['page-width', 'whole-page'] as const
export type FitMode = typeof FIT_MODES[number]

let master: MasterScore | null = null
let score: Score | null = null
let fileName = ''
const settings: ViewSettings = { ...appSettings().view }
const saveSettings = (s: ViewSettings): void => updateSettings('view', s)
let zoom = 100 // current zoom in percent
let pages: HTMLDivElement[] = []
const visible = new Set<HTMLDivElement>()
let renderTimer = 0
let unsubscribeNotation: (() => void) | null = null
let externalChangeTimer = 0

function fitMode(): FitMode | null {
    return (FIT_MODES as readonly string[]).includes(settings.zoom) ? settings.zoom as FitMode : null
}

function spreadActive(): boolean {
    return !!score && settings.viewMode === 'page' && settings.spread && isTwoSided(score)
}

export function setStatus(text: string, error = false): void {
    publish({ status: text, statusError: error })
}

// ---------------------------------------------------------------------------------
//   busy overlay: the layout is synchronous, the UI is blocked while a file is opened
// ---------------------------------------------------------------------------------

const busyEl = $<HTMLDivElement>('busy')

export function isBusy(): boolean {
    return !busyEl.hidden
}

/** shows the overlay and waits until it is painted */
export async function showBusy(title: string, detail = ''): Promise<void> {
    $('busy-title').textContent = title
    $('busy-title').title = title
    $('busy-detail').textContent = detail
    if (busyEl.hidden) {
        busyEl.hidden = false
        document.body.setAttribute('aria-busy', 'true')
        viewport.setAttribute('inert', '')
    }
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve)))
}

/** shows the overlay again with its last texts (after a question while loading) */
export function resumeBusy(): Promise<void> {
    return showBusy($('busy-title').textContent ?? '', $('busy-detail').textContent ?? '')
}

export function hideBusy(): void {
    busyEl.hidden = true
    document.body.removeAttribute('aria-busy')
    viewport.removeAttribute('inert')
}

// ---------------------------------------------------------------------------------
//   fonts and the open score
// ---------------------------------------------------------------------------------

// the editor shows the layout break icons like MuseScore (not printed)
setCanLayoutIcons(true)

/** resolves when the engraving fonts are loaded (rejects if they cannot be loaded) */
export const fontsReady = initEngravingFonts(async (path) => {
    const res = await fetch(`${import.meta.env.BASE_URL}${path}`)
    if (!res.ok) {
        throw new Error(`could not load font ${path}`)
    }
    return res.arrayBuffer()
})
fontsReady.then(() => setStatus('Ready'), (e: Error) => setStatus(`Error: ${e.message}`, true))

/** shows a laid out score; `name` is the file name (or the title of a new score) */
export function showScore(s: MasterScore, name: string): void {
    master = s
    fileName = name
    showNotation(currentNotation(s))
}

/** shows the score of a notation (the master score or a part) */
function showNotation(s: Score): void {
    unsubscribeNotation?.()
    removeShadowNote()
    score = s
    // changes made by a timer (real-time note input) are shown like the changes of commands
    unsubscribeNotation = onNotationChanged(s, () => {
        clearTimeout(externalChangeTimer)
        externalChangeTimer = window.setTimeout(() => scoreChanged(), 0)
    })
    publish({ selection: '', modified: isModified(s), noteInput: noteInputState(s).active, selectionVersion: viewState.selectionVersion + 1, scoreVersion: viewState.scoreVersion + 1 })
    printPagesDiv.replaceChildren()
    applyViewMode()
    buildPages()
}

// NotationSwitchListModel / the Parts dialog: another notation of the open project becomes the current one
// (the tabs may switch while React renders them: the view is switched afterwards)
onCurrentNotationChanged((m) => {
    queueMicrotask(() => {
        if (m === master && score !== currentNotation(m)) {
            showNotation(currentNotation(m))
            viewShown()
        }
    })
})

export function clearScore(): void {
    unsubscribeNotation?.()
    unsubscribeNotation = null
    removeShadowNote()
    score = null
    master = null
    publish({ selection: '', modified: false, noteInput: false, selectionVersion: viewState.selectionVersion + 1, scoreVersion: viewState.scoreVersion + 1 })
    fileName = ''
    printPagesDiv.replaceChildren()
    buildPages()
    setStatus('Ready')
}

/** the score was saved: its modified state changed (no new layout) */
export function scoreSaved(): void {
    if (score) {
        publish({ modified: isModified(score) })
    }
}

/** called when the score view becomes visible again (its size was 0 while hidden) */
export function viewShown(): void {
    updatePan()
    if (score) {
        const page = currentPage()
        applyZoom(computeZoom())
        centerPage(page)
    }
    viewport.focus({ preventScroll: true })
}

// ---------------------------------------------------------------------------------
//   pages
// ---------------------------------------------------------------------------------

const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
        const el = e.target as HTMLDivElement
        if (e.isIntersecting) {
            visible.add(el)
        } else {
            visible.delete(el)
        }
    }
    scheduleRender(0)
    updatePageInfo()
}, { root: viewport, rootMargin: '50%' })

/** a page is a white box; its canvas covers the whole page or, at high zoom, only the visible part */
function makePage(idx: number): HTMLDivElement {
    const el = document.createElement('div')
    el.className = 'page'
    el.dataset.page = String(idx)
    el.setAttribute('role', 'img')
    el.setAttribute('aria-label', `Page ${idx + 1}`)
    el.appendChild(document.createElement('canvas'))
    return el
}

/** like MuseScore's tab: the file name without extension; the score title as tooltip */
function publishName(): void {
    const title = score ? scoreBaseName(fileName) : ''
    publish({ hasScore: !!score, title, tooltip: score ? [scoreTitle(score), fileName].filter(Boolean).join(' – ') : '' })
    document.title = score ? `${title} – MuseEncore` : 'MuseEncore'
}

/** the score got another file name (Save as) */
export function setScoreName(name: string): void {
    fileName = name
    publishName()
}

const pagesBuiltListeners = new Set<() => void>()

/** the page elements were made again (overlays like the playback cursor are added to them again) */
export function onPagesBuilt(listener: () => void): () => void {
    pagesBuiltListeners.add(listener)
    return () => pagesBuiltListeners.delete(listener)
}

/** the element of a page (null if there is none): overlays are positioned in percent of it */
export function pageElement(idx: number): HTMLDivElement | null {
    return pages[idx] ?? null
}

/** the size of a page in inches */
export function pageInches(idx: number): { width: number; height: number } | null {
    return score && idx >= 0 && idx < pageCount(score) ? pageSize(score, idx) : null
}

let s_programmaticScroll = 0

/** a rectangle of a page (inches) */
type Rect = { x: number; y: number; width: number; height: number }

/**
 * C++ AbstractNotationPaintView::adjustCanvasPosition (and alignToCurrentPageBorder): moves the view so that a
 * rectangle of a page (inches) is visible, with a border; returns true if the view moved. Unlike C++, the continuous
 * views keep the position across their direction (vertical in the horizontal view, horizontal in the vertical one)
 * unless the rectangle is moved into the view on that axis: alignToCurrentPageBorder would align it to the page there.
 */
export function adjustViewToRect(pageIdx: number, r: Rect, adjustVertically: boolean, borderInches: number): boolean {
    const el = pages[pageIdx]
    if (!el || !score) {
        return false
    }
    const pr = el.getBoundingClientRect()
    const f = pr.width / pageSize(score, pageIdx).width
    const vr = viewport.getBoundingClientRect()
    // account for the continuous panel if panning in the continuous view
    const panelWidth = settings.viewMode !== 'continuous-horizontal' ? 0
        : panelBox.isConnected ? panelBox.getBoundingClientRect().width : s_panelWidth
    const view = { left: vr.left + panelWidth, top: vr.top, width: viewport.clientWidth - panelWidth, height: viewport.clientHeight }
    const show = { left: pr.left + r.x * f, top: pr.top + r.y * f, width: r.width * f, height: r.height * f }
    const right = (b: { left: number; width: number }): number => b.left + b.width
    const bottom = (b: { top: number; height: number }): number => b.top + b.height

    if (view.width * view.height < show.width * show.height) {
        return false
    }
    if (show.left >= view.left && right(show) <= right(view) && show.top >= view.top && bottom(show) <= bottom(view)) {
        return false
    }

    const border = borderInches * f
    const pos = { x: vr.left, y: vr.top }
    let movedX = false
    let movedY = false

    // the rectangle is placed right of the panel
    let afterPanel = false
    if (show.left < view.left) {
        pos.x = show.left - border - panelWidth
        movedX = afterPanel = true
    } else if (show.left > right(view)) {
        pos.x = right(show) - viewport.clientWidth + border
        movedX = true
    } else if (view.width >= show.width && right(show) > right(view)) {
        pos.x = show.left - border - panelWidth
        movedX = afterPanel = true
    }

    if (adjustVertically) {
        if (show.top < view.top && bottom(show) < bottom(view)) {
            pos.y = show.top - border
            movedY = true
        } else if (show.top > bottom(view)) {
            pos.y = bottom(show) - view.height + border
            movedY = true
        } else if (view.height >= show.height && bottom(show) > bottom(view)) {
            pos.y = show.top - border
            movedY = true
        }
    }

    // alignToCurrentPageBorder
    const fullWidth = viewport.clientWidth
    if (settings.viewMode !== 'continuous-vertical' || movedX) {
        if (pos.x < pr.left || fullWidth >= pr.width) {
            pos.x = pr.left
        } else if (fullWidth < pr.width && fullWidth + pos.x > pr.right) {
            pos.x = pr.right - fullWidth
        }
    }
    if (settings.viewMode !== 'continuous-horizontal' || movedY) {
        if (pos.y < pr.top || view.height >= pr.height) {
            pos.y = pr.top
        } else if (view.height < pr.height && view.height + pos.y > pr.bottom) {
            pos.y = pr.bottom - view.height
        }
    }

    const dx = Math.round(pos.x - vr.left)
    const dy = Math.round(pos.y - vr.top)
    if (!dx && !dy) {
        return false
    }
    s_programmaticScroll++
    viewport.scrollBy(dx, dy)
    if (afterPanel && settings.viewMode === 'continuous-horizontal') {
        // not in C++: the panel is drawn for the new position now, and the view corrects for its width (unknown when it
        // was not shown before, e.g. at the start of the score) instead of moving again in the next frame
        updateContinuousPanel()
        const d = Math.round((panelBox.isConnected ? panelBox.getBoundingClientRect().width : 0) - panelWidth)
        if (d) {
            viewport.scrollBy(-d, 0)
            updateContinuousPanel()
        }
    }
    requestAnimationFrame(() => { s_programmaticScroll = Math.max(0, s_programmaticScroll - 1) })
    return true
}

/**
 * not in MuseScore (the playalong): moves the view so that a rectangle of a page (inches) is fully visible, not covered
 * by the continuous panel at the left edge, with a margin; if it has to move, `context` (a rectangle containing
 * `r`, e.g. with the previous measure) is shown instead when it fits. The rectangle is placed at the left (top) of the
 * view so that what follows is visible. `ahead` (what follows `r` on the page, e.g. the next measure) turns the view one
 * step early: it moves when `ahead` is cut off at the right (bottom), so the measure played next is visible before it is
 * reached. The continuous views only move in their direction (the horizontal one only horizontally, the vertical one
 * only vertically): the position across it stays where the user put it. Returns true if the view moved.
 */
export function showRectInView(pageIdx: number, r: Rect, context?: Rect, ahead?: Rect, marginInches = 0.2,
                               recheck = true): boolean {
    const el = pages[pageIdx]
    if (!el || !score) {
        return false
    }
    const followX = settings.viewMode !== 'continuous-vertical'
    const followY = settings.viewMode !== 'continuous-horizontal'
    const pr = el.getBoundingClientRect()
    const f = pr.width / pageSize(score, pageIdx).width
    const vr = viewport.getBoundingClientRect()
    const margin = marginInches * f
    // the panel appears when the view moves away from the start of the score: its last width
    const inset = settings.viewMode !== 'continuous-horizontal' ? 0
        : panelBox.isConnected ? panelBox.getBoundingClientRect().width : s_panelWidth
    const view = { left: vr.left + inset + margin, top: vr.top + margin, right: vr.left + viewport.clientWidth - margin, bottom: vr.top + viewport.clientHeight - margin }
    const toView = (x: Rect): { left: number; top: number; right: number; bottom: number } =>
        ({ left: pr.left + x.x * f, top: pr.top + x.y * f, right: pr.left + (x.x + x.width) * f, bottom: pr.top + (x.y + x.height) * f })
    const show = toView(r)
    const next = ahead ? toView(ahead) : null
    let dx = 0
    let dy = 0
    if (followX && (show.left < view.left || show.right > view.right
        || (next && next.left >= show.left && next.right > view.right && Math.abs(next.top - show.top) < 1))) {
        const c = context ? toView(context) : null
        const target = c && c.right - c.left <= view.right - view.left ? c : show
        dx = target.left - view.left
    }
    if (followY && (show.top < view.top || show.bottom > view.bottom || (next && next.top > show.top && next.bottom > view.bottom))) {
        dy = show.bottom - show.top <= view.bottom - view.top ? show.top - view.top : show.top - vr.top
    }
    dx = Math.round(dx)
    dy = Math.round(dy)
    if (!dx && !dy) {
        return false
    }
    const left = viewport.scrollLeft
    const top = viewport.scrollTop
    s_programmaticScroll++
    viewport.scrollBy(dx, dy)
    requestAnimationFrame(() => { s_programmaticScroll = Math.max(0, s_programmaticScroll - 1) })
    if (recheck) {
        // once the panel is drawn for the new position (its width is known then)
        requestAnimationFrame(() => requestAnimationFrame(() => showRectInView(pageIdx, r, context, ahead, marginInches, false)))
    }
    return viewport.scrollLeft !== left || viewport.scrollTop !== top
}

/**
 * C++ AbstractNotationPaintView::adjustCanvasPositionSmoothPan: the rectangle of a page (inches) moves to the middle of
 * the view horizontally (vertically too if it is not in the view); returns true if the view moved
 */
export function centerViewOnRect(pageIdx: number, r: { x: number; y: number; width: number; height: number }): boolean {
    const el = pages[pageIdx]
    if (!el || !score) {
        return false
    }
    const pr = el.getBoundingClientRect()
    const f = pr.width / pageSize(score, pageIdx).width
    const vr = viewport.getBoundingClientRect()
    const show = { left: pr.left + r.x * f, top: pr.top + r.y * f, width: r.width * f, height: r.height * f }
    const inView = show.left < vr.left + viewport.clientWidth && show.left + show.width > vr.left
        && show.top < vr.top + viewport.clientHeight && show.top + show.height > vr.top
    const left = viewport.scrollLeft
    const top = viewport.scrollTop
    s_programmaticScroll++
    viewport.scrollLeft += show.left - (vr.left + viewport.clientWidth / 2)
    if (!inView) {
        viewport.scrollTop += show.top - (vr.top + viewport.clientHeight / 2)
    }
    requestAnimationFrame(() => { s_programmaticScroll = Math.max(0, s_programmaticScroll - 1) })
    return viewport.scrollLeft !== left || viewport.scrollTop !== top
}

const userMovedListeners = new Set<() => void>()

/** the user moved the view (wheel, scroll bars, the hand tool): the automatic panning pauses (C++ moveCanvas) */
export function onUserMovedView(listener: () => void): () => void {
    userMovedListeners.add(listener)
    return () => userMovedListeners.delete(listener)
}

function userMovedView(): void {
    for (const l of userMovedListeners) {
        l()
    }
}

function buildPages(keepPosition = false): void {
    const scroll = { left: viewport.scrollLeft, top: viewport.scrollTop }
    observer.disconnect()
    visible.clear()
    pagesDiv.replaceChildren()
    pages = []

    publishName()

    if (score) {
        const n = pageCount(score)
        for (let i = 0; i < n; ++i) {
            pages.push(makePage(i))
        }
        if (spreadActive()) {
            // two-sided layout: the first page is a right-hand page
            const placeholder = document.createElement('div')
            placeholder.className = 'page placeholder'
            placeholder.dataset.page = '0'
            placeholder.setAttribute('aria-hidden', 'true')
            const items = [placeholder, ...pages]
            for (let i = 0; i < items.length; i += 2) {
                const spread = document.createElement('div')
                spread.className = 'spread'
                spread.append(...items.slice(i, i + 2))
                pagesDiv.appendChild(spread)
            }
        } else {
            pagesDiv.append(...pages)
        }
        for (const el of pages) {
            observer.observe(el)
        }
    }

    updateControls()
    updatePan()
    applyZoom(computeZoom())
    for (const l of pagesBuiltListeners) {
        l()
    }
    if (keepPosition) {
        viewport.scrollTo(scroll.left, scroll.top)
        return
    }
    if (score && settings.viewMode !== 'page') {
        showPageStart()
    } else if (score) {
        centerPage(0)
    } else {
        viewport.scrollTo(0, 0)
    }
    viewport.focus({ preventScroll: true })
}

/**
 * After an editing command, undo or redo (the library has laid the score out again): new pages if their number changed,
 * new page sizes, repaint, the status bar, the modified flag; the selection (in note input: the cursor) is scrolled
 * into view.
 */
export function scoreChanged(scroll = true): void {
    clearTimeout(externalChangeTimer)
    if (!score) {
        return
    }
    // a click keeps the shadow note at the mouse position, keyboard input hides it until the mouse moves (like MuseScore)
    if (score.shadowNote().visible()) {
        updateShadowNote()
    } else {
        removeShadowNote()
    }
    if (pageCount(score) !== pages.length) {
        buildPages(true)
    } else {
        applyZoom(zoom)
    }
    publish({ modified: isModified(score), noteInput: noteInputState(score).active, scoreVersion: viewState.scoreVersion + 1 })
    selectionChanged(scroll)
    updateTextInput()
}

function pageCssSize(idx: number, z = zoom): { w: number; h: number } {
    const s = pageSize(score!, idx)
    const f = CSS_DPI * z / 100
    return { w: s.width * f, h: s.height * f }
}

/** sets the CSS size of all pages; the bitmaps are redrawn later (until then they are scaled) */
function applyZoom(z: number): void {
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
    if (score) {
        for (const el of pagesDiv.querySelectorAll<HTMLDivElement>('.page')) {
            const { w, h } = pageCssSize(Number(el.dataset.page))
            el.style.width = `${w}px`
            el.style.height = `${h}px`
        }
    }
    updateZoomSelect()
    scheduleRender(120)
}

function scheduleRender(delay: number): void {
    clearTimeout(renderTimer)
    renderTimer = window.setTimeout(renderVisible, delay)
}

// images of the score are decoded asynchronously: draw the pages again when one is available
onImageDecoded(() => {
    for (const el of pages) {
        delete el.querySelector<HTMLCanvasElement>(':scope > canvas')!.dataset.dpi
    }
    scheduleRender(0)
})

/**
 * Draws a page at the given resolution. Small enough pages are drawn completely; otherwise only the visible part
 * of the page plus a margin of half a viewport is drawn (a "tile"), so the bitmap stays small at any zoom.
 */
function renderPage(el: HTMLDivElement, cssDpi: number): void {
    const idx = Number(el.dataset.page)
    const s = pageSize(score!, idx)
    const dpr = window.devicePixelRatio
    const dpi = cssDpi * dpr
    const fullW = s.width * dpi
    const fullH = s.height * dpi
    const c = el.querySelector<HTMLCanvasElement>(':scope > canvas')!
    const d = c.dataset
    const sameDpi = d.dpi === dpi.toFixed(4)

    let region: { x: number; y: number; width: number; height: number } | undefined
    if (fullW * fullH <= MAX_CANVAS_PIXELS && fullW <= MAX_CANVAS_SIZE && fullH <= MAX_CANVAS_SIZE) {
        if (sameDpi && d.tile === '0') {
            return
        }
    } else {
        // visible part of the page in device pixels
        const pr = el.getBoundingClientRect()
        const vr = viewport.getBoundingClientRect()
        const vis = {
            l: (Math.max(pr.left, vr.left) - pr.left) * dpr,
            t: (Math.max(pr.top, vr.top) - pr.top) * dpr,
            r: (Math.min(pr.right, vr.right) - pr.left) * dpr,
            b: (Math.min(pr.bottom, vr.bottom) - pr.top) * dpr,
        }
        if (vis.r <= vis.l || vis.b <= vis.t) {
            return
        }
        if (sameDpi && d.tile === '1' && Number(d.x) <= vis.l + 1 && Number(d.y) <= vis.t + 1
            && Number(d.x) + Number(d.w) >= vis.r - 1 && Number(d.y) + Number(d.h) >= vis.b - 1) {
            return // the current tile still covers the visible part
        }
        const mx = vr.width * dpr / 2
        const my = vr.height * dpr / 2
        const x = Math.floor(Math.max(0, vis.l - mx))
        const y = Math.floor(Math.max(0, vis.t - my))
        region = {
            x,
            y,
            width: Math.ceil(Math.min(fullW, vis.r + mx)) - x,
            height: Math.ceil(Math.min(fullH, vis.b + my)) - y,
        }
    }

    const x = region?.x ?? 0
    const y = region?.y ?? 0
    const w = region?.width ?? Math.round(fullW)
    const h = region?.height ?? Math.round(fullH)
    c.width = Math.max(1, w)
    c.height = Math.max(1, h)
    // relative to the page, so a bitmap keeps its place while zooming until it is redrawn
    c.style.left = `${x / fullW * 100}%`
    c.style.top = `${y / fullH * 100}%`
    c.style.width = `${w / fullW * 100}%`
    c.style.height = `${h / fullH * 100}%`
    // like MuseScore's notation view (not printing): selection colors, the range frame, frames, invisible items grey
    drawPage(score!, idx, c.getContext('2d')!, { dpi, region, printing: false, pixelRatio: dpr })
    Object.assign(d, { dpi: dpi.toFixed(4), tile: region ? '1' : '0', x: String(x), y: String(y), w: String(w), h: String(h) })
}

function renderVisible(): void {
    if (!score) {
        return
    }
    updateContinuousPanel()
    const cssDpi = CSS_DPI * zoom / 100
    // draw one page per frame to keep the UI responsive
    const queue = [...visible].sort((a, b) => Number(a.dataset.page) - Number(b.dataset.page))
    const step = (): void => {
        const el = queue.shift()
        if (!el || !score) {
            return
        }
        if (el.isConnected) {
            renderPage(el, cssDpi)
        }
        requestAnimationFrame(step)
    }
    step()
}

// ---------------------------------------------------------------------------------
//   printing: every page as vector graphics (SVG) on a sheet of the score's page size
// ---------------------------------------------------------------------------------

const printPagesDiv = $<HTMLDivElement>('print-pages')
const pageStyle = document.createElement('style')
document.head.appendChild(pageStyle)

function preparePrint(): void {
    if (!score || printPagesDiv.childElementCount) {
        return
    }
    // like MuseScore (Score::print), the pages of the page view are printed in every view mode
    const pageView = settings.viewMode !== 'page'
    if (pageView) {
        setScoreViewMode(score, 'page')
    }
    // the paper has the page size of the score, which also gives portrait or landscape
    const size = pageSize(score, 0)
    pageStyle.textContent = `@page { size: ${size.width}in ${size.height}in; margin: 0; }`
    // glyph outlines are defined once for all pages
    const defs = new SvgGlyphDefs()
    let html = ''
    for (let i = 0; i < pageCount(score); ++i) {
        html += `<div class="print-page">${drawPageSvg(score, i, { defs })}</div>`
    }
    printPagesDiv.innerHTML = defs.svg() + html
    if (pageView) {
        applyViewMode()
    }
}

export async function print(): Promise<void> {
    if (!score) {
        return
    }
    if (!printPagesDiv.childElementCount) {
        await showBusy('Preparing pages for printing…', `${pageCount(score)} ${pageCount(score) === 1 ? 'page' : 'pages'}`)
        try {
            preparePrint()
        } finally {
            hideBusy()
        }
    }
    window.print()
}

// printing from the browser menu
window.addEventListener('beforeprint', preparePrint)
window.addEventListener('afterprint', () => {
    printPagesDiv.replaceChildren()
    pageStyle.textContent = ''
})

// ---------------------------------------------------------------------------------
//   zoom
// ---------------------------------------------------------------------------------

function computeZoom(): number {
    const mode = fitMode()
    if (!score || !mode) {
        const z = Number(settings.zoom)
        return Number.isFinite(z) && z > 0 ? z : 100
    }
    if (settings.viewMode === 'fit-width') {
        return 100 // the page is as wide as the view (at this zoom)
    }
    const gap = pageGap()
    const availW = viewport.clientWidth - 2 * gap
    const availH = viewport.clientHeight - 2 * gap
    const s = pageSize(score, 0)
    if (settings.viewMode === 'continuous-horizontal') {
        return Math.max(MIN_ZOOM, availH / (s.height * CSS_DPI) * 100)
    }
    if (settings.viewMode === 'continuous-vertical') {
        return Math.max(MIN_ZOOM, availW / (s.width * CSS_DPI) * 100)
    }
    const pagesAcross = spreadActive() ? 2 : 1
    const zw = availW / (s.width * pagesAcross * CSS_DPI) * 100
    const zh = availH / (s.height * CSS_DPI) * 100
    return Math.max(MIN_ZOOM, mode === 'page-width' ? zw : Math.min(zw, zh))
}

function updateZoomSelect(): void {
    publish({ zoom, fitMode: fitMode() })
}

/** zooms keeping the score point under (clientX, clientY) in place */
export function zoomAt(z: number, clientX?: number, clientY?: number): void {
    if (!score) {
        return
    }
    const rect = viewport.getBoundingClientRect()
    const x = clientX ?? rect.left + rect.width / 2
    const y = clientY ?? rect.top + rect.height / 2

    // anchor: the page under the point (or the nearest one) and the relative position on it
    let anchor: HTMLDivElement | null = null
    let best = Infinity
    for (const c of visible.size ? visible : pages) {
        const r = c.getBoundingClientRect()
        const dx = Math.max(r.left - x, 0, x - r.right)
        const dy = Math.max(r.top - y, 0, y - r.bottom)
        const d = dx * dx + dy * dy
        if (d < best) {
            best = d
            anchor = c
        }
    }
    const before = anchor?.getBoundingClientRect()
    const fx = before ? (x - before.left) / before.width : 0
    const fy = before ? (y - before.top) / before.height : 0

    settings.zoom = String(Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) * 100) / 100)
    saveSettings(settings)
    applyZoom(Number(settings.zoom))

    if (anchor && before) {
        const after = anchor.getBoundingClientRect()
        viewport.scrollLeft += after.left + fx * after.width - x
        viewport.scrollTop += after.top + fy * after.height - y
    }
    scheduleReflow()
}

export function zoomStep(dir: 1 | -1): void {
    const next = dir > 0 ? ZOOM_LEVELS.find(l => l > zoom + 0.5) : [...ZOOM_LEVELS].reverse().find(l => l < zoom - 0.5)
    zoomAt(next ?? (dir > 0 ? MAX_ZOOM : MIN_ZOOM))
}

export function setFitMode(mode: FitMode): void {
    const page = currentPage()
    settings.zoom = mode
    saveSettings(settings)
    applyZoom(computeZoom())
    centerPage(page)
}

new ResizeObserver(() => {
    updatePan()
    scheduleReflow()
    if (fitMode() && score) {
        // the page stays fitted and centered (e.g. entering full screen)
        const page = currentPage()
        applyZoom(computeZoom())
        centerPage(page)
    }
}).observe(viewport)

// ---------------------------------------------------------------------------------
//   layout and navigation
// ---------------------------------------------------------------------------------

function updateControls(): void {
    const horizontal = settings.orientation === 'horizontal'
    pagesDiv.className = (horizontal ? 'horizontal' : 'vertical') + (settings.viewMode !== 'page' ? ' continuous' : '')
    publish({ orientation: settings.orientation, spread: spreadActive(), spreadAvailable: !!score && isTwoSided(score) })
    updatePageInfo()
}

export function setOrientation(o: 'horizontal' | 'vertical'): void {
    const page = currentPage()
    settings.orientation = o
    saveSettings(settings)
    updateControls()
    if (fitMode()) {
        applyZoom(computeZoom())
    }
    centerPage(page)
}

export function toggleSpread(): void {
    const page = currentPage()
    settings.spread = !settings.spread
    saveSettings(settings)
    buildPages()
    centerPage(page)
}

/** index of the page nearest to the start of the viewport */
function currentPage(): number {
    if (!pages.length) {
        return 0
    }
    const r = viewport.getBoundingClientRect()
    const horizontal = settings.orientation === 'horizontal'
    let best = 0
    let bestDist = Infinity
    for (const c of pages) {
        const cr = c.getBoundingClientRect()
        // the page whose visible part is largest wins; ties go to the first one
        const visibleLen = horizontal
            ? Math.min(cr.right, r.right) - Math.max(cr.left, r.left)
            : Math.min(cr.bottom, r.bottom) - Math.max(cr.top, r.top)
        const dist = -visibleLen
        if (dist < bestDist - 1) {
            bestDist = dist
            best = Number(c.dataset.page)
        }
    }
    return best
}

export function goToPage(idx: number, behavior: ScrollBehavior = 'smooth'): void {
    if (!pages.length) {
        return
    }
    const c = pages[Math.max(0, Math.min(pages.length - 1, idx))]
    // in a spread, scroll to the spread (its left page)
    const target = c.parentElement?.classList.contains('spread') ? c.parentElement : c
    const gap = pageGap()
    const vr = viewport.getBoundingClientRect()
    const tr = target.getBoundingClientRect()
    if (settings.orientation === 'horizontal') {
        viewport.scrollTo({ left: viewport.scrollLeft + tr.left - vr.left - gap, behavior })
    } else {
        viewport.scrollTo({ top: viewport.scrollTop + tr.top - vr.top - gap, behavior })
    }
}

/** shows the page (in a spread: the spread) in the middle of the view, horizontally and vertically */
export function centerPage(idx = currentPage()): void {
    if (!pages.length) {
        return
    }
    const c = pages[Math.max(0, Math.min(pages.length - 1, idx))]
    const target = c.parentElement?.classList.contains('spread') ? c.parentElement : c
    const vr = viewport.getBoundingClientRect()
    const tr = target.getBoundingClientRect()
    const continuous = settings.viewMode !== 'page'
    if (!continuous || tr.width <= viewport.clientWidth) {
        viewport.scrollLeft += tr.left + tr.width / 2 - (vr.left + viewport.clientWidth / 2)
    }
    if (!continuous || tr.height <= viewport.clientHeight) {
        viewport.scrollTop += tr.top + tr.height / 2 - (vr.top + viewport.clientHeight / 2)
    }
}

/**
 * The "Center measure" button: centers the selection (e.g. the selected measures; the rectangles on the page of the
 * first one) or, without a selection, the first measure of the score
 */
export function centerSelectionOrFirstMeasure(): void {
    let rects = score ? selectionBounds(score) : []
    if (!rects.length) {
        const first = score ? firstMeasureBounds(score) : null
        rects = first ? [first] : []
    }
    if (!rects.length) {
        centerPage()
        return
    }
    const page = rects[0].page
    const onPage = rects.filter(r => r.page === page)
    const left = Math.min(...onPage.map(r => r.x))
    const top = Math.min(...onPage.map(r => r.y))
    const right = Math.max(...onPage.map(r => r.x + r.width))
    const bottom = Math.max(...onPage.map(r => r.y + r.height))
    const el = pages[page]
    if (!el) {
        return
    }
    const pr = el.getBoundingClientRect()
    const f = pr.width / pageSize(score!, page).width
    const vr = viewport.getBoundingClientRect()
    viewport.scrollLeft += pr.left + (left + right) / 2 * f - (vr.left + viewport.clientWidth / 2)
    viewport.scrollTop += pr.top + (top + bottom) / 2 * f - (vr.top + viewport.clientHeight / 2)
}

/** the continuous views: shows the beginning of their page (centered along an axis where it fits) */
function showPageStart(): void {
    const el = pages[0]
    if (!el) {
        return
    }
    const gap = pageGap()
    const vr = viewport.getBoundingClientRect()
    const tr = el.getBoundingClientRect()
    viewport.scrollLeft += tr.width <= viewport.clientWidth
        ? tr.left + tr.width / 2 - (vr.left + viewport.clientWidth / 2) : tr.left - vr.left - gap
    viewport.scrollTop += tr.height <= viewport.clientHeight
        ? tr.top + tr.height / 2 - (vr.top + viewport.clientHeight / 2) : tr.top - vr.top - gap
}

// ---------------------------------------------------------------------------------
//   view modes (MuseScore's status bar: NotationStatusBarModel::setCurrentViewMode, NotationPainting::setViewMode)
// ---------------------------------------------------------------------------------

/** the page width of the "fit to window" view in inches: the width of the view at the current zoom */
function fitWidthInches(): number {
    return Math.max(1, (viewport.clientWidth - 2 * pageGap()) / (CSS_DPI * zoom / 100))
}

/** lays the score out in the view mode of the settings; returns true if the layout changed */
function applyViewMode(): boolean {
    publish({ viewMode: settings.viewMode })
    if (!score) {
        return false
    }
    if (settings.viewMode === 'fit-width') {
        // the zoom of the view first (the page width follows from it)
        zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, computeZoom()))
    }
    return setScoreViewMode(score, settings.viewMode, settings.viewMode === 'fit-width' ? fitWidthInches() : 0)
}

// while the view mode changes (a new layout of the whole score, which blocks the page for a moment in large scores),
// the score is greyed out with a spinner
const viewSwitchIndicator = document.createElement('div')
viewSwitchIndicator.className = 'view-switch-indicator'
viewSwitchIndicator.setAttribute('aria-hidden', 'true')
viewSwitchIndicator.appendChild(document.createElement('div')).className = 'spinner'
let viewSwitch = 0

export function setViewMode(mode: ViewMode): void {
    if (mode === settings.viewMode) {
        return
    }
    settings.viewMode = mode
    saveSettings(settings)
    if (score && settings.viewMode === 'fit-width' && fitMode()) {
        settings.zoom = '100'
        saveSettings(settings)
    }
    publish({ viewMode: mode })
    if (!score) {
        return
    }
    const host = viewport.parentElement!
    host.classList.add('view-switching')
    host.appendChild(viewSwitchIndicator)
    viewport.inert = true
    // the indicator must be painted before the (synchronous) layout; a later switch replaces this one
    const token = ++viewSwitch
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
        if (token !== viewSwitch) {
            return
        }
        viewport.inert = false
        try {
            applyViewMode()
            buildPages()
            // the selection stays in view
            selectionChanged(true)
        } finally {
            host.classList.remove('view-switching')
            viewSwitchIndicator.remove()
        }
    })))
}

// the continuous view (horizontal): the staff names, clefs, key and time signatures at the left edge of the view
// (a box as wide as the panel, with a shadow at its right edge; the canvas in it is wider). The box is sticky at the left
// edge of the view (CSS), so it doesn't lag behind the scrolling; its contents are repainted only when they change.
const panelBox = document.createElement('div')
panelBox.className = 'continuous-panel'
panelBox.setAttribute('aria-hidden', 'true')
const panelCanvas = document.createElement('canvas')
panelBox.appendChild(panelCanvas)
let panelFrame = 0
let panelShownKey = ''
/** the width of the panel when it was shown last (css pixels) */
let s_panelWidth = 0

function scheduleContinuousPanel(): void {
    if (!panelFrame) {
        panelFrame = requestAnimationFrame(() => {
            panelFrame = 0
            updateContinuousPanel()
        })
    }
}

function hideContinuousPanel(): void {
    panelBox.remove()
    panelShownKey = ''
}

/** C++ AbstractNotationPaintView::paint: m_continuousPanel->paint() after the score, at the left edge of the view */
function updateContinuousPanel(): void {
    const el = pages[0]
    if (!score || !el || settings.viewMode !== 'continuous-horizontal') {
        hideContinuousPanel()
        return
    }
    const pr = el.getBoundingClientRect()
    const vr = viewport.getBoundingClientRect()
    const cssPerInch = pr.width / pageSize(score, 0).width
    const leftCss = Math.max(0, vr.left - pr.left)
    const topCss = Math.max(0, vr.top - pr.top)
    const widthCss = Math.ceil(viewport.clientWidth / 2)
    const dpr = window.devicePixelRatio
    const w = Math.round(widthCss * dpr)
    const h = Math.round(pr.height * dpr)
    // the canvas keeps its contents unless its size, the zoom or the score changed
    const viewKey = `${viewState.scoreVersion}|${w}x${h}|${cssPerInch.toFixed(4)}|`
    if (panelCanvas.width !== w || panelCanvas.height !== h) {
        panelCanvas.width = w
        panelCanvas.height = h
        panelShownKey = ''
    }
    const ctx = panelCanvas.getContext('2d')!
    const shownKey = panelShownKey.startsWith(viewKey) ? panelShownKey.slice(viewKey.length) : undefined
    // paints only if the contents changed (over the old ones: the panel's background covers the visible part)
    const result = drawContinuousPanel(score, ctx, { dpi: cssPerInch * dpr, left: leftCss / cssPerInch, top: topCss / cssPerInch, shownKey })
    if (!result) {
        hideContinuousPanel()
        return
    }
    panelShownKey = viewKey + result.key
    Object.assign(panelCanvas.style, { width: `${widthCss}px`, height: `${pr.height}px` })
    s_panelWidth = Math.min(widthCss, result.width * cssPerInch)
    Object.assign(panelBox.style, { width: `${s_panelWidth}px`, height: `${pr.height}px` })
    if (panelBox.parentElement !== el) {
        el.prepend(panelBox)
    }
}

let reflowTimer = 0

/** the "fit to window" view: the score is laid out again for a new width of the view or a new zoom */
function scheduleReflow(): void {
    if (!score || settings.viewMode !== 'fit-width') {
        return
    }
    clearTimeout(reflowTimer)
    reflowTimer = window.setTimeout(() => {
        const el = pages[0]
        if (!score || !el || settings.viewMode !== 'fit-width') {
            return
        }
        // the same part of the score stays at the top of the view (as far as the new layout allows)
        const vr = viewport.getBoundingClientRect()
        const before = el.getBoundingClientRect()
        const f = (vr.top - before.top) / before.height
        if (!setScoreViewMode(score, 'fit-width', fitWidthInches())) {
            return
        }
        buildPages(true)
        const after = pages[0].getBoundingClientRect()
        viewport.scrollTop += after.top + f * after.height - vr.top
        viewport.scrollLeft += after.left + after.width / 2 - (vr.left + viewport.clientWidth / 2)
        publish({ scoreVersion: viewState.scoreVersion + 1 })
    }, 150)
}

function pageGap(): number {
    return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--page-gap')) || 24
}

export function lastPage(): number {
    return pages.length - 1
}

// the pages can be moved beyond their edges (like MuseScore's canvas) until this much of them is visible
const MIN_VISIBLE = 48
let pan = { x: 0, y: 0 }

/** sets the space around the pages; the view keeps showing the same part of the pages */
function updatePan(): void {
    // without a score nothing can be moved (the drop target must stay in view)
    const next = score ? {
        x: settings.viewMode === 'fit-width' ? 0 : Math.max(0, viewport.clientWidth - MIN_VISIBLE - pageGap()),
        y: Math.max(0, viewport.clientHeight - MIN_VISIBLE - pageGap()),
    } : { x: 0, y: 0 }
    if (next.x === pan.x && next.y === pan.y) {
        return
    }
    pagesDiv.style.setProperty('--pan-x', `${next.x}px`)
    pagesDiv.style.setProperty('--pan-y', `${next.y}px`)
    viewport.scrollLeft += next.x - pan.x
    viewport.scrollTop += next.y - pan.y
    pan = next
}

export function stepPage(dir: 1 | -1): void {
    const cur = currentPage()
    if (!spreadActive()) {
        goToPage(cur + dir)
        return
    }
    // spreads: [1], [2, 3], [4, 5], ... (0-based: [0], [1, 2], [3, 4], ...)
    const spread = cur === 0 ? 0 : Math.floor((cur + 1) / 2)
    const target = Math.max(0, spread + dir)
    goToPage(target === 0 ? 0 : 2 * target - 1)
}

function updatePageInfo(): void {
    if (!score) {
        publish({ pageText: '–', canPrev: false, canNext: false })
        return
    }
    const n = pages.length
    const cur = currentPage()
    const partner = spreadActive() && cur > 0 ? (cur % 2 === 1 ? cur + 1 : cur - 1) : -1
    const shown = partner >= 0 && partner < n ? `${Math.min(cur, partner) + 1}–${Math.max(cur, partner) + 1}` : `${cur + 1}`
    publish({ pageText: `${shown} / ${n}`, canPrev: cur > 0, canNext: Math.max(cur, partner) < n - 1 })
}

viewport.addEventListener('scroll', () => {
    if (!s_programmaticScroll) {
        userMovedView()
    }
    updatePageInfo()
    // tiles of zoomed-in pages follow the view, also while it keeps moving (smooth panning while playing)
    scheduleContinuousPanel()
    if (!scrollRenderTimer) {
        scrollRenderTimer = window.setTimeout(() => {
            scrollRenderTimer = 0
            renderVisible()
        }, 60)
    }
}, { passive: true })
let scrollRenderTimer = 0

// ---------------------------------------------------------------------------------
//   wheel, pinch and the hand tool
// ---------------------------------------------------------------------------------

/** a mouse wheel notch (as opposed to trackpad scrolling, which keeps scrolling) */
function isMouseWheel(e: WheelEvent): boolean {
    if (e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
        return true
    }
    const legacy = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY
    if (legacy !== undefined && legacy !== 0 && e.deltaX === 0) {
        return Math.abs(legacy) % 120 === 0
    }
    return e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50
}

viewport.addEventListener('wheel', (e) => {
    if (!score) {
        return
    }
    if (e.ctrlKey || e.metaKey) {
        // trackpad pinch (reported as ctrl+wheel) and ctrl+wheel
        e.preventDefault()
        zoomAt(zoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY)
    } else if (!e.shiftKey && settings.viewMode === 'page' && isMouseWheel(e)) {
        // a wheel notch zooms in the page view; the continuous views are scrolled (also because fast trackpad
        // scrolling can look like wheel notches)
        e.preventDefault()
        zoomAt(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX, e.clientY)
    }
    // otherwise: native scrolling (trackpad, shift+wheel)
}, { passive: false })

// Safari trackpad pinch
let gestureStartZoom = 0
viewport.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureStartZoom = zoom })
viewport.addEventListener('gesturechange', (e) => {
    e.preventDefault()
    const ge = e as Event & { scale: number; clientX: number; clientY: number }
    zoomAt(gestureStartZoom * ge.scale, ge.clientX, ge.clientY)
})

// touch pinch (one finger pans natively)
let pinch: { dist: number; zoom: number } | null = null
const touchDist = (t: TouchList): number => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
viewport.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2 && score) {
        pinch = { dist: touchDist(e.touches), zoom }
    }
}, { passive: true })
viewport.addEventListener('touchmove', (e) => {
    if (pinch && e.touches.length === 2) {
        e.preventDefault()
        const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2
        const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2
        zoomAt(pinch.zoom * touchDist(e.touches) / pinch.dist, cx, cy)
    }
}, { passive: false })
viewport.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) {
        pinch = null
    }
})

// ---------------------------------------------------------------------------------
//   selection (MuseScore's NotationViewInputController: click, ctrl/cmd+click adds, shift+click extends)
// ---------------------------------------------------------------------------------

/** redraws the pages after a selection change (no new layout) and updates the status bar */
export function selectionChanged(scrollIntoView = false): void {
    if (!score) {
        return
    }
    for (const el of pages) {
        delete el.querySelector<HTMLCanvasElement>(':scope > canvas')!.dataset.dpi
    }
    scheduleRender(0)
    publish({ selection: hasSelection(score) ? selectionInfo(score) : '', selectionVersion: viewState.selectionVersion + 1 })
    if (scrollIntoView) {
        const b = noteInputCursorBounds(score) ?? selectionBounds(score)[0]
        const el = b ? pages[b.page] : null
        if (el && b) {
            const pr = el.getBoundingClientRect()
            const vr = viewport.getBoundingClientRect()
            const f = pr.width / pageSize(score, b.page).width
            const x = pr.left + b.x * f
            const y = pr.top + b.y * f
            const m = 24
            viewport.scrollBy({
                left: x < vr.left + m ? x - vr.left - m : x + b.width * f > vr.right - m ? x + b.width * f - vr.right + m : 0,
                top: y < vr.top + m ? y - vr.top - m : y + b.height * f > vr.bottom - m ? y + b.height * f - vr.bottom + m : 0,
            })
        }
    }
}


export function selectAllElements(): void {
    if (score) {
        selectAll(score)
        selectionChanged()
    }
}

export function deselect(): boolean {
    if (score && clearSelection(score)) {
        selectionChanged()
        return true
    }
    return false
}

// ---------------------------------------------------------------------------------
//   mouse: MuseScore's NotationViewInputController (click selection, drag of elements and grips, Shift+drag on
//   empty space: lasso, double click: text editing, triple click: select the text)
// ---------------------------------------------------------------------------------

/** the page under the pointer, or the nearest one, and the point on it (inches; may be outside of the page) */
function pagePointAt(clientX: number, clientY: number): { page: number; x: number; y: number; dpi: number } | null {
    if (!score || !pages.length) {
        return null
    }
    let best: HTMLDivElement | null = null
    let bestDist = Infinity
    for (const el of visible.size ? visible : pages) {
        if (!el.isConnected) {
            continue
        }
        const r = el.getBoundingClientRect()
        const dx = Math.max(r.left - clientX, 0, clientX - r.right)
        const dy = Math.max(r.top - clientY, 0, clientY - r.bottom)
        const d = dx * dx + dy * dy
        if (d < bestDist) {
            bestDist = d
            best = el
        }
    }
    if (!best) {
        return null
    }
    const idx = Number(best.dataset.page)
    const r = best.getBoundingClientRect()
    const cssDpi = r.width / pageSize(score, idx).width
    return { page: idx, x: (clientX - r.left) / cssDpi, y: (clientY - r.top) / cssDpi, dpi: cssDpi }
}

const isMacPlatform = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

function pointerEvent(e: MouseEvent): ViewPointerEvent | null {
    const pt = pagePointAt(e.clientX, e.clientY)
    if (!pt) {
        return null
    }
    return {
        ...pt, clientX: e.clientX, clientY: e.clientY, button: e.button, buttons: e.buttons,
        shift: e.shiftKey, ctrl: isMacPlatform ? e.metaKey : e.ctrlKey, alt: e.altKey,
    }
}

let mouse: { id: number; lastX: number; lastY: number } | null = null
let tripleClickTimer = 0

viewport.addEventListener('pointerdown', (e) => {
    if (!score || spaceDown || (e.button !== 0 && e.button !== 2)) {
        return
    }
    if (e.button === 2 && noteInputState(score).active) {
        return // the right click removes a note (contextmenu)
    }
    const ev = pointerEvent(e)
    if (!ev) {
        return
    }
    mouse = { id: e.pointerId, lastX: e.clientX, lastY: e.clientY }
    viewport.setPointerCapture(e.pointerId)
    const noteInput = noteInputState(score).active
    viewMousePress(score, ev)
    // in note input mode a click puts a note (a new layout)
    afterViewInput(noteInput)
})

viewport.addEventListener('pointermove', (e) => {
    if (!score || !mouse || mouse.id !== e.pointerId) {
        return
    }
    const ev = pointerEvent(e)
    if (!ev) {
        return
    }
    const r = viewMouseMove(score, ev)
    if (r.outgoingDrag) {
        startOutgoingDrag(r.outgoingDrag)
    }
    if (outgoing) {
        moveOutgoingDrag(e)
    } else if (r.moveCanvas) {
        // move the canvas with the pointer (like the hand tool)
        viewport.scrollLeft -= e.clientX - mouse.lastX
        viewport.scrollTop -= e.clientY - mouse.lastY
    } else if (isDragging(score) || textEditingInfo(score).active) {
        afterViewInput(false, false)
    }
    mouse.lastX = e.clientX
    mouse.lastY = e.clientY
})

const releasePointer = (e: PointerEvent): void => {
    if (!score || !mouse || mouse.id !== e.pointerId) {
        return
    }
    mouse = null
    endOutgoingDrag(e.type === 'pointerup' ? e : null)
    const ev = pointerEvent(e)
    if (ev) {
        viewMouseRelease(score, { ...ev, buttons: e.buttons })
    }
    afterViewInput(true)
}
viewport.addEventListener('pointerup', releasePointer)
viewport.addEventListener('pointercancel', releasePointer)

viewport.addEventListener('dblclick', (e) => {
    if (!score || spaceDown) {
        return
    }
    const ev = pointerEvent(e)
    if (!ev) {
        return
    }
    viewMouseDoubleClick(score, ev)
    clearTimeout(tripleClickTimer)
    const s = score
    tripleClickTimer = window.setTimeout(() => viewResetTripleClick(s), 500) // QApplication::doubleClickInterval()
    afterViewInput(true)
})

// the browser's context menu is replaced by the score's context menu (below; in note input mode a right click removes
// a note)
viewport.addEventListener('contextmenu', (e) => {
    if (score && !noteInputState(score).active) {
        e.preventDefault()
    }
})

/** after a view event: repaint (with a new layout if the score changed), the status bar, the text input */
function afterViewInput(layoutChanged: boolean, scroll = false): void {
    if (!score) {
        return
    }
    // a click in note input mode puts a note, drags change the layout inside an open command: always a new paint
    void layoutChanged
    scoreChanged(scroll)
}

// ---------------------------------------------------------------------------------
//   drag and drop of palette cells onto the score (NotationViewInputController dragEnterEvent, dragMoveEvent,
//   dragLeaveEvent, dropEvent): the drop target is highlighted by the library's paint (drawPage)
// ---------------------------------------------------------------------------------

/** repaints the pages without a new layout (drag feedback) */
let repaintFrame = 0
function repaintPages(): void {
    if (repaintFrame) {
        return
    }
    repaintFrame = requestAnimationFrame(() => {
        repaintFrame = 0
        for (const el of pages) {
            delete el.querySelector<HTMLCanvasElement>(':scope > canvas')!.dataset.dpi
        }
        renderVisible()
    })
}

// the preferences of the note input section (NotationConfiguration); the cursor is repainted when it changes
function applyNoteInputSettings(): void {
    const s = appSettings().noteInput
    NotationConfiguration.setDefaultNoteInputMethod(s.defaultMethod === 'note-input-by-duration' ? NoteEntryMethod.BY_DURATION : NoteEntryMethod.BY_NOTE_NAME)
    NotationConfiguration.setAddAccidentalDotsArticulationsToNextNoteEntered(s.addAccidentalDotsArticulationsToNextNoteEntered)
    if (s.useNoteInputCursorInInputByDuration !== NotationConfiguration.useNoteInputCursorInInputByDuration()) {
        NotationConfiguration.setUseNoteInputCursorInInputByDuration(s.useNoteInputCursorInInputByDuration)
        repaintPages()
    }
}
applyNoteInputSettings()
onSettingsChanged(applyNoteInputSettings)

let dropActive = false

function dragEvent(e: DragEvent): ViewDragEvent | null {
    const pt = pagePointAt(e.clientX, e.clientY)
    return pt ? { page: pt.page, x: pt.x, y: pt.y, shift: e.shiftKey, ctrl: isMacPlatform ? e.metaKey : e.ctrlKey, alt: e.altKey } : null
}

function startDrop(): boolean {
    if (!score || dropActive || isBusy()) {
        return dropActive
    }
    const d = dragData()
    if (!d?.symbol) {
        return false
    }
    dropActive = viewDragEnter(score, d.symbol)
    return dropActive
}

function stopDrop(): void {
    if (dropActive && score) {
        viewDragLeave(score)
        repaintPages()
    }
    dropActive = false
}

viewport.addEventListener('dragenter', () => {
    startDrop()
})

viewport.addEventListener('dragover', (e) => {
    if (!score || !startDrop()) {
        return
    }
    const ev = dragEvent(e)
    const accepted = !!ev && viewDragMove(score, ev)
    e.preventDefault()
    if (e.dataTransfer) {
        e.dataTransfer.dropEffect = accepted ? 'copy' : 'none'
    }
    repaintPages()
})

viewport.addEventListener('dragleave', (e) => {
    if (dropActive && !viewport.contains(e.relatedTarget as Node | null)) {
        stopDrop()
    }
})

viewport.addEventListener('drop', (e) => {
    if (!score || !dropActive) {
        return
    }
    e.preventDefault()
    e.stopPropagation()
    const ev = dragEvent(e)
    dropActive = false
    const symbol = dragData()?.symbol ?? ''
    setDragData(null)
    if (ev && isInstrumentChangeSymbol(symbol)) {
        // the instrument is chosen first (NotationInteraction::selectInstrument), then the drop is done again
        viewDragLeave(score)
        repaintPages()
        const target = score
        void withSelectedInstrument(() => {
            if (score === target && viewDragEnter(target, symbol)) {
                viewDragMove(target, ev)
                if (viewDrop(target, ev)) {
                    scoreChanged(false)
                }
            }
        })
        return
    }
    if (ev && viewDrop(score, ev)) {
        scoreChanged(false)
    } else {
        repaintPages()
    }
    viewport.focus({ preventScroll: true })
})

// a drag that ends elsewhere (Escape, a drop outside of the view)
document.addEventListener('dragend', () => {
    stopDrop()
    setDragData(null)
})

// ---------------------------------------------------------------------------------
//   an element dragged out of the score (Shift+Ctrl+drag: NotationInteraction::startOutgoingDragElement, MuseScore's
//   QDrag): dropped onto the score it is copied there (the view's dropEvent, like a palette cell), dropped onto a
//   palette it is added to it. The pointer stays captured by the view; the element under it at the end gets
//   ELEMENT_DROP_EVENT.
// ---------------------------------------------------------------------------------

let outgoing: { drag: OutgoingElementDrag; ghost: HTMLElement; over: Element | null; overScore: boolean } | null = null

function startOutgoingDrag(drag: OutgoingElementDrag): void {
    const ghost = document.createElement('div')
    ghost.className = 'outgoing-drag-ghost'
    ghost.textContent = drag.name
    document.body.appendChild(ghost)
    outgoing = { drag, ghost, over: null, overScore: false }
}

function outgoingDragEvent(e: PointerEvent): ViewDragEvent | null {
    const target = document.elementFromPoint(e.clientX, e.clientY)
    if (!target || !viewport.contains(target)) {
        return null
    }
    const pt = pagePointAt(e.clientX, e.clientY)
    return pt ? { page: pt.page, x: pt.x, y: pt.y, shift: e.shiftKey, ctrl: isMacPlatform ? e.metaKey : e.ctrlKey, alt: e.altKey } : null
}

function moveOutgoingDrag(e: PointerEvent): void {
    if (!outgoing || !score) {
        return
    }
    outgoing.ghost.style.left = `${e.clientX + 12}px`
    outgoing.ghost.style.top = `${e.clientY + 12}px`
    const grid = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-palette-grid]') ?? null
    if (grid !== outgoing.over) {
        outgoing.over?.classList.remove('drop-active')
        grid?.classList.add('drop-active')
        outgoing.over = grid
    }
    // over the score: the drop target is highlighted (NotationViewInputController::dragMoveEvent)
    const ev = outgoingDragEvent(e)
    if (ev) {
        if (!outgoing.overScore) {
            outgoing.overScore = viewDragEnter(score, outgoing.drag.mimeData)
        }
        if (outgoing.overScore) {
            viewDragMove(score, ev)
            repaintPages()
        }
    } else if (outgoing.overScore) {
        outgoing.overScore = false
        viewDragLeave(score)
        repaintPages()
    }
}

function endOutgoingDrag(e: PointerEvent | null): void {
    if (!outgoing) {
        return
    }
    const { drag, ghost, over, overScore } = outgoing
    outgoing = null
    ghost.remove()
    over?.classList.remove('drop-active')
    if (overScore && score) {
        const ev = e ? outgoingDragEvent(e) : null
        if (ev && viewDrop(score, ev)) {
            scoreChanged(false)
        } else {
            viewDragLeave(score)
            repaintPages()
        }
        return
    }
    const target = e ? document.elementFromPoint(e.clientX, e.clientY) : null
    if (e && target && !viewport.contains(target)) {
        const detail: ElementDropDetail = { mimeData: drag.mimeData, clientX: e.clientX, clientY: e.clientY }
        target.dispatchEvent(new CustomEvent(ELEMENT_DROP_EVENT, { bubbles: true, detail }))
    }
}

// ---------------------------------------------------------------------------------
//   text editing: keyboard input through a hidden text field at the text cursor (IME and dead keys work), the
//   cursor and the selection are painted by the library (MuseScore's EditModeRenderer)
// ---------------------------------------------------------------------------------

const textInput = document.createElement('textarea')
textInput.className = 'notation-text-input'
textInput.dataset.notationInput = ''
textInput.setAttribute('aria-label', 'Text')
textInput.setAttribute('autocomplete', 'off')
textInput.setAttribute('autocapitalize', 'off')
textInput.spellcheck = false
document.body.appendChild(textInput)

/** a DOM key event as the library's key event (Qt's Ctrl is Command on macOS) */
function viewKey(e: KeyboardEvent): ViewKeyEvent {
    return {
        key: e.key, code: e.code, shift: e.shiftKey, alt: e.altKey,
        ctrl: isMacPlatform ? e.metaKey : e.ctrlKey, meta: isMacPlatform ? e.ctrlKey : e.metaKey,
    }
}

/** the text field follows the text cursor and has the focus while a text is edited */
function updateTextInput(): void {
    const info = score ? textEditingInfo(score) : null
    if (!info || !info.active || !info.cursor) {
        textInput.classList.remove('active')
        textInput.style.left = '-1000px'
        if (document.activeElement === textInput) {
            viewport.focus({ preventScroll: true })
        }
        return
    }
    const el = pages[info.cursor.page]
    if (el) {
        const pr = el.getBoundingClientRect()
        const f = pr.width / pageSize(score!, info.cursor.page).width
        textInput.style.left = `${pr.left + info.cursor.x * f}px`
        textInput.style.top = `${pr.top + info.cursor.y * f}px`
        textInput.style.height = `${Math.max(8, info.cursor.height * f)}px`
        textInput.style.fontSize = `${Math.max(8, info.cursor.height * f * 0.8)}px`
    }
    textInput.classList.add('active')
    if (document.activeElement !== textInput) {
        textInput.focus({ preventScroll: true })
    }
}

textInput.addEventListener('keydown', (e) => {
    if (!score || e.isComposing || e.keyCode === 229) {
        return // the input method composes
    }
    const k = viewKey(e)
    if (viewShortcutOverride(score, k)) {
        e.preventDefault()
        e.stopPropagation()
        viewKeyPress(score, k)
        scoreChanged(false)
    }
    // otherwise the key is a shortcut (actions.ts: lyrics navigation, Escape, Ctrl+B, ...)
})

textInput.addEventListener('compositionupdate', (e) => {
    if (score) {
        viewInputText(score, '', e.data)
        scoreChanged(false)
    }
})

textInput.addEventListener('compositionend', (e) => {
    if (score) {
        viewInputText(score, e.data)
        textInput.value = ''
        scoreChanged(false)
    }
})

textInput.addEventListener('input', (e) => {
    const ie = e as InputEvent
    if (score && !ie.isComposing && ie.inputType === 'insertText' && ie.data) {
        // characters that came without a usable keydown (e.g. on-screen keyboards)
        viewInputText(score, ie.data)
        scoreChanged(false)
    }
    if (!ie.isComposing) {
        textInput.value = ''
    }
})

// the global shortcuts (actions.ts) leave the keys the edited element takes (MuseScore's shortcutOverrideEvent)
setShortcutOverride((e) => {
    if (!score || document.body.dataset.view !== 'score' || e.isComposing) {
        return false
    }
    const t = e.target as Element | null
    if (t !== textInput && t !== viewport && t !== document.body) {
        return false
    }
    return viewShortcutOverride(score, viewKey(e))
})

// ---------------------------------------------------------------------------------
//   clipboard: MuseScore's clipboard formats through the copy/cut/paste events (custom mime types in the
//   DataTransfer); the library's in-memory clipboard is the fallback (and serves the Edit menu's Paste)
// ---------------------------------------------------------------------------------

function clipboardTarget(e: ClipboardEvent): boolean {
    const t = e.target as Element | null
    return !!score && document.body.dataset.view === 'score' && (t === textInput || t === viewport || t === document.body || !!t?.closest?.('#viewport'))
}

function writeClipboard(e: ClipboardEvent): void {
    const data = clipboardContents()
    if (!e.clipboardData || !Object.keys(data).length) {
        return
    }
    for (const [format, text] of Object.entries(data)) {
        try {
            e.clipboardData.setData(format, text)
        } catch {
            // a browser that does not accept the custom type: the in-memory clipboard keeps it
        }
    }
    e.preventDefault()
}

document.addEventListener('copy', (e) => {
    if (clipboardTarget(e) && executeAction(score!, 'action://notation/copy')) {
        writeClipboard(e)
    }
})

document.addEventListener('cut', (e) => {
    if (clipboardTarget(e) && isActionEnabled(score!, 'action://notation/cut')) {
        executeAction(score!, 'action://notation/copy')
        writeClipboard(e)
        executeAction(score!, 'action://notation/delete')
        scoreChanged()
    }
})

document.addEventListener('paste', (e) => {
    if (!clipboardTarget(e)) {
        return
    }
    e.preventDefault()
    const dt = e.clipboardData
    if (dt) {
        const data: Record<string, string> = {}
        for (const format of [...CLIPBOARD_FORMATS, 'text/plain']) {
            const d = dt.getData(format)
            if (d) {
                data[format] = d
            }
        }
        const hasMuseScoreData = CLIPBOARD_FORMATS.some(f => f in data)
        const imageFile = hasMuseScoreData ? null : [...dt.files].find(f => f.type.startsWith('image/') && f.type !== 'image/svg+xml')
        if (imageFile) {
            // an image (Score::cmdPaste with QMimeData::hasImage): read the file, then paste
            imageFile.arrayBuffer().then((buf) => {
                if (!score) {
                    return
                }
                setClipboardImage(new Uint8Array(buf))
                if (executeAction(score, 'action://notation/paste')) {
                    scoreChanged()
                }
            }).catch(() => {})
            return
        }
        const current = clipboardContents()
        // the system clipboard has something else than what was copied here: paste that
        if (hasMuseScoreData || (data['text/plain'] !== undefined && data['text/plain'] !== current['text/plain'])) {
            setClipboardContents(data)
        }
    }
    if (executeAction(score!, 'action://notation/paste')) {
        scoreChanged()
    }
})

// ---------------------------------------------------------------------------------
//   note input: the shadow note at the mouse position, right click removes a note
//   (MuseScore's NotationViewInputController::hoverMoveEvent / handleClickInNoteInputMode)
// ---------------------------------------------------------------------------------

const shadowCanvas = document.createElement('canvas')
shadowCanvas.className = 'shadow-note'
shadowCanvas.setAttribute('aria-hidden', 'true')
let hover: { el: HTMLDivElement; x: number; y: number } | null = null
let hoverFrame = 0

function removeShadowNote(): void {
    shadowCanvas.remove()
}

/** shows the shadow note at the last mouse position (in note input mode) */
function updateShadowNote(): void {
    if (!score || !hover || !hover.el.isConnected || !noteInputState(score).active) {
        if (score && shadowCanvas.isConnected) {
            hideShadowNote(score)
        }
        removeShadowNote()
        return
    }
    const el = hover.el
    const idx = Number(el.dataset.page)
    const r = el.getBoundingClientRect()
    const cssDpi = r.width / pageSize(score, idx).width
    const b = showShadowNote(score, idx, (hover.x - r.left) / cssDpi, (hover.y - r.top) / cssDpi)
    if (!b) {
        removeShadowNote()
        return
    }
    const dpr = window.devicePixelRatio
    const dpi = cssDpi * dpr
    const x = Math.floor(b.x * dpi) - 2
    const y = Math.floor(b.y * dpi) - 2
    const region = { x, y, width: Math.ceil((b.x + b.width) * dpi) + 2 - x, height: Math.ceil((b.y + b.height) * dpi) + 2 - y }
    shadowCanvas.width = Math.max(1, region.width)
    shadowCanvas.height = Math.max(1, region.height)
    Object.assign(shadowCanvas.style, {
        left: `${x / dpr}px`, top: `${y / dpr}px`, width: `${region.width / dpr}px`, height: `${region.height / dpr}px`,
    })
    const ctx = shadowCanvas.getContext('2d')!
    ctx.clearRect(0, 0, shadowCanvas.width, shadowCanvas.height)
    drawShadowNote(score, idx, ctx, { dpi, region })
    if (shadowCanvas.parentElement !== el) {
        el.appendChild(shadowCanvas)
    }
}

viewport.addEventListener('pointermove', (e) => {
    if (!score || e.pointerType === 'touch' || !noteInputState(score).active) {
        if (shadowCanvas.isConnected) {
            hover = null
            updateShadowNote()
        }
        return
    }
    const el = (e.target as Element).closest<HTMLDivElement>('.page:not(.placeholder)')
    hover = el ? { el, x: e.clientX, y: e.clientY } : null
    if (!hoverFrame) {
        hoverFrame = requestAnimationFrame(() => {
            hoverFrame = 0
            updateShadowNote()
        })
    }
})

viewport.addEventListener('pointerleave', () => {
    hover = null
    updateShadowNote()
})

viewport.addEventListener('contextmenu', (e) => {
    if (!score) {
        return
    }
    if (!noteInputState(score).active) {
        // NotationView: the context menu of the right-clicked element (the press set the hit element context)
        if (pagePointAt(e.clientX, e.clientY)) {
            e.preventDefault()
            showScoreContextMenu(score, e.clientX, e.clientY)
        }
        return
    }
    e.preventDefault()
    const el = (e.target as Element).closest<HTMLDivElement>('.page:not(.placeholder)')
    if (!el) {
        return
    }
    const idx = Number(el.dataset.page)
    const r = el.getBoundingClientRect()
    const cssDpi = r.width / pageSize(score, idx).width
    if (rightClickAt(score, idx, (e.clientX - r.left) / cssDpi, (e.clientY - r.top) / cssDpi)) {
        scoreChanged()
    }
})

// hand tool: the middle mouse button drags the view; with the setting "Hold Space and drag to move the score"
// (web.spacePan) also Space + the left button (then Shift+Space plays and Escape stops, see actions.ts), otherwise Space plays
// like in MuseScore (the "play" action)
let spaceDown = false
let drag: { x: number; y: number; left: number; top: number; id: number } | null = null

function setHand(on: boolean): void {
    viewport.classList.toggle('hand', on || !!drag)
}

viewport.addEventListener('pointerdown', (e) => {
    if (!score || !(spaceDown && e.button === 0) && e.button !== 1) {
        return
    }
    e.preventDefault()
    drag = { x: e.clientX, y: e.clientY, left: viewport.scrollLeft, top: viewport.scrollTop, id: e.pointerId }
    viewport.setPointerCapture(e.pointerId)
    viewport.classList.add('hand', 'dragging')
})
viewport.addEventListener('pointermove', (e) => {
    if (drag && e.pointerId === drag.id) {
        viewport.scrollLeft = drag.left - (e.clientX - drag.x)
        viewport.scrollTop = drag.top - (e.clientY - drag.y)
    }
})
const endDrag = (e: PointerEvent): void => {
    if (drag && e.pointerId === drag.id) {
        drag = null
        viewport.classList.remove('dragging')
        setHand(spaceDown)
    }
}
const releaseSpace = (): void => {
    if (spaceDown) {
        spaceDown = false
        setHand(false)
    }
}
document.addEventListener('keyup', (e) => {
    if (e.key === ' ') {
        releaseSpace()
    }
    if (e.key === 'Shift' && score && e.target === viewport) {
        viewKeyRelease(score, viewKey(e))
        scoreChanged(false)
    }
})
window.addEventListener('blur', releaseSpace)
viewport.addEventListener('pointerup', endDrag)
viewport.addEventListener('pointercancel', endDrag)

// ---------------------------------------------------------------------------------
//   keyboard shortcuts
// ---------------------------------------------------------------------------------

function isTextInput(t: EventTarget | null): boolean {
    return t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement
}

// in full screen the app's chrome is collapsed: the menu bar and toolbars at the top, the bottom toolbar dock and the
// status bar at the bottom, the panels at the left (right to left: right) edge; each part is shown while the pointer is
// at its edge or on it, or while it has the keyboard focus
type Edge = 'top' | 'bottom' | 'side'

const EDGE_CLASS: Record<Edge, string> = { top: 'toolbar-shown', bottom: 'bottom-shown', side: 'panels-shown' }
const edges: Record<Edge, { el: HTMLElement | null; timer: number }> = {
    top: { el: null, timer: 0 },
    bottom: { el: null, timer: 0 },
    side: { el: null, timer: 0 },
}
const EDGES = Object.keys(edges) as Edge[]

const isFullscreen = (): boolean => document.body.classList.contains('fullscreen')
const isShown = (edge: Edge): boolean => document.body.classList.contains(EDGE_CLASS[edge])

function showEdge(edge: Edge, autoHideMs = 0): void {
    clearTimeout(edges[edge].timer)
    document.body.classList.add(EDGE_CLASS[edge])
    if (autoHideMs) {
        edges[edge].timer = window.setTimeout(() => hideEdge(edge), autoHideMs)
    }
}

function hideEdge(edge: Edge): void {
    clearTimeout(edges[edge].timer)
    const el = edges[edge].el
    if (el && (el.matches(':hover') || el.matches(':has(:focus-visible)') || el.matches(':has([aria-haspopup][aria-expanded="true"])'))) {
        return // pointer on it, keyboard navigation or an open menu/popup in it (not an expanded section)
    }
    document.body.classList.remove(EDGE_CLASS[edge])
}

document.addEventListener('fullscreenchange', () => {
    const fs = !!document.fullscreenElement
    document.body.classList.toggle('fullscreen', fs)
    publish({ fullscreen: fs })
    for (const edge of EDGES) {
        if (fs) {
            // briefly, so it is clear where it went
            showEdge(edge, 1200)
        } else {
            clearTimeout(edges[edge].timer)
            document.body.classList.remove(EDGE_CLASS[edge])
        }
    }
})

/** the elements that are collapsed in full screen (set by the React app): the chrome at the top, the bottom bars, the panels */
export function setChrome(el: HTMLElement, edge: Edge = 'top'): void {
    edges[edge].el = el
    el.addEventListener('pointerenter', () => clearTimeout(edges[edge].timer))
    el.addEventListener('focusin', () => {
        if (isFullscreen()) {
            showEdge(edge)
        }
    })
    el.addEventListener('focusout', () => {
        if (isFullscreen() && !el.matches(':hover')) {
            edges[edge].timer = window.setTimeout(() => hideEdge(edge), 300)
        }
    })
}

for (const [edge, id] of [['top', 'toolbar-trigger'], ['bottom', 'bottom-trigger'], ['side', 'side-trigger']] as const) {
    $(id).addEventListener('pointerenter', () => showEdge(edge))
    $(id).addEventListener('pointerdown', () => showEdge(edge, 3000)) // touch: tap at the edge
}

/** how far the pointer is away from a shown part, towards the score (negative: on it) */
function distanceFromEdge(edge: Edge, r: DOMRect, x: number, y: number): number {
    switch (edge) {
    case 'top': return y - r.bottom
    case 'bottom': return r.top - y
    case 'side': return document.documentElement.dir === 'rtl' ? r.left - x : x - r.right
    }
}

// hidden when the pointer is clearly away from it (not on leaving it: an open menu or list is outside of it)
document.addEventListener('pointermove', (e) => {
    if (!isFullscreen()) {
        return
    }
    for (const edge of EDGES) {
        const el = edges[edge].el
        if (!el || !isShown(edge)) {
            continue
        }
        const d = distanceFromEdge(edge, el.getBoundingClientRect(), e.clientX, e.clientY)
        if (d > 24) {
            clearTimeout(edges[edge].timer)
            edges[edge].timer = window.setTimeout(() => hideEdge(edge), 300)
        } else if (d <= 0) {
            clearTimeout(edges[edge].timer)
        }
    }
})

export function toggleFullscreen(): void {
    if (document.fullscreenElement) {
        void document.exitFullscreen()
    } else {
        void document.documentElement.requestFullscreen?.()
    }
}

document.addEventListener('keydown', (e) => {
    if (isBusy()) {
        e.preventDefault()
        return
    }
    // modal dialogs and the panels keep their keys
    if (document.querySelector('dialog[open]') || (e.target instanceof Element && e.target.closest('.panel-dock'))) {
        return
    }
    const mod = e.ctrlKey || e.metaKey
    const key = e.key
    // the commands of the menus and toolbars are actions (actions/actions.ts) with MuseScore's shortcuts;
    // here only the keys of the view itself
    if (!score || document.body.dataset.view !== 'score') {
        return
    }

    if (key === ' ' && appSettings().web.spacePan && !mod && !e.altKey && !e.shiftKey && !isTextInput(e.target)
        && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault() // no scrolling
        if (!spaceDown) {
            spaceDown = true
            setHand(true)
        }
        return
    }

    if (e.target === viewport && viewShortcutOverride(score, viewKey(e))) {
        // the selected or edited element takes the key (MuseScore's shortcutOverrideEvent / keyPressEvent)
        e.preventDefault()
        viewKeyPress(score, viewKey(e))
        scoreChanged(false)
        return
    }
    if (e.target === viewport && key === 'Shift' && !e.repeat) {
        // C++ keyPressEvent: Shift shows the time tick anchors of the selected element (Shift+Left/Right moves it)
        viewKeyPress(score, viewKey(e))
        scoreChanged(false)
        return
    }

    let handled = true
    if (isTextInput(e.target) || e.target instanceof HTMLButtonElement) {
        handled = false
    } else if (key === 'PageDown') {
        stepPage(1)
    } else if (key === 'PageUp') {
        stepPage(-1)
    } else if (key.startsWith('Arrow') || ((key === 'Home' || key === 'End') && (e.shiftKey || mod))) {
        // MuseScore's selection navigation; without a selection the arrows scroll
        const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
        if (moveSelection(score, key, { shift: e.shiftKey, ctrl: isMac ? e.metaKey : e.ctrlKey, alt: e.altKey })) {
            selectionChanged(true)
        } else if (!mod && document.activeElement !== viewport && key.startsWith('Arrow')) {
            const d = 60
            viewport.scrollBy({
                left: key === 'ArrowLeft' ? -d : key === 'ArrowRight' ? d : 0,
                top: key === 'ArrowUp' ? -d : key === 'ArrowDown' ? d : 0,
            })
        } else {
            handled = document.activeElement !== viewport
        }
    } else if (key === 'Escape') {
        handled = deselect()
    } else {
        handled = false
    }
    if (handled) {
        e.preventDefault()
    }
})


// ---------------------------------------------------------------------------------
//   help, drag and drop
// ---------------------------------------------------------------------------------

export function showShortcutsHelp(): void {
    helpDialog.showModal()
}

helpDialog.addEventListener('close', () => viewport.focus({ preventScroll: true }))

// a file can be dropped anywhere (also on the home screen)
// dragenter/dragleave do not pair up reliably (text nodes, Safari, drags cancelled outside the window), so the
// highlight lasts as long as dragover keeps firing (every ~50 ms while a drag is over the page)
/** the drop highlight covers the box of the given element (body::after is fixed: it must not scroll with the score) */
function setDropArea(area: Element): void {
    const r = area.getBoundingClientRect()
    const style = document.body.style
    style.setProperty('--drop-left', `${r.left}px`)
    style.setProperty('--drop-top', `${r.top}px`)
    style.setProperty('--drop-width', `${r.width}px`)
    style.setProperty('--drop-height', `${r.height}px`)
}
let dragTimer = 0
function endDragOver(): void {
    clearTimeout(dragTimer)
    document.body.classList.remove('dragover')
}
document.addEventListener('dragover', (e) => {
    e.preventDefault()
    if (e.dataTransfer?.types.includes('Files')) {
        if (!document.body.classList.contains('dragover')) {
            // the home screen or the score
            const area = [...document.querySelectorAll('.home, .viewport-host')].find(el => el.getClientRects().length)
            setDropArea(area ?? document.body)
            document.body.classList.add('dragover')
        }
        clearTimeout(dragTimer)
        dragTimer = window.setTimeout(endDragOver, 200)
    }
})
document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) {
        endDragOver() // left the window
    }
})
document.addEventListener('drop', (e) => {
    e.preventDefault()
    endDragOver()
    const f = e.dataTransfer?.files[0]
    if (f && !isBusy() && !document.querySelector('dialog[open]')) {
        handlers.openFile(f)
    }
})

updateControls()
