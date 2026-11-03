import type { El } from './types'

// internal names keep the old app name so drawings saved before the rename still load
const DB_NAME = 'rabiscalidraw'
const LEGACY_KEY = 'rabiscalidraw:v1' // first version kept the scene in localStorage

// kv:     'scene' (v1: the single drawing) and 'current' (id of the open drawing)
// meta:   one small record per drawing, cheap to list
// scenes: the elements of each drawing, loaded one at a time
export interface Meta {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  thumb?: string
}

let dbp: Promise<IDBDatabase> | null = null
function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 2)
    r.onupgradeneeded = () => {
      const d = r.result
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv')
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' })
      if (!d.objectStoreNames.contains('scenes')) d.createObjectStore('scenes')
    }
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  return dbp
}

const wrap = <T,>(r: IDBRequest<T>) =>
  new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })

async function run<T>(stores: string[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const d = await db()
  const tx = d.transaction(stores, mode)
  const done = new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error) })
  const out = await fn(tx)
  await done
  return out
}

const newId = () => crypto.randomUUID()

export async function createDrawing(name: string, els: El[] = [], thumb?: string): Promise<Meta> {
  const now = Date.now()
  const meta: Meta = { id: newId(), name, createdAt: now, updatedAt: now, thumb }
  await run(['meta', 'scenes'], 'readwrite', async (tx) => {
    tx.objectStore('meta').put(meta)
    tx.objectStore('scenes').put(els, meta.id)
  })
  return meta
}

export const loadScene = (id: string) =>
  run(['scenes'], 'readonly', (tx) => wrap<El[] | undefined>(tx.objectStore('scenes').get(id))).then((v) => v ?? [])

export async function saveScene(id: string, els: El[], thumb?: string): Promise<Meta | undefined> {
  return run(['meta', 'scenes'], 'readwrite', async (tx) => {
    const metas = tx.objectStore('meta')
    const cur = await wrap<Meta | undefined>(metas.get(id))
    if (!cur) return undefined // deleted while a save was pending
    const next = { ...cur, updatedAt: Date.now(), thumb }
    metas.put(next)
    tx.objectStore('scenes').put(els, id)
    return next
  })
}

export async function patchMeta(id: string, patch: Partial<Pick<Meta, 'name'>>) {
  await run(['meta'], 'readwrite', async (tx) => {
    const cur = await wrap<Meta | undefined>(tx.objectStore('meta').get(id))
    if (cur) tx.objectStore('meta').put({ ...cur, ...patch })
  })
}

export async function removeDrawing(id: string) {
  await run(['meta', 'scenes', 'kv'], 'readwrite', async (tx) => {
    tx.objectStore('meta').delete(id)
    tx.objectStore('scenes').delete(id)
    tx.objectStore('kv').delete(`chat:${id}`)
  })
}

// the conversation about a drawing (summary, questions, answers), kept beside it
export const loadChat = <T,>(id: string) =>
  run(['kv'], 'readonly', (tx) => wrap<T | undefined>(tx.objectStore('kv').get(`chat:${id}`)))
export const saveChat = (id: string, chat: unknown) =>
  run(['kv'], 'readwrite', async (tx) => { tx.objectStore('kv').put(chat, `chat:${id}`) })

export const setCurrent = (id: string) =>
  run(['kv'], 'readwrite', async (tx) => { tx.objectStore('kv').put(id, 'current') })

export interface Boot { metas: Meta[]; currentId: string; els: El[] }

export async function boot(): Promise<Boot> {
  try {
    let metas = await run(['meta'], 'readonly', (tx) => wrap<Meta[]>(tx.objectStore('meta').getAll()))
    if (!metas.length) {
      // first run of this version: adopt the single drawing from v1 (IndexedDB 'scene' or localStorage)
      let old: El[] = []
      try {
        old = (await run(['kv'], 'readonly', (tx) => wrap<El[] | undefined>(tx.objectStore('kv').get('scene')))) ?? []
      } catch { /* ignore */ }
      if (!old.length) {
        try {
          const raw = localStorage.getItem(LEGACY_KEY)
          if (raw) old = JSON.parse(raw) as El[]
        } catch { /* ignore */ }
      }
      metas = [await createDrawing('Desenho 1', old)]
    }
    const saved = await run(['kv'], 'readonly', (tx) => wrap<string | undefined>(tx.objectStore('kv').get('current')))
    const current = metas.find((m) => m.id === saved) ?? [...metas].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    return { metas, currentId: current.id, els: await loadScene(current.id) }
  } catch {
    // IndexedDB blocked (e.g. private window): work in memory only, saves will fail quietly
    const now = Date.now()
    return { metas: [{ id: 'local', name: 'Desenho 1', createdAt: now, updatedAt: now }], currentId: 'local', els: [] }
  }
}
