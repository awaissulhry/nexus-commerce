/**
 * How a file row finds the record it means — the join, tested.
 *
 * buildPreview had no test at all, which is how the defect below survived
 * shipping and a review: AX-ZD.9 added `_row_key` resolution and it could not
 * fire in the one case it was written for.
 *
 * The batch queries selected records by their EXTERNAL id column only. The
 * row-key map was then built from whatever those queries returned, so a record
 * could only be found by local id once it had already been found by external id.
 * A row whose id column was blank or mangled resolved by neither path and
 * previewed as UNRESOLVED — silently, since UNRESOLVED reads as "this row is not
 * in the account" rather than "we could not read your file".
 *
 * Proved on prod: every one of the 20 campaign-level negative keywords in the
 * account has a null externalTargetId, so all 20 exported and none could return.
 *
 * The fake below is deliberately literal about the `where` clause, because the
 * shape of that clause IS the bug.
 */
import { describe, it, expect } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { buildPreview } from './preview.js'
import { buildRowKey } from '@nexus/shared/ads-bulksheet'

type Rec = Record<string, unknown>

/** Honours `{ OR: [{ <col>: { in } }, { id: { in } }] }` and the plain form. */
function match(rows: Rec[], where: Rec): Rec[] {
  const clauses = (where.OR as Rec[] | undefined) ?? [where]
  return rows.filter((r) => clauses.some((c) => Object.entries(c).every(([col, cond]) => {
    const wanted = (cond as { in?: unknown[] }).in
    return Array.isArray(wanted) && r[col] != null && wanted.includes(r[col])
  })))
}

interface Fixtures {
  staged: Array<{ rowIndex: number; status: string; parsedValues: unknown }>
  campaigns?: Rec[]
  adGroups?: Rec[]
  targets?: Rec[]
  productAds?: Rec[]
}

function fakePrisma(f: Fixtures): PrismaClient {
  const table = (rows: Rec[] = []) => ({ findMany: async ({ where }: { where: Rec }) => match(rows, where) })
  return {
    importJobRow: { findMany: async () => f.staged },
    campaign: table(f.campaigns),
    adGroup: table(f.adGroups),
    adTarget: table(f.targets),
    amazonAdsPortfolio: table([]),
    adProductAd: table(f.productAds),
  } as unknown as PrismaClient
}

const staged = (rowIndex: number, entity: string, values: Rec, rowKey = ''): { rowIndex: number; status: string; parsedValues: unknown } => ({
  rowIndex, status: 'PENDING',
  parsedValues: { entity, operation: 'Update', rowKey, baseline: '', values: { Product: 'Sponsored Products', Entity: entity, Operation: 'Update', ...values } },
})

const TARGET = {
  id: 'loc_tgt_1', externalTargetId: null, expressionValue: 'giacca moto', expressionType: 'PHRASE',
  status: 'ENABLED', bidCents: 45, isNegative: true,
}
const CAMPAIGN = {
  id: 'loc_camp_1', externalCampaignId: '204055123456789', name: 'Alpha', status: 'ENABLED',
  dailyBudget: 20, biddingStrategy: 'LEGACY_FOR_SALES', portfolioId: null,
}

describe('a row whose ID column is unusable still resolves through _row_key', () => {
  it('finds a target that has NO external id at all', async () => {
    // The campaign-negative-keyword case from prod. Nothing to match on but the
    // row key.
    const rowKey = buildRowKey({ entity: 'Campaign negative keyword', externalId: null, localId: TARGET.id })
    const p = await buildPreview(fakePrisma({
      staged: [staged(0, 'Campaign negative keyword', { 'Keyword ID': '', State: 'paused' }, rowKey)],
      targets: [TARGET],
    }), 'job')

    expect(p.counts.unresolved, 'the row key was ignored — this is the shipped defect').toBe(0)
    expect(p.rows[0].status).toBe('UPDATE')
    expect(p.rows[0].targetId).toBe('loc_tgt_1')
    expect(p.rows[0].diffs).toEqual([{ field: 'State', current: 'enabled', next: 'paused' }])
  })

  it('finds a campaign whose id Excel rewrote as 2.04055E+14', async () => {
    // The motivating scenario in AX-ZD.9's own comment. The mangled value is not
    // blank, so it reaches the query and matches nothing.
    const rowKey = buildRowKey({ entity: 'Campaign', externalId: CAMPAIGN.externalCampaignId, localId: CAMPAIGN.id })
    const p = await buildPreview(fakePrisma({
      staged: [staged(0, 'Campaign', { 'Campaign ID': '2.04055E+14', State: 'paused' }, rowKey)],
      campaigns: [CAMPAIGN],
    }), 'job')

    expect(p.counts.unresolved).toBe(0)
    expect(p.rows[0].targetId).toBe('loc_camp_1')
    expect(p.rows[0].label).toBe('Alpha')
  })

  it('still resolves by ID column when there is no row key', async () => {
    // Purely additive: the old path must be untouched.
    const p = await buildPreview(fakePrisma({
      staged: [staged(0, 'Campaign', { 'Campaign ID': '204055123456789', State: 'paused' })],
      campaigns: [CAMPAIGN],
    }), 'job')

    expect(p.rows[0].status).toBe('UPDATE')
    expect(p.rows[0].targetId).toBe('loc_camp_1')
  })
})

