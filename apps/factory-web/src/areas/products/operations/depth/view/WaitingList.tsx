'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Check } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { minutesText } from '../../../styles/model'
import type { WaitingEntry } from '../api'
import { waitingSelectHeld } from '../model'
import type { WaitingActions, WaitingModel } from '../use-waiting'
import '../depth.css'

/**
 * The SMV changes waiting for approval (B-W2b-235; design products.operations sec:operations.tiles "SMV changes waiting for
 * approval (W2b)"): the tile's view on the shared list frame — the operation (a link to its Minutes), old → new SMV, from
 * which day, why, who proposed it and when — oldest first. Approve N with rows selected: a change the person proposed, or
 * may not decide, is not selectable and says why on its box; a rejection needs its reason, on the operation's Minutes. It
 * fetches nothing.
 */
export function WaitingList({ model, actions, prefix, userId, selected: preset, confirmOpen }: { model: WaitingModel; actions?: WaitingActions; prefix: string; userId: string | null; selected?: string[]; confirmOpen?: boolean }) {
  return (
    <WithMessages namespaces={['products-operations-depth']}>
      <List model={model} actions={actions} prefix={prefix} userId={userId} preset={preset} confirmOpen={confirmOpen} />
    </WithMessages>
  )
}

function List({ model, actions, prefix, userId, preset, confirmOpen }: { model: WaitingModel; actions?: WaitingActions; prefix: string; userId: string | null; preset?: string[]; confirmOpen?: boolean }) {
  const t = useT('products-operations-depth')
  const tl = useT('library')
  const locale = useLocale()
  const [selected, setSelected] = useState<readonly string[]>(preset ?? [])
  const [confirm, setConfirm] = useState(confirmOpen ?? false)
  const rows = model.entries
  const picked = (rows ?? []).filter((entry) => selected.includes(entry.proposal.id))
  const href = (entry: WaitingEntry) => `${prefix}/products/operations/${entry.operation.id}?tab=minutes`

  const columns = useMemo<ColDef<WaitingEntry>[]>(() => {
    const OperationCell = ({ data }: ICellRendererParams<WaitingEntry>) =>
      data ? (
        <span className="fw-opd-cell">
          <Link className="fw-opd-link" href={href(data)}>
            {data.operation.code}
          </Link>
          <span className="fw-opd-sub">{data.operation.name}</span>
        </span>
      ) : null
    const ChangeCell = ({ data }: ICellRendererParams<WaitingEntry>) =>
      data ? (
        <span className="fw-opd-cell">
          <span className="fw-opd-num">{t('decide.oldNew', { from: minutesText(data.operation.standardMinutes, locale), to: minutesText(data.proposal.standardMinutes, locale) })}</span>
          <span className="fw-opd-sub">{t('waiting.version', { number: data.proposal.number })}</span>
        </span>
      ) : null
    const ByCell = ({ data }: ICellRendererParams<WaitingEntry>) =>
      data ? (
        <span className="fw-opd-cell">
          <span>{data.proposal.proposedBy.name}</span>
          <span className="fw-opd-sub">{formatDate(data.proposal.proposedAt, { locale })}</span>
        </span>
      ) : null
    return [
      { colId: 'operation', headerName: t('waiting.col.operation'), minWidth: 200, flex: 1.4, cellRenderer: OperationCell, valueGetter: (params) => (params.data ? `${params.data.operation.code} · ${params.data.operation.name}` : '') },
      { colId: 'change', headerName: t('waiting.col.change'), minWidth: 170, flex: 1, cellRenderer: ChangeCell, valueGetter: (params) => (params.data ? params.data.proposal.standardMinutes : '') },
      { colId: 'from', headerName: t('waiting.col.from'), minWidth: 130, flex: 0.8, valueGetter: (params) => (params.data ? formatDate(params.data.proposal.effectiveFrom, { locale }) : '') },
      { colId: 'reason', headerName: t('waiting.col.reason'), minWidth: 220, flex: 2, tooltipValueGetter: (params) => params.data?.proposal.reason, valueGetter: (params) => params.data?.proposal.reason ?? '' },
      { colId: 'by', headerName: t('waiting.col.by'), minWidth: 170, flex: 1, cellRenderer: ByCell, valueGetter: (params) => params.data?.proposal.proposedBy.name ?? '' },
    ]
  }, [t, locale, prefix])

  const state =
    model.problem !== null ? (
      <EmptyState title={t('waiting.failed')} description={tl(model.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{tl('common.retry')}</Button>} />
    ) : rows !== null && rows.length === 0 ? (
      <EmptyState title={t('waiting.empty.title')} description={t('waiting.empty.body')} />
    ) : undefined
  const approveHeld = model.busy ? t('held.busy') : null
  const notice = model.notice

  return (
    <div className="fw-opd-stack">
      {notice && (
        <Banner
          tone={notice.tone}
          title={notice.key.startsWith('problem.') ? tl(notice.key, notice.params) : t(notice.key, notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {tl('common.dismiss')}
            </Button>
          }
        />
      )}
      <p className="fw-opd-hint">{t('waiting.intro')}</p>
      <ListFrame<WaitingEntry>
        label={t('waiting.label')}
        listKey={null}
        rows={state ? [] : rows}
        rowId={(row) => row.proposal.id}
        columns={columns}
        count={rows ? t('waiting.count', { count: model.count ?? rows.length }) : '—'}
        isRowSelectable={(row) => {
          const why = waitingSelectHeld(row, userId)
          return why ? t(why) : null
        }}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" variant="primary" aria-label={t('waiting.approveN', { count: picked.length })} heldReason={approveHeld} onClick={() => setConfirm(true)}>
              <Check size={13} aria-hidden /> <SelectionLabel>{t('waiting.approveN', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        onOpen={(row) => actions?.onOpen?.(href(row))}
        state={state}
      />
      {confirm && picked.length > 0 && (
        <Modal
          open
          onClose={() => setConfirm(false)}
          size="md"
          title={t('waiting.confirmTitle', { count: picked.length })}
          footer={
            <>
              <Button onClick={() => setConfirm(false)}>{tl('common.back')}</Button>
              <Button
                variant="primary"
                heldReason={approveHeld}
                onClick={() =>
                  void actions?.onApprove?.(picked.map((entry) => entry.proposal.id)).then((ok) => {
                    setConfirm(false)
                    if (ok) setSelected([])
                  })
                }
              >
                {t('waiting.approveN', { count: picked.length })}
              </Button>
            </>
          }
        >
          <div className="fw-opd-stack">
            <p className="fw-opd-hint">{t('waiting.confirmIntro')}</p>
            <ul className="fw-opd-list">
              {picked.map((entry) => (
                <li key={entry.proposal.id}>
                  <b>{entry.operation.code}</b> · {t('decide.oldNew', { from: minutesText(entry.operation.standardMinutes, locale), to: minutesText(entry.proposal.standardMinutes, locale) })} · {t('versions.from', { day: formatDate(entry.proposal.effectiveFrom, { locale }) })} · {entry.proposal.proposedBy.name}
                </li>
              ))}
            </ul>
          </div>
        </Modal>
      )}
    </div>
  )
}
