'use client'

import { useEffect, useMemo } from 'react'
import { Ban, FileSignature, Printer, Upload } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select } from '@nexus/ui/primitives'
import { RECEIPT_LAW } from '@nexus/factory-domain/safety/ppe/rules'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { siteColumn } from '../../../../shell/scope/scope-context'
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import type { IssueLine } from '../api'
import { ISSUE_VIEWS, issuedByText, issueMatches, itemName, RECEIPT_TONE, receiptsOfLines, type IssueView } from '../model'
import type { PpePageActions, PpePageModel } from '../view-model'
import { PAGE_KEYS, receiptHref, SectionFailed, SectionHead, SectionLoading, useDay, useWhen, useWords } from './parts'

/**
 * Issues and receipts (design sec issues; QHS-261; D.Lgs. 81/2008 art. 18 c.1 d, art. 77 c.4): every item handed over at the
 * top bar's site — Date · person · item · size · quantity · issued by · signed (badge + PIN on the tablet, or paper receipt) ·
 * receipt PDF · reason — as the list frame, one row per line. A wrong issue is voided with a reason, never deleted (the row
 * keeps its void mark); a paper receipt whose scan is not on file says so and takes the scan here. Print receipts over the
 * rows chosen (their receipts, each once, in a new tab). Enter opens the row's receipt.
 */
