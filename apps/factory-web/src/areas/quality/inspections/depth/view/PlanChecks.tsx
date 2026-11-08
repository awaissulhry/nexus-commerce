'use client'

import { useState, type KeyboardEvent } from 'react'
import Link from 'next/link'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Button, Input, SegmentedControl, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { CellSaveMark } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { Section } from '../../../_shared/parts'
import type { Read } from '../../../_shared/model'
import type { ResultBody, Sheet, SheetCheck } from '../api'
import { answerOf, checkCounts, identityTone, identityWords, labelIn, recordable, unitsOf, valueProblem } from '../model'
import { ClassTag, useDepthT, useSay } from '../parts'
import type { SaveMark } from '../use-final-depth'

/** A row's save mark: the DS CellSaveMark while saving or unknown, the refusal in words; nothing once saved. */
export function DepthMark({ mark }: { mark: SaveMark | undefined }) {
  const td = useDepthT()
  const t = useT('quality')
  if (!mark || mark.state === 'saved') return null
  if (mark.state === 'refused') {
    const words = [mark.problem.includes('.') && !mark.problem.startsWith('problem.') ? td(mark.problem) : t(mark.problem), ...(mark.lines ?? [])].join(' ')
    return (
      <span className="fw-q-refused fw-qd-refused" role="alert">
        {words}
      </span>
    )
  }
  return <CellSaveMark state={mark.state} />
}

type Answer = 'PASS' | 'FAIL' | 'NOT_APPLICABLE' | 'none'

/**
 * Inspection › Checks & results on a plan (design ins-checklist on B-W2b-97's sheet): the plan version's frozen checks, each
 * with its class and its answers over the sample ("3 passed · 1 failed · 1 not checked"), and — for the unit picked — the
 * answer recorded on the bench or here (Pass, Fail, Not applicable, Not checked), its value, note, where and when. While the
 * inspection is open and it is the viewer's, a row answers by its control or by 1 / 2 / 3 on the focused row; a fail and a
 * critical "not applicable" ask the note first (the plan's rule), then save. A measurement is answered on the chart, a photo
 * on the bench. "11 of 12 checked · 1 failed · critical failed: none" heads the list.
 */
