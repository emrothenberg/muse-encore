// SPDX-License-Identifier: GPL-3.0-only
// The editor's home screen, New Score dialog and stored scores in headless Chrome: npm run test:e2e
// (the score view is covered for both apps by webapps.e2e.ts).
import { existsSync, readFileSync } from 'node:fs'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { presetNoMigration } from './e2ehelpers'
import { DEMOS, ROOT, hasSubmodule, openScore } from '../helpers'
import { SegmentType } from '../../src/engraving/dom/segment'
import type { Chord } from '../../src/engraving/dom/chord'
import { unzipSync } from 'fflate'

const CHROME = process.env.CHROME_PATH ?? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find(p => existsSync(p))

const SCORE_HOST = 'http://scores.test/'

let server: ViteDevServer
let browser: Browser
let base = ''

async function newPage(opts: { askMigration?: boolean } = {}): Promise<{ page: Page; context: BrowserContext }> {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    if (!opts.askMigration) {
        await presetNoMigration(context)
    }
    await context.route(`${SCORE_HOST}**`, route => route.fulfill({
        body: readFileSync(`${DEMOS}/Amazing_grace.mscz`), headers: { 'access-control-allow-origin': '*' },
    }))
    const page = await context.newPage()
    page.on('pageerror', e => { throw e })
    // leaving the page with unsaved changes: the browser asks (beforeunload)
    page.on('dialog', d => void d.accept())
    return { page, context }
}

const view = (page: Page): Promise<string | undefined> => page.evaluate(() => document.body.dataset.view)
async function cardNames(page: Page): Promise<string[]> {
    await page.waitForSelector('.score-card.new') // the list is read from IndexedDB
    await page.waitForTimeout(300)
    return page.$$eval('.score-card:not(.new) .card-name', els => els.map(e => e.textContent ?? ''))
}

/**
 * after a reload: the home screen (the score that was open is not opened again); opens the score from its card
 * (without a name: the most recent one)
 */
async function reopen(page: Page, name?: string): Promise<void> {
    if (new URL(page.url()).searchParams.has('url')) {
        await scoreShown(page) // ?url= opens its score again
        return
    }
    await page.waitForSelector('.home')
    expect(await page.evaluate(() => document.body.dataset.view)).toBe('home')
    await page.click(name ? `.score-card:not(.new):has(.card-name:text-is("${name}"))` : '.score-card:not(.new) >> nth=0')
    await scoreShown(page)
}

async function scoreShown(page: Page): Promise<void> {
    await page.waitForFunction(() => document.body.dataset.view === 'score' && document.getElementById('busy')!.hidden
        && /\d+ ms$/.test(document.getElementById('status')!.textContent ?? ''), null, { timeout: 120000 })
}

