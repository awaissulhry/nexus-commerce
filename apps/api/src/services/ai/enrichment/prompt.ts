/**
 * PES.8 — the enrichment prompt.
 *
 * One prompt per (product × coordinate), covering every cell we are drafting
 * for that product at once. Batching this way is not just cheaper: the model
 * writes a title, its bullets and its attributes against the SAME context in
 * one pass, so they agree with each other. Four separate calls produce four
 * independently plausible answers that contradict on colour or material.
 *
 * Two rules the prompt is built to make structurally hard to break:
 *  - Every cap the channel publishes is stated per field, in both characters
 *    and UTF-8 bytes when the two differ. The output is still validated —
 *    the prompt is a request, `validate.ts` is the gate.
 *  - The model is told, explicitly, that omitting a field is a correct answer.
 *    An enrichment pass that invents a certification or a measurement to fill
 *    a cell is worse than one that leaves it empty, because the empty cell is
 *    visible and the invention is not.
 */
import type { CellConstraint } from './constraints.js'
import { constraintLine } from './constraints.js'

export interface ProductPromptContext {
  id: string
  sku: string
  name: string | null
  brand: string | null
  productType: string | null
  description: string | null
  bulletPoints: string[]
  keywords: string[]
  /** Attribute values already known — the evidence, and what NOT to contradict. */
  knownAttributes: Record<string, unknown>
}

export interface BuildPromptInput {
  product: ProductPromptContext
  constraints: CellConstraint[]
  /** Where the draft lands: 'the master record' or 'Amazon · IT'. */
  scopeLabel: string
  /** The language the copy must be written in. */
  language: string
  /** Values the target cells hold right now, by columnKey. */
  currentValues: Record<string, unknown>
}

function renderKnown(attrs: Record<string, unknown>): string {
  const rows = Object.entries(attrs)
    .filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0))
    .slice(0, 60)
    .map(([k, v]) => `  ${k}: ${Array.isArray(v) ? v.join(' / ') : String(v).slice(0, 200)}`)
  return rows.length > 0 ? rows.join('\n') : '  (none recorded)'
}

function renderCurrent(constraints: CellConstraint[], current: Record<string, unknown>): string {
  const rows = constraints
    .map((c) => {
      const v = current[c.columnKey]
      if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) return null
      const shown = Array.isArray(v) ? v.map((x) => String(x)).join(' | ') : String(v)
      return `  ${c.columnKey}: ${shown.slice(0, 400)}`
    })
    .filter(Boolean) as string[]
  return rows.length > 0 ? rows.join('\n') : '  (all empty)'
}

export function buildEnrichmentPrompt(input: BuildPromptInput): string {
  const { product, constraints, scopeLabel, language, currentValues } = input
  return [
    `You are enriching one product record in a PIM for ${scopeLabel}.`,
    `Write every text value in ${language}.`,
    '',
    'PRODUCT',
    `  SKU: ${product.sku}`,
    product.name ? `  Current name: ${product.name}` : null,
    product.brand ? `  Brand: ${product.brand}` : null,
    product.productType ? `  Product type: ${product.productType}` : null,
    product.description ? `  Description: ${product.description.slice(0, 1500)}` : null,
    product.bulletPoints.length > 0
      ? `  Existing bullets: ${product.bulletPoints.slice(0, 6).map((b) => b.slice(0, 200)).join(' | ')}`
      : null,
    product.keywords.length > 0 ? `  Keywords: ${product.keywords.slice(0, 20).join(', ')}` : null,
    '',
    'KNOWN ATTRIBUTES (evidence — never contradict these)',
    renderKnown(product.knownAttributes),
    '',
    'WHAT THESE CELLS HOLD TODAY (you are proposing a replacement; leave a field',
    'out entirely if what is there is already good)',
    renderCurrent(constraints, currentValues),
    '',
    'FIELDS TO PROPOSE — each line gives the channel\'s own limits. The limits are',
    'hard: a value over a cap is discarded, not trimmed, so write within them.',
    ...constraints.map(constraintLine),
    '',
    'RULES',
    '- Ground every value in the product information above. If the evidence does',
    '  not support a field, OMIT it. An omitted field is a correct answer.',
    '- Never invent a certification, standard, measurement, material, country of',
    '  origin, or identifier. These are claims a buyer and a regulator rely on.',
    '- Where a field lists allowed values, answer with EXACTLY one of them,',
    '  copied character for character.',
    '- Count UTF-8 bytes where a byte cap is given: an accented letter costs 2.',
    '- No emojis, no ALL-CAPS shouting, no keyword stuffing.',
    '',
    'Return ONLY a JSON object, no prose and no markdown fences, shaped:',
    '{ "fields": { "<field key>": { "value": <string or array of strings>,',
    '  "confidence": "high" | "medium" | "low",',
    '  "reason": "<one short clause naming the evidence>" }, ... } }',
    'Omit any field you are not proposing. "low" confidence values are discarded,',
    'so use it honestly rather than withholding.',
  ]
    .filter((l) => l !== null)
    .join('\n')
}

