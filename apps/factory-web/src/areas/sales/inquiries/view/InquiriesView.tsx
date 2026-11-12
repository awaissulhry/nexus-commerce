'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { MoreHorizontal, Plus, UserRound, X, XCircle } from 'lucide-react'
import { EmptyState, Menu, MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Select } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import type { LiveState } from '../../../../shell/live/use-live'
import type { InquiryList, InquiryRow, PartyOption } from '../api'
import {
  assigneePhrase,
  bulkReach,
  chipsOf,
  DESIGN_TILES,
  HOME_ADDRESS,
  INQUIRY_SOURCES,
  isFiltered,
  isOpen,
  listHref,
  noticeKey,
  pageNotices,
  priceText,
  recordHref,
  SAVED_ROWS,
  tilePartial,
  tileValue,
  verbHeld,
  type InquiriesCan,
  type InquirySource,
  type InquiryTile,
  type ListAddress,
  type Notice,
  type RowVerb,
} from '../model'
import { Freshness, InquiriesMessages, isPageKey, NoAccess, NoticeLine, PageHead, SourceTag, StatusPill, useWords, WaitingTag } from '../parts'
import type { InquiryRecordActions, InquiryRecordModel } from '../record-model'
import { AssignDialog, DeclineDialog, type AssignModel, type DeclineModel } from './Dialogs'
import { InquiryDetail } from './InquiryDetail'
import { NewInquiryDialog, type NewInquiryActions, type NewInquiryModel } from './NewInquiryDialog'
import type { RecordSlots } from './RecordTabs'

/** Assign to… or Decline N over a selection (all or none: the API's bulk routes). */
export type BulkDialog = { readonly kind: 'assign'; readonly ids: readonly string[]; readonly model: AssignModel } | { readonly kind: 'decline'; readonly ids: readonly string[]; readonly model: DeclineModel }

/** SCR-105 — Sales › Inquiries: tiles, notices, the list, the inquiry in its DetailModal, New inquiry, Assign, Decline. */
export interface InquiriesModel {
  prefix: string
  me: string
  companyId: string | null
  can: InquiriesCan
  address: ListAddress
  /** The read: null while it is read; `problem` when it failed (never drawn as an empty list). */
  list: InquiryList | null
  problem: string | null
  /** The customers of the From filter (null without parties.view or not read). */
  customers: readonly PartyOption[] | null
  asOf: string | null
  live: LiveState
  /** Changes that arrived while the list was on screen ("N updates · Show"). */
  updates: number
  notice: Notice | null
  /** The notices dismissed on this device (by value). */
  dismissed: readonly string[]
  /** The rows a read brings at most (the API's limit). */
  limit: number
  newInquiry: NewInquiryModel | null
  bulk: BulkDialog | null
  /** The inquiry open in its DetailModal (`?open=`). */
  detail: InquiryRecordModel | null
  /** Design cases: the rows selected, the keys panel open, every notice listed. */
  selected?: readonly string[]
  keysOpen?: boolean
  noticesOpen?: boolean
}

export interface InquiriesActions {
  onAddress?: (patch: Partial<ListAddress>) => void
  onClearFilters?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onOpen?: (inquiryId: string | null) => void
  /** A row's verb: the inquiry opens with that verb's dialog (Make quote, Assign, Decline) or runs it (Ask for more information). */
  onRowVerb?: (row: InquiryRow, verb: RowVerb) => void
  onBulk?: (kind: 'assign' | 'decline', ids: readonly string[]) => void
  bulk?: {
    onAssign?: (assigneeId: string | null) => void
    onRetryPeople?: () => void
    onDecline?: (patch: Partial<DeclineModel['draft']>) => void
    onSubmit?: () => void
    onClose?: () => void
  }
  onNew?: () => void
  newInquiry?: NewInquiryActions
  record?: InquiryRecordActions
  onCopy?: (numbers: readonly string[]) => void
  onDismissNotice?: () => void
  onDismissPageNotice?: (key: string) => void
}

