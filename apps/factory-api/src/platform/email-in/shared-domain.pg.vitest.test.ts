import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { sortMail, type SortFacts } from '@nexus/factory-domain/email-in/rules'
import { callerFor, command, type CommandCaller } from '../../core/command'
import { BRAND_ALPHA, BRAND_BETA } from '../../golden-flow/portal/testing/two-brands'
import { addTenant, startHarness, type Harness, type TestTenant } from '../auth/sessions/testing/harness'
import { systemContext } from '../outbox/system'
import { useThreadRecords, type RecordResolver } from '../threads/records'
import { ensureThread, writeMessage } from '../threads/threads'
import { MAIL_FACTS, sortFactsOf, type MailFacts } from './match'

/**
 * B-TH-033 (threads plan TH-2, WALL-G14, wall tests T22 and T23; Owner rule 2026-11-16: "One brand must not be able to see
 * anything related to any other brand"): mail in never trusts a shared domain. A reply that names brand A's thread (its reply
 * token or our own Message-ID) is "known" by a company domain only when that domain is brand A's ALONE: a brand B person at a
 * domain both brands use (a group) writing to brand A's thread is held for a person (UNKNOWN_SENDER), never shared with brand
 * A. A contact of both brands writing without a token goes to triage (a person decides). The sorting's facts are read as the
 * worker reads them (the tenant's system scope, row-level security real); `sortMail` decides.
 *
 * Brand Alpha and Brand Beta are the two-brand harness's names; their people share the made-up group domain
 * `brand-group.example`. Run with `node scripts/factory/run-pg-tests.mjs platform/email-in`.
 */

let h: Harness
let tenant: TestTenant
const alpha = newId()
const beta = newId()
const alphaQuote = newId()
const GROUP = 'brand-group.example'
const ALPHA_OWN = 'alpha-own.example'
const people = {
  alphaAtGroup: `alma@${GROUP}`,
  betaAtGroup: `bruno@${GROUP}`,
  alphaOwn: `anna@${ALPHA_OWN}`,
  both: `shared.buyer@${GROUP}`,
}
let quotes: Map<string, { companyId: string; partyId: string }>

const system = (): CommandCaller => callerFor(h.database, systemContext(tenant.id, newId()))

async function party(id: string, brand: typeof BRAND_ALPHA, emails: readonly string[]): Promise<void> {
  await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: newId() }, async (client) => {
    await client.party.create({ data: { id, code: brand.code, kind: 'ORGANISATION', legalName: brand.legalName, tradeName: brand.tradeName, roles: ['CUSTOMER', 'BRAND'] } })
    for (const email of emails) await client.partyContact.create({ data: { id: newId(), partyId: id, name: `Contact ${email.split('@')[0]}`, email } })
  })
}

/** Brand A's record thread with one OUTBOUND mail of ours (its Message-ID is what a reply names). */
async function alphaThread(ourMessageId: string): Promise<string> {
  const { result } = await command(system(), { name: 'threads.testOpen', input: { alphaQuote, ourMessageId } }, async (tools) => {
    const { thread } = await ensureThread(tools, { type: 'Quote', id: alphaQuote }, null)
    tools.audit({ action: 'threads.testOpen', recordType: 'Thread', recordId: thread.id })
    await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'EMAIL', author: { kind: 'SYSTEM', id: null, name: 'Test' }, bodyText: 'Here is the quote.', emailMessageId: ourMessageId })
    return thread.id
  })
  return result
}

/** The sorting's facts of one mail (as the worker reads them), and where `sortMail` sends it. */
async function sorted(mail: { readonly from: string; readonly inReplyTo?: string }): Promise<{ facts: SortFacts; outcome: ReturnType<typeof sortMail> }> {
  const row = {
    ...Object.fromEntries(Object.keys(MAIL_FACTS).map((key) => [key, null])),
    id: newId(),
    status: 'RECEIVED',
    companyId: tenant.companies[0]!.id,
    envelopeTo: [],
    to: ['orders@factory.example.com'],
    cc: [],
    fromAddress: mail.from,
    emailMessageId: `<${newId()}@sender.example>`,
    inReplyTo: mail.inReplyTo ?? null,
    referenceIds: [],
    spfVerdict: 'PASS',
    dkimVerdict: 'PASS',
    dmarcVerdict: 'PASS',
    spamVerdict: 'PASS',
    virusVerdict: 'PASS',
    subject: 'About the order',
  } as unknown as MailFacts & { subject: string }
  const { result } = await command(system(), { name: 'emailIn.testFacts', input: { from: mail.from } }, async (tools) => {
    tools.audit({ action: 'emailIn.testFacts', recordType: 'Tenant', recordId: tenant.id })
    return (await sortFactsOf(tools.tx, row)).facts
  })
  return { facts: result, outcome: sortMail(result) }
}

