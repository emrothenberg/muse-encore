/*
 * SPDX-License-Identifier: GPL-3.0-only
 * The playback toolbar (MuseScore's PlaybackToolBar.qml / PlaybackToolBarActions.qml / PlaybackToolBarModel): the
 * actions of PlaybackUiActions::defaultPlaybackToolConfig (rewind, play/pause, loop, metronome; loop in/out are in the
 * settings menu of the docked toolbar), the "Playback settings" menu, the play time, measure and beat, the tempo with
 * the speed popup. Not in MuseScore: the mute button, the progress of loading the sounds and the playalong (its button;
 * while it is on the previous/next measure buttons, the practice mode and the measure followed; in note input mode the
 * button enters the notes played; the notes heard are shown in the status bar).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { actionDescription, isActionEnabled, shortcutText, triggerAction, useActions } from '../actions/actions'
import { ICON_CODES } from '../actions/uiactiondata'
import { MenuPopup } from '../components/Menu'
import { qtrc, trString, useLanguage, webtr } from '../i18n'
import type { MenuItem } from '../menus/appmenu'
import { rewindTo, rewindToBeat, setTempoMultiplier, usePlaybackState } from '../playback/playbackcontroller'
import { ActionButton } from './ToolBars'
import { usePlayalongState } from '../playalong/playalongcontroller'

const icon = (code: number): string => String.fromCodePoint(code)

/** MusicalSymbolCodes::CROTCHET (Leland) */
const CROTCHET = ''

function tooltip(code: string): string {
    const sc = shortcutText(code)
    return sc ? `${actionDescription(code)} (${sc})` : actionDescription(code)
}

/** PlaybackToolBarModel::playAction: the play button shows "pause" while playing */
function PlayButton(): React.JSX.Element {
    useActions()
    const st = usePlaybackState()
    return (
        <button className="tool-button" data-action="play" title={tooltip('play')} aria-label={actionDescription('play')}
            disabled={!isActionEnabled('play')} onClick={() => triggerAction('play')}>
            <span className="tool-icon" aria-hidden="true">{icon(st.playing ? ICON_CODES.PAUSE : ICON_CODES.PLAY)}</span>
        </button>
    )
}

/** the sound output on/off (not in MuseScore): the speaker, crossed out while muted */
function MuteButton(): React.JSX.Element {
    useActions()
    const st = usePlaybackState()
    return (
        <button className={`tool-button mute-button${st.muted ? ' muted' : ''}`} data-action="playback-mute" title={tooltip('playback-mute')}
            aria-label={actionDescription('playback-mute')} aria-pressed={st.muted} onClick={() => triggerAction('playback-mute')}>
            <span className="tool-icon" aria-hidden="true">{icon(ICON_CODES.AUDIO)}</span>
        </button>
    )
}

/**
 * the "Playback settings" menu: PlaybackUiActions::midiInputActions, the MIDI input pitch, settingsActions, the overtone filter of the playalong (not in
 * MuseScore) and (docked) the loop boundary actions
 */
const SETTINGS_ITEMS: MenuItem[] = [
    { kind: 'action', code: 'midi-on' },
    {
        kind: 'menu', id: 'midi-input-pitch', title: ['notation', 'MIDI input pitch'], items: [
            { kind: 'action', code: 'midi-input-written-pitch' },
            { kind: 'action', code: 'midi-input-sounding-pitch' },
        ],
    },
    { kind: 'separator' },
    { kind: 'action', code: 'repeat' },
    { kind: 'action', code: 'play-chord-symbols' },
    { kind: 'action', code: 'toggle-hear-playback-when-editing' },
    { kind: 'action', code: 'pan' },
    { kind: 'action', code: 'smooth-pan' },
    { kind: 'action', code: 'countin' },
    { kind: 'separator' },
    {
        kind: 'menu', id: 'playalong-overtone-filter', title: [null, 'Overtone filter'], items: [
            { kind: 'action', code: 'playalong-overtone-filter-off' },
            { kind: 'action', code: 'playalong-overtone-filter-normal' },
            { kind: 'action', code: 'playalong-overtone-filter-strong' },
            { kind: 'action', code: 'playalong-overtone-filter-calibrated' },
            { kind: 'separator' },
            { kind: 'action', code: 'playalong-calibrate' },
        ],
    },
    { kind: 'action', code: 'playalong-keep-microphone' },
    { kind: 'separator' },
    { kind: 'action', code: 'loop-in' },
    { kind: 'action', code: 'loop-out' },
]

