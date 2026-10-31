'use client'

import { useMemo, useRef } from 'react'
import Link from 'next/link'
import { ArrowRight, Circle, CircleCheck, Download, FileText, MoreHorizontal, RefreshCw } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, Menu, Timeline, type MenuItemDef, type TimelineStep } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Skeleton, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { dash, Section } from '../../../../quality/_shared/parts'
import type { CertCan } from '../../model'
import { StatusPill, useDay } from '../../view/parts'
import type { Renewals, Review, Stage } from '../api'
import { appliedHeld, barOf, linkHeld, REVIEW_TONE, reviewHeld, reviewVerbs, STAGE_TONE, stageState, startHeld, windowKey, WINDOW_MONTHS, type RenewalsModel } from '../model'
import type { RenewalsActions } from '../use-renewals'
import { RenewalDialogs } from './dialogs'

/** A certificate's record address (the record's own helper lives with the register's view; this one avoids the cycle). */
const certificateHref = (prefix: string, id: string, query = '') => `${prefix}/compliance/certificates/${encodeURIComponent(id)}${query ? `?${query}` : ''}`

/**
 * SCR-051 › Renewals (design compliance.certificates rec:Certificate tab `renewals`, W2a; QHS-105, PRD-283, PRD-285):
 *
 *   Validity and renewal (ren-timeline)   the five-year bar (a composed ValidityBar: the design's "(new)" part, not in
 *                                         the DS) with the window 12 to 6 months before the end, the 180 / 90 / 30-day
 *                                         alerts and today; each alert stage in words (whom it tells, when, what it did);
 *                                         the renewal: its next step as the primary (Start renewal · Record the
 *                                         application · Link the new certificate), the task's steps, the successor
 *   Changes to the approved type          every review of this certificate on the ONE list frame (Export N while rows
 *   (ren-changes)                         are selected): the style revision, what changed (before → after: a composed
 *                                         ChangeValue), whether the notified body's answer is needed, the status, the
 *                                         answer's file, and the verbs (Tell the notified body · Not needed · Record
 *                                         the answer); "the new revision prints no class label until the answer is
 *                                         recorded".
 *
 * Fetches nothing: use-renewals.ts reads and writes.
 */
export function RenewalsTab({ model, can, prefix, actions }: { model: RenewalsModel; can: CertCan; prefix: string; actions?: RenewalsActions }) {
  const t = useT('certificates')
  const q = useT('quality')
  const renewals = model.renewals.value
  return (
    <>
      {model.renewals.problem ? (
        <Section title={t('ren.title')}>
          <Banner tone="danger" title={t('ren.failed')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{q('common.retry')}</Button>}>
            <p className="fw-q-hint">{q(model.renewals.problem)}</p>
          </Banner>
        </Section>
      ) : !renewals ? (
        <Section title={t('ren.title')}>
          <Skeleton height={28} />
          <Skeleton height={120} />
        </Section>
      ) : (
        <ValidityAndRenewal renewals={renewals} model={model} can={can} prefix={prefix} actions={actions} />
      )}
      <ChangesList model={model} can={can} prefix={prefix} actions={actions} />
      {renewals && <RenewalDialogs renewals={renewals} model={model} can={can} actions={actions} />}
    </>
  )
}

// ---- Validity and renewal ------------------------------------------------------------------------------------------------------

