import { Decimal } from 'decimal.js'
import type { CompositionPart } from '../labels/rules'
import { baseFactor, decimalText, fixedRatio, type ItemUnits, type Uom } from '../../product/units/units'
import { normalisedWords, readFibre } from './fibres'

/**
 * The fibre composition of a garment computed from its BOM (B-W2b-208; PRD-338, PRD-340; Reg. (EU) 1007/2011 arts. 2, 9,
 * 11, 12; W1 types the composition once in the label template, B-W1-19). Pure: the API reads a style revision's BOM lines
 * and their materials and hands them here.
 *
 * Parts. A label gives the composition per part (art. 11: each component with its own fibres). Until the BOM has sections
 * (B-W2b-211, BomLine.section), a line's part follows its material's kind: TEXTILE is the outer fabric, LINING the lining,
 * PADDING the padding, a MEMBRANE with fibres the membrane. Thread, trims, labels, hardware and protectors are not parts
 * (Annex VI leaves labels, trimmings and accessories out of the composition), but a thread or trim with fibres weighs as
 * textile in the 80 % check. Leather and other materials without fibres are non-textile parts. Packaging is not part of
 * the garment.
 *
 * Weights. A part made of one composition needs no weight. A part that mixes materials of different compositions is
 * computed by weight (each material's fibres × its weight in the garment); so is the textile share of the whole garment.
 * A line's weight is its quantity per garment (the size asked, wastage left out: it is cut away) in grams: from its unit
 * when that is a mass (KG, G) or converts to one through the material's units, else from the material's `weight`
 * attribute ("180 g/m2", "45 g/m", "120 g/pcs"; "120 g" = per one base unit). The typed weight per material is B-W2b-206's
 * Item.properties; until then the attribute is read, and a line without one is named, never guessed.
 *
 * The 80 % check (art. 2(2)(a)): a product with at least 80 % textile fibres by weight is a textile product. The garment's
 * weight is its net mass when the style has one on record (Style.netMassKg, the customs field), else the sum of its
 * lines' weights.
 */

export const COMPONENTS = ['SHELL', 'LINING', 'PADDING', 'MEMBRANE'] as const
export type Component = (typeof COMPONENTS)[number]

/** A part's words in the languages the factory prints first, and the words people type for it on a label. */
export const COMPONENT_WORDS: Readonly<Record<Component, { readonly en: string; readonly it: string; readonly typed: readonly string[] }>> = Object.freeze({
  SHELL: { en: 'outer fabric', it: 'tessuto esterno', typed: ['shell', 'outer', 'outer shell', 'outer fabric', 'main fabric', 'esterno', 'tessuto esterno', 'tessuto principale'] },
  LINING: { en: 'lining', it: 'fodera', typed: ['lining', 'fodera'] },
  PADDING: { en: 'padding', it: 'imbottitura', typed: ['padding', 'imbottitura', 'insulation', 'wadding', 'ovatta', 'filling'] },
  MEMBRANE: { en: 'membrane', it: 'membrana', typed: ['membrane', 'membrana', 'laminate'] },
})

const COMPONENT_OF_KIND: Readonly<Record<string, Component>> = Object.freeze({ TEXTILE: 'SHELL', LINING: 'LINING', PADDING: 'PADDING', MEMBRANE: 'MEMBRANE' })
/** Kinds that are textile whatever they hold: a line of one without fibres is a problem. */
const TEXTILE_KINDS = new Set(['TEXTILE', 'LINING', 'PADDING'])

/** What a BOM line is to the label. */
export type LineRole = 'PART' | 'OTHER_TEXTILE' | 'NON_TEXTILE' | 'NOT_IN_GARMENT'

export interface FibreShare {
  readonly fibre: string
  readonly percent: string
}

/** A material as the composition reads it (factory-db Item). */
export interface MaterialFacts {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly kind: string
  /** Item.composition as stored: [{ fibre, percent }] (W1 checks it adds up to 100). */
  readonly composition: unknown
  readonly animalOrigin: boolean
  readonly attributes: Readonly<Record<string, string>> | null
  readonly units: ItemUnits
}

