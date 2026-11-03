/*
 * SPDX-License-Identifier: GPL-3.0-only
 * The app's state and commands: which view is shown (home screen or score), the open score, opening files and
 * stored scores, creating new scores, saving (ProjectActionsController). The React components read the state with
 * useSession().
 */
import { useSyncExternalStore } from 'react'
import {
    createScore, drawPage, endTextEditing, isModified, EngravingErr, importSuffixes, layoutScore, isMuseScoreFile, NotationReadError, type NotationReaderInteractive, markSaved, openFileAccept, openScoreFile, markUnsaved, MigrationOptions, MigrationType, pageCount,
    pageFormatSize, pageSize, saveMscz, scoreAppVersion, scoreMigrationType, scoreTitle, withPageView, type MasterScore, type NewScoreOptions,
} from '../src/index'
import {
    addScore, autosaveIds, contentHash, countScores, loadAutosave, loadScoreContent, MAX_SCORES, openScoreId, removeAutosave, removeScore,
    saveScoreContent, scoreIdsWithHash, scoreName, scoresLeastRecentFirst, scoresWithUnsavedChanges, separateFromFile, setOpenScoreId,
    takeLegacyLastFile, updateScore, type ScoreEntry,
} from './db'
import { baseName, isMsczName, msczFileName, pickFileToOpen, saveToComputer, writeFile, type FilePickerType } from './files'
import { showMessage } from './components/MessageBox'
import { arg, qtrc, webtr } from './i18n'
import {
    clearScore, currentMasterScore, currentScore, fontsReady, handlers, hideBusy, resumeBusy, scoreChanged, scoreSaved, setScoreName, setStatus, showBusy,
    showScore, viewShown,
} from './scoreview'
import { settings, updateSettings, type StoredMigrationOptions } from './settings'
import { holdOpenScore, scoresOpenElsewhere } from './tabs'

export interface CurrentScore {
    /** the id of its stored entry; null if it could not be stored */
    id: string | null
    /** the file name with extension; for a new score its title */
    name: string
    /** never saved (NotationProject::isNewlyCreated): "Save" asks for a name like "Save as" */
    newlyCreated: boolean
    /** the file on the computer it was opened from or saved to: "Save" writes it back too */
    handle?: FileSystemFileHandle
}

export type SaveChangesAnswer = 'save' | 'dontSave' | 'cancel'

/** the answer of the Save as dialog: the name, and whether the file is also saved on the computer */
export interface SaveAsAnswer {
    name: string
    toComputer: boolean
}

export interface SessionState {
    view: 'home' | 'score'
    /** the open score */
    current: CurrentScore | null
    newScoreDialog: boolean
    /** another dialog of the app; the questions (saveChanges, saveAs, restoreSession, migration, removeScore) are answered with answerDialog() */
    dialog: 'preferences' | 'about' | 'transpose' | 'clearRecent' | 'revertFactory' | 'saveChanges' | 'saveAs' | 'restoreSession' | 'migration' | 'removeScore' | null
    /** the name proposed by the Save as dialog */
    saveAsName: string
    /** the name of the score the restore dialog is about */
    restoreName: string
    /** the scores the "Too many scores" dialog offers for deleting, the first one is proposed */
    removableScores: ScoreEntry[]
    /** the last error, shown on the home screen */
    error: string | null
    /** the question of the migration dialog (answered with the chosen options, or null if it was closed) */
    migration: MigrationQuestion | null
    /** the number of the shown question (the key of its dialog: a question asked again gets a new dialog) */
    question: number
}

/** the parameters of MuseScore's migration dialog (ProjectMigrator::askAboutMigration) */
export interface MigrationQuestion {
    appVersion: string
    migrationType: MigrationType.Pre_3_6 | MigrationType.Ver_3_6
    options: StoredMigrationOptions
}

let state: SessionState = {
    view: 'home', current: null, newScoreDialog: false, dialog: null, saveAsName: '', restoreName: '', removableScores: [], error: null, migration: null, question: 0,
}
const listeners = new Set<() => void>()

function setState(patch: Partial<SessionState>): void {
    state = { ...state, ...patch }
    document.body.dataset.view = state.view
    for (const l of listeners) {
        l()
    }
}

