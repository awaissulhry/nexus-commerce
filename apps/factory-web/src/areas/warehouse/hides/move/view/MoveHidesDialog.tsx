'use client'

import { ArrowRightLeft } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../../lib/i18n/provider'
import { quantity } from '../../../../_shared/stock/model'
import { HidesMessages, useHideWords } from '../../words'
import { movable, moveHeldKey, type MoveDialogActions, type MoveDialogModel } from '../move-model'
import '../../find/find.css'

export type { MoveDialogActions, MoveDialogModel } from '../move-model'

/**
 * Move N hides (B-W2b-131; design warehouse.hides hd-grid selection row "Move…", W2b): the hides chosen — each with where it
 * lies and what moves, or left out with why (nothing at a place of the site, used up, no place) —, the place to move them
 * to (the site's active places), a note, then "Move N hides": one transfer per hide; once sent, each hide says moved or
 * why it was refused (the others still went). Esc closes.
 */
export function MoveHidesDialog({ model, actions }: { model: MoveDialogModel; actions?: MoveDialogActions }) {
  return (
    <HidesMessages>
      <Dialog model={model} actions={actions} />
    </HidesMessages>
  )
}

function Dialog({ model, actions }: { model: MoveDialogModel; actions?: MoveDialogActions }) {
  const t = useHideWords()
  const locale = useLocale()
  const say = (phrase: { key: string; params?: Readonly<Record<string, string | number>> }) => t(phrase.key, phrase.params)
  const going = movable(model)
  const held = moveHeldKey(model)
  const close = () => actions?.onClose?.()
  const target = model.places.value?.find((place) => place.id === model.toLocationId) ?? null
  const moved = model.results ? Object.values(model.results).filter((result) => result.moved).length : 0
  const refused = model.results ? Object.values(model.results).filter((result) => !result.moved).length : 0

  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={t('move.title', { count: model.hides.length })}
      footer={
        model.results ? (
          <Button size="sm" variant="primary" onClick={close}>
            {t('find.close')}
          </Button>
        ) : (
          <>
            <Button size="sm" onClick={close}>
              {t('stock:common.cancel')}
            </Button>
            <Button size="sm" variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onMove?.()}>
              {model.posting ? <Spinner size={12} /> : <ArrowRightLeft size={13} aria-hidden />} {t('move.go', { count: going.length })}
            </Button>
          </>
        )
      }
    >
      <div className="fw-hd-find">
        {model.problem && <Banner tone="danger" title={say(model.problem)} />}
        {model.results && <Banner tone={refused > 0 ? 'warning' : 'success'} title={refused > 0 ? t('move.doneSome', { moved, refused }) : t('move.done', { count: moved, place: target?.code ?? '' })} />}
        <p className="fw-hd-find-hint">{t('move.intro')}</p>
        <Field label={t('move.hides')}>
          <ul className="fw-hd-move-list">
            {model.hides.map((hide) => {
              const result = model.results?.[hide.id]
              const there = !hide.why && hide.from?.id === model.toLocationId
              return (
                <li key={hide.id}>
                  <span className="fw-wl-code">{hide.code}</span>
                  <span className="fw-st-num">{`${quantity(hide.quantity, locale)} ${t(`stock:uom.${hide.uom}`)}`}</span>
                  <span className="fw-st-sub">{hide.from ? t('move.from', { place: hide.from.code }) : '—'}</span>
                  <span className="fw-st-sub">
                    {result ? (result.moved ? t('move.moved') : t('move.refused', { why: say(result.problem) })) : hide.why ? t('move.leftOut', { why: say(hide.why) }) : there ? t('move.there') : t('move.ok')}
                  </span>
                </li>
              )
            })}
          </ul>
        </Field>
        <Field label={t('move.to')} required>
          {model.places.problem ? (
            <Banner
              tone="danger"
              title={t('move.placesFailed')}
              action={
                <Button size="sm" onClick={() => actions?.onRetryPlaces?.()}>
                  {t('lots:rec.retry')}
                </Button>
              }
            />
          ) : model.places.value === null ? (
            <span className="fw-hd-find-hint" role="status">
              <Spinner size={12} /> {t('find.searching')}
            </span>
          ) : (
            <Select size="sm" value={model.toLocationId ?? ''} disabled={!!model.results} onChange={(event) => actions?.onPlace?.(event.target.value || null)}>
              <option value="">{t('move.pickPlace')}</option>
              {model.places.value.map((place) => (
                <option key={place.id} value={place.id}>
                  {`${place.code} · ${place.name} (${t(`stock:locationKind.${place.kind}`)})`}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('move.note')} hint={t('move.noteHint')}>
          <Input size="sm" value={model.note} maxLength={500} disabled={!!model.results} onChange={(event) => actions?.onNote?.(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
