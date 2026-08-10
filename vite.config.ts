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

// host:true = listen on all interfaces so the watch/phone can reach us over LAN.
// The browser keeps using http://127.0.0.1:5173 (Spotify's registered redirect).
export default defineConfig({
  plugins: [react(), garminReceiver()],
  server: { host: true, port: 5173, strictPort: true },
})
