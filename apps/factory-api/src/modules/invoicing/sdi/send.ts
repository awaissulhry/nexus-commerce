import { ConflictError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { INVOICES_ISSUE } from '@nexus/factory-domain/invoicing/permissions'
import { failureOf, failureReasonOf, maySend, sendFileName, sendProgressive } from '@nexus/factory-domain/invoicing/sdi/states'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { recordGeneratedFile } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { reviewIssue } from '../facts'
import { refusal } from '../issue'
import { makeInvoiceFiles } from '../invoice-files'
import { filesPending, officeInvoice, readInvoice, readLines, type InvoiceRow, type Reader } from '../store'
import { correctInCommand, resendProblems } from './correct'
import { prepareCorrectedFiles, readXml, type PreparedSendFiles } from './files'
import { recordPoll } from './poll'
import { recordSendResult } from './record'
import type { SdiRuntime, SendResult } from './runtime'
import { lockInvoice, readSends, sdiAccountOf } from './store'
import { sdiView, type SdiView } from './view'

/**
 * Sending an invoice to SDI (FIN-084; B-W1-50; A2 SCR-081 "Issue and send", "Fix and resend"): invoices.issue with a
 * fresh step-up, from ISSUED, REJECTED (corrected: same number and date, a new file) or ERROR (sent again). Like the
 * issue, in steps, the outside call never inside a transaction:
 *
 *   0. before anything is written: the state, the company's SDI account, no send on its way; after a send the provider
 *      did not answer (ERROR, NO_ANSWER) the provider is asked first: when it has that file, its answer is recorded and
 *      nothing is sent twice (409); a REJECTED invoice is brought up to date (the correction command with no change:
 *      seller and buyer data as they are now) and its corrected XML and PDF are made and put in the store; an issued
 *      invoice whose files are pending gets them (makeInvoiceFiles);
 *   1. the START command `invoices.sdiSend` on the invoice (its version bump locks the row; the request's
 *      Idempotency-Key makes a repeat answer from its receipt): the checks again; for a REJECTED invoice the issue's
 *      checks again and the corrected files named on it; the send row SENDING (attempt n, its own file name, the
 *      invoice's XML, the company's SDI account: the …_money_guards trigger checks the last two);
 *   2. ONE gateway call `sdi.send_invoice` with the send's id as the provider's idempotency key (retried by the gateway
 *      when it may pass later; never twice at the provider);
 *   3. the RESULT command: SENT with the provider's id, or FAILED with why (REFUSED, NOT_SENT, or NO_ANSWER: "it may have
 *      reached SDI"), and the invoice follows (SENT or ERROR; record.ts).
 * A process that stops between 1 and 3 leaves the send SENDING: the status poll settles it. SDI's answer comes later
 * (webhook or poll: record.ts applyMessages).
 */

/** Asks the provider about the last send when it did not answer; refuses (409) when the provider has that file. */
async function checkUnanswered(sdi: SdiRuntime, caller: CommandCaller, invoice: InvoiceRow): Promise<void> {
  if (invoice.status !== 'ERROR') return
  const latest = (await caller.withClient((client) => readSends(client, invoice.id))).at(-1)
  if (!latest || latest.status !== 'FAILED' || !failureOf(latest.failureReason)?.uncertain) return
  let answer
  try {
    answer = await sdi.status(caller, latest.integrationAccountId, { providerRef: latest.providerRef, fileName: latest.fileName, idempotencyKey: latest.id })
  } catch {
    throw new ConflictError('The last send got no answer and the SDI intermediary cannot be asked now; try again in a few minutes (sending again before it answers could make SDI reject the second file as a duplicate).')
  }
  if (!answer.known) return
  await command(caller, { name: 'invoices.sdiPollResult', input: { submissionId: latest.id } }, (tools) => recordPoll(tools, latest.id, answer, { staleSending: false }))
  throw new ConflictError('The SDI intermediary has the last file: it was not sent twice. SDI’s answer is recorded when it comes.')
}

/** The progressive of the next send whose file name is free in the tenant (SDI refuses a name it has seen: 00002). */
async function freeName(db: Reader, invoice: InvoiceRow, attempt: number, xmlName: string): Promise<{ progressive: string; fileName: string }> {
  for (let salt = 0; salt < 20; salt++) {
    const progressive = sendProgressive(invoice.id, attempt, salt)
    const fileName = sendFileName(xmlName, progressive)
    if (fileName === null) throw new ConflictError(`The invoice's XML is not named as SDI asks (${xmlName}); make its files again.`)
    if (!(await db.sdiSubmission.findFirst({ where: { fileName }, select: { id: true } }))) return { progressive, fileName }
  }
  throw new ConflictError('No free file name was found for this send; try again.')
}

async function xmlNameOf(db: Reader, xmlFileId: string | null): Promise<string> {
  const file = xmlFileId ? await db.storedFile.findUnique({ where: { id: xmlFileId }, select: { originalName: true } }) : null
  if (!file) throw new ConflictError('The invoice’s XML is not stored yet: make its files first.')
  return file.originalName
}

interface Started {
  readonly submissionId: string
  readonly attempt: number
  readonly fileName: string
  readonly xmlFileId: string
  readonly accountId: string
}

/** Step 1, inside the START command (the invoice's row is locked by its version bump). */
async function startInCommand(tools: CommandTools, invoiceId: string, expected: { readonly version?: number | undefined; readonly builtFrom?: number }, prepared: PreparedSendFiles | null): Promise<Started> {
  const { tx } = tools
  await lockInvoice(tx, invoiceId)
  const current = (await readInvoice(tx, invoiceId))!
  const previousVersion = tools.record!.previousVersion
  if (expected.version !== undefined && expected.version !== previousVersion && expected.builtFrom === undefined) {
    throw new ConflictError(`This Invoice changed since it was read (version ${expected.version}); it is now at version ${previousVersion}. Reload it and send again.`)
  }
  if (!maySend(current.status)) throw new InvalidStateError(`The invoice is ${current.status}: it is sent to SDI when ISSUED, REJECTED (corrected) or in ERROR.`)
  const sends = await readSends(tx, invoiceId)
  if (sends.at(-1)?.status === 'SENDING') throw new ConflictError('A send of this invoice to SDI is on its way already.')
  const account = await sdiAccountOf(tx, current.companyId)
  const attempt = (sends.at(-1)?.attempt ?? 0) + 1

  let fileName: string
  let xmlFileId: string
  if (current.status === 'REJECTED') {
    if (!prepared || expected.builtFrom === undefined) throw new ConflictError('The corrected file of this invoice is not made yet; send again.')
    if (expected.builtFrom !== previousVersion) throw new ConflictError('The invoice changed while its corrected file was made; send it again.')
    const problems = resendProblems((await reviewIssue(tx, current, await readLines(tx, invoiceId), current.issueDate!.toISOString().slice(0, 10), tools.now)).problems)
    if (problems.length > 0) throw refusal(problems)
    if (await tx.sdiSubmission.findFirst({ where: { fileName: prepared.fileName }, select: { id: true } })) throw new ConflictError('The new file name was taken meanwhile; send again.')
    const details = { documentType: current.docType, number: current.number, correctedFor: `attempt ${attempt}` }
    const xml = await recordGeneratedFile(tools, prepared.xml, { details: { ...details, file: 'FatturaPA XML (corrected)' } })
    const pdf = await recordGeneratedFile(tools, prepared.pdf, { details: { ...details, file: 'courtesy copy (corrected)' } })
    await tx.invoice.update({ where: { id: invoiceId }, data: { xmlFileId: xml.id, pdfFileId: pdf.id }, select: { id: true } })
    tools.audit({ action: 'invoices.sdiCorrectedFiles', recordType: 'Invoice', recordId: invoiceId, companyId: current.companyId, before: { xmlFileId: current.xmlFileId, pdfFileId: current.pdfFileId }, after: { xmlFileId: xml.id, pdfFileId: pdf.id, fileName: prepared.fileName } })
    fileName = prepared.fileName
    xmlFileId = xml.id
  } else {
    if (!current.xmlFileId) throw new ConflictError('The invoice’s XML is not stored yet: make its files first.')
    const xmlName = await xmlNameOf(tx, current.xmlFileId)
    fileName = attempt === 1 && !(await tx.sdiSubmission.findFirst({ where: { fileName: xmlName }, select: { id: true } })) ? xmlName : (await freeName(tx, current, attempt, xmlName)).fileName
    xmlFileId = current.xmlFileId
  }

  const submissionId = newId()
  await tx.sdiSubmission.create({
    data: {
      id: submissionId,
      partyId: current.buyerPartyId,
      invoiceId,
      attempt,
      integrationAccountId: account.id,
      fileName,
      xmlFileId,
      status: 'SENDING',
      createdById: tools.context.audience === 'office' ? tools.context.actorId : null,
    },
    select: { id: true },
  })
  tools.audit({ action: 'invoices.sdiSend', recordType: 'SdiSubmission', recordId: submissionId, companyId: current.companyId, after: { invoiceId, attempt, fileName, xmlFileId, from: current.status } })
  tools.emit({
    type: 'invoice.sdi_status_changed',
    subject: invoiceId,
    companyId: current.companyId,
    payload: { invoiceId, submissionId, attempt, sendStatus: 'SENDING', invoiceStatus: current.status, previousStatus: current.status },
  })
  return { submissionId, attempt, fileName, xmlFileId, accountId: account.id }
}

/** Whether this Idempotency-Key already started a send (a repeated request goes straight to the send it started). */
async function startedBefore(caller: CommandCaller, idempotencyKey: string | undefined): Promise<boolean> {
  if (!idempotencyKey) return false
  return (await caller.withClient((client) => client.idempotencyReceipt.findFirst({ where: { scope: 'invoices.sdiSend', key: idempotencyKey }, select: { key: true } }))) !== null
}

/** Steps 2 and 3 for a send that is SENDING: the XML, the provider, the result. A send that moved meanwhile is left as it is. */
async function deliver(files: FilesRuntime, sdi: SdiRuntime, caller: CommandCaller, started: Started, xmlText: string | null): Promise<void> {
  const send = await caller.withClient((client) => client.sdiSubmission.findUnique({ where: { id: started.submissionId }, select: { status: true } }))
  if (send?.status !== 'SENDING') return
  let xml = xmlText
  if (xml === null) {
    try {
      xml = await readXml(files, caller, started.xmlFileId)
    } catch {
      xml = null
    }
  }
  const result: SendResult = xml === null ? { ok: false, failureReason: failureReasonOf('NOT_SENT', 'the XML could not be read from the file store') } : await sdi.send(caller, started.accountId, { fileName: started.fileName, xml, idempotencyKey: started.submissionId })
  await command(caller, { name: 'invoices.sdiSendResult', input: { submissionId: started.submissionId } }, (tools) => recordSendResult(tools, started.submissionId, result))
}

/**
 * invoices.issue (step-up; POST /invoicing/invoices/:invoiceId/sdi/send): sends the invoice to SDI (see the module
 * comment). Answers the invoice's SDI status after the provider's answer.
 */
export async function sendToSdi(
  files: FilesRuntime,
  sdi: SdiRuntime,
  caller: CommandCaller,
  invoiceId: string,
  body: { version?: number | undefined },
  idempotencyKey: string | undefined,
  stepUp: () => void,
): Promise<{ sdi: SdiView }> {
  let invoice = await officeInvoice(caller, invoiceId, INVOICES_ISSUE)
  stepUp()
  let prepared: PreparedSendFiles | null = null
  let builtFrom: number | undefined
  if (!(await startedBefore(caller, idempotencyKey))) {
    if (!maySend(invoice.status)) {
      throw new InvalidStateError(
        invoice.status === 'DRAFT' ? 'The invoice is a draft: issue it first.' : invoice.status === 'SENT' ? 'The invoice is at SDI: its answer comes by itself.' : `The invoice is ${invoice.status}: SDI's answer is final.`,
      )
    }
    await caller.withClient((client) => sdiAccountOf(client, invoice.companyId))
    if ((await caller.withClient((client) => readSends(client, invoice.id))).at(-1)?.status === 'SENDING') throw new ConflictError('A send of this invoice to SDI is on its way already.')
    await checkUnanswered(sdi, caller, invoice)
    if (invoice.status === 'REJECTED') {
      // The invoice as it is now (seller and buyer data refreshed), then its corrected files for the next send's name.
      const { result } = await command(caller, { name: 'invoices.sdiCorrect', input: { invoiceId, refresh: true }, record: { type: 'Invoice', id: invoiceId, ...(body.version === undefined ? {} : { expectedVersion: body.version }) } }, async (tools) => {
        const { problems } = await correctInCommand(tools, invoiceId, {}, null)
        return { version: tools.record!.version, problems }
      })
      if (result.problems.length > 0) throw refusal(result.problems)
      invoice = (await caller.withClient((client) => readInvoice(client, invoiceId)))!
      const attempt = ((await caller.withClient((client) => readSends(client, invoiceId))).at(-1)?.attempt ?? 0) + 1
      const { progressive } = await caller.withClient(async (client) => freeName(client, invoice, attempt, await xmlNameOf(client, invoice.xmlFileId)))
      prepared = await prepareCorrectedFiles(files, caller, invoiceId, progressive)
      builtFrom = result.version
    } else if (filesPending(invoice)) {
      await makeInvoiceFiles(files, caller, invoiceId)
    }
  }
  const { result: started } = await command(
    caller,
    { name: 'invoices.sdiSend', idempotencyKey, input: { invoiceId, ...body }, record: { type: 'Invoice', id: invoiceId } },
    (tools) => startInCommand(tools, invoiceId, { version: body.version, ...(builtFrom === undefined ? {} : { builtFrom }) }, prepared),
  )
  await deliver(files, sdi, caller, started, prepared?.xmlText ?? null)
  return { sdi: await caller.withClient(async (client) => sdiView(client, (await readInvoice(client, invoiceId)) ?? missing())) }
}

function missing(): never {
  throw new NotFoundError('Invoice not found.')
}
