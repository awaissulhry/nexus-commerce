'use client'

import { Lock, Plus } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, MetricStrip, SummaryTable, type Metric } from '@nexus/ui/components'
import { Button, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { decimalText, moneyText } from '../../../model'
import type { VersionRecord, VersionRow } from '../api'
import { approveHeld, compareDefaults, CS_NS, newVersionHeld, removeHeld, sendHeld, STATE_TONE, takeBackHeld, versionState, type Phrase } from '../model'
import type { VersionsActions, VersionsModel } from '../screen'
import { CompareDialog } from './CompareDialog'
import { VersionDialogs } from './VersionDialogs'

/**
 * SCR-500 — Style › Cost › Cost sheet versions and approval (design products.styles style.cost.versions; FIN-014, FIN-015,
 * FIN-016): the style's versions series by series (Version, Season, Status, Approved by, Cost — the base size's and the
 * weighted cost for a typical size mix, only with the cost grain), the version in view (its figures, its size mix, its cost
 * by category at the base size, what was left out when it was written) and what may happen to it now: Send for approval,
 * Approve and lock (the approval engine's yes: never by the person who asked or who made it), Take back, Copy as a new
 * version, Delete the draft; New version from the components of the revision in view; Compare two versions. An approved
 * version is locked and says what to do instead (a new version). The view fetches nothing.
 */
export function VersionsCard({ model, actions }: { model: VersionsModel; actions?: VersionsActions }) {
  const t = useT(CS_NS)
  const locale = useLocale()
  const say = (phrase: Phrase | null) => (phrase ? t(phrase.key, phrase.params) : null)
  const list = model.list
  const header = t('ver.title')
  if (list.status === 'idle' || list.status === 'loading')
    return (
      <Card header={header} aria-busy="true">
        <p className="fw-st-hint" role="status">
          <Spinner size={14} /> {t('ver.loading')}
        </p>
      </Card>
    )
  if (list.status === 'error')
    return (
      <Card header={header}>
        <EmptyState title={t('ver.failed')} description={t(list.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.('list')}>{t('csCommon.retry')}</Button>} />
      </Card>
    )
  const rows = list.value.versions
  const newHeld = newVersionHeld(model.can, model.revision, model.busy)
  const newButton = (
    <Button size="sm" variant="secondary" heldReason={say(newHeld)} onClick={() => actions?.onDialog?.({ kind: 'new', from: 'COMPONENTS' })}>
      <Plus size={14} aria-hidden /> {model.revision ? t('ver.new', { revision: model.revision.revision }) : t('ver.newPlain')}
    </Button>
  )
  const compareHeld = compareDefaults(rows) === null ? t('ver.compareHeld') : null
  const money = (value: string | null | undefined, currency: string) => (model.grains.cost && value !== undefined && value !== null ? moneyText(value, currency, locale) : null)
  const inView = model.inView

  return (
    <div className="fw-st-stack-lg">
      <Card
        header={header}
        headerAction={
          <span className="fw-st-actions fw-cs-wrap">
            <Button size="sm" variant="quiet" heldReason={compareHeld} onClick={() => actions?.onCompareOpen?.()}>
              {t('ver.compare')}
            </Button>
            {newButton}
          </span>
        }
        description={t('ver.intro')}
      >
        <div className="fw-st-stack">
          {model.notice && (
            <Banner
              tone={model.notice.tone}
              title={t(model.notice.words.key, model.notice.words.params)}
              action={
                <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
                  {t('csCommon.dismiss')}
                </Button>
              }
            />
          )}
          {!model.grains.cost && <Banner tone="info" icon={<Lock size={16} aria-hidden />} title={t('ver.noGrain')} />}
          {rows.length === 0 ? (
            <EmptyState title={t('ver.empty')} description={model.revision ? t('ver.emptyBody', { revision: model.revision.revision }) : t('ver.emptyNoRevision')} action={newButton} />
          ) : (
            <SummaryTable
              label={header}
              density="roomy"
              stackOnPhone
              columns={[t('ver.col.version'), t('ver.col.season'), t('ver.col.status'), t('ver.col.approvedBy'), ...(model.grains.cost ? [t('ver.col.cost')] : []), t('ver.col.show')]}
              widths={model.grains.cost ? ['18%', '14%', '18%', '20%', '18%', undefined] : ['22%', '18%', '22%', '22%', undefined]}
              align={[undefined, undefined, undefined, undefined, ...(model.grains.cost ? ['right' as const] : []), 'right']}
              rows={[...rows]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .map((row) => {
                  const state = versionState(row)
                  const shown = inView?.id === row.id
                  return {
                    id: row.id,
                    cells: [
                      <span key="v" className="fw-st-cellstack">
                        <b>{t('ver.name', { version: row.sheetVersion })}</b>
                        <span className="nds-summary-sub">{row.basedOnId ? t('ver.revBased', { revision: row.revision.revision, version: rows.find((other) => other.id === row.basedOnId)?.sheetVersion ?? '—' }) : t('ver.rev', { revision: row.revision.revision })}</span>
                      </span>,
                      row.season ? row.season.code : <span className="fw-st-hint">{t('ver.noSeason')}</span>,
                      <Pill key="s" tone={STATE_TONE[state]}>
                        {state === 'approved' && <Lock size={12} aria-hidden />} {t(`verState.${state}`)}
                      </Pill>,
                      row.approvedBy ? (
                        <span key="a" className="fw-st-cellstack">
                          <span>{row.approvedBy.name}</span>
                          {row.approvedAt && <span className="nds-summary-sub">{formatDate(row.approvedAt, { locale })}</span>}
                        </span>
                      ) : (
                        '—'
                      ),
                      ...(model.grains.cost
                        ? [
                            <span key="c" className="fw-st-cellstack">
                              <b>{money(row.baseCost, row.currency) ?? t('ver.notKnown')}</b>
                              <span className="nds-summary-sub">{row.weightedCost ? t('ver.weightedShort', { amount: money(row.weightedCost, row.currency) ?? '—' }) : t('ver.baseShort', { size: row.baseSize })}</span>
                            </span>,
                          ]
                        : []),
                      <Button key="o" size="sm" variant={shown ? 'tonal' : 'quiet'} aria-pressed={shown} onClick={() => actions?.onPick?.(row.id)} aria-label={t('ver.showLabel', { version: row.sheetVersion })}>
                        {shown ? t('ver.shown') : t('ver.show')}
                      </Button>,
                    ],
                  }
                })}
            />
          )}
        </div>
      </Card>
      {inView && <VersionInView row={inView} model={model} actions={actions} />}
      <VersionDialogs model={model} actions={actions} />
      {model.compare && <CompareDialog rows={rows} model={model.compare} grains={model.grains} actions={actions} />}
    </div>
  )
}

/** The version in view: its state in words, its actions (each held with why), its figures, size mix and cost by category. */
function VersionInView({ row, model, actions }: { row: VersionRow; model: VersionsModel; actions?: VersionsActions }) {
  const t = useT(CS_NS)
  const locale = useLocale()
  const say = (phrase: Phrase | null) => (phrase ? t(phrase.key, phrase.params) : null)
  const state = versionState(row)
  const record = model.record.status === 'ready' && model.record.value.sheet.id === row.id ? model.record.value : null
  const money = (value: string | null | undefined) => (model.grains.cost && value !== undefined && value !== null ? moneyText(value, row.currency, locale) : null)
  const price = (value: string | null | undefined) => (model.grains.price && value !== undefined && value !== null ? moneyText(value, row.currency, locale) : null)
  const pct = (value: number) => `${decimalText(String(value), locale, 1)} %`
  const send = sendHeld(model.can, row, record, model.busy)
  const approve = approveHeld(model.can, row, model.task, model.busy)
  const back = takeBackHeld(model.can, row, model.busy)
  const remove = removeHeld(model.can, row, record, model.busy)
  const copy = !model.can.manage ? t('verHeld.noManage') : model.busy ? t('verHeld.busy') : null
  const frozenBy = row.frozenReason === 'SUPERSEDED' ? (model.list.status === 'ready' ? model.list.value.versions.find((other) => other.state === 'APPROVED' && other.createdAt > row.createdAt) : undefined) : undefined

  const metrics: Metric[] = [
    ...(model.grains.cost
      ? [
          { label: t('verView.base', { size: row.baseSize }), value: money(row.baseCost) ?? t('ver.notKnown'), hint: row.baseCost ? undefined : t('verView.baseUnknown') },
          { label: t('verView.weighted'), value: money(row.weightedCost) ?? t('ver.notKnown'), hint: weightsHint(record, t) },
        ]
      : []),
    ...(model.grains.price ? [{ label: t('verView.target'), value: price(row.targetPrice) ?? t('verView.noTarget') }] : []),
    ...(model.grains.margin ? [{ label: t('verView.targetMargin'), value: row.targetMarginPct ? pct(Number(row.targetMarginPct)) : t('verView.noTarget') }] : []),
  ]

  return (
    <Card
      header={
        <span className="fw-st-inline">
          {t('verView.title', { version: row.sheetVersion })}
          <Pill tone={STATE_TONE[state]}>
            {state === 'approved' && <Lock size={12} aria-hidden />} {t(`verState.${state}`)}
          </Pill>
        </span>
      }
      headerAction={
          <span className="fw-st-actions fw-cs-wrap">
            {state === 'draft' && (
              <Button size="sm" variant="primary" heldReason={say(send)} onClick={() => actions?.onDialog?.({ kind: 'send' })}>
                {t('verAct.send')}
              </Button>
            )}
            {state === 'waiting' && (
              <Button size="sm" variant="primary" heldReason={say(approve)} onClick={() => actions?.onDialog?.({ kind: 'approve' })}>
                {t('verAct.approve')}
              </Button>
            )}
            {state === 'approved' && (
              <Button size="sm" heldReason={say(back)} onClick={() => actions?.onDialog?.({ kind: 'takeBack' })}>
                {t('verAct.takeBack')}
              </Button>
            )}
            <Button size="sm" heldReason={copy} onClick={() => actions?.onDialog?.({ kind: 'new', from: 'COPY', basedOnId: row.id })}>
              {t('verAct.copy')}
            </Button>
            {(state === 'draft' || state === 'waiting') && (
              <Button size="sm" variant="danger-outline" heldReason={say(remove)} onClick={() => actions?.onDialog?.({ kind: 'remove' })}>
                {t('verAct.remove')}
              </Button>
            )}
          </span>
      }
      description={t(`verWords.${state}`, { version: frozenBy?.sheetVersion ?? '—' })}
    >
      <div className="fw-st-stack">
        {metrics.length > 0 && <MetricStrip metrics={metrics} />}
        <KeyValue
          dense
          labelCase="sentence"
          columns={2}
          items={[
            { label: t('verView.revision'), value: t('ver.rev', { revision: row.revision.revision }) },
            { label: t('verView.season'), value: row.season ? `${row.season.code}${row.season.status === 'CLOSED' ? ` · ${t('verView.seasonClosed')}` : ''}` : t('ver.noSeason') },
            { label: t('verView.made'), value: formatDate(row.createdAt, { locale }) },
            { label: t('verView.approvedBy'), value: row.approvedBy ? `${row.approvedBy.name}${row.approvedAt ? ` · ${formatDate(row.approvedAt, { locale })}` : ''}` : '—' },
            ...(record?.sheet.note ? [{ label: t('verView.note'), value: record.sheet.note }] : []),
          ]}
        />
        {model.record.status === 'loading' || (model.record.status === 'ready' && !record) ? (
          <p className="fw-st-hint" role="status">
            <Spinner size={12} /> {t('verView.loading')}
          </p>
        ) : model.record.status === 'error' ? (
          <Banner tone="danger" title={t('verView.failed')} action={<Button size="sm" onClick={() => actions?.onRetry?.('record')}>{t('csCommon.retry')}</Button>}>
            {t(model.record.problem)}
          </Banner>
        ) : record ? (
          <RecordParts record={record} money={money} />
        ) : null}
        {state === 'waiting' && model.task?.status === 'error' && (
          <Banner tone="warning" title={t('verView.taskFailed')} action={<Button size="sm" onClick={() => actions?.onRetry?.('task')}>{t('csCommon.retry')}</Button>} />
        )}
        {(state === 'approved' || state === 'superseded' || state === 'seasonClosed' || state === 'withdrawn') && <p className="fw-st-hint">{t('verView.lockedWhat')}</p>}
      </div>
    </Card>
  )
}

function weightsHint(record: VersionRecord | null, t: (key: string, params?: Record<string, string | number>) => string): string | undefined {
  if (!record) return undefined
  const weights = record.weights
  if (weights.missing.length > 0) return t('verView.weightsMissing', { sizes: weights.missing.join(', ') })
  return t(weightSourceKey(weights))
}

/** Where the size mix came from: its source, else "kept when it was written" when shares exist (an older version says no source). */
const weightSourceKey = (weights: VersionRecord['weights']): string => `weightSource.${weights.source ?? (weights.shares.length > 0 ? 'KEPT' : 'NONE')}`

/** The size mix, the cost by category at the base size and what was left out when the version was written. */
function RecordParts({ record, money }: { record: VersionRecord; money: (value: string | null | undefined) => string | null }) {
  const t = useT(CS_NS)
  const locale = useLocale()
  const sheet = record.sheet
  const base = record.split.find((cell) => cell.size === sheet.baseSize) ?? null
  const categories = base ? base.categories.filter((entry) => entry.amount === undefined || Number(entry.amount) !== 0) : []
  return (
    <div className="fw-cs-parts">
      <div className="fw-st-stack">
        <h3 className="fw-cs-h3">{t('verView.mixTitle')}</h3>
        {record.weights.shares.length === 0 ? (
          <p className="fw-st-hint">{t('verView.noMix')}</p>
        ) : (
          <SummaryTable
            label={t('verView.mixTitle')}
            columns={[t('verView.col.size'), t('verView.col.share')]}
            align={[undefined, 'right']}
            rows={record.weights.shares.map((share) => ({ id: share.size, cells: [share.size === sheet.baseSize ? t('steps.baseSizeOption', { size: share.size }) : share.size, `${decimalText(share.sharePct, locale, 2)} %`] }))}
          />
        )}
        <p className="fw-st-hint">{t(weightSourceKey(record.weights))}</p>
      </div>
      <div className="fw-st-stack">
        <h3 className="fw-cs-h3">{t('verView.byCategory', { size: sheet.baseSize })}</h3>
        {!base || categories.length === 0 ? (
          <p className="fw-st-hint">{t('verView.noLines')}</p>
        ) : (
          <SummaryTable
            label={t('verView.byCategory', { size: sheet.baseSize })}
            columns={[t('verView.col.category'), money('0') !== null ? t('verView.col.amount') : t('verView.col.lines')]}
            align={[undefined, 'right']}
            rows={[
              ...categories.map((entry) => ({
                id: entry.category,
                cells: [t(`stepCat.${entry.category}`), money(entry.amount) ?? String(record.lines.filter((line) => line.category === entry.category && (line.size === null || line.size === sheet.baseSize)).length)],
              })),
              ...(money('0') !== null ? [{ id: 'total', cells: [<b key="l">{t('verView.total')}</b>, <b key="v">{base.complete ? (money(base.total) ?? '—') : t('steps.knownSoFar', { amount: money(base.knownTotal) ?? '—' })}</b>] }] : []),
            ]}
          />
        )}
        {record.leftOut.length > 0 && (
          <Banner tone="warning" title={t('verView.leftOut', { count: record.leftOut.length })}>
            <ul className="fw-st-list">
              {record.leftOut.map((entry) => (
                <li key={entry.key}>
                  {t(`stepMissing.${entry.code}`)}
                  {entry.size ? ` ${t('steps.inSize', { size: entry.size })}` : ''}
                </li>
              ))}
            </ul>
          </Banner>
        )}
        <span>
          <Tag tone="neutral">{t('verView.lineCount', { count: record.lines.length })}</Tag>
        </span>
      </div>
    </div>
  )
}
