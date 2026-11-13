'use client'

import { useId } from 'react'
import Link from 'next/link'
import { ArrowLeftRight, Check, MessageSquareWarning, PencilRuler, Send } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Listbox } from '@nexus/ui/components'
import { Button, InfoTip, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { CheckList, Section, type CheckLine } from '../../../../quality/_shared/parts'
import { Timeline } from '../../../../../lib/i18n/ds-parts'
import type { ProfileRecord, Revision } from '../../api'
import { basicLines, beyondPoints, brokenRules, formPoints, measureLines, rangeVerdict, reviewDraftFor, reviewHeld, rightHeld, ruleWords, styleFindingsOf, templatesHref, type Phrase } from '../../model'
import { ReviewPill, useWords } from '../../parts'
import type { ProfileRecordActions, ProfileRecordModel } from '../view-model'

/**
 * The rider profile's Measurements tab (design rider.measurements): the revision read (a Listbox of every revision; Compare two;
 * New revision — the old one stays, orders keep theirs; Send a measurement link), its values against the template's points (the
 * plausible range, the points kept outside it because the measurer checked them, how to measure each), the basics, the base
 * size, fit notes and the internal note, who measured, where and when, the privacy notice given; the Factory review (SAL-292:
 * state, who, when, the words; Confirm · Ask for more, held with why); the Certified range check per MTM style (PRD-288:
 * inside or outside, the base size suggested, the impossible ratios flagged, the points that fall out and by how much).
 */
export function MeasurementsTab({ model, record, actions }: { model: ProfileRecordModel; record: ProfileRecord; actions?: ProfileRecordActions }) {
  const { t, say, day, when } = useWords()
  const listId = useId()
  const offline = model.live === 'offline'
  const shown: Revision | undefined = record.revisions.find((revision) => revision.id === model.revisionId) ?? record.revisions[0]
  if (!shown)
    return (
      <Card padded>
        <EmptyState title={t('meas.none')} />
      </Card>
    )
  const points = formPoints(record.template?.points)
  const lines = measureLines(shown, points)
  const basics = basicLines(shown)
  const isLatest = shown.id === record.latestId
  const recordHeld: Phrase | null = !record.may.record ? rightHeld('record') : offline ? { key: 'held.offline' } : null
  const linkHeld: Phrase | null = !model.can.link ? rightHeld('link') : offline ? { key: 'held.offline' } : null

  return (
    <div className="fw-mtm-stack">
      <div className="fw-mtm-head">
        <div className="fw-mtm-row">
          <Listbox
            id={listId}
            size="sm"
            ariaLabel={t('meas.revisionPick')}
            value={shown.id}
            onChange={(value) => actions?.onRevision?.(value)}
            options={record.revisions.map((revision) => ({ value: revision.id, label: t('meas.revisionOption', { revision: revision.revision, date: day(revision.takenAt), review: t(`review.${revision.review.status}`) }) }))}
          />
          {!isLatest && <Tag tone="warning">{t('meas.older', { revision: record.revisions[0]?.revision ?? 0 })}</Tag>}
        </div>
        <div className="fw-mtm-actions">
          <Button size="sm" variant="secondary" heldReason={record.revisions.length < 2 ? t('meas.compareHeld') : null} onClick={() => actions?.onDialog?.({ kind: 'compare', beforeId: record.revisions[1]?.id ?? shown.id, afterId: record.revisions[0]?.id ?? shown.id })}>
            <ArrowLeftRight size={14} aria-hidden /> {t('meas.compare')}
          </Button>
          <Button size="sm" variant="secondary" heldReason={say(linkHeld)} onClick={() => actions?.onOpenLink?.()}>
            <Send size={14} aria-hidden /> {t('band.link')}
          </Button>
          <Button size="sm" variant="secondary" heldReason={say(recordHeld)} onClick={() => actions?.onNewRevision?.()}>
            <PencilRuler size={14} aria-hidden /> {t('band.newRevision')}
          </Button>
        </div>
      </div>
      <div className="fw-mtm-two">
        <div className="fw-mtm-stack">
          <Section id="mtm-measures" title={t('meas.title', { revision: shown.revision })} sub={shown.byLink ? t('meas.byLink', { when: when(shown.submittedAt) }) : t('meas.byOffice')}>
            {!record.may.record && <p className="fw-mtm-hint">{t('meas.viewOnly')}</p>}
            {record.template ? null : <Banner tone="warning" title={t('off.noTemplate')} />}
            {lines.length === 0 ? (
              <p className="fw-mtm-hint">{t('form.noPoints')}</p>
            ) : (
              <dl className="fw-mtm-measures">
                {lines.map((line) => (
                  <div key={line.code} className="fw-mtm-measure">
                    <dt>
                      {line.name}
                      {line.howTo && <InfoTip tip={line.howTo} />}
                    </dt>
                    <dd>
                      {line.value ? `${line.value} ${line.unit}` : '—'}
                      {line.outside && <Tag tone="warning">{t('meas.outsideChecked')}</Tag>}
                      {line.range && <span className="fw-mtm-hint">{line.range}</span>}
                    </dd>
                  </div>
                ))}
                {basics.map((basic) => (
                  <div key={basic.code} className="fw-mtm-measure">
                    <dt>{t(`form.basic.${basic.code}`)}</dt>
                    <dd>{basic.value ? `${basic.value} ${basic.unit}` : '—'}</dd>
                  </div>
                ))}
              </dl>
            )}
            <dl className="fw-mtm-measures">
              <div className="fw-mtm-measure">
                <dt>{t('meas.baseSize')}</dt>
                <dd>{shown.baseSize ?? '—'}</dd>
              </div>
              <div className="fw-mtm-measure">
                <dt>{t('meas.measuredBy')}</dt>
                <dd>{shown.measuredBy?.name ?? shown.takenBy}</dd>
              </div>
              <div className="fw-mtm-measure">
                <dt>{t('meas.where')}</dt>
                <dd>{shown.measuredPlace ?? '—'}</dd>
              </div>
              <div className="fw-mtm-measure">
                <dt>{t('meas.when')}</dt>
                <dd>{when(shown.takenAt)}</dd>
              </div>
              <div className="fw-mtm-measure">
                <dt>{t('meas.notice')}</dt>
                <dd>{t('meas.noticeValue', { notice: shown.privacyNoticeRef, when: when(shown.privacyNoticeAt) })}</dd>
              </div>
              <div className="fw-mtm-measure">
                <dt>{t('meas.photos')}</dt>
                <dd>{shown.photos > 0 ? t('meas.photosCount', { count: shown.photos }) : t('meas.photosNone')}</dd>
              </div>
            </dl>
            <div className="fw-mtm-tight">
              <h3 className="fw-mtm-h3">{t('meas.fitNotes')}</h3>
              <p className="fw-mtm-text">{shown.fitNotes ?? '—'}</p>
            </div>
            <div className="fw-mtm-tight">
              <h3 className="fw-mtm-h3">{t('meas.internal')}</h3>
              <p className="fw-mtm-text">{shown.internalNote ?? '—'}</p>
            </div>
            {shown.old && <Banner tone="warning" title={t('meas.old')} />}
          </Section>
        </div>
        <div className="fw-mtm-stack">
          <ReviewPanel model={model} record={record} actions={actions} />
          <RangePanel model={model} record={record} actions={actions} />
        </div>
      </div>
    </div>
  )
}

function ReviewPanel({ model, record, actions }: { model: ProfileRecordModel; record: ProfileRecord; actions?: ProfileRecordActions }) {
  const { t, say, when } = useWords()
  const latest = record.revisions[0]!
  const offline = model.live === 'offline'
  const confirmHeld = reviewHeld(record, 'CONFIRM', model.me, model.can, offline)
  const askHeld = reviewHeld(record, 'NEED_MORE', model.me, model.can, offline)
  const open = (decision: 'CONFIRM' | 'NEED_MORE') => actions?.onDialog?.({ kind: 'review', draft: reviewDraftFor(decision, record.review.mailTo), check: null, checking: false, busy: false, notice: null })
  const history = record.revisions.filter((revision) => revision.review.status !== 'WAITING' && revision.review.at)
  return (
    <Section
      id="mtm-review"
      title={t('reviewPanel.title')}
      sub={t('reviewPanel.sub')}
      actions={
        latest.review.status === 'CONFIRMED' ? undefined : (
          <>
            <Button size="sm" variant="secondary" heldReason={say(askHeld)} onClick={() => open('NEED_MORE')}>
              <MessageSquareWarning size={14} aria-hidden /> {t('reviewPanel.askMore')}
            </Button>
            <Button size="sm" variant="primary" heldReason={say(confirmHeld)} onClick={() => open('CONFIRM')}>
              <Check size={14} aria-hidden /> {t('reviewPanel.confirm')}
            </Button>
          </>
        )
      }
    >
      <p className="fw-mtm-row">
        <ReviewPill status={latest.review.status} />
        <span className="fw-mtm-hint">
          {latest.review.status === 'WAITING' ? t('reviewPanel.notYet', { revision: latest.revision }) : t('reviewPanel.by', { revision: latest.revision, name: latest.review.by?.name ?? '—', when: when(latest.review.at) })}
        </span>
      </p>
      {latest.review.note && <p className="fw-mtm-text">{latest.review.note}</p>}
      {latest.review.status === 'WAITING' && record.review.outside.length > 0 && <p className="fw-mtm-hint">{t('reviewPanel.outside', { count: record.review.outside.length })}</p>}
      {latest.review.status !== 'CONFIRMED' && !record.review.mailTo && <p className="fw-mtm-hint">{t('reviewPanel.noAddress')}</p>}
      {history.length > 0 && (
        <Timeline
          label={t('reviewPanel.history')}
          steps={history.map((revision) => ({
            key: revision.id,
            label: t(revision.review.status === 'CONFIRMED' ? 'activity.confirmed' : 'activity.needMore', { revision: revision.revision, by: revision.review.by?.name ?? '' }),
            tone: revision.review.status === 'CONFIRMED' ? 'success' : 'warning',
            at: revision.review.at,
            detail: revision.review.note ?? undefined,
          }))}
        />
      )}
    </Section>
  )
}

function RangePanel({ model, record, actions }: { model: ProfileRecordModel; record: ProfileRecord; actions?: ProfileRecordActions }) {
  const { t, say, locale } = useWords()
  const ids = { style: useId(), colourway: useId() }
  const range = model.range
  const check = range.check
  const broken = brokenRules(check)
  const beyond = beyondPoints(check)
  const checks: CheckLine[] = []
  if (check && check.rulesOn) {
    for (const finding of styleFindingsOf(check)) checks.push({ id: `style-${finding.key}`, state: 'OPEN', text: say(finding) ?? '' })
    checks.push({ id: 'base', state: check.baseSize.size ? 'OK' : 'UNKNOWN', name: t('range.baseSize'), text: check.baseSize.size ? t(check.baseSize.how === 'INSIDE' ? 'range.baseInside' : 'range.baseNearest', { size: check.baseSize.size }) : t('range.baseNone') })
    checks.push({ id: 'rules', state: broken.length === 0 ? 'OK' : broken.some((rule) => rule.severity === 'BLOCK') ? 'OPEN' : 'WARNING', name: t('range.ratios'), text: broken.length === 0 ? t('range.ratiosOk') : broken.map((rule) => ruleWords(rule.words, locale, rule.code)).join(' · ') })
    checks.push({
      id: 'alterations',
      state: beyond.length === 0 ? 'OK' : 'OPEN',
      name: t('range.alterations'),
      text: beyond.length === 0 ? t('range.alterationsOk') : beyond.map((entry) => t('range.beyond', { point: points(record, entry.code), difference: entry.difference ?? '—', unit: entry.uom.toLowerCase() })).join(' · '),
    })
    if (check.certificate) checks.push({ id: 'certificate', state: check.certificate.allowed ? 'OK' : 'OPEN', name: t('range.certificate'), text: check.certificate.allowed ? t('range.certificateOk', { number: check.certificate.certificateNumber ?? '—' }) : t('range.certificateNo', { count: check.certificate.reasons.length, points: [...new Set(check.certificate.reasons.flatMap((reason) => (reason.point ? [points(record, reason.point)] : [])))].join(', ') || '—' }) })
  }
  return (
    <Section id="mtm-range" title={t('range.title')} sub={t('range.sub')}>
      {!model.can.styles ? (
        <p className="fw-mtm-hint">{say(rightHeld('styles'))}</p>
      ) : range.styles.items !== null && range.styles.items.length === 0 ? (
        <EmptyState title={t('range.noStyles')} description={t('range.noStylesBody')} />
      ) : (
        <div className="fw-mtm-stack">
          <div className="fw-mtm-fields">
            <Field label={t('range.style')} htmlFor={ids.style}>
              <Select id={ids.style} size="sm" value={range.styleId} onChange={(event) => actions?.onRangeStyle?.(event.target.value)}>
                <option value="">{range.styles.items === null ? t('common.reading') : t('range.stylePick', { count: range.styles.items.length })}</option>
                {(range.styles.items ?? []).map((style) => (
                  <option key={style.id} value={style.id}>
                    {style.code} · {style.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('range.colourway')} htmlFor={ids.colourway}>
              <Select id={ids.colourway} size="sm" disabled={!range.style} value={range.colourwayId} onChange={(event) => actions?.onRangeColourway?.(event.target.value)}>
                <option value="">{t('range.colourwayPick')}</option>
                {(range.style?.colourways ?? [])
                  .filter((colourway) => colourway.status === 'ACTIVE')
                  .map((colourway) => (
                    <option key={colourway.id} value={colourway.id}>
                      {colourway.code} · {colourway.name}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
          {range.problem && <Banner tone="danger" title={t(range.problem)} />}
          {range.checking && (
            <p className="fw-mtm-hint" role="status">
              <Spinner size={12} /> {t('range.checking')}
            </p>
          )}
          {check && !range.checking && (
            <>
              <p className="fw-mtm-row">
                <Tag tone={!check.rulesOn ? 'neutral' : check.insideCertifiedRange === true ? 'success' : check.insideCertifiedRange === false ? 'danger' : 'warning'}>{say(rangeVerdict(check))}</Tag>
              </p>
              {!check.rulesOn ? (
                <p className="fw-mtm-hint">
                  {t('range.offBody')}{' '}
                  <Link className="fw-mtm-link" href={templatesHref(model.prefix)}>
                    {t('off.where')}
                  </Link>
                </p>
              ) : (
                <CheckList label={t('range.title')} checks={checks} />
              )}
              {check.rulesOn && check.insideCertifiedRange === false && <p className="fw-mtm-hint">{t('range.outsideMeans')}</p>}
            </>
          )}
          {!check && !range.checking && range.styleId === '' && <p className="fw-mtm-hint">{t('range.pickFirst')}</p>}
        </div>
      )}
    </Section>
  )
}

const points = (record: ProfileRecord, code: string): string => record.template?.points.find((point) => point.code === code)?.name ?? code
