/**
 * VP.3 — Generate combinations (§3.4), as pure functions.
 *
 * The dialog is a preview of a WRITE, so everything it claims on screen is computed here and
 * tested: how many combinations the chosen values make, which of them already exist, what each new
 * SKU would be, and which sibling each new variant copies from. The component draws the answer and
 * owns no rule.
 *
 * 🔴 The SKU pattern is DERIVED from the family's own SKUs, not invented. A default like
 * `{parent}-{Colore}-{Taglia}` would produce `GALE-JACKET-Nero-XXS` beside twenty existing
 * `GALE-JACKET-BLACK-MEN-XXS`, and the operator's only signal that the house convention had been
 * dropped would be the preview line — which is exactly the kind of plausible wrong default that
 * passes review. `deriveSkuPattern` reads the convention back out of the children instead, INCLUDING
 * the per-value codes (`Nero → BLACK`), and says when it could not.
 */
import { cartesian, type AxisSummary } from './coverage'

/* ── what the dialog holds ────────────────────────────────────────────────────────────────── */

export interface ChoiceValue {
  code: string
  label: string
  /** Typed into the dialog; it exists nowhere yet and is created only by pressing Create. */
  isNew: boolean
}

export interface AxisChoice {
  key: string
  label: string
  values: ChoiceValue[]
}

export interface PlannedVariant {
  sku: string
  /** axis key → value code. */
  axisValues: Record<string, string>
  /** The existing SKU whose title, price and stock this variant copies. `null` when there is none. */
  copiesFrom: string | null
}

export interface SkippedVariant {
  sku: string
  axisValues: Record<string, string>
  reason: string
}

export interface GeneratePlan {
  /** The product of the CHOSEN value counts — the dialog's `3 × 10 = 30`. */
  combinations: number
  /** How many of those already exist as variants. */
  existing: number
  plan: PlannedVariant[]
  skipped: SkippedVariant[]
}

/** What `buildPlan` needs to know about the family. */
export interface PlanFamily {
  parentSku: string
  /** Every existing variant, with its axis codes. */
  children: Array<{ sku: string; axisValues: Record<string, string | null> }>
  /** Every SKU in the catalogue slice we can see — a collision is refused by name, never renamed. */
  knownSkus?: readonly string[]
}

/* ── the pattern ──────────────────────────────────────────────────────────────────────────── */

export interface SkuPattern {
  /** `{parent}-{Colore.code}-MEN-{Taglia}` */
  pattern: string
  /** axis key → value code → the SKU segment that value contributes (`Nero` → `BLACK`). */
  codes: Record<string, Record<string, string>>
  /**
   * False when the family's SKUs do not follow one segment convention. The dialog then shows the
   * generic pattern and says it is a suggestion, rather than claiming to have read a house rule
   * that is not there.
   */
  derived: boolean
  /**
   * WHY it could not be read, when it could not. A degraded default that cannot say why is the same
   * defect as a disabled control that cannot — the operator sees a suggestion and has no way to know
   * whether their family is unusual or their data is wrong.
   *
   * 🔴 On GALE-JACKET the answer is the second, and it is worth seeing: two variants whose SKU says
   * `XXS` store `Taglia: 'XS'`, so `XS` maps to two different SKU segments and no one-to-one
   * convention exists. Naming that turns "we could not read your pattern" into "these two rows
   * disagree with their own SKUs".
   */
  reason?: string
}

const SEP = '-'

/** The token an axis contributes, by label where it has one — `{Colore}` is what the band shows. */
export function axisToken(axis: { key: string; label: string }, coded: boolean): string {
  const name = axis.label.trim() || axis.key
  return coded ? `{${name}.code}` : `{${name}}`
}

/**
 * Read the family's SKU convention back out of its children.
 *
 * The rule, in one sentence: split every child SKU on `-`, drop the parent's own segments from the
 * front, and for each remaining position decide whether it is a literal (the same on every child),
 * an axis VALUE (it tracks one axis and equals that axis's code) or an axis CODE (it tracks one axis
 * and does not).
 *
 * Returns `derived: false` — and a generic pattern — when the children disagree about their segment
 * count, do not share the parent's prefix, or leave a varying position that no axis explains. A
 * guessed pattern is worse than an honest generic one, because the preview line would then be a
 * confident wrong answer.
 */
