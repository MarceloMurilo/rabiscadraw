// Lays a diagram out with ELK (the Eclipse Layout Kernel): groups are real containers, the nodes of a
// group stay together, connectors are routed around nodes and their captions get room of their own.
// Falls back to the hand-made layout in diagram.ts when ELK is not usable (or coordinates were given).
import type { El } from './types'
import type { CleanSpec } from './spec'
import { COLORS, frameTints } from './catalog'
import { measureText } from './render'
import { EDGE_FS, FRAME_PAD, FRAME_TOP, LABEL_FS, NODE_FS, buildDiagram, makeNodes } from './diagram'

type Pt = [number, number]
const rid = () => crypto.randomUUID()
const seed = () => Math.floor(Math.random() * 2 ** 31)

let elkPromise: Promise<any> | null = null
const loadElk = () => (elkPromise ??= import('elkjs/lib/elk.bundled.js').then((m: any) => new (m.default ?? m)()))

// repeated points and the middle point of three in a row go away
function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of pts) {
    const l = out[out.length - 1]
    if (l && Math.abs(l[0] - p[0]) < 0.5 && Math.abs(l[1] - p[1]) < 0.5) continue
    out.push(p)
  }
  for (let i = out.length - 2; i > 0; i--) {
    const [a, b, c] = [out[i - 1], out[i], out[i + 1]]
    if ((Math.abs(a[0] - b[0]) < 0.5 && Math.abs(b[0] - c[0]) < 0.5) || (Math.abs(a[1] - b[1]) < 0.5 && Math.abs(b[1] - c[1]) < 0.5)) out.splice(i, 1)
  }
  return out
}

// leave a small gap at both ends so the line does not touch the drawing
function gapEnds(pts: Pt[], a: number, b: number): Pt[] {
  if (pts.length < 2) return pts
  const out = pts.map((p) => [...p] as Pt)
  const pull = (from: Pt, to: Pt, d: number): Pt => {
    const dx = to[0] - from[0], dy = to[1] - from[1], len = Math.hypot(dx, dy) || 1
    return d >= len ? from : [from[0] + (dx / len) * d, from[1] + (dy / len) * d]
  }
  out[0] = pull(out[0], out[1], a)
  const n = out.length
  out[n - 1] = pull(out[n - 1], out[n - 2], b)
  return out
}

export async function buildDiagramAuto(spec: CleanSpec, origin: { x: number; y: number }): Promise<{ els: El[]; nodeIds: Record<string, string> }> {
  const pinned = spec.nodes.some((n) => typeof n.x === 'number' && typeof n.y === 'number')
  if (pinned) return buildDiagram(spec, origin)
  try {
    return await layoutWithElk(spec, origin)
  } catch (e) {
    console.warn('ELK layout failed, using the simple layout', e)
    return buildDiagram(spec, origin)
  }
}

