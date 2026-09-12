import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createServer } from 'vite'
const root = fileURLToPath(new URL('.', import.meta.url)), repo = resolve(root, '../../../..')
const evidence = { requests: [], uploads: [], used: [] }
let mode = 'ready'
const art = name => `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><rect width="640" height="640" fill="#edf2ee"/><path d="M200 160 270 115 300 155 340 155 370 115 440 160 490 280 420 310 410 530 230 530 220 310 150 280Z" fill="#345046"/><text x="320" y="600" text-anchor="middle" fill="#17362c" font-size="24" font-family="sans-serif">${name}</text></svg>`
const file = (id, type, label, extra = {}) => ({ id: `gid://shopify/${type === 'image' ? 'MediaImage' : type === 'video' ? 'Video' : type === 'document' ? 'GenericFile' : 'Model3d'}/${id}`, accountId: 'store-a', type, label, alt: 'Synthetic catalog photograph', status: 'READY', errors: [], url: type === 'video' ? 'http://127.0.0.1:4139/demo.mp4' : `http://127.0.0.1:4139/art/${id}.svg`, previewUrl: type === 'image' || type === 'video' ? `http://127.0.0.1:4139/art/${id}.svg` : null, mimeType: type === 'image' ? 'image/jpeg' : type === 'video' ? 'video/mp4' : 'application/pdf', width: type === 'image' ? 1600 : null, height: type === 'image' ? 2000 : null, sizeBytes: 185000, durationSeconds: type === 'video' ? 14.5 : null, createdAt: '2026-09-08T09:00:00Z', updatedAt: '2026-09-08T10:00:00Z', ...extra })
const files = [file(1, 'image', 'Forest jacket — front.jpg'), file(2, 'image', 'Forest jacket — detail.jpg'), file(3, 'video', 'Product demonstration.mp4', { durationSeconds: 2 }), file(4, 'document', 'Care instructions.pdf'), file(5, 'model3d', 'Jacket model.glb', { sizeBytes: null }), file(6, 'image', 'New campaign image.jpg', { status: 'PROCESSING', url: null, previewUrl: null }), file(7, 'image', 'Unavailable image.jpg', { previewUrl: '/missing-image.jpg' }), file(8, 'video', 'Failed video.mp4', { status: 'FAILED', url: null, previewUrl: null, errors: ['Shopify could not process this example video.'] })]
const server = await createServer({ configFile: false, root, resolve: { alias: [
  { find: '@/lib/backend-url', replacement: root + '/backend.ts' },
  { find: 'next/navigation', replacement: root + '/navigation.tsx' },
  { find: 'next/link', replacement: root + '/link.tsx' },
  { find: '@', replacement: repo + '/apps/web/src' },
  { find: '@nexus/shared', replacement: repo + '/packages/shared' },
  { find: 'react-dom', replacement: repo + '/node_modules/react-dom' },
  { find: 'react', replacement: repo + '/node_modules/react' },
] }, esbuild: { jsx: 'automatic' }, define: { 'process.env.NODE_ENV': '"development"', 'process.env.NEXT_PUBLIC_WORKSPACES_ENABLED': '"1"' },
  server: { host: '127.0.0.1', port: 4139, strictPort: true, fs: { allow: [root, repo] } },
  plugins: [{ name: 'shopify-media-fixture', configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
    const url = new URL(req.url, 'http://127.0.0.1:4139')
    if (url.pathname.startsWith('/art/')) { res.setHeader('Content-Type', 'image/svg+xml'); return res.end(art(url.pathname.includes('1') ? 'FRONT' : 'DETAIL')) }
    if (url.pathname === '/missing-image.jpg') { res.statusCode = 404; return res.end() }
    if (!url.pathname.startsWith('/api/')) return next()
    const send = (body, code = 200) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)) }
    if (url.pathname === '/api/fixture/mode') { mode = url.searchParams.get('mode') ?? 'ready'; return send({ mode }) }
    if (url.pathname === '/api/fixture/evidence') return send(evidence)
    evidence.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) })
    if (url.pathname.endsWith('/media-sources')) {
      if (mode === 'source-error') return send({ error: 'The store connection is unavailable.' }, 502)
      const source = (id, label) => ({ accountId: id, label, domain: `${id}.myshopify.com`, isPrimary: id === 'store-a', readIssue: mode === 'permissions' ? 'Reconnect this store and grant access to Shopify Files.' : null, uploadIssue: mode === 'gated' ? 'Shopify uploads are disabled by the server’s publish settings.' : null })
      return send({ stores: mode === 'disconnected' ? [] : [source('store-a', 'Xavia Demo'), source('store-b', 'Second store')], defaultSource: mode === 'disconnected' ? 'nexus' : mode === 'ambiguous' ? null : 'store-a' })
    }
    if (url.pathname.endsWith('/shopify/files')) {
      if (mode === 'error') return send({ error: 'Shopify could not be reached. Please retry.' }, 502)
      const accountId = url.searchParams.get('accountId'), type = url.searchParams.get('type'), search = url.searchParams.get('search') || ''
      if (search === 'slow') await new Promise(resolve => setTimeout(resolve, 1800))
      const filtered = (accountId === 'store-b' ? [file(20, 'image', 'Second-store exclusive.jpg')] : files).filter(file => (type === 'all' || file.type === type) && file.label.toLowerCase().includes(search.toLowerCase()))
      const after = url.searchParams.get('after'), items = after ? filtered.slice(4) : filtered.slice(0, 4)
      return send({ accountId, items: mode === 'empty' ? [] : items.map(item => ({ ...item, accountId })), nextCursor: !after && filtered.length > 4 && mode !== 'empty' ? 'page-2' : null, fetchedAt: new Date().toISOString() })
    }
    if (url.pathname.endsWith('/shopify/reference')) {
      let text = ''; for await (const chunk of req) text += chunk
      const body = JSON.parse(text)
      if (mode === 'deleted') return send({ error: 'This file is no longer available in the selected store.' }, 404)
      return send({ assetId: `${body.accountId}-reference`, url: files[0].url, label: files[0].label })
    }
    if (url.pathname.endsWith('/shopify/upload')) {
      let size = 0; for await (const chunk of req) size += chunk.length
      evidence.uploads.push({ accountId: url.searchParams.get('accountId'), size })
      return send({ file: { ...files[5], accountId: url.searchParams.get('accountId') }, reused: false })
    }
    if (url.pathname.endsWith('/fixture/used')) { let text = ''; for await (const chunk of req) text += chunk; evidence.used.push(JSON.parse(text)); return send({ ok: true }) }
    return send({ error: 'Unknown fixture route' }, 404)
  }) } }], optimizeDeps: { include: ['react', 'react-dom/client'] } })
await server.listen()
console.log('Shopify media QA: http://127.0.0.1:4139')
