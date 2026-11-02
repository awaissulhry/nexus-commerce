'use client'

import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { CheckCheck, Eye, MoreHorizontal, ShieldAlert } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Menu, SummaryTable } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, RadioCard, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale, useScopedT, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { Finding, SummaryRow } from '../api'
import type { BundlesActions, BundlesModel, FindingsDialog as FindingsDialogModel, WhoDialog as WhoDialogModel } from '../list-model'
import { askOf, BUNDLES_NAMESPACE, findingSelectable, patternsState, reviewHeld, reviewManyHeld, seenWords, summaryKey, WHO_PURPOSES, whoHeld, whoShowHeld, type FindingsAsk, type WhoPurpose } from '../model'
import { LegalBasisNote } from './parts'

const STATUS_TONE = { OPEN: 'warning', REVIEWED: 'success', DISMISSED: 'neutral' } as const

/**
 * Scan-pattern checks (design bd-patterns, MES-075): patterns about BUNDLES to talk about, never a score. The law's
 * sentence, then per site whether the checks run and why not ("Not available: this site records stations, not people"),
 * the counts of the last 7 days per line, operation and kind; a count opens the bundles behind it, never the people.
 */
export function ScanPatterns({ model, actions }: { model: BundlesModel; actions?: BundlesActions }) {
  const t = useT(BUNDLES_NAMESPACE)
  const summary = model.summary.value
  const state = summary ? patternsState(summary) : null
  const count = (row: SummaryRow, ask: FindingsAsk, value: number, name: string) =>
    value > 0 ? (
      <Button key={name} size="sm" variant="quiet" aria-label={t('patterns.openCount', { count: value, kind: t(`kind.${row.kind}`) })} onClick={() => actions?.onAsk?.(ask)}>
        {value}
      </Button>
    ) : (
      <span key={name}>0</span>
    )
  return (
    <Card padded className="fw-pr-card">
      <div className="fw-pr-card-head">
        <h2 className="fw-pr-h2">{t('patterns.title')}</h2>
        <span className="fw-pr-hint">{t('patterns.days', { count: summary?.days ?? 7 })}</span>
      </div>
      <LegalBasisNote />
      {model.summary.problem ? (
        <Banner
          tone="danger"
          title={t('patterns.failed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetrySummary?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : !summary || !state ? (
        <div className="fw-pr-stack" aria-busy="true">
          <Skeleton height={22} />
          <Skeleton height={22} />
        </div>
      ) : (
        <>
          {state.off.map((entry) => (
            <p key={entry.site.id} className="fw-bd-off">
              <ShieldAlert size={14} aria-hidden /> <b>{entry.site.code}</b> {t(entry.words.key, entry.words.params)}
            </p>
          ))}
          {state.counts &&
            (summary.rows.length === 0 ? (
              <p className="fw-pr-hint">{t('patterns.none')}</p>
            ) : (
              <SummaryTable
                label={t('patterns.title')}
                stackOnPhone
                columns={[t('patterns.col.line'), t('patterns.col.operation'), t('patterns.col.kind'), t('patterns.col.open'), t('patterns.col.reviewed'), t('patterns.col.dismissed')]}
                align={[undefined, undefined, undefined, 'right', 'right', 'right']}
                rows={summary.rows.map((row) => {
                  const ask = askOf(row)
                  return {
                    id: summaryKey(row),
                    cells: [
                      row.line ? `${row.line.code} · ${row.line.name}` : t('patterns.noLine'),
                      row.operation ? `${row.operation.code} · ${row.operation.name}` : '—',
                      t(`kind.${row.kind}`),
                      count(row, ask, row.open, 'open'),
                      count(row, ask, row.reviewed, 'reviewed'),
                      count(row, ask, row.dismissed, 'dismissed'),
                    ],
                  }
                })}
              />
            ))}
        </>
      )}
    </Card>
  )
}

/** The bundles behind a count (one kind, line and operation): the shared list frame in a dialog, each with its review. */
export function FindingsDialog({ model, dialog, actions }: { model: BundlesModel; dialog: FindingsDialogModel; actions?: BundlesActions }) {
  const t = useT(BUNDLES_NAMESPACE)
  const scoped = useScopedT(BUNDLES_NAMESPACE)
  const locale = useLocale()
  const [selected, setSelected] = useState<readonly string[]>([])
  const items = dialog.rows.items
  const summary = model.summary.value
  const held = (words: { key: string; params?: Readonly<Record<string, string | number>> } | null) => (words ? t(words.key, words.params) : null)
  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  // The latest actions, so a parent's render never remounts the grid's cells (an open ⋯ stays open).
  const latest = useRef(actions)
  latest.current = actions

  const columns = useMemo<ColDef<Finding>[]>(() => {
    const BundleCell = ({ data }: ICellRendererParams<Finding>) =>
      data ? (
        <span className="fw-pr-cell">
          <Link className="fw-pr-link fw-pr-code" href={`${model.prefix}/production/bundles/${data.bundle.id}`}>
            {data.bundle.code}
          </Link>
          <span className="fw-pr-cell-sub">{data.bundle.part ? `${data.bundle.part} · ` : ''}{t('col.piecesCount', { count: data.bundle.quantity })}</span>
        </span>
      ) : null
    const OrderCell = ({ data }: ICellRendererParams<Finding>) =>
      data ? (
        <Link className="fw-pr-link" href={`${model.prefix}/production/work-orders/${data.workOrder.id}`}>
          {data.workOrder.number}
        </Link>
      ) : null
    const SeenCell = ({ data }: ICellRendererParams<Finding>) => {
      if (!data) return null
      const words = seenWords(data)
      return <span className="fw-pr-ellipsis">{t(words.key, words.params)}</span>
    }
    const StatusCell = ({ data }: ICellRendererParams<Finding>) => (data ? <Pill tone={STATUS_TONE[data.status]}>{t(`finding.${data.status}`)}</Pill> : null)
    const MoreCell = ({ data }: ICellRendererParams<Finding>) => {
      if (!data) return null
      const review = held(reviewHeld(data, model.can, dialog.busy))
      const who = held(whoHeld(data, summary, model.can))
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('finding.menu', { code: data.bundle.code }) }}
          items={[
            { id: 'open', label: t('finding.open'), href: `${model.prefix}/production/bundles/${data.bundle.id}` },
            { id: 'reviewed', label: t('finding.markReviewed'), disabled: review !== null, ...(review ? { description: review } : {}), onSelect: () => latest.current?.onReviewed?.([data.id]) },
            { id: 'dismiss', label: t('finding.dismiss'), disabled: review !== null, ...(review ? { description: review } : {}), onSelect: () => latest.current?.onDismiss?.(data) },
            { id: 'who', label: t('finding.who'), disabled: who !== null, ...(who ? { description: who } : {}), onSelect: () => latest.current?.onWho?.(data) },
          ]}
        />
      )
    }
    return [
      { colId: 'bundle', headerName: t('finding.col.bundle'), minWidth: 150, flex: 1, cellRenderer: BundleCell },
      { colId: 'workOrder', headerName: t('finding.col.workOrder'), minWidth: 110, flex: 0.7, cellRenderer: OrderCell },
      { colId: 'seen', headerName: t('finding.col.seen'), minWidth: 240, flex: 2, cellRenderer: SeenCell },
      { colId: 'when', headerName: t('finding.col.when'), minWidth: 130, flex: 0.8, valueGetter: (params) => (params.data ? formatDateTime(params.data.windowStart, { locale }) : '') },
      { colId: 'status', headerName: t('finding.col.status'), minWidth: 110, flex: 0.6, cellRenderer: StatusCell },
      { colId: 'more', headerName: t('finding.col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    // The menu's words follow the rows' state.
  }, [t, locale, model.prefix, model.can, summary, dialog.busy])

  const state = dialog.rows.problem ? (
    <EmptyState
      title={t('finding.failed')}
      description={scoped(`production:${dialog.rows.problem}`)}
      action={
        <Button size="sm" onClick={() => actions?.onRetryFindings?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : items && items.length === 0 ? (
    <EmptyState title={t('finding.none')} />
  ) : undefined

  const manyHeld = held(reviewManyHeld(picked, model.can, dialog.busy))
  return (
    <>
      <Modal open onClose={() => actions?.onAsk?.(null)} title={t(`kind.${dialog.ask.kind}`)} subtitle={t('finding.subtitle')} size="xl">
        <div className="fw-pr-dialog">
          {dialog.notice && <Banner tone={dialog.notice.tone} title={scoped(dialog.notice.words.key, dialog.notice.words.params)} />}
          <ListFrame<Finding>
            label={t('finding.table')}
            listKey={null}
            rows={state ? [] : items}
            rowId={(row) => row.id}
            columns={columns}
            count={items ? t(dialog.rows.more ? 'finding.countMore' : 'finding.count', { count: items.length }) : '—'}
            selection={{
              selected,
              onChange: setSelected,
              actions: (
                <Button
                  size="sm"
                  variant="primary"
                  aria-label={t('finding.reviewMany', { count: picked.length })}
                  heldReason={manyHeld}
                  onClick={() => {
                    actions?.onReviewed?.(picked.map((row) => row.id))
                    setSelected([])
                  }}
                >
                  <CheckCheck size={13} aria-hidden /> <SelectionLabel>{t('finding.reviewMany', { count: picked.length })}</SelectionLabel>
                </Button>
              ),
            }}
            isRowSelectable={(row) => held(findingSelectable(row))}
            more={dialog.rows.more && items?.length ? { label: t('list.more'), onMore: () => actions?.onMoreFindings?.() } : null}
            state={state}
          />
        </div>
      </Modal>
      {dialog.dismiss && <DismissDialog finding={dialog.dismiss} busy={dialog.busy} actions={actions} />}
      {dialog.who && <WhoDialog who={dialog.who} purpose={model.whoPurpose} actions={actions} />}
    </>
  )
}

function DismissDialog({ finding, busy, actions }: { finding: Finding; busy: boolean; actions?: BundlesActions }) {
  const t = useT(BUNDLES_NAMESPACE)
  const [note, setNote] = useState('')
  return (
    <Modal
      open
      onClose={() => actions?.onDismiss?.(null)}
      title={t('finding.dismissTitle', { code: finding.bundle.code })}
      size="sm"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onDismiss?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={note.trim().length === 0 ? t('review.noteNeeded') : busy ? t('held.busy') : null} onClick={() => actions?.onSendDismiss?.(note.trim())}>
            {t('finding.dismiss')}
          </Button>
        </>
      }
    >
      <Field label={t('finding.dismissNote')}>
        <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={500} />
      </Field>
    </Modal>
  )
}

/**
 * Show who (one finding) (design pop:bd-who): a purpose is required, the legal basis on record is shown, "This view is
 * logged". The scans of this one bundle in the finding's window, with the workers' names, drawn only here: never a list,
 * a filter or a total, gone when the dialog closes.
 */
function WhoDialog({ who, purpose: startPurpose, actions }: { who: WhoDialogModel; purpose?: WhoPurpose; actions?: BundlesActions }) {
  const t = useT(BUNDLES_NAMESPACE)
  const scoped = useScopedT(BUNDLES_NAMESPACE)
  const locale = useLocale()
  const [purpose, setPurpose] = useState<WhoPurpose | null>(startPurpose ?? null)
  const [note, setNote] = useState('')
  const heldWords = whoShowHeld(purpose, who.busy)
  const answer = who.answer
  return (
    <Modal
      open
      onClose={() => actions?.onWho?.(null)}
      title={t('who.title', { code: who.finding.bundle.code })}
      subtitle={t(`kind.${who.finding.kind}`)}
      size="lg"
      footer={
        answer ? (
          <>
            <span className="grow" />
            <Button size="sm" variant="primary" onClick={() => actions?.onWho?.(null)}>
              {t('common.close')}
            </Button>
          </>
        ) : (
          <>
            <span className="grow" />
            <Button size="sm" onClick={() => actions?.onWho?.(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="primary" heldReason={heldWords ? t(heldWords.key) : null} onClick={() => purpose && actions?.onShowWho?.(purpose, note.trim())}>
              {who.busy ? <Spinner size={12} /> : <Eye size={13} aria-hidden />} {t('who.show')}
            </Button>
          </>
        )
      }
    >
      <div className="fw-pr-dialog">
        <Banner tone="info" title={t('who.logged')}>
          {t('who.oneFinding')}
        </Banner>
        {who.basis && <p className="fw-pr-hint">{t('who.basis', { kind: t(`who.basisKind.${who.basis.kind}`), reference: who.basis.reference, when: formatDateTime(who.basis.recordedAt, { locale }) })}</p>}
        {who.problem && <Banner tone="danger" title={scoped(who.problem.key, who.problem.params)} />}
        {answer ? (
          answer.scans.length === 0 ? (
            <p className="fw-pr-hint">{t('who.noScans')}</p>
          ) : (
            <SummaryTable
              label={t('who.table')}
              stackOnPhone
              columns={[t('who.col.when'), t('who.col.operation'), t('who.col.worker'), t('who.col.station'), t('who.col.good'), t('who.col.scrap'), t('who.col.rework')]}
              align={[undefined, undefined, undefined, undefined, 'right', 'right', 'right']}
              rows={answer.scans.map((scan) => ({
                id: scan.id,
                cells: [
                  <span key="when" className="fw-pr-inline">
                    {formatDateTime(scan.at, { locale })}
                    {scan.kind !== 'REPORT' && <Tag tone="warning">{t(`scanKind.${scan.kind}`)}</Tag>}
                  </span>,
                  scan.operation ? `${scan.operation.seq} ${scan.operation.code}` : '—',
                  scan.worker?.name ?? t('who.noWorker'),
                  scan.station?.code ?? '—',
                  String(scan.good),
                  String(scan.scrap),
                  String(scan.rework),
                ],
              }))}
            />
          )
        ) : (
          <>
            <fieldset className="fw-pr-list">
              <legend className="fw-pr-h3">{t('who.purpose')}</legend>
              {WHO_PURPOSES.map((value) => (
                <RadioCard key={value} variant="row" name="fw-bd-who-purpose" checked={purpose === value} selected={purpose === value} onChange={() => setPurpose(value)} title={t(`who.purposeWord.${value}`)} />
              ))}
            </fieldset>
            <Field label={t('who.note')}>
              <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={300} />
            </Field>
          </>
        )}
      </div>
    </Modal>
  )
}