/** A BOM line in the size asked: its quantity per garment (null: the line is not used in that size). */
export interface LineFacts {
  readonly seq: number
  readonly placement: string | null
  readonly qty: string | null
  readonly uom: Uom
  readonly material: MaterialFacts
}

export type Severity = 'FAIL' | 'WARN'
export interface Finding {
  readonly path: string
  readonly message: string
  readonly severity: Severity
}

// ---- a material's fibres and weight -------------------------------------------------------------------------------------------

/** The material's fibres as stored; an unreadable list counts as none. */
export function fibresOf(material: Pick<MaterialFacts, 'composition'>): FibreShare[] {
  const value = material.composition
  if (!Array.isArray(value)) return []
  const fibres: FibreShare[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return []
    const { fibre, percent } = entry as Record<string, unknown>
    if (typeof fibre !== 'string' || typeof percent !== 'string' || !/^\d{1,3}(\.\d{1,2})?$/.test(percent.trim())) return []
    fibres.push({ fibre: fibre.trim(), percent: percent.trim() })
  }
  return fibres
}

/** The key a fibre is compared by: its Annex I key, else its typed words. */
export const fibreKey = (typed: string): string => {
  const reading = readFibre(typed)
  return reading.kind === 'ANNEX' ? reading.fibre.key : normalisedWords(typed)
}

/** The line's role: a part of the label, another textile, a non-textile part, or not in the garment. */
export function roleOf(material: MaterialFacts): LineRole {
  if (material.kind === 'PACKAGING') return 'NOT_IN_GARMENT'
  if (material.kind === 'LEATHER') return 'NON_TEXTILE'
  const hasFibres = fibresOf(material).length > 0
  const component = COMPONENT_OF_KIND[material.kind]
  if (component && (hasFibres || TEXTILE_KINDS.has(material.kind))) return 'PART'
  return hasFibres ? 'OTHER_TEXTILE' : 'NON_TEXTILE'
}

export const componentOf = (material: MaterialFacts): Component | null => (roleOf(material) === 'PART' ? (COMPONENT_OF_KIND[material.kind] ?? null) : null)

const WEIGHT_KEY = /^(weight|peso|grammatura|gsm|mass|massa)\b/
const PER_UNIT: Readonly<Record<string, Uom>> = Object.freeze({ m2: 'M2', 'm²': 'M2', mq: 'M2', sqm: 'M2', m: 'M', ml: 'M', pcs: 'PCS', pc: 'PCS', pz: 'PCS', piece: 'PCS', pair: 'PAIR', paio: 'PAIR' })
const WEIGHT_TEXT = /^(\d{1,7}(?:[.,]\d{1,4})?)\s*(kg|g|gsm)\s*(?:\/\s*([a-z0-9²]+))?$/

/** The material's weight attribute: grams per one `per` (the material's base unit when the text names none). */
export interface MaterialWeight {
  readonly gramsPer: Decimal
  readonly per: Uom
  readonly text: string
}

