/*
 * SPDX-License-Identifier: GPL-3.0-only
 * The toolbars (MuseScore's NotationToolBar, UndoRedoToolBar, NoteInputBar with its customisation popup, and the
 * web viewer's page view toolbar) in docks. A toolbar is moved by dragging its handle (or with the arrow keys
 * on the handle) within a dock or to another dock; dropped below the last row of the top area it gets a new row.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CENTER_ICON } from '../../shared/icons'
import {
    actionDefinition, actionDescription, actionTitle, isActionChecked, isActionEnabled, isCheckable, registerAction, shortcutText, triggerAction,
    useActions,
} from '../actions/actions'
import { MenuPopup } from '../components/Menu'
import { ViewModeControl } from '../components/ViewModeControl'
import { qtrc, stripMnemonic, trString, useLanguage, webtr } from '../i18n'
import { useSettings } from '../settings'
import type { MenuItem } from '../menus/appmenu'
import { ZOOM_LEVELS, setFitMode, useScoreView, zoomAt, type FitMode } from '../scoreview'
import { PlaybackToolBar } from './PlaybackToolBar'
import {
    BOTTOM_DOCK, DEFAULT_NOTE_INPUT_BAR, TOOLBARS, dockOf, moveToolBar, noteInputBarConfig, rowSequence, setNoteInputBarConfig,
    toolBarLayout, topRowCount, topRowId, useNoteInputBarConfig, useToolBarLayout, type DockId, type ToolConfigItem,
} from './layout'

const ICON = { grip: '', plus: '', cog: '', chevronDown: '', up: '', down: '', remove: '' }

// ---------------------------------------------------------------------------------
//   buttons
// ---------------------------------------------------------------------------------

/** icons MuseScore's icon font does not have */
const SVG_ICONS: Record<string, React.JSX.Element> = {
    'view-center-page': (
        <svg width="1em" height="1em" viewBox={CENTER_ICON.viewBox} style={{ display: 'block' }}>
            <path fill="currentColor" d={CENTER_ICON.path} />
        </svg>
    ),
}

function tooltip(code: string): string {
    const sc = shortcutText(code)
    return sc ? `${actionDescription(code)} (${sc})` : actionDescription(code)
}

/** a button for an action: its icon (or title), tooltip with shortcut, enabled and checked state */
export function ActionButton({ code, showTitle = false, bold = false, menu }: {
    code: string
    showTitle?: boolean
    bold?: boolean
    /** a menu that opens with the button (MuseScore: items with subitems) */
    menu?: MenuItem[]
}): React.JSX.Element {
    useActions()
    const def = actionDefinition(code)
    const enabled = isActionEnabled(code) || (!!menu && menu.length > 0)
    const checked = isActionChecked(code)
    const icon = SVG_ICONS[code] ?? (def?.icon ? String.fromCodePoint(def.icon) : '')
    const [open, setOpen] = useState(false)
    const ref = useRef<HTMLButtonElement>(null)
    return (
        <>
            <button ref={ref} data-action={code} className={`tool-button${showTitle || !icon ? ' with-title' : ''}${bold ? ' bold' : ''}`}
                title={tooltip(code)} aria-label={actionDescription(code)} disabled={!enabled}
                aria-pressed={def?.checkable || isCheckable(code) ? checked : undefined}
                aria-haspopup={menu ? 'menu' : undefined} aria-expanded={menu ? open : undefined}
                onClick={() => menu && !isActionEnabled(code) ? setOpen(!open) : triggerAction(code)}>
                {icon && <span className="tool-icon" aria-hidden="true">{icon}</span>}
                {(showTitle || !icon) && <span className="tool-title">{stripMnemonic(actionTitle(code))}</span>}
            </button>
            {menu && (
                <button className="tool-button menu-arrow-button" aria-label={`${actionDescription(code)}: ${qtrc('global', 'Menu')}`}
                    disabled={!menu.length} onClick={() => setOpen(!open)}>
                    <span className="tool-icon small" aria-hidden="true">{ICON.chevronDown}</span>
                </button>
            )}
            {menu && open && ref.current && (
                <MenuPopup items={menu} anchor={ref.current.getBoundingClientRect()} placement="below"
                    label={actionDescription(code)} onClose={(back) => { setOpen(false); if (back) { ref.current?.focus() } }} />
            )}
        </>
    )
}

