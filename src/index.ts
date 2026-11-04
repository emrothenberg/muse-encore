/*
 * SPDX-License-Identifier: GPL-3.0-only
 * MuseEncore — port of MuseScore Studio (https://github.com/musescore/MuseScore)
 * Copyright (C) 2021-2026 MuseScore Limited and others
 *
 * Public library API: load .mscz/.mscx files, lay them out and paint pages onto a canvas.
 * Framework independent; works in browsers and in node (with a canvas implementation).
 */

import { EditStyle } from './notationscene/editstyle'
import { ScoreRangeUtilities } from './notation/utilities/scorerangeutilities'
import { CanvasPaintProvider, type Canvas2D } from './framework/draw/canvaspaintprovider'
import { Painter } from './framework/draw/painter'
import { Transform } from './framework/draw/types/transform'
import { SvgGlyphDefs, SvgPaintProvider } from './framework/draw/svgpaintprovider'
import { imageCache } from './framework/draw/imagecache'
import { PointF, RectF } from './framework/draw/types/geometry'
import { Fraction } from './engraving/types/fraction'
import { DPI, DurationType, Key, PreferSharpFlat } from './engraving/types/types'
import { Instrument } from './engraving/dom/instrument'
import { EditStaff } from './notationscene/editstaff'
import { NotationContextMenuModel, type ContextMenuItem } from './notationscene/notationcontextmenumodel'
import { StaffType } from './engraving/dom/stafftype'
import { Part } from './engraving/dom/part'
import type { InstrumentChange } from './engraving/dom/instrchange'
import { TimeSigType } from './engraving/dom/timesig'
import { ScoreOrder } from './engraving/dom/scoreorder'
import {
    TraitType, instrumentGenres as engravingInstrumentGenres, instrumentGroups, instrumentOrders, searchTemplate,
} from './engraving/dom/instrtemplate'
import type { MidiEvent } from './framework/midi/midievent'
import { NotationProject, ProjectCreateOptions } from './project/internal/notationproject'
import { Sid } from './engraving/style/styledef'
import { fontProvider } from './engraving/infrastructure/engravingcontext'
import { MscLoader, loadScore as loadMasterScore } from './engraving/rw/mscloader'
import { createNotationReadersRegister } from './importexport/readers'
import { NotationReadError, type NotationReaderInteractive, type NotationReaderOptions } from './project/inotationreader'
import { defaultMusicXmlImportSettings, musicXmlImportConfiguration, type MusicXmlImportSettings } from './importexport/musicxml/internal/musicxmlconfiguration'
import { defaultMidiImportSettings, midiImportConfiguration, type MidiImportSettings } from './importexport/midi/internal/midiconfiguration'
import { NotationRuler } from './notationscene/notationruler'
import { NotationConfiguration } from './notation/internal/notationconfiguration'
import { SelectDialog, SelectNoteDialog } from './notationscene/selectdialog'
import { NoteSpellingType } from './engraving/types/types'
import type { Harmony } from './engraving/dom/harmony'
import { NoteCaseType, tpc2name, tpc2pitch } from './engraving/dom/pitchspelling'
import { HDuration, Voicing } from './engraving/dom/realizedharmony'
import { TupletBracketType, TupletNumberType } from './engraving/dom/tuplet'
import { AddBoxesTarget } from './notation/notationtypes'
import { TupletOptions } from './notation/notationtypes'
import { ProjectMigrator, migrationTypeFromMscVersion } from './project/internal/projectmigrator'
import { MigrationType, MigrationOptions } from './project/types/projecttypes'
import type { TemplateFileProvider } from './project/internal/mdlmigrator'
import { MscReader } from './engraving/infrastructure/mscreader'
import { MscWriter } from './engraving/infrastructure/mscwriter'
import { MscSaver } from './engraving/rw/mscsaver'
import { Writer } from './engraving/rw/write/writer'
import { EngravingCompat } from './engraving/compat/engravingcompat'
import { MasterScore } from './engraving/dom/masterscore'
import type { Score } from './engraving/dom/score'
import { ContinuousPanel } from './notationscene/continuouspanel'
import { LayoutMode } from './engraving/dom/score'
import { ScoreRenderer } from './engraving/rendering/score/scorerenderer'
import { Paint } from './engraving/rendering/score/paint'
import { setSelectInstrumentProvider as setInteractionSelectInstrumentProvider } from './notation/internal/notationinteraction'
import { NotationInteraction } from './notation/internal/notationinteraction'
import { NotationAccessibility } from './notation/internal/notationaccessibility'
import { NotationViewInputController } from './notationscene/notationviewinputcontroller'
import { NotationActionController } from './notationscene/notationactioncontroller'
import { EngravingConfiguration } from './engraving/internal/engravingconfiguration'
import { Pid, PropertyFlags, propertyId, propertyName, propertyType, propertyUserName } from './engraving/dom/property'
import { TranslatableString } from './framework/global/types/translatablestring'
import type { InspectorChange } from './inspector/abstractinspectormodel'
import { P_TYPE, propertyValueEquals, type PropertyValue } from './engraving/types/propertyvalue'
import { Spatium } from './engraving/types/dimension'
import { Color } from './framework/draw/types/color'
import { SizeF } from './framework/draw/types/geometry'
import { Align, DPMM, DurationTypeWithDots } from './engraving/types/types'
import { NoteEntryMethod } from './engraving/dom/input'
import { Accidental } from './engraving/dom/accidental'
import { TConv } from './engraving/types/typesconv'
import { ElementType } from './engraving/types/types'
import type { EngravingItem } from './engraving/dom/engravingitem'
// (imports of the palette section)
import { Factory } from './engraving/dom/factory'
import { scoreDummy } from './engraving/compat/dummyelement'
import { Dynamic } from './engraving/dom/dynamic'
import { Note } from './engraving/dom/note'
import { SymId } from './engraving/types/symid'
import { SymNames } from './engraving/types/symnames'
import { BarLineType, ClefType, DynamicType, NoteHeadGroup, NoteHeadType, ParenthesesMode, nidx } from './engraving/types/types'
import { KeyboardModifier } from './engraving/editing/editdata'
// (imports of the copy/paste, text editing and drag section)
import { MimeData, clipboard } from './framework/global/clipboard'
import { KeyboardKey, MouseButton } from './engraving/editing/editdata'
import { TextEditData } from './engraving/editing/textedit'
import { mimeStaffListFormat, mimeSymbolFormat, mimeSymbolListFormat } from './engraving/dom/mscore'
import type { ViewMouseEvent } from './notationscene/notationviewinputcontroller'
import type { NotationKeyEvent } from './notation/internal/notationinteraction'
// (imports of the parts section)
import { MasterNotationParts } from './notation/internal/masternotationparts'
import { NotationParts } from './notation/internal/notationparts'
import { InsertMode as PartsInsertMode } from './notation/internal/notationparts'
// (editing modules that register the undo commands of DOM classes: dom -> editing hooks)
import './engraving/editing/editpart'
import './engraving/editing/editharppedaldiagram'
import { customOrder, type PartInstrumentList } from './notation/notationtypes'
import { PageSettings } from './notationscene/pagesettings'
import { NotationStyle } from './notation/internal/notationstyle'
import type { NotationUndoStack } from './notation/internal/notationundostack'
import type { AddRemoveSystemLockType } from './notation/notationtypes'
import { NotationElements } from './notation/internal/notationelements'
import { ProjectPropertiesModel } from './project/projectpropertiesmodel'
import { MasterNotation } from './notation/internal/masternotation'
import { NotationSwitchListModel, PartListModel, type NotationContext } from './notationscene/partlistmodel'
import { SelectType } from './engraving/dom/select'

export { initEngravingFonts, fontsInitialized, type FontFileLoader } from './engraving/engravingmodule'
export { MscLoadError } from './engraving/rw/mscloader'

/**
 * whether layout break icons are laid out (C++ EngravingConfiguration::canLayoutIcons: in the app, not in the
 * converter); an editor that shows unprintable items (drawPage with printing: false) turns it on before loading scores
 */
export function setCanLayoutIcons(v: boolean): void {
    EngravingConfiguration.setCanLayoutIcons(v)
}
export { setTranslator, mtrc, qtrc, arg, type Translator } from './framework/global/translation'
export type { MasterScore } from './engraving/dom/masterscore'
export { NotationReadError, type NotationReaderInteractive, type NotationReaderOptions, type MusicXmlImportSettings, type MidiImportSettings }
export { Err as EngravingErr, errText } from './engraving/engravingerrors'
export type { Score } from './engraving/dom/score'
export type { Part } from './engraving/dom/part'
export type { StaffSettingsModel } from './instrumentsscene/staffsettingsmodel'
export type { InstrumentSettingsModel } from './instrumentsscene/instrumentsettingsmodel'
export type { SystemObjectsLayerSettingsModel } from './instrumentsscene/systemobjectslayersettingsmodel'
export { CustomizeKitDialog, NOTE_HEAD_NAMES, customizeKitNoteheadSymbols } from './palette/customizekitdialog'
export { DirectionV, NoteHeadGroup, NoteHeadType } from './engraving/types/types'
export type { Canvas2D } from './framework/draw/canvaspaintprovider'
export { SvgGlyphDefs } from './framework/draw/svgpaintprovider'
// the editor's panels: palettes, layout panel, properties (inspector)
export * from './palette/api'
export * from './instrumentsscene/api'
export * from './inspector/api'
export * from './notationscene/styledialog/api'
// playback: MIDI events, positions/times, playback cursor, loop markers
export * from './playback/api'
export { MidiEvent, Opcode } from './framework/midi/midievent'
export { NONE_DEVICE_ID, type MidiDevice, type MidiDeviceID } from './framework/midi/miditypes'
export { WebMidiInPort, type MidiAccessState, type MidiNavigator } from './framework/midi/internal/platform/web/webmidiinport'
export { ALL_MIDI_ACTIONS, MidiRemote, RemoteEventType, isValidRemoteEvent, noRemoteEvent, remoteEventFromMidiEvent, type MidiControlsMapping, type RemoteEvent } from './framework/midiremote/midiremote'
export { setMidiInputConfiguration, type MidiInputConfiguration } from './notation/internal/notationmidiinput'
export { NotationConfiguration } from './notation/internal/notationconfiguration'
export { NoteEntryMethod } from './engraving/dom/input'
export * from './playalong/api'
export {
    setFallbackFontEngine, createCanvasFallbackFontEngine, type FallbackFontEngine, type FallbackFont,
} from './framework/draw/internal/fontprovider'

/** Reads a .mscz (zip) or .mscx (xml) file. Fonts must be initialized before (initEngravingFonts). */
export function loadScore(data: Uint8Array | ArrayBuffer): MasterScore {
    const score = loadMasterScore(data)
    // NotationProject::doLoad reads the cloud info with std::map::operator[], which adds these meta tags (saved files
    // contain them)
    for (const tag of ['source', 'sourceRevisionId', 'audioComUrl']) {
        if (!score.metaTags().has(tag)) {
            score.setMetaTag(tag, '')
        }
    }
    score.setIsOpen(true) // GlobalContext::setCurrentNotation: the score is open (saved as <open>)
    score.setExcerptsChanged(false) // MasterNotation::initExcerptNotations
    return score
}

const s_notationReaders = createNotationReadersRegister()

/** the suffixes of the formats importScore reads (C++ the registered INotationReaders) */
export function importSuffixes(): string[] {
    return s_notationReaders.suffixes()
}

/** true for .mscz/.mscx (and the backup .mscz~) files: loadScore, else importScore (C++ isMuseScoreFile) */
export function isMuseScoreFile(fileName: string): boolean {
    return /\.(mscz|mscx|mscz~)$/i.test(fileName)
}

export interface ImportOptions extends NotationReaderOptions {
    /** the content of the style file for imports (Preferences > Import > "Use style file"); none: the built-in style */
    style?: string | null
}

/**
 * Imports a file of another format (MusicXML, MIDI, Capella, Guitar Pro; the suffix of `fileName` selects the reader)
 * into a new score like MuseScore's File > Open (NotationProject::doImport). Lay it out with layoutScore(). Throws a
 * NotationReadError if the file cannot be read; the questions and warnings of the import (e.g. MusicXML errors) are
 * asked through options.interactive. The settings of the import are set with setImportConfiguration().
 */
export async function importScore(data: Uint8Array | ArrayBuffer, fileName: string, options: ImportOptions = {}): Promise<MasterScore> {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    const score = await new NotationProject().doImport(s_notationReaders, bytes, fileName, options, options.style ?? null)
    score.setIsOpen(true)
    score.setExcerptsChanged(false)
    return score
}

/** the file types File > Open accepts (the accept attribute of a file input): MuseScore files and the import formats */
export function openFileAccept(): string {
    return ['mscz', 'mscx', ...importSuffixes()].map(s => '.' + s).join(',')
}

/** the name of a score file without the suffix of a MuseScore file or of an import format */
export function scoreBaseName(fileName: string): string {
    const m = /\.([^.]+)$/.exec(fileName)
    return m && (isMuseScoreFile(fileName) || importSuffixes().includes(m[1].toLowerCase())) ? fileName.slice(0, m.index) : fileName
}

/** opens a MuseScore file (loadScore) or imports a file of another format (importScore) */
export async function openScoreFile(data: Uint8Array | ArrayBuffer, fileName: string, options: ImportOptions = {}): Promise<MasterScore> {
    return isMuseScoreFile(fileName) ? loadScore(data) : importScore(data, fileName, options)
}

/** the settings of the import (Preferences > Import): MusicXML (C++ import/musicXml/*) and MIDI (io/midi/*) */
export interface ImportConfiguration {
    musicXml: MusicXmlImportSettings
    midi: MidiImportSettings
}

/** MuseScore's defaults of the import settings */
export function defaultImportConfiguration(): ImportConfiguration {
    return { musicXml: defaultMusicXmlImportSettings(), midi: defaultMidiImportSettings() }
}

export function importConfiguration(): ImportConfiguration {
    return { musicXml: musicXmlImportConfiguration().settings(), midi: midiImportConfiguration().settings() }
}

export function setImportConfiguration(configuration: { musicXml?: Partial<MusicXmlImportSettings>; midi?: Partial<MidiImportSettings> }): void {
    if (configuration.musicXml) {
        musicXmlImportConfiguration().setSettings(configuration.musicXml)
    }
    if (configuration.midi) {
        midiImportConfiguration().setSettings(configuration.midi)
    }
}

/**
 * Loads a template of share/templates (the .mscx file and the score_style.mss of its directory) as it is, e.g. for a
 * preview (MuseScore's TemplatePaintView); lay it out with layoutScore(). New scores are made with createScore().
 */
export function loadTemplate(mscx: string, style?: string | null): MasterScore {
    const encoder = new TextEncoder()
    const files = new Map<string, Uint8Array>([['template.mscx', encoder.encode(mscx)]])
    if (style) {
        files.set('score_style.mss', encoder.encode(style))
    }
    const score = new MasterScore()
    new MscLoader().loadMscz(score, MscReader.fromFiles(files, { mainFileName: 'template.mscx' }))
    return score
}

export { MigrationType, MigrationOptions } from './project/types/projecttypes'
export type { TemplateFileProvider } from './project/internal/mdlmigrator'

/** the migration a score of an older version can get (Unknown: none, 4.0 and newer) */
export function scoreMigrationType(score: MasterScore): MigrationType {
    return migrationTypeFromMscVersion(score.mscVersion())
}