export function onSessionChanged(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

export function useSession(): SessionState {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l)
            return () => listeners.delete(l)
        },
        () => state,
    )
}

export function setView(view: 'home' | 'score'): void {
    if (view === 'score' && !state.current) {
        return
    }
    setState({ view })
    if (view === 'score') {
        viewShown()
    }
}

export function dismissError(): void {
    setState({ error: null })
}

export function showNewScoreDialog(open: boolean): void {
    setState({ newScoreDialog: open })
}

export function showDialog(dialog: SessionState['dialog']): void {
    setState({ dialog })
}

export function session(): SessionState {
    return state
}

// the questions (IInteractive::question etc.): a dialog whose answer resolves a promise
let answerQuestion: ((answer: unknown) => void) | null = null

function ask<T>(dialog: 'saveChanges' | 'saveAs' | 'restoreSession' | 'migration' | 'removeScore', patch: Partial<SessionState> = {}): Promise<T> {
    answerQuestion?.(undefined)
    return new Promise<T>((resolve) => {
        answerQuestion = resolve as (answer: unknown) => void
        setState({ ...patch, dialog, question: state.question + 1 })
    })
}

/**
 * the answer of the shown question (the dialogs call it when they are closed). `question`: the number of the question
 * the dialog was shown for; the close event of a dialog comes a task after it was closed, when the same question may
 * already be asked again (e.g. Escape and Ctrl+S at once), so the answer of an older dialog is ignored.
 */
export function answerDialog(answer: unknown, question = state.question): void {
    if (question !== state.question) {
        return
    }
    const resolve = answerQuestion
    answerQuestion = null
    showDialog(null)
    resolve?.(answer)
}

// ---------------------------------------------------------------------------------
//   opening and creating scores
// ---------------------------------------------------------------------------------

const UNTITLED = 'Untitled score' // NotationProject::scoreDefaultTitle

/** what the home screen shows of a score: its page view (also when it is shown in a continuous view) */
interface PageViewInfo {
    pages: number
    /** a small picture of the first page (like MuseScore's thumbnail) */
    thumbnail: Promise<Blob | undefined>
}

/**
 * Taken when a score is loaded (in the page view, before the view switches to its view mode) and when it is saved;
 * otherwise the score is laid out as pages for it and back again (like printing).
 */
const s_pageViewInfo = new WeakMap<MasterScore, PageViewInfo>()

function pageViewInfo(score: MasterScore): PageViewInfo {
    let info = s_pageViewInfo.get(score)
    if (!info) {
        info = withPageView(score, () => ({ pages: pageCount(score), thumbnail: drawThumbnail(score) }))
        s_pageViewInfo.set(score, info)
    }
    return info
}

function drawThumbnail(score: MasterScore): Promise<Blob | undefined> {
    const size = pageSize(score, 0)
    const width = 360
    const c = document.createElement('canvas')
    c.width = width
    c.height = Math.round(size.height * width / size.width)
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, c.width, c.height)
    drawPage(score, 0, ctx, { dpi: width / size.width })
    return new Promise(resolve => c.toBlob(b => resolve(b ?? undefined), 'image/webp', 0.85))
}

function makeThumbnail(score: MasterScore): Promise<Blob | undefined> {
    return pageViewInfo(score).thumbnail
}

/** `aspect` is the one of the page format (also in the continuous views, which have one long page) */
function entryInfo(score: MasterScore): Pick<ScoreEntry, 'title' | 'composer' | 'pages' | 'aspect'> {
    const size = pageFormatSize(score)
    return {
        title: scoreTitle(score),
        composer: score.metaTag('composer') || '',
        pages: pageViewInfo(score).pages,
        aspect: size.width / size.height,
    }
}

/** opening the score was cancelled (the migration dialog was closed) */
class OpenCancelled extends Error {}

/** the time the questions asked while loading were open (not part of the layout time) */
let s_questionTime = 0

/**
 * Shows the busy overlay, makes and lays out the score (synchronously, so the overlay is painted first; make() only
 * waits for questions) and shows it. Returns null (with the error shown) if it fails or is cancelled.
 */
