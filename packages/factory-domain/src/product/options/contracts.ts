import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { money, notMoney } from '../../money/marked'
import { BOM_SECTIONS } from '../bom-structure/rules'
import { localisedNames } from '../materials/contracts'
import { MASTER_STATUSES } from '../sizes/rules'
import { REVISION_STATUSES } from '../styles/revisions'
import { STYLE_STATUSES } from '../styles/rules'
import { UOMS } from '../units/units'
import { CHECK_CODES, OPTION_EFFECT_KINDS, OPTION_GROUP_KINDS, OPTION_LIMITS, OPTION_RULE_KINDS, OPTION_RULE_SEVERITIES, PART_EFFECT_KINDS } from './rules'

/**
 * Options and configuration rules (B-W2b-229; PRD-081, PRD-206, PRD-207, PRD-208, PRD-211; design products.options, SCR-114):
 * what apps/factory-api's modules/product/options accepts and answers, and what B-W2b-242's Options & rules screen and W2b-5's
 * configurator read.
 *
 * Versions: a group's own fields, its archive and its rules (saved as a set, the Rules tab's EditModeBar) send the GROUP's
 * version; a value's fields, archive, effects and price send the VALUE's version (the effects are its parts); a style's
 * offer of a group sends the offer's version (null: the style does not offer the group yet); a draft BOM line's option the
 * REVISION's version (W1).
 *
 * Money (A1 §3.11): only a value's price surcharge (`priceDelta`, `pricePct`, the check's `price`) is money, marked
 * money.price: dropped from the answer of a caller without the price grain, refused in a request without it. No cost here
 * (the cost delta of an option is W2b-6's, FIN-018). Decimals travel as plain decimal strings ("5.5", "-25").
 */

const version = () => z.number().int().min(1)
const text = (max: number) => z.string().trim().min(1).max(max)
const code = () => z.string().trim().min(1).max(OPTION_LIMITS.code).regex(/^\S+$/, { message: 'A code has no spaces.' })
const words = () => output({ it: z.string(), en: z.string() })
const decimal = () => z.string().trim().regex(/^-?\d+(\.\d+)?$/, { message: 'A plain decimal ("5.5", "-25").' })
const ref = output({ id: id(), code: z.string(), name: z.string() })
const names = () => z.record(z.string(), z.string()).nullable()
/** Words per language the person typed ({ "it": "…", "en": "…" }); left out or null: none. */
const message = () => z.partialRecord(z.enum(['it', 'en']), text(OPTION_LIMITS.message)).nullish()

export const groupParams = input({ groupId: id() })
export const valueParams = input({ groupId: id(), valueId: id() })
export const effectParams = input({ groupId: id(), valueId: id(), effectId: id() })
export const styleParams = input({ styleId: id() })
export const offerParams = input({ styleId: id(), groupId: id() })
export const lineParams = input({ styleId: id(), revisionId: id(), lineId: id() })

// ---- groups (PRD-206) -----------------------------------------------------------------------------------------------------

export const listGroupsQuery = input({
  /** ACTIVE (default), ARCHIVED or ALL. */
  status: z.enum([...MASTER_STATUSES, 'ALL']).default('ACTIVE'),
  /** The groups a style of this company may offer (its own and the tenant-wide ones). */
  companyId: id().optional(),
  kind: z.enum(OPTION_GROUP_KINDS).optional(),
  /** Code, name or a value's code or name. */
  q: z.string().trim().min(1).max(100).optional(),
  /** The tile "Options that take a garment outside its certificate": groups with such a value. */
  outsideCertificate: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
})
export type ListGroupsQuery = z.output<typeof listGroupsQuery>

const picksIn = { minPicks: z.number().int().min(0).max(OPTION_LIMITS.picks), maxPicks: z.number().int().min(1).max(OPTION_LIMITS.picks).nullable() }

export const createGroupBody = input({
  /** Left out or null: tenant-wide (every company's styles may offer it). */
  companyId: id().nullish(),
  code: code(),
  name: text(OPTION_LIMITS.name),
  nameI18n: localisedNames().nullish(),
  description: text(OPTION_LIMITS.description).nullish(),
  kind: z.enum(OPTION_GROUP_KINDS),
  /** Left out: a single choice 0 to 1, the others 0 to any. */
  minPicks: picksIn.minPicks.optional(),
  maxPicks: picksIn.maxPicks.optional(),
})
export type CreateGroupBody = z.output<typeof createGroupBody>

