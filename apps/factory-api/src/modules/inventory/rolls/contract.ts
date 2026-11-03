import { z } from 'zod'
import { periodLockOverride as lockOverride } from '@nexus/factory-domain/accounting/contracts'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { LEVEL_STATES, PACK_UOMS } from '@nexus/factory-domain/inventory/rolls/consumables'
import { CERTIFICATE_STATES, PROTECTOR_LIMITS, PROTECTOR_WARNINGS } from '@nexus/factory-domain/inventory/rolls/protectors'
import { LENGTH_UOMS, ROLL_LIMITS, ROLL_STATES } from '@nexus/factory-domain/inventory/rolls/rolls'

/**
 * Rolls, protector lots and consumables (B-W2b-107; SCM-260, SCM-261, SCM-263): the contracts of read.ts, write.ts, stock.ts,
 * protectors.ts and consumables.ts. Lengths and quantities are decimal strings with four decimals in the unit beside them;
 * the list's summary is rolls beside length. No money; no person (a roll's history names an office person by name, a floor
 * action by its audience only).
 */

const decimal = () => z.string().trim().regex(/^\d{1,14}(\.\d{1,4})?$/, 'A decimal of 0 or more, at most four decimals.')
const length = () => decimal()
const percent = () => z.string().trim().regex(/^\d{1,3}(\.\d{1,2})?$/, 'A percent from 0 to 100, two decimals.')
const uom = z.enum(LENGTH_UOMS)
const words = output({ it: z.string(), en: z.string() })
const place = output({ id: id(), code: z.string(), name: z.string() })
const optionalText = (max: number) => z.string().max(max).nullish()
const periodLockOverride = lockOverride.optional()

// ---- rolls ------------------------------------------------------------------------------------------------------------------

export const rollView = output({
  id: id(),
  code: z.string(),
  state: z.enum(ROLL_STATES),
  /** In a place of the site's stock (FULL, PARTIAL, END with a place). */
  inStock: z.boolean(),
  version: z.number().int(),
  siteId: id(),
  companyId: id(),
  item: output({ id: id(), code: z.string(), name: z.string() }),
  colour: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  lot: output({ id: id(), code: z.string(), dyeBatch: z.string().nullable(), qualityStatus: z.string() }),
  supplierRollRef: z.string().nullable(),
  /** As received (fixed) and what is left in stock, in `uom`. */
  length: z.string(),
  lengthLeft: z.string(),
  uom,
  /** "44.5 m of 60 m" (it "44,5 m su 60 m"). */
  words,
  widthCm: z.string().nullable(),
  shade: z.string().nullable(),
  shadeGroup: output({ id: id(), label: z.string(), outOfShade: z.boolean() }).nullable(),
  shrinkageLengthPercent: z.string().nullable(),
  shrinkageWidthPercent: z.string().nullable(),
  shrinkageGroup: z.string().nullable(),
  defects: z.string().nullable(),
  location: place.nullable(),
  note: z.string().nullable(),
  createdAt: instant(),
  updatedAt: instant(),
})

/** A lot's rolls against its ledger, per place (base unit). */
export const lotCheckView = output({
  lotId: id(),
  lotCode: z.string(),
  uom,
  onHand: z.string(),
  tagged: z.string(),
  /** In stock and on no roll. */
  untagged: z.string(),
  /** What the rolls say beyond what the ledger holds where they lie (a lot move no roll gave). */
  beyond: z.string(),
  rolls: z.number().int(),
  places: z.array(output({ location: place, onHand: z.string(), tagged: z.string(), untagged: z.string(), beyond: z.string() })),
  words,
})

export const rollParams = input({ rollId: id() })
export const lotParams = input({ lotId: id() })

export const listRollsContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    itemId: id().optional(),
    itemColourId: id().optional(),
    lotId: id().optional(),
    state: z.enum([...ROLL_STATES, 'inStock', 'all']).optional(),
    shadeGroupId: id().optional(),
    shade: z.string().trim().min(1).max(ROLL_LIMITS.shade).optional(),
    shrinkageGroup: z.string().trim().min(1).max(ROLL_LIMITS.shrinkageGroup).optional(),
    minWidthCm: decimal().optional(),
    maxWidthCm: decimal().optional(),
    minLengthLeft: decimal().optional(),
    q: z.string().trim().min(1).max(60).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: id().optional(),
  }),
  response: {
    200: output({
      rows: z.array(rollView),
      nextCursor: id().nullable(),
      /** Rolls beside what is left on them, for the whole selection (all pages): counts and lengths, not money. */
      summary: output({ rolls: z.number().int(), length: z.string(), uom, words }),
      /** With `lotId`: the lot's rolls against its ledger. */
      lot: lotCheckView.nullable(),
    }),
  },
})