/** The `weight` attribute read ("180 g/m2", "0.25 kg/m", "120 g"); null when none; a problem when it cannot be read. */
export function weightOf(material: Pick<MaterialFacts, 'attributes' | 'units'>): MaterialWeight | { readonly problem: string } | null {
  for (const [key, raw] of Object.entries(material.attributes ?? {})) {
    const name = key.trim().toLowerCase()
    if (!WEIGHT_KEY.test(name)) continue
    // The unit may be in the attribute's name: "weight (g/m2)" = "180".
    const unitInName = /\(([^)]+)\)/.exec(name)?.[1]?.replace(/\s+/g, '') ?? ''
    const value = raw.trim().toLowerCase().replace(/\s+/g, ' ')
    // A bare number takes the unit of the attribute's name; "gsm" and "grammatura" are grams per square metre.
    const bare = /^\d{1,7}(?:[.,]\d{1,4})?$/.test(value)
    const text = bare && unitInName ? `${value} ${unitInName}` : bare && /^(gsm|grammatura)\b/.test(name) ? `${value} gsm` : value
    const match = WEIGHT_TEXT.exec(text.replace(/\s*\/\s*/g, '/'))
    if (!match) return { problem: `"${key}: ${raw}" is not a weight this check reads: write it as "180 g/m2", "45 g/m" or "120 g/pcs".` }
    const amount = new Decimal(match[1]!.replace(',', '.'))
    const unit = match[2]!
    if (unit === 'gsm') {
      if (match[3] !== undefined) return { problem: `"${key}: ${raw}" is not a weight this check reads: gsm already means grams per square metre.` }
      return { gramsPer: amount, per: 'M2', text }
    }
    const grams = unit === 'kg' ? amount.times(1000) : amount
    if (match[3] === undefined) return { gramsPer: grams, per: material.units.baseUom, text }
    const per = PER_UNIT[match[3]]
    if (!per) return { problem: `"${key}: ${raw}" names a unit this check does not read (${match[3]}): use m2, m or pcs.` }
    return { gramsPer: grams, per, text }
  }
  return null
}

export type LineWeight = { readonly grams: Decimal; readonly how: string } | { readonly grams: null; readonly why: string }

/** The line's weight in the garment, in grams (wastage left out), or why it is not known. */
export function lineWeight(line: LineFacts): LineWeight {
  if (line.qty === null) return { grams: null, why: 'not used in this size' }
  const qty = new Decimal(line.qty)
  const units = line.material.units
  const direct = fixedRatio(line.uom, 'G')
  if (direct) return { grams: qty.times(direct), how: `${decimalText(qty)} ${line.uom} on the BOM` }
  const lineFactor = baseFactor(line.uom, units)
  const gramFactor = baseFactor('G', units)
  if (lineFactor && gramFactor) return { grams: qty.times(lineFactor).div(gramFactor), how: `the material's units convert ${line.uom} to grams` }
  const weight = weightOf(line.material)
  if (weight === null) return { grams: null, why: `material ${line.material.code} has no weight: add the attribute "weight" (e.g. "180 g/m2")` }
  if ('problem' in weight) return { grams: null, why: weight.problem }
  const perFactor = baseFactor(weight.per, units)
  if (!lineFactor || !perFactor) {
    return { grams: null, why: `material ${line.material.code} weighs ${weight.text}, and its units do not convert ${line.uom} to ${weight.per}: give the weight per ${line.uom}` }
  }
  return { grams: qty.times(lineFactor).div(perFactor).times(weight.gramsPer), how: `${weight.text} × ${decimalText(qty)} ${line.uom}` }
}

// ---- the parts ---------------------------------------------------------------------------------------------------------------

export interface ComputedFibre {
  /** Its Annex I key (the English official name), else the typed words. */
  readonly fibre: string
  /** True when the name is an Annex I name of this list. */
  readonly annex: boolean
  readonly percent: string
}

export interface ComputedPart {
  readonly component: Component
  /** The part's English words (what a label part is called here). */
  readonly part: string
  readonly words: { readonly en: string; readonly it: string }
  /** Null when it cannot be computed (see `findings`). */
  readonly fibres: readonly ComputedFibre[] | null
  /** ONE_COMPOSITION: every material of the part has the same fibres; BY_WEIGHT: mixed, weighed. */
  readonly basis: 'ONE_COMPOSITION' | 'BY_WEIGHT' | null
  /** The material codes of the part, in BOM order. */
  readonly materials: readonly string[]
}

const sameFibres = (a: readonly FibreShare[], b: readonly FibreShare[]): boolean =>
  a.length === b.length && a.every((share) => b.some((other) => fibreKey(other.fibre) === fibreKey(share.fibre) && new Decimal(other.percent).eq(share.percent)))

