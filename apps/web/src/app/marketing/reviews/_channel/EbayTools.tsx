'use client'

/**
 * Reviews › eBay (build spec §3.5, rulings 3, 6, 7) — the eBay tools menu and the page's sections: a banner per market
 * Nexus is not reading (when a reconnect fixes it, replies there are held until then), tiles, eBay's own detailed seller ratings and
 * feedback by type (Trading GetFeedback, asked at most once an hour per account), the feedback list (the Inbox's seller
 * feedback rows: ticks, select-all and a bulk bar — Assign · Set status · Mark as responded; a row opens the Inbox's
 * review pop-up, where a reply of up to 500 characters is written). PR G (eBay's REST Feedback API): eBay's AI topics,
 * the buyers' photos in the list, revision requests (EbayRevisions.tsx) and leaving feedback for buyers
 * (EbayBuyerFeedback.tsx, each send an approval a person decides).
 */
import { memo, useCallback, useMemo, useState, type ComponentProps, type ReactNode } from 'react'
import { ChevronDown, ListChecks, MessageSquareReply, Search, UserPlus } from 'lucide-react'
import {
  Banner, Card, EmptyState, Field, HoverCard, Listbox, Menu, MetricStrip, Modal, PerformanceGraph, StarRating, useToast,
  type ChartSeries, type MenuItemDef,
} from '@/design-system/components'
import {
  GridCard, GridNoRowsOverlay, GridSearchSlot, GridSelectionActions, GridToolbar, NexusGrid, SelectionLabel, gridGeometry,
  type ColDef, type GridApi, type ICellRendererParams,
} from '@/design-system/grid'
import { Button, Input, Pill, SegmentedControl, Skeleton, Tag } from '@/design-system/primitives'
import { chart } from '@/design-system/tokens'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import Link from '@/lib/workspaces/Link'
import { useRouter } from '@/lib/workspaces/navigation'
import { reviewsSend } from '../_lib/reviewsFetch'
import { inboxHref } from '../_lib/reviewsLinks'
import { STATUS_WORD } from '../_lib/reviewWords'
import { SectionError } from '../_overview/SectionError'
import type { InboxRow } from '../inbox/inboxDatasource'
import {
  BULK_LABEL, SETTABLE_STATUSES, bulkActionHeld, bulkApplyHeld, bulkApplyLabel, bulkBody, bulkReach, bulkResultWords, bulkSkipWords,
  ownerChoices, type BulkAction, type BulkRow,
} from '../inbox/inboxBulk'
import { agoWords, dayWords, hasTranslation, languageWords, photoWords, productWords, readStateBanners } from '../inbox/inboxTiles'
import { tileMetrics } from './AmazonTools'
import { EbayBuyerFeedback, LEAVE_FEEDBACK_ID } from './EbayBuyerFeedback'
import { EbayRevisions, REVISIONS_ID } from './EbayRevisions'
import { topicTags } from './ebayToolsModel'
import {
  TYPE_TONE, TYPE_WORD, dsrRows, ebayTiles, feedbackTypeOf, filterFeedback, lockedLinks, periodLabel, plural, replyHeld, replyNote,
  sectionData, sectionError, sellerHubHref, summaryNote, typeChartRows, typeChartWords, typeOptions,
  type ChannelPeriod, type EbayReadState, type EbaySections as EbayData, type FeedbackFilter,
} from './channelModel'
import { lockParams, scopeTitleWords, type ReviewsLock } from './reviewsScope'
import s from './channel.module.css'

const TILE_MIN_PX = 132

// ── Tools menu ───────────────────────────────────────────────────────

