'use client'

import { StepUpModal } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import type { StepUpModel } from '../../../shared/model'

/**
 * The DS StepUpModal with this step's words (B-W2b-413): the sentence is a key of `admin-security-depth` (what the code
 * allows), a wrong, used or locked code the Admin words (`admin` stepUp.problem.*). Put inside a provider of both catalogues.
 */
export function FreshCode({ model, onSubmit, onClose }: { model: StepUpModel | undefined; onSubmit?: (code: string) => void; onClose?: () => void }) {
  const t = useT('admin-security-depth')
  const ta = useT('admin')
  if (!model) return null
  return (
    <StepUpModal
      open={model.open}
      title={ta('stepUp.title')}
      sentence={t(model.sentence)}
      busy={model.busy}
      error={model.problem ? ta(model.problem) : null}
      confirmLabel={ta('stepUp.confirm')}
      onSubmit={(code) => onSubmit?.(code)}
      onClose={() => onClose?.()}
    />
  )
}