/** the version of MuseScore that saved the score (e.g. "3.6.2"; C++ EngravingProject::appVersion) */
export function scoreAppVersion(score: MasterScore): string {
    return score.mscoreVersion()
}

export interface LayoutScoreOptions {
    /**
     * the migration of a score of MuseScore 3 or older when it is laid out the first time (the options the user chose
     * in MuseScore's migration dialog); none: the score keeps its old style
     */
    migration?: MigrationOptions | null
    /** the files of MuseScore's share/templates, e.g. the drumsets of the migration of MDL percussion */
    templateFile?: TemplateFileProvider | null
}

/** Lays out the whole score (pages, systems, measures, ...) */
export function layoutScore(score: MasterScore, options: LayoutScoreOptions = {}): void {
    // MuseScore lays out a loaded score twice (EngravingProject::loadMscz and NotationProject::doLoad) and some
    // results depend on the previous pass (e.g. chord shapes include the lyrics bboxes, which are only laid out
    // after the chord shapes are filled), so do the same to get identical results.
    // The compatibility conversions for older files run between and after these passes (NotationProject::load).
    const firstLayout = !s_compatDone.has(score)
    // C++ the layouts of the loading run in Score::update(), which sets up the tempo map afterwards if needed
    const update = (): void => {
        ScoreRenderer.layoutScore(score, new Fraction(0, 1), new Fraction(-1, 1))
        if (score.needSetUpTempoMap()) {
            score.setUpTempoMap()
            score.setNeedSetUpTempoMap(false)
        }
    }
    update()
    if (firstLayout) {
        s_compatDone.add(score)
        // NotationProject::doLoad: the migration (its command lays out the changed score)
        new ProjectMigrator(options.templateFile ?? null).migrateEngravingProjectIfNeed(score, options.migration ?? null)
        EngravingCompat.doPreLayoutCompatIfNeeded(score)
        score.updateCapo(/* ignoreNotationUpdate */ true)
    }
    update()
    if (firstLayout && EngravingCompat.doPostLayoutCompatIfNeeded(score)) {
        ScoreRenderer.layoutScore(score, new Fraction(0, 1), new Fraction(-1, 1))
    }
}

const s_compatDone = new WeakSet<Score>()

/**
 * The view modes of MuseScore's notation view (NotationPainting::setViewMode) plus 'fit-width' (not in MuseScore):
 * - 'page': page view
 * - 'continuous-horizontal': continuous view (horizontal), one system on one page (LayoutMode::LINE)
 * - 'continuous-vertical': continuous view (vertical), all systems on one long page (LayoutMode::SYSTEM)
 * - 'fit-width': like 'continuous-vertical', but the systems are as wide as `width` (e.g. the window) and only
 *   section breaks start a new system
 */
export type ViewMode = 'page' | 'continuous-horizontal' | 'continuous-vertical' | 'fit-width'

export function viewMode(score: Score): ViewMode {
    switch (score.layoutMode()) {
    case LayoutMode.LINE:
    case LayoutMode.HORIZONTAL_FIXED:
        return 'continuous-horizontal'
    case LayoutMode.SYSTEM:
        return score.reflowWidth() ? 'fit-width' : 'continuous-vertical'
    default:
        return 'page'
    }
}

/**
 * Sets the view mode and lays out the score again if it changed. `width`: the page width of 'fit-width' in inches
 * (the systems are this width minus the page margins). Returns true if the layout changed.
 */
export function setViewMode(score: Score, mode: ViewMode, width = 0): boolean {
    const layoutMode = mode === 'continuous-horizontal' ? LayoutMode.LINE
        : mode === 'continuous-vertical' || mode === 'fit-width' ? LayoutMode.SYSTEM : LayoutMode.PAGE
    const reflowWidth = mode === 'fit-width' ? Math.round(width * DPI) : 0
    if (score.layoutMode() === layoutMode && score.reflowWidth() === reflowWidth) {
        return false
    }
    score.setLayoutMode(layoutMode)
    score.setReflowWidth(reflowWidth)
    if (s_compatDone.has(score)) {
        ScoreRenderer.layoutScore(score, new Fraction(0, 1), new Fraction(-1, 1))
    }
    return true
}

/**
 * Runs `fn` with the score laid out in the page view (e.g. for printing or a thumbnail of the first page, like
 * Score::print) and lays it out in its view mode again afterwards.
 */
export function withPageView<T>(score: Score, fn: () => T): T {
    const layoutMode = score.layoutMode()
    const reflowWidth = score.reflowWidth()
    if (layoutMode === LayoutMode.PAGE) {
        return fn()
    }
    score.setLayoutMode(LayoutMode.PAGE)
    score.setReflowWidth(0)
    ScoreRenderer.layoutScore(score, new Fraction(0, 1), new Fraction(-1, 1))
    try {
        return fn()
    } finally {
        score.setLayoutMode(layoutMode)
        score.setReflowWidth(reflowWidth)
        ScoreRenderer.layoutScore(score, new Fraction(0, 1), new Fraction(-1, 1))
    }
}

/** MuseScore saves laid out scores (multimeasure rests, compatibility conversions of old files happen with the layout) */
function ensureLaidOut(score: Score): void {
    if (s_compatDone.has(score)) {
        return
    }
    if (score.isMaster()) {
        layoutScore(score as MasterScore)
    } else {
        // a part (excerpt) score: ExcerptNotation::init lays it out (no compatibility conversions of its own)
        ScoreRenderer.layoutScore(score, new Fraction(0, 1), new Fraction(-1, 1))
        s_compatDone.add(score)
    }
}

/** The main .mscx file of the score as MuseScore 4.7.5 writes it (Writer::writeScore; the style is in score_style.mss) */
export function writeMscx(score: Score): string {
    ensureLaidOut(score)
    return Writer.writeScore(score)
}

/**
 * A complete .mscz file (MasterScore::writeMscz: META-INF/container.xml, score_style.mss, the score, the parts
 * (Excerpts/) and a custom chord list). `fileName` (e.g. "My Score.mscz") gives the name of the .mscx inside.
 */
export function saveMscz(score: MasterScore, fileName?: string): Uint8Array {
    ensureLaidOut(score)
    const writer = new MscWriter({ filePath: fileName })
    new MscSaver().writeMscz(score, writer)
    return writer.zipData()
}

export function pageCount(score: Score): number {
    return score.npages()
}

/** the page format of the style in inches (the page size of the page view, also in the continuous views) */
export function pageFormatSize(score: Score): { width: number; height: number } {
    // not Paint.pageSizeInch: that is the size of the first laid out page (the long page of a continuous view)
    return { width: score.style().styleD(Sid.pageWidth), height: score.style().styleD(Sid.pageHeight) }
}

/** page size in inches (in the continuous views the size of their single page) */
export function pageSize(score: Score, pageIdx = 0): { width: number; height: number } {
    const bbox = score.pages()[pageIdx]?.ldata().bbox()
    if (!bbox) {
        const s = Paint.pageSizeInch(score)
        return { width: s.width(), height: s.height() }
    }
    return { width: bbox.width() / DPI, height: bbox.height() / DPI }
}

/** the bounding box of a system of a page (inches from the page's top left), e.g. a preview of the first system */
export function systemRect(score: Score, pageIdx = 0, systemIdx = 0): { x: number; y: number; width: number; height: number } | null {
    const system = score.pages()[pageIdx]?.systems()[systemIdx]
    if (!system) {
        return null
    }
    const r = system.ldata().bbox().translated(system.pos())
    return { x: r.x() / DPI, y: r.y() / DPI, width: r.width() / DPI, height: r.height() / DPI }
}

/** true if the score is laid out for two-sided printing (style "pageTwosided"): odd pages are right-hand pages */
export function isTwoSided(score: Score): boolean {
    return score.style().styleB(Sid.pageTwosided)
}

/** score title (metaTag "workTitle" or the first title text), empty if none */
export function scoreTitle(score: Score): string {
    return score.metaTag('workTitle') || ''
}

export interface DrawPageOptions {
    /** pixels per inch of the canvas (default 100) */
    dpi?: number
    /** fill the page with white before drawing (default true) */
    background?: boolean
    /**
     * draw like printing (default true). With false the page is drawn like MuseScore's notation view: invisible
     * elements grey, frames, selected elements in the selection colors and the range selection frame.
     */
    printing?: boolean
    /**
     * draw only this part of the page (in canvas pixels at `dpi`, relative to the page's top left corner); the canvas
     * then has the size of the region. Used to draw sharp tiles at high zoom without a huge page bitmap.
     */
    region?: { x: number; y: number; width: number; height: number }
    /**
     * device pixels per view pixel (window.devicePixelRatio when `dpi` includes it; default 1): the edit overlays
     * (grips, anchor lines, range frame) have sizes in view pixels like the logical pixels of MuseScore's notation view
     */
    pixelRatio?: number
}

/**
 * Images (pictures of the .mscz) are decoded by the canvas drawing. In browsers this happens asynchronously: the
 * first drawing leaves images out, and `listener` is called when an image has been decoded (the page should be drawn
 * again). Returns a function that removes the listener.
 */
export function onImageDecoded(listener: () => void): () => void {
    return imageCache.onImageDecoded(listener)
}

/** true if images were left out of the last canvas drawing because they are still being decoded (see imagesDecoded()) */
export function hasPendingImages(): boolean {
    return imageCache.hasPending()
}

/** resolves when the images that are being decoded for the canvas drawing are available; then draw again */
export function imagesDecoded(): Promise<void> {
    return imageCache.whenDecoded()
}

/**
 * Sets the function that decodes images for the canvas drawing (default in browsers: createImageBitmap, or an <img>
 * element for SVG). In node, e.g. `pm => loadImage(Buffer.from(pm.data))` with @napi-rs/canvas. The decoder gets the
 * encoded data and its MIME type and returns the decoded image (a CanvasImageSource) or a promise of it.
 */
export function setImageDecoder(decoder: ((image: { data: Uint8Array; mimeType: string; width: number; height: number }) =>
unknown | Promise<unknown>) | null): void {
    imageCache.setDecoder(decoder ? (pm) => decoder({ data: pm.data(), mimeType: pm.mimeType(), width: pm.width(), height: pm.height() }) : null)
}

/**
 * Draws one page onto a 2D canvas context. The canvas should have the size pageSize() * dpi
 * (multiply with window.devicePixelRatio and pass a correspondingly higher dpi for sharp output on HiDPI screens).
 */
export function drawPage(score: Score, pageIdx: number, ctx: Canvas2D, options: DrawPageOptions = {}): void {
    const dpi = options.dpi ?? 100
    const scale = dpi / DPI
    const r = options.region
    const provider = new CanvasPaintProvider(ctx, new Transform(scale, 0, 0, scale, r ? -r.x : 0, r ? -r.y : 0))
    const painter = new Painter(provider, fontProvider(), 'page_' + pageIdx)
    let frameRect: RectF | undefined
    if (r) {
        // the region in score coordinates: only the items intersecting it are painted
        const pagePos = score.pages()[pageIdx]?.pos() ?? new PointF()
        frameRect = new RectF(r.x / scale, r.y / scale, r.width / scale, r.height / scale).translated(pagePos)
    }
    const isPrinting = options.printing ?? true
    Paint.paintScore(painter, score, {
        fromPage: pageIdx,
        toPage: pageIdx,
        isPrinting,
        printPageBackground: options.background ?? true,
        frameRect,
    })
    if (!isPrinting) {
        // C++ currentScaling(painter): the view's logical pixels per score unit
        drawSelectionRange(score, pageIdx, painter, scale / (options.pixelRatio ?? 1))
    }
}

const s_continuousPanels = new WeakMap<Score, ContinuousPanel>()

/**
 * The continuous view (horizontal): MuseScore's ContinuousPanel, the staff names, clefs, key and time signatures at the
 * left edge of the view once the beginning of the score is scrolled out of it. `left` and `top` are the position of the
 * top left corner of the view on the page (inches; the measure number is shown above the topmost staff whose number is
 * in the view); the canvas shows the page from x = left at its left edge (y = 0 at its top) at `dpi`. The panel covers
 * the whole height of the page. Returns null if there is no panel, else its width in inches and the key of its
 * contents: with the key of the contents the canvas shows (`shownKey`), nothing is painted if they are unchanged
 * (`painted` false). The contents don't depend on `left` otherwise.
 */
export function drawContinuousPanel(score: Score, ctx: Canvas2D,
    options: { dpi: number; left: number; top?: number; shownKey?: string }): { width: number; key: string; painted: boolean } | null {
    if (!score.lineMode() || !score.npages()) {
        return null
    }
    let panel = s_continuousPanels.get(score)
    if (!panel) {
        panel = new ContinuousPanel(score)
        s_continuousPanels.set(score, panel)
    }
    const scale = options.dpi / DPI
    const left = options.left * DPI
    const provider = new CanvasPaintProvider(ctx, new Transform(scale, 0, 0, scale, -left * scale, 0))
    const painter = new Painter(provider, fontProvider(), 'continuous_panel')
    const shownKey = options.shownKey
    if (!panel.paint(painter, { left, top: (options.top ?? 0) * DPI, shownKey }, { isPrinting: false })) {
        return null
    }
    return { width: panel.backgroundWidth() / DPI, key: panel.key(), painted: panel.key() !== shownKey }
}

/** the range selection rectangle (MuseScore's notation view paints it after the score) */
function drawSelectionRange(score: Score, pageIdx: number, painter: Painter, scaling: number): void {
    const page = score.pages()[pageIdx]
    if (!page) {
        return
    }
    const pagePos = page.pos()
    painter.translate(pagePos.times(-1))
    if (score.selection().isRange()) {
        notationState(score).interaction.drawSelectionRange(painter, scaling)
    }
    if (noteInputCursorPage(score) === pageIdx) {
        // C++ AbstractNotationPaintView::paint
        const interaction = notationState(score).interaction
        const noteInput = interaction.noteInput()
        if (interaction.shouldDrawInputPreview()) {
            interaction.drawInputPreview(painter, { isPrinting: false })
        }
        if (noteInput.usingNoteInputMethod(NoteEntryMethod.BY_DURATION) && !NotationConfiguration.useNoteInputCursorInInputByDuration()) {
            NotationRuler.paint(painter, noteInput.state())
        } else {
            drawNoteInputCursor(score, painter)
        }
    }
    drawEditMode(score, page, painter, scaling)
    painter.translate(pagePos)
}

/** the page of the note input cursor, -1 if not in note input mode */
function noteInputCursorPage(score: Score): number {
    if (!score.noteEntryMode()) {
        return -1
    }
    const page = score.inputState().segment()?.measure().system()?.page()
    return page ? score.pages().indexOf(page) : -1
}

/** C++ NoteInputCursor::paint (the cursor drawn by MuseScore's notation view; TODO(port): TAB string marks) */
function drawNoteInputCursor(score: Score, painter: Painter): void {
    const noteInput = notationState(score).interaction.noteInput()
    const state = noteInput.state()
    const fillColor = EngravingConfiguration.selectionColor(state.voice())
    const cursorRect = noteInput.cursorRect()
    if (!cursorRect.isValid()) {
        return
    }

    const cursorRectColor = fillColor.clone()
    cursorRectColor.setAlpha(NOTE_INPUT_CURSOR_OPACITY)
    painter.fillRect(cursorRect, cursorRectColor)

    const staff = state.staff()
    if (!staff) {
        return
    }

    const spatium = staff.staffType(state.tick()).spatium()
    const leftLineWidth = Math.trunc(0.14 * spatium)

    const leftLine = new RectF(cursorRect.topLeft().x(), cursorRect.topLeft().y(), leftLineWidth, cursorRect.height())
    painter.fillRect(leftLine, fillColor)
}

