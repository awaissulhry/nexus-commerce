'use client'

import { useMemo } from 'react'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { EmptyState } from '@nexus/ui/components'
import { Button, Select } from '@nexus/ui/primitives'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { siteColumn } from '../../../../shell/scope/scope-context'
import { EARNINGS_KINDS } from '@nexus/factory-domain/people/earnings/rules'
import type { EarningsKind, EntryRow } from '../api'
import { dayText, hasRight, minutesText, moneyText, monthText, rateText } from '../model'
import type { PieceActions, PieceModel } from '../view-model'
import { Figure, said, Section, usePieceWords } from './parts'

/**
 * Earnings ledger (design sec:ledger, MES-256): every paid scan as an entry; a correction is a new entry, never an edit. It
 * names nobody and has no worker filter (Owner answer W1; B-W2b-43 refuses a person's key): a person is read on their
 * statement, an entry opens as one record. Only with the right; everyone else is told why it is not here.
 */
export function LedgerSection({ model, actions }: { model: PieceModel; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  const locale = useLocale()
  const { ledger, address } = model
  const hidden = t('periods.hidden')
  const columns = useMemo<ColDef<EntryRow>[]>(() => {
    const site = siteColumn<EntryRow>(model.scope, (row) => row.siteId, t('sites.site'))
    return [
      {
        colId: 'date',
        headerName: t('ledger.date'),
        width: 130,
        valueGetter: (params) => params.data?.workDate ?? '',
        cellRenderer: (params: ICellRendererParams<EntryRow>) =>
          params.data ? (
            <a
              className="fw-pp-link"
              href={`?entry=${encodeURIComponent(params.data.id)}`}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey) return
                event.preventDefault()
                actions?.onOpenEntry(params.data!.id)
              }}
            >
              {dayText(params.data.workDate, locale)}
            </a>
          ) : null,
      },
      ...(site ? [site] : []),
      { colId: 'bundle', headerName: t('ledger.bundle'), width: 130, valueGetter: (params) => params.data?.bundle ?? '—' },
      { colId: 'operation', headerName: t('rates.operation'), flex: 1, minWidth: 200, valueGetter: (params) => (params.data?.operation ? `${params.data.operation.code} · ${params.data.operation.name}` : '—') },
      { colId: 'pieces', headerName: t('ledger.pieces'), width: 90, type: 'numericColumn', valueGetter: (params) => params.data?.pieces ?? '—' },
      { colId: 'minutes', headerName: t('ledger.minutes'), width: 100, type: 'numericColumn', valueGetter: (params) => minutesText(params.data?.minutes, locale) ?? '—' },
      { colId: 'rate', headerName: t('ledger.rate'), width: 120, type: 'numericColumn', cellRenderer: (params: ICellRendererParams<EntryRow>) => (params.data ? <Figure value={rateText(params.data.rate, params.data.currency, locale)} hidden={hidden} /> : null) },
      { colId: 'amount', headerName: t('ledger.amount'), width: 130, type: 'numericColumn', cellRenderer: (params: ICellRendererParams<EntryRow>) => (params.data ? <Figure value={moneyText(params.data.amount, params.data.currency, locale)} hidden={hidden} /> : null) },
      { colId: 'source', headerName: t('ledger.source'), width: 170, valueGetter: (params) => (params.data ? t(`kind.ledger.${params.data.reversesId ? 'REVERSAL' : params.data.kind}`) : '') },
      { colId: 'corrects', headerName: t('ledger.corrects'), width: 170, valueGetter: (params) => (params.data ? (params.data.correctsMonth ? monthText(params.data.correctsMonth, locale) : params.data.reversesId ? t('ledger.reverses') : '') : '') },
      { colId: 'reason', headerName: t('ledger.reason'), width: 220, valueGetter: (params) => params.data?.reason ?? '' },
    ]
  }, [t, locale, hidden, actions, model.scope])
  if (!ledger) {
    if (!model.can.earnings) return null
    return (
      <Section id="ledger" title={t('ledger.title')} hint={t('ledger.hint')}>
        <p className="fw-pr8-hint">{t(hasRight(model.can) ? 'common.reading' : 'ledger.noRight')}</p>
      </Section>
    )
  }
  const periods = model.periods?.status === 'ready' ? model.periods.value : []
  return (
    <Section id="ledger" title={t('ledger.title')} hint={t('ledger.hint')}>
      <ListFrame<EntryRow>
        listKey="people.piecerates.ledger"
        title={t('ledger.title')}
        label={t('ledger.title')}
        rows={ledger.problem ? [] : ledger.entries}
        rowId={(row) => row.id}
        columns={columns}
        count={t('ledger.count', { count: ledger.entries?.length ?? 0 })}
        tools={
          <span className="fw-pr8-row">
            <Select size="sm" aria-label={t('ledger.period')} value={address.ledgerPeriod ?? ''} onChange={(event) => actions?.onAddress({ ledgerPeriod: event.target.value || null })}>
              <option value="">{t('ledger.allPeriods')}</option>
              {periods.map((row) => (
                <option key={row.id} value={row.id}>
                  {monthText(row.month, locale)}
                </option>
              ))}
            </Select>
            {model.lines.length > 0 && (
              <Select size="sm" aria-label={t('record.line')} value={address.ledgerLine ?? ''} onChange={(event) => actions?.onAddress({ ledgerLine: event.target.value || null })}>
                <option value="">{t('ledger.allLines')}</option>
                {model.lines.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.code}
                  </option>
                ))}
              </Select>
            )}
            <Select size="sm" aria-label={t('ledger.source')} value={address.ledgerKind ?? ''} onChange={(event) => actions?.onAddress({ ledgerKind: (event.target.value || null) as EarningsKind | null })}>
              <option value="">{t('ledger.allSources')}</option>
              {EARNINGS_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kind.ledger.${kind}`)}
                </option>
              ))}
            </Select>
          </span>
        }
        onHelp={() => actions?.onHelp(true)}
        onOpen={(row) => actions?.onOpenEntry(row.id)}
        more={ledger.more ? { label: t('ledger.more'), onMore: () => actions?.onLedgerMore(), held: ledger.loadingMore ? t('common.reading') : null } : null}
        state={
          ledger.problem ? (
            <EmptyState
              title={t('common.failed')}
              description={said(t, ledger.problem)}
              action={
                <Button size="sm" onClick={() => actions?.onRetry()}>
                  {t('common.retry')}
                </Button>
              }
            />
          ) : ledger.entries?.length === 0 ? (
            <EmptyState title={t('ledger.empty')} description={t('ledger.emptyBody')} />
          ) : undefined
        }
      />
    </Section>
  )
}
