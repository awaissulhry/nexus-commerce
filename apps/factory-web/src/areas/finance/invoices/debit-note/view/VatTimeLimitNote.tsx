'use client'

import { Banner } from '@nexus/ui/components'
import { Spinner } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayInstant } from '../../../_shared/model'
import { DEPTH, DEPTH_NAMESPACES } from '../../test-mode/depth'
import type { VatLimit } from '../api'
import { VAT_LIMIT_TONE, vatLimitWords } from '../model'

export interface VatTimeLimitModel {
  /** No reason picked yet: nothing is said. */
  asked: boolean
  value: VatLimit | null
  /** The read failed (a finance message key): said, never drawn as "no limit". */
  problem: string | null
}

/**
 * The VAT time-limit warning inside the credit note (design finance.invoices pop:credit-note "VAT time-limit warning on
 * decreases", W2b; FIN-073): for the reason picked, whether this credit note may still lower the VAT — within one year of
 * the operation (until when), beyond it (the VAT stays due: ask the accountant), no limit for a return or a defect, ask for
 * "other", or waiting for the accountant while the company's switch is off. A warning only: the credit note is never held.
 */
export function VatTimeLimitNote({ model }: { model: VatTimeLimitModel }) {
  if (!model.asked) return null
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <Note model={model} />
    </WithMessages>
  )
}

function Note({ model }: { model: VatTimeLimitModel }) {
  const t = useT('finance')
  const w = useT(DEPTH)
  const locale = useLocale()
  if (model.problem) return <Banner tone="warning" title={w('vatLimit.failed', { why: t(model.problem) })} />
  if (!model.value)
    return (
      <p className="fw-fin-hint" role="status">
        <Spinner size={12} /> {w('vatLimit.reading')}
      </p>
    )
  const words = vatLimitWords(model.value, (value) => formatDate(dayInstant(value), { locale }))
  return (
    <Banner tone={VAT_LIMIT_TONE[model.value.verdict.state]} title={w('vatLimit.title')}>
      {w(words.key, words.params)}
    </Banner>
  )
}
