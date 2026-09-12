import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'graphql'
import { emptyShopifyLinkedDraft, fieldAddress, shopifyLinkedDraftSchema, type ShopifyLinkedDraft } from '@nexus/shared/shopify-linked-products'

const fixture = vi.hoisted(() => {
  const data = { audits: [] as any[], listings: [] as any[], gql: null as any, failSave: false }
  function match(row: any, where: any): boolean { return Object.entries(where).every(([key, value]: [string, any]) => value && typeof value === 'object' && 'in' in value ? value.in.includes(row[key]) : row[key] === value) }
  const db: any = { auditLog: { create: async ({ data: row }: any) => { data.audits.push(structuredClone(row)); return { id: String(data.audits.length) } } }, product: { findFirst: async ({ where }: any) => where.id === 'family' ? { id: 'family', name: 'Family', parentId: null, deletedAt: null, children: [] } : null },
    marketplace: { findFirst: async ({ where }: any) => where.channel === 'SHOPIFY' && where.code === 'GLOBAL' ? { id: 'global', currency: 'EUR' } : null },
    channelListing: {
      findMany: async ({ where }: any) => structuredClone(data.listings.filter(row => match(row, where))),
      findUnique: async ({ where }: any) => structuredClone(data.listings.find(row => match(row, where)) ?? null),
      findFirst: async ({ where }: any) => structuredClone(data.listings.find(row => match(row, where)) ?? null),
      updateMany: async ({ where, data: patch }: any) => { if (data.failSave) throw new Error('database write failed'); const rows = data.listings.filter(row => match(row, where)); for (const row of rows) { row.platformAttributes = structuredClone(patch.platformAttributes); row.version += patch.version.increment }; return { count: rows.length } },
      create: async ({ data: input }: any) => { const row = { id: `listing-${data.listings.length}`, version: 1, ...structuredClone(input) }; data.listings.push(row); return row },
    },
  }
  db.$transaction = async (fn: any) => { const snapshot = structuredClone(data.listings); try { return await fn(db) } catch (e) { data.listings = snapshot; throw e } }
  return { data, db }
})
vi.mock('../../db.js', () => ({ default: fixture.db }))
vi.mock('../connection-resolver.service.js', () => ({ resolveChannelConnectionId: async (_: string, account: string) => { if (!['A', 'B'].includes(account)) throw new Error('Account unavailable'); return account } }))
vi.mock('./admin-client.js', () => ({ shopifyAdmin: async (account: string) => ({ graphql: (q: string, v: any) => fixture.data.gql(q, v, account) }), assertShopifyResult: (payload: any) => { if (!payload || payload.userErrors?.length) throw new Error(payload?.userErrors?.[0]?.message ?? 'Missing result'); return payload } }))
import { applyLinkedBatch, beginLinkedSync, advanceLinkedSync, buildLinkedPlan, getLinkedWorkspace, importLinkedFamily, LINKED_KEY, previewLinkedWorkspace, rebaseLinkedWorkspace, saveLinkedWorkspace } from './linked-products.service'
import { collectShopifyPages, invalidateShopifyDefinitionConstraints, readLinkedFields, readLinkedProducts, readLinkedStoreSchema, resolveLinkedReferences } from './linked-products-gateway'
import { synchronizeContent } from './content-sync.service'
import { discoverLinkedFamily } from './linked-discovery.service'
import { configureLinkedAutomation, runLinkedAutomation } from './linked-automation.service'
import { suggestSharedContent } from './linked-shared-content.service'
import { shopifyInformationPublicationIssue } from './linked-state-guard'
const gid = (id: number) => `gid://shopify/Product/${id}`
const scope = { accountId: 'A', market: 'GLOBAL' }
let fields: Map<string, any>, calls: { name: string; variables: any; account: string }[], loseAck: boolean, schemaChanged: boolean
const def = { id: 'gid://shopify/MetafieldDefinition/1', namespace: 'custom', key: 'siblings', name: 'Related colours', description: null, ownerType: 'PRODUCT', type: { name: 'list.product_reference' }, validations: [], access: { admin: null, storefront: 'PUBLIC_READ' } }
const connection = (nodes: any[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } })
const lookup = (ownerId: string, key = 'siblings') => fields.get(fieldAddress({ ownerId, namespace: 'custom', key }))
beforeEach(() => {
  invalidateShopifyDefinitionConstraints()
  fields = new Map(); calls = []; fixture.data.audits = []; loseAck = false; schemaChanged = false; fixture.data.failSave = false
  for (const id of [1, 2]) { const value = { ownerId: gid(id), namespace: 'custom', key: 'siblings', type: 'list.product_reference', value: JSON.stringify([gid(1), gid(2)]), compareDigest: `base-${id}` }; fields.set(fieldAddress(value), value) }
  fixture.data.listings = ['A', 'B'].map(account => ({ id: `listing-${account}`, productId: 'family', channel: 'SHOPIFY', channelConnectionId: account, marketplace: 'GLOBAL', aliasKey: '', version: 1, externalListingId: '1', platformAttributes: { untouched: account } }))
  fixture.data.gql = async (query: string, variables: any = {}, account = 'A'): Promise<any> => {
    parse(query); const name = query.match(/(?:query|mutation)\s+(\w+)/)![1]; calls.push({ name, variables, account })
    if (name === 'NexusLinkedDefinitions') return { metafieldDefinitions: connection(variables.ownerType === 'PRODUCT' ? [{ ...def, name: schemaChanged ? 'Changed definition' : def.name }] : []) }
    if (name === 'NexusLinkedEntryDefinitions') return { metaobjectDefinitions: connection([]) }
    if (name === 'NexusLinkedSettings') return { shopLocales: [{ locale: 'fr', primary: true, published: true }], metafieldDefinitionTypes: [{ name: 'list.product_reference', category: 'REFERENCE' }] }
    if (name === 'NexusLinkedProducts') return { nodes: variables.ids.map((id: string) => ({ id, title: `Product ${id.split('/').at(-1)}`, handle: `p-${id.split('/').at(-1)}` })) }
    if (name === 'NexusLinkedOwner') return { node: { id: variables.id, title: 'Product 1', metafields: connection([...fields.values()].filter(f => f.ownerId === variables.id)) } }
    if (name === 'NexusLinkedOwnerVariants') return { product: { variants: connection([]) } }
    if (name === 'NexusLinkedReferenceNames') return { nodes: variables.ids.map((id: string) => ({ id, title: `Product ${id.split('/').at(-1)}` })) }
    if (name === 'NexusLinkedFieldValues') {
      const result: any = {}
      for (let i = 0; variables[`id${i}`]; i++) result[`owner${i}`] = { id: variables[`id${i}`], metafield: structuredClone(fields.get(fieldAddress({ ownerId: variables[`id${i}`], namespace: variables[`ns${i}`], key: variables[`key${i}`] })) ?? null) }
      return result
    }
    if (name === 'NexusLinkedSet') {
      if (variables.metafields.some((f: any) => (fields.get(fieldAddress(f))?.compareDigest ?? null) !== f.compareDigest)) return { metafieldsSet: { userErrors: [{ message: 'Compare digest conflict' }] } }
      for (const f of variables.metafields) fields.set(fieldAddress(f), { ...f, compareDigest: `saved-${calls.length}` })
      if (loseAck) { loseAck = false; throw new Error('Connection dropped after mutation') }
      return { metafieldsSet: { metafields: [], userErrors: [] } }
    }
    if (name === 'NexusLinkedClear') { for (const f of variables.metafields) fields.delete(fieldAddress(f)); return { metafieldsDelete: { userErrors: [] } } }
    throw new Error(`Unmocked operation: ${name}`)
  }
})
const gql: any = (q: string, v: any) => fixture.data.gql(q, v)

