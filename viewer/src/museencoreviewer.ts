/*
 * SPDX-License-Identifier: GPL-3.0-only
 * The MuseEncore Viewer component: shows a .mscz/.mscx file (or a MusicXML, MIDI, Capella or Guitar Pro file, imported
 * like MuseScore's File > Open) in an element of a web page (in a shadow root), with the page view (pages side by side,
 * vertically or as two-page spreads) and MuseScore's continuous views, zoom, printing, full screen and the playback. The MuseEncore Viewer app (viewer/main.ts) and the npm package (applyMuseEncoreViewer,
 * index.ts) use it. Keyboard shortcuts follow MuseScore Studio (src/app/configs/data/shortcuts.xml) where they make
 * sense for a viewer.
 */
/// <reference types="vite/client" />
import {
    centerTargetBounds, NONE_DEVICE_ID, playalongMeasureBounds, drawContinuousPanel, drawPage, drawPageSvg, initEngravingFonts, isTwoSided, layoutScore, onImageDecoded, openFileAccept, openScoreFile, scoreBaseName, pageCount,
    pageSize, playbackCursorBounds, scoreTitle, setViewMode as setScoreViewMode, SvgGlyphDefs, withPageView, type MasterScore,
} from '../../src/index'
import { centerViewOnMeasureOrPage } from '../../shared/centerview'
import { CENTER_ICON } from '../../shared/icons'
import { SOUNDFONT_CDN_URL } from '../../shared/playback/soundfont'
import { ViewerMidiInput, type ViewerMidiSettings } from './midiinput'
import { ViewerPlayalong, type ViewerPlayalongState } from './playalong'
import { ViewerPlayback, type ViewerPlaybackState } from './playback'
import type {
    ContinuousView, MuseEncoreScoreInfo, MuseEncoreScoreSource, MuseEncoreViewer as IMuseEncoreViewer, MuseEncoreViewerOptions,
    MuseEncoreViewerToolbarGroups, MuseEncoreViewSettings,
} from './types'
import css from './viewer.css?inline'
import logoSvg from '../../logo/muse-encore-logo.svg?raw'
import { version as VIEWER_VERSION } from '../../packages/viewer/package.json'

type ViewerViewMode = MuseEncoreViewSettings['viewMode']

/** a rectangle of a page in inches */
interface PageRect {
    x: number
    y: number
    width: number
    height: number
}

/** the options of the viewer app (not part of the package's API) */
export interface MuseEncoreViewerAppOptions extends MuseEncoreViewerOptions {
    /** the view settings to start with (they override zoom, continuousView, pageOrientation and twoPages) */
    viewSettings?: MuseEncoreViewSettings
    onViewSettingsChange?: (settings: MuseEncoreViewSettings) => void
    /** a file was opened by the user (file dialog, drop) or from a URL */
    onFileOpened?: (fileName: string, data: ArrayBuffer) => void
    onFileClosed?: () => void
    /** the viewer takes the focus when a score is shown */
    autoFocus?: boolean
    /** the title shown without a score (and in the document title) */
    appTitle?: string
}

// ---------------------------------------------------------------------------------
//   shared by all viewers on a page: the engraving fonts and the icon font
// ---------------------------------------------------------------------------------

/** the package's fonts/ directory (dist/muse-encore-viewer.js -> ../fonts/) */
function defaultFontsUrl(): string {
    return new URL(/* @vite-ignore */ '../fonts/', import.meta.url).href
}

/** the package's directory, which has the model of the note detection in basic-pitch/ */
function defaultNoteDetectionUrl(): string {
    return new URL(/* @vite-ignore */ '../', import.meta.url).href
}

/** the settings of the playalong and the MIDI input, kept between visits */
const PLAYALONG_SETTINGS_KEY = 'musescoreweb:viewer-playalong'

interface PlayalongSettings {
    practice: boolean
    midi: ViewerMidiSettings
}

function loadPlayalongSettings(): PlayalongSettings {
    const defaults: PlayalongSettings = { practice: false, midi: { enabled: false, deviceId: '', deviceName: '' } }
    try {
        const stored = JSON.parse(localStorage.getItem(PLAYALONG_SETTINGS_KEY) ?? '{}') as Partial<PlayalongSettings>
        return { practice: !!stored.practice, midi: { ...defaults.midi, ...stored.midi } }
    } catch {
        return defaults
    }
}

