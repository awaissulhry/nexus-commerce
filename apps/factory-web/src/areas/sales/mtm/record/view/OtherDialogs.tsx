'use client'

import { useId } from 'react'
import { CalendarX2, Repeat } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Lightbox } from '@nexus/ui/patterns'
import { Button, Checkbox, Kbd, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import type { ProfileRecord } from '../../api'
import { deleteDayHeld, repeatHeld } from '../../model'
import { NoticeLine, useSubmitKey, useWords } from '../../parts'
import type { ProfileRecordActions, ProfileRecordModel } from '../view-model'

/**
 * Repeat order from the latest profile (design rider.orders.list#1, SAL-300: a unit like an earlier one — style, colourway, base
 * size — on the rider's NEWEST revision, on a new draft quote; measures older than 12 months ask "order on these measures anyway?"
 * first), the photos' deletion day (with why, logged) and a photo opened (its stripped copy, in the DS Lightbox). Fetches nothing.
 */
export function OtherDialogs({ model, record, actions }: { model: ProfileRecordModel; record: ProfileRecord; actions?: ProfileRecordActions }) {
  const dialog = model.dialog
  if (dialog?.kind === 'repeat') return <RepeatDialog model={model} record={record} dialog={dialog} actions={actions} />
  if (dialog?.kind === 'deleteDay') return <DeleteDayDialog model={model} dialog={dialog} actions={actions} />
  if (dialog?.kind === 'photo') return <PhotoDialog record={record} dialog={dialog} actions={actions} />
  return null
}

function RepeatDialog({ model, record, dialog, actions }: { model: ProfileRecordModel; record: ProfileRecord; dialog: Extract<NonNullable<ProfileRecordModel['dialog']>, { kind: 'repeat' }>; actions?: ProfileRecordActions }) {
  const { t, say, day } = useWords()
  const fromId = useId()
  const facts = dialog.facts
  const held = say(repeatHeld(facts, dialog.measuredOk, { can: model.can, offline: model.live === 'offline', companyId: model.companyId })) ?? (dialog.busy ? t('common.working') : null)
  const onKey = useSubmitKey(true, !!held, () => actions?.onRepeat?.())
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      size="md"
      title={t('repeat.title')}
      subtitle={t('repeat.sub', { rider: record.riderName, garment: record.garmentType })}
      footer={
        <span className="fw-mtm-actions">
          <Button variant="secondary" onClick={() => actions?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onRepeat?.()} aria-keyshortcuts="Meta+Enter">
            {dialog.busy ? <Spinner size={12} /> : <Repeat size={14} aria-hidden />} {t('repeat.create')} <Kbd>⌘↵</Kbd>
          </Button>
        </span>
      }
    >
      <div className="fw-mtm-stack" onKeyDown={onKey}>
        <NoticeLine notice={dialog.notice} />
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
        {!facts && !dialog.problem && (
          <p className="fw-mtm-hint" role="status">
            <Spinner size={12} /> {t('common.reading')}
          </p>
        )}
        {facts && (
          <>
            <p className="fw-mtm-hint">{t('repeat.latest', { revision: facts.latest.revision, date: day(facts.latest.takenOn), months: facts.latest.months, review: t(`review.${facts.latest.review}`) })}</p>
            {facts.latest.review !== 'CONFIRMED' && <p className="fw-mtm-hint">{t('repeat.waitsReview')}</p>}
            {facts.latest.old && (
              <Banner tone="warning" title={t('repeat.old', { months: facts.latest.months })}>
                <Checkbox checked={dialog.measuredOk} onChange={(event) => actions?.onRepeatDraft?.({ measuredOk: event.target.checked })} label={t('repeat.anyway')} />
              </Banner>
            )}
            {facts.earlier.length === 0 ? (
              <p className="fw-mtm-hint">{t('repeat.held.noEarlier')}</p>
            ) : (
              <Field label={t('repeat.from')} htmlFor={fromId} hint={t('repeat.fromHint')}>
                <Select id={fromId} size="sm" value={dialog.fromLineId} onChange={(event) => actions?.onRepeatDraft?.({ fromLineId: event.target.value })}>
                  {facts.earlier.map((unit) => (
                    <option key={unit.lineId} value={unit.lineId}>
                      {unit.number} · {unit.style.code} {unit.colourway.code} · {unit.baseSize ?? '—'} · {t('row.revisionValue', { revision: unit.revision })}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <p className="fw-mtm-hint">{t('repeat.after')}</p>
          </>
        )}
      </div>
    </Modal>
  )
}

function DeleteDayDialog({ model, dialog, actions }: { model: ProfileRecordModel; dialog: Extract<NonNullable<ProfileRecordModel['dialog']>, { kind: 'deleteDay' }>; actions?: ProfileRecordActions }) {
  const { t, say, locale } = useWords()
  const ids = { day: useId(), reason: useId() }
  const held = say(deleteDayHeld(dialog.day, dialog.reason, model.today)) ?? (dialog.busy ? t('common.working') : model.live === 'offline' ? t('held.offline') : null)
  const onKey = useSubmitKey(true, !!held, () => actions?.onDeleteDay?.())
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      size="sm"
      title={t('photos.deleteTitle', { revision: dialog.revision })}
      footer={
        <span className="fw-mtm-actions">
          <Button variant="secondary" onClick={() => actions?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" heldReason={held} onClick={() => actions?.onDeleteDay?.()} aria-keyshortcuts="Meta+Enter">
            {dialog.busy ? <Spinner size={12} /> : <CalendarX2 size={14} aria-hidden />} {t('photos.deleteSave')} <Kbd>⌘↵</Kbd>
          </Button>
        </span>
      }
    >
      <div className="fw-mtm-stack" onKeyDown={onKey}>
        <NoticeLine notice={dialog.notice} />
        <Field label={t('photos.deleteDayLabel')} required htmlFor={ids.day} hint={t('photos.deleteDayHint')}>
          <DateField id={ids.day} value={dialog.day} min={model.today} onChange={(value) => actions?.onDeleteDayDraft?.({ day: value })} locale={INTL_LOCALE[locale]} ariaLabel={t('photos.deleteDayLabel')} />
        </Field>
        <Field label={t('photos.deleteReason')} required htmlFor={ids.reason}>
          <Textarea id={ids.reason} rows={2} value={dialog.reason} onChange={(event) => actions?.onDeleteDayDraft?.({ reason: event.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}

function PhotoDialog({ record, dialog, actions }: { record: ProfileRecord; dialog: Extract<NonNullable<ProfileRecordModel['dialog']>, { kind: 'photo' }>; actions?: ProfileRecordActions }) {
  const { t } = useWords()
  if (!dialog.src)
    return (
      <Modal open onClose={() => actions?.onDialog?.(null)} size="sm" title={t(`photos.view.${dialog.view}`)}>
        {dialog.problem ? (
          <Banner tone="danger" title={t(dialog.problem)} />
        ) : (
          <p className="fw-mtm-hint" role="status">
            <Spinner size={12} /> {t('photos.opening')}
          </p>
        )}
      </Modal>
    )
  return <Lightbox open onClose={() => actions?.onDialog?.(null)} items={[{ url: dialog.src, alt: t('photos.alt', { view: t(`photos.view.${dialog.view}`), rider: record.riderName }) }]} index={0} onIndex={() => undefined} title={t(`photos.view.${dialog.view}`)} caption={t('photos.stripped')} />
}
