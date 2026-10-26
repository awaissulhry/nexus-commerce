'use client'

/**
 * Reviews › Inbox — the grid's columns (build spec §3.2, the Inbox board): Received · Channel · Stars · Review ·
 * Product · order · Status by default, so the list fits beside the Reviews sub-sidebar (928px of grid at a 1280px
 * window: Review's 200px minimum keeps the seven inside it); Mood · themes and Owner · due
 * come back with Customise. Received and Stars sort on the server (a header click is the API's `sort`); the rest show
 * what the row says. A review in another language shows its English on hover (`HoverCard`). Every word comes from
 * `inboxTiles.ts`.
 */
import { memo } from 'react'
import { HoverCard, StarRating } from '@/design-system/components'
import { statusColumn, type ColDef, type ICellRendererParams } from '@/design-system/grid'
import { Pill, Tag } from '@/design-system/primitives'
import type { PreferencesColumnSpec, PreferencesValue } from '@/design-system/patterns'
import { MOOD_WORD, STATUS_WORD, channelMarketWords, themeWord } from '../_lib/reviewWords'
import type { InboxRow } from './inboxDatasource'
import { MOOD_TONE, STATUS_TONE, agoWords, dayWords, dueWords, hasTranslation, kindWords, languageWords, productWords } from './inboxTiles'
import s from './inbox.module.css'

type Cell = ICellRendererParams<InboxRow>

const ReceivedCell = memo(function ReceivedCell({ data }: Cell) {
  if (!data) return null
  return (
    <span className={s.stack}>
      <span className={s.main}>{dayWords(data.postedAt)}</span>
      <span className={s.sub}>{agoWords(data.postedAt, Date.now())}</span>
    </span>
  )
})

const ChannelCell = memo(function ChannelCell({ data }: Cell) {
  if (!data) return null
  return (
    <span className={s.stack}>
      <span className={s.main}>{channelMarketWords(data.channel, data.market, 'short')}</span>
      <span className={s.sub}>{kindWords(data)}</span>
    </span>
  )
})

const StarsCell = memo(function StarsCell({ data }: Cell) {
  if (!data) return null
  return <StarRating value={data.rating} size="sm" />
})

const ReviewCell = memo(function ReviewCell({ data }: Cell) {
  if (!data) return null
  const language = languageWords(data.language)
  const body = (
    <span className={s.stack}>
      <span className={s.snippet}>{data.snippet || 'No text'}</span>
      <span className={s.sub}>{[language, data.buyer].filter(Boolean).join(' · ') || 'Buyer not named'}</span>
    </span>
  )
  return hasTranslation(data) ? <HoverCard text={`In English: ${data.english}`}>{body}</HoverCard> : body
})

const ProductCell = memo(function ProductCell({ data }: Cell) {
  if (!data) return null
  const product = productWords(data)
  return (
    <span className={s.stack}>
      <span className={product ? s.main : s.muted}>{product ?? 'No product link'}</span>
      <span className={s.sub}>{data.order?.label ?? 'No order'}</span>
    </span>
  )
})

const MoodCell = memo(function MoodCell({ data }: Cell) {
  if (!data) return null
  const [first, ...rest] = data.themes
  return (
    <span className={s.line}>
      {data.mood ? <Pill tone={MOOD_TONE[data.mood] ?? 'neutral'}>{MOOD_WORD[data.mood] ?? data.mood}</Pill> : <span className={s.muted}>Not read yet</span>}
      {first && <Tag tone="neutral">{themeWord(first)}</Tag>}
      {rest.length > 0 && <span className={s.sub} title={rest.map(themeWord).join(', ')}>+{rest.length}</span>}
    </span>
  )
})

const OwnerCell = memo(function OwnerCell({ data }: Cell) {
  if (!data) return null
  const due = dueWords(data, Date.now())
  return (
    <span className={s.stack}>
      <span className={data.assignee ? s.main : s.muted}>{data.assignee ?? 'Nobody'}</span>
      <span className={due.kind === 'late' ? s.dueLate : due.kind === 'soon' ? s.dueSoon : s.sub}>{due.text}</span>
    </span>
  )
})

