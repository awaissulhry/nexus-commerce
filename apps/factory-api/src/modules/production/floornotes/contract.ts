import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { FILE_ASK_KINDS } from '@nexus/factory-domain/files/asks' // B-OF-034
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
  // B-OF-034 (order files tab): the office's ask for a file this photo answers (the note's files go to the ask: OPEN → ARRIVED); an
  // ask no longer open, or not this tablet's, leaves the ask as it is and the note posts as any note. Also on the offline queue
  // (production.floorNote.post parses this body), though a photo itself goes up only online.
  askId: id().optional(),
})

// B-OF-034: + the ask the note named, and whether its photo answered it (false: it was closed meanwhile, or not this tablet's).
const noteAnswer = output({ messageId: id(), threadId: id(), files: z.number().int(), ask: output({ id: id(), answered: z.boolean() }).nullable() })

export const noteContract = defineContract({ params: workOrderParams, body: noteBody, response: { 200: noteAnswer, 201: noteAnswer } })

// ── B-OF-034 (order files tab; 13-backend §2): the office's open asks for files this tablet answers ──
/**
 * GET /production/floor-notes/asks: the OPEN asks of the tablet's own site addressed to the signed-in worker's team, one of their live
 * floor roles, or whoever works a step of a work order the station's queue or the person's day holds. What the floor reads: what is
 * asked (never priced, never body data: the database refuses those to the floor), the kind, the due day and how late, the work order
 * and its step, the customer's CODE only, the newest reason it was asked again, the last "ask for an update". Never a worker, never a
 * name, never "seen" (the read writes nothing).
 */
export const floorAskView = output({
  askId: id(),
  words: z.string(),
  fileKind: z.enum(FILE_ASK_KINDS),
  dueOn: businessDate(),
  lateDays: z.number().int(),
  workOrder: output({ id: id(), number: z.string() }),
  step: output({ id: id(), seq: z.number().int(), name: z.string() }).nullable(),
  /** The customer as the floor reads it: its code, never its name (null: none). */
  customer: z.string().nullable(),
  /** "Asked again: {reason}" (null: never asked again). */
  askedAgain: z.string().nullable(),
  /** "The office asked for an update, {day}" (null: never). */
  chasedAt: instant().nullable(),
})

export const floorAsksContract = defineContract({ response: { 200: output({ asOf: instant(), asks: z.array(floorAskView) }) } })
// ── end B-OF-034 ──
