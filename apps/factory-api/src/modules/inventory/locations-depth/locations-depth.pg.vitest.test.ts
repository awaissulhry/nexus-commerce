import { fileURLToPath } from 'node:url'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { keyOf } from '@nexus/factory-domain/imports/importer'
import { locationsImporter } from '@nexus/factory-domain/inventory/locations/importer'
import { buildApp } from '../../../core/app'
import { command } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { pdfFlatText, pdfPageCount } from '../../../platform/documents/testing/pdf-text'
import { ALL_INVENTORY, startInventoryFixture, type InventoryFixture } from '../ledger/testing/fixture'
import { locationsImportAdapter } from '../locations/importer'

/**
 * Locations in depth on the local stack (B-W2b-289; SCM-177, SCM-178, SCM-179, SCM-181), through the app's real routes on
 * the inventory fixture's made-up data (ledger/testing/fixture.ts) with sessions of its own (printing, counts):
 *   - the location types: what each holds, a customer's place with its party, where a kind sits, what never retypes; a
 *     material refused at a customer's place; the locations import making a customer's place with its party checked;
 *   - bin labels: the suggested and a typed code (unique in the tenant), the scan, print jobs (one per place, a place
 *     without a code given its suggested one, an outside place refused), the bin labels PDF, a changed code's old labels;
 *   - blocks: block, change, unblock in words; a move in or out refused while it holds; a count of a place blocks it and
 *     the places inside it while it counts, and only its own block is lifted when the counting ends;
 *   - default locations: set, change (the earlier one kept), clear; what a place may be the default for; the resolver.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/inventory/locations-depth`.
 */

type Json = Record<string, any>
let f: InventoryFixture
let ids: InventoryFixture['ids']
let app: FastifyInstance
let serial = 0
const idem = () => `depth-${Date.now()}-${++serial}`
const extra = { customer: newId(), supplier: newId(), archivedCustomer: newId(), printer: newId(), count: newId(), user: newId() }

const grant = (permissions: readonly Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const COUNTS: Permission[] = ['inventory.counts.view', 'inventory.counts.manage', 'inventory.counts.approve']
const PRINT: Permission[] = ['print.view', 'print.labels']

function sessions(): Record<string, SessionContext> {
  const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: extra.user, grants })
  return {
    manager: office(ids.tenantA, [grant([...ALL_INVENTORY, ...COUNTS, ...PRINT, 'money.cost'])]),
    viewer: office(ids.tenantA, [grant(['inventory.locations.view', 'inventory.stock.view'])]),
    'company-two': office(ids.tenantA, [grant([...ALL_INVENTORY, ...PRINT], [ids.companyA2])]),
    'manager-b': office(ids.tenantB, [grant([...ALL_INVENTORY, ...PRINT])]),
    'floor-a1': { audience: 'floor', tenantId: ids.tenantA, actorId: newId(), siteId: ids.siteA1, deviceId: ids.deviceA1, grants: [grant(['inventory.locations.view', 'inventory.transfer', ...PRINT], [ids.companyA], [ids.siteA1])] },
    'floor-a2': { audience: 'floor', tenantId: ids.tenantA, actorId: newId(), siteId: ids.siteA2, deviceId: ids.deviceA2, grants: [grant(['inventory.locations.view', 'inventory.transfer'], [ids.companyA], [ids.siteA2])] },
  }
}

