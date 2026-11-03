// Mounts the Rabiscadraw server inside the Vite dev server (same origin, same port).
import type { Plugin } from 'vite'
import { createHandler } from './core'

export function rabiscadrawServer(env: Record<string, string>): Plugin {
  return {
    name: 'rabiscadraw-server',
    configureServer(server) {
      server.middlewares.use(createHandler({ env, dev: true }))
    },
  }
}
