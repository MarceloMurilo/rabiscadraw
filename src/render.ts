import rough from 'roughjs'
import type { RoughCanvas } from 'roughjs/bin/canvas'
import type { RoughSVG } from 'roughjs/bin/svg'
import type { Options } from 'roughjs/bin/core'
import type { El } from './types'
import { bbox, boundsOf, canRotate, centerOf, notePoint } from './geometry'
import type { Box } from './geometry'
import { iconById } from './catalog'

export const FONTS = [
  { id: 'excali', label: 'Excalifont', css: 'Excalifont,"Segoe Print","Comic Sans MS",cursive', weight: '400' },
  { id: 'patrick', label: 'Patrick Hand', css: '"Patrick Hand","Comic Sans MS",cursive', weight: '400' },
  { id: 'nunito', label: 'Nunito', css: 'Nunito,system-ui,sans-serif', weight: '600' },
]
export const fontOf = (id?: string) => FONTS.find((f) => f.id === id) ?? FONTS[0]
const canvasFont = (id: string | undefined, size: number) => {
  const f = fontOf(id)
  return `${f.weight} ${size}px ${f.css}`
}
export const loadFonts = () =>
  Promise.all(FONTS.map((f) => document.fonts.load(`${f.weight} 20px ${f.css}`))).then(() => undefined, () => undefined)
const LINE_HEIGHT = 1.25
const NS = 'http://www.w3.org/2000/svg'

let mctx: CanvasRenderingContext2D | null = null
export function measureText(text: string, fontSize: number, family?: string) {
  mctx ??= document.createElement('canvas').getContext('2d')!
  mctx.font = canvasFont(family, fontSize)
  const lines = text.split('\n')
  const w = Math.max(1, ...lines.map((l) => mctx!.measureText(l).width))
  return { w, h: lines.length * fontSize * LINE_HEIGHT }
}

const imgCache = new Map<string, HTMLImageElement>()
let imgListener: () => void = () => {}
export const onImageLoad = (fn: () => void) => { imgListener = fn }
export function getImage(src: string) {
  let img = imgCache.get(src)
  if (!img) {
    img = new Image()
    img.onload = () => imgListener()
    img.src = src
    imgCache.set(src, img)
  }
  return img
}

// Icons are a square drawing with the caption underneath; the element box covers both.
export function iconLayout(el: El, text = el.text ?? '') {
  const b = bbox(el)
  const fs = el.fontSize ?? 16
  const labelH = text ? text.split('\n').length * fs * LINE_HEIGHT + 10 : 0
  const side = Math.max(8, Math.min(b.w, b.h - labelH))
  return { b, fs, labelH, side, ix: b.x + (b.w - side) / 2, iy: b.y }
}

function drawCentered(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, fs: number, family: string | undefined, color: string, align: CanvasTextAlign = 'center') {
  ctx.save()
  ctx.font = canvasFont(family, fs)
  ctx.fillStyle = color
  ctx.textBaseline = 'middle'
  ctx.textAlign = align
  const lines = text.split('\n'), lh = fs * LINE_HEIGHT
  const y0 = cy - ((lines.length - 1) * lh) / 2
  lines.forEach((l, i) => ctx.fillText(l, cx, y0 + i * lh))
  ctx.restore()
}

