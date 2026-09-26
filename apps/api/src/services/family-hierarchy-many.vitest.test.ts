/**
 * P3 (docs/attributes/PLAN.md §4.1) — `resolveEffectiveAttributesMany` must equal `resolveEffectiveAttributes` for every
 * family, and must cost one query per hierarchy LEVEL, not one per family per ancestor.
 */
import { expect, it, vi } from 'vitest'
vi.mock('../db.js', () => ({ default: {} }))
import { FamilyHierarchyService, type FamilyChainNode } from './family-hierarchy.service.js'

const attr = (attributeId: string, required = false, sortOrder = 0, channels: string[] = []) => ({ attributeId, required, channels, sortOrder })

function fakeClient(nodes: FamilyChainNode[]) {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const calls = { findUnique: 0, findMany: 0 }
  const client = {
    productFamily: {
      findUnique: async ({ where }: { where: { id: string } }) => { calls.findUnique++; return byId.get(where.id) ?? null },
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => { calls.findMany++; return where.id.in.map(id => byId.get(id)).filter(Boolean) },
    },
  }
  return { service: new FamilyHierarchyService(client as never), calls }
}

// general → apparel → protective → {jackets, gloves}; apparel → rainwear; plus a lone family.
const TREE: FamilyChainNode[] = [
  { id: 'general', parentFamilyId: null, familyAttributes: [attr('brand', true, 0), attr('gtin', false, 1)] },
  { id: 'apparel', parentFamilyId: 'general', familyAttributes: [attr('color', true, 2, ['AMAZON']), attr('size', true, 3)] },
  { id: 'protective', parentFamilyId: 'apparel', familyAttributes: [attr('ce', false, 4), attr('brand', false, 9)] },
  { id: 'jackets', parentFamilyId: 'protective', familyAttributes: [attr('collar', false, 5)] },
  { id: 'gloves', parentFamilyId: 'protective', familyAttributes: [attr('knuckle', true, 5)] },
  { id: 'rainwear', parentFamilyId: 'apparel', familyAttributes: [attr('waterproof', true, 5)] },
  { id: 'lone', parentFamilyId: null, familyAttributes: [attr('note', false, 0)] },
]

it('equals the single-family resolver for every family, including shared ancestors and a parent-wins conflict', async () => {
  const ids = TREE.map(n => n.id)
  const { service } = fakeClient(TREE)
  const many = await service.resolveEffectiveAttributesMany(ids)
  for (const id of ids) expect(many.get(id)).toEqual(await service.resolveEffectiveAttributes(id))
  // Positive control: inheritance really happened (brand stays required: the ancestor wins over `protective`).
  expect(many.get('jackets')!.map(a => a.attributeId)).toEqual(['brand', 'gtin', 'color', 'size', 'ce', 'collar'])
  expect(many.get('jackets')!.find(a => a.attributeId === 'brand')).toMatchObject({ required: true, source: 'general' })
})

it('costs one query per hierarchy level, whatever the number of families', async () => {
  const { service, calls } = fakeClient(TREE)
  await service.resolveEffectiveAttributesMany(['jackets', 'gloves', 'rainwear', 'lone'])
  // Levels: {jackets, gloves, rainwear, lone} → {protective, apparel} → {general} (apparel already loaded) → stop.
  expect(calls.findMany).toBe(3)
  expect(calls.findUnique).toBe(0)
  const single = fakeClient(TREE)
  for (const id of ['jackets', 'gloves', 'rainwear', 'lone']) await single.service.resolveEffectiveAttributes(id)
  expect(single.calls.findUnique).toBe(4 + 4 + 3 + 1)
})

it('throws for a missing family and for a cycle, like the single form', async () => {
  const { service } = fakeClient(TREE)
  await expect(service.resolveEffectiveAttributesMany(['jackets', 'nope'])).rejects.toThrow('family nope not found')
  const cyclic = fakeClient([
    { id: 'a', parentFamilyId: 'b', familyAttributes: [] },
    { id: 'b', parentFamilyId: 'a', familyAttributes: [] },
  ])
  await expect(cyclic.service.resolveEffectiveAttributesMany(['a'])).rejects.toThrow('cycle detected at family a')
})