function informationFixture() {
  const original = fixture.data.gql
  let title = 'Product 1', order = [1, 2, 3].map(n => `gid://shopify/MediaImage/${n}`), jobDone = false
  let mutations = 0, failAcknowledgement = false
  fixture.data.gql = async (query: string, variables: any = {}, account: string) => {
    if (!query.includes('NexusInformation')) return original(query, variables, account)
    parse(query)
    if (query.includes('NexusInformationNativeOwners')) return { nodes: variables.ids.map((id: string) => ({ id, title, descriptionHtml: '', tags: [], vendor: '', productType: '', seo: { title: null, description: null } })) }
    if (query.includes('NexusInformationContext')) return { shop: { currencyCode: 'EUR', ianaTimezone: 'Europe/Rome' } }
    if (query.includes('NexusInformationProductUpdate')) { mutations++; title = variables.product.title; if (failAcknowledgement) { failAcknowledgement = false; throw new Error('Lost native acknowledgement') }; return { productUpdate: { product: { id: gid(1) }, userErrors: [] } } }
    if (query.includes('NexusInformationProduct(')) return { product: { id: variables.id, title, handle: 'product', descriptionHtml: '', tags: [], vendor: '', productType: '', seo: { title: null, description: null } } }
    if (query.includes('NexusInformationVariants')) return { product: { variants: connection([]) } }
    if (query.includes('NexusInformationMedia(')) return { product: { media: connection(order.map(id => ({ id, alt: '', mediaContentType: 'IMAGE', status: 'READY' }))) } }
    if (query.includes('NexusInformationReorder')) {
      const checkpoint = fixture.data.listings[0].platformAttributes._nexusLinkedProductsOperation.mediaJobs[gid(1)]
      expect(checkpoint).toEqual({ submitted: true })
      mutations++
      if (failAcknowledgement) { failAcknowledgement = false; throw new Error('Lost media acknowledgement') }
      return { productReorderMedia: { job: { id: 'job-1' }, mediaUserErrors: [] } }
    }
    if (query.includes('NexusInformationMediaJob')) return { job: { id: variables.id, done: jobDone } }
    throw new Error('Unexpected Information query')
  }
  return { mutations: () => mutations, loseAcknowledgement: () => { failAcknowledgement = true }, title: (v: string) => { title = v }, finish: (ids: string[]) => { jobDone = true; order = ids } }
}

