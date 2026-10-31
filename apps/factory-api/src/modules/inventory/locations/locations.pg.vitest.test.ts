import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { keyOf } from '@nexus/factory-domain/imports/importer'
import { locationsImporter } from '@nexus/factory-domain/inventory/locations/importer'
import { command } from '../../../core/command'
import { IMPORTERS } from '../../../platform/imports/registry'
import { startInventoryFixture, type InventoryFixture } from '../ledger/testing/fixture'
import { locationsImportAdapter } from './importer'

/**
 * The locations of each site on the local stack (B-W1-22; SCM-176, SCM-177, SCM-178): the tree per site (the floor: its
 * own site's), create, rename, move and archive (only when empty), and the locations import's adapter. Run with
 * `node scripts/factory/run-pg-tests.mjs inventory`.
 */

type Json = Record<string, any>
let f: InventoryFixture
let ids: InventoryFixture['ids']
let serial = 0
const key = () => `loc-${Date.now()}-${++serial}`

async function create(body: Json, session = 'manager'): Promise<Json> {
  const response = await f.call(session, 'POST', '/inventory/locations', { siteId: ids.siteA1, kind: 'BIN', ...body })
  expect(response.statusCode, response.body).toBe(201)
  return response.json().location
}

beforeAll(async () => {
  f = await startInventoryFixture('locations')
  ids = f.ids
}, 60_000)

afterAll(async () => {
  await f?.close()
}, 60_000)

