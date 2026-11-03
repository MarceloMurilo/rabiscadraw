import type { El } from './types'
import { iconLayout } from './render'

export interface Box { x: number; y: number; w: number; h: number }
export interface Handle { name: string; x: number; y: number }

export const bbox = (el: El): Box => ({
  x: Math.min(el.x, el.x + el.w),
  y: Math.min(el.y, el.y + el.h),
  w: Math.abs(el.w),
  h: Math.abs(el.h),
})

export const canRotate = (el: El) => el.type !== 'line' && el.type !== 'arrow' && el.type !== 'connector'

export function centerOf(el: El) {
  const b = bbox(el)
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
}

export function rotatePt(x: number, y: number, cx: number, cy: number, a: number) {
  const c = Math.cos(a), s = Math.sin(a), dx = x - cx, dy = y - cy
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c }
}

// the point is within the element's box (turned with it when rotated); lines and arrows only count near the line itself
export function insideBox(el: El, x: number, y: number, pad: number): boolean {
  if (el.type === 'line' || el.type === 'arrow') return hitTest(el, x, y, pad)
  const c = centerOf(el)
  const q = el.angle && canRotate(el) ? rotatePt(x, y, c.x, c.y, -el.angle) : { x, y }
  const b = bbox(el)
  return q.x >= b.x - pad && q.x <= b.x + b.w + pad && q.y >= b.y - pad && q.y <= b.y + b.h + pad
}

// where the padlock of a locked element sits: just outside its top-left corner (turned with it)
// the box of the drawing itself: for icons the square, not the wider box that also holds the caption
const markBox = (el: El): Box => {
  if (el.type !== 'icon') return bbox(el)
  const L = iconLayout(el)
  return { x: L.ix, y: L.iy, w: L.side, h: L.side }
}

export function lockPoint(el: El, zoom: number) {
  const b = markBox(el), c = centerOf(el)
  const px = b.x - 14 / zoom, py = b.y - 14 / zoom
  return el.angle && canRotate(el) ? rotatePt(px, py, c.x, c.y, el.angle) : { x: px, y: py }
}

// where the "i" button of an element with an explanation sits: just outside its top-right corner (turned with it)
export function notePoint(el: El, zoom: number) {
  const b = markBox(el), c = centerOf(el)
  const px = b.x + b.w + 9 / zoom, py = b.y - 9 / zoom
  return el.angle && canRotate(el) ? rotatePt(px, py, c.x, c.y, el.angle) : { x: px, y: py }
}

export function boundsOf(els: El[]): Box | null {
  if (!els.length) return null
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const el of els) {
    const b = bbox(el)
    const corners: [number, number][] = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]]
    const c = centerOf(el)
    for (const [cx, cy] of corners) {
      const q = el.angle && canRotate(el) ? rotatePt(cx, cy, c.x, c.y, el.angle) : { x: cx, y: cy }
      x1 = Math.min(x1, q.x); y1 = Math.min(y1, q.y)
      x2 = Math.max(x2, q.x); y2 = Math.max(y2, q.y)
    }
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

const isLinear = (el: El) => el.type === 'line' || el.type === 'arrow'

function distSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay
  const l = dx * dx + dy * dy
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

export function hitTest(el: El, px: number, py: number, tol: number): boolean {
  if (el.angle && canRotate(el)) {
    const c = centerOf(el)
    const q = rotatePt(px, py, c.x, c.y, -el.angle)
    px = q.x; py = q.y
  }
  const pad = tol + el.strokeWidth / 2
  if (isLinear(el)) return distSeg(px, py, el.x, el.y, el.x + el.w, el.y + el.h) <= pad
  if (el.type === 'freedraw' || el.type === 'connector') {
    const p = el.points!
    if (p.length === 1) return Math.hypot(px - el.x - p[0][0], py - el.y - p[0][1]) <= pad
    for (let i = 0; i < p.length - 1; i++) {
      if (distSeg(px, py, el.x + p[i][0], el.y + p[i][1], el.x + p[i + 1][0], el.y + p[i + 1][1]) <= pad) return true
    }
    return false
  }
  const b = bbox(el)
  const filled = el.fill !== 'transparent'
  if (el.type === 'text' || el.type === 'image' || el.type === 'icon') {
    return px >= b.x - pad && px <= b.x + b.w + pad && py >= b.y - pad && py <= b.y + b.h + pad
  }
  if (el.type === 'rectangle') {
    const outer = px >= b.x - pad && px <= b.x + b.w + pad && py >= b.y - pad && py <= b.y + b.h + pad
    if (!outer || (filled && !el.frame)) return outer // a filled group box is only grabbed by its border, so the board inside stays free
    return !(px > b.x + pad && px < b.x + b.w - pad && py > b.y + pad && py < b.y + b.h - pad)
  }
  const a = b.w / 2, c = b.h / 2
  if (!a || !c) return false
  const dx = px - (b.x + a), dy = py - (b.y + c)
  const f = el.type === 'ellipse' ? Math.hypot(dx / a, dy / c) : Math.abs(dx) / a + Math.abs(dy) / c
  const m = Math.max(1, Math.min(a, c))
  return filled ? f <= 1 + pad / m : Math.abs(f - 1) * m <= pad
}

export function handlesOf(el: El, zoom: number): Handle[] {
  if (isLinear(el)) {
    return [{ name: 'p0', x: el.x, y: el.y }, { name: 'p1', x: el.x + el.w, y: el.y + el.h }]
  }
  const b = bbox(el), p = 6 / zoom, c = centerOf(el)
  const hs: Handle[] = [
    { name: 'nw', x: b.x - p, y: b.y - p },
    { name: 'ne', x: b.x + b.w + p, y: b.y - p },
    { name: 'se', x: b.x + b.w + p, y: b.y + b.h + p },
    { name: 'sw', x: b.x - p, y: b.y + b.h + p },
  ]
  if (canRotate(el)) hs.push({ name: 'rot', x: c.x, y: b.y - p - 24 / zoom })
  if (!el.angle) return hs
  return hs.map((h) => ({ name: h.name, ...rotatePt(h.x, h.y, c.x, c.y, el.angle!) }))
}