/** A change: only the fields sent change (null clears an optional one). The company never changes. */
export const updateGroupBody = input({
  version: version(),
  code: code().optional(),
  name: text(OPTION_LIMITS.name).optional(),
  nameI18n: localisedNames().nullish(),
  description: text(OPTION_LIMITS.description).nullish(),
  kind: z.enum(OPTION_GROUP_KINDS).optional(),
  minPicks: picksIn.minPicks.optional(),
  maxPicks: picksIn.maxPicks.optional(),
})
export type UpdateGroupBody = z.output<typeof updateGroupBody>

export const statusBody = input({ version: version(), reason: text(500).optional() })
export type StatusBody = z.output<typeof statusBody>

export const groupRowView = output({
  id: id(),
  code: z.string(),
  name: z.string(),
  nameI18n: names(),
  description: z.string().nullable(),
  companyId: id().nullable(),
  kind: z.enum(OPTION_GROUP_KINDS),
  minPicks: z.number().int(),
  maxPicks: z.number().int().nullable(),
  /** "0–1", "1–any". */
  picks: words(),
  /** Active values. */
  values: z.number().int(),
  /** Styles that offer it (active offers). */
  styles: z.number().int(),
  /** Active rules. */
  rules: z.number().int(),
  /** Active values that take the garment outside its certificate. */
  outsideCertificate: z.number().int(),
  status: z.enum(MASTER_STATUSES),
  version: z.number().int(),
  updatedAt: instant(),
})
export type GroupRowView = z.infer<typeof groupRowView>

export const groupListView = output({
  groups: z.array(groupRowView),
  /** The tiles: every group of the filter, and those with a value outside the certificate (each the list's total under it). */
  counts: output({ all: z.number().int(), outsideCertificate: z.number().int() }),
})
export type GroupListView = z.infer<typeof groupListView>

// ---- values (PRD-206, PRD-211) --------------------------------------------------------------------------------------------

const freeTextFields = {
  /** The customer types a text with it (a name to embroider): then a maximum length, maybe a pattern. */
  freeText: z.boolean(),
  freeTextMaxLength: z.number().int().min(1).max(OPTION_LIMITS.freeTextLength).nullable(),
  /** A regular expression the text must match, found anywhere in it (anchor it with ^ and $). */
  freeTextPattern: z.string().min(1).max(OPTION_LIMITS.pattern).nullable(),
}

export const createValueBody = input({
  code: code(),
  name: text(OPTION_LIMITS.name),
  nameI18n: localisedNames().nullish(),
  /** Its place in the group's list; left out: after the last. */
  seq: z.number().int().min(0).max(100_000).optional(),
  freeText: freeTextFields.freeText.optional(),
  freeTextMaxLength: freeTextFields.freeTextMaxLength.optional(),
  freeTextPattern: freeTextFields.freeTextPattern.optional(),
})
export type CreateValueBody = z.output<typeof createValueBody>

export const updateValueBody = input({
  version: version(),
  code: code().optional(),
  name: text(OPTION_LIMITS.name).optional(),
  nameI18n: localisedNames().nullish(),
  seq: z.number().int().min(0).max(100_000).optional(),
  freeText: freeTextFields.freeText.optional(),
  freeTextMaxLength: freeTextFields.freeTextMaxLength.optional(),
  freeTextPattern: freeTextFields.freeTextPattern.optional(),
})
export type UpdateValueBody = z.output<typeof updateValueBody>

export const valueView = output({
  id: id(),
  groupId: id(),
  code: z.string(),
  name: z.string(),
  nameI18n: names(),
  seq: z.number().int(),
  ...freeTextFields,
  /** It has a CERTIFICATE effect: the garment is no longer the one its certificate covers. */
  outsideCertificate: z.boolean(),
  /** Its effects (the price surcharge included). */
  effects: z.number().int(),
  /** The styles' draft and released BOM lines and routing steps only for it. */
  usedBy: output({ lines: z.number().int(), steps: z.number().int() }),
  status: z.enum(MASTER_STATUSES),
  version: z.number().int(),
  updatedAt: instant(),
})
export type ValueView = z.infer<typeof valueView>