/** C++ NotationConfiguration::cursorOpacity() */
const NOTE_INPUT_CURSOR_OPACITY = 50

export interface DrawPageSvgOptions {
    /** fill the page with white before drawing (default true) */
    background?: boolean
    /** draw like printing (default true); false: like MuseScore's notation view (see DrawPageOptions.printing) */
    printing?: boolean
    /**
     * glyph definitions shared by several pages in one HTML document: the page then only references them
     * and `defs.svg()` must be added to the document once, after all pages are drawn.
     * Without it the SVG is standalone.
     */
    defs?: SvgGlyphDefs
    /** pixels per inch the SVG is shown at (default 100); only used for the width of the range selection frame */
    dpi?: number
}

/** Draws one page as SVG (vector graphics, size in inches, each glyph outline defined once and reused) */
export function drawPageSvg(score: Score, pageIdx: number, options: DrawPageSvgOptions = {}): string {
    const provider = new SvgPaintProvider(options.defs ?? new SvgGlyphDefs(), options.defs ? `p${pageIdx}-` : '')
    const painter = new Painter(provider, fontProvider(), 'page_' + pageIdx)
    const isPrinting = options.printing ?? true
    Paint.paintScore(painter, score, {
        fromPage: pageIdx,
        toPage: pageIdx,
        isPrinting,
        printPageBackground: options.background ?? true,
    })
    if (!isPrinting) {
        drawSelectionRange(score, pageIdx, painter, (options.dpi ?? 100) / DPI)
    }
    const size = pageSize(score, pageIdx)
    const bbox = score.pages()[pageIdx]?.ldata().bbox() ?? new RectF(0, 0, size.width * DPI, size.height * DPI)
    return provider.svg(`${size.width}in`, `${size.height}in`, bbox, !options.defs)
}

// ---------------------------------------------------------------------------------------------------------------------
//   new scores (MuseScore's New Score dialog)
// ---------------------------------------------------------------------------------------------------------------------

/** Key.INVALID: "Open/Atonal" in the New Score dialog */
export const KEY_ATONAL: number = Key.INVALID

export type NewScoreTempoDuration = 'whole' | 'half' | 'quarter' | 'eighth' | '16th'

export interface NewScoreOptions {
    title?: string
    subtitle?: string
    composer?: string
    lyricist?: string
    copyright?: string
    /** instrument template ids in score order (from instrumentGroupList()); ignored when templateMscx is given */
    instruments: { id: string; soloist?: boolean }[]
    /**
     * score order id from scoreOrders(), or 'custom' (C++ customOrder()); like InstrumentsRepository::order() an
     * unknown id (incl. 'custom' and undefined) gives an empty order, which sets no brackets
     */
    order?: string
    /** the user moved instruments out of the order (C++ ScoreOrder::customized) */
    orderCustomized?: boolean
    /** a template file's contents (.mscx text from MuseScore/share/templates) instead of instruments */
    templateMscx?: string
    /** the score_style.mss of the template's directory (MuseScore reads it with the template, it holds the style) */
    templateStyle?: string
    /** Key -7..7 (C♭ major .. C♯ major), KEY_ATONAL for open/atonal */
    key: number
    timesig: { numerator: number; denominator: number }
    timesigType: 'normal' | 'common' | 'cut'
    /** number of measures (without the pickup measure) */
    measures: number
    /** pickup measure (anacrusis) length; null/undefined = no pickup measure */
    pickup?: { numerator: number; denominator: number } | null
    /** tempo marking; null/undefined = none */
    tempo?: { bpm: number; duration: NewScoreTempoDuration; dot: boolean } | null
}

/** the dialog's default tempo and pickup (used when the user enables them) */
export const DEFAULT_NEW_SCORE_TEMPO: Readonly<{ bpm: number; duration: NewScoreTempoDuration; dot: boolean }> =
    Object.freeze({ bpm: 120, duration: 'quarter', dot: false })
export const DEFAULT_NEW_SCORE_PICKUP: Readonly<{ numerator: number; denominator: number }> = Object.freeze({ numerator: 1, denominator: 4 })

/** the defaults of the New Score dialog (AdditionalInfoModel::init): C major, 4/4, 32 measures, no tempo, no pickup */
export function defaultNewScoreOptions(): NewScoreOptions {
    return {
        instruments: [],
        key: Key.C,
        timesig: { numerator: 4, denominator: 4 },
        timesigType: 'normal',
        measures: 32,
        pickup: null,
        tempo: null,
    }
}

const TEMPO_DURATIONS: Record<NewScoreTempoDuration, DurationType> = {
    whole: DurationType.V_WHOLE, half: DurationType.V_HALF, quarter: DurationType.V_QUARTER, eighth: DurationType.V_EIGHTH,
    '16th': DurationType.V_16TH,
}

/** InstrumentsRepository::order(): a copy of the order with that id, an empty order if there is none */
function repositoryOrder(orderId: string | undefined): ScoreOrder {
    const order = instrumentOrders().find(o => o.id === orderId)
    return order ? order.clone() : new ScoreOrder()
}

/**
 * Creates and lays out a new score like MuseScore's New Score dialog (NewScoreModel::parseOptions,
 * NotationProject::createNew / loadTemplate). Deterministic for the same options.
 */
export function createScore(options: NewScoreOptions): MasterScore {
    const projectOptions = new ProjectCreateOptions()
    projectOptions.title = options.title ?? ''
    projectOptions.subtitle = options.subtitle ?? ''
    projectOptions.composer = options.composer ?? ''
    projectOptions.lyricist = options.lyricist ?? ''
    projectOptions.copyright = options.copyright ?? ''
    if (options.templateMscx !== undefined) {
        const encoder = new TextEncoder()
        projectOptions.template = {
            mscx: encoder.encode(options.templateMscx),
            style: options.templateStyle ? encoder.encode(options.templateStyle) : null,
        }
    }

    const scoreOptions = projectOptions.scoreOptions
    scoreOptions.withTempo = !!options.tempo
    if (options.tempo) {
        scoreOptions.tempo.valueBpm = options.tempo.bpm
        scoreOptions.tempo.duration = TEMPO_DURATIONS[options.tempo.duration] ?? DurationType.V_QUARTER
        scoreOptions.tempo.withDot = options.tempo.dot
    }
    scoreOptions.timesigType = options.timesigType === 'common' ? TimeSigType.FOUR_FOUR
        : options.timesigType === 'cut' ? TimeSigType.ALLA_BREVE : TimeSigType.NORMAL
    scoreOptions.globalTimesig = new Fraction(options.timesig.numerator, options.timesig.denominator)
    scoreOptions.key = options.key as Key
    scoreOptions.totalMeasures = options.measures
    scoreOptions.withPickupMeasure = !!options.pickup
    if (options.pickup) {
        scoreOptions.pickupTimesig = new Fraction(options.pickup.numerator, options.pickup.denominator)
    }

    if (!projectOptions.template) {
        for (const instr of options.instruments) {
            const t = searchTemplate(instr.id)
            if (!t) {
                throw new Error(`unknown instrument template: ${instr.id}`)
            }
            scoreOptions.parts.push({ partId: '', instrumentTemplate: t, isExistingPart: false, isSoloist: !!instr.soloist })
        }
    }

    scoreOptions.order = repositoryOrder(options.order)
    scoreOptions.order.customized = !!options.orderCustomized

    const score = new NotationProject().createNew(projectOptions)
    s_compatDone.add(score) // laid out like MuseScore does for a new score (once, no compatibility conversions)
    score.setIsOpen(true) // GlobalContext::setCurrentNotation: the score is open (saved as <open>)
    return score
}

export interface InstrumentTemplateInfo {
    id: string
    groupId: string
    familyId: string
    trackName: string
    longName: string
    shortName: string
    description: string
    /** genre ids (instrumentGenres()) */
    genres: readonly string[]
    trait: { type: 'tuning' | 'transposition' | 'course' | 'unknown' | ''; name: string; isDefault: boolean; isHiddenOnScore: boolean }
    staffCount: number
    /** C++ InstrumentTemplate::sequenceOrder (the index in its instruments.xml group, used by instrumentSortingIndex()) */
    sequenceOrder: number
}

function traitTypeName(t: TraitType): 'tuning' | 'transposition' | 'course' | 'unknown' {
    return t === TraitType.Tuning ? 'tuning' : t === TraitType.Transposition ? 'transposition' : t === TraitType.Course ? 'course' : 'unknown'
}

let s_groupList: { id: string; name: string; templates: readonly InstrumentTemplateInfo[] }[] | null = null

/** genres of instruments.xml (id + English name) */
export function instrumentGenres(): readonly { id: string; name: string }[] {
    return engravingInstrumentGenres().map(g => ({ id: g.id, name: g.name }))
}

/**
 * The instrument groups with their templates in the order of instruments.xml (like InstrumentsRepository: only
 * templates with a track name and a long name).
 */
export function instrumentGroupList(): readonly { id: string; name: string; templates: readonly InstrumentTemplateInfo[] }[] {
    s_groupList ??= instrumentGroups().map(g => ({
        id: g.id,
        name: g.name,
        templates: g.instrumentTemplates.filter(t => t.trackName && t.longNames.length).map(t => ({
            id: t.id,
            groupId: t.groupId,
            familyId: t.familyId(),
            trackName: t.trackName,
            longName: t.longNames[0]?.name() ?? '',
            shortName: t.shortNames[0]?.name() ?? '',
            description: t.description,
            genres: t.genres.map(ig => ig.id),
            trait: {
                type: t.trait.name || t.trait.type !== TraitType.Unknown ? traitTypeName(t.trait.type) : '',
                name: t.trait.name,
                isDefault: t.trait.isDefault,
                isHiddenOnScore: t.trait.isHiddenOnScore,
            },
            staffCount: t.staffCount,
            sequenceOrder: t.sequenceOrder,
        })),
    }))
    return s_groupList
}

/** the score orders of orders.xml (id + English name); 'custom' is not in the list (C++ customOrder()) */
export function scoreOrders(): readonly { id: string; name: string }[] {
    return instrumentOrders().map(o => ({ id: o.id, name: o.name }))
}

/** ScoreOrder::instrumentSortingIndex of that order (0 for 'custom' and unknown orders: the order is kept) */
export function instrumentSortingIndex(orderId: string, instrumentId: string, isSoloist: boolean): number {
    const order = instrumentOrders().find(o => o.id === orderId)
    return order ? order.instrumentSortingIndex(instrumentId, isSoloist) : 0
}

/** ScoreOrder::isScoreOrder: true if the sorting indices are in ascending order (always true for 'custom') */
export function isScoreOrder(orderId: string, indices: readonly number[]): boolean {
    if (orderId === 'custom') {
        return true
    }
    return repositoryOrder(orderId).isScoreOrder(indices)
}

// ---------------------------------------------------------------------------------------------------------------------
//   selection (MuseScore's notation view: NotationInteraction, NotationViewInputController, NotationAccessibility)
// ---------------------------------------------------------------------------------------------------------------------

/** click, ctrl/cmd+click, shift+click */
export type SelectMode = 'single' | 'add' | 'range'

interface NotationState {
    interaction: NotationInteraction
    controller: NotationViewInputController
    actions: NotationActionController
    accessibility: NotationAccessibility
    style: NotationStyle
}

const s_notationStates = new WeakMap<Score, NotationState>()

function notationState(score: Score): NotationState {
    let st = s_notationStates.get(score)
    if (!st) {
        const interaction = new NotationInteraction(score)
        st = {
            interaction,
            controller: new NotationViewInputController(interaction),
            actions: new NotationActionController(interaction),
            accessibility: new NotationAccessibility(score),
            style: new NotationStyle(() => score, interaction.undoStack()),
        }
        s_notationStates.set(score, st)
    }
    return st
}

/** a point of a page (inches from the page's top left) in canvas coordinates; null if there is no such page */
function pagePointToCanvas(score: Score, pageIdx: number, x: number, y: number): PointF | null {
    const page = score.pages()[pageIdx]
    if (!page) {
        return null
    }
    return page.pos().plus(new PointF(x * DPI, y * DPI))
}

/** C++ NotationViewInputController::hitWidth(): selectionProximity (2) * 0.5 view pixels */
function hitWidth(viewDpi: number): number {
    return 2 * 0.5 / (viewDpi / DPI)
}

export interface HitTestOptions {
    /** pixels per inch of the view (the dpi the page is shown at, without devicePixelRatio; default 100): the hit tolerance is one view pixel */
    dpi?: number
}

/**
 * The element a click at a point of a page would hit (inches from the page's top left, like drawPage's coordinates /
 * dpi), null if none. On empty staff space inside a measure this is the measure. type: the element type (MuseScore's
 * xml name, e.g. "Note", "Measure"), name: its translated user name.
 */
export function hitTest(score: Score, pageIdx: number, x: number, y: number, options: HitTestOptions = {}): { type: string; name: string } | null {
    const pos = pagePointToCanvas(score, pageIdx, x, y)
    if (!pos) {
        return null
    }
    const e = notationState(score).interaction.hitElement(pos, hitWidth(options.dpi ?? 100))
    return e ? { type: e.typeName(), name: e.translatedTypeUserName() } : null
}

function selectionSnapshot(score: Score): unknown[] {
    const sel = score.selection()
    return [sel.state(), sel.startSegment(), sel.endSegment(), sel.staffStart(), sel.staffEnd(), ...sel.elements()]
}

function selectionDiffers(a: unknown[], b: unknown[]): boolean {
    return a.length !== b.length || a.some((v, i) => v !== b[i])
}

/**
 * Selects like a click in MuseScore's notation view (a click on empty staff space selects the measure, a click outside
 * of the staves deselects); returns true if the selection changed. No new layout is needed, only a repaint of
 * selectionBounds() before and after.
 */
export function selectAt(score: Score, pageIdx: number, x: number, y: number, mode: SelectMode,
    options: HitTestOptions = {}): boolean {
    const pos = pagePointToCanvas(score, pageIdx, x, y)
    if (!pos) {
        return false
    }
    const before = selectionSnapshot(score)
    notationState(score).controller.leftClick(pos, hitWidth(options.dpi ?? 100), { shift: mode === 'range', ctrl: mode === 'add' })
    return selectionDiffers(before, selectionSnapshot(score))
}

/** deselects all (Escape); returns true if there was a selection */
export function clearSelection(score: Score): boolean {
    return notationState(score).interaction.clearSelection()
}

/** selects the whole score (Ctrl+A) */
export function selectAll(score: Score): void {
    notationState(score).interaction.selectAll()
}

export { TransposeMode, TransposeDirection, AutoOnOff, PreferSharpFlat } from './engraving/types/types'

/**
 * The actions insert-measures, insert-measures-after-selection, insert-measures-at-start-of-score and append-measures
 * with the number of measures (MuseScore asks for it with its SelectMeasuresCountDialog): NotationActionController::
 * addMeasures. Returns false if the target needs a selection and there is none.
 */
export function addMeasures(score: Score, count: number, target: AddBoxesTarget): boolean {
    const actions = notationState(score).actions
    if ((target === AddBoxesTarget.BeforeSelection || target === AddBoxesTarget.AfterSelection) && !hasSelection(score)) {
        return false
    }
    actions.addMeasures(count, target)
    return true
}
export { AddBoxesTarget, BoxType } from './notation/notationtypes'

