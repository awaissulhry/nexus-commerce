import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedCostActuals, type CostActualsSeed } from '../seed/cost-actuals'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Actual cost to the end (W2b-6, schema wave 54/57, B-W2b-376, …_cost_actuals_w2b_guards) on a database built from the
 * migrations and seeded twice, through the real login and the office scope:
 *   - the settings: the close tolerance, the purchase price variance's place, the company's switch for the accountant's
 *     figures (GATE-ACCOUNTANT: off by default, only on a company's row, with when and by whom); never deleted;
 *   - a work order's close: the reason exactly beyond the tolerance in force, only a COMPLETED work order, one live close,
 *     the work order CLOSED with it in the same transaction; the Undo within 60 seconds by the person who closed it, a
 *     reopen with a reason; an undone close frozen; the work order back to COMPLETED only with its close undone and the
 *     close's entries reversed (the redefined work order guard lets CLOSED → COMPLETED through);
 *   - the close's ledger: a closed or settled work order takes no cost entry but a reversal; a VARIANCE entry takes its
 *     variance off, before the CLOSE entry; the CLOSE entry leaves the work order at 0; their reversals only once the close
 *     is undone; nothing of it while the switch is off;
 *   - the variance split, purchase price variances and cost of goods sold: where and what they may be; reversed once;
 *     append-only; nothing while the switch is off;
 *   - landed cost: born DRAFT, posted with its shares adding up (one POSTED per charge line), reversed with why, shares only
 *     while DRAFT, only a DRAFT deleted.
 * The refusals are check_violation (23514) in words, a unique key's 23505, or the grants' "permission denied".
 */

const NS = 'w2b-376-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: CostActualsSeed

const key = (name: string): string => seedUuid(NS, name)
const companyA = (): string => key('company:A')
const siteA = (): string => key('site:A1')
const leather = (): string => key('product:item:leather')
const lot = (): string => s.accounting.money.shipping.quality.production.inventory.leatherLotId
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (text: string, ...values: unknown[]) => as(office(), (client) => client.$executeRawUnsafe(text, ...values))
/** Several statements in one office transaction (the deferred checks run at its commit). */
const inOne = (...statements: [string, ...unknown[]][]) =>
  as(office(), (client) =>
    client.$transaction(async (tx) => {
      for (const [text, ...values] of statements) await tx.$executeRawUnsafe(text, ...values)
    }),
  )
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const one = async (text: string, values: unknown[] = []) => (await admin(text, values))[0] as Record<string, unknown>

/** An INSERT of the row's own columns (the others take their defaults). */
const insertOf = (table: string, row: Record<string, unknown>): [string, ...unknown[]] => {
  const columns = Object.keys(row).map((column) => `"${column}"`).join(', ')
  return [`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row)]
}

const switchTo = (on: boolean) =>
  run(
    `UPDATE "ActualCostSettings" SET "postingsOn" = $2, "postingsOnAt" = ${on ? 'now()' : 'NULL'}, "postingsOnById" = ${on ? '$3::uuid' : 'NULL'} WHERE id = $1::uuid`,
    s.settingsIds.companyA,
    on,
    ...(on ? [a.actorId] : []),
  )

/** A cost entry of SEED-WO-0004 (the columns a test names, the rest as the seed writes them). */
const entry = (columns: Record<string, unknown>): [string, ...unknown[]] => {
  const row = {
    id: randomUUID(),
    companyId: companyA(),
    siteId: siteA(),
    workOrderId: s.workOrderId,
    currency: 'EUR',
    costingMethod: 'UNDECIDED',
    idempotencyKey: `test:${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    ...columns,
  }
  return insertOf('WorkOrderCostEntry', row)
}
const post = (columns: Record<string, unknown>) => run(...entry(columns))

/** A close of SEED-WO-0004, as the seed's but at `closedAt` (now when not given). */
const closeRow = (columns: Record<string, unknown>): [string, ...unknown[]] => {
  const row = {
    id: randomUUID(),
    companyId: companyA(),
    siteId: siteA(),
    workOrderId: s.workOrderId,
    plannedQuantity: 2,
    actualQuantity: 2,
    plannedScrapQuantity: 0,
    scrapQuantity: 0,
    plannedMaterialCost: 9000,
    actualMaterialCost: 9100,
    plannedMinutes: '244',
    actualMinutes: '244',
    currency: 'EUR',
    tolerancePct: '5',
    closedAt: new Date().toISOString(),
    closedById: a.actorId,
    ...columns,
  }
  return insertOf('WorkOrderClose', row)
}

beforeAll(async () => {
  db = await migratedDatabase('costactualsw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  s = await seedCostActuals({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent.
  await seedCostActuals({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the seed', () => {
  it('runs twice: two closes (the first undone), the work order CLOSED at the second and its entries adding up to 0', async () => {
    const counts = await one(
      `SELECT (SELECT count(*)::int FROM "ActualCostSettings" WHERE "tenantId" = $1::uuid) AS settings,
              (SELECT count(*)::int FROM "WorkOrderClose" WHERE "tenantId" = $1::uuid) AS closes,
              (SELECT count(*)::int FROM "WorkOrderVariance" WHERE "tenantId" = $1::uuid) AS variances,
              (SELECT count(*)::int FROM "PurchasePriceVariance" WHERE "tenantId" = $1::uuid) AS ppv,
              (SELECT count(*)::int FROM "CostOfSalesEntry" WHERE "tenantId" = $1::uuid) AS cogs,
              (SELECT count(*)::int FROM "LandedCostAllocation" WHERE "tenantId" = $1::uuid) AS landed,
              (SELECT count(*)::int FROM "LandedCostShare" WHERE "tenantId" = $1::uuid) AS shares,
              (SELECT sum(amount)::int FROM "WorkOrderCostEntry" WHERE "workOrderId" = $2::uuid) AS balance,
              (SELECT status::text FROM "WorkOrder" WHERE id = $2::uuid) AS status,
              (SELECT "closedAt" = (SELECT "closedAt" FROM "WorkOrderClose" WHERE id = $3::uuid) FROM "WorkOrder" WHERE id = $2::uuid) AS "closedByIt"`,
      [a.tenantId, s.workOrderId, s.closeIds.live],
    )
    expect(counts).toEqual({ settings: 2, closes: 2, variances: 3, ppv: 1, cogs: 4, landed: 2, shares: 2, balance: 0, status: 'CLOSED', closedByIt: true })
  })
})

describe('actual-cost settings (GATE-ACCOUNTANT)', () => {
  it('keep the tolerance 0 to 100, the switch on a company row only, with when and by whom', async () => {
    await expect(run(`UPDATE "ActualCostSettings" SET "closeTolerancePct" = 101 WHERE id = $1::uuid`, s.settingsIds.tenant)).rejects.toThrow(/percent from 0 to 100/)
    await expect(run(`UPDATE "ActualCostSettings" SET "postingsOn" = true, "postingsOnAt" = now(), "postingsOnById" = $2::uuid WHERE id = $1::uuid`, s.settingsIds.tenant, a.actorId)).rejects.toThrow(
      /switched on per company, on its own settings row/,
    )
    await expect(run(`UPDATE "ActualCostSettings" SET "postingsOnAt" = NULL WHERE id = $1::uuid`, s.settingsIds.companyA)).rejects.toThrow(/never change while they stay on/)
    await expect(run(`UPDATE "ActualCostSettings" SET "postingsOnAt" = now() WHERE id = $1::uuid`, s.settingsIds.companyA)).rejects.toThrow(/never change while they stay on/)
    await expect(run(`UPDATE "ActualCostSettings" SET "postingsOn" = false WHERE id = $1::uuid`, s.settingsIds.companyA)).rejects.toThrow(/with when \(not in the future\) and the person .* off has neither/)
    await expect(run(`UPDATE "ActualCostSettings" SET "companyId" = NULL WHERE id = $1::uuid`, s.settingsIds.companyA)).rejects.toThrow(/company and creation .* never change/)
  })

  it('are never deleted or truncated, by any login', async () => {
    await expect(run(`DELETE FROM "ActualCostSettings" WHERE id = $1::uuid`, s.settingsIds.tenant)).rejects.toThrow(/permission denied/)
    await expect(admin(`DELETE FROM "ActualCostSettings" WHERE id = $1::uuid`, [s.settingsIds.tenant])).rejects.toThrow(/kept, never deleted/)
    await expect(admin(`TRUNCATE "ActualCostSettings"`)).rejects.toThrow(/TRUNCATE on "ActualCostSettings" is refused/)
  })
})

describe('the closed work order and its ledger (FIN-034)', () => {
  it('a CLOSED work order takes no cost entry but a reversal', async () => {
    await expect(post({ kind: 'ADJUSTMENT', amount: 100, reason: 'Late labour.' })).rejects.toThrow(/is CLOSED; it takes no cost entry but a reversal/)
  })

  it('its close is never deleted; the work order does not go back while the close stands', async () => {
    await expect(admin(`DELETE FROM "WorkOrderClose" WHERE id = $1::uuid`, [s.closeIds.live])).rejects.toThrow(/kept, never deleted/)
    await expect(run(`UPDATE "WorkOrder" SET status = 'COMPLETED', "closedAt" = NULL WHERE id = $1::uuid`, s.workOrderId)).rejects.toThrow(/goes back to COMPLETED only with its close .* undone/)
  })

  it('the close stands: its entries are not reversed, and the close keeps what it says', async () => {
    await expect(post({ kind: 'CLOSE', amount: 50, reversalOfId: s.costEntryIds.close, reason: 'Wrong close.' })).rejects.toThrow(/belongs to close .* which stands; it is reversed only once the close is undone/)
    await expect(run(`UPDATE "WorkOrderClose" SET "actualQuantity" = 1 WHERE id = $1::uuid`, s.closeIds.live)).rejects.toThrow(/keeps what was closed, when and by whom/)
    await expect(run(`UPDATE "WorkOrderClose" SET "reasonNote" = 'x' WHERE id = $1::uuid`, s.closeIds.undone)).rejects.toThrow(/was undone at .* changes no more/)
  })

  it("an undo after 60 seconds is a reopen and says why; the work order goes back only with the close's entries reversed", async () => {
    await expect(run(`UPDATE "WorkOrderClose" SET "undoneAt" = now(), "undoneById" = $2::uuid WHERE id = $1::uuid`, s.closeIds.live, a.actorId)).rejects.toThrow(/a reopen says why \(MES-013/)
    await expect(run(`UPDATE "WorkOrderClose" SET "undoneAt" = now(), "undoneById" = $2::uuid, "reopenReason" = 'no' WHERE id = $1::uuid`, s.closeIds.live, a.actorId)).rejects.toThrow(
      /says why it was reopened \(3 to 1,000 characters\)/,
    )
    // Undone but the work order left CLOSED: refused at the commit.
    await expect(
      inOne([`UPDATE "WorkOrderClose" SET "undoneAt" = now(), "undoneById" = $2::uuid, "reopenReason" = 'A garment came back for repair.' WHERE id = $1::uuid`, s.closeIds.live, a.actorId]),
    ).rejects.toThrow(/is undone, but the work order is still CLOSED by it/)
    // Undone, back to COMPLETED, entries not reversed: refused.
    await expect(
      inOne(
        [`UPDATE "WorkOrderClose" SET "undoneAt" = now(), "undoneById" = $2::uuid, "reopenReason" = 'A garment came back for repair.' WHERE id = $1::uuid`, s.closeIds.live, a.actorId],
        [`UPDATE "WorkOrder" SET status = 'COMPLETED', "closedAt" = NULL WHERE id = $1::uuid`, s.workOrderId],
      ),
    ).rejects.toThrow(/only once the 3 variance and closing entr\(y\/ies\) of its undone close .* are reversed/)
    // The reopen as it is done: undo, reverse the three entries, back to COMPLETED, in one transaction.
    const reversal = (original: string, kind: string, amount: number, item: string | null = null) =>
      entry({ kind, amount, itemId: item, reversalOfId: original, reason: 'The close was reopened.', occurredAt: new Date().toISOString() })
    await inOne(
      [`UPDATE "WorkOrderClose" SET "undoneAt" = now(), "undoneById" = $2::uuid, "reopenReason" = 'A garment came back for repair.' WHERE id = $1::uuid`, s.closeIds.live, a.actorId],
      reversal(s.costEntryIds.usage, 'VARIANCE', 400, leather()),
      reversal(s.costEntryIds.labour, 'VARIANCE', 150),
      reversal(s.costEntryIds.close, 'CLOSE', 50),
      [`UPDATE "WorkOrder" SET status = 'COMPLETED', "closedAt" = NULL WHERE id = $1::uuid`, s.workOrderId],
    )
    expect(await one(`SELECT status::text AS status, (SELECT sum(amount)::int FROM "WorkOrderCostEntry" WHERE "workOrderId" = $1::uuid) AS balance FROM "WorkOrder" WHERE id = $1::uuid`, [s.workOrderId])).toEqual({
      status: 'COMPLETED',
      balance: 600,
    })
  })
})

describe('closing a work order (MES-012, MES-013)', () => {
  it('needs a reason code exactly beyond the tolerance in force, of capitals', async () => {
    await expect(inOne(closeRow({ actualMaterialCost: 9600 }))).rejects.toThrow(/beyond the 5\.0000 % tolerance .* it needs a reason code/)
    await expect(inOne(closeRow({ reasonCode: 'LEATHER_YIELD' }))).rejects.toThrow(/within the 5\.0000 % tolerance: it takes no reason code/)
    await expect(inOne(closeRow({ scrapQuantity: 1 }))).rejects.toThrow(/it needs a reason code/)
    await expect(inOne(closeRow({ actualMaterialCost: 9600, reasonCode: 'leather yield' }))).rejects.toThrow(/reason code of capitals, digits and underscores/)
    await expect(inOne(closeRow({ tolerancePct: '10', actualMaterialCost: 9600 }))).rejects.toThrow(/close tolerance in force \(5\.0000 %\), not 10(\.0+)? %/)
  })

  it('goes with the work order CLOSED at its time, in the same transaction', async () => {
    await expect(inOne(closeRow({}))).rejects.toThrow(/a live close goes with the work order CLOSED at its time/)
  })

  it('a close, its split and its entries, settled; one live close; the Undo within 60 seconds by the person who closed it', async () => {
    const closeId = randomUUID()
    const varianceId = randomUUID()
    const closedAt = new Date().toISOString()
    const variance = (amount: number, id = varianceId): [string, ...unknown[]] => [
      `INSERT INTO "WorkOrderVariance" (id, "companyId", "siteId", "workOrderId", "closeId", category, "itemId", amount) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'MATERIAL_PRICE', $6::uuid, $7)`,
      id,
      companyA(),
      siteA(),
      s.workOrderId,
      closeId,
      leather(),
      amount,
    ]
    // The closing entry must leave 0: 600 − 500 (the variance) = 100, not 90.
    await expect(
      inOne(
        closeRow({ id: closeId, closedAt }),
        variance(500),
        entry({ kind: 'VARIANCE', amount: -500, itemId: leather(), sourceType: 'WorkOrderVariance', sourceId: varianceId, occurredAt: closedAt }),
        entry({ kind: 'CLOSE', amount: -90, sourceType: 'WorkOrderClose', sourceId: closeId, occurredAt: closedAt }),
        [`UPDATE "WorkOrder" SET status = 'CLOSED', "closedAt" = $2::timestamptz WHERE id = $1::uuid`, s.workOrderId, closedAt],
      ),
    ).rejects.toThrow(/leaves 10 on work order .* takes off what is left after the variances \(-100\)/)
    await expect(
      inOne(closeRow({ id: closeId, closedAt }), variance(500), entry({ kind: 'VARIANCE', amount: 500, itemId: leather(), sourceType: 'WorkOrderVariance', sourceId: varianceId, occurredAt: closedAt })),
    ).rejects.toThrow(/the opposite of its amount \(-500\)/)
    await expect(inOne(closeRow({ id: closeId, closedAt }), variance(500), entry({ kind: 'VARIANCE', amount: -500, sourceType: 'WorkOrderVariance', sourceId: varianceId, occurredAt: closedAt }))).rejects.toThrow(
      /its material, no quantity/,
    )
    await expect(inOne(closeRow({ id: closeId, closedAt }), [variance(500)[0].replace("'MATERIAL_PRICE'", "'LABOUR_RATE'"), ...variance(500).slice(1)])).rejects.toThrow(/names no material: only a material price/)
    await inOne(
      closeRow({ id: closeId, closedAt }),
      variance(500),
      entry({ kind: 'VARIANCE', amount: -500, itemId: leather(), sourceType: 'WorkOrderVariance', sourceId: varianceId, occurredAt: closedAt }),
      entry({ kind: 'CLOSE', amount: -100, sourceType: 'WorkOrderClose', sourceId: closeId, occurredAt: closedAt }),
      [`UPDATE "WorkOrder" SET status = 'CLOSED', "closedAt" = $2::timestamptz WHERE id = $1::uuid`, s.workOrderId, closedAt],
    )
    // Settled: a second close, a late variance entry, a late entry of any kind.
    await expect(inOne(closeRow({}))).rejects.toThrow(/is CLOSED; a work order is closed once it is COMPLETED/)
    await expect(post({ kind: 'VARIANCE', amount: -1, sourceType: 'WorkOrderVariance', sourceId: varianceId, occurredAt: closedAt })).rejects.toThrow(/is CLOSED; it takes no cost entry but a reversal/)
    // The variance split and the ledger are append-only.
    await expect(run(`UPDATE "WorkOrderVariance" SET amount = 1 WHERE id = $1::uuid`, varianceId)).rejects.toThrow(/permission denied/)
    await expect(admin(`UPDATE "WorkOrderVariance" SET amount = 1 WHERE id = $1::uuid`, [varianceId])).rejects.toThrow(/append-only: UPDATE on "WorkOrderVariance" is refused/)
    await expect(admin(`TRUNCATE "WorkOrderVariance"`)).rejects.toThrow(/append-only: TRUNCATE on "WorkOrderVariance" is refused/)
    // The Undo: by the person who closed it, within 60 seconds, no reason; its entries reversed; back to COMPLETED.
    const [variancePost] = (await admin(`SELECT id FROM "WorkOrderCostEntry" WHERE "sourceId" = $1::uuid`, [varianceId])) as { id: string }[]
    const [closePost] = (await admin(`SELECT id FROM "WorkOrderCostEntry" WHERE "sourceId" = $1::uuid`, [closeId])) as { id: string }[]
    await inOne(
      [`UPDATE "WorkOrderClose" SET "undoneAt" = now(), "undoneById" = $2::uuid WHERE id = $1::uuid`, closeId, a.actorId],
      entry({ kind: 'VARIANCE', amount: 500, itemId: leather(), reversalOfId: variancePost!.id, reason: 'Undo.' }),
      entry({ kind: 'CLOSE', amount: 100, reversalOfId: closePost!.id, reason: 'Undo.' }),
      [`UPDATE "WorkOrder" SET status = 'COMPLETED', "closedAt" = NULL WHERE id = $1::uuid`, s.workOrderId],
    )
    // An undone close takes no variance, and its entries no repeat.
    await expect(inOne(variance(10, randomUUID()))).rejects.toThrow(/was undone at .* takes no variance/)
  })

  it('refuses a close of a work order that is not COMPLETED, and a second live close', async () => {
    const closedAt = new Date().toISOString()
    const first = randomUUID()
    await expect(
      inOne(closeRow({ id: first, closedAt }), closeRow({ closedAt }), [`UPDATE "WorkOrder" SET status = 'CLOSED', "closedAt" = $2::timestamptz WHERE id = $1::uuid`, s.workOrderId, closedAt]),
    ).rejects.toThrow(/has a live close already; undo it first/)
    // A close may be written undone (history) without touching the work order.
    expect(await run(...closeRow({ closedAt: '2026-11-01T08:00:00.000Z', undoneAt: '2026-11-01T08:00:10.000Z', undoneById: a.actorId }))).toBe(1)
  })
})

describe("the switch for the accountant's figures (GATE-ACCOUNTANT)", () => {
  it('while off: no variance, no variance or closing entry, no purchase price variance, no cost of goods sold, no posted landed cost', async () => {
    await switchTo(false)
    try {
      const closedAt = new Date().toISOString()
      const closeId = randomUUID()
      await expect(
        inOne(closeRow({ id: closeId, closedAt }), [
          `INSERT INTO "WorkOrderVariance" (id, "companyId", "siteId", "workOrderId", "closeId", category, amount) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'OVERHEAD', 600)`,
          randomUUID(),
          companyA(),
          siteA(),
          s.workOrderId,
          closeId,
        ]),
      ).rejects.toThrow(/switched off \(GATE-ACCOUNTANT\): the variance split of close/)
      await expect(inOne(closeRow({ id: closeId, closedAt }), entry({ kind: 'CLOSE', amount: -600, sourceType: 'WorkOrderClose', sourceId: closeId, occurredAt: closedAt }))).rejects.toThrow(
        /switched off \(GATE-ACCOUNTANT\): the closing entry/,
      )
      // The close itself does not wait for the switch.
      await inOne(closeRow({ id: closeId, closedAt }), [`UPDATE "WorkOrder" SET status = 'CLOSED', "closedAt" = $2::timestamptz WHERE id = $1::uuid`, s.workOrderId, closedAt])
      await expect(
        run(
          `INSERT INTO "PurchasePriceVariance" (id, "companyId", "partyId", at, "supplierInvoiceLineId", "itemId", quantity, "standardUnitCost", "paidUnitCost", "differenceAmount", "postedAt", "idempotencyKey")
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'INVOICE', $4::uuid, $5::uuid, 105, 4.2, 4.3, 1050, now(), $6)`,
          randomUUID(),
          companyA(),
          key('party:P2'),
          s.accounting.supplierLineIds.leather,
          leather(),
          `ppv:${randomUUID()}`,
        ),
      ).rejects.toThrow(/switched off \(GATE-ACCOUNTANT\): purchase price variance/)
      await expect(
        run(
          `INSERT INTO "CostOfSalesEntry" (id, "companyId", "partyId", "siteId", "shipmentLineId", quantity, "materialAmount", amount, "postedAt", "idempotencyKey")
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1, 100, 100, now(), $6)`,
          randomUUID(),
          companyA(),
          key('party:P1'),
          siteA(),
          s.accounting.money.shipping.lineIds[0],
          `cogs:${randomUUID()}`,
        ),
      ).rejects.toThrow(/switched off \(GATE-ACCOUNTANT\): cost of goods sold/)
      await expect(run(`UPDATE "LandedCostAllocation" SET status = 'POSTED', "postedAt" = now(), "postedById" = $2::uuid WHERE id = $1::uuid`, s.landedIds.draft, a.actorId)).rejects.toThrow(
        /switched off \(GATE-ACCOUNTANT\): landed cost/,
      )
      // A reversal waits for no switch.
      expect(
        await run(
          `INSERT INTO "CostOfSalesEntry" (id, "companyId", "partyId", "siteId", "shipmentLineId", quantity, "materialAmount", "labourAmount", "overheadAmount", amount, "postedAt", "reversalOfId", reason, "idempotencyKey")
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, -1, -9800, -4300, -700, -14800, now(), $6::uuid, 'Shipped by mistake.', $7)`,
          randomUUID(),
          companyA(),
          key('party:P1'),
          siteA(),
          s.accounting.money.shipping.lineIds[0],
          s.cogsIds.black,
          `cogs:reversal:${s.cogsIds.black}`,
        ),
      ).toBe(1)
    } finally {
      await switchTo(true)
    }
  })
})

describe('purchase price variance (FIN-031)', () => {
  const ppv = (columns: Record<string, unknown>) =>
    run(
      ...insertOf('PurchasePriceVariance', {
        id: randomUUID(),
        companyId: companyA(),
        partyId: key('party:P2'),
        at: 'INVOICE',
        supplierInvoiceLineId: s.accounting.supplierLineIds.leather,
        itemId: leather(),
        quantity: '105',
        standardUnitCost: '4.2',
        paidUnitCost: '4.3',
        differenceAmount: 1050,
        currency: 'EUR',
        postedAt: new Date().toISOString(),
        idempotencyKey: `ppv:${randomUUID()}`,
        ...columns,
      }),
    )

  it('is quantity × (paid − standard), on a GOODS line, where the company takes it', async () => {
    await expect(ppv({ differenceAmount: 1000 })).rejects.toThrow(/105\.0000 × \(4\.300000 − 4\.200000\) = 1050 minor units, not 1000/)
    await expect(ppv({ supplierInvoiceLineId: s.accounting.supplierLineIds.freight })).rejects.toThrow(/of a GOODS line \(this one: CHARGE\)/)
    await expect(ppv({ at: 'RECEIPT', supplierInvoiceLineId: null, siteId: siteA(), receiptLineId: s.accounting.money.shipping.quality.production.inventory.receiptLineId })).rejects.toThrow(
      /takes its purchase price variance at the invoice, not at the receipt/,
    )
    await expect(ppv({ at: 'RECEIPT' })).rejects.toThrow(/names exactly its source/)
  })

  it('is reversed once, exactly, with why; never changed', async () => {
    const reversal = { reversalOfId: s.ppvId, quantity: '-105', differenceAmount: -1050, standardCostId: s.accounting.standardCostIds.leather, idempotencyKey: `ppv:reversal:${s.ppvId}` }
    await expect(ppv({ ...reversal, reason: 'no' })).rejects.toThrow(/says why \(3 to 1,000 characters\)/)
    await expect(ppv({ ...reversal, differenceAmount: -1000, reason: 'Wrong price.' })).rejects.toThrow(/takes back purchase price variance .* exactly/)
    expect(await ppv({ ...reversal, reason: 'The supplier sent a credit note for the price.' })).toBe(1)
    await expect(ppv({ ...reversal, idempotencyKey: `ppv:${randomUUID()}`, reason: 'Again.' })).rejects.toThrow(/is reversed already/)
    await expect(admin(`UPDATE "PurchasePriceVariance" SET reason = 'x' WHERE id = $1::uuid`, [s.ppvId])).rejects.toThrow(/append-only: UPDATE on "PurchasePriceVariance"/)
    await expect(admin(`DELETE FROM "PurchasePriceVariance" WHERE id = $1::uuid`, [s.ppvId])).rejects.toThrow(/append-only: DELETE on "PurchasePriceVariance"/)
  })
})

describe('cost of goods sold (FIN-043)', () => {
  const cogs = (columns: Record<string, unknown>) =>
    run(
      ...insertOf('CostOfSalesEntry', {
        id: randomUUID(),
        companyId: companyA(),
        partyId: key('party:P1'),
        siteId: siteA(),
        shipmentLineId: s.accounting.money.shipping.lineIds[1],
        quantity: '1',
        materialAmount: 100,
        labourAmount: 0,
        subcontractAmount: 0,
        overheadAmount: 0,
        amount: 100,
        currency: 'EUR',
        postedAt: new Date().toISOString(),
        idempotencyKey: `cogs:${randomUUID()}`,
        ...columns,
      }),
    )

  it('adds up by category, names one source, of a shipment that left, for its garments', async () => {
    await expect(cogs({ amount: 90 })).rejects.toThrow(/sum of its material, labour, subcontract and overhead \(100\), not 90/)
    await expect(cogs({ invoiceLineId: randomUUID() })).rejects.toThrow(/names exactly one source/)
    await expect(cogs({ quantity: '2' })).rejects.toThrow(/that left \(this one is SHIPPED\), for its 1 garment/)
    await expect(cogs({ shipmentLineId: s.accounting.money.shipping.draftLineId })).rejects.toThrow(/that left \(this one is DRAFT\)/)
    await expect(cogs({ quantity: '-1', materialAmount: -100, amount: -100 })).rejects.toThrow(/a quantity above 0 and amounts of 0 or more/)
  })

  it('is reversed once, exactly; never changed or removed', async () => {
    await expect(cogs({ reversalOfId: s.cogsIds.red, quantity: '-1', materialAmount: -9600, labourAmount: -4200, overheadAmount: -700, amount: -14500, reason: 'Again.' })).rejects.toThrow(/is reversed already/)
    await expect(cogs({ reversalOfId: s.cogsIds.redReversal, quantity: '1', materialAmount: 9600, labourAmount: 4200, overheadAmount: 700, amount: 14500, reason: 'Undo the undo.' })).rejects.toThrow(/never a reversal/)
    await expect(admin(`DELETE FROM "CostOfSalesEntry" WHERE id = $1::uuid`, [s.cogsIds.red])).rejects.toThrow(/append-only: DELETE on "CostOfSalesEntry"/)
    await expect(run(`DELETE FROM "CostOfSalesEntry" WHERE id = $1::uuid`, s.cogsIds.red)).rejects.toThrow(/permission denied/)
  })
})

describe('landed cost (FIN-044)', () => {
  const share = (allocationId: string, amount: number, columns: Record<string, unknown> = {}) =>
    run(
      ...insertOf('LandedCostShare', {
        id: randomUUID(),
        allocationId,
        siteId: siteA(),
        itemId: leather(),
        lotId: lot(),
        key: `share:${allocationId}:${lot()}`,
        basisAmount: '1',
        amount,
        ...columns,
      }),
    )

  it('is born a DRAFT, of a CHARGE line for its net amount', async () => {
    const insert = (status: string, line: string, amount: number) =>
      run(
        `INSERT INTO "LandedCostAllocation" (id, "companyId", "partyId", "supplierInvoiceLineId", basis, amount, status) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'WEIGHT', $5, $6::"LandedCostStatus")`,
        randomUUID(),
        companyA(),
        key('party:P2'),
        line,
        amount,
        status,
      )
    await expect(insert('POSTED', s.accounting.supplierLineIds.freight, 1500)).rejects.toThrow(/starts as a DRAFT, not POSTED/)
    await expect(insert('DRAFT', s.accounting.supplierLineIds.leather, 45150)).rejects.toThrow(/lands a CHARGE line \(this one: GOODS\)/)
    await expect(insert('DRAFT', s.accounting.supplierLineIds.freight, 1400)).rejects.toThrow(/for its net amount \(1500\)/)
  })

  it('is posted with its shares adding up, one POSTED per line; its shares only while DRAFT; reversed with why', async () => {
    const post = () => run(`UPDATE "LandedCostAllocation" SET status = 'POSTED', "postedAt" = now(), "postedById" = $2::uuid WHERE id = $1::uuid`, s.landedIds.draft, a.actorId)
    await expect(share(s.landedIds.draft, 1, { key: 'share:wrong' })).rejects.toThrow(/has the key "share:/)
    expect(await share(s.landedIds.draft, 10, { key: `share:${s.landedIds.draft}:${lot()}-second` })).toBe(1)
    await expect(post()).rejects.toThrow(/shares adding up to its amount \(1500\): 2 share\(s\) add up to 1510/)
    await run(`DELETE FROM "LandedCostShare" WHERE "allocationId" = $1::uuid AND key LIKE '%-second'`, s.landedIds.draft)
    expect(await post()).toBe(1)
    await expect(share(s.landedIds.draft, 0, { key: `share:${s.landedIds.draft}:${lot()}-third` })).rejects.toThrow(/is POSTED; its shares are written, changed and removed only while it is a DRAFT/)
    await expect(run(`DELETE FROM "LandedCostAllocation" WHERE id = $1::uuid`, s.landedIds.draft)).rejects.toThrow(/only a DRAFT is deleted/)
    await expect(run(`UPDATE "LandedCostAllocation" SET basis = 'VALUE' WHERE id = $1::uuid`, s.landedIds.draft)).rejects.toThrow(/is POSTED; nothing but its reversal/)
    // A second POSTED allocation of the same charge line.
    const second = randomUUID()
    await run(
      `INSERT INTO "LandedCostAllocation" (id, "companyId", "partyId", "supplierInvoiceLineId", basis, amount) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'WEIGHT', 1500)`,
      second,
      companyA(),
      key('party:P2'),
      s.accounting.supplierLineIds.freight,
    )
    expect(await share(second, 1500, { key: `share:${second}:${lot()}` })).toBe(1)
    await expect(run(`UPDATE "LandedCostAllocation" SET status = 'POSTED', "postedAt" = now(), "postedById" = $2::uuid WHERE id = $1::uuid`, second, a.actorId)).rejects.toThrow(
      /LandedCostAllocation_one_posted|duplicate key/,
    )
    await expect(run(`UPDATE "LandedCostAllocation" SET status = 'REVERSED', "reversedAt" = now(), "reversedById" = $2::uuid WHERE id = $1::uuid`, s.landedIds.draft, a.actorId)).rejects.toThrow(
      /reversed exactly when REVERSED/,
    )
    expect(
      await run(`UPDATE "LandedCostAllocation" SET status = 'REVERSED', "reversedAt" = now(), "reversedById" = $2::uuid, "reverseReason" = 'Weight is the basis.' WHERE id = $1::uuid`, s.landedIds.draft, a.actorId),
    ).toBe(1)
    // A DRAFT is deleted once its shares are gone.
    await expect(run(`DELETE FROM "LandedCostAllocation" WHERE id = $1::uuid`, second)).rejects.toThrow(/still has shares; remove them first/)
    await run(`DELETE FROM "LandedCostShare" WHERE "allocationId" = $1::uuid`, second)
    expect(await run(`DELETE FROM "LandedCostAllocation" WHERE id = $1::uuid`, second)).toBe(1)
    await expect(admin(`TRUNCATE "LandedCostShare"`)).rejects.toThrow(/TRUNCATE on "LandedCostShare" is refused/)
  })
})