describe('the location tree (SCM-176)', () => {
  it('lists each site’s tree in order, with depth and path; the floor sees its own site only', async () => {
    const office = await f.call('viewer', 'GET', '/inventory/locations')
    expect(office.statusCode, office.body).toBe(200)
    const sites = office.json().sites as Json[]
    expect(sites.map((site) => site.code)).toEqual(['A1', 'A2', 'C1'])
    expect(sites[0]!.locations.map((location: Json) => [location.code, location.depth, location.path.join('/')])).toEqual([
      ['A1-CUT', 0, 'A1-CUT'],
      ['A1-STORE', 0, 'A1-STORE'],
      ['A1-BIN-01', 1, 'A1-STORE/A1-BIN-01'],
      ['A1-BIN-02', 1, 'A1-STORE/A1-BIN-02'],
    ])
    const floor = await f.call('floor-a2', 'GET', '/inventory/locations')
    expect(floor.statusCode, floor.body).toBe(200)
    expect(floor.json().sites.map((site: Json) => site.code)).toEqual(['A2'])
    expect((await f.call('floor-a2', 'GET', `/inventory/locations?siteId=${ids.siteA1}`)).json().sites).toEqual([])
    expect((await f.call('company-two', 'GET', '/inventory/locations')).json().sites.map((site: Json) => site.code)).toEqual(['C1'])
    expect((await f.call('manager-b', 'GET', '/inventory/locations')).json().sites.map((site: Json) => site.code)).toEqual(['B1'])
  })

  it('creates a location with its audit row; the code is upper case, unique on the site and never changes', async () => {
    const zone = await create({ code: 'a1-z1', name: 'Zone one', kind: 'ZONE', parentId: ids.store })
    expect(zone).toMatchObject({ code: 'A1-Z1', name: 'Zone one', kind: 'ZONE', parentId: ids.store, depth: 1, path: ['A1-STORE', 'A1-Z1'], status: 'ACTIVE', version: 1 })
    expect(await f.admin('SELECT action, audience FROM "AuditLog" WHERE "recordId" = $1', [zone.id])).toEqual([{ action: 'inventory.locations.create', audience: 'OFFICE' }])
    const again = await f.call('manager', 'POST', '/inventory/locations', { siteId: ids.siteA1, code: 'A1-Z1', name: 'Again', kind: 'ZONE' })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.message).toBe('Site A1 already has a location A1-Z1.')
    // The same code on another site is fine.
    await create({ siteId: ids.siteA2, code: 'A1-Z1', name: 'Same code, other site', kind: 'ZONE' })
    const bad = await f.call('manager', 'POST', '/inventory/locations', { siteId: ids.siteA1, code: 'A 1', name: 'x', kind: 'BIN' })
    expect(bad.json().error.issues).toEqual([{ path: 'body/code', message: 'Expected 1 to 40 upper-case letters, digits, dots, dashes or underscores (a bin label code).' }])
    const otherSiteParent = await f.call('manager', 'POST', '/inventory/locations', { siteId: ids.siteA1, code: 'A1-X', name: 'x', kind: 'BIN', parentId: ids.storeA2 })
    expect(otherSiteParent.json().error.issues).toEqual([{ path: 'body/parentId', message: 'Not a location of this site.' }])
    expect((await f.call('floor-a1', 'POST', '/inventory/locations', { siteId: ids.siteA1, code: 'A1-F', name: 'x', kind: 'BIN' })).statusCode).toBe(403)
    expect((await f.call('viewer', 'POST', '/inventory/locations', { siteId: ids.siteA1, code: 'A1-V', name: 'x', kind: 'BIN' })).statusCode).toBe(403)
    expect((await f.call('company-two', 'POST', '/inventory/locations', { siteId: ids.siteA1, code: 'A1-C', name: 'x', kind: 'BIN' })).statusCode).toBe(403)
    expect((await f.call('manager-b', 'POST', '/inventory/locations', { siteId: ids.siteA1, code: 'A1-B', name: 'x', kind: 'BIN' })).statusCode).toBe(404)
  })

  it('renames and retypes with the version guard; moves inside the tree, never inside itself', async () => {
    const zone = await create({ code: 'A1-Z2', name: 'Zone two', kind: 'ZONE' })
    const bin = await create({ code: 'A1-Z2-01', name: 'Bin', parentId: zone.id })
    const renamed = await f.call('manager', 'PATCH', `/inventory/locations/${zone.id}`, { version: 1, name: 'Leather zone', kind: 'WAREHOUSE' })
    expect(renamed.statusCode, renamed.body).toBe(200)
    expect(renamed.json().location).toMatchObject({ name: 'Leather zone', kind: 'WAREHOUSE', version: 2 })
    expect((await f.call('manager', 'PATCH', `/inventory/locations/${zone.id}`, { version: 1, name: 'Stale' })).statusCode).toBe(409)

    const cycle = await f.call('manager', 'POST', `/inventory/locations/${zone.id}/move`, { version: 2, parentId: bin.id })
    expect(cycle.statusCode).toBe(400)
    expect(cycle.json().error.issues).toEqual([{ path: 'body/parentId', message: 'A location does not sit inside itself or one of its own.' }])
    const moved = await f.call('manager', 'POST', `/inventory/locations/${zone.id}/move`, { version: 2, parentId: ids.store })
    expect(moved.statusCode, moved.body).toBe(200)
    expect(moved.json().location).toMatchObject({ parentId: ids.store, depth: 1, path: ['A1-STORE', 'A1-Z2'] })
    const top = await f.call('manager', 'POST', `/inventory/locations/${zone.id}/move`, { version: 3, parentId: null })
    expect(top.json().location).toMatchObject({ parentId: null, depth: 0 })
  })

  it('archives only an empty location with nothing active inside it; an archived one takes nothing inside it', async () => {
    const zone = await create({ code: 'A1-Z3', name: 'Zone three', kind: 'ZONE' })
    const bin = await create({ code: 'A1-Z3-01', name: 'Bin', parentId: zone.id })
    const withChild = await f.call('manager', 'POST', `/inventory/locations/${zone.id}/archive`, { version: 1 })
    expect(withChild.statusCode).toBe(409)
    expect(withChild.json().error.message).toBe('1 active location(s) sit inside it; archive or move them first.')

    const found = await f.call('manager', 'POST', '/inventory/adjustments', { siteId: ids.siteA1, itemId: ids.protector, locationId: bin.id, direction: 'IN', quantity: '2', note: 'Test stock.' }, key())
    expect(found.statusCode, found.body).toBe(201)
    const holding = await f.call('manager', 'POST', `/inventory/locations/${bin.id}/archive`, { version: 1 })
    expect(holding.statusCode).toBe(409)
    expect(holding.json().error.message).toBe('The location still holds stock; move it out (or adjust it) before archiving the location.')
    const out = await f.call('manager', 'POST', '/inventory/transfers', { siteId: ids.siteA1, itemId: ids.protector, fromLocationId: bin.id, toLocationId: ids.store, quantity: '2' }, key())
    expect(out.statusCode, out.body).toBe(201)

    const archived = await f.call('manager', 'POST', `/inventory/locations/${bin.id}/archive`, { version: 1 })
    expect(archived.statusCode, archived.body).toBe(200)
    expect(archived.json().location).toMatchObject({ status: 'ARCHIVED', version: 2 })
    expect((await f.call('manager', 'POST', `/inventory/locations/${bin.id}/archive`, { version: 2 })).statusCode).toBe(409)
    const inside = await f.call('manager', 'POST', '/inventory/locations', { siteId: ids.siteA1, code: 'A1-Z3-02', name: 'x', kind: 'BIN', parentId: bin.id })
    expect(inside.json().error.issues).toEqual([{ path: 'body/parentId', message: 'Location A1-Z3-01 is archived; nothing goes inside it.' }])
    const listed = (await f.call('viewer', 'GET', `/inventory/locations?siteId=${ids.siteA1}`)).json().sites[0].locations.map((location: Json) => location.code)
    expect(listed).not.toContain('A1-Z3-01')
    const all = (await f.call('viewer', 'GET', `/inventory/locations?siteId=${ids.siteA1}&includeArchived=true`)).json().sites[0].locations.map((location: Json) => location.code)
    expect(all).toContain('A1-Z3-01')
    expect((await f.call('manager', 'POST', `/inventory/locations/${newId()}/archive`, { version: 1 })).statusCode).toBe(404)
  })
})

