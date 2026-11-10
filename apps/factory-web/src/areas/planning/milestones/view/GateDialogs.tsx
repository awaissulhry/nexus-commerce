'use client'

import { CheckCheck, Save } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { GATE_KINDS, GATE_LIMITS, isSampleGate, type GateKind } from '@nexus/factory-domain/planning/milestones/rules'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useT } from '../../../../lib/i18n/provider'
import { ActionConfirm, DateField, Modal } from '../../../../lib/i18n/ds-parts'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import type { Gate, Order } from '../api'
import { dayText, draftHeld, gateName, heldOf, kindsLeft, reasonHeld, type GateDraft, type Words } from '../model'
import type { MilestonesActions, MilestonesModel } from '../view-model'
import { StartBeforeDialog } from './StartBeforeDialog'

/**
 * The page's dialogs: Add a gate / Change the gate (the order, the kind — one per kind and order, Other as many as needed —,
 * what it is in words, the target date, the sample round it waits for (a pre-production sample: a pre-production round), its
 * planner), Mark done on a day (today or a day before; one gate or the ticked ones), Start before the gate? (the shared
 * dialog), Remove the gate (a confirm: only while neither passed nor started before), and the keyboard keys.
 */
export function GateDialogs({ model, actions, words }: { model: MilestonesModel; actions?: MilestonesActions; words: Words }) {
  const { t, locale } = words
  const lists = useT('lists')
  const dialog = model.dialog
  if (!dialog) return null
  const world = model.world.status === 'ready' ? model.world.value : null
  const gates: Gate[] = world ? world.orders.flatMap((order) => order.gates) : []
  const orderOf = (id: string | null): Order | null => (world && id ? (world.orders.find((order) => order.id === id) ?? null) : null)
  const close = () => actions?.onCloseDialog?.()

  if (dialog.kind === 'add' || dialog.kind === 'edit') {
    const gate = dialog.kind === 'edit' ? (gates.find((entry) => entry.id === dialog.gateId) ?? null) : null
    const order = dialog.kind === 'add' ? orderOf(dialog.orderId) : orderOf(gate?.salesOrderId ?? null)
    const draft = dialog.draft
    const set = (next: Partial<GateDraft>) => actions?.onDraft?.({ ...draft, ...next })
    const choices = dialog.choices?.status === 'ready' ? dialog.choices.value : null
    const kinds: readonly GateKind[] = dialog.kind === 'edit' ? [draft.kind] : order ? kindsLeft(order) : GATE_KINDS
    const rounds = (choices?.rounds ?? []).filter((round) => draft.kind !== 'PP_SAMPLE' || round.kind === 'PRE_PRODUCTION')
    const openOrders = (world?.orders ?? []).filter((entry) => entry.mayAddGate.allowed)
    const held = dialog.busy ? t('held.busy') : !order ? t('held.pickOrder') : draftHeld(draft, t)
    return (
      <Modal
        open
        onClose={close}
        title={dialog.kind === 'add' ? t('form.addTitle') : t('form.editTitle', { name: gateName(draft.kind, gate?.label ?? null, t) })}
        subtitle={order ? t('form.subtitle', { order: order.number, customer: order.customer.name }) : t('form.pickSubtitle')}
        size="md"
        footer={
          <span className="fw-tna-footer">
            <span />
            <span className="fw-tna-inline">
              <Button size="sm" onClick={close}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onSaveGate?.()}>
                {dialog.busy ? <Spinner size={12} /> : <Save size={13} aria-hidden />} {dialog.kind === 'add' ? t('form.add') : t('form.save')}
              </Button>
            </span>
          </span>
        }
      >
        <div className="fw-tna-form">
          {dialog.kind === 'add' && (
            <Field label={t('form.order')} required hint={openOrders.length === 0 ? t('form.noOrders') : undefined}>
              <Select size="sm" value={dialog.orderId ?? ''} onChange={(event) => actions?.onPickOrder?.(event.target.value)}>
                <option value="" disabled>
                  {t('form.pickOrder')}
                </option>
                {openOrders.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.number} · {entry.customer.name}
                    {entry.promiseDate ? ` · ${t('form.ships', { day: dayText(entry.promiseDate, locale) })}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('form.kind')} required hint={t(`kindHint.${draft.kind}`)}>
            <Select size="sm" value={draft.kind} disabled={dialog.kind === 'edit'} onChange={(event) => set({ kind: event.target.value as GateKind, sampleRoundId: '' })}>
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kind.${kind}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={draft.kind === 'OTHER' ? t('form.label') : t('form.labelOptional')} required={draft.kind === 'OTHER'} hint={t('form.labelHint', { max: GATE_LIMITS.label })}>
            <Input size="sm" maxLength={GATE_LIMITS.label} value={draft.label} onChange={(event) => set({ label: event.target.value })} />
          </Field>
          <Field label={t('form.target')} hint={t('form.targetHint')}>
            <DateField value={draft.targetDate} onChange={(value) => set({ targetDate: value })} ariaLabel={t('form.target')} locale={INTL_LOCALE[locale]} />
          </Field>
          {isSampleGate(draft.kind) && (
            <Field label={t('form.round')} hint={draft.kind === 'PP_SAMPLE' ? t('form.roundHintPp') : t('form.roundHint')}>
              {dialog.choices?.status === 'loading' ? (
                <Skeleton height={32} />
              ) : (
                <Select size="sm" value={draft.sampleRoundId} onChange={(event) => set({ sampleRoundId: event.target.value })}>
                  <option value="">{t('form.noRound')}</option>
                  {rounds.map((round) => (
                    <option key={round.id} value={round.id}>
                      {round.number} · {round.style.code} · {t(`roundKind.${round.kind}`, { no: round.roundNo })} · {round.decision ? t(`decision.${round.decision}`) : t('decision.none')}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field label={t('form.owner')} hint={t('form.ownerHint')}>
            {dialog.choices?.status === 'loading' ? (
              <Skeleton height={32} />
            ) : (
              <Select size="sm" value={draft.ownerId} onChange={(event) => set({ ownerId: event.target.value })}>
                <option value="">{t('form.ownerMe')}</option>
                {(choices?.owners ?? [])
                  .filter((person) => !person.me)
                  .map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          {dialog.choices?.status === 'error' && <Banner tone="warning" title={t('form.choicesFailed')} />}
          {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
        </div>
      </Modal>
    )
  }

  if (dialog.kind === 'pass') {
    const chosen = gates.filter((gate) => dialog.gateIds.includes(gate.id))
    const held = dialog.busy ? t('held.busy') : chosen.length === 0 ? t('held.noGate') : (chosen.map((gate) => heldOf(gate.actions.pass, t)).find((reason) => reason !== null) ?? (world && dialog.on > world.today ? t('refusal.FUTURE_DAY') : null))
    return (
      <Modal
        open
        onClose={close}
        title={t('pass.title', { count: chosen.length })}
        size="sm"
        footer={
          <span className="fw-tna-footer">
            <span />
            <span className="fw-tna-inline">
              <Button size="sm" onClick={close}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onPassConfirm?.()}>
                {dialog.busy ? <Spinner size={12} /> : <CheckCheck size={13} aria-hidden />} {t('pass.confirm', { count: chosen.length })}
              </Button>
            </span>
          </span>
        }
      >
        <div className="fw-tna-form">
          <ul className="fw-tna-gate-list">
            {chosen.map((gate) => (
              <li key={gate.id}>{t('pass.gate', { name: gateName(gate.kind, gate.label, t), order: orderOf(gate.salesOrderId)?.number ?? '' })}</li>
            ))}
          </ul>
          <Field label={t('pass.on')} hint={t('pass.onHint')}>
            <DateField value={dialog.on} onChange={(value) => actions?.onPassDay?.(value)} ariaLabel={t('pass.on')} locale={INTL_LOCALE[locale]} />
          </Field>
          <p className="fw-tna-hint">{t('pass.opens')}</p>
          {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
        </div>
      </Modal>
    )
  }

  if (dialog.kind === 'startBefore') {
    const chosen = gates.filter((gate) => dialog.gateIds.includes(gate.id))
    const rows = chosen.map((gate) => ({ id: gate.id, name: gateName(gate.kind, gate.label, t), order: orderOf(gate.salesOrderId)?.number ?? '', target: dayText(gate.targetDate, locale), owner: gate.owner?.name ?? null, held: heldOf(gate.actions.startBefore, t) }))
    const held = rows.find((row) => row.held)?.held ?? reasonHeld(dialog.reason, t)
    return <StartBeforeDialog gates={rows} reason={dialog.reason} busy={dialog.busy} problem={dialog.problem} held={held} onReason={(reason) => actions?.onReason?.(reason)} onConfirm={() => actions?.onStartConfirm?.()} onCancel={close} t={t} />
  }

  if (dialog.kind === 'remove') {
    const gate = gates.find((entry) => entry.id === dialog.gateId)
    if (!gate) return null
    const order = orderOf(gate.salesOrderId)
    return (
      <ActionConfirm
        impact={{
          level: 'confirm',
          reach: 'local',
          title: t('remove.title', { name: gateName(gate.kind, gate.label, t), order: order?.number ?? '' }),
          confirmLabel: t('remove.confirm'),
          consequences: [t('remove.what'), gate.holds > 0 ? t('remove.frees', { count: gate.holds }) : t('remove.nothingHeld')],
          reversal: { verb: t('remove.back'), fidelity: 'lossy' },
          ...(dialog.problem ? { refusal: { reason: t(dialog.problem) } } : {}),
        }}
        onConfirm={() => actions?.onRemoveConfirm?.()}
        onCancel={close}
      />
    )
  }

  const keys: ListKey[] = [
    { keys: ['1', '2', '3'], does: t('keys.views') },
    { keys: ['←', '→'], does: t('keys.months') },
    { keys: ['t'], does: t('keys.today') },
    { keys: ['Enter'], does: t('keys.open') },
    { keys: ['d'], does: t('keys.done') },
    { keys: ['n'], does: t('keys.add') },
  ]
  return (
    <Modal open onClose={close} title={t('page.keys')} size="sm">
      <ul className="fw-tna-gate-list">
        {listKeys(keys, true).map((entry) => (
          <li key={entry.does}>
            <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
          </li>
        ))}
      </ul>
    </Modal>
  )
}
