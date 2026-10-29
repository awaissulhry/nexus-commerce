import type { Metadata } from 'next'
import { MailToSort } from '../../../../../../areas/home/mail-to-sort/MailToSort'

export const metadata: Metadata = { title: 'Mail to sort · Nexus Factory' }

/**
 * Home › Mail to sort (SCR-019; areas/home/nav.ts, permission email.triage). The company layout above loaded the
 * session and draws the Office shell; the page is the client container, which loads the mail through the API.
 */
export default function MailToSortPage() {
  return <MailToSort />
}
