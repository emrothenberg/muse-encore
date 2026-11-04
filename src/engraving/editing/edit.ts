/*
 * SPDX-License-Identifier: GPL-3.0-only
 * MuseEncore — port of MuseScore Studio (https://github.com/musescore/MuseScore)
 * Copyright (C) 2021-2026 MuseScore Limited and others
 *
 * Port of the parts of src/engraving/editing/edit.cpp that creating a new score needs (plus
 * MasterScore::insertMeasure of masterscore.cpp and Measure::adjustToLen of measure.cpp, which use the same
 * editing functions). The C++ functions are methods of Score/MasterScore/Measure; here they are added to these
 * classes by this module (module augmentation), so it must be imported before they are used.
 *
 * The changes go through the undo stack (Score.undo(), editing/undo.ts) like in C++; outside of a command
 * (createScore) they are applied directly. Linked staves/excerpts are not ported, so the "linked" loops only handle
 * the element itself.
 */

import type { ChordBracket } from '../dom/chordbracket'
import type { MeasureRepeat } from '../dom/measurerepeat'
import { Fraction } from '../types/fraction'
import {
    AccidentalRole, BeamMode, BracketType, DirectionV, DurationType, ElementType, KeyMode, Key,
    PlacementV, TextStyleType, VOICES, VoiceAssignment, nidx, staff2track, track2staff, track2voice,
    type DirectionH, type staff_idx_t, type track_idx_t, type voice_idx_t,
} from '../types/types'
import { Sid } from '../style/styledef'
import { Factory } from '../dom/factory'
import { Pid, PropertyFlags } from '../dom/property'
import { Score } from '../dom/score'
import { MasterScore } from '../dom/masterscore'
import { Measure, MeasureNumberMode } from '../dom/measure'
import { SegmentType, type Segment } from '../dom/segment'
import { KeySigEvent, type KeyList } from '../dom/key'
import { TDuration, toDurationList, toRhythmicDurationList } from '../dom/durationtype'
import { Transpose } from './transpose'
import { Interval } from '../dom/interval'
import { ChangeMeasureLen, InsertMeasures, InsertTime, InsertTimeUnmanagedSpanner, RemoveMeasures } from './editmeasures'
import { AddElement, ChangeElement, ChangeParent, RemoveElement } from './addremoveelement'
import { ChangeProperty } from './editproperty'
import { ChangeStyle, ChangeStyleValues } from './editstyle'
import { DefaultStyle } from '../style/defaultstyle'
import { ChangeFretting, ChangePitch } from './editnote'
import { ChangeSpannerElements, ChangeStartEndSpanner } from './editspanner'
import { MoveTremolo } from './edittremolo'
import { ScoreRange } from '../dom/range'
import { ChangeChordStaffMove } from './editchord'
import { CloneVoice, ExchangeVoice } from './editvoicing'
import { InsertPart, RemovePart } from './editpart'
import { InsertStaff, RemoveStaff } from './editstaff'
import { AddBracket, RemoveBracket } from './editbrackets'
import { searchTemplate } from '../dom/instrtemplate'
import type { Bracket } from '../dom/bracket'
import { scoreDummy } from '../compat/dummyelement'
import { MScore, MsError } from '../dom/mscore'
import { InputState, NoteEntryMethod, NoteVal } from '../dom/input'
import { NoteType } from '../dom/chordrest'
import { AccidentalType } from '../dom/accidentaldata'
import { Accidental } from '../dom/accidental'
import { PropertyPropagation } from '../dom/engravingobject'
import { SelectType } from '../dom/select'
import { FiguredBass } from '../dom/figuredbass'
import { nextChordRest } from '../dom/chord'
import { tpc2alter } from '../dom/pitchspelling'
import {
    allowRemoveWhenRemovingStaves, collectElementsAnchoredToChordRest, collectElementsAnchoredToNote, noteAnchoredSpannerIsInRange, searchTieNote,
} from '../dom/utils'
import { propertyValueEquals } from '../types/propertyvalue'
import { TranslatableString } from '../../framework/global/types/translatablestring'
import { PointF } from '../../framework/draw/types/geometry'
import type { DurationElement } from '../dom/durationelement'
import type { Beam } from '../dom/beam'
import type { LayoutBreak } from '../dom/layoutbreak'
import { ArticulationAnchor, type Articulation } from '../dom/articulation'
import type { Ornament } from '../dom/ornament'
import type { TremoloTwoChord } from '../dom/tremolotwochord'
import type { SlurTieSegment } from '../dom/slurtie'
import type { TrillSegment } from '../dom/trill'
import type { FretDiagram } from '../dom/fret'
import type { EngravingItem } from '../dom/engravingitem'
import type { MeasureBase } from '../dom/measurebase'
import type { ChordRest } from '../dom/chordrest'
import type { Rest } from '../dom/rest'
import type { Part } from '../dom/part'
import type { Staff } from '../dom/staff'
import type { TimeSig } from '../dom/timesig'
import type { KeySig } from '../dom/keysig'
import type { InstrumentChange } from '../dom/instrchange'
import type { FBox } from '../dom/box'
import { Text } from '../dom/text'
import type { TextBase } from '../dom/textbase'
import type { Spanner, SpannerSegment } from '../dom/spanner'
import type { Chord } from '../dom/chord'
import type { Note } from '../dom/note'
import type { Tuplet } from '../dom/tuplet'
import type { Tie } from '../dom/tie'
import type { Selection } from '../dom/select'
// (imports of the text editing section)
import { StaffText, SystemText } from '../dom/stafftextbase'
import { Fingering } from '../dom/fingering'
import { HarmonyType, type Harmony } from '../dom/harmony'
import type { RehearsalMark } from '../dom/rehearsalmark'
import type { TempoText } from '../dom/tempotext'
import type { Lyrics } from '../dom/lyrics'
import type { SelectionFilter } from '../dom/selectionfilter'
import type { EngravingObject } from '../dom/engravingobject'
import type { PropertyValue } from '../types/propertyvalue'
import type { SymId } from '../types/symid'
import { ChangePageNumberOffset } from './editscoreproperties'
import { EditSystemLocks } from './editsystemlocks'
import type { SystemLockIndicator } from '../dom/indicatoricon'
import { LayoutBreakType } from '../types/types'
import type { GuitarBend } from '../dom/guitarbend'
import type { Box } from '../dom/box'
import type { ChordLine } from '../dom/chordline'
import type { StringTunings } from '../dom/stringtunings'
import { StringData } from '../dom/stringdata'
import type { Breath } from '../dom/breath'

/** C++ Score::InsertMeasureOptions */
export class InsertMeasureOptions {
    createEmptyMeasures = false
    moveSignaturesClef = true
    needDeselectAll = true
    cloneBoxToAllParts = true
    moveStaffTypeChanges = true
    ignoreBarLines = false
}

declare module '../dom/score' {
    interface Score {
        /** the tick of the selected chord/rest (the input position of e.g. loop markers) */
        pos(): Fraction
        doUndoAddElement(element: EngravingItem): void
        undoAddElement(element: EngravingItem, addToLinkedStaves?: boolean, ctrlModifier?: boolean, elementToRelink?: EngravingItem | null): void
        doUndoRemoveElement(element: EngravingItem): void
        undoRemoveElement(element: EngravingItem | null, removeLinked?: boolean): void
        undoRemovePart(part: Part, partIdx?: number): void
        undoInsertPart(part: Part, targetPartIndex: number): void
        undoRemoveStaff(staff: Staff): void
        undoInsertStaff(staff: Staff, ridx: staff_idx_t, createRests?: boolean): void
        undoAddBracket(staff: Staff, level: number, type: BracketType, span: number): void
        undoRemoveBracket(b: Bracket): void
        undoInsertTime(tick: Fraction, len: Fraction): void
        undoAddCR(cr: ChordRest, measure: Measure, tick: Fraction): void
        insertMeasure(type: ElementType, beforeMeasure?: MeasureBase | null, options?: InsertMeasureOptions): MeasureBase | null
        insertBox(type: ElementType, beforeMeasure: MeasureBase | null, options?: InsertMeasureOptions): MeasureBase | null
        restoreInitialKeySigAndTimeSig(): void
        cmdAddTimeSig(fm: Measure, staffIdx: staff_idx_t, ts: TimeSig, local: boolean): void
        undoChangeKeySig(ostaff: Staff, tick: Fraction, key: KeySigEvent): void
        updateInstrumentChangeTranspositions(key: KeySigEvent, staff: Staff, tick: Fraction): void
        addText(type: TextStyleType, destinationElement?: EngravingItem | null): TextBase | null
        /** figuredbass.cpp */
        addFiguredBass(): FiguredBass | null
        clearSystemLocks(): void
        adjustKeySigs(sidx: staff_idx_t, eidx: staff_idx_t, km: KeyList): void

        // ---- edit.cpp functions used by the editing commands (being ported) ----
        getSelectedNote(): Note | null
        getSelectedChordRest(): ChordRest | null
        getSelectedChordRests(): Set<ChordRest>
        /** C++ addRest(const Fraction& tick, ...) and addRest(Segment*, ...) */
        addRest(tickOrSegment: Fraction | Segment, track: track_idx_t, d: TDuration, tuplet: Tuplet | null): Rest
        addMeasureRepeat(tick: Fraction, track: track_idx_t, numMeasures: number): MeasureRepeat
        addChord(tick: Fraction, d: TDuration, oc: Chord, genTie: boolean, tuplet: Tuplet | null): Chord | null
        addClone(cr: ChordRest, tick: Fraction, d: TDuration): ChordRest
        setRest(tick: Fraction, track: track_idx_t, l: Fraction, useDots: boolean, tuplet: Tuplet | null, useFullMeasureRest?: boolean): Rest | null
        setRests(tick: Fraction, track: track_idx_t, l: Fraction, useDots: boolean, tuplet: Tuplet | null, useFullMeasureRest?: boolean): Rest[]
        addNote(chord: Chord, noteVal: NoteVal, forceAccidental?: boolean, articulationIds?: ReadonlySet<SymId>, externalInputState?: InputState | null): Note
        addNoteToTiedChord(chord: Chord, noteVal: NoteVal, forceAccidental?: boolean, articulationIds?: ReadonlySet<SymId>): Note | null
        searchNote(tick: Fraction, track: track_idx_t): ChordRest | null
        regroupNotesAndRests(startTick: Fraction, endTick: Fraction, track: track_idx_t): void
        cmdTieNoteList(selection: Selection, noteEntryMode: boolean): Note[]
        cmdAddTie(addToChord?: boolean): void
        cmdToggleTie(): Tie | null
        cmdToggleLaissezVib(): void
        cmdFlip(): void
        deleteItem(el: EngravingItem | null): void
        deleteRange(segStart: Segment, segEnd: Segment | null, trackStart: track_idx_t, trackEnd: track_idx_t, filter: SelectionFilter,
            selectionContainsMultiNoteChords?: boolean): ChordRest[]
        deleteRangeAtTrack(crsToSelect: ChordRest[], track: track_idx_t, startSeg: Segment | null, endTick: Fraction,
            currentTuplet: Tuplet | null, filter: SelectionFilter, selectionContainsMultiNoteChords: boolean): void
        deleteOrShortenOutSpannersFromRange(t1: Fraction, t2: Fraction, track1: track_idx_t, track2: track_idx_t, filter: SelectionFilter): void
        deleteSlursFromRange(t1: Fraction, t2: Fraction, trackStart: track_idx_t, trackEnd: track_idx_t, filter: SelectionFilter): void
        deleteAnnotationsFromRange(s1: Segment | null, s2: Segment | null, track1: track_idx_t, track2: track_idx_t,
            filter: SelectionFilter): void
        cmdDeleteTuplet(tuplet: Tuplet, replaceWithRest: boolean): void
        cmdDeleteSelection(): void
        cmdEnterRest(d: TDuration): void
        enterRest(d: TDuration, externalInputState?: InputState | null): void
        removeChordRest(cr: ChordRest, clearSegment: boolean): void
        nextInputPos(cr: ChordRest | null, doSelect: boolean): void
        undoChangeVisible(item: EngravingItem, visible: boolean): void
        undoChangePitch(note: Note, pitch: number, tpc1: number, tpc2: number): void
        undoChangeFretting(note: Note, pitch: number, string: number, fret: number, tpc1: number, tpc2: number): void
        undoChangeParent(element: EngravingItem | null, parent: EngravingItem | null, staffIdx: staff_idx_t): void
        undoChangeTpc(note: Note, tpc: number): void
        undoChangeChordRestLen(cr: ChordRest, d: TDuration): void
        undoChangeElement(oldElement: EngravingItem | null, newElement: EngravingItem): void
        undoChangeUserMirror(n: Note, d: DirectionH): void
        undoChangeSpannerElements(spanner: Spanner, startElement: EngravingItem | null, endElement: EngravingItem | null): void
        undoChangeStyleVal(idx: Sid, v: PropertyValue): void
        resetStyleValue(styleToReset: Sid): void
        resetStyleValues(styleIdSet: ReadonlySet<Sid>): void
        /**
         * C++ Score::loadStyle(IODevice&, ign, overlap) (scorefile.cpp): applies a style file (its content here) through
         * the undo stack; overlap: only its values that are not the defaults
         */
        loadStyle(data: string, ign?: boolean, overlap?: boolean): boolean
        undoChangeStyleValues(values: Map<Sid, PropertyValue>): void
        undoChangePageNumberOffset(po: number): void
        /** C++ undoPropertyChanged(EngravingObject*, Pid, const PropertyValue&, PropertyFlags) */
        undoPropertyChanged(e: EngravingObject, t: Pid, st: PropertyValue, ps?: PropertyFlags): void
        /** C++ bool undoPropertyChanged(EngravingItem*, Pid, const PropertyValue&, PropertyFlags) (renamed: no overloads in TS) */
        undoPropertyChangedItem(item: EngravingItem, propId: Pid, propValue: PropertyValue, propFlags?: PropertyFlags): boolean
        cmdExchangeVoice(s: voice_idx_t, d: voice_idx_t): void
        undoExchangeVoice(measure: Measure, srcVoice: voice_idx_t, dstVoice: voice_idx_t, srcStaff: staff_idx_t, dstStaff: staff_idx_t): void

        // ---- score.cpp ----
        cmdRemovePart(part: Part | null): void
        cmdRemoveStaff(staffIdx: staff_idx_t): void
        adjustBracketsDel(sidx: number, eidx: number): void
        adjustBracketsIns(sidx: number, eidx: number): void
        updateBracesAndBarlines(part: Part, newIndex: number): void
        remapBracketsAndBarlines(): void
        changeSelectedElementsVoice(voice: voice_idx_t): void
        canReselectItem(item: EngravingItem | null): boolean
    }
}

Score.prototype.pos = function (this: Score): Fraction {
    let el: EngravingItem | null = this.selection().element()
    if (this.selection().activeCR()) {
        el = this.selection().activeCR()
    }
    if (el) {
        if (el.type() === ElementType.NOTE) {
            el = el.parentItem()!
        }
        switch (el.type()) {
        case ElementType.MEASURE_REPEAT:
        case ElementType.REST:
        case ElementType.MMREST:
        case ElementType.CHORD:
            return (el as unknown as ChordRest).tick()
        default:
            break
        }
    }
    return new Fraction(0, 1)
}

declare module '../dom/masterscore' {
    interface MasterScore {
        /** C++ MasterScore::insertMeasure(MeasureBase*, const InsertMeasureOptions&) (renamed: no overloads in TS) */
        insertMeasureInMaster(beforeMeasure?: MeasureBase | null, options?: InsertMeasureOptions): Measure | null
    }
}

declare module '../dom/measure' {
    interface Measure {
        adjustToLen(nf: Fraction, appendRestsIfNecessary?: boolean): void
    }
}

Score.prototype.doUndoAddElement = function (this: Score, element: EngravingItem): void {
    if (element.generated()) {
        this.addElement(element)
    } else {
        this.undo(new AddElement(element))
    }
}

Score.prototype.doUndoRemoveElement = function (this: Score, element: EngravingItem): void {
    if (element.generated()) {
        this.removeElement(element)
    } else {
        this.undo(new RemoveElement(element))
    }
}

/** C++ isSystemTextLine() of textlinebase.h */
function isSystemTextLine(element: EngravingItem | null): boolean {
    return !!element && element.isTextLineBase() && element.systemFlag()
}

/** the element types added to the linked staves (the other ones are only added to their own staff) */
const LINKED_STAFF_TYPES: ReadonlySet<ElementType> = new Set([
    ElementType.ARTICULATION, ElementType.ORNAMENT, ElementType.TAPPING, ElementType.CHORDLINE, ElementType.LYRICS,
    ElementType.SLUR, ElementType.HAMMER_ON_PULL_OFF, ElementType.TIE, ElementType.NOTE, ElementType.INSTRUMENT_CHANGE,
    ElementType.HAIRPIN, ElementType.OTTAVA, ElementType.TRILL, ElementType.VIBRATO, ElementType.TEXTLINE,
    ElementType.PEDAL, ElementType.LET_RING, ElementType.PALM_MUTE, ElementType.WHAMMY_BAR,
    ElementType.PARTIAL_LYRICSLINE, ElementType.BREATH, ElementType.DYNAMIC, ElementType.EXPRESSION,
    ElementType.STAFF_TEXT, ElementType.SYSTEM_TEXT, ElementType.TRIPLET_FEEL, ElementType.PLAYTECH_ANNOTATION,
    ElementType.CAPO, ElementType.STRING_TUNINGS, ElementType.STICKING, ElementType.TREMOLO_SINGLECHORD,
    ElementType.TREMOLO_TWOCHORD, ElementType.ARPEGGIO, ElementType.CHORD_BRACKET, ElementType.SYMBOL,
    ElementType.IMAGE, ElementType.TREMOLOBAR, ElementType.FRET_DIAGRAM, ElementType.FERMATA, ElementType.HARMONY,
    ElementType.HARP_DIAGRAM, ElementType.FIGURED_BASS, ElementType.CLEF, ElementType.AMBITUS,
    ElementType.PLAY_COUNT_TEXT,
])

// Some elements in voice 1 of a staff should be copied to every track which has a linked voice in this staff
const VOICE1_COPY_TYPES: ReadonlySet<ElementType> = new Set([
    ElementType.SYMBOL, ElementType.IMAGE, ElementType.TREMOLOBAR, ElementType.DYNAMIC, ElementType.EXPRESSION,
    ElementType.STAFF_TEXT, ElementType.PLAYTECH_ANNOTATION, ElementType.CAPO, ElementType.STRING_TUNINGS,
    ElementType.STICKING, ElementType.FRET_DIAGRAM, ElementType.HARMONY, ElementType.HAIRPIN, ElementType.OTTAVA,
    ElementType.TRILL, ElementType.SLUR, ElementType.HAMMER_ON_PULL_OFF, ElementType.VIBRATO, ElementType.TEXTLINE,
    ElementType.PEDAL, ElementType.LYRICS, ElementType.PARTIAL_LYRICSLINE, ElementType.CLEF, ElementType.AMBITUS,
])

/** C++ static findLinkedChord (edit.cpp): the chord linked to c in the staff nstaff */
export function findLinkedChord(c: Chord, nstaff: Staff): Chord | null {
    const se = c.score().excerpt()
    const de = nstaff.score().excerpt()
    let strack = c.track()

    if (se) {
        // muse::key: the first key with the value (default 0)
        strack = se.tracksMapping().find(([, v]) => v === strack)?.[0] ?? 0
    }
    let dtrack = nstaff.idx() * VOICES + strack % VOICES

    if (de) {
        const l = de.tracksMapping().filter(([k]) => k === strack).map(([, v]) => v)
        if (!l.length) {
            // simply return the first linked chord whose staff is equal to nstaff
            for (const ee of c.linkList()) {
                const ch = ee as Chord
                if (ch.staff() === nstaff) {
                    return ch
                }
            }
            return null
        }
        for (const i of l) {
            if (nstaff.idx() * VOICES <= i && (nstaff.idx() + 1) * VOICES > i) {
                dtrack = i
                break
            }
        }
    }

    const s = c.segment()
    const nm = nstaff.score().tick2measure(s.tick())
    const ns = nm ? nm.findSegment(s.segmentType(), s.tick()) : null
    const ne = ns ? ns.element(dtrack) : null
    if (!ne || !ne.isChord()) {
        return null
    }
    let nc = ne as Chord
    if (c.isGrace()) {
        const pc = c.explicitParent() as unknown as Chord
        let index = 0
        for (const gc of pc.graceNotes()) {
            if (c === gc) {
                break
            }
            index++
        }
        if (index < nc.graceNotes().length) {
            nc = nc.graceNotes()[index]
        }
    }
    return nc
}

Score.prototype.undoAddElement = function (this: Score, element: EngravingItem, addToLinkedStaves = true,
    ctrlModifier = false, elementToRelink: EngravingItem | null = null): void {
    const ostaff = element.staff()
    const strack = element.track()
    const et = element.type()

    //
    // some elements are replicated for all parts regardless of
    // linking:
    //

    const isSystemLine = isSystemTextLine(element)

    if ((et === ElementType.REHEARSAL_MARK)
        || (et === ElementType.SYSTEM_TEXT)
        || (et === ElementType.TRIPLET_FEEL)
        || (et === ElementType.JUMP)
        || (et === ElementType.MARKER)
        || (et === ElementType.TEMPO_TEXT)
        || (et === ElementType.PLAY_COUNT_TEXT)
        || isSystemLine
    ) {
        let staffList: (Staff | null)[] = []

        if (!addToLinkedStaves) {
            staffList.push(element.staff())
        } else if (ctrlModifier && isSystemLine) {
            staffList = [...ostaff!.staffList()]
            element.setSystemFlag(false)
        } else {
            for (const s of this.scoreList()) {
                staffList.push(s.staff(0)) // system objects always appear on the top staff
                for (const staff of s.systemObjectStaves()) {
                    if (staff.idx() === nidx) {
                        continue
                    }
                    staffList.push(staff)
                }
            }
        }

        if (elementToRelink) {
            staffList = staffList.filter(st => st !== ostaff)
        }

        let originalAdded = false
        for (const staff of staffList) {
            if (!staff) {
                continue
            }

            const score = staff.score()
            const staffIdx = staff.idx()
            const ntrack = staffIdx * VOICES
            let ne: EngravingItem

            if (ostaff && staff.score() === ostaff.score() && staff === staffList[0] && !originalAdded) {
                // add the element itself to the first system object staff in the score
                ne = element
                originalAdded = true
            } else {
                // add linked clones to the other staves
                ne = element.linkedClone()
                ne.setScore(score)
                ne.setSelected(false)
                ne.setTrack(staffIdx * VOICES + element.voice())
            }

            if (isSystemLine) {
                const nsp = ne as unknown as Spanner
                const sp = element as unknown as Spanner
                const diff = sp.track2() - sp.track()
                nsp.setTrack2(nsp.track() + diff)
                nsp.computeStartElement()
                nsp.computeEndElement()
                this.doUndoAddElement(nsp)
            } else if (et === ElementType.MARKER || et === ElementType.JUMP) {
                const om = element.explicitParent() as unknown as Measure
                const m = score.tick2measure(om.tick())!
                ne.setTrack(ntrack)
                ne.setParent(m)
                this.doUndoAddElement(ne)
            } else if (et === ElementType.MEASURE_NUMBER) {
                (element.explicitParent() as unknown as Measure).undoChangeProperty(Pid.MEASURE_NUMBER_MODE, MeasureNumberMode.SHOW)
            } else if (et === ElementType.PLAY_COUNT_TEXT) {
                const segment = element.explicitParent() as unknown as Segment
                const tick = segment.tick()
                const m = score.tick2measure(tick.minus(Fraction.eps()))!
                const seg = m.undoGetSegment(SegmentType.EndBarLine, tick)
                ne.setTrack(ntrack)
                ne.setParent(seg)
                this.doUndoAddElement(ne)
            } else {
                const segment = element.explicitParent() as unknown as Segment
                const tick = segment.tick()
                const m = score.tick2measure(tick)!
                const seg = m.undoGetSegment(SegmentType.ChordRest, tick)
                ne.setTrack(ntrack)
                ne.setParent(seg)
                this.doUndoAddElement(ne)
            }
        }

        return
    }

    if (et === ElementType.FINGERING
        || (et === ElementType.IMAGE && !element.explicitParent()!.isSegment())
        || (et === ElementType.SYMBOL && !element.explicitParent()!.isSegment())
        || et === ElementType.NOTE
        || et === ElementType.TEXT
        || et === ElementType.GLISSANDO
        || et === ElementType.GUITAR_BEND
        || et === ElementType.NOTELINE
        || et === ElementType.BEND
        || (et === ElementType.CHORD && (element as unknown as Chord).isGrace())
        || et === ElementType.LAISSEZ_VIB
        || et === ElementType.PARTIAL_TIE
        || et === ElementType.PARENTHESIS
    ) {
        const parent = element.parentItem()
        let links = parent ? parent.links() : null

        // don't link part name
        if (et === ElementType.TEXT) {
            const t = element as unknown as Text
            if (t.textStyleType() === TextStyleType.INSTRUMENT_EXCERPT) {
                links = null
            }
        }
        if (!links || !addToLinkedStaves) {
            this.doUndoAddElement(element)
            return
        }
        for (const ee of [...links]) {
            const e = ee as EngravingItem
            let ne: EngravingItem
            if (e === parent) {
                ne = element
            } else {
                if (element.isGlissando() || element.isGuitarBend() || element.isNoteLine()) { // and other spanners with Anchor::NOTE
                    const newEnd = SpannerClass.endElementFromSpanner(element as unknown as Spanner, e)
                    if (newEnd) {
                        ne = element.linkedClone();
                        (ne as unknown as Spanner).setNoteSpan(e as unknown as Note, newEnd)
                        if (element.isGuitarBend() && element.staffType()!.isTabStaff()) {
                            (ne as unknown as GuitarBend).endNote()!.setVisible(true)
                        }
                    } else { // couldn't find suitable start note
                        continue
                    }
                } else if (element.isFingering()) {
                    const tabFingering = e.staff()!.staffType(e.tick())!.showTabFingering()
                    if (e.staff()!.isTabStaff(e.tick()) && !tabFingering) {
                        continue
                    }
                    ne = element.linkedClone()
                } else {
                    ne = element.linkedClone()
                }
            }
            ne.setScore(e.score())
            ne.setSelected(false)
            ne.setParent(e)
            this.doUndoAddElement(ne)
        }
        return
    }

    if (et === ElementType.LAYOUT_BREAK) {
        const lb = element as unknown as LayoutBreak
        if (lb.layoutBreakType() === LayoutBreakType.SECTION) {
            this.doUndoAddElement(lb)
            let m: MeasureBase | null = lb.measure()
            if (m.isBox()) {
                // for frames, use linked frames
                const links = m.links()
                if (links) {
                    for (const lo of [...links]) {
                        if (lo.isBox()) {
                            const box = lo as unknown as Box
                            const score = box.score()
                            if (score !== lb.score()) {
                                const e = lb.linkedClone()
                                e.setScore(score)
                                e.setParent(box)
                                this.doUndoAddElement(e)
                            }
                        }
                    }
                    return
                } else { // if thera are not linked frames, use previous measure
                    m = m.prevMeasure()
                    if (!m) {
                        return
                    }
                }
            }
            for (const s of this.scoreList()) {
                if (s !== lb.score()) {
                    const e = lb.linkedClone()
                    e.setScore(s)
                    const nm = s.tick2measure(m.tick())
                    e.setParent(nm)
                    this.doUndoAddElement(e)
                }
            }
            return
        }
    }

    if (!ostaff || !LINKED_STAFF_TYPES.has(et)) {
        this.doUndoAddElement(element)
        return
    }

    let staves: Staff[]
    if (addToLinkedStaves) {
        staves = ostaff.staffList()
    } else {
        staves = [ostaff]
    }

    if (elementToRelink) {
        staves = staves.filter(st => st !== ostaff)
    }

    for (const staff of staves) {
        const score = staff.score()
        const staffIdx = staff.idx()

        let linkedTrack = ostaff.getLinkedTrackInStaff(staff, strack)
        if (linkedTrack === nidx) {
            if (track2voice(strack) === 0 && VOICE1_COPY_TYPES.has(et)) {
                linkedTrack = staff2track(staffIdx)
            } else {
                continue
            }
        }

        let ne: EngravingItem
        if (staff === ostaff) {
            ne = element
        } else {
            if (staff.rstaff() !== ostaff.rstaff()) {
                switch (element.type()) {
                // exclude certain element types except on corresponding staff in part
                // this should be same list excluded in cloneStaff()
                case ElementType.STAFF_TEXT:
                case ElementType.SYSTEM_TEXT:
                case ElementType.TRIPLET_FEEL:
                case ElementType.PLAYTECH_ANNOTATION:
                case ElementType.CAPO:
                case ElementType.STRING_TUNINGS:
                case ElementType.FRET_DIAGRAM:
                case ElementType.HARMONY:
                case ElementType.FIGURED_BASS:
                case ElementType.DYNAMIC:
                case ElementType.EXPRESSION:
                case ElementType.LYRICS: // not normally segment-attached
                case ElementType.PARTIAL_LYRICSLINE:
                case ElementType.PLAY_COUNT_TEXT:
                case ElementType.WHAMMY_BAR:
                    continue
                default:
                    break
                }
            }
            ne = element.linkedClone()
            ne.setScore(score)
            ne.setSelected(false)
            ne.setTrack(linkedTrack)

            if (ne.isFretDiagram()) {
                const fd = ne as unknown as FretDiagram
                const fdHarmony = fd.harmony()
                if (fdHarmony) {
                    fdHarmony.setScore(score)
                    fdHarmony.setSelected(false)
                    fdHarmony.setTrack(linkedTrack)
                }
            }
        }

        if (element.isArticulationFamily()) {
            const a = element as unknown as Articulation
            let segment: Segment
            let st: SegmentType
            let m: Measure | null
            let tick: Fraction
            if (a.explicitParent()!.isChordRest()) {
                const cr = a.chordRest()!
                segment = cr.segment()
                st = SegmentType.ChordRest
                tick = segment.tick()
                m = score.tick2measure(tick)
            } else {
                segment = a.explicitParent()!.explicitParent() as unknown as Segment
                st = SegmentType.EndBarLine
                tick = segment.tick()
                m = score.tick2measure(tick)
                if (m && m.tick().eq(tick)) {
                    m = m.prevMeasure()
                }
            }
            const seg = m ? m.findSegment(st, tick) : null
            if (!seg) {
                console.warn('undoAddSegment: segment not found')
                break
            }
            const na = ne as unknown as Articulation
            na.setTrack(linkedTrack)
            if (a.explicitParent()!.isChordRest()) {
                const cr = a.chordRest()!
                let ncr: ChordRest | null
                if (cr.isGrace()) {
                    ncr = findLinkedChord(cr as Chord, score.staff(staffIdx)!)
                } else {
                    ncr = seg.element(linkedTrack) as ChordRest | null
                }
                na.setParent(ncr)
            } else {
                const bl = seg.element(linkedTrack) as BarLine | null
                na.setParent(bl)
            }
            this.doUndoAddElement(na)
        } else if (element.isChordLine() || element.isLyrics()) {
            const cr = element.explicitParent() as unknown as ChordRest
            const segment = cr.segment()
            const tick = segment.tick()
            const m = score.tick2measure(tick)
            const seg = m ? m.findSegment(SegmentType.ChordRest, tick) : null
            if (!seg) {
                console.warn('undoAddSegment: segment not found')
                break
            }
            ne.setTrack(linkedTrack)
            let ncr = seg.element(linkedTrack) as ChordRest | null
            ne.setParent(ncr)
            if (element.isChordLine()) {
                if (cr.isGrace()) {
                    ncr = findLinkedChord(cr as Chord, score.staff(staffIdx)!)
                    ne.setParent(ncr)
                }
                const oldChordLine = element as unknown as ChordLine
                const newChordLine = ne as unknown as ChordLine
                // Chordline also needs to know the new note
                const oldNote = oldChordLine.note()
                const newNote = oldNote ? (ncr as Chord).findNote(oldNote.pitch()) : null
                newChordLine.setNote(newNote)
            }
            this.doUndoAddElement(ne)
        } else if (element.isHarmony() && element.explicitParent()!.isFretDiagram()) {
            const parentFd = element.parentItem()!
            if (parentFd.score() !== score) {
                // Find linked fret diagram
                const linkedFd = parentFd.findLinkedInScore(score)
                ne.setParent(linkedFd)
            }
            this.doUndoAddElement(ne)
        } else if (element.isSymbol()
            || element.isImage()
            || element.isTremoloBar()
            || element.isDynamic()
            || element.isExpression()
            || element.isStaffText()
            || element.isPlayTechAnnotation()
            || element.isCapo()
            || element.isStringTunings()
            || element.isSticking()
            || element.isFretDiagram()
            || element.isFermata()
            || element.isHarmony() // Case with parent FretDiagram handled above, so we know it has parent Segment
            || element.isHarpPedalDiagram()
            || element.isFiguredBass()
            || element.isClef()
            || element.isAmbitus()) {
            //
            // elements with Segment as parent
            //
            const segment = element.explicitParent() as unknown as Segment
            const tick = segment.tick()
            let m = score.tick2measure(tick)!
            const addClefToPrevMeasure = (segment.segmentType() & SegmentType.Clef) !== 0 && element.isClef() && !(element as unknown as Clef).isHeader()
            const addBlToPrevMeasure = (segment.segmentType() & SegmentType.EndBarLine) !== 0
            if (m.tick().eq(tick) && (addClefToPrevMeasure || addBlToPrevMeasure) && m.prevMeasure()) {
                m = m.prevMeasure()!
            }
            const seg = m.undoGetSegment(segment.segmentType(), tick)
            ne.setTrack(linkedTrack)
            ne.setParent(seg)

            if (ne.isStringTunings()) {
                const stringTunings = ne as unknown as StringTunings
                if (stringTunings.stringData().isNull()) {
                    const stringData = stringTunings.part()!.stringData(tick, staff.idx())!
                    const frets = stringData.frets()
                    const stringList = stringData.stringList()

                    stringTunings.setStringData(StringData.fromStrings(frets, stringList))
                }
            }

            this.doUndoAddElement(ne)
            // transpose harmony if necessary
            if (element.isHarmony() && ne !== element) {
                const h = ne as unknown as Harmony
                if (score.style().styleB(Sid.concertPitch) !== element.style().styleB(Sid.concertPitch)) {
                    const staffDest = h.staff()!
                    const interval = staffDest.transpose(tick).clone()
                    if (!interval.isZero()) {
                        if (!score.style().styleB(Sid.concertPitch)) {
                            interval.flip()
                        }
                        Transpose.undoTransposeHarmony(score, h, interval)
                    }
                }
            }
        } else if (element.isSlur()
            || element.isHairpin()
            || element.isOttava()
            || element.isTrill()
            || element.isVibrato()
            || element.isTextLine()
            || element.isPedal()
            || element.isLetRing()
            || element.isPalmMute()
            || element.isWhammyBar()
            || element.isPartialLyricsLine()) {
            const sp = element as unknown as Spanner
            const nsp = ne as unknown as Spanner
            const tr2 = sp.effectiveTrack2()
            const diff = tr2 - sp.track()
            nsp.setTrack2(linkedTrack + diff)
            nsp.setTrack(linkedTrack)

            // determine start/end element for slurs
            // this is only necessary if start/end element is
            //   a grace note, otherwise the element can be set to zero
            //   and will later be calculated from tick/track values
            //
            if (element.isSlur() && sp !== nsp) {
                if (sp.startElement()) {
                    for (const ee of sp.startElement()!.linkList()) {
                        const e = ee as EngravingItem
                        if (e.score() === nsp.score() && e.track() === nsp.track()) {
                            nsp.setStartElement(e)
                            break
                        }
                    }
                }
                if (sp.endElement()) {
                    for (const ee of sp.endElement()!.linkList()) {
                        const e = ee as EngravingItem
                        if (e.score() === nsp.score() && e.track() === nsp.track2()) {
                            nsp.setEndElement(e)
                            break
                        }
                    }
                }
            }

            if (sp.isTextLine() && sp !== nsp) {
                const parent = sp.parentItem()
                if (parent && parent.isNote()) {
                    nsp.setParent(parent.findLinkedInStaff(staff))
                }
                const endEl = sp.endElement()
                if (endEl && endEl.isNote()) {
                    nsp.setEndElement(endEl.findLinkedInStaff(staff))
                }
            }

            this.doUndoAddElement(nsp)
        } else if ((et as ElementType) === ElementType.GLISSANDO || (et as ElementType) === ElementType.GUITAR_BEND
            || (et as ElementType) === ElementType.NOTELINE) {
            this.doUndoAddElement(ne)
        } else if (element.isType(ElementType.TREMOLO_TWOCHORD)) {
            const tremolo = element as unknown as TremoloTwoChord
            const cr1 = tremolo.chord1()!
            const cr2 = tremolo.chord2()!
            const diff = cr2.track() - cr1.track()
            const s1 = cr1.segment()
            const s2 = cr2.segment()
            const m1 = s1.measure()
            const m2 = s2.measure()
            const nm1 = score.tick2measure(m1.tick())!
            const nm2 = score.tick2measure(m2.tick())!
            const ns1 = nm1.findSegment(s1.segmentType(), s1.tick())!
            const ns2 = nm2.findSegment(s2.segmentType(), s2.tick())!
            const c1 = ns1.element(linkedTrack) as Chord
            const c2 = ns2.element(linkedTrack + diff) as Chord
            const ntremolo = ne as unknown as TremoloTwoChord
            ntremolo.setChords(c1, c2)
            ntremolo.setParent(c1)
            this.doUndoAddElement(ntremolo)
        } else if (element.isType(ElementType.TREMOLO_SINGLECHORD)) {
            const cr = element.explicitParent() as unknown as Chord
            const c1 = findLinkedChord(cr, score.staff(staffIdx)!)
            ne.setParent(c1)
            this.doUndoAddElement(ne)
        } else if (element.isArpeggio() || element.isChordBracket()) {
            const cr = element.explicitParent() as unknown as ChordRest
            const s = cr.segment()
            const m = s.measure()
            const nm = score.tick2measure(m.tick())!
            const ns = nm.findSegment(s.segmentType(), s.tick())!
            const c1 = ns.element(linkedTrack) as Chord
            ne.setParent(c1)
            this.doUndoAddElement(ne)
        } else if (element.isTie()) {
            const tie = element as unknown as Tie
            const n1 = tie.startNote()!
            const n2 = tie.endNote()
            const cr1 = n1.chord()
            const cr2 = n2 ? n2.chord() : null

            // find corresponding notes in linked staff
            // accounting for grace notes and cross-staff notation
            let sm = 0
            if (cr2 && cr1.staffIdx() !== cr2.staffIdx()) {
                sm = cr2.staffIdx() - cr1.staffIdx()
            }
            const c1 = findLinkedChord(cr1, score.staff(staffIdx)!)
            const c2 = cr2 && score.staff(staffIdx + sm) ? findLinkedChord(cr2, score.staff(staffIdx + sm)!) : null

            if (!c1) {
                return
            }

            const nn1 = c1.findNote(n1.pitch(), n1.unisonIndex())
            const nn2 = c2 && n2 ? c2.findNote(n2.pitch(), n2.unisonIndex()) : null

            const track1 = c1.track()
            const track2 = c2 ? c2.track() : track1

            // create tie
            const ntie = ne as unknown as Tie
            ntie.eraseSpannerSegments()
            ntie.setTrack(track1)
            ntie.setTrack2(track2)
            ntie.setStartNote(nn1)
            ntie.setEndNote(nn2)
            this.doUndoAddElement(ntie)
        } else if (element.isInstrumentChange()) {
            const is = element as unknown as InstrumentChange
            const s1 = is.segment()
            const m1 = s1.measure()
            const nm1 = score.tick2measure(m1.tick())!
            const ns1 = nm1.findSegment(s1.segmentType(), s1.tick())
            const nis = ne as unknown as InstrumentChange
            nis.setParent(ns1)
            const tickStart = nis.segment().tick()
            const part = nis.part()!
            const oldV = nis.staff()!.transpose(tickStart).clone()
            // ws: instrument should not be changed here
            const ch0 = is.instrument().channel(0)
            if (!is.instrument().channels().length || ch0!.program() === -1) {
                nis.setInstrument(staff.part().instrument(s1.tick()))
            } else if (nis !== is) {
                nis.setInstrument(is.instrument())
            }
            this.doUndoAddElement(nis)
            // transpose root score; parts will follow
            if (score.isMaster() && !nis.staff()!.transpose(tickStart).equals(oldV)) {
                const i = part.instruments().upperBound(tickStart.ticks())
                const tickEnd = i === part.instruments().size() ? new Fraction(-1, 1) : Fraction.fromTicks(part.instruments().keyAt(i))
                Transpose.transpositionChanged(this, part, oldV, tickStart, tickEnd)
            }
        } else if (element.isBreath()) {
            const breath = element as unknown as Breath
            const tick = breath.segment()!.tick()
            let m = score.tick2measure(tick)!
            // breath appears before barline
            if (m.tick().eq(tick)) {
                m = m.prevMeasure()!
            }
            const seg = m.undoGetSegment(SegmentType.Breath, tick)
            const nbreath = ne as unknown as Breath
            nbreath.setScore(score)
            nbreath.setTrack(linkedTrack)
            nbreath.setParent(seg)
            this.doUndoAddElement(nbreath)
        } else {
            console.warn(`undoAddElement: unhandled: <${element.typeName()}>`)
        }
        ne.styleChanged()

        if (elementToRelink) {
            const links = ne.links()
            if (!links) {
                ne.linkTo(elementToRelink)
            } else {
                elementToRelink.setLinks(links as EngravingObject[])
                ;(links as EngravingObject[]).push(elementToRelink)
            }
        }
    }
}

