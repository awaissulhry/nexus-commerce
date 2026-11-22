import { z } from 'zod'
import { defineEvent, /* B-SA-002 */ livePartyId } from '../events/define'
import { notMoney } from '../money/marked' // B-CP-014: `priced` is a lock flag, not an amount

/**
 * The files platform's events (plan A1 §3.4, §3.6; feature COL-045). apps/factory-api's platform/files emits
 * `file.available` in the transaction that confirms an upload, so a record's file panel refreshes on every office
 * screen that may read the record's files (and later steps, the record timeline for one, can react to it).
 */
export const events = [
  defineEvent({
    type: 'file.available',
    context: 'files',
    description: 'An uploaded file was checked against what was announced and can now be opened.',
    payload: z.strictObject({
      fileId: z.uuid(),
      recordType: z.string(),
      recordId: z.uuid(),
      // B-W2b-96: AUDIO (a voice note of a machine request or job, QHS-189; FileKind since B-W2b-86).
      kind: z.enum(['ATTACHMENT', 'DOCUMENT', 'PHOTO', 'CERTIFICATE', 'FISCAL_ARCHIVE', 'AUDIO']),
      // B-SA-002 (Sales page plan P17'): the customer of the file's record as the office's file reads judge it
      // (platform/files/record-scope.ts fileLivePartyId), so an office person limited to some customers is sent the live message
      // of their customers' files; none (null) for several customers, none or a record not found: every-customer viewers only.
      // Never in the live fields; optional, so an older event still parses.
      partyId: livePartyId(),
    }),
    live: { permission: 'files.read', fields: ['recordType', 'recordId'] },
  }),
  // B-W2b-177 (COL-049): the scheduler's reminder that a document of a record stops being valid soon (30, then 7 days
  // before): the record's owner is told (platform/files/expiry/notices.ts), the record's Files panel shows it at once.
  defineEvent({
    type: 'file.expiry_due',
    context: 'files',
    description: 'A document of a record stops being valid soon: 30 days, then 7 days before its expiry date.',
    payload: z.strictObject({
      fileId: z.uuid(),
      recordType: z.string(),
      recordId: z.uuid(),
      expiresOn: z.iso.date(),
      daysLeft: z.number().int().min(0),
      window: z.union([z.literal(30), z.literal(7)]),
      /** The partner asked for a new version (its open request), or null when the file is not a partner's. */
      partnerTaskId: z.uuid().nullable(),
    }),
    live: { permission: 'files.read', fields: ['recordType', 'recordId'] },
  }),
  // B-W2b-177 (COL-055): a picture or a PDF page was marked up (a picture: its marked version follows as file.available).
  defineEvent({
    type: 'file.marked_up',
    context: 'files',
    description: 'Someone drew arrows or circles on a picture or a PDF page of a record.',
    payload: z.strictObject({
      markupId: z.uuid(),
      fileId: z.uuid(),
      recordType: z.string(),
      recordId: z.uuid(),
      page: z.number().int().min(1).nullable(),
      resultFileId: z.uuid().nullable(),
    }),
    live: { permission: 'files.read', fields: ['recordType', 'recordId'] },
  }),
  // ---- B-CP-014 (customer page plan, the money wall D6): a file was marked as showing prices, or the mark was taken off (POST
  // /files/:fileId/priced). The mark reaches every version of its series (and, when marked, the copies made of them): `fileIds`.
  // The record's file panel refreshes (a name becomes the lock, or the lock the name); search reads the messages that carry these
  // files again (a priced file's name is never in search). No amount, no name of the file.
  defineEvent({
    type: 'file.priced_changed',
    context: 'files',
    description: 'A file was marked as showing prices (only people who see prices open it), or the mark was taken off.',
    payload: z.strictObject({
      fileId: z.uuid(),
      recordType: z.string(),
      recordId: z.uuid(),
      priced: notMoney(z.boolean()),
      fileIds: z.array(z.uuid()).max(500),
      // The customer of the file's record (platform/files/record-scope.ts fileLivePartyId), as file.available carries it.
      partyId: livePartyId(),
    }),
    live: { permission: 'files.read', fields: ['recordType', 'recordId'] },
  }),
  // ---- end B-CP-014
  // ---- B-OF-032 (order files tab; 13-backend §2): an ask for a file on a sales order (FileAsk, modules/sales/file-asks) was made,
  // files arrived for it, it was decided (accepted, or asked again) or changed (its words, due day, addressee, a chase, a cancel).
  // The order's Files tab and its thread's Files window re-read their asks. Ids and states only: no words, no file name, no person,
  // never a worker; the order's customer as the office's live wall judges it (the order's own partyId). No floor or partner entry.
  defineEvent({
    type: 'file_ask.asked',
    context: 'files',
    description: 'Someone in the office asked a person, a role, a team or whoever works a step for a file on a sales order.',
    payload: z.strictObject({ askId: z.uuid(), salesOrderId: z.uuid(), workOrderId: z.uuid().nullable(), status: z.enum(['OPEN', 'ARRIVED', 'ACCEPTED', 'CANCELLED']), partyId: livePartyId() }),
    live: { permission: 'orders.view', fields: ['salesOrderId'] },
  }),
  defineEvent({
    type: 'file_ask.arrived',
    context: 'files',
    description: 'Files were sent for an ask for a file: the asker checks them.',
    payload: z.strictObject({ askId: z.uuid(), salesOrderId: z.uuid(), workOrderId: z.uuid().nullable(), status: z.enum(['OPEN', 'ARRIVED', 'ACCEPTED', 'CANCELLED']), partyId: livePartyId() }),
    live: { permission: 'orders.view', fields: ['salesOrderId'] },
  }),
  defineEvent({
    type: 'file_ask.decided',
    context: 'files',
    description: 'The files sent for an ask for a file were accepted, or the file was asked for again with a reason.',
    payload: z.strictObject({ askId: z.uuid(), salesOrderId: z.uuid(), workOrderId: z.uuid().nullable(), status: z.enum(['OPEN', 'ARRIVED', 'ACCEPTED', 'CANCELLED']), decision: z.enum(['ACCEPTED', 'ASKED_AGAIN']), partyId: livePartyId() }),
    live: { permission: 'orders.view', fields: ['salesOrderId'] },
  }),
  defineEvent({
    type: 'file_ask.changed',
    context: 'files',
    description: 'An ask for a file changed: its words, its due day, who is asked, an ask for an update, or it was cancelled.',
    payload: z.strictObject({ askId: z.uuid(), salesOrderId: z.uuid(), workOrderId: z.uuid().nullable(), status: z.enum(['OPEN', 'ARRIVED', 'ACCEPTED', 'CANCELLED']), change: z.enum(['WORDS', 'DUE', 'ADDRESSEE', 'CHASED', 'CANCELLED']), partyId: livePartyId() }),
    live: { permission: 'orders.view', fields: ['salesOrderId'] },
  }),
  // ---- end B-OF-032
] as const