function svgCentered(g: SVGElement, text: string, cx: number, cy: number, fs: number, el: El, align: 'left' | 'center' | 'right' = 'center') {
  const lines = text.split('\n'), lh = fs * LINE_HEIGHT
  const y0 = cy - ((lines.length - 1) * lh) / 2
  lines.forEach((l, i) => {
    const t = document.createElementNS(NS, 'text')
    t.setAttribute('x', String(cx))
    t.setAttribute('y', String(y0 + i * lh))
    t.setAttribute('font-size', String(fs))
    t.setAttribute('font-family', fontOf(el.fontFamily).css)
    t.setAttribute('font-weight', fontOf(el.fontFamily).weight)
    t.setAttribute('fill', el.stroke)
    t.setAttribute('text-anchor', align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle')
    t.setAttribute('dominant-baseline', 'middle')
    t.textContent = l
    g.appendChild(t)
  })
}

// text bound to a rectangle / ellipse / diamond, centred in it
function labelPos(el: El, b: Box) {
  const fs = el.fontSize ?? 20
  const blockH = (el.text ?? '').split('\n').length * fs * LINE_HEIGHT
  const align = el.align ?? 'center', v = el.valign ?? 'middle'
  // ellipses and diamonds are narrower near their edges, so keep the text further in
  const pad = el.type === 'rectangle' ? 10 : Math.max(10, b.w * 0.18)
  const vpad = el.type === 'rectangle' ? 10 : Math.max(10, b.h * 0.18)
  const x = align === 'left' ? b.x + pad : align === 'right' ? b.x + b.w - pad : b.x + b.w / 2
  const cy = v === 'top' ? b.y + vpad + blockH / 2 : v === 'bottom' ? b.y + b.h - vpad - blockH / 2 : b.y + b.h / 2
  return { x, cy, fs, align }
}
function drawLabel(ctx: CanvasRenderingContext2D, el: El, b: Box) {
  if (!el.text) return
  const L = labelPos(el, b)
  drawCentered(ctx, el.text, L.x, L.cy, L.fs, el.fontFamily, el.stroke, L.align)
}
function svgLabel(g: SVGElement, el: El, b: Box) {
  if (!el.text) return
  const L = labelPos(el, b)
  svgCentered(g, el.text, L.x, L.cy, L.fs, el, L.align)
}

function roughOpts(el: El): Options {
  const o: Options = {
    stroke: el.stroke,
    strokeWidth: el.strokeWidth,
    roughness: el.roughness,
    seed: el.seed,
    // one clean stroke instead of the doubled sketchy one, with a gentler curve
    disableMultiStroke: true,
    disableMultiStrokeFill: true,
    bowing: 0.6,
  }
  if (el.dash) o.strokeLineDash = [8, 7]
  if (el.fill !== 'transparent') {
    o.fill = el.fill
    o.fillStyle = el.type === 'icon' ? 'solid' : el.fillStyle ?? 'hachure'
    o.fillWeight = el.strokeWidth / 2
    o.hachureGap = el.strokeWidth * 4 + 2
  }
  return o
}

function headAt(tx: number, ty: number, angle: number, strokeWidth: number, maxLen: number): [number, number][] {
  const len = Math.min(10 + strokeWidth * 3, maxLen)
  const side = (d: number): [number, number] => [
    tx + len * Math.cos(angle + Math.PI + d),
    ty + len * Math.sin(angle + Math.PI + d),
  ]
  return [side(0.45), [tx, ty], side(-0.45)]
}

function arrowHead(el: El): [number, number][] {
  return headAt(el.x + el.w, el.y + el.h, Math.atan2(el.h, el.w), el.strokeWidth, Math.hypot(el.w, el.h) * 0.6)
}

// a connector is a polyline (usually with right-angle bends) whose points are relative to x,y
function connectorPts(el: El): [number, number][] {
  return el.points!.map(([a, b]) => [el.x + a, el.y + b])
}
/** The route of a line, arrow or connector in drawing coordinates, from its start to its end. */
export function pathOf(el: El): [number, number][] | null {
  if (el.type === 'connector') return el.points?.length ? connectorPts(el) : null
  if (el.type === 'arrow' || el.type === 'line') return [[el.x, el.y], [el.x + el.w, el.y + el.h]]
  return null
}
function connectorHead(el: El, pts: [number, number][]): [number, number][] {
  const [px, py] = pts[pts.length - 2] ?? pts[0]
  const [tx, ty] = pts[pts.length - 1]
  return headAt(tx, ty, Math.atan2(ty - py, tx - px), el.strokeWidth, Math.max(6, Math.hypot(tx - px, ty - py) * 0.8))
}

// hand shake removal: drop near-duplicate points, then round the corners off (Chaikin). Cached per points array.
const smoothCache = new WeakMap<object, [number, number][]>()
function smoothPts(p: [number, number][]): [number, number][] {
  if (p.length < 3) return p
  const hit = smoothCache.get(p)
  if (hit) return hit
  const kept: [number, number][] = [p[0]]
  for (let i = 1; i < p.length - 1; i++) {
    const l = kept[kept.length - 1]
    if (Math.hypot(p[i][0] - l[0], p[i][1] - l[1]) >= 1.5) kept.push(p[i])
  }
  kept.push(p[p.length - 1])
  let out = kept
  for (let r = 0; r < 2 && out.length > 2; r++) {
    const n: [number, number][] = [out[0]]
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i], b = out[i + 1]
      n.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]])
    }
    n.push(out[out.length - 1])
    out = n
  }
  smoothCache.set(p, out)
  return out
}

