'use client'

import { useEffect, useState } from 'react'
import { Info, Lock } from 'lucide-react'
import { Banner, Card, DetailPopover, EmptyState, Field, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, Pill, RadioCard, Spinner, Textarea } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Phrase } from '../../../_shared/model'
import { DECIDED_METHODS, type DecidedMethod, type MethodState } from '../api'
import { chooseHeld, confirmProblems, fromKey, lockWords, methodState, type CostingAbilities } from '../model'

export interface CostingCardModel {
  can: CostingAbilities
  /** The method in force for the company shown; null value while it loads. */
  method: { value: MethodState | null; problem: string | null; forbidden?: boolean }
  /** The person is choosing (the confirmation shows). */
  choosing: DecidedMethod | null
  busy: boolean
  problem: Phrase | null
  /** Design cases: the confirmation ticked, a reason typed, the lock pop-up open. */
  draft?: { accountant?: boolean; reason?: string; lockOpen?: boolean }
}

export interface CostingCardActions {
  onRetry?: () => void
  onPick?: (method: DecidedMethod | null) => void
  onChoose?: (input: { method: DecidedMethod; reason: string }) => void
}

/**
 * Finance settings › Costing (design finance.settings sec:costing): the costing method of the company shown — standard,
 * moving average or FIFO (c.c. art. 2426) — the accountant's choice. While nothing is chosen every cost is provisional.
 * Choosing asks the person to confirm the accountant chose it (GATE-ACCOUNTANT), an optional reason, and a fresh code.
 * Once the first cost entry is posted under it the method is locked: the choice is held with that reason, and "Why is it
 * locked?" (pop:method-lock) says since when entries exist and that changing it would revalue them. The cost-per-minute
 * calculator comes in a later version (W2b): shown held.
 */
