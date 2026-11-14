'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import type { Invoice } from '../../_shared/api'
import { abilitiesOf, money, readProblem } from '../../_shared/model'
import { depthProblem, type DepthProblem } from '../test-mode/depth'
import { decideAgain, getInvoiceTax, type InvoiceTax } from './api'
import { againHeld, stampLineOf } from './model'
import { StampDutyCheckView } from './view/StampDutyCheckView'

/**
 * The pre-check's stamp duty line (B-W2b-417 on B-W2b-392's GET /invoicing/invoices/:id/tax): read for a draft whenever its
 * version changes (its lines, a deduction, a declaration); "Decide again" saves the draft unchanged (PATCH with its
 * version) and hands the answer to the record, which reads its parts again.
 */
export function StampDutyCheck({ invoice, onChanged }: { invoice: Invoice; onChanged: (next: Invoice) => void }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const [tax, setTax] = useState<{ value: InvoiceTax | null; problem: string | null }>({ value: null, problem: null })
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<DepthProblem | null>(null)

  const read = useCallback(async () => {
    try {
      setTax({ value: await getInvoiceTax(api, invoice.id), problem: null })
    } catch (error) {
      setTax({ value: null, problem: readProblem(error) })
    }
  }, [api, invoice.id])
  useEffect(() => {
    void read()
  }, [read, invoice.version])

  const value = tax.value
  const amount = value?.stampDuty.amount
  const line = value ? stampLineOf(value, can.price && amount !== null && amount !== undefined ? money(amount, invoice.currency, locale) : null) : null
  return (
    <StampDutyCheckView
      model={{ line, readProblem: tax.problem, held: againHeld(can, busy), problem, busy }}
      actions={{
        onRetry: () => void read(),
        onAgain: () => {
          if (busy) return
          setBusy(true)
          setProblem(null)
          void (async () => {
            try {
              onChanged(await decideAgain(api, invoice, newIdempotencyKey()))
            } catch (error) {
              setProblem(depthProblem(error))
            } finally {
              setBusy(false)
            }
          })()
        },
      }}
    />
  )
}
