import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createServer } from 'vite'
const root = fileURLToPath(new URL('.', import.meta.url)), repo = resolve(root, '../../../..')
const calls = [], reviews = new Map()
const server = await createServer({ configFile: false, root, resolve: { alias: [
  { find: '@/lib/auth/AuthProvider', replacement: root + '/auth.ts' },
  { find: '@/lib/backend-url', replacement: root + '/backend.ts' },
  { find: '@', replacement: repo + '/apps/web/src' },
  { find: 'react-dom', replacement: repo + '/node_modules/react-dom' },
  { find: 'react', replacement: repo + '/node_modules/react' },
] }, esbuild: { jsx: 'automatic' }, define: { 'process.env.NODE_ENV': '"development"' },
  server: { host: '127.0.0.1', port: 3166, strictPort: true, fs: { allow: [root, repo] } },
  plugins: [{ name: 'isolated-studio-contract', enforce: 'pre', resolveId(source, importer) {
    if ((source === './contracts' || source === '../contracts') && importer?.includes('/edit/_studio/')) return root + '/contracts.ts'
  } }, { name: 'mock-publication-api', configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, 'http://127.0.0.1:3166')
      if (!url.pathname.startsWith('/api/')) return next()
      let body = {}; if (req.method !== 'GET') { let text = ''; for await (const part of req) text += part; body = text ? JSON.parse(text) : {} }
      const scenario = new URL(req.headers.referer ?? 'http://local').searchParams.get('scenario') ?? 'success'
      const send = (value, code = 200) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
      if (url.pathname.endsWith('/evidence')) return send(calls)
      calls.push({ method: req.method, path: url.pathname, body, scenario })
      if (url.pathname.endsWith('/preview')) {
        await new Promise(r => setTimeout(r, 250))
        if (scenario === 'error') return send({ error: 'Temporary connection failure. Please refresh the review.' }, 503)
        const review = { id: scenario === 'blocked' ? null : `review-${reviews.size + 1}`, productId: 'demo', scope: { ...body, ...(scenario === 'wrong' ? { accountId: 'wrong-account' } : {}) },
          accountLabel: 'Nexus Italy', aliasLabel: body.listingId ? 'Summer collection' : 'Primary listing', mode: 'live', action: 'update', excluded: 1,
          rows: [{ productId: 'demo', sku: 'GALE-JACKET', title: 'Gale motorcycle jacket', existing: true }, ...Array.from({ length: 3 }, (_, i) => ({ productId: `child-${i}`, sku: `GALE-JACKET-BLACK-${['S', 'M', 'L'][i]}`, title: `Black jacket · ${['Small', 'Medium', 'Large'][i]}`, existing: true }))],
          issues: scenario === 'blocked' ? [{ severity: 'error', sku: 'GALE-JACKET-BLACK-S', message: 'Price is required and must be positive.' }] : [], expiresAt: new Date(Date.now() + 900000).toISOString(),
          ...(body.channel === 'SHOPIFY' ? { visibility: 'DRAFT', locations: [{ id: 'location-one', name: 'Main warehouse' }, { id: 'location-two', name: 'Retail store' }] } : {}) }
        reviews.set(review.id, review); return send(review)
      }
      const id = url.pathname.split('/').at(req.method === 'POST' ? -2 : -1)
      if (url.pathname.endsWith('/submit')) {
        await new Promise(r => setTimeout(r, 400))
        if (scenario === 'stale') return send({ message: 'Saved information changed. Refresh the review before publishing.' }, 409)
        if (scenario === 'uncertain') return send({ message: 'The response was interrupted.' }, 502)
      }
      return send({ id, status: 'SUBMITTED', message: 'Submitted to Amazon. Feed demo-42 is awaiting processing; the listing is not yet confirmed live.', results: [{ sku: 'GALE-JACKET', status: 'SUBMITTED', reference: 'demo-42', message: 'Awaiting Amazon processing' }] })
    })
  } }], optimizeDeps: { include: ['react', 'react-dom/client'] } })
await server.listen()
console.log('Studio publication QA (provider calls mocked): http://127.0.0.1:3166/')