describe('Information uses the existing durable save and synchronization pipeline', () => {
  async function start(kind: 'native' | 'media') {
    const saved = await initialized()
    if (kind === 'native') saved.draft.nativeEdits = [{ productId: gid(1), ownerId: gid(1), ownerLabel: 'Product 1', field: 'title', value: 'Product 1', nextValue: 'Updated title' }]
    else saved.draft.mediaEdits = [{ productId: gid(1), ownerLabel: 'Product 1', value: [1, 2, 3].map(n => `gid://shopify/MediaImage/${n}`), nextValue: [3, 1, 2].map(n => `gid://shopify/MediaImage/${n}`) }]
    await saveLinkedWorkspace('family', scope, { draft: saved.draft, expectedRevision: saved.revision })
    const { workspace, plan } = await previewLinkedWorkspace('family', scope)
    return beginLinkedSync('family', scope, { expectedRevision: workspace.revision, planRevision: plan.revision }, 'MANUAL', 'actor-qa')
  }
  it('persists a native change, verifies remote readback, and clears only its saved draft', async () => {
    const remote = informationFixture(), running = await start('native')
    const done = await advanceLinkedSync('family', scope, running.operation!.id)
    expect(done.operation).toMatchObject({ status: 'VERIFIED', completed: 1, total: 1 })
    expect(done.draft.nativeEdits).toEqual([])
    expect(fixture.data.listings[0].platformAttributes.untouched).toBe('A')
    expect(fixture.data.listings[1].platformAttributes.untouched).toBe('B')
    expect(remote.mutations()).toBe(1)
    expect(fixture.data.audits.map(a => a.action)).toContain('shopify.sync.verified')
    expect(fixture.data.audits.find(a => a.action === 'shopify.sync.started')).toMatchObject({ userId: 'actor-qa', metadata: { accountId: 'A', operationId: running.operation!.id } })
    expect(fixture.data.audits.find(a => a.action === 'shopify.sync.started').after.nativeEdits).toHaveLength(1)
  })
  it('retains a failed native draft and reconciles a lost acknowledgement without duplicate writes', async () => {
    const remote = informationFixture(), running = await start('native'); remote.loseAcknowledgement()
    await expect(advanceLinkedSync('family', scope, running.operation!.id)).rejects.toThrow('Lost native')
    expect((await getLinkedWorkspace('family', scope)).draft.nativeEdits).toHaveLength(1)
    const done = await advanceLinkedSync('family', scope, running.operation!.id)
    expect(done.operation?.status).toBe('VERIFIED'); expect(remote.mutations()).toBe(1)
  })
  it('retains gallery job checkpoints while pending and requires completion plus final order', async () => {
    const remote = informationFixture(), running = await start('media')
    const pending = await advanceLinkedSync('family', scope, running.operation!.id)
    expect(pending.operation).toMatchObject({ status: 'RUNNING', completed: 0, total: 1 })
    expect(fixture.data.listings[0].platformAttributes._nexusLinkedProductsOperation.mediaJobs[gid(1)]).toEqual({ submitted: true, jobId: 'job-1' })
    await advanceLinkedSync('family', scope, running.operation!.id)
    expect(remote.mutations()).toBe(1)
    remote.finish([3, 1, 2].map(n => `gid://shopify/MediaImage/${n}`))
    const done = await advanceLinkedSync('family', scope, running.operation!.id)
    expect(done.operation?.status).toBe('VERIFIED'); expect(done.draft.mediaEdits).toEqual([])
  })
  it('preserves the uncertain gallery submission and refuses a blind retry', async () => {
    const remote = informationFixture(), running = await start('media'); remote.loseAcknowledgement()
    await expect(advanceLinkedSync('family', scope, running.operation!.id)).rejects.toThrow('Lost media')
    await expect(advanceLinkedSync('family', scope, running.operation!.id)).rejects.toThrow('uncertain')
    expect((await getLinkedWorkspace('family', scope)).draft.mediaEdits).toHaveLength(1)
    expect(remote.mutations()).toBe(1)
  })
  it('does not turn Information-only drafts into separate-product families', () => {
    const draft = { ...emptyShopifyLinkedDraft(), informationOnly: true }
    expect(shopifyInformationPublicationIssue({ [LINKED_KEY]: draft })).toBeNull()
    expect(shopifyInformationPublicationIssue({ [LINKED_KEY]: { ...draft, nativeEdits: [{}] } })).toMatch(/pending/)
    expect(shopifyInformationPublicationIssue({ [LINKED_KEY]: emptyShopifyLinkedDraft() })).toMatch(/separate/)
  })
})
async function initialized() {
  const draft = await importLinkedFamily(gql, gid(1), { namespace: 'custom', key: 'siblings', includeSelf: false })
  const current = await getLinkedWorkspace('family', scope)
  return saveLinkedWorkspace('family', scope, { expectedRevision: current.revision, draft })
}

