'use client'

import { useId, type ReactNode } from 'react'
import { Card } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import type { Order } from '../../../api'
import { dayInstant, readOnlyOnPage, type Phrase } from '../../../model'
import { NAMESPACE as DEPTH } from '../../../depth/model'
import { factsDoorsOf, incotermOf, languageOf, madeOf, shipToOf } from '../../overview/facts'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import './facts.css'

/** The quote's delivery terms words (the Incoterm's name, ship complete / as ready): the words the quote showed (one word per meaning). */
const QUOTE_TERMS = 'sales-quotes-depth'

/**
 * F-OO-209 (order overview 11-design §7; Owner §7) — Order facts: two columns of the facts found nowhere else on the Overview.
 * Customer PO and Ship to with Change… (the ONE edit path: the Lines edit mode with that field focused — use-overview-acts and the
 * band's own ⋯ Change ship-to…), Priority and Season with Set… (the depth's own dialogs), the rest Fixed (set when the order was
 * made: payment · currency, Incoterm, language · tax mode) and Made (derived). Each door is held with words (amendHeld,
 * depthEditHeld: a closed or cancelled order holds them all); a read-only reader sees the facts and no door. Fetches nothing.
 * F-OO-210 (Owner D4): the office note as the last, whole row — "Only the office sees it", Change… opens its dialog in the page's
 * one slot ({ kind: 'note' }), saved by the Orders sheet's own write.
 */
export function FactsCard({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  return (
    <WithMessages namespaces={[QUOTE_TERMS]}>
      <Facts order={order} model={model} actions={actions} />
    </WithMessages>
  )
}

function Facts({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const d = useT(DEPTH)
  const q = useT(QUOTE_TERMS)
  const locale = useLocale()
  const readOnly = readOnlyOnPage(model.can, { assignSupervisor: model.people?.mayAssign, qualityHold: model.workOrderActs?.can.qualityHold })
  const doors = factsDoorsOf(order, { can: model.can, readOnly, busy: model.busy, depthCan: model.depth?.can })
  const depth = model.depth?.depth ?? null
  const read = depth?.value ?? null
  const say = (phrase: Phrase | null) => (phrase ? t(phrase.key, phrase.params) : null)
  // The depth's own part: Skeleton while it reads, "—" + "Could not be read" when it failed (never drawn as a fact).
  const depthValue = (value: (depth: NonNullable<typeof read>) => string): ReactNode =>
    read ? value(read) : depth && depth.problem === null ? <Skeleton height={16} /> : depth?.problem ? `— · ${t('facts.unread')}` : '—'
  const made = madeOf(order)
  const madeWords = [
    t(made.by ? 'facts.madeBy' : 'facts.madeNoName', { date: formatDate(order.createdAt, { locale }), name: made.by ?? '', changed: formatDate(order.updatedAt, { locale }) }),
    ...(made.ordered ? [t('facts.ordered', { date: formatDate(dayInstant(made.ordered), { locale }) })] : []),
  ].join(' · ')
  const terms = incotermOf(order)
  const incotermName = (code: string) => {
    const words = q(`incoterm.${code}`)
    return words === `incoterm.${code}` ? code : words
  }
  const fixed = <span className="fw-so-hint fw-so-fact-fixed" title={t('facts.fixedTitle')}>{t('facts.fixed')}</span>
  return (
    <Card padded>
      <h2 className="fw-so-h2">{t('overview.facts.title')}</h2>
      <ul className="fw-so-ov-cols fw-so-facts">
        <Fact
          label={t('overview.facts.customerRef')}
          value={order.customerRef ?? '—'}
          door={doors ? (describedBy) => <Door label={t('doors.change')} held={say(doors.customerRef)} describedBy={describedBy} onClick={() => actions?.onCustomerRefChange?.()} /> : null}
        />
        <Fact
          label={d('priority.legend')}
          value={depthValue((value) => `${d(`priority.level.${value.priority.level}`)}${value.priority.level === 'URGENT' && value.priority.urgentReason ? ` · ${value.priority.urgentReason}` : ''}`)}
          door={doors && read ? (describedBy) => <Door label={t('facts.set')} held={say(doors.priority)} describedBy={describedBy} onClick={() => actions?.depth?.onDialog?.({ kind: 'priority', level: read.priority.level, reason: read.priority.urgentReason ?? '' })} /> : null}
        />
        <Fact
          label={t('edit.shipTo')}
          value={shipToOf(order) ?? '—'}
          door={doors ? (describedBy) => <Door label={t('doors.change')} held={say(doors.shipTo)} describedBy={describedBy} onClick={() => actions?.onChangeShipTo?.()} /> : null}
        />
        <Fact
          label={d('season.label')}
          value={depthValue((value) => (value.season ? `${value.season.code} · ${value.season.name}` : d('season.noSeason')))}
          door={doors && read ? (describedBy) => <Door label={t('facts.set')} held={say(doors.season)} describedBy={describedBy} onClick={() => actions?.depth?.onDialog?.({ kind: 'season', seasonId: read.season?.id ?? '' })} /> : null}
        />
        <Fact label={t('facts.payment')} value={`${order.paymentTerms?.trim() || '—'} · ${order.currency}`} door={() => fixed} />
        <Fact label={t('facts.languageTax')} value={`${languageOf(order, locale)} · ${t(`newOrder.taxModes.${order.taxMode}`)}`} door={() => fixed} />
        {terms && (
          <Fact
            label={q('terms.incoterm')}
            value={[terms.code ? incotermName(terms.code) : '—', ...(terms.place ? [terms.place] : []), ...(terms.ship ? [q(terms.ship === 'complete' ? 'terms.shipComplete' : 'terms.shipAsReady')] : [])].join(' · ')}
            door={() => fixed}
          />
        )}
        <Fact label={t('facts.made')} value={madeWords} door={null} />
        {/* F-OO-210 (Owner D4): the office note, the whole row — only when the read sends it (never an empty note over one not read). */}
        {order.internalNote !== undefined && (
          <Fact
            wide
            label={
              <>
                {t('facts.note.label')} <Tag tone="neutral">{t('facts.note.tag')}</Tag>
              </>
            }
            value={order.internalNote?.trim() ? <span className="fw-so-fact-text">{order.internalNote}</span> : <span className="fw-so-hint">{t('facts.note.empty')}</span>}
            door={doors ? (describedBy) => <Door label={t('doors.change')} held={say(doors.note)} describedBy={describedBy} onClick={() => actions?.onDialog?.({ kind: 'note' })} /> : null}
          />
        )}
      </ul>
    </Card>
  )
}

/** One fact: its label, its value, and its door (Change… / Set…, held with words) or "Fixed" — the Overview's shared card row. */
function Fact({ label, value, door, wide = false }: { label: ReactNode; value: ReactNode; door: ((describedBy: string) => ReactNode) | null; /* F-OO-210: the whole row */ wide?: boolean }) {
  const id = useId()
  return (
    <li className={wide ? 'fw-so-ov-row fw-so-fact fw-so-fact-note' : 'fw-so-ov-row fw-so-fact'}>
      <span id={id} className="fw-so-fact-label">
        {label}
      </span>
      <span className="fw-so-fact-value">{value}</span>
      {door && <span className="fw-so-ov-doors">{door(id)}</span>}
    </li>
  )
}

function Door({ label, held, describedBy, onClick }: { label: string; held: string | null; describedBy: string; onClick: () => void }) {
  return (
    <Button size="sm" variant="quiet" heldReason={held} aria-describedby={describedBy} onClick={onClick}>
      {label}
    </Button>
  )
}
