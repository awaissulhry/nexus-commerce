'use client'

import { useEffect, useMemo, useRef } from 'react'
import Link from 'next/link'
import { Bell, Download, FileText, MoreHorizontal, Search, Send, X } from 'lucide-react'
import { EmptyState, Field, Menu, MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Select } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { isPageKey } from '../../../../quality/_shared/hooks'
import { Freshness, NoAccess, NoticeBanner, PageHead } from '../../../../quality/_shared/parts'
import { DECLARATION_KINDS } from '@nexus/factory-domain/compliance/substances/rules'
import { SHOWN_STATUSES } from '@nexus/factory-domain/compliance/declarations-asked/rules'
import { DEPTH_NAMESPACE, DepthMessages } from '../../substances/frame/parts'
import { ShortcutsDialog, useListWords } from '../../view/parts'
import type { DeclarationRequest } from '../api'
import { askAgainHeld, bulkRemindable, cancelHeld, cancelReasonProblem, materialsLine, previewHeld, remindHeld, type DeclarationsAddress, type Held } from '../model'
import type { DeclarationsViewModel } from '../view-model'
import { AskDialog, type AskActions } from './AskDialog'
import { DueWords, KindWords, ShownPill } from './parts'
import { RecordModal, type RecordActions } from './RecordModal'

export interface DeclarationsActions extends RecordActions, AskActions {
  onAddress?: (change: Partial<DeclarationsAddress>) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onSelect?: (ids: readonly string[]) => void
  onExport?: (rows: readonly DeclarationRequest[]) => void
  onCancelConfirm?: () => void
  onAskAgainConfirm?: () => void
  onCopy?: (text: string) => void
  onDismissNotice?: () => void
}

/**
 * Supplier declarations (B-W2b-267, SCR-054-declarations; design compliance.tests sec:ts-decl): the page's frame (tiles,
 * the view switch), then the requests on the ONE list frame — Request, Supplier, Material or trim, Type (with the Candidate
 * List day), Requested, Due (Countdown, or days late), Reminders sent, Status, Valid to, File, ⋯ (Open, Remind, Accept,
 * Reject, Re-request, Cancel, See it as the supplier) — with Remind N and CSV N while rows are selected. A row opens the
 * Supplier declaration (DetailModal, J / K walk the rows); Request declarations is `c`. Fetches nothing.
 */
export function DeclarationsView({ model, actions }: { model: DeclarationsViewModel; actions?: DeclarationsActions }) {
  return (
    <DepthMessages>
      <Declarations model={model} actions={actions} />
    </DepthMessages>
  )
}

const held = (t: (key: string, params?: Record<string, string | number>) => string, reason: Held | null): string | null => (reason ? t(reason.key, reason.params as Record<string, string | number> | undefined) : null)