export function EbayToolsMenu({ lock }: { lock: ReviewsLock }) {
  const [open, setOpen] = useState(false)
  const market = lockParams(lock).market
  // PR G — both sections are on this page: the menu takes the person there (and to its heading, for the keyboard). After
  // the menu has closed and handed the focus back to its button, or that hand-back would scroll the page up again.
  const goTo = (id: string) => () => {
    window.setTimeout(() => {
      const section = document.getElementById(id)
      if (!section) return
      const heading = section.querySelector<HTMLElement>('h2, h3')
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }) }
      section.scrollIntoView({ block: 'start' })
    }, 60)
  }
  const items: MenuItemDef[] = [
    { id: 'leave', label: 'Leave feedback for buyers', description: 'Positive only · each send waits for approval in Nexus', onSelect: goTo(LEAVE_FEEDBACK_ID) },
    { id: 'revisions', label: 'Feedback revision requests', description: '5 a calendar year, plus 5 per 1,000 feedback · asked in eBay Seller Hub', onSelect: goTo(REVISIONS_ID) },
    { id: 'hub', label: 'Open eBay Seller Hub', description: `${market ? scopeTitleWords(lock) : 'eBay'} · opens a new tab`, href: sellerHubHref(market), target: '_blank' },
  ]
  return <Menu label={<>eBay tools <ChevronDown size={11} aria-hidden /></>} items={items} open={open} onOpenChange={setOpen} align="right" />
}

// ── Sections ─────────────────────────────────────────────────────────

export interface EbaySectionsProps {
  lock: ReviewsLock
  period: ChannelPeriod
  sections: EbayData
  busy: boolean
  canManage: boolean
  me: string | null
  onRetry: () => void
}

export function EbaySections({ lock, period, sections, busy, canManage, me, onRetry }: EbaySectionsProps) {
  const tiles = sectionData(sections.tiles)
  const summary = sectionData(sections.summary)
  const readState = sectionData(sections.readState)
  const metrics = useMemo(() => (tiles ? tileMetrics(ebayTiles(tiles, summary, lock, period)) : null), [tiles, summary, lock, period])
  const banners = useMemo(() => readStateBanners(readState), [readState])

  return (
    <>
      {sectionError(sections.readState) && <SectionError error={sectionError(sections.readState)!} onRetry={onRetry} busy={busy} />}
      {banners.map((b) => (
        <Banner
          key={b.key}
          tone="warning"
          title={b.title}
          action={b.action ? <Button asChild size="sm"><Link href={b.action.href}>{b.action.label}</Link></Button> : undefined}
        >
          {/* Audit B18: nothing holds a reply here — say what really happens. */}
          {b.body}{b.action ? ' A reply sent before the account is connected again fails: eBay refuses it.' : ''}
        </Banner>
      ))}

      {sectionError(sections.tiles) ? (
        <SectionError error={sectionError(sections.tiles)!} onRetry={onRetry} busy={busy} />
      ) : metrics ? (
        <MetricStrip metrics={metrics} linkAs={Link} minTileWidth={TILE_MIN_PX} className={s.tiles} />
      ) : null}

      <SummaryCards lock={lock} sections={sections} busy={busy} onRetry={onRetry} />

      <FeedbackList lock={lock} period={period} sections={sections} busy={busy} canManage={canManage} me={me} onRetry={onRetry} />

      <EbayRevisions lock={lock} sections={sections} busy={busy} onRetry={onRetry} />

      <EbayBuyerFeedback lock={lock} canManage={canManage} />

      <p className={s.footnote}>
        Where the numbers come from: the feedback score, the share of positive, the counts by period and the detailed seller ratings are eBay’s own,
        for the whole eBay account, asked at most once an hour. Neutral, negative and the list are the feedback Nexus reads every 30 minutes. eBay’s
        own counts can be higher than the list: Nexus keeps only the feedback buyers left you as a seller, with words, and eBay’s newer read leaves
        out the feedback eBay leaves by itself. A reply is public, one per feedback, up to 500 characters, and can’t be edited or removed.
      </p>
    </>
  )
}

// ── eBay's summary: detailed ratings, feedback by type ───────────────

