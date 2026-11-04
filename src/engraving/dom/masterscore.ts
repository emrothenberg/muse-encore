/*
 * SPDX-License-Identifier: GPL-3.0-only
 * MuseEncore — port of MuseScore Studio (https://github.com/musescore/MuseScore)
 * Copyright (C) 2021-2026 MuseScore Limited and others
 *
 * Port of src/engraving/dom/masterscore.h/.cpp
 * TODO(port): playback score, the PartChannelSettingsLinks of excerpts (m_playbackSettingsLinks)
 */

import { RepeatList } from './repeatlist'
import { LoopBoundaryType, Score } from './score'
import { TimeSigMap } from './sig'
import { TempoMap } from './tempo'
import { UndoStack } from '../editing/undo'
import { CmdState } from '../editing/cmdstate'
import type { Excerpt } from './excerpt'
import type { Staff } from './staff'
import type { Part } from './part'
import { PartChannelSettingsLink, type InstrChannel } from './instrument'
import { Fraction } from '../types/fraction'
import { DefaultStyle } from '../style/defaultstyle'

/** the "platform" meta tag of new scores (C++ Q_OS_WIN / Q_OS_MAC / Q_OS_LINUX) */
function platformName(): string {
    const g = globalThis as { process?: { platform?: string }; navigator?: { platform?: string; userAgent?: string } }
    const p = g.process?.platform ?? g.navigator?.platform ?? g.navigator?.userAgent ?? ''
    if (/^win|windows/i.test(p)) {
        return 'Microsoft Windows'
    }
    if (/darwin|mac/i.test(p)) {
        return 'Apple Macintosh'
    }
    if (/linux/i.test(p)) {
        return 'Linux'
    }
    return 'Unknown'
}

/** C++ MidiMapping (masterscore.h) */
export class MidiMapping {
    m_part: Part | null = null
    m_articulation: InstrChannel | null = null
    m_port = 0
    m_channel = 0
    m_masterChannel: InstrChannel | null = null
    m_link = new PartChannelSettingsLink()

    part(): Part | null { return this.m_part }
    articulation(): InstrChannel { return this.m_articulation! }
    port(): number { return this.m_port }
    channel(): number { return this.m_channel }
}

/** C++ MidiInputEvent */
export interface MidiInputEvent {
    pitch: number
    chord: boolean
    velocity: number
}

export class MasterScore extends Score {
    /** C++ m_activeMidiPitches: MIDI keys currently being held down */
    private m_activeMidiPitches: MidiInputEvent[] = []

    override activeMidiPitches(): MidiInputEvent[] { return this.m_activeMidiPitches }

    private m_sigmap = new TimeSigMap()
    private m_tempomap = new TempoMap()
    private m_loopBoundaries: [Fraction, Fraction] = [new Fraction(0, 1), new Fraction(0, 1)] // 0 - LoopIn, 1 - LoopOut
    private m_loopBoundaryTickChanged = new Set<(type: LoopBoundaryType, ticks: number) => void>()
    private m_mscoreVersion = ''
    private m_mscoreRevision = 0
    private m_expandRepeats = true
    private m_expandedRepeatList = new RepeatList(this)
    private m_nonExpandedRepeatList = new RepeatList(this)
    private m_undoStack = new UndoStack()
    private m_cmdState = new CmdState() // modified during cmd processing
    private m_excerpts: Excerpt[] = []
    private m_midiMapping: MidiMapping[] = []
    private m_isSimpleMidiMapping = false // midi mapping is simple if all ports and channels don't decrease and don't have
                                          // 'holes' except drum tracks
    private m_midiPortCount = 0 // A count of JACK/ALSA midi out ports

