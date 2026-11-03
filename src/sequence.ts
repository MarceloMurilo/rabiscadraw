// Lays out a UML sequence diagram: participants across the top with dashed lifelines, messages top to
// bottom in order, activation bars, notes and alt / opt / loop fragments. Deterministic, no layout engine.
import type { El } from './types'
import type { SequenceSpec } from './spec'
import { COLORS, iconById } from './catalog'
import { measureText } from './render'
import { wrap } from './diagram'

const FS = 14 // message text
const HEAD_FS = 16 // participant caption
const SIDE = 60 // icon square
const BAR = 12 // activation bar width
const rid = () => crypto.randomUUID()
const seed = () => Math.floor(Math.random() * 2 ** 31)

interface Col { id: string; label: string; kind?: string; desc?: string; w: number; h: number; side: number; x: number }
interface Frag { kind: string; label: string; yTop: number; min: number; max: number; elseAt?: number; elseLabel?: string }

export function buildSequence(spec: SequenceSpec, origin: { x: number; y: number }) {
  const cols: Col[] = spec.participants.map((p) => {
    const def = iconById(p.kind)
    const m = measureText(wrap(p.label, def ? 16 : 20), HEAD_FS, 'excali')
    return def
      ? { id: p.id, label: wrap(p.label, 16), kind: def.id, desc: p.description?.trim() || undefined, w: Math.max(SIDE, m.w + 14), h: SIDE + m.h + 10, side: SIDE, x: 0 }
      : { id: p.id, label: wrap(p.label, 20), desc: p.description?.trim() || undefined, w: Math.max(110, m.w + 36), h: Math.max(44, m.h + 22), side: 0, x: 0 }
  })
  const at = new Map(cols.map((c, i) => [c.id, i]))

  // ---- horizontal: gaps between columns grow until every message caption fits
  const gap = cols.slice(1).map((c, i) => Math.max(170, (cols[i].w + c.w) / 2 + 40))
  const msgs = spec.steps.filter((s) => s.type === 'message').map((s) => ({
    a: at.get(s.from!)!, b: at.get(s.to!)!, lw: s.label ? measureText(s.label, FS, 'excali').w : 0,
  }))
  for (const m of [...msgs].filter((x) => x.a !== x.b).sort((p, q) => Math.abs(p.a - p.b) - Math.abs(q.a - q.b))) {
    const lo = Math.min(m.a, m.b), hi = Math.max(m.a, m.b)
    let sum = 0
    for (let i = lo; i < hi; i++) sum += gap[i]
    const need = m.lw + 56
    if (sum < need) for (let i = lo; i < hi; i++) gap[i] += (need - sum) / (hi - lo)
  }
  // a message to itself needs room to its right
  let tail = 0
  for (const m of msgs.filter((x) => x.a === x.b)) {
    const need = m.lw + 96
    if (m.a < gap.length) gap[m.a] = Math.max(gap[m.a], need + cols[m.a + 1].w / 2)
    else tail = Math.max(tail, need)
  }
  const left = origin.x + Math.max(cols[0].w / 2, 44)
  cols.forEach((c, i) => { c.x = i === 0 ? left : cols[i - 1].x + gap[i - 1] })

  // ---- vertical
  const els: El[] = []
  const frames: El[] = [], lifelines: El[] = [], bars: El[] = [], heads: El[] = [], arrows: El[] = [], notes: El[] = [], texts: El[] = [], tagBgs: El[] = []
  const headH = Math.max(...cols.map((c) => c.h))
  let y = origin.y + headH + 26
  const nodeIds: Record<string, string> = {}

  // participants
  for (const c of cols) {
    const id = rid()
    nodeIds[c.id] = id
    const d = iconById(c.kind)
    const color = COLORS[d?.color ?? 'default']
    const common = { id, x: c.x - c.w / 2, y: origin.y, w: c.w, h: c.h, stroke: color.stroke, fill: color.fill, fillStyle: 'solid' as const, strokeWidth: 2, roughness: 0.6, seed: seed(), fontFamily: 'excali', description: c.desc, nid: c.id }
    if (c.kind) heads.push({ ...common, type: 'icon', icon: c.kind, text: c.label, fontSize: 16 })
    else heads.push({ ...common, type: 'rectangle', stroke: '#1e1e1e', fill: '#f1f3f5', text: c.label, fontSize: HEAD_FS })
  }

  const open: Frag[] = []
  const stacks: { y1: number }[][] = cols.map(() => [])
  const lastTouch: number[] = cols.map(() => y)
  let fragN = 0
  const touch = (idx: number, x1: number, x2: number) => {
    for (const f of open) { f.min = Math.min(f.min, x1); f.max = Math.max(f.max, x2) }
    lastTouch[idx] = y
  }
  const bar = (i: number, y1: number, y2: number) => {
    bars.push({ id: rid(), aux: true, type: 'rectangle', x: cols[i].x - BAR / 2, y: y1, w: BAR, h: Math.max(y2 - y1, 24), stroke: '#495057', fill: '#fff', fillStyle: 'solid', strokeWidth: 1, roughness: 0.4, seed: seed() })
  }
  const closeFrag = (f: Frag, yBottom: number) => {
    const x1 = f.min - 26, x2 = f.max + 26
    const fid = rid()
    frames.push({ id: fid, frame: true, nid: `frag${++fragN}`, cap: `${f.kind}${f.label ? ` [${f.label}]` : ''}`, type: 'rectangle', x: x1, y: f.yTop, w: x2 - x1, h: yBottom - f.yTop, stroke: '#868e96', fill: 'transparent', strokeWidth: 1, roughness: 0.5, seed: seed() })
    const tag = `${f.kind}${f.label ? `  [${f.label}]` : ''}`
    const tm = measureText(tag, FS, 'excali')
    tagBgs.push({ id: rid(), aux: true, type: 'rectangle', x: x1 + 4, y: f.yTop + 3, w: tm.w + 8, h: tm.h + 6, stroke: '#fff', fill: '#fff', fillStyle: 'solid', strokeWidth: 1, roughness: 0, seed: 1 })
    texts.push({ id: rid(), aux: true, of: fid, type: 'text', x: x1 + 8, y: f.yTop + 6, w: tm.w, h: tm.h, stroke: '#495057', fill: 'transparent', strokeWidth: 1, roughness: 0.6, seed: 1, text: tag, fontSize: FS, fontFamily: 'excali' })
    if (f.elseAt) {
      lifelines.push({ id: rid(), aux: true, type: 'line', x: x1, y: f.elseAt, w: x2 - x1, h: 0, stroke: '#868e96', fill: 'transparent', strokeWidth: 1, roughness: 0.4, seed: seed(), dash: true })
      const label = `[${f.elseLabel || 'senão'}]`
      const em = measureText(label, FS, 'excali')
      tagBgs.push({ id: rid(), aux: true, type: 'rectangle', x: x1 + 4, y: f.elseAt + 2, w: em.w + 8, h: em.h + 6, stroke: '#fff', fill: '#fff', fillStyle: 'solid', strokeWidth: 1, roughness: 0, seed: 1 })
      texts.push({ id: rid(), aux: true, of: fid, type: 'text', x: x1 + 8, y: f.elseAt + 4, w: em.w, h: em.h, stroke: '#495057', fill: 'transparent', strokeWidth: 1, roughness: 0.6, seed: 1, text: label, fontSize: FS, fontFamily: 'excali' })
    }
  }

  for (const s of spec.steps) {
    if (s.type === 'message') {
      const a = at.get(s.from!)!, b = at.get(s.to!)!
      const text = s.label ?? ''
      const m = text ? measureText(text, FS, 'excali') : { w: 0, h: 0 }
      const style = s.style ?? 'call'
      if (a === b) {
        const x = cols[a].x + (stacks[a].length ? BAR / 2 : 0)
        const yA = y + m.h + 12
        const pts: [number, number][] = [[0, 0], [46, 0], [46, 26], [0, 26]]
        const cid = rid()
        arrows.push({ id: cid, from: nodeIds[s.from!], to: nodeIds[s.to!], cap: text || undefined, type: 'connector', x, y: yA, w: 46, h: 26, points: pts, endArrow: true, stroke: '#343a40', fill: 'transparent', strokeWidth: 2, roughness: 0.6, seed: seed(), dash: style === 'return' })
        if (text) texts.push({ id: rid(), aux: true, of: cid, type: 'text', x: x + 54, y: yA + (26 - m.h) / 2, w: m.w, h: m.h, stroke: '#495057', fill: 'transparent', strokeWidth: 1, roughness: 0.6, seed: 1, text, fontSize: FS, fontFamily: 'excali' })
        touch(a, cols[a].x - 6, x + 54 + m.w)
        y = yA + 26 + 24
        continue
      }
      const yA = y + m.h + 12
      const dir = cols[b].x > cols[a].x ? 1 : -1
      let offS = 0, offT = 0
      if (style === 'return') {
        offS = stacks[a].length ? BAR / 2 : 0
        offT = stacks[b].length ? BAR / 2 : 0
        if (stacks[a].length) bar(a, stacks[a].pop()!.y1, yA)
      } else {
        offS = stacks[a].length ? BAR / 2 : 0
        offT = BAR / 2
        if (style === 'call') stacks[b].push({ y1: yA - 6 })
      }
      const xs = cols[a].x + dir * offS, xt = cols[b].x - dir * offT
      const id = rid()
      arrows.push({ id, from: nodeIds[s.from!], to: nodeIds[s.to!], cap: text || undefined, type: 'arrow', x: xs, y: yA, w: xt - xs, h: 0, stroke: '#343a40', fill: 'transparent', strokeWidth: style === 'return' ? 1.5 : 2, roughness: 0.6, seed: seed(), dash: style === 'return' })
      if (text) texts.push({ id: rid(), aux: true, of: id, type: 'text', x: (xs + xt) / 2 - m.w / 2, y: yA - m.h - 4, w: m.w, h: m.h, stroke: '#495057', fill: 'transparent', strokeWidth: 1, roughness: 0.6, seed: 1, text, fontSize: FS, fontFamily: 'excali' })
      touch(a, Math.min(xs, xt), Math.max(xs, xt))
      touch(b, Math.min(xs, xt), Math.max(xs, xt))
      y = yA + 22
    } else if (s.type === 'note') {
      const i = at.get(s.over!)!
      const m = measureText(s.label!, FS, 'excali')
      const w = m.w + 26, h = m.h + 16
      const ny = y + 6
      notes.push({ id: rid(), type: 'rectangle', x: cols[i].x - w / 2, y: ny, w, h, stroke: '#e67700', fill: '#fff3bf', fillStyle: 'solid', strokeWidth: 1, roughness: 0.5, seed: seed(), text: s.label!, fontSize: FS, fontFamily: 'excali' })
      touch(i, cols[i].x - w / 2, cols[i].x + w / 2)
      y = ny + h + 16
    } else if (s.type === 'begin') {
      open.push({ kind: s.kind ?? 'opt', label: s.label ?? '', yTop: y + 2, min: Infinity, max: -Infinity })
      y += 34
    } else if (s.type === 'else') {
      const f = open[open.length - 1]
      if (f) { f.elseAt = y + 6; f.elseLabel = s.label ?? ''; y += 30 }
    } else if (s.type === 'end') {
      const f = open.pop()
      if (f) {
        if (!isFinite(f.min)) { f.min = cols[0].x - 30; f.max = cols[cols.length - 1].x + 30 }
        closeFrag(f, y + 4)
        for (const p of open) { p.min = Math.min(p.min, f.min - 26); p.max = Math.max(p.max, f.max + 26) }
        y += 24
      }
    }
  }
  // activations that never got a return end at the participant's last message
  cols.forEach((_, i) => { for (const a of stacks[i]) bar(i, a.y1, Math.max(lastTouch[i] + 6, a.y1 + 24)) })

  const bottom = y + 10
  cols.forEach((c) => {
    const top = origin.y + c.h
    lifelines.push({ id: rid(), aux: true, type: 'line', x: c.x, y: top, w: 0, h: bottom - top, stroke: '#868e96', fill: 'transparent', strokeWidth: 1, roughness: 0.4, seed: seed(), dash: true })
  })
  els.push(...frames, ...lifelines, ...bars, ...tagBgs, ...heads, ...arrows, ...texts, ...notes)
  return { els, nodeIds }
}
