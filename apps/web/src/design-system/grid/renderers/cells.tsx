'use client'

/**
 * GDS — the cell library. Every renderer here is memoised, null-safe, and a `ColDef` fragment away
 * from use (`../columns/presets.ts`). A page composes these; it does not write its own money cell.
 *
 * The rule every one of them enforces: an UNMEASURED value (`null`) and a MEASURED zero are
 * different facts and render differently — `formatGridValue` decides which, the cell draws it.
 * `EmptyValue` is the dash: muted, and it carries a `title` ONLY when the zero was measured.
 *
 * Styling: `../theme/grid.css` (`.nds-grid-*`), tokens from `tokens/grid.ts`. No CSS module, so
 * the cell reads the same in a page card, a modal and a drawer.
 */
import { memo, useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight, ExternalLink, MoreHorizontal } from 'lucide-react'
import type { ICellRendererParams, IRowNode } from 'ag-grid-community'

import { Button, InfoTip, Pill, TagGlyph, type Tone } from '../../primitives'
import { CoverageSummary, Menu, Thumbnail, type CoverageChannel, type MenuItemDef } from '../../components'
import { emptyValueA11y } from './emptyValue'
import { EMPTY_DASH, formatGridValue, type FormatOptions, type GridValueKind } from './format'
import { longTextMarkLabel, longTextState, type LongTextCaps } from './longTextState'
import { readinessMeta, type RowReadinessState } from './readiness'

/* ── the dash ─────────────────────────────────────────────────────────────────────────────── */

/**
 * 🔴 A UNION, not two optional fields — a measured zero MUST say what was measured.
 *
 * The old shape was `{ measuredZero?: boolean; title?: string }`, which let `<EmptyValue
 * measuredZero />` compile and render `aria-label={undefined}`: an element whose only content is an
 * em-dash and which has **no accessible name at all**. The unmeasured case, meanwhile, was named
 * "Not measured". So a screen-reader user heard a name for the value we know nothing about and
 * silence for the one we measured — the exact inversion of this component's purpose, in the
 * component that exists to make that distinction audible.
 *
 * Found by FE.1 writing a probe (hub #313), latent not live: all 8 `zero: 'dash'` call sites pass a
 * `zeroTitle` today, so discipline was holding and no operator was affected. The type is what
 * permitted it, so the type is what changed — the incorrect call is now a compile error rather than
 * a silent gap that no sighted review can see.
 */
export type EmptyValueProps =
  | { measuredZero: true; title: string }
  | { measuredZero?: false; title?: never }

export const EmptyValue = memo(function EmptyValue({ measuredZero = false, title }: EmptyValueProps) {
  const a = emptyValueA11y(measuredZero, title)
  return (
    <span className="nds-cell-empty" title={a.title} aria-label={a.ariaLabel}>
      {EMPTY_DASH}
    </span>
  )
})

/* ── numbers and dates ────────────────────────────────────────────────────────────────────── */

export interface NumericCellParams extends FormatOptions {
  kind?: GridValueKind
  /** The title a measured zero shows under `zero: 'dash'` — say what was measured. */
  zeroTitle?: string | ((data: unknown) => string)
  muted?: boolean
}

export const NumericCell = memo(function NumericCell(p: ICellRendererParams & NumericCellParams) {
  const f = formatGridValue(p.kind ?? 'integer', p.value, { zero: p.zero, dp: p.dp })
  if (f.empty) return <EmptyValue />
  if (f.measuredZero) {
    /* `zeroTitle` is optional on `NumericCellParams` and cannot be made conditional on `zero:
       'dash'` without a union over `FormatOptions` — so this is the one path where a measured zero
       can arrive without its reason, and it floors rather than passing `undefined` through. */
    const t = typeof p.zeroTitle === 'function' ? p.zeroTitle(p.data) : p.zeroTitle
    return <EmptyValue measuredZero title={t ?? 'Measured zero'} />
  }
  return <span className={p.muted ? 'nds-cell-muted' : undefined}>{f.text}</span>
})

