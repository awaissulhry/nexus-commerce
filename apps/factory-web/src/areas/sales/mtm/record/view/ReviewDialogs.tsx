'use client'

import { useId } from 'react'
import { Check, MessageSquareWarning } from 'lucide-react'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Kbd, SegmentedControl, Select, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { CheckList, type CheckLine } from '../../../../quality/_shared/parts'
import type { ProfileRecord } from '../../api'
import { brokenRules, compareLines, formPoints, rangeText, reviewDraftHeld, reviewHeld, ruleWords } from '../../model'
import { useSubmitKey, useWords } from '../../parts'
import type { ProfileRecordActions, ProfileRecordModel } from '../view-model'

/**
 * Review measurements (design pop:mtm.review, SAL-292) and Compare revisions (pop:mtm.compare): the review shows the points the
 * plausibility checks flag (values kept outside their range because the measurer checked them; the template's rules the measures
 * break, in the rules' own words — only while made-to-measure has started for the template), the design notes, and the decision:
 * Confirm (the waiting orders made to it go on) or Ask for more (the words are mailed to the rider or dealer when an address is
 * known). Nobody confirms measures they took themselves. The compare puts two revisions side by side per point, the differences
 * toned. ⌘↵ decides; Esc closes. Fetches nothing.
 */
export function ReviewDialogs({ model, record, actions }: { model: ProfileRecordModel; record: ProfileRecord; actions?: ProfileRecordActions }) {
  const dialog = model.dialog
  if (dialog?.kind === 'review') return <ReviewDialog model={model} record={record} dialog={dialog} actions={actions} />
  if (dialog?.kind === 'compare') return <CompareDialog record={record} dialog={dialog} actions={actions} />
  return null
}

function ReviewDialog({ model, record, dialog, actions }: { model: ProfileRecordModel; record: ProfileRecord; dialog: Extract<NonNullable<ProfileRecordModel['dialog']>, { kind: 'review' }>; actions?: ProfileRecordActions }) {
  const { t, say, locale } = useWords()
  const noteId = useId()
  const latest = record.revisions[0]!
  const points = formPoints(record.template?.points)
  const offline = model.live === 'offline'
  const decisionHeld = reviewHeld(record, dialog.draft.decision, model.me, model.can, offline)
  const draftHeld = reviewDraftHeld(dialog.draft)
  const held = say(decisionHeld) ?? say(draftHeld) ?? (dialog.busy ? t('common.working') : null)
  const onKey = useSubmitKey(true, !!held, () => actions?.onReview?.())
  const checks: CheckLine[] = record.review.outside.map((code) => {
    const point = points.find((entry) => entry.code === code)
    const value = latest.measurements[code]
    return { id: `out-${code}`, state: 'WARNING', name: point?.name ?? code, text: t('review.outsideLine', { value: value ? `${value.value} ${value.unit}` : '—', range: point ? (rangeText(point) ?? '—') : '—' }) }
  })
  const broken = brokenRules(dialog.check)
  for (const rule of broken) checks.push({ id: `rule-${rule.code}`, state: rule.severity === 'BLOCK' ? 'OPEN' : 'WARNING', name: rule.code, text: ruleWords(rule.words, locale, rule.code) })
  const rulesOn = record.template?.rulesOn ?? false
  if (checks.length === 0) checks.push({ id: 'none', state: rulesOn ? 'OK' : 'NOT_NEEDED', text: rulesOn ? t('review.nothingFlagged') : t('review.rulesOff', { template: record.template?.code ?? record.garmentType }) })
  const confirming = dialog.draft.decision === 'CONFIRM'
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      size="lg"
      title={t('review.title', { revision: latest.revision })}
      subtitle={t('review.sub', { rider: record.riderName, garment: record.garmentType, by: latest.measuredBy?.name ?? latest.takenBy })}
      footer={
        <span className="fw-mtm-actions">
          <Button variant="secondary" onClick={() => actions?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button variant={confirming ? 'primary' : 'warning'} heldReason={held} onClick={() => actions?.onReview?.()} aria-keyshortcuts="Meta+Enter">
            {dialog.busy ? <Spinner size={12} /> : confirming ? <Check size={14} aria-hidden /> : <MessageSquareWarning size={14} aria-hidden />} {confirming ? t('review.confirm') : t('review.send')} <Kbd>⌘↵</Kbd>
          </Button>
        </span>
      }
    >
      <div className="fw-mtm-stack" onKeyDown={onKey}>
        {dialog.notice && <Banner tone={dialog.notice.tone} title={say(dialog.notice)} />}
        <section className="fw-mtm-tight" aria-label={t('review.flagged')}>
          <h3 className="fw-mtm-h3">{t('review.flagged')}</h3>
          {dialog.checking ? (
            <p className="fw-mtm-hint" role="status">
              <Spinner size={12} /> {t('range.checking')}
            </p>
          ) : (
            <CheckList label={t('review.flagged')} checks={checks} />
          )}
        </section>
        <Field label={t('review.decision')}>
          <SegmentedControl
            ariaLabel={t('review.decision')}
            size="sm"
            value={dialog.draft.decision}
            onChange={(value) => actions?.onReviewDraft?.({ decision: value === 'NEED_MORE' ? 'NEED_MORE' : 'CONFIRM' })}
            options={[
              { value: 'CONFIRM', label: t('reviewPanel.confirm') },
              { value: 'NEED_MORE', label: t('reviewPanel.askMore') },
            ]}
          />
        </Field>
        {decisionHeld && <p className="fw-mtm-hint">{say(decisionHeld)}</p>}
        <Field label={confirming ? t('review.notes') : t('review.message')} required={!confirming} htmlFor={noteId} hint={confirming ? t('review.notesHint') : t('review.messageHint')} error={dialog.draft.decision === 'NEED_MORE' && draftHeld ? (say(draftHeld) ?? undefined) : undefined}>
          <Textarea id={noteId} rows={4} value={dialog.draft.note} onChange={(event) => actions?.onReviewDraft?.({ note: event.target.value })} />
        </Field>
        {!confirming && (
          <div className="fw-mtm-tight">
            <Checkbox checked={dialog.draft.notify && record.review.mailTo} disabled={!record.review.mailTo} onChange={(event) => actions?.onReviewDraft?.({ notify: event.target.checked })} label={t('review.notify')} />
            <p className="fw-mtm-hint">{record.review.mailTo ? t('review.notifyHint') : t('review.noAddress')}</p>
          </div>
        )}
        {confirming && <p className="fw-mtm-hint">{t('review.confirmMeans')}</p>}
      </div>
    </Modal>
  )
}

