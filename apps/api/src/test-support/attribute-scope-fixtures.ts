/**
 * P3b S0 (docs/attributes/PLAN.md §10.9) — the four businesses the attribute-scope steps are measured on.
 *
 * Each is created through the real `createWorkspaceService().create` (its 20 markets and starter dictionary are the
 * ones production creates), then given only what makes it that case:
 *
 *   F1 eBay only        one active eBay account; one product, no family
 *   F2 Amazon only      one active Amazon account; one product, no family, with an Amazon-only key in its shared bag
 *                       (what an Amazon-scope save of a field with no listing store writes, `channel-specs/amazon.ts`)
 *   F3 no channel       nothing connected; one product, no family
 *   F4 Motovento-shaped eBay + Etsy accounts; the 242 shared attributes of the study (`attribute-scope-dictionary.json`)
 *                       in a Jackets family, created like the assortment copy does (`skipDuplicates`: a starter row with
 *                       the same code is kept); one product in the family
 *
 * Tests call it inside `formulaDatabase()` (PGlite with the generated row-level-security policies).
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { PrismaClient } from '@prisma/client'
import { createWorkspaceService } from '../services/workspace.service.js'
import { withWorkspace, type WorkspaceContext } from '../lib/workspace-context.js'

export type ScopeFixtureKey = 'F1' | 'F2' | 'F3' | 'F4'

export interface ScopeFixture {
  context: WorkspaceContext
  productId: string
  familyId: string | null
  channels: string[]
}

export interface StudyAttribute { code: string; label: string; type: string; class: 'core' | 'channel-specific' | 'unused-or-duplicate' }

export function studyAttributes(): StudyAttribute[] {
  const file = new URL('./attribute-scope-dictionary.json', import.meta.url)
  return (JSON.parse(readFileSync(file, 'utf8')) as { attributes: StudyAttribute[] }).attributes
}

/** An Amazon-only attribute of the study (class `channel-specific`), used for F2's shared-bag key. */
export const AMAZON_ONLY_KEY = 'department'

const CHANNELS: Record<ScopeFixtureKey, string[]> = { F1: ['EBAY'], F2: ['AMAZON'], F3: [], F4: ['EBAY', 'ETSY'] }

/**
 * A new business's own settings (not a market's currency). Currency is listed first: the market-currency gate
 * (`apps/api/scripts/check-market-currency.mjs`) reads a market code followed by a currency literal as a
 * market→currency decision, and this is none.
 */
const NEW_BUSINESS = { currency: 'EUR', timezone: 'Europe/Rome', country: 'IT' } as const

export async function createScopeFixtures(client: PrismaClient): Promise<Record<ScopeFixtureKey, ScopeFixture>> {
  if (!(await client.role.findUnique({ where: { key: 'OWNER' } }))) await client.role.create({ data: { key: 'OWNER', name: 'Owner', isSystem: true } })
  const service = createWorkspaceService(client)
  const out = {} as Record<ScopeFixtureKey, ScopeFixture>
  for (const key of ['F1', 'F2', 'F3', 'F4'] as const) {
    const user = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active' } })
    const created = await service.create(user.id, { name: `Scope ${key}`, ...NEW_BUSINESS, creationKey: randomUUID() })
    const context = (await service.membership(user.id, created.id)).context
    const { productId, familyId } = await withWorkspace(context, async () => {
      for (const channelType of CHANNELS[key]) {
        // A made-up account id: the active-account unique index is not per business, and a real account always has one.
        await client.channelConnection.create({ data: { channelType, managedBy: 'oauth', isActive: true, accountLabel: `${key} ${channelType}`, externalAccountId: `scope-${key}-${channelType}` } as never })
      }
      if (key !== 'F4') {
        const product = await client.product.create({ data: { sku: `SCOPE-${key}`, name: `Scope ${key}`, basePrice: 10,
          ...(key === 'F2' ? { categoryAttributes: { [AMAZON_ONLY_KEY]: 'Uomo' } } : {}) } })
        return { productId: product.id, familyId: null }
      }
      const group = await client.attributeGroup.create({ data: { code: 'scope-copied', label: 'Copied attributes' } })
      const attributes = studyAttributes()
      await client.customAttribute.createMany({ data: attributes.map((a, i) => ({ code: a.code, label: a.label, type: a.type, groupId: group.id, sortOrder: i })), skipDuplicates: true })
      const ids = await client.customAttribute.findMany({ where: { code: { in: attributes.map(a => a.code) } }, select: { id: true } })
      const family = await client.productFamily.create({ data: { code: 'jackets', label: 'Jackets' } })
      await client.familyAttribute.createMany({ data: ids.map((a, i) => ({ familyId: family.id, attributeId: a.id, required: false, channels: [], sortOrder: i })) })
      const product = await client.product.create({ data: { sku: 'SCOPE-F4', name: 'Scope F4', basePrice: 10, familyId: family.id } })
      return { productId: product.id, familyId: family.id }
    })
    out[key] = { context, productId, familyId, channels: CHANNELS[key] }
  }
  return out
}
