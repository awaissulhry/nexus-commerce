'use client'

import { useState, type ReactNode } from 'react' // F-OO-105: "Show {n} more"
import Link from 'next/link' // F-OO-105
import { Card, Menu } from '@nexus/ui/components' // F-OO-107: Menu (More ▾)
import { Button, Skeleton } from '@nexus/ui/primitives'
import { Banknote, CircleAlert, Hourglass, Pause, Ruler, ShieldAlert } from 'lucide-react' // F-OO-105: each strip's mark
import { ChevronDown } from 'lucide-react' // F-OO-107: More ▾
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useScopedT, useT } from '../../../../../../lib/i18n/provider'
import { useProductionWords } from '../../../../../../lib/production/words'
import { FreshnessLine } from '../../../../../../lib/production/view/FreshnessLine'
import { StageStrip } from '../../../../../../lib/production/view/StageStrip'
import type { Order } from '../../../api'
import type { Phrase } from '../../../model'
import { readOf, say, type WaitingState } from '../../overview/model' // F-OP-301 (walk #1–#3): the ONE waiting list's state
import { headlineOf, stageStripOf, stagesShown } from '../../overview/where'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { useSearchParams } from 'next/navigation'
import { tabHref } from '../../../../../_shared/record-frame/address'
import './where.css' // F-OO-103: the section 1 frame's own CSS
// ---- F-OO-105: the strips' doors — the band's yes door (DepthBand, imported as it is), the depth's words, the page's tab links ----
import { YesDoorView } from '../../../depth/view/DepthBand'
import { NAMESPACE as DEPTH } from '../../../depth/model'
import { ageOf } from '../../../../../../lib/production/model'
import { TabLink } from '../../../../../../lib/tab-link/TabLink'
import { dayInstant, readOnlyOnPage } from '../../../model'
import { STRIPS_SHOWN, stripDoorsOf, whereStripsOf, type StripDoor, type StripDoorsInput, type WhereStrip } from '../../overview/where'
// ---- end F-OO-105
import { whereMovesOf, type WhereMove, type WhereMoveId } from '../../overview/where' // F-OO-107: the order's own moves
// ---- F-OO-106: the credit strip's own doors, lines and dialogs (Check credit again, Ask for a yes…) — the page's dialog frame ----
import { Banner, Field } from '@nexus/ui/components'
import { Textarea } from '../../../../../../lib/i18n/ds-parts'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { CREDIT_ASK_NOTE_MAX, creditLinesOf, refuseLineOf } from '../../overview/where'
import { Frame } from '../Dialogs'
// ---- end F-OO-106

/**
 * F-OO-100 (order overview lane: one file per card) — "Where it is now".
 *
 * F-OO-103 (order overview §1.1, §1.6; review F8, F14): the section 1 frame. It keeps the title, "Live · as of 10:42", the headline
 * (the status and the stage, F-OO-101) with its quiet line, and the five stages with their link to Production's work orders and their
 * quiet line (F-OO-102). Between the headline and the stages sits the strips slot (one strip per hold or wait, most blocking first,
 * F-OO-104 / F-OO-105: they read OverviewTab's ONE waiting list, `waiting.holds`); under the stages the moves slot (the order's own
 * moves, F-OO-107). What left, each living on in ONE other place: Who acts next (Requests & changes' groups), Ex-factory and how it
 * moved (Next dates' Promised row), Health and the customer's Urgent (the band's chip and tag), Bundles in work (Progress by line's
 * counts), the deposit note on Preparing (the deposit strip).
 */
