/*
 * SPDX-License-Identifier: GPL-3.0-only
 * MuseEncore — port of MuseScore Studio (https://github.com/musescore/MuseScore)
 *
 * Bumps the version of MuseEncore (package.json and package-lock.json) and of the npm package muse-encore-viewer
 * (packages/viewer/package.json, and its CDN URL in packages/viewer/example/index.html), which always have the same
 * version, commits it ("Bumps version to x.y.z") and creates the tag vx.y.z. Nothing is pushed or published.
 *
 *   npm run bump-version [-- <version>]
 *
 * A missing version is asked for, suggesting the next patch version (0.0.14 -> 0.0.15); Enter takes the suggestion,
 * or type another version.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface, type Interface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const FILES = ['package.json', 'package-lock.json'].filter(f => existsSync(join(ROOT, f)))
const VIEWER_FILE = 'packages/viewer/package.json'
/** files with the CDN URL of the viewer package (https://cdn.jsdelivr.net/npm/muse-encore-viewer@x.y.z/...) */
const VIEWER_CDN_FILES = ['packages/viewer/example/index.html'].filter(f => existsSync(join(ROOT, f)))
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
}

function fail(message: string): never {
    console.error(message)
    process.exit(1)
}

function readVersion(file: string): string {
    return JSON.parse(readFileSync(join(ROOT, file), 'utf8')).version as string
}

function nextPatch(file: string, version: string): string {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
    if (!m) {
        fail(`${file}: version ${version} is not x.y.z`)
    }
    return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

function checkVersion(version: string): string {
    version = version.replace(/^v/, '')
    if (!SEMVER.test(version)) {
        fail(`invalid version: ${version}`)
    }
    return version
}

/** sets the version in a JSON file (the lock file has it at the top and for the root package) */
function setVersion(file: string, version: string): void {
    const path = join(ROOT, file)
    const json = JSON.parse(readFileSync(path, 'utf8'))
    json.version = version
    if (json.packages?.['']) {
        json.packages[''].version = version
    }
    writeFileSync(path, JSON.stringify(json, null, 2) + '\n')
}

/** sets the version of the viewer package in its CDN URLs */
function setCdnVersion(file: string, version: string): void {
    const path = join(ROOT, file)
    writeFileSync(path, readFileSync(path, 'utf8').replace(/(muse-encore-viewer@)[^/'"\s]+/g, `$1${version}`))
}

async function main(rl: Interface): Promise<void> {
    if (git('status', '--porcelain', '--', ...FILES, VIEWER_FILE, ...VIEWER_CDN_FILES)) {
        fail(`${[...FILES, VIEWER_FILE, ...VIEWER_CDN_FILES].join(' / ')} have uncommitted changes`)
    }
    const current = readVersion('package.json')
    const viewerCurrent = readVersion(VIEWER_FILE)
    const ask = async (question: string, suggestion: string): Promise<string> =>
        (await rl.question(`${question} [${suggestion}]: `)).trim() || suggestion

    const version = checkVersion(process.argv[2] || await ask(`MuseEncore and muse-encore-viewer ${current} -> new version`, nextPatch('package.json', current)))
    const tag = `v${version}`
    if (git('tag', '--list', tag)) {
        fail(`tag ${tag} exists already`)
    }

    for (const file of [...FILES, VIEWER_FILE]) {
        setVersion(file, version)
    }
    for (const file of VIEWER_CDN_FILES) {
        setCdnVersion(file, version)
    }
    // only the version files, other changes of the working tree stay uncommitted
    git('commit', '-m', `Bumps version to ${version}`, '--', ...FILES, VIEWER_FILE, ...VIEWER_CDN_FILES)
    git('tag', tag)

    console.log(`MuseEncore ${current} -> ${version}, muse-encore-viewer ${viewerCurrent} -> ${version}`)
    console.log(`Committed and tagged ${tag}. Not pushed: git push && git push origin ${tag}`)
    console.log(`Remember to publish the viewer package: npm run build:viewer-package && cd packages/viewer && npm publish`)
}

const rl = createInterface({ input: process.stdin, output: process.stdout })
try {
    await main(rl)
} finally {
    rl.close()
}