function Separator(): React.JSX.Element {
    return <span className="tool-separator" role="separator" aria-orientation="vertical" />
}

// ---------------------------------------------------------------------------------
//   the toolbars
// ---------------------------------------------------------------------------------

function NotationToolBar(): React.JSX.Element {
    // NotationToolBarModel: "parts" and "toggle-mixer" (no mixer here)
    return <ActionButton code="parts" showTitle bold />
}

function UndoRedoToolBar(): React.JSX.Element {
    return (
        <>
            <ActionButton code="action://notation/undo" />
            <ActionButton code="action://notation/redo" />
        </>
    )
}

const NOTE_INPUT_METHODS = ['note-input-by-note-name', 'note-input-by-duration', 'note-input-rhythm', 'note-input-repitch',
    'note-input-realtime-auto', 'note-input-realtime-manual', 'note-input-timewise']

const SUBMENUS: Record<string, string[]> = {
    'cross-staff-beaming': ['move-up', 'move-down'],
    tuplet: ['duplet', 'triplet', 'quadruplet', 'quintuplet', 'sextuplet', 'septuplet', 'octuplet', 'nonuplet', 'tuplet-dialog'],
}

const actionItems = (codes: string[]): MenuItem[] => codes.map(code => code ? { kind: 'action', code } : { kind: 'separator' })

/** NoteInputBarModel::makeAddItems */
function addItems(): MenuItem[] {
    const notes = ['c', 'd', 'e', 'f', 'g', 'a', 'b']
    return [
        { kind: 'menu', id: '', title: ['notation', 'Notes'], items: actionItems([...notes.map(n => `note-${n}`), '', ...notes.map(n => `chord-${n}`)]) },
        { kind: 'menu', id: '', title: ['notation', 'Intervals'], items: actionItems([...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(i => `interval${i}`), '', ...[2, 3, 4, 5, 6, 7, 8, 9, 10].map(i => `interval-${i}`)]) },
        { kind: 'menu', id: '', title: ['notation', 'Measures'], items: actionItems(['insert-measure', 'append-measure', '', 'insert-measures', 'insert-measures-after-selection', '', 'insert-measures-at-start-of-score', 'append-measures']) },
        { kind: 'menu', id: '', title: ['notation', 'Frames'], items: actionItems(['insert-hbox', 'insert-vbox', 'insert-textframe', 'insert-fretframe', '', 'append-hbox', 'append-vbox', 'append-textframe', 'append-fretframe']) },
        { kind: 'menu', id: '', title: ['notation', 'Text'], items: actionItems(['title-text', 'subtitle-text', 'composer-text', 'poet-text', 'part-text', '', 'system-text', 'staff-text', 'add-dynamic', 'expression-text', 'rehearsalmark-text', 'instrument-change-text', 'fingering-text', '', 'sticking-text', 'chord-text', 'roman-numeral-text', 'nashville-number-text', 'lyrics', 'figured-bass', 'tempo']) },
        { kind: 'menu', id: '', title: ['notation', 'Lines'], items: actionItems(['add-slur', 'add-hairpin', 'add-hairpin-reverse', 'add-8va', 'add-8vb', 'add-noteline']) },
        { kind: 'menu', id: '', title: ['notation', 'Chords and fretboard diagrams'], items: actionItems(['chord-text', 'add-fretboard-diagram', '', 'insert-fretframe']) },
    ]
}

