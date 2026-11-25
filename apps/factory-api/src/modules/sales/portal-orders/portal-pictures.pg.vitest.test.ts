import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedShipping } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld, type PortalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Browser, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * pg-s2 S2.1 — the picture read of Portal › Orders (POST /portal/sales-orders/pictures; portal grid D4, Z12, H6; 15-steps GAP-3: the
 * brand-wall sweep T02 calls GETs only, so this read-POST has its own two-brand test, as T08 and T37 have for unread). Through the
 * real app and the real portal sign-in by code, on the factory-db seeds up to shipping (Brand A = the seeded customer SEED-C1, its
 * style SEED-JKT-01 its private label; Brand B = another customer). Each brand gets orders and pictures of its own, written with the
 * database's rules off (the read is what is tested here). Every name and number is made up.
 *
 *   - A gets its own orders' pictures, in the asked order: the first GOODS line's (a fee line first is skipped), its distinct styles
 *     counted, `fileId` always null, never the original's name or storage key; `small` null while no preview exists.
 *   - A asking with B's ids (or an unknown one) gets nothing for them — absent, no error, no count; the same the other way.
 *   - a picture whose content was copied from another customer's file is left out (the content wall), in the same shape.
 *   - the body: 1–200 ids, each once; a role without portal.salesOrders.view is refused; the office picture routes refuse a portal
 *     session.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/portal-orders`.
 */

let h: Harness
let tenant: TestTenant
let world: PortalWorld
const NS = 'portal-order-pictures'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!

const people = { a: 'ada.buyer@seed-racing.example', designer: 'dino.designer@seed-racing.example', b: 'bea.buyer@other-brand.example' }
const browsers = {} as Record<keyof typeof people, Browser>

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<void> {
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    const id = newId()
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const key of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [partyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
}

async function signedIn(email: string): Promise<Browser> {
  const browser = await portalBrowser(h)
  h.clock.advance(61_000)
  expect((await browser.post('/portal/signin/start', { tenant: NS, company: 'SCA', email })).status).toBe(200)
  await h.auth.settled()
  const answer = await browser.post('/portal/signin/code', { tenant: NS, company: 'SCA', email, code: mailedCode(h, email)!.code })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const terms = await browser.get('/portal/terms?locale=en')
  expect((await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
  return browser
}

/** The pictures of these orders as `who` reads them (200), or the answer's status. */
async function pictures(who: keyof typeof people, orderIds: unknown, status = 200): Promise<Json> {
  const answer = await browsers[who].post('/portal/sales-orders/pictures', { orderIds })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

// ---- the rows, written with the database's rules off (replica): the read is what is tested ------------------------------------

async function planted(rows: readonly { readonly sql: string; readonly values: unknown[] }[]): Promise<void> {
  await h.db.admin.query('BEGIN')
  try {
    await h.db.admin.query("SET LOCAL session_replication_role = 'replica'")
    for (const row of rows) await h.db.admin.query(row.sql, row.values)
    await h.db.admin.query('COMMIT')
  } catch (error) {
    await h.db.admin.query('ROLLBACK')
    throw error
  }
}
const copyOf = (table: string, from: string, over: Json) => ({ sql: `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, values: [JSON.stringify(over), from] })

const seeded = { order: '', line: '', style: '', store: '' }

/** A style of a brand (a copy of SEED-JKT-01 under its own code). */
async function style(code: string, brandPartyId: string): Promise<string> {
  const id = newId()
  await planted([copyOf('Style', seeded.style, { id, code, name: `Made-up ${code}`, brandPartyId })])
  return id
}

/** An order of the party with these lines (kind, style, colourway), in this order; a copy of the seeded order and line. */
async function order(partyId: string, number: string, seq: number, lines: readonly { readonly kind: 'SIZE_GRID' | 'FEE'; readonly styleId: string; readonly colourwayId: string }[]): Promise<string> {
  const id = newId()
  await planted([
    copyOf('SalesOrder', seeded.order, { id, partyId, number, customerSeq: seq, customerRef: `PO-${number}`, status: 'CONFIRMED', quoteVersionId: null, reapprovalNeededAt: null, internalNote: null, billTo: { name: 'Made-up' }, shipTo: { name: 'Made-up' }, version: 1 }),
    ...lines.map((line, index) =>
      copyOf('SalesOrderLine', seeded.line, { id: newId(), orderId: id, partyId, seq: (index + 1) * 10, kind: line.kind, styleId: line.styleId, colourwayId: line.colourwayId, quoteLineId: null, measurementProfileId: null, feeCreditOrderId: null, closedShortQuantity: null, closedShortAt: null }),
    ),
  ])
  return id
}

