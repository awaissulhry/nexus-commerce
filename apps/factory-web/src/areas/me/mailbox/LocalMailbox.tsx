'use client'

import { useRouter } from 'next/navigation'
import type { LocalMailboxModel } from './model'
import { LocalMailboxView } from './view/LocalMailboxView'

/** The live Local mailbox (B-W2b-F58): the page read the mails on the server; Refresh reads them again. */
export function LocalMailbox({ model }: { model: LocalMailboxModel }) {
  const router = useRouter()
  return <LocalMailboxView model={model} onRefresh={() => router.refresh()} />
}
