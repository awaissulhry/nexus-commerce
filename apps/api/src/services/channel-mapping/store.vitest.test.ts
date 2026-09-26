/**
 * CHMAP M1/M2 — the mapping versions on a real PostgreSQL (PGlite, the production schema and every policy):
 * find-or-create by form, the Owner's decisions carried to a new version, activation rules, frozen active versions,
 * and business isolation (row-level security + the cross-business reference guard).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MappingForm } from '@nexus/shared/channel-mapping'
import { withWorkspace } from '../../lib/workspace-context.js'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})

const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const business = (id: string) => state.db.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [id])
const form = (fingerprint: string, extra: Partial<MappingForm> = {}): MappingForm => ({ channel: 'AMAZON', marketplace: 'IT', formKind: 'AMAZON_TEMPLATE', formKey: 'COAT+PANTS',
  templateIdentifier: 'tmpl-it', templateVersion: '2026.0713', language: 'it_IT', layout: { sheet: 'Modello', labelRow: 4, keyRow: 5, dataRow: 7 }, keyFingerprint: fingerprint, ...extra })
type Draft = import('./store.js').DraftRow
const row = (channelKey: string, extra: Partial<Draft> = {}): Draft => ({ channelKey, columnKey: channelKey, label: null, aliases: [], productTypes: [], requirement: 'optional', templateRequirement: null,
  targetKind: 'channelField', targetKey: channelKey.split('#')[0], transform: [{ op: 'copy' }], direction: 'both', state: 'mapped', reason: null, decidedBy: 'rule', sortOrder: 0, ...extra })
const rules = (): Draft[] => [row('contribution_sku#1.value', { targetKind: 'identity', targetKey: null, requirement: 'required' }), row('item_name[language_tag=it_IT]#1.value', { requirement: 'required' }),
  row('team_name[language_tag=it_IT]#1.value'), row('mystery#1.value', { state: 'unmapped', targetKind: 'none', targetKey: null })]

describe('CHMAP — mapping versions in the database', () => {
  let store: typeof import('./store.js')
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    store = await import('./store.js')
    for (const id of ['BIZ_A', 'BIZ_B']) await business(id)
  }, 120_000)
  afterAll(async () => { vi.unstubAllEnvs(); await state.db?.close() }, 30_000)
  const inA = <T>(work: () => Promise<T>) => withWorkspace(scope('BIZ_A'), work)
  const inB = <T>(work: () => Promise<T>) => withWorkspace(scope('BIZ_B'), work)

  it('a new form gets DRAFT v1; the same columns find it again; new columns make v2 with the Owner’s decisions', async () => {
    const first = await inA(() => store.ensureSetForForm(form('fp-1'), rules))
    expect(first.created).toBe(true)
    expect(first.set).toMatchObject({ version: 1, status: 'DRAFT', source: 'FILE', templateVersion: '2026.0713' })
    expect((await inA(() => store.ensureSetForForm(form('fp-1'), rules))).set.id).toBe(first.set.id)
    await inA(() => store.decideField(first.set.id, 'team_name[language_tag=it_IT]#1.value', { state: 'ignored', reason: 'Amazon workaround' }))
    const next = await inA(() => store.ensureSetForForm(form('fp-2', { templateIdentifier: 'tmpl-it-2', templateVersion: '2026.0801' }), () => [...rules(), row('style#1.value')]))
    expect(next).toMatchObject({ created: true })
    expect(next.set).toMatchObject({ version: 2, basedOnId: first.set.id })
    const team = next.set.fields.find(f => f.channelKey === 'team_name[language_tag=it_IT]#1.value')!
    expect(team).toMatchObject({ state: 'ignored', decidedBy: 'owner', reason: 'Amazon workaround' })
    expect(next.set.fields).toHaveLength(5)
  })

  it('refuses to activate while a REQUIRED column is unmapped; activation retires the ACTIVE version; an ACTIVE version is frozen', async () => {
    const { set } = await inA(() => store.ensureSetForForm(form('fp-3', { formKey: 'COAT' }), () => [...rules(), row('brand#1.value', { state: 'unmapped', targetKind: 'none', targetKey: null, requirement: 'required' })]))
    await expect(inA(() => store.activateSet(set.id))).rejects.toThrow(/1 required column is not mapped \(brand#1\.value\)/)
    await expect(inA(() => store.decideField(set.id, 'brand#1.value', { state: 'ignored' }))).rejects.toThrow(/Say why/)
    await inA(() => store.decideField(set.id, 'brand#1.value', { state: 'mapped', targetKind: 'channelField', targetKey: 'brand' }))
    const active = await inA(() => store.activateSet(set.id, 'owner'))
    expect(active).toMatchObject({ status: 'ACTIVE', counts: { requiredUnmapped: 0 } })
    await expect(inA(() => store.decideField(set.id, 'team_name[language_tag=it_IT]#1.value', { state: 'ignored', reason: 'x' }))).rejects.toThrow(/is active and cannot change/)
    await expect(inA(() => store.decideField(set.id, 'contribution_sku#1.value', { state: 'ignored', reason: 'x' }))).rejects.toThrow(/cannot change|is active/)
    const copy = await inA(() => store.newVersionFrom(set.id, 'owner'))
    expect(copy).toMatchObject({ status: 'DRAFT', version: 2, basedOnId: set.id, source: 'EDIT' })
    await expect(inA(() => store.decideField(copy.id, 'contribution_sku#1.value', { state: 'ignored', reason: 'x' }))).rejects.toThrow(/SKU, product-type and action columns/)
    const second = await inA(() => store.activateSet(copy.id, 'owner'))
    expect(second.status).toBe('ACTIVE')
    expect((await inA(() => store.getSet(set.id))).status).toBe('RETIRED')
    // Re-activating the retired version is the rollback: the other one retires.
    await inA(() => store.activateSet(set.id, 'owner'))
    expect((await inA(() => store.getSet(copy.id))).status).toBe('RETIRED')
    const actives = await state.db.db.query(`SELECT count(*)::int AS n FROM "ChannelMappingSet" WHERE "formKey" = 'COAT' AND status = 'ACTIVE'`)
    expect(actives.rows[0].n).toBe(1)
  })

  it('records every use of a version', async () => {
    const { set } = await inA(() => store.ensureSetForForm(form('fp-1'), rules))
    await inA(() => store.recordUse(set.id, 'IMPORT', 'Modello', { rows: 3 }))
    const uses = await inA(() => store.listUses(set.id))
    expect(uses[0]).toMatchObject({ action: 'IMPORT', reference: 'Modello', detail: { rows: 3 } })
  })

  it('keeps each business’s mappings to itself (row-level security and the reference guard)', async () => {
    const aSets = await inA(() => store.listSets())
    expect(aSets.length).toBeGreaterThan(0)
    expect(await inB(() => store.listSets())).toEqual([])
    await expect(inB(() => store.getSet(aSets[0].id))).rejects.toThrow(/does not exist/)
    // B cannot hang a field or a use on A's version.
    const { default: prisma } = await import('../../db.js')
    await expect(inB(() => prisma.channelMappingField.create({ data: { setId: aSets[0].id, channelKey: 'x', targetKind: 'none', state: 'unmapped' } }))).rejects.toThrow()
    await expect(inB(() => prisma.channelMappingUse.create({ data: { setId: aSets[0].id, action: 'IMPORT' } }))).rejects.toThrow()
    // B's own copy of the same form is its own v1.
    const own = await inB(() => store.ensureSetForForm(form('fp-1'), rules))
    expect(own.set.version).toBe(1)
    expect(own.set.workspaceId).toBe('BIZ_B')
  })
})
