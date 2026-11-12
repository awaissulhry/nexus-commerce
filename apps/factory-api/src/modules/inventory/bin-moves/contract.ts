import { z } from 'zod'
import { defineContract, id, input, instant, output, quantity } from '@nexus/factory-domain/core/contracts'
import { QUALITY_STATES, SCANNED_KINDS } from '@nexus/factory-domain/inventory/bin-moves/rules'
import { taskView } from '../tasks/contract'

/**
 * Moves on the floor (B-W2b-292; SCM-218, SCM-202): the contracts of "In your hands" (a scan), a move by its two scans and its
 * undo. Quantities are decimal strings in the item's base unit; no field carries money; no person.
 */

const scanned = () => z.string().trim().min(1).max(80)

export const handView = output({
  kind: z.enum(SCANNED_KINDS),
  code: z.string(),
  /** "Lot LOT-…", "Hide …", "Roll RL-…", "Remnant RM-…". */
  label: z.string(),
  siteId: id(),
  item: output({ id: id(), code: z.string(), name: z.string(), kind: z.string(), tracking: z.string(), baseUom: z.string() }),
  colour: output({ code: z.string(), name: z.string() }).nullable(),
  lot: output({ id: id(), code: z.string(), qualityStatus: z.string(), lifecycle: z.string() }).nullable(),
  hide: output({ id: id(), code: z.string(), state: z.string() }).nullable(),
  roll: output({ id: id(), code: z.string(), state: z.string() }).nullable(),
  remnant: output({ id: id(), code: z.string() }).nullable(),
  /** RELEASED, QUARANTINE, BLOCKED, REJECTED (the lot's) or ON_HOLD (an active hold names it). */
  quality: z.enum(QUALITY_STATES),
  holdIds: z.array(id()),
  /** It moves whole (a hide, a remnant, a roll, a lot tracked hide by hide). */
  whole: z.boolean(),
  uom: z.string(),
  onHand: z.string(),
  /** Where it lies at the site now (most first). */
  lying: z.array(output({ locationId: id(), code: z.string(), name: z.string(), kind: z.string(), onHand: z.string() })),
})

const placeShort = output({ id: id(), code: z.string(), name: z.string(), kind: z.string() })

export const scanContract = defineContract({
  querystring: input({ code: scanned() }),
  response: { 200: output({ hand: handView, tasks: z.array(taskView) }) },
})

export const moveBody = input({
  /** What is moved: a lot's number, a hide's, a roll's or a remnant's tag (scanned). */
  code: scanned(),
  /** The place's bin label (scanned), or its code typed. */
  placeCode: scanned(),
  fromLocationId: id().nullish(),
  /** In the item's base unit; left out: all of it. */
  quantity: quantity().nullish(),
  taskId: id().nullish(),
  note: z.string().trim().max(500).nullish(),
  occurredAt: instant().optional(),
})

const moveAnswer = output({
  moveIds: z.array(id()),
  moves: z
    .array(output({ id: id(), itemId: id(), lotId: id().nullable(), hideId: id().nullable(), fromLocationId: id().nullable(), toLocationId: id().nullable(), quantity: z.string(), uom: z.string(), occurredAt: instant() }))
    .optional(),
  from: placeShort,
  to: placeShort,
  /** What is in hand after the move (where it lies now). */
  hand: handView,
  /** The put-away and move tasks the move did (DONE) or took (still partly there). */
  tasks: z.array(taskView),
})

export const moveContract = defineContract({ body: moveBody, response: { 201: moveAnswer } })

export const undoContract = defineContract({
  params: input({ moveId: id() }),
  response: { 201: output({ undoneIds: z.array(id()), moveIds: z.array(id()), tasks: z.array(taskView) }) },
})
