// The flow of a selected arrow: a soft glow along its path and a few dots running from where it starts to where it ends.
// Lives above the canvas, never stored. Keyed by the arrow, so picking another one starts it again.
import type { El, View } from './types'
import { pathOf } from './render'

const SPEED = 240 // screen pixels per second
const DOTS = 4

export const isFlowEl = (e: El | undefined): e is El => !!e && !e.aux && (e.type === 'arrow' || e.type === 'line' || e.type === 'connector')

export function FlowDots({ el, view }: { el: El; view: View }) {
  const pts = pathOf(el)
  if (!pts || pts.length < 2) return null
  const s = pts.map(([x, y]) => [view.x + x * view.zoom, view.y + y * view.zoom] as const)
  const d = s.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  let len = 0
  for (let i = 1; i < s.length; i++) len += Math.hypot(s[i][0] - s[i - 1][0], s[i][1] - s[i - 1][1])
  if (len < 8) return null
  const dur = Math.min(4, Math.max(0.9, len / SPEED))
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  return (
    <svg className="flow-dots" key={el.id}>
      <path d={d} className="flow-line" />
      {!still && Array.from({ length: DOTS }, (_, i) => (
        <circle key={i} r={3.5} className="flow-dot">
          <animateMotion dur={`${dur}s`} begin={`${(-i * dur) / DOTS}s`} repeatCount="indefinite" path={d} calcMode="linear" />
        </circle>
      ))}
    </svg>
  )
}

/** The arrow whose flow is shown: the only selected element, when it is a line, arrow or connector. */
export function flowOf(els: El[], sel: string[], enabled: boolean): El | null {
  if (!enabled || sel.length !== 1) return null
  const e = els.find((x) => x.id === sel[0])
  return isFlowEl(e) ? e : null
}

/** What lights up with it: the two pieces it joins and its caption. */
export function flowEnds(els: El[], flow: El): El[] {
  const ids = [flow.from ?? flow.bindStart, flow.to ?? flow.bindEnd]
  return [...ids.map((id) => els.find((x) => x.id === id)), els.find((x) => x.aux && x.of === flow.id)].filter((x): x is El => !!x && !x.frame)
}
