import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Locale } from '../../../lib/i18n/locales'
import type { Translate } from '../../../lib/i18n/messages'
import { sizesText } from '@nexus/factory-domain/planning/leather/feasibility'
import { withoutValidCertificate } from '@nexus/factory-domain/planning/leather/protectors'
import { csvOf, quantity } from '../../_shared/buying/model'
import type { LeatherNeed, LeatherProtectors, LeatherYield, NeedRow, ProtectorRow, YieldRow } from './api'

/**
 * Planning › Leather & cut plan (SCR-252), the rules without a screen: the address (the page's own filters, so a saved view
 * keeps them), the tiles (counts that are saved filters), which rows each section shows, what an action needs and why it is
 * held, the proposal and the shade options in words, the cut plan's rows and the CSV. Every word from the catalogue
 * `planning-leather`; numbers from the API's exact decimals. No money unless the API sent it (the cost grain).
 */

export const NAMESPACE = 'planning-leather'

export const TILES = ['orders', 'shade', 'protectors', 'drift'] as const
export type Tile = (typeof TILES)[number]
export const FEASIBILITY_FILTERS = ['all', 'FITS', 'SPLIT', 'MUST_BUY', 'ASK_CUSTOMER', 'COVERED'] as const
export type FeasibilityFilter = (typeof FEASIBILITY_FILTERS)[number]

export interface LeatherControls {
  readonly site: string | null
  readonly tile: Tile | null
  readonly feas: FeasibilityFilter
  readonly q: string
  /** A need row's id: its shade drawer is open. */
  readonly open: string | null
}

export function controlsOf(params: URLSearchParams): LeatherControls {
  const tile = params.get('tile')
  const feas = params.get('feas')
  return {
    site: params.get('site') || null,
    tile: (TILES as readonly string[]).includes(tile ?? '') ? (tile as Tile) : null,
    feas: (FEASIBILITY_FILTERS as readonly string[]).includes(feas ?? '') ? (feas as FeasibilityFilter) : 'all',
    q: params.get('q') ?? '',
    open: params.get('open') || null,
  }
}

export function queryOf(controls: LeatherControls): string {
  const out = new URLSearchParams()
  if (controls.site) out.set('site', controls.site)
  if (controls.tile) out.set('tile', controls.tile)
  if (controls.feas !== 'all') out.set('feas', controls.feas)
  if (controls.q.trim()) out.set('q', controls.q.trim())
  if (controls.open) out.set('open', controls.open)
  return out.toString()
}

/** What the person may do here (the API checks again): the page's read, the loss, the plan run, and the drawer's actions. */
export interface LeatherCan {
  readonly view: boolean
  readonly manage: boolean
  readonly run: boolean
  readonly reserve: boolean
  readonly draftPo: boolean
  readonly note: boolean
}

export function leatherCan(permissions: readonly string[]): LeatherCan {
  const has = (permission: string) => permissions.includes(permission)
  return { view: has('planning.view'), manage: has('planning.leather.manage'), run: has('planning.run'), reserve: has('inventory.reserve'), draftPo: has('purchasing.manage'), note: has('threads.post') }
}

// ---- the tiles -------------------------------------------------------------------------------------------------------------

export const needsLeather = (row: NeedRow): boolean => Number(row.toFind) > 0
export const notOneShade = (row: NeedRow): boolean => row.feasibility === 'SPLIT' || row.feasibility === 'MUST_BUY' || row.feasibility === 'ASK_CUSTOMER'
export const protectorHeld = (row: ProtectorRow): boolean => withoutValidCertificate(row.state)
export const drifted = (row: YieldRow): boolean => row.proposal.state === 'PROPOSED'

/** Each tile's count: a number once its section is read, null ('—') while unknown; never hidden. */
export function tileCounts(need: LeatherNeed | null, protectors: LeatherProtectors | null, yields: LeatherYield | null): Record<Tile, number | null> {
  return {
    orders: need ? new Set(need.rows.filter(needsLeather).map((row) => row.order.id)).size : null,
    shade: need ? need.rows.filter(notOneShade).length : null,
    protectors: protectors ? protectors.rows.filter(protectorHeld).length : null,
    drift: yields ? yields.rows.filter(drifted).length : null,
  }
}

