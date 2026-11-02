'use client'

import { useId, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowDown, ArrowLeftToLine, ArrowUp, Layers, UserRoundPlus } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Select, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { DISPATCH_LIMITS } from '@nexus/factory-domain/production/dispatch/rules'
import { Combobox, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { formatNumber } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Phrase } from '../../_shared/model'
import type { DispatchBoard, DispatchCard, OperatorPicker } from '../api'
import {
  assignHeld,
  boardHeld,
  bundleWords,
  checkPhrase,
  dayWords,
  DISPATCH_NAMESPACE,
  isRest,
  laneStep,
  moveBundlesHeld,
  moveTargets,
  operatorWords,
  pickerLabel,
  presencePhrase,
  REASON_MIN,
  stationLabel,
  stationOf,
  type DrawnBoard,
} from '../model'
import type { DispatchActions, DispatchDialog, DispatchViewModel } from '../view-model'

const say = (t: (key: string, params?: Phrase['params']) => string, phrase: Phrase | null): string | null => (phrase ? t(phrase.key, phrase.params) : null)

/**
 * The page's dialogs: a card's detail (facts, and where Move bundles and the lane's order open from: the DS card has no ⋯),
 * Assign operator (design pop:dp-assign: the people clocked in with their level for this operation, no output number; a hold
 * says why, a warning asks a reason), Move bundles (pop:dp-move: "Move 3 bundles", to a line or a station), the reason a
 * warned move asks for, the keys. Each held with its reason; the server's refusal in words inside the dialog.
 */
