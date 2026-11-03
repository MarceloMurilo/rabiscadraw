// The conversation about a drawing made from a repository: what the AI said about it and what the person asked.
import type { El } from './types'
import { readGraph } from './graph'
import type { ToolCall } from './repo-tools'

export interface ChatMsg { role: 'user' | 'ai'; text: string; focus?: string[]; error?: boolean }
export interface ChatData {
  repoName: string
  kind: 'architecture' | 'sequence'
  /** the repository summary the drawing came from; sent with every question so answers can go into detail */
  context: string
  /** compact map of the repository (tree, facts, functions per file); with the files still loaded the guide looks into the code through tools instead of reading `context` */
  index?: string
  messages: ChatMsg[]
}

/** The drawing as the AI needs to see it. */
export function askGraph(els: El[]) {
  const g = readGraph(els, '', 0)
  return {
    nodes: g.nodes.map((n) => ({ id: n.id, label: 'label' in n ? n.label : undefined, kind: 'kind' in n ? n.kind : undefined, description: 'description' in n ? n.description : undefined, group: 'group' in n ? n.group : undefined })),
    edges: g.edges.filter((e) => e.from && e.to).map((e) => ({ from: e.from, to: e.to, label: 'label' in e ? e.label : undefined })),
    groups: g.groups,
  }
}

/** Lets the guide look into the repository: the server asks for one tool call at a time, the page runs it and sends the result back. */
export interface CodeTools { index: string; run: (c: ToolCall) => Promise<string>; onStep?: (c: ToolCall) => void }
const MAX_LOOKS = 8 // safety net; the server stops asking after 5

export async function askServer(body: { mode: 'overview' | 'ask'; kind: ChatData['kind']; graph: ReturnType<typeof askGraph>; context: string; history: ChatMsg[]; question?: string; selected?: string[] }, tools?: CodeTools) {
  const trace: { call: ToolCall; output: string }[] = []
  for (;;) {
    const r = await fetch('/api/ai/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        context: tools ? '' : body.context, // with tools the index replaces the big summary
        index: tools?.index,
        trace: tools ? trace : undefined,
        history: body.history.map((m) => ({ role: m.role, text: m.text })),
      }),
    })
    const data = await r.json().catch(() => null)
    if (!r.ok) throw new Error(data?.error ?? `Erro ${r.status}`)
    if (!data?.tool) return data as { answer: string; focus: string[] }
    if (!tools || trace.length >= MAX_LOOKS) throw new Error('A IA pediu consultas demais ao código.')
    tools.onStep?.(data.tool)
    let output: string
    try { output = await tools.run(data.tool) } catch (e) { output = `Erro ao consultar: ${e instanceof Error ? e.message : String(e)}` }
    trace.push({ call: data.tool, output })
  }
}

/** Elements on the board that stand for the given piece ids (the piece itself or the box of a group). */
export const piecesOf = (els: El[], ids: string[]) => els.filter((e) => !e.aux && e.nid && ids.includes(e.nid))
