'use client'

import { useEffect, useState } from 'react'
import { useOfficeApi } from '../../../../lib/session/context'
import type { CreditReason } from '../../_shared/api'
import { readProblem } from '../../_shared/model'
import { getVatTimeLimit, type VatLimit } from './api'
import { VatTimeLimitNote } from './view/VatTimeLimitNote'

/**
 * The credit note's VAT time-limit warning (B-W2b-417 on B-W2b-401's GET …/vat-time-limit): read for the reason the person
 * picks (once per reason), drawn inside the credit note dialog.
 */
export function VatTimeLimit({ invoiceId, reason }: { invoiceId: string; reason: CreditReason | null }) {
  const api = useOfficeApi()
  const [answer, setAnswer] = useState<{ value: VatLimit | null; problem: string | null }>({ value: null, problem: null })
  useEffect(() => {
    if (!reason) return
    let live = true
    setAnswer({ value: null, problem: null })
    getVatTimeLimit(api, invoiceId, reason)
      .then((value) => live && setAnswer({ value, problem: null }))
      .catch((error: unknown) => live && setAnswer({ value: null, problem: readProblem(error) }))
    return () => {
      live = false
    }
  }, [api, invoiceId, reason])
  return <VatTimeLimitNote model={{ asked: !!reason, value: answer.value, problem: answer.problem }} />
}