function SummaryCards({ lock, sections, busy, onRetry }: Pick<EbaySectionsProps, 'lock' | 'sections' | 'busy' | 'onRetry'>) {
  const summary = sectionData(sections.summary)
  const error = sectionError(sections.summary)
  const typeRows = useMemo(() => (summary ? typeChartRows(summary) : []), [summary])
  // Recharts takes colours as props (tokens/colors.ts `chart`).
  const left = useMemo<ChartSeries>(() => ({
    key: 'feedback', label: 'Feedback', color: chart.reference, axis: 'left', axisLabel: 'Feedback', format: (v) => Math.round(v).toLocaleString('en'),
    stack: [
      { key: 'positive', label: 'Positive', color: chart.positive },
      { key: 'neutral', label: 'Neutral', color: chart.neutral },
      { key: 'negative', label: 'Negative', color: chart.negative },
    ],
  }), [])
  const right = useMemo<ChartSeries>(() => ({ key: 'pct', label: '% positive', color: chart.actual, axis: 'right', axisLabel: '% positive', format: (v) => `${v.toFixed(1)}%` }), [])
  const note = summary ? summaryNote(summary, lock) : null
  const notRead = summary && (summary.state === 'not_read' || summary.state === 'no_account')

  const body = (content: ReactNode) =>
    error ? <SectionError error={error} onRetry={onRetry} busy={busy} /> : !summary ? <Skeleton height={180} /> : content

  return (
    <>
      {summary?.words && (
        <Banner tone={summary.state === 'partial' ? 'warning' : 'info'} title={notRead ? 'eBay’s own numbers are not shown.' : undefined}>
          {summary.words}
        </Banner>
      )}
      <div className={s.row}>
        <Card className={s.half} header="Detailed seller ratings" headingLevel={2} description={`eBay’s 1–5 ratings from buyers · ${summary?.dsrPeriod === 'ThirtyDays' ? 'last 30 days' : 'last 12 months'} · ${scopeTitleWords(lock)}`}>
          {body(notRead || !summary?.dsr.length ? (
            <EmptyState title="No ratings from eBay" description="eBay’s detailed seller ratings show here once eBay is read." />
          ) : summary!.dsr.every((d) => d.count === 0) ? (
            // Live audit C02: four rows of "No ratings" said one thing four times.
            <EmptyState title="No detailed ratings yet" description={`eBay has no detailed seller ratings from buyers for ${summary?.dsrPeriod === 'ThirtyDays' ? 'the last 30 days' : 'the last 12 months'}.`} />
          ) : (
            <ul className={s.dsrList} aria-label="Detailed seller ratings">
              {dsrRows(summary!).map((d) => (
                <li key={d.key} className={s.dsrRow}>
                  <span className={s.main}>{d.label}</span>
                  <StarRating value={d.rating} size="md" />
                  <b className={s.num}>{d.value}</b>
                  <span className={s.sub}>{d.count}</span>
                </li>
              ))}
            </ul>
          ))}
        </Card>
        <Card className={s.half} header="Feedback by type" headingLevel={2} description="eBay counts positive, neutral and negative, not stars · eBay’s periods">
          {body(notRead || typeRows.length === 0 ? (
            <EmptyState title="No counts from eBay" description="eBay’s counts by type show here once eBay is read." />
          ) : (
            <div className={s.stackGap}>
              <PerformanceGraph data={typeRows as unknown as Array<Record<string, number | string>>} xKey="when" left={left} right={right} height={210} />
              <p className="nds-vh">{typeChartWords(typeRows)}</p>
            </div>
          ))}
          {/* PR G — the topics are the feedback Nexus read, so they show whether or not eBay's own counts were read. */}
          <EbayTopicsBlock sections={sections} />
          {note && <p className={s.note}>{note}</p>}
        </Card>
      </div>
    </>
  )
}

// ── The feedback list ────────────────────────────────────────────────

