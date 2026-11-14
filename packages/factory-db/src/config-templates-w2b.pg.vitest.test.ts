import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DOCUMENT_TYPES } from '@nexus/factory-domain/documents/model'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedFiles } from '../seed/files'
import { seed as seedConfig, type ConfigSeed } from '../seed/w2b6-config'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { DocumentTemplateKind } from './generated/prisma/enums'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Configuration without code (W2b-6, schema wave 56/57, B-W2b-379, …_config_templates_w2b_guards) on a database built from the
 * migrations and seeded twice, through the real login and its scopes:
 *   - custom fields: a record type that is a table of the tenant, the code and its key, labels, a unit only on NUMBER, the
 *     grain exactly with the MONEY audience, the portal only for what everyone sees or a price, a list exactly on a select
 *     field (its company's or every company's, active), a linked record type exactly on LINK; fixed once made; archived,
 *     never deleted;
 *   - their values: of a record that exists (of the field's company), one per field and record, in the shape of the field's
 *     type (a list's code active when new, an office person, a record of the linked type, an available file of the record),
 *     changed forward; an archived field's values kept as they are;
 *   - picklists and their values: codes and keys, swatch and icon, added to an active list, deactivated not deleted, a list
 *     archived only once no active field picks from it;
 *   - document and e-mail template versions: born DRAFT, published once, one ACTIVE per company, kind or event and language,
 *     words frozen once published, RETIRED frozen whole, only a DRAFT removed; placeholders only as {{name}};
 *   - saved replies: an office person's own or shared, a record type of the tenant, placeholders;
 *   - a quote template line's options: not on a fee, of a group the style offers, the free text and what the group takes; the
 *     line keeps its style while it has options; a group's takes change refused while a template option picks the other kind;
 *     removed with the line.
 * The refusals are check_violation (23514) in words, the unique keys' 23505, or the grants' permission denied.
 */

const NS = 'w2b-379-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: ConfigSeed

const key = (name: string): string => seedUuid(NS, name)
/** The id of a seed's first row (eight zeros, as the seeds give it). */
const firstKey = (name: string): string => `00000000${key(name).slice(8)}`
const A = {
  companyA: key('company:A'),
  companyB: key('company:B'),
  siteA1: key('site:A1'),
  siteB1: key('site:B1'),
  member: key('user:member'),
  store: key('files:account:r2'),
  P1: key('party:P1'),
  seasonTemplate: firstKey('sales-pricing:template:SEASON'),
}
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (text: string, ...values: unknown[]) => as(office(), (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const insert = (table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ')
  return run(`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row))
}
/** Runs `work` as the owner login with every trigger off for its own transaction (fixtures of other waves only). */
async function asReplica(work: () => Promise<unknown>): Promise<void> {
  await db.admin.query('BEGIN')
  try {
    await db.admin.query("SET LOCAL session_replication_role = 'replica'")
    await work()
    await db.admin.query('COMMIT')
  } catch (error) {
    await db.admin.query('ROLLBACK')
    throw error
  }
}
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const code = (): string => `t_${randomUUID().slice(0, 8)}`

/** A custom field of company A (unless `companyId` is given) on a record type, TEXT unless given. */
async function field(recordType: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  const fieldCode = (extra.code as string | undefined) ?? code()
  expect(
    await insert('CustomField', {
      id,
      companyId: A.companyA,
      recordType,
      code: fieldCode,
      key: `field:${recordType}:${fieldCode}`,
      type: 'TEXT',
      labelIt: 'Campo di prova',
      labelEn: 'Test field',
      ...extra,
    }),
  ).toBe(1)
  return id
}
const setField = (id: string, assignments: string, ...values: unknown[]) => run(`UPDATE "CustomField" SET ${assignments} WHERE id = $1::uuid`, id, ...values)
/** A value of a field on a record (its record type given), written now by the test's actor. */
async function value(fieldId: string, recordType: string, recordId: string, val: unknown, extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  expect(
    await insert('CustomFieldValue', { id, fieldId, recordType, recordId, key: `value:${fieldId}:${recordId}`, value: val, changedAt: new Date().toISOString(), changedById: a.actorId, ...extra }),
  ).toBe(1)
  return id
}
const setValue = (id: string, val: unknown) => run(`UPDATE "CustomFieldValue" SET value = $2::jsonb, "changedAt" = now() WHERE id = $1::uuid`, id, JSON.stringify(val))
/** A picklist of company A (unless given) with the codes given (active). */
async function list(codes: readonly string[], extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  const listCode = code()
  expect(await insert('Picklist', { id, companyId: A.companyA, code: listCode, key: `picklist:${listCode}`, labelIt: 'Lista di prova', labelEn: 'Test list', ...extra })).toBe(1)
  for (const [index, entry] of codes.entries()) expect(await option(id, entry, { sortOrder: index })).toBe(1)
  return id
}
const option = (picklistId: string, entry: string, extra: Record<string, unknown> = {}) =>
  insert('PicklistValue', { id: randomUUID(), picklistId, code: entry, key: `option:${picklistId}:${entry}`, labelIt: entry, labelEn: entry, ...extra })
/** An AVAILABLE file of a record. */
async function file(recordType: string, recordId: string): Promise<string> {
  const id = randomUUID()
  await insert('StoredFile', {
    id,
    companyId: A.companyA,
    recordType,
    recordId,
    kind: 'DOCUMENT',
    originalName: 'Test certificate.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    sha256: sha(id),
    storeAccountId: A.store,
    storageKey: `t/${a.tenantId}/c/${A.companyA}/2026/${randomUUID()}`,
    status: 'AVAILABLE',
    availableAt: new Date().toISOString(),
  })
  return id
}
/** A DRAFT document template version of company A. */
async function documentTemplate(kind: string, language: string, revision: number, extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  expect(await insert('DocumentTemplate', { id, companyId: A.companyA, kind, language, revision, key: `doc:${kind}:${A.companyA}:${language}:${revision}`, ...extra })).toBe(1)
  return id
}
const setDocument = (id: string, assignments: string, ...values: unknown[]) => run(`UPDATE "DocumentTemplate" SET ${assignments} WHERE id = $1::uuid`, id, ...values)
const publish = (table: string, id: string) => run(`UPDATE "${table}" SET status = 'ACTIVE', "publishedAt" = now(), "publishedById" = $2::uuid WHERE id = $1::uuid`, id, a.actorId)
const retire = (table: string, id: string) => run(`UPDATE "${table}" SET status = 'RETIRED', "retiredAt" = now() WHERE id = $1::uuid`, id)
/** A DRAFT e-mail template version (company A's unless `companyId` is given). */
async function emailTemplate(event: string, language: string, revision: number, extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  const companyId = 'companyId' in extra ? (extra.companyId as string | null) : A.companyA
  expect(
    await insert('EmailTemplate', {
      id,
      companyId,
      event,
      language,
      revision,
      key: `mail:${event}:${companyId ?? 'all'}:${language}:${revision}`,
      subject: 'Test {{record.number}}',
      body: 'Hello {{contact.name}},\nmade-up words.',
      ...extra,
    }),
  ).toBe(1)
  return id
}
const reply = (extra: Record<string, unknown> = {}) => insert('MessageTemplate', { id: randomUUID(), name: 'Test reply', language: 'en', body: 'Hello {{contact.name}}.', ...extra })
const templateOption = (row: Record<string, unknown>) => insert('QuoteTemplateLineOption', { id: randomUUID(), lineId: s.records.seasonLine, ...row })
const options = {
  liner: firstKey('options:group:LINER'),
  linerYes: firstKey('options:value:LINER:YES'),
  name: key('options:group:NAME'),
  nameValue: key('options:value:NAME:NAME'),
  perforation: key('options:group:PERF'),
  perfFront: key('options:value:PERF:FRONT'),
}

beforeAll(async () => {
  db = await migratedDatabase('configw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedFiles({ db: factory, namespace: NS })
  s = await seedConfig({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent.
  await seedConfig({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the seed', () => {
  it('runs twice and leaves one of each row', async () => {
    const [counts] = await admin(
      `SELECT (SELECT count(*)::int FROM "CustomField" WHERE "tenantId" = $1::uuid) AS fields,
              (SELECT count(*)::int FROM "CustomField" WHERE "tenantId" = $1::uuid AND status = 'ARCHIVED') AS archived,
              (SELECT count(*)::int FROM "CustomFieldValue" WHERE "tenantId" = $1::uuid) AS "values",
              (SELECT count(*)::int FROM "Picklist" WHERE "tenantId" = $1::uuid) AS lists,
              (SELECT count(*)::int FROM "PicklistValue" WHERE "tenantId" = $1::uuid AND NOT active) AS deactivated,
              (SELECT count(*)::int FROM "DocumentTemplate" WHERE "tenantId" = $1::uuid) AS documents,
              (SELECT count(*)::int FROM "EmailTemplate" WHERE "tenantId" = $1::uuid) AS mails,
              (SELECT count(*)::int FROM "MessageTemplate" WHERE "tenantId" = $1::uuid) AS replies,
              (SELECT count(*)::int FROM "QuoteTemplateLineOption" WHERE "tenantId" = $1::uuid) AS "templateOptions"`,
      [a.tenantId],
    )
    expect(counts).toEqual({ fields: 12, archived: 1, values: 10, lists: 2, deactivated: 1, documents: 4, mails: 3, replies: 4, templateOptions: 2 })
    const states = await admin(`SELECT revision, status::text FROM "DocumentTemplate" WHERE "tenantId" = $1::uuid AND kind = 'QUOTE' ORDER BY revision`, [a.tenantId])
    expect(states).toEqual([
      { revision: 1, status: 'RETIRED' },
      { revision: 2, status: 'ACTIVE' },
      { revision: 3, status: 'DRAFT' },
    ])
  })

  it('names the documents of factory-domain value for value', () => {
    expect(Object.values(DocumentTemplateKind).sort()).toEqual([...DOCUMENT_TYPES].sort())
  })
})

describe('custom fields (PLT-111)', () => {
  it('are added to a record type that is a table of the tenant, by a code once per record type', async () => {
    await expect(field('NoSuchModel')).rejects.toThrow(/is added to a record type that is a table of the tenant/)
    await expect(field('Tenant')).rejects.toThrow(/is added to a record type that is a table of the tenant/)
    await expect(field('Style', { code: 'Bad-Code' })).rejects.toThrow(/lower-case letters, digits and underscores/)
    await expect(field('Style', { code: 'colour_code', key: 'field:Party:colour_code' })).rejects.toThrow(/the key of custom field .* is field:<record type>:<code>/)
    await expect(field('Style', { code: 'care_code' })).rejects.toThrow(/duplicate key|unique constraint/)
    // Another record type may use the same code.
    expect(await field('Party', { code: 'care_code' })).toBeTruthy()
    await expect(field('Style', { labelEn: 'two\nlines' })).rejects.toThrow(/a label in Italian and in English/)
    await expect(field('Style', { section: 'Not a key' })).rejects.toThrow(/form section named by its key/)
    await expect(field('Style', { sortOrder: 10_000 })).rejects.toThrow(/at a place from 0 to 9999/)
  })

  it('keep a unit for numbers only, and the grain exactly for money only some see', async () => {
    await expect(field('Item', { unit: 'mm' })).rejects.toThrow(/only a NUMBER field has a unit/)
    expect(await field('Item', { type: 'NUMBER', unit: 'mm' })).toBeTruthy()
    await expect(field('SalesOrder', { type: 'MONEY' })).rejects.toThrow(/money field .* is seen only by people with its grain/)
    await expect(field('SalesOrder', { type: 'MONEY', audience: 'MONEY' })).rejects.toThrow(/names the grain of its money .* exactly when only people with that grain see it/)
    await expect(field('SalesOrder', { type: 'MONEY', audience: 'MONEY', grain: 'gold' })).rejects.toThrow(/names the grain of its money/)
    await expect(field('SalesOrder', { grain: 'cost' })).rejects.toThrow(/names the grain of its money/)
    expect(await field('SalesOrder', { type: 'MONEY', audience: 'MONEY', grain: 'cost' })).toBeTruthy()
    // A number only some see (a margin percent).
    expect(await field('SalesOrder', { type: 'NUMBER', audience: 'MONEY', grain: 'margin' })).toBeTruthy()
  })

  it('show in the portal only what every office person sees, or a price', async () => {
    await expect(field('SalesOrder', { audience: 'PERSONAL', shownInPortal: true })).rejects.toThrow(/shown in the portal only when every office person sees it or it is a price/)
    await expect(field('SalesOrder', { type: 'MONEY', audience: 'MONEY', grain: 'cost', shownInPortal: true })).rejects.toThrow(/shown in the portal only/)
    expect(await field('SalesOrder', { type: 'MONEY', audience: 'MONEY', grain: 'price', shownInPortal: true })).toBeTruthy()
    expect(await field('SalesOrder', { shownInPortal: true })).toBeTruthy()
  })

  it('pick from a list exactly when a select, of their company or every company, while the list is active', async () => {
    await expect(field('Style', { type: 'SELECT' })).rejects.toThrow(/picks from a list exactly when it is a SELECT or MULTI_SELECT field/)
    await expect(field('Style', { picklistId: s.picklistIds.lining })).rejects.toThrow(/picks from a list exactly when/)
    expect(await field('Style', { type: 'MULTI_SELECT', picklistId: s.picklistIds.lining })).toBeTruthy()
    // A field of every company takes no company's list; a company B field no company A list.
    await expect(field('Style', { companyId: null, type: 'SELECT', picklistId: s.picklistIds.finish })).rejects.toThrow(/picks from a list of its own company or of every company/)
    await expect(field('Style', { companyId: A.companyB, type: 'SELECT', picklistId: s.picklistIds.finish })).rejects.toThrow(/picks from a list of its own company or of every company/)
    const archived = await list(['X'])
    expect(await run(`UPDATE "Picklist" SET status = 'ARCHIVED' WHERE id = $1::uuid`, archived)).toBe(1)
    await expect(field('Style', { type: 'SELECT', picklistId: archived })).rejects.toThrow(/picks from list .*, which is archived: restore the list first/)
  })

  it('link to a record type exactly when a LINK field', async () => {
    await expect(field('Style', { type: 'LINK' })).rejects.toThrow(/links to a record type .* exactly when it is a LINK field/)
    await expect(field('Style', { linkTo: 'Style' })).rejects.toThrow(/exactly when it is a LINK field/)
    await expect(field('Style', { type: 'LINK', linkTo: 'NoSuchModel' })).rejects.toThrow(/exactly when it is a LINK field/)
    expect(await field('Style', { type: 'LINK', linkTo: 'Party' })).toBeTruthy()
  })

  it('never change what they are once made; archived and restored, never deleted', async () => {
    const id = await field('Style')
    await expect(setField(id, `type = 'NUMBER'`)).rejects.toThrow(/the company, record type, code, type, list and linked record type of custom field .* never change/)
    await expect(setField(id, `"companyId" = NULL`)).rejects.toThrow(/never change/)
    expect(await setField(id, `"labelEn" = 'Renamed', required = true, "sortOrder" = 5`)).toBe(1)
    expect(await setField(id, `status = 'ARCHIVED'`)).toBe(1)
    expect(await setField(id, `status = 'ACTIVE'`)).toBe(1)
    // The runtime role has no delete grant; the trigger refuses every login, the owner included.
    await expect(run(`DELETE FROM "CustomField" WHERE id = $1::uuid`, id)).rejects.toThrow(/permission denied/)
    await expect(admin(`DELETE FROM "CustomField" WHERE id = $1::uuid`, [id])).rejects.toThrow(/is kept, never deleted: archive or deactivate it/)
    await expect(admin(`TRUNCATE "CustomField" CASCADE`)).rejects.toThrow(/TRUNCATE on "CustomField" is refused/)
  })
})

describe('custom values (PLT-111)', () => {
  it('are of a record of the field\'s type that exists, of its company, one per field and record', async () => {
    const id = await field('Site')
    await expect(value(id, 'Site', randomUUID(), 'x')).rejects.toThrow(/is of a Site .* that does not exist/)
    await expect(value(id, 'Style', s.records.jkt01, 'x')).rejects.toThrow(/is of a Site record, as its field/)
    await expect(value(id, 'Site', A.siteB1, 'x')).rejects.toThrow(/is of a record of company .*, and field .* is of company .* only/)
    await expect(value(id, 'Site', A.siteA1, 'x', { key: `value:${id}:${A.siteB1}` })).rejects.toThrow(/the key of custom value .* is value:<field>:<record>/)
    const own = await value(id, 'Site', A.siteA1, 'x')
    await expect(value(id, 'Site', A.siteA1, 'y')).rejects.toThrow(/duplicate key|unique constraint/)
    await expect(run(`UPDATE "CustomFieldValue" SET "recordId" = $2::uuid WHERE id = $1::uuid`, own, A.siteB1)).rejects.toThrow(/keeps its field and record/)
    // A field of every company takes a record of any company.
    expect(await value(await field('Site', { companyId: null }), 'Site', A.siteB1, 'z')).toBeTruthy()
  })

  it('hold text, numbers, money, days and yes or no in their shape; never empty', async () => {
    const text = await field('Style')
    await expect(value(text, 'Style', s.records.jkt05, 42)).rejects.toThrow(/a TEXT value is a string of 1 to 4000 characters/)
    await expect(value(text, 'Style', s.records.jkt05, '  ')).rejects.toThrow(/a TEXT value is a string/)
    const own = await value(text, 'Style', s.records.jkt05, 'Made-up text.')
    await expect(run(`UPDATE "CustomFieldValue" SET value = 'null'::jsonb, "changedAt" = now() WHERE id = $1::uuid`, own)).rejects.toThrow(/a value is never empty/)
    const number = await field('Style', { type: 'NUMBER', unit: 'kg' })
    await expect(value(number, 'Style', s.records.jkt05, '1.5')).rejects.toThrow(/a NUMBER value is a number/)
    await expect(value(number, 'Style', s.records.jkt05, 1e16)).rejects.toThrow(/a NUMBER value is below 10\^15/)
    expect(await value(number, 'Style', s.records.jkt05, 1.5)).toBeTruthy()
    const money = await field('Style', { type: 'MONEY', audience: 'MONEY', grain: 'price' })
    await expect(value(money, 'Style', s.records.jkt05, 899)).rejects.toThrow(/a MONEY value is \{ "amount"/)
    await expect(value(money, 'Style', s.records.jkt05, { amount: 899 })).rejects.toThrow(/a MONEY value is \{ "amount"/)
    await expect(value(money, 'Style', s.records.jkt05, { amount: 8.99, currency: 'EUR' })).rejects.toThrow(/a whole number of minor units/)
    await expect(value(money, 'Style', s.records.jkt05, { amount: 899, currency: 'eur' })).rejects.toThrow(/its currency \(three capitals, ISO 4217\)/)
    expect(await value(money, 'Style', s.records.jkt05, { amount: 89900, currency: 'EUR' })).toBeTruthy()
    const day = await field('Style', { type: 'DATE' })
    await expect(value(day, 'Style', s.records.jkt05, '2026-02-30')).rejects.toThrow(/a DATE value is a day, YYYY-MM-DD/)
    await expect(value(day, 'Style', s.records.jkt05, '21/01/2027')).rejects.toThrow(/a DATE value is a day/)
    expect(await value(day, 'Style', s.records.jkt05, '2027-01-21')).toBeTruthy()
    const yes = await field('Style', { type: 'YES_NO' })
    await expect(value(yes, 'Style', s.records.jkt05, 'yes')).rejects.toThrow(/a YES_NO value is true or false/)
    expect(await value(yes, 'Style', s.records.jkt05, true)).toBeTruthy()
  })

  it('pick active codes of their list; a deactivated code stays where it is', async () => {
    const pick = await field('Style', { type: 'SELECT', picklistId: s.picklistIds.lining })
    await expect(value(pick, 'Style', s.records.jkt05, 'GOLD')).rejects.toThrow(/GOLD is not a value of its list/)
    await expect(value(pick, 'Style', s.records.jkt05, 'QUILTED')).rejects.toThrow(/QUILTED is deactivated: it stays on the records that have it/)
    await expect(value(pick, 'Style', s.records.jkt05, ['MESH'])).rejects.toThrow(/a SELECT value is one value code of its list/)
    const own = await value(pick, 'Style', s.records.jkt05, 'MESH')
    // MESH is deactivated after it was chosen: the value keeps it, and may be changed to another active code.
    expect(await run(`UPDATE "PicklistValue" SET active = false WHERE id = $1::uuid`, s.picklistValueIds.mesh)).toBe(1)
    expect(await run(`UPDATE "CustomFieldValue" SET "changedById" = $2::uuid WHERE id = $1::uuid`, own, A.member)).toBe(1)
    expect(await setValue(own, 'WATERPROOF')).toBe(1)
    await expect(setValue(own, 'MESH')).rejects.toThrow(/MESH is deactivated/)
    const many = await field('Style', { type: 'MULTI_SELECT', picklistId: s.picklistIds.lining })
    await expect(value(many, 'Style', s.records.jkt05, [])).rejects.toThrow(/a list of 1 to 100 value codes of its list, each once/)
    await expect(value(many, 'Style', s.records.jkt05, ['THERMAL', 'THERMAL'])).rejects.toThrow(/each once/)
    await expect(value(many, 'Style', s.records.jkt05, 'THERMAL')).rejects.toThrow(/a MULTI_SELECT value is a list/)
    expect(await run(`UPDATE "PicklistValue" SET active = true WHERE id = $1::uuid`, s.picklistValueIds.mesh)).toBe(1)
    const both = await value(many, 'Style', s.records.jkt05, ['THERMAL', 'MESH'])
    expect(await run(`UPDATE "PicklistValue" SET active = false WHERE id = $1::uuid`, s.picklistValueIds.mesh)).toBe(1)
    // MESH it had stays; adding QUILTED (deactivated) is refused; adding WATERPROOF (active) passes.
    await expect(setValue(both, ['THERMAL', 'MESH', 'QUILTED'])).rejects.toThrow(/QUILTED is deactivated/)
    expect(await setValue(both, ['MESH', 'WATERPROOF'])).toBe(1)
    expect(await run(`UPDATE "PicklistValue" SET active = true WHERE id = $1::uuid`, s.picklistValueIds.mesh)).toBe(1)
  })

  it('name an office person, a record of the linked type or an available file of the record', async () => {
    const partnerUser = randomUUID()
    await asReplica(() =>
      db.admin.query(`INSERT INTO "User" (id, "tenantId", email, "displayName", audience, "partyId", "partnerKind") VALUES ($1, $2, $3, 'Test partner', 'PARTNER', $4, 'CUSTOMER')`, [
        partnerUser,
        a.tenantId,
        `partner-${partnerUser.slice(0, 8)}@example.com`,
        A.P1,
      ]),
    )
    const person = await field('Style', { type: 'PERSON' })
    await expect(value(person, 'Style', s.records.jkt05, 'someone')).rejects.toThrow(/a PERSON value is an id \(a uuid\)/)
    await expect(value(person, 'Style', s.records.jkt05, randomUUID())).rejects.toThrow(/a PERSON value is an office person of the tenant/)
    await expect(value(person, 'Style', s.records.jkt05, partnerUser)).rejects.toThrow(/a PERSON value is an office person of the tenant/)
    expect(await value(person, 'Style', s.records.jkt05, A.member)).toBeTruthy()
    const link = await field('Style', { type: 'LINK', linkTo: 'Style' })
    await expect(value(link, 'Style', s.records.jkt05, randomUUID())).rejects.toThrow(/a LINK value is the id of a Style record that exists/)
    await expect(value(link, 'Style', s.records.jkt05, A.siteA1)).rejects.toThrow(/a LINK value is the id of a Style record that exists/)
    expect(await value(link, 'Style', s.records.jkt05, s.records.jkt01)).toBeTruthy()
    const attachment = await field('Style', { type: 'FILE' })
    await expect(value(attachment, 'Style', s.records.jkt05, await file('Style', s.records.jkt01))).rejects.toThrow(/a FILE value is an available file of the record/)
    expect(await value(attachment, 'Style', s.records.jkt05, await file('Style', s.records.jkt05))).toBeTruthy()
  })

  it('are changed forward, with who changed them', async () => {
    const id = await value(await field('Style'), 'Style', s.records.jkt05, 'first')
    await expect(run(`UPDATE "CustomFieldValue" SET value = '"second"'::jsonb WHERE id = $1::uuid`, id)).rejects.toThrow(/names when its new value was written: later than its last change/)
    await expect(
      run(`UPDATE "CustomFieldValue" SET value = '"second"'::jsonb, "changedAt" = now() + interval '1 hour' WHERE id = $1::uuid`, id),
    ).rejects.toThrow(/was not changed in the future/)
    expect(await setValue(id, 'second')).toBe(1)
  })

  it('of an archived field are kept as they are: no new value, no change, not removed', async () => {
    const id = await field('Style')
    const own = await value(id, 'Style', s.records.jkt05, 'kept')
    expect(await setField(id, `status = 'ARCHIVED'`)).toBe(1)
    await expect(value(id, 'Style', s.records.jkt01, 'new')).rejects.toThrow(/is archived: it takes no new value and its values change no more/)
    await expect(setValue(own, 'changed')).rejects.toThrow(/is archived: it takes no new value/)
    await expect(run(`DELETE FROM "CustomFieldValue" WHERE id = $1::uuid`, own)).rejects.toThrow(/is archived: its values are kept as they are/)
    expect(await setField(id, `status = 'ACTIVE'`)).toBe(1)
    expect(await run(`DELETE FROM "CustomFieldValue" WHERE id = $1::uuid`, own)).toBe(1)
    await expect(admin(`TRUNCATE "CustomFieldValue"`)).rejects.toThrow(/TRUNCATE on "CustomFieldValue" is refused/)
  })
})

describe('picklists (PLT-115)', () => {
  it('have codes and keys; their values a swatch, an icon, a place and a description', async () => {
    const listCode = code()
    await expect(insert('Picklist', { id: randomUUID(), code: 'Bad', key: 'picklist:Bad', labelIt: 'x', labelEn: 'x' })).rejects.toThrow(/the code of list .* is lower-case letters/)
    await expect(insert('Picklist', { id: randomUUID(), code: listCode, key: 'picklist:other', labelIt: 'x', labelEn: 'x' })).rejects.toThrow(/the key of list .* is picklist:<code>/)
    await expect(insert('Picklist', { id: randomUUID(), code: 'lining_type', key: 'picklist:lining_type', labelIt: 'x', labelEn: 'x' })).rejects.toThrow(/duplicate key|unique constraint/)
    const id = await list(['RED'])
    await expect(option(id, 'red')).rejects.toThrow(/the code of list value .* is upper-case letters, digits and underscores/)
    await expect(option(id, 'RED')).rejects.toThrow(/duplicate key|unique constraint/)
    await expect(option(id, 'BLUE', { key: `option:${id}:GREEN` })).rejects.toThrow(/the key of list value .* is option:<list>:<code>/)
    await expect(option(id, 'BLUE', { colour: 'blue' })).rejects.toThrow(/a swatch colour #rrggbb and a tag icon id/)
    await expect(option(id, 'BLUE', { icon: 'Big Icon' })).rejects.toThrow(/a swatch colour #rrggbb and a tag icon id/)
    await expect(option(id, 'BLUE', { sortOrder: -1 })).rejects.toThrow(/its place from 0 to 9999/)
    expect(await option(id, 'BLUE', { colour: '#2563eb', icon: 'star', description: 'A made-up value.' })).toBe(1)
  })

  it('keep their values: deactivated, never deleted; codes fixed; an archived list takes no new value', async () => {
    const id = await list(['ONE'])
    await expect(run(`UPDATE "PicklistValue" SET code = 'TWO' WHERE "picklistId" = $1::uuid`, id)).rejects.toThrow(/the list and the code of list value .* never change/)
    expect(await run(`UPDATE "PicklistValue" SET active = false, "labelEn" = 'One (old)' WHERE "picklistId" = $1::uuid`, id)).toBe(1)
    await expect(run(`DELETE FROM "PicklistValue" WHERE "picklistId" = $1::uuid`, id)).rejects.toThrow(/permission denied/)
    await expect(admin(`DELETE FROM "PicklistValue" WHERE "picklistId" = $1::uuid`, [id])).rejects.toThrow(/is kept, never deleted/)
    await expect(run(`UPDATE "Picklist" SET code = 'renamed' WHERE id = $1::uuid`, id)).rejects.toThrow(/the company and the code of list .* never change/)
    expect(await run(`UPDATE "Picklist" SET status = 'ARCHIVED' WHERE id = $1::uuid`, id)).toBe(1)
    await expect(option(id, 'TWO')).rejects.toThrow(/is archived: it takes no new value/)
    await expect(admin(`DELETE FROM "Picklist" WHERE id = $1::uuid`, [id])).rejects.toThrow(/is kept, never deleted/)
  })

  it('are archived only once no active field picks from them', async () => {
    const id = await list(['ONE'])
    const user = await field('Style', { type: 'SELECT', picklistId: id })
    await expect(run(`UPDATE "Picklist" SET status = 'ARCHIVED' WHERE id = $1::uuid`, id)).rejects.toThrow(/is picked from by active field .*: archive the field first/)
    expect(await setField(user, `status = 'ARCHIVED'`)).toBe(1)
    expect(await run(`UPDATE "Picklist" SET status = 'ARCHIVED' WHERE id = $1::uuid`, id)).toBe(1)
    // Restoring the field asks for its list first.
    await expect(setField(user, `status = 'ACTIVE'`)).rejects.toThrow(/which is archived: restore the list first/)
  })
})

describe('document templates (PLT-231)', () => {
  it('are written as a DRAFT with their key, language and words', async () => {
    await expect(documentTemplate('PACKING_LIST', 'it', 1, { status: 'ACTIVE', publishedAt: new Date().toISOString(), publishedById: a.actorId })).rejects.toThrow(/is written as a DRAFT, then published/)
    await expect(documentTemplate('PACKING_LIST', 'ITA', 1)).rejects.toThrow(/is in a language of two lower-case letters/)
    await expect(documentTemplate('PACKING_LIST', 'it', 0)).rejects.toThrow(/with its version number from 1/)
    await expect(documentTemplate('PACKING_LIST', 'it', 1, { key: `doc:PACKING_LIST:${A.companyA}:it:2` })).rejects.toThrow(/the key of document template .* is doc:<kind>:<company>:<language>:<version>/)
    await expect(documentTemplate('PACKING_LIST', 'it', 1, { header: 'Ciao {{party.name' })).rejects.toThrow(/hold placeholders only as \{\{name\}\}/)
    await expect(documentTemplate('PACKING_LIST', 'it', 1, { footer: 'Ciao {{ two words }}' })).rejects.toThrow(/hold placeholders only as \{\{name\}\}/)
    await expect(documentTemplate('PACKING_LIST', 'it', 1, { terms: 'x'.repeat(20_001) })).rejects.toThrow(/terms of up to 20000/)
    await expect(documentTemplate('PACKING_LIST', 'it', 1, { fieldsShown: ['discount', 'discount'] })).rejects.toThrow(/shows up to 60 fields of its layout, each once/)
    await expect(documentTemplate('PACKING_LIST', 'it', 1, { fieldsShown: ['Not a key'] })).rejects.toThrow(/shows up to 60 fields/)
    expect(await documentTemplate('PACKING_LIST', 'it', 1, { header: 'Colli per {{ party.name }}', fieldsShown: ['parcel', 'goods'] })).toBeTruthy()
    await expect(documentTemplate('PACKING_LIST', 'it', 1)).rejects.toThrow(/duplicate key|unique constraint/)
  })

  it('are published once, one ACTIVE per company, kind and language, then frozen; RETIRED frozen whole', async () => {
    const first = await documentTemplate('INVOICE_COPY', 'en', 1, { footer: 'Made-up footer.' })
    expect(await setDocument(first, `footer = 'Changed while a draft.'`)).toBe(1)
    await expect(setDocument(first, `status = 'ACTIVE'`)).rejects.toThrow(/names when and by whom it was published exactly once it is published/)
    await expect(setDocument(first, `status = 'RETIRED', "retiredAt" = now()`)).rejects.toThrow(/moves DRAFT → ACTIVE → RETIRED \(not DRAFT → RETIRED\)/)
    expect(await publish('DocumentTemplate', first)).toBe(1)
    await expect(setDocument(first, `footer = 'Changed after.'`)).rejects.toThrow(/was published: its words and fields never change \(write a new version\)/)
    await expect(setDocument(first, `"publishedById" = $2::uuid`, A.member)).rejects.toThrow(/was published once; when and by whom stay as they were/)
    await expect(setDocument(first, `revision = 7`)).rejects.toThrow(/the company, kind, language and version number of document template .* never change/)
    const second = await documentTemplate('INVOICE_COPY', 'en', 2)
    await expect(publish('DocumentTemplate', second)).rejects.toThrow(/DocumentTemplate_one_active|duplicate key/)
    // Another language or company has its own.
    expect(await publish('DocumentTemplate', await documentTemplate('INVOICE_COPY', 'it', 1))).toBe(1)
    await expect(setDocument(first, `status = 'RETIRED'`)).rejects.toThrow(/names when it was retired exactly when RETIRED/)
    expect(await retire('DocumentTemplate', first)).toBe(1)
    expect(await publish('DocumentTemplate', second)).toBe(1)
    await expect(setDocument(first, `"retiredAt" = now()`)).rejects.toThrow(/is RETIRED: it changes no more/)
  })

  it('are removed only as a DRAFT', async () => {
    const draft = await documentTemplate('DDT', 'it', 1)
    const used = await documentTemplate('DDT', 'it', 2)
    expect(await publish('DocumentTemplate', used)).toBe(1)
    await expect(run(`DELETE FROM "DocumentTemplate" WHERE id = $1::uuid`, used)).rejects.toThrow(/was published \(ACTIVE\): it is kept, never removed/)
    expect(await run(`DELETE FROM "DocumentTemplate" WHERE id = $1::uuid`, draft)).toBe(1)
    await expect(admin(`TRUNCATE "DocumentTemplate"`)).rejects.toThrow(/TRUNCATE on "DocumentTemplate" is refused/)
  })
})

describe('e-mail templates (PLT-232)', () => {
  it('are for an event in a language, with a subject, a body and placeholders', async () => {
    await expect(emailTemplate('Quote Sent', 'it', 1)).rejects.toThrow(/is for an event named as the mail's template key/)
    await expect(emailTemplate('quote', 'it', 1)).rejects.toThrow(/is for an event named as the mail's template key/)
    await expect(emailTemplate('exports.ready', 'it', 1, { subject: 'two\nlines' })).rejects.toThrow(/a subject of one line of 1 to 200 characters/)
    await expect(emailTemplate('exports.ready', 'it', 1, { body: 'Hello }} there' })).rejects.toThrow(/hold placeholders only as \{\{name\}\}/)
    await expect(emailTemplate('exports.ready', 'it', 1, { key: 'mail:exports.ready:all:it:1' })).rejects.toThrow(/the key of e-mail template .* is mail:<event>:<company or all>:<language>:<version>/)
    expect(await emailTemplate('exports.ready', 'it', 1)).toBeTruthy()
  })

  it('are one ACTIVE per event, company or every company, and language; frozen once published', async () => {
    const own = await emailTemplate('fittings.invite', 'it', 1)
    const all = await emailTemplate('fittings.invite', 'it', 1, { companyId: null })
    const allNext = await emailTemplate('fittings.invite', 'it', 2, { companyId: null })
    expect(await publish('EmailTemplate', own)).toBe(1)
    expect(await publish('EmailTemplate', all)).toBe(1)
    await expect(publish('EmailTemplate', allNext)).rejects.toThrow(/EmailTemplate_one_active|duplicate key/)
    await expect(run(`UPDATE "EmailTemplate" SET body = 'Changed.' WHERE id = $1::uuid`, all)).rejects.toThrow(/was published: its subject and body never change/)
    const draft = await emailTemplate('fittings.invite', 'it', 3, { companyId: null })
    await expect(run(`UPDATE "EmailTemplate" SET "companyId" = $2::uuid WHERE id = $1::uuid`, draft, A.companyA)).rejects.toThrow(/never change \(a new version is a new row\)/)
    expect(await retire('EmailTemplate', all)).toBe(1)
    expect(await publish('EmailTemplate', allNext)).toBe(1)
    await expect(run(`DELETE FROM "EmailTemplate" WHERE id = $1::uuid`, all)).rejects.toThrow(/was published \(RETIRED\): it is kept/)
  })
})

describe('saved replies (COL-016)', () => {
  it('are an office person\'s own or shared, for a record type of the tenant or any, with placeholders', async () => {
    const partnerUser = randomUUID()
    await asReplica(() =>
      db.admin.query(`INSERT INTO "User" (id, "tenantId", email, "displayName", audience, "partyId", "partnerKind") VALUES ($1, $2, $3, 'Test partner', 'PARTNER', $4, 'CUSTOMER')`, [
        partnerUser,
        a.tenantId,
        `partner-${partnerUser.slice(0, 8)}@example.com`,
        A.P1,
      ]),
    )
    await expect(reply({ ownerId: partnerUser })).rejects.toThrow(/is an office person's own, or shared \(not a partner user's\)/)
    await expect(reply({ recordType: 'NoSuchModel' })).rejects.toThrow(/is for a record type that is a table of the tenant/)
    await expect(reply({ body: 'Hello {{contact.name}' })).rejects.toThrow(/its placeholders only as \{\{name\}\}/)
    await expect(reply({ name: 'two\nlines' })).rejects.toThrow(/has a name of one line of 1 to 120 characters/)
    await expect(reply({ language: 'english' })).rejects.toThrow(/a language of two lower-case letters/)
    expect(await reply({ ownerId: A.member, recordType: 'PurchaseOrder', companyId: A.companyA })).toBe(1)
    const shared = s.messageTemplateIds[3]!
    expect(await run(`UPDATE "MessageTemplate" SET "ownerId" = $2::uuid WHERE id = $1::uuid`, shared, A.member)).toBe(1)
    expect(await run(`UPDATE "MessageTemplate" SET "ownerId" = NULL WHERE id = $1::uuid`, shared)).toBe(1)
    expect(await run(`DELETE FROM "MessageTemplate" WHERE "ownerId" = $1::uuid AND "recordType" = 'PurchaseOrder'`, A.member)).toBe(1)
    await expect(admin(`TRUNCATE "MessageTemplate"`)).rejects.toThrow(/TRUNCATE on "MessageTemplate" is refused/)
  })
})

describe('the options a quote template line starts with (B-W2b-374)', () => {
  it('are of a line that is no fee, of a group its style offers, with the text the value takes', async () => {
    const feeLine = key('sales-pricing:template:SEASON:30')
    await expect(templateOption({ lineId: feeLine, groupId: options.liner, valueId: options.linerYes })).rejects.toThrow(/quote template line .* is a fee: it starts with no options/)
    // SEED-JKT-01's line (seq 10): its style offers no option group.
    await expect(templateOption({ lineId: firstKey('sales-pricing:template:SEASON:10'), groupId: options.liner, valueId: options.linerYes })).rejects.toThrow(
      /is of a group the style of quote template line .* does not offer/,
    )
    await expect(templateOption({ groupId: options.name, valueId: options.nameValue })).rejects.toThrow(/has the customer's text exactly when its value takes one/)
    await expect(templateOption({ groupId: options.name, valueId: options.nameValue, freeText: 'A NAME FAR TOO LONG' })).rejects.toThrow(/is one line of at most 12 characters matching the value's pattern/)
    await expect(templateOption({ groupId: options.liner, valueId: options.linerYes, freeText: 'ROSSI' })).rejects.toThrow(/exactly when its value takes one/)
    expect(await templateOption({ groupId: options.name, valueId: options.nameValue, freeText: 'BIANCHI' })).toBe(1)
    await expect(run(`UPDATE "QuoteTemplateLineOption" SET "valueId" = $2::uuid WHERE id = $1::uuid`, s.templateLineOptionIds[0], options.linerYes)).rejects.toThrow(
      /keeps its line, group and value|violates foreign key/,
    )
    await expect(templateOption({ groupId: options.liner, valueId: options.linerYes, itemColourId: randomUUID() })).rejects.toThrow(/names a material's colour only with the material|violates foreign key/)
    await expect(admin(`TRUNCATE "QuoteTemplateLineOption"`)).rejects.toThrow(/TRUNCATE on "QuoteTemplateLineOption" is refused/)
  })

  it('pick what their group takes, and a group takes the other kind only once no template option picks it', async () => {
    const colour = key('product:colour:RED')
    const material = s.records.leather
    expect(await run(`UPDATE "OptionGroup" SET takes = 'COLOUR' WHERE id = $1::uuid`, options.perforation)).toBe(1)
    await expect(templateOption({ groupId: options.perforation, valueId: options.perfFront, itemId: material })).rejects.toThrow(/which takes a colour of the library: it picks no material/)
    const picked = randomUUID()
    expect(await insert('QuoteTemplateLineOption', { id: picked, lineId: s.records.seasonLine, groupId: options.perforation, valueId: options.perfFront, colourId: colour })).toBe(1)
    await expect(run(`UPDATE "OptionGroup" SET takes = 'MATERIAL' WHERE id = $1::uuid`, options.perforation)).rejects.toThrow(
      /options: group SEED-OG-PERF takes a material only once none of the quote template options of it picks a library colour/,
    )
    expect(await run(`DELETE FROM "QuoteTemplateLineOption" WHERE id = $1::uuid`, picked)).toBe(1)
    expect(await run(`UPDATE "OptionGroup" SET takes = 'MATERIAL' WHERE id = $1::uuid`, options.perforation)).toBe(1)
    await expect(templateOption({ groupId: options.perforation, valueId: options.perfFront, colourId: colour })).rejects.toThrow(/which takes a material and its colour: it picks no library colour/)
    expect(await templateOption({ groupId: options.perforation, valueId: options.perfFront, itemId: material })).toBe(1)
    expect(await run(`UPDATE "OptionGroup" SET takes = NULL WHERE id = $1::uuid`, options.perforation)).toBe(1)
  })

  it('keep their line\'s style and kind, and go with their line', async () => {
    const line = s.records.seasonLine
    await expect(run(`UPDATE "QuoteTemplateLine" SET "styleId" = $2::uuid, "colourwayId" = NULL WHERE id = $1::uuid`, line, s.records.jkt01)).rejects.toThrow(
      /keeps its style while it has options .*: remove them first/,
    )
    await expect(run(`UPDATE "QuoteTemplateLine" SET kind = 'FEE', "feeKind" = 'SAMPLE' WHERE id = $1::uuid`, line)).rejects.toThrow(/has options: it becomes a fee only once they are removed/)
    expect(await run(`UPDATE "QuoteTemplateLine" SET section = 'Giacche' WHERE id = $1::uuid`, line)).toBe(1)
    const own = randomUUID()
    expect(await insert('QuoteTemplateLine', { id: own, templateId: A.seasonTemplate, seq: 90, kind: 'SIZE_GRID', styleId: s.records.jkt05 })).toBe(1)
    expect(await templateOption({ lineId: own, groupId: options.liner, valueId: options.linerYes })).toBe(1)
    expect(await run(`DELETE FROM "QuoteTemplateLine" WHERE id = $1::uuid`, own)).toBe(1)
    expect(await admin(`SELECT 1 FROM "QuoteTemplateLineOption" WHERE "lineId" = $1::uuid`, [own])).toEqual([])
  })
})