export function deriveSkuPattern(parentSku: string, children: PlanFamily['children'], axes: readonly AxisSummary[]): SkuPattern {
  const generic = (reason: string): SkuPattern => ({
    pattern: [`{parent}`, ...axes.map(a => axisToken(a, false))].join(SEP),
    codes: {},
    derived: false,
    reason,
  })
  const complete = children.filter(c => axes.every(a => typeof c.axisValues[a.key] === 'string' && c.axisValues[a.key]))
  if (axes.length === 0) return generic('This family has no axes to build a pattern from.')
  if (complete.length === 0) return generic('No variant carries a value on every axis, so there is no complete SKU to read a pattern from.')

  const parentParts = parentSku.split(SEP)
  const split = complete.map(c => ({ child: c, parts: c.sku.split(SEP) }))
  /* Every child must start with the parent's segments and be the same length; a family whose SKUs
     were minted by different hands has no single convention to read. */
  const width = split[0].parts.length
  if (split.some(s => s.parts.length !== width)) {
    return generic(`These SKUs do not all have the same number of "${SEP}" parts, so they follow more than one convention.`)
  }
  if (split.some(s => parentParts.some((p, i) => s.parts[i] !== p))) {
    return generic(`Not every variant SKU starts with the parent's "${parentSku}", so there is no shared stem to build on.`)
  }
  const tailWidth = width - parentParts.length
  if (tailWidth <= 0) return generic('The variant SKUs add nothing after the parent SKU, so no axis is expressed in them.')

  const codes: Record<string, Record<string, string>> = {}
  const tokens: string[] = []
  for (let i = 0; i < tailWidth; i++) {
    const at = parentParts.length + i
    const seen = new Set(split.map(s => s.parts[at]))
    if (seen.size === 1) { tokens.push(split[0].parts[at]); continue }
    /* Which axis explains this position? The one where every child sharing an axis value shares
       this segment, AND two different axis values never share it — a one-to-one correspondence,
       not a correlation. */
    const pairsFor = (a: AxisSummary) => split.map(s => [String(s.child.axisValues[a.key]), s.parts[at]] as const)
    const axis = axes.find(a => oneToOne(pairsFor(a)))
    if (!axis) {
      /*
       * 🔴 Report the NEAREST MISS, not the first axis in the list — and the difference is the whole
       * value of the sentence. At a failing position every non-matching axis clashes TRIVIALLY: on
       * GALE-JACKET's size segment `Colore` "Nero" appears with all ten sizes, because it is a
       * colour. Picking the first axis therefore emitted `Colore "Nero" appears as both "3XL" and
       * "4XL"`, which is nonsense — those are Taglia segments — and I had QUOTED the correct-looking
       * sentence to another lane without ever reading what the code emits
       * (`reference_claims_must_match_their_measurement`; found by running this module against the
       * live family, not by review).
       *
       * Measured per segment on GALE-JACKET, violations = values mapping to more than one segment:
       *     segment 0   Colore 0  ·  Taglia 9    → Colore owns it
       *     segment 1   Colore 0  ·  Taglia 0    → the literal `MEN`
       *     segment 2   Colore 2  ·  Taglia 1    → neither, and TAGLIA is the near miss
       * The axis with the fewest violations is the one the position belongs to.
       */
      const ranked = axes
        .map(a => ({ axis: a, violations: violationCount(pairsFor(a)) }))
        .filter(x => x.violations > 0)
        .sort((x, y) => x.violations - y.violations)
      const clash = ranked.length > 0 ? firstClash(pairsFor(ranked[0].axis), ranked[0].axis.label) : null
      return generic(clash ?? `Part ${i + 1} of these SKUs does not track any one axis, so no pattern can be read from it.`)
    }
    const map: Record<string, string> = {}
    for (const s of split) map[String(s.child.axisValues[axis.key])] = s.parts[at]
    codes[axis.key] = map
    const literal = Object.entries(map).every(([value, segment]) => value === segment)
    tokens.push(axisToken(axis, !literal))
  }
  /* Every axis must appear, or generating would mint duplicate SKUs for different combinations. */
  const absent = axes.filter(a => !tokens.some(t => t === axisToken(a, true) || t === axisToken(a, false)))
  if (absent.length > 0) {
    return generic(`${absent.map(a => a.label).join(' and ')} ${absent.length === 1 ? 'is' : 'are'} not expressed in these SKUs, so a generated SKU could not tell two combinations apart.`)
  }
  return { pattern: [`{parent}`, ...tokens].join(SEP), codes, derived: true }
}

