import { z } from 'zod'
import { defineContract, id, input, instant, output, quantity } from '@nexus/factory-domain/core/contracts'
import { AREA_UOMS } from '@nexus/factory-domain/inventory/hides/area'
import { notMoney } from '@nexus/factory-domain/money/marked'
import { GRADING_LIMITS } from '@nexus/factory-domain/inventory/hides/grading'
import { AREA_OUTCOMES, MEASURE_LIMITS } from '@nexus/factory-domain/inventory/hides/measure'
import { SHARE_SOURCES } from '@nexus/factory-domain/inventory/hides/usable'
import { HIDE_STATES } from '@nexus/factory-domain/inventory/issue/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'

/**
 * Hides as stock (B-W2b-94; PRD-031, SCM-249, SCM-250, SCM-258): the contracts of grade-rules.ts, grading.ts, measures.ts
 * and grade-mix.ts. Areas are decimal strings with four decimals, shares percents with two; an area says its unit beside it
 * (`uom`), and the two numbers of leather stock are a count of hides beside an area. Words are checked in factory-domain
 * inventory/hides (answers in words at `body/<field>`); the lengths here only stop oversized bodies. No money, no person
 * but who measured, inside one hide's record.
 */

const version = z.number().int().min(1)
const named = output({ id: id(), code: z.string(), name: z.string() })
const area = z.string()
const areaUom = z.enum(AREA_UOMS)
const share = z.string()
const flag = () => z.enum(['true', 'false']).transform((value) => value === 'true')
const words = output({ it: z.string(), en: z.string() })

const gradeRef = output({ id: id(), code: z.string(), labelIt: z.string(), labelEn: z.string(), active: z.boolean() })

// ---- an article's grades and usable shares (PRD-031; design products.materials "Grades and usable area") ---------------

const materialParams = input({ materialId: id() })

export const gradeRuleRow = output({
  grade: gradeRef.extend({ /** The grade's default share (no rule of the article's own). */ defaultShare: share }),
  /** The article's own active rule for the grade; null: the grade's default applies. */
  rule: output({ id: id(), usableShare: share, panels: z.array(z.string()), version: z.number().int(), updatedAt: instant() }).nullable(),
  /** What applies: the rule's share, else the grade's default. */
  share,
  source: z.enum(SHARE_SOURCES),
  /** The panels the grade may be cut for; empty: every panel. */
  panels: z.array(z.string()),
  /** Retired rules of the article for the grade (history). */
  retiredRules: z.array(output({ id: id(), usableShare: share, panels: z.array(z.string()), version: z.number().int(), updatedAt: instant() })),
  /** Hides of the article in stock with this grade (by record, or by their W1 text). */
  hidesInStock: z.number().int(),
})
export type GradeRuleRowView = z.infer<typeof gradeRuleRow>

export const gradeRulesContract = defineContract({
  params: materialParams,
  response: {
    200: output({
      material: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), tracksHides: z.boolean() }),
      /** Every active grade, and a retired one the article still has a rule for, in tile order. Empty: not a leather tracked by the hide. */
      grades: z.array(gradeRuleRow),
      canManage: z.boolean(),
    }),
  },
})

const ruleBody = {
  usableShare: z.string().max(12),
  panels: z.array(z.string().max(GRADING_LIMITS.panel * 4)).max(GRADING_LIMITS.panels * 2),
}

export const createGradeRuleContract = defineContract({
  params: materialParams,
  body: input({ gradeId: id(), usableShare: ruleBody.usableShare, panels: ruleBody.panels.optional() }),
  response: { 201: output({ grade: gradeRuleRow }) },
})

export const editGradeRuleContract = defineContract({
  params: input({ materialId: id(), ruleId: id() }),
  body: input({ version, usableShare: ruleBody.usableShare.optional(), panels: ruleBody.panels.optional(), /** false: retire; true: make a retired rule active again. */ active: z.boolean().optional() }),
  response: { 200: output({ grade: gradeRuleRow }) },
})