describe.skipIf(!CHROME || !hasSubmodule)('editor', () => {
    beforeAll(async () => {
        server = await createServer({ configFile: `${ROOT}editor/vite.config.ts`, root: `${ROOT}editor`, server: { port: 0 }, logLevel: 'error' })
        await server.listen()
        base = server.resolvedUrls!.local[0]
        browser = await chromium.launch({ executablePath: CHROME, headless: true })
    }, 60000)

    afterAll(async () => {
        await browser?.close()
        await server?.close()
    })

    it('starts with the home screen and lists opened scores', async () => {
        const { page, context } = await newPage()
        await page.goto(base)
        await page.waitForSelector('.home')
        expect(await view(page)).toBe('home')
        expect(await page.locator('.toolbar-dock').count()).toBe(0) // the toolbars are on the score page
        expect(await page.isDisabled('.app-tabs [role="tab"]:nth-child(2)')).toBe(true)
        expect(await cardNames(page)).toEqual([])

        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        await page.click('.app-tabs [role="tab"]:has-text("Home")')
        await page.waitForFunction(() => document.querySelectorAll('.score-card:not(.new) img').length === 1, null, { timeout: 10000 })
        expect(await cardNames(page)).toEqual(['amazing'])

        // the same file again: no second entry
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        await page.click('#clear')
        expect(await view(page)).toBe('home')
        expect(await cardNames(page)).toEqual(['amazing'])

        // reopened from the list
        await page.click('.score-card:not(.new)')
        await scoreShown(page)
        expect(await page.textContent('#title')).toBe('amazing')
        await context.close()
    }, 180000)

    it('imports MusicXML, MIDI, Capella and Guitar Pro files; Save makes a MuseScore file of them', async () => {
        const { page, context } = await newPage()
        const IMPORT = `${ROOT}MuseScore/src/importexport/`
        const files: Record<string, string> = {
            'testHello.mxl': `${IMPORT}musicxml/tests/data/testHello.mxl`,
            'testHello.xml': `${IMPORT}musicxml/tests/data/testHello.xml`,
            'lyrics_voice_1.mid': `${IMPORT}midi/tests/midiimport_data/lyrics_voice_1.mid`,
            'test1.cap': `${IMPORT}capella/tests/data/test1.cap`,
            'basic-bend.gp5': `${IMPORT}guitarpro/tests/data/basic-bend.gp5`,
            'accent.gp': `${IMPORT}guitarpro/tests/data/accent.gp`,
        }
        await context.route('http://imports.test/**', route => route.fulfill({
            body: readFileSync(files[new URL(route.request().url()).pathname.slice(1)]),
            headers: { 'access-control-allow-origin': '*' },
        }))
        for (const name of Object.keys(files)) {
            await page.goto(`${base}?url=${encodeURIComponent(`http://imports.test/${name}`)}`)
            await scoreShown(page)
            expect(await page.textContent('#status')).toMatch(/\d+ pages? · layout/)
            // the name without the suffix; an imported score is not modified
            expect(await page.textContent('#title')).toBe(name.replace(/\.[^.]+$/, ''))
        }
        // Save of an imported score goes through "Save as" (a new MuseScore file)
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+s')
        await page.waitForSelector('dialog.save-score[open]')
        await page.click('dialog.save-score button[type="submit"]')
        await page.waitForSelector('dialog.save-score', { state: 'detached' })
        await page.click('.app-tabs [role="tab"]:has-text("Home")')
        expect(await cardNames(page)).toContain('accent')
        await context.close()
    }, 240000)

    it('asks about MusicXML errors, shows files that cannot be read and has the Import preferences', async () => {
        const { page, context } = await newPage()
        const xml = readFileSync(`${ROOT}MuseScore/src/importexport/musicxml/tests/data/testHello.xml`, 'utf8')
        const files: Record<string, string> = { 'truncated.xml': xml.slice(0, xml.indexOf('</measure>')), 'bad.mid': 'MThd garbage' }
        await context.route('http://imports.test/**', route => route.fulfill({
            body: files[new URL(route.request().url()).pathname.slice(1)], headers: { 'access-control-allow-origin': '*' },
        }))
        // MuseScore's question; "No": the file is not opened ("Cannot read file")
        await page.goto(`${base}?url=${encodeURIComponent('http://imports.test/truncated.xml')}`)
        await page.waitForSelector('dialog.message-box[open]')
        expect(await page.textContent('dialog.message-box')).toMatch(/\d+ errors? found, import may be incomplete\..*Do you want to try to load this file anyway\?/s)
        await page.click('dialog.message-box button[value="no"]')
        await page.waitForFunction(() => /Cannot read file truncated\.xml/.test(document.querySelector('dialog.message-box[open]')?.textContent ?? ''))
        await page.click('dialog.message-box button[value="ok"]')
        // "Yes": opened
        await page.goto(`${base}?url=${encodeURIComponent('http://imports.test/truncated.xml')}`)
        await page.waitForSelector('dialog.message-box[open]')
        await page.click('dialog.message-box button[value="yes"]')
        await scoreShown(page)

        // a MIDI file that cannot be read: MuseScore's warning, then "Cannot read file"
        await page.goto(`${base}?url=${encodeURIComponent('http://imports.test/bad.mid')}`)
        await page.waitForFunction(() => /Import failed/.test(document.querySelector('dialog.message-box[open]')?.textContent ?? ''))
        await page.click('dialog.message-box button[value="ok"]')
        await page.waitForFunction(() => /Cannot read file bad\.mid/.test(document.querySelector('dialog.message-box[open]')?.textContent ?? ''))
        await page.click('dialog.message-box button[value="ok"]')

        // Preferences > Import
        await page.click('.menubar > button:has-text("Edit")')
        await page.click('.menu-item:has-text("Preferences")')
        await page.waitForSelector('dialog.preferences[open]')
        await page.click('.preferences-pages li:has-text("Import")')
        await page.uncheck('.preferences-page label:has-text("Import system and page breaks") input')
        await page.selectOption('.import-shortest-note', '480')
        const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('musescoreweb:settings')!).import)
        expect(stored.musicXml.importBreaks).toBe(false)
        expect(stored.midi.midiShortestNote).toBe(480)
        expect(stored.styleFile).toBeNull()
        // "Use style file" before a file is chosen: the file chooser is enabled
        await page.check('.preferences-page input[name="import-style"] >> nth=1')
        expect(await page.isEnabled('.import-style-row button')).toBe(true)
        await context.close()
    }, 180000)

    it('asks about the migration of an older score (fonts Leland and Edwin) and remembers the answer', async () => {
        const { page, context } = await newPage({ askMigration: true })
        const url = `${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`
        const stored = (): Promise<Record<string, unknown> | undefined> => page.evaluate(() =>
            JSON.parse(localStorage.getItem('musescoreweb:settings') ?? '{}').project?.migration?.Pre_3_6)
        const checks = page.locator('dialog.migration input[type="checkbox"]')

        // a MuseScore 2 score: the dialog for scores older than 3.6.2, all improvements checked
        await page.goto(url)
        await page.waitForSelector('dialog.migration[open]')
        expect(await page.textContent('#migration-title')).toMatch(/MuseScore 2\./)
        expect(await checks.count()).toBe(4)
        expect(await Promise.all([0, 1, 2, 3].map(i => checks.nth(i).isChecked()))).toEqual([true, true, true, false])
        expect(await page.getAttribute('dialog.migration a', 'href')).toBe('https://musescore.org/node/367337')
        expect(await page.isHidden('#busy')).toBe(true)
        await checks.nth(1).uncheck() // no Edwin
        await page.click('dialog.migration button.primary')
        await scoreShown(page)
        expect(await page.textContent('#title')).toBe('*amazing') // migrated: modified
        expect(await stored()).toMatchObject({ isApplyMigration: true, isAskAgain: true, isApplyLeland: true, isApplyEdwin: false })

        // asked again, with the last answer; closing the dialog does not open the score
        await page.goto(url)
        await page.waitForSelector('dialog.migration[open]')
        expect(await checks.nth(1).isChecked()).toBe(false)
        await page.keyboard.press('Escape')
        await page.waitForFunction(() => document.getElementById('busy')!.hidden && !document.querySelector('dialog[open]'))
        expect(await view(page)).toBe('home')

        // "Don't ask again": the next time the score is opened with the stored answer
        await page.goto(url)
        await page.waitForSelector('dialog.migration[open]')
        await checks.nth(3).check()
        await page.click('dialog.migration button.primary')
        await scoreShown(page)
        expect(await stored()).toMatchObject({ isAskAgain: false, isApplyEdwin: false })
        await page.goto(url)
        await scoreShown(page)
        expect(await page.locator('dialog.migration').count()).toBe(0)
        expect(await page.textContent('#title')).toBe('*amazing')
        await context.close()
    }, 180000)

    it('creates a score from instruments and keeps it', async () => {
        const { page, context } = await newPage()
        await page.goto(base)
        await page.click('.home-footer button:has-text("New")')
        await page.waitForSelector('dialog.new-score[open]')
        expect(await page.isDisabled('dialog.new-score .dialog-buttons button:has-text("Done")')).toBe(true)

        await page.fill('.instruments input[type="search"]', 'flute')
        await page.dblclick('.instruments [role="option"] >> text=Flute')
        await page.fill('.instruments input[type="search"]', 'piano')
        await page.dblclick('.instruments [role="option"] >> text=Piano')
        const onScore = await page.$$eval('.on-score [role="option"] .item-name', els => els.map(e => e.textContent))
        expect(onScore).toEqual(['Flute', 'Piano'])

        await page.click('dialog.new-score button:has-text("Next")')
        await page.fill('input[placeholder="Untitled score"]', 'Test score')
        await page.fill('input[placeholder="Composer / arranger"]', 'Someone')
        await page.click('dialog.new-score .dialog-buttons button:has-text("Done")')
        await scoreShown(page)
        // a new score is unsaved (NotationProject::markAsNewlyCreated)
        expect(await page.textContent('#title')).toBe('*Test score')

        // the open score is created again after a reload
        await page.reload()
        await reopen(page, 'Test score')
        expect(await page.textContent('#title')).toBe('*Test score')

        // removing a created score asks first
        await page.click('.app-tabs [role="tab"]:has-text("Home")')
        await page.hover('.score-grid li:nth-child(2)')
        await page.click('.score-grid li:nth-child(2) .remove')
        await page.waitForSelector('dialog.confirm[open]')
        await page.click('dialog.confirm button:has-text("Remove")')
        await page.waitForFunction(() => !document.querySelector('.score-card:not(.new)'))
        await context.close()
    }, 180000)

    it('creates a score from a template with a preview', async () => {
        const { page, context } = await newPage()
        await page.goto(base)
        await page.keyboard.press('ControlOrMeta+n')
        await page.waitForSelector('dialog.new-score[open]')
        await page.click('[role="tab"]:has-text("Create from template")')
        await page.click('.choose-template [role="option"]:has-text("Chamber Music")')
        await page.click('.choose-template [role="option"]:has-text("String Quartet")')
        await page.waitForSelector('.template-preview canvas', { timeout: 60000 })
        await page.click('dialog.new-score .dialog-buttons button:has-text("Done")')
        await scoreShown(page)
        expect(await page.textContent('#title')).toBe('*Untitled score')
        await context.close()
    }, 180000)

    it('has MuseScore\'s menus, operable with the mouse and the keyboard', async () => {
        const { page, context } = await newPage()
        await page.goto(base)
        await page.waitForSelector('.home')
        const menus = await page.$$eval('.menubar > button', b => b.map(x => x.textContent))
        expect(menus).toEqual(['File', 'Edit', 'View', 'Add', 'Format', 'Tools', 'Help'])
        await page.click('.menubar > button:has-text("File")')
        const items = await page.$$eval('.menu-popup [role^="menuitem"] .menu-title', e => e.map(x => x.textContent))
        expect(items.slice(0, 4)).toEqual(['New…', 'Open…', 'Open recent', 'Close'])
        await page.click('.menu-popup [role="menuitem"]:has-text("New…")')
        await page.waitForSelector('dialog.new-score[open]')
        await page.keyboard.press('Escape')
        await page.waitForFunction(() => !document.querySelector('dialog[open]'))

        // F10 focuses the menu bar; arrows and Enter open a menu and run an item (the mouse is moved away: hovering
        // an item makes it the active one)
        await page.mouse.move(600, 600)
        await page.keyboard.press('F10')
        await page.keyboard.press('ArrowRight') // Edit
        await page.keyboard.press('ArrowDown')
        expect(await page.textContent('.menu-popup .menu-item.active .menu-title')).toBe('Undo')
        await page.keyboard.press('End') // Preferences…
        await page.keyboard.press('Enter')
        await page.waitForSelector('dialog.preferences[open]')
        await context.close()
    })

    it('moves, hides and customizes toolbars and keeps their layout', async () => {
        const { page, context } = await newPage()
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        const docks = (): Promise<Record<string, string[]>> => page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>('[data-dock]')]
            .map(d => [d.dataset.dock!, [...d.querySelectorAll<HTMLElement>('[data-toolbar]')].map(t => t.dataset.toolbar!)])))
        const main = ['notationToolBar', 'playbackToolBar', 'undoRedoToolBar']
        // the page view toolbar is at the bottom by default
        expect(await docks()).toEqual({ main, top: ['noteInputBar'], bottom: ['viewToolBar'] })

        // the handle's menu: a new row below the last one, back, to the bottom dock and back
        const moveBy = async (title: string, expected: Record<string, string[]>): Promise<void> => {
            await page.click('[data-toolbar="viewToolBar"] .toolbar-grip')
            await page.click(`.menu-popup .menu-item:has-text("${title}")`)
            await page.waitForFunction(e => JSON.stringify(Object.fromEntries([...document.querySelectorAll<HTMLElement>('[data-dock]')]
                .map(d => [d.dataset.dock!, [...d.querySelectorAll<HTMLElement>('[data-toolbar]')].map(t => t.dataset.toolbar!)]))) === e,
            JSON.stringify(expected))
        }
        await moveBy('Move to the top', { main, top: ['noteInputBar', 'viewToolBar'] })

        // drag the page view toolbar before the note input toolbar
        const grip = page.locator('[data-toolbar="viewToolBar"] .toolbar-grip')
        const target = await page.locator('[data-toolbar="noteInputBar"]').boundingBox()
        const g = await grip.boundingBox()
        await page.mouse.move(g!.x + 5, g!.y + 10)
        await page.mouse.down()
        await page.mouse.move(target!.x + 10, target!.y + 15, { steps: 8 })
        await page.mouse.up()
        expect((await docks()).top).toEqual(['viewToolBar', 'noteInputBar'])

        await moveBy('Move to the row below', { main, top: ['noteInputBar'], top1: ['viewToolBar'] })
        expect(await page.isVisible('[data-toolbar="viewToolBar"]')).toBe(true)
        await moveBy('Move to the row above', { main, top: ['noteInputBar', 'viewToolBar'] })
        await moveBy('Move to the bottom', { main, top: ['noteInputBar'], bottom: ['viewToolBar'] })
        await moveBy('Move to the top', { main, top: ['noteInputBar', 'viewToolBar'] })

        // dragged below the last row: a new row
        const lastRow = await page.locator('[data-dock="top"]').boundingBox()
        const g2 = await grip.boundingBox()
        await page.mouse.move(g2!.x + 5, g2!.y + 10)
        await page.mouse.down()
        await page.mouse.move(g2!.x + 20, lastRow!.y + lastRow!.height + 20, { steps: 8 })
        await page.mouse.up()
        expect(await docks()).toEqual({ main, top: ['noteInputBar'], top1: ['viewToolBar'] })
        await moveBy('Move to the row above', { main, top: ['noteInputBar', 'viewToolBar'] })

        // hide the note input toolbar (View > Toolbars) and remove a button from it
        await page.click('[data-toolbar="noteInputBar"] button[aria-label="Customize toolbar"]')
        await page.click('.customise-list li[data-action="pad-note-4"] input[type="checkbox"]')
        await page.keyboard.press('Escape')
        expect(await page.locator(".tool-button[data-action=\"pad-note-4\"]").count()).toBe(0)
        await page.click('.menubar > button:has-text("View")')
        await page.hover('.menu-item:has-text("Toolbars")')
        await page.click('.menu-item:has-text("Note input")')
        await page.waitForFunction(() => !document.querySelector('[data-toolbar="noteInputBar"]')) // menu actions run after the menu closed

        await page.reload()
        await reopen(page)
        expect((await docks()).top).toEqual(['viewToolBar'])
        await page.click('.menubar > button:has-text("View")')
        await page.click('.menu-item:has-text("Restore the default layout")')
        await page.waitForSelector('[data-toolbar="noteInputBar"]')
        expect(await docks()).toEqual({ main, top: ['noteInputBar'], bottom: ['viewToolBar'] })
        expect(await page.locator(".tool-button[data-action=\"pad-note-4\"]").count()).toBe(1)
        await context.close()
    }, 120000)

    it('uses MuseScore\'s translations', async () => {
        const { page, context } = await newPage()
        await page.goto(base)
        await page.waitForSelector('.home')
        await page.click('.menubar > button:has-text("Edit")')
        await page.click('.menu-item:has-text("Preferences")')
        await page.selectOption('dialog.preferences select', 'de')
        await page.waitForFunction(() => document.documentElement.lang === 'de')
        await page.click('dialog.preferences .dialog-buttons button')
        expect(await page.$$eval('.menubar > button', b => b.map(x => x.textContent))).toEqual(
            ['Datei', 'Bearbeiten', 'Ansicht', 'Hinzufügen', 'Formatierung', 'Werkzeuge', 'Hilfe'])
        expect(await page.textContent('#home-title')).toBe('Partituren')
        await page.reload()
        await page.waitForFunction(() => document.querySelector('.menubar > button')?.textContent === 'Datei')
        // instruments in the New Score dialog
        await page.click('.home-footer .primary')
        await page.fill('dialog.new-score input[type="search"]', 'Flöte')
        expect(await page.locator('.instruments [role="option"]:has-text("Flöte")').count()).toBeGreaterThan(0)
        await context.close()
    })

    it('selects elements with the mouse and the keyboard and shows them in the status bar', async () => {
        const { page, context } = await newPage()
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        const status = (): Promise<string> => page.textContent('#status').then(t => t ?? '')
        const p = (await page.locator('.page').first().boundingBox())!
        // the rest at the start of the soprano staff
        await page.mouse.click(p.x + p.width * 0.22, p.y + p.height * 0.155)
        await page.waitForFunction(() => document.getElementById('status')!.textContent!.startsWith('Rest;'))
        expect(await status()).toContain('Measure: 1; Beat: 1; Staff 1 (Soprano)')
        // MuseScore's selection color (the page is redrawn after the selection change)
        const blue = await page.waitForFunction(() => {
            const c = document.querySelector<HTMLCanvasElement>('.page canvas')!
            const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
            for (let i = 0; i < d.length; i += 4) {
                if (d[i + 2] - d[i] > 100 && d[i + 2] > d[i + 1] + 40) { // #0065BF, antialiased
                    return true
                }
            }
            return false
        }).then(() => true)
        expect(blue).toBe(true)
        const before = await status()
        await page.keyboard.press('ArrowRight') // the next chord or rest
        await page.waitForFunction(b => document.getElementById('status')!.textContent !== b, before)
        expect(await status()).toMatch(/^(Note|Rest|Chord);.*Measure: 1; Beat: [^1]/)
        // shift+click on the staff in measure 3: a range
        await page.keyboard.down('Shift')
        await page.mouse.click(p.x + p.width * 0.45, p.y + p.height * 0.155)
        await page.keyboard.up('Shift')
        await page.waitForFunction(() => document.getElementById('status')!.textContent!.startsWith('Range selection'))
        expect(await status()).toContain('Start measure: 1')
        expect(await status()).toContain('End measure: 3')
        await page.keyboard.press('Escape')
        await page.waitForFunction(() => /\d+ ms$/.test(document.getElementById('status')!.textContent!))
        await page.keyboard.press('ControlOrMeta+a')
        await page.waitForFunction(() => document.getElementById('status')!.textContent!.startsWith('Range selection'))
        await context.close()
    }, 120000)

    it('enters notes with the keyboard, undoes and deletes them', async () => {
        const { page, context } = await newPage()
        await page.goto(base)
        await page.click('.home-footer button:has-text("New")')
        await page.waitForSelector('dialog.new-score[open]')
        await page.fill('.instruments input[type="search"]', 'flute')
        await page.dblclick('.instruments [role="option"] >> text=Flute')
        await page.click('dialog.new-score .dialog-buttons button:has-text("Done")')
        await scoreShown(page)
        const status = (): Promise<string> => page.textContent('#status').then(t => t ?? '')
        const pressed = (code: string): Promise<string | null> => page.getAttribute(`.tool-button[data-action="${code}"]`, 'aria-pressed')
        const undoButton = '.tool-button[data-action="action://notation/undo"]'
        expect(await page.isDisabled(undoButton)).toBe(true)

        // N starts note input at the first rest, C D E enter quarter notes
        await page.focus('#viewport')
        await page.keyboard.press('n')
        await page.waitForFunction(() => document.querySelector('.tool-button[data-action="note-input-by-note-name"]')?.getAttribute('aria-pressed') === 'true')
        expect(await pressed('pad-note-4')).toBe('true')
        await page.keyboard.press('c')
        await page.keyboard.press('d')
        await page.keyboard.press('e')
        await page.waitForFunction(() => /^Note;.*Pitch: E5/.test(document.getElementById('status')!.textContent!))
        expect(await status()).toContain('Measure: 1; Beat: 3')
        expect(await page.isDisabled(undoButton)).toBe(false)

        // a duration key changes the input duration
        await page.keyboard.press('4') // pad-note-8
        await page.waitForFunction(() => document.querySelector('.tool-button[data-action="pad-note-8"]')?.getAttribute('aria-pressed') === 'true')
        expect(await pressed('pad-note-4')).toBe('false')

        // undo removes the last note, Escape ends note input
        await page.keyboard.press('ControlOrMeta+z')
        await page.waitForFunction(() => !/Pitch: E5/.test(document.getElementById('status')!.textContent!))
        await page.keyboard.press('Escape')
        await page.waitForFunction(() => document.querySelector('.tool-button[data-action="note-input-by-note-name"]')?.getAttribute('aria-pressed') !== 'true')

        // the selected note: up arrow raises it, Delete replaces it with a rest
        await page.keyboard.press('ArrowLeft')
        await page.waitForFunction(() => /^Note;.*Pitch: C5/.test(document.getElementById('status')!.textContent!))
        await page.keyboard.press('ArrowUp')
        await page.waitForFunction(() => /^Note;.*Pitch: C♯5/.test(document.getElementById('status')!.textContent!))
        await page.keyboard.press('Delete')
        await page.waitForFunction(() => /^Rest/.test(document.getElementById('status')!.textContent!))
        await page.keyboard.press('ControlOrMeta+z')
        await page.waitForFunction(() => /^Note;.*Pitch: C♯5/.test(document.getElementById('status')!.textContent!))
        await context.close()
    }, 180000)

    it('enters a triplet and a slur by keyboard, re-pitches notes and enters notes with the mouse', async () => {
        const { page, context } = await newPage()
        await page.goto(base)
        await page.click('.home-footer button:has-text("New")')
        await page.waitForSelector('dialog.new-score[open]')
        await page.fill('.instruments input[type="search"]', 'flute')
        await page.dblclick('.instruments [role="option"] >> text=Flute')
        await page.click('dialog.new-score .dialog-buttons button:has-text("Done")')
        await scoreShown(page)
        const status = (): Promise<string> => page.textContent('#status').then(t => t ?? '')
        const waitStatus = (re: RegExp): Promise<unknown> => page.waitForFunction(
            (src) => new RegExp(src).test(document.getElementById('status')!.textContent!), re.source)
        const pressed = (code: string): Promise<string | null> => page.getAttribute(`.tool-button[data-action="${code}"]`, 'aria-pressed')

        // N, Ctrl+3: a triplet of eighths; S starts a slur at D, F ends it
        await page.focus('#viewport')
        await page.keyboard.press('n')
        await page.keyboard.press('ControlOrMeta+3')
        await waitStatus(/^Rest.*Duration: Triplet Eighth/)
        await page.keyboard.press('c')
        await page.keyboard.press('d')
        await waitStatus(/^Note;.*Pitch: D5; Duration: Triplet Eighth/)
        await page.keyboard.press('s')
        await page.waitForFunction(() => document.querySelector('.tool-button[data-action="add-slur"]')?.getAttribute('aria-pressed') === 'true')
        await page.keyboard.press('e')
        await page.keyboard.press('f')
        await waitStatus(/^Note;.*Pitch: F5; Duration: Eighth;.*Beat: 2;/)
        await page.keyboard.press('s')
        await page.waitForFunction(() => document.querySelector('.tool-button[data-action="add-slur"]')?.getAttribute('aria-pressed') === 'false')
        await page.keyboard.press('Escape')

        // re-pitch mode (Ctrl+Shift+I) from the first note: new pitches, the rhythm stays
        for (let i = 0; i < 3; ++i) {
            const before = await status()
            await page.keyboard.press('ArrowLeft')
            await page.waitForFunction(b => document.getElementById('status')!.textContent !== b, before)
        }
        await waitStatus(/^Note;.*Pitch: C5; Duration: Triplet Eighth;.*Beat: 1;/)
        await page.keyboard.press('ControlOrMeta+Shift+i')
        // note input in the re-pitch mode (hidden in the default toolbar): the note name button is not pressed
        await page.waitForFunction(() => document.querySelector('.tool-button[data-action="note-input-by-note-name"]')?.getAttribute('aria-pressed') === 'false')
        await page.keyboard.press('g')
        await waitStatus(/^Note;.*Pitch: G4; Duration: Triplet Eighth;.*Beat: 1;/)
        await page.keyboard.press('a')
        await waitStatus(/^Note;.*Pitch: A4; Duration: Triplet Eighth;.*Beat: 1\.33/)
        expect(await pressed('note-input-by-note-name')).toBe('false')
        await page.keyboard.press('Escape')

        // the mouse in note input mode: the shadow note follows it, a click on the middle line of measure 2 enters a B4
        await page.keyboard.press('n')
        // zoom 100 % (Ctrl+0), the top of the first page in view
        await page.keyboard.press('ControlOrMeta+0')
        await page.waitForTimeout(400)
        await page.evaluate(() => {
            const v = document.getElementById('viewport')!
            const pr = document.querySelector('.page')!.getBoundingClientRect()
            v.scrollBy(0, pr.top - v.getBoundingClientRect().top - 20)
        })
        await page.waitForTimeout(400)
        const p = (await page.locator('.page').first().boundingBox())!
        const x = p.x + p.width * 0.38
        // the staff lines in the page bitmap at that x (dark pixels), the middle one of the first staff
        const lineY = await page.evaluate((fx) => {
            const c = document.querySelector<HTMLCanvasElement>('.page canvas')!
            const col = Math.round(c.width * fx)
            const d = c.getContext('2d')!.getImageData(col, 0, 1, c.height).data
            // runs of non-white rows (antialiased lines), their centers
            const lines: number[] = []
            let runStart = -1
            for (let y = 0; y <= c.height; ++y) {
                const dark = y < c.height && d[y * 4] < 245
                if (dark && runStart < 0) {
                    runStart = y
                } else if (!dark && runStart >= 0) {
                    lines.push((runStart + y - 1) / 2)
                    runStart = -1
                }
            }
            // the first five equally spaced runs are the staff lines
            for (let i = 0; i + 4 < lines.length; ++i) {
                const gap = lines[i + 1] - lines[i]
                if ([2, 3, 4].every(k => Math.abs(lines[i + k] - lines[i + k - 1] - gap) <= 1)) {
                    return (lines[i + 2] + 0.5) / c.height
                }
            }
            return -1
        }, 0.38)
        expect(lineY).toBeGreaterThan(0)
        const y = p.y + p.height * lineY
        await page.mouse.move(x, y - 40)
        await page.mouse.move(x, y, { steps: 4 })
        await page.waitForSelector('.page canvas.shadow-note')
        await page.mouse.click(x, y)
        await waitStatus(/^Note;.*Pitch: B4;.*Measure: 2;/)
        expect(await page.locator('.page canvas.shadow-note').count()).toBe(1)
        await page.keyboard.press('Escape')
        await page.mouse.move(x, y + 5)
        await page.waitForFunction(() => !document.querySelector('.page canvas.shadow-note'))
        await context.close()
    }, 180000)

    it('saves the edited score in the browser and asks before closing it with unsaved changes', async () => {
        const { page, context } = await newPage()
        await page.goto(base)
        await page.click('.home-footer button:has-text("New")')
        await page.waitForSelector('dialog.new-score[open]')
        await page.fill('.instruments input[type="search"]', 'flute')
        await page.dblclick('.instruments [role="option"] >> text=Flute')
        await page.click('dialog.new-score .dialog-buttons button:has-text("Done")')
        await scoreShown(page)
        await page.focus('#viewport')
        await page.keyboard.press('n')
        await page.keyboard.press('c')
        await page.keyboard.press('d')
        await page.waitForFunction(() => /^Note;.*Pitch: D5/.test(document.getElementById('status')!.textContent!))
        await page.keyboard.press('Escape')
        // Ctrl+Home selects the clef, the right arrow moves to the first note
        const firstNote = async (): Promise<void> => {
            await page.keyboard.press('ControlOrMeta+Home')
            await page.waitForFunction(() => /^Treble clef/.test(document.getElementById('status')!.textContent!))
            await page.keyboard.press('ArrowRight')
            await page.waitForFunction(() => /^Note/.test(document.getElementById('status')!.textContent!))
        }

        // File > Save stores it (a new score: through "Save as"); after a reload the notes are there
        // the tab shows "*" before the title while there are unsaved changes (NotationSwitchButton)
        expect(await page.textContent('#title')).toMatch(/^\*/)
        await page.keyboard.press('ControlOrMeta+s')
        await page.waitForSelector('dialog.save-score[open]')
        await page.click('dialog.save-score button[type="submit"]')
        await page.waitForFunction(() => !document.getElementById('title')!.textContent!.startsWith('*'))
        await page.reload()
        await reopen(page)
        await page.focus('#viewport')
        await firstNote()
        expect(await page.textContent('#status')).toMatch(/^Note;.*Pitch: C5/)

        // an unsaved change: closing asks; "Cancel" keeps the score open, "Don’t save" closes it
        await page.keyboard.press('ArrowUp')
        await page.waitForFunction(() => /^Note;.*Pitch: C♯5/.test(document.getElementById('status')!.textContent!))
        await page.click('.notation-tab #clear')
        await page.waitForSelector('dialog.confirm[open]')
        expect(await page.textContent('#save-changes-title')).toContain('before closing')
        await page.click('dialog.confirm button[value="cancel"]')
        expect(await page.isVisible('.notation-tab')).toBe(true)
        await page.click('.notation-tab #clear')
        await page.click('dialog.confirm button[value="dontSave"]')
        await page.waitForSelector('.home')
        // the stored version is the saved one
        await page.click('.score-card:not(.new)')
        await scoreShown(page)
        await page.focus('#viewport')
        await firstNote()
        expect(await page.textContent('#status')).toMatch(/^Note;.*Pitch: C5/)
        await context.close()
    }, 180000)

    it('edits the selection from the palettes and the Properties panel (undoable)', async () => {
        const { page, context } = await newPage()
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+Home')
        for (let i = 0; i < 8 && !(await page.textContent('#status'))!.startsWith('Note'); i++) {
            await page.keyboard.press('ArrowRight')
        }
        const before = (await page.textContent('#status'))!
        expect(before).toMatch(/^Note/)
        expect(await page.textContent('#title')).not.toMatch(/^\*/)

        // a palette cell: the flat of the accidentals palette
        await page.click('.palette-tree-item[data-palette-type="Accidental"] .palette-header')
        const flat = '.palette-tree-item[data-palette-type="Accidental"] .palette-cell[aria-label="Flat"]'
        await page.waitForSelector(flat)
        await page.click(flat)
        await page.waitForFunction(() => /^Note;.*Pitch: [A-G]♭/.test(document.getElementById('status')!.textContent!))
        expect(await page.textContent('#title')).toMatch(/^\*/)
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+z')
        await page.waitForFunction((b) => document.getElementById('status')!.textContent === b, before)

        // the Properties panel: "Visible" off, then undo
        await page.click('#panel-tab-inspectorPanel')
        const visible = '.inspector [data-section="SECTION_GENERAL"] [data-property="isVisible"] input'
        await page.waitForSelector(visible)
        expect(await page.isChecked(visible)).toBe(true)
        await page.click(visible)
        await page.waitForFunction((sel) => !document.querySelector<HTMLInputElement>(sel)!.checked, visible)
        expect(await page.textContent('#title')).toMatch(/^\*/)
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+z')
        await page.waitForFunction((sel) => document.querySelector<HTMLInputElement>(sel)!.checked, visible)
        expect(await page.textContent('#title')).not.toMatch(/^\*/)

        // the notehead parentheses (Score::cmdAddParenthesesToNotes), then undo
        const notation = '.inspector [data-section="SECTION_NOTATION"]'
        if (await page.getAttribute(`${notation} .insp-section-header`, 'aria-expanded') !== 'true') {
            await page.click(`${notation} .insp-section-header`)
        }
        const withParens = `${notation} [role="radio"][aria-label="Notehead with parentheses"]`
        await page.waitForSelector(withParens)
        expect(await page.getAttribute(withParens, 'aria-checked')).toBe('false')
        await page.click(withParens)
        await page.waitForFunction((sel) => document.querySelector(sel)!.getAttribute('aria-checked') === 'true', withParens)
        expect(await page.textContent('#title')).toMatch(/^\*/)
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+z')
        await page.waitForFunction((sel) => document.querySelector(sel)!.getAttribute('aria-checked') === 'false', withParens)
        expect(await page.textContent('#title')).not.toMatch(/^\*/)
        await context.close()
    }, 180000)

    it('shows the panels Palettes, Layout and Properties, toggled by the View menu and shortcuts', async () => {
        const { page, context } = await newPage()
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        const tabs = (): Promise<string[]> => page.$$eval('.panel-tabs [role="tab"]', t => t.map(x => x.textContent ?? ''))
        const currentTab = (): Promise<string | null> => page.textContent('.panel-tabs [role="tab"][aria-selected="true"]')
        expect(await tabs()).toEqual(['Palettes', 'Layout', 'Properties'])
        expect(await currentTab()).toBe('Palettes')

        // View > Properties hides it (checked menu item), F9 hides the palettes, F7 the layout panel
        await page.click('.menubar > button:has-text("View")')
        expect(await page.getAttribute('.menu-item:has-text("Properties")', 'aria-checked')).toBe('true')
        await page.click('.menu-item:has-text("Properties")')
        await page.waitForFunction(() => document.querySelectorAll('.panel-tabs [role="tab"]').length === 2)
        await page.keyboard.press('F9')
        await page.waitForFunction(() => document.querySelectorAll('.panel-tabs [role="tab"]').length === 1)
        expect(await currentTab()).toBe('Layout')
        await page.keyboard.press('F7')
        await page.waitForFunction(() => !document.querySelector('.panel-dock'))
        // showing a panel makes it the current tab
        await page.keyboard.press('F9')
        await page.waitForSelector('.panel-dock')
        expect(await tabs()).toEqual(['Palettes'])

        // the tab's menu closes it; keyboard navigation between tabs
        await page.keyboard.press('F7')
        await page.waitForFunction(() => document.querySelectorAll('.panel-tabs [role="tab"]').length === 2)
        expect(await currentTab()).toBe('Layout')
        await page.focus('.panel-tabs [role="tab"][aria-selected="true"]')
        await page.keyboard.press('ArrowLeft')
        expect(await currentTab()).toBe('Palettes')
        await page.click('.panel-tab.current .panel-tab-menu')
        await page.click('.menu-item:has-text("Close")')
        await page.waitForFunction(() => document.querySelectorAll('.panel-tabs [role="tab"]').length === 1)
        expect(await tabs()).toEqual(['Layout'])

        // the width: dragging the splitter; kept with the open panels across reloads
        const dockWidth = (): Promise<number> => page.$eval('.panel-dock', d => d.getBoundingClientRect().width)
        expect(await dockWidth()).toBe(300)
        const s = (await page.locator('.panel-splitter').boundingBox())!
        await page.mouse.move(s.x + 2, s.y + 200)
        await page.mouse.down()
        await page.mouse.move(s.x + 82, s.y + 200, { steps: 5 })
        await page.mouse.up()
        expect(await dockWidth()).toBe(380)
        await page.reload()
        await reopen(page)
        expect(await tabs()).toEqual(['Layout'])
        expect(await dockWidth()).toBe(380)

        // "Restore the default layout"
        await page.click('.menubar > button:has-text("View")')
        await page.click('.menu-item:has-text("Restore the default layout")')
        await page.waitForFunction(() => document.querySelectorAll('.panel-tabs [role="tab"]').length === 3)
        expect(await currentTab()).toBe('Palettes')
        expect(await dockWidth()).toBe(300)
        await context.close()
    }, 120000)

    it('collapses the panel area to a strip and expands it again', async () => {
        const { page, context } = await newPage()
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        const dockWidth = (): Promise<number> => page.$eval('.panel-dock', d => d.getBoundingClientRect().width)
        const viewportWidth = async (): Promise<number> => (await page.locator('#viewport').boundingBox())!.width
        const wide = await viewportWidth()
        await page.click('.panel-collapse[aria-label="Collapse"]')
        await page.waitForSelector('.panel-dock.collapsed')
        expect(await dockWidth()).toBe(32)
        expect(await page.$$eval('.panel-strip-tab', t => t.map(x => x.textContent))).toEqual(['Palettes', 'Layout', 'Properties'])
        expect(await page.locator('.panel-splitter').count()).toBe(0)
        expect(await viewportWidth()).toBeGreaterThan(wide + 200)
        // kept across reloads; a tab of the strip expands the panel area with that panel
        await page.reload()
        await reopen(page)
        await page.waitForSelector('.panel-dock.collapsed')
        await page.click('.panel-strip-tab:has-text("Layout")')
        await page.waitForSelector('.panel-dock:not(.collapsed)')
        expect(await page.textContent('.panel-tabs [role="tab"][aria-selected="true"]')).toBe('Layout')
        expect(await dockWidth()).toBe(300)
        // the expand button, and showing a panel (F9) expand it, too
        await page.click('.panel-collapse')
        await page.click('.panel-collapse[aria-label="Expand"]')
        await page.waitForSelector('.panel-dock:not(.collapsed)')
        await page.click('.panel-collapse')
        await page.click('.page')
        await page.keyboard.press('F9')
        await page.waitForSelector('.panel-dock:not(.collapsed)')
        expect(await page.textContent('.panel-tabs [role="tab"][aria-selected="true"]')).toBe('Palettes')
        await context.close()
    }, 120000)

    it('shows the palettes with rendered cells, search and keyboard navigation', async () => {
        const { page, context } = await newPage()
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        await page.waitForSelector('.palettes-panel .palette-tree-item[data-palette-type="Clef"]')
        // expand the clefs: the cells are drawn
        await page.click('.palette-tree-item[data-palette-type="Clef"] .palette-header')
        await page.waitForSelector('.palette-tree-item[data-palette-type="Clef"] .palette-header[aria-expanded="true"]')
        const cell = '.palette-tree-item[data-palette-type="Clef"] .palette-cell[data-element="Clef"]'
        expect(await page.getAttribute(cell, 'title')).toBe('Treble clef')
        const inked = await page.waitForFunction((sel) => {
            const c = document.querySelector<HTMLCanvasElement>(`${sel} canvas.palette-cell-canvas`)
            const d = c?.getContext('2d')?.getImageData(0, 0, c.width, c.height).data
            return !!d && d.some((v, i) => i % 4 === 3 && v > 0)
        }, cell).then(() => true)
        expect(inked).toBe(true)
        // arrows move between the cells
        await page.focus(`${cell}:first-child`)
        const label = (): Promise<string | null> => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null)
        const first = await label()
        await page.keyboard.press('ArrowRight')
        expect(await label()).not.toBe(first)
        await page.keyboard.press('ArrowLeft')
        expect(await label()).toBe(first)
        // the search
        await page.click('.palette-search-button')
        await page.fill('.palette-search input', 'trill')
        await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('.palette-tree-item')].map(e => e.dataset.paletteType).join() === 'Ornament,Line')
        await context.close()
    }, 120000)

    it('lists the parts of the score in the Layout panel, synced with the selection', async () => {
        const { page, context } = await newPage()
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        await page.click('#panel-tab-instrumentsPanel')
        const parts = await page.$$eval('.layout-tree [role="treeitem"][data-type="part"]', r => r.map(x => x.getAttribute('aria-label')))
        expect(parts).toEqual(['Soprano', 'Alto', 'Tenor', 'Bass'])
        expect(await page.locator('.layout-tree [data-type="system-objects"]').count()).toBeGreaterThan(0)
        // expanding a part shows its staff and the "Add staff" row
        await page.click('.layout-tree [data-type="part"] .expand')
        await page.waitForSelector('.layout-tree [data-type="part"][aria-expanded="true"]')
        expect(await page.locator('.layout-tree [data-type="staff"]').count()).toBe(1)
        expect(await page.locator('.layout-tree [data-type="control"]').count()).toBe(1)
        // the score selection selects the rows of its parts
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+a')
        await page.waitForFunction(() => document.querySelectorAll('.layout-tree [data-type="part"][aria-selected="true"]').length === 4)
        await page.keyboard.press('Escape')
        await page.waitForFunction(() => document.querySelectorAll('.layout-tree [aria-selected="true"]').length === 0)
        await context.close()
    }, 120000)

    it('replaces an instrument and adds an instrument change with the Select instrument dialog', async () => {
        const { page, context } = await newPage()
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        await page.click('#panel-tab-instrumentsPanel')
        const soprano = '.layout-tree [data-type="part"][aria-label="Soprano"]'
        const chooseClarinet = async (): Promise<void> => {
            await page.waitForSelector('dialog.select-instrument[open]')
            expect(await page.textContent('dialog.select-instrument h2')).toBe('Select instrument')
            // only the families and the instruments (no "Your score" list)
            expect(await page.locator('dialog.select-instrument .on-score').count()).toBe(0)
            await page.fill('dialog.select-instrument .instruments input[type="search"]', 'clarinet')
            await page.click('dialog.select-instrument .instruments [role="option"] .item-name >> text=/^Clarinet$/')
            await page.click('dialog.select-instrument .dialog-buttons .primary')
            await page.waitForSelector('dialog.select-instrument', { state: 'detached' })
        }

        // Layout panel: the instrument's settings, "Replace instrument"
        await page.hover(soprano)
        await page.click(`${soprano} .settings`)
        await page.click('.layout-settings-popup .replace-instrument')
        await chooseClarinet()
        await page.waitForFunction(() => document.querySelector('.layout-tree [data-type="part"]')!.getAttribute('aria-label')!.includes('Clarinet'))
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+z')
        await page.waitForSelector(soprano)

        // the instrument change of the Text palette asks for the instrument first; Cancel adds nothing
        await page.click('#panel-tab-palettesPanel')
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+Home')
        for (let i = 0; i < 8 && !(await page.textContent('#status'))!.startsWith('Note'); i++) {
            await page.keyboard.press('ArrowRight')
        }
        await page.click('.palette-tree-item[data-palette-type="Text"] .palette-header')
        const cell = '.palette-tree-item[data-palette-type="Text"] .palette-cell[aria-label="Instrument change"]'
        await page.waitForSelector(cell)
        await page.click(cell)
        await page.waitForSelector('dialog.select-instrument[open]')
        await page.click('dialog.select-instrument .dialog-buttons .secondary')
        await page.waitForSelector('dialog.select-instrument', { state: 'detached' })
        expect(await page.textContent('#status')).toMatch(/^Note/)
        await page.click(cell)
        await chooseClarinet()
        await page.waitForFunction(() => /^Instrument change/.test(document.getElementById('status')!.textContent!))
        expect(await page.textContent('#status')).toContain('To Clarinet')
        await context.close()
    }, 120000)

    it('opens the Staff/Part properties from the context menu of an instrument name and applies them (undoable)', async () => {
        const { page, context } = await newPage()
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        // the instrument name "Soprano" of the first system
        const box = (await page.locator('.page').first().boundingBox())!
        await page.mouse.click(box.x + box.width * 0.09, box.y + box.height * 0.152, { button: 'right' })
        await page.waitForSelector('.menu-popup')
        const titles = await page.$$eval('.menu-popup .menu-title', e => e.map(x => x.textContent))
        expect(titles).toContain('Staff/Part properties…')
        await page.click('.menu-popup .menu-item:has-text("Staff/Part properties…")')
        await page.waitForSelector('dialog.edit-staff[open]')
        expect(await page.inputValue('dialog.edit-staff textarea >> nth=0')).toBe('Soprano')
        // Advanced style properties: the staff type with a preview
        await page.click('dialog.edit-staff .advanced-style')
        await page.waitForSelector('dialog.edit-staff-type[open]')
        expect(await page.textContent('dialog.edit-staff-type .group-name')).toBe('STANDARD STAFF')
        await page.waitForFunction(() => {
            const c = document.querySelector<HTMLCanvasElement>('dialog.edit-staff-type .staff-type-preview')!
            const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
            return d.some((v, i) => i % 4 === 0 && v < 128)
        })
        await page.click('dialog.edit-staff-type .dialog-buttons .secondary')
        await page.waitForSelector('dialog.edit-staff-type', { state: 'detached' })
        const lines = 'dialog.edit-staff .edit-staff-grid input[type="number"] >> nth=0'
        expect(await page.inputValue(lines)).toBe('5')
        await page.fill(lines, '1')
        await page.click('dialog.edit-staff .dialog-buttons .primary')
        await page.waitForSelector('dialog.edit-staff', { state: 'detached' })
        expect(await page.textContent('#title')).toMatch(/^\*/)
        // one undo step
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+z')
        await page.waitForFunction(() => !document.getElementById('title')!.textContent!.startsWith('*'))
        await context.close()
    }, 120000)

    it('runs the tools of the Tools menu (Explode, Realize chord symbols dialog)', async () => {
        const { page, context } = await newPage()
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+a') // select all
        await page.click('.menubar > button:has-text("Tools")')
        for (const title of ['Explode', 'Implode', 'Remove selected range', 'Fill with slashes', 'Regroup rhythms']) {
            expect(await page.getAttribute(`.menu-popup .menu-item:has-text("${title}")`, 'aria-disabled')).toBe('false')
        }
        await page.click('.menu-popup .menu-item:has-text("Fill with slashes")')
        await page.waitForFunction(() => document.getElementById('title')!.textContent!.startsWith('*'))

        // Realize chord symbols: the dialog of the selected chord symbols
        await page.click('.menubar > button:has-text("Tools")')
        await page.click('.menu-popup .menu-item:has-text("Realize chord symbols")')
        await page.waitForSelector('dialog.realize-dialog[open]')
        expect(await page.textContent('dialog.realize-dialog h2')).toBe('Realize chord symbols')
        expect(await page.isDisabled('dialog.realize-dialog select >> nth=0')).toBe(true) // not overridden
        await page.check('dialog.realize-dialog legend input[type="checkbox"]')
        expect(await page.isDisabled('dialog.realize-dialog select >> nth=0')).toBe(false)
        await page.click('dialog.realize-dialog .dialog-buttons .secondary >> nth=1') // Cancel
        await page.waitForSelector('dialog.realize-dialog', { state: 'detached' })
        await context.close()
    }, 120000)

    it('adds measures with the number dialog and a tuplet with the tuplet dialog (Add menu)', async () => {
        const { page, context } = await newPage()
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        const box = (await page.locator('.page').first().boundingBox())!

        // Add > Measures > Insert at end of score…: 30 measures (one undo step)
        await page.click('.menubar > button:has-text("Add")')
        await page.hover('.menu-item:has-text("Measures")')
        await page.click('.menu-item:has-text("Insert at end of score…")')
        await page.waitForSelector('dialog.measures-count-dialog[open]')
        await page.fill('dialog.measures-count-dialog input[type="number"]', '30')
        await page.click('dialog.measures-count-dialog .dialog-buttons .primary')
        await page.waitForSelector('dialog.measures-count-dialog', { state: 'detached' })
        await page.waitForFunction(() => document.getElementById('title')!.textContent!.startsWith('*'))
        // the added measures (from 18) are selected
        expect(await page.textContent('#status')).toMatch(/^Range selection; Start measure: 18;/)
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+z')
        await page.waitForFunction(() => !document.getElementById('title')!.textContent!.startsWith('*'))

        // Add > Tuplets > Other…: disabled without a note or rest, a 5:4 tuplet on the first rest of the soprano
        await page.mouse.click(box.x + box.width * 0.22, box.y + box.height * 0.155)
        await page.waitForFunction(() => document.getElementById('status')!.textContent!.startsWith('Rest;'))
        await page.click('.menubar > button:has-text("Add")')
        await page.hover('.menu-item:has-text("Tuplets")')
        await page.click('.menu-item:has-text("Other…")')
        await page.waitForSelector('dialog.tuplet-dialog[open]')
        expect(await page.textContent('dialog.tuplet-dialog h2')).toBe('Create tuplet')
        await page.fill('dialog.tuplet-dialog .ratio input >> nth=0', '5')
        await page.fill('dialog.tuplet-dialog .ratio input >> nth=1', '4')
        await page.click('dialog.tuplet-dialog .dialog-buttons .primary')
        await page.waitForSelector('dialog.tuplet-dialog', { state: 'detached' })
        await page.waitForFunction(() => /^(Rest|Note|Chord);.*Tuplet/i.test(document.getElementById('status')!.textContent!)
            || document.getElementById('title')!.textContent!.startsWith('*'))
        expect(await page.textContent('#title')).toMatch(/^\*/)
        await context.close()
    }, 120000)

    it('formats the score with Page settings and Measures per system (Format menu, undoable)', async () => {
        const { page, context } = await newPage()
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        const pages = await page.locator('.page').count()
        const openFormat = async (title: string): Promise<void> => {
            await page.click('.menubar > button:has-text("Format")')
            await page.click(`.menu-popup .menu-item:has-text("${title}")`)
        }

        // Page settings: a larger staff space gives more pages at once; Cancel reverts it
        await openFormat('Page settings…')
        await page.waitForSelector('dialog.page-settings[open]')
        expect(await page.textContent('dialog.page-settings h2')).toBe('Page settings')
        const spatium = Number(await page.inputValue('dialog.page-settings input[data-name="spatiumEntry"]'))
        await page.fill('dialog.page-settings input[data-name="spatiumEntry"]', String(spatium * 2))
        await page.press('dialog.page-settings input[data-name="spatiumEntry"]', 'Enter')
        await page.waitForFunction(n => document.querySelectorAll('.page').length > n, pages)
        await page.click('dialog.page-settings .dialog-buttons button:has-text("Cancel")')
        await page.waitForSelector('dialog.page-settings', { state: 'detached' })
        await page.waitForFunction(n => document.querySelectorAll('.page').length === n, pages)
        expect(await page.textContent('#title')).not.toMatch(/^\*/)

        // landscape, OK: one undo step
        await openFormat('Page settings…')
        await page.waitForSelector('dialog.page-settings[open]')
        await page.check('dialog.page-settings input[name="orientation"] >> nth=1')
        await page.click('dialog.page-settings .dialog-buttons .primary')
        await page.waitForSelector('dialog.page-settings', { state: 'detached' })
        await page.waitForFunction(() => document.getElementById('title')!.textContent!.startsWith('*'))
        const landscape = await page.locator('.page').first().boundingBox()
        expect(landscape!.width).toBeGreaterThan(landscape!.height)
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+z')
        await page.waitForFunction(() => !document.getElementById('title')!.textContent!.startsWith('*'))

        // Measures per system: 2 measures per system for the whole score
        await openFormat('Measures per system…')
        await page.waitForSelector('dialog.breaks-dialog[open]')
        await page.fill('dialog.breaks-dialog input[type="number"]', '2')
        await page.click('dialog.breaks-dialog .dialog-buttons .primary')
        await page.waitForSelector('dialog.breaks-dialog', { state: 'detached' })
        await page.waitForFunction(() => document.getElementById('title')!.textContent!.startsWith('*'))
        await page.waitForFunction(n => document.querySelectorAll('.page').length > n, pages)
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+z')
        await page.waitForFunction(() => !document.getElementById('title')!.textContent!.startsWith('*'))
        await context.close()
    }, 120000)

    it('edits the style with the Style dialog', async () => {
        const { page, context } = await newPage()
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        const pages = await page.locator('.page').count()
        const openStyle = async (): Promise<void> => {
            await page.click('.menubar > button:has-text("Format")')
            await page.click('.menu-popup .menu-item:has-text("Style…")')
            await page.waitForSelector('dialog.edit-style[open]')
        }
        const staffDistance = 'dialog.edit-style input[data-name="staffDistance"]'

        // a larger distance between staves gives more pages at once; Cancel reverts it
        await openStyle()
        expect(await page.textContent('dialog.edit-style h2')).toBe('Style')
        await page.click('dialog.edit-style .es-pagelist [role="option"]:has-text("Spacing")')
        expect(await page.isDisabled('dialog.edit-style button[data-name="resetStaffDistance"]')).toBe(true)
        await page.fill(staffDistance, '20')
        await page.press(staffDistance, 'Enter')
        await page.waitForFunction(n => document.querySelectorAll('.page').length > n, pages)
        expect(await page.isDisabled('dialog.edit-style button[data-name="resetStaffDistance"]')).toBe(false)
        await page.click('dialog.edit-style .dialog-buttons button:has-text("Cancel")')
        await page.waitForSelector('dialog.edit-style', { state: 'detached' })
        await page.waitForFunction(n => document.querySelectorAll('.page').length === n, pages)
        expect(await page.textContent('#title')).not.toMatch(/^\*/)

        // the dialog opens on the last page; a check box and OK: one undo step
        await openStyle()
        expect(Number(await page.inputValue(staffDistance))).toBe(6.5)
        await page.fill(staffDistance, '20')
        await page.press(staffDistance, 'Enter')
        await page.waitForFunction(n => document.querySelectorAll('.page').length > n, pages)
        await page.click('dialog.edit-style .es-pagelist [role="option"]:text-is("Score")')
        await page.check('dialog.edit-style input[data-name="hideEmptyStaves"]')
        await page.click('dialog.edit-style .dialog-buttons .primary')
        await page.waitForSelector('dialog.edit-style', { state: 'detached' })
        await page.waitForFunction(() => document.getElementById('title')!.textContent!.startsWith('*'))
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+z')
        await page.waitForFunction(() => !document.getElementById('title')!.textContent!.startsWith('*'))
        await page.waitForFunction(n => document.querySelectorAll('.page').length === n, pages)
        await context.close()
    }, 120000)

    it('goes to a measure with Find / Go to and edits the project properties (undoable)', async () => {
        const { page, context } = await newPage()
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)

        // Find / Go to (Ctrl+F): typing selects the measure, Enter closes the bar
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+f')
        await page.waitForSelector('.search-popup input:focus')
        await page.keyboard.type('5')
        await page.waitForFunction(() => /^Range selection; Start measure: 5;/.test(document.getElementById('status')!.textContent!))
        await page.keyboard.press('Enter')
        await page.waitForSelector('.search-popup', { state: 'detached' })

        // File > Project properties…: change the title of the work, OK; one undo step
        await page.click('.menubar > button:has-text("File")')
        await page.click('.menu-popup .menu-item:has-text("Project properties…")')
        await page.waitForSelector('dialog.project-properties[open]')
        expect(await page.textContent('dialog.project-properties h2')).toBe('Project properties')
        await page.fill('dialog.project-properties input[aria-label="Work title"]', 'A new title')
        await page.click('dialog.project-properties .dialog-buttons button:has-text("New property")')
        await page.keyboard.type('myProperty')
        await page.fill('dialog.project-properties .property-row:last-child input[aria-label="Value"]', 'x')
        await page.click('dialog.project-properties .dialog-buttons .primary')
        await page.waitForSelector('dialog.project-properties', { state: 'detached' })
        await page.waitForFunction(() => document.getElementById('title')!.textContent!.startsWith('*'))
        await page.click('.menubar > button:has-text("File")')
        await page.click('.menu-popup .menu-item:has-text("Project properties…")')
        expect(await page.inputValue('dialog.project-properties input[aria-label="Work title"]')).toBe('A new title')
        expect(await page.locator('dialog.project-properties input[value="myProperty"]').count()).toBe(1)
        await page.click('dialog.project-properties .dialog-buttons button:has-text("Cancel")')
        await page.waitForSelector('dialog.project-properties', { state: 'detached' })
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+z')
        await page.waitForFunction(() => !document.getElementById('title')!.textContent!.startsWith('*'))
        await context.close()
    }, 120000)

    it('opens a part from the Parts dialog and edits it', async () => {
        const { page, context } = await newPage()
        await context.route(`${SCORE_HOST}parts.mscx`, route => route.fulfill({
            body: readFileSync(`${ROOT}MuseScore/src/engraving/tests/parts_data/part-all.mscx`),
            headers: { 'access-control-allow-origin': '*' },
        }))
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}parts.mscx`)}`)
        await scoreShown(page)
        expect(await page.locator('.notation-tab').count()).toBe(1)

        // File > Parts…: the parts of the instruments (not created yet); select both (Shift+click) and open them
        await page.click('.menubar > button:has-text("File")')
        await page.click('.menu-popup .menu-item:has-text("Parts…")')
        await page.waitForSelector('dialog.parts-dialog[open]')
        expect(await page.$$eval('dialog.parts-dialog .part-title', els => els.map(e => e.textContent))).toEqual(['Alto', 'Tenor'])
        expect(await page.isDisabled('dialog.parts-dialog .dialog-buttons .primary')).toBe(true)
        await page.click('dialog.parts-dialog .part-row >> nth=0')
        await page.click('dialog.parts-dialog .part-row >> nth=1', { modifiers: ['Shift'] })
        await page.click('dialog.parts-dialog .dialog-buttons .primary') // Open selected
        await page.waitForSelector('dialog.parts-dialog', { state: 'detached' })
        await page.waitForFunction(() => document.querySelectorAll('.notation-tab').length === 3)
        expect(await page.textContent('.notation-tab[aria-selected="true"] .notation-tab-title')).toBe('Tenor')
        // creating the parts is a change of the score
        await page.waitForFunction(() => document.getElementById('title')!.textContent!.startsWith('*'))

        // linked editing: deleting the first measure's notes in the part changes the score; undo restores it
        const scorePage = async (): Promise<Buffer> => {
            await page.waitForTimeout(300) // the redraw
            return page.locator('.page').first().screenshot()
        }
        await page.click('.notation-tab >> nth=0')
        const scoreBefore = await scorePage()
        await page.click('.notation-tab >> nth=2') // Tenor
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+f')
        await page.keyboard.type('1')
        await page.keyboard.press('Enter')
        await page.waitForFunction(() => /^Range selection/.test(document.getElementById('status')!.textContent!))
        await page.keyboard.press('Delete')
        await page.click('.notation-tab >> nth=0')
        expect((await scorePage()).equals(scoreBefore)).toBe(false)
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+z')
        expect((await scorePage()).equals(scoreBefore)).toBe(true)
        // and the other way round: deleting in the score (Find selects the measure in the top staff) changes the part
        await page.click('.notation-tab >> nth=1') // Alto
        const partBefore = await scorePage()
        await page.click('.notation-tab >> nth=0')
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+f')
        await page.keyboard.type('1')
        await page.keyboard.press('Enter')
        await page.waitForFunction(() => /^Range selection/.test(document.getElementById('status')!.textContent!))
        await page.keyboard.press('Delete')
        await page.click('.notation-tab >> nth=1')
        expect((await scorePage()).equals(partBefore)).toBe(false)
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+z')
        expect((await scorePage()).equals(partBefore)).toBe(true)

        // editing in the part: one more undo step, undo reverts it
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+f')
        await page.keyboard.type('1')
        await page.keyboard.press('Enter')
        await page.waitForFunction(() => /^Range selection/.test(document.getElementById('status')!.textContent!))
        await page.click('.menubar > button:has-text("Format")')
        await page.hover('.menu-item:has-text("Stretch")')
        await page.click('.menu-item:has-text("Increase layout stretch")')
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+z') // the stretch
        await page.keyboard.press('ControlOrMeta+z') // the parts
        await page.waitForFunction(() => !document.getElementById('title')!.textContent!.startsWith('*'))
        // the undone parts: their tabs are gone
        await page.waitForFunction(() => document.querySelectorAll('.notation-tab').length === 1)
        expect(await page.getAttribute('.notation-tab >> nth=0', 'aria-selected')).toBe('true')
        await context.close()
    }, 120000)

    it('shows the instruments of a part in the Layout panel, the staff settings and the tabs\' context menu', async () => {
        const { page, context } = await newPage()
        await context.route(`${SCORE_HOST}parts.mscx`, route => route.fulfill({
            body: readFileSync(`${ROOT}MuseScore/src/engraving/tests/parts_data/part-all.mscx`),
            headers: { 'access-control-allow-origin': '*' },
        }))
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}parts.mscx`)}`)
        await scoreShown(page)
        await page.click('.menubar > button:has-text("File")')
        await page.click('.menu-popup .menu-item:has-text("Parts…")')
        await page.waitForSelector('dialog.parts-dialog[open]')
        await page.click('dialog.parts-dialog .part-row >> nth=0')
        await page.click('dialog.parts-dialog .part-row >> nth=1', { modifiers: ['Shift'] })
        await page.click('dialog.parts-dialog .dialog-buttons .primary')
        await page.waitForFunction(() => document.querySelectorAll('.notation-tab').length === 3)

        // the Layout panel of the Tenor part: the Tenor first, the Alto (not in the part) hidden, no system markings
        await page.click('#panel-tab-instrumentsPanel')
        const partNames = (): Promise<(string | null)[]> =>
            page.$$eval('.layout-tree [role="treeitem"][data-type="part"]', r => r.map(x => x.getAttribute('aria-label')))
        await page.waitForFunction(() => document.querySelectorAll('.layout-tree [data-type="part"]').length === 2)
        expect(await partNames()).toEqual(['Tenor', 'Alto'])
        const alto = '.layout-tree [data-type="part"][aria-label="Alto"]'
        expect(await page.locator(`${alto}.hidden-item`).count()).toBe(1)
        expect(await page.locator('.layout-tree [data-type="system-objects"]').count()).toBe(0)
        // showing the Alto adds it to the part
        await page.click(`${alto} .visibility`)
        await page.waitForSelector(`${alto}:not(.hidden-item)`)

        // the staff settings of the Tenor's staff: the voices of the part
        await page.click('.layout-tree [data-type="part"][aria-label="Tenor"] .expand')
        const staff = '.layout-tree [data-type="staff"] >> nth=0'
        await page.hover(staff)
        await page.click(`${staff} >> .settings`)
        await page.waitForSelector('.layout-settings-popup.staff-settings')
        expect(await page.textContent('.layout-settings-popup')).toContain('Voices visible in the score')
        const voice2 = '.layout-settings-popup .voices input >> nth=1'
        expect(await page.isChecked(voice2)).toBe(true)
        await page.click(voice2)
        await page.waitForFunction(() => !(document.querySelectorAll('.layout-settings-popup .voices input')[1] as HTMLInputElement).checked)
        await page.keyboard.press('Escape')
        await page.waitForSelector('.layout-settings-popup', { state: 'detached' })

        // the context menu of the Alto's tab: close the other tabs (the score's tab stays)
        await page.click('.notation-tab >> nth=1', { button: 'right' })
        await page.waitForSelector('.menu-popup')
        expect(await page.$$eval('.menu-popup .menu-item', els => els.map(e => e.textContent!.trim())))
            .toEqual(['Close tab', 'Close other tabs', 'Close all tabs'])
        await page.click('.menu-popup .menu-item:has-text("Close other tabs")')
        await page.waitForFunction(() => document.querySelectorAll('.notation-tab').length === 2)
        expect(await page.textContent('.notation-tab[aria-selected="true"] .notation-tab-title')).toBe('Alto')
        await context.close()
    }, 120000)

    it('renames an instrument in its settings and rearranges instruments by dragging in the Layout panel', async () => {
        const { page, context } = await newPage()
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        await page.click('#panel-tab-instrumentsPanel')
        const partNames = (): Promise<(string | null)[]> =>
            page.$$eval('.layout-tree [role="treeitem"][data-type="part"]', r => r.map(x => x.getAttribute('aria-label')))
        const soprano = '.layout-tree [data-type="part"][aria-label="Soprano"]'

        // the name on the main score: Enter commits it (one undo step)
        await page.hover(soprano)
        await page.click(`${soprano} .settings`)
        await page.fill('.layout-settings-popup .instrument-name', 'Sopran')
        await page.press('.layout-settings-popup .instrument-name', 'Enter')
        await page.waitForSelector('.layout-tree [data-type="part"][aria-label="Sopran"]')
        await page.keyboard.press('Escape')
        await page.waitForSelector('.layout-settings-popup', { state: 'detached' })

        // dragging the Alto down over the Tenor moves it after the Tenor
        const alto = (await page.locator('.layout-tree [data-type="part"][aria-label="Alto"] .layout-row-title').boundingBox())!
        const tenor = (await page.locator('.layout-tree [data-type="part"][aria-label="Tenor"] .layout-row-title').boundingBox())!
        await page.mouse.move(alto.x + 5, alto.y + alto.height / 2)
        await page.mouse.down()
        await page.mouse.move(alto.x + 5, alto.y + alto.height / 2 + 10, { steps: 3 })
        await page.mouse.move(tenor.x + 5, tenor.y + tenor.height / 2, { steps: 5 })
        await page.mouse.up()
        await page.waitForFunction(() => document.querySelectorAll('.layout-tree [data-type="part"]')[2]?.getAttribute('aria-label') === 'Alto')
        expect(await partNames()).toEqual(['Sopran', 'Tenor', 'Alto', 'Bass'])
        // undo: the order of the score, then the name
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+z')
        await page.waitForFunction(() => document.querySelectorAll('.layout-tree [data-type="part"]')[1]?.getAttribute('aria-label') === 'Alto')
        await page.keyboard.press('ControlOrMeta+z')
        await page.waitForSelector(soprano)
        await context.close()
    }, 120000)

    it('customizes the drum kit from the context menu of a drum staff (Customize kit…)', async () => {
        const { page, context } = await newPage()
        await context.route(`${SCORE_HOST}drums.mscx`, route => route.fulfill({
            body: readFileSync(`${ROOT}MuseScore/vtest/scores/drumset-custom-1.mscx`),
            headers: { 'access-control-allow-origin': '*' },
        }))
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}drums.mscx`)}`)
        await scoreShown(page)
        // the context menu of the drum staff (right-clicks down the first system until the staff is hit)
        const box = (await page.locator('.page').first().boundingBox())!
        let found = false
        for (let f = 0.06; f < 0.35 && !found; f += 0.01) {
            await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * f, { button: 'right' })
            await page.waitForSelector('.menu-popup')
            found = await page.locator('.menu-popup .menu-item:has-text("Customize kit…")').count() > 0
            if (!found) {
                await page.keyboard.press('Escape')
                await page.waitForSelector('.menu-popup', { state: 'detached' })
            }
        }
        expect(found).toBe(true)
        await page.click('.menu-popup .menu-item:has-text("Customize kit…")')
        await page.waitForSelector('dialog.customize-kit[open]')
        expect(await page.locator('dialog.customize-kit .customize-kit-row').count()).toBe(128)
        // the first drum (sorted by name, descending): a change of the staff line changes the score at once
        await page.click('dialog.customize-kit .customize-kit-row >> nth=0')
        const line = 'dialog.customize-kit input[type="number"]'
        const before = Number(await page.inputValue(line))
        await page.fill(line, String(before + 2))
        await page.waitForFunction(() => document.getElementById('title')!.textContent!.startsWith('*'))
        // the shortcut dialog
        await page.click('dialog.customize-kit button.shortcut')
        await page.waitForSelector('dialog.percussion-shortcut[open]')
        await page.focus('dialog.percussion-shortcut .shortcut-input')
        await page.keyboard.press('q')
        expect(await page.textContent('dialog.percussion-shortcut .shortcut-input')).toBe('Q')
        await page.click('dialog.percussion-shortcut .dialog-buttons .secondary:has-text("Cancel")')
        await page.waitForSelector('dialog.percussion-shortcut', { state: 'detached' })
        // Cancel restores the drumset
        await page.click('dialog.customize-kit .dialog-buttons .secondary:has-text("Cancel")')
        await page.waitForSelector('dialog.customize-kit', { state: 'detached' })
        await context.close()
    }, 120000)

    it('selects similar elements from the context menu (Select > Similar, More…)', async () => {
        const { page, context } = await newPage()
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        const status = (): Promise<string> => page.textContent('#status').then(t => t ?? '')
        const box = (await page.locator('.page').first().boundingBox())!
        // the rest at the start of the soprano staff
        const openSelectMenu = async (): Promise<void> => {
            await page.mouse.click(box.x + box.width * 0.22, box.y + box.height * 0.155, { button: 'right' })
            await page.waitForSelector('.menu-popup')
            await page.hover('.menu-popup .menu-item:has-text("Select")')
            await page.waitForSelector('.menu-popup >> nth=1')
        }
        // Escape and a click outside close the context menu
        const openMenu = async (): Promise<void> => {
            await page.mouse.click(box.x + box.width * 0.22, box.y + box.height * 0.155, { button: 'right' })
            await page.waitForSelector('.menu-popup')
        }
        await openMenu()
        await page.keyboard.press('Escape')
        await page.waitForSelector('.menu-popup', { state: 'detached' })
        await openMenu()
        await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.9)
        await page.waitForSelector('.menu-popup', { state: 'detached' })
        await openMenu()
        await page.mouse.click(5, 5) // outside of the score view
        await page.waitForSelector('.menu-popup', { state: 'detached' })

        // the same for the menus of the side panels (here: the menu of a palette)
        const header = '.palette-tree-item[data-palette-type="Clef"] .palette-header'
        const menuButton = '.palette-tree-item[data-palette-type="Clef"] .palette-menu-button'
        const openPaletteMenu = async (): Promise<void> => {
            await page.hover(header)
            await page.click(menuButton)
            await page.waitForSelector('.menu-popup')
        }
        await openPaletteMenu()
        await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.9) // the score
        await page.waitForSelector('.menu-popup', { state: 'detached' })
        await openPaletteMenu()
        await page.keyboard.press('Escape')
        await page.waitForSelector('.menu-popup', { state: 'detached' })
        await openPaletteMenu()
        await page.click(menuButton) // the menu button closes its menu (and does not open it again)
        await page.waitForSelector('.menu-popup', { state: 'detached' })

        await openSelectMenu()
        await page.click('.menu-popup >> nth=1 >> .menu-item:has-text("Similar") >> nth=0')
        await page.waitForFunction(() => document.getElementById('status')!.textContent === 'List selection')

        // More…: the Select dialog of the rest (same duration only for rests)
        await page.mouse.click(box.x + box.width * 0.22, box.y + box.height * 0.155)
        await page.waitForFunction(() => document.getElementById('status')!.textContent!.startsWith('Rest;'))
        await openSelectMenu()
        await page.click('.menu-popup >> nth=1 >> .menu-item:has-text("More…")')
        await page.waitForSelector('dialog.select-dialog[open]')
        expect(await page.textContent('dialog.select-dialog h2')).toBe('Select')
        expect(await page.isDisabled('dialog.select-dialog label:has-text("Same duration") input')).toBe(false)
        await page.check('dialog.select-dialog label:has-text("Same staff") input')
        await page.click('dialog.select-dialog .dialog-buttons .primary')
        await page.waitForSelector('dialog.select-dialog', { state: 'detached' })
        expect(await status()).toBe('List selection')
        await context.close()
    }, 120000)

    it('edits the instruments in the Layout panel: hides a part, undoes, removes and adds instruments', async () => {
        const { page, context } = await newPage()
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        await page.click('#panel-tab-instrumentsPanel')
        const partNames = (): Promise<(string | null)[]> =>
            page.$$eval('.layout-tree [role="treeitem"][data-type="part"]', r => r.map(x => x.getAttribute('aria-label')))
        const alto = '.layout-tree [data-type="part"][aria-label="Alto"]'
        const undoButton = '.tool-button[data-action="action://notation/undo"]'

        // the eye button hides the part and its staff (undoable: "Hide instrument", "Hide staff", like MuseScore)
        expect(await page.isDisabled(`${alto} .visibility`)).toBe(false)
        await page.click(`${alto} .visibility`)
        await page.waitForSelector(`${alto}.hidden-item`)
        expect(await page.getAttribute(`${alto} .visibility`, 'aria-pressed')).toBe('false')
        expect(await page.isDisabled(undoButton)).toBe(false)
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+z')
        await page.keyboard.press('ControlOrMeta+z')
        await page.waitForSelector(`${alto}:not(.hidden-item)`)
        expect(await page.getAttribute(`${alto} .visibility`, 'aria-pressed')).toBe('true')

        // the selected instrument is removed with the remove button; the score has one staff less
        await page.click(`${alto} .layout-row-title`)
        await page.waitForSelector(`${alto}[aria-selected="true"]`)
        await page.click('.layout-controls [data-control="remove"]')
        await page.waitForFunction(() => document.querySelectorAll('.layout-tree [data-type="part"]').length === 3)
        expect(await partNames()).toEqual(['Soprano', 'Tenor', 'Bass'])

        // Add > New instrument opens the instruments dialog; the chosen instrument is added to the score
        await page.click('.layout-add-button')
        await page.click('.menu-item:has-text("New instrument")')
        await page.waitForSelector('dialog.instruments-dialog[open]')
        await page.fill('dialog.instruments-dialog .instruments input[type="search"]', 'flute')
        await page.dblclick('dialog.instruments-dialog .instruments [role="option"] >> text=Flute')
        await page.click('dialog.instruments-dialog .dialog-buttons button:has-text("OK")')
        await page.waitForFunction(() => document.querySelectorAll('.layout-tree [data-type="part"]').length === 4)
        expect(await partNames()).toContain('Flute')

        // undo removes the flute again, a second undo restores the alto
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+z')
        await page.waitForFunction(() => document.querySelectorAll('.layout-tree [data-type="part"]').length === 3)
        await page.keyboard.press('ControlOrMeta+z')
        await page.waitForFunction(() => document.querySelectorAll('.layout-tree [data-type="part"]').length === 4)
        expect(await partNames()).toEqual(['Soprano', 'Alto', 'Tenor', 'Bass'])
        await context.close()
    }, 180000)

    it('shows the values of the selection in the Properties panel', async () => {
        const { page, context } = await newPage()
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        await page.keyboard.press('F9') // hide the palettes: the properties are the first tab
        await page.click('#panel-tab-inspectorPanel')
        // without a selection: the score sections
        await page.waitForSelector('.inspector [data-section="SECTION_SCORE_DISPLAY"]')
        expect(await page.textContent('.inspector [data-section="SECTION_SCORE_APPEARANCE"] .insp-section-title')).toBe('Score appearance')
        // a note
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+Home')
        for (let i = 0; i < 8 && !(await page.textContent('#status'))!.startsWith('Note'); i++) {
            await page.keyboard.press('ArrowRight')
        }
        expect(await page.textContent('#status')).toMatch(/^Note/)
        await page.waitForSelector('.inspector [data-section="SECTION_NOTATION"]')
        expect(await page.isChecked('.inspector [data-section="SECTION_GENERAL"] [data-property="isVisible"] input')).toBe(true)
        expect(await page.textContent('.inspector [data-section="SECTION_NOTATION"] .insp-section-title')).toBe('Note')
        expect(await page.textContent('[data-view="NoteSettings"] .insp-tabbar [role="tab"][aria-selected="true"]')).toBe('Head')
        expect(await page.isChecked('[data-view="NoteSettings"] [data-property="isHeadHidden"] input')).toBe(false)
        // the whole score: measures
        await page.keyboard.press('ControlOrMeta+a')
        await page.waitForSelector('.inspector [data-section="SECTION_MEASURES"]')
        await context.close()
    }, 120000)

    it('keeps the settings of the home screen', async () => {
        const { page, context } = await newPage()
        await page.goto(base)
        await page.click('button[aria-label="List view"]')
        await page.reload()
        await page.waitForSelector('.home')
        expect(await page.getAttribute('button[aria-label="List view"]', 'aria-checked')).toBe('true')
        await context.close()
    })

    // -----------------------------------------------------------------------------------------------------------
    //   copy/paste, text editing, drag, lasso: the positions of the elements come from the same layout in node
    // -----------------------------------------------------------------------------------------------------------

    /** fractions of the first page (x, y) of the chord/rests of the first staff and of the measures of Amazing grace */
    async function amazingGraceLayout(): Promise<{
        cr: { x: number; y: number; type: string }[]
        measures: { left: number; right: number; staffTop: number; staffBottom: number }[]
        tempo: { x: number; y: number } | null
    }> {
        const score = await openScore(`${DEMOS}/Amazing_grace.mscz`)
        const page = score.pages()[0]
        const pw = page.ldata().bbox().width()
        const ph = page.ldata().bbox().height()
        const cr: { x: number; y: number; type: string }[] = []
        const measures: { left: number; right: number; staffTop: number; staffBottom: number }[] = []
        for (let m = score.firstMeasure(); m && measures.length < 6; m = m.nextMeasure()) {
            const r = m.pageBoundingRect()
            const sys = m.system()!
            const st = sys.staff(0)!.bbox().translated(sys.pagePos())
            measures.push({ left: r.left() / pw, right: r.right() / pw, staffTop: st.top() / ph, staffBottom: st.bottom() / ph })
            for (let s = m.first(SegmentType.ChordRest); s; s = s.next(SegmentType.ChordRest)) {
                const e = s.element(0)
                if (e) {
                    const target = e.isChord() ? (e as unknown as Chord).upNote() : e
                    const c = target.pageBoundingRect().center()
                    cr.push({ x: c.x() / pw, y: c.y() / ph, type: e.typeName() })
                }
            }
        }
        let tempo: { x: number; y: number } | null = null
        score.scanElements(e => {
            if (!tempo && e.isText() && e.parent()?.isVBox()) { // the title
                const c = e.pageBoundingRect().center()
                tempo = { x: c.x() / pw, y: c.y() / ph }
            }
        })
        return { cr, measures, tempo }
    }

    async function openAmazingGrace(): Promise<{ page: Page; context: BrowserContext; box: { x: number; y: number; width: number; height: number } }> {
        const { page, context } = await newPage()
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        const box = (await page.locator('.page').first().boundingBox())!
        // a selection and its end repaint the pages like after the edits (the first paint differs in antialiasing)
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+a')
        await page.waitForTimeout(500)
        await page.keyboard.press('Escape')
        await page.waitForTimeout(1000)
        return { page, context, box }
    }

    const statusText = (page: Page): Promise<string> => page.textContent('#status').then(t => t ?? '')
    const undoButton = '.tool-button[data-action="action://notation/undo"]'

    /** keeps the pixels of the first page (to compare later with pixelsChanged) */
    async function pageSnapshot(page: Page): Promise<string> {
        await page.waitForTimeout(400) // the page is redrawn after a change
        await page.evaluate(() => {
            const c = document.querySelector<HTMLCanvasElement>('.page canvas')!
            ;(window as unknown as { snapshot: Uint8ClampedArray }).snapshot = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
        })
        return ''
    }

    /**
     * the number of pixels of the first page that differ from the snapshot (the paint order of equal elements may
     * change after a partial layout, which changes the antialiasing of a few hundred pixels)
     */
    async function pixelsChanged(page: Page): Promise<number> {
        await page.waitForTimeout(400)
        return page.evaluate(() => {
            const c = document.querySelector<HTMLCanvasElement>('.page canvas')!
            const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
            const s = (window as unknown as { snapshot: Uint8ClampedArray }).snapshot
            if (s.length !== d.length) {
                return d.length
            }
            let n = 0
            for (let i = 0; i < d.length; i += 4) {
                if (Math.abs(d[i] - s[i]) > 60 || Math.abs(d[i + 2] - s[i + 2]) > 60) {
                    ++n
                }
            }
            return n
        })
    }

    it('copies a measure and pastes it into another measure (Ctrl+C, Ctrl+V), undoable', async () => {
        const layout = await amazingGraceLayout()
        const { page, context, box } = await openAmazingGrace()
        const at = (fx: number, fy: number): [number, number] => [box.x + box.width * fx, box.y + box.height * fy]

        await pageSnapshot(page)
        // empty staff space in measure 2 selects the measure
        const m2 = layout.measures[1]
        await page.mouse.click(...at(m2.left + (m2.right - m2.left) * 0.9, m2.staffTop + (m2.staffBottom - m2.staffTop) * 0.1))
        await page.waitForFunction(() => document.getElementById('status')!.textContent!.startsWith('Range selection'))
        expect(await statusText(page)).toContain('Start measure: 2')
        await page.keyboard.press('ControlOrMeta+c')

        // the first chord/rest of measure 4
        const m4 = layout.measures[3]
        const target = layout.cr.find(c => c.x > m4.left && c.x < m4.right)!
        await page.mouse.click(...at(target.x, target.y))
        await page.waitForFunction(() => /^(Note|Rest|Chord);.*Measure: 4/.test(document.getElementById('status')!.textContent!))
        const targetStatus = await statusText(page)
        await page.keyboard.press('ControlOrMeta+v')
        await page.waitForFunction(() => document.getElementById('status')!.textContent!.startsWith('Range selection'))
        expect(await statusText(page)).toContain('Start measure: 4')
        expect(await page.isDisabled(undoButton)).toBe(false)
        await page.keyboard.press('Escape')
        expect(await pixelsChanged(page)).toBeGreaterThan(50)
        await page.keyboard.press('ControlOrMeta+z')
        await page.keyboard.press('Escape')
        await page.mouse.click(...at(target.x, target.y))
        await page.waitForFunction(() => /^(Note|Rest|Chord);.*Measure: 4/.test(document.getElementById('status')!.textContent!))
        expect(await statusText(page)).toBe(targetStatus)
        await context.close()
    }, 180000)

    it('adds a staff text (Ctrl+T) and types its text', async () => {
        const layout = await amazingGraceLayout()
        const { page, context, box } = await openAmazingGrace()
        const note = layout.cr.find(c => c.type === 'Chord')!
        await page.mouse.click(box.x + box.width * note.x, box.y + box.height * note.y)
        await page.waitForFunction(() => document.getElementById('status')!.textContent!.startsWith('Note;'))
        await page.keyboard.press('ControlOrMeta+t')
        await page.waitForFunction(() => document.activeElement?.classList.contains('notation-text-input'))
        await page.keyboard.type('Allegro molto')
        await page.keyboard.press('Backspace')
        await page.keyboard.press('Backspace')
        await page.keyboard.press('Escape') // ends text editing, the text stays selected
        await page.waitForFunction(() => document.getElementById('status')!.textContent!.startsWith('Staff text: Allegro mol'))
        expect(await page.isDisabled(undoButton)).toBe(false)
        await context.close()
    }, 180000)

    it('adds lyrics to two notes (Ctrl+L, hyphen to the next note)', async () => {
        const layout = await amazingGraceLayout()
        const { page, context, box } = await openAmazingGrace()
        const notes = layout.cr.filter(c => c.type === 'Chord')
        await page.mouse.click(box.x + box.width * notes[0].x, box.y + box.height * notes[0].y)
        await page.waitForFunction(() => document.getElementById('status')!.textContent!.startsWith('Note;'))
        await page.keyboard.press('ControlOrMeta+l')
        await page.waitForFunction(() => document.activeElement?.classList.contains('notation-text-input'))
        await page.keyboard.type('A')
        await page.keyboard.press('-') // next-syllable
        await page.keyboard.type('maz')
        await page.keyboard.press('Escape')
        await page.waitForFunction(() => /^Lyrics: maz/.test(document.getElementById('status')!.textContent!))
        await page.keyboard.press('ControlOrMeta+z')
        await page.waitForFunction(() => !/^Lyrics: maz/.test(document.getElementById('status')!.textContent!))
        await context.close()
    }, 180000)

    it('creates a custom palette, adds cells by drag and drop, keeps it after a reload; drops cells on the score', async () => {
        const layout = await amazingGraceLayout()
        const { page, context, box } = await openAmazingGrace()
        const at = (fx: number, fy: number): [number, number] => [box.x + box.width * fx, box.y + box.height * fy]

        // Add palettes > Create custom palette
        await page.click('.palettes-header .add-palettes')
        await page.click('.add-palettes-popup button:has-text("Create custom palette")')
        await page.fill('#custom-palette-name', 'My palette')
        await page.click('.add-palettes-popup button:has-text("Create")')
        const custom = '.palette-tree-item[data-palette-type="Custom"]'
        await page.waitForSelector(`${custom} .palette-empty`)
        expect(await page.textContent(`${custom} .palette-name`)).toBe('My palette')
        expect(await page.textContent(`${custom} .palette-empty`)).toBe('Drag and drop any element here')

        // a cell of the clefs dragged into the custom palette
        await page.click('.palette-tree-item[data-palette-type="Clef"] .palette-header')
        const bass = '.palette-tree-item[data-palette-type="Clef"] .palette-cell[aria-label="Bass clef"]'
        await page.dragAndDrop(bass, `${custom} .palette-grid`)
        await page.waitForSelector(`${custom} .palette-cell[aria-label="Bass clef"]`)

        // the title dragged out of the score with Shift+Ctrl onto the custom palette: a custom cell
        const [tx, ty] = at(layout.tempo!.x, layout.tempo!.y)
        const grid = (await page.locator(`${custom} .palette-grid`).boundingBox())!
        await page.keyboard.down('Shift')
        await page.keyboard.down('ControlOrMeta')
        await page.mouse.move(tx, ty)
        await page.mouse.down()
        for (let i = 1; i <= 8; ++i) {
            await page.mouse.move(tx + (grid.x + grid.width / 2 - tx) * i / 8, ty + (grid.y + grid.height / 2 - ty) * i / 8)
        }
        await page.mouse.up()
        await page.keyboard.up('ControlOrMeta')
        await page.keyboard.up('Shift')
        await page.waitForSelector(`${custom} .palette-cell[data-element="Text"]`)

        // the user palettes are kept after a reload
        await page.waitForTimeout(500)
        await page.reload()
        await reopen(page)
        await page.waitForSelector(`${custom} .palette-cell[aria-label="Bass clef"]`)
        expect(await page.locator(`${custom} .palette-cell[data-element="Text"]`).count()).toBe(1)

        // the cell's properties (context menu), the name is its tooltip
        await page.click(`${custom} .palette-cell[aria-label="Bass clef"]`, { button: 'right', force: true }) // aria-disabled: no selection
        await page.click('.menu-item:has-text("Properties…")')
        await page.waitForSelector('dialog.palette-properties[open]')
        await page.fill('#palette-cell-name', 'F clef')
        await page.click('dialog.palette-properties button:has-text("OK")')
        await page.waitForSelector(`${custom} .palette-cell[aria-label="F clef"]`)

        // a cell dragged onto a note of the score: the accent is added (undoable)
        await pageSnapshot(page)
        await page.click('.palette-tree-item[data-palette-type="Articulation"] .palette-header')
        const accent = '.palette-tree-item[data-palette-type="Articulation"] .palette-cell[aria-label="Accent above"]'
        await page.waitForSelector(accent)
        const note = layout.cr.find(c => c.type === 'Chord')!
        const vp = (await page.locator('#viewport').boundingBox())!
        const [nx, ny] = at(note.x, note.y)
        await page.dragAndDrop(accent, '#viewport', { targetPosition: { x: nx - vp.x, y: ny - vp.y - 4 } })
        await page.waitForFunction(() => /^\*/.test(document.getElementById('title')!.textContent!))
        expect(await pixelsChanged(page)).toBeGreaterThan(30)
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+z')
        await page.waitForFunction(() => !/^\*/.test(document.getElementById('title')!.textContent!))

        // the custom palette is deleted permanently ("Hide/Delete palette" asks)
        await page.click(`${custom} .palette-header`, { button: 'right' })
        await page.click('.menu-item:has-text("Hide/Delete palette")')
        await page.click('dialog.palette-question button[data-value="delete"]')
        await page.waitForFunction((sel) => !document.querySelector(sel), custom)
        await context.close()
    }, 180000)

    it('drags an element with the mouse (undoable) and selects with the lasso (Shift+drag)', async () => {
        const layout = await amazingGraceLayout()
        const { page, context, box } = await openAmazingGrace()
        const at = (fx: number, fy: number): [number, number] => [box.x + box.width * fx, box.y + box.height * fy]
        expect(layout.tempo).not.toBeNull()

        // the title: press, move, release
        await pageSnapshot(page)

        const [tx, ty] = at(layout.tempo!.x, layout.tempo!.y)
        await page.mouse.move(tx, ty)
        await page.mouse.down()
        for (let i = 1; i <= 5; ++i) {
            await page.mouse.move(tx + 8 * i, ty + 4 * i)
        }
        await page.mouse.up()
        await page.waitForFunction(() => document.getElementById('status')!.textContent!.startsWith('Title'))
        expect(await page.isDisabled(undoButton)).toBe(false)
        expect(await pixelsChanged(page)).toBeGreaterThan(1000)
        await page.keyboard.press('ControlOrMeta+z')
        await page.keyboard.press('Escape')
        expect(await pixelsChanged(page)).toBeLessThan(800)

        // lasso around the first two measures of the top staff (from empty space above the staff)
        const m1 = layout.measures[0]
        const m2 = layout.measures[1]
        const h = m1.staffBottom - m1.staffTop
        await page.keyboard.down('Shift')
        await page.mouse.move(...at(m1.left + 0.01, m1.staffTop - 0.7 * h))
        await page.mouse.down()
        for (let i = 1; i <= 5; ++i) {
            await page.mouse.move(...at(m1.left + 0.01 + (m2.right - m1.left) * i / 5, m1.staffTop - 0.7 * h + 2 * h * i / 5))
        }
        await page.mouse.up()
        await page.keyboard.up('Shift')
        await page.waitForFunction(() => document.getElementById('status')!.textContent!.startsWith('Range selection'))
        expect(await statusText(page)).toContain('Start measure: 1')
        await context.close()
    }, 180000)

    it('saves a new score with Save as, keeps it after a reload, saves to the computer and a copy', async () => {
        const { page, context } = await newPage()
        // without the File System Access API "Save to computer" downloads the file
        await context.addInitScript(() => { delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker })
        await page.goto(base)
        await page.click('.home-footer button:has-text("New")')
        await page.waitForSelector('dialog.new-score[open]')
        await page.fill('.instruments input[type="search"]', 'flute')
        await page.dblclick('.instruments [role="option"] >> text=Flute')
        await page.click('dialog.new-score .dialog-buttons button:has-text("Done")')
        await scoreShown(page)
        expect(await page.textContent('#title')).toBe('*Untitled score')

        // Save on a new score asks for the name (title of the score by default); Escape cancels
        await page.keyboard.press('ControlOrMeta+s')
        await page.waitForSelector('dialog.save-score[open]')
        expect(await page.inputValue('dialog.save-score input')).toBe('Untitled score')
        await page.keyboard.press('Escape')
        await page.waitForFunction(() => !document.querySelector('dialog[open]'))
        expect(await page.textContent('#title')).toBe('*Untitled score')

        await page.keyboard.press('ControlOrMeta+s')
        await page.fill('dialog.save-score input', 'My song')
        await page.keyboard.press('Enter')
        await page.waitForFunction(() => document.getElementById('title')!.textContent === 'My song')

        // the open score is the saved one after a reload; the new score's entry became the saved score
        await page.reload()
        await reopen(page, 'My song')
        expect(await page.textContent('#title')).toBe('My song')
        await page.click('.app-tabs [role="tab"]:has-text("Home")')
        expect(await cardNames(page)).toEqual(['My song'])
        await page.click('.app-tabs [role="tab"]:has-text("Score")')

        // Save as (Ctrl+Shift+S): a new score in the list, the open score refers to it
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+Shift+s')
        await page.waitForSelector('dialog.save-score[open]')
        expect(await page.inputValue('dialog.save-score input')).toBe('My song')
        await page.fill('dialog.save-score input', 'Other version')
        await page.click('dialog.save-score button[type="submit"]')
        await page.waitForFunction(() => document.getElementById('title')!.textContent === 'Other version')
        await page.reload()
        await reopen(page, 'Other version')
        expect(await page.textContent('#title')).toBe('Other version')
        await page.click('.app-tabs [role="tab"]:has-text("Home")')
        expect((await cardNames(page)).sort()).toEqual(['My song', 'Other version'])
        await page.click('.app-tabs [role="tab"]:has-text("Score")')

        // "Save to computer": also downloads the .mscz
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+Shift+s')
        await page.fill('dialog.save-score input', 'On disk')
        const [download] = await Promise.all([page.waitForEvent('download'), page.click('dialog.save-score .save-to-computer')])
        expect(download.suggestedFilename()).toBe('On disk.mscz')
        await page.waitForFunction(() => document.getElementById('title')!.textContent === 'On disk')

        // File > Save other > Save a copy downloads "<name> - copy.mscz"
        await page.click('.menubar > button:has-text("File")')
        await page.hover('.menu-item:has-text("Save other")')
        const [copy] = await Promise.all([page.waitForEvent('download'), page.click('.menu-item:has-text("Save a copy")')])
        expect(copy.suggestedFilename()).toBe('On disk - copy.mscz')
        expect(await page.textContent('#title')).toBe('On disk')
        await context.close()
    }, 180000)

    it('autosaves a modified score and restores it after the page was left', async () => {
        const { page, context } = await newPage()
        // auto save every 1.2 s
        await context.addInitScript(() => {
            const s = JSON.parse(localStorage.getItem('musescoreweb:settings') ?? '{}') as { project?: Record<string, unknown> }
            if (s.project?.autoSaveInterval === undefined) {
                s.project = { ...s.project, autoSaveEnabled: true, autoSaveInterval: 0.02 }
                localStorage.setItem('musescoreweb:settings', JSON.stringify(s))
            }
        })
        const autosaves = (): Promise<number> => page.evaluate(() => new Promise<number>((resolve) => {
            const req = indexedDB.open('musescoreweb-scores')
            req.onsuccess = () => {
                const db = req.result
                const count = db.transaction('autosaves', 'readonly').objectStore('autosaves').count()
                count.onsuccess = () => {
                    db.close()
                    resolve(count.result)
                }
            }
        }))
        const waitAutosaves = async (n: number): Promise<void> => {
            for (let i = 0; i < 100 && (await autosaves()) !== n; i++) {
                await page.waitForTimeout(100)
            }
            expect(await autosaves()).toBe(n)
        }
        const status = (): Promise<string> => page.textContent('#status').then(t => t ?? '')
        const firstNote = async (): Promise<string> => {
            await page.focus('#viewport')
            await page.keyboard.press('ControlOrMeta+Home')
            for (let i = 0; i < 8 && !(await status()).startsWith('Note'); i++) {
                await page.keyboard.press('ArrowRight')
            }
            return status()
        }
        const raise = async (): Promise<string> => {
            const before = await firstNote()
            await page.keyboard.press('ArrowUp')
            await page.waitForFunction((b) => document.getElementById('status')!.textContent !== b, before)
            return status()
        }

        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        const original = await firstNote()
        expect(original).toMatch(/^Note/)
        const raised = await raise()
        expect(raised).not.toBe(original)
        expect(await page.textContent('#title')).toBe('*amazing')
        await waitAutosaves(1)

        // the page is left with unsaved changes: the next start asks to restore the session
        await page.goto(base)
        await page.waitForSelector('dialog.restore-session[open]')
        expect(await page.textContent('#restore-session-title')).toBe('The previous session quit unexpectedly.')
        await page.click('dialog.restore-session button[value="yes"]')
        await scoreShown(page)
        expect(await page.textContent('#title')).toBe('*amazing')
        expect(await firstNote()).toBe(raised)

        // closing without saving removes the autosave; the saved version is opened again
        await page.click('.notation-tab #clear')
        await page.click('dialog.confirm button[value="dontSave"]')
        await page.waitForSelector('.home')
        await waitAutosaves(0)
        await page.click('.score-card:not(.new)')
        await scoreShown(page)
        expect(await page.textContent('#title')).toBe('amazing')
        expect(await firstNote()).toBe(original)

        // "No" removes the autosave; the score opened from the home screen is the saved version
        await raise()
        await waitAutosaves(1)
        await page.reload()
        await page.waitForSelector('dialog.restore-session[open]')
        await page.click('dialog.restore-session button[value="no"]')
        await reopen(page, 'amazing')
        expect(await page.textContent('#title')).toBe('amazing')
        expect(await firstNote()).toBe(original)
        await waitAutosaves(0)

        // saving removes the autosave; undoing to the saved state, too
        await raise()
        await waitAutosaves(1)
        await page.keyboard.press('ControlOrMeta+s')
        await page.waitForFunction(() => document.getElementById('title')!.textContent === 'amazing')
        await waitAutosaves(0)
        await raise()
        await waitAutosaves(1)
        await page.keyboard.press('ControlOrMeta+z')
        await page.waitForFunction(() => document.getElementById('title')!.textContent === 'amazing')
        await waitAutosaves(0)

        // the preference (Preferences > Save & publish > Auto save every … min)
        await page.click('.menubar > button:has-text("Edit")')
        await page.click('.menu-item:has-text("Preferences")')
        await page.waitForSelector('dialog.preferences[open]')
        await page.click('.preferences-pages li:has-text("Save & publish")')
        await page.uncheck('.autosave-row input[type="checkbox"]')
        expect(await page.isDisabled('.autosave-row input[type="number"]')).toBe(true)
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem('musescoreweb:settings')!).project.autoSaveEnabled)).toBe(false)
        await context.close()
    }, 180000)

    // the playback (automated browsers get the silent synthesizer: navigator.webdriver; it counts the played notes)
    interface PlaybackProbe { playing: boolean; position: number; tick: number; muted: boolean; notes: number; cursor: string | null }
    const playbackProbe = (page: Page): Promise<PlaybackProbe> => page.evaluate(() => {
        const p = (window as unknown as { __museencorePlayback: {
            synth: { noteOnCount: number }; state: () => { playing: boolean; position: number; tick: number; muted: boolean }
        } }).__museencorePlayback
        const st = p.state()
        const c = document.querySelector<HTMLElement>('.playback-cursor')
        return {
            playing: st.playing, position: st.position, tick: st.tick, muted: st.muted, notes: p.synth.noteOnCount,
            cursor: c && !c.hidden && c.style.display !== 'none' ? c.style.left : null,
        }
    })
    const playButton = '[data-toolbar="playbackToolBar"] .tool-button[data-action="play"]'
    const muteButton = '[data-toolbar="playbackToolBar"] .tool-button[data-action="playback-mute"]'

    it('plays all instruments with SpessaSynth after channels were added before (MIDI import)', async () => {
        const { page, context } = await newPage()
        await context.route('http://imports.test/**', route => route.fulfill({
            body: readFileSync(`${ROOT}MuseScore/src/importexport/midi/tests/midiimport_data/instrument_channels.mid`),
            headers: { 'access-control-allow-origin': '*' },
        }))
        await page.goto(`${base}?synth=spessasynth&url=${encodeURIComponent('http://imports.test/instrument_channels.mid')}`)
        await scoreShown(page)
        type Spessa = { load(): Promise<void>; setupChannel(c: number, s: object): void
            m_synth: { midiChannels: { voiceCount: number }[] } | null }
        // another score (or a preview note) added the channels up to 16 before; the channels that sound are recorded
        await page.evaluate(async () => {
            const w = window as unknown as { __museencorePlayback: { synth: Spessa }; __voiced: number[] }
            const synth = w.__museencorePlayback.synth
            await synth.load()
            synth.setupChannel(16, { program: 0, bank: 0, drum: false, volume: 100, pan: 64, reverb: 0, chorus: 0 })
            w.__voiced = []
            setInterval(() => synth.m_synth!.midiChannels.forEach((c, i) => {
                if (c.voiceCount > 0 && !w.__voiced.includes(i)) {
                    w.__voiced.push(i)
                }
            }), 20)
        })
        await page.waitForTimeout(500)
        await page.click(playButton)
        await page.waitForFunction(() => !(window as unknown as { __museencorePlayback: { state: () => { playing: boolean } } })
            .__museencorePlayback.state().playing, null, { timeout: 30000 })
        const voiced = await page.evaluate(() => (window as unknown as { __voiced: number[] }).__voiced)
        // the channels above the ones added before sound too
        expect(Math.max(...voiced)).toBeGreaterThan(16)
        await context.close()
    }, 120000)

    it('plays the score from the toolbar and with Shift+Space, moves the playback cursor, mutes and plays notes on click', async () => {
        const layout = await amazingGraceLayout()
        const { page, context, box } = await openAmazingGrace()
        const at = (fx: number, fy: number): [number, number] => [box.x + box.width * fx, box.y + box.height * fy]
        expect(await page.locator('[data-toolbar="playbackToolBar"]').count()).toBe(1)

        // play / pause with the toolbar button: the position and the cursor advance
        await page.click(playButton)
        await page.waitForFunction(() => (window as unknown as { __museencorePlayback: { state: () => { playing: boolean; tick: number } } })
            .__museencorePlayback.state().tick > 1920, null, { timeout: 20000 }) // after the pickup measure's rests
        const a = await playbackProbe(page)
        expect(a.playing).toBe(true)
        expect(a.notes).toBeGreaterThan(0)
        expect(a.cursor).not.toBeNull()
        await page.waitForTimeout(600)
        const b = await playbackProbe(page)
        expect(b.position).toBeGreaterThan(a.position)
        expect(parseFloat(b.cursor!)).not.toBe(parseFloat(a.cursor!))
        await page.click(playButton)
        await page.waitForFunction(() => !(window as unknown as { __museencorePlayback: { state: () => { playing: boolean } } })
            .__museencorePlayback.state().playing)
        const paused = await playbackProbe(page)
        expect(paused.position).toBeGreaterThan(0)

        // with the default setting "Hold Space and drag to move the score" Space is the hand tool: playback starts
        // with Shift+Space (play from the selection) and stops with Escape
        await page.focus('#viewport')
        await page.keyboard.press(' ')
        await page.waitForTimeout(300)
        expect((await playbackProbe(page)).playing).toBe(false) // Space alone is the hand tool
        await page.keyboard.press('Shift+Space')
        await page.waitForFunction(() => (window as unknown as { __museencorePlayback: { state: () => { playing: boolean } } })
            .__museencorePlayback.state().playing)
        await page.waitForTimeout(300)
        await page.keyboard.press('Escape')
        await page.waitForFunction(() => !(window as unknown as { __museencorePlayback: { state: () => { playing: boolean } } })
            .__museencorePlayback.state().playing)

        // a click on a note plays it (and seeks there)
        const note = layout.cr.filter(c => c.type === 'Chord')[2]
        let before = (await playbackProbe(page)).notes
        await page.mouse.click(...at(note.x, note.y))
        await page.waitForFunction(() => /^Note/.test(document.getElementById('status')!.textContent!))
        await page.waitForFunction(n => (window as unknown as { __museencorePlayback: { synth: { noteOnCount: number } } })
            .__museencorePlayback.synth.noteOnCount > n, before)

        // muted: no sound for the preview notes; the mute is kept after a reload
        await page.click(muteButton)
        expect((await playbackProbe(page)).muted).toBe(true)
        expect(await page.getAttribute(muteButton, 'aria-pressed')).toBe('true')
        before = (await playbackProbe(page)).notes
        await page.keyboard.press('ArrowUp')
        await page.waitForTimeout(300)
        expect((await playbackProbe(page)).notes).toBe(before)
        await page.keyboard.press('ControlOrMeta+z')
        await page.reload()
        await reopen(page)
        expect((await playbackProbe(page)).muted).toBe(true)
        await page.click(muteButton)
        expect((await playbackProbe(page)).muted).toBe(false)

        // View > Toolbars hides the playback toolbar
        await page.click('.menubar > button:has-text("View")')
        await page.hover('.menu-item:has-text("Toolbars")')
        await page.click('.menu-item:has-text("Playback controls")')
        await page.waitForFunction(() => !document.querySelector('[data-toolbar="playbackToolBar"]'))
        await context.close()
    }, 180000)
    it('toggles concert pitch in the status bar (undoable)', async () => {
        const { page, context } = await newPage()
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        const control = '.statusbar-button.concert-pitch'
        expect(await page.textContent(control)).toContain('Concert pitch')
        expect(await page.getAttribute(control, 'aria-checked')).toBe('false')
        await page.click(control)
        await page.waitForSelector(`${control}[aria-checked="true"]`)
        await page.click('.page')
        await page.keyboard.press('ControlOrMeta+z')
        await page.waitForSelector(`${control}[aria-checked="false"]`)
        await context.close()
    })
    it('transposes the score with the Transpose dialog (undoable)', async () => {
        const { page, context } = await newPage()
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        await page.waitForTimeout(500)
        const before = await page.locator('.page').first().screenshot()
        await page.click('.menubar > button:has-text("Tools")')
        await page.click('.menu-item:has-text("Transpose…")')
        await page.waitForSelector('dialog.transpose[open]')
        expect(await page.textContent('dialog.transpose h2')).toBe('Transpose')
        // nothing was selected: the whole score is selected, so transposing to a key is possible
        const toKey = page.locator('dialog.transpose label:has-text("To Key") input')
        expect(await toKey.isEnabled()).toBe(true)
        // the defaults: to C major (closest)
        expect(await toKey.isChecked()).toBe(true)
        await page.click('dialog.transpose button[type="submit"]')
        await page.waitForSelector('dialog.transpose', { state: 'detached' })
        await page.waitForTimeout(500)
        const after = await page.locator('.page').first().screenshot()
        expect(after.equals(before)).toBe(false)

        await page.click('.menubar > button:has-text("Edit")')
        await page.click('.menu-item:has-text("Undo")')
        await page.waitForTimeout(500)
        // undo restores the selection of the command (the whole score): deselect by clicking beside the page
        await page.click('#viewport', { position: { x: 5, y: 5 } })
        await page.waitForTimeout(300)
        expect((await page.locator('.page').first().screenshot()).equals(before)).toBe(true)
        await context.close()
    })
    it('switches the view mode in the status bar: continuous views, fit to window, smooth panning while playing', async () => {
        const { page, context } = await newPage()
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        const pageCount = await page.locator('.page').count()
        const pageBox = async (): Promise<{ x: number; y: number; width: number; height: number }> => (await page.locator('.page').first().boundingBox())!
        const chooseViewMode = async (title: string): Promise<void> => {
            await page.click('.statusbar-button[aria-haspopup="menu"]')
            await page.click(`.menu-item:has-text("${title}")`)
            await page.waitForTimeout(500)
        }
        expect(await page.textContent('.statusbar-button[aria-haspopup="menu"]')).toContain('Page view')

        // continuous view (horizontal): one page with one system, wider than the view
        await chooseViewMode('Continuous view (horizontal)')
        expect(await page.textContent('.statusbar-button[aria-haspopup="menu"]')).toContain('Continuous view')
        expect(await page.locator('.page').count()).toBe(1)
        expect(await page.getAttribute('#pages', 'class')).toContain('continuous')
        let box = await pageBox()
        expect(box.width).toBeGreaterThan(box.height * 3)
        const viewport = (await page.locator('#viewport').boundingBox())!
        expect(box.width).toBeGreaterThan(viewport.width)

        // smooth panning: the playback cursor stays in the middle of the view
        await page.click('[data-toolbar="playbackToolBar"] .tool-button[aria-label="Playback settings"]')
        await page.click('.menu-item:has-text("Smooth panning")')
        await page.click(playButton)
        await page.waitForFunction(() => (window as unknown as { __museencorePlayback: { state: () => { tick: number } } })
            .__museencorePlayback.state().tick > 4 * 1440, null, { timeout: 30000 })
        const cursorOffsets: number[] = []
        for (let i = 0; i < 3; ++i) {
            await page.waitForTimeout(400)
            const c = (await page.locator('.playback-cursor').boundingBox())!
            cursorOffsets.push(c.x + c.width / 2 - (viewport.x + viewport.width / 2))
        }
        await page.click(playButton)
        for (const d of cursorOffsets) {
            expect(Math.abs(d)).toBeLessThan(40)
        }

        // continuous view (vertical): one long page
        await chooseViewMode('Continuous view (vertical)')
        expect(await page.locator('.page').count()).toBe(1)
        box = await pageBox()
        expect(box.height).toBeGreaterThan(box.width)
        // the mouse wheel scrolls the continuous views (it zooms only in the page view)
        const zoomBefore = await page.inputValue('.zoom-select')
        const top = await page.evaluate(() => document.getElementById('viewport')!.scrollTop)
        await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2)
        await page.mouse.wheel(0, 120)
        await page.waitForTimeout(300)
        expect(await page.inputValue('.zoom-select')).toBe(zoomBefore)
        expect(await page.evaluate(() => document.getElementById('viewport')!.scrollTop)).toBeGreaterThan(top)

        // fit to window: the page is as wide as the view, also after the window size changes
        await chooseViewMode('Continuous view (fit to window)')
        expect(await page.textContent('.statusbar-button[aria-haspopup="menu"]')).toContain('fit to window')
        const gap = (vw: number, pw: number): number => vw - pw
        box = await pageBox()
        let vp = (await page.locator('#viewport').boundingBox())!
        expect(gap(vp.width, box.width)).toBeGreaterThan(0)
        expect(gap(vp.width, box.width)).toBeLessThan(80)
        const systemsWide = box.height
        await page.setViewportSize({ width: 900, height: 800 })
        await page.waitForTimeout(800)
        box = await pageBox()
        vp = (await page.locator('#viewport').boundingBox())!
        expect(gap(vp.width, box.width)).toBeLessThan(80)
        expect(box.height).toBeGreaterThan(systemsWide) // more systems
        expect(await page.evaluate(() => document.getElementById('viewport')!.scrollWidth <= document.getElementById('viewport')!.clientWidth + 1)).toBe(true)

        // the view mode is kept after a reload; back to the page view
        await page.reload()
        await reopen(page)
        expect(await page.textContent('.statusbar-button[aria-haspopup="menu"]')).toContain('fit to window')
        await chooseViewMode('Page view')
        expect(await page.locator('.page').count()).toBe(pageCount)
        await context.close()
    }, 180000)

    it('exports the score and its parts with the Export dialog', async () => {
        const { page, context } = await newPage()
        // without the File System Access API the files are downloaded
        await context.addInitScript(() => { delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker })
        await page.goto(`${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`)
        await scoreShown(page)
        const openExport = async (): Promise<void> => {
            await page.click('.menubar > button:has-text("File")')
            await page.click('.menu-item:has-text("Export…")')
            await page.waitForSelector('dialog.export-dialog[open]')
        }
        const read = async (d: { path(): Promise<string | null> }): Promise<Buffer> => readFileSync((await d.path())!)

        // the main score as PDF (the default format)
        await openExport()
        expect(await page.inputValue('#export-format')).toBe('pdf')
        expect(await page.isChecked('.export-score.main input')).toBe(true)
        const [pdf] = await Promise.all([page.waitForEvent('download'), page.click('dialog.export-dialog button.primary')])
        expect(pdf.suggestedFilename()).toBe('amazing.pdf')
        expect((await read(pdf)).subarray(0, 5).toString()).toBe('%PDF-')
        await page.waitForFunction(() => !document.querySelector('dialog.export-dialog'))

        // every page of all scores as PNG: several files in a ZIP archive
        await openExport()
        await page.selectOption('#export-format', 'png')
        await page.fill('#export-resolution', '40')
        await page.press('#export-resolution', 'Enter')
        await page.click('dialog.export-dialog button:has-text("Select all")')
        const [zip] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('dialog.export-dialog button.primary')])
        expect(zip.suggestedFilename()).toBe('amazing.zip')
        const names = Object.keys(unzipSync(new Uint8Array(await read(zip))))
        expect(names).toContain('amazing-1.png')
        expect(names).toContain('amazing-2.png')
        expect(names.some(n => /^amazing-Soprano-1\.png$/.test(n))).toBe(true)

        // the dialog keeps the format and the scores of the last export; MusicXML has the file types as subtypes
        await openExport()
        expect(await page.inputValue('#export-format')).toBe('png')
        expect(await page.inputValue('#export-resolution')).toBe('40')
        await page.selectOption('#export-format', 'mxl')
        expect(await page.inputValue('#export-subtype')).toBe('mxl')
        await page.click('dialog.export-dialog button:has-text("Clear selection")')
        expect(await page.isDisabled('dialog.export-dialog button.primary')).toBe(true)
        await page.check('.export-score:has-text("Soprano") input')
        const [mxl] = await Promise.all([page.waitForEvent('download'), page.click('dialog.export-dialog button.primary')])
        expect(mxl.suggestedFilename()).toBe('amazing-Soprano.mxl')
        expect(Object.keys(unzipSync(new Uint8Array(await read(mxl))))).toContain('META-INF/container.xml')
        await context.close()
    }, 180000)

    // ---------------------------------------------------------------------------------
    //   no work is lost: autosaves of other scores, the limit of stored scores, other tabs, the microphone
    // ---------------------------------------------------------------------------------

    /** runs on the raw IndexedDB of the app, given as a function source (it has no access to this module) */
    const idb = <T>(page: Page, body: string): Promise<T> => page.evaluate(([src]) => new Promise<T>((resolve, reject) => {
        const req = indexedDB.open('musescoreweb-scores')
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
            const db = req.result
            const fn = new Function('db', `return (${src})(db)`) as (db: IDBDatabase) => Promise<T>
            void fn(db).then((r) => {
                db.close()
                resolve(r)
            }, reject)
        }
    }), [body])
    const autosaveKeys = (page: Page): Promise<string[]> => idb<string[]>(page, `db => new Promise((res) => {
        const r = db.transaction('autosaves').objectStore('autosaves').getAllKeys(); r.onsuccess = () => res(r.result) })`)
    const scoreCount = (page: Page): Promise<number> => idb<number>(page, `db => new Promise((res) => {
        const r = db.transaction('scores').objectStore('scores').count(); r.onsuccess = () => res(r.result) })`)
    /** stores scores directly; `autosave`: with an autosave */
    const seedScores = (page: Page, names: readonly string[], autosave = false): Promise<void> => idb<void>(page, `db => new Promise((res, rej) => {
        const t = db.transaction(['scores', 'contents', 'autosaves'], 'readwrite');
        ${JSON.stringify(names)}.forEach((name, i) => {
            t.objectStore('scores').put({ id: name, name: name + '.mscz', title: '', composer: '', source: 'file', size: 0, pages: 1, aspect: 0.7, created: 1, modified: 1, opened: 1000 + i })
            t.objectStore('contents').put({ id: name, data: new ArrayBuffer(0) })
            if (${autosave}) t.objectStore('autosaves').put({ id: name, data: new ArrayBuffer(0), time: Date.now() })
        })
        t.oncomplete = () => res(); t.onerror = () => rej(t.error)
    })`)
    const fastAutosave = (context: BrowserContext): Promise<void> => context.addInitScript(() => {
        const s = JSON.parse(localStorage.getItem('musescoreweb:settings') ?? '{}') as { project?: Record<string, unknown> }
        if (s.project?.autoSaveInterval === undefined) {
            s.project = { ...s.project, autoSaveEnabled: true, autoSaveInterval: 0.02 }
            localStorage.setItem('musescoreweb:settings', JSON.stringify(s))
        }
    })
    const statusOf = (page: Page): Promise<string> => page.textContent('#status').then(t => t ?? '')
    /** selects the first note and raises it */
    const modify = async (page: Page): Promise<string> => {
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+Home')
        for (let i = 0; i < 8 && !(await statusOf(page)).startsWith('Note'); i++) {
            await page.keyboard.press('ArrowRight')
        }
        const before = await statusOf(page)
        await page.keyboard.press('ArrowUp')
        await page.waitForFunction((b) => document.getElementById('status')!.textContent !== b, before)
        return statusOf(page)
    }
    const waitAutosave = async (page: Page, count: number): Promise<void> => {
        for (let i = 0; i < 100 && (await autosaveKeys(page)).length !== count; i++) {
            await page.waitForTimeout(100)
        }
        expect((await autosaveKeys(page)).length).toBe(count)
    }
    const AMAZING = (): string => `${base}?url=${encodeURIComponent(`${SCORE_HOST}amazing.mscz`)}`

    it('the restore question is about one score: Escape removes only its autosave', async () => {
        const { page, context } = await newPage()
        await fastAutosave(context)
        await page.goto(AMAZING())
        await scoreShown(page)
        await modify(page)
        await waitAutosave(page, 1)
        await seedScores(page, ['other'], true)
        const amazing = (await autosaveKeys(page)).find(k => k !== 'other')!

        // the open score is asked about; the others stay
        await page.goto(base)
        await page.waitForSelector('dialog.restore-session[open]')
        expect(await page.textContent('.restore-session-name')).toBe('amazing')
        await page.keyboard.press('Escape')
        await page.waitForSelector('dialog.restore-session', { state: 'detached' })
        await page.waitForFunction(() => !document.querySelector('dialog[open]'))
        await page.waitForTimeout(200)
        const left = await autosaveKeys(page)
        expect(left).toEqual(['other'])
        expect(left).not.toContain(amazing)

        // the next start asks about the other score, "No" removes its autosave
        await page.reload()
        await page.waitForSelector('dialog.restore-session[open]')
        expect(await page.textContent('.restore-session-name')).toBe('other')
        await page.click('dialog.restore-session button[value="no"]')
        await waitAutosave(page, 0)
        await context.close()
    }, 180000)

    it('opening the file of a score with unsaved changes keeps them as a separate score', async () => {
        const { page, context } = await newPage()
        await fastAutosave(context)
        await page.goto(AMAZING())
        await scoreShown(page)
        const raised = await modify(page)
        await waitAutosave(page, 1)

        await page.goto(AMAZING())
        await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('kept as a separate score'), null, { timeout: 120000 })
        expect(await statusOf(page)).toContain('amazing (unsaved changes)')
        expect(await page.textContent('#title')).toBe('amazing') // the file, not modified
        await waitAutosave(page, 1)
        await page.click('.app-tabs [role="tab"]:has-text("Home")')
        expect((await cardNames(page)).sort()).toEqual(['amazing', 'amazing (unsaved changes)'])

        // the file again: the entry of the file is reused, the separate score stays
        await page.goto(AMAZING())
        await scoreShown(page)
        await page.click('.app-tabs [role="tab"]:has-text("Home")')
        expect((await cardNames(page)).sort()).toEqual(['amazing', 'amazing (unsaved changes)'])
        await waitAutosave(page, 1)

        // the separate score has the changes
        await page.click('.score-card:not(.new):has(.card-name:text-is("amazing (unsaved changes)"))')
        await scoreShown(page)
        expect(await page.textContent('#title')).toBe('*amazing (unsaved changes)')
        await page.focus('#viewport')
        await page.keyboard.press('ControlOrMeta+Home')
        for (let i = 0; i < 8 && !(await statusOf(page)).startsWith('Note'); i++) {
            await page.keyboard.press('ArrowRight')
        }
        expect(await statusOf(page)).toBe(raised)
        await context.close()
    }, 240000)

    it('asks which score to delete when more than 500 scores would be stored', async () => {
        const { page, context } = await newPage()
        await page.goto(base)
        await page.waitForSelector('.home')
        await seedScores(page, Array.from({ length: 500 }, (_, i) => `seed${String(i).padStart(3, '0')}`))

        // Cancel: nothing is deleted, the score is not opened
        await page.goto(AMAZING())
        await page.waitForSelector('dialog.remove-score[open]', { timeout: 120000 })
        expect(await page.locator('.remove-score-list input').count()).toBe(500)
        expect(await page.locator('.remove-score-name').first().textContent()).toBe('seed000') // least recently opened
        expect(await page.locator('.remove-score-list input').first().isChecked()).toBe(true)
        await page.keyboard.press('Escape')
        await page.waitForSelector('.home')
        expect(await view(page)).toBe('home')
        expect(await scoreCount(page)).toBe(500)

        // the score chosen is deleted, the score is opened and stored
        await page.goto(AMAZING())
        await page.waitForSelector('dialog.remove-score[open]', { timeout: 120000 })
        await page.locator('.remove-score-list input').nth(1).check()
        await page.click('dialog.remove-score button[value="delete"]')
        await scoreShown(page)
        await page.waitForFunction(() => !document.querySelector('dialog[open]'))
        await page.waitForTimeout(300)
        expect(await scoreCount(page)).toBe(500)
        const ids = await idb<string[]>(page, `db => new Promise((res) => {
            const r = db.transaction('scores').objectStore('scores').getAllKeys(); r.onsuccess = () => res(r.result) })`)
        expect(ids).toContain('seed000')
        expect(ids).not.toContain('seed001')

        // the same file again needs no room
        await page.goto(AMAZING())
        await scoreShown(page)
        expect(await page.locator('dialog.remove-score').count()).toBe(0)
        await context.close()
    }, 240000)

    it('warns about a score open in another tab and leaves its autosave alone', async () => {
        const { page, context } = await newPage()
        await fastAutosave(context)
        await page.goto(AMAZING())
        await scoreShown(page)
        await modify(page)
        await waitAutosave(page, 1)

        // a new tab: the autosave of the first tab is not left over from a crash
        const tab2 = await context.newPage()
        tab2.on('dialog', d => void d.accept())
        await tab2.goto(base)
        await tab2.waitForSelector('.score-card:not(.new)')
        await tab2.waitForTimeout(500)
        expect(await tab2.locator('dialog.restore-session').count()).toBe(0)
        await waitAutosave(tab2, 1)

        // opening it: the question; "No" keeps the home screen
        await tab2.click('.score-card:not(.new)')
        await tab2.waitForSelector('dialog.message-box[open]')
        expect(await tab2.textContent('#message-box-text')).toContain('already open in another tab')
        expect(await tab2.textContent('.message-box-detail')).toContain('whichever tab saves last')
        await tab2.click('dialog.message-box button[value="no"]')
        await tab2.waitForTimeout(200)
        expect(await view(tab2)).toBe('home')

        await tab2.click('.score-card:not(.new)')
        await tab2.click('dialog.message-box button[value="yes"]')
        await scoreShown(tab2)
        await tab2.waitForTimeout(300)
        expect(await tab2.locator('dialog.message-box').count()).toBe(0) // told already

        // entering the first tab: told once
        await page.evaluate(() => window.dispatchEvent(new Event('focus')))
        await page.waitForSelector('dialog.message-box[open]')
        expect(await page.textContent('#message-box-text')).toContain('also open in another tab')
        await page.click('dialog.message-box button[value="ok"]')
        await page.evaluate(() => window.dispatchEvent(new Event('focus')))
        await page.waitForTimeout(300)
        expect(await page.locator('dialog.message-box').count()).toBe(0)

        // all tabs closed (the locks are released like after a crash): the autosave is restored at the next start
        await page.close()
        await tab2.close()
        const tab3 = await context.newPage()
        tab3.on('dialog', d => void d.accept())
        await tab3.goto(base)
        await tab3.waitForSelector('dialog.restore-session[open]')
        await context.close()
    }, 240000)

    describe('microphone of the playalong', () => {
        let micBrowser: Browser

        beforeAll(async () => {
            micBrowser = await chromium.launch({
                executablePath: CHROME, headless: true,
                args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
            })
            // the first start imports the detector: with a cold cache the dev server finds its dependencies and reloads
            // the page, which would lose the state of a test
            const { page, context } = await micPage(true)
            const reload = page.waitForEvent('framenavigated', { timeout: 120000 }).then(() => true)
            await toggle(page)
            if (await Promise.race([reload, playalongStatus(page, 'listening').then(() => false)])) {
                await scoreShown(page)
                await toggle(page)
                await playalongStatus(page, 'listening')
            }
            await context.close()
        }, 300000)

        afterAll(async () => {
            await micBrowser?.close()
        })

        /** records the streams of getUserMedia; `delay`: the time the browser "asks" */
        async function micPage(granted: boolean, delay = 0): Promise<{ page: Page; context: BrowserContext }> {
            const context = await micBrowser.newContext({ viewport: { width: 1280, height: 800 } })
            await presetNoMigration(context)
            await context.route(`${SCORE_HOST}**`, route => route.fulfill({
                body: readFileSync(`${DEMOS}/Amazing_grace.mscz`), headers: { 'access-control-allow-origin': '*' },
            }))
            if (granted) {
                await context.grantPermissions(['microphone'], { origin: new URL(base).origin })
            } else {
                // the fake UI of the browser answers every request: like a browser that would ask again
                await context.addInitScript(() => {
                    const query = navigator.permissions.query.bind(navigator.permissions)
                    navigator.permissions.query = async (d) => {
                        const r = await query(d)
                        return d.name === 'microphone' ? Object.create(r, { state: { value: 'prompt' } }) as PermissionStatus : r
                    }
                })
            }
            await context.addInitScript((d) => {
                const w = window as unknown as { __mic: MediaStream[] }
                w.__mic = []
                const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
                navigator.mediaDevices.getUserMedia = async (c) => {
                    await new Promise(r => setTimeout(r, d))
                    const s = await gum(c)
                    w.__mic.push(s)
                    return s
                }
            }, delay)
            const page = await context.newPage()
            page.on('pageerror', e => { throw e })
            await page.goto(`${AMAZING()}&synth=none`)
            await scoreShown(page)
            return { page, context }
        }
        const tracks = (page: Page): Promise<{ state: string; enabled: boolean }[]> => page.evaluate(() =>
            (window as unknown as { __mic: MediaStream[] }).__mic.flatMap(s => s.getTracks()).map(t => ({ state: t.readyState, enabled: t.enabled })))
        const playalongStatus = (page: Page, status: string): Promise<unknown> => page.waitForFunction((st) =>
            (window as unknown as { __museencorePlayalong?: { state: () => { status: string } } }).__museencorePlayalong?.state().status === st, status, { timeout: 120000 })
        const toggle = (page: Page): Promise<void> => page.click('[data-action="playalong"]')

        it('is closed when switched off if the permission is granted', async () => {
            const { page, context } = await micPage(true)
            await toggle(page)
            await playalongStatus(page, 'listening')
            expect(await tracks(page)).toEqual([{ state: 'live', enabled: true }])
            await toggle(page)
            await playalongStatus(page, 'off')
            await page.waitForFunction(() => (window as unknown as { __mic: MediaStream[] }).__mic.every(s => s.getTracks().every(t => t.readyState === 'ended')))
            await context.close()
        }, 180000)

        it('is closed by default; with the setting it is kept muted if the browser would ask again', async () => {
            const { page, context } = await micPage(false)
            const keepSetting = async (): Promise<void> => {
                await page.click('[data-action="playback-settings"]')
                await page.locator('.menu-item:has-text("Keep microphone active during session")').click()
            }
            await toggle(page)
            await playalongStatus(page, 'listening')
            await toggle(page)
            await playalongStatus(page, 'off')
            await page.waitForTimeout(300)
            expect(await tracks(page)).toEqual([{ state: 'ended', enabled: true }])

            await keepSetting()
            await toggle(page)
            await playalongStatus(page, 'listening')
            await toggle(page)
            await playalongStatus(page, 'off')
            await page.waitForTimeout(300)
            expect((await tracks(page))[1]).toEqual({ state: 'live', enabled: false })

            // switched on again: no new request
            await toggle(page)
            await playalongStatus(page, 'listening')
            expect((await tracks(page)).slice(1)).toEqual([{ state: 'live', enabled: true }])
            await toggle(page)
            await playalongStatus(page, 'off')
            await page.waitForTimeout(300)
            expect((await tracks(page)).slice(1)).toEqual([{ state: 'live', enabled: false }])

            // turning the setting off closes it at once
            await keepSetting()
            await page.waitForFunction(() => (window as unknown as { __mic: MediaStream[] }).__mic.every(s => s.getTracks().every(t => t.readyState === 'ended')))
            await context.close()
        }, 180000)

        it('is closed if it is switched off while the browser asks for it', async () => {
            const { page, context } = await micPage(false, 1500)
            await toggle(page)
            await playalongStatus(page, 'loading')
            await toggle(page)
            await playalongStatus(page, 'off')
            await page.waitForFunction(() => (window as unknown as { __mic: MediaStream[] }).__mic.length === 1, null, { timeout: 10000 })
            await page.waitForFunction(() => (window as unknown as { __mic: MediaStream[] }).__mic.every(s => s.getTracks().every(t => t.readyState === 'ended')), null, { timeout: 5000 })
            await page.waitForTimeout(200)
            expect((await page.evaluate(() => (window as unknown as { __museencorePlayalong: { state: () => { status: string } } }).__museencorePlayalong.state().status))).toBe('off')
            await context.close()
        }, 180000)
    })
})