/** a selected chord symbol of the Realize chord symbols dialog (RealizeHarmonyDialog::setChordList) */
export interface RealizableChordSymbol {
    id: number
    name: string
    /** the intervals from the root (semitones) */
    intervals: string
    /** the root and the note names */
    noteNames: string
}

/** the selected chord symbols that can be realized (MuseScore's RealizeHarmonyDialog lists them) */
export function realizableChordSymbols(score: Score): RealizableChordSymbol[] {
    const res: RealizableChordSymbol[] = []
    for (const e of score.selection().elements()) {
        if (!e.isHarmony()) {
            continue
        }
        const h = e as unknown as Harmony
        if (!h.isRealizable()) {
            continue
        }
        const rootTpc = h.rootTpc()
        let intervals = ''
        let noteNames = tpc2name(rootTpc, NoteSpellingType.STANDARD, NoteCaseType.AUTO)
        for (const [pitch, tpc] of h.getRealizedHarmony().notes()) {
            intervals += String((pitch - tpc2pitch(rootTpc)) % 128 % 12) + ' '
            noteNames += ', ' + tpc2name(tpc, NoteSpellingType.STANDARD, NoteCaseType.AUTO)
        }
        res.push({ id: h.id(), name: h.harmonyName(), intervals, noteNames })
    }
    return res
}

/**
 * RealizeHarmonyDialog::accept: realizes the selected chord symbols into notes (one undo step). Without options the
 * voicing and duration of each chord symbol are used ("Override with custom options" unchecked).
 */
export function realizeChordSymbols(score: Score, options: { literal: boolean; voicing: Voicing; duration: HDuration } | null): boolean {
    const interaction = notationState(score).interaction
    if (score.selection().isNone()) {
        return false
    }
    interaction.realizeSelectedChordSymbols(options ? options.literal : true, options ? options.voicing : Voicing.INVALID,
        options ? options.duration : HDuration.INVALID)
    return true
}
export { Voicing, HDuration } from './engraving/dom/realizedharmony'

/** the action tuplet-dialog ("Other…" of the tuplets) can be used: a note or rest is selected */
export function canAddCustomTuplet(score: Score): boolean {
    return notationState(score).actions.noteOrRestSelected()
}

/** the defaults of MuseScore's TupletDialog: the number and bracket types of the score's style */
export function customTupletDefaults(score: Score): { numberType: TupletNumberType; bracketType: TupletBracketType } {
    return {
        numberType: score.style().styleI(Sid.tupletNumberType) as TupletNumberType,
        bracketType: score.style().styleI(Sid.tupletBracketType) as TupletBracketType,
    }
}

/**
 * The action custom-tuplet (TupletDialog::apply): a tuplet with the ratio actualNotes/normalNotes on the selection
 * (or the note input position); false if it can not be added.
 */
export function addCustomTuplet(score: Score, actualNotes: number, normalNotes: number, numberType: TupletNumberType,
    bracketType: TupletBracketType): boolean {
    const actions = notationState(score).actions
    if (!actions.noteOrRestSelected()) {
        return false
    }
    const options = new TupletOptions()
    options.ratio = new Fraction(actualNotes, normalNotes)
    options.numberType = numberType
    options.bracketType = bracketType
    actions.putTuplet(options)
    return true
}
export { TupletNumberType, TupletBracketType } from './engraving/dom/tuplet'
import type { TransposeOptions } from './notation/notationtypes'
export type { TransposeOptions }

/** what MuseScore's Transpose dialog can offer for the selection (TransposeDialog's constructor) */
export interface TransposeSelectionInfo {
    /** nothing was selected: the whole score was selected for the dialog (deselect it after transposing) */
    allSelected: boolean
    /** a range is selected: transposing to a key and the key signatures is possible */
    rangeSelection: boolean
    /** chord symbols or fretboard diagrams are selected */
    hasChordNames: boolean
}

/**
 * The instrument of an instrument change that is added (a palette cell or Add > Text > Instrument change): MuseScore
 * asks for it with its select instrument dialog while the command runs; here the provider returns the id of the
 * chosen instrument template (asked for before the command), or null to cancel adding the instrument change.
 */
export function setSelectInstrumentProvider(provider: (() => string | null) | null): void {
    setInteractionSelectInstrumentProvider(provider ? () => {
        const id = provider()
        return id ? searchTemplate(id) : null
    } : null)
}

/** prepares the selection for the Transpose dialog: selects the whole score if nothing is selected */
export function prepareTransposeSelection(score: Score): TransposeSelectionInfo {
    const interaction = notationState(score).interaction
    let allSelected = false
    if (score.selection().isNone()) {
        interaction.selectAll()
        allSelected = true
    }
    const rangeSelection = score.selection().isRange()
    const hasChordNames = score.selection().elements().some(item => item.isHarmony() || item.isFretDiagram())
    return { allSelected, rangeSelection, hasChordNames }
}

/**
 * Transposes the selection (MuseScore's Transpose dialog: NotationInteraction::transpose, undoable "Transposition");
 * with allSelected (prepareTransposeSelection) the selection is cleared afterwards. Returns false if a note could not
 * be transposed (out of the pitch range).
 */
export function transposeSelection(score: Score, options: TransposeOptions, allSelected = false): boolean {
    const interaction = notationState(score).interaction
    const ok = interaction.transpose(options)
    if (allSelected) {
        interaction.clearSelection()
    }
    return ok
}

/**
 * Keyboard navigation of the selection like MuseScore's shortcuts without note input: arrows (next/previous chord),
 * Ctrl+arrows (measure), Shift(+Ctrl)+Left/Right and Shift+Up/Down (extend the range), Alt+Up/Down (note in chord /
 * staff), Ctrl+Alt+Up/Down (top/bottom note), Shift(+Ctrl)+Home/End (to the start/end of the system/score),
 * Ctrl+Home/End (first/last element), Escape, Ctrl+A. key like KeyboardEvent.key; returns true if handled.
 */
export function moveSelection(score: Score, key: string, mods: { shift: boolean; ctrl: boolean; alt: boolean }): boolean {
    return notationState(score).controller.keyAction(key, mods)
}

export function hasSelection(score: Score): boolean {
    return !score.selection().isNone()
}

/** status bar text of the selection (MuseScore's accessibility info, translated through mtrc), empty if none */
export function selectionInfo(score: Score): string {
    return notationState(score).accessibility.accessibilityInfo()
}

/**
 * The pages and rectangles (inches from the page's top left) of the selection, to repaint them and to scroll the
 * selection into view: the range selection frames (one per system) and the bounding boxes of the selected elements.
 */
export function selectionBounds(score: Score): { page: number; x: number; y: number; width: number; height: number }[] {
    const res: { page: number; x: number; y: number; width: number; height: number }[] = []
    const pages = score.pages()
    const add = (pageIdx: number, r: RectF): void => {
        if (pageIdx >= 0 && r.isValid()) {
            res.push({ page: pageIdx, x: r.x() / DPI, y: r.y() / DPI, width: r.width() / DPI, height: r.height() / DPI })
        }
    }
    const interaction = notationState(score).interaction
    // range frames (canvas coordinates): the page containing the frame's center; with a margin for the frame's pen
    const m = 0.03 * DPI
    for (const r of interaction.rangeBoundingArea()) {
        const page = interaction.point2page(r.center(), true)
        if (page) {
            add(pages.indexOf(page), r.translated(page.pos().times(-1)).adjusted(-m, -m, m, m))
        }
    }
    for (const e of score.selection().elements()) {
        const page = e.findAncestor(ElementType.PAGE) as unknown as EngravingItem | null
        if (page) {
            add(pages.indexOf(page as never), e.pageBoundingRect())
        }
    }
    return res
}

/** The page and rectangle (inches from the page's top left) of the first measure, like the frame of its range selection. */
export function firstMeasureBounds(score: Score): { page: number; x: number; y: number; width: number; height: number } | null {
    const m = score.firstMeasureMM()
    if (!m) {
        return null
    }
    const frame = ScoreRangeUtilities.boundingArea(score, m.firstEnabled(), m.last(), 0, score.nstaves())[0]
    const page = frame ? notationState(score).interaction.point2page(frame.center(), true) : null
    if (!page) {
        return null
    }
    const r = frame.translated(page.pos().times(-1))
    return { page: score.pages().indexOf(page), x: r.x() / DPI, y: r.y() / DPI, width: r.width() / DPI, height: r.height() / DPI }
}

// ---------------------------------------------------------------------------------------------------------------------
//   editing (MuseScore's NotationActionController, NotationInteraction, NotationUndoStack)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Runs one of MuseScore's actions (the codes of its notationuiactions.cpp, e.g. "note-input", "note-c", "pad-note-8",
 * "pitch-up", "action://notation/delete", "action://notation/undo") on the score, like MuseScore's
 * NotationActionController. The score is laid out again when it changed. Returns false if the action is not
 * available or not enabled (isActionEnabled).
 */
export function executeAction(score: Score, code: string): boolean {
    return notationState(score).actions.dispatch(code)
}

/**
 * the event of a MIDI device for the score (C++ notation->midiInput()->onMidiEventReceived): it enters notes, starts
 * the note input or only sounds, depending on the state of the note input
 */
export function midiEventReceived(score: Score, event: MidiEvent): void {
    notationState(score).actions.midiInput().onMidiEventReceived(event)
}

/**
 * enters pitches played together at the note input position (the editor enters the notes detected from the
 * microphone with it); true if the note input changed (a new chord, or the pitches of the input by duration)
 */
export function enterMidiNotes(score: Score, pitches: readonly number[]): boolean {
    const actions = notationState(score).actions
    if (!score.inputState().noteEntryMode() || !pitches.length) {
        return false
    }
    actions.midiInput().onNoteOns(pitches)
    return true
}

/** the action codes executeAction() handles (the same for every score) */
export function notationActionCodes(): readonly string[] {
    return NotationActionController.actionCodes()
}

/** the actions with a checked state (isActionChecked): the buttons of MuseScore's note input toolbar */
export function isCheckableAction(code: string): boolean {
    return NotationActionController.isCheckableAction(code)
}

export function isActionAvailable(score: Score, code: string): boolean {
    return notationState(score).actions.isActionAvailable(code)
}

/** like the enabled state of MuseScore's actions (e.g. delete needs a selection, undo something to undo) */
export function isActionEnabled(score: Score, code: string): boolean {
    return notationState(score).actions.canReceiveAction(code)
}

/** the checked state of the note input toolbar's buttons (MuseScore's NoteInputBarModel): durations, dots, ... */
export function isActionChecked(score: Score, code: string): boolean {
    return notationState(score).actions.isActionChecked(code)
}

export function canUndo(score: Score): boolean {
    return score.undoStack().canUndo()
}

export function canRedo(score: Score): boolean {
    return score.undoStack().canRedo()
}

/** undoes the last command; returns false if there is nothing to undo */
export function undo(score: Score): boolean {
    return executeAction(score, 'action://notation/undo')
}

/** redoes the last undone command; returns false if there is nothing to redo */
export function redo(score: Score): boolean {
    return executeAction(score, 'action://notation/redo')
}

export interface UndoStackInfo {
    canUndo: boolean
    canRedo: boolean
    /** the translated name of the command undo() undoes (like "Enter note"), '' if none */
    undoActionName: string
    redoActionName: string
    /** the current state: the number of done commands */
    index: number
    /** the number of commands (done and undone) */
    size: number
}

export function undoStackInfo(score: Score): UndoStackInfo {
    const stack = notationState(score).interaction.undoStack()
    return {
        canUndo: stack.canUndo(),
        canRedo: stack.canRedo(),
        undoActionName: stack.topMostUndoActionName().translated(),
        redoActionName: stack.topMostRedoActionName().translated(),
        index: stack.currentStateIndex(),
        size: stack.undoRedoActionCount(),
    }
}

/** true if the score was changed since it was opened, created or last saved (markSaved) */
export function isModified(score: Score): boolean {
    return score.dirty()
}

/** marks the current state as saved (undoing or redoing makes the score modified again) */
export function markSaved(score: Score): void {
    score.undoStack().setClean()
}

/**
 * marks the score as modified although nothing was changed since it was loaded (NotationProject::markAsUnsaved: a new
 * score, a score restored from an autosave); undo does not make it unmodified, only markSaved does
 */
export function markUnsaved(score: Score): void {
    score.undoStack().setUnclean()
}

const NOTE_INPUT_METHOD_NAMES: Partial<Record<NoteEntryMethod, string>> = {
    [NoteEntryMethod.BY_NOTE_NAME]: 'by-note-name',
    [NoteEntryMethod.BY_DURATION]: 'by-duration',
    [NoteEntryMethod.REPITCH]: 'repitch',
    [NoteEntryMethod.RHYTHM]: 'rhythm',
    [NoteEntryMethod.REALTIME_AUTO]: 'realtime-auto',
    [NoteEntryMethod.REALTIME_MANUAL]: 'realtime-manual',
    [NoteEntryMethod.TIMEWISE]: 'timewise',
}

export interface NoteInputStateInfo {
    /** note input mode is on */
    active: boolean
    /** like the action codes "note-input-<method>": 'by-note-name', 'by-duration', ... */
    method: string
    /** MuseScore's xml duration name ("quarter", "eighth", "measure", ...), '' if none */
    duration: string
    dots: number
    rest: boolean
    /** the SMuFL name of the accidental to add (e.g. "accidentalSharp"), '' if none */
    accidental: string
    /** 0..3 */
    voice: number
    /** the staff of the input position, -1 if none */
    staff: number
}

/** the state of the note input (also outside of note input mode: the duration etc. of the selection) */
export function noteInputState(score: Score): NoteInputStateInfo {
    const is = score.inputState()
    const d = is.duration()
    return {
        active: is.noteEntryMode(),
        method: NOTE_INPUT_METHOD_NAMES[is.noteEntryMethod()] ?? '',
        duration: d.isValid() ? TConv.toXmlDurationType(d.type()) : '',
        dots: d.isValid() ? d.dots() : 0,
        rest: is.rest(),
        accidental: is.accidentalType() ? Accidental.subtype2name(is.accidentalType()) : '',
        voice: is.voice(),
        staff: is.isValid() ? is.staffIdx() : -1,
    }
}

/** the note input cursor (inches from the page's top left) for repainting and scrolling it into view; null if none */
export function noteInputCursorBounds(score: Score): { page: number; x: number; y: number; width: number; height: number } | null {
    const pageIdx = noteInputCursorPage(score)
    if (pageIdx < 0) {
        return null
    }
    const r = notationState(score).interaction.noteInput().cursorRect().translated(score.pages()[pageIdx].pos().times(-1))
    if (!r.isValid()) {
        return null
    }
    return { page: pageIdx, x: r.x() / DPI, y: r.y() / DPI, width: r.width() / DPI, height: r.height() / DPI }
}

/**
 * A property value as plain JSON (like MuseScore's inspector shows it: AbstractInspectorModel::valueFromElementUnits):
 * numbers (enums as their C++ numeric values, millimetre and spatium values in staff spaces, tempo in BPM), booleans,
 * strings, points {x, y} (staff spaces for spatium dependent elements, else millimetres), sizes {width, height},
 * colors "#rrggbb" or "#rrggbbaa", fractions "n/d", alignment {horizontal, vertical}, durations {type, dots}, arrays
 * of numbers; null for other value types.
 */
