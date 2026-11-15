'use client'

import { useCallback, useEffect, useState } from 'react'
import { useOfficeApi } from '../../../../lib/session/context'
import type { Payment } from '../../_shared/api'
import { useCoalesced, useLive } from '../../_shared/hooks'
import { readProblem } from '../../_shared/model'
import { paymentBankLine, type PaymentBankLine } from './api'
import { BankLineCard } from './view/BankLineCard'

/**
 * The Bank line tab's container (B-W2b-425 on B-W2b-393's API): reads the statement line the payment came from and how sure
 * its match was (payments.view; the line itself with payments.bank.view). Live: a bank line accepted or taken back reads it
 * again.
 */
export function BankLine({ payment, prefix }: { payment: Payment; /** B-W2b-406: `/w/<company>` for the statement's link. */ prefix: string }) {
  const api = useOfficeApi()
  const [value, setValue] = useState<PaymentBankLine | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const read = useCallback(async () => {
    try {
      setValue(await paymentBankLine(api, payment.id))
      setProblem(null)
    } catch (error) {
      setProblem(readProblem(error))
    }
  }, [api, payment.id])
  useEffect(() => {
    void read()
  }, [read, payment.version])
  const reread = useCoalesced(() => void read(), 700)
  useLive(
    (change) => {
      if ((change.type === 'bank_match.accepted' || change.type === 'bank_match.reversed') && Object.values(change.fields).includes(payment.id)) reread()
    },
    () => reread(),
  )
  return <BankLineCard model={{ value, problem, people: payment.people, prefix }} actions={{ onRetry: () => void read() }} />
}
