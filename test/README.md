# Tests

Test scores come from the MuseScore submodule (`git submodule update --init`): the v4.7.5 vtest scores
(`MuseScore/vtest/scores`) and demos (`MuseScore/demos`), plus real-world scores in `mscz-test-files/`.

| Command | What | Needs |
|---|---|---|
| `npm test` | library: reading, layout, drawing, SVG, font fallback, regressions | submodule |
| `npm run test:e2e` | web viewer in headless Chrome | Google Chrome (`CHROME_PATH` for another binary) |
| `npm run compare:all` | every page against MuseScore 4.7.5, compared with `test/compare-baseline.csv` | MuseScore 4.7.5 app |
| `npm run compare -- <file>` | one score against MuseScore, with diff images (red = only MuseScore, blue = only port) | MuseScore 4.7.5 app |

## Library (`npm test`)

- `rendering.test.ts` — page counts as in MuseScore (2.x, 3.x, 4.x files), two-sided layouts, titles, landscape
  page sizes; drawing a region of a page (zoomed-in tiles) gives the same pixels as the whole page.
- `svg.test.ts` — SVG output: each glyph is defined once and placed with `<use>`; definitions shared by the pages
  of a document; unique ids; rasterized SVG equals the canvas output (1 px tolerance for antialiasing); masks.
- `fontfallback.test.ts` — characters missing in the score fonts (CJK) are measured and drawn with a platform
  font (serif or sans-serif like the score font); none without a fallback engine (node).
- `regressions.test.ts` — bugs found in real-world scores (e.g. Note.clone sharing the accidental).
- `chordlist.test.ts`, `style.test.ts` — chord symbol descriptions, style reading.
- `midiinput.test.ts` — MIDI input with a fake device: the browser's API, the MIDI mappings, note input of all kinds.

## Web viewer and editor (`npm run test:e2e`, `test/e2e/webapps.e2e.ts`)

Starts the Vite dev server and serves the scores from a fake host. The score view is shared by both apps, so
these tests run for the viewer and the editor. Covers:

- empty state (viewer): drop target centered, nothing to scroll (the toolbar is the viewer's; in the editor the
  same commands are MuseScore actions in a toolbar and the shortcuts are MuseScore's, e.g. ⌃⌘F for full screen
  on macOS)
- loading window while a file is downloaded/laid out; input blocked meanwhile
- opening via `?url=`, page centered, last file remembered across reloads, close button forgets it (also when
  reloading immediately; the editor then shows its home screen)
- pages side by side / vertical; two-page spreads only for two-sided layouts ([1], [2, 3], …), spread navigation
- MuseScore shortcuts (Ctrl +/-/0, Home/End, Ctrl+PgDn), Ctrl+wheel zoom at the pointer
- space + drag beyond the pages (a 48 px strip stays visible), "Center measure" (the bar being played, the
  selection in the editor, the paused position or the first bar; its page if the page fits into the view)
- high zoom: tiles of the visible part at full resolution, at most 16 Mpx
- full screen: toolbar collapsed, shown at the top edge
- printing: vector pages (no bitmaps) on sheets of the score's page size (portrait and landscape), page count

## Editor (`test/e2e/editor.e2e.ts`)

- home screen at the first start; opened scores listed with thumbnails (IndexedDB), no duplicate entry for the
  same file, reopening from the list
- New Score dialog from instruments (search, add, order) with title/composer; the new score is created again after
  a reload; removing a created score asks first
- New Score dialog from a template with a rendered preview (Ctrl+N)
- settings (grid/list view) kept across reloads
- menu bar: MuseScore's menus, mouse and keyboard (F10, arrows, End, Enter)
- toolbars: dragging a toolbar to another place, hiding one (View > Toolbars), customizing the note input toolbar,
  the layout kept across reloads, "Restore the default layout"
- translations: German through Preferences (menus, home screen, instrument search), kept across reloads
- panels: Palettes/Layout/Properties toggled by the View menu, F7/F9 and the tab menu, tab keyboard navigation,
  width (splitter) and open panels kept, "Restore the default layout"; palette cells drawn (non-empty canvas),
  grid arrows, search; Layout panel lists the parts and follows the selection; Properties panel shows the score
  sections without selection, the Note section of a selected note, Measures for a range

## Comparison with MuseScore (`npm run compare:all`)

Renders every score with MuseScore 4.7.5 (`/Applications/MuseScore 4.app`) and the port at 50 DPI and measures
the share of ink pixels that differ per page. A page more than 0.5 percentage points worse than in
`test/compare-baseline.csv` is a regression (exit code 1). After intended changes:
`npm run compare:all -- --update-baseline`. Investigate single elements by comparing with MuseScore's SVG export
(`mscore -o out.svg file.mscz`, one CSS class per element type), which uses the same 1200 DPI coordinates.

## Manual checks

Not automated (need a real display or device):

- pinch zoom on touch screens and trackpads (Safari gesture events), middle mouse button drag
- real full screen (F11 / button) in Chrome, Safari, Firefox; toolbar tap on touch devices
- printing on paper and "Save as PDF" in Safari and Firefox
- the spinner keeps turning during the layout of a large score (e.g. goldberg.mscz)
- dark mode appearance; fallback fonts for CJK text on other platforms
- editor: New Score dialog with the keyboard (lists, dropdown panels, Escape), on a phone-sized screen; storage
  in a private window (nothing is kept, no errors)