export type PropertyJsonValue = number | boolean | string | number[] | { [key: string]: number } | null

function spatiumDependent(pid: Pid, item: EngravingItem): boolean {
    return pid === Pid.OFFSET ? item.offsetIsSpatiumDependent() : item.sizeIsSpatiumDependent()
}

function colorToJson(c: Color): string {
    const h = (n: number): string => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')
    return `#${h(c.r)}${h(c.g)}${h(c.b)}${c.a === 255 ? '' : h(c.a)}`
}

/** C++ AbstractInspectorModel::valueFromElementUnits; undefined if the item does not have the property */
function valueToJson(pid: Pid, value: PropertyValue, item: EngravingItem): PropertyJsonValue | undefined {
    if (value === undefined) {
        return undefined
    }
    if (pid === Pid.VERSE) {
        return (value as number) + 1
    }
    switch (propertyType(pid)) {
    case P_TYPE.POINT: {
        const p = value as PointF
        const f = spatiumDependent(pid, item) ? item.spatium() : DPMM
        return { x: p.x() / f, y: p.y() / f }
    }
    case P_TYPE.MILLIMETRE:
        return Spatium.fromMM(value as number, item.spatium()).val()
    case P_TYPE.SPATIUM:
        return value instanceof Spatium ? value.val() : value as number
    case P_TYPE.TEMPO:
        return (value as number) * 60
    case P_TYPE.COLOR:
        return value instanceof Color ? colorToJson(value) : null
    default:
        break
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
        return value
    }
    if (value instanceof Fraction) {
        return `${value.numerator()}/${value.denominator()}`
    }
    if (value instanceof Align) {
        return { horizontal: value.horizontal, vertical: value.vertical }
    }
    if (value instanceof SizeF) {
        return { width: value.width(), height: value.height() }
    }
    if (value instanceof PointF) {
        return { x: value.x(), y: value.y() }
    }
    if (value instanceof DurationTypeWithDots) {
        return { type: value.type, dots: value.dots }
    }
    if (value instanceof Spatium) {
        return value.val()
    }
    if (Array.isArray(value) && value.every(v => typeof v === 'number')) {
        return [...value as number[]]
    }
    return null
}

/** C++ AbstractInspectorModel::valueToElementUnits; undefined if the value cannot be converted */
function valueFromJson(pid: Pid, v: PropertyJsonValue, item: EngravingItem): PropertyValue | undefined {
    if (pid === Pid.VERSE) {
        return (v as number) - 1
    }
    const obj = (v && typeof v === 'object' && !Array.isArray(v)) ? v as { [key: string]: number } : null
    switch (propertyType(pid)) {
    case P_TYPE.POINT: {
        if (!obj) {
            return undefined
        }
        const f = spatiumDependent(pid, item) ? item.spatium() : DPMM
        return new PointF(obj.x * f, obj.y * f)
    }
    case P_TYPE.MILLIMETRE:
        return typeof v === 'number' ? new Spatium(v).toAbsolute(item.spatium()) : undefined
    case P_TYPE.SPATIUM:
        return typeof v === 'number' ? new Spatium(v) : undefined
    case P_TYPE.TEMPO:
        return typeof v === 'number' ? v / 60 : undefined
    case P_TYPE.COLOR: {
        if (typeof v !== 'string' || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v)) {
            return undefined
        }
        const n = (i: number): number => parseInt(v.slice(i, i + 2), 16)
        return new Color(n(1), n(3), n(5), v.length === 9 ? n(7) : 255)
    }
    case P_TYPE.FRACTION: {
        const m = typeof v === 'string' ? /^(-?\d+)\/(\d+)$/.exec(v) : null
        return m ? new Fraction(Number(m[1]), Number(m[2])) : undefined
    }
    case P_TYPE.ALIGN:
        return obj ? new Align(obj.horizontal, obj.vertical) : undefined
    case P_TYPE.SIZE:
        return obj ? new SizeF(obj.width, obj.height) : undefined
    case P_TYPE.DURATION_TYPE_WITH_DOTS:
        return obj ? new DurationTypeWithDots(obj.type, obj.dots) : undefined
    default:
        break
    }
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' || Array.isArray(v)) {
        return v
    }
    return undefined
}

export interface SelectionPropertyInfo {
    /** MuseScore's property name (the xml tag, e.g. "visible", "offset", "color") */
    name: string
    /** MuseScore's user name of the property (untranslated) */
    userName: string
    /** the value of the first selected item that has the property */
    value: PropertyJsonValue
    /** its default (style) value */
    defaultValue: PropertyJsonValue
    /** 'styled': the value comes from the style, 'unstyled': a styled property set by the user, 'nostyle': no style */
    styled: 'nostyle' | 'unstyled' | 'styled'
    /** the selected items have different values */
    mixed: boolean
    /** the number of selected items that have the property */
    count: number
}

function selectionItems(score: Score): EngravingItem[] {
    return [...score.selection().elements()]
}

/**
 * The properties of the selected items for an inspector (like MuseScore's AbstractInspectorModel::loadPropertyItem):
 * all properties the items have, or only the given ones (by name). Keyed by property name.
 */
export function selectionProperties(score: Score, names?: readonly string[]): Record<string, SelectionPropertyInfo> {
    const items = selectionItems(score)
    const res: Record<string, SelectionPropertyInfo> = {}
    if (!items.length) {
        return res
    }
    const pids: Pid[] = names ? names.map(n => propertyId(n)).filter(p => p !== Pid.END)
        : Array.from({ length: Pid.END }, (_, i) => i as Pid).filter(p => propertyName(p))
    for (const pid of pids) {
        let info: SelectionPropertyInfo | null = null
        let firstValue: PropertyValue = undefined
        for (const item of items) {
            const v = item.getProperty(pid)
            const json = valueToJson(pid, v, item)
            if (json === undefined) {
                continue // not a property of this item
            }
            if (!info) {
                const flags = item.propertyFlags(pid)
                info = {
                    name: propertyName(pid),
                    userName: propertyUserName(pid),
                    value: json,
                    defaultValue: valueToJson(pid, item.propertyDefault(pid), item) ?? null,
                    styled: flags === PropertyFlags.STYLED ? 'styled' : flags === PropertyFlags.UNSTYLED ? 'unstyled' : 'nostyle',
                    mixed: false,
                    count: 1,
                }
                firstValue = v
            } else {
                info.count++
                if (!propertyValueEquals(firstValue, v)) {
                    info.mixed = true
                }
            }
        }
        if (info) {
            res[info.name] = info
        }
    }
    return res
}

/**
 * Sets a property (by name, see selectionProperties) of all selected items that have it as one undoable command, like
 * MuseScore's inspector (a styled value becomes unstyled); the value as in selectionProperties. Returns false if no
 * selected item has the property or the value cannot be converted.
 */
export function changeSelectionProperty(score: Score, name: string, value: PropertyJsonValue): boolean {
    const pid = propertyId(name)
    if (pid === Pid.END) {
        return false
    }
    const items = selectionItems(score).filter(e => e.getProperty(pid) !== undefined)
    if (!items.length) {
        return false
    }
    const converted = valueFromJson(pid, value, items[0])
    if (converted === undefined) {
        return false
    }
    notationState(score).interaction.changeProperty(items, pid, converted)
    return true
}

/** resets a property of all selected items that have it to its default (style) value, as one undoable command */
export function resetSelectionProperty(score: Score, name: string): boolean {
    const pid = propertyId(name)
    if (pid === Pid.END) {
        return false
    }
    const items = selectionItems(score).filter(e => e.getProperty(pid) !== undefined)
    if (!items.length) {
        return false
    }
    notationState(score).interaction.resetProperty(items, pid)
    return true
}

/**
 * Applies the changes the Properties panel computed (inspectorPropertyChanges, inspectorPropertyResets,
 * inspectorArrangeChanges) as one undoable command, like AbstractInspectorModel::setPropertyValue /
 * onPropertyValueReset ("Edit %1" / "Reset %1" with the first change's property). Returns false if nothing was applied.
 */
export function applyInspectorChanges(score: Score, changes: readonly InspectorChange[]): boolean {
    if (!changes.length) {
        return false
    }
    const interaction = notationState(score).interaction
    const parens = changes.find(c => c.command === 'addParentheses' || c.command === 'removeParentheses')
    if (parens) {
        // NoteheadSettingsModel: the parentheses of the selected notes (Score::cmdAddParenthesesToNotes etc.)
        const add = parens.command === 'addParentheses'
        interaction.startEdit(new TranslatableString('undoableAction', add ? 'Add notehead parentheses' : 'Remove notehead parentheses'))
        if (add) {
            score.cmdAddParenthesesToNotes()
        } else {
            score.cmdRemoveParenthesesFromNotes()
        }
        interaction.apply()
        return true
    }
    const reset = changes.every(c => c.reset)
    interaction.startEdit(new TranslatableString('undoableAction', reset ? 'Reset %1' : 'Edit %1').arg(propertyUserName(changes[0].pid)))
    for (const c of changes) {
        if (c.command === 'changeVisible') {
            score.undoChangeVisible(c.item, !!c.value)
        } else if (c.reset) {
            c.item.undoResetProperty(c.pid)
        } else {
            c.item.undoChangeProperty(c.pid, c.value, c.flags ?? PropertyFlags.NOSTYLE)
        }
    }
    // NoteheadSettingsModel: resetting the parentheses of notes resets their chord parentheses too
    const parensReset = changes.find(c => c.reset && c.pid === Pid.HAS_PARENTHESES && c.item.isNote())
    if (parensReset) {
        if (parensReset.item.parenthesesMode() === ParenthesesMode.BOTH) {
            score.cmdAddParenthesesToNotes()
        } else {
            score.cmdRemoveParenthesesFromNotes()
        }
    }
    interaction.apply()
    return true
}

// ---------------------------------------------------------------------------------------------------------------------
//   palette elements (MuseScore's palettes: NotationInteraction::applyPaletteElement): filled by the palette drop port
// ---------------------------------------------------------------------------------------------------------------------

/** an element of a palette (created with createPaletteElement or by the caller, e.g. with Factory) */
export type PaletteElement = EngravingItem

/**
 * Description of a palette element; the names are MuseScore's xml names:
 * - Clef: clefType 'G', 'F', 'C3', 'G8vb', ... (TConv ClefType xml names)
 * - KeySig: key -7..7 (concert key)
 * - TimeSig: numerator/denominator, timeSigType 'normal' | 'common' | 'cut' (default 'normal')
 * - BarLine: barLineType 'normal', 'double', 'start-repeat', 'end-repeat', 'end-start-repeat', 'dashed', 'end', ...
 * - Articulation, Ornament, Fermata, Breath, Symbol: symbol = SMuFL SymId name, e.g. 'articAccentAbove',
 *   'ornamentTrill', 'fermataAbove', 'breathMarkComma'
 * - Dynamic: dynamic 'p', 'mf', 'sfz', ...
 * - Accidental: accidental = xml subtype name, e.g. 'accidentalSharp', 'accidentalFlat', 'accidentalNatural'
 * - NoteHead: group = xml notehead group name, e.g. 'cross', 'diamond', 'slash', 'normal'
 * - LayoutBreak: breakType 'line' | 'page' | 'section' | 'noBreak'
 * - Hairpin: hairpinType 'crescendo' | 'decrescendo' | 'crescendo-line' | 'decrescendo-line'
 * - StaffText, SystemText, TempoText, RehearsalMark, Expression: text (plain text)
 */
export type PaletteElementSpec =
    | { type: 'Clef'; clefType: string }
    | { type: 'KeySig'; key: number }
    | { type: 'TimeSig'; numerator: number; denominator: number; timeSigType?: 'normal' | 'common' | 'cut' }
    | { type: 'BarLine'; barLineType: string }
    | { type: 'Articulation' | 'Ornament' | 'Fermata' | 'Breath' | 'Symbol'; symbol: string }
    | { type: 'Dynamic'; dynamic: string }
    | { type: 'Accidental'; accidental: string }
    | { type: 'NoteHead'; group: string }
    | { type: 'LayoutBreak'; breakType: 'line' | 'page' | 'section' | 'noBreak' }
    | { type: 'Hairpin'; hairpinType: 'crescendo' | 'decrescendo' | 'crescendo-line' | 'decrescendo-line' }
    | { type: 'StaffText' | 'SystemText' | 'TempoText' | 'RehearsalMark' | 'Expression'; text: string }

const PALETTE_HAIRPIN_TYPES = { crescendo: 0, decrescendo: 1, 'crescendo-line': 2, 'decrescendo-line': 3 } as const // HairpinType
const PALETTE_BREAK_TYPES = { page: 0, line: 1, section: 2, noBreak: 3 } as const // LayoutBreakType

/**
 * Creates a palette element (like the cells of MuseScore's palettes) for the given score (it uses the score's style).
 * Returns null for unknown names. The element is not added to the score: applyPaletteElement() adds copies of it.
 */
export function createPaletteElement(score: Score, spec: PaletteElementSpec): PaletteElement | null {
    const e = Factory.createItemByName(spec.type === 'Hairpin' ? 'HairPin' : spec.type, scoreDummy(score)) // xml names
    if (!e) {
        return null
    }
    const item = e as unknown as Record<string, (...args: unknown[]) => unknown>
    switch (spec.type) {
    case 'Clef': {
        const ct = TConv.fromXmlClefType(spec.clefType, ClefType.INVALID)
        if (ct === ClefType.INVALID) {
            return null
        }
        item.setClefType(ct)
        break
    }
    case 'KeySig':
        item.setKey(spec.key)
        break
    case 'TimeSig': {
        const t = spec.timeSigType === 'common' ? TimeSigType.FOUR_FOUR : spec.timeSigType === 'cut' ? TimeSigType.ALLA_BREVE : TimeSigType.NORMAL
        item.setSig(new Fraction(spec.numerator, spec.denominator), t)
        break
    }
    case 'BarLine':
        item.setBarLineType(TConv.fromXmlBarLineType(spec.barLineType, BarLineType.NORMAL))
        break
    case 'Articulation':
    case 'Ornament':
    case 'Fermata':
    case 'Breath':
    case 'Symbol': {
        const id = SymNames.symIdByName(spec.symbol)
        if (id === SymId.noSym) {
            return null
        }
        if (spec.type === 'Symbol') {
            item.setSym(id)
        } else {
            item.setSymId(id)
        }
        break
    }
    case 'Dynamic': {
        const t = TConv.fromXmlDynamicType(spec.dynamic, DynamicType.OTHER)
        item.setDynamicType(t)
        item.setXmlText(Dynamic.dynamicText(t))
        break
    }
    case 'Accidental':
        item.setAccidentalType(Accidental.name2subtype(spec.accidental))
        break
    case 'NoteHead': {
        const group = TConv.fromXmlNoteHeadGroup(spec.group, NoteHeadGroup.HEAD_NORMAL)
        item.setSym(Note.noteHeadSym(0, group, NoteHeadType.HEAD_HALF))
        break
    }
    case 'LayoutBreak':
        item.setLayoutBreakType(PALETTE_BREAK_TYPES[spec.breakType])
        break
    case 'Hairpin':
        item.setHairpinType(PALETTE_HAIRPIN_TYPES[spec.hairpinType])
        break
    default:
        item.setPlainText(spec.text)
        break
    }
    e.setTrack(nidx) // from the palette
    e.styleChanged()
    return e
}

/** the translated name of a palette element (for tooltips), e.g. "Treble clef", "Staccato" */
export function paletteElementName(element: PaletteElement): string {
    return element.translatedSubtypeUserName() || element.translatedTypeUserName()
}

