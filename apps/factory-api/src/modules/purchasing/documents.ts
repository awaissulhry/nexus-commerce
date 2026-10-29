import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../core/command'
import { serverClock } from '../../core/time'
import { confirmLinksOf } from './confirm-links'
import { officeOrder } from './store'

/**
 * A purchase order's documents and sends (B-W1-30; A2 SCR-059 "Documents" and "Confirmations & changes › Sends"): the PDFs
 * the supplier got (one per send of a revision; downloaded through /files/:id/download), the confirm links made for it
 * (their state: live, used, expired, revoked; never a token) and the mails on its thread (send, new links, the
 * cancellation) with their delivery state. purchasing.view; nothing here carries a price.
 */
export async function listDocuments(caller: CommandCaller, orderId: string) {
  const order = await officeOrder(caller, orderId)
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const files = await client.storedFile.findMany({
      where: { recordType: 'PurchaseOrder', recordId: order.id, kind: 'FISCAL_ARCHIVE' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, originalName: true, sha256: true, sizeBytes: true, status: true, createdAt: true },
    })
    const mails = await client.emailOutbound.findMany({
      where: { recordType: 'PurchaseOrder', recordId: order.id },
      orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, to: true, cc: true, subject: true, status: true, queuedAt: true, sentAt: true, deliveredAt: true, failedAt: true, lastError: true },
    })
    return {
      revision: order.revision,
      status: order.status,
      sentAt: order.sentAt === null ? null : toUtcIso(order.sentAt),
      documents: files.map((file) => ({ fileId: file.id, name: file.originalName, sha256: file.sha256, sizeBytes: file.sizeBytes, status: file.status, createdAt: toUtcIso(file.createdAt) })),
      links: await confirmLinksOf(client, order.id, now),
      mails: mails.map((mail) => ({
        id: mail.id,
        to: mail.to,
        cc: mail.cc,
        subject: mail.subject,
        status: mail.status,
        queuedAt: toUtcIso(mail.queuedAt),
        sentAt: mail.sentAt === null ? null : toUtcIso(mail.sentAt),
        deliveredAt: mail.deliveredAt === null ? null : toUtcIso(mail.deliveredAt),
        failedAt: mail.failedAt === null ? null : toUtcIso(mail.failedAt),
        lastError: mail.lastError,
      })),
    }
  })
}
