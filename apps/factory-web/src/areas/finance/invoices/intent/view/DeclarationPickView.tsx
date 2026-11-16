'use client'

import { Button, Select, Spinner } from '@nexus/ui/primitives'
import { useScopedT, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Phrase } from '../../../_shared/model'
import { CheckList } from '../../../_shared/parts'
import type { InvoiceIntent } from '../api'
import { INTENT_NAMESPACES, NAMESPACE, type IntentProblem } from '../model'

export interface DeclarationPickModel {
  /** The draft's declaration and the customer's live ones (null while read). */
  intent: InvoiceIntent | null
  /** The read failed (a finance message key). */
  readProblem: string | null
  /** The named declaration in words (its protocol, state, what this invoice uses of it). */
  named: Phrase | null
  /** The declaration chosen in the picker ('' = none chosen). */
  picked: string | null
  nameHeld: Phrase | null
  letGoHeld: Phrase | null
  busy: boolean
  problem: IntentProblem | null
}

export interface DeclarationPickActions {
  onPick?: (declarationId: string | null) => void
  onName?: () => void
  onLetGo?: () => void
  onRetry?: () => void
}

/**
 * "Declaration of intent" in a draft's Before you issue (B-W2b-GB02, G152; FIN-100): the declaration the draft rests on —
 * its protocol, state and what this invoice uses of it — with "Let it go" (its lines take the buyer's VAT again), or the
 * customer's live declarations to name one ("Name it": the taxable lines become N3.5). Shown only for an invoice, a deposit
 * invoice, a deferred invoice or a debit note of a customer that sent one. Naming waits for the company's declarations switch
 * (the accountant's); letting one go never does. The issue's own checks (INTENT_*) say what is still missing.
 */
export function DeclarationPickView({ model, actions }: { model: DeclarationPickModel; actions?: DeclarationPickActions }) {
  return (
    <WithMessages namespaces={INTENT_NAMESPACES}>
      <Pick model={model} actions={actions} />
    </WithMessages>
  )
}

function Pick({ model, actions }: { model: DeclarationPickModel; actions?: DeclarationPickActions }) {
  const t = useT('finance')
  const w = useT(NAMESPACE)
  const s = useScopedT('finance')
  if (model.readProblem)
    return (
      <p className="fw-fin-hint">
        {w('pick.failed', { why: t(model.readProblem) })}{' '}
        <Button size="sm" variant="link" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      </p>
    )
  if (!model.intent)
    return (
      <p className="fw-fin-hint" role="status">
        <Spinner size={12} /> {w('pick.reading')}
      </p>
    )
  const intent = model.intent
  const named = intent.declarationOfIntent
  const others = intent.declarationCandidates.filter((entry) => entry.id !== named?.id)
  return (
    <>
      <CheckList
        label={w('pick.label')}
        items={[
          {
            id: 'declaration-of-intent',
            ok: named !== null ? named.state === 'CHECKED' : true,
            words: named && model.named ? w(model.named.key, model.named.params) : w('pick.none'),
            ...(named
              ? {
                  fix: (
                    <Button size="sm" variant="link" heldReason={model.letGoHeld ? w(model.letGoHeld.key) : null} onClick={() => actions?.onLetGo?.()}>
                      {model.busy ? t('common.working') : w('pick.letGo')}
                    </Button>
                  ),
                }
              : {}),
          },
        ]}
      />
      {!intent.switches.declarationsOfIntentOn && <p className="fw-fin-hint">{w('pick.switchOff')}</p>}
      {others.length > 0 && (
        <span className="fw-fin-actions">
          <Select size="sm" aria-label={named ? w('pick.other') : w('pick.choose')} value={model.picked ?? ''} onChange={(event) => actions?.onPick?.(event.target.value || null)}>
            <option value="">{named ? w('pick.other') : w('pick.choose')}</option>
            {others.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {w('pick.option', { protocol: entry.protocolNumber, year: entry.year, state: w(`state.${entry.state}`) })}
              </option>
            ))}
          </Select>
          <Button size="sm" heldReason={model.nameHeld ? w(model.nameHeld.key) : null} onClick={() => actions?.onName?.()}>
            {model.busy ? t('common.working') : w('pick.name')}
          </Button>
        </span>
      )}
      {model.problem && <p className="fw-fin-hint">{s(model.problem.key, model.problem.params)}</p>}
    </>
  )
}
