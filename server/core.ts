// The Rabiscadraw server, as one request handler used both by the Vite dev server (server/plugin.ts)
// and by the standalone production server (server/index.ts).
//
//   /bridge/events?session=T   the page opens this stream; MCP tool calls for T arrive here
//   /bridge/result?session=T   the page answers a tool call
//   /mcp/T                     MCP endpoint (streamable HTTP) of the person who owns session T
//   /api/ai/*                  built-in "draw with AI" (only when the server has an OpenAI key)
//
// Every browser tab group gets a random session token that only it knows. The MCP address contains
// that token, so an agent can draw only on the page of whoever handed it the address.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { COLOR_NAMES, ICONS } from '../src/catalog'
import { ASK_PROMPT, ASK_TOOLS_PROMPT, askStepOpenAiSchema, KIND_IDS, MODULE_PROMPT, moduleOpenAiSchema, moduleShape, REPO_PROMPT, askOpenAiSchema, REVIEW_PROMPT, SEQ_REPO_PROMPT, SYSTEM_PROMPT, openAiSchema, seqOpenAiSchema, seqSchema, seqShape, specShape, specSchema } from './schema'

export interface CoreOptions {
  env: Record<string, string | undefined>
  /** Vite dev server: the page comes from Vite and a token-less /mcp works from this machine. */
  dev: boolean
  /** Production: folder with the built page. */
  staticDir?: string
  /** Extra host names this server answers to (loopback is always allowed). */
  allowedHosts?: string[]
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const TOKEN = /^[A-Za-z0-9_-]{20,64}$/
const MAX_BODY = 1_000_000
const MAX_RESULT_BODY = 8_000_000 // a screenshot comes back through here
const MAX_STREAMS_PER_TOKEN = 6
const MAX_STREAMS_TOTAL = 400
const MAX_PENDING_PER_TOKEN = 8

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
}

