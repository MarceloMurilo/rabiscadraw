import rough from 'roughjs'
import type { RoughCanvas } from 'roughjs/bin/canvas'
import type { RoughSVG } from 'roughjs/bin/svg'
import type { Options } from 'roughjs/bin/core'
import type { El } from './types'
import { bbox, boundsOf } from './geometry'

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

function roughOpts(el: El): Options {
  const o: Options = {
    stroke: el.stroke,
    strokeWidth: el.strokeWidth,
    roughness: el.roughness,
    seed: el.seed,
  }
  if (el.fill !== 'transparent') {
    o.fill = el.fill
    o.fillStyle = 'hachure'
    o.fillWeight = el.strokeWidth / 2
    o.hachureGap = el.strokeWidth * 4 + 2
  }
  return o
}

function arrowHead(el: El): [number, number][] {
  const tx = el.x + el.w, ty = el.y + el.h
  const angle = Math.atan2(el.h, el.w)
  const len = Math.min(10 + el.strokeWidth * 3, Math.hypot(el.w, el.h) * 0.6)
  const side = (d: number): [number, number] => [
    tx + len * Math.cos(angle + Math.PI + d),
    ty + len * Math.sin(angle + Math.PI + d),
  ]
  return [side(0.45), [tx, ty], side(-0.45)]
}

function freePathD(el: El): string {
  const p = el.points!
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
  const o = roughOpts(el)
  const b = bbox(el)
  switch (el.type) {
    case 'rectangle':
      rc.rectangle(b.x, b.y, b.w, b.h, o)
      break
    case 'ellipse':
      rc.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w, b.h, o)
      break
    case 'diamond':
      rc.polygon([
        [b.x + b.w / 2, b.y], [b.x + b.w, b.y + b.h / 2],
        [b.x + b.w / 2, b.y + b.h], [b.x, b.y + b.h / 2],
      ], o)
      break
    case 'line':
    case 'arrow':
      rc.line(el.x, el.y, el.x + el.w, el.y + el.h, o)
      if (el.type === 'arrow') rc.linearPath(arrowHead(el), { ...o, fill: undefined })
      break
    case 'freedraw':
      ctx.save()
      ctx.translate(el.x, el.y)
      ctx.strokeStyle = el.stroke
      ctx.lineWidth = el.strokeWidth
      ctx.lineCap = ctx.lineJoin = 'round'
      ctx.stroke(new Path2D(freePathD(el)))
      ctx.restore()
      break
    case 'image': {
      const img = getImage(el.src ?? '')
      if (img.complete && img.naturalWidth) ctx.drawImage(img, b.x, b.y, b.w, b.h)
      break
    }
    case 'text': {
      const fs = el.fontSize ?? 20
      ctx.save()
      ctx.font = canvasFont(el.fontFamily, fs)
      ctx.fillStyle = el.stroke
      ctx.textBaseline = 'top'
      ;(el.text ?? '').split('\n').forEach((l, i) => ctx.fillText(l, el.x, el.y + i * fs * LINE_HEIGHT))
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
      g.appendChild(rs.rectangle(b.x, b.y, b.w, b.h, o))
      break
    case 'ellipse':
      g.appendChild(rs.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w, b.h, o))
      break
    case 'diamond':
      g.appendChild(rs.polygon([
        [b.x + b.w / 2, b.y], [b.x + b.w, b.y + b.h / 2],
        [b.x + b.w / 2, b.y + b.h], [b.x, b.y + b.h / 2],
      ], o))
      break
    case 'line':
    case 'arrow':
      g.appendChild(rs.line(el.x, el.y, el.x + el.w, el.y + el.h, o))
      if (el.type === 'arrow') g.appendChild(rs.linearPath(arrowHead(el), { ...o, fill: undefined }))
      break
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
    case 'image': {
      const im = document.createElementNS(NS, 'image')
      im.setAttribute('href', el.src ?? '')
      im.setAttribute('x', String(b.x))
      im.setAttribute('y', String(b.y))
      im.setAttribute('width', String(b.w))
      im.setAttribute('height', String(b.h))
      g.appendChild(im)
      break
    }
    case 'text': {
      const fs = el.fontSize ?? 20
      ;(el.text ?? '').split('\n').forEach((l, i) => {
        const t = document.createElementNS(NS, 'text')
        t.setAttribute('x', String(el.x))
        t.setAttribute('y', String(el.y + i * fs * LINE_HEIGHT))
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

export function exportPNG(els: El[]) {
  const b = boundsOf(els)
  if (!b) return
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
  c.toBlob((bl) => bl && download(bl, 'rabiscadraw.png'))
}

export function exportSVG(els: El[]) {
  const b = boundsOf(els)
  if (!b) return
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
  download(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }), 'rabiscadraw.svg')
}

export function saveJSON(els: El[]) {
  const data = JSON.stringify({ type: 'rabiscadraw', version: 1, elements: els }, null, 2)
  download(new Blob([data], { type: 'application/json' }), 'desenho.rabiscadraw')
}

// scene files/clipboard payloads written before the rename still say "rabiscalidraw"
export const isSceneType = (t: unknown) => t === 'rabiscadraw' || t === 'rabiscalidraw'
