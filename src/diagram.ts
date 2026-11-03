// Turns a DiagramSpec (nodes, edges, groups) into drawing elements: layered layout, right-angle
// connectors routed through the free channels between layers, and captions that avoid each other.
import type { El } from './types'
import type { CleanSpec, SpecEdge } from './spec'
import { COLORS, frameTints, iconById } from './catalog'
import type { ColorName } from './catalog'
import { measureText } from './render'

export const NODE_FS = 20
export const LABEL_FS = 16
export const EDGE_FS = 14
export const ICON_SIDE = 76
const GAP_MAIN = 130 // minimum space between layers
const GAP_CROSS = 34 // between nodes of the same layer
export const FRAME_PAD = 26
export const FRAME_TOP = 44
const SLOT = 22 // room per connector inside a channel

type Pt = [number, number]
interface Rect { x: number; y: number; w: number; h: number }

export interface Laid {
  i: number
  id: string
  kind?: string
  shape: 'rectangle' | 'ellipse' | 'diamond' | 'text'
  label: string
  color: ColorName
  group?: string
  description?: string
  w: number
  h: number
  x: number
  y: number
  side: number // icon square (icons only)
}

interface Plan {
  e: SpecEdge
  a: Laid
  b: Laid
  la: number
  lb: number
  g1: number // channel used next to the source
  g2: number // channel used next to the target
  k1: number // slot inside g1
  k2: number
  paired: boolean // the opposite edge exists too
  lw: number // caption size along the main axis
}

const rid = () => crypto.randomUUID()
const seed = () => Math.floor(Math.random() * 2 ** 31)

export function wrap(s: string, max = 22): string {
  return s
    .split('\n')
    .flatMap((line) => {
      const out: string[] = []
      let cur = ''
      for (const w of line.split(/\s+/).filter(Boolean)) {
        if (!cur) cur = w
        else if ((cur + ' ' + w).length <= max) cur += ' ' + w
        else { out.push(cur); cur = w }
      }
      out.push(cur)
      return out
    })
    .join('\n')
}

export function sizeNode(n: Laid) {
  if (n.kind) {
    const m = measureText(n.label, LABEL_FS, 'excali')
    n.side = ICON_SIDE
    n.w = Math.max(ICON_SIDE, m.w + 14)
    n.h = ICON_SIDE + (n.label ? m.h + 10 : 0)
    return
  }
  const m = measureText(n.label, NODE_FS, 'excali')
  if (n.shape === 'text') { n.w = m.w; n.h = m.h }
  else if (n.shape === 'diamond') { n.w = Math.max(150, m.w * 1.7 + 30); n.h = Math.max(84, m.h * 1.9 + 24) }
  else if (n.shape === 'ellipse') { n.w = Math.max(130, m.w * 1.35 + 36); n.h = Math.max(66, m.h * 1.5 + 22) }
  else { n.w = Math.max(120, m.w + 44); n.h = Math.max(56, m.h + 30) }
  n.side = 0
}

// The part of a node an arrow should touch (the drawing itself, not the caption under an icon).
function anchorOf(n: Laid) {
  if (n.kind) return { cx: n.x + n.w / 2, cy: n.y + n.side / 2, hw: n.side / 2, hh: n.side / 2, shape: 'rectangle' as const }
  return { cx: n.x + n.w / 2, cy: n.y + n.h / 2, hw: n.w / 2, hh: n.h / 2, shape: n.shape }
}

function borderPoint(a: ReturnType<typeof anchorOf>, tx: number, ty: number, gap: number): Pt {
  const dx = tx - a.cx, dy = ty - a.cy
  const len = Math.hypot(dx, dy) || 1
  let t: number
  if (a.shape === 'ellipse') t = 1 / Math.hypot(dx / a.hw, dy / a.hh)
  else if (a.shape === 'diamond') t = 1 / (Math.abs(dx) / a.hw + Math.abs(dy) / a.hh)
  else t = Math.min(a.hw / (Math.abs(dx) || 1e-9), a.hh / (Math.abs(dy) || 1e-9))
  const k = t + gap / len
  return [a.cx + dx * k, a.cy + dy * k]
}

