'use client'

/**
 * Sheet publish parity, build shape v2 (Owner 2026-10-04), phase P9 — where a product sells, in one pill.
 *
 * The Nexus product status (ACTIVE / DRAFT / INACTIVE) left the studio: it is "Catalog status" in the Products list now.
 * In its place the studio shows the SELLING state of the product's listings, read from the waiting Status and Action
 * values (`usePublishActions`, P8) — no channel call:
 *  - the header pill: "Active on 5 of 7" (success; warning when a listing is inactive), "Not listed" (neutral), and
 *    the danger tone with the words "· 1 to end" / "· 1 to delete" when an End or a Delete waits for Publish in the
 *    family. The pill opens a panel (`SellingSummaryPanel`): each market of the product, its state and what waits.
 *  - the shared scope's words for one product row: "Active" when every market agrees, "Active in 5 of 7" or "Mixed"
 *    otherwise (`sellingSummaryOf`) — the sheet's Status column and the record drawer use the same words.
 *
 * New listings (Owner 2026-10-04): a market where the product is not on the channel yet (Draft) is a NEW listing — its
 * Status chooses what Publish creates. The words count them: "Active in 5 of 7 · 2 new"; a market's line says what
 * Publish does there ("Amazon · IT: New listing. Publish creates it, but buyers cannot buy it yet."). A market Nexus
 * deleted is one too (simplify): "Not listed · 1 deleted"; its line says it in the delete's words, or "Lists again".
 *
 * One set of words everywhere (Owner 2026-10-04): Active · Inactive · Not listed · Ended (eBay, Shopify), Mixed.
 *
 * The pure parts are exported for the master sheet's shared columns, the record drawer and the tests. Design system
 * only: `Pill`, `DetailPopover`, `SellingStatusView`, `PublishActionView`.
 */
import type { ReactNode } from 'react'
import type { SellingState, StatusTarget } from '@nexus/shared/listing-actions'
import { SEND_MODE_LABEL, type PublishActionCell, type SendMode, type WaitingCounts } from '@nexus/shared/publish-actions'
import { channelLabel } from '@nexus/shared/channel-label'
import { DetailPopover } from '@/design-system/components'
import {
  PublishActionView, SELLING_STATE_TONE, SELLING_STATE_WORD, STATUS_TARGET_WORD, SellingStatusView, waitingSetPhrase,
} from '@/design-system/grid'
import { Button, Pill, Skeleton } from '@/design-system/primitives'
import type { Tone } from '@/design-system/primitives/tone'
import { statusCellValue } from './sheet/channel/statusColumn'
import { sheetWaitingMark, waitingTotalOf } from './sheet/usePublishActions'
import { aliasMarkText } from './listingScope'

// ── Labels and order ─────────────────────────────────────────────────────────────────────────────

type MarketCell = Pick<PublishActionCell, 'channel' | 'marketplace' | 'aliasKey'> & Partial<Pick<PublishActionCell, 'aliasLabel' | 'aliasPosition'>>

/**
 * "Amazon · IT" — the market as every publish message names it. A second listing on the same market carries its mark and
 * name, as the sheet's band shows it (Owner 2026-10-05): "eBay · IT · ① ALT1". A server that does not name the alias
 * yet leaves "· alias".
 */
export function marketLabel(cell: MarketCell): string {
  const base = `${channelLabel(cell.channel)} · ${cell.marketplace}`
  if (!cell.aliasKey) return base
  const position = typeof cell.aliasPosition === 'number' && cell.aliasPosition > 0 ? cell.aliasPosition : null
  const label = cell.aliasLabel?.trim() || null
  return position !== null ? `${base} · ${aliasMarkText(position, label)}` : label ? `${base} · ${label}` : `${base} · alias`
}

