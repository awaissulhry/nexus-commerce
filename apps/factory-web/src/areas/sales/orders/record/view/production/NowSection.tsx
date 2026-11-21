'use client'

import { AlertTriangle, Hourglass, Lock, MessageSquare, Send, User } from 'lucide-react'
import { Banner, type MenuItemDef } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { useSearchParams } from 'next/navigation'
import { formatDate, formatDateTime } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { healthStateOf, markActsOf } from '../../../../../../lib/production/health/model'
import { RaiseDialog } from '../../../../../../lib/production/health/view/HealthCard'
import { HealthPill } from '../../../../../../lib/production/view/HealthPill'
import { StageStrip } from '../../../../../../lib/production/view/StageStrip'
import { WaitingOnPill } from '../../../../../../lib/production/view/WaitingOnPill'
import { useProductionWords } from '../../../../../../lib/production/words'
import { TabLink } from '../../../../../../lib/tab-link/TabLink'
import { tabHref } from '../../../../../_shared/record-frame/address'
import type { BrandHealth } from '@nexus/factory-domain/production-brand/health'
import type { Order } from '../../../api'
import { dayInstant } from '../../../model'
import { depthMenuItems } from '../../../depth/view/DepthBand'
import { NAMESPACE as DEPTH } from '../../../depth/model'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { healthInputOf, readOf, say } from '../../overview/model'
import { handRowOf, headlineOf, stageStripOf, stagesShown } from '../../overview/where'
import { askPresetOf, askStarterOf, asksOf, onItOf } from '../../production/asks'
import { healthWhyOf, nextStepOf, nowStateOf, piecesOf, placeAnchorOf, urgencyOf, type HealthWhy } from '../../production/now'
import { ShowInThreadDoor } from '../Discuss'
import { LineMenuButton } from '../LineMenu'
import { PartFailed, PartReading, Quiet, Section } from './Kit'

/**
 * F-PT-102 / F-PT-103 (order PRODUCTION tab, 10-design §3; S5 §3; 18-lead-settles L3, L5, L7) — "Production now", the tab's top
 * answer: where the order is (the stage, Overview's own strip and words), how many of its pieces passed each step, whether it keeps
 * the promise and why (the stored health word — the band's — and one sentence that agrees with it), the one door to what holds it, the
 * urgency, who is on it and "Ask for an update" (the production lane's note dialog, a ready ask). Office only: the customer never reads
 * an ask. Read-only reads it all and has no button (no Ask door); a door the reader may not use is not drawn (L9).
 */
