import { DomainError, ForbiddenError, NotFoundError, isDomainError } from '@nexus/factory-domain/core/errors'
import { can, grantsFor } from '@nexus/factory-domain/core/permissions'
import { PAYABLES_VIEW } from '@nexus/factory-domain/payables/permissions'
import { PAYABLES_REMITTANCE_SWITCH } from '@nexus/factory-domain/payables/proposal/permissions'
import { supplierLanguageOf } from '@nexus/factory-domain/purchasing/orders'
import { copiesOf, routeMail } from '@nexus/factory-domain/purchasing/suppliers-depth/routing'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { sendEmail } from '../../../platform/email-out/outbound'
import { senderOf } from '../../purchasing/store'
import { officeOf, type Reader } from '../store'

/**
 * The remittance advice (B-W2b-403; PQ1:02 "the remittance advice goes through routeMail('REMITTANCE') (behind the company's
 * remittance switch, OFF)"; the Owner's rule of 11-13: every message that would go out by itself has a per-company switch,
 * OFF by default; factory-db PayablesSettings.remittanceMailOn, B-W2b-370). When a payment proposal is recorded paid, each
 * of its suppliers gets one mail naming the invoices paid, the day and the bank's reference — never an IBAN, and no amount
 * (the mail is kept on the invoice's thread, which office readers without the cost grain see) — to the contacts that
 * receive remittances (routeMail: by what they receive, else W1's INVOICES role), on the thread of its first invoice of the
 * proposal. Each supplier's mail is its own command (a mail that cannot go never undoes the payment), FAKE e-mail locally.
 *
 *   GET /payables/remittance/settings?companyId   payables.view: the switch as it holds (company row, tenant row, off), words
 *   PUT /payables/remittance/settings             payables.remittance.switch (the Owner's; turning it ON asks a fresh code):
 *                                                 { companyId | null, remittanceMailOn, version? } — the PayablesSettings row
 *                                                 (made when missing), payables_settings.changed
 */

export interface Remittance {
  readonly on: boolean
  readonly source: 'COMPANY' | 'TENANT' | 'NONE'
  readonly settingsId: string | null
  readonly version: number | null
  readonly words: { readonly en: string; readonly it: string }
}

const OFF_WORDS = { en: 'Remittance advices are off: suppliers are not e-mailed when they are paid (the Owner switches them on per company).', it: 'Gli avvisi di pagamento sono spenti: i fornitori non ricevono una mail quando sono pagati (li accende il titolare, per società).' }
const ON_WORDS = { en: 'Remittance advices are on: each supplier paid gets one mail naming its invoices, the day and the bank reference (never the bank details).', it: 'Gli avvisi di pagamento sono accesi: ogni fornitore pagato riceve una mail con le fatture, il giorno e il riferimento della banca (mai le coordinate).' }

/** The switch in force for a company (its row, else the tenant's, else off); companyId null: the tenant's row. */
export async function remittanceOf(db: Reader, companyId: string | null): Promise<Remittance> {
  const rows = await db.payablesSettings.findMany({ where: { OR: [{ companyId: null }, ...(companyId ? [{ companyId }] : [])] }, select: { id: true, companyId: true, version: true, remittanceMailOn: true } })
  const own = companyId ? rows.find((row) => row.companyId === companyId) : undefined
  const tenant = rows.find((row) => row.companyId === null)
  const row = own ?? tenant
  if (!row) return { on: false, source: 'NONE', settingsId: null, version: null, words: OFF_WORDS }
  return { on: row.remittanceMailOn, source: own ? 'COMPANY' : 'TENANT', settingsId: row.id, version: row.version, words: row.remittanceMailOn ? ON_WORDS : OFF_WORDS }
}

export interface RemittanceOutcome {
  readonly partyId: string
  readonly sent: boolean
  /** Why not: SWITCHED_OFF, NO_CONTACT (nobody receives remittances), NOT_SENT (the mail was refused: `words`). */
  readonly held: 'SWITCHED_OFF' | 'NO_CONTACT' | 'NOT_SENT' | null
  readonly emailId: string | null
  readonly recipients: number
  readonly words: string | null
}

const dayOf = (value: Date | null): string => (value === null ? '' : value.toISOString().slice(0, 10))

