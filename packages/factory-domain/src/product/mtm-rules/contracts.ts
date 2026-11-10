import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { ALTERATION_OUTCOMES, FINDING_KINDS, MTM_LIMITS, RULE_KINDS, RULE_OUTCOMES, RULE_SEVERITIES, RULE_STATUSES, TIES } from './rules'

/**
 * Made-to-measure rules' contracts (B-W2b-248; PRD-017, PRD-201 … PRD-204): what apps/factory-api's modules/product/mtm-rules
 * accepts and answers. No money: quantities and measures travel as plain decimal strings ("45.5") in their unit. A
 * template's writes send the TEMPLATE's `version`; marking a BOM line sends the REVISION's (as every BOM write).
 */

const version = () => z.number().int().min(1)
const code = () => z.string().trim().min(1).max(60)
const decimal = () => z.string().trim().max(12)
const words = () => z.record(z.string().max(16), z.string().max(MTM_LIMITS.message))
const nameWords = z.record(z.string(), z.string()).nullable()

// ---- the template's rules ---------------------------------------------------------------------------------------------

export const ruleBody = input({
  /** Unique in the template, no spaces ("INSEAM_LE_OUTSEAM"): a rule keeps its id while its code stays. */
  code: code(),
  kind: z.enum(RULE_KINDS),
  pointCode: code(),
  /** ORDER and RATIO: the point it is compared with; RANGE: none. */
  otherPointCode: code().nullish(),
  /** RATIO: the bounds of point ÷ other point (at least one). */
  minFactor: decimal().nullish(),
  maxFactor: decimal().nullish(),
  /** RANGE: the bounds of the point's measure, in its unit (at least one). */
  minValue: decimal().nullish(),
  maxValue: decimal().nullish(),
  severity: z.enum(RULE_SEVERITIES),
  /** What is wrong, per language: {"it": "…", "en": "…"}. */
  messageI18n: words(),
  /** ARCHIVED: kept, not checked. */
  status: z.enum(RULE_STATUSES).default('ACTIVE'),
})
export type RuleBody = z.output<typeof ruleBody>

/**
 * The template's made-to-measure rules saved whole (PUT): every rule (kept by its code, changed, added; the ones left out
 * removed), the base size rule (null: none), and the limits of the points named (the others keep theirs).
 */
export const putRulesBody = input({
  version: version(),
  baseSizeRule: input({ points: z.array(code()).min(1).max(MTM_LIMITS.baseSizePoints), tie: z.enum(TIES).default('LARGER') }).nullable(),
  points: z
    .array(
      input({
        code: code(),
        /** The inspection tolerance of a made-to-measure garment at this point, plus and minus (B-W2b-97), in its unit. */
        tolerance: decimal().nullable(),
        /** How far under and over the base size's measure a unit may be before a pattern maker reviews it (PRD-203). */
        alterationMinus: decimal().nullable(),
        alterationPlus: decimal().nullable(),
      }),
    )
    .max(MTM_LIMITS.points)
    .default([]),
  rules: z.array(ruleBody).max(MTM_LIMITS.rules),
})
export type PutRulesBody = z.output<typeof putRulesBody>

/** The rules on or off (GATE-MTM: the Owner's word, product.mtm.switch). */
export const switchRulesBody = input({ version: version(), on: z.boolean(), reason: z.string().trim().max(MTM_LIMITS.reason).nullish() })
export type SwitchRulesBody = z.output<typeof switchRulesBody>

const templatePointView = output({
  id: id(),
  code: z.string(),
  name: z.string(),
  nameI18n: nameWords,
  seq: z.number().int(),
  uom: z.string(),
  required: z.boolean(),
  minValue: z.string().nullable(),
  maxValue: z.string().nullable(),
  tolerance: z.string().nullable(),
  alterationMinus: z.string().nullable(),
  alterationPlus: z.string().nullable(),
  status: z.string(),
  /** The library's body point it is (B-W2b-224), with its zone. */
  pointOfMeasure: output({ id: id(), code: z.string(), bodyZone: z.string() }).nullable(),
})

export const mtmRuleView = output({
  id: id(),
  code: z.string(),
  kind: z.enum(RULE_KINDS),
  pointCode: z.string(),
  otherPointCode: z.string().nullable(),
  minFactor: z.string().nullable(),
  maxFactor: z.string().nullable(),
  minValue: z.string().nullable(),
  maxValue: z.string().nullable(),
  severity: z.enum(RULE_SEVERITIES),
  messageI18n: z.record(z.string(), z.string()),
  status: z.enum(RULE_STATUSES),
})

export const templateRulesView = output({
  template: output({
    id: id(),
    companyId: id().nullable(),
    code: z.string(),
    name: z.string(),
    nameI18n: nameWords,
    productType: z.string(),
    status: z.string(),
    rulesOn: z.boolean(),
    baseSizeRule: output({ points: z.array(z.string()), tie: z.enum(TIES) }).nullable(),
    version: z.number().int(),
    updatedAt: instant(),
  }),
  points: z.array(templatePointView),
  rules: z.array(mtmRuleView),
  /** The styles measured with it, and how many of them are made to measure. */
  styles: output({ measured: z.number().int(), madeToMeasure: z.number().int() }),
  /** "On · 2 rules (1 blocking) · base size from chest · alteration limits on 3 points". */
  summary: z.string(),
  /** The caller may keep the rules (product.styles.manage over the template's company, the template active); else why not. */
  editable: z.boolean(),
  refusal: z.string().nullable(),
  /** The caller may turn them on or off (product.mtm.switch). */
  switchable: z.boolean(),
})
export type TemplateRulesView = z.output<typeof templateRulesView>