export function InquiriesView({ model, actions, slots }: { model: InquiriesModel; actions?: InquiriesActions; slots?: RecordSlots }) {
  return (
    <InquiriesMessages>
      <List model={model} actions={actions} slots={slots} />
    </InquiriesMessages>
  )
}

const INTL = { it: 'it-IT', en: 'en-GB' } as const

function List({ model, actions, slots }: { model: InquiriesModel; actions?: InquiriesActions; slots?: RecordSlots }) {
  const { t, say, locale, day, when } = useWords()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [search, setSearch] = useState(model.address.q)
  const [noticesOpen, setNoticesOpen] = useState(model.noticesOpen ?? false)
  useEffect(() => setSearch(model.address.q), [model.address.q])
  const rows = model.list?.rows ?? null
  const rowsKey = rows?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const offline = model.live === 'offline'
  const act = useRef(actions)
  act.current = actions
  const byId = useMemo(() => new Map((rows ?? []).map((row) => [row.id, row])), [rows])
  const open = (row: Pick<InquiryRow, 'id'>) => actions?.onOpen?.(row.id)
  const openHref = (row: Pick<InquiryRow, 'id'>) => listHref(model.prefix, { ...model.address, isNew: false, mail: null, open: row.id, tab: 'request' })

  // c: New inquiry; q / d / a: the focused (or the one selected) row's verb — never while typing or in a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.newInquiry || model.bulk || model.detail) return
      if (event.key === 'c' && model.can.manage) {
        event.preventDefault()
        act.current?.onNew?.()
        return
      }
      const verb: RowVerb | null = event.key === 'q' ? 'quote' : event.key === 'd' ? 'decline' : event.key === 'a' ? 'assign' : null
      if (!verb) return
      const focused = (document.activeElement as HTMLElement | null)?.closest('[row-id]')?.getAttribute('row-id') ?? (selected.length === 1 ? selected[0] : null)
      const row = focused ? byId.get(focused) : null
      if (row && !verbHeld(row, verb, model.can, offline)) {
        event.preventDefault()
        act.current?.onRowVerb?.(row, verb)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.newInquiry, model.bulk, model.detail, model.can, offline, selected, byId])

  const columns = useMemo<ColDef<InquiryRow>[]>(() => {
    const verbItem = (row: InquiryRow, verb: RowVerb, label: string): MenuItemDef => {
      const held = say(verbHeld(row, verb, model.can, offline))
      return { id: verb, label, disabled: !!held, description: held ?? undefined, onSelect: () => act.current?.onRowVerb?.(row, verb) }
    }
    const NumberCell = ({ data }: ICellRendererParams<InquiryRow>) =>
      data ? (
        <span className="fw-inq-cell">
          <Link
            className="fw-inq-link fw-inq-code"
            href={openHref(data)}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
              event.preventDefault()
              open(data)
            }}
          >
            {data.number}
          </Link>
          <span className="fw-inq-hint">{when(data.receivedAt)}</span>
        </span>
      ) : null
    const FromCell = ({ data }: ICellRendererParams<InquiryRow>) =>
      data ? (
        <span className="fw-inq-cell">
          <span>{data.party ? data.party.name : data.fromWords}</span>
          <span className="fw-inq-hint">{data.party ? data.party.code : t('who.prospectTag')}</span>
        </span>
      ) : null
    const SourceCell = ({ data }: ICellRendererParams<InquiryRow>) => (data ? <SourceTag source={data.source} /> : null)
    const StatusCell = ({ data }: ICellRendererParams<InquiryRow>) =>
      data ? (
        <span className="fw-inq-row">
          <StatusPill status={data.status} />
          {data.declineReason && <span className="fw-inq-hint">{t(`decline.${data.declineReason}`)}</span>}
          {data.quote && <span className="fw-inq-hint fw-inq-code">{data.quote.number}</span>}
        </span>
      ) : null
    const WaitingCell = ({ data }: ICellRendererParams<InquiryRow>) => (data ? <WaitingTag row={data} /> : null)
    const MoreCell = ({ data }: ICellRendererParams<InquiryRow>) => {
      if (!data) return null
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('row.menu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('row.open'), onSelect: () => open(data) },
            { id: 'tab', label: t('row.openNewTab'), href: recordHref(model.prefix, data.id), target: '_blank' },
            ...(isOpen(data.status)
              ? [
                  verbItem(data, 'quote', t('verb.quoteKey')),
                  verbItem(data, 'assign', t('verb.assignKey')),
                  verbItem(data, 'askInfo', t('verb.askInfo')),
                  { ...verbItem(data, 'decline', t('verb.declineKey')), tone: 'danger' as const },
                ]
              : []),
            { id: 'copy', label: t('row.copy'), onSelect: () => act.current?.onCopy?.([data.number]) },
          ]}
        />
      )
    }
    return [
      { colId: 'number', headerName: t('col.number'), minWidth: 150, flex: 0.7, valueGetter: (params) => params.data?.number ?? '', cellRenderer: NumberCell },
      { colId: 'from', headerName: t('col.from'), minWidth: 170, flex: 1, valueGetter: (params) => (params.data ? (params.data.party?.name ?? params.data.fromWords) : ''), cellRenderer: FromCell },
      { colId: 'summary', headerName: t('col.summary'), minWidth: 220, flex: 1.6, valueGetter: (params) => params.data?.summary ?? '' },
      { colId: 'source', headerName: t('col.source'), minWidth: 110, flex: 0.5, valueGetter: (params) => (params.data ? t(`source.${params.data.source}`) : ''), cellRenderer: SourceCell },
      { colId: 'products', headerName: t('col.products'), minWidth: 150, flex: 0.8, valueGetter: (params) => (params.data ? params.data.products.join(', ') || '—' : '') },
      { colId: 'sizes', headerName: t('col.sizes'), minWidth: 150, flex: 0.8, valueGetter: (params) => (params.data ? params.data.sizes || '—' : '') },
      { colId: 'pieces', headerName: t('col.pieces'), minWidth: 90, flex: 0.35, type: 'rightAligned', valueGetter: (params) => params.data?.pieces ?? null },
      ...(model.can.price
        ? [
            {
              colId: 'targetPrice',
              headerName: t('col.targetPrice'),
              minWidth: 110,
              flex: 0.5,
              type: 'rightAligned',
              valueGetter: (params: { data?: InquiryRow }) => {
                const price = params.data?.targetUnitPrice as string | null | undefined
                return params.data && price ? priceText(price, params.data.currency, INTL[locale]) : ''
              },
            } satisfies ColDef<InquiryRow>,
          ]
        : []),
      { colId: 'wantedDate', headerName: t('col.wantedDate'), minWidth: 110, flex: 0.5, valueGetter: (params) => (params.data ? day(params.data.wantedDate) : '') },
      { colId: 'waitingHours', headerName: t('col.waiting'), minWidth: 170, flex: 0.8, valueGetter: (params) => params.data?.waiting.workingMinutes ?? null, cellRenderer: WaitingCell },
      { colId: 'assignedTo', headerName: t('col.assignedTo'), minWidth: 110, flex: 0.5, valueGetter: (params) => (params.data ? (say(assigneePhrase(params.data)) ?? '') : '') },
      { colId: 'status', headerName: t('col.status'), minWidth: 150, flex: 0.7, valueGetter: (params) => (params.data ? t(`status.${params.data.status}`) : ''), cellRenderer: StatusCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    // The cells read the model through these values only.
  }, [t, say, day, when, locale, model.prefix, model.can, model.address, offline])

  if (!model.can.view) return <NoAccess />

  const filtered = isFiltered(model.address)
  const reach = bulkReach(rows ?? [], selected)
  const ownKeys: ListKey[] = [
    { keys: ['c'], does: t('keys.new') },
    { keys: ['q'], does: t('keys.quote') },
    { keys: ['a'], does: t('keys.assign') },
    { keys: ['d'], does: t('keys.decline') },
  ]
  const newButton = (
    <Button size="sm" variant="primary" heldReason={model.can.manage ? (offline ? t('held.offline') : null) : say({ key: 'held.right', params: { right: 'right.sales.inquiries.manage' } })} onClick={() => actions?.onNew?.()} aria-keyshortcuts="c">
      <Plus size={14} aria-hidden /> {t('list.new')}
    </Button>
  )
  const state: ReactNode = model.problem ? (
    <EmptyState
      title={t('list.failed')}
      description={t(model.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : rows !== null && rows.length === 0 ? (
    filtered ? (
      <EmptyState
        title={t('list.noMatch')}
        description={t('list.noMatchBody')}
        action={
          <Button size="sm" onClick={() => actions?.onClearFilters?.()}>
            {t('common.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState title={t('list.empty')} description={t('list.emptyBody')} action={model.can.manage ? newButton : undefined} />
    )
  ) : undefined

  const partyName = model.address.party ? (model.customers?.find((party) => party.id === model.address.party)?.tradeName ?? model.customers?.find((party) => party.id === model.address.party)?.legalName ?? rows?.find((row) => row.party?.id === model.address.party)?.party?.name ?? null) : null
  const chips = chipsOf(model.address, partyName)
  const notices = pageNotices(model.list, model.limit, new Set(model.dismissed))
  const fromValue = model.address.prospect ? 'prospect' : (model.address.party ?? '')

  const tools = (
    <>
      <Select size="sm" aria-label={t('list.rows')} value={model.address.tile} onChange={(event) => actions?.onAddress?.({ tile: event.target.value as InquiryTile })}>
        {SAVED_ROWS.map((tile) => (
          <option key={tile} value={tile}>
            {t(`tile.${tile}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" aria-label={t('list.sourceLabel')} value={model.address.source ?? ''} onChange={(event) => actions?.onAddress?.({ source: (event.target.value || null) as InquirySource | null })}>
        <option value="">{t('list.allSources')}</option>
        {INQUIRY_SOURCES.map((source) => (
          <option key={source} value={source}>
            {t(`source.${source}`)}
          </option>
        ))}
      </Select>
      <Select
        size="sm"
        aria-label={t('list.fromLabel')}
        value={fromValue}
        onChange={(event) => {
          const value = event.target.value
          actions?.onAddress?.(value === 'prospect' ? { prospect: true, party: null } : { prospect: false, party: value || null })
        }}
      >
        <option value="">{t('list.allFrom')}</option>
        <option value="prospect">{t('list.prospectsOnly')}</option>
        {(model.customers ?? []).map((party) => (
          <option key={party.id} value={party.id}>
            {party.code} · {party.tradeName ?? party.legalName}
          </option>
        ))}
      </Select>
    </>
  )

  const tile = (id: (typeof DESIGN_TILES)[number]) => ({
    label: t(`tile.${id}`),
    value: tileValue(model.list, id, !!model.problem),
    hint: model.problem ? t('tile.failed') : tilePartial(model.list, id) ? t('tile.partial') : t(`tile.hint.${id}`),
    onClick: () => actions?.onAddress?.({ tile: model.address.tile === id ? HOME_ADDRESS.tile : id }),
    active: model.address.tile === id,
  })

  return (
    <div className="fw-inq">
      <PageHead
        intro={t('list.intro')}
        status={<Freshness asOf={model.asOf} live={model.live} />}
        actions={
          <>
            <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('list.more') }} items={[{ id: 'rules', label: t('list.rulesLater'), disabled: true, description: t('list.rulesLaterHint') }]} />
            {newButton}
          </>
        }
      />
      <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {notices.length > 0 && (
        <div className="fw-inq-notices" aria-label={t('notice.label')}>
          {(noticesOpen ? notices : notices.slice(0, 1)).map((notice) => (
            <NoticeLine key={noticeKey(notice)} notice={notice} onDismiss={() => actions?.onDismissPageNotice?.(noticeKey(notice))} />
          ))}
          {notices.length > 1 && (
            <Button size="sm" variant="quiet" aria-expanded={noticesOpen} onClick={() => setNoticesOpen((now) => !now)}>
              {noticesOpen ? t('notice.fewer') : t('notice.more', { count: notices.length - 1 })}
            </Button>
          )}
        </div>
      )}
      <MetricStrip metrics={DESIGN_TILES.map(tile)} />
      {chips.length > 0 && (
        <div className="fw-inq-chips" aria-label={t('chip.label')}>
          {chips.map((chip) => (
            <FilterChip key={chip.id} pressed onClick={() => actions?.onAddress?.(chip.clear)} aria-label={t('chip.clear', { what: say(chip.label) ?? '' })}>
              {say(chip.label)} <X size={12} aria-hidden />
            </FilterChip>
          ))}
          <Button size="sm" variant="quiet" onClick={() => actions?.onClearFilters?.()}>
            {t('chip.clearAll')}
          </Button>
        </div>
      )}
      <ListFrame<InquiryRow>
        label={t('list.tableLabel')}
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={model.list ? (rows !== null && rows.length >= model.limit ? t('list.countCapped', { count: rows.length }) : t('list.count', { count: rows?.length ?? 0 })) : t('list.countReading')}
        search={
          <Input
            size="sm"
            type="search"
            className="fw-inq-search"
            aria-label={t('list.search')}
            placeholder={t('list.search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') actions?.onAddress?.({ q: search })
            }}
            onBlur={() => search !== model.address.q && actions?.onAddress?.({ q: search })}
          />
        }
        tools={tools}
        selection={{
          selected,
          onChange: setSelected,
          exportSelected: true,
          actions: (
            <>
              <span className="fw-inq-hint">{reach.closed > 0 ? t('bulk.reachClosed', { open: reach.open.length, closed: reach.closed }) : t('bulk.reach', { count: reach.open.length })}</span>
              <Button size="sm" heldReason={!model.can.manage ? say({ key: 'held.right', params: { right: 'right.sales.inquiries.manage' } }) : (say(reach.held) ?? (offline ? t('held.offline') : null))} aria-label={t('bulk.assign', { count: reach.open.length })} onClick={() => actions?.onBulk?.('assign', reach.open.map((row) => row.id))}>
                <UserRound size={13} aria-hidden /> <SelectionLabel>{t('bulk.assign', { count: reach.open.length })}</SelectionLabel>
              </Button>
              <Button size="sm" variant="danger-outline" heldReason={!model.can.manage ? say({ key: 'held.right', params: { right: 'right.sales.inquiries.manage' } }) : (say(reach.held) ?? (offline ? t('held.offline') : null))} aria-label={t('bulk.decline', { count: reach.open.length })} onClick={() => actions?.onBulk?.('decline', reach.open.map((row) => row.id))}>
                <XCircle size={13} aria-hidden /> <SelectionLabel>{t('bulk.decline', { count: reach.open.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        keys={ownKeys}
        keysOpen={model.keysOpen}
        onOpen={(row) => open(row)}
        state={state}
        title={t('list.tableLabel')}
        withheld={model.can.price ? [] : [{ label: t('col.targetPrice'), reason: t('list.withheldPrice') }]}
        cards={{ hrefOf: (row) => recordHref(model.prefix, row.id) }}
      />
      <p className="fw-inq-hint">{t('list.foot')}</p>
      {model.newInquiry && <NewInquiryDialog model={model.newInquiry} me={model.me} can={model.can} prefix={model.prefix} actions={actions?.newInquiry} />}
      {model.bulk?.kind === 'assign' && <AssignDialog model={model.bulk.model} actions={{ onAssign: actions?.bulk?.onAssign, onRetry: actions?.bulk?.onRetryPeople, onClose: actions?.bulk?.onClose }} />}
      {model.bulk?.kind === 'decline' && <DeclineDialog model={model.bulk.model} actions={{ onDraft: actions?.bulk?.onDecline, onSubmit: actions?.bulk?.onSubmit, onClose: actions?.bulk?.onClose }} />}
      {model.detail && <InquiryDetail model={model.detail} actions={actions?.record} slots={slots} nav={{ ids: (rows ?? []).map((row) => row.id), onGo: (id) => actions?.onOpen?.(id) }} onClose={() => actions?.onOpen?.(null)} />}
    </div>
  )
}
