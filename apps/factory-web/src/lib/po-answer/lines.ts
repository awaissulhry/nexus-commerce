import type { LineAnswerKind, LineDraft, LineRequest } from '@nexus/ui/patterns/LineResponseList/index'
import type { Locale } from '../i18n/locales'
import { plainQuantity, quantityShown } from './quantities'

/**
 * A purchase order's lines answered with the DS LineResponseList (B-W2b-155) — the supplier portal's "Confirm or propose"
 * (portal.supplier.orders) and the PO link's "Your answer" / "Propose a change" (links.po) share these rules, pure:
 *
 *   the line as the request asks it   the supplier's codes first, our description, colour, the leather facts, the Cr VI
 *                                      report as a tag, the quantity and the date as asked, the articles it may offer
 *   the answer as the API takes it     the part's kinds ↔ the API's (CANNOT ↔ CANNOT_DELIVER), quantities from what was
 *                                      typed in the page's language, a SUBSTITUTE's article and/or words, a CHANGE's words
 *
 * The words come from the page's catalogue through `t` (keys `lines.*` and `uom.*`, the same in `portal-supplier-orders`
 * and `po-confirm-link`). No price anywhere (Owner answer C2). In src/lib because the links view and the portal view share
 * it (a view never imports another: check-view-boundaries).
 */

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** The API's line answers (factory-domain purchasing/portal-orders PORTAL_LINE_ANSWERS: W1's four and the W2b two). */
export const PORTAL_LINE_ANSWERS = ['AS_ASKED', 'OTHER', 'SPLIT', 'CANNOT_DELIVER', 'SUBSTITUTE', 'CHANGE'] as const
export type PortalLineAnswer = (typeof PORTAL_LINE_ANSWERS)[number]

/** A line's answer as the API takes it (the portal's POST …/confirm and, for W1's four, the link's). */
export interface PortalLineBody {
  readonly lineId: string
  readonly answer: PortalLineAnswer
  readonly quantity?: string | null
  readonly date?: string | null
  readonly deliveries?: { quantity: string; date: string }[] | null
  readonly reason?: string | null
  readonly substituteItemId?: string | null
  readonly substituteNote?: string | null
}

/** The DS part's kinds and the API's line answers, one for one. */
export const API_KIND: Readonly<Record<LineAnswerKind, PortalLineAnswer>> = Object.freeze({ AS_ASKED: 'AS_ASKED', OTHER: 'OTHER', SPLIT: 'SPLIT', CANNOT: 'CANNOT_DELIVER', SUBSTITUTE: 'SUBSTITUTE', CHANGE: 'CHANGE' })
export const DS_KIND: Readonly<Record<PortalLineAnswer, LineAnswerKind>> = Object.freeze({ AS_ASKED: 'AS_ASKED', OTHER: 'OTHER', SPLIT: 'SPLIT', CANNOT_DELIVER: 'CANNOT', SUBSTITUTE: 'SUBSTITUTE', CHANGE: 'CHANGE' })

/** The kinds the request allows, as the part names them (the API's order kept; unknown answers left out). */
export function kindsOf(lineAnswers: readonly string[]): LineAnswerKind[] {
  return lineAnswers.flatMap((answer) => (answer in DS_KIND ? [DS_KIND[answer as PortalLineAnswer]] : []))
}

/** The fields of a purchase order line the answer reads (the portal's and the link's lines both have them). */
export interface AnswerableLine {
  readonly id: string
  readonly seq: number
  readonly code: string | null
  readonly name: string | null
  readonly colour: { readonly name: string | null; readonly supplierCode: string | null } | null
  readonly description: string | null
  readonly quantity: string
  readonly uom: string
  readonly needDate: string
  readonly grade: string | null
  readonly thicknessMinMm: string | null
  readonly thicknessMaxMm: string | null
  readonly oneDyeBatch: boolean
  readonly areaTolerancePct: string | null
  readonly estimatedHides: number | null
  readonly requiresCrViTest: boolean
  readonly note: string | null
  readonly confirmedQuantity: string | null
  readonly confirmedDate: string | null
  /** Confirmed by an earlier answer: not answered again (the portal). */
  readonly locked?: boolean
  /** Cancelled or closed short: not answered at all. */
  readonly ended?: 'CANCELLED' | 'CLOSED_SHORT' | null
}

/** "VACH-NAPPA-12 · Vacchetta nappa": the supplier's code (else ours) first, then our name or description. */
export function lineTitle(line: Pick<AnswerableLine, 'code' | 'name' | 'description'>): string {
  return [line.code, line.name ?? line.description].filter((part): part is string => Boolean(part && part.trim())).join(' · ') || '—'
}