async function load(name: string, make: () => MasterScore | Promise<MasterScore>): Promise<MasterScore | null> {
    await showBusy(`Opening ${name}`, 'Loading fonts…')
    try {
        await fontsReady
        setStatus(`Loading ${name}…`)
        await showBusy(`Opening ${name}`, 'Laying out the score…')
        s_questionTime = 0
        const t0 = performance.now()
        const s = await make()
        const t1 = performance.now() - s_questionTime
        s_pageViewInfo.delete(s)
        pageViewInfo(s)
        showScore(s, name)
        const pages = pageViewInfo(s).pages
        setStatus(`${name} · ${pages} ${pages === 1 ? 'page' : 'pages'} · layout ${Math.round(t1 - t0)} ms`)
        return s
    } catch (e) {
        if (e instanceof OpenCancelled) {
            setStatus('')
            return null
        }
        console.error(e)
        const msg = `Could not open ${name}: ${(e as Error).message}`
        setStatus(msg, true)
        hideBusy()
        await warnProjectCannotBeOpened(e, name)
        return null
    } finally {
        hideBusy()
    }
}

/**
 * ProjectActionsController::warnProjectCannotBeOpened: "Cannot read file …" with the text of the error; nothing for an
 * error that was shown already (IgnoreError)
 */
async function warnProjectCannotBeOpened(e: unknown, name: string): Promise<void> {
    if (e instanceof NotationReadError && e.code === EngravingErr.IgnoreError) {
        return
    }
    const title = arg(qtrc('project', 'Cannot read file %1'), name)
    const text = e instanceof Error && e.message ? e.message : qtrc('project', 'An error occurred while reading this file.')
    await showMessage(title, text)
}

/** shows the score that was just loaded at once; it is stored meanwhile (store() returns its id) */
async function opened(score: Omit<CurrentScore, 'id'>, store: () => Promise<string | null>): Promise<string | null> {
    const current: CurrentScore = { ...score, id: null }
    setState({ current, error: null })
    setView('score')
    const id = await store()
    setOpenScoreId(id)
    if (state.current === current) {
        setState({ current: { ...current, id } })
    }
    return id
}

/**
 * the questions and warnings of an import (IInteractive): message boxes; the busy overlay is hidden meanwhile and the
 * time they are open is not part of the layout time
 */
const importInteractive: NotationReaderInteractive = {
    question: (title, text) => whileBusyHidden(async () => await showMessage(title, text, ['no', 'yes']) === 'yes'),
    warning: (title, text) => whileBusyHidden(async () => { await showMessage(title, text) }),
}

async function whileBusyHidden<T>(question: () => Promise<T>): Promise<T> {
    const t0 = performance.now()
    hideBusy()
    try {
        return await question()
    } finally {
        await resumeBusy()
        s_questionTime += performance.now() - t0
    }
}

/**
 * a MuseScore file (loadScore) or a file of an import format (importScore with the import style of the settings,
 * NotationProject::doImport), by the suffix of its name
 */
async function loadFileData(data: ArrayBuffer, name: string): Promise<MasterScore> {
    const s = await openScoreFile(data, name, { interactive: importInteractive, style: settings().import.styleFile?.content ?? null })
    const migration = await migrationOptions(s)
    layoutScore(s, { migration, templateFile })
    return s
}

// ---------------------------------------------------------------------------------
//   the migration of scores of MuseScore 3 and older (ProjectMigrator)
// ---------------------------------------------------------------------------------

// MdlMigrator: the drumsets of share/templates (C++ globalConfiguration()->appDataPath() + "templates/")
const DRUMSETS = import.meta.glob<string>('../MuseScore/share/templates/*.drm', { query: '?raw', import: 'default', eager: true })

function templateFile(name: string): string | null {
    return DRUMSETS[`../MuseScore/share/templates/${name}`] ?? null
}

/**
 * ProjectMigrator::migrateEngravingProjectIfNeed: the options of the migration of a score of an older version, from
 * the settings or, unless "Don't ask again" was chosen, from the migration dialog (then stored). null: no migration
 * needed. Closing the dialog cancels opening the score (OpenCancelled).
 */
