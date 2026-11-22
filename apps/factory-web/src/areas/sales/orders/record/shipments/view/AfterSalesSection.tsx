'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { MenuItemDef } from '@nexus/ui/components'
import { Pill, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { Order } from '../../../api'
import { complaintHref, returnHref } from '../../links/model'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { LineMenuButton } from '../../view/LineMenu'
import { PartFailed, PartReading, Section } from '../../view/production/Kit' // F-OS-104: the Production kit, in place
import { afterSalesOf, type CaseRow } from '../after-sales'
import { Button } from '@nexus/ui/primitives' // F-OS-303
import { afterSalesDoorsOf } from '../doors' // F-OS-303
import { copyLinkTo, kitId } from './hrefs'
import { sentenceOf, useShipSay } from './say'

/**
 * F-OS-104 (order SHIPMENTS tab, 10-design §6) — section 3 "Complaints & returns" (#after-sales; replaces the order links' card on this
 * tab), drawn: titled by what the reader may see; the answer ("2 open · 1 waiting for your yes · 1 closed"); ONE list, newest first —
 * Case (kind + number, a real link to its page) · About (its shipment's row, or the whole order) · What · Status · Next — the closed
 * cases behind "Show N closed", "Showing the latest 50" when the list is cut. Nothing reported: one line. Neither right: no section.
 * F-OS-303: Open a return… and Log a complaint… on the head, Send a claim link… in its ⋯ — their pages' own windows, in place (the
 * container mounts them). Draws its model (shipments/after-sales.ts, doors.ts).
 */
export function AfterSalesSection({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('order-shipments')
  const o = useT('orders')
  const say = useShipSay()
  const [showClosed, setShowClosed] = useState(false)
  const after = afterSalesOf(model.links, order.chain.shipments)
  if (after.state === 'hidden') return null
  const info = <p>{t('after.info')}</p>
  if (after.state === 'loading')
    return (
      <Section id={kitId('after-sales')} title={o('links.title')} answer={o('links.loading')} info={info}>
        <PartReading rows={2} height={30} />
      </Section>
    )
  if (after.state === 'error')
    return (
      <Section id={kitId('after-sales')} title={o('links.title')} info={info}>
        <PartFailed part={t('after.part')} problem={after.problem} onRetry={actions?.links?.onRetry} />
      </Section>
    )
  const links = model.links?.state === 'ready' ? model.links.links : null
  // F-OS-303: Open a return… · Log a complaint… (their pages' own windows, in place; hidden without the right, held only while nothing
  // has left), and Send a claim link… in the ⋯ (the order's link).
  const doors = afterSalesDoorsOf(order, model.can)
  // (Drawn by the right and the state alone — the container's act opens the window; the design gallery has none.)
  const onAfter = actions?.shipmentsTab?.onAfterSales
  const buttons = doors.buttons.map((door) => (
    <Button key={door.kind} size="sm" heldReason={door.held ? say(door.held) : null} onClick={() => onAfter?.(door.kind)}>
      {say(door.label)}
    </Button>
  ))
  const items: MenuItemDef[] = [
    ...(doors.claim ? [{ id: 'claim', label: say(doors.claim.label), disabled: !!doors.claim.held, description: doors.claim.held ? say(doors.claim.held) : undefined, onSelect: doors.claim.held ? undefined : () => onAfter?.('claim') }] : []),
    ...(links?.returns !== null ? [{ id: 'returns', label: t('after.openReturns'), href: `${model.prefix}/sales/returns` }] : []),
    ...(links?.complaints !== null ? [{ id: 'complaints', label: t('after.openComplaints'), href: `${model.prefix}/quality/complaints` }] : []),
    { id: 'copy', label: t('where.copyLink'), onSelect: () => copyLinkTo('after-sales') },
  ]
  const title = say(after.title)
  const shown = [...after.open, ...(showClosed ? after.closed : [])]
  return (
    <Section id={kitId('after-sales')} title={title} answer={sentenceOf(after.answer.map(say))} buttons={buttons} info={info} more={<LineMenuButton label={t('after.more')} items={items} />}>
      {shown.length > 0 ? (
        <div className="fw-os-al" role="table" aria-label={title}>
          <div className="fw-os-ar is-hd" role="row">
            <span role="columnheader">{t('after.col.case')}</span>
            <span role="columnheader">{t('after.col.about')}</span>
            <span role="columnheader">{t('after.col.what')}</span>
            <span role="columnheader">{t('after.col.status')}</span>
            <span role="columnheader">{t('after.col.next')}</span>
          </div>
          {shown.map((row) => (
            <CaseRowView key={`${row.kind}-${row.id}`} row={row} prefix={model.prefix} />
          ))}
        </div>
      ) : null}
      {after.closed.length > 0 || after.truncated ? (
        <div className="fw-os-al-foot">
          {after.closed.length > 0 ? (
            <button type="button" className="fw-pt-link" aria-expanded={showClosed} onClick={() => setShowClosed((value) => !value)}>
              {showClosed ? t('after.hideClosed') : t('after.showClosed', { count: after.closed.length })}
            </button>
          ) : null}
          {after.truncated ? <span className="fw-os-mu">{t('after.truncated')}</span> : null}
        </div>
      ) : null}
    </Section>
  )
}

function CaseRowView({ row, prefix }: { row: CaseRow; prefix: string }) {
  const t = useT('order-shipments')
  const say = useShipSay()
  const locale = useLocale()
  const href = row.kind === 'return' ? returnHref(prefix, row.id) : complaintHref(prefix, row.id)
  const about = row.about
  return (
    <div className="fw-os-ar" role="row">
      <div className="fw-os-ar-k" role="cell">
        <Tag tone={row.kind === 'return' ? 'info' : 'warning'}>{t(`after.kind.${row.kind}`)}</Tag>
        <Link className="fw-pt-link" href={href}>
          {row.number}
        </Link>
      </div>
      <div className="fw-os-ar-a" role="cell">
        {about.kind === 'shipment' ? (
          about.onThisOrder ? (
            <a className="fw-pt-link" href={`#about-Shipment-${about.id}`}>
              {about.number} ›
            </a>
          ) : (
            about.number
          )
        ) : (
          t('after.about.order')
        )}
      </div>
      <div className="fw-os-ar-w" role="cell">
        {row.what.map(say).join(' · ')}
      </div>
      <div className="fw-os-ar-s" role="cell">
        <Pill tone={row.tone}>{say(row.status)}</Pill>
        {row.waiting ? <Tag tone="warning">{t('after.waiting')}</Tag> : null}
      </div>
      <div className="fw-os-ar-x" role="cell">
        {row.next.map((next) => (
          <span key={next.key}>{say(next)}</span>
        ))}
        {row.replacement ? (
          <Link className="fw-pt-link" href={`${prefix}/sales/orders/${encodeURIComponent(row.replacement.id)}`}>
            {t('after.next.replacement', { number: row.replacement.number })}
          </Link>
        ) : null}
        <span className="fw-os-mu">{formatDate(row.at, { locale })}</span>
      </div>
    </div>
  )
}
