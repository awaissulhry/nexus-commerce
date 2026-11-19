import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DESIGNER_WORDS, designerWords } from '@nexus/factory-domain/auth/partners/designer'
import { newId } from '@nexus/factory-domain/core/ids'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../abuse/guard'
import { usePortalOptions } from '../portal/service'
import { addPartner, freshGuard, inWorld, mailedCode, portalBrowser, portalWorld, type PortalWorld } from '../portal/testing/portal'
import { addTenant, addUser, Browser, enrolTotp, startHarness, stepUp, type Answer, type Harness, type TestTenant } from '../sessions/testing/harness'

/**
 * B-CP-078 (customer page plan C7, D12; 12 §5; review C4, F7; lead pick: no step-up; wall W-CP-5) on the local stack, through the
 * real app: an office Owner signed in with two-factor, the portal of a made-up customer (Brand Alpha) and a second one (Brand
 * Beta), office people holding threads.read + threads.post over Alpha (Giulia), over every customer (Marta), over Beta only
 * (Bruno), threads.read only (Nora), a suspended one (Sara), and an office person who manages partners of Beta only.
 *
 *   - the slot's rules at the field: a backup alone, the same person twice, a person who does not reach Alpha (NO_REACH), one no
 *     longer active, a portal person or an unknown id (NOT_OFFICE); the pick list names only who may be named; the stored version
 *     (stale: 409; nothing changes: 409); no step-up; a customer without settings gets its row with the portal OFF; a supplier: 409;
 *   - the office read says "No longer reaches Brand Alpha" / "No longer active" for a person named before (they stay named);
 *   - the portal reads ONE display name — the designer's while active, else the backup's, else none — never an id, an e-mail, a
 *     role or whether two names exist; Beta never reads Alpha's name (W-CP-5); with the portal off, no name at all;
 *   - an office person limited to Beta reads, lists and changes nothing of Alpha's: "Customer not found.", word for word an
 *     unknown id's;
 *   - the made-to-measure drafts switch on Portal settings (on by default).
 * Every name is made up. Run with `node scripts/factory/run-pg-tests.mjs platform/auth/partners/designer`.
 */

type Json = Record<string, any>
const SLUG = 'designer-cp078'
let h: Harness
let tenant: TestTenant
let world: PortalWorld
let owner: Browser
let ownerSecret: string
let limited: Browser
let betaPartyId = ''
let serial = 0
const P = {} as Record<'giulia' | 'marta' | 'bruno' | 'nora' | 'sara', string>
const NAMES = { giulia: 'Made-up Giulia Verdi', marta: 'Made-up Marta Bianchi', bruno: 'Made-up Bruno Neri', nora: 'Made-up Nora Gialli', sara: 'Made-up Sara Rosa' }
let alphaBuyer = ''
const ALPHA_BUYER = 'anna.buyer.cp078@brand-alpha.example'
const BETA_BUYER = 'berta.buyer.cp078@brand-beta.example'

const url = (partyId: string, tail = '') => `/partners/${partyId}/factory-designer${tail}`
const send = (browser: Browser, method: 'GET' | 'PUT', path: string, body?: unknown): Promise<Answer> =>
  method === 'GET' ? browser.get(path) : browser.send('PUT', path, body, { headers: { 'idempotency-key': `cp078-key-${++serial}` } })