async function migrationOptions(score: MasterScore): Promise<MigrationOptions | null> {
    const migrationType = scoreMigrationType(score)
    if (migrationType === MigrationType.Unknown) {
        return null
    }
    // ProjectConfiguration::migrationOptions: the stored ones or the defaults
    let options = settings().project.migration[migrationType] ?? { ...new MigrationOptions() }
    if (options.isAskAgain) {
        const answer = await askAboutMigration(options, scoreAppVersion(score), migrationType)
        if (!answer) {
            throw new OpenCancelled()
        }
        options = answer
        updateSettings('project', { migration: { ...settings().project.migration, [migrationType]: options } })
    }
    return MigrationOptions.from(options)
}

async function askAboutMigration(options: StoredMigrationOptions, appVersion: string,
    migrationType: MigrationType.Pre_3_6 | MigrationType.Ver_3_6): Promise<StoredMigrationOptions | null> {
    const t0 = performance.now()
    hideBusy()
    const answer = await ask<StoredMigrationOptions | null>('migration', { migration: { appVersion, migrationType, options } })
    setState({ migration: null })
    if (answer) {
        await resumeBusy()
    }
    s_questionTime += performance.now() - t0
    return answer
}

/** a score that was not saved yet (a new score, a restored autosave) is modified from the start */
function unsaved(s: MasterScore): MasterScore {
    markUnsaved(s)
    return s
}

/**
 * For one more stored score (`MAX_SCORES` are stored): the user chooses a score to delete; the open score and scores
 * open in other tabs are not offered. false if cancelled.
 */
async function ensureRoomForScore(): Promise<boolean> {
    while (await countScores() >= MAX_SCORES) {
        const elsewhere = await scoresOpenElsewhere()
        const removableScores = (await scoresLeastRecentFirst()).filter(e => e.id !== state.current?.id && !elsewhere.has(e.id))
        if (!removableScores.length) {
            return true
        }
        const id = await ask<string | null | undefined>('removeScore', { removableScores })
        setState({ removableScores: [] })
        if (!id) {
            return false
        }
        await removeScore(id)
    }
    return true
}

/** the score of the file has a name that tells it apart from the file opened again */
function nameWithUnsavedChanges(name: string): string {
    const suffix = /\.[^.]+$/.exec(name)?.[0] ?? ''
    return arg(webtr('%1 (unsaved changes)'), name.slice(0, name.length - suffix.length)) + suffix
}

/** the score is already open in another tab: asks whether to open it here as well */
async function confirmOpenedElsewhere(ids: readonly string[]): Promise<boolean> {
    const id = ids.find(i => i !== state.current?.id)
    const elsewhere = await scoresOpenElsewhere()
    if (!id || !ids.some(i => elsewhere.has(i))) {
        return true
    }
    if (await showMessage(webtr('This score is already open in another tab. Do you want to open it here as well?'), TABS_DO_NOT_SHARE(), ['no', 'yes']) !== 'yes') {
        return false
    }
    s_warnedOpenElsewhere = id
    return true
}

export async function openFileData(name: string, data: ArrayBuffer, source: 'file' | 'url', url?: string, handle?: FileSystemFileHandle): Promise<void> {
    const hash = await contentHash(data)
    const sameFile = hash ? await scoreIdsWithHash(hash) : []
    if (!(await confirmOpenedElsewhere(sameFile))) {
        return
    }
    if (!(await closeOpenedScore())) {
        return
    }
    const s = await load(name, () => loadFileData(data, name))
    if (!s) {
        return
    }
    // a score of this file with unsaved changes stays as a separate score with its autosave (unless these changes are
    // being made in another tab); the file opens as its own score
    const elsewhere = await scoresOpenElsewhere()
    const unsavedChanges = (await scoresWithUnsavedChanges(sameFile)).filter(id => !elsewhere.has(id))
    if (sameFile.every(id => unsavedChanges.includes(id)) && !(await ensureRoomForScore())) {
        clearScore()
        setStatus('')
        return
    }
    let keptAs: string | null = null
    for (const id of unsavedChanges) {
        keptAs = await separateFromFile(id, nameWithUnsavedChanges) ?? keptAs
    }
    // an imported score is saved as a new MuseScore file (NotationProject::doImport: m_isNewlyCreated)
    const id = await opened({ name, newlyCreated: !isMuseScoreFile(name), handle }, async () => addScore(
        { name, source, url, hash, size: data.byteLength, handle, ...entryInfo(s) },
        { data },
    ))
    if (id) {
        // an autosave older than the file's saved version is not restored by anything (see openStored)
        if (!elsewhere.has(id)) {
            await removeAutosave(id)
        }
        void makeThumbnail(s).then(thumbnail => updateScore(id, { thumbnail }))
    }
    if (keptAs) {
        setStatus(arg(webtr('Your unsaved changes to this score were kept as a separate score: %1'), baseName(keptAs)))
    }
}