const overlapArea = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))

// drops repeated points and the middle point of three in a row
function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (last && Math.abs(last[0] - p[0]) < 0.5 && Math.abs(last[1] - p[1]) < 0.5) continue
    out.push(p)
  }
  for (let i = out.length - 2; i > 0; i--) {
    const [a, b, c] = [out[i - 1], out[i], out[i + 1]]
    const sameX = Math.abs(a[0] - b[0]) < 0.5 && Math.abs(b[0] - c[0]) < 0.5
    const sameY = Math.abs(a[1] - b[1]) < 0.5 && Math.abs(b[1] - c[1]) < 0.5
    if (sameX || sameY) out.splice(i, 1)
  }
  return out
}

export function makeNodes(spec: CleanSpec): Laid[] {
  return spec.nodes.map((n, i) => {
    const def = iconById(n.kind)
    const laid: Laid = {
      i, id: n.id, kind: def?.id, shape: n.shape ?? 'rectangle', label: wrap(n.label, def ? 16 : 22),
      color: n.color ?? def?.color ?? 'default', group: n.group || undefined, description: n.description?.trim() || undefined, w: 0, h: 0, x: 0, y: 0, side: 0,
    }
    sizeNode(laid)
    return laid
  })
}

export function buildDiagram(spec: CleanSpec, origin: { x: number; y: number }) {
  const dir = spec.direction
  const horizontal = dir === 'LR'
  const nodes = makeNodes(spec)
  const idx = new Map(nodes.map((n) => [n.id, n.i]))
  const N = nodes.length

  // --- layering: longest path over the graph with back edges removed
  const out: number[][] = nodes.map(() => [])
  const inn: number[][] = nodes.map(() => [])
  for (const e of spec.edges) out[idx.get(e.from)!].push(idx.get(e.to)!)
  const state = new Array<number>(N).fill(0)
  const fwd: number[][] = nodes.map(() => [])
  const visit = (u: number) => {
    state[u] = 1
    for (const v of out[u]) {
      if (state[v] === 1) continue // back edge: ignored for layering
      fwd[u].push(v)
      if (state[v] === 0) visit(v)
    }
    state[u] = 2
  }
  const hasIn = new Set<number>()
  out.forEach((vs) => vs.forEach((v) => hasIn.add(v)))
  for (let i = 0; i < N; i++) if (!hasIn.has(i) && state[i] === 0) visit(i)
  for (let i = 0; i < N; i++) if (state[i] === 0) visit(i)
  fwd.forEach((vs, u) => vs.forEach((v) => inn[v].push(u)))

  const layer = new Array<number>(N).fill(0)
  const indeg = inn.map((x) => x.length)
  const queue = indeg.map((d, i) => (d === 0 ? i : -1)).filter((i) => i >= 0)
  while (queue.length) {
    const u = queue.shift()!
    for (const v of fwd[u]) {
      layer[v] = Math.max(layer[v], layer[u] + 1)
      if (--indeg[v] === 0) queue.push(v)
    }
  }
  const nLayers = Math.max(0, ...layer) + 1
  const layers: number[][] = Array.from({ length: nLayers }, () => [])
  for (let i = 0; i < N; i++) layers[layer[i]].push(i)

  // --- ordering inside each layer: barycenter sweeps
  const posIn = () => {
    const p = new Array<number>(N).fill(0)
    layers.forEach((l) => l.forEach((n, k) => { p[n] = k }))
    return p
  }
  const groupRank = new Map(spec.groups.map((g, i) => [g.id, i]))
  const regroup = (list: number[]) => {
    const slots = list.map((n, k) => (nodes[n].group ? k : -1)).filter((k) => k >= 0)
    const grouped = slots
      .map((k) => list[k])
      .sort((a, b) => (groupRank.get(nodes[a].group!) ?? 0) - (groupRank.get(nodes[b].group!) ?? 0))
    const res = [...list]
    slots.forEach((k, i) => { res[k] = grouped[i] })
    return res
  }
  for (let pass = 0; pass < 6; pass++) {
    const down = pass % 2 === 0
    const order = down ? layers.map((_, k) => k) : layers.map((_, k) => nLayers - 1 - k)
    for (const l of order) {
      const p = posIn()
      const neighbours = down ? inn : fwd
      const bary = (n: number) => {
        const ns = neighbours[n]
        return ns.length ? ns.reduce((s, m) => s + p[m], 0) / ns.length : p[n]
      }
      layers[l] = regroup([...layers[l]].sort((a, b) => bary(a) - bary(b) || a - b))
    }
  }

  // --- connector plans: which channel each edge uses, so channels can be made wide enough
  const pairSet = new Set(spec.edges.map((e) => `${e.from}>${e.to}`))
  const usersOf: Plan[][] = Array.from({ length: nLayers }, () => [])
  const plans: Plan[] = spec.edges.map((e) => {
    const a = nodes[idx.get(e.from)!], b = nodes[idx.get(e.to)!]
    const la = layer[a.i], lb = layer[b.i]
    let g1: number, g2: number
    if (lb > la) { g1 = la; g2 = lb - 1 } else if (lb < la) { g1 = la - 1; g2 = lb } else { g1 = g2 = la }
    const lm = e.label ? measureText(e.label, EDGE_FS, 'excali') : { w: 0, h: 0 }
    const p: Plan = { e, a, b, la, lb, g1, g2, k1: 0, k2: 0, paired: pairSet.has(`${e.to}>${e.from}`), lw: horizontal ? lm.w : lm.h }
    p.k1 = usersOf[g1].length
    usersOf[g1].push(p)
    if (g2 !== g1) { p.k2 = usersOf[g2].length; usersOf[g2].push(p) }
    return p
  })
  const gapWidth = usersOf.map((users, g) => {
    const labelNeed = Math.max(0, ...users.map((p) => (p.lw ? p.lw + 70 : 0)))
    const base = horizontal ? GAP_MAIN : GAP_MAIN - 30
    return Math.max(base, SLOT * (users.length + 1) + 30, labelNeed)
  })

  // --- coordinates
  // Each group gets its own lane across all layers (a band on the cross axis), so group frames can
  // never cut into each other. Nodes without a group share one extra lane placed first.
  const mainOf = (n: Laid) => (horizontal ? n.w : n.h)
  const crossOf = (n: Laid) => (horizontal ? n.h : n.w)
  const lanes: string[] = [
    ...(nodes.some((n) => !n.group) ? [''] : []),
    ...spec.groups.filter((g) => nodes.some((n) => n.group === g.id)).map((g) => g.id),
  ]
  const laneOf = (n: Laid) => lanes.indexOf(n.group ?? '')
  const totals = lanes.map(() => layers.map(() => 0)) // stacked size of each lane in each layer
  layers.forEach((l, li) => l.forEach((ni) => {
    const k = laneOf(nodes[ni])
    totals[k][li] += crossOf(nodes[ni]) + (totals[k][li] ? GAP_CROSS : 0)
  }))
  const laneSize = totals.map((t) => Math.max(0, ...t))
  const laneStart: number[] = []
  let acc = 0
  lanes.forEach((id, k) => { laneStart[k] = acc; acc += laneSize[k] + (id === '' ? 40 : FRAME_TOP + FRAME_PAD + 12) })
  const used = lanes.map(() => layers.map(() => 0))
  let cursor = 0
  layers.forEach((l, li) => {
    const size = Math.max(0, ...l.map((n) => mainOf(nodes[n])))
    l.forEach((ni) => {
      const nd = nodes[ni]
      const k = laneOf(nd)
      const c = laneStart[k] + (laneSize[k] - totals[k][li]) / 2 + used[k][li]
      used[k][li] += crossOf(nd) + GAP_CROSS
      const main = cursor + (size - mainOf(nd)) / 2
      if (horizontal) { nd.x = main; nd.y = c } else { nd.x = c; nd.y = main }
    })
    cursor += size + gapWidth[li]
  })
  // explicit coordinates from the caller win over the automatic ones (and turn off connector routing)
  let pinned = false
  spec.nodes.forEach((n, i) => {
    if (typeof n.x === 'number' && typeof n.y === 'number') { nodes[i].x = n.x; nodes[i].y = n.y; pinned = true }
  })

  const hasFrames = spec.groups.length > 0 && nodes.some((n) => n.group)
  const minX = Math.min(...nodes.map((n) => n.x)), minY = Math.min(...nodes.map((n) => n.y))
  const dx = origin.x - minX + (hasFrames ? FRAME_PAD : 0)
  const dy = origin.y - minY + (hasFrames ? FRAME_TOP : 0)
  nodes.forEach((n) => { n.x += dx; n.y += dy })

  const els: El[] = []
  const base = { strokeWidth: 2, roughness: 0.6 }
  const blocked: Rect[] = nodes.map((n) => ({ x: n.x - 4, y: n.y - 4, w: n.w + 8, h: n.h + 8 }))

  // --- group frames first so they sit behind everything
  const tints = frameTints(spec.groups)
  for (const [gi, g] of spec.groups.entries()) {
    const tint = tints[gi]
    const members = nodes.filter((n) => n.group === g.id)
    if (!members.length) continue
    const x1 = Math.min(...members.map((n) => n.x)) - FRAME_PAD
    const y1 = Math.min(...members.map((n) => n.y)) - FRAME_TOP
    const x2 = Math.max(...members.map((n) => n.x + n.w)) + FRAME_PAD
    const y2 = Math.max(...members.map((n) => n.y + n.h)) + FRAME_PAD
    const fid = rid()
    els.push({ id: fid, type: 'rectangle', x: x1, y: y1, w: x2 - x1, h: y2 - y1, stroke: tint.stroke, fill: tint.fill, fillStyle: 'solid', strokeWidth: 2, roughness: 0.6, seed: seed(), frame: true, nid: g.id, cap: g.label })
    const m = measureText(g.label, EDGE_FS + 2, 'excali')
    els.push({ id: rid(), aux: true, of: fid, type: 'text', x: x1 + 12, y: y1 + 10, w: m.w, h: m.h, stroke: '#495057', fill: 'transparent', strokeWidth: 1, roughness: 0.6, seed: 1, text: g.label, fontSize: EDGE_FS + 2, fontFamily: 'excali' })
    blocked.push({ x: x1 + 8, y: y1 + 6, w: m.w + 8, h: m.h + 8 })
  }

  // --- nodes
  const nodeIds: Record<string, string> = {}
  for (const n of nodes) {
    const c = COLORS[n.color]
    const id = rid()
    nodeIds[n.id] = id
    const common = { id, x: n.x, y: n.y, w: n.w, h: n.h, stroke: c.stroke, fill: c.fill, fillStyle: 'solid' as const, ...base, seed: seed(), fontFamily: 'excali', description: n.description, nid: n.id, grp: n.group }
    if (n.kind) els.push({ ...common, type: 'icon', icon: n.kind, text: n.label, fontSize: LABEL_FS })
    else if (n.shape === 'text') els.push({ ...common, type: 'text', fill: 'transparent', text: n.label, fontSize: NODE_FS })
    else els.push({ ...common, type: n.shape, text: n.label, fontSize: NODE_FS })
  }

  // --- connector routing, done on virtual axes: main = along the layers, cross = across them
  const vm = (x: number, y: number) => (horizontal ? x : y)
  const vc = (x: number, y: number) => (horizontal ? y : x)
  const real = (m: number, c: number): Pt => (horizontal ? [m, c] : [c, m])
  const vrect = (n: Laid) => ({ m1: vm(n.x, n.y), m2: vm(n.x + n.w, n.y + n.h), c1: vc(n.x, n.y), c2: vc(n.x + n.w, n.y + n.h) })
  const layerStart = layers.map((l) => Math.min(...l.map((n) => vrect(nodes[n]).m1)))
  const layerEnd = layers.map((l) => Math.max(...l.map((n) => vrect(nodes[n]).m2)))
  const axes = (n: Laid) => {
    const A = anchorOf(n)
    return horizontal
      ? { cm: A.cx, cc: A.cy, hm: A.hw, hc: A.hh }
      : { cm: A.cy, cc: A.cx, hm: A.hh, hc: A.hw }
  }

  // Several connectors on one side of a node are spread along that side (ordered by where they go,
  // so they cross as little as possible) instead of all starting from the same point.
  const startOff = new Map<Plan, number>()
  const endOff = new Map<Plan, number>()
  {
    type End = { p: Plan; start: boolean; other: number }
    const sides = new Map<string, { node: Laid; ends: End[] }>()
    const put = (node: Laid, side: 'lo' | 'hi', end: End) => {
      const key = `${node.i}:${side}`
      if (!sides.has(key)) sides.set(key, { node, ends: [] })
      sides.get(key)!.ends.push(end)
    }
    for (const p of plans) {
      const dirm = p.lb > p.la ? 1 : p.lb < p.la ? -1 : 0
      put(p.a, dirm >= 0 ? 'hi' : 'lo', { p, start: true, other: axes(p.b).cc })
      put(p.b, dirm > 0 ? 'lo' : 'hi', { p, start: false, other: axes(p.a).cc })
    }
    for (const { node, ends } of sides.values()) {
      ends.sort((x, y) => x.other - y.other)
      const n = ends.length
      const step = n > 1 ? Math.min(14, (axes(node).hc * 1.4) / (n - 1)) : 0
      ends.forEach((en, k) => (en.start ? startOff : endOff).set(en.p, (k - (n - 1) / 2) * step))
    }
  }
  const channelX = (g: number, k: number, count: number) => {
    const lo = layerEnd[g] + 14
    const hi = (g + 1 < nLayers ? layerStart[g + 1] : layerEnd[g] + gapWidth[g]) - 14
    return lo + ((hi - lo) * (k + 1)) / (count + 1)
  }
  const usedCross: number[] = []
  const pickCross = (p: Plan, x1: number, x2: number, cs: number, ce: number) => {
    const lo = Math.min(x1, x2), hi = Math.max(x1, x2)
    const others = nodes.filter((n) => n !== p.a && n !== p.b).map(vrect)
    const cands = new Set<number>([cs, ce])
    others.forEach((r) => { cands.add(r.c1 - 18); cands.add(r.c2 + 18) })
    const all = nodes.map(vrect)
    cands.add(Math.min(...all.map((r) => r.c1)) - 30)
    cands.add(Math.max(...all.map((r) => r.c2)) + 30)
    let best = cs, bestCost = Infinity
    for (const cy of cands) {
      const hit = others.some((r) => cy > r.c1 - 10 && cy < r.c2 + 10 && hi > r.m1 - 10 && lo < r.m2 + 10)
      const crowded = usedCross.some((u) => Math.abs(u - cy) < 12)
      const cost = Math.abs(cy - cs) + Math.abs(cy - ce) + (hit ? 1e6 : 0) + (crowded ? 40 : 0)
      if (cost < bestCost) { bestCost = cost; best = cy }
    }
    usedCross.push(best)
    return best
  }

  const routeOf = (p: Plan): Pt[] => {
    const A = anchorOf(p.a), B = anchorOf(p.b)
    if (pinned) {
      // coordinates were chosen by the caller: a plain straight connector
      return [borderPoint(A, B.cx, B.cy, 3), borderPoint(B, A.cx, A.cy, 4)]
    }
    const a = axes(p.a), b = axes(p.b)
    const cs = a.cc + (startOff.get(p) ?? 0), ce = b.cc + (endOff.get(p) ?? 0)
    const dirm = p.lb > p.la ? 1 : p.lb < p.la ? -1 : 0
    let pts: [number, number][]
    if (dirm === 0) {
      // same layer: leave and re-enter through the right side
      const x = channelX(p.g1, p.k1, usersOf[p.g1].length)
      pts = [[a.cm + a.hm, cs], [x, cs], [x, ce], [b.cm + b.hm, ce]]
    } else {
      const ms = a.cm + dirm * a.hm, me = b.cm - dirm * b.hm
      if (p.g1 === p.g2) {
        const x = channelX(p.g1, p.k1, usersOf[p.g1].length)
        pts = Math.abs(cs - ce) < 1.5 ? [[ms, cs], [me, cs]] : [[ms, cs], [x, cs], [x, ce], [me, ce]]
      } else {
        const x1 = channelX(p.g1, p.k1, usersOf[p.g1].length)
        const x2 = channelX(p.g2, p.k2, usersOf[p.g2].length)
        const cy = pickCross(p, x1, x2, cs, ce)
        pts = [[ms, cs], [x1, cs], [x1, cy], [x2, cy], [x2, ce], [me, ce]]
      }
    }
    return simplify(pts.map(([m, c]) => real(m, c)))
  }

  // --- connectors and their captions
  const segRect = (a: Pt, b: Pt): Rect => ({ x: Math.min(a[0], b[0]) - 3, y: Math.min(a[1], b[1]) - 3, w: Math.abs(a[0] - b[0]) + 6, h: Math.abs(a[1] - b[1]) + 6 })
  const routes = plans.map(routeOf)
  const segsOf = routes.map((pts) => pts.slice(1).map((q, k) => segRect(pts[k], q)))

  const connIds = plans.map(() => rid())
  plans.forEach((p, ei) => {
    const pts = routes[ei]
    const minX1 = Math.min(...pts.map((q) => q[0])), minY1 = Math.min(...pts.map((q) => q[1]))
    const maxX1 = Math.max(...pts.map((q) => q[0])), maxY1 = Math.max(...pts.map((q) => q[1]))
    els.push({
      id: connIds[ei], from: nodeIds[p.a.id], to: nodeIds[p.b.id], cap: p.e.label || undefined, type: 'connector', x: minX1, y: minY1, w: maxX1 - minX1, h: maxY1 - minY1,
      points: pts.map(([px, py]) => [px - minX1, py - minY1]), endArrow: p.e.kind !== 'line',
      stroke: '#343a40', fill: 'transparent', ...base, seed: seed(),
    })
  })

  // Captions go last: for each one, try spots next to its own line (longest segment first) and keep the
  // first that touches no node, no other caption and no other connector; otherwise the least bad one.
  plans.forEach((p, ei) => {
    if (!p.e.label) return
    const m = measureText(p.e.label, EDGE_FS, 'excali')
    const pts = routes[ei]
    const segs = pts.slice(1).map((q, k) => ({ a: pts[k], b: q, len: Math.hypot(q[0] - pts[k][0], q[1] - pts[k][1]) })).sort((s, t) => t.len - s.len)
    const foreign = segsOf.flatMap((list, k) => (k === ei ? [] : list))
    const cands: Rect[] = []
    for (const s of segs.filter((x) => x.len >= 24)) {
      const isH = Math.abs(s.a[1] - s.b[1]) < Math.abs(s.a[0] - s.b[0])
      for (const f of [0.5, 0.3, 0.7, 0.15, 0.85]) {
        const px = s.a[0] + (s.b[0] - s.a[0]) * f, py = s.a[1] + (s.b[1] - s.a[1]) * f
        for (const side of [-1, 1]) {
          cands.push(isH
            ? { x: px - m.w / 2, y: side < 0 ? py - m.h - 5 : py + 5, w: m.w, h: m.h }
            : { x: side > 0 ? px + 7 : px - m.w - 7, y: py - m.h / 2, w: m.w, h: m.h })
        }
      }
    }
    if (!cands.length) {
      const q = pts[Math.floor(pts.length / 2)]
      cands.push({ x: q[0] - m.w / 2, y: q[1] - m.h - 5, w: m.w, h: m.h })
    }
    let best = cands[0], bestScore = Infinity
    for (const c of cands) {
      let score = 0
      for (const r of blocked) score += overlapArea(c, r)
      for (const r of foreign) score += overlapArea(c, r) * 2
      if (score < bestScore) { bestScore = score; best = c }
      if (score === 0) break
    }
    blocked.push({ x: best.x - 3, y: best.y - 2, w: best.w + 6, h: best.h + 4 })
    els.push({
      id: rid(), aux: true, of: connIds[ei], type: 'text', x: best.x, y: best.y, w: m.w, h: m.h, stroke: '#495057', fill: 'transparent',
      strokeWidth: 1, roughness: 0.6, seed: 1, text: p.e.label, fontSize: EDGE_FS, fontFamily: 'excali',
    })
  })
  return { els, nodeIds }
}