describe('the row key is not a skeleton key', () => {
  it('refuses a key minted for a different entity', async () => {
    // An ad group's key pasted onto a campaign row must not resolve, or the row
    // diffs against fields the record does not own.
    const wrongKey = buildRowKey({ entity: 'Ad group', externalId: null, localId: CAMPAIGN.id })
    const p = await buildPreview(fakePrisma({
      staged: [staged(0, 'Campaign', { 'Campaign ID': '', State: 'paused' }, wrongKey)],
      campaigns: [CAMPAIGN],
    }), 'job')

    expect(p.counts.unresolved).toBe(1)
    expect(p.rows[0].targetId).toBeNull()
  })

  it('reports UNRESOLVED, not a crash, when the local id no longer exists', async () => {
    // The record was deleted between export and upload.
    const rowKey = buildRowKey({ entity: 'Campaign', externalId: null, localId: 'gone' })
    const p = await buildPreview(fakePrisma({
      staged: [staged(0, 'Campaign', { 'Campaign ID': '', State: 'paused' }, rowKey)],
      campaigns: [CAMPAIGN],
    }), 'job')

    expect(p.counts.unresolved).toBe(1)
    expect(p.rows[0].note).toMatch(/No campaign/)
  })
})

describe('a CREATE resolves its PARENT, not itself', () => {
  const AG = { id: 'loc_ag_1', externalAdGroupId: '777', name: 'AG', status: 'ENABLED', defaultBidCents: 50 }

  it('previews a new keyword as a diff from nothing, with the parent attached', async () => {
    const p = await buildPreview(fakePrisma({
      staged: [staged(0, 'Keyword', { 'Ad group ID': '777', 'Keyword text': 'giacca moto', 'Match type': 'Exact', Bid: '0,85', State: 'enabled' })].map((s) => ({
        ...s, parsedValues: { ...(s.parsedValues as Rec), operation: 'Create' },
      })),
      adGroups: [AG],
    }), 'job')

    expect(p.rows[0].status).toBe('CREATE')
    expect(p.rows[0].parentId, 'the new row must know which ad group it hangs off').toBe('loc_ag_1')
    expect(p.rows[0].targetId, 'nothing exists yet to point at').toBeNull()
    expect(p.rows[0].label).toBe('giacca moto')
    // Every field the new row will be born with, so the preview is not a bare verdict.
    expect(p.rows[0].diffs).toEqual([
      { field: 'Keyword text', current: '', next: 'giacca moto' },
      { field: 'Match type', current: '', next: 'Exact' },
      { field: 'Bid', current: '', next: '0,85' },
      { field: 'State', current: '', next: 'enabled' },
    ])
  })

  it('omits columns the operator left blank rather than listing them as empty', async () => {
    const p = await buildPreview(fakePrisma({
      staged: [staged(0, 'Negative keyword', { 'Ad group ID': '777', 'Keyword text': 'bambino', 'Match type': 'Negative exact' })].map((s) => ({
        ...s, parsedValues: { ...(s.parsedValues as Rec), operation: 'Create' },
      })),
      adGroups: [AG],
    }), 'job')
    expect(p.rows[0].diffs.map((d) => d.field)).toEqual(['Keyword text', 'Match type'])
  })

  it('refuses a new row whose parent does not exist, and says which column is wrong', async () => {
    const p = await buildPreview(fakePrisma({
      staged: [staged(0, 'Keyword', { 'Ad group ID': '999', 'Keyword text': 'x', 'Match type': 'Exact', Bid: '1,00' })].map((s) => ({
        ...s, parsedValues: { ...(s.parsedValues as Rec), operation: 'Create' },
      })),
      adGroups: [AG],
    }), 'job')
    expect(p.rows[0].status).toBe('UNRESOLVED')
    expect(p.rows[0].note).toMatch(/No ad group with Ad group ID "999"/)
  })

  it('says the parent column is REQUIRED when it is blank', async () => {
    const p = await buildPreview(fakePrisma({
      staged: [staged(0, 'Product ad', { SKU: 'XV-001' })].map((s) => ({
        ...s, parsedValues: { ...(s.parsedValues as Rec), operation: 'Create' },
      })),
      adGroups: [AG],
    }), 'job')
    expect(p.rows[0].status).toBe('UNRESOLVED')
    expect(p.rows[0].note).toMatch(/Ad group ID is required/)
  })
})

describe('product ads resolve on both keys too', () => {
  const AD = { id: 'loc_ad_1', externalAdId: '493240712820577', sku: null, asin: 'B0CR5TFBZC', status: 'ENABLED' }

  it('by Ad ID', async () => {
    const p = await buildPreview(fakePrisma({
      staged: [staged(0, 'Product ad', { 'Ad ID': '493240712820577', State: 'paused' })],
      productAds: [AD],
    }), 'job')
    expect(p.rows[0].status).toBe('UPDATE')
    // Labelled by what an operator recognises, not the 15-digit id.
    expect(p.rows[0].label).toBe('B0CR5TFBZC')
  })

  it('by row key when the Ad ID was mangled', async () => {
    const rowKey = buildRowKey({ entity: 'Product ad', externalId: AD.externalAdId, localId: AD.id })
    const p = await buildPreview(fakePrisma({
      staged: [staged(0, 'Product ad', { 'Ad ID': '4.93241E+14', State: 'paused' }, rowKey)],
      productAds: [AD],
    }), 'job')
    expect(p.counts.unresolved).toBe(0)
    expect(p.rows[0].targetId).toBe('loc_ad_1')
  })

  it('reports no change when the file matches the record', async () => {
    const p = await buildPreview(fakePrisma({
      staged: [staged(0, 'Product ad', { 'Ad ID': '493240712820577', State: 'enabled' })],
      productAds: [AD],
    }), 'job')
    expect(p.rows[0].status).toBe('UNCHANGED')
  })
})
