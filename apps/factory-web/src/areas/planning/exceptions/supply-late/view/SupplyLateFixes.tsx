'use client'

import Link from 'next/link'
import { CalendarClock, ExternalLink, RefreshCw, ShoppingCart, Truck, Waypoints } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Pill, Skeleton, Spinner } from '@nexus/ui/primitives'
import { INTL_LOCALE, type Locale } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { SupplyLate } from '../api'
import { boardHref, chaseHref, checkHeld, orderHref, planHref, purchaseOrderOf, repromiseHeld, repromiseHref, riskTone, supplierHref, SUPPLY_LATE_NAMESPACE, type Place } from '../model'
import type { SupplyLateActions, SupplyLateSlot } from '../use-supply-late'
import '../supply-late.css'

const day = (value: string | null, locale: Locale): string => {
  if (!value) return '—'
  const [year, month, date] = value.slice(0, 10).split('-').map(Number) as [number, number, number]
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(Date.UTC(year, month - 1, date)))
}

/** An instant as the site's day in the same words as the others ("16 nov 2026"). */
const instantDay = (value: string, locale: Locale, timeZone = 'Europe/Rome'): string => new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value))

/**
 * The fixes of a supply too late (design planning.exceptions pop:detail "Fixes: chase PO-0091 · move WO-0221 on the board · buy
 * elsewhere · re-promise (W2b)"), inside the exception's DetailModal, read fresh when it opens: Chase the purchase order (its
 * record with the chase dialog), Move each work order it feeds on the board (its planned start against the first day it can
 * start with the material), Buy elsewhere from another approved source (its lead time, the day it would arrive ordered today,
 * in time or not; the material's line in What to buy & make), Re-promise each order line it feeds (Promise dates with its
 * Re-promise; Review when one waits). How it was found (the nightly run or the supplier's new date) and Check now. Each fix is a
 * real link: ⌘-click keeps the queue open while fixing. No money.
 */
export function SupplyLateFixes({ slot, actions, place, row, timeZone }: { slot: SupplyLateSlot; actions?: SupplyLateActions; place: Place; row: { id: string; record: { type: string; id: string } | null }; timeZone?: string }) {
  return (
    <WithMessages namespaces={[SUPPLY_LATE_NAMESPACE]}>
      <FixesBody slot={slot} actions={actions} place={place} row={row} timeZone={timeZone} />
    </WithMessages>
  )
}

