/*
 * SPDX-License-Identifier: GPL-3.0-only
 * The npm package "muse-encore-viewer" (packages/viewer): the viewer component as one ES module with all dependencies
 * (it can be imported from a CDN without a bundler); SpessaSynth is a separate chunk loaded with the first playback.
 * tools/build-viewer-package.ts runs it and adds the fonts and the type declarations.
 */
import { defineConfig } from 'vite'

export default defineConfig({
    root: import.meta.dirname,
    publicDir: false,
    // the worker of the note detection is found relative to the module, wherever the package is served from
    base: './',
    build: {
        outDir: '../packages/viewer/dist',
        emptyOutDir: true,
        target: 'es2022',
        sourcemap: true,
        // fully minified (Vite keeps the whitespace of ES library builds for the tree shaking of bundlers; the viewer is
        // used as a whole)
        minify: true,
        rolldownOptions: { output: { minify: true } },
        lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'muse-encore-viewer' },
    },
})
