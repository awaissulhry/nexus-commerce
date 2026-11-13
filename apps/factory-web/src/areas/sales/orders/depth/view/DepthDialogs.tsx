'use client'

import { useMemo } from 'react'
import { Banner, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Input, Radio, SegmentedControl, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { DateField, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { INTL_LOCALE, type Locale } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { DocumentSendView } from '../../../../_shared/document-send/view/DocumentSendView'
import { money } from '../../../quotes/model'
import type { Order } from '../../api'
import { dayInstant, romeToday } from '../../model'
import { Frame } from '../../record/view/Dialogs'
import { PRIORITY_LEVELS, type FreezeField, type PriorityLevel } from '../api'
import { confirmationHref, depositKindChoices, frozenProblemsOf, NAMESPACE, pricedProblems, sizeMoves, urgentReasonProblem, URGENT_REASON_MAX, type DepositMode } from '../model'
import type { OrderDepthActions, OrderDepthModel } from '../use-order-depth'

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * The depth's dialogs on the order studio (B-W2b-323): Set priority (URGENT asks its reason), Set season (the company's open
 * seasons), Ask for a yes, Take the request back, Put the order back, Send the confirmation (the ONE send dialog, SCR-037) and
 * the priced change (SAL-219: what moved and its price, the fee, the extra deposit and its kind — the caparra penitenziale shown
 * and held while it is off —, whether a yes is asked, the reason). Each says a refusal inside itself; what was typed stays.
 */
export function DepthDialogs({ order, model, actions, prefix }: { order: Order; model: OrderDepthModel; actions?: OrderDepthActions; prefix: string }) {
  if (!model.dialog) return null
  return (
    <WithMessages namespaces={[NAMESPACE, 'orders']}>
      <Dialogs order={order} model={model} actions={actions} prefix={prefix} />
    </WithMessages>
  )
}

function Dialogs({ order, model, actions, prefix }: { order: Order; model: OrderDepthModel; actions?: OrderDepthActions; prefix: string }) {
  const dialog = model.dialog
  if (!dialog) return null
  if (dialog.kind === 'priority') return <PriorityDialog order={order} model={model} actions={actions} />
  if (dialog.kind === 'season') return <SeasonDialog order={order} model={model} actions={actions} />
  if (dialog.kind === 'ask' || dialog.kind === 'withdraw') return <YesDialog order={order} model={model} actions={actions} />
  if (dialog.kind === 'putBack') return <PutBackDialog order={order} model={model} actions={actions} />
  if (dialog.kind === 'send') return <SendDialog order={order} model={model} actions={actions} prefix={prefix} />
  if (dialog.kind === 'priced') return <PricedDialog order={order} model={model} actions={actions} />
  return null
}

function Problem({ model }: { model: OrderDepthModel }) {
  const d = useT(NAMESPACE)
  return model.problem ? <Banner tone="danger" title={d(model.problem.key, model.problem.params)} /> : null
}

const closeOf = (actions?: OrderDepthActions) => () => actions?.onDialog?.(null)

// ---- Set priority ---------------------------------------------------------------------------------------------------------

function PriorityDialog({ order, model, actions }: { order: Order; model: OrderDepthModel; actions?: OrderDepthActions }) {
  const d = useT(NAMESPACE)
  const dialog = model.dialog
  if (dialog?.kind !== 'priority') return null
  const now = model.depth.value?.priority ?? null
  const problem = urgentReasonProblem(dialog.level, dialog.reason)
  const same = now !== null && now.level === dialog.level && (dialog.level !== 'URGENT' || (now.urgentReason ?? '') === dialog.reason.trim())
  const held = model.busy ? d('held.busy') : problem ? d(problem) : same ? d('held.prioritySame') : null
  const set = (next: Partial<{ level: PriorityLevel; reason: string }>) => actions?.onDialog?.({ ...dialog, ...next })
  return (
    <Frame title={d('priority.title', { number: order.number })} held={held} go={() => actions?.onPriority?.()} goLabel={model.busy ? d('common.working') : d('priority.go')} onClose={closeOf(actions)} problem={<Problem model={model} />} size="sm">
      <fieldset className="fw-sod-radios">
        <legend className="fw-sod-legend">{d('priority.legend')}</legend>
        {PRIORITY_LEVELS.map((level) => (
          <Radio key={level} name="fw-sod-priority" value={level} checked={dialog.level === level} onChange={() => set({ level })} label={d(`priority.level.${level}`)} />
        ))}
      </fieldset>
      <p className="fw-sod-hint">{d(`priority.means.${dialog.level}`)}</p>
      {dialog.level === 'URGENT' && (
        <Field label={d('priority.reason')} hint={d('priority.reasonHint', { max: URGENT_REASON_MAX })}>
          <Textarea value={dialog.reason} onChange={(event) => set({ reason: event.target.value })} rows={2} maxLength={URGENT_REASON_MAX + 10} />
        </Field>
      )}
    </Frame>
  )
}

// ---- Set season -----------------------------------------------------------------------------------------------------------

function SeasonDialog({ order, model, actions }: { order: Order; model: OrderDepthModel; actions?: OrderDepthActions }) {
  const d = useT(NAMESPACE)
  const locale = useLocale()
  const dialog = model.dialog
  if (dialog?.kind !== 'season') return null
  const current = model.depth.value?.season?.id ?? ''
  const held = model.busy ? d('held.busy') : model.seasons === null ? d('held.reading') : dialog.seasonId === current ? d('held.seasonSame') : null
  const chosen = model.seasons?.find((season) => season.id === dialog.seasonId) ?? null
  return (
    <Frame title={d('season.title', { number: order.number })} held={held} go={() => actions?.onSeason?.()} goLabel={model.busy ? d('common.working') : d('season.go')} onClose={closeOf(actions)} problem={<Problem model={model} />} size="sm">
      {model.seasons === null ? (
        <p className="fw-sod-hint" role="status">
          <Spinner size={14} /> {d('season.reading')}
        </p>
      ) : (
        <>
          <Field label={d('season.label')} hint={model.seasons.length === 0 ? d('season.none') : d('season.hint')}>
            <Select value={dialog.seasonId} onChange={(event) => actions?.onDialog?.({ kind: 'season', seasonId: event.target.value })}>
              <option value="">{d('season.noSeason')}</option>
              {model.seasons.map((season) => (
                <option key={season.id} value={season.id}>
                  {`${season.code} · ${season.name}`}
                </option>
              ))}
            </Select>
          </Field>
          {chosen && (
            <KeyValue
              dense
              labelCase="sentence"
              items={[
                { label: d('season.runs'), value: d('season.runsValue', { from: formatDate(dayInstant(chosen.startsOn), { locale }), to: formatDate(dayInstant(chosen.endsOn), { locale }) }) },
                { label: d('season.book'), value: chosen.orderBookClosesOn ? formatDate(dayInstant(chosen.orderBookClosesOn), { locale }) : '—' },
                { label: d('season.state'), value: <Tag tone={chosen.state === 'OPEN' ? 'success' : 'warning'}>{d(`season.stateValue.${chosen.state}`)}</Tag> },
              ]}
            />
          )}
        </>
      )}
    </Frame>
  )
}

// ---- Ask for a yes / Take the request back --------------------------------------------------------------------------------

function YesDialog({ order, model, actions }: { order: Order; model: OrderDepthModel; actions?: OrderDepthActions }) {
  const d = useT(NAMESPACE)
  const dialog = model.dialog
  if (dialog?.kind === 'withdraw') {
    return (
      <Frame title={d('wait.withdrawTitle', { number: order.number })} held={model.busy ? d('held.busy') : null} go={() => actions?.onWithdraw?.()} goLabel={model.busy ? d('common.working') : d('wait.withdraw')} onClose={closeOf(actions)} problem={<Problem model={model} />} size="sm">
        <p className="fw-sod-hint">{d('wait.withdrawBody')}</p>
      </Frame>
    )
  }
  if (dialog?.kind !== 'ask') return null
  return (
    <Frame title={d('wait.askTitle', { number: order.number })} held={model.busy ? d('held.busy') : null} go={() => actions?.onAsk?.()} goLabel={model.busy ? d('common.working') : d('wait.ask')} onClose={closeOf(actions)} problem={<Problem model={model} />} size="sm">
      <p className="fw-sod-hint">{d('wait.askBody')}</p>
      <Field label={d('wait.note')} hint={d('wait.noteHint')}>
        <Textarea value={dialog.note} onChange={(event) => actions?.onDialog?.({ kind: 'ask', note: event.target.value })} rows={3} maxLength={4000} />
      </Field>
    </Frame>
  )
}

// ---- Put the order back -----------------------------------------------------------------------------------------------------

function PutBackDialog({ order, model, actions }: { order: Order; model: OrderDepthModel; actions?: OrderDepthActions }) {
  const d = useT(NAMESPACE)
  const dialog = model.dialog
  if (dialog?.kind !== 'putBack') return null
  const change = model.changes?.value?.changes.find((entry) => entry.id === dialog.changeId) ?? null
  return (
    <Frame title={d('putBack.title', { revision: change?.revision ?? '—', number: order.number })} held={model.busy ? d('held.busy') : !change ? d('held.reading') : null} go={() => actions?.onPutBack?.()} goLabel={model.busy ? d('common.working') : d('putBack.go')} onClose={closeOf(actions)} problem={<Problem model={model} />} size="md">
      <p className="fw-sod-hint">{d('putBack.body', { revision: change?.revision ?? '—' })}</p>
      {change?.deposit && change.deposit.status === 'OPEN' && <Banner tone="info" title={d('putBack.deposit')} />}
      <Field label={d('putBack.reason')} hint={d('putBack.reasonHint')}>
        <Textarea value={dialog.reason} onChange={(event) => actions?.onDialog?.({ ...dialog, reason: event.target.value })} rows={2} maxLength={500} />
      </Field>
    </Frame>
  )
}

// ---- Send the confirmation (SCR-037's one send dialog) --------------------------------------------------------------------------

function SendDialog({ order, model, actions, prefix }: { order: Order; model: OrderDepthModel; actions?: OrderDepthActions; prefix: string }) {
  const d = useT(NAMESPACE)
  const locale = useLocale()
  const dialog = model.dialog
  const send = model.send
  const confirmation = model.confirmation?.value ?? null
  if (dialog?.kind !== 'send') return null
  const newest = confirmation?.versions[0] ?? null
  const recipient = send?.recipient
  const waiting = order.status === 'PENDING_APPROVAL' || order.status === 'CANCELLED'
  const outdated = !newest || confirmation?.upToDate === false
  return (
    <DocumentSendView
      open
      model={{
        title: d('send.title', { number: order.number }),
        documentLabel: newest ? d('send.document', { number: order.number, version: newest.version }) : d('send.documentNew', { number: order.number }),
        recipient: recipient ? { name: recipient.name, email: recipient.email } : null,
        language: locale === 'en' ? 'en' : 'it',
        how: { kind: 'pdfOnly' },
        freezeNote: outdated ? d('send.freezeNew') : d('send.freeze', { version: newest?.version ?? 1 }),
        recipientCan: [d('send.can')],
        fields: { cc: dialog.cc, subject: dialog.subject, message: dialog.message },
        checks:
          recipient === undefined
            ? { status: 'loading' }
            : {
                status: 'ready',
                items: [
                  { id: 'confirmed', state: waiting ? 'blocks' : 'passes', label: waiting ? d(order.status === 'CANCELLED' ? 'held.confirmationCancelled' : 'held.confirmationWaiting') : d('send.check.confirmed') },
                  { id: 'recipient', state: recipient ? 'passes' : 'blocks', label: recipient ? d('send.check.recipient', { email: recipient.email }) : d('send.check.noRecipient') },
                  { id: 'version', state: outdated ? 'warning' : 'passes', label: outdated ? d('send.check.newVersion') : d('send.check.upToDate', { version: newest?.version ?? 1 }) },
                ],
              },
        preview: { src: send?.pdf ?? null, openHref: confirmationHref(prefix, order.id), problem: null, fileName: `${order.number}-confirmation.pdf` },
        sending: model.busy,
        problem: model.problem ? d(model.problem.key, model.problem.params) : null,
        result: send?.result ? { delivery: 'sent', to: send.result.to, at: send.result.at, linkUntil: null } : null,
        canSend: model.can.manage,
      }}
      actions={{
        onField: (field, value) => actions?.onDialog?.({ ...dialog, [field]: value }),
        onSend: () => actions?.onSend?.(),
        onClose: closeOf(actions),
      }}
    />
  )
}

// ---- The priced change (SAL-219) ---------------------------------------------------------------------------------------------

function PricedDialog({ order, model, actions }: { order: Order; model: OrderDepthModel; actions?: OrderDepthActions }) {
  const d = useT(NAMESPACE)
  const locale = useLocale()
  const priced = model.priced
  const today = useMemo(() => romeToday(), [])
  if (!priced) return null
  const { draft, preview } = priced
  const value = preview.value
  const local = pricedProblems(draft, today, { price: model.can.price })
  const finalProblems = pricedProblems(draft, today, { price: model.can.price, final: true })
  const apiProblems = value && !value.ok ? pricedProblemWords(value.problems, order, d) : []
  const held = model.busy
    ? d('held.busy')
    : Object.keys(local).length > 0
      ? d(Object.values(local)[0]!)
      : preview.phase === 'reading'
        ? d('priced.held.reading')
        : preview.phase === 'failed'
          ? d('priced.held.failed')
          : apiProblems.length > 0
            ? d('priced.held.problems')
            : finalProblems.reason
              ? d(finalProblems.reason)
              : null
  const lineName = (lineId: string, styleId: string) => {
    const line = order.lines.find((entry) => entry.id === lineId)
    return line ? `${line.style?.code ?? '—'} · ${line.colourway?.code ?? '—'}` : styleId.slice(0, 8)
  }
  const amountOf = (lineId: string) => value?.parts?.find((part) => part.orderLineId === lineId)?.amount
  const rows = (value?.diff?.lines ?? []).map((line) => ({
    id: line.lineId,
    cells: [
      <span key="l" className="fw-sod-cell">
        <span>{lineName(line.lineId, line.styleId)}</span>
        <span className="fw-sod-hint">{sizeMoves(line).map((move) => `${move.size} ${move.delta > 0 ? '+' : '−'}${Math.abs(move.delta)}`).join(' · ') || d(`priced.lineKind.${line.change}`)}</span>
      </span>,
      <Input
        key="w"
        size="sm"
        aria-label={d('priced.labelOf', { line: lineName(line.lineId, line.styleId) })}
        placeholder={d('priced.labelPlaceholder')}
        value={draft.labels[line.lineId] ?? ''}
        maxLength={220}
        onChange={(event) => actions?.onPricedDraft?.({ labels: { ...draft.labels, [line.lineId]: event.target.value } })}
      />,
      ...(model.can.price ? [amountOf(line.lineId) === undefined ? '—' : signed(amountOf(line.lineId)!, order.currency, locale)] : []),
    ],
  }))
  const kinds = depositKindChoices(model.depositKinds)
  const deposit = value?.deposit ?? null
  return (
    <Frame
      title={d('priced.title', { revision: value?.revision ?? '—', number: order.number })}
      held={held}
      go={() => actions?.onPricedApply?.()}
      goLabel={model.busy ? d('common.working') : d('priced.go')}
      onClose={closeOf(actions)}
      problem={<Problem model={model} />}
      size="xl"
    >
      <Banner tone="info" title={d('priced.how')}>
        {value?.stage ? d('priced.stage', { stage: d(`stage.${value.stage.stage}`) }) : null}
      </Banner>
      {preview.phase === 'reading' && !value && (
        <p className="fw-sod-hint" role="status">
          <Spinner size={14} /> {d('priced.reading')}
        </p>
      )}
      {preview.phase === 'failed' && <Banner tone="danger" title={d(preview.problem ?? 'priced.held.failed')} />}
      {apiProblems.length > 0 && (
        <Banner tone="danger" title={d('priced.problems', { count: apiProblems.length })}>
          <ul className="fw-sod-list">
            {apiProblems.map((words) => (
              <li key={words}>{words}</li>
            ))}
          </ul>
        </Banner>
      )}
      {rows.length > 0 && <SummaryTable label={d('priced.tableLabel')} columns={[d('priced.col.line'), d('priced.col.words'), ...(model.can.price ? [d('priced.col.price')] : [])]} rows={rows} density="roomy" stackOnPhone />}
      {local.labels && <p className="fw-sod-problem">{d(local.labels)}</p>}
      {model.can.price ? (
        <div className="fw-sod-two">
          <Field label={d('priced.fee')} hint={d('priced.feeHint', { currency: order.currency })} error={local.fee ? d(local.fee) : undefined}>
            <Input value={draft.fee} inputMode="decimal" onChange={(event) => actions?.onPricedDraft?.({ fee: event.target.value })} placeholder="0,00" />
          </Field>
          <KeyValue
            dense
            labelCase="sentence"
            items={[
              { label: d('priced.change'), value: value?.changeAmount === null || value?.changeAmount === undefined ? '—' : signed(value.changeAmount, order.currency, locale) },
              { label: d('priced.feeValue'), value: value?.feeAmount ? money(value.feeAmount, order.currency, locale) : '—' },
            ]}
          />
        </div>
      ) : (
        <p className="fw-sod-hint">{d('priced.noPrice')}</p>
      )}
      <fieldset className="fw-sod-fieldset">
        <legend className="fw-sod-legend">{d('priced.deposit')}</legend>
        <SegmentedControl
          size="sm"
          ariaLabel={d('priced.deposit')}
          value={draft.deposit}
          onChange={(next) => actions?.onPricedDraft?.({ deposit: next as DepositMode })}
          options={(['default', 'none', ...(model.can.price ? ['pct', 'amount'] : [])] as DepositMode[]).map((mode) => ({ value: mode, label: d(`priced.depositMode.${mode}`) }))}
          wrap
        />
        {draft.deposit === 'pct' && (
          <Field label={d('priced.pct')} error={local.pct ? d(local.pct) : undefined}>
            <Input value={draft.pct} inputMode="decimal" onChange={(event) => actions?.onPricedDraft?.({ pct: event.target.value })} placeholder="30" />
          </Field>
        )}
        {draft.deposit === 'amount' && (
          <Field label={d('priced.amount', { currency: order.currency })} error={local.amount ? d(local.amount) : undefined}>
            <Input value={draft.amount} inputMode="decimal" onChange={(event) => actions?.onPricedDraft?.({ amount: event.target.value })} placeholder="0,00" />
          </Field>
        )}
        {draft.deposit !== 'none' && (
          <div className="fw-sod-two">
            <Field label={d('priced.kind')} hint={d('priced.kindHint')}>
              <Select value={draft.kind} onChange={(event) => actions?.onPricedDraft?.({ kind: event.target.value as typeof draft.kind })}>
                {kinds.map((entry) => (
                  <option key={entry.kind} value={entry.kind} disabled={!entry.available}>
                    {entry.available ? d(`depositKind.${entry.kind}`) : d('depositKind.off', { kind: d(`depositKind.${entry.kind}`) })}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={d('priced.dueDate')} hint={d('priced.dueHint')} error={local.dueDate ? d(local.dueDate) : undefined}>
              <DateField value={draft.dueDate} onChange={(next) => actions?.onPricedDraft?.({ dueDate: next })} min={today} locale={INTL_LOCALE[locale]} ariaLabel={d('priced.dueDate')} />
            </Field>
          </div>
        )}
        {kinds.some((entry) => entry.kind === 'CAPARRA_PENITENZIALE' && !entry.available) && <p className="fw-sod-hint">{d('depositKind.offWhy')}</p>}
        {draft.deposit !== 'none' && value && (
          <p className="fw-sod-hint">{deposit && model.can.price && deposit.amount !== undefined ? d('priced.depositValue', { amount: money(deposit.amount, order.currency, locale), pct: Number(deposit.pct).toLocaleString(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 2 }) }) : d('priced.depositNone')}</p>
        )}
      </fieldset>
      {value?.yes === 'WOULD_ASK' && <Banner tone="warning" title={d('priced.yes.WOULD_ASK')} />}
      {value?.yes === 'NOBODY_TO_ASK' && <Banner tone="info" title={d('priced.yes.NOBODY_TO_ASK')} />}
      <p className="fw-sod-hint">{d('priced.customer')}</p>
      <Field label={d('priced.reason')} hint={d('priced.reasonHint')}>
        <Textarea value={draft.reason} onChange={(event) => actions?.onPricedDraft?.({ reason: event.target.value })} rows={2} maxLength={520} />
      </Field>
    </Frame>
  )
}

const signed = (minor: number, currency: string, locale: Locale) => `${minor >= 0 ? '+' : '−'}${money(Math.abs(minor), currency, locale)}`

/** The priced route's refusals in this catalogue's words, from their place (never the API's English). */
export function pricedProblemWords(problems: ReadonlyArray<{ path: string }>, order: Pick<Order, 'lines'>, d: Translate): string[] {
  const out = new Set<string>()
  const frozen = frozenProblemsOf(problems)
  for (const entry of frozen) {
    const line = entry.seq === null ? null : order.lines.find((row) => row.seq === entry.seq)
    out.add(line ? d('priced.problem.frozenLine', { line: `${line.style?.code ?? '—'} · ${line.colourway?.code ?? '—'}`, field: d(`field.${entry.field as FreezeField}`) }) : d('priced.problem.frozenOrder', { field: d(`field.${entry.field as FreezeField}`) }))
  }
  for (const problem of problems) {
    if (frozen.length > 0 && /^body\/(lines\/\d+\/)?[A-Z_]+$/.test(problem.path)) continue
    if (problem.path.includes('deposit')) out.add(d('priced.problem.deposit'))
    else if (problem.path.includes('fee')) out.add(d('priced.problem.fee'))
    else if (problem.path.includes('labels')) out.add(d('priced.problem.label'))
    else if (problem.path.includes('lines')) out.add(d('priced.problem.lines'))
    else out.add(d('priced.problem.other'))
  }
  return [...out]
}
