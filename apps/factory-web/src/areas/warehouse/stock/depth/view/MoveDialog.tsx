'use client'

import { useEffect, useRef } from 'react'
import { ArrowRightLeft } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { quantity } from '../../../../_shared/stock/model'
import type { PlaceView } from '../../../locations/depth/api'
import { DEPTH_NAMESPACE, moveHeldKey, movesPart, placesById, type MoveActions, type MoveDialogModel } from '../model'

/**
 * Move… (design warehouse.stock st-grid "row ⋯ Move… (W2b)", "selection row 'Move…' (W2b)"): the rows picked to another
 * place of the same site — one move per stock key (a leather row moves each of its hides whole), one row of another
 * material in part (all of it by default) — with a note. A blocked place (a count, damage, a clean-up), a transit place
 * (only a transfer moves its goods) and the place the stock already lies in are refused in words before anything is sent;
 * the API refuses what it must (a place that does not hold that kind). ⌘↵ moves; after it, what moved and what was refused.
 */
export function MoveDialog({ model, places, actions }: { model: MoveDialogModel; places: readonly PlaceView[]; actions?: MoveActions }) {
  const t = useT(DEPTH_NAMESPACE)
  const s = useT('stock')
  const locale = useLocale()
  const byId = placesById(places)
  const held = moveHeldKey(model, byId)
  const part = movesPart(model)
  const line = model.lines[0]
  const unit = line ? s(`uom.${line.item.baseUom}`) : ''
  const latest = useRef(actions)
  latest.current = actions
  const set = (patch: Partial<MoveDialogModel['draft']>) => latest.current?.onChange?.({ ...model.draft, ...patch })

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

  const placeWords = (place: PlaceView) => `${place.code} · ${place.name}${place.block?.holds ? ` · ${t('wd.move.blockedSuffix')}` : ''}`
  const from = [...new Set(model.lines.map((entry) => entry.location.code))]

  if (model.done) {
    return (
      <Modal
        open
        onClose={() => actions?.onClose?.()}
        size="md"
        title={t('wd.move.doneTitle', { count: model.done.moved })}
        footer={
          <Button size="sm" variant="primary" onClick={() => actions?.onClose?.()}>
            {s('common.close')}
          </Button>
        }
      >
        <div className="fw-stk-form">
          {model.done.moved > 0 && <Banner tone="success" title={t('wd.move.done', { count: model.done.moved, place: byId.get(model.draft.toLocationId)?.code ?? '' })} />}
          {model.done.refused.length > 0 && (
            <Banner tone="danger" title={t('wd.move.refusedTitle', { count: model.done.refused.length })}>
              <ul className="fw-wd-list">
                {model.done.refused.map((entry) => (
                  <li key={entry.label}>{t('wd.move.refusedLine', { what: entry.label, why: t(entry.problem.key, entry.problem.params) })}</li>
                ))}
              </ul>
            </Banner>
          )}
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="md"
      title={t('wd.move.title', { count: model.lines.length })}
      subtitle={t('wd.move.from', { places: from.join(', ') })}
      footer={
        <>
          <span className="fw-stk-hint">{t('wd.move.keys')}</span>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onClose?.()}>
            {s('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held ? t(held.key, held.params) : null} onClick={() => actions?.onPost?.()} aria-keyshortcuts="Meta+Enter">
            <ArrowRightLeft size={13} aria-hidden /> {t('wd.move.do', { count: model.planned.length })}
          </Button>
        </>
      }
    >
      <div className="fw-stk-form">
        {model.problem && <Banner tone="danger" title={t(model.problem.key, model.problem.params)} />}
        <ul className="fw-wd-list" aria-label={t('wd.move.what')}>
          {model.planned.slice(0, 8).map((entry) => (
            <li key={entry.key}>
              {entry.label} · <span className="fw-st-num">{`${quantity(entry.input.quantity, locale)} ${s(`uom.${entry.uom}`)}`}</span>
            </li>
          ))}
          {model.planned.length > 8 && <li className="fw-wd-muted">{t('wd.move.andMore', { count: model.planned.length - 8 })}</li>}
        </ul>
        <Field label={t('wd.move.to')} required hint={t('wd.move.toHint')}>
          <Select value={model.draft.toLocationId} onChange={(event) => set({ toLocationId: event.target.value })}>
            <option value="" disabled>
              {t('wd.move.pick')}
            </option>
            {model.targets.map((place) => (
              <option key={place.id} value={place.id} disabled={!!place.block?.holds}>
                {' '.repeat(place.depth)}
                {placeWords(place)}
              </option>
            ))}
          </Select>
        </Field>
        {part && line && (
          <Field label={t('wd.move.quantity', { unit })} hint={t('wd.move.quantityHint', { quantity: quantity(line.onHand, locale), unit })}>
            <Input inputMode="decimal" value={model.draft.quantity} onChange={(event) => set({ quantity: event.target.value })} suffix={unit} />
          </Field>
        )}
        {!part && <p className="fw-stk-hint">{t('wd.move.whole')}</p>}
        <Field label={t('wd.move.note')} hint={t('wd.move.noteHint')}>
          <Textarea value={model.draft.note} onChange={(event) => set({ note: event.target.value })} limit={500} rows={2} />
        </Field>
      </div>
    </Modal>
  )
}