function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) { reject(new HttpError(413, 'Corpo grande demais')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolveBody(undefined)
      try { resolveBody(JSON.parse(raw)) } catch { reject(new HttpError(400, 'JSON inválido')) }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

export function createHandler(opts: CoreOptions) {
  const env = opts.env
  const extraHosts = new Set((opts.allowedHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean))

  // ---------- who may talk to us
  const hostOf = (v: string) => v.replace(/:\d+$/, '').toLowerCase()
  const hostAllowed = (host: string) => LOOPBACK.has(host) || extraHosts.has(host)
  // Checking Host and Origin also blocks DNS rebinding from a web page.
  function allowed(req: IncomingMessage): boolean {
    if (!hostAllowed(hostOf(req.headers.host ?? ''))) return false
    const origin = req.headers.origin
    if (origin) {
      try { if (!hostAllowed(new URL(origin).hostname.toLowerCase())) return false } catch { return false }
    }
    return true
  }
  const isLoopbackReq = (req: IncomingMessage) => LOOPBACK.has(hostOf(req.headers.host ?? ''))

  // Behind Caddy every request comes from 127.0.0.1; the real address is in X-Forwarded-For.
  function clientIp(req: IncomingMessage): string {
    const remote = req.socket.remoteAddress ?? ''
    const fwd = req.headers['x-forwarded-for']
    if ((remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') && typeof fwd === 'string') {
      return fwd.split(',')[0].trim() || remote
    }
    return remote
  }

  // ---------- rate limiting (fixed window, in memory)
  const buckets = new Map<string, { n: number; t: number }>()
  const hit = (key: string, limit: number, windowMs = 60_000) => {
    const now = Date.now()
    const b = buckets.get(key)
    if (!b || now - b.t > windowMs) { buckets.set(key, { n: 1, t: now }); return true }
    return ++b.n <= limit
  }
  setInterval(() => {
    const now = Date.now()
    for (const [k, b] of buckets) if (now - b.t > 600_000) buckets.delete(k)
  }, 300_000).unref()

  // ---------- page bridge
  const clients: { token: string; res: ServerResponse }[] = []
  const pending = new Map<string, { token: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  let counter = 0

  const callBrowser = (token: string | null, op: string, args: unknown, timeoutMs = 25_000) =>
    new Promise<unknown>((resolveCall, reject) => {
      const mine = token ? clients.filter((c) => c.token === token) : clients
      const target = mine[mine.length - 1] // most recently opened tab
      if (!target) {
        reject(new Error('Nenhum navegador está com o Rabiscadraw aberto neste link. Abra o Rabiscadraw, clique no botão roxo e use o endereço MCP que ele mostra.'))
        return
      }
      const owner = target.token
      if ([...pending.values()].filter((p) => p.token === owner).length >= MAX_PENDING_PER_TOKEN) {
        reject(new Error('Muitos comandos em andamento. Espere um pouco.'))
        return
      }
      const id = `c${++counter}`
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('O navegador não respondeu a tempo.')) }, timeoutMs)
      pending.set(id, { token: owner, resolve: resolveCall, reject, timer })
      target.res.write(`data: ${JSON.stringify({ id, op, args })}\n\n`)
    })

  // ---------- built-in AI (only when this server has a key)
  const model = () => env.OPENAI_MODEL || 'gpt-5.6-luna'
  let aiDay = ''
  let aiToday = 0
  async function callJson(prompt: string, system: string, name: string, schema: Record<string, unknown>, count = true): Promise<unknown> {
    const key = env.OPENAI_API_KEY
    if (!key) throw new HttpError(503, 'A IA embutida está desligada neste servidor. Conecte o seu Claude ou Codex pelo MCP.')
    const today = new Date().toISOString().slice(0, 10)
    if (today !== aiDay) { aiDay = today; aiToday = 0 }
    if (count && ++aiToday > Number(env.DAILY_AI_LIMIT ?? 300)) throw new HttpError(429, 'Limite diário da IA embutida atingido.')
    const base = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
    let r: Response
    try {
      r = await fetch(`${base}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: model(),
          instructions: system,
          input: prompt,
          text: { format: { type: 'json_schema', name, strict: true, schema } },
        }),
        signal: AbortSignal.timeout(120_000),
      })
    } catch (e) {
      throw new HttpError(504, `Não consegui falar com a OpenAI: ${e instanceof Error ? e.message : String(e)}`)
    }
    const data: any = await r.json().catch(() => null)
    if (!r.ok) {
      // OpenAI echoes a masked copy of the key in 401s; never pass any piece of it on
      const why = String(data?.error?.message ?? 'erro desconhecido').replace(/sk-[\w*-]+/g, 'sk-…')
      throw new HttpError(502, `OpenAI ${r.status}: ${why}`)
    }
    const parts: any[] = (data?.output ?? []).flatMap((o: any) => (o?.type === 'message' ? o.content ?? [] : []))
    const refusal = parts.find((p) => p?.type === 'refusal')
    if (refusal) throw new HttpError(422, `O modelo recusou: ${refusal.refusal}`)
    const text: string | undefined = parts.find((p) => p?.type === 'output_text')?.text
    if (!text) throw new HttpError(502, `Resposta sem conteúdo (status ${data?.status ?? '?'}).`)
    try { return JSON.parse(text) } catch { throw new HttpError(502, 'O modelo devolveu um JSON inválido.') }
  }

  async function generateSpec(prompt: string, system = SYSTEM_PROMPT, mode: 'architecture' | 'sequence' = 'architecture'): Promise<any> {
    const json = await callJson(prompt, system, mode === 'sequence' ? 'sequence' : 'diagram', mode === 'sequence' ? seqOpenAiSchema : openAiSchema)
    const parsed = (mode === 'sequence' ? seqSchema : specSchema).safeParse(json)
    if (!parsed.success) throw new HttpError(502, 'O diagrama devolvido não bate com o formato esperado.')
    return parsed.data
  }

  // a question about a drawing; the answer names the pieces it is about so the page can light them up
  const askShape = z.object({ answer: z.string(), focus: z.array(z.string()) })
  const stepShape = z.object({
    action: z.enum(['grep', 'outline', 'read', 'read_symbol', 'answer']),
    pattern: z.string().nullable(), path: z.string().nullable(), from: z.number().nullable(), to: z.number().nullable(), symbol: z.string().nullable(),
    answer: z.string().nullable(), focus: z.array(z.string()).nullable(),
  })
  const MAX_STEPS = 5 // looks into the code per question; after that the answer is forced
  const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '')
  async function answerAbout(b: any) {
    const g = b?.graph
    if (!g || !Array.isArray(g.nodes) || !g.nodes.length) throw new HttpError(400, 'Desenho vazio.')
    const ids = new Set<string>()
    const nodes = g.nodes.slice(0, 80).map((n: any) => { const id = clip(n?.id, 80); ids.add(id); return { id, label: clip(n?.label, 100), kind: clip(n?.kind, 40) || undefined, description: clip(n?.description, 500) || undefined, group: clip(n?.group, 80) || undefined } })
    const groups = (Array.isArray(g.groups) ? g.groups : []).slice(0, 30).map((x: any) => { const id = clip(x?.id, 80); ids.add(id); return { id, label: clip(x?.label, 100) } })
    const edges = (Array.isArray(g.edges) ? g.edges : []).slice(0, 160).map((e: any) => ({ from: clip(e?.from, 80), to: clip(e?.to, 80), label: clip(e?.label, 120) || undefined }))
    const history = (Array.isArray(b.history) ? b.history : []).slice(-8).map((m: any) => `${m?.role === 'user' ? 'PESSOA' : 'GUIA'}: ${clip(m?.text, 1500)}`).join('\n')
    const selected = (Array.isArray(b.selected) ? b.selected : []).map((s: unknown) => clip(s, 80)).filter((s: string) => ids.has(s)).slice(0, 6)
    const overview = b.mode === 'overview'
    const question = overview ? 'Faça uma visão geral deste desenho (pedido de resumo).' : clip(b.question, 1000).trim()
    if (!question) throw new HttpError(400, 'Escreva a pergunta.')
    // with an index the AI looks into the files through tools (run in the page); without one it gets the summary as before
    const index = clip(b.index, 60_000).trim()
    const trace = (Array.isArray(b.trace) ? b.trace : []).slice(0, MAX_STEPS).map((t: any, i: number) => {
      const c = t?.call ?? {}
      const args = ['pattern', 'path', 'from', 'to', 'symbol'].filter((k) => c[k] != null).map((k) => `${k}=${JSON.stringify(typeof c[k] === 'string' ? clip(c[k], 200) : c[k])}`).join(' ')
      return `[${i + 1}] ${clip(c.action, 20)} ${args}\n${clip(t?.output, 6500)}`
    })
    const tools = !overview && !!index
    const material = tools ? `INDICE:\n${index}` : clip(b.context, 200_000) ? `MATERIAL:\n${clip(b.context, 200_000)}` : 'MATERIAL: nenhum. Responda só com o que o desenho mostra.'
    const prompt = [
      `DESENHO${b.kind === 'sequence' ? ' (diagrama de sequência)' : ''}:\n${JSON.stringify({ nodes, edges, groups })}`,
      material,
      history && `CONVERSA ATÉ AQUI:\n${history}`,
      selected.length && `PEÇAS SELECIONADAS PELA PESSOA: ${selected.join(', ')}`,
      `${overview ? 'PEDIDO' : 'PERGUNTA'}: ${question}`,
      trace.length && `INVESTIGACAO ATE AGORA:\n${trace.join('\n\n')}`,
      tools && trace.length >= MAX_STEPS && 'Você já usou todas as consultas ao código: responda agora com o que viu e diga o que não deu para confirmar.',
    ].filter(Boolean).join('\n\n')
    if (tools && trace.length < MAX_STEPS) {
      // a step: look at the code once more, or answer
      const st = stepShape.safeParse(await callJson(prompt, ASK_PROMPT + ASK_TOOLS_PROMPT, 'step', askStepOpenAiSchema, trace.length === 0))
      if (!st.success) throw new HttpError(502, 'A resposta da IA veio num formato inesperado.')
      const d = st.data
      if (d.action !== 'answer') {
        const needs = d.action === 'grep' ? d.pattern : d.action === 'read_symbol' ? d.symbol : d.path
        if (!needs) throw new HttpError(502, 'A IA pediu uma consulta ao código sem os dados necessários.')
        return { tool: { action: d.action, pattern: d.pattern, path: d.path, from: d.from, to: d.to, symbol: d.symbol } }
      }
      if (!d.answer?.trim()) throw new HttpError(502, 'A IA não respondeu.')
      return { answer: d.answer.trim(), focus: [...new Set(d.focus ?? [])].filter((f) => ids.has(f)).slice(0, 6) }
    }
    const parsed = askShape.safeParse(await callJson(prompt, tools ? ASK_PROMPT + ASK_TOOLS_PROMPT : ASK_PROMPT, 'answer', askOpenAiSchema, !tools || trace.length === 0))
    if (!parsed.success) throw new HttpError(502, 'A resposta da IA veio num formato inesperado.')
    return { answer: parsed.data.answer.trim(), focus: [...new Set(parsed.data.focus)].filter((f) => ids.has(f)).slice(0, 6) }
  }

  // ---------- MCP
  const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] })
  const asError = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] })
  const guarded = <A,>(fn: (a: A) => Promise<{ content: any[] }>) => async (a: A) => {
    try { return await fn(a) } catch (e) { return asError(e) }
  }

  function createMcp(token: string | null) {
    const call = (op: string, args: unknown) => callBrowser(token, op, args)
    const mcp = new McpServer({ name: 'rabiscadraw', version: '0.1.0' })
    const needsPage = ' The Rabiscadraw page must be open in the user\'s browser.'

    mcp.registerTool('list_components', {
      title: 'List ready-made components',
      description: 'Architecture components Rabiscadraw already knows how to draw (database, load_balancer, queue, api_gateway, gateway_exclusive...). Use their id as `kind` in add_diagram instead of drawing shapes.',
      inputSchema: {},
    }, guarded(async () => asText(ICONS.map((i) => ({ id: i.id, label: i.label, use_for: i.hint })))))

    mcp.registerTool('add_diagram', {
      title: 'Draw a diagram',
      description:
        'Draws a diagram on the open Rabiscadraw canvas. Describe nodes, edges and groups; the app lays them out, routes the connectors and draws them. ' +
        'Use `kind` (see list_components) for databases, load balancers, queues, gateways, users, etc. - never fake them with plain shapes. ' +
        'Give every group (boundary box) a different `color` so the areas read apart: blue = the device of the user (browser, app), green = the own backend of the system, yellow = cloud/hosting, violet = internal, local or admin tooling, red = security or risk, teal = third-party and public services. ' +
        'Each node may carry an optional `description` (1-3 sentences on what it does in the architecture); the person reads it in a card when they click the node, so add it when it helps them understand the design. ' +
        'You can grow an existing architecture: in `edges`, `from`/`to` may be the id of a node that is already on the board (see get_scene) - do NOT declare it again in `nodes`. ' +
        'The new block is then placed beside the nodes it connects to and wired to them with attached arrows. Node ids you declare must be new on this board. ' +
        'Returns the ids of the created elements so they can be referenced or deleted later.' + needsPage,
      inputSchema: {
        ...specShape,
        target: z.enum(['current', 'new']).nullish().describe('current = add below what is already on the canvas (default); new = open a new drawing'),
        name: z.string().max(80).nullish().describe('Name for the new drawing when target is "new"'),
      },
    }, guarded(async ({ target, name, ...spec }: any) => asText(await call('add_diagram', { spec, target: target ?? 'current', name: name ?? undefined }))))

    mcp.registerTool('add_sequence_diagram', {
      title: 'Draw a UML sequence diagram',
      description:
        'Draws a UML sequence diagram on the open Rabiscadraw canvas: participants across the top with dashed lifelines, then the steps in order (messages, returns, notes, alt/opt/loop boxes). ' +
        'List `participants` (2 to 12; give `kind` for a ready-made icon, see list_components) and `steps` top to bottom. A message has `from`, `to` and a short `label`; style "return" draws a dashed answer, and the same id in from and to is a message to itself. ' +
        'Open a box with a step of type "begin" (kind alt, opt or loop, `label` = the condition), use type "else" for the other branch of an alt, and close it with "end". Activation bars are drawn automatically from calls to their returns. ' +
        'Use it for the order of calls in one flow; use add_diagram for the structure of a system.' + needsPage,
      inputSchema: {
        ...seqShape,
        target: z.enum(['current', 'new']).nullish().describe('current = add below what is on the canvas (default); new = open a new drawing'),
        name: z.string().max(80).nullish().describe('Name for the new drawing when target is "new"'),
      },
    }, guarded(async ({ target, name, ...spec }: any) => asText(await call('add_sequence', { spec, target: target ?? 'current', name: name ?? undefined }))))

    mcp.registerTool('get_scene', {
      title: 'Read the architecture',
      description:
        'Reads the open drawing as an architecture: `nodes` (id, label, kind, description, group, position), `edges` (from -> to with labels, including arrows the person drew), `groups` and any `other_elements`, plus a `version` number. ' +
        'Use the node ids in add_diagram edges, update_elements, connect_nodes, delete_elements and screenshot.' + needsPage,
      inputSchema: {},
    }, guarded(async () => asText(await call('get_scene', {}))))

    mcp.registerTool('changes_since', {
      title: 'What changed since a version',
      description:
        'Pass the `version` you got from get_scene (or from the last changes_since). Returns what was added, removed or modified on the open drawing since then - by the person or by you - so you can follow along without reading everything again. ' +
        'If the version is too old or another drawing was opened it says so; then call get_scene.' + needsPage,
      inputSchema: { version: z.number().int().min(0).describe('Version number to compare against') },
    }, guarded(async (a: { version: number }) => asText(await call('changes_since', a))))

    mcp.registerTool('update_elements', {
      title: 'Edit nodes and connections',
      description:
        'Changes nodes that are already on the board, in place: `label`, `description` (empty string clears it), `kind` (swap an icon for another component), `color`, and position `x`/`y` (top-left, canvas units). ' +
        'For a connection (an edge id from get_scene) only `label` applies. Moving a node re-attaches its connections so they follow it. The person can undo with Ctrl+Z.' + needsPage,
      inputSchema: {
        updates: z.array(z.object({
          ref: z.string().max(100).describe('Node id (or edge id) from get_scene'),
          label: z.string().max(160).nullish(),
          description: z.string().max(600).nullish(),
          kind: z.enum(KIND_IDS).nullish().describe('Only for nodes that are icons'),
          color: z.enum(COLOR_NAMES).nullish(),
          x: z.number().nullish(),
          y: z.number().nullish(),
        })).min(1).max(100),
      },
    }, guarded(async (a: { updates: Record<string, unknown>[] }) => {
      // null means "leave as is", except a null description which clears it
      const clean = a.updates.map((u) => Object.fromEntries(Object.entries(u).filter(([k, v]) => v !== undefined && (v !== null || k === 'description')).map(([k, v]) => [k, v ?? ''])))
      return asText(await call('update_elements', { updates: clean }))
    }))

    mcp.registerTool('connect_nodes', {
      title: 'Connect existing nodes',
      description: 'Draws attached arrows (or plain lines) between nodes that are already on the board, with an optional caption saying what flows. Ids come from get_scene.' + needsPage,
      inputSchema: {
        edges: z.array(z.object({
          from: z.string().max(100),
          to: z.string().max(100),
          label: z.string().max(80).nullish(),
          kind: z.enum(['arrow', 'line']).nullish(),
        })).min(1).max(100),
      },
    }, guarded(async (a: { edges: unknown[] }) => asText(await call('connect_nodes', a))))

    mcp.registerTool('screenshot', {
      title: 'Screenshot the canvas',
      description:
        'Returns a PNG of the open drawing to check how it came out. By default the whole drawing. ' +
        '`ids` shows only those nodes (with the connections and group boxes between them); `region` crops a rectangle in canvas units (use positions from get_scene) - good for zooming into a crowded part; ' +
        '`numbered` draws a number on every node that has a description and returns the legend (number -> node -> description); `max_side` sets the resolution (default 1600).' + needsPage,
      inputSchema: {
        ids: z.array(z.string().max(100)).max(100).nullish().describe('Only these nodes'),
        region: z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() }).nullish(),
        numbered: z.boolean().nullish(),
        max_side: z.number().int().min(300).max(2400).nullish(),
      },
    }, guarded(async (a: { ids?: string[] | null; region?: unknown; numbered?: boolean | null; max_side?: number | null }) => {
      const r = (await call('screenshot', { ids: a.ids ?? undefined, region: a.region ?? undefined, numbered: a.numbered ?? false, max_side: a.max_side ?? undefined })) as {
        png?: string
        legend?: unknown[]
      }
      if (!r?.png) throw new Error('O desenho está vazio.')
      const content: any[] = [{ type: 'image' as const, data: r.png, mimeType: 'image/png' }]
      if (r.legend?.length) content.push({ type: 'text' as const, text: JSON.stringify({ legend: r.legend }, null, 2) })
      return { content }
    }))

    mcp.registerTool('list_drawings', {
      title: 'List drawings',
      description: 'Lists the drawings in the side bar and tells which one is open.' + needsPage,
      inputSchema: {},
    }, guarded(async () => asText(await call('list_drawings', {}))))

    mcp.registerTool('open_drawing', {
      title: 'Open a drawing',
      description: 'Switches to another drawing by id or exact name.' + needsPage,
      inputSchema: { id: z.string().max(200).describe('Drawing id or name') },
    }, guarded(async (a: { id: string }) => asText(await call('open_drawing', a))))

    mcp.registerTool('clear_drawing', {
      title: 'Clear the open drawing',
      description: 'Removes every element of the open drawing (the user can undo with Ctrl+Z).' + needsPage,
      inputSchema: {},
    }, guarded(async () => asText(await call('clear', {}))))

    mcp.registerTool('delete_elements', {
      title: 'Delete elements',
      description: 'Deletes nodes or elements of the open drawing by id (ids come from get_scene or add_diagram). Deleting a node also removes the connections attached to it.' + needsPage,
      inputSchema: { ids: z.array(z.string().max(100)).min(1).max(500) },
    }, guarded(async (a: { ids: string[] }) => asText(await call('delete_elements', a))))

    return mcp
  }

  // ---------- static files (production)
  const root = opts.staticDir ? resolve(opts.staticDir) : null
  function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
    if (!root || (req.method !== 'GET' && req.method !== 'HEAD')) return false
    let rel: string
    try { rel = decodeURIComponent(path) } catch { return false }
    if (rel.includes('\0')) return false
    let file = normalize(join(root, rel === '/' ? 'index.html' : rel))
    if (file !== root && !file.startsWith(root + sep)) return false
    let st = statSafe(file)
    if (st?.isDirectory()) { file = join(file, 'index.html'); st = statSafe(file) }
    if (!st) {
      if (extname(rel)) return false // a missing asset is a 404, not the app
      file = join(root, 'index.html') // any other path belongs to the single-page app
      st = statSafe(file)
      if (!st) return false
    }
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
    res.statusCode = 200
    res.setHeader('content-type', type)
    res.setHeader('content-length', String(st.size))
    res.setHeader('cache-control', rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
    if (req.method === 'HEAD') { res.end(); return true }
    createReadStream(file).on('error', () => res.destroy()).pipe(res)
    return true
  }
  const statSafe = (f: string) => { try { return statSync(f) } catch { return null } }

  function securityHeaders(res: ServerResponse) {
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('x-frame-options', 'DENY')
    res.setHeader(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    )
  }

  // ---------- routing
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    const mcpMatch = path.match(/^\/mcp(?:\/([^/]+))?$/)
    const mine = path.startsWith('/bridge/') || path.startsWith('/api/') || !!mcpMatch || path === '/healthz'

    if (!opts.dev) securityHeaders(res)

    if (!mine) {
      if (opts.dev) return next()
      if (!allowed(req)) return sendJson(res, 421, { error: 'Host não autorizado.' })
      if (serveStatic(req, res, path)) return
      return sendJson(res, 404, { error: 'Não encontrado.' })
    }
    if (path === '/healthz') { res.setHeader('content-type', 'text/plain'); return void res.end('ok') }
    if (!allowed(req)) return sendJson(res, 403, { error: 'Host ou origem não autorizados.' })
    const ip = clientIp(req)

    try {
      if (path === '/bridge/events' && req.method === 'GET') {
        const token = url.searchParams.get('session') ?? ''
        if (!TOKEN.test(token)) throw new HttpError(400, 'Sessão inválida.')
        if (!hit(`sse:${ip}`, 60)) throw new HttpError(429, 'Muitas conexões.')
        if (clients.length >= MAX_STREAMS_TOTAL) throw new HttpError(503, 'Servidor cheio. Tente de novo em instantes.')
        const own = clients.filter((c) => c.token === token)
        if (own.length >= MAX_STREAMS_PER_TOKEN) own[0].res.end() // too many tabs: drop the oldest
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
        res.write(': conectado\n\n')
        const entry = { token, res }
        clients.push(entry)
        const ping = setInterval(() => res.write(': ping\n\n'), 20_000)
        req.on('close', () => {
          clearInterval(ping)
          const i = clients.indexOf(entry)
          if (i >= 0) clients.splice(i, 1)
        })
        return
      }

      if (path === '/bridge/result' && req.method === 'POST') {
        const token = url.searchParams.get('session') ?? ''
        if (!TOKEN.test(token)) throw new HttpError(400, 'Sessão inválida.')
        if (!hit(`res:${token}`, 300)) throw new HttpError(429, 'Muitas respostas.')
        const b = (await readBody(req, MAX_RESULT_BODY)) as { id?: string; ok?: boolean; data?: unknown; error?: string } | undefined
        const p = b?.id ? pending.get(b.id) : undefined
        if (p && b && p.token === token) { // only the page that was asked may answer
          clearTimeout(p.timer)
          pending.delete(b.id!)
          if (b.ok) p.resolve(b.data)
          else p.reject(new Error(String(b.error ?? 'Falhou no navegador.').slice(0, 500)))
        }
        return sendJson(res, 200, { ok: true })
      }

      if (path === '/api/ai/status' && req.method === 'GET') {
        const configured = !!env.OPENAI_API_KEY
        return sendJson(res, 200, { configured, model: configured ? model() : null, dev: opts.dev })
      }

      if (path === '/api/ai/diagram' && req.method === 'POST') {
        if (!hit(`ai:${ip}`, 10)) throw new HttpError(429, 'Muitos pedidos. Espere um minuto.')
        const b = (await readBody(req)) as { prompt?: unknown } | undefined
        const prompt = typeof b?.prompt === 'string' ? b.prompt.trim().slice(0, 4000) : ''
        if (!prompt) throw new HttpError(400, 'Escreva o que você quer desenhar.')
        return sendJson(res, 200, { spec: await generateSpec(prompt) })
      }

      if (path === '/api/ai/ask' && req.method === 'POST') {
        if (!hit(`ask:${ip}`, 90)) throw new HttpError(429, 'Muitas perguntas. Espere um minuto.')
        return sendJson(res, 200, await answerAbout(await readBody(req, 900_000)))
      }

      // deep analysis: the page cuts the repository into modules and asks for one summary each, in parallel
      if (path === '/api/ai/module' && req.method === 'POST') {
        if (!hit(`module:${ip}`, 150)) throw new HttpError(429, 'Muitos módulos de uma vez. Espere um minuto.')
        const b = (await readBody(req, 400_000)) as { name?: unknown; label?: unknown; files?: unknown } | undefined
        const files = Array.isArray(b?.files) ? (b!.files as any[]).filter((f) => typeof f?.path === 'string' && typeof f?.text === 'string').slice(0, 400) : []
        if (!files.length) throw new HttpError(400, 'Módulo sem arquivos.')
        const label = typeof b?.label === 'string' ? b.label.slice(0, 120) : 'módulo'
        const name = typeof b?.name === 'string' ? b.name.slice(0, 80) : 'repositório'
        let body = `Repositório: ${name}\nMódulo: ${label}\n`
        for (const f of files) body += `\n### ${String(f.path).slice(0, 300)}\n${String(f.text).slice(0, 120_000)}\n`
        const out = moduleShape.safeParse(await callJson(body.slice(0, 260_000), MODULE_PROMPT, 'module', moduleOpenAiSchema, false))
        if (!out.success) throw new HttpError(502, 'A IA devolveu um resumo de módulo inválido.')
        return sendJson(res, 200, { module: out.data })
      }

      if (path === '/api/ai/repo' && req.method === 'POST') {
        if (!hit(`repo:${ip}`, 4)) throw new HttpError(429, 'Muitas análises. Espere um minuto.')
        const b = (await readBody(req, 700_000)) as { name?: unknown; summary?: unknown; views?: unknown } | undefined
        const summary = typeof b?.summary === 'string' ? b.summary.slice(0, 260_000) : ''
        if (!summary.trim()) throw new HttpError(400, 'Resumo do repositório vazio.')
        const name = typeof b?.name === 'string' ? b.name.slice(0, 80) : 'repositório'
        const views = Array.isArray(b?.views) ? (b!.views as unknown[]).filter((v) => v === 'architecture' || v === 'sequence') : ['architecture']
        if (!views.length) throw new HttpError(400, 'Escolha o que desenhar.')
        const material = `Nome do repositório: ${name}\n\n${summary}`
        // the views are independent: ask for them at the same time
        const architecture = async () => {
          const draft = await generateSpec(material, REPO_PROMPT)
          // second pass: the draft is checked against the evidence; if that fails the draft is still a fine answer
          try { return await generateSpec(`${material}\n\n## RASCUNHO DO DIAGRAMA (JSON)\n${JSON.stringify(draft)}`, REVIEW_PROMPT) } catch { return draft }
        }
        const [arch, seq] = await Promise.all([
          views.includes('architecture') ? architecture() : null,
          views.includes('sequence') ? generateSpec(material, SEQ_REPO_PROMPT, 'sequence') : null,
        ])
        return sendJson(res, 200, { architecture: arch, sequence: seq, spec: arch })
      }

      if (mcpMatch) {
        const token = mcpMatch[1] ?? null
        if (token === null && !(opts.dev && isLoopbackReq(req))) {
          throw new HttpError(404, 'Use o endereço MCP pessoal que o Rabiscadraw mostra no painel (botão roxo).')
        }
        if (token !== null && !TOKEN.test(token)) throw new HttpError(404, 'Endereço MCP inválido.')
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          return sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Use POST.' }, id: null })
        }
        if (!hit(`mcp-ip:${ip}`, 240) || (token && !hit(`mcp:${token}`, 90))) throw new HttpError(429, 'Muitas chamadas. Espere um minuto.')
        const body = await readBody(req)
        const mcp = createMcp(token)
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
        res.on('close', () => { transport.close(); mcp.close() })
        await mcp.connect(transport)
        await transport.handleRequest(req, res, body)
        return
      }

      sendJson(res, 404, { error: 'Rota desconhecida.' })
    } catch (e) {
      if (res.headersSent) { res.end(); return }
      const status = e instanceof HttpError ? e.status : 500
      sendJson(res, status, { error: e instanceof HttpError ? e.message : 'Erro interno.' })
    }
  }
}