// ---- a hide's measures (SCM-249) ------------------------------------------------------------------------------------

const hideParams = input({ hideId: id() })

export const measureView = output({
  id: id(),
  measuredAt: instant(),
  /** The tannery's area as typed; null: none typed (the check uses the area the hide was received with). */
  declaredArea: area.nullable(),
  /** What the check sets the measure against, in the measure's unit. */
  declared: area,
  declaredFrom: z.enum(['TANNERY', 'RECEIPT']),
  measuredArea: area,
  areaUom,
  difference: area,
  differencePercent: z.string(),
  outcome: z.enum(AREA_OUTCOMES),
  /** The incoming inspection it was taken in; null: a re-measure on its own. */
  incomingInspectionId: id().nullable(),
  /** Who measured, inside this record only: an office user, or a floor worker where the site's PERFORMANCE gate is open. */
  by: output({ audience: z.enum(['OFFICE', 'FLOOR']), id: id().nullable(), name: z.string().nullable(), hidden: z.boolean() }),
  note: z.string().nullable(),
  /** The measure that counts: the latest. */
  latest: z.boolean(),
})
export type MeasureView = z.infer<typeof measureView>

const hideHead = output({
  id: id(),
  code: z.string(),
  state: z.enum(HIDE_STATES),
  version: z.number().int(),
  siteId: id(),
  companyId: id(),
  item: output({ id: id(), code: z.string(), name: z.string(), baseUom: z.enum(UOMS) }),
  colour: named.nullable(),
  lot: output({ id: id(), code: z.string(), dyeBatch: z.string().nullable() }),
  /** As received, never changed (W1's rule): a correction is an adjustment move. With the other unit beside it. */
  area: output({ uom: areaUom, quantity: area, other: output({ uom: areaUom, quantity: area }) }),
  /** The same area in the article's base unit. */
  baseArea: area,
  /** What the site's ledger holds of it now, base unit. */
  onHand: area,
})

export const measuresContract = defineContract({
  params: hideParams,
  response: {
    200: output({
      hide: hideHead,
      tolerancePercent: share,
      /** ORDER_LINE: the area tolerance of the purchase order line the lot came on; DEFAULT: the default (no setting yet). */
      toleranceFrom: z.enum(['ORDER_LINE', 'DEFAULT']),
      /** Newest first. */
      measures: z.array(measureView),
      latest: measureView.nullable(),
      /** Why the hide cannot be measured now (only a whole hide is); null: it can. */
      measureRefusal: z.string().nullable(),
      canMeasure: z.boolean(),
      /** May correct the hide's stock with the measure (inventory.adjust). */
      canCorrectStock: z.boolean(),
    }),
  },
})

export const recordMeasureContract = defineContract({
  params: hideParams,
  body: input({
    measuredArea: quantity(),
    /** Default the hide's own unit. */
    areaUom: areaUom.optional(),
    /** The tannery's area of this hide, in the same unit, when the list says it. */
    declaredArea: quantity().nullish(),
    /** Default now. */
    measuredAt: instant().optional(),
    note: z.string().max(MEASURE_LIMITS.note * 2).nullish(),
    /**
     * Also correct the hide's stock to the measured area: an ADJUSTMENT move at the place that holds it (inventory.adjust),
     * with its note and, optionally, a code of the ADJUSTMENT reason list.
     */
    correctStock: input({ note: z.string().max(MEASURE_LIMITS.reason * 2).nullish(), reasonCode: z.string().max(40).optional() }).optional(),
  }),
  response: {
    201: output({
      measure: measureView,
      /** The adjustment move; null: the stock was not asked to change, or said the measured area already. */
      move: output({ id: id(), direction: z.enum(['IN', 'OUT']), quantity: area, uom: z.enum(UOMS) }).nullable(),
    }),
  },
})