const matches = (q: string, ...values: (string | null | undefined)[]): boolean => {
  const needle = q.trim().toLowerCase()
  return needle === '' || values.some((value) => (value ?? '').toLowerCase().includes(needle))
}

export function visibleNeed(rows: readonly NeedRow[], controls: Pick<LeatherControls, 'tile' | 'feas' | 'q'>): NeedRow[] {
  return rows.filter(
    (row) =>
      (controls.tile !== 'orders' || needsLeather(row)) &&
      (controls.tile !== 'shade' || notOneShade(row)) &&
      (controls.feas === 'all' || row.feasibility === controls.feas) &&
      matches(controls.q, row.order.number, row.style.code, row.style.name, row.item.code, row.colourway?.name, row.best?.lotCode),
  )
}

export const visibleProtectors = (rows: readonly ProtectorRow[], controls: Pick<LeatherControls, 'tile' | 'q'>): ProtectorRow[] =>
  rows.filter((row) => (controls.tile !== 'protectors' || protectorHeld(row)) && matches(controls.q, row.order.number, row.style.code, row.item.code, row.placement))

export const visibleYield = (rows: readonly YieldRow[], controls: Pick<LeatherControls, 'tile' | 'q'>): YieldRow[] => rows.filter((row) => (controls.tile !== 'drift' || drifted(row)) && matches(controls.q, row.style.code, row.style.name))

/** The section a tile filters (the page scrolls to it). */
export const sectionOfTile = (tile: Tile): 'need' | 'protectors' | 'yield' => (tile === 'protectors' ? 'protectors' : tile === 'drift' ? 'yield' : 'need')

// ---- words -----------------------------------------------------------------------------------------------------------------

export interface Words {
  readonly t: Translate
  readonly unit: (uom: string) => string
  readonly locale: Locale
}

export const area = (value: string | null | undefined, uom: string, words: Words): string => (value === null || value === undefined ? '—' : `${quantity(value, words.locale)} ${words.unit(uom)}`)
export const pct = (value: string | null | undefined, words: Words): string => (value === null || value === undefined ? '—' : `${quantity(value, words.locale)} %`)

export const feasibilityTone = (row: Pick<NeedRow, 'feasibility'>): 'success' | 'info' | 'warning' | 'danger' | 'neutral' =>
  row.feasibility === 'FITS' ? 'success' : row.feasibility === 'COVERED' ? 'neutral' : row.feasibility === 'SPLIT' ? 'info' : row.feasibility === 'MUST_BUY' ? 'warning' : 'danger'

export const protectorTone = (row: Pick<ProtectorRow, 'state'>): 'success' | 'warning' | 'danger' => (row.state === 'OK' ? 'success' : row.state === 'SHORT' ? 'warning' : 'danger')

/** "Lot L-221 · shade 2 · 412 ft² free" */
export function lotWords(lot: { lotCode: string; shadeLabel: string | null; free?: string; area?: string } | null, uom: string, words: Words): string {
  if (!lot) return words.t('lot.none')
  const shade = lot.shadeLabel ? words.t('lot.shade', { shade: lot.shadeLabel }) : words.t('lot.noShade')
  const size = lot.free ?? lot.area
  return size === undefined ? `${lot.lotCode} · ${shade}` : words.t('lot.free', { lot: lot.lotCode, shade, area: area(size, uom, words) })
}

/** The sizes of an order line: "46–54 · 12 pcs". */
export function sizesWords(row: Pick<NeedRow, 'sizes' | 'pieces'>, words: Words): string {
  const sizes = row.sizes.map((size) => size.size)
  return words.t('row.sizes', { sizes: sizesText(sizes, sizes), count: row.pieces })
}

export function gradeMixWords(row: Pick<NeedRow, 'gradeMix'>, words: Words): string {
  if (row.gradeMix.length === 0) return words.t('grade.none')
  return row.gradeMix.map((grade) => `${grade.code ?? words.t('grade.ungraded')} ${quantity(grade.pct, words.locale, 0)} %`).join(' · ')
}

