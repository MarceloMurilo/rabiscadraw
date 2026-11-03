// The tools the guide uses to look into the repository while answering: grep, outline, read and read_symbol.
// They run here in the browser over the files the person allowed, and each one returns a small text
// (a few lines), so a question costs a few hundred tokens of code instead of the whole repository.
import { blockEnd, symbolsOf } from './repo-facts'
import { isText, redactLine, textOf } from './repo'
import type { RepoItem } from './repo'

export type ToolName = 'grep' | 'outline' | 'read' | 'read_symbol'
export interface ToolCall {
  action: ToolName
  pattern?: string | null
  path?: string | null
  from?: number | null
  to?: number | null
  symbol?: string | null
}

const MAX_MATCHES = 25
const MAX_LINES = 120
const MAX_OUT = 6000
const SRC_FIRST = /\.(ts|tsx|js|jsx|mjs|cjs|py|java|kt|go|rs|rb|php|cs|scala)$/i

// repositories whose files can be read by the guide of each drawing (kept in memory only)
const stores = new Map<string, RepoItem[]>()
export const setRepoFiles = (drawingId: string, files: RepoItem[]) => { stores.set(drawingId, files) }
export const repoFilesOf = (drawingId: string) => stores.get(drawingId)

const clip = (s: string) => (s.length > MAX_OUT ? s.slice(0, MAX_OUT) + '\n… (cortado)' : s)
const numbered = (lines: string[], from: number) => lines.map((l, i) => `${from + i}| ${redactLine(l).slice(0, 240)}`).join('\n')

