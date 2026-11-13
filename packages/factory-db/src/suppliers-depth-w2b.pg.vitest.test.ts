import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedAuth } from '../seed/auth'
import { seed as seedPortalSupply, type PortalSupplySeed } from '../seed/portal-supply'
import { seed as seedSuppliersDepth, type SuppliersDepthSeed } from '../seed/suppliers-depth'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Suppliers in depth (W2b-5, schema wave 42/44, B-W2b-287, …_suppliers_depth_w2b_guards) on a database built from the
 * migrations and seeded twice, through the real login and the scoped client:
 *   - a party as a supplier: kinds and status only with a supplier role, each status change with when and by whom, the reason
 *     of a hold, never cleared; the origin, the hides' countries and tannages only on a tannery; what a contact receives;
 *   - bank accounts NEVER CHANGED IN PLACE (SCM-007): proposed PROPOSED (the IBAN's check digits, the masked IBAN the database
 *     writes), the call-back to a number on file before the proposal by someone who neither proposed nor wrote it, the second
 *     person's check (nobody verifies their own change, the Owner included: Q3 = A), one ACTIVE per party and currency, refused
 *     and retired once; a supplier's portal session inserts only a PROPOSED account of its own party by its own person and
 *     never reads the call-back or who checked;
 *   - qualifications: the scope by role and library, the evidence by record type + id (accepted, of the party), decided once,
 *     suspended and lifted back to the decision, withdrawn; never deleted;
 *   - subcontract agreements: DRAFT → SIGNED with its file → SUPERSEDED | TERMINATED, one SIGNED per company and workshop, only a
 *     DRAFT deleted;
 *   - grants: the floor reads nothing; a portal session reads no qualification or agreement.
 * The refusals are check_violation (23514); their messages are read through raw SQL.
 */

const NS = 'w2b-287-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: SuppliersDepthSeed
let supply: PortalSupplySeed
let invitedId: string

