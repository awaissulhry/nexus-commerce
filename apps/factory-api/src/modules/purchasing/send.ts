import type { FastifyRequest } from 'fastify'
import { DomainError, InvalidStateError, type Issue } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { composeDocument } from '@nexus/factory-domain/documents/compose'
import { legalProblems } from '@nexus/factory-domain/documents/legal'
import type { DocumentParty } from '@nexus/factory-domain/documents/model'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { identityAt } from '@nexus/factory-domain/parties/tax'
import { purchaseOrderDocument, purchaseOrderDocumentNumber, purchaseOrderMail, type SupplierOrder } from '@nexus/factory-domain/purchasing/document'
import { newLinkProblem, supplierLanguageOf, type PurchaseOrderStatus, type SendCheck } from '@nexus/factory-domain/purchasing/orders'
import { PURCHASING_SEND } from '@nexus/factory-domain/purchasing/permissions'
import { command, type CommandCaller } from '../../core/command'
import { serverClock } from '../../core/time'
import { companyLegalOf, documentFileName } from '../../platform/documents/documents'
import { renderDocumentPdf } from '../../platform/documents/pdf'
import { processEmail } from '../../platform/email-out/service'
import { putGeneratedFile, recordGeneratedFile, systemCallerOf, type PreparedGeneratedFile } from '../../platform/files/files'
import { processFiles } from '../../platform/files/service'
import { officeAuthOf } from '../../platform/auth/sessions/office-auth'
import { TAX_COLUMNS, taxFieldsOf } from '../parties/store'
import { confirmLinkTerms, insertConfirmLink, mintConfirmLink, revokeConfirmLinks, type ConfirmLinkTerms, type MintedLink } from './confirm-links'
import { deliverLinkMail, queueLinkMail } from './mail'
import { detailInCommand, refreshTotal } from './orders'
import { dayOf, decimal, officeContextOf, officeOrder, quantityText, readOrder, senderOf, type Reader } from './store'
import { checksOf, letterheadProblems, readFacts, siteAddressOf, type OrderFacts } from './views'

/**
 * Sending a purchase order (B-W1-30; SCM-054, SCM-055; A1 §2.5; PLAN §4.7 stage 08-buy; the design's Send dialog, SCR-037):
 * ONE flow, purchasing.send over the order's company, site and supplier, the quote's send pattern (B-W1-24):
 *
 *   1. the checks (factory-domain purchasing/orders sendChecks: supplier ACTIVE, its orders contact with an e-mail, the
 *      letterhead, the delivery address, lines priced and needed today or later); warnings never stop;
 *   2. outside any transaction: the frozen document (the supplier's legal name, address and VAT number, the delivery site,
 *      every line with its leather specs and prices, the net total), the PURCHASE_ORDER layout with the company's
 *      letterhead, the PDF (same input, same bytes) put in the file store (FISCAL_ARCHIVE: business correspondence is kept
 *      ten years, c.c. art. 2220), shared with the supplier's party (it is the mail's attachment) but NOT with link
 *      sessions (the confirm link shows no price); and the confirm link's token minted (only its hash goes further);
 *   3. ONE command on the PurchaseOrder (its version = the edit-conflict guard; a cancel that committed meanwhile makes it
 *      a 409): the supplier's details checked unchanged since the document was made; the PDF's StoredFile row; the order
 *      SENT with sentAt, sentById, the day as its order date and the total of its lines (the …_supply_guards trigger checks
 *      it and freezes the order from now on); the PO_CONFIRM link; the mail on the order's thread with the PDF, without
 *      the link (purchasing/mail.ts); purchase_order.sent;
 *   4. after the commit, the mail leaves with the link (in this process: the link exists only in memory).
 *
 * Idempotent: a repeated Idempotency-Key answers the first send from its receipt (nothing is made again, no second mail);
 * a send of an order that changed since it was read is a 409 naming the current version. The token is in no answer, row,
 * audit entry or event: only the mail holds it.
 */

