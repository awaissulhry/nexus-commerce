'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { Camera, Trash2 } from 'lucide-react'
import { Banner, Field, Modal } from '@nexus/ui/components'
import { PhotoCapture } from '@nexus/ui/components/PhotoCapture/index'
import { Button, Checkbox, Input, Select, Spinner, Textarea } from '@nexus/ui/primitives'
import { usePhotoWords } from '../../../../lib/ds-words/photo-capture'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { money, quantity, unitTotals } from '../../../_shared/stock/model'
import { useUnitWord } from '../../../_shared/stock/parts'
import type { WriteOffActions, WriteOffDialogModel } from './dialog-model'
import { DAILY_NAMESPACE, NCR_SEVERITIES, reasonLabel, valueLeaving, writeOffHeld } from './model'
import { DailyMessages, useSay } from './parts'

/**
 * Write off (design warehouse.moves pop:mv-writeoff) and Scrap N hides (warehouse.hides pop:hd-scrap) — ONE dialog: what
 * leaves the stock (one stock key at one place with its quantity, or hides whole), the reason of the tenant's WRITE_OFF
 * list (a reason that needs detail needs the note), the note and a reference, a photo (taken or chosen; sent once the
 * write-off is posted, its record being the write-off), "Open a nonconformance" (from the lot or the hide), and with the
 * cost grain the value leaving stock. Held stock (a quality hold) and reserved hides hold the button with the reason;
 * the API refuses them too, in our words. After posting it says what happened: the moves, the value, the photo and the
 * NCR (each with Try again when it failed: the write-off itself stands). No "scrap location": a SCRAP leaves the site.
 */
export function WriteOffDialog({ model, actions }: { model: WriteOffDialogModel; actions?: WriteOffActions }) {
  return (
    <DailyMessages>
      <Dialog model={model} actions={actions} />
    </DailyMessages>
  )
}