interface FeedbackContext { readState: readonly EbayReadState[] | null }
type Cell = ICellRendererParams<InboxRow, unknown, FeedbackContext>

const ReceivedCell = memo(function ReceivedCell({ data }: Cell) {
  if (!data) return null
  return (
    <span className={s.stack}>
      <span className={s.main}>{dayWords(data.postedAt)}</span>
      <span className={s.sub}>{data.market ? `eBay ${data.market}` : 'eBay'} · {agoWords(data.postedAt, Date.now())}</span>
    </span>
  )
})

const TypeCell = memo(function TypeCell({ data }: Cell) {
  if (!data) return null
  const type = feedbackTypeOf(data.rating)
  return type ? <Pill tone={TYPE_TONE[type]}>{TYPE_WORD[type]}</Pill> : <span className={s.sub}>No type</span>
})

const CommentCell = memo(function CommentCell({ data }: Cell) {
  if (!data) return null
  const body = (
    <span className={s.stack}>
      <span className={s.snippet}>{data.snippet || 'No comment'}</span>
      <span className={s.sub}>{[data.buyer, languageWords(data.language), photoWords(data)].filter(Boolean).join(' · ') || 'Buyer not named'}</span>
    </span>
  )
  return hasTranslation(data) ? <HoverCard text={`In English: ${data.english}`}>{body}</HoverCard> : body
})

/** PR G — eBay's AI topics of one feedback (eBay's newer feedback read), the first two and "+n". */
const TopicsCell = memo(function TopicsCell({ data }: Cell) {
  if (!data) return null
  if (data.aiTopics == null) return <span className={s.sub} title="eBay’s topics are read for feedback read by eBay’s newer feedback API">Not read</span>
  const topics = data.aiTopics
  if (topics.length === 0) return <span className={s.sub}>None</span>
  const [first, second, ...rest] = topics
  const tone = (sentiment: string | null) => (sentiment === 'NEGATIVE' ? 'danger' : sentiment === 'POSITIVE' ? 'success' : 'neutral')
  return (
    <span className={s.inline}>
      <Tag tone={tone(first.sentiment)}>{first.label}</Tag>
      {second && <Tag tone={tone(second.sentiment)}>{second.label}</Tag>}
      {rest.length > 0 && <span className={s.sub} title={rest.map((t) => t.label).join(', ')}>+{rest.length}</span>}
    </span>
  )
})

const ItemCell = memo(function ItemCell({ data }: Cell) {
  if (!data) return null
  const product = productWords(data)
  return (
    <span className={s.stack}>
      <span className={product ? s.main : s.sub}>{product ?? 'No item link'}</span>
      <span className={s.sub}>{data.order?.label ?? 'No order'}</span>
    </span>
  )
})

const ReplyCell = memo(function ReplyCell({ data, context }: Cell) {
  if (!data) return null
  const held = replyHeld(data, context?.readState ?? null)
  return (
    <span className={s.inline}>
      {held
        ? <Button size="sm" heldReason={held}><MessageSquareReply size={13} aria-hidden /> Reply</Button>
        : <Button asChild size="sm"><Link href={inboxHref({ channel: 'EBAY', market: data.market, review: data.id })}><MessageSquareReply size={13} aria-hidden /> Reply</Link></Button>}
      <span className={s.sub}>{replyNote(data)}</span>
    </span>
  )
})

const StatusCell = memo(function StatusCell({ data }: Cell) {
  if (!data) return null
  return <span className={s.stack}><span className={s.main}>{STATUS_WORD[data.status] ?? data.status}</span><span className={s.sub}>{data.assignee ?? 'Nobody'}</span></span>
})

