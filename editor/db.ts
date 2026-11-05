/*
 * SPDX-License-Identifier: GPL-3.0-only
 * The scores of the app in IndexedDB (via Dexie): every opened or created score is kept with its content, so the
 * home screen can list and reopen it (like MuseScore's recent scores). The score that is open is remembered in
 * localStorage and reopened on the next start. Autosaves (ProjectAutoSaver) are kept in a separate table, one per score.
 * Storage can be unavailable (private windows, blocked site data): then nothing is remembered and all calls fail
 * silently.
 */
import Dexie, { type EntityTable } from 'dexie'
import { useLiveQuery } from 'dexie-react-hooks'
import type { NewScoreOptions } from '../src/index'

export interface ScoreEntry {
    id: string
    /** file name with extension; for a new score its title */
    name: string
    title: string
    composer: string
    source: 'file' | 'url' | 'new'
    url?: string
    /** SHA-256 of a file's content: opening the same file again reuses the entry */
    hash?: string
    size: number
    pages: number
    /** page width / height (for the thumbnail placeholder) */
    aspect: number
    created: number
    modified: number
    opened: number
    thumbnail?: Blob
    /** the file on the computer (File System Access API): "Save" writes it back too */
    handle?: FileSystemFileHandle
}

/**
 * The content of a score: a file (.mscz or .mscx; saving stores an .mscz). New scores of earlier versions, which
 * had no score writer, are stored as the options they were created with (createScore() is deterministic).
 */
export type ScoreContent =
    | { id: string; data: ArrayBuffer }
    | { id: string; options: NewScoreOptions }

/** the autosave of a stored score (MuseScore: the file "<name>.mscz.autosave" next to the score) */
export interface Autosave {
    /** the id of the score */
    id: string
    data: ArrayBuffer
    time: number
}

class ScoreDb extends Dexie {
    scores!: EntityTable<ScoreEntry, 'id'>
    contents!: EntityTable<ScoreContent, 'id'>
    autosaves!: EntityTable<Autosave, 'id'>

    constructor() {
        // the database keeps the project's former name (MuseScore Web), so the scores of existing users are kept
        super('musescoreweb-scores')
        this.version(1).stores({
            scores: 'id, opened, hash',
            contents: 'id',
        })
        this.version(2).stores({
            autosaves: 'id',
        })
    }
}

const db = new ScoreDb()

/** at most this many scores are stored: for one more, the user chooses a score to delete (session.ts: ensureRoomForScore) */
export const MAX_SCORES = 500

