/**
 * Reviews › Insights › Fixes › Size guide — pure: a size-guide fix from fit by size (review-fit.ts `fitFindings`).
 *
 * When a product family's sizes run small or large by the fit rule (a size needs MIN_FIT_SIGNALS reviews or size
 * returns, the leader with at least half of them, no tie — `fitCell`; nothing here judges a size again), Fixes offers
 * one fix per family and direction:
 *   what is wrong   "Runs small: 7 reviews and 4 size returns say so for sizes M–L" (English, the title)
 *   the change      "Tell buyers to order one size up in sizes M–L" — a new last bullet point of the family's text in
 *                   the business's source language (a fixed sentence per language, never the AI), and the same advice
 *                   for the size guide, which Nexus does not keep (added by hand)
 *   the evidence    each judged size's verdict in words, over SIZE_GUIDE_PERIOD
 * Sent for approval it is one set-content step (review-fix-plan.service.ts): Nexus only; the channels change through
 * Publish. Nothing goes to a channel by itself.
 *
 * The re-check (`planSizeGuideRecheck`, run by review-size-guide.service.ts) keeps ONE open fix per family and
 * direction: it refreshes the open one, closes duplicates, closes an open fix whose evidence is gone, and never makes a
 * new fix while a person's decision on the last one stands (sent, applied, dismissed) — only once that evidence went
 * away and came back.
 */
import { MIN_FIT_SIGNALS, type FitDirection, type FitFinding } from './review-fit.js'

export type SizeDirection = Exclude<FitDirection, 'true'>

/** The longest Insights period: a size guide rests on a year of reviews and returns. */
export const SIZE_GUIDE_PERIOD = '12m' as const
export const SIZE_GUIDE_WINDOW_WORDS = 'the last 12 months'
/** `ReviewActionItem.source` of a fix the re-check made (the Fixes page says "from fit by size", never "by AI"). */
export const SIZE_GUIDE_SOURCE = 'fit-by-size'
export const SIZE_GUIDE_CREATED_BY = 'nexus:fit-by-size'
export const SIZE_GUIDE_THEME = 'FIT_SIZING'
/** A bullet point is at most this long (the Fixes edit window's rule). */
export const SIZE_GUIDE_LINE_MAX = 500

export interface SizeGuidePayload {
  direction: SizeDirection
  /** The sizes judged that way, in wearing order. */
  sizes: string[]
  /** The same in words: "M–L", "S, M and XL". */
  sizesText: string
  /** They are every size of the family: the sentence names no size. */
  allSizes: boolean
  /** Of the signals in those sizes that say this way. */
  reviews: number
  returns: number
  /** "M — Runs small: 5 of 6 fit mentions (83%), from 4 reviews and 2 returns." per size. */
  evidence: string[]
  /** "Tell buyers to order one size up in sizes M–L: in the size guide and in the listing text." */
  advice: string
  /** The language of `line`: the business's source language. */
  language: string
  /** The new last bullet point in `language`; null when Nexus has no sentence in that language (edit the proposal). */
  line: string | null
  /** What `line` says in English. */
  english: string
  /** A person edited the title or the bullet: a re-check with the same sizes keeps their words. */
  edited?: boolean
  checkedAt: string
  /** The evidence went away (a closed or decided fix): when it comes back, the re-check makes a new fix. */
  evidenceGoneAt?: string | null
  /** Closed by the re-check (Open → Dismissed), with why. */
  closed?: { words: string; at: string } | null
}

// ── Words ───────────────────────────────────────────────────────────

const AND: Record<string, string> = { en: 'and', it: 'e', de: 'und', fr: 'et', es: 'y' }

/**
 * "M–L" when the sizes follow each other in the family's own order, else "S, M and XL" (in `language`); one size as
 * it is. `familySizes` is the family's wearing order (`FitFinding.familySizes`).
 */
export function sizesWords(sizes: readonly string[], familySizes: readonly string[], language = 'en'): string {
  if (sizes.length <= 1) return sizes.join('')
  const at = sizes.map((s) => familySizes.indexOf(s))
  const follow = at.every((i, n) => i >= 0 && (n === 0 || i === at[n - 1] + 1))
  if (follow) return `${sizes[0]}–${sizes[sizes.length - 1]}`
  return `${sizes.slice(0, -1).join(', ')} ${AND[language] ?? AND.en} ${sizes[sizes.length - 1]}`
}

type Sentence = (direction: SizeDirection, sizes: string | null, many: boolean) => string

/**
 * The new bullet point per language: the languages the fit phrase map reads (FIT_LANGUAGES), so the map reads each
 * sentence back as its own direction (tested). `sizes` null = every size of the family.
 */
