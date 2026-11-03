'use client'

import { useEffect, useState } from 'react'
import { Recycle, RotateCcw } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, CheckboxCard, Input, RadioCard, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { DowngradeOptions, Repair, ScrapRow } from '../api'
import { downgradeHeld, SCRAP_NAMESPACE, type DowngradeDraft, type Phrase } from '../model'
import type { ScrapActions, ScrapModel } from './ScrapView'

/**
 * B-W2b-126 — second quality and the repair station on Scrap & rework (SCR-140; design production.scrap pop:sc-downgrade
 * "Downgrade to second quality", pop:sc-item for a rework row; MES-132, MES-133).
 *
 *   DowngradeDialog  from a scrap row (Esc closes; focus returns to the opener): how many garments of the row still can go
 *                    (the API's count), why (a reason tile; Other needs words), kept as the cell's SKU (in a place outside
 *                    finished goods, so they never ship as first quality) or a second-quality item, the place, and for
 *                    protective clothing the confirmation that the fault does not touch the protection. ESPR said in one
 *                    line. Held with why, in words, before anything is typed (a cut piece, the scrap's approval, …).
 *   SecondSection    a SECOND row's detail: kept as what, where, the note; withdrawn when and why; Withdraw… with the reason.
 *   RepairSection    a rework row's detail: where it stands at the repair station, in and out, the station, the minutes
 *                    (per rework), good and scrapped; who scanned only where the site's PERFORMANCE gate is open, else said
 *                    as hidden. Never a figure per person.
 */

export interface DowngradeModel {
  readonly rowId: string
  /** What the row can still send (null: being read). */
  readonly options: DowngradeOptions | null
  /** The options could not be read: the problem's key. */
  readonly readProblem: string | null
  readonly draft: DowngradeDraft
}

export interface RepairModel {
  readonly reworkId: string
  readonly value: Repair | null
  readonly problem: string | null
}

const say = (t: (key: string, params?: Record<string, string | number>) => string, words: Phrase | null): string | null => (words ? t(words.key, words.params) : null)

