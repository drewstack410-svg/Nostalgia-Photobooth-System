import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

type R2Module = {
  loadEnvFile: (filePath: string) => void
  loadEnvFromDisk: () => string
  getR2Config: () => {
    ok: boolean
    missing: string[]
    bucket: string
    publicUrl: string
  }
  pingR2?: () => Promise<{
    configured: boolean
    connected: boolean
    apiOk: boolean
    publicOk: boolean
    bucket?: string
    publicUrl?: string
    missing: string[]
    error?: string
  }>
  uploadToR2: (opts: {
    imageDataUrl: string
    folder?: string
    publicId?: string
  }) => Promise<{
    success: boolean
    url?: string
    publicId?: string
    error?: string
  }>
}

function loadR2(): R2Module {
  const id = require.resolve('./electron/r2Upload.js')
  delete require.cache[id]
  return require(id) as R2Module
}

const loaded = loadR2().loadEnvFromDisk()
if (loaded) {
  console.log('[R2] Loaded credentials from', loaded)
} else {
  console.warn('[R2] No desktop/.env found — R2 uploads will be skipped')
}

function r2DevProxy() {
  return {
    name: 'r2-dev-proxy',
    configureServer(server: { middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] || ''
        if (url === '/api/r2-status' && req.method === 'GET') {
          const r2 = loadR2()
          const ping = r2.pingR2
            ? r2.pingR2()
            : Promise.resolve({
                configured: false,
                connected: false,
                error: 'R2 ping is unavailable — restart npm run dev',
              })
          void Promise.resolve(ping)
            .then((status) => {
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify(status))
            })
            .catch((err: unknown) => {
              res.statusCode = 500
              res.setHeader('Content-Type', 'application/json')
              res.end(
                JSON.stringify({
                  configured: false,
                  connected: false,
                  error: err instanceof Error ? err.message : String(err),
                }),
              )
            })
          return
        }
        if (url.startsWith('/r2/') && req.method === 'GET') {
          const r2 = loadR2()
          const cfg = r2.getR2Config()
          const rest = url.slice('/r2/'.length)
          const target = `${cfg.publicUrl}/${rest}`
          void fetch(target)
            .then(async (up) => {
              const buf = Buffer.from(await up.arrayBuffer())
              res.statusCode = up.status
              const contentType = up.headers.get('content-type')
              if (contentType) res.setHeader('Content-Type', contentType)
              res.setHeader('Cache-Control', 'public, max-age=300')
              res.end(buf)
            })
            .catch((err: unknown) => {
              res.statusCode = 502
              res.setHeader('Content-Type', 'text/plain')
              res.end(err instanceof Error ? err.message : String(err))
            })
          return
        }
        const sessionMatch = url.match(/^\/session\/([a-zA-Z0-9]+)\.json$/)
        if (sessionMatch && req.method === 'GET') {
          const r2 = loadR2()
          const cfg = r2.getR2Config()
          const target = `${cfg.publicUrl}/${cfg.folder}/s/${sessionMatch[1]}.json`
          void fetch(target)
            .then(async (up) => {
              const buf = Buffer.from(await up.arrayBuffer())
              res.statusCode = up.status
              res.setHeader(
                'Content-Type',
                up.headers.get('content-type') || 'application/json',
              )
              res.setHeader('Cache-Control', 'no-cache')
              res.end(buf)
            })
            .catch((err: unknown) => {
              res.statusCode = 502
              res.setHeader('Content-Type', 'application/json')
              res.end(
                JSON.stringify({
                  error: err instanceof Error ? err.message : String(err),
                }),
              )
            })
          return
        }
        if (url === '/api/r2-upload' && req.method === 'POST') {
          const chunks: Buffer[] = []
          req.on('data', (c: Buffer) => chunks.push(c))
          req.on('end', async () => {
            res.setHeader('Content-Type', 'application/json')
            try {
              const r2 = loadR2()
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
              const result = await r2.uploadToR2({
                imageDataUrl: body.imageDataUrl || body.imageData,
                folder: body.folder,
                publicId: body.publicId,
              })
              res.statusCode = result.success ? 200 : 400
              res.end(JSON.stringify(result))
            } catch (err) {
              res.statusCode = 500
              res.end(
                JSON.stringify({
                  success: false,
                  error: err instanceof Error ? err.message : String(err),
                }),
              )
            }
          })
          return
        }
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [vue(), r2DevProxy()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
server: {
    port: 5173,
    strictPort: true
  }
})
