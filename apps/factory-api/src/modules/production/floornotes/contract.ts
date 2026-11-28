import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { FILE_ASK_KINDS } from '@nexus/factory-domain/files/asks' // B-OF-034
import { FLOOR_NOTE_LIMITS, FLOOR_NOTE_TILE_CODES } from '@nexus/factory-domain/production/floornotes/rules'
import { CLIENT_SCAN_ID } from '@nexus/factory-domain/production/scans/rules'
import { fileView, presignedView } from '../../../platform/files/contract'
// owb-fl3 (S5 server B): Tell the office, the Me page.
import { SUGGESTION_KINDS, SUGGESTION_LIMITS } from '@nexus/factory-domain/production/baskets/signals'
import { departmentView } from '../departments/contract'

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

// ── owb-fl3 (S5 server B; `_owb-fl-common.md` § 3 "fl3"): Tell the office, and the Me page ──────────────────────────────────────
/**
 * POST /floor/suggestions: an idea, something wrong or a thanks, in words or a voice note (POST /floor/suggestions/files, then
 * …/complete, online only). `withName` false: nothing of the worker is kept (no worker id, no tablet clock, the receipt's key
 * hashed; it never goes through the offline queue). `withName` true names the worker only where the site names workers.
 */
export const suggestionBody = input({
  kind: z.enum(SUGGESTION_KINDS),
  words: z.string().trim().min(1).max(SUGGESTION_LIMITS.words).optional(),
  /** A voice note announced and confirmed with POST /floor/suggestions/files. */
  voiceFileId: id().optional(),
  withName: z.boolean(),
  /** The phone's id for it (A1 §3.8): one suggestion, once. */
  clientEventId: z.string().regex(CLIENT_SCAN_ID, 'Expected 8 to 64 letters, digits, dots, colons, underscores or hyphens.'),
  occurredAt: instant().optional(),
})
export type SuggestionBody = z.infer<typeof suggestionBody>

const suggestionAnswer = output({
  /** `withName`: the worker's name went with it (asked for, and the site names workers). */
  suggestion: output({ id: id(), kind: z.enum(SUGGESTION_KINDS), withName: z.boolean() }),
  replayed: z.boolean(),
})
export const suggestionContract = defineContract({ body: suggestionBody, response: { 201: suggestionAnswer, 200: suggestionAnswer } })

export const suggestionVoiceContract = defineContract({
  body: input({
    originalName: z.string().min(1).max(500),
    /** A sound (audio/…). */
    contentType: z.string().min(1).max(200),
    sizeBytes: z.number().int().min(1),
    sha256: z.string(),
    durationSeconds: z.number().min(0).max(SUGGESTION_LIMITS.voiceSeconds),
  }),
  response: { 201: output({ file: fileView, upload: presignedView }) },
})
export const suggestionVoiceCompleteContract = defineContract({ params: input({ fileId: id() }), response: { 200: output({ file: fileView }) } })

/**
 * GET /floor/me/profile (the Me page; GET /floor/me stays the session's): my team and its leader (names only where the site names
 * workers), the departments I may work in (my skills' operations; none known → every active department), today's done count for
 * my eyes only after the PIN step-up (My day's rule; else null), my language and the site's floor languages.
 */
export const profileContract = defineContract({
  response: {
    200: output({
      subject: z.enum(['WORKER', 'STATION']),
      team: output({ id: id(), name: z.string() }).nullable(),
      leader: output({ name: z.string().nullable() }).nullable(),
      departments: z.array(departmentView.pick({ id: true, number: true, name: true, shortName: true, tone: true, icon: true, nameI18n: true })),
      /** SKILLS: from my skills' operations; ALL: no skill says, every active department. */
      departmentsFrom: z.enum(['SKILLS', 'ALL']),
      /** Baskets I reported today and did not undo; null until the PIN step-up (or at a site that records stations). */
      doneToday: z.number().int().nullable(),
      locale: z.string(),
      floorLocales: z.array(z.string()),
    }),
  },
})
// ── end owb-fl3 ──