export async function openFile(file: File, handle?: FileSystemFileHandle): Promise<void> {
    await openFileData(file.name, await file.arrayBuffer(), 'file', undefined, handle)
}

export async function openUrl(url: string): Promise<void> {
    if (!(await closeOpenedScore())) {
        return
    }
    const name = decodeURIComponent(url.split('/').pop()?.split('?')[0] || 'score.mscz')
    await showBusy(`Opening ${name}`, 'Downloading…')
    try {
        const res = await fetch(url)
        if (!res.ok) {
            throw new Error(`${res.status} ${res.statusText}`)
        }
        await openFileData(name, await res.arrayBuffer(), 'url', url)
    } catch (e) {
        hideBusy()
        const msg = `Could not load ${url}: ${(e as Error).message}`
        setStatus(msg, true)
        setState({ error: msg })
    }
}

/**
 * Opens a score of the home screen; false if it is not stored (any more). Like ProjectActionsController::loadProject,
 * an autosave of the score is opened instead of the saved version (the score is then modified).
 */
export async function openStored(id: string): Promise<boolean> {
    if (state.current?.id === id) {
        setView('score')
        return true
    }
    const stored = await loadScoreContent(id)
    if (!stored) {
        return false
    }
    if (!(await confirmOpenedElsewhere([id]))) {
        return true
    }
    if (!(await closeOpenedScore())) {
        return true
    }
    const { entry, content } = stored
    let autosave = await loadAutosave(id)
    if (autosave && autosave.time < entry.modified) {
        // older than the saved score (should not happen: saving removes it)
        await removeAutosave(id)
        autosave = null
    }
    // a new score that was never saved is stored as the options it was created with, an imported one as its file
    const newlyCreated = !('data' in content) || !isMuseScoreFile(entry.name)
    const s = await load(entry.name, async () => {
        if (autosave) {
            return unsaved(await loadFileData(autosave.data, msczFileName(entry.name)))
        }
        return 'data' in content ? loadFileData(content.data, entry.name) : unsaved(createScore(content.options))
    })
    if (!s) {
        return true
    }
    await opened({ name: entry.name, newlyCreated, handle: entry.handle }, async () => {
        await updateScore(id, { opened: Date.now(), ...entryInfo(s) })
        return id
    })
    if (!entry.thumbnail) {
        void makeThumbnail(s).then(thumbnail => updateScore(id, { thumbnail }))
    }
    return true
}

export async function createNewScore(options: NewScoreOptions): Promise<void> {
    const name = options.title?.trim() || UNTITLED
    showNewScoreDialog(false)
    if (!(await closeOpenedScore())) {
        return
    }
    // a new score is unsaved (NotationProject::markAsNewlyCreated)
    const s = await load(name, () => unsaved(createScore(options)))
    if (!s) {
        return
    }
    if (!(await ensureRoomForScore())) {
        clearScore()
        setStatus('')
        return
    }
    const id = await opened({ name, newlyCreated: true }, () => addScore({ name, source: 'new', size: 0, ...entryInfo(s) }, { options }))
    if (id) {
        void makeThumbnail(s).then(thumbnail => updateScore(id, { thumbnail }))
    }
}

// ---------------------------------------------------------------------------------
//   saving (ProjectActionsController): "Save" stores the score in this browser (and writes the file back if it was
//   opened from or saved to a file of the computer), "Save as" asks for a name and stores it as a new score,
//   "Save a copy" saves a file on the computer
// ---------------------------------------------------------------------------------

