import { command, type CommandCaller } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { processSdi, type SdiRuntime } from './runtime'
import { lockInvoice, readArchive, readSends, writeArchive } from './store'

/**
 * Legal archiving (conservazione; FIN-092; DM 17.6.2014, c.c. art. 2220: ten years), rented from the SDI intermediary
 * (A1 §4; PLAN §2.8): once SDI handed the file to the customer's side (DELIVERED, or NOT_DELIVERABLE: issued, in the
 * tax drawer), the worker's handler `invoicing.sdiArchive` asks the provider to archive that send (one gateway call,
 * sdi.archive, idempotent) and records it in ONE command (store.ts writeArchive: the send's archivedAt and archiveRef,
 * set once; an audit row; the event invoice.sdi_archived). A
 * refused or failed call is retried by the queue. A rejected file is never archived: it counts as never issued. The
 * factory keeps its own copy too: the XML, the PDF and the receipts are FISCAL_ARCHIVE files (ten years).
 */

/** Archives the invoice's delivered (or not deliverable) send when it is not archived yet. */
export async function archiveInvoice(sdi: SdiRuntime, caller: CommandCaller, invoiceId: string, causationId?: string): Promise<'archived' | 'already' | 'nothing'> {
  const found = await caller.withClient(async (client) => {
    const invoice = await client.invoice.findUnique({ where: { id: invoiceId }, select: { id: true, companyId: true, status: true } })
    return invoice ? { invoice, archive: await readArchive(client, invoiceId), sends: await readSends(client, invoiceId) } : null
  })
  if (!found) return 'nothing'
  if (found.archive) return 'already'
  const send = found.sends.find((row) => row.status === 'DELIVERED') ?? found.sends.find((row) => row.status === 'NOT_DELIVERABLE')
  if (!send) return 'nothing'
  if (!send.providerRef) throw new Error(`Send ${send.id} has no provider id yet; it is archived once the poll names it.`)
  const receipt = await sdi.archive(caller, send.integrationAccountId, { providerRef: send.providerRef, fileName: send.fileName })
  const { result } = await command(caller, { name: 'invoices.sdiArchive', idempotencyKey: `sdi-archive.${send.id}`, input: { invoiceId, submissionId: send.id }, ...(causationId ? { causationId } : {}) }, async (tools) => {
    await lockInvoice(tools.tx, invoiceId)
    if (await readArchive(tools.tx, invoiceId)) return { archived: false }
    await writeArchive(tools, found.invoice, { submissionId: send.id, archiveRef: receipt.archiveRef, archivedAt: receipt.archivedAt })
    return { archived: true }
  })
  return result.archived ? 'archived' : 'already'
}

/** The worker's handler: on invoice.sdi_status_changed into DELIVERED or NOT_DELIVERABLE. Listed in background.ts HANDLERS. */
export function sdiArchiveHandler(runtime: () => SdiRuntime = processSdi): EventHandler {
  return defineHandler({
    name: 'invoicing.sdiArchive',
    events: ['invoice.sdi_status_changed'],
    attempts: 10,
    async handle(event, { caller }) {
      const payload = event.payload as { invoiceId: string; invoiceStatus: string; previousStatus: string }
      if (payload.invoiceStatus === payload.previousStatus || (payload.invoiceStatus !== 'DELIVERED' && payload.invoiceStatus !== 'NOT_DELIVERABLE')) return
      await archiveInvoice(runtime(), caller, payload.invoiceId, event.eventId)
    },
  })
}
