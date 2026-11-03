/*
 * SPDX-License-Identifier: GPL-3.0-only
 * The microphone of the note detection. Closing it can make the browser ask for the permission again at the next start
 * (Firefox, unless "Remember this decision" was chosen; browsers with the permission state "prompt"). In these browsers
 * it can be kept open and muted until the tab is closed (the app's setting); where the permission is permanent it is
 * always closed, because keeping it would have no benefit.
 */

let s_kept: MediaStream | null = null

export function stopMicrophone(stream: MediaStream): void {
    stream.getTracks().forEach(track => track.stop())
}

function setActive(stream: MediaStream, active: boolean): void {
    stream.getAudioTracks().forEach((track) => { track.enabled = active })
}

/** whether opening the microphone again would ask the user */
async function wouldAskAgain(): Promise<boolean> {
    // Firefox's state "granted" includes one-time permissions, which it asks for again when no stream is left
    if (navigator.userAgent.includes('Firefox')) {
        return true
    }
    try {
        return (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state !== 'granted'
    } catch {
        return true // the state is not available
    }
}

/** the kept microphone if it still works, otherwise asks the browser for it */
export async function acquireMicrophone(audio: MediaTrackConstraints): Promise<MediaStream> {
    const kept = s_kept
    s_kept = null
    if (kept?.getAudioTracks().some(track => track.readyState === 'live')) {
        setActive(kept, true)
        return kept
    }
    return navigator.mediaDevices.getUserMedia({ audio })
}

/**
 * Listening has stopped: the microphone is closed, or kept muted if `keep()` and the browser would ask again.
 * It is muted at once, the browser's answer about the permission comes later (a new start may have taken it by then).
 */
export function releaseMicrophone(stream: MediaStream, keep: () => boolean): void {
    if (!keep()) {
        stopMicrophone(stream)
        return
    }
    setActive(stream, false)
    closeKeptMicrophone()
    s_kept = stream
    void wouldAskAgain().then((asks) => {
        if ((!asks || !keep()) && s_kept === stream) {
            closeKeptMicrophone()
        }
    })
}

/** closes the kept microphone, if there is one */
export function closeKeptMicrophone(): void {
    if (s_kept) {
        stopMicrophone(s_kept)
        s_kept = null
    }
}