function roundRectD(x: number, y: number, w: number, h: number): string {
  const r = Math.min(18, Math.min(w, h) / 4)
  return `M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}V${y + r}Q${x} ${y} ${x + r} ${y}Z`
}

function freePathD(el: El): string {
  const p = smoothPts(el.points!)
  if (p.length === 1) return `M${p[0][0]} ${p[0][1]} l0.01 0`
  let d = `M${p[0][0]} ${p[0][1]}`
  for (let i = 1; i < p.length - 1; i++) {
    const mx = (p[i][0] + p[i + 1][0]) / 2, my = (p[i][1] + p[i + 1][1]) / 2
    d += ` Q${p[i][0]} ${p[i][1]} ${mx} ${my}`
  }
  const last = p[p.length - 1]
  return d + ` L${last[0]} ${last[1]}`
}

export function drawElement(rc: RoughCanvas, ctx: CanvasRenderingContext2D, el: El) {
  const rot = el.angle && canRotate(el) ? el.angle : 0
  const alpha = el.opacity === undefined ? 1 : el.opacity / 100
  if (!rot && alpha === 1) { drawBody(rc, ctx, el); return }
  ctx.save()
  ctx.globalAlpha *= alpha
  if (rot) {
    const c = centerOf(el)
    ctx.translate(c.x, c.y)
    ctx.rotate(rot)
    ctx.translate(-c.x, -c.y)
  }
  drawBody(rc, ctx, el)
  ctx.restore()
}