/** A product's listings in a stable order: by market, the primary listing first, then the aliases in their place order. */
export function sortedCells(cells: readonly PublishActionCell[]): PublishActionCell[] {
  const market = (cell: PublishActionCell) => `${channelLabel(cell.channel)} · ${cell.marketplace}`
  const place = (cell: PublishActionCell) => (!cell.aliasKey ? 0 : typeof cell.aliasPosition === 'number' ? cell.aliasPosition : Number.MAX_SAFE_INTEGER)
  return [...cells].sort((a, b) => market(a).localeCompare(market(b), 'en') || place(a) - place(b) || a.aliasKey.localeCompare(b.aliasKey, 'en') || a.listingId.localeCompare(b.listingId))
}

/** Every product's listings, in the stable order (the shared scope: one sheet row = one product). */
export function cellsByProduct(cells: readonly PublishActionCell[]): Map<string, PublishActionCell[]> {
  const out = new Map<string, PublishActionCell[]>()
  for (const cell of cells) out.set(cell.productId, [...(out.get(cell.productId) ?? []), cell])
  for (const [id, list] of out) out.set(id, sortedCells(list))
  return out
}

const READ_ONLY: readonly SellingState[] = ['draft', 'not_listed']
const sentence = (text: string) => { const t = text.trim(); return !t ? '' : /[.!?]$/.test(t) ? t : `${t}.` }
const n = (count: number) => count.toLocaleString('en')

// ── The words of one product's markets ───────────────────────────────────────────────────────────

export interface SellingSummary {
  /** Listings: one per market (and per extra listing on a market). */
  total: number
  /** Listings that sell now. */
  active: number
  /** Inactive and Mixed listings. */
  inactive: number
  /** Listings on a channel (not Not listed). */
  onChannel: number
  /** New listings: markets where the product is not on the channel yet (its Status chooses what Publish creates). */
  fresh: number
  /** Markets Nexus deleted (not on the channel; their Status lists them again). Unlinked ones are counted apart. */
  deleted: number
  /** Markets Nexus unlinked (Item ID control): the listing may still be live there; never listed as new. */
  unlinked?: number
  /** Every listing in the same state, or null (none, or they differ). */
  uniform: SellingState | null
  /** "Active" · "Active in 5 of 7" · "Mixed" · "Not listed". */
  word: string
  tone: Tone
}

/** The shared scope's words for one product: "Active" when every market agrees, "Active in 5 of 7" / "Mixed" when not. */
export function sellingSummaryOf(cells: readonly PublishActionCell[]): SellingSummary {
  const total = cells.length
  const states = new Set(cells.map(c => c.state))
  const active = cells.filter(c => c.state === 'active').length
  const inactive = cells.filter(c => c.state === 'paused' || c.state === 'mixed').length
  const onChannel = cells.filter(c => !READ_ONLY.includes(c.state)).length
  const fresh = cells.filter(c => !!c.create && !c.deleted).length
  const deleted = cells.filter(c => !!c.deleted && !c.deleted.unlinked).length
  const unlinked = cells.filter(c => !!c.deleted?.unlinked).length
  const uniform = states.size === 1 ? [...states][0] : null
  const word = !total ? SELLING_STATE_WORD.not_listed
    : uniform ? SELLING_STATE_WORD[uniform] ?? SELLING_STATE_WORD.unknown
      : active ? `Active in ${n(active)} of ${n(total)}` : 'Mixed'
  const tone: Tone = !total ? 'neutral' : uniform ? SELLING_STATE_TONE[uniform] ?? 'neutral' : inactive ? 'warning' : active ? 'success' : 'neutral'
  return { total, active, inactive, onChannel, fresh, deleted, unlinked, uniform, word, tone }
}

/** "2 new · 1 deleted · 1 unlinked" — the markets not on the channel (Publish creates the product there, or leaves it out), or null. */
export const freshWords = (summary: Pick<SellingSummary, 'fresh'> & Partial<Pick<SellingSummary, 'deleted' | 'unlinked'>>): string | null =>
  [summary.fresh ? `${n(summary.fresh)} new` : null, summary.deleted ? `${n(summary.deleted)} deleted` : null,
    summary.unlinked ? `${n(summary.unlinked)} unlinked` : null].filter(Boolean).join(' · ') || null