/** removeLinked: also remove the linked elements */
Score.prototype.undoRemoveElement = function (this: Score, element: EngravingItem | null, removeLinked = true): void {
    if (!element) {
        return
    }
    const segments: Segment[] = []
    for (const ee of element.linkList()) {
        const e = ee as EngravingItem
        if (e === element || removeLinked) {
            this.doUndoRemoveElement(e)

            if (e.explicitParent() && e.explicitParent()!.isSegment()) {
                const s = e.explicitParent() as unknown as Segment
                if (!segments.includes(s)) {
                    segments.push(s)
                }
            }
            if (e.explicitParent() && e.explicitParent()!.isSystem()) {
                e.setParent(null) // systems will be regenerated upon redo, so detach
            }
        }
    }

    // TODO(port): measure repeats (undoChangeMeasureRepeatCount)

    for (const s of segments) {
        if (s.empty()) {
            if (s.header() || s.trailer()) { // probably more segment types (system header)
                s.setEnabled(false)
            } else {
                this.doUndoRemoveElement(s)
            }
        }
    }
}

Score.prototype.undoRemovePart = function (this: Score, part: Part, partIdx: number = nidx): void {
    this.undo(new RemovePart(part, partIdx))
}

Score.prototype.undoInsertPart = function (this: Score, part: Part, targetPartIndex: number): void {
    this.undo(new InsertPart(part, targetPartIndex))
}

/** idx - index of staff in part */
Score.prototype.undoRemoveStaff = function (this: Score, staff: Staff): void {
    const staffIndex = staff.idx()

    const spannersToRemove: Spanner[] = []

    for (const spanner of this.spanner()) {
        if (allowRemoveWhenRemovingStaves(spanner, staffIndex)) {
            spannersToRemove.push(spanner)
        }
    }

    for (const spanner of this.unmanagedSpanners()) {
        if (allowRemoveWhenRemovingStaves(spanner, staffIndex)) {
            spannersToRemove.push(spanner)
        }
    }

    for (const spanner of spannersToRemove) {
        spanner.undoUnlink()
        this.doUndoRemoveElement(spanner)
    }

    //
    //    adjust measures
    //
    for (let m = staff.score().firstMeasure(); m; m = m.nextMeasure()) {
        m.cmdRemoveStaves(staffIndex, staffIndex + 1)
        if (m.hasMMRest()) {
            m.mmRest()!.cmdRemoveStaves(staffIndex, staffIndex + 1)
        }
    }

    staff.undoUnlink()

    this.undo(new RemoveStaff(staff))
}

/** ridx - index of staff in part */
Score.prototype.undoInsertStaff = function (this: Score, staff: Staff, ridx: staff_idx_t, createRests = true): void {
    this.undo(new InsertStaff(staff, ridx))
    const idx = this.staffIdxOfPart(staff.part()) + ridx
    for (let m = this.firstMeasure(); m; m = m.nextMeasure()) {
        m.cmdAddStaves(idx, idx + 1, createRests)
        if (m.hasMMRest()) {
            m.mmRest()!.cmdAddStaves(idx, idx + 1, false)
        }
    }
    // when newly adding an instrument,
    // this was already set when we created the staff
    // we don't have any better info at this point
    // and it doesn't work to adjust bracket & barlines until all staves are added
    // TODO: adjust brackets only when appropriate
    //adjustBracketsIns(idx, idx+1);
}

Score.prototype.undoRemoveBracket = function (this: Score, b: Bracket): void {
    this.undo(new RemoveBracket(b.staff()!, b.column(), b.bracketType(), b.span()))
}

// ---- score.cpp: the part and staff functions that create undo commands ----

Score.prototype.cmdRemovePart = function (this: Score, part: Part | null): void {
    if (!part) {
        return
    }

    const sidx = this.staffIdxOfPart(part)
    const n = part.nstaves()

    for (let i = 0; i < n; ++i) {
        this.cmdRemoveStaff(sidx)
    }

    this.undoRemovePart(part, this.parts().indexOf(part))
}

Score.prototype.cmdRemoveStaff = function (this: Score, staffIdx: staff_idx_t): void {
    const s = this.staff(staffIdx)!
    this.adjustBracketsDel(staffIdx, staffIdx + 1)

    this.undoRemoveStaff(s)
}

Score.prototype.adjustBracketsDel = function (this: Score, sidx: number, eidx: number): void {
    if (!(sidx < eidx && eidx <= this.nstaves())) {
        return
    }

    const staves = this.staves()
    for (let staffIdx = 0; staffIdx < eidx; ++staffIdx) {
        const staff = staves[staffIdx]
        for (const bi of [...staff.brackets()]) {
            const span = bi.bracketSpan()
            if ((span === 0) || ((staffIdx + span) <= sidx)) {
                continue
            }
            const startsOutsideDeletedRange = staffIdx < sidx
            const endsOutsideDeletedRange = (staffIdx + span) >= eidx
            if (startsOutsideDeletedRange && endsOutsideDeletedRange) {
                // Shorten the bracket by the number of staves deleted
                bi.undoChangeProperty(Pid.BRACKET_SPAN, span - (eidx - sidx))
            } else if (startsOutsideDeletedRange) {
                // Shorten the bracket by the number of staves deleted that were spanned by it
                bi.undoChangeProperty(Pid.BRACKET_SPAN, sidx - staffIdx)
            } else if (endsOutsideDeletedRange) {
                if (eidx < staves.length) {
                    // Move the bracket past the end of the deleted range,
                    // and shorten it by the number of staves deleted that were spanned by it.
                    // That is, add a new bracket; the old one will be removed when removing the staves.

                    this.undoAddBracket(staves[eidx], bi.column(), bi.bracketType(), span - (eidx - staffIdx))
                }
            }
        }
    }
}

Score.prototype.adjustBracketsIns = function (this: Score, sidx: number, eidx: number): void {
    const staves = this.staves()
    for (let staffIdx = 0; staffIdx < staves.length; ++staffIdx) {
        const staff = staves[staffIdx]
        for (const bi of staff.brackets()) {
            const span = bi.bracketSpan()
            if ((span === 0) || ((staffIdx + span) < sidx) || (staffIdx > eidx)) {
                continue
            }
            if ((sidx >= staffIdx) && (eidx <= (staffIdx + span))) {
                bi.undoChangeProperty(Pid.BRACKET_SPAN, span + (eidx - sidx))
            }
        }
    }
}

Score.prototype.updateBracesAndBarlines = function (this: Score, part: Part, newIndex: number): void {
    let noBracesFound = true
    for (let indexInPart = 0; indexInPart < part.nstaves(); ++indexInPart) {
        const indexInScore = part.staves()[indexInPart].idx()
        for (const bi of this.staff(indexInScore)!.brackets()) {
            noBracesFound = false
            if (bi.bracketType() === BracketType.BRACE) {
                if ((indexInPart <= newIndex) && (newIndex <= bi.bracketSpan())) {
                    bi.undoChangeProperty(Pid.BRACKET_SPAN, bi.bracketSpan() + 1)
                }
            }
        }
    }

    const updateBracketSpan = (modIndex: number, refIndex: number): void => {
        const modStaff = this.staff(part.staves()[modIndex].idx())!
        const refStaff = this.staff(part.staves()[refIndex].idx())!
        modStaff.undoChangeProperty(Pid.STAFF_BARLINE_SPAN, refStaff.getProperty(Pid.STAFF_BARLINE_SPAN))
    }

    if (newIndex >= 2) {
        updateBracketSpan(newIndex - 1, newIndex - 2)
    }

    if (part.nstaves() === 2) {
        const tp = searchTemplate(part.instrument().id())
        if (tp) {
            const firstStaffBarLineSpan = tp.barlineSpan[0]
            if (firstStaffBarLineSpan) {
                this.staff(part.staff(0)!.idx())!.undoChangeProperty(Pid.STAFF_BARLINE_SPAN, firstStaffBarLineSpan)
            }
            if (noBracesFound && (tp.bracket[0] !== BracketType.NO_BRACKET)) {
                this.undoAddBracket(part.staves()[0], 0, tp.bracket[0], part.nstaves())
            }
        }
    } else {
        updateBracketSpan(newIndex, newIndex - 1)
    }
}

/**
 * Reconstructs brackets and barlines based on how they are in the masterScore. Must be called after creating an
 * excerpt or adding new parts to it.
 */
Score.prototype.remapBracketsAndBarlines = function (this: Score): void {
    if (this.isMaster()) {
        return
    }

    // Remove all brackets
    for (const staff of this.staves()) {
        for (const bracket of staff.brackets()) {
            bracket.setBracketType(BracketType.NO_BRACKET)
        }
    }
    // Remap all brackets from masterScore
    const master = this.masterScore()
    for (let masterStaffIdx = 0; masterStaffIdx < master.nstaves(); ++masterStaffIdx) {
        let masterStaff = master.staff(masterStaffIdx)!
        const brackets = [...masterStaff.brackets()]

        for (let bracketIdx = 0; bracketIdx < brackets.length; ++bracketIdx) {
            const bracket = brackets[bracketIdx]
            let firstBracketed: Staff | null = null
            let span = 0

            // There is no guarantee that bracket->bracketSpan() is correctly bounded,
            // so masterStaffIdx + bracket->bracketSpan() might be > master->nstaves(),
            // in which case masterStaff below will become null.
            const endSpannedMasterStaffIdx = Math.min(masterStaffIdx + bracket.bracketSpan(), master.nstaves())

            for (let spannedMasterStIdx = masterStaffIdx; spannedMasterStIdx < endSpannedMasterStaffIdx; ++spannedMasterStIdx) {
                masterStaff = master.staff(spannedMasterStIdx)!

                const linkedStaff = masterStaff.findLinkedInScore(this)
                if (!linkedStaff) {
                    continue
                }

                if (!firstBracketed) {
                    firstBracketed = linkedStaff
                }

                ++span
            }

            if (firstBracketed && span > 1) {
                firstBracketed.setBracketType(bracketIdx, bracket.bracketType())
                firstBracketed.setBracketSpan(bracketIdx, span)
            }
        }
    }

    // Remap all barline spans from masterScore
    for (const staff of this.staves()) {
        let masterStaff = staff.findLinkedInScore(this.masterScore())
        if (!masterStaff || !masterStaff.barLineSpan()) {
            continue
        }
        // Look in the masterScore for all the staves spanned by a common barline.
        // If at least one of them is also in this score, then connect it through.
        let extendBarline = false
        let span = masterStaff.barLineSpan()
        while (!extendBarline && span && masterStaff.idx() + 1 < master.nstaves()) {
            masterStaff = this.masterScore().staff(masterStaff.idx() + 1)!
            span = masterStaff.barLineSpan()
            if (masterStaff.findLinkedInScore(this)) {
                extendBarline = true
                break
            }
        }
        if (extendBarline) {
            staff.setBarLineSpan(true)
        }
    }
}

Score.prototype.undoAddBracket = function (this: Score, staff: Staff, level: number, type: BracketType, span: number): void {
    const startStaffIdx = staff.idx()
    const totStaves = this.nstaves()

    // Make sure this brackets won't overlap with others sharing same column.
    // If overlaps are found, move the other brackets outwards (i.e. increase column).
    for (let staffIdx = startStaffIdx; staffIdx < startStaffIdx + span && staffIdx < totStaves; ++staffIdx) {
        const brackets = this.staves()[staffIdx].brackets()

        for (let i = brackets.length - 1; i >= level; --i) {
            if (i >= brackets.length) {
                // This might theoretically happen when a lot of brackets get cleaned up
                // after changing the column of the first bracket we see
                continue
            }

            if (brackets[i].bracketType() === BracketType.NO_BRACKET) {
                continue
            }

            brackets[i].undoChangeProperty(Pid.BRACKET_COLUMN, brackets[i].column() + 1)
        }
    }

    this.undo(new AddBracket(staff, level, type, span))
}

/** (the linked spanners of the parts follow through the property propagation) */
Score.prototype.undoInsertTime = function (this: Score, tick: Fraction, len: Fraction): void {
    if (len.isZero()) {
        return
    }

    const spannersToAdjust: Spanner[] = []
    for (const s of this.spanner()) {
        if (s.tick2().lt(tick)) {
            continue
        }
        let append = false
        if (len.gt(new Fraction(0, 1))) {
            if (tick.gt(s.tick()) && tick.lt(s.tick2())) {
                append = true
            } else if (tick.le(s.tick())) {
                append = true
            }
        } else {
            const tick2 = tick.minus(len)
            if (s.tick().ge(tick2)) {
                append = true
            } else if (s.tick().ge(tick) && s.tick2().le(tick2)) {
                append = true
            } else if (s.tick().le(tick) && s.tick2().ge(tick2)) {
                const t2 = s.tick2().plus(len)
                if (t2.gt(s.tick())) {
                    append = true
                }
            } else if (s.tick().gt(tick) && s.tick2().gt(tick2)) {
                append = true
            } else if (s.tick().lt(tick) && s.tick2().lt(tick2)) {
                append = true
            }
        }
        for (const ss of spannersToAdjust) {
            if (ss.linkList().includes(s)) {
                append = false
                break
            }
        }
        if (append) {
            spannersToAdjust.push(s)
        }
    }
    for (const s of spannersToAdjust) {
        if (len.gt(new Fraction(0, 1))) {
            if (tick.eq(s.tick()) && s.isVolta()) {
                s.undoChangeProperty(Pid.SPANNER_TICKS, s.ticks().plus(len))
            } else if (tick.gt(s.tick()) && tick.lt(s.tick2())) {
                //
                //  case a:
                //  +----spanner--------+
                //    +---add---
                //
                s.undoChangeProperty(Pid.SPANNER_TICKS, s.ticks().plus(len))
            } else if (tick.le(s.tick())) {
                //
                //  case b:
                //       +----spanner--------
                //  +---add---
                // and
                //            +----spanner--------
                //  +---add---+
                const startElement = s.startElement()
                const endElement = s.endElement()
                this.undoChangeSpannerElements(s, null, null)
                s.undoChangeProperty(Pid.SPANNER_TICK, s.tick().plus(len))
                this.undoChangeSpannerElements(s, startElement, endElement)
            }
        } else {
            const tick2 = tick.minus(len)
            if (s.tick().ge(tick2)) {
                //
                //  case A:
                //  +----remove---+ +---spanner---+
                //
                let t = s.tick().plus(len)
                if (t.lt(new Fraction(0, 1))) {
                    t = new Fraction(0, 1)
                }
                const startElement = s.startElement()
                const endElement = s.endElement()
                this.undoChangeSpannerElements(s, null, null)
                s.undoChangeProperty(Pid.SPANNER_TICK, t)
                this.undoChangeSpannerElements(s, startElement, endElement)
            } else if (s.tick().ge(tick) && s.tick2().le(tick2)) {
                //
                //  case B:
                //    +---spanner---+
                //  +----remove--------+
                //
                this.undoRemoveElement(s)
            } else if (s.tick().le(tick) && s.tick2().ge(tick2)) {
                //
                //  case C:
                //  +----spanner--------+
                //    +---remove---+
                //
                const t2 = s.tick2().plus(len)
                if (t2.gt(s.tick())) {
                    s.undoChangeProperty(Pid.SPANNER_TICKS, s.ticks().plus(len))
                }
            } else if (s.tick().gt(tick) && s.tick2().gt(tick2)) {
                //
                //  case D:
                //       +----spanner--------+
                //  +---remove---+
                //
                const d1 = s.tick().minus(tick)
                const d2 = tick2.minus(s.tick())
                const le = s.ticks().minus(d2)
                if (le.isZero()) {
                    this.undoRemoveElement(s)
                } else {
                    s.undoChangeProperty(Pid.SPANNER_TICK, s.tick().minus(d1))
                    s.undoChangeProperty(Pid.SPANNER_TICKS, le)
                }
            } else if (s.tick().lt(tick) && s.tick2().lt(tick2)) {
                //
                //  case E:
                //       +----spanner--------+
                //                     +---remove---+
                //
                const d = s.tick2().minus(tick)
                const le = s.ticks().minus(d)
                if (le.isZero()) {
                    this.undoRemoveElement(s)
                } else {
                    s.undoChangeProperty(Pid.SPANNER_TICKS, le)
                }
            }
        }
    }

    this.undo(new InsertTimeUnmanagedSpanner(this, tick, len))
}

Score.prototype.undoAddCR = function (this: Score, cr: ChordRest, measure: Measure, tick: Fraction): void {
    if (cr.lyrics().length) {
        // Add chordrest and lyrics separately for correct
        // handling of adding lyrics to linked staves.
        const lyrics = [...cr.lyrics()]
        cr.lyrics().length = 0
        this.undoAddCR(cr, measure, tick)
        for (const l of lyrics) {
            this.undoAddElement(l)
        }
        return
    }

    const ostaff = cr.staff()!
    const strack = cr.track()

    const segmentType = SegmentType.ChordRest

    for (const staff of ostaff.staffList()) {
        const linkedTrack = ostaff.getLinkedTrackInStaff(staff, strack)

        if (linkedTrack === nidx || linkedTrack < staff.part().startTrack() || linkedTrack >= staff.part().endTrack()) {
            continue
        }

        const score = staff.score()
        const m = score === this ? measure : score.tick2measure(tick)
        if (!m) {
            break
        }
        const seg = m.undoGetSegment(segmentType, tick)

        const newcr = staff === ostaff ? cr : cr.linkedClone() as ChordRest
        newcr.setScore(score)

        newcr.setTrack(linkedTrack)
        newcr.setParent(seg)

        // Climb up the (possibly nested) tuplets from this chordRest
        // Make sure all tuplets are cloned and correctly nested
        let elementBelow: DurationElement = cr
        let tupletAbove = elementBelow.tuplet()
        while (tupletAbove) {
            const linkedElementBelow = elementBelow.findLinkedInStaff(staff) as DurationElement | null
            if (!linkedElementBelow) { // shouldn't happen
                break
            }
            let linkedTuplet = tupletAbove.findLinkedInStaff(staff) as Tuplet | null
            if (!linkedTuplet) {
                linkedTuplet = tupletAbove.linkedClone() as Tuplet
                linkedTuplet.setScore(score)
                linkedTuplet.setTrack(newcr.track())
                linkedTuplet.setParent(m)
            }
            linkedElementBelow.setTuplet(linkedTuplet)

            elementBelow = tupletAbove
            tupletAbove = tupletAbove.tuplet()
        }

        if (newcr.isRest() && (newcr as Rest).isGap() && !(newcr.track() % VOICES)) {
            (newcr as Rest).setGap(false)
        }

        this.doUndoAddElement(newcr)
    }
}

/**
 * if inserting Measure, act on master score (and add to all linked scores);
 * if inserting Box, add to local score only
 */
Score.prototype.insertMeasure = function (this: Score, type: ElementType, beforeMeasure: MeasureBase | null = null,
    options: InsertMeasureOptions = new InsertMeasureOptions()): MeasureBase | null {
    let localInsertMeasureBase: MeasureBase | null = null
    if (type === ElementType.MEASURE) {
        const masterInsertMeasure = this.masterScore().insertMeasureInMaster(beforeMeasure, options)
        if (masterInsertMeasure) {
            localInsertMeasureBase = this.tick2measureBase(masterInsertMeasure.tick())
        }
    } else {
        localInsertMeasureBase = this.insertBox(type, beforeMeasure, options)
    }

    // TODO(port): deselectAll()

    return localInsertMeasureBase
}

Score.prototype.insertBox = function (this: Score, type: ElementType, beforeMeasure: MeasureBase | null,
    options: InsertMeasureOptions = new InsertMeasureOptions()): MeasureBase | null {
    const isFrame = type === ElementType.FBOX || type === ElementType.HBOX || type === ElementType.TBOX || type === ElementType.VBOX

    if (!isFrame) {
        return null
    }

    let tick: Fraction
    const isTitleFrame = type === ElementType.VBOX && !!beforeMeasure && beforeMeasure === beforeMeasure.score().first()
    if (beforeMeasure) {
        if (beforeMeasure.isMeasure()) {
            const m = beforeMeasure as Measure
            if (m.isMMRest()) {
                beforeMeasure = m.mmRestFirst()
            }
            // TODO(port): measure repeat groups (MsError::CANNOT_SPLIT_MEASURE_REPEAT)
        } else {
            beforeMeasure = beforeMeasure.top() // don't try to insert in front of nested frame
        }
        tick = beforeMeasure!.tick()
    } else {
        tick = this.last() ? this.last()!.endTick() : new Fraction(0, 1)
    }

    const newMeasureBase = Factory.createItem(type, this.dummySystem()) as MeasureBase
    newMeasureBase.setTick(tick)
    newMeasureBase.setNext(beforeMeasure)
    newMeasureBase.setPrev(beforeMeasure ? beforeMeasure.prev() : this.last())
    newMeasureBase.setSizeIsSpatiumDependent(!isTitleFrame)

    if (type === ElementType.FBOX) {
        (newMeasureBase as unknown as FBox).init()
    }

    this.undo(new InsertMeasures(newMeasureBase, newMeasureBase))

    if (options.cloneBoxToAllParts) {
        newMeasureBase.manageExclusionFromParts(/*exclude =*/ false)
    }

    return newMeasureBase
}

Score.prototype.restoreInitialKeySigAndTimeSig = function (this: Score): void {
    const concertPitch = this.style().styleB(Sid.concertPitch)
    const startTick = new Fraction(0, 1)

    const firstMeas = this.firstMeasure()!
    for (const staff of this.staves()) {
        const concertKey = Key.C
        let transposedKey = concertKey
        const part = staff.part()
        const instrument = part.instrument()
        const transpose = -instrument.transpose().chromatic
        if (!concertPitch) {
            transposedKey = Transpose.transposeKey(transposedKey, Interval.fromChromatic(transpose), part.preferSharpFlat())
        }

        const keySegment = firstMeas.undoGetSegment(SegmentType.KeySig, startTick)

        const keySigEvent = new KeySigEvent()
        keySigEvent.setConcertKey(concertKey)
        keySigEvent.setKey(transposedKey)
        // use atonal KS for drums
        if (instrument.useDrumset()) {
            keySigEvent.setCustom(true)
            keySigEvent.setMode(KeyMode.NONE)
        }

        const newKeySig = Factory.createItem(ElementType.KEYSIG, keySegment) as KeySig
        newKeySig.setTrack(staff.idx() * VOICES)
        keySegment.add(newKeySig)
        newKeySig.setKeySigEvent(keySigEvent)
        this.undoAddElement(newKeySig)

        staff.setKey(new Fraction(0, 1), keySigEvent)

        const timeSegment = firstMeas.undoGetSegment(SegmentType.TimeSig, startTick)
        const newTimeSig = Factory.createItem(ElementType.TIMESIG, timeSegment) as TimeSig
        newTimeSig.setTrack(staff.idx() * VOICES)
        newTimeSig.setSig(new Fraction(4, 4))
        timeSegment.add(newTimeSig)
        this.undoAddElement(newTimeSig)
    }

    firstMeas.setTimesig(new Fraction(4, 4))
    firstMeas.setTicks(new Fraction(4, 4))
}

Score.prototype.cmdAddTimeSig = function (this: Score, fm: Measure, staffIdx: staff_idx_t, ts: TimeSig, local: boolean): void {
    this.deselectAll()

    if (fm.isMMRest()) {
        fm = fm.mmRestFirst()!
    }

    const ns = ts.sig()
    const tick = fm.tick()
    if (local) {
        const stretch = ns.div(fm.timesig()).reduced()
        ts.setStretch(stretch)
    }

    const track = staffIdx * VOICES
    let seg = fm.findSegment(SegmentType.TimeSig, tick)
    let ots = seg ? seg.element(track) as TimeSig | null : null

    // Check same tick at end of previous measure
    if (!ots) {
        const prevMeasure = fm.prevMeasure()
        seg = prevMeasure ? prevMeasure.findSegmentR(SegmentType.TimeSig, prevMeasure.ticks()) : seg
        ots = seg ? seg.element(track) as TimeSig | null : null
    }

    if (ots && ots.equals(ts)) {
        //
        //  ignore if there is already a timesig
        //  with same values
        //
        return
    }

    seg = fm.undoGetSegment(SegmentType.TimeSig, tick)

    const getStaffIdxRange = (score: Score): [staff_idx_t, staff_idx_t] => {
        if (local) {
            if (score === this) {
                return [staffIdx, staffIdx + 1]
            }
            const thisStaff = this.staff(staffIdx)!
            const linkedStaff = thisStaff.findLinkedInScore(score)
            if (linkedStaff) {
                return [linkedStaff.idx(), linkedStaff.idx() + 1]
            }
            return [0, 0]
        }
        return [0, score.nstaves()]
    }

    if (ots && ots.sig().eq(ns) && ots.stretch().eq(ts.stretch())) {
        //
        // the measure duration does not change,
        // so its ok to just update the time signatures
        //
        const nts = this.staff(staffIdx)!.nextTimeSig(tick.plus(Fraction.eps()))
        const lmTick = nts ? nts.segment().tick() : new Fraction(-1, 1)
        for (const score of this.scoreList()) {
            const mf = score.tick2measure(tick)
            const lm = !lmTick.eq(new Fraction(-1, 1)) ? score.tick2measure(lmTick) : null
            for (let m = mf; m && m !== lm; m = m.nextMeasure()) {
                const changeActual = m.ticks().eq(m.timesig())
                m.undoChangeProperty(Pid.TIMESIG_NOMINAL, ns)
                if (changeActual) {
                    m.undoChangeProperty(Pid.TIMESIG_ACTUAL, ns)
                }
            }
            const [first, end] = getStaffIdxRange(score)
            for (let si = first; si < end; ++si) {
                const nsig = seg.element(si * VOICES) as TimeSig | null
                if (!nsig) {
                    continue
                }
                nsig.undoChangeProperty(Pid.SHOW_COURTESY, ts.showCourtesySig())
                nsig.undoChangeProperty(Pid.TIMESIG, ts.sig())
                nsig.undoChangeProperty(Pid.TIMESIG_TYPE, ts.timeSigType())
                nsig.undoChangeProperty(Pid.NUMERATOR_STRING, ts.numeratorString())
                nsig.undoChangeProperty(Pid.DENOMINATOR_STRING, ts.denominatorString())
                nsig.undoChangeProperty(Pid.TIMESIG_STRETCH, ts.stretch())
                nsig.undoChangeProperty(Pid.GROUP_NODES, ts.groups().nodes())
                nsig.setSelected(false)
                nsig.setDropTarget(false)
            }
        }
    } else {
        const mScore = this.masterScore()
        let mf: Measure | null = mScore.tick2measure(tick)

        //
        // rewrite all measures up to the next time signature
        //
        if (mf === mScore.firstMeasure() && mf!.nextMeasure() && !mf!.ticks().eq(mf!.timesig())) {
            // handle upbeat
            mf!.undoChangeProperty(Pid.TIMESIG_NOMINAL, ns)
            const m = mf!.nextMeasure()!
            const s = m.findSegment(SegmentType.TimeSig, m.tick())
            mf = s ? null : mf!.nextMeasure()
        } else {
            if (this.sigmap().timesig(seg.tick().ticks()).nominal().identical(ns)) {
                // no change to global time signature,
                // but we need to rewrite any staves with local time signatures
                for (let i = 0; i < this.nstaves(); ++i) {
                    const its = this.staff(i)!.timeSig(tick)
                    if (its && its.isLocal()) {
                        if (!mScore.rewriteMeasures(mf!, ns, i)) {
                            this.undoStack().activeCommand()!.unwind()
                            return
                        }
                    }
                }
                mf = null
            }
        }

        // try to rewrite the measures first
        // we will only add time signatures if this succeeds
        // this means, however, that the rewrite cannot depend on the time signatures being in place
        if (mf) {
            const [first, end] = getStaffIdxRange(mScore)
            if (end !== first && !mScore.rewriteMeasures(mf, ns, local ? first : nidx)) {
                this.undoStack().activeCommand()!.unwind()
                return
            }
        }
        // add the time signatures
        const masterTimeSigs = new Map<track_idx_t, TimeSig>()
        for (const score of this.scoreList()) {
            const nfm = score.tick2measure(tick)!
            seg = nfm.undoGetSegment(SegmentType.TimeSig, nfm.tick())
            const [first, end] = getStaffIdxRange(score)
            for (let si = first; si < end; ++si) {
                if (fm.isMeasureRepeatGroup(si)) {
                    this.deleteItem(fm.measureRepeatElement(si))
                }
                let nsig = seg.element(si * VOICES) as TimeSig | null
                if (!nsig) {
                    nsig = ts.clone() as TimeSig // Factory::copyTimeSig
                    nsig.setScore(score)
                    nsig.setTrack(si * VOICES)
                    nsig.setParent(seg)
                    nsig.styleChanged()
                    this.undoAddElement(nsig)
                    if (score.excerpt()) {
                        const masterTrack = score.excerpt()!.tracksMapping().find(([, v]) => v === nsig!.track())?.[0] ?? 0
                        const masterTimeSig = masterTimeSigs.get(masterTrack)
                        if (masterTimeSig) {
                            this.undo(new Link(masterTimeSig, nsig))
                        }
                    }
                } else {
                    nsig.undoChangeProperty(Pid.SHOW_COURTESY, ts.showCourtesySig())
                    nsig.undoChangeProperty(Pid.TIMESIG_TYPE, ts.timeSigType())
                    nsig.undoChangeProperty(Pid.TIMESIG, ts.sig())
                    nsig.undoChangeProperty(Pid.NUMERATOR_STRING, ts.numeratorString())
                    nsig.undoChangeProperty(Pid.DENOMINATOR_STRING, ts.denominatorString())

                    // HACK do it twice to accommodate undo
                    nsig.undoChangeProperty(Pid.TIMESIG_TYPE, ts.timeSigType())
                    nsig.undoChangeProperty(Pid.TIMESIG_STRETCH, ts.stretch())
                    nsig.undoChangeProperty(Pid.GROUP_NODES, ts.groups().nodes())
                    nsig.setSelected(false)
                    nsig.setDropTarget(false) // DEBUG
                }

                if (score.isMaster()) {
                    masterTimeSigs.set(nsig.track(), nsig)
                }
            }
        }
    }
}

Score.prototype.undoChangeKeySig = function (this: Score, ostaff: Staff, tick: Fraction, key: KeySigEvent): void {
    let lks: KeySig | null = null
    let needsUpdate = false

    for (const staff of ostaff.staffList()) {
        if (staff.isDrumStaff(tick)) {
            continue
        }

        const score = staff.score()
        const measure = score.tick2measure(tick)
        if (!measure) {
            continue
        }
        const s = measure.undoGetSegment(SegmentType.KeySig, tick)

        const staffIdx = staff.idx()
        const track = staffIdx * VOICES
        const ks = s.element(track) as KeySig | null

        const interval = staff.part().instrument(tick).transpose().clone()
        const oldStaffInterval = staff.transpose(tick).clone()
        const nkey = key.clone()
        const concertPitch = score.style().styleB(Sid.concertPitch)

        if (interval.chromatic && !concertPitch && !nkey.isAtonal()) {
            interval.flip()
            nkey.setKey(Transpose.transposeKey(key.concertKey(), interval, staff.part().preferSharpFlat()))
            interval.flip()
        }

        this.updateInstrumentChangeTranspositions(key, staff, tick)
        if (ks) {
            ks.undoChangeProperty(Pid.GENERATED, false)
            this.undo(new ChangeKeySig(ks, nkey, ks.showCourtesy()))
        } else {
            const nks = Factory.createItem(ElementType.KEYSIG, s) as KeySig
            nks.setParent(s)
            nks.setTrack(track)
            nks.setKeySigEvent(nkey)
            this.doUndoAddElement(nks)
            if (lks) {
                this.undo(new Link(lks, nks))
            } else {
                lks = nks
            }
        }
        if (!interval.equals(staff.transpose(tick)) || !interval.equals(oldStaffInterval)) {
            needsUpdate = true
        }
    }
    if (needsUpdate) {
        const tickEnd = Fraction.fromTicks(ostaff.keyList().nextKeyTick(tick.ticks()))
        Transpose.transpositionChanged(this, ostaff.part(), ostaff.transpose(tick).clone(), tick, tickEnd)
    }
}

Score.prototype.updateInstrumentChangeTranspositions = function (this: Score, key: KeySigEvent, staff: Staff, tick: Fraction): void {
    if (!key.forInstrumentChange()) {
        const kl = staff.keyList()
        let nextTick = kl.nextKeyTick(tick.ticks())

        while (nextTick !== -1) {
            const e = kl.key(nextTick).clone()
            if (e.forInstrumentChange()) {
                if (key.isAtonal() && !e.isAtonal()) {
                    e.setMode(KeyMode.NONE)
                    e.setConcertKey(Key.C)
                } else {
                    e.setMode(key.mode())
                    const transposeInterval = staff.part().instrument(Fraction.fromTicks(nextTick)).transpose().clone()
                    transposeInterval.flip()
                    const ckey = key.concertKey()
                    const nkey = Transpose.transposeKey(ckey, transposeInterval, staff.part().preferSharpFlat())
                    e.setConcertKey(ckey)
                    e.setKey(nkey)
                }
                const m = this.tick2measure(Fraction.fromTicks(nextTick))
                const s = m ? m.tick2segment(Fraction.fromTicks(nextTick), SegmentType.KeySig) : null
                const track = staff.idx() * VOICES
                let keySig: KeySig | null = null
                const keySigElem = s ? s.element(track) : null
                if (keySigElem && keySigElem.isKeySig()) {
                    keySig = keySigElem as unknown as KeySig
                }
                if (keySig) {
                    this.undo(new ChangeKeySig(keySig, e, keySig.showCourtesy()))
                }
                nextTick = kl.nextKeyTick(nextTick)
            } else {
                nextTick = -1
            }
        }
    }
}