/** The composed ValidityBar: the elapsed span, the window band and the marks, each in words below (never a colour alone). */
function RenewalBar({ renewals }: { renewals: Renewals }) {
  const t = useT('certificates')
  const day = useDay()
  const bar = barOf(renewals)
  return (
    <div className="fw-ce-ren-bar" role="img" aria-label={t('ren.bar.label', { from: day(renewals.certificate.validFrom), to: day(renewals.certificate.validTo), today: day(renewals.today) })}>
      <div className="fw-ce-ren-track">
        <span className="fw-ce-ren-elapsed" style={{ width: `${bar.elapsed}%` }} />
        <span className="fw-ce-ren-window" style={{ left: `${bar.windowFrom}%`, width: `${Math.max(0.5, bar.windowTo - bar.windowFrom)}%` }} />
        {bar.marks.map((mark) => (
          <span key={mark.key} className={`fw-ce-ren-mark is-${mark.kind}`} style={{ left: `${mark.at}%` }} title={mark.kind === 'today' ? t('ren.bar.today', { date: day(mark.date) }) : t('ren.bar.stage', { days: mark.days ?? 0, date: day(mark.date) })} />
        ))}
      </div>
      <div className="fw-ce-ren-ends" aria-hidden>
        <span>{day(renewals.certificate.validFrom)}</span>
        <span>{day(renewals.certificate.validTo)}</span>
      </div>
    </div>
  )
}

