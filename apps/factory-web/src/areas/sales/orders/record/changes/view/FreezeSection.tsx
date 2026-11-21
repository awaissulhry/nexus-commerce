'use client'

import { useSearchParams } from 'next/navigation'
import { Button, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { TabLink } from '../../../../../../lib/tab-link/TabLink'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { tabHref } from '../../../../../_shared/record-frame/address'
import type { Order } from '../../../api'
import type { FreezeField } from '../../../depth/api'
import { NAMESPACE as DEPTH } from '../../../depth/model'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { PartFailed, PartReading, Section } from '../../view/production/Kit' // F-OC-101 (L6): the Production kit, in place
import { FREEZE_WORD_TONE, freezePartsOf, freezeVerdictOf, isFinalVerdict, linesDoorOf, type FreezeVerdict } from '../freeze'
import './changes.css'

/**
 * F-OC-202 (order CHANGES tab, 10-design §4; 13-backend R13a, B-OC-017; L3) — section 2, Can it still change? (#freeze): second, under
 * Waiting (O2 = A). ONE sentence — the order's state first, then our approval that blocks, then the freeze rules — the door to the
 * Lines tab (the one place to change: orders.manage on an order that can still change; held with its reason while our approval
 * waits), where the floor is, and each part in three words: Can change · Needs the customer's yes · Can't change any more (Options
 * not shown; the delivery address "checked when the customer asks", L3). What freezes next and "Rule of {customer}" come with S2
 * (B-OC-017) and are not said until then. Every reader reads it; fetches nothing.
 */
export function FreezeSection(props: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  return (
    <WithMessages namespaces={[DEPTH]}>
      <Freeze {...props} />
    </WithMessages>
  )
}

function Freeze({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const d = useT(DEPTH)
  const locale = useLocale()
  const search = useSearchParams()?.toString() ?? ''
  const depth = model.depth
  const changes = depth?.changes ?? null
  const freezePart = depth?.freeze ?? null
  const title = t('changesTab.freeze.title')
  const customer = order.party?.legalName ?? ''
  const verdict = freezeVerdictOf({ status: order.status, changes: changes?.value ?? null, freeze: freezePart })
  const field = (name: FreezeField) => d(`field.${name}`)
  const sentence = (v: FreezeVerdict): string => {
    switch (v.kind) {
      case 'blocked':
        return v.revision !== null ? t('changesTab.freeze.verdict.blocked', { revision: v.revision, date: formatDate(v.since, { locale }) }) : t('changesTab.freeze.verdict.blockedAny', { date: formatDate(v.since, { locale }) })
      case 'locked':
        return [v.needsYes.length > 0 ? t('changesTab.freeze.verdict.needsYes', { parts: v.needsYes.map(field).join(', ') }) : null, v.cantChange.length > 0 ? t('changesTab.freeze.verdict.cantChange', { parts: v.cantChange.map(field).join(', ') }) : null].filter(Boolean).join(' ')
      case 'reading':
        return t('changesTab.freeze.reading')
      case 'failed':
        return ''
      default:
        return t(`changesTab.freeze.verdict.${v.kind}`)
    }
  }
  const info = (
    <>
      <p>{t('changesTab.freeze.info')}</p>
    </>
  )
  // The door: the Lines tab (the one place to change), held in words while our approval of an old change waits.
  const door = linesDoorOf(verdict, model.can)
  const buttons = door
    ? [
        door.held ? (
          <Button key="lines" size="sm" heldReason={door.held.revision !== null ? t('changesTab.freeze.heldRevision', { revision: door.held.revision }) : t('changesTab.freeze.heldAny')}>
            {t('changesTab.freeze.lines')}
          </Button>
        ) : (
          <Button key="lines" size="sm" variant="primary" asChild>
            <TabLink href={tabHref(`${model.prefix}/sales/orders/${order.id}`, 'lines', search)}>{t('changesTab.freeze.lines')}</TabLink>
          </Button>
        ),
      ]
    : []
  // Blocked: the approval it waits for is a row of Waiting on us (its Confirm / Refuse… there) — "See it ↑".
  const waitingTask = changes?.value?.waitingForYes?.taskId ?? null
  const answer = (
    <>
      {sentence(verdict)}
      {verdict.kind === 'blocked' && waitingTask ? (
        <>
          {' '}
          <a className="fw-pt-link" href={`#about-Approval-${waitingTask}`}>
            {t('changesTab.freeze.seeIt')}
          </a>
        </>
      ) : null}
    </>
  )
  if (verdict.kind === 'reading' || verdict.kind === 'failed') {
    return (
      <Section id="freeze" title={title} answer={verdict.kind === 'reading' ? answer : null} info={info} buttons={buttons}>
        {verdict.kind === 'reading' ? <PartReading rows={1} height={22} /> : <PartFailed part={title} problem={freezePart?.problem ?? 'problem.read.unavailable'} onRetry={() => actions?.depth?.onRetry?.('freeze')} />}
      </Section>
    )
  }
  // An order that no longer changes is the head's one line.
  if (isFinalVerdict(verdict)) {
    return (
      <Section id="freeze" title={title} answer={answer} info={info}>
        {null}
      </Section>
    )
  }
  const freeze = freezePart?.value ?? null
  const parts = freeze ? freezePartsOf(freeze) : []
  const withNext = parts.some((part) => part.next !== null)
  // "On the floor: Sewing started · since 19/11/2026" (the stage the order reached and its day only; no worker, no station).
  const reached = freeze?.order.stage ?? null
  const floor = !freeze ? null : !reached ? t('changesTab.freeze.floorNothing') : freeze.order.on ? t('changesTab.freeze.floor', { stage: d(`stage.${reached}`), date: formatDate(`${freeze.order.on}T12:00:00Z`, { locale }) }) : t('changesTab.freeze.floorStage', { stage: d(`stage.${reached}`) })
  return (
    <Section id="freeze" title={title} answer={answer} info={info} buttons={buttons}>
      <p className="fw-pt-quiet fw-oc-foot">{[floor, t('changesTab.freeze.portal')].filter(Boolean).join(' · ')}</p>
      {/* A failed changes read never claims "not blocked": it says it could not read whether our approval waits. */}
      {changes?.problem ? <p className="fw-pt-quiet">{t('changesTab.freeze.changesUnread')}</p> : null}
      {freeze && freeze.rules === 0 ? <p className="fw-pt-quiet">{t('changesTab.freeze.noRules')}</p> : null}
      {parts.length > 0 && (
        <div className="fw-pt-blk">
          <h3 className="fw-pt-h3">{t('changesTab.freeze.parts')}</h3>
          <table className="fw-pt-table">
            <thead>
              <tr>
                <th scope="col">{t('changesTab.freeze.col.part')}</th>
                <th scope="col">{t('changesTab.freeze.col.now')}</th>
                {withNext && <th scope="col">{t('changesTab.freeze.col.next')}</th>}
              </tr>
            </thead>
            <tbody>
              {parts.map((part) => (
                <tr key={part.field}>
                  <td className="fw-pt-first">{field(part.field)}</td>
                  <td data-label={t('changesTab.freeze.col.now')}>
                    <Tag tone={FREEZE_WORD_TONE[part.word]}>{t(`changesTab.freeze.word.${part.word}`)}</Tag>
                    {part.of && <span className="fw-pt-sub">{t(`changesTab.freeze.of.${part.of.unit}`, { count: part.of.count, total: part.of.total })}</span>}
                    {part.words && <span className="fw-pt-sub">{locale === 'en' ? part.words.en : part.words.it}</span>}
                    {part.customerRule && <span className="fw-pt-sub">{t('changesTab.freeze.customerRule', { customer })}</span>}
                    {/* L3: the office's own address change is not checked against the rules yet — the customer's ask is. */}
                    {part.field === 'SHIP_TO' && <span className="fw-pt-sub">{t('changesTab.freeze.shipToChecked')}</span>}
                  </td>
                  {withNext && <td data-label={t('changesTab.freeze.col.next')}>{part.next ? t('changesTab.freeze.next', { stage: d(`stage.${part.next.stage}`), word: t(`changesTab.freeze.word.${part.next.word}`) }) : null}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}