export interface DateCellParams {
  muted?: boolean
}

export const DateCell = memo(function DateCell(p: ICellRendererParams & DateCellParams) {
  const f = formatGridValue('date', p.value)
  if (f.empty) return <EmptyValue />
  return <span className={['nds-cell-date', p.muted === false ? '' : 'nds-cell-muted'].filter(Boolean).join(' ')}>{f.text}</span>
})

/* ── status ───────────────────────────────────────────────────────────────────────────────── */

export interface BadgeCellParams {
  /** value → pill. A value with no entry renders the fallback tone with the raw value as label. */
  tones: Record<string, { tone: Tone; label: string }>
  fallbackTone?: Tone
  size?: 'sm' | 'md'
}

export const BadgeCell = memo(function BadgeCell(p: ICellRendererParams & BadgeCellParams) {
  if (p.value === null || p.value === undefined || p.value === '') return <EmptyValue />
  const key = String(p.value)
  const entry = p.tones[key] ?? { tone: p.fallbackTone ?? 'neutral', label: key }
  return <Pill tone={entry.tone} size={p.size}>{entry.label}</Pill>
})

/* ── locked ───────────────────────────────────────────────────────────────────────────────── */

export interface LockedCellParams {
  kind?: GridValueKind
  /** Why it is read-only — the lock's accessible name. */
  reason?: string
}

export const LockedCell = memo(function LockedCell(p: ICellRendererParams & LockedCellParams) {
  const f = formatGridValue(p.kind ?? 'text', p.value)
  return (
    <span className="nds-cell-locked">
      {f.empty ? EMPTY_DASH : f.text}
      <span className="nds-cell-lock-glyph" role="img" aria-label={p.reason ?? 'Read-only'}>🔒</span>
    </span>
  )
})

/* ── links ────────────────────────────────────────────────────────────────────────────────── */

export interface LinkCellParams {
  href: (data: unknown) => string
  /** Same-tab title link, plus a hover-revealed "Open" pill that opens a NEW tab (the products page's shape). */
  openPill?: boolean
}

