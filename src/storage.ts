import type { El } from './types'

// internal names keep the old app name so drawings saved before the rename still load
const DB_NAME = 'rabiscalidraw'
const STORE = 'kv'
const KEY = 'scene'
const LEGACY_KEY = 'rabiscalidraw:v1' // first version kept the scene in localStorage

let dbp: Promise<IDBDatabase> | null = null
function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1)
    r.onupgradeneeded = () => r.result.createObjectStore(STORE)
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  return dbp
}

export async function loadScene(): Promise<El[]> {
  try {
    const d = await db()
    const v = await new Promise<El[] | undefined>((res, rej) => {
      const r = d.transaction(STORE).objectStore(STORE).get(KEY)
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    if (v) return v
  } catch { /* IndexedDB unavailable: fall through */ }
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    return raw ? (JSON.parse(raw) as El[]) : []
  } catch {
    return []
  }
}

export async function saveScene(els: El[]) {
  const d = await db()
  await new Promise<void>((res, rej) => {
    const tx = d.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(els, KEY)
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
  })
}
