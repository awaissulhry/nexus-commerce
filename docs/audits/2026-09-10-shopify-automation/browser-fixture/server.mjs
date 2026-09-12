import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { fieldAddress, linkedFamilyChanges } from '../../../../packages/shared/dist/shopify-linked-products.js'
const root = fileURLToPath(new URL('.', import.meta.url)), repo = resolve(root, '../../../..')
const id = (kind, n) => `gid://shopify/${kind}/${n}`, writes = [], fields = new Map()
const members = ['Red touring jacket', 'Blue touring jacket', 'Black touring jacket'].map((title, n) => ({ id: id('Product', n + 1), title, handle: title.toLowerCase().replaceAll(' ', '-'), image: null }))
const def = (key, name, type, extra = {}) => ({ id: `definition-${key}`, name, description: null, namespace: 'custom', key, ownerType: 'PRODUCT', type, validations: [], access: { admin: null, storefront: 'PUBLIC_READ' }, ...extra })
const definitions = [def('siblings', 'Linked variations', 'list.product_reference'), def('colour', 'Colour label', 'single_line_text_field'), def('caption', 'Product caption', 'multi_line_text_field'), def('features', 'Feature sections', 'list.metaobject_reference', { validations: [{ name: 'metaobject_definition_id', value: id('MetaobjectDefinition', 1) }] }), def('gallery', 'Additional gallery', 'list.file_reference'), def('featured', 'Featured style', 'boolean'), def('size_note', 'Size note', 'single_line_text_field', { ownerType: 'PRODUCTVARIANT' }), def('managed', 'App content', 'single_line_text_field', { namespace: 'app--123', readOnlyReason: 'This field is managed by another app.' })]
const entryDefinition = { publishable: true, id: id('MetaobjectDefinition', 1), name: 'Product feature', type: 'feature', description: null, access: { admin: null, storefront: 'PUBLIC_READ' }, fields: [def('heading', 'Heading', 'single_line_text_field', { namespace: 'feature', ownerType: 'METAOBJECT' }), def('image', 'Feature image', 'file_reference', { namespace: 'feature', ownerType: 'METAOBJECT' })] }
const schema = { definitions, metaobjectDefinitions: [entryDefinition], types: [...new Set(definitions.map(d => d.type))].map(name => ({ name, category: 'TEXT' })), locales: [{ locale: 'en', primary: true, published: true }, { locale: 'it', primary: false, published: true }], revision: 'schema-1' }
for (const member of members) for (const [key, value] of Object.entries({ siblings: JSON.stringify(members.slice(0, 2).map(m => m.id)), colour: member.title.split(' ')[0], caption: `Touring protection in ${member.title.split(' ')[0].toLowerCase()}.`, features: JSON.stringify([id('Metaobject', 1)]), featured: 'false' })) {
  const type = definitions.find(d => d.key === key).type, field = { ownerId: member.id, namespace: 'custom', key, type, value, compareDigest: `base-${member.id}-${key}` }; fields.set(fieldAddress(field), field)
}
const entry = { status: 'ACTIVE', id: id('Metaobject', 1), name: 'Red shoulder protection', type: 'feature', handle: 'red-shoulder', revision: 'entry-1', fields: [{ key: 'heading', type: 'single_line_text_field', value: 'Red shoulder protection' }, { key: 'image', type: 'file_reference', value: null }], definition: entryDefinition, usedBy: members.slice(0, 2).map(m => ({ id: m.id, label: m.title })), moreUses: false }
let workspace = { productId: 'store-demo', familyId: 'store-demo', name: 'Touring jacket family', destination: { accountId: 'shopify', listingId: 'demo-listing', market: 'GLOBAL' }, revision: '1', draft: { version: 1, members: members.slice(0, 2), relationship: { namespace: 'custom', key: 'siblings', includeSelf: true }, baselineLinks: members.slice(0, 2).map(m => fields.get(fieldAddress({ ownerId: m.id, namespace: 'custom', key: 'siblings' }))), edits: [] }, suggestedProductIds: [members[0].id], operation: null }
const entries = new Map([[entry.id, entry]])
let plan = null, counter = 1, mode = ''
const update = () => { workspace.revision = String(++counter); return workspace }
const snapshots = addresses => addresses.map(a => structuredClone(fields.get(fieldAddress(a)) ?? { ...a, type: 'list.product_reference', value: null, compareDigest: null }))
const server = await createServer({ configFile: false, root, resolve: { alias: [
  { find: '@/lib/auth/AuthProvider', replacement: root + '/auth.ts' }, { find: '@/lib/backend-url', replacement: root + '/backend.ts' },
  { find: 'next/navigation', replacement: root + '/navigation.tsx' }, { find: 'next/link', replacement: root + '/link.tsx' }, { find: 'next/dynamic', replacement: root + '/dynamic.tsx' },
  { find: '@', replacement: repo + '/apps/web/src' }, { find: '@nexus/shared', replacement: repo + '/packages/shared' },
  { find: 'react-dom', replacement: repo + '/node_modules/react-dom' }, { find: 'react', replacement: repo + '/node_modules/react' },
] }, esbuild: { jsx: 'automatic' }, define: { 'process.env.NODE_ENV': '"development"' }, server: { hmr: false, host: '127.0.0.1', port: 3143, strictPort: true, fs: { allow: [root, repo] } },
plugins: [{ name: 'isolated-linked-shopify', configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
  const url = new URL(req.url, 'http://127.0.0.1:3143'); if (!url.pathname.startsWith('/api/')) return next()
  const send = (data, code = 200) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)) }
  let body = {}; if (req.method !== 'GET') { let raw = ''; for await (const chunk of req) raw += chunk; body = raw ? JSON.parse(raw) : {} }
  if (url.pathname.endsWith('/fixture/mode')) { mode = body.mode; return send({ mode }) }
  if (url.pathname.endsWith('/fixture/evidence')) return send({ writes, workspace, fields: [...fields.values()], entries: [...entries.values()] })
  if (url.pathname.endsWith('/studio/destination')) return send({ productId: 'store-demo', familyId: 'store-demo', channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId: 'shopify', aliasKey: null, listing: null })
  if (url.pathname.endsWith('/readiness')) return send({ market: 'GLOBAL', scopes: [], computedAt: new Date().toISOString() })
  if (url.pathname.includes('/shopify-linked')) {
    const suffix = url.pathname.split('/shopify-linked')[1]
    if (req.method !== 'GET') writes.push({ suffix, body })
    if (!suffix) { if (req.method === 'PUT') { if (mode === 'conflict') { mode = ''; update() }; if (body.expectedRevision !== workspace.revision) return send({ error: 'Draft changed' }, 409); workspace.draft = body.draft; workspace.automation = { ...workspace.automation, mode: 'PAUSED', status: 'IDLE', message: 'Draft changed. Review the saved rules before enabling automation.' }; update() }; return send(workspace) }
    if (suffix === '/suggest-sharing') return send(definitions.filter(d => d.ownerType === 'PRODUCT' && !d.readOnlyReason && d.key !== 'siblings' && !(body.draft.sharedFields ?? []).some(r => r.key === d.key)).flatMap(d => { const baseline = snapshots(body.draft.members.map(m => ({ ownerId: m.id, namespace: d.namespace, key: d.key }))); return baseline[0].value !== null && baseline.every(f => f.value === baseline[0].value) ? [{ name: d.name, rule: { namespace: d.namespace, key: d.key, sourceProductId: body.draft.members[0].id, excludedProductIds: [], baseline } }] : [] }))
    if (suffix === '/discover') return send({ draft: { ...workspace.draft, edits: [] }, candidates: [{ namespace: 'custom', key: 'siblings', name: 'Linked variations', linkedProducts: 2 }], reasons: ['Discovered from reciprocal Shopify links.'] })
    if (suffix === '/automation') { if (body.expectedRevision !== workspace.revision) return send({ error: 'Draft changed' }, 409); workspace.automation = { mode: body.mode, status: 'IDLE', lastCheckedAt: null, lastVerifiedAt: null, message: 'The reviewed rules run in the background.', changes: 0 }; return send(update()) }
    if (suffix === '/automation-check') { workspace.automation = { ...workspace.automation, status: 'VERIFIED', lastCheckedAt: new Date().toISOString(), lastVerifiedAt: new Date().toISOString(), message: 'Family links and shared content match the saved rules.', changes: 0 }; return send(update()) }
    if (suffix === '/schema') return send(schema)
    if (suffix === '/products') return send(members.filter(m => body.ids.includes(m.id)))
    if (suffix === '/read-links') return send(snapshots(body.ids.map(ownerId => ({ ownerId, namespace: body.namespace, key: body.key }))))
    if (suffix === '/field-values') return send(snapshots(body.addresses))
    if (suffix === '/owner') { const ownerId = url.searchParams.get('ownerId'), product = ownerId.includes('/Product/'), member = members.find(m => m.id === (product ? ownerId : id('Product', Number(ownerId.split('/').at(-1)) - 100))) ?? members[0]; return send({ id: ownerId, title: product ? member.title : 'Small', productId: product ? ownerId : member.id, ownerType: product ? 'PRODUCT' : 'PRODUCTVARIANT', fields: [...fields.values()].filter(f => f.ownerId === ownerId), variants: product ? [{ id: id('ProductVariant', 100 + Number(ownerId.split('/').at(-1))), title: 'Small', sku: 'STYLE-S' }] : [] }) }
    if (suffix === '/references') { const type = url.searchParams.get('type'), query = url.searchParams.get('query')?.toLowerCase() ?? ''; const items = type === 'product_reference' ? members.map(m => ({ id: m.id, label: m.title, image: null, handle: m.handle })) : type?.includes('metaobject') ? [...entries.values()].map(e => ({ id: e.id, label: e.name, type: e.type, image: null })) : [{ id: id('MediaImage', 1), label: 'Red feature photograph', image: null }]; return send({ items: items.filter(i => i.label.toLowerCase().includes(query)), cursor: null }) }
    if (suffix === '/reference-names') return send(body.ids.map(ref => ({ id: ref, label: members.find(m => m.id === ref)?.title ?? (entries.get(ref)?.name ?? 'Feature photograph'), image: null })))
    if (suffix === '/import') return send({ ...workspace.draft, members: members.slice(0, 2), edits: [], relationship: body.relationship })
    if (suffix === '/preview') { plan = { revision: 'plan-' + workspace.revision, schemaRevision: schema.revision, warnings: [], changes: [...linkedFamilyChanges(workspace.draft), ...workspace.draft.edits, ...(workspace.draft.sharedFields ?? []).flatMap(rule => { const source = fields.get(fieldAddress({ ownerId: rule.sourceProductId, namespace: rule.namespace, key: rule.key })); return workspace.draft.members.filter(m => m.id !== rule.sourceProductId && !rule.excludedProductIds.includes(m.id)).flatMap(m => { const current = snapshots([{ ownerId: m.id, namespace: rule.namespace, key: rule.key }])[0]; return current.value === source.value ? [] : [{ ...current, nextValue: source.value, ownerLabel: m.title }] }) })] }; return send({ workspace, plan }) }
    if (suffix === '/synchronize') { workspace.operation = { id: '00000000-0000-4000-8000-000000000001', status: 'RUNNING', completed: 0, total: plan.changes.length, error: null }; return send(update()) }
    if (suffix === '/advance') { for (const change of plan.changes) { if (change.nextValue === null) fields.delete(fieldAddress(change)); else fields.set(fieldAddress(change), { ownerId: change.ownerId, namespace: change.namespace, key: change.key, type: change.type, value: change.nextValue, compareDigest: 'saved-' + counter }) }; if (mode === 'interrupt') { mode = ''; workspace.operation.status = 'UNVERIFIED'; workspace.operation.error = 'Response lost. Resume to verify the applied values.'; update(); return send({ error: workspace.operation.error }, 502) }; workspace.operation.status = 'VERIFIED'; workspace.operation.completed = workspace.operation.total; workspace.draft.edits = []; workspace.draft.baselineLinks = snapshots(workspace.draft.members.map(m => ({ ownerId: m.id, namespace: 'custom', key: 'siblings' }))); return send(update()) }
    if (suffix === '/rebase') { workspace.operation = null; workspace.draft.baselineLinks = snapshots(workspace.draft.members.map(m => ({ ownerId: m.id, namespace: 'custom', key: 'siblings' }))); return send(update()) }
    if (suffix === '/entry') {
      if (req.method === 'GET') return send(entries.get(url.searchParams.get('id')))
      let target = body.id ? entries.get(body.id) : [...entries.values()].find(e => e.handle === body.handle)
      if (!target) { target = { ...structuredClone(entry), id: id('Metaobject', entries.size + 1), handle: body.handle, fields: [], usedBy: [], moreUses: false }; entries.set(target.id, target) }
      for (const field of body.fields) { const old = target.fields.find(f => f.key === field.key); if (old) old.value = field.value || null; else target.fields.push({ ...field, type: entryDefinition.fields.find(f => f.key === field.key).type }) }
      target.status = body.status ?? target.status; target.revision = 'entry-' + counter++; target.name = target.fields.find(f => f.key === 'heading')?.value ?? 'New entry'; return send(target)
    }
    return send({ error: 'Unimplemented fixture route' }, 404)
  }
  return send({ items: [], views: [], rules: [], fields: [], families: [], counts: {}, jobs: [], sources: [], products: {}, formulas: [], functions: [] })
}) } }], optimizeDeps: { include: ['react', 'react-dom/client'] } })
await server.listen()
console.log('Shopify family QA: http://127.0.0.1:3143/products/store-demo/edit/studio?scope=SHOPIFY&market=GLOBAL&tab=shopify-family')
