import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url)), repo = resolve(root, '../../../..')
const definition = (key, name, ownerType = 'PRODUCT') => ({ id: `definition:${ownerType}:${key}`, key, name, namespace: 'custom', ownerType, type: 'single_line_text_field', description: 'Store-managed field', validations: [], access: { admin: null, storefront: null }, constraints: null })
const stores = { 'store-A': { revision: 1, definitions: [definition('material', 'Material'), definition('serial', 'Serial number', 'PRODUCTVARIANT')] }, 'store-B': { revision: 1, definitions: [definition('finish', 'Finish')] } }
const clients = new Set(), evidence = { reads: {}, events: [], writes: [] }
const publish = accountId => { const event = { type: 'shopify.schema.changed', accountId, ts: Date.now() }; evidence.events.push(event); for (const client of clients) client.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`) }
const server = await createServer({ configFile: false, root, resolve: { alias: [
  { find: '@/lib/auth/AuthProvider', replacement: root + '/auth.ts' },
  { find: '@/lib/backend-url', replacement: root + '/backend.ts' },
  { find: '@', replacement: repo + '/apps/web/src' },
  { find: '@nexus/shared', replacement: repo + '/packages/shared' },
  { find: 'react-dom', replacement: repo + '/node_modules/react-dom' },
  { find: 'react', replacement: repo + '/node_modules/react' },
] }, esbuild: { jsx: 'automatic' }, define: { 'process.env.NODE_ENV': '"development"' }, server: { hmr: false, host: '127.0.0.1', port: 3156, strictPort: true, fs: { allow: [repo] } },
plugins: [{ name: 'attribute-sync-verification', configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
  const url = new URL(req.url, 'http://127.0.0.1:3156')
  if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/fixture/')) return next()
  if (url.pathname === '/api/listings/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' }); res.write(`event: ping\ndata: {"ts":${Date.now()}}\n\n`)
    clients.add(res); req.on('close', () => clients.delete(res)); return
  }
  const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
  if (url.pathname === '/fixture/evidence') return json(evidence)
  if (url.pathname === '/fixture/change') {
    let body = ''; for await (const chunk of req) body += chunk
    const { action, account } = JSON.parse(body)
    const target = action === 'Change other store' ? account === 'store-A' ? 'store-B' : 'store-A' : account
    const store = stores[target]
    if (action === 'Add definition') store.definitions = [...store.definitions.filter(d => d.key !== 'new_attribute'), definition('new_attribute', 'New store attribute')]
    if (action === 'Rename definition') store.definitions = store.definitions.map(d => d.key === 'new_attribute' ? { ...d, name: 'Renamed store attribute' } : d)
    if (action === 'Delete definition') store.definitions = store.definitions.filter(d => d.key !== 'new_attribute')
    if (action === 'Fail schema read') store.error = true
    if (action === 'Recover schema read') store.error = false
    store.revision++; publish(target); return json({ ok: true })
  }
  if (url.pathname === '/api/saved-views') return json({ items: [] })
  const account = url.searchParams.get('accountId'), store = stores[account]
  if (!store) return json({ error: 'Unknown verification store' }, 404)
  if (url.pathname.endsWith('/schema-subscriptions')) return json({ live: true })
  if (url.pathname.endsWith('/schema')) {
    evidence.reads[account] = (evidence.reads[account] ?? 0) + 1
    return store.error ? json({ error: 'Simulated connection loss' }, 503) : json({ ...store, revision: String(store.revision), metaobjectDefinitions: [], types: [{ name: 'single_line_text_field', category: 'TEXT' }], locales: [] })
  }
  if (url.pathname.endsWith('/information')) {
    const productId = 'gid://shopify/Product/1', variantId = 'gid://shopify/ProductVariant/2'
    const row = (id, kind, title) => ({ id, kind, title, productId, handle: 'verification', image: null, media: [], fields: store.definitions.filter(d => d.ownerType === kind).map(d => ({ ownerId: id, namespace: d.namespace, key: d.key, type: d.type, value: d.key === 'material' ? 'Cotton' : null, compareDigest: d.key === 'material' ? 'material-original' : null })), values: kind === 'PRODUCT' ? { title, descriptionHtml: '', tags: '[]', vendor: 'Verification' } : { price: '12.00', sku: '001' } })
    return json({ currency: 'EUR', timezone: 'Europe/Rome', rows: [row(productId, 'PRODUCT', 'Verification product'), row(variantId, 'PRODUCTVARIANT', 'Small')] })
  }
  if (url.pathname.endsWith('/reference-names')) return json([])
  return json({ error: 'This fixture does not implement that operation.' }, 404)
}) } }] })
await server.listen(); console.log('Attribute verification: http://127.0.0.1:3156')