export function IssuesLens({ model, actions, onHelp }: { model: PpePageModel; actions?: PpePageActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const ds = useDsWords()
  const day = useDay()
  const when = useWhen()
  const locale = useLocale()
  const { address, scope, can } = model
  const answer = model.issues.status === 'ready' ? model.issues.value : null
  const rows = useMemo(() => (answer ? answer.issues.filter((row) => issueMatches(row, address.q, locale)) : null), [answer, address.q, locale])
  const selected = model.selected ?? []
  useEffect(() => {
    if (rows && selected.some((id) => !rows.some((row) => row.id === id))) actions?.onSelected?.(selected.filter((id) => rows.some((row) => row.id === id)))
  }, [rows, selected, actions])

  const columns = useMemo<ColDef<IssueLine>[]>(() => {
    const by = { worker: t('issues.byWorker'), none: '—' }
    const PersonCell = ({ data }: ICellRendererParams<IssueLine>) =>
      data ? (
        <span className="fw-ppe-cell">
          <span>{data.employee.name}</span>
          <span className="fw-ppe-muted">{data.employee.employeeCode ?? t('gaps.noCode')}</span>
        </span>
      ) : null
    const ItemCell = ({ data }: ICellRendererParams<IssueLine>) =>
      data ? (
        <span className="fw-ppe-cell">
          <span className={data.voided ? 'fw-ppe-struck' : undefined}>{itemName(data.item, locale)}</span>
          <span className="fw-ppe-muted fw-ppe-code">{data.item.code}</span>
        </span>
      ) : null
    // The state says how it was signed (with the PIN at a tablet, or on paper); the method in words is the pill's title.
    const SignedCell = ({ data }: ICellRendererParams<IssueLine>) =>
      data ? (
        <span className="fw-ppe-row fw-ppe-nowrap">
          <span title={t(`method.${data.method}`)}>
            <Pill tone={RECEIPT_TONE[data.receipt.state]} dot>
              {t(`receiptState.${data.receipt.state}`)}
            </Pill>
          </span>
          <a
            className="fw-ppe-link"
            href={receiptHref(model.prefix, [data.receiptId])}
            target="_blank"
            rel="noopener noreferrer"
            title={data.receipt.documentFileId ? t('issues.receiptKept') : data.receipt.scanFileId ? t('issues.receiptScan') : t('issues.receiptPdf')}
            aria-label={t('issues.openReceipt', { name: data.employee.name, date: day(data.issuedAt) })}
          >
            <FileSignature size={14} aria-hidden /> {t('issues.pdf')}
          </a>
        </span>
      ) : null
    // A wrong issue is voided with a reason, never deleted; a paper receipt still without its scan takes it here.
    const ActionsCell = ({ data }: ICellRendererParams<IssueLine>) => {
      if (!data) return null
      if (data.voided)
        return (
          <span className="fw-ppe-cell fw-ppe-muted" title={data.voided.reason ?? undefined}>
            <span>{t('issues.voidedOn', { date: day(data.voided.at) })}</span>
            <span>{data.voided.reason ?? '—'}</span>
          </span>
        )
      return (
        <span className="fw-ppe-row fw-ppe-nowrap">
          {data.receipt.state === 'NOT_SIGNED' && (
            <Button size="sm" variant="quiet" heldReason={can.upload ? null : t('held.upload')} aria-label={t('issues.addScanOf', { name: data.employee.name })} onClick={() => actions?.onAddress?.({ scan: data.receiptId })}>
              <Upload size={13} aria-hidden /> {t('issues.addScanShort')}
            </Button>
          )}
          <Button size="sm" variant="quiet" heldReason={!can.issue || !data.canVoid ? t('held.issue') : null} aria-label={t('issues.voidOf', { item: itemName(data.item, locale), name: data.employee.name })} onClick={() => actions?.onAddress?.({ void: data.id })}>
            <Ban size={13} aria-hidden /> {t('issues.void')}
          </Button>
        </span>
      )
    }
    const site = siteColumn<IssueLine>(scope, (row) => row.siteId, t('col.site'))
    return [
      { colId: 'date', headerName: t('issues.col.date'), minWidth: 145, flex: 0.7, valueGetter: (params) => params.data?.issuedAt ?? '', valueFormatter: (params) => (params.data ? when(params.data.issuedAt) : '') },
      { colId: 'person', headerName: t('issues.col.person'), minWidth: 145, flex: 1, valueGetter: (params) => params.data?.employee.name ?? '', cellRenderer: PersonCell },
      { colId: 'item', headerName: t('issues.col.item'), minWidth: 160, flex: 1.2, valueGetter: (params) => (params.data ? itemName(params.data.item, locale) : ''), cellRenderer: ItemCell },
      { colId: 'size', headerName: t('issues.col.size'), minWidth: 85, flex: 0.4, valueGetter: (params) => (params.data ? (params.data.size ?? t('issues.oneSize')) : '') },
      { colId: 'quantity', headerName: t('issues.col.quantity'), minWidth: 105, flex: 0.4, type: 'numericColumn', valueGetter: (params) => params.data?.quantity ?? null },
      { colId: 'reason', headerName: t('issues.col.reason'), minWidth: 120, flex: 0.5, valueGetter: (params) => (params.data ? t(`reason.${params.data.reason}`) : '') },
      { colId: 'by', headerName: t('issues.col.by'), minWidth: 115, flex: 0.7, valueGetter: (params) => (params.data ? issuedByText(params.data.issuedBy, by) : '') },
      { colId: 'signed', headerName: t('issues.col.signed'), minWidth: 200, flex: 1.1, sortable: false, valueGetter: (params) => (params.data ? t(`receiptState.${params.data.receipt.state}`) : ''), cellRenderer: SignedCell },
      ...(site ? [site] : []),
      { colId: 'actions', headerName: t('col.actions'), minWidth: 205, flex: 0.8, sortable: false, pinned: 'right', valueGetter: (params) => (params.data?.voided ? t('issues.voided') : ''), cellRenderer: ActionsCell },
    ]
  }, [t, day, when, scope, locale, can.issue, can.upload, model.prefix, actions])

  const filters = (
    <span className="fw-ppe-row">
      <Input size="sm" type="search" value={address.q} placeholder={t('issues.search')} aria-label={t('issues.search')} onChange={(event) => actions?.onAddress?.({ q: event.target.value })} />
      <Select size="sm" value={address.signed} aria-label={t('issues.signedFilter')} onChange={(event) => actions?.onAddress?.({ signed: event.target.value as IssueView })}>
        {ISSUE_VIEWS.map((view) => (
          <option key={view} value={view}>
            {t(`issues.view.${view}`)}
          </option>
        ))}
      </Select>
      {address.person && (
        <Button size="sm" variant="quiet" aria-label={t('issues.clearPerson')} onClick={() => actions?.onAddress?.({ person: null })}>
          {t('issues.personChip', { name: answer?.issues.find((row) => row.employee.id === address.person)?.employee.name ?? t('issues.onePerson') })} ×
        </Button>
      )}
      {address.ppe && (
        <Button size="sm" variant="quiet" aria-label={t('issues.clearItem')} onClick={() => actions?.onAddress?.({ ppe: null })}>
          {t('issues.itemChip', { item: answer?.issues.find((row) => row.item.id === address.ppe)?.item.code ?? t('issues.oneItem') })} ×
        </Button>
      )}
      {(address.from || address.to) && (
        <Button size="sm" variant="quiet" aria-label={t('issues.clearDates')} onClick={() => actions?.onAddress?.({ from: null, to: null })}>
          {t('issues.datesChip', { from: address.from ? day(address.from) : '…', to: address.to ? day(address.to) : '…' })} ×
        </Button>
      )}
    </span>
  )

  const head = (
    <SectionHead id="fw-ppe-issues" title={t('issues.title')} note={<LawRef law={answer?.law.receipt ?? RECEIPT_LAW} plain={t('law.receipt')} labels={ds.lawRef} />}>
      <ScopeSiteChip model={scope} />
    </SectionHead>
  )

  if (model.issues.status === 'error') {
    return (
      <>
        {head}
        <SectionFailed title={t('issues.failed')} problem={model.issues.problem} onRetry={() => actions?.onRetry?.('issues')} />
      </>
    )
  }
  if (!answer || !rows) {
    return (
      <>
        {head}
        <SectionLoading rows={6} />
      </>
    )
  }

  const filtered = address.q !== '' || address.signed !== 'all' || !!address.person || !!address.ppe || !!address.from || !!address.to
  const receipts = receiptsOfLines(rows, selected)
  return (
    <>
      {head}
      <ListFrame<IssueLine>
        label={t('issues.label')}
        title={t('issues.title')}
        listKey="plant.ppe.2"
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={t('issues.count', { count: rows.length })}
        search={filters}
        selection={{
          selected,
          onChange: (ids) => actions?.onSelected?.(ids),
          actions: (
            <Button size="sm" variant="primary" aria-label={t('bulk.receipts', { count: receipts.length })} onClick={() => actions?.onPrintReceipts?.(receipts)}>
              <Printer size={13} aria-hidden /> <SelectionLabel>{t('bulk.receipts', { count: receipts.length })}</SelectionLabel>
            </Button>
          ),
        }}
        keys={PAGE_KEYS(t)}
        onHelp={onHelp}
        onOpen={(row) => actions?.onPrintReceipts?.([row.receiptId])}
        more={answer.complete ? null : { label: t('issues.more'), onMore: () => undefined, held: t('issues.moreHeld') }}
        state={
          rows.length === 0 ? (
            filtered ? (
              <EmptyState icon={<FileSignature size={22} aria-hidden />} title={t('issues.noneFiltered')} description={t('common.noneFilteredHint')} />
            ) : (
              <EmptyState icon={<FileSignature size={22} aria-hidden />} title={t('issues.emptyTitle')} description={t('issues.empty')} />
            )
          ) : undefined
        }
        cards={{ fields: { item: { role: 'title' }, person: { role: 'subtitle' } } }}
      />
    </>
  )
}
