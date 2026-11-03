# MuseEncore

TypeScript port of the MuseScore Studio engraving engine (reference: **v4.7.5, commit 3654226**).
Goal: read `.mscz`/`.mscx` files and render them in the browser so that they look exactly like
the desktop app. License: GPL-3.0-only (same as MuseScore).
MuseEncore (the editor; with MuseEncore Viewer) is neither an official MuseScore project nor an official fork;
"MuseScore" only names the original software. The project was called "MuseScore Web" before: the browser storage
keys and database names (`musescoreweb:*`, `musescoreweb-scores`, `musescore-web-viewer`) keep that name so existing
users keep their data. The repository is https://github.com/pstaender/muse-encore (GitHub Pages:
https://pstaender.github.io/muse-encore/); the local checkout directory may still be called musescoreweb.

## Reference sources

- `./MuseScore` is a git submodule pinned to the reference version v4.7.5
  (`git submodule update --init`; shallow). Read the sources there directly, e.g.
  `MuseScore/src/engraving/rendering/score/chordlayout.cpp`. When updating the reference, move the submodule
  to the new tag and follow the changes file by file.
- MuseScore 4.7.5 is installed at `/Applications/MuseScore 4.app`; use it to create reference renders:
  `"/Applications/MuseScore 4.app/Contents/MacOS/mscore" -o out.svg file.mscz` (SVG has a CSS class per element type)
  or `-r 100 -o out.png` for PNGs.
- Test scores: the v4.7.5 vtest files in `MuseScore/vtest/scores` (newer MuseScore versions contain
  5.0 files that the 4.7.5 reader rejects), plus real-world scores in `mscz-test-files/`.

## Structure (mirrors the C++ tree)