function contentFields() {
  const original = fixture.data.gql
  fixture.data.gql = async (query: string, variables: any, account: string) => {
    const result = await original(query, variables, account)
    if (query.includes('query NexusLinkedDefinitions') && variables.ownerType === 'PRODUCT') result.metafieldDefinitions.nodes.push({ ...def, id: 'gid://shopify/MetafieldDefinition/2', key: 'caption', name: 'Shared caption', type: { name: 'single_line_text_field' } })
    if (query.includes('query NexusLinkedSettings')) result.metafieldDefinitionTypes.push({ name: 'single_line_text_field', category: 'TEXT' })
    return result
  }
  for (const id of [1, 2]) {
    const field = { ownerId: gid(id), namespace: 'custom', key: 'caption', type: 'single_line_text_field', value: id === 1 ? 'Source content' : 'Previous content', compareDigest: `caption-${id}` }
    fields.set(fieldAddress(field), field)
  }
}
async function sharedWorkspace() {
  contentFields()
  const workspace = await initialized()
  workspace.draft.sharedFields = [{ namespace: 'custom', key: 'caption', sourceProductId: gid(1), excludedProductIds: [], baseline: structuredClone([lookup(gid(1), 'caption'), lookup(gid(2), 'caption')]) }]
  return saveLinkedWorkspace('family', scope, { draft: workspace.draft, expectedRevision: workspace.revision })
}
async function automaticWorkspace() {
  await sharedWorkspace()
  const { workspace, plan } = await previewLinkedWorkspace('family', scope)
  return configureLinkedAutomation('family', scope, { mode: 'AUTOMATIC', expectedRevision: workspace.revision, planRevision: plan.revision })
}
describe('family discovery without title or colour assumptions', () => {
  it('refuses mismatched product identities instead of importing a different family', async () => {
    await expect(readLinkedProducts(async () => ({ nodes: [{ id: gid(99) }] }) as any, [gid(1)])).rejects.toThrow('unavailable')
  })
  it('refuses incomplete reference responses instead of reporting them as available', async () => {
    await expect(resolveLinkedReferences(async () => ({ nodes: [] }) as any, [gid(1)])).rejects.toThrow('incomplete')
  })
  it('discovers the single reciprocal reference list from linked Nexus IDs without writes', async () => {
    const result = await discoverLinkedFamily(gql, [gid(1)], null)
    expect(result.draft?.members.map(m => m.id)).toEqual([gid(1), gid(2)])
    expect(result.draft?.relationship?.key).toBe('siblings')
    expect(calls.some(c => c.name === 'NexusLinkedSet')).toBe(false)
  })
  it('does not infer a family from one-way recommendations', async () => {
    lookup(gid(2)).value = '[]'
    expect((await discoverLinkedFamily(gql, [gid(1)], null)).draft).toBeNull()
  })
  it('requires an explicit field when two reciprocal lists are possible', async () => {
    const original = fixture.data.gql
    fixture.data.gql = async (query: string, variables: any, account: string) => {
      const result = await original(query, variables, account)
      if (query.includes('query NexusLinkedDefinitions') && variables.ownerType === 'PRODUCT') result.metafieldDefinitions.nodes.push({ ...def, id: 'gid://shopify/MetafieldDefinition/3', key: 'other', name: 'Other list' })
      return result
    }
    for (const id of [1, 2]) { const f = { ...lookup(gid(id)), key: 'other' }; fields.set(fieldAddress(f), f) }
    const ambiguous = await discoverLinkedFamily(gql, [gid(1)], null)
    expect(ambiguous.draft).toBeNull(); expect(ambiguous.candidates).toHaveLength(2)
    expect((await discoverLinkedFamily(gql, [gid(1)], { namespace: 'custom', key: 'other', includeSelf: true })).draft?.relationship?.key).toBe('other')
  })
  it('does not discard other linked Nexus listing identities', async () => {
    expect((await discoverLinkedFamily(gql, [gid(1), gid(3)], null)).draft).toBeNull()
  })
})
describe('persistent shared content and server automation', () => {
  it('proposes matching content in bulk and retains differing or empty products as overrides', async () => {
    contentFields()
    const workspace = await initialized(), template = workspace.draft.members[0]
    workspace.draft.members.push({ ...template, id: gid(3) }, { ...template, id: gid(4) })
    const shared = { ...lookup(gid(1), 'caption'), ownerId: gid(3) }; fields.set(fieldAddress(shared), shared)
    const suggestions = await suggestSharedContent(gql, workspace.draft, await readLinkedStoreSchema(gql))
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].rule.sourceProductId).toBe(gid(1))
    expect(suggestions[0].rule.excludedProductIds).toEqual([gid(2), gid(4)])
    expect(calls.some(c => c.name === 'NexusLinkedSet')).toBe(false)
  })
  it('does not choose a shared source when equally common values disagree', async () => {
    contentFields()
    const workspace = await initialized(), template = workspace.draft.members[0]
    for (const id of [3, 4]) { workspace.draft.members.push({ ...template, id: gid(id) }); const f = { ...lookup(gid(id - 2), 'caption'), ownerId: gid(id) }; fields.set(fieldAddress(f), f) }
    expect(await suggestSharedContent(gql, workspace.draft, await readLinkedStoreSchema(gql))).toEqual([])
  })
  it('keeps pending individual edits out of bulk sharing suggestions', async () => {
    contentFields(); lookup(gid(2), 'caption').value = 'Source content'
    const workspace = await initialized()
    workspace.draft.edits.push({ ...lookup(gid(2), 'caption'), nextValue: 'Pending individual', ownerLabel: 'Product 2' })
    expect(await suggestSharedContent(gql, workspace.draft, await readLinkedStoreSchema(gql))).toEqual([])
  })
  it('propagates a source update on later checks without another manual copy, and is idempotent', async () => {
    await automaticWorkspace()
    const first = await runLinkedAutomation('family', scope)
    expect(first.automation?.status).toBe('VERIFIED')
    expect(lookup(gid(2), 'caption').value).toBe('Source content')
    const source = lookup(gid(1), 'caption'); source.value = 'Updated source'; source.compareDigest = 'updated-source'
    await runLinkedAutomation('family', scope)
    expect(lookup(gid(2), 'caption').value).toBe('Updated source')
    const writes = calls.filter(c => c.name === 'NexusLinkedSet').length
    await runLinkedAutomation('family', scope)
    expect(calls.filter(c => c.name === 'NexusLinkedSet')).toHaveLength(writes)
    expect(fixture.data.listings.find(l => l.channelConnectionId === 'B').platformAttributes).toEqual({ untouched: 'B' })
  })
  it('flags a separately edited follower and preserves its value', async () => {
    await automaticWorkspace(); await runLinkedAutomation('family', scope)
    const target = lookup(gid(2), 'caption'); target.value = 'Merchant override'; target.compareDigest = 'merchant-digest'
    const writes = calls.filter(c => c.name === 'NexusLinkedSet').length
    const result = await runLinkedAutomation('family', scope)
    expect(result.automation?.status).toBe('NEEDS_REVIEW')
    expect(result.automation?.message).toContain('product override')
    expect(target.value).toBe('Merchant override')
    expect(calls.filter(c => c.name === 'NexusLinkedSet')).toHaveLength(writes)
  })
  it('keeps excluded products independent and permits their individual edits', async () => {
    const workspace = await sharedWorkspace()
    workspace.draft.sharedFields![0].excludedProductIds = [gid(2)]
    workspace.draft.edits.push({ ...lookup(gid(2), 'caption'), nextValue: 'Individual', ownerLabel: 'Product 2' })
    expect(shopifyLinkedDraftSchema.safeParse(workspace.draft).success).toBe(true)
    const plan = await buildLinkedPlan(gql, workspace.draft)
    expect(plan.changes.map(c => c.nextValue)).toEqual(['Individual'])
  })
  it('refuses a direct edit of inherited content until the product becomes an override', async () => {
    const workspace = await sharedWorkspace()
    workspace.draft.edits.push({ ...lookup(gid(2), 'caption'), nextValue: 'Individual', ownerLabel: 'Product 2' })
    expect(shopifyLinkedDraftSchema.safeParse(workspace.draft).success).toBe(false)
  })
  it('monitor mode finds changes without making Shopify writes', async () => {
    const workspace = await sharedWorkspace()
    await configureLinkedAutomation('family', scope, { mode: 'MONITOR', expectedRevision: workspace.revision })
    const result = await runLinkedAutomation('family', scope)
    expect(result.automation?.status).toBe('NEEDS_REVIEW'); expect(result.automation?.changes).toBe(1)
    expect(calls.some(c => c.name === 'NexusLinkedSet')).toBe(false)
  })
  it('pauses automation whenever an editor saves a different draft', async () => {
    const workspace = await automaticWorkspace()
    workspace.draft.members.reverse()
    const saved = await saveLinkedWorkspace('family', scope, { draft: workspace.draft, expectedRevision: workspace.revision })
    expect(saved.automation?.mode).toBe('PAUSED')
    await runLinkedAutomation('family', scope)
    expect(calls.some(c => c.name === 'NexusLinkedSet')).toBe(false)
  })
  it('requires review of exactly the current source values before enabling automation', async () => {
    await sharedWorkspace()
    const { workspace, plan } = await previewLinkedWorkspace('family', scope)
    lookup(gid(1), 'caption').value = 'Changed after review'
    await expect(configureLinkedAutomation('family', scope, { mode: 'AUTOMATIC', expectedRevision: workspace.revision, planRevision: plan.revision })).rejects.toThrow('changed')
  })
  it('does not propagate deletion of source content', async () => {
    await automaticWorkspace(); await runLinkedAutomation('family', scope)
    fields.delete(fieldAddress({ ownerId: gid(1), namespace: 'custom', key: 'caption' }))
    const result = await runLinkedAutomation('family', scope)
    expect(result.automation?.status).toBe('NEEDS_REVIEW')
    expect(lookup(gid(2), 'caption').value).toBe('Source content')
  })
  it('recovers a lost acknowledgement on the next scheduled check without duplicate writes', async () => {
    await automaticWorkspace(); loseAck = true
    const interrupted = await runLinkedAutomation('family', scope)
    expect(interrupted.operation?.status).toBe('UNVERIFIED')
    const writes = calls.filter(c => c.name === 'NexusLinkedSet').length
    const recovered = await runLinkedAutomation('family', scope)
    expect(recovered.operation?.status).toBe('VERIFIED')
    expect(calls.filter(c => c.name === 'NexusLinkedSet')).toHaveLength(writes)
  })
  it('stops later automatic batches when paused', async () => {
    await automaticWorkspace(); loseAck = true
    const interrupted = await runLinkedAutomation('family', scope)
    await configureLinkedAutomation('family', scope, { mode: 'PAUSED', expectedRevision: interrupted.revision })
    await expect(advanceLinkedSync('family', scope, interrupted.operation!.id, true)).rejects.toThrow('paused')
  })
  it('refuses a changed shared source after review and before the first write', async () => {
    await sharedWorkspace()
    const { workspace, plan } = await previewLinkedWorkspace('family', scope)
    const started = await beginLinkedSync('family', scope, { expectedRevision: workspace.revision, planRevision: plan.revision })
    lookup(gid(1), 'caption').value = 'Changed during operation'; lookup(gid(1), 'caption').compareDigest = 'changed-source'
    await expect(advanceLinkedSync('family', scope, started.operation!.id)).rejects.toThrow('Shared source content changed')
    expect(calls.some(c => c.name === 'NexusLinkedSet')).toBe(false)
  })
})
describe('complete store discovery and source reads', () => {
  it('imports exact product order, detects self-inclusion and reads each owner’s baseline', async () => {
    const data = await initialized()
    expect(data.draft.relationship?.includeSelf).toBe(true)
    expect(data.draft.members.map(m => m.id)).toEqual([gid(1), gid(2)])
    expect(data.draft.baselineLinks.map(f => f.compareDigest)).toEqual(['base-1', 'base-2'])
    expect((await readLinkedStoreSchema(gql)).locales[0].locale).toBe('fr')
    expect(calls.some(c => c.name === 'NexusLinkedSet')).toBe(false)
  })
  it('paginates to completion and refuses repeated or missing cursors', async () => {
    expect(await collectShopifyPages(async after => ({ nodes: [after ? 2 : 1], pageInfo: { hasNextPage: !after, endCursor: after ? null : 'next' } }))).toEqual([1, 2])
    await expect(collectShopifyPages(async () => ({ nodes: [1], pageInfo: { hasNextPage: true, endCursor: 'same' } }))).rejects.toThrow('pagination changed')
    await expect(collectShopifyPages(async () => ({ nodes: [1, 2], pageInfo: { hasNextPage: false, endCursor: null } }), 1)).rejects.toThrow('No partial')
  })
  it('batches exact field reads instead of reading each product’s full variant matrix', async () => {
    const addresses = Array.from({ length: 61 }, (_, i) => ({ ownerId: gid(i + 1), namespace: 'custom', key: 'siblings' }))
    expect(await readLinkedFields(gql, addresses)).toHaveLength(61)
    expect(calls.filter(c => c.name === 'NexusLinkedFieldValues')).toHaveLength(3)
    expect(calls.some(c => c.name === 'NexusLinkedOwnerVariants')).toBe(false)
  })
})
describe('local drafts and account isolation', () => {
  it('prevents a native-variant publication from consolidating a linked family', async () => {
    await initialized(); calls = []
    await expect(synchronizeContent('family', scope, {})).rejects.toThrow('separate Shopify products')
    expect(calls).toHaveLength(0)
  })
  it('refuses enabling a linked family while native publication is running', async () => {
    fixture.data.listings[0].platformAttributes._nexusContentPublish = { status: 'PUBLISHING' }
    const current = await getLinkedWorkspace('family', scope)
    await expect(saveLinkedWorkspace('family', scope, { expectedRevision: current.revision, draft: emptyShopifyLinkedDraft() })).rejects.toThrow('native Shopify publication is running')
  })
  it('writes only the selected store and preserves unrelated attributes', async () => {
    const initial = await initialized()
    expect(fixture.data.listings[0].platformAttributes.untouched).toBe('A')
    expect(fixture.data.listings[1].platformAttributes).toEqual({ untouched: 'B' })
    expect((await getLinkedWorkspace('family', { ...scope, accountId: 'B' })).draft).toEqual(emptyShopifyLinkedDraft())
    const changed = structuredClone(initial.draft); changed.members.reverse()
    await saveLinkedWorkspace('family', scope, { expectedRevision: initial.revision, draft: changed })
    await expect(saveLinkedWorkspace('family', scope, { expectedRevision: initial.revision, draft: initial.draft })).rejects.toThrow('changed')
  })
  it('rejects a listing attributed to another store before a remote query', async () => {
    await expect(getLinkedWorkspace('family', { ...scope, listingId: 'listing-B' })).rejects.toThrow('does not belong')
    expect(calls).toHaveLength(0)
  })
  it('rolls back a failed persistence operation', async () => {
    const current = await getLinkedWorkspace('family', scope), before = structuredClone(fixture.data.listings)
    fixture.data.failSave = true
    await expect(saveLinkedWorkspace('family', scope, { expectedRevision: current.revision, draft: emptyShopifyLinkedDraft() })).rejects.toThrow('database write failed')
    expect(fixture.data.listings).toEqual(before)
  })
})
describe('review, conflicts and resumable synchronization', () => {
  it('refuses an edit after its definition is deleted even when Shopify retains the stored value', async () => {
    contentFields()
    const { draft } = await initialized()
    const stored = fields.get(fieldAddress({ ownerId: gid(1), namespace: 'custom', key: 'caption' }))
    draft.edits = [{ ...stored, nextValue: 'Pending caption', ownerLabel: 'Product 1' }]
    const original = fixture.data.gql
    fixture.data.gql = async (query: string, variables: any, account: string) => {
      const result = await original(query, variables, account)
      if (query.includes('query NexusLinkedDefinitions')) result.metafieldDefinitions.nodes = result.metafieldDefinitions.nodes.filter((d: any) => d.key !== 'caption')
      return result
    }
    await expect(buildLinkedPlan(gql, draft)).rejects.toThrow('definition changed or is missing')
    expect(fields.get(fieldAddress(stored)).value).toBe('Source content')
    expect(calls.some(c => c.name === 'NexusLinkedSet')).toBe(false)
  })
  async function ready() {
    const data = await initialized(); data.draft.members.reverse()
    await saveLinkedWorkspace('family', scope, { expectedRevision: data.revision, draft: data.draft })
    const review = await previewLinkedWorkspace('family', scope)
    return beginLinkedSync('family', scope, { expectedRevision: review.workspace.revision, planRevision: review.plan.revision })
  }
  it('updates all siblings and records verified baselines for the next edit', async () => {
    const running = await ready()
    const done = await advanceLinkedSync('family', scope, running.operation!.id)
    expect(done.operation).toMatchObject({ status: 'VERIFIED', completed: 2, total: 2 })
    expect(done.draft.baselineLinks).toHaveLength(2)
    expect(done.draft.baselineLinks.every(f => f.compareDigest?.startsWith('saved-'))).toBe(true)
    expect(JSON.parse(lookup(gid(1)).value)).toEqual([gid(2), gid(1)])
    expect(calls.filter(c => c.name === 'NexusLinkedSet')).toHaveLength(1)
    expect(calls.some(c => /ProductSet|ProductCreate|Inventory/.test(c.name))).toBe(false)
  })
  it('reconciles a successful write after a lost acknowledgement without repeating it', async () => {
    const running = await ready(); loseAck = true
    await expect(advanceLinkedSync('family', scope, running.operation!.id)).rejects.toThrow('Connection dropped')
    expect((await getLinkedWorkspace('family', scope)).operation?.status).toBe('UNVERIFIED')
    const done = await advanceLinkedSync('family', scope, running.operation!.id)
    expect(done.operation?.status).toBe('VERIFIED')
    expect(calls.filter(c => c.name === 'NexusLinkedSet')).toHaveLength(1)
  })
  it('detects a Shopify edit between review and apply and requires explicit reconciliation', async () => {
    const running = await ready(); lookup(gid(1)).compareDigest = 'external'; lookup(gid(1)).value = '[]'
    await expect(advanceLinkedSync('family', scope, running.operation!.id)).rejects.toThrow('Shopify changed')
    expect(calls.filter(c => c.name === 'NexusLinkedSet')).toHaveLength(0)
    const current = await getLinkedWorkspace('family', scope)
    await expect(saveLinkedWorkspace('family', scope, { expectedRevision: current.revision, draft: current.draft })).rejects.toThrow('pending synchronization')
    const rebased = await rebaseLinkedWorkspace('family', scope, current.revision)
    expect(rebased.operation).toBeNull(); expect(rebased.draft.baselineLinks.find(f => f.ownerId === gid(1))?.value).toBe('[]')
  })
  it('refuses definitions changed after review', async () => {
    const running = await ready(); schemaChanged = true
    await expect(advanceLinkedSync('family', scope, running.operation!.id)).rejects.toThrow('definitions changed')
    expect(calls.filter(c => c.name === 'NexusLinkedSet')).toHaveLength(0)
  })
  it('checks every sibling even when its imported relationship needed no change', async () => {
    const { draft } = await initialized()
    lookup(gid(2)).value = '[]'; lookup(gid(2)).compareDigest = 'external-edit'
    await expect(buildLinkedPlan(gql, draft)).rejects.toThrow('family relationship changed')
    expect(calls.some(c => c.name === 'NexusLinkedSet')).toBe(false)
  })
  it('refuses moving a product out of another family without reviewing those existing members', async () => {
    const { draft } = await initialized()
    lookup(gid(2)).value = JSON.stringify([gid(2), gid(3)])
    draft.baselineLinks[1].value = lookup(gid(2)).value
    await expect(buildLinkedPlan(gql, draft)).rejects.toThrow('outside this reviewed family')
    expect(calls.some(c => c.name === 'NexusLinkedSet')).toBe(false)
  })
  it('persists progress across multiple atomic batches and verifies earlier rows again', async () => {
    const current = await getLinkedWorkspace('family', scope), draft = emptyShopifyLinkedDraft()
    draft.relationship = { namespace: 'custom', key: 'siblings', includeSelf: false }
    draft.members = Array.from({ length: 27 }, (_, i) => ({ id: gid(i + 1), title: `Product ${i + 1}`, handle: `p-${i}`, image: null }))
    draft.baselineLinks = draft.members.map(m => ({ ownerId: m.id, namespace: 'custom', key: 'siblings', type: 'list.product_reference', value: null, compareDigest: null }))
    fields.clear()
    await saveLinkedWorkspace('family', scope, { expectedRevision: current.revision, draft })
    const review = await previewLinkedWorkspace('family', scope)
    const running = await beginLinkedSync('family', scope, { expectedRevision: review.workspace.revision, planRevision: review.plan.revision })
    const first = await advanceLinkedSync('family', scope, running.operation!.id)
    expect(first.operation).toMatchObject({ status: 'RUNNING', completed: 25, total: 27 })
    lookup(gid(1)).value = '[]'; lookup(gid(1)).compareDigest = 'changed-after-first-batch'
    await expect(advanceLinkedSync('family', scope, running.operation!.id)).rejects.toThrow('before final verification')
    expect((await getLinkedWorkspace('family', scope)).operation?.status).toBe('UNVERIFIED')
    expect(calls.filter(c => c.name === 'NexusLinkedSet').map(c => c.variables.metafields.length)).toEqual([25, 2])
  })
  it('does not permit an unrelated product field edit', async () => {
    const { draft } = await initialized()
    const outside: ShopifyLinkedDraft = { ...draft, relationship: null, baselineLinks: [], edits: [{ ownerId: gid(3), namespace: 'custom', key: 'siblings', type: 'list.product_reference', value: null, compareDigest: null, nextValue: '[]', ownerLabel: 'Foreign product' }] }
    await expect(buildLinkedPlan(gql, outside)).rejects.toThrow('outside this reviewed family')
  })
  it('keeps variant definitions separate and verifies the variant belongs to a family product', async () => {
    const { draft } = await initialized(), original = fixture.data.gql
    let variantProduct = gid(2)
    const variantId = 'gid://shopify/ProductVariant/102'
    fixture.data.gql = async (query: string, variables: any, account: string) => {
      if (query.includes('NexusLinkedDefinitions') && variables.ownerType === 'PRODUCTVARIANT') return { metafieldDefinitions: connection([{ ...def, ownerType: 'PRODUCTVARIANT', key: 'size_note', type: { name: 'single_line_text_field' } }]) }
      if (query.includes('NexusLinkedSettings')) return { shopLocales: [], metafieldDefinitionTypes: [{ name: 'list.product_reference', category: 'REFERENCE' }, { name: 'single_line_text_field', category: 'TEXT' }] }
      if (query.includes('NexusLinkedOwner(') && variables.id === variantId) return { node: { id: variantId, title: 'Small', product: { id: variantProduct }, metafields: connection([]) } }
      return original(query, variables, account)
    }
    draft.edits.push({ ownerId: variantId, namespace: 'custom', key: 'size_note', type: 'single_line_text_field', value: null, compareDigest: null, nextValue: 'Size-specific fit', ownerLabel: 'Blue / Small' })
    expect((await buildLinkedPlan(gql, draft)).changes).toMatchObject([{ ownerId: variantId, type: 'single_line_text_field' }])
    variantProduct = gid(3)
    await expect(buildLinkedPlan(gql, draft)).rejects.toThrow('outside this reviewed family')
  })
  it('refuses concurrent metafield changes without partial batch writes', async () => {
    const changes = [1, 2].map(id => ({ ...lookup(gid(id)), nextValue: '[]', ownerLabel: `Product ${id}` }))
    lookup(gid(2)).compareDigest = 'new'
    await expect(applyLinkedBatch(gql, changes)).rejects.toThrow('Shopify changed')
    expect(lookup(gid(1)).value).not.toBe('[]')
  })
})

