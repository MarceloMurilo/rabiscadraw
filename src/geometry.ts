import type { El } from './types'

export interface Box { x: number; y: number; w: number; h: number }
export interface Handle { name: string; x: number; y: number }

export const bbox = (el: El): Box => ({
  x: Math.min(el.x, el.x + el.w),
  y: Math.min(el.y, el.y + el.h),
  w: Math.abs(el.w),
  h: Math.abs(el.h),
})

export function boundsOf(els: El[]): Box | null {
  if (!els.length) return null
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const el of els) {
    const b = bbox(el)
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y)
    x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h)
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
  const pad = tol + el.strokeWidth / 2
  if (isLinear(el)) return distSeg(px, py, el.x, el.y, el.x + el.w, el.y + el.h) <= pad
  if (el.type === 'freedraw') {
    const p = el.points!
    if (p.length === 1) return Math.hypot(px - el.x - p[0][0], py - el.y - p[0][1]) <= pad
    for (let i = 0; i < p.length - 1; i++) {
      if (distSeg(px, py, el.x + p[i][0], el.y + p[i][1], el.x + p[i + 1][0], el.y + p[i + 1][1]) <= pad) return true
    }
    return false
  }
  const b = bbox(el)
  const filled = el.fill !== 'transparent'
  if (el.type === 'text' || el.type === 'image') {
    return px >= b.x - pad && px <= b.x + b.w + pad && py >= b.y - pad && py <= b.y + b.h + pad
  }
  if (el.type === 'rectangle') {
    const outer = px >= b.x - pad && px <= b.x + b.w + pad && py >= b.y - pad && py <= b.y + b.h + pad
    if (!outer || filled) return outer
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
  const b = bbox(el), p = 6 / zoom
  return [
    { name: 'nw', x: b.x - p, y: b.y - p },
    { name: 'ne', x: b.x + b.w + p, y: b.y - p },
    { name: 'se', x: b.x + b.w + p, y: b.y + b.h + p },
    { name: 'sw', x: b.x - p, y: b.y + b.h + p },
  ]
}
