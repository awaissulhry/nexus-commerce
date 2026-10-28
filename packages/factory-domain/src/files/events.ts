import { z } from 'zod'
import { defineEvent } from '../events/define'

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
      kind: z.enum(['ATTACHMENT', 'DOCUMENT', 'PHOTO', 'CERTIFICATE', 'FISCAL_ARCHIVE']),
    }),
    live: { permission: 'files.read', fields: ['recordType', 'recordId'] },
  }),
] as const
