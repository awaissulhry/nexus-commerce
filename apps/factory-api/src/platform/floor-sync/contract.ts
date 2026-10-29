import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DISCARD_REASON_MAX, DISCARD_REASON_MIN, MAX_SYNC_EVENTS, CLIENT_EVENT_ID } from '@nexus/factory-domain/floor-sync/rules'
import { SCAN_ID_KINDS } from '@nexus/factory-domain/numbering/kinds'
import { blockView } from '../numbering/contract'

/**
 * The floor sync (B-W0-30; PLT-237, PLT-239, PLT-240, PLT-189; design floor.sync SCR-023). No field carries money; no
 * floor answer names a worker (a refused action is the tablet's own, or "another person's", counted); the office sees
 * one refused action's worker by name, inside that record only.
 */

const clientEventId = () => z.string().regex(CLIENT_EVENT_ID, 'Expected 8 to 64 letters, digits, dots, colons, underscores or hyphens.')

const event = input({
  /** The tablet's id for the event (unique per tablet): a resend is answered, never applied twice. */
  clientEventId: clientEventId(),
  /** Its place in the tablet's queue (FIFO per tablet). */
  seq: z.number().int().min(0).max(2_000_000_000),
  /** factory-domain floor-sync FLOOR_SYNC_KINDS. */
  kind: z.string().trim().min(1).max(80),
  /** When it happened, by the tablet's clock. */
  occurredAt: instant().optional(),
  /** Who did it on the tablet (the worker signed in then): another person's waits for them. */
  workerId: id().optional(),
  /** The module's body without the envelope (factory-api platform/floor-sync kinds.ts). */
  payload: z.record(z.string(), z.unknown()),
})

const summary = output({
  code: z.string().nullable().optional(),
  good: z.number().int().optional(),
  scrap: z.number().int().optional(),
  rework: z.number().int().optional(),
  quantity: z.number().int().optional(),
  sets: z.number().int().optional(),
  workOrderId: z.string().optional(),
  target: z.string().nullable().optional(),
})

const refusalAnswer = output({
  /** The kept refused action (null: not kept, e.g. another person's action that waits for them). */
  id: id().nullable(),
  code: z.string(),
  message: z.string(),
  fix: z.string(),
  final: z.boolean(),
})

const clock = output({ deviceSentAt: instant(), skewSeconds: z.number().int(), off: z.boolean(), flagged: z.boolean() })

export const syncContract = defineContract({
  body: input({
    /** The tablet's clock at the send (the clock check, PLT-240). */
    sentAt: instant().optional(),
    /** The queue's events, each once; applied by seq whatever the order here. */
    events: z.array(event).max(MAX_SYNC_EVENTS),
    /** The tablet's own count of numbers left per kind (labels printed and not yet sent count as used): top-up. */
    blocks: z
      .array(input({ kind: z.enum(SCAN_ID_KINDS), remaining: z.number().int().min(0).max(2_000_000_000).optional() }))
      .max(SCAN_ID_KINDS.length)
      .optional(),
  }),
  response: {
    200: output({
      serverTime: instant(),
      clock: clock.nullable(),
      events: z.array(
        output({
          clientEventId: z.string(),
          seq: z.number().int(),
          kind: z.string(),
          /** accepted: recorded now; duplicate: recorded before; refused: kept with its reason; waiting: another person's. */
          status: z.enum(['accepted', 'duplicate', 'refused', 'waiting']),
          /** When the server recorded it (accepted, duplicate). */
          serverTime: instant().nullable(),
          result: output({ type: z.string(), id: id() }).nullable(),
          refusal: refusalAnswer.nullable(),
        }),
      ),
      /** The tablet's open number blocks after the top-up (only when it sent `blocks`). */
      blocks: output({ scanTag: z.string(), blocks: z.array(blockView) }).nullable(),
    }),
  },
})

const refusedView = output({
  id: id(),
  siteId: id(),
  deviceId: id(),
  clientEventId: z.string(),
  kind: z.string(),
  deviceSeq: z.number().int(),
  code: z.string(),
  message: z.string(),
  fix: z.string(),
  final: z.boolean(),
  summary,
  stationId: id().nullable(),
  deviceTime: instant().nullable(),
  serverTime: instant(),
  status: z.enum(['OPEN', 'RESOLVED', 'DISCARDED']),
  resolvedAt: instant().nullable(),
  discardedAt: instant().nullable(),
  discardedBy: z.enum(['FLOOR', 'OFFICE']).nullable(),
  discardReason: z.string().nullable(),
  version: z.number().int(),
})

export const mineContract = defineContract({
  response: {
    200: output({
      serverTime: instant(),
      /** The tablet's last recorded event (null: none yet). */
      lastRecordedAt: instant().nullable(),
      /** Who the site's floor records name: the worker, or only the station. */
      subject: z.enum(['WORKER', 'STATION']),
      /** The open refused actions that are the person's on this tablet, newest first. */
      refused: z.array(refusedView),
      /** Other people's open refused actions on this tablet: counted, never shown (Statuto dei Lavoratori art. 4). */
      othersRefused: z.number().int(),
    }),
  },
})

const refusedParams = input({ refusedId: id() })

export const floorDiscardContract = defineContract({
  params: refusedParams,
  body: input({}).optional(),
  response: { 200: output({ refused: refusedView }) },
})

const listStatus = z.enum(['OPEN', 'RESOLVED', 'DISCARDED', 'ALL'])

export const listRefusedContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    deviceId: id().optional(),
    kind: z.string().trim().min(1).max(80).optional(),
    /** Default OPEN: the ones someone must act on. */
    status: listStatus.default('OPEN'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      refused: z.array(refusedView.extend({ device: output({ id: id(), name: z.string() }) })),
    }),
  },
})

export const refusedOneContract = defineContract({
  params: refusedParams,
  response: {
    200: output({
      refused: refusedView.extend({
        device: output({ id: id(), name: z.string() }),
        /** Who sent it, by name, where the site names workers (inside this one record only). */
        worker: output({ id: id(), name: z.string() }).nullable(),
        discardedById: id().nullable(),
        /** What the tablet sent. */
        payload: z.record(z.string(), z.unknown()),
        moduleRefusal: output({ type: z.string(), id: id() }).nullable(),
      }),
    }),
  },
})

export const officeDiscardContract = defineContract({
  params: refusedParams,
  body: input({
    /** Why it will not be recorded (the tablet and the audit log keep it). */
    reason: z.string().trim().min(DISCARD_REASON_MIN).max(DISCARD_REASON_MAX),
    version: z.number().int().min(1),
  }),
  response: { 200: output({ refused: refusedView }) },
})