```
src/
  framework/global      realfn (fuzzy float compare like muse::RealIsEqual), clipboard.ts (MimeData/Clipboard: the
                        in-memory replacement of QMimeData/QApplication::clipboard(), synced with the browser by the editor),
                        cryptographichash.ts (MD4 for image store names)
  framework/draw        geometry, PainterPath, Transform, Pen/Brush/Font, Painter,
                        FontProvider (opentype.js, replaces Qt font metrics), canvas and SVG paint providers,
                        Pixmap/ImageProvider/SvgRenderer + imagecache.ts (asynchronous image decoding; pages are redrawn
                        when an image is decoded: onImageDecoded/imagesDecoded in index.ts)
  framework/midi        MIDI 1.0 events (midievent.ts; MidiEvent = C++ midi::Event), internal/platform/web/webmidiinport.ts: the input port
                        on the browser's Web MIDI API (permission, devices, connection; no sysex, no MIDI 2.0)
  framework/midiremote  MidiRemote: the actions of MIDI keys and controllers (the MIDI mappings)
  framework/mpe         PlaybackSetupData, SoundId/SoundCategory/SoundSubCategory as strings (soundid.ts, generated)
  framework/audio/fluidsynth  soundmapping: the MS Basic presets of MuseScore 4's Fluid synth per sound and articulation
                        (findPrograms, articulationSounds; tables generated)
  engraving/types       enums (types.ts), Fraction, Spatium, SymId (generated)
  engraving/style       Sid + default style (generated), MStyle
  engraving/infrastructure  Shape, Skyline, Smufl, MscReader (zip)
  engraving/dom         the score object model (Score, Measure, Segment, Chord, Note, ...)
  engraving/rw          XmlReader, readers (read460 for 4.x incl. read400/read410 compat, read302 for 3.x, read206 for 2.x),
                        rw/compat (chord list hook, CompatUtils incl. doCompatibilityConversions = compatconversions.ts),
                        XmlWriter, rw/write (Writer, TWrite, MeasureWrite, StaffWrite, ConnectorInfoWriter, WriteContext),
                        MscSaver (.mscz contents); infrastructure/MscWriter (zip via fflate), EID/EIDRegister;
                        rw/rwregister.ts: the reader/writer the DOM uses for the clipboard (mime data, paste)
  engraving/compat      EngravingCompat (pre/post layout conversions of old files), page format, dummy element;
                        compat/midi: the MIDI renderer (CompatMidiRender: play events, tempo/pause maps, velocities)
  engraving/playback    PlaybackSetupDataResolver: instrument -> sound (mapping/setupdatamaps.ts generated)
  engraving/rendering/score  layout (ScoreLayout with the page view and the continuous views ScoreHorizontalViewLayout /
                        ScoreVerticalViewLayout, SystemLayout, ChordLayout, ...) and painting (TDraw)
  engraving/rendering/single  SingleLayout/SingleDraw: standalone items (palette cells) on the palette score
  engraving/rendering/editmode  EditModeRenderer: text cursor/selection of an edited text, grips
  engraving/editing     score changes (edit.cpp, cmd.cpp, ... as Score module augmentations) through the undo stack
                        (undo.ts: UndoStack/UndoMacro/UndoCommand; startCmd/endCmd/undoRedo in cmd.ts, CmdState in
                        cmdstate.ts); dom/noteentry.ts and dom/input.ts (InputState) for note input; textedit.ts
                        (TextBase editing + its undo commands), editdata.ts/elementeditdata.ts (EditData: drag, grips,
                        keys); dom/paste.ts (Score::cmdPaste, pasteStaff, ...), dom/select.ts mime data; dom/range.ts
                        (ScoreRange/TrackList) for rewriting measures (time signature changes)
  project               the import (File > Open of other formats: NotationProject.doImport, INotationReader; importScore in
                        index.ts), the export (File > Export…): ExportDialogModel, ExportProjectScenario (file names, unit types),
                        NotationWritersRegister (the writers by suffix; MuseScore files per part are not in MuseScore)
  notation, project     MasterNotation / NotationParts / MasterNotationParts / NotationProject: creating new scores
                        (createScore), the part and staff commands of the Layout panel (editing/editpart.ts, editstaff.ts);
                        NotationInteraction / NotationNoteInput / NotationUndoStack: selection, editing, note input;
                        NotationMidiInput: MIDI input (note on/off, chords, real-time modes, preview, controllers; onNoteOns: the
                        notes of the microphone), the real-time advance; NotationPlayback (notationplayback.ts:
                        the events of the MIDI renderer in seconds, metronome, preview notes, loop boundaries);
                        ProjectMigrator / MdlMigrator: the migration of 3.x and older scores (layoutScore's `migration`
                        option; the app asks with MuseScore's migration dialog)
  importexport          imagesexport (PdfWriter on framework/draw/pdfdocument.ts + pdfpaintprovider.ts, PngWriter with
                        pngencoder.ts drawn in strips, SvgWriter), midi (exportmidi, midifile: the MIDI file export and
                        reading; midiimport: the MIDI import; midiconfiguration: its settings), musicxml (exportmusicxml: the MusicXML export, .musicxml and
                        .mxl; import/: the MusicXML import), capella (.cap/.capx import), guitarpro (Guitar Pro 1-7 and
                        Power Tab import); readers.ts registers the import readers (NotationReadersRegister)
  playback              IPlaybackController (set by the app; the notation scene seeks/plays through it); api.ts
  playalong             api.ts: the measures in the played order with their pitches, their rectangles (the editor's
                        Playalong, not in MuseScore)
  notationscene         NotationViewInputController (clicks, keys), NotationActionController (action codes -> commands),
                        PlaybackCursor, LoopMarker, ContinuousPanel (left edge of the horizontal continuous view),
                        NotationContextMenuModel (the score's context menu), EditStaff/EditStaffType (the logic of the
                        Staff/Part properties and Edit staff type dialogs; the app's dialogs show them), SelectDialog/
                        SelectNoteDialog ("Select > More…"; NotationElements filters the elements)
  palette               palette tree/palettes/cells with XML read/write and .mpal files (palettecreator: default +
                        master palettes), the user palette tree (paletteprovider.ts: PaletteProvider, UserPaletteController;
                        palettemodel.ts: PaletteTreeModel addressed by PaletteIndex), cell icons (PaletteCellIconEngine,
                        EngravingItemPreviewPainter); api.ts
  instrumentsscene      Layout panel tree model (LayoutPanelTreeModel and its tree items); api.ts
  inspector             Properties panel models (InspectorListModel, section/notation models, PropertyItem);
                        api.ts, inspectorselectionproperties.ts
  index.ts              public library API (re-exports palette/instrumentsscene/inspector api.ts)
fonts/                  runtime data: fonts (Leland, Bravura, Emmentaler/MScore, Gonville/Gootville, Petaluma,
                        Finale Maestro/Broadway, MuseJazz, Edwin, FreeSerif/FreeSans, MScoreBC for figured bass) with their
                        licenses, chord description files (chords/), fonts_figuredbass.xml, harmony_to_diagram.xml (fret
                        diagrams of chord symbols, generated), legacy default styles for old scores (styles/)
tools/gen/              generators for tables derived from the C++ sources (re-run on MuseScore updates)
tools/                  node scripts: render to PNG, compare with MuseScore output
viewer/                 MuseEncore Viewer: src/museencoreviewer.ts is the viewer component (plain DOM in a shadow root, styles in
                        src/viewer.css: page view, continuous views incl. fit to window, zoom, print, full screen, playback with
                        src/playback.ts; options and API types in src/types.ts); main.ts is the app (opening files, storage.ts),
                        src/index.ts the npm package's entry (applyMuseEncoreViewer), embed.html a dev page of the package API
packages/viewer/        the npm package "muse-encore-viewer" (package.json, README; dist/ + fonts/ are built by
                        tools/build-viewer-package.ts with viewer/vite.lib.config.ts: one bundled ES module for CDNs)
shared/                 code of both apps: icons.ts (SVG icons), playback/ (Synthesizer interface, SpessaSynth + MS Basic.sf3 loaded on first use and
                        cached, player.ts scheduler), vite-plugin-sound.ts (serves/copies the soundfont), notedetection/
                        (NoteDetector interface: microphone -> notes; microphone.ts opens, closes or keeps the microphone; basicpitch/ = Spotify's basic-pitch, Apache-2.0,
                        vendored with its TensorFlow.js model, loaded on demand, running in a Web Worker (worker.ts;
                        the audio worklet sends the audio to it; levelgate.ts drops too quiet notes, overtonefilter.ts the overtones of low notes); calibration.ts (the values measured with
                        the calibration sheet); replaceable in
                        createNoteDetector)
editor/                 MuseEncore (the editor), Vite score editor app: React UI (App.tsx, home/, newscore/, dialogs/ mirror MuseScore's
                        QML pages), menu bar (menus/appmenu.ts = AppMenuModel), toolbars (toolbars/: docks, note input bar),
                        actions (actions/: MuseScore's UiActions + shortcuts, generated uiactiondata.ts; appactions.ts =
                        the handlers), i18n.ts (MuseScore's translations via vite-plugin-locales.ts; the app's own
                        strings without context are translated in locales/webstrings.json, webtr()), score view
                        (scoreview.ts, DOM code from the viewer; drops of palette cells), dragcontroller.ts (the data of
                        the current drag), session.ts (open/create/save scores; the migration dialog
                        dialogs/MigrationDialog.tsx), tabs.ts (scores open in other tabs: Web Locks), db.ts (IndexedDB via
                        Dexie), settings.ts (localStorage), playback/ (playbackcontroller.ts = playback actions on shared/playback,
                        playbackview.ts cursor/pan/loop markers; `?synth=none` = no sound), playalong/ (Playalong, not
                        in MuseScore: follower.ts = score following, playalongcontroller.ts, playalongview.ts; in note
                        input mode the button enters the notes played (enterMidiNotes = NotationMidiInput note-ons); calibration of the note
                        detection with calibration.mscx and CalibrationBox.tsx;
                        `?playalong-input=test-melody` instead of the microphone), midi/ (midicontroller.ts = MidiInputOutputController: connection, events to MidiRemote and the score,
                        settings.midi, midi-on, MIDI input pitch; only the visible, last focused tab takes the events; the permission is asked by
                        "Enable MIDI input" only), panels/ (the left dock: PanelDock.tsx tabs + splitter,
                        panels.ts state, palettes/ (palette tree stored as PaletteTree XML in localStorage, dialogs),
                        layout/, inspector/ UIs; editbridge.ts = all score changes of the
                        panels; the Layout panel's commands go through the library's NotationParts port)
test/                   vitest tests
```