/** The line's facts in the supplier's words: colour (their code), grade, thickness, one dye batch, tolerance, hides. */
export function lineFacts(line: AnswerableLine, t: Translate, locale: Locale = 'it'): string[] {
  const n = (value: string) => (/^\d+(?:\.\d+)?$/.test(value) ? quantityShown(value, locale) : value)
  const facts: string[] = []
  if (line.colour?.name || line.colour?.supplierCode) {
    const colour = line.colour.name ?? line.colour.supplierCode ?? ''
    facts.push(line.colour.supplierCode && line.colour.name ? `${t('lines.colour', { colour })} · ${t('lines.yourCode', { code: line.colour.supplierCode })}` : t('lines.colour', { colour }))
  }
  if (line.grade) facts.push(t('lines.grade', { grade: line.grade }))
  if (line.thicknessMinMm && line.thicknessMaxMm) facts.push(t('lines.thickness', { min: n(line.thicknessMinMm), max: n(line.thicknessMaxMm) }))
  else if (line.thicknessMinMm) facts.push(t('lines.thicknessFrom', { min: n(line.thicknessMinMm) }))
  else if (line.thicknessMaxMm) facts.push(t('lines.thicknessUpTo', { max: n(line.thicknessMaxMm) }))
  if (line.oneDyeBatch) facts.push(t('lines.oneDyeBatch'))
  if (line.areaTolerancePct) facts.push(t('lines.tolerance', { pct: n(line.areaTolerancePct) }))
  if (line.estimatedHides !== null && line.estimatedHides > 0) facts.push(t('lines.hides', { count: line.estimatedHides }))
  return facts
}

export interface LineWords {
  readonly t: Translate
  readonly locale: Locale
  /** An ISO day written in the page's language. */
  readonly day: (iso: string) => string
}

/** "1.200 ft²": a quantity in the page's language with its unit's word. */
export const quantityWords = (quantity: string, uom: string, words: Pick<LineWords, 't' | 'locale'>): string =>
  /^\d+(?:\.\d+)?$/.test(quantity.trim()) ? `${quantityShown(quantity.trim(), words.locale)} ${words.t(`uom.${uom}`)}` : quantity

/** A line as the DS part asks it. `substitutes`: the articles of ours the supplier may offer instead (code and name). */
export function lineRequestOf(line: AnswerableLine, words: LineWords, substitutes: readonly { readonly itemId: string; readonly code: string; readonly name: string }[] = []): LineRequest {
  const { t, locale, day } = words
  const locked = line.locked === true
  return {
    id: line.id,
    seq: line.seq,
    title: lineTitle(line),
    details: lineFacts(line, t, locale),
    ...(line.note ? { note: line.note } : {}),
    asked: { quantity: quantityShown(line.quantity, locale), plain: line.quantity, unit: t(`uom.${line.uom}`), date: line.needDate, dateText: day(line.needDate) },
    ...(line.requiresCrViTest ? { tags: [{ label: t('lines.crVi'), tone: 'warning' as const }] } : {}),
    ...(substitutes.length > 0 ? { substitutes: substitutes.map((choice) => ({ id: choice.itemId, label: `${choice.code} · ${choice.name}` })) } : {}),
    ...(locked
      ? {
          locked:
            line.confirmedQuantity !== null
              ? t('lines.confirmed', { quantity: quantityShown(line.confirmedQuantity, locale), unit: t(`uom.${line.uom}`), date: line.confirmedDate ? day(line.confirmedDate) : '—' })
              : true,
        }
      : {}),
  }
}

/** The lines that take an answer or show one: not cancelled, not closed short. */
export const answerLines = <L extends AnswerableLine>(lines: readonly L[]): L[] => lines.filter((line) => !line.ended)

/** The lines this answer names: open ones only (a locked line is not answered again). */
export const openLines = <L extends AnswerableLine>(lines: readonly L[]): L[] => answerLines(lines).filter((line) => line.locked !== true)

const text = (value: string | undefined): string => (value ?? '').trim()
const orNull = (value: string | undefined): string | null => (text(value) === '' ? null : text(value))

/** A line's answer as the API takes it (no draft, or AS_ASKED: as asked). Quantities from what was typed in `locale`. */
export function lineBodyOf(lineId: string, draft: LineDraft | null | undefined, locale: Locale): PortalLineBody {
  if (!draft || draft.kind === 'AS_ASKED') return { lineId, answer: 'AS_ASKED' }
  const reason = text(draft.reason)
  const quantity = (typed: string | undefined): string | null => (text(typed) === '' ? null : (plainQuantity(text(typed), locale) ?? text(typed)))
  switch (draft.kind) {
    case 'CANNOT':
      return { lineId, answer: 'CANNOT_DELIVER', reason }
    case 'CHANGE':
      return { lineId, answer: 'CHANGE', reason }
    case 'OTHER':
      return { lineId, answer: 'OTHER', quantity: quantity(draft.quantity), date: orNull(draft.date), reason }
    case 'SPLIT':
      return { lineId, answer: 'SPLIT', deliveries: (draft.deliveries ?? []).map((part) => ({ quantity: quantity(part.quantity) ?? '', date: part.date.trim() })), reason }
    case 'SUBSTITUTE':
      return {
        lineId,
        answer: 'SUBSTITUTE',
        quantity: quantity(draft.quantity),
        date: orNull(draft.date),
        substituteItemId: orNull(draft.substituteId),
        substituteNote: orNull(draft.substitute),
        reason: reason === '' ? null : reason,
      }
  }
}

/** A typed quantity → the plain decimal the part compares (the page's language: "1.200,5" in Italian). */
export const parseQuantityIn =
  (locale: Locale) =>
  (typed: string): string | null =>
    plainQuantity(typed, locale)
