import { factsOf, outlineOf, signalsOf, symbolsOf } from './repo-facts'
import type { FileFacts } from './repo-facts'
// Reads a dropped repository folder in the browser and boils it down to a compact text summary
// (tree, manifests, infrastructure files, entry points) for the AI to analyse. Nothing leaves the
// machine from here: the summary is shown to the person first and only sent after they confirm.

export interface RepoItem { path: string; file: File }
export interface RepoSummary {
  name: string
  text: string
  signals: number // facts found by code: env vars, hosts, containers, routes...
  included: { path: string; chars: number }[]
  fileCount: number
  skipped: number
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'target', 'vendor', '__pycache__', '.venv', 'venv', 'env',
  'coverage', '.idea', '.vscode', 'bin', 'obj', '.gradle', '.terraform', '.cache', '.turbo', '.svn', 'bower_components', 'Pods', '.dart_tool',
])
const BINARY = /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tgz|tar|7z|rar|jar|war|class|dll|exe|so|dylib|woff2?|ttf|otf|eot|mp[34]|mov|avi|wasm|bin|dat|db|sqlite|lock|map|min\.js|min\.css|pyc)$/i
const LOCKS = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/
const SECRET_FILE = /(^|\/)(\.env(\..+)?|.*\.(pem|key|p12|pfx|keystore|jks)|id_rsa.*|credentials.*|.*secrets?\.(json|ya?ml))$/i
const MAX_FILES = 8000
const MAX_FILE = 300_000
const BUDGET = 140_000
const SCAN_FILES = 2500 // files read to look for signals
const SIGNALS_MAX = 16_000

// ---------- reading the drop

const readAll = (reader: FileSystemDirectoryReader) =>
  new Promise<FileSystemEntry[]>((res, rej) => {
    const out: FileSystemEntry[] = []
    const next = () => reader.readEntries((batch) => { if (!batch.length) res(out); else { out.push(...batch); next() } }, rej)
    next()
  })
const fileOf = (e: FileSystemFileEntry) => new Promise<File>((res, rej) => e.file(res, rej))

async function walk(entry: FileSystemEntry, path: string, out: RepoItem[], count: { skipped: number }) {
  if (out.length >= MAX_FILES) return
  if (entry.isDirectory) {
    if (SKIP_DIRS.has(entry.name)) { count.skipped++; return }
    for (const child of await readAll((entry as FileSystemDirectoryEntry).createReader())) await walk(child, `${path}/${child.name}`, out, count)
  } else {
    out.push({ path, file: await fileOf(entry as FileSystemFileEntry) })
  }
}

// Must be called synchronously inside the drop event (the entries die after it).
export function dropHasFolder(dt: DataTransfer): boolean {
  return Array.from(dt.items ?? []).some((i) => i.kind === 'file' && i.webkitGetAsEntry?.()?.isDirectory)
}

export async function collectDrop(dt: DataTransfer): Promise<{ name: string; items: RepoItem[]; skipped: number } | null> {
  const entries = Array.from(dt.items ?? []).map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() ?? null : null)).filter((e): e is FileSystemEntry => !!e)
  const dir = entries.find((e) => e.isDirectory)
  if (!dir) return null
  const items: RepoItem[] = []
  const count = { skipped: 0 }
  await walk(dir, dir.name, items, count)
  return { name: dir.name, items: items.map((i) => ({ ...i, path: i.path.slice(dir.name.length + 1) })), skipped: count.skipped }
}

// <input type="file" webkitdirectory>
export function collectInput(files: FileList): { name: string; items: RepoItem[]; skipped: number } | null {
  const all = Array.from(files)
  if (!all.length) return null
  const name = all[0].webkitRelativePath.split('/')[0] || 'repositorio'
  const items: RepoItem[] = []
  let skipped = 0
  for (const f of all) {
    const rel = f.webkitRelativePath.split('/').slice(1)
    if (rel.slice(0, -1).some((d) => SKIP_DIRS.has(d))) { skipped++; continue }
    if (items.length < MAX_FILES) items.push({ path: rel.join('/'), file: f })
  }
  return { name, items, skipped }
}

// ---------- summary