function resolvePath(files: RepoItem[], p: string): RepoItem | string {
  const clean = p.trim().replace(/\\/g, '/').replace(/^\.?\//, '')
  if (!clean) return 'Informe o caminho do arquivo.'
  const exact = files.find((f) => f.path === clean)
  if (exact) return exact
  const tail = files.filter((f) => f.path.endsWith('/' + clean))
  if (tail.length === 1) return tail[0]
  if (tail.length > 1) return `Caminho ambíguo, use um destes: ${tail.slice(0, 6).map((f) => f.path).join(', ')}`
  const base = clean.split('/').pop()!.toLowerCase()
  const near = files.filter((f) => f.path.toLowerCase().includes(base)).slice(0, 6)
  return `Não achei «${clean}».${near.length ? ` Parecidos: ${near.map((f) => f.path).join(', ')}` : ' Veja a árvore do índice.'}`
}

async function textFor(f: RepoItem): Promise<string | null> {
  const t = await textOf(f.file)
  return isText(t) ? t : null
}

async function grep(files: RepoItem[], pattern: string, scope: string | null | undefined) {
  let re: RegExp
  try { re = new RegExp(pattern.slice(0, 200), 'i') } catch { re = new RegExp(pattern.slice(0, 200).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
  const scoped = scope ? files.filter((f) => f.path.includes(scope.replace(/\\/g, '/').replace(/^\.?\//, ''))) : files
  const ordered = [...scoped].sort((a, b) => Number(SRC_FIRST.test(b.path)) - Number(SRC_FIRST.test(a.path)) || a.path.localeCompare(b.path))
  const hits: string[] = []
  let total = 0
  for (const f of ordered) {
    const t = await textFor(f)
    if (!t) continue
    const lines = t.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > 600 || !re.test(lines[i])) continue
      total++
      if (hits.length < MAX_MATCHES) hits.push(`${f.path}:${i + 1}: ${redactLine(lines[i].trim()).slice(0, 200)}`)
    }
    if (total > 400) break
  }
  if (!hits.length) return 'Nenhum resultado. Tente outro termo ou uma variação (o grep ignora maiúsculas e aceita regex).'
  return hits.join('\n') + (total > hits.length ? `\n… e mais ${total > 400 ? '400+' : total - hits.length} ocorrências; refine o padrão ou passe «path» para limitar a uma pasta.` : '')
}

async function outline(files: RepoItem[], path: string) {
  const f = resolvePath(files, path)
  if (typeof f === 'string') return f
  const t = await textFor(f)
  if (t === null) return 'Arquivo binário.'
  const syms = symbolsOf(t)
  const total = t.split('\n').length
  if (!syms.length) return `${f.path} (${total} linhas): nenhuma função ou classe reconhecida. Use read para ver o conteúdo.`
  return `${f.path} (${total} linhas)\n` + syms.slice(0, 150).map((s) => `${s.line}: ${s.name} (${s.kind})`).join('\n')
}

async function read(files: RepoItem[], path: string, from?: number | null, to?: number | null) {
  const f = resolvePath(files, path)
  if (typeof f === 'string') return f
  const t = await textFor(f)
  if (t === null) return 'Arquivo binário.'
  const lines = t.split('\n')
  const a = Math.max(1, Math.floor(from ?? 1))
  const b = Math.min(lines.length, Math.floor(to ?? a + MAX_LINES - 1), a + MAX_LINES - 1)
  if (a > lines.length) return `${f.path} só tem ${lines.length} linhas.`
  const more = b < lines.length ? `\n… (${f.path} tem ${lines.length} linhas; continue com from=${b + 1})` : ''
  return clip(`${f.path}:${a}-${b}\n${numbered(lines.slice(a - 1, b), a)}${more}`)
}

async function readSymbol(files: RepoItem[], symbol: string, path?: string | null) {
  const wanted = symbol.trim().toLowerCase()
  const last = (n: string) => n.split('.').pop()!.toLowerCase()
  const found: { f: RepoItem; text: string; syms: ReturnType<typeof symbolsOf>; i: number }[] = []
  let pool = files
  if (path) {
    const f = resolvePath(files, path)
    if (typeof f === 'string') return f
    pool = [f]
  }
  for (const f of pool) {
    if (!SRC_FIRST.test(f.path)) continue
    const text = await textFor(f)
    if (!text) continue
    const syms = symbolsOf(text)
    const i = syms.findIndex((s) => s.name.toLowerCase() === wanted) >= 0 ? syms.findIndex((s) => s.name.toLowerCase() === wanted) : syms.findIndex((s) => last(s.name) === last(wanted))
    if (i >= 0) found.push({ f, text, syms, i })
  }
  if (!found.length) return `Não achei «${symbol}». Use grep para localizar onde aparece.`
  if (found.length > 1) return `«${symbol}» aparece em vários arquivos: ${found.slice(0, 8).map((x) => `${x.f.path}:${x.syms[x.i].line}`).join(', ')}. Chame de novo com «path».`
  const { f, text, syms, i } = found[0]
  const lines = text.split('\n')
  const start = syms[i].line - 1
  const end = blockEnd(lines, start, f.path, syms[i + 1] ? syms[i + 1].line - 1 : undefined)
  const shown = Math.min(end, start + MAX_LINES - 1)
  const more = shown < end ? `\n… (a função continua até a linha ${end + 1}; use read com from=${shown + 2})` : ''
  return clip(`${f.path}:${start + 1}-${shown + 1} (${syms[i].name})\n${numbered(lines.slice(start, shown + 1), start + 1)}${more}`)
}

export async function runTool(files: RepoItem[], c: ToolCall): Promise<string> {
  switch (c.action) {
    case 'grep': return c.pattern ? clip(await grep(files, c.pattern, c.path)) : 'grep precisa de «pattern».'
    case 'outline': return c.path ? clip(await outline(files, c.path)) : 'outline precisa de «path».'
    case 'read': return c.path ? await read(files, c.path, c.from, c.to) : 'read precisa de «path».'
    case 'read_symbol': return c.symbol ? await readSymbol(files, c.symbol, c.path) : 'read_symbol precisa de «symbol».'
    default: return 'Ferramenta desconhecida.'
  }
}

/** What the person sees while the guide works. */
export function describeTool(c: ToolCall): string {
  switch (c.action) {
    case 'grep': return `Procurando «${(c.pattern ?? '').slice(0, 40)}» no código…`
    case 'outline': return `Vendo a estrutura de ${c.path ?? 'um arquivo'}…`
    case 'read': return `Lendo ${c.path ?? 'um arquivo'}…`
    case 'read_symbol': return `Lendo a função ${c.symbol ?? ''}…`
    default: return 'Investigando o código…'
  }
}
