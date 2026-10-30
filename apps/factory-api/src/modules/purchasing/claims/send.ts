import { InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { claimMail } from '@nexus/factory-domain/purchasing/claims/mail'
import { PURCHASING_CLAIMS_MANAGE } from '@nexus/factory-domain/purchasing/claims/permissions'
import { CLAIM_LIMITS, CLAIM_REASON_LIST, readClaimReason, sendProblems, type ClaimKind, type ClaimRemedy } from '@nexus/factory-domain/purchasing/claims/rules'
import { supplierLanguageOf } from '@nexus/factory-domain/purchasing/orders'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { sendEmail } from '../../../platform/email-out/outbound'
import { actorIdOf, senderOf, type Reader } from '../store'
import { detailInCommand } from './claims'
import { followDiscrepancies } from './follow'
import { CLAIM_RECORD, claimInCommand, factsOf, officeClaim, readLines, type ClaimRow } from './store'
import type { ClaimDetailView } from './views'

/**
 * Sending a claim to the supplier (B-W2a-44; SCM-134; design purchasing.claims "Send to supplier"): a DRAFT, or a claim
 * the supplier REJECTED (again, with more evidence), goes to SENT (sentAt, sentById) with a remedy chosen; the
 * discrepancies it pursues are reported with it (OPEN → SENT). By e-mail on the claim's thread (record SupplierClaim:
 * the supplier's party, so its reply lands on the claim) to the supplier's contacts — the text of factory-domain claims
 * `claimMail` in the supplier's language, never a price — or `mail: null` when the supplier was told another way (the
 * goods travel with the return DDT, a call). E-mail leaves through email out (QUEUED; the worker delivers it; FAKE SES
 * locally and in tests): no real provider here.
 *
 *   GET  /purchasing/claims/:claimId/send-check   purchasing.claims.manage: the contacts with an e-mail (QUALITY, then
 *        ORDERS first, the first suggested), the language, the subject and standard text, and why it cannot go yet
 *   POST /purchasing/claims/:claimId/send         purchasing.claims.manage: {version, remedy?, mail: {contactIds, cc?,
 *        subject?, message?, language?} | null}
 */

export interface MailInput {
  readonly contactIds: readonly string[]
  readonly cc?: readonly string[] | undefined
  readonly subject?: string | null | undefined
  /** The office's own words in place of the standard text. */
  readonly message?: string | null | undefined
  readonly language?: DocumentLanguage | undefined
}

export interface SendInput {
  readonly version: number
  readonly remedy?: ClaimRemedy | undefined
  readonly mail: MailInput | null
}

const QUALITY_FIRST = (roles: readonly string[]) => (roles.includes('QUALITY') ? 0 : roles.includes('ORDERS') ? 1 : 2)

/** The supplier's active contacts with an e-mail, QUALITY then ORDERS first. */
async function contactsOf(db: Reader, partyId: string) {
  const party = await db.party.findUniqueOrThrow({ where: { id: partyId }, select: { id: true, legalName: true, language: true } })
  const contacts = await db.partyContact.findMany({ where: { partyId, status: 'ACTIVE', email: { not: null } }, select: { id: true, name: true, email: true, roles: true, language: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] })
  return { party, contacts: [...contacts].sort((a, b) => QUALITY_FIRST(a.roles) - QUALITY_FIRST(b.roles)) }
}

/** The claim's mail in a language: its lines named as the supplier knows them (no price). */
async function mailOf(db: Reader, claim: ClaimRow, language: DocumentLanguage, recipientName: string | null, message: string | null) {
  const lines = await readLines(db, claim.id)
  const items = new Map((await db.item.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.itemId))] } }, select: { id: true, code: true, name: true, nameI18n: true } })).map((row) => [row.id, row]))
  const colours = new Map((await db.itemColour.findMany({ where: { id: { in: lines.flatMap((line) => (line.itemColourId ? [line.itemColourId] : [])) } }, select: { id: true, name: true } })).map((row) => [row.id, row.name]))
  const lots = new Map((await db.lot.findMany({ where: { id: { in: lines.flatMap((line) => (line.lotId ? [line.lotId] : [])) } }, select: { id: true, code: true, supplierLotRef: true } })).map((row) => [row.id, row]))
  const hides = new Map((await db.hide.findMany({ where: { id: { in: lines.flatMap((line) => (line.hideId ? [line.hideId] : [])) } }, select: { id: true, code: true, supplierCode: true } })).map((row) => [row.id, row]))
  const { code, note } = readClaimReason(claim.reason)
  const reason = code ? await db.reasonCode.findFirst({ where: { list: CLAIM_REASON_LIST, code }, select: { labelIt: true, labelEn: true } }) : null
  const receipt = claim.goodsReceiptId ? await db.goodsReceipt.findUnique({ where: { id: claim.goodsReceiptId }, select: { number: true, supplierDdtNumber: true } }) : null
  const order = claim.purchaseOrderId ? await db.purchaseOrder.findUnique({ where: { id: claim.purchaseOrderId }, select: { number: true } }) : null
  const named = (names: unknown, fallback: string) => {
    const value = names !== null && typeof names === 'object' ? (names as Record<string, unknown>)[language] : null
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  }
  return claimMail({
    language,
    number: claim.number,
    kind: claim.kind as ClaimKind,
    remedy: claim.remedy as ClaimRemedy | null,
    reason: { label: reason ? (language === 'it' ? reason.labelIt : reason.labelEn) : null, note: code ? note : claim.reason },
    receiptNumber: receipt?.number ?? null,
    supplierDdtNumber: receipt?.supplierDdtNumber ?? null,
    orderNumber: order?.number ?? null,
    lines: lines.map((line) => {
      const item = items.get(line.itemId)
      const lot = line.lotId ? lots.get(line.lotId) : undefined
      const hide = line.hideId ? hides.get(line.hideId) : undefined
      return {
        seq: line.seq,
        code: item?.code ?? '',
        name: item ? named(item.nameI18n, item.name) : '',
        colour: line.itemColourId ? (colours.get(line.itemColourId) ?? null) : null,
        // The supplier's own references beside ours: its lot and the tannery's hide number.
        lot: lot ? (lot.supplierLotRef ? `${lot.code} / ${lot.supplierLotRef}` : lot.code) : null,
        hide: hide ? (hide.supplierCode ? `${hide.code} / ${hide.supplierCode}` : hide.code) : null,
        quantity: line.quantity.toFixed(4),
        uom: line.uom,
        reason: line.reason,
      }
    }),
    recipientName,
    message,
  })
}

