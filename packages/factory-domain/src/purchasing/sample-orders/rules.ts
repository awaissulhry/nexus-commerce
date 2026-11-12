import { KIND_WORDS, type SampleKind, type SampleStage } from '../../sales/samples/rules'

/**
 * Sample and development orders (B-W2b-347; SCM-043; design purchasing.sourcing, SCR-222), pure: a purchase order of kind SAMPLE
 * buys sample hides, swatches and colour cards for a style in development, or for one of its sample rounds
 * (PurchaseOrder.developmentStyleId, sampleRoundId; factory-db buying-depth, B-W2b-285). It is an ordinary order in every other
 * way (numbered from the company's PURCHASE_ORDER series, drafted, sent with its PDF, confirmed, received), but it is not
 * production buying: planning never nets it against what production needs, a plan's or a request's lines never land on it,
 * and the spend of production leaves it out (PRODUCTION_ORDER_KINDS, the readers' one list). The words a supplier reads and
 * the refusals with their codes live here; the screen says its own words from the codes.
 */

/** The kinds of purchase order that are production buying: netted by planning, counted in production spend. */
export const PRODUCTION_ORDER_KINDS = ['STANDARD'] as const
export const SAMPLE_ORDER_KIND = 'SAMPLE' as const
export type PurchaseOrderKind = (typeof PRODUCTION_ORDER_KINDS)[number] | typeof SAMPLE_ORDER_KIND

/** Whether an order of this kind is production buying (planning nets it; production spend counts it). */
export const countsInProductionSpend = (kind: string): boolean => (PRODUCTION_ORDER_KINDS as readonly string[]).includes(kind)

/** What a sample line buys: a whole sample hide, a swatch (a cut piece of the material), a colour card. */
export const SAMPLE_LINE_KINDS = ['HIDE', 'SWATCH', 'COLOUR_CARD'] as const
export type SampleLineKind = (typeof SAMPLE_LINE_KINDS)[number]

/** At most this many lines in the New sample order dialog (W1's order holds more: the buyer adds them on the record). */
export const MAX_SAMPLE_LINES = 20

type Words = { readonly it: string; readonly en: string }

/** What the supplier reads first in a sample line's description, in its language. */
export const SAMPLE_LINE_WORDS: Readonly<Record<SampleLineKind, Words>> = Object.freeze({
  HIDE: { it: 'Pelle campione', en: 'Sample hide' },
  SWATCH: { it: 'Campione di materiale', en: 'Swatch' },
  COLOUR_CARD: { it: 'Cartella colori', en: 'Colour card' },
})

/** The line's description as it is stored and printed: the sample words, then the buyer's own (one line of text). */
export function sampleLineDescription(kind: SampleLineKind, language: 'it' | 'en', own: string | null | undefined): string {
  const words = SAMPLE_LINE_WORDS[kind][language]
  const extra = own?.trim() ?? ''
  return extra === '' ? words : `${words} · ${extra}`
}

// ---- refusals -------------------------------------------------------------------------------------------------------------

export const SAMPLE_ORDER_REFUSALS = [
  /** The order named is not a sample order. */
  'NOT_A_SAMPLE_ORDER',
  /** The style is archived or discontinued: no development buying for it. */
  'STYLE_CLOSED',
  /** The sample round is decided or cancelled. */
  'ROUND_CLOSED',
  /** The sample round is another style's. */
  'ROUND_OF_ANOTHER_STYLE',
  /** A sample hide is leather. */
  'HIDE_NOT_LEATHER',
  /** A sample order buys materials, never a finished garment. */
  'NOT_A_MATERIAL',
  /** A plan's or a request's production lines never go on a sample order. */
  'SAMPLE_ORDER_TAKES_NO_PLAN_LINES',
] as const
export type SampleOrderRefusalCode = (typeof SAMPLE_ORDER_REFUSALS)[number]
export interface SampleOrderRefusal {
  readonly code: SampleOrderRefusalCode
  readonly message: string
}
const refusal = (code: SampleOrderRefusalCode, message: string): SampleOrderRefusal => ({ code, message })

/** A style takes development buying unless it is archived or discontinued (the sample rounds' own rule, B-W2b-246). */
export function developmentStyleRefusal(style: { readonly code: string; readonly status: string; readonly lifecycle: string }): SampleOrderRefusal | null {
  if (style.status === 'ARCHIVED') return refusal('STYLE_CLOSED', `Style ${style.code} is archived: reactivate it before buying samples for it.`)
  if (style.lifecycle === 'DISCONTINUED') return refusal('STYLE_CLOSED', `Style ${style.code} is discontinued: no samples are bought for it.`)
  return null
}

/** The stages of a sample round that still take sample buying (a decided or cancelled round is closed). */
export const OPEN_ROUND_STAGES: readonly SampleStage[] = ['REQUESTED', 'IN_MAKING', 'SENT', 'UNDER_REVIEW']

/** A round takes sample buying while it is open, and only for its own style. */
export function sampleRoundRefusal(round: { readonly number: string; readonly styleId: string; readonly stage: SampleStage }, styleId: string): SampleOrderRefusal | null {
  if (round.styleId !== styleId) return refusal('ROUND_OF_ANOTHER_STYLE', `Sample round ${round.number} is another style's: choose a round of the style the samples are for.`)
  if (!OPEN_ROUND_STAGES.includes(round.stage)) return refusal('ROUND_CLOSED', `Sample round ${round.number} is ${round.stage === 'DECIDED' ? 'decided' : 'cancelled'}: buy for an open round, or for the style alone.`)
  return null
}

/** What a sample line may buy: a material (never a finished garment); a sample hide is leather. */
export function sampleLineRefusal(kind: SampleLineKind, item: { readonly code: string; readonly kind: string }): SampleOrderRefusal | null {
  if (item.kind === 'FINISHED') return refusal('NOT_A_MATERIAL', `${item.code} is a finished garment: a sample order buys materials.`)
  if (kind === 'HIDE' && item.kind !== 'LEATHER') return refusal('HIDE_NOT_LEATHER', `${item.code} is not leather: a sample hide is a hide of a leather.`)
  return null
}

/** A plan's or a request's lines go on production orders only. */
export const planLinesRefusal = (number: string): SampleOrderRefusal =>
  refusal('SAMPLE_ORDER_TAKES_NO_PLAN_LINES', `${number} is a sample order: what the plan or a request buys goes on a production order of the supplier.`)

export const notASampleOrder = (number: string): SampleOrderRefusal => refusal('NOT_A_SAMPLE_ORDER', `${number} is not a sample order.`)

// ---- the development project in words -----------------------------------------------------------------------------------

export interface DevelopmentFacts {
  /** Null only for a SAMPLE order the database holds without its style (no route writes one). */
  readonly style: { readonly code: string; readonly name: string } | null
  readonly round: { readonly number: string; readonly kind: SampleKind; readonly roundNo: number } | null
}

/** "GIA-DEMO-01 Giacca Demo · Prototipo, giro 1 (SR-2026-0003)": what the sample order is for, in the reader's language ('' without a style). */
export function developmentWords(facts: DevelopmentFacts, language: 'it' | 'en'): string {
  if (!facts.style) return ''
  const style = `${facts.style.code} ${facts.style.name}`.trim()
  if (!facts.round) return style
  const round = `${KIND_WORDS[facts.round.kind][language]}, ${language === 'it' ? 'giro' : 'round'} ${facts.round.roundNo}`
  return `${style} · ${round} (${facts.round.number})`
}
