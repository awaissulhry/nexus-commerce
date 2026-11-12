import { z } from 'zod'
import { businessDate, defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { CERTIFICATE_STATUSES } from '@nexus/factory-domain/compliance/certificates/rules'
import { ITEM_KINDS, ITEM_TRACKINGS } from '@nexus/factory-domain/product/materials/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import { LINE_KIND_SEND_CHECK_CODES } from '@nexus/factory-domain/purchasing/line-kinds/codes'
import { ROLL_LIMITS } from '@nexus/factory-domain/purchasing/line-kinds/rolls'
import { VARIANT_LIMITS } from '@nexus/factory-domain/purchasing/line-kinds/variants'

/**
 * The contracts of purchase order lines by kind (B-W2b-328; SCM-076, SCM-077, SCM-186). No money here: a line's price and
 * amount stay on W1's line (the order's record); a change of the quantity by rolls answers the lines-by-kind view, and
 * the record (GET /purchasing/orders/:id) shows the new amount to a caller with the cost grain. Every write names the
 * order's version: the edit-conflict guard.
 */

const version = z.number().int().min(1)
const measure = z.string().trim().min(1).max(14)

const certificateView = output({
  id: id(),
  number: z.string(),
  standard: z.string(),
  status: z.enum(CERTIFICATE_STATUSES),
  validFrom: businessDate(),
  validTo: businessDate(),
})

const variantView = output({
  code: z.string(),
  itemColourId: id().nullable(),
  colourCode: z.string().nullable(),
  size: z.string().nullable(),
  supplierCode: z.string().nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
})

const checkView = output({ code: z.enum(LINE_KIND_SEND_CHECK_CODES), severity: z.enum(['BLOCKS', 'WARNING']), path: z.string(), message: z.string() })

export const lineKindsView = output({
  orderId: id(),
  number: z.string(),
  status: z.enum(PURCHASE_ORDER_STATUSES),
  /** The order's version now (the next write names it). */
  version: z.number().int(),
  /** STANDARD, or SAMPLE (development: a protector line without a certificate is a warning only). */
  kind: z.enum(['STANDARD', 'SAMPLE']),
  /** The lines can change (a DRAFT order and the caller holds purchasing.manage over it). */
  mayChange: z.boolean(),
  lines: z.array(
    output({
      id: id(),
      seq: z.number().int(),
      itemId: id(),
      itemCode: z.string(),
      itemKind: z.enum(ITEM_KINDS),
      tracking: z.enum(ITEM_TRACKINGS),
      itemColourId: id().nullable(),
      quantity: z.string(),
      uom: z.enum(UOMS),
      /** Cancelled or closed short: its kind changes no more. */
      ended: z.boolean(),
      /** FABRIC and TRIM lines go by rolls; PROTECTOR lines name a certificate; any line may name a variant. */
      buysAs: z.enum(['FABRIC', 'TRIM', 'PROTECTOR', 'OTHER']),
      rolls: output({
        count: z.number().int(),
        lengthM: z.string().nullable(),
        widthCm: z.string().nullable(),
        /** "2 rolls × 50 m × 150 cm". */
        words: z.string(),
        /** The quantity the rolls make in the line's unit (null: its unit cannot say it, the quantity is as typed). */
        makes: z.string().nullable(),
        matches: z.boolean(),
      }).nullable(),
      /** The material's own width in cm (its properties): the default width of a roll. */
      materialWidthCm: z.string().nullable(),
      /** A warning when the rolls are another width than the material's. */
      widthNote: z.string().nullable(),
      ppe: z.boolean(),
      certificate: certificateView
        .extend({
          /** HOLDS today from this supplier, or why not. */
          state: z.enum(['HOLDS', 'NOT_VALID', 'OTHER_SUPPLIER', 'NOT_COVERING']),
          words: z.string(),
          /** It ends before the line's need date. */
          endsBeforeNeed: z.boolean(),
        })
        .nullable(),
      /** The PPE register's certificates that cover the material from this supplier today (a protector line's picker). */
      certificateChoices: z.array(certificateView.extend({ coverage: z.enum(['THIS_SUPPLIER', 'ANY_SUPPLIER']) })),
      variant: variantView.extend({ problem: z.string().nullable() }).nullable(),
      /** The material's ACTIVE variants that fit the line's colour (a variant without a colour fits every colour). */
      variantChoices: z.array(variantView),
      /** The material is tracked by lot (or hide, serial): each lot keeps its variant apart in stock. */
      keepsVariantsApart: z.boolean(),
    }),
  ),
  /** What a send checks of the lines by kind now (DRAFT; empty otherwise). */
  checks: z.array(checkView),
})

const kindsAnswer = output({ kinds: lineKindsView })

export const getLineKindsContract = defineContract({ params: input({ purchaseOrderId: id() }), response: { 200: kindsAnswer } })

export const putLineKindContract = defineContract({
  params: input({ purchaseOrderId: id(), lineId: id() }),
  body: input({
    version,
    /** The rolls (null: not by rolls). The width defaults to the material's own; the quantity follows when its unit can say it. */
    rolls: input({ count: z.number().int().min(1).max(ROLL_LIMITS.rolls), lengthM: measure.nullable().optional(), widthCm: measure.nullable().optional() }).nullable().optional(),
    /** The PPE register's certificate the supplier delivers against (null: none named). */
    certificateId: id().nullable().optional(),
    /** The material's variant the line buys, by its code (null: none). A line without a colour takes the variant's. */
    variantCode: z.string().trim().min(1).max(VARIANT_LIMITS.code).nullable().optional(),
  }),
  response: { 200: kindsAnswer },
})