// ---- rules (PRD-207), shaped for the design system's RuleBuilder ----------------------------------------------------------

/** One condition row of the RuleBuilder: field `option`, operator `eq`, the value id or `*` (any option of the group). */
export const ruleRow = output({
  id: z.string().min(1).max(60),
  field: z.string().nullable(),
  operator: z.string().nullable(),
  value: z.union([z.string(), z.array(z.string())]).nullable(),
})
export const ruleDraft = output({ combinator: z.enum(['and', 'or']), rows: z.array(ruleRow).max(10) })

export const ruleInput = input({
  /** A rule saved before (left out: a new one). */
  id: id().optional(),
  /** The subject as the RuleBuilder draft: one row "the option is <value>" (`*`: any option of the group). */
  when: input({ combinator: z.enum(['and', 'or']).default('and'), rows: z.array(input({ id: z.string().min(1).max(60), field: z.string().nullable(), operator: z.string().nullable(), value: z.union([z.string(), z.array(z.string())]).nullable() })).max(10) }),
  kind: z.enum(OPTION_RULE_KINDS),
  otherValueId: id(),
  severity: z.enum(OPTION_RULE_SEVERITIES),
  /** What the person reads when it is broken; null: the API's words; left out: a saved rule keeps its own (a new one: none). */
  message: message(),
  /** ARCHIVED: kept, switched off. Left out: a saved rule keeps its status, a new one is ACTIVE. */
  status: z.enum(MASTER_STATUSES).optional(),
})
export type RuleInput = z.output<typeof ruleInput>

/** A group's rules as a set: the rules left out are removed. */
export const rulesBody = input({ version: version(), rules: z.array(ruleInput).max(OPTION_LIMITS.rules) })
export type RulesBody = z.output<typeof rulesBody>

const valueRef = output({ id: id(), code: z.string(), name: z.string(), nameI18n: names(), groupId: id(), groupCode: z.string(), groupName: z.string(), status: z.enum(MASTER_STATUSES) })

export const ruleView = output({
  id: id(),
  valueId: id().nullable(),
  /** The subject as the RuleBuilder draws it. */
  when: ruleDraft,
  kind: z.enum(OPTION_RULE_KINDS),
  otherValueId: id(),
  other: valueRef,
  severity: z.enum(OPTION_RULE_SEVERITIES),
  messageI18n: names(),
  /** The preview: "Full perforation excludes Thermal liner — block". */
  words: words(),
  /** What the person reads when it is broken (its message, else the API's words). */
  broken: words(),
  status: z.enum(MASTER_STATUSES),
  version: z.number().int(),
})
export type RuleView = z.infer<typeof ruleView>

/** What the RuleBuilder's `option` field may pick: any option of the group, then its values. */
export const subjectOption = output({ value: z.string(), code: z.string().nullable(), words: words(), status: z.enum(MASTER_STATUSES) })

// ---- effects (PRD-208, PRD-081) -------------------------------------------------------------------------------------------

const effectFields = {
  itemId: id().nullish(),
  itemColourId: id().nullish(),
  targetItemId: id().nullish(),
  qty: decimal().nullish(),
  uom: z.enum(UOMS).nullish(),
  /** BOM_ADD: { "50": "1.2", "52": "1.3" } (sizes of the style's range when used); a size without one takes qty. */
  sizeQuantities: z.record(z.string(), decimal()).nullish(),
  section: z.enum(BOM_SECTIONS).nullish(),
  operationId: id().nullish(),
  minutes: decimal().nullish(),
  note: text(OPTION_LIMITS.note).nullish(),
}

/** A new effect of a value (not its price: that is …/price). */
export const createEffectBody = input({ version: version(), kind: z.enum(PART_EFFECT_KINDS), ...effectFields })
export type CreateEffectBody = z.output<typeof createEffectBody>

/** A change: only the fields sent change (null clears one). The kind never changes (another kind is another effect). */
export const updateEffectBody = input({ version: version(), ...effectFields })
export type UpdateEffectBody = z.output<typeof updateEffectBody>

/** An effect out: the VALUE's version in the query. */
export const removeEffectQuery = input({ version: z.coerce.number().int().min(1) })
export type RemoveEffectQuery = z.output<typeof removeEffectQuery>