// ---- a hide's grade, shade group, thickness, defects (SCM-250; design "Measurements & grade") ---------------------------

const gradeChoice = gradeRef.extend({ share, source: z.enum(SHARE_SOURCES), panels: z.array(z.string()) })
const shadeChoice = output({ id: id(), label: z.string(), outOfShade: z.boolean(), swatchRef: z.string().nullable(), lotId: id().nullable() })

export const gradingView = output({
  hide: hideHead.extend({ supplierCode: z.string().nullable(), thicknessMm: z.string().nullable(), defects: z.string().nullable() }),
  /** The grade: its record, or the grade whose code its W1 text is (`byText`); null: ungraded. */
  grade: gradeRef.extend({ byText: z.boolean() }).nullable(),
  /** The hide's text as W1 keeps it (with a record: the grade's code). */
  gradeText: z.string().nullable(),
  shade: shadeChoice.nullable(),
  shadeText: z.string().nullable(),
  /** The usable area at its grade: of its measured area, and of what is left (base unit). Null: ungraded. */
  usable: output({ share, source: z.enum(SHARE_SOURCES), panels: z.array(z.string()), measured: area, left: area }).nullable(),
  /** The usable area of what is left at each grade the hide may be given (design "usable-area estimate per grade"). */
  estimates: z.array(output({ gradeId: id(), code: z.string(), share, source: z.enum(SHARE_SOURCES), usable: area, current: z.boolean() })),
  choices: output({ grades: z.array(gradeChoice), shadeGroups: z.array(shadeChoice) }),
  lastMeasure: measureView.nullable(),
  /** Why it cannot be changed (used up, scrapped, returned); null: it can. */
  readOnly: z.string().nullable(),
  /** The hide was cut already: a change says why. */
  reasonRequired: z.boolean(),
  canEdit: z.boolean(),
  /** Who changed grade, shade, thickness or defects, from → to, why; newest first. */
  changes: z.array(
    output({
      at: instant(),
      actorId: id(),
      audience: z.string(),
      from: z.record(z.string(), z.string().nullable()),
      to: z.record(z.string(), z.string().nullable()),
      reason: z.string().nullable(),
    }),
  ),
})
export type GradingView = z.infer<typeof gradingView>

export const gradingContract = defineContract({ params: hideParams, response: { 200: gradingView } })

export const correctGradingContract = defineContract({
  params: hideParams,
  body: input({
    version,
    /** A grade of the article's (null: no grade). The text is written with it. */
    gradeId: id().nullish(),
    /** A shade group of the hide's article, colour and lot (null: not sorted). The text is written with it. */
    shadeGroupId: id().nullish(),
    thicknessMm: z.string().max(12).nullish(),
    defects: z.string().max(GRADING_LIMITS.defects * 2).nullish(),
    /** Required once the hide was cut. */
    reason: z.string().max(GRADING_LIMITS.reason * 2).nullish(),
  }),
  response: { 200: gradingView },
})

// ---- a lot's area against the tannery (SCM-249, QHS-025) ------------------------------------------------------------