// port of Score::addFiguredBass (figuredbass.cpp)
Score.prototype.addFiguredBass = function (this: Score): FiguredBass | null {
    const el = this.selection().element()
    if (!el || (!(el.isNote()) && !(el.isRest()) && !(el.isFiguredBass()))) {
        MScore.setError(MsError.NO_NOTE_FIGUREDBASS_SELECTED)
        return null
    }

    let fb: FiguredBass | null
    let bNew = true
    if (el.isNote() || el.isRest()) {
        const cr = el.isNote() ? (el as unknown as Note).chord() : el as unknown as ChordRest
        const r = FiguredBass.addFiguredBassToSegment(cr.segment(), cr.staffIdx() * VOICES, new Fraction(0, 1))
        fb = r.fb
        bNew = r.isNew
    } else {
        fb = el as unknown as FiguredBass
        bNew = false
    }

    if (!fb) {
        return null
    }

    if (bNew) {
        this.undoAddElement(fb)
    }
    this.select(fb, SelectType.SINGLE, 0)
    return fb
}

Score.prototype.addText = function (this: Score, type: TextStyleType, destinationElement: EngravingItem | null = null): TextBase | null {
    let textBox: TextBase | null = null

    switch (type) {
    case TextStyleType.TITLE:
    case TextStyleType.SUBTITLE:
    case TextStyleType.COMPOSER:
    case TextStyleType.LYRICIST:
    case TextStyleType.INSTRUMENT_EXCERPT: {
        let frame: MeasureBase | null = null

        if (destinationElement && destinationElement.isVBox()) {
            frame = destinationElement as unknown as MeasureBase
        } else {
            frame = this.first()
            if (!frame || !frame.isBox()) {
                frame = this.insertBox(ElementType.VBOX, frame)
            }
        }

        textBox = new Text(frame, type) // Factory::createText(frame, type)
        textBox.setParent(frame)
        this.undoAddElement(textBox)
        break
    }
    case TextStyleType.FRAME: {
        if (!destinationElement) {
            break
        }
        textBox = new Text(destinationElement, type)
        textBox.setParent(destinationElement)
        this.undoAddElement(textBox)
        break
    }
    default:
        // the texts that need a chord/rest: in the text editing section below (addTextToChordRest)
        textBox = addTextToChordRest(this, type, destinationElement)
        break
    }

    return textBox
}

/** (score.cpp) */
Score.prototype.adjustKeySigs = function (this: Score, sidx: staff_idx_t, eidx: staff_idx_t, km: KeyList): void {
    for (let staffIdx = sidx; staffIdx < eidx; ++staffIdx) {
        const staff = this.staves()[staffIdx]
        for (const [t, ke] of km.entries()) {
            const tick = Fraction.fromTicks(t)
            const measure = this.tick2measure(tick)
            if (!measure) {
                continue
            }
            if (staff.isDrumStaff(tick)) {
                continue
            }
            const key = ke.clone()
            const v = staff.part().instrument(tick).transpose().clone()
            if (!v.isZero() && !this.style().styleB(Sid.concertPitch) && !key.isAtonal()) {
                v.flip()
                key.setKey(Transpose.transposeKey(key.concertKey(), v, staff.part().preferSharpFlat()))
            }
            staff.setKey(tick, key)

            const s = measure.getSegment(SegmentType.KeySig, tick)
            const keysig = Factory.createItem(ElementType.KEYSIG, s) as KeySig
            keysig.setParent(s)
            keysig.setTrack(staffIdx * VOICES)
            keysig.setKeySigEvent(key)
            this.doUndoAddElement(keysig)
        }
    }
}

Score.prototype.clearSystemLocks = function (this: Score): void {
    this.systemLocks().clear()
}

/**
 * Create a new MeasureBase of Measure type and insert before measure. If measure is zero, append new MeasureBase.
 */
MasterScore.prototype.insertMeasureInMaster = function (this: MasterScore, beforeMeasure: MeasureBase | null = null,
    options: InsertMeasureOptions = new InsertMeasureOptions()): Measure | null {
    let tick: Fraction
    if (beforeMeasure) {
        if (beforeMeasure.isMeasure()) {
            if ((beforeMeasure as Measure).isMMRest()) {
                beforeMeasure = (beforeMeasure as Measure).prev()
                beforeMeasure = beforeMeasure ? beforeMeasure.next() : this.firstMeasure()
                this.deselectAll()
            }
            for (let staffIdx = 0; staffIdx < this.nstaves(); ++staffIdx) {
                if ((beforeMeasure as Measure).isMeasureRepeatGroupWithPrevM(staffIdx)) {
                    MScore.setError(MsError.CANNOT_SPLIT_MEASURE_REPEAT)
                    return null
                }
            }
        }
        tick = beforeMeasure!.tick()
    } else {
        tick = this.last() ? this.last()!.endTick() : new Fraction(0, 1)
    }

    const isBeginning = tick.isZero()

    // Use nominal time signature of current or previous measure, depending on whether
    // the time sig from `beforeMeasure` will be moved to the newly created measure
    const currentTimeSig = this.sigmap().timesig(!options.moveSignaturesClef && !isBeginning && beforeMeasure && beforeMeasure.prevMeasure()
        ? beforeMeasure.prevMeasure()!.tick().ticks()
        : tick.ticks()).nominal()

    let masterMeasure: Measure | null = null
    let ticks = new Fraction(0, 1)

    for (const score of this.scoreList()) {
        let actualBeforeMeasure: MeasureBase | null = null

        if (beforeMeasure) {
            if (beforeMeasure.score() === score) {
                actualBeforeMeasure = beforeMeasure
            } else if (!beforeMeasure.isMeasure() && beforeMeasure.links()) {
                for (const m of beforeMeasure.links()!) {
                    if (m && m.isMeasureBase() && m.score() === score) {
                        actualBeforeMeasure = m as unknown as MeasureBase
                        break
                    }
                }
            }
            // if beforeMeasure is measure; or if din't find linked frame, use measure
            if (!actualBeforeMeasure) {
                actualBeforeMeasure = score.tick2measure(tick)
            }
        }

        const newMeasure = Factory.createItem(ElementType.MEASURE, score.dummySystem()) as Measure
        newMeasure.setTick(tick)

        if (actualBeforeMeasure) {
            actualBeforeMeasure = actualBeforeMeasure.top() // don't try to insert in front of nested frame
        }
        newMeasure.setNext(actualBeforeMeasure)
        newMeasure.setPrev(actualBeforeMeasure ? actualBeforeMeasure.prev() : score.last())

        newMeasure.setTimesig(currentTimeSig)
        newMeasure.setTicks(currentTimeSig)

        this.undo(new InsertMeasures(newMeasure, newMeasure, options.moveStaffTypeChanges))

        ticks = newMeasure.ticks()
        let measureInsert: Measure | null = null // insert before
        if (actualBeforeMeasure) {
            if (actualBeforeMeasure.isMeasure()) {
                measureInsert = actualBeforeMeasure as Measure
            } else {
                measureInsert = score.tick2measure(actualBeforeMeasure.tick())
            }
        }

        if (score.isMaster()) {
            masterMeasure = newMeasure
        }

        const timeSigList: TimeSig[] = []
        const keySigList: KeySig[] = []
        const initClefList: Clef[] = []
        const previousClefList: Clef[] = []
        const specialCaseClefs: Clef[] = []
        const afterBarlineClefs: Clef[] = []
        const previousBarLinesList: BarLine[] = []

        const pm = newMeasure.prevMeasure()

        //
        // remove clefs, barlines, time and key signatures
        //
        let headerKeySig = false
        if (measureInsert) {
            // if inserting before first measure, always preserve clefs and signatures
            // at the begining of the score (move them back)

            if (pm && !options.moveSignaturesClef && !isBeginning) {
                const ps = pm.findSegment(SegmentType.Clef, tick)
                if (ps && ps.enabled()) {
                    for (let staffIdx = 0; staffIdx < score.nstaves(); ++staffIdx) {
                        const pc = ps.element(staffIdx * VOICES)
                        if (pc) {
                            previousClefList.push(pc as unknown as Clef)
                            this.doUndoRemoveElement(pc)
                            if (ps.empty()) {
                                this.undoRemoveElement(ps)
                            }
                        }
                    }
                }
            }

            if (options.moveSignaturesClef || isBeginning) {
                for (let staffIdx = 0; staffIdx < score.nstaves(); ++staffIdx) {
                    for (let s = measureInsert.first(); s && s.rtick().isZero(); s = s.next()) {
                        if (!s.enabled()) {
                            continue
                        }
                        const e = s.element(staffIdx * VOICES)
                        let specialCase = false
                        let initClef = false
                        let moveClef = false
                        let moveOther = false
                        if (e && e.isClef()) {
                            if (s.isHeaderClefType()) {
                                // if it's a header clef, we only add if it's an init clef
                                // (other header clefs are handled by undo(new InsertMeasures())
                                initClef = isBeginning && !(e as unknown as Clef).forInstrumentChange()
                                moveClef = initClef
                            } else {
                                const clefPos = (e as unknown as Clef).clefToBarlinePosition()
                                if (isBeginning) {
                                    // special case:
                                    // there is a non-header clef at global tick 0, and we are inserting at the beginning of the score.
                                    // this clef will be moved with the measure it accompanies, but it will be moved before the barline.
                                    specialCase = true
                                    moveClef = true
                                } else if (clefPos === ClefToBarlinePosition.AFTER) {
                                    // non header clef at the begining of the measure
                                    moveClef = true
                                }
                            }
                        } else {
                            // otherwise, we only add if e is not generated
                            moveOther = !!e && (!e.generated() || tick.isZero())
                        }
                        if (!moveClef && !moveOther) {
                            continue // this item will remain with the old measure
                        }
                        // otherwise, this item is moved back to the new measure
                        let ee: EngravingItem | null = null
                        if (e!.isKeySig()) {
                            const ks = e as unknown as KeySig
                            if (ks.forInstrumentChange()) {
                                continue
                            }
                            keySigList.push(ks)
                            // if instrument change on that place, set correct key signature for instrument change
                            const ic = s.next(SegmentType.ChordRest)!.findAnnotation(ElementType.INSTRUMENT_CHANGE,
                                e!.part()!.startTrack(), e!.part()!.endTrack() - 1)
                            if (ic) {
                                const ke = ks.keySigEvent().clone()
                                ke.setForInstrumentChange(true)
                                this.undoChangeKeySig(ks.staff()!, e!.tick(), ke)
                            } else {
                                ee = e
                            }
                            if (s.header()) {
                                headerKeySig = true
                            }
                        } else if (e!.isTimeSig()) {
                            const ts = e as unknown as TimeSig
                            timeSigList.push(ts)
                            ee = e
                        } else if (e!.isClef()) {
                            const clef = e as unknown as Clef
                            if (specialCase) {
                                specialCaseClefs.push(clef)
                            } else if (initClef) {
                                initClefList.push(clef)
                            } else {
                                afterBarlineClefs.push(clef)
                            }
                            ee = e
                        }
                        if (ee) {
                            this.doUndoRemoveElement(ee)
                            if (s.empty() && s.isTimeSigType()) {
                                this.undoRemoveElement(s)
                            }
                        }
                    }
                }

                if (masterMeasure && measureInsert.repeatStart()) {
                    masterMeasure.undoChangeProperty(Pid.REPEAT_START, true)
                    measureInsert.undoChangeProperty(Pid.REPEAT_START, false)
                }
            }
        } else if (!measureInsert && tick.eq(new Fraction(0, 1))) {
            // If inserting measure into an empty score, restore default C key signature
            // and 4/4 time signature
            score.restoreInitialKeySigAndTimeSig()
        }

        if (pm && !options.moveSignaturesClef && !options.ignoreBarLines) {
            const pbs = pm.findSegment(SegmentType.EndBarLine, tick)
            if (pbs && pbs.enabled()) {
                for (let staffIdx = 0; staffIdx < score.nstaves(); ++staffIdx) {
                    const pb = pbs.element(staffIdx * VOICES)
                    if (pb && !pb.generated()) {
                        previousBarLinesList.push(pb as unknown as BarLine)
                        this.doUndoRemoveElement(pb)
                        if (pbs.empty()) {
                            pbs.setEnabled(false)
                        }
                    }
                }
            }
            if (masterMeasure && pm.repeatEnd()) {
                masterMeasure.undoChangeProperty(Pid.REPEAT_END, true)
                pm.undoChangeProperty(Pid.REPEAT_END, false)
            }
        }

        //
        // move clef, barline, time, key signatures
        //
        for (const ts of timeSigList) {
            const nts = ts.clone() as TimeSig // Factory::copyTimeSig
            const s = newMeasure.undoGetSegmentR(SegmentType.TimeSig, new Fraction(0, 1))
            nts.setParent(s)
            this.doUndoAddElement(nts)
        }
        for (const ks of keySigList) {
            const nks = ks.clone() as KeySig // Factory::copyKeySig
            const s = newMeasure.undoGetSegmentR(SegmentType.KeySig, new Fraction(0, 1))
            if (headerKeySig || newMeasure.tick().isZero()) {
                s.setHeader(true)
            }
            nks.setParent(s)
            if (!nks.isAtonal()) {
                nks.setKey(nks.concertKey()) // to set correct (transposing) key
            }
            this.doUndoAddElement(nks)
        }
        for (const clef of initClefList) {
            const nClef = clef.clone() as Clef // Factory::copyClef
            const s = newMeasure.undoGetSegmentR(SegmentType.HeaderClef, new Fraction(0, 1))
            s.setHeader(true)
            nClef.setParent(s)
            this.doUndoAddElement(nClef)
        }
        for (const clef of afterBarlineClefs) {
            const nClef = clef.clone() as Clef
            const s = newMeasure.undoGetSegmentR(SegmentType.Clef, new Fraction(0, 1))
            s.setHeader(true)
            nClef.setParent(s)
            this.doUndoAddElement(nClef)
        }
        for (const clef of previousClefList) {
            const nClef = clef.clone() as Clef
            const s = newMeasure.undoGetSegmentR(SegmentType.Clef, newMeasure.ticks())
            nClef.setParent(s)
            this.doUndoAddElement(nClef)
        }
        for (const clef of specialCaseClefs) {
            const nClef = clef.clone() as Clef
            const s = newMeasure.undoGetSegmentR(SegmentType.Clef, newMeasure.ticks())
            nClef.setParent(s)
            this.doUndoAddElement(nClef)
        }
        for (const barLine of previousBarLinesList) {
            const nBarLine = barLine.clone() as BarLine // Factory::copyBarLine
            const s = newMeasure.undoGetSegmentR(SegmentType.EndBarLine, newMeasure.ticks())
            nBarLine.setParent(s)
            this.doUndoAddElement(nBarLine)
        }
    }

    this.undoInsertTime(tick, ticks)

    if (masterMeasure && !options.createEmptyMeasures) {
        //
        // fill measure with rest
        // undoAddCR adds rest to linked staves as well
        for (let staffIdx = 0; staffIdx < this.nstaves(); ++staffIdx) {
            const track = staffIdx * VOICES
            const rest = Factory.createItem(ElementType.REST, this) as Rest // parent: dummy segment
            rest.setDurationType(new TDuration(DurationType.V_MEASURE))
            const timeStretch = this.staff(staffIdx)!.timeStretch(masterMeasure.tick())
            rest.setTicks(masterMeasure.ticks().times(timeStretch))
            rest.setTrack(track)
            this.undoAddCR(rest, masterMeasure, tick)
        }
    }

    if (options.needDeselectAll) {
        this.deselectAll()
    }

    return masterMeasure
}

Measure.prototype.adjustToLen = function (this: Measure, nf: Fraction, appendRestsIfNecessary = true): void {
    const ol = this.ticks()
    const nl = nf
    const diff = nl.minus(ol)

    let startTick = this.endTick()
    if (diff.lt(new Fraction(0, 1))) {
        startTick = startTick.plus(diff)
    }

    this.score().undoInsertTime(startTick, diff)

    for (const s of this.score().scoreList()) {
        s.undo(new InsertTime(s, startTick, diff))
        const m = s.tick2measure(this.tick())!
        s.undo(new ChangeMeasureLen(m, nf))
        if (nl.gt(ol)) {
            // move EndBarLine, TimeSigAnnounce, KeySigAnnounce
            for (let seg = m.first(); seg; seg = seg.next()) {
                if (seg.segmentType() & (SegmentType.EndBarLine | SegmentType.CourtesyTimeSigType | SegmentType.CourtesyKeySigType)) {
                    seg.setRtick(nl)
                }
            }
        }
    }
    const s = this.score().masterScore()
    const m = s.tick2measure(this.tick())!
    const sl = s.uniqueStaves()

    for (const staffIdx of sl) {
        let rests = 0
        let chords = 0
        let rest: Rest | null = null
        for (let segment = m.first(); segment; segment = segment.next()) {
            const strack = staffIdx * VOICES
            const etrack = strack + VOICES
            for (let track = strack; track < etrack; ++track) {
                const e = segment.element(track)
                if (e) {
                    if (e.isRest()) {
                        ++rests
                        rest = e as Rest
                    } else if (e.isChord()) {
                        ++chords
                    }
                }
            }
        }
        const stretch = s.staff(staffIdx)!.timeStretch(this.tick())
        // if just a single rest
        if (rests === 1 && chords === 0) {
            // if measure value didn't change, stick to whole measure rest
            if (this.timesig().eq(nf)) {
                rest!.undoChangeProperty(Pid.DURATION, nf.times(stretch))
                rest!.undoChangeProperty(Pid.DURATION_TYPE_WITH_DOTS, new TDuration(DurationType.V_MEASURE).typeWithDots())
            } else { // if measure value did change, represent with rests actual measure value
                // convert the measure duration in a list of values (no dots for rests)
                const durList = toRhythmicDurationList(nf.times(stretch), /*isRest=*/ true, /*rtickStart=*/ new Fraction(0, 1),
                    /*nominal=*/ this.score().sigmap().timesig(this.tick().ticks()).nominal(), /*measure=*/ this, /*maxDots=*/ 0, stretch)
                if (durList.length === 0) {
                    continue
                }
                // set the existing rest to the first value of the duration list
                const firstDur = durList[0]
                rest!.undoChangeProperty(Pid.DURATION, firstDur.isMeasure() ? this.ticks() : firstDur.fraction())
                rest!.undoChangeProperty(Pid.DURATION_TYPE_WITH_DOTS, durList[0].typeWithDots())

                // add rests for any other duration list value
                let tickOffset = this.tick().plus(rest!.actualTicks())
                for (let i = 1; i < durList.length; i++) {
                    const newRest = Factory.createItem(ElementType.REST, s) as Rest // parent: dummy segment
                    const dur = durList[i]
                    newRest.setDurationType(dur)
                    newRest.setTicks(dur.isMeasure() ? this.ticks() : dur.fraction())
                    newRest.setTrack(rest!.track())
                    this.score().undoAddCR(newRest, this, tickOffset)
                    tickOffset = tickOffset.plus(newRest.actualTicks())
                }
            }
            continue
        }

        const strack = staffIdx * VOICES
        const etrack = strack + VOICES

        for (let trk = strack; trk < etrack; ++trk) {
            let n = diff
            let rFlag = false
            if (n.lt(new Fraction(0, 1))) {
                for (let segment = m.last(); segment;) {
                    const pseg = segment.prev()
                    if (segment.segmentType() === SegmentType.ChordRest) {
                        const annotations = [...segment.annotations()] // make a copy since we alter the list
                        for (const a of annotations) {
                            if (a.track() === trk) {
                                s.undoRemoveElement(a)
                            }
                        }
                        const e = segment.element(trk)
                        if (e && e.isChordRest()) {
                            const cr = e as ChordRest
                            if (cr.durationType().type() === DurationType.V_MEASURE) {
                                const actualTicks = cr.actualTicks()
                                n = n.plus(actualTicks)
                                cr.setDurationType(new TDuration(actualTicks))
                            } else {
                                n = n.plus(cr.actualTicks())
                            }
                            s.undoRemoveElement(e)
                            if (n.ge(new Fraction(0, 1))) {
                                break
                            }
                        }
                    } else if (segment.segmentType() === SegmentType.Breath) {
                        const e = segment.element(trk)
                        if (e) {
                            s.undoRemoveElement(e)
                        }
                    }
                    segment = pseg
                }
                rFlag = true
            }
            const voice = trk % VOICES
            if (appendRestsIfNecessary && n.gt(new Fraction(0, 1)) && (rFlag || voice === 0)) {
                // add rest to measure
                const rtick = this.tick().plus(nl).minus(n)
                const track = staffIdx * VOICES + voice
                s.setRest(rtick, track, n.times(stretch), false, null, false)
            }
        }
    }
    if (diff.lt(new Fraction(0, 1))) {
        //
        //  CHECK: do not remove all slurs
        //
        for (const e of [...m.el()]) {
            if (e.isSlur()) {
                s.undoRemoveElement(e)
            }
        }
    }

    const sel = this.score().selection()
    if (!sel.isRange()) {
        return
    }
    // If the selection started and/or ended inside this measure, we should pass it
    // updated start/end segments...
    const oldStart = sel.startSegment()
    if (oldStart && sel.startMeasureBase() === this) {
        const newStart = this.tick2segment(oldStart.tick())
        sel.setStartSegment(newStart ? newStart : this.first())
    }
    const oldEnd = sel.endSegment()
    if (oldEnd && sel.endMeasureBase() === this) {
        const newEnd = this.tick2segment(oldEnd.tick())
        sel.setEndSegment(newEnd ? newEnd : this.last()!.next1())
    }
}

// =====================================================================================================================
//   edit.cpp functions of the editing commands (selection helpers, adding chords/rests/notes, ties, flip,
//   deletion, visibility, undo helpers) and Score::changeSelectedElementsVoice / canReselectItem of score.cpp
// =====================================================================================================================

Score.prototype.getSelectedNote = function (this: Score): Note | null {
    const el = this.selection().element()
    if (el && el.isNote()) {
        return el as unknown as Note
    }
    MScore.setError(MsError.NO_NOTE_SELECTED)
    return null
}

/** C++ chordOrRest() of edit.cpp */
function chordOrRest(el: EngravingItem | null): ChordRest | null {
    if (el) {
        if (el.isNote()) {
            return (el as unknown as Note).chord()
        } else if (el.isRestFamily() || el.isChord()) {
            return el as unknown as ChordRest
        }
    }
    return null
}

Score.prototype.getSelectedChordRest = function (this: Score): ChordRest | null {
    const cr = chordOrRest(this.selection().element())
    if (!cr) {
        MScore.setError(MsError.NO_NOTE_REST_SELECTED)
    }

    return cr
}

Score.prototype.getSelectedChordRests = function (this: Score): Set<ChordRest> {
    const set = new Set<ChordRest>()
    for (let e of this.selection().elements()) {
        if (e.isNote()) {
            e = e.parentItem()!
        }
        if (e.isChordRest()) {
            set.add(e as unknown as ChordRest)
        }
    }
    return set
}

/**
 * create one Rest at tick (C++ addRest(const Fraction& tick, ...)) or in the segment (addRest(Segment*, ...)) with
 * duration d; create segment if necessary
 */
Score.prototype.addMeasureRepeat = function (this: Score, tick: Fraction, track: track_idx_t, numMeasures: number): MeasureRepeat {
    const measure = this.tick2measure(tick)!
    const mr = Factory.createItem(ElementType.MEASURE_REPEAT, scoreDummy(this).segment()) as MeasureRepeat
    mr.setNumMeasures(numMeasures)
    mr.setTicks(measure.stretchedLen(this.staff(track2staff(track))!))
    mr.setTrack(track)
    this.undoAddCR(mr, measure, tick)
    return mr
}

Score.prototype.addRest = function (this: Score, tickOrSegment: Fraction | Segment, track: track_idx_t, d: TDuration,
    tuplet: Tuplet | null): Rest {
    if (tickOrSegment instanceof Fraction) {
        const tick = tickOrSegment
        const measure = this.tick2measure(tick)!
        const rest = Factory.createItem(ElementType.REST, scoreDummy(this).segment()) as Rest
        rest.setDurationType(d)
        if (d.type() === DurationType.V_MEASURE) {
            rest.setTicks(measure.stretchedLen(this.staff(track2staff(track))!))
        } else {
            rest.setTicks(d.fraction())
        }
        rest.setTrack(track)
        rest.setTuplet(tuplet)
        this.undoAddCR(rest, measure, tick)
        return rest
    }

    const s = tickOrSegment
    const rest = Factory.createItem(ElementType.REST, s) as Rest
    rest.setDurationType(d)
    if (d.type() === DurationType.V_MEASURE) {
        rest.setTicks(s.measure().stretchedLen(this.staff(Math.trunc(track / VOICES))!))
    } else {
        rest.setTicks(d.fraction())
    }
    rest.setTrack(track)
    rest.setParent(s)
    rest.setTuplet(tuplet)
    this.undoAddCR(rest, this.tick2measure(s.tick())!, s.tick())
    return rest
}

/**
 * Create one Chord at tick with duration d
 * - create segment if necessary.
 * - Use chord "oc" as prototype;
 * - if "genTie" then tie to chord "oc"
 */
Score.prototype.addChord = function (this: Score, tick: Fraction, d: TDuration, oc: Chord, genTie: boolean,
    tuplet: Tuplet | null): Chord | null {
    const measure = this.tick2measure(tick)
    if (!measure || measure.endTick().le(tick)) {
        // C++: LOGD("Score::addChord(): end of score?")
        return null
    }

    const chord = Factory.createItem(ElementType.CHORD, scoreDummy(this).segment()) as Chord
    chord.setTuplet(tuplet)
    chord.setTrack(oc.track())
    chord.setDurationType(d)
    chord.setTicks(d.fraction())
    chord.setStemDirection(oc.stemDirection())

    for (const n of oc.notes()) {
        const nn = Factory.createItem(ElementType.NOTE, chord) as Note
        nn.setPitch(n.pitch())
        nn.setTpc1(n.tpc1())
        nn.setTpc2(n.tpc2())
        chord.add(nn)
    }
    this.undoAddCR(chord, measure, tick)

    //
    // now as both chords are in place
    // (have segments as parent) we can add ties:
    //
    if (genTie) {
        const n = oc.notes().length
        for (let i = 0; i < n; ++i) {
            const n1 = oc.notes()[i]
            const n2 = chord.notes()[i]
            const tie = Factory.createItem(ElementType.TIE, scoreDummy(this)) as Tie
            tie.setStartNote(n1)
            tie.setEndNote(n2)
            tie.setTick(tie.startNote()!.tick())
            tie.setTick2(tie.endNote()!.tick())
            tie.setTrack(n1.track())
            this.undoAddElement(tie)
        }
    }

    return chord
}

Score.prototype.addClone = function (this: Score, cr: ChordRest, tick: Fraction, d: TDuration): ChordRest {
    // TODO(port): change a MeasureRepeat into a Rest (Factory::copyRest + hack_toRestType)
    const newcr = cr.clone() as ChordRest
    newcr.mutldata().setPosX(0.0)
    newcr.setDurationType(d)
    newcr.setTicks(d.isMeasure() ? cr.measure().stretchedLen(cr.staff()!) : d.fraction())
    newcr.setTuplet(cr.tuplet())
    newcr.setSelected(false)
    if (newcr.isChord()) {
        const chord = newcr as unknown as Chord
        for (const g of [...chord.graceNotes()]) {
            chord.remove(g) // C++ removeAllGraceNotes()
        }
    }

    this.undoAddCR(newcr, cr.measure(), tick)
    return newcr
}

/** sets rests and returns the first one; "l" is in local (stretched) time */
Score.prototype.setRest = function (this: Score, tick: Fraction, track: track_idx_t, l: Fraction, useDots: boolean,
    tuplet: Tuplet | null, useFullMeasureRest = true): Rest | null {
    const rests = this.setRests(tick, track, l, useDots, tuplet, useFullMeasureRest)
    return rests.length ? rests[0] : null
}

/** create one or more rests to fill "l"; "l" is in local (stretched) time */
Score.prototype.setRests = function (this: Score, tick_: Fraction, track: track_idx_t, l_: Fraction, useDots: boolean,
    tuplet: Tuplet | null, useFullMeasureRest = true): Rest[] {
    let l = l_
    let tick = tick_
    let measure: Measure | null = this.tick2measure(tick)
    const rests: Rest[] = []
    const staff = this.staff(Math.trunc(track / VOICES))!

    while (!l.isZero() && measure) {
        //
        // divide into measures
        //
        let f: Fraction
        if (tuplet) {
            f = tuplet.baseLen().fraction().times(new Fraction(tuplet.ratio().numerator(), 1))
            for (const de of tuplet.elements()) {
                if (de.tick().ge(tick)) {
                    break
                }
                f = f.minus(de.ticks())
            }
            //
            // restrict to tuplet len
            //
            if (f.lt(l)) {
                l = f
            }
        } else {
            if (measure.tick().lt(tick)) {
                f = measure.endTick().minus(tick)
            } else {
                f = measure.ticks()
            }
            f = f.times(staff.timeStretch(tick))
        }

        if (f.gt(l)) {
            f = l
        }

        // Don't fill a full measure with rests on a non-zero voice, *unless* it has links in voice zero
        const fullMeasure = tick.eq(measure.tick()) && f.eq(measure.stretchedLen(staff))
        const emptyNonZeroVoice = track2voice(track) !== 0 && !measure.hasVoice(track)
        if (emptyNonZeroVoice && fullMeasure && !staff.trackHasLinksInVoiceZero(track)) {
            l = l.minus(f)
            measure = measure.nextMeasure()
            if (!measure) {
                break
            }
            tick = measure.tick()
            continue
        }

        if (measure.timesig().eq(measure.ticks()) // not in pickup measure
            && fullMeasure
            && !tuplet
            && useFullMeasureRest) {
            const rest = this.addRest(tick, track, new TDuration(DurationType.V_MEASURE), tuplet)
            tick = tick.plus(rest.actualTicks())
            rests.push(rest)
        } else {
            //
            // compute list of durations which will fit l
            //
            let dList: TDuration[]
            if (tuplet || f.isZero()) {
                dList = toDurationList(l, useDots)
                dList.reverse()
            } else {
                const timeStretch = staff.timeStretch(tick)
                dList = toRhythmicDurationList(f, true, tick.minus(measure.tick()).times(timeStretch),
                    this.sigmap().timesig(tick).nominal(), measure, useDots ? 1 : 0, timeStretch)
            }
            if (dList.length === 0) {
                return rests
            }

            for (const d of dList) {
                const rest = this.addRest(tick, track, d, tuplet)
                // If we're filling an empty non-zero voice make these gaps
                rest.setGap(emptyNonZeroVoice && !fullMeasure)
                rests.push(rest)
                tick = tick.plus(rest.actualTicks())
            }
        }
        l = l.minus(f)

        measure = measure.nextMeasure()
        if (!measure) {
            break
        }
        tick = measure.tick()
    }
    return rests
}

/** addNote from NoteVal */
Score.prototype.addNote = function (this: Score, chord: Chord, noteVal: NoteVal, forceAccidental = false,
    articulationIds: ReadonlySet<SymId> = new Set(), externalInputState: InputState | null = null): Note {
    const is = externalInputState ?? this.inputState()

    const note = Factory.createItem(ElementType.NOTE, chord) as Note
    note.setParent(chord)
    note.setTrack(chord.track())
    note.setNval(noteVal)
    this.undoAddElement(note)
    if (forceAccidental) {
        const tpc = this.style().styleB(Sid.concertPitch) ? noteVal.tpc1 : noteVal.tpc2
        const alter = tpc2alter(tpc)
        const at = Accidental.value2subtype(alter)
        const a = Factory.createItem(ElementType.ACCIDENTAL, note) as Accidental
        a.setAccidentalType(at)
        a.setRole(AccidentalRole.USER)
        a.setParent(note)
        this.undoAddElement(a)
    }

    if (articulationIds.size) {
        chord.updateArticulations(articulationIds)
    }

    // TODO(port): setPlayNote(true), setPlayChord(true) (playback)

    if (externalInputState) {
        is.setTrack(note.track())
        is.setLastSegment(is.segment())
        is.setSegment(note.chord().segment())
    } else {
        this.select(note, SelectType.SINGLE, 0)
    }

    if (!chord.staff()!.isTabStaff(chord.tick())) {
        const entryMethod = is.noteEntryMethod()
        if (entryMethod !== NoteEntryMethod.REPITCH && entryMethod !== NoteEntryMethod.REALTIME_AUTO
            && entryMethod !== NoteEntryMethod.REALTIME_MANUAL) {
            is.moveToNextInputPos()
        }
    }
    return note
}

Score.prototype.addNoteToTiedChord = function (this: Score, chord: Chord, noteVal: NoteVal, forceAccidental = false,
    articulationIds: ReadonlySet<SymId> = new Set()): Note | null {
    if (chord.notes().length === 0) {
        return null
    }
    let referenceNote = chord.notes()[0]

    while (true) {
        // don't add note if it is already part of tied notes previously
        if (referenceNote.chord().findNote(noteVal.pitch)) {
            return null
        }
        if (!referenceNote.tieBack() || referenceNote.incomingPartialTie()) {
            break
        }
        referenceNote = referenceNote.tieBack()!.startNote()!
    }

    let tie: Tie | null = null
    let newNote: Note | null = null

    while (referenceNote.tieFor()) {
        chord = referenceNote.chord()
        newNote = this.addNote(chord, noteVal, forceAccidental, articulationIds)
        if (!newNote) {
            return null
        }
        if (tie) {
            tie.setEndNote(newNote)
            tie.setTick2(newNote.tick())
            newNote.setTieBack(tie)
            this.undoAddElement(tie)
        }

        tie = Factory.createItem(ElementType.TIE, newNote) as Tie
        tie.setStartNote(newNote)
        tie.setTick(newNote.tick())
        tie.setTrack(newNote.track())
        newNote.setTieFor(tie)

        if (!referenceNote.tieFor()!.endNote()) {
            break
        }

        referenceNote = referenceNote.tieFor()!.endNote()!
    }

    chord = referenceNote.chord()
    newNote = this.addNote(chord, noteVal, forceAccidental, articulationIds)

    if (!newNote) {
        return null
    }

    if (tie) {
        tie.setEndNote(newNote)
        tie.setTick2(newNote.tick())
        newNote.setTieBack(tie)
        this.undoAddElement(tie)
    }

    this.connectTies()

    return newNote
}

Score.prototype.searchNote = function (this: Score, tick: Fraction, track: track_idx_t): ChordRest | null {
    let ipe: ChordRest | null = null
    const st = SegmentType.ChordRest
    // C++ firstSegment(st)
    const fm = this.firstMeasure()
    let first = fm ? fm.first() : null
    if (first && !(first.segmentType() & st)) {
        first = first.next1(st)
    }
    for (let segment = first; segment; segment = segment.next1(st)) {
        const cr = segment.cr(track)
        if (!cr) {
            continue
        }
        if (cr.tick().eq(tick)) {
            return cr
        }
        if (cr.tick().gt(tick)) {
            return ipe ?? cr
        }
        ipe = cr
    }
    return null
}

/**
 * combine consecutive rests into fewer rests of longer duration, combine tied notes/chords into fewer notes of longer
 * duration. Only operates on one voice - protects manual layout adjustment, etc.
 * TODO(port): Score::regroupNotesAndRests (not ported yet)
 */
Score.prototype.regroupNotesAndRests = function (this: Score, _startTick: Fraction, _endTick: Fraction, _track: track_idx_t): void {
}

Score.prototype.cmdTieNoteList = function (this: Score, selection: Selection, noteEntryMode: boolean): Note[] {
    const el = selection.element()
    const n = InputState.note(el)
    if (n) {
        if (noteEntryMode) {
            return [...n.chord().notes()]
        } else {
            return [n]
        }
    } else {
        const cr = InputState.chordRest(el)
        if (cr && cr.isChord()) {
            return [...(cr as Chord).notes()]
        }
    }
    return selection.noteList()
}

function createAndAddTie(startNote: Note, endNote: Note | null): Tie | null {
    const score = startNote.score()
    const tie = Factory.createItem(endNote ? ElementType.TIE : ElementType.PARTIAL_TIE, startNote) as Tie
    tie.setStartNote(startNote)
    tie.setTrack(startNote.track())
    tie.setTick(startNote.chord().segment().tick())
    if (endNote) {
        if (endNote.tieBack()) {
            score.undoRemoveElement(endNote.tieBack())
        }
        tie.setEndNote(endNote)
        tie.setTicks(endNote.chord().segment().tick().minus(startNote.chord().segment().tick()))
    }
    score.undoAddElement(tie)

    // TODO(port): tie->addTiesToJumpPoints(); remove a partial tie without jump points (repeats)

    return tie
}