const call = (session: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, key: string | null = method === 'GET' ? null : idem()): Promise<LightMyRequestResponse> =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
const ok = async (response: Promise<LightMyRequestResponse>, status = 200): Promise<Json> => {
  const answer = await response
  expect(answer.statusCode, answer.body).toBe(status)
  return answer.json() as Json
}
const refused = async (response: Promise<LightMyRequestResponse>, status: number): Promise<Json> => {
  const answer = await response
  expect(answer.statusCode, answer.body).toBe(status)
  return answer.json().error as Json
}
const place = async (id: string): Promise<Json> => (await f.admin(`SELECT code, kind::text, "labelCode", "blockReason"::text AS reason, "blockNote" AS note, "blockedUntil", version FROM "Location" WHERE id = $1`, [id]))[0]!
const events = async (type: string, subject: string) => (await f.admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2 ORDER BY id', [type, subject])).map((row) => row.payload)
const tomorrow = () => businessDate(new Date(Date.now() + 36 * 3600_000))
const yesterday = () => businessDate(new Date(Date.now() - 36 * 3600_000))

beforeAll(async () => {
  f = await startInventoryFixture('locations_depth')
  ids = f.ids
  const SESSIONS = sessions()
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: f.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  await f.admin(
    `INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles, status) VALUES
       ($1, $4, NULL, 'CLI-DEPTH', 'ORGANISATION', 'Cliente Inventato S.r.l.', '{CUSTOMER}', 'ACTIVE'),
       ($2, $4, $5, 'FORN-DEPTH', 'ORGANISATION', 'Fornitore Inventato S.r.l.', '{SUPPLIER}', 'ACTIVE'),
       ($3, $4, $5, 'CLI-OLD', 'ORGANISATION', 'Cliente Vecchio S.r.l.', '{CUSTOMER}', 'ARCHIVED')`,
    [extra.customer, extra.supplier, extra.archivedCustomer, ids.tenantA, ids.companyA],
  )
  await f.admin(
    `INSERT INTO "Printer" (id, "tenantId", "companyId", "siteId", code, name, kind, relay, "relayTarget", dpi, "labelWidthMm", "labelHeightMm") VALUES ($1, $2, $3, $4, 'LBL-BIN', 'Made-up bin label printer', 'LABEL_ZPL', 'FAKE', 'test-bin-labels:9100', 203, 100, 50)`,
    [extra.printer, ids.tenantA, ids.companyA, ids.siteA1],
  )
}, 90_000)

afterAll(async () => {
  await app?.close()
  await f?.close()
}, 60_000)

describe('location types (SCM-177)', () => {
  let customerPlace: Json
  it('says what each kind holds; the floor reads it too', async () => {
    const { kinds } = await ok(call('floor-a1', 'GET', '/inventory/locations/kinds'))
    const of = (kind: string) => (kinds as Json[]).find((entry) => entry.kind === kind)!
    expect(kinds).toHaveLength(13)
    expect(of('CUSTOMER')).toMatchObject({ group: 'OUTSIDE', holds: 'FINISHED', party: ['CUSTOMER', 'BRAND'], labelled: false, blockable: false, atTop: true, fixed: true })
    expect(of('TRANSIT')).toMatchObject({ transferOnly: true, purposes: [] })
    expect(of('PRODUCTION')).toMatchObject({ holds: 'MATERIALS', purposes: ['ISSUE', 'RETURN'] })
    expect(of('QUARANTINE').purposes).toEqual(['QUALITY'])
    expect(of('PICK_FACE')).toMatchObject({ holds: 'MATERIALS', container: false })
  })

  it("makes a customer's place only with a customer or brand of the company, at the top; it never turns into another kind", async () => {
    const base = { siteId: ids.siteA1, code: 'A1-CLI', name: 'Fitting stock at the customer', kind: 'CUSTOMER' }
    expect((await refused(call('manager', 'POST', '/inventory/locations', base), 400)).issues).toEqual([{ path: 'body/partyId', message: expect.stringContaining('name it') }])
    expect((await refused(call('manager', 'POST', '/inventory/locations', { ...base, partyId: extra.supplier }), 400)).issues[0].message).toContain('no customer or brand')
    expect((await refused(call('manager', 'POST', '/inventory/locations', { ...base, partyId: extra.archivedCustomer }), 400)).issues[0].message).toBe('The customer is archived.')
    expect((await refused(call('manager', 'POST', '/inventory/locations', { ...base, partyId: extra.customer, parentId: ids.store }), 400)).issues).toEqual([{ path: 'body/parentId', message: expect.stringContaining('top of the site') }])
    customerPlace = (await ok(call('manager', 'POST', '/inventory/locations', { ...base, partyId: extra.customer }), 201)).location
    expect(customerPlace).toMatchObject({ kind: 'CUSTOMER', partyId: extra.customer, parentId: null, labelCode: null, block: null })
    expect((await refused(call('manager', 'PATCH', `/inventory/locations/${customerPlace.id}`, { version: 1, kind: 'BIN' }), 400)).issues).toEqual([{ path: 'body/kind', message: expect.stringContaining('stays one') }])
    expect((await refused(call('manager', 'PATCH', `/inventory/locations/${ids.bin1}`, { version: 1, kind: 'TRANSIT' }), 400)).issues[0].path).toBe('body/kind')
    // Nothing sits inside a customer's place, a transit place or a pick face.
    const transit = (await ok(call('manager', 'POST', '/inventory/locations', { siteId: ids.siteA1, code: 'A1-TRANSIT', name: 'In transit to A2', kind: 'TRANSIT' }), 201)).location
    const pick = (await ok(call('manager', 'POST', '/inventory/locations', { siteId: ids.siteA1, code: 'A1-PF-01', name: 'Pick face', kind: 'PICK_FACE', parentId: ids.store }), 201)).location
    for (const parent of [customerPlace, transit, pick]) {
      expect((await refused(call('manager', 'POST', '/inventory/locations', { siteId: ids.siteA1, code: `${parent.code}-X`, name: 'x', kind: 'BIN', parentId: parent.id }), 400)).issues[0]).toMatchObject({ path: 'body/parentId', message: expect.stringContaining('Nothing sits inside') })
    }
  })

  it("refuses a material at a customer's place and a finished garment on a line-side rack, in words; takes a material on a pick face", async () => {
    const pick = (await f.admin<{ id: string }>(`SELECT id FROM "Location" WHERE code = 'A1-PF-01'`))[0]!.id
    const atCustomer = await refused(call('manager', 'POST', '/inventory/adjustments', { siteId: ids.siteA1, itemId: ids.protector, locationId: customerPlace.id, direction: 'IN', quantity: '2', note: 'Test.' }), 400)
    expect(atCustomer.message).toBe("Location A1-CLI is a customer's place: it holds finished garments only, not materials (TEST-PROTECTOR).")
    await ok(call('manager', 'POST', '/inventory/adjustments', { siteId: ids.siteA1, itemId: ids.protector, locationId: pick, direction: 'IN', quantity: '2', note: 'Test stock.' }), 201)
  })

  it('the locations import makes a Customer row with its customer checked, and refuses one without', async () => {
    const caller = f.system()
    const scope = { companyId: ids.companyA }
    const values = { site: 'A1', code: 'A1-CLI-IMP', name: 'Imported customer place', kind: 'CUSTOMER', workshop: 'CLI-DEPTH' }
    const plan = locationsImporter.plan(values, null)
    expect(plan).toEqual({ action: 'CREATE', after: values })
    const checked = await command(caller, { name: 'test.checkLocations', input: {} }, async (tools) => {
      tools.audit({ recordType: 'Site', recordId: ids.siteA1 })
      return locationsImportAdapter.check!(tools.tx, [{ rowNumber: 2, key: { site: 'A1', code: 'A1-CLI-IMP' }, values }, { rowNumber: 3, key: { site: 'A1', code: 'A1-CLI-NO' }, values: { ...values, code: 'A1-CLI-NO', workshop: 'FORN-DEPTH' } }], scope, { tenantId: ids.tenantA, grants: [] } as never)
    })
    expect(checked.result).toEqual([[], [{ column: 'workshop', message: expect.stringContaining('no customer or brand') }]])
    const keyValues = JSON.parse(keyOf(locationsImporter, values)!) as string[]
    await command(caller, { name: 'test.applyLocations', input: {} }, (tools) => locationsImportAdapter.write(tools, { action: 'CREATE', key: { site: keyValues[0]!, code: keyValues[1]! }, recordId: null, before: {}, values }, scope))
    expect(await f.admin(`SELECT kind::text, "partyId"::text AS "partyId", "parentId" FROM "Location" WHERE code = 'A1-CLI-IMP'`)).toEqual([{ kind: 'CUSTOMER', partyId: extra.customer, parentId: null }])
    await expect(
      command(caller, { name: 'test.applyLocations', input: { n: 2 } }, (tools) =>
        locationsImportAdapter.write(tools, { action: 'CREATE', key: { site: 'A1', code: 'A1-CLI-NO' }, recordId: null, before: {}, values: { ...values, code: 'A1-CLI-NO', workshop: 'FORN-DEPTH' } }, scope),
      ),
    ).rejects.toThrow(/no customer or brand/)
  })
})

describe('bin labels (SCM-178)', () => {
  it('gives the suggested code or a typed one, unique in the tenant; the scan names the place (the floor: its own site)', async () => {
    const given = await ok(call('manager', 'PUT', `/inventory/locations/${ids.bin1}/label-code`, { version: (await place(ids.bin1)).version }))
    expect(given).toMatchObject({ location: { code: 'A1-BIN-01', labelCode: 'A1-BIN-01' }, printed: 0 })
    const typed = await ok(call('manager', 'PUT', `/inventory/locations/${ids.bin1}/label-code`, { version: given.location.version, labelCode: ' bin/a1:01 ' }))
    expect(typed.location.labelCode).toBe('BIN/A1:01')
    // Another place of another site of the tenant: the same code is taken.
    const taken = await refused(call('manager', 'PUT', `/inventory/locations/${ids.storeA2}/label-code`, { version: 1, labelCode: 'BIN/A1:01' }), 409)
    expect(taken.message).toBe('Label code BIN/A1:01 is on location A1-BIN-01 of site A1 already: a scan names one place.')
    expect((await refused(call('manager', 'PUT', `/inventory/locations/${ids.storeA2}/label-code`, { version: 1, labelCode: 'A 1' }), 400)).issues[0].path).toBe('body/labelCode')
    const transit = (await f.admin<{ id: string; version: number }>(`SELECT id, version FROM "Location" WHERE code = 'A1-TRANSIT'`))[0]!
    expect((await refused(call('manager', 'PUT', `/inventory/locations/${transit.id}/label-code`, { version: transit.version }), 400)).message).toContain('gets no bin label')
    expect((await call('floor-a1', 'PUT', `/inventory/locations/${ids.bin1}/label-code`, { version: 1 })).statusCode).toBe(403)
    expect(await events('inventory.location_label_changed', ids.bin1)).toEqual([
      expect.objectContaining({ labelCode: 'A1-BIN-01', change: 'SET' }),
      expect.objectContaining({ labelCode: 'BIN/A1:01', change: 'CHANGED' }),
    ])

    const scanned = await ok(call('floor-a1', 'GET', `/inventory/locations/scan?code=${encodeURIComponent('bin/a1:01')}`))
    expect(scanned).toMatchObject({ location: { id: ids.bin1, code: 'A1-BIN-01', labelCode: 'BIN/A1:01' }, path: ['A1-STORE', 'A1-BIN-01'] })
    expect((await call('floor-a2', 'GET', '/inventory/locations/scan?code=BIN%2FA1%3A01')).statusCode).toBe(404)
    expect((await call('manager-b', 'GET', '/inventory/locations/scan?code=BIN%2FA1%3A01')).statusCode).toBe(404)
    expect((await refused(call('viewer', 'GET', '/inventory/locations/scan?code=NOPE'), 404)).message).toBe('No place carries label NOPE.')
  })

  it("prints one job per place on the site's label printer; a place without a code gets its suggested one; an outside place is refused", async () => {
    const transit = (await f.admin<{ id: string }>(`SELECT id FROM "Location" WHERE code = 'A1-TRANSIT'`))[0]!.id
    const printed = await ok(call('manager', 'POST', '/inventory/locations/labels/print', { printerId: extra.printer, locationIds: [ids.bin1, ids.bin2, transit], copies: 2, language: 'en' }), 201)
    expect(printed.jobs.map((job: Json) => [job.labelCode, job.state])).toEqual([
      ['BIN/A1:01', 'QUEUED'],
      ['A1-BIN-02', 'QUEUED'],
    ])
    expect(printed.refused).toEqual([{ locationId: transit, code: 'A1-TRANSIT', message: expect.stringContaining('not a place on the floor') }])
    const jobs = await f.admin(`SELECT "recordType", "labelKind", "scanId", copies, zpl FROM "PrintJob" WHERE "printerId" = $1 ORDER BY "scanId"`, [extra.printer])
    expect(jobs.map((job) => [job.recordType, job.labelKind, job.scanId, job.copies])).toEqual([
      ['Location', 'LOCATION', 'A1-BIN-02', 2],
      ['Location', 'LOCATION', 'BIN/A1:01', 2],
    ])
    expect(jobs[1]!.zpl).toContain('^FDBIN/A1:01^FS')
    expect(jobs[1]!.zpl).toContain('Location')
    expect((await place(ids.bin2)).labelCode).toBe('A1-BIN-02')
    // A place of another site is refused for this printer; the floor prints its own site's labels once they have a code.
    expect((await ok(call('manager', 'POST', '/inventory/locations/labels/print', { printerId: extra.printer, locationIds: [ids.storeA2] }), 201)).refused[0].message).toContain('printer of that site')
    expect((await ok(call('floor-a1', 'POST', '/inventory/locations/labels/print', { printerId: extra.printer, locationIds: [ids.bin1] }, idem()), 201)).jobs).toHaveLength(1)
    expect((await call('floor-a1', 'POST', '/inventory/locations/labels/print', { printerId: extra.printer, locationIds: [ids.store] }, idem())).statusCode).toBe(403)

    const label = await ok(call('manager', 'GET', `/inventory/locations/${ids.bin1}/label?language=en`))
    expect(label).toMatchObject({ code: 'BIN/A1:01', suggested: false, labelled: true, label: { heading: 'Location · Pelli Inventate S.r.l.', scanId: 'BIN/A1:01' } })
    expect(label.label.fields).toEqual([
      { label: 'Site', value: 'A1' },
      { label: 'Kind', value: 'Bin' },
      { label: 'Path', value: 'A1-STORE › A1-BIN-01' },
      { label: 'Code', value: 'A1-BIN-01' },
    ])
    expect(label.jobs).toHaveLength(2)
    expect((await ok(call('viewer', 'GET', `/inventory/locations/${ids.bin1}/label`))).jobs).toEqual([])
    // A changed code: the labels printed with the old one no longer scan.
    const changed = await ok(call('manager', 'PUT', `/inventory/locations/${ids.bin1}/label-code`, { version: (await place(ids.bin1)).version, labelCode: 'A1-R1-01' }))
    expect(changed.printed).toBe(2)
  })

  it('makes the bin labels PDF, a page per label and copy', async () => {
    const answer = await call('manager', 'POST', '/inventory/locations/labels/pdf', { locationIds: [ids.bin1, ids.bin2], copies: 1, language: 'it' })
    expect(answer.statusCode, answer.body).toBe(200)
    expect(answer.headers['content-type']).toBe('application/pdf')
    expect(pdfPageCount(answer.rawPayload)).toBe(2)
    const text = pdfFlatText(answer.rawPayload)
    expect(text).toContain('A1-R1-01')
    expect(text).toContain('Ubicazione')
    expect((await call('company-two', 'POST', '/inventory/locations/labels/pdf', { locationIds: [ids.bin1] })).statusCode).toBe(404)
  })
})

describe('blocked locations (SCM-181)', () => {
  it('blocks with a reason and an until-day, refuses every move in or out while it holds, and unblocks', async () => {
    const v = (await place(ids.bin1)).version
    expect((await refused(call('manager', 'POST', `/inventory/locations/${ids.bin1}/block`, { version: v, reason: 'OTHER' }), 400)).issues).toEqual([{ path: 'body/note', message: 'Say why in words (the reason is Other).' }])
    expect((await refused(call('manager', 'POST', `/inventory/locations/${ids.bin1}/block`, { version: v, reason: 'DAMAGE', until: yesterday() }), 400)).issues[0].path).toBe('body/until')
    const transit = (await f.admin<{ id: string; version: number }>(`SELECT id, version FROM "Location" WHERE code = 'A1-TRANSIT'`))[0]!
    expect((await refused(call('manager', 'POST', `/inventory/locations/${transit.id}/block`, { version: transit.version, reason: 'DAMAGE' }), 400)).issues[0].path).toBe('location')
    expect((await call('floor-a1', 'POST', `/inventory/locations/${ids.bin1}/block`, { version: v, reason: 'DAMAGE' })).statusCode).toBe(403)
    expect((await call('viewer', 'POST', `/inventory/locations/${ids.bin1}/block`, { version: v, reason: 'DAMAGE' })).statusCode).toBe(403)

    const blocked = (await ok(call('manager', 'POST', `/inventory/locations/${ids.bin1}/block`, { version: v, reason: 'DAMAGE', note: 'Shelf bent by the forklift.', until: tomorrow() }))).location
    expect(blocked.block).toMatchObject({ reason: 'DAMAGE', note: 'Shelf bent by the forklift.', until: tomorrow(), holds: true, countNumber: null })
    // A move in or out is refused in the database's words (409), whoever moves it.
    const into = await refused(call('manager', 'POST', '/inventory/adjustments', { siteId: ids.siteA1, itemId: ids.protector, locationId: ids.bin1, direction: 'IN', quantity: '1', note: 'Test.' }), 409)
    expect(into).toMatchObject({ message: 'Location A1-BIN-01 is blocked (damage): nothing moves in or out of it until it is unblocked.', issues: [{ path: 'warehouse/LOCATION_BLOCKED', message: expect.any(String) }] })
    const pick = (await f.admin<{ id: string }>(`SELECT id FROM "Location" WHERE code = 'A1-PF-01'`))[0]!.id
    expect((await call('floor-a1', 'POST', '/inventory/transfers', { siteId: ids.siteA1, itemId: ids.protector, fromLocationId: pick, toLocationId: ids.bin1, quantity: '1' }, idem())).statusCode).toBe(409)
    // The list of blocked places, and the W1 tree's status.
    expect((await ok(call('floor-a1', 'GET', `/inventory/locations/blocked?siteId=${ids.siteA1}`))).locations.map((row: Json) => row.code)).toEqual(['A1-BIN-01'])
    const tree = (await ok(call('viewer', 'GET', `/inventory/locations?siteId=${ids.siteA1}`))).sites[0].locations as Json[]
    expect(tree.find((row) => row.id === ids.bin1)!.block).toMatchObject({ reason: 'DAMAGE', holds: true })

    const changed = (await ok(call('manager', 'POST', `/inventory/locations/${ids.bin1}/block`, { version: blocked.version, reason: 'CLEAN_UP' }))).location
    expect(changed.block).toMatchObject({ reason: 'CLEAN_UP', until: null, at: blocked.block.at })
    const open = (await ok(call('manager', 'POST', `/inventory/locations/${ids.bin1}/unblock`, { version: changed.version }))).location
    expect(open.block).toBeNull()
    expect((await refused(call('manager', 'POST', `/inventory/locations/${ids.bin1}/unblock`, { version: open.version }), 400)).message).toBe('Location A1-BIN-01 is not blocked.')
    await ok(call('floor-a1', 'POST', '/inventory/transfers', { siteId: ids.siteA1, itemId: ids.protector, fromLocationId: pick, toLocationId: ids.bin1, quantity: '1' }, idem()), 201)
    expect((await events('inventory.location_blocked', ids.bin1)).map((event) => [event.change, event.reason])).toEqual([
      ['BLOCKED', 'DAMAGE'],
      ['CHANGED', 'CLEAN_UP'],
      ['UNBLOCKED', null],
    ])
  })

  it('a count of a place blocks it and the places inside it while it counts; only its own block is lifted', async () => {
    // A2 is blocked by a person before the count; the count leaves that block as it is.
    await ok(call('manager', 'POST', `/inventory/locations/${ids.bin2}/block`, { version: (await place(ids.bin2)).version, reason: 'DAMAGE' }))
    await f.admin(
      `INSERT INTO "StockCount" (id, "tenantId", "companyId", "siteId", number, kind, "locationId", status, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, 'TEST-CNT-1', 'CYCLE', $5, 'DRAFT', now(), now())`,
      [extra.count, ids.tenantA, ids.companyA, ids.siteA1, ids.store],
    )
    let count = (await ok(call('manager', 'POST', `/inventory/stock-counts/${extra.count}/start`, { version: 1 }))).count
    expect(count.status).toBe('COUNTING')
    const note = 'Count TEST-CNT-1 is running here.'
    expect(await place(ids.store)).toMatchObject({ reason: 'COUNT', note })
    expect(await place(ids.bin1)).toMatchObject({ reason: 'COUNT', note })
    expect(await place(ids.bin2)).toMatchObject({ reason: 'DAMAGE', note: null })
    expect(await place(ids.cut)).toMatchObject({ reason: null })
    const out = await refused(call('manager', 'POST', '/inventory/transfers', { siteId: ids.siteA1, itemId: ids.protector, fromLocationId: ids.bin1, toLocationId: ids.cut, quantity: '1' }), 409)
    expect(out.message).toBe('Location A1-BIN-01 is blocked (a count): nothing moves in or out of it until it is unblocked.')
    // A person does not lift a running count's block.
    expect((await refused(call('manager', 'POST', `/inventory/locations/${ids.bin1}/unblock`, { version: (await place(ids.bin1)).version }), 400)).message).toContain('The count unblocks it')

    // Submitted: the counting ended, its places take moves again; sent back to count again: blocked again.
    const { lines } = await ok(call('manager', 'GET', `/inventory/stock-counts/${extra.count}/lines`))
    await ok(call('manager', 'POST', `/inventory/stock-counts/${extra.count}/lines/record`, { lines: (lines as Json[]).map((line) => ({ lineId: line.id, version: line.version, counted: line.expected })) }))
    count = (await ok(call('manager', 'POST', `/inventory/stock-counts/${extra.count}/submit`, { version: count.version }))).count
    expect(count.status).toBe('SUBMITTED')
    expect(await place(ids.bin1)).toMatchObject({ reason: null, note: null })
    expect(await place(ids.bin2)).toMatchObject({ reason: 'DAMAGE' })
    count = (await ok(call('manager', 'POST', `/inventory/stock-counts/${extra.count}/send-back`, { version: count.version, reason: 'Count the rack again.' }))).count
    expect(count.status).toBe('COUNTING')
    expect(await place(ids.store)).toMatchObject({ reason: 'COUNT', note })
    count = (await ok(call('manager', 'POST', `/inventory/stock-counts/${extra.count}/cancel`, { version: count.version, reason: 'Done another day.' }))).count
    expect(await place(ids.store)).toMatchObject({ reason: null })
    expect(await place(ids.bin2)).toMatchObject({ reason: 'DAMAGE' })
    expect((await events('inventory.location_blocked', ids.store)).map((event) => [event.change, event.countId])).toEqual([
      ['BLOCKED', extra.count],
      ['UNBLOCKED', extra.count],
      ['BLOCKED', extra.count],
      ['UNBLOCKED', extra.count],
    ])
    await ok(call('manager', 'POST', `/inventory/locations/${ids.bin2}/unblock`, { version: (await place(ids.bin2)).version }))
  })
})

describe('default locations (SCM-179)', () => {
  it('sets, changes (the earlier row kept) and clears a default; refuses a place that does not serve the purpose or hold the kind', async () => {
    const put = (body: Json, session = 'manager') => call(session, 'PUT', '/inventory/locations/defaults', body)
    const first = (await ok(put({ siteId: ids.siteA1, itemKind: null, purpose: 'RECEIVING', locationId: ids.bin1 }))).default
    expect(first).toMatchObject({ itemKind: null, purpose: 'RECEIVING', location: { id: ids.bin1, code: 'A1-BIN-01' }, updatedById: extra.user })
    expect((await refused(put({ siteId: ids.siteA1, itemKind: null, purpose: 'RECEIVING', locationId: ids.bin2 }), 409)).message).toContain('send the version')
    const second = (await ok(put({ siteId: ids.siteA1, itemKind: null, purpose: 'RECEIVING', locationId: ids.bin2, version: first.version }))).default
    expect(second.location.id).toBe(ids.bin2)
    expect(await f.admin(`SELECT "locationId"::text AS "locationId", active FROM "DefaultLocation" WHERE "siteId" = $1 AND purpose = 'RECEIVING' ORDER BY "createdAt", id`, [ids.siteA1])).toEqual([
      { locationId: ids.bin1, active: false },
      { locationId: ids.bin2, active: true },
    ])
    expect((await refused(put({ siteId: ids.siteA1, itemKind: null, purpose: 'QUALITY', locationId: ids.bin1 }), 400)).issues[0]).toMatchObject({ path: 'body/locationId', message: expect.stringContaining('a quality default is a quarantine place') })
    expect((await refused(put({ siteId: ids.siteA1, itemKind: 'FINISHED', purpose: 'ISSUE', locationId: ids.cut }), 400)).issues[0].message).toContain('does not hold finished garments')
    expect((await refused(put({ siteId: ids.siteA1, itemKind: null, purpose: 'RECEIVING', locationId: ids.storeA2, version: second.version }), 400)).issues[0].message).toBe('Not a location of this site.')
    expect((await put({ siteId: ids.siteA1, itemKind: null, purpose: 'ISSUE', locationId: ids.cut }, 'viewer')).statusCode).toBe(403)
    expect((await put({ siteId: ids.siteA1, itemKind: null, purpose: 'ISSUE', locationId: ids.cut }, 'company-two')).statusCode).toBe(403)

    // The kind's own default before the fallback; the resolver says whose.
    await ok(put({ siteId: ids.siteA1, itemKind: 'LINING', purpose: 'RECEIVING', locationId: ids.store }))
    expect(await ok(call('floor-a1', 'GET', `/inventory/locations/defaults/resolve?purpose=RECEIVING&itemId=${ids.lining}`))).toEqual({ location: expect.objectContaining({ id: ids.store, code: 'A1-STORE' }), from: 'KIND' })
    expect(await ok(call('manager', 'GET', `/inventory/locations/defaults/resolve?siteId=${ids.siteA1}&purpose=RECEIVING&itemId=${ids.protector}`))).toEqual({ location: expect.objectContaining({ id: ids.bin2 }), from: 'FALLBACK' })
    expect(await ok(call('manager', 'GET', `/inventory/locations/defaults/resolve?siteId=${ids.siteA1}&purpose=PUT_AWAY`))).toEqual({ location: null, from: null })
    const { defaults } = await ok(call('floor-a1', 'GET', `/inventory/locations/defaults?siteId=${ids.siteA1}`))
    expect((defaults as Json[]).map((row) => [row.purpose, row.itemKind, row.location.code])).toEqual([
      ['RECEIVING', null, 'A1-BIN-02'],
      ['RECEIVING', 'LINING', 'A1-STORE'],
    ])
    expect((await call('floor-a2', 'GET', `/inventory/locations/defaults?siteId=${ids.siteA1}`)).statusCode).toBe(404)

    expect((await ok(put({ siteId: ids.siteA1, itemKind: null, purpose: 'RECEIVING', locationId: null, version: second.version }))).default).toBeNull()
    expect((await ok(call('manager', 'GET', `/inventory/locations/defaults?siteId=${ids.siteA1}`))).defaults).toHaveLength(1)
    expect((await events('inventory.default_location_changed', first.id)).map((event) => event.change)).toEqual(['SET'])
  })
})