/** One value that waits for Publish on some of a product's markets. `value` null = the markets wait for different values. */
export interface WaitingSpread<V extends string> {
  value: V | null
  count: number
  total: number
  /** How many markets wait for each value. */
  byValue: ReadonlyMap<V, number>
  /** Who set them and when — only when one person set every one (the newest time). */
  by: { setAt: string | null; setByName: string | null } | null
}

function spread<V extends string>(cells: readonly PublishActionCell[], valueOf: (cell: PublishActionCell) => { value: V; setAt: string | null; setByName: string | null } | null): WaitingSpread<V> | null {
  const waiting = cells.map(valueOf).filter((w): w is NonNullable<typeof w> => !!w)
  if (!waiting.length) return null
  const byValue = new Map<V, number>()
  for (const w of waiting) byValue.set(w.value, (byValue.get(w.value) ?? 0) + 1)
  const names = new Set(waiting.map(w => w.setByName ?? ''))
  const newest = waiting.map(w => w.setAt).filter((t): t is string => !!t).sort().at(-1) ?? null
  return {
    value: byValue.size === 1 ? waiting[0].value : null, count: waiting.length, total: cells.length, byValue,
    by: names.size === 1 && [...names][0] ? { setAt: newest, setByName: [...names][0] } : null,
  }
}

/**
 * The Status values that wait for Publish (a value the listing outgrew — "No longer applies" — does not wait). On a row
 * not on the channel (new, or deleted by Nexus) it is the row's own choice: what Publish creates (or lists again).
 */
export const statusWaitingOf = (cells: readonly PublishActionCell[]) => spread<StatusTarget>(cells, c =>
  c.status.target && !c.status.noLongerApplies && c.status.setAt ? { value: c.status.target, setAt: c.status.setAt, setByName: c.status.setByName } : null)

/**
 * The Action values that wait for Publish (Full update, Delete; Partial update is the default and never waits). A row
 * not on the channel reads Full update whatever is stored (it is always sent whole): it is not counted here.
 */
export const sendWaitingOf = (cells: readonly PublishActionCell[]) => spread<Exclude<SendMode, 'partial'>>(cells, c =>
  c.send.mode !== 'partial' && !c.send.noLongerApplies && c.send.setAt && !c.create ? { value: c.send.mode, setAt: c.send.setAt, setByName: c.send.setByName } : null)

/** One market as a line: "Amazon · DE: Active. Inactive waits for Publish, set by Awais today 10:42. Full update waits." */
export function marketLine(cell: PublishActionCell, now: number = Date.now()): string {
  if (cell.create) {
    // A row not on the channel (new, or deleted by Nexus): what Publish does there, and who chose it.
    const by = cell.create.source === 'own' && cell.status.setAt ? waitingSetPhrase(cell.status, now) : ''
    // An unlinked row is never listed again from here: its words say why (the unlink's own).
    const head = cell.create.target === 'not_listed' ? STATUS_TARGET_WORD.not_listed : cell.deleted?.unlinked ? STATUS_TARGET_WORD[cell.create.target] : cell.deleted ? 'Lists again' : 'New listing'
    return `${marketLabel(cell)}: ${head}. ${sentence(cell.create.sentence)}${by ? ` ${by[0].toUpperCase()}${by.slice(1)}.` : ''}`
  }
  const parts = [`${marketLabel(cell)}: ${SELLING_STATE_WORD[cell.state] ?? SELLING_STATE_WORD.unknown}`]
  if (cell.stateReason) parts.push(sentence(cell.stateReason).replace(/\.$/, ''))
  if (cell.status.target) {
    const by = waitingSetPhrase(cell.status, now)
    parts.push(cell.status.noLongerApplies
      ? `the waiting change to ${STATUS_TARGET_WORD[cell.status.target]} no longer applies`
      : `${STATUS_TARGET_WORD[cell.status.target]} waits for Publish${by ? `, ${by}` : ''}`)
  }
  if (cell.send.mode !== 'partial') {
    const by = waitingSetPhrase(cell.send, now)
    parts.push(cell.send.noLongerApplies ? `the waiting ${SEND_MODE_LABEL[cell.send.mode]} no longer applies` : `${SEND_MODE_LABEL[cell.send.mode]} waits for Publish${by ? `, ${by}` : ''}`)
  }
  return `${parts[0]}${parts.length > 1 ? `. ${parts.slice(1).map(p => `${p[0].toUpperCase()}${p.slice(1)}`).join('. ')}` : ''}.`
}