/** The mail's words in the supplier's language (no amount, no IBAN). */
function mailOf(language: 'it' | 'en', company: string, invoices: readonly { number: string; issueDate: Date }[], paidOn: string, reference: string) {
  const list = invoices.map((invoice) => `- ${invoice.number} (${dayOf(invoice.issueDate)})`).join('\n')
  return language === 'it'
    ? { subject: `Avviso di pagamento — ${company} — ${paidOn}`, body: `Buongiorno,\n\nvi comunichiamo il pagamento delle fatture seguenti, con bonifico del ${paidOn} (riferimento banca: ${reference}):\n${list}\n\nCordiali saluti,\n${company}` }
    : { subject: `Remittance advice — ${company} — ${paidOn}`, body: `Hello,\n\nwe let you know that the invoices below were paid by bank transfer on ${paidOn} (bank reference: ${reference}):\n${list}\n\nKind regards,\n${company}` }
}

/** After a proposal is recorded paid: one remittance per supplier, while the company's switch is on. */
export async function sendRemittances(caller: CommandCaller, proposalId: string, idempotencyKey?: string): Promise<RemittanceOutcome[]> {
  const context = officeOf(caller)
  const facts = await caller.withClient(async (client) => {
    const proposal = await client.paymentProposal.findUniqueOrThrow({ where: { id: proposalId }, select: { id: true, companyId: true, company: { select: { legalName: true } }, lines: { select: { partyId: true, supplierInvoice: { select: { id: true, number: true, issueDate: true, dueDate: true, paidOn: true, paymentRef: true } } } } } })
    return { proposal, switch: await remittanceOf(client, proposal.companyId) }
  })
  const bySupplier = new Map<string, { id: string; number: string; issueDate: Date; dueDate: Date | null; paidOn: Date | null; paymentRef: string | null }[]>()
  for (const line of facts.proposal.lines) bySupplier.set(line.partyId, [...(bySupplier.get(line.partyId) ?? []), line.supplierInvoice])
  const outcomes: RemittanceOutcome[] = []
  for (const [partyId, invoices] of bySupplier) {
    if (!facts.switch.on) {
      outcomes.push({ partyId, sent: false, held: 'SWITCHED_OFF', emailId: null, recipients: 0, words: OFF_WORDS.en })
      continue
    }
    const ordered = [...invoices].sort((a, b) => dayOf(a.dueDate).localeCompare(dayOf(b.dueDate)) || a.number.localeCompare(b.number))
    try {
      const { result } = await command(caller, { name: 'payables.proposals.remittance', idempotencyKey: idempotencyKey ? `${idempotencyKey}:remit:${partyId}` : undefined, input: { proposalId, partyId } }, async (tools) => {
        const party = await tools.tx.party.findUniqueOrThrow({ where: { id: partyId }, select: { language: true } })
        const contacts = await tools.tx.partyContact.findMany({ where: { partyId, status: 'ACTIVE', email: { not: null } }, select: { id: true, name: true, email: true, roles: true, receives: true, language: true, status: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] })
        const routing = routeMail('REMITTANCE', contacts)
        if (routing.contacts.length === 0) {
          tools.audit({ action: 'payables.proposals.remittanceHeld', recordType: 'PaymentProposal', recordId: proposalId, companyId: facts.proposal.companyId, after: { partyId, held: 'NO_CONTACT' } })
          return { emailId: null, recipients: 0 }
        }
        const to = routing.contacts[0]!
        const cc = copiesOf('REMITTANCE', contacts, to.email)
        const language = supplierLanguageOf(to.language, party.language)
        const paid = ordered[0]!
        const mail = mailOf(language, facts.proposal.company.legalName, ordered, dayOf(paid.paidOn), paid.paymentRef ?? '')
        const sent = await sendEmail(tools, { record: { type: 'SupplierInvoice', id: paid.id }, sender: await senderOf(tools.tx, context), to: [to.email!], cc, subject: mail.subject, body: mail.body, locale: language })
        tools.audit({ action: 'payables.proposals.remittance', recordType: 'PaymentProposal', recordId: proposalId, companyId: facts.proposal.companyId, after: { partyId, outboundId: sent.outbound.id, recipients: 1 + cc.length, invoices: ordered.length, by: routing.by } })
        return { emailId: sent.outbound.id, recipients: 1 + cc.length }
      })
      outcomes.push(result.emailId ? { partyId, sent: true, held: null, emailId: result.emailId, recipients: result.recipients, words: null } : { partyId, sent: false, held: 'NO_CONTACT', emailId: null, recipients: 0, words: 'No active contact with an e-mail receives remittance advices (nor has the INVOICES role).' })
    } catch (error) {
      // The payment stands; the mail did not go (no sender identity, a refused address …): said in words.
      if (!isDomainError(error)) throw error
      outcomes.push({ partyId, sent: false, held: 'NOT_SENT', emailId: null, recipients: 0, words: error.message })
    }
  }
  return outcomes
}

