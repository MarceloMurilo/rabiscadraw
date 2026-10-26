import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import rough from 'roughjs'
import type { El, ShapeType, Style, Tool, View } from './types'
import { bbox, handlesOf, hitTest } from './geometry'
import type { Box } from './geometry'
import { loadScene, saveScene } from './storage'
import { FONTS, drawElement, exportPNG, exportSVG, fontOf, loadFonts, isSceneType, measureText, onImageLoad, saveJSON } from './render'

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
  | { kind: 'create'; id: string; x: number; y: number; shape: ShapeType; pts: [number, number][]; snap: El[] }
  | { kind: 'move'; ids: string[]; x: number; y: number; snap: El[] }
  | { kind: 'laser' }
  | { kind: 'marquee'; x: number; y: number; base: string[] }
  | { kind: 'resize'; id: string; handle: string; orig: El; snap: El[] }

interface Editing { id?: string; x: number; y: number; value: string; fontSize: number; fontFamily: string; color: string }

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
  if (shift && o.type !== 'freedraw' && o.type !== 'image') nw = nh = Math.max(nw, nh)
  if (o.type === 'image') nh = (nw * b.h) / Math.max(b.w, 1)
  const nx = px < fx ? fx - nw : fx, ny = py < fy ? fy - nh : fy
  const out: El = { ...o, x: nx, y: ny, w: nw, h: nh }
  if (o.type === 'freedraw') {
    const sx = nw / Math.max(b.w, 1), sy = nh / Math.max(b.h, 1)
    out.points = o.points!.map(([a, c]) => [a * sx, c * sy])
  }
  return out
}

