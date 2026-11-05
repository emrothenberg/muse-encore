/*
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { join } from 'node:path'
import { defineConfig } from 'vite'
import { basicPitchModel } from '../shared/notedetection/basicpitch/vite-plugin-basicpitch'
import { musescoreSound } from '../shared/vite-plugin-sound'

export default defineConfig({
    root: __dirname,
    // MuseScore's soundfont (MS Basic.sf3) for the playback, the model of the playalong's note detection
    plugins: [musescoreSound(join(__dirname, '../MuseScore/share/sound')), basicPitchModel()],
    // the runtime fonts are served from the repository's fonts directory (e.g. /leland/Leland.otf)
    publicDir: '../fonts',
    // only the note detection's worker imports it: found when the playalong starts, it would reload the page
    optimizeDeps: { include: ['@tensorflow/tfjs'] },
    build: { outDir: '../dist-viewer', emptyOutDir: true },
})
