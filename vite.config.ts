import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { rabiscadrawServer } from './server/plugin'

export default defineConfig(({ mode }) => ({
  // the .env (OpenAI key) is read here, on the server side only; nothing from it reaches the browser
  plugins: [react(), rabiscadrawServer(loadEnv(mode, process.cwd(), ''))],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
}))
