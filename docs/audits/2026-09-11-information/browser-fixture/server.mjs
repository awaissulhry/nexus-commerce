import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
const root = fileURLToPath(new URL('.', import.meta.url)), repo = resolve(root, '../../../..')
let mode = ''; const writes = []; const layouts = new Map()
const server = await createServer({ configFile: false, root, resolve: { alias: [
  { find: '@/lib/auth/AuthProvider', replacement: root + '/auth.ts' },
  { find: '@/lib/backend-url', replacement: root + '/backend.ts' },
  { find: 'next/navigation', replacement: root + '/navigation.tsx' },
  { find: 'next/link', replacement: root + '/link.tsx' },
  { find: 'next/dynamic', replacement: root + '/dynamic.tsx' },
  { find: '@', replacement: repo + '/apps/web/src' },
  { find: '@nexus/shared', replacement: repo + '/packages/shared' },
  { find: 'react-dom', replacement: repo + '/node_modules/react-dom' },
  { find: 'react', replacement: repo + '/node_modules/react' },
] }, esbuild: { jsx: 'automatic' }, define: { 'process.env.NODE_ENV': '"development"' },
  server: { host: '127.0.0.1', port: 3151, strictPort: true, fs: { allow: [root, repo] } },
  plugins: [{ name: 'isolated-store-api', configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, 'http://127.0.0.1:3151')
      if (!url.pathname.startsWith('/api/')) return next()
      const send = (data, code = 200) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)) }
      let body = {}; if (req.method !== 'GET') { let text = ''; for await (const chunk of req) text += chunk; body = text ? JSON.parse(text) : {} }
      if (url.pathname === '/api/fixture/mode') { mode = body.mode; return send({ ok: true }) }
      if (url.pathname === '/api/fixture/evidence') return send({ writes })
      if (url.pathname.startsWith('/api/saved-views')) {
        if (req.method === 'GET') return send({ items: [...layouts.values()].filter(layout => layout.surface === url.searchParams.get('surface')) })
        const layout = { ...body, id: url.pathname.split('/')[3] ?? `layout-${layouts.size + 1}`, updatedAt: new Date().toISOString() }; layouts.set(layout.id, layout); return send(layout)
      }
      if (url.pathname === '/api/products/ai/drafts') return send({ drafts: [], counts: { total: 0, pending: 0, failed: 0, stale: 0 } })
      if (url.pathname.includes('/grid-views')) return send({ views: [] })
      if (url.pathname.includes('/reference-labels')) return send({ labels: {} })
      if (mode === 'delay' && url.pathname.endsWith('/studio/sheet')) { mode = ''; await new Promise(resolve => setTimeout(resolve, 2500)) }
      const target = 'http://127.0.0.1:4116' + url.pathname + url.search
      try {
        const response = await fetch(target, { method: req.method, ...(req.method !== 'GET' ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) })
        const data = await response.json()
        if (req.method !== 'GET') { writes.push({ url: url.pathname, body, status: response.status, response: data }); if (mode === 'interrupt' && req.method === 'PATCH' && response.ok) { mode = ''; return send({ error: 'Controlled fixture: connection interrupted after save.' }, 503) } }
        if (response.status === 404 && (url.pathname.includes('/views') || url.pathname.includes('/events') || url.pathname.includes('/status'))) return send({ items: [], views: [], jobs: [] })
        return send(data, response.status)
      } catch (error) { return send({ error: String(error) }, 502) }

    })
  } }], optimizeDeps: { include: ['react', 'react-dom/client'] } })
await server.listen()
console.log('Disposable Information QA: http://127.0.0.1:3151/products/store-demo/edit/studio?market=IT')