describe('Conditional Shopify definitions', () => {
  it('paginates category subtypes before advertising a complete definition', async () => {
    const original = fixture.data.gql
    fixture.data.gql = async (query: string, variables: any) => {
      const result = query.includes('NexusLinkedDefinitionConstraints') ? { node: { constraints: { values: connection([{ value: 'aa-8-1' }]) } } } : await original(query, variables)
      if (query.includes('NexusLinkedDefinitions') && variables.ownerType === 'PRODUCT') result.metafieldDefinitions.nodes[0].constraints = { key: 'category', values: { nodes: [{ value: 'aa-8' }], pageInfo: { hasNextPage: true, endCursor: 'category-page-2' } } }
      return result
    }
    expect((await readLinkedStoreSchema(gql)).definitions[0].constraints).toEqual({ key: 'category', values: ['aa-8', 'aa-8-1'] })
  })
  it('rejects an inapplicable category before accepting any Shopify write plan', async () => {
    const original = fixture.data.gql
    fixture.data.gql = async (query: string, variables: any) => {
      if (query.includes('NexusInformationNativeOwners')) return { nodes: variables.ids.map((id: string) => ({ id, category: { id: 'gid://shopify/TaxonomyCategory/aa-8-10' } })) }
      if (query.includes('NexusApplicableDefinitions')) return { metafieldDefinitions: connection([]) }
      const result = await original(query, variables)
      if (query.includes('NexusLinkedDefinitions') && variables.ownerType === 'PRODUCT') result.metafieldDefinitions.nodes[0].constraints = { key: 'category', values: connection([{ value: 'aa-8-1' }]) }
      return result
    }
    const draft = { ...emptyShopifyLinkedDraft(), informationOnly: true, members: [{ id: gid(1), title: 'One', handle: 'one', image: null }], edits: [{ ...lookup(gid(1)), nextValue: '[]', ownerLabel: 'One' }] }
    await expect(buildLinkedPlan(gql, draft)).rejects.toThrow('does not apply')
    expect(calls.some(c => ['NexusLinkedSet','NexusLinkedClear'].includes(c.name))).toBe(false)
  })
  it('caches complete subtype pages per store and invalidates them explicitly', async () => {
    const original = fixture.data.gql
    let store = 'A', pages = 0
    fixture.data.gql = async (query: string, variables: any) => {
      if (query.includes('NexusLinkedDefinitionConstraints')) { pages++; return { node: { constraints: { values: connection([{ value: store === 'A' ? 'aa-8-1' : 'aa-8-2' }]) } } } }
      const result = await original(query, variables)
      if (query.includes('NexusLinkedSettings')) result.shop = { id: store }
      if (query.includes('NexusLinkedDefinitions') && variables.ownerType === 'PRODUCT') result.metafieldDefinitions.nodes[0].constraints = { key: 'category', values: { nodes: [{ value: 'aa-8' }], pageInfo: { hasNextPage: true, endCursor: 'next' } } }
      return result
    }
    await readLinkedStoreSchema(gql); await readLinkedStoreSchema(gql)
    expect(pages).toBe(1)
    store = 'B'
    expect((await readLinkedStoreSchema(gql)).definitions[0].constraints?.values).toEqual(['aa-8', 'aa-8-2'])
    expect(pages).toBe(2)
    invalidateShopifyDefinitionConstraints(); await readLinkedStoreSchema(gql)
    expect(pages).toBe(3)
  })
  it('checks fresh applicability before mutation even when cached subtypes permit the category', async () => {
    const original = fixture.data.gql
    let allowed = false, checks = 0
    fixture.data.gql = async (query: string, variables: any) => {
      if (query.includes('NexusInformationNativeOwners')) return { nodes: variables.ids.map((id: string) => ({ id, category: { id: 'gid://shopify/TaxonomyCategory/aa-8' } })) }
      if (query.includes('NexusApplicableDefinitions')) { checks++; expect(variables.category).toBe('gid://shopify/TaxonomyCategory/aa-8'); return { metafieldDefinitions: connection(allowed ? [{ id: def.id }] : []) } }
      return original(query, variables)
    }
    const schema = await readLinkedStoreSchema(gql)
    schema.definitions[0].constraints = { key: 'category', values: ['aa-8'] }
    const changes = [1, 2].map(id => ({ ...lookup(gid(id)), nextValue: '[]', ownerLabel: String(id) }))
    await expect(applyLinkedBatch(gql, changes, schema)).rejects.toThrow('does not apply')
    expect(calls.some(c => c.name === 'NexusLinkedSet')).toBe(false)
    allowed = true; await applyLinkedBatch(gql, changes, schema)
    expect(checks).toBe(2) // Once per category for each attempt, never once per cell.
    expect(lookup(gid(1)).value).toBe('[]')
    expect(lookup(gid(2)).value).toBe('[]')
  })
})