function savePlayalongSettings(settings: PlayalongSettings): void {
    try {
        localStorage.setItem(PLAYALONG_SETTINGS_KEY, JSON.stringify(settings))
    } catch {
        // no storage (blocked site data): the settings last until the page is closed
    }
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']

let s_fonts: Promise<void> | null = null

function loadFonts(fontsUrl: string): Promise<void> {
    if (!document.getElementById('muse-encore-viewer-icon-font')) {
        // fonts declared in a shadow root are not loaded: the UI icon font is declared in the document
        const style = document.createElement('style')
        style.id = 'muse-encore-viewer-icon-font'
        style.textContent = `@font-face { font-family: "MusescoreIcon"; src: url("${fontsUrl}musescoreicon/MusescoreIcon.ttf") format("truetype"); font-display: block; }`
        document.head.appendChild(style)
    }
    s_fonts ??= initEngravingFonts(async (path) => {
        const res = await fetch(`${fontsUrl}${path}`)
        if (!res.ok) {
            throw new Error(`could not load font ${path}`)
        }
        return res.arrayBuffer()
    })
    return s_fonts
}

// ---------------------------------------------------------------------------------
//   constants
// ---------------------------------------------------------------------------------

/** MuseScore's zoom steps (NotationViewInputController::ZOOM_LEVELS) */
const ZOOM_LEVELS = [5, 10, 15, 25, 50, 75, 100, 150, 200, 400, 800, 1600]
const MIN_ZOOM = ZOOM_LEVELS[0]
const MAX_ZOOM = ZOOM_LEVELS[ZOOM_LEVELS.length - 1]
const CSS_DPI = 96 // CSS pixels per inch at 100%
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024 // larger pages are drawn as tiles of the visible part
// the pages can be moved beyond their edges (like MuseScore's canvas) until this much of them is visible
const MIN_VISIBLE = 48
/** below this width the toolbar is compact */
const NARROW_WIDTH = 640

const FIT_MODES = ['page-width', 'whole-page'] as const
type FitMode = typeof FIT_MODES[number]

const VIEW_MODES: Record<ContinuousView, ViewerViewMode> = {
    'horizontal': 'continuous-horizontal',
    'vertical': 'continuous-vertical',
    'window-fit': 'fit-width',
}

const DEFAULT_GROUPS: Required<MuseEncoreViewerToolbarGroups> = {
    file: false, pageNavigation: true, pageView: true, zoom: true, playback: false, playalong: false, print: true, fullScreen: true,
}

// MuseScore's icon codes (src/framework/ui/view/iconcodes.h)
const ICON = {
    open: '&#xEF23;', close: '&#xEF14;', prev: '&#xF39C;', next: '&#xF39B;', pagesH: '&#xEF1C;', pagesV: '&#xF3AF;',
    twoPages: '&#xEF7F;', zoomOut: '&#xEF16;', zoomIn: '&#xEF18;', center: `<svg width="1em" height="1em" viewBox="${CENTER_ICON.viewBox}" aria-hidden="true" style="display:block"><path fill="currentColor" d="${CENTER_ICON.path}"/></svg>`, print: '&#xF3B7;', fullscreen: '&#xEF15;',
    play: '', pause: '', rewind: '&#xEF26;', microphone: '&#xF41B;', measurePrev: '&#xEF35;', measureNext: '&#xEF34;', practice: '&#xEF1F;', midi: '&#xEF98;',
}

const HOMEPAGE_URL = 'https://github.com/pstaender/muse-encore'

// the GitHub mark (Octicons, MIT)
const GITHUB_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>'

function template(appTitle: string): string {
    return `
<div id="toolbar-trigger" aria-hidden="true"></div>
<div id="toolbar" class="toolbar" role="toolbar" aria-label="Viewer controls">
    <div class="group" data-group="file">
        <button id="open" class="icon" title="Open… (Ctrl+O)" aria-label="Open file">${ICON.open}</button>
        <span id="title" class="title">${appTitle}</span>
        <button id="clear" class="icon" title="Close file" aria-label="Close file" hidden>${ICON.close}</button>
        <input type="file" id="file" accept="${openFileAccept()}" hidden>
    </div>

    <div class="group" id="nav-group" data-group="pageNavigation">
        <button id="prev" class="icon" title="Previous page (Ctrl+PgUp)" aria-label="Previous page">${ICON.prev}</button>
        <span id="page-info" class="page-info" aria-live="polite">–</span>
        <button id="next" class="icon" title="Next page (Ctrl+PgDn)" aria-label="Next page">${ICON.next}</button>
    </div>

    <div class="group" data-group="pageView">
        <select id="view-mode" title="View mode" aria-label="View mode">
            <option value="page">Page view</option>
            <option value="continuous-horizontal">Continuous view (horizontal)</option>
            <option value="continuous-vertical">Continuous view (vertical)</option>
            <option value="fit-width">Continuous view (fit to window)</option>
        </select>
        <div class="segmented" role="radiogroup" aria-label="Page layout">
            <button id="layout-h" class="icon" role="radio" title="Pages side by side" aria-label="Pages side by side">${ICON.pagesH}</button>
            <button id="layout-v" class="icon" role="radio" title="Pages vertically" aria-label="Pages vertically">${ICON.pagesV}</button>
        </div>
        <button id="spread" class="icon toggle" title="Two pages (two-sided page layout)" aria-label="Two pages" aria-pressed="false">${ICON.twoPages}</button>
    </div>

    <div class="group" data-group="zoom">
        <button id="zoom-out" class="icon" title="Zoom out (Ctrl+−)" aria-label="Zoom out">${ICON.zoomOut}</button>
        <select id="zoom" title="Zoom" aria-label="Zoom"></select>
        <button id="zoom-in" class="icon" title="Zoom in (Ctrl++)" aria-label="Zoom in">${ICON.zoomIn}</button>
        <button id="center" class="icon" title="Center measure" aria-label="Center measure">${ICON.center}</button>
    </div>

    <div class="group" data-group="playback">
        <button id="rewind" class="icon" title="Rewind" aria-label="Rewind">${ICON.rewind}</button>
        <button id="play" class="icon" title="Play" aria-label="Play">${ICON.play}</button>
        <input id="play-position" class="play-position" type="range" min="0" max="0" step="0.1" value="0" aria-label="Play position">
        <span id="play-time" class="play-time" aria-live="off">0:00 / 0:00</span>
    </div>

    <div class="group" data-group="playalong">
        <button id="playalong" class="icon toggle" title="Playalong: follow the score while you play (microphone or MIDI input)" aria-label="Playalong" aria-pressed="false">${ICON.microphone}</button>
        <span id="playalong-follow" class="playalong-follow" hidden>
            <button id="playalong-prev" class="icon" title="Previous measure" aria-label="Previous measure">${ICON.measurePrev}</button>
            <span id="playalong-measure" class="playalong-measure-number" role="status" aria-label="Measure number">–</span>
            <button id="playalong-next" class="icon" title="Next measure" aria-label="Next measure">${ICON.measureNext}</button>
            <button id="playalong-practice" class="icon toggle" title="Playalong practice: also follow when you repeat measures, go back or skip measures" aria-label="Playalong practice" aria-pressed="false">${ICON.practice}</button>
        </span>
        <span id="playalong-status" class="playalong-status" role="status" hidden></span>
        <button id="midi-settings" class="icon toggle" title="MIDI settings" aria-label="MIDI settings" aria-pressed="false">${ICON.midi}</button>
    </div>

    <div class="group end">
        <button id="print" class="icon" title="Print (Ctrl+P)" aria-label="Print" data-group="print">${ICON.print}</button>
        <button id="fullscreen" class="icon" title="Full screen (F11)" aria-label="Full screen" data-group="fullScreen">${ICON.fullscreen}</button>
        <button id="help" class="icon text" title="Keyboard shortcuts" aria-label="Keyboard shortcuts" aria-expanded="false">?</button>
    </div>
</div>

<div id="viewport" tabindex="0" aria-label="Score">
    <div id="pages"></div>
    <div id="empty" class="empty">
        <div id="drop-target" class="drop-target">
            <div class="drop-icon">${ICON.open}</div>
            <p><strong>Open a MuseScore file</strong></p>
            <p class="muted">Drop a MuseScore, MusicXML, MIDI, Capella or Guitar Pro file here, or <button id="open2" class="link">browse</button></p>
        </div>
        <p id="empty-message" class="muted"></p>
    </div>
</div>

<!-- shown while a file is opened (the layout blocks the page for a moment) -->
<div id="busy" class="busy" hidden>
    <div class="busy-card" role="status" aria-live="polite">
        <div class="spinner" aria-hidden="true"></div>
        <div id="busy-title" class="busy-title">Loading…</div>
        <div id="busy-detail" class="muted"></div>
    </div>
</div>

<div id="statusbar" class="statusbar">
    <span id="status">Loading fonts…</span>
</div>

<dialog id="help-dialog" aria-label="Keyboard shortcuts">
    <h2>Keyboard shortcuts</h2>
    <table>
        <tr data-group="file"><td><kbd>Ctrl</kbd> <kbd>O</kbd></td><td>Open file</td></tr>
        <tr data-group="playback"><td><kbd>Space</kbd></td><td>Play / pause</td></tr>
        <tr data-group="playalong"><td><kbd>←</kbd> / <kbd>→</kbd></td><td>Previous / next measure during the playalong</td></tr>
        <tr><td><kbd>Ctrl</kbd> <kbd>+</kbd> / <kbd>Ctrl</kbd> <kbd>−</kbd></td><td>Zoom in / out</td></tr>
        <tr><td><kbd>Ctrl</kbd> <kbd>0</kbd></td><td>Zoom to 100%</td></tr>
        <tr><td>Mouse wheel, pinch</td><td>Zoom at pointer</td></tr>
        <tr><td><kbd>Shift</kbd> + wheel, trackpad</td><td>Scroll</td></tr>
        <tr><td>Drag (or hold <kbd>Space</kbd> + drag)</td><td>Move the view (also beyond the pages)</td></tr>
        <tr><td><kbd>Ctrl</kbd> <kbd>PgDn</kbd> / <kbd>Ctrl</kbd> <kbd>PgUp</kbd></td><td>Next / previous page</td></tr>
        <tr><td><kbd>Home</kbd> / <kbd>End</kbd></td><td>First / last page</td></tr>
        <tr><td>Arrow keys</td><td>Scroll</td></tr>
        <tr><td><kbd>Ctrl</kbd> <kbd>P</kbd></td><td>Print</td></tr>
        <tr><td><kbd>F11</kbd></td><td>Full screen</td></tr>
    </table>
    <p class="muted">On macOS use <kbd>⌘</kbd> instead of <kbd>Ctrl</kbd>.</p>
    <form method="dialog" class="dialog-buttons"><button id="about" type="button" class="secondary">About…</button><button class="primary">Close</button></form>
</dialog>

<dialog id="midi-dialog" class="midi-settings" aria-label="MIDI settings">
    <h2>MIDI settings</h2>
    <label class="midi-field"><input type="checkbox" id="midi-on"> Enable MIDI input</label>
    <label class="midi-field">MIDI input <select id="midi-device"></select></label>
    <p id="midi-message" class="midi-message" role="status"></p>
    <p class="muted">With a connected device, Playalong follows the keys you play instead of listening to the microphone.</p>
    <form method="dialog"><button class="primary">Close</button></form>
</dialog>

<dialog id="about-dialog" class="about" aria-label="About MuseEncore Viewer">
    <div class="about-logo" aria-hidden="true">${logoSvg.replace(/^[\s\S]*?(?=<svg)/, '')}</div>
    <h2>MuseEncore Viewer</h2>
    <p class="muted">Version ${VIEWER_VERSION}</p>
    <p><a href="${HOMEPAGE_URL}" target="_blank" rel="noopener">${GITHUB_ICON}<span>${HOMEPAGE_URL.replace('https://', '')}</span></a></p>
    <form method="dialog"><button class="primary" autofocus>Close</button></form>
</dialog>
`
}

function formatTime(sec: number): string {
    const s = Math.max(0, Math.floor(sec))
    const h = Math.floor(s / 3600)
    const m = Math.floor(s / 60) % 60
    const ss = String(s % 60).padStart(2, '0')
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

function isTextInput(t: EventTarget | null): boolean {
    return t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement
}

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

/** the file name of a URL (without query) */
function urlFileName(url: string): string {
    try {
        return decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || 'score.mscz')
    } catch {
        return 'score.mscz'
    }
}

// ---------------------------------------------------------------------------------
//   the viewer
// ---------------------------------------------------------------------------------

export class MuseEncoreViewer implements IMuseEncoreViewer {
    readonly element: HTMLElement
    readonly ready: Promise<MuseEncoreScoreInfo>
    /** the element with the shadow root (a child of `element`) */
    readonly host: HTMLDivElement
    readonly shadow: ShadowRoot

    private readonly m_opts: MuseEncoreViewerAppOptions
    private readonly m_groups: Required<MuseEncoreViewerToolbarGroups>
    private readonly m_fontsUrl: string
    private readonly m_appTitle: string
    private readonly m_abort = new AbortController()
    private m_resolveReady: (info: MuseEncoreScoreInfo) => void = () => {}
    private m_rejectReady: (e: Error) => void = () => {}
    private m_readySettled = false
    private m_destroyed = false

    // elements
    private readonly root: HTMLDivElement
    private readonly toolbar: HTMLElement
    private readonly viewport: HTMLElement
    private readonly pagesDiv: HTMLDivElement
    private readonly emptyDiv: HTMLDivElement
    private readonly statusEl: HTMLSpanElement
    private readonly titleEl: HTMLSpanElement
    private readonly fileInput: HTMLInputElement
    private readonly zoomSelect: HTMLSelectElement
    private readonly viewModeSelect: HTMLSelectElement
    private readonly pageInfo: HTMLSpanElement
    private readonly busyEl: HTMLDivElement
    private readonly helpDialog: HTMLDialogElement
    private readonly aboutDialog: HTMLDialogElement
    private readonly playPosition: HTMLInputElement
    private readonly playTime: HTMLSpanElement
    private readonly btn: Record<'open' | 'open2' | 'clear' | 'prev' | 'next' | 'layoutH' | 'layoutV' | 'spread' | 'zoomIn' | 'zoomOut'
        | 'print' | 'center' | 'fullscreen' | 'help' | 'play' | 'rewind' | 'playalong' | 'playalongPrev' | 'playalongNext' | 'playalongPractice' | 'midiSettings', HTMLButtonElement>
    private readonly midiDialog: HTMLDialogElement
    private readonly midiOn: HTMLInputElement
    private readonly midiDevice: HTMLSelectElement
    private readonly midiMessage: HTMLParagraphElement
    private readonly playalongFollow: HTMLSpanElement
    private readonly playalongMeasure: HTMLSpanElement
    private readonly playalongStatus: HTMLSpanElement

    // state
    private score: MasterScore | null = null
    private fileName = ''
    private settings: MuseEncoreViewSettings
    private zoom = 100 // current zoom in percent
    private pages: HTMLDivElement[] = []
    private readonly visible = new Set<HTMLDivElement>()
    private renderTimer = 0
    private scrollRenderTimer = 0
    private reflowTimer = 0
    private layoutVersion = 0 // counts the layouts of the score (the continuous panel repaints after a new one)
    private viewSwitch = 0
    private pan = { x: 0, y: 0 }
    private spaceDown = false
    private spaceUsed = false // the view was moved while Space was held (no play/pause)
    private drag: { x: number; y: number; left: number; top: number; id: number } | null = null
    private pinch: { dist: number; zoom: number } | null = null
    private gestureStartZoom = 0
    private toolbarHideTimer = 0
    private dragTimer = 0
    private loadToken = 0

    private readonly observer: IntersectionObserver
    private readonly resizeObserver: ResizeObserver
    private readonly removeImageListener: () => void
    private readonly viewSwitchIndicator: HTMLDivElement
    private readonly panelBox: HTMLDivElement
    private readonly panelCanvas: HTMLCanvasElement
    private panelFrame = 0
    private panelShownKey = ''
    private readonly playback: ViewerPlayback | null
    private readonly cursor: HTMLDivElement
    private readonly playalong: ViewerPlayalong | null
    private readonly midi: ViewerMidiInput | null
    private readonly playalongMarker: HTMLDivElement
    private playalongShownTick = -1
    private autoScrollPausedUntil = 0
    private programmaticScroll = 0

    constructor(element: HTMLElement, source?: MuseEncoreScoreSource | null, options: MuseEncoreViewerAppOptions = {}) {
        this.element = element
        this.m_opts = options
        this.m_groups = { ...DEFAULT_GROUPS, ...options.toolbarGroups }
        this.m_fontsUrl = (options.fontsUrl ?? defaultFontsUrl()).replace(/\/?$/, '/')
        this.m_appTitle = options.appTitle ?? 'MuseEncore Viewer'
        this.ready = new Promise<MuseEncoreScoreInfo>((resolve, reject) => {
            this.m_resolveReady = resolve
            this.m_rejectReady = reject
        })
        this.ready.catch(() => {}) // the error is also reported by onError and in the view

        // the initial view
        const zoomOpt = options.zoom ?? (options.centerAndResizeToPage === false ? 100 : 'whole-page')
        this.settings = options.viewSettings ? { ...options.viewSettings } : {
            zoom: String(zoomOpt),
            orientation: options.pageOrientation ?? 'horizontal',
            spread: options.twoPages ?? false,
            viewMode: options.continuousView ? VIEW_MODES[options.continuousView] ?? 'page' : 'page',
        }
        if (this.settings.viewMode === 'fit-width' && this.fitMode()) {
            this.settings.zoom = '100' // the page is as wide as the view: a fit mode makes no sense
        }

        // the shadow root in a child element (the element itself may not allow a shadow root or already have one)
        this.host = document.createElement('div')
        this.host.className = 'muse-encore-viewer'
        this.host.style.cssText = 'display:block;width:100%;height:100%'
        if (options.colorScheme === 'light' || options.colorScheme === 'dark') {
            this.host.dataset.theme = options.colorScheme
        }
        this.shadow = this.host.attachShadow({ mode: 'open' })
        const style = document.createElement('style')
        style.textContent = css
        this.root = document.createElement('div')
        this.root.className = 'viewer'
        this.root.innerHTML = template(this.m_appTitle)
        this.shadow.append(style, this.root)
        element.replaceChildren(this.host)

        const $ = <T extends HTMLElement>(id: string): T => this.shadow.getElementById(id) as T
        this.toolbar = $('toolbar')
        this.viewport = $('viewport')
        this.pagesDiv = $('pages')
        this.emptyDiv = $('empty')
        this.statusEl = $('status')
        this.titleEl = $('title')
        this.fileInput = $('file')
        this.zoomSelect = $('zoom')
        this.viewModeSelect = $('view-mode')
        this.pageInfo = $('page-info')
        this.busyEl = $('busy')
        this.helpDialog = $('help-dialog')
        this.aboutDialog = $('about-dialog')
        this.playPosition = $('play-position')
        this.playTime = $('play-time')
        this.btn = {
            open: $('open'), open2: $('open2'), clear: $('clear'), prev: $('prev'), next: $('next'), layoutH: $('layout-h'),
            layoutV: $('layout-v'), spread: $('spread'), zoomIn: $('zoom-in'), zoomOut: $('zoom-out'), print: $('print'),
            center: $('center'), fullscreen: $('fullscreen'), help: $('help'), play: $('play'), rewind: $('rewind'),
            playalong: $('playalong'), playalongPrev: $('playalong-prev'), playalongNext: $('playalong-next'),
            playalongPractice: $('playalong-practice'), midiSettings: $('midi-settings'),
        }
        this.midiDialog = $('midi-dialog')
        this.midiOn = $('midi-on')
        this.midiDevice = $('midi-device')
        this.midiMessage = $('midi-message')
        this.playalongFollow = $('playalong-follow')
        this.playalongMeasure = $('playalong-measure')
        this.playalongStatus = $('playalong-status')

        // the groups to show
        for (const el of this.root.querySelectorAll<HTMLElement>('[data-group]')) {
            el.hidden = !this.m_groups[el.dataset.group as keyof MuseEncoreViewerToolbarGroups]
        }
        this.btn.help.hidden = !options.keyboardShortcuts
        const endGroup = this.toolbar.querySelector<HTMLElement>('.group.end')!
        endGroup.hidden = [...endGroup.children].every(c => (c as HTMLElement).hidden)
        this.toolbar.hidden = !!options.disableToolbar || [...this.toolbar.children].every(c => (c as HTMLElement).hidden)
        $('statusbar').hidden = !options.showStatusBar
        $('drop-target').hidden = !this.m_groups.file
        if (!document.fullscreenEnabled) {
            this.btn.fullscreen.hidden = true
        }

        // the view mode switch indicator, the continuous panel, the playback cursor
        this.viewSwitchIndicator = document.createElement('div')
        this.viewSwitchIndicator.className = 'view-switch-indicator'
        this.viewSwitchIndicator.setAttribute('aria-hidden', 'true')
        this.viewSwitchIndicator.appendChild(document.createElement('div')).className = 'spinner'
        this.panelBox = document.createElement('div')
        this.panelBox.className = 'continuous-panel'
        this.panelBox.setAttribute('aria-hidden', 'true')
        this.panelCanvas = document.createElement('canvas')
        this.panelBox.appendChild(this.panelCanvas)
        this.cursor = document.createElement('div')
        this.cursor.className = 'playback-cursor'
        this.cursor.setAttribute('aria-hidden', 'true')
        this.cursor.hidden = true

        this.playback = this.m_groups.playback
            ? new ViewerPlayback(options.soundFontUrl ?? SOUNDFONT_CDN_URL, s => this.playbackChanged(s))
            : null

        this.playalongMarker = document.createElement('div')
        this.playalongMarker.className = 'playalong-marker'
        this.playalongMarker.setAttribute('aria-hidden', 'true')
        this.playalongMarker.hidden = true
        if (this.m_groups.playalong) {
            const stored = loadPlayalongSettings()
            const save = (): void => savePlayalongSettings({ practice: !!this.playalong?.state().practice, midi: this.midi!.settings() })
            this.midi = new ViewerMidiInput(stored.midi, () => {
                save()
                this.midiChanged()
            }, (pitch, time) => this.playalong?.midiNoteOn(pitch, time))
            let practice = stored.practice
            this.playalong = new ViewerPlayalong((options.noteDetectionUrl ?? defaultNoteDetectionUrl()).replace(/\/?$/, '/'), () => this.midi!.isReceiving(), practice, (s) => {
                if (s.practice !== practice) {
                    practice = s.practice
                    save()
                }
                this.playalongChanged(s)
            })
        } else {
            this.playalong = null
            this.midi = null
        }

        this.observer = new IntersectionObserver((entries) => {
            for (const e of entries) {
                const el = e.target as HTMLDivElement
                if (e.isIntersecting) {
                    this.visible.add(el)
                } else {
                    this.visible.delete(el)
                }
            }
            this.scheduleRender(0)
            this.updatePageInfo()
        }, { root: this.viewport, rootMargin: '50%' })

        this.resizeObserver = new ResizeObserver(() => this.resized())
        this.resizeObserver.observe(this.viewport)

        // images of the score are decoded asynchronously: draw the pages again when one is available
        this.removeImageListener = onImageDecoded(() => {
            for (const el of this.pages) {
                delete el.querySelector<HTMLCanvasElement>(':scope > canvas')!.dataset.dpi
            }
            this.panelShownKey = ''
            this.scheduleRender(0)
        })

        this.initZoomSelect()
        this.installListeners()
        this.updateControls()
        this.midiChanged()

        void loadFonts(this.m_fontsUrl).then(
            () => { if (!this.score && !this.isBusy()) this.setStatus('Ready') },
            (e: Error) => this.setStatus(`Error: ${e.message}`, true))

        if (source) {
            void this.load(source).catch(() => {})
        }
    }

    // ---------------------------------------------------------------------------------
    //   public API
    // ---------------------------------------------------------------------------------

    async load(source: MuseEncoreScoreSource, fileName?: string): Promise<MuseEncoreScoreInfo> {
        const token = ++this.loadToken
        let name = fileName ?? 'score.mscz'
        try {
            let data: ArrayBuffer
            if (typeof source === 'string' || source instanceof URL) {
                const url = String(source)
                name = fileName ?? urlFileName(url)
                await this.showBusy(`Opening ${name}`, 'Downloading…')
                const res = await fetch(url)
                if (!res.ok) {
                    throw new Error(`${res.status} ${res.statusText}`)
                }
                data = await res.arrayBuffer()
            } else if (source instanceof Blob) {
                name = fileName ?? ((source as File).name || name)
                data = await source.arrayBuffer()
            } else if (source instanceof Uint8Array) {
                data = source.slice().buffer as ArrayBuffer
            } else {
                data = source
            }
            if (token !== this.loadToken) {
                throw new Error('superseded by another score')
            }
            return await this.openData(name, data, true)
        } catch (e) {
            this.hideBusy()
            const error = e as Error
            this.loadFailed(name, error)
            throw error
        }
    }

    pageCount(): number {
        return this.score ? this.pages.length : 0
    }

    currentPage(): number {
        return this.currentPageIdx() + 1
    }

    goToPage(page: number): void {
        this.goToPageIdx(page - 1)
    }

    centerAndResizeToPage(page: number): void {
        if (this.settings.viewMode !== 'page') {
            this.setViewMode('page')
        }
        this.settings.zoom = 'whole-page'
        this.settingsChanged()
        this.applyZoom(this.computeZoom())
        this.centerPage(page - 1)
    }

    setZoom(zoom: number | 'whole-page' | 'page-width'): void {
        if (typeof zoom === 'number') {
            this.zoomAt(zoom)
        } else {
            this.setFitMode(zoom)
        }
    }

    setContinuousView(view: ContinuousView | false): void {
        this.setViewMode(view ? VIEW_MODES[view] : 'page')
    }

    async play(): Promise<void> {
        await this.playback?.play()
    }

    pause(): void {
        this.playback?.pause()
    }

    stop(): void {
        this.playback?.stop()
    }

    isPlaying(): boolean {
        return !!this.playback?.state().playing
    }

    toggleFullScreen(): void {
        if (document.fullscreenElement) {
            void document.exitFullscreen()
        } else {
            void this.host.requestFullscreen?.()
        }
    }

    /** prints the pages (in a frame with only the pages, like MuseScore's Score::print in every view mode) */
    async print(): Promise<void> {
        if (!this.score) {
            return
        }
        const n = pageCount(this.score)
        await this.showBusy('Preparing pages for printing…', `${n} ${n === 1 ? 'page' : 'pages'}`)
        let doc: string
        try {
            const { css: pageCss, html } = this.printPages()
            doc = `<!doctype html><html><head><meta charset="utf-8"><title>${this.fileName.replace(/[<&]/g, '')}</title><style>${pageCss}
html, body { margin: 0; padding: 0; background: #fff; }
.print-page { break-after: page; overflow: hidden; }
.print-page:last-child { break-after: auto; }
.print-page svg { display: block; }
</style></head><body>${html}</body></html>`
        } finally {
            this.hideBusy()
        }
        const frame = document.createElement('iframe')
        frame.setAttribute('aria-hidden', 'true')
        frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
        document.body.appendChild(frame)
        await new Promise<void>((resolve) => {
            frame.onload = () => resolve()
            frame.srcdoc = doc
        })
        const win = frame.contentWindow!
        const remove = (): void => { setTimeout(() => frame.remove(), 100) }
        win.addEventListener('afterprint', remove, { once: true })
        win.focus()
        win.print()
        // browsers without afterprint in frames: removed with the next print or after a minute
        setTimeout(remove, 60000)
    }

    /**
     * the pages as SVG (vector graphics) for printing and the @page rule of the score's page size (the paper has the
     * page size of the score, which also gives portrait or landscape)
     */
    printPages(): { css: string; html: string } {
        const score = this.score
        if (!score) {
            return { css: '', html: '' }
        }
        return withPageView(score, () => {
            const size = pageSize(score, 0)
            // glyph outlines are defined once for all pages
            const defs = new SvgGlyphDefs()
            let html = ''
            for (let i = 0; i < pageCount(score); ++i) {
                html += `<div class="print-page">${drawPageSvg(score, i, { defs })}</div>`
            }
            return { css: `@page { size: ${size.width}in ${size.height}in; margin: 0; }`, html: defs.svg() + html }
        })
    }

    /** handles a key event (the app forwards the keys typed outside of the viewer); returns true if it was used */
    handleKeyDown(e: KeyboardEvent): boolean {
        if (this.isBusy()) {
            e.preventDefault()
            return true
        }
        if (!this.m_opts.keyboardShortcuts || this.helpDialog.open || this.aboutDialog.open || this.midiDialog.open) {
            return false
        }
        const mod = e.ctrlKey || e.metaKey
        const key = e.key
        const target = e.composedPath()[0] ?? e.target

        if (key === ' ' && !mod && !isTextInput(target)) {
            // Space: play/pause (MuseScore) when released without moving the view; held and dragged: the hand tool
            e.preventDefault()
            if (!this.spaceDown) {
                this.spaceDown = true
                this.spaceUsed = false
                this.setHand(true)
            }
            return true
        }

        let handled = true
        if (mod && (key === '+' || key === '=')) {
            this.zoomStep(1)
        } else if (mod && (key === '-' || key === '_')) {
            this.zoomStep(-1)
        } else if (mod && key === '0') {
            this.zoomAt(100)
        } else if (mod && key.toLowerCase() === 'o' && this.m_groups.file) {
            this.fileInput.click()
        } else if (mod && key.toLowerCase() === 'p') {
            void this.print()
        } else if (key === 'F11') {
            this.toggleFullScreen()
        } else if (!this.score || isTextInput(target)) {
            handled = false
        } else if (key === 'PageDown') {
            this.stepPage(1)
        } else if (key === 'PageUp') {
            this.stepPage(-1)
        } else if (key === 'Home') {
            this.goToPageIdx(0)
        } else if (key === 'End') {
            this.goToPageIdx(this.pages.length - 1)
        } else if (!mod && (key === 'ArrowLeft' || key === 'ArrowRight') && this.playalong?.state().active) {
            this.playalong.step(key === 'ArrowLeft' ? -1 : 1)
        } else if (!mod && key.startsWith('Arrow') && this.shadow.activeElement !== this.viewport) {
            // arrow keys scroll natively when the score has the focus
            const d = 60
            this.viewport.scrollBy({
                left: key === 'ArrowLeft' ? -d : key === 'ArrowRight' ? d : 0,
                top: key === 'ArrowUp' ? -d : key === 'ArrowDown' ? d : 0,
            })
        } else {
            handled = false
        }
        if (handled) {
            e.preventDefault()
        }
        return handled
    }

    handleKeyUp(e: KeyboardEvent): void {
        if (e.key === ' ' && this.spaceDown) {
            this.spaceDown = false
            this.setHand(false)
            if (!this.spaceUsed && this.playback && this.score && !isTextInput(e.composedPath()[0] ?? e.target)) {
                this.playback.togglePlay()
            }
        }
    }

    /** closes the score (the app's close button) */
    closeFile(): void {
        this.playback?.setScore(null)
        this.playalong?.setScore(null)
        this.score = null
        this.fileName = ''
        this.m_opts.onFileClosed?.()
        this.buildPages()
        this.setStatus('Ready')
    }

    destroy(): void {
        if (this.m_destroyed) {
            return
        }
        this.m_destroyed = true
        this.m_abort.abort()
        this.observer.disconnect()
        this.resizeObserver.disconnect()
        this.removeImageListener()
        this.playback?.dispose()
        this.playalong?.dispose()
        this.midi?.dispose()
        clearTimeout(this.renderTimer)
        clearTimeout(this.scrollRenderTimer)
        clearTimeout(this.reflowTimer)
        clearTimeout(this.toolbarHideTimer)
        clearTimeout(this.dragTimer)
        cancelAnimationFrame(this.panelFrame)
        if (document.fullscreenElement === this.host) {
            void document.exitFullscreen()
        }
        this.host.remove()
        this.score = null
    }

    // ---------------------------------------------------------------------------------
    //   status and busy overlay: the layout is synchronous, the UI is blocked while a file is opened
    // ---------------------------------------------------------------------------------

    private setStatus(text: string, error = false): void {
        this.statusEl.textContent = text
        this.statusEl.parentElement!.classList.toggle('error', error)
    }

    private settingsChanged(): void {
        this.m_opts.onViewSettingsChange?.({ ...this.settings })
    }

    private isBusy(): boolean {
        return !this.busyEl.hidden
    }

    /** shows the overlay and waits until it is painted */
    private async showBusy(title: string, detail = ''): Promise<void> {
        const $ = (id: string): HTMLElement => this.shadow.getElementById(id)!
        $('busy-title').textContent = title
        $('busy-title').title = title
        $('busy-detail').textContent = detail
        if (this.busyEl.hidden) {
            this.busyEl.hidden = false
            this.root.setAttribute('aria-busy', 'true')
            this.viewport.setAttribute('inert', '')
        }
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve)))
    }

    private hideBusy(): void {
        this.busyEl.hidden = true
        this.root.removeAttribute('aria-busy')
        this.viewport.removeAttribute('inert')
    }

    // ---------------------------------------------------------------------------------
    //   files
    // ---------------------------------------------------------------------------------

    private async openData(name: string, data: ArrayBuffer, notify: boolean): Promise<MuseEncoreScoreInfo> {
        await this.showBusy(`Opening ${name}`, 'Loading fonts…')
        await loadFonts(this.m_fontsUrl)
        this.setStatus(`Loading ${name}…`)
        // the overlay must be painted before the (synchronous) layout
        await this.showBusy(`Opening ${name}`, 'Laying out the score…')
        if (this.m_destroyed) {
            throw new Error('the viewer was removed')
        }
        try {
            const t0 = performance.now()
            const s = await openScoreFile(data, name)
            layoutScore(s)
            const n = pageCount(s) // the pages of the page view
            const t1 = performance.now()
            this.score = s
            this.fileName = name
            this.applyViewMode()
            ++this.layoutVersion
            this.playback?.setScore(s)
            this.playalong?.setScore(s)
            this.buildPages()
            this.showInitialPage()
            this.setStatus(`${name} · ${n} ${n === 1 ? 'page' : 'pages'} · layout ${Math.round(t1 - t0)} ms`)
            this.shadow.getElementById('empty-message')!.textContent = ''
            if (notify) {
                this.m_opts.onFileOpened?.(name, data)
            }
            const info: MuseEncoreScoreInfo = { fileName: name, title: scoreTitle(s), pageCount: n }
            if (!this.m_readySettled) {
                this.m_readySettled = true
                this.m_resolveReady(info)
            }
            this.m_opts.onLoad?.(info)
            return info
        } finally {
            this.hideBusy()
        }
    }

    private loadFailed(name: string, error: Error): void {
        console.error(error)
        this.setStatus(`Could not open ${name}: ${error.message}`, true)
        if (!this.score) {
            this.shadow.getElementById('empty-message')!.textContent = `Could not open ${name}: ${error.message}`
        }
        if (!this.m_readySettled) {
            this.m_readySettled = true
            this.m_rejectReady(error)
        }
        this.m_opts.onError?.(error)
    }

    private openFile(file: File): void {
        void this.load(file).catch(() => {})
    }

    /** the start of the view after loading: the page of centerAndResizeToPage */
    private showInitialPage(): void {
        if (!this.score || this.settings.viewMode !== 'page') {
            return
        }
        const page = this.m_opts.centerAndResizeToPage
        this.centerPage(typeof page === 'number' ? Math.max(0, Math.min(this.pages.length - 1, Math.round(page) - 1)) : 0)
        if (page === false) {
            this.showPageStart()
        }
    }

    // ---------------------------------------------------------------------------------
    //   pages
    // ---------------------------------------------------------------------------------

    /** a page is a white box; its canvas covers the whole page or, at high zoom, only the visible part */
    private makePage(idx: number): HTMLDivElement {
        const el = document.createElement('div')
        el.className = 'page'
        el.dataset.page = String(idx)
        el.setAttribute('role', 'img')
        el.setAttribute('aria-label', `Page ${idx + 1}`)
        el.appendChild(document.createElement('canvas'))
        return el
    }

    private spreadActive(): boolean {
        return !!this.score && this.settings.viewMode === 'page' && this.settings.spread && isTwoSided(this.score)
    }

    private buildPages(keepPosition = false): void {
        const scroll = { left: this.viewport.scrollLeft, top: this.viewport.scrollTop }
        this.hideContinuousPanel()
        this.cursor.remove()
        this.playalongMarker.remove()
        this.observer.disconnect()
        this.visible.clear()
        this.pagesDiv.replaceChildren()
        this.pages = []

        const score = this.score
        this.emptyDiv.hidden = !!score
        this.btn.clear.hidden = !score
        // like MuseScore's tab: the file name without extension; the score title as tooltip
        this.titleEl.textContent = score ? scoreBaseName(this.fileName) : this.m_appTitle
        this.titleEl.title = score ? [scoreTitle(score), this.fileName].filter(Boolean).join(' – ') : ''

        if (score) {
            const n = pageCount(score)
            for (let i = 0; i < n; ++i) {
                this.pages.push(this.makePage(i))
            }
            if (this.spreadActive()) {
                // two-sided layout: the first page is a right-hand page
                const placeholder = document.createElement('div')
                placeholder.className = 'page placeholder'
                placeholder.dataset.page = '0'
                placeholder.setAttribute('aria-hidden', 'true')
                const items = [placeholder, ...this.pages]
                for (let i = 0; i < items.length; i += 2) {
                    const spread = document.createElement('div')
                    spread.className = 'spread'
                    spread.append(...items.slice(i, i + 2))
                    this.pagesDiv.appendChild(spread)
                }
            } else {
                this.pagesDiv.append(...this.pages)
            }
            for (const el of this.pages) {
                this.observer.observe(el)
            }
        }

        this.updateControls()
        this.updatePan()
        this.applyZoom(this.computeZoom())
        this.updateCursor()
        this.updatePlayalongMarker(false)
        if (keepPosition) {
            this.viewport.scrollTo(scroll.left, scroll.top)
            return
        }
        if (score && this.settings.viewMode !== 'page') {
            this.showPageStart()
        } else if (score) {
            this.centerPage(0)
        } else {
            this.viewport.scrollTo(0, 0)
        }
        if (this.m_opts.autoFocus || this.shadow.activeElement) {
            this.viewport.focus({ preventScroll: true })
        }
    }

    private pageCssSize(idx: number, z = this.zoom): { w: number; h: number } {
        const s = pageSize(this.score!, idx)
        const f = CSS_DPI * z / 100
        return { w: s.width * f, h: s.height * f }
    }

    /** sets the CSS size of all pages; the bitmaps are redrawn later (until then they are scaled) */
    private applyZoom(z: number): void {
        this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
        if (this.score) {
            for (const el of this.pagesDiv.querySelectorAll<HTMLDivElement>('.page')) {
                const { w, h } = this.pageCssSize(Number(el.dataset.page))
                el.style.width = `${w}px`
                el.style.height = `${h}px`
            }
        }
        this.updateZoomSelect()
        this.scheduleRender(120)
    }

    private scheduleRender(delay: number): void {
        clearTimeout(this.renderTimer)
        this.renderTimer = window.setTimeout(() => this.renderVisible(), delay)
    }

    /**
     * Draws a page at the given resolution. Small enough pages are drawn completely; otherwise only the visible part
     * of the page plus a margin of half a viewport is drawn (a "tile"), so the bitmap stays small at any zoom.
     */
    private renderPage(el: HTMLDivElement, cssDpi: number): void {
        const idx = Number(el.dataset.page)
        const s = pageSize(this.score!, idx)
        const dpr = window.devicePixelRatio
        const dpi = cssDpi * dpr
        const fullW = s.width * dpi
        const fullH = s.height * dpi
        const c = el.querySelector<HTMLCanvasElement>(':scope > canvas')!
        const d = c.dataset
        const sameDpi = d.dpi === dpi.toFixed(4)

        let region: { x: number; y: number; width: number; height: number } | undefined
        if (fullW * fullH <= MAX_CANVAS_PIXELS) {
            if (sameDpi && d.tile === '0') {
                return
            }
        } else {
            // visible part of the page in device pixels
            const pr = el.getBoundingClientRect()
            const vr = this.viewport.getBoundingClientRect()
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
        drawPage(this.score!, idx, c.getContext('2d')!, { dpi, region })
        Object.assign(d, { dpi: dpi.toFixed(4), tile: region ? '1' : '0', x: String(x), y: String(y), w: String(w), h: String(h) })
    }

    private renderVisible(): void {
        if (!this.score) {
            return
        }
        this.updateContinuousPanel()
        const cssDpi = CSS_DPI * this.zoom / 100
        // draw one page per frame to keep the UI responsive
        const queue = [...this.visible].sort((a, b) => Number(a.dataset.page) - Number(b.dataset.page))
        const step = (): void => {
            const el = queue.shift()
            if (!el || !this.score) {
                return
            }
            if (el.isConnected) {
                this.renderPage(el, cssDpi)
            }
            requestAnimationFrame(step)
        }
        step()
    }

    // ---------------------------------------------------------------------------------
    //   zoom
    // ---------------------------------------------------------------------------------

    private fitMode(): FitMode | null {
        return (FIT_MODES as readonly string[]).includes(this.settings.zoom) ? this.settings.zoom as FitMode : null
    }

    private computeZoom(): number {
        const mode = this.fitMode()
        const score = this.score
        if (!score || !mode) {
            const z = Number(this.settings.zoom)
            return Number.isFinite(z) && z > 0 ? z : 100
        }
        if (this.settings.viewMode === 'fit-width') {
            return 100 // the page is as wide as the view (at this zoom)
        }
        const gap = this.pageGap()
        const availW = this.viewport.clientWidth - 2 * gap
        const availH = this.viewport.clientHeight - 2 * gap
        const s = pageSize(score, 0)
        // the continuous views fit their long page across it (MuseScore fits the page view only)
        if (this.settings.viewMode === 'continuous-horizontal') {
            return Math.max(MIN_ZOOM, availH / (s.height * CSS_DPI) * 100)
        }
        if (this.settings.viewMode === 'continuous-vertical') {
            return Math.max(MIN_ZOOM, availW / (s.width * CSS_DPI) * 100)
        }
        const pagesAcross = this.spreadActive() ? 2 : 1
        const zw = availW / (s.width * pagesAcross * CSS_DPI) * 100
        const zh = availH / (s.height * CSS_DPI) * 100
        return Math.max(MIN_ZOOM, mode === 'page-width' ? zw : Math.min(zw, zh))
    }

    private initZoomSelect(): void {
        for (const level of ZOOM_LEVELS) {
            const o = document.createElement('option')
            o.value = String(level)
            o.textContent = `${level}%`
            o.dataset.level = '1'
            this.zoomSelect.appendChild(o)
        }
    }

    private updateZoomSelect(): void {
        const zoomSelect = this.zoomSelect
        const custom = zoomSelect.querySelector<HTMLOptionElement>('option[data-custom]')
        for (const o of zoomSelect.querySelectorAll<HTMLOptionElement>('option[data-level]')) {
            o.selected = false
        }
        // the fit modes of the view mode: the page view fits the page's width or the whole page; the continuous views fit
        // their one long page across (both modes zoom alike: one entry); "Fit to window" makes the page as wide as the
        // view, fitting has no effect there
        const viewMode = this.settings.viewMode
        const fitOptions: [FitMode, string][] = viewMode === 'page' ? [['page-width', 'Page width'], ['whole-page', 'Whole page']]
            : viewMode === 'continuous-horizontal' ? [['page-width', 'Fit to window height']]
            : viewMode === 'continuous-vertical' ? [['page-width', 'Fit to window width']]
            : []
        const shown = [...zoomSelect.querySelectorAll<HTMLOptionElement>('option[data-fit]')]
        if (shown.map(o => o.value + o.textContent).join() !== fitOptions.map(([m, t]) => m + t).join()) {
            shown.forEach(o => o.remove())
            const first = zoomSelect.querySelector('option[data-level]')
            for (const [m, title] of fitOptions) {
                const o = document.createElement('option')
                o.value = m
                o.textContent = title
                o.dataset.fit = '1'
                zoomSelect.insertBefore(o, first)
            }
        }
        const mode = this.fitMode()
        if (mode && fitOptions.length) {
            zoomSelect.value = fitOptions.find(([m]) => m === mode)?.[0] ?? fitOptions[0][0]
            custom?.remove()
            return
        }
        const level = ZOOM_LEVELS.find(l => Math.abs(l - this.zoom) < 0.5)
        if (level !== undefined) {
            custom?.remove()
            zoomSelect.value = String(level)
            return
        }
        let opt = custom
        if (!opt) {
            opt = document.createElement('option')
            opt.dataset.custom = '1'
            zoomSelect.prepend(opt)
        }
        opt.value = String(this.zoom)
        opt.textContent = `${Math.round(this.zoom)}%`
        zoomSelect.value = opt.value
    }

    /** zooms keeping the score point under (clientX, clientY) in place */
    private zoomAt(z: number, clientX?: number, clientY?: number): void {
        if (!this.score) {
            return
        }
        const viewport = this.viewport
        const rect = viewport.getBoundingClientRect()
        const x = clientX ?? rect.left + rect.width / 2
        const y = clientY ?? rect.top + rect.height / 2

        // anchor: the page under the point (or the nearest one) and the relative position on it
        let anchor: HTMLDivElement | null = null
        let best = Infinity
        for (const c of this.visible.size ? this.visible : this.pages) {
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

        this.settings.zoom = String(Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) * 100) / 100)
        this.settingsChanged()
        this.applyZoom(Number(this.settings.zoom))

        if (anchor && before) {
            const after = anchor.getBoundingClientRect()
            viewport.scrollLeft += after.left + fx * after.width - x
            viewport.scrollTop += after.top + fy * after.height - y
        }
        this.scheduleReflow()
    }

    private zoomStep(dir: 1 | -1): void {
        const next = dir > 0 ? ZOOM_LEVELS.find(l => l > this.zoom + 0.5) : [...ZOOM_LEVELS].reverse().find(l => l < this.zoom - 0.5)
        this.zoomAt(next ?? (dir > 0 ? MAX_ZOOM : MIN_ZOOM))
    }

    private setFitMode(mode: FitMode): void {
        const page = this.currentPageIdx()
        this.settings.zoom = mode
        this.settingsChanged()
        this.applyZoom(this.computeZoom())
        this.scheduleReflow()
        this.centerPage(page)
    }

    private resized(): void {
        this.root.classList.toggle('narrow', this.root.clientWidth < NARROW_WIDTH)
        this.updatePan()
        this.scheduleReflow()
        if (this.fitMode() && this.score) {
            // the page stays fitted and centered (e.g. entering full screen)
            const page = this.currentPageIdx()
            this.applyZoom(this.computeZoom())
            this.centerPage(page)
        }
    }

    // ---------------------------------------------------------------------------------
    //   layout and navigation
    // ---------------------------------------------------------------------------------

    private updateControls(): void {
        const has = !!this.score
        const horizontal = this.settings.orientation === 'horizontal'
        const pageView = this.settings.viewMode === 'page'
        const btn = this.btn
        this.pagesDiv.className = (horizontal ? 'horizontal' : 'vertical') + (pageView ? '' : ' continuous')
        btn.layoutH.setAttribute('aria-checked', String(horizontal))
        btn.layoutV.setAttribute('aria-checked', String(!horizontal))
        this.viewModeSelect.value = this.settings.viewMode
        const twoSided = !!this.score && isTwoSided(this.score)
        btn.spread.disabled = !twoSided || !pageView
        btn.spread.setAttribute('aria-pressed', String(this.spreadActive()))
        btn.spread.title = twoSided ? 'Two pages' : 'Two pages (only for scores with a two-sided page layout)'
        for (const b of [btn.prev, btn.next, btn.zoomIn, btn.zoomOut, btn.center, btn.print, btn.play, btn.rewind, btn.playalong]) {
            b.disabled = !has
        }
        this.playPosition.disabled = !has
        // the continuous views have one page: no page layout
        btn.layoutH.disabled = btn.layoutV.disabled = !has || !pageView
        // nor page navigation or centering of a page
        btn.prev.parentElement!.hidden = !this.m_groups.pageNavigation || !pageView
        btn.center.hidden = !pageView
        this.zoomSelect.disabled = !has
        this.updateZoomSelect() // the fit modes of the view mode
        this.updatePageInfo()
    }

    private setOrientation(o: 'horizontal' | 'vertical'): void {
        const page = this.currentPageIdx()
        this.settings.orientation = o
        this.settingsChanged()
        this.updateControls()
        if (this.fitMode()) {
            this.applyZoom(this.computeZoom())
        }
        this.centerPage(page)
    }

    private toggleSpread(): void {
        const page = this.currentPageIdx()
        this.settings.spread = !this.settings.spread
        this.settingsChanged()
        this.buildPages()
        this.centerPage(page)
    }

    /** index of the page nearest to the start of the viewport */
    private currentPageIdx(): number {
        if (!this.pages.length) {
            return 0
        }
        const r = this.viewport.getBoundingClientRect()
        const horizontal = this.settings.orientation === 'horizontal'
        let best = 0
        let bestDist = Infinity
        for (const c of this.pages) {
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

    private goToPageIdx(idx: number, behavior: ScrollBehavior = 'smooth'): void {
        if (!this.pages.length) {
            return
        }
        const c = this.pages[Math.max(0, Math.min(this.pages.length - 1, idx))]
        // in a spread, scroll to the spread (its left page)
        const target = c.parentElement?.classList.contains('spread') ? c.parentElement : c
        const gap = this.pageGap()
        const vr = this.viewport.getBoundingClientRect()
        const tr = target.getBoundingClientRect()
        if (this.settings.orientation === 'horizontal') {
            this.viewport.scrollTo({ left: this.viewport.scrollLeft + tr.left - vr.left - gap, behavior })
        } else {
            this.viewport.scrollTo({ top: this.viewport.scrollTop + tr.top - vr.top - gap, behavior })
        }
    }

    /** shows the page (in a spread: the spread) in the middle of the view, horizontally and vertically */
    private centerPage(idx = this.currentPageIdx()): void {
        if (!this.pages.length) {
            return
        }
        const viewport = this.viewport
        const c = this.pages[Math.max(0, Math.min(this.pages.length - 1, idx))]
        const target = c.parentElement?.classList.contains('spread') ? c.parentElement : c
        const vr = viewport.getBoundingClientRect()
        const tr = target.getBoundingClientRect()
        // the long page of a continuous view is centered only along the axis where it fits
        const continuous = this.settings.viewMode !== 'page'
        if (!continuous || tr.width <= viewport.clientWidth) {
            viewport.scrollLeft += tr.left + tr.width / 2 - (vr.left + viewport.clientWidth / 2)
        }
        if (!continuous || tr.height <= viewport.clientHeight) {
            viewport.scrollTop += tr.top + tr.height / 2 - (vr.top + viewport.clientHeight / 2)
        }
    }

    /** The center button: the measure of centerTargetBounds, or its page if that fits into the view (same in the editor) */
    private centerMeasureOrPage(): void {
        const target = this.score ? centerTargetBounds(this.score, this.playback?.state()) : null
        const el = target ? this.pages[target.page] : null
        if (target && el) {
            centerViewOnMeasureOrPage(this.viewport, el, pageSize(this.score!, target.page).width, target)
        } else {
            this.centerPage()
        }
    }

    /** the continuous views: shows the beginning of their page (centered along an axis where it fits) */
    private showPageStart(): void {
        const el = this.pages[0]
        if (!el) {
            return
        }
        const viewport = this.viewport
        const gap = this.pageGap()
        const vr = viewport.getBoundingClientRect()
        const tr = el.getBoundingClientRect()
        viewport.scrollLeft += tr.width <= viewport.clientWidth
            ? tr.left + tr.width / 2 - (vr.left + viewport.clientWidth / 2) : tr.left - vr.left - gap
        viewport.scrollTop += tr.height <= viewport.clientHeight
            ? tr.top + tr.height / 2 - (vr.top + viewport.clientHeight / 2) : tr.top - vr.top - gap
    }

    private pageGap(): number {
        return parseFloat(getComputedStyle(this.root).getPropertyValue('--page-gap')) || 24
    }

    /** sets the space around the pages; the view keeps showing the same part of the pages */
    private updatePan(): void {
        const viewport = this.viewport
        // without a score nothing can be moved (the drop target must stay in view)
        const next = this.score ? {
            x: this.settings.viewMode === 'fit-width' ? 0 : Math.max(0, viewport.clientWidth - MIN_VISIBLE - this.pageGap()),
            y: Math.max(0, viewport.clientHeight - MIN_VISIBLE - this.pageGap()),
        } : { x: 0, y: 0 }
        if (next.x === this.pan.x && next.y === this.pan.y) {
            return
        }
        this.pagesDiv.style.setProperty('--pan-x', `${next.x}px`)
        this.pagesDiv.style.setProperty('--pan-y', `${next.y}px`)
        viewport.scrollLeft += next.x - this.pan.x
        viewport.scrollTop += next.y - this.pan.y
        this.pan = next
    }

    private stepPage(dir: 1 | -1): void {
        const cur = this.currentPageIdx()
        if (!this.spreadActive()) {
            this.goToPageIdx(cur + dir)
            return
        }
        // spreads: [1], [2, 3], [4, 5], ... (0-based: [0], [1, 2], [3, 4], ...)
        const spread = cur === 0 ? 0 : Math.floor((cur + 1) / 2)
        const target = Math.max(0, spread + dir)
        this.goToPageIdx(target === 0 ? 0 : 2 * target - 1)
    }

    private updatePageInfo(): void {
        if (!this.score) {
            this.pageInfo.textContent = '–'
            this.btn.prev.disabled = this.btn.next.disabled = true
            return
        }
        const n = this.pages.length
        const cur = this.currentPageIdx()
        const partner = this.spreadActive() && cur > 0 ? (cur % 2 === 1 ? cur + 1 : cur - 1) : -1
        const shown = partner >= 0 && partner < n ? `${Math.min(cur, partner) + 1}–${Math.max(cur, partner) + 1}` : `${cur + 1}`
        this.pageInfo.textContent = `${shown} / ${n}`
        this.btn.prev.disabled = cur <= 0
        this.btn.next.disabled = Math.max(cur, partner) >= n - 1
    }

    // ---------------------------------------------------------------------------------
    //   view modes (MuseScore's status bar: NotationStatusBarModel::setCurrentViewMode, NotationPainting::setViewMode)
    // ---------------------------------------------------------------------------------

    /** the page width of the "fit to window" view in inches: the width of the view at the current zoom */
    private fitWidthInches(): number {
        return Math.max(1, (this.viewport.clientWidth - 2 * this.pageGap()) / (CSS_DPI * this.zoom / 100))
    }

    /** lays the score out in the view mode of the settings; returns true if the layout changed */
    private applyViewMode(): boolean {
        const score = this.score
        if (!score) {
            return false
        }
        const mode = this.settings.viewMode
        if (mode === 'fit-width') {
            // the zoom of the view first (the page width follows from it)
            this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.computeZoom()))
        }
        return setScoreViewMode(score, mode, mode === 'fit-width' ? this.fitWidthInches() : 0)
    }

    private setViewMode(mode: ViewerViewMode): void {
        if (mode === this.settings.viewMode) {
            return
        }
        this.settings.viewMode = mode
        if (mode === 'fit-width' && this.score && this.fitMode()) {
            this.settings.zoom = '100'
        }
        this.settingsChanged()
        if (!this.score) {
            this.updateControls()
            return
        }
        const viewport = this.viewport
        const r = viewport.getBoundingClientRect()
        const rr = this.root.getBoundingClientRect()
        Object.assign(this.viewSwitchIndicator.style, {
            left: `${r.left - rr.left}px`, top: `${r.top - rr.top}px`, width: `${r.width}px`, height: `${r.height}px`,
        })
        this.root.appendChild(this.viewSwitchIndicator)
        viewport.classList.add('view-switching')
        viewport.inert = true
        // the indicator must be painted before the (synchronous) layout; a later switch replaces this one
        const token = ++this.viewSwitch
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
            if (token !== this.viewSwitch || !this.score || this.m_destroyed) {
                return
            }
            viewport.inert = false
            try {
                this.applyViewMode()
                ++this.layoutVersion
                this.buildPages()
            } finally {
                viewport.classList.remove('view-switching')
                this.viewSwitchIndicator.remove()
            }
        })))
    }

    /** the "fit to window" view: the score is laid out again for a new width of the view or a new zoom */
    private scheduleReflow(): void {
        if (!this.score || this.settings.viewMode !== 'fit-width') {
            return
        }
        clearTimeout(this.reflowTimer)
        this.reflowTimer = window.setTimeout(() => {
            const el = this.pages[0]
            const score = this.score
            if (!score || !el || this.settings.viewMode !== 'fit-width') {
                return
            }
            // the same part of the score stays at the top of the view (as far as the new layout allows)
            const viewport = this.viewport
            const vr = viewport.getBoundingClientRect()
            const before = el.getBoundingClientRect()
            const f = (vr.top - before.top) / before.height
            if (!setScoreViewMode(score, 'fit-width', this.fitWidthInches())) {
                return
            }
            ++this.layoutVersion
            this.buildPages(true)
            const after = this.pages[0].getBoundingClientRect()
            viewport.scrollTop += after.top + f * after.height - vr.top
            viewport.scrollLeft += after.left + after.width / 2 - (vr.left + viewport.clientWidth / 2)
        }, 150)
    }

    // the continuous view (horizontal): the staff names, clefs, key and time signatures at the left edge of the view
    // (a box as wide as the panel, with a shadow at its right edge; the canvas in it is wider). The box is sticky at the
    // left edge of the view (CSS), so it doesn't lag behind the scrolling; its contents are repainted only when they change.

    private scheduleContinuousPanel(): void {
        if (!this.panelFrame) {
            this.panelFrame = requestAnimationFrame(() => {
                this.panelFrame = 0
                this.updateContinuousPanel()
            })
        }
    }

    private hideContinuousPanel(): void {
        this.panelBox.remove()
        this.panelShownKey = ''
    }

    /** C++ AbstractNotationPaintView::paint: m_continuousPanel->paint() after the score, at the left edge of the view */
    private updateContinuousPanel(): void {
        const el = this.pages[0]
        const score = this.score
        if (!score || !el || this.settings.viewMode !== 'continuous-horizontal') {
            this.hideContinuousPanel()
            return
        }
        const pr = el.getBoundingClientRect()
        const vr = this.viewport.getBoundingClientRect()
        const cssPerInch = pr.width / pageSize(score, 0).width
        const leftCss = Math.max(0, vr.left - pr.left)
        const topCss = Math.max(0, vr.top - pr.top)
        const widthCss = Math.ceil(this.viewport.clientWidth / 2)
        const dpr = window.devicePixelRatio
        const w = Math.round(widthCss * dpr)
        const h = Math.round(pr.height * dpr)
        const canvas = this.panelCanvas
        // the canvas keeps its contents unless its size, the zoom or the layout changed
        const viewKey = `${this.layoutVersion}|${w}x${h}|${cssPerInch.toFixed(4)}|`
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w
            canvas.height = h
            this.panelShownKey = ''
        }
        const ctx = canvas.getContext('2d')!
        const shownKey = this.panelShownKey.startsWith(viewKey) ? this.panelShownKey.slice(viewKey.length) : undefined
        // paints only if the contents changed (over the old ones: the panel's background covers the visible part)
        const result = drawContinuousPanel(score, ctx, { dpi: cssPerInch * dpr, left: leftCss / cssPerInch, top: topCss / cssPerInch, shownKey })
        if (!result) {
            this.hideContinuousPanel()
            return
        }
        this.panelShownKey = viewKey + result.key
        Object.assign(canvas.style, { width: `${widthCss}px`, height: `${pr.height}px` })
        Object.assign(this.panelBox.style, { width: `${Math.min(widthCss, result.width * cssPerInch)}px`, height: `${pr.height}px` })
        if (this.panelBox.parentElement !== el) {
            el.prepend(this.panelBox)
        }
    }

    // ---------------------------------------------------------------------------------
    //   playback: the controls, the cursor (AbstractNotationPaintView::movePlaybackCursor) and the view following it
    // ---------------------------------------------------------------------------------

    private playbackChanged(s: ViewerPlaybackState): void {
        const playing = s.playing
        this.btn.play.textContent = playing ? ICON.pause : ICON.play
        this.btn.play.title = playing ? 'Pause' : 'Play'
        this.btn.play.setAttribute('aria-label', this.btn.play.title)
        this.playPosition.max = String(s.totalTime)
        if (!this.playPosition.matches(':active')) {
            this.playPosition.value = String(s.position)
        }
        if (s.loading !== null) {
            this.playTime.textContent = Number.isNaN(s.loading) ? 'Loading sounds…' : `Loading sounds… ${Math.round(s.loading * 100)}%`
        } else {
            this.playTime.textContent = `${formatTime(s.position)} / ${formatTime(s.totalTime)}`
        }
        if (s.error) {
            this.setStatus(`Could not load the sounds: ${s.error}`, true)
            this.playTime.title = s.error
        }
        this.updateCursor()
    }

    private updateCursor(): void {
        const s = this.playback?.state()
        const score = this.score
        if (!s || !score || !s.playing) {
            this.cursor.hidden = true
            return
        }
        const b = playbackCursorBounds(score, s.tick)
        const pageEl = b ? this.pages[b.page] : undefined
        if (!b || !pageEl) {
            this.cursor.hidden = true
            return
        }
        const size = pageSize(score, b.page)
        if (this.cursor.parentElement !== pageEl) {
            pageEl.appendChild(this.cursor)
        }
        Object.assign(this.cursor.style, {
            left: `${b.x / size.width * 100}%`, top: `${b.y / size.height * 100}%`,
            width: `${b.width / size.width * 100}%`, height: `${b.height / size.height * 100}%`,
        })
        this.cursor.hidden = false
        if (performance.now() >= this.autoScrollPausedUntil) {
            this.adjustViewToCursor(pageEl, b.page === 0 && this.settings.viewMode === 'continuous-horizontal')
        }
    }

    /**
     * AbstractNotationPaintView::adjustCanvasPosition: the view follows the cursor (with a border of 3 spatium, the
     * cursor is 0.4 spatium wide), in the continuous view (horizontal) the cursor stays in the middle (smooth panning)
     */
    private adjustViewToCursor(pageEl: HTMLDivElement, smoothPan: boolean): void {
        const viewport = this.viewport
        const vr = viewport.getBoundingClientRect()
        const view = { left: vr.left, top: vr.top, width: viewport.clientWidth, height: viewport.clientHeight }
        const c = this.cursor.getBoundingClientRect()
        let dx = 0
        let dy = 0
        if (smoothPan) {
            dx = c.left - (view.left + view.width / 2)
        } else {
            const border = 3 * c.width / 0.4
            if (c.left < view.left || c.right > view.left + view.width) {
                dx = c.left - border - view.left
            }
            if (c.top < view.top || c.bottom > view.top + view.height) {
                // the system at the top of the view (or centered if the page fits)
                const pr = pageEl.getBoundingClientRect()
                dy = pr.height <= view.height ? pr.top + pr.height / 2 - (view.top + view.height / 2) : c.top - border - view.top
            }
        }
        if (Math.round(dx) || Math.round(dy)) {
            this.programmaticScroll++
            viewport.scrollBy(Math.round(dx), Math.round(dy))
            requestAnimationFrame(() => { this.programmaticScroll = Math.max(0, this.programmaticScroll - 1) })
        }
    }

    /** the user moved the view while playing: the view stops following the cursor for 2 s (C++ moveCanvas) */
    private userMovedView(): void {
        if (this.playback?.state().playing) {
            this.autoScrollPausedUntil = performance.now() + 2000
        }
    }

    // ---------------------------------------------------------------------------------
    //   playalong: the controls, the measure followed (editor/playalong/playalongview.ts) and the MIDI settings
    // ---------------------------------------------------------------------------------

    private togglePlayalong(): void {
        const playalong = this.playalong
        if (!playalong) {
            return
        }
        if (playalong.state().active) {
            playalong.stop()
            return
        }
        // the sound of the playback would be heard by the microphone
        this.playback?.pause()
        playalong.start(this.playback?.state().tick ?? 0)
    }

    private playalongChanged(s: ViewerPlayalongState): void {
        const btn = this.btn
        btn.playalong.setAttribute('aria-pressed', String(s.active))
        btn.playalongPractice.setAttribute('aria-pressed', String(s.practice))
        this.playalongFollow.hidden = !s.active
        this.playalongMeasure.textContent = s.number > 0 ? String(s.number) : '–'
        btn.playalongPrev.disabled = s.index <= 0
        btn.playalongNext.disabled = s.index < 0 || s.index >= s.count - 1
        const status = s.status === 'loading' ? 'Starting the note detection…' : s.status === 'error' ? s.error : ''
        this.playalongStatus.textContent = status
        this.playalongStatus.hidden = !status
        this.playalongStatus.classList.toggle('error', s.status === 'error')
        if (s.status === 'error') {
            this.setStatus(s.error, true)
        } else if (s.heard.length) {
            const names = [...s.heard].sort((a, b) => a - b).map(p => `${NOTE_NAMES[p % 12]}${Math.floor(p / 12) - 1}`)
            this.setStatus(`Notes heard: ${names.join(' ')}`)
        }
        if (s.tick !== this.playalongShownTick) {
            this.playalongShownTick = s.tick
            this.updatePlayalongMarker(true)
        }
    }

    /** the measure followed is highlighted on its page (in percent of the page like the playback cursor) */
    private updatePlayalongMarker(scroll: boolean): void {
        const marker = this.playalongMarker
        const st = this.playalong?.state()
        const score = this.score
        const b = score && st?.active && st.tick >= 0 ? playalongMeasureBounds(score, st.tick) : null
        const pageEl = b ? this.pages[b.page] : undefined
        if (!b || !pageEl || !st || !score) {
            marker.hidden = true
            return
        }
        const size = pageSize(score, b.page)
        if (marker.parentElement !== pageEl) {
            pageEl.appendChild(marker)
        }
        Object.assign(marker.style, {
            left: `${b.x / size.width * 100}%`, top: `${b.y / size.height * 100}%`,
            width: `${b.width / size.width * 100}%`, height: `${b.height / size.height * 100}%`,
        })
        marker.hidden = false
        if (scroll) {
            // in the practice mode with the measure before it if it is on the same system
            const p = st.practice && st.prevTick >= 0 ? playalongMeasureBounds(score, st.prevTick) : null
            const context = p && p.page === b.page && Math.abs(p.y - b.y) < 0.01 && p.x < b.x
                ? { x: p.x, y: b.y, width: b.x + b.width - p.x, height: b.height } : undefined
            // the measure played next if it follows on the page (not a jump back)
            const n = st.nextTick >= 0 ? playalongMeasureBounds(score, st.nextTick) : null
            const ahead = n && n.page === b.page && (n.y > b.y + 0.01 || (Math.abs(n.y - b.y) < 0.01 && n.x > b.x)) ? n : undefined
            this.showRectInView(b.page, b, context, ahead)
        }
    }

    /**
     * the editor's showRectInView: the view moves only if the rectangle of a page (inches) or the measure after it would be
     * cut off, and only in the direction of a continuous view (not under the continuous panel)
     */
    private showRectInView(pageIdx: number, r: PageRect, context?: PageRect, ahead?: PageRect, recheck = true): void {
        const el = this.pages[pageIdx]
        const score = this.score
        if (!el || !score) {
            return
        }
        const viewport = this.viewport
        const mode = this.settings.viewMode
        const pr = el.getBoundingClientRect()
        const f = pr.width / pageSize(score, pageIdx).width
        const vr = viewport.getBoundingClientRect()
        const margin = 0.2 * f
        const inset = mode === 'continuous-horizontal' && this.panelBox.isConnected ? this.panelBox.getBoundingClientRect().width : 0
        const view = { left: vr.left + inset + margin, top: vr.top + margin, right: vr.left + viewport.clientWidth - margin, bottom: vr.top + viewport.clientHeight - margin }
        const toView = (x: PageRect): { left: number; top: number; right: number; bottom: number } =>
            ({ left: pr.left + x.x * f, top: pr.top + x.y * f, right: pr.left + (x.x + x.width) * f, bottom: pr.top + (x.y + x.height) * f })
        const show = toView(r)
        const next = ahead ? toView(ahead) : null
        let dx = 0
        let dy = 0
        if (mode !== 'continuous-vertical' && (show.left < view.left || show.right > view.right
            || (next && next.left >= show.left && next.right > view.right && Math.abs(next.top - show.top) < 1))) {
            const c = context ? toView(context) : null
            dx = (c && c.right - c.left <= view.right - view.left ? c : show).left - view.left
        }
        if (mode !== 'continuous-horizontal' && (show.top < view.top || show.bottom > view.bottom || (next && next.top > show.top && next.bottom > view.bottom))) {
            dy = show.bottom - show.top <= view.bottom - view.top ? show.top - view.top : show.top - vr.top
        }
        if (Math.round(dx) || Math.round(dy)) {
            this.programmaticScroll++
            viewport.scrollBy(Math.round(dx), Math.round(dy))
            requestAnimationFrame(() => { this.programmaticScroll = Math.max(0, this.programmaticScroll - 1) })
            if (recheck) {
                // once the panel is drawn for the new position (its width is known then)
                requestAnimationFrame(() => requestAnimationFrame(() => this.showRectInView(pageIdx, r, context, ahead, false)))
            }
        }
    }

    /** shows the state of the MIDI input in the dialog and the toolbar; the playalong takes the notes from where they are now */
    private midiChanged(): void {
        const midi = this.midi
        if (!midi) {
            return
        }
        const on = midi.isOn()
        this.midiOn.checked = on
        this.midiOn.disabled = midi.accessState() === 'unsupported'
        this.btn.midiSettings.setAttribute('aria-pressed', String(on))
        const devices = midi.devices()
        this.midiDevice.replaceChildren(...devices.map((d) => {
            const o = document.createElement('option')
            o.value = d.id
            o.textContent = d.id === NONE_DEVICE_ID ? 'No device' : d.name
            return o
        }))
        this.midiDevice.value = midi.deviceId() || NONE_DEVICE_ID
        this.midiDevice.disabled = !on
        this.midiMessage.textContent = midi.settings().enabled || this.midiOn.disabled ? midi.accessProblem() : ''
        this.playalong?.inputChanged()
    }

    // ---------------------------------------------------------------------------------
    //   input: wheel, pinch, the hand tool, keys, the toolbar, files
    // ---------------------------------------------------------------------------------

    private setHand(on: boolean): void {
        this.viewport.classList.toggle('hand', on || !!this.drag)
    }

    // in full screen the toolbar is collapsed; it is shown while the pointer is at the top edge or on it,
    // or while it has the keyboard focus
    private showToolbar(autoHideMs = 0): void {
        clearTimeout(this.toolbarHideTimer)
        this.root.classList.add('toolbar-shown')
        if (autoHideMs) {
            this.toolbarHideTimer = window.setTimeout(() => this.hideToolbar(), autoHideMs)
        }
    }

    private hideToolbar(): void {
        clearTimeout(this.toolbarHideTimer)
        if (this.toolbar.matches(':hover') || this.toolbar.matches(':has(:focus-visible)')) {
            return // pointer on it or keyboard navigation in it
        }
        this.root.classList.remove('toolbar-shown')
    }

    /** the drop highlight covers the score view */
    private setDropArea(): void {
        const r = this.viewport.getBoundingClientRect()
        const rr = this.root.getBoundingClientRect()
        const style = this.root.style
        style.setProperty('--drop-left', `${r.left - rr.left}px`)
        style.setProperty('--drop-top', `${r.top - rr.top}px`)
        style.setProperty('--drop-width', `${r.width}px`)
        style.setProperty('--drop-height', `${r.height}px`)
    }

    private endDragOver(): void {
        clearTimeout(this.dragTimer)
        this.root.classList.remove('dragover')
    }

    private installListeners(): void {
        const signal = this.m_abort.signal
        const viewport = this.viewport
        const btn = this.btn
        const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void,
            opts: AddEventListenerOptions = {}): void => el.addEventListener(type, fn, { ...opts, signal })

        on(viewport, 'scroll', () => {
            this.updatePageInfo()
            this.scheduleContinuousPanel()
            // tiles of zoomed-in pages follow the view, also while it keeps moving (smooth panning while playing)
            if (!this.scrollRenderTimer) {
                this.scrollRenderTimer = window.setTimeout(() => {
                    this.scrollRenderTimer = 0
                    this.renderVisible()
                }, 60)
            }
            if (!this.programmaticScroll) {
                this.userMovedView()
            }
        }, { passive: true })

        on(viewport, 'wheel', (e) => {
            if (!this.score) {
                return
            }
            if (e.ctrlKey || e.metaKey) {
                // trackpad pinch (reported as ctrl+wheel) and ctrl+wheel
                e.preventDefault()
                this.zoomAt(this.zoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY)
            } else if (!e.shiftKey && this.settings.viewMode === 'page' && isMouseWheel(e)) {
                // a wheel notch zooms in the page view; the continuous views are scrolled
                e.preventDefault()
                this.zoomAt(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX, e.clientY)
            }
            // otherwise: native scrolling (trackpad, shift+wheel)
        }, { passive: false })

        // Safari trackpad pinch
        viewport.addEventListener('gesturestart', (e) => { e.preventDefault(); this.gestureStartZoom = this.zoom }, { signal })
        viewport.addEventListener('gesturechange', (e) => {
            e.preventDefault()
            const ge = e as Event & { scale: number; clientX: number; clientY: number }
            this.zoomAt(this.gestureStartZoom * ge.scale, ge.clientX, ge.clientY)
        }, { signal })

        // touch pinch (one finger pans natively)
        const touchDist = (t: TouchList): number => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
        on(viewport, 'touchstart', (e) => {
            if (e.touches.length === 2 && this.score) {
                this.pinch = { dist: touchDist(e.touches), zoom: this.zoom }
            }
        }, { passive: true })
        on(viewport, 'touchmove', (e) => {
            if (this.pinch && e.touches.length === 2) {
                e.preventDefault()
                const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2
                const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2
                this.zoomAt(this.pinch.zoom * touchDist(e.touches) / this.pinch.dist, cx, cy)
            }
        }, { passive: false })
        on(viewport, 'touchend', (e) => {
            if (e.touches.length < 2) {
                this.pinch = null
            }
        })

        // drag the view with the mouse (left or middle button; touch scrolls natively); holding Space shows the hand
        on(viewport, 'pointerdown', (e) => {
            if (!this.score || (e.button !== 0 && e.button !== 1) || (e.pointerType === 'touch' && !this.spaceDown)) {
                return
            }
            // not on the scroll bars
            const r = viewport.getBoundingClientRect()
            if (e.clientX - r.left >= viewport.clientLeft + viewport.clientWidth
                || e.clientY - r.top >= viewport.clientTop + viewport.clientHeight) {
                return
            }
            e.preventDefault()
            if (this.spaceDown) {
                this.spaceUsed = true
            }
            this.drag = { x: e.clientX, y: e.clientY, left: viewport.scrollLeft, top: viewport.scrollTop, id: e.pointerId }
            viewport.setPointerCapture(e.pointerId)
            viewport.classList.add('hand', 'dragging')
        })
        on(viewport, 'pointermove', (e) => {
            if (this.drag && e.pointerId === this.drag.id) {
                viewport.scrollLeft = this.drag.left - (e.clientX - this.drag.x)
                viewport.scrollTop = this.drag.top - (e.clientY - this.drag.y)
            }
        })
        const endDrag = (e: PointerEvent): void => {
            if (this.drag && e.pointerId === this.drag.id) {
                this.drag = null
                viewport.classList.remove('dragging')
                this.setHand(this.spaceDown)
            }
        }
        on(viewport, 'pointerup', endDrag)
        on(viewport, 'pointercancel', endDrag)

        // keys typed in the viewer (the app forwards the others)
        on(this.root, 'keydown', (e) => { this.handleKeyDown(e) })
        on(this.root, 'keyup', (e) => this.handleKeyUp(e))
        window.addEventListener('blur', () => {
            this.spaceDown = false
            this.setHand(false)
        }, { signal })

        // full screen
        document.addEventListener('fullscreenchange', () => {
            const fs = document.fullscreenElement === this.host
            this.root.classList.toggle('fullscreen', fs)
            btn.fullscreen.title = fs ? 'Exit full screen (F11)' : 'Full screen (F11)'
            btn.fullscreen.setAttribute('aria-label', fs ? 'Exit full screen' : 'Full screen')
            if (fs) {
                // briefly, so it is clear where it went
                this.showToolbar(1200)
            } else {
                this.root.classList.remove('toolbar-shown')
            }
        }, { signal })
        const trigger = this.shadow.getElementById('toolbar-trigger')!
        on(trigger, 'pointerenter', () => this.showToolbar())
        on(trigger, 'pointerdown', () => this.showToolbar(3000)) // touch: tap at the top edge
        on(this.toolbar, 'pointerenter', () => clearTimeout(this.toolbarHideTimer))
        on(this.toolbar, 'focusin', () => {
            if (this.root.classList.contains('fullscreen')) {
                this.showToolbar()
            }
        })
        on(this.toolbar, 'focusout', () => {
            if (this.root.classList.contains('fullscreen') && !this.toolbar.matches(':hover')) {
                this.toolbarHideTimer = window.setTimeout(() => this.hideToolbar(), 300)
            }
        })
        // hidden when the pointer is clearly below it (not on leaving it: an open zoom list is outside of it)
        on(this.root, 'pointermove', (e) => {
            if (!this.root.classList.contains('toolbar-shown') || !this.root.classList.contains('fullscreen')) {
                return
            }
            const bottom = this.toolbar.getBoundingClientRect().bottom
            if (e.clientY > bottom + 24) {
                clearTimeout(this.toolbarHideTimer)
                this.toolbarHideTimer = window.setTimeout(() => this.hideToolbar(), 300)
            } else if (e.clientY <= bottom) {
                clearTimeout(this.toolbarHideTimer)
            }
        })

        // buttons
        on(btn.open, 'click', () => this.fileInput.click())
        on(btn.open2, 'click', () => this.fileInput.click())
        on(btn.clear, 'click', () => this.closeFile())
        on(btn.prev, 'click', () => this.stepPage(-1))
        on(btn.next, 'click', () => this.stepPage(1))
        on(btn.layoutH, 'click', () => this.setOrientation('horizontal'))
        on(btn.layoutV, 'click', () => this.setOrientation('vertical'))
        on(btn.spread, 'click', () => this.toggleSpread())
        on(this.viewModeSelect, 'change', () => this.setViewMode(this.viewModeSelect.value as ViewerViewMode))
        on(btn.zoomIn, 'click', () => this.zoomStep(1))
        on(btn.zoomOut, 'click', () => this.zoomStep(-1))
        on(this.zoomSelect, 'change', () => {
            const v = this.zoomSelect.value
            if ((FIT_MODES as readonly string[]).includes(v)) {
                this.setFitMode(v as FitMode)
            } else {
                this.zoomAt(Number(v))
            }
            viewport.focus({ preventScroll: true })
        })
        on(btn.print, 'click', () => void this.print())
        on(btn.center, 'click', () => this.centerMeasureOrPage())
        on(btn.fullscreen, 'click', () => this.toggleFullScreen())
        on(btn.help, 'click', () => this.helpDialog.showModal())
        on(this.helpDialog, 'close', () => {
            if (!this.aboutDialog.open) {
                viewport.focus({ preventScroll: true })
            }
        })
        on(this.root.querySelector<HTMLButtonElement>('#about')!, 'click', () => {
            this.helpDialog.close()
            this.aboutDialog.showModal()
        })
        on(this.aboutDialog, 'close', () => viewport.focus({ preventScroll: true }))
        on(btn.play, 'click', () => this.playback?.togglePlay())
        on(btn.rewind, 'click', () => this.playback?.stop())
        on(this.playPosition, 'input', () => this.playback?.seek(Number(this.playPosition.value)))
        on(btn.playalong, 'click', () => this.togglePlayalong())
        on(btn.playalongPrev, 'click', () => this.playalong?.step(-1))
        on(btn.playalongNext, 'click', () => this.playalong?.step(1))
        on(btn.playalongPractice, 'click', () => this.playalong?.togglePractice())
        on(btn.midiSettings, 'click', () => this.midiDialog.showModal())
        on(this.midiOn, 'change', () => this.midi?.setEnabled(this.midiOn.checked))
        on(this.midiDevice, 'change', () => this.midi?.selectDevice(this.midiDevice.value))
        on(this.midiDialog, 'close', () => viewport.focus({ preventScroll: true }))

        // space must not activate the focused toolbar button (it is the hand tool / play)
        for (const b of this.toolbar.querySelectorAll('button')) {
            on(b, 'keyup', (e) => {
                if (e.key === ' ') {
                    e.preventDefault()
                }
            })
        }

        // files: the file dialog and dropping a file
        on(this.fileInput, 'change', () => {
            const f = this.fileInput.files?.[0]
            if (f) {
                this.openFile(f)
            }
            this.fileInput.value = ''
        })
        if (this.m_groups.file) {
            // dragenter/dragleave do not pair up reliably (text nodes, Safari, drags cancelled outside the window), so the
            // highlight lasts as long as dragover keeps firing (every ~50 ms while a drag is over the viewer)
            on(this.root, 'dragover', (e) => {
                e.preventDefault()
                if (e.dataTransfer?.types.includes('Files')) {
                    if (!this.root.classList.contains('dragover')) {
                        this.setDropArea()
                        this.root.classList.add('dragover')
                    }
                    clearTimeout(this.dragTimer)
                    this.dragTimer = window.setTimeout(() => this.endDragOver(), 200)
                }
            })
            on(this.root, 'dragleave', (e) => {
                if (!e.relatedTarget) {
                    this.endDragOver() // left the window
                }
            })
            on(this.root, 'drop', (e) => {
                e.preventDefault()
                this.endDragOver()
                const f = e.dataTransfer?.files[0]
                if (f && !this.isBusy()) {
                    this.openFile(f)
                }
            })
        }
    }
}
