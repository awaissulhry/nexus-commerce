'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { History } from 'lucide-react'
import { Banner, Card, EmptyState, type TimelineStep } from '@nexus/ui/components'
import { Button, Select, Skeleton } from '@nexus/ui/primitives'
import { EDIT_KINDS, type EditKind } from '@nexus/factory-domain/production/labour/rules'
import { DateField, Timeline } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import type { LabourEdit } from '../api'
import { addressText, editReason } from '../model'
import type { LabourActions, LabourModel } from './LabourView'
import { ChangeList, dayText, useLabourT, useValueWords } from './parts'

const EDIT_TONE = { LABOUR_EDIT: 'info', SCAN_CORRECTION: 'info', ATTENDANCE_CORRECTION: 'warning', CLOCK_EDIT: 'warning' } as const

/**
 * Changes to labour records (design lb-audit, MES-204): every edit keeps before and after, who, when and why, newest first,
 * filtered by the page's line, the dates and the kind. `by` is who made the change (an office person or a team leader),
 * never whose record it is: a row says only that someone is on it. Attendance changes appear only at sites whose ATTENDANCE
 * gate is on (the API's rule) and name no line.
 */
export function EditsTimeline({ model, actions }: { model: LabourModel; actions?: LabourActions }) {
  const t = useLabourT()
  const locale = useLocale()
  const words = useValueWords(model.codes, model.timeZone)
  const edits = model.edits

  const steps = useMemo<TimelineStep[]>(
    () =>
      (edits.items ?? []).map((edit: LabourEdit) => {
        const where = edit.line ? edit.line.code : t('edits.noLine')
        const open = edit.disputeId ? `DISPUTE:${edit.disputeId}` : edit.recordType === 'OffStandardEntry' ? `OFF_STANDARD:${edit.recordId}` : null
        const href = open ? `${model.prefix}/production/labour${addressText({ ...model.address, open })}` : null
        return {
          key: edit.id,
          label: t('edits.step', { kind: t(`editKind.${edit.kind}`), where, day: dayText(edit.workDate, locale, model.timeZone) }),
          tone: EDIT_TONE[edit.kind],
          at: edit.at,
          detail: (
            <span className="fw-lb-edit">
              <ChangeList changes={edit.changes} words={words} />
              {edit.reason && <span className="fw-lb-sub">{t('edits.why', { reason: editReason(edit.reason, edit.disputeId) ?? '' })}</span>}
              <span className="fw-lb-sub">
                {edit.by ? t('edits.by', { name: edit.by.name }) : t('edits.bySystem')}
                {edit.named ? ` · ${t('edits.named')}` : ''}
              </span>
            </span>
          ),
          ...(href ? { action: <Link className="fw-lb-link" href={href}>{t('common.open')}</Link> } : {}),
        }
      }),
    [edits.items, locale, model.address, model.prefix, model.timeZone, t, words],
  )

  let body
  if (edits.problem) body = <Banner tone="danger" title={t(edits.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  else if (!edits.items) body = <Skeleton height={140} />
  else if (edits.items.length === 0) body = <EmptyState icon={<History size={22} aria-hidden />} title={t('edits.empty.title')} description={t('edits.empty.body')} />
  else body = <Timeline steps={steps} label={t('edits.title')} now={model.now} />

  return (
    <Card padded className="fw-lb-card">
      <section className="fw-lb-section" aria-label={t('edits.title')}>
        <div className="fw-lb-card-head">
          <div>
            <h2 className="fw-lb-h2">{t('edits.title')}</h2>
            <p className="fw-lb-hint">{t('edits.hint')}</p>
          </div>
          <span className="fw-lb-filters">
            <Select size="sm" aria-label={t('edits.kindLabel')} value={model.address.editKind ?? ''} onChange={(event) => actions?.onAddress?.({ editKind: (event.target.value || null) as EditKind | null })}>
              <option value="">{t('edits.kindAll')}</option>
              {EDIT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`editKind.${kind}`)}
                </option>
              ))}
            </Select>
            <span className="fw-lb-date">
              <span className="fw-lb-sub">{t('common.from')}</span>
              <DateField ariaLabel={t('common.from')} value={model.address.editFrom ?? edits.from ?? ''} onChange={(value) => actions?.onAddress?.({ editFrom: value || null })} />
            </span>
            <span className="fw-lb-date">
              <span className="fw-lb-sub">{t('common.to')}</span>
              <DateField ariaLabel={t('common.to')} value={model.address.editTo ?? edits.to ?? ''} onChange={(value) => actions?.onAddress?.({ editTo: value || null })} />
            </span>
          </span>
        </div>
        {body}
        {edits.more && (
          <div>
            <Button size="sm" onClick={() => actions?.onMoreEdits?.()} heldReason={edits.limitReached ? t('held.tooMany') : null}>
              {t('common.more')}
            </Button>
          </div>
        )}
      </section>
    </Card>
  )
}