export function DispatchDialogs({ model, board, drawn, actions }: { model: DispatchViewModel; board: DispatchBoard; drawn: DrawnBoard; actions?: DispatchActions | undefined }) {
  const dialog = model.dialog
  return (
    <>
      {dialog?.kind === 'card' && drawn.byId.get(dialog.cardId) && <CardDialog card={drawn.byId.get(dialog.cardId)!} cardId={dialog.cardId} model={model} board={board} actions={actions} />}
      {dialog?.kind === 'assign' && <AssignDialog dialog={dialog} model={model} board={board} actions={actions} />}
      {dialog?.kind === 'move' && drawn.byId.get(dialog.cardId) && <MoveDialog dialog={dialog} card={drawn.byId.get(dialog.cardId)!} model={model} board={board} actions={actions} />}
      {dialog?.kind === 'keys' && <KeysDialog actions={actions} />}
      {model.reasonFor !== null && <ReasonDialog label={model.reasonFor} actions={actions} />}
    </>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fw-dp-fact">
      <dt className="fw-dp-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function stateWords(card: DispatchCard, t: (key: string, params?: Phrase['params']) => string): string {
  if (card.state === 'WAITING_FOR_PREVIOUS' && card.previous) return t('detail.state.WAITING_FOR_PREVIOUS', { seq: card.previous.seq, name: card.previous.name })
  return t(card.state === 'WAITING_FOR_PREVIOUS' ? 'detail.state.READY' : `detail.state.${card.state}`)
}

function CardDialog({ card, cardId, model, board, actions }: { card: DispatchCard; cardId: string; model: DispatchViewModel; board: DispatchBoard; actions?: DispatchActions | undefined }) {
  const t = useT(DISPATCH_NAMESPACE)
  const locale = useLocale()
  const words = { locale }
  const close = () => actions?.onDialog?.(null)
  const held = model.busy ? t('held.busy') : say(t, boardHeld(board, model.offline)) ?? (card.movable ? null : t('held.draft'))
  const station = stationOf(board, card.stationId)
  const place = station ? stationLabel(board, station) : t('kit.tray')
  const earlier = laneStep(board, card, -1)
  const later = laneStep(board, card, 1)
  const backHeld = held ?? (isRest(card) ? t('held.alreadyNotAssigned') : null)
  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={`${card.workOrder.number} · ${t('card.operation', { seq: card.operation.seq, name: card.operation.name })}`}
      subtitle={`${card.workOrder.style.code} · ${card.workOrder.style.name}`}
      footer={
        <>
          <Button onClick={close}>{t('common.close')}</Button>
          {model.can.workOrders && (
            <Button asChild>
              <Link href={`${model.prefix}/production/work-orders/${encodeURIComponent(card.workOrder.id)}`}>{t('detail.openWorkOrder')}</Link>
            </Button>
          )}
        </>
      }
    >
      <div className="fw-dp-form">
        <dl className="fw-dp-facts">
          <Fact label={t('detail.place')}>{place}</Fact>
          <Fact label={t('detail.stateLabel')}>{stateWords(card, t)}</Fact>
          <Fact label={t('detail.pieces')}>{formatNumber(card.pieces, locale)}</Fact>
          <Fact label={t('detail.minutes')}>{t('detail.minutesValue', { minutes: formatNumber(Number(card.minutes), locale), each: formatNumber(Number(card.standardMinutes), locale) })}</Fact>
          <Fact label={t('detail.due')}>{card.workOrder.dueDate ? dayWords(card.workOrder.dueDate, words) : '—'}</Fact>
          <Fact label={t('detail.materialLabel')}>{card.material ? t(`detail.material.${card.material.state}`, { date: card.material.date ? dayWords(card.material.date, words) : '—' }) : '—'}</Fact>
          <Fact label={t('detail.bundles')}>{card.bundles.length > 0 ? card.bundles.map((bundle) => bundle.code).join(', ') : (bundleWords(card, t) ?? '—')}</Fact>
          {card.workOrder.holdReason && <Fact label={t('detail.hold')}>{card.workOrder.holdReason}</Fact>}
          {board.rules.namesWorkers && (
            <Fact label={t('detail.operators')}>
              {card.operators.length === 0 ? (
                t('lane.noOperator')
              ) : (
                <span className="fw-dp-who">
                  {card.operators.map((operator) => {
                    const presence = presencePhrase(operator)
                    return (
                      <span key={operator.assignmentId} className="fw-dp-operator">
                        {operatorWords(operator, t)}
                        {presence && <Tag tone={presence.tone}>{say(t, presence.words)}</Tag>}
                        {operator.overridden && <Tag tone="neutral">{t('detail.keptWithReason')}</Tag>}
                      </span>
                    )
                  })}
                </span>
              )}
            </Fact>
          )}
        </dl>
        <div className="fw-dp-verbs">
          <Button size="sm" heldReason={held ?? (card.bundles.length === 0 ? t('held.noBundles') : null)} onClick={() => actions?.onDialog?.({ kind: 'move', cardId, picked: card.bundles.map((bundle) => bundle.id), target: null, problem: null })}>
            <Layers size={14} aria-hidden /> {t('detail.moveBundles')}
          </Button>
          {board.rules.namesWorkers && (
            <Button size="sm" heldReason={held} onClick={() => actions?.onAssignStart?.({ kind: 'card', stationId: card.stationId, operationId: card.operation.id, place: `${card.workOrder.number} · ${place}` })}>
              <UserRoundPlus size={14} aria-hidden /> {t('detail.assign')}
            </Button>
          )}
          <Button size="sm" heldReason={held ?? say(t, earlier.held)} onClick={() => actions?.onStep?.(card, -1)}>
            <ArrowUp size={14} aria-hidden /> {t('detail.earlier')}
          </Button>
          <Button size="sm" heldReason={held ?? say(t, later.held)} onClick={() => actions?.onStep?.(card, 1)}>
            <ArrowDown size={14} aria-hidden /> {t('detail.later')}
          </Button>
          <Button size="sm" heldReason={backHeld} onClick={() => actions?.onBack?.(card)}>
            <ArrowLeftToLine size={14} aria-hidden /> {t('detail.back')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function pickerSentence(picker: OperatorPicker, forOperation: boolean, t: (key: string, params?: Phrase['params']) => string): string {
  const who = picker.clockedOnly ? 'clockedOnly' : 'everyone'
  return t(`assign.${who}${forOperation ? 'Level' : ''}`)
}

function AssignDialog({ dialog, model, board, actions }: { dialog: Extract<DispatchDialog, { kind: 'assign' }>; model: DispatchViewModel; board: DispatchBoard; actions?: DispatchActions | undefined }) {
  const t = useT(DISPATCH_NAMESPACE)
  const labelId = useId()
  const close = () => actions?.onDialog?.(null)
  const update = (next: Partial<typeof dialog>) => actions?.onDialog?.({ ...dialog, ...next })
  const picker = dialog.picker.status === 'ready' ? dialog.picker.value : null
  const person = picker?.operators.find((entry) => entry.workerId === dialog.workerId) ?? null
  const check = person ? checkPhrase(person) : null
  const asksReason = dialog.askReason || person?.decision === 'WARN'
  const heldWords = model.busy ? t('held.busy') : !picker ? t('held.loading') : say(t, boardHeld(board, model.offline)) ?? say(t, assignHeld(person, dialog.reason, dialog.askReason))
  const isReassign = dialog.target.kind === 'reassign'
  const forOperation = dialog.target.operationId !== null
  return (
    <Modal
      open
      onClose={close}
      size="sm"
      title={isReassign ? t('assign.titleReassign') : t('assign.title')}
      subtitle={dialog.target.kind === 'reassign' ? t('assign.from', { person: dialog.target.from, place: dialog.target.place }) : dialog.target.place}
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={heldWords} onClick={() => actions?.onAssign?.()}>
            {model.busy ? <Spinner size={13} /> : <UserRoundPlus size={14} aria-hidden />} {isReassign ? t('assign.doReassign') : t('assign.do')}
          </Button>
        </>
      }
    >
      <div className="fw-dp-form">
        {dialog.picker.status === 'loading' && <Skeleton height={64} />}
        {dialog.picker.status === 'error' && <Banner tone="danger" title={t(dialog.picker.problem)} />}
        {picker && (
          <>
            <p className="fw-dp-muted">{pickerSentence(picker, forOperation, t)}</p>
            {picker.operators.length === 0 ? (
              <p className="fw-dp-text">{picker.clockedOnly ? t('assign.nobodyIn') : t('assign.nobody')}</p>
            ) : (
              <Field label={<span id={labelId}>{t('assign.person')}</span>} hint={picker.complete ? undefined : t('assign.first', { count: picker.operators.length })}>
                <Combobox labelledBy={labelId} value={dialog.workerId ?? ''} options={picker.operators.map((entry) => ({ value: entry.workerId, label: pickerLabel(entry, t, forOperation) }))} onChange={(workerId) => update({ workerId, askReason: false, problem: null })} />
              </Field>
            )}
            {check && <Banner tone={person?.decision === 'WARN' ? 'warning' : 'danger'} title={say(t, check)} />}
            {asksReason && person?.decision !== 'HOLD' && (
              <Field label={t('reason.label')} hint={t('reason.hint', { count: REASON_MIN })}>
                <Textarea value={dialog.reason} maxLength={DISPATCH_LIMITS.overrideReason} rows={3} onChange={(event) => update({ reason: event.target.value })} />
              </Field>
            )}
          </>
        )}
        {dialog.problem && <Banner tone={dialog.askReason ? 'warning' : 'danger'} title={say(t, dialog.problem)} />}
      </div>
    </Modal>
  )
}

function MoveDialog({ dialog, card, model, board, actions }: { dialog: Extract<DispatchDialog, { kind: 'move' }>; card: DispatchCard; model: DispatchViewModel; board: DispatchBoard; actions?: DispatchActions | undefined }) {
  const t = useT(DISPATCH_NAMESPACE)
  const locale = useLocale()
  const close = () => actions?.onDialog?.(null)
  const update = (next: Partial<typeof dialog>) => actions?.onDialog?.({ ...dialog, ...next })
  const targets = moveTargets(board, card)
  const count = dialog.picked.length
  const held = model.busy ? t('held.busy') : say(t, boardHeld(board, model.offline)) ?? say(t, moveBundlesHeld(card, dialog.picked, dialog.target))
  const toggle = (id: string) => update({ picked: dialog.picked.includes(id) ? dialog.picked.filter((value) => value !== id) : [...dialog.picked, id], problem: null })
  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={t('move.title')}
      subtitle={`${card.workOrder.number} · ${t('card.operation', { seq: card.operation.seq, name: card.operation.name })}`}
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onMoveBundles?.()}>
            {model.busy ? <Spinner size={13} /> : <Layers size={14} aria-hidden />} {t('move.do', { count })}
          </Button>
        </>
      }
    >
      <div className="fw-dp-form">
        <fieldset className="fw-dp-bundles">
          <legend className="fw-dp-legend">{t('move.bundles')}</legend>
          <span className="fw-dp-inline">
            <Button size="xs" variant="quiet" onClick={() => update({ picked: card.bundles.map((bundle) => bundle.id), problem: null })}>
              {t('move.all')}
            </Button>
            <Button size="xs" variant="quiet" onClick={() => update({ picked: [], problem: null })}>
              {t('move.none')}
            </Button>
          </span>
          <div className="fw-dp-bundle-grid">
            {card.bundles.map((bundle) => (
              <Checkbox key={bundle.id} checked={dialog.picked.includes(bundle.id)} onChange={() => toggle(bundle.id)} label={t('move.bundle', { code: bundle.code, count: formatNumber(bundle.garments, locale) })} />
            ))}
          </div>
        </fieldset>
        <Field label={t('move.to')}>
          <Select value={dialog.target ?? ''} onChange={(event) => update({ target: event.target.value || null, problem: null })}>
            <option value="">{t('move.pick')}</option>
            {targets.map((target) => (
              <option key={target.value} value={target.value}>
                {say(t, target.label)}
              </option>
            ))}
          </Select>
        </Field>
        {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem)} />}
      </div>
    </Modal>
  )
}