export function CostingCard({ model, actions }: { model: CostingCardModel; actions?: CostingCardActions }) {
  const t = useT('finance')
  const d = useT('finance-daily')
  const words = useT('finance-costing')
  const locale = useLocale()
  const [accountant, setAccountant] = useState(model.draft?.accountant ?? false)
  const [reason, setReason] = useState(model.draft?.reason ?? '')
  // A design case opens "Why is it locked?" after the first paint (open on the server breaks hydration: a portal).
  const [lockOpen, setLockOpen] = useState(false)
  const wantsLockOpen = !!model.draft?.lockOpen
  useEffect(() => {
    if (wantsLockOpen) setLockOpen(true)
  }, [wantsLockOpen])
  const part = model.method
  const state = part.value
  if (!model.can.view || part.forbidden)
    return (
      <Card padded className="fw-fin-card">
        <h2 className="fw-fin-h2">{d('costing.title')}</h2>
        <p className="fw-fin-hint">{d('costing.noRight')}</p>
      </Card>
    )
  if (!state)
    return (
      <Card padded className="fw-fin-card" aria-busy={part.problem ? undefined : 'true'}>
        <h2 className="fw-fin-h2">{d('costing.title')}</h2>
        {part.problem ? (
          <EmptyState title={d('costing.failed')} description={t(part.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
        ) : (
          <p className="fw-fin-hint" role="status">
            <Spinner size={12} /> {d('costing.loading')}
          </p>
        )}
      </Card>
    )
  const status = methodState(state)
  const lock = lockWords(state)
  const picked = model.choosing
  const held = chooseHeld(state, model.can, picked)
  const problems = confirmProblems({ accountant, reason })
  const confirmHeld = model.busy ? t('held.busy') : held ? d(held.key, held.params) : (problems.accountant ?? problems.reason) ? d((problems.accountant ?? problems.reason)!) : null
  const name = (method: string) => (method === 'UNDECIDED' ? d('costing.undecided') : words(`method.name.${method}`))
  // A name standing alone (a title, a value) starts with a capital; inside a sentence it stays as written.
  const title = (method: string) => {
    const text = name(method)
    return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1)
  }
  const radiosHeld = !model.can.choose ? d('costing.held.noRight') : state.locked ? d('costing.held.locked') : null
  return (
    <Card padded className="fw-fin-card">
      <div className="fw-fin-card-head">
        <h2 className="fw-fin-h2">{d('costing.title')}</h2>
        <Pill tone={status.tone}>
          {state.locked && <Lock size={12} aria-hidden />} {d(status.key, { method: name(state.method) })}
        </Pill>
      </div>
      <p className="fw-fin-hint">{d('costing.explain')}</p>
      <KeyValue
        dense
        labelCase="sentence"
        columns={2}
        items={[
          { label: d('costing.method'), value: title(state.method), hint: d(fromKey(state)) },
          { label: d('costing.entries'), value: state.entries > 0 ? d('costing.entriesValue', { count: state.entries }) : d('costing.noEntries'), hint: state.firstEntryAt ? d('costing.since', { date: formatDate(state.firstEntryAt, { locale }) }) : undefined },
        ]}
      />
      {state.method === 'UNDECIDED' && <Banner tone="warning" title={d('costing.provisional')}>{d('costing.provisionalBody')}</Banner>}
      {lock && (
        <span className="fw-fin-inline">
          <DetailPopover
            trigger={
              <span className="fw-fin-inline">
                <Info size={13} aria-hidden /> {d('costing.whyLocked')}
              </span>
            }
            triggerLabel={d('costing.whyLocked')}
            label={d('costing.lockTitle')}
            open={wantsLockOpen ? lockOpen : undefined}
            onOpenChange={wantsLockOpen ? setLockOpen : undefined}
          >
            <div className="fw-fin-stack-tight">
              <b>{d('costing.lockTitle')}</b>
              <span>{lock.since ? d('costing.lockSince', { date: formatDate(lock.since, { locale }), count: lock.entries }) : d('costing.lockNoDate', { count: lock.entries })}</span>
              {lock.lockedAt && <span>{d('costing.lockedOn', { date: formatDateTime(lock.lockedAt, { locale }) })}</span>}
              <span>{d('costing.lockWhy')}</span>
              <span className="fw-fin-hint">{d('costing.lockLaw')}</span>
            </div>
          </DetailPopover>
        </span>
      )}
      <fieldset className="fw-fin-choices">
        <legend className="fw-fin-legend">{d('costing.choose')}</legend>
        {DECIDED_METHODS.map((method) => (
          <RadioCard
            key={method}
            name="fw-fin-costing-method"
            value={method}
            checked={(picked ?? (state.method === 'UNDECIDED' ? null : state.method)) === method}
            selected={(picked ?? (state.method === 'UNDECIDED' ? null : state.method)) === method}
            disabled={!!radiosHeld}
            onChange={() => actions?.onPick?.(method)}
            title={title(method)}
            description={radiosHeld && state.method !== method ? radiosHeld : d(`costing.about.${method}`)}
          />
        ))}
      </fieldset>
      {picked && !state.locked && (
        <div className="fw-fin-stack-tight">
          <Checkbox checked={accountant} onChange={(event) => setAccountant(event.target.checked)} label={d('costing.accountant', { method: name(picked) })} />
          <Field label={d('costing.reason')} hint={d('costing.reasonHint')} error={problems.reason ? d(problems.reason) : undefined}>
            <Textarea value={reason} rows={2} maxLength={500} onChange={(event) => setReason(event.target.value)} />
          </Field>
          <p className="fw-fin-hint">{d('costing.afterChoose')}</p>
          {model.problem && <Banner tone="danger" title={d(model.problem.key, model.problem.params)} />}
          <span className="fw-fin-actions">
            <Button size="sm" variant="primary" heldReason={confirmHeld} onClick={() => actions?.onChoose?.({ method: picked, reason: reason.trim() })}>
              {model.busy ? t('common.working') : d('costing.save', { method: name(picked) })}
            </Button>
            <Button size="sm" onClick={() => actions?.onPick?.(null)}>
              {t('common.cancel')}
            </Button>
          </span>
        </div>
      )}
      <span className="fw-fin-inline">
        <Button size="sm" variant="quiet" heldReason={d('costing.calculatorLater')}>
          {d('costing.calculator')}
        </Button>
      </span>
    </Card>
  )
}