function drawBody(rc: RoughCanvas, ctx: CanvasRenderingContext2D, el: El) {
  const o = roughOpts(el)
  const b = bbox(el)
  switch (el.type) {
    case 'rectangle':
      if (el.rounded) rc.path(roundRectD(b.x, b.y, b.w, b.h), o)
      else rc.rectangle(b.x, b.y, b.w, b.h, o)
      drawLabel(ctx, el, b)
      break
    case 'ellipse':
      rc.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w, b.h, o)
      drawLabel(ctx, el, b)
      break
    case 'diamond':
      rc.polygon([
        [b.x + b.w / 2, b.y], [b.x + b.w, b.y + b.h / 2],
        [b.x + b.w / 2, b.y + b.h], [b.x, b.y + b.h / 2],
      ], o)
      drawLabel(ctx, el, b)
      break
    case 'line':
    case 'arrow':
      rc.line(el.x, el.y, el.x + el.w, el.y + el.h, o)
      if (el.type === 'arrow') rc.linearPath(arrowHead(el), { ...o, fill: undefined, strokeLineDash: undefined })
      break
    case 'connector': {
      const pts = connectorPts(el)
      rc.linearPath(pts, { ...o, fill: undefined })
      if (el.endArrow !== false) rc.linearPath(connectorHead(el, pts), { ...o, fill: undefined, strokeLineDash: undefined })
      break
    }
    case 'freedraw':
      ctx.save()
      ctx.translate(el.x, el.y)
      ctx.strokeStyle = el.stroke
      ctx.lineWidth = el.strokeWidth
      ctx.lineCap = ctx.lineJoin = 'round'
      ctx.stroke(new Path2D(freePathD(el)))
      ctx.restore()
      break
    case 'icon': {
      const def = iconById(el.icon)
      if (!def) break
      const L = iconLayout(el), s = L.side / 100
      ctx.save()
      ctx.translate(L.ix, L.iy)
      ctx.scale(s, s)
      if (el.flipX) { ctx.translate(100, 0); ctx.scale(-1, 1) }
      if (el.flipY) { ctx.translate(0, 100); ctx.scale(1, -1) }
      const io: Options = { ...o, strokeWidth: el.strokeWidth / s }
      for (const d of def.paths) rc.path(d, io)
      ctx.restore()
      if (el.text) drawCentered(ctx, el.text, b.x + b.w / 2, b.y + L.side + L.labelH / 2, L.fs, el.fontFamily, el.stroke)
      break
    }
    case 'image': {
      const img = getImage(el.src ?? '')
      if (img.complete && img.naturalWidth) {
        ctx.save()
        ctx.translate(b.x + (el.flipX ? b.w : 0), b.y + (el.flipY ? b.h : 0))
        ctx.scale(el.flipX ? -1 : 1, el.flipY ? -1 : 1)
        ctx.drawImage(img, 0, 0, b.w, b.h)
        ctx.restore()
      }
      break
    }
    case 'text': {
      const fs = el.fontSize ?? 20
      ctx.save()
      ctx.font = canvasFont(el.fontFamily, fs)
      ctx.fillStyle = el.stroke
      ctx.textBaseline = 'top'
      ctx.textAlign = el.align ?? 'left'
      const tx = el.align === 'center' ? el.x + el.w / 2 : el.align === 'right' ? el.x + el.w : el.x
      ;(el.text ?? '').split('\n').forEach((l, i) => ctx.fillText(l, tx, el.y + i * fs * LINE_HEIGHT))
      ctx.restore()
      break
    }
  }
}