/**
 * Applies a palette element to the selection like a click on a palette cell in MuseScore
 * (NotationInteraction::applyPaletteElement): copies are dropped on the selected elements or the measures of a range
 * selection. Undoable; the score is laid out again. modifiers: ctrl applies key/time signatures to the selected staff
 * only, shift adds a note to a chord. Returns false if nothing is selected.
 */
export function applyPaletteElement(score: Score, element: PaletteElement,
    modifiers: { ctrl?: boolean; shift?: boolean } = {}): boolean {
    let m = 0
    if (modifiers.ctrl) {
        m |= KeyboardModifier.ControlModifier
    }
    if (modifiers.shift) {
        m |= KeyboardModifier.ShiftModifier
    }
    return notationState(score).interaction.applyPaletteElement(element, m)
}

// ---------------------------------------------------------------------------------------------------------------------
//   parts and staves (MuseScore's Layout panel and instruments dialog: MasterNotationParts / NotationParts)
// ---------------------------------------------------------------------------------------------------------------------

const s_notationParts = new WeakMap<Score, NotationParts>()

/** INotation::parts(): MasterNotationParts of the master score, NotationParts of a part (excerpt) score */
function notationParts(score: Score): NotationParts {
    let p = s_notationParts.get(score)
    if (!p) {
        p = score.isMaster()
            ? new MasterNotationParts(score as MasterScore, notationState(score).interaction)
            : new NotationParts(score, notationState(score).interaction)
        s_notationParts.set(score, p)
    }
    return p
}

/** runs a NotationParts command; true if it recorded an undoable change */
function runPartsCommand(score: Score, cmd: (parts: NotationParts) => void): boolean {
    const stack = score.undoStack()
    const index = stack.currentIndex()
    const size = stack.size()
    cmd(notationParts(score))
    return stack.currentIndex() !== index || stack.size() !== size
}

/**
 * "Replace instrument" of the Layout panel (PartTreeItem::replaceInstrument): the part gets the instrument of the
 * template (and its staff type), transposing the notes, key signatures and chord symbols for a new transposition.
 */
export function replacePartInstrument(score: Score, partId: string, templateId: string): boolean {
    const part = score.parts().find(p => p.id() === partId)
    const templ = searchTemplate(templateId)
    if (!part || !templ) {
        return false
    }
    const instrument = Instrument.fromTemplate(templ)
    const staffType = templ.staffTypePreset ?? StaffType.getDefaultPreset(templ.staffGroup)
    return runPartsCommand(score, p => p.replaceInstrument(
        { partId, instrumentId: part.instrument().id(), tick: Part.MAIN_INSTRUMENT_TICK }, instrument, staffType))
}

/** the selected instrument change (the element of the action "change-instrument"), null if none */
export function selectedInstrumentChange(score: Score): { partId: string; instrumentId: string; tick: number } | null {
    const element = score.selection().element()
    if (!element || !element.isInstrumentChange()) {
        return null
    }
    const ic = element as unknown as InstrumentChange
    return { partId: ic.part()!.id(), instrumentId: ic.instrument().id(), tick: ic.tick().ticks() }
}

/** "Select instrument…" of an instrument change (InstrumentsActionsController::changeInstrument) */
export function changeInstrumentChange(score: Score, templateId: string): boolean {
    const key = selectedInstrumentChange(score)
    const templ = searchTemplate(templateId)
    if (!key || !templ) {
        return false
    }
    return runPartsCommand(score, p => p.replaceInstrument(
        { partId: key.partId, instrumentId: key.instrumentId, tick: Fraction.fromTicks(key.tick) }, Instrument.fromTemplate(templ)))
}

/** "Prefer sharps/flats" of a part (INotationParts::setPartSharpFlat): 0 none, 1 sharps, 2 flats, 3 auto */
export function setPartSharpFlat(score: Score, partId: string, sharpFlat: PreferSharpFlat): boolean {
    return runPartsCommand(score, p => p.setPartSharpFlat(partId, sharpFlat))
}

/**
 * The Staff/Part properties dialog (MuseScore's EditStaff) for the staff of the selection (or of the hit element
 * context); null if there is no staff. The dialog edits its values and calls apply().
 */
export function createEditStaff(score: Score): EditStaff | null {
    const editStaff = new EditStaff(notationState(score).interaction, notationParts(score))
    return editStaff.isValid() ? editStaff : null
}
/**
 * "Select > More…" (NotationActionController::openSelectionMoreOptions, action "select-dialog"): MuseScore's Select
 * notes dialog for a note, else its Select dialog, for the context item (the selected element or the right-clicked
 * one); null without a context item. The dialog edits values and calls apply() on OK.
 */
export function createSelectDialog(score: Score): SelectDialog | SelectNoteDialog | null {
    const interaction = notationState(score).interaction
    const item = interaction.contextItem()
    if (!item) {
        return null
    }
    return item.isNote() ? new SelectNoteDialog(interaction) : new SelectDialog(interaction)
}
export {
    SelectDialog, SelectNoteDialog, type SelectDialogAction, type SelectDialogValues, type SelectNoteDialogValues,
} from './notationscene/selectdialog'
export { EditStaff, type EditStaffValues, type EditStaffString } from './notationscene/editstaff'

/**
 * "Find / Go to" (SearchPopupModel::search, action "find"): selects what the text names (a measure "12", a measure range
 * "3-7", a page "p2", a rehearsal mark "rA" or its name); the selection is cleared first. Returns the found elements'
 * count; the app shows the selection (C++ showItem).
 */
export function searchNotation(score: Score, text: string): number {
    const interaction = notationState(score).interaction
    interaction.clearSelection()

    const elements = new NotationElements(score).search(text)
    if (elements.length) {
        const inputState = score.inputState()
        interaction.select(elements, elements.length === 1 ? SelectType.SINGLE : SelectType.RANGE,
            inputState.isValid() ? inputState.staffIdx() : 0)
        interaction.showItem(elements[0])
    }
    return elements.length
}

/** the model of the Project properties dialog (File > Project properties…); filePath: the file the app shows */
export function createProjectPropertiesModel(score: MasterScore, filePath = ''): ProjectPropertiesModel {
    return new ProjectPropertiesModel(score, notationState(score).interaction.undoStack(), filePath)
}
export { ProjectPropertiesModel, type ProjectProperty, type ProjectMeta } from './project/projectpropertiesmodel'

// =====================================================================================================================
//   parts (excerpts): the MasterNotation's excerpt notations, the current notation (C++ GlobalContext), the Parts
//   dialog (PartListModel) and the notation tabs (NotationSwitchListModel)
// =====================================================================================================================

const s_masterNotations = new WeakMap<MasterScore, MasterNotation>()
const s_currentNotations = new WeakMap<MasterScore, Score>()
const s_currentNotationListeners = new Set<(master: MasterScore) => void>()

/** the MasterNotation of the score (of its master score), with its excerpt notations (initExcerptNotations) */
export function masterNotation(score: Score): MasterNotation {
    const master = score.masterScore()
    let mn = s_masterNotations.get(master)
    if (!mn) {
        mn = new MasterNotation(master, s => notationState(s).interaction.undoStack())
        s_masterNotations.set(master, mn)
        mn.initExcerptNotations(master.excerpts())
    }
    return mn
}

/** the score of the current notation of a project: its master score or an open part (C++ currentNotation) */
export function currentNotation(score: Score): Score {
    const master = score.masterScore()
    return s_currentNotations.get(master) ?? master
}

/**
 * C++ GlobalContext::setCurrentNotation: shows the master score or a part; a part is laid out first if needed. The
 * listeners of onCurrentNotationChanged are called.
 */
export function setCurrentNotation(score: Score): void {
    const master = score.masterScore()
    if (currentNotation(master) === score) {
        return
    }
    if (!score.isMaster()) {
        ensureLaidOut(score)
    }
    s_currentNotations.set(master, score)
    for (const l of [...s_currentNotationListeners]) {
        l(master)
    }
}

export function onCurrentNotationChanged(listener: (master: MasterScore) => void): () => void {
    s_currentNotationListeners.add(listener)
    return () => s_currentNotationListeners.delete(listener)
}

/** the NotationContext of a project (for the Parts dialog and the tabs) */
export function notationContext(score: Score): NotationContext {
    const master = score.masterScore()
    return {
        masterNotation: () => masterNotation(master),
        currentNotation: () => currentNotation(master),
        setCurrentNotation: (s: Score) => setCurrentNotation(s),
    }
}

/** the model of the Parts dialog (File > Parts…); call load() */
export function createPartListModel(score: Score): PartListModel {
    return new PartListModel(notationContext(score))
}

/** the model of the notation tabs (the score and its open parts); call load() */
export function createNotationSwitchListModel(score: Score): NotationSwitchListModel {
    return new NotationSwitchListModel(notationContext(score))
}

/** the part (excerpt) name of a part score; null for a master score */
export function partScoreName(score: Score): string | null {
    return score.isMaster() ? null : score.excerpt()?.name() ?? null
}

export {
    PartListModel, NotationSwitchListModel, type NotationContext, type PartListItem, type NotationSwitchItem,
    type NotationSwitchMenuItem, type SelectionModifiers,
} from './notationscene/partlistmodel'
export { MasterNotation } from './notation/internal/masternotation'
export { ExcerptNotation } from './notation/internal/excerptnotation'

/** the style of the score (MuseScore's INotationStyle) for the Style and Page Settings dialogs and load/save style */
export function notationStyle(score: Score): NotationStyle {
    return notationState(score).style
}

/**
 * The undo stack of the notation (INotation::undoStack): the Style and Page Settings dialogs collect their changes
 * in one command (prepareChanges when shown, commitChanges on OK, rollbackChanges on Cancel).
 */
export function notationUndoStack(score: Score): NotationUndoStack {
    return notationState(score).interaction.undoStack()
}

/**
 * The Style dialog (MuseScore's EditStyle, action "edit-style") for the score: the states of the widgets of
 * editstyle.ui (PAGE_LIST, PAGE_STACK) that the app renders; show() when shown, accept() on OK, reject() on Cancel.
 */
export function createEditStyle(score: Score): EditStyle {
    return new EditStyle(score, notationStyle(score), notationUndoStack(score))
}
export {
    EditStyle, WidgetState, ALL_PAGE_CODES, ALL_TEXT_STYLE_SUBPAGE_CODES, STYLE_WIDGETS, BUTTON_GROUPS, uiText, type ComboItem,
    type StyleWidget,
} from './notationscene/editstyle'
export { Align, AlignH, AlignV, FontStyle } from './engraving/types/types'
export { Color } from './framework/draw/types/color'
export { PointF } from './framework/draw/types/geometry'
export { PAGE_LIST, PAGE_STACK, type UiString, type UiWidget, type UiLayout, type UiLayoutItem, type UiProps } from './notationscene/editstyleui'

/**
 * BreaksDialog::showEvent (the "Measures per system" dialog, action "measures-per-system"): selects the whole score
 * if there is no range selection; returns whether it did (pass it to addRemoveSystemLocks).
 */
export function prepareBreaksDialog(score: Score): { allSelected: boolean } {
    const interaction = notationState(score).interaction
    if (!score.selection().isRange()) {
        interaction.selectAll()
        return { allSelected: true }
    }
    return { allSelected: false }
}

/** BreaksDialog::accept: INotationInteraction::addRemoveSystemLocks; the selection of prepareBreaksDialog is cleared */
export function addRemoveSystemLocks(score: Score, intervalType: AddRemoveSystemLockType, interval: number,
    allSelected = false): void {
    const interaction = notationState(score).interaction
    interaction.addRemoveSystemLocks(intervalType, interval)
    if (allSelected) {
        interaction.clearSelection()
    }
}

/** the Page Settings dialog (MuseScore's PageSettings) of the score; the dialog calls show() first */
export function createPageSettings(score: Score, metricUnit: boolean, setMetricUnit: (mm: boolean) => void): PageSettings {
    return new PageSettings(score, notationState(score).style, notationState(score).interaction.undoStack(), metricUnit, setMetricUnit)
}
export {
    PageSettings, PAGE_SETTINGS_SPIN_BOXES, type PageSettingsSpinBox, type PageSettingsValues, type PageSizeItem,
} from './notationscene/pagesettings'
export { NotationStyle } from './notation/internal/notationstyle'
export type { NotationUndoStack } from './notation/internal/notationundostack'
export { AddRemoveSystemLockType } from './notation/notationtypes'
export { Sid } from './engraving/style/styledef'
export {
    EditStaffType, NOTEHEAD_SCHEMES, type EditStaffTypeValues, type EditStaffTypeEnabled, type TabNoteValues,
} from './notationscene/editstafftype'
export { TablatureMinimStyle, TablatureSymbolRepeat } from './engraving/dom/stafftype'
export { StaffGroup, NoteHeadScheme, TextStyleType } from './engraving/types/types'

/**
 * The items of the score's context menu (MuseScore's NotationContextMenuModel) for the right-clicked element (the hit
 * element context of the last mouse press) or the selection: action codes with optional titles ([context, source]).
 */
export function contextMenuItems(score: Score): ContextMenuItem[] {
    return new NotationContextMenuModel(notationState(score).interaction).loadItems()
}
export type { ContextMenuItem, ContextMenuTitle } from './notationscene/notationcontextmenumodel'

/** shows or hides a part (INotationParts::setPartVisible); ids are Part.id() */
export function setPartVisible(score: Score, partId: string, visible: boolean): boolean {
    return runPartsCommand(score, p => p.setPartVisible(partId, visible))
}

/**
 * inserts a part into a part score (INotationParts::insertPart, the Layout panel of a part score: a hidden instrument
 * of the main score shown); `part` is a clone of the main score's part (Part.clone())
 */
export function insertPart(score: Score, part: Part, index: number): boolean {
    return runPartsCommand(score, p => p.insertPart(part, index))
}

/** "Reset all formatting" of an instrument in a part score (INotationParts::replacePart with a clone of the main score's part) */
export function replacePart(score: Score, partId: string, newPart: Part): boolean {
    return runPartsCommand(score, p => p.replacePart(partId, newPart))
}

/**
 * the Customize kit dialog (action "customize-kit") for the drumset of the instrument of the context menu's element or
 * of the note input; null if there is none. Its changes are applied to the score at once (undoable, "Edit drumset").
 */
export function createCustomizeKitDialog(score: Score): CustomizeKitDialog | null {
    const target = customizeKitTarget(score)
    if (!target) {
        return null
    }
    const { part, tick } = target
    const interaction = notationState(score).interaction
    const contextItem = interaction.contextItem()
    const originPitch = contextItem && contextItem.isNote() ? (contextItem as unknown as Note).pitch() : -1
    const dialog = new CustomizeKitDialog({ replaceDrumset: (key, drumset) => notationParts(score).replaceDrumset(key, drumset) },
        part, tick, originPitch)
    return dialog.isValid() ? dialog : null
}

/** C++ CustomizeKitDialog::initDrumsetAndKey: the part and tick of the hit element context, else of the note input */
function customizeKitTarget(score: Score): { part: Part; tick: Fraction } | null {
    const interaction = notationState(score).interaction
    const context = interaction.hitElementContext()
    const state = interaction.noteInput().state()
    const hitContextValid = !!context.staff && !!context.element
    const noteInputValid = !!state.staff() && !!state.segment()
    if (!hitContextValid && !noteInputValid) {
        return null
    }
    const part = hitContextValid ? context.staff!.part() : state.staff()!.part()
    const tick = hitContextValid ? context.element!.tick() : state.segment()!.tick()
    return { part, tick }
}