File and class names follow the C++ ones (`chordlayout.cpp` -> `chordlayout.ts`, `ChordLayout`),
methods keep their C++ names, so changes in MuseScore can be followed file by file.

## Conventions

- Keep the port close to the original structure and logic; comment only where the TS code is not
  self-explanatory or deviates from C++ (e.g. features not ported yet: mark with `// TODO(port):`).
- C++ value types (PointF, RectF, ...) are classes here: never store a reference to another object's
  point/rect, clone instead. `Fraction` is immutable.
- `nidx` is `-1` (C++ `muse::nidx`).
- All layout units are MuseScore "pixels" at 1200 DPI (`DPI` in `types.ts`), spatium default 24.8.
- Text metrics must follow Qt's QFontMetricsF on a 1200 DPI device (see `fontprovider.ts`).
- Every file starts with the GPL SPDX header.
- The web UI is built with React (the viewer still uses plain DOM code; new UI, e.g. the editor, uses React).
  The engraving library itself stays framework independent.
- UI texts are MuseScore's English source strings with MuseScore's translation context (`qtrc("project", "New score")`,
  see share/locale/*.ts), so MuseScore's translations apply; commands are MuseScore's actions (codes, titles, icons,
  shortcuts from the generated table) registered with `registerAction`. Strings MuseScore does not have are
  translated in editor/locales/webstrings.json (all of MuseScore's languages; `webtr()`, `[null, text]` titles).
- The same command has the same icon in the editor and the viewer: when an icon changes, change it in both. Both use
  MuseScore's icon codes (the viewer's `ICON` table, the editor's actions); SVG icons (for what MuseScore's icon font does
  not have) are defined once in `shared/icons.ts`.
- TypeScript 7 (native compiler); `npm run typecheck` / `npm run build` use it.
- C++ destructors with side effects must be emulated explicitly (e.g. ~LayoutContext -> end of ScoreLayout.layoutRange).
- DOM -> rendering calls (C++ `renderer()->...`) go through hooks set in `rendering/score/scorerenderer.ts`.
- Score changes go through the undo stack like in C++ (`score.undo(new ChangeProperty(...))`, `undoChangeProperty`,
  `undoAddElement`, ...) between `startCmd()` and `endCmd()` (NotationInteraction: `startEdit()`/`apply()`); outside
  of a command (loading, createScore) they are applied directly. `endCmd`/`undoRedo` lay out the range the commands
  marked with `triggerLayout()` (partial layout like C++); a command without a range lays out the whole score.
  Undo/redo tests compare a hash of the SVG of all pages before and after (test/helpers.ts `scoreHash`).
- The DOM modules have import cycles: tests should import from `src/index` (or `./helpers`) first.
- There is no read400/read410: the 2.x/3.x readers call the shared read460 `TRead` functions where C++ calls
  `read400::TRead`. Version checks of read400 (`mscVersion() < 400` etc.) must therefore be in the read460
  functions (guarded by the file version), e.g. ignoring pre-4.0 slur offsets and stem lengths.

## Commands

- `npm run typecheck` - tsc
- `npm test` - vitest (library); `npm run test:e2e` - web viewer in headless Chrome; see `test/README.md`
- `npm run dev:viewer` (or `npm run dev`) - the viewer (Vite; `?url=<score>` opens a score, fonts are served from
  ./fonts; `/embed.html?url=<score>&options=<JSON>` shows the package API); `npm run build:viewer` builds it into dist-viewer/
- `npm run build:viewer-package` - the npm package muse-encore-viewer in packages/viewer (publish from there)
- `npm run dev:editor` - the editor (same options); `npm run build:editor` builds it into dist-editor/
  (it bundles MuseScore's templates from `MuseScore/share/templates`, so the submodule is needed)
- `npm run render -- <file.mscz> <out-prefix> [dpi | svg]` - render pages to PNG (or SVG) in node
- `npm run compare -- <file.mscz> [out-dir] [dpi]` - render with MuseScore and with this port and diff the PNGs
  (red = only MuseScore, blue = only port). For exact numbers compare with MuseScore's SVG export, which uses
  the same 1200 DPI coordinates as the layout.
- `npm run compare:all` - compare all vtest scores and `mscz-test-files/` with MuseScore against
  `test/compare-baseline.csv` (regressions fail); `-- --update-baseline` after intended changes
- `npm run roundtrip` - load -> saveMscz -> load every baseline score and compare the SVG of every page (exact, or
  equal within the rounding of 6-digit values; a second round trip must be exact)
- `npm run compare:musicxml -- [files]` - diff the MusicXML export against MuseScore's (`mscore -o out.musicxml`, cached in
  compare-out/musicxml/ref)
- `npm run compare:mscx` - diff writeMscx/saveMscz output (main .mscx, style, parts) against MuseScore's own re-save
  (`mscore -o out.mscx`, cached in compare-out/mscx/ref); EIDs are normalized
- `npm run bump-version [-- <version> [<viewer version> | -]]` - set the version of package.json and optionally of the
  viewer package (asks, suggesting the next patch versions), commit "Bumps version to x.y.z" and tag vx.y.z (no push,
  no npm publish)
- `npx tsx tools/gen/<gen-*.ts> MuseScore` - regenerate tables from the reference sources (symids, styledef,
  property, typesconv, noteheads, accidentals, textstyle, drumset, instrumenttemplates, scoreorders, soundmapping, harmonytodiagram [-> fonts], uiactions [-> editor/actions])

## Progress tracking

Keep `claude_history.md` up to date (what was done, what is missing, known differences).
