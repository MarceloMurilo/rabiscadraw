// The drawing seen as an architecture: nodes, connections and groups. Used by the MCP bridge so an
// agent can read what is on the board, wire new things to old ones and follow what the person changes.
import type { El } from './types'
import { boundsOf } from './geometry'
import { rebind } from './bind'
import { measureText } from './render'

const NODE_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'icon', 'text', 'image'])
const LINK_TYPES = new Set(['connector', 'arrow', 'line'])
const EDGE_FS = 14

export const isNode = (e: El) => NODE_TYPES.has(e.type) && !e.frame && !e.aux
export const isLink = (e: El) => LINK_TYPES.has(e.type) && !e.aux
const refOf = (e: El) => e.nid ?? e.id
const rid = () => crypto.randomUUID()
const seed = () => Math.floor(Math.random() * 2 ** 31)
const rnd = Math.round

// an agent names a node by the id it gave it, or by the element id
export function findNode(els: El[], ref: string): El | undefined {
  return els.find((e) => isNode(e) && (e.nid === ref || e.id === ref)) ?? els.find((e) => isNode(e) && e.id === ref)
}

export function readGraph(els: El[], drawing: string, version: number) {
  const nodes = els.filter(isNode)
  const refById = new Map(nodes.map((n) => [n.id, refOf(n)]))
  const labelOf = (id: string) => els.find((e) => e.aux && e.of === id && e.type === 'text')?.text
  const edges = els.filter(isLink).map((e) => {
    const a = e.from ?? e.bindStart, b = e.to ?? e.bindEnd
    return {
      id: e.id,
      from: a ? refById.get(a) ?? null : null,
      to: b ? refById.get(b) ?? null : null,
      ...(e.cap || labelOf(e.id) ? { label: e.cap ?? labelOf(e.id) } : {}),
      ...(e.type === 'line' || e.endArrow === false ? { kind: 'line' } : {}),
    }
  })
  const frames = els.filter((e) => e.frame)
  const groups = frames.map((f) => ({
    id: refOf(f),
    label: f.cap ?? els.find((e) => e.aux && e.of === f.id)?.text ?? '',
    nodes: nodes.filter((n) => n.grp && n.grp === f.nid).map(refOf),
  }))
  const connected = new Set<string>()
  edges.forEach((e) => { if (e.from) connected.add(e.from); if (e.to) connected.add(e.to) })
  const out = nodes.map((n) => ({
    id: refOf(n),
    ...(n.nid ? { element_id: n.id } : {}),
    type: n.type,
    ...(n.icon ? { kind: n.icon } : {}),
    ...(n.text ? { label: n.text } : {}),
    ...(n.description ? { description: n.description } : {}),
    ...(n.grp ? { group: n.grp } : {}),
    x: rnd(n.x), y: rnd(n.y), w: rnd(n.w), h: rnd(n.h),
  }))
  const others = els.filter((e) => !isNode(e) && !isLink(e) && !e.frame && !e.aux).map((e) => ({ id: e.id, type: e.type, x: rnd(e.x), y: rnd(e.y), w: rnd(e.w), h: rnd(e.h) }))
  return { drawing, version, nodes: out, edges, groups, ...(others.length ? { other_elements: others } : {}) }
}

// ---------- connecting existing nodes

export interface LinkSpec { from: El; to: El; label?: string | null; kind?: 'arrow' | 'line' | null }

// arrows attached to both nodes (they follow when the nodes move), each with its caption halfway
export function linkEls(all: El[], links: LinkSpec[]): El[] {
  const arrows: El[] = links.map((l) => ({
    id: rid(), type: l.kind === 'line' ? 'line' : 'arrow',
    x: l.from.x + l.from.w / 2, y: l.from.y + l.from.h / 2, w: l.to.x - l.from.x, h: l.to.y - l.from.y,
    stroke: '#343a40', fill: 'transparent', strokeWidth: 2, roughness: 0.6, seed: seed(),
    bindStart: l.from.id, bindEnd: l.to.id, cap: l.label || undefined,
  }))
  const fixed = rebind([...all, ...arrows]).slice(all.length)
  const out: El[] = []
  fixed.forEach((a, i) => {
    out.push(a)
    const text = links[i].label
    if (!text) return
    const m = measureText(text, EDGE_FS, 'excali')
    const mx = a.x + a.w / 2, my = a.y + a.h / 2
    out.push({
      id: rid(), aux: true, of: a.id, type: 'text', x: mx - m.w / 2, y: my - m.h - 6, w: m.w, h: m.h, stroke: '#495057', fill: 'transparent',
      strokeWidth: 1, roughness: 0.6, seed: 1, text, fontSize: EDGE_FS, fontFamily: 'excali',
    })
  })
  return out
}