beforeAll(async () => {
  h = await startHarness('email_in_shared')
  tenant = await addTenant(h, 'th033-mail')
  const companyId = tenant.companies[0]!.id
  quotes = new Map([[alphaQuote, { companyId, partyId: alpha }]])
  const quoteResolver: RecordResolver = async (client, id) => {
    const found = quotes.get(id)
    return found && (await client.company.findUnique({ where: { id: found.companyId }, select: { id: true } })) ? { companyId: found.companyId, siteId: null, partyId: found.partyId } : null
  }
  const partyResolver: RecordResolver = async (client, id) => {
    const found = await client.party.findUnique({ where: { id }, select: { companyId: true } })
    return found ? { companyId: found.companyId, siteId: null, partyId: id } : null
  }
  useThreadRecords({ Quote: quoteResolver, Party: partyResolver })
  await party(alpha, BRAND_ALPHA, [people.alphaAtGroup, people.alphaOwn, people.both])
  await party(beta, BRAND_BETA, [people.betaAtGroup, people.both])
}, 90_000)

afterAll(async () => {
  useThreadRecords(undefined)
  await h?.close()
}, 60_000)

describe('T22: a shared domain never makes a sender known (B-TH-033, WALL-G14)', () => {
  it("a brand B person at the group's domain answering brand A's thread is held, not shared with brand A", async () => {
    const ours = `<out-${newId()}@factory.example.com>`
    const threadId = await alphaThread(ours)
    const { facts, outcome } = await sorted({ from: people.betaAtGroup, inReplyTo: ours })
    expect(facts.thread).toMatchObject({ id: threadId, partyId: alpha, by: 'HEADERS' })
    expect(facts.senderKnown).toBeNull()
    expect(outcome).toEqual({ status: 'HELD', reason: 'UNKNOWN_SENDER', threadId })
  })

  it("anyone else at the group's domain is held too; brand A's own contact there still joins", async () => {
    const ours = `<out-${newId()}@factory.example.com>`
    const threadId = await alphaThread(ours)
    expect((await sorted({ from: `newcomer@${GROUP}`, inReplyTo: ours })).outcome).toEqual({ status: 'HELD', reason: 'UNKNOWN_SENDER', threadId })
    const own = await sorted({ from: people.alphaAtGroup, inReplyTo: ours })
    expect(own.facts.senderKnown).toBe('CONTACT')
    expect(own.outcome).toEqual({ status: 'MATCHED', by: 'HEADERS', threadId })
  })

  it("a domain that is brand A's alone still makes a colleague known (as before)", async () => {
    const ours = `<out-${newId()}@factory.example.com>`
    const threadId = await alphaThread(ours)
    const colleague = await sorted({ from: `alfredo@${ALPHA_OWN}`, inReplyTo: ours })
    expect(colleague.facts.senderKnown).toBe('DOMAIN')
    expect(colleague.outcome).toEqual({ status: 'MATCHED', by: 'HEADERS', threadId })
  })
})

describe('T23: a contact of two brands writing without a token goes to a person (B-TH-033, W23)', () => {
  it('a contact of brand A and brand B is matched to neither: triage', async () => {
    const { facts, outcome } = await sorted({ from: people.both })
    expect(facts.thread).toBeNull()
    expect(facts.senderParty).toBeNull()
    expect(outcome).toEqual({ status: 'TRIAGE', threadId: null })
  })

  it("a contact of brand A alone joins brand A's own thread (as before)", async () => {
    const { facts, outcome } = await sorted({ from: people.alphaOwn })
    expect(facts.senderParty).toMatchObject({ partyId: alpha })
    expect(outcome.status).toBe('MATCHED')
  })
})
