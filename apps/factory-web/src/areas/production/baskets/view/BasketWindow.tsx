'use client'

import Link from 'next/link'
import { Check, CircleAlert, Hourglass, Image as ImageIcon, Package, Printer, ShoppingBag, UserRound } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { DeptChip } from '../../../../lib/department/view/DeptChip'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WindowShell } from '../../../../lib/window-shell/view/WindowShell'
import type { BasketRead, BoardCard, MoveReason } from '../api'
import { MOVE_REASONS } from '../api'
import { BASKETS_NAMESPACE, customerWords, departmentOf, moveTargets, orderHref, type MoveTarget } from '../model'

/**
 * owb-fl9 step 1 — the basket window (P/office.js modal 'basket'; centred, a bottom sheet on a phone): the big picture, the customer,
 * where it is · **Design page** · **Open the order** · **Problem solved** (today's call answer) · **Move it to** a step of ITS route or
 * Ready to ship (back asks why: Work again · Moved by mistake · Other) · **Give it to** (names only, where the site names workers) ·
 * **Print its card and pages again…** (S3's window, hidden while its slot is a stub). A person without the right reads the basket.
 */

export interface BasketWindowModel {
  readonly card: BoardCard
  readonly read: BasketRead | null
  readonly state: 'loading' | 'ready' | 'failed'
  readonly prefix: string
  readonly can: { readonly move: boolean; readonly back: boolean; readonly solve: boolean; readonly give: boolean; readonly printAgain: boolean }
  readonly people: readonly { readonly workerId: string; readonly name: string }[]
  /** A move back waits for its reason. */
  readonly backTo: MoveTarget | null
  readonly busy: boolean
  /** The words of the last refusal or failure (null: none). */
  readonly problem: string | null
  /** What just happened (null: nothing yet). */
  readonly done: string | null
}

export interface BasketWindowActions {
  readonly onClose: () => void
  readonly onMove: (target: MoveTarget) => void
  readonly onReason: (reason: MoveReason) => void
  readonly onSolve: () => void
  readonly onGive: (workerId: string) => void
  readonly onPrintAgain: () => void
}

