import type { Metadata } from 'next'
import { MailboxPage } from '../../../../../../areas/me/mailbox/MailboxPage'

export const metadata: Metadata = { title: 'Nexus Factory' }

/** `/w/<company>/me/mailbox` — the local test server's mailbox (B-W2b-F58; a 404 anywhere but FACTORY_ENV=local). */
export default function Page({ params }: { params: Promise<{ company: string }> }) {
  return <MailboxPage params={params} />
}
