/**
 * W2.4 — Pure-function tests for mergeFamilyAttributes.
 *
 * No DB. Run with `npx tsx <file>`. Vitest harness lands with
 * TECH_DEBT #42; until then this file documents intent + runs
 * trivially when imported, matching the pattern of
 * atp-channel.service.test.ts.
 */

import {
  mergeFamilyAttributes,
  type FamilyChainNode,
} from './family-hierarchy.service.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a)
  const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected=${y} actual=${x}`)
}

const SELF_ID = 'fam-jacket'
const PARENT_ID = 'fam-apparel'
const GRAND_ID = 'fam-clothing'

const ATTR_BRAND = 'attr-brand'
const ATTR_COLOR = 'attr-color'
const ATTR_SIZE = 'attr-size'
const ATTR_CE = 'attr-ce-cert'

test('single family with no parents returns its own attributes', () => {
  const chain: FamilyChainNode[] = [
    {
      id: SELF_ID,
      parentFamilyId: null,
      familyAttributes: [
        { attributeId: ATTR_BRAND, required: true, channels: [], sortOrder: 0 },
        { attributeId: ATTR_COLOR, required: false, channels: [], sortOrder: 1 },
      ],
    },
  ]
  const r = mergeFamilyAttributes(chain)
  eq(r.length, 2)
  eq(r[0].attributeId, ATTR_BRAND)
  eq(r[0].source, 'self')
  eq(r[1].attributeId, ATTR_COLOR)
  eq(r[1].source, 'self')
})

test('parent attributes are inherited and tagged with parent id', () => {
  const chain: FamilyChainNode[] = [
    {
      id: SELF_ID,
      parentFamilyId: PARENT_ID,
      familyAttributes: [
        { attributeId: ATTR_CE, required: true, channels: ['AMAZON'], sortOrder: 5 },
      ],
    },
    {
      id: PARENT_ID,
      parentFamilyId: null,
      familyAttributes: [
        { attributeId: ATTR_BRAND, required: true, channels: [], sortOrder: 0 },
      ],
    },
  ]
  const r = mergeFamilyAttributes(chain)
  eq(r.length, 2)
  // Sort order: brand (0) before ce (5)
  eq(r[0].attributeId, ATTR_BRAND)
  eq(r[0].source, PARENT_ID)
  eq(r[1].attributeId, ATTR_CE)
  eq(r[1].source, 'self')
})

test('parent wins on duplicate attributeId (Akeneo-strict additive)', () => {
  // Child re-declares ATTR_BRAND as optional. Parent had it required.
  // Resolver MUST return parent's required=true.
  const chain: FamilyChainNode[] = [
    {
      id: SELF_ID,
      parentFamilyId: PARENT_ID,
      familyAttributes: [
        { attributeId: ATTR_BRAND, required: false, channels: [], sortOrder: 99 },
      ],
    },
    {
      id: PARENT_ID,
      parentFamilyId: null,
      familyAttributes: [
        { attributeId: ATTR_BRAND, required: true, channels: ['AMAZON', 'EBAY'], sortOrder: 0 },
      ],
    },
  ]
  const r = mergeFamilyAttributes(chain)
  eq(r.length, 1)
  eq(r[0].attributeId, ATTR_BRAND)
  eq(r[0].required, true, 'parent-wins: required from parent kept')
  eq(r[0].channels, ['AMAZON', 'EBAY'], 'parent-wins: channels from parent kept')
  eq(r[0].sortOrder, 0, 'parent-wins: sortOrder from parent kept')
  eq(r[0].source, PARENT_ID, 'source points to parent, not self')
})

test('three-level chain merges additively from root down', () => {
  const chain: FamilyChainNode[] = [
    {
      id: SELF_ID,
      parentFamilyId: PARENT_ID,
      familyAttributes: [
        { attributeId: ATTR_CE, required: true, channels: [], sortOrder: 3 },
      ],
    },
    {
      id: PARENT_ID,
      parentFamilyId: GRAND_ID,
      familyAttributes: [
        { attributeId: ATTR_SIZE, required: true, channels: [], sortOrder: 2 },
      ],
    },
    {
      id: GRAND_ID,
      parentFamilyId: null,
      familyAttributes: [
        { attributeId: ATTR_BRAND, required: true, channels: [], sortOrder: 0 },
        { attributeId: ATTR_COLOR, required: false, channels: [], sortOrder: 1 },
      ],
    },
  ]
  const r = mergeFamilyAttributes(chain)
  eq(r.length, 4)
  eq(r.map((x) => x.attributeId), [ATTR_BRAND, ATTR_COLOR, ATTR_SIZE, ATTR_CE])
  eq(r.map((x) => x.source), [GRAND_ID, GRAND_ID, PARENT_ID, 'self'])
})

test('output is deterministic — same input always sorts the same way', () => {
  const chain: FamilyChainNode[] = [
    {
      id: SELF_ID,
      parentFamilyId: null,
      familyAttributes: [
        // Same sortOrder; tie-break must use attributeId ascending.
        { attributeId: 'z-attr', required: false, channels: [], sortOrder: 5 },
        { attributeId: 'a-attr', required: false, channels: [], sortOrder: 5 },
        { attributeId: 'm-attr', required: false, channels: [], sortOrder: 5 },
      ],
    },
  ]
  const r = mergeFamilyAttributes(chain)
  eq(r.map((x) => x.attributeId), ['a-attr', 'm-attr', 'z-attr'])
})

test('channels array is copied (callers cannot mutate cached parent rows)', () => {
  const parentChannels = ['AMAZON', 'EBAY']
  const chain: FamilyChainNode[] = [
    {
      id: SELF_ID,
      parentFamilyId: null,
      familyAttributes: [
        { attributeId: ATTR_BRAND, required: true, channels: parentChannels, sortOrder: 0 },
      ],
    },
  ]
  const r = mergeFamilyAttributes(chain)
  // Mutating the result must not touch the input.
  r[0].channels.push('SHOPIFY')
  eq(parentChannels, ['AMAZON', 'EBAY'], 'caller mutation did not leak')
})

test('empty chain returns empty result', () => {
  eq(mergeFamilyAttributes([]), [])
})

let failed = 0
for (const t of tests) {
  try {
    t.fn()
    console.log(`  ok  ${t.name}`)
  } catch (e) {
    failed++
    console.error(`FAIL  ${t.name}\n      ${e instanceof Error ? e.message : String(e)}`)
  }
}
if (failed > 0) {
  console.error(`\n${failed} test(s) failed`)
  process.exit(1)
}
console.log(`\n${tests.length} tests passed`)