Score.prototype.cmdAddTie = function (this: Score, addToChord = false): void {
    const noteList = this.cmdTieNoteList(this.selection(), this.noteEntryMode())
    if (noteList.length === 0) {
        // C++: LOGD("no notes selected")
        return
    }

    noteList.sort((a, b) => a.track() - b.track())
    let track = noteList[0].track()

    const toSelect: EngravingItem[] = []

    this.startCmd(new TranslatableString('undoableAction', 'Add tie'))
    let lastAddedChord: Chord | null = null
    const is = this.inputState()

    for (let note of noteList) {
        if (note.tieFor()) {
            if (addToChord) {
                continue
            } else {
                this.undoRemoveElement(note.tieFor())
            }
        }

        let cr: ChordRest | null = null
        const c = note.chord()
        const staffMove = c.staffMove()

        // set cursor at position after note
        if (c.isGraceBefore()) {
            // tie grace note before to main note
            cr = c.explicitParent() as unknown as Chord
            addToChord = true
        } else {
            is.setTrack(note.chord().track())
            is.setSegment(note.chord().segment())
            is.moveToNextInputPos()
            is.setLastSegment(is.segment())

            if (!is.cr()) {
                this.expandVoice()
            }
            cr = is.cr()
        }
        if (!cr) {
            break
        }

        let addFlag = lastAddedChord !== null
        if (c.track() !== track) {
            addFlag = false
            track = c.track()
        }
        // try to re-use existing note or chord
        let n: Note | null = null
        if (addToChord && cr.isChord()) {
            const chord = cr as Chord
            const nn = chord.findNote(note.pitch())
            if (nn && nn.tpc() === note.tpc()) {
                n = nn // re-use note
            } else {
                addFlag = true // re-use chord
            }
        }

        // if no note to re-use, create one
        const nval = note.noteVal()
        if (!n) {
            n = this.addPitch(nval, addFlag)
            if (n && staffMove !== 0) {
                this.undo(new ChangeChordStaffMove(n.chord(), staffMove))
            }
        } else {
            this.select(n)
        }

        if (n) {
            if (!lastAddedChord) {
                lastAddedChord = n.chord()
            }
            // n is not necessarily next note if duration span over measure
            let nnote = searchTieNote(note)
            while (nnote) {
                // DEBUG: if duration spans over measure
                // this does not set line for intermediate notes
                // tpc was set correctly already
                createAndAddTie(note, nnote)

                if (!addFlag || nnote.chord().tick().ge(lastAddedChord.tick()) || nnote.chord().isGrace()) {
                    break
                } else {
                    note = nnote
                    is.setLastSegment(is.segment())
                    nnote = this.addPitch(nval, true)
                }
            }
            if (staffMove !== 0) {
                for (const tiedNote of n.tiedNotes()) {
                    this.undo(new ChangeChordStaffMove(tiedNote.chord(), staffMove))
                }
            }
        }
        if (n) {
            toSelect.push(n)
        }
    }
    if (lastAddedChord) {
        this.nextInputPos(lastAddedChord, false)
    }
    for (const e of toSelect) {
        if (this.canReselectItem(e)) {
            this.select(e, SelectType.ADD)
        }
    }
    this.endCmd()
}

Score.prototype.cmdToggleTie = function (this: Score): Tie | null {
    const noteList: (Note | null)[] = this.cmdTieNoteList(this.selection(), this.noteEntryMode())

    if (noteList.length === 0) {
        // C++: LOGD("no notes selected")
        return null
    }

    const tieNoteList: (Note | null)[] = new Array(noteList.length).fill(null)
    let singleTick = true
    let someHaveExistingNextNoteToTieTo = false
    let allHaveExistingNextNoteToTieTo = true
    for (let i = 0; i < noteList.length; ++i) {
        const n = noteList[i]!
        if (!n.chord().tick().eq(noteList[0]!.tick())) {
            singleTick = false
        }
        if (n.tieFor()) {
            tieNoteList[i] = null
        } else {
            const tieNote = searchTieNote(n)
            tieNoteList[i] = tieNote
            if (tieNote || n.chord().hasFollowingJumpItem()) {
                someHaveExistingNextNoteToTieTo = true
            } else {
                allHaveExistingNextNoteToTieTo = false
            }
        }
    }

    const shouldTieListSelection = noteList.length >= 2 && !singleTick

    if (singleTick /* i.e. all notes are in the same tick */ && !allHaveExistingNextNoteToTieTo) {
        this.cmdAddTie()
        return null
    }

    const actionName = someHaveExistingNextNoteToTieTo
        ? new TranslatableString('undoableAction', 'Add tie')
        : new TranslatableString('undoableAction', 'Remove tie')

    this.startCmd(actionName)

    let tie: Tie | null = null

    for (let i = 0; i < noteList.length; ++i) {
        const note = noteList[i]
        const tieToNote = tieNoteList[i]

        if (!note) {
            continue
        }

        // Tie to adjacent unselected note
        if (someHaveExistingNextNoteToTieTo && tieToNote) {
            const startNote = note.tick().le(tieToNote.tick()) ? note : tieToNote
            const endNote = startNote === tieToNote ? note : tieToNote
            tie = createAndAddTie(startNote, endNote)
            continue
        }

        const oldTie = note.tieFor()
        const chord = note.chord()
        if (oldTie) {
            // Toggle existing tie off
            // TODO(port): oldTie->undoRemoveTiesFromJumpPoints() (repeats)
            this.undoRemoveElement(oldTie)
            continue
        }

        if (chord.hasFollowingJumpItem()) {
            // Create partial tie
            tie = createAndAddTie(note, null)
            continue
        }

        if (!shouldTieListSelection || i > noteList.length - 2) {
            continue
        }

        // Tie to next appropriate note in selection
        let note2: Note | null = null

        for (let j = i + 1; j < noteList.length; ++j) {
            const candidateNote = noteList[j]
            if (!candidateNote) {
                continue
            }
            const samePart = note.part() === candidateNote.part()
            const samePitch = note.pitch() === candidateNote.pitch()
            const sameUnisonIdx = note.unisonIndex() === candidateNote.unisonIndex()
            const diffTick = !note.tick().eq(candidateNote.tick())
            if (samePart && samePitch && sameUnisonIdx && diffTick) {
                note2 = candidateNote
                noteList[j] = null
                break
            }
        }

        if (!note2) {
            continue
        }

        const startNote = note.tick().le(note2.tick()) ? note : note2
        const endNote = startNote === note2 ? note : note2

        tie = createAndAddTie(startNote, endNote)
    }

    this.endCmd()

    return tie
}

Score.prototype.cmdToggleLaissezVib = function (this: Score): void {
    const noteList = this.selection().noteList()

    if (noteList.length === 0) {
        // C++: LOGD("no notes selected")
        return
    }

    this.startCmd(new TranslatableString('undoableAction', 'Toggle laissez vibrer'))

    for (const note of noteList) {
        const lv = note.laissezVib()
        if (lv) {
            this.undoRemoveElement(lv)
        } else if (note.tieFor()) {
            continue
        } else {
            const lvTie = Factory.createItem(ElementType.LAISSEZ_VIB, note)!
            lvTie.setParent(note)
            this.undoAddElement(lvTie)
        }
    }

    this.endCmd()
}

Score.prototype.cmdFlip = function (this: Score): void {
    const el = [...this.selection().elements()]
    if (el.length === 0) {
        MScore.setError(MsError.NO_FLIPPABLE_SELECTED)
        return
    }

    const alreadyFlippedElements = new Set<EngravingItem>()
    const flipOnce = (element: EngravingItem, flipFunction: () => void): void => {
        if (!alreadyFlippedElements.has(element)) {
            alreadyFlippedElements.add(element)
            flipFunction()
        }
    }

    for (let e of el) {
        if (e.hasVoiceAssignmentProperties()) {
            const item = e
            flipOnce(item, () => {
                const curPlacement = item.getProperty(Pid.PLACEMENT) as PlacementV
                item.undoChangeProperty(Pid.DIRECTION, curPlacement === PlacementV.ABOVE ? DirectionV.DOWN : DirectionV.UP)
            })
        } else if (e.isNote() || e.isStem() || e.isHook()) {
            const chord = (e as unknown as { chord(): Chord }).chord()
            if (!chord) {
                continue
            }

            if (chord.beam()) {
                if (!this.selection().isRange()) {
                    e = chord.beam()!
                } else {
                    continue
                }
            } else if (chord.tremoloTwoChord()) {
                if (!this.selection().isRange()) {
                    e = chord.tremoloTwoChord()!
                } else {
                    continue
                }
            } else {
                flipOnce(chord, () => {
                    const dir = chord.up() ? DirectionV.DOWN : DirectionV.UP
                    chord.undoChangeProperty(Pid.STEM_DIRECTION, dir)
                })
            }
        }

        if (e.isBeam()) {
            const beam = e as unknown as Beam
            flipOnce(beam, () => {
                if (beam.cross()) {
                    const newCrossStaffMove = beam.crossStaffMove() + 1
                    if (beam.acceptCrossStaffMove(newCrossStaffMove)) {
                        beam.undoChangeProperty(Pid.BEAM_CROSS_STAFF_MOVE, newCrossStaffMove)
                    } else {
                        beam.undoChangeProperty(Pid.BEAM_CROSS_STAFF_MOVE, beam.minCRMove() - beam.defaultCrossStaffIdx())
                    }
                } else {
                    const dir = beam.up() ? DirectionV.DOWN : DirectionV.UP
                    beam.undoChangeProperty(Pid.STEM_DIRECTION, dir)
                }
            })
        } else if (e.isType(ElementType.TREMOLO_TWOCHORD)) {
            const tremolo = e as unknown as TremoloTwoChord
            flipOnce(tremolo, () => {
                const dir = tremolo.up() ? DirectionV.DOWN : DirectionV.UP
                tremolo.undoChangeProperty(Pid.STEM_DIRECTION, dir)
            })
        } else if (e.isSlurTieSegment()) {
            const slurTie = (e as unknown as SlurTieSegment).slurTie()
            flipOnce(slurTie, () => {
                const dir = slurTie.up() ? DirectionV.DOWN : DirectionV.UP
                slurTie.undoChangeProperty(Pid.SLUR_DIRECTION, dir)
            })
        } else if (e.isArticulationFamily()) {
            const artic = e as unknown as Articulation
            flipOnce(artic, () => {
                let articAnchor = artic.anchor()
                switch (articAnchor) {
                case ArticulationAnchor.TOP:
                    articAnchor = ArticulationAnchor.BOTTOM
                    break
                case ArticulationAnchor.BOTTOM:
                    articAnchor = ArticulationAnchor.TOP
                    break
                case ArticulationAnchor.AUTO:
                    articAnchor = artic.up() ? ArticulationAnchor.BOTTOM : ArticulationAnchor.TOP
                    break
                }
                let pf = artic.propertyFlags(Pid.ARTICULATION_ANCHOR)
                if (pf === PropertyFlags.STYLED) {
                    pf = PropertyFlags.UNSTYLED
                }
                artic.undoChangeProperty(Pid.ARTICULATION_ANCHOR, articAnchor, pf)
            })
        } else if (e.isTuplet()) {
            const tuplet = e as unknown as Tuplet
            flipOnce(tuplet, () => {
                const dir = tuplet.isUp() ? DirectionV.DOWN : DirectionV.UP
                tuplet.undoChangeProperty(Pid.DIRECTION, dir, PropertyFlags.UNSTYLED)
            })
        } else if (e.isNoteDot() && e.explicitParent()!.isNote()) {
            const note = e.explicitParent() as unknown as Note
            const d = note.dotIsUp() ? DirectionV.DOWN : DirectionV.UP
            note.undoChangeProperty(Pid.DOT_POSITION, d)
        } else if (e.isChordBracket()) {
            const cb = e as unknown as ChordBracket
            flipOnce(cb, () => {
                const d = cb.hookPos() === DirectionV.UP ? DirectionV.DOWN : DirectionV.UP
                cb.undoChangeProperty(Pid.BRACKET_HOOK_POS, d)
            })
        } else if (e.isGuitarBendSegment()) {
            const bend = (e as unknown as SpannerSegment).spanner()!
            flipOnce(bend, () => {
                const direction = (bend.ldata() as unknown as { up?: boolean }).up ? DirectionV.DOWN : DirectionV.UP
                bend.undoChangeProperty(Pid.DIRECTION, direction)
            })
        } else if (e.isTrillSegment()) {
            const ornament = (e as unknown as TrillSegment).trill().ornament()
            if (!ornament) {
                continue
            }

            flipOnce(ornament, () => {
                let articAnchor = ornament.getProperty(Pid.ARTICULATION_ANCHOR) as ArticulationAnchor

                switch (articAnchor) {
                case ArticulationAnchor.TOP:
                    articAnchor = ArticulationAnchor.BOTTOM
                    break
                case ArticulationAnchor.BOTTOM:
                    articAnchor = ArticulationAnchor.TOP
                    break
                case ArticulationAnchor.AUTO:
                    articAnchor = ornament.up() ? ArticulationAnchor.BOTTOM : ArticulationAnchor.TOP
                    break
                }
                let pf = ornament.propertyFlags(Pid.ARTICULATION_ANCHOR)
                if (pf === PropertyFlags.STYLED) {
                    pf = PropertyFlags.UNSTYLED
                }
                ornament.undoChangeProperty(Pid.ARTICULATION_ANCHOR, articAnchor, pf)
            })
        } else if (e.isStaffText()
                   || e.isSystemText()
                   || e.isTempoText()
                   || e.isTripletFeel()
                   || e.isJump()
                   || e.isMarker()
                   || e.isRehearsalMark()
                   || e.isMeasureNumber()
                   || e.isInstrumentChange()
                   || e.isPlayTechAnnotation()
                   || e.isCapo()
                   || e.isStringTunings()
                   || e.isSticking()
                   || e.isFingering()
                   || e.isHarmony()
                   || e.isFretDiagram()
                   || e.isHarpPedalDiagram()
                   || e.isOttava()
                   || e.isOttavaSegment()
                   || e.isTextLine()
                   || e.isTextLineSegment()
                   || e.isLetRing()
                   || e.isLetRingSegment()
                   || e.isVibrato()
                   || e.isVibratoSegment()
                   || e.isPalmMute()
                   || e.isPalmMuteSegment()
                   || e.isWhammyBar()
                   || e.isWhammyBarSegment()
                   || e.isRasgueado()
                   || e.isRasgueadoSegment()
                   || e.isHarmonicMark()
                   || e.isHarmonicMarkSegment()
                   || e.isGradualTempoChange()
                   || e.isGradualTempoChangeSegment()
                   || e.isPedal()
                   || e.isPedalSegment()
                   || e.isLyrics()
                   || e.isBreath()
                   || e.isFermata()
                   || e.isHammerOnPullOffText()) {
            e.undoChangeProperty(Pid.AUTOPLACE, true)
            // TODO: undoChangeProperty() should probably do this directly
            // see https://musescore.org/en/node/281432
            const ee = (e.propertyDelegate(Pid.PLACEMENT) as EngravingItem | null) ?? e

            flipOnce(ee, () => {
                // getProperty() delegates call from spannerSegment to Spanner
                let p = ee.getProperty(Pid.PLACEMENT) as PlacementV
                p = (p === PlacementV.ABOVE) ? PlacementV.BELOW : PlacementV.ABOVE
                let pf = ee.propertyFlags(Pid.PLACEMENT)
                if (pf === PropertyFlags.STYLED) {
                    pf = PropertyFlags.UNSTYLED
                }
                const oldDefaultY = (ee.propertyDefault(Pid.OFFSET) as PointF).y()
                ee.undoChangeProperty(Pid.PLACEMENT, p, pf)
                // flip and rebase user offset to new default now that placement has changed
                const newDefaultY = (ee.propertyDefault(Pid.OFFSET) as PointF).y()
                if (ee.isSpanner()) {
                    const spanner = ee as unknown as Spanner
                    for (const ss of spanner.spannerSegments()) {
                        if (!ss.isStyled(Pid.OFFSET)) {
                            const off = (ss.getProperty(Pid.OFFSET) as PointF).clone()
                            const oldY = off.y() - oldDefaultY
                            off.setY(newDefaultY - oldY)
                            ss.undoChangeProperty(Pid.OFFSET, off)
                            ss.setOffsetChanged(false)
                        }
                    }
                } else if (!ee.isStyled(Pid.OFFSET)) {
                    const off = (ee.getProperty(Pid.OFFSET) as PointF).clone()
                    const oldY = off.y() - oldDefaultY
                    off.setY(newDefaultY - oldY)
                    ee.undoChangeProperty(Pid.OFFSET, off)
                    ee.setOffsetChanged(false)
                }
            })
        }
    }
}

Score.prototype.deleteItem = function (this: Score, el: EngravingItem | null): void {
    if (!el) {
        return
    }

    if (el.generated()) {
        switch (el.type()) {
        // These types can be removed, even if generated
        case ElementType.BAR_LINE:
        case ElementType.BRACKET:
        case ElementType.CLEF:
        case ElementType.INSTRUMENT_NAME:
        case ElementType.KEYSIG:
        case ElementType.MEASURE_NUMBER:
        case ElementType.SYSTEM_LOCK_INDICATOR:
        case ElementType.HAMMER_ON_PULL_OFF_TEXT:
        case ElementType.PLAY_COUNT_TEXT:
        case ElementType.LYRICSLINE_SEGMENT:
            break
        // All other types cannot be removed if generated
        default:
            return
        }
    }

    let type = el.type()
    if (type === ElementType.NOTE) {
        const chord = el.explicitParent() as unknown as Chord
        if (chord.notes().length > 1) {
            this.undoRemoveElement(el)
            this.select(chord.downNote(), SelectType.SINGLE, 0)
            return
        }
        // else fall through
        el = chord
        type = ElementType.CHORD
    }

    switch (type) {
    case ElementType.INSTRUMENT_NAME:
        // TODO(port): ChangeInstrumentLong / ChangeInstrumentShort
        break

    case ElementType.TIMESIG:
        // TODO(port): cmdRemoveTimeSig (needs rewriteMeasures)
        break

    case ElementType.KEYSIG: {
        let k: KeySig | null = el as unknown as KeySig
        let m = k.measure()!
        if (m.isMMRest()) {
            m = m.mmRestFirst()!
            const s = m.findSegment(SegmentType.KeySig, k.tick())
            if (s) {
                k = s.element(k.track()) as unknown as KeySig | null
            }
            if (!k || k.generated()) {
                return
            }
        }
        const nextCrSeg = k.segment()!.next1(SegmentType.ChordRest)
        const ic = !!nextCrSeg && !!nextCrSeg.findAnnotation(ElementType.INSTRUMENT_CHANGE,
            el.part()!.startTrack(), el.part()!.endTrack() - 1)
        this.undoRemoveElement(k)
        if (ic) {
            const ke = k.keySigEvent().clone()
            ke.setForInstrumentChange(true)
            const cKey = k.staff()!.keySigEvent(k.tick()).concertKey()
            let tKey = cKey
            if (!this.style().styleB(Sid.concertPitch)) {
                const v = k.part()!.instrument(k.tick()).transpose().clone()
                v.flip()
                tKey = Transpose.transposeKey(cKey, v, k.part()!.preferSharpFlat())
            }
            ke.setConcertKey(cKey)
            ke.setKey(tKey)
            this.undoChangeKeySig(k.staff()!, k.tick(), ke)
        }
        for (let i = 0; i < k.part()!.nstaves(); i++) {
            const staff = k.part()!.staff(i)!
            const e = staff.keySigEvent(k.tick()).clone()
            this.updateInstrumentChangeTranspositions(e, staff, k.tick())
        }
        break
    }

    case ElementType.CHORD: {
        const chord = el as unknown as Chord
        this.removeChordRest(chord, false)

        // replace with rest
        if (chord.noteType() === NoteType.NORMAL) {
            const rest = Factory.createItem(ElementType.REST, scoreDummy(this).segment()) as Rest
            rest.setDurationType(chord.durationType())
            rest.setTicks(chord.ticks())

            rest.setTrack(el.track())
            rest.setParent(chord.explicitParent())

            const segment = chord.segment()
            this.undoAddCR(rest, segment.measure(), segment.tick())

            const tuplet = chord.tuplet()
            if (tuplet) {
                const tl = tuplet.linkList()
                for (const e of rest.linkList()) {
                    const de = e as unknown as DurationElement
                    for (const ee of tl) {
                        const t = ee as unknown as Tuplet
                        if (t.score() === de.score() && t.track() === de.track()) {
                            de.setTuplet(t)
                            t.add(de as unknown as EngravingItem)
                            break
                        }
                    }
                }
            }
            //select(rest, SelectType::SINGLE, 0);
        } else {
            // remove segment if empty
            const seg = chord.segment()
            if (seg.empty()) {
                this.undoRemoveElement(seg)
            }
        }
        break
    }

    case ElementType.MEASURE_REPEAT:
        // TODO(port): measure repeats (undoChangeMeasureRepeatCount, undoSetNoBreak)
        break

    case ElementType.MMREST:
    case ElementType.REST: {
        //
        // only allow for voices != 0
        //    e.g. voice 0 rests cannot be removed
        //
        const rest = el as unknown as Rest
        if (rest.tuplet() && rest.tuplet()!.elements().length === 0) {
            this.undoRemoveElement(rest.tuplet())
        }
        if ((el.voice() !== 0) && !rest.tuplet()) {
            rest.undoChangeProperty(Pid.GAP, true)
            rest.undoChangeProperty(Pid.BEAM_MODE, BeamMode.AUTO)
            for (const r of el.linkList()) {
                const rr = r as unknown as Rest
                if (rr.track() % VOICES) {
                    rr.undoChangeProperty(Pid.GAP, true)
                }
            }

            // delete them really when only gap rests are in the actual measure.
            const m = rest.measure()
            const track = el.track()
            if (m.isOnlyDeletedRests(track) && !el.staff()!.trackHasLinksInVoiceZero(track)) {
                const st = SegmentType.ChordRest
                for (let s = m.first(st); s; s = s.next(st)) {
                    const del = s.element(track)
                    if (s.segmentType() !== st || !del) {
                        continue
                    }
                    if ((del as unknown as Rest).isGap()) {
                        this.undoRemoveElement(del)
                    }
                }
                this.checkSpanner(m.tick(), m.endTick())
            } else {
                // check if the other rest could be combined
                const s = rest.segment()

                const rests: Rest[] = []
                // find previous segment with cr in this track
                let pe: EngravingItem | null = null
                for (let ps = s.prev(SegmentType.ChordRest); ps; ps = ps.prev(SegmentType.ChordRest)) {
                    const elm = ps.element(track)
                    if (elm && elm.isRest() && (elm as unknown as Rest).isGap()) {
                        pe = el
                        rests.push(elm as unknown as Rest)
                    } else if (elm) {
                        break
                    }
                }
                // find next segment with cr in this track
                let ns: Segment | null
                let ne: EngravingItem | null = null
                for (ns = s.next(SegmentType.ChordRest); ns; ns = ns.next(SegmentType.ChordRest)) {
                    const elm = ns.element(track)
                    if (elm && elm.isRest() && (elm as unknown as Rest).isGap()) {
                        ne = elm
                        rests.push(elm as unknown as Rest)
                    } else if (elm) {
                        break
                    }
                }

                const stick = pe ? pe.tick() : s.tick()
                let ticks: Fraction

                if (ne) {
                    ticks = ne.tick().minus(stick).plus((ne as unknown as Rest).actualTicks())
                } else if (ns) {
                    ticks = ns.tick().minus(stick)
                } else {
                    ticks = m.endTick().minus(stick)
                }

                if (!ticks.eq(m.ticks()) && !ticks.eq(s.ticks())) {
                    this.undoRemoveElement(rest)
                    for (const r of rests) {
                        this.undoRemoveElement(r)
                    }

                    const f = ticks.times(el.staff()!.timeStretch(el.tick()))

                    const dList = toDurationList(f, true)
                    if (dList.length === 0) {
                        break
                    }

                    let curTick = stick
                    for (const d of dList) {
                        const rr = Factory.createItem(ElementType.REST, scoreDummy(this).segment()) as Rest
                        rr.setTicks(d.fraction())
                        rr.setDurationType(d)
                        rr.setTrack(track)
                        rr.setGap(true)
                        this.undoAddCR(rr, m, curTick)
                        curTick = curTick.plus(rr.actualTicks())
                    }
                }
            }
            // Set input position
            // TODO If deleted element is last of a sequence, use prev?
            if (this.noteEntryMode()) {
                this.move('prev-chord')
            }
        }
        break
    }

    case ElementType.ACCIDENTAL:
        if (el.explicitParent()!.isNote()) {
            this.changeNoteAccidental(el.explicitParent() as unknown as Note, AccidentalType.NONE)
        } else {
            this.undoRemoveElement(el)
        }
        break

    case ElementType.BAR_LINE: {
        const bl = el as unknown as BarLine
        const s = bl.segment()!
        const m = s.measure()
        if (s.isBeginBarLineType() || s.isBarLineType()) {
            this.undoRemoveElement(el)
        } else {
            if (bl.barLineType() === BarLineType.START_REPEAT) {
                const m2 = m.isMMRest() ? m.mmRestFirst()! : m
                for (const lscore of this.scoreList()) {
                    const lmeasure = lscore.tick2measure(m2.tick())
                    if (lmeasure) {
                        lmeasure.undoChangeProperty(Pid.REPEAT_START, false)
                        lmeasure.undoChangeProperty(Pid.REPEAT_COUNT, 2)
                    }
                }
                if (!bl.generated()) {
                    this.undoRemoveElement(el)
                }
            } else if (bl.barLineType() === BarLineType.END_REPEAT) {
                const m2 = m.isMMRest() ? m.mmRestLast()! : m
                for (const lscore of this.scoreList()) {
                    const lmeasure = lscore.tick2measure(m2.tick())
                    if (lmeasure) {
                        lmeasure.undoChangeProperty(Pid.REPEAT_END, false)
                        lmeasure.undoChangeProperty(Pid.REPEAT_COUNT, 2)
                    }
                }
                if (!bl.generated()) {
                    this.undoRemoveElement(el)
                }
            } else {
                bl.undoChangeProperty(Pid.BARLINE_TYPE, BarLineType.NORMAL)
            }
        }
        break
    }

    case ElementType.TUPLET:
        this.cmdDeleteTuplet(el as unknown as Tuplet, true)
        break

    case ElementType.MEASURE: {
        const m = el as unknown as Measure
        this.undoRemoveMeasures(m, m)
        this.undoInsertTime(m.tick(), m.endTick().minus(m.tick()).neg())
        break
    }

    case ElementType.BRACKET:
        // TODO(port): undoRemoveBracket
        break

    case ElementType.LAYOUT_BREAK: {
        this.undoRemoveElement(el)
        const lb = el as unknown as LayoutBreak
        const mb = lb.measure()
        let m = mb && mb.isMeasure() ? mb as Measure : null
        if (m && m.isMMRest()) {
            // propagate to original measure
            m = m.mmRestLast()!
            for (const e of m.el()) {
                if (e.isLayoutBreak() && (e as unknown as LayoutBreak).layoutBreakType() === lb.layoutBreakType()) {
                    this.undoRemoveElement(e)
                    break
                }
            }
        }
        break
    }

    case ElementType.CLEF: {
        let clef = el as unknown as Clef
        let m = clef.measure()!
        if (m.isMMRest()) {
            // propagate to original measure
            m = m.mmRestLast()!
            const s = m.findSegment(SegmentType.Clef, clef.segment()!.tick())
            if (s && s.element(clef.track())) {
                const c = s.element(clef.track())!
                this.undoRemoveElement(c)
            }
        } else {
            if (clef.generated()) {
                // find the real clef if this is a cautionary one
                if (m && m.prevMeasure()) {
                    const tick = m.tick()
                    m = m.prevMeasure()!
                    const s = m.findSegment(SegmentType.Clef, tick)
                    if (s && s.element(clef.track())) {
                        clef = s.element(clef.track()) as unknown as Clef
                    }
                }
            }
            this.undoRemoveElement(clef)
        }
        break
    }

    case ElementType.MEASURE_NUMBER: {
        const mea = el.explicitParent() as unknown as Measure
        switch (mea.measureNumberMode()) {
        // If the user tries to remove an automatically generated measure number,
        // we should force the measure not to show any measure number
        case MeasureNumberMode.AUTO:
            mea.undoChangeProperty(Pid.MEASURE_NUMBER_MODE, MeasureNumberMode.HIDE)
            break

        // If the user tries to remove a measure number that he added manually,
        // then we should set the MeasureNumberMode to AUTO only if will not show if set to auto.
        // If after setting the MeasureNumberMode to AUTO, the measure number still shows,
        // We need to force the measure to hide its measure number.
        case MeasureNumberMode.SHOW:
            if (mea.showMeasureNumberInAutoMode()) {
                mea.undoChangeProperty(Pid.MEASURE_NUMBER_MODE, MeasureNumberMode.HIDE)
            } else {
                mea.undoChangeProperty(Pid.MEASURE_NUMBER_MODE, MeasureNumberMode.AUTO)
            }
            break
        case MeasureNumberMode.HIDE:
            break
        }
        break
    }

    case ElementType.REHEARSAL_MARK:
    case ElementType.TEMPO_TEXT: {
        const s = el.explicitParent() as unknown as Segment
        let m = s.measure()
        if (m.isMMRest()) {
            // propagate to original measure/element
            m = m.mmRestFirst()!
            const ns = m.findSegment(SegmentType.ChordRest, s.tick())
            const annotations = ns ? [...ns.annotations()] : [] // make a copy since we alter the list
            for (const e of annotations) {
                if (e.type() === el.type() && e.track() === el.track()) {
                    this.undoRemoveElement(e)
                    break
                }
            }
        } else {
            this.undoRemoveElement(el)
        }
        break
    }

    case ElementType.LYRICSLINE_SEGMENT:
        // TODO(port): lyrics lines (LyricsLine::lyrics, LYRIC_TICKS, SYLLABIC)
        this.undoRemoveElement((el as unknown as SpannerSegment).spanner())
        break

    case ElementType.OTTAVA_SEGMENT:
    case ElementType.HAIRPIN_SEGMENT:
    case ElementType.TRILL_SEGMENT:
    case ElementType.VIBRATO_SEGMENT:
    case ElementType.TEXTLINE_SEGMENT:
    case ElementType.VOLTA_SEGMENT:
    case ElementType.SLUR_SEGMENT:
    case ElementType.TIE_SEGMENT:
    case ElementType.LAISSEZ_VIB_SEGMENT:
    case ElementType.PARTIAL_TIE_SEGMENT:
    case ElementType.PARTIAL_LYRICSLINE_SEGMENT:
    case ElementType.PEDAL_SEGMENT:
    case ElementType.GLISSANDO_SEGMENT:
    case ElementType.NOTELINE_SEGMENT:
    case ElementType.LET_RING_SEGMENT:
    case ElementType.GRADUAL_TEMPO_CHANGE_SEGMENT:
    case ElementType.PALM_MUTE_SEGMENT:
    case ElementType.WHAMMY_BAR_SEGMENT:
    case ElementType.RASGUEADO_SEGMENT:
    case ElementType.HARMONIC_MARK_SEGMENT:
    case ElementType.PICK_SCRAPE_SEGMENT:
    case ElementType.GUITAR_BEND_SEGMENT:
    case ElementType.HAMMER_ON_PULL_OFF_SEGMENT: {
        const sp = (el as unknown as SpannerSegment).spanner()!
        // TODO(port): tie jump points (undoRemoveTiesFromJumpPoints, updateStartTieOnRemoval)
        this.undoRemoveElement(sp)
        // TODO(port): guitar bends (PRE_BEND/PRE_DIVE: delete the start note)
        break
    }

    case ElementType.TAPPING_HALF_SLUR_SEGMENT: {
        const halfSlur = (el as unknown as SpannerSegment).spanner()!
        const tapping = halfSlur.parent() as unknown as EngravingItem
        this.undoRemoveElement(tapping)
        break
    }

    case ElementType.HAMMER_ON_PULL_OFF_TEXT:
        // TODO(port): hammer-on/pull-off texts (undoRemoveHopoText)
        break

    case ElementType.STEM_SLASH: // cannot delete this elements
    case ElementType.HOOK:
    case ElementType.GUITAR_BEND_TEXT:
    case ElementType.GUITAR_BEND_HOLD_SEGMENT:
        // C++: LOGD("cannot remove %s", el->typeName())
        break

    case ElementType.TEXT:
        if ((el.explicitParent() && el.explicitParent()!.isTBox()) || el.isTBox()) {
            el.undoChangeProperty(Pid.TEXT, '')
        } else {
            this.undoRemoveElement(el)
        }
        break

    case ElementType.PLAY_COUNT_TEXT:
        // TODO(port): PlayCountText (barline()->undoChangeProperty(Pid::PLAY_COUNT_TEXT_SETTING, HIDE))
        break

    case ElementType.INSTRUMENT_CHANGE: {
        const ic = el as unknown as InstrumentChange
        const tickStart = ic.segment().tick()
        const part = ic.part()!
        const oldV = part.staff(0)!.transpose(tickStart).clone()
        this.undoRemoveElement(el)
        if (!tickStart.isZero()) {
            for (const keySig of ic.keySigs()) {
                this.deleteItem(keySig)
            }
        }
        for (const clef of ic.clefs()) {
            this.deleteItem(clef)
        }
        if (!part.staff(0)!.transpose(tickStart).equals(oldV)) {
            const i = part.instruments().upperBound(tickStart.ticks())
            const tickEnd = i === part.instruments().size() ? new Fraction(-1, 1) : Fraction.fromTicks(part.instruments().keyAt(i))
            Transpose.transpositionChanged(this, part, oldV, tickStart, tickEnd)
        }
        break
    }

    case ElementType.MARKER: {
        const m = el.explicitParent() as unknown as Measure
        if (m.isMMRest()) {
            // find corresponding marker in underlying measure
            let found = false
            // the marker may be in the first measure...
            for (const e of m.mmRestFirst()!.el()) {
                if (e.isMarker() && e.subtype() === el.subtype()) {
                    this.undoRemoveElement(e)
                    found = true
                    break
                }
            }
            if (!found) {
                // ...or it may be in the last measure
                for (const e of m.mmRestLast()!.el()) {
                    if (e.isMarker() && e.subtype() === el.subtype()) {
                        this.undoRemoveElement(e)
                        break
                    }
                }
            }
        }
        // whether m is an mmrest or not, we still need to remove el
        this.undoRemoveElement(el)
        break
    }

    case ElementType.JUMP: {
        const m = el.explicitParent() as unknown as Measure
        if (m.isMMRest()) {
            // find corresponding jump in underlying measure
            for (const e of m.mmRestLast()!.el()) {
                if (e.isJump() && e.subtype() === el.subtype()) {
                    this.undoRemoveElement(e)
                    break
                }
            }
        }
        // whether m is an mmrest or not, we still need to remove el
        this.undoRemoveElement(el)
        break
    }

    case ElementType.SYSTEM_LOCK_INDICATOR: {
        const systemLock = (el as SystemLockIndicator).systemLock()
        EditSystemLocks.undoRemoveSystemLock(this, systemLock)
        break
    }

    case ElementType.PARENTHESIS:
        if (el.parent() && el.parent()!.isChord()) {
            // TODO(port): EditChord::removeChordParentheses (parentheses of a note group)
            break
        }
        this.undoRemoveElement(el)
        break

    default:
        this.undoRemoveElement(el)
        break
    }
}

Score.prototype.deleteOrShortenOutSpannersFromRange = function (this: Score, t1: Fraction, t2: Fraction, track1: track_idx_t,
    track2: track_idx_t, filter: SelectionFilter): void {
    const SPANNER_TYPES_TO_SHORTEN_OUT = new Set([
        ElementType.HAIRPIN,
        ElementType.OTTAVA,
        ElementType.TRILL,
        ElementType.VIBRATO,
    ])

    // undoRemoveElement and undoChangeProperty also handle linked elements, so we need
    // to make sure each linked group is handled only once if multiple elements per linked
    // group are found in the range, for example in the case of linked staves.
    const handledMainElements = new Set<EngravingObject>()

    for (const sp of this.spannerMap().findOverlapping(t1.ticks(), t2.ticks() - 1)) {
        const spStartTick = sp.tick()
        const spEndTick = sp.tick2()
        const trackValid = sp.track() >= track1 && sp.track() < track2
        if (!trackValid || sp.isVolta() || sp.systemFlag()) {
            continue
        }

        const links = sp.links()
        if (links) {
            if (handledMainElements.has(links[0])) {
                // already handled this linked group
                continue
            }
            handledMainElements.add(links[0])
        }

        // Special handling for grace notes...
        const startChord = sp.startChord()
        const startChordIsSelectableGrace = !!startChord && startChord.isGrace() && filter.canSelect(startChord)

        const endChord = sp.endChord()
        const endChordIsSelectableGrace = !!endChord && endChord.isGrace() && filter.canSelect(endChord)

        if (startChordIsSelectableGrace || endChordIsSelectableGrace) {
            this.undoRemoveElement(sp)
            continue
        }

        if (!filter.canSelectVoice(sp.track()) || !filter.canSelect(sp)) {
            continue
        }
        if (spStartTick.ge(t1) && spStartTick.lt(t2)
            && spEndTick.gt(t1) && spEndTick.le(t2)) {
            this.undoRemoveElement(sp)
        } else if (sp.isSlur() && ((spStartTick.ge(t1) && spStartTick.lt(t2))
                                   || (spEndTick.ge(t1) && spEndTick.lt(t2)))) {
            this.undoRemoveElement(sp)
        } else if (SPANNER_TYPES_TO_SHORTEN_OUT.has(sp.type())) {
            const moveStart = spStartTick.ge(t1) && spStartTick.lt(t2)
            const moveEnd = spEndTick.gt(t1) && spEndTick.le(t2)
            if (moveStart) {
                const tickDiff = t2.minus(spStartTick)
                sp.undoChangeProperty(Pid.SPANNER_TICK, t2)
                sp.undoChangeProperty(Pid.SPANNER_TICKS, sp.ticks().minus(tickDiff))
            } else if (moveEnd) {
                const tickDiff = spEndTick.minus(t1)
                sp.undoChangeProperty(Pid.SPANNER_TICKS, sp.ticks().minus(tickDiff))
            }
        }
    }
}

