'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import Link from 'next/link'
import { Banner, KeyValue, Sparkline, type TimelineStep } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Input, Kbd, Pill, SegmentedControl } from '@nexus/ui/primitives'
import { DetailModal, Textarea, Timeline, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { useWords } from '../../_shared/parts'
import { DECISION_CHOICES, decisionHeld, differenceText, historyLine, operationHref, operationLabel, routingHref, sparkValues, standardText, styleLabel, type DecisionChoice } from '../model'
import type { ReviewDetailState } from '../use-review'
import type { EfficiencyActions, EfficiencyModel } from './EfficiencyView'

const SPEAK_KEYS: Readonly<Record<string, DecisionChoice>> = { c: 'CHANGE', i: 'INVESTIGATE' }

/**
 * The standard review's detail (design pop:review, a DetailModal at `?open=<operation>`): bundles, actual against SMV, the
 * history in words, one decision with its reason. J / K are the DS's Prev / Next, the same on every page, so "keep" is ⇧K
 * here (the design's plain K would collide); C change, I investigate. A key only picks the decision and goes to the reason:
 * a decision always carries one. "Change" records what the standard should become; the standard itself changes with a new
 * routing revision in Products, and rates follow c.c. art. 2101.
 */
export function ReviewDetail({ model, detail, actions }: { model: EfficiencyModel; detail: ReviewDetailState & { id: string; ids: readonly string[] }; actions?: EfficiencyActions | undefined }) {
  const t = useT('people-efficiency')
  const people = useWords()
  const locale = useLocale()
  const ds = useDsWords()
  const reason = useRef<HTMLTextAreaElement>(null)
  const { read, draft } = detail
  const value = read.status === 'ready' ? read.value : null
  const close = () => actions?.onAddress?.({ open: null })
  const pick = (decision: DecisionChoice) => actions?.review?.onDraft({ decision })
  const held = decisionHeld(draft, model.can, detail.busy)

  // In the capture phase, before the DS's own J / K: ⇧K must not also move to the previous row.
  const latest = useRef({ pick, can: model.can.review })
  latest.current = { pick, can: model.can.review }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || !latest.current.can) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      const key = event.key.toLowerCase()
      const decision = event.shiftKey && key === 'k' ? 'KEEP' : event.shiftKey ? undefined : SPEAK_KEYS[key]
      if (!decision) return
      event.preventDefault()
      latest.current.pick(decision)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const decision = draft.decision
  useEffect(() => {
    if (decision) reason.current?.focus()
  }, [decision])

  const steps: TimelineStep[] = (value?.history ?? []).map((entry) => ({
    key: entry.id,
    tone: entry.decision === 'KEEP' ? 'success' : entry.decision === 'CHANGE' ? 'warning' : 'info',
    label: t(historyLine(entry), { who: entry.by }),
    detail: [formatDateTime(entry.at, { locale, timeZone: model.timeZone }), entry.proposedMinutes ? t('review.proposedWas', { minutes: standardText(entry.proposedMinutes, locale) }) : null, entry.reason].filter(Boolean).join(' · '),
  }))

  const body: ReactNode = value ? (
    <div className="fw-pp-stack">
      {detail.done && (
        <Banner tone="success" title={t(`review.done.${detail.done.decision}`)}>
          {detail.done.decision === 'CHANGE' && model.can.styles ? <Link href={routingHref(model.prefix, detail.done.styleId)}>{t('review.startRevision')}</Link> : null}
        </Banner>
      )}
      {detail.problem && <Banner tone="danger" title={detail.problem.ns === 'efficiency' ? t(detail.problem.words.key) : people(detail.problem.words.key, detail.problem.words.params)} />}
      {value.tooFew && <Banner tone="info" title={t('tooFew.long')} />}
      <div className="fw-ef-detail">
        <section className="fw-pp-stack tight" aria-label={t('review.figures')}>
          <KeyValue
            columns={2}
            labelCase="sentence"
            items={[
              { label: t('operations.smv'), value: standardText(value.standardMinutes, locale) },
              { label: t('operations.actual'), value: value.tooFew ? '—' : standardText(value.figures.actualMinutes, locale) },
              { label: t('operations.difference'), value: value.tooFew ? '—' : differenceText(value.figures.differencePercent, locale) },
              { label: t('operations.bundles'), value: value.figures.bundles === null ? '—' : String(value.figures.bundles), hint: t('review.window', { from: formatDate(`${value.from}T12:00:00Z`, { locale }), to: formatDate(`${value.to}T12:00:00Z`, { locale }) }) },
              { label: t('review.since'), value: value.review.since ? formatDate(`${value.review.since}T12:00:00Z`, { locale }) : '—' },
              { label: t('review.why'), value: value.review.reason ? t(`review.reason.${value.review.reason}`) : t('review.notOnQueue') },
            ]}
          />
          <Sparkline fluid height={40} shape="line" values={sparkValues(value.days)} label={t('operations.spark', { operation: operationLabel(value) })} emptyLabel={t('operations.sparkEmpty')} format={(n) => differenceText(String(n), locale)} />
          <h3 className="fw-ef-h3">{t('review.history')}</h3>
          {steps.length === 0 ? <p className="fw-pp-hint">{t('review.noHistory')}</p> : <Timeline label={t('review.history')} steps={steps} />}
        </section>
        <section className="fw-pp-stack tight" aria-label={t('review.decision')}>
          <h3 className="fw-ef-h3">{t('review.decision')}</h3>
          <SegmentedControl
            ariaLabel={t('review.decision')}
            options={DECISION_CHOICES.map((choice) => ({ value: choice, label: t(`decision.${choice}`) }))}
            value={draft.decision ?? ''}
            disabled={!model.can.review}
            onChange={(next) => pick(next as DecisionChoice)}
          />
          <p className="fw-pp-hint">
            <Kbd>⇧K</Kbd> {t('keys.keep')} · <Kbd>C</Kbd> {t('keys.change')} · <Kbd>I</Kbd> {t('keys.investigate')}
          </p>
          {draft.decision === 'CHANGE' && (
            <>
              <label className="fw-pp-stack tight">
                <span>{t('review.proposed')}</span>
                <Input inputMode="decimal" value={draft.proposed} onChange={(event) => actions?.review?.onDraft({ proposed: event.target.value })} />
              </label>
              <p className="fw-pp-hint">
                {t('review.changeNote')} <LawRef law={t('review.law')} plain={t('review.lawPlain')} labels={ds.lawRef} />
              </p>
            </>
          )}
          <label className="fw-pp-stack tight">
            <span>{t('review.reasonLabel')}</span>
            <Textarea ref={reason} value={draft.reason} onChange={(event) => actions?.review?.onDraft({ reason: event.target.value })} />
          </label>
          <span className="fw-pp-row">
            <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.review?.onDecide()}>
              {t('review.record')}
            </Button>
            {model.can.operations && (
              <Button variant="quiet" asChild>
                <Link href={operationHref(model.prefix, value.operation.id)} target="_blank" rel="noopener noreferrer">
                  {t('operations.inProducts')}
                </Link>
              </Button>
            )}
          </span>
        </section>
      </div>
    </div>
  ) : null

  return (
    <DetailModal
      open
      onClose={close}
      title={value ? operationLabel(value) : t('review.title')}
      subtitle={value ? styleLabel(value) : undefined}
      meta={value?.review.reason ? <Pill tone={value.review.reason === 'OFF_STANDARD' ? 'warning' : 'info'}>{t(`review.reason.${value.review.reason}`)}</Pill> : undefined}
      nav={{ ids: detail.ids, current: detail.id, onGo: (id) => actions?.onAddress?.({ open: id }), noun: t('review.noun') }}
      loading={read.status === 'loading'}
      error={read.status === 'error' ? (read.problem.ns === 'efficiency' ? t(read.problem.words.key) : people(read.problem.words.key, read.problem.words.params)) : undefined}
      onRetry={() => actions?.review?.onRetry()}
    >
      {body}
    </DetailModal>
  )
}
