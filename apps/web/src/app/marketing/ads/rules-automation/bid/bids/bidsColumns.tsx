'use client'

/**
 * Bid page, Bids view — the bids table's columns and cells. One registry (`BID_COLUMN_SPECS`) names every column once:
 * the grid, Customise and the tests read it, so the two cannot drift.
 *
 * The cells only show; a click on a row (or Enter on a cell) opens the keyword's side panel, and a link in a cell is a
 * link (the DS entity-links cell and the owner chip keep their click from the row). Hover lines say the rest. Money is
 * in the row's own currency (`_shared/format.ts`); a money key the server left out (no ad-spend permission) reads as a
 * dash. Every header has the grid's ⋮ menu (sort, pin, size, Customise, Reset), as on the Rules table.
 *
 * Keyword Auto (KEYWORD-AUTO.md): Auto (a switch per keyword), Suggested (Amazon's median, the range and its age on hover,
 * Apply) and Goal (the keyword's own target ACoS and max) show only when the answer carries their fields
 * (`BidColumnFeatures`); without them the table is as before — never a made-up value.
 */
import { memo, type ReactNode } from 'react'
import { ArrowDownRight, ArrowUpRight, Brain, CircleSlash, Clock, Gauge, ListChecks, Moon, MousePointerClick, Pause, ShoppingCart, User } from 'lucide-react'
import { Button, Pill, Tag } from '@/design-system/primitives'
import { DetailPopover, EntityLinks, Sparkline, sparkWords, type EntityLinkComponent } from '@/design-system/components'
import { entityLinksColumn, integerColumn, keepFromGrid, switchColumn, type ColDef, type ICellRendererParams } from '@/design-system/grid'
import Link from '@/lib/workspaces/Link'
import { CHANGE_STATE_TONE, CHANGE_STATE_WORD } from '../_shared/delivery'
import { money, moneyText, WEEK } from '../_shared/format'
import {
  acosText, aimDirection, AUTO_WORDS, contestedMark, floorGivesBack, lastChangeWords, matchWord, ownerHint, ownerLabel, ownerTone, ownerWords, resultsWords,
  type BidGridRow, type OwnerKind, type WriterLink,
} from './bidsModel'
import { FullName } from '../_shared/FullName'
import { goalText } from './goalModel'
import { deliveryChip } from './liveModel'
import { actionCellKeys, ownerCellKeys, placeCellKeys } from './ownerKeys'
import { suggestedWords } from './suggestedModel'
import styles from './bids.module.css'

/** What the cells ask the view (AG's `context`, a ref that never changes identity). */
export interface BidsCellHandlers {
  openWhy(targetId: string): void
  /** Apply Amazon's suggested bid to this row (through the review); absent without the permission. */
  apply?: (row: BidGridRow) => void
  /** The Auto switch was flipped (through the review); absent without the permission (the switch only shows). */
  onSwitch?: (row: BidGridRow, next: boolean, field: string) => void
}
export interface BidsCellContext { readonly current: BidsCellHandlers }
type Cell = ICellRendererParams<BidGridRow> & { context?: BidsCellContext }
const WorkspaceLink = Link as unknown as EntityLinkComponent

/** The owner's icon (outline, decorative: the chip says the words). */
export function OwnerIcon({ kind, size = 12 }: { kind: OwnerKind; size?: number }) {
  const props = { size, strokeWidth: 2.25, 'aria-hidden': true as const, className: 'nds-cell-glyph' }
  switch (kind) {
    case 'BRAIN': return <Brain {...props} />
    case 'RULE': return <ListChecks {...props} />
    case 'PLAN': return <Clock {...props} />
    case 'PERSON': return <User {...props} />
    case 'ENGINE': return <Gauge {...props} />
    // Nobody sets it: no mark, the plain dash says it (re-audit NICE: "⊘ —" read as a thing, not as nothing).
    case 'NONE': return null
    default: return <CircleSlash {...props} />
  }
}

/**
 * A writer as a chip. A rule's chip is a link to its detail on this page; the Brain's chip opens the keyword's Why tab
 * (`onWhy`); the rest are their words, with who on hover. Never a link to another page (Owner 2026-10-10).
 */