Score.prototype.deleteSlursFromRange = function (this: Score, t1: Fraction, t2: Fraction, trackStart: track_idx_t,
    trackEnd: track_idx_t, filter: SelectionFilter): void {
    for (const sp of this.spannerMap().findOverlapping(t1.ticks(), t2.ticks() - 1)) {
        const spStartTick = sp.tick()
        const spEndTick = sp.tick2()
        if (!sp.isSlur()) {
            continue
        }
        if (!filter.canSelectVoice(sp.track()) || !filter.canSelect(sp)) {
            continue
        }

        if (sp.track() >= trackStart && sp.track() < trackEnd) {
            if ((spStartTick.ge(t1) && spStartTick.lt(t2))
                || (spEndTick.ge(t1) && spEndTick.lt(t2))) {
                this.undoRemoveElement(sp)
            }
        }
    }
}

/** Deletes annotations in the given range that match the given selection filter. */
Score.prototype.deleteAnnotationsFromRange = function (this: Score, s1: Segment | null, s2: Segment | null, track1: track_idx_t,
    track2: track_idx_t, filter: SelectionFilter): void {
    if (!s1) {
        return
    }
    if (s2 && s2.tick().lt(s1.tick())) {
        return
    }

    for (let track = track1; track < track2; ++track) {
        if (!filter.canSelectVoice(track)) {
            continue
        }
        for (let s: Segment | null = s1; s && s !== s2; s = s.next1()) {
            const annotations = [...s.annotations()] // make a copy since we alter the list
            for (const annotation of annotations) {
                // skip if not included in selection (eg, filter)
                if (!filter.canSelect(annotation)) {
                    continue
                }
                if (!annotation.systemFlag() && annotation.track() === track) {
                    this.deleteItem(annotation)
                }
            }
        }
    }
}

Score.prototype.deleteRangeAtTrack = function (this: Score, crsToSelect: ChordRest[], track: track_idx_t, startSeg: Segment | null,
    endTick: Fraction, currentTuplet: Tuplet | null, filter: SelectionFilter, selectionContainsMultiNoteChords: boolean): void {
    while (startSeg && !(startSeg.isChordRestType() && startSeg.cr(track))) {
        // Range should always start at a ChordRest segment - find the next one for this track...
        startSeg = startSeg.next1(SegmentType.ChordRest)
    }

    if (!startSeg) {
        return
    }

    let restStartTick = startSeg.tick()
    let restDuration = new Fraction(0, 1)

    // When we find a deselected DurationElement - write rests up to the start of the deselected element (using the existing values for
    // restStartTick and restDuration), skip the deselected element (move restStartTick forward), and reset restDuration...
    const foundDeselected = (deselectedElement: DurationElement): void => {
        const rests = this.setRests(restStartTick, track, restDuration, /*useDots*/ !currentTuplet, currentTuplet)
        crsToSelect.push(...rests)
        restStartTick = deselectedElement.endTick()
        restDuration = new Fraction(0, 1)
    }

    for (let s: Segment | null = startSeg; s && s.tick().lt(endTick); s = s.next1()) {
        const e = s.element(track)
        if (!e) {
            continue
        }

        if (s.isBreathType()) {
            this.deleteItem(e)
            continue
        }

        if (!s.isChordRestType()) {
            // do not delete TimeSig/KeySig, it doesn't make sense to do it (except on full system)
            if (!s.isTimeTickType() && !s.isTimeSigType() && !s.isKeySigType()
                && !s.isSegType(SegmentType.BarLineType) /*covers all barLine types*/) {
                this.undoRemoveElement(e)
            }
            continue
        }

        if (e.isMeasureRepeat()) {
            // MeasureRepeat has its own special handling, so it is skipped here
            foundDeselected(e as unknown as DurationElement)
            this.deleteItem(e)
            continue
        }

        const cr1 = e as unknown as ChordRest

        // currentTuplet refers to the tuplet that we're currently performing a delete range "inside". It is possible that currentTuplet contains nested
        // tuplets, in which case we should find the "top-most nested tuplet" (nextTuplet) and:
        //      1. If it is selectable, delete it completely using cmdDeleteTuplet (deletes all elements contained in that tuplet)
        //      2. If it is not selectable, call this method recursively "inside" that tuplet (nextTuplet becomes currentTuplet for the recursive call)

        let nextTuplet: Tuplet | null = null
        if (cr1.tuplet() && cr1.tuplet() !== currentTuplet) {
            nextTuplet = cr1.tuplet()
            while (nextTuplet!.tuplet() && nextTuplet!.tuplet() !== currentTuplet) {
                nextTuplet = nextTuplet!.tuplet()
            }
        }

        if (nextTuplet) {
            // The range of nextTuplet will be handled by cmdDeleteTuplet or the recursive call - skip it at this level of recursion...
            let lastInTuplet = nextTuplet.elements()[nextTuplet.elements().length - 1]
            while (lastInTuplet.isTuplet()) {
                const els = (lastInTuplet as unknown as Tuplet).elements()
                lastInTuplet = els[els.length - 1]
            }
            if (!lastInTuplet.isChordRest()) {
                break
            }
            s = (lastInTuplet as unknown as ChordRest).segment()

            if (filter.canSelectTuplet(nextTuplet, cr1.tick(), endTick, selectionContainsMultiNoteChords)) {
                restDuration = restDuration.plus(nextTuplet.ticks())
                this.cmdDeleteTuplet(nextTuplet, /*replaceWithRest*/ false)
            } else {
                const recursionEnd = Fraction.min(nextTuplet.endTick(), endTick)
                this.deleteRangeAtTrack(crsToSelect, track, cr1.segment(), recursionEnd, nextTuplet, filter, selectionContainsMultiNoteChords)
                foundDeselected(nextTuplet)
            }

            if (!s) {
                break
            }

            continue
        }

        for (const elem of collectElementsAnchoredToChordRest(cr1)) {
            if (!elem.isChord()) {
                if (filter.canSelect(elem)) {
                    this.undoRemoveElement(elem)
                }
                continue
            }
            // Special handling for grace notes...
            const chord = elem as unknown as Chord
            if (!chord.isGrace()) {
                continue
            }
            const anchoredToGrace = collectElementsAnchoredToChordRest(chord)
            for (const graceNote of chord.notes()) {
                for (const noteAnchored of collectElementsAnchoredToNote(graceNote, true, false)) {
                    anchoredToGrace.add(noteAnchored)
                }
            }
            for (const graceElem of anchoredToGrace) {
                if (filter.canSelect(graceElem)) {
                    // Delete elements anchored to grace note...
                    this.undoRemoveElement(graceElem)
                }
            }
            if (filter.canSelect(elem)) {
                // Delete grace note itself...
                this.undoRemoveElement(elem)
            }
        }

        if (cr1.isRestFamily()) {
            if (cr1.selected()) {
                restDuration = restDuration.plus(cr1.ticks())
                this.removeChordRest(cr1, true)
            } else {
                foundDeselected(cr1)
            }
            continue
        }

        const chord = cr1 as Chord

        const allNotes = [...chord.notes()]
        const notesToRemove = new Set<Note>()
        for (let noteIdx = 0; noteIdx < allNotes.length; ++noteIdx) {
            const note = allNotes[noteIdx]
            if (filter.canSelectNoteIdx(noteIdx, allNotes.length, selectionContainsMultiNoteChords)) {
                notesToRemove.add(note)
                //! NOTE: Don't need to remove anchored elements - they won't survive the deletion of their parent note...
                continue
            }
            for (const elem of collectElementsAnchoredToNote(note, true, false)) {
                if (!filter.canSelect(elem)) {
                    continue
                }
                if (!elem.isSpanner() || elem.isPartialTie() || elem.isLaissezVib()) {
                    this.undoRemoveElement(elem)
                    continue
                }
                if (noteAnchoredSpannerIsInRange(elem as unknown as Spanner, cr1.tick(), endTick)) {
                    this.undoRemoveElement(elem)
                }
            }
            if (!filter.canSelectNoteIdx(noteIdx, allNotes.length, selectionContainsMultiNoteChords)) {
                continue
            }
            notesToRemove.add(note)
        }

        if (notesToRemove.size === allNotes.length) {
            restDuration = restDuration.plus(cr1.ticks())
            this.removeChordRest(cr1, true)
        } else {
            for (const note of notesToRemove) {
                this.undoRemoveElement(note)
            }
            foundDeselected(cr1)
        }
    }

    const rests = this.setRests(restStartTick, track, restDuration, /*useDots*/ !currentTuplet, currentTuplet)
    crsToSelect.push(...rests)
}

/**
 * Deletes elements in the given range that match the given selection filter.
 * Returns chords/rests inside the selected range that can be used to establish a selection after this
 * deletion operation.
 */
Score.prototype.deleteRange = function (this: Score, s1: Segment, s2: Segment | null, track1: track_idx_t, track2: track_idx_t,
    filter: SelectionFilter, selectionContainsMultiNoteChords = false): ChordRest[] {
    const crsForSelection: ChordRest[] = []

    // delete content from measures underlying mmrests
    if (s1.measure() && s1.measure().isMMRest()) {
        s1 = s1.measure().mmRestFirst()!.first()!
    }
    if (s2 && s2.measure() && s2.measure().isMMRest()) {
        s2 = s2.measure().mmRestLast()!.last()
    }

    const startTick = s1.tick()
    const endTick = s2 ? s2.tick() : this.lastMeasure()!.endTick()

    this.deleteOrShortenOutSpannersFromRange(startTick, endTick, track1, track2, filter)
    this.deleteAnnotationsFromRange(s1, s2, track1, track2, filter)

    for (let track = track1; track < track2; ++track) {
        if (!filter.canSelectVoice(track)) {
            continue
        }
        this.deleteRangeAtTrack(crsForSelection, track, s1, endTick, /*currentTuplet*/ null, filter, selectionContainsMultiNoteChords)
    }

    return crsForSelection
}

Score.prototype.cmdDeleteSelection = function (this: Score): void {
    let crsSelectedAfterDeletion: (ChordRest | null)[] = [] // select something after deleting notes
    let elSelectedAfterDeletion: EngravingItem | null = null

    if (this.selection().isRange()) {
        crsSelectedAfterDeletion = this.deleteRange(this.selection().startSegment()!, this.selection().endSegment(),
            staff2track(this.selection().staffStart()), staff2track(this.selection().staffEnd()),
            this.selectionFilter(), this.selection().rangeContainsMultiNoteChords())
    } else {
        // deleteItem modifies selection().elements() list,
        // so we need a local copy:
        const el = [...this.selection().elements()]

        // keep track of linked elements that are deleted implicitly
        // so we don't try to delete them twice if they are also in selection
        const deletedElements = new Set<EngravingObject>()
        // Similarly, deleting one spanner segment, will delete all of them
        // so we don't try to delete them twice if they are also in selection
        const deletedSpanners = new Set<Spanner>()

        const selectCRAtTickAndTrack = (tick: Fraction, track: track_idx_t): void => {
            const cr = this.findCR(tick, track)
            if (cr) {
                crsSelectedAfterDeletion.push(cr)
            }
        }

        for (const e of el) {
            // these are the linked elements we are about to delete
            const links: readonly EngravingObject[] = e.links() ? [...e.links()!] : []

            // find location of element to select after deleting notes
            // get tick of element itself if that is valid
            // or of spanner or parent if that is more valid
            let tick = new Fraction(-1, 1)
            if (e.isNote()) {
                tick = (e as unknown as Note).chord().tick()
            } else if (e.isRest() || e.isMMRest()) {
                tick = e.tick()
            } else if (e.isMeasureRepeat()) { // may be attached in different measure than it appears
                // TODO(port): MeasureRepeat::firstMeasureOfGroup()
                tick = e.tick()
            } else if (e.isSpannerSegment()) {
                tick = (e as unknown as SpannerSegment).spanner()!.tick()
            } else if (e.isBreath()) {
                // we want the tick of the ChordRest that precedes the breath mark (in the same track)
                for (let s = (e.explicitParent() as unknown as Segment).prev(); s; s = s.prev()) {
                    if (s.isChordRestType() && s.element(e.track())) {
                        tick = s.tick()
                        break
                    }
                }
            } else if (e.isBarLine() && (e as unknown as BarLine).barLineType() !== BarLineType.START_REPEAT) {
                // we want the tick of the ChordRest that precedes the barline (in the same track)
                for (let s = (e as unknown as BarLine).segment()!.prev(); s; s = s.prev()) {
                    if (s.isChordRestType() && s.element(e.track())) {
                        tick = s.tick()
                        break
                    }
                }
            } else if (e.isSoundFlag()) {
                tick = e.tick()
            } else if (e.explicitParent()
                       && (e.explicitParent()!.isSegment() || e.explicitParent()!.isChord() || e.explicitParent()!.isNote()
                           || e.explicitParent()!.isRest())) {
                tick = e.parentItem()!.tick()
            }
            //else tick < 0
            const track = e.track()

            // We should not allow deleting the very first keySig of the piece, because it is
            // logically incorrect and leads to a state of undefined key/transposition.
            // Also instrument change key signatures should be undeletable.
            // The correct action is for the user to set an atonal/custom keySig as needed.
            if (e.isKeySig()) {
                if (e.tick().isZero() || (e as unknown as KeySig).forInstrumentChange()) {
                    MScore.setError(MsError.CANNOT_REMOVE_KEY_SIG)
                    selectCRAtTickAndTrack(tick, track)
                    continue
                }
            }

            // Don't allow deleting the trill cue note
            if (e.isNote() && (e as unknown as Note).isTrillCueNote()) {
                selectCRAtTickAndTrack(tick, track)
                continue
            }

            if (e.isFretDiagram() || e.isHarmony()) {
                const fbox = e.findAncestor(ElementType.FBOX)
                if (fbox) {
                    // We can't delete elements inside fret box, instead we hide them
                    const fretDiagram = e.isFretDiagram() ? e : e.parentItem()
                    if (fretDiagram) {
                        fretDiagram.undoChangeProperty(Pid.VISIBLE, false)
                        continue
                    }
                } else if (e.isFretDiagram()) {
                    const fretDiagram = e as unknown as FretDiagram
                    const harmony = fretDiagram.harmony()
                    if (harmony) {
                        this.undoChangeParent(harmony, fretDiagram.segment()!, track2staff(fretDiagram.track()))
                        elSelectedAfterDeletion = harmony
                    }
                } else if (e.isHarmony()) {
                    if (e.parentItem()!.isFretDiagram()) {
                        elSelectedAfterDeletion = e.parentItem()
                    }
                }
            }

            // delete element if we have not done so already
            if (!deletedElements.has(e)) {
                // do not delete two spanner segments from the same spanner
                if (e.isSpannerSegment()) {
                    const spanner = (e as unknown as SpannerSegment).spanner()!
                    if (deletedSpanners.has(spanner)) {
                        continue
                    } else {
                        for (const se of spanner.linkList()) {
                            deletedSpanners.add(se as unknown as Spanner)
                        }
                    }
                }
                this.deleteItem(e)
            }

            if (!elSelectedAfterDeletion) {
                selectCRAtTickAndTrack(tick, track)
            }

            // add these linked elements to list of already-deleted elements
            for (const se of links) {
                deletedElements.add(se)
            }
        }
    }

    this.deselectAll()
    // make new selection if appropriate
    if (this.noteEntryMode()) {
        if (crsSelectedAfterDeletion.length && crsSelectedAfterDeletion[0]) {
            this.inputState().setSegment(crsSelectedAfterDeletion[0].segment())
        } else {
            crsSelectedAfterDeletion.push(this.inputState().cr())
        }
    }
    if (elSelectedAfterDeletion) {
        this.select(elSelectedAfterDeletion)
    } else if (crsSelectedAfterDeletion.length) {
        const elementsToSelect: EngravingItem[] = []
        for (const cr of crsSelectedAfterDeletion) {
            if (cr) {
                if (cr.isChord()) {
                    elementsToSelect.push((cr as Chord).upNote())
                }
                if (cr.isRest()) {
                    elementsToSelect.push(cr)
                }
            }
        }
        this.select(elementsToSelect, SelectType.ADD, 0)
    }
}

Score.prototype.cmdEnterRest = function (this: Score, d: TDuration): void {
    if (this.inputState().track() === nidx) {
        // C++: LOGD("cmdEnterRest: track invalid")
        return
    }
    this.startCmd(new TranslatableString('undoableAction', 'Enter rest'))
    this.enterRest(d)
    this.endCmd()
}

Score.prototype.enterRest = function (this: Score, d: TDuration, externalInputState: InputState | null = null): void {
    const is = externalInputState ?? this.inputState()

    this.expandVoice(is.segment()!, is.track())

    if (!is.cr()) {
        // C++: LOGD("cannot enter rest here")
        return
    }

    const track = is.track()
    const nval = new NoteVal()
    this.setNoteRest(is.segment()!, track, nval, d.fraction(), DirectionV.AUTO, /* forceAccidental */ false,
        is.articulationIds(), /* rhythmic */ false, externalInputState)
    is.moveToNextInputPos()
    if (!is.noteEntryMode() || is.usingNoteEntryMethod(NoteEntryMethod.BY_NOTE_NAME)) {
        is.setRest(false) // continue with normal note entry
    }
}

/** remove chord or rest, remove associated segment if empty, remove beam, remove slurs */
Score.prototype.removeChordRest = function (this: Score, cr: ChordRest, clearSegment: boolean): void {
    const segments = new Set<Segment>()
    for (const e of cr.linkList()) {
        if (cr.isChord()) {
            const startingSpanners = [...(e as unknown as Chord).startingSpanners()]
            for (const spanner of startingSpanners) {
                if (spanner.isTrill() || spanner.isSlur()) {
                    this.doUndoRemoveElement(spanner)
                }
            }
        }
        this.doUndoRemoveElement(e as unknown as EngravingItem)
        if (clearSegment) {
            segments.add(cr.segment())
        }
    }
    for (const s of segments) {
        if (s.empty()) {
            this.doUndoRemoveElement(s)
        }
    }
    if (cr.beam()) {
        const beam = cr.beam()!
        if (beam.generated()) {
            beam.parentItem()?.remove(beam)
        } else {
            this.undoRemoveElement(beam)
        }
    }
}

/** remove tuplet and replace with rest */
Score.prototype.cmdDeleteTuplet = function (this: Score, tuplet: Tuplet, replaceWithRest: boolean): void {
    const elements = [...tuplet.elements()]
    for (const de of elements) {
        if (de.isChordRest()) {
            this.removeChordRest(de as unknown as ChordRest, true)
        } else {
            this.cmdDeleteTuplet(de as unknown as Tuplet, false)
        }
    }
    if (replaceWithRest) {
        this.setRest(tuplet.tick(), tuplet.track(), tuplet.ticks(), true, tuplet.tuplet())
    }
}

Score.prototype.nextInputPos = function (this: Score, cr: ChordRest | null, doSelect: boolean): void {
    if (!cr) {
        return
    }
    let ncr = nextChordRest(cr)
    if (!ncr && (this.inputState().track() % VOICES)) {
        const s = this.tick2segment(cr.endTick(), false, SegmentType.ChordRest)
        ncr = s ? s.element(cr.staffIdx() * VOICES) as unknown as ChordRest | null : null
    }
    if (ncr) {
        this.inputState().setSegment(ncr.segment())
        if (doSelect) {
            this.select(ncr, SelectType.SINGLE, 0)
        }
        // C++: v->moveCursor() for the views
    }
}

Score.prototype.cmdExchangeVoice = function (this: Score, s: voice_idx_t, d: voice_idx_t): void {
    if (!this.selection().isRange()) {
        MScore.setError(MsError.NO_STAFF_SELECTED)
        return
    }
    const t1 = this.selection().tickStart()
    const t2 = this.selection().tickEnd()

    let m1 = this.tick2measure(t1)
    let m2 = this.tick2measure(t2)

    if (this.selection().score().excerpt()) {
        return
    }

    if (m2 && t2.gt(m2.tick())) {
        m2 = m2.nextMeasure()
    }

    while (m1) {
        this.undoExchangeVoice(m1, s, d, this.selection().staffStart(), this.selection().staffEnd())
        m1 = m1.nextMeasure()
        if (!m1 || (m2 && m1.tick().eq(m2.tick()))) {
            break
        }
    }
}

Score.prototype.undoExchangeVoice = function (this: Score, measure: Measure, srcVoice: voice_idx_t, dstVoice: voice_idx_t,
    srcStaff: staff_idx_t, dstStaff: staff_idx_t): void {
    const tick = measure.tick()

    for (let staffIdx = srcStaff; staffIdx < dstStaff; ++staffIdx) {
        const staffList = new Set<Staff>(this.staff(staffIdx)!.staffList())

        const srcStaffTrack = staffIdx * VOICES
        const srcTrack = srcStaffTrack + srcVoice
        const dstTrack = srcStaffTrack + dstVoice
        const trackDiff = dstVoice - srcVoice

        //handle score and complete measures first
        this.undo(new ExchangeVoice(measure, srcTrack, dstTrack, staffIdx))

        for (const st of staffList) {
            const staffTrack = st.idx() * VOICES
            const measure2 = st.score().tick2measure(tick)!
            const ex = st.score().excerpt()

            if (ex) {
                const tracks = ex.tracksMapping()
                const values = (key: track_idx_t): track_idx_t[] => tracks.filter(([k]) => k === key).map(([, v]) => v)
                let srcTrackList = values(srcTrack)
                let dstTrackList = values(dstTrack)

                for (const srcTrack2 of [...srcTrackList]) {
                    // don't care about other linked staves
                    if (!(staffTrack <= srcTrack2) || !(srcTrack2 < staffTrack + VOICES)) {
                        continue
                    }

                    const tempTrack = srcTrack
                    const testTracks = values(tempTrack + trackDiff)
                    let hasVoice = false
                    for (const testTrack of testTracks) {
                        if (staffTrack <= testTrack && testTrack < staffTrack + VOICES && dstTrackList.includes(testTrack)) {
                            hasVoice = true
                            // voice is simply exchangeable now (deal directly)
                            this.undo(new ExchangeVoice(measure2, srcTrack2, testTrack, Math.floor(staffTrack / 4)))
                        }
                    }

                    // only source voice is in this staff
                    if (!hasVoice) {
                        this.undo(new CloneVoice(measure.first()!, measure2.endTick(), measure2.first()!, tempTrack, srcTrack2,
                            tempTrack + trackDiff))
                        srcTrackList = srcTrackList.filter(t => t !== srcTrack2)
                    }
                }

                for (const dstTrack2 of [...dstTrackList]) {
                    // don't care about other linked staves
                    if (!(staffTrack <= dstTrack2) || !(dstTrack2 < staffTrack + VOICES)) {
                        continue
                    }

                    const tempTrack = dstTrack
                    const testTracks = values(tempTrack - trackDiff)
                    let hasVoice = false
                    for (const testTrack of testTracks) {
                        if (staffTrack <= testTrack && testTrack < staffTrack + VOICES && srcTrackList.includes(testTrack)) {
                            hasVoice = true
                        }
                    }

                    // only destination voice is in this staff
                    if (!hasVoice) {
                        this.undo(new CloneVoice(measure.first()!, measure2.endTick(), measure2.first()!, tempTrack, dstTrack2,
                            tempTrack - trackDiff))
                        dstTrackList = dstTrackList.filter(t => t !== dstTrack2)
                    }
                }
            } else if (srcStaffTrack !== staffTrack) {
                // linked staff in same score (all voices present can be assumed)
                this.undo(new ExchangeVoice(measure2, staffTrack + srcVoice, staffTrack + dstVoice, st.idx()))
            }
        }
    }

    // make sure voice 0 is complete

    if (srcVoice === 0 || dstVoice === 0) {
        for (let staffIdx = srcStaff; staffIdx < dstStaff; ++staffIdx) {
            // check for complete timeline of voice 0
            let ctick = measure.tick()
            const track = staffIdx * VOICES
            for (let s = measure.first(SegmentType.ChordRest); s; s = s.next(SegmentType.ChordRest)) {
                const cr = s.element(track) as unknown as ChordRest | null
                if (!cr) {
                    continue
                }
                if (cr.isRest()) {
                    const r = cr as unknown as Rest
                    if (r.isGap()) {
                        r.undoChangeProperty(Pid.GAP, false)
                    }
                }
                if (ctick.lt(s.tick())) {
                    this.setRest(ctick, track, s.tick().minus(ctick), false, null) // fill gap
                }
                ctick = cr.endTick()
            }
            const etick = measure.endTick()
            if (ctick.lt(etick)) {
                this.setRest(ctick, track, etick.minus(ctick), false, null) // fill gap
            }
        }
    }
}

// ---------------------------------------------------------
//   undo helpers
// ---------------------------------------------------------

/**
 * C++ bool undoPropertyChanged(EngravingItem*, Pid, const PropertyValue&, PropertyFlags): the item's property was
 * already changed to its new value; records the change (propValue: the old value)
 */
Score.prototype.undoPropertyChangedItem = function (this: Score, item: EngravingItem, propId: Pid, propValue: PropertyValue,
    propFlags: PropertyFlags = PropertyFlags.NOSTYLE): boolean {
    let changed = false

    const currentPropValue = item.getProperty(propId)
    const currentPropFlags = item.propertyFlags(propId)

    if (!propertyValueEquals(currentPropValue, propValue) || currentPropFlags !== propFlags) {
        item.setPropertyFlags(propId, propFlags)
        this.undoStack().pushWithoutPerforming(new ChangeProperty(item, propId, propValue, propFlags))
        changed = true
    }

    for (const linkedItem of item.linkListForPropertyPropagation()) {
        if (linkedItem === item) {
            continue
        }
        const propertyPropagate = item.propertyPropagation(linkedItem as EngravingItem, propId)
        switch (propertyPropagate) {
        case PropertyPropagation.PROPAGATE:
            if (!propertyValueEquals(linkedItem.getProperty(propId), currentPropValue)) {
                this.undoStack().pushAndPerform(new ChangeProperty(linkedItem, propId, currentPropValue, propFlags), null)
                changed = true
            }
            break
        case PropertyPropagation.UNLINK:
            item.unlinkPropertyFromMaster(propId)
            break
        default:
            break
        }
    }

    return changed
}

Score.prototype.undoPropertyChanged = function (this: Score, e: EngravingObject, t: Pid, st: PropertyValue,
    ps: PropertyFlags = PropertyFlags.NOSTYLE): void {
    if (!propertyValueEquals(e.getProperty(t), st)) {
        this.undoStack().pushWithoutPerforming(new ChangeProperty(e, t, st, ps))
    }
}

Score.prototype.undoChangeStyleVal = function (this: Score, idx: Sid, v: PropertyValue): void {
    this.undo(new ChangeStyleValues(this, new Map([[idx, v]])))
}

Score.prototype.resetStyleValue = function (this: Score, styleToReset: Sid): void {
    const defStyle = DefaultStyle.defaultStyle()
    this.undoChangeStyleVal(styleToReset, defStyle.value(styleToReset))
}

Score.prototype.resetStyleValues = function (this: Score, styleIdSet: ReadonlySet<Sid>): void {
    if (!styleIdSet.size) {
        return
    }

    const values = new Map<Sid, PropertyValue>()
    const defStyle = DefaultStyle.defaultStyle()

    for (const sid of styleIdSet) {
        values.set(sid, defStyle.value(sid))
    }

    this.undoChangeStyleValues(values)
}

Score.prototype.loadStyle = function (this: Score, data: string, _ign = false, overlap = false): boolean {
    const st = this.style().clone()
    if (st.readDocument(data)) {
        this.undo(new ChangeStyle(this, st, overlap))
        return true
    }
    console.error('The style data is not compatible with this version of MuseScore Studio.')
    return false
}

Score.prototype.undoChangePageNumberOffset = function (this: Score, po: number): void {
    this.undo(new ChangePageNumberOffset(this, po))
}

Score.prototype.undoChangeStyleValues = function (this: Score, values: Map<Sid, PropertyValue>): void {
    this.undo(new ChangeStyleValues(this, values))
}

Score.prototype.undoChangeParent = function (this: Score, element: EngravingItem | null, parent: EngravingItem | null,
    staffIdx: staff_idx_t): void {
    if (!element || !parent) {
        return
    }

    if (element.parentItem() === parent && staffIdx === element.staffIdx()) {
        return
    }

    const destStaff = this.staff(staffIdx)!
    let recreateItemNeeded = false

    for (const obj of [...element.linkList()]) {
        const item = obj as EngravingItem
        const linkedScore = item.score()
        const linkedOrigin = item.staff()
        // don't allow staff-change of linked elements within the same score
        let linkedDest = linkedScore !== this && destStaff !== element.staff() ? destStaff.findLinkedInScore(linkedScore) : linkedOrigin
        if (!linkedDest && element.systemFlag()) {
            linkedDest = linkedScore.staff(0)
        }

        if (!linkedScore) {
            continue
        }
        if (item === element) {
            // Master score
            this.undo(new ChangeParent(element, parent, staffIdx))
        } else if (linkedOrigin && linkedDest) {
            // Part - origin and destination staves are in this part
            let linkedParent: EngravingItem | null
            if (parent.isSegment()) {
                // Get parent segment in linked score
                const oldSeg = parent as unknown as Segment
                const oldMeas = oldSeg.measure()
                const newMeas = linkedScore.tick2measure(oldMeas.tick())!
                linkedParent = newMeas.tick2segment(oldSeg.tick(), oldSeg.segmentType())
                if (!linkedParent && (oldSeg.segmentType() & CHORD_REST_OR_TIME_TICK_TYPE)) {
                    // A ChordRest segment that exists in the score may not exist in the part.
                    // In that case we create a TimeTick segment as new parent for the linked item.
                    linkedParent = newMeas.getSegment(SegmentType.TimeTick, oldSeg.tick())
                }
            } else {
                linkedParent = parent.findLinkedInStaff(linkedDest)
            }
            if (!linkedParent) {
                continue
            }
            linkedScore.undo(new ChangeParent(item, linkedParent, linkedScore.staffIdx(linkedDest)))
        } else if (linkedOrigin && !linkedDest) {
            // Part - move is to a different staff
            // Remove original item
            linkedScore.undoRemoveElement(item, false)
            recreateItemNeeded = true
        }
    }

    if (recreateItemNeeded) {
        // Need to create item in some parts
        for (const obj of destStaff.linkList()) {
            const linkedDest = obj as Staff
            const linkedScore = linkedDest.score()
            if (linkedDest !== destStaff && !element.findLinkedInScore(linkedScore)) {
                // Item should be in this score and isn't already
                const newItem = element.linkedClone()
                let linkedParent: EngravingItem | null

                if (parent.isSegment()) {
                    // Get parent segment in linked score
                    const oldSeg = parent as unknown as Segment
                    const m = linkedScore.tick2measure(oldSeg.tick())!
                    linkedParent = m.tick2segment(oldSeg.tick(), oldSeg.segmentType())
                } else {
                    linkedParent = parent.findLinkedInScore(linkedScore)
                }

                newItem.setParent(linkedParent)
                newItem.setTrack(linkedScore.staffIdx(linkedDest) * VOICES)
                newItem.setOffset(new PointF())
                linkedParent!.undoAddElement(newItem, false)
            }
        }
    }
}

Score.prototype.undoChangeElement = function (this: Score, oldElement: EngravingItem | null, newElement: EngravingItem): void {
    if (!oldElement) {
        this.undoAddElement(newElement)
    } else {
        for (const obj of oldElement.linkList()) {
            const item = obj as EngravingItem
            if (item === oldElement) {
                this.undo(new ChangeElement(oldElement, newElement))
            } else {
                if (item.score()) {
                    const newClone = newElement.clone()
                    item.score().undo(new ChangeElement(item, newClone))
                }
            }
        }
    }
}

Score.prototype.undoChangePitch = function (this: Score, note: Note, pitch: number, tpc1: number, tpc2: number): void {
    for (const e of note.linkList()) {
        const n = e as unknown as Note
        this.undoStack().pushAndPerform(new ChangePitch(n, pitch, tpc1, tpc2), null)
    }
}

/**
 * To use with tablatures to force a specific note fretting;
 * Pitch, string and fret must be changed all together; otherwise,
 * if they are not consistent among themselves, the refretting algorithm may re-assign
 * fret and string numbers for (potentially) all the notes of all the chords of a segment.
 */
Score.prototype.undoChangeFretting = function (this: Score, note: Note, pitch: number, string: number, fret: number,
    tpc1: number, tpc2: number): void {
    const l = note.links()
    if (l) {
        for (const e of l) {
            const n = e as unknown as Note
            this.undo(new ChangeFretting(n, pitch, string, fret, tpc1, tpc2))
        }
    } else {
        this.undo(new ChangeFretting(note, pitch, string, fret, tpc1, tpc2))
    }
}

Score.prototype.undoChangeChordRestLen = function (this: Score, cr: ChordRest, d: TDuration): void {
    cr.undoChangeProperty(Pid.DURATION_TYPE_WITH_DOTS, d.typeWithDots())
    cr.undoChangeProperty(Pid.DURATION, d.fraction())
}

Score.prototype.undoChangeSpannerElements = function (this: Score, spanner: Spanner, startElement: EngravingItem | null,
    endElement: EngravingItem | null): void {
    const oldStartElement = spanner.startElement()
    const oldEndElement = spanner.endElement()
    const startDeltaTrack = startElement && oldStartElement ? startElement.track() - oldStartElement.track() : 0
    const endDeltaTrack = endElement && oldEndElement ? endElement.track() - oldEndElement.track() : 0
    // scan all spanners linked to this one
    for (const el of spanner.linkList()) {
        const sp = el as unknown as Spanner
        let newStartElement: EngravingItem | null = null
        let newEndElement: EngravingItem | null = null
        // if not the current spanner, but one linked to it, determine its new start and end elements
        // as modifications 'parallel' to the modifications of the current spanner's start and end elements
        if (sp !== spanner) {
            if (startElement) {
                // determine the track where to expect the 'parallel' start element
                const newTrack = sp.startElement() ? sp.startElement()!.track() + startDeltaTrack : sp.track()
                // look in elements linked to new start element for an element with
                // same score as linked spanner and appropriate track
                for (const ee of startElement.linkList()) {
                    const e = ee as EngravingItem
                    if (e.score() === sp.score() && e.track() === newTrack) {
                        newStartElement = e
                        break
                    }
                }
            }
            // similarly to determine the 'parallel' end element
            if (endElement) {
                const newTrack = sp.endElement() ? sp.endElement()!.track() + endDeltaTrack : sp.track2()
                for (const ee of endElement.linkList()) {
                    const e = ee as EngravingItem
                    if (e.score() === sp.score() && e.track() === newTrack) {
                        newEndElement = e
                        break
                    }
                }
            }
        } else {
            // if current spanner, just use stored start and end elements
            newStartElement = startElement
            newEndElement = endElement
        }
        sp.score().undo(new ChangeSpannerElements(sp, newStartElement, newEndElement))

        // TODO(port): toTie(sp)->updatePossibleJumpPoints() (repeats)
    }
}

Score.prototype.undoChangeUserMirror = function (this: Score, n: Note, d: DirectionH): void {
    n.undoChangeProperty(Pid.MIRROR_HEAD, d)
}

/** TODO-TPC: check */
Score.prototype.undoChangeTpc = function (this: Score, note: Note, v: number): void {
    note.undoChangeProperty(Pid.TPC1, v)
}

// ---------------------------------------------------------
//   visibility
// ---------------------------------------------------------

function chordHasVisibleNote(chord: Chord): boolean {
    for (const note of chord.notes()) {
        if (note.visible()) {
            return true
        }
    }

    return false
}

function undoChangeNoteVisibility(note: Note, visible: boolean): void {
    note.undoChangeProperty(Pid.VISIBLE, visible)

    if (note.bendBack() || note.bendFor()) {
        note.setOverrideBendVisibilityRules(true)
    } else {
        note.setOverrideBendVisibilityRules(false)
    }

    for (const dot of note.dots()) {
        dot.undoChangeProperty(Pid.VISIBLE, visible)
    }

    for (const e of note.el()) {
        e.undoChangeProperty(Pid.VISIBLE, visible)
    }

    if (note.accidental()) {
        note.accidental()!.undoChangeProperty(Pid.VISIBLE, visible)
    }

    const noteChord = note.chord()
    const beam = noteChord.beam()
    const chords: Chord[] = []

    const chordHasVisibleNote_ = visible || chordHasVisibleNote(noteChord)
    let beamHasVisibleNote_ = chordHasVisibleNote_

    if (beam) {
        for (const item of beam.elements()) {
            if (!item.isChord()) {
                continue
            }

            const chord = item as unknown as Chord
            chords.push(chord)

            if (!beamHasVisibleNote_ && chord !== noteChord) {
                beamHasVisibleNote_ = chordHasVisibleNote(chord)
            }
        }
    } else {
        chords.push(noteChord)
    }

    const IGNORED_TYPES = new Set([
        ElementType.NOTE,
        ElementType.LYRICS,
        ElementType.SLUR,
        ElementType.HAMMER_ON_PULL_OFF,
        ElementType.CHORD, // grace notes
        ElementType.LEDGER_LINE, // temporary objects, impossible to change visibility
    ])

    for (const chord of chords) {
        for (const obj of chord.linkList()) {
            const linkedChord = obj as unknown as Chord
            const linkedChordHasVisibleNote = chordHasVisibleNote(linkedChord)
            // C++ getChildren(): the descendants of the chord
            for (const child of linkedChord.childrenItems(true)) {
                const type = child.type()

                if (IGNORED_TYPES.has(type)) {
                    continue
                }

                if (beam) {
                    if (type === ElementType.STEM || type === ElementType.BEAM) {
                        child.undoChangeProperty(Pid.VISIBLE, beamHasVisibleNote_)
                        continue
                    }
                }
                if (child.isOrnament()) {
                    undoChangeOrnamentVisibility(child as unknown as Ornament, visible)
                } else {
                    child.undoChangeProperty(Pid.VISIBLE, linkedChordHasVisibleNote)
                }
            }
        }
    }
}

