'use client'

import type { ReactNode } from 'react'
import { AlertCircle, Check } from 'lucide-react'
import { Pill, Spinner } from '@nexus/ui/primitives'
import { StepUpModal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { StepUpState } from '../../_shared/hooks'
import type { Hold } from '../api'
import { statusOf, type CellMark } from '../model'
import '../../_shared/quality.css'
import '../holds.css'

/**
 * The parts the Holds screens share (SCR-078: the list, the hold's DetailModal, the place and release dialogs, the hold
 * tag): their catalogues, the hold's state pill (mark AND word), a cell's save mark in our words (the DS CellSaveMark
 * names its states in English only: composed here), and the DS step-up dialog in the holds' words.
 */

/** `holds` with the shared `quality` words, the list frame's (`lists`) and the record panels' (`records`). */
export function HoldsMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={['holds', 'quality', 'lists', 'records']}>{children}</WithMessages>
}

export function HoldPill({ hold }: { hold: Pick<Hold, 'status' | 'overdue'> }) {
  const t = useT('holds')
  const status = statusOf(hold)
  return (
    <Pill tone={status.tone} dot>
      {t(status.key)}
    </Pill>
  )
}

/** A cell's save: a spinner while saving, a tick once saved, "!" with the reason when refused. */
export function SaveMark({ mark }: { mark: CellMark | undefined }) {
  const t = useT('holds')
  if (!mark) return null
  if (mark.state === 'saving')
    return (
      <span role="status" aria-label={t('cell.saving')}>
        <Spinner size={12} />
      </span>
    )
  if (mark.state === 'saved') return <Check size={13} className="fw-hd-saved" role="img" aria-label={t('cell.saved')} />
  const reason = t(mark.problem ?? 'cell.failed')
  return <AlertCircle size={13} className="fw-hd-refused" role="img" aria-label={reason} />
}

/** The DS step-up dialog with what the code allows here (a `holds` key). */
export function HoldsStepUp({ state, onSubmit, onCancel }: { state: StepUpState; onSubmit: (code: string) => void; onCancel: () => void }) {
  const t = useT('holds')
  const q = useT('quality')
  return (
    <StepUpModal
      open={state.open}
      title={q('stepUp.title')}
      sentence={state.sentence ? t(state.sentence) : ''}
      busy={state.busy}
      error={state.problem ? q(state.problem) : null}
      onSubmit={onSubmit}
      onClose={onCancel}
      confirmLabel={t('release.stepUpConfirm')}
    />
  )
}