/** purchasing.claims.manage: what the send would do now, and why it cannot yet. */
export async function sendCheck(caller: CommandCaller, claimId: string) {
  const { claim } = await officeClaim(caller, claimId, PURCHASING_CLAIMS_MANAGE)
  return caller.withClient(async (client) => {
    const { party, contacts } = await contactsOf(client, claim.partyId)
    const suggested = contacts[0] ?? null
    const language = supplierLanguageOf(suggested?.language ?? null, party.language)
    const mail = await mailOf(client, claim, language, suggested?.name ?? null, null)
    const lines = await readLines(client, claim.id)
    const problems: Issue[] = [
      ...sendProblems(factsOf(claim, lines)).map((message) => ({ path: 'claim', message })),
      ...(contacts.length === 0 ? [{ path: 'contactIds', message: `${party.legalName} has no active contact with an e-mail: add one to the supplier first, or send without a mail.` }] : []),
    ]
    return {
      ready: problems.length === 0,
      problems,
      recipients: contacts.map((contact) => ({ contactId: contact.id, name: contact.name, email: contact.email!, roles: contact.roles, language: contact.language, suggested: contact.id === suggested?.id })),
      language,
      subject: mail.subject,
      message: mail.body,
    }
  })
}

/**
 * The send inside the caller's command (the claim's row is held: its version bump, or it was made in this command):
 * DRAFT | REJECTED → SENT, the discrepancies reported, the mail queued on the claim's thread when asked.
 */