const FEEDBACK_COLUMNS: ColDef<InboxRow>[] = [
  { colId: 'received', headerName: 'Received', width: 132, minWidth: 120, cellRenderer: ReceivedCell },
  { colId: 'type', headerName: 'Type', width: 108, cellRenderer: TypeCell },
  { colId: 'comment', headerName: 'Comment', minWidth: 220, flex: 1, cellRenderer: CommentCell },
  { colId: 'topics', headerName: 'AI topics', width: 170, cellRenderer: TopicsCell },
  { colId: 'item', headerName: 'Item · order', width: 190, cellRenderer: ItemCell },
  { colId: 'reply', headerName: 'Reply', width: 190, cellRenderer: ReplyCell },
  { colId: 'status', headerName: 'Status · owner', width: 130, cellRenderer: StatusCell },
]

const feedbackRowId = (p: { data: InboxRow }) => p.data.id
const BULK_ICON = { assign: UserPlus, status: ListChecks, responded: MessageSquareReply } as const
type EbayBulk = 'assign' | 'status' | 'responded'
const EBAY_BULK: readonly EbayBulk[] = ['assign', 'status', 'responded']
const EBAY_BULK_LABEL: Record<EbayBulk, string> = { assign: BULK_LABEL.assign, status: BULK_LABEL.status, responded: 'Mark as responded' }
/** The Inbox's bulk action behind each button (Mark as responded = Set status to Responded). */
const INBOX_ACTION: Record<EbayBulk, BulkAction> = { assign: 'assign', status: 'status', responded: 'status' }