export function WhereCard({ order, model, actions, waiting }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; /** OverviewTab's ONE waiting list: the strips read its holds (F-OO-104). */ waiting: WaitingState }) {
  const t = useT('orders')
  const w = useProductionWords()
  const locale = useLocale()
  const search = useSearchParams()?.toString() ?? '' // F-OP-104: the stages' door keeps the dock's scope
  const state = model.production ?? null
  const read = readOf(state)
  const headline = read?.headline ?? null
  const loading = !state || state.status === 'loading'
  // F-OO-101: the status word, then the stage word ("In production · Quality check"); dated words say their days in the page's way.
  const words = headlineOf(order, headline)
  const dated = (phrase: Phrase): string => t(phrase.key, Object.fromEntries(Object.entries(phrase.params ?? {}).map(([key, value]) => [key, typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? formatDate(value, { locale }) : value])))
  const sentence = [words.status ? dated(words.status) : null, words.stage ? w.t(`parts.stage.${words.stage}`) : null].filter(Boolean).join(' · ')
  const quiet = words.note ? t(words.note.key, words.note.stage ? { stage: w.t(`parts.stage.${words.note.stage}`) } : undefined) : null
  const strip = stageStripOf(order, headline, read?.dates ?? null) // F-OO-102: the dots in the headline's own state
  // F-OP-301 (walk #2): section 1 names no wait at all now (Who acts next lives in Requests & changes' groups, F-OO-103), so it can
  // never say a stale "Waiting on us · 5 d" beside a card that says nothing waits — and it never reads the headline's kept waiting list
  // (end check fix wave: named in words, so the source test that no such read exists reads only code).
  // F-OO-104: its strips name what stops the order (holds, the yes, the deposit) — the ONE list's HOLD rows, never a "waiting on".
  return (
    <Card padded className="fw-so-where">
      <div className="fw-so-card-head">
        <h2 className="fw-so-h2">{t('overview.where')}</h2>
        <FreshnessLine mode={model.liveState === 'live' ? 'live' : model.liveState === 'offline' ? 'offline' : 'connecting'} asOf={read?.asOf ?? null} />
      </div>
      <div className="fw-so-where-said">
        {loading ? <Skeleton width={260} height={24} /> : <p className="fw-so-headline">{sentence}</p>}
        {!loading && quiet ? <p className="fw-so-hint">{quiet}</p> : null}
      </div>
      {/* ---- F-OO-103: the strips slot — one strip per hold or wait, most blocking first, each with its real door (F-OO-104, F-OO-105) ---- */}
      {/* F-OO-106: the credit strip names what its check found in the Finance page's own words (sales-credit finding.*). */}
      <WithMessages namespaces={CREDIT_NS}>
        <Strips order={order} model={model} actions={actions} waiting={waiting} retry={!stagesShown(words.state)} />
      </WithMessages>
      {stagesShown(words.state) ? (
        <div className="fw-so-where-stages">
          {/* F-OP-104: the stages are one real link to Production's work orders. F-OO-102: drawn in the headline's own state. */}
          <StageStrip
            face="office"
            layout="auto"
            label={t('overview.where')}
            {...strip}
            stageHref={`${tabHref(`${model.prefix}/sales/orders/${order.id}`, 'production', search)}#work-orders`}
            stageLinkLabel={words.state === 'ALL_DONE' ? t('where.stagesDone') : t('doors.stages', { stage: strip.stage ? w.t(`parts.stage.${strip.stage}`) : w.t('parts.stage.unknown') })}
            loading={loading}
            problem={state?.status === 'failed'}
            onRetry={() => actions?.onRetryProduction?.()}
          />
          {/* F-OO-102: derived, and it says so. */}
          {!loading && state?.status !== 'failed' ? <p className="fw-so-hint">{w.t('parts.stage.office.setBy')}</p> : null}
        </div>
      ) : null}
      {/* ---- F-OO-103: the moves slot — the order's own moves: Mark ready…, Hold the whole order…, More ▾ (F-OO-107, F-OO-108) ---- */}
      <Moves order={order} model={model} actions={actions} />
      {/* F-OO-106: the credit strip's dialogs, in the page's one slot (Overview's own: use-overview-acts). */}
      <CreditDialogs order={order} model={model} actions={actions} />
    </Card>
  )
}

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
function toneOf(strip: WhereStrip, today: string): 'warning' | 'danger' | 'info' {
  if (strip.kind === 'credit' || strip.kind === 'quality') return 'danger'
  if (strip.kind === 'deposit') return strip.state === 'MISSING' || (strip.due !== null && strip.due < today) ? 'danger' : 'warning'
  return strip.kind === 'pause' ? 'info' : 'warning'
}

/**
 * The strips slot: at most four strips, the rest behind "Show {n} more"; while the production read comes, one quiet row; a failed
 * read says so here (Try again only when the stages, which carry their own, are not drawn) — the order read's strips stay.
 */
