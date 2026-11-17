import { events as threadEvents } from '@nexus/factory-domain/threads/events'
import { statusAfterResume, type InquiryStatus } from '@nexus/factory-domain/sales/inquiries/rules'
import { command } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { readInquiryRow } from './store'
import { writeInquiry } from './inquiries'

/**
 * The customer's answer takes the request up again by itself (B-TH-013; threads plan G4, PR-21; design O-SAL-INQ-LIST
 * pane-actions-F05 "when the brand answers, the request goes back to In progress by itself"): a message INTO an inquiry's thread
 * (INBOUND: a portal post or a mail reply of its customer) while the inquiry waits for the customer (NEED_INFO) moves it back to
 * ASSIGNED when someone keeps it, else NEW — the office's word "In progress" — in ONE command in the tenant's system scope: the
 * version moves, an audit row (no person: the system), inquiry.changed RESUMED (the office's live Incoming, and the portal
 * reads "Being reviewed"). Any other message (an internal note, our own reply), any other state or record: nothing.
 *
 * A message is always on its own record's thread, and a thread names one party (platform/threads): a reply on customer B's
 * thread never reaches customer A's request (W08).
 */

export const RESUME_ON_REPLY_HANDLER = 'sales.inquiryResumeOnReply'

const posted = threadEvents.find((event) => event.type === 'thread.message_posted')!

export function resumeOnReplyHandler(): EventHandler {
  return defineHandler({
    name: RESUME_ON_REPLY_HANDLER,
    events: ['thread.message_posted'],
    async handle(event, tools) {
      const payload = posted.payload.parse(event.payload) as { recordType: string; recordId: string; direction: string; messageId: string }
      if (payload.recordType !== 'Inquiry' || payload.direction !== 'INBOUND') return
      // Most answers come while the request does not wait (it moved on, or was never asked): nothing to write.
      const seen = await tools.caller.withClient((db) => readInquiryRow(db, payload.recordId))
      if (!seen || seen.status !== 'NEED_INFO') return
      await command(tools.caller, { name: 'sales.inquiries.resumeOnReply', input: { inquiryId: payload.recordId, messageId: payload.messageId } }, async (commandTools) => {
        await commandTools.tx.$queryRaw`SELECT id FROM "Inquiry" WHERE id = ${payload.recordId}::uuid FOR UPDATE`
        const row = await readInquiryRow(commandTools.tx, payload.recordId)
        if (!row || row.status !== 'NEED_INFO') {
          // Taken up by a person meanwhile: the command says so (every command writes its audit row).
          commandTools.audit({ action: 'sales.inquiries.resumeOnReply', recordType: 'Inquiry', recordId: payload.recordId, companyId: row?.companyId ?? null, after: { resumed: false, status: row?.status ?? null, messageId: payload.messageId } })
          return { resumed: false }
        }
        const status: InquiryStatus = statusAfterResume(row.assigneeId)
        await writeInquiry(commandTools, row, { status })
        commandTools.audit({ action: 'sales.inquiries.resumeOnReply', recordType: 'Inquiry', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status, messageId: payload.messageId } })
        commandTools.emit({ type: 'inquiry.changed', subject: row.id, companyId: row.companyId, payload: { inquiryId: row.id, number: row.number, status, previousStatus: row.status, change: 'RESUMED', partyId: row.partyId, assigneeId: row.assigneeId } })
        return { resumed: true }
      })
    },
  })
}
