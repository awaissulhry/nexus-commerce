'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { BadgeCheck, Download, MoreHorizontal, Plus, Search, X } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { isPageKey } from '../../../quality/_shared/hooks'
import { dash, Freshness, NoAccess, NoticeBanner, PageHead } from '../../../quality/_shared/parts'
import { REGISTER_MAX, type Certificate, type StyleOption } from '../api'
import { CERT_TILES, CERT_VIEWS, CERTIFICATE_KINDS, filterRows, holderOf, isFiltered, kindOf, NO_FILTERS, noticesOf, tileCounts, type CertFilters, type CertificateDraft, type CertificatesListModel, type CheckModel, type DraftField, type ListDialog } from '../model'
import { AddCertificateDialog, CheckGarmentDialog } from './dialogs'
import { CertMessages, GateExplainer, LeftTag, ShortcutsDialog, StatusPill, useDay, useListWords } from './parts'

export interface CertificatesListActions {
  onFilters?: (filters: CertFilters) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onSelect?: (ids: readonly string[]) => void
  onOpen?: (certificate: Certificate) => void
  onDialog?: (dialog: ListDialog | null) => void
  onExplainer?: (open: boolean) => void
  onExport?: (certificates: readonly Certificate[]) => void
  onCopy?: (text: string) => void
  onDismissNotice?: () => void
  // Add certificate
  onAddDraft?: (draft: CertificateDraft) => void
  onAddTouch?: (field: DraftField) => void
  onAddFile?: (file: File) => void
  onCreate?: () => void
  // Check a garment
  onCheckQuery?: (query: string) => void
  onCheckStyle?: (style: StyleOption) => void
  onCheckClearStyle?: () => void
  onCheckPatch?: (patch: Partial<Pick<CheckModel, 'colourwayId' | 'size' | 'date'>>) => void
  onCheckRun?: () => void
}

/** A certificate's record address (a tab when asked). */
export const certificateHref = (prefix: string, certificateId: string, query = ''): string => `${prefix}/compliance/certificates/${encodeURIComponent(certificateId)}${query ? `?${query}` : ''}`

/**
 * SCR-050 Certificates (design compliance.certificates W1: ce-explainer, ce-metrics, ce-notice, ce-grid): how the gate
 * works (collapsible), the saved-filter tiles (a tile IS a view), the most serious notice, and the register on the ONE
 * list frame (Owner rule 2026-10-29): count, search, Rows ▾, Kind and the chips — swapped for Export N while rows are
 * selected — the header select-all box, shift-click ranges, the footer with the keys icon. No bulk edit of legal fields:
 * a certificate changes on its record. Add certificate (`c`) and Check a garment (`k`) are dialogs. Fetches nothing.
 */
export function CertificatesListView({ model, actions }: { model: CertificatesListModel; actions?: CertificatesListActions }) {
  return (
    <CertMessages>
      <CertificatesList model={model} actions={actions} />
    </CertMessages>
  )
}