/** The value's price surcharge: an amount in a currency, or a percent of the price; neither: no surcharge. */
export const priceBody = input({
  version: version(),
  priceDelta: money.price(decimal()),
  currency: z.string().trim().regex(/^[A-Z]{3}$/, { message: 'ISO 4217: EUR.' }).nullish(),
  pricePct: money.price(decimal()),
})
export type PriceBody = z.output<typeof priceBody>

export const effectView = output({
  id: id(),
  valueId: id(),
  kind: z.enum(OPTION_EFFECT_KINDS),
  item: ref.nullable(),
  itemColourId: id().nullable(),
  targetItem: ref.nullable(),
  qty: z.string().nullable(),
  uom: z.enum(UOMS).nullable(),
  sizeQuantities: z.record(z.string(), z.string()).nullable(),
  section: z.enum(BOM_SECTIONS).nullable(),
  operation: ref.nullable(),
  minutes: z.string().nullable(),
  priceDelta: money.price(z.string().nullable()),
  currency: z.string().nullable(),
  pricePct: money.price(z.string().nullable()),
  note: z.string().nullable(),
  /** "Adds SEED-THR-530 5 m · THREAD"; a price effect says no amount here. */
  words: words(),
  updatedAt: instant(),
})
export type EffectView = z.infer<typeof effectView>

// ---- the group's record ---------------------------------------------------------------------------------------------------

export const offerOfGroupView = output({
  id: id(),
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), status: z.enum(STYLE_STATUSES) }),
  seq: z.number().int(),
  minPicks: z.number().int().nullable(),
  maxPicks: z.number().int().nullable(),
  /** What the style asks in the end (its own, else the group's). */
  picks: words(),
  defaultValueId: id().nullable(),
  status: z.enum(MASTER_STATUSES),
  version: z.number().int(),
})

export const groupView = output({
  ...groupRowView.shape,
  values: z.array(valueView),
  rules: z.array(ruleView),
  effects: z.array(effectView),
  styles: z.array(offerOfGroupView),
  /** The RuleBuilder's `option` field. */
  subjectOptions: z.array(subjectOption),
  /** Counts as the list has them. */
  counts: output({ values: z.number().int(), styles: z.number().int(), rules: z.number().int(), outsideCertificate: z.number().int() }),
  /** manage: the library's writes; price: whether the caller may set price surcharges here (a right, not an amount). */
  may: output({ manage: z.boolean(), price: notMoney(z.boolean()) }),
})
export type GroupView = z.infer<typeof groupView>

// ---- a style's offers (PRD-206) and its option lines and steps (PRD-081, PRD-128) -----------------------------------------

/** Offer a group on a style, or change the offer. `version` = the ACTIVE offer's (null: the style does not offer it yet). */
export const offerBody = input({
  version: version().nullable(),
  seq: z.number().int().min(0).max(1000).optional(),
  minPicks: z.number().int().min(0).max(OPTION_LIMITS.picks).nullish(),
  maxPicks: z.number().int().min(1).max(OPTION_LIMITS.picks).nullish(),
  defaultValueId: id().nullish(),
})
export type OfferBody = z.output<typeof offerBody>

export const withdrawBody = input({ version: version() })
export type WithdrawBody = z.output<typeof withdrawBody>

export const offerView = output({
  id: id(),
  group: output({ id: id(), code: z.string(), name: z.string(), nameI18n: names(), kind: z.enum(OPTION_GROUP_KINDS), minPicks: z.number().int(), maxPicks: z.number().int().nullable(), status: z.enum(MASTER_STATUSES) }),
  seq: z.number().int(),
  minPicks: z.number().int().nullable(),
  maxPicks: z.number().int().nullable(),
  effective: output({ minPicks: z.number().int(), maxPicks: z.number().int().nullable() }),
  picks: words(),
  defaultValueId: id().nullable(),
  values: z.array(output({ id: id(), code: z.string(), name: z.string(), nameI18n: names(), seq: z.number().int(), freeText: z.boolean(), outsideCertificate: z.boolean(), status: z.enum(MASTER_STATUSES) })),
  status: z.enum(MASTER_STATUSES),
  version: z.number().int(),
  updatedAt: instant(),
})
export type OfferView = z.infer<typeof offerView>