function NoteInputBar(): React.JSX.Element {
    useActions()
    const config = useNoteInputBarConfig()
    const defaultMethod = useSettings().noteInput.defaultMethod
    const [customize, setCustomize] = useState(false)
    const cogRef = useRef<HTMLButtonElement>(null)

    // NoteInputBarModel::load: hidden items are left out, "" starts a new section
    const shown = config.filter(i => i.show)
    const out: React.JSX.Element[] = []
    let methodsShown = false
    shown.forEach((i, k) => {
        if (!i.action) {
            if (out.length && k < shown.length - 1 && shown[k + 1]?.action) {
                out.push(<Separator key={`s${k}`} />)
            }
            return
        }
        // the note input methods are one button with a menu of the others (like MuseScore's note input button)
        if (NOTE_INPUT_METHODS.includes(i.action)) {
            if (!methodsShown) {
                methodsShown = true
                const methods = shown.filter(x => NOTE_INPUT_METHODS.includes(x.action)).map(x => x.action)
                // the button shows the method in use (in note input mode) and lists the shown methods in its menu
                // (outside of it the default input mode: the button starts it)
                const current = methods.find(code => isActionChecked(code)) ?? (methods.includes(defaultMethod) ? defaultMethod : methods[0])
                out.push(<ActionButton key={i.action} code={current} menu={methods.length > 1 ? actionItems(methods) : undefined} />)
            }
            return
        }
        out.push(<ActionButton key={i.action} code={i.action} menu={SUBMENUS[i.action] ? actionItems(SUBMENUS[i.action]) : undefined} />)
    })
    return (
        <>
            {out}
            <Separator />
            <ActionButtonAdd />
            <button ref={cogRef} className="tool-button" title={`${qtrc('notation', 'Customize toolbar')}: ${qtrc('notation', 'Show/hide toolbar buttons')}`}
                aria-label={qtrc('notation', 'Customize toolbar')} aria-haspopup="dialog" aria-expanded={customize} onClick={() => setCustomize(!customize)}>
                <span className="tool-icon" aria-hidden="true">{ICON.cog}</span>
            </button>
            {customize && cogRef.current && <CustomisePopup anchor={cogRef.current} onClose={() => setCustomize(false)} />}
        </>
    )
}

function ActionButtonAdd(): React.JSX.Element {
    const [open, setOpen] = useState(false)
    const ref = useRef<HTMLButtonElement>(null)
    return (
        <>
            <button ref={ref} className="tool-button with-title" aria-haspopup="menu" aria-expanded={open} title={qtrc('global', 'Add')}
                onClick={() => setOpen(!open)}>
                <span className="tool-icon" aria-hidden="true">{ICON.plus}</span>
                <span className="tool-title">{qtrc('global', 'Add')}</span>
                <span className="tool-icon small" aria-hidden="true">{ICON.chevronDown}</span>
            </button>
            {open && ref.current && (
                <MenuPopup items={addItems()} anchor={ref.current.getBoundingClientRect()} placement="below" label={qtrc('global', 'Add')}
                    onClose={(back) => { setOpen(false); if (back) { ref.current?.focus() } }} />
            )}
        </>
    )
}