// ---- the check --------------------------------------------------------------------------------------------------------

const measureEntry = input({ value: z.string().trim().max(12), unit: z.string().trim().min(1).max(10) })

/**
 * One check of a measurement set (PRD-017, PRD-201 … PRD-204): against a style (its template, sizes, BOM and certificate)
 * or a template alone; the measures of a rider's profile revision or typed ({"chest": {"value": "100", "unit": "cm"}}).
 */
export const mtmCheckBody = input({
  styleId: id().optional(),
  templateId: id().optional(),
  measurementProfileId: id().optional(),
  measurements: z.record(code(), measureEntry).optional(),
  /** A base size typed (a size of the style's range); left out: the one the measures suggest (rules on). */
  baseSize: z.string().trim().min(1).max(40).optional(),
  /** The colourway the certificate is asked for; left out: the certificate is not asked. */
  colourwayId: id().optional(),
  /** The revision whose BOM is scaled; left out: the released one, else the newest draft. */
  revisionId: id().optional(),
  /** The day the certificate is asked for (Europe/Rome); left out: today. */
  date: businessDate().optional(),
})
export type MtmCheckBody = z.output<typeof mtmCheckBody>

const finding = output({ kind: z.enum(FINDING_KINDS), ref: z.string().nullable(), message: z.string(), words: z.record(z.string(), z.string()).nullable() })

export const mtmCheckView = output({
  template: output({ id: id(), code: z.string(), name: z.string(), rulesOn: z.boolean() }),
  style: output({ id: id(), code: z.string(), mtmAllowed: z.boolean(), revision: output({ id: id(), revision: z.number().int(), status: z.string() }).nullable() }).nullable(),
  profile: output({ id: id(), revision: z.number().int(), garmentType: z.string() }).nullable(),
  verdict: z.enum(['OK', 'WARN', 'BLOCK']),
  rulesOn: z.boolean(),
  rules: z.array(
    output({
      code: z.string(),
      kind: z.enum(RULE_KINDS),
      severity: z.enum(RULE_SEVERITIES),
      outcome: z.enum(RULE_OUTCOMES),
      pointCode: z.string(),
      otherPointCode: z.string().nullable(),
      value: z.string().nullable(),
      otherValue: z.string().nullable(),
      ratio: z.string().nullable(),
      words: z.record(z.string(), z.string()),
      detail: z.string(),
    }),
  ),
  baseSize: output({
    size: z.string().nullable(),
    how: z.enum(['INSIDE', 'NEAREST']).nullable(),
    tie: z.boolean(),
    points: z.array(output({ code: z.string(), value: z.string().nullable(), range: output({ min: z.string(), max: z.string() }).nullable(), distance: z.string().nullable() })),
    detail: z.string(),
    /** The base size the alterations and the consumption are read against: the typed one, else the suggested one. */
    used: z.string().nullable(),
    typed: z.string().nullable(),
  }),
  alterations: z.array(
    output({
      code: z.string(),
      uom: z.string(),
      outcome: z.enum(ALTERATION_OUTCOMES),
      value: z.string().nullable(),
      base: z.string().nullable(),
      difference: z.string().nullable(),
      alterationMinus: z.string().nullable(),
      alterationPlus: z.string().nullable(),
      detail: z.string(),
    }),
  ),
  consumption: z
    .array(
      output({
        lineId: id(),
        seq: z.number().int(),
        item: output({ id: id(), code: z.string(), name: z.string() }),
        placement: z.string().nullable(),
        uom: z.string(),
        wastagePct: z.string(),
        baseQty: z.string().nullable(),
        unitQty: z.string().nullable(),
        scaled: output({ pointCode: z.string(), factor: z.string(), value: z.string(), base: z.string() }).nullable(),
        detail: z.string(),
      }),
    )
    .nullable(),
  /** The caller does not hold product.bom.view: the consumption is not shown. */
  consumptionHidden: z.boolean(),
  certificate: output({
    allowed: z.boolean(),
    outcome: z.string(),
    certificateNumber: z.string().nullable(),
    message: z.string().nullable(),
    reasons: z.array(output({ code: z.string(), message: z.string(), point: z.string().optional() })),
  }).nullable(),
  insideCertifiedRange: z.boolean().nullable(),
  blocks: z.array(finding),
  warnings: z.array(finding),
  notes: z.array(z.string()),
})
export type MtmCheckView = z.output<typeof mtmCheckView>

// ---- a BOM line marked to scale (PRD-204) ------------------------------------------------------------------------------

/** A draft revision's BOM line marked to scale with a point of the style's template and its factor (both, or neither). */
export const bomLineScaleBody = input({
  /** The revision's version, as every BOM write. */
  version: version(),
  pointCode: code().nullable(),
  /** The share of the quantity that follows the point: above 0, at most 10 ("1", "0.8"). */
  factor: decimal().nullable(),
})
export type BomLineScaleBody = z.output<typeof bomLineScaleBody>

export const bomLineScaleView = output({
  line: output({ id: id(), seq: z.number().int(), scale: output({ pointId: id(), pointCode: z.string(), factor: z.string() }).nullable() }),
  revision: output({ id: id(), version: z.number().int() }),
})
export type BomLineScaleView = z.output<typeof bomLineScaleView>