/** How many values map to more than one segment here. The near-miss axis has the fewest. */
function violationCount(pairs: readonly (readonly [string, string])[]): number {
  const seen = new Map<string, Set<string>>()
  for (const [value, segment] of pairs) {
    const set = seen.get(value) ?? new Set<string>()
    set.add(segment)
    seen.set(value, set)
  }
  return [...seen.values()].filter(set => set.size > 1).length
}

/** The first value that maps to two different segments, said in an operator's words. */
function firstClash(pairs: readonly (readonly [string, string])[], axisLabel: string): string | null {
  const seen = new Map<string, string>()
  for (const [value, segment] of pairs) {
    const had = seen.get(value)
    if (had !== undefined && had !== segment) {
      return `${axisLabel} "${value}" appears in these SKUs as both "${had}" and "${segment}", so no single pattern fits — check those variants, their stored value may disagree with their SKU.`
    }
    seen.set(value, segment)
  }
  return null
}

function oneToOne(pairs: readonly (readonly [string, string])[]): boolean {
  const forward = new Map<string, string>()
  const back = new Map<string, string>()
  for (const [a, b] of pairs) {
    if (forward.has(a) && forward.get(a) !== b) return false
    if (back.has(b) && back.get(b) !== a) return false
    forward.set(a, b)
    back.set(b, a)
  }
  return true
}

/** The code a value contributes to a SKU: the derived one, else the value upper-cased. */
export function codeFor(pattern: SkuPattern, axisKey: string, value: string): string {
  return pattern.codes[axisKey]?.[value] ?? defaultCode(value)
}

/** Where a code came from. `sibling` is EVIDENCE this client read; `default` is what the server does. */
export type CodeSource = 'sibling' | 'default'

/**
 * 🔴 The distinction this exists for, found by VP.2 and latent until they said so.
 *
 * The generate service has NO value-mapping data to work from — `FieldValueMap` holds zero rows, and
 * `SizeScaleMap`'s 23 are EU-to-alpha SIZE conversions, not colour codes — so its `{axis.code}`
 * UPPERCASES the value: `Nero → NERO`. This client reads `Nero → BLACK` back out of the family's own
 * SKUs, which is better evidence but is evidence only THIS side has.
 *
 * So on any family where `deriveSkuPattern` succeeds, an unlabelled preview would show
 * `GALE-JACKET-BLACK-MEN-XXS` while Create produced `GALE-JACKET-NERO-MEN-XXS`. Nothing on this
 * family today (the derivation refuses it), which is exactly what makes it the dangerous kind: a
 * confident wrong preview waiting for the first family whose SKUs are consistent.
 *
 * The resolution is that the SERVER's dry run is the authority once it is wired (§5.3), and until
 * then the dialog says which codes it read and which the server would invent. It does not silently
 * pick one.
 */
export function codeSource(pattern: SkuPattern, axisKey: string, value: string): CodeSource {
  return pattern.codes[axisKey]?.[value] !== undefined ? 'sibling' : 'default'
}

/**
 * A value nobody has minted a code for yet.
 *
 * Upper-cased and stripped of anything a SKU should not carry — accents folded, runs of other
 * characters collapsed to one `-`. It is a SUGGESTION: §3.4's copy says "(new, edit before
 * creating)" because this cannot know the house abbreviation (`Rosso` is `RED` only because someone
 * decided so).
 */
export function defaultCode(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, SEP)
    .replace(/^-+|-+$/g, '')
}

/** Substitute `{parent}`, `{Axis}` and `{Axis.code}` — unknown tokens are LEFT IN, never blanked. */
export function renderSku(
  pattern: string,
  parts: { parentSku: string; axes: readonly AxisChoice[]; values: Record<string, string>; codes: SkuPattern },
): string {
  return pattern.replace(/\{([^}]+)\}/g, (whole, token: string) => {
    if (token === 'parent') return parts.parentSku
    const coded = token.endsWith('.code')
    const name = coded ? token.slice(0, -'.code'.length) : token
    const axis = parts.axes.find(a => a.label === name) ?? parts.axes.find(a => a.key === name)
    if (!axis) return whole
    const value = parts.values[axis.key]
    if (value == null) return whole
    return coded ? codeFor(parts.codes, axis.key, value) : value
  })
}

