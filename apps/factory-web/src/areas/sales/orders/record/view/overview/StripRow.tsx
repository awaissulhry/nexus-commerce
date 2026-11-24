'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { Button } from '@nexus/ui/primitives'
import { Banknote, CircleAlert, Hourglass, Pause, Ruler, ShieldAlert } from 'lucide-react'
import { useSearchParams } from 'next/navigation'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useScopedT, useT } from '../../../../../../lib/i18n/provider'
import { ageOf } from '../../../../../../lib/production/model'
import { useProductionWords } from '../../../../../../lib/production/words'
import { TabLink } from '../../../../../../lib/tab-link/TabLink'
import { tabHref } from '../../../../../_shared/record-frame/address'
import type { Order } from '../../../api'
import { dayInstant, readOnlyOnPage } from '../../../model'
import { YesDoorView } from '../../../depth/view/DepthBand'
import { NAMESPACE as DEPTH } from '../../../depth/model'
import { say } from '../../overview/model'
import { creditLinesOf, refuseLineOf, type StripDoor, type WhereStrip } from '../../overview/where'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
// F-CO-K2: the row is the shared overview kit's Strip (its look comes with it, on Overview and on Production › Problems & holds alike)
import { Strip, StripSaid } from '../../../../../_shared/record-overview/Overview'

/**
 * F-PT-301 (order PRODUCTION tab; plan D2 / L9) — ONE strip row for what stops the order, moved out of WhereCard unchanged (F-OO-105,
 * F-OO-106, F-OO-109): Overview's "Where it is now" and Production › Problems & holds draw the SAME rows with the SAME doors
 * (whereStripsOf + stripDoorsOf — one rule: a door the reader may not use is not drawn).
 * F-CO-K2: the row itself is the shared overview kit's `Strip` + `StripSaid` (mark | words | doors, the tone's rule); this file keeps
 * the order's kinds, words, quiet lines and doors.
 */

/** The Finance page's catalogue: the credit strip names what its check found in its words (WhereCard's credit dialogs too). */
export const CREDIT_NS = ['sales-credit'] as const

// ---- F-OO-105 (order overview §1.3; review F1, F8, F13): the strips — words, age, and each one's real doors ----------------------
/** Each strip's tone (its left rule) and mark: what stops the work hardest reads danger. */
const MARK: Readonly<Record<WhereStrip['kind'], ReactNode>> = {
  yes: <Hourglass size={14} aria-hidden />,
  credit: <CircleAlert size={14} aria-hidden />,
  review: <Ruler size={14} aria-hidden />,
  deposit: <Banknote size={14} aria-hidden />,
  quality: <ShieldAlert size={14} aria-hidden />,
  production: <Pause size={14} aria-hidden />,
  pause: <Pause size={14} aria-hidden />,
  other: <CircleAlert size={14} aria-hidden />,
}
export function toneOf(strip: WhereStrip, today: string): 'warning' | 'danger' | 'info' {
  if (strip.kind === 'credit' || strip.kind === 'quality') return 'danger'
  if (strip.kind === 'deposit') return strip.state === 'MISSING' || (strip.due !== null && strip.due < today) ? 'danger' : 'warning'
  return strip.kind === 'pause' ? 'info' : 'warning'
}

/** "WO-00021, WO-00022 and 2 more": at most two numbers named. */
function numbersOf(t: (key: string, params?: Record<string, string | number>) => string, numbers: readonly string[]): string {
  const named = numbers.slice(0, 2).join(', ')
  return numbers.length > 2 ? t('where.strip.andMore', { numbers: named, count: numbers.length - 2 }) : named
}

