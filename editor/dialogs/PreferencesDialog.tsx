/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Preferences (MuseScore's PreferencesDialog.qml): pages in a side bar; for now "General" with the language,
 * "Save & publish" with the auto save (SaveAndPublishPreferencesPage.qml: AutoSaveSection), "Note input" with the MIDI
 * devices and the note preview (NoteInputPreferencesPage.qml: MidiInputSection, NotePreviewSection), "Audio & MIDI"
 * (AudioMidiPreferencesPage.qml: MidiDevicesSection, the input only), "MIDI mappings" (MidiDeviceMappingPage.qml), "Import"
 * (ImportPreferencesPage.qml: the style for imports, MusicXML and MIDI; Overture, MEI and MNX are not ported) and "Web
 * version" with the settings of the web version (not in MuseScore).
 */
import { useEffect, useRef, useState } from 'react'
import { actionTitle, formatShortcut, shortcuts } from '../actions/actions'
import { ICON_CODES } from '../actions/uiactiondata'
import { arg, currentLanguage, languageList, qtrc, setLanguage, useLanguage, webtr } from '../i18n'
import { pickFile } from '../files'
import { NONE_DEVICE_ID } from '../../src/index'
import { updateSettings, useSettings } from '../settings'
import { MidiMappingsPage } from './MidiMappingsPage'
import { inputDeviceSelected, isMidiInputOn, midiAccessProblem, setMidiInputOn, useMidiState } from '../midi/midicontroller'

const PAGES: readonly { id: string; title: string; icon: number; web?: boolean }[] = [
    { id: 'general', title: 'General', icon: ICON_CODES.SETTINGS_COG },
    { id: 'cloud', title: 'Save & publish', icon: ICON_CODES.CLOUD_FILE },
    { id: 'note-input', title: 'Note input', icon: ICON_CODES.EDIT },
    { id: 'audio-midi', title: 'Audio & MIDI', icon: ICON_CODES.AUDIO },
    { id: 'midi-device-mapping', title: 'MIDI mappings', icon: ICON_CODES.MIDI_INPUT },
    { id: 'import', title: 'Import', icon: ICON_CODES.IMPORT },
    { id: 'web', title: 'Web version', icon: ICON_CODES.GLOBE, web: true },
]

function GeneralPage(): React.JSX.Element {
    useLanguage()
    const { ui } = useSettings()
    const [loading, setLoading] = useState(false)
    const languages = languageList()
    return (
        <section className="preferences-section" aria-labelledby="pref-language">
            <h3 id="pref-language">{qtrc('preferences', 'Language')}</h3>
            <label className="field">
                <span className="visually-hidden">{qtrc('preferences', 'Language')}</span>
                <select value={ui.language} disabled={loading}
                    onChange={async (e) => {
                        setLoading(true)
                        try {
                            await setLanguage(e.target.value)
                        } finally {
                            setLoading(false)
                        }
                    }}>
                    <option value="system">{qtrc('preferences', 'System default')}</option>
                    {languages.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
                </select>
            </label>
            <p className="muted hint">
                {ui.language === 'system' ? `${qtrc('preferences', 'System default')}: ${languages.find(l => l.code === currentLanguage())?.name ?? 'English'}` : ''}
            </p>
        </section>
    )
}

/** AutoSaveSection.qml: "Auto save every [n] min" */
function SaveAndPublishPage(): React.JSX.Element {
    useLanguage()
    const { project } = useSettings()
    return (
        <section className="preferences-section" aria-labelledby="pref-autosave">
            <h3 id="pref-autosave">{qtrc('preferences', 'Auto save')}</h3>
            <div className="autosave-row">
                <label className="check">
                    <input type="checkbox" checked={project.autoSaveEnabled}
                        onChange={e => updateSettings('project', { autoSaveEnabled: e.target.checked })} />
                    {qtrc('preferences', 'Auto save every')}
                </label>
                <span className="number-with-unit">
                    <input type="number" min={1} max={100} step={1} disabled={!project.autoSaveEnabled}
                        aria-label={qtrc('preferences', 'Auto save every')}
                        value={Math.max(1, Math.round(project.autoSaveInterval))}
                        onChange={(e) => {
                            const v = Math.round(Number(e.target.value))
                            if (v >= 1 && v <= 100) {
                                updateSettings('project', { autoSaveInterval: v })
                            }
                        }} />
                    {' ' + qtrc('global', 'min', 'abbreviation of minutes')}
                </span>
            </div>
        </section>
    )
}

/** why the browser gives no access to MIDI devices */
function MidiAccessHint(): React.JSX.Element | null {
    const problem = midiAccessProblem(useMidiState().access)
    return problem ? <p className="muted hint midi-access-hint">{problem}</p> : null
}

/** MidiInputSection.qml */
function MidiInputSection(): React.JSX.Element {
    const { midi } = useSettings()
    const { access } = useMidiState()
    const on = isMidiInputOn()
    return (
        <section className="preferences-section midi-devices" aria-labelledby="pref-midi-devices">
            <h3 id="pref-midi-devices">{qtrc('preferences', 'MIDI devices')}</h3>
            <label className="check">
                <input type="checkbox" checked={on} disabled={access === 'unsupported'} onChange={e => setMidiInputOn(e.target.checked)} />
                {qtrc('preferences', 'Enable MIDI input')}
            </label>
            <MidiAccessHint />
            <label className="check">
                <input type="checkbox" disabled={!on} checked={midi.startNoteInputWhenPressingKey}
                    onChange={e => updateSettings('midi', { startNoteInputWhenPressingKey: e.target.checked })} />
                {qtrc('preferences', 'When pressing a key, begin note input at the selected measure, note, or rest')}
            </label>
            <details className="preferences-expandable">
                <summary>{qtrc('preferences', 'Real-time input modes')}</summary>
                <label className="check">
                    <input type="checkbox" disabled={!on} checked={midi.advanceToNextNoteOnKeyRelease}
                        onChange={e => updateSettings('midi', { advanceToNextNoteOnKeyRelease: e.target.checked })} />
                    {qtrc('preferences', 'Advance to next note on key release')}
                </label>
                <div className="autosave-row">
                    <span>{qtrc('preferences', 'Delay between notes')}</span>
                    <span className="number-with-unit">
                        <input type="number" min={1} max={10000} step={1} disabled={!on} aria-label={qtrc('preferences', 'Delay between notes')}
                            value={midi.realtimeDelay}
                            onChange={(e) => {
                                const v = Math.round(Number(e.target.value))
                                if (v >= 1 && v <= 10000) {
                                    updateSettings('midi', { realtimeDelay: v })
                                }
                            }} />
                        {' ' + qtrc('global', 'ms')}
                    </span>
                </div>
            </details>
        </section>
    )
}

/** NoteInputPreferencesPage.qml: NoteInputSection, MidiInputSection, NotePreviewSection */
function NoteInputPage(): React.JSX.Element {
    useLanguage()
    const { playback, midi, noteInput } = useSettings()
    const play = playback.playNotesWhenEditing
    const midiBoxEnabled = isMidiInputOn() && play
    const check = (key: 'playChordWhenEditing' | 'playHarmonyWhenEditing' | 'playPreviewNotesInInputByDuration' | 'playPreviewNotesWithScoreDynamics',
                   text: string): React.JSX.Element => (
        <label className="check">
            <input type="checkbox" disabled={!play} checked={play && playback[key]}
                onChange={e => updateSettings('playback', { [key]: e.target.checked })} />
            {qtrc('preferences', text)}
        </label>
    )
    return (
        <>
        <section className="preferences-section note-input" aria-labelledby="pref-note-input">
            <h3 id="pref-note-input">{qtrc('preferences', 'Note input')}</h3>
            <div className="autosave-row">
                <span>{qtrc('preferences', 'Default input mode')}</span>
                <select aria-label={qtrc('preferences', 'Default input mode')} value={noteInput.defaultMethod}
                    onChange={e => updateSettings('noteInput', { defaultMethod: e.target.value as typeof noteInput.defaultMethod })}>
                    <option value="note-input-by-note-name">{actionTitle('note-input-by-note-name')}</option>
                    <option value="note-input-by-duration">{actionTitle('note-input-by-duration')}</option>
                </select>
            </div>
            <div className="autosave-row">
                <span>{qtrc('preferences', 'Apply accidentals, augmentation dots, and articulations')}</span>
                <select aria-label={qtrc('preferences', 'Apply accidentals, augmentation dots, and articulations')}
                    value={noteInput.addAccidentalDotsArticulationsToNextNoteEntered ? '0' : '1'}
                    onChange={e => updateSettings('noteInput', { addAccidentalDotsArticulationsToNextNoteEntered: e.target.value === '0' })}>
                    <option value="0">{qtrc('preferences', 'To next note entered')}</option>
                    <option value="1">{qtrc('preferences', 'To previous note entered')}</option>
                </select>
            </div>
            <div className="autosave-row">
                <span>{qtrc('preferences', 'Input by duration mode cursor')}</span>
                <select aria-label={qtrc('preferences', 'Input by duration mode cursor')}
                    value={noteInput.useNoteInputCursorInInputByDuration ? '1' : '0'}
                    onChange={e => updateSettings('noteInput', { useNoteInputCursorInInputByDuration: e.target.value === '1' })}>
                    <option value="0">{qtrc('preferences', 'Above staff')}</option>
                    <option value="1">{qtrc('preferences', 'On staff')}</option>
                </select>
            </div>
        </section>
        <MidiInputSection />
        <section className="preferences-section" aria-labelledby="pref-note-preview">
            <h3 id="pref-note-preview">{qtrc('preferences', 'Note preview')}</h3>
            <label className="check">
                <input type="checkbox" checked={play} onChange={e => updateSettings('playback', { playNotesWhenEditing: e.target.checked })} />
                {qtrc('preferences', 'Hear playback when adding, editing, and selecting notes')}
            </label>
            <div className="autosave-row">
                <span>{qtrc('preferences', 'Playback duration')}</span>
                <span className="number-with-unit">
                    <input type="number" min={0} max={10000} step={1} disabled={!play} aria-label={qtrc('preferences', 'Playback duration')}
                        value={playback.notePlayDuration}
                        onChange={(e) => {
                            const v = Math.round(Number(e.target.value))
                            if (v >= 0 && v <= 10000) {
                                updateSettings('playback', { notePlayDuration: v })
                            }
                        }} />
                    {' ' + qtrc('global', 'ms')}
                </span>
            </div>
            {check('playChordWhenEditing', 'Play chord when editing')}
            {check('playHarmonyWhenEditing', 'Play chord symbols and Nashville numbers')}
            {check('playPreviewNotesInInputByDuration', 'Play when setting pitch (input by duration mode only)')}
            {check('playPreviewNotesWithScoreDynamics', 'Play preview notes with score dynamics')}
            <label className="check">
                <input type="checkbox" disabled={!midiBoxEnabled} checked={midiBoxEnabled && playback.playNotesOnMidiInput}
                    onChange={e => updateSettings('playback', { playNotesOnMidiInput: e.target.checked })} />
                {qtrc('preferences', 'Play MIDI input')}
            </label>
            <label className="check">
                <input type="checkbox" disabled={!midiBoxEnabled || !playback.playNotesOnMidiInput}
                    checked={midiBoxEnabled && midi.useMidiVelocityAndDuration}
                    onChange={e => updateSettings('midi', { useMidiVelocityAndDuration: e.target.checked })} />
                {qtrc('preferences', 'Play MIDI notes with velocity and duration during note input')}
            </label>
        </section>
        </>
    )
}

/**
 * AudioMidiPreferencesPage.qml: MidiDevicesSection. The input only: the sound output of a browser goes to its own
 * synthesizer, so there is no audio API, MIDI output or MIDI 2.0
 */
function AudioMidiPage(): React.JSX.Element {
    useLanguage()
    const { access, devices, deviceId } = useMidiState()
    return (
        <section className="preferences-section" aria-labelledby="pref-midi">
            <h3 id="pref-midi">{qtrc('preferences', 'MIDI')}</h3>
            <div className="autosave-row">
                <span>{qtrc('preferences', 'MIDI input')}</span>
                <select aria-label={qtrc('preferences', 'MIDI input')} disabled={access !== 'granted'} value={deviceId || NONE_DEVICE_ID}
                    onChange={e => inputDeviceSelected(e.target.value)}>
                    {devices.map(d => <option key={d.id} value={d.id}>{d.id === NONE_DEVICE_ID ? qtrc('midi', 'No device') : d.name}</option>)}
                </select>
            </div>
            <MidiAccessHint />
        </section>
    )
}

/** ImportPreferencesModel::shortestNotes: the shortest note of the MIDI import in ticks (Constants::DIVISION = 480) */
const SHORTEST_NOTES: readonly [string, number][] = [
    ['Quarter', 480], ['Eighth', 240], ['16th', 120], ['32nd', 60], ['64th', 30], ['128th', 15], ['256th', 7], ['512th', 3], ['1024th', 1],
]

/** ImportPreferencesPage.qml: ImportStyleSection, MusicXmlSection, MidiSection */
function ImportPage(): React.JSX.Element {
    useLanguage()
    const { import: imp } = useSettings()
    // ImportStyleSection: "Use style file" can be chosen before a file is chosen
    const [useStyleFileExplicitlySet, setUseStyleFileExplicitlySet] = useState(false)
    const useStyleFile = useStyleFileExplicitlySet || imp.styleFile !== null
    const chooseStyle = async (): Promise<void> => {
        const file = await pickFile({ description: qtrc('preferences', 'MuseScore style file'), accept: { 'application/octet-stream': ['.mss'] } })
        if (file) {
            updateSettings('import', { styleFile: { name: file.name, content: await file.text() } })
        }
    }
    const musicXml = (key: keyof typeof imp.musicXml, text: string): React.JSX.Element => (
        <label className="check">
            <input type="checkbox" checked={imp.musicXml[key]}
                onChange={e => updateSettings('import', { musicXml: { ...imp.musicXml, [key]: e.target.checked } })} />
            {qtrc('preferences', text)}
        </label>
    )
    return (
        <>
            <section className="preferences-section" aria-labelledby="pref-import-style">
                <h3 id="pref-import-style">{qtrc('preferences', 'Style used for import')}</h3>
                <label className="check">
                    <input type="radio" name="import-style" checked={!useStyleFile}
                        onChange={() => {
                            setUseStyleFileExplicitlySet(false)
                            updateSettings('import', { styleFile: null })
                        }} />
                    {qtrc('preferences', 'Built-in style')}
                </label>
                <div className="autosave-row import-style-row">
                    <label className="check">
                        <input type="radio" name="import-style" checked={useStyleFile} onChange={() => setUseStyleFileExplicitlySet(true)} />
                        {qtrc('preferences', 'Use style file')}
                    </label>
                    <input type="text" readOnly className="import-style-path" disabled={!useStyleFile} value={imp.styleFile?.name ?? ''}
                        aria-label={qtrc('preferences', 'Use style file')} />
                    <button className="secondary" disabled={!useStyleFile} title={qtrc('preferences', 'Choose default style for imports')}
                        onClick={() => void chooseStyle()}>{qtrc('ui', 'Browse')}</button>
                </div>
            </section>
            <section className="preferences-section" aria-labelledby="pref-import-musicxml">
                <h3 id="pref-import-musicxml">{qtrc('preferences', 'MusicXML')}</h3>
                {musicXml('importLayout', 'Import layout')}
                {musicXml('importBreaks', 'Import system and page breaks')}
                {musicXml('needUseDefaultFont', 'Apply default typeface (Edwin) to imported scores')}
                {musicXml('inferTextType', 'Infer text type based on content where possible')}
            </section>
            <section className="preferences-section" aria-labelledby="pref-import-midi">
                <h3 id="pref-import-midi">{qtrc('preferences', 'MIDI')}</h3>
                <div className="autosave-row">
                    <span>{qtrc('preferences', 'Shortest note')}</span>
                    <select className="import-shortest-note" aria-label={qtrc('preferences', 'Shortest note')} value={imp.midi.midiShortestNote}
                        onChange={e => updateSettings('import', { midi: { ...imp.midi, midiShortestNote: Number(e.target.value) } })}>
                        {SHORTEST_NOTES.map(([title, ticks]) => <option key={ticks} value={ticks}>{qtrc('preferences', title)}</option>)}
                    </select>
                </div>
                <label className="check">
                    <input type="checkbox" checked={imp.midi.roundTempo}
                        onChange={e => updateSettings('import', { midi: { ...imp.midi, roundTempo: e.target.checked } })} />
                    {qtrc('appshell/preferences', 'Round tempos to nearest whole number')}
                </label>
            </section>
        </>
    )
}

/** the settings of the web version (not in MuseScore) */
function WebVersionPage(): React.JSX.Element {
    useLanguage()
    const { web } = useSettings()
    return (
        <section className="preferences-section" aria-labelledby="pref-web">
            <h3 id="pref-web">{webtr('Web version')}</h3>
            <label className="check">
                <input type="checkbox" checked={web.spacePan} onChange={e => updateSettings('web', { spacePan: e.target.checked })} />
                {webtr('Hold Space and drag to move the score')}
            </label>
            <p className="muted hint">
                {/* playback then starts with Shift+Space and stops with Escape */}
                {actionTitle('play-from-selection')}: {formatShortcut(shortcuts('play-from-selection')[0] ?? 'Shift+Space')},
                {' '}{actionTitle('stop')}: {formatShortcut('Esc')}.
                {' '}
                {webtr('Otherwise Space starts and stops playback and the middle mouse button moves the score.')}
            </p>
        </section>
    )
}

export function PreferencesDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
    useLanguage()
    const ref = useRef<HTMLDialogElement>(null)
    const [page, setPage] = useState<string>('general')
    useEffect(() => {
        ref.current?.showModal()
    }, [])
    return (
        <dialog ref={ref} className="preferences" aria-labelledby="preferences-title" onClose={onClose}>
            <header className="dialog-header">
                <h2 id="preferences-title">{qtrc('preferences', 'Preferences')}</h2>
                <button className="icon" aria-label={qtrc('global', 'Close')} title={qtrc('global', 'Close')} onClick={() => ref.current?.close()}>{''}</button>
            </header>
            <div className="preferences-body">
                <ul className="preferences-pages" role="tablist" aria-orientation="vertical">
                    {PAGES.map(p => (
                        <li key={p.id} role="tab" aria-selected={page === p.id} tabIndex={0} onClick={() => setPage(p.id)}
                            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPage(p.id) } }}>
                            <span className="icon-glyph" aria-hidden="true">{String.fromCodePoint(p.icon)}</span>
                            {p.web ? webtr(p.title) : qtrc('preferences', p.title)}
                        </li>
                    ))}
                </ul>
                <div className="preferences-page" role="tabpanel">
                    {page === 'general' && <GeneralPage />}
                    {page === 'cloud' && <SaveAndPublishPage />}
                    {page === 'note-input' && <NoteInputPage />}
                    {page === 'audio-midi' && <AudioMidiPage />}
                    {page === 'midi-device-mapping' && <MidiMappingsPage />}
                    {page === 'import' && <ImportPage />}
                    {page === 'web' && <WebVersionPage />}
                </div>
            </div>
            <form method="dialog" className="dialog-buttons">
                <button className="primary" value="ok">{qtrc('global', 'OK')}</button>
            </form>
        </dialog>
    )
}
