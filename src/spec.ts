// The diagram description exchanged with the LLM and with MCP agents. Pure data, no DOM.
import { iconById } from './catalog'
import type { ColorName } from './catalog'

export interface SpecNode {
  id: string
  label: string
  kind?: string | null // component id from the catalog (database, load_balancer, ...)
  shape?: 'rectangle' | 'ellipse' | 'diamond' | 'text' | null // only used when there is no kind
  color?: ColorName | null
  group?: string | null
  description?: string | null // optional: what this component does in the architecture
  x?: number | null
  y?: number | null
}
export interface SpecEdge { from: string; to: string; label?: string | null; kind?: 'arrow' | 'line' | null }
export interface SpecGroup { id: string; label: string; color?: string | null }
export interface DiagramSpec {
  title?: string | null
  direction?: 'LR' | 'TB' | null
  nodes: SpecNode[]
  edges?: SpecEdge[] | null
  groups?: SpecGroup[] | null
}

export interface CleanSpec {
  title?: string
  direction: 'LR' | 'TB'
  nodes: SpecNode[]
  edges: SpecEdge[]
  groups: SpecGroup[]
}

// Makes whatever came from a model or an agent safe to lay out: unique ids, no dangling edges,
// unknown components dropped, groups that nodes mention but nobody declared get created.
export function normalizeSpec(spec: DiagramSpec): CleanSpec {
  const seen = new Set<string>()
  const nodes: SpecNode[] = []
  for (const n of (spec.nodes ?? []).slice(0, 80)) {
    let id = String(n.id || `n${nodes.length + 1}`)
    while (seen.has(id)) id += '_'
    seen.add(id)
    nodes.push({
      ...n,
      id,
      label: String(n.label ?? ''),
      kind: iconById(n.kind) ? n.kind : undefined,
      group: n.group || undefined,
    })
  }
  // an edge may still reference an id that was renamed above only if ids were duplicated; keep first match
  const ids = new Set(nodes.map((n) => n.id))
  const edges = (spec.edges ?? []).filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to).slice(0, 200)
  const groups = [...(spec.groups ?? [])]
  for (const n of nodes) {
    if (n.group && !groups.some((g) => g.id === n.group)) groups.push({ id: n.group, label: n.group })
  }
  return { title: spec.title || undefined, direction: spec.direction ?? 'LR', nodes, edges, groups }
}

// ---------- UML sequence diagram (participants and ordered steps)

export interface SeqParticipant {
  id: string
  label: string
  kind?: string | null // component id from the catalog; none = a plain box
  description?: string | null
}
// A flat list keeps it easy for models: fragments are opened with `begin` and closed with `end`.
export interface SeqStep {
  type: 'message' | 'note' | 'begin' | 'else' | 'end'
  from?: string | null // message: sender
  to?: string | null // message: receiver (same as sender = a message to itself)
  label?: string | null // message text; note text; fragment condition; else condition
  style?: 'call' | 'return' | 'async' | null // message: call (default), return (dashed), async
  over?: string | null // note: participant it sits over
  kind?: 'alt' | 'opt' | 'loop' | null // begin: kind of fragment
}
export interface SequenceSpec {
  title?: string | null
  participants: SeqParticipant[]
  steps: SeqStep[]
}

// Safe to lay out: unique ids, no messages to unknown participants, balanced fragments.
export function normalizeSequence(spec: SequenceSpec): SequenceSpec {
  const seen = new Set<string>()
  const participants: SeqParticipant[] = []
  for (const p of (spec.participants ?? []).slice(0, 12)) {
    let id = String(p.id || `p${participants.length + 1}`)
    while (seen.has(id)) id += '_'
    seen.add(id)
    participants.push({ ...p, id, label: String(p.label ?? id), kind: iconById(p.kind) ? p.kind : undefined })
  }
  const ids = new Set(participants.map((p) => p.id))
  const steps: SeqStep[] = []
  let open = 0
  for (const s of (spec.steps ?? []).slice(0, 90)) {
    if (s.type === 'message') {
      if (s.from && s.to && ids.has(s.from) && ids.has(s.to)) steps.push(s)
    } else if (s.type === 'note') {
      if (s.over && ids.has(s.over) && s.label) steps.push(s)
    } else if (s.type === 'begin') {
      open++
      steps.push({ ...s, kind: s.kind ?? 'opt' })
    } else if (s.type === 'else') {
      if (open > 0) steps.push(s)
    } else if (s.type === 'end') {
      if (open > 0) { open--; steps.push(s) }
    }
  }
  while (open-- > 0) steps.push({ type: 'end' })
  return { title: spec.title || undefined, participants, steps }
}