async function layoutWithElk(spec: CleanSpec, origin: { x: number; y: number }) {
  const elk = await loadElk()
  const nodes = makeNodes(spec)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const groupsUsed = spec.groups.filter((g) => nodes.some((n) => n.group === g.id))

  const elkNode = (n: (typeof nodes)[number]) => {
    const node: any = { id: `n:${n.id}` }
    if (n.kind) {
      // only the icon square takes part in routing; the caption hangs below it as an outside label
      node.width = n.side
      node.height = n.side
      if (n.label) {
        const m = measureText(n.label, LABEL_FS, 'excali')
        node.labels = [{ text: n.label, width: m.w + 14, height: m.h + 10, layoutOptions: { 'elk.nodeLabels.placement': '[H_CENTER, V_BOTTOM, OUTSIDE]' } }]
      }
    } else {
      node.width = n.w
      node.height = n.h
    }
    return node
  }

  const children: any[] = nodes.filter((n) => !n.group || !groupsUsed.some((g) => g.id === n.group)).map(elkNode)
  for (const g of groupsUsed) {
    children.push({
      id: `g:${g.id}`,
      layoutOptions: { 'elk.padding': `[top=${FRAME_TOP + 6},left=${FRAME_PAD + 4},bottom=${FRAME_PAD + 4},right=${FRAME_PAD + 4}]` },
      children: nodes.filter((n) => n.group === g.id).map(elkNode),
    })
  }
  const edges = spec.edges.map((e, i) => {
    const lm = e.label ? measureText(e.label, EDGE_FS, 'excali') : null
    return {
      id: `e${i}`, sources: [`n:${e.from}`], targets: [`n:${e.to}`],
      ...(lm ? { labels: [{ text: e.label, width: lm.w + 10, height: lm.h + 6, layoutOptions: { 'elk.edgeLabels.placement': 'CENTER' } }] } : {}),
    }
  })

  const run = (horizontal: boolean) => elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': horizontal ? 'RIGHT' : 'DOWN',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': '[top=10,left=10,bottom=10,right=10]',
      'elk.spacing.nodeNode': '40',
      'elk.layered.spacing.nodeNodeBetweenLayers': '70',
      'elk.spacing.edgeNode': '26',
      'elk.spacing.edgeEdge': '16',
      'elk.layered.spacing.edgeNodeBetweenLayers': '26',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '16',
      'elk.spacing.edgeLabel': '4',
      'elk.spacing.labelNode': '6',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.nodePlacement.favorStraightEdges': 'true',
    },
    children: structuredClone(children),
    edges: structuredClone(edges),
  })

  // try both directions and keep the one that comes out closest to a screen (a long chain of groups is unreadable)
  const preferred = spec.direction === 'LR'
  const [first, second] = await Promise.all([run(preferred), run(!preferred)])
  const score = (g: any) => Math.abs(Math.log(g.width / g.height / 1.6))
  const graph = score(second) + 0.3 < score(first) ? second : first

  // absolute position of every node and group (ELK gives them relative to their parent)
  const abs = new Map<string, { x: number; y: number; w: number; h: number }>()
  const walk = (n: any, ox: number, oy: number) => {
    for (const c of n.children ?? []) {
      const x = ox + c.x, y = oy + c.y
      abs.set(c.id, { x, y, w: c.width, h: c.height })
      walk(c, x, y)
    }
  }
  walk(graph, 0, 0)
  const minX = Math.min(...[...abs.values()].map((r) => r.x)), minY = Math.min(...[...abs.values()].map((r) => r.y))
  const dx = origin.x - minX, dy = origin.y - minY

  const els: El[] = []
  const base = { strokeWidth: 2, roughness: 0.6 }

  // group frames first so they sit behind everything
  const tints = frameTints(groupsUsed)
  for (const [gi, g] of groupsUsed.entries()) {
    const tint = tints[gi]
    const r = abs.get(`g:${g.id}`)!
    const fid = rid()
    els.push({ id: fid, type: 'rectangle', x: r.x + dx, y: r.y + dy, w: r.w, h: r.h, stroke: tint.stroke, fill: tint.fill, fillStyle: 'solid', strokeWidth: 2, roughness: 0.6, seed: seed(), frame: true, nid: g.id, cap: g.label })
    const m = measureText(g.label, EDGE_FS + 2, 'excali')
    els.push({ id: rid(), aux: true, of: fid, type: 'text', x: r.x + dx + 12, y: r.y + dy + 10, w: m.w, h: m.h, stroke: '#495057', fill: 'transparent', strokeWidth: 1, roughness: 0.6, seed: 1, text: g.label, fontSize: EDGE_FS + 2, fontFamily: 'excali' })
  }

  const nodeIds: Record<string, string> = {}
  for (const n of nodes) {
    const r = abs.get(`n:${n.id}`)!
    const c = COLORS[n.color]
    const id = rid()
    nodeIds[n.id] = id
    // an icon element is wider than its square when the caption is wider; the square stays centred on ELK's box
    const x = n.kind ? r.x + dx + r.w / 2 - n.w / 2 : r.x + dx
    const common = { id, x, y: r.y + dy, w: n.w, h: n.h, stroke: c.stroke, fill: c.fill, fillStyle: 'solid' as const, ...base, seed: seed(), fontFamily: 'excali', description: n.description, nid: n.id, grp: n.group }
    if (n.kind) els.push({ ...common, type: 'icon', icon: n.kind, text: n.label, fontSize: LABEL_FS })
    else if (n.shape === 'text') els.push({ ...common, type: 'text', fill: 'transparent', text: n.label, fontSize: NODE_FS })
    else els.push({ ...common, type: n.shape, text: n.label, fontSize: NODE_FS })
  }

  // connectors, then their captions
  const labels: El[] = []
  const rel = (e: any) => {
    // edge coordinates are relative to their container (the root unless ELK says otherwise)
    const c = e.container && e.container !== 'root' ? abs.get(e.container) : null
    return c ? { x: c.x, y: c.y } : { x: 0, y: 0 }
  }
  graph.edges.forEach((e: any, i: number) => {
    const sec = e.sections?.[0]
    if (!sec) return
    const o = rel(e)
    const raw: Pt[] = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].map((p: any) => [p.x + o.x + dx, p.y + o.y + dy] as Pt)
    const pts = gapEnds(simplify(raw), 3, 4)
    const x1 = Math.min(...pts.map((p) => p[0])), y1 = Math.min(...pts.map((p) => p[1]))
    const x2 = Math.max(...pts.map((p) => p[0])), y2 = Math.max(...pts.map((p) => p[1]))
    const spec_e = spec.edges[i]
    const cid = rid()
    els.push({
      id: cid, from: nodeIds[spec_e.from], to: nodeIds[spec_e.to], cap: spec_e.label || undefined, type: 'connector',
      x: x1, y: y1, w: x2 - x1, h: y2 - y1, points: pts.map(([px, py]) => [px - x1, py - y1]), endArrow: spec_e.kind !== 'line',
      stroke: '#343a40', fill: 'transparent', ...base, seed: seed(),
    })
    const l = e.labels?.[0]
    if (l && spec_e.label) {
      const m = measureText(spec_e.label, EDGE_FS, 'excali')
      labels.push({
        id: rid(), aux: true, of: cid, type: 'text', x: l.x + o.x + dx + (l.width - m.w) / 2, y: l.y + o.y + dy + (l.height - m.h) / 2, w: m.w, h: m.h,
        stroke: '#495057', fill: 'transparent', strokeWidth: 1, roughness: 0.6, seed: 1, text: spec_e.label, fontSize: EDGE_FS, fontFamily: 'excali',
      })
    }
  })
  els.push(...labels)
  return { els, nodeIds }
}
