/*
 * SPDX-License-Identifier: GPL-3.0-only
 * The public types of the MuseEncore Viewer component (applyMuseEncoreViewer). Types only: the package's declaration
 * file is generated from this file.
 */

/** the continuous views of MuseScore's status bar, plus 'window-fit' (systems as wide as the view, not in MuseScore) */
export type ContinuousView = 'horizontal' | 'vertical' | 'window-fit'

/** the groups of the toolbar; each one can be hidden */
export interface MuseEncoreViewerToolbarGroups {
    /** open (button, Ctrl+O, dropping a file), close, file name; default false (the MuseEncore Viewer app shows it) */
    file?: boolean
    /** previous / next page and the page indicator; default true */
    pageNavigation?: boolean
    /** the view mode (page view, continuous views) and the page layout (side by side, vertically, two pages); default true */
    pageView?: boolean
    /** zoom in / out, the zoom levels and fit modes, center measure; default true */
    zoom?: boolean
    /** play / pause, back to the start, the play position (MuseScore's MIDI renderer with MS Basic.sf3); default false */
    playback?: boolean
    /**
     * Playalong: the button that follows the score measure by measure while the user plays, into the microphone (the
     * browser asks for it; the note detection is loaded on the first start) or on a MIDI device, and the MIDI settings;
     * default false
     */
    playalong?: boolean
    /** print (vector pages on sheets of the score's page size); default true */
    print?: boolean
    /** full screen; default true */
    fullScreen?: boolean
}

export interface MuseEncoreViewerOptions {
    /**
     * the page (1-based) that is fitted into the view ("Whole page") and centered after loading; default 1.
     * false: the zoom of `zoom` (default 100%) at the start of the score
     */
    centerAndResizeToPage?: number | false
    /** the initial zoom: a percentage or a fit mode; default 'whole-page' (or 100 with centerAndResizeToPage: false) */
    zoom?: number | 'whole-page' | 'page-width'
    /** the initial view: false (default) is the page view */
    continuousView?: ContinuousView | false
    /** the pages of the page view side by side (default) or below each other */
    pageOrientation?: 'horizontal' | 'vertical'
    /** facing pages (only for scores with a two-sided page layout); default false */
    twoPages?: boolean
    /** the toolbar groups to show */
    toolbarGroups?: MuseEncoreViewerToolbarGroups
    /**
     * MuseScore's keyboard shortcuts (zoom, pages, print, full screen, Space: play; Space + drag also moves the view)
     * while the viewer has the focus, and the "?" button with their list; default false
     */
    keyboardShortcuts?: boolean
    /** no toolbar at all; default false */
    disableToolbar?: boolean
    /** the status bar below the score (loading, number of pages, errors); default false */
    showStatusBar?: boolean
    /** the color scheme of the controls; default 'auto' (the browser's), as is any other value */
    colorScheme?: 'auto' | 'light' | 'dark'
    /**
     * the URL of the directory with the fonts (Leland, Bravura, ... and the chord/style files of the package's
     * fonts/ directory); default: the package's fonts/ directory next to dist/
     */
    fontsUrl?: string
    /** the URL of MuseScore's soundfont "MS Basic.sf3" (51 MB, loaded on the first playback and cached); default: MuseScore's repository */
    soundFontUrl?: string
    /**
     * the URL of the directory with basic-pitch/ (the model of the playalong's note detection, 900 kB, loaded on the
     * first start); default: the package's directory
     */
    noteDetectionUrl?: string
    /** called when a score is shown */
    onLoad?: (info: MuseEncoreScoreInfo) => void
    /** called when a score could not be loaded */
    onError?: (error: Error) => void
}

export interface MuseEncoreScoreInfo {
    /** the file name (from the URL or the file) */
    fileName: string
    /** the score's title (the title frame or the meta tag "workTitle") */
    title: string
    /** the pages of the page view */
    pageCount: number
}

/** the score's source: a URL, the file's data or a File/Blob */
export type MuseEncoreScoreSource = string | URL | ArrayBuffer | Uint8Array | Blob

/** the view state the viewer app keeps between sessions */
export interface MuseEncoreViewSettings {
    /** a percentage ("100") or a fit mode ("page-width", "whole-page") */
    zoom: string
    orientation: 'horizontal' | 'vertical'
    spread: boolean
    viewMode: 'page' | 'continuous-horizontal' | 'continuous-vertical' | 'fit-width'
}

export interface MuseEncoreViewer {
    /** the element the viewer was created in */
    readonly element: HTMLElement
    /** resolves when the first score is shown (rejects if it could not be loaded) */
    readonly ready: Promise<MuseEncoreScoreInfo>
    /** opens another score */
    load(source: MuseEncoreScoreSource, fileName?: string): Promise<MuseEncoreScoreInfo>
    /** the number of pages (0 without a score) */
    pageCount(): number
    /** the page (1-based) shown now */
    currentPage(): number
    /** scrolls to a page (1-based) */
    goToPage(page: number): void
    /** fits the page (1-based) into the view and centers it */
    centerAndResizeToPage(page: number): void
    /** a percentage or a fit mode */
    setZoom(zoom: number | 'whole-page' | 'page-width'): void
    setContinuousView(view: ContinuousView | false): void
    /** starts the playback (loads the sounds on the first call; call it from a user gesture) */
    play(): Promise<void>
    pause(): void
    /** stops and goes back to the start */
    stop(): void
    isPlaying(): boolean
    print(): Promise<void>
    toggleFullScreen(): void
    /** removes the viewer from the page */
    destroy(): void
}