function CompareDialog({ record, dialog, actions }: { record: ProfileRecord; dialog: Extract<NonNullable<ProfileRecordModel['dialog']>, { kind: 'compare' }>; actions?: ProfileRecordActions }) {
  const { t, day } = useWords()
  const ids = { before: useId(), after: useId() }
  const before = record.revisions.find((revision) => revision.id === dialog.beforeId) ?? record.revisions[1] ?? record.revisions[0]!
  const after = record.revisions.find((revision) => revision.id === dialog.afterId) ?? record.revisions[0]!
  const lines = compareLines(before, after, formPoints(record.template?.points))
  const option = (revision: (typeof record.revisions)[number]) => (
    <option key={revision.id} value={revision.id}>
      {t('meas.revisionOption', { revision: revision.revision, date: day(revision.takenAt), review: t(`review.${revision.review.status}`) })}
    </option>
  )
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      size="lg"
      title={t('compare.title')}
      subtitle={t('compare.sub', { changed: lines.filter((line) => line.changed).length, total: lines.length })}
      footer={
        <Button variant="primary" onClick={() => actions?.onDialog?.(null)}>
          {t('common.close')}
        </Button>
      }
    >
      <div className="fw-mtm-stack">
        <div className="fw-mtm-fields">
          <Field label={t('compare.before')} htmlFor={ids.before}>
            <Select id={ids.before} size="sm" value={before.id} onChange={(event) => actions?.onCompare?.({ beforeId: event.target.value })}>
              {record.revisions.map(option)}
            </Select>
          </Field>
          <Field label={t('compare.after')} htmlFor={ids.after}>
            <Select id={ids.after} size="sm" value={after.id} onChange={(event) => actions?.onCompare?.({ afterId: event.target.value })}>
              {record.revisions.map(option)}
            </Select>
          </Field>
        </div>
        <SummaryTable
          label={t('compare.title')}
          stackOnPhone
          columns={[t('compare.point'), t('compare.revision', { revision: before.revision }), t('compare.revision', { revision: after.revision }), t('compare.difference')]}
          widths={['34%', '22%', '22%', undefined]}
          rows={lines.map((line) => ({
            id: line.code,
            cells: [
              line.code === 'height' || line.code === 'weight' ? t(`form.basic.${line.code}`) : line.name,
              line.before ? `${line.before} ${line.unit}` : '—',
              line.after ? `${line.after} ${line.unit}` : '—',
              <span key="d" className={line.difference?.startsWith('+') ? 'fw-mtm-diff-up' : line.difference?.startsWith('−') ? 'fw-mtm-diff-down' : undefined}>
                {line.difference ? `${line.difference} ${line.unit}` : line.changed ? t('compare.onlyOne') : t('compare.same')}
              </span>,
            ],
          }))}
        />
      </div>
    </Modal>
  )
}