/** NoteInputBarCustomisePopup: show/hide the items, move them, add and remove separators */
function CustomisePopup({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }): React.JSX.Element {
    useLanguage()
    const [items, setItems] = useState<ToolConfigItem[]>(() => [...noteInputBarConfig()])
    const [selected, setSelected] = useState(-1)
    const ref = useRef<HTMLDivElement>(null)
    const [pos, setPos] = useState({ left: 0, top: 0 })

    useLayoutEffect(() => {
        const a = anchor.getBoundingClientRect()
        const w = ref.current?.offsetWidth ?? 300
        setPos({ left: Math.max(8, Math.min(a.right - w, window.innerWidth - w - 8)), top: a.bottom + 4 })
    }, [anchor])

    useEffect(() => {
        ref.current?.focus()
        const onDown = (e: PointerEvent): void => {
            if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
                onClose()
            }
        }
        document.addEventListener('pointerdown', onDown, true)
        return () => document.removeEventListener('pointerdown', onDown, true)
    }, [anchor, onClose])

    const apply = (next: ToolConfigItem[]): void => {
        setItems(next)
        setNoteInputBarConfig(next)
    }
    const move = (dir: -1 | 1): void => {
        const j = selected + dir
        if (selected < 0 || j < 0 || j >= items.length) {
            return
        }
        const next = [...items]
        ;[next[selected], next[j]] = [next[j], next[selected]]
        apply(next)
        setSelected(j)
    }

    return (
        <div ref={ref} className="customise-popup" role="dialog" aria-label={qtrc('notation', 'Customize toolbar')} tabIndex={-1}
            style={{ left: pos.left, top: pos.top }}
            onKeyDown={e => {
                if (e.key === 'Escape') {
                    e.stopPropagation()
                    onClose()
                    anchor.focus()
                }
            }}>
            <div className="customise-header">
                <button className="secondary" disabled={selected < 0}
                    onClick={() => {
                        // NoteInputBarCustomiseModel::addSeparatorLine: below the selected item
                        const next = [...items]
                        next.splice(selected + 1, 0, { action: '', show: true })
                        apply(next)
                        setSelected(selected + 1)
                    }}>{qtrc('notation', 'Add separator line')}</button>
                <span className="spacer" />
                <button className="icon" title={qtrc('global', 'Move up')} aria-label={qtrc('global', 'Move up')} disabled={selected <= 0} onClick={() => move(-1)}>{ICON.up}</button>
                <button className="icon" title={qtrc('global', 'Move down')} aria-label={qtrc('global', 'Move down')} disabled={selected < 0 || selected >= items.length - 1} onClick={() => move(1)}>{ICON.down}</button>
                <button className="icon" title={qtrc('global', 'Delete')} aria-label={qtrc('global', 'Delete')} disabled={selected < 0 || !!items[selected]?.action}
                    onClick={() => {
                        apply(items.filter((_, i) => i !== selected))
                        setSelected(-1)
                    }}>{ICON.remove}</button>
            </div>
            <ul className="list customise-list" role="listbox" aria-label={qtrc('notation', 'Customize toolbar')}>
                {items.map((it, i) => (
                    <li key={i} role="option" aria-selected={i === selected} tabIndex={0} data-action={it.action || undefined} onClick={() => setSelected(i)}
                        onKeyDown={e => {
                            if (e.key === ' ' && it.action) {
                                e.preventDefault()
                                apply(items.map((x, k) => k === i ? { ...x, show: !x.show } : x))
                            }
                        }}>
                        {it.action ? (
                            <>
                                <input type="checkbox" checked={it.show} aria-label={stripMnemonic(actionTitle(it.action))}
                                    onChange={() => apply(items.map((x, k) => k === i ? { ...x, show: !x.show } : x))}
                                    onClick={e => e.stopPropagation()} />
                                <span className="tool-icon" aria-hidden="true">{actionDefinition(it.action)?.icon ? String.fromCodePoint(actionDefinition(it.action)!.icon!) : ''}</span>
                                <span className="item-name">{stripMnemonic(actionTitle(it.action))}</span>
                            </>
                        ) : (
                            <span className="item-name muted separator-item">{`-------  ${qtrc('notation', 'Separator line')}  -------`}</span>
                        )}
                    </li>
                ))}
            </ul>
            <div className="dialog-buttons">
                <button className="secondary" onClick={() => { apply([...DEFAULT_NOTE_INPUT_BAR]); setSelected(-1) }}>{qtrc('global', 'Reset')}</button>
            </div>
        </div>
    )
}

