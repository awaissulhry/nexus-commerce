import { beforeEach, expect, it, vi } from 'vitest'
import { parse } from 'graphql'
const state = vi.hoisted(() => ({ calls: [] as string[], missing: false }))
vi.mock('./content-workspace.service.js', () => ({ contentDestination: async () => ({ accountId: 'account' }) }))
vi.mock('./admin-client.js', () => ({ shopifyAdmin: async () => ({ graphql: async (query: string, variables: any) => {
  parse(query); const name = query.match(/query (\w+)/)![1]; state.calls.push(name)
  if (name === 'NexusImportSource') return { shopLocales: [{ locale: 'it', primary: true, published: true }], product: {
    id: 'gid://shopify/Product/1', title: 'Jacket', media: { nodes: [], pageInfo: {} }, variants: { nodes: [], pageInfo: {} },
    metafields: { nodes: [{ id: 'gid://shopify/Metafield/1', namespace: 'custom', key: 'features', type: 'list.metaobject_reference', value: '[]', definition: { name: 'Features', validations: [{ name: 'metaobject_definition_id', value: 'gid://shopify/MetaobjectDefinition/1' }] } }], pageInfo: {} },
  } }
  if (name === 'NexusReferenceType') {
    if (state.missing) return { node: null }
    const nested = variables.id.endsWith('/2')
    return { node: { id: variables.id, name: nested ? 'Copy' : 'Feature', type: nested ? 'feature_copy' : 'feature', fieldDefinitions: [nested
      ? { key: 'text', name: 'Text', type: { name: 'single_line_text_field' }, validations: [] }
      : { key: 'copy', name: 'Copy', type: { name: 'metaobject_reference' }, validations: [{ name: 'metaobject_definition_id', value: 'gid://shopify/MetaobjectDefinition/2' }] }],
    } }
  }
  throw new Error(`Unexpected operation ${name}`)
} }) }))
import { importContentSource } from './content-import.service.js'
beforeEach(() => { state.calls = []; state.missing = false })
it('imports referenced definitions recursively even when the entry list is empty', async () => {
  const result = await importContentSource('family', { accountId: 'account', market: 'GLOBAL' }, '1')
  expect(result.metaobjectDefinitions.map(d => d.type)).toEqual(['feature', 'feature_copy'])
  expect(result.metaobjectDefinitions[0].fields[0].metaobjectType).toBe('feature_copy')
  expect(result.metaobjects).toEqual([])
  expect(result.values['custom.features'].value).toBe('[]')
  expect(state.calls).toEqual(['NexusImportSource', 'NexusReferenceType', 'NexusReferenceType'])
})
it('refuses an unavailable referenced definition instead of returning an incomplete import', async () => {
  state.missing = true
  await expect(importContentSource('family', { accountId: 'account', market: 'GLOBAL' }, '1')).rejects.toThrow('definition is unavailable')
})