/** One column of the Inbox, with what Customise needs to know. */
interface InboxColumn {
  key: string
  label: string
  shown: boolean
  def: ColDef<InboxRow>
}

const STATUS_TONES = Object.fromEntries(Object.entries(STATUS_WORD).map(([key, label]) => [key, { tone: STATUS_TONE[key] ?? 'neutral', label }]))

const COLUMNS: readonly InboxColumn[] = [
  { key: 'received', label: 'Received', shown: true, def: { colId: 'received', headerName: 'Received', field: 'postedAt', width: 104, sortable: true, cellRenderer: ReceivedCell } },
  { key: 'channel', label: 'Channel', shown: true, def: { colId: 'channel', headerName: 'Channel', width: 150, sortable: false, cellRenderer: ChannelCell } },
  { key: 'stars', label: 'Stars', shown: true, def: { colId: 'stars', headerName: 'Stars', field: 'rating', width: 104, sortable: true, cellRenderer: StarsCell } },
  { key: 'review', label: 'Review', shown: true, def: { colId: 'review', headerName: 'Review', minWidth: 200, flex: 1, sortable: false, cellRenderer: ReviewCell } },
  { key: 'product', label: 'Product · order', shown: true, def: { colId: 'product', headerName: 'Product · order', width: 200, sortable: false, cellRenderer: ProductCell } },
  { key: 'mood', label: 'Mood · themes', shown: false, def: { colId: 'mood', headerName: 'Mood · themes', width: 200, sortable: false, cellRenderer: MoodCell } },
  {
    key: 'status', label: 'Status', shown: true,
    def: { ...statusColumn<InboxRow>('status', { tones: STATUS_TONES, fallbackTone: 'neutral' }), colId: 'status', headerName: 'Status', width: 120, sortable: false },
  },
  { key: 'owner', label: 'Owner · due', shown: false, def: { colId: 'owner', headerName: 'Owner · due', width: 150, sortable: false, cellRenderer: OwnerCell } },
]

/** The grid's columns; Mood · themes and Owner · due start hidden (Customise brings them back). */
export const INBOX_COLUMN_DEFS: ColDef<InboxRow>[] = COLUMNS.map((c) => ({ ...c.def, hide: !c.shown }))

/**
 * The column slices of the grid's first state when nothing is saved yet. AG reads a state that names a sort but no
 * column slice as a reset of every column it does not mention: all shown (`hide` in the definitions is overridden) and
 * no flex (Review froze at its minimum width, then was saved as a fixed width). Measured on the products page
 * 2026-09-05 and again here; so the page's own default says what starts hidden and which column takes the room.
 */
export const INBOX_FIRST_COLUMN_STATE = {
  columnVisibility: { hiddenColIds: COLUMNS.filter((c) => !c.shown).map((c) => c.key) },
  columnSizing: { columnSizingModel: COLUMNS.filter((c) => c.def.flex).map((c) => ({ colId: c.key, flex: c.def.flex ?? undefined })) },
}

/** Customise: every column, which show at first, and the bridge to AG's column state. */
export const INBOX_COLUMN_SPECS: PreferencesColumnSpec[] = COLUMNS.map((c) => ({ key: c.key, label: c.label }))
export const INBOX_DEFAULT_VISIBLE: string[] = COLUMNS.filter((c) => c.shown).map((c) => c.key)
export const INBOX_PREFS_BRIDGE = { columns: COLUMNS.map((c) => ({ key: c.key, locked: false })) }
export const INBOX_DEFAULT_PREFS: PreferencesValue = {
  visibleColumns: INBOX_DEFAULT_VISIBLE,
  lockedColumns: [],
  stickyFirstColumn: true,
  stickyLastColumn: false,
  pageSize: 0,
  sortBy: '',
  sortDir: 'desc',
}
