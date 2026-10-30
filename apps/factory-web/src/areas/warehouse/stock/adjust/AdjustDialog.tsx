'use client'

import { useEffect, useRef } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { Banner, Field, Modal } from '@nexus/ui/components'
import { Button, Input, SegmentedControl, Select, Textarea } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { quantity } from '../../../_shared/stock/model'
import { adjustChecks, adjustPreview, type AdjustActions, type AdjustDialogModel } from './model'

/**
 * Adjust stock (design st-adjust, mv-adjust — the ONE dialog of Stock and Movements): what it adjusts (material, colour,
 * lot, hide and place, from the row), Up or Down, the quantity in the item's base unit, the reason (required: the ledger
 * keeps it), a reference, the unit cost with the cost grain only, and the preview. "Post adjustment" is held with the
 * missing field named; ⌘↵ posts; a refusal says why in our words. The stock changes only through this move.
 */
export function AdjustDialog({ model, actions }: { model: AdjustDialogModel; actions?: AdjustActions }) {
  const t = useT('warehouse-stock')
  const s = useT('stock')
  const locale = useLocale()
  const { target, draft } = model
  const unit = s(`uom.${target.item.baseUom}`)
  const checks = adjustChecks(model)
  const preview = adjustPreview(model)
  const held = model.offline ? s('held.offline') : model.posting ? t('adj.posting') : checks.length > 0 ? t(`adj.held.${checks[0]}`, { quantity: quantity(target.onHand, locale), unit }) : null
  const latest = useRef(actions)
  latest.current = actions
  const set = (patch: Partial<typeof draft>) => latest.current?.onChange?.({ ...draft, ...patch })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
        event.preventDefault()
        latest.current?.onPost?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [held])

  const what = [`${target.item.code} · ${target.item.name}`, target.colour ? `${target.colour.code} ${target.colour.name}` : null, target.lot ? t('adj.lot', { code: target.lot.code }) : null, target.hide ? t('adj.hide', { code: target.hide.code }) : null].filter(Boolean).join(' · ')
  const placeName = (id: string) => {
    const found = id === target.location.id ? target.location : model.locations?.find((place) => place.id === id)
    return found ? `${found.code} · ${found.name}` : '—'
  }
  const previewText =
    preview.delta === null
      ? t('adj.preview.none')
      : preview.place === 'row' && preview.before !== null && preview.after !== null
        ? t('adj.preview.row', { before: quantity(preview.before, locale), after: quantity(preview.after, locale), unit, place: placeName(target.location.id) })
        : t('adj.preview.other', { quantity: quantity(Math.abs(preview.delta), locale), unit, place: placeName(draft.locationId) })

  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="md"
      title={t('adj.title')}
      subtitle={what}
      footer={
        <>
          <span className="fw-stk-hint">{t('adj.keys')}</span>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onClose?.()}>
            {s('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onPost?.()} aria-keyshortcuts="Meta+Enter">
            <SlidersHorizontal size={13} aria-hidden /> {t('adj.post')}
          </Button>
        </>
      }
    >
      <div className="fw-stk-form">
        {model.problem && <Banner tone="danger" title={t(model.problem.key, model.problem.params)} />}
        <p className="fw-stk-hint">{t('adj.intro', { site: target.siteCode, place: placeName(target.location.id), quantity: quantity(target.onHand, locale), unit })}</p>
        <Field label={t('adj.direction')}>
          <SegmentedControl
            ariaLabel={t('adj.direction')}
            value={draft.direction}
            onChange={(value) => set({ direction: value as 'IN' | 'OUT', ...(value === 'OUT' ? { locationId: target.location.id } : {}) })}
            options={[
              { value: 'OUT', label: t('adj.down') },
              { value: 'IN', label: t('adj.up') },
            ]}
          />
        </Field>
        {draft.direction === 'IN' && (
          <Field label={t('adj.location')} hint={t('adj.locationHint')}>
            <Select value={draft.locationId} onChange={(event) => set({ locationId: event.target.value })}>
              <option value={target.location.id}>{placeName(target.location.id)}</option>
              {(model.locations ?? [])
                .filter((place) => place.id !== target.location.id)
                .map((place) => (
                  <option key={place.id} value={place.id}>
                    {place.code} · {place.name}
                  </option>
                ))}
            </Select>
          </Field>
        )}
        <Field label={t('adj.quantity', { unit })} required error={checks.includes('tooMuch') ? t('adj.held.tooMuch', { quantity: quantity(target.onHand, locale), unit }) : undefined}>
          <Input inputMode="decimal" value={draft.quantity} onChange={(event) => set({ quantity: event.target.value })} suffix={unit} autoFocus />
        </Field>
        <Field label={t('adj.note')} required hint={t('adj.noteHint')}>
          <Textarea value={draft.note} onChange={(event) => set({ note: event.target.value })} limit={500} rows={3} />
        </Field>
        <Field label={t('adj.reference')} hint={t('adj.referenceHint')}>
          <Input value={draft.reference} onChange={(event) => set({ reference: event.target.value })} maxLength={120} />
        </Field>
        {model.withCost && (
          <Field label={t('adj.unitCost', { unit })} hint={t('adj.unitCostHint')} error={checks.includes('unitCost') ? t('adj.held.unitCost') : undefined}>
            <Input inputMode="decimal" value={draft.unitCost} onChange={(event) => set({ unitCost: event.target.value })} />
          </Field>
        )}
        <p className="fw-stk-preview" role="status">
          {previewText}
        </p>
      </div>
    </Modal>
  )
}