/** the Customize kit dialog can be opened (the instrument of the context or the note input has a drumset) */
export function canCustomizeKit(score: Score): boolean {
    const target = customizeKitTarget(score)
    const inst = target?.part.instrument(target.tick)
    return !!inst && inst.useDrumset() && !!inst.drumset()
}

/** draws the example of the Customize kit dialog (its drumNote cell) */
export function drawCustomizeKitExample(dialog: CustomizeKitDialog, ctx: Canvas2D, options: DrawPaletteCellOptions): void {
    const cell = dialog.exampleCell()
    if (cell) {
        drawCellElement(cell, ctx, options)
    }
}

/** the model of the settings popup of a system markings layer of the Layout panel (staff: the layer's staff) */
export function createSystemObjectsLayerSettingsModel(score: Score, staffId: string): SystemObjectsLayerSettingsModel {
    const model = new SystemObjectsLayerSettingsModel({
        score, parts: notationParts(score), undoStack: notationState(score).interaction.undoStack(),
    })
    model.load(staffId)
    return model
}

/** the model of the Layout panel's instrument settings popup (InstrumentSettingsModel) for a part of the score */
export function createInstrumentSettingsModel(score: Score, partId: string): InstrumentSettingsModel {
    const notation = (s: Score): StaffSettingsNotation => ({
        score: s, parts: notationParts(s), undoStack: notationState(s).interaction.undoStack(),
    })
    const model = new InstrumentSettingsModel(notation(score), notation(score.masterScore()))
    model.load(partId, score.parts().find(p => p.id() === partId)?.instrumentId() ?? '')
    return model
}

/**
 * the model of the Layout panel's staff settings popup (StaffSettingsModel) for a staff (Staff.id()) of the score (the
 * master score or a part score); its setters change the score through the undo stack
 */
export function createStaffSettingsModel(score: Score, staffId: string): StaffSettingsModel {
    const notation = (s: Score): StaffSettingsNotation => ({
        score: s, parts: notationParts(s), undoStack: notationState(s).interaction.undoStack(),
    })
    const model = new StaffSettingsModel(notation(score), notation(score.masterScore()))
    model.load(staffId)
    return model
}

/**
 * the name (on the score or part score) of the main instrument of a part (InstrumentSettingsModel::setInstrumentName /
 * setAbbreviature: INotationParts::setInstrumentName / setInstrumentAbbreviature)
 */
export function setInstrumentName(score: Score, partId: string, name: string, abbreviature = false): boolean {
    const part = score.parts().find(p => p.id() === partId)
    if (!part) {
        return false
    }
    const key = { partId, instrumentId: part.instrument().id(), tick: Part.MAIN_INSTRUMENT_TICK }
    return runPartsCommand(score, p => abbreviature ? p.setInstrumentAbbreviature(key, name) : p.setInstrumentName(key, name))
}

/** shows or hides a staff (INotationParts::setStaffVisible); ids are Staff.id() */
export function setStaffVisible(score: Score, staffId: string, visible: boolean): boolean {
    return runPartsCommand(score, p => p.setStaffVisible(staffId, visible))
}

/** removes instruments (INotationParts::removeParts; the part scores of these instruments are deleted too) */
export function removeParts(score: Score, partIds: readonly string[]): boolean {
    return runPartsCommand(score, p => p.removeParts(partIds))
}

/** removes staves (INotationParts::removeStaves) */
export function removeStaves(score: Score, staffIds: readonly string[]): boolean {
    return runPartsCommand(score, p => p.removeStaves(staffIds))
}

/** moves instruments before (or after) the destination instrument (INotationParts::moveParts) */
export function moveParts(score: Score, partIds: readonly string[], destinationPartId: string, after: boolean): boolean {
    return runPartsCommand(score, p => p.moveParts(partIds, destinationPartId, after ? PartsInsertMode.After : PartsInsertMode.Before))
}

/** moves staves of one instrument before (or after) the destination staff (INotationParts::moveStaves) */
export function moveStaves(score: Score, staffIds: readonly string[], destinationStaffId: string, after: boolean): boolean {
    return runPartsCommand(score, p => p.moveStaves(staffIds, destinationStaffId, after ? PartsInsertMode.After : PartsInsertMode.Before))
}

/**
 * appends a staff to an instrument ("Add staff": StaffControlTreeItem::appendNewItem creates a staff with the
 * instrument's clef for the new staff index and calls INotationParts::appendStaff)
 */
export function appendStaff(score: Score, partId: string): boolean {
    const part = score.parts().find(p => p.id() === partId)
    if (!part) {
        return false
    }
    const staff = Factory.createStaff(part)
    staff.setDefaultClefType(part.instrument().clefType(part.nstaves()))
    return runPartsCommand(score, p => p.appendStaff(staff, partId))
}

/** the staves get a copy of the top system markings (INotationParts::addSystemObjects) */
export function addSystemObjects(score: Score, staffIds: readonly string[]): boolean {
    return runPartsCommand(score, p => p.addSystemObjects(staffIds))
}

/** removes the system markings layers of the staves (INotationParts::removeSystemObjects) */
export function removeSystemObjects(score: Score, staffIds: readonly string[]): boolean {
    return runPartsCommand(score, p => p.removeSystemObjects(staffIds))
}

/** moves a system markings layer to another staff (INotationParts::moveSystemObjects) */
export function moveSystemObjects(score: Score, sourceStaffId: string, destinationStaffId: string): boolean {
    return runPartsCommand(score, p => p.moveSystemObjects(sourceStaffId, destinationStaffId))
}

/** INotationParts::moveSystemObjectLayerBelowBottomStaff (below = true) / moveSystemObjectLayerAboveBottomStaff */
export function moveSystemObjectLayerBottomStaff(score: Score, below: boolean): boolean {
    return runPartsCommand(score, p => below ? p.moveSystemObjectLayerBelowBottomStaff() : p.moveSystemObjectLayerAboveBottomStaff())
}

/** sets the instrument order (INotationParts::setScoreOrder; an id of scoreOrders() or 'custom') */
export function setScoreOrder(score: Score, orderId: string): boolean {
    const order = orderId === 'custom' ? customOrder() : instrumentOrders().find(o => o.id === orderId)?.clone()
    if (!order) {
        return false
    }
    return runPartsCommand(score, p => p.setScoreOrder(order))
}

/** an entry of setInstruments(): an existing part (by id) or a new instrument (template id) */
export type ScorePartSpec = { partId: string; soloist?: boolean } | { instrumentId: string; soloist?: boolean }

/**
 * Sets the instruments of the score like MuseScore's instruments dialog (INotationParts::setParts): parts not in the
 * list are removed, new instruments are added, all are sorted in the order of the list. `orderId`: the score order
 * (default: the current one). Returns false for unknown ids or if nothing changed.
 */
export function setInstruments(score: Score, parts: readonly ScorePartSpec[], orderId?: string): boolean {
    const list: PartInstrumentList = []
    for (const spec of parts) {
        if ('partId' in spec) {
            const part = score.parts().find(p => p.id() === spec.partId)
            if (!part) {
                return false
            }
            list.push({ partId: spec.partId, instrumentTemplate: null as never, isExistingPart: true, isSoloist: spec.soloist ?? part.soloist() })
        } else {
            const t = searchTemplate(spec.instrumentId)
            if (!t) {
                return false
            }
            list.push({ partId: '', instrumentTemplate: t, isExistingPart: false, isSoloist: !!spec.soloist })
        }
    }
    let order = score.scoreOrder()
    if (orderId !== undefined) {
        order = orderId === 'custom' ? customOrder() : repositoryOrder(orderId)
    }
    return runPartsCommand(score, p => p.setParts(list, order))
}

/**
 * Adds instruments (template ids) to the score: the existing parts are kept; the new ones are inserted where the
 * score order sorts them (appended for a custom or customized order), like the instruments dialog does.
 */
export function addInstruments(score: Score, instrumentIds: readonly string[]): boolean {
    const order = score.scoreOrder()
    const sorted = order.id !== 'custom' && !order.customized && order.groups.length > 0
    const specs: { spec: ScorePartSpec; index: number }[] = score.parts().map(p => ({
        spec: { partId: p.id() }, index: order.instrumentSortingIndex(p.instrument().id(), p.soloist()),
    }))
    for (const id of instrumentIds) {
        const spec: ScorePartSpec = { instrumentId: id }
        if (sorted) {
            const index = order.instrumentSortingIndex(id, false)
            let pos = specs.findIndex(s => s.index > index)
            if (pos === -1) {
                pos = specs.length
            }
            specs.splice(pos, 0, { spec, index })
        } else {
            specs.push({ spec, index: 0 })
        }
    }
    return setInstruments(score, specs.map(s => s.spec))
}

// ---------------------------------------------------------------------------------------------------------------------
//   copy/paste, text editing, drag and lasso (MuseScore's notation view: NotationViewInputController mouse and key
//   events, NotationInteraction): the clipboard is the library's in-memory clipboard; the UI synchronizes it with the
//   system clipboard (clipboardContents / setClipboardContents)
// ---------------------------------------------------------------------------------------------------------------------

/** the formats ('application/musescore/stafflist', ..., 'text/plain') and data of the clipboard */
export function clipboardContents(): Record<string, string> {
    const m = clipboard().mimeData()
    const res: Record<string, string> = {}
    for (const f of m.formats()) {
        res[f] = m.data(f)
    }
    return res
}

export function setClipboardContents(data: Record<string, string>): void {
    const m = new MimeData()
    for (const [f, d] of Object.entries(data)) {
        m.setData(f, d)
    }
    clipboard().setMimeData(m)
}

/** puts an image file (PNG, JPEG, GIF, BMP, WebP) on the clipboard: pasting adds it as an Image to the selected elements */
export function setClipboardImage(data: Uint8Array): void {
    const m = new MimeData()
    m.setImageData(data)
    clipboard().setMimeData(m)
}

/** the actions whose shortcuts apply while a text is edited and have priority then (MuseScore's CTX_NOTATION_TEXT_EDITING) */
export function isTextEditingAction(code: string): boolean {
    return TEXT_EDITING_ACTIONS.has(code)
}

const TEXT_EDITING_ACTIONS: ReadonlySet<string> = new Set([
    'next-word', 'next-text-element', 'prev-text-element', 'next-lyric-verse', 'prev-lyric-verse', 'next-syllable',
    'add-melisma', 'text-b', 'text-i', 'text-u', 'text-s', 'text-sub', 'text-sup',
])

/** the clipboard formats MuseScore's copy writes (mime types) */
export const CLIPBOARD_FORMATS: readonly string[] = [mimeSymbolFormat, mimeSymbolListFormat, mimeStaffListFormat,
    TextEditData.mimeRichTextFormat]

/** the selection as MuseScore's clipboard data (format and xml text), null without a selection */
export function selectionMimeData(score: Score): { format: string; data: string } | null {
    const sel = score.selection()
    const format = sel.mimeType()
    if (!format || !sel.canCopy()) {
        return null
    }
    return { format, data: sel.mimeData() }
}

/** a pointer event of the view: page and position on it (inches from its top left), as for selectAt */
export interface ViewPointerEvent {
    page: number
    x: number
    y: number
    /** the position in view pixels (the drag threshold) */
    clientX: number
    clientY: number
    /** 0 left, 1 middle, 2 right (DOM MouseEvent.button) */
    button: number
    /** DOM MouseEvent.buttons */
    buttons: number
    shift: boolean
    /** Ctrl (Cmd on macOS) */
    ctrl: boolean
    alt: boolean
    /** pixels per inch of the view (hit tolerance); default 100 */
    dpi?: number
}

function viewMouseEvent(score: Score, e: ViewPointerEvent): ViewMouseEvent | null {
    const pos = pagePointToCanvas(score, e.page, e.x, e.y)
    if (!pos) {
        return null
    }
    const button = e.button === 1 ? MouseButton.MiddleButton : e.button === 2 ? MouseButton.RightButton : MouseButton.LeftButton
    const buttons = ((e.buttons & 1) ? MouseButton.LeftButton : 0) | ((e.buttons & 2) ? MouseButton.RightButton : 0)
        | ((e.buttons & 4) ? MouseButton.MiddleButton : 0)
    const modifiers = (e.shift ? KeyboardModifier.ShiftModifier : 0) | (e.ctrl ? KeyboardModifier.ControlModifier : 0)
        | (e.alt ? KeyboardModifier.AltModifier : 0)
    return { logicPos: pos, physicalPos: { x: e.clientX, y: e.clientY }, button, buttons, shift: e.shift, ctrl: e.ctrl, alt: e.alt, modifiers }
}

/** C++ NotationViewInputController::mousePressEvent (selection, start of drags, grips, text cursor) */
export function viewMousePress(score: Score, e: ViewPointerEvent): void {
    const ev = viewMouseEvent(score, e)
    if (ev) {
        notationState(score).controller.mousePressEvent(ev, hitWidth(e.dpi ?? 100))
    }
}

/**
 * C++ mouseMoveEvent (drag of elements and grips, lasso with Shift on empty space, text selection); returns the
 * logical move of the canvas (inches) when the view should be moved instead
 */
export function viewMouseMove(score: Score, e: ViewPointerEvent): { moveCanvas: { x: number; y: number } | null; outgoingDrag: OutgoingElementDrag | null } {
    const ev = viewMouseEvent(score, e)
    if (!ev) {
        return { moveCanvas: null, outgoingDrag: null }
    }
    const interaction = notationState(score).interaction
    const wasOutgoing = interaction.isOutgoingDragStarted()
    const r = notationState(score).controller.mouseMoveEvent(ev)
    const drag = !wasOutgoing ? interaction.outgoingDrag() : null
    return {
        moveCanvas: r.moveCanvas ? { x: r.moveCanvas.x() / DPI, y: r.moveCanvas.y() / DPI } : null,
        outgoingDrag: drag ? { mimeData: drag.mimeData, type: drag.element.typeName(), name: drag.element.translatedTypeUserName() } : null,
    }
}

/**
 * An element dragged out of the view (Shift+Ctrl+drag: NotationInteraction::startOutgoingDragElement): its mime data
 * (MIME_SYMBOL_FORMAT, e.g. for insertPaletteCell). Returned once by the viewMouseMove that started the drag; the
 * view carries out the drag.
 */
export interface OutgoingElementDrag {
    mimeData: string
    /** MuseScore's element type name */
    type: string
    /** the translated user name of the element type */
    name: string
}

// ---------------------------------------------------------------------------------------------------------------------
//   drop of a palette cell (or another element's mime data) onto the view (NotationViewInputController
//   dragEnterEvent/dragMoveEvent/dragLeaveEvent/dropEvent -> NotationInteraction startDropSingle/updateDropSingle/
//   dropSingle/endDrop). The drop target is highlighted and the anchor line drawn by drawPage (printing: false).
// ---------------------------------------------------------------------------------------------------------------------

/** a position during a drag: page and position on it (inches from its top left), the keyboard modifiers */
export interface ViewDragEvent {
    page: number
    x: number
    y: number
    shift: boolean
    /** Ctrl (Cmd on macOS) */
    ctrl: boolean
    alt: boolean
}

function dragModifiers(e: ViewDragEvent): number {
    return (e.shift ? KeyboardModifier.ShiftModifier : 0) | (e.ctrl ? KeyboardModifier.ControlModifier : 0)
        | (e.alt ? KeyboardModifier.AltModifier : 0)
}