function undoChangeRestVisibility(rest: Rest, visible: boolean): void {
    rest.undoChangeProperty(Pid.VISIBLE, visible)

    for (const dot of rest.dotList()) {
        dot.undoChangeProperty(Pid.VISIBLE, visible)
    }
}

function undoChangeOrnamentVisibility(ornament: Ornament, visible: boolean): void {
    ornament.undoChangeProperty(Pid.VISIBLE, visible)
    const cueNoteChord = ornament.cueNoteChord()
    if (cueNoteChord) {
        undoChangeNoteVisibility(cueNoteChord.upNote(), visible)
    }
    if (ornament.accidentalAbove()) {
        ornament.accidentalAbove()!.undoChangeProperty(Pid.VISIBLE, visible)
    }
    if (ornament.accidentalBelow()) {
        ornament.accidentalBelow()!.undoChangeProperty(Pid.VISIBLE, visible)
    }
}

Score.prototype.undoChangeVisible = function (this: Score, item: EngravingItem, visible: boolean): void {
    if (item.isNote()) {
        undoChangeNoteVisibility(item as unknown as Note, visible)
    } else if (item.isRest()) {
        undoChangeRestVisibility(item as unknown as Rest, visible)
    } else if (item.isOrnament()) {
        undoChangeOrnamentVisibility(item as unknown as Ornament, visible)
    } else if (item.isTrillSegment()) {
        item.undoChangeProperty(Pid.VISIBLE, visible)
        const orn = (item as unknown as TrillSegment).trill().ornament()
        if (orn) {
            undoChangeOrnamentVisibility(orn, visible)
        }
    } else {
        item.undoChangeProperty(Pid.VISIBLE, visible)
    }
}

// ---------------------------------------------------------
//   score.cpp
// ---------------------------------------------------------

/** C++ Score::canReselectItem (score.cpp) */
Score.prototype.canReselectItem = function (this: Score, item: EngravingItem | null): boolean {
    if (!item || item.selected()) {
        return false
    }

    const seg = item.findAncestor(ElementType.SEGMENT)
    if (seg) {
        return seg.childrenItems(true).includes(item)
    }

    return true
}

/**
 * C++ Score::changeSelectedElementsVoice (score.cpp): moves selected notes into specified voice if possible
 * TODO(port): parentheses of note groups, lyrics
 */
Score.prototype.changeSelectedElementsVoice = function (this: Score, voice: voice_idx_t): void {
    const isOperationValid = (score: Score, origTrack: track_idx_t, dstTrack: track_idx_t): boolean => {
        const excerpt = score.excerpt()
        if (!excerpt) {
            return true
        }

        // muse::key(map, value, muse::nidx)
        const key = (value: track_idx_t): track_idx_t => excerpt.tracksMapping().find(([, v]) => v === value)?.[0] ?? nidx
        const dstTrackMapped = key(dstTrack)
        if (dstTrackMapped === nidx) {
            return false
        }

        const origTrackMapped = key(origTrack)
        if (origTrackMapped === dstTrack) {
            return false
        }

        return true
    }

    const newElements: EngravingItem[] = []
    const oel = [...this.selection().elements()] // make copy
    for (let e of oel) {
        if (e.isNote()) {
            let note = e as unknown as Note
            let chord = note.chord()

            // move grace notes with main chord only
            if (chord.isGrace() || chord.isTrillCueNote()) {
                continue
            }

            if (chord.voice() === voice) {
                continue
            }

            let score: Score = this
            if (this.excerpt() && !chord.staff()!.isVoiceVisible(voice)) {
                // We are on a linked stave with the desired voice not visible
                // Get note in main score to continue
                note = note.findLinkedInScore(this.masterScore()) as unknown as Note
                chord = note.chord()
                score = this.masterScore()
            }
            const s = chord.segment()
            const m = s.measure()
            const notes = chord.notes().length
            const dstTrack = chord.staffIdx() * VOICES + voice
            const dstCR = s.element(dstTrack) as unknown as ChordRest | null
            let dstChord: Chord | null = null

            if (!isOperationValid(score, chord.track(), dstTrack)) {
                continue
            }

            // set up destination chord

            if (dstCR && dstCR.globalTicks().eq(chord.globalTicks())) {
                // existing chord/rest in destination with correct duration
                //   this case allows for tuplets, unlike the more general case below
                if (dstCR.isChord()) {
                    // can simply move note in
                    dstChord = dstCR as Chord
                } else {
                    // replace rest with chord, then move note in
                    dstChord = Factory.createItem(ElementType.CHORD, s) as Chord
                    dstChord.setTrack(dstTrack)
                    dstChord.setDurationType(chord.durationType())
                    dstChord.setTicks(chord.ticks())
                    dstChord.setTuplet(dstCR.tuplet())
                    dstChord.setParent(s)
                    score.undoRemoveElement(dstCR)
                }
            } else if (!chord.tuplet()) {
                // rests or gap in destination
                //   insert new chord if the rests / gap are long enough
                //   then move note in
                let hasIncompatibleTuplet = false
                let cBefore: Chord | null = null
                let cAfterStart: Chord | null = null
                for (let s2 = m.first(SegmentType.ChordRest); s2; s2 = s2.next(SegmentType.ChordRest)) {
                    const cr2 = s2.element(dstTrack) as unknown as ChordRest | null
                    if (!cr2) {
                        continue
                    }
                    const topTuplet = cr2.topTuplet()
                    if (topTuplet) {
                        if (topTuplet.tick().lt(s.tick()) && topTuplet.endTick().gt(s.tick())) {
                            hasIncompatibleTuplet = true
                            break
                        }
                        if (topTuplet.tick().lt(chord.endTick()) && topTuplet.endTick().gt(chord.endTick())) {
                            hasIncompatibleTuplet = true
                            break
                        }
                    }
                    if (!cr2.isChord()) {
                        continue
                    }
                    if (s2.tick().lt(s.tick())) {
                        cBefore = cr2 as Chord
                    }
                    if (s2.tick().ge(s.tick())) {
                        cAfterStart = cr2 as Chord
                    }
                    if (s2.tick().ge(chord.endTick())) {
                        break
                    }
                }
                if (hasIncompatibleTuplet) {
                    continue
                }
                if (cBefore && cBefore.endTick().gt(s.tick())) {
                    // previous chord overlaps
                    continue
                }
                if (cAfterStart && cAfterStart.tick().lt(chord.endTick())) {
                    // next chord overlaps
                    continue
                }
                // big enough gap found
                dstChord = Factory.createItem(ElementType.CHORD, s) as Chord
                dstChord.setTrack(dstTrack)
                dstChord.setDurationType(chord.durationType())
                dstChord.setTicks(chord.ticks())
                dstChord.setParent(s)
                // makeGapVoice will not back-fill an empty voice
                if (voice && !dstCR) {
                    score.expandVoice(s, /*m->first(SegmentType::ChordRest,*/ dstTrack)
                }
                score.makeGapVoice(s, dstTrack, chord.ticks(), s.tick())
            }

            if (!dstChord) {
                continue
            }

            // move note to destination chord

            // create & add new note
            const newNote = note.clone() as Note // C++ Factory::copyNote(*note)
            newNote.setSelected(false)
            newNote.setParent(dstChord)
            score.undoAddElement(newNote)
            newElements.push(newNote)
            // add new chord if one was created
            if (dstChord !== (dstCR as unknown)) {
                score.undoAddCR(dstChord, m, s.tick())
            }
            for (const linked of note.linkList()) {
                const linkedNote = linked as unknown as Note
                const linkedNewNote = linked === note ? newNote : newNote.findLinkedInStaff(linkedNote.staff()!) as unknown as Note
                // reconnect the tie to this note, if any
                let tie = linkedNote.tieBack()
                if (tie) {
                    const startNote = tie.isPartialTie() && !tie.isOutgoing() ? null : tie.startNote()
                    score.undoChangeSpannerElements(tie, startNote, linkedNewNote)
                }
                // reconnect the tie from this note, if any
                tie = linkedNote.tieFor()
                if (tie) {
                    score.undoChangeSpannerElements(tie, linkedNewNote, tie.endNote())
                }

                // Reconnect note anchored spanners
                for (const spanner of [...linkedNote.spannerBack()]) {
                    score.undoChangeSpannerElements(spanner, spanner.startElement(), linkedNewNote)
                }

                for (const spanner of [...linkedNote.spannerFor()]) {
                    score.undoChangeSpannerElements(spanner, linkedNewNote, spanner.endElement())
                }
            }

            // TODO(port): move parentheses of note groups to the new chord (EditChord::removeChordParentheses)

            // remove original note
            if (notes > 1) {
                score.undoRemoveElement(note)
            } else if (notes === 1) {
                // take care of slurs
                const currentTick = chord.tick().ticks()
                for (const spanner of score.spannerMap().findOverlapping(currentTick, currentTick + 1)) {
                    if (!spanner.isSlur()) {
                        continue
                    }
                    const slur = spanner
                    if (slur.startElement() === (chord as unknown) && slur.endElement() === (chord as unknown)) {
                        score.undoChangeSpannerElements(slur, dstChord, dstChord)
                        slur.undoChangeProperty(Pid.VOICE, voice)
                    } else if (slur.startElement() === (chord as unknown)) {
                        score.undoChangeSpannerElements(slur, dstChord, slur.endElement())
                    } else if (slur.endElement() === (chord as unknown)) {
                        score.undoChangeSpannerElements(slur, slur.startElement(), dstChord)
                    }
                }
                // move articulations
                for (const artic of [...chord.articulations()]) {
                    if (dstChord.hasArticulation(artic)) {
                        continue
                    }
                    score.undoChangeParent(artic, dstChord, dstChord.staffIdx())
                }
                // create rest to leave behind
                const r = Factory.createItem(ElementType.REST, s) as Rest
                r.setTrack(chord.track())
                r.setDurationType(chord.durationType())
                r.setTicks(chord.ticks())
                r.setTuplet(chord.tuplet())
                r.setParent(s)
                // if there were grace notes, move them
                while (chord.graceNotes().length) {
                    const gc = chord.graceNotes()[0]
                    const ngc = gc.clone() as Chord // C++ Factory::copyChord(*gc)
                    score.undoRemoveElement(gc)
                    ngc.setParent(dstChord)
                    ngc.setTrack(dstChord.track())
                    score.undoAddElement(ngc)
                }
                // remove chord, replace with rest
                score.undoRemoveElement(chord)
                score.undoAddCR(r, m, s.tick())
            }

            // TODO(port): move lyrics (Factory::copyLyrics)
        } else if (e.hasVoiceAssignmentProperties()) {
            if (e.isSpannerSegment()) {
                e = (e as unknown as SpannerSegment).spanner()!
            }

            e.undoChangeProperty(Pid.VOICE, voice)
            e.undoChangeProperty(Pid.VOICE_ASSIGNMENT, VoiceAssignment.CURRENT_VOICE_ONLY)
            newElements.push(e)
        }
    }

    if (newElements.length) {
        this.selection().clear()
        this.select(newElements, SelectType.ADD, nidx)
    }

    this.setLayoutAll()
}

// =====================================================================================================================
//   edit.cpp functions for drop / palette elements (undoChangeClef, undoChangeBarLineType, ...): this section is
//   filled by the palette drop port; the editing commands go above it
// =====================================================================================================================

// (imports of this section; ES imports are hoisted)
import { BarLineType, ClefType } from '../types/types'
import { PropertyFlags as DropPropertyFlags } from '../dom/property'
import { CHORD_REST_OR_TIME_TICK_TYPE } from '../dom/segment'
import { ClefInfo } from '../dom/clefinfo'
import { MScore as DropMScore, MsError as DropMsError } from '../dom/mscore'
import { ChangeClefType } from './editclef'
import { ChangeKeySig } from './editkeysig'
import { ChangeProperty as DropChangeProperty } from './editproperty'
import { Link, Unlink } from './addremoveelement'
import type { Clef } from '../dom/clef'
import type { BarLine } from '../dom/barline'
import type { Hairpin } from '../dom/hairpin'

declare module '../dom/score' {
    interface Score {
        undoChangeClef(ostaff: Staff, e: EngravingItem, ct: ClefType, forInstrumentChange?: boolean, clefToRelink?: Clef | null): void
        undoChangeBarLineType(bl: BarLine, barType: BarLineType, allStaves: boolean, replace?: boolean): void
        /** TODO(port): play count texts (PlayCountText is not ported): does nothing */
        undoUpdatePlayCountText(m: Measure | null): void
        /** C++ addHairpin(Hairpin*, ChordRest*, ChordRest*) */
        addHairpin(hairpin: Hairpin, cr1: ChordRest, cr2: ChordRest | null): void
    }
}

Score.prototype.undoChangeClef = function (this: Score, ostaff: Staff, e: EngravingItem, ct: ClefType,
    forInstrumentChange = false, clefToRelink: Clef | null = null): void {
    let moveClef = false
    let st = SegmentType.Clef
    if (e.isMeasure()) {
        if ((e as unknown as Measure).prevMeasure()) {
            moveClef = true
        } else {
            st = SegmentType.HeaderClef
        }
    } else if (e.isClef()) {
        const clef = e as unknown as Clef
        if (clef.segment().isHeaderClefType()) {
            if (clef.measure().prevMeasure()) {
                moveClef = true
            } else {
                st = SegmentType.HeaderClef
            }
        } else if (clef.rtick().eq(clef.measure().ticks())) {
            moveClef = true
        }
    } else if (e.rtick().isZero()) {
        const curMeasure = e.findMeasure()
        const prevMeasure = curMeasure ? curMeasure.prevMeasure() : null
        if (prevMeasure && !prevMeasure.sectionBreak()) {
            moveClef = true
        }
    }

    const concertPitch = this.style().styleB(Sid.concertPitch)
    let gclef: Clef | null = null
    const tick = e.tick()
    const rtick = e.rtick()
    const isSmall = (st === SegmentType.Clef)
    for (const staff of ostaff.staffList()) {
        if (clefToRelink && ostaff === staff) {
            continue
        }

        const score = staff.score()
        let measure = score.tick2measure(tick)

        if (!measure) {
            continue
        }

        let rt: Fraction
        if (moveClef) { // if at start of measure and there is a previous measure
            measure = measure.prevMeasure()!
            rt = measure.ticks()
        } else {
            rt = rtick
        }
        const destSeg = measure.undoGetSegmentR(st, rt)

        const staffIdx = staff.idx()
        const track = staffIdx * VOICES
        let clef = destSeg.element(track) as Clef | null

        const staffType = staff.staffType(e.tick())
        const staffGroup = staffType.group()
        if (ClefInfo.staffGroup(ct) !== staffGroup && !forInstrumentChange) {
            continue
        }

        if (clef) {
            //
            // for transposing instruments, differentiate
            // clef type for concertPitch
            //
            const i = staff.part().instrument(tick)
            let cp: ClefType
            let tp: ClefType
            if (i.transpose().isZero()) {
                cp = ct
                tp = ct
            } else if (concertPitch) {
                cp = ct
                tp = clef.transposingClef()
            } else {
                cp = clef.concertClef()
                tp = ct
            }
            clef.setGenerated(false)
            score.undo(new ChangeClefType(clef, cp, tp))
            const oClef = clef.otherClef()
            if (oClef && !oClef.generated()) {
                score.undo(new ChangeClefType(oClef, cp, tp))
            }
            // change the clef in the mmRest if any
            if (measure.hasMMRest()) {
                const mmMeasure = measure.mmRest()!
                const mmDestSeg = mmMeasure.findSegment(SegmentType.Clef, tick)
                if (mmDestSeg) {
                    const mmClef = mmDestSeg.element(clef.track()) as Clef | null
                    if (mmClef) {
                        score.undo(new ChangeClefType(mmClef, cp, tp))
                    }
                }
            }
        } else {
            if (gclef) {
                clef = gclef.linkedClone() as Clef
                clef.setScore(score)
            } else {
                clef = Factory.createItem(ElementType.CLEF, destSeg) as Clef // C++: parent score->dummy()->segment()
                clef.setClefType(ct)
                gclef = clef
            }
            clef.setTrack(track)
            clef.setParent(destSeg)
            clef.setIsHeader(st === SegmentType.HeaderClef)
            score.doUndoAddElement(clef)
        }
        if (forInstrumentChange) {
            clef.setForInstrumentChange(true)
        }
        clef.setSmall(isSmall)

        if (clefToRelink) {
            if (!clef.links()) {
                clef.linkTo(clefToRelink)
            } else if (!clef.isLinked(clefToRelink)) {
                clefToRelink.linkTo(clef)
            }
        }
    }
}

Score.prototype.undoUpdatePlayCountText = function (this: Score, _m: Measure | null): void {
    // TODO(port): PlayCountText (Sid::repeatPlayCountShow)
}

Score.prototype.undoChangeBarLineType = function (this: Score, bl: BarLine, barType: BarLineType, allStaves: boolean,
    replace = true): void {
    if (barType === bl.barLineType()) {
        return
    }

    let m = bl.measure()
    if (!m) {
        return
    }

    let keepStartRepeat = false

    if (barType === BarLineType.START_REPEAT && bl.segment().segmentType() !== SegmentType.BeginBarLine) {
        m = m.nextMeasure()
        if (!m) { // we were in last measure
            return
        }
    } else if (bl.barLineType() === BarLineType.START_REPEAT) {
        if (m.system() && m.isFirstInSystem()) {
            if (barType !== BarLineType.END_REPEAT) {
                for (const lscore of this.scoreList()) {
                    const lmeasure = lscore.tick2measure(m.tick())
                    if (lmeasure) {
                        lmeasure.undoChangeProperty(Pid.REPEAT_START, false)
                    }
                }
            }
            return
        }

        m = m.prevMeasureMM()
        if (!m) {
            return
        }

        const ebl = m.endBarLine()
        if (!ebl) {
            return
        }
        bl = ebl

        if (barType === BarLineType.END_REPEAT) {
            keepStartRepeat = true
        }
    }

    // when setting barline type on mmrest, set for underlying measure (and linked staves)
    // createMMRest will then set for the mmrest directly
    let m2: Measure | null = m.isMMRest() ? m.mmRestLast() : m

    switch (barType) {
    case BarLineType.END:
    case BarLineType.NORMAL:
    case BarLineType.DOUBLE:
    case BarLineType.BROKEN:
    case BarLineType.DOTTED:
    case BarLineType.REVERSE_END:
    case BarLineType.HEAVY:
    case BarLineType.DOUBLE_HEAVY: {
        const nextMM = m.nextMeasureMM()
        if (nextMM && nextMM.system() && nextMM.isFirstInSystem()) {
            keepStartRepeat = true
        }

        let segment = bl.segment()
        const segmentType = segment.segmentType()

        if (segmentType === SegmentType.EndBarLine) {
            let generated = false
            if (bl.barLineType() === barType) {
                generated = bl.generated() // no change: keep current status
            } else if (!bl.generated() && (barType === BarLineType.NORMAL)) {
                generated = true // currently non-generated, changing to normal: assume generated
            }
            if (allStaves) {
                // use all staves of master score; we will take care of parts in loop through linked staves below
                const mScore = bl.masterScore()
                if (mScore.style().styleB(Sid.createMultiMeasureRests)) {
                    m2 = mScore.tick2measureMM(m2!.tick())
                    if (!m2) {
                        return
                    }
                    segment = m2.undoGetSegment(segment.segmentType(), segment.tick())
                    m2 = m2.isMMRest() ? m2.mmRestLast() : m2
                    if (!m2) {
                        return
                    }
                } else {
                    m2 = mScore.tick2measure(m2!.tick())
                    if (!m2) {
                        return
                    }
                    segment = m2.undoGetSegment(segment.segmentType(), segment.tick())
                }
            }
            const elist: readonly (EngravingItem | null)[] = allStaves ? [...segment.elist()] : [bl]
            for (const e of elist) {
                if (!e || !e.staff() || !e.isBarLine()) {
                    continue
                }

                // handle linked staves/parts:
                // barlines themselves are not necessarily linked,
                // so use staffList to find linked staves
                const sbl = e as unknown as BarLine
                for (const lstaff of sbl.staff()!.staffList()) {
                    const lscore = lstaff.score()
                    const ltrack = lstaff.idx() * VOICES

                    // handle mmrests:
                    // set the barline on the underlying measure
                    // this will copied to the mmrest during layout, in createMMRest
                    const lmeasure = lscore.tick2measure(m2!.tick())
                    if (!lmeasure) {
                        continue
                    }

                    lmeasure.undoChangeProperty(Pid.REPEAT_END, false)

                    const nextMeasure = lmeasure.nextMeasure()
                    if (nextMeasure && !keepStartRepeat) {
                        nextMeasure.undoChangeProperty(Pid.REPEAT_START, false)
                    }
                    const lsegment = lmeasure.undoGetSegmentR(SegmentType.EndBarLine, lmeasure.ticks())
                    let lbl = lsegment.element(ltrack) as BarLine | null
                    if (!lbl) {
                        lbl = Factory.createItem(ElementType.BAR_LINE, lsegment) as BarLine
                        lbl.setParent(lsegment)
                        lbl.setTrack(ltrack)
                        lbl.setSpanStaff(lstaff.barLineSpan())
                        lbl.setSpanFrom(lstaff.barLineFrom())
                        lbl.setSpanTo(lstaff.barLineTo())
                        lbl.setBarLineType(barType)
                        lbl.setGenerated(generated)
                        lscore.addElement(lbl)
                        if (!generated) {
                            lbl.linkTo(sbl)
                        }
                    } else {
                        lscore.undo(new DropChangeProperty(lbl, Pid.GENERATED, generated, DropPropertyFlags.NOSTYLE))
                        lscore.undo(new DropChangeProperty(lbl, Pid.BARLINE_TYPE, barType, DropPropertyFlags.NOSTYLE))
                        // set generated flag before and after so it sticks on type change and also works on undo/redo
                        lscore.undo(new DropChangeProperty(lbl, Pid.GENERATED, generated, DropPropertyFlags.NOSTYLE))
                        if (lbl !== sbl && !generated && !lbl.links()) {
                            lscore.undo(new Link(lbl, sbl))
                        } else if (lbl !== sbl && generated && lbl.isLinked(sbl)) {
                            lscore.undo(new Unlink(lbl))
                            let linkedOnCoveringMMRest: EngravingItem | null
                            while ((linkedOnCoveringMMRest = sbl.findLinkedInScore(lscore))) {
                                // Edge case: an additional link of this barline exists on the covering mmRest of lbl's measure
                                lscore.undo(new Unlink(linkedOnCoveringMMRest))
                                lscore.doUndoRemoveElement(linkedOnCoveringMMRest)
                            }
                        }
                    }
                }
            }
        } else if (segmentType === SegmentType.BeginBarLine) {
            for (const lscore of m2!.score().scoreList()) {
                const lmeasure = lscore.tick2measure(m2!.tick())!
                const segment1 = lmeasure.undoGetSegmentR(SegmentType.BeginBarLine, new Fraction(0, 1))
                for (const e of segment1.elist()) {
                    if (e) {
                        lscore.undo(new DropChangeProperty(e, Pid.GENERATED, false, DropPropertyFlags.NOSTYLE))
                        lscore.undo(new DropChangeProperty(e, Pid.BARLINE_TYPE, barType, DropPropertyFlags.NOSTYLE))
                        // set generated flag before and after so it sticks on type change and also works on undo/redo
                        lscore.undo(new DropChangeProperty(e, Pid.GENERATED, false, DropPropertyFlags.NOSTYLE))
                    }
                }
            }
        }
        break
    }
    case BarLineType.START_REPEAT: {
        for (let staffIdx = 0; staffIdx < m2!.score().nstaves(); ++staffIdx) {
            if (m2!.isMeasureRepeatGroupWithPrevM(staffIdx)) {
                DropMScore.setError(DropMsError.CANNOT_SPLIT_MEASURE_REPEAT)
                return
            }
        }
        for (const lscore of m2!.score().scoreList()) {
            let lmeasure = lscore.tick2measure(m2!.tick())
            if (lmeasure) {
                lmeasure.undoChangeProperty(Pid.REPEAT_START, true)
                lmeasure = lmeasure.prevMeasure()
                if (lmeasure && replace) {
                    lmeasure.undoChangeProperty(Pid.REPEAT_END, false)
                }
            }
        }
        break
    }
    case BarLineType.END_REPEAT: {
        for (let staffIdx = 0; staffIdx < m2!.score().nstaves(); ++staffIdx) {
            if (m2!.isMeasureRepeatGroupWithNextM(staffIdx)) {
                DropMScore.setError(DropMsError.CANNOT_SPLIT_MEASURE_REPEAT)
                return
            }
        }
        for (const lscore of m2!.score().scoreList()) {
            let lmeasure = lscore.tick2measure(m2!.tick())
            if (lmeasure) {
                lmeasure.undoChangeProperty(Pid.REPEAT_END, true)
                lmeasure = lmeasure.nextMeasure()
                if (lmeasure && replace) {
                    lmeasure.undoChangeProperty(Pid.REPEAT_START, false)
                }
            }
        }
        break
    }
    case BarLineType.END_START_REPEAT: {
        for (let staffIdx = 0; staffIdx < m2!.score().nstaves(); ++staffIdx) {
            if (m2!.isMeasureRepeatGroupWithNextM(staffIdx)) {
                DropMScore.setError(DropMsError.CANNOT_SPLIT_MEASURE_REPEAT)
                return
            }
        }
        for (const lscore of m2!.score().scoreList()) {
            let lmeasure = lscore.tick2measure(m2!.tick())
            if (lmeasure) {
                lmeasure.undoChangeProperty(Pid.REPEAT_END, true)
                lmeasure = lmeasure.nextMeasure()
                if (lmeasure) {
                    lmeasure.undoChangeProperty(Pid.REPEAT_START, true)
                }
            }
        }
        break
    }
    default:
        break
    }

    this.undoUpdatePlayCountText(m)
}

Score.prototype.addHairpin = function (this: Score, hairpin: Hairpin, cr1: ChordRest, cr2: ChordRest | null): void {
    const track = cr1.track()
    const startTick = cr1.tick()

    let endTick = startTick
    if (this.selection().isRange()) {
        endTick = this.selection().tickEnd()
    } else {
        if (cr2 && cr2 !== cr1) {
            endTick = cr2.endTick()
        } else {
            endTick = cr1.isChord() ? (cr1 as unknown as Chord).endTickIncludingTied() : cr1.endTick()
        }
        const startSegment = cr2 ? cr2.segment() : cr1.segment()
        for (let segment: Segment | null = startSegment; segment && segment.tick().lt(endTick);
            segment = segment.next1(CHORD_REST_OR_TIME_TICK_TYPE)) {
            if (segment === startSegment) {
                continue
            }
            if (segment.findAnnotation(ElementType.DYNAMIC, track, track)) {
                endTick = segment.tick()
                break
            }
        }
    }

    hairpin.setTrack(track)
    hairpin.setTrack2(track)
    hairpin.setTick(startTick)
    hairpin.setTick2(endTick)

    this.undoAddElement(hairpin)
}

// =====================================================================================================================
//   Time signature changes that rewrite measures: Score::rewriteMeasures (both overloads) and
//   Score::undoRemoveMeasures of edit.cpp (cmdAddTimeSig is above)
// =====================================================================================================================

declare module '../dom/score' {
    interface Score {
        /**
         * C++ rewriteMeasures(Measure* fm, const Fraction& ns, staff_idx_t staffIdx): rewrite all measures up to the next
         * time signature or section break; and rewriteMeasures(Measure* startMeasure, Measure* endMeasure,
         * const Fraction& newTimeSig, staff_idx_t staffIdx): rewrite all measures from startMeasure to endMeasure
         * (including). If staffIdx is valid, a local time signature change is rewritten.
         */
        rewriteMeasures(fm: Measure, ns: Fraction, staffIdx: staff_idx_t): boolean
        rewriteMeasures(startMeasure: Measure, endMeasure: Measure, newTimeSig: Fraction, staffIdx: staff_idx_t): boolean
        undoRemoveMeasures(m1: Measure, m2: Measure, preserveTies?: boolean, moveStaffTypeChanges?: boolean): void
    }
}

Score.prototype.rewriteMeasures = function (this: Score, a: Measure, b: Measure | Fraction, c: Fraction | staff_idx_t,
    d?: staff_idx_t): boolean {
    if (b instanceof Fraction) {
        return rewriteMeasuresUpToNextTimeSig(this, a, b, c as staff_idx_t)
    }
    return rewriteMeasuresRange(this, a, b, c as Fraction, d!)
}

/** C++ bool Score::rewriteMeasures(Measure* startMeasure, Measure* endMeasure, const Fraction& newTimeSig, staff_idx_t staffIdx) */
function rewriteMeasuresRange(score: Score, startMeasure: Measure, endMeasure: Measure, newTimeSig: Fraction, staffIdx: staff_idx_t): boolean {
    if (staffIdx !== nidx) {
        // local timesig
        // don't actually rewrite, just update measure rest durations
        // abort if there is anything other than measure rests in range
        const strack = staffIdx * VOICES
        const etrack = strack + VOICES
        for (let m: Measure | null = startMeasure; m; m = m.nextMeasure()) {
            for (let s = m.first(SegmentType.ChordRest); s; s = s.next(SegmentType.ChordRest)) {
                for (let track = strack; track < etrack; ++track) {
                    const cr = s.element(track) as ChordRest | null
                    if (!cr) {
                        continue
                    }
                    if (cr.isRest() && cr.durationType().type() === DurationType.V_MEASURE) {
                        cr.undoChangeProperty(Pid.DURATION, newTimeSig)
                    } else {
                        return false
                    }
                }
            }
            if (m === endMeasure) {
                break
            }
        }
        return true
    }

    let fmr = true

    // Format: chord 1 tick, chord 2 tick, tremolo, track
    const tremoloChordTicks: [Fraction, Fraction, TremoloTwoChord, track_idx_t][] = []

    const strack = 0
    const etrack = score.ntracks()

    const endOfMeasureTimeSigsToRemove: Segment[] = []

    for (let m: Measure | null = startMeasure; m; m = m.nextMeasure()) {
        if (!m.isFullMeasureRest()) {
            fmr = false
        }

        for (let s = m.first(); s; s = s.next()) {
            if (!s.isChordRestType() && !(s.isTimeSigType() && s.endOfMeasureChange())) {
                continue
            }

            if (s.isTimeSigType()) {
                endOfMeasureTimeSigsToRemove.push(s)
                continue
            }

            for (let track = strack; track < etrack; ++track) {
                const cr = s.element(track) as ChordRest | null
                if (cr && cr.isChord()) {
                    const chord = cr as unknown as Chord
                    if (chord.tremoloTwoChord()) {
                        const trem = chord.tremoloTwoChord()!

                        // Don't add same chord twice
                        if (trem.chord2() === chord) {
                            continue
                        }

                        tremoloChordTicks.push([cr.tick(), trem.chord2()!.segment().tick(), trem, track])
                    }
                }
            }
        }

        if (m === endMeasure) {
            break
        }
    }

    if (!fmr) {
        // check for local time signatures
        for (let m: Measure | null = startMeasure; m; m = m.nextMeasure()) {
            for (let si = 0; si < score.nstaves(); ++si) {
                if (!score.staff(si)!.timeStretch(m.tick()).eq(new Fraction(1, 1))) {
                    // we cannot change a staff with a local time signature
                    return false
                }
                if (m === endMeasure) {
                    break // (like C++: only leaves the staff loop)
                }
            }
        }
    }

    for (const seg of endOfMeasureTimeSigsToRemove) {
        score.doUndoRemoveElement(seg)
    }

    const range = new ScoreRange()
    const nextMeasure = endMeasure.nextMeasure()
    let finalSeg = endMeasure.last()!
    if (nextMeasure) {
        finalSeg = nextMeasure.first()!
    }
    range.read(startMeasure.first()!, finalSeg)

    //
    // calculate number of required measures = newMeasures
    //
    const ticks = range.ticks().isNotZero() ? range.ticks() : score.endTick().minus(startMeasure.first()!.tick())
    const k = ticks.div(newTimeSig)
    const newMeasures = Math.trunc((k.numerator() + k.denominator() - 1) / k.denominator())

    const newDuration = newTimeSig.times(new Fraction(newMeasures, 1))

    // evtl. we have to fill the last measure
    const fill = newDuration.minus(ticks)
    range.fill(fill)

    for (const s of score.scoreList()) {
        const m1 = s.tick2measure(startMeasure.tick())!
        const m2 = s.tick2measure(endMeasure.tick())!

        const tick1 = m1.tick()
        const tick2 = m2.endTick()
        const spanners = s.spannerMap().findOverlapping(tick1.ticks(), tick2.ticks())
        for (const sp of spanners) {
            if (sp.tick().ge(tick1) && sp.tick().lt(tick2)) {
                score.doUndoRemoveElement(sp)
            }
        }
        s.undoRemoveMeasures(m1, m2, true)

        let newFirstMeasure: Measure | null = null
        let newLastMeasure: Measure | null = null
        let tick = startMeasure.tick()
        for (let i = 0; i < newMeasures; ++i) {
            const m = Factory.createItem(ElementType.MEASURE, s.dummySystem()) as Measure
            m.setPrev(newLastMeasure)
            if (newLastMeasure) {
                newLastMeasure.setNext(m)
            }
            m.setTimesig(newTimeSig)
            m.setTicks(newTimeSig)
            m.setTick(tick)
            tick = tick.plus(m.ticks())
            newLastMeasure = m
            if (!newFirstMeasure) {
                newFirstMeasure = m
            }
        }
        //
        // insert new calculated measures
        //
        newFirstMeasure!.setPrev(m1.prev())
        newLastMeasure!.setNext(m2.next())
        s.undo(new InsertMeasures(newFirstMeasure!, newLastMeasure!))
    }
    if (!fill.isZero()) {
        score.undoInsertTime(endMeasure.endTick(), fill)
    }

    if (!range.write(score.masterScore(), startMeasure.tick())) {
        return false
    }

    for (const s of score.scoreList()) {
        s.connectTies(true)
    }

    // reset start and end elements for slurs that overlap the rewritten measures
    for (const spanner of score.spannerMap().findOverlapping(startMeasure.tick().ticks(), endMeasure.tick().ticks())) {
        const slur = spanner.isSlur() ? spanner : null
        if (slur) {
            const startEl = slur.startElement()
            const endEl = slur.endElement()
            if (!startEl || !endEl) {
                continue
            }
            score.undo(new ChangeStartEndSpanner(spanner, slur.findStartCR(), slur.findEndCR()))
        }
    }
    // Attempt to move tremolos to correct chords
    for (const [chord1Tick, chord2Tick, trem, track] of tremoloChordTicks) {
        score.undo(new MoveTremolo(trem.score(), chord1Tick, chord2Tick, trem, track))
    }

    if (score.noteEntryMode()) {
        // set input cursor to possibly re-written segment
        const icTick = score.inputState().tick()
        let icSegment = score.tick2segment(icTick, false, SegmentType.ChordRest)
        if (!icSegment) {
            // this can happen if cursor was on a rest
            // and in the rewriting it got subsumed into a full measure rest
            let icMeasure = score.tick2measure(icTick)
            if (!icMeasure) { // shouldn't happen, but just in case
                icMeasure = score.firstMeasure()
            }
            icSegment = icMeasure!.first(SegmentType.ChordRest)
        }
        score.inputState().setSegment(icSegment)
    }

    return true
}