function FeedbackList({ lock, period, sections, busy, canManage, me, onRetry }: EbaySectionsProps) {
  const router = useRouter()
  const { toast } = useToast()
  const list = sectionData(sections.feedback)
  const error = sectionError(sections.feedback)
  const readState = sectionData(sections.readState)
  const [type, setType] = useState<FeedbackFilter>('all')
  const [search, setSearch] = useState('')
  const rows = useMemo(() => list?.rows ?? [], [list])
  const rowData = useMemo(() => filterFeedback(rows, type, search), [rows, type, search])
  const options = useMemo(() => typeOptions(rows), [rows])
  const columnDefs = useMemo(() => FEEDBACK_COLUMNS, [])
  const context = useMemo<FeedbackContext>(() => ({ readState }), [readState])
  const rowSelection = useMemo<NonNullable<ComponentProps<typeof NexusGrid<InboxRow>>['rowSelection']>>(() => ({
    mode: 'multiRow', checkboxes: true, headerCheckbox: true, enableClickSelection: false,
  }), [])
  const selectionColumnDef = useMemo(() => ({ width: gridGeometry.selectColW, maxWidth: gridGeometry.selectColW, resizable: false }), [])
  const [api, setApi] = useState<GridApi<InboxRow> | null>(null)
  const [ticked, setTicked] = useState<InboxRow[]>([])
  const onGridReady = useCallback((e: { api: GridApi<InboxRow> }) => setApi(e.api), [])
  const onSelectionChanged = useCallback((e: { api: GridApi<InboxRow> }) => setTicked(e.api.getSelectedRows()), [])
  const clear = useCallback(() => { if (api && !api.isDestroyed()) api.deselectAll() }, [api])
  const onRowClicked = useCallback((e: { data?: InboxRow; event?: Event | null }) => {
    const target = e.event?.target
    if (target instanceof Element && target.closest('a, button, .ag-selection-checkbox, .ag-checkbox, [col-id="ag-Grid-SelectionColumn"]')) return
    if (e.data) router.push(inboxHref({ channel: 'EBAY', market: e.data.market, review: e.data.id }))
  }, [router])
  const noRowsParams = useMemo(() => (type !== 'all' || search.trim()
    ? { title: 'No feedback matches', message: 'Pick All, or clear the search.', action: { label: 'Show all feedback', onClick: () => { setType('all'); setSearch('') } } }
    : { title: `No feedback in the ${periodLabel(period)}`, message: 'Feedback shows here as Nexus reads it from eBay, every 30 minutes.' }), [type, search, period])
  const [bulk, setBulk] = useState<EbayBulk | null>(null)
  const links = lockedLinks(lock, period)
  const truncated = list && list.total > rows.length

  const bulkButtons = EBAY_BULK.map((action) => {
    const Icon = BULK_ICON[action]
    const held = action === 'responded'
      ? bulkApplyHeld('status', 'RESPONDED', { canManage, rows: ticked })
      : bulkActionHeld(INBOX_ACTION[action], { canManage, rows: ticked })
    return (
      <Button key={action} size="sm" aria-label={EBAY_BULK_LABEL[action]} onClick={() => setBulk(action)} heldReason={held}>
        <Icon size={13} aria-hidden /> <SelectionLabel>{EBAY_BULK_LABEL[action]}</SelectionLabel>
      </Button>
    )
  })

  return (
    <>
      {error ? (
        <SectionError error={error} onRetry={onRetry} busy={busy} />
      ) : (
        <GridCard
          toolbar={(
            <GridToolbar
              count={ticked.length > 0 ? <><b>{ticked.length.toLocaleString('en')}</b> selected</> : list ? <><b>{rowData.length.toLocaleString('en')}</b> feedback</> : '—'}
              right={(
                <>
                  {/* A phone is narrower than the four choices: they scroll sideways inside the card, never off its edge. */}
                  <div className={s.segScroll}>
                    <SegmentedControl size="sm" ariaLabel="Type" options={options} value={type} onChange={(v) => setType(v as FeedbackFilter)} />
                  </div>
                  <Button asChild size="sm"><Link href={links.inbox({ kind: 'seller' })}>Open in the Inbox</Link></Button>
                </>
              )}
            >
              {ticked.length > 0 ? (
                <GridSelectionActions>
                  {bulkButtons}
                  <Button size="sm" variant="link" onClick={clear}>Clear</Button>
                </GridSelectionActions>
              ) : (
                <GridSearchSlot>
                  <Input
                    leadingIcon={<Search size={13} aria-hidden />}
                    placeholder="Search comment, buyer, item…"
                    aria-label="Search comment, buyer or item"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    style={{ width: '100%' }}
                  />
                </GridSearchSlot>
              )}
            </GridToolbar>
          )}
          footer={truncated ? (
            <p className={s.gridNote}>
              Showing the newest {plural(rows.length, 'feedback', 'feedback')} of {list!.total.toLocaleString('en')}. <Link href={links.inbox({ kind: 'seller' })} className={s.cellLink}>Open them all in the Inbox</Link>
            </p>
          ) : undefined}
        >
          {!list ? (
            <div className={s.pad}><Skeleton height={200} /></div>
          ) : (
            <NexusGrid<InboxRow>
              domLayout="autoHeight"
              rows="media"
              rowData={rowData}
              columnDefs={columnDefs}
              getRowId={feedbackRowId}
              context={context}
              rowSelection={rowSelection}
              selectionColumnDef={selectionColumnDef}
              onGridReady={onGridReady}
              onSelectionChanged={onSelectionChanged}
              onRowClicked={onRowClicked}
              rowClass={s.clickRow}
              noRowsOverlayComponent={GridNoRowsOverlay}
              noRowsOverlayComponentParams={noRowsParams}
            />
          )}
        </GridCard>
      )}

      {bulk && (
        <BulkDialog
          action={bulk}
          rows={ticked}
          canManage={canManage}
          owners={list?.owners ?? []}
          me={me}
          onClose={() => setBulk(null)}
          onDone={(words, tone) => { setBulk(null); clear(); toast(words, tone) }}
        />
      )}
    </>
  )
}

interface BulkDialogProps {
  action: EbayBulk
  rows: readonly BulkRow[]
  canManage: boolean
  owners: readonly string[]
  me: string | null
  onClose: () => void
  onDone: (words: string, tone: 'success' | 'warning') => void
}