const SENTENCES: Record<string, Sentence> = {
  en: (d, s, many) =>
    `${s ? `${many ? 'Sizes' : 'Size'} ${s} ${many ? 'run' : 'runs'} ${d}` : `Runs ${d}`}: we suggest ordering one size ${d === 'small' ? 'up' : 'down'}.`,
  it: (d, s, many) =>
    `${s ? (many ? `Le taglie ${s} vestono ${d === 'small' ? 'piccole' : 'grandi'}` : `La taglia ${s} veste ${d === 'small' ? 'piccola' : 'grande'}`) : `Veste ${d === 'small' ? 'piccolo' : 'grande'}`}: consigliamo di ordinare una taglia in ${d === 'small' ? 'più' : 'meno'}.`,
  de: (d, s, many) =>
    `${s ? (many ? `Die Größen ${s} fallen` : `Größe ${s} fällt`) : 'Fällt'} ${d === 'small' ? 'klein' : 'groß'} aus: wir empfehlen, eine Größe ${d === 'small' ? 'größer' : 'kleiner'} zu bestellen.`,
  fr: (d, s, many) =>
    `${s ? `En ${many ? 'tailles' : 'taille'} ${s}, ce modèle` : 'Ce modèle'} taille ${d === 'small' ? 'petit' : 'grand'} : nous conseillons de prendre une taille ${d === 'small' ? 'au-dessus' : 'en dessous'}.`,
  es: (d, s, many) =>
    `${s ? `En ${many ? 'las tallas' : 'la talla'} ${s}, este modelo` : 'Este modelo'} talla ${d === 'small' ? 'pequeño' : 'grande'}: recomendamos pedir una talla ${d === 'small' ? 'más' : 'menos'}.`,
}

/** The languages Nexus writes the sizing bullet in. */
export const SIZE_GUIDE_LANGUAGES = Object.keys(SENTENCES)

