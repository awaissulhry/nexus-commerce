/**
 * Reviews Insights › Fit by size (Phase 3, PR J) — pure: does a product family run small, true to size or large, per
 * size? Read by the Themes fit table and the product pop-up (Summary "Size fit", Sizes tab); the reads are
 * review-fit.service.ts.
 *
 * A signal is one buyer saying which way a size fits:
 *   a review   its text says it (runs small / true to size / runs large). The sentiment call gives the FIT_SIZING
 *              theme but no direction, so the direction comes from a careful phrase map in English, Italian, German,
 *              French and Spanish (`fitDirectionOfText`): the review's own words first, its English translation only
 *              when they say nothing. A review the AI (or a person) read WITHOUT the fit theme never counts — "the box
 *              was too small" is not about fit. A phrase after a negation ("not too small", "nicht zu klein") does not
 *              count. Small and large in one review cancel out; small or large beats a "fits well" in the same review.
 *   a return   its reason says "too small" / "too large" (Amazon APPAREL_TOO_SMALL, Shopify SIZE_TOO_LARGE, a reason
 *              typed by a person …). A reason that says only "does not fit" / "wrong size" counts when the buyer's own
 *              comment says which way; else it is an unclear fit return (counted in the words, never in a verdict).
 *              A return never says "true to size".
 * The size is the variant's own (its Size / Taglia / Größe … axis, `canonicalVariantAxis`). A review on the family
 * itself names no size: it is counted as "names no size", never guessed.
 *
 * A size gets a verdict from MIN_FIT_SIGNALS (5) signals: the direction with the most signals, when it holds at least
 * half of them and no other direction ties it; otherwise "mixed". Fewer than 5 is "too few" — never a verdict.
 */
import { canonicalVariantAxis } from '../pim/variant-attribute-keys.js'

export const MIN_FIT_SIGNALS = 5
/** The Themes fit table shows at most this many families (most signals first); the words say how many more. */
export const FIT_FAMILY_LIMIT = 15

export type FitDirection = 'small' | 'true' | 'large'
export type FitVerdict = FitDirection | 'mixed' | 'too_few'

/** The languages the phrase map reads (ISO 639-1). */
export const FIT_LANGUAGES = ['en', 'it', 'de', 'fr', 'es'] as const

// ── Phrases ─────────────────────────────────────────────────────────

type Rule = { re: RegExp; dir: FitDirection }
const rule = (source: string, dir: FitDirection): Rule => ({ re: new RegExp(source, 'g'), dir })

/** groß / gross / größ / grös / groess. */
const GROSS = 'gr(?:o|ö|oe)(?:ß|ss)'
/** fällt / faellt / fallt / fallen. */
const FAELLT = 'f(?:ä|ae|a)ll(?:t|en)'

/**
 * In order: a phrase that matched is blanked out, so a later, shorter phrase cannot read it again ("una taglia più
 * grande" is "order bigger" = runs small, never "grande" = runs large). Phase 1 = which size to order, phase 2 =
 * "than expected", phase 3 = the direct words, phase 4 = true to size.
 */