/** One strip: its mark, its words with the age (the day in its title), its quiet lines, its doors. */
export function StripRow({ strip, doors, order, model, actions, now }: { strip: WhereStrip; doors: readonly StripDoor[]; order: Order; model: OrderRecordModel; actions?: OrderRecordActions; now: number }) {
  const t = useT('orders')
  const c = useT(CREDIT_NS[0]) // F-OO-106: the findings in Finance's own words
  const w = useProductionWords()
  const locale = useLocale()
  const day = (value: string) => formatDate(/^\d{4}-\d{2}-\d{2}$/.test(value) ? dayInstant(value) : value, { locale })
  const reasons = 'reasons' in strip ? strip.reasons.map((entry) => say(entry, locale)).join(' · ') : ''
  const title = (() => {
    switch (strip.kind) {
      case 'yes':
        return strip.who ? t('where.strip.yes.waits', { who: strip.who }) : strip.asked ? t('where.strip.yes.asked') : t('where.strip.yes.nobody')
      case 'credit':
        // F-OO-106 (walk #2): asked of someone this reader cannot name — "waits for a yes that is asked", never "nobody asked".
        return strip.who ? t('where.strip.credit.waits', { who: strip.who }) : strip.asked ? t('where.strip.credit.asked') : t('where.strip.credit.nobody')
      case 'review':
        return strip.count ? t('where.strip.review', { count: strip.count }) : t('where.strip.reviewUnits')
      case 'deposit':
        if (strip.state === 'MISSING') return t('held.depositMissing')
        if (!strip.due) return t('where.strip.deposit.open')
        return strip.due < model.today ? t('where.strip.deposit.overdue', { date: day(strip.due) }) : t('where.strip.deposit.waiting', { date: day(strip.due) })
      case 'quality':
      case 'production':
        return reasons ? t(`where.strip.${strip.kind}`, { reasons }) : t(`where.strip.${strip.kind}Plain`)
      case 'pause':
        return t('where.strip.pause')
      case 'other':
        return reasons
    }
  })()
  // The quiet lines: the work orders it stops (named, those not reached counted — F13), a shared one's own page, who releases quality.
  const lines: string[] = []
  if ('workOrders' in strip) {
    const { reached, notReached } = strip.workOrders
    const numbers = reached.flatMap((entry) => (entry.number ? [entry.number] : []))
    const outside = notReached > 0 ? t('where.strip.notReached', { count: notReached }) : ''
    if (numbers.length > 0) lines.push([t('where.strip.on', { count: reached.length + notReached, numbers: numbersOf(t, numbers) }), outside].filter(Boolean).join(' '))
    else if (notReached > 0) lines.push(t('where.strip.onlyNotReached', { count: notReached }))
    const shared = reached.flatMap((entry) => (entry.shared && entry.number && strip.kind !== 'quality' ? [entry.number] : []))
    if (shared.length > 0) lines.push(t('where.strip.shared', { count: shared.length, numbers: numbersOf(t, shared) }))
    if (strip.kind === 'quality') lines.push(t('where.strip.qualityWho'))
    // F-PT-301 (plan D2 / L9): a hold of this order's own work orders this reader may not lift — no grey door (stripDoorsOf leaves it
    // out), ONE line says who does it; on Overview and on Production alike. Read-only reads the strip's words only.
    const readOnly = readOnlyOnPage(model.can, { assignSupervisor: model.people?.mayAssign, qualityHold: model.workOrderActs?.can.qualityHold })
    if ((strip.kind === 'production' || strip.kind === 'pause') && doors.length === 0 && !readOnly && reached.some((entry) => !entry.shared)) lines.push(t('wo.heldHold'))
  }
  if (strip.kind === 'review' && order.lines.filter((line) => line.kind === 'MADE_TO_MEASURE').length > 1) lines.push(t('where.strip.reviewDoor.several'))
  // ---- F-OO-106: the credit strip's own lines — what was found, the last answer to a yes, who checks it; never an amount ----
  if (strip.kind === 'credit')
    for (const line of creditLinesOf(model.credit ?? null, order.status === 'PENDING_APPROVAL'))
      lines.push(t(line.phrase.key, { ...(line.phrase.params ?? {}), ...(line.date ? { date: day(line.date) } : {}), ...(line.findings ? { findings: line.findings.map((code) => c(`finding.${code}`)).join(' · ') } : {}) }))
  // What a no does, beside a yes decided here (the band's Refuse… dialog says nothing of it): the credit's leaves it held, the order's cancels it.
  const refuse = refuseLineOf(strip, doors)
  if (refuse) lines.push(t(refuse.key))
  // ---- end F-OO-106
  const age = ageOf(strip.since, now)
  return (
    <Strip tone={toneOf(strip, model.today)} mark={MARK[strip.kind]} doors={doors.length > 0 ? doors.map((door) => <StripDoorView key={door.kind} door={door} order={order} model={model} actions={actions} />) : undefined}>
      <StripSaid title={title} since={age && strip.since ? { iso: strip.since, day: day(strip.since), words: w.t(age.key, age.params) } : null} lines={lines} />
    </Strip>
  )
}