/** One window per bulk action: pick the value (Mark as responded has none), see how many it changes, apply. */
function BulkDialog({ action, rows, canManage, owners, me, onClose, onDone }: BulkDialogProps) {
  const inboxAction = INBOX_ACTION[action]
  const [value, setValue] = useState(action === 'assign' && me ? me : action === 'responded' ? 'RESPONDED' : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reach = bulkReach(inboxAction, action === 'assign' ? value || null : value, rows)
  const held = busy ? 'Applying… this takes a few seconds.' : bulkApplyHeld(inboxAction, value, { canManage, rows })
  const skipped = bulkSkipWords(reach.skipped)

  const apply = async () => {
    setBusy(true)
    setError(null)
    const res = await reviewsSend<{ changed: number; skipped: { id: string; reason: string }[] }>(
      'POST', '/reviews/inbox/bulk', bulkBody(rows.map((r) => r.id), inboxAction, value), { idempotent: true, what: 'bulk change' },
    )
    setBusy(false)
    if (!res.data) {
      setError(res.error)
      return
    }
    emitInvalidation({ type: 'review.updated', meta: { bulk: inboxAction, changed: res.data.changed } })
    onDone(bulkResultWords(inboxAction, value || null, res.data), res.data.changed > 0 ? 'success' : 'warning')
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={`${EBAY_BULK_LABEL[action]} · ${rows.length.toLocaleString('en')} ticked`}
      footer={(
        <div className={s.dialogFoot}>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" onClick={() => void apply()} heldReason={held}>
            {action === 'responded' ? `Mark ${plural(reach.apply.length, 'feedback', 'feedback')} as responded` : bulkApplyLabel(inboxAction, value || null, reach.apply.length)}
          </Button>
        </div>
      )}
    >
      <div className={s.stackGap}>
        {action === 'assign' && (
          <Field label="Owner" hint="The person who answers this feedback. Nobody takes it off its owner.">
            <Listbox size="sm" ariaLabel="Owner" options={ownerChoices(owners, me)} value={value} onChange={setValue} searchable width="100%" />
          </Field>
        )}
        {action === 'status' && (
          <Field label="Status">
            <Listbox
              size="sm"
              ariaLabel="Status"
              placeholder="Pick a status"
              options={SETTABLE_STATUSES.map((v) => ({ value: v, label: STATUS_WORD[v] ?? v }))}
              value={value || undefined}
              onChange={setValue}
              width="100%"
            />
          </Field>
        )}
        {action === 'responded' && (
          <p className={s.note}>
            Records in Nexus that this feedback was answered — for a reply written on eBay itself. Nothing is sent to eBay: a reply from Nexus goes
            out from the review’s window in the Inbox.
          </p>
        )}
        {skipped && <p className={s.note}>{skipped}</p>}
        {error && <Banner tone="danger" title={error} />}
      </div>
    </Modal>
  )
}

// ── eBay's AI topics (PR G) ──────────────────────────────────────────

/** The topics eBay's AI found in the feedback of this page's scope and period; why none show, in words. */
function EbayTopicsBlock({ sections }: { sections: EbayData }) {
  const topics = sectionData(sections.topics)
  const error = sectionError(sections.topics)
  const tags = topicTags(topics)
  return (
    <div className={s.sampleBlock}>
      <span className={s.inline}><span className={s.main}>Topics eBay’s AI found in the feedback</span>{topics && topics.read > 0 && <span className={s.sub}>{`${topics.read.toLocaleString('en')} feedback read`}</span>}</span>
      {error ? (
        <span className={s.sub}>{error}</span>
      ) : tags.length > 0 ? (
        <span className={s.inline} role="group" aria-label="eBay’s AI topics">
          {tags.map((t) => <Tag key={t.key} tone={t.tone} title={t.title}>{t.text}</Tag>)}
        </span>
      ) : (
        <span className={s.sub}>{topics?.words ?? 'eBay’s topics show here once eBay’s feedback is read.'}</span>
      )}
    </div>
  )
}