function drawElementSvg(rs: RoughSVG, el: El): SVGElement {
  const o = roughOpts(el)
  const b = bbox(el)
  const g = document.createElementNS(NS, 'g')
  switch (el.type) {
    case 'rectangle':
      g.appendChild(el.rounded ? rs.path(roundRectD(b.x, b.y, b.w, b.h), o) : rs.rectangle(b.x, b.y, b.w, b.h, o))
      svgLabel(g, el, b)
      break
    case 'ellipse':
      g.appendChild(rs.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w, b.h, o))
      svgLabel(g, el, b)
      break
    case 'diamond':
      g.appendChild(rs.polygon([
        [b.x + b.w / 2, b.y], [b.x + b.w, b.y + b.h / 2],
        [b.x + b.w / 2, b.y + b.h], [b.x, b.y + b.h / 2],
      ], o))
      svgLabel(g, el, b)
      break
    case 'line':
    case 'arrow':
      g.appendChild(rs.line(el.x, el.y, el.x + el.w, el.y + el.h, o))
      if (el.type === 'arrow') g.appendChild(rs.linearPath(arrowHead(el), { ...o, fill: undefined, strokeLineDash: undefined }))
      break
    case 'connector': {
      const pts = connectorPts(el)
      g.appendChild(rs.linearPath(pts, { ...o, fill: undefined }))
      if (el.endArrow !== false) g.appendChild(rs.linearPath(connectorHead(el, pts), { ...o, fill: undefined, strokeLineDash: undefined }))
      break
    }
    case 'freedraw': {
      const p = document.createElementNS(NS, 'path')
      p.setAttribute('d', freePathD(el))
      p.setAttribute('transform', `translate(${el.x} ${el.y})`)
      p.setAttribute('fill', 'none')
      p.setAttribute('stroke', el.stroke)
      p.setAttribute('stroke-width', String(el.strokeWidth))
      p.setAttribute('stroke-linecap', 'round')
      p.setAttribute('stroke-linejoin', 'round')
      g.appendChild(p)
      break
    }
    case 'icon': {
      const def = iconById(el.icon)
      if (!def) break
      const L = iconLayout(el), s = L.side / 100
      const ig = document.createElementNS(NS, 'g')
      ig.setAttribute('transform', `translate(${L.ix} ${L.iy}) scale(${s})${el.flipX ? ' translate(100 0) scale(-1 1)' : ''}${el.flipY ? ' translate(0 100) scale(1 -1)' : ''}`)
      const io: Options = { ...o, strokeWidth: el.strokeWidth / s }
      for (const d of def.paths) ig.appendChild(rs.path(d, io))
      g.appendChild(ig)
      if (el.text) svgCentered(g, el.text, b.x + b.w / 2, b.y + L.side + L.labelH / 2, L.fs, el)
      break
    }
    case 'image': {
      const im = document.createElementNS(NS, 'image')
      im.setAttribute('href', el.src ?? '')
      im.setAttribute('x', '0')
      im.setAttribute('y', '0')
      im.setAttribute('transform', `translate(${b.x + (el.flipX ? b.w : 0)} ${b.y + (el.flipY ? b.h : 0)}) scale(${el.flipX ? -1 : 1} ${el.flipY ? -1 : 1})`)
      im.setAttribute('width', String(b.w))
      im.setAttribute('height', String(b.h))
      g.appendChild(im)
      break
    }
    case 'text': {
      const fs = el.fontSize ?? 20
      ;(el.text ?? '').split('\n').forEach((l, i) => {
        const t = document.createElementNS(NS, 'text')
        t.setAttribute('x', String(el.align === 'center' ? el.x + el.w / 2 : el.align === 'right' ? el.x + el.w : el.x))
        t.setAttribute('y', String(el.y + i * fs * LINE_HEIGHT))
        t.setAttribute('text-anchor', el.align === 'center' ? 'middle' : el.align === 'right' ? 'end' : 'start')
        t.setAttribute('font-size', String(fs))
        t.setAttribute('font-family', fontOf(el.fontFamily).css)
        t.setAttribute('font-weight', fontOf(el.fontFamily).weight)
        t.setAttribute('fill', el.stroke)
        t.setAttribute('dominant-baseline', 'hanging')
        t.textContent = l
        g.appendChild(t)
      })
      break
    }
  }
  if (el.angle && canRotate(el)) {
    const c = centerOf(el)
    g.setAttribute('transform', `rotate(${(el.angle * 180) / Math.PI} ${c.x} ${c.y})`)
  }
  if (el.opacity !== undefined) g.setAttribute('opacity', String(el.opacity / 100))
  return g
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

const PAD = 24

export function renderPNG(els: El[]): Promise<Blob | null> {
  const b = boundsOf(els)
  if (!b) return Promise.resolve(null)
  const s = 2
  const c = document.createElement('canvas')
  c.width = Math.ceil((b.w + PAD * 2) * s)
  c.height = Math.ceil((b.h + PAD * 2) * s)
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.setTransform(s, 0, 0, s, (PAD - b.x) * s, (PAD - b.y) * s)
  const rc = rough.canvas(c)
  els.forEach((e) => drawElement(rc, ctx, e))
  return new Promise((res) => c.toBlob(res))
}

export function exportPNG(els: El[], name = 'rabiscadraw') {
  renderPNG(els).then((bl) => bl && download(bl, `${fileSafe(name)}.png`))
}