const RULES: readonly Rule[] = [
  // ── Phase 1: order a different size ──
  // en
  rule('\\b(?:a|one|1|half a) size (?:up|bigger|larger)', 'small'),
  rule('\\b(?:next|one) size up', 'small'),
  rule('\\bsized? up\\b', 'small'),
  rule('\\b(?:bigger|larger) size', 'small'),
  rule('\\b(?:a|one|1|half a) size (?:down|smaller)', 'large'),
  rule('\\b(?:next|one) size down', 'large'),
  rule('\\bsized? down\\b', 'large'),
  rule('\\bsmaller size', 'large'),
  // it
  rule('\\btaglia (?:in più|più grande|sopra|superiore)', 'small'),
  rule('\\btaglia (?:in meno|più piccola|sotto|inferiore)', 'large'),
  // de
  rule(`\\b(?:eine|1) (?:nummer|${GROSS}e) ${GROSS}er`, 'small'),
  rule(`\\b${GROSS}ere (?:${GROSS}e|nummer)`, 'small'),
  rule(`\\b(?:eine|1) (?:nummer|${GROSS}e) kleiner`, 'large'),
  rule(`\\bkleinere (?:${GROSS}e|nummer)`, 'large'),
  // fr
  rule('\\b(?:une |1 )?taille (?:au[- ]dessus|de plus|plus grande|supérieure)', 'small'),
  rule('\\b(?:une |1 )?taille (?:en[- ]dessous|au[- ]dessous|de moins|plus petite|inférieure)', 'large'),
  // es
  rule('\\btalla (?:más grande|mayor|superior|por encima)', 'small'),
  rule('\\btalla (?:más pequeña|más chica|menor|inferior|por debajo)', 'large'),
  rule('\\buna talla más', 'small'),
  rule('\\buna talla menos', 'large'),

  // ── Phase 2: than expected ──
  rule('\\b(?:smaller|tighter) than (?:expected|usual|normal|standard|i expected|i thought|the size)', 'small'),
  rule('\\b(?:bigger|larger|looser|roomier) than (?:expected|usual|normal|standard|i expected|i thought|the size)', 'large'),
  rule('\\bpiù (?:piccol|strett)[aoie] (?:del|di quanto|rispetto|che)', 'small'),
  rule('\\bpiù (?:grand[ei]|larg[aoe]|larghi|abbondant[ei]) (?:del|di quanto|rispetto|che)', 'large'),
  rule('\\b(?:kleiner|enger) als (?:erwartet|gedacht|gewohnt|normal|üblich)', 'small'),
  rule(`\\b(?:${GROSS}er|weiter) als (?:erwartet|gedacht|gewohnt|normal|üblich)`, 'large'),
  rule("\\bplus (?:petit|serré)e?s? que (?:prévu|d'habitude|la normale|l'ordinaire)", 'small'),
  rule("\\bplus (?:grand|large|ample)e?s? que (?:prévu|d'habitude|la normale|l'ordinaire)", 'large'),
  rule('\\bmás (?:pequeñ|chic|ajustad|estrech)[oa]s? (?:de lo|que lo|que)', 'small'),
  rule('\\bmás (?:grandes?|holgad[oa]s?|anch[oa]s?) (?:de lo|que lo|que)', 'large'),

  // ── Phase 3: the direct words ──
  // en
  rule('\\bruns? (?:a (?:bit|little) |slightly |very |quite |rather )?small', 'small'),
  rule('\\brunning small', 'small'),
  rule('\\bfits? (?:a (?:bit|little) |slightly |very |quite )?(?:small|tight|snug)', 'small'),
  rule('\\btoo (?:small|tight|snug)', 'small'),
  rule('\\b(?:a (?:bit|little)|slightly|quite|rather) (?:small|tight|snug)\\b', 'small'),
  rule('\\bsmall fitting', 'small'),
  rule('\\bruns? (?:a (?:bit|little) |slightly |very |quite |rather )?(?:large|big)', 'large'),
  rule('\\brunning (?:large|big)', 'large'),
  rule('\\bfits? (?:a (?:bit|little) |slightly |very |quite )?(?:large|big|loose)', 'large'),
  rule('\\btoo (?:large|big|loose|baggy|roomy)', 'large'),
  rule('\\b(?:a (?:bit|little)|slightly|quite|rather) (?:large|big|loose|baggy)\\b', 'large'),
  rule('\\blarge fitting', 'large'),
  // it
  rule("\\b(?:veste|vestono|calza|calzano|vestibilità) (?:un po' |leggermente |molto |decisamente |abbastanza )?(?:piccol|strett|ridott)", 'small'),
  rule('\\btroppo (?:piccol|strett)', 'small'),
  rule("\\bun po' (?:piccol|strett)", 'small'),
  rule('\\btaglie (?:sono )?(?:piccole|strette)', 'small'),
  rule("\\bla taglia è (?:un po' )?piccola", 'small'),
  rule("\\b(?:veste|vestono|calza|calzano|vestibilità) (?:un po' |leggermente |molto |decisamente |abbastanza )?(?:grand|larg|abbondant)", 'large'),
  rule('\\btroppo (?:grand|larg|abbondant)', 'large'),
  rule("\\bun po' (?:grand|larg|abbondant)", 'large'),
  rule('\\btaglie (?:sono )?(?:grandi|abbondanti)', 'large'),
  rule("\\bla taglia è (?:un po' )?(?:grande|abbondante)", 'large'),
  // de
  rule(`\\b${FAELLT} (?:etwas |eher |sehr |deutlich |leicht |recht )?(?:klein|eng)`, 'small'),
  rule('\\bzu (?:klein|eng)', 'small'),
  rule('\\b(?:klein|eng) geschnitten', 'small'),
  rule(`\\b${FAELLT} (?:etwas |eher |sehr |deutlich |leicht |recht )?(?:${GROSS}|weit)`, 'large'),
  rule(`\\bzu (?:${GROSS}|weit)`, 'large'),
  rule(`\\b(?:${GROSS}|weit) geschnitten`, 'large'),
  // fr
  rule('\\btaill(?:e|ent) (?:un peu |très |plutôt |légèrement |bien )?petit', 'small'),
  rule('\\btrop (?:petit|serré|juste)', 'small'),
  rule('\\bun peu (?:petit|serré|juste)', 'small'),
  rule('\\btaill(?:e|ent) (?:un peu |très |plutôt |légèrement |bien )?grand', 'large'),
  rule('\\btrop (?:grand|large|ample)', 'large'),
  rule('\\bun peu (?:grand|large|ample)', 'large'),
  // es
  rule('\\btalla(?:n|je)? (?:es |muy |un poco |algo )?(?:pequeñ|chic)', 'small'),
  rule('\\b(?:queda|quedan|viene|vienen) (?:muy |un poco |algo |bastante )?(?:pequeñ|chic|justo|justa|ajustad|estrech)', 'small'),
  rule('\\bdemasiado (?:pequeñ|chic|ajustad|estrech)', 'small'),
  rule('\\btalla(?:n|je)? (?:es |muy |un poco |algo )?grande', 'large'),
  rule('\\b(?:queda|quedan|viene|vienen) (?:muy |un poco |algo |bastante )?(?:grande|holgad|anch)', 'large'),
  rule('\\bdemasiado (?:grande|holgad|anch)', 'large'),

  // ── Phase 4: true to size ──
  rule('\\btrue[- ]to[- ]size', 'true'),
  rule('\\bfits? (?:true|perfectly|perfect|great|well|as expected|just right|like a glove)', 'true'),
  rule('\\b(?:perfect|great|good) fit\\b', 'true'),
  rule('\\bperfectly fit', 'true'),
  rule('\\bsiz(?:e|ing) (?:is |was )?(?:spot on|perfect|accurate|correct|right|as expected)', 'true'),
  rule('\\b(?:right|correct) size\\b', 'true'),
  rule('\\b(?:veste|vestono|calza|calzano) (?:a pennello|perfettamente|bene|giust)', 'true'),
  rule('\\bvestibilità (?:perfetta|ottima|giusta|corretta|regolare)', 'true'),
  rule('\\btaglia (?:giusta|perfetta|corretta|regolare|esatta)', 'true'),
  rule('\\btaglie (?:giuste|regolari|corrette)', 'true'),
  rule('\\bcorrisponde alla taglia', 'true'),
  rule('\\bpasst (?:perfekt|genau|gut|super|wie angegossen)', 'true'),
  rule('\\bsitzt (?:perfekt|gut|super|wie angegossen)', 'true'),
  rule(`\\b${GROSS}e passt`, 'true'),
  rule('\\bpassform (?:ist )?(?:perfekt|gut|super)', 'true'),
  rule(`\\b${FAELLT} normal`, 'true'),
  rule(`\\b${GROSS}engerecht`, 'true'),
  rule('\\btaill(?:e|ent) (?:normalement|parfaitement|correctement)', 'true'),
  rule('\\btaille (?:parfaite|correcte|idéale|conforme|exacte)', 'true'),
  rule('\\bbonne taille', 'true'),
  rule("\\bconforme (?:à la|au) (?:taille|guide)", 'true'),
  rule('\\btalla (?:perfecta|correcta|exacta|adecuada|real|justa)', 'true'),
  rule('\\b(?:queda|quedan|sienta|sientan) (?:perfect|genial|muy bien|bien)', 'true'),
  rule('\\b(?:se ajusta|corresponde|fiel) a la talla', 'true'),
  rule('\\btallaje (?:correcto|perfecto|exacto)', 'true'),
]