export const redactLine = (l: string) =>
  /BEGIN [A-Z ]*PRIVATE KEY/.test(l)
    ? '[removido]'
    : l
      .replace(/((?:secret|passw(?:or)?d|passwd|token|api[_-]?key|private[_-]?key|authorization|credential)[\w.-]*["']?\s*[:=]\s*)(["']?)[^\s"',;]+/gi, '$1$2[removido]')
      .replace(/\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|xox[abp]-[A-Za-z0-9-]{10,})\b/g, '[removido]')
      .replace(/(\w+:\/\/[^\s:/@]+:)[^\s@/]+@/g, '$1[removido]@')

export const redact = (text: string) =>
  text
    .split('\n')
    .filter((l) => !/BEGIN [A-Z ]*PRIVATE KEY/.test(l))
    .map(redactLine)
    .join('\n')

const MANIFEST = /(^|\/)(package\.json|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|go\.mod|requirements\.txt|pyproject\.toml|Pipfile|Cargo\.toml|composer\.json|Gemfile|mix\.exs|pubspec\.yaml|[^/]+\.csproj)$/
const INFRA = /(^|\/)(docker-compose[^/]*\.ya?ml|compose\.ya?ml|Dockerfile[^/]*|Procfile|serverless\.ya?ml|template\.ya?ml|skaffold\.ya?ml|Chart\.yaml|values\.ya?ml|openapi[^/]*\.(ya?ml|json)|swagger[^/]*\.(ya?ml|json)|schema\.prisma|[^/]+\.proto|\.env\.(example|sample)|nginx\.conf|Caddyfile)$|(^|\/)(k8s|kubernetes|deploy|helm|terraform|infra)\/[^/]+\.(ya?ml|tf)$|^[^/]*\.tf$/i
const ENTRY = /(^|\/)(main|index|app|server|application|program|startup|manage|wsgi|asgi|cli)\.(?:[jt]sx?|mjs|cjs|py|java|kt|go|rs|rb|php|cs|scala|swift|dart|exs?)$|(^|\/)application[\w-]*\.(ya?ml|properties)$/i
const ROLE = /(controller|route|router|handler|resolver|service|consumer|producer|listener|worker|queue|job|repository|gateway|client|adapter|middleware|schema|model|entity)/i
const CODE = /\.(ts|tsx|js|jsx|mjs|py|java|kt|go|rs|rb|php|cs|scala|swift|dart|ex|exs|sql|graphql|gql|yml|yaml|toml|json|md)$/i

const SRC = /\.(ts|tsx|js|jsx|mjs|cjs|py|java|kt|go|rs|rb|php|cs|scala)$/
// folders whose code is usually the heart of the system
const CORE_DIR = /(^|\/)(api|functions|routes?|controllers?|handlers?|services?|workers?|jobs?|consumers?|producers?|queues?|repositories|adapters?|middleware|domain|core|lib|pipelines?)\//i

