'use client'

import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { NAMESPACE } from '../model'

/** A word of the declarations' catalogue drawn where a label is a node (Invoices' ⋯ lists it beside its own words). B-W2b-GB02 (G152). */
export function IntentWord({ k }: { k: string }) {
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <Word k={k} />
    </WithMessages>
  )
}

function Word({ k }: { k: string }) {
  const w = useT(NAMESPACE)
  return <>{w(k)}</>
}
