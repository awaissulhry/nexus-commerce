'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Lock, Mail, UserRound } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Input, RadioCard, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, Textarea } from '../../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { money } from '../../../../quotes/model'
import { MILESTONE_KINDS, SHORT_WHYS, type MilestoneKind, type MoneyPlanAct, type Order, type PlanFigures } from '../../../api'
import { dayInstant } from '../../../model'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { OpenStepDialog, WaiveDialog } from '../../schedule/view/StepVerbs'
import { DialogProblem, Frame } from '../../view/Dialogs'
import { beforeAfterOf, HAND_LABEL_MAX, HAND_REASON, handBodyOf, handInputOf, handWindowOf, reasonProblemOf, type HandInput } from '../hand'
import { planOf, type PlanRefusal } from '../plan'
import { acceptBodyOf, diffWordOf } from '../price' // F-OM-301
import { stillToPayOf } from '../totals'
import { useSay } from './say'

/**
 * F-OM-101 / 201 / 202 (order MONEY tab, 10-design §9) — the payment plan's windows, mounted ONCE by the page (OrderRecordView, the
 * GateDialogs pattern; centred DS modals, never a drawer): Waive… and Open for payment of a step with no day (as before); every hand
 * act of the plan (money/hand.ts: Change the deposit… · Move due day… · Ask for the deposit again… · Add a step… · Change amount… ·
 * Rename… · Remove step… · Undo opening · Change payment terms… · Accept short (bank charges)…) — each with its fields, the plan
 * before → after (its preview, read again as it is typed), What happens, The customer, What never changes, Why (required, office
 * only) and who and when; and Undo this payment…. A refusal stays in the window in this page's words; what was typed stays.
 */
