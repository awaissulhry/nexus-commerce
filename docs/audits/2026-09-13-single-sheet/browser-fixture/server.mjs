import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { gunzipSync } from 'node:zlib'
const root = fileURLToPath(new URL('.', import.meta.url)), repo = resolve(root, '../../../..')
const sheets = Object.fromEntries(['SHOPIFY', 'ETSY'].map(channel => [channel, JSON.parse(readFileSync(`${root}/${channel.toLowerCase()}.json`, 'utf8'))]))
sheets.MASTER = JSON.parse(readFileSync(`${root}/master.json`, 'utf8'))
const baseline = process.argv.includes('--baseline')
const port = baseline ? 3159 : 3158
let failNextRead = false
const writes = []
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
  server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [root, repo] } },
  plugins: [{ name: 'pre-consolidation-snapshot', enforce: 'pre', load(id) {
    if (!baseline) return null
    const sheetRoot = repo + '/apps/web/src/app/products/[id]/edit/_studio/sheet/'
    if (id === sheetRoot + 'ProductSheet.tsx') return `import { MasterSheet } from './master/MasterSheet'; import { ChannelSheet } from './channel/ChannelSheet'; export function ProductSheet(props) { return props.scope === 'master' ? <MasterSheet {...props} /> : <ChannelSheet {...props} /> }`
    if (id === sheetRoot + 'master/MasterSheet.tsx') return gunzipSync(readFileSync(root + '/../baseline/MasterSheet.tsx.gz')).toString()
    if (id === sheetRoot + 'channel/ChannelSheet.tsx') return gunzipSync(readFileSync(root + '/../baseline/ChannelSheet.tsx.gz')).toString()
    if (id === sheetRoot + 'channel/value-source.ts') return gunzipSync(readFileSync(root + '/../baseline/value-source.ts.gz')).toString()
    return null
  } }, { name: 'isolated-store-api', configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`)
      if (!url.pathname.startsWith('/api/')) return next()
      const send = (data, code = 200) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)) }
      let body = {}; if (req.method !== 'GET') { let text = ''; for await (const chunk of req) text += chunk; body = text ? JSON.parse(text) : {} }
      const channel = url.searchParams.get('channel') ?? 'MASTER'
      if (url.pathname.endsWith('/fixture/fail-next-read')) { failNextRead = true; return send({ armed: true }) }
      if (url.pathname.endsWith('/studio/sheet')) {
        if (failNextRead) { failNextRead = false; return send({ error: 'Simulated temporary sheet outage' }, 503) }
        return send(sheets[channel])
      }
      if (url.pathname.endsWith('/studio/destination')) return send({ productId: 'store-demo', familyId: 'store-demo', channel, marketplace: 'GLOBAL', accountId: channel.toLowerCase(), aliasKey: null, listing: null })
      if (url.pathname.includes('/pim/family/')) return send({ role: 'parent', self: { ...sheets.MASTER.family, isParent: true, parentId: null }, parent: null, children: sheets.MASTER.rows.slice(1).map(r => ({ id: r.id, sku: r.sku, name: r.sku, variantAttributes: null })), siblings: [] })
      if (url.pathname.endsWith('/readiness')) return send({ market: 'GLOBAL', scopes: [], computedAt: new Date().toISOString() })
      if (url.pathname.endsWith('/products/bulk')) {
        writes.push(body)
        const sheet = sheets[body.marketplaceContexts?.[0]?.channel ?? 'MASTER']
        if (!sheet) return send({ error: 'Choose the store destination.' }, 400)
        for (const change of body.changes ?? []) {
          const row = sheet.rows.find(r => r.id === change.id), key = change.field.replace(/^attr_/, '')
          if (!row?.values[key]) return send({ error: 'Unknown fixture cell' }, 400)
          row.values[key] = { ...row.values[key], value: change.value, pinned: true, follows: false, source: 'channelExplicit', layer: 'channel' }
          if (row.listing) row.listing.version++; else row.version++
        }
        return send({ success: true, updated: body.changes.length, errors: [], versionOf: sheet.scope.kind === 'master' ? 'product' : 'channelListing', currentVersion: (() => { const row = sheet.rows.find(r => r.id === body.changes[0].id); return row.listing?.version ?? row.version })() })
      }
      if (url.pathname.endsWith('/fixture/evidence')) return send({ writes })
      if (url.pathname.includes('/ai-drafts')) return send({ drafts: [] })
      if (url.pathname.endsWith('/formulas/batch')) return send({ products: {}, formulas: [] })
      if (url.pathname.endsWith('/formulas/functions')) return send({ functions: [] })
      if (url.pathname.includes('/grid-views')) return send({ views: [] })
      if (url.pathname.includes('/reference-labels')) return send({ labels: {} })
      return send({ items: [], views: [], rules: [], fields: [], families: [], counts: {}, jobs: [], sources: [], drafts: [] })
    })
  } }], optimizeDeps: { include: ['react', 'react-dom/client'] } })
await server.listen()
console.log(`Single sheet ${baseline ? 'baseline' : 'consolidated'} QA: http://127.0.0.1:${port}/products/store-demo/edit/studio?market=GLOBAL&locale=en`)