export function NowSection({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const d = useT(DEPTH)
  const locale = useLocale()
  const search = useSearchParams()?.toString() ?? ''
  const recordHref = `${model.prefix}/sales/orders/${order.id}`
  const state = model.production ?? null
  const read = readOf(state)
  const headline = read?.headline ?? null
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const stateNow = nowStateOf(order, headline)
  const people = model.people ?? null
  const mayAsk = !!people?.mayNote && stateNow !== 'after'
  const ask = () => actions?.people?.onAsk?.(askPresetOf(t, askStarterOf({ number: order.number, promise: headline?.promise.date ?? order.promiseDate }, day)))

  // ---- the ⋯: the mark (production.brand.manage — hidden without it, not offered while the dates already say it), Assign
  // supervisor…, Set priority… (the depth's own dialog, held by the order's state with its words). The stage set by hand keeps its ONE
  // place on Overview (the stage block's link). ----
  const health = model.health ?? null
  const view = health?.orders[0]?.read.value ?? null
  const mark = stateNow === 'kept' ? markActsOf(view, !!health?.can) : { mark: null, remove: false }
  const busy = health?.busy ? t('held.busy') : undefined
  const items: MenuItemDef[] = [
    ...(mark.mark ? [{ id: 'mark', label: t(mark.mark === 'change' ? 'productionTab.now.changeMark' : 'productionTab.now.markAtRisk'), disabled: !!busy, description: busy, onSelect: () => actions?.health?.onDialog?.(order.id) }] : []),
    ...(mark.remove ? [{ id: 'unmark', label: t('productionTab.now.removeMark'), disabled: !!busy, description: busy, onSelect: () => actions?.health?.onClear?.(order.id) }] : []),
    ...(people?.mayAssign && stateNow !== 'after' ? [{ id: 'assign', label: t('menu.assignSupervisor'), onSelect: () => actions?.people?.onAssign?.() }] : []),
    ...depthMenuItems(order, model.depth, actions?.depth, d).filter((item) => item.id === 'depth-priority'),
  ]
  const more = items.length > 0 ? <LineMenuButton label={t('productionTab.more', { section: t('productionTab.now.title') })} items={items} /> : null

  let body
  if (!state || state.status === 'loading') body = <PartReading rows={3} height={28} />
  else if (state.status === 'failed') body = <PartFailed part={t('productionTab.now.title')} problem={state.problem} onRetry={() => actions?.onRetryProduction?.()} />
  else {
    body = (
      <div className="fw-pt-now">
        <StageBlock order={order} model={model} recordHref={recordHref} search={search} day={day} />
        {stateNow === 'kept' ? <HealthBlock order={order} model={model} recordHref={recordHref} search={search} day={day} onAsk={mayAsk ? ask : null} /> : stateNow === 'notKept' ? <div className="fw-pt-now-blk fw-pt-now-health"><Quiet>{t('productionTab.now.notKept')}</Quiet></div> : null}
        {stateNow !== 'after' ? <PeopleBlock order={order} model={model} actions={actions} onAsk={mayAsk ? ask : null} /> : null}
      </div>
    )
  }
  return (
    <Section id="now" title={t('productionTab.now.title')} asOf={read?.asOf ?? null} more={more} info={<p>{t('productionTab.now.infoBody')}</p>}>
      {body}
      {health?.dialog ? <RaiseDialog model={health} actions={actions?.health} /> : null}
    </Section>
  )
}

/** Where it is: the stage (→ next · since), set by hand (its one place is Overview), the five stages, the pieces per step. */
function StageBlock({ order, model, recordHref, search, day }: { order: Order; model: OrderRecordModel; recordHref: string; search: string; day: (value: string) => string }) {
  const t = useT('orders')
  const w = useProductionWords()
  const locale = useLocale()
  const read = readOf(model.production)
  const headline = read?.headline ?? null
  const words = headlineOf(order, headline)
  const strip = stageStripOf(order, headline, read?.dates ?? null)
  const hand = handRowOf(order, headline, model.today)
  const stage = headline?.stage ?? null
  const pieces = piecesOf(order, read?.lines)
  // The headline's own words otherwise (Overview's sentence: the status, its days, the stage word).
  const dated = (key: string, params?: Readonly<Record<string, string | number>>) => t(key, Object.fromEntries(Object.entries(params ?? {}).map(([name, value]) => [name, typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? formatDate(value, { locale }) : value])))
  const sentence = [words.status ? dated(words.status.key, words.status.params) : null, words.stage ? w.t(`parts.stage.${words.stage}`) : null].filter(Boolean).join(' · ')
  return (
    <div className="fw-pt-now-blk">
      <span className="fw-pt-label">{t('productionTab.now.stageLabel')}</span>
      {words.state === 'CURRENT' && stage ? (
        <p className="fw-pt-stage">
          {w.t(`parts.stage.${stage.code}`)}
          {stage.next ? <small>→ {t('productionTab.now.next', { stage: w.t(`parts.stage.${stage.next.code}`) })}</small> : null}
          {stage.since ? <small>· {t('productionTab.now.since', { date: day(stage.since) })}</small> : null}
        </p>
      ) : (
        <p className="fw-pt-stage">{sentence}</p>
      )}
      {hand ? (
        <p className="fw-pt-hint">
          <Tag tone={hand.tone}>{t('where.manual.tag')}</Tag> {t('productionTab.now.byHand')} ·{' '}
          <TabLink className="fw-pt-link" href={tabHref(recordHref, 'overview', search)}>
            {t('productionTab.now.byHandLink')}
          </TabLink>
        </p>
      ) : null}
      {stagesShown(words.state) ? <StageStrip face="office" layout="auto" label={t('productionTab.now.stageLabel')} {...strip} note={hand ? t(hand.stripNote.key) : strip.note} /> : null}
      {pieces ? (
        <>
          <span className="fw-pt-label">
            {t('productionTab.now.piecesLabel')} · {t('productionTab.now.of', { of: pieces.of })}
          </span>
          <div className="fw-pt-counts">
            {pieces.steps.map((entry) => (
              <div key={entry.step} className="fw-pt-count">
                <span className="fw-pt-label">{t(`productionTab.now.step.${entry.step}`)}</span>
                {entry.value === null ? (
                  <b title={w.t('parts.pieces.notCounted')} aria-label={`${t(`productionTab.now.step.${entry.step}`)}: ${w.t('parts.pieces.notCounted')}`}>
                    —
                  </b>
                ) : (
                  <b>{entry.value}</b>
                )}
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}

/** Is it OK: the stored word, the waiting pill, ONE sentence of why, the mark while it stands, ONE next-step door; the urgency. */
function HealthBlock({ order, model, recordHref, search, day, onAsk }: { order: Order; model: OrderRecordModel; recordHref: string; search: string; day: (value: string) => string; onAsk: (() => void) | null }) {
  const t = useT('orders')
  const w = useProductionWords()
  const d = useT(DEPTH)
  const locale = useLocale()
  const read = readOf(model.production)
  const headline = read?.headline ?? null
  const health = headline?.health ?? null
  const why = healthWhyOf({ order, headline, dates: read?.dates ?? null, lines: read?.lines ?? null })
  const next = nextStepOf(headline)
  const urgency = urgencyOf(headline, read?.work ?? null)
  const raise = health?.raise ?? null
  const supervisor = read?.people?.supervisor?.name ?? null
  const problem = model.health?.problem && !model.health.dialog ? model.health.problem : null
  const whyWords = (entry: HealthWhy): string => {
    switch (entry.kind) {
      case 'late':
        return t('productionTab.now.why.late', { promise: day(entry.promise), count: entry.open })
      case 'lineLate':
        return t('productionTab.now.why.lineLate', { line: entry.line, finish: day(entry.finish), count: entry.days, promise: day(entry.promise) })
      case 'lineNoDate':
        return t('productionTab.now.why.lineNoDate', { line: entry.line, promise: day(entry.promise) })
      case 'gateLate':
        return t('productionTab.now.why.gateLate', { gate: entry.gate.label ?? d(`gate.${entry.gate.kind ?? 'OTHER'}`), target: day(entry.target), promise: day(entry.promise) })
      case 'marked': {
        const state = healthStateOf((entry.computed as BrandHealth | null) ?? null)
        const params = { day: entry.at ? formatDate(entry.at, { locale }) : '—', reason: say(entry.reason, locale), health: state ? w.t(`parts.health.${state}`) : w.t('parts.health.none') }
        return entry.by ? t('productionTab.now.why.marked', { name: entry.by, ...params }) : t('productionTab.now.why.markedNoName', params)
      }
      case 'noDate':
        return t('productionTab.now.why.noDate')
      case 'onTrack':
        return entry.days === 0 ? t('productionTab.now.why.onTrackOnDay', { finish: day(entry.finish) }) : t('productionTab.now.why.onTrack', { finish: day(entry.finish), count: entry.days, promise: day(entry.promise) })
      case 'fromDates':
        return entry.plan ? w.t('parts.health.fromDates', { plan: day(entry.plan), promise: day(entry.promise) }) : w.t('parts.health.fromDatesNoPlan', { promise: day(entry.promise) })
    }
  }
  const place = next?.kind === 'blocker' ? placeAnchorOf(next.place) : null
  return (
    <div className="fw-pt-now-blk fw-pt-now-health">
      <span className="fw-pt-label">{t('productionTab.now.healthLabel')}</span>
      <span className="fw-pt-inline">
        <HealthPill face="office" {...healthInputOf(order, headline, read?.dates ?? null)} explain={false} />
        {headline?.waiting ? <WaitingOnPill face="office" who={headline.waiting.on} since={headline.waiting.since} /> : null}
      </span>
      {why ? <p className="fw-pt-why">{whyWords(why)}</p> : null}
      {raise ? (
        <div className="fw-pt-mark">
          {raise.note ? (
            <span className="fw-pt-inline">
              <Lock size={12} aria-hidden /> {w.t('parts.health.officeOnly')} — {raise.note}
            </span>
          ) : null}
          <span>{t('productionTab.now.markLapses', { date: day(raise.until) })}</span>
        </div>
      ) : null}
      {problem ? <Banner tone="danger" title={w.t(problem.key, problem.params)} /> : null}
      {next?.kind === 'blocker' && place ? (
        <p className="fw-pt-hint">
          <span>{t('productionTab.now.nextDoor', { words: say(next.words, locale) })}</span>
          {place.tab === 'production' ? (
            <a className="fw-pt-link" href={`#${place.anchor}`}>
              {t(`productionTab.now.nextPlace.${place.anchor}`)}
            </a>
          ) : (
            <TabLink className="fw-pt-link" href={tabHref(recordHref, 'changes', search)}>
              {t('productionTab.now.nextPlace.changes')}
            </TabLink>
          )}
        </p>
      ) : next?.kind === 'ask' && onAsk ? (
        <p className="fw-pt-hint">
          <button type="button" className="fw-pt-link" onClick={onAsk}>
            {supervisor ? t('productionTab.now.nextAsk', { name: supervisor }) : t('productionTab.now.nextAskNobody')}
          </button>
        </p>
      ) : null}
      {urgency && (urgency.customer || urgency.rush || urgency.priority) ? (
        <span className="fw-pt-inline" aria-label={t('productionTab.now.urgencyLabel')}>
          {urgency.customer ? (
            <Tag tone="warning">
              <AlertTriangle size={12} aria-hidden /> {t('productionTab.now.urgentCustomer')}
            </Tag>
          ) : null}
          {urgency.rush ? <Tag tone="neutral">{t('productionTab.now.rush')}</Tag> : null}
          {urgency.priority ? <Tag tone="neutral">{t('productionTab.now.priority', { words: say(urgency.priority, locale) })}</Tag> : null}
        </span>
      ) : null}
    </div>
  )
}

/** Who is on it, Ask for an update (a ready ask; office only), the asks line from the order's issues. */
function PeopleBlock({ order, model, actions, onAsk }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; onAsk: (() => void) | null }) {
  const t = useT('orders')
  const locale = useLocale()
  const read = readOf(model.production)
  const onIt = onItOf(read?.people ?? null)
  const asks = model.asks ?? null
  const view = asks?.value ? asksOf(asks.value.issues) : null
  const at = (value: string) => formatDateTime(value, { locale })
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const supervisor = onIt.kind === 'supervisor' ? onIt.name : null
  return (
    <div className="fw-pt-now-blk fw-pt-now-people">
      <span className="fw-pt-label">{t('productionTab.now.peopleLabel')}</span>
      <div className="fw-pt-prow">
        <div className="fw-pt-person">
          <User size={18} aria-hidden />
          {onIt.kind === 'supervisor' ? (
            <div>
              <b>{onIt.name}</b>
              <span>
                {t(onIt.me ? 'productionTab.now.supervisorMe' : 'productionTab.now.supervisor')}
                {onIt.backup ? ` · ${t('productionTab.now.backup', { name: onIt.backup })}` : ''}
              </span>
            </div>
          ) : onIt.kind === 'nobody' ? (
            <div>
              <b>{t('productionTab.now.nobody')}</b>
            </div>
          ) : (
            <div>
              <span>{t('overview.people.held')}</span>
            </div>
          )}
        </div>
        {onAsk ? (
          <Button size="sm" variant="primary" onClick={onAsk}>
            <Send size={14} aria-hidden /> {t('productionTab.ask.button')}
          </Button>
        ) : null}
      </div>
      {onIt.kind === 'nobody' && onAsk ? (
        <p className="fw-pt-hint">
          <span>{t('productionTab.ask.noSupervisor')}</span>
          {model.people?.mayAssign ? (
            <button type="button" className="fw-pt-link" onClick={() => actions?.people?.onAssign?.()}>
              {t('menu.assignSupervisor')}
            </button>
          ) : null}
        </p>
      ) : null}
      {asks && !asks.value && !asks.problem ? <PartReading rows={1} height={16} /> : null}
      {asks?.problem ? <PartFailed part={t('productionTab.partAsks')} problem={asks.problem} onRetry={() => actions?.onRetryAsks?.()} /> : null}
      {view ? (
        <div className="fw-pt-now-blk">
          {view.open ? (
            <p className="fw-pt-line">
              <Hourglass size={14} aria-hidden />
              <span>
                {[
                  view.open.by ? t('productionTab.now.askedBy', { by: view.open.by, at: at(view.open.at) }) : t('productionTab.now.asked', { at: at(view.open.at) }),
                  view.open.workOrder ? t('productionTab.now.about', { number: view.open.workOrder }) : null,
                  view.open.escalated ? say(view.open.escalated, locale) : supervisor ? t('productionTab.now.answersBy', { name: supervisor, due: day(view.open.due) }) : t('productionTab.now.answerBy', { due: day(view.open.due) }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {view.open.messageId ? <ShowInThreadDoor order={order} at={view.open.at} /> : null}
            </p>
          ) : null}
          {view.latest ? (
            <p className="fw-pt-line">
              <MessageSquare size={14} aria-hidden />
              <span>
                {view.latest.by ? t('productionTab.now.latest', { by: view.latest.by, at: at(view.latest.at) }) : view.latest.text ? t('productionTab.now.latestNoName', { at: at(view.latest.at) }) : t('productionTab.now.answered', { at: at(view.latest.at) })}
                {view.latest.text ? (
                  <>
                    {' · '}
                    <q>{view.latest.text}</q>
                  </>
                ) : null}
              </span>
              {view.latest.messageId ? <ShowInThreadDoor order={order} at={view.latest.at} /> : null}
            </p>
          ) : null}
          {!view.open && !view.latest ? <Quiet>{t('productionTab.now.none')}</Quiet> : null}
          {view.waiting > 0 ? (
            <p className="fw-pt-line">
              <span>{t('productionTab.now.questions', { count: view.waiting })}</span>
              <a className="fw-pt-link" href="#holds">
                {t('productionTab.now.nextPlace.holds')}
              </a>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
