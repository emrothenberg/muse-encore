/*
 * SPDX-License-Identifier: GPL-3.0-only
 * The "MIDI mappings" page of the Preferences (MuseScore's MidiDeviceMappingPage.qml with MidiMappingTopPanel,
 * ValueList and MidiMappingBottomPanel) and EditMidiMappingDialog.qml. Changes apply at once like the other pages here.
 */
import { useEffect, useRef, useState } from 'react'
import { isValidRemoteEvent, noRemoteEvent, remoteEventFromMidiEvent, RemoteEventType, type RemoteEvent } from '../../src/index'
import { actionDefinition, actionDescription, useActions } from '../actions/actions'
import { qtrc, useLanguage } from '../i18n'
import { mappableActions, setMidiMappings, startMappingEdit, useMidiState } from '../midi/midicontroller'
import { updateSettings, useSettings } from '../settings'

const NO_ICON = 0xFFFF
const SHARP_NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']

/** C++ RemoteEvent::name */
function remoteEventName(e: RemoteEvent): string {
    if (e.type === RemoteEventType.Note) {
        // muse::pitchToString
        const name = `${SHARP_NOTES[e.value % 12]}${Math.trunc(e.value / 12) - 1}`
        return qtrc('shortcuts', 'Note %1').replace('%1', qtrc('global/pitchName', name))
    }
    if (e.type === RemoteEventType.Controller) {
        return qtrc('shortcuts', 'CC %1').replace('%1', String(e.value))
    }
    return qtrc('shortcuts', 'None')
}

function ActionIcon({ code }: { code: string }): React.JSX.Element {
    const icon = actionDefinition(code)?.icon ?? NO_ICON
    return <span className="icon-glyph" aria-hidden="true">{icon !== NO_ICON ? String.fromCodePoint(icon) : ''}</span>
}

/** EditMidiMappingDialog.qml */
function EditMidiMappingDialog({ action, origin, onMap, onClose }: {
    action: string
    origin: RemoteEvent
    onMap: (event: RemoteEvent) => void
    onClose: () => void
}): React.JSX.Element {
    const ref = useRef<HTMLDialogElement>(null)
    const [event, setEvent] = useState(origin)
    const { devices, deviceId } = useMidiState()
    useEffect(() => {
        ref.current?.showModal()
        return startMappingEdit(e => setEvent(remoteEventFromMidiEvent(e)))
    }, [])
    const valid = isValidRemoteEvent(event)
    const deviceName = devices.find(d => d.id === deviceId)?.name ?? ''
    return (
        <dialog ref={ref} className="edit-midi-mapping" aria-labelledby="edit-midi-mapping-title"
            onClose={(e) => {
                // React lets the event bubble to the Preferences dialog, which would close too
                e.stopPropagation()
                onClose()
            }}>
            <header className="dialog-header">
                <h2 id="edit-midi-mapping-title">{qtrc('shortcuts', 'MIDI remote control')}</h2>
            </header>
            <p className="edit-midi-mapping-action"><ActionIcon code={action} /> <strong>{actionDescription(action)}</strong></p>
            <p>{qtrc('shortcuts', 'Press a key or adjust a control on your MIDI device to assign it to this action.')}</p>
            <label className="edit-midi-mapping-field">
                {qtrc('shortcuts', 'MIDI mapping:')}
                <input type="text" readOnly placeholder={qtrc('shortcuts', 'Waiting…')}
                    value={valid ? `${deviceName} > ${remoteEventName(event)}` : ''} />
            </label>
            <form method="dialog" className="dialog-buttons">
                <button value="cancel">{qtrc('global', 'Cancel')}</button>
                <button className="primary" value="add" disabled={!valid} onClick={() => onMap(event)}>{qtrc('global', 'Add')}</button>
            </form>
        </dialog>
    )
}

export function MidiMappingsPage(): React.JSX.Element {
    useLanguage()
    useActions()
    const { midi } = useSettings()
    const [current, setCurrent] = useState<string | null>(null)
    const [editing, setEditing] = useState<string | null>(null)
    const eventOf = (action: string): RemoteEvent => midi.mappings.find(m => m.action === action)?.event ?? noRemoteEvent()
    const setEvent = (action: string, event: RemoteEvent | null): void => {
        const others = midi.mappings.filter(m => m.action !== action)
        setMidiMappings(event ? [...others, { action, event }] : others)
    }
    const enabled = midi.useRemoteControl
    return (
        <section className="preferences-section midi-mappings">
            <label className="check midi-remote-control">
                <input type="checkbox" checked={enabled} onChange={e => updateSettings('midi', { useRemoteControl: e.target.checked })} />
                <strong>{qtrc('shortcuts', 'MIDI remote control')}</strong>
            </label>
            <table className="midi-mappings-list" aria-disabled={!enabled}>
                <thead>
                    <tr><th>{qtrc('shortcuts', 'action')}</th><th>{qtrc('shortcuts', 'status')}</th></tr>
                </thead>
                <tbody>
                    {mappableActions().map((action) => {
                        const event = eventOf(action)
                        const valid = isValidRemoteEvent(event)
                        return (
                            <tr key={action} data-action={action} tabIndex={enabled ? 0 : -1} aria-selected={current === action}
                                onClick={() => enabled && setCurrent(action)}
                                onDoubleClick={() => enabled && setEditing(action)}
                                onKeyDown={(e) => {
                                    if (enabled && e.key === 'Enter') {
                                        e.preventDefault()
                                        setCurrent(action)
                                        setEditing(action)
                                    }
                                }}>
                                <td><ActionIcon code={action} /> {actionDescription(action)}</td>
                                <td className={valid ? '' : 'muted'}>{valid ? remoteEventName(event) : qtrc('shortcuts', 'Inactive')}</td>
                            </tr>
                        )
                    })}
                </tbody>
            </table>
            <div className="midi-mappings-buttons">
                <button disabled={!enabled || !current} onClick={() => setEditing(current)}>{qtrc('shortcuts', 'Assign MIDI mapping…')}</button>
                <button disabled={!enabled} onClick={() => { if (current) { setEvent(current, null) } }}>{qtrc('global', 'Clear')}</button>
                <button disabled={!enabled} onClick={() => setMidiMappings([])}>{qtrc('global', 'Clear all')}</button>
            </div>
            {editing && (
                <EditMidiMappingDialog action={editing} origin={eventOf(editing)} onMap={e => setEvent(editing, e)} onClose={() => setEditing(null)} />
            )}
        </section>
    )
}