export function canSave(): boolean {
    return !!state.current && !!currentMasterScore()
}

/** ProjectActionsController::saveProjectAt: an edited text is ended first */
function endEditing(_s: MasterScore): void {
    const s = currentScore() // the text is edited in the current notation (a part or the score)
    if (s && endTextEditing(s)) {
        scoreChanged(false)
    }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** the score was saved under this id (and name): the open score refers to it, it is not modified any more */
function saved(s: MasterScore, current: CurrentScore, where: string): void {
    setOpenScoreId(current.id)
    setState({ current })
    setScoreName(current.name)
    markSaved(s)
    scoreSaved()
    if (current.id) {
        void removeAutosave(current.id)
        const id = current.id
        void makeThumbnail(s).then(thumbnail => updateScore(id, { thumbnail }))
    }
    setStatus(`${baseName(current.name)} saved ${where}`)
}

/**
 * File > Save (ProjectActionsController::saveProject(SaveMode::Save)): a score that was never saved goes through
 * "Save as"; otherwise it is stored in this browser (a new entry if it is not stored any more) and written back to
 * its file on the computer if there is one.
 */
export async function saveScore(): Promise<boolean> {
    const s = currentMasterScore()
    const current = state.current
    if (!s || !current) {
        return false
    }
    if (current.newlyCreated) {
        return saveScoreAs()
    }
    endEditing(s)
    const bytes = saveMscz(s, msczFileName(current.name))
    // first the file (the permission request needs the user's key press or click)
    let where = 'in this browser'
    if (current.handle && isMsczName(current.handle.name)) {
        if (await writeFile(current.handle, bytes)) {
            where = `in this browser and to ${current.handle.name}`
        } else {
            setStatus(`Could not write ${current.handle.name}`, true)
        }
    }
    const data = toArrayBuffer(bytes)
    s_pageViewInfo.delete(s) // the score was edited since
    const info = { size: data.byteLength, hash: await contentHash(data), ...entryInfo(s) }
    let id = current.id
    if (!id || !(await saveScoreContent(id, data, info))) {
        if (!(await ensureRoomForScore())) {
            return false
        }
        id = await addScore({ name: current.name, source: 'file', handle: current.handle, ...info }, { data }, true)
        if (!id) {
            setStatus(`Could not save ${current.name}: the browser does not store data for this page`, true)
            return false
        }
    }
    saved(s, { ...current, id }, where)
    return true
}

/** File > Save as: asks for the name (and whether to save to the computer, too) and saves the score as a new score */
export async function saveScoreAs(): Promise<boolean> {
    const current = state.current
    if (!currentMasterScore() || !current) {
        return false
    }
    // ProjectConfiguration::defaultSavingFilePath: the title of a new score, otherwise the file name
    const answer = await ask<SaveAsAnswer | null>('saveAs', { saveAsName: baseName(current.name) })
    if (!answer?.name.trim()) {
        return false
    }
    try {
        return await saveAs(answer.name, answer.toComputer)
    } catch (e) {
        console.error(e)
        setStatus(`Could not save the score: ${(e as Error).message}`, true)
        return false
    }
}

async function saveAs(name: string, toComputer: boolean): Promise<boolean> {
    const s = currentMasterScore()
    const current = state.current
    if (!s || !current) {
        return false
    }
    const fileName = msczFileName(name)
    endEditing(s)
    const bytes = saveMscz(s, fileName)
    let handle: FileSystemFileHandle | undefined
    let where = 'in this browser'
    if (toComputer) {
        const file = await saveToComputer(bytes, fileName)
        if (!file) {
            return false // cancelled
        }
        handle = file.handle
        where = `in this browser and to ${handle?.name ?? 'the downloads'}`
    }
    const data = toArrayBuffer(bytes)
    s_pageViewInfo.delete(s) // the score was edited since
    const info = { size: data.byteLength, hash: await contentHash(data), ...entryInfo(s) }
    let id: string | null = null
    if (current.newlyCreated && current.id) {
        // the entry of a new score becomes the saved score (MuseScore removes the new score's temporary file)
        if (await saveScoreContent(current.id, data, { name: fileName, handle, ...info })) {
            id = current.id
        }
    }
    const room = id !== null || await ensureRoomForScore()
    if (!id && room) {
        id = await addScore({ name: fileName, source: current.newlyCreated ? 'new' : 'file', handle, ...info }, { data }, true)
    }
    if (!room && !toComputer) {
        return false
    }
    if (!id) {
        if (!toComputer) {
            setStatus(`Could not save ${fileName}: the browser does not store data for this page`, true)
            return false
        }
        // saved on the computer only
        saved(s, { id: null, name: fileName, newlyCreated: false, handle }, `to ${handle?.name ?? 'the downloads'}`)
        return true
    }
    saved(s, { id, name: fileName, newlyCreated: false, handle }, where)
    return true
}

/** File > Save a copy: saves the score on the computer (OpenSaveProjectScenario::askLocalPath: "<name> - copy") */
export async function saveCopy(): Promise<void> {
    const s = currentMasterScore()
    if (!s || !state.current) {
        return
    }
    const fileName = msczFileName(state.current.name, ` - ${qtrc('project/save', 'copy', 'a copy of a file')}`)
    endEditing(s)
    try {
        await saveToComputer(saveMscz(s, fileName), fileName)
    } catch (e) {
        setStatus(`Could not save ${fileName}: ${(e as Error).message}`, true)
    }
}

// ---------------------------------------------------------------------------------
//   closing
// ---------------------------------------------------------------------------------

/** the title of the question before closing a modified score (ProjectActionsController::askAboutSavingScore) */
export function saveChangesTitle(): string {
    return arg(qtrc('project', 'Do you want to save changes to the score “%1” before closing?'), baseName(state.current?.name ?? UNTITLED))
}

/**
 * ProjectActionsController::closeOpenedProject: asks before a modified score is closed (Save / Don't save / Cancel);
 * false if it stays open
 */
async function closeOpenedScore(goToHome = false): Promise<boolean> {
    if (!state.current) {
        return true
    }
    const s = currentMasterScore()
    if (s && isModified(s)) {
        const answer = await ask<SaveChangesAnswer | undefined>('saveChanges')
        if (!answer || answer === 'cancel' || (answer === 'save' && !(await saveScore()))) {
            return false
        }
    }
    clearScore()
    setOpenScoreId(null)
    // the autosave of a score closed without saving is removed by the autosaver (ProjectAutoSaver::update)
    setState({ current: null })
    if (goToHome) {
        setView('home')
    }
    return true
}

/** File > Close; asks first if the score has unsaved changes */
export function closeScore(): void {
    void closeOpenedScore(true)
}

/** the stored score was removed from the list: if it is open, it stays open but is not stored any more */
export function forgetScore(id: string): void {
    if (state.current?.id === id) {
        setOpenScoreId(null)
        setState({ current: { ...state.current, id: null } })
    }
}

// ---------------------------------------------------------------------------------
//   the file chooser
// ---------------------------------------------------------------------------------

const fileInput = document.createElement('input')
fileInput.type = 'file'
fileInput.accept = openFileAccept()
fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0]
    if (f) {
        void openFile(f)
    }
    fileInput.value = ''
})

