/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Which stored scores are open in other tabs (not in MuseScore, which has one window per score and locks nothing here):
 * a tab holds a shared Web Lock while a score is open. The browser releases it when the tab is closed or crashes, and
 * also keeps it while a tab in the background is frozen, which a message between the tabs could not tell.
 * Without Web Locks (insecure context) no other tab is known.
 */

const PREFIX = 'musescoreweb:open-score:'

let s_held: { id: string; granted: boolean; release: () => void } | null = null

function locks(): LockManager | null {
    return (navigator as { locks?: LockManager }).locks ?? null
}

/** this tab has this score open (null: none) */
export function holdOpenScore(id: string | null): void {
    if ((s_held?.id ?? null) === id) {
        return
    }
    s_held?.release()
    s_held = null
    const manager = locks()
    if (!id || !manager) {
        return
    }
    let release = (): void => {}
    const until = new Promise<void>((resolve) => { release = resolve })
    const held = { id, granted: false, release }
    s_held = held
    void manager.request(PREFIX + id, { mode: 'shared' }, () => {
        held.granted = true
        return until
    }).catch(() => {})
}

/** the ids of the scores open in other tabs */
export async function scoresOpenElsewhere(): Promise<Set<string>> {
    const ids = new Set<string>()
    try {
        const { held = [] } = (await locks()?.query()) ?? {}
        let ownSeen = false
        for (const { name } of held) {
            if (!name?.startsWith(PREFIX)) {
                continue
            }
            const id = name.slice(PREFIX.length)
            if (s_held?.granted && s_held.id === id && !ownSeen) {
                ownSeen = true // the lock of this tab
            } else {
                ids.add(id)
            }
        }
    } catch {
        // not available
    }
    return ids
}