/** The sizing bullet in `language`, or null when Nexus has no sentence in it. */
export function sizingLine(direction: SizeDirection, sizes: readonly string[], familySizes: readonly string[], allSizes: boolean, language: string): string | null {
  const sentence = SENTENCES[language]
  if (!sentence) return null
  return sentence(direction, allSizes ? null : sizesWords(sizes, familySizes, language), sizes.length > 1)
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-IE')} ${n === 1 ? one : many}`

/** "Runs small: 7 reviews and 4 size returns say so for sizes M–L". */
export function sizeGuideTitle(f: Pick<FitFinding, 'direction' | 'sizes' | 'familySizes' | 'reviews' | 'returns'>): string {
  const basis = [f.reviews ? count(f.reviews, 'review', 'reviews') : null, f.returns ? count(f.returns, 'size return', 'size returns') : null].filter(Boolean).join(' and ')
  const verb = f.reviews + f.returns === 1 ? 'says' : 'say'
  const sizes = `${f.sizes.length > 1 ? 'sizes' : 'size'} ${sizesWords(f.sizes, f.familySizes)}`
  return `Runs ${f.direction}: ${basis} ${verb} so for ${sizes}`
}

/** "Tell buyers to order one size up in sizes M–L: in the size guide and in the listing text." */
export function sizeGuideAdvice(f: Pick<FitFinding, 'direction' | 'sizes' | 'familySizes'>, allSizes: boolean): string {
  const where = allSizes ? '' : ` in ${f.sizes.length > 1 ? 'sizes' : 'size'} ${sizesWords(f.sizes, f.familySizes)}`
  return `Tell buyers to order one size ${f.direction === 'small' ? 'up' : 'down'}${where}: in the size guide and in the listing text.`
}

export const SIZE_GUIDE_DETAIL = `From fit by size over ${SIZE_GUIDE_WINDOW_WORDS}: a size needs ${MIN_FIT_SIGNALS} fit mentions (reviews, or returns marked too small or too large), and at least half of them saying one way.`

/** The fix one finding makes: its title, its detail and its payload (in the business's source `language`). */
export function sizeGuideFix(f: FitFinding, language: string, now: Date): { title: string; detail: string; payload: SizeGuidePayload } {
  const allSizes = f.sizes.length === f.familySizes.length
  return {
    title: sizeGuideTitle(f),
    detail: SIZE_GUIDE_DETAIL,
    payload: {
      direction: f.direction,
      sizes: [...f.sizes],
      sizesText: sizesWords(f.sizes, f.familySizes),
      allSizes,
      reviews: f.reviews,
      returns: f.returns,
      evidence: f.cells.map((c) => `${c.size} — ${c.words}`),
      advice: sizeGuideAdvice(f, allSizes),
      language,
      line: sizingLine(f.direction, f.sizes, f.familySizes, allSizes, language),
      english: sizingLine(f.direction, f.sizes, f.familySizes, allSizes, 'en')!,
      edited: false,
      checkedAt: now.toISOString(),
      evidenceGoneAt: null,
      closed: null,
    },
  }
}

// ── The re-check ────────────────────────────────────────────────────

export interface SizeGuideRow {
  id: string
  productId: string | null
  status: string
  title: string
  detail: string | null
  payload: unknown
  createdAt: Date
}

export type SizeGuideStep =
  | { op: 'create'; productId: string; title: string; detail: string; payload: SizeGuidePayload }
  /** An open fix, with the evidence of now. */
  | { op: 'refresh'; id: string; title: string; detail: string; payload: Record<string, unknown> }
  /** Open → Dismissed: its evidence is gone, or a newer open fix says the same. */
  | { op: 'close'; id: string; payload: Record<string, unknown> }
  /** A decided fix (applied, dismissed): its evidence went away, so it may come back as a new fix. */
  | { op: 'gone'; id: string; payload: Record<string, unknown> }

const bag = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const directionOf = (v: unknown): SizeDirection | null => (v === 'small' || v === 'large' ? v : null)
const keyOf = (productId: string, direction: SizeDirection) => `${productId}|${direction}`
const newestFirst = (a: SizeGuideRow, b: SizeGuideRow) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const without = (p: Record<string, unknown>, ...keys: string[]) => Object.fromEntries(Object.entries(p).filter(([k]) => !keys.includes(k)))

export const DUPLICATE_WORDS = 'Closed by Nexus: a newer size-guide fix for this product says the same.'
/** "Closed by Nexus: the reviews and returns of the last 12 months no longer say sizes M–L run small." */
export function goneWords(payload: Record<string, unknown>): string {
  const sizes = Array.isArray(payload.sizes) ? payload.sizes.filter((s): s is string => typeof s === 'string') : []
  const one = sizes.length === 1 && payload.allSizes !== true
  const which = payload.allSizes === true || sizes.length === 0
    ? 'its sizes'
    : `${one ? 'size' : 'sizes'} ${typeof payload.sizesText === 'string' && payload.sizesText ? payload.sizesText : sizes.join(', ')}`
  return `Closed by Nexus: the reviews and returns of ${SIZE_GUIDE_WINDOW_WORDS} no longer say ${which} ${one ? 'runs' : 'run'} ${payload.direction === 'large' ? 'large' : 'small'}.`
}

/**
 * What the re-check changes, from the size-guide fixes there are (any status) and the findings of now. Pure; the rows
 * the business made by hand without a direction are left alone.
 */
export function planSizeGuideRecheck(rows: readonly SizeGuideRow[], findings: readonly FitFinding[], language: string, now: Date): SizeGuideStep[] {
  const groups = new Map<string, SizeGuideRow[]>()
  for (const row of rows) {
    const direction = directionOf(bag(row.payload).direction)
    if (!row.productId || !direction) continue
    const key = keyOf(row.productId, direction)
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  for (const list of groups.values()) list.sort(newestFirst)
  const at = now.toISOString()
  const steps: SizeGuideStep[] = []
  const found = new Set<string>()

  for (const f of findings) {
    const key = keyOf(f.familyId, f.direction)
    if (found.has(key)) continue
    found.add(key)
    const list = groups.get(key) ?? []
    const fresh = sizeGuideFix(f, language, now)
    const open = list.filter((r) => r.status === 'OPEN')
    if (open.length > 0) {
      const [keep, ...extra] = open
      const before = bag(keep.payload)
      // A person's words stay while the sizes stay the same; new sizes are new evidence, so new words.
      const kept = before.edited === true && sameJson(before.sizes, fresh.payload.sizes)
      const payload: Record<string, unknown> = {
        ...before,
        ...fresh.payload,
        ...(kept ? { line: before.line ?? null, english: before.english ?? fresh.payload.english, language: before.language ?? language, edited: true } : {}),
      }
      const title = kept ? keep.title : fresh.title
      if (title !== keep.title || fresh.detail !== keep.detail || !sameJson(without(payload, 'checkedAt'), without(before, 'checkedAt'))) {
        steps.push({ op: 'refresh', id: keep.id, title, detail: fresh.detail, payload })
      }
      for (const dup of extra) steps.push({ op: 'close', id: dup.id, payload: { ...bag(dup.payload), closed: { words: DUPLICATE_WORDS, at } } })
      continue
    }
    // A person's decision stands while its evidence does: sent (waiting), applied or dismissed.
    if (list.some((r) => r.status === 'SENT')) continue
    const newest = list[0]
    if (!newest || bag(newest.payload).evidenceGoneAt) steps.push({ op: 'create', productId: f.familyId, ...fresh })
  }

  for (const [key, list] of groups) {
    if (found.has(key)) continue
    const open = list.filter((r) => r.status === 'OPEN')
    for (const row of open) {
      const payload = bag(row.payload)
      steps.push({ op: 'close', id: row.id, payload: { ...payload, evidenceGoneAt: at, closed: { words: goneWords(payload), at } } })
    }
    if (open.length > 0) continue
    const newest = list[0]
    if ((newest.status === 'APPLIED' || newest.status === 'DISMISSED') && !bag(newest.payload).evidenceGoneAt) {
      steps.push({ op: 'gone', id: newest.id, payload: { ...bag(newest.payload), evidenceGoneAt: at } })
    }
  }
  return steps
}