async function ok(browser: Browser, method: 'GET' | 'PUT', path: string, body?: unknown): Promise<Json> {
  const answer = await send(browser, method, path, body)
  expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.body)}`).toBe(200)
  return answer.body as Json
}
const issuesOf = (answer: Answer): Json[] => answer.body?.error?.issues ?? []

/** An office person with a made-up role of these permissions, over these customers ([]: every customer). */
async function officePerson(key: keyof typeof P, permissions: string[], parties: string[], status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE'): Promise<string> {
  const id = newId()
  const roleId = newId()
  await inWorld(h, world, async (client) => {
    await client.user.create({ data: { id, email: `${key}.cp078@example.com`, displayName: NAMES[key], status, audience: 'OFFICE' }, select: { id: true } })
    await client.role.create({ data: { id: roleId, key: `t-cp078-${key}`, name: `T ${key} (made up)`, audience: 'OFFICE', permissions, grains: [] }, select: { id: true } })
    await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId, allCompanies: true, partyIds: parties, validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
  })
  return id
}

async function portalSignIn(email: string): Promise<Browser> {
  const browser = await portalBrowser(h)
  h.clock.advance(61_000)
  expect((await browser.post('/portal/signin/start', { tenant: SLUG, company: 'C1', email })).status).toBe(200)
  await h.auth.settled()
  const answer = await browser.post('/portal/signin/code', { tenant: SLUG, company: 'C1', email, code: mailedCode(h, email)!.code })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const terms = await browser.get('/portal/terms?locale=en')
  expect((await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
  return browser
}

const setStatus = (userId: string, status: 'ACTIVE' | 'SUSPENDED') => h.db.admin.query('UPDATE "User" SET status = $2::"UserStatus" WHERE id = $1', [userId, status])

beforeAll(async () => {
  h = await startHarness('partners_cp078')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  tenant = await addTenant(h, SLUG, 1)
  world = await portalWorld(h, tenant)
  betaPartyId = newId()
  await inWorld(h, world, async (client) => {
    await client.party.create({ data: { id: betaPartyId, code: `P${betaPartyId.slice(-6)}`, kind: 'ORGANISATION', legalName: 'Brand Beta S.r.l.', tradeName: 'Brand Beta', roles: ['CUSTOMER'] }, select: { id: true } })
    await client.portalSettings.create({ data: { id: betaPartyId, partyId: betaPartyId, portalOn: true }, select: { id: true } })
  })
  const threads = ['threads.read', 'threads.post']
  P.giulia = await officePerson('giulia', threads, [world.partyId])
  P.marta = await officePerson('marta', threads, [])
  P.bruno = await officePerson('bruno', threads, [betaPartyId])
  P.nora = await officePerson('nora', ['threads.read'], [])
  P.sara = await officePerson('sara', threads, [], 'SUSPENDED')
  const ownerUser = await addUser(h, tenant, { email: 'owner.cp078@example.com', role: 'owner' })
  owner = new Browser(h.app)
  await owner.signIn(SLUG, ownerUser.email, ownerUser.password)
  ownerSecret = await enrolTotp(h, owner)
  // An office person who manages partners of Beta only (W-CP-5: Alpha is not there for them).
  const limitedUser = await addUser(h, tenant, { email: 'limited.cp078@example.com' })
  await inWorld(h, world, async (client) => {
    const roleId = newId()
    await client.role.create({ data: { id: roleId, key: 't-cp078-partners-beta', name: 'T partners of Beta (made up)', audience: 'OFFICE', permissions: ['partners.view', 'partners.manage', 'threads.read', 'threads.post'], grains: [] }, select: { id: true } })
    await client.roleAssignment.create({ data: { id: newId(), userId: limitedUser.id, roleId, allCompanies: true, partyIds: [betaPartyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
  })
  limited = new Browser(h.app)
  await limited.signIn(SLUG, limitedUser.email, limitedUser.password)
  // The portal people: Alpha's buyer and Beta's.
  alphaBuyer = await addPartner(h, world, ALPHA_BUYER)
  await inWorld(h, world, async (client) => {
    const id = newId()
    await client.user.create({ data: { id, email: BETA_BUYER, displayName: 'Made-up Berta Buyer', status: 'ACTIVE', audience: 'PARTNER', partyId: betaPartyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: world.roleId, allCompanies: true, partyIds: [betaPartyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
  })
}, 300_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

describe('B-CP-078: the factory designer slot', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('names a designer and a backup by the slot’s rules, at the field; the pick list names only who may be named; no step-up', async () => {
    const empty = await ok(owner, 'GET', url(world.partyId))
    expect(empty.factoryDesigner).toMatchObject({ partyId: world.partyId, designer: null, backup: null, since: null, portalOn: true, mayManage: true })
    const version = empty.factoryDesigner.version as number
    const choices = await ok(owner, 'GET', url(world.partyId, '/choices'))
    const named = choices.people.map((person: Json) => person.id)
    expect(named).toEqual(expect.arrayContaining([P.giulia, P.marta]))
    for (const out of [P.bruno, P.nora, P.sara, alphaBuyer]) expect(named).not.toContain(out)
    expect(JSON.stringify(choices)).not.toMatch(/@/)
    // Refused at the field, before anything is written (the owner asked no step-up for any of this).
    const at = async (body: Json, path: string, word: string) => {
      const refused = await send(owner, 'PUT', url(world.partyId), { version, ...body })
      expect(refused.status, JSON.stringify(body)).toBe(400)
      expect(issuesOf(refused)).toContainEqual({ path, message: word })
    }
    await at({ designerId: null, backupId: P.marta }, 'body/backupId', DESIGNER_WORDS.BACKUP_ALONE.en)
    await at({ designerId: P.giulia, backupId: P.giulia }, 'body/backupId', DESIGNER_WORDS.SAME_PERSON.en)
    await at({ designerId: P.nora, backupId: null }, 'body/designerId', designerWords('NO_REACH', 'Brand Alpha').en)
    await at({ designerId: P.bruno, backupId: null }, 'body/designerId', designerWords('NO_REACH', 'Brand Alpha').en)
    await at({ designerId: P.sara, backupId: null }, 'body/designerId', DESIGNER_WORDS.NOT_ACTIVE.en)
    await at({ designerId: alphaBuyer, backupId: null }, 'body/designerId', DESIGNER_WORDS.NOT_OFFICE.en)
    await at({ designerId: newId(), backupId: null }, 'body/designerId', DESIGNER_WORDS.NOT_OFFICE.en)
    const saved = await ok(owner, 'PUT', url(world.partyId), { designerId: P.giulia, backupId: P.marta, version })
    expect(saved.factoryDesigner).toMatchObject({ designer: { id: P.giulia, name: NAMES.giulia, state: 'OK', words: null }, backup: { id: P.marta, name: NAMES.marta, state: 'OK', words: null }, since: expect.any(String), version: version + 1 })
    const settings = (await h.db.admin.query('SELECT "factoryDesignerId", "factoryDesignerSetAt", "factoryDesignerBackupId" FROM "PortalSettings" WHERE id = $1', [world.partyId])).rows[0]
    expect(settings).toMatchObject({ factoryDesignerId: P.giulia, factoryDesignerBackupId: P.marta })
    expect(settings.factoryDesignerSetAt).not.toBeNull()
    // The stored version: a stale one is a 409; the same names again change nothing (409 in words).
    expect((await send(owner, 'PUT', url(world.partyId), { designerId: P.marta, backupId: null, version })).status).toBe(409)
    const same = await send(owner, 'PUT', url(world.partyId), { designerId: P.giulia, backupId: P.marta, version: version + 1 })
    expect(same.status).toBe(409)
    expect(same.body.error.message).toBe(DESIGNER_WORDS.NOTHING_CHANGES.en)
    const audits = (await h.db.admin.query(`SELECT after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'partners.setFactoryDesigner' AND "recordId" = $2`, [tenant.id, world.partyId])).rows
    expect(audits).toEqual([{ after: { factoryDesignerId: P.giulia, factoryDesignerBackupId: P.marta } }])
  })

  it('a customer without settings gets its row with the portal OFF; a supplier has no factory designer', async () => {
    const gamma = newId()
    const supplier = newId()
    await inWorld(h, world, async (client) => {
      await client.party.create({ data: { id: gamma, code: `P${gamma.slice(-6)}`, kind: 'ORGANISATION', legalName: 'Brand Gamma S.r.l.', roles: ['CUSTOMER'] }, select: { id: true } })
      await client.party.create({ data: { id: supplier, code: `P${supplier.slice(-6)}`, kind: 'ORGANISATION', legalName: 'Made-up Supplier S.r.l.', roles: ['SUPPLIER'] }, select: { id: true } })
    })
    const made = await ok(owner, 'PUT', url(gamma), { designerId: P.marta, backupId: null, version: 0 })
    expect(made.factoryDesigner).toMatchObject({ designer: { id: P.marta, state: 'OK' }, portalOn: false, version: 1 })
    const refused = await send(owner, 'PUT', url(supplier), { designerId: P.marta, backupId: null, version: 0 })
    expect(refused.status).toBe(409)
    expect(refused.body.error.message).toBe(DESIGNER_WORDS.ONLY_CUSTOMERS.en)
  })

  it('the office read says "No longer reaches Brand Alpha" and "No longer active" for a person named before (they stay named)', async () => {
    await h.db.admin.query(`UPDATE "RoleAssignment" SET "partyIds" = ARRAY[$2]::uuid[] WHERE "userId" = $1`, [P.giulia, betaPartyId])
    await setStatus(P.marta, 'SUSPENDED')
    try {
      const read = await ok(owner, 'GET', url(world.partyId))
      expect(read.factoryDesigner.designer).toMatchObject({ id: P.giulia, state: 'NO_REACH', words: designerWords('NO_LONGER_REACHES', 'Brand Alpha') })
      expect(read.factoryDesigner.backup).toMatchObject({ id: P.marta, state: 'NOT_ACTIVE', words: DESIGNER_WORDS.NO_LONGER_ACTIVE })
    } finally {
      await h.db.admin.query(`UPDATE "RoleAssignment" SET "partyIds" = ARRAY[$2]::uuid[] WHERE "userId" = $1`, [P.giulia, world.partyId])
      await setStatus(P.marta, 'ACTIVE')
    }
  })

  it('the portal reads ONE name — the designer’s while active, else the backup’s, else none; Beta never reads Alpha’s (W-CP-5)', async () => {
    const alpha = await portalSignIn(ALPHA_BUYER)
    const beta = await portalSignIn(BETA_BUYER)
    const read = await alpha.get('/portal/factory-designer')
    expect(read.status, JSON.stringify(read.body)).toBe(200)
    expect(read.body).toEqual({ name: NAMES.giulia })
    // Never an id, an e-mail or a role; never whether two names exist.
    expect(JSON.stringify(read.body)).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}-|Marta|backup|designer/i)
    expect((await beta.get('/portal/factory-designer')).body).toEqual({ name: null })
    await setStatus(P.giulia, 'SUSPENDED')
    try {
      expect((await alpha.get('/portal/factory-designer')).body).toEqual({ name: NAMES.marta })
      await setStatus(P.marta, 'SUSPENDED')
      expect((await alpha.get('/portal/factory-designer')).body).toEqual({ name: null })
    } finally {
      await setStatus(P.giulia, 'ACTIVE')
      await setStatus(P.marta, 'ACTIVE')
    }
    expect(JSON.stringify((await beta.get('/portal/factory-designer')).body)).not.toContain('Giulia')
    // The portal switched off: no name reaches the customer at all.
    await h.db.admin.query('UPDATE "PortalSettings" SET "portalOn" = false WHERE id = $1', [world.partyId])
    try {
      const off = await alpha.get('/portal/factory-designer')
      expect(off.status).not.toBe(200)
      expect(JSON.stringify(off.body)).not.toContain('Giulia')
    } finally {
      await h.db.admin.query('UPDATE "PortalSettings" SET "portalOn" = true WHERE id = $1', [world.partyId])
    }
  })

  it('W-CP-5: an office person limited to Beta reads, lists and changes nothing of Alpha’s — word for word an unknown id', async () => {
    for (const [method, tail, body] of [
      ['GET', '', undefined],
      ['GET', '/choices', undefined],
      ['PUT', '', { designerId: P.bruno, backupId: null, version: 1 }],
    ] as const) {
      const alpha = await send(limited, method, url(world.partyId, tail), body)
      const unknown = await send(limited, method, url(newId(), tail), body)
      expect(alpha.status, `${method} ${tail}`).toBe(404)
      expect(unknown.status).toBe(404)
      expect(alpha.body.error.message).toBe('Customer not found.')
      expect(alpha.body.error.message).toBe(unknown.body.error.message)
      expect(JSON.stringify(alpha.body)).not.toMatch(/Alpha|Giulia/)
    }
    // Beta is theirs: Bruno (who reaches Beta) is named there.
    expect((await ok(limited, 'PUT', url(betaPartyId), { designerId: P.bruno, backupId: null, version: 1 })).factoryDesigner.designer).toMatchObject({ id: P.bruno, state: 'OK' })
  })

  it('the made-to-measure drafts switch on Portal settings: on by default, the office may switch one customer off', async () => {
    const tab = await owner.get(`/partners/${world.partyId}`)
    expect(tab.body.settings).toMatchObject({ mtmDraftsOn: true })
    await stepUp(h, owner, ownerSecret)
    const off = await owner.post(`/partners/${world.partyId}/settings`, { mtmDraftsOn: false, version: tab.body.settings.version })
    expect(off.status, JSON.stringify(off.body)).toBe(200)
    expect(off.body.settings).toMatchObject({ mtmDraftsOn: false })
    await stepUp(h, owner, ownerSecret)
    expect((await owner.post(`/partners/${world.partyId}/settings`, { mtmDraftsOn: true, version: off.body.settings.version })).body.settings).toMatchObject({ mtmDraftsOn: true })
  })
})
