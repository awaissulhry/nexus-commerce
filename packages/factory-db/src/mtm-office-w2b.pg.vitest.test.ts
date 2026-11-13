import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedMtmOffice, type MtmOfficeSeed } from '../seed/mtm-office'
import { seed as seedPortalSales } from '../seed/portal-sales'
import { seed as seedSales, type SalesSeed } from '../seed/sales'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * The made-to-measure office (W2b-5, schema wave 44/44, B-W2b-297, …_mtm_office_w2b_guards) on a database built from the
 * migrations and seeded twice, through the real login and the scoped client:
 *   - the factory review of a measurement profile revision: born WAITING, WAITING → CONFIRMED | NEED_MORE, NEED_MORE again
 *     or CONFIRMED, CONFIRMED final, who and when, the words to ask for more, never confirmed by the person who measured;
 *     who of ours measured (an office person, never on a link send) and where, given once; the portal reads the review's
 *     status and words, never who;
 *   - appointments: booked first, closed once (DONE and MISSED once started, CANCELLED with why), frozen but the notes and
 *     the revision a DONE one led to, a fitting of a revision, a DONE one with who was there, the rider of the profile;
 *   - fitting results: of a fitting or a made-to-measure order line of the fitted revision, the point changes in the
 *     profile's points and units, OK | ALTER | REMAKE, written once but the alteration (an ALTERATION repair) and the new
 *     revision, named once each;
 *   - a MADE_TO_MEASURE quote or order line only of a style flagged made-to-measure (PRD-017);
 *   - the MTM worksheet a generated document of a MeasurementProfile;
 *   - nothing here for the portal or the floor, nothing deleted.
 * The refusals are check_violation (23514); their messages are read through raw SQL.
 */

const NS = 'w2b-297-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: MtmOfficeSeed
let sales: SalesSeed

