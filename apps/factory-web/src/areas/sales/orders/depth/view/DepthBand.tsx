'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Hourglass } from 'lucide-react'
import { Banner, Field, KeyValue, type MenuItemDef } from '@nexus/ui/components'
import { Button, Pill, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { OpenApproval, Order } from '../../api'
import { askHeld, depthEditHeld, NAMESPACE, onlyMeasurements, openRequest, PRIORITY_TONE, waitPhrases, withdrawHeld } from '../model'
import { bannerYesOf, confirmLabelOf, refuseProblemOf, REFUSE_WORDS_MAX, yesDoorOf, type YesDoor } from '../model' // F-OP-101
import type { OrderDepthActions, OrderDepthModel } from '../use-order-depth'
import type { OrderRecordModel, YesActions } from '../../record/record-model' // F-OP-101
import { Frame } from '../../record/view/Dialogs' // F-OP-101: the order's dialog frame
import '../depth.css'

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * The band's depth (B-W2b-323; design sales.orders grid Priority (W2b) and Season (W2b), shown on the order too): the priority
 * (URGENT with its reason), the season, and the band's notice. Fetches nothing.
 */
export function DepthPills({ model }: { model: OrderDepthModel }) {
  return (
    <WithMessages namespaces={[NAMESPACE, 'orders' /* F-SA-230 */]}>
      <Pills model={model} />
    </WithMessages>
  )
}

function Pills({ model }: { model: OrderDepthModel }) {
  const d = useT(NAMESPACE)
  const o = useT('orders') // F-SA-230: "Priority · High" / "Priority · Top", the board card's words (one word per meaning)
  const depth = model.depth.value
  if (!depth) return null
  const level = depth.priority.level
  return (
    <>
      {level !== 'NORMAL' && (
        <Pill tone={PRIORITY_TONE[level]} title={depth.priority.urgentReason ?? undefined}>
          {o('board.priority', { level: d(`priority.level.${level}`) })}
        </Pill>
      )}
      {level === 'URGENT' && depth.priority.urgentReason && <span className="fw-sod-reason">{depth.priority.urgentReason}</span>}
      {depth.season && <Tag tone="neutral">{d('season.tag', { code: depth.season.code })}</Tag>}
      {depth.confirmation.sentAt && depth.confirmation.sentVersion !== null && <Tag tone="success">{d('confirmation.sentTag', { version: depth.confirmation.sentVersion })}</Tag>}
    </>
  )
}

/** The record's ⋯ verbs of the depth: Set priority…, Set season… (each held with its reason). */
export function depthMenuItems(order: Order, model: OrderDepthModel | undefined, actions: OrderDepthActions | undefined, d: Translate): MenuItemDef[] {
  if (!model || !model.can.manage) return []
  const held = depthEditHeld(order.status, model.can)
  const depth = model.depth.value
  return [
    { id: 'depth-priority', label: d('action.priority'), disabled: !!held || !depth, description: held ? d(held.key) : undefined, onSelect: () => depth && actions?.onDialog?.({ kind: 'priority', level: depth.priority.level, reason: depth.priority.urgentReason ?? '' }) },
    { id: 'depth-season', label: d('action.season'), disabled: !!held || !depth, description: held ? d(held.key) : undefined, onSelect: () => depth && actions?.onDialog?.({ kind: 'season', seasonId: depth.season?.id ?? '' }) },
  ]
}

/**
 * "Waiting for a yes" (B-W2b-303's SALES_ORDER kind; the order is PENDING_APPROVAL): why it waits, in words — a request open
 * (who decides, since when), nobody asked yet, the customer's credit — with Ask for a yes and Take the request back, each held
 * with its reason. Nobody decides their own request.
 * F-OP-101 (10-order-page §2.4): the yes moves onto the page — a candidate approver who did not ask gets **Confirm the order**
 * (primary) and **Refuse…** (words required), the order read's own rows (B-OP-020); the asker sees Confirm held ("You asked for this
 * yes: another person decides"); anybody else keeps Ask / Take back and reads "Who decides: …". Open Approvals stays a quiet link.
 */
export function WaitingBanner({ model, actions, prefix, yes, onYes }: { model: OrderDepthModel; actions?: OrderDepthActions; prefix: string; /* F-OP-101 */ yes?: { readonly approvals: readonly OpenApproval[] | undefined; readonly busy: boolean }; onYes?: YesActions }) {
  return (
    <WithMessages namespaces={[NAMESPACE, 'orders' /* F-OP-101: approval.* */]}>
      <Waiting model={model} actions={actions} prefix={prefix} yes={yes} onYes={onYes} />
    </WithMessages>
  )
}

function Waiting({ model, actions, prefix, yes, onYes }: { model: OrderDepthModel; actions?: OrderDepthActions; prefix: string; yes?: { readonly approvals: readonly OpenApproval[] | undefined; readonly busy: boolean }; onYes?: YesActions }) {
  const d = useT(NAMESPACE)
  const t = useT('orders') // F-OP-101
  const locale = useLocale()
  const part = model.approval
  if (!part) return null
  if (!part.value) {
    return part.problem ? (
      <Banner
        tone="danger"
        title={d('wait.failed')}
        action={
          <Button size="sm" onClick={() => actions?.onRetry?.('approval')}>
            {d('common.retry')}
          </Button>
        }
      >
        {d(part.problem)}
      </Banner>
    ) : null
  }
  const approval = part.value
  // B-W2b-368: waiting only for the factory review — the review banner says it (no yes is asked).
  if (!approval.waiting || onlyMeasurements(approval)) return null
  const request = openRequest(approval)
  const ask = askHeld(approval, model.can)
  const withdraw = withdrawHeld(approval, model.can)
  // ---- F-OP-101: the yes this reader decides here (the order's own first), the one they asked (held), who decides the others ----
  const doors = bannerYesOf(yes?.approvals).map((task) => yesDoorOf(task, model.busy || !!yes?.busy))
  const decide = doors.find((door): door is Extract<YesDoor, { kind: 'decide' }> => door.kind === 'decide') ?? null
  const asked = doors.find((door) => door.kind === 'selfAsked') ?? null
  // ---- end F-OP-101
  return (
    <div className="fw-sod-wait" role="region" aria-label={d('wait.title')}>
      <Banner
        tone="warning"
        icon={<Hourglass size={16} aria-hidden />}
        title={d('wait.title')}
        action={
          <span className="fw-sod-actions">
            {decide ? (
              // F-OP-101: the approver decides in place — Confirm the order (primary) and Refuse… (words required).
              <YesDoorView door={decide} onYes={onYes} />
            ) : request ? (
              <>
                {/* F-OP-101 (rule 42): the asker sees the yes held, never theirs to give. */}
                {asked && <YesDoorView door={asked} onYes={onYes} />}
                <Button size="sm" heldReason={withdraw ? d(withdraw.key) : model.busy ? d('held.busy') : null} onClick={() => actions?.onDialog?.({ kind: 'withdraw' })}>
                  {d('wait.withdraw')}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="primary" heldReason={ask ? d(ask.key) : model.busy ? d('held.busy') : null} onClick={() => actions?.onDialog?.({ kind: 'ask', note: '' })}>
                {d('wait.ask')}
              </Button>
            )}
            <Button size="sm" variant="quiet" asChild>
              <Link href={`${prefix}/home/approvals`}>{d('wait.openApprovals')}</Link>
            </Button>
          </span>
        }
      >
          <span className="fw-sod-stack">
            {waitPhrases(approval).map((entry) => (
              <span key={entry.key}>{d(entry.key, entry.params)}</span>
            ))}
            {request && (
              <span className="fw-sod-hint">
                {request.approver ? d('wait.askedOf', { who: request.approver, date: formatDate(request.requestedAt, { locale }) }) : d('wait.asked', { date: formatDate(request.requestedAt, { locale }) })}
                {request.mine && ` · ${d('wait.mine')}`}
              </span>
            )}
            {/* F-OP-101: what each open yes asks of this reader — held for the asker, who decides for everyone else. */}
            {doors.map((door) =>
              door.kind === 'decide' ? null : (
                <span key={door.task.taskId} className="fw-sod-hint">
                  {doors.length > 1 ? `${locale === 'en' ? door.task.kindLabel.en : door.task.kindLabel.it} · ` : ''}
                  {door.kind === 'selfAsked' ? t('approval.selfAsked') : t('approval.whoDecides', { who: door.who })}
                </span>
              ),
            )}
          </span>
      </Banner>
    </div>
  )
}

// ---- F-OP-101: one open yes's door — the approver's Confirm (or Approve) and Refuse…, the asker's Confirm held with its words, who
// decides for everyone else. The banner draws it, and an old change's yes on its waiting row (F-OP-103).
export function YesDoorView({ door, onYes }: { door: YesDoor; onYes?: YesActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const say = (phrase: { key: string; params?: Record<string, string | number> } | null) => (phrase ? t(phrase.key, phrase.params) : null)
  if (door.kind === 'whoDecides') return <span className="fw-sod-hint">{t('approval.whoDecides', { who: door.who })}</span>
  if (door.kind === 'selfAsked') {
    return (
      <Button size="sm" variant="primary" heldReason={t('approval.selfAsked')}>
        {say(confirmLabelOf(door.task, locale))}
      </Button>
    )
  }
  return (
    <>
      <Button size="sm" variant="primary" heldReason={say(door.confirmHeld)} onClick={() => onYes?.onConfirm?.(door.task.taskId)}>
        {say(confirmLabelOf(door.task, locale))}
      </Button>
      <Button size="sm" heldReason={say(door.refuseHeld)} onClick={() => onYes?.onRefuse?.(door.task.taskId)}>
        {t('approval.refuse')}
      </Button>
    </>
  )
}

// ---- F-OP-101: Refuse… — the reason a no names (the tenant's "Why an approver says no" list) and the words (required) ----------------
/**
 * The no of one open yes (the band's, or an old change's waiting row): its kind and who asked, the reason picked from the list, the
 * words typed (1 to 2000 characters, the engine's own rule); Refuse sends the task's version. A refusal is said inside it; what was
 * typed stays.
 */
// ---- F-CP-108 (customer page plan C2b; lane agreement (a)): TYPE ONLY — Refuse… takes the narrow part of the record's model it reads, so
// the Orders sheet's row ("Confirm or refuse…") mounts THIS dialog in place; the record passes its whole model as before.
export type RefuseYesModel = Pick<OrderRecordModel, 'dialog' | 'draft' | 'refuseReasons' | 'busy' | 'dialogProblem'>
// ---- end F-CP-108
export function RefuseYesDialog({ order, model, actions }: { order: Order; model: RefuseYesModel /* F-CP-108: type only */; actions?: { readonly onDialog?: (dialog: null) => void; readonly yes?: YesActions } }) {
  return (
    <WithMessages namespaces={['orders']}>
      <Refuse order={order} model={model} actions={actions} />
    </WithMessages>
  )
}

function Refuse({ order, model, actions }: { order: Order; model: RefuseYesModel /* F-CP-108: type only */; actions?: { readonly onDialog?: (dialog: null) => void; readonly yes?: YesActions } }) {
  const t = useT('orders')
  const locale = useLocale()
  const dialog = model.dialog
  const [reasonCode, setReasonCode] = useState(model.draft?.reasonCode ?? '')
  const [words, setWords] = useState(model.draft?.reason ?? '')
  if (dialog?.kind !== 'refuseYes') return null
  const task = (order.openApprovals ?? []).find((entry) => entry.taskId === dialog.taskId) ?? null
  const reasons = model.refuseReasons ?? null
  const problem = refuseProblemOf({ reasonCode, words })
  const held = model.busy ? t('held.busy') : !task ? t('approval.refused.NOT_PENDING') : !reasons?.value ? t('approval.no.reading') : problem ? t(problem.key, problem.params) : null
  const close = () => actions?.onDialog?.(null)
  return (
    <Frame
      title={t('approval.refuseTitle', { number: order.number })}
      held={held}
      go={() => task && actions?.yes?.onRefuseConfirm?.(task.taskId, reasonCode, words.trim())}
      goLabel={model.busy ? t('common.working') : t('approval.refuseGo')}
      onClose={close}
      problem={model.dialogProblem ? <Banner tone="danger" title={t(model.dialogProblem.key, model.dialogProblem.params)} /> : null}
      tone="danger"
      size="sm"
    >
      {task && (
        <KeyValue
          dense
          labelCase="sentence"
          items={[
            { label: t('approval.kind'), value: locale === 'en' ? task.kindLabel.en : task.kindLabel.it },
            { label: t('approval.askedBy'), value: t('approval.askedByOn', { who: task.requester.name, date: formatDate(task.requestedAt, { locale }) }) },
          ]}
        />
      )}
      <Field label={t('approval.no.reason')}>
        {!reasons || (reasons.value === null && reasons.problem === null) ? (
          <Skeleton height={32} />
        ) : reasons.value === null ? (
          <Banner
            tone="danger"
            title={t(reasons.problem ?? 'problem.read.internal')}
            action={
              <Button size="sm" onClick={() => actions?.yes?.onRefuseReasons?.()}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : (
          <Select value={reasonCode} onChange={(event) => setReasonCode(event.target.value)}>
            <option value="">{t('approval.no.pick')}</option>
            {reasons.value.map((reason) => (
              <option key={reason.code} value={reason.code}>
                {locale === 'en' ? reason.labelEn : reason.labelIt}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('approval.no.words')} hint={t('approval.no.wordsHint')}>
        <Textarea value={words} onChange={(event) => setWords(event.target.value)} rows={3} maxLength={REFUSE_WORDS_MAX + 10} />
      </Field>
    </Frame>
  )
}
// ---- end F-OP-101

/** The depth's own notice (a write that went, a refusal outside a dialog). */
export function DepthNotice({ model, actions }: { model: OrderDepthModel; actions?: OrderDepthActions }) {
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <Notice model={model} actions={actions} />
    </WithMessages>
  )
}

function Notice({ model, actions }: { model: OrderDepthModel; actions?: OrderDepthActions }) {
  const d = useT(NAMESPACE)
  if (!model.notice) return null
  return (
    <Banner
      tone={model.notice.tone}
      title={d(model.notice.words.key, model.notice.words.params)}
      action={
        <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
          {d('common.dismiss')}
        </Button>
      }
    />
  )
}
