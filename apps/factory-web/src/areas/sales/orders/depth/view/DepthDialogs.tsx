'use client'

import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Radio, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { DocumentSendView } from '../../../../_shared/document-send/view/DocumentSendView'
import type { Order } from '../../api'
import { dayInstant } from '../../model'
import { Frame } from '../../record/view/Dialogs'
import { PRIORITY_LEVELS, type PriorityLevel } from '../api'
import { confirmationHref, NAMESPACE, urgentReasonProblem, URGENT_REASON_MAX } from '../model'
import type { OrderDepthActions, OrderDepthModel } from '../use-order-depth'
import { ASK_DAYS } from '../../record/revised-order-ask' // F-OC-203: the ask's own answer-by

/**
 * The depth's dialogs on the order studio (B-W2b-323): Set priority (URGENT asks its reason), Set season (the company's open
 * seasons), Ask for a yes, Take the request back, Restore as before (put back), Send the confirmation (the ONE send dialog,
 * SCR-037) and Ask {customer} to re-confirm a revision (F-OC-203). F-OC-304: the priced change's own window went — nothing opened it
 * any more (the Lines tab's Review and save prices a frozen change). Each says a refusal inside itself; what was typed stays.
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
  if (dialog.kind === 'askRevision') return <AskRevisionDialog order={order} model={model} actions={actions} /> // F-OC-203 (L5)
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

// ---- F-OC-203 (10-design §7 D5; 18-lead-settles L5): Ask {customer} to re-confirm revision N? -------------------------------------
/**
 * The customer re-confirms a revision whose ask was never sent (or expired): a task in its portal and, with an e-mail address on
 * file (the confirmation's own recipient), an e-mail; they answer with their typed name. Until they answer, the row waits under
 * Waiting on {customer}. After the ask: where it went, and Done.
 */
function AskRevisionDialog({ order, model, actions }: { order: Order; model: OrderDepthModel; actions?: OrderDepthActions }) {
  const t = useT('orders')
  const d = useT(NAMESPACE)
  const locale = useLocale()
  const dialog = model.dialog
  if (dialog?.kind !== 'askRevision') return null
  const customer = order.party?.legalName ?? ''
  const ask = model.askRevision ?? null
  const recipient = ask?.recipient
  const reach = ask?.reach ?? null
  const due = formatDate(new Date(Date.now() + ASK_DAYS * 86_400_000), { locale })
  return (
    <Frame
      title={t('changesTab.ask.title', { customer, revision: dialog.revision })}
      held={model.busy ? d('held.busy') : recipient === undefined ? t('changesTab.ask.reading') : null}
      go={() => actions?.onAskRevision?.()}
      goLabel={model.busy ? d('common.working') : t('changesTab.ask.go', { customer })}
      onClose={closeOf(actions)}
      problem={<Problem model={model} />}
      size="md"
      done={reach ? <Banner tone="success" title={reach.reach === 'email' ? t('changesTab.ask.doneEmail', { customer, email: reach.email }) : t('changesTab.ask.donePortal', { customer })} /> : undefined}
    >
      <p className="fw-sod-hint">{t('changesTab.ask.body', { customer, number: order.number })}</p>
      <KeyValue
        dense
        labelCase="sentence"
        items={[
          { label: t('changesTab.ask.dueLabel'), value: due },
          { label: t('changesTab.ask.toLabel'), value: recipient === undefined ? t('changesTab.ask.reading') : recipient ? `${recipient.name} · ${recipient.email}` : t('changesTab.ask.portalOnly', { customer }) },
        ]}
      />
      <p className="fw-sod-hint">{t('changesTab.ask.until', { customer })}</p>
    </Frame>
  )
}
// ---- end F-OC-203

// ---- Send the confirmation (SCR-037's one send dialog) --------------------------------------------------------------------------

function SendDialog({ order, model, actions, prefix }: { order: Order; model: OrderDepthModel; actions?: OrderDepthActions; prefix: string }) {
  const d = useT(NAMESPACE)
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
        language: order.language === 'en' ? 'en' : 'it', // F-OC-203 (L9): the order's language, the one the PDF is made in
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
        outside: send?.outside ?? null, // TH-0 follow-up (B-TH-004): "Send outside this customer"
      }}
      actions={{
        onField: (field, value) => actions?.onDialog?.({ ...dialog, [field]: value }),
        onSend: () => actions?.onSend?.(),
        onSendOutside: (checked) => actions?.onSendOutside?.(checked), // TH-0 follow-up (B-TH-004)
        onClose: closeOf(actions),
      }}
    />
  )
}
