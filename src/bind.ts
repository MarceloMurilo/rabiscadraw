// Arrows and lines that stay attached to the elements at their ends, and follow them when they move, resize or rotate.
import type { El } from './types'
import { bbox, centerOf, rotatePt } from './geometry'
import { iconLayout } from './render'

const BINDABLE = ['rectangle', 'diamond', 'ellipse', 'icon', 'text', 'image']
const isLinear = (e: El) => e.type === 'arrow' || e.type === 'line'
const GAP = 3

type AttachShape = 'rect' | 'ellipse' | 'diamond'

// the part of an element an arrow touches: the icon square for icons (not their caption), the whole box otherwise
function attachBox(t: El): { x: number; y: number; w: number; h: number; shape: AttachShape } {
  if (t.type === 'icon') {
    const L = iconLayout(t)
    return { x: L.ix, y: L.iy, w: L.side, h: L.side, shape: 'rect' }
  }
  const b = bbox(t)
  return { ...b, shape: t.type === 'ellipse' ? 'ellipse' : t.type === 'diamond' ? 'diamond' : 'rect' }
}

function attachCenter(t: El) {
  const a = attachBox(t), rc = centerOf(t)
  const c = { x: a.x + a.w / 2, y: a.y + a.h / 2 }
  return t.angle ? rotatePt(c.x, c.y, rc.x, rc.y, t.angle) : c
}

// where the line from the element's centre towards (tx, ty) leaves its outline, plus a small gap
export function edgePoint(t: El, tx: number, ty: number, gap: number) {
  const a = attachBox(t), rc = centerOf(t), ang = t.angle ?? 0
  const q = ang ? rotatePt(tx, ty, rc.x, rc.y, -ang) : { x: tx, y: ty }
  const cx = a.x + a.w / 2, cy = a.y + a.h / 2
  let dx = q.x - cx, dy = q.y - cy
  if (!dx && !dy) dy = -1
  const hw = Math.max(a.w / 2, 1), hh = Math.max(a.h / 2, 1)
  const s = a.shape === 'ellipse'
    ? 1 / Math.hypot(dx / hw, dy / hh)
    : a.shape === 'diamond'
      ? 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh)
      : 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh)
  const len = Math.hypot(dx, dy)
  const px = cx + dx * s + (dx / len) * gap, py = cy + dy * s + (dy / len) * gap
  return ang ? rotatePt(px, py, rc.x, rc.y, ang) : { x: px, y: py }
}

// the point is inside the element (or within tol of it), whatever its rotation
function containsPt(t: El, x: number, y: number, tol: number) {
  const rc = centerOf(t)
  const q = t.angle ? rotatePt(x, y, rc.x, rc.y, -t.angle) : { x, y }
  const b = bbox(t)
  if (t.type === 'ellipse' || t.type === 'diamond') {
    const a = b.w / 2 + tol, c = b.h / 2 + tol
    if (a <= 0 || c <= 0) return false
    const dx = q.x - (b.x + b.w / 2), dy = q.y - (b.y + b.h / 2)
    return t.type === 'ellipse' ? (dx / a) ** 2 + (dy / c) ** 2 <= 1 : Math.abs(dx) / a + Math.abs(dy) / c <= 1
  }
  return q.x >= b.x - tol && q.x <= b.x + b.w + tol && q.y >= b.y - tol && q.y <= b.y + b.h + tol
}

// topmost element an arrow end dropped at (x, y) should attach to (the boxes drawn around diagram groups are skipped)
export function bindHit(els: El[], x: number, y: number, tol: number, exclude: string[]): El | null {
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i]
    if (!BINDABLE.includes(el.type) || el.frame || el.aux || exclude.includes(el.id)) continue
    if (containsPt(el, x, y, tol)) return el
  }
  return null
}

// moving an arrow on its own (without the elements it is attached to) lets it go
export function detachMoved(list: El[], moved: string[]): El[] {
  return list.map((e) => {
    if (!isLinear(e) || !moved.includes(e.id)) return e
    const s = !!e.bindStart && !moved.includes(e.bindStart)
    const t = !!e.bindEnd && !moved.includes(e.bindEnd)
    return s || t ? { ...e, bindStart: s ? undefined : e.bindStart, bindEnd: t ? undefined : e.bindEnd } : e
  })
}

// puts every attached end back on its element's outline; ends whose element is gone are released. Returns the same array when nothing changed.
export function rebind(els: El[]): El[] {
  let byId: Map<string, El> | null = null
  let out: El[] | null = null
  els.forEach((el, i) => {
    if (!isLinear(el) || (!el.bindStart && !el.bindEnd)) return
    byId ??= new Map(els.map((e) => [e.id, e]))
    const s = el.bindStart ? byId.get(el.bindStart) : undefined
    const e = el.bindEnd ? byId.get(el.bindEnd) : undefined
    let next = el
    if ((el.bindStart && !s) || (el.bindEnd && !e)) {
      next = { ...el, bindStart: s ? el.bindStart : undefined, bindEnd: e ? el.bindEnd : undefined }
    }
    let sx = next.x, sy = next.y, ex = next.x + next.w, ey = next.y + next.h
    const sRef = e ? attachCenter(e) : { x: ex, y: ey }
    const eRef = s ? attachCenter(s) : { x: sx, y: sy }
    if (s) { const p = edgePoint(s, sRef.x, sRef.y, GAP + next.strokeWidth); sx = p.x; sy = p.y }
    if (e) { const p = edgePoint(e, eRef.x, eRef.y, GAP + next.strokeWidth); ex = p.x; ey = p.y }
    if (Math.abs(sx - next.x) > 0.01 || Math.abs(sy - next.y) > 0.01 || Math.abs(ex - next.x - next.w) > 0.01 || Math.abs(ey - next.y - next.h) > 0.01) {
      next = { ...next, x: sx, y: sy, w: ex - sx, h: ey - sy }
    }
    if (next !== el) { out ??= [...els]; out[i] = next }
  })
  return out ?? els
}