/** One door, the real command or link (held with words when the reader may not). */
function StripDoorView({ door, order, model, actions }: { door: StripDoor; order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const scoped = useScopedT('orders') // a held phrase of the work-order acts may name another catalogue
  const d = useT(DEPTH)
  const search = useSearchParams()?.toString() ?? ''
  const recordHref = `${model.prefix}/sales/orders/${order.id}`
  switch (door.kind) {
    case 'yes':
      return <YesDoorView door={door.door} onYes={actions?.yes} />
    case 'ask':
      return (
        <Button size="sm" variant="primary" heldReason={door.held ? d(door.held.key, door.held.params) : null} onClick={() => actions?.depth?.onDialog?.({ kind: 'ask', note: '' })}>
          {d('wait.ask')}
        </Button>
      )
    case 'withdraw':
      return (
        <Button size="sm" heldReason={door.held ? d(door.held.key, door.held.params) : null} onClick={() => actions?.depth?.onDialog?.({ kind: 'withdraw' })}>
          {d('wait.withdraw')}
        </Button>
      )
    case 'payment':
      return (
        <Button size="sm" heldReason={door.held ? t(door.held.key, door.held.params) : null} onClick={() => actions?.onDialog?.({ kind: 'depositPayment', requestId: door.requestId })}>
          {t('deposit.record')}
        </Button>
      )
    case 'tab':
      return (
        <Button size="sm" variant="quiet" asChild>
          <TabLink href={`${tabHref(recordHref, door.tab, search)}${door.anchor ? `#${door.anchor}` : ''}`}>{t(`waiting.go.${door.tab}`)}</TabLink>
        </Button>
      )
    case 'lift':
      return (
        <Button size="sm" heldReason={door.held ? scoped(door.held.key, door.held.params) : null} onClick={() => actions?.workOrderActs?.onAct?.(door.row, 'lift')}>
          {t(door.label)}
        </Button>
      )
    // F-OO-109: Lift… for the strip's own work orders — the ONE lift dialog (the work-order acts'), all or none.
    case 'liftMany':
      return (
        <Button size="sm" heldReason={door.held ? scoped(door.held.key, door.held.params) : null} onClick={() => actions?.workOrderActs?.onLiftMany?.({ kind: door.holdKind, workOrders: door.workOrders, shared: door.shared, notReached: door.notReached })}>
          {t(door.label)}
        </Button>
      )
    case 'workOrder':
      return (
        <Button size="sm" variant="quiet" asChild>
          <Link href={door.href}>{t('where.strip.openWo', { number: door.number })}</Link>
        </Button>
      )
    case 'quality':
      // F-PT-301 (L9): drawn only for who may open Quality's holds (stripDoorsOf leaves it out otherwise).
      return (
        <Button size="sm" variant="quiet" asChild>
          <Link href={door.href} aria-label={t('where.strip.releaseOf', { number: door.number })}>
            {t('where.strip.release')}
          </Link>
        </Button>
      )
    // ---- F-OO-106: the order's own credit hold — its dialogs in the page's one slot; Try again when its read failed ----
    case 'creditCheck':
      return (
        <Button size="sm" heldReason={door.held ? t(door.held.key, door.held.params) : null} onClick={() => actions?.onDialog?.({ kind: 'creditCheck' })}>
          {t('where.credit.check')}
        </Button>
      )
    case 'creditAsk':
      return (
        <Button size="sm" heldReason={door.held ? t(door.held.key, door.held.params) : null} onClick={() => actions?.onDialog?.({ kind: 'creditAsk', checkId: door.checkId })}>
          {t('where.credit.ask')}
        </Button>
      )
    case 'creditRetry':
      return (
        <Button size="sm" onClick={() => actions?.credit?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      )
    // ---- end F-OO-106
    case 'review':
      return door.href ? (
        <Button size="sm" variant="quiet" asChild>
          <Link href={door.href}>{t('where.strip.reviewDoor.open')}</Link>
        </Button>
      ) : (
        <Button size="sm" variant="quiet" heldReason={door.held ? t(door.held.key, door.held.params) : null}>
          {t('where.strip.reviewDoor.open')}
        </Button>
      )
  }
}
// ---- end F-OO-105