function Dialog({ model, actions }: { model: WriteOffDialogModel; actions?: WriteOffActions }) {
  const t = useT(DAILY_NAMESPACE)
  const s = useT('stock')
  const say = useSay()
  const locale = useLocale()
  const unitWord = useUnitWord()
  const photoWords = usePhotoWords()
  const { target, draft } = model
  const reasons = model.reasons.value ?? []
  const latest = useRef(actions)
  latest.current = actions
  const set = (patch: Partial<typeof draft>) => latest.current?.onChange?.({ ...draft, ...patch })
  const heldPhrase = model.reasons.value === null ? { key: model.reasons.problem ? 'wo.reasonsFailed' : 'wo.reasonsLoading' } : writeOffHeld(target, draft, reasons, model.posting)
  const held = heldPhrase ? say(heldPhrase) : null

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held && !model.done) {
        event.preventDefault()
        latest.current?.onPost?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [held, model.done])

  const hides = target.kind === 'hides' ? target.hides : []
  const title = target.kind === 'hides' ? t('wo.titleHides', { count: hides.length }) : t('wo.title')
  const unit = target.kind === 'quantity' ? unitWord(target.item.baseUom) : ''
  const leaving =
    target.kind === 'hides'
      ? unitTotals(
          hides.map((hide) => ({ uom: hide.uom, quantity: hide.area })),
          unitWord,
          locale,
        )
      : draft.quantity.trim()
        ? `${quantity(draft.quantity.replace(',', '.'), locale)} ${unit}`
        : '—'
  const value = model.withCost ? valueLeaving(target, draft) : null
  const reason = reasons.find((entry) => entry.code === draft.reasonCode)
  const close = () => actions?.onClose?.()

  if (model.done) {
    const done = model.done
    const ncrHref = done.ncr?.id ? `${model.prefix}${recordAddress({ type: 'Nonconformance', id: done.ncr.id }, OFFICE_PAGES)}` : null
    return (
      <Modal
        open
        onClose={close}
        size="md"
        title={t('wo.done.title')}
        subtitle={title}
        footer={
          <Button size="sm" variant="primary" onClick={close}>
            {t('wo.close')}
          </Button>
        }
      >
        <div className="fw-dy-form" role="status">
          <Banner tone="success" title={t('wo.done.moves', { count: done.moves })} />
          {model.withCost && done.value && <p className="fw-dy-strong">{t('wo.done.value', { value: money(done.value.amount, done.value.currency, locale) })}</p>}
          {done.photo && (
            <p className="fw-dy-row">
              {done.photo === 'sending' && <Spinner size={12} />}
              <span>{t(done.photo === 'sending' ? 'wo.done.photoSending' : done.photo === 'sent' ? 'wo.done.photoSent' : 'wo.done.photoFailed')}</span>
              {done.photo === 'failed' && (
                <Button size="sm" onClick={() => actions?.onRetryPhoto?.()}>
                  {t('wo.done.photoRetry')}
                </Button>
              )}
            </p>
          )}
          {done.ncr && (
            <p className="fw-dy-row">
              {done.ncr.state === 'sending' && <Spinner size={12} />}
              <span>
                {done.ncr.state === 'sending'
                  ? t('wo.done.ncrOpening')
                  : done.ncr.state === 'failed'
                    ? t('wo.done.ncrFailed')
                    : done.ncr.number
                      ? t('wo.done.ncrOpened', { number: done.ncr.number })
                      : t('wo.done.ncrOpenedNoNumber')}
              </span>
              {done.ncr.state === 'sent' && ncrHref && (
                <Button size="sm" asChild>
                  <Link href={ncrHref}>{t('wo.done.ncrOpen')}</Link>
                </Button>
              )}
              {done.ncr.state === 'failed' && (
                <Button size="sm" onClick={() => actions?.onRetryNcr?.()}>
                  {t('wo.done.ncrRetry')}
                </Button>
              )}
            </p>
          )}
          {done.overReserved > 0 && <Banner tone="warning" title={t('wo.done.overReserved', { count: done.overReserved })} />}
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={title}
      subtitle={target.kind === 'quantity' ? t('wo.what', { material: `${target.item.code} · ${target.item.name}${target.lot ? ` · ${target.lot.code}` : ''}`, place: target.location.code, quantity: quantity(target.onHand, locale), unit }) : undefined}
      footer={
        <>
          <span className="fw-dy-hint">{t('wo.keys')}</span>
          <span className="grow" />
          <Button size="sm" onClick={close}>
            {s('common.cancel')}
          </Button>
          <Button size="sm" variant="danger" heldReason={held} onClick={() => actions?.onPost?.()} aria-keyshortcuts="Meta+Enter">
            {model.posting ? <Spinner size={12} /> : <Trash2 size={13} aria-hidden />} {target.kind === 'hides' ? t('wo.goHides', { count: hides.length }) : t('wo.go')}
          </Button>
        </>
      }
    >
      <div className="fw-dy-form">
        {model.problem && <Banner tone="danger" title={say(model.problem)} />}
        {model.reasons.problem && <Banner tone="danger" title={t('wo.reasonsFailed')} />}
        <p className="fw-dy-hint">{target.kind === 'hides' ? t('wo.introHides') : t('wo.intro')}</p>
        {target.kind === 'hides' ? (
          <Field label={t('wo.hides')}>
            <ul className="fw-dy-list">
              {hides.map((hide) => (
                <li key={hide.id}>
                  <span className="fw-dy-code">{hide.code}</span>
                  <span className="fw-st-num">{`${quantity(hide.area, locale)} ${unitWord(hide.uom)}`}</span>
                  {hide.hold && <span className="fw-dy-out">{t('wo.held.onHold', { code: hide.code })}</span>}
                  {!hide.hold && hide.reservedFor && <span className="fw-dy-out">{t('wo.held.reserved', { code: hide.code, demand: hide.reservedFor })}</span>}
                </li>
              ))}
            </ul>
          </Field>
        ) : (
          <Field label={t('wo.quantity', { unit })} required>
            <Input inputMode="decimal" value={draft.quantity} onChange={(event) => set({ quantity: event.target.value })} suffix={unit} autoFocus />
          </Field>
        )}
        <Field label={t('wo.reason')} required>
          <Select value={draft.reasonCode} onChange={(event) => set({ reasonCode: event.target.value })} disabled={model.reasons.value === null}>
            <option value="">{model.reasons.value === null ? t('wo.reasonsLoading') : t('wo.reasonPick')}</option>
            {reasons.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {reasonLabel(reasons, entry.code, locale)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('wo.note')} required={!!reason?.needsDetail} hint={t('wo.noteHint')}>
          <Textarea value={draft.note} onChange={(event) => set({ note: event.target.value })} limit={500} rows={3} />
        </Field>
        <Field label={t('wo.reference')} hint={t('wo.referenceHint')}>
          <Input value={draft.reference} onChange={(event) => set({ reference: event.target.value })} maxLength={120} />
        </Field>
        <Field label={t('wo.photo')} hint={model.canPhoto ? t('wo.photoHint') : t('wo.photoNoRight')}>
          {draft.photo ? (
            <span className="fw-dy-photo">
              <Camera size={14} aria-hidden /> <span>{t('wo.photoReady', { width: draft.photo.width, height: draft.photo.height })}</span>
              <Button size="sm" variant="quiet" onClick={() => set({ photo: null })}>
                {t('wo.photoRemove')}
              </Button>
            </span>
          ) : draft.photoStep ? (
            <PhotoCapture label={t('wo.photoLabel')} words={photoWords} markup facesHint onCapture={(photo) => set({ photo, photoStep: false })} onCancel={() => set({ photoStep: false })} />
          ) : (
            <span className="fw-dy-photo">
              <Button size="sm" heldReason={model.canPhoto ? null : t('wo.photoNoRight')} onClick={() => set({ photoStep: true })}>
                <Camera size={13} aria-hidden /> {t('wo.photoAdd')}
              </Button>
            </span>
          )}
        </Field>
        {model.canNcr ? (
          <Checkbox checked={draft.openNcr} onChange={(event) => set({ openNcr: event.target.checked })} label={t('wo.ncr')} />
        ) : null}
        {model.canNcr && <p className="fw-dy-hint">{t('wo.ncrHint')}</p>}
        {model.canNcr && draft.openNcr && (
          <Field label={t('wo.severity')} required>
            <Select value={draft.ncrSeverity} onChange={(event) => set({ ncrSeverity: event.target.value as typeof draft.ncrSeverity })}>
              <option value="">{t('wo.severityPick')}</option>
              {NCR_SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  {t(`wo.severities.${severity}`)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <p className="fw-dy-strong" role="status">
          {t('wo.leaving', { stock: leaving })}
        </p>
        {model.withCost && <p className="fw-dy-hint">{value ? t('wo.value', { value: money(value.amount, value.currency, locale) }) : t('wo.valueUnknown')}</p>}
      </div>
    </Modal>
  )
}