function CertificatesList({ model, actions }: { model: CertificatesListModel; actions?: CertificatesListActions }) {
  const t = useT('certificates')
  const q = useT('quality')
  const day = useDay()
  const lists = useListWords()
  const can = model.can
  const dialog = model.dialog
  const all = useMemo(() => model.rows.value ?? [], [model.rows.value])
  const waiting = useMemo(() => model.waiting?.value ?? {}, [model.waiting?.value])
  const rows = useMemo(() => filterRows(all, model.filters, waiting), [all, model.filters, waiting])
  const selectedRows = rows.filter((row) => model.selected.includes(row.id))
  const [query, setQuery] = useState(model.filters.q)
  useEffect(() => setQuery(model.filters.q), [model.filters.q])
  const typed = useRef(false)
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current.actions?.onFilters?.({ ...latest.current.model.filters, q: query }), 250)
    return () => clearTimeout(timer)
  }, [query])
  const [noticesOpen, setNoticesOpen] = useState(!!model.noticesOpen)
  const addHeld = can.manage ? null : t('held.manage')
  const checkHeld = can.styles ? null : t('check.held.styles')

  // c: Add certificate, k: Check a garment (g stays for the global go-to chords). The frame keeps / j k x ↵ ?.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (dialog || model.add || model.check || !isPageKey(event)) return
      if (event.key === 'c' && can.manage) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'add' })
      } else if (event.key === 'k' && can.view) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'check' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, can.manage, can.view, dialog, model.add, model.check])

  const live = useRef({ actions })
  live.current = { actions }
  const columns = useMemo<ColDef<Certificate>[]>(() => {
    const NumberCell = ({ data }: ICellRendererParams<Certificate>) =>
      data ? (
        <span className="fw-q-cell">
          <Link className="fw-q-name fw-q-code" href={certificateHref(model.prefix, data.id)} tabIndex={-1}>
            {data.number}
          </Link>
          <span className="fw-q-hint">{data.modelReference ?? '—'}</span>
        </span>
      ) : null
    const StandardCell = ({ data }: ICellRendererParams<Certificate>) =>
      data ? (
        <span className="fw-q-cell">
          <span>{data.standard}</span>
          <span className="fw-q-hint">{[t(`kind.${kindOf(data.standard)}`), data.ppeClass ? t(kindOf(data.standard) === 'PROTECTOR' ? 'list.level' : 'list.class', { class: data.ppeClass }) : null].filter(Boolean).join(' · ')}</span>
        </span>
      ) : null
    const HolderCell = ({ data }: ICellRendererParams<Certificate>) => {
      if (!data) return null
      const holder = holderOf(data, model.companies, model.brands)
      return (
        <span className="fw-q-cell">
          <span>{dash(holder.name)}</span>
          <span className="fw-q-hint">{t(`holder.${holder.kind}`)}</span>
        </span>
      )
    }
    const BodyCell = ({ data }: ICellRendererParams<Certificate>) =>
      data ? (
        <span className="fw-q-cell">
          <span className="fw-q-num">{data.notifiedBodyNumber}</span>
          <span className="fw-q-hint">{data.notifiedBodyName}</span>
        </span>
      ) : null
    const ValidCell = ({ data }: ICellRendererParams<Certificate>) =>
      data ? (
        <span className="fw-q-cell">
          <span className="fw-q-num">{t('list.validRange', { from: day(data.validFrom), to: day(data.validTo) })}</span>
          <LeftTag certificate={data} today={model.today} />
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<Certificate>) => (data ? <StatusPill status={data.status} /> : null)
    // W2a (B-W2a-66): a change to the approved type waiting for the notified body (the reviews of the Renewals tab).
    const ChangesCell = ({ data }: ICellRendererParams<Certificate>) => {
      if (!data) return null
      const count = model.waiting?.value ? (model.waiting.value[data.id] ?? 0) : null
      if (count === null || count === 0) return <span className="fw-q-hint">{count === null ? '—' : t('list.changesNone')}</span>
      return (
        <Link className="fw-q-link" href={certificateHref(model.prefix, data.id, 'tab=renewals')} tabIndex={-1}>
          <Tag tone="warning">{t('list.changesWaiting', { count })}</Tag>
        </Link>
      )
    }
    const ActionsCell = ({ data }: ICellRendererParams<Certificate>) =>
      data ? <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.menu', { number: data.number }) }} items={rowItems(data)} /> : null
    const rowItems = (certificate: Certificate): MenuItemDef[] => {
      const href = certificateHref(model.prefix, certificate.id)
      return [
        { id: 'open', label: t('row.open'), href },
        { id: 'tab', label: t('row.openNewTab'), href, target: '_blank' },
        { id: 'coverage', label: t('row.coverage'), href: certificateHref(model.prefix, certificate.id, 'tab=coverage') },
        { id: 'check', label: t('row.check'), href: certificateHref(model.prefix, certificate.id, 'tab=coverage&act=check') },
        // W2a (B-W2a-66): Start renewal opens the Renewals tab with its dialog.
        {
          id: 'renew',
          label: t('row.renew'),
          href: certificateHref(model.prefix, certificate.id, 'tab=renewals&act=renew'),
          ...(!model.can.manage ? { disabled: true, description: t('held.manage') } : certificate.status !== 'VALID' && certificate.status !== 'SUSPENDED' ? { disabled: true, description: t('ren.held.notRenewable') } : {}),
        },
        { id: 'copy', label: t('row.copy'), onSelect: () => live.current.actions?.onCopy?.(certificate.number) },
      ]
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<Certificate>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number }): ColDef<Certificate> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      column('number', t('list.col.number'), NumberCell, { flex: 1.4, minWidth: 180 }),
      column('standard', t('list.col.standard'), StandardCell, { flex: 1.5, minWidth: 190 }),
      column('holder', t('list.col.holder'), HolderCell, { flex: 1.3, minWidth: 160 }),
      column('body', t('list.col.body'), BodyCell, { flex: 1.3, minWidth: 160 }),
      { colId: 'covers', headerName: t('list.col.covers'), sortable: false, flex: 1, minWidth: 150, valueGetter: (params) => (params.data ? t('list.covers', { count: params.data.coverageCount }) : '') },
      column('valid', t('list.col.valid'), ValidCell, { flex: 1.6, minWidth: 210 }),
      column('status', t('list.col.status'), StatusCell, { flex: 0.9, minWidth: 120 }),
      column('changes', t('list.col.changes'), ChangesCell, { flex: 1, minWidth: 150 }),
      { ...column('actions', t('list.col.actions'), ActionsCell, { width: 72, minWidth: 72 }), suppressHeaderMenuButton: true },
    ]
    // The cells close over the words, the people's names and today: a change of these rebuilds them.
  }, [t, day, model.prefix, model.companies, model.brands, model.today, model.waiting, model.can.manage])

  if (!can.view) return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />

  const filtered = isFiltered(model.filters)
  const counts = model.rows.value ? tileCounts(model.rows.value) : null
  const notices = model.rows.value ? noticesOf(model.rows.value) : []
  const setFilters = (patch: Partial<CertFilters>) => actions?.onFilters?.({ ...model.filters, ...patch })

  const tile = (id: (typeof CERT_TILES)[number]) => {
    const active = model.filters.view === id
    return {
      label: t(`tile.${id}`),
      value: model.rows.problem ? '—' : counts ? String(counts[id]) : <Skeleton width={36} height={22} />,
      hint: model.rows.problem ? t('tile.unknown') : id === 'expiring' && counts ? t('tile.expiringHint', { within90: counts.within90, within30: counts.within30 }) : t(`tileHint.${id}`),
      active,
      onClick: () => setFilters({ view: active ? 'all' : id }),
    }
  }

  const viewItems: MenuItemDef[] = [{ id: 'heading', heading: true, label: t('list.rowsHeading') }, ...CERT_VIEWS.map((view) => ({ id: view, label: t(`view.${view}`), checked: model.filters.view === view, onSelect: () => setFilters({ view }) }))]
  const moreItems: MenuItemDef[] = [
    { id: 'export', label: t('list.exportView'), onSelect: () => actions?.onExport?.(rows), disabled: rows.length === 0, description: rows.length === 0 ? t('list.exportNothing') : t('list.exportViewHint', { count: rows.length }) },
    { id: 'check', label: t('check.open'), onSelect: () => actions?.onDialog?.({ kind: 'check' }) },
    { id: 'sep', separator: true },
    { id: 'keys', label: t('keys.title'), onSelect: () => actions?.onDialog?.({ kind: 'shortcuts' }) },
  ]
  const chip = (key: string, label: string, onRemove: () => void) => (
    <FilterChip key={key} pressed onClick={onRemove} aria-label={t('list.removeFilter', { name: label })}>
      {label} <X size={12} aria-hidden />
    </FilterChip>
  )
  const tools = (
    <>
      <Menu label={t('list.rows', { view: t(`view.${model.filters.view}`) })} items={viewItems} />
      <Select size="sm" aria-label={t('list.kindFilter')} value={model.filters.kind} onChange={(event) => setFilters({ kind: event.target.value as CertFilters['kind'] })}>
        <option value="all">{t('list.allKinds')}</option>
        {CERTIFICATE_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {t(`kind.${kind}`)}
          </option>
        ))}
      </Select>
      {filtered && (
        <span className="fw-q-chips" aria-label={t('list.activeFilters')}>
          {model.filters.view !== 'all' && chip('view', t(`view.${model.filters.view}`), () => setFilters({ view: 'all' }))}
          {model.filters.kind !== 'all' && chip('kind', t(`kind.${model.filters.kind}`), () => setFilters({ kind: 'all' }))}
          {model.filters.q.trim() !== '' && chip('q', `“${model.filters.q.trim()}”`, () => setFilters({ q: '' }))}
          <Button size="sm" variant="quiet" onClick={() => actions?.onFilters?.(NO_FILTERS)}>
            {t('list.clearAll')}
          </Button>
        </span>
      )}
    </>
  )

  const bulkActions = (
    <Button size="sm" onClick={() => actions?.onExport?.(selectedRows)} aria-label={t('list.bulkExport', { count: selectedRows.length })}>
      <Download size={13} aria-hidden /> <SelectionLabel>{t('list.bulkExport', { count: selectedRows.length })}</SelectionLabel>
    </Button>
  )

  const state = model.rows.problem ? (
    <EmptyState
      title={t('list.failedTitle')}
      description={q(model.rows.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {q('common.retry')}
        </Button>
      }
    />
  ) : model.rows.value !== null && rows.length === 0 ? (
    filtered && all.length > 0 ? (
      <EmptyState
        title={t('list.noMatch')}
        action={
          <Button size="sm" onClick={() => actions?.onFilters?.(NO_FILTERS)}>
            {t('list.clearAll')}
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={<BadgeCheck size={24} aria-hidden />}
        title={t('list.empty.title')}
        description={t(can.manage ? 'list.empty.body' : 'list.empty.bodyView')}
        action={
          can.manage ? (
            <Button variant="primary" onClick={() => actions?.onDialog?.({ kind: 'add' })}>
              {t('list.emptyAdd')}
            </Button>
          ) : undefined
        }
      />
    )
  ) : undefined

  const ownKeys: ListKey[] = [
    { keys: ['c'], does: t('keys.add') },
    { keys: ['k'], does: t('keys.check') },
  ]
  const capped = (model.rows.value?.length ?? 0) >= REGISTER_MAX
  const notice = notices[0] ?? null

  return (
    <div className="fw-q fw-ce">
      <PageHead
        intro={t('list.intro')}
        status={<Freshness asOf={model.asOf} live={model.live} />}
        actions={
          <>
            <Button size="sm" onClick={() => actions?.onDialog?.({ kind: 'check' })} heldReason={checkHeld} aria-keyshortcuts="k">
              {t('check.open')}
            </Button>
            <Button size="sm" variant="primary" onClick={() => actions?.onDialog?.({ kind: 'add' })} heldReason={addHeld} aria-keyshortcuts="c">
              <Plus size={14} aria-hidden /> {t('list.add')}
            </Button>
          </>
        }
      />
      <GateExplainer open={!!model.explainerOpen} onToggle={actions?.onExplainer} onCheck={() => actions?.onDialog?.({ kind: 'check' })} checkHeld={can.styles ? null : 'check.held.styles'} />
      <NoticeBanner notice={model.notice} namespace="certificates" onDismiss={actions?.onDismissNotice} />
      {notice && (
        <Banner
          tone={notice.tone}
          title={t(notice.key, notice.params)}
          action={
            <span className="fw-q-actions">
              <Button size="sm" asChild>
                <Link href={certificateHref(model.prefix, notice.certificateId)}>{t('notice.open')}</Link>
              </Button>
              {notices.length > 1 && (
                <Button size="sm" variant="quiet" aria-expanded={noticesOpen} onClick={() => setNoticesOpen((open) => !open)}>
                  {t(noticesOpen ? 'notice.fewer' : 'notice.more', { count: notices.length - 1 })}
                </Button>
              )}
            </span>
          }
        >
          {notice.detail && <p className="fw-q-hint fw-ce-data">{notice.detail.join(' ')}</p>}
          {noticesOpen && notices.length > 1 && (
            <ul className="fw-q-lines">
              {notices.slice(1).map((entry) => (
                <li key={`${entry.key}-${entry.certificateId}`}>
                  <Link className="fw-q-link" href={certificateHref(model.prefix, entry.certificateId)}>
                    {t(entry.key, entry.params)}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Banner>
      )}
      <MetricStrip metrics={CERT_TILES.map(tile)} />

      <ListFrame<Certificate>
        label={t('list.table')}
        rows={model.rows.problem ? [] : model.rows.value === null ? null : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={model.rows.value ? t(filtered ? 'list.countOf' : 'list.count', { count: rows.length, total: all.length }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={14} aria-hidden />}
            aria-label={t('list.search')}
            placeholder={t('list.search')}
            value={query}
            onChange={(event) => {
              typed.current = true
              setQuery(event.target.value)
            }}
          />
        }
        tools={tools}
        right={<Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('list.more') }} items={moreItems} />}
        selection={{ selected: model.selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulkActions }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={capped ? { label: t('list.moreCapped'), onMore: () => undefined, held: t('held.registerMax', { max: REGISTER_MAX }) } : null}
        keys={ownKeys}
        onHelp={() => actions?.onDialog?.({ kind: 'shortcuts' })}
        onOpen={(row) => actions?.onOpen?.(row)}
        state={state}
        focusRow={model.focusRow}
      />

      {model.add && <AddCertificateDialog model={model.add} can={can} companies={model.companies} brands={model.brands} actions={{ onDraft: actions?.onAddDraft, onTouch: actions?.onAddTouch, onFile: actions?.onAddFile, onCreate: actions?.onCreate, onClose: () => actions?.onDialog?.(null) }} />}
      {model.check && (
        <CheckGarmentDialog
          model={model.check}
          can={can}
          today={model.today ?? model.check.date}
          actions={{ onQuery: actions?.onCheckQuery, onPickStyle: actions?.onCheckStyle, onClearStyle: actions?.onCheckClearStyle, onCheck: actions?.onCheckPatch, onRun: actions?.onCheckRun, onClose: () => actions?.onDialog?.(null) }}
        />
      )}
      <ShortcutsDialog open={dialog?.kind === 'shortcuts'} onClose={() => actions?.onDialog?.(null)} keys={listKeys(ownKeys, true).map((entry) => ({ keys: entry.keys, does: lists(entry.does) }))} />
    </div>
  )
}