function FixesBody({ slot, actions, place, row, timeZone }: { slot: SupplyLateSlot; actions?: SupplyLateActions; place: Place; row: { id: string; record: { type: string; id: string } | null }; timeZone?: string }) {
  const t = useT(SUPPLY_LATE_NAMESPACE)
  const locale = useLocale()
  const loaded = slot.detail?.id === row.id ? slot.detail.loaded : null
  if (!loaded || loaded.status === 'loading') {
    return (
      <section className="fw-psl" aria-busy="true" aria-labelledby="fw-psl-title">
        <h3 id="fw-psl-title" className="fw-psl-h3">
          {t('supplyLate.fixes')}
        </h3>
        <Skeleton height={18} />
        <Skeleton height={18} />
      </section>
    )
  }
  if (loaded.status === 'error') {
    return (
      <section className="fw-psl" aria-labelledby="fw-psl-title">
        <h3 id="fw-psl-title" className="fw-psl-h3">
          {t('supplyLate.fixes')}
        </h3>
        <Banner
          tone="danger"
          title={t('supplyLate.fixesError')}
          action={
            <Button size="sm" onClick={() => actions?.onRetryDetail?.()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(loaded.problem)}
        </Banner>
      </section>
    )
  }
  const value: SupplyLate = loaded.value
  const fixes = value.fixes
  const purchaseOrderId = purchaseOrderOf({ fixes, record: value.record ?? row.record })
  const held = checkHeld({ fixes, record: value.record ?? row.record }, slot.can, slot.checking)
  return (
    <section className="fw-psl" aria-labelledby="fw-psl-title">
      <div className="fw-psl-head">
        <h3 id="fw-psl-title" className="fw-psl-h3">
          {t('supplyLate.fixes')}
        </h3>
        <span className="fw-psl-inline">
          <Pill tone={value.foundBy === 'SUPPLIER_DATE' ? 'info' : 'neutral'}>{t(`supplyLate.foundBy.${value.foundBy}`)}</Pill>
          <Button size="sm" variant="quiet" heldReason={held ? t(held) : null} onClick={() => purchaseOrderId && actions?.onCheck?.(purchaseOrderId)}>
            {slot.checking ? <Spinner size={12} /> : <RefreshCw size={13} aria-hidden />} {t('supplyLate.check')}
          </Button>
        </span>
      </div>
      {slot.problem && <Banner tone="danger" title={t(slot.problem)} />}
      {slot.checked && <Banner tone="success" title={t('supplyLate.checked', { raised: slot.checked.raised, open: slot.checked.stillOpen, cleared: slot.checked.cleared })} />}
      {!fixes ? (
        <p className="fw-psl-hint">{t('supplyLate.noFixes')}</p>
      ) : (
        <ol className="fw-psl-fixes">
          <li className="fw-psl-fix">
            <span className="fw-psl-fix-head">
              <Truck size={14} aria-hidden /> <b>{t('supplyLate.chase.title')}</b>
            </span>
            {fixes.chase ? (
              <>
                <span className="fw-psl-text">
                  {t('supplyLate.chase.what', { order: fixes.chase.purchaseOrder.number, line: fixes.chase.line.seq, item: fixes.chase.line.item, supplier: fixes.chase.supplier?.name ?? t('supplyLate.chase.noSupplier') })}
                </span>
                <span className="fw-psl-sub">
                  {t('supplyLate.chase.dates', { supply: day(fixes.chase.supplyDate, locale), need: day(fixes.chase.needDate, locale) })}
                  {fixes.chase.daysLate ? ` · ${t('supplyLate.daysLate', { count: fixes.chase.daysLate })}` : ''}
                </span>
                <span>
                  <FixLink href={chaseHref(fixes.chase, place)} held={slot.can.purchasing ? null : t('supplyLate.held.noPurchasing')} label={t('supplyLate.chase.verb', { order: fixes.chase.purchaseOrder.number })} first />
                </span>
              </>
            ) : (
              <span className="fw-psl-hint">{t('supplyLate.chase.none')}</span>
            )}
          </li>
          <li className="fw-psl-fix">
            <span className="fw-psl-fix-head">
              <Waypoints size={14} aria-hidden /> <b>{t('supplyLate.move.title')}</b>
            </span>
            {fixes.move.length === 0 ? (
              <span className="fw-psl-hint">{t('supplyLate.move.none')}</span>
            ) : (
              <ul className="fw-psl-list">
                {fixes.move.map((entry) => (
                  <li key={entry.workOrder.id} className="fw-psl-entry">
                    <span className="fw-psl-text">
                      {t('supplyLate.move.what', {
                        order: entry.workOrder.number,
                        start: entry.plannedStart ? instantDay(entry.plannedStart, locale, timeZone) : t('supplyLate.move.notOnBoard'),
                        earliest: entry.earliestStart ? day(entry.earliestStart, locale) : t('supplyLate.move.unknown'),
                      })}{' '}
                      {entry.inTime === null ? null : <Pill tone={entry.inTime ? 'success' : 'warning'}>{t(entry.inTime ? 'supplyLate.move.inTime' : 'supplyLate.move.late')}</Pill>}
                    </span>
                    <FixLink href={boardHref(entry.workOrder.id, place)} held={null} label={t('supplyLate.move.verb', { order: entry.workOrder.number })} />
                  </li>
                ))}
              </ul>
            )}
          </li>
          <li className="fw-psl-fix">
            <span className="fw-psl-fix-head">
              <ShoppingCart size={14} aria-hidden /> <b>{t('supplyLate.elsewhere.title')}</b>
            </span>
            {fixes.buyElsewhere.length === 0 ? (
              <span className="fw-psl-hint">{t('supplyLate.elsewhere.none')}</span>
            ) : (
              <ul className="fw-psl-list">
                {fixes.buyElsewhere.map((entry) => (
                  <li key={entry.sourceId} className="fw-psl-entry">
                    <span className="fw-psl-text">
                      <Link className="fw-psl-link" href={supplierHref(entry.supplier, place)}>
                        {entry.supplier.name || entry.supplier.code}
                      </Link>
                      {': '}
                      {entry.leadTimeDays === null ? t('supplyLate.elsewhere.noLead') : t('supplyLate.elsewhere.what', { count: entry.leadTimeDays, day: day(entry.arrives, locale) })}{' '}
                      {entry.inTime === null ? null : <Pill tone={entry.inTime ? 'success' : 'warning'}>{t(entry.inTime ? 'supplyLate.elsewhere.inTime' : 'supplyLate.elsewhere.late')}</Pill>}
                    </span>
                    <FixLink href={planHref(entry.requirementId, place)} held={null} label={t('supplyLate.elsewhere.verb')} />
                  </li>
                ))}
              </ul>
            )}
          </li>
          <li className="fw-psl-fix">
            <span className="fw-psl-fix-head">
              <CalendarClock size={14} aria-hidden /> <b>{t('supplyLate.repromise.title')}</b>
            </span>
            {fixes.repromise.length === 0 ? (
              <span className="fw-psl-hint">{t('supplyLate.repromise.none')}</span>
            ) : (
              <ul className="fw-psl-list">
                {fixes.repromise.map((entry) => {
                  const verb = repromiseHeld(entry, slot.can)
                  return (
                    <li key={entry.orderLine.id} className="fw-psl-entry">
                      <span className="fw-psl-text">
                        <Link className="fw-psl-link" href={orderHref(entry.order, place)}>
                          {t('supplyLate.repromise.line', { order: entry.order.number, line: entry.orderLine.seq })}
                        </Link>{' '}
                        · {entry.customer.name}: {t('supplyLate.repromise.what', { current: day(entry.current, locale), finish: day(entry.finish, locale) })}{' '}
                        {entry.risk ? <Pill tone={riskTone(entry.risk)}>{t(`risk.${entry.risk}`)}</Pill> : null} {entry.waiting ? <Pill tone="info">{t('supplyLate.repromise.waiting')}</Pill> : null}
                      </span>
                      <FixLink href={repromiseHref(entry.orderLine.id, place)} held={verb.held ? t(verb.held) : null} label={t(verb.label)} />
                    </li>
                  )
                })}
              </ul>
            )}
          </li>
        </ol>
      )}
      <p className="fw-psl-hint">{t('supplyLate.newTab')}</p>
    </section>
  )
}

function FixLink({ href, held, label, first = false }: { href: string; held: string | null; label: string; first?: boolean }) {
  if (held) {
    return (
      <Button size="sm" variant="quiet" heldReason={held}>
        <ExternalLink size={13} aria-hidden /> {label}
      </Button>
    )
  }
  return (
    <Button size="sm" variant={first ? 'secondary' : 'quiet'} asChild>
      <Link href={href}>
        <ExternalLink size={13} aria-hidden /> {label}
      </Link>
    </Button>
  )
}