export function PlanChecks({
  sheet,
  unit,
  marks,
  held,
  prefix,
  onUnit,
  onAnswer,
  onRetry,
}: {
  sheet: Read<Sheet> | null
  unit: number
  marks: Readonly<Record<string, SaveMark>>
  /** Why the answers are read only here (a key of `inspections-depth`), or null. */
  held: string | null
  prefix: string
  onUnit?: (unit: number) => void
  onAnswer?: (body: ResultBody) => void
  onRetry?: () => void
}) {
  const td = useDepthT()
  const t = useT('quality')
  const locale = useLocale()
  const [pending, setPending] = useState<Record<string, Answer>>({})
  if (!sheet || (sheet.value === null && !sheet.problem)) {
    return (
      <Section id="plan-checks" title={td('checks.headingReading')}>
        <Skeleton width="100%" height={120} />
      </Section>
    )
  }
  if (sheet.problem || !sheet.value) {
    return (
      <Section id="plan-checks" title={td('checks.headingReading')}>
        <EmptyState
          title={td('checks.failed')}
          description={t(sheet.problem ?? 'problem.unknown')}
          action={
            <Button size="sm" onClick={() => onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      </Section>
    )
  }
  const value = sheet.value
  const editable = held === null
  const now = value.checksNow
  const units = unitsOf(value.inspection.sampleSize)
  const send = (check: SheetCheck, outcome: Answer, extra: { value?: string | null; note?: string | null } = {}) => {
    const current = answerOf(check, unit)
    const note = extra.note !== undefined ? extra.note : (current?.note ?? null)
    // A fail says what is wrong; a critical check is "not applicable" only with the reason (B-W2b-97's rule): ask first.
    if ((outcome === 'FAIL' || (outcome === 'NOT_APPLICABLE' && check.checkClass === 'CRITICAL')) && !(note ?? '').trim()) {
      setPending((states) => ({ ...states, [check.code]: outcome }))
      return
    }
    setPending((states) => {
      const next = { ...states }
      delete next[check.code]
      return next
    })
    onAnswer?.({ checkCode: check.code, sampleIndex: unit, outcome: outcome === 'none' ? null : outcome, value: extra.value !== undefined ? extra.value : (current?.value ?? null), note: outcome === 'none' ? null : note })
  }
  const onRowKey = (event: KeyboardEvent<HTMLLIElement>, check: SheetCheck) => {
    if (!editable || !recordable(check) || event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return
    const outcome: Answer | null = event.key === '1' ? 'PASS' : event.key === '2' ? 'FAIL' : event.key === '3' ? 'NOT_APPLICABLE' : null
    if (!outcome) return
    event.preventDefault()
    send(check, outcome)
  }
  return (
    <Section
      id="plan-checks"
      title={td('checks.heading', { code: value.plan.code, number: value.plan.number })}
      sub={td('checks.now', { answered: now.answered, total: now.outOf, failed: now.failed.length, critical: now.failedCritical.length > 0 ? now.failedCritical.join(', ') : td('checks.criticalNone') })}
      actions={
        <span className="fw-q-actions">
          <Button size="sm" variant="quiet" asChild>
            <Link href={`${prefix}/quality/plans/${encodeURIComponent(value.plan.planId)}`}>{td('checks.openPlan')}</Link>
          </Button>
          {units.length > 0 && (
            <Select size="sm" aria-label={td('checks.unitPick')} value={String(unit)} onChange={(event) => onUnit?.(Number(event.target.value))}>
              {units.map((entry) => (
                <option key={entry} value={entry}>
                  {td('checks.unitOf', { unit: entry, sample: value.inspection.sampleSize })}
                </option>
              ))}
            </Select>
          )}
        </span>
      }
    >
      {held && <p className="fw-q-hint">{td(held)}</p>}
      {now.mandatoryMissing.length > 0 && <p className="fw-q-hint">{td('checks.mandatoryMissing', { checks: now.mandatoryMissing.join(', ') })}</p>}
      {value.checks.length === 0 ? (
        <EmptyState title={td('checks.empty')} />
      ) : (
        <ul className="fw-qd-checks">
          {value.checks.map((check) => {
            const counts = checkCounts(check, value.inspection.sampleSize)
            const current = answerOf(check, unit)
            const answered: Answer = pending[check.code] ?? (current?.outcome ?? 'none')
            const asking = pending[check.code] !== undefined
            const canRecord = editable && recordable(check)
            const takesValue = ['COUNT', 'CHOICE', 'FREE_TEXT'].includes(check.type)
            return (
              <li key={check.id} className="fw-qd-check" tabIndex={canRecord ? 0 : -1} onKeyDown={(event) => onRowKey(event, check)} aria-label={labelIn(check, locale)}>
                <span className="fw-q-cell">
                  <span className="fw-q-cell-row">
                    <strong>{labelIn(check, locale)}</strong>
                    <ClassTag klass={check.checkClass} />
                    {check.mandatory && <Tag tone="neutral">{td('checks.mandatory')}</Tag>}
                    {check.photoRequired && <Tag tone="info">{td('checks.photoRequired')}</Tag>}
                  </span>
                  <span className="fw-q-hint">
                    <span className="fw-q-code">{check.code}</span> · {td(`checks.type.${check.type}`)} · {check.takesResult ? td('checks.counts', counts) : td('checks.instruction')}
                  </span>
                </span>
                <span className="fw-qd-answer">
                  {!check.takesResult ? null : check.onChart ? (
                    <span className="fw-q-hint">{td('checks.onChart')}</span>
                  ) : check.type === 'PHOTO' ? (
                    <span className="fw-q-hint">{td('checks.photoBench')}</span>
                  ) : canRecord ? (
                    <SegmentedControl
                      size="sm"
                      ariaLabel={td('checks.answerFor', { check: labelIn(check, locale), unit })}
                      value={answered}
                      onChange={(next) => send(check, next as Answer)}
                      options={[
                        { value: 'PASS', label: td('checks.pass') },
                        { value: 'FAIL', label: td('checks.fail') },
                        { value: 'NOT_APPLICABLE', label: td('checks.na') },
                        { value: 'none', label: td('checks.notChecked') },
                      ]}
                    />
                  ) : (
                    <Tag tone={answered === 'PASS' ? 'success' : answered === 'FAIL' ? 'danger' : 'neutral'}>{td(`checks.answer.${answered}`)}</Tag>
                  )}
                  {canRecord && takesValue && (
                    check.type === 'CHOICE' && check.choices.length > 0 ? (
                      <Select size="sm" aria-label={td('checks.valueFor', { check: labelIn(check, locale), unit })} value={current?.value ?? ''} onChange={(event) => send(check, answered === 'none' ? 'PASS' : answered, { value: event.target.value || null })}>
                        <option value="">{td('checks.noValue')}</option>
                        {check.choices.map((choice) => (
                          <option key={choice} value={choice}>
                            {choice}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Input
                        size="sm"
                        inputMode={check.type === 'COUNT' ? 'numeric' : 'text'}
                        aria-label={td('checks.valueFor', { check: labelIn(check, locale), unit })}
                        defaultValue={current?.value ?? ''}
                        key={`${check.code}:${unit}:${current?.value ?? ''}`}
                        onBlur={(event) => {
                          const text = event.target.value.trim()
                          if (text === (current?.value ?? '')) return
                          if (valueProblem(check, text)) return
                          send(check, answered === 'none' ? 'PASS' : answered, { value: text || null })
                        }}
                      />
                    )
                  )}
                  {!canRecord && current?.value && <span className="fw-q-code">{current.value}</span>}
                  {canRecord && (asking || answered === 'FAIL' || (answered === 'NOT_APPLICABLE' && check.checkClass === 'CRITICAL')) ? (
                    <Input
                      size="sm"
                      aria-label={td('checks.noteFor', { check: labelIn(check, locale), unit })}
                      placeholder={td('checks.notePlaceholder')}
                      defaultValue={current?.note ?? ''}
                      key={`${check.code}:${unit}:note:${current?.note ?? ''}`}
                      autoFocus={asking}
                      onBlur={(event) => {
                        const note = event.target.value.trim() || null
                        if (asking && note) send(check, pending[check.code]!, { note })
                        else if (!asking && note !== (current?.note ?? null) && answered !== 'none') send(check, answered, { note })
                      }}
                    />
                  ) : current?.note ? (
                    <span className="fw-q-hint">{current.note}</span>
                  ) : null}
                </span>
                <span className="fw-q-hint fw-qd-recorded" role="status">
                  {asking ? td(pending[check.code] === 'FAIL' ? 'checks.needNote' : 'checks.needReason') : current ? td('checks.recorded', { where: td(`checks.where.${current.recordedBy}`), at: formatDateTime(current.recordedAt, { locale }), photos: current.photos.length }) : null}
                  <DepthMark mark={marks[`check:${check.code}`]} />
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <p className="fw-q-hint">{td('checks.keys')}</p>
    </Section>
  )
}

/**
 * Inspection › Checks & results › Serial and batch check (design ins-identity, QHS-052 on B-W2b-97's sheet): expected against
 * scanned — "Expected 48 · scanned 47 · missing 1 · unknown 0" — the missing and unknown numbers named, the batch read once.
 * A missing or unknown number fails the lot; not done holds a pass. Scanned at the bench (the office reads it here). A W1
 * inspection has no such check.
 */
export function IdentitySection({ sheet, workOrderHref }: { sheet: Read<Sheet> | null; workOrderHref: string | null }) {
  const td = useDepthT()
  const say = useSay()
  if (!sheet) {
    return (
      <Section id="identity" title={td('identity.heading')}>
        <p className="fw-q-hint">{td('identity.w1')}</p>
      </Section>
    )
  }
  const identity = sheet.value?.identity ?? null
  if (!identity) {
    return (
      <Section id="identity" title={td('identity.heading')}>
        {sheet.problem ? <p className="fw-q-hint">{td('checks.failed')}</p> : <Skeleton width="100%" height={48} />}
      </Section>
    )
  }
  const tone = identityTone(identity)
  const list = (codes: readonly string[], total: number) => (codes.length < total ? td('identity.listMore', { list: codes.join(', '), count: total - codes.length }) : codes.join(', '))
  return (
    <Section id="identity" title={td('identity.heading')} sub={say(identityWords(identity))}>
      <Banner tone={tone === 'success' ? 'success' : tone === 'danger' ? 'danger' : 'info'} title={td(identity.ok === true ? 'identity.ok' : identity.ok === false ? 'identity.fail' : 'identity.open')}>
        {identity.mode === 'SERIAL' && identity.missingCount > 0 && <p>{td('identity.missing', { list: list(identity.missing, identity.missingCount) })}</p>}
        {identity.mode === 'SERIAL' && identity.unknown.length > 0 && <p>{td('identity.unknown', { list: identity.unknown.join(', ') })}</p>}
      </Banner>
      <p className="fw-q-hint">
        {td('identity.bench', { count: identity.scans })}{' '}
        {workOrderHref && identity.missingCount > 0 && (
          <Link className="fw-q-link" href={workOrderHref}>
            {td('identity.workOrder')}
          </Link>
        )}
      </p>
    </Section>
  )
}