/* ── the plan ─────────────────────────────────────────────────────────────────────────────── */

/**
 * The existing variant a new combination copies from: the one sharing the most axis values, ties
 * broken by the earlier axis (so `Rosso · XXS` copies a `… · XXS` sibling rather than any red one
 * when there is no red at all).
 */
export function nearestSibling(
  values: Record<string, string>,
  axes: readonly AxisChoice[],
  children: PlanFamily['children'],
): string | null {
  let best: { sku: string; score: number } | null = null
  for (const child of children) {
    let score = 0
    for (let i = 0; i < axes.length; i++) {
      if (child.axisValues[axes[i].key] === values[axes[i].key]) score += axes.length - i
    }
    if (!best || score > best.score) best = { sku: child.sku, score }
  }
  return best?.sku ?? null
}

/**
 * The dialog's whole answer. `dryRun` in §5.3's sense: nothing is written, and this is what the
 * summary box and the footer button count.
 */
export function buildPlan(
  axes: readonly AxisChoice[],
  family: PlanFamily,
  pattern: SkuPattern,
  patternText: string,
): GeneratePlan {
  if (axes.length === 0 || axes.some(a => a.values.length === 0)) {
    return { combinations: 0, existing: 0, plan: [], skipped: [] }
  }
  const combinations = axes.reduce((n, a) => n * a.values.length, 1)
  const existingTuples = new Set(
    family.children
      .filter(c => axes.every(a => typeof c.axisValues[a.key] === 'string' && c.axisValues[a.key]))
      .map(c => axes.map(a => String(c.axisValues[a.key])).join(' ')),
  )
  const taken = new Set<string>([...(family.knownSkus ?? []), ...family.children.map(c => c.sku), family.parentSku])
  const plan: PlannedVariant[] = []
  const skipped: SkippedVariant[] = []
  let existing = 0
  for (const tuple of cartesian(axes.map(a => a.values.map(v => v.code)))) {
    const values: Record<string, string> = {}
    axes.forEach((a, i) => { values[a.key] = tuple[i] })
    if (existingTuples.has(tuple.join(' '))) { existing++; continue }
    const sku = renderSku(patternText, { parentSku: family.parentSku, axes, values, codes: pattern })
    if (taken.has(sku)) {
      /* §5.3: refuse a collision BY NAME, never rename. A silently suffixed SKU is a new identity
         nobody chose, and it would reach the channels as one. */
      skipped.push({ sku, axisValues: values, reason: `${sku} already exists — change the pattern or the value code` })
      continue
    }
    taken.add(sku)
    plan.push({ sku, axisValues: values, copiesFrom: nearestSibling(values, axes, family.children) })
  }
  return { combinations, existing, plan, skipped }
}

/* ── the copy (§3.4, verbatim) ────────────────────────────────────────────────────────────── */

/** `3 values · Rosso is new and is added only when you create · type a value and press Enter to add another` */
export function axisHint(choice: AxisChoice): string {
  const fresh = choice.values.filter(v => v.isNew)
  const parts = [`${choice.values.length} ${choice.values.length === 1 ? 'value' : 'values'}`]
  if (fresh.length > 0) {
    const names = fresh.map(v => v.label)
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
    parts.push(`${list} ${names.length === 1 ? 'is' : 'are'} new and ${names.length === 1 ? 'is' : 'are'} added only when you create`)
    parts.push('type a value and press Enter to add another')
  }
  return parts.join(' · ')
}

/** `Codes: Nero → BLACK, Giallo → YELLOW, Rosso → RED (new, edit before creating)` — the coded axes only. */
export interface CodeLine {
  axisKey: string
  entries: Array<{ label: string; code: string; isNew: boolean; source: CodeSource }>
}

export function codeLines(axes: readonly AxisChoice[], pattern: SkuPattern, patternText: string): CodeLine[] {
  return axes
    .filter(a => patternText.includes(axisToken(a, true)))
    .map(a => ({
      axisKey: a.key,
      entries: a.values.map(v => ({ label: v.label, code: codeFor(pattern, a.key, v.code), isNew: v.isNew, source: codeSource(pattern, a.key, v.code) })),
    }))
    .filter(line => line.entries.length > 0)
}