/** the toolbar of the web viewer: pages, page layout, zoom, printing, full screen */
function ViewToolBar(): React.JSX.Element {
    useLanguage()
    const v = useScoreView()
    // the fit modes of the view mode: the page view fits the page's width or the whole page; the continuous views fit
    // their one long page across (both modes zoom alike: one entry), "Fit to window" is always as wide as the window
    const fitOptions: [FitMode, string][] = v.viewMode === 'page'
        ? [['page-width', qtrc('notation', 'Page width')], ['whole-page', qtrc('notation', 'Whole page')]]
        : v.viewMode === 'continuous-horizontal' ? [['page-width', webtr('Fit to window height')]]
        : v.viewMode === 'continuous-vertical' ? [['page-width', webtr('Fit to window width')]]
        : []
    const level = ZOOM_LEVELS.find(l => Math.abs(l - v.zoom) < 0.5)
    const zoomValue = v.fitMode && fitOptions.length ? fitOptions.find(([m]) => m === v.fitMode)?.[0] ?? fitOptions[0][0]
        : level !== undefined ? String(level) : 'custom'
    return (
        <>
            <ActionButton code="page-prev" />
            <span className="page-info" aria-live="polite" aria-label={qtrc('notation', 'Page')}>{v.pageText}</span>
            <ActionButton code="page-next" />
            <Separator />
            <ActionButton code="view-pages-horizontal" />
            <ActionButton code="view-pages-vertical" />
            <ActionButton code="view-two-pages" />
            <ViewModeControl className="tool-button view-mode-button" />
            <Separator />
            <ActionButton code="zoomout" />
            <select className="zoom-select" title={qtrc('notation', 'Zoom')} aria-label={qtrc('notation', 'Zoom')} disabled={!v.hasScore} value={zoomValue}
                onChange={e => {
                    const val = e.target.value
                    if (val === 'page-width' || val === 'whole-page') {
                        setFitMode(val as FitMode)
                    } else if (val !== 'custom') {
                        zoomAt(Number(val))
                    }
                    document.getElementById('viewport')?.focus({ preventScroll: true })
                }}>
                {zoomValue === 'custom' && <option value="custom">{`${Math.round(v.zoom)}%`}</option>}
                {fitOptions.map(([m, title]) => <option key={m} value={m}>{title}</option>)}
                {ZOOM_LEVELS.map(l => <option key={l} value={String(l)}>{`${l}%`}</option>)}
            </select>
            <ActionButton code="zoomin" />
            <ActionButton code="view-center-page" />
            <Separator />
            <ActionButton code="print" />
            <ActionButton code="fullscreen" />
            <ActionButton code="view-shortcuts-help" showTitle />
        </>
    )
}

const CONTENT: Record<string, () => React.JSX.Element> = {
    notationToolBar: NotationToolBar,
    playbackToolBar: PlaybackToolBar,
    undoRedoToolBar: UndoRedoToolBar,
    noteInputBar: NoteInputBar,
    viewToolBar: ViewToolBar,
}

// ---------------------------------------------------------------------------------
//   docks and moving toolbars
// ---------------------------------------------------------------------------------

interface DragState { id: string; dock: DockId; index: number; x: number; y: number }

const dragListeners = new Set<(d: DragState | null) => void>()
let drag: DragState | null = null

function setDrag(d: DragState | null): void {
    drag = d
    for (const l of dragListeners) {
        l(d)
    }
}

function useDrag(): DragState | null {
    const [d, setD] = useState<DragState | null>(drag)
    useEffect(() => {
        dragListeners.add(setD)
        return () => { dragListeners.delete(setD) }
    }, [])
    return d
}

/** where a toolbar dropped at (x, y) goes: the dock under the point (or the nearest) and the index in it */
function dropTarget(id: string, x: number, y: number): { dock: DockId; index: number } {
    let best: { dock: DockId; dist: number; el: HTMLElement } | null = null
    for (const el of document.querySelectorAll<HTMLElement>('[data-dock]')) {
        const r = el.getBoundingClientRect()
        const dist = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0
        if (!best || dist < best.dist) {
            best = { dock: el.dataset.dock as DockId, dist, el }
        }
    }
    if (!best) {
        return { dock: dockOf(id), index: 0 }
    }
    const bars = [...best.el.querySelectorAll<HTMLElement>(':scope > .toolbar[data-toolbar]')].filter(b => b.dataset.toolbar !== id)
    const rtl = document.documentElement.dir === 'rtl'
    let index = bars.length
    for (let i = 0; i < bars.length; ++i) {
        const r = bars[i].getBoundingClientRect()
        const sameRow = y >= r.top && y <= r.bottom
        if ((sameRow && (rtl ? x > r.left + r.width / 2 : x < r.left + r.width / 2)) || y < r.top) {
            index = i
            break
        }
    }
    return { dock: best.dock, index }
}

