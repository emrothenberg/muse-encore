// SPDX-License-Identifier: GPL-3.0-only
// Builds the npm package "muse-encore-viewer" in packages/viewer: the bundled ES module (viewer/vite.lib.config.ts),
// its type declarations (from viewer/src/types.ts), the runtime fonts and the license; example/auto.html from
// example/auto_template.html with the build time as the module's query (no stale module from the browser cache).
// npm run build:viewer-package; then `npm publish` in packages/viewer.
import { execFileSync } from 'node:child_process'
import { cpSync, copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'vite'

const ROOT = join(import.meta.dirname, '..')
const PKG = join(ROOT, 'packages/viewer')
const DIST = join(PKG, 'dist')

await build({ configFile: join(ROOT, 'viewer/vite.lib.config.ts'), logLevel: 'warn' })

// the declarations: the public types and the entry (the implementation's types are not part of the API)
execFileSync(join(ROOT, 'node_modules/.bin/tsc'), [
    join(ROOT, 'viewer/src/types.ts'), '--declaration', '--emitDeclarationOnly', '--strict', '--target', 'ES2022',
    '--lib', 'ES2022,DOM,DOM.Iterable', '--skipLibCheck', '--types', '', '--ignoreConfig', '--outDir', DIST,
], { stdio: 'inherit' })
writeFileSync(join(DIST, 'muse-encore-viewer.d.ts'), `// SPDX-License-Identifier: GPL-3.0-only
import type { MuseEncoreScoreSource, MuseEncoreViewer, MuseEncoreViewerOptions } from './types'

export type {
    ContinuousView, MuseEncoreScoreInfo, MuseEncoreScoreSource, MuseEncoreViewer, MuseEncoreViewerOptions, MuseEncoreViewerToolbarGroups,
} from './types'

/**
 * Shows a score in \`target\` (an element or a CSS selector); the viewer fills the element, which needs a height.
 * Returns the viewer (its \`ready\` promise resolves when the score is shown).
 */
export declare function applyMuseEncoreViewer(target: HTMLElement | string, source: MuseEncoreScoreSource,
    options?: MuseEncoreViewerOptions): MuseEncoreViewer

export default applyMuseEncoreViewer
`)

// the fonts are loaded at runtime from ../fonts/ relative to the module
rmSync(join(PKG, 'fonts'), { recursive: true, force: true })
cpSync(join(ROOT, 'fonts'), join(PKG, 'fonts'), { recursive: true, filter: src => !src.endsWith('.DS_Store') })
copyFileSync(join(ROOT, 'LICENSE'), join(PKG, 'LICENSE'))

// the model of the playalong's note detection is loaded at runtime from ../basic-pitch/ relative to the module
const MODEL = join(ROOT, 'shared/notedetection/basicpitch')
rmSync(join(PKG, 'basic-pitch'), { recursive: true, force: true })
cpSync(join(MODEL, 'model'), join(PKG, 'basic-pitch'), { recursive: true })
copyFileSync(join(MODEL, 'LICENSE'), join(PKG, 'basic-pitch/LICENSE'))

const example = readFileSync(join(PKG, 'example/auto_template.html'), 'utf8')
writeFileSync(join(PKG, 'example/auto.html'),
    example.replaceAll('../dist/muse-encore-viewer.js?{timestamp}', `../dist/muse-encore-viewer.js?${Date.now()}`))
console.log(`built ${PKG}`)
