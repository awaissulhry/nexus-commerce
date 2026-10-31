'use client'

import { useEffect, useRef, useState } from 'react'
import { Bookmark, Search } from 'lucide-react'
import { Banner, Field, Modal } from '@nexus/ui/components'
import { Button, Input, Radio, Spinner, Textarea } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { quantity, unitTotals } from '../../../_shared/stock/model'
import { useUnitWord } from '../../../_shared/stock/parts'
import type { ReserveActions, ReserveDialogModel } from './dialog-model'
import { DAILY_NAMESPACE, reserveHeldKey } from './model'
import { DailyMessages, useSay } from './parts'

/**
 * Reserve N hides to a work order (design warehouse.hides selection row "Reserve to a work order…", the action of the
 * W2b "Find hides for a job": "Reserve 11 hides"): the hides chosen (each free to reserve, or left out with why — on
 * hold, its lot not released, reserved already, not in stock), the open work order of the site found by number, batch
 * or style (a radio list), a note, then "Reserve N hides" (whole hides, all or nothing). A refusal (the stock was taken
 * meanwhile) is said in our words.
 */
export function ReserveDialog({ model, actions }: { model: ReserveDialogModel; actions?: ReserveActions }) {
  return (
    <DailyMessages>
      <Dialog model={model} actions={actions} />
    </DailyMessages>
  )
}

function Dialog({ model, actions }: { model: ReserveDialogModel; actions?: ReserveActions }) {
  const t = useT(DAILY_NAMESPACE)
  const s = useT('stock')
  const say = useSay()
  const locale = useLocale()
  const unitWord = useUnitWord()
  const [query, setQuery] = useState(model.query)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (query === model.query) return
    const timer = setTimeout(() => latest.current?.onQuery?.(query), 300)
    return () => clearTimeout(timer)
  }, [query, model.query])
  const free = model.hides.filter((hide) => hide.why === null)
  const heldKey = reserveHeldKey(model)
  const close = () => actions?.onClose?.()

  if (model.done) {
    return (
      <Modal
        open
        onClose={close}
        size="md"
        title={t('reserve.title', { count: model.hides.length })}
        footer={
          <Button size="sm" variant="primary" onClick={close}>
            {t('wo.close')}
          </Button>
        }
      >
        <Banner tone="success" title={t('reserve.done', { count: model.done.count, workOrder: model.done.workOrder })} />
      </Modal>
    )
  }

  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={t('reserve.title', { count: model.hides.length })}
      footer={
        <>
          <Button size="sm" onClick={close}>
            {s('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={heldKey ? t(heldKey) : null} onClick={() => actions?.onReserve?.()}>
            {model.posting ? <Spinner size={12} /> : <Bookmark size={13} aria-hidden />} {t('reserve.go', { count: free.length })}
          </Button>
        </>
      }
    >
      <div className="fw-dy-form">
        {model.problem && <Banner tone="danger" title={say(model.problem)} />}
        <p className="fw-dy-hint">{t('reserve.intro')}</p>
        <Field label={t('reserve.hides')}>
          <ul className="fw-dy-list">
            {model.hides.map((hide) => (
              <li key={hide.id}>
                <span className="fw-dy-code">{hide.code}</span>
                <span className="fw-st-num">{`${quantity(hide.area, locale)} ${unitWord(hide.uom)}`}</span>
                <span className="fw-dy-out">{hide.lotCode}</span>
                <span className="fw-dy-out">{hide.why ? `${t('reserve.leftOut')}: ${say(hide.why)}` : t('reserve.ok')}</span>
              </li>
            ))}
          </ul>
        </Field>
        <p className="fw-dy-strong">
          {unitTotals(
            free.map((hide) => ({ uom: hide.uom, quantity: hide.area })),
            unitWord,
            locale,
          )}
        </p>
        <Field label={t('reserve.workOrder')} required>
          {model.canSeeWorkOrders ? (
            <div className="fw-dy-form">
              <Input type="search" size="sm" leadingIcon={<Search size={13} aria-hidden />} aria-label={t('reserve.search')} placeholder={t('reserve.search')} value={query} onChange={(event) => setQuery(event.target.value)} />
              {model.workOrders.problem ? (
                <Banner
                  tone="danger"
                  title={t('reserve.workOrdersFailed')}
                  action={
                    <Button size="sm" onClick={() => actions?.onRetryWorkOrders?.()}>
                      {s('problem.retry')}
                    </Button>
                  }
                />
              ) : model.workOrders.value === null ? (
                <p className="fw-dy-row fw-dy-hint" role="status">
                  <Spinner size={12} /> {t('reserve.searching')}
                </p>
              ) : model.workOrders.value.length === 0 ? (
                <p className="fw-dy-hint">{t('reserve.noneFound')}</p>
              ) : (
                <div className="fw-dy-picks" role="radiogroup" aria-label={t('reserve.workOrder')}>
                  {model.workOrders.value.map((order) => (
                    <Radio
                      key={order.id}
                      name="reserve-work-order"
                      checked={model.workOrderId === order.id}
                      onChange={() => actions?.onPick?.(order.id)}
                      label={[order.number, `${order.styleCode} · ${order.styleName}`, t('reserve.pieces', { count: order.pieces }), order.dueDate ? t('reserve.due', { day: formatDate(`${order.dueDate}T12:00:00Z`, { locale, timeZone: model.timeZone }) }) : null].filter(Boolean).join(' · ')}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="fw-dy-hint">{t('reserve.noRightWorkOrders')}</p>
          )}
        </Field>
        <Field label={t('reserve.note')} hint={t('reserve.noteHint')}>
          <Textarea value={model.note} onChange={(event) => actions?.onNote?.(event.target.value)} limit={500} rows={2} />
        </Field>
      </div>
    </Modal>
  )
}
