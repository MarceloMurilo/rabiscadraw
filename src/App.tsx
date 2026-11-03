import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import rough from 'roughjs'
import type { El, ShapeType, Style, Tool, View } from './types'
import { bbox, boundsOf, canRotate, centerOf, handlesOf, hitTest, insideBox, lockPoint, notePoint, rotatePt } from './geometry'
import { bindHit, detachMoved, rebind } from './bind'
import type { Box } from './geometry'
import { boot, createDrawing, loadChat, loadScene, patchMeta, removeDrawing, saveChat, saveScene, setCurrent } from './storage'
import type { Meta } from './storage'
import { FONTS, drawElement, exportPNG, exportSVG, fontOf, loadFonts, isSceneType, measureText, onImageLoad, renderPNG, saveJSON, snapshotPNG, svgString, thumbnail, iconLayout } from './render'
import { ICONS, COLORS, iconById } from './catalog'
import { buildDiagramAuto } from './diagram-elk'
import { diffEls, findNode, isLink, isNode, linkEls, placeBeside, readGraph, reattach } from './graph'
import { normalizeSequence, normalizeSpec } from './spec'
import { buildSequence } from './sequence'
import { buildIndex, collectDrop, collectInput, dropHasFolder, summarize, usableOf } from './repo'
import { mapModules, modulesOf } from './repo-map'
import { describeTool, repoFilesOf, runTool, setRepoFiles } from './repo-tools'
import type { RepoItem, RepoSummary } from './repo'
import { RepoTree } from './RepoTree'
import type { DiagramSpec, SequenceSpec } from './spec'
import { connectBridge, loadToken, newToken } from './bridge'
import { askGraph, askServer, piecesOf } from './chat'
import type { ChatData, ChatMsg } from './chat'
import { ChatPanel } from './ChatPanel'
import type { Pick } from './ChatPanel'
import { FocusGlow } from './FocusGlow'
import { FlowDots, flowEnds, flowOf, isFlowEl } from './FlowDots'

const STROKES = ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00']
const FILLS = ['transparent', '#ffc9c9', '#b2f2bb', '#a5d8ff', '#ffec99']
const TOOLS: { id: Tool; key: string; label: string; icon: string }[] = [
  { id: 'select', key: 'V', label: 'Selecionar', icon: 'M5 3l14 8-6 2-2 6z' },
  { id: 'hand', key: 'H', label: 'Mover tela', icon: 'M8 12V6.5a1.5 1.5 0 013 0V11m0-5.5a1.5 1.5 0 013 0V11m0-3.5a1.5 1.5 0 013 0V15a6 6 0 01-6 6h-1a6 6 0 01-5-3l-3-5a1.5 1.5 0 012.5-1.5L8 14' },
  { id: 'rectangle', key: 'R', label: 'Retângulo', icon: 'M4 6h16v12H4z' },
  { id: 'diamond', key: 'D', label: 'Losango', icon: 'M12 3l9 9-9 9-9-9z' },
  { id: 'ellipse', key: 'O', label: 'Elipse', icon: 'M3 12a9 6 0 1018 0 9 6 0 10-18 0' },
  { id: 'arrow', key: 'A', label: 'Seta', icon: 'M5 19L19 5M10 5h9v9' },
  { id: 'line', key: 'L', label: 'Linha', icon: 'M5 19L19 5' },
  { id: 'pen', key: 'P', label: 'Lápis', icon: 'M4 20l4-1L19 8l-3-3L5 16z' },
  { id: 'text', key: 'T', label: 'Texto', icon: 'M6 5h12M12 5v14M9 19h6' },
  { id: 'laser', key: 'K', label: 'Laser (só aponta, não desenha)', icon: 'M12 9a3 3 0 100 6 3 3 0 000-6zM12 2v3M12 19v3M2 12h3M19 12h3' },
]
const KEY_TO_TOOL: Record<string, Tool> = {}
TOOLS.forEach((t, i) => { KEY_TO_TOOL[t.key.toLowerCase()] = t.id; KEY_TO_TOOL[String(i + 1)] = t.id })

const LASER_MS = 900

type Drag =
  | { kind: 'pan'; sx: number; sy: number; v: View }
  | { kind: 'create'; id: string; x: number; y: number; shape: ShapeType; pts: [number, number][]; snap: El[]; startId?: string }
  | { kind: 'move'; ids: string[]; x: number; y: number; snap: El[]; base?: El[]; orig?: string[]; moved?: boolean } // base / orig: Alt+drag, dragging copies
  | { kind: 'laser' }
  | { kind: 'marquee'; x: number; y: number; base: string[] }
  | { kind: 'resize'; id: string; handle: string; orig: El; snap: El[] }
  | { kind: 'rotate'; id: string; cx: number; cy: number; snap: El[] }

// the history of a drawing: snapshots of its elements, plus things done to the list of drawings
type DrawOp =
  | { op: 'rename'; id: string; name: string }
  | { op: 'delete'; id: string; back?: string }
  | { op: 'restore'; meta: Meta; scene: El[] }
type Hist = El[] | DrawOp

interface Editing { id?: string; x: number; y: number; value: string; fontSize: number; fontFamily: string; color: string; align?: 'left' | 'center' | 'right'; center?: { x: number; y: number } }

type MenuItem = 'sep' | { label: string; key?: string; run: () => void; disabled?: boolean; danger?: boolean }

// shapes that carry a caption of their own (edited with a double click)
const LABELED = ['rectangle', 'ellipse', 'diamond', 'icon']
const SHAPES_WITH_CAPTION = ['rectangle', 'ellipse', 'diamond']

const snap45 = (dx: number, dy: number): [number, number] => {
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
  const l = Math.hypot(dx, dy)
  return [l * Math.cos(a), l * Math.sin(a)]
}

function penEl(base: El, pts: [number, number][]): El {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const x = Math.min(...xs), y = Math.min(...ys)
  return { ...base, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, points: pts.map(([a, b]) => [a - x, b - y]) }
}

function resizeEl(o: El, handle: string, px: number, py: number, shift: boolean): El {
  if (handle === 'p0' || handle === 'p1') {
    let ex = px, ey = py
    const ox = handle === 'p0' ? o.x + o.w : o.x, oy = handle === 'p0' ? o.y + o.h : o.y
    if (shift) { const [dx, dy] = snap45(px - ox, py - oy); ex = ox + dx; ey = oy + dy }
    return handle === 'p0'
      ? { ...o, x: ex, y: ey, w: ox - ex, h: oy - ey }
      : { ...o, w: ex - o.x, h: ey - o.y }
  }
  const b = bbox(o)
  const fx = handle.includes('w') ? b.x + b.w : b.x
  const fy = handle.includes('n') ? b.y + b.h : b.y
  if (o.type === 'text') {
    const fs = Math.max(8, Math.round((o.fontSize ?? 20) * (Math.abs(py - fy) / Math.max(b.h, 1))))
    const m = measureText(o.text ?? '', fs, o.fontFamily)
    return { ...o, x: handle.includes('w') ? fx - m.w : fx, y: handle.includes('n') ? fy - m.h : fy, w: m.w, h: m.h, fontSize: fs }
  }
  let nw = Math.max(1, Math.abs(px - fx)), nh = Math.max(1, Math.abs(py - fy))
  if (shift && o.type !== 'freedraw' && o.type !== 'image' && o.type !== 'icon') nw = nh = Math.max(nw, nh)
  if (o.type === 'image' || o.type === 'icon') nh = (nw * b.h) / Math.max(b.w, 1)
  const nx = px < fx ? fx - nw : fx, ny = py < fy ? fy - nh : fy
  const out: El = { ...o, x: nx, y: ny, w: nw, h: nh }
  if (o.type === 'freedraw' || o.type === 'connector') {
    const sx = nw / Math.max(b.w, 1), sy = nh / Math.max(b.h, 1)
    out.points = o.points!.map(([a, c]) => [a * sx, c * sy])
  }
  return out
}

// copies with fresh ids; arrows keep their attachment only to elements copied along, and groups stay groups (as new groups)
function cloneEls(src: El[], dx: number, dy: number, reseed = false): El[] {
  const ids = new Map(src.map((e) => [e.id, crypto.randomUUID()]))
  const gids = new Map<string, string>()
  const gid = (g: string) => { if (!gids.has(g)) gids.set(g, crypto.randomUUID()); return gids.get(g) }
  return src.map((e) => ({
    ...e,
    id: ids.get(e.id)!,
    x: e.x + dx,
    y: e.y + dy,
    ...(reseed ? { seed: Math.floor(Math.random() * 2 ** 31) } : {}),
    groupId: e.groupId ? gid(e.groupId) : undefined,
    bindStart: e.bindStart ? ids.get(e.bindStart) : undefined,
    bindEnd: e.bindEnd ? ids.get(e.bindEnd) : undefined,
  }))
}

// resize a rotated element: work in its own (unrotated) frame, then move the new box so the opposite corner stays put
function resizeRotated(o: El, handle: string, px: number, py: number, shift: boolean): El {
  if (!o.angle || handle === 'p0' || handle === 'p1') return resizeEl(o, handle, px, py, shift)
  const c = centerOf(o)
  const q = rotatePt(px, py, c.x, c.y, -o.angle)
  const out = resizeEl(o, handle, q.x, q.y, shift)
  const lc = centerOf(out)
  const wc = rotatePt(lc.x, lc.y, c.x, c.y, o.angle)
  return { ...out, x: out.x + wc.x - lc.x, y: out.y + wc.y - lc.y }
}

const FONT_SIZES = [{ k: 'S', v: 16 }, { k: 'M', v: 20 }, { k: 'L', v: 28 }, { k: 'XL', v: 40 }]
const ROUGH = [
  { v: 0, label: 'Liso', d: 'M3 12h18' },
  { v: 0.6, label: 'Suave', d: 'M3 12q4.5-3 9 0t9 0' },
  { v: 1.5, label: 'Rabisco', d: 'M3 12q2-5 4.5 0t4.5 0 4.5 0 4.5 0' },
]
const WIDTHS = [{ v: 1, label: 'Fina' }, { v: 2, label: 'Média' }, { v: 4, label: 'Grossa' }]
const DRAW_TOOLS: Tool[] = ['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'pen', 'text']

const H_ICON = {'left': 'M4 6h16M4 12h10M4 18h14', 'center': 'M4 6h16M7 12h10M5 18h14', 'right': 'M4 6h16M10 12h10M6 18h14'}
const V_ICON = {'top': 'M5 5h14M9 9v10M15 9v6', 'middle': 'M5 12h14M9 7v10M15 9v6', 'bottom': 'M5 19h14M9 5v10M15 9v6'}

// a floating panel the user can move: drag the grip at its top; the offset is kept inside the stage (and remembered when a key is given)
function useDragOffset(storageKey?: string) {
  const [off, setOff] = useState<{ x: number; y: number }>(() => {
    try {
      const v = storageKey ? localStorage.getItem(storageKey) : null
      if (v) { const o = JSON.parse(v); if (typeof o?.x === 'number' && typeof o?.y === 'number') return o }
    } catch { /* storage blocked */ }
    return { x: 0, y: 0 }
  })
  const offRef = useRef(off); offRef.current = off
  const ref = useRef<HTMLDivElement>(null)
  const start = useRef<{ px: number; py: number; ox: number; oy: number; bl: number; bt: number; sw: number; sh: number } | null>(null)
  const handle = {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      const el = ref.current, stage = el?.parentElement
      if (!el || !stage) return
      e.preventDefault()
      e.stopPropagation()
      e.currentTarget.setPointerCapture(e.pointerId)
      const r = el.getBoundingClientRect(), sr = stage.getBoundingClientRect()
      const o = offRef.current
      start.current = { px: e.clientX, py: e.clientY, ox: o.x, oy: o.y, bl: r.left - sr.left - o.x, bt: r.top - sr.top - o.y, sw: sr.width, sh: sr.height }
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      const s = start.current
      if (!s) return
      const x = Math.min(Math.max(s.ox + e.clientX - s.px, -s.bl), s.sw - s.bl - 80)
      const y = Math.min(Math.max(s.oy + e.clientY - s.py, -s.bt), s.sh - s.bt - 40)
      setOff({ x, y })
    },
    onPointerUp: () => {
      if (!start.current) return
      start.current = null
      if (storageKey) { try { localStorage.setItem(storageKey, JSON.stringify(offRef.current)) } catch { /* storage blocked */ } }
    },
  }
  return { off, ref, handle }
}

// the card with the explanation of the selected element, movable
function NoteCard({ el, style, onClose }: { el: El; style: React.CSSProperties; onClose: () => void }) {
  const drag = useDragOffset()
  return (
    <div className="panel note-card" ref={drag.ref} style={{ ...style, transform: `translate(${drag.off.x}px, ${drag.off.y}px)` }}>
      <div className="grip" title="Arraste para mover" {...drag.handle} />
      <button className="note-x" title="Fechar" onClick={onClose}>✕</button>
      <div className="note-body">
        <h5>{(el.text ?? '').split('\n').join(' ') || 'Elemento'}</h5>
        <p>{el.description}</p>
      </div>
    </div>
  )
}

// Open Color: 14 hues x 10 shades, light to dark (the quick swatches above are picked from it)
const PALETTE: string[][] = [
  ['#f8f9fa', '#f1f3f5', '#e9ecef', '#dee2e6', '#ced4da', '#adb5bd', '#868e96', '#495057', '#343a40', '#212529'],
  ['#fff5f5', '#ffe3e3', '#ffc9c9', '#ffa8a8', '#ff8787', '#ff6b6b', '#fa5252', '#f03e3e', '#e03131', '#c92a2a'],
  ['#fff0f6', '#ffdeeb', '#fcc2d7', '#faa2c1', '#f783ac', '#f06595', '#e64980', '#d6336c', '#c2255c', '#a61e4d'],
  ['#f8f0fc', '#f3d9fa', '#eebefa', '#e599f7', '#da77f2', '#cc5de8', '#be4bdb', '#ae3ec9', '#9c36b5', '#862e9c'],
  ['#f3f0ff', '#e5dbff', '#d0bfff', '#b197fc', '#9775fa', '#845ef7', '#7950f2', '#7048e8', '#6741d9', '#5f3dc4'],
  ['#edf2ff', '#dbe4ff', '#bac8ff', '#91a7ff', '#748ffc', '#5c7cfa', '#4c6ef5', '#4263eb', '#3b5bdb', '#364fc7'],
  ['#e7f5ff', '#d0ebff', '#a5d8ff', '#74c0fc', '#4dabf7', '#339af0', '#228be6', '#1c7ed6', '#1971c2', '#1864ab'],
  ['#e3fafc', '#c5f6fa', '#99e9f2', '#66d9e8', '#3bc9db', '#22b8cf', '#15aabf', '#1098ad', '#0c8599', '#0b7285'],
  ['#e6fcf5', '#c3fae8', '#96f2d7', '#63e6be', '#38d9a9', '#20c997', '#12b886', '#0ca678', '#099268', '#087f5b'],
  ['#ebfbee', '#d3f9d8', '#b2f2bb', '#8ce99a', '#69db7c', '#51cf66', '#40c057', '#37b24d', '#2f9e44', '#2b8a3e'],
  ['#f4fce3', '#e9fac8', '#d8f5a2', '#c0eb75', '#a9e34b', '#94d82d', '#82c91e', '#74b816', '#66a80f', '#5c940d'],
  ['#fff9db', '#fff3bf', '#ffec99', '#ffe066', '#ffd43b', '#fcc419', '#fab005', '#f59f00', '#f08c00', '#e67700'],
  ['#fff4e6', '#ffe8cc', '#ffd8a8', '#ffc078', '#ffa94d', '#ff922b', '#fd7e14', '#f76707', '#e8590c', '#d9480f'],
]

