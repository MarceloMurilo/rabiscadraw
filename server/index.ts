// Standalone production server: serves the built page (dist/) and the bridge, MCP and AI endpoints.
//
//   PORT           default 8787
//   HOST           default 127.0.0.1 (put Caddy or another proxy in front)
//   ALLOWED_HOSTS  comma separated public host names, e.g. rabiscadraw.example.com
//   STATIC_DIR     default ./dist
//   OPENAI_API_KEY optional. Without it the built-in AI is off and people use MCP with their own agent.
//
// Only real environment variables are read; there is no .env loading, so a developer .env can never
// end up on the server by accident.
import { createServer } from 'node:http'
import { createHandler } from './core'

const port = Number(process.env.PORT ?? 8787)
const host = process.env.HOST ?? '127.0.0.1'

const handler = createHandler({
  env: process.env,
  dev: false,
  staticDir: process.env.STATIC_DIR ?? 'dist',
  allowedHosts: (process.env.ALLOWED_HOSTS ?? '').split(','),
})

const server = createServer((req, res) => {
  handler(req, res, () => { res.statusCode = 404; res.end() }).catch(() => { if (!res.headersSent) res.statusCode = 500; res.end() })
})
server.keepAliveTimeout = 65_000
server.listen(port, host, () => {
  console.log(`Rabiscadraw em http://${host}:${port} (IA embutida: ${process.env.OPENAI_API_KEY ? 'ligada' : 'desligada'})`)
})
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close(() => process.exit(0)))