const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const asMember = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: s.memberId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: a.sites[0]!.id })
const asSupplier = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: s.supplierUserId, partyId: s.partyP2 })
const asCustomer = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: s.buyerUserId, partyId: s.partyP1 })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyText = (table: string) => `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) => run(scope, copyText(table), JSON.stringify(changes), id)
/** UPDATE row `id` of `table`: `set` is the SET list. */
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()

/** A made-up Italian test IBAN for a 12-digit account number, its ISO 7064 check digits correct. */
function iban(account: string): string {
  const bban = `X0000000000${account.padStart(12, '0')}`
  const digits = [...`${bban}IT00`].map((ch) => (/[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch)).join('')
  return `IT${String(98n - (BigInt(digits) % 97n)).padStart(2, '0')}${bban}`
}
let accountNumber = 287100
const nextIban = (): string => iban(String(accountNumber++))
/** A new PROPOSED account of P2: a copy of the portal proposal with `changes` (by default proposed by the Owner 30 minutes ago). */
async function propose(changes: Record<string, unknown> = {}, scope: FactoryScope = office()): Promise<string> {
  const id = randomUUID()
  const row = { id, iban: nextIban(), proposedById: a.actorId, proposedAt: ago(30), createdAt: ago(30), createdById: a.actorId, replacesId: null, ...changes }
  expect(await copyRow(scope, 'SupplierBankAccount', s.bankAccountIds.pending, row)).toBe(1)
  return id
}
/** The call-back of an account to P2's order desk (on file since the seed), by the member. */
const callBack = (id: string, set = '') =>
  update(asMember(), 'SupplierBankAccount', id, `"callBackAt" = $2::timestamptz, "callBackById" = $3::uuid, "callBackContactId" = $4::uuid, "callBackPhone" = '+39 000 0000002', version = version + 1${set}`, ago(20), s.memberId, s.orderDeskContactId)

beforeAll(async () => {
  db = await migratedDatabase('suppliersw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  invitedId = (await seedAuth({ db: factory, namespace: NS })).invitedId
  supply = await seedPortalSupply({ db: factory, namespace: NS })
  s = await seedSuppliersDepth({ db: factory, namespace: NS }, { partnerScope: true })
  // Run twice: every seed is idempotent.
  await seedSuppliersDepth({ db: factory, namespace: NS }, { partnerScope: true })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('a party as a supplier', () => {
  it('has supplier kinds, each once, only with the SUPPLIER, SUBCONTRACTOR or CARRIER role', async () => {
    await expect(update(office(), 'Party', s.partyP2, `"supplierKinds" = '{TANNERY,TANNERY}'`)).rejects.toThrow(/each supplier kind once/)
    await expect(update(office(), 'Party', s.partyP1, `"supplierKinds" = '{TRIMS}'`)).rejects.toThrow(/supplier kinds only with the SUPPLIER, SUBCONTRACTOR or CARRIER role/)
    expect(await update(office(), 'Party', s.partyP2, `"supplierKinds" = '{TANNERY,SUBCONTRACTOR,TRIMS}'`)).toBe(1)
    // A write of W1's columns never meets the rule (the trigger fires on the new columns only).
    expect(await update(office(), 'Party', s.partyP2, `"tradeName" = 'Seed Tannery', roles = '{SUPPLIER,SUBCONTRACTOR}'`)).toBe(1)
  })

  it('records each change of its status with when and by whom; a hold says why; never cleared', async () => {
    await expect(update(office(), 'Party', s.partyP1, `"supplierStatus" = 'PROSPECT', "supplierStatusChangedAt" = now()`)).rejects.toThrow(/supplier status only with the SUPPLIER, SUBCONTRACTOR or CARRIER role/)
    await expect(update(office(), 'Party', s.partyP2, `"supplierStatus" = 'ON_HOLD'`)).rejects.toThrow(/records when \(not in the future, later than the last change\)/)
    await expect(update(office(), 'Party', s.partyP2, `"supplierStatus" = 'ON_HOLD', "supplierStatusChangedAt" = now() + interval '1 day'`)).rejects.toThrow(/records when/)
    await expect(update(office(), 'Party', s.partyP2, `"supplierStatus" = 'ON_HOLD', "supplierStatusChangedAt" = now()`)).rejects.toThrow(/ON_HOLD as a supplier with the reason why/)
    await expect(update(office(), 'Party', s.partyP2, `"supplierStatus" = 'ON_HOLD', "supplierStatusChangedAt" = now(), "supplierStatusReason" = 'Late twice.', "supplierStatusChangedById" = $2::uuid`, s.supplierUserId)).rejects.toThrow(
      /changed by an active office user/,
    )
    await expect(update(office(), 'Party', s.partyP2, `"supplierStatus" = 'ON_HOLD', "supplierStatusChangedAt" = now(), "supplierStatusReason" = E'Late\\ntwice.'`)).rejects.toThrow(/one line of 1 to 500/)
    expect(await update(office(), 'Party', s.partyP2, `"supplierStatus" = 'ON_HOLD', "supplierStatusChangedAt" = now(), "supplierStatusReason" = 'Two late deliveries in October.', "supplierStatusChangedById" = $2::uuid`, s.memberId)).toBe(1)
    await expect(update(office(), 'Party', s.partyP2, `"supplierStatusChangedById" = $2::uuid`, a.actorId)).rejects.toThrow(/only with a change of the status/)
    expect(await update(office(), 'Party', s.partyP2, `"supplierStatusReason" = 'Two late deliveries in October; one more and it is blocked.'`)).toBe(1)
    await expect(update(office(), 'Party', s.partyP2, `"supplierStatus" = NULL, "supplierStatusReason" = NULL, "supplierStatusChangedAt" = NULL, "supplierStatusChangedById" = NULL`)).rejects.toThrow(/never cleared once set/)
    // The system may change it (no person).
    expect(await update(office(), 'Party', s.partyP2, `"supplierStatus" = 'APPROVED', "supplierStatusChangedAt" = now() + interval '1 second', "supplierStatusReason" = NULL, "supplierStatusChangedById" = NULL`)).toBe(1)
    await expect(update(office(), 'Party', s.partyP1, `"supplierStatusReason" = 'Never a supplier.'`)).rejects.toThrow(/no supplier status, so no reason/)
  })

  it('says where it makes what it sells: hides and tannages only as a tannery', async () => {
    await expect(update(office(), 'Party', s.partyP2, `"originCountry" = 'Italy'`)).rejects.toThrow(/a country code of two capitals/)
    await expect(update(office(), 'Party', s.partyP2, `"originRegion" = E'Two\\nlines'`)).rejects.toThrow(/a region of one line/)
    await expect(update(office(), 'Party', s.partyP2, `"hideOriginCountries" = '{IT,IT}'`)).rejects.toThrow(/raw hides come from by two capitals .* each once/)
    await expect(update(office(), 'Party', s.partyP2, `"hideOriginCountries" = '{ita}'`)).rejects.toThrow(/raw hides come from by two capitals/)
    await expect(update(office(), 'Party', s.partyP2, `tannages = '{VEGETABLE,VEGETABLE}'`)).rejects.toThrow(/each tannage once/)
    await expect(update(office(), 'Party', s.partyP2, `"supplierKinds" = '{SUBCONTRACTOR}'`)).rejects.toThrow(/only as a TANNERY/)
    expect(await update(office(), 'Party', s.partyP2, `"originCountry" = 'PT', "originRegion" = 'Seed north', "hideOriginCountries" = '{PT,BR}', tannages = '{CHROME}'`)).toBe(1)
  })

  it('is read by its own portal without why it has its status or who changed it', async () => {
    const rows = await sql(asSupplier(), `SELECT "supplierKinds"::text[] AS kinds, "supplierStatus"::text AS status, "originCountry" FROM "Party" WHERE id = $1::uuid`, s.partyP2)
    expect(rows).toEqual([{ kinds: expect.arrayContaining(['TANNERY']), status: expect.any(String), originCountry: expect.any(String) }])
    await expect(sql(asSupplier(), `SELECT "supplierStatusReason" FROM "Party"`)).rejects.toThrow(/permission denied/)
    await expect(sql(asSupplier(), `SELECT "supplierStatusChangedById" FROM "Party"`)).rejects.toThrow(/permission denied/)
  })

  it('routes mail to the contacts that receive it, each kind once', async () => {
    await expect(update(office(), 'PartyContact', s.orderDeskContactId, `receives = '{PO,PO}'`)).rejects.toThrow(/what it receives each once/)
    const contact = randomUUID()
    expect(await copyRow(office(), 'PartyContact', s.orderDeskContactId, { id: contact, name: 'Seed Accounts Two', email: null, receives: ['REMITTANCE', 'CLAIM'] })).toBe(1)
    expect((await sql(asSupplier(), `SELECT receives::text[] AS receives FROM "PartyContact" WHERE id = $1::uuid`, contact))[0]).toEqual({ receives: ['REMITTANCE', 'CLAIM'] })
  })
})

describe('bank accounts (SCM-007): never changed in place', () => {
  it('are proposed PROPOSED with an IBAN whose check digits hold; the database writes the masked IBAN', async () => {
    const good = nextIban()
    const wrongDigits = `IT${good.slice(2, 4) === '99' ? '98' : '99'}${good.slice(4)}`
    await expect(propose({ iban: wrongDigits })).rejects.toThrow(/check digits that hold/)
    await expect(propose({ iban: good.toLowerCase() })).rejects.toThrow(/check digits that hold/)
    await expect(propose({ iban: `${good.slice(0, 4)} ${good.slice(4)}` })).rejects.toThrow(/check digits that hold/)
    await expect(propose({ bic: 'SEED' })).rejects.toThrow(/BIC .* 8 or 11/)
    await expect(propose({ holder: '' })).rejects.toThrow(/names its holder/)
    await expect(propose({ currency: 'euro' })).rejects.toThrow(/three capitals/)
    await expect(propose({ status: 'VERIFIED', verifiedAt: ago(1), verifiedById: s.memberId })).rejects.toThrow(/proposed PROPOSED at version 1/)
    await expect(propose({ callBackAt: ago(1) })).rejects.toThrow(/proposed PROPOSED at version 1/)
    await expect(propose({ proposedAt: new Date(Date.now() + 86_400_000).toISOString() })).rejects.toThrow(/not proposed in the future/)
    await expect(propose({ proposedById: invitedId })).rejects.toThrow(/proposed by an active office user, or by an active person of its own supplier/)
    await expect(propose({ proposedById: s.buyerUserId })).rejects.toThrow(/proposed by an active office user, or by an active person of its own supplier/)
    await expect(propose({ replacesId: s.bankAccountIds.retired })).rejects.toThrow(/replaces the ACTIVE account of its party/)
    const id = await propose({ iban: good, ibanCountry: 'XX', ibanLast4: '0000', replacesId: s.bankAccountIds.active })
    expect((await admin(`SELECT "ibanCountry", "ibanLast4", status FROM "SupplierBankAccount" WHERE id = $1::uuid`, [id]))[0]).toEqual({ ibanCountry: 'IT', ibanLast4: good.slice(-4), status: 'PROPOSED' })
    for (const set of [`iban = '${nextIban()}'`, `holder = 'Someone Else'`, `bic = 'SEEDITM9XXX'`, `currency = 'USD'`, `"ibanLast4" = '9999'`, `"proposedById" = '${s.memberId}'`, `"replacesId" = NULL`]) {
      await expect(update(office(), 'SupplierBankAccount', id, set)).rejects.toThrow(/never changed in place/)
    }
    await expect(update(office(), 'SupplierBankAccount', id, `version = version + 2, "callBackAt" = NULL`)).rejects.toThrow(/version by one at most/)
  })

  it('are checked by a call-back to a number on file before the proposal, by someone who neither proposed nor wrote it', async () => {
    const id = await propose()
    const set = (by: string, contactId: string, phone: string, at = ago(20)) =>
      update(asMember(), 'SupplierBankAccount', id, `"callBackAt" = $2::timestamptz, "callBackById" = $3::uuid, "callBackContactId" = $4::uuid, "callBackPhone" = $5, version = version + 1`, at, by, contactId, phone)
    await expect(set(a.actorId, s.orderDeskContactId, '+39 000 0000002')).rejects.toThrow(/neither proposed nor wrote the account/)
    await expect(set(s.supplierUserId, s.orderDeskContactId, '+39 000 0000002')).rejects.toThrow(/neither proposed nor wrote the account/)
    await expect(set(s.memberId, s.orderDeskContactId, '+39 000 0000099')).rejects.toThrow(/dials the phone on file/)
    await expect(set(s.memberId, s.orderDeskContactId, '+39 000 0000002', ago(40))).rejects.toThrow(/after its proposal/)
    await expect(update(asMember(), 'SupplierBankAccount', id, `"callBackAt" = now(), "callBackById" = $2::uuid, version = version + 1`, s.memberId)).rejects.toThrow(/all or none/)
    // A contact made (or changed) after the proposal is not a number we had: the classic "call us on this new number".
    const newContact = randomUUID()
    expect(await copyRow(office(), 'PartyContact', s.orderDeskContactId, { id: newContact, name: 'Seed New Desk', email: null, phone: '+39 000 0000777', receives: [], createdAt: ago(10), updatedAt: ago(10) })).toBe(1)
    await expect(set(s.memberId, newContact, '+39 000 0000777')).rejects.toThrow(/a number we had on file before the proposal/)
    const oldContact = randomUUID()
    expect(await copyRow(office(), 'PartyContact', s.orderDeskContactId, { id: oldContact, name: 'Seed Old Desk', email: null, phone: '+39 000 0000888', receives: [], createdAt: ago(600), updatedAt: ago(600) })).toBe(1)
    expect(await update(office(), 'PartyContact', oldContact, `phone = '+39 000 0000889', "updatedAt" = now()`)).toBe(1)
    await expect(set(s.memberId, oldContact, '+39 000 0000889')).rejects.toThrow(/a number we had on file before the proposal/)
    // A contact of another party: the reference refuses it.
    await expect(set(s.memberId, (await admin(`SELECT id FROM "PartyContact" WHERE "partyId" = $1::uuid LIMIT 1`, [s.partyP1]))[0]!.id as string, '+39 000 0000002')).rejects.toThrow(/foreign key/)
    // The digits are what counts.
    expect(await set(s.memberId, s.orderDeskContactId, '0039-000-0000002'.replace(/^00/, '+'))).toBe(1)
    await expect(update(office(), 'SupplierBankAccount', id, `"callBackPhone" = '+39 000 0000002'`)).rejects.toThrow(/recorded once/)
  })

  it('may call back the phone of an address of the party (exactly one of contact and address)', async () => {
    const address = randomUUID()
    const office2 = (await admin(`SELECT id FROM "PartyAddress" WHERE "partyId" = $1::uuid ORDER BY id LIMIT 1`, [s.partyP2]))[0]!.id as string
    expect(await copyRow(office(), 'PartyAddress', office2, { id: address, kinds: ['PICKUP'], isDefaultBillTo: false, isDefaultShipTo: false, phone: '+39 055 000 0123', createdAt: ago(600), updatedAt: ago(600) })).toBe(1)
    const id = await propose()
    await expect(
      update(asMember(), 'SupplierBankAccount', id, `"callBackAt" = now(), "callBackById" = $2::uuid, "callBackContactId" = $3::uuid, "callBackAddressId" = $4::uuid, "callBackPhone" = '+39 055 000 0123', version = version + 1`, s.memberId, s.orderDeskContactId, address),
    ).rejects.toThrow(/exactly one contact or address/)
    expect(await update(asMember(), 'SupplierBankAccount', id, `"callBackAt" = now(), "callBackById" = $2::uuid, "callBackAddressId" = $3::uuid, "callBackPhone" = '+39 055 000 0123', version = version + 1`, s.memberId, address)).toBe(1)
  })

  it('are verified by a second person after the call-back: nobody verifies their own change, the Owner included (Q3 = A)', async () => {
    const id = await propose()
    const verify = (by: string, scope = asMember()) => update(scope, 'SupplierBankAccount', id, `status = 'VERIFIED', "verifiedAt" = now(), "verifiedById" = $2::uuid, version = version + 1`, by)
    await expect(verify(s.memberId)).rejects.toThrow(/after the call-back/)
    expect(await callBack(id)).toBe(1)
    // The Owner proposed and wrote it: the Owner never checks it, whatever the path (the owner login too).
    await expect(verify(a.actorId, office())).rejects.toThrow(/never the one who proposed or wrote it/)
    await expect(admin(`UPDATE "SupplierBankAccount" SET status = 'VERIFIED', "verifiedAt" = now(), "verifiedById" = $2::uuid, version = version + 1 WHERE id = $1::uuid`, [id, a.actorId])).rejects.toThrow(
      /never the one who proposed or wrote it/,
    )
    await expect(verify(s.supplierUserId)).rejects.toThrow(/checked by an active office user/)
    await expect(verify(invitedId)).rejects.toThrow(/checked by an active office user/)
    await expect(update(asMember(), 'SupplierBankAccount', id, `status = 'VERIFIED', version = version + 1`)).rejects.toThrow(/once a second person checked it/)
    // A proposal the member wrote for the supplier: the member is its writer and never checks it either.
    const written = await propose({ proposedById: s.supplierUserId, createdById: s.memberId })
    expect(await update(office(), 'SupplierBankAccount', written, `"callBackAt" = now(), "callBackById" = $2::uuid, "callBackContactId" = $3::uuid, "callBackPhone" = '+39 000 0000002', version = version + 1`, a.actorId, s.orderDeskContactId)).toBe(1)
    await expect(update(asMember(), 'SupplierBankAccount', written, `status = 'VERIFIED', "verifiedAt" = now(), "verifiedById" = $2::uuid, version = version + 1`, s.memberId)).rejects.toThrow(/never the one who proposed or wrote it/)
    expect(await verify(s.memberId)).toBe(1)
    await expect(update(office(), 'SupplierBankAccount', id, `"verifiedById" = $2::uuid`, a.actorId)).rejects.toThrow(/recorded once/)
  })

  it('make one ACTIVE account per party and currency: the old one is retired first; refused and retired are final', async () => {
    const id = await propose({ replacesId: s.bankAccountIds.active })
    expect(await callBack(id)).toBe(1)
    await expect(update(asMember(), 'SupplierBankAccount', id, `status = 'ACTIVE', "verifiedAt" = now(), "verifiedById" = $2::uuid, "activatedAt" = now(), version = version + 1`, s.memberId)).rejects.toThrow(/duplicate key|unique/)
    await expect(update(office(), 'SupplierBankAccount', s.bankAccountIds.active, `status = 'RETIRED', "retiredAt" = now(), "retireReason" = E'Two\\nlines', version = version + 1`)).rejects.toThrow(/one line, 1 to 500/)
    await as(asMember(), (client) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`UPDATE "SupplierBankAccount" SET status = 'RETIRED', "retiredAt" = now(), "retireReason" = 'Replaced.', version = version + 1 WHERE id = $1::uuid`, s.bankAccountIds.active)
        await tx.$executeRawUnsafe(`UPDATE "SupplierBankAccount" SET status = 'ACTIVE', "verifiedAt" = now(), "verifiedById" = $2::uuid, "activatedAt" = now(), version = version + 1 WHERE id = $1::uuid`, id, s.memberId)
      }),
    )
    expect((await admin(`SELECT count(*)::int AS n FROM "SupplierBankAccount" WHERE "partyId" = $1::uuid AND status = 'ACTIVE'`, [s.partyP2]))[0]).toEqual({ n: 1 })
    await expect(update(office(), 'SupplierBankAccount', s.bankAccountIds.active, `"retireReason" = 'Closed.'`)).rejects.toThrow(/RETIRED already: it never changes again/)
    await expect(update(office(), 'SupplierBankAccount', id, `status = 'PROPOSED', version = version + 1`)).rejects.toThrow(/PROPOSED → VERIFIED → ACTIVE → RETIRED/)
    // A second currency has its own ACTIVE account.
    const usd = await propose({ currency: 'USD' })
    await expect(callBack(usd, `, status = 'ACTIVE', "verifiedAt" = now(), "verifiedById" = '${s.memberId}'`)).rejects.toThrow(/exactly with when it became active/)
    expect(await callBack(usd, `, status = 'ACTIVE', "verifiedAt" = now(), "verifiedById" = '${s.memberId}', "activatedAt" = now()`)).toBe(1)
    // Refused: exactly with when, by whom and why; then final.
    const refused = await propose()
    await expect(update(asMember(), 'SupplierBankAccount', refused, `status = 'REFUSED', "refusedAt" = now(), "refusedById" = $2::uuid, version = version + 1`, s.memberId)).rejects.toThrow(/REFUSED exactly with when, by whom and why/)
    await expect(update(asMember(), 'SupplierBankAccount', refused, `status = 'REFUSED', "refusedAt" = now(), "refusedById" = $2::uuid, "refuseReason" = 'Not asked.', version = version + 1`, s.supplierUserId)).rejects.toThrow(/refused by an active office user/)
    expect(await update(asMember(), 'SupplierBankAccount', refused, `status = 'REFUSED', "refusedAt" = now(), "refusedById" = $2::uuid, "refuseReason" = 'Not asked.', version = version + 1`, s.memberId)).toBe(1)
    await expect(update(office(), 'SupplierBankAccount', s.bankAccountIds.refused, `"refuseReason" = 'Changed my mind.'`)).rejects.toThrow(/REFUSED already/)
  })

  it('are never deleted', async () => {
    await expect(run(office(), `DELETE FROM "SupplierBankAccount" WHERE id = $1::uuid`, s.bankAccountIds.pending)).rejects.toThrow(/permission denied/)
    await expect(admin(`DELETE FROM "SupplierBankAccount" WHERE id = $1::uuid`, [s.bankAccountIds.pending])).rejects.toThrow(/never deleted/)
    // CASCADE: B-W2b-370's payment proposal lines reference the accounts (a plain TRUNCATE stops at that foreign key); the table's
    // own trigger still refuses first.
    await expect(admin(`TRUNCATE "SupplierBankAccount" CASCADE`)).rejects.toThrow(/TRUNCATE on "SupplierBankAccount" is refused/)
  })

  it("are proposed in the portal only PROPOSED, of the supplier's own party, by one of its own people; the call-back and the checker stay unread", async () => {
    const columns = `id, "partyId", iban, holder, currency, "proposedById", "proposedAt"`
    const insert = (scope: FactoryScope, partyId: string, by: string, extra = '', extraValue = '') =>
      run(scope, `INSERT INTO "SupplierBankAccount" (${columns}${extra}) VALUES ($1::uuid, $2::uuid, $3, 'Seed Leather Supplier S.p.A.', 'EUR', $4::uuid, now()${extraValue})`, randomUUID(), partyId, nextIban(), by)
    expect(await insert(asSupplier(), s.partyP2, s.supplierUserId)).toBe(1)
    await expect(insert(asSupplier(), s.partyP1, s.supplierUserId)).rejects.toThrow(/row-level security/)
    await expect(insert(asSupplier(), s.partyP2, a.actorId)).rejects.toThrow(/an active person of its own supplier in the portal/)
    await expect(insert(asSupplier(), s.partyP2, s.supplierUserId, ', status', `, 'VERIFIED'`)).rejects.toThrow(/proposed PROPOSED at version 1/)
    await expect(insert(asSupplier(), s.partyP2, s.supplierUserId, ', "callBackById"', `, '${s.memberId}'`)).rejects.toThrow(/permission denied/)
    await expect(insert(asSupplier(), s.partyP2, s.supplierUserId, ', "createdById"', `, '${s.supplierUserId}'`)).rejects.toThrow(/permission denied/)
    await expect(run(asSupplier(), `UPDATE "SupplierBankAccount" SET "refuseReason" = NULL WHERE false`)).rejects.toThrow(/permission denied/)
    for (const column of ['callBackPhone', 'callBackById', 'callBackContactId', 'callBackAddressId', 'verifiedById', 'refusedById', 'createdById']) {
      await expect(sql(asSupplier(), `SELECT "${column}" FROM "SupplierBankAccount" LIMIT 1`)).rejects.toThrow(/permission denied/)
    }
    const own = await sql(asSupplier(), `SELECT "partyId", "ibanCountry", "ibanLast4", status::text AS status FROM "SupplierBankAccount" ORDER BY "proposedAt", id`)
    expect(own.length).toBeGreaterThan(4)
    expect(own.every((row) => row.partyId === s.partyP2)).toBe(true)
    expect((await sql(asCustomer(), `SELECT id FROM "SupplierBankAccount"`)).map((row) => row.id)).toEqual([s.bankAccountIds.p1])
  })
})

describe('qualifications (SCM-027, PLN-162)', () => {
  /** A new PENDING qualification of P2: a copy of the sewing one with `changes`. */
  async function qualification(changes: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID()
    expect(await copyRow(office(), 'SupplierQualification', s.qualificationIds.pending, { id, createdAt: ago(60), ...changes })).toBe(1)
    return id
  }
  const decide = (id: string, set: string, ...values: unknown[]) => update(asMember(), 'SupplierQualification', id, `${set}, version = version + 1`, ...values)

  it('are recorded PENDING for kinds of work, operations of the library or kinds of material, by the role they need', async () => {
    await expect(qualification({ status: 'APPROVED' })).rejects.toThrow(/recorded PENDING at version 1/)
    await expect(qualification({ workCentreKinds: [], operationIds: [] })).rejects.toThrow(/at least one kind of work, operation or kind of material/)
    await expect(qualification({ workCentreKinds: ['SEWING', 'SEWING'] })).rejects.toThrow(/each once/)
    await expect(qualification({ operationIds: [randomUUID()] })).rejects.toThrow(/operations of the tenant's library only/)
    await expect(qualification({ partyId: s.partyP1 })).rejects.toThrow(/for work only of a party with the SUBCONTRACTOR role/)
    await expect(qualification({ workCentreKinds: [], operationIds: [], materialKinds: ['TRIM'], partyId: s.partyP1 })).rejects.toThrow(/for materials only of one with the SUPPLIER role/)
    await expect(qualification({ validFrom: '2026-12-01', validUntil: '2026-11-01' })).rejects.toThrow(/until a day not before the day it holds from/)
    expect(await qualification({ workCentreKinds: ['FINISHING', 'ASSEMBLY'], operationIds: [], materialKinds: ['LEATHER', 'LINING'] })).toBeDefined()
  })

  it('rest on evidence of their own supplier: an accepted answer, an accepted document, a file of the supplier or the qualification', async () => {
    const shape = (evidence: unknown) => qualification({ evidence })
    await expect(shape({ recordType: 'StoredFile' })).rejects.toThrow(/lists its evidence as/)
    await expect(shape([{ recordType: 'Certificate', recordId: randomUUID() }])).rejects.toThrow(/names each evidence as/)
    await expect(shape([{ recordType: 'StoredFile', recordId: 'abc' }])).rejects.toThrow(/names each evidence as/)
    await expect(shape([{ recordType: 'StoredFile', recordId: s.fileIds.visitReport, extra: 1 }])).rejects.toThrow(/names each evidence as/)
    const twice = { recordType: 'SupplierDocumentUpload', recordId: s.certificateUploadId }
    await expect(shape([twice, twice])).rejects.toThrow(/each once/)
    await expect(shape([{ recordType: 'SupplierQuestionnaireResponse', recordId: supply.answers.open }])).rejects.toThrow(/ACCEPTED questionnaire answer of its own supplier/)
    await expect(shape([{ recordType: 'StoredFile', recordId: s.fileIds.terms2 }])).rejects.toThrow(/AVAILABLE file of its supplier or of the qualification/)
    const waiting = (await admin(`SELECT id FROM "SupplierDocumentUpload" WHERE "partyId" = $1::uuid AND status = 'WAITING' LIMIT 1`, [s.partyP2]))[0]!.id
    await expect(shape([{ recordType: 'SupplierDocumentUpload', recordId: waiting }])).rejects.toThrow(/ACCEPTED document of its own supplier/)
    expect(await update(office(), 'SupplierQuestionnaireResponse', supply.answers.open, `decision = 'ACCEPTED', "reviewedAt" = now(), "reviewedById" = $2::uuid, version = version + 1`, s.memberId)).toBe(1)
    expect(await shape([{ recordType: 'SupplierQuestionnaireResponse', recordId: supply.answers.open }, twice])).toBeDefined()
  })

  it('are decided once, from a day, on evidence; then their scope, days and evidence are fixed', async () => {
    const id = await qualification()
    await expect(decide(id, `status = 'APPROVED', "decidedAt" = now(), "decidedById" = $2::uuid`, s.memberId)).rejects.toThrow(/from a day, with at least one evidence/)
    expect(await update(office(), 'SupplierQualification', id, `"validFrom" = current_date, evidence = $2::jsonb, version = version + 1`, JSON.stringify([{ recordType: 'SupplierDocumentUpload', recordId: s.certificateUploadId }]))).toBe(1)
    await expect(decide(id, `status = 'APPROVED'`)).rejects.toThrow(/exactly with when and by whom it was decided/)
    await expect(decide(id, `status = 'APPROVED', "decidedAt" = now(), "decidedById" = $2::uuid`, s.supplierUserId)).rejects.toThrow(/decided by an active office user/)
    await expect(decide(id, `status = 'CONDITIONAL', "decidedAt" = now(), "decidedById" = $2::uuid`, s.memberId)).rejects.toThrow(/CONDITIONAL exactly with its conditions/)
    await expect(decide(id, `status = 'APPROVED', "decidedAt" = now(), "decidedById" = $2::uuid, conditions = 'Only black.'`, s.memberId)).rejects.toThrow(/CONDITIONAL exactly with its conditions/)
    expect(await decide(id, `status = 'APPROVED', "decidedAt" = now(), "decidedById" = $2::uuid`, s.memberId)).toBe(1)
    await expect(decide(id, `"validUntil" = current_date + 30`)).rejects.toThrow(/keeps what it is for, its days and its evidence once decided/)
    await expect(decide(id, `"workCentreKinds" = '{SEWING,FINISHING}'`)).rejects.toThrow(/once decided/)
    await expect(decide(id, `"decidedById" = $2::uuid`, a.actorId)).rejects.toThrow(/decided once/)
    await expect(decide(id, `status = 'CONDITIONAL', conditions = 'Late.'`)).rejects.toThrow(/decided once|not APPROVED → CONDITIONAL/)
    await expect(update(office(), 'SupplierQualification', id, `"partyId" = $2::uuid`, s.partyP1)).rejects.toThrow(/keeps its company, supplier and creation/)
    // REFUSED: with why, then final.
    const refused = await qualification()
    await expect(decide(refused, `status = 'REFUSED', "decidedAt" = now(), "decidedById" = $2::uuid`, s.memberId)).rejects.toThrow(/REFUSED exactly with why/)
    expect(await decide(refused, `status = 'REFUSED', "decidedAt" = now(), "decidedById" = $2::uuid, "refuseReason" = 'No visit possible.'`, s.memberId)).toBe(1)
    await expect(decide(refused, `status = 'WITHDRAWN', "withdrawnAt" = now(), "withdrawReason" = 'x'`)).rejects.toThrow(/REFUSED already: it never changes again/)
  })

  it('are suspended with why and lifted back to their decision; withdrawn with why; never deleted', async () => {
    const id = s.qualificationIds.suspended
    await expect(decide(id, `status = 'APPROVED', "suspendedAt" = NULL, "suspendReason" = NULL`)).rejects.toThrow(/lifted back to its decision \(CONDITIONAL\)/)
    await expect(decide(id, `status = 'CONDITIONAL'`)).rejects.toThrow(/SUSPENDED exactly with since when/)
    expect(await decide(id, `status = 'CONDITIONAL', "suspendedAt" = NULL, "suspendReason" = NULL`)).toBe(1)
    await expect(decide(id, `status = 'SUSPENDED', "suspendedAt" = now()`)).rejects.toThrow(/SUSPENDED exactly with since when .* and why/)
    await expect(decide(id, `status = 'SUSPENDED', "suspendedAt" = '2026-10-01', "suspendReason" = 'Too early.'`)).rejects.toThrow(/not before its decision/)
    expect(await decide(id, `status = 'SUSPENDED', "suspendedAt" = now(), "suspendReason" = 'DURC expired again.'`)).toBe(1)
    await expect(decide(id, `status = 'WITHDRAWN', "withdrawnAt" = now()`)).rejects.toThrow(/SUSPENDED exactly with since when/)
    await expect(decide(id, `status = 'WITHDRAWN', "suspendedAt" = NULL, "suspendReason" = NULL, "withdrawnAt" = now()`)).rejects.toThrow(/WITHDRAWN exactly with when .* and why/)
    expect(await decide(id, `status = 'WITHDRAWN', "suspendedAt" = NULL, "suspendReason" = NULL, "withdrawnAt" = now(), "withdrawReason" = 'We stopped finishing outside.'`)).toBe(1)
    await expect(decide(id, `"withdrawReason" = 'Changed.'`)).rejects.toThrow(/WITHDRAWN already/)
    // A PENDING one may be withdrawn before any decision.
    expect(await decide(await qualification(), `status = 'WITHDRAWN', "withdrawnAt" = now(), "withdrawReason" = 'Not needed any more.'`)).toBe(1)
    await expect(decide(s.qualificationIds.pending, `status = 'SUSPENDED', "suspendedAt" = now(), "suspendReason" = 'x'`)).rejects.toThrow(/not PENDING → SUSPENDED/)
    await expect(run(office(), `DELETE FROM "SupplierQualification" WHERE id = $1::uuid`, s.qualificationIds.pending)).rejects.toThrow(/permission denied/)
    await expect(admin(`DELETE FROM "SupplierQualification" WHERE id = $1::uuid`, [s.qualificationIds.pending])).rejects.toThrow(/never deleted/)
  })
})

describe('subcontract agreements (SCM-049; L. 192/1998 art. 2)', () => {
  /** A new DRAFT revision of company A with P2: a copy of the draft for 2027 with `changes`. */
  async function draft(changes: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID()
    expect(await copyRow(office(), 'SubcontractAgreement', s.agreementIds.draft, { id, revision: 1000 + (accountNumber++ % 1000), ...changes })).toBe(1)
    return id
  }
  /** An AVAILABLE file of the agreement (rows only). */
  async function termsFile(recordId: string, status = 'AVAILABLE'): Promise<string> {
    const id = randomUUID()
    expect(
      await copyRow(office(), 'StoredFile', s.fileIds.terms2, { id, recordId, status, availableAt: status === 'AVAILABLE' ? new Date().toISOString() : null, storageKey: `t/${a.tenantId}/c/${s.companyA}/2026/${id}`, seriesId: null }),
    ).toBe(1)
    return id
  }

  it('are written DRAFT with a workshop of the company, from revision 1', async () => {
    await expect(draft({ status: 'SUPERSEDED', signedAt: ago(2), endedAt: ago(1), termsFileId: s.fileIds.terms2 })).rejects.toThrow(/written DRAFT at version 1/)
    await expect(draft({ revision: 0 })).rejects.toThrow(/from revision 1/)
    await expect(draft({ partyId: s.partyP1 })).rejects.toThrow(/with a workshop \(the SUBCONTRACTOR role\)/)
    await expect(draft({ title: '' })).rejects.toThrow(/a title of one line/)
    await expect(draft({ validUntil: '2026-12-31' })).rejects.toThrow(/until a day not before its first day/)
    await expect(copyRow(office(), 'SubcontractAgreement', s.agreementIds.draft, { id: randomUUID() })).rejects.toThrow(/duplicate key|unique/)
  })

  it('are signed with their file, one SIGNED per company and workshop, then fixed until superseded or terminated', async () => {
    const id = await draft()
    const file = await termsFile(id)
    // Revision 2 is SIGNED: a second one is refused until it is superseded.
    await expect(update(office(), 'SubcontractAgreement', id, `status = 'SIGNED', "signedAt" = now(), "termsFileId" = $2::uuid, version = version + 1`, file)).rejects.toThrow(/duplicate key|unique/)
    expect(await update(office(), 'SubcontractAgreement', s.agreementIds.signed, `status = 'SUPERSEDED', "endedAt" = now(), version = version + 1`)).toBe(1)
    await expect(update(office(), 'SubcontractAgreement', id, `status = 'SIGNED', "signedAt" = now(), "termsFileId" = NULL, version = version + 1`)).rejects.toThrow(/signed exactly with when .* and its signed file/)
    const otherFile = await termsFile(s.agreementIds.signed)
    await expect(update(office(), 'SubcontractAgreement', id, `status = 'SIGNED', "signedAt" = now(), "termsFileId" = $2::uuid, version = version + 1`, otherFile)).rejects.toThrow(/AVAILABLE file of the agreement or of its workshop/)
    const waitingFile = await termsFile(id, 'PENDING_UPLOAD')
    await expect(update(office(), 'SubcontractAgreement', id, `status = 'SIGNED', "signedAt" = now(), "termsFileId" = $2::uuid, version = version + 1`, waitingFile)).rejects.toThrow(/AVAILABLE file/)
    await expect(update(office(), 'SubcontractAgreement', id, `status = 'SIGNED', "signedAt" = now() + interval '1 day', "termsFileId" = $2::uuid, version = version + 1`, file)).rejects.toThrow(/not in the future/)
    expect(await update(office(), 'SubcontractAgreement', id, `status = 'SIGNED', "signedAt" = now(), "termsFileId" = $2::uuid, version = version + 1`, file)).toBe(1)
    await expect(update(office(), 'SubcontractAgreement', id, `title = 'Changed'`)).rejects.toThrow(/is signed: its title, file, signature and days are fixed/)
    await expect(update(office(), 'SubcontractAgreement', id, `revision = 9`)).rejects.toThrow(/keeps its company, workshop, revision and creation/)
    await expect(update(office(), 'SubcontractAgreement', id, `status = 'DRAFT', "signedAt" = NULL`)).rejects.toThrow(/is signed/)
    await expect(update(office(), 'SubcontractAgreement', id, `status = 'TERMINATED', "endedAt" = now()`)).rejects.toThrow(/TERMINATED with why/)
    await expect(update(office(), 'SubcontractAgreement', id, `status = 'TERMINATED', "endedAt" = '2026-01-01', "endReason" = 'Closed.'`)).rejects.toThrow(/not before it was signed/)
    expect(await update(office(), 'SubcontractAgreement', id, `status = 'TERMINATED', "endedAt" = now(), "endReason" = 'The workshop closed.', version = version + 1`)).toBe(1)
    await expect(update(office(), 'SubcontractAgreement', id, `"endReason" = 'Changed.'`)).rejects.toThrow(/TERMINATED already/)
    await expect(update(office(), 'SubcontractAgreement', s.agreementIds.superseded, `"endReason" = 'Changed.'`)).rejects.toThrow(/SUPERSEDED already/)
  })

  it('are deleted only while DRAFT', async () => {
    const id = await draft()
    expect(await run(office(), `DELETE FROM "SubcontractAgreement" WHERE id = $1::uuid`, id)).toBe(1)
    await expect(run(office(), `DELETE FROM "SubcontractAgreement" WHERE id = $1::uuid`, s.agreementIds.superseded)).rejects.toThrow(/only a DRAFT is deleted/)
    await expect(admin(`TRUNCATE "SubcontractAgreement"`)).rejects.toThrow(/TRUNCATE on "SubcontractAgreement" is refused/)
  })
})

describe('grants', () => {
  it('the floor reads nothing here; a portal session reads no qualification or agreement', async () => {
    for (const table of ['SupplierBankAccount', 'SupplierQualification', 'SubcontractAgreement']) {
      await expect(sql(floor(), `SELECT id FROM "${table}" LIMIT 1`)).rejects.toThrow(/permission denied/)
    }
    for (const table of ['SupplierQualification', 'SubcontractAgreement']) {
      await expect(sql(asSupplier(), `SELECT id FROM "${table}" LIMIT 1`)).rejects.toThrow(/permission denied/)
    }
  })
})
