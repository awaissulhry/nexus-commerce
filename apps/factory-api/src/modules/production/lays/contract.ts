import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { LENGTH_UOMS, ROLL_STATES } from '@nexus/factory-domain/inventory/rolls/rolls'
import { ALLOCATION_REFUSALS, ALLOCATION_WARNINGS } from '@nexus/factory-domain/production/cutorders/allocation'
import { CUT_ORDER_KINDS, CUT_ORDER_LIMITS, CUT_ORDER_STATUSES, CUT_TICKET_STATUSES, LAY_STATUSES } from '@nexus/factory-domain/production/cutorders/rules'
import { CUT_VARIANCE_REASONS, RECONCILE_REFUSALS } from '@nexus/factory-domain/production/lays/reconcile'
import { LAY_LIMITS, LAY_REFUSALS, LAY_WARNINGS } from '@nexus/factory-domain/production/lays/rules'

/**
 * Lays at the table and the reconciliation of a cut order (B-W2b-116; MES-038, MES-039, MES-045, MES-046): the contracts of
 * spread.ts, fabric.ts and reconcile.ts. Lengths are decimal strings in the unit beside them (a roll's: its own; the sums and the
 * fabric used: metres); an instant is ISO 8601 UTC. No money; no person.
 */

const words = output({ it: z.string(), en: z.string() })
const ref = output({ id: id(), code: z.string(), name: z.string() })
const decimal = () => z.string().trim().regex(/^\d{1,14}(\.\d{1,4})?$/, 'A decimal of 0 or more, at most four decimals.')
const version = z.number().int().min(1)
const uom = z.enum(LENGTH_UOMS)
const layParams = input({ layId: id() })

const refusalCodes = z.enum([...LAY_REFUSALS, ...RECONCILE_REFUSALS, ...ALLOCATION_REFUSALS])

export const layView = output({
  lay: output({
    id: id(),
    cutOrderId: id(),
    seq: z.number().int(),
    /** Lays of the cut order not cancelled. */
    of: z.number().int(),
    /** The plies planned. */
    plies: z.number().int(),
    status: z.enum(LAY_STATUSES),
    /** The lay's length on the table (null: the marker's). */
    layLength: z.string().nullable(),
    lengthUom: uom.nullable(),
    /** One ply off a roll, in metres. */
    plyMetres: z.string(),
    counted: output({ left: z.number().int(), right: z.number().int(), checkedAt: instant() }).nullable(),
    cutAt: instant().nullable(),
    version: z.number().int(),
  }),
  cutOrder: output({
    id: id(),
    number: z.string(),
    kind: z.enum(CUT_ORDER_KINDS),
    status: z.enum(CUT_ORDER_STATUSES),
    material: output({ item: ref, colour: ref.nullable() }),
    marker: output({ name: z.string(), length: z.string(), uom, widthCm: z.string().nullable(), words }).nullable(),
    /** "46:1 · 48:2": the size chips. */
    ratio: z.string(),
    garmentsPerPly: z.number().int(),
  }),
  ticket: output({ id: id(), number: z.string(), code: z.string(), status: z.enum(CUT_TICKET_STATUSES) }).nullable(),
  /** The lay report, roll by roll. */
  rolls: z.array(
    output({
      id: id(),
      seq: z.number().int(),
      rollId: id(),
      code: z.string(),
      lotCode: z.string(),
      plies: z.number().int(),
      splices: z.number().int(),
      endLoss: z.string(),
      endReturned: z.string(),
      uom,
      /** What it gave the lay (plies × ply + end loss), in its unit. */
      used: z.string(),
      state: z.enum(ROLL_STATES),
      lengthLeft: z.string(),
      shade: z.string().nullable(),
      shrinkageGroup: z.string().nullable(),
      version: z.number().int(),
    }),
  ),
  /** The running sums: plies, rolls, plies still needed, what the rolls gave (metres), in words. */
  spread: output({ plies: z.number().int(), rolls: z.number().int(), needed: z.number().int(), used: z.string(), words: words.nullable() }),
  /** A CUT lay's fabric used, in metres (stored once confirmed). */
  fabricUsed: output({
    posted: z.boolean(),
    uom,
    plies: z.number().int(),
    estimated: z.string(),
    recorded: z.string(),
    confirmed: z.string().nullable(),
    confirmedAt: instant().nullable(),
    note: z.string().nullable(),
    version: z.number().int().nullable(),
    words,
    recordedWords: words,
  }).nullable(),
  /** Why the table may not spread or count it now. */
  refusal: output({ code: refusalCodes, message: z.string() }).nullable(),
  can: output({ spread: z.boolean(), count: z.boolean(), fabricUsed: z.boolean() }),
  warnings: z.array(output({ code: z.enum([...ALLOCATION_WARNINGS, ...LAY_WARNINGS]), message: z.string() })),
})

