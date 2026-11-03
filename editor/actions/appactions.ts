/*
 * SPDX-License-Identifier: GPL-3.0-only
 * The handlers of the actions the app implements (like MuseScore's ApplicationActionController,
 * ProjectActionsController, NotationActionController), and the app's own actions (the page view toolbar of the
 * web viewer).
 */
import { removeAllScores } from '../db'
import { ICON_CODES } from './uiactiondata'
import type { ViewMode } from '../../src/index'
import {
    centerPage, centerSelectionOrFirstMeasure, goToPage, lastPage, onScoreViewChanged, print, scoreViewState, setFitMode, setOrientation,
    setViewMode, showShortcutsHelp, stepPage, toggleFullscreen, toggleSpread, zoomAt, zoomStep,
} from '../scoreview'
import {
    canSave, chooseFile, closeScore, forgetScore, onSessionChanged, saveCopy, saveScore, saveScoreAs, session, showDialog,
    showNewScoreDialog,
} from '../session'
import { isToolBarVisible, onToolBarLayoutChanged, restoreDefaultLayout, setStatusBarVisible, setToolBarVisible, toolBarLayout } from '../toolbars/layout'
import { currentLanguage } from '../i18n'
import { registerPanelActions } from '../panels/PanelDock'
import { isPanelOpen, onPanelsChanged, togglePanel } from '../panels/panels'
import { canOpenStaffProperties, openStaffProperties } from '../dialogs/EditStaffDialog'
import { openSelectDialog } from '../dialogs/SelectDialog'
import { openTupletDialog } from '../dialogs/TupletDialog'
import { openRealizeChordSymbolsDialog } from '../dialogs/RealizeChordSymbolsDialog'
import { openEditStyleDialog } from '../dialogs/EditStyleDialog'
import { openSelectMeasuresCountDialog } from '../dialogs/SelectMeasuresCountDialog'
import { openPageSettingsDialog } from '../dialogs/PageSettingsDialog'
import { openBreaksDialog } from '../dialogs/BreaksDialog'
import { canCustomizeKit, openCustomizeKitDialog } from '../dialogs/CustomizeKitDialog'
import { loadStyle, saveStyle } from '../stylefiles'
import { showSearchPopup } from '../components/SearchPopup'
import { openProjectPropertiesDialog } from '../dialogs/ProjectPropertiesDialog'
import { openPartsDialog } from '../dialogs/PartsDialog'
import { openExportDialog } from '../dialogs/ExportDialog'
import { AddBoxesTarget, canAddCustomTuplet, hasSelection } from '../../src/index'
import { currentScore } from '../scoreview'
import { actionsChanged, isActionEnabled, registerAction, triggerAction } from './actions'
import { registerNotationActions } from './notationactions'
import { initMidiInput } from '../midi/midicontroller'
import { registerPlaybackActions } from '../playback/playbackcontroller'
import { registerPlayalongActions } from '../playalong/playalongcontroller'
import '../playback/playbackview'
import '../playalong/playalongview'

const scoreShown = (): boolean => scoreViewState().hasScore && session().view === 'score'
const hasScore = (): boolean => !!session().current

function openUrl(url: string): void {
    window.open(url, '_blank', 'noopener')
}

