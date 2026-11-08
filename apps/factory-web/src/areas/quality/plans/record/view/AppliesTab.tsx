'use client'

import { Card, Field } from '@nexus/ui/components'
import { Input } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../../lib/i18n/ds-parts'
import { formatNumber } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { PlanRecord } from '../../api'
import { PLAN_LIMITS, type ChipKind } from '../../constants'
import { appliesProblems, chipKindsFor, chipPickable, type AppliesDraft } from '../../model'
import { ChipEditor, problemAt, SectionHead, useSay } from '../../view/parts'
import type { PlanRecordModel } from './PlanRecordView'

export interface AppliesActions {
  onApplies?: (draft: AppliesDraft) => void
  onDiscardApplies?: () => void
  onSaveApplies?: () => void
  onChipSearch?: (kind: ChipKind, q: string) => void
}

/**
 * Applies to (design rec tab "applies"): where the plan is used — rule chips by style, category, material, supplier,
 * operation and customer (none: everything of its stage) — with "applies to 14 of 20 styles" (materials for an incoming
 * plan) for what is saved, and the plan's name. Its own save (the plan's PATCH): the chips are the plan's, not a version's.
 */
export function AppliesTab({ model, record, count, actions }: { model: PlanRecordModel; record: PlanRecord; count: number; actions?: AppliesActions }) {
  const t = useT('quality-plans')
  const say = useSay()
  const locale = useLocale()
  const draft = model.applies
  if (!draft) return null
  const mayManage = model.can.manage && record.may.manage
  const problems = appliesProblems(draft)
  const shownProblems = model.shown ? problems : []
  const preview = record.preview
  const offline = model.live === 'offline'
  return (
    <section className="fw-qp-tab" aria-labelledby="fw-qp-applies">
      <Card padded>
        <SectionHead id="fw-qp-applies" title={t('applies.title')} sub={t(record.plan.stage === 'INCOMING' ? 'applies.subIncoming' : 'applies.sub')} />
        <div className="fw-qp-form">
          <Field label={t('applies.name')} error={say(problemAt(shownProblems, 'name')) || undefined} required>
            <Input value={draft.name} maxLength={PLAN_LIMITS.name} readOnly={!mayManage} onChange={(event) => actions?.onApplies?.({ ...draft, name: event.target.value })} />
          </Field>
          <ChipEditor
            label={t('applies.chips')}
            chips={draft.chips}
            kinds={chipKindsFor(record.plan.stage)}
            pickable={(kind) => chipPickable(kind, model.can)}
            stage={record.plan.stage}
            prefix={model.prefix}
            search={model.chipSearch}
            problems={shownProblems}
            disabled={!mayManage}
            onChange={(chips) => actions?.onApplies?.({ ...draft, chips })}
            onSearch={(kind, q) => actions?.onChipSearch?.(kind, q)}
          />
          <p className="fw-qp-preview-line" role="status">
            {count > 0
              ? t('applies.previewAfterSave')
              : t(preview.subject === 'materials' ? 'applies.previewMaterials' : 'applies.previewStyles', { count: preview.count, n: formatNumber(preview.count, locale), of: formatNumber(preview.outOf, locale) })}
          </p>
          {record.rules > 0 && <p className="fw-qp-muted">{t('applies.rules', { count: record.rules })}</p>}
          <p className="fw-qp-muted">{t('applies.how')}</p>
        </div>
      </Card>
      {mayManage && count > 0 && (
        <EditModeBar
          count={count}
          onDiscard={() => actions?.onDiscardApplies?.()}
          onApply={() => actions?.onSaveApplies?.()}
          applyLabel={model.busy === 'applies' ? t('common.saving') : t('applies.save')}
          busy={model.busy === 'applies'}
          applyHeldReason={problems.length > 0 ? t('builder.heldProblems', { count: problems.length }) : offline ? t('held.offline') : null}
          saveShortcut
        />
      )}
    </section>
  )
}
