'use client'

import { StepUpModal } from '../../../../../lib/i18n/ds-parts'
import type { StepUpState } from '../../../_shared/parts'
import { useDepthWords } from '../parts'

/**
 * The fresh authenticator code of a release from do-not-use (Change status: only a technician, as a sign-safe; Owner answer
 * H1): the DS StepUpModal with this step's words. The state and the act's second run are the plant's `useStepUp`.
 */
export function ReleaseStepUp({ state, onSubmit, onCancel }: { state: StepUpState; onSubmit?: ((code: string) => void) | undefined; onCancel?: (() => void) | undefined }) {
  const t = useDepthWords()
  const problem = state.problem ? t(state.problem.replace(/^stepUp\.problem\./, 'stepUp.')) : null
  return (
    <StepUpModal
      open={state.open}
      title={t('stepUp.title')}
      sentence={state.sentence ? t(state.sentence) : ''}
      busy={state.busy}
      error={problem}
      onSubmit={(code) => onSubmit?.(code)}
      onClose={() => onCancel?.()}
      confirmLabel={t('stepUp.confirm')}
    />
  )
}
