// SPDX-License-Identifier: GPL-3.0-only
// The microphone of the note detection: when it is closed, kept or opened again (the browser APIs are stubbed).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioInput } from '../shared/notedetection/basicpitch/audioinput'
import { acquireMicrophone, closeKeptMicrophone, releaseMicrophone } from '../shared/notedetection/microphone'

function fakeStream(): MediaStream {
    const track = { enabled: true, readyState: 'live', stop(): void { this.readyState = 'ended' } }
    return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream
}

const track = (s: MediaStream): MediaStreamTrack => s.getTracks()[0]
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve))
const on = (): boolean => true

describe('microphone', () => {
    let getUserMedia: ReturnType<typeof vi.fn>
    let permission: string | null
    let userAgent: string

    beforeEach(() => {
        permission = 'prompt'
        userAgent = 'Chrome'
        getUserMedia = vi.fn(async () => fakeStream())
        vi.stubGlobal('navigator', {
            get userAgent() { return userAgent },
            mediaDevices: { getUserMedia },
            permissions: { query: async () => {
                if (permission === null) {
                    throw new TypeError('not supported')
                }
                return { state: permission }
            } },
        })
    })

    afterEach(() => {
        closeKeptMicrophone()
        vi.unstubAllGlobals()
    })

    it('closes the microphone if it is not to be kept', async () => {
        const s = await acquireMicrophone({})
        releaseMicrophone(s, () => false)
        expect(track(s).readyState).toBe('ended')
    })

    it('closes the microphone where the permission is granted: the browser would not ask again', async () => {
        permission = 'granted'
        const s = await acquireMicrophone({})
        releaseMicrophone(s, on)
        expect(track(s).enabled).toBe(false) // muted at once
        await flush()
        expect(track(s).readyState).toBe('ended')
    })

    for (const [name, setup] of [
        ['the permission state is "prompt"', () => { permission = 'prompt' }],
        ['the permission state is not available', () => { permission = null }],
        // Firefox reports one-time permissions as "granted" and asks again
        ['in Firefox', () => { permission = 'granted'; userAgent = 'Firefox/140' }],
    ] as const) {
        it(`keeps the microphone muted and reuses it if ${name}`, async () => {
            setup()
            const s = await acquireMicrophone({})
            releaseMicrophone(s, on)
            await flush()
            expect(track(s).readyState).toBe('live')
            expect(track(s).enabled).toBe(false)

            expect(await acquireMicrophone({})).toBe(s)
            expect(track(s).enabled).toBe(true)
            expect(getUserMedia).toHaveBeenCalledTimes(1)
        })
    }

    it('closes the kept microphone when the setting is turned off', async () => {
        const s = await acquireMicrophone({})
        releaseMicrophone(s, on)
        await flush()
        closeKeptMicrophone()
        expect(track(s).readyState).toBe('ended')
        await acquireMicrophone({})
        expect(getUserMedia).toHaveBeenCalledTimes(2)
    })

    it('asks again if the kept microphone ended (device removed, permission revoked)', async () => {
        const s = await acquireMicrophone({})
        releaseMicrophone(s, on)
        await flush()
        track(s).stop()
        expect(await acquireMicrophone({})).not.toBe(s)
        expect(getUserMedia).toHaveBeenCalledTimes(2)
    })

    it('a new start during the permission check keeps the microphone it took', async () => {
        permission = 'granted'
        const s = await acquireMicrophone({})
        releaseMicrophone(s, on)
        expect(await acquireMicrophone({})).toBe(s) // before the answer of the permission check
        await flush()
        expect(track(s).readyState).toBe('live')
        expect(track(s).enabled).toBe(true)
    })

    it('closes a microphone granted after the input was stopped, also if it should be kept', async () => {
        const s = fakeStream()
        let grant = (_: MediaStream): void => {}
        getUserMedia.mockImplementation(() => new Promise((resolve) => { grant = resolve }))
        const input = new AudioInput(() => {}, on)
        const started = input.start('microphone')
        await flush() // the browser asks now
        await input.stop()
        grant(s)
        await expect(started).rejects.toMatchObject({ name: 'AbortError' })
        expect(track(s).readyState).toBe('ended')
    })
})
