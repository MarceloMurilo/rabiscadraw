// Architecture signals pulled out of a repository by plain code (no AI): environment variables (names
// only, never values), external hosts the code calls, packages, containers, routes and redirects.
// The AI gets these as facts, so it does not have to find them in the middle of a long file.

export interface FileFacts { env: string[]; hosts: string[]; routes: string[] }

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|java|kt|go|rs|rb|php|cs|scala|swift|dart|ex|exs|ya?ml|toml|sh|tf)$/i
const ENV_FILE = /(^|\/)\.env\.(example|sample)$/i
const COMPOSE = /(^|\/)(docker-compose[^/]*|compose)\.ya?ml$/i
const NOISE_HOST = /(^|\.)(w3\.org|schema\.org|example\.(com|org|net)|localhost|googleapis\.com\/css|fonts\.(googleapis|gstatic)\.com|npmjs\.(org|com)|creativecommons\.org|mozilla\.org|developer\.mozilla\.org|wikipedia\.org|stackoverflow\.com|xmlns|json-schema\.org|opensource\.org|apache\.org|gnu\.org|ietf\.org|eslint\.org|nodejs\.org|reactjs\.org|react\.dev|vitejs\.dev|nextjs\.org|tailwindcss\.com)$/i

const ENV_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]{2,})/g,
  /process\.env\[['"]([A-Z][A-Z0-9_]{2,})['"]\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]{2,})/g,
  /os\.environ(?:\.get)?[\[(]\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
  /(?:os\.)?getenv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
  /System\.getenv\(\s*"([A-Z][A-Z0-9_]{2,})"/g,
  /Environment\.GetEnvironmentVariable\(\s*"([A-Z][A-Z0-9_]{2,})"/g,
]
const ROUTE_PATTERNS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/\b(?:app|router|server|api|fastify)\.(get|post|put|patch|delete|all)\(\s*['"`]([^'"`]+)['"`]/g, (m) => `${m[1].toUpperCase()} ${m[2]}`],
  [/@(?:\w+)\.(get|post|put|patch|delete|route|websocket)\(\s*['"]([^'"]+)['"]/g, (m) => `${m[1].toUpperCase()} ${m[2]}`],
  [/@(Get|Post|Put|Delete|Patch|Request)Mapping\(\s*(?:value\s*=\s*)?\{?\s*"([^"]+)"/g, (m) => `${m[1].toUpperCase()} ${m[2]}`],
  [/\bfetch\(\s*['"`](\/[^'"`?\s]+)/g, (m) => `chama ${m[1]}`],
]

export function factsOf(path: string, text: string): FileFacts {
  const env = new Set<string>()
  const hosts = new Set<string>()
  const routes = new Set<string>()
  const code = CODE_EXT.test(path)
  if (ENV_FILE.test(path)) for (const m of text.matchAll(/^([A-Z][A-Z0-9_]{2,})\s*=/gm)) env.add(m[1])
  if (code) {
    for (const re of ENV_PATTERNS) for (const m of text.matchAll(re)) env.add(m[1])
    if (COMPOSE.test(path)) for (const m of text.matchAll(/\$\{([A-Z][A-Z0-9_]{2,})/g)) env.add(m[1])
    for (const m of text.matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi)) {
      const h = m[1].toLowerCase()
      if (!NOISE_HOST.test(h)) hosts.add(h)
    }
    for (const [re, fmt] of ROUTE_PATTERNS) for (const m of text.matchAll(new RegExp(re.source, re.flags))) routes.add(fmt(m))
  }
  // routes that are the file itself (Next.js app router, pages/api, serverless /api folders)
  if (/(^|\/)app\/.*\/route\.[jt]sx?$/.test(path) || /(^|\/)pages\/api\/.+\.[jt]sx?$/.test(path) || /^api\/[^/]+\.[jt]s$/.test(path) || /(^|\/)api\/[^/]+\.[jt]s$/.test(path)) {
    routes.add(`função serverless em ${path}`)
  }
  return { env: [...env], hosts: [...hosts], routes: [...routes].slice(0, 30) }
}

// ---------- manifests, compose files, redirects: read structurally

function packagesOf(path: string, text: string): string | null {
  try {
    if (/(^|\/)package\.json$/.test(path)) {
      const j = JSON.parse(text)
      const dep = Object.keys(j.dependencies ?? {}), dev = Object.keys(j.devDependencies ?? {})
      const scripts = Object.entries(j.scripts ?? {}).slice(0, 12).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
      return `${path}${j.name ? ` (${j.name})` : ''}: dependências ${dep.join(', ') || '-'}${dev.length ? `; dev: ${dev.slice(0, 15).join(', ')}` : ''}${scripts.length ? `; scripts: ${scripts.join(' | ')}` : ''}`
    }
    if (/(^|\/)requirements[^/]*\.txt$/.test(path)) {
      const names = text.split('\n').map((l) => l.trim().split(/[=<>~! \[;#]/)[0]).filter((n) => n && !n.startsWith('-')).slice(0, 50)
      return `${path}: ${names.join(', ')}`
    }
    if (/(^|\/)go\.mod$/.test(path)) {
      const names = [...text.matchAll(/^\s*([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+v/gm)].map((m) => m[1]).slice(0, 40)
      return `${path}: ${names.join(', ')}`
    }
    if (/(^|\/)pom\.xml$/.test(path)) {
      const names = [...new Set([...text.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)].map((m) => m[1]))].slice(0, 40)
      return `${path}: ${names.join(', ')}`
    }
    if (/(^|\/)(Cargo\.toml|pyproject\.toml)$/.test(path)) {
      const names = [...text.matchAll(/^\s*"?([A-Za-z0-9_.-]+)"?\s*=\s*[{"]/gm)].map((m) => m[1]).slice(0, 40)
      return `${path}: ${names.join(', ')}`
    }
    if (/(^|\/)composer\.json$/.test(path)) {
      return `${path}: ${Object.keys(JSON.parse(text).require ?? {}).join(', ')}`
    }
  } catch { /* malformed manifest: skip */ }
  return null
}

function composeOf(path: string, text: string): string | null {
  const lines = text.split('\n')
  const out: string[] = []
  let inServices = false, cur: { name: string; image?: string; ports: string[]; dependsOn: string[] } | null = null
  let inDepends = false
  const flush = () => { if (cur) out.push(`${cur.name}${cur.image ? ` (${cur.image})` : ''}${cur.ports.length ? ` portas ${cur.ports.slice(0, 3).join(',')}` : ''}${cur.dependsOn.length ? ` depende de ${cur.dependsOn.join(',')}` : ''}`) }
  for (const l of lines) {
    if (/^services:\s*$/.test(l)) { inServices = true; continue }
    if (/^[a-z_-]+:\s*/.test(l) && !/^services:/.test(l)) { if (inServices) { flush(); cur = null } inServices = false; continue }
    if (!inServices) continue
    const svc = l.match(/^  ([A-Za-z0-9_.-]+):\s*(?:#.*)?$/)
    if (svc) { flush(); cur = { name: svc[1], ports: [], dependsOn: [] }; inDepends = false; continue }
    if (!cur) continue
    const img = l.match(/^\s{4}image:\s*(\S+)/)
    if (img) cur.image = img[1].replace(/\$\{[^}]*:-([^}]*)\}/g, '$1').replace(/^docker\.io\//, '')
    const port = l.match(/^\s{6}-\s*["']?(?:[\d.]+:)?(\d+:\d+|\d+)["']?/)
    if (port && !inDepends) cur.ports.push(port[1])
    if (/^\s{4}depends_on:/.test(l)) { inDepends = true; continue }
    if (/^\s{4}[a-z_]+:/.test(l)) inDepends = false
    if (inDepends) { const d = l.match(/^\s{6}(?:-\s*)?([A-Za-z0-9_.-]+)\s*:?\s*$/); if (d) cur.dependsOn.push(d[1]) }
  }
  flush()
  return out.length ? `${path}: ${out.join('; ')}` : null
}

function redirectsOf(path: string, text: string): string | null {
  if (!/(^|\/)vercel\.json$/.test(path)) return null
  try {
    const j = JSON.parse(text)
    const r = (j.redirects ?? []).slice(0, 10).map((x: any) => `${x.source} -> ${x.destination}`)
    const w = (j.rewrites ?? []).slice(0, 10).map((x: any) => `${x.source} => ${x.destination}`)
    const parts = [...(r.length ? [`redirects: ${r.join('; ')}`] : []), ...(w.length ? [`rewrites: ${w.join('; ')}`] : [])]
    return parts.length ? `${path}: ${parts.join(' | ')}` : null
  } catch { return null }
}

export interface Signals { text: string; count: number }

export function signalsOf(files: { path: string; text: string; facts: FileFacts }[]): Signals {
  const env = new Map<string, Set<string>>()
  const hosts = new Map<string, Set<string>>()
  const routes: string[] = []
  const packages: string[] = []
  const compose: string[] = []
  const redirects: string[] = []
  for (const f of files) {
    for (const e of f.facts.env) (env.get(e) ?? env.set(e, new Set()).get(e)!).add(f.path)
    for (const h of f.facts.hosts) (hosts.get(h) ?? hosts.set(h, new Set()).get(h)!).add(f.path)
    for (const r of f.facts.routes) routes.push(`${r}  [${f.path}]`)
    const pkg = packagesOf(f.path, f.text); if (pkg) packages.push(pkg)
    if (COMPOSE.test(f.path)) { const c = composeOf(f.path, f.text); if (c) compose.push(c) }
    const rd = redirectsOf(f.path, f.text); if (rd) redirects.push(rd)
  }
  const where = (s: Set<string>) => [...s].slice(0, 2).join(', ') + (s.size > 2 ? ` +${s.size - 2}` : '')
  const sections: string[] = []
  if (env.size) sections.push(`### Variáveis de ambiente usadas (só os nomes)\n${[...env].sort((a, b) => b[1].size - a[1].size).slice(0, 80).map(([k, v]) => `${k}  [${where(v)}]`).join('\n')}`)
  if (hosts.size) sections.push(`### Serviços externos chamados (hosts no código)\n${[...hosts].sort((a, b) => b[1].size - a[1].size).slice(0, 50).map(([k, v]) => `${k}  [${where(v)}]`).join('\n')}`)
  if (compose.length) sections.push(`### Containers (docker-compose)\n${compose.join('\n')}`)
  if (routes.length) sections.push(`### Rotas e chamadas HTTP\n${routes.slice(0, 80).join('\n')}`)
  if (redirects.length) sections.push(`### Redirects e rewrites\n${redirects.join('\n')}`)
  if (packages.length) sections.push(`### Pacotes e scripts\n${packages.slice(0, 12).join('\n')}`)
  const count = env.size + hosts.size + routes.length + compose.length + redirects.length
  return { text: sections.join('\n\n'), count }
}

// ---------- big files: structure instead of just the first lines

const DECL = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+\w+|class\s+\w+|interface\s+\w+|enum\s+\w+|(?:const|let|var)\s+[A-Za-z_][\w]*\s*=\s*(?:async\s*)?(?:\(|function|new\s|\{|\[|require)|def\s+\w+|async\s+def\s+\w+|func\s+\w+|fn\s+\w+|(?:public|private|protected|static)[\w\s<>,\[\]]*\s\w+\s*\()/
const LINE_COMMENT = /^\s*(?:\/\/|#)\s?(.*)$/

// a short list of the declarations in a file, each with the first line of the comment above it
export function outlineOf(body: string, max = 70): string {
  const lines = body.split('\n')
  const out: string[] = []
  let comment = ''
  for (const l of lines) {
    const c = l.match(LINE_COMMENT)
    if (c) { if (!comment && c[1].trim().length > 25) comment = c[1].trim().slice(0, 160); continue }
    if (DECL.test(l)) {
      out.push((comment ? `// ${comment}\n` : '') + l.trim().slice(0, 140))
      if (out.length >= max) break
    }
    if (l.trim()) comment = ''
  }
  return out.join('\n')
}

// ---------- symbols: where each function / class starts and ends (plain regex, no parser)

export interface Sym { name: string; line: number; kind: 'function' | 'class' | 'type' | 'method' } // line is 1-based

const NOT_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'do', 'try', 'with', 'super', 'new', 'await', 'typeof', 'import', 'require'])
const FN_VALUE = String.raw`(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[\w$]+\s*=>)`
const SYM_PATTERNS: [RegExp, Sym['kind']][] = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([\w$]+)/, 'function'],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+|data\s+|sealed\s+|open\s+)?class\s+([\w$]+)/, 'class'],
  [/^\s*(?:export\s+)?(?:declare\s+)?(?:interface|enum|type)\s+([\w$]+)/, 'type'],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|trait)\s+([\w$]+)/, 'type'],
  [new RegExp(String.raw`^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*${FN_VALUE}`), 'function'],
  [/^\s*(?:async\s+)?def\s+(\w+)/, 'function'],
  [/^func\s+(?:\([^)]*\)\s*)?(\w+)/, 'function'],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/, 'function'],
  [/^\s*(?:(?:public|private|protected|internal|override|suspend|inline|open)\s+)*fun\s+(?:<[^>]+>\s*)?(?:[\w.]+\.)?(\w+)/, 'function'],
  [new RegExp(String.raw`^\s*([\w$]+(?:\.[\w$]+)+)\s*=\s*${FN_VALUE}`), 'function'], // Net.send = function () {}
  [new RegExp(String.raw`^\s*([\w$]+)\s*:\s*${FN_VALUE}`), 'function'], // send: function () {}
  [/^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|synchronized|async)\s+)+(?:[\w<>\[\],.?]+\s+)+([\w$]+)\s*\(/, 'method'],
  [/^\s*(?:(?:static|async|get|set)\s+)*([\w$]+)\s*\([^;]*\)\s*(?::\s*[^{]+)?\{\s*$/, 'method'], // send(msg) {
]

export function symbolsOf(text: string): Sym[] {
  const out: Sym[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length && out.length < 400; i++) {
    const l = lines[i]
    if (l.length > 300 || !l.trim()) continue
    for (const [re, kind] of SYM_PATTERNS) {
      const m = re.exec(l)
      if (m) {
        if (!NOT_METHOD.has(m[1])) out.push({ name: m[1], line: i + 1, kind })
        break
      }
    }
  }
  return out
}

const bare = (l: string) => l.replace(/(["'`])(?:\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$/, '')

/** Index (0-based) of the last line of the function / class that starts at line `start` (0-based). */
export function blockEnd(lines: string[], start: number, path: string, nextStart?: number): number {
  if (/\.py$/i.test(path)) {
    const base = lines[start].match(/^\s*/)![0].length
    let last = start
    for (let i = start + 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue
      if (lines[i].match(/^\s*/)![0].length <= base) break
      last = i
    }
    return last
  }
  let depth = 0, seen = false
  for (let i = start; i < lines.length && i < start + 3000; i++) {
    for (const ch of bare(lines[i])) {
      if (ch === '{') { depth++; seen = true } else if (ch === '}') { depth-- }
      if (seen && depth <= 0) return i
    }
    if (!seen && i - start >= 4) break
  }
  // no braces (an expression, or a language without them): stop at the blank line or the next symbol
  let end = start
  while (end + 1 < lines.length && end - start < 30 && lines[end + 1].trim() && (nextStart === undefined || end + 1 < nextStart)) end++
  return end
}