function Strips({ order, model, actions, waiting, retry }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; waiting: WaitingState; retry: boolean }) {
  const t = useT('orders')
  const [all, setAll] = useState(false)
  const read = readOf(model.production)
  const approval = model.depth?.approval?.value ?? null
  const { strips, holds } = whereStripsOf(order, read, approval, waiting)
  if (strips.length === 0 && holds === 'read') return null
  const input: StripDoorsInput = {
    prefix: model.prefix,
    order,
    can: model.can,
    // Read-only sees the strips' words and no door (the band's own rule, as every card).
    readOnly: readOnlyOnPage(model.can, { assignSupervisor: model.people?.mayAssign, qualityHold: model.workOrderActs?.can.qualityHold }),
    busy: model.busy,
    approval,
    depthCan: model.depth?.can ?? null,
    work: read?.work?.workOrders ?? [],
    acts: model.workOrderActs?.can ?? null,
    credit: model.credit ?? null, // F-OO-106
  }
  const shown = all ? strips : strips.slice(0, STRIPS_SHOWN)
  const now = Date.now()
  return (
    <div className="fw-so-strips-box">
      <ul className="fw-so-strips" aria-label={t('where.strips')}>
        {shown.map((entry) => (
          <StripRow key={entry.key} strip={entry} doors={stripDoorsOf(entry, input)} order={order} model={model} actions={actions} now={now} />
        ))}
        {holds === 'reading' && (
          <li className="fw-so-strip-reading">
            <Skeleton height={22} />
          </li>
        )}
        {holds === 'failed' && (
          <li className="fw-so-ov-row fw-so-strip" data-tone="danger">
            <span className="fw-so-strip-mark">
              <CircleAlert size={14} aria-hidden />
            </span>
            <span className="fw-so-strip-said">{t('where.strip.failed')}</span>
            {retry && (
              <span className="fw-so-ov-doors">
                <Button size="sm" onClick={() => actions?.onRetryProduction?.()}>
                  {t('common.retry')}
                </Button>
              </span>
            )}
          </li>
        )}
      </ul>
      {strips.length > STRIPS_SHOWN && (
        <Button size="sm" variant="quiet" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? t('where.strip.showFewer') : t('where.strip.showMore', { count: strips.length - STRIPS_SHOWN })}
        </Button>
      )}
    </div>
  )
}

/** "WO-00021, WO-00022 and 2 more": at most two numbers named. */
function numbersOf(t: (key: string, params?: Record<string, string | number>) => string, numbers: readonly string[]): string {
  const named = numbers.slice(0, 2).join(', ')
  return numbers.length > 2 ? t('where.strip.andMore', { numbers: named, count: numbers.length - 2 }) : named
}

