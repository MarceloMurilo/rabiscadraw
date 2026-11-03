// A soft pulsing halo around the pieces the guide is talking about. Lives above the canvas, never stored.
import type { El, View } from './types'
import { bbox } from './geometry'

export function FocusGlow({ els, view }: { els: El[]; view: View }) {
  return (
    <>
      {els.map((e) => {
        const b = bbox(e), pad = 10
        return (
          <div
            key={e.id}
            className="focus-glow"
            style={{ left: view.x + (b.x - pad) * view.zoom, top: view.y + (b.y - pad) * view.zoom, width: (b.w + 2 * pad) * view.zoom, height: (b.h + 2 * pad) * view.zoom }}
          />
        )
      })}
    </>
  )
}