function WriterChip({ kind, label, hint, href, onWhy }: { kind: OwnerKind; label: string; hint: string; href: string | null; onWhy?: () => void }) {
  // Nobody: a plain muted dash, not a chip.
  if (kind === 'NONE') return <span className="nds-cell-muted" title={hint} aria-label={hint} role="img">—</span>
  const body = <span className={styles.inline}><OwnerIcon kind={kind} /><span className={styles.ellipsis}>{label}</span></span>
  if (href) {
    return (
      <Link href={href} className={styles.chipLink} title={hint} aria-label={hint}>
        <Pill tone={ownerTone(kind)} size="sm" className={styles.pillFit}>{body}</Pill>
      </Link>
    )
  }
  if (onWhy) {
    return (
      <Pill tone={ownerTone(kind)} size="sm" className={styles.pillFit} onClick={onWhy} title={`${hint} · Why`} aria-label={`${hint}: why`} data-owner-action="">
        {body}
      </Pill>
    )
  }
  return (
    <span className={styles.chip} title={hint} aria-label={hint} role="img">
      <Pill tone={ownerTone(kind)} size="sm" className={styles.pillFit}>{body}</Pill>
    </span>
  )
}

/** "+N": the other writers of this bid — on hover, click, Enter or Space; a rule opens its detail, the Brain the Why tab. */
function OthersList({ others, onWhy, returnFocus }: { others: readonly WriterLink[]; onWhy?: () => void; returnFocus?: () => void }) {
  if (!others.length) return null
  const names = others.map((w) => w.name).join(', ')
  return (
    <DetailPopover
      trigger={`+${others.length}`}
      triggerLabel={`Also sets it: ${names}`}
      triggerClassName="nds-entitylinks-count"
      label="Also sets it"
      hoverDelay={150}
      returnFocus={returnFocus}
    >
      {({ close }) => (
        <ul className="nds-entitylinks-list">
          {others.map((w) => (
            <li key={w.key}>
              <span className={styles.inline}>
                <OwnerIcon kind={w.kind} />
                {w.href
                  ? <Link href={w.href} className="nds-entitylink" title={w.hint} onClick={() => close()}>{w.name}</Link>
                  : w.why && onWhy
                    ? <Button size="xs" variant="link" title={`${w.hint} · Why`} onClick={() => { close({ returnFocus: false }); onWhy() }}>{w.name}</Button>
                    : <span className="nds-entitylink is-plain" title={w.hint}>{w.name}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </DetailPopover>
  )
}

/**
 * Who sets the bid: a chip with an icon (a rule opens its detail on this page, the Brain the keyword's Why tab), and
 * "+N" when other writers write it too (their names on hover and focus). The chip's hover line and accessible name say
 * every writer.
 */
export function OwnerChip({ row, onWhy, returnFocus }: { row: Pick<BidGridRow, 'owner' | 'ownerHref' | 'ownerWhy' | 'others'>; onWhy?: () => void; returnFocus?: () => void }) {
  const hint = ownerHint(row.owner)
  return (
    <span className={styles.ownerCell}>
      <WriterChip kind={row.owner.kind} label={ownerLabel(row.owner)} hint={hint} href={row.ownerHref} onWhy={row.ownerWhy ? onWhy : undefined} />
      {contestedMark(row.owner) && <OthersList others={row.others} onWhy={onWhy} returnFocus={returnFocus} />}
    </span>
  )
}

/** The night-floor mark beside a bid: a moon, and what the morning gives back. */
export function NightFloorMark({ row }: { row: Pick<BidGridRow, 'nightFloor' | 'spark' | 'currency'> }) {
  if (!row.nightFloor) return null
  const back = floorGivesBack(row)
  const words = back == null ? 'Night floor until the morning' : `Night floor · back to ${money(back, row.currency)} in the morning`
  return (
    <span className={styles.mark} role="img" aria-label={words} title={words}>
      <Moon size={12} strokeWidth={2.25} className={`nds-cell-glyph ${styles.moon}`} aria-hidden />
    </span>
  )
}

/** The keyword, and its match type under it (the Match column is in Customise for sorting). */
const KeywordCell = memo(function KeywordCell({ data, eGridCell }: Cell) {
  if (!data) return null
  const match = matchWord(data.match)
  return (
    <span className={styles.two}>
      <FullName full={data.text} cell={eGridCell} className={styles.keyword} />
      {match !== '—' && <span className={styles.subMuted}>{match}</span>}
    </span>
  )
})

/**
 * Where the bid lives: its campaign on the first line, its ad group under it — each a link, each with the room of the
 * whole column, so the names read at 1440 px (audit S10). Enter follows the campaign, ⇧ Enter the ad group. A name cut
 * short shows whole on hover and on keyboard focus (`FullName`).
 */
const PlaceCell = memo(function PlaceCell({ data, eGridCell }: Cell) {
  if (!data) return null
  return (
    <FullName full={placeWords(data)} cell={eGridCell} className={styles.fill}>
      <span onClickCapture={keepFromGrid} className={styles.two}>
        <EntityLinks items={data.campaigns} noun={CAMPAIGN_NOUN} linkAs={WorkspaceLink} />
        <span className={styles.sub}><EntityLinks items={data.adGroups} noun={AD_GROUP_NOUN} linkAs={WorkspaceLink} /></span>
      </span>
    </FullName>
  )
})

/** The place in words, for its tooltip: "Campaign: … · Ad group: …". */
const placeWords = (r: BidGridRow): string =>
  [r.campaign?.name ? `Campaign: ${r.campaign.name}` : '', r.adGroup?.name ? `Ad group: ${r.adGroup.name}` : ''].filter(Boolean).join(' · ')

/** The Auto cell when no engine runs the campaign: a muted dash; the reason on hover and on keyboard focus. */
const AutoNoneCell = memo(function AutoNoneCell({ data, eGridCell }: Cell) {
  if (!data) return null
  const why = data.autoWhy?.trim() || 'No engine runs this campaign'
  return <FullName full={why} cell={eGridCell} always label={`No engine: ${why}`} className={`nds-cell-muted ${styles.reasonMark}`}>—</FullName>
})

const MatchCell = memo(function MatchCell({ data }: Cell) {
  if (!data) return null
  const word = matchWord(data.match)
  return word === '—' ? <span className="nds-cell-muted">—</span> : <Tag tone="neutral">{word}</Tag>
})

const OwnerCell = memo(function OwnerCell({ data, eGridCell, context }: Cell) {
  if (!data) return null
  return (
    <span className={styles.cellFill} onClickCapture={keepFromGrid}>
      <OwnerChip row={data} onWhy={() => context?.current.openWhy(data.targetId)} returnFocus={eGridCell ? () => eGridCell.focus() : undefined} />
    </span>
  )
})

const BidNowCell = memo(function BidNowCell({ data }: Cell) {
  if (!data) return null
  const chip = deliveryChip(data)
  return (
    <span className={styles.money}>
      {chip && <span title={`The newest change: ${CHANGE_STATE_WORD[chip]}`}><Tag tone={CHANGE_STATE_TONE[chip]}>{CHANGE_STATE_WORD[chip]}</Tag></span>}
      <NightFloorMark row={data} />
      <span title={typeof data.bidNow === 'number' ? undefined : 'Hidden'}>{moneyText(data.bidNow, data.currency)}</span>
    </span>
  )
})

/** Amazon's suggested bid: its median, the range and its age on hover and focus, and Apply when it differs from the bid. */
const SuggestedCell = memo(function SuggestedCell({ data, context }: Cell) {
  if (!data) return null
  const cell = data.suggested ?? { kind: 'loading' as const }
  const w = suggestedWords(cell, data.currency)
  const apply = context?.current.apply
  const differs = w.mid !== null && typeof data.bidNow === 'number' && w.mid !== data.bidNow
  return (
    <span className={styles.suggested} onClickCapture={keepFromGrid}>
      <span className={w.mid === null ? 'nds-cell-muted' : undefined} title={w.hint} aria-label={w.mid === null ? w.hint : `${w.text}: ${w.hint}`}>{w.text}</span>
      {differs && apply && (
        <Button size="xs" variant="secondary" data-cell-action="" title={`Set the bid to ${w.text}`} aria-label={`Apply ${w.text} to ${data.text}`} onClick={() => apply(data)}>Apply</Button>
      )}
    </span>
  )
})

/** The keyword's own goal ("20 % · max €0.80"); a click or Enter opens its Goal tab. Honest when no engine runs it. */
const GoalCell = memo(function GoalCell({ data, eGridCell }: Cell) {
  if (!data) return null
  if (data.auto === 'NONE') {
    const why = data.autoWhy?.trim() || 'No engine runs this campaign'
    return <FullName full={why} cell={eGridCell} always label={`No engine: ${why}`} className={`nds-cell-muted ${styles.reasonMark}`}>—</FullName>
  }
  const text = goalText(data.goal, data.currency)
  return <span className={text === '—' ? 'nds-cell-muted' : styles.ellipsis} title={text === '—' ? 'No goal of its own: its campaign\'s or product\'s applies' : text}>{text}</span>
})

const AimCell = memo(function AimCell({ data }: Cell) {
  if (!data) return null
  const dir = aimDirection(data)
  const arrow: ReactNode = dir === 'up'
    ? <span className={styles.mark} role="img" aria-label="Higher than now" title="Higher than now"><ArrowUpRight size={12} strokeWidth={2.25} className={`nds-cell-glyph ${styles.up}`} aria-hidden /></span>
    : dir === 'down'
      ? <span className={styles.mark} role="img" aria-label="Lower than now" title="Lower than now"><ArrowDownRight size={12} strokeWidth={2.25} className={`nds-cell-glyph ${styles.down}`} aria-hidden /></span>
      : null
  const held = data.heldBy ? `Held: ${data.heldBy.label}${data.heldBy.reason ? ` · ${data.heldBy.reason}` : ''}` : null
  return (
    <span className={styles.money}>
      {held && (
        <span className={styles.mark} role="img" aria-label={held} title={held}>
          <Pause size={12} strokeWidth={2.25} className="nds-cell-glyph nds-cell-muted" aria-hidden />
        </span>
      )}
      {arrow}
      <span>{moneyText(data.brainAim, data.currency)}</span>
    </span>
  )
})

const LastChangeCell = memo(function LastChangeCell({ data }: Cell) {
  if (!data) return null
  const w = lastChangeWords(data.lastChange, data.currency)
  if (!w) return <span className="nds-cell-muted" title="No change in 30 d">—</span>
  return (
    <span className={styles.inline} title={w.title}>
      <OwnerIcon kind={data.lastChange!.by.kind} />
      <span>{w.text}</span>
    </span>
  )
})

/** Clicks · orders · ACoS of 7 d, as icons and numbers; the hover line names them. */
const ResultsCell = memo(function ResultsCell({ data }: Cell) {
  if (!data) return null
  const w = resultsWords(data.d7, data.currency)
  return (
    <span className={styles.results} title={w.title} aria-label={w.title} role="img">
      <span className={styles.inline}><MousePointerClick size={12} strokeWidth={2.25} className="nds-cell-glyph nds-cell-muted" aria-hidden />{w.clicks}</span>
      <span className={styles.inline}><ShoppingCart size={12} strokeWidth={2.25} className="nds-cell-glyph nds-cell-muted" aria-hidden />{w.orders}</span>
      <span className={typeof data.d7.acosPct === 'number' ? undefined : 'nds-cell-muted'}>{w.acos}</span>
    </span>
  )
})

/** The bid at this hour on each of the last 7 days (the DS step line), in the row's own currency. */
const TrendCell = memo(function TrendCell({ data }: Cell) {
  if (!data) return null
  return (
    <span className="nds-cell-spark">
      <Sparkline values={data.spark ?? []} label={TREND_LABEL} format={(n) => money(n, data.currency)} width={72} />
    </span>
  )
})

const AcosCell = memo(function AcosCell({ data }: Cell) {
  if (!data) return null
  const pct = data.d7.acosPct
  return <span className={typeof pct === 'number' ? undefined : 'nds-cell-muted'} title={typeof pct === 'number' ? undefined : `No sales in ${WEEK}`}>{acosText(pct)}</span>
})

const SpendCell = memo(function SpendCell({ data }: Cell) {
  if (!data) return null
  return <>{moneyText(data.d7.spend, data.currency)}</>
})

const MaxCpcCell = memo(function MaxCpcCell({ data }: Cell) {
  if (!data) return null
  return <span title="The most a click can cost this hour: the bid with its highest placement">{moneyText(data.maxCpc, data.currency)}</span>
})

/** The trend's accessible name and hover line. */
export const TREND_LABEL = `Bid · ${WEEK}`

/**
 * Every column, once: its id, the words Customise shows, and whether it starts hidden or is locked in place. Match sits
 * under the keyword, and Portfolio and Changes 7 d start hidden, so the keyword, campaign, ad group and rule names have
 * room at 1440 px (audit S10); Customise shows them, and the keyword's panel always lists its portfolio and changes.
 */
export type BidColumnSpec = { key: string; label: string; locked?: boolean; hidden?: boolean }

/** The keyword-Auto columns the answer can carry (KEYWORD-AUTO.md): each shows only when its field is there. */
export interface BidColumnFeatures { suggested: boolean; auto: boolean; goal: boolean }
export const NO_COLUMN_FEATURES: BidColumnFeatures = { suggested: false, auto: false, goal: false }

/** `quiet`: starts hidden once this many keyword-Auto columns need its room (Trend first, then Last change, then Brain bid). */
const ALL_SPECS: ReadonlyArray<BidColumnSpec & { feature?: keyof BidColumnFeatures; quiet?: 1 | 2 | 3 }> = [
  { key: 'keyword', label: 'Keyword', locked: true },
  { key: 'match', label: 'Match', hidden: true },
  { key: 'portfolio', label: 'Portfolio', hidden: true },
  { key: 'campaign', label: 'Campaign · Ad group' },
  { key: 'owner', label: 'Who sets it' },
  { key: 'auto', label: 'Auto', feature: 'auto' },
  { key: 'bidNow', label: 'Bid now' },
  { key: 'suggested', label: 'Suggested', feature: 'suggested' },
  { key: 'goal', label: 'Goal', feature: 'goal' },
  { key: 'brainAim', label: 'Brain bid', quiet: 3 },
  { key: 'lastChange', label: 'Last change', quiet: 2 },
  { key: 'changes7d', label: `Changes ${WEEK}`, hidden: true },
  { key: 'results', label: `Results ${WEEK}` },
  { key: 'spark', label: `Trend ${WEEK}`, quiet: 1 },
  { key: 'clicks', label: `Clicks ${WEEK}`, hidden: true },
  { key: 'orders', label: `Orders ${WEEK}`, hidden: true },
  { key: 'acos', label: `ACoS ${WEEK}`, hidden: true },
  { key: 'spend', label: `Spend ${WEEK}`, hidden: true },
  { key: 'maxCpc', label: 'Max CPC', hidden: true },
]

/**
 * Every column, once: its id, the words Customise shows, and whether it starts hidden or is locked in place. Match sits
 * under the keyword, and Portfolio and Changes 7 d start hidden, so the names have room at 1440 px (audit S10). Each
 * keyword-Auto column that is there (Auto · Suggested · Goal) takes the room of one quiet column: Trend, then Last change,
 * then Brain bid start hidden. Customise shows them, and the keyword's detail always lists them.
 */
export function bidColumnSpecs(features: BidColumnFeatures = NO_COLUMN_FEATURES): BidColumnSpec[] {
  const extra = [features.suggested, features.auto, features.goal].filter(Boolean).length
  return ALL_SPECS
    .filter((c) => !c.feature || features[c.feature])
    .map(({ feature: _f, quiet, ...c }) => (quiet && extra >= quiet ? { ...c, hidden: true } : c))
}

/** The plain table's columns (no keyword-Auto fields). */
export const BID_COLUMN_SPECS: ReadonlyArray<BidColumnSpec> = bidColumnSpecs()

const LABEL: Record<string, string> = Object.fromEntries(ALL_SPECS.map((c) => [c.key, c.label]))
/** On a phone the three that matter come first: the keyword, its bid, who sets it; the rest scroll. */
const PHONE_FIRST = ['keyword', 'bidNow', 'owner']
const PORTFOLIO_NOUN = { one: 'portfolio', many: 'portfolios' }
const CAMPAIGN_NOUN = { one: 'campaign', many: 'campaigns' }
const AD_GROUP_NOUN = { one: 'ad group', many: 'ad groups' }
const numeric = { type: 'rightAligned', headerClass: 'nds-ag-head-num' } as const
const num = ['nds-ag-cell', 'nds-ag-num']

/** A money cell's words for the CSV and the clipboard, in the row's own currency. */
const moneyOf = (p: { value: unknown; data?: BidGridRow }) => moneyText(p.value as number | null, p.data?.currency ?? 'EUR')

/**
 * The columns. Every width holds its header with the ⋮ menu and its widest value, so nothing is cut at 1440 px; the
 * campaign and ad group share what is left (flex). A phone gets a narrow pinned keyword with its bid and owner beside it.
 * Built once per phone flag by the view (useMemo), so the grid sees a stable array.
 */
export function bidColumns(phone: boolean, features: BidColumnFeatures = NO_COLUMN_FEATURES): ColDef<BidGridRow>[] {
  const specs = bidColumnSpecs(features)
  const shown = new Set(specs.map((c) => c.key))
  const hidden = new Set(specs.filter((c) => c.hidden).map((c) => c.key))
  // With the keyword-Auto columns (and the row checkboxes, 43 px) the names share less room.
  const rich = features.suggested || features.auto || features.goal
  const cols: ColDef<BidGridRow>[] = [
    { colId: 'keyword', headerName: LABEL.keyword, valueGetter: (p) => p.data?.text ?? '', cellRenderer: KeywordCell, pinned: 'left', width: phone ? 140 : rich ? 180 : 196, cellClass: 'nds-ag-cell' },
    { colId: 'match', headerName: LABEL.match, valueGetter: (p) => matchWord(p.data?.match), cellRenderer: MatchCell, width: 124, cellClass: 'nds-ag-cell' },
    { ...entityLinksColumn<BidGridRow>('portfolios', { header: LABEL.portfolio, noun: PORTFOLIO_NOUN, linkAs: Link }), colId: 'portfolio', flex: 2, minWidth: 130 },
    {
      colId: 'campaign', headerName: LABEL.campaign, flex: 1, minWidth: rich ? 210 : 260, cellClass: 'nds-ag-cell', cellRenderer: PlaceCell,
      valueGetter: (p) => (p.data ? `${p.data.campaign.name} · ${p.data.adGroup.name}` : ''),
      suppressKeyboardEvent: placeCellKeys as ColDef<BidGridRow>['suppressKeyboardEvent'],
      headerTooltip: 'Enter: the campaign · Shift+Enter: the ad group',
    },
    {
      colId: 'owner', headerName: LABEL.owner, valueGetter: (p) => (p.data ? ownerWords(p.data.owner) : ''), getQuickFilterText: (p) => (p.data ? ownerWords(p.data.owner) : ''),
      cellRenderer: OwnerCell, width: rich ? 172 : 196, cellClass: 'nds-ag-cell', suppressKeyboardEvent: ownerCellKeys as ColDef<BidGridRow>['suppressKeyboardEvent'],
      headerTooltip: 'A rule opens its detail; the Brain opens Why. +N: others that set it too',
    },
    {
      ...switchColumn<BidGridRow>('autoOn', { header: LABEL.auto, label: (r) => `Auto for ${r.text}`, words: AUTO_WORDS, disabledReason: (r) => r.autoLock ?? null }),
      // No engine runs its campaign: a muted dash with the reason on hover and focus, never "Manual" (audit R1).
      cellRendererSelector: (p) => (p.data?.auto === 'NONE' ? { component: AutoNoneCell } : undefined),
      colId: 'auto', width: 112, headerTooltip: 'Auto: the engine moves this bid · Manual: you hold it · —: no engine runs its campaign',
    },
    { colId: 'bidNow', headerName: LABEL.bidNow, valueGetter: (p) => p.data?.bidNow ?? null, valueFormatter: moneyOf, cellRenderer: BidNowCell, width: features.auto || features.suggested || features.goal ? 128 : 104, cellClass: num, ...numeric },
    {
      colId: 'suggested', headerName: LABEL.suggested, width: 150, cellClass: num, ...numeric, cellRenderer: SuggestedCell,
      valueGetter: (p) => (p.data?.suggested?.kind === 'bid' ? p.data.suggested.bid.mid ?? null : null),
      valueFormatter: (p) => (p.data ? suggestedWords(p.data.suggested ?? { kind: 'loading' }, p.data.currency).text : ''),
      suppressKeyboardEvent: actionCellKeys as ColDef<BidGridRow>['suppressKeyboardEvent'],
      headerTooltip: 'Amazon\'s suggested bid: the median; the range on hover. Apply sets it',
    },
    {
      colId: 'goal', headerName: LABEL.goal, width: 150, cellClass: 'nds-ag-cell', cellRenderer: GoalCell,
      valueGetter: (p) => (p.data ? goalText(p.data.goal, p.data.currency) : ''),
      headerTooltip: 'This keyword\'s own target ACoS and max bid. Opens its Goal tab',
    },
    { colId: 'brainAim', headerName: LABEL.brainAim, valueGetter: (p) => p.data?.brainAim ?? null, valueFormatter: moneyOf, cellRenderer: AimCell, width: 112, cellClass: num, ...numeric, headerTooltip: 'The bid the Brain\'s goal asks for' },
    {
      colId: 'lastChange', headerName: LABEL.lastChange, valueGetter: (p) => (p.data?.lastChange ? Date.parse(p.data.lastChange.at) : null),
      valueFormatter: (p) => (p.data ? lastChangeWords(p.data.lastChange, p.data.currency)?.text ?? '—' : ''), cellRenderer: LastChangeCell, width: 164, cellClass: 'nds-ag-cell',
      headerTooltip: 'The night floor and its morning give-back are left out',
    },
    { ...integerColumn<BidGridRow>('changes7d'), colId: 'changes7d', headerName: LABEL.changes7d, width: 128 },
    {
      colId: 'results', headerName: LABEL.results, valueGetter: (p) => p.data?.d7.clicks ?? null, valueFormatter: (p) => (p.data ? resultsWords(p.data.d7, p.data.currency).title : ''),
      cellRenderer: ResultsCell, width: 148, cellClass: 'nds-ag-cell', headerTooltip: `Clicks · orders · ACoS, ${WEEK}`,
    },
    {
      colId: 'spark', headerName: LABEL.spark, valueGetter: (p) => p.data?.spark ?? null, sortable: false, cellRenderer: TrendCell, width: 112, cellClass: 'nds-ag-cell',
      valueFormatter: (p) => (p.data ? sparkWords(p.data.spark ?? [], (n) => money(n, p.data!.currency)) : ''),
      getQuickFilterText: () => '',
      headerTooltip: 'The bid at this hour on each of the last 7 days',
    },
    { ...integerColumn<BidGridRow>('d7.clicks'), colId: 'clicks', headerName: LABEL.clicks, width: 116 },
    { ...integerColumn<BidGridRow>('d7.orders'), colId: 'orders', headerName: LABEL.orders, width: 120 },
    { colId: 'acos', headerName: LABEL.acos, valueGetter: (p) => p.data?.d7.acosPct ?? null, valueFormatter: (p) => acosText(p.value as number | null), cellRenderer: AcosCell, width: 112, cellClass: num, ...numeric },
    { colId: 'spend', headerName: LABEL.spend, valueGetter: (p) => p.data?.d7.spend ?? null, valueFormatter: moneyOf, cellRenderer: SpendCell, width: 116, cellClass: num, ...numeric },
    { colId: 'maxCpc', headerName: LABEL.maxCpc, valueGetter: (p) => p.data?.maxCpc ?? null, valueFormatter: moneyOf, cellRenderer: MaxCpcCell, width: 112, cellClass: num, ...numeric, headerTooltip: 'The bid with its highest placement, this hour' },
  ]
  const shaped = cols.filter((c) => shown.has(c.colId as string)).map((c) => (hidden.has(c.colId as string) ? { ...c, hide: true } : c))
  if (!phone) return shaped
  const first = PHONE_FIRST.map((id) => shaped.find((c) => c.colId === id)!)
  return [...first, ...shaped.filter((c) => !PHONE_FIRST.includes(c.colId as string))]
}