function stageStep(stage: Stage, words: { t: ReturnType<typeof useT>; day: (date: string | null | undefined) => string }): TimelineStep {
  const { t, day } = words
  const state = stageState(stage)
  const whom = stage.recipientRole ? t('ren.stage.tells', { role: stage.recipientRole.name }) : t('ren.stage.tellsNobody')
  const detail = [
    t(stage.workingDays ? 'ren.stage.onWorking' : 'ren.stage.on', { date: day(stage.fireOn) }),
    whom,
    state === 'fired' && stage.alert ? t(`ren.stage.alert.${stage.alert.state}`, { count: stage.alert.told, date: day(stage.alert.raisedAt.slice(0, 10)) }) : null,
    state === 'fired' && !stage.alert ? t('ren.stage.firedQuiet', { date: day(stage.timer?.firedAt?.slice(0, 10)) }) : null,
    state === 'cancelled' ? t('ren.stage.cancelled') : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return {
    key: stage.ruleId,
    tone: state === 'fired' ? (stage.severity === 'CRITICAL' ? 'danger' : 'warning') : STAGE_TONE[state] === 'info' ? 'info' : 'neutral',
    label: (
      <span className="fw-q-tags">
        <span>{t('ren.stage.name', { days: stage.daysBefore })}</span>
        <Tag tone={STAGE_TONE[state]}>{t(`ren.stage.state.${state}`)}</Tag>
        {stage.builtIn && <span className="fw-q-hint">{t('ren.stage.builtIn')}</span>}
      </span>
    ),
    detail,
  }
}

function ValidityAndRenewal({ renewals, model, can, prefix, actions }: { renewals: Renewals; model: RenewalsModel; can: CertCan; prefix: string; actions?: RenewalsActions }) {
  const t = useT('certificates')
  const day = useDay()
  const renewal = renewals.renewal
  const next = renewals.nextStep
  const startWhy = startHeld(renewals, can, model.busy)
  const appliedWhy = appliedHeld(renewals, can, undefined, model.busy)
  const linkWhy = linkHeld(renewals, can, undefined, model.busy)
  const primary =
    next === 'START' ? (
      <Button size="sm" variant="primary" heldReason={startWhy ? t(startWhy) : null} onClick={() => actions?.onDialog?.({ kind: 'start' })}>
        <RefreshCw size={14} aria-hidden /> {t('ren.start.open')}
      </Button>
    ) : next === 'APPLY' ? (
      <Button size="sm" variant="primary" heldReason={appliedWhy ? t(appliedWhy) : null} onClick={() => actions?.onDialog?.({ kind: 'applied' })}>
        {t('ren.applied.open')}
      </Button>
    ) : next === 'LINK' ? (
      <Button size="sm" variant="primary" heldReason={linkWhy ? t(linkWhy) : null} onClick={() => actions?.onDialog?.({ kind: 'link' })}>
        {t('ren.link.open')}
      </Button>
    ) : null
  const more: MenuItemDef[] = [
    ...(next !== 'APPLY' && next !== 'RENEWED' && next !== 'NONE' ? [{ id: 'applied', label: t('ren.applied.open'), onSelect: () => actions?.onDialog?.({ kind: 'applied' }), ...(appliedWhy ? { disabled: true, description: t(appliedWhy) } : {}) }] : []),
    ...(next !== 'LINK' && next !== 'RENEWED' && next !== 'NONE' ? [{ id: 'link', label: t('ren.link.open'), onSelect: () => actions?.onDialog?.({ kind: 'link' }), ...(linkWhy ? { disabled: true, description: t(linkWhy) } : {}) }] : []),
  ]
  const steps = renewals.stages.map((stage) => stageStep(stage, { t, day }))
  const checklist = renewal?.task?.checklist ?? []
  const done = checklist.filter((item) => item.done).length
  return (
    <Section
      title={t('ren.title')}
      sub={t('ren.intro', { opens: WINDOW_MONTHS.opens, closes: WINDOW_MONTHS.closes })}
      actions={
        <>
          {primary}
          {more.length > 0 && <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('ren.more') }} items={more} />}
        </>
      }
    >
      <RenewalBar renewals={renewals} />
      <Banner tone={renewals.window.phase === 'OPEN' ? 'info' : renewals.window.phase === 'CLOSED' && !renewals.successor ? 'warning' : 'neutral'} title={t(windowKey(renewals.window.phase), { opens: day(renewals.window.opens), closes: day(renewals.window.closes), date: day(renewals.certificate.validTo) })}>
        <p className="fw-q-hint">{t('ren.window.law')}</p>
      </Banner>
      <div className="fw-q-two">
        <Card padded>
          <h3 className="fw-ce-ren-h">{t('ren.stages.title')}</h3>
          {steps.length === 0 ? <p className="fw-q-hint">{t('ren.stages.none')}</p> : <Timeline label={t('ren.stages.title')} steps={steps} />}
          <p className="fw-q-hint">{t('ren.stages.where')}</p>
        </Card>
        <Card padded>
          <h3 className="fw-ce-ren-h">{t('ren.renewal.title')}</h3>
          {renewals.successor ? (
            <Banner tone="success" title={t('ren.renewal.renewedBy', { number: renewals.successor.number, from: day(renewals.successor.validFrom), to: day(renewals.successor.validTo) })}>
              <Button size="sm" asChild>
                <Link href={certificateHref(prefix, renewals.successor.id, 'tab=renewals')}>
                  {t('ren.renewal.openSuccessor')} <ArrowRight size={14} aria-hidden />
                </Link>
              </Button>
            </Banner>
          ) : null}
          {renewals.carriedOver && renewals.carriedOver.some((entry) => !entry.covered) && (
            <Banner tone="warning" title={t('ren.renewal.notCarried', { count: renewals.carriedOver.filter((entry) => !entry.covered).length })}>
              <ul className="fw-q-lines">
                {renewals.carriedOver.filter((entry) => !entry.covered).map((entry) => (
                  <li key={entry.styleId}>
                    <span className="fw-q-code">{entry.code}</span> {entry.name}
                  </li>
                ))}
              </ul>
              <p className="fw-q-hint">{t('ren.renewal.notCarriedFix')}</p>
            </Banner>
          )}
          {renewals.renews && (
            <p>
              {t('ren.renewal.renews')}{' '}
              <Link className="fw-q-link fw-q-code" href={certificateHref(prefix, renewals.renews.id, 'tab=renewals')}>
                {renewals.renews.number}
              </Link>{' '}
              <StatusPill status={renewals.renews.status} />
            </p>
          )}
          {renewal ? (
            <KeyValue
              items={[
                { label: t('ren.renewal.started'), value: t('ren.renewal.startedBy', { date: day(renewal.startedAt.slice(0, 10)), name: renewal.startedBy ?? '—' }) },
                { label: t('ren.renewal.task'), value: renewal.task ? t('ren.renewal.taskState', { title: renewal.task.title, state: t(`ren.task.${renewal.task.status}`), done, total: checklist.length, assignee: renewal.task.assignee ?? t('ren.renewal.nobody') }) : t('ren.renewal.taskHidden') },
                { label: t('ren.renewal.due'), value: day(renewal.task?.dueDate ?? renewals.window.closes) },
                { label: t('ren.renewal.applied'), value: renewal.appliedOn ? t(renewal.inWindow === false ? 'ren.renewal.appliedLate' : 'ren.renewal.appliedOn', { date: day(renewal.appliedOn), reference: renewal.reference ?? '—' }) : t('ren.renewal.notApplied') },
              ]}
            />
          ) : !renewals.successor ? (
            <p className="fw-q-hint">{t(next === 'NONE' ? 'ren.renewal.none' : 'ren.renewal.notStarted')}</p>
          ) : null}
          {checklist.length > 0 && (
            <ul className="fw-ce-ren-steps" aria-label={t('ren.renewal.steps')}>
              {checklist.map((item, index) => (
                <li key={index} className={item.done ? 'is-done' : undefined}>
                  {item.done ? <CircleCheck size={14} aria-hidden className="fw-ce-ren-tick" /> : <Circle size={14} aria-hidden className="fw-ce-ren-tick" />}
                  <span className="nds-vh">{t(item.done ? 'ren.renewal.stepIsDone' : 'ren.renewal.stepIsOpen')}</span>
                  <span>
                    {item.text}
                    {item.done && <span className="fw-q-hint"> · {t('ren.renewal.stepDone', { date: day(item.doneAt?.slice(0, 10)), name: item.doneBy ?? '—' })}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {renewals.log.length > 0 && (
            <ul className="fw-q-lines fw-ce-ren-log" aria-label={t('ren.log.title')}>
              {renewals.log.map((entry, index) => (
                <li key={`${entry.at}-${index}`}>
                  {t(`ren.log.${entry.action}`, { date: day(entry.at.slice(0, 10)), name: entry.by ?? '—', detail: entry.action === 'RENEWED' ? (entry.detail ?? '—') : day(entry.detail) })}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Section>
  )
}

// ---- Changes to the approved type -------------------------------------------------------------------------------------------

function ChangesList({ model, can, prefix, actions }: { model: RenewalsModel; can: CertCan; prefix: string; actions?: RenewalsActions }) {
  const t = useT('certificates')
  const q = useT('quality')
  const day = useDay()
  const rows = model.reviews.value
  const selected = rows?.filter((row) => model.selected.includes(row.id)) ?? []
  const live = useRef({ actions })
  live.current = { actions }
  const columns = useMemo<ColDef<Review>[]>(() => {
    const RevisionCell = ({ data }: ICellRendererParams<Review>) =>
      data ? (
        <span className="fw-q-cell">
          <Link className="fw-q-name fw-q-code" href={`${prefix}/products/styles/${encodeURIComponent(data.styleId)}?tab=compliance&rev=${encodeURIComponent(data.revision.id)}`} tabIndex={-1}>
            {data.style.code}
          </Link>
          <span className="fw-q-hint">{data.comparedRevision ? t('ren.changes.revision', { revision: data.revision.revision, compared: data.comparedRevision.revision }) : t('ren.changes.revisionOnly', { revision: data.revision.revision })}</span>
        </span>
      ) : null
    const ChangeCell = ({ data }: ICellRendererParams<Review>) =>
      data ? (
        <span className="fw-q-cell">
          {data.changes.slice(0, 2).map((change, index) => (
            <span key={index} className="fw-ce-change">
              <strong>{t(`ren.kind.${change.kind}`)}</strong> <span className="fw-ce-data">{change.before}</span> <ArrowRight size={12} aria-label={t('ren.changes.to')} /> <span className="fw-ce-data">{change.after}</span>
            </span>
          ))}
          {data.changes.length > 2 && <span className="fw-q-hint">{t('ren.changes.more', { count: data.changes.length - 2 })}</span>}
        </span>
      ) : null
    const NeededCell = ({ data }: ICellRendererParams<Review>) =>
      data ? (
        <span className="fw-q-cell">
          <span>{t(`ren.needed.${data.status}`)}</span>
          {data.holdsLabel && <span className="fw-q-hint">{t('ren.changes.labelHeld')}</span>}
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<Review>) =>
      data ? (
        <span className="fw-q-cell">
          <Pill tone={REVIEW_TONE[data.status]} dot>
            {t(`ren.status.${data.status}`)}
          </Pill>
          <span className="fw-q-hint">{data.answeredOn ? t('ren.changes.answered', { date: day(data.answeredOn), reference: data.answerReference ?? '—' }) : data.notifiedAt ? t('ren.changes.told', { date: day(data.notifiedAt.slice(0, 10)) }) : dash(null)}</span>
        </span>
      ) : null
    const FileCell = ({ data }: ICellRendererParams<Review>) =>
      data ? (
        data.files.length > 0 ? (
          <span className="fw-q-cell">
            <span>
              <FileText size={13} aria-hidden /> {data.files[0]!.originalName}
            </span>
            {data.files.length > 1 && <span className="fw-q-hint">{t('ren.changes.files', { count: data.files.length })}</span>}
          </span>
        ) : (
          <span className="fw-q-hint">{t('ren.changes.noFile')}</span>
        )
      ) : null
    const ActionsCell = ({ data }: ICellRendererParams<Review>) => {
      if (!data) return null
      const verbs = reviewVerbs(data)
      const items: MenuItemDef[] = verbs.map((verb) => {
        const why = reviewHeld(can, verb)
        return { id: verb, label: t(`ren.verb.${verb}`), onSelect: () => live.current.actions?.onDialog?.({ kind: verb, reviewId: data.id }), ...(why ? { disabled: true, description: t(why) } : {}) }
      })
      if (items.length === 0) items.push({ id: 'none', label: t('ren.verb.none'), disabled: true, description: t(`ren.status.${data.status}`) })
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('ren.changes.menu', { code: data.style.code, revision: data.revision.revision }) }} items={items} />
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<Review>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number }): ColDef<Review> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      column('revision', t('ren.changes.col.revision'), RevisionCell, { flex: 1.5, minWidth: 230 }),
      column('change', t('ren.changes.col.change'), ChangeCell, { flex: 2.4, minWidth: 280 }),
      column('needed', t('ren.changes.col.needed'), NeededCell, { flex: 1.7, minWidth: 250 }),
      column('status', t('ren.changes.col.status'), StatusCell, { flex: 1.3, minWidth: 170 }),
      column('file', t('ren.changes.col.file'), FileCell, { flex: 1.2, minWidth: 160 }),
      { ...column('actions', t('ren.changes.col.actions'), ActionsCell, { width: 72, minWidth: 72 }), suppressHeaderMenuButton: true },
    ]
  }, [t, day, prefix, can])

  const holding = rows?.filter((row) => row.holdsLabel).length ?? 0
  const state = model.reviews.problem ? (
    <EmptyState title={t('ren.changes.failed')} description={q(model.reviews.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{q('common.retry')}</Button>} />
  ) : rows && rows.length === 0 ? (
    <EmptyState title={t('ren.changes.empty')} description={t('ren.changes.emptyBody')} />
  ) : undefined
  return (
    <Section title={t('ren.changes.title')} sub={t('ren.changes.intro')}>
      {holding > 0 && <Banner tone="warning" title={t('ren.changes.heldBanner', { count: holding })} />}
      <ListFrame<Review>
        label={t('ren.changes.title')}
        listKey={null}
        rows={model.reviews.problem ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t('ren.changes.count', { count: rows.length }) : '—'}
        selection={{
          selected: model.selected,
          onChange: (ids) => actions?.onSelect?.(ids),
          actions: (
            <Button size="sm" onClick={() => actions?.onExport?.(selected)} aria-label={t('list.bulkExport', { count: selected.length })}>
              <Download size={13} aria-hidden /> <SelectionLabel>{t('list.bulkExport', { count: selected.length })}</SelectionLabel>
            </Button>
          ),
        }}
        state={state}
      />
    </Section>
  )
}