export default function App() {
  const [els, setEls] = useState<El[]>([])
  const [tool, setTool] = useState<Tool>('select')
  const [sel, setSel] = useState<string[]>([])
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 })
  const [style, setStyle] = useState<Style>({ stroke: STROKES[0], fill: 'transparent', strokeWidth: 2, roughness: 1 })
  const [editing, setEditing] = useState<Editing | null>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [tick, setTick] = useState(0)
  const [font, setFont] = useState('excali')
  const [hover, setHover] = useState<string | null>(null)
  const [marquee, setMarquee] = useState<Box | null>(null)

  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const drag = useRef<Drag | null>(null)
  const past = useRef<El[][]>([])
  const future = useRef<El[][]>([])
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
  const toolRef = useRef(tool); toolRef.current = tool
  const selRef = useRef(sel); selRef.current = sel
  const editRef = useRef(editing); editRef.current = editing

  const commit = useCallback((next: El[]) => {
    past.current.push(elsRef.current)
    if (past.current.length > 200) past.current.shift()
    future.current = []
    setEls(next)
  }, [])

  const undo = useCallback(() => {
    const prev = past.current.pop()
    if (!prev) return
    future.current.push(elsRef.current)
    setEls(prev)
    setSel([])
  }, [])

  const redo = useCallback(() => {
    const next = future.current.pop()
    if (!next) return
    past.current.push(elsRef.current)
    setEls(next)
    setSel([])
  }, [])

  const select = (el: El | null) => {
    setSel(el ? [el.id] : [])
    if (el) setStyle({ stroke: el.stroke, fill: el.fill, strokeWidth: el.strokeWidth, roughness: el.roughness })
    if (el?.type === 'text') setFont(el.fontFamily ?? 'excali')
  }

  // persistence (IndexedDB)
  const loaded = useRef(false)
  useEffect(() => {
    // wait for the fonts so stored text is measured with the real glyph widths
    Promise.all([loadScene(), loadFonts()]).then(([scene]) => {
      if (scene.length) {
        setEls(scene.map((e) => (e.type === 'text' ? { ...e, ...measureText(e.text ?? '', e.fontSize ?? 20, e.fontFamily) } : e)))
      }
      loaded.current = true
      setTick((t) => t + 1)
    })
  }, [])
  useEffect(() => {
    if (!loaded.current) return
    const t = setTimeout(() => { saveScene(els).catch(() => { /* storage blocked */ }) }, 300)
    return () => clearTimeout(t)
  }, [els])

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
    for (const el of els) if (el.id !== editing?.id) drawElement(rc, ctx, el)

    const z = view.zoom
    const selEls = els.filter((e) => sel.includes(e.id) && e.id !== editing?.id)
    ctx.save()
    ctx.strokeStyle = '#6965db'
    ctx.fillStyle = '#fff'
    ctx.lineWidth = 1.5 / z
    if (selEls.length === 1) {
      const s = selEls[0]
      const hs = handlesOf(s, z)
      if (s.type !== 'line' && s.type !== 'arrow') {
        const b = bbox(s), p = 6 / z
        ctx.strokeRect(b.x - p, b.y - p, b.w + 2 * p, b.h + 2 * p)
        for (const h of hs) { ctx.fillRect(h.x - 4 / z, h.y - 4 / z, 8 / z, 8 / z); ctx.strokeRect(h.x - 4 / z, h.y - 4 / z, 8 / z, 8 / z) }
      } else {
        for (const h of hs) { ctx.beginPath(); ctx.arc(h.x, h.y, 5 / z, 0, Math.PI * 2); ctx.fill(); ctx.stroke() }
      }
    } else {
      ctx.setLineDash([6 / z, 4 / z])
      for (const s of selEls) { const b = bbox(s), p = 4 / z; ctx.strokeRect(b.x - p, b.y - p, b.w + 2 * p, b.h + 2 * p) }
    }
    const hov = tool === 'select' && hover && !sel.includes(hover) ? els.find((e) => e.id === hover) : undefined
    if (hov) {
      const b = bbox(hov), p = 4 / z
      ctx.setLineDash([])
      ctx.globalAlpha = 0.55
      ctx.strokeRect(b.x - p, b.y - p, b.w + 2 * p, b.h + 2 * p)
      ctx.globalAlpha = 1
    }
    if (marquee) {
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(105,101,219,.1)'
      ctx.fillRect(marquee.x, marquee.y, marquee.w, marquee.h)
      ctx.strokeRect(marquee.x, marquee.y, marquee.w, marquee.h)
    }
    ctx.restore()
  }, [els, view, sel, size, editing?.id, tick, hover, marquee, tool])

  useEffect(() => { onImageLoad(() => setTick((t) => t + 1)) }, [])

  // wheel: pan, ctrl+wheel: zoom at cursor
  useEffect(() => {
    const node = stageRef.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const v = viewRef.current
      if (e.ctrlKey || e.metaKey) {
        const r = node.getBoundingClientRect()
        const sx = e.clientX - r.left, sy = e.clientY - r.top
        const z = Math.min(8, Math.max(0.1, v.zoom * Math.exp(-e.deltaY * 0.01)))
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
    if (ed.id) {
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

  // clipboard: copy/cut/paste elements, paste images and plain text
  useEffect(() => {
    const inField = (e: Event) => (e.target as HTMLElement).tagName === 'TEXTAREA'
    const centre = () => {
      const n = stageRef.current!, v = viewRef.current
      return { x: (n.clientWidth / 2 - v.x) / v.zoom, y: (n.clientHeight / 2 - v.y) / v.zoom }
    }
    const onCopy = (e: ClipboardEvent, cut: boolean) => {
      if (inField(e)) return
      const picked = elsRef.current.filter((x) => selRef.current.includes(x.id))
      if (!picked.length) return
      e.preventDefault()
      e.clipboardData?.setData('text/plain', JSON.stringify({ type: 'rabiscadraw', elements: picked }))
      if (cut) { commit(elsRef.current.filter((x) => !selRef.current.includes(x.id))); setSel([]) }
    }
    const addImage = (file: File) => {
      const reader = new FileReader()
      reader.onload = () => {
        const src = reader.result as string
        const probe = new Image()
        probe.onload = () => {
          const k = Math.min(1, 400 / probe.naturalWidth)
          const w = probe.naturalWidth * k, h = probe.naturalHeight * k
          const c = centre()
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
    const onPaste = (e: ClipboardEvent) => {
      if (inField(e) || !e.clipboardData) return
      const file = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'))?.getAsFile()
      if (file) { e.preventDefault(); addImage(file); return }
      const txt = e.clipboardData.getData('text/plain')
      if (!txt) return
      e.preventDefault()
      try {
        const d = JSON.parse(txt)
        if (isSceneType(d?.type) && Array.isArray(d.elements)) {
          const copies: El[] = (d.elements as El[]).map((s) => ({ ...s, id: crypto.randomUUID(), x: s.x + 16, y: s.y + 16 }))
          commit([...elsRef.current, ...copies])
          setSel(copies.map((c) => c.id))
          return
        }
      } catch { /* not ours: paste as text */ }
      const m = measureText(txt, 20, fontRef.current), c = centre()
      const el: El = {
        id: crypto.randomUUID(), type: 'text', x: c.x - m.w / 2, y: c.y - m.h / 2, w: m.w, h: m.h,
        ...styleRef.current, fill: 'transparent', seed: 1, text: txt, fontSize: 20, fontFamily: fontRef.current,
      }
      commit([...elsRef.current, el])
      setSel([el.id])
    }
    const copy = (e: ClipboardEvent) => onCopy(e, false)
    const cut = (e: ClipboardEvent) => onCopy(e, true)
    window.addEventListener('copy', copy)
    window.addEventListener('cut', cut)
    window.addEventListener('paste', onPaste)
    return () => { window.removeEventListener('copy', copy); window.removeEventListener('cut', cut); window.removeEventListener('paste', onPaste) }
  }, [commit])

  // keyboard
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'TEXTAREA') return
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (e.code === 'Space') { space.current = true; e.preventDefault(); return }
      if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return }
      if (mod && k === 'y') { e.preventDefault(); redo(); return }
      if (mod && k === 'd') {
        e.preventDefault()
        const copies = elsRef.current
          .filter((x) => selRef.current.includes(x.id))
          .map((x): El => ({ ...x, id: crypto.randomUUID(), x: x.x + 16, y: x.y + 16, seed: Math.floor(Math.random() * 2 ** 31) }))
        if (copies.length) { commit([...elsRef.current, ...copies]); setSel(copies.map((c) => c.id)) }
        return
      }
      if (mod && k === 'a') { e.preventDefault(); setTool('select'); setSel(elsRef.current.map((x) => x.id)); return }
      if (mod) return
      if (k === 'delete' || k === 'backspace') {
        if (selRef.current.length) { commit(elsRef.current.filter((x) => !selRef.current.includes(x.id))); setSel([]) }
        return
      }
      if (k === 'escape') { setTool('select'); setSel([]); return }
      if (k.startsWith('arrow') && selRef.current.length) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0
        const dy = k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0
        commit(elsRef.current.map((x) => (selRef.current.includes(x.id) ? { ...x, x: x.x + dx, y: x.y + dy } : x)))
        return
      }
      if (KEY_TO_TOOL[k]) { setTool(KEY_TO_TOOL[k]); if (KEY_TO_TOOL[k] !== 'select') setSel([]) }
    }
    const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space') space.current = false }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp) }
  }, [commit, undo, redo])

  const toWorld = (e: { clientX: number; clientY: number }) => {
    const r = stageRef.current!.getBoundingClientRect()
    const v = viewRef.current
    return { sx: e.clientX - r.left, sy: e.clientY - r.top, x: (e.clientX - r.left - v.x) / v.zoom, y: (e.clientY - r.top - v.y) / v.zoom }
  }

  const hitAt = (x: number, y: number): El | null => {
    const tol = 6 / viewRef.current.zoom
    const list = elsRef.current
    for (let i = list.length - 1; i >= 0; i--) if (hitTest(list[i], x, y, tol)) return list[i]
    return null
  }

  const openTextEditor = (x: number, y: number, el?: El) => {
    editRef.current = {
      id: el?.id, x: el?.x ?? x, y: el?.y ?? y, value: el?.text ?? '',
      fontSize: el?.fontSize ?? 20, fontFamily: el?.fontFamily ?? fontRef.current, color: el?.stroke ?? styleRef.current.stroke,
    }
    setEditing(editRef.current)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (editRef.current) { if ((e.target as HTMLElement).tagName !== 'TEXTAREA') commitText(); return }
    if ((e.target as HTMLElement).tagName !== 'CANVAS') return
    stageRef.current!.setPointerCapture(e.pointerId)
    const p = toWorld(e)
    const t = toolRef.current

    if (e.button === 1 || t === 'hand' || space.current) {
      drag.current = { kind: 'pan', sx: p.sx, sy: p.sy, v: viewRef.current }
      return
    }
    if (e.button !== 0) return

    if (t === 'select') {
      const ids = selRef.current
      if (ids.length === 1) {
        const cur = elsRef.current.find((x) => x.id === ids[0])
        if (cur) {
          const z = viewRef.current.zoom
          const h = handlesOf(cur, z).find((hd) => Math.hypot(hd.x - p.x, hd.y - p.y) * z <= 9)
          if (h) { drag.current = { kind: 'resize', id: cur.id, handle: h.name, orig: cur, snap: elsRef.current }; return }
        }
      }
      const hit = hitAt(p.x, p.y)
      if (hit) {
        if (e.shiftKey) { setSel(ids.includes(hit.id) ? ids.filter((i) => i !== hit.id) : [...ids, hit.id]); return }
        const keep = ids.includes(hit.id)
        if (!keep) select(hit)
        drag.current = { kind: 'move', ids: keep ? ids : [hit.id], x: p.x, y: p.y, snap: elsRef.current }
      } else {
        if (!e.shiftKey) setSel([])
        drag.current = { kind: 'marquee', x: p.x, y: p.y, base: e.shiftKey ? ids : [] }
      }
      return
    }

    if (t === 'laser') { drag.current = { kind: 'laser' }; pushLaser(p.sx, p.sy, true); return }

    if (t === 'text') { openTextEditor(p.x, p.y); return }

    const shape: ShapeType = t === 'pen' ? 'freedraw' : (t as ShapeType)
    const base: El = {
      id: crypto.randomUUID(), type: shape, x: p.x, y: p.y, w: 0, h: 0,
      ...styleRef.current, seed: Math.floor(Math.random() * 2 ** 31),
      points: shape === 'freedraw' ? [[0, 0]] : undefined,
    }
    drag.current = { kind: 'create', id: base.id, x: p.x, y: p.y, shape, pts: [[p.x, p.y]], snap: elsRef.current }
    setEls([...elsRef.current, base])
    setSel([base.id])
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    const p = toWorld(e)
    if (!d) {
      if (toolRef.current === 'select' && !editRef.current) {
        const h = (e.target as HTMLElement).tagName === 'CANVAS' ? hitAt(p.x, p.y)?.id ?? null : null
        setHover((prev) => (prev === h ? prev : h))
      }
      return
    }
    if (d.kind === 'laser') {
      pushLaser(p.sx, p.sy)
    } else if (d.kind === 'pan') {
      setView({ ...d.v, x: d.v.x + p.sx - d.sx, y: d.v.y + p.sy - d.sy })
    } else if (d.kind === 'move') {
      const dx = p.x - d.x, dy = p.y - d.y
      setEls(d.snap.map((x) => (d.ids.includes(x.id) ? { ...x, x: x.x + dx, y: x.y + dy } : x)))
    } else if (d.kind === 'resize') {
      setEls(d.snap.map((x) => (x.id === d.id ? resizeEl(d.orig, d.handle, p.x, p.y, e.shiftKey) : x)))
    } else if (d.kind === 'marquee') {
      const box = { x: Math.min(d.x, p.x), y: Math.min(d.y, p.y), w: Math.abs(p.x - d.x), h: Math.abs(p.y - d.y) }
      setMarquee(box)
      const inside = elsRef.current
        .filter((el) => {
          const b = bbox(el)
          return b.x >= box.x && b.y >= box.y && b.x + b.w <= box.x + box.w && b.y + b.h <= box.y + box.h
        })
        .map((el) => el.id)
      setSel([...new Set([...d.base, ...inside])])
    } else if (d.kind === 'create') {
      const upd = (fn: (el: El) => El) => setEls((cur) => cur.map((x) => (x.id === d.id ? fn(x) : x)))
      if (d.shape === 'freedraw') {
        d.pts.push([p.x, p.y])
        upd((el) => penEl(el, d.pts))
      } else {
        let dx = p.x - d.x, dy = p.y - d.y
        if (e.shiftKey) {
          if (d.shape === 'line' || d.shape === 'arrow') [dx, dy] = snap45(dx, dy)
          else { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * m; dy = Math.sign(dy || 1) * m }
        }
        upd((el) => ({ ...el, w: dx, h: dy }))
      }
    }
  }

  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
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
    } else if (d.kind === 'move' || d.kind === 'resize') {
      if (elsRef.current !== d.snap) { past.current.push(d.snap); future.current = [] }
    }
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).tagName !== 'CANVAS' || toolRef.current !== 'select') return
    const p = toWorld(e)
    const hit = hitAt(p.x, p.y)
    if (hit?.type === 'text') { setSel([hit.id]); openTextEditor(hit.x, hit.y, hit) }
    else if (!hit) openTextEditor(p.x, p.y)
  }

  const applyStyle = (patch: Partial<Style>) => {
    setStyle((st) => ({ ...st, ...patch }))
    const ids = selRef.current
    if (ids.length) commit(elsRef.current.map((e) => (ids.includes(e.id) ? { ...e, ...patch } : e)))
  }

  const applyFont = (id: string) => {
    setFont(id)
    const ids = selRef.current
    const texts = elsRef.current.filter((e) => ids.includes(e.id) && e.type === 'text')
    if (texts.length) {
      commit(elsRef.current.map((e) => (ids.includes(e.id) && e.type === 'text' ? { ...e, fontFamily: id, ...measureText(e.text ?? '', e.fontSize ?? 20, id) } : e)))
    }
  }

  const openFile = (file: File) => {
    file.text().then((txt) => {
      try {
        const data = JSON.parse(txt)
        if (isSceneType(data?.type) && Array.isArray(data.elements)) {
          commit(data.elements as El[])
          setSel([])
        } else alert('Arquivo inválido.')
      } catch { alert('Arquivo inválido.') }
    })
  }

  const cursor = tool === 'hand' ? 'grab' : tool === 'select' ? (hover ? 'move' : 'default') : tool === 'text' ? 'text' : 'crosshair'
  const editView = editing && {
    left: editing.x * view.zoom + view.x,
    top: editing.y * view.zoom + view.y,
    fontSize: editing.fontSize * view.zoom,
  }
  const lines = editing ? editing.value.split('\n') : []

  return (
    <div
      className="stage"
      ref={stageRef}
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onMouseDown={(e) => { if ((e.target as HTMLElement).tagName === 'CANVAS') e.preventDefault() }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      <canvas ref={canvasRef} />
      <canvas ref={laserCanvas} className="laser" />

      <div className="panel menu">
        <span className="brand"><img className="logo" src="/favicon.svg" alt="" />Rabiscadraw</span>
        <button onClick={() => fileRef.current?.click()}>Abrir</button>
        <button onClick={() => saveJSON(els)}>Salvar</button>
        <button onClick={() => exportPNG(els)}>PNG</button>
        <button onClick={() => exportSVG(els)}>SVG</button>
        <button onClick={() => { if (els.length && confirm('Limpar tudo?')) { commit([]); setSel([]) } }}>Limpar</button>
        <input ref={fileRef} type="file" hidden accept=".rabiscadraw,.rabiscalidraw,.json" onChange={(e) => { const f = e.target.files?.[0]; if (f) openFile(f); e.target.value = '' }} />
      </div>

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
      </div>

      <div className="panel props">
        <div>
          <h4>Traço</h4>
          <div className="row">
            {STROKES.map((c) => <button key={c} className={'sw' + (style.stroke === c ? ' on' : '')} style={{ background: c }} onClick={() => applyStyle({ stroke: c })} />)}
          </div>
        </div>
        <div>
          <h4>Fundo</h4>
          <div className="row">
            {FILLS.map((c) => <button key={c} className={'sw' + (c === 'transparent' ? ' none' : '') + (style.fill === c ? ' on' : '')} style={c === 'transparent' ? undefined : { background: c }} onClick={() => applyStyle({ fill: c })} />)}
          </div>
        </div>
        <div>
          <h4>Espessura</h4>
          <div className="row">
            {[1, 2, 4].map((w) => <button key={w} className={'opt' + (style.strokeWidth === w ? ' on' : '')} onClick={() => applyStyle({ strokeWidth: w })}>{['Fina', 'Média', 'Grossa'][[1, 2, 4].indexOf(w)]}</button>)}
          </div>
        </div>
        <div>
          <h4>Rabisco</h4>
          <div className="row">
            {[0, 1, 2].map((r) => <button key={r} className={'opt' + (style.roughness === r ? ' on' : '')} onClick={() => applyStyle({ roughness: r })}>{['Liso', 'Torto', 'Doido'][r]}</button>)}
          </div>
        </div>
        <div>
          <h4>Fonte do texto</h4>
          <div className="row">
            {FONTS.map((f) => <button key={f.id} className={'opt' + (font === f.id ? ' on' : '')} style={{ fontFamily: f.css, fontWeight: f.weight, fontSize: 14 }} onClick={() => applyFont(f.id)}>{f.label}</button>)}
          </div>
        </div>
      </div>

      <div className="panel zoom">
        <button onClick={() => zoomBy(1 / 1.2)}>−</button>
        <span>{Math.round(view.zoom * 100)}%</span>
        <button onClick={() => zoomBy(1.2)}>+</button>
        <button title="Resetar zoom" onClick={() => setView({ x: 0, y: 0, zoom: 1 })}>⟲</button>
        <button title="Desfazer (Ctrl+Z)" onClick={undo}>↶</button>
        <button title="Refazer (Ctrl+Shift+Z)" onClick={redo}>↷</button>
      </div>

      <div className="hint">Ctrl+scroll = zoom · Espaço+arrastar = mover tela · Duplo clique = texto</div>

      {editing && editView && (
        <textarea
          ref={taRef}
          className="edit"
          value={editing.value}
          rows={lines.length}
          cols={Math.max(2, ...lines.map((l) => l.length + 1))}
          style={{ left: editView.left, top: editView.top, fontSize: editView.fontSize, color: editing.color, fontFamily: fontOf(editing.fontFamily).css, fontWeight: fontOf(editing.fontFamily).weight }}
          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
          onBlur={commitText}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); commitText() } }}
        />
      )}
    </div>
  )
}