const byPercent = (a: ComputedFibre, b: ComputedFibre): number => new Decimal(b.percent).comparedTo(a.percent) || a.fibre.localeCompare(b.fibre)

/** Shares as whole percents adding up to exactly 100 (largest remainder), from exact weights. */
export function wholePercents(weights: ReadonlyMap<string, Decimal>): Map<string, Decimal> {
  const total = [...weights.values()].reduce((sum, value) => sum.plus(value), new Decimal(0))
  const result = new Map<string, Decimal>()
  if (total.lte(0)) return result
  const exact = [...weights.entries()].map(([key, value]) => ({ key, value: value.times(100).div(total) }))
  let left = new Decimal(100).minus(exact.reduce((sum, entry) => sum.plus(entry.value.floor()), new Decimal(0)))
  for (const entry of exact) result.set(entry.key, entry.value.floor())
  const order = [...exact].sort((a, b) => b.value.minus(b.value.floor()).comparedTo(a.value.minus(a.value.floor())) || a.key.localeCompare(b.key))
  for (const entry of order) {
    if (left.lte(0)) break
    result.set(entry.key, result.get(entry.key)!.plus(1))
    left = left.minus(1)
  }
  return result
}

/** One part from its lines (all of one component), with what keeps it from being computed. */
function partOf(component: Component, lines: readonly LineFacts[], findings: Finding[]): ComputedPart {
  const words = COMPONENT_WORDS[component]
  const used = lines.filter((line) => line.qty !== null)
  const materials = [...new Map(used.map((line) => [line.material.id, line.material])).values()]
  const base = { component, part: words.en, words: { en: words.en, it: words.it }, materials: materials.map((material) => material.code) }
  const missing = materials.filter((material) => fibresOf(material).length === 0)
  for (const material of missing) {
    findings.push({ path: `materials/${material.code}/composition`, severity: 'FAIL', message: `Material ${material.code} (${words.en}) has no fibre composition: type it on the material (Reg. (EU) 1007/2011 art. 9).` })
  }
  if (missing.length > 0 || materials.length === 0) return { ...base, fibres: null, basis: null }
  const first = fibresOf(materials[0]!)
  if (materials.every((material) => sameFibres(fibresOf(material), first))) {
    const fibres = first.map((share) => ({ fibre: fibreKey(share.fibre), annex: readFibre(share.fibre).kind === 'ANNEX', percent: decimalText(new Decimal(share.percent)) }))
    return { ...base, fibres: fibres.sort(byPercent), basis: 'ONE_COMPOSITION' }
  }
  const weights = new Map<string, Decimal>()
  const annex = new Map<string, boolean>()
  let weighed = true
  for (const line of used) {
    const weight = lineWeight(line)
    if (weight.grams === null) {
      findings.push({ path: `lines/${line.seq}/weight`, severity: 'WARN', message: `The ${words.en} mixes materials of different fibres, so it is computed by weight, and line ${line.seq} (${line.material.code}) has no weight: ${weight.why}.` })
      weighed = false
      continue
    }
    for (const share of fibresOf(line.material)) {
      const key = fibreKey(share.fibre)
      annex.set(key, readFibre(share.fibre).kind === 'ANNEX')
      weights.set(key, (weights.get(key) ?? new Decimal(0)).plus(weight.grams.times(share.percent).div(100)))
    }
  }
  if (!weighed) return { ...base, fibres: null, basis: null }
  const percents = wholePercents(weights)
  const fibres = [...percents.entries()].filter(([, percent]) => percent.gt(0)).map(([fibre, percent]) => ({ fibre, annex: annex.get(fibre) ?? false, percent: decimalText(percent) }))
  return { ...base, fibres: fibres.sort(byPercent), basis: 'BY_WEIGHT' }
}