describe('the locations import (adapter)', () => {
  it('is registered, loads by site and code in the job’s company, creates parents first and updates name, kind and parent', async () => {
    expect(IMPORTERS).toContain(locationsImportAdapter)
    const caller = f.system()
    const scope = { companyId: ids.companyA }
    const rows: Record<string, string>[] = [
      { site: 'A1', code: 'A1-IMP', name: 'Imported zone', kind: 'ZONE' },
      { site: 'A1', code: 'A1-IMP-01', name: 'Imported bin', kind: 'BIN', parent: 'A1-IMP' },
      { site: 'A1', code: 'A1-BIN-01', name: 'Bin one, renamed', kind: 'BIN', parent: 'A1-IMP' },
    ]
    const load = () =>
      command(caller, { name: 'test.loadLocations', input: {} }, async (tools) => {
        const found = await locationsImportAdapter.load(tools.tx, rows.map((row) => ({ site: row.site!, code: row.code! })), scope)
        tools.audit({ recordType: 'Site', recordId: ids.siteA1 })
        return found.map((record) => ({ ...record }))
      })
    const existing = (await load()).result
    expect(existing).toEqual([{ id: ids.bin1, values: { site: 'A1', code: 'A1-BIN-01', name: 'A1-BIN-01', kind: 'BIN', parent: 'A1-STORE', workshop: null } }])

    await command(caller, { name: 'test.applyLocations', input: {} }, async (tools) => {
      for (const row of rows) {
        const record = existing.find((entry) => entry.values.code === row.code) ?? null
        const plan = locationsImporter.plan(row, record)
        const keyValues = JSON.parse(keyOf(locationsImporter, row)!) as string[]
        if (plan.action === 'CREATE') await locationsImportAdapter.write(tools, { action: 'CREATE', key: { site: keyValues[0]!, code: keyValues[1]! }, recordId: null, before: {}, values: plan.after }, scope)
        if (plan.action === 'UPDATE') await locationsImportAdapter.write(tools, { action: 'UPDATE', key: { site: keyValues[0]!, code: keyValues[1]! }, recordId: record!.id, before: plan.before, values: plan.after }, scope)
      }
      return null
    })
    const tree = (await f.call('viewer', 'GET', `/inventory/locations?siteId=${ids.siteA1}`)).json().sites[0].locations as Json[]
    const path = (code: string) => tree.find((location) => location.code === code)?.path.join('/')
    expect(path('A1-IMP-01')).toBe('A1-IMP/A1-IMP-01')
    expect(path('A1-BIN-01')).toBe('A1-IMP/A1-BIN-01')
    expect(tree.find((location) => location.code === 'A1-BIN-01')).toMatchObject({ name: 'Bin one, renamed', version: 2 })
    expect(await f.admin(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'inventory.importLocation'`)).toEqual([{ n: 3 }])

    // A site of another company, or a parent the site does not have: the batch stops with the reason.
    await expect(
      command(caller, { name: 'test.applyLocations', input: { n: 2 } }, (tools) =>
        locationsImportAdapter.write(tools, { action: 'CREATE', key: { site: 'C1', code: 'C1-X' }, recordId: null, before: {}, values: { site: 'C1', code: 'C1-X', name: 'x', kind: 'BIN' } }, scope),
      ),
    ).rejects.toThrow('Site C1 is not a site of the import’s company.'.replace('’', "'"))
    await expect(
      command(caller, { name: 'test.applyLocations', input: { n: 3 } }, (tools) =>
        locationsImportAdapter.write(tools, { action: 'CREATE', key: { site: 'A1', code: 'A1-ORPHAN' }, recordId: null, before: {}, values: { site: 'A1', code: 'A1-ORPHAN', name: 'x', kind: 'BIN', parent: 'A1-NOPE' } }, scope),
      ),
    ).rejects.toThrow(/Parent A1-NOPE is not a location of the site yet/)
    // B-W2a-25, W2b B-W2b-25: a workshop's stock location names its workshop (the Workshop column); without one the batch stops.
    await expect(
      command(caller, { name: 'test.applyLocations', input: { n: 4 } }, (tools) =>
        locationsImportAdapter.write(tools, { action: 'CREATE', key: { site: 'A1', code: 'A1-TERZ' }, recordId: null, before: {}, values: { site: 'A1', code: 'A1-TERZ', name: 'x', kind: 'SUBCONTRACTOR' } }, scope),
      ),
    ).rejects.toThrow(/a Subcontractor location names its workshop/)
    await expect(
      command(caller, { name: 'test.applyLocations', input: { n: 5 } }, (tools) =>
        locationsImportAdapter.write(tools, { action: 'UPDATE', key: { site: 'A1', code: 'A1-BIN-01' }, recordId: ids.bin1, before: { kind: 'BIN' }, values: { kind: 'SUBCONTRACTOR' } }, scope),
      ),
    ).rejects.toThrow(/a workshop location stays one/)
  })
})