export function MoneyDialogs({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const steps = model.scheduleSteps
  const dialog = model.dialog
  return (
    <>
      {steps?.waiving ? <WaiveDialog waiving={steps.waiving} model={steps} actions={actions?.scheduleSteps} /> : null}
      {steps?.opening ? <OpenStepDialog step={steps.opening} model={steps} today={model.today} actions={actions?.scheduleSteps} /> : null}
      {dialog?.kind === 'moneyPlan' ? <PlanDialog key={`${dialog.act}:${dialog.stepId ?? ''}:${dialog.requestId ?? ''}`} order={order} act={dialog.act} stepId={dialog.stepId} requestId={dialog.requestId} model={model} actions={actions} /> : null}
      {dialog?.kind === 'undoPayment' ? <UndoPaymentDialog key={dialog.paymentId} order={order} requestId={dialog.requestId} paymentId={dialog.paymentId} model={model} actions={actions} /> : null}
      {/* F-OM-301 (B-OM-020): Price check's ⋯ */}
      {dialog?.kind === 'priceAccept' || dialog?.kind === 'priceUnaccept' ? <PriceAcceptDialog key={dialog.kind} order={order} undo={dialog.kind === 'priceUnaccept'} model={model} actions={actions} /> : null}
    </>
  )
}

/** The five parts every hand window says (10-design §9): what happens, the customer, what never changes; the reason; who and when. */
function HandParts({ happens, told, never, reason, onReason, reasonError, code, who }: { happens: readonly string[]; told: string; never: string; reason: string; onReason: (value: string) => void; reasonError: string | null; code: boolean; /** F-OM-301 / 302: the window's own who-and-when line (else the plan's). */ who?: string }) {
  const t = useT('orders')
  return (
    <>
      <div className="fw-om-dlg-part">
        <span className="fw-om-dlg-h">{t('moneyTab.hand.whatHappens')}</span>
        <ul className="fw-om-dlg-list">
          {happens.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      <p className="fw-om-dlg-line">
        <Mail size={14} aria-hidden />
        <span>
          <b>{t('moneyTab.hand.customer')}</b> {told}
        </span>
      </p>
      <p className="fw-om-dlg-line">
        <Lock size={14} aria-hidden />
        <span>
          <b>{t('moneyTab.hand.neverLabel')}</b> {never}
        </span>
      </p>
      <Field label={t('moneyTab.hand.reason')} hint={t('moneyTab.hand.whyHint')} error={reason !== '' && reasonError ? reasonError : undefined} required>
        <Textarea value={reason} onChange={(event) => onReason(event.target.value)} rows={3} maxLength={HAND_REASON.max} />
      </Field>
      <p className="fw-om-dlg-line is-quiet">
        <UserRound size={14} aria-hidden />
        <span>{who ?? t(code ? 'moneyTab.hand.whoCode' : 'moneyTab.hand.who')}</span>
      </p>
    </>
  )
}

function PlanDialog({ order, act, stepId, requestId, model, actions }: { order: Order; act: MoneyPlanAct; stepId: string | null; requestId: string | null; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const say = useSay(order.currency)
  const schedule = model.schedule?.value ?? null
  const settlement = model.can.viewInvoices ? (model.settlement?.value ?? null) : null
  const plan = schedule ? planOf({ order, schedule, settlement, can: model.can, stepCan: model.scheduleSteps?.can ?? null, today: model.today, stillToPay: stillToPayOf(order, settlement) }) : null
  const row = plan?.rows.find((entry) => (requestId !== null && entry.request?.id === requestId) || (stepId !== null && entry.step?.id === stepId)) ?? null
  const step = row?.step ?? (stepId ? (schedule?.steps.find((entry) => entry.id === stepId) ?? null) : null)
  const request = row?.request ?? (requestId ? (order.chain.depositRequests.find((entry) => entry.id === requestId) ?? null) : null)
  const [input, setInput] = useState<HandInput>(() => handInputOf(act, { row, order, openSteps: plan?.openSteps ?? [], today: model.today }))
  const set = (patch: Partial<HandInput>) => setInput((now) => ({ ...now, ...patch }))
  const shape = handWindowOf(act, { order, row, price: model.can.price })
  const built = handBodyOf(act, input, { step, request, order, today: model.today, steps: schedule?.steps ?? [] })
  const state = model.moneyPlan
  // The preview is the act's own body (its reason too: the server's rule), read a moment after typing stops.
  const previewKey = built.body && !built.reasonProblem ? JSON.stringify(input) : null
  useEffect(() => {
    if (!built.body || !previewKey) return
    const body = built.body
    const timer = setTimeout(() => actions?.onPlanPreview?.(body), 350)
    return () => clearTimeout(timer)
    // The key is the typed input; the body follows it.
  }, [previewKey])
  const words = (refusal: PlanRefusal): string => ('key' in refusal ? say(refusal) : refusal[locale === 'it' ? 'it' : 'en'])
  const answer = previewKey ? (state?.preview?.value ?? null) : null
  // The server's refusal of the act as typed, said before the click (the preview answers it in words); it holds Go.
  const planned = answer?.refusal ? answer.refusal.words[locale === 'it' ? 'it' : 'en'] : null
  const held = model.busy ? t('held.busy') : built.problem ? say(built.problem) : built.reasonProblem ? say(built.reasonProblem) : planned
  const refused = state?.refused ? <Banner tone="danger" title={words(state.refused)} /> : <DialogProblem model={model} />
  const rows = beforeAfterOf(answer)
  const choices = (list: readonly { readonly id: string; readonly title: Parameters<typeof say>[0] }[]) => list.map((entry) => <option key={entry.id} value={entry.id}>{say(entry.title)}</option>)
  const fields: Record<string, ReactNode> = {
    share: (
      <Field key="share" label={t('moneyTab.hand.field.share')} hint={t('moneyTab.hand.field.shareHint')} error={input.share !== '' && built.problem?.key === 'moneyTab.hand.problem.share' ? say(built.problem) : undefined}>
        <Input value={input.share} onChange={(event) => set({ share: event.target.value })} inputMode="decimal" autoComplete="off" />
      </Field>
    ),
    day: (
      <Field key="day" label={t('moneyTab.hand.field.day')} hint={t(act === 'ADD_STEP' ? 'moneyTab.hand.field.dayOptional' : 'moneyTab.hand.field.dayHint')}>
        <DateField value={input.day} onChange={(day) => set({ day })} min={model.today} locale={INTL_LOCALE[locale]} ariaLabel={t('moneyTab.hand.field.day')} />
      </Field>
    ),
    kind: (
      <Field key="kind" label={t('moneyTab.hand.field.kind')}>
        <Select value={input.kind} onChange={(event) => set({ kind: event.target.value as HandInput['kind'] })}>
          {MILESTONE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`moneyTab.plan.kind.${kind}`)}
            </option>
          ))}
        </Select>
      </Field>
    ),
    label: (
      <Field key="label" label={t('moneyTab.hand.field.label')} hint={t('moneyTab.hand.field.labelHint')}>
        <Input value={input.label} onChange={(event) => set({ label: event.target.value })} maxLength={HAND_LABEL_MAX} autoComplete="off" />
      </Field>
    ),
    restTo: (
      <Field key="restTo" label={t('moneyTab.hand.field.restTo')}>
        <Select value={input.restTo} onChange={(event) => set({ restTo: event.target.value })}>
          <option value="">{t('moneyTab.hand.field.pick')}</option>
          {choices(row?.restTo ?? [])}
        </Select>
      </Field>
    ),
    from: (
      <Field key="from" label={t('moneyTab.hand.field.from')}>
        <Select value={input.from} onChange={(event) => set({ from: event.target.value })}>
          <option value="">{t('moneyTab.hand.field.pick')}</option>
          {choices(plan?.openSteps ?? [])}
        </Select>
      </Field>
    ),
    terms: (
      <Field key="terms" label={t('moneyTab.hand.field.terms')} hint={t('moneyTab.hand.field.termsHint')}>
        {!state?.terms || (!state.terms.value && !state.terms.problem) ? (
          <p className="fw-pt-quiet" role="status">
            <Spinner size={12} /> {t('moneyTab.hand.field.termsReading')}
          </p>
        ) : state.terms.value ? (
          <Select value={input.termsId} onChange={(event) => set({ termsId: event.target.value })}>
            <option value="">{t('moneyTab.hand.field.pick')}</option>
            {state.terms.value.map((terms) => (
              <option key={terms.id} value={terms.id}>
                {terms.name}
              </option>
            ))}
          </Select>
        ) : (
          <p className="fw-pt-quiet">{t('moneyTab.hand.field.termsFailed')}</p>
        )}
      </Field>
    ),
    why: (
      <fieldset key="why" className="fw-so-choices">
        <legend className="fw-om-dlg-h">{t('moneyTab.hand.field.shortWhy')}</legend>
        {SHORT_WHYS.map((why) => (
          <RadioCard key={why} variant="row" name="fw-om-short-why" value={why} checked={input.why === why} selected={input.why === why} onChange={() => set({ why })} title={t(`moneyTab.hand.why.${why}`)} />
        ))}
      </fieldset>
    ),
  }
  const figuresOf = (kind: MilestoneKind, figures: PlanFigures | null): string => {
    if (!figures) return t('moneyTab.hand.ba.none')
    const amount = model.can.price && figures.amount !== undefined ? ` · ${money(figures.amount, order.currency, locale)}` : ''
    const due = figures.dueDate ? ` · ${formatDate(dayInstant(figures.dueDate), { locale })}` : ''
    return `${figures.label?.trim() || t(`moneyTab.plan.kind.${kind}`)}${amount}${due}`
  }
  return (
    <Frame
      title={say(shape.title)}
      held={held}
      go={() => built.body && actions?.onPlanAct?.(built.body)}
      goLabel={model.busy ? t('common.working') : say(shape.go)}
      tone={shape.danger ? 'danger' : 'primary'}
      onClose={() => actions?.onDialog?.(null)}
      problem={refused}
      size={act === 'CHANGE_TERMS' ? 'lg' : 'md'}
    >
      {shape.sub ? <p className="fw-so-hint">{say(shape.sub)}</p> : null}
      {shape.fields.length > 0 ? <div className="fw-om-dlg-grid">{shape.fields.map((field) => fields[field])}</div> : null}
      {/* The plan before → after, from the server's preview — read once the act and its reason are typed; its refusal said here. */}
      {planned ? (
        <Banner tone="warning" title={planned} />
      ) : !previewKey ? (
        <p className="fw-pt-quiet">{t('moneyTab.hand.ba.waits')}</p>
      ) : state?.preview?.problem ? (
        <p className="fw-pt-quiet">{t('moneyTab.hand.ba.failed')}</p>
      ) : rows ? (
        <div className="fw-om-dlg-part">
          <span className="fw-om-dlg-h">{t('moneyTab.hand.ba.title')}</span>
          <table className="fw-om-ba">
            <thead>
              <tr>
                <th>{t('moneyTab.hand.ba.now')}</th>
                <th>{t('moneyTab.hand.ba.after')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => (
                <tr key={entry.key}>
                  <td>{entry.added ? t('moneyTab.hand.ba.new') : figuresOf(entry.kind, entry.before)}</td>
                  <td>{entry.removed ? t('moneyTab.hand.ba.removed') : figuresOf(entry.kind, entry.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !answer ? (
        <p className="fw-pt-quiet" role="status">
          <Spinner size={12} /> {t('moneyTab.hand.ba.reading')}
        </p>
      ) : null}
      <HandParts happens={shape.happens.map(say)} told={say(shape.told)} never={say(shape.never)} reason={input.reason} onReason={(reason) => set({ reason })} reasonError={built.reasonProblem ? say(built.reasonProblem) : null} code={shape.code || answer?.preview?.needsFreshCode === true} />
    </Frame>
  )
}

/**
 * F-OM-202 (B-OM-017, 10-design D3): Undo this payment… — the payment is taken off this request and voided when it then pays nothing
 * else, in one step; never deleted (Voided, with the reason). A SOFT-locked month asks why it goes in anyway.
 */
function UndoPaymentDialog({ order, requestId, paymentId, model, actions }: { order: Order; requestId: string; paymentId: string; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const payment = model.schedule?.value?.requests?.find((entry) => entry.id === requestId)?.payments?.find((entry) => entry.paymentId === paymentId) ?? null
  const [reason, setReason] = useState('')
  const [lockReason, setLockReason] = useState('')
  const lockAsked = model.moneyPlan?.lockAsked ?? false
  const reasonProblem = reasonProblemOf(reason)
  const lockProblem = lockAsked ? reasonProblemOf(lockReason) : null
  const held = model.busy ? t('held.busy') : reasonProblem ? t(reasonProblem.key) : lockProblem ? t('moneyTab.lock.problem') : null
  const day = payment ? formatDate(dayInstant(payment.receivedOn), { locale }) : ''
  return (
    <Frame
      title={t('moneyTab.undo.title', { date: day })}
      held={held}
      go={() => actions?.onUndoPayment?.({ paymentId, requestId, reason, ...(lockAsked ? { lockReason } : {}) })}
      goLabel={model.busy ? t('common.working') : t('moneyTab.undo.go')}
      tone="danger"
      onClose={() => actions?.onDialog?.(null)}
      problem={<DialogProblem model={model} />}
    >
      {payment ? <p className="fw-so-hint">{[t('moneyTab.plan.payments.ref', { ref: payment.externalRef }), ...(model.can.price && payment.amount !== undefined ? [money(payment.amount, order.currency, locale)] : [])].join(' · ')}</p> : null}
      {lockAsked ? (
        <Field label={t('moneyTab.lock.label')} hint={t('moneyTab.lock.hint')} required>
          <Textarea value={lockReason} onChange={(event) => setLockReason(event.target.value)} rows={2} maxLength={HAND_REASON.max} />
        </Field>
      ) : null}
      <HandParts happens={[t('moneyTab.undo.happens.reversed'), t('moneyTab.undo.happens.open'), t('moneyTab.undo.happens.production')]} told={t('moneyTab.undo.told')} never={t('moneyTab.undo.never')} reason={reason} onReason={setReason} reasonError={reasonProblem ? t(reasonProblem.key) : null} code={false} />
    </Frame>
  )
}

/**
 * F-OM-301 (B-OM-020, 10-design D8; L3) — Accept the difference on {number}: both prices stay as they are; the check says "≠ Not equal ·
 * Accepted by hand" with the name, the day and the reason, and opens again by itself when either price changes; the customer is not
 * told. Undo the acceptance…: the check says "Not equal" again; the history keeps the acceptance. Each with its reason (office only).
 */
function PriceAcceptDialog({ order, undo, model, actions }: { order: Order; undo: boolean; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const say = useSay(order.currency)
  const read = model.priceCheck?.read
  const check = read?.state === 'ready' ? read.check : null
  const [reason, setReason] = useState('')
  const reasonProblem = reasonProblemOf(reason)
  const body = check && !undo ? acceptBodyOf(check, reason) : null
  const held = model.busy ? t('held.busy') : !check || (!undo && !body) ? t('moneyTab.price.accept.gone') : reasonProblem ? say(reasonProblem) : null
  const diff = check ? diffWordOf(check.total.priceDiff) : null
  const ns = undo ? 'moneyTab.price.unaccept' : 'moneyTab.price.accept'
  return (
    <Frame
      title={t(`${ns}.title`, { number: order.number })}
      held={held}
      go={() => (undo ? actions?.onPriceUnaccept?.(reason) : body && actions?.onPriceAccept?.(body))}
      goLabel={model.busy ? t('common.working') : t(`${ns}.go`)}
      tone={undo ? 'danger' : 'primary'}
      onClose={() => actions?.onDialog?.(null)}
      problem={<DialogProblem model={model} />}
    >
      {check && check.total.brandPrice !== null ? (
        <p className="fw-so-hint">
          {t('moneyTab.price.accept.sub', { lines: t('priceCheck.lines', { count: check.total.priceNotEqualLines }), ours: money(check.total.ourPrice, check.currency, locale), theirs: money(check.total.brandPrice, check.currency, locale) })}
          {diff ? ` · ${say(diff)}` : ''}
        </p>
      ) : null}
      <HandParts
        happens={undo ? [t('moneyTab.price.unaccept.happens.again'), t('moneyTab.price.unaccept.happens.kept')] : [t('moneyTab.price.accept.happens.stay'), t('moneyTab.price.accept.happens.shows'), t('moneyTab.price.accept.happens.reopens')]}
        told={t(`${ns}.told`)}
        never={t(`${ns}.never`)}
        reason={reason}
        onReason={setReason}
        reasonError={reasonProblem ? say(reasonProblem) : null}
        code={false}
        who={t('moneyTab.price.accept.who')}
      />
    </Frame>
  )
}