export function DowngradeDialog({ model, actions }: { model: ScrapModel; actions?: ScrapActions }) {
  const t = useT(SCRAP_NAMESPACE)
  const downgrade = model.downgrade!
  const row = (model.rows.items ?? []).find((entry) => entry.id === downgrade.rowId) ?? null
  const { options, draft } = downgrade
  const held = say(t, downgradeHeld(options, draft, model.can, model.busy))
  const set = (next: Partial<DowngradeDraft>) => actions?.onDowngradeDraft?.({ ...draft, ...next })
  return (
    <Modal
      open
      onClose={() => actions?.onDowngrade?.(null)}
      title={t('second.title')}
      subtitle={row ? t('item.title.SCRAP', { count: row.pieces, number: row.workOrder.number }) : undefined}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onDowngrade?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onDowngradeGo?.()}>
            {model.busy ? <Spinner size={12} /> : <Recycle size={13} aria-hidden />} {t('second.go')}
          </Button>
        </>
      }
    >
      <div className="fw-sc-dialog">
        {model.problem && <Banner tone="danger" title={say(t, model.problem)} />}
        {downgrade.readProblem ? (
          <Banner tone="danger" title={t('second.readFailed')}>
            {t(downgrade.readProblem)}
          </Banner>
        ) : null}
        <p className="fw-sc-hint">{t('second.espr')}</p>
        {!options && !downgrade.readProblem ? <p className="fw-sc-hint">{t('held.loading')}</p> : null}
        {options ? (
          <>
            <p>{t('second.body', { left: options.left, scrapped: options.scrapped, downgraded: options.downgraded, cell: `${options.cell.colourwayCode} ${options.cell.size}` })}</p>
            {options.held ? <Banner tone="warning" title={say(t, downgradeHeld(options, draft, model.can, false))} /> : null}
            <Field label={t('second.quantity')} hint={t('second.quantityHint', { max: options.left })}>
              <Input size="sm" type="number" inputMode="numeric" min={1} max={Math.max(1, options.left)} value={draft.quantity} disabled={Boolean(options.held)} onChange={(event) => set({ quantity: event.target.value })} />
            </Field>
            <fieldset className="fw-sc-choices">
              <legend className="fw-sc-h3">{t('second.reason')}</legend>
              <div className="fw-sc-reasons">
                {options.reasons.map((code) => (
                  <RadioCard key={code} variant="row" name="fw-sc-second-reason" value={code} checked={draft.reasonCode === code} selected={draft.reasonCode === code} disabled={Boolean(options.held)} onChange={() => set({ reasonCode: code })} title={t(`second.reasonCode.${code}`)} />
                ))}
              </div>
            </fieldset>
            <Field label={draft.reasonCode === 'OTHER' ? t('second.noteRequired') : t('second.note')}>
              <Textarea value={draft.note} onChange={(event) => set({ note: event.target.value })} rows={2} maxLength={500} disabled={Boolean(options.held)} />
            </Field>
            <fieldset className="fw-sc-choices">
              <legend className="fw-sc-h3">{t('second.target')}</legend>
              <RadioCard variant="row" name="fw-sc-second-target" value="SKU" checked={draft.target === 'SKU'} selected={draft.target === 'SKU'} disabled={!options.sku || Boolean(options.held)} onChange={() => set({ target: 'SKU' })} title={t('second.targetSku', { sku: options.sku?.sku ?? '—' })} description={options.sku ? t('second.targetSkuHint') : t('second.refusal.NO_SKU')} />
              <RadioCard variant="row" name="fw-sc-second-target" value="ITEM" checked={draft.target === 'ITEM'} selected={draft.target === 'ITEM'} disabled={Boolean(options.held)} onChange={() => set({ target: 'ITEM' })} title={t('second.targetItem')} description={options.items.length > 0 ? t('second.targetItemHint') : t('second.held.noItems')} />
            </fieldset>
            {draft.target === 'ITEM' ? (
              <Field label={t('second.item')}>
                <Select size="sm" value={draft.itemId} disabled={options.items.length === 0 || Boolean(options.held)} onChange={(event) => set({ itemId: event.target.value })}>
                  <option value="">{t('second.pick')}</option>
                  {options.items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.code} · {item.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field label={t('second.place')} hint={draft.target === 'SKU' ? t('second.placeHintSku') : t('second.placeHint')}>
              <Select size="sm" value={draft.toLocationId} disabled={Boolean(options.held)} onChange={(event) => set({ toLocationId: event.target.value })}>
                <option value="">{t('second.pick')}</option>
                {options.places.map((place) => (
                  <option key={place.id} value={place.id} disabled={draft.target === 'SKU' && place.finishedGoods}>
                    {place.code} · {place.name}
                    {place.finishedGoods ? ` (${t('second.finishedGoods')})` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            {options.ppe ? (
              <CheckboxCard variant="row" checked={draft.ppeConfirmed} selected={draft.ppeConfirmed} disabled={Boolean(options.held)} onChange={(event) => set({ ppeConfirmed: event.target.checked })} title={t('second.ppe')} description={t('second.ppeHint')} />
            ) : null}
          </>
        ) : null}
      </div>
    </Modal>
  )
}

/** A SECOND row's detail: what the garments are kept as and where; withdrawn; Withdraw… with the reason. */
export function SecondSection({ model, row, actions }: { model: ScrapModel; row: ScrapRow; actions?: ScrapActions }) {
  const t = useT(SCRAP_NAMESPACE)
  const locale = useLocale()
  const target = row.downgrade
  const [withdrawing, setWithdrawing] = useState(false)
  const [reason, setReason] = useState('')
  useEffect(() => {
    setWithdrawing(false)
    setReason('')
  }, [row.id])
  if (!target) return null
  const held = !model.can.downgrade ? t('held.permission', { permission: 'production.downgrade' }) : target.withdrawn ? t('second.refusal.ALREADY_WITHDRAWN') : model.busy ? t('held.busy') : null
  return (
    <section className="fw-sc-card" aria-label={t('second.section')}>
      <h3 className="fw-sc-h3">{t('second.section')}</h3>
      <KeyValue
        columns={2}
        items={[
          { label: t('second.keptAs'), value: target.target === 'SKU' ? t('second.keptSku', { sku: target.sku?.sku ?? '—' }) : t('second.keptItem', { item: target.item ? `${target.item.code} · ${target.item.name}` : '—' }) },
          { label: t('second.place'), value: target.place ? `${target.place.code} · ${target.place.name}` : t('second.noMove') },
          ...(target.note ? [{ label: t('second.note'), value: target.note }] : []),
          ...(target.withdrawn ? [{ label: t('second.withdrawnAt'), value: formatDateTime(target.withdrawn.at, { locale, timeZone: model.timeZone }), hint: target.withdrawn.reason }] : []),
        ]}
      />
      {target.withdrawn ? <Tag tone="neutral">{t('second.withdrawn')}</Tag> : null}
      {!target.withdrawn && withdrawing ? (
        <div className="fw-sc-dialog">
          <Field label={t('second.withdrawReason')} hint={t('second.withdrawHint')}>
            <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} />
          </Field>
          <span className="fw-sc-inline">
            <Button size="sm" onClick={() => setWithdrawing(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="danger" heldReason={held ?? (reason.trim().length < 3 ? t('held.reason') : null)} onClick={() => actions?.onWithdraw?.(row, reason.trim())}>
              {model.busy ? <Spinner size={12} /> : <RotateCcw size={13} aria-hidden />} {t('second.withdrawGo')}
            </Button>
          </span>
        </div>
      ) : null}
      {!target.withdrawn && !withdrawing ? (
        <span className="fw-sc-inline">
          <Button size="sm" variant="danger-outline" heldReason={held} onClick={() => setWithdrawing(true)}>
            <RotateCcw size={13} aria-hidden /> {t('second.withdraw')}
          </Button>
        </span>
      ) : null}
    </section>
  )
}

/** A rework row's repair at the repair station. */
export function RepairSection({ model }: { model: ScrapModel }) {
  const t = useT(SCRAP_NAMESPACE)
  const locale = useLocale()
  const repair = model.repair
  if (!repair) return null
  const place = { locale, timeZone: model.timeZone }
  const value = repair.value
  return (
    <section className="fw-sc-card" aria-label={t('repair.section')}>
      <h3 className="fw-sc-h3">{t('repair.section')}</h3>
      {repair.problem ? <p className="fw-sc-hint">{t('repair.failed')}</p> : null}
      {!value && !repair.problem ? <p className="fw-sc-hint">{t('held.loading')}</p> : null}
      {value ? (
        <>
          <KeyValue
            columns={2}
            items={[
              { label: t('repair.state'), value: t(value.state ? `repair.stateOf.${value.state}` : value.repairOutAt ? 'repair.stateOf.OUT' : 'repair.stateOf.NONE') },
              { label: t('repair.station'), value: value.station?.code ?? '—' },
              { label: t('repair.in'), value: value.repairInAt ? formatDateTime(value.repairInAt, place) : '—', ...(value.scannedInBy ? { hint: value.scannedInBy.name } : {}) },
              { label: t('repair.out'), value: value.repairOutAt ? formatDateTime(value.repairOutAt, place) : '—', ...(value.scannedOutBy ? { hint: value.scannedOutBy.name } : {}) },
              { label: t('repair.minutes'), value: value.minutes === null ? '—' : t('repair.minutesValue', { count: value.minutes }), hint: t('repair.minutesHint') },
              { label: t('repair.result'), value: value.status === 'DONE' ? t('repair.resultValue', { good: value.goodQuantity, scrap: value.scrapQuantity }) : '—' },
            ]}
          />
          {value.workerHidden ? <p className="fw-sc-hint">{t('repair.hidden')}</p> : null}
        </>
      ) : null}
    </section>
  )
}
