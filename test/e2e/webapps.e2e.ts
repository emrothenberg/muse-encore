// SPDX-License-Identifier: GPL-3.0-only
// MuseEncore Viewer and MuseEncore Editor (started as a copy of the viewer) in headless Chrome: npm run test:e2e
// (needs Google Chrome; CHROME_PATH=<binary> to use another one).
import { existsSync, readFileSync } from 'node:fs'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { presetNoMigration } from './e2ehelpers'
import { DEMOS, ROOT, TEST_FILES, VTEST, hasSubmodule } from '../helpers'

const CHROME = process.env.CHROME_PATH ?? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find(p => existsSync(p))

// scores are served from a fake host (request interception), like a score on another web server
const SCORES: Record<string, string> = {
    'amazing.mscz': `${DEMOS}/Amazing_grace.mscz`,
    'goldberg.mscz': `${DEMOS}/goldberg.mscz`,
    'twosided.mscz': `${VTEST}/page-numbers-03.mscz`,
    'landscape.mscz': `${VTEST}/mmrest-measure-repeat-custom-staves.mscz`,
    'chopin.mscz': `${TEST_FILES}/Chopin_-_Nocturne_Op_9_No_2_E_Flat_Major.mscz`,
    'onesided.mscz': `${DEMOS}/All_Dudes.mscz`,
    // import formats
    'hello.musicxml': `${ROOT}MuseScore/src/importexport/musicxml/tests/data/testHello.xml`,
    'lyrics.mid': `${ROOT}MuseScore/src/importexport/midi/tests/midiimport_data/lyrics_voice_1.mid`,
    'test1.cap': `${ROOT}MuseScore/src/importexport/capella/tests/data/test1.cap`,
    'bend.gpx': `${ROOT}MuseScore/src/importexport/guitarpro/tests/data/basic-bend.gpx`,
}
const SCORE_HOST = 'http://scores.test/'

// the viewer's elements are in the shadow root of its component; the editor's in the document
declare global {
    function $v(id: string): HTMLElement | null
    function $vq(selector: string): HTMLElement | null
    function $vqa(selector: string): HTMLElement[]
    function $vbody(): HTMLElement
}
function installHelpers(): void {
    const root = (): ShadowRoot | null | undefined => document.getElementById('app')?.firstElementChild?.shadowRoot
    const w = window as unknown as Record<string, unknown>
    w.$v = (id: string) => root()?.getElementById(id) ?? document.getElementById(id)
    w.$vq = (s: string) => root()?.querySelector(s) ?? document.querySelector(s)
    w.$vqa = (s: string) => [...(root()?.querySelectorAll(s) ?? document.querySelectorAll(s))]
    w.$vbody = () => root()?.querySelector('.viewer') ?? document.body
}

let server: ViteDevServer
let browser: Browser
let base = ''

async function newPage(opts: { colorScheme?: 'light' | 'dark'; delayMs?: number } = {}): Promise<{ page: Page; context: BrowserContext }> {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: opts.colorScheme })
    await presetNoMigration(context)
    await context.addInitScript(installHelpers)
    await context.route(`${SCORE_HOST}**`, async route => {
        const name = route.request().url().slice(SCORE_HOST.length)
        if (opts.delayMs) {
            await new Promise(r => setTimeout(r, opts.delayMs))
        }
        await route.fulfill({ body: readFileSync(SCORES[name]), headers: { 'access-control-allow-origin': '*' } })
    })
    const page = await context.newPage()
    page.on('pageerror', e => { throw e })
    return { page, context }
}

async function openScore(page: Page, name: string): Promise<void> {
    await page.goto(`${base}?url=${encodeURIComponent(SCORE_HOST + name)}`)
    await page.waitForFunction(() => /pages?$/.test($v('status')?.textContent ?? '')
        || /\d+ ms$/.test($v('status')?.textContent ?? ''), null, { timeout: 120000 })
    await page.waitForFunction(() => $v('busy')!.hidden)
}

