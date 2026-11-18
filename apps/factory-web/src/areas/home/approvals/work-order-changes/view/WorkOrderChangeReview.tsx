'use client'

import Link from 'next/link'
import { Check, ExternalLink, RotateCcw } from 'lucide-react'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { DetailModal, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { orderHref as cutOrderHref } from '../../../../production/cutting/orders/model'
import { DEPTH_NS } from '../../model'
import { said } from '../../requests/model'
import type { WorkOrderChange } from '../api'
import {
  applyHeld,
  applyLabelOf,
  changeRefusalKeyOf,
  DECISION_LIMIT,
  decideCellsOf,
  declineHeld,
  laysOf,
  outcomeWordsOf,
  routeOf,
  wordsRefusalOf,
  WOC,
  type ChangeReviewActions,
  type ChangeReviewModel,
  type Held,
} from '../model'

/**
 * F-SA-245 (sales page plan R1; 14-change-flow §2.0 S7; review C-11, R-6) — the ONE decide window of a work-order change, from
 * Home › Approvals' row "Work order change · WO-…" and from the work order's band notice. It draws ChangeReviewModel and fetches
 * nothing (use-work-order-change.ts reads it): the change in words (who proposed it and why), each cell before → after beside
 * what the work order makes now and what of it is already cut and bundled, the extra pieces and the outcome chosen at Accept, the
 * lay it touches, what Apply does; Apply ("Lower to the order", "Make more for the order", "Make the new work order") and
 * "Leave as is…" (with why), each held with its reason before the click and said once in the window. A refusal says its own
 * words with "Read again"; "Re-plan the lay first" with a door to the lay.
 */

const STATUS_TONE: Readonly<Record<WorkOrderChange['status'], 'info' | 'success' | 'neutral' | 'warning'>> = Object.freeze({ PROPOSED: 'warning', APPLIED: 'success', DECLINED: 'neutral', STALE: 'neutral' })

export interface WorkOrderChangeReviewProps {
  readonly review: ChangeReviewModel | null | undefined
  /** `/w/<company>` (the doors to the work order, the order and the lay). */
  readonly prefix: string
  readonly offline: boolean
  readonly busy?: boolean
  /** The door's own list: the ‹ › arrows walk it (Approvals: its rows; the work order: its waiting changes). */
  readonly nav: { readonly ids: readonly string[]; readonly onOpen?: ((id: string | null) => void) | undefined }
  readonly actions?: ChangeReviewActions | undefined
}

export function WorkOrderChangeReview(props: WorkOrderChangeReviewProps) {
  if (!props.review) return null
  return (
    <WithMessages namespaces={[DEPTH_NS, 'approvals', 'sales']}>
      <Review {...props} review={props.review} />
    </WithMessages>
  )
}

function Review({ review, prefix, offline, busy = false, nav, actions }: WorkOrderChangeReviewProps & { review: ChangeReviewModel }) {
  const t = useT('approvals')
  const depth = useT(DEPTH_NS)
  const sales = useT('sales')
  const locale = useLocale()
  const say = (held: Held | null) => (held ? t(held.key, held.params) : null)
  const change = review.change.status === 'ready' ? review.change.value : null
  const workOrder = review.workOrder?.status === 'ready' ? review.workOrder.value : null
  const records = review.lays?.status === 'ready' ? review.lays.value : null
  const found = change && records ? laysOf(change, records) : null
  const stop = found?.stop ?? null
  const facts = { workOrder, stop, problem: review.problem, offline, busy }
  const applyWait = change ? applyHeld(change, facts) : { key: `${WOC}.held.reading` }
  const declineWait = change ? declineHeld(change, null, { offline, busy }) : { key: `${WOC}.held.reading` }
  // Why it cannot be applied as it stands (decided, not this reader's, the work order now, a lay) — said once, not only on hover.
  const standing = change ? applyHeld(change, { ...facts, problem: null, offline: false, busy: false }) : null
  const route = change ? routeOf(change, workOrder) : null
  const routeName = route && 'route' in route ? route.route : null
  const dialog = review.dialog
  const number = change?.workOrder?.number ?? change?.madeWorkOrder?.number ?? ''

  const title = change ? said(change.words.title, locale) : t(`${WOC}.titleUnknown`)
  const subtitle = change ? t(`${WOC}.subtitle`, { order: change.salesOrder.number, who: change.proposedBy?.name ?? t(`${WOC}.someone`), at: formatDateTime(change.proposedAt, { locale }) }) : undefined
  const error = review.change.status === 'error' ? sales(review.change.problem) : review.change.status === 'not_found' || review.change.status === 'forbidden' ? t(`${WOC}.notFound`) : undefined
  const ids = nav.ids
  const onGo = nav.onOpen
  const walk = ids.length > 1 && ids.includes(review.id) && onGo ? { ids: [...ids], current: review.id, onGo: (next: string) => onGo(next), noun: depth('review.noun') } : undefined

  // The lay a refusal or the pre-check names: its record when read, else the work order's Cutting & bundles (its lays listed there).
  const layDoor = (named: string | null) => {
    const lay = named ? (found?.lays.find((entry) => entry.number === named) ?? null) : null
    const href = lay ? cutOrderHref(prefix, lay.id) : change?.workOrder ? `${prefix}/production/work-orders/${encodeURIComponent(change.workOrder.id)}?tab=cutting` : null
    return href ? (
      <Button size="sm" variant="quiet" asChild>
        <Link href={href}>
          <ExternalLink size={14} aria-hidden /> {lay ? t(`${WOC}.lays.open`, { number: lay.number }) : t(`${WOC}.lays.openWorkOrder`)}
        </Link>
      </Button>
    ) : undefined
  }
  const stored = change?.status === 'PROPOSED' ? wordsRefusalOf(change.lastError) : null

  const footer =
    change && change.status === 'PROPOSED' ? (
      <>
        <Button size="sm" heldReason={say(declineWait)} onClick={() => !declineWait && !dialog && actions?.onDecline?.()}>
          {t(`${WOC}.leave`)}
        </Button>
        <Button size="sm" variant="primary" heldReason={say(applyWait)} onClick={() => !applyWait && !dialog && actions?.onApply?.()}>
          <Check size={14} aria-hidden /> {t(applyLabelOf(change, routeName))}
        </Button>
      </>
    ) : undefined

  const cells = change ? decideCellsOf(change, workOrder) : []
  const outcome = change ? outcomeWordsOf(change, review.customer) : null
  return (
    <>
      <DetailModal
        open
        onClose={() => nav.onOpen?.(null)}
        title={title}
        subtitle={subtitle}
        meta={change ? <Pill tone={STATUS_TONE[change.status]}>{said(change.words.status, locale)}</Pill> : undefined}
        nav={walk}
        loading={review.change.status === 'loading' && !change}
        error={error}
        onRetry={() => actions?.onRetry?.()}
        actions={footer}
      >
        {change && (
          <div className="fw-apv-review">
            <Banner tone="info" title={t(`${WOC}.why`, { reason: change.reason })} />
            {review.problem && (
              <Banner
                tone="danger"
                title={t(review.problem.key, { number })}
                action={
                  <span className="fw-apv-tags">
                    {review.problem.code === 'REPLAN_LAY' || review.problem.code === 'CUTTING_UNDER_WAY' ? layDoor(review.problem.lay) : null}
                    <Button size="sm" onClick={() => actions?.onRetry?.()}>
                      <RotateCcw size={14} aria-hidden /> {t(`${WOC}.readAgain`)}
                    </Button>
                  </span>
                }
              />
            )}
            {!review.problem && standing && change.status === 'PROPOSED' && <Banner tone="warning" title={say(standing)!} action={stop ? layDoor(stop.number) : undefined} />}
            {!review.problem && !standing && change.lastError && (
              <Banner tone="warning" title={t(`${WOC}.lastError`, { words: stored ? t(changeRefusalKeyOf(stored.code), { number }) : change.lastError })} action={stored?.lay ? layDoor(stored.lay) : undefined} />
            )}
            {change.status !== 'PROPOSED' && change.decidedAt && (
              <p className="fw-apv-hint">
                {t(`${WOC}.decided`, { status: said(change.words.status, locale), who: change.decidedBy?.name ?? t(`${WOC}.someone`), at: formatDateTime(change.decidedAt, { locale }) })}
                {change.decisionNote ? ` · ${t(`${WOC}.decisionNote`, { words: change.decisionNote })}` : ''}
              </p>
            )}
            <SummaryTable
              label={t(`${WOC}.cells.label`)}
              columns={[t(`${WOC}.cells.col.cell`), t(`${WOC}.cells.col.change`), t(`${WOC}.cells.col.now`), t(`${WOC}.cells.col.cut`)]}
              rows={cells.map((cell) => ({
                id: cell.key,
                cells: [
                  [cell.line !== null ? t(`${WOC}.cells.line`, { line: cell.line }) : null, cell.colourway, cell.size].filter(Boolean).join(' · '),
                  t(`${WOC}.cells.fromTo`, { from: cell.from, to: cell.to }),
                  cell.now === null ? '—' : cell.changed ? (
                    <Tag key="n" tone="warning">
                      {t(`${WOC}.cells.changed`, { now: cell.now })}
                    </Tag>
                  ) : (
                    String(cell.now)
                  ),
                  cell.cut === null && cell.bundled === null ? (workOrder ? t(`${WOC}.cells.notCounted`) : '—') : t(`${WOC}.cells.cutBundled`, { cut: cell.cut ?? '—', bundled: cell.bundled ?? '—' }),
                ],
              }))}
              density="roomy"
              stackOnPhone
            />
            {review.workOrder?.status === 'forbidden' || (change.workOrder && review.workOrder === null) ? <p className="fw-apv-hint">{t(`${WOC}.cells.noRight`)}</p> : null}
            {review.workOrder?.status === 'error' && <p className="fw-apv-hint">{t(`${WOC}.cells.notRead`)}</p>}
            {change.extra.length > 0 && (
              <section aria-labelledby="fw-apv-woc-extra">
                <h3 id="fw-apv-woc-extra" className="fw-apv-h">
                  {t(`${WOC}.extra.title`)}
                </h3>
                <ul className="fw-apv-list">
                  {change.extra.map((entry) => (
                    <li key={entry.workOrderSizeId}>{said(entry.words, locale)}</li>
                  ))}
                </ul>
                <p className="fw-apv-hint">{outcome ? t(`${WOC}.extra.outcome`, { outcome: said(outcome, locale) }) : t(`${WOC}.extra.none`)}</p>
              </section>
            )}
            {change.status === 'PROPOSED' && change.workOrder && (
              <section aria-labelledby="fw-apv-woc-lays">
                <h3 id="fw-apv-woc-lays" className="fw-apv-h">
                  {t(`${WOC}.lays.title`)}
                </h3>
                {review.lays === null ? (
                  <p className="fw-apv-hint">{workOrder?.status === 'DRAFT' ? t(`${WOC}.lays.draft`) : t(`${WOC}.lays.noRight`)}</p>
                ) : review.lays.status === 'loading' ? (
                  <p className="fw-apv-hint">{t(`${WOC}.lays.reading`)}</p>
                ) : review.lays.status !== 'ready' ? (
                  <p className="fw-apv-hint">{t(`${WOC}.lays.notRead`)}</p>
                ) : found && found.lays.length > 0 ? (
                  <ul className="fw-apv-list">
                    {found.lays.map((lay) => (
                      <li key={lay.id}>
                        <Link className="fw-apv-link" href={cutOrderHref(prefix, lay.id)}>
                          {lay.number}
                        </Link>{' '}
                        · {t(`${WOC}.lays.stand.${lay.stand}`)} · {lay.sizes.join(', ')}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="fw-apv-hint">{t(`${WOC}.lays.none`)}</p>
                )}
              </section>
            )}
            {change.status === 'PROPOSED' && (
              <section aria-labelledby="fw-apv-woc-does">
                <h3 id="fw-apv-woc-does" className="fw-apv-h">
                  {t(`${WOC}.does.title`)}
                </h3>
                <p className="fw-apv-hint">{t(`${WOC}.does.${routeName ?? 'unknown'}`)}</p>
                <p className="fw-apv-hint">{t(`${WOC}.does.proposal`)}</p>
              </section>
            )}
            <span className="fw-apv-tags">
              {change.workOrder && (
                <Button size="sm" variant="quiet" asChild>
                  <Link href={`${prefix}/production/work-orders/${encodeURIComponent(change.workOrder.id)}`}>
                    <ExternalLink size={14} aria-hidden /> {t(`${WOC}.openWorkOrder`, { number: change.workOrder.number })}
                  </Link>
                </Button>
              )}
              {change.madeWorkOrder && (
                <Button size="sm" variant="quiet" asChild>
                  <Link href={`${prefix}/production/work-orders/${encodeURIComponent(change.madeWorkOrder.id)}`}>
                    <ExternalLink size={14} aria-hidden /> {t(`${WOC}.openWorkOrder`, { number: change.madeWorkOrder.number })}
                  </Link>
                </Button>
              )}
              <Button size="sm" variant="quiet" asChild>
                <Link href={`${prefix}/sales/orders/${encodeURIComponent(change.salesOrder.id)}`}>
                  <ExternalLink size={14} aria-hidden /> {t(`${WOC}.openOrder`, { order: change.salesOrder.number })}
                </Link>
              </Button>
            </span>
          </div>
        )}
      </DetailModal>
      {change && dialog?.kind === 'decline' && <LeaveDialog change={change} dialog={dialog} offline={offline} actions={actions} />}
    </>
  )
}

/** "Leave as is…": why it stays as it is (1 to 300), the order's "Still to do" shows it; ⌘↵ sends. */
function LeaveDialog({ change, dialog, offline, actions }: { change: WorkOrderChange; dialog: NonNullable<ChangeReviewModel['dialog']>; offline: boolean; actions?: ChangeReviewActions | undefined }) {
  const t = useT('approvals')
  const held = declineHeld(change, dialog.words, { offline, busy: dialog.busy })
  const send = () => {
    if (held) return
    actions?.onDeclineSend?.()
  }
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog?.()}
      title={t(`${WOC}.leaveTitle`, { number: change.workOrder?.number ?? change.salesOrder.number })}
      size="sm"
      footer={
        <>
          <Button onClick={() => actions?.onCloseDialog?.()}>{t(`${WOC}.back`)}</Button>
          <Button variant="primary" heldReason={held ? t(held.key, held.params) : null} onClick={send}>
            {t(`${WOC}.leaveSend`)}
          </Button>
        </>
      }
    >
      <div
        className="fw-apv-review"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            send()
          }
        }}
      >
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem, { number: change.workOrder?.number ?? '' })} />}
        <Field label={t(`${WOC}.leaveWhy`)} required hint={t(`${WOC}.leaveHint`, { max: DECISION_LIMIT })}>
          <Textarea value={dialog.words} onChange={(event) => actions?.onDeclineWords?.(event.target.value)} rows={3} maxLength={DECISION_LIMIT} />
        </Field>
      </div>
    </Modal>
  )
}