export async function sendInCommand(tools: CommandTools, context: OfficeContext, claimId: string, input: Omit<SendInput, 'version'>): Promise<{ outboundId: string | null; recipients: number }> {
  const { tx, now } = tools
  const claim = await claimInCommand(tx, claimId)
  const remedy = input.remedy ?? (claim.remedy as ClaimRemedy | null)
  const lines = await readLines(tx, claimId)
  const problems = sendProblems({ ...factsOf(claim, lines), remedy })
  if (problems.length > 0) throw new InvalidStateError(problems.join(' '))

  // The recipients: active contacts of the supplier with an e-mail.
  let to: string[] = []
  let language: DocumentLanguage = 'it'
  let recipientName: string | null = null
  if (input.mail) {
    const { party, contacts } = await contactsOf(tx, claim.partyId)
    const issues: Issue[] = []
    const chosen = [...new Set(input.mail.contactIds)].flatMap((contactId, index) => {
      const contact = isUuid(contactId) ? contacts.find((entry) => entry.id === contactId) : undefined
      if (!contact) issues.push({ path: `body/mail/contactIds/${index}`, message: `Not an active contact of ${party.legalName} with an e-mail.` })
      return contact ? [contact] : []
    })
    if (input.mail.contactIds.length === 0) issues.push({ path: 'body/mail/contactIds', message: 'Choose who gets the claim.' })
    if (chosen.length > CLAIM_LIMITS.recipients) issues.push({ path: 'body/mail/contactIds', message: `At most ${CLAIM_LIMITS.recipients} recipients.` })
    if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
    to = chosen.map((contact) => contact.email!)
    language = input.mail.language ?? supplierLanguageOf(chosen[0]!.language, party.language)
    recipientName = chosen.length === 1 ? chosen[0]!.name : null
  }

  const again = claim.status === 'REJECTED'
  await tx.supplierClaim.update({ where: { id: claimId }, data: { status: 'SENT', sentAt: now, sentById: actorIdOf(tools), remedy }, select: { id: true } })
  const reported = await followDiscrepancies(tools, claim, 'SENT')
  let outboundId: string | null = null
  if (input.mail) {
    const mail = await mailOf(tx, { ...claim, remedy }, language, recipientName, input.mail.message ?? null)
    const sent = await sendEmail(tools, {
      record: { type: CLAIM_RECORD, id: claimId },
      sender: await senderOf(tx, context),
      to,
      cc: [...(input.mail.cc ?? [])],
      subject: input.mail.subject?.trim() ? input.mail.subject.trim() : mail.subject,
      body: mail.body,
      locale: language,
    })
    outboundId = sent.outbound.id
  }
  const recipients = to.length + (input.mail?.cc?.length ?? 0)
  tools.audit({
    action: 'purchasing.claims.send',
    recordType: CLAIM_RECORD,
    recordId: claimId,
    companyId: claim.companyId,
    siteId: claim.siteId,
    before: { status: claim.status, remedy: claim.remedy },
    after: { status: 'SENT', remedy, again, outboundId, recipients, language: input.mail ? language : null, discrepanciesReported: reported },
  })
  tools.emit({ type: 'supplier_claim.sent', subject: claimId, companyId: claim.companyId, siteId: claim.siteId, payload: { supplierClaimId: claimId, number: claim.number, status: 'SENT', again, outboundId, recipients } })
  return { outboundId, recipients }
}

/** purchasing.claims.manage: the claim to the supplier (see the file's comment). A repeated Idempotency-Key sends no second mail. */
export async function sendClaim(caller: CommandCaller, claimId: string, input: SendInput, idempotencyKey?: string): Promise<{ claim: ClaimDetailView; emailId: string | null }> {
  const { context } = await officeClaim(caller, claimId, PURCHASING_CLAIMS_MANAGE)
  const { result } = await command(
    caller,
    { name: 'purchasing.claims.send', idempotencyKey, input: { claimId, ...input }, record: { type: 'SupplierClaim', id: claimId, expectedVersion: input.version } },
    async (tools) => {
      const sent = await sendInCommand(tools, context, claimId, input)
      return { claim: await detailInCommand(tools, claimId), emailId: sent.outboundId }
    },
  )
  return result
}