// ── The header pill ──────────────────────────────────────────────────────────────────────────────

export interface HeaderSelling {
  /** "Active on 5 of 7" · "Not listed" (+ " · 1 to end · 1 to delete" when one waits in the family). */
  label: string
  tone: Tone
  /** The whole sentence for a screen reader and the trigger's name. */
  ariaLabel: string
  live: number
  total: number
}

/** Every value that waits for Publish (the deleted rows listed again included, when the counts carry them). */
const totalWaiting = (w: WaitingCounts & { relist?: number }) => waitingTotalOf(w)

/**
 * The header pill of one product: its own listings ("Active on 5 of 7"), and the family's End and Delete values that wait
 * for Publish (danger: Publish sends the whole family, so a waiting delete anywhere in it is named here).
 */
export function headerSellingOf(cells: readonly PublishActionCell[], familyWaiting: WaitingCounts): HeaderSelling {
  const summary = sellingSummaryOf(cells)
  const danger = [
    familyWaiting.ended ? `${n(familyWaiting.ended)} to end` : null,
    familyWaiting.delete ? `${n(familyWaiting.delete)} to delete` : null,
  ].filter((p): p is string => !!p)
  const listed = summary.onChannel > 0
  const base = listed ? `Active on ${n(summary.active)} of ${n(summary.total)}` : SELLING_STATE_WORD.not_listed
  const tone: Tone = danger.length ? 'danger' : !listed ? 'neutral' : summary.inactive ? 'warning' : summary.active ? 'success' : 'neutral'
  const label = danger.length ? `${base} · ${danger.join(' · ')}` : base
  const sell = listed
    ? `Sells on ${n(summary.active)} of ${n(summary.total)} ${summary.total === 1 ? 'market' : 'markets'}${summary.inactive ? `; ${n(summary.inactive)} inactive` : ''}.`
    : summary.total ? `Not listed on any market: Publish creates ${summary.total === 1 ? 'its listing' : `its ${n(summary.total)} listings`} as each Status says.` : 'Not listed on any market yet.'
  const mark = sheetWaitingMark(familyWaiting)
  const waits = mark ? ` In this family, ${mark.label.replace(/ for Publish$/, '')} for Publish: ${mark.detail}.` : ''
  return { label, tone, ariaLabel: `${sell}${waits}`, live: summary.active, total: summary.total }
}

/** The Publish button's count: every value that waits for Publish in the family (0 = no count). */
export function publishWaitingCount(waiting: WaitingCounts | null | undefined): number {
  return waiting ? totalWaiting(waiting) : 0
}

/** "Publish · 4" and its sentence, or the plain button when nothing waits. */
export function publishButtonWords(waiting: WaitingCounts | null | undefined): { label: string; title: string; ariaLabel: string } {
  const count = publishWaitingCount(waiting)
  if (!count || !waiting) return { label: 'Publish', title: 'Review and send this family to its channels.', ariaLabel: 'Publish' }
  const mark = sheetWaitingMark(waiting)!
  return {
    label: `Publish · ${n(count)}`,
    title: `${mark.label}: ${mark.detail}. Review them and the changed fields, then send.`,
    ariaLabel: `Publish. ${mark.label}: ${mark.detail}.`,
  }
}

// ── The panel: each market, its state and what waits ────────────────────────────────────────────

export type SellingReadState = 'idle' | 'loading' | 'ready' | 'error'

export interface SellingSummaryPanelProps {
  sku: string
  cells: readonly PublishActionCell[]
  /** The family's waiting values (the foot line), or null to leave it out. */
  familyWaiting: WaitingCounts | null
  error?: string | null
  onRetry?: () => void
  now?: number
}