export function registerAppActions(): void {
    // ---- file ----
    registerAction('file-new', { run: () => showNewScoreDialog(true) })
    registerAction('file-open', { run: () => void chooseFile() })
    registerAction('file-close', { run: closeScore, enabled: hasScore })
    // saving: in this browser (IndexedDB), and to the file on the computer the score was opened from or saved to;
    // a copy is saved on the computer (.mscz)
    registerAction('file-save', { run: () => void saveScore(), enabled: canSave })
    registerAction('file-save-as', { run: () => void saveScoreAs(), enabled: canSave })
    registerAction('file-save-a-copy', { run: () => void saveCopy(), enabled: canSave })
    registerAction('clear-recent', { run: () => showDialog('clearRecent') })
    registerAction('print', { run: () => void print(), enabled: scoreShown })
    // ProjectActionsController::exportScore
    registerAction('file-export', { run: openExportDialog, enabled: scoreShown })

    // ---- edit ----
    registerAction('preference-dialog', { run: () => showDialog('preferences') })
    // the editing and note input actions (incl. undo/redo, select all, escape): notationactions.ts
    registerNotationActions()

    // NotationActionController::openStaffProperties
    registerAction('staff-properties', { run: openStaffProperties, enabled: () => scoreShown() && canOpenStaffProperties(), context: 'notation' })
    // NotationActionController::openSelectionMoreOptions (enabled with a selection like C++ hasSelection)
    // the Format menu: NotationActionController::openPageSettingsDialog, openBreaksDialog, loadStyle, saveStyle
    // NotationActionController::openPartsDialog
    registerAction('parts', { run: openPartsDialog, enabled: scoreShown })
    // ProjectActionsController::openProjectProperties
    registerAction('project-properties', { run: openProjectPropertiesDialog, enabled: scoreShown })
    // SearchPopupModel: Find / Go to
    registerAction('find', { run: showSearchPopup, enabled: scoreShown, context: 'notation' })
    registerAction('page-settings', { run: openPageSettingsDialog, enabled: scoreShown, context: 'notation' })
    registerAction('measures-per-system', { run: openBreaksDialog, enabled: scoreShown, context: 'notation' })
    // PaletteActionsController::openCustomizeKitDialog (a drum staff in the context menu or the note input)
    registerAction('customize-kit', {
        run: openCustomizeKitDialog, enabled: () => scoreShown() && canCustomizeKit(currentScore()), context: 'notation',
    })
    registerAction('load-style', { run: () => void loadStyle(), enabled: scoreShown, context: 'notation' })
    registerAction('save-style', { run: () => void saveStyle(), enabled: scoreShown, context: 'notation' })
    // NotationActionController::openRealizeChordSymbolsDialog
    registerAction('realize-chord-symbols', { run: openRealizeChordSymbolsDialog, enabled: scoreShown, context: 'notation' })
    registerAction('edit-style', { run: args => openEditStyleDialog(args?.[0], args?.[1]), enabled: scoreShown, context: 'notation' })
    // NotationActionController::openTupletOtherDialog (enabled with a selected note or rest)
    registerAction('tuplet-dialog', {
        run: openTupletDialog,
        enabled: () => { const s = currentScore(); return !!s && scoreShown() && canAddCustomTuplet(s) },
        context: 'notation',
    })
    // NotationActionController::addMeasures: the number of measures from SelectMeasuresCountDialog
    for (const [code, target, needsSelection] of [
        ['insert-measures', AddBoxesTarget.BeforeSelection, true],
        ['insert-measures-after-selection', AddBoxesTarget.AfterSelection, true],
        ['insert-measures-at-start-of-score', AddBoxesTarget.AtStartOfScore, false],
        ['append-measures', AddBoxesTarget.AtEndOfScore, false],
    ] as const) {
        registerAction(code, {
            run: () => openSelectMeasuresCountDialog(target),
            enabled: () => { const s = currentScore(); return !!s && scoreShown() && (!needsSelection || hasSelection(s)) },
            context: 'notation',
        })
    }
    registerAction('select-dialog', { run: openSelectDialog, enabled: () => scoreShown() && canOpenStaffProperties(), context: 'notation' })

    // ---- tools ----
    // NotationActionController::openTransposeDialog
    registerAction('transpose', { run: () => showDialog('transpose'), enabled: scoreShown, context: 'notation' })
    // ApplicationActionController::doGlobalUndo etc.: the global shortcuts go to the notation when it is shown
    for (const name of ['undo', 'redo', 'delete', 'cancel']) {
        const target = `action://notation/${name}`
        registerAction(`action://${name}`, { run: () => void triggerAction(target), enabled: () => isActionEnabled(target), context: 'notation' })
    }

    // ---- view ----
    registerAction('fullscreen', { run: toggleFullscreen, checked: () => scoreViewState().fullscreen }, { icon: ICON_CODES.SPLIT_OUT_ARROWS })
    registerAction('toggle-noteinput', {
        run: () => setToolBarVisible('noteInputBar', !isToolBarVisible('noteInputBar')),
        checked: () => isToolBarVisible('noteInputBar'),
    })
    registerAction('toggle-transport', {
        run: () => setToolBarVisible('playbackToolBar', !isToolBarVisible('playbackToolBar')),
        checked: () => isToolBarVisible('playbackToolBar'),
    })
    registerAction('toggle-viewtoolbar', {
        run: () => setToolBarVisible('viewToolBar', !isToolBarVisible('viewToolBar')),
        checked: () => isToolBarVisible('viewToolBar'),
    }, { title: [null, 'Page view toolbar'], checkable: true })
    registerAction('toggle-statusbar', {
        run: () => setStatusBarVisible(!toolBarLayout().statusBar),
        checked: () => toolBarLayout().statusBar,
    })
    registerAction('dock-restore-default-layout', { run: restoreDefaultLayout })
    // the panels (ApplicationActionController::toggleDock; enabled with a score: UiCtxProjectOpened)
    for (const [code, panel] of [['toggle-palettes', 'palettesPanel'], ['toggle-instruments', 'instrumentsPanel'], ['inspector', 'inspectorPanel']]) {
        registerAction(code, { run: () => togglePanel(panel), enabled: scoreShown, checked: () => isPanelOpen(panel) })
    }
    registerPanelActions()

    // ---- zoom and pages (MuseScore: NotationActionController) ----
    registerAction('zoomin', { run: () => zoomStep(1), enabled: scoreShown })
    registerAction('zoomout', { run: () => zoomStep(-1), enabled: scoreShown })
    registerAction('zoom100', { run: () => zoomAt(100), enabled: scoreShown })
    registerAction('zoom-page-width', { run: () => setFitMode('page-width'), enabled: scoreShown })
    registerAction('zoom-whole-page', { run: () => setFitMode('whole-page'), enabled: scoreShown })
    registerAction('page-prev', { run: () => stepPage(-1), enabled: () => scoreShown() && scoreViewState().canPrev },
        { title: [null, 'Previous page'], icon: ICON_CODES.CHEVRON_LEFT })
    registerAction('page-next', { run: () => stepPage(1), enabled: () => scoreShown() && scoreViewState().canNext },
        { title: [null, 'Next page'], icon: ICON_CODES.CHEVRON_RIGHT })
    registerAction('page-top', { run: () => goToPage(0), enabled: scoreShown })
    registerAction('page-end', { run: () => goToPage(lastPage()), enabled: scoreShown })

    // ---- view modes (NotationActionController: view-mode-*; the status bar's ViewModeControl) ----
    for (const [code, mode] of VIEW_MODE_ACTIONS) {
        registerAction(code, { run: () => setViewMode(mode), enabled: scoreShown, checked: () => scoreViewState().viewMode === mode }, { checkable: true })
    }
    registerAction('view-mode-fit-width', {
        run: () => setViewMode('fit-width'), enabled: scoreShown, checked: () => scoreViewState().viewMode === 'fit-width',
    }, {
        title: [null, 'Continuous view (fit to window)'],
        description: [null, 'Display continuous view (vertical) as wide as the window, without system and page breaks'],
        icon: ICON_CODES.HORIZONTAL, checkable: true,
    })

    // ---- the page view toolbar of the web viewer ----
    const pageViewShown = (): boolean => scoreShown() && scoreViewState().viewMode === 'page'
    registerAction('view-pages-horizontal', {
        run: () => setOrientation('horizontal'), enabled: pageViewShown, checked: () => scoreViewState().orientation === 'horizontal',
    }, { title: [null, 'Pages side by side'], icon: 0xEF1C, checkable: true })
    registerAction('view-pages-vertical', {
        run: () => setOrientation('vertical'), enabled: pageViewShown, checked: () => scoreViewState().orientation === 'vertical',
    }, { title: [null, 'Pages vertically'], icon: 0xF3AF, checkable: true })
    registerAction('view-two-pages', {
        run: toggleSpread, enabled: () => pageViewShown() && scoreViewState().spreadAvailable, checked: () => scoreViewState().spread,
    }, { title: [null, 'Two pages'], description: [null, 'Two pages (for scores with a two-sided page layout)'], icon: 0xEF7F, checkable: true })
    // the icon is an SVG (ToolBars.tsx)
    registerAction('view-center-page', { run: centerSelectionOrFirstMeasure, enabled: scoreShown },
        { title: [null, 'Center measure'], description: [null, 'Center the selected measure, or the first measure'] })
    registerAction('view-shortcuts-help', { run: showShortcutsHelp }, { title: [null, '?'], description: [null, 'Keyboard shortcuts'] })

    // ---- playback (PlaybackController) ----
    registerPlaybackActions()
    initMidiInput()
    registerPlayalongActions()

    // ---- help (ApplicationActionController) ----
    registerAction('online-handbook', { run: () => openUrl(`https://handbook.musescore.org?tag=handbook&locale=${currentLanguage()}`) })
    registerAction('ask-help', { run: () => openUrl(`https://musescore.org/redirect/post/question?locale=${currentLanguage()}`) })
    registerAction('accessibility-statement', { run: () => openUrl('https://musescore.org/about/musescore-studio-accessibility-statement') })
    registerAction('about-musescore', { run: () => showDialog('about') }, { title: [null, '&About MuseEncore…'] })
    registerAction('revert-factory', { run: () => showDialog('revertFactory') })

    // the states depend on the session, the score view and the toolbars
    onSessionChanged(actionsChanged)
    onScoreViewChanged(actionsChanged)
    onToolBarLayoutChanged(actionsChanged)
    onPanelsChanged(actionsChanged)
}

/** MuseScore's view modes (NotationStatusBarModel ALL_VIEW_MODE_MAP without the developer mode's "Floating") */
export const VIEW_MODE_ACTIONS: readonly (readonly [string, ViewMode])[] = [
    ['view-mode-page', 'page'],
    ['view-mode-continuous', 'continuous-horizontal'],
    ['view-mode-single', 'continuous-vertical'],
]

/** "Clear recent" confirmed: the stored scores are removed (they are the recent list here) */
export async function clearRecentScores(): Promise<void> {
    const cur = session().current
    if (cur?.id) {
        forgetScore(cur.id)
    }
    await removeAllScores()
}