export const rollRecordContract = defineContract({
  params: rollParams,
  response: {
    200: output({
      roll: rollView,
      lot: lotCheckView,
      history: z.array(
        output({
          at: instant(),
          action: z.enum(['TAGGED', 'DESCRIBED', 'ISSUED', 'RETURNED', 'MOVED', 'SCRAPPED', 'CORRECTED']),
          from: z.string().nullable(),
          to: z.string().nullable(),
          lengthBefore: z.string().nullable(),
          lengthAfter: z.string().nullable(),
          workOrderNumber: z.string().nullable(),
          /** The office person's name; null for a floor action or the system. */
          by: z.string().nullable(),
          audience: z.string(),
          reason: z.string().nullable(),
        }),
      ),
    }),
  },
})

export const lookupRollContract = defineContract({
  querystring: input({ code: z.string().trim().min(3).max(40) }),
  response: { 200: output({ roll: rollView }) },
})

const description = {
  supplierRollRef: optionalText(ROLL_LIMITS.supplierRollRef),
  widthCm: z.string().trim().nullish(),
  shade: optionalText(ROLL_LIMITS.shade),
  shadeGroupId: id().nullish(),
  shrinkageLengthPercent: percent().nullish(),
  shrinkageWidthPercent: percent().nullish(),
  shrinkageGroup: optionalText(ROLL_LIMITS.shrinkageGroup),
  defects: optionalText(ROLL_LIMITS.defects),
  note: optionalText(ROLL_LIMITS.note),
}

export const tagRollsContract = defineContract({
  params: lotParams,
  body: input({
    /** Where the rolls lie (default: the one place holding what no roll claims). */
    locationId: id().optional(),
    /** The unit the lengths are in (default the lot's). */
    uom: uom.optional(),
    rolls: z.array(input({ length: length(), ...description })).min(1).max(ROLL_LIMITS.perTag),
  }),
  response: { 201: output({ rolls: z.array(rollView), lot: lotCheckView }) },
})

export const describeRollContract = defineContract({
  params: rollParams,
  body: input({ version: z.number().int().min(1), ...description, end: z.boolean().optional() }),
  response: { 200: output({ roll: rollView }) },
})

const written = output({ roll: rollView, moveIds: z.array(id()), workOrderId: id().nullable() })
const common = { version: z.number().int().min(1).optional(), occurredAt: instant().optional(), periodLockOverride }

export const issueRollContract = defineContract({
  params: rollParams,
  body: input({ ...common, workOrderId: id(), length: length().optional(), uom: uom.optional(), overIssueReason: z.string().trim().min(3).max(500).optional() }),
  response: { 200: written },
})

export const returnRollContract = defineContract({
  params: rollParams,
  body: input({ ...common, workOrderId: id(), length: length(), uom: uom.optional(), toLocationId: id(), note: optionalText(500) }),
  response: { 200: written },
})

export const moveRollContract = defineContract({
  params: rollParams,
  body: input({ ...common, toLocationId: id(), note: optionalText(500) }),
  response: { 200: written },
})

export const scrapRollContract = defineContract({
  params: rollParams,
  body: input({ ...common, reasonCode: z.string().trim().min(1).max(40), note: optionalText(500) }),
  response: { 200: written },
})

export const correctRollContract = defineContract({
  params: rollParams,
  body: input({ ...common, lengthLeft: length(), uom: uom.optional(), note: z.string().trim().min(3).max(500), reasonCode: z.string().trim().min(1).max(40).optional() }),
  response: { 200: written },
})

// ---- protector lots ------------------------------------------------------------------------------------------------------

const certificate = output({ state: z.enum(CERTIFICATE_STATES), validTo: z.string().nullable(), words })
const lotRef = output({ id: id(), code: z.string(), supplierLotRef: z.string().nullable(), qualityStatus: z.string() })
const itemRef = output({ id: id(), code: z.string(), name: z.string() })
const workOrderRef = output({ id: id(), number: z.string(), batchNumber: z.string().nullable(), status: z.string(), style: output({ code: z.string(), name: z.string() }) })
const registerCertificate = output({ id: id(), number: z.string(), standard: z.string(), validTo: z.string() }).nullable()

export const protectorRecordView = output({
  id: id(),
  workOrderId: id(),
  garmentSerial: output({ id: id(), serial: z.string(), status: z.string() }).nullable(),
  item: itemRef,
  lot: lotRef,
  placement: z.string().nullable(),
  certificate,
  withdrawn: output({ at: instant(), reason: z.string() }).nullable(),
  version: z.number().int(),
  createdAt: instant(),
})