export const areaCheckContract = defineContract({
  params: input({ lotId: id() }),
  response: {
    200: output({
      lot: output({
        id: id(),
        code: z.string(),
        companyId: id(),
        siteId: id(),
        supplier: output({ id: id(), name: z.string() }).nullable(),
        supplierLotRef: z.string().nullable(),
        item: output({ id: id(), code: z.string(), name: z.string(), baseUom: z.enum(UOMS) }),
        receipt: output({ id: id(), number: z.string() }).nullable(),
      }),
      /** The unit every figure below is in: the article's base unit. */
      uom: areaUom,
      tolerancePercent: share,
      toleranceFrom: z.enum(['ORDER_LINE', 'DEFAULT']),
      hides: z.array(
        output({
          hide: output({ id: id(), code: z.string(), state: z.enum(HIDE_STATES) }),
          measured: z.boolean(),
          /** Null until measured. */
          declared: area.nullable(),
          measuredArea: area.nullable(),
          difference: area.nullable(),
          differencePercent: z.string().nullable(),
          outcome: z.enum(AREA_OUTCOMES).nullable(),
          measuredAt: instant().nullable(),
        }),
      ),
      counts: output({ hides: z.number().int(), measured: z.number().int(), notMeasured: z.number().int() }),
      /** The measured hides together (areas, not money); null: none measured yet. */
      total: notMoney(output({ declared: area, measured: area, difference: area, differencePercent: z.string(), outcome: z.enum(AREA_OUTCOMES) }).nullable()),
      claim: output({
        /** Short beyond the tolerance: a claim to the supplier is in order. */
        opens: z.boolean(),
        words: words,
        /** The body of POST /purchasing/claims (purchasing.claims.manage) that claims the shortfall; null: no claim in order. */
        prefill: output({
          kind: z.literal('CLAIM'),
          siteId: id(),
          /** The claim list's SHORT_DELIVERY when the tenant keeps it active; null: the person picks the reason. */
          reasonCode: z.string().nullable(),
          reasonNote: z.string(),
          lines: z.array(output({ lotId: id(), hideId: id(), quantity: area, uom: z.enum(UOMS), reason: z.string() })),
        }).nullable(),
        /** Claims that name the lot already (purchasing.view); empty without it. */
        existing: z.array(output({ id: id(), number: z.string(), status: z.string() })),
      }),
    }),
  },
})

// ---- grade mix and usable area, hides beside area (SCM-250, SCM-258) ----------------------------------------------------

const mixFigures = {
  hides: z.number().int(),
  /** Σ measured area (as received), base unit. */
  measured: area,
  /** Σ what the site's ledger holds of them now, base unit. */
  left: area,
}

export const gradeMixContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    itemId: id().optional(),
    itemColourId: id().optional(),
    lotId: id().optional(),
    /** article (default): per article and colour, what planning reads; lot: the grade mix of each lot as delivered. */
    groupBy: z.enum(['article', 'lot']).optional(),
    /** Default true: the hides in stock (full, partly cut, remnant); false: every hide, used ones too. */
    inStock: flag().optional(),
  }),
  response: {
    200: output({
      groupBy: z.enum(['article', 'lot']),
      groups: z.array(
        output({
          item: output({ id: id(), code: z.string(), name: z.string() }),
          colour: named.nullable(),
          lot: output({ id: id(), code: z.string(), dyeBatch: z.string().nullable(), receivedAt: instant().nullable() }).nullable(),
          uom: areaUom,
          ...mixFigures,
          /** Σ usable area of the graded hides (of what is left). */
          usable: area,
          /** What is left of the ungraded hides: its usable area is unknown. */
          ungradedLeft: area,
          /** The two numbers in words, of what is left: "37 hides · 412.50 m² (4,440.3 ft²)". */
          words: words,
          grades: z.array(
            output({
              /** Null: the ungraded hides. */
              grade: gradeRef.nullable(),
              /** The W1 texts of the ungraded hides. */
              texts: z.array(z.string()),
              ...mixFigures,
              /** Graded by their W1 text only (no record yet). */
              byText: z.number().int(),
              share: share.nullable(),
              source: z.enum(SHARE_SOURCES).nullable(),
              usable: area.nullable(),
              percentOfArea: z.string(),
            }),
          ),
          /** Tagged offcuts in stock (Remnant IN_STOCK): pieces beside their area. */
          remnants: output({ pieces: z.number().int(), area }),
        }),
      ),
      /** Per base unit, every group together (hides and areas, not money). */
      totals: notMoney(z.array(output({ uom: areaUom, ...mixFigures, usable: area, ungradedLeft: area, remnants: output({ pieces: z.number().int(), area }), words: words }))),
    }),
  },
})