function newId(): string {
    return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export async function contentHash(data: ArrayBuffer): Promise<string | undefined> {
    try {
        const d = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
        return Array.from(d, b => b.toString(16).padStart(2, '0')).join('')
    } catch {
        return undefined // no crypto.subtle (insecure context)
    }
}

/**
 * adds a score (or, for a file that is already stored, updates its entry unless `asNew`: "Save as" always makes a new
 * entry); returns its id
 */
export async function addScore(entry: Omit<ScoreEntry, 'id' | 'created' | 'modified' | 'opened'>, content: Omit<ScoreContent, 'id'>, asNew = false): Promise<string | null> {
    const now = Date.now()
    try {
        return await db.transaction('rw', db.scores, db.contents, async () => {
            const existing = entry.hash && !asNew ? await db.scores.where('hash').equals(entry.hash).first() : undefined
            if (existing) {
                await db.scores.update(existing.id, { ...entry, opened: now })
                return existing.id
            }
            const id = newId()
            await db.scores.add({ ...entry, id, created: now, modified: now, opened: now })
            await db.contents.add({ ...content, id } as ScoreContent)
            return id
        })
    } catch (e) {
        console.warn('could not store the score', e)
        return null
    }
}

export async function countScores(): Promise<number> {
    try {
        return await db.scores.count()
    } catch {
        return 0
    }
}

/** all stored scores, least recently opened first */
export async function scoresLeastRecentFirst(): Promise<ScoreEntry[]> {
    try {
        return await db.scores.orderBy('opened').toArray()
    } catch {
        return []
    }
}

/** the ids of the stored scores with this file content */
export async function scoreIdsWithHash(hash: string): Promise<string[]> {
    try {
        return (await db.scores.where('hash').equals(hash).primaryKeys()) as string[]
    } catch {
        return []
    }
}

export async function scoreName(id: string): Promise<string | null> {
    try {
        return (await db.scores.get(id))?.name ?? null
    } catch {
        return null
    }
}

/** which of these scores have an autosave newer than their saved version (what opening them would restore) */
export async function scoresWithUnsavedChanges(ids: readonly string[]): Promise<string[]> {
    try {
        const entries = await db.scores.bulkGet([...ids])
        const autosaves = await db.autosaves.bulkGet([...ids])
        return ids.filter((_, i) => {
            const entry = entries[i]
            const autosave = autosaves[i]
            return !!entry && !!autosave && autosave.time >= entry.modified
        })
    } catch {
        return []
    }
}

/**
 * The file of a score with unsaved changes was opened again: the score keeps its autosave as a separate score. It is
 * not the file's score any more: it gets a new name and is neither found by the file's content nor written to the file.
 * Returns its new name.
 */
export async function separateFromFile(id: string, rename: (name: string) => string): Promise<string | null> {
    try {
        return await db.transaction('rw', db.scores, async () => {
            const entry = await db.scores.get(id)
            if (!entry) {
                return null
            }
            const name = rename(entry.name)
            await db.scores.update(id, { name, hash: undefined, handle: undefined })
            return name
        })
    } catch (e) {
        console.warn('could not rename the score', e)
        return null
    }
}

export async function updateScore(id: string, changes: Partial<Omit<ScoreEntry, 'id'>>): Promise<void> {
    try {
        await db.scores.update(id, changes)
    } catch {
        // ignore
    }
}

/** replaces the content of a stored score (saving; changes may rename it); false if it is not stored */
export async function saveScoreContent(id: string, data: ArrayBuffer, changes: Partial<Omit<ScoreEntry, 'id'>>): Promise<boolean> {
    try {
        return await db.transaction('rw', db.scores, db.contents, async () => {
            if (!(await db.scores.get(id))) {
                return false
            }
            await db.contents.put({ id, data } as ScoreContent)
            await db.scores.update(id, { ...changes, modified: Date.now() })
            return true
        })
    } catch (e) {
        console.warn('could not store the score', e)
        return false
    }
}

export async function loadScoreContent(id: string): Promise<{ entry: ScoreEntry; content: ScoreContent } | null> {
    try {
        const [entry, content] = await Promise.all([db.scores.get(id), db.contents.get(id)])
        return entry && content ? { entry, content } : null
    } catch {
        return null
    }
}

export async function removeScore(id: string): Promise<void> {
    try {
        await db.transaction('rw', db.scores, db.contents, db.autosaves, async () => {
            await db.scores.delete(id)
            await db.contents.delete(id)
            await db.autosaves.delete(id)
        })
    } catch {
        // ignore
    }
}

export async function removeAllScores(): Promise<void> {
    try {
        await db.transaction('rw', db.scores, db.contents, db.autosaves, async () => {
            await db.scores.clear()
            await db.contents.clear()
            await db.autosaves.clear()
        })
    } catch {
        // ignore
    }
}

/** all stored scores, most recently opened first; undefined while loading, [] without storage */
export function useScores(): ScoreEntry[] | undefined {
    return useLiveQuery(async () => {
        try {
            return await db.scores.orderBy('opened').reverse().toArray()
        } catch {
            return []
        }
    })
}

// ---------------------------------------------------------------------------------
//   autosaves (ProjectAutoSaver)
// ---------------------------------------------------------------------------------

/** stores the autosave of a stored score; false if it failed (or the score is not stored) */
export async function putAutosave(id: string, data: ArrayBuffer): Promise<boolean> {
    try {
        return await db.transaction('rw', db.scores, db.autosaves, async () => {
            if (!(await db.scores.get(id))) {
                return false
            }
            await db.autosaves.put({ id, data, time: Date.now() })
            return true
        })
    } catch (e) {
        console.warn('could not store the autosave', e)
        return false
    }
}

export async function loadAutosave(id: string): Promise<Autosave | null> {
    try {
        return (await db.autosaves.get(id)) ?? null
    } catch {
        return null
    }
}

/** the ids of the scores with an autosave (ProjectAutoSaver::projectHasUnsavedChanges) */
export async function autosaveIds(): Promise<string[]> {
    try {
        return (await db.autosaves.toCollection().primaryKeys()) as string[]
    } catch {
        return []
    }
}

export async function removeAutosave(id: string): Promise<void> {
    try {
        await db.autosaves.delete(id)
    } catch {
        // ignore
    }
}

// ---------------------------------------------------------------------------------
//   the open score
// ---------------------------------------------------------------------------------

// synchronous, so a score that was just closed does not come back when the page is reloaded at once
const OPEN_SCORE_KEY = 'musescoreweb:open'

export function openScoreId(): string | null {
    try {
        return localStorage.getItem(OPEN_SCORE_KEY)
    } catch {
        return null
    }
}

export function setOpenScoreId(id: string | null): void {
    try {
        if (id) {
            localStorage.setItem(OPEN_SCORE_KEY, id)
        } else {
            localStorage.removeItem(OPEN_SCORE_KEY)
        }
    } catch {
        // ignore
    }
}

// ---------------------------------------------------------------------------------
//   the first version kept only the last opened file (database "musescoreweb", store "files", key "last")
// ---------------------------------------------------------------------------------

/** the last file of the first version, which is then deleted; null if there is none */
export async function takeLegacyLastFile(): Promise<{ name: string; data: ArrayBuffer; open: boolean } | null> {
    const LEGACY_FILE_KEY = 'musescoreweb:file'
    let open = false
    try {
        open = !!localStorage.getItem(LEGACY_FILE_KEY)
        localStorage.removeItem(LEGACY_FILE_KEY)
        if (!(await indexedDB.databases?.())?.some(d => d.name === 'musescoreweb')) {
            return null
        }
    } catch {
        return null
    }
    const file = await new Promise<{ name: string; data: ArrayBuffer } | null>((resolve) => {
        const req = indexedDB.open('musescoreweb')
        req.onerror = () => resolve(null)
        req.onsuccess = () => {
            const idb = req.result
            try {
                const get = idb.transaction('files', 'readonly').objectStore('files').get('last')
                get.onsuccess = () => {
                    idb.close()
                    const f = get.result as { name?: string; data?: ArrayBuffer } | undefined
                    resolve(f?.name && f.data ? { name: f.name, data: f.data } : null)
                }
                get.onerror = () => {
                    idb.close()
                    resolve(null)
                }
            } catch {
                idb.close()
                resolve(null)
            }
        }
    })
    indexedDB.deleteDatabase('musescoreweb')
    return file ? { ...file, open } : null
}