const key = (name: string): string => seedUuid(NS, name)
const SITE_A1 = key('site:A1')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: SITE_A1 })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId: s.partyIds.P1 })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyText = (table: string) => `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) => run(scope, copyText(table), JSON.stringify(changes), id)
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()
const later = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString()

beforeAll(async () => {
  db = await migratedDatabase('mtmofficew2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  sales = await seedSales({ db: factory, namespace: NS })
  // P1's JACKET revision 2, the one its rider sent by link (the first row of MeasurementProfile).
  await seedPortalSales({ db: factory, namespace: NS })
  s = await seedMtmOffice({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent.
  await seedMtmOffice({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the factory review of a measurement profile revision (SAL-291, SAL-292)', () => {
  /** A new revision of P1's TROUSERS (measured by the member in the showroom), WAITING. */
  const newRevision = async (changes: Record<string, unknown> = {}): Promise<string> => {
    const id = randomUUID()
    const [{ next }] = (await admin(`SELECT max(revision) + 1 AS next FROM "MeasurementProfile" WHERE "riderName" = 'Seed Team Rider' AND "garmentType" = 'TROUSERS' AND "partyId" = $1::uuid`, [s.partyIds.P1])) as [{ next: number }]
    expect(await copyRow(office(), 'MeasurementProfile', s.profileIds.p1Trousers1, { id, revision: next, supersedesId: null, ...changes })).toBe(1)
    return id
  }

  it('is born WAITING, unreviewed, also when the office types it', async () => {
    await expect(newRevision({ reviewStatus: 'CONFIRMED', reviewedAt: ago(5), reviewedById: s.ownerId })).rejects.toThrow(/starts WAITING/)
    const rows = await sql(office(), `SELECT "reviewStatus"::text AS status, "measuredPlace" AS place FROM "MeasurementProfile" WHERE id = $1::uuid`, await newRevision())
    expect(rows[0]).toEqual({ status: 'WAITING', place: 'Seed showroom' })
  })

  it('is never confirmed by the person who measured (Q3), but they may ask for more', async () => {
    const revision = await newRevision()
    await expect(update(office(), 'MeasurementProfile', revision, `"reviewStatus" = 'CONFIRMED', "reviewedAt" = now(), "reviewedById" = $2::uuid`, s.memberId)).rejects.toThrow(/someone else confirms it/)
    expect(await update(office(), 'MeasurementProfile', revision, `"reviewStatus" = 'NEED_MORE', "reviewedAt" = now(), "reviewedById" = $2::uuid, "reviewNote" = 'Check the inseam again'`, s.memberId)).toBe(1)
    // Asked again, with other words; then confirmed by the owner, and final.
    expect(await update(office(), 'MeasurementProfile', revision, `"reviewNote" = 'Check the inseam again, standing', "reviewedAt" = now()`)).toBe(1)
    expect(await update(office(), 'MeasurementProfile', revision, `"reviewStatus" = 'CONFIRMED', "reviewedAt" = now(), "reviewedById" = $2::uuid, "reviewNote" = NULL`, s.ownerId)).toBe(1)
    await expect(update(office(), 'MeasurementProfile', revision, `"reviewNote" = 'Changed my mind'`)).rejects.toThrow(/is CONFIRMED/)
  })

  it('asks for more only in words, with who and when, at a time that makes sense', async () => {
    const revision = await newRevision()
    await expect(update(office(), 'MeasurementProfile', revision, `"reviewStatus" = 'NEED_MORE', "reviewedAt" = now(), "reviewedById" = $2::uuid`, s.ownerId)).rejects.toThrow(/to ask for more/)
    await expect(update(office(), 'MeasurementProfile', revision, `"reviewStatus" = 'CONFIRMED', "reviewedAt" = now()`)).rejects.toThrow(/exactly with who reviewed it and when/)
    await expect(update(office(), 'MeasurementProfile', revision, `"reviewNote" = 'A note before any review'`)).rejects.toThrow(/come with the review/)
    await expect(update(office(), 'MeasurementProfile', revision, `"reviewStatus" = 'CONFIRMED', "reviewedAt" = $2::timestamptz, "reviewedById" = $3::uuid`, later(60), s.ownerId)).rejects.toThrow(/not in the future/)
    await expect(update(office(), 'MeasurementProfile', revision, `"reviewStatus" = 'CONFIRMED', "reviewedAt" = '2026-01-01T00:00:00Z', "reviewedById" = $2::uuid`, s.ownerId)).rejects.toThrow(/after the rider was measured/)
    expect(await update(office(), 'MeasurementProfile', revision, `"reviewStatus" = 'NEED_MORE', "reviewedAt" = now(), "reviewedById" = $2::uuid, "reviewNote" = 'Please send a side photo'`, s.ownerId)).toBe(1)
    await expect(update(office(), 'MeasurementProfile', revision, `"reviewStatus" = 'WAITING', "reviewedAt" = NULL, "reviewedById" = NULL, "reviewNote" = NULL`)).rejects.toThrow(/never goes back to WAITING/)
  })

  it('keeps who measured and where as written, and an office person of ours', async () => {
    await expect(update(office(), 'MeasurementProfile', s.profileIds.p1Trousers1, `"measuredPlace" = 'Elsewhere'`)).rejects.toThrow(/never edited in place/)
    await expect(newRevision({ measuredPlace: 'two\nlines' })).rejects.toThrow(/1 to 200 characters of one line/)
    const partnerUser = randomUUID()
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, audience, "partyId", "partnerKind") VALUES ($1::uuid, $2::uuid, $3, 'Seed portal buyer', 'ACTIVE', 'PARTNER', $4::uuid, 'CUSTOMER')`, [
      partnerUser, a.tenantId, `buyer.${partnerUser.slice(0, 8)}@example.com`, s.partyIds.P1,
    ])
    await expect(newRevision({ measuredByUserId: partnerUser })).rejects.toThrow(/an office person of ours/)
    // A revision the rider sent by link names no person of ours (the first row is the link send of P1's JACKET revision 2).
    await expect(copyRow(office(), 'MeasurementProfile', s.profileIds.p1Jacket2, { id: randomUUID(), revision: 1_000, measuredByUserId: s.memberId })).rejects.toThrow(/sent by link/)
  })

  it('still lets the photo deletion date move, and reviews a link send only after it was sent', async () => {
    expect(await update(office(), 'MeasurementProfile', s.profileIds.p1Jacket2, `"photosDeleteAfter" = now() + interval '90 days'`)).toBe(1)
    const [sent] = await admin(`SELECT "submittedAt" > now() AS later FROM "MeasurementProfile" WHERE id = $1::uuid`, [s.profileIds.p1Jacket2])
    // The portal seed sends it on a day after this wave was built: until then a review of it is too early.
    if (sent?.later) {
      await expect(update(office(), 'MeasurementProfile', s.profileIds.p1Jacket2, `"reviewStatus" = 'NEED_MORE', "reviewedAt" = now(), "reviewedById" = $2::uuid, "reviewNote" = 'The back photo is blurred'`, s.ownerId)).rejects.toThrow(/after the rider was measured and the revision sent/)
    } else {
      expect(await update(office(), 'MeasurementProfile', s.profileIds.p1Jacket2, `"reviewStatus" = 'NEED_MORE', "reviewedAt" = now(), "reviewedById" = $2::uuid, "reviewNote" = 'The back photo is blurred'`, s.ownerId)).toBe(1)
    }
  })

  it('is read by the portal (status and words), never who reviewed or measured', async () => {
    const rows = await sql(partner(), `SELECT "reviewStatus"::text AS status, "reviewNote" AS words FROM "MeasurementProfile" WHERE id = $1::uuid`, s.profileIds.p1Jacket1)
    expect(rows[0]?.status).toBe('CONFIRMED')
    expect(String(rows[0]?.words)).toMatch(/design checked/)
    await expect(sql(partner(), `SELECT "reviewedById" FROM "MeasurementProfile" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(partner(), `SELECT "measuredByUserId" FROM "MeasurementProfile" LIMIT 1`)).rejects.toThrow(/permission denied/)
  })
})

describe('appointments (SAL-054)', () => {
  const newAppointment = async (changes: Record<string, unknown> = {}): Promise<string> => {
    const id = randomUUID()
    expect(await copyRow(office(), 'Appointment', s.appointmentIds.booked, { id, ...changes })).toBe(1)
    return id
  }

  it('are booked first, end after they start and last at most a day', async () => {
    await expect(newAppointment({ status: 'DONE', closedAt: ago(1) })).rejects.toThrow(/booked first/)
    await expect(newAppointment({ endsAt: '2026-12-02T08:00:00Z' })).rejects.toThrow(/ends after it starts/)
    await expect(newAppointment({ endsAt: '2026-12-03T10:00:00Z' })).rejects.toThrow(/at most 24 hours/)
    await expect(newAppointment({ place: '   ' })).rejects.toThrow(/1 to 200 characters of one line/)
    await expect(newAppointment({ measurementProfileId: null })).rejects.toThrow(/fitting .* is of a rider's measurement profile revision/)
    await expect(newAppointment({ contactId: key('party-contact:P1:buyer') })).rejects.toThrow(/with the rider of its measurement profile/)
    expect(await sql(office(), `SELECT status::text AS status FROM "Appointment" WHERE id = $1::uuid`, await newAppointment())).toEqual([{ status: 'BOOKED' }])
  })

  it('are done or missed only once they started, cancelled with why, and then final but the notes', async () => {
    // ---- B-W2b-F43: an appointment a week ahead on every day the test runs (the seeded booked fitting's day passes on 2 Dec 2026, and
    // from then "only once it started" no longer refused).
    const booked = await newAppointment({ startsAt: later(7 * 24 * 60), endsAt: later(7 * 24 * 60 + 60) })
    // ---- end B-W2b-F43
    await expect(update(office(), 'Appointment', booked, `status = 'DONE', "closedAt" = now()`)).rejects.toThrow(/only once it started/)
    await expect(update(office(), 'Appointment', booked, `status = 'CANCELLED', "closedAt" = now()`)).rejects.toThrow(/why it was cancelled/)
    await expect(update(office(), 'Appointment', booked, `status = 'CANCELLED', "cancelReason" = 'The rider is ill'`)).rejects.toThrow(/closed .* exactly with when/)
    expect(await update(office(), 'Appointment', booked, `status = 'CANCELLED', "closedAt" = now(), "closedById" = $2::uuid, "cancelReason" = 'The rider is ill'`, s.ownerId)).toBe(1)
    await expect(update(office(), 'Appointment', booked, `status = 'BOOKED', "closedAt" = NULL, "cancelReason" = NULL`)).rejects.toThrow(/only its notes change/)
    expect(await update(office(), 'Appointment', booked, `notes = 'Asked to book again in January'`)).toBe(1)
    await expect(update(office(), 'Appointment', s.appointmentIds.fitted, `place = 'Elsewhere'`)).rejects.toThrow(/only its notes change/)
    await expect(update(office(), 'Appointment', s.appointmentIds.fitted, `"companyId" = $2::uuid`, a.companies[1]!.id)).rejects.toThrow(/never change/)
  })

  it('say who was there when DONE, and a measuring session names the revision it led to once', async () => {
    const started = { startsAt: ago(90), endsAt: ago(30) }
    const nobody = await newAppointment({ ...started, withUserId: null, withName: null })
    await expect(update(office(), 'Appointment', nobody, `status = 'DONE', "closedAt" = now()`)).rejects.toThrow(/says who was there/)
    const measuring = await newAppointment({ ...started, kind: 'MEASURING', measurementProfileId: null })
    expect(await update(office(), 'Appointment', measuring, `status = 'DONE', "closedAt" = now()`)).toBe(1)
    expect(await update(office(), 'Appointment', measuring, `"measurementProfileId" = $2::uuid`, s.profileIds.p1Trousers1)).toBe(1)
    await expect(update(office(), 'Appointment', measuring, `"measurementProfileId" = $2::uuid`, s.profileIds.p1Jacket1)).rejects.toThrow(/names the profile revision it led to once/)
  })

  it('are kept, and read by the office only', async () => {
    await expect(admin(`DELETE FROM "Appointment" WHERE id = $1::uuid`, [s.appointmentIds.cancelled])).rejects.toThrow(/never deleted/)
    await expect(sql(partner(), `SELECT id FROM "Appointment" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(floor(), `SELECT id FROM "FittingResult" LIMIT 1`)).rejects.toThrow(/permission denied/)
  })
})