export const workOrderParams = input({ workOrderId: id() })

export const batchProtectorsContract = defineContract({
  params: workOrderParams,
  response: {
    200: output({
      workOrder: workOrderRef,
      protectors: z.array(
        output({
          item: itemRef,
          /** On the batch's BOM (false: recorded though not planned). */
          planned: z.boolean(),
          batchLotIds: z.array(id()),
          garments: z.number().int(),
          missing: z.boolean(),
          /** The register's certificate covering the protector today (office answers only). */
          registerCertificate,
        }),
      ),
      records: z.array(protectorRecordView),
      /** The protector lots the work order holds now (issued less returned): what to record from. */
      issuedLots: z.array(output({ lot: lotRef, item: itemRef, issued: z.string(), certificate })),
      words,
    }),
  },
})

export const recordProtectorContract = defineContract({
  body: input({
    workOrderId: id(),
    garmentSerialId: id().optional(),
    serial: z.string().trim().min(3).max(40).optional(),
    lotId: id().optional(),
    lotCode: z.string().trim().min(1).max(60).optional(),
    placement: optionalText(PROTECTOR_LIMITS.placement),
  }),
  response: { 201: output({ record: protectorRecordView, warnings: z.array(output({ code: z.enum(PROTECTOR_WARNINGS), words })) }) },
})

export const withdrawProtectorContract = defineContract({
  params: input({ rowId: id() }),
  body: input({ version: z.number().int().min(1), reason: z.string().trim().min(PROTECTOR_LIMITS.reasonMin).max(PROTECTOR_LIMITS.reason) }),
  response: { 200: output({ record: protectorRecordView }) },
})

export const protectorRecallContract = defineContract({
  params: lotParams,
  response: {
    200: output({
      lot: output({ id: id(), code: z.string(), supplierLotRef: z.string().nullable(), qualityStatus: z.string(), item: itemRef }),
      certificate,
      registerCertificate,
      batches: z.array(output({ workOrder: workOrderRef, placements: z.array(z.string()) })),
      garments: z.array(output({ serial: output({ id: id(), serial: z.string(), status: z.string() }), workOrder: output({ id: id(), number: z.string() }), placement: z.string().nullable() })),
      /** Work orders the lot was issued to (not reversed) with no record of it: the recall reads them too. */
      issuedWithoutRecord: z.array(output({ workOrder: workOrderRef, issued: z.string() })),
      words,
      registerConcern: output({ lotIds: z.array(id()), workOrderIds: z.array(id()), serials: z.array(z.string()) }),
    }),
  },
})

// ---- consumables -----------------------------------------------------------------------------------------------------------

const pack = output({ packSize: z.string(), packUom: z.string() })

export const consumablesContract = defineContract({
  querystring: input({
    siteId: id(),
    q: z.string().trim().min(1).max(60).optional(),
    state: z.enum(LEVEL_STATES).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }),
  response: {
    200: output({
      site: output({ id: id(), code: z.string(), name: z.string() }),
      rows: z.array(
        output({
          item: output({ id: id(), code: z.string(), name: z.string(), kind: z.string(), baseUom: z.string(), version: z.number().int() }),
          colour: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
          pack: pack.nullable(),
          onHand: z.string(),
          onHandPacks: output({ packs: z.string(), loose: z.string() }).nullable(),
          onOrder: z.string(),
          reserved: z.string(),
          /** "12 cones · 60,000 m". */
          words,
          levels: output({ itemPlanningId: id(), method: z.string(), minStock: z.string().nullable(), maxStock: z.string().nullable(), version: z.number().int() }).nullable(),
          state: z.enum(LEVEL_STATES),
          /** On hand + on order − reserved. */
          position: z.string(),
          reorder: output({ quantity: z.string(), packs: z.string().nullable(), words }).nullable(),
          canEditPack: z.boolean(),
          canEditLevels: z.boolean(),
        }),
      ),
      more: z.boolean(),
      counts: output({ belowMin: z.number().int(), ok: z.number().int(), aboveMax: z.number().int(), noLevels: z.number().int() }),
    }),
  },
})

export const setPackContract = defineContract({
  params: input({ itemId: id() }),
  body: input({ version: z.number().int().min(1), packSize: decimal().nullable(), packUom: z.enum(PACK_UOMS).nullable() }),
  response: {
    200: output({
      item: output({ id: id(), code: z.string(), name: z.string(), kind: z.string(), baseUom: z.string(), version: z.number().int() }),
      pack: output({ packSize: z.string(), packUom: z.string(), words }).nullable(),
    }),
  },
})