function SettingsButton(): React.JSX.Element {
    useLanguage()
    const [open, setOpen] = useState(false)
    const ref = useRef<HTMLButtonElement>(null)
    const title = trString(['action', 'Playback settings'])
    return (
        <>
            <button ref={ref} className="tool-button" title={title} aria-label={title} aria-haspopup="menu" aria-expanded={open}
                data-action="playback-settings" onClick={() => setOpen(!open)}>
                <span className="tool-icon" aria-hidden="true">{icon(ICON_CODES.SETTINGS_COG)}</span>
            </button>
            {open && ref.current && (
                <MenuPopup items={SETTINGS_ITEMS} anchor={ref.current.getBoundingClientRect()} placement="below" label={title}
                    onClose={(back) => { setOpen(false); if (back) { ref.current?.focus() } }} />
            )}
        </>
    )
}

/** TimeInputField: the play time (h:mm:ss.d); Enter goes to the typed time */
function formatTime(secs: number): string {
    const t = Math.max(0, secs)
    const h = Math.floor(t / 3600)
    const m = Math.floor(t / 60) % 60
    const s = t % 60
    return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`
}

function parseTime(text: string): number | null {
    const parts = text.trim().split(':').map(Number)
    if (!parts.length || parts.some(p => !Number.isFinite(p) || p < 0)) {
        return null
    }
    return parts.reduce((acc, p) => acc * 60 + p, 0)
}

function TimeField(): React.JSX.Element {
    const st = usePlaybackState()
    const [editing, setEditing] = useState<string | null>(null)
    return (
        <input className="playback-time" aria-label={qtrc('global', 'Seconds')} value={editing ?? formatTime(st.position)}
            onFocus={e => { setEditing(formatTime(st.position)); e.currentTarget.select() }}
            onChange={e => setEditing(e.target.value)}
            onBlur={() => setEditing(null)}
            onKeyDown={(e) => {
                if (e.key === 'Enter') {
                    const t = parseTime(e.currentTarget.value)
                    if (t !== null) {
                        rewindTo(t)
                    }
                    setEditing(null)
                    e.currentTarget.blur()
                } else if (e.key === 'Escape') {
                    setEditing(null)
                    e.currentTarget.blur()
                }
            }} />
    )
}

/** MeasureAndBeatFields: measure and beat of the play position (editable) */
function MeasureBeatFields(): React.JSX.Element {
    const st = usePlaybackState()
    const measure = st.beat.measureIndex + 1
    const beat = Math.trunc(st.beat.beat) + 1
    return (
        <span className="playback-measure-beat">
            <input type="number" aria-label={qtrc('playback', 'Measure', 'Measure number')} min={1} max={st.beat.maxMeasureIndex + 1}
                value={measure} onChange={(e) => {
                    const m = Number(e.target.value)
                    if (m >= 1 && m <= st.beat.maxMeasureIndex + 1 && m !== measure) {
                        rewindToBeat(m - 1, Math.trunc(st.beat.beat))
                    }
                }} />
            <span aria-hidden="true">.</span>
            <input type="number" aria-label={qtrc('playback', 'Beat', 'Beat number')} min={1} max={st.beat.maxBeatIndex + 1}
                value={beat} onChange={(e) => {
                    const b = Number(e.target.value)
                    if (b >= 1 && b <= st.beat.maxBeatIndex + 1 && b !== beat) {
                        rewindToBeat(st.beat.measureIndex, b - 1)
                    }
                }} />
        </span>
    )
}

/** PlaybackSpeedPopup / PlaybackSpeedSlider: 10 % to 300 % */
function SpeedPopup({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }): React.JSX.Element {
    useLanguage()
    const st = usePlaybackState()
    const ref = useRef<HTMLDivElement>(null)
    const [pos, setPos] = useState({ left: 0, top: 0 })
    useLayoutEffect(() => {
        const a = anchor.getBoundingClientRect()
        const w = ref.current?.offsetWidth ?? 280
        setPos({ left: Math.max(8, Math.min(a.left + a.width / 2 - w / 2, window.innerWidth - w - 8)), top: a.bottom + 4 })
    }, [anchor])
    useEffect(() => {
        const onDown = (e: PointerEvent): void => {
            if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
                onClose()
            }
        }
        document.addEventListener('pointerdown', onDown, true)
        return () => document.removeEventListener('pointerdown', onDown, true)
    }, [anchor, onClose])
    const percent = Math.round(st.tempoMultiplier * 100)
    return (
        <div ref={ref} className="speed-popup" role="dialog" aria-label={qtrc('playback', 'Playback speed popup')} tabIndex={-1}
            style={{ left: pos.left, top: pos.top }}
            onKeyDown={(e) => {
                if (e.key === 'Escape') {
                    e.stopPropagation()
                    onClose()
                    anchor.focus()
                }
            }}>
            <label className="speed-label" htmlFor="playback-speed">{qtrc('playback', 'Speed')}</label>
            <span className="number-with-unit">
                <input id="playback-speed" type="number" min={10} max={300} step={5} value={percent}
                    aria-label={qtrc('playback', 'Speed')}
                    onChange={(e) => {
                        const v = Number(e.target.value)
                        if (v >= 10 && v <= 300) {
                            setTempoMultiplier(v / 100)
                        }
                    }} />
                %
            </span>
            <input type="range" min={0.1} max={3} step={0.05} value={st.tempoMultiplier} aria-label={qtrc('playback', 'Speed')}
                onChange={e => setTempoMultiplier(Number(e.target.value))} />
        </div>
    )
}

function TempoButton(): React.JSX.Element {
    useLanguage()
    const st = usePlaybackState()
    const [open, setOpen] = useState(false)
    const ref = useRef<HTMLButtonElement>(null)
    return (
        <>
            <button ref={ref} className="tool-button with-title tempo-button" title={qtrc('playback', 'Speed')} aria-haspopup="dialog" aria-expanded={open}
                aria-label={`${qtrc('playback', 'Speed')}: ${st.tempo}`} onClick={() => setOpen(!open)}>
                <span className="tempo-note" aria-hidden="true">{CROTCHET}</span>
                <span className="tempo-value">{` = ${st.tempo}`}</span>
            </button>
            {open && ref.current && <SpeedPopup anchor={ref.current} onClose={() => setOpen(false)} />}
        </>
    )
}

/** the progress of loading the sounds (MuseScore: PlaybackLoadingInfo) and errors */
function LoadingInfo(): React.JSX.Element | null {
    const st = usePlaybackState()
    if (st.loading === null && !st.error) {
        return null
    }
    if (st.error) {
        return <span className="playback-loading error" role="status" title={st.error}>{`${qtrc('playback', 'Loading audio samples')} ✕`}</span>
    }
    const pct = Number.isFinite(st.loading) ? Math.round(st.loading! * 100) : null
    return (
        <span className="playback-loading" role="status" title={qtrc('playback', 'Loading audio samples')}>
            <progress max={1} value={pct === null ? undefined : st.loading!} aria-label={qtrc('playback', 'Loading audio samples')} />
            {pct !== null && <span className="playback-loading-text">{`${pct}%`}</span>}
        </span>
    )
}

/** the playalong (not in MuseScore): its button; while on the measure buttons, the practice mode and the status */
function Playalong(): React.JSX.Element {
    useLanguage()
    const st = usePlayalongState()
    let status = ''
    if (st.status === 'loading') {
        status = webtr('Starting the note detection…')
    } else if (st.status === 'error') {
        status = st.error
    }
    return (
        <>
            <ActionButton code="playalong" />
            {st.active && st.mode === 'playalong' && (
                <>
                    <ActionButton code="playalong-prev" />
                    <span className="playalong-measure-number" role="status" aria-label={qtrc('playback', 'Measure', 'Measure number')}>
                        {st.number > 0 ? st.number : '–'}
                    </span>
                    <ActionButton code="playalong-next" />
                    <ActionButton code="playalong-practice" />
                </>
            )}
            {st.active && st.mode === 'noteinput' && st.status === 'listening' && (
                <span className="playalong-status" role="status">{webtr('Entering the notes you play')}</span>
            )}
            {status && <span className={`playalong-status${st.status === 'error' ? ' error' : ''}`} role="status">{status}</span>}
        </>
    )
}

export function PlaybackToolBar(): React.JSX.Element {
    useLanguage()
    return (
        <>
            <ActionButton code="rewind" />
            <PlayButton />
            <ActionButton code="loop" />
            <ActionButton code="metronome" />
            <MuteButton />
            <SettingsButton />
            <LoadingInfo />
            <span className="tool-separator" role="separator" aria-orientation="vertical" />
            <TimeField />
            <MeasureBeatFields />
            <TempoButton />
            <span className="tool-separator" role="separator" aria-orientation="vertical" />
            <Playalong />
        </>
    )
}