const written = { 200: layView.extend({ replayed: z.boolean() }) }

export const readLayContract = defineContract({ params: layParams, response: { 200: layView } })

export const startLayContract = defineContract({
  params: layParams,
  body: input({ version: version.optional(), layLength: decimal().optional(), uom: uom.optional() }),
  response: written,
})

const figures = {
  plies: z.number().int().min(1).max(CUT_ORDER_LIMITS.pliesPerLay).optional(),
  splices: z.number().int().min(0).max(LAY_LIMITS.splices).optional(),
  endLoss: decimal().optional(),
  endReturned: decimal().optional(),
  /** The unit of endLoss and endReturned (default the roll's). */
  uom: uom.optional(),
}

export const addRollContract = defineContract({
  params: layParams,
  body: input({ version: version.optional(), code: z.string().trim().min(1).max(60).optional(), rollId: id().optional(), ...figures }),
  response: { 201: layView.extend({ replayed: z.boolean() }) },
})

export const changeRollContract = defineContract({
  params: input({ layId: id(), layRollId: id() }),
  body: input({ version: version.optional(), ...figures }),
  response: written,
})

export const undoRollContract = defineContract({ params: layParams, body: input({ version: version.optional(), layRollId: id().optional() }), response: written })

export const countLayContract = defineContract({
  params: layParams,
  body: input({ version: version.optional(), left: z.number().int().min(1).max(CUT_ORDER_LIMITS.pliesPerLay), right: z.number().int().min(1).max(CUT_ORDER_LIMITS.pliesPerLay) }),
  response: written,
})

export const fabricUsedContract = defineContract({
  params: layParams,
  body: input({
    version: version.optional(),
    confirmed: decimal().optional(),
    uom: uom.optional(),
    note: z.string().trim().max(LAY_LIMITS.note).nullish(),
    overIssueReason: z.string().trim().min(1).max(CUT_ORDER_LIMITS.reason).optional(),
  }),
  response: written,
})

// ---- the reconciliation -------------------------------------------------------------------------------------------------------

const figuresOut = { ordered: z.number().int(), cut: z.number().int(), recut: z.number().int(), difference: z.number().int() }
const materialSums = { estimated: z.string(), recorded: z.string(), used: z.string().nullable(), issued: z.string(), endLoss: z.string(), endsReturned: z.string() }

export const reconciliationView = output({
  cutOrder: output({ id: id(), number: z.string(), kind: z.enum(CUT_ORDER_KINDS), status: z.enum(CUT_ORDER_STATUSES), version: z.number().int(), reconciledAt: instant().nullable() }),
  lines: z.array(
    output({
      id: id(),
      seq: z.number().int(),
      workOrder: output({ id: id(), number: z.string() }),
      style: ref,
      colourway: ref,
      size: z.string(),
      ratio: z.number().int().nullable(),
      ...figuresOut,
      needsReason: z.boolean(),
      reconciled: output({ varianceReasonCode: z.string().nullable(), note: z.string().nullable(), reconciledAt: instant() }).nullable(),
    }),
  ),
  /** Ordered and cut per size. */
  sizes: z.array(output({ size: z.string(), ...figuresOut })),
  /** FABRIC: per CUT lay and summed, in metres: the estimate, the lay report, used (confirmed), issued, end loss, ends returned. */
  material: output({
    uom,
    lays: z.array(output({ layId: id(), seq: z.number().int(), plies: z.number().int(), ...materialSums, confirmed: z.boolean() })),
    sum: output({ ...materialSums, used: z.string() }),
    words,
  }).nullable(),
  reasons: z.array(output({ code: z.enum(CUT_VARIANCE_REASONS), words })),
  refusal: output({ code: z.enum(RECONCILE_REFUSALS), message: z.string() }).nullable(),
  garments: output({ ordered: z.number().int(), cut: z.number().int() }),
  words,
  can: output({ reconcile: z.boolean() }),
})

const cutOrderParams = input({ cutOrderId: id() })

export const reconciliationContract = defineContract({ params: cutOrderParams, response: { 200: reconciliationView } })

export const reconcileContract = defineContract({
  params: cutOrderParams,
  body: input({
    version,
    lines: z
      .array(input({ lineId: id(), reasonCode: z.string().trim().min(1).max(40).optional(), note: z.string().trim().max(LAY_LIMITS.note).nullish() }))
      .max(CUT_ORDER_LIMITS.lines)
      .optional(),
  }),
  response: { 200: reconciliationView },
})
