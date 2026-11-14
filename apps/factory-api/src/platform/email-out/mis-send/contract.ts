import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { MAX_RECIPIENTS } from '@nexus/factory-domain/email/rules'
import { MAX_ATTACHMENTS, MAX_BODY_LENGTH, RECORD_TYPE } from '@nexus/factory-domain/threads/rules'
import { MIS_SEND_WARNINGS, RECIPIENT_KINDS, RECIPIENT_SOURCES } from './rules'

/**
 * The mis-send guard's contract (B-W2b-397; COL-004; design shell.panels pop:mis-send). Office only: what a person is about
 * to send from a record's thread (the composer's "Message to <party>"), checked before it goes. Codes and the person's own
 * words back, never sentences: the screen says them. Nothing is written.
 */

export const misSendParams = input({ recordType: z.string().regex(RECORD_TYPE), recordId: id() })

export const misSendBody = input({
  to: z.array(z.string().max(254)).min(1).max(MAX_RECIPIENTS),
  subject: z.string().max(998).optional(),
  body: z.string().max(MAX_BODY_LENGTH),
  attachments: z.array(id()).max(MAX_ATTACHMENTS).default([]),
})
export type MisSendBody = z.infer<typeof misSendBody>

const organisation = output({ id: id(), name: z.string() })

export const misSendView = output({
  /** The record's party: the organisation the message is for (null: the record has none and no mail can go). */
  party: organisation.nullable(),
  /** Each address as typed (trimmed, lower case), whose it is and how we know. */
  recipients: z.array(
    output({
      address: z.string(),
      kind: z.enum(RECIPIENT_KINDS),
      source: z.enum(RECIPIENT_SOURCES).nullable(),
      organisation: organisation.nullable(),
      /** The contact's or portal person's name, when the address is theirs. */
      personName: z.string().nullable(),
    }),
  ),
  /** What the person should look at before sending; each with the words, names or addresses found (at most 10). */
  warnings: z.array(output({ code: z.enum(MIS_SEND_WARNINGS), items: z.array(z.string()) })),
  /** Each attachment and who sees it: shared with the party, or the office only. */
  attachments: z.array(output({ id: id(), name: z.string(), sizeBytes: z.number().int(), audience: z.enum(['PARTY', 'OFFICE']) })),
})
export type MisSendView = z.infer<typeof misSendView>

export const misSendContract = defineContract({
  params: misSendParams,
  body: misSendBody,
  response: { 200: misSendView },
})
