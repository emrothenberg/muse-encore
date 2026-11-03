# muse-encore-viewer

Show MuseScore files (`.mscz`/`.mscx`) in a web page, like an inline PDF viewer: the pages as MuseScore Studio lays
them out, MuseScore's continuous views, zoom, printing (vector pages), full screen and playback. MusicXML
(`.musicxml`/`.xml`/`.mxl`), MIDI (`.mid`/`.midi`/`.kar`), Capella (`.cap`/`.capx`), Guitar Pro
(`.gtp`/`.gp3`/`.gp4`/`.gp5`/`.gpx`/`.gp`) and Power Tab (`.ptb`) files are imported like MuseScore Studio's File > Open.

It is based on [MuseEncore](https://github.com/pstaender/muse-encore), a TypeScript port of MuseScore Studio's
engraving engine (reference version 4.7.5). Everything runs in the browser; no server is needed.

> **MuseEncore is neither an official MuseScore project nor a fork of MuseScore.** It is an independent
> port of MuseScore Studio's open source code and is not affiliated with or endorsed by MuseScore Limited or the
> MuseScore project. "MuseScore" is used here only to name the original software this project is based on.

## Usage

With a bundler:

```sh
npm install muse-encore-viewer
```

```js
import applyMuseEncoreViewer from 'muse-encore-viewer'

applyMuseEncoreViewer(document.getElementById('score'), 'scores/example.mscz')
```

From a CDN, without a build step:

```html
<div id="score" style="aspect-ratio: 3/4; width: 100%; height: auto;"></div>
<script type="module">
    import applyMuseEncoreViewer from 'https://cdn.jsdelivr.net/npm/muse-encore-viewer@latest/dist/muse-encore-viewer.js'

    applyMuseEncoreViewer('#score', 'scores/example.mscz', { toolbarGroups: { playback: true } })
</script>
```

The viewer fills the element, so give the element a height. Its controls live in a shadow root: the page's styles
do not change them and their styles do not leak into the page. Several viewers can be on one page.

The score is loaded with `fetch`, so a score on another host must allow cross-origin requests. Instead of a URL you can
pass the file's data (`ArrayBuffer`, `Uint8Array`) or a `File`/`Blob`.

## Options

All options with their defaults:

```js
const viewer = applyMuseEncoreViewer(targetElement, pathToMuseScoreFile, {
    centerAndResizeToPage: 1,     // fit this page (1-based) into the view and center it; false: start at the top
    zoom: 'whole-page',           // or 'page-width' or a percentage (100 with centerAndResizeToPage: false)
    continuousView: false,        // 'horizontal', 'vertical', 'window-fit'; false: the page view
    pageOrientation: 'horizontal',// the pages of the page view side by side, or 'vertical'
    twoPages: false,              // facing pages (scores with a two-sided page layout)
    toolbarGroups: {
        pageNavigation: true,     // previous / next page, page indicator
        pageView: true,           // view mode (page / continuous views) and page layout
        zoom: true,               // zoom in / out, zoom levels, center page
        playback: false,          // play / pause, rewind, play position
        print: true,              // print button
        fullScreen: true,         // full screen button
        file: false,              // open / close a file, file name, dropping files
    },
    keyboardShortcuts: false,     // MuseScore's shortcuts while the viewer has the focus, and the "?" button
    disableToolbar: false,        // no toolbar at all
    showStatusBar: false,         // the status bar below the score
    colorScheme: 'auto',          // 'light', 'dark'; auto: the browser's
    fontsUrl: undefined,          // the fonts directory; default: this package's fonts/ next to dist/
    soundFontUrl: undefined,      // MS Basic.sf3; default: MuseScore's repository (see Playback)
    onLoad: (info) => {},         // { fileName, title, pageCount }
    onError: (error) => {},
})
```

The continuous views are MuseScore's continuous view (horizontal: one long system; vertical: all systems on one long
page). `'window-fit'` (not in MuseScore) lays the score out as wide as the view, without system and page breaks, and
again when the view's size or the zoom changes.

## The viewer object

```js
await viewer.ready                 // { fileName, title, pageCount } when the score is shown
await viewer.load('other.mscz')    // another score
await viewer.load(blob, 'song.musicxml') // the file name's suffix selects the format
viewer.pageCount()
viewer.currentPage()               // 1-based
viewer.goToPage(3)
viewer.centerAndResizeToPage(2)
viewer.setZoom(150)                // or 'whole-page', 'page-width'
viewer.setContinuousView('window-fit') // or 'horizontal', 'vertical', false
await viewer.play()                // call it from a user gesture (the browser's autoplay rules)
viewer.pause()
viewer.stop()                      // back to the start
viewer.isPlaying()
await viewer.print()
viewer.toggleFullScreen()
viewer.destroy()
```

## Playback

The playback uses MuseScore's MIDI renderer and MuseScore's soundfont "MS Basic.sf3" (MIT license, 51 MB) with the
[SpessaSynth](https://github.com/spessasus/spessasynth_lib) synthesizer. The soundfont is downloaded on the first
playback and kept in the browser's Cache Storage. By default it is loaded from MuseScore's repository at the
reference version (raw.githubusercontent.com); set `soundFontUrl` to serve it yourself.

## Fonts

The engraving fonts (Leland, Bravura, Edwin, ... with their licenses) are in `fonts/` and loaded at runtime from the
same place as the module (`../fonts/` relative to `dist/muse-encore-viewer.js`), which works with CDNs that serve the
whole package (jsDelivr, unpkg). If you copy only the module, copy the fonts too and set `fontsUrl`.

## License

GPL-3.0-only, like MuseScore Studio. The fonts have their own licenses (see `fonts/`).

## Building

In the repository: `npm run build:viewer-package` builds this package into `packages/viewer` (the module, its
type declarations, the fonts and the license); then `npm publish` there. `packages/viewer/example/` shows a few
viewers on a page (`npx vite packages/viewer`, then open `/example/?url=<score>`); it is online at
[pstaender.github.io/muse-encore/viewer-package/example/](https://pstaender.github.io/muse-encore/viewer-package/example/).
