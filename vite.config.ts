import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Garmin receiver: the Connect IQ field on the watch POSTs live workout data
 * (via the phone's Garmin Connect app) to this endpoint on the Mac's LAN IP;
 * the browser conductor GETs the latest sample. Dev-server middleware keeps
 * the "no backend" promise — the receiver lives inside vite.
 */
function garminReceiver(): Plugin {
  interface Sample {
    receivedAt: number
    [k: string]: unknown
  }
  let latest: Sample | null = null
  return {
    name: 'garmin-receiver',
    configureServer(server) {
      server.middlewares.use('/api/garmin', (req, res) => {
        if (req.method === 'POST') {
          let body = ''
          req.on('data', (c) => (body += c))
          req.on('end', () => {
            try {
              latest = { ...JSON.parse(body), receivedAt: Date.now() }
            } catch {
              // ignore malformed posts — never crash the receiver mid-run
            }
            res.statusCode = 204
            res.end()
          })
        } else {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(latest))
        }
      })
    },
  }
}

/**
 * Corpus server: the Replay Lab's supply of REAL runs. Serves the extracted
 * structured-run corpus (data/garmin-history-structured/, local-only and
 * gitignored — privacy floor) so the browser can mass-test the engine against
 * actual bodies without a backend.
 */
function corpusServer(): Plugin {
  const dir = path.resolve(process.cwd(), 'data', 'garmin-history-structured')
  let cache: { key: string; list: unknown[] } | null = null
  return {
    name: 'corpus-server',
    configureServer(server) {
      server.middlewares.use('/api/corpus', (req, res) => {
        res.setHeader('Content-Type', 'application/json')
        const sub = (req.url ?? '/').replace(/^\//, '').split('?')[0]
        if (!fs.existsSync(dir)) {
          res.end(JSON.stringify(sub ? null : []))
          return
        }
        if (sub === '') {
          const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
          const key = files.map((f) => `${f}:${fs.statSync(path.join(dir, f)).mtimeMs}`).join('|')
          if (cache?.key !== key) {
            cache = {
              key,
              list: files.map((f) => {
                try {
                  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
                  const steps = d.planSteps ?? []
                  return {
                    file: f,
                    name: d.wktName ?? d.name ?? f,
                    date: f.slice(0, 10),
                    steps: steps.length,
                    hard: steps.filter((s: { kind: string }) => s.kind === 'hard').length,
                    samples: (d.samples ?? []).length,
                  }
                } catch {
                  return null
                }
              }).filter(Boolean),
            }
          }
          res.end(JSON.stringify(cache.list))
          return
        }
        // Single file — names are our own generated slugs; allow only those.
        if (!/^[\w.-]+\.json$/.test(sub) || !fs.existsSync(path.join(dir, sub))) {
          res.statusCode = 404
          res.end('null')
          return
        }
        res.end(fs.readFileSync(path.join(dir, sub), 'utf8'))
      })
    },
  }
}

// host:true = listen on all interfaces so the watch/phone can reach us over LAN.
// The browser keeps using http://127.0.0.1:5173 (Spotify's registered redirect).
export default defineConfig({
  plugins: [react(), garminReceiver(), corpusServer()],
  server: { host: true, port: 5173, strictPort: true },
})
