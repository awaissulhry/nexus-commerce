'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronUp, ExternalLink, FilePlus2 } from 'lucide-react'
import { Banner, Card, KeyValue, Modal, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, RadioCard, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { dayAt, money, quantity, unitPrice } from '../../../_shared/buying/model'
import type { BuyRequest, RequestDetail } from '../api'
import {
  draftHeld,
  historyPhrases,
  holdPhrase,
  neighbours,
  nettingPhrases,
  orderHref,
  requestedByPhrase,
  roundingPhrases,
  salesOrderHref,
  say,
  sourceHref,
  sourcePhrase,
  statusPhrase,
  supplierFromPhrase,
  toneOf,
  workOrderHref,
  type RequestsActions,
  type RequestsModel,
} from '../model'

/**
 * The Request (design purchasing.requests pop:detail, a centred detail — the DS DetailModal's Prev / Next words are English
 * only, so this one has its own): the source, the netting in sentences from the numbers, what it is for (orders, work
 * orders) or what is already on order, the approved suppliers to pick from, the history; "Draft PO" (b) for this one
 * request; J / K walk the rows as the list shows them; the source record opens in a new tab.
 */
export function RequestDetailView({ model, ids, actions }: { model: RequestsModel; ids: readonly string[]; actions?: RequestsActions }) {
  const t = useT('purchasing-requests')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const detail = model.detail!
  const loaded = detail.detail.status === 'ready' ? detail.detail.value : null
  const listed = model.rows.items?.find((row) => row.id === detail.requestId) ?? null
  const request: BuyRequest | null = loaded?.request ?? listed
  const walk = neighbours(ids, detail.requestId)
  const chosen = detail.supplierId
  const draftWhy = request ? draftHeld([request], model.can, model.offline) : null

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="listbox"]') || target.isContentEditable)) return
      if ((event.key === 'j' || event.key === 'J') && walk.next) {
        event.preventDefault()
        actions?.onOpen?.(walk.next)
      } else if ((event.key === 'k' || event.key === 'K') && walk.previous) {
        event.preventDefault()
        actions?.onOpen?.(walk.previous)
      } else if (event.key === 'b' && request && !draftWhy) {
        event.preventDefault()
        actions?.detail?.onDraft?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const title = request ? t('detail.title', { material: request.item.code }) : t('detail.titleLoading')
  return (
    <Modal
      open
      onClose={() => actions?.onOpen?.(null)}
      title={title}
      subtitle={request ? `${request.item.name}${request.colour ? ` · ${request.colour.name}` : ''} · ${request.site.code}` : undefined}
      size="detail"
      footer={
        <>
          <span className="fw-by-hint">{walk.index >= 0 ? t('detail.position', { index: walk.index + 1, count: ids.length }) : ''}</span>
          <Button size="sm" variant="quiet" heldReason={walk.previous ? null : t('detail.first')} onClick={() => walk.previous && actions?.onOpen?.(walk.previous)} aria-keyshortcuts="k">
            <ChevronUp size={13} aria-hidden /> {t('detail.previous')}
          </Button>
          <Button size="sm" variant="quiet" heldReason={walk.next ? null : t('detail.last')} onClick={() => walk.next && actions?.onOpen?.(walk.next)} aria-keyshortcuts="j">
            <ChevronDown size={13} aria-hidden /> {t('detail.next')}
          </Button>
          <span className="grow" />
          {request && (
            <Button size="sm" asChild>
              <a href={sourceHref(model.prefix, request)} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={13} aria-hidden /> {t('detail.source')}
              </a>
            </Button>
          )}
          <Button size="sm" variant="primary" heldReason={draftWhy ? say(t, draftWhy) : request ? null : t('held.loading')} onClick={() => actions?.detail?.onDraft?.()} aria-keyshortcuts="b">
            <FilePlus2 size={13} aria-hidden /> {t('detail.draft')}
          </Button>
        </>
      }
    >
      <div className="fw-by-dialog">
        {detail.detail.status === 'loading' && (
          <p className="fw-by-hint" role="status">
            <Spinner size={14} /> {t('common.loading')}
          </p>
        )}
        {detail.detail.status === 'error' && (
          <Banner tone="danger" title={t('detail.failed')} action={<Button size="sm" onClick={() => actions?.detail?.onRetry?.()}>{t('common.retry')}</Button>}>
            {t(detail.detail.problem)}
          </Banner>
        )}
        {detail.detail.status === 'not_found' && <Banner tone="warning" title={t('detail.gone')} />}
        {detail.detail.status === 'forbidden' && <Banner tone="danger" title={t('problem.forbidden')} />}
        {request && <RequestBody model={model} request={request} loaded={loaded} chosen={chosen} actions={actions} place={place} />}
      </div>
    </Modal>
  )
}

function RequestBody({ model, request, loaded, chosen, actions, place }: { model: RequestsModel; request: BuyRequest; loaded: RequestDetail | null; chosen: string | null; actions?: RequestsActions; place: { locale: 'it' | 'en'; timeZone?: string } }) {
  const t = useT('purchasing-requests')
  const locale = useLocale()
  const hold = holdPhrase(request)
  const from = supplierFromPhrase(request)
  const rounding = roundingPhrases(request, locale)
  const mayPick = request.status === 'OPEN' && model.can.manage
  return (
    <>
      <div className="fw-by-inline">
        <Pill tone={toneOf(request)}>{say(t, statusPhrase(request))}</Pill>
        <Tag>{say(t, sourcePhrase(request))}</Tag>
        {request.item.requiresCrViTest && <Tag tone="warning">{t('crVi')}</Tag>}
      </div>
      {hold && request.status === 'OPEN' && <Banner tone="warning" title={say(t, hold)} />}
      {request.warnings.map((warning) => (
        <Banner key={warning.code} tone="info" title={t(`warning.${warning.code}`)} />
      ))}

      <div className="fw-rq-detail">
        <Card padded>
          <h3 className="fw-by-h3">{t('detail.facts')}</h3>
          <KeyValue
            dense
            items={[
              { label: t('col.by'), value: say(t, requestedByPhrase(request)), hint: request.plan ? formatDateTime(request.plan.runStartedAt, place) : t('by.live') },
              { label: t('col.need'), value: formatDate(dayAt(request.needDate), place), hint: t(request.orderBy.passed && request.status === 'OPEN' ? 'orderBy.passed' : 'orderBy.on', { date: formatDate(dayAt(request.orderBy.date), place) }) },
              {
                label: t('detail.lead'),
                value: request.orderBy.leadTimeDays === null ? t('detail.noLead') : t('detail.leadDays', { count: request.orderBy.leadTimeDays }),
                hint: request.orderBy.closedDaysSkipped > 0 ? t('detail.closedDays', { count: request.orderBy.closedDaysSkipped }) : undefined,
              },
              {
                label: t('col.quantity'),
                value: `${quantity(request.quantity, locale)} ${t(`uom.${request.uom}`)}${request.estimatedHides !== null && request.uom !== 'HIDE' ? ` (${t('hides', { count: request.estimatedHides })})` : ''}`,
                hint: request.uom !== request.baseUom ? t('detail.inBase', { quantity: quantity(request.baseQuantity, locale), uom: t(`uom.${request.baseUom}`) }) : undefined,
              },
              { label: t('col.supplier'), value: request.supplier ? request.supplier.name : t('supplier.none'), hint: from ? say(t, from) : undefined },
              ...(request.supplierArticleCode || request.supplierColourCode
                ? [{ label: t('detail.codes'), value: [request.supplierArticleCode, request.supplierColourCode].filter(Boolean).join(' · ') }]
                : []),
              ...(model.can.cost && request.currency
                ? [
                    { label: t('detail.price'), value: request.unitPrice ? `${unitPrice(request.unitPrice, request.currency, locale)} / ${t(`uom.${request.uom}`)}` : t('detail.noPrice') },
                    { label: t('col.value'), value: money(request.expectedAmount ?? null, request.currency, locale) },
                  ]
                : []),
            ]}
          />
        </Card>
        <Card padded>
          <h3 className="fw-by-h3">{t('detail.why')}</h3>
          <ol className="fw-rq-netting">
            {nettingPhrases(request, locale).map((words, index) => (
              <li key={`${words.key}-${index}`}>{say(t, words)}</li>
            ))}
          </ol>
          {rounding.length > 0 && (
            <>
              <h4 className="fw-rq-h4">{t('detail.rounding')}</h4>
              <ul className="fw-by-list">
                {rounding.map((words, index) => (
                  <li key={`${words.key}-${index}`}>{say(t, words)}</li>
                ))}
              </ul>
            </>
          )}
          {request.reorder?.note && <p className="fw-by-hint">{t('detail.ruleNote', { note: request.reorder.note })}</p>}
        </Card>
      </div>

      {request.plan && (request.plan.orders.length > 0 || request.plan.workOrders.length > 0) && (
        <Card padded>
          <h3 className="fw-by-h3">{t('detail.forWhat')}</h3>
          <div className="fw-by-stack">
            {request.plan.orders.length > 0 && (
              <p className="fw-by-text">
                {t('detail.salesOrders', { count: request.plan.orders.length })}{' '}
                <span className="fw-by-chips">
                  {request.plan.orders.map((order) => (
                    <Link key={order.id} className="fw-by-link" href={salesOrderHref(model.prefix, order.id)} target="_blank" rel="noopener noreferrer">
                      {order.number}
                    </Link>
                  ))}
                </span>
              </p>
            )}
            {request.plan.workOrders.length > 0 && (
              <p className="fw-by-text">
                {t('detail.workOrders', { count: request.plan.workOrders.length })}{' '}
                <span className="fw-by-chips">
                  {request.plan.workOrders.map((number) => (
                    <Link key={number} className="fw-by-link" href={workOrderHref(model.prefix, number)} target="_blank" rel="noopener noreferrer">
                      {number}
                    </Link>
                  ))}
                </span>
              </p>
            )}
          </div>
        </Card>
      )}

      {loaded && request.kind === 'REORDER' && (
        <Card padded>
          <h3 className="fw-by-h3">{t('detail.onOrder')}</h3>
          {loaded.onOrder.length === 0 ? (
            <p className="fw-by-hint">{t('detail.onOrderNone')}</p>
          ) : (
            <SummaryTable
              label={t('detail.onOrder')}
              density="compact"
              stackOnPhone
              columns={[t('detail.order'), t('col.status'), t('detail.open')]}
              align={['left', 'left', 'right']}
              rows={loaded.onOrder.map((line, index) => ({
                id: `${line.purchaseOrderId}-${index}`,
                cells: [
                  <Link key="po" className="fw-by-link" href={orderHref(model.prefix, line.purchaseOrderId)}>
                    {line.number}
                  </Link>,
                  t(`poStatus.${line.status}`),
                  `${quantity(line.openQuantity, locale)} ${t(`uom.${request.baseUom}`)}`,
                ],
              }))}
            />
          )}
        </Card>
      )}

      {loaded && (
        <Card padded>
          <h3 className="fw-by-h3">{t('detail.sources')}</h3>
          {loaded.sources.length === 0 ? (
            <p className="fw-by-hint">{t('detail.noSources')}</p>
          ) : (
            <div className="fw-by-stack" role="radiogroup" aria-label={t('detail.sources')}>
              {loaded.sources.map((source) => {
                const picked = chosen ? chosen === source.partyId : request.supplier?.id === source.partyId
                const terms = [
                  t(`preference.${source.preference}`),
                  t('detail.unit', { uom: t(`uom.${source.purchaseUom}`) }),
                  ...(source.minOrderQty ? [t('detail.minimum', { quantity: quantity(source.minOrderQty, locale) })] : []),
                  ...(source.orderMultiple ? [t('detail.multiple', { quantity: quantity(source.orderMultiple, locale) })] : []),
                  source.leadTimeDays === null ? t('detail.supplierLead') : t('detail.leadDays', { count: source.leadTimeDays }),
                  ...(model.can.cost ? [source.unitPrice ? unitPrice(source.unitPrice, source.currency, locale) : t('detail.noPrice')] : []),
                ]
                return (
                  <RadioCard
                    key={source.id}
                    variant="row"
                    name={`source-${request.id}`}
                    checked={picked}
                    selected={picked}
                    disabled={!mayPick || source.supplier.status === 'BLOCKED' || source.supplier.status === 'ARCHIVED'}
                    onChange={() => actions?.detail?.onSupplier?.(source.partyId === request.supplier?.id ? null : source.partyId)}
                    title={`${source.supplier.name}${source.supplierArticleCode ? ` · ${source.supplierArticleCode}` : ''}`}
                    description={terms.join(' · ')}
                  />
                )
              })}
              {!mayPick && <p className="fw-by-hint">{t(model.can.manage ? 'detail.pickClosed' : 'held.noManage')}</p>}
            </div>
          )}
        </Card>
      )}

      <Card padded>
        <h3 className="fw-by-h3">{t('detail.history')}</h3>
        <ul className="fw-by-list">
          {historyPhrases(request).map((entry, index) => (
            <li key={`${entry.words.key}-${index}`}>
              {entry.at ? <b>{formatDateTime(entry.at, place)}</b> : null}
              {entry.at ? ' — ' : ''}
              {say(t, entry.words)}
              {entry.words.key === 'history.ordered' && request.plan?.purchaseOrder && (
                <>
                  {' '}
                  <Link className="fw-by-link" href={orderHref(model.prefix, request.plan.purchaseOrder.id)}>
                    {t('detail.openOrder')}
                  </Link>
                </>
              )}
            </li>
          ))}
          {request.plan?.setAside?.note && <li>{t('detail.setAsideNote', { note: request.plan.setAside.note })}</li>}
        </ul>
      </Card>
    </>
  )
}