const text = (page: Page, id: string): Promise<string> => page.evaluate(i => $v(i)!.textContent ?? '', id)

/** waits until the page indicator shows `info` (navigation scrolls smoothly) */
const pageInfoIs = (page: Page, info: string): Promise<unknown> =>
    page.waitForFunction(i => ($v('page-info') ?? $vq('.page-info'))!.textContent === i, info, { timeout: 10000 })

/** offset of the page's center from the view's center */
function pageCenterOffset(page: Page, idx = 0): Promise<[number, number]> {
    return page.evaluate((i) => {
        const v = $v('viewport')!.getBoundingClientRect()
        const p = $vqa('.page:not(.placeholder)')[i].getBoundingClientRect()
        // + 0: no -0
        return [Math.round(p.left + p.width / 2 - v.left - v.width / 2) + 0, Math.round(p.top + p.height / 2 - v.top - v.height / 2) + 0]
    }, idx)
}

/**
 * the hand tool: Space + drag (in the editor the default setting "Hold Space and drag to move the score"; in the viewer
 * a plain drag moves the view too), or the middle mouse button in the editor
 */
async function handDrag(page: Page, app: string, dx: number, dy: number, middleButton = false): Promise<void> {
    const space = app === 'viewer' || !middleButton
    await page.mouse.move(640, 400)
    if (space) {
        await page.keyboard.down(' ')
    }
    await page.mouse.down({ button: space ? 'left' : 'middle' })
    for (let i = 1; i <= 10; ++i) {
        await page.mouse.move(640 + dx * i / 10, 400 + dy * i / 10)
    }
    await page.mouse.up({ button: space ? 'left' : 'middle' })
    if (space) {
        await page.keyboard.up(' ')
    }
}

