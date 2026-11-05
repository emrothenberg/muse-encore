/*
 * SPDX-License-Identifier: GPL-3.0-only
 * The MuseEncore Viewer app: the viewer component in the whole window, with opening files (file dialog, drop, ?url=),
 * the last opened file and the view settings kept between sessions, the playback, MuseScore's keyboard shortcuts.
 */
/// <reference types="vite/client" />
import { scoreBaseName } from '../src/index'
import { appSoundFontUrl } from '../shared/playback/soundfont'
import { MuseEncoreViewer } from './src/museencoreviewer'
import { clearLastFile, loadLastFile, loadSettings, saveLastFile, saveSettings } from './storage'

const APP_TITLE = 'MuseEncore Viewer'
const app = document.getElementById('app')!
let restoring = false // the last file is opened again: it is not stored again

const viewer = new MuseEncoreViewer(app, null, {
    appTitle: APP_TITLE,
    fontsUrl: import.meta.env.BASE_URL,
    soundFontUrl: appSoundFontUrl(import.meta.env.BASE_URL),
    noteDetectionUrl: import.meta.env.BASE_URL,
    toolbarGroups: { file: true, pageNavigation: true, pageView: true, zoom: true, playback: true, playalong: true, print: true, fullScreen: true },
    keyboardShortcuts: true,
    showStatusBar: true,
    autoFocus: true,
    viewSettings: loadSettings({ zoom: 'whole-page', orientation: 'horizontal', spread: false, viewMode: 'page' }),
    onViewSettingsChange: saveSettings,
    onFileOpened: (name, data) => {
        if (!restoring) {
            void saveLastFile({ name, data })
        }
    },
    onFileClosed: () => {
        void clearLastFile()
        document.title = APP_TITLE
    },
    onLoad: (info) => {
        // like MuseScore's tab: the file name without extension
        document.title = `${scoreBaseName(info.fileName)} – ${APP_TITLE}`
    },
})

// the shortcuts work wherever the focus is (keys typed in the viewer are handled by it)
document.addEventListener('keydown', (e) => {
    if (!e.composedPath().includes(viewer.host)) {
        viewer.handleKeyDown(e)
    }
})
document.addEventListener('keyup', (e) => {
    if (!e.composedPath().includes(viewer.host)) {
        viewer.handleKeyUp(e)
    }
})
// a file dropped next to the viewer must not be opened by the browser
document.addEventListener('dragover', e => e.preventDefault())
document.addEventListener('drop', e => e.preventDefault())

// printing from the browser's menu: every page as vector graphics (SVG) on a sheet of the score's page size
const printPagesDiv = document.getElementById('print-pages')!
const pageStyle = document.createElement('style')
document.head.appendChild(pageStyle)
window.addEventListener('beforeprint', () => {
    if (printPagesDiv.childElementCount) {
        return
    }
    const { css, html } = viewer.printPages()
    pageStyle.textContent = css
    printPagesDiv.innerHTML = html
})
window.addEventListener('afterprint', () => {
    printPagesDiv.replaceChildren()
    pageStyle.textContent = ''
})

// startup: ?url=<score url>, otherwise the last opened file
const initialUrl = new URLSearchParams(location.search).get('url')
if (initialUrl) {
    void viewer.load(initialUrl).catch(() => {})
} else {
    void loadLastFile().then(f => {
        if (f) {
            restoring = true
            void viewer.load(f.data, f.name).catch(() => {}).finally(() => { restoring = false })
        }
    })
}