/** A picture as the office keeps it (a Style file, office only, no small preview yet) of a style's colourway, or its main one. */
async function picture(styleId: string, colourwayId: string | null, name: string, sourceFileId: string | null = null): Promise<string> {
  const fileId = newId()
  await planted([
    {
      sql: `INSERT INTO "StoredFile" (id, "tenantId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256, "storeAccountId", "storageKey", status, visibility, "sourceFileId") VALUES ($1, $2, 'Style', $3, 'PHOTO', $4, 'image/jpeg', 2400, repeat('0', 64), $5, $6, 'AVAILABLE', '{OFFICE}', $7)`,
      values: [fileId, T, styleId, name, seeded.store, `test/${fileId}`, sourceFileId],
    },
    { sql: `INSERT INTO "StyleImage" (id, "tenantId", "styleId", "colourwayId", "fileId", kind, seq, "isMain") VALUES ($1, $2, $3, $4, $5, 'PHOTO', 0, $6)`, values: [newId(), T, styleId, colourwayId, fileId, colourwayId === null] },
  ])
  return fileId
}

beforeAll(async () => {
  h = await startHarness('portal_order_pictures')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedShipping({ db: h.database, namespace: NS })
  tenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    // The portal's sign-in mail sender (as tenant set-up makes it): a FAKE SES account and company A's NOTIFICATION identity.
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses-portal', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${NS}.example.com`
    await client.emailIdentity.create({
      data: { id: newId(), companyId: companyA, kind: 'NOTIFICATION', domain, fromAddress: `noreply@${domain}`, displayName: 'Seed A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${NS}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
    await client.portalSettings.create({ data: { id: P1, partyId: P1, portalOn: true }, select: { id: true } })
  })
  // Company A's portal terms and Brand B (another customer, no orders) with its portal on.
  world = await portalWorld(h, tenant)
  freshGuard(h)
  await partnerPerson(people.a, P1, ['customer-buyer'])
  await partnerPerson(people.designer, P1, ['customer-designer'])
  await partnerPerson(people.b, world.partyId, ['customer-buyer'])
  for (const key of Object.keys(people) as (keyof typeof people)[]) browsers[key] = await signedIn(people[key])
  seeded.order = (await one<{ id: string }>('SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = $2', [T, 'SEED-SO-0001'])).id
  seeded.line = (await one<{ id: string }>(`SELECT id FROM "SalesOrderLine" WHERE "orderId" = $1 AND kind <> 'FEE' ORDER BY seq LIMIT 1`, [seeded.order])).id
  seeded.style = (await one<{ id: string }>('SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = $2', [T, 'SEED-JKT-01'])).id
  seeded.store = (await one<{ id: string }>('SELECT id::text AS id FROM "IntegrationAccount" WHERE "tenantId" = $1 LIMIT 1', [T])).id
}, 240_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

describe('pg-s2 S2.1 the pictures of Portal › Orders: the customer’s own orders only (GAP-3)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const w = { a1: '', a2: '', b1: '', fileA1: '', fileA2: '', fileB1: '', betaSource: '', styleA2: '', styleB: '' }
  const colour = { a1: newId(), a2: newId(), walled: newId(), b1: newId(), fee: newId() }

  beforeAll(async () => {
    w.styleA2 = await style('TPG-A-JKT-2', P1)
    w.styleB = await style('TPG-B-JKT', world.partyId)
    // A1: a fee line first (skipped), then SEED-JKT-01 in its own colourway (its picture), then a second style of A's.
    w.a1 = await order(P1, 'TPG-SO-A-PIC1', 951, [
      { kind: 'FEE', styleId: w.styleA2, colourwayId: colour.fee },
      { kind: 'SIZE_GRID', styleId: seeded.style, colourwayId: colour.a1 },
      { kind: 'SIZE_GRID', styleId: w.styleA2, colourwayId: colour.a2 },
    ])
    w.fileA1 = await picture(seeded.style, colour.a1, 'TPG front A1.jpg')
    // A2: SEED-JKT-01 in a colourway whose only picture is a copy of Brand B's own file (the content wall leaves it out).
    w.betaSource = newId()
    await planted([
      {
        sql: `INSERT INTO "StoredFile" (id, "tenantId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256, "storeAccountId", "storageKey", status, visibility) VALUES ($1, $2, 'Party', $3, 'PHOTO', 'TPG beta source.jpg', 'image/jpeg', 2400, repeat('0', 64), $4, $5, 'AVAILABLE', '{OFFICE}')`,
        values: [w.betaSource, T, world.partyId, seeded.store, `test/${w.betaSource}`],
      },
    ])
    w.a2 = await order(P1, 'TPG-SO-A-PIC2', 952, [{ kind: 'SIZE_GRID', styleId: seeded.style, colourwayId: colour.walled }])
    w.fileA2 = await picture(seeded.style, colour.walled, 'TPG walled copy.jpg', w.betaSource)
    // B1: Brand B's own style, with its main picture.
    w.b1 = await order(world.partyId, 'TPG-SO-B-PIC1', 951, [{ kind: 'SIZE_GRID', styleId: w.styleB, colourwayId: colour.b1 }])
    w.fileB1 = await picture(w.styleB, null, 'TPG front B1.jpg')
  })

  it('A gets its own orders’ pictures in the asked order: the first goods line’s, its styles counted, never a file id', async () => {
    const unknown = newId()
    const answer = await pictures('a', [w.a2, unknown, w.a1])
    expect(answer.pictures).toEqual([
      // A2's only picture is walled: the order is there, its picture not (the part draws its placeholder).
      { id: w.a2, styleId: seeded.style, styleCode: 'SEED-JKT-01', styleName: expect.any(String), styleCount: 1, fileId: null, contentType: null, small: null },
      // The fee line is skipped; two goods styles; no small preview made yet.
      { id: w.a1, styleId: seeded.style, styleCode: 'SEED-JKT-01', styleName: expect.any(String), styleCount: 2, fileId: null, contentType: 'image/jpeg', small: null },
    ])
    expect(typeof answer.asOf).toBe('string')
    const text = JSON.stringify(answer)
    for (const word of [w.fileA1, w.fileA2, w.betaSource, 'TPG front', 'TPG walled', 'TPG beta', 'test/', unknown]) expect(text, word).not.toContain(word)
  })

  it('A asking with B’s ids gets nothing for them (absent, no error); B reads its own; the same the other way', async () => {
    expect((await pictures('a', [w.b1])).pictures).toEqual([])
    expect((await pictures('a', [w.b1, w.a1])).pictures.map((row: Json) => row.id)).toEqual([w.a1])
    const theirs = await pictures('b', [w.b1, w.a1, w.a2])
    expect(theirs.pictures).toEqual([{ id: w.b1, styleId: w.styleB, styleCode: 'TPG-B-JKT', styleName: 'Made-up TPG-B-JKT', styleCount: 1, fileId: null, contentType: 'image/jpeg', small: null }])
    const text = JSON.stringify(theirs)
    for (const word of [w.a1, w.a2, w.fileA1, 'SEED-JKT', 'TPG-A-']) expect(text, word).not.toContain(word)
    expect(JSON.stringify(await pictures('a', [w.b1]))).not.toMatch(/TPG-B-|TPG front B1/)
  })

  it('the body: 1–200 ids, each once; a role without the orders’ view is refused; the office picture routes refuse a portal session', async () => {
    await pictures('a', [], 400)
    await pictures('a', [w.a1, w.a1], 400)
    await pictures('a', Array.from({ length: 201 }, () => newId()), 400)
    await pictures('a', ['not-an-id'], 400)
    await pictures('designer', [w.a1], 403)
    for (const [url, body] of [
      ['/sales/orders/pictures', { orderIds: [w.a1] }],
      ['/sales/quotes/pictures', { quoteIds: [w.a1] }],
      ['/sales/inquiries/pictures', { inquiryIds: [w.a1] }],
      ['/sales/order-requests/pictures', { requestIds: [w.a1] }],
      ['/production/work-orders/pictures', { workOrderIds: [w.a1] }],
    ] as const) {
      const answer = await browsers.a.post(url, body)
      expect(answer.status, url).toBeGreaterThanOrEqual(400)
      expect(JSON.stringify(answer.body), url).not.toContain(w.fileA1)
    }
  })
})