const revisionRef = output({ id: id(), revision: z.number().int(), status: z.enum(REVISION_STATUSES) })

export const styleOptionsView = output({
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), status: z.enum(STYLE_STATUSES) }),
  /** Active offers in the configurator's order, then the archived ones. */
  offers: z.array(offerView),
  /** The BOM lines only for an option, of every revision (the newest first). */
  lines: z.array(output({ revision: revisionRef, lineId: id(), seq: z.number().int(), item: ref, optionValueId: id(), option: z.string() })),
  /** The routing steps only for some options, of every revision. */
  steps: z.array(output({ revision: revisionRef, stepId: id(), seq: z.number().int(), code: z.string(), name: z.string(), optionValueIds: z.array(id()), options: z.array(z.string()) })),
  /** The caller may change the style's offers (product.styles.manage, the style not archived); the edit rule is asked at the write. */
  editable: z.boolean(),
})
export type StyleOptionsView = z.infer<typeof styleOptionsView>

export const withdrawnView = output({ withdrawn: z.enum(['REMOVED', 'ARCHIVED']), words: words(), options: styleOptionsView })

/** A draft BOM line only for one option (PRD-081), or for every garment again (null). */
export const lineOptionBody = input({ version: version(), optionValueId: id().nullable() })
export type LineOptionBody = z.output<typeof lineOptionBody>

export const lineOptionView = output({
  line: output({ id: id(), seq: z.number().int(), item: ref, optionValueId: id().nullable(), option: z.string().nullable() }),
  revision: output({ id: id(), revision: z.number().int(), version: z.number().int() }),
})
export type LineOptionView = z.infer<typeof lineOptionView>

// ---- THE check (PRD-207), for W2b-5's configurator ------------------------------------------------------------------------

export const checkBody = input({
  picks: z.array(input({ valueId: id(), text: z.string().max(OPTION_LIMITS.freeTextLength * 2).nullish() })).max(OPTION_LIMITS.values),
  /** The revision whose BOM the changes are read on; left out: the style's draft, else its released revision. */
  revisionId: id().optional(),
  /** A group nothing was chosen of takes the style's default (default true). */
  useDefaults: z.boolean().default(true),
})
export type CheckBody = z.output<typeof checkBody>

const finding = output({ code: z.enum(CHECK_CODES), severity: z.enum(OPTION_RULE_SEVERITIES), path: z.string(), groupId: id().nullable(), valueId: id().nullable(), ruleId: id().nullable(), message: words() })

const effectRef = output({ effectId: id(), valueId: id(), kind: z.enum(OPTION_EFFECT_KINDS), words: words() })

export const checkView = output({
  style: output({ id: id(), code: z.string() }),
  /** No BLOCK: the configuration may be taken once its warnings are read. */
  ok: z.boolean(),
  blocks: z.array(finding),
  warnings: z.array(finding),
  chosen: z.array(output({ valueId: id(), groupId: id(), code: z.string(), groupCode: z.string(), text: z.string().nullable(), byDefault: z.boolean() })),
  effects: output({
    bom: z.array(effectRef),
    operations: z.array(effectRef),
    minutes: z.array(effectRef),
    /** Minutes added up (an operation at its standard minutes is counted in operationsAtStandard). */
    minutesAdded: z.string(),
    operationsAtStandard: z.number().int(),
    /** The surcharges: amounts per currency and the percents, each added up (percents never compound). */
    price: money.price(output({ byCurrency: z.array(output({ currency: z.string(), delta: z.string() })), percent: z.string().nullable() }).nullable()),
    outsideCertificate: z.boolean(),
    certificateNotes: z.array(output({ valueId: id(), note: z.string() })),
  }),
  /** What the choice does to the revision's lines (null: the style has no draft or released revision). */
  bom: output({
    revision: revisionRef,
    optionLinesTaken: z.array(id()),
    optionLinesLeftOut: z.array(id()),
    removed: z.array(output({ lineId: id(), seq: z.number().int(), effectId: id() })),
    replaced: z.array(output({ lineId: id(), seq: z.number().int(), effectId: id(), item: ref })),
    added: z.array(effectRef),
    /** Two options changing the same material, an effect whose material no line takes, a material put in twice. */
    notes: z.array(words()),
  }).nullable(),
})
export type CheckView = z.infer<typeof checkView>