// a colour row: quick swatches, a button that unfolds the whole palette, and a free colour picker
function ColorField({ value, presets, onPick }: { value: string; presets: string[]; onPick: (c: string) => void }) {
  const [open, setOpen] = useState(false)
  const swatch = (c: string, cls: string) => (
    <button key={c} title={c === 'transparent' ? 'Sem cor' : c} className={cls + (c === 'transparent' ? ' none' : '') + (value === c ? ' on' : '')} style={c === 'transparent' ? undefined : { background: c }} onClick={() => onPick(c)} />
  )
  const custom = !presets.includes(value) && !PALETTE.some((r) => r.includes(value)) && value !== 'transparent'
  return (
    <>
      <div className="row">
        {presets.map((c) => swatch(c, 'sw'))}
        <button className={'sw more' + (open ? ' on' : '')} title="Todas as cores" onClick={() => setOpen((o) => !o)}>
          <svg viewBox="0 0 24 24"><path d="M6 6h.01M12 6h.01M18 6h.01M6 12h.01M12 12h.01M18 12h.01M6 18h.01M12 18h.01M18 18h.01" strokeWidth="3.5" /></svg>
        </button>
        <label className={'sw custom' + (custom ? ' on' : '')} title="Escolher outra cor" style={custom ? { background: value } : undefined}>
          <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff'} onChange={(e) => onPick(e.target.value)} />
        </label>
      </div>
      {open && (
        <div className="palette-grid">
          {presets.includes('transparent') && (
            <div className="hue-row">{swatch('transparent', 'pg')}</div>
          )}
          {PALETTE.map((hue, i) => (
            <div className="hue-row" key={i}>{hue.map((c) => swatch(c, 'pg'))}</div>
          ))}
        </div>
      )}
    </>
  )
}

// the text of the selected element, edited in the panel: shows on the canvas while typing, one undo step when done
function TextField({ value, onLive, onDone }: { value: string; onLive: (v: string) => void; onDone: () => void }) {
  const doneRef = useRef(onDone); doneRef.current = onDone
  useEffect(() => () => doneRef.current(), []) // the canvas keeps the focus where it is, so a new selection must end the edit
  return <textarea className="note-field" rows={3} value={value} placeholder="Texto do elemento" onChange={(e) => onLive(e.target.value)} onBlur={onDone} />
}

// explanation of an element; saved when the field loses focus or when another element gets selected (the canvas keeps the focus where it is)
function NoteField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value)
  const vRef = useRef(v); vRef.current = v
  const savedRef = useRef(value)
  const onSaveRef = useRef(onSave); onSaveRef.current = onSave
  const flushNote = () => { if (vRef.current !== savedRef.current) { savedRef.current = vRef.current; onSaveRef.current(vRef.current) } }
  useEffect(() => flushNote, [])
  return <textarea className="note-field" rows={4} value={v} placeholder="O que isso faz na arquitetura? (opcional)" onChange={(e) => setV(e.target.value)} onBlur={flushNote} />
}

function Sec({ t, children }: { t: string; children: React.ReactNode }) {
  return <div className="sec"><h4>{t}</h4>{children}</div>
}

