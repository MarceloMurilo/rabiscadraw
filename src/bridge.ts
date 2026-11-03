// Link between this page and the server. MCP agents call the server at an address that contains this
// browser's private token, the server pushes the command here over SSE, the page applies it to the
// open drawing and posts the result back.
export type BridgeHandler = (op: string, args: any) => Promise<unknown>

const KEY = 'rabiscadraw:mcp-token'

const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function loadToken(): string {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved && /^[A-Za-z0-9_-]{20,64}$/.test(saved)) return saved
  } catch { /* storage blocked */ }
  const fresh = randomToken()
  try { localStorage.setItem(KEY, fresh) } catch { /* storage blocked */ }
  return fresh
}

export function newToken(): string {
  const fresh = randomToken()
  try { localStorage.setItem(KEY, fresh) } catch { /* storage blocked */ }
  return fresh
}

export function connectBridge(token: string, handle: BridgeHandler) {
  const es = new EventSource(`/bridge/events?session=${encodeURIComponent(token)}`)
  es.onmessage = async (ev) => {
    let msg: { id: string; op: string; args: unknown }
    try { msg = JSON.parse(ev.data) } catch { return }
    let body: { id: string; ok: boolean; data?: unknown; error?: string }
    try {
      body = { id: msg.id, ok: true, data: await handle(msg.op, msg.args) }
    } catch (e) {
      body = { id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    fetch(`/bridge/result?session=${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => { /* server gone */ })
  }
  return () => es.close()
}
