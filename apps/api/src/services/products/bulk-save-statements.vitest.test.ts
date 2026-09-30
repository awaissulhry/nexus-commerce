/**
 * B31 (audit 2026-09-30) — statements per row of a bulk save, on a realistic eBay IT family (a parent and 21
 * variations, each listed, with the category's item specifics), through the real `applyProductBulkSave` on PGlite.
 * Every round trip the pg driver sends is counted (BEGIN, SAVEPOINT and COMMIT included).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import pg from 'pg'

vi.setConfig({ testTimeout: 120_000 })
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { applyProductBulkSave, type BulkSaveUnit } from './bulk-save.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ROWS = Number(process.env.B31_ROWS ?? 21)

async function sent<T>(work: () => Promise<T>): Promise<{ value: T; texts: string[] }> {
  const original = pg.Client.prototype.query
  const texts: string[] = []
  pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
    const first = args[0] as { text?: string } | string
    texts.push(typeof first === 'string' ? first : first?.text ?? '?')
    return (original as (...a: unknown[]) => unknown).apply(this, args)
  } as typeof original
  try { return { value: await work(), texts } } finally { pg.Client.prototype.query = original }
}
/** "SELECT Product", "UPDATE ChannelListing", "SAVEPOINT" … */
const kindOf = (text: string) => {
  const verb = text.trim().split(/\s+/)[0].toUpperCase()
  const table = /(?:FROM|INTO|UPDATE)\s+(?:"public"\.)?"?([A-Za-z_]+)"?/i.exec(text)?.[1] ?? ''
  return `${verb} ${table}`.trim()
}
const histogram = (texts: string[]) => Object.entries(texts.reduce<Record<string, number>>((acc, text) => { const k = kindOf(text); acc[k] = (acc[k] ?? 0) + 1; return acc }, {}))
  .sort((a, b) => b[1] - a[1])

let account = ''
const kids = Array.from({ length: ROWS }, (_, i) => `stmt-kid-${String(i).padStart(2, '0')}`)
beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } as never })
  account = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'statements', isActive: true, isPrimary: true, externalAccountId: 'FAKE-EBAY' } as never })).id
  await prisma.categorySchema.create({ data: { channel: 'EBAY', marketplace: 'IT', productType: '177104', schemaVersion: 'fixture', expiresAt: new Date('2099-01-01'), schemaDefinition: { aspects: [
    { id: 'aspect_Paese di origine', kind: 'enum', label: 'Paese di origine', localizedName: 'Paese di origine', options: ['Pakistan', 'Cina', 'Italia'], enumMode: 'strict', cardinality: 'SINGLE' },
    { id: 'aspect_Color', kind: 'text', label: 'Colore', localizedName: 'Colore', englishName: 'Color', cardinality: 'SINGLE', variantEligible: true },
    { id: 'aspect_Materiale', kind: 'text', label: 'Materiale', localizedName: 'Materiale', cardinality: 'SINGLE' },
  ] } as never } })
  await prisma.ebayDescriptionTheme.create({ data: { id: 'stmt-theme', name: 'stmt-theme', html: '<div>{{description}}</div>' } })
  await prisma.product.create({ data: { id: 'stmt-parent', sku: 'STMT-PARENT', name: 'Family', basePrice: 10, isParent: true, variationAxes: ['Colore'] } as never })
  await prisma.product.createMany({ data: kids.map(id => ({ id, sku: id.toUpperCase(), name: id, basePrice: 10, parentId: 'stmt-parent' })) })
  for (const [n, productId] of ['stmt-parent', ...kids].entries()) await prisma.channelListing.create({ data: { productId, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'IT',
    channelConnectionId: account, platformAttributes: { categoryId: '177104', itemSpecifics: { Colore: `C${n}`, Materiale: 'Pelle' } } as never } })
}), 120_000)
afterAll(async () => { await state.db?.close() })

/** The family's listing bags, as the eBay write contract reads them (A18: only for a channel attribute write). */
const familyBagReads = (texts: string[]) => texts.filter(text => /^\s*SELECT/.test(text) && text.includes('"ChannelListing"."aliasKey", "public"."ChannelListing"."platformAttributes"') && !text.includes('"ChannelListing"."version"')).length

const measure = async (field: string, value: (i: number) => unknown, check?: (texts: string[]) => void) => {
  const versions = await scoped(() => prisma.channelListing.findMany({ where: { productId: { in: kids } }, select: { productId: true, version: true } }))
  const units: BulkSaveUnit[] = kids.map((productId, i) => ({ key: productId, expectedVersion: versions.find(v => v.productId === productId)!.version,
    changes: [{ id: productId, field, value: value(i), target: 'channel', intent: 'set' } as never],
    marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT', locale: 'it', aliasKey: '', accountId: account }] }))
  const { value: result, texts } = await sent(() => scoped(() => applyProductBulkSave({ units }, { logger: { warn: vi.fn(), error: vi.fn() } } as never)))
  expect(result.units.map(unit => unit.status), JSON.stringify(result.units.find(unit => unit.status !== 200))).toEqual(kids.map(() => 200))
  if (process.env.B31_DUMP) {
    const start = texts.findIndex((text, i) => text.startsWith('SAVEPOINT') && i > texts.findIndex(t => t.startsWith('SAVEPOINT')))
    const end = texts.findIndex((text, i) => i > start && text.startsWith('RELEASE'))
    const misses = (globalThis as any).__B31 as string[]
    console.log(misses.slice(Math.floor(misses.length / 2), Math.floor(misses.length / 2) + 45).join('\n'))
    console.log(texts.slice(start, end + 1).map(text => text.replace(/\s+/g, ' ').slice(0, 70) + (text.includes(' @ ') ? ' @ ' + text.split(' @ ')[1] : '')).join('\n'))
  }
  check?.(texts)
  console.log(`[B31] ${field}: ${texts.length} statements for ${ROWS} rows = ${(texts.length / ROWS).toFixed(1)}/row`, JSON.stringify(histogram(texts).slice(0, 25)))
  return texts.length / ROWS
}

describe('B31 — statements per row of a bulk save (eBay IT family, one unit per row)', () => {
  // Measured 2026-09-30 on 21 rows (base → now): theme 39.2 → 32.4, item specific 47.7 → 42.8, axis 44.7 → 38.8. A ceiling
  // a little above today's numbers, so a change that adds a read per row is caught.
  it('Description theme', async () => { expect(await measure('attr_descriptionThemeId', () => 'stmt-theme')).toBeLessThanOrEqual(34) })
  it('an item specific (Materiale, listing-level: moves to the parent listing)', async () => { expect(await measure('attr_materiale', i => `M${i}`)).toBeLessThanOrEqual(45) })
  it('an axis (Colore)', async () => { expect(await measure('attr_color', i => `X${i}`)).toBeLessThanOrEqual(41) })
  it('A18: a quantity paste never reads the family\'s item-specific bags', async () => {
    await measure('ebay_quantity', i => i + 1, texts => expect(familyBagReads(texts)).toBe(0))
  })
})