export interface Composition {
  readonly parts: readonly ComputedPart[]
  /** Materials of animal origin that are not textile (leather, fur): the art. 12 phrase is needed. */
  readonly animalParts: readonly { readonly code: string; readonly name: string }[]
  readonly findings: readonly Finding[]
}

/** The parts of the garment and its non-textile animal parts, from the lines of one colourway in one size. */
export function computeComposition(lines: readonly LineFacts[]): Composition {
  const findings: Finding[] = []
  const parts: ComputedPart[] = []
  for (const component of COMPONENTS) {
    const ofComponent = lines.filter((line) => componentOf(line.material) === component)
    if (ofComponent.some((line) => line.qty !== null)) parts.push(partOf(component, ofComponent, findings))
  }
  const animal = new Map<string, { code: string; name: string }>()
  for (const line of lines) {
    if (line.qty === null) continue
    // Art. 12 is about NON-textile parts of animal origin (leather, fur): wool is a fibre, not such a part.
    if ((line.material.animalOrigin || line.material.kind === 'LEATHER') && roleOf(line.material) === 'NON_TEXTILE') animal.set(line.material.id, { code: line.material.code, name: line.material.name })
  }
  return { parts, animalParts: [...animal.values()], findings }
}

/** "lining 100 % polyester" */
export const partText = (part: string, fibres: readonly { readonly fibre: string; readonly percent: string }[]): string =>
  `${part} ${fibres.map((fibre) => `${fibre.percent} % ${fibre.fibre}`).join(', ')}`

// ---- the label's typed composition against the BOM --------------------------------------------------------------------------------

/** The tolerance between a label's share and a share computed by weight: art. 20's manufacturing tolerance, 3 points. */
export const WEIGHT_TOLERANCE = new Decimal(3)

const partMatches = (typed: string, component: Component): boolean => {
  const words = normalisedWords(typed)
  return COMPONENT_WORDS[component].typed.some((word) => words === word || words.includes(word))
}

const fibresMatch = (typed: readonly FibreShare[], part: ComputedPart): boolean => {
  if (part.fibres === null) return false
  const tolerance = part.basis === 'BY_WEIGHT' ? WEIGHT_TOLERANCE : new Decimal(0)
  const shares = typed.filter((share) => /^\d{1,3}(\.\d{1,2})?$/.test(share.percent.trim()))
  return (
    shares.length === typed.length &&
    shares.length === part.fibres.length &&
    part.fibres.every((fibre) => {
      const match = shares.find((share) => fibreKey(share.fibre) === fibre.fibre)
      return match !== undefined && new Decimal(match.percent).minus(fibre.percent).abs().lte(tolerance)
    })
  )
}

/** Where the label's typed composition and the BOM disagree (paths: `label/composition/<i>`, `bom/<component>`). */
export function compareWithLabel(parts: readonly ComputedPart[], typed: readonly CompositionPart[]): Finding[] {
  const findings: Finding[] = []
  const used = new Set<number>()
  for (const part of parts) {
    if (part.fibres === null) continue
    let index = typed.findIndex((entry, at) => !used.has(at) && partMatches(entry.part, part.component))
    if (index < 0) index = typed.findIndex((entry, at) => !used.has(at) && fibresMatch(entry.fibres, part))
    if (index < 0) {
      findings.push({ path: `bom/${part.component}`, severity: 'FAIL', message: `The label has no ${part.part}: the BOM gives ${partText(part.part, part.fibres)} (Reg. (EU) 1007/2011 art. 11).` })
      continue
    }
    used.add(index)
    const entry = typed[index]!
    if (!fibresMatch(entry.fibres, part)) {
      const how = part.basis === 'BY_WEIGHT' ? 'by weight, within 3 points' : 'from its material'
      findings.push({
        path: `label/composition/${index}`,
        severity: 'FAIL',
        message: `The label says ${partText(entry.part, entry.fibres)}; the BOM gives ${partText(part.part, part.fibres)} (${how}).`,
      })
    }
  }
  typed.forEach((entry, index) => {
    if (used.has(index)) return
    if (entry.fibres.length > 0 && entry.fibres.every((share) => readFibre(share.fibre).kind === 'NOT_TEXTILE')) {
      findings.push({ path: `label/composition/${index}`, severity: 'WARN', message: `"${entry.part}" lists leather or fur, which is no textile fibre: the animal-origin phrase says it (art. 12); leave it out of the fibre composition.` })
    } else {
      findings.push({ path: `label/composition/${index}`, severity: 'WARN', message: `The label lists ${entry.part}, but the BOM has no such textile part.` })
    }
  })
  return findings
}