const READ_STATE = { loaded: true, failed: false, lockedReason: null }

/** The panel's content: one line per market — its state pill, the waiting Status and Action — and what waits in the family. */
export function SellingSummaryPanel({ sku, cells, familyWaiting, error, onRetry, now }: SellingSummaryPanelProps) {
  const sorted = sortedCells(cells)
  const mark = familyWaiting ? sheetWaitingMark(familyWaiting) : null
  return (
    <div className="nds-detailpop-body">
      <div className="nds-detailpop-h">{sorted.length ? `Where ${sku} sells` : `${sku} is not listed`}</div>
      {error && <p className="nds-detailpop-note" role="alert">The selling state could not be read again: {sentence(error)} {onRetry && <Button variant="quiet" size="xs" onClick={onRetry}>Try again</Button>}</p>}
      {sorted.length > 0 ? (
        <ul className="nds-detailpop-list" aria-label={`Markets of ${sku}`}>
          {sorted.map(cell => (
            <li key={cell.listingId} className="nds-detailpop-item">
              <span className="nds-detailpop-what">
                <span className="nds-detailpop-label">{marketLabel(cell)}</span>
                {cell.stateReason && <span className="nds-detailpop-reason">{sentence(cell.stateReason)}</span>}
              </span>
              <span className="nds-selling-visual">
                <SellingStatusView value={statusCellValue(cell, READ_STATE)} now={now} />
                {/* A row not on the channel: its Status already says what Publish does; its Full update is not repeated here. */}
                {!cell.create && cell.send.mode !== 'partial' && !cell.send.noLongerApplies && (
                    <PublishActionView value={{ mode: cell.send.mode, setAt: cell.send.setAt, setByName: cell.send.setByName }} now={now} />
                  )}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="nds-detailpop-note">Publish creates its listings: choose the markets in the Publish window.</p>
      )}
      {familyWaiting && (
        <div className="nds-detailpop-foot">
          {mark ? `In this family, ${mark.label}: ${mark.detail}. Nothing is sent until you press Publish.` : 'Nothing waits for Publish in this family.'}
        </div>
      )}
    </div>
  )
}

export interface SellingSummaryPillProps extends SellingSummaryPanelProps {
  status: SellingReadState
  /** The pill's words and tone (`headerSellingOf`, or the shared words of a sheet row). */
  label: string
  tone: Tone
  /** The trigger's whole sentence. */
  ariaLabel: string
  size?: 'sm' | 'md'
  /** Shown before the first read answers. */
  loading?: ReactNode
}

/**
 * The selling pill: a DetailPopover trigger (click, Enter, Space, or a resting pointer) whose panel lists each market.
 * Before the first read answers it is a skeleton — never a guessed state; a failed first read says so and offers a retry.
 */
export function SellingSummaryPill({ status, label, tone, ariaLabel, size = 'sm', loading, ...panel }: SellingSummaryPillProps) {
  if (status === 'idle' || status === 'loading') {
    return <>{loading ?? <Skeleton width={104} height={20} radius="var(--nds-radius-pill)" />}<span className="nds-vh">Reading where {panel.sku} sells.</span></>
  }
  const failedFirst = status === 'error' && !panel.cells.length
  return (
    <DetailPopover
      trigger={<Pill tone={failedFirst ? 'neutral' : tone} size={size} dot>{failedFirst ? 'Selling state unknown' : label}</Pill>}
      triggerLabel={failedFirst ? `The selling state of ${panel.sku} could not be read. Show details.` : `${ariaLabel} Show each market.`}
      label={`Where ${panel.sku} sells`}
    >
      <SellingSummaryPanel {...panel} error={failedFirst ? panel.error ?? 'the request failed' : panel.error} />
    </DetailPopover>
  )
}

/** The record's selling cells in the current scope, as a host hands them to the record drawer (P9). */
export interface RecordSelling {
  status: SellingReadState
  error: string | null
  /** The record's listings in this scope: every market (shared scope), or the one listing (a channel scope). */
  cellsOf: (rowId: string) => readonly PublishActionCell[]
}
