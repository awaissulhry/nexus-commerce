'use client'

import { Button, Spinner } from '@nexus/ui/primitives'
import { useScopedT, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Phrase } from '../../../_shared/model'
import { CheckList } from '../../../_shared/parts'
import { DEPTH, DEPTH_NAMESPACES, type DepthProblem } from '../../test-mode/depth'
import type { StampLine } from '../model'

export interface StampDutyCheckModel {
  /** The decision in words (null while it is read). */
  line: StampLine | null
  /** The read failed (a finance message key). */
  readProblem: string | null
  /** Why "Decide again" is held. */
  held: Phrase | null
  /** "Decide again" was refused. */
  problem: DepthProblem | null
  busy: boolean
}

export interface StampDutyCheckActions {
  onAgain?: () => void
  onRetry?: () => void
}

/**
 * "Stamp duty decided" in the draft's Before you issue (design finance.invoices rec:Invoice lines/precheck, W2b): the
 * rule's decision in words — due and charged to the customer as a line, not due, not charged on this type of document, an
 * invoice not in euro, or waiting for the accountant while the company's switch is off — and, when the draft's stamp line
 * no longer matches the decision (its lines changed), "Decide again" (the draft saved unchanged). The issue's own check
 * says the same; this line says how to fix it.
 */
export function StampDutyCheckView({ model, actions }: { model: StampDutyCheckModel; actions?: StampDutyCheckActions }) {
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <StampCheck model={model} actions={actions} />
    </WithMessages>
  )
}

function StampCheck({ model, actions }: { model: StampDutyCheckModel; actions?: StampDutyCheckActions }) {
  const t = useT('finance')
  const w = useT(DEPTH)
  const s = useScopedT('finance')
  if (model.readProblem)
    return (
      <p className="fw-fin-hint">
        {w('stamp.check.failed', { why: t(model.readProblem) })}{' '}
        <Button size="sm" variant="link" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      </p>
    )
  if (!model.line)
    return (
      <p className="fw-fin-hint" role="status">
        <Spinner size={12} /> {w('stamp.check.reading')}
      </p>
    )
  const line = model.line
  return (
    <>
      <CheckList
        label={w('stamp.check.label')}
        items={[
          {
            id: 'stamp-duty',
            ok: line.ok,
            words: w(line.words.key, line.words.params),
            ...(line.again
              ? {
                  fix: (
                    <Button size="sm" variant="link" heldReason={model.held ? w(model.held.key) : null} onClick={() => actions?.onAgain?.()}>
                      {model.busy ? t('common.working') : w('stamp.check.again')}
                    </Button>
                  ),
                }
              : {}),
          },
        ]}
      />
      {model.problem && <p className="fw-fin-hint">{s(model.problem.key, model.problem.params)}</p>}
    </>
  )
}