/** C++ bool Score::rewriteMeasures(Measure* fm, const Fraction& ns, staff_idx_t staffIdx) */
function rewriteMeasuresUpToNextTimeSig(score: Score, fm: Measure, ns: Fraction, staffIdx: staff_idx_t): boolean {
    let lm: Measure | null = fm
    let fm1: Measure | null = fm
    let nm: Measure | null = null
    let sectionBreak: LayoutBreak | null = null
    let endOfMeasureTimeSigSeg: Segment | null = null

    //
    // split into Measure segments fm-lm
    //
    const foundLM = (curMeas: MeasureBase | null, curLM: Measure): boolean => {
        if (!curMeas || !curMeas.isMeasure() || curLM.sectionBreak()) {
            return true
        }
        let timeSigSeg = (curMeas as Measure).findSegmentR(SegmentType.TimeSig, new Fraction(0, 1))
        if (!timeSigSeg && curMeas.prevMeasure()) {
            // find time sig at end of previous measure
            const prevMeasure = curMeas.prevMeasure()!
            timeSigSeg = prevMeasure.findSegmentR(SegmentType.TimeSig, prevMeasure.ticks())
            if (timeSigSeg) {
                endOfMeasureTimeSigSeg = timeSigSeg
            }
        }
        if (timeSigSeg && curMeas !== fm) {
            return staffIdx === nidx || !!timeSigSeg.element(staff2track(staffIdx))
        }
        return false
    }
    for (let measure: MeasureBase | null = fm; ; measure = measure!.next()) {
        if (foundLM(measure, lm!)) {
            // save section break to reinstate after rewrite
            const layoutBreak = lm!.sectionBreakElement()

            if (lm && layoutBreak) {
                sectionBreak = layoutBreak.clone() as LayoutBreak // Factory::copyLayoutBreak
            }

            if (!score.rewriteMeasures(fm1!, lm!, ns, staffIdx)) {
                if (staffIdx !== nidx) {
                    MScore.setError(MsError.CANNOT_CHANGE_LOCAL_TIMESIG_MEASURE_NOT_EMPTY)
                    // restore measure rests that were prematurely modified
                    const fr = score.staff(staffIdx)!.timeSig(fm.tick())!.sig()
                    for (let m: Measure | null = fm1; m; m = m.nextMeasure()) {
                        const cr = m.findChordRest(m.tick(), staffIdx * VOICES)
                        if (cr && cr.isRest() && cr.durationType().type() === DurationType.V_MEASURE) {
                            cr.undoChangeProperty(Pid.DURATION, fr)
                        } else {
                            break
                        }
                    }
                }
                for (let m: Measure | null = fm1; m; m = m.nextMeasure()) {
                    if (m.first(SegmentType.TimeSig)) {
                        break
                    }
                    const fr = ns
                    m.undoChangeProperty(Pid.TIMESIG_NOMINAL, fr)
                }
                return false
            }

            // after rewrite, lm is not necessarily valid
            // m is first MeasureBase after rewritten range
            // m->prevMeasure () is new last measure of range
            // set nm to first true Measure after rewritten range
            // we may use this to reinstate time signatures
            if (measure && measure.prevMeasure()) {
                nm = measure.prevMeasure()!.nextMeasure()
            } else {
                nm = null
            }

            if (sectionBreak) {
                // reinstate section break, then stop rewriting
                if (measure && measure.prevMeasure()) {
                    sectionBreak.setParent(measure.prevMeasure())
                    score.undoAddElement(sectionBreak)
                } else if (!measure) {
                    sectionBreak.setParent(score.lastMeasure())
                    score.undoAddElement(sectionBreak)
                } else {
                    // C++: LOGD("unable to restore section break")
                    nm = null
                    sectionBreak = null
                }
                break
            }

            // stop rewriting at end of score
            // or at a measure (which means we found a time signature segment)
            if (!measure || measure.isMeasure()) {
                break
            }

            // skip frames
            while (!measure.isMeasure()) {
                const layoutBreak2 = measure.sectionBreakElement()

                if (layoutBreak2) {
                    // frame has a section break; we can stop skipping ahead
                    sectionBreak = layoutBreak2
                    break
                }
                measure = measure.next()
                if (!measure) {
                    break
                }
            }
            // stop rewriting if we encountered a section break on a frame
            // or if there is a time signature on first measure after the frame
            if (sectionBreak || (measure && (measure as Measure).first(SegmentType.TimeSig))) {
                break
            }

            // set up for next range to rewrite
            fm1 = measure as Measure | null
            if (!fm1) {
                break
            }
        }

        // if we didn't break the loop already,
        // we must have an ordinary measure
        // add measure to range to rewrite
        lm = measure as Measure | null
    }

    // if any staves don't have time signatures at the point where we stopped,
    // we need to reinstate their previous time signatures
    if (!nm) {
        return true
    }
    const nmm = nm as Measure
    const timeSigSeg = nmm.undoGetSegment(SegmentType.TimeSig, nmm.tick())

    for (let i = 0; i < score.nstaves(); ++i) {
        if (staffIdx !== nidx && i !== staffIdx) {
            continue
        }
        if (!timeSigSeg.element(staff2track(i))) {
            const eomSeg = endOfMeasureTimeSigSeg as Segment | null
            const ots = eomSeg ? eomSeg.element(staff2track(i)) as TimeSig | null : score.staff(i)!.timeSig(nmm.tick())
            if (ots) {
                const nts = ots.clone() as TimeSig // Factory::copyTimeSig
                nts.setParent(timeSigSeg)
                if (sectionBreak) {
                    nts.setGenerated(false)
                    nts.setShowCourtesySig(false)
                }
                score.undoAddElement(nts)
            }
        }
    }

    return true
}

Score.prototype.undoRemoveMeasures = function (this: Score, m1: Measure, m2: Measure, preserveTies = false,
    moveStaffTypeChanges = true): void {
    const startTick = m1.tick()
    const endTick = m2.endTick()
    const spannersToRemove = new Set<Spanner>()

    //
    //  handle ties which start before m1 and end in (m1-m2)
    //
    for (let s = m1.first(); s !== m2.last(); s = s!.next1()) {
        if (!s) {
            // This score is corrupted; handle it without crashing,
            // to help the user to fix corruptions by deleting the affected measures
            break
        }

        if (!s.isChordRestType()) {
            continue
        }

        // Make sure annotations are removed once, even if this segment contains linked copies of the same annotation
        // (the linked copy would be removed by undoRemoveElement)
        while (s.annotations().length) {
            const annotation = s.annotations()[0]
            this.undoRemoveElement(annotation)
        }

        for (let track = 0; track < this.ntracks(); ++track) {
            const e = s.element(track)
            if (!e || !e.isChord()) {
                continue
            }
            const c = e as Chord
            for (const n of c.notes()) {
                // Remove ties crossing measure range boundaries
                let t = n.tieBackNonPartial()
                if (t && t.startNote() && t.startNote()!.chord().tick().lt(startTick)) {
                    if (preserveTies) {
                        t.setEndNote(null)
                    } else {
                        this.undoRemoveElement(t)
                    }
                }
                t = n.tieForNonPartial()
                if (t && t.endNote() && t.endNote()!.chord().tick().ge(endTick)) {
                    this.undoRemoveElement(t)
                }

                // Do the same for other note-anchored spanners (e.g. glissandi).
                // Delay actual removing to avoid modifying lists inside loops over them.
                for (const sb of n.spannerBack()) {
                    if (sb.tick().lt(startTick)) {
                        spannersToRemove.add(sb)
                    }
                }
                for (const sf of n.spannerFor()) {
                    if (sf.tick2().ge(endTick)) {
                        spannersToRemove.add(sf)
                    }
                }
            }
        }
    }

    for (const s of spannersToRemove) {
        this.undoRemoveElement(s)
    }

    // delete staffTypeChanges in removed measures
    if (moveStaffTypeChanges) {
        for (let m: Measure | null = m1; m && m !== m2.nextMeasure(); m = m.nextMeasure()) {
            for (let i = m.el().length; i > 0; --i) {
                const el = m.el()[i - 1]
                if (el && el.isStaffTypeChange()) {
                    this.deleteItem(el)
                }
            }
        }
    }

    EditSystemLocks.removeSystemLocksOnRemoveMeasures(this, m1, m2)

    this.undo(new RemoveMeasures(m1, m2, moveStaffTypeChanges))
}

// =====================================================================================================================
//   text editing: the texts of Score::addText that need a chord/rest (edit.cpp), the rehearsal mark texts (score.cpp)
// =====================================================================================================================

declare module '../dom/score' {
    interface Score {
        createRehearsalMarkText(current: RehearsalMark): string
        nextRehearsalMarkText(previous: RehearsalMark, current: RehearsalMark | null): string
    }
}

/** the cases of Score::addText for rehearsal marks, staff/system texts, dynamics, ..., chord symbols, lyrics, tempo */
function addTextToChordRest(score: Score, type: TextStyleType, destinationElement: EngravingItem | null): TextBase | null {
    let textBox: TextBase | null = null

    switch (type) {
    case TextStyleType.REHEARSAL_MARK: {
        const chordRest = chordOrRest(destinationElement)
        if (!chordRest) {
            break
        }
        textBox = Factory.createItem(ElementType.REHEARSAL_MARK, chordRest.segment()) as unknown as TextBase
        textBox.setParent(chordRest.segment())
        textBox.setTrack(0)
        textBox.setXmlText(score.createRehearsalMarkText(textBox as unknown as RehearsalMark))
        chordRest.undoAddAnnotation(textBox)
        break
    }
    case TextStyleType.STAFF: {
        const chordRest = chordOrRest(destinationElement)
        if (!chordRest) {
            break
        }
        textBox = new StaffText(scoreDummy(score).segment(), TextStyleType.STAFF)
        chordRest.undoAddAnnotation(textBox)
        break
    }
    case TextStyleType.SYSTEM: {
        const chordRest = chordOrRest(destinationElement)
        if (!chordRest) {
            break
        }
        textBox = new SystemText(scoreDummy(score).segment(), TextStyleType.SYSTEM)
        chordRest.undoAddAnnotation(textBox)
        break
    }
    case TextStyleType.DYNAMICS:
    case TextStyleType.EXPRESSION:
    case TextStyleType.INSTRUMENT_CHANGE: {
        const chordRest = chordOrRest(destinationElement)
        if (!chordRest) {
            break
        }
        const elementType = type === TextStyleType.DYNAMICS ? ElementType.DYNAMIC
            : type === TextStyleType.EXPRESSION ? ElementType.EXPRESSION : ElementType.INSTRUMENT_CHANGE
        textBox = Factory.createItem(elementType, scoreDummy(score).segment()) as unknown as TextBase
        chordRest.undoAddAnnotation(textBox)
        break
    }
    case TextStyleType.STICKING: {
        const chordRest = chordOrRest(destinationElement)
        if (!chordRest) {
            break
        }
        textBox = Factory.createItem(ElementType.STICKING, scoreDummy(score).segment()) as unknown as TextBase
        chordRest.undoAddAnnotation(textBox)
        break
    }
    case TextStyleType.FINGERING:
    case TextStyleType.LH_GUITAR_FINGERING:
    case TextStyleType.RH_GUITAR_FINGERING:
    case TextStyleType.STRING_NUMBER: {
        if (!destinationElement || !destinationElement.isNote()) {
            break
        }

        const staff = destinationElement.staff()!
        const isTablature = staff.isTabStaff(destinationElement.tick())
        const tabFingering = staff.staffType(destinationElement.tick()).showTabFingering()
        if (isTablature && !tabFingering) {
            break
        }

        textBox = new Fingering(destinationElement as unknown as Note, type)
        textBox.setTrack(destinationElement.track())
        textBox.setParent(destinationElement)
        score.undoAddElement(textBox)
        break
    }
    case TextStyleType.HARMONY_A:
    case TextStyleType.HARMONY_ROMAN:
    case TextStyleType.HARMONY_NASHVILLE: {
        let track = nidx
        let newParent: EngravingItem | null = null
        if (destinationElement && destinationElement.isFretDiagram()) {
            const fretDiagram = destinationElement as unknown as FretDiagram
            track = fretDiagram.track()
            newParent = fretDiagram.harmony() ? fretDiagram.segment() as unknown as EngravingItem : fretDiagram as unknown as EngravingItem
        } else {
            const chordRest = chordOrRest(destinationElement)
            if (chordRest) {
                track = chordRest.track()
                newParent = chordRest.segment()
            }
        }

        if (track === nidx || !newParent) {
            break
        }

        const harmony = Factory.createItem(ElementType.HARMONY, newParent) as Harmony
        harmony.setTrack(track)
        harmony.setParent(newParent)

        const harmonyTypes = new Map<TextStyleType, HarmonyType>([
            [TextStyleType.HARMONY_A, HarmonyType.STANDARD],
            [TextStyleType.HARMONY_ROMAN, HarmonyType.ROMAN],
            [TextStyleType.HARMONY_NASHVILLE, HarmonyType.NASHVILLE],
        ])
        harmony.setHarmonyType(harmonyTypes.get(type)!)

        textBox = harmony
        score.undoAddElement(textBox)
        break
    }
    case TextStyleType.LYRICS_ODD: {
        if (!destinationElement || (!destinationElement.isNote() && !destinationElement.isLyrics() && !destinationElement.isRest())) {
            break
        }
        let chordRest: ChordRest | null = null
        if (destinationElement.isNote()) {
            chordRest = (destinationElement as unknown as Note).chord()
            if (chordRest.isGrace()) {
                chordRest = chordRest.explicitParent() as unknown as ChordRest
            }
        } else if (destinationElement.isLyrics()) {
            chordRest = (destinationElement as unknown as Lyrics).chordRest()
        } else if (destinationElement.isRest()) {
            chordRest = destinationElement as unknown as ChordRest
        } else {
            break
        }

        const no = chordRest.lyrics().length
        // TODO(port): partial lyrics lines starting at the chord/rest (PartialLyricsLine) raise the verse number

        const lyrics = Factory.createItem(ElementType.LYRICS, chordRest) as Lyrics
        lyrics.setTrack(chordRest.track())
        lyrics.setParent(chordRest)
        lyrics.setProperty(Pid.VERSE, no)

        textBox = lyrics
        score.undoAddElement(textBox)
        break
    }
    case TextStyleType.TEMPO: {
        const chordRest = chordOrRest(destinationElement)
        if (!chordRest) {
            break
        }

        const event = score.sigmap().timesig(chordRest.tick())
        const f = event.nominal()
        let text = '<sym>metNoteQuarterUp</sym> = 80'
        switch (f.denominator()) {
        case 1:
            text = '<sym>metNoteWhole</sym> = 80'
            break
        case 2:
            text = '<sym>metNoteHalfUp</sym> = 80'
            break
        case 4:
            text = '<sym>metNoteQuarterUp</sym> = 80'
            break
        case 8:
            if (f.numerator() % 3 === 0) {
                text = '<sym>metNoteQuarterUp</sym><sym>space</sym><sym>metAugmentationDot</sym> = 80'
            } else {
                text = '<sym>metNote8thUp</sym> = 80'
            }
            break
        case 16:
            if (f.numerator() % 3 === 0) {
                text = '<sym>metNote8thUp</sym><sym>space</sym><sym>metAugmentationDot</sym> = 80'
            } else {
                text = '<sym>metNote16thUp</sym> = 80'
            }
            break
        case 32:
            if (f.numerator() % 3 === 0) {
                text = '<sym>metNote16thUp</sym><sym>space</sym><sym>metAugmentationDot</sym> = 80'
            } else {
                text = '<sym>metNote32ndUp</sym> = 80'
            }
            break
        case 64:
            if (f.numerator() % 3 === 0) {
                text = '<sym>metNote32ndUp</sym><sym>space</sym><sym>metAugmentationDot</sym> = 80'
            } else {
                text = '<sym>metNote64thUp</sym> = 80'
            }
            break
        case 128:
            if (f.numerator() % 3 === 0) {
                text = '<sym>metNote64ndUp</sym><sym>space</sym><sym>metAugmentationDot</sym> = 80'
            } else {
                text = '<sym>metNote128thUp</sym> = 80'
            }
            break
        default:
            break
        }

        const tempoText = Factory.createItem(ElementType.TEMPO_TEXT, chordRest.segment()) as TempoText
        tempoText.setParent(chordRest.segment())
        tempoText.setTrack(0)
        tempoText.setXmlText(text)
        tempoText.setFollowText(true)
        tempoText.updateTempo()

        textBox = tempoText
        score.undoAddElement(textBox)
        break
    }
    case TextStyleType.HARP_PEDAL_DIAGRAM:
    case TextStyleType.HARP_PEDAL_TEXT_DIAGRAM:
        // TODO(port): HarpPedalDiagram (element type not ported)
        break
    default:
        break
    }

    return textBox
}

Score.prototype.createRehearsalMarkText = function (this: Score, current: RehearsalMark): string {
    const tick = current.segment().tick()
    let before: RehearsalMark | null = null
    let after: RehearsalMark | null = null
    const firstMeasure = this.firstMeasure() // C++ firstSegment(SegmentType::All)
    for (let s = firstMeasure ? firstMeasure.first(SegmentType.All) : null; s; s = s.next1()) {
        for (const e of s.annotations()) {
            if (e && e.isRehearsalMark()) {
                if (s.tick().lt(tick)) {
                    before = e as unknown as RehearsalMark
                } else if (s.tick().gt(tick)) {
                    after = e as unknown as RehearsalMark
                    break
                }
            }
        }
        if (after) {
            break
        }
    }
    let s = 'A'
    const s1 = before ? before.xmlText() : ''
    const s2 = after ? after.xmlText() : ''
    if (s1.length === 0) {
        return s
    }
    s = this.nextRehearsalMarkText(before!, current) // try to sequence
    if (s === current.xmlText()) {
        // no sequence detected (or current happens to be correct)
        return s
    } else if (s === s2) {
        // next in sequence already present
        if (isLetter(s1[0])) {
            if (s1.length === 2) {
                s = s1[0] + String.fromCharCode(s1.charCodeAt(1) + 1) // BB, BC, CC
            } else {
                s = s1 + '1' // B, B1, C
            }
        } else {
            s = s1 + 'A' // 2, 2A, 3
        }
    }
    return s
}

/**
 * finds next rehearsal in sequence established by previous
 *  Alphabetic sequences:
 *   A, B, ..., Y, Z, AA, BB, ..., YY, ZZ
 *   a, b, ..., y, z, aa, bb, ..., yy, zz
 *  Numeric sequences:
 *   1, 2, 3, ...
 *   If number of previous rehearsal mark matches measure number, assume use of measure numbers throughout
 */
Score.prototype.nextRehearsalMarkText = function (this: Score, previous: RehearsalMark, current: RehearsalMark | null): string {
    const previousText = previous.xmlText()
    const fallback = current ? current.xmlText() : previousText + '\''

    if (previousText.length === 1 && isLetter(previousText[0])) {
        // single letter sequence
        if (previousText === 'Z') {
            return 'AA'
        } else if (previousText === 'z') {
            return 'aa'
        } else {
            return String.fromCharCode(previousText.charCodeAt(0) + 1)
        }
    } else if (previousText.length === 2 && isLetter(previousText[0]) && isLetter(previousText[1])) {
        // double letter sequence
        if (previousText[0] === previousText[1]) {
            // repeated letter sequence
            if (previousText.toUpperCase() !== 'ZZ') {
                const c = String.fromCharCode(previousText.charCodeAt(0) + 1)
                return c + c
            } else {
                return fallback
            }
        } else {
            return fallback
        }
    } else {
        // try to interpret as number
        if (!/^\s*[+-]?\d+\s*$/.test(previousText)) {
            return fallback
        }
        let n = parseInt(previousText, 10)
        if (current && n === previous.segment().measure().no() + 1) {
            // use measure number
            n = current.segment().measure().no() + 1
            return String(n)
        } else {
            // use number sequence
            n = n + 1
            return String(n)
        }
    }
}

function isLetter(c: string | undefined): boolean {
    return !!c && /\p{L}/u.test(c)
}

// =====================================================================================================================
//   edit.cpp functions of note input and the line/tuplet commands (addTuplet, cmdCreateTuplet, addSlur, addHairpins,
//   cmdAddOttava, cmdSetBeamMode, cmdFullMeasureRest, ...)
// =====================================================================================================================

// (imports of this section; ES imports are hoisted)
import { ClefToBarlinePosition, SpannerSegmentType } from '../types/types'
import { ChordRest as NoteInputChordRest } from '../dom/chordrest'
import { TupletBracketType, TupletNumberType, type Tuplet as NoteInputTuplet } from '../dom/tuplet'
import { HairpinType } from '../dom/hairpin'
import { OttavaType, type Ottava } from '../dom/ottava'
import { Grip } from './editdata'
import { PointF as NoteInputPointF } from '../../framework/draw/types/geometry'
import type { Slur } from '../dom/slur'

declare module '../dom/chordrest' {
    interface ChordRest {
        /** C++ ChordRest::slur(const ChordRest* secondChordRest): the slur from this chord rest to the second one */
        slur(secondChordRest?: ChordRest | null): Slur | null
    }
}

declare module '../dom/score' {
    interface Score {
        /** C++ getSelectedStartEndChordRests(ChordRest*&, ChordRest*&): [cr1, cr2] (cr2 is null if it is cr1) */
        getSelectedStartEndChordRests(): [ChordRest | null, ChordRest | null]
        addTuplet(destinationChordRest: ChordRest, ratio: Fraction, numberType: TupletNumberType,
            bracketType: TupletBracketType): NoteInputTuplet | null
        /** replace cr with tuplet */
        cmdCreateTuplet(ocr: ChordRest, tuplet: NoteInputTuplet): void
        addSlur(firstChordRest: ChordRest, secondChordRest: ChordRest | null, slurTemplate: Slur | null): Slur
        addHairpins(type: HairpinType): Hairpin[]
        /** C++ addHairpin(HairpinType, ChordRest*, ChordRest*) */
        addHairpinOfType(type: HairpinType, cr1: ChordRest | null, cr2: ChordRest | null): Hairpin | null
        /** C++ addHairpin(HairpinType, Fraction, Fraction, track_idx_t) */
        addHairpinAtTicks(type: HairpinType, sTick: Fraction, eTick: Fraction, track: track_idx_t): Hairpin
        cmdAddOttava(type: OttavaType): void
        cmdSetBeamMode(mode: BeamMode): void
        cmdFullMeasureRest(): void
    }
}

NoteInputChordRest.prototype.slur = function (this: ChordRest, secondChordRest: ChordRest | null = null): Slur | null {
    if (!secondChordRest) {
        // TODO(port): ChordRestNavigateOptions disableOverRepeats
        secondChordRest = nextChordRest(this)
    }
    const currentTick = this.tick().ticks()
    let result: Slur | null = null
    for (const spanner of this.score().spannerMap().findOverlapping(currentTick, currentTick + 1)) {
        if (!spanner.isSlur()) {
            continue
        }
        const slur = spanner as unknown as Slur
        if (slur.startElement() === this && slur.endElement() === secondChordRest) {
            if (slur.slurDirection() === DirectionV.AUTO) {
                return slur
            }
            result = slur
        }
    }
    return result
}

Score.prototype.getSelectedStartEndChordRests = function (this: Score): [ChordRest | null, ChordRest | null] {
    let cr1: ChordRest | null = null
    let cr2: ChordRest | null = null
    for (let e of this.selection().elements()) {
        if (e.isNote()) {
            e = e.parentItem()!
        }
        if (e.isChordRest()) {
            const cr = e as unknown as ChordRest
            if (!cr1 || cr1.tick().gt(cr.tick())) {
                cr1 = cr
            }
            if (!cr2 || cr2.tick().lt(cr.tick())) {
                cr2 = cr
            }
        }
    }
    if (!cr1) {
        MScore.setError(MsError.NO_NOTE_REST_SELECTED)
    }
    if (cr1 === cr2) {
        cr2 = null
    }
    return [cr1, cr2]
}

Score.prototype.addTuplet = function (this: Score, destinationChordRest: ChordRest, ratio: Fraction,
    numberType: TupletNumberType, bracketType: TupletBracketType): NoteInputTuplet | null {
    if (destinationChordRest.durationType().lt(new TDuration(DurationType.V_512TH))
        && !destinationChordRest.durationType().equals(new TDuration(DurationType.V_MEASURE))) {
        return null
    }

    const measure = destinationChordRest.measure()
    if (measure && measure.isMMRest()) {
        return null
    }

    let f = destinationChordRest.ticks()
    const ot = destinationChordRest.tuplet()

    f = f.reduced() //measure duration might not be reduced

    const _ratio = new Fraction(ratio.numerator() !== -1 ? ratio.numerator() : f.numerator(),
        ratio.denominator() !== -1 ? ratio.denominator() : f.numerator())

    const fr = f.times(new Fraction(1, _ratio.denominator()))
    if (!TDuration.isValidFraction(fr)) {
        // TODO(port): MessageBox warning "Cannot create tuplet with ratio %1 for duration %2"
        return null
    }

    const tuplet = Factory.createItem(ElementType.TUPLET, measure) as unknown as NoteInputTuplet
    tuplet.setRatio(_ratio)

    tuplet.setNumberType(numberType)
    if (tuplet.numberType() === (tuplet.style().styleI(Sid.tupletNumberType) as TupletNumberType)) {
        tuplet.setPropertyFlags(Pid.NUMBER_TYPE, PropertyFlags.STYLED)
    } else {
        tuplet.setPropertyFlags(Pid.NUMBER_TYPE, PropertyFlags.UNSTYLED)
    }

    tuplet.setBracketType(bracketType)
    if (tuplet.bracketType() === (tuplet.style().styleI(Sid.tupletBracketType) as TupletBracketType)) {
        tuplet.setPropertyFlags(Pid.BRACKET_TYPE, PropertyFlags.STYLED)
    } else {
        tuplet.setPropertyFlags(Pid.BRACKET_TYPE, PropertyFlags.UNSTYLED)
    }

    tuplet.setTicks(f)
    tuplet.setBaseLen(new TDuration(fr))

    tuplet.setTrack(destinationChordRest.track())
    tuplet.setTick(destinationChordRest.tick())
    tuplet.setParent(measure)

    if (ot) {
        tuplet.setTuplet(ot)
    }

    this.cmdCreateTuplet(destinationChordRest, tuplet)

    const elements = tuplet.elements()
    let elementForSelect: DurationElement | null = null
    if (elements.length) {
        const firstElement = elements[0]
        if (firstElement.isRest()) {
            elementForSelect = firstElement
        } else if (elements.length > 1) {
            elementForSelect = elements[1]
        }
    }

    if (elementForSelect) {
        this.score().select(elementForSelect, SelectType.SINGLE, 0)
        this.score().inputState().setDuration(tuplet.baseLen())
    }

    return tuplet
}

Score.prototype.cmdCreateTuplet = function (this: Score, ocr: ChordRest, tuplet: NoteInputTuplet): void {
    const track = ocr.track()
    const measure = ocr.measure()
    let tick = ocr.tick()
    const an = tuplet.ticks().times(tuplet.ratio()).div(tuplet.baseLen().fraction())
    if (!an.denominator()) {
        return
    }

    if (ocr.tuplet()) {
        tuplet.setTuplet(ocr.tuplet())
    }
    this.removeChordRest(ocr, false)

    let cr: ChordRest
    if (ocr.isChord()) {
        const chord = Factory.createItem(ElementType.CHORD, scoreDummy(this).segment()) as unknown as Chord
        cr = chord
        chord.setStemDirection((ocr as unknown as Chord).stemDirection())
        for (const oldNote of (ocr as unknown as Chord).notes()) {
            const note = Factory.createItem(ElementType.NOTE, chord) as unknown as Note
            note.setPitch(oldNote.pitch())
            note.setTpc1(oldNote.tpc1())
            note.setTpc2(oldNote.tpc2())
            cr.add(note)
        }
    } else {
        cr = Factory.createItem(ElementType.REST, scoreDummy(this).segment()) as unknown as ChordRest
    }

    const actualNotes = Math.trunc(an.numerator() / an.denominator())

    tuplet.setTrack(track)
    cr.setTuplet(tuplet)
    cr.setTrack(track)
    cr.setDurationType(tuplet.baseLen())
    cr.setTicks(tuplet.baseLen().fraction())

    this.undoAddCR(cr, measure, tick)

    const ticks = cr.actualTicks()

    for (let i = 0; i < (actualNotes - 1); ++i) {
        tick = tick.plus(ticks)
        const rest = Factory.createItem(ElementType.REST, scoreDummy(this).segment()) as unknown as Rest
        rest.setTuplet(tuplet)
        rest.setTrack(track)
        rest.setDurationType(tuplet.baseLen())
        rest.setTicks(tuplet.baseLen().fraction())
        this.undoAddCR(rest, measure, tick)
    }
}

Score.prototype.addSlur = function (this: Score, firstChordRest: ChordRest, secondChordRest: ChordRest | null,
    slurTemplate: Slur | null): Slur {
    if (!secondChordRest) {
        // TODO(port): ChordRestNavigateOptions disableOverRepeats
        secondChordRest = nextChordRest(firstChordRest)

        if (!secondChordRest || !secondChordRest.isChord()) {
            // TODO(port): hammer-on/pull-off templates (GuitarBend::createEndNote)
            if (!secondChordRest) {
                secondChordRest = firstChordRest
            }
        } else if (secondChordRest.isChord()) {
            const firstChordRestIsTiedToSecond = firstChordRest.isChord() && (firstChordRest as unknown as Chord).allNotesTiedToNext()
                && (firstChordRest as unknown as Chord).upNote().tieFor()!.endNote()!.parent() === secondChordRest

            // Follow chain of tied notes and slur until the last
            if (firstChordRestIsTiedToSecond || !firstChordRest.isGrace()) {
                while ((secondChordRest as unknown as Chord).allNotesTiedToNext()) {
                    secondChordRest = (secondChordRest as unknown as Chord).upNote().tieFor()!.endNote()!.chord()
                }
            }

            // If the first chord rest is also tied to this chain, slur to the next non-tied note
            if (firstChordRestIsTiedToSecond) {
                const nextCandidate = nextChordRest(secondChordRest)
                if (nextCandidate) {
                    secondChordRest = nextCandidate
                }
            }
        }
    }
    const second = secondChordRest!

    const slur = slurTemplate ? slurTemplate.clone() as unknown as Slur : Factory.createItem(ElementType.SLUR, scoreDummy(this)) as unknown as Slur
    slur.setScore(firstChordRest.score())
    slur.setTick(firstChordRest.tick())
    slur.setTick2(second.tick())
    slur.setTrack(firstChordRest.track())
    if (second.staff()!.part() === firstChordRest.staff()!.part()
        && !second.staff()!.isLinked(firstChordRest.staff()!)) {
        slur.setTrack2(second.track())
    } else {
        slur.setTrack2(firstChordRest.track())
    }
    slur.setStartElement(firstChordRest)
    slur.setEndElement(second)

    firstChordRest.score().undoAddElement(slur)
    const ss = slur.newSlurTieSegment(scoreDummy(firstChordRest.score()).system())
    ss.setSpannerSegmentType(SpannerSegmentType.SINGLE)
    if (firstChordRest === second && !(slur.isOutgoing() || slur.isIncoming())) {
        ss.setSlurOffset(Grip.END, new NoteInputPointF(3.0 * firstChordRest.style().spatium(), 0.0))
    }
    slur.add(ss)

    return slur
}

Score.prototype.addHairpins = function (this: Score, type: HairpinType): Hairpin[] {
    const hairpins: Hairpin[] = []

    // add hairpin on each staff if possible
    const sel = this.selection()
    if (sel.isRange() && sel.staffStart() !== sel.staffEnd() - 1) {
        for (let staffIdx = sel.staffStart(); staffIdx < sel.staffEnd(); ++staffIdx) {
            const cr1 = sel.firstChordRest(staffIdx * VOICES)
            const cr2 = sel.lastChordRest(staffIdx * VOICES)
            const h = cr1 ? this.addHairpinOfType(type, cr1, cr2)
                : this.addHairpinAtTicks(type, sel.tickStart(), sel.tickEnd(), staff2track(staffIdx))
            if (h) {
                hairpins.push(h)
            }
        }
    } else {
        // for single staff range selection, or single selection,
        // find start & end elements elements
        const [cr1, cr2] = this.getSelectedStartEndChordRests()
        const h = this.addHairpinOfType(type, cr1, cr2)
        if (h) {
            hairpins.push(h)
        }
    }

    for (const hairpin of hairpins) {
        hairpin.setInitialTrackAndVoiceAssignment(hairpin.track(), /*curVoiceOnlyOverride*/ false)
    }

    return hairpins
}

/** C++ Factory::createHairpin + the texts of the line types */
function createHairpinOfType(score: Score, type: HairpinType): Hairpin {
    const hairpin = Factory.createItem(ElementType.HAIRPIN, scoreDummy(score).segment()) as unknown as Hairpin
    hairpin.setHairpinType(type)
    if (type === HairpinType.CRESC_LINE) {
        hairpin.setBeginText('cresc.')
        hairpin.setContinueText('(cresc.)')
    } else if (type === HairpinType.DIM_LINE) {
        hairpin.setBeginText('dim.')
        hairpin.setContinueText('(dim.)')
    }
    return hairpin
}

Score.prototype.addHairpinOfType = function (this: Score, type: HairpinType, cr1: ChordRest | null, cr2: ChordRest | null): Hairpin | null {
    if (!cr1) {
        return null
    }

    const hairpin = createHairpinOfType(this, type)
    this.addHairpin(hairpin, cr1, cr2)

    return hairpin
}

Score.prototype.addHairpinAtTicks = function (this: Score, type: HairpinType, sTick: Fraction, eTick: Fraction,
    track: track_idx_t): Hairpin {
    const hairpin = createHairpinOfType(this, type)

    hairpin.setTrack(track)
    hairpin.setTick(sTick)
    hairpin.setTick2(eTick)

    this.undoAddElement(hairpin)

    return hairpin
}

Score.prototype.cmdAddOttava = function (this: Score, type: OttavaType): void {
    const sel = this.selection() // C++ copies the selection state before the operation
    const isRange = sel.isRange()
    const staffStart = sel.staffStart()
    const staffEnd = sel.staffEnd()
    // add on each staff if possible
    if (isRange && staffStart !== staffEnd - 1) {
        const crs: [ChordRest, ChordRest][] = []
        for (let staffIdx = staffStart; staffIdx < staffEnd; ++staffIdx) {
            const cr1 = sel.firstChordRest(staffIdx * VOICES)
            let cr2 = sel.lastChordRest(staffIdx * VOICES)
            if (!cr1) {
                continue
            }
            if (!cr2) {
                cr2 = cr1
            }
            crs.push([cr1, cr2])
        }
        for (const [cr1, cr2] of crs) {
            const ottava = Factory.createItem(ElementType.OTTAVA, scoreDummy(this)) as unknown as Ottava
            ottava.setOttavaType(type)
            if (type === OttavaType.OTTAVA_8VB /*|| type == OttavaType::OTTAVA_15MB || type == OttavaType::OTTAVA_22MB*/) {
                ottava.setPlacement(PlacementV.BELOW)
                ottava.styleChanged()
            }
            ottava.setTrack(cr1.track())
            ottava.setTrack2(cr1.track())
            ottava.setTick(cr1.tick())
            ottava.setTick2(cr2.endTick())
            this.undoAddElement(ottava)
        }
    } else {
        const [cr1, cr2_] = this.getSelectedStartEndChordRests()
        if (!cr1) {
            return
        }
        const cr2 = cr2_ ?? cr1

        const ottava = Factory.createItem(ElementType.OTTAVA, scoreDummy(this)) as unknown as Ottava
        ottava.setOttavaType(type)
        if (type === OttavaType.OTTAVA_8VB /*|| type == OttavaType::OTTAVA_15MB || type == OttavaType::OTTAVA_22MB*/) {
            ottava.setPlacement(PlacementV.BELOW)
            ottava.styleChanged()
        }
        ottava.setTrack(cr1.track())
        ottava.setTrack2(cr1.track())
        ottava.setTick(cr1.tick())
        ottava.setTick2(cr2.endTick())
        this.undoAddElement(ottava)
        if (!this.noteEntryMode()) {
            this.select(ottava, SelectType.SINGLE, 0)
        }
    }
}

Score.prototype.cmdSetBeamMode = function (this: Score, mode: BeamMode): void {
    for (const cr of this.getSelectedChordRests()) {
        if (cr) {
            cr.undoChangeProperty(Pid.BEAM_MODE, mode)
        }
    }
}

Score.prototype.cmdFullMeasureRest = function (this: Score): void {
    let s1: Segment | null = null
    let s2: Segment | null = null
    let stick1 = new Fraction(-1, 1)
    let stick2 = new Fraction(-1, 1)
    let track1: track_idx_t = nidx
    let track2: track_idx_t = nidx
    let r: Rest | null = null

    if (this.noteEntryMode()) {
        s1 = this.inputState().segment()
        if (!s1 || !s1.rtick().isZero()) {
            return
        }
        const m = s1.measure()
        s2 = m.last()
        stick1 = s1.tick()
        stick2 = s2!.tick()
        track1 = this.inputState().track()
        track2 = track1 + 1
    } else if (this.selection().isRange()) {
        s1 = this.selection().startSegment()
        s2 = this.selection().endSegment()
        if (this.style().styleB(Sid.createMultiMeasureRests)) {
            // use underlying measures
            if (s1 && s1.measure().isMMRest()) {
                s1 = this.tick2segment(stick1)
            }
            if (s2 && s2.measure().isMMRest()) {
                s2 = this.tick2segment(stick2, true)
            }
        }
        stick1 = this.selection().tickStart()
        stick2 = this.selection().tickEnd()
        let ss1 = s1
        if (ss1 && ss1.segmentType() !== SegmentType.ChordRest) {
            ss1 = ss1.next1(SegmentType.ChordRest)
        }
        const fullMeasure = ss1 && (ss1.measure().first(SegmentType.ChordRest) === ss1)
            && (!s2 || (s2.segmentType() === SegmentType.EndBarLine)
                || (s2.segmentType() === SegmentType.TimeSigAnnounce)
                || (s2.segmentType() === SegmentType.KeySigAnnounce))
        if (!fullMeasure) {
            return
        }
        track1 = this.selection().staffStart() * VOICES
        track2 = this.selection().staffEnd() * VOICES
    } else if (this.selection().cr()) {
        const cr = this.selection().cr()
        if (!cr || !cr.rtick().isZero()) {
            return
        }
        const m = cr.measure()
        s1 = m.first()
        s2 = m.last()
        stick1 = s1!.tick()
        stick2 = s2!.tick()
        track1 = this.selection().cr()!.track()
        track2 = track1 + 1
    } else {
        return
    }

    for (let track = track1; track < track2; ++track) {
        if (this.selection().isRange() && !this.selectionFilter().canSelectVoice(track)) {
            continue
        }
        // first pass - remove non-initial rests from empty measures/voices
        for (let s: Segment | null = s1; s !== s2 && s; s = s.next1()) {
            if (!(s.measure().isOnlyRests(track))) { // Don't remove anything from measures that contain notes
                continue
            }
            if (s.segmentType() !== SegmentType.ChordRest || !s.element(track)) {
                continue
            }
            const cr = s.element(track) as unknown as ChordRest
            // keep first rest of measure as placeholder (replaced in second pass)
            // but delete all others
            if (!s.rtick().isZero()) {
                this.removeChordRest(cr, true)
            }
        }
        // second pass - replace placeholders with full measure rests
        for (let m: Measure | null = s1!.measure(); m; m = m.nextMeasure()) {
            if (m.isOnlyRests(track)) {
                const cr = m.findChordRest(m.tick(), track)
                if (cr) {
                    this.removeChordRest(cr, true)
                    r = this.addRest(m.tick(), track, new TDuration(DurationType.V_MEASURE), null)
                } else if (this.noteEntryMode()) {
                    // might be no cr at input position
                    r = this.addRest(m.tick(), track, new TDuration(DurationType.V_MEASURE), null)
                }
            }
            if (s2 && (m === s2.measure())) {
                break
            }
        }
    }

    // selected range is probably empty now and possibly subsumed by an mmrest
    // so updating selection requires forcing mmrests to be updated first
    s1 = this.tick2segmentMM(stick1)
    s2 = this.tick2segmentMM(stick2, true)
    if (this.selection().isRange() && s1 && s2) {
        this.selection().setStartSegment(s1)
        this.selection().setEndSegment(s2)
        this.selection().updateSelectedElements()
    } else if (r) {
        // note entry mode
        this.select(r, SelectType.SINGLE)
    } else {
        this.deselectAll()
    }
}