function prio(path: string, size = 0): number {
  const depth = path.split('/').length
  if (/(^|\/)README(\.md)?$/i.test(path) && depth <= 2) return 0
  if (MANIFEST.test(path) && depth <= 3) return 0
  if (INFRA.test(path)) return 0
  if (ENTRY.test(path) && depth <= 4) return 1
  if (SRC.test(path) && /(^|\/)(api|functions)\//i.test(path) && !/(^|\/)(test|tests|__tests__|spec)\//i.test(path)) return 1
  if (SRC.test(path) && size >= 12_000 && !/\.(test|spec)\./i.test(path)) return 1 // a big source file is usually where the logic lives
  if (SRC.test(path) && (ROLE.test(path.split('/').pop()!) || CORE_DIR.test(path))) return 2
  return 9
}

function treeOf(paths: string[]): string {
  type Node = { n: number; kids: Map<string, Node> }
  const root: Node = { n: 0, kids: new Map() }
  for (const p of paths) {
    let cur = root
    cur.n++
    for (const part of p.split('/')) {
      if (!cur.kids.has(part)) cur.kids.set(part, { n: 0, kids: new Map() })
      cur = cur.kids.get(part)!
      cur.n++
    }
  }
  const lines: string[] = []
  const show = (node: Node, indent: string, depth: number) => {
    for (const [name, kid] of [...node.kids].sort((a, b) => Number(b[1].kids.size > 0) - Number(a[1].kids.size > 0) || a[0].localeCompare(b[0]))) {
      if (lines.length >= 320) return
      if (kid.kids.size) {
        lines.push(`${indent}${name}/ (${kid.n} arquivos)`)
        if (depth < 3) show(kid, indent + '  ', depth + 1)
      } else lines.push(`${indent}${name}`)
    }
  }
  show(root, '', 0)
  return lines.join('\n')
}

export const isText = (s: string) => !s.includes('\0')

// what can ever be read: no binaries, lockfiles, oversized files or secrets (those are never offered)
export function usableOf(items: RepoItem[], skippedDirs: number) {
  const usable = items.filter((i) => !BINARY.test(i.path) && !LOCKS.test(i.path) && i.file.size <= MAX_FILE && !(SECRET_FILE.test(i.path) && !/\.(example|sample)$/i.test(i.path)))
  return { usable, skipped: items.length - usable.length + skippedDirs }
}

const texts = new WeakMap<File, Promise<string>>()
export const textOf = (f: File) => {
  let t = texts.get(f)
  // like git: a file is binary only when a NUL shows up near its start; a stray NUL in the middle of source code (a regex such as /[\0-\x1f]/) is kept, written out as \0
  if (!t) { t = f.text().then((s) => (s.slice(0, 8000).includes('\0') ? s : s.replace(/\0/g, '\\0'))).catch(() => '\0'); texts.set(f, t) }
  return t
}

const factCache = new Map<File, FileFacts>()
const SCANNABLE = /\.(ts|tsx|js|jsx|mjs|cjs|py|java|kt|go|rs|rb|php|cs|scala|swift|dart|ex|exs|ya?ml|toml|json|xml|txt|sh|tf)$|\.env\.(example|sample)$/i

// `sel` is what the person lets the AI see (name and content); `forced` are files they ticked by hand, which get their content sent first
export async function summarize(name: string, usable: RepoItem[], skipped: number, sel: Set<string>, forced: Set<string> = new Set()): Promise<RepoSummary> {
  const chosen = usable.filter((i) => sel.has(i.path))
  const paths = chosen.map((i) => i.path)

  const byTop = new Map<string, { n: number; ext: Map<string, number> }>()
  for (const p of paths) {
    const parts = p.split('/')
    const top = parts.length > 1 ? parts[0] + '/' : '(raiz)'
    const e = byTop.get(top) ?? { n: 0, ext: new Map() }
    e.n++
    const ext = (p.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()
    if (ext) e.ext.set(ext, (e.ext.get(ext) ?? 0) + 1)
    byTop.set(top, e)
  }
  const folders = [...byTop].sort((a, b) => b[1].n - a[1].n).slice(0, 40)
    .map(([k, v]) => `${k}: ${v.n} arquivos (${[...v.ext].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([x, c]) => `${x} ${c}`).join(', ')})`)

  const ranked = chosen
    .map((i) => ({ i, p: forced.has(i.path) ? 1 : prio(i.path, i.file.size), hand: forced.has(i.path) }))
    .filter((x) => x.p < 9)
    .sort((a, b) => Number(b.hand) - Number(a.hand) || a.p - b.p || a.i.path.split('/').length - b.i.path.split('/').length || a.i.path.localeCompare(b.i.path))

  // signals: read every readable file once and let plain code pull out the architecture facts
  const scan: { path: string; text: string; facts: FileFacts }[] = []
  const toScan = chosen.filter((i) => SCANNABLE.test(i.path) || /Dockerfile/.test(i.path)).slice(0, SCAN_FILES)
  for (let k = 0; k < toScan.length; k += 60) {
    const batch = await Promise.all(toScan.slice(k, k + 60).map(async (i) => ({ i, t: await textOf(i.file) })))
    for (const { i, t } of batch) {
      if (!isText(t)) continue
      let facts = factCache.get(i.file)
      if (!facts) { facts = factsOf(i.path, t); factCache.set(i.file, facts) }
      scan.push({ path: i.path, text: t, facts })
    }
  }
  const sig = signalsOf(scan)
  const sigText = sig.text.length > SIGNALS_MAX ? sig.text.slice(0, SIGNALS_MAX) + '\n… (cortado)' : sig.text

  const caps = [9000, 6500, 3000]
  const limitRole = [Infinity, 30, 40]
  const used = [0, 0, 0]
  let text = `Repositório: ${name}\nArquivos considerados: ${chosen.length}\n\n${sigText ? `## Sinais detectados (extraídos por código, são fatos)\n${sigText}\n\n` : ''}## Pastas principais\n${folders.join('\n')}\n\n## Árvore\n${treeOf(paths)}\n\n## Arquivos-chave\n`
  const included: { path: string; chars: number }[] = []
  for (const { i, p, hand } of ranked) {
    if (text.length >= BUDGET) break
    if (!hand && used[p] >= limitRole[p]) continue
    const raw = await textOf(i.file)
    if (!isText(raw)) continue
    let body = raw
    if (/\.env\.(example|sample)$/i.test(i.path)) body = body.split('\n').map((l) => l.replace(/=.*/, '=')).join('\n')
    body = redact(body)
    let cut = body
    if (body.length > caps[p]) {
      // a big file: the start, then its structure (declarations with the comment above each), then the end
      const outline = outlineOf(body).slice(0, Math.floor(caps[p] * 0.3))
      cut = body.slice(0, Math.floor(caps[p] * 0.55)) + `\n… (arquivo grande, ${body.split('\n').length} linhas; estrutura abaixo)\n${outline}\n… (final do arquivo)\n` + body.slice(-Math.floor(caps[p] * 0.12))
    }
    text += `\n### ${i.path}\n${cut}\n`
    included.push({ path: i.path, chars: cut.length })
    used[p]++
  }
  return { name, text, signals: sig.count, included, fileCount: chosen.length, skipped }
}

// ---------- index for questions: small and stable, the AI reads the files it needs through tools

const INDEX_BUDGET = 36_000

/** Tree, detected facts and the functions of every source file (name:line). A few thousand tokens, whatever the repo size. */
export async function buildIndex(name: string, files: RepoItem[]): Promise<string> {
  const scan: { path: string; text: string; facts: FileFacts }[] = []
  const toScan = files.filter((i) => SCANNABLE.test(i.path) || /Dockerfile/.test(i.path)).slice(0, SCAN_FILES)
  for (let k = 0; k < toScan.length; k += 60) {
    const batch = await Promise.all(toScan.slice(k, k + 60).map(async (i) => ({ i, t: await textOf(i.file) })))
    for (const { i, t } of batch) {
      if (!isText(t)) continue
      let facts = factCache.get(i.file)
      if (!facts) { facts = factsOf(i.path, t); factCache.set(i.file, facts) }
      scan.push({ path: i.path, text: t, facts })
    }
  }
  const sig = signalsOf(scan)
  const sigText = sig.text.length > SIGNALS_MAX ? sig.text.slice(0, SIGNALS_MAX) + '\n… (cortado)' : sig.text
  let out = `Repositório: ${name}\nArquivos que você pode consultar: ${files.length}\n\n${sigText ? `## Sinais detectados (extraídos por código, são fatos)\n${sigText}\n\n` : ''}## Árvore\n${treeOf(files.map((f) => f.path))}\n\n## Funções e classes por arquivo (nome:linha)\n`
  const code = scan
    .filter((f) => SRC.test(f.path) && !/(^|\/)(test|tests|__tests__)\//i.test(f.path))
    .sort((a, b) => prio(a.path, a.text.length) - prio(b.path, b.text.length) || a.path.localeCompare(b.path))
  for (const f of code) {
    const syms = symbolsOf(f.text)
    if (!syms.length) continue
    const line = `${f.path} (${f.text.split('\n').length} linhas): ${syms.slice(0, 30).map((s) => `${s.name}:${s.line}`).join(', ')}${syms.length > 30 ? ', …' : ''}`
    if (out.length + line.length > INDEX_BUDGET) { out += '… (índice cortado; use grep para achar o resto)\n'; break }
    out += line + '\n'
  }
  return out
}