/** One strip: its mark, its words with the age (the day in its title), its quiet lines, its doors. */
function StripRow({ strip, doors, order, model, actions, now }: { strip: WhereStrip; doors: readonly StripDoor[]; order: Order; model: OrderRecordModel; actions?: OrderRecordActions; now: number }) {
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
        return strip.who ? t('where.strip.credit.waits', { who: strip.who }) : t('where.strip.credit.nobody')
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
    <li className="fw-so-ov-row fw-so-strip" data-tone={toneOf(strip, model.today)}>
      <span className="fw-so-strip-mark">{MARK[strip.kind]}</span>
      <span className="fw-so-strip-said">
        <span>
          {title}
          {age && strip.since ? (
            <>
              {' · '}
              <time dateTime={strip.since} title={day(strip.since)}>
                {w.t(age.key, age.params)}
              </time>
            </>
          ) : null}
        </span>
        {lines.map((line) => (
          <span key={line} className="fw-so-hint">
            {line}
          </span>
        ))}
      </span>
      {doors.length > 0 && (
        <span className="fw-so-ov-doors">
          {doors.map((door) => (
            <StripDoorView key={door.kind} door={door} order={order} model={model} actions={actions} />
          ))}
        </span>
      )}
    </li>
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
      // F-OO-108: Quality's holds do not open for this reader — the door is held with who releases it (never a link that refuses).
      if (door.held)
        return (
          <Button size="sm" variant="quiet" heldReason={t(door.held.key, door.held.params)}>
            {t('where.strip.release')}
          </Button>
        )
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

// ---- F-OO-107 (order overview §1.5; review F8): the order's own moves — the band's dialogs, held with the band's own words ----------
/**
 * Mark ready… in view; Record a shipment made elsewhere…, Cancel order…, Close order… under More ▾ — each opening the SAME dialog as
 * the band (the page's one dialog slot; made elsewhere: its container's dialog, mounted once by the page). A move the reader may not run
 * is held with words (a held menu item says why). Read-only: no row.
 */
function Moves({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const readOnly = readOnlyOnPage(model.can, { assignSupervisor: model.people?.mayAssign, qualityHold: model.workOrderActs?.can.qualityHold })
  const locale = useLocale()
  // F-OO-108: Hold the whole order… reads the production read's work orders and the page's acts (its dialog is theirs).
  const read = readOf(model.production)
  const moves = whereMovesOf(order, { can: model.can, readOnly, elsewhere: model.elsewhere, work: read ? (read.work ?? null) : undefined, acts: model.workOrderActs?.can ?? null })
  if (!moves) return null
  // A held move says why: the band's words (a phrase), or the hold plan's own words (both languages, the domain's).
  const heldOf = (move: WhereMove): string | null => (move.held ? ('key' in move.held ? t(move.held.key, move.held.params) : say(move.held, locale)) : model.busy ? t('held.busy') : null)
  const run = (move: WhereMove): void => {
    const id: WhereMoveId = move.id
    if (id === 'elsewhere') return actions?.onRecordElsewhere?.()
    // F-OO-108: the ONE Hold dialog (the work-order acts'), on the plan's work orders with their versions.
    if (id === 'hold') return move.hold ? actions?.workOrderActs?.onHoldOrder?.({ number: order.number, plan: move.hold.plan, units: move.hold.units }) : undefined
    actions?.onDialog?.({ kind: id })
  }
  return (
    <>
      <div className="fw-so-where-moves" role="group" aria-label={t('where.moves')}>
        {moves.shown.map((move) => (
          <Button key={move.id} size="sm" heldReason={heldOf(move)} onClick={() => run(move)}>
            {t(move.label.key)}
          </Button>
        ))}
        {moves.more.length > 0 && (
          <Menu
            label={
              <>
                {t('where.more')} <ChevronDown size={14} aria-hidden />
              </>
            }
            triggerProps={{ className: 'nds-btn sm', 'aria-label': t('where.moreOf', { number: order.number }) }}
            items={moves.more.map((move) => {
              const held = heldOf(move)
              return { id: move.id, label: t(move.label.key), ...(move.id === 'cancel' ? { tone: 'danger' as const } : {}), disabled: !!held, ...(held ? { description: held } : { onSelect: () => run(move) }) }
            })}
          />
        )}
      </div>
      {/* F-OP-123: Record a shipment made elsewhere… — its dialog is the page's, mounted once (OrderRecordView, F-OO-111). */}
    </>
  )
}
// ---- end F-OO-107

// ---- F-OO-106 (order overview §1.4; review F8, F16): Check credit again and Ask for a yes… — the page's own dialog frame ------------
/** The Finance page's catalogue: the credit strip names what its check found in its words. */
const CREDIT_NS = ['sales-credit'] as const

/**
 * The credit strip's two dialogs (the page's one slot, Overview's: `creditCheck`, `creditAsk`). Check credit again: what it does, then
 * Check again — no version: the check id is the lock (a "checked meanwhile" is said here). Ask for a yes…: a word for who decides
 * (optional), then Ask — "nobody to ask" is said here and holds Ask (the customer pays, or Finance raises the limit). Esc closes
 * (DS Modal), not while the act goes; what was typed stays after a refusal.
 */
function CreditDialogs({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const dialog = model.dialog
  if (dialog?.kind === 'creditCheck') return <CreditCheckDialog order={order} model={model} actions={actions} refused={dialog.refused ?? null} />
  if (dialog?.kind === 'creditAsk') return <CreditAskDialog key={dialog.checkId} order={order} model={model} actions={actions} checkId={dialog.checkId} refused={dialog.refused ?? null} />
  return null
}

function CreditCheckDialog({ order, model, actions, refused }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; refused: Phrase | null }) {
  const t = useT('orders')
  return (
    <Frame
      title={t('where.credit.checkTitle', { customer: order.party?.legalName ?? order.number })}
      held={model.busy ? t('held.busy') : null}
      go={() => actions?.credit?.onCheck?.()}
      goLabel={model.busy ? t('common.working') : t('where.credit.checkGo')}
      onClose={() => !model.busy && actions?.onDialog?.(null)}
      problem={refused ? <Banner tone="danger" title={t(refused.key, refused.params)} /> : null}
      size="sm"
    >
      <p>{t('where.credit.checkBody')}</p>
    </Frame>
  )
}

function CreditAskDialog({ order, model, actions, checkId, refused }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; checkId: string; refused: Phrase | null }) {
  const t = useT('orders')
  const [note, setNote] = useState(model.draft?.message ?? '')
  // Nobody to ask: asking again changes nothing — Ask is held with the same words.
  const held = model.busy ? t('held.busy') : refused?.key === 'where.credit.refused.nobody' ? t(refused.key) : null
  return (
    <Frame
      title={t('where.credit.askTitle', { number: order.number })}
      held={held}
      go={() => actions?.credit?.onAsk?.(checkId, note)}
      goLabel={model.busy ? t('common.working') : t('where.credit.askGo')}
      onClose={() => !model.busy && actions?.onDialog?.(null)}
      problem={refused ? <Banner tone="danger" title={t(refused.key, refused.params)} /> : null}
      size="sm"
    >
      <p className="fw-so-hint">{t('where.credit.askBody')}</p>
      <Field label={t('where.credit.askNote')} hint={t('where.credit.askHint', { count: CREDIT_ASK_NOTE_MAX })}>
        <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={CREDIT_ASK_NOTE_MAX} />
      </Field>
    </Frame>
  )
}
// ---- end F-OO-106