describe.skipIf(!CHROME || !hasSubmodule).each(['viewer', 'editor'])('%s', (app) => {
    // the viewer's toolbar has ids; the editor's toolbars are made of MuseScore's actions
    const editor = app === 'editor'
    const sel = editor ? {
        layoutV: '[data-action="view-pages-vertical"]', spread: '[data-action="view-two-pages"]', zoom: '.zoom-select',
        center: '[data-action="view-center-page"]', fullscreen: '[data-action="fullscreen"]', pageInfo: '.page-info',
    } : {
        layoutV: '#layout-v', spread: '#spread', zoom: '#zoom', center: '#center', fullscreen: '#fullscreen', pageInfo: '#page-info',
    }
    // MuseScore's full screen shortcut on macOS is Ctrl+Cmd+F
    const fullscreenKey = editor && process.platform === 'darwin' ? 'Control+Meta+f' : 'F11'
    beforeAll(async () => {
        server = await createServer({ configFile: `${ROOT}${app}/vite.config.ts`, root: `${ROOT}${app}`, server: { port: 0 }, logLevel: 'error' })
        await server.listen()
        base = server.resolvedUrls!.local[0]
        browser = await chromium.launch({ executablePath: CHROME, headless: true })
    }, 60000)

    afterAll(async () => {
        await browser?.close()
        await server?.close()
    })

    it.runIf(app === 'viewer')('shows the centered drop target without a file and nothing to scroll', async () => {
        const { page, context } = await newPage()
        await page.goto(base)
        await page.waitForFunction(() => $v('status')!.textContent === 'Ready')
        const r = await page.evaluate(() => {
            const v = $v('viewport')!
            const d = $vq('.drop-target')!.getBoundingClientRect()
            const vr = v.getBoundingClientRect()
            return {
                scrollable: [v.scrollWidth - v.clientWidth, v.scrollHeight - v.clientHeight],
                center: [Math.round(d.left + d.width / 2 - vr.left - vr.width / 2), Math.round(d.top + d.height / 2 - vr.top - vr.height / 2)],
            }
        })
        expect(r.scrollable).toEqual([0, 0])
        expect(r.center).toEqual([0, 0])
        await context.close()
    })

    it('shows a blocking loading window while a file is opened', async () => {
        const { page, context } = await newPage({ delayMs: 1500 })
        let chooser = false
        page.on('filechooser', () => { chooser = true })
        await page.goto(`${base}?url=${encodeURIComponent(SCORE_HOST + 'amazing.mscz')}`)
        await page.waitForFunction(() => !$v('busy')!.hidden)
        expect(await text(page, 'busy-title')).toBe('Opening amazing.mscz')
        expect(await text(page, 'busy-detail')).toBe('Downloading…')
        expect(await page.evaluate(() => $v('viewport')!.hasAttribute('inert'))).toBe(true)
        await page.keyboard.press('Control+O') // ignored while busy
        await page.waitForFunction(() => $v('busy')!.hidden, null, { timeout: 60000 })
        expect(chooser).toBe(false)
        expect(await text(page, 'status')).toMatch(/2 pages/)
        await context.close()
    })

    it('opens MusicXML, MIDI, Capella and Guitar Pro files', async () => {
        const { page, context } = await newPage()
        for (const name of ['hello.musicxml', 'lyrics.mid', 'test1.cap', 'bend.gpx']) {
            await openScore(page, name)
            expect(await text(page, 'status')).toMatch(new RegExp(`^${name.replace('.', '\\.')} · \\d+ pages?`))
            expect(await text(page, 'title')).toBe(name.replace(/\.[^.]+$/, ''))
            expect(await page.evaluate(() => $vqa('.page:not(.placeholder)').length)).toBeGreaterThan(0)
        }
        await context.close()
    })

    it('opens a score centered; the viewer remembers it and forgets it when closed, the editor starts with the home screen', async () => {
        const { page, context } = await newPage()
        // the viewer shows its drop target without a score, the editor its home screen
        const noScore = (): Promise<boolean> => page.evaluate((a) => a === 'viewer'
            ? !$v('empty')!.hidden
            : !!$vq('.home') && document.body.dataset.view === 'home', app)
        await openScore(page, 'amazing.mscz')
        expect(await text(page, 'title')).toBe('amazing')
        expect(await page.textContent(sel.pageInfo)).toBe('1 / 2')
        expect(await pageCenterOffset(page)).toEqual([0, 0])

        if (app !== 'viewer') {
            // the editor does not open the last score again (a large score or one that crashes it would open every time)
            await page.goto(base)
            await page.waitForSelector('.home')
            await page.waitForTimeout(1500)
            expect(await noScore()).toBe(true)
            await context.close()
            return
        }
        await page.goto(base) // no ?url: the last file is opened again
        await page.waitForFunction(() => /2 pages/.test($v('status')?.textContent ?? ''), null, { timeout: 60000 })
        expect(await text(page, 'title')).toBe('amazing')

        await page.click('#clear')
        expect(await noScore()).toBe(true)
        await page.reload() // at once: the file must not come back
        await page.waitForTimeout(1500)
        expect(await noScore()).toBe(true)
        await context.close()
    }, 120000)

    it('shows pages side by side or vertically and two-page spreads for two-sided layouts', async () => {
        const { page, context } = await newPage()
        const rects = (): Promise<DOMRect[]> => page.evaluate(() =>
            [...$vqa('.page:not(.placeholder)')].map(p => p.getBoundingClientRect().toJSON() as DOMRect))
        await openScore(page, 'twosided.mscz')
        let r = await rects()
        expect(r[1].left).toBeGreaterThan(r[0].right) // side by side (default)
        await page.click(sel.layoutV)
        r = await rects()
        expect(r[1].top).toBeGreaterThan(r[0].bottom)
        expect(await page.isDisabled(sel.spread)).toBe(false)
        await page.click(sel.spread)
        // page 1 is a right-hand page: [placeholder, 1], [2, 3], [4]
        const spreads = await page.evaluate(() => [...$vqa('.spread')].map(s =>
            [...s.children].map(c => c.classList.contains('placeholder') ? '-' : Number((c as HTMLElement).dataset.page) + 1).join(',')))
        expect(spreads).toEqual(['-,1', '2,3', '4'])
        r = await rects()
        expect(Math.round(r[2].left)).toBe(Math.round(r[1].right)) // facing pages without gap
        expect(await page.textContent(sel.pageInfo)).toBe('1 / 4')
        await page.keyboard.press('ControlOrMeta+PageDown')
        await pageInfoIs(page, '2–3 / 4')

        await openScore(page, 'onesided.mscz')
        expect(await page.isDisabled(sel.spread)).toBe(true)
        await context.close()
    }, 120000)

    it('navigates and zooms with MuseScore shortcuts and the mouse wheel', async () => {
        const { page, context } = await newPage()
        await openScore(page, 'goldberg.mscz')
        const zoom = (): Promise<string> => page.evaluate(z => ($vq(z) as HTMLSelectElement).selectedOptions[0].textContent ?? '', sel.zoom)
        await page.keyboard.press('ControlOrMeta+0')
        expect(await zoom()).toBe('100%')
        await page.keyboard.press('ControlOrMeta+=')
        expect(await zoom()).toBe('150%')
        await page.keyboard.press('ControlOrMeta+-')
        await page.keyboard.press('ControlOrMeta+-')
        expect(await zoom()).toBe('75%')

        await page.keyboard.press('End')
        await pageInfoIs(page, '119 / 119')
        await page.keyboard.press('Home')
        await pageInfoIs(page, '1 / 119')
        await page.keyboard.press('ControlOrMeta+PageDown')
        await pageInfoIs(page, '2 / 119')

        // mouse wheel zoom keeps the point under the pointer in place
        const before = await page.evaluate(() => $vqa('.page')[1].getBoundingClientRect().left)
        await page.mouse.move(700, 400)
        await page.keyboard.down('Control')
        await page.mouse.wheel(0, -100)
        await page.keyboard.up('Control')
        await page.waitForTimeout(300)
        expect(parseFloat(await zoom())).toBeGreaterThan(75)
        const after = await page.evaluate(() => $vqa('.page')[1].getBoundingClientRect().left)
        expect(after).toBeLessThan(before) // the page grew around the pointer
        await context.close()
    }, 120000)

    it('moves the view beyond the pages and centers the page (editor: the first measure) again', async () => {
        const { page, context } = await newPage()
        await openScore(page, 'amazing.mscz')
        await handDrag(page, app, 1500, 1200)
        const moved = await page.evaluate(() => {
            const v = $v('viewport')!.getBoundingClientRect()
            const p = $vq('.page')!.getBoundingClientRect()
            return [Math.round(v.right - p.left), Math.round(v.bottom - p.top)]
        })
        expect(moved).toEqual([48, 48]) // only a strip of the page stays visible
        await page.click(sel.center)
        if (!editor) {
            expect(await pageCenterOffset(page)).toEqual([0, 0])
        } else {
            // without a selection: the first measure, in the upper left part of the page
            const [firstX, firstY] = await pageCenterOffset(page)
            expect(firstX).toBeGreaterThan(50)
            expect(firstY).toBeGreaterThan(50)
            // the middle mouse button moves the view too
            await handDrag(page, app, 300, 200, true)
            expect(await pageCenterOffset(page)).toEqual([firstX + 300, firstY + 200])
            // with a selection the center button centers it, not the first measure (the music fills only the upper part of the page)
            await page.focus('#viewport')
            await page.keyboard.press('ControlOrMeta+a')
            await page.click(sel.center)
            const [x, y] = await pageCenterOffset(page)
            expect(Math.abs(x)).toBeLessThan(40)
            expect(Math.abs(y)).toBeGreaterThan(10)
        }
        await context.close()
    }, 120000)

    it('draws zoomed-in pages as sharp tiles of bounded size', async () => {
        const { page, context } = await newPage()
        await openScore(page, 'amazing.mscz')
        await page.selectOption(sel.zoom, '800')
        await page.waitForTimeout(1500)
        const c = await page.evaluate(() => {
            const canvas = $vq('.page canvas') as HTMLCanvasElement
            return { tile: canvas.dataset.tile, pixels: canvas.width * canvas.height, dpi: Number(canvas.dataset.dpi) }
        })
        expect(c.tile).toBe('1')
        expect(c.pixels).toBeLessThanOrEqual(16 * 1024 * 1024)
        expect(c.dpi).toBeCloseTo(96 * 8, 0) // full resolution, not scaled up
        await context.close()
    }, 120000)

    it('collapses the toolbar in full screen and shows it at the top edge', async () => {
        const { page, context } = await newPage()
        await openScore(page, 'amazing.mscz')
        const shown = (): Promise<boolean> => page.evaluate(() => $vbody().classList.contains('toolbar-shown'))
        await page.click(sel.fullscreen)
        await page.waitForTimeout(400)
        expect(await page.evaluate(() => $vbody().classList.contains('fullscreen'))).toBe(true)
        expect(await shown()).toBe(true) // the pointer is still on it
        await page.mouse.move(640, 500)
        await page.waitForTimeout(700)
        expect(await shown()).toBe(false)
        await page.mouse.move(640, 3)
        await page.waitForTimeout(300)
        expect(await shown()).toBe(true)
        await page.mouse.move(640, 400)
        await page.waitForTimeout(700)
        expect(await shown()).toBe(false)
        if (editor) {
            // the bottom toolbar dock with the status bar and the panels: the same at the bottom and left edge
            const has = (c: string): Promise<boolean> => page.evaluate(c => $vbody().classList.contains(c), c)
            const hidden = (sel: string): Promise<boolean> => page.evaluate(s => {
                const r = $vq(s)!.getBoundingClientRect()
                return r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth
            }, sel)
            expect(await has('bottom-shown')).toBe(false)
            expect(await hidden('.statusbar')).toBe(true)
            expect(await has('panels-shown')).toBe(false)
            expect(await hidden('.panel-dock')).toBe(true)
            await page.mouse.move(640, 797)
            await page.waitForTimeout(400)
            expect(await has('bottom-shown')).toBe(true)
            expect(await hidden('.statusbar')).toBe(false)
            await page.mouse.move(640, 400)
            await page.waitForTimeout(700)
            expect(await has('bottom-shown')).toBe(false)
            await page.mouse.move(2, 400)
            await page.waitForTimeout(400)
            expect(await has('panels-shown')).toBe(true)
            expect(await hidden('.panel-dock')).toBe(false)
            await page.mouse.move(150, 400) // on the panels: stays
            await page.waitForTimeout(700)
            expect(await has('panels-shown')).toBe(true)
            await page.mouse.move(900, 400)
            await page.waitForTimeout(700)
            expect(await has('panels-shown')).toBe(false)
        }
        await page.keyboard.press(fullscreenKey)
        await page.waitForTimeout(300)
        expect(await page.evaluate(() => $vbody().classList.contains('fullscreen'))).toBe(false)
        await context.close()
    }, 120000)

    it.runIf(app === 'viewer')('plays the score with the playback cursor (no sound in automated browsers)', async () => {
        const { page, context } = await newPage()
        await openScore(page, 'amazing.mscz')
        expect(await text(page, 'play-time')).toBe('0:00 / 0:41')
        await page.click('#play')
        await page.waitForFunction(() => /^0:0[2-9]/.test($v('play-time')!.textContent ?? ''), null, { timeout: 10000 })
        expect(await page.evaluate(() => !$vq('.playback-cursor')!.hidden)).toBe(true)
        expect(await page.getAttribute('#play', 'aria-label')).toBe('Pause')
        // Space pauses (MuseScore's shortcut), holding it and dragging moves the view
        await page.keyboard.press(' ')
        await page.waitForFunction(() => $vq('.playback-cursor')!.hidden)
        const paused = await text(page, 'play-time')
        await page.waitForTimeout(500)
        expect(await text(page, 'play-time')).toBe(paused)
        await page.click('#rewind')
        expect(await text(page, 'play-time')).toBe('0:00 / 0:41')
        await context.close()
    }, 120000)

    it.runIf(app === 'viewer')('lays out the continuous view (fit to window) as wide as the view', async () => {
        const { page, context } = await newPage()
        await openScore(page, 'amazing.mscz')
        await page.selectOption('#view-mode', 'fit-width')
        await page.waitForFunction(() => $vqa('.page').length === 1 && !$v('viewport')!.classList.contains('view-switching'))
        const widths = (): Promise<[number, number]> => page.evaluate(() =>
            [Math.round($vq('.page')!.getBoundingClientRect().width), $v('viewport')!.clientWidth])
        let [w, vw] = await widths()
        expect(w).toBe(vw - 2 * 24) // the page gap at both sides
        expect(await page.evaluate(() => ($v('zoom') as HTMLSelectElement).selectedOptions[0].textContent)).toBe('100%')
        await page.setViewportSize({ width: 900, height: 800 })
        await page.waitForTimeout(800) // the reflow is delayed
        ;[w, vw] = await widths()
        expect(w).toBe(vw - 2 * 24)
        await context.close()
    }, 120000)

    it.runIf(app === 'viewer')('embeds viewers with applyMuseEncoreViewer and its options', async () => {
        const { page, context } = await newPage()
        const options = { continuousView: 'vertical', toolbarGroups: { playback: true, print: false, pageNavigation: false }, showStatusBar: true }
        await page.goto(`${base}embed.html?url=${encodeURIComponent(SCORE_HOST + 'twosided.mscz')}&options=${encodeURIComponent(JSON.stringify(options))}`)
        const info = await page.evaluate(async () => {
            const viewers = (window as unknown as { viewers: { ready: Promise<{ pageCount: number }>; currentPage(): number }[] }).viewers
            const loaded = await Promise.all(viewers.map(v => v.ready))
            return loaded.map((l, i) => ({ pages: l.pageCount, current: viewers[i].currentPage() }))
        })
        expect(info).toEqual([{ pages: 4, current: 1 }, { pages: 4, current: 2 }])
        const shown = (score: string, id: string): Promise<boolean> => page.evaluate(([s, i]) => {
            const el = document.querySelector(`${s} .muse-encore-viewer`)!.shadowRoot!.getElementById(i)!
            return el.checkVisibility()
        }, [score, id])
        expect(await shown('#score1', 'play')).toBe(true)
        expect(await shown('#score1', 'zoom')).toBe(true)
        expect(await shown('#score1', 'print')).toBe(false)
        expect(await shown('#score1', 'page-info')).toBe(false)
        expect(await shown('#score1', 'open')).toBe(false)
        expect(await shown('#score1', 'status')).toBe(true)
        expect(await shown('#score2', 'toolbar')).toBe(false)
        expect(await shown('#score2', 'status')).toBe(false)
        // the continuous view (vertical): one long page
        expect(await page.evaluate(() => document.querySelector('#score1 .muse-encore-viewer')!.shadowRoot!.querySelectorAll('.page').length)).toBe(1)
        // the viewer does not take the focus of the page
        expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
        await context.close()
    }, 120000)

    it.each([
        ['goldberg.mscz', 119, '8.26x11.69'],
        ['landscape.mscz', 1, '11.69x5.51'],
    ])('prints %s as vector pages on sheets of the score page size', async (name, pages, size) => {
        const { page, context } = await newPage()
        await openScore(page, name)
        const pdf = (await page.pdf({ preferCSSPageSize: true, printBackground: true })).toString('latin1')
        const boxes = [...pdf.matchAll(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/g)]
            .map(m => `${(+m[3] / 72).toFixed(2)}x${(+m[4] / 72).toFixed(2)}`)
        expect((pdf.match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(pages)
        expect(new Set(boxes)).toEqual(new Set([size]))
        expect(pdf).not.toMatch(/\/Subtype\s*\/Image/) // no bitmaps
        expect(await page.evaluate(() => $v('print-pages')!.childElementCount)).toBe(0)
        await context.close()
    }, 180000)
})