// A node that was moved leaves its generated (routed) connectors behind: swap them for attached
// arrows, which follow the nodes. Their captions are carried to the new middle.
export function reattach(els: El[], moved: string[]): El[] {
  if (!moved.length) return els
  const touches = (e: El) => [e.from, e.to, e.bindStart, e.bindEnd].some((x) => x && moved.includes(x))
  const hit = (e: El) => isLink(e) && touches(e)
  if (!els.some(hit)) return els
  const swapped = els.map((e) => (e.type === 'connector' && hit(e) ? ({
    id: e.id, type: e.endArrow === false ? 'line' : 'arrow', x: e.x, y: e.y, w: 1, h: 1,
    stroke: e.stroke, fill: 'transparent', strokeWidth: e.strokeWidth, roughness: e.roughness, seed: e.seed,
    bindStart: e.from, bindEnd: e.to, cap: e.cap,
  } as El) : e))
  const ids = new Set(els.filter(hit).map((e) => e.id))
  const fixed = rebind(swapped)
  return fixed.map((e) => {
    if (!(e.aux && e.of && ids.has(e.of))) return e
    const a = fixed.find((x) => x.id === e.of)!
    return { ...e, x: a.x + a.w / 2 - e.w / 2, y: a.y + a.h / 2 - e.h - 6 }
  })
}

// ---------- where a new block goes

const GAP = 140
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

// Moves for a block of size (bw, bh) so it sits beside the nodes it connects to without covering anything.
// Returns the offset to add to the block, or null when nothing was linked.
export function placeBeside(existing: El[], anchors: El[], block: { x: number; y: number; w: number; h: number }, horizontal: boolean) {
  const ab = boundsOf(anchors)
  if (!ab) return null
  const rects = existing.map((e) => boundsOf([e])!).filter(Boolean)
  const cx = ab.x + ab.w / 2 - block.w / 2, cy = ab.y + ab.h / 2 - block.h / 2
  const right = (k: number) => ({ x: ab.x + ab.w + GAP, y: cy + k })
  const below = (k: number) => ({ x: cx + k, y: ab.y + ab.h + GAP })
  const left = (k: number) => ({ x: ab.x - GAP - block.w, y: cy + k })
  const above = (k: number) => ({ x: cx + k, y: ab.y - GAP - block.h })
  const order = horizontal ? [right, below, above, left] : [below, right, left, above]
  const step = horizontal ? block.h + 60 : block.w + 60
  for (const side of order) {
    for (const k of [0, step, -step, step * 2, -step * 2]) {
      const p = side(k)
      const r = { x: p.x - 40, y: p.y - 40, w: block.w + 80, h: block.h + 80 }
      if (!rects.some((q) => overlaps(r, q))) return { dx: p.x - block.x, dy: p.y - block.y, side: side === right ? 'direita' : side === below ? 'abaixo' : side === left ? 'esquerda' : 'acima' }
    }
  }
  return null
}

// ---------- what changed between two versions

const WATCHED: (keyof El)[] = ['text', 'description', 'icon', 'stroke', 'fill', 'x', 'y', 'w', 'h', 'bindStart', 'bindEnd', 'cap']

export function diffEls(before: El[], after: El[]) {
  const was = new Map(before.map((e) => [e.id, e]))
  const now = new Map(after.map((e) => [e.id, e]))
  const brief = (e: El) => ({ id: refOf(e), element_id: e.id, type: e.type, ...(e.text ? { label: e.text } : {}) })
  const added = after.filter((e) => !was.has(e.id) && !e.aux).map(brief)
  const removed = before.filter((e) => !now.has(e.id) && !e.aux).map(brief)
  const modified: unknown[] = []
  for (const e of after) {
    const o = was.get(e.id)
    if (!o || e.aux) continue
    const fields = WATCHED.filter((k) => {
      const a = o[k], b = e[k]
      return typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) > 0.5 : a !== b
    })
    if (fields.length) modified.push({ ...brief(e), changed: fields.map((f) => (f === 'text' ? 'label' : f)) })
  }
  return { added, removed, modified }
}