function Declarations({ model, actions }: { model: DeclarationsViewModel; actions?: DeclarationsActions }) {
  const t = useT(DEPTH_NAMESPACE)
  const q = useT('quality')
  const lists = useListWords()
  const locale = useLocale()
  const can = model.can
  const rows = useMemo(() => model.list.value?.requests ?? [], [model.list.value])
  const selectedRows = rows.filter((row) => model.selected.includes(row.id))
  const remindable = selectedRows.filter(bulkRemindable)
  const askHeld = !can.manage ? t('held.manage') : !model.online ? t('held.offline') : null

  // c: Request declarations (the frame's keys are / j k x ↵ ?; the same rule skips fields, menus and dialogs).
  const busy = !!model.record || !!model.ask || !!model.dialog
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'c' || busy || askHeld || !isPageKey(event)) return
      event.preventDefault()
      actions?.onAskOpen?.([], [])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, busy, askHeld])

  const live = useRef({ actions, model })
  live.current = { actions, model }
  const columns = useMemo<ColDef<DeclarationRequest>[]>(() => {
    const words = (reason: Held | null) => held(t, reason)
    const NumberCell = ({ data }: ICellRendererParams<DeclarationRequest>) =>
      data ? (
        <span className="fw-q-cell">
          <Link className="fw-q-name fw-q-code" href={`${live.current.model.prefix}/compliance/tests?view=declarations&open=${encodeURIComponent(data.id)}`} tabIndex={-1} onClick={(event) => { event.preventDefault(); live.current.actions?.onOpen?.(data.id) }}>
            {data.number}
          </Link>
          <span className="fw-q-hint">{t(`channel.${data.channel}`)}</span>
        </span>
      ) : null
    const SupplierCell = ({ data }: ICellRendererParams<DeclarationRequest>) =>
      data ? (
        <span className="fw-q-cell">
          <span className="fw-q-code">{data.party.code}</span>
          <span className="fw-q-hint">{data.party.name}</span>
        </span>
      ) : null
    const MaterialCell = ({ data }: ICellRendererParams<DeclarationRequest>) => (data ? <span title={data.materials.map((material) => material.articleLabel).join('\n')}>{materialsLine(data, (count) => t('decl.more', { count }))}</span> : null)
    const KindCell = ({ data }: ICellRendererParams<DeclarationRequest>) => (data ? <KindWords request={data} /> : null)
    const DueCell = ({ data }: ICellRendererParams<DeclarationRequest>) => (data ? <DueWords request={data} /> : null)
    const StatusCell = ({ data }: ICellRendererParams<DeclarationRequest>) =>
      data ? (
        <span className="fw-q-cell">
          <ShownPill shown={data.shown} />
          {data.status === 'ANSWERED' && data.answeredLines < data.lines && <span className="fw-q-hint">{t('decl.linesOpen', { count: data.lines - data.answeredLines })}</span>}
          {data.reminderDue && <span className="fw-q-hint">{t('decl.reminderDue')}</span>}
        </span>
      ) : null
    const FileCell = ({ data }: ICellRendererParams<DeclarationRequest>) =>
      data ? (
        data.file?.fileId ? (
          <Button size="sm" variant="quiet" onClick={() => live.current.actions?.onOpen?.(data.id, 'answer')} aria-label={t('decl.fileOpen', { number: data.number })}>
            <FileText size={14} aria-hidden /> {t(data.file.source === 'UPLOAD' ? 'decl.fileUpload' : 'decl.fileOffice')}
          </Button>
        ) : (
          <span className="fw-q-hint">{t('decl.noFile')}</span>
        )
      ) : null
    const ActionsCell = ({ data }: ICellRendererParams<DeclarationRequest>) => (data ? <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.menu', { number: data.number }) }} items={rowItems(data)} /> : null)
    const rowItems = (row: DeclarationRequest): MenuItemDef[] => {
      const { model: now, actions: act } = live.current
      const verb = (id: string, label: string, reason: Held | null, onSelect: () => void): MenuItemDef => (reason ? { id, label, disabled: true, description: words(reason) ?? undefined } : { id, label, onSelect })
      return [
        { id: 'open', label: t('row.open'), onSelect: () => act?.onOpen?.(row.id) },
        verb('remind', t('row.remind'), remindHeld(row, now.can, now.online), () => act?.onRemind?.([row.id])),
        { id: 'decide', label: t('row.decide'), onSelect: () => act?.onOpen?.(row.id, 'decision') },
        verb('askAgain', t('row.askAgain'), askAgainHeld(row, now.can, now.online), () => act?.onDialog?.({ kind: 'askAgain', id: row.id, dueOn: '', reminderEveryDays: row.reminderEveryDays === null ? '' : String(row.reminderEveryDays), message: '' })),
        verb('cancel', t('row.cancel'), cancelHeld(row, now.can, now.online), () => act?.onDialog?.({ kind: 'cancel', id: row.id, reason: '' })),
        { id: 'sep', separator: true },
        verb('preview', t('row.preview'), previewHeld(row, now.can), () => act?.onPreview?.(row)),
        { id: 'copy', label: t('row.copy'), onSelect: () => act?.onCopy?.(row.number) },
      ]
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<DeclarationRequest>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number }): ColDef<DeclarationRequest> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      column('number', t('decl.col.number'), NumberCell, { flex: 1, minWidth: 125 }),
      column('supplier', t('decl.col.supplier'), SupplierCell, { flex: 1.3, minWidth: 140 }),
      column('materials', t('decl.col.materials'), MaterialCell, { flex: 2, minWidth: 170 }),
      column('kind', t('decl.col.kind'), KindCell, { flex: 1.2, minWidth: 130 }),
      { colId: 'sentAt', headerName: t('decl.col.requested'), sortable: false, flex: 0.8, minWidth: 100, valueGetter: (params) => (params.data ? formatDate(params.data.sentAt, { locale }) : '') },
      column('due', t('decl.col.due'), DueCell, { flex: 1, minWidth: 120 }),
      { colId: 'reminders', headerName: t('decl.col.reminders'), sortable: false, flex: 0.5, minWidth: 80, valueGetter: (params) => (params.data ? String(params.data.remindersSent) : '') },
      column('status', t('decl.col.status'), StatusCell, { flex: 1.3, minWidth: 140 }),
      { colId: 'validTo', headerName: t('decl.col.validTo'), sortable: false, flex: 0.8, minWidth: 100, valueGetter: (params) => (params.data?.validTo ? formatDate(params.data.validTo, { locale }) : '—') },
      column('file', t('decl.col.file'), FileCell, { flex: 0.9, minWidth: 100 }),
      { ...column('actions', t('decl.col.actions'), ActionsCell, { width: 72, minWidth: 72 }), suppressHeaderMenuButton: true },
    ]
  }, [t, locale])

  if (!can.view) return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />

  const address = model.address
  const filtered = address.shown !== null || address.kind !== null || address.q.trim() !== ''
  const choose = (change: Partial<DeclarationsAddress>) => actions?.onAddress?.(change)
  const statusItems: MenuItemDef[] = [
    { id: 'heading', heading: true, label: t('decl.statusHeading') },
    { id: 'all', label: t('decl.allStatuses'), checked: address.shown === null, onSelect: () => choose({ shown: null }) },
    ...SHOWN_STATUSES.map((shown) => ({ id: shown, label: t(`shown.${shown}`), checked: address.shown === shown, onSelect: () => choose({ shown }) })),
  ]
  const kindItems: MenuItemDef[] = [
    { id: 'heading', heading: true, label: t('decl.kindHeading') },
    { id: 'all', label: t('decl.allKinds'), checked: address.kind === null, onSelect: () => choose({ kind: null }) },
    ...DECLARATION_KINDS.map((kind) => ({ id: kind, label: t(`kind.${kind}`), checked: address.kind === kind, onSelect: () => choose({ kind }) })),
  ]
  const chip = (key: string, label: string, onRemove: () => void) => (
    <FilterChip key={key} pressed onClick={onRemove} aria-label={t('list.removeFilter', { name: label })}>
      {label} <X size={12} aria-hidden />
    </FilterChip>
  )
  const tools = (
    <>
      <Menu label={t('decl.statusMenu', { status: address.shown ? t(`shown.${address.shown}`) : t('decl.allStatuses') })} items={statusItems} />
      <Menu label={t('decl.kindMenu', { kind: address.kind ? t(`kind.${address.kind}`) : t('decl.allKinds') })} items={kindItems} />
      {filtered && (
        <span className="fw-q-chips" aria-label={t('list.activeFilters')}>
          {address.shown && chip('shown', t(`shown.${address.shown}`), () => choose({ shown: null }))}
          {address.kind && chip('kind', t(`kind.${address.kind}`), () => choose({ kind: null }))}
          {address.q.trim() !== '' && chip('q', `“${address.q.trim()}”`, () => choose({ q: '' }))}
          <Button size="sm" variant="quiet" onClick={() => choose({ shown: null, kind: null, q: '' })}>
            {t('list.clearAll')}
          </Button>
        </span>
      )}
    </>
  )
  const moreItems: MenuItemDef[] = [
    { id: 'export', label: t('list.exportView'), onSelect: () => actions?.onExport?.(rows), disabled: rows.length === 0, description: rows.length === 0 ? t('list.exportNothing') : t('list.exportViewHint', { count: rows.length }) },
    { id: 'sep', separator: true },
    { id: 'keys', label: t('keys.title'), onSelect: () => actions?.onDialog?.({ kind: 'keys' }) },
  ]
  const remindReason = !can.manage ? t('held.manage') : !model.online ? t('held.offline') : remindable.length === 0 ? t('held.remindNoneWaiting') : null
  const bulkActions = (
    <>
      <Button size="sm" heldReason={remindReason} onClick={() => actions?.onRemind?.(remindable.map((row) => row.id))} aria-label={t('bulk.remind', { count: remindable.length, total: selectedRows.length })}>
        <Bell size={13} aria-hidden /> <SelectionLabel>{t('bulk.remind', { count: remindable.length, total: selectedRows.length })}</SelectionLabel>
      </Button>
      <Button size="sm" onClick={() => actions?.onExport?.(selectedRows)} aria-label={t('bulk.export', { count: selectedRows.length })}>
        <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: selectedRows.length })}</SelectionLabel>
      </Button>
    </>
  )
  const state = model.list.problem ? (
    <EmptyState title={t('list.failedTitle')} description={q(model.list.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{q('common.retry')}</Button>} />
  ) : model.list.value !== null && rows.length === 0 ? (
    filtered ? (
      <EmptyState title={t('list.noMatch')} action={<Button size="sm" onClick={() => choose({ shown: null, kind: null, q: '' })}>{t('list.clearAll')}</Button>} />
    ) : (
      <EmptyState
        icon={<Send size={24} aria-hidden />}
        title={t('decl.empty.title')}
        description={t('decl.empty.body')}
        action={<Button variant="primary" heldReason={askHeld} onClick={() => actions?.onAskOpen?.([], [])}>{t('ask.open')}</Button>}
      />
    )
  ) : undefined
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('keys.ask') }, { keys: ['1', '2', '3', '4'], does: t('keys.views') }]
  const rowIds = rows.map((row) => row.id)

  return (
    <div className="fw-q fw-mt">
      <PageHead
        intro={t('decl.intro')}
        status={<Freshness asOf={model.asOf} live={model.live} />}
        actions={
          <Button size="sm" variant="primary" heldReason={askHeld} onClick={() => actions?.onAskOpen?.([], [])}>
            {t('ask.open')}
          </Button>
        }
      />
      <NoticeBanner notice={model.notice} namespace={DEPTH_NAMESPACE} onDismiss={actions?.onDismissNotice} />
      {model.frame.tiles.length > 0 && <MetricStrip metrics={[...model.frame.tiles]} />}
      {model.frame.switcher}
      <ListFrame<DeclarationRequest>
        label={t('decl.table')}
        listKey="compliance.tests.declarations"
        rows={model.list.problem ? [] : model.list.value ? rows : null}
        rowId={(row) => row.id}
        columns={columns}
        count={t('decl.count', { count: rows.length })}
        search={<Input size="sm" type="search" leadingIcon={<Search size={14} aria-hidden />} aria-label={t('decl.search')} placeholder={t('decl.search')} value={address.q} onChange={(event) => choose({ q: event.target.value })} />}
        tools={tools}
        right={<Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('list.more') }} items={moreItems} />}
        selection={{ selected: model.selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulkActions }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.list.value?.more ? { label: t('list.showMore', { count: 50 }), onMore: () => undefined, held: t('held.listMax', { max: 500 }) } : null}
        keys={ownKeys}
        onHelp={() => actions?.onDialog?.({ kind: 'keys' })}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        focusRow={model.focusRow}
      />

      {model.record && <RecordModal model={model} record={model.record} rowIds={rowIds} actions={actions} />}
      {model.ask && <AskDialog ask={model.ask} can={model.can} online={model.online} actions={actions} />}
      <VerbDialogs model={model} actions={actions} />
      <ShortcutsDialog open={model.dialog?.kind === 'keys'} onClose={() => actions?.onDialog?.(null)} keys={listKeys(ownKeys, true).map((entry) => ({ keys: entry.keys, does: lists(entry.does) }))} />
    </div>
  )
}