/**
 * D7 — the TRANSLATE prompt.
 *
 * A different job from enrichment and it must not drift into it: the source copy is a decision
 * somebody already made, and a "translation" that improves the wording is an unreviewed rewrite
 * wearing a translation's label. The instruction is to carry the same claims across, and to say so
 * when the target language cannot do that within the cap rather than quietly cutting.
 *
 * The caps are the TARGET market's, not the source's — the same field is capped differently per
 * marketplace, and German is reliably longer than English for the same sentence.
 */
export interface BuildTranslatePromptInput {
  product: ProductPromptContext
  constraints: CellConstraint[]
  /** The language being translated INTO, named for a human ("German"). */
  targetLanguage: string
  /** The language the source values are in. */
  sourceLanguage: string
  /** Source values by columnKey — what is being translated. */
  sourceValues: Record<string, unknown>
  /** What that locale already holds, so an existing translation is not re-proposed unchanged. */
  currentValues: Record<string, unknown>
}

export function buildTranslatePrompt(input: BuildTranslatePromptInput): string {
  const { product, constraints, targetLanguage, sourceLanguage, sourceValues, currentValues } = input
  return [
    `You are translating one product's listing copy from ${sourceLanguage} into ${targetLanguage}.`,
    '',
    'PRODUCT (for disambiguation only — do not add facts from it)',
    `  SKU: ${product.sku}`,
    product.brand ? `  Brand: ${product.brand}` : null,
    product.productType ? `  Product type: ${product.productType}` : null,
    '',
    `SOURCE COPY (${sourceLanguage}) — translate exactly these`,
    renderCurrent(constraints, sourceValues),
    '',
    `ALREADY IN ${targetLanguage} (omit a field whose existing translation is already correct)`,
    renderCurrent(constraints, currentValues),
    '',
    "FIELDS AND THE TARGET MARKET'S LIMITS — a value over a cap is discarded, not trimmed",
    ...constraints.map(constraintLine),
    '',
    'RULES',
    '- Translate; do not rewrite, improve, expand or re-order. The source copy is a decision',
    '  somebody already made. A better sentence is still the wrong answer here.',
    '- Carry every claim across unchanged. Never add a claim the source does not make, and never',
    '  drop one to fit — if it cannot fit the cap, OMIT the field and say so in `reason`.',
    '- Keep brand names, model names, part numbers and measurements exactly as written.',
    `- Count UTF-8 bytes where a byte cap is given: accented characters cost 2.`,
    '- Match the register of the source, not of marketing copy generally.',
    '',
    'Return ONLY a JSON object, no prose and no markdown fences, shaped:',
    '{ "fields": { "<field key>": { "value": <string or array of strings>,',
    '  "confidence": "high" | "medium" | "low",',
    '  "reason": "<short — say here if you omitted a field because it would not fit>" }, ... } }',
    'Omit any field you are not proposing. "low" confidence values are discarded.',
  ]
    .filter((l) => l !== null)
    .join('\n')
}