import { SplitJoinMeasure } from './splitjoinmeasure'
import { Spanner as SpannerClass } from '../dom/spanner'
import { SelState as DeleteSelState } from '../dom/select'
import { trackZeroVoice as deleteTrackZeroVoice } from '../types/types'

// =====================================================================================================================
//   Deleting measures and time (edit.cpp: deleteMeasures, reconnectSlurs, cmdTimeDelete, doTimeDelete,
//   checkTimeDelete, doTimeDeleteForMeasure) and Score::firstTrailingMeasure (score.cpp)
// =====================================================================================================================

declare module '../dom/score' {
    interface Score {
        deleteMeasures(mbStart: MeasureBase, mbEnd: MeasureBase, preserveTies?: boolean): void
        reconnectSlurs(mbStart: MeasureBase, mbEnd: MeasureBase): void
        /** delete time by decreasing measure length if partial measures are selected */
        cmdTimeDelete(): void
        doTimeDelete(startSegment: Segment, endSegment: Segment | null): void
        checkTimeDelete(startSegment: Segment, endSegment: Segment | null): boolean
        doTimeDeleteForMeasure(m: Measure, startSegment: Segment, f: Fraction): void
        /** C++ firstTrailingMeasure(ChordRest** cr): the first of the empty measures at the end of the score */
        firstTrailingMeasure(cr?: { v: ChordRest } | null): Measure | null
        /** (score.cpp) */
        appendMeasures(n: number): void
    }
}

Score.prototype.appendMeasures = function (this: Score, n: number): void {
    const options = new InsertMeasureOptions()
    options.createEmptyMeasures = false

    for (let i = 0; i < n; ++i) {
        this.insertMeasure(ElementType.MEASURE, null, options)
    }
}

const CR_TYPE = SegmentType.ChordRest

Score.prototype.deleteMeasures = function (this: Score, mbStart: MeasureBase, mbEnd: MeasureBase, preserveTies = false): void {
    this.select(null, SelectType.SINGLE, 0)

    if (mbEnd.isMeasure()) {
        const mbEndMeasure = mbEnd as Measure
        if (mbEndMeasure.isMMRest()) {
            mbEnd = mbEndMeasure.mmRestLast()!
        }
    }

    if (!preserveTies) {
        // we're not preserving slurs and ties where they are, so the endpoints need to be either
        // moved or the slur has to be deleted
        this.reconnectSlurs(mbStart, mbEnd)
    }

    // get the last deleted timesig & keysig in order to restore after deletion
    const lastDeletedTimeSigs = new Map<staff_idx_t, TimeSig>()

    for (let mb: MeasureBase | null = mbEnd; mb; mb = mb.prev()) {
        if (mb.isMeasure()) {
            const m = mb as Measure
            const sts = m.findSegment(SegmentType.TimeSig, m.tick())

            if (sts) {
                for (let staffIdx = 0; staffIdx < this.nstaves(); ++staffIdx) {
                    if (!lastDeletedTimeSigs.has(staffIdx)) {
                        const ts = sts.element(staffIdx * VOICES) as unknown as TimeSig | null
                        if (ts) {
                            lastDeletedTimeSigs.set(staffIdx, ts)
                        }
                    }
                }
            }

            if (lastDeletedTimeSigs.size === this.nstaves()) {
                break
            }
        }
        if (mb === mbStart) {
            break
        }
    }

    const lastDeletedKeySigEvents: KeySigEvent[] = []

    for (const staff of this.staves()) {
        const kse = staff.keySigEvent(mbEnd.tick())
        lastDeletedKeySigEvents.push(kse)
    }

    const startTick = mbStart.tick()
    const endTick = mbEnd.tick()

    for (const score of this.scoreList()) {
        const startMeasure = score.tick2measure(startTick)!
        const endMeasure = score.tick2measure(endTick)!

        score.undoRemoveMeasures(startMeasure, endMeasure, preserveTies)

        // adjust views: C++ MuseScoreView::adjustCanvasPosition (the app shows the selection)

        // insert correct timesig after deletion
        const mBeforeSel = startMeasure.prevMeasure()
        const mAfterSel = mBeforeSel ? mBeforeSel.nextMeasure() : score.firstMeasure()
        if (mAfterSel) {
            let s = mAfterSel.findSegment(SegmentType.TimeSig, mAfterSel.tick())

            for (let staffIdx = 0; staffIdx < score.nstaves(); ++staffIdx) {
                if (s && s.element(staffIdx * VOICES)) {
                    continue
                }

                const lastDeletedForThisStaff = lastDeletedTimeSigs.get(staffIdx) ?? null
                if (!lastDeletedForThisStaff) {
                    continue
                }

                if (mBeforeSel) {
                    const staff = this.staff(staffIdx)
                    if (!staff) {
                        continue
                    }

                    const timeSig = staff.timeSig(mBeforeSel.tick())
                    if (!timeSig || timeSig.sig().eq(lastDeletedForThisStaff.sig())) {
                        continue
                    }
                }

                if (!s) {
                    s = mAfterSel.undoGetSegment(SegmentType.TimeSig, mAfterSel.tick())
                }

                const nts = Factory.createItem(ElementType.TIMESIG, s) as unknown as TimeSig
                nts.setTrack(staffIdx * VOICES)
                nts.setParent(s)
                nts.setFrom(lastDeletedForThisStaff)
                nts.setStretch(nts.sig().div(mAfterSel.timesig()))
                score.undoAddElement(nts)
            }
        }

        // insert correct keysig if necessary
        if (mAfterSel && !mBeforeSel) {
            const s = mAfterSel.undoGetSegment(SegmentType.KeySig, mAfterSel.tick())

            let userCustomizedKeySig = false
            for (const e of s.elist()) {
                if (e && e.isKeySig() && !e.generated()) {
                    userCustomizedKeySig = true
                    break
                }
            }
            if (userCustomizedKeySig) {
                continue
            }

            const concertPitch = score.style().styleB(Sid.concertPitch)
            for (const staff of score.staves()) {
                const part = staff.part()!
                const instrument = part.instrument(new Fraction(0, 1))
                let nkse = new KeySigEvent()
                const staffIdx = staff.idx()

                if (instrument.useDrumset()) {
                    nkse.setConcertKey(Key.C)
                    nkse.setCustom(true)
                    nkse.setMode(KeyMode.NONE)
                } else {
                    nkse = lastDeletedKeySigEvents[staffIdx].clone()
                    if (!concertPitch && !nkse.isAtonal()) {
                        const v = instrument.transpose().clone()
                        v.flip()
                        nkse.setKey(Transpose.transposeKey(nkse.concertKey(), v, part.preferSharpFlat()))
                    }
                }

                let nks = s.element(staff2track(staffIdx)) as unknown as KeySig | null
                if (!nks) {
                    nks = Factory.createItem(ElementType.KEYSIG, s) as unknown as KeySig
                    nks.setParent(s)
                    nks.setTrack(staffIdx * VOICES)
                    nks.setKeySigEvent(nkse)
                    score.undoAddElement(nks)
                } else {
                    nks.setGenerated(false)
                    nks.setKeySigEvent(nkse)
                    staff.setKey(mAfterSel.tick(), nkse)
                }
            }
        }
    }

    this.undoInsertTime(mbStart.tick(), mbEnd.endTick().minus(mbStart.tick()).neg())
    this.inputState().setSegment(null) // invalidate position
}

Score.prototype.reconnectSlurs = function (this: Score, mbStart: MeasureBase, mbEnd: MeasureBase): void {
    // Reconnect or remove slurs that intersect with these deleted measures
    const sTick = mbStart.tick()
    const eTick = mbEnd.tick()
    for (const sp of this.spannerMap().findOverlapping(sTick.ticks(), eTick.ticks())) {
        if (!sp.isSlur()) {
            continue
        }
        const cr1 = sp.startCR()
        const cr2 = sp.endCR()
        if (!cr1 || !cr2) {
            // this is an invalid slur
            continue
        }
        let m: MeasureBase | null = mbStart
        let adjust1 = false
        let adjust2 = false
        const measure1 = cr1.measure()
        const measure2 = cr2.measure()
        do {
            adjust1 = adjust1 ? true : (measure1 as MeasureBase | null) === m
            adjust2 = adjust2 ? true : (measure2 as MeasureBase | null) === m
            if (m === mbEnd) {
                break
            } else {
                m = m!.next()
            }
        } while (m && !(adjust1 && adjust2))
        if (adjust1 && adjust2) {
            // if both endpoints of this slur are inside this deleted range, remove the slur.
            this.undoRemoveElement(sp)
            continue
        } else if (adjust1) {
            // endpoint 1 is in deleted range. move endpoint forward to first non-deleted CR after range
            const mNext = mbEnd.next() && mbEnd.next()!.isMeasure() ? mbEnd.next() as Measure : null
            if (!mNext) {
                this.undoRemoveElement(sp)
                continue
            }
            let firstAvailableCr: ChordRest | null = null
            // search for last cr in this voice
            let seg = mNext.first(SegmentType.ChordRest)
            const spTrack = sp.track()
            const spEndCr = sp.endCR()!
            const spEndCrTick = spEndCr.tick()
            while (seg) {
                firstAvailableCr = seg.cr(spTrack)
                if (!firstAvailableCr || !firstAvailableCr.isChord()) {
                    seg = seg.next(SegmentType.ChordRest)
                    continue
                }
                const gracesBefore = (firstAvailableCr as unknown as Chord).graceNotesBefore().chords()
                if (firstAvailableCr.tick().gt(spEndCrTick)) {
                    // we would create a negative-length slur. remove it entirely.
                    this.undoRemoveElement(sp)
                    break
                } else if (spEndCr === firstAvailableCr) {
                    // this would be a zero-length slur, but a possibility exists that this cr has grace after
                    if (gracesBefore.length === 0) {
                        this.undoRemoveElement(sp)
                        break
                    }
                }
                if (gracesBefore.length) {
                    firstAvailableCr = gracesBefore[0]
                }
                const newSp = sp.clone() as Spanner
                newSp.setStartElement(firstAvailableCr)
                newSp.setTick(firstAvailableCr.tick())
                this.undoChangeElement(sp, newSp)
                break
            }
        } else if (adjust2) {
            // endpoint 2 is in deleted range. move endpoint backward to last non-deleted CR before range
            const mPrev = mbStart.prev() && mbStart.prev()!.isMeasure() ? mbStart.prev() as Measure : null
            if (!mPrev) {
                this.undoRemoveElement(sp)
                continue
            }
            let firstAvailableCr: ChordRest | null = null
            // search for last cr in this voice
            let seg = mPrev.last()
            if (seg && seg.segmentType() !== SegmentType.ChordRest) {
                seg = seg.prev(SegmentType.ChordRest)
            }
            const spStartCr = sp.startCR()!
            const spStartCrTick = spStartCr.tick()
            while (seg) {
                firstAvailableCr = seg.cr(sp.track2())
                if (!firstAvailableCr || !firstAvailableCr.isChord()) {
                    seg = seg.prev(SegmentType.ChordRest)
                    continue
                }
                const gracesAfter = (firstAvailableCr as unknown as Chord).graceNotesAfter().chords()
                if (firstAvailableCr.tick().lt(spStartCrTick)) {
                    // we would create a negative-length slur. remove it entirely.
                    this.undoRemoveElement(sp)
                    break
                } else if (spStartCr === firstAvailableCr) {
                    // this would be a zero-length slur, but a possibility exists that this cr has grace after
                    if (gracesAfter.length === 0) {
                        this.undoRemoveElement(sp)
                        break
                    }
                }
                if (gracesAfter.length) {
                    firstAvailableCr = gracesAfter[gracesAfter.length - 1]
                }
                const newSp = sp.clone() as Spanner
                newSp.setEndElement(firstAvailableCr)
                newSp.setTick2(firstAvailableCr.tick())
                this.undoChangeElement(sp, newSp)
                break
            }
        } else {
            // both of the endpoints are outside of the deleted range. there is no reason to change or delete anything
        }
    }
}

Score.prototype.checkTimeDelete = function (this: Score, startSegment: Segment, endSegment: Segment | null): boolean {
    let startMeasure = startSegment.measure()
    let endMeasure: Measure

    if (endSegment) {
        endMeasure = endSegment.prev() ? endSegment.measure() : endSegment.measure().prevMeasure()!
    } else {
        endMeasure = this.lastMeasure()!
    }

    const endTick = endSegment ? endSegment.tick() : endMeasure.endTick()
    let tick = startSegment.tick()
    let etick = startMeasure === endMeasure ? endTick : startMeasure.endTick()

    // check for MeasureRepeat
    const startsAtBeginningOfMeasure = tick.eq(startMeasure.tick())
    const endsAtEndOfMeasure = endTick.eq(endMeasure.endTick())
    for (let staffIdx = 0; staffIdx < this.nstaves(); ++staffIdx) {
        if ((startMeasure.isMeasureRepeatGroup(staffIdx) && !startsAtBeginningOfMeasure)
            || (endMeasure.isMeasureRepeatGroup(staffIdx) && !endsAtEndOfMeasure)
            || startMeasure.isMeasureRepeatGroupWithPrevM(staffIdx)
            || endMeasure.isMeasureRepeatGroupWithNextM(staffIdx)) {
            MScore.setError(MsError.CANNOT_REMOVE_TIME_MEASURE_REPEAT)
            return false
        }
    }

    let canDeleteTime = true
    while (canDeleteTime) {
        for (let track = 0; canDeleteTime && track < this.nstaves() * VOICES; ++track) {
            if (startMeasure.hasVoice(track)) {
                const fs = startMeasure.first(CR_TYPE)
                for (let s = fs; s; s = s.next(CR_TYPE)) {
                    if (s.element(track)) {
                        const cr = s.element(track) as unknown as ChordRest
                        const t = cr.tuplet()
                        const de: DurationElement = t ? t : cr
                        const f = de.tick().plus(de.actualTicks())
                        const cetick = f
                        if (cetick.le(tick)) {
                            continue
                        }
                        if (de.tick().ge(etick)) {
                            break
                        }
                        if (t && (t.tick().lt(tick) || cetick.gt(etick))) {
                            canDeleteTime = false
                            break
                        }
                    }
                }
            }
        }
        if (startMeasure === endMeasure) {
            break
        }
        startMeasure = endMeasure
        tick = startMeasure.tick()
        etick = endTick
    }
    if (!canDeleteTime) {
        MScore.setError(MsError.CANNOT_REMOVE_TIME_TUPLET)
        return false
    }
    return true
}

Score.prototype.cmdTimeDelete = function (this: Score): void {
    const e = this.selection().element()

    if (e && e.isBarLine() && (e as unknown as BarLine).segment().isEndBarLineType()) {
        const m = (e as unknown as BarLine).segment().measure()
        const next = m.nextMeasure()
        if (next) {
            SplitJoinMeasure.joinMeasures(this.masterScore(), m.tick(), next.tick())
        }
        return
    }

    let startSegment: Segment | null = null
    let endSegment: Segment | null = null

    if (this.selection().state() !== DeleteSelState.RANGE) {
        if (!e) {
            return
        }

        let cr: ChordRest | null = null
        if (e.isNote()) {
            cr = (e as unknown as Note).chord()
        } else if (e.isChordRest()) {
            cr = e as unknown as ChordRest
        } else {
            return
        }

        startSegment = cr.segment()
        const endTick = cr.endTick()
        endSegment = this.tick2measure(endTick)!.findSegment(CR_TYPE, endTick)
    } else {
        startSegment = this.selection().startSegment()
        endSegment = this.selection().endSegment()
    }

    if (!this.isMaster() && this.masterScore()) {
        const startTick = startSegment!.tick()
        const masterStartMeas = this.masterScore().tick2measure(startTick)!
        const masterStartSeg = masterStartMeas.findSegment(startSegment!.segmentType(), startSegment!.tick())
        let masterEndSeg: Segment | null = null

        if (endSegment) {
            const endTick = endSegment.tick()
            let masterEndMeas = this.masterScore().tick2measure(endTick)!
            if (endSegment.isEndBarLineType()) {
                const prevMasterEndMeasure = masterEndMeas.prevMeasure()
                masterEndMeas = prevMasterEndMeasure ? prevMasterEndMeasure : masterEndMeas
            }
            masterEndSeg = masterEndMeas.findSegment(endSegment.segmentType(), endSegment.tick())
        }

        this.masterScore().doTimeDelete(masterStartSeg!, masterEndSeg)
    } else {
        this.doTimeDelete(startSegment!, endSegment)
    }

    if (this.noteEntryMode()) {
        let currentSegment = endSegment
        let cr: ChordRest | null = null
        const is = this.inputState()
        if (!currentSegment && this.lastMeasureMM()) {
            // deleted to end of score - get last cr on current track
            currentSegment = this.lastMeasureMM()!.last()
            if (currentSegment) {
                cr = currentSegment.nextChordRest(is.track(), true)
                if (cr) {
                    currentSegment = cr.segment()
                }
            }
        }
        if (!currentSegment) {
            // no cr found - append a new measure
            this.appendMeasures(1)
            currentSegment = this.lastMeasureMM()!.first(SegmentType.ChordRest)
        }
        is.setSegment(currentSegment)
        cr = is.cr()
        if (cr) {
            if (cr.isChord()) {
                this.select((cr as unknown as Chord).upNote(), SelectType.SINGLE)
            } else {
                this.select(cr, SelectType.SINGLE)
            }
        } else {
            // could not find cr to select,
            // may be that there is a "hole" in the current track
            this.deselectAll()
        }
    } else {
        this.deselectAll()
    }
}

Score.prototype.doTimeDelete = function (this: Score, startSegment: Segment, endSegment: Segment | null): void {
    if (!this.checkTimeDelete(startSegment, endSegment)) {
        return
    }

    let mbStart: MeasureBase = startSegment.measure()
    if (mbStart.isMeasure() && (mbStart as Measure).isMMRest()) {
        mbStart = (mbStart as Measure).mmRestFirst()!
    }
    let mbEnd: MeasureBase

    if (endSegment) {
        mbEnd = endSegment.prev(SegmentType.ChordRest) ? endSegment.measure() : endSegment.measure().prevMeasure()!
    } else {
        mbEnd = this.lastMeasure()!
    }

    let endTick = endSegment ? endSegment.tick() : mbEnd.endTick()

    for (;;) {
        if (!mbStart.tick().eq(startSegment.tick())) {
            const tick = startSegment.tick()
            let len: Fraction
            if (mbEnd === mbStart) {
                len = endTick.minus(tick)
            } else {
                len = mbStart.endTick().minus(tick)
            }
            this.doTimeDeleteForMeasure(mbStart as Measure, startSegment, len)
            if (mbStart === mbEnd) {
                break
            }
            mbStart = mbStart.next()!
        }
        endTick = endSegment ? endSegment.tick() : mbEnd.endTick()
        if (!mbEnd.endTick().eq(endTick)) {
            const len = endTick.minus(mbEnd.tick())
            this.doTimeDeleteForMeasure(mbEnd as Measure, (mbEnd as Measure).first()!, len)
            if (mbStart === mbEnd) {
                break
            }
            mbEnd = mbEnd.prev()!
        }
        this.deleteMeasures(mbStart, mbEnd)
        break
    }
}

Score.prototype.doTimeDeleteForMeasure = function (this: Score, m: Measure, startSegment: Segment, f: Fraction): void {
    if (f.isZero()) {
        return
    }

    const tick = startSegment.rtick()
    const len = f
    const etick = tick.plus(len)

    const fs = m.first(CR_TYPE)

    for (let track = 0; track < this.nstaves() * VOICES; ++track) {
        if (m.hasVoice(track)) {
            for (let s = fs; s; s = s.next(CR_TYPE)) {
                if (s.element(track)) {
                    const cr = s.element(track) as unknown as ChordRest
                    const cetick = cr.rtick().plus(cr.actualTicks())

                    if (cetick.le(tick)) {
                        continue
                    }
                    if (s.rtick().ge(etick)) {
                        break
                    }

                    if (cr.isFullMeasureRest()) {
                        if (cr.rtick().ge(tick)) {
                            // Move full-measure rest from the deleted area
                            this.undoRemoveElement(cr)
                            const newCR = cr.clone() as ChordRest
                            newCR.setTicks(cr.ticks().minus(f))
                            this.undoAddCR(newCR, m, m.tick().plus(etick))
                        } else {
                            cr.undoChangeProperty(Pid.DURATION, cr.ticks().minus(f))
                        }
                    } else if (s.rtick().ge(tick) && cetick.le(etick)) {
                        // inside deleted area
                        this.undoRemoveElement(cr)
                    } else if (s.rtick().ge(tick)) {
                        // running out
                        const ff = cetick.minus(etick)
                        this.undoRemoveElement(cr)
                        this.createCRSequence(ff, cr, tick.plus(len))
                    } else if (s.rtick().lt(tick) && cetick.le(etick)) {
                        // running in
                        const f1 = tick.minus(s.rtick())
                        this.changeCRlen(cr, f1, false)
                    } else {
                        // running in/out
                        const f1 = cr.ticks().minus(f)
                        this.changeCRlen(cr, f1, false)
                    }
                }
            }
        }
    }
    const abstick = startSegment.tick()
    this.undoInsertTime(abstick, len.neg())

    const emptySegments: Segment[] = []

    for (const score of this.masterScore().scoreList()) {
        const localMeasure = score.tick2measure(abstick)!

        this.undo(new InsertTime(score, abstick, len.neg()))

        let updatedTick = tick
        for (let s = localMeasure.first(CR_TYPE); s; s = s.next()) {
            if (s.rtick().lt(etick) || s.rtick().eq(updatedTick)) {
                continue
            }

            s.undoChangeProperty(Pid.TICK, updatedTick)
            updatedTick = updatedTick.plus(s.ticks())

            if (score.isMaster()) {
                if (s.isChordRestType() && !s.hasElements()) {
                    emptySegments.push(s)
                }
            }
        }

        this.undo(new ChangeMeasureLen(localMeasure, localMeasure.ticks().minus(f)))
    }

    for (const s of emptySegments) {
        const ns = s.next(CR_TYPE)
        if (ns) {
            // Move annotations from the empty segment.
            // TODO: do we need to preserve annotations at all?
            // Maybe only some types (Tempo etc.)?
            const annotations = [...s.annotations()] // make a copy since we alter the list
            for (const a of annotations) {
                const a1 = a.clone()
                a1.setParent(ns)
                this.undoRemoveElement(a)
                this.undoAddElement(a1)
            }
        }
    }
}

Score.prototype.firstTrailingMeasure = function (this: Score, cr: { v: ChordRest } | null = null): Measure | null {
    let firstMeasure: Measure | null = null
    let m = this.lastMeasure()

    if (!cr) {
        // No active selection: prepare first empty trailing measure of entire score
        while (m && m.isEmpty(nidx)) {
            firstMeasure = m
            m = m.prevMeasure()
        }
    } else {
        // Active selection: select full measure rest of active staff's empty trailing measure
        let tempCR: ChordRest | null
        while (m && (tempCR = m.first()!.nextChordRest(deleteTrackZeroVoice(cr.v.track()), false)) && tempCR.isFullMeasureRest()) {
            cr.v = tempCR
            firstMeasure = m
            m = m.prevMeasure()
        }
    }

    return firstMeasure
}

// =====================================================================================================================
//   Score::cloneVoice (edit.cpp): copies a voice (exchange voices, explode, implode)
// =====================================================================================================================

declare module '../dom/score' {
    interface Score {
        cloneVoice(strack: track_idx_t, dtrack: track_idx_t, sf: Segment, lTick: Fraction, link?: boolean, spanner?: boolean): void
    }
}

Score.prototype.cloneVoice = function (this: Score, strack: track_idx_t, dtrack: track_idx_t, sf: Segment, lTick: Fraction,
    link = true, spanner = true): void {
    const start = sf.tick()
    const tieMap = new Map<Tie, Tie>()
    const tupletMap = new Map<Tuplet, Tuplet>() // tuplets cannot cross measure boundaries
    const score = sf.score()
    let tremolo: TremoloTwoChord | null = null

    for (let oseg: Segment | null = sf; oseg && oseg.tick().lt(lTick); oseg = oseg.next1()) {
        let ns: Segment | null = null // create segment later, on demand
        const dm = this.tick2measure(oseg.tick())!

        const oe = oseg.element(strack)

        if (oe && !oe.generated() && oe.isChordRest()) {
            // If we want to maintain the link (exchange voice) create a linked clone
            // If we want new, unlinked elements (implode/explode) create a clone
            const ne = link ? oe.linkedClone() : oe.clone()
            ne.setTrack(dtrack)

            //Don't clone gaps to a first voice
            if (!(ne.track() % VOICES) && ne.isRest()) {
                (ne as unknown as Rest).setGap(false)
            }

            ne.setScore(this)
            const ocr = oe as unknown as ChordRest
            const ncr = ne as unknown as ChordRest

            //Handle beams
            if (ocr.beam() && ocr.beam()!.elements().length && ocr.beam()!.elements()[0] === ocr) {
                const nb = ocr.beam()!.clone() as Beam
                nb.clear()
                nb.setTrack(dtrack)
                nb.setScore(this)
                nb.add(ncr)
                ncr.setBeam(nb)
            }

            // clone Tuplets
            let ot = ocr.tuplet()
            if (ot) {
                ot.setTrack(strack)
                let nt = tupletMap.get(ot) ?? null
                if (!nt) {
                    nt = (link ? ot.linkedClone() : ot.clone()) as Tuplet
                    nt.setTrack(dtrack)
                    nt.setParent(dm)
                    tupletMap.set(ot, nt)

                    let nt1 = nt
                    while (ot.tuplet()) {
                        let nt2 = tupletMap.get(ot.tuplet()!) ?? null
                        if (!nt2) {
                            nt2 = (link ? ot.tuplet()!.linkedClone() : ot.tuplet()!.clone()) as Tuplet
                            nt2.setTrack(dtrack)
                            nt2.setParent(dm)
                            tupletMap.set(ot.tuplet()!, nt2)
                        }
                        nt2.add(nt1)
                        nt1.setTuplet(nt2)
                        ot = ot.tuplet()!
                        nt1 = nt2
                    }
                }
                nt.add(ncr)
                ncr.setTuplet(nt)
            }

            // clone additional settings
            if (oe.isRest()) {
                const ore = ocr as unknown as Rest
                // If we would clone a full measure rest just don't clone this rest
                if (ore.isFullMeasureRest() && (dtrack % VOICES)) {
                    continue
                }
            }

            const cloneChord = (oldChord: Chord, newChord: Chord): void => {
                const n = oldChord.notes().length
                for (let i = 0; i < n; ++i) {
                    const on = oldChord.notes()[i]
                    const nn = newChord.notes()[i]
                    const idx = track2staff(dtrack)
                    const tick = oseg!.tick()
                    const v = this.staff(idx) ? this.staff(idx)!.transpose(tick).clone() : new Interval()
                    nn.setTpc1(on.tpc1())
                    if (v.isZero()) {
                        nn.setTpc2(on.tpc1())
                    } else {
                        v.flip()
                        nn.setTpc2(Transpose.transposeTpc(nn.tpc1(), v, true))
                    }

                    if (on.tieFor()) {
                        const tie = (link ? on.tieFor()!.linkedClone() : on.tieFor()!.clone()) as Tie
                        tie.setScore(this)
                        nn.setTieFor(tie)
                        tie.setStartNote(nn)
                        tie.setTrack(nn.track())
                        tie.setEndNote(nn)
                        tieMap.set(on.tieFor()!, tie)
                    }
                    if (on.tieBack()) {
                        const tie = tieMap.get(on.tieBack()!)
                        if (tie) {
                            nn.setTieBack(tie)
                            tie.setEndNote(nn)
                        }
                    }
                    // add back spanners (going back from end to start spanner element
                    // makes sure the 'other' spanner anchor element is already set up)
                    // 'on' is the old spanner end note and 'nn' is the new spanner end note
                    for (const oldSp of on.spannerBack()) {
                        const newStart = SpannerClass.startElementFromSpanner(oldSp, nn)
                        if (newStart) {
                            const newSp = (link ? oldSp.linkedClone() : oldSp.clone()) as Spanner
                            newSp.setNoteSpan(newStart, nn)
                            this.addElement(newSp)
                        }
                    }
                }
                // two note tremolo
                const tr = oldChord.tremoloTwoChord()
                if (tr) {
                    if (oldChord === tr.chord1()) {
                        tremolo = (link ? tr.linkedClone() : tr.clone()) as TremoloTwoChord
                        tremolo.setScore(newChord.score())
                        tremolo.setParent(newChord)
                        tremolo.setTrack(newChord.track())
                        tremolo.setChords(newChord, null)
                        newChord.setTremoloTwoChord(tremolo)
                    } else if (oldChord === tr.chord2()) {
                        if (tremolo) {
                            tremolo.setChords(tremolo.chord1(), newChord)
                            newChord.setTremoloTwoChord(tremolo)
                        }
                    }
                }
            }
            if (oe.isChord()) {
                cloneChord(ocr as unknown as Chord, ncr as unknown as Chord)
                const ograces = (ocr as unknown as Chord).graceNotes()
                const ngraces = (ncr as unknown as Chord).graceNotes()
                for (let i = 0; i < ograces.length; ++i) {
                    cloneChord(ograces[i], ngraces[i])
                }
            }

            // Add element
            if (link) {
                // To segment to avoid adding to all linked staves (exchange voice)
                if (!ns) {
                    ns = dm.getSegment(oseg.segmentType(), oseg.tick())
                }
                ns.add(ne)
            } else {
                // To score, to add to all linked staves (implode/explode)
                this.undoAddCR(ncr, dm, oseg.tick())
            }
        }
        const tst = dm.segments().firstCRSegment()
        if (strack % VOICES && !(dtrack % VOICES) && (!tst || !tst.element(dtrack))) {
            const rest = Factory.createItem(ElementType.REST, this) as unknown as Rest
            rest.setTicks(dm.ticks())
            rest.setDurationType(new TDuration(DurationType.V_MEASURE))
            rest.setTrack(dtrack)
            if (link) {
                const segment = dm.getSegment(SegmentType.ChordRest, dm.tick())
                segment.add(rest)
            } else {
                this.undoAddCR(rest, dm, dm.tick())
            }
        }

        const annotations = [...oseg.annotations()]
        for (const annotation of annotations) {
            if (!annotation.elementAppliesToTrack(strack)) {
                continue
            }

            // If we want to maintain the link (exchange voice) create a linked clone
            // If we want new, unlinked elements (implode/explode) create a clone
            const newAnnotation = link ? annotation.linkedClone() : annotation.clone()
            newAnnotation.setTrack(dtrack)

            // Add element
            if (link) {
                // To segment to avoid adding to all linked staves (exchange voice)
                if (!ns) {
                    ns = dm.getSegment(oseg.segmentType(), oseg.tick())
                }
                ns.add(newAnnotation)
            } else {
                // To score, to add to all linked staves (implode/explode)
                this.doUndoAddElement(newAnnotation)
            }
        }
    }

    if (spanner) {
        // Find and add corresponding slurs and hairpins
        const SPANNERS_TO_COPY = [ElementType.SLUR, ElementType.HAMMER_ON_PULL_OFF, ElementType.HAIRPIN]
        const spanners = score.spannerMap().findOverlapping(start.ticks(), lTick.ticks())
        for (const sp of spanners) {
            const spStart = sp.tick()
            const spEnd = spStart.plus(sp.ticks())

            if (SPANNERS_TO_COPY.includes(sp.type()) && (spStart.ge(start) && spEnd.lt(lTick))) {
                if (!sp.elementAppliesToTrack(strack)) {
                    continue
                }
                const nsp = (link ? sp.linkedClone() : sp.clone()) as Spanner

                nsp.setScore(this)
                nsp.setParent(null)
                nsp.setTrack(dtrack)
                nsp.setTrack2(dtrack)

                // set start/end element for slur
                const cr1 = sp.startCR()
                const cr2 = sp.endCR()

                nsp.setStartElement(null)
                nsp.setEndElement(null)
                if (cr1 && cr1.links()) {
                    for (const e of cr1.links()!) {
                        const cr = e as unknown as ChordRest
                        if (cr === cr1) {
                            continue
                        }
                        if (cr.score() === this && cr.tick().eq(nsp.tick()) && cr.track() === dtrack) {
                            nsp.setStartElement(cr)
                            break
                        }
                    }
                }
                if (cr2 && cr2.links()) {
                    for (const e of cr2.links()!) {
                        const cr = e as unknown as ChordRest
                        if (cr === cr2) {
                            continue
                        }
                        if (cr.score() === this && cr.tick().eq(nsp.tick2()) && cr.track() === dtrack) {
                            nsp.setEndElement(cr)
                            break
                        }
                    }
                }
                this.doUndoAddElement(nsp)
            }
        }
    }
}


// =====================================================================================================================
//   noteVal, addMidiPitch, addTiedMidiPitch (edit.cpp): the pitches of MIDI input (also: the notes detected from the microphone)
// =====================================================================================================================

// (imports of this section; ES imports are hoisted)
import { pitch2tpc, Prefer } from '../dom/pitchspelling'

declare module '../dom/score' {
    interface Score {
        /** the NoteVal of a MIDI pitch on a staff (spelled with the accidental of the input state as a hint) */
        noteVal(pitch: number, staffIdx: number, allowTransposition: boolean): NoteVal
        /** adds a MIDI pitch at the input position (addFlag: to the chord) */
        addMidiPitch(pitch: number, addFlag: boolean, allowTransposition: boolean): Note | null
        /** adds a MIDI pitch tied to the same pitch of the previous chord (a key still held at the real-time advance) */
        addTiedMidiPitch(pitch: number, addFlag: boolean, prevChord: Chord | null, allowTransposition: boolean): Note | null
    }
}

Score.prototype.noteVal = function (this: Score, pitch: number, staffIdx: number, allowTransposition: boolean): NoteVal {
    const nval = new NoteVal(pitch)

    const st = this.staff(staffIdx)
    if (!st) {
        return nval
    }

    const concertPitch = this.style().styleB(Sid.concertPitch)
    const v = st.part().instrument(this.inputState().tick()).transpose()

    // If an accidental is set in the input state, use it as a hint for the pitch spelling
    const at = this.inputState().accidentalType()
    if (at === AccidentalType.FLAT || at === AccidentalType.SHARP) {
        const prefer = at === AccidentalType.SHARP ? Prefer.SHARPS : Prefer.FLATS
        if (concertPitch || v.isZero()) {
            // Note: using Key::C always and ignoring actual key signature. Otherwise, flat mode would still use sharps
            // sometimes if they're in the key, and vice versa, which seems contrary to the intent of the hint.
            nval.tpc1 = pitch2tpc(nval.pitch, Key.C, prefer)
            const vFlipped = v.clone()
            vFlipped.flip()
            nval.tpc2 = Transpose.transposeTpc(nval.tpc1, vFlipped, true)
        } else {
            // Spell the transposed pitch first, then convert to concert pitch
            let writtenPitch = nval.pitch
            if (!allowTransposition) {
                writtenPitch -= v.chromatic
            }
            nval.tpc2 = pitch2tpc(writtenPitch, Key.C, prefer)
            nval.tpc1 = Transpose.transposeTpc(nval.tpc2, v, true)
        }
    }

    // if transposing, interpret MIDI pitch as representing desired written pitch
    // set pitch based on corresponding sounding pitch
    if (!concertPitch && allowTransposition) {
        nval.pitch += v.chromatic
    }

    return nval
}

Score.prototype.addMidiPitch = function (this: Score, pitch: number, addFlag: boolean, allowTransposition: boolean): Note | null {
    const nval = this.noteVal(pitch, this.inputState().staffIdx(), allowTransposition)
    return this.addPitch(nval, addFlag)
}

Score.prototype.addTiedMidiPitch = function (this: Score, pitch: number, addFlag: boolean, prevChord: Chord | null, allowTransposition: boolean): Note | null {
    const n = this.addMidiPitch(pitch, addFlag, allowTransposition)
    if (prevChord && n) {
        const nn = prevChord.findNote(n.pitch())
        if (nn) {
            const tie = Factory.createItem(ElementType.TIE, scoreDummy(this)) as unknown as Tie
            tie.setStartNote(nn)
            tie.setEndNote(n)
            tie.setTick(tie.startNote()!.tick())
            tie.setTick2(tie.endNote()!.tick())
            tie.setTrack(n.track())
            n.setTieBack(tie)
            nn.setTieFor(tie)
            this.undoAddElement(tie)
        }
    }
    return n
}