// ---- the 80 % check (art. 2(2)(a)) ---------------------------------------------------------------------------------------------

export const TEXTILE_THRESHOLD_PCT = new Decimal(80)

export interface TextileShare {
  /** The textile share in percent, one decimal; null when a weight is missing. */
  readonly pct: string | null
  /** True: at least 80 % textile, a textile product; null: not known. */
  readonly applies: boolean | null
  readonly basis: 'NET_MASS' | 'BOM' | null
  readonly textileGrams: string | null
  readonly garmentGrams: string | null
  /** The lines whose weight is needed and missing. */
  readonly missing: readonly { readonly seq: number; readonly code: string; readonly why: string }[]
  readonly findings: readonly Finding[]
}

const grams = (value: Decimal): string => decimalText(value.toDecimalPlaces(1, Decimal.ROUND_HALF_UP))

/** The textile share of the garment (`netMassKg`: the style's net mass, when on record). */
export function textileShareOf(lines: readonly LineFacts[], netMassKg: string | null): TextileShare {
  const inGarment = lines.filter((line) => line.qty !== null && roleOf(line.material) !== 'NOT_IN_GARMENT')
  const textile = inGarment.filter((line) => {
    const role = roleOf(line.material)
    return role === 'PART' || role === 'OTHER_TEXTILE'
  })
  const needed = netMassKg === null ? inGarment : textile
  const missing: { seq: number; code: string; why: string }[] = []
  const weights = new Map<number, Decimal>()
  for (const line of needed) {
    const weight = lineWeight(line)
    if (weight.grams === null) missing.push({ seq: line.seq, code: line.material.code, why: weight.why })
    else weights.set(line.seq, weight.grams)
  }
  const basis = netMassKg === null ? 'BOM' : 'NET_MASS'
  if (missing.length > 0) {
    return { pct: null, applies: null, basis, textileGrams: null, garmentGrams: null, missing, findings: missing.map((line) => ({ path: `lines/${line.seq}/weight`, severity: 'WARN' as const, message: `Line ${line.seq} (${line.code}): ${line.why}.` })) }
  }
  const textileGrams = textile.reduce((sum, line) => sum.plus(weights.get(line.seq) ?? 0), new Decimal(0))
  const total = netMassKg === null ? inGarment.reduce((sum, line) => sum.plus(weights.get(line.seq) ?? 0), new Decimal(0)) : new Decimal(netMassKg).times(1000)
  const findings: Finding[] = []
  if (total.lte(0)) return { pct: null, applies: null, basis, textileGrams: grams(textileGrams), garmentGrams: grams(total), missing, findings: [{ path: 'weight', severity: 'WARN', message: 'The garment weighs nothing on record: the textile share cannot be computed.' }] }
  if (textileGrams.gt(total)) {
    findings.push({ path: 'style/netMassKg', severity: 'WARN', message: `The BOM's textiles weigh ${grams(textileGrams)} g, more than the garment's net mass of ${grams(total)} g: check the weights or the net mass.` })
  }
  const share = textileGrams.times(100).div(total)
  return {
    pct: decimalText(share.toDecimalPlaces(1, Decimal.ROUND_DOWN)),
    applies: share.gte(TEXTILE_THRESHOLD_PCT),
    basis,
    textileGrams: grams(textileGrams),
    garmentGrams: grams(total),
    missing,
    findings,
  }
}