export function svgString(els: El[]): string | null {
  const b = boundsOf(els)
  if (!b) return null
  const w = b.w + PAD * 2, h = b.h + PAD * 2
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('xmlns', NS)
  svg.setAttribute('width', String(w))
  svg.setAttribute('height', String(h))
  svg.setAttribute('viewBox', `${b.x - PAD} ${b.y - PAD} ${w} ${h}`)
  const bg = document.createElementNS(NS, 'rect')
  bg.setAttribute('x', String(b.x - PAD))
  bg.setAttribute('y', String(b.y - PAD))
  bg.setAttribute('width', String(w))
  bg.setAttribute('height', String(h))
  bg.setAttribute('fill', '#fff')
  svg.appendChild(bg)
  const rs = rough.svg(svg)
  els.forEach((e) => svg.appendChild(drawElementSvg(rs, e)))
  return new XMLSerializer().serializeToString(svg)
}

export function exportSVG(els: El[], name = 'rabiscadraw') {
  const out = svgString(els)
  if (out) download(new Blob([out], { type: 'image/svg+xml' }), `${fileSafe(name)}.svg`)
}

export function saveJSON(els: El[], name = 'desenho') {
  const data = JSON.stringify({ type: 'rabiscadraw', version: 1, elements: els }, null, 2)
  download(new Blob([data], { type: 'application/json' }), `${fileSafe(name)}.rabiscadraw`)
}

// scene files/clipboard payloads written before the rename still say "rabiscalidraw"
export const isSceneType = (t: unknown) => t === 'rabiscadraw' || t === 'rabiscalidraw'

const fileSafe = (name: string) => name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'desenho'

// small preview for the drawings list
export function thumbnail(els: El[]): string | undefined {
  const b = boundsOf(els)
  if (!b) return undefined
  const W = 200, H = 130, pad = 12, k = 1.5
  const s = Math.min((W - pad * 2) / Math.max(b.w, 1), (H - pad * 2) / Math.max(b.h, 1), 1)
  const c = document.createElement('canvas')
  c.width = W * k
  c.height = H * k
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.setTransform(k * s, 0, 0, k * s, k * ((W - b.w * s) / 2 - b.x * s), k * ((H - b.h * s) / 2 - b.y * s))
  const rc = rough.canvas(c)
  els.forEach((e) => drawElement(rc, ctx, e))
  return c.toDataURL('image/jpeg', 0.7)
}

// PNG of the whole drawing as base64 (no data: prefix), for agents that want to look at the result
export interface SnapOpts {
  maxSide?: number
  area?: { x: number; y: number; w: number; h: number } // scene rectangle to show (default: everything)
  numbered?: boolean // number the elements that carry an explanation
}

// PNG for an agent. Returns the image and, when numbered, the legend of the numbers drawn on it.
export function snapshotPNG(els: El[], opts: SnapOpts | number = {}): { png: string; legend: { n: number; el: El }[] } | undefined {
  const o = typeof opts === 'number' ? { maxSide: opts } : opts
  const maxSide = o.maxSide ?? 1600
  const b = o.area ?? boundsOf(els)
  if (!b) return undefined
  const pad = o.area ? 0 : PAD + (o.numbered ? 14 : 0)
  const w = b.w + pad * 2, h = b.h + pad * 2
  const s = Math.min(o.area ? 3 : 2, maxSide / Math.max(w, h))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.ceil(w * s))
  c.height = Math.max(1, Math.ceil(h * s))
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.setTransform(s, 0, 0, s, (pad - b.x) * s, (pad - b.y) * s)
  const rc = rough.canvas(c)
  els.forEach((e) => drawElement(rc, ctx, e))
  const legend = o.numbered ? els.filter((e) => e.description && !e.aux).map((el, i) => ({ n: i + 1, el })) : []
  for (const { n, el } of legend) {
    const m = notePoint(el, 1)
    ctx.save()
    ctx.fillStyle = '#fff'
    ctx.strokeStyle = '#6965db'
    ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.arc(m.x, m.y, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    ctx.fillStyle = '#4a47b8'
    ctx.font = 'bold 11px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(n), m.x, m.y + 0.5)
    ctx.restore()
  }
  return { png: c.toDataURL('image/png').split(',')[1], legend }
}