/** the file types of File > Open (ProjectActionsController::selectScoreOpeningFile) that are supported */
function openFileTypes(): FilePickerType[] {
    const supported = new Set(['mscz', 'mscx', ...importSuffixes()])
    const type = (description: string, suffixes: string[]): FilePickerType => (
        { description, accept: { 'application/octet-stream': suffixes.filter(s => supported.has(s)).map(s => '.' + s) } })
    const types = [
        type(qtrc('project', 'All supported files'), [...supported]),
        type(qtrc('project', 'MuseScore files'), ['mscz']),
        type(qtrc('project', 'MusicXML files'), ['mxl', 'musicxml', 'xml']),
        type(qtrc('project', 'MIDI files'), ['mid', 'midi', 'kar']),
        type(qtrc('project', 'Capella files'), ['cap', 'capx']),
        type(qtrc('project', 'Guitar Pro files'), ['gtp', 'gp3', 'gp4', 'gp5', 'gpx', 'gp']),
        type(qtrc('project', 'Power Tab Editor files (experimental)'), ['ptb']),
        type(qtrc('project', 'Uncompressed MuseScore folders (experimental)'), ['mscx']),
    ]
    return types.filter(t => Object.values(t.accept)[0].length)
}

/** File > Open: with the File System Access API the file can be written back by "Save" */
export async function chooseFile(): Promise<void> {
    const picked = await pickFileToOpen(openFileTypes())
    if (picked === null) {
        fileInput.click()
    } else if (picked !== 'cancel') {
        await openFile(picked.file, picked.handle)
    }
}