function ToolBarFrame({ id }: { id: string }): React.JSX.Element {
    useLanguage()
    const info = TOOLBARS.find(t => t.id === id)!
    const Content = CONTENT[id]
    const title = stripMnemonic(trString(info.title))
    const [menu, setMenu] = useState<DOMRect | null>(null)

    const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>): void => {
        if (e.button !== 0) {
            return
        }
        const grip = e.currentTarget
        const startX = e.clientX
        const startY = e.clientY
        let moved = false
        grip.setPointerCapture(e.pointerId)
        const onMove = (ev: PointerEvent): void => {
            if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) {
                return
            }
            moved = true
            const t = dropTarget(id, ev.clientX, ev.clientY)
            setDrag({ id, ...t, x: ev.clientX, y: ev.clientY })
        }
        const onUp = (): void => {
            grip.removeEventListener('pointermove', onMove)
            grip.removeEventListener('pointerup', onUp)
            grip.removeEventListener('pointercancel', onUp)
            if (moved && drag) {
                moveToolBar(id, drag.dock, drag.index)
            }
            setDrag(null)
        }
        grip.addEventListener('pointermove', onMove)
        grip.addEventListener('pointerup', onUp)
        grip.addEventListener('pointercancel', onUp)
    }

    const menuItems: MenuItem[] = [
        { kind: 'action', code: `toolbar-move-left:${id}` },
        { kind: 'action', code: `toolbar-move-right:${id}` },
        { kind: 'action', code: `toolbar-move-up:${id}` },
        { kind: 'action', code: `toolbar-move-down:${id}` },
        dockOf(id) === BOTTOM_DOCK ? { kind: 'action', code: `toolbar-move-top:${id}` } : { kind: 'action', code: `toolbar-move-bottom:${id}` },
        ...(info.toggleAction ? [{ kind: 'separator' } as MenuItem, { kind: 'action', code: info.toggleAction } as MenuItem] : []),
    ]

    return (
        <div className={`toolbar${drag?.id === id ? ' dragging' : ''}`} data-toolbar={id} role="toolbar" aria-label={title}>
            <button className="toolbar-grip" title={`${title} – ${qtrc('appshell', 'Drag to move')}`}
                aria-label={`${title}: ${qtrc('appshell', 'Drag to move')}`}
                onPointerDown={onPointerDown}
                onContextMenu={e => { e.preventDefault(); setMenu(e.currentTarget.getBoundingClientRect()) }}
                onClick={e => setMenu(e.currentTarget.getBoundingClientRect())}
                onKeyDown={e => {
                    const rtl = document.documentElement.dir === 'rtl'
                    const handled = { ArrowLeft: () => moveToolBarBy(id, rtl ? 1 : -1), ArrowRight: () => moveToolBarBy(id, rtl ? -1 : 1), ArrowUp: () => moveToolBarDock(id, -1), ArrowDown: () => moveToolBarDock(id, 1) }[e.key]
                    if (handled && e.altKey) {
                        e.preventDefault()
                        handled()
                    }
                }}>
                <span aria-hidden="true">{ICON.grip}</span>
            </button>
            <Content />
            {menu && (
                <MenuPopup items={menuItems} anchor={menu} placement="below" label={title} onClose={() => setMenu(null)} />
            )}
        </div>
    )
}

/** moves a toolbar within its dock (dir -1: towards the start) */
function moveToolBarBy(id: string, dir: -1 | 1): void {
    const dock = dockOf(id)
    moveToolBar(id, dock, toolBarLayout().docks[dock].indexOf(id) + dir)
}

/** the row above: the end of it; the row below: the start of it, below the last row of the top area a new row */
function rowMoveTarget(id: string, dir: -1 | 1): { dock: DockId; index: number } | null {
    const layout = toolBarLayout()
    const dock = dockOf(id)
    const rows = rowSequence(layout)
    const i = rows.indexOf(dock)
    if (i < 0) {
        return null // the bottom dock: "Move to the top"
    }
    if (dir < 0) {
        return i > 0 ? { dock: rows[i - 1], index: layout.docks[rows[i - 1]].length } : null
    }
    if (i + 1 < rows.length) {
        return { dock: rows[i + 1], index: 0 }
    }
    // a new row below the last one (not for a toolbar that is alone in it)
    return layout.docks[dock].length > 1 ? { dock: topRowId(topRowCount(layout)), index: 0 } : null
}