    constructor() {
        super()
        this.m_metaTags.set('platform', platformName())
        for (const tag of ['movementNumber', 'movementTitle', 'workNumber', 'workTitle', 'arranger', 'composer', 'lyricist',
            'translator', 'source', 'copyright']) {
            this.m_metaTags.set(tag, '')
        }
        const d = new Date()
        const pad = (n: number): string => String(n).padStart(2, '0')
        this.m_metaTags.set('creationDate', `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
    }

    override isMaster(): boolean { return true }

    excerpts(): Excerpt[] { return this.m_excerpts }
    addExcerpt(ex: Excerpt, index = -1): void {
        if (!ex.inited()) {
            this.initParts(ex)
        }
        this.m_excerpts.splice(index === -1 ? this.m_excerpts.length : index, 0, ex)
        this.setExcerptsChanged(true)
    }

    /** C++ MasterScore::initParts (excerpt.cpp) */
    initParts(excerpt: Excerpt): void {
        let nstaves = 1 // Initialise to 1 to force writing of the first part.
        const assignedStavesIds = new Set<string>()
        for (const excerptStaff of excerpt.excerptScore()!.staves()) {
            const ls = excerptStaff.links()
            if (!ls) {
                continue
            }

            for (const le of ls) {
                if (le.score() !== this) {
                    continue
                }

                const linkedMasterStaff = le as Staff
                if (assignedStavesIds.has(linkedMasterStaff.id())) {
                    continue
                }

                const excerptPart = excerptStaff.part()
                const masterPart = linkedMasterStaff.part()

                //! NOTE: parts/staves of excerpt must have the same ID as parts/staves of the master score
                //! In fact, excerpts are just viewers for the master score
                excerptStaff.setId(linkedMasterStaff.id())
                excerptPart.setId(masterPart.id())

                assignedStavesIds.add(linkedMasterStaff.id())

                // For instruments with multiple staves, every staff will point to the
                // same part. To prevent adding the same part several times to the excerpt,
                // add only the part of the first staff pointing to the part.
                if (!(--nstaves)) {
                    excerpt.parts().push(linkedMasterStaff.part())
                    nstaves = linkedMasterStaff.part().nstaves()
                }
                break
            }
        }

        if (!excerpt.tracksMapping().length) { // SHOULDN'T HAPPEN, protected in the UI, but it happens during read-in!!!
            excerpt.updateTracksMapping()
        }
    }

    /** C++ createScore(): a part score with the base style */
    createScore(): Score {
        const s = new Score(this)
        s.setStyle(DefaultStyle.baseStyle())
        return s
    }
    override masterScore(): MasterScore { return this }
    override sigmap(): TimeSigMap { return this.m_sigmap }
    override tempomap(): TempoMap { return this.m_tempomap }
    setTempomap(tm: TempoMap): void { this.m_tempomap = tm }
    override undoStack(): UndoStack { return this.m_undoStack }
    override cmdState(): CmdState { return this.m_cmdState }
    addLayoutFlags(val: number): void { this.m_cmdState.layoutFlags |= val }
    setInstrumentsChanged(val: boolean): void { this.m_cmdState.instrumentsChanged = val }
    setExcerptsChanged(val: boolean): void { this.m_cmdState.excerptsChanged = val }
    excerptsChanged(): boolean { return this.m_cmdState.excerptsChanged }

    override setPlaylistDirty(): void {
        this.m_expandedRepeatList.setScoreChanged()
        this.m_nonExpandedRepeatList.setScoreChanged()
    }

    expandRepeats(): boolean { return this.m_expandRepeats }

    override loopBoundaryTick(type: LoopBoundaryType): Fraction {
        if (type === LoopBoundaryType.Unknown) {
            return new Fraction(0, 1)
        }
        return this.m_loopBoundaries[type]
    }

    override setLoopBoundaryTick(type: LoopBoundaryType, tick: Fraction): void {
        if (type === LoopBoundaryType.Unknown) {
            return
        }
        if (tick.lt(new Fraction(0, 1))) {
            tick = new Fraction(0, 1)
        }
        const last = this.lastMeasure()
        if (last && tick.gt(last.endTick())) {
            // End Reverb may last longer than written notation, but cursor position should not
            tick = last.endTick()
        }

        this.m_loopBoundaries[type] = tick
        // even though tick position might not have changed, layout might have
        // so we should update cursor here
        for (const l of [...this.m_loopBoundaryTickChanged]) {
            l(type, tick.ticks())
        }
    }

    /** C++ Score::loopBoundaryTickChanged() (a channel): returns a function removing the listener */
    onLoopBoundaryTickChanged(listener: (type: LoopBoundaryType, ticks: number) => void): () => void {
        this.m_loopBoundaryTickChanged.add(listener)
        return () => this.m_loopBoundaryTickChanged.delete(listener)
    }

    setExpandRepeats(expand: boolean): void {
        if (this.m_expandRepeats === expand) {
            return
        }
        this.m_expandRepeats = expand
        this.setPlaylistDirty()
    }

    /** needed for usage in Seq::processMessages */
    updateRepeatListTempo(): void {
        this.m_expandedRepeatList.updateTempo()
        this.m_nonExpandedRepeatList.updateTempo()
    }

    updateRepeatList(): void {
        this.m_expandedRepeatList.update(true)
        this.m_nonExpandedRepeatList.update(false)
    }

    override repeatList(expandRepeats = this.m_expandRepeats, updateTies = true): RepeatList {
        if (expandRepeats) {
            this.m_expandedRepeatList.update(true, updateTies)
            return this.m_expandedRepeatList
        }

        this.m_nonExpandedRepeatList.update(false, updateTies)
        return this.m_nonExpandedRepeatList
    }

    // ---------------------------------------------------------------------------------------------------------------
    //   MIDI mapping (port of src/engraving/dom/midimapping.cpp)
    // ---------------------------------------------------------------------------------------------------------------

    midiMapping(): MidiMapping[] { return this.m_midiMapping }
    midiMappingAt(channel: number): MidiMapping { return this.m_midiMapping[channel] }
    midiPort(idx: number): number { return this.m_midiMapping[idx].port() }
    midiChannel(idx: number): number { return this.m_midiMapping[idx].channel() }
    exportMidiMapping(): boolean { return !this.m_isSimpleMidiMapping }
    midiPortCount(): number { return this.m_midiPortCount }
    setMidiPortCount(n: number): void { this.m_midiPortCount = n }

    rebuildMidiMapping(): void {
        // TODO(port): playback score (m_playbackScore)
        this.removeDeletedMidiMapping()
        const maxport = this.updateMidiMappings()
        this.reorderMidiMapping()
        this.rebuildExcerptsMidiMapping()
        this.setMidiPortCount(maxport)
    }

    //---------------------------------------------------------
    //   checkMidiMapping
    //   midi mapping is simple if all ports and channels
    //   don't decrease and don't have 'holes' except drum tracks
    //---------------------------------------------------------

    checkMidiMapping(): void {
        this.m_isSimpleMidiMapping = true
        this.rebuildMidiMapping()

        const drum: boolean[] = []
        for (const part of this.parts()) {
            for (const instr of part.instruments().values()) {
                for (let j = 0; j < instr.channels().length; ++j) {
                    drum.push(instr.useDrumset())
                }
            }
        }
        let lastChannel = -1 // port*16+channel
        let lastDrumPort = -1
        let index = 0
        for (const m of this.m_midiMapping) {
            if (index >= drum.length) {
                break
            }
            if (drum[index]) {
                lastDrumPort++
                if (m.port() !== lastDrumPort) {
                    this.m_isSimpleMidiMapping = false
                    return
                }
            } else {
                lastChannel++
                if (lastChannel % 16 === 9) {
                    lastChannel++
                }
                const p = Math.trunc(lastChannel / 16)
                const c = lastChannel % 16
                if (m.port() !== p || m.channel() !== c) {
                    this.m_isSimpleMidiMapping = false
                    return
                }
            }
            index++
        }
    }

    private getNextFreeMidiMapping(occupiedMidiChannels: Set<number>, search: { from: number }, p = -1, ch = -1): number {
        if (ch !== -1 && p !== -1) {
            return p * 16 + ch
        } else if (ch !== -1 && p === -1) {
            for (let port = 0; ; port++) {
                if (!occupiedMidiChannels.has(port * 16 + ch)) {
                    occupiedMidiChannels.add(port * 16 + ch)
                    return port * 16 + ch
                }
            }
        } else if (ch === -1 && p !== -1) {
            for (let channel = 0; channel < 16; channel++) {
                if (channel !== 9 && !occupiedMidiChannels.has(p * 16 + channel)) {
                    occupiedMidiChannels.add(p * 16 + channel)
                    return p * 16 + channel
                }
            }
        }

        for (; ; search.from++) {
            if (search.from % 16 !== 9 && !occupiedMidiChannels.has(search.from)) {
                occupiedMidiChannels.add(search.from)
                return search.from
            }
        }
    }

    private getNextFreeDrumMidiMapping(occupiedMidiChannels: Set<number>): number {
        for (let i = 0; ; i++) {
            if (!occupiedMidiChannels.has(i * 16 + 9)) {
                occupiedMidiChannels.add(i * 16 + 9)
                return i * 16 + 9
            }
        }
    }

    private rebuildExcerptsMidiMapping(): void {
        for (const ex of this.excerpts()) {
            const excerptScore = ex.excerptScore()
            if (!excerptScore) {
                continue
            }
            for (const p of excerptScore.parts()) {
                const masterPart = p.masterPart()
                if (!masterPart.score().isMaster()) {
                    // C++ LOGW() << "rebuildExcerptsMidiMapping: no part in master score is linked with " << p->partName()
                    continue
                }
                for (const [tick, iMaster] of masterPart.instruments()) {
                    const iLocal = p.instrument(Fraction.fromTicks(tick))
                    const nchannels = iMaster.channels().length
                    if (iLocal.channels().length !== nchannels) {
                        // may happen, e.g., if user changes an instrument
                        iLocal.assign(iMaster)
                        continue
                    }
                    for (let c = 0; c < nchannels; ++c) {
                        const cLocal = iLocal.channel(c)!
                        const cMaster = iMaster.channel(c)!
                        cLocal.setChannel(cMaster.channel())
                    }
                }
            }
        }
    }

    //---------------------------------------------------------
    //   reorderMidiMapping
    //   Set mappings in order you see in Add->Instruments
    //---------------------------------------------------------

    private reorderMidiMapping(): void {
        let sequenceNumber = 0
        for (const part of this.parts()) {
            for (const instr of part.instruments().values()) {
                for (const channel of instr.channels()) {
                    if (this.m_midiMapping[sequenceNumber].part() === part
                        && this.m_midiMapping[sequenceNumber].m_masterChannel === channel) {
                        sequenceNumber++
                        continue
                    }

                    const shouldBe = channel.channel()
                    const tmp = this.m_midiMapping[sequenceNumber]
                    this.m_midiMapping[sequenceNumber] = this.m_midiMapping[shouldBe]
                    this.m_midiMapping[shouldBe] = tmp
                    this.m_midiMapping[sequenceNumber].articulation().setChannel(sequenceNumber)
                    channel.setChannel(sequenceNumber)
                    this.m_midiMapping[shouldBe].articulation().setChannel(shouldBe)

                    sequenceNumber++
                }
            }
        }
    }

    //---------------------------------------------------------
    //   removeDeletedMidiMapping
    //   Remove mappings to deleted instruments
    //---------------------------------------------------------

    private removeDeletedMidiMapping(): void {
        let removeOffset = 0
        const mappingSize = this.m_midiMapping.length
        for (let index = 0; index < mappingSize; index++) {
            const part = this.m_midiMapping[index].part()
            if (!part || !this.parts().includes(part)) {
                removeOffset++
                continue
            }
            // Not all channels could exist
            let channelExists = false
            for (const instr of part.instruments().values()) {
                const mm = this.m_midiMapping[index]
                channelExists = mm.articulation().channel() !== -1
                                && instr.channels().includes(mm.m_masterChannel!)
                                && !(mm.port() === -1 && mm.channel() === -1)
                if (channelExists) {
                    break
                }
            }
            if (!channelExists) {
                removeOffset++
                continue
            }
            // Let's do a left shift by 'removeOffset' items if necessary
            if (index !== 0 && removeOffset !== 0) {
                this.m_midiMapping[index - removeOffset] = this.m_midiMapping[index]

                const chanVal = this.m_midiMapping[index - removeOffset].articulation().channel()
                this.m_midiMapping[index - removeOffset].articulation().setChannel(chanVal - removeOffset)
            }
        }
        // We have 'removeOffset' deleted instruments, let's remove their mappings
        for (let index = 0; index < removeOffset; index++) {
            this.m_midiMapping.pop()
        }
    }

    //---------------------------------------------------------
    //   updateMidiMapping
    //   Add mappings to new instruments and repair existing ones
    //   (C++ int updateMidiMapping(), renamed: TS has no overloads)
    //---------------------------------------------------------

    private updateMidiMappings(): number {
        const maxport = { v: 0 }
        const occupiedMidiChannels = new Set<number>() // each entry is port*16+channel, port range: 0-inf, channel: 0-15
        const search = { from: 0 } // makes getting next free MIDI mapping faster

        for (const mm of this.m_midiMapping) {
            if (mm.port() === -1 || mm.channel() === -1) {
                continue
            }
            occupiedMidiChannels.add(mm.port() * 16 + mm.channel())
            if (maxport.v < mm.port()) {
                maxport.v = mm.port()
            }
        }

        for (const part of this.parts()) {
            for (const instr of part.instruments().values()) {
                const useDrumset = instr.useDrumset()
                for (const channel of instr.channels()) {
                    this.doUpdateMidiMapping(maxport, occupiedMidiChannels, search, part, channel, useDrumset)
                }
            }
        }

        return maxport.v
    }

    private doUpdateMidiMapping(maxport: { v: number }, occupiedMidiChannels: Set<number>, search: { from: number },
                                part: Part, channel: InstrChannel, useDrumset: boolean): void {
        let channelExists = false
        for (const mapping of this.m_midiMapping) {
            const validChannelIndex = channel.channel() >= 0 && channel.channel() < this.m_midiMapping.length
            if (channel === mapping.m_masterChannel && validChannelIndex) {
                channelExists = true
                break
            }
        }

        if (!channelExists) {
            let midiPort: number
            let midiChannel: number

            if (useDrumset) {
                midiPort = Math.trunc(this.getNextFreeDrumMidiMapping(occupiedMidiChannels) / 16)
                midiChannel = 9
            } else {
                const nm = this.getNextFreeMidiMapping(occupiedMidiChannels, search)
                midiPort = Math.trunc(nm / 16)
                midiChannel = nm % 16
            }

            if (midiPort > maxport.v) {
                maxport.v = midiPort
            }

            this.addMidiMapping(channel, part, midiPort, midiChannel)
            return
        }

        // Channel could already exist, but have unassigned port or channel...
        const mapping = this.m_midiMapping[channel.channel()]

        if (mapping.port() === -1) {
            const nm = this.getNextFreeMidiMapping(occupiedMidiChannels, search, -1, mapping.channel())
            mapping.m_port = Math.trunc(nm / 16)
            return
        }

        if (this.m_midiMapping[channel.channel()].channel() === -1) {
            if (useDrumset) {
                mapping.m_port = Math.trunc(this.getNextFreeDrumMidiMapping(occupiedMidiChannels) / 16)
                mapping.m_channel = 9
                return
            }
            const nm = this.getNextFreeMidiMapping(occupiedMidiChannels, search, mapping.port())
            mapping.m_port = Math.trunc(nm / 16)
            mapping.m_channel = nm % 16
        }
    }

    addMidiMapping(channel: InstrChannel, part: Part, midiPort: number, midiChannel: number): void {
        if (!part.score().isMaster()) {
            return
        }

        const mm = new MidiMapping()
        mm.m_part = part
        mm.m_masterChannel = channel
        mm.m_articulation = channel.clone()
        mm.m_link = new PartChannelSettingsLink(mm.articulation(), mm.m_masterChannel, /* excerpt */ false)

        mm.m_port = midiPort
        mm.m_channel = midiChannel

        const mscoreChannel = this.m_midiMapping.length
        mm.m_articulation.setChannel(mscoreChannel)
        mm.m_masterChannel.setChannel(mscoreChannel)

        this.m_midiMapping.push(mm)
    }

    /** C++ updateMidiMapping(InstrChannel*, Part*, int midiPort, int midiChannel) */
    updateMidiMapping(channel: InstrChannel, part: Part | null, midiPort: number, midiChannel: number): void {
        const c = channel.channel()
        if (c < 0) {
            return
        }
        if (c >= this.m_midiMapping.length) {
            // C++ LOGD("Can't set midi channel: midiMapping is empty!")
            return
        }
        const mm = this.m_midiMapping[c]

        if (midiChannel !== -1) {
            mm.m_channel = midiChannel
        }
        if (midiPort !== -1) {
            mm.m_port = midiPort
        }
        if (part) {
            mm.m_part = part.masterPart()
        }
    }

    mscoreVersion(): string { return this.m_mscoreVersion }
    setMscoreVersion(v: string): void { this.m_mscoreVersion = v }
    mscoreRevision(): number { return this.m_mscoreRevision }
    setMscoreRevision(v: number): void { this.m_mscoreRevision = v }
}
