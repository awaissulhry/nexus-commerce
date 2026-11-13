import type { Words } from '../record/lines-depth/model'
import type { LeftOut, OpenInquiry, QuoteTemplate, StartBody, TemplateLine, TemplateRow } from './api'

/**
 * New quote › Start from: Template or Inquiry (design pop:quotes.new), pure: which template lines the person picks for
 * (a colourway chosen at use, the pieces typed at use, or the line left out), the body the start sends, and what the API
 * left out in this dialog's words (its reasons are English: B-W2b-294's quote-templates start and B-W2b-295's inquiry quote
 * are matched here by kind, and the line's place said from its seq).
 */

export type NewFromKind = 'template' | 'inquiry'

/** What the person picks for one open template line (typed as text; the start sends whole pieces). */
export interface LinePick {
  colourwayId: string
  sizes: Record<string, string>
  skip: boolean
}

export interface TemplatePick {
  query: string
  /** null: not read yet. */
  results: TemplateRow[] | null
  problem: string | null
  chosenId: string
  template: { status: 'loading' } | { status: 'ready'; value: QuoteTemplate } | { status: 'error'; problem: string } | null
  /** Each open line's style (its colourways and sizes), read once. */
  styles: Readonly<Record<string, { colourways: Array<{ id: string; code: string; name: string; status: string; offeredSizes: string[] }>; sizes: string[] } | null>>
  picks: Readonly<Record<string, LinePick>>
}

export interface InquiryPick {
  results: OpenInquiry[] | null
  problem: string | null
  chosenId: string
}

/** The start's receipt, said before the new quote opens (what was left out). */
export interface StartDone {
  quoteId: string
  number: string
  from: string
  lines: number | null
  leftOut: LeftOut[]
  warnings: number
}

export interface NewFromModel {
  active: NewFromKind | null
  template: TemplatePick | null
  inquiry: InquiryPick | null
  done: StartDone | null
  /** May the person read inquiries (sales.inquiries.view) and make a quote of one (sales.inquiries.manage)? */
  inquiries: { view: boolean; manage: boolean }
}

/** A template line the person must pick for: its colourway or its pieces are chosen at use (a fee line never). */
export const isOpenLine = (line: Pick<TemplateLine, 'kind' | 'colourwayId' | 'sizes'>): boolean => line.kind === 'SIZE_GRID' && (line.colourwayId === null || line.sizes === null)

export const openLines = (template: Pick<QuoteTemplate, 'lines'>): TemplateLine[] => template.lines.filter(isOpenLine).sort((a, b) => a.seq - b.seq)

const whole = (text: string | undefined): number | null => {
  const trimmed = (text ?? '').trim()
  return /^\d{1,6}$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null
}

/** The start's lines: each open line's pick (a line not filled in is left out by the API, in words). */
export function startLines(template: Pick<QuoteTemplate, 'lines'>, picks: Readonly<Record<string, LinePick>>): StartBody['lines'] {
  return openLines(template).map((line) => {
    const pick = picks[line.id]
    if (!pick || pick.skip) return { templateLineId: line.id, skip: true }
    const sizes = line.sizes === null ? Object.fromEntries(Object.entries(pick.sizes).flatMap(([size, text]) => { const pieces = whole(text); return pieces && pieces > 0 ? [[size, pieces]] : [] })) : null
    return {
      templateLineId: line.id,
      ...(line.colourwayId === null && pick.colourwayId ? { colourwayId: pick.colourwayId } : {}),
      ...(sizes && Object.keys(sizes).length > 0 ? { sizes } : {}),
    }
  })
}

/** Why Create from a template waits, or null. */
export function templateHeld(pick: TemplatePick | null): Words | null {
  if (!pick || !pick.chosenId) return { key: 'from.held.template' }
  if (!pick.template || pick.template.status === 'loading') return { key: 'from.held.reading' }
  if (pick.template.status === 'error') return { key: 'from.held.templateFailed' }
  for (const line of openLines(pick.template.value)) {
    const chosen = pick.picks[line.id]
    if (!chosen || chosen.skip) continue
    const bad = Object.entries(chosen.sizes).find(([, text]) => text.trim() !== '' && whole(text) === null)
    if (bad) return { key: 'from.held.pieces', params: { line: line.seq, size: bad[0] } }
  }
  return null
}

/** Why Create from an inquiry waits, or null. */
export function inquiryHeld(pick: InquiryPick | null, can: NewFromModel['inquiries']): Words | null {
  if (!can.view) return { key: 'from.held.noInquiries' }
  if (!can.manage) return { key: 'from.held.noInquiryManage' }
  if (!pick || !pick.chosenId) return { key: 'from.held.inquiry' }
  return null
}

/**
 * One thing a start left out, in this dialog's words. The template start (B-W2b-294/-302) and the inquiry quote
 * (B-W2b-295, through W1's copy) answer English reasons: matched here by kind; anything new says "not added" with its line.
 */
export function leftOutWords(entry: LeftOut): Words {
  const line = entry.seq
  const reason = entry.reason
  if (entry.size !== null) return { key: 'from.left.size', params: { line, size: entry.size } }
  if (/Left out when the quote was made/.test(reason)) return { key: 'from.left.skipped', params: { line } }
  if (/fee without a price/i.test(reason)) return { key: 'from.left.feeNoPrice', params: { line } }
  if (/fee is net/i.test(reason)) return { key: 'from.left.feeNet', params: { line } }
  if (/colourway is chosen/i.test(reason)) return { key: 'from.left.noColourway', params: { line } }
  if (/pieces per size are typed/i.test(reason)) return { key: 'from.left.noSizes', params: { line } }
  if (/none of its sizes/i.test(reason)) return { key: 'from.left.noneOffered', params: { line } }
  if (/made-to-measure/i.test(reason)) return { key: 'from.left.mtm', params: { line } }
  if (/private.label/i.test(reason)) return { key: 'from.left.privateLabel', params: { line } }
  if (/released/i.test(reason)) return { key: 'from.left.scope', params: { line } }
  if (/archived/i.test(reason)) return { key: 'from.left.archived', params: { line } }
  if (/style/i.test(reason)) return { key: 'from.left.noStyle', params: { line } }
  if (/colourway/i.test(reason)) return { key: 'from.left.noColourway', params: { line } }
  if (/size|piece/i.test(reason)) return { key: 'from.left.noSizes', params: { line } }
  return { key: 'from.left.other', params: { line } }
}

export const EMPTY_TEMPLATE_PICK: TemplatePick = { query: '', results: null, problem: null, chosenId: '', template: null, styles: {}, picks: {} }
export const EMPTY_INQUIRY_PICK: InquiryPick = { results: null, problem: null, chosenId: '' }
