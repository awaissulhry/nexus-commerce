'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '../../lib/api/client'
import { isApiError } from '../../lib/api/errors'
import { WithMessages } from '../../record-panels/i18n'
import { readLinkDeposit } from './api'
import type { DepositPayViewModel } from './model'
import { DepositPayView } from './view/DepositPayView'

/**
 * A DEPOSIT_INFO link, once it opened (the link landing did `POST /link/open`): reads the deposit and how to pay it
 * (`GET /payments/link/deposit`). Reading uses nothing. The token stays in the client's `x-factory-link` header; nothing
 * of it is in an address or in storage.
 */
export function DepositPay({ api }: { api: ApiClient }) {
  return (
    <WithMessages namespaces={['deposit-link']}>
      <DepositPayContainer api={api} />
    </WithMessages>
  )
}

function DepositPayContainer({ api }: { api: ApiClient }) {
  const [model, setModel] = useState<DepositPayViewModel>({ link: 'loading', deposit: null, copied: null })
  const load = useCallback(async () => {
    try {
      const deposit = await readLinkDeposit(api)
      setModel((current) => ({ ...current, link: 'valid', deposit }))
    } catch (error) {
      setModel((current) => ({ ...current, link: isApiError(error) && error.kind === 'not_found' ? 'unavailable' : 'error' }))
    }
  }, [api])
  useEffect(() => {
    void load()
  }, [load])
  return (
    <DepositPayView
      model={model}
      actions={{
        onCopy: (what, text) => {
          void navigator.clipboard
            ?.writeText(text)
            .then(() => setModel((current) => ({ ...current, copied: what })))
            .catch(() => undefined)
        },
      }}
    />
  )
}