// ---- the Owner's switch ----------------------------------------------------------------------------------------------------

/** Over a company, or (null: the tenant-wide row) a grant over every company. */
const mayAt = (context: OfficeContext, permission: typeof PAYABLES_VIEW | typeof PAYABLES_REMITTANCE_SWITCH, companyId: string | null): boolean =>
  companyId === null ? grantsFor(actorOf(context), permission).some((grant) => grant.companies === 'all') : can(actorOf(context), permission, { companyId })

async function answerFor(db: Reader, context: OfficeContext, companyId: string | null) {
  return { companyId, ...(await remittanceOf(db, companyId)), mayChange: mayAt(context, PAYABLES_REMITTANCE_SWITCH, companyId) }
}

/** GET /payables/remittance/settings (payables.view). */
export async function getRemittanceSettings(caller: CommandCaller, query: { readonly companyId?: string | undefined }) {
  const context = officeOf(caller)
  const companyId = query.companyId ?? null
  if (companyId !== null && !can(actorOf(context), PAYABLES_VIEW, { companyId })) throw new NotFoundError('Company not found.')
  return caller.withClient(async (db) => {
    if (companyId !== null && !(await db.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
    return answerFor(db, context, companyId)
  })
}

/** PUT /payables/remittance/settings (payables.remittance.switch; turning it ON also asks a fresh code). */
export async function putRemittanceSettings(caller: CommandCaller, body: { readonly companyId: string | null; readonly remittanceMailOn: boolean; readonly version?: number | undefined }, stepUp: () => void, idempotencyKey?: string) {
  const context = officeOf(caller)
  if (!mayAt(context, PAYABLES_REMITTANCE_SWITCH, body.companyId)) throw new ForbiddenError(body.companyId === null ? 'The switch of every company is changed only by a role over every company.' : undefined)
  const before = await caller.withClient((db) => remittanceOf(db, body.companyId))
  if (body.remittanceMailOn && !before.on) stepUp()
  await command(caller, { name: 'payables.remittanceSwitch', idempotencyKey, input: body }, async (tools) => {
    const id = body.companyId ?? context.tenantId
    if (body.companyId !== null && !(await tools.tx.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
    await tools.tx.$queryRaw`SELECT id FROM "PayablesSettings" WHERE id = ${id}::uuid FOR UPDATE`
    const existing = await tools.tx.payablesSettings.findUnique({ where: { id }, select: { id: true, version: true, remittanceMailOn: true } })
    if (existing && body.version !== undefined && body.version !== existing.version) throw new DomainError('conflict', `These settings changed since they were read; they are now at version ${existing.version}. Reload them and change them again.`, [{ path: 'body/version', message: `The current version is ${existing.version}.` }])
    if (existing && existing.remittanceMailOn === body.remittanceMailOn) {
      tools.audit({ action: 'payables.remittanceSwitch', recordType: 'PayablesSettings', recordId: id, companyId: body.companyId, after: { remittanceMailOn: body.remittanceMailOn, unchanged: true } })
      return { id }
    }
    if (existing) await tools.tx.payablesSettings.update({ where: { id }, data: { remittanceMailOn: body.remittanceMailOn, version: existing.version + 1, updatedAt: tools.now }, select: { id: true } })
    else await tools.tx.payablesSettings.create({ data: { id, companyId: body.companyId, remittanceMailOn: body.remittanceMailOn, createdAt: tools.now, updatedAt: tools.now, createdById: context.actorId }, select: { id: true } })
    tools.audit({ action: 'payables.remittanceSwitch', recordType: 'PayablesSettings', recordId: id, companyId: body.companyId, before: existing ? { remittanceMailOn: existing.remittanceMailOn } : null, after: { remittanceMailOn: body.remittanceMailOn } })
    tools.emit({ type: 'payables_settings.changed', subject: id, companyId: body.companyId, payload: { settingsId: id, companyId: body.companyId, fields: ['remittanceMailOn'], created: !existing } })
    return { id }
  })
  return caller.withClient((db) => answerFor(db, context, body.companyId))
}