/** "Split by garment: sizes 46–50 from L-221, 52–56 from L-230". */
export function splitWords(row: Pick<NeedRow, 'split' | 'sizes'>, words: Words): string {
  const scale = row.sizes.map((size) => size.size)
  return (row.split ?? []).map((part) => words.t('option.splitPart', { sizes: sizesText(part.sizes, scale), lot: part.lotCode })).join(', ')
}

/** The proposal in words: "Set loss 12 % → 14 %" (or what the state says instead). */
export function proposalWords(row: Pick<YieldRow, 'proposal' | 'lastDecision'>, words: Words, minCuts: number): string {
  const { proposal } = row
  const from = proposal.fromPct === null ? '—' : pct(proposal.fromPct, words)
  switch (proposal.state) {
    case 'TOO_FEW':
      return words.t('yield.tooFew', { count: proposal.cuts, min: minCuts })
    case 'IN_LINE':
      return words.t('yield.inLine')
    case 'PROPOSED':
      return words.t('yield.propose', { from, to: pct(proposal.toPct, words) })
    case 'ACCEPTED':
      return row.lastDecision?.revision ? words.t('yield.acceptedIn', { to: pct(proposal.toPct, words), revision: row.lastDecision.revision }) : words.t('yield.acceptedWaiting', { to: pct(proposal.toPct, words) })
    case 'DISMISSED':
      return words.t('yield.dismissed', { to: pct(proposal.toPct, words) })
  }
}

// ---- holds -----------------------------------------------------------------------------------------------------------------

/** Accept is held: no right, the proposal is not open, or it is in the draft already. Null: allowed. */
export function acceptHeld(row: YieldRow, can: LeatherCan): string | null {
  if (!can.manage) return 'held.noManage'
  if (row.proposal.state !== 'PROPOSED' && row.proposal.state !== 'DISMISSED' && row.proposal.state !== 'ACCEPTED') return 'held.noProposal'
  if (row.proposal.state === 'ACCEPTED' && (!row.draft || row.lastDecision?.revision === row.draft.revision)) return row.draft ? 'held.inDraft' : 'held.waitsForDraft'
  return null
}

export function dismissHeld(row: YieldRow, can: LeatherCan): string | null {
  if (!can.manage) return 'held.noManage'
  if (row.proposal.state === 'DISMISSED') return 'held.dismissedAlready'
  if (row.proposal.state !== 'PROPOSED' && row.proposal.state !== 'ACCEPTED') return 'held.noProposal'
  return null
}

export const reasonHeld = (reason: string): string | null => (reason.trim().length < 3 ? 'held.reasonShort' : reason.trim().length > 500 ? 'held.reasonLong' : null)

export type ShadeOption = 'reserve' | 'split' | 'buy' | 'ask'

/** The options the drawer offers for a row, in the design's order, each with why it is held (null: allowed). */
export function shadeOptions(row: NeedRow, can: LeatherCan): { option: ShadeOption; held: string | null }[] {
  const out: { option: ShadeOption; held: string | null }[] = []
  if (row.feasibility === 'FITS') out.push({ option: 'reserve', held: !can.reserve ? 'held.noReserve' : !row.proposal ? 'held.noProposalHides' : null })
  if (row.split) out.push({ option: 'split', held: !can.reserve ? 'held.noReserve' : null })
  if (row.buy && Number(row.buy.area) > 0) out.push({ option: 'buy', held: !can.draftPo ? 'held.noDraftPo' : row.requirement.decision !== 'OPEN' ? `held.requirement.${row.requirement.decision}` : null })
  if (row.feasibility !== 'FITS' && row.feasibility !== 'COVERED') out.push({ option: 'ask', held: !can.note ? 'held.noNote' : null })
  return out
}

/** b on a focused Must buy row: the Draft PO, or why not. */
export function draftPoHeld(row: NeedRow, can: LeatherCan): string | null {
  return shadeOptions(row, can).find((entry) => entry.option === 'buy')?.held ?? 'held.notMustBuy'
}