function ReasonDialog({ label, actions }: { label: string; actions?: DispatchActions | undefined }) {
  const t = useT(DISPATCH_NAMESPACE)
  const [reason, setReason] = useState('')
  const short = reason.trim().length < REASON_MIN
  return (
    <Modal
      open
      onClose={() => actions?.onReason?.(null)}
      size="sm"
      title={t('reason.title')}
      subtitle={label || undefined}
      footer={
        <>
          <Button onClick={() => actions?.onReason?.(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={short ? t('held.reason') : null} onClick={() => actions?.onReason?.(reason.trim())}>
            {t('reason.do')}
          </Button>
        </>
      }
    >
      <div className="fw-dp-form">
        <p className="fw-dp-text">{t('reason.body')}</p>
        <Field label={t('reason.label')} hint={t('reason.hint', { count: REASON_MIN })}>
          <Textarea value={reason} maxLength={DISPATCH_LIMITS.overrideReason} rows={3} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

const KEYS = ['pick', 'arrows', 'drop', 'cancel', 'open', 'undo', 'redo'] as const

function KeysDialog({ actions }: { actions?: DispatchActions | undefined }) {
  const t = useT(DISPATCH_NAMESPACE)
  const close = () => actions?.onDialog?.(null)
  return (
    <Modal open onClose={close} size="sm" title={t('keys.title')} footer={<Button onClick={close}>{t('common.close')}</Button>}>
      <dl className="fw-dp-facts">
        {KEYS.map((key) => (
          <Fact key={key} label={t(`keys.${key}.key`)}>
            {t(`keys.${key}.does`)}
          </Fact>
        ))}
      </dl>
    </Modal>
  )
}