export function BasketWindow({ model, actions }: { model: BasketWindowModel; actions: BasketWindowActions }) {
  const t = useT(BASKETS_NAMESPACE)
  const locale = useLocale()
  const { card, read } = model
  const orderId = card.salesOrderId ?? read?.basket.salesOrderId ?? null
  const steps = read?.route.steps ?? []
  const place = read?.place?.operationId ?? card.step?.operationId ?? null
  const targets = moveTargets(steps, place)
  const problem = read?.flags?.problem ?? card.flags?.problem ?? null
  const picture = read?.picture?.src ?? card.picture?.src ?? null
  const hereDept = card.step?.department ? departmentOf(card.step.department, locale) : null

  return (
    <WindowShell
      open
      onClose={actions.onClose}
      title={t('window.title', { code: card.code })}
      subtitle={customerWords(card, 'office')}
      size="lg"
      closeHeld={model.busy ? t('window.busy') : null}
      more={
        model.can.printAgain && orderId ? (
          <Button size="sm" variant="quiet" onClick={actions.onPrintAgain}>
            <Printer aria-hidden /> {t('window.printAgain')}
          </Button>
        ) : undefined
      }
    >
      <div className="fw-bb-window">
        <div className="fw-bb-whead">
          <span className="fw-bb-wpic" aria-hidden>
            {picture ? <img src={picture} alt="" /> : <ImageIcon />}
          </span>
          <div className="fw-bb-wtext">
            <p className="fw-bb-wwhere">
              {hereDept ? <DeptChip dept={hereDept} /> : <span className="fw-bb-ready"><Package aria-hidden /> {t('column.ready')}</span>}
              {card.progress ? <span className="fw-bb-progress">{t('card.progress', { done: card.progress.done, total: card.progress.total })}</span> : null}
            </p>
            {card.worker?.name ? (
              <p className="fw-bb-muted">
                <UserRound aria-hidden className="fw-bb-icon" /> {t('window.has', { name: card.worker.name })}
              </p>
            ) : null}
            <div className="fw-bb-wacts">
              {orderId ? (
                <Button size="sm" asChild>
                  <Link href={orderHref(model.prefix, orderId, 'files')}>
                    <ImageIcon aria-hidden /> {t('window.designPage')}
                  </Link>
                </Button>
              ) : null}
              {orderId ? (
                <Button size="sm" asChild>
                  <Link href={orderHref(model.prefix, orderId, 'production')}>
                    <ShoppingBag aria-hidden /> {t('window.openOrder')}
                  </Link>
                </Button>
              ) : null}
              {problem && model.can.solve ? (
                <Button size="sm" variant="primary" heldReason={model.busy ? t('window.busy') : null} onClick={actions.onSolve}>
                  <Check aria-hidden /> {t('window.solved')}
                </Button>
              ) : null}
            </div>
          </div>
        </div>

        {model.problem ? <Banner tone="danger" title={model.problem} /> : null}
        {model.done ? <Banner tone="success" title={model.done} /> : null}

        <section className="fw-bb-wsec" aria-labelledby="fw-bb-move">
          <h3 id="fw-bb-move" className="fw-bb-wh">
            {t('window.moveTo')}
          </h3>
          {model.state === 'loading' ? (
            <p className="fw-bb-muted">
              <Hourglass aria-hidden className="fw-bb-icon" /> {t('window.loading')}
            </p>
          ) : null}
          {model.state === 'failed' ? (
            <p className="fw-bb-muted">
              <CircleAlert aria-hidden className="fw-bb-icon" /> {t('window.routeFailed')}
            </p>
          ) : null}
          {model.state === 'ready' && !model.can.move ? <p className="fw-bb-muted">{t('window.readOnly')}</p> : null}
          {model.state === 'ready' && model.can.move ? (
            <>
              <div className="fw-bb-targets" role="group" aria-labelledby="fw-bb-move">
                {targets.map((target) => {
                  const dept = target.step?.department ? departmentOf(target.step.department, locale) : null
                  const held = model.busy ? t('window.busy') : target.held ? t('window.packFirst') : target.kind === 'BACK' && !model.can.back ? t('window.backLeader') : null
                  return (
                    <Button key={target.operationId ?? 'ready'} size="sm" variant={model.backTo?.operationId === target.operationId && model.backTo !== null ? 'tonal' : 'secondary'} heldReason={held} onClick={() => actions.onMove(target)}>
                      {dept ? <DeptChip dept={dept} /> : target.step ? target.step.name : <span className="fw-bb-ready"><Package aria-hidden /> {t('column.ready')}</span>}
                      {target.kind === 'BACK' ? <span className="fw-bb-back">{t('window.back')}</span> : null}
                    </Button>
                  )
                })}
              </div>
              <p className="fw-bb-muted">{t('window.moveHint')}</p>
              {model.backTo ? (
                <div className="fw-bb-why" role="group" aria-label={t('window.why')}>
                  <span className="fw-bb-wh">{t('window.why')}</span>
                  {MOVE_REASONS.map((reason) => (
                    <Button key={reason} size="sm" variant="secondary" heldReason={model.busy ? t('window.busy') : null} onClick={() => actions.onReason(reason)}>
                      {t(`reason.${reason}`)}
                    </Button>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </section>

        {model.can.give && model.people.length > 0 ? (
          <section className="fw-bb-wsec" aria-labelledby="fw-bb-give">
            <h3 id="fw-bb-give" className="fw-bb-wh">
              {t('window.giveTo')}
            </h3>
            <div className="fw-bb-targets" role="group" aria-labelledby="fw-bb-give">
              {model.people.map((person) => (
                <Button key={person.workerId} size="sm" variant="secondary" aria-pressed={card.worker?.name === person.name} heldReason={model.busy ? t('window.busy') : null} onClick={() => actions.onGive(person.workerId)}>
                  <UserRound aria-hidden /> {person.name}
                </Button>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </WindowShell>
  )
}