describe('fitting results (SAL-297)', () => {
  const newResult = (changes: Record<string, unknown>) => copyRow(office(), 'FittingResult', s.fittingIds.ok, { id: randomUUID(), ...changes })

  it('are of a fitting that was not missed or cancelled, or of an order line', async () => {
    await expect(newResult({ appointmentId: null })).rejects.toThrow(/of a fitting appointment, of a made-to-measure order line, or of both/)
    await expect(newResult({ partyId: s.partyIds.P1, appointmentId: s.appointmentIds.cancelled, measurementProfileId: s.profileIds.p1Jacket1 })).rejects.toThrow(/FITTING appointment of its company that was not missed or cancelled/)
    await expect(newResult({ fittedAt: later(60) })).rejects.toThrow(/not in the future/)
    await expect(newResult({ fittedAt: '2026-01-01T00:00:00Z' })).rejects.toThrow(/after the rider was measured/)
  })

  it('ask per point of the profile a signed change in its unit; OK asks none, ALTER one or words, REMAKE says why', async () => {
    const alter = (pointChanges: unknown, more: Record<string, unknown> = {}) => newResult({ verdict: 'ALTER', notes: null, pointChanges, ...more })
    await expect(newResult({ pointChanges: { chest: { change: '+1.0', unit: 'cm' } } })).rejects.toThrow(/is OK: it asks no change/)
    await expect(alter({})).rejects.toThrow(/names the points to change or says what to change/)
    await expect(alter({ shoulder: { change: '+1.0', unit: 'cm' } })).rejects.toThrow(/not one of the profile's measures/)
    await expect(alter({ chest: { change: '2cm', unit: 'cm' } })).rejects.toThrow(/signed decimal/)
    await expect(alter({ chest: { change: '0.0', unit: 'cm' } })).rejects.toThrow(/signed decimal, not zero/)
    await expect(alter({ chest: { change: '+10', unit: 'mm' } })).rejects.toThrow(/unit it was measured in/)
    await expect(alter({ chest: { change: '+1.0', unit: 'cm', why: 'x' } })).rejects.toThrow(/nothing else/)
    await expect(alter({ chest: { change: '+1.0', unit: 'cm' } }, { alterationDays: 400 })).rejects.toThrow(/days \(1 to 365\)/)
    expect(await alter({ chest: { change: '-0.5', unit: 'cm', note: 'a little loose' } }, { alterationDays: 3 })).toBe(1)
    expect(await alter({}, { notes: 'Move the knee pocket up' })).toBe(1)
    await expect(newResult({ verdict: 'REMAKE', notes: null })).rejects.toThrow(/a REMAKE says why/)
    expect(await newResult({ verdict: 'REMAKE', notes: 'The leather cannot be let out' })).toBe(1)
  })

  it('are written once; the alteration (an ALTERATION repair) and the new revision are named once each', async () => {
    await expect(update(office(), 'FittingResult', s.fittingIds.ok, `notes = 'Changed'`)).rejects.toThrow(/written once/)
    const repair = randomUUID()
    const alteration = randomUUID()
    expect(await copyRow(office(), 'RepairOrder', s.alterationRepairId, { id: repair, number: `SEED-REP-T-${repair.slice(0, 8)}`, kind: 'REPAIR' })).toBe(1)
    expect(await copyRow(office(), 'RepairOrder', s.alterationRepairId, { id: alteration, number: `SEED-REP-T-${alteration.slice(0, 8)}` })).toBe(1)
    await expect(update(office(), 'FittingResult', s.fittingIds.ok, `"alterationRepairId" = $2::uuid`, alteration)).rejects.toThrow(/is OK: it asks no change and opens nothing/)
    await expect(update(office(), 'FittingResult', s.fittingIds.alter, `"alterationRepairId" = $2::uuid`, repair)).rejects.toThrow(/once each, never another/)
    const second = randomUUID()
    expect(await copyRow(office(), 'FittingResult', s.fittingIds.alter, { id: second, alterationRepairId: null })).toBe(1)
    await expect(update(office(), 'FittingResult', second, `"alterationRepairId" = $2::uuid`, repair)).rejects.toThrow(/opens an ALTERATION repair order/)
    await expect(update(office(), 'FittingResult', second, `"alterationRepairId" = $2::uuid`, s.alterationRepairId)).rejects.toThrow(/duplicate key|FittingResult_tenantId_alterationRepairId_key/)
    expect(await update(office(), 'FittingResult', second, `"alterationRepairId" = $2::uuid, version = version + 1`, alteration)).toBe(1)
    // P1's JACKET revision 2 (sent by link) is the later revision of the same rider and garment type.
    await expect(update(office(), 'FittingResult', second, `"newProfileId" = $2::uuid`, s.profileIds.p1Jacket1)).rejects.toThrow(/never the revision it fitted/)
    await expect(update(office(), 'FittingResult', second, `"newProfileId" = $2::uuid`, s.profileIds.p1Trousers1)).rejects.toThrow(/later revision of the same rider and garment type/)
    expect(await update(office(), 'FittingResult', second, `"newProfileId" = $2::uuid`, s.profileIds.p1Jacket2)).toBe(1)
    await expect(update(office(), 'FittingResult', second, `"newProfileId" = NULL`)).rejects.toThrow(/once each, never another/)
    await expect(admin(`DELETE FROM "FittingResult" WHERE id = $1::uuid`, [second])).rejects.toThrow(/never deleted/)
  })

  it('of an order line are of its made-to-measure unit and its revision', async () => {
    const mtmLine = randomUUID()
    expect(await copyRow(office(), 'SalesOrderLine', key('sales:SO1:line:10'), {
      id: mtmLine, seq: 900, kind: 'MADE_TO_MEASURE', measurementProfileId: s.profileIds.p1Jacket1, quantity: 1, quoteLineId: null, description: 'MTM unit (test)',
    })).toBe(1)
    const ofLine = (lineId: string, profileId: string) =>
      newResult({ partyId: s.partyIds.P1, appointmentId: null, salesOrderLineId: lineId, measurementProfileId: profileId, fittedAt: ago(10) })
    await expect(ofLine(key('sales:SO1:line:10'), s.profileIds.p1Jacket1)).rejects.toThrow(/MADE_TO_MEASURE order line of its company, made to the profile revision it fitted/)
    await expect(ofLine(mtmLine, s.profileIds.p1Trousers1)).rejects.toThrow(/made to the profile revision it fitted/)
    expect(await ofLine(mtmLine, s.profileIds.p1Jacket1)).toBe(1)
  })
})

describe('a made-to-measure line names a style flagged made-to-measure (PRD-017)', () => {
  it('on quotes and orders, checked when the line is written or its kind or style changes', async () => {
    const mtmQuoteLine = `00000000${key('sales:Q2:v1:line:20').slice(8)}`
    const styleId = (await admin(`SELECT "styleId"::text AS id FROM "QuoteLine" WHERE id = $1::uuid`, [mtmQuoteLine]))[0]!.id as string
    expect(await copyRow(office(), 'QuoteLine', mtmQuoteLine, { id: randomUUID(), seq: 30 })).toBe(1)
    expect(await update(office(), 'Style', styleId, `"mtmAllowed" = false`)).toBe(1)
    try {
      await expect(copyRow(office(), 'QuoteLine', mtmQuoteLine, { id: randomUUID(), seq: 40 })).rejects.toThrow(/not made to measure \(a person flags the style first/)
      await expect(copyRow(office(), 'SalesOrderLine', key('sales:SO1:line:10'), {
        id: randomUUID(), seq: 910, kind: 'MADE_TO_MEASURE', measurementProfileId: s.profileIds.p1Jacket1, quantity: 1, quoteLineId: null,
      })).rejects.toThrow(/SalesOrderLine .* not made to measure/)
      // An existing line keeps its other changes.
      expect(await update(office(), 'QuoteLine', mtmQuoteLine, `note = 'Seed: the rider asks for a red stripe', version = version + 1`)).toBe(1)
      // A size-grid line of the style is untouched by the rule.
      expect(await update(office(), 'SalesOrderLine', key('sales:SO1:line:10'), `note = 'Seed: size grid', version = version + 1`)).toBe(1)
    } finally {
      expect(await update(office(), 'Style', styleId, `"mtmAllowed" = true`)).toBe(1)
    }
  })
})

describe('the made-to-measure worksheet (SAL-303)', () => {
  it('is a generated document of a measurement profile, of a company of the tenant, without a site', async () => {
    const rows = await sql(office(), `SELECT kind::text AS kind, "recordType" AS type, "siteId" AS site FROM "GeneratedDocument" WHERE id = $1::uuid`, s.worksheetId)
    expect(rows).toEqual([{ kind: 'MTM_WORKSHEET', type: 'MeasurementProfile', site: null }])
    await expect(copyRow(office(), 'GeneratedDocument', s.worksheetId, { id: randomUUID(), version: 2, recordType: 'SalesOrder', recordId: sales.orderId })).rejects.toThrow(/a made-to-measure worksheet a MeasurementProfile's/)
    await expect(copyRow(office(), 'GeneratedDocument', s.worksheetId, { id: randomUUID(), version: 2, siteId: SITE_A1 })).rejects.toThrow(/company and site of its MeasurementProfile/)
    expect(await copyRow(office(), 'GeneratedDocument', s.worksheetId, { id: randomUUID(), version: 2 })).toBe(1)
    expect(await sql(floor(), `SELECT id FROM "GeneratedDocument" WHERE "recordType" = 'MeasurementProfile'`)).toEqual([])
  })
})