/** dragEnterEvent: starts the drop of an element (mimeData: MIME_SYMBOL_FORMAT data); false if it cannot be read */
export function viewDragEnter(score: Score, mimeData: string): boolean {
    return notationState(score).interaction.startDropSingle(mimeData)
}

/** dragMoveEvent: returns true if the element can be dropped at the position (the target is highlighted) */
export function viewDragMove(score: Score, e: ViewDragEvent): boolean {
    const pos = pagePointToCanvas(score, e.page, e.x, e.y)
    return !!pos && notationState(score).interaction.updateDropSingle(pos, dragModifiers(e))
}

/** dropEvent: drops the element (one undoable command); returns true if it was dropped. The drop ends. */
export function viewDrop(score: Score, e: ViewDragEvent): boolean {
    const pos = pagePointToCanvas(score, e.page, e.x, e.y)
    const interaction = notationState(score).interaction
    const accepted = !!pos && interaction.dropSingle(pos, dragModifiers(e))
    interaction.endDrop()
    return accepted
}

/** the current drop target of a drag over the view (highlighted), null if none */
export function viewDropTarget(score: Score): { type: string; name: string } | null {
    const t = notationState(score).interaction.dropTargetItem()
    return t ? { type: t.typeName(), name: t.translatedTypeUserName() } : null
}

/** dragLeaveEvent: ends the drop without dropping */
export function viewDragLeave(score: Score): void {
    notationState(score).interaction.endDrop()
}

export function viewMouseRelease(score: Score, e: ViewPointerEvent): void {
    const ev = viewMouseEvent(score, e)
    if (ev) {
        notationState(score).controller.mouseReleaseEvent(ev)
    }
}

/** C++ mouseDoubleClickEvent (starts text editing, selects a word or all notes of a chord) */
export function viewMouseDoubleClick(score: Score, e: ViewPointerEvent): void {
    const ev = viewMouseEvent(score, e)
    if (ev) {
        notationState(score).controller.mouseDoubleClickEvent(ev)
    }
}

/** to be called after the double click interval (C++ QTimer): a third click selects the whole text */
export function viewResetTripleClick(score: Score): void {
    notationState(score).controller.resetTripleClick()
}

/** a key press like DOM's KeyboardEvent (key, code); ctrl is Cmd on macOS, meta is Control on macOS */
export interface ViewKeyEvent {
    key: string
    code?: string
    shift: boolean
    ctrl: boolean
    alt: boolean
    meta?: boolean
}

const DOM_KEYS: Record<string, number> = {
    Escape: KeyboardKey.Key_Escape, Tab: KeyboardKey.Key_Tab, Backspace: KeyboardKey.Key_Backspace,
    Enter: KeyboardKey.Key_Return, Insert: KeyboardKey.Key_Insert, Delete: KeyboardKey.Key_Delete,
    Home: KeyboardKey.Key_Home, End: KeyboardKey.Key_End, ArrowLeft: KeyboardKey.Key_Left, ArrowUp: KeyboardKey.Key_Up,
    ArrowRight: KeyboardKey.Key_Right, ArrowDown: KeyboardKey.Key_Down, PageUp: KeyboardKey.Key_PageUp,
    PageDown: KeyboardKey.Key_PageDown, Shift: KeyboardKey.Key_Shift, Control: KeyboardKey.Key_Control,
    Meta: KeyboardKey.Key_Meta, Alt: KeyboardKey.Key_Alt, F2: KeyboardKey.Key_F2,
}

/** the Qt key event (Qt::Key, modifiers, text) of a DOM key event */
function notationKeyEvent(e: ViewKeyEvent): NotationKeyEvent {
    let key = DOM_KEYS[e.key] ?? 0
    let text = ''
    if (!key && e.key.length > 0 && [...e.key].length === 1) {
        text = e.key
        // Qt keys of characters are their upper case code (Key_A = 'A')
        key = e.key.toUpperCase().codePointAt(0)!
        if (e.key === ' ') {
            key = KeyboardKey.Key_Space
        }
    }
    if (e.key === 'Backtab' || (e.key === 'Tab' && e.shift)) {
        key = KeyboardKey.Key_Backtab
    }
    if ((e.ctrl || e.meta) && !e.alt) {
        text = '' // no text with Ctrl (like Qt on macOS)
    }
    const modifiers = (e.shift ? KeyboardModifier.ShiftModifier : 0) | (e.ctrl ? KeyboardModifier.ControlModifier : 0)
        | (e.alt ? KeyboardModifier.AltModifier : 0) | (e.meta ? KeyboardModifier.MetaModifier : 0)
        | (e.code?.startsWith('Numpad') ? KeyboardModifier.KeypadModifier : 0)
    return { key, modifiers, text }
}

/**
 * C++ shortcutOverrideEvent: true if the key goes to the notation view (editing of a text or element, Enter to edit
 * a selected text) instead of being a shortcut; then viewKeyPress handles it
 */
export function viewShortcutOverride(score: Score, e: ViewKeyEvent): boolean {
    return notationState(score).controller.shortcutOverrideEvent(notationKeyEvent(e))
}

/** C++ keyPressEvent (editing of the edited text or element); returns true if the key was handled */
export function viewKeyPress(score: Score, e: ViewKeyEvent): boolean {
    return notationState(score).controller.keyPressEvent(notationKeyEvent(e))
}

/** C++ keyReleaseEvent: releasing Shift hides the time tick anchors shown while it is held */
export function viewKeyRelease(score: Score, e: ViewKeyEvent): void {
    notationState(score).controller.keyReleaseEvent(notationKeyEvent(e))
}

/** C++ inputMethodEvent: text typed into the edited text (commit), or the preedit string of an input method composition */
export function viewInputText(score: Score, commit: string, preedit = ''): void {
    notationState(score).controller.inputMethodEvent(commit, preedit)
}

export interface TextEditingInfo {
    /** a text is edited */
    active: boolean
    /** MuseScore's xml name of the edited element ("StaffText", "Lyrics", ...) */
    type: string
    /** the text cursor (inches from the page's top left) */
    cursor: { page: number; x: number; y: number; width: number; height: number } | null
    /** the plain text */
    text: string
}

/** ends the editing of a text (before saving: ProjectActionsController::saveProjectAt); false if no text was edited */
export function endTextEditing(score: Score): boolean {
    const interaction = notationState(score).interaction
    if (!interaction.isTextEditingStarted()) {
        return false
    }
    interaction.endEditText()
    return true
}

export function textEditingInfo(score: Score): TextEditingInfo {
    const interaction = notationState(score).interaction
    const text = interaction.isTextEditingStarted() ? interaction.editedText() : null
    if (!text) {
        return { active: false, type: '', cursor: null, text: '' }
    }
    let cursor: TextEditingInfo['cursor'] = null
    const page = text.findAncestor(ElementType.PAGE) as unknown as { pos(): PointF } | null
    if (page) {
        const r = text.cursor().cursorRect().translated(text.canvasPos()).translated(page.pos().times(-1))
        cursor = { page: score.pages().indexOf(page as never), x: r.x() / DPI, y: r.y() / DPI, width: r.width() / DPI, height: r.height() / DPI }
    }
    return { active: true, type: text.typeName(), cursor, text: text.plainText() }
}

/** true while elements, a grip or the lasso are dragged */
export function isDragging(score: Score): boolean {
    return notationState(score).interaction.isDragStarted()
}

/** the edit mode overlays: the edited text (cursor, selection, frame), the grips, the lasso */
function drawEditMode(score: Score, page: EngravingItem, painter: Painter, scaling: number): void {
    const interaction = notationState(score).interaction
    const opt = { isPrinting: false }
    const edited = interaction.editData().element
    if (edited && edited.findAncestor(ElementType.PAGE) === page) {
        interaction.drawTextEditMode(painter, scaling, opt)
        interaction.drawGripPoints(painter, scaling, opt)
    }
    interaction.drawLasso(painter, scaling)
    interaction.drawDrop(painter)
    interaction.drawAnchorLines(painter, scaling)
}

//   note input in the view: the shadow note at the mouse position, the right click, changes made by a timer
//   (MuseScore's NotationViewInputController hover/right click, NotationInteraction::showShadowNoteForPosition)
// ---------------------------------------------------------------------------------------------------------------------

import { TDraw } from './engraving/rendering/score/tdraw'
import { StaffSettingsModel, type StaffSettingsNotation } from './instrumentsscene/staffsettingsmodel'
import { InstrumentSettingsModel } from './instrumentsscene/instrumentsettingsmodel'
import { SystemObjectsLayerSettingsModel } from './instrumentsscene/systemobjectslayersettingsmodel'
import { CustomizeKitDialog } from './palette/customizekitdialog'
import { drawCellElement, type DrawPaletteCellOptions } from './palette/api'

/** a rectangle on a page (inches from the page's top left) */
export interface PageRect {
    page: number
    x: number
    y: number
    width: number
    height: number
}

function pageRectOf(score: Score, pageIdx: number, r: RectF): PageRect | null {
    const page = score.pages()[pageIdx]
    if (!page || !r.isValid()) {
        return null
    }
    const pr = r.translated(page.pos().times(-1))
    return { page: pageIdx, x: pr.x() / DPI, y: pr.y() / DPI, width: pr.width() / DPI, height: pr.height() / DPI }
}

/**
 * In note input mode: shows the shadow note (the preview of the note a click would enter) at a point of a page
 * (inches from the page's top left), like moving the mouse over MuseScore's notation view. Returns its bounds for
 * repainting (drawShadowNote), null if it is not shown (not in note input mode or no input position there).
 */
export function showShadowNote(score: Score, pageIdx: number, x: number, y: number): PageRect | null {
    const pos = pagePointToCanvas(score, pageIdx, x, y)
    const st = notationState(score)
    if (!pos || !st.controller.hoverMove(pos)) {
        if (score.shadowNote().visible()) {
            st.controller.hoverLeave()
        }
        return null
    }
    return pageRectOf(score, pageIdx, st.interaction.shadowNoteRect())
}

/** hides the shadow note (the mouse left the view); returns true if it was shown */
export function hideShadowNote(score: Score): boolean {
    const shown = score.shadowNote().visible() && score.shadowNote().isValid()
    notationState(score).controller.hoverLeave()
    return shown
}

/**
 * Draws only the shadow note (if shown) onto a transparent canvas, with the same coordinates as drawPage (dpi,
 * region): MuseScore's view paints it over the score.
 */
export function drawShadowNote(score: Score, pageIdx: number, ctx: Canvas2D,
    options: { dpi?: number; region?: { x: number; y: number; width: number; height: number } } = {}): void {
    const page = score.pages()[pageIdx]
    const note = score.shadowNote()
    if (!page || !note.visible() || !note.isValid()) {
        return
    }
    const dpi = options.dpi ?? 100
    const scale = dpi / DPI
    const r = options.region
    const provider = new CanvasPaintProvider(ctx, new Transform(scale, 0, 0, scale, r ? -r.x : 0, r ? -r.y : 0))
    const painter = new Painter(provider, fontProvider(), 'shadow_' + pageIdx)
    painter.translate(page.pos().times(-1))
    TDraw.drawItem(note, painter, { isPrinting: false }) // C++ score()->renderer()->drawItem(shadowNote)
}

/**
 * A right click at a point of a page in note input mode removes the note there (MuseScore's "remove-note"); returns
 * false outside of note input mode. The score is laid out again.
 */
export function rightClickAt(score: Score, pageIdx: number, x: number, y: number): boolean {
    const pos = pagePointToCanvas(score, pageIdx, x, y)
    return !!pos && notationState(score).controller.rightClick(pos)
}

/**
 * Calls the listener after changes that were not made by a call of this API: the real-time note input advances by
 * a timer ("realtime-advance" in the automatic real-time mode). Returns a function that removes the listener.
 */
/** C++ NotationInteraction::findAndSelectChordRest (the "pause-and-select" action): selects the chord/rest at a tick */
export function findAndSelectChordRest(score: Score, tick: number): void {
    notationState(score).interaction.findAndSelectChordRest(Fraction.fromTicks(tick))
}

export function onNotationChanged(score: Score, listener: () => void): () => void {
    return notationState(score).interaction.notationChanged().onNotify(listener)
}

// ---------------------------------------------------------------------------------------------------------------------
//   export (File > Export…: PDF, PNG, SVG, MIDI, MusicXML and MuseScore files)
// ---------------------------------------------------------------------------------------------------------------------

import { ExportDialogModel } from './project/exportdialogmodel'
import { ExportProjectScenario } from './project/internal/exportprojectscenario'
import { NotationWritersRegister, type ExportConfiguration } from './project/internal/notationwritersregister'
import { defaultImagesExportConfiguration } from './importexport/imagesexport/internal/imagesexportconfiguration'
import { defaultMusicXmlExportOptions } from './importexport/musicxml/api'

/** the default settings of the export formats (MuseScore's) */
export function defaultExportConfiguration(): ExportConfiguration {
    return {
        images: defaultImagesExportConfiguration(),
        midi: { expandRepeats: true, exportRPNs: true },
        musicXml: { ...defaultMusicXmlExportOptions },
    }
}

/** the export of a project: the writers with the settings and the scenario (C++ ExportProjectScenario) */
function exportProjectScenario(score: Score, configuration: ExportConfiguration, projectName: string): ExportProjectScenario {
    const writers = new NotationWritersRegister(configuration, {
        saveMscz: (s, fileName) => saveMscz(s, fileName),
        writeMscx: s => writeMscx(s),
        loadScore: (data) => {
            const s = loadScore(data)
            layoutScore(s)
            return s
        },
    })
    return new ExportProjectScenario(writers, masterNotation(score), projectName, {
        ensureLaidOut,
        setPageView: (scores) => {
            const modes = scores.map(s => ({ s, mode: viewMode(s), width: s.reflowWidth() / DPI }))
            for (const s of scores) {
                setViewMode(s, 'page')
            }
            return () => {
                for (const m of modes) {
                    setViewMode(m.s, m.mode, m.width)
                }
            }
        },
    })
}

/**
 * The model of the Export dialog for the project of `score` (the current notation, selected in the list); call init().
 * `configuration` holds the settings of the formats (changed by the dialog, onConfigurationChanged: to save them);
 * `projectName` is the project's file name without suffix (the base of the exported files' names).
 */
export function createExportDialogModel(score: Score, configuration: ExportConfiguration, projectName: string,
    onConfigurationChanged?: () => void): ExportDialogModel {
    const scenario = exportProjectScenario(score, configuration, projectName)
    return new ExportDialogModel(masterNotation(score), currentNotation(score), scenario, configuration, onConfigurationChanged)
}

export { ExportDialogModel, MusicXmlLayoutType, type ExportScoreItem } from './project/exportdialogmodel'
export { UnitType } from './project/inotationwriter'
export type { ExportType } from './project/internal/exporttype'
export type { ExportedFile } from './project/internal/exportprojectscenario'
export type { ExportConfiguration } from './project/internal/notationwritersregister'
export type { ImagesExportConfiguration } from './importexport/imagesexport/internal/imagesexportconfiguration'
export { setExportCanvasFactory, type CanvasFactory } from './importexport/imagesexport/internal/pngwriter'
export { writeMusicXml, writeMxl, type MusicXmlExportOptions } from './importexport/musicxml/api'
export { writeMidi, type MidiExportOptions } from './importexport/midi/api'