const REMINDERS = ['', '3', '7', '14', '30'] as const

/** Cancel (a reason) and Re-request (a new due day, the cadence, a message): each asks first, then sends. */
function VerbDialogs({ model, actions }: { model: DeclarationsViewModel; actions?: DeclarationsActions }) {
  const t = useT(DEPTH_NAMESPACE)
  const q = useT('quality')
  const dialog = model.dialog
  const request = dialog && dialog.kind !== 'keys' ? (model.list.value?.requests.find((row) => row.id === dialog.id) ?? (model.record?.read.value?.request.id === dialog.id ? model.record.read.value.request : null)) : null
  if (!dialog || dialog.kind === 'keys' || !request) return null
  if (dialog.kind === 'cancel') {
    const problem = cancelReasonProblem(dialog.reason)
    return (
      <Modal
        open
        size="sm"
        title={t('cancel.title', { number: request.number })}
        onClose={() => actions?.onDialog?.(null)}
        footer={
          <>
            <Button onClick={() => actions?.onDialog?.(null)}>{q('common.close')}</Button>
            <Button variant="danger" heldReason={problem ? t(problem) : model.busy ? q('common.loading') : null} onClick={() => actions?.onCancelConfirm?.()}>
              {t('cancel.confirm')}
            </Button>
          </>
        }
      >
        <p className="fw-q-hint">{t(request.channel === 'PORTAL' ? 'cancel.portal' : 'cancel.office')}</p>
        <Field label={t('cancel.reason')} hint={t('cancel.reasonHint')}>
          <Textarea rows={3} value={dialog.reason} maxLength={500} onChange={(event) => actions?.onDialog?.({ ...dialog, reason: event.target.value })} />
        </Field>
      </Modal>
    )
  }
  const dueHeld = dialog.dueOn === '' ? t('askAgain.dueNeeded') : null
  return (
    <Modal
      open
      size="md"
      title={t('askAgain.title', { number: request.number })}
      onClose={() => actions?.onDialog?.(null)}
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{q('common.close')}</Button>
          <Button variant="primary" heldReason={dueHeld ?? (model.busy ? q('common.loading') : null)} onClick={() => actions?.onAskAgainConfirm?.()}>
            {t('askAgain.confirm')}
          </Button>
        </>
      }
    >
      <p className="fw-q-hint">{t(request.status === 'SENT' || request.status === 'OVERDUE' ? 'askAgain.waiting' : request.kind === 'REACH_SVHC' ? 'askAgain.svhc' : 'askAgain.decided', { number: request.number })}</p>
      <div className="fw-mt-form">
        <Field label={t('ask.due')}>
          <DateField value={dialog.dueOn} onChange={(value) => actions?.onDialog?.({ ...dialog, dueOn: value })} ariaLabel={t('ask.due')} />
        </Field>
        <Field label={t('ask.reminder')}>
          <Select value={dialog.reminderEveryDays} onChange={(event) => actions?.onDialog?.({ ...dialog, reminderEveryDays: event.target.value })} aria-label={t('ask.reminder')}>
            {REMINDERS.map((value) => (
              <option key={value} value={value}>
                {value === '' ? t('ask.reminderNever') : t('ask.reminderEvery', { count: Number(value) })}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label={t('ask.message')} hint={t('ask.messageHint')}>
        <Textarea rows={3} value={dialog.message} maxLength={2000} onChange={(event) => actions?.onDialog?.({ ...dialog, message: event.target.value })} />
      </Field>
    </Modal>
  )
}