handlers.openFile = (f) => void openFile(f)

// unsaved changes: the browser asks before the page is left
window.addEventListener('beforeunload', (e) => {
    const s = currentMasterScore()
    if (s && isModified(s)) {
        e.preventDefault()
    }
})

// ---------------------------------------------------------------------------------
//   the score in other tabs (not in MuseScore)
// ---------------------------------------------------------------------------------

const TABS_DO_NOT_SHARE = (): string => webtr('The tabs do not share their changes: whichever tab saves last overwrites what the other tab saved. To avoid losing work, continue in one tab only and close the score in the other.')

/** the score the user knows to be open in another tab: asked or told once, until it is not open there any more */
let s_warnedOpenElsewhere: string | null = null

/** entering a score (this tab or the Score page) that was opened in another tab meanwhile: explains the situation */
async function warnIfOpenElsewhere(): Promise<void> {
    const id = state.current?.id
    if (!id || state.view !== 'score') {
        return
    }
    if (!(await scoresOpenElsewhere()).has(id)) {
        if (s_warnedOpenElsewhere === id) {
            s_warnedOpenElsewhere = null
        }
        return
    }
    if (s_warnedOpenElsewhere !== id && state.current?.id === id && !state.dialog) {
        s_warnedOpenElsewhere = id
        await showMessage(webtr('This score is also open in another tab.'), TABS_DO_NOT_SHARE())
    }
}

let s_lastView = state.view
onSessionChanged(() => {
    holdOpenScore(state.current?.id ?? null)
    if (state.view !== s_lastView) {
        s_lastView = state.view
        void warnIfOpenElsewhere()
    }
})
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        void warnIfOpenElsewhere()
    }
})
window.addEventListener('focus', () => void warnIfOpenElsewhere())

// ---------------------------------------------------------------------------------
//   startup: ?url=<score url>, otherwise the score that was open
// ---------------------------------------------------------------------------------

/**
 * StartupScenario::restoreLastSession: autosaves are left over if the page was closed with unsaved changes (or the
 * browser quit). The question is about one score: "Yes" opens it with its autosave (returns its id), "No" or Escape
 * removes its autosave (MuseScore: all of them). The autosaves of other scores stay: they are restored when these
 * scores are opened and asked about at the next start. Autosaves of scores open in other tabs are not left over.
 */
async function restoreSessionIfNeeded(): Promise<string | null> {
    const elsewhere = await scoresOpenElsewhere()
    const ids = (await autosaveIds()).filter(id => !elsewhere.has(id))
    if (!ids.length) {
        return null
    }
    const open = openScoreId()
    const id = open && ids.includes(open) ? open : ids[0]
    const name = await scoreName(id)
    if (await ask<boolean>('restoreSession', { restoreName: name ? baseName(name) : '' })) {
        return id
    }
    await removeAutosave(id)
    return null
}

export async function startup(): Promise<void> {
    const url = new URLSearchParams(location.search).get('url')
    const legacy = await takeLegacyLastFile()
    if (url) {
        await openUrl(url)
    } else {
        // the score that was open is not opened again (a large score or one that crashes the editor would be opened
        // at every start); the home screen lists it
        if (legacy) {
            // keep it in the list without opening it; the details are filled in when it is opened
            await addScore({
                name: legacy.name, source: 'file', hash: await contentHash(legacy.data), size: legacy.data.byteLength,
                title: '', composer: '', pages: 0, aspect: 210 / 297,
            }, { data: legacy.data })
        }
        const id = await restoreSessionIfNeeded()
        setOpenScoreId(null)
        if (id) {
            await openStored(id)
        }
    }
}