/** The supplier as the order prints it: legal name, registered (else invoice, else any) address, VAT number today. */
async function supplierParty(db: Reader, facts: OrderFacts, today: string): Promise<DocumentParty> {
  const addresses = await db.partyAddress.findMany({
    where: { partyId: facts.party.id, status: 'ACTIVE' },
    select: { kinds: true, isDefaultBillTo: true, line1: true, line2: true, postalCode: true, city: true, province: true, country: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const address = addresses.find((row) => row.kinds.includes('REGISTERED')) ?? addresses.find((row) => row.isDefaultBillTo) ?? addresses[0] ?? null
  const identities = await db.partyTaxIdentity.findMany({ where: { partyId: facts.party.id }, select: TAX_COLUMNS })
  const identity = identityAt(identities.map(taxFieldsOf), today)
  return {
    name: facts.party.legalName,
    address: address ? { line1: address.line1, line2: address.line2, postalCode: address.postalCode, city: address.city, province: address.province, country: address.country } : null,
    vatNumber: identity?.vatNumber ?? null,
    fiscalCode: identity?.vatNumber ? null : (identity?.fiscalCode ?? null),
    email: facts.contact?.email ?? null,
  }
}

/** The frozen order the PDF is painted from (prices included: the mailed commercial document). */
function supplierOrderOf(facts: OrderFacts, supplier: DocumentParty, today: string): SupplierOrder {
  const { order } = facts
  return {
    number: order.number,
    revision: order.revision,
    language: supplierLanguageOf(facts.contact?.language, facts.party.language),
    date: today,
    currency: order.currency,
    supplier,
    deliverTo: siteAddressOf(facts.site),
    requestedDate: dayOf(order.requestedDate),
    incoterms: order.incoterms,
    paymentTerms: order.paymentTerms,
    note: order.note,
    netAmount: facts.lines.reduce((sum, line) => sum + line.netAmount, 0),
    lines: facts.lines.map((line) => {
      const item = facts.items.get(line.itemId)!
      const colour = line.itemColourId ? facts.colours.get(line.itemColourId) : undefined
      return {
        seq: line.seq,
        code: line.supplierArticleCode ?? item.code,
        name: item.name,
        colour: colour ? { name: colour.name, supplierCode: line.supplierColourCode } : null,
        description: line.description,
        quantity: quantityText(line.quantity),
        uom: line.uom,
        unitPrice: line.unitPrice.toFixed(6),
        netAmount: line.netAmount,
        needDate: dayOf(line.needDate)!,
        leather:
          item.kind === 'LEATHER'
            ? {
                grade: line.grade,
                thicknessMinMm: decimal(line.thicknessMinMm),
                thicknessMaxMm: decimal(line.thicknessMaxMm),
                oneDyeBatch: line.oneDyeBatch,
                areaTolerancePct: decimal(line.areaTolerancePct),
                estimatedHides: line.estimatedHides,
                baseQuantity: quantityText(line.baseQuantity),
                baseUom: item.baseUom,
              }
            : null,
        requiresCrViTest: line.requiresCrViTest,
        note: line.note,
      }
    }),
  }
}

const latestNeedOf = (facts: OrderFacts): string | null => facts.lines.map((line) => dayOf(line.needDate)!).sort().at(-1) ?? null

const refusal = (checks: readonly SendCheck[]): DomainError => {
  const blocking = checks.filter((check) => check.severity === 'BLOCKS')
  return new DomainError('conflict', `The order cannot be sent yet. ${blocking.map((check) => check.message).join(' ')}`, blocking.map((check): Issue => ({ path: check.path, message: check.message })))
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// ---- the checks (the Send dialog) -----------------------------------------------------------------------------------

/** purchasing.view: what the send would check now, to whom it goes, and the mail it would write (no link: it does not exist yet). */
export async function sendCheck(caller: CommandCaller, orderId: string) {
  const order = await officeOrder(caller, orderId)
  const now = serverClock.now()
  const today = businessDate(now)
  const companyLegal = legalProblems(await companyLegalOf(caller, order.companyId))
  return caller.withClient(async (client) => {
    const facts = await readFacts(client, order)
    const checks = checksOf(facts, today, companyLegal)
    const language = supplierLanguageOf(facts.contact?.language, facts.party.language)
    const terms = confirmLinkTerms(today, latestNeedOf(facts), now)
    const number = purchaseOrderDocumentNumber(order.number, order.revision)
    const mail = purchaseOrderMail({ language, number, recipientName: facts.contact?.name ?? null, linkUntil: businessDate(terms.expiresAt), message: null, resend: false })
    return {
      ready: checks.ready,
      checks: checks.checks,
      recipient: facts.contact ? { contactId: facts.contact.id, name: facts.contact.name, email: facts.contact.email } : null,
      documentNumber: number,
      language,
      linkExpiresAt: toUtcIso(terms.expiresAt),
      subject: mail.subject,
      message: mail.stored,
    }
  })
}

// ---- send -----------------------------------------------------------------------------------------------------------

export interface SendBody {
  readonly version: number
  readonly cc?: readonly string[] | undefined
  readonly subject?: string | null | undefined
  /** The office's own words above the link paragraph; none: the standard text. */
  readonly message?: string | null | undefined
}

interface SendPlan {
  readonly supplier: DocumentParty
  readonly to: string
  readonly file: PreparedGeneratedFile
  readonly pdf: Buffer
  readonly fileName: string
  readonly layout: string
  readonly language: 'it' | 'en'
  readonly documentNumber: string
  readonly link: MintedLink
  readonly terms: ConfirmLinkTerms
  readonly mail: ReturnType<typeof purchaseOrderMail>
}

/** purchasing.send: the PDF, the confirm link and the mail (see the module comment). */
export async function sendOrder(request: FastifyRequest, orderId: string, body: SendBody, idempotencyKey?: string) {
  const caller: CommandCaller = request
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, PURCHASING_SEND)
  const now = serverClock.now()
  const today = businessDate(now)

  // Steps 1 and 2, only for the version the caller read (a repeat or a stale send goes straight to the command: its
  // receipt answers, or the version guard refuses).
  let plan: SendPlan | null = null
  let refused: DomainError | null = null
  if (order.version === body.version) {
    const companyLegal = legalProblems(await companyLegalOf(caller, order.companyId))
    const read = await caller.withClient(async (client) => {
      const facts = await readFacts(client, order)
      return { facts, supplier: await supplierParty(client, facts, today) }
    })
    const { facts, supplier } = read
    const checks = checksOf(facts, today, companyLegal)
    if (!checks.ready || !facts.contact?.email) refused = refusal(checks.checks)
    else {
      const frozen = supplierOrderOf(facts, supplier, today)
      const composed = composeDocument({ ...purchaseOrderDocument(frozen), company: await companyLegalOf(caller, order.companyId), sample: false })
      const pdf = await renderDocumentPdf(composed)
      const fileName = documentFileName(composed)
      const file = await putGeneratedFile(processFiles(), caller, {
        companyId: order.companyId,
        recordType: 'PurchaseOrder',
        recordId: order.id,
        kind: 'FISCAL_ARCHIVE',
        originalName: fileName,
        contentType: 'application/pdf',
        body: pdf,
        // The mail's attachment is shared with the supplier's party; never with a link session (no price on the link).
        visibility: ['OFFICE', 'PARTNER'],
        partyId: order.partyId,
      })
      const terms = confirmLinkTerms(today, latestNeedOf(facts), now)
      const documentNumber = purchaseOrderDocumentNumber(order.number, order.revision)
      const mail = purchaseOrderMail({ language: frozen.language, number: documentNumber, recipientName: facts.contact.name, linkUntil: businessDate(terms.expiresAt), message: body.message ?? null, resend: false })
      plan = { supplier, to: facts.contact.email, file, pdf, fileName, layout: composed.layout, language: frozen.language, documentNumber, link: mintConfirmLink(context.tenantId, order.partyId), terms, mail }
    }
  }

  const { result, replayed } = await command(
    caller,
    { name: 'purchasing.send', idempotencyKey, input: { orderId, ...body }, record: { type: 'PurchaseOrder', id: order.id, expectedVersion: body.version } },
    async (tools) => {
      if (!plan) throw refused ?? new InvalidStateError('The order cannot be sent as it is: reload it.')
      const { tx } = tools
      const current = (await readOrder(tx, order.id))!
      // The supplier's data as the document printed it (the parties module writes it outside the order's commands).
      const facts = await readFacts(tx, current)
      const again = checksOf(facts, businessDate(tools.now), await letterheadProblems(tx, tools.context, current.companyId))
      if (!again.ready) throw refusal(again.checks)
      if (facts.contact?.email !== plan.to || !sameJson(await supplierParty(tx, facts, businessDate(tools.now)), plan.supplier)) {
        throw new DomainError('conflict', "The supplier's details changed while the order was being sent: send it again.", [{ path: 'partyId', message: 'Changed since the document was made.' }])
      }
      const file = await recordGeneratedFile(tools, plan.file, { details: { documentType: 'PURCHASE_ORDER', number: plan.documentNumber, layout: plan.layout, language: plan.language } })
      const netAmount = await refreshTotal(tools, current.id)
      await tx.purchaseOrder.update({ where: { id: current.id }, data: { status: 'SENT', sentAt: tools.now, sentById: context.actorId, orderDate: new Date(`${businessDate(tools.now)}T00:00:00.000Z`) }, select: { id: true } })
      const revoked = await revokeConfirmLinks(tools, current, context.actorId)
      const link = await insertConfirmLink(tools, plan.link, current, { email: plan.to, terms: plan.terms, actorId: context.actorId })
      const mail = await queueLinkMail(tools, {
        orderId: current.id,
        sender: await senderOf(tx, context),
        to: plan.to,
        cc: body.cc ?? [],
        subject: body.subject?.trim() ? body.subject.trim() : plan.mail.subject,
        storedText: plan.mail.stored,
        attachments: [file.id],
        locale: plan.language,
      })
      tools.audit({
        action: 'purchasing.send',
        recordType: 'PurchaseOrder',
        recordId: current.id,
        companyId: current.companyId,
        siteId: current.siteId,
        before: { status: current.status as PurchaseOrderStatus },
        after: { status: 'SENT', revision: current.revision, lines: facts.lines.length, documentFileId: file.id, documentSha256: plan.file.sha256, linkId: link.linkId, linkExpiresAt: toUtcIso(link.expiresAt), revokedLinkIds: revoked, outboundId: mail.outbound.id, to: plan.to, netAmount: markMoney('cost', netAmount) },
      })
      tools.emit({
        type: 'purchase_order.sent',
        subject: current.id,
        companyId: current.companyId,
        siteId: current.siteId,
        payload: { purchaseOrderId: current.id, number: current.number, revision: current.revision, partyId: current.partyId, documentFileId: file.id, linkId: link.linkId, outboundId: mail.outbound.id },
      })
      return {
        ...(await detailInCommand(tools, current.id)),
        sent: {
          revision: current.revision,
          sentAt: toUtcIso(tools.now),
          documentFileId: file.id,
          documentSha256: plan.file.sha256,
          to: plan.to,
          link: { id: link.linkId, expiresAt: toUtcIso(link.expiresAt) },
          emailId: mail.outbound.id,
        },
      }
    },
  )
  // Step 4: the mail leaves with the link, once (a replay sends nothing again).
  const delivery = replayed || !plan ? null : await deliverLinkMail(processEmail(), systemCallerOf(request)(context.tenantId), result.sent.emailId, { text: plan.mail.withLink(officeAuthOf(request.server).link('/l', plan.link.token)), attachment: { filename: plan.fileName, content: plan.pdf } })
  return { ...result, delivery }
}

// ---- a new link -----------------------------------------------------------------------------------------------------

export interface NewLinkBody {
  readonly version: number
  readonly cc?: readonly string[] | undefined
  readonly message?: string | null | undefined
}

/**
 * purchasing.send: a new confirm link for a sent order (the supplier lost it, a mail scanner used it, it ran out): the
 * live ones stop working, the new one is mailed with the PDF the supplier got, as the send does. Only while the order
 * waits for the supplier (SENT).
 */
export async function sendNewLink(request: FastifyRequest, orderId: string, body: NewLinkBody, idempotencyKey?: string) {
  const caller: CommandCaller = request
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, PURCHASING_SEND)
  const now = serverClock.now()
  const today = businessDate(now)

  let refused: DomainError | null = null
  let plan: { link: MintedLink; terms: ConfirmLinkTerms; mail: ReturnType<typeof purchaseOrderMail>; pdf: Buffer; to: string; fileId: string; fileName: string; language: 'it' | 'en' } | null = null
  if (order.version === body.version) {
    const problem = newLinkProblem(order.status as PurchaseOrderStatus)
    if (problem) refused = new InvalidStateError(problem)
    else {
      const read = await caller.withClient(async (client) => {
        const facts = await readFacts(client, order)
        // The PDF the supplier got: the order's newest stored print of its document.
        const file = await client.storedFile.findFirst({ where: { recordType: 'PurchaseOrder', recordId: order.id, kind: 'FISCAL_ARCHIVE', status: 'AVAILABLE' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, originalName: true, sizeBytes: true, storeAccountId: true, storageKey: true } })
        return { facts, file }
      })
      const { facts, file } = read
      const contact = facts.contact
      if (!contact?.email || contact.status !== 'ACTIVE') refused = new DomainError('conflict', 'Choose an active contact with an e-mail: the link goes to them.', [{ path: 'contactId', message: 'No e-mail.' }])
      else if (!file) refused = new InvalidStateError("The order's PDF is not available: it cannot be sent again.")
      else {
        const pdf = await processEmail().files().read(caller, file.storeAccountId, file.storageKey, file.sizeBytes)
        if (!pdf) throw new InvalidStateError("The order's PDF is missing from the file store.")
        const language = supplierLanguageOf(contact.language, facts.party.language)
        const terms = confirmLinkTerms(today, latestNeedOf(facts), now)
        const mail = purchaseOrderMail({ language, number: purchaseOrderDocumentNumber(order.number, order.revision), recipientName: contact.name, linkUntil: businessDate(terms.expiresAt), message: body.message ?? null, resend: true })
        plan = { link: mintConfirmLink(context.tenantId, order.partyId), terms, mail, pdf, to: contact.email, fileId: file.id, fileName: file.originalName, language }
      }
    }
  }

  const { result, replayed } = await command(
    caller,
    { name: 'purchasing.sendLink', idempotencyKey, input: { orderId, ...body }, record: { type: 'PurchaseOrder', id: order.id, expectedVersion: body.version } },
    async (tools) => {
      if (!plan) throw refused ?? new InvalidStateError('The order changed: reload it.')
      const current = (await readOrder(tools.tx, order.id))!
      const problem = newLinkProblem(current.status as PurchaseOrderStatus)
      if (problem) throw new InvalidStateError(problem)
      const revoked = await revokeConfirmLinks(tools, current, context.actorId)
      const link = await insertConfirmLink(tools, plan.link, current, { email: plan.to, terms: plan.terms, actorId: context.actorId })
      const mail = await queueLinkMail(tools, { orderId: current.id, sender: await senderOf(tools.tx, context), to: plan.to, cc: body.cc ?? [], subject: plan.mail.subject, storedText: plan.mail.stored, attachments: [plan.fileId], locale: plan.language })
      tools.audit({ action: 'purchasing.sendLink', recordType: 'PurchaseOrder', recordId: current.id, companyId: current.companyId, siteId: current.siteId, after: { linkId: link.linkId, linkExpiresAt: toUtcIso(link.expiresAt), revokedLinkIds: revoked, outboundId: mail.outbound.id, to: plan.to } })
      tools.emit({ type: 'purchase_order.link_sent', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { purchaseOrderId: current.id, number: current.number, linkId: link.linkId, revokedLinkIds: revoked, outboundId: mail.outbound.id } })
      return { ...(await detailInCommand(tools, current.id)), link: { id: link.linkId, expiresAt: toUtcIso(link.expiresAt), to: plan.to, revokedLinkIds: revoked, emailId: mail.outbound.id } }
    },
  )
  const delivery = replayed || !plan ? null : await deliverLinkMail(processEmail(), systemCallerOf(request)(context.tenantId), result.link.emailId, { text: plan.mail.withLink(officeAuthOf(request.server).link('/l', plan.link.token)), attachment: { filename: plan.fileName, content: plan.pdf } })
  return { ...result, delivery }
}