export default function App() {
  const [els, setEls] = useState<El[]>([])
  const [tool, setTool] = useState<Tool>('select')
  const [sel, setSel] = useState<string[]>([])
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 })
  const [style, setStyle] = useState<Style>({ stroke: STROKES[0], fill: 'transparent', strokeWidth: 2, roughness: 0.6, fillStyle: 'hachure', opacity: 100, rounded: false })
  const [editing, setEditing] = useState<Editing | null>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [tick, setTick] = useState(0)
  const [metas, setMetas] = useState<Meta[]>([])
  const [currentId, setCurrentId] = useState('')
  const [sidebar, setSidebar] = useState(() => { try { return localStorage.getItem('rabiscadraw:sidebar') !== '0' } catch { return true } })
  const [renaming, setRenaming] = useState<string | null>(null)
  const [font, setFont] = useState('excali')
  const [fontSize, setFontSize] = useState(20)
  const [spaceHeld, setSpaceHeld] = useState(false) // Space down: open hand, drag to pan
  const [grabbing, setGrabbing] = useState(false) // panning right now: closed hand
  const [bindHint, setBindHint] = useState<string | null>(null) // element an arrow end would attach to
  const propsDrag = useDragOffset('rabiscadraw:props-offset')
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null) // right-click menu, in stage pixels
  const [fileMenu, setFileMenu] = useState(false) // the menu behind the hamburger button
  const [dark, setDark] = useState(() => { try { return localStorage.getItem('rabiscadraw:theme') === 'dark' } catch { return false } })
  const [openNote, setOpenNote] = useState<string | null>(null) // element whose explanation card is open
  const [onMarker, setOnMarker] = useState<string | null>(null) // element whose "i" button the pointer is over
  const [onLock, setOnLock] = useState<string | null>(null) // locked element whose padlock the pointer is over
  const [menuLocked, setMenuLocked] = useState<string | null>(null) // locked element under the right click
  const styleClip = useRef<Partial<El> | null>(null)
  const act = useRef<Record<string, any>>({}) // current versions of the actions, for the long-lived key and clipboard listeners
  const [hover, setHover] = useState<string | null>(null)
  const [marquee, setMarquee] = useState<Box | null>(null)
  const [iconKind, setIconKind] = useState('database')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [repo, setRepo] = useState<{ name: string; all: RepoItem[]; skipped: number; sel: Set<string>; forced: Set<string>; sum: RepoSummary; views: 'both' | 'architecture' | 'sequence'; busy: boolean; msg: string; deep: boolean; prog: string } | null>(null) // a dropped repository waiting for the person's OK
  const repoRef = useRef(repo)
  repoRef.current = repo
  const [dropping, setDropping] = useState(false) // a folder is being dragged over the page
  const repoInput = useRef<HTMLInputElement>(null)
  const [aiMsg, setAiMsg] = useState('')
  const chats = useRef(new Map<string, ChatData>()) // the guide of each drawing that came from a repository
  const [, setChatTick] = useState(0)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatBusy, setChatBusy] = useState<string[]>([]) // drawings with a question in flight
  const [chatStatus, setChatStatus] = useState<Record<string, string>>({}) // what the guide is looking at right now, per drawing
  const [focusIds, setFocusIds] = useState<string[]>([]) // pieces being pointed at, by nid
  const focusTimer = useRef(0)
  const lastDrawn = useRef<El[]>([])
  const [mcpToken, setMcpToken] = useState(loadToken)
  const [copied, setCopied] = useState('')
  const [aiTarget, setAiTarget] = useState<'current' | 'new'>('current')
  const [aiInfo, setAiInfo] = useState<{ configured: boolean; model: string | null; dev: boolean } | null>(null)

  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const drag = useRef<Drag | null>(null)
  const past = useRef<Hist[]>([])
  const future = useRef<Hist[]>([])
  const space = useRef(false)
  const laserCanvas = useRef<HTMLCanvasElement>(null)
  const laserPts = useRef<{ x: number; y: number; t: number }[][]>([])
  const laserRaf = useRef(0)

  // laser trail lives on its own overlay canvas and fades out; it is never stored
  const laserFrame = () => {
    const c = laserCanvas.current
    if (!c) { laserRaf.current = 0; return }
    const dpr = window.devicePixelRatio || 1
    const ctx = c.getContext('2d')!
    const now = performance.now()
    // each press starts its own stroke, so separate strokes are never joined by a line
    laserPts.current = laserPts.current
      .map((s) => s.filter((p) => now - p.t < LASER_MS))
      .filter((s) => s.length)
    const strokes = laserPts.current
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, c.width, c.height)
    ctx.lineCap = ctx.lineJoin = 'round'
    const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
    // plain red line that fades out
    ctx.strokeStyle = ctx.fillStyle = '#ff2d2d'
    ctx.lineWidth = 4
    for (const pts of strokes) {
      const n = pts.length
      if (n === 1) {
        ctx.globalAlpha = Math.max(0, 1 - (now - pts[0].t) / LASER_MS)
        ctx.beginPath()
        ctx.arc(pts[0].x, pts[0].y, 2, 0, Math.PI * 2)
        ctx.fill()
        continue
      }
      for (let i = 1; i < n; i++) {
        const a = i === 1 ? pts[0] : mid(pts[i - 1], pts[i])
        const b = i === n - 1 ? pts[i] : mid(pts[i], pts[i + 1])
        ctx.globalAlpha = Math.max(0, 1 - (now - pts[i].t) / LASER_MS)
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, b.x, b.y)
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1
    laserRaf.current = strokes.length ? requestAnimationFrame(laserFrame) : 0
  }
  const pushLaser = (x: number, y: number, newStroke = false) => {
    const strokes = laserPts.current
    const pt = { x, y, t: performance.now() }
    if (newStroke || !strokes.length) strokes.push([pt])
    else strokes[strokes.length - 1].push(pt)
    if (!laserRaf.current) laserRaf.current = requestAnimationFrame(laserFrame)
  }

  const elsRef = useRef(els); elsRef.current = els
  const viewRef = useRef(view); viewRef.current = view
  const styleRef = useRef(style); styleRef.current = style
  const fontRef = useRef(font); fontRef.current = font
  const fontSizeRef = useRef(fontSize); fontSizeRef.current = fontSize
  const iconKindRef = useRef(iconKind); iconKindRef.current = iconKind
  const sidebarRef = useRef(sidebar); sidebarRef.current = sidebar
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    try { localStorage.setItem('rabiscadraw:theme', dark ? 'dark' : 'light') } catch { /* storage blocked */ }
  }, [dark])
  useEffect(() => { try { localStorage.setItem('rabiscadraw:sidebar', sidebar ? '1' : '0') } catch { /* storage blocked */ } }, [sidebar])
  const toolRef = useRef(tool); toolRef.current = tool
  const selRef = useRef(sel); selRef.current = sel
  const editRef = useRef(editing); editRef.current = editing
  const currentRef = useRef(currentId); currentRef.current = currentId

  const opRef = useRef<(op: DrawOp, dir: 'undo' | 'redo') => void>(() => {})
  const coalesce = useRef<{ key: string; t: number } | null>(null)

  // every change of the drawing goes through here and becomes one undo step; changes with the same key in quick succession
  // (dragging a slider, typing an angle) share one step
  const commit = useCallback((next: El[], key?: string) => {
    const now = Date.now()
    const merge = !!key && coalesce.current?.key === key && now - coalesce.current.t < 800
    coalesce.current = key ? { key, t: now } : null
    if (!merge) {
      past.current.push(elsRef.current)
      if (past.current.length > 200) past.current.shift()
    }
    future.current = []
    setEls(rebind(next))
  }, [])

  const undo = useCallback(() => {
    coalesce.current = null
    const prev = past.current.pop()
    if (!prev) return
    if (!Array.isArray(prev)) { opRef.current(prev, 'undo'); return }
    future.current.push(elsRef.current)
    setEls(prev)
    setSel((cur) => cur.filter((id) => prev.some((e) => e.id === id)))
  }, [])

  const redo = useCallback(() => {
    coalesce.current = null
    const next = future.current.pop()
    if (!next) return
    if (!Array.isArray(next)) { opRef.current(next, 'redo'); return }
    past.current.push(elsRef.current)
    setEls(next)
    setSel((cur) => cur.filter((id) => next.some((e) => e.id === id)))
  }, [])

  const select = (el: El | null) => {
    setSel(el ? [el.id] : [])
    if (el) setStyle({ stroke: el.stroke, fill: el.fill, strokeWidth: el.strokeWidth, roughness: el.roughness, fillStyle: el.fillStyle ?? 'hachure', opacity: el.opacity ?? 100, rounded: !!el.rounded })
    if (el?.type === 'text') setFont(el.fontFamily ?? 'excali')
    if (el?.fontSize) setFontSize(el.fontSize)
  }

  // persistence (IndexedDB): several drawings, one scene record each
  const loaded = useRef(false)
  const lastSaved = useRef<El[] | null>(null)
  const histories = useRef(new Map<string, { past: Hist[]; future: Hist[]; view: View }>())

  const remeasure = (list: El[]) =>
    list.map((e) => (e.type === 'text' ? { ...e, ...measureText(e.text ?? '', e.fontSize ?? 20, e.fontFamily) } : e))

  useEffect(() => {
    // wait for the fonts so stored text is measured with the real glyph widths
    Promise.all([boot(), loadFonts()]).then(([b]) => {
      const scene = remeasure(b.els)
      lastSaved.current = scene
      setEls(scene)
      setMetas(b.metas)
      setCurrentId(b.currentId)
      currentRef.current = b.currentId
      loaded.current = true
      setTick((t) => t + 1)
    })
  }, [])

  const flush = async () => {
    const list = elsRef.current
    if (!loaded.current || list === lastSaved.current) return
    lastSaved.current = list
    try {
      const m = await saveScene(currentRef.current, list, thumbnail(list))
      if (m) setMetas((ms) => ms.map((x) => (x.id === m.id ? m : x)))
    } catch { /* storage blocked */ }
  }
  const flushRef = useRef(flush); flushRef.current = flush

  useEffect(() => {
    if (!loaded.current || els === lastSaved.current) return
    const t = setTimeout(() => { flushRef.current() }, 400)
    return () => clearTimeout(t)
  }, [els])

  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flushRef.current() }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [])

  const switchTo = async (id: string) => {
    if (id === currentRef.current) return
    if (editRef.current) { commitText(); await new Promise((r) => setTimeout(r, 0)) }
    await flush()
    histories.current.set(currentRef.current, { past: past.current, future: future.current, view: viewRef.current })
    const scene = remeasure(await loadScene(id))
    const h = histories.current.get(id)
    past.current = h?.past ?? []
    future.current = h?.future ?? []
    lastSaved.current = scene
    currentRef.current = id
    setEls(scene)
    setSel([])
    setView(h?.view ?? { x: 0, y: 0, zoom: 1 })
    setCurrentId(id)
    setCurrent(id).catch(() => { /* ignore */ })
  }

  const freeName = (base: string) => {
    const used = new Set(metas.map((m) => m.name))
    if (!used.has(base)) return base
    for (let n = 2; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`
  }

  const newDrawing = async (list: El[] = [], name?: string) => {
    await flush()
    const back = currentRef.current
    const m = await createDrawing(freeName(name ?? `Desenho ${metas.length + 1}`), list, thumbnail(list))
    setMetas((ms) => [m, ...ms])
    await switchTo(m.id)
    past.current.push({ op: 'delete', id: m.id, back }) // Ctrl+Z on a fresh drawing removes it again
  }

  const duplicateDrawing = async (id: string) => {
    const src = metas.find((m) => m.id === id)
    if (!src) return
    await flush()
    const copy = await loadScene(id)
    const m = await createDrawing(freeName(`${src.name} (cópia)`), copy, thumbnail(copy))
    const guide = chats.current.get(id) ?? (await loadChat<ChatData>(id).catch(() => undefined))
    if (guide) putChat(m.id, guide)
    setMetas((ms) => [m, ...ms])
    await switchTo(m.id)
    past.current.push({ op: 'delete', id: m.id, back: id })
  }

  const renameDrawing = async (id: string, raw: string) => {
    setRenaming(null)
    const name = raw.trim()
    const cur = metas.find((m) => m.id === id)
    if (!cur || !name || name === cur.name) return
    past.current.push({ op: 'rename', id, name: cur.name })
    future.current = []
    setMetas((ms) => ms.map((m) => (m.id === id ? { ...m, name } : m)))
    patchMeta(id, { name }).catch(() => { /* ignore */ })
  }

  // delete a drawing and land on another one (the one given, else the most recent; a fresh one if none is left)
  const removeAndSwitch = async (id: string, back?: string) => {
    const rest = metas.filter((x) => x.id !== id)
    const isCurrent = id === currentRef.current
    if (isCurrent) lastSaved.current = elsRef.current // do not write the doomed drawing back
    await removeDrawing(id)
    histories.current.delete(id)
    if (!isCurrent) { setMetas(rest); return }
    const next = rest.find((m) => m.id === back) ?? (rest.length ? [...rest].sort((x, y) => y.updatedAt - x.updatedAt)[0] : await createDrawing('Desenho 1'))
    setMetas(rest.length ? rest : [next])
    await switchTo(next.id)
    histories.current.delete(id)
  }

  const deleteDrawing = async (id: string) => {
    const m = metas.find((x) => x.id === id)
    if (!m || !confirm(`Apagar "${m.name}"? Ctrl+Z traz de volta.`)) return
    const scene = id === currentRef.current ? elsRef.current : await loadScene(id)
    await removeAndSwitch(id)
    past.current.push({ op: 'restore', meta: m, scene })
  }

  // undo / redo of what was done to the list of drawings (create, rename, delete); each step hands back its own inverse
  const applyOp = async (op: DrawOp, dir: 'undo' | 'redo') => {
    let inverse: DrawOp
    if (op.op === 'rename') {
      const cur = metas.find((m) => m.id === op.id)
      if (!cur) return
      setMetas((ms) => ms.map((m) => (m.id === op.id ? { ...m, name: op.name } : m)))
      patchMeta(op.id, { name: op.name }).catch(() => { /* ignore */ })
      inverse = { op: 'rename', id: op.id, name: cur.name }
    } else if (op.op === 'delete') {
      const m = metas.find((x) => x.id === op.id)
      if (!m) return
      const scene = op.id === currentRef.current ? elsRef.current : await loadScene(op.id)
      await removeAndSwitch(op.id, op.back)
      inverse = { op: 'restore', meta: m, scene }
    } else {
      await flush()
      const back = currentRef.current
      const m = await createDrawing(op.meta.name, op.scene, thumbnail(op.scene))
      setMetas((ms) => [m, ...ms])
      await switchTo(m.id)
      inverse = { op: 'delete', id: m.id, back }
    }
    ;(dir === 'undo' ? future : past).current.push(inverse)
  }

  const currentName = metas.find((m) => m.id === currentId)?.name ?? ''
  const sortedMetas = [...metas].sort((a, b) => b.updatedAt - a.updatedAt)

  // ---------- diagrams: from the AI panel and from MCP agents
  const fitTo = (list: El[]) => {
    const b = boundsOf(list)
    const n = stageRef.current
    if (!b || !n) return
    // keep clear of the side bar and of the style panel
    const left = (sidebarRef.current ? 262 : 12) + 200
    const availW = n.clientWidth - left - 24, availH = n.clientHeight - 150
    const z = Math.max(0.1, Math.min(1, availW / Math.max(b.w, 1), availH / Math.max(b.h, 1)))
    setView({ zoom: z, x: left + (availW - b.w * z) / 2 - b.x * z, y: 110 + (availH - b.h * z) / 2 - b.y * z })
  }

  const applyDiagram = async (raw: DiagramSpec, target: 'current' | 'new' = 'current', name?: string) => {
    const cur = target === 'new' ? [] : elsRef.current
    // nodes of this call are always new; edges may also name nodes that are already on the board
    const fresh = new Set((raw.nodes ?? []).map((n) => String(n.id)))
    for (const n of raw.nodes ?? []) {
      if (cur.some((e) => isNode(e) && e.nid === String(n.id))) {
        throw new Error(`O id "${n.id}" já existe no quadro. Use outro id para o nó novo; para ligar a um nó que já existe, não o declare em nodes: cite o id dele só nas edges.`)
      }
    }
    const known = (id: string) => fresh.has(id) || !!findNode(cur, id)
    const unknown = [...new Set((raw.edges ?? []).flatMap((e) => [e.from, e.to]).filter((id) => !known(id)))]
    if (unknown.length) throw new Error(`Nós não encontrados nas edges: ${unknown.join(', ')}. Veja os ids com get_scene.`)
    const inside = (raw.edges ?? []).filter((e) => fresh.has(e.from) && fresh.has(e.to))
    const toOld = (raw.edges ?? []).filter((e) => !(fresh.has(e.from) && fresh.has(e.to)))
    const spec = normalizeSpec({ ...raw, edges: inside })
    if (!spec.nodes.length) throw new Error('O diagrama veio sem nenhum item.')

    const first = target === 'new' ? null : boundsOf(cur)
    const r = await buildDiagramAuto(spec, first ? { x: first.x, y: first.y + first.h + 100 } : { x: 80, y: 80 })
    let added = r.els
    let where = first ? 'abaixo do que já existia' : undefined
    if (target === 'new') {
      await newDrawing(added, name ?? spec.title)
    } else {
      // a block wired to existing nodes goes beside them, not under everything
      const anchors = toOld.flatMap((e) => [e.from, e.to]).filter((id) => !fresh.has(id)).map((id) => findNode(cur, id)!)
      const bb = boundsOf(added)
      const pos = anchors.length && bb ? placeBeside(cur, anchors, bb, spec.direction === 'LR') : null
      if (pos) {
        added = added.map((e) => ({ ...e, x: e.x + pos.dx, y: e.y + pos.dy }))
        where = `à ${pos.side} dos nós ligados`
      }
      const all = [...cur, ...added]
      const byNew = (id: string) => all.find((e) => e.id === r.nodeIds[id])
      const links = toOld.map((e) => ({ from: (byNew(e.from) ?? findNode(cur, e.from))!, to: (byNew(e.to) ?? findNode(cur, e.to))!, label: e.label, kind: e.kind }))
      added = [...added, ...linkEls(all, links)]
      commit([...cur, ...added])
      setSel(added.map((e) => e.id))
    }
    fitTo(added)
    lastDrawn.current = added
    return { elements: added.length, nodes: r.nodeIds, ...(where ? { placed: where } : {}), ...(toOld.length ? { connected_to_existing: toOld.length } : {}) }
  }

  const applySequence = async (raw: SequenceSpec, target: 'current' | 'new' = 'current', name?: string) => {
    const spec = normalizeSequence(raw)
    if (spec.participants.length < 2 || !spec.steps.length) throw new Error('O diagrama de sequência veio sem participantes ou sem passos.')
    const cur = target === 'new' ? [] : elsRef.current
    const first = boundsOf(cur)
    const r = buildSequence(spec, first ? { x: first.x, y: first.y + first.h + 100 } : { x: 80, y: 80 })
    if (target === 'new') await newDrawing(r.els, name ?? spec.title ?? undefined)
    else { commit([...cur, ...r.els]); setSel(r.els.map((e) => e.id)) }
    fitTo(r.els)
    lastDrawn.current = r.els
    return { elements: r.els.length, participants: r.nodeIds }
  }

  // every settled change of the drawing is a numbered version, so an agent can ask what changed since the one it saw
  const versions = useRef({ v: 0, last: null as El[] | null, drawing: '', snaps: [] as { v: number; drawing: string; els: El[] }[] })
  const recordVersion = () => {
    const h = versions.current
    if (!loaded.current || (h.last === elsRef.current && h.drawing === currentRef.current)) return
    h.v++
    h.last = elsRef.current
    h.drawing = currentRef.current
    h.snaps.push({ v: h.v, drawing: h.drawing, els: h.last })
    if (h.snaps.length > 60) h.snaps.shift()
  }
  useEffect(() => {
    const t = setTimeout(recordVersion, 400)
    return () => clearTimeout(t)
  }, [els, currentId])

  const bridgeRef = useRef<(op: string, args: any) => Promise<unknown>>(async () => null)
  bridgeRef.current = async (op, args) => {
    if (!loaded.current) throw new Error('O Rabiscadraw ainda está carregando; tente de novo.')
    recordVersion()
    const cur = elsRef.current
    // deleting a node takes its connections and their captions with it
    const withLinks = (ids: Set<string>) => {
      const gone = new Set(ids)
      for (const e of cur) {
        if (isLink(e) && [e.from, e.to, e.bindStart, e.bindEnd].some((x) => x && ids.has(x))) gone.add(e.id)
      }
      for (const e of cur) if (e.aux && e.of && gone.has(e.of)) gone.add(e.id)
      return gone
    }
    switch (op) {
      case 'add_diagram': return applyDiagram(args.spec, args.target, args.name)
      case 'add_sequence': return applySequence(args.spec, args.target, args.name)
      case 'get_scene': return readGraph(cur, currentName, versions.current.v)
      case 'changes_since': {
        const h = versions.current
        const now = h.v
        const base = h.snaps.find((x) => x.v === args.version)
        if (args.version === now) return { version: now, changed: false }
        if (!base) return { version: now, stale: true, message: 'Essa versão é antiga demais (ou inexistente). Leia o quadro de novo com get_scene.' }
        if (base.drawing !== currentRef.current) return { version: now, reset: true, message: 'Outro desenho foi aberto desde então. Leia o quadro de novo com get_scene.' }
        return { version: now, changed: true, ...diffEls(base.els, cur) }
      }
      case 'screenshot': {
        let list = cur
        if (args.ids?.length) {
          const picked = args.ids.map((id: string) => findNode(cur, id) ?? cur.find((e) => e.id === id))
          const bad = args.ids.filter((_: string, i: number) => !picked[i])
          if (bad.length) throw new Error(`Não encontrei: ${bad.join(', ')}.`)
          const keep = new Set<string>(picked.map((e: El) => e.id))
          const nodeIds = new Set<string>(keep)
          for (const e of cur) {
            const a = e.from ?? e.bindStart, b = e.to ?? e.bindEnd
            if (isLink(e) && a && b && nodeIds.has(a) && nodeIds.has(b)) keep.add(e.id)
            if (e.frame && picked.some((p: El) => p.grp && p.grp === e.nid)) keep.add(e.id)
          }
          for (const e of cur) if (e.aux && e.of && keep.has(e.of)) keep.add(e.id)
          list = cur.filter((e) => keep.has(e.id))
        }
        const area = args.region ? { x: args.region.x, y: args.region.y, w: Math.max(20, args.region.w), h: Math.max(20, args.region.h) } : undefined
        const snap = snapshotPNG(list, { maxSide: args.max_side, area, numbered: !!args.numbered })
        if (!snap) return { png: undefined }
        return {
          png: snap.png,
          legend: snap.legend.map(({ n, el }) => ({ n, id: el.nid ?? el.id, ...(el.text ? { label: el.text } : {}), description: el.description })),
        }
      }
      case 'update_elements': {
        let next = cur
        const moved: string[] = []
        const done: string[] = []
        const missing: string[] = []
        for (const u of args.updates as any[]) {
          const target = findNode(next, u.ref) ?? next.find((e) => e.id === u.ref && isLink(e))
          if (!target) { missing.push(u.ref); continue }
          let n: El = target
          if (typeof u.label === 'string') {
            if (isLink(target)) {
              const cap = next.find((e) => e.aux && e.of === target.id)
              const m = measureText(u.label, 14, 'excali')
              const mid = { x: target.x + target.w / 2, y: target.y + target.h / 2 }
              if (cap) next = next.map((e) => (e.id === cap.id ? { ...e, text: u.label, w: m.w, h: m.h } : e))
              else if (u.label) next = [...next, { id: crypto.randomUUID(), aux: true, of: target.id, type: 'text', x: mid.x - m.w / 2, y: mid.y - m.h - 6, w: m.w, h: m.h, stroke: '#495057', fill: 'transparent', strokeWidth: 1, roughness: 0.6, seed: 1, text: u.label, fontSize: 14, fontFamily: 'excali' }]
              n = { ...n, cap: u.label || undefined }
            } else if (target.type === 'text') {
              const m = measureText(u.label, target.fontSize ?? 20, target.fontFamily ?? 'excali')
              n = { ...n, text: u.label, w: m.w, h: m.h }
            } else n = { ...n, text: u.label }
          }
          if (u.description !== undefined) n = { ...n, description: u.description?.trim() || undefined }
          if (u.kind) {
            if (n.type !== 'icon' || !iconById(u.kind)) throw new Error(`"${u.ref}" não é um ícone, ou "${u.kind}" não existe em list_components.`)
            n = { ...n, icon: u.kind }
          }
          if (u.color) n = { ...n, stroke: COLORS[u.color as keyof typeof COLORS].stroke, fill: n.type === 'text' ? 'transparent' : COLORS[u.color as keyof typeof COLORS].fill }
          if (typeof u.x === 'number' || typeof u.y === 'number') {
            n = { ...n, x: typeof u.x === 'number' ? u.x : n.x, y: typeof u.y === 'number' ? u.y : n.y }
            moved.push(n.id)
          }
          next = next.map((e) => (e.id === n.id ? n : e))
          done.push(u.ref)
        }
        if (done.length) commit(reattach(next, moved))
        return { updated: done.length, ...(missing.length ? { not_found: missing } : {}) }
      }
      case 'connect_nodes': {
        const bad: string[] = []
        const links = (args.edges as any[]).map((e) => {
          const from = findNode(cur, e.from), to = findNode(cur, e.to)
          if (!from) bad.push(e.from)
          if (!to) bad.push(e.to)
          return { from: from!, to: to!, label: e.label, kind: e.kind }
        })
        if (bad.length) throw new Error(`Nós não encontrados: ${[...new Set(bad)].join(', ')}. Veja os ids com get_scene.`)
        const made = linkEls(cur, links)
        commit([...cur, ...made])
        return { created: made.filter((e) => isLink(e)).map((e) => e.id) }
      }
      case 'list_drawings':
        return { current: currentRef.current, drawings: metas.map((m) => ({ id: m.id, name: m.name, updatedAt: new Date(m.updatedAt).toISOString() })) }
      case 'open_drawing': {
        const m = metas.find((x) => x.id === args.id) ?? metas.find((x) => x.name === args.id)
        if (!m) throw new Error('Desenho não encontrado.')
        await switchTo(m.id)
        return { opened: m.name }
      }
      case 'clear': commit([]); setSel([]); return { cleared: true }
      case 'delete_elements': {
        const ids = new Set<string>(args.ids.map((id: string) => findNode(cur, id)?.id ?? id))
        const gone = withLinks(ids)
        const n = cur.filter((e) => ids.has(e.id)).length
        commit(cur.filter((e) => !gone.has(e.id)))
        setSel([])
        return { deleted: n, also_removed_connections: cur.filter((e) => gone.has(e.id) && !ids.has(e.id) && !e.aux).length }
      }
      default: throw new Error(`Operação desconhecida: ${op}`)
    }
  }
  // each browser has its own private MCP address; the token is what ties an agent to this page
  useEffect(() => connectBridge(mcpToken, (op, args) => bridgeRef.current(op, args)), [mcpToken])
  const mcpUrl = `${location.origin}/mcp/${mcpToken}`
  const claudeCmd = `claude mcp add --transport http rabiscadraw ${mcpUrl}`
  const codexCfg = `[mcp_servers.rabiscadraw]\nurl = "${mcpUrl}"`
  const copyText = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(text); setTimeout(() => setCopied(''), 1500) }).catch(() => { /* clipboard blocked */ })
  }
  const rotateToken = () => {
    if (confirm('Gerar um endereço novo? O atual deixa de funcionar e os agentes conectados precisam ser reconfigurados.')) setMcpToken(newToken())
  }

  const askAI = async () => {
    const prompt = aiPrompt.trim()
    if (!prompt || aiBusy) return
    setAiBusy(true)
    setAiMsg('')
    try {
      const r = await fetch('/api/ai/diagram', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) })
      const data = await r.json().catch(() => null)
      if (!r.ok) throw new Error(data?.error ?? `Erro ${r.status}`)
      const res = await applyDiagram(data.spec, aiTarget, data.spec.title ?? undefined)
      setAiMsg(`Pronto: ${res.elements} elementos desenhados. Desfaça com Ctrl+Z se não gostar.`)
    } catch (e) {
      setAiMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setAiBusy(false)
    }
  }
  // ---------- analyse a repository: drop a folder, review what would be sent, confirm
  const openRepo = async (found: { name: string; items: { path: string; file: File }[]; skipped: number } | null) => {
    if (!found || !found.items.length) { setAiOpen(true); setAiMsg('Não achei arquivos nessa pasta.'); return }
    const info = aiInfo ?? (await fetch('/api/ai/status').then((r) => r.json()).catch(() => null))
    setAiInfo(info)
    if (!info?.configured) { setAiOpen(true); setAiMsg('Este servidor não tem chave de IA configurada (OPENAI_API_KEY no .env), então não consigo analisar o repositório.'); return }
    const { usable, skipped } = usableOf(found.items, found.skipped)
    const sel = new Set(usable.map((i) => i.path))
    const sum = await summarize(found.name, usable, skipped, sel)
    setRepo({ name: found.name, all: usable, skipped, sel, forced: new Set(), sum, views: 'both', busy: false, msg: '', deep: true, prog: '' })
  }
  // the summary follows the ticks
  const repoKey = repo ? repo.sel : null
  const repoForced = repo ? repo.forced : null
  useEffect(() => {
    if (!repoKey || !repoForced) return
    let live = true
    const t = setTimeout(async () => {
      const cur = repoRef.current
      if (!cur) return
      const sum = await summarize(cur.name, cur.all, cur.skipped, cur.sel, cur.forced)
      if (live) setRepo((c) => (c && c.sel === cur.sel && c.forced === cur.forced ? { ...c, sum } : c))
    }, 150)
    return () => { live = false; clearTimeout(t) }
  }, [repoKey, repoForced])
  const pickRepo = (paths: string[], on: boolean, byHand: boolean) => setRepo((c) => {
    if (!c) return c
    const sel = new Set(c.sel), forced = new Set(c.forced)
    for (const p of paths) {
      if (on) { sel.add(p); if (byHand) forced.add(p) } else { sel.delete(p); forced.delete(p) }
    }
    return { ...c, sel, forced }
  })
  const pickAllRepo = async (mode: 'all' | 'none' | 'essential') => {
    const c = repoRef.current
    if (!c) return
    if (mode === 'essential') {
      const keys = (await summarize(c.name, c.all, c.skipped, new Set(c.all.map((i) => i.path)))).included.map((f) => f.path)
      setRepo((x) => (x ? { ...x, sel: new Set(keys), forced: new Set() } : x))
    } else setRepo((x) => (x ? { ...x, sel: mode === 'all' ? new Set(x.all.map((i) => i.path)) : new Set(), forced: new Set() } : x))
  }
  const analyseRepo = async () => {
    if (!repo || repo.busy) return
    setRepo({ ...repo, busy: true, msg: '', prog: '' })
    try {
      // deep analysis: every allowed file is read in full, module by module, and the drawing is made from the module summaries
      let summaryText = repo.sum.text
      let note = ''
      if (repo.deep) {
        const picked = repo.all.filter((i) => repo.sel.has(i.path))
        const mods = await modulesOf(picked)
        const head = repo.sum.text.split('\n## Arquivos-chave\n')[0]
        const res = await mapModules(repo.name, mods, (d, t) => setRepo((c) => (c ? { ...c, prog: `Resumindo módulos: ${d} de ${t}…` } : c)))
        if (!res.done) throw new Error('Nenhum módulo foi resumido. Tente de novo ou desligue a análise profunda.')
        summaryText = `${head}\n${res.text}`
        note = ` ${res.done} de ${res.total} módulos lidos por inteiro (${res.files} arquivos).`
        setRepo((c) => (c ? { ...c, prog: 'Desenhando a partir dos resumos…' } : c))
      }
      const r = await fetch('/api/ai/repo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: repo.name, summary: summaryText, views: repo.views === 'both' ? ['architecture', 'sequence'] : [repo.views] }) })
      const data = await r.json().catch(() => null)
      if (!r.ok) throw new Error(data?.error ?? `Erro ${r.status}`)
      const arch = data.architecture ?? data.spec
      // the guide looks into these files (only the ones the person allowed) when answering questions
      const files = repo.all.filter((i) => repo.sel.has(i.path))
      const index = await buildIndex(repo.name, files).catch(() => '')
      let drawn = 0
      // each view is its own drawing; the sequence goes first so the architecture is the one left open
      if (data.sequence && repo.views !== 'architecture') {
        drawn += (await applySequence(data.sequence, 'new', data.sequence.title ?? `Sequência de ${repo.name}`)).elements
        startGuide('sequence', repo.name, summaryText, index, files)
      }
      if (arch && repo.views !== 'sequence') {
        drawn += (await applyDiagram(arch, 'new', arch.title ?? `Arquitetura de ${repo.name}`)).elements
        startGuide('architecture', repo.name, summaryText, index, files)
      }
      setRepo(null)
      setAiOpen(false)
      setChatOpen(true)
      setAiMsg(`Repositório analisado: ${drawn} elementos desenhados.${note}`)
    } catch (e) {
      setRepo((cur) => (cur ? { ...cur, busy: false, prog: '', msg: e instanceof Error ? e.message : String(e) } : cur))
    }
  }
  // ---------- the guide: a summary of the drawing and answers about each piece, which light up on the board
  const putChat = (id: string, data: ChatData) => {
    chats.current.set(id, data)
    setChatTick((t) => t + 1)
    saveChat(id, data).catch(() => { /* storage blocked */ })
  }
  const say = (id: string, msg: ChatMsg) => {
    const c = chats.current.get(id)
    if (c) putChat(id, { ...c, messages: [...c.messages, msg] })
  }
  const busyOn = (id: string, on: boolean) => setChatBusy((b) => (on ? [...b, id] : b.filter((x) => x !== id)))

  // pieces blink softly for a few seconds; if they are off screen the board slides to them
  const pulse = (ids: string[]) => {
    window.clearTimeout(focusTimer.current)
    setFocusIds(ids)
    if (!ids.length) return
    const hit = piecesOf(elsRef.current, ids)
    const b = boundsOf(hit)
    const n = stageRef.current
    if (b && n) {
      const v = viewRef.current, pad = 70
      const x1 = v.x + b.x * v.zoom, y1 = v.y + b.y * v.zoom, x2 = x1 + b.w * v.zoom, y2 = y1 + b.h * v.zoom
      if (x1 < (sidebarRef.current ? 480 : 250) || y1 < pad + 40 || x2 > n.clientWidth - 380 || y2 > n.clientHeight - pad) {
        const z = Math.min(Math.max(v.zoom, 0.6), 1)
        const availW = n.clientWidth - 380 - (sidebarRef.current ? 262 : 12)
        setView({ zoom: z, x: (sidebarRef.current ? 262 : 12) + availW / 2 - (b.x + b.w / 2) * z, y: n.clientHeight / 2 - (b.y + b.h / 2) * z })
      }
    }
    focusTimer.current = window.setTimeout(() => setFocusIds([]), 9000)
  }

  const startGuide = (kind: ChatData['kind'], repoName: string, context: string, index?: string, files?: RepoItem[]) => {
    const id = currentRef.current
    const graph = askGraph(lastDrawn.current)
    if (files?.length && index) setRepoFiles(id, files)
    putChat(id, { repoName, kind, context, index: index || undefined, messages: [] })
    busyOn(id, true)
    askServer({ mode: 'overview', kind, graph, context, history: [] })
      .then((r) => { say(id, { role: 'ai', text: r.answer, focus: r.focus }); if (currentRef.current === id) pulse(r.focus) })
      .catch((e) => say(id, { role: 'ai', text: `Não consegui montar o resumo: ${e instanceof Error ? e.message : String(e)}`, error: true }))
      .finally(() => busyOn(id, false))
  }

  const askGuide = async (question: string, selected: string[]) => {
    const id = currentRef.current
    const c = chats.current.get(id)
    if (!c || chatBusy.includes(id)) return
    putChat(id, { ...c, messages: [...c.messages, { role: 'user', text: question }] })
    busyOn(id, true)
    // while the dropped files are still in memory the guide looks into the code; after a reload it answers from the saved summary
    const files = repoFilesOf(id)
    const tools = files && c.index
      ? { index: c.index, run: (t: Parameters<typeof runTool>[1]) => runTool(files, t), onStep: (t: Parameters<typeof runTool>[1]) => setChatStatus((s) => ({ ...s, [id]: describeTool(t) })) }
      : undefined
    try {
      const r = await askServer({ mode: 'ask', kind: c.kind, graph: askGraph(elsRef.current), context: c.context, history: c.messages.filter((m) => !m.error), question, selected }, tools)
      say(id, { role: 'ai', text: r.answer, focus: r.focus })
      if (currentRef.current === id) pulse(r.focus)
    } catch (e) {
      say(id, { role: 'ai', text: e instanceof Error ? e.message : String(e), error: true })
    } finally {
      busyOn(id, false)
      setChatStatus((s) => { const { [id]: _gone, ...rest } = s; return rest })
    }
  }

  // switching drawings: the guide of the new one comes from storage
  useEffect(() => {
    window.clearTimeout(focusTimer.current)
    setFocusIds([])
    if (chats.current.has(currentId)) { setChatTick((t) => t + 1); return }
    let live = true
    loadChat<ChatData>(currentId)
      .then((d) => { if (d && live && !chats.current.has(currentId)) { chats.current.set(currentId, d); setChatTick((t) => t + 1) } })
      .catch(() => { /* ignore */ })
    return () => { live = false }
  }, [currentId])

  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const enter = (e: DragEvent) => { if (hasFiles(e)) { depth++; setDropping(true) } }
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault() }
    const leave = (e: DragEvent) => { if (hasFiles(e) && --depth <= 0) { depth = 0; setDropping(false) } }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDropping(false)
      const dt = e.dataTransfer!
      if (dropHasFolder(dt)) collectDrop(dt).then(openRepo).catch(() => setAiMsg('Não consegui ler a pasta.'))
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [aiInfo])

  useEffect(() => {
    if (!aiOpen) return
    fetch('/api/ai/status').then((r) => r.json()).then(setAiInfo).catch(() => setAiInfo(null))
  }, [aiOpen])

  // track stage size
  useLayoutEffect(() => {
    const node = stageRef.current!
    const ro = new ResizeObserver(() => setSize({ w: node.clientWidth, h: node.clientHeight }))
    ro.observe(node)
    setSize({ w: node.clientWidth, h: node.clientHeight })
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const c = laserCanvas.current!
    const dpr = window.devicePixelRatio || 1
    c.width = Math.floor(size.w * dpr)
    c.height = Math.floor(size.h * dpr)
  }, [size])

  // render
  useEffect(() => {
    const c = canvasRef.current!
    const dpr = window.devicePixelRatio || 1
    c.width = Math.floor(size.w * dpr)
    c.height = Math.floor(size.h * dpr)
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.x, dpr * view.y)
    const rc = rough.canvas(c)
    // with an arrow selected, the other arrows (and their captions) fade so its flow stands out
    const flowSel = flowOf(els, sel, tool === 'select' && !editing)
    const arrowIds = new Set(flowSel ? els.filter(isFlowEl).map((e) => e.id) : [])
    for (const el of els) {
      const faded = !!flowSel && ((isFlowEl(el) && el.id !== flowSel.id) || (!!el.aux && !!el.of && el.of !== flowSel.id && arrowIds.has(el.of)))
      if (faded) { ctx.save(); ctx.globalAlpha = 0.2 }
      if (el.id !== editing?.id) drawElement(rc, ctx, el)
      else if (el.type !== 'text') drawElement(rc, ctx, { ...el, text: undefined })
      if (faded) ctx.restore()
    }

    const z = view.zoom
    const selEls = els.filter((e) => sel.includes(e.id) && e.id !== editing?.id)
    // outline of an element, turned together with it when rotated
    const outline = (e: El, pad: number) => {
      const bb = bbox(e), c = centerOf(e)
      ctx.save()
      if (e.angle && canRotate(e)) { ctx.translate(c.x, c.y); ctx.rotate(e.angle); ctx.translate(-c.x, -c.y) }
      ctx.strokeRect(bb.x - pad, bb.y - pad, bb.w + 2 * pad, bb.h + 2 * pad)
      ctx.restore()
    }
    ctx.save()
    ctx.strokeStyle = '#6965db'
    ctx.fillStyle = '#fff'
    ctx.lineWidth = 1.5 / z
    if (selEls.length === 1) {
      const s = selEls[0]
      const hs = handlesOf(s, z)
      if (s.type !== 'line' && s.type !== 'arrow') {
        outline(s, 6 / z)
        const rot = hs.find((h) => h.name === 'rot')
        if (rot) {
          const bb = bbox(s), c = centerOf(s)
          const top = rotatePt(c.x, bb.y - 6 / z, c.x, c.y, s.angle ?? 0)
          ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(rot.x, rot.y); ctx.stroke()
        }
        for (const h of hs) {
          if (h.name === 'rot') { ctx.beginPath(); ctx.arc(h.x, h.y, 5 / z, 0, Math.PI * 2); ctx.fill(); ctx.stroke() }
          else { ctx.fillRect(h.x - 4 / z, h.y - 4 / z, 8 / z, 8 / z); ctx.strokeRect(h.x - 4 / z, h.y - 4 / z, 8 / z, 8 / z) }
        }
      } else {
        for (const h of hs) { ctx.beginPath(); ctx.arc(h.x, h.y, 5 / z, 0, Math.PI * 2); ctx.fill(); ctx.stroke() }
      }
    } else if (selEls.length > 1 && selEls.every((e) => e.groupId && e.groupId === selEls[0].groupId)) {
      // a group: one box around all of it
      const gb = boundsOf(selEls)!
      ctx.strokeRect(gb.x - 8 / z, gb.y - 8 / z, gb.w + 16 / z, gb.h + 16 / z)
    } else {
      ctx.setLineDash([6 / z, 4 / z])
      for (const s of selEls) outline(s, 4 / z)
    }
    const hov = tool === 'select' && hover && !sel.includes(hover) ? els.find((e) => e.id === hover) : undefined
    if (hov) {
      ctx.setLineDash([])
      ctx.globalAlpha = 0.55
      outline(hov, 4 / z)
      ctx.globalAlpha = 1
    }
    // the element an arrow end would attach to
    const bh = bindHint ? els.find((e) => e.id === bindHint) : undefined
    if (bh) {
      ctx.setLineDash([])
      ctx.lineWidth = 2.5 / z
      ctx.globalAlpha = 0.9
      outline(bh, 8 / z)
      ctx.globalAlpha = 1
      ctx.lineWidth = 1.5 / z
    }
    // "i" button on elements that carry an explanation: a quiet outlined dot beside the element's top-right corner;
    // clicking it opens or closes the explanation card
    for (const e of els) {
      if (!e.description || e.id === editing?.id) continue
      const m = notePoint(e, z), r = 8 / z
      const open = openNote === e.id, on = onMarker === e.id
      ctx.save()
      ctx.setLineDash([])
      ctx.globalAlpha = open || on ? 1 : 0.8
      ctx.fillStyle = open ? '#6965db' : '#fff'
      ctx.strokeStyle = open || on ? '#6965db' : '#b4b4c0'
      ctx.lineWidth = 1.25 / z
      ctx.beginPath(); ctx.arc(m.x, m.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
      ctx.fillStyle = open ? '#fff' : on ? '#6965db' : '#9a9aa8'
      ctx.font = `600 ${11 / z}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('i', m.x, m.y + 0.5 / z)
      ctx.restore()
    }
    // padlock on locked elements: clicking it unlocks the element
    for (const e of els) {
      if (!e.locked) continue
      const m = lockPoint(e, z), r = 8 / z, on = onLock === e.id, u = 1 / z
      ctx.save()
      ctx.setLineDash([])
      ctx.globalAlpha = on ? 1 : 0.85
      ctx.fillStyle = '#fff'
      ctx.strokeStyle = on ? '#6965db' : '#b4b4c0'
      ctx.lineWidth = 1.25 * u
      ctx.beginPath(); ctx.arc(m.x, m.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
      ctx.fillStyle = ctx.strokeStyle = on ? '#6965db' : '#8a8a98'
      ctx.lineWidth = 1.3 * u
      ctx.fillRect(m.x - 3 * u, m.y - 0.5 * u, 6 * u, 4.5 * u)
      ctx.beginPath(); ctx.arc(m.x, m.y - 0.8 * u, 2.2 * u, Math.PI, 0); ctx.stroke()
      ctx.restore()
    }
    if (marquee) {
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(105,101,219,.1)'
      ctx.fillRect(marquee.x, marquee.y, marquee.w, marquee.h)
      ctx.strokeRect(marquee.x, marquee.y, marquee.w, marquee.h)
    }
    ctx.restore()
  }, [els, view, sel, size, editing?.id, tick, hover, marquee, tool, bindHint, openNote, onMarker, onLock])

  useEffect(() => { onImageLoad(() => setTick((t) => t + 1)) }, [])

  // wheel: pan, ctrl+wheel: zoom at cursor
  useEffect(() => {
    const node = stageRef.current!
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('.sidebar, .palette, .ai-panel, .chat-panel, .note-card, .props, .ctx, .repo-modal')) return
      setMenu(null)
      e.preventDefault()
      const v = viewRef.current
      if (e.ctrlKey || e.metaKey) {
        const r = node.getBoundingClientRect()
        const sx = e.clientX - r.left, sy = e.clientY - r.top
        // a mouse-wheel notch reports deltaY ≈ 100 (≈2.7x per tick); clamp so each event is a ~10% step
        const dy = Math.max(-10, Math.min(10, e.deltaY * (e.deltaMode === 1 ? 16 : 1)))
        const z = Math.min(8, Math.max(0.1, v.zoom * Math.exp(-dy * 0.01)))
        const wx = (sx - v.x) / v.zoom, wy = (sy - v.y) / v.zoom
        setView({ zoom: z, x: sx - wx * z, y: sy - wy * z })
      } else {
        setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY })
      }
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [])

  const zoomBy = (f: number) => {
    const v = viewRef.current
    const z = Math.min(8, Math.max(0.1, v.zoom * f))
    const cx = size.w / 2, cy = size.h / 2
    const wx = (cx - v.x) / v.zoom, wy = (cy - v.y) / v.zoom
    setView({ zoom: z, x: cx - wx * z, y: cy - wy * z })
  }

  const commitText = useCallback(() => {
    const ed = editRef.current
    if (!ed) return
    editRef.current = null
    setEditing(null)
    const value = ed.value
    const bound = ed.id ? elsRef.current.find((e) => e.id === ed.id && e.type !== 'text') : undefined
    if (bound) {
      commit(elsRef.current.map((e) => (e.id === ed.id ? { ...e, text: value.trim() ? value : undefined } : e)))
    } else if (ed.id) {
      if (!value.trim()) {
        commit(elsRef.current.filter((e) => e.id !== ed.id))
        setSel([])
      } else {
        const m = measureText(value, ed.fontSize, ed.fontFamily)
        commit(elsRef.current.map((e) => (e.id === ed.id ? { ...e, text: value, w: m.w, h: m.h } : e)))
      }
    } else if (value.trim()) {
      const m = measureText(value, ed.fontSize, ed.fontFamily)
      const el: El = {
        id: crypto.randomUUID(), type: 'text', x: ed.x, y: ed.y, w: m.w, h: m.h,
        ...styleRef.current, stroke: ed.color, fill: 'transparent',
        seed: 1, text: value, fontSize: ed.fontSize, fontFamily: ed.fontFamily,
      }
      commit([...elsRef.current, el])
      setSel([el.id])
    }
  }, [commit])

  useEffect(() => {
    if (!editing) return
    const t = setTimeout(() => taRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [editing?.id, editing?.x, editing?.y])

  // clipboard: copy/cut/paste elements, paste images and plain text. The keyboard, the browser menu and the right-click menu share these.
  const copyPayload = () => JSON.stringify({ type: 'rabiscadraw', elements: elsRef.current.filter((x) => selRef.current.includes(x.id)) })
  const centreOfView = () => {
    const n = stageRef.current!, v = viewRef.current
    return { x: (n.clientWidth / 2 - v.x) / v.zoom, y: (n.clientHeight / 2 - v.y) / v.zoom }
  }
  const addImageFile = (file: Blob) => {
    const reader = new FileReader()
    reader.onload = () => {
      const src = reader.result as string
      const probe = new Image()
      probe.onload = () => {
        const k = Math.min(1, 400 / probe.naturalWidth)
        const w = probe.naturalWidth * k, h = probe.naturalHeight * k
        const c = centreOfView()
        const el: El = {
          id: crypto.randomUUID(), type: 'image', x: c.x - w / 2, y: c.y - h / 2, w, h,
          ...styleRef.current, seed: 1, src,
        }
        commit([...elsRef.current, el])
        setSel([el.id])
      }
      probe.src = src
    }
    reader.readAsDataURL(file)
  }
  const pasteText = (txt: string) => {
    try {
      const d = JSON.parse(txt)
      if (isSceneType(d?.type) && Array.isArray(d.elements)) {
        const copies: El[] = cloneEls(d.elements as El[], 16, 16)
        commit([...elsRef.current, ...copies])
        setSel(copies.map((c) => c.id))
        return
      }
    } catch { /* not ours: paste as text */ }
    const m = measureText(txt, 20, fontRef.current), c = centreOfView()
    const el: El = {
      id: crypto.randomUUID(), type: 'text', x: c.x - m.w / 2, y: c.y - m.h / 2, w: m.w, h: m.h,
      ...styleRef.current, fill: 'transparent', seed: 1, text: txt, fontSize: 20, fontFamily: fontRef.current,
    }
    commit([...elsRef.current, el])
    setSel([el.id])
  }
  useEffect(() => {
    const inField = (e: Event) => ['TEXTAREA', 'INPUT'].includes((e.target as HTMLElement).tagName)
    const onCopy = (e: ClipboardEvent, cut: boolean) => {
      if (inField(e) || !selRef.current.length) return
      e.preventDefault()
      e.clipboardData?.setData('text/plain', act.current.copyPayload())
      if (cut) { commit(elsRef.current.filter((x) => !selRef.current.includes(x.id))); setSel([]) }
    }
    const onPaste = (e: ClipboardEvent) => {
      if (inField(e) || !e.clipboardData) return
      const file = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'))?.getAsFile()
      if (file) { e.preventDefault(); act.current.addImageFile(file); return }
      const txt = e.clipboardData.getData('text/plain')
      if (!txt) return
      e.preventDefault()
      act.current.pasteText(txt)
    }
    const copy = (e: ClipboardEvent) => onCopy(e, false)
    const cut = (e: ClipboardEvent) => onCopy(e, true)
    window.addEventListener('copy', copy)
    window.addEventListener('cut', cut)
    window.addEventListener('paste', onPaste)
    return () => { window.removeEventListener('copy', copy); window.removeEventListener('cut', cut); window.removeEventListener('paste', onPaste) }
  }, [commit])

  // right-click menu closes when anything outside it is pressed
  useEffect(() => {
    if (!menu && !fileMenu) return
    const close = (e: PointerEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('.ctx') || t.closest('.menu')) return
      setMenu(null)
      setFileMenu(false)
    }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [menu, fileMenu])

  // keyboard
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement
      if (['TEXTAREA', 'INPUT'].includes(tgt.tagName)) {
        // in a field of the properties panel Ctrl+Z / Ctrl+Y still mean undo / redo of the drawing
        const key = e.key.toLowerCase()
        if ((e.ctrlKey || e.metaKey) && (key === 'z' || key === 'y') && tgt.closest('.props, .note-card')) {
          e.preventDefault()
          tgt.blur()
          const again = key === 'y' || e.shiftKey
          setTimeout(() => (again ? redo() : undo()), 0)
        }
        return
      }
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (e.code === 'Space') { space.current = true; setSpaceHeld(true); e.preventDefault(); return }
      const anySel = selRef.current.length > 0
      if (mod && e.altKey && e.code === 'KeyC') { e.preventDefault(); act.current.copyStyles(); return }
      if (mod && e.altKey && e.code === 'KeyV') { e.preventDefault(); act.current.pasteStyles(); return }
      if (!mod && e.shiftKey && e.altKey && e.code === 'KeyC') { e.preventDefault(); act.current.copyPng(); return }
      if (mod && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        e.preventDefault()
        act.current.reorder(e.code === 'BracketLeft' ? (e.shiftKey ? 'back' : 'backward') : (e.shiftKey ? 'front' : 'forward'))
        return
      }
      if (mod && e.shiftKey && k === 'l') { e.preventDefault(); act.current.toggleLock(); return }
      if (!mod && !e.altKey && e.shiftKey && anySel && (e.code === 'KeyH' || e.code === 'KeyV')) { e.preventDefault(); act.current.flipSel(e.code === 'KeyH' ? 'h' : 'v'); return }
      if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return }
      if (mod && k === 'y') { e.preventDefault(); redo(); return }
      if (mod && k === 'd') {
        e.preventDefault()
        const copies = cloneEls(elsRef.current.filter((x) => selRef.current.includes(x.id)), 16, 16, true)
        if (copies.length) { commit([...elsRef.current, ...copies]); setSel(copies.map((c) => c.id)) }
        return
      }
      if (mod && k === 'g') {
        e.preventDefault()
        const ids = selRef.current
        if (e.shiftKey) {
          if (elsRef.current.some((x) => ids.includes(x.id) && x.groupId)) commit(elsRef.current.map((x) => (ids.includes(x.id) ? { ...x, groupId: undefined } : x)))
        } else if (ids.length > 1) {
          const gid = crypto.randomUUID()
          commit(elsRef.current.map((x) => (ids.includes(x.id) ? { ...x, groupId: gid } : x)))
        }
        return
      }
      if (mod && k === 's') { e.preventDefault(); act.current.saveFile(); return }
      if (mod && k === 'o') { e.preventDefault(); act.current.openFileDialog(); return }
      if (mod && k === 'a') { e.preventDefault(); setTool('select'); setSel(elsRef.current.filter((x) => !x.locked).map((x) => x.id)); return }
      if (mod) return
      if (k === 'delete' || k === 'backspace') {
        if (selRef.current.length) { commit(elsRef.current.filter((x) => !selRef.current.includes(x.id))); setSel([]) }
        return
      }
      if (k === 'enter' && (e.target as HTMLElement).tagName !== 'BUTTON' && act.current.editSelected()) { e.preventDefault(); return }
      if (k === 'escape') { setTool('select'); setSel([]); setOpenNote(null); setMenu(null); setFileMenu(false); return }
      if (k.startsWith('arrow') && selRef.current.length) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0
        const dy = k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0
        commit(detachMoved(elsRef.current.map((x) => (selRef.current.includes(x.id) ? { ...x, x: x.x + dx, y: x.y + dy } : x)), selRef.current))
        return
      }
      if (KEY_TO_TOOL[k]) { setTool(KEY_TO_TOOL[k]); if (KEY_TO_TOOL[k] !== 'select') setSel([]) }
    }
    const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space') { space.current = false; setSpaceHeld(false) } }
    // the key-up never arrives if the window loses focus while Space is held
    const onBlur = () => { space.current = false; setSpaceHeld(false) }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); window.removeEventListener('blur', onBlur) }
  }, [commit, undo, redo])

  const toWorld = (e: { clientX: number; clientY: number }) => {
    const r = stageRef.current!.getBoundingClientRect()
    const v = viewRef.current
    return { sx: e.clientX - r.left, sy: e.clientY - r.top, x: (e.clientX - r.left - v.x) / v.zoom, y: (e.clientY - r.top - v.y) / v.zoom }
  }

  const hitAt = (x: number, y: number): El | null => {
    const tol = 6 / viewRef.current.zoom
    const list = elsRef.current
    for (let i = list.length - 1; i >= 0; i--) if (!list[i].locked && hitTest(list[i], x, y, tol)) return list[i]
    return null
  }

  // a selected element can be grabbed anywhere inside its box, not only on its lines
  const selInside = (x: number, y: number): string | null => {
    const pad = 6 / viewRef.current.zoom
    return elsRef.current.find((el) => selRef.current.includes(el.id) && insideBox(el, x, y, pad))?.id ?? null
  }

  // the "i" button of an element with an explanation under the pointer
  const markerAt = (x: number, y: number): string | null => {
    const z = viewRef.current.zoom
    const list = elsRef.current
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]
      if (!e.description) continue
      const m = notePoint(e, z)
      if (Math.hypot(x - m.x, y - m.y) <= 10 / z) return e.id
    }
    return null
  }

  // the padlock of a locked element under the pointer
  const lockAt = (x: number, y: number): string | null => {
    const z = viewRef.current.zoom
    const list = elsRef.current
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]
      if (!e.locked) continue
      const m = lockPoint(e, z)
      if (Math.hypot(x - m.x, y - m.y) <= 10 / z) return e.id
    }
    return null
  }

  // clicking a member of a group means the whole group
  const withGroups = (ids: string[]): string[] => {
    const gs = new Set(elsRef.current.filter((e) => ids.includes(e.id) && e.groupId).map((e) => e.groupId))
    if (!gs.size) return ids
    return elsRef.current.filter((e) => ids.includes(e.id) || (e.groupId && gs.has(e.groupId))).map((e) => e.id)
  }

  const openTextEditor = (x: number, y: number, el?: El) => {
    if (el && el.type !== 'text') {
      // caption of a shape or an icon: edited in place, centred
      const b = bbox(el)
      const icon = el.type === 'icon'
      const L = icon ? iconLayout(el, el.text || 'x') : null
      editRef.current = {
        id: el.id, x: 0, y: 0, value: el.text ?? '',
        fontSize: el.fontSize ?? (icon ? 16 : 20), fontFamily: el.fontFamily ?? fontRef.current, color: el.stroke,
        center: { x: b.x + b.w / 2, y: icon && L ? b.y + L.side + L.labelH / 2 : b.y + b.h / 2 },
      }
      setEditing(editRef.current)
      return
    }
    editRef.current = {
      id: el?.id, x: el?.x ?? x, y: el?.y ?? y, value: el?.text ?? '', align: el?.align,
      fontSize: el?.fontSize ?? fontSizeRef.current, fontFamily: el?.fontFamily ?? fontRef.current, color: el?.stroke ?? styleRef.current.stroke,
    }
    setEditing(editRef.current)
  }

  // start dragging the given elements; with Alt held the drag pulls out copies and leaves the originals where they are
  const startMove = (ids: string[], p: { x: number; y: number }, alt: boolean) => {
    if (!alt) { drag.current = { kind: 'move', ids, x: p.x, y: p.y, snap: elsRef.current }; return }
    const base = elsRef.current
    const copies = cloneEls(base.filter((x) => ids.includes(x.id)), 0, 0, true)
    const next = [...base, ...copies]
    setEls(next)
    setSel(copies.map((c) => c.id))
    drag.current = { kind: 'move', ids: copies.map((c) => c.id), x: p.x, y: p.y, snap: next, base, orig: ids }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (editRef.current) { if ((e.target as HTMLElement).tagName !== 'TEXTAREA') commitText(); return }
    if ((e.target as HTMLElement).tagName !== 'CANVAS') return
    stageRef.current!.setPointerCapture(e.pointerId)
    setPaletteOpen(false)
    const p = toWorld(e)
    const t = toolRef.current

    if (e.button === 1 || t === 'hand' || space.current) {
      drag.current = { kind: 'pan', sx: p.sx, sy: p.sy, v: viewRef.current }
      setGrabbing(true)
      return
    }
    if (e.button !== 0) return

    if (t === 'select') {
      const lk = lockAt(p.x, p.y)
      if (lk) { commit(elsRef.current.map((x) => (x.id === lk ? { ...x, locked: undefined } : x))); setSel([lk]); return }
      const mk = markerAt(p.x, p.y)
      if (mk) { setOpenNote((o) => (o === mk ? null : mk)); return }
      const ids = selRef.current
      if (ids.length === 1) {
        const cur = elsRef.current.find((x) => x.id === ids[0])
        if (cur) {
          const z = viewRef.current.zoom
          const h = handlesOf(cur, z).find((hd) => Math.hypot(hd.x - p.x, hd.y - p.y) * z <= 9)
          if (h?.name === 'rot') { const c = centerOf(cur); drag.current = { kind: 'rotate', id: cur.id, cx: c.x, cy: c.y, snap: elsRef.current }; return }
          if (h) { drag.current = { kind: 'resize', id: cur.id, handle: h.name, orig: cur, snap: elsRef.current }; return }
        }
      }
      if (!e.shiftKey && ids.length && selInside(p.x, p.y)) {
        startMove(ids, p, e.altKey)
        return
      }
      const hit = hitAt(p.x, p.y)
      if (hit) {
        const gids = withGroups([hit.id])
        if (e.shiftKey) { setSel(ids.includes(hit.id) ? ids.filter((i) => !gids.includes(i)) : [...new Set([...ids, ...gids])]); return }
        const keep = ids.includes(hit.id)
        if (!keep) { select(hit); if (gids.length > 1) setSel(gids) }
        startMove(keep ? ids : gids, p, e.altKey)
      } else {
        if (!e.shiftKey) { setSel([]); setOpenNote(null) }
        drag.current = { kind: 'marquee', x: p.x, y: p.y, base: e.shiftKey ? ids : [] }
      }
      return
    }

    if (t === 'laser') {
      // while presenting, touching the "i" of an element opens or closes its explanation; anywhere else the laser draws
      const mk = markerAt(p.x, p.y)
      if (mk) { setOpenNote((o) => (o === mk ? null : mk)); return }
      drag.current = { kind: 'laser' }
      pushLaser(p.sx, p.sy, true)
      return
    }

    if (t === 'icon') {
      const def = iconById(iconKindRef.current)
      if (def) {
        const m = measureText(def.label, 16, 'excali')
        const c = COLORS[def.color ?? 'default']
        const w = Math.max(76, m.w + 14)
        const el: El = {
          id: crypto.randomUUID(), type: 'icon', icon: def.id, x: p.x - w / 2, y: p.y - 38, w, h: 76 + m.h + 10,
          ...styleRef.current, stroke: c.stroke, fill: c.fill, fillStyle: 'solid', seed: Math.floor(Math.random() * 2 ** 31),
          text: def.label, fontSize: 16, fontFamily: 'excali',
        }
        commit([...elsRef.current, el])
        setSel([el.id])
        setTool('select')
      }
      return
    }

    if (t === 'text') { openTextEditor(p.x, p.y); return }

    const shape: ShapeType = t === 'pen' ? 'freedraw' : (t as ShapeType)
    const base: El = {
      id: crypto.randomUUID(), type: shape, x: p.x, y: p.y, w: 0, h: 0,
      ...styleRef.current, seed: Math.floor(Math.random() * 2 ** 31),
      points: shape === 'freedraw' ? [[0, 0]] : undefined,
    }
    // an arrow or line that starts on an element is attached to it
    const startTgt = shape === 'arrow' || shape === 'line' ? bindHit(elsRef.current, p.x, p.y, 10 / viewRef.current.zoom, []) : null
    if (startTgt) base.bindStart = startTgt.id
    drag.current = { kind: 'create', id: base.id, x: p.x, y: p.y, shape, pts: [[p.x, p.y]], snap: elsRef.current, startId: startTgt?.id }
    setEls([...elsRef.current, base])
    setSel([base.id])
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    const p = toWorld(e)
    if (!d) {
      if (toolRef.current === 'select' && !editRef.current) {
        const h = (e.target as HTMLElement).tagName === 'CANVAS' ? hitAt(p.x, p.y)?.id ?? selInside(p.x, p.y) : null
        setHover((prev) => (prev === h ? prev : h))
        const mk = (e.target as HTMLElement).tagName === 'CANVAS' ? markerAt(p.x, p.y) : null
        setOnMarker((prev) => (prev === mk ? prev : mk))
        const lk = (e.target as HTMLElement).tagName === 'CANVAS' ? lockAt(p.x, p.y) : null
        setOnLock((prev) => (prev === lk ? prev : lk))
      } else if (toolRef.current === 'laser' && !editRef.current) {
        const mk = (e.target as HTMLElement).tagName === 'CANVAS' ? markerAt(p.x, p.y) : null
        setOnMarker((prev) => (prev === mk ? prev : mk))
      }
      return
    }
    if (d.kind === 'laser') {
      pushLaser(p.sx, p.sy)
    } else if (d.kind === 'pan') {
      setView({ ...d.v, x: d.v.x + p.sx - d.sx, y: d.v.y + p.sy - d.sy })
    } else if (d.kind === 'move') {
      const dx = p.x - d.x, dy = p.y - d.y
      if (Math.hypot(dx, dy) * viewRef.current.zoom > 3) d.moved = true
      setEls(rebind(detachMoved(d.snap.map((x) => (d.ids.includes(x.id) ? { ...x, x: x.x + dx, y: x.y + dy } : x)), d.ids)))
    } else if (d.kind === 'resize') {
      let out = resizeRotated(d.orig, d.handle, p.x, p.y, e.shiftKey)
      if ((d.orig.type === 'arrow' || d.orig.type === 'line') && (d.handle === 'p0' || d.handle === 'p1')) {
        // dragging an end of an arrow: attach it to the element under the pointer, or let it go
        const other = d.handle === 'p0' ? d.orig.bindEnd : d.orig.bindStart
        const tgt = bindHit(d.snap, p.x, p.y, 10 / viewRef.current.zoom, other ? [d.orig.id, other] : [d.orig.id])
        out = d.handle === 'p0' ? { ...out, bindStart: tgt?.id } : { ...out, bindEnd: tgt?.id }
        setBindHint(tgt?.id ?? null)
      }
      setEls(rebind(d.snap.map((x) => (x.id === d.id ? out : x))))
    } else if (d.kind === 'rotate') {
      let a = Math.atan2(p.y - d.cy, p.x - d.cx) + Math.PI / 2
      if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12)
      a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
      setEls(rebind(d.snap.map((x) => (x.id === d.id ? { ...x, angle: a } : x))))
    } else if (d.kind === 'marquee') {
      const box = { x: Math.min(d.x, p.x), y: Math.min(d.y, p.y), w: Math.abs(p.x - d.x), h: Math.abs(p.y - d.y) }
      setMarquee(box)
      const inside = elsRef.current
        .filter((el) => {
          if (el.locked) return false
          const b = bbox(el)
          return b.x >= box.x && b.y >= box.y && b.x + b.w <= box.x + box.w && b.y + b.h <= box.y + box.h
        })
        .map((el) => el.id)
      setSel([...new Set([...d.base, ...withGroups(inside)])])
    } else if (d.kind === 'create') {
      const upd = (fn: (el: El) => El) => setEls((cur) => rebind(cur.map((x) => (x.id === d.id ? fn(x) : x))))
      if (d.shape === 'freedraw') {
        d.pts.push([p.x, p.y])
        upd((el) => penEl(el, d.pts))
      } else {
        let dx = p.x - d.x, dy = p.y - d.y
        if (e.shiftKey) {
          if (d.shape === 'line' || d.shape === 'arrow') [dx, dy] = snap45(dx, dy)
          else { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * m; dy = Math.sign(dy || 1) * m }
        }
        if (d.shape === 'arrow' || d.shape === 'line') {
          const tgt = bindHit(elsRef.current, p.x, p.y, 10 / viewRef.current.zoom, d.startId ? [d.id, d.startId] : [d.id])
          setBindHint(tgt?.id ?? null)
          // the start is put back where the press happened first: attaching it moves it onto the outline
          upd((el) => ({ ...el, x: d.x, y: d.y, w: dx, h: dy, bindEnd: tgt?.id }))
        } else upd((el) => ({ ...el, w: dx, h: dy }))
      }
    }
  }

  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.kind === 'pan') setGrabbing(false)
    setBindHint(null)
    if (d.kind === 'marquee') {
      setMarquee(null)
      const only = elsRef.current.filter((x) => selRef.current.includes(x.id))
      if (only.length === 1) select(only[0])
    } else if (d.kind === 'create') {
      const el = elsRef.current.find((x) => x.id === d.id)
      const tiny = el && el.type !== 'freedraw' && Math.abs(el.w) < 3 && Math.abs(el.h) < 3
      if (!el || tiny) { setEls(d.snap); setSel([]); return }
      past.current.push(d.snap)
      future.current = []
      setTool('select')
    } else if (d.kind === 'move' && d.base) {
      // Alt+drag: one undo step takes the copies away again; a click without dragging leaves no copies behind
      if (d.moved) { past.current.push(d.base); future.current = [] } else { setEls(d.base); setSel(d.orig ?? []) }
    } else if (d.kind === 'move' || d.kind === 'resize' || d.kind === 'rotate') {
      if (elsRef.current !== d.snap) { past.current.push(d.snap); future.current = [] }
    }
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    // pointer capture makes the browser aim the double click at the stage, not at the canvas, so test "not on a panel" instead
    if ((e.target as HTMLElement).closest('.panel, .palette, .ai-fab, textarea, input, select, button') || toolRef.current !== 'select') return
    const p = toWorld(e)
    // an empty rectangle/ellipse/diamond only "hits" on its outline, but a double click inside it means its caption
    const inside = [...elsRef.current].reverse().find((el) => {
      if (el.locked || !LABELED.includes(el.type)) return false
      const b = bbox(el)
      return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h
    })
    const hit = hitAt(p.x, p.y) ?? inside ?? null
    if (hit && (hit.type === 'text' || LABELED.includes(hit.type))) { setSel([hit.id]); openTextEditor(hit.x, hit.y, hit) }
    else if (!hit) openTextEditor(p.x, p.y)
  }

  const applyStyle = (patch: Partial<Style>, key?: string) => {
    setStyle((st) => ({ ...st, ...patch }))
    const ids = selRef.current
    if (ids.length) commit(elsRef.current.map((e) => (ids.includes(e.id) ? { ...e, ...patch } : e)), key)
  }

  const applyFont = (id: string) => {
    setFont(id)
    const ids = selRef.current
    const texts = elsRef.current.filter((e) => ids.includes(e.id) && e.type === 'text')
    if (texts.length) {
      commit(elsRef.current.map((e) => (ids.includes(e.id) && e.type === 'text' ? { ...e, fontFamily: id, ...measureText(e.text ?? '', e.fontSize ?? 20, id) } : e)))
    }
  }

  const applyFontSize = (v: number) => {
    setFontSize(v)
    const ids = selRef.current
    const hit = elsRef.current.filter((e) => ids.includes(e.id) && (e.type === 'text' || LABELED.includes(e.type)))
    if (!hit.length) return
    commit(elsRef.current.map((e) => {
      if (!ids.includes(e.id)) return e
      if (e.type === 'text') return { ...e, fontSize: v, ...measureText(e.text ?? '', v, e.fontFamily) }
      return LABELED.includes(e.type) ? { ...e, fontSize: v } : e
    }))
  }

  const applyAlign = (patch: { align?: El['align']; valign?: El['valign'] }) => {
    const ids = selRef.current
    commit(elsRef.current.map((e) => (ids.includes(e.id) && (e.type === 'text' || SHAPES_WITH_CAPTION.includes(e.type)) ? { ...e, ...patch } : e)))
  }

  const textStart = useRef<El[] | null>(null)
  const setTextLive = (id: string, v: string) => {
    if (!textStart.current) textStart.current = elsRef.current
    setEls((cur) => rebind(cur.map((e) => {
      if (e.id !== id) return e
      return e.type === 'text' ? { ...e, text: v, ...measureText(v, e.fontSize ?? 20, e.fontFamily) } : { ...e, text: v || undefined }
    })))
  }
  const endText = (id: string) => {
    const start = textStart.current
    textStart.current = null
    if (!start || elsRef.current === start) return
    past.current.push(start)
    future.current = []
    const el = elsRef.current.find((e) => e.id === id)
    if (el?.type === 'text' && !(el.text ?? '').trim()) { setEls(elsRef.current.filter((e) => e.id !== id)); setSel([]) }
  }
  const editSelected = () => {
    const only = elsRef.current.filter((x) => selRef.current.includes(x.id))
    if (only.length !== 1 || (only[0].type !== 'text' && !LABELED.includes(only[0].type))) return false
    openTextEditor(only[0].x, only[0].y, only[0])
    return true
  }

  const setDescription = (id: string, v: string) => {
    commit(elsRef.current.map((e) => (e.id === id ? { ...e, description: v.trim() ? v : undefined } : e)))
  }

  const setAngleDeg = (deg: number) => {
    const a = ((((deg % 360) + 360) % 360) * Math.PI) / 180
    const ids = selRef.current
    commit(elsRef.current.map((e) => (ids.includes(e.id) && canRotate(e) ? { ...e, angle: a } : e)), 'angle')
  }

  const reorder = (mode: 'back' | 'backward' | 'forward' | 'front') => {
    const ids = selRef.current
    if (!ids.length) return
    const list = elsRef.current
    const on = (e: El) => ids.includes(e.id)
    let next = [...list]
    if (mode === 'back') next = [...list.filter(on), ...list.filter((e) => !on(e))]
    else if (mode === 'front') next = [...list.filter((e) => !on(e)), ...list.filter(on)]
    else if (mode === 'forward') {
      for (let i = next.length - 2; i >= 0; i--) if (on(next[i]) && !on(next[i + 1])) [next[i], next[i + 1]] = [next[i + 1], next[i]]
    } else {
      for (let i = 1; i < next.length; i++) if (on(next[i]) && !on(next[i - 1])) [next[i], next[i - 1]] = [next[i - 1], next[i]]
    }
    commit(next)
  }

  const duplicateSel = () => {
    const copies = elsRef.current
      .filter((x) => selRef.current.includes(x.id))
      .map((x): El => ({ ...x, id: crypto.randomUUID(), x: x.x + 16, y: x.y + 16, seed: Math.floor(Math.random() * 2 ** 31) }))
    if (copies.length) { commit([...elsRef.current, ...copies]); setSel(copies.map((c) => c.id)) }
  }
  const groupSel = () => {
    const ids = selRef.current
    if (ids.length < 2) return
    const gid = crypto.randomUUID()
    commit(elsRef.current.map((x) => (ids.includes(x.id) ? { ...x, groupId: gid } : x)))
  }
  const ungroupSel = () => {
    const ids = selRef.current
    commit(elsRef.current.map((x) => (ids.includes(x.id) ? { ...x, groupId: undefined } : x)))
  }
  const deleteSel = () => {
    if (selRef.current.length) { commit(elsRef.current.filter((x) => !selRef.current.includes(x.id))); setSel([]) }
  }

  // ---------- actions of the right-click menu (also on the keyboard)
  const copySel = () => { if (selRef.current.length) navigator.clipboard?.writeText(copyPayload()).catch(() => { /* clipboard blocked */ }) }
  const cutSel = () => { copySel(); deleteSel() }
  const pasteClip = async () => {
    try {
      for (const it of await navigator.clipboard.read()) {
        const t = it.types.find((x) => x.startsWith('image/'))
        if (t) { addImageFile(await it.getType(t)); return }
      }
    } catch { /* reading images not allowed: try text */ }
    try { const txt = await navigator.clipboard.readText(); if (txt) pasteText(txt) } catch { /* clipboard blocked */ }
  }
  const picks = () => elsRef.current.filter((x) => selRef.current.includes(x.id))
  const copyPng = async () => {
    const blob = await renderPNG(picks())
    if (!blob) return
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]) } catch { /* clipboard blocked */ }
  }
  const copySvg = () => {
    const out = svgString(picks())
    if (out) navigator.clipboard?.writeText(out).catch(() => { /* clipboard blocked */ })
  }
  const copyStyles = () => {
    const e = picks()[0]
    if (!e) return
    styleClip.current = { stroke: e.stroke, fill: e.fill, strokeWidth: e.strokeWidth, roughness: e.roughness, fillStyle: e.fillStyle, opacity: e.opacity, rounded: e.rounded, fontFamily: e.fontFamily }
  }
  const pasteStyles = () => {
    const s = styleClip.current
    const ids = selRef.current
    if (!s || !ids.length) return
    commit(elsRef.current.map((e) => {
      if (!ids.includes(e.id)) return e
      const n: El = { ...e, stroke: s.stroke!, strokeWidth: s.strokeWidth!, roughness: s.roughness!, fillStyle: s.fillStyle, opacity: s.opacity }
      if (e.type !== 'text' && e.type !== 'image') n.fill = s.fill!
      if (e.type === 'rectangle') n.rounded = s.rounded
      if (s.fontFamily && (e.type === 'text' || LABELED.includes(e.type))) {
        n.fontFamily = s.fontFamily
        if (e.type === 'text') Object.assign(n, measureText(e.text ?? '', e.fontSize ?? 20, s.fontFamily))
      }
      return n
    }))
  }
  // mirror the selection around the centre of its box
  const flipSel = (dir: 'h' | 'v') => {
    const ids = selRef.current
    const b = boundsOf(picks())
    if (!b) return
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2
    const next = elsRef.current.map((e): El => {
      if (!ids.includes(e.id)) return e
      if (e.type === 'line' || e.type === 'arrow') {
        return dir === 'h' ? { ...e, x: 2 * cx - e.x, w: -e.w } : { ...e, y: 2 * cy - e.y, h: -e.h }
      }
      let out: El = e
      if ((e.type === 'freedraw' || e.type === 'connector') && e.points) {
        const k = dir === 'h' ? 0 : 1
        const lo = Math.min(...e.points.map((q) => q[k])), hi = Math.max(...e.points.map((q) => q[k]))
        const pts = e.points.map((q): [number, number] => (dir === 'h' ? [lo + hi - q[0], q[1]] : [q[0], lo + hi - q[1]]))
        const centre = (dir === 'h' ? e.x : e.y) + (lo + hi) / 2
        const mirrored = 2 * (dir === 'h' ? cx : cy) - centre
        out = dir === 'h' ? { ...e, points: pts, x: mirrored - (lo + hi) / 2 } : { ...e, points: pts, y: mirrored - (lo + hi) / 2 }
      } else {
        const bb = bbox(e)
        out = dir === 'h' ? { ...e, x: 2 * cx - (bb.x + bb.w / 2) - bb.w / 2, w: bb.w, h: bb.h, y: bb.y } : { ...e, y: 2 * cy - (bb.y + bb.h / 2) - bb.h / 2, w: bb.w, h: bb.h, x: bb.x }
      }
      if (e.type === 'icon' || e.type === 'image') out = dir === 'h' ? { ...out, flipX: !e.flipX } : { ...out, flipY: !e.flipY }
      if (e.angle && e.type !== 'text') out = { ...out, angle: -e.angle }
      return out
    })
    commit(detachMoved(next, ids))
  }
  const toggleLock = () => {
    const ids = selRef.current
    if (!ids.length) return
    commit(elsRef.current.map((e) => (ids.includes(e.id) ? { ...e, locked: true } : e)))
    setSel([])
  }
  const unlockAll = () => commit(elsRef.current.map((e) => (e.locked ? { ...e, locked: undefined } : e)))

  const onContextMenu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).tagName !== 'CANVAS') return
    e.preventDefault()
    if (editRef.current) return
    const p = toWorld(e)
    setPaletteOpen(false)
    if (toolRef.current !== 'select') setTool('select')
    let lockedId: string | null = null
    if (!selInside(p.x, p.y)) {
      const hit = hitAt(p.x, p.y)
      if (hit) { select(hit); const g = withGroups([hit.id]); if (g.length > 1) setSel(g) } else {
        setSel([])
        const tol = 6 / viewRef.current.zoom
        lockedId = [...elsRef.current].reverse().find((el) => el.locked && hitTest(el, p.x, p.y, tol))?.id ?? null
      }
    }
    setMenuLocked(lockedId)
    setMenu({ x: p.sx, y: p.sy })
  }

  // which sections of the properties panel make sense for what is selected (or for the tool in hand)
  const picked = els.filter((e) => sel.includes(e.id))
  const kinds: string[] = picked.length ? picked.map((e) => e.type) : DRAW_TOOLS.includes(tool) ? [tool === 'pen' ? 'freedraw' : tool] : []
  const has = (...t: string[]) => kinds.some((k) => t.includes(k))
  const one = picked.length === 1 ? picked[0] : null
  const showProps = kinds.length > 0
  const showWidth = has('rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'connector', 'freedraw', 'icon')
  const showFill = has('rectangle', 'diamond', 'ellipse', 'icon')
  const showHatch = has('rectangle', 'diamond', 'ellipse') // icons are always filled solid
  const showRough = has('rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'connector', 'icon')
  const showEdges = has('rectangle')
  const showText = has('text', 'rectangle', 'ellipse', 'diamond', 'icon')
  const showRotate = !!one && canRotate(one)
  const alignable = picked.filter((e) => e.type === 'text' || SHAPES_WITH_CAPTION.includes(e.type))
  const showAlign = alignable.length > 0
  const showValign = alignable.some((e) => e.type !== 'text')
  const curAlign = alignable[0]?.align ?? (alignable[0]?.type === 'text' ? 'left' : 'center')
  const curValign = alignable.find((e) => e.type !== 'text')?.valign ?? 'middle'
  const roughOn = ROUGH.reduce((best, r) => (Math.abs(r.v - style.roughness) < Math.abs(best.v - style.roughness) ? r : best)).v
  const NOTE_W = 300
  const sameGroup = picked.length > 1 && picked.every((e) => e.groupId && e.groupId === picked[0].groupId)
  const items: MenuItem[] = picked.length
    ? [
        { label: 'Recortar', key: 'Ctrl+X', run: cutSel },
        { label: 'Copiar', key: 'Ctrl+C', run: copySel },
        { label: 'Colar', key: 'Ctrl+V', run: pasteClip },
        'sep',
        { label: 'Copiar como PNG', key: 'Shift+Alt+C', run: copyPng },
        { label: 'Copiar como SVG', run: copySvg },
        'sep',
        { label: 'Copiar estilos', key: 'Ctrl+Alt+C', run: copyStyles },
        { label: 'Colar estilos', key: 'Ctrl+Alt+V', run: pasteStyles, disabled: !styleClip.current },
        'sep',
        sameGroup
          ? { label: 'Desagrupar', key: 'Ctrl+Shift+G', run: ungroupSel }
          : { label: 'Agrupar', key: 'Ctrl+G', run: groupSel, disabled: picked.length < 2 },
        'sep',
        { label: 'Para trás', key: 'Ctrl+[', run: () => reorder('backward') },
        { label: 'Para frente', key: 'Ctrl+]', run: () => reorder('forward') },
        { label: 'Para o fundo', key: 'Ctrl+Shift+[', run: () => reorder('back') },
        { label: 'Para o topo', key: 'Ctrl+Shift+]', run: () => reorder('front') },
        'sep',
        { label: 'Inverter na horizontal', key: 'Shift+H', run: () => flipSel('h') },
        { label: 'Inverter na vertical', key: 'Shift+V', run: () => flipSel('v') },
        'sep',
        { label: 'Duplicar', key: 'Ctrl+D', run: duplicateSel },
        { label: 'Bloquear', key: 'Ctrl+Shift+L', run: toggleLock },
        'sep',
        { label: 'Apagar', key: 'Delete', run: deleteSel, danger: true },
      ]
    : [
        ...(menuLocked ? [{ label: 'Desbloquear este elemento', run: () => commit(elsRef.current.map((x) => (x.id === menuLocked ? { ...x, locked: undefined } : x))) } as MenuItem, 'sep' as const] : []),
        { label: 'Colar', key: 'Ctrl+V', run: pasteClip },
        { label: 'Selecionar tudo', key: 'Ctrl+A', run: () => setSel(elsRef.current.filter((x) => !x.locked).map((x) => x.id)) },
        ...(els.some((e) => e.locked) ? [{ label: 'Desbloquear tudo', run: unlockAll }] : []),
      ]
  const menuH = items.reduce((h, i) => h + (i === 'sep' ? 9 : 31), 12)
  const menuStyle = menu ? { left: Math.max(8, Math.min(menu.x, size.w - 248)), top: Math.max(8, Math.min(menu.y, size.h - menuH - 8)) } : undefined

  const chat = chats.current.get(currentId)
  const labelOfEl = (e: El) => (e.text ?? e.cap ?? '').replace(/\s+/g, ' ').trim()
  const pieceLabels: Record<string, string> = {}
  for (const e of els) if (e.nid && !e.aux) pieceLabels[e.nid] = labelOfEl(e) || e.nid
  // what the person has selected, in a form the guide can explain
  let pick: Pick | null = null
  if (chat && sel.length === 1) {
    const e = els.find((x) => x.id === sel[0])
    if (e && !e.aux) {
      if (e.nid && pieceLabels[e.nid]) pick = { ids: [e.nid], label: pieceLabels[e.nid], question: e.frame ? `Explique o bloco «${pieceLabels[e.nid]}»: o que reúne e como as peças dele trabalham juntas.` : `Explique a peça «${pieceLabels[e.nid]}»: para que serve, como funciona por dentro, com quem conversa e o que quebra sem ela.` }
      else if (e.from && e.to) {
        const a = els.find((x) => x.id === e.from), b = els.find((x) => x.id === e.to)
        if (a?.nid && b?.nid) pick = { ids: [a.nid, b.nid], label: `${pieceLabels[a.nid]} → ${pieceLabels[b.nid]}`, question: `Explique a conexão de «${pieceLabels[a.nid]}» para «${pieceLabels[b.nid]}»${e.cap ? ` (${e.cap})` : ''}: o que passa por ela, quem inicia e como funciona.` }
      }
    }
  }
  const flow = flowOf(els, sel, tool === 'select' && !editing)
  const lit = [...(focusIds.length ? piecesOf(els, focusIds) : []), ...(flow ? flowEnds(els, flow) : [])]
  const focusEls = lit.filter((e, i) => lit.findIndex((x) => x.id === e.id) === i)
  const noteEl = openNote && (tool === 'select' || tool === 'laser') && !editing ? els.find((e) => e.id === openNote && e.description) ?? null : null
  let noteStyle: React.CSSProperties | undefined
  if (noteEl) {
    const nb = boundsOf([noteEl])!
    const right = (nb.x + nb.w) * view.zoom + view.x + 16
    const left = right + NOTE_W > size.w - 12 ? Math.max(12, nb.x * view.zoom + view.x - 16 - NOTE_W) : right
    const top = Math.min(Math.max(70, nb.y * view.zoom + view.y), Math.max(70, size.h - 200))
    noteStyle = { left, top, width: NOTE_W }
  }
  const angleDeg = Math.round((((one?.angle ?? 0) * 180) / Math.PI) % 360)

  const openFile = (file: File) => {
    file.text().then((txt) => {
      try {
        const data = JSON.parse(txt)
        if (isSceneType(data?.type) && Array.isArray(data.elements)) {
          newDrawing(data.elements as El[], file.name.replace(/\.[^.]+$/, '') || 'Desenho')
        } else alert('Arquivo inválido.')
      } catch { alert('Arquivo inválido.') }
    })
  }

  opRef.current = applyOp
  act.current = { saveFile: () => saveJSON(elsRef.current, currentName), openFileDialog: () => fileRef.current?.click(), editSelected, copyPayload, addImageFile, pasteText, copyStyles, pasteStyles, copyPng, reorder, toggleLock, flipSel }
  const cursor = grabbing ? 'grabbing' : (onMarker && (tool === 'select' || tool === 'laser')) || (onLock && tool === 'select') ? 'pointer' : tool === 'hand' || spaceHeld ? 'grab' : tool === 'select' ? (hover ? 'move' : 'default') : tool === 'text' ? 'text' : 'crosshair'
  const editView = editing && {
    left: (editing.center?.x ?? editing.x) * view.zoom + view.x,
    top: (editing.center?.y ?? editing.y) * view.zoom + view.y,
    fontSize: editing.fontSize * view.zoom,
    centered: !!editing.center,
  }
  const lines = editing ? editing.value.split('\n') : []

  return (
    <div
      className={'stage' + (sidebar ? ' sb-open' : '')}
      ref={stageRef}
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onMouseDown={(e) => { if ((e.target as HTMLElement).tagName === 'CANVAS') e.preventDefault() }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <canvas ref={canvasRef} />
      <canvas ref={laserCanvas} className="laser" />
      {flow && <FlowDots el={flow} view={view} />}
      {focusEls.length > 0 && <FocusGlow els={focusEls} view={view} />}

      <div className="panel menu">
        <button className={'sb-toggle' + (sidebar ? ' on' : '')} title={sidebar ? 'Minimizar desenhos' : 'Mostrar desenhos'} onClick={() => setSidebar((v) => !v)}>
          <svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM9 5v14" /></svg>
        </button>
        <button className={fileMenu ? 'on' : ''} title="Menu" onClick={() => setFileMenu((o) => !o)}>☰</button>
        <span className="brand"><img className="logo" src="/favicon.svg" alt="" />Rabiscadraw</span>
        {!sidebar && currentName && <span className="doc-name">{currentName}</span>}
        <input ref={fileRef} type="file" hidden accept=".rabiscadraw,.rabiscalidraw,.json" onChange={(e) => { const f = e.target.files?.[0]; if (f) openFile(f); e.target.value = '' }} />
      </div>
      {fileMenu && (
        <div className="ctx filemenu">
          <button onClick={() => { setFileMenu(false); setSidebar((v) => !v) }}><span>{sidebar ? 'Ocultar desenhos' : 'Mostrar desenhos'}</span></button>
          <button onClick={() => { setFileMenu(false); setDark((d) => !d) }}><span>{dark ? 'Tema claro' : 'Tema escuro'}</span></button>
          <hr />
          <button onClick={() => { setFileMenu(false); fileRef.current?.click() }}><span>Abrir arquivo…</span><kbd>Ctrl+O</kbd></button>
          <button onClick={() => { setFileMenu(false); saveJSON(els, currentName) }}><span>Salvar como arquivo…</span><kbd>Ctrl+S</kbd></button>
          <hr />
          <button onClick={() => { setFileMenu(false); exportPNG(els, currentName) }}><span>Exportar PNG</span></button>
          <button onClick={() => { setFileMenu(false); exportSVG(els, currentName) }}><span>Exportar SVG</span></button>
          <hr />
          <button className="danger" onClick={() => { setFileMenu(false); if (els.length) { commit([]); setSel([]) } }}><span>Limpar tudo</span><kbd>Ctrl+Z desfaz</kbd></button>
        </div>
      )}

      <div className="panel toolbar">
        {TOOLS.map((t, i) => (
          <span key={t.id} style={{ display: 'contents' }}>
            {i === 2 && <div className="sep" />}
            <button className={'tool' + (tool === t.id ? ' active' : '')} title={`${t.label} (${t.key})`} onClick={() => { setTool(t.id); if (t.id !== 'select') setSel([]) }}>
              <svg viewBox="0 0 24 24"><path d={t.icon} /></svg>
              <kbd>{i + 1}</kbd>
            </button>
          </span>
        ))}
        <div className="sep" />
        <button className={'tool' + (tool === 'icon' || paletteOpen ? ' active' : '')} title="Componentes de arquitetura (banco, load balancer, gateways...)" onClick={() => setPaletteOpen((o) => !o)}>
          <svg viewBox="0 0 24 24"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM16.5 13v7M13 16.5h7" /></svg>
        </button>
        {paletteOpen && (
          <div className="palette">
            <h4>Componentes de arquitetura</h4>
            <div className="pal-grid">
              {ICONS.map((d) => (
                <button
                  key={d.id}
                  className={'pal-item' + (tool === 'icon' && iconKind === d.id ? ' on' : '')}
                  title={d.hint}
                  onClick={() => { setIconKind(d.id); setTool('icon'); setSel([]); setPaletteOpen(false) }}
                >
                  <svg viewBox="0 0 100 100">{d.paths.map((p, k) => <path key={k} d={p} />)}</svg>
                  <span>{d.label}</span>
                </button>
              ))}
            </div>
            <p className="pal-note">Clique num componente e depois no quadro. A IA e os agentes MCP usam os mesmos.</p>
          </div>
        )}
      </div>

      {showProps && (
        <div className="panel props" ref={propsDrag.ref} style={{ transform: `translate(${propsDrag.off.x}px, ${propsDrag.off.y}px)` }}>
          <div className="grip" title="Arraste para mover" {...propsDrag.handle} />
          {picked.length > 0 && (
            <Sec t="Ações">
              <div className="row">
                <button title="Duplicar (Ctrl+D)" className="ib" onClick={duplicateSel}><svg viewBox="0 0 24 24"><path d="M9 9h10v10H9zM5 15V5h10" /></svg></button>
                <button title="Apagar (Delete)" className="ib" onClick={deleteSel}><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" /></svg></button>
                <button title="Agrupar (Ctrl+G)" className="ib" disabled={picked.length < 2} onClick={groupSel}><svg viewBox="0 0 24 24"><path d="M4 4h10v10H4zM10 10h10v10H10z" /></svg></button>
                <button title="Desagrupar (Ctrl+Shift+G)" className="ib" disabled={!picked.some((e) => e.groupId)} onClick={ungroupSel}><svg viewBox="0 0 24 24"><path d="M4 4h7v7H4zM13 13h7v7h-7z" /></svg></button>
              </div>
              <div className="row gap">
                <button title="Para o fundo" className="ib" onClick={() => reorder('back')}><svg viewBox="0 0 24 24"><path d="M6 5h12M12 9v10M8 15l4 4 4-4" /></svg></button>
                <button title="Para trás" className="ib" onClick={() => reorder('backward')}><svg viewBox="0 0 24 24"><path d="M12 6v12M7 13l5 5 5-5" /></svg></button>
                <button title="Para frente" className="ib" onClick={() => reorder('forward')}><svg viewBox="0 0 24 24"><path d="M12 18V6M7 11l5-5 5 5" /></svg></button>
                <button title="Para o topo" className="ib" onClick={() => reorder('front')}><svg viewBox="0 0 24 24"><path d="M6 19h12M12 15V5M8 9l4-4 4 4" /></svg></button>
              </div>
            </Sec>
          )}
          {one && (one.type === 'text' || LABELED.includes(one.type)) && (
            <Sec t="Conteúdo">
              <TextField key={one.id} value={one.text ?? ''} onLive={(v) => setTextLive(one.id, v)} onDone={() => endText(one.id)} />
            </Sec>
          )}
          {one && (
            <Sec t="Explicação">
              <NoteField key={one.id} value={one.description ?? ''} onSave={(v) => setDescription(one.id, v)} />
            </Sec>
          )}
          <Sec t={has('text') && !showWidth ? 'Cor' : 'Traço'}>
            <ColorField value={style.stroke} presets={STROKES} onPick={(c) => applyStyle({ stroke: c })} />
          </Sec>
          {showFill && (
            <Sec t="Fundo">
              <ColorField value={style.fill} presets={FILLS} onPick={(c) => applyStyle({ fill: c })} />
              {style.fill !== 'transparent' && showHatch && (
                <div className="row gap">
                  {(['hachure', 'solid'] as const).map((f) => <button key={f} className={'opt' + ((style.fillStyle ?? 'hachure') === f ? ' on' : '')} onClick={() => applyStyle({ fillStyle: f })}>{f === 'hachure' ? 'Riscado' : 'Sólido'}</button>)}
                </div>
              )}
            </Sec>
          )}
          {showWidth && (
            <Sec t="Espessura">
              <div className="row">
                {WIDTHS.map((w) => (
                  <button key={w.v} title={w.label} className={'ib' + (style.strokeWidth === w.v ? ' on' : '')} onClick={() => applyStyle({ strokeWidth: w.v })}>
                    <svg viewBox="0 0 24 24"><path d="M4 12h16" strokeWidth={w.v + 0.6} /></svg>
                  </button>
                ))}
              </div>
            </Sec>
          )}
          {showRough && (
            <Sec t="Traço do rabisco">
              <div className="row">
                {ROUGH.map((r) => (
                  <button key={r.v} title={r.label} className={'ib' + (roughOn === r.v ? ' on' : '')} onClick={() => applyStyle({ roughness: r.v })}>
                    <svg viewBox="0 0 24 24"><path d={r.d} /></svg>
                  </button>
                ))}
              </div>
            </Sec>
          )}
          {showEdges && (
            <Sec t="Cantos">
              <div className="row">
                <button title="Retos" className={'ib' + (!style.rounded ? ' on' : '')} onClick={() => applyStyle({ rounded: false })}><svg viewBox="0 0 24 24"><path d="M5 5h14v14H5z" /></svg></button>
                <button title="Arredondados" className={'ib' + (style.rounded ? ' on' : '')} onClick={() => applyStyle({ rounded: true })}><svg viewBox="0 0 24 24"><path d="M9 5h6a4 4 0 014 4v6a4 4 0 01-4 4H9a4 4 0 01-4-4V9a4 4 0 014-4z" /></svg></button>
              </div>
            </Sec>
          )}
          {showText && (
            <Sec t="Texto">
              <div className="row">
                {FONTS.map((f) => <button key={f.id} title={f.label} className={'ib txt' + (font === f.id ? ' on' : '')} style={{ fontFamily: f.css, fontWeight: f.weight }} onClick={() => applyFont(f.id)}>Aa</button>)}
              </div>
              <div className="row gap">
                {FONT_SIZES.map((f) => <button key={f.k} className={'ib txt' + (fontSize === f.v ? ' on' : '')} onClick={() => applyFontSize(f.v)}>{f.k}</button>)}
              </div>
            </Sec>
          )}
          {showAlign && (
            <Sec t="Alinhamento">
              <div className="row">
                {(['left', 'center', 'right'] as const).map((a) => (
                  <button key={a} title={{ left: 'Esquerda', center: 'Centro', right: 'Direita' }[a]} className={'ib' + (curAlign === a ? ' on' : '')} onClick={() => applyAlign({ align: a })}>
                    <svg viewBox="0 0 24 24"><path d={H_ICON[a]} /></svg>
                  </button>
                ))}
              </div>
              {showValign && (
                <div className="row gap">
                  {(['top', 'middle', 'bottom'] as const).map((a) => (
                    <button key={a} title={{ top: 'Topo', middle: 'Meio', bottom: 'Base' }[a]} className={'ib' + (curValign === a ? ' on' : '')} onClick={() => applyAlign({ valign: a })}>
                      <svg viewBox="0 0 24 24"><path d={V_ICON[a]} /></svg>
                    </button>
                  ))}
                </div>
              )}
            </Sec>
          )}
          <Sec t="Opacidade">
            <input className="range" type="range" min={10} max={100} step={10} value={style.opacity ?? 100} onChange={(e) => applyStyle({ opacity: Number(e.target.value) }, 'opacity')} />
          </Sec>
          {showRotate && (
            <Sec t="Rotação">
              <div className="row center">
                <button title="Girar 15° para a esquerda" className="ib" onClick={() => setAngleDeg(angleDeg - 15)}><svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 108-8H8M8 1l-3 3 3 3" /></svg></button>
                <label className="deg"><input type="number" value={angleDeg} onChange={(e) => setAngleDeg(Number(e.target.value) || 0)} />°</label>
                <button title="Girar 15° para a direita" className="ib" onClick={() => setAngleDeg(angleDeg + 15)}><svg viewBox="0 0 24 24" style={{ transform: 'scaleX(-1)' }}><path d="M4 12a8 8 0 108-8H8M8 1l-3 3 3 3" /></svg></button>
              </div>
            </Sec>
          )}
        </div>
      )}

      <div className="panel zoom">
        <button onClick={() => zoomBy(1 / 1.2)}>−</button>
        <span>{Math.round(view.zoom * 100)}%</span>
        <button onClick={() => zoomBy(1.2)}>+</button>
        <button title="Resetar zoom" onClick={() => setView({ x: 0, y: 0, zoom: 1 })}>⟲</button>
        <button title="Desfazer (Ctrl+Z)" onClick={undo}>↶</button>
        <button title="Refazer (Ctrl+Shift+Z)" onClick={redo}>↷</button>
      </div>

      <div className="hint">Ctrl+scroll = zoom · Espaço+arrastar = mover tela · Duplo clique = texto</div>

      <button className={'ai-fab' + (aiOpen ? ' on' : '')} title="IA e agentes (conectar Claude, Codex...)" onClick={() => { setAiOpen((o) => !o); setChatOpen(false) }}>
        <svg viewBox="0 0 24 24"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></svg>
      </button>
      {chat && (
        <button className={'ai-fab chat-fab' + (chatOpen ? ' on' : '')} title="Guia da arquitetura: pergunte sobre cada peça" onClick={() => { setChatOpen((o) => !o); setAiOpen(false) }}>
          <svg viewBox="0 0 24 24"><path d="M4 4h16v12H9l-5 4z" /></svg>
          {chatBusy.includes(currentId) && <i className="chat-dot" />}
        </button>
      )}
      {chat && chatOpen && (
        <ChatPanel
          chat={chat}
          busy={chatBusy.includes(currentId)}
          status={chatStatus[currentId]}
          labels={pieceLabels}
          pick={pick}
          onAsk={askGuide}
          onFocus={pulse}
          onClose={() => { setChatOpen(false); setFocusIds([]) }}
        />
      )}
      {aiOpen && (
        <div className="panel ai-panel">
          <div className="ai-head">
            <strong>IA e agentes</strong>
            <button onClick={() => setAiOpen(false)} title="Fechar">✕</button>
          </div>

          <div className="ai-block">
            <h4>Conecte o seu Claude, Codex ou outro agente (MCP)</h4>
            <p>Eles desenham neste quadro, na sua conta de IA, enquanto esta página estiver aberta.</p>
            <div className="mcp-url">
              <code>{mcpUrl}</code>
              <button onClick={() => copyText(mcpUrl)}>{copied === mcpUrl ? 'Copiado' : 'Copiar'}</button>
            </div>
            <details>
              <summary>Claude Code</summary>
              <div className="mcp-url">
                <code>{claudeCmd}</code>
                <button onClick={() => copyText(claudeCmd)}>{copied === claudeCmd ? 'Copiado' : 'Copiar'}</button>
              </div>
            </details>
            <details>
              <summary>Codex</summary>
              <div className="mcp-url">
                <code>{codexCfg}</code>
                <button onClick={() => copyText(codexCfg)}>{copied === codexCfg ? 'Copiado' : 'Copiar'}</button>
              </div>
              <p>Em <code>~/.codex/config.toml</code>. Se a sua versão não aceitar <code>url</code>, use <code>npx -y mcp-remote {'<endereço>'}</code>.</p>
            </details>
            <details>
              <summary>Outros clientes</summary>
              <p>Qualquer cliente MCP com HTTP (streamable HTTP) funciona com o endereço acima.</p>
            </details>
            <p className="ai-warn">Este endereço é secreto: quem o tiver pode desenhar no seu quadro. <button className="link" onClick={rotateToken}>Gerar um endereço novo</button></p>
          </div>

          {aiInfo?.configured && (
            <div className="ai-block">
              <h4>Analisar um repositório</h4>
              <p>Arraste uma pasta de projeto para qualquer lugar da tela, ou escolha uma. A IA lê um resumo e desenha a arquitetura.</p>
              <input ref={repoInput} type="file" hidden {...({ webkitdirectory: '', directory: '' } as object)} onChange={(e) => { const f = e.target.files; if (f?.length) openRepo(collectInput(f)); e.target.value = '' }} />
              <button className="ai-go" onClick={() => repoInput.current?.click()}>Escolher pasta…</button>
            </div>
          )}

          {aiInfo?.configured ? (
            <div className="ai-block">
              <h4>Ou desenhe aqui com a IA do servidor</h4>
              <textarea
                className="ai-text"
                rows={3}
                value={aiPrompt}
                placeholder="Ex.: arquitetura de um e-commerce com app web, API gateway, serviços de pedidos e pagamentos, uma fila e um banco de dados"
                onChange={(e) => setAiPrompt(e.target.value)}
                onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); askAI() } }}
              />
              <div className="ai-row">
                <select value={aiTarget} onChange={(e) => setAiTarget(e.target.value as 'current' | 'new')}>
                  <option value="current">Adicionar ao desenho atual</option>
                  <option value="new">Em um desenho novo</option>
                </select>
                <button className="ai-go" disabled={aiBusy || !aiPrompt.trim()} onClick={askAI}>{aiBusy ? 'Desenhando…' : 'Desenhar'}</button>
              </div>
              {aiMsg && <p className="ai-msg">{aiMsg}</p>}
            </div>
          ) : (
            <p className="ai-msg">Este servidor não tem IA própria. Quem desenha é o agente que você conectar acima.</p>
          )}
        </div>
      )}

      {dropping && <div className="drop-veil"><div>Solte a pasta do projeto para analisar a arquitetura</div></div>}
      {repo && (
        <div className="repo-veil">
          <div className="panel repo-modal">
            <strong>Analisar “{repo.name}”</strong>
            <p>
              Escolha o que a IA pode ler. O que ficar desmarcado não sai do seu computador, nem o nome. Vão <b>{repo.sum.fileCount}</b> de {repo.all.length} arquivos,
              com o conteúdo de <b>{repo.sum.included.length}</b> deles e <b>{repo.sum.signals}</b> sinais de arquitetura extraídos (~{Math.round(repo.sum.text.length / 1000)} mil caracteres) para a IA{aiInfo?.model ? <> (<code>{aiInfo.model}</code>)</> : null}, via servidor.
            </p>
            <div className="repo-quick">
              <button className="link" onClick={() => pickAllRepo('all')}>Tudo</button>
              <button className="link" onClick={() => pickAllRepo('essential')}>Só o essencial</button>
              <button className="link" onClick={() => pickAllRepo('none')}>Nenhum</button>
            </div>
            <RepoTree
              paths={repo.all.map((i) => i.path)}
              sel={repo.sel}
              content={new Set(repo.sum.included.map((f) => f.path))}
              onToggle={(paths, on) => pickRepo(paths, on, paths.length === 1)}
            />
            <p className="repo-note">Sempre de fora: node_modules, .git, builds, binários, lockfiles e arquivos .env. Senhas, tokens e chaves óbvios viram [removido]. “conteúdo” = o texto do arquivo é enviado; “nome” = só o caminho aparece. Arquivos que você marca à mão têm prioridade no conteúdo.</p>
            <div className="repo-views" role="radiogroup" aria-label="O que desenhar">
              {([['both', 'Os dois'], ['architecture', 'System design'], ['sequence', 'Sequência (UML)']] as const).map(([v, label]) => (
                <button key={v} role="radio" aria-checked={repo.views === v} className={'opt' + (repo.views === v ? ' on' : '')} disabled={repo.busy} onClick={() => setRepo({ ...repo, views: v })}>{label}</button>
              ))}
            </div>
            <button role="switch" aria-checked={repo.deep} className={'opt' + (repo.deep ? ' on' : '')} disabled={repo.busy} onClick={() => setRepo({ ...repo, deep: !repo.deep })} title="Lê todos os arquivos permitidos, módulo por módulo, e desenha a partir dos resumos. Mais lento e usa mais chamadas da IA, mas nada fica de fora.">Análise profunda (resumo por módulo){repo.deep ? ': ligada' : ': desligada'}</button>
            <div className="ai-row">
              <span className="repo-where">Cada análise abre em desenhos novos, sem mexer nos seus.</span>
              <button className="ai-go" disabled={repo.busy || !repo.sel.size} onClick={analyseRepo}>{repo.busy ? 'Analisando…' : 'Analisar e desenhar'}</button>
            </div>
            {repo.busy && repo.prog && <p className="repo-where">{repo.prog}</p>}
            {repo.msg && <p className="ai-msg ai-warn">{repo.msg}</p>}
            <button className="link" disabled={repo.busy} onClick={() => setRepo(null)}>Cancelar</button>
          </div>
        </div>
      )}

      <aside className={'panel sidebar' + (sidebar ? '' : ' closed')} aria-hidden={!sidebar}>
          <div className="sb-head">
            <strong>Desenhos</strong>
            <div className="sb-tools">
              <button className="sb-new" onClick={() => newDrawing()}>+ Novo</button>
              <button className="sb-close" title="Minimizar desenhos" onClick={() => setSidebar(false)}>«</button>
            </div>
          </div>
          <div className="sb-list">
            {sortedMetas.map((m) => (
              <div key={m.id} className={'sb-item' + (m.id === currentId ? ' on' : '')} onClick={() => switchTo(m.id)}>
                {m.thumb ? <img src={m.thumb} alt="" /> : <div className="sb-empty" />}
                <div className="sb-info">
                  {renaming === m.id ? (
                    <input
                      autoFocus
                      defaultValue={m.name}
                      onClick={(e) => e.stopPropagation()}
                      onFocus={(e) => e.currentTarget.select()}
                      onBlur={(e) => renameDrawing(m.id, e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur()
                        if (e.key === 'Escape') { e.currentTarget.value = m.name; e.currentTarget.blur() }
                      }}
                    />
                  ) : (
                    <span className="sb-name" onDoubleClick={(e) => { e.stopPropagation(); setRenaming(m.id) }}>{m.name}</span>
                  )}
                  <small>{ago(m.updatedAt)}</small>
                </div>
                <div className="sb-actions">
                  <button title="Renomear" onClick={(e) => { e.stopPropagation(); setRenaming(m.id) }}>✎</button>
                  <button title="Duplicar" onClick={(e) => { e.stopPropagation(); duplicateDrawing(m.id) }}>⧉</button>
                  <button title="Apagar" onClick={(e) => { e.stopPropagation(); deleteDrawing(m.id) }}>🗑</button>
                </div>
              </div>
            ))}
          </div>
      </aside>

      {noteEl && noteStyle && <NoteCard key={noteEl.id} el={noteEl} style={noteStyle} onClose={() => setOpenNote(null)} />}

      {menu && menuStyle && (
        <div className="ctx" style={menuStyle} onContextMenu={(e) => e.preventDefault()}>
          {items.map((it, i) =>
            it === 'sep' ? <hr key={i} /> : (
              <button key={i} className={it.danger ? 'danger' : ''} disabled={it.disabled} onClick={() => { setMenu(null); it.run() }}>
                <span>{it.label}</span>
                {it.key && <kbd>{it.key}</kbd>}
              </button>
            ),
          )}
        </div>
      )}

      {editing && editView && (
        <textarea
          ref={taRef}
          className="edit"
          value={editing.value}
          rows={lines.length}
          cols={Math.max(2, ...lines.map((l) => l.length + 1))}
          style={{ left: editView.left, top: editView.top, fontSize: editView.fontSize, transform: editView.centered ? 'translate(-50%, -50%)' : undefined, textAlign: editView.centered ? 'center' : editing.align, color: editing.color, fontFamily: fontOf(editing.fontFamily).css, fontWeight: fontOf(editing.fontFamily).weight }}
          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
          onBlur={commitText}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); commitText() } }}
        />
      )}
    </div>
  )
}

const ago = (t: number) => {
  const sec = (Date.now() - t) / 1000
  if (sec < 60) return 'agora'
  if (sec < 3600) return `há ${Math.floor(sec / 60)} min`
  if (sec < 86400) return `há ${Math.floor(sec / 3600)} h`
  return new Date(t).toLocaleDateString('pt-BR')
}