/** The note Sales gets on the order's thread (they ask the customer; an internal note never reaches a party). */
export function askNote(row: NeedRow, words: Words): string {
  const uom = row.item.baseUom
  const lines = [
    words.t('ask.head', { order: row.order.number, line: row.orderLine.seq, style: row.style.code, colour: row.colourway?.name ?? '—' }),
    words.t('ask.need', { area: area(row.toFind, uom, words), leather: row.item.code }),
    row.split ? words.t('ask.split', { split: splitWords(row, words) }) : null,
    row.buy ? words.t('ask.buy', { area: area(row.buy.area, uom, words), shade: row.buy.shadeLabel ?? '—' }) : null,
    words.t('ask.question'),
  ]
  return lines.filter((line): line is string => line !== null).join('\n')
}

// ---- refusals and reads ----------------------------------------------------------------------------------------------------

export function refusalOf(error: unknown): string {
  if (!isApiError(error)) return 'refusal.failed'
  const paths = error.issues.map(issuePath)
  if (paths.some((path) => path.includes('PROPOSAL_MOVED'))) return 'refusal.moved'
  if (paths.some((path) => path.includes('ALREADY_ACCEPTED'))) return 'refusal.alreadyAccepted'
  if (paths.some((path) => path.includes('ALREADY_DISMISSED'))) return 'refusal.alreadyDismissed'
  if (paths.some((path) => path.includes('SHADE_LOT') || path.includes('OUT_OF_SHADE'))) return 'refusal.shade'
  if (paths.some((path) => path.includes('draftVersion'))) return 'refusal.draft'
  if (error.kind === 'conflict') return 'refusal.changed'
  if (error.kind === 'invalid') return paths.some((path) => path.includes('reason')) ? 'refusal.reason' : 'refusal.invalid'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'refusal.forbidden'
  if (error.kind === 'not_found') return 'refusal.gone'
  if (error.kind === 'unavailable') return 'refusal.offline'
  return 'refusal.failed'
}

export function readProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'error.failed'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'error.forbidden'
  if (error.kind === 'unavailable') return 'error.offline'
  if (error.kind === 'not_found') return 'error.gone'
  return 'error.failed'
}

// ---- the cut plan and the export ---------------------------------------------------------------------------------------------

export interface CutPlanRow {
  readonly id: string
  readonly cells: string[]
}

/** The cut plan's rows for the cutting room: order, style and colour, sizes, leather, area to find, hides, the lot, the answer. */
export function cutPlanRows(rows: readonly NeedRow[], words: Words): CutPlanRow[] {
  return rows.map((row) => ({
    id: row.id,
    cells: [
      `${row.order.number} · ${words.t('row.line', { seq: row.orderLine.seq })}`,
      `${row.style.code} · ${row.colourway?.name ?? '—'}`,
      sizesWords(row, words),
      `${row.item.code}${row.colour ? ` · ${row.colour.name}` : ''}`,
      area(row.toFind, row.item.baseUom, words),
      row.hides === null ? '—' : String(row.hides),
      row.feasibility === 'SPLIT' ? splitWords(row, words) : lotWords(row.best, row.item.baseUom, words),
      words.t(`feasibility.${row.feasibility}`),
    ],
  }))
}

export function csvOfNeed(rows: readonly NeedRow[], words: Words): string {
  return csvOf(
    ['order', 'line', 'style', 'colour', 'sizes', 'leather', 'area', 'issued', 'reserved', 'toFind', 'hides', 'loss', 'bestLot', 'feasibility'].map((column) => words.t(`csv.${column}`)),
    rows.map((row) => [row.order.number, row.orderLine.seq, row.style.code, row.colourway?.name ?? '', sizesWords(row, words), row.item.code, row.area, row.issued, row.reserved, row.toFind, row.hides ?? '', row.lossPct ?? '', row.best?.lotCode ?? '', words.t(`feasibility.${row.feasibility}`)]),
  )
}

/** The rows the next/previous keys walk in the drawer (the order shown). */
export function neighbours(ids: readonly string[], current: string): { prev: string | null; next: string | null } {
  const at = ids.indexOf(current)
  return { prev: at > 0 ? ids[at - 1]! : null, next: at >= 0 && at < ids.length - 1 ? ids[at + 1]! : null }
}
