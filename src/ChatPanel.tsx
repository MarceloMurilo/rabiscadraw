// The guide of a drawing: shows what the AI summarised about the repository and answers questions about each piece.
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatData } from './chat'

// **bold**, `code` and "- " lists; nothing else, and never raw HTML
function Rich({ text }: { text: string }) {
  const inline = (s: string): ReactNode[] =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((p, i) =>
      p.startsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : p.startsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : p,
    )
  const lines = text.split('\n').filter((l) => l.trim())
  const out: ReactNode[] = []
  let items: string[] = []
  const flush = () => {
    if (items.length) out.push(<ul key={`u${out.length}`}>{items.map((t, i) => <li key={i}>{inline(t)}</li>)}</ul>)
    items = []
  }
  for (const l of lines) {
    const m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(l)
    if (m) items.push(m[1])
    else { flush(); out.push(<p key={`p${out.length}`}>{inline(l)}</p>) }
  }
  flush()
  return <>{out}</>
}

export interface Pick { ids: string[]; label: string; question: string }

export function ChatPanel({ chat, busy, status, labels, pick, onAsk, onFocus, onClose }: {
  chat: ChatData
  busy: boolean
  /** what the guide is looking into right now (a file, a function) */
  status?: string
  labels: Record<string, string>
  pick: Pick | null
  onAsk: (question: string, selected: string[]) => void
  onFocus: (ids: string[]) => void
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [chat.messages.length, busy])
  const send = () => {
    const q = text.trim()
    if (!q || busy) return
    setText('')
    onAsk(q, pick?.ids ?? [])
  }
  return (
    <div className="panel chat-panel">
      <div className="ai-head">
        <strong>{chat.kind === 'sequence' ? 'Guia da sequência' : 'Guia da arquitetura'} · {chat.repoName}</strong>
        <button onClick={onClose} title="Fechar">✕</button>
      </div>
      <div className="chat-list">
        {chat.messages.length === 0 && busy && <p className="chat-wait">Lendo o desenho e montando um resumo…</p>}
        {chat.messages.map((m, i) => (
          <div key={i} className={'chat-msg ' + m.role + (m.error ? ' err' : '')}>
            {m.role === 'ai' ? <Rich text={m.text} /> : <p>{m.text}</p>}
            {m.role === 'ai' && !!m.focus?.length && (
              <div className="chat-chips">
                {m.focus.map((f) => <button key={f} title="Mostrar no quadro" onClick={() => onFocus([f])}>{labels[f] ?? f}</button>)}
                {m.focus.length > 1 && <button className="all" title="Piscar todas as peças" onClick={() => onFocus(m.focus!)}>ver todas</button>}
              </div>
            )}
          </div>
        ))}
        {busy && chat.messages.length > 0 && <p className="chat-wait">{status ?? 'Pensando…'}</p>}
        <div ref={end} />
      </div>
      {pick && (
        <button className="chat-pick" disabled={busy} onClick={() => onAsk(pick.question, pick.ids)} title="Pergunta sobre a peça selecionada no quadro">
          Explicar «{pick.label}»
        </button>
      )}
      <div className="chat-input">
        <textarea
          rows={2}
          value={text}
          placeholder={pick ? `Pergunte sobre «${pick.label}» ou sobre qualquer parte…` : 'Pergunte sobre qualquer parte. Clique numa peça para explicá-la.'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
        />
        <button className="ai-go" disabled={busy || !text.trim()} onClick={send}>Enviar</button>
      </div>
    </div>
  )
}