export const LinkCell = memo(function LinkCell(p: ICellRendererParams & LinkCellParams) {
  if (p.value === null || p.value === undefined || !p.data) return <EmptyValue />
  const href = p.href(p.data)
  return (
    <span className="nds-cell-title-row">
      <Link href={href} className="nds-cell-title-link" title={String(p.value)} onClick={(e) => e.stopPropagation()}>
        {String(p.value)}
      </Link>
      {p.openPill && (
        <a className="nds-cell-open" href={href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
          <ExternalLink size={11} /> Open
        </a>
      )}
    </span>
  )
})

/* ── stock ────────────────────────────────────────────────────────────────────────────────── */

export type StockLevel = 'out' | 'low' | 'ok'

export interface StockCellParams {
  /** The level for a value; default: ≤0 out, ≤ threshold(data) low, else ok. */
  level?: (value: number, data: unknown) => StockLevel
  threshold?: (data: unknown) => number
}

export const stockLevel = (value: number, threshold: number): StockLevel => (value <= 0 ? 'out' : value <= threshold ? 'low' : 'ok')

export const StockCell = memo(function StockCell(p: ICellRendererParams & StockCellParams) {
  const f = formatGridValue('integer', p.value)
  if (f.empty) return <EmptyValue />
  const n = Number(p.value)
  const level = p.level ? p.level(n, p.data) : stockLevel(n, p.threshold ? p.threshold(p.data) : 0)
  return <span className={`nds-cell-stock nds-cell-stock-${level}`}>{f.text}</span>
})

/* ── delta chip ───────────────────────────────────────────────────────────────────────────── */

export const DeltaChip = memo(function DeltaChip({ delta }: { delta: number }) {
  if (delta === 0) return null
  return <span className={delta < 0 ? 'nds-cell-delta nds-cell-delta-neg' : 'nds-cell-delta'}>{delta > 0 ? `+${delta}` : delta}</span>
})

/* ── group row ────────────────────────────────────────────────────────────────────────────── */

export interface GroupCellProps {
  label: string
  count: number
  noun?: [singular: string, plural: string]
}

export const GroupCell = memo(function GroupCell({ label, count, noun = ['row', 'rows'] }: GroupCellProps) {
  return (
    <span className="nds-cell-group">
      <strong>{label}</strong>
      <span className="nds-cell-group-count">
        {count.toLocaleString('en-GB')} {count === 1 ? noun[0] : noun[1]}
      </span>
    </span>
  )
})

/* ── tags ─────────────────────────────────────────────────────────────────────────────────── */

export interface GridTag {
  id: string
  name: string
  icon?: string | null
  color?: string | null
}

export interface TagsCellParams {
  /** Glyphs shown before the "+N" overflow (default 6). */
  max?: number
}

export const TagsCell = memo(function TagsCell(p: ICellRendererParams & TagsCellParams) {
  const tags = (Array.isArray(p.value) ? p.value : []) as GridTag[]
  if (tags.length === 0) return null
  const max = p.max ?? 6
  const solo = tags.length === 1 ? tags[0] : null
  const glyphs = solo ? [] : tags.slice(0, max)
  const spare = solo ? 0 : tags.length - glyphs.length
  return (
    <InfoTip tip={tags.map((t) => t.name).join(' · ')}>
      <span className="nds-cell-tags">
        {solo && (
          <span className="nds-cell-tagchip">
            <TagGlyph icon={solo.icon} color={solo.color} size={12} />
            <span className="nds-cell-tagchip-name">{solo.name}</span>
          </span>
        )}
        {glyphs.map((t) => (
          <span key={t.id} className="nds-cell-tagglyph">
            <TagGlyph icon={t.icon} color={t.color} size={12} />
          </span>
        ))}
        {spare > 0 && <span className="nds-cell-tagmore">+{spare}</span>}
      </span>
    </InfoTip>
  )
})

/* ── coverage ─────────────────────────────────────────────────────────────────────────────── */

/** `value` is `CoverageChannel[]` — the page's valueGetter computes it from its own data shape. */
export const CoverageCell = memo(function CoverageCell(p: ICellRendererParams) {
  const channels = (Array.isArray(p.value) ? p.value : []) as CoverageChannel[]
  if (channels.length === 0) return null
  return <CoverageSummary channels={channels} />
})

/* ── actions ──────────────────────────────────────────────────────────────────────────────── */

export interface ActionsCellParams<T = unknown> {
  /** The one visible button (Edit). A link when `href` is given. */
  primary?: { label: ReactNode; href?: (data: T) => string; onClick?: (data: T) => void }
  /** The ⋯ menu. */
  items?: (data: T) => MenuItemDef[]
  /** Accessible name for the ⋯ trigger. */
  menuLabel?: (data: T) => string
}

function ActionsCellImpl<T>(p: ICellRendererParams<T> & ActionsCellParams<T>) {
  const data = p.data
  if (!data) return null
  const items = p.items?.(data) ?? []
  return (
    <div className="nds-cell-actions">
      {p.primary &&
        (p.primary.href ? (
          <Button asChild size="sm">
            <Link href={p.primary.href(data)}>{p.primary.label}</Link>
          </Button>
        ) : (
          <Button size="sm" onClick={() => p.primary?.onClick?.(data)}>
            {p.primary.label}
          </Button>
        ))}
      {items.length > 0 && (
        <Menu
          label={<MoreHorizontal size={15} />}
          items={items}
          align="right"
          triggerProps={{ className: 'nds-btn sm icon', 'aria-label': p.menuLabel?.(data) ?? 'More actions' }}
        />
      )}
    </div>
  )
}
export const ActionsCell = memo(ActionsCellImpl) as typeof ActionsCellImpl

/* ── chips: the 20px squares beside a name (the Ad Manager's A/M + SP/SB/SD) ──────────────── */

export type IdentityChipTone = 'auto' | 'manual' | 'program' | 'neutral' | 'accent'

export interface IdentityChipProps {
  /** One or two characters — `A`, `M`, `SP`. */
  label: ReactNode
  tone?: IdentityChipTone
  /** The hover explanation; a chip with no tip is a mark nobody can read. */
  tip?: string
}

/**
 * A 20×20 square chip that sits BEFORE the title in an identity cell, never in a column of its
 * own: targeting (A/M, filled), programme (SP/SB/SD, outlined), an accent mark (a lightbulb).
 * The Ad Manager drew these in its campaign cell; this is that cell's chip, on the tokens.
 */
export const IdentityChip = memo(function IdentityChip({ label, tone = 'neutral', tip }: IdentityChipProps) {
  const chip = (
    <span className={`nds-cell-chip nds-cell-chip-${tone}`} aria-label={tip} role={tip ? 'img' : undefined}>
      {label}
    </span>
  )
  return tip ? <InfoTip tip={tip}>{chip}</InfoTip> : chip
})

export const TargetingChip = memo(function TargetingChip({ targeting }: { targeting: 'A' | 'M' | 'AUTO' | 'MANUAL' }) {
  const auto = targeting === 'A' || targeting === 'AUTO'
  return <IdentityChip label={auto ? 'A' : 'M'} tone={auto ? 'auto' : 'manual'} tip={auto ? 'Targeting: Automatic' : 'Targeting: Manual'} />
})

const PROGRAM_NAMES: Record<string, string> = { SP: 'Sponsored Products', SB: 'Sponsored Brands', SD: 'Sponsored Display' }

export const ProgramChip = memo(function ProgramChip({ program }: { program: 'SP' | 'SB' | 'SD' | string }) {
  return <IdentityChip label={program} tone="program" tip={PROGRAM_NAMES[program] ?? program} />
})

/* ── sheet cells: long text, readiness, follows-master, required ─────────────────────────── */

/**
 * The cap fields as the WIRE states them — `LongTextCellParams` is re-exported from
 * `longTextState.ts` so the rule and the renderer cannot disagree about their shape.
 *
 * 🔴 The old props were `{ maxLength, countBytes }`: a cap plus a UNIT FLAG. That shape is what let
 * a byte cap be dropped — `product_description` carries `maxBytes: 20000` and reached this cell as
 * `countBytes: true` with `maxLength: undefined`, so it counted bytes against nothing and reported
 * the field as fine. Taking the raw caps removes the shape that made the loss expressible.
 */
export type { LongTextCaps as LongTextCellParams } from './longTextState'

/**
 * A title / bullet / description cell: one line, ellipsis, and a MARK for how much room is left
 * (spec §9.3a). The figures live in the tooltip.
 *
 * 🔴 `filled` carries a VISIBLE mark and that is load-bearing, not decoration. `unchecked` — no cap
 * was supplied for this column — is deliberately SILENT, because it is the majority case (60 of 96
 * columns) and a mark on most cells would drain the salience from the ones that matter. Silence can
 * only mean "nothing is known here" while "known and within cap" looks different. **If `filled` is
 * ever made silent too, that ruling flips and `unchecked` takes the mark instead** (UX.1, §9.3a) —
 * whoever changes `filled` owns re-reading that line.
 *
 * 🔴 The glyphs differ in SHAPE, not only in tone: amber and red are the same mark to a large
 * minority of operators, so `●` / `◆` / `▲` carry the distinction and the colour reinforces it.
 */
const MARK: Record<'filled' | 'near' | 'over', string> = { filled: '●', near: '◆', over: '▲' }

/**
 * The save reason as TEXT inside the cell, visually hidden.
 *
 * 🔴 The tooltip is a HOVER overlay. A screen reader gets nothing from it, a keyboard-only operator
 * gets nothing from it, and — measured the hard way — a DOM probe walking the cell finds nothing
 * either, which is how the reason came to be reported as unrendered when it was merely unhoverable
 * (#662). This node is the second route: same string as the tooltip's first paragraph, because both
 * read the tracker's `reason` rather than each phrasing it.
 *
 * `.nds-vh` is the DS's clip utility (#657) — NOT `display:none`, which would remove it from the
 * accessibility tree and leave this component doing nothing at all while looking like it worked.
 */
export function CellSaveReason({ reason }: { reason?: string }) {
  if (!reason) return null
  return <span className="nds-vh">{reason}</span>
}

/**
 * An EMPTY cell that a channel REQUIRES on this row — the one glyph, the one class, the one name,
 * for every renderer on every scope. Master rendered this span inline and the channel scopes
 * rendered `—` for the same state (measured 2026-09-04); each sheet now decides WHETHER (the shared
 * `columnRequiredByAny`) and this decides HOW it looks.
 */
export function RequiredValue() {
  return <span className="nds-cell-required" role="img" aria-label="Required">⚠ required</span>
}

export const LongTextCell = memo(function LongTextCell(p: ICellRendererParams & LongTextCaps) {
  const text = p.value == null ? '' : String(p.value)
  const reading = longTextState(p.value, p)
  if (reading.state === 'empty') {
    return p.required ? <RequiredValue /> : <EmptyValue />
  }
  const glyph = reading.state === 'unchecked' ? null : MARK[reading.state]
  return (
    /* 🔴 NO `title` here. A renderer that sets one gives the cell a SECOND tooltip, competing with
       the column's own and hiding the refusal reason behind whichever the pointer rested on. The
       figures reach the operator through `longTextTooltipLine` in the column's getter — see
       cellTooltip.ts. The mark's `aria-label` below stays: that is this element's own name, not a
       claim on the cell's tooltip. */
    <span className="nds-cell-longtext">
      <span className="nds-cell-longtext-text">{text}</span>
      {glyph && (
        <span
          className={`nds-cell-longtext-mark nds-cell-longtext-mark-${reading.state}`}
          role="img"
          aria-label={longTextMarkLabel(reading)}
        >
          {glyph}
        </span>
      )}
    </span>
  )
})

/**
 * Re-exported from `readiness.ts`, which is the ONE tone/label source for both readiness
 * vocabularies (programme §3). The private table that used to live here is gone: it was a second
 * copy, in a `.tsx` the node-environment test suite cannot reach.
 */
export type ReadinessState = RowReadinessState

export interface ReadinessValue {
  state: ReadinessState
  /** What is missing or wrong — the tooltip and the count. */
  issues?: string[]
  /** A live listing's channel id (ASIN, eBay item id) when `live`. */
  ref?: string
}

/**
 * Per channel × market: can this row ship? `value` is a `ReadinessValue` the page computes (from the
 * publish validator / readiness service). A count on the pill, the reasons on hover.
 */
export const ReadinessCell = memo(function ReadinessCell(p: ICellRendererParams) {
  const v = p.value as ReadinessValue | null | undefined
  if (!v) return <EmptyValue />
  const meta = readinessMeta(v.state, 'row')
  const n = v.issues?.length ?? 0
  const label = n && v.state !== 'live' && v.state !== 'ready' ? `${meta.label} · ${n}` : v.state === 'live' && v.ref ? `${meta.label} · ${v.ref}` : meta.label
  const pill = <Pill tone={meta.tone} size="sm">{label}</Pill>
  return n ? <InfoTip tip={v.issues!.join(' · ')}>{pill}</InfoTip> : pill
})

export interface FollowsCellParams {
  /** The label of what is followed (default "master"). */
  of?: string
}

/**
 * The follows-master control beside a per-market value (FFD10): a per-market cell is a PROJECTION,
 * and writing it while the market still follows master is a silent no-op. This cell says which it
 * is — `Follows master` or `Pinned` — and the page flips the flag when the value is edited.
 */
export const FollowsCell = memo(function FollowsCell(p: ICellRendererParams & FollowsCellParams) {
  if (p.value == null) return <EmptyValue />
  const follows = !!p.value
  return (
    <span className={follows ? 'nds-cell-follows' : 'nds-cell-follows nds-cell-follows-pinned'} title={follows ? `Follows ${p.of ?? 'master'} — edit the value to pin it` : `Pinned for this market — clear to follow ${p.of ?? 'master'} again`}>
      {follows ? `Follows ${p.of ?? 'master'}` : 'Pinned'}
    </span>
  )
})

/* ── identity ─────────────────────────────────────────────────────────────────────────────── */

export interface IdentityCellProps {
  image?: string | null
  photoCount?: number
  /** The title line. A string becomes the same-tab link when `href` is given. */
  title: ReactNode
  href?: string
  /** Hover-revealed "Open" pill that opens `href` in a NEW tab. */
  openPill?: boolean
  /** The sub-line: SKU, tags, counts — the caller's own nodes. */
  sub?: ReactNode
  /** Sits before the thumbnail (an expander, a drag handle). */
  leading?: ReactNode
  /** `title` attribute on the link — the full name when the visible one truncates. */
  titleAttr?: string
  /** Hide the image column entirely (SKU-first rows without artwork). */
  noImage?: boolean
}

/**
 * photo · title / sub-line — the identity cell every catalogue-style grid draws. Geometry is the
 * products page's, measured: 11px gaps, the title a `--nds-primary` semibold ellipsis at 330px max.
 */
export const IdentityCell = memo(function IdentityCell({ image, photoCount, title, href, openPill, sub, leading, titleAttr, noImage }: IdentityCellProps) {
  return (
    <div className="nds-cell-identity">
      {leading}
      {!noImage && <Thumbnail src={image ?? null} photoCount={photoCount} alt={typeof title === 'string' ? title : ''} />}
      <div className="nds-cell-identity-meta">
        <div className="nds-cell-title-row">
          {href ? (
            <Link href={href} className="nds-cell-title-link" title={titleAttr} onClick={(e) => e.stopPropagation()}>
              {title}
            </Link>
          ) : (
            title
          )}
          {href && openPill && (
            <a className="nds-cell-open" href={href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              <ExternalLink size={11} /> Open
            </a>
          )}
        </div>
        {sub && <div className="nds-cell-sub">{sub}</div>}
      </div>
    </div>
  )
})

/** The monospace SKU in a sub-line. */
export const SkuTag = memo(function SkuTag({ children }: { children: ReactNode }) {
  return <span className="nds-cell-sku">{children}</span>
})

/** The 20px chevron that expands a tree row, and the slot that keeps a leaf aligned. */
export interface ExpandButtonProps {
  expanded: boolean
  onToggle: () => void
  labels?: [collapsed: string, expanded: string]
}

/**
 * Whether an AG row node is expanded, as a subscription.
 *
 * 🔴 AG re-renders a cell renderer on expand, but it does NOT re-run it with a fresh `node.expanded`
 * in every path, so a renderer that reads `node.expanded` once draws a chevron that stops matching
 * the tree it controls. The node's own `expandedChanged` event is the only reliable source.
 *
 * In the ENGINE because both sheets' identity band owns the expander now (#719): master had this
 * hook privately and the channel scope was about to need its own copy, which is the fork the
 * shared-component rule exists to prevent — two subscriptions to one AG behaviour, drifting apart
 * the first time AG changes when it fires.
 */
export function useExpanded(node: IRowNode): boolean {
  const [expanded, setExpanded] = useState(!!node.expanded)
  useEffect(() => {
    const on = () => setExpanded(!!node.expanded)
    node.addEventListener('expandedChanged', on)
    return () => node.removeEventListener('expandedChanged', on)
  }, [node])
  return expanded
}

export const ExpandButton = memo(function ExpandButton({ expanded, onToggle, labels = ['Expand', 'Collapse'] }: ExpandButtonProps) {
  return (
    <button
      type="button"
      className="nds-cell-expand"
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      aria-label={expanded ? labels[1] : labels[0]}
      aria-expanded={expanded}
    >
      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
    </button>
  )
})

export const ExpandSlot = memo(function ExpandSlot() {
  return <span className="nds-cell-expand-slot" aria-hidden />
})
