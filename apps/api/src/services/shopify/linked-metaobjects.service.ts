import { z } from 'zod'
import { validateShopifyField, shopifyReferenceError, type ShopifyReusableEntry } from '@nexus/shared/shopify-linked-products'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'
import { assertShopifyResult, type ShopifyGraphql } from './admin-client.js'
import { linkedDigest, readLinkedMetaobject, readLinkedStoreSchema, resolveLinkedReferences } from './linked-products-gateway.js'

export async function getLinkedEntry(gql: ShopifyGraphql, id: string): Promise<ShopifyReusableEntry> {
  const [entry, schema] = await Promise.all([readLinkedMetaobject(gql, id), readLinkedStoreSchema(gql)])
  const definition = schema.metaobjectDefinitions.find(d => d.id === entry.definition.id)
  if (!definition) throw new WorkspaceScopeError('This reusable entry definition is no longer available to this store connection.', 422)
  return { id: entry.id, type: entry.type, name: entry.displayName, handle: entry.handle, fields: entry.fields, definition, status: entry.capabilities?.publishable?.status ?? null,
    revision: linkedDigest([entry.id, entry.updatedAt, entry.fields, definition, entry.capabilities]), usedBy: entry.referencedBy.nodes.map((r: any) => ({ id: r.referencer?.id ?? 'unknown', label: r.referencer?.product ? `${r.referencer.product.title} / ${r.referencer.title}` : r.referencer?.title ?? r.referencer?.displayName ?? 'Other Shopify resource' })), moreUses: entry.referencedBy.pageInfo.hasNextPage }
}

const inputSchema = z.object({ id: z.string().regex(/^gid:\/\/shopify\/Metaobject\/\d+$/).optional(), expectedRevision: z.string().optional(),
  type: z.string().min(1), handle: z.string().regex(/^[a-z0-9][a-z0-9-]{0,254}$/), fields: z.array(z.object({ key: z.string().min(1), value: z.string() }).strict()).max(250),
  status: z.enum(['ACTIVE', 'DRAFT']).optional(),
}).strict()
export async function saveLinkedEntry(gql: ShopifyGraphql, body: unknown) {
  const parsed = inputSchema.safeParse(body)
  if (!parsed.success) throw new WorkspaceScopeError('Choose an entry type, handle and valid fields.', 400)
  const input = parsed.data, schema = await readLinkedStoreSchema(gql)
  const definition = schema.metaobjectDefinitions.find(d => d.type === input.type)
  if (!definition || definition.fields.some(f => f.readOnlyReason)) throw new WorkspaceScopeError('This reusable entry type is unavailable or read-only.', 422)
  if (input.status && !definition.publishable) throw new WorkspaceScopeError('This entry type does not support a publication status.', 422)
  if (new Set(input.fields.map(f => f.key)).size !== input.fields.length) throw new WorkspaceScopeError('Each entry field must appear once.', 400)
  let existing = input.id ? await getLinkedEntry(gql, input.id) : null
  if (existing && (existing.type !== input.type || existing.handle !== input.handle)) throw new WorkspaceScopeError('The entry identity changed. Reload before saving.')
  if (!input.id) {
    const result = await gql(`query NexusLinkedEntryByHandle($handle:MetaobjectHandleInput!) { metaobjectByHandle(handle:$handle) { id } }`, { handle: { type: input.type, handle: input.handle } })
    if (result.metaobjectByHandle) existing = await getLinkedEntry(gql, result.metaobjectByHandle.id)
  }
  for (const field of input.fields) {
    const def = definition.fields.find(d => d.key === field.key)
    if (!def) throw new WorkspaceScopeError(`The entry field ${field.key} is no longer defined.`, 422)
    // Shopify represents a cleared optional metaobject field with an empty input
    // string. Required fields still reject it and readback accepts only emptiness.
    const error = validateShopifyField(def, field.value === '' ? null : field.value)
    if (error) throw new WorkspaceScopeError(`${def.name}: ${error}`, 422)
    if (def.type.includes('_reference') && field.value) {
      const ids = def.type.startsWith('list.') ? JSON.parse(field.value) : [field.value]
      for (let i = 0; i < ids.length; i += 100) {
        const error = shopifyReferenceError(def, await resolveLinkedReferences(gql, ids.slice(i, i + 100)), schema)
        if (error) throw new WorkspaceScopeError(error, 422)
      }
    }
  }
  for (const def of definition.fields.filter(d => d.required)) if (!(input.fields.find(f => f.key === def.key)?.value ?? existing?.fields.find(f => f.key === def.key)?.value)) throw new WorkspaceScopeError(`${def.name} is required.`, 422)
  const matches = (entry: ShopifyReusableEntry) => (!input.status || entry.status === input.status) && input.fields.every(f => {
    const value = entry.fields.find(v => v.key === f.key)?.value
    return f.value === '' ? value === '' || value == null : value === f.value
  })
  // Reconcile a lost acknowledgement without duplicating entries or replaying an overwrite.
  if (existing && matches(existing)) return existing
  if (existing && (!input.id || input.expectedRevision !== existing.revision)) throw new WorkspaceScopeError('This entry changed in Shopify. Reload it before saving.')
  const patch = { fields: input.fields, ...(input.status ? { capabilities: { publishable: { status: input.status } } } : {}) }
  const payload = existing
    ? assertShopifyResult((await gql(`mutation NexusLinkedEntryUpdate($id:ID!,$metaobject:MetaobjectUpdateInput!) { metaobjectUpdate(id:$id,metaobject:$metaobject) { metaobject { id } userErrors { field message } } }`, { id: existing.id, metaobject: patch })).metaobjectUpdate, 'Save reusable entry')
    : assertShopifyResult((await gql(`mutation NexusLinkedEntryCreate($metaobject:MetaobjectCreateInput!) { metaobjectCreate(metaobject:$metaobject) { metaobject { id } userErrors { field message } } }`, { metaobject: { type: input.type, handle: input.handle, ...patch } })).metaobjectCreate, 'Create reusable entry')
  const verified = await getLinkedEntry(gql, (payload as any).metaobject.id)
  if (!matches(verified)) throw new WorkspaceScopeError('The reusable entry readback differs. Reload it before retrying.', 502)
  return verified
}