/** moves a toolbar to the row above or below */
function moveToolBarDock(id: string, dir: -1 | 1): void {
    const t = rowMoveTarget(id, dir)
    if (t) {
        moveToolBar(id, t.dock, t.index)
    }
}

// the actions of the menu of a toolbar's handle
for (const { id } of TOOLBARS) {
    const pos = (): number => toolBarLayout().docks[dockOf(id)].indexOf(id)
    registerAction(`toolbar-move-left:${id}`, { run: () => moveToolBarBy(id, -1), enabled: () => pos() > 0 }, { title: [null, 'Move left'] })
    registerAction(`toolbar-move-right:${id}`, { run: () => moveToolBarBy(id, 1), enabled: () => pos() < toolBarLayout().docks[dockOf(id)].length - 1 },
        { title: [null, 'Move right'] })
    registerAction(`toolbar-move-up:${id}`, { run: () => moveToolBarDock(id, -1), enabled: () => rowMoveTarget(id, -1) !== null },
        { title: [null, 'Move to the row above'] })
    registerAction(`toolbar-move-down:${id}`, { run: () => moveToolBarDock(id, 1), enabled: () => rowMoveTarget(id, 1) !== null },
        { title: [null, 'Move to the row below'] })
    // the dock above the status bar and back (to the end of the last row of the top area)
    registerAction(`toolbar-move-bottom:${id}`, { run: () => moveToolBar(id, BOTTOM_DOCK, toolBarLayout().docks[BOTTOM_DOCK].length) },
        { title: [null, 'Move to the bottom'] })
    registerAction(`toolbar-move-top:${id}`, {
        run: () => {
            const n = topRowCount()
            const last = topRowId(Math.max(0, n - 1))
            moveToolBar(id, last, toolBarLayout().docks[last]?.length ?? 0)
        },
    }, { title: [null, 'Move to the top'] })
}

/** a dock: its toolbars in their order; while a toolbar is dragged, the place where it would go is marked */
export function ToolBarDock({ dock, className = '' }: { dock: DockId; className?: string }): React.JSX.Element | null {
    const layout = useToolBarLayout()
    const d = useDrag()
    const ids = (layout.docks[dock] ?? []).filter(id => !layout.hidden.includes(id))
    if (!ids.length && !d) {
        return null
    }
    const items: React.JSX.Element[] = []
    const others = ids.filter(id => id !== d?.id)
    let k = 0
    for (const id of ids) {
        if (d && d.dock === dock && id !== d.id && others.indexOf(id) === d.index) {
            items.push(<span key={`marker${k++}`} className="drop-marker" aria-hidden="true" />)
        }
        items.push(<ToolBarFrame key={id} id={id} />)
    }
    if (d && d.dock === dock && d.index >= others.length) {
        items.push(<span key="marker-end" className="drop-marker" aria-hidden="true" />)
    }
    return (
        <div className={`toolbar-dock dock-${dock}${d ? ' drag-active' : ''} ${className}`} data-dock={dock}>
            {items}
        </div>
    )
}

/** the rows of the top area; while a toolbar is dragged, an empty row below them takes it as a new row */
export function ToolBarRows(): React.JSX.Element {
    const layout = useToolBarLayout()
    const d = useDrag()
    const n = topRowCount(layout)
    const rows = Array.from({ length: n + (d ? 1 : 0) }, (_, i) => topRowId(i))
    return <>{rows.map(r => <ToolBarDock key={r} dock={r} className="dock-top" />)}</>
}

/** the hidden toolbars can be shown again (View > Toolbars; AppMenuModel::makeToolbarsItems: playback controls first) */
export function toolbarMenuItems(): MenuItem[] {
    const items: MenuItem[] = TOOLBARS.filter(t => t.toggleAction).map(t => ({ kind: 'action', code: t.toggleAction! }))
    return [...items, { kind: 'action', code: 'toggle-statusbar' }]
}

