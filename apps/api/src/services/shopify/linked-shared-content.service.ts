import { definitionAddress, fieldAddress, validateShopifyField, type ShopifyFieldEdit, type ShopifyFieldSnapshot, type ShopifyLinkedDraft, type ShopifyStoreSchema, type ShopifySharedSuggestion } from '@nexus/shared/shopify-linked-products'
import type { ShopifyGraphql } from './admin-client.js'
import { readLinkedFields, resolveLinkedReferences } from './linked-products-gateway.js'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'

/** Propose exact common values; distinct existing values become explicit overrides. */
export async function suggestSharedContent(gql: ShopifyGraphql, draft: ShopifyLinkedDraft, schema: ShopifyStoreSchema): Promise<ShopifySharedSuggestion[]> {
  if (draft.members.length < 2 || (draft.sharedFields?.length ?? 0) >= 100) return []
  const suggestions: ShopifySharedSuggestion[] = []
  for (const def of schema.definitions.filter(d => d.ownerType === 'PRODUCT' && !d.readOnlyReason && !/^(\$app|app--|apps--)/.test(d.namespace)
    && definitionAddress(d) !== (draft.relationship ? definitionAddress(draft.relationship) : '')
    && !draft.sharedFields?.some(r => definitionAddress(r) === definitionAddress(d)))) {
    const fields = await readLinkedFields(gql, draft.members.map(m => ({ ownerId: m.id, namespace: def.namespace, key: def.key })))
    // Pending individual edits are never silently turned into shared content.
    if (draft.edits.some(e => definitionAddress(e) === definitionAddress(def) && draft.members.some(m => m.id === e.ownerId))) continue
    const counts = new Map<string, number>()
    for (const f of fields) if (f.type === def.type && f.value !== null && !['', '[]'].includes(f.value)) counts.set(f.value, (counts.get(f.value) ?? 0) + 1)
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
    if (!ranked.length || ranked[0][1] < 2 || ranked[0][1] === ranked[1]?.[1]) continue
    const value = ranked[0][0], source = fields.find(f => f.value === value)!
    suggestions.push({ name: def.name, rule: { namespace: def.namespace, key: def.key, sourceProductId: source.ownerId,
      excludedProductIds: fields.filter(f => f.value !== value).map(f => f.ownerId), baseline: fields.map(f => ({ ...f, type: f.type || def.type })) } })
    if (suggestions.length + (draft.sharedFields?.length ?? 0) === 100) break
  }
  return suggestions
}

/** Source changes flow to followers; a changed follower always needs an explicit review. */
export async function resolveSharedContent(gql: ShopifyGraphql, draft: ShopifyLinkedDraft, schema: ShopifyStoreSchema) {
  const changes: ShopifyFieldEdit[] = [], verification: ShopifyFieldEdit[] = [], sources: ShopifyFieldSnapshot[] = []
  for (const rule of draft.sharedFields ?? []) {
    const def = schema.definitions.find(d => d.ownerType === 'PRODUCT' && d.namespace === rule.namespace && d.key === rule.key)
    if (!def || def.readOnlyReason) throw new WorkspaceScopeError(`The shared field ${rule.namespace}.${rule.key} is unavailable or read-only. Review its rule.`, 422)
    const followers = draft.members.filter(m => m.id !== rule.sourceProductId && !rule.excludedProductIds.includes(m.id))
    const fields = await readLinkedFields(gql, [rule.sourceProductId, ...followers.map(m => m.id)].map(ownerId => ({ ownerId, namespace: rule.namespace, key: rule.key })))
    const source = fields[0], sourceEdit = draft.edits.find(e => fieldAddress(e) === fieldAddress(source))
    const nextValue = sourceEdit ? sourceEdit.nextValue : source.value
    if (nextValue === null) throw new WorkspaceScopeError(`${def.name}: the shared source is empty. Choose content or remove the rule; automation will not clear family content.`, 422)
    if (source.value !== null && source.type !== def.type) throw new WorkspaceScopeError(`${def.name}: the source type changed. Refresh the rule.`, 422)
    const validation = validateShopifyField(def, nextValue)
    if (validation) throw new WorkspaceScopeError(`${def.name}: ${validation}`, 422)
    if (def.type.includes('_reference')) {
      const ids: string[] = def.type.startsWith('list.') ? JSON.parse(nextValue) : [nextValue]
      for (let offset = 0; offset < ids.length; offset += 100) {
        const refs = await resolveLinkedReferences(gql, ids.slice(offset, offset + 100))
        if (refs.some(r => !r.available)) throw new WorkspaceScopeError(`${def.name}: shared content contains an unavailable reference. Review its source.`, 422)
      }
    }
    sources.push(source)
    verification.push({ ...source, type: def.type, ownerLabel: draft.members.find(m => m.id === rule.sourceProductId)!.title, nextValue })
    for (const field of fields.slice(1)) {
      const baseline = rule.baseline.find(f => fieldAddress(f) === fieldAddress(field))
      if (!baseline || baseline.type !== def.type || field.value !== baseline.value || field.compareDigest !== baseline.compareDigest || (field.value !== null && field.type !== def.type))
        throw new WorkspaceScopeError(`${draft.members.find(m => m.id === field.ownerId)!.title} / ${def.name}: shared content changed in Shopify. Keep it as a product override or refresh and review before replacing it.`)
      const edit = { ...field, type: def.type, nextValue, ownerLabel: draft.members.find(m => m.id === field.ownerId)!.title }
      verification.push(edit)
      if (edit.value !== edit.nextValue) changes.push(edit)
    }
  }
  return { changes, verification, sources }
}
