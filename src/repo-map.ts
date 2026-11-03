// Deep analysis (map-reduce): the repository is cut into modules that each fit one AI call, every module is summarised on its own
// (in parallel), and the drawing is made from all the summaries. Nothing is left out because of a context limit.
import type { RepoItem } from './repo'
import { isText, redact, textOf } from './repo'

export interface ModuleSummary {
  role: string
  summary: string
  exposes: string[]
  talks_to: string[]
  flows: string[]
  key_files: { path: string; what: string }[]
  uncertain: string[]
}
export interface Module { label: string; files: { path: string; text: string }[]; chars: number }
export interface MapResult {
  /** text to put in the repository summary, one block per module */
  text: string
  done: number
  total: number
  /** modules the AI could not summarise (their files are listed so the drawing admits the gap) */
  failed: string[]
  files: number
}

const MODULE_MAX = 45_000 // characters of code per module call
const MAX_MODULES = 60
const PARALLEL = 4

type Piece = { path: string; text: string }
const size = (ps: Piece[]) => ps.reduce((n, p) => n + p.text.length + p.path.length + 8, 0)

/** A file bigger than the limit is cut by lines into parts, so no part is lost. */
function splitBig(p: Piece, max: number): Piece[] {
  if (p.text.length <= max) return [p]
  // a single huge line (minified code, a dump) is chopped too, so no character is dropped
  const lines = p.text.split('\n').flatMap((l) => (l.length > max ? (l.match(new RegExp(`[^]{1,${max - 1}}`, 'g')) ?? [l]) : [l]))
  const parts: Piece[] = []
  let cur: string[] = [], n = 0
  for (const l of lines) {
    if (n + l.length + 1 > max && cur.length) { parts.push({ path: '', text: cur.join('\n') }); cur = []; n = 0 }
    cur.push(l)
    n += l.length + 1
  }
  if (cur.length) parts.push({ path: '', text: cur.join('\n') })
  return parts.map((x, i) => ({ path: `${p.path} (parte ${i + 1}/${parts.length})`, text: x.text }))
}

/** Folders become modules; a folder too big is split by its subfolders, small neighbours are joined. */
export function planModules(pieces: Piece[], max = MODULE_MAX): Module[] {
  const out: Module[] = []
  const put = (label: string, ps: Piece[]) => out.push({ label, files: ps, chars: size(ps) })
  const walk = (ps: Piece[], prefix: string) => {
    if (!ps.length) return
    if (size(ps) <= max) return put(prefix || '(raiz)', ps)
    const here: Piece[] = [], kids = new Map<string, Piece[]>()
    for (const p of ps) {
      const rest = p.path.slice(prefix.length)
      const i = rest.indexOf('/')
      if (i < 0) here.push(p)
      else { const k = rest.slice(0, i + 1); kids.set(k, [...(kids.get(k) ?? []), p]) }
    }
    // loose files of this folder, big ones in parts, grouped up to the limit
    let group: Piece[] = []
    const flush = () => { if (group.length) put(prefix || '(raiz)', group); group = [] }
    for (const p of here.flatMap((f) => splitBig(f, max))) {
      if (size(group) + p.text.length > max) flush()
      group.push(p)
    }
    flush()
    // subfolders: small ones are joined while they fit, big ones recurse
    let join: Piece[] = [], names: string[] = []
    const flushJoin = () => { if (join.length) put(prefix + names.join(', '), join); join = []; names = [] }
    for (const [k, v] of [...kids].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (size(v) > max) { flushJoin(); walk(v, prefix + k); continue }
      if (size(join) + size(v) > max) flushJoin()
      join.push(...v); names.push(k)
    }
    flushJoin()
  }
  walk(pieces.flatMap((p) => splitBig(p, max)).sort((a, b) => a.path.localeCompare(b.path)), '')
  return out
}

/** Reads every allowed text file (secrets already redacted) and cuts them into modules; if there would be too many, the modules grow. */
export async function modulesOf(files: RepoItem[]): Promise<Module[]> {
  const pieces: Piece[] = []
  for (let k = 0; k < files.length; k += 60) {
    const batch = await Promise.all(files.slice(k, k + 60).map(async (i) => ({ i, t: await textOf(i.file) })))
    for (const { i, t } of batch) {
      if (!isText(t) || !t.trim()) continue
      let body = t
      if (/\.env\.(example|sample)$/i.test(i.path)) body = body.split('\n').map((l) => l.replace(/=.*/, '=')).join('\n')
      pieces.push({ path: i.path, text: redact(body) })
    }
  }
  let max = MODULE_MAX
  let mods = planModules(pieces, max)
  while (mods.length > MAX_MODULES && max < 400_000) { max *= 2; mods = planModules(pieces, max) }
  return mods
}

const lines = (title: string, xs: string[]) => (xs.length ? `- ${title}: ${xs.join('; ')}\n` : '')
export const renderModule = (label: string, s: ModuleSummary) =>
  `### Módulo ${label}\n${s.role}\n${s.summary}\n${lines('expõe', s.exposes)}${lines('conversa com', s.talks_to)}${lines('fluxos', s.flows)}` +
  `${lines('arquivos-chave', s.key_files.map((k) => `${k.path} (${k.what})`))}${lines('incerto', s.uncertain)}`

async function summariseOne(name: string, m: Module): Promise<ModuleSummary> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch('/api/ai/module', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, label: m.label, files: m.files }) })
      const data = await r.json().catch(() => null)
      if (!r.ok) throw new Error(data?.error ?? `Erro ${r.status}`)
      return data.module as ModuleSummary
    } catch (e) { lastErr = e }
  }
  throw lastErr
}

/** Summarises all modules, a few at a time. */
export async function mapModules(name: string, mods: Module[], onProgress: (done: number, total: number) => void): Promise<MapResult> {
  const results: (string | null)[] = mods.map(() => null)
  const failed: string[] = []
  let next = 0, done = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= mods.length) return
      try { results[i] = renderModule(mods[i].label, await summariseOne(name, mods[i])) }
      catch { failed.push(`${mods[i].label} (${mods[i].files.map((f) => f.path).slice(0, 6).join(', ')})`) }
      onProgress(++done, mods.length)
    }
  }
  onProgress(0, mods.length)
  await Promise.all(Array.from({ length: Math.min(PARALLEL, mods.length) }, worker))
  const gaps = failed.length ? `\n### Módulos que NÃO foram resumidos (não invente nada sobre eles)\n${failed.map((f) => `- ${f}`).join('\n')}\n` : ''
  return {
    text: `## Resumo por módulo (cada módulo foi lido por inteiro)\n\n${results.filter(Boolean).join('\n')}${gaps}`,
    done: mods.length - failed.length,
    total: mods.length,
    failed,
    files: mods.reduce((n, m) => n + m.files.length, 0),
  }
}
