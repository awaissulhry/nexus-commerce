'use client'

import Link from 'next/link'
import { Search } from 'lucide-react'
import { Banner, DateField, Field, Modal } from '@nexus/ui/components'
import { Button, Checkbox, Input, Select, Spinner, Tag, Textarea } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { quantity, unitPrice } from '../../../../_shared/buying/model'
import { say } from '../../model'
import { freePieces, locationOf, newOrderHeld, workshopOf, type SubcontractingActions, type SubcontractingModel } from '../list-model'

/**
 * New subcontract order (design purchasing.subcontracting pop:new; Band; Esc closes and returns focus to the opener):
 * the work order (released or running, by number or style), the operations the workshop does — from its routing, the
 * outside ones picked first, each with the pieces still free —, the workshop (the routing's, or another active
 * subcontractor: "qualified only" is W2b), its stock location on the site, the return date (empty: the routing's transit
 * days, the workshop's closed days skipped), the kit planned from the work order's materials, a note. "Create draft"
 * (⌘↵) is held with the reason; the number comes from the series. The fee per piece is a cost: shown with the cost grain
 * only.
 */
export function NewOrderDialog({ model, actions }: { model: SubcontractingModel; actions?: SubcontractingActions }) {
  const t = useT('subcontracting')
  const locale = useLocale()
  const draft = model.newOrder!
  const on = actions?.newOrder
  const held = newOrderHeld(draft, model.can)
  const heldWords = held ? say(t, held) : null
  const workshop = workshopOf(draft)
  const place = locationOf(draft)
  const outside = draft.outside
  const routingWorkshops = outside?.workshops ?? []
  // The fee's currency is the company's (every order of the list carries it); before any order exists, the number alone.
  const currency = model.rows.items?.[0]?.currency ?? null
  const fee = (text: string) => (currency ? unitPrice(text, currency, locale) : quantity(text, locale, 4))

  return (
    <Modal
      open
      onClose={() => actions?.onNew?.(false)}
      title={t('new.title')}
      size="lg"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onNew?.(false)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={heldWords} onClick={() => on?.onCreate?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {draft.busy && <Spinner size={12} />} {t('new.create')}
          </Button>
        </>
      }
    >
      <div
        className="fw-by-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
            event.preventDefault()
            on?.onCreate?.()
          }
        }}
      >
        {!draft.workOrder ? (
          <>
            <Field label={t('new.workOrder')} required hint={t('new.workOrderHint')}>
              <Input size="sm" type="search" leadingIcon={<Search size={13} aria-hidden />} value={draft.query} onChange={(event) => on?.onQuery?.(event.target.value)} placeholder={t('new.workOrderSearch')} autoFocus />
            </Field>
            {draft.workOrdersProblem ? (
              <Banner tone="danger" title={t(draft.workOrdersProblem)} />
            ) : draft.workOrders === null ? (
              <p className="fw-by-hint" role="status">
                <Spinner size={14} /> {t('common.loading')}
              </p>
            ) : draft.workOrders.length === 0 ? (
              <p className="fw-by-hint">{t('new.noWorkOrder')}</p>
            ) : (
              <div className="fw-by-stack" role="group" aria-label={t('new.workOrder')}>
                {draft.workOrders.map((choice) => (
                  <Button key={choice.id} size="sm" variant="quiet" onClick={() => on?.onWorkOrder?.(choice)}>
                    <span className="fw-by-inline">
                      <b>{choice.number}</b>
                      <span className="fw-by-hint">{t('new.workOrderLine', { style: `${choice.style.code} ${choice.style.name}`, garments: t('common.pieces', { count: choice.garments }), site: choice.site.code })}</span>
                      {choice.outsideSteps > 0 ? <Tag tone="info">{t('new.outsideSteps', { count: choice.outsideSteps })}</Tag> : <Tag tone="neutral">{t('new.noOutsideSteps')}</Tag>}
                      {choice.liveOrders > 0 && <Tag tone="neutral">{t('new.liveOrders', { count: choice.liveOrders })}</Tag>}
                    </span>
                  </Button>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="fw-by-card-head">
              <span className="fw-by-inline">
                <b>{draft.workOrder.number}</b>
                <span className="fw-by-hint">{t('new.workOrderLine', { style: `${draft.workOrder.style.code} ${draft.workOrder.style.name}`, garments: t('common.pieces', { count: draft.workOrder.garments }), site: draft.workOrder.site.code })}</span>
              </span>
              <Button size="sm" variant="quiet" onClick={() => on?.onWorkOrder?.(null)}>
                {t('new.change')}
              </Button>
            </div>
            {outside && outside.orders.length > 0 && <p className="fw-by-hint">{t('new.ordersOf', { orders: outside.orders.map((entry) => `${entry.number} (${t(`status.${entry.status}`)})`).join(', ') })}</p>}
            {draft.outsideProblem ? (
              <Banner tone="danger" title={t(draft.outsideProblem)} />
            ) : !outside ? (
              <p className="fw-by-hint" role="status">
                <Spinner size={14} /> {t('new.loading')}
              </p>
            ) : (
              <>
                <Field label={t('new.operations')} required hint={t('new.operationsHint')}>
                  <div className="fw-sc-pick" role="group" aria-label={t('new.operations')}>
                    {[...outside.operations]
                      .sort((a, b) => (a.outside ? 0 : 1) - (b.outside ? 0 : 1) || a.seq - b.seq)
                      .map((operation) => {
                        const pick = draft.picked.find((entry) => entry.operationId === operation.id)
                        const { left, garments } = freePieces(outside, operation.id)
                        const label = t('new.operationLine', { seq: operation.seq, code: operation.code, name: operation.name })
                        const price = operation.outside?.pricePerPiece
                        return (
                          <div key={operation.id} className={pick ? 'fw-sc-op is-picked' : 'fw-sc-op'}>
                            <Checkbox checked={!!pick} disabled={left === 0} onChange={(event) => on?.onToggle?.(operation.id, event.target.checked)} aria-label={label} />
                            <span className="fw-sc-op-body">
                              <b className="fw-by-ellipsis">{label}</b>
                              <span className="fw-by-hint">
                                {operation.outside?.workshop
                                  ? t('new.outsideBy', { workshop: operation.outside.workshop.name, days: operation.outside.transitDays === null ? '—' : t('new.days', { count: operation.outside.transitDays }) })
                                  : t('new.inHouse')}
                                {operation.outside ? ` · ${model.can.cost ? (price ? t('new.fee', { fee: fee(price) }) : t('new.fee', { fee: '—' })) : t('new.feeHidden')}` : ''}
                              </span>
                              <span className="fw-by-hint">{left === 0 ? t('new.full') : t('new.left', { left, garments })}</span>
                            </span>
                            {pick ? (
                              <Input className="fw-sc-op-pieces" size="sm" type="number" inputMode="numeric" min={1} max={left} value={pick.pieces} onChange={(event) => on?.onPieces?.(operation.id, event.target.value)} aria-label={`${t('new.pieces')} · ${label}`} />
                            ) : (
                              <span />
                            )}
                          </div>
                        )
                      })}
                  </div>
                </Field>
                <div className="fw-by-fields">
                  <Field label={t('new.workshop')} required hint={t('new.workshopHint')}>
                    <Select
                      size="sm"
                      value={draft.otherOpen ? '__other' : (workshop?.id ?? '')}
                      onChange={(event) => {
                        const value = event.target.value
                        if (value === '__other') {
                          on?.onOther?.(true)
                          return
                        }
                        on?.onOther?.(false)
                        const routing = routingWorkshops.find((entry) => entry.id === value)
                        on?.onWorkshop?.(routing ? { id: routing.id, code: routing.code, name: routing.name } : null)
                      }}
                    >
                      <option value="">—</option>
                      {routingWorkshops.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {t('new.workshopOfRouting', { name: entry.name })}
                        </option>
                      ))}
                      {draft.workshop && !routingWorkshops.some((entry) => entry.id === draft.workshop!.id) && <option value={draft.workshop.id}>{draft.workshop.name}</option>}
                      {model.can.parties && <option value="__other">{t('new.otherWorkshop')}</option>}
                    </Select>
                  </Field>
                  <Field label={t('new.returnDate')} hint={t('new.returnDateHint')}>
                    <DateField value={draft.returnDate} onChange={(value) => on?.onReturnDate?.(value)} locale={locale === 'it' ? 'it-IT' : 'en-GB'} placeholder={t('new.returnDateEmpty')} clearable clearLabel={t('common.clear')} />
                  </Field>
                </div>
                {draft.otherOpen && (
                  <div className="fw-by-stack">
                    <Input size="sm" type="search" leadingIcon={<Search size={13} aria-hidden />} value={draft.otherQuery} onChange={(event) => on?.onOtherQuery?.(event.target.value)} placeholder={t('new.workshopSearch')} aria-label={t('new.workshopSearch')} autoFocus />
                    {draft.others === null ? (
                      <p className="fw-by-hint" role="status">
                        <Spinner size={14} /> {t('common.loading')}
                      </p>
                    ) : draft.others.length === 0 ? (
                      <p className="fw-by-hint">{t('new.noWorkshop')}</p>
                    ) : (
                      <div className="fw-by-stack" role="group" aria-label={t('new.workshop')}>
                        {draft.others.slice(0, 8).map((option) => (
                          <Button
                            key={option.id}
                            size="sm"
                           
                            variant={draft.workshop?.id === option.id ? 'tonal' : 'quiet'}
                            aria-pressed={draft.workshop?.id === option.id}
                            onClick={() => {
                              on?.onWorkshop?.({ id: option.id, code: option.code, name: option.tradeName ?? option.legalName })
                              on?.onOther?.(false)
                            }}
                          >
                            <span className="fw-by-inline">
                              <b>{option.tradeName ?? option.legalName}</b>
                              <span className="fw-by-hint">{option.code}</span>
                            </span>
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {workshop && (
                  <p className="fw-by-hint">
                    {place.known ? (
                      place.location ? (
                        t('new.location', { location: `${place.location.code} · ${place.location.name}` })
                      ) : (
                        <>
                          {t('new.noLocation', { workshop: workshop.name })}{' '}
                          {model.can.locations && (
                            <Link className="fw-by-link" href={`${model.prefix}/warehouse/locations`}>
                              {t('new.toLocations')}
                            </Link>
                          )}
                        </>
                      )
                    ) : (
                      t('new.locationLater')
                    )}
                  </p>
                )}
                <Checkbox checked={draft.planKit} onChange={(event) => on?.onPlanKit?.(event.target.checked)} label={t('new.planKit')} />
                <p className="fw-by-hint">{t('new.planKitHint')}</p>
                <Field label={t('new.note')}>
                  <Textarea value={draft.note} onChange={(event) => on?.onNote?.(event.target.value)} rows={2} maxLength={1000} />
                </Field>
                <ul className="fw-by-list">
                  <li>{t('new.number')}</li>
                  <li>{t('new.after')}</li>
                </ul>
              </>
            )}
          </>
        )}
        {draft.problem && <Banner tone="danger" title={say(t, draft.problem)} />}
      </div>
    </Modal>
  )
}
