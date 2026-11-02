import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { FLOOR_NOTE_LIMITS, FLOOR_NOTE_TILE_CODES } from '@nexus/factory-domain/production/floornotes/rules'
import { CLIENT_SCAN_ID } from '@nexus/factory-domain/production/scans/rules'
import { fileView, presignedView } from '../../../platform/files/contract'

/**
 * A comment or a photo from the floor (B-W2b-47; MES-101, COL-017). A file is announced for the work order, PUT to the
 * presigned URL and confirmed, then named by the note; the note goes to the work order's thread. No field carries money.
 */

const reminder = output({ code: z.string(), it: z.string(), en: z.string() })
const workOrderParams = input({ workOrderId: id() })

export const tilesContract = defineContract({
  response: {
    200: output({
      tiles: z.array(output({ code: z.enum(FLOOR_NOTE_TILE_CODES), label: output({ it: z.string(), en: z.string() }), needsDetail: z.boolean() })),
      /** What the photo step shows with its outline guide. */
      reminder,
      limits: output({ noteMax: z.number().int(), filesPerNote: z.number().int(), clipSeconds: z.number().int() }),
    }),
  },
})

export const announceBody = input({
  originalName: z.string().min(1).max(500),
  /** A picture (the PHOTO kind's types) or a clip (MP4, WebM, QuickTime). */
  contentType: z.string().min(1).max(200),
  sizeBytes: z.number().int().min(1),
  sha256: z.string(),
  /** A clip: its length, by the tablet. */
  durationSeconds: z.number().min(0).max(600).optional(),
})

export const announceContract = defineContract({ params: workOrderParams, body: announceBody, response: { 201: output({ file: fileView, upload: presignedView, reminder }) } })

export const completeContract = defineContract({ params: input({ workOrderId: id(), fileId: id() }), response: { 200: output({ file: fileView }) } })

export const noteBody = input({
  /** The tablet's id for the note (A1 §3.8): one note, once, also from the offline queue. */
  clientEventId: z.string().regex(CLIENT_SCAN_ID, 'Expected 8 to 64 letters, digits, dots, colons, underscores or hyphens.'),
  tileCode: z.enum(FLOOR_NOTE_TILE_CODES),
  /** The worker's own words, when there are any. */
  note: z.string().trim().min(1).max(FLOOR_NOTE_LIMITS.noteMax).optional(),
  /** Confirmed files of this work order. */
  fileIds: z.array(id()).max(FLOOR_NOTE_LIMITS.filesPerNote).optional(),
  /** What it is about, when it is about one bundle and operation. */
  bundleId: id().optional(),
  workOrderOperationId: id().optional(),
  occurredAt: instant().optional(),
})

const noteAnswer = output({ messageId: id(), threadId: id(), files: z.number().int() })

export const noteContract = defineContract({ params: workOrderParams, body: noteBody, response: { 200: noteAnswer, 201: noteAnswer } })
