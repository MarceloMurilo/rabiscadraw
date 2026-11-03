// The files of a dropped repository as a tree with check boxes: the person decides what the AI may read.
import { useEffect, useMemo, useRef, useState } from 'react'

interface Node { name: string; path: string; files: string[]; kids: Map<string, Node> }

function buildTree(paths: string[]): Node {
  const root: Node = { name: '', path: '', files: [], kids: new Map() }
  for (const p of paths) {
    let cur = root
    cur.files.push(p)
    const parts = p.split('/')
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/')
      if (!cur.kids.has(part)) cur.kids.set(part, { name: part, path, files: [], kids: new Map() })
      cur = cur.kids.get(part)!
      cur.files.push(p)
    })
  }
  return root
}

function Check({ state, onChange }: { state: 'on' | 'off' | 'some'; onChange: (on: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = state === 'some' }, [state])
  return <input ref={ref} type="checkbox" checked={state === 'on'} onChange={(e) => onChange(e.target.checked)} />
}

export function RepoTree({ paths, sel, content, onToggle }: {
  paths: string[]
  sel: Set<string>
  content: Set<string> // files whose text will be sent (the rest only appear by name)
  onToggle: (paths: string[], on: boolean) => void
}) {
  const tree = useMemo(() => buildTree(paths), [paths])
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggleOpen = (p: string) => setOpen((o) => { const n = new Set(o); if (n.has(p)) n.delete(p); else n.add(p); return n })

  const rows = (node: Node, depth: number): JSX.Element[] => {
    const kids = [...node.kids.values()].sort((a, b) => Number(b.kids.size > 0) - Number(a.kids.size > 0) || a.name.localeCompare(b.name))
    return kids.flatMap((k) => {
      const isDir = k.kids.size > 0
      const on = k.files.filter((f) => sel.has(f)).length
      const state = on === 0 ? 'off' : on === k.files.length ? 'on' : 'some'
      const row = (
        <div key={k.path} className="rt-row" style={{ paddingLeft: depth * 14 }}>
          {isDir ? <button className="rt-arrow" onClick={() => toggleOpen(k.path)}>{open.has(k.path) ? '▾' : '▸'}</button> : <span className="rt-arrow" />}
          <label>
            <Check state={state} onChange={(v) => onToggle(isDir ? k.files : [k.path], v)} />
            <span className={isDir ? 'rt-dir' : ''}>{k.name}{isDir ? '/' : ''}</span>
          </label>
          {isDir
            ? <small>{on}/{k.files.length}</small>
            : content.has(k.path) ? <small className="rt-read" title="O conteúdo deste arquivo vai para a IA">conteúdo</small> : sel.has(k.path) ? <small title="Só o nome aparece">nome</small> : null}
        </div>
      )
      return isDir && open.has(k.path) ? [row, ...rows(k, depth + 1)] : [row]
    })
  }
  return <div className="rt">{rows(tree, 0)}</div>
}