/** A negation just before a phrase cancels it ("not too small", "nicht zu klein", "non è troppo piccola", "pas trop petit"). */
const NEGATED = /(?:\bnot|n't|\bnever|\bnicht|\bkein\w*|\bnie|\bnon|\bpas|\bjamais|\bno|\bnunca)\b[^.!?;:,]{0,12}$/

function normalise(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/[’‘`´]/g, "'").replace(/\s+/g, ' ')
}

/**
 * The direction one text says, or 'mixed' (it says both small and large), or null (it says nothing about which way).
 * Every language of the map is read, whatever the review says its language is.
 */
export function fitDirectionOfText(text: string | null | undefined): FitDirection | 'mixed' | null {
  if (!text || !text.trim()) return null
  let t = normalise(text)
  const found = new Set<FitDirection>()
  for (const r of RULES) {
    r.re.lastIndex = 0
    t = t.replace(r.re, (match: string, ...rest: unknown[]) => {
      const offset = rest[rest.length - 2] as number
      const whole = rest[rest.length - 1] as string
      if (!NEGATED.test(whole.slice(Math.max(0, offset - 24), offset))) found.add(r.dir)
      return ' '.repeat(match.length)
    })
  }
  const small = found.has('small')
  const large = found.has('large')
  if (small && large) return 'mixed'
  if (small) return 'small'
  if (large) return 'large'
  return found.has('true') ? 'true' : null
}

export interface FitReviewText {
  title?: string | null
  body: string | null
  bodyEnglish?: string | null
  /** The review's themes (sentiment categories); null = never read by the AI. */
  categories?: readonly string[] | null
}

/**
 * The direction one review gives, or null. A review read without the fit theme never counts (null categories = not
 * read yet: the phrases alone decide). Its own words first; the English translation only when they say nothing.
 */
export function fitDirectionOfReview(r: FitReviewText): FitDirection | null {
  if (r.categories && !r.categories.includes('FIT_SIZING')) return null
  const own = fitDirectionOfText([r.title, r.body].filter(Boolean).join('. '))
  if (own === 'mixed') return null
  if (own) return own
  const english = fitDirectionOfText(r.bodyEnglish)
  return english === 'mixed' ? null : english
}

// ── Return reasons ──────────────────────────────────────────────────

const REASON_SMALL = /too (?:small|tight)|troppo (?:piccol|strett)|zu (?:klein|eng)|trop (?:petit|serr)|demasiado (?:pequeñ|chic)|runs small/
const REASON_LARGE = new RegExp(`too (?:large|big|loose)|troppo (?:grand|larg)|zu (?:${GROSS}|weit)|trop (?:grand|large)|demasiado grande|runs (?:large|big)`)
/** A reason about the fit that does not say which way ("does not fit", "wrong size", "taglia sbagliata"). */
const REASON_FIT = new RegExp(`\\bfit|\\bsiz(?:e|ing)\\b|taglia|misura|${GROSS}e|passt nicht|taille|talla`)

/**
 * The direction a return's reason gives: 'small' / 'large'; 'unclear' when the reason is about the fit without a way
 * and the buyer's comment does not say one either; null when the reason is not about the fit. The reason arrives as
 * the channel's code turned into words ("apparel too small", "size too large", "does not fit") or a person's text.
 */
export function returnFitDirection(reason: string | null | undefined, notes?: string | null): 'small' | 'large' | 'unclear' | null {
  const r = normalise(reason ?? '').replace(/[_-]+/g, ' ').trim()
  if (!r) return null
  if (REASON_SMALL.test(r)) return 'small'
  if (REASON_LARGE.test(r)) return 'large'
  if (!REASON_FIT.test(r)) return null
  const said = fitDirectionOfText(notes)
  return said === 'small' || said === 'large' ? said : 'unclear'
}

// ── Sizes ───────────────────────────────────────────────────────────

const bag = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/**
 * A variant's size: `categoryAttributes.variations` first, then the legacy `variantAttributes` (the order every
 * publisher reads); an explicit `size` key wins inside a bag, else any key that means size (Taglia, Größe, Taille …).
 */
export function sizeOfVariant(product: { variantAttributes?: unknown; categoryAttributes?: unknown }): string | null {
  const bags = [bag(bag(product.categoryAttributes).variations), bag(product.variantAttributes)]
  for (const b of bags) {
    const keys = Object.keys(b)
    const key = keys.find((k) => k === 'size') ?? keys.find((k) => canonicalVariantAxis(k) === 'size')
    const value = key ? b[key] : undefined
    if (typeof value === 'string' && value.trim()) return value.trim().replace(/\s+/g, ' ')
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

const LETTERS = ['XXXS', 'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '4XL', '5XL', '6XL']
const LETTER_ALIAS: Record<string, string> = { '3XS': 'XXXS', '2XS': 'XXS', '2XL': 'XXL', '3XL': 'XXXL', XXXXL: '4XL', XXXXXL: '5XL' }

/** The key two spellings of one size share ("xl" = "XL", "2XL" = "XXL"). */
export function sizeKey(size: string): string {
  const up = size.trim().replace(/\s+/g, ' ').toUpperCase()
  return LETTER_ALIAS[up] ?? up
}

function sizeRank(size: string): [number, number, string] {
  const key = sizeKey(size)
  const letter = LETTERS.indexOf(key)
  if (letter >= 0) return [0, letter, key]
  const n = key.match(/\d+(?:[.,]\d+)?/)
  if (n) return [1, Number(n[0].replace(',', '.')), key]
  return [2, 0, key]
}

/** Sizes in wearing order: XS, S, M, L, XL …, then numbers (40, 42, 42.5 …), then the rest A–Z ("One size"). */
export function compareSizes(a: string, b: string): number {
  const ra = sizeRank(a)
  const rb = sizeRank(b)
  return ra[0] - rb[0] || ra[1] - rb[1] || ra[2].localeCompare(rb[2])
}

// ── Verdicts ────────────────────────────────────────────────────────

export interface FitCounts {
  small: number
  true: number
  large: number
  /** Of the signals: how many came from reviews and from returns. */
  reviews: number
  returns: number
}

export interface FitCell extends FitCounts {
  size: string
  total: number
  verdict: FitVerdict
  /** Percent of the signals per direction (whole numbers); null below the minimum (no shares are shown then). */
  shares: { small: number; true: number; large: number } | null
  /** The verdict direction's share; null for mixed and too few. */
  share: number | null
  /** What the verdict is and what it rests on, in words. */
  words: string
}

export const emptyCounts = (): FitCounts => ({ small: 0, true: 0, large: 0, reviews: 0, returns: 0 })

const DIRECTION_WORDS: Record<FitDirection, string> = { small: 'Runs small', true: 'True to size', large: 'Runs large' }
const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-IE')} ${n === 1 ? one : many}`

/** "9 reviews and 3 returns", "1 review", "2 returns". */
export function basisWords(reviews: number, returns: number): string {
  const parts = [reviews ? plural(reviews, 'review', 'reviews') : null, returns ? plural(returns, 'return', 'returns') : null].filter(Boolean)
  return parts.length ? parts.join(' and ') : 'nothing yet'
}

/** One size's verdict from its signals (MIN_FIT_SIGNALS, leader with at least half, no tie). */
export function fitCell(size: string, counts: FitCounts, min = MIN_FIT_SIGNALS): FitCell {
  const total = counts.small + counts.true + counts.large
  const basis = basisWords(counts.reviews, counts.returns)
  if (total < min) {
    return {
      ...counts, size, total, verdict: 'too_few', shares: null, share: null,
      words: `Too few: ${plural(total, 'fit mention', 'fit mentions')} (${basis}); a size needs ${min} before it gets a verdict.`,
    }
  }
  const pctOf = (n: number) => Math.round((n / total) * 100)
  const shares = { small: pctOf(counts.small), true: pctOf(counts.true), large: pctOf(counts.large) }
  const ranked = (['small', 'true', 'large'] as const).map((d) => [d, counts[d]] as const).sort((a, b) => b[1] - a[1])
  const [lead, leadCount] = ranked[0]
  const tied = ranked[1][1] === leadCount
  if (tied || leadCount * 2 < total) {
    return {
      ...counts, size, total, verdict: 'mixed', shares, share: null,
      words: `Buyers disagree: no way leads with half of ${plural(total, 'fit mention', 'fit mentions')} (${counts.small} small, ${counts.true} true to size, ${counts.large} large; from ${basis}).`,
    }
  }
  return {
    ...counts, size, total, verdict: lead, shares, share: shares[lead],
    words: `${DIRECTION_WORDS[lead]}: ${leadCount} of ${plural(total, 'fit mention', 'fit mentions')} (${shares[lead]}%), from ${basis}.`,
  }
}

/** "What to tell buyers", from the sizes with a verdict only. */
export function familyAdvice(cells: ReadonlyArray<Pick<FitCell, 'size' | 'verdict'>>): string {
  const judged = cells.filter((c) => c.verdict !== 'too_few')
  if (judged.length === 0) return 'Too few fit mentions per size to tell buyers anything yet.'
  const by = (v: FitVerdict) => judged.filter((c) => c.verdict === v).map((c) => c.size)
  const small = by('small')
  const trueSize = by('true')
  const large = by('large')
  const mixed = by('mixed')
  const list = (sizes: string[]) => (sizes.length <= 1 ? sizes.join('') : `${sizes.slice(0, -1).join(', ')} and ${sizes[sizes.length - 1]}`)
  const every = judged.length > 1 ? `every size with enough mentions (${list(judged.map((c) => c.size))})` : `${judged[0].size}, the one size with enough mentions`
  if (small.length === judged.length) return `Runs small in ${every}: suggest one size up.`
  if (large.length === judged.length) return `Runs large in ${every}: suggest one size down.`
  if (trueSize.length === judged.length) return `True to size in ${every}.`
  if (mixed.length === judged.length) return `Buyers disagree about the fit in ${every}.`
  const parts: string[] = []
  if (small.length) parts.push(`${list(small)} ${small.length === 1 ? 'runs' : 'run'} small: suggest one size up`)
  if (large.length) parts.push(`${list(large)} ${large.length === 1 ? 'runs' : 'run'} large: suggest one size down`)
  if (trueSize.length) parts.push(`${list(trueSize)} ${trueSize.length === 1 ? 'is' : 'are'} true to size`)
  if (mixed.length) parts.push(`buyers disagree about ${list(mixed)}`)
  const text = parts.join('; ')
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`
}

// ── Tables ──────────────────────────────────────────────────────────

/** One signal, placed: its family, its product (a variant), the variant's size (null = names no size). */
export interface FitSignal {
  familyId: string
  productId: string
  size: string | null
  direction: FitDirection
  source: 'review' | 'return'
}

export interface FitFamilyInfo {
  id: string
  name: string
  sku: string
  /** The sizes the family sells (its variants' sizes). */
  sizes: readonly string[]
  /** Its variants with a size: "M · Black" (size and colour). */
  variants: ReadonlyArray<{ id: string; label: string; size: string | null }>
}

/** A family row of the Themes table: one cell per column size ("not sold" when the family has no such size). */
export interface FitFamilyRow {
  familyId: string
  name: string
  sku: string
  signals: number
  reviews: number
  returns: number
  /** Fit mentions on the family that name no size (counted, never placed). */
  noSize: number
  cells: Array<FitCell | { size: string; verdict: 'not_sold' }>
  advice: string
}

export interface FitTable {
  /** The columns: every size with a signal in a shown family, in wearing order. */
  sizes: string[]
  families: FitFamilyRow[]
  /** Families with signals that did not fit in the table (FIT_FAMILY_LIMIT). */
  moreFamilies: number
  summary: { reviews: number; returns: number; unclearReturns: number; noSize: number; minimum: number }
  /** What the table rests on, in words. */
  words: string
}

export interface ProductFit {
  family: { id: string; name: string }
  /** One row per size the family sells or has signals for. */
  sizes: FitCell[]
  /** One row per variant (size and colour). */
  variants: Array<FitCell & { productId: string; label: string }>
  reviews: number
  returns: number
  unclearReturns: number
  noSize: number
  advice: string
  words: string
  minimum: number
}

function add(counts: FitCounts, s: Pick<FitSignal, 'direction' | 'source'>): void {
  counts[s.direction] += 1
  if (s.source === 'review') counts.reviews += 1
  else counts.returns += 1
}

/** The words under the table and in the pop-up: what the verdicts rest on. */
export function fitBasisWords(input: { reviews: number; returns: number; unclearReturns: number; noSize: number; minimum?: number; amazonNote?: boolean }): string {
  const min = input.minimum ?? MIN_FIT_SIGNALS
  const parts = [
    `From ${plural(input.reviews, 'review', 'reviews')} that say how the fit runs and ${plural(input.returns, 'return', 'returns')} with the reason “too small” or “too large”.`,
  ]
  if (input.noSize) parts.push(`${plural(input.noSize, 'fit mention names', 'fit mentions name')} no size (the review is on the family, not a variant) and ${input.noSize === 1 ? 'is' : 'are'} not counted.`)
  if (input.unclearReturns) parts.push(`${plural(input.unclearReturns, 'return says', 'returns say')} only that it did not fit, without which way, and ${input.unclearReturns === 1 ? 'is' : 'are'} not counted.`)
  if (input.amazonNote !== false) parts.push('Amazon topics carry no size, so Amazon counts only through returns and imported reviews.')
  parts.push(`A size needs ${min} mentions before it gets a verdict.`)
  return parts.join(' ')
}

/** The Themes fit table: families with signals (most first), a cell per size. */
export function buildFitTable(input: {
  signals: readonly FitSignal[]
  families: ReadonlyMap<string, FitFamilyInfo>
  unclearReturns?: number
  limit?: number
  minimum?: number
}): FitTable {
  const min = input.minimum ?? MIN_FIT_SIGNALS
  const perFamily = new Map<string, { total: FitCounts; sizes: Map<string, { label: string; counts: FitCounts }>; noSize: number }>()
  const slot = (familyId: string) => {
    let f = perFamily.get(familyId)
    if (!f) perFamily.set(familyId, (f = { total: emptyCounts(), sizes: new Map(), noSize: 0 }))
    return f
  }
  for (const s of input.signals) {
    if (!input.families.has(s.familyId)) continue
    const f = slot(s.familyId)
    if (!s.size) {
      f.noSize += 1
      continue
    }
    add(f.total, s)
    const key = sizeKey(s.size)
    const cell = f.sizes.get(key) ?? { label: s.size, counts: emptyCounts() }
    add(cell.counts, s)
    f.sizes.set(key, cell)
  }

  const ranked = [...perFamily.entries()]
    .filter(([, f]) => f.total.reviews + f.total.returns > 0)
    .map(([id, f]) => ({ id, f, info: input.families.get(id)!, signals: f.total.reviews + f.total.returns }))
    .sort((a, b) => b.signals - a.signals || a.info.name.localeCompare(b.info.name))
  const limit = input.limit ?? FIT_FAMILY_LIMIT
  const shown = ranked.slice(0, limit)

  const columns = new Map<string, string>()
  for (const r of shown) for (const [key, c] of r.f.sizes) if (!columns.has(key)) columns.set(key, c.label)
  const sizes = [...columns.values()].sort(compareSizes)

  const families: FitFamilyRow[] = shown.map(({ id, f, info, signals }) => {
    const sold = new Set(info.sizes.map(sizeKey))
    const cells = sizes.map((size) => {
      const key = sizeKey(size)
      const c = f.sizes.get(key)
      if (c) return fitCell(size, c.counts, min)
      return sold.has(key) ? fitCell(size, emptyCounts(), min) : { size, verdict: 'not_sold' as const }
    })
    const judged = cells.filter((c): c is FitCell => c.verdict !== 'not_sold')
    return { familyId: id, name: info.name, sku: info.sku, signals, reviews: f.total.reviews, returns: f.total.returns, noSize: f.noSize, cells, advice: familyAdvice(judged) }
  })

  const reviews = ranked.reduce((n, r) => n + r.f.total.reviews, 0)
  const returns = ranked.reduce((n, r) => n + r.f.total.returns, 0)
  const noSize = [...perFamily.values()].reduce((n, f) => n + f.noSize, 0)
  const unclearReturns = input.unclearReturns ?? 0
  return {
    sizes,
    families,
    moreFamilies: Math.max(0, ranked.length - shown.length),
    summary: { reviews, returns, unclearReturns, noSize, minimum: min },
    words: fitBasisWords({ reviews, returns, unclearReturns, noSize, minimum: min }),
  }
}

/** One family's fit for the product pop-up: per size, and per variant (size and colour). */
export function buildProductFit(input: {
  signals: readonly FitSignal[]
  family: FitFamilyInfo
  unclearReturns?: number
  minimum?: number
}): ProductFit {
  const min = input.minimum ?? MIN_FIT_SIGNALS
  const mine = input.signals.filter((s) => s.familyId === input.family.id)
  const placed = mine.filter((s) => s.size)
  const bySize = new Map<string, { label: string; counts: FitCounts }>()
  for (const size of input.family.sizes) if (!bySize.has(sizeKey(size))) bySize.set(sizeKey(size), { label: size, counts: emptyCounts() })
  const byVariant = new Map<string, FitCounts>()
  const total = emptyCounts()
  for (const s of placed) {
    const key = sizeKey(s.size!)
    const slot = bySize.get(key) ?? { label: s.size!, counts: emptyCounts() }
    add(slot.counts, s)
    bySize.set(key, slot)
    const v = byVariant.get(s.productId) ?? emptyCounts()
    add(v, s)
    byVariant.set(s.productId, v)
    add(total, s)
  }
  const sizes = [...bySize.values()].sort((a, b) => compareSizes(a.label, b.label)).map((c) => fitCell(c.label, c.counts, min))
  const variants = input.family.variants
    .filter((v) => v.size)
    .map((v) => ({ ...fitCell(v.size!, byVariant.get(v.id) ?? emptyCounts(), min), productId: v.id, label: v.label }))
    .sort((a, b) => compareSizes(a.size, b.size) || a.label.localeCompare(b.label))
  const noSize = mine.length - placed.length
  const unclearReturns = input.unclearReturns ?? 0
  return {
    family: { id: input.family.id, name: input.family.name },
    sizes,
    variants,
    reviews: total.reviews,
    returns: total.returns,
    unclearReturns,
    noSize,
    advice: familyAdvice(sizes),
    words: fitBasisWords({ reviews: total.reviews, returns: total.returns, unclearReturns, noSize, minimum: min }),
    minimum: min,
  }
}

// ── Findings for the size-guide fixes ───────────────────────────────

/**
 * A family whose sizes run one way with enough evidence — Reviews › Fixes › Size guide (review-size-guide.ts). The
 * sizes are exactly the ones `fitCell` gives that verdict (the rule above: MIN_FIT_SIGNALS signals, the leader with at
 * least half, no tie); nothing here judges a size a second way.
 */
export interface FitFinding {
  familyId: string
  name: string
  sku: string
  direction: 'small' | 'large'
  /** The sizes with that verdict, in wearing order. */
  sizes: string[]
  /** Every size of the family (the sizes it sells, and any size with a signal), in wearing order. */
  familySizes: string[]
  /** Of the signals in those sizes that say this way: how many are reviews, how many returns. */
  reviews: number
  returns: number
  /** Each of those sizes' verdict in words (`fitCell`). */
  cells: Array<{ size: string; words: string }>
}

/** Every family whose sizes run small, and every family whose sizes run large (a family can do both, in other sizes). */
export function fitFindings(input: { signals: readonly FitSignal[]; families: ReadonlyMap<string, FitFamilyInfo>; minimum?: number }): FitFinding[] {
  const byFamily = new Map<string, FitSignal[]>()
  for (const s of input.signals) {
    const list = byFamily.get(s.familyId)
    if (list) list.push(s)
    else byFamily.set(s.familyId, [s])
  }
  const out: FitFinding[] = []
  for (const family of input.families.values()) {
    const signals = byFamily.get(family.id) ?? []
    if (signals.length === 0) continue
    const fit = buildProductFit({ signals, family, minimum: input.minimum })
    for (const direction of ['small', 'large'] as const) {
      const cells = fit.sizes.filter((c) => c.verdict === direction)
      if (cells.length === 0) continue
      const keys = new Set(cells.map((c) => sizeKey(c.size)))
      const behind = signals.filter((s) => s.direction === direction && s.size && keys.has(sizeKey(s.size)))
      out.push({
        familyId: family.id,
        name: family.name,
        sku: family.sku,
        direction,
        sizes: cells.map((c) => c.size),
        familySizes: fit.sizes.map((c) => c.size),
        reviews: behind.filter((s) => s.source === 'review').length,
        returns: behind.filter((s) => s.source === 'return').length,
        cells: cells.map((c) => ({ size: c.size, words: c.words })),
      })
    }
  }
  const order = { small: 0, large: 1 } as const
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.familyId.localeCompare(b.familyId) || order[a.direction] - order[b.direction])
}
