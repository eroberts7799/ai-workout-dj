import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 127.0.0.1 (not localhost): Spotify only allows loopback-IP redirect URIs.
// strictPort so the registered redirect URI http://127.0.0.1:5173/callback always matches.
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
})
