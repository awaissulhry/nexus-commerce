import { notFound, redirect } from 'next/navigation'
import { kindsOf, portalPrefix } from '../../../../../../../portal/shell/model'
import { recordPageOf } from '../../../../../../../portal/shell/nav/portal-nav'
import { RecordPage } from '../../../../../../../portal/shell/record/RecordPage'
// B-TH-274 (P-ANY): `?view=conversation` keeps a record's conversation as its own page (an invoice's "Ask about this invoice").
import { opensOwnPage } from '../../../../../../../portal/shell/record/model'
import { loadPortalSession } from '../../../../../../../portal/shell/server'

/**
 * `/p/<party>/open/<type>/<id>` — where the API's links point (notifications, tasks, mails; factory-domain portal/home/links):
 * the record's own page for the person's kind once built (RECORD_PAGES), else the generic page — the record's summary and its
 * conversation as the main column (B-TH-274, PL5). `?view=conversation` opens the generic page even when the record has a page
 * of its own (the invoice's conversation); `/open/Party/<own party id>` is the account conversation. The anchor (`#task:<id>`)
 * stays with the browser through the redirect.
 */
export default async function OpenRecordPage({ params, searchParams }: { params: Promise<{ type: string; id: string }>; searchParams: Promise<{ view?: string | string[] }> }) {
  const { type, id } = await params
  const { view } = await searchParams
  if (!/^[A-Z][A-Za-z0-9]{0,63}$/.test(type) || !/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const load = await loadPortalSession()
  // The layout already sent a person without a session to sign in.
  if (load.kind !== 'signed_in') return null
  const page = recordPageOf(kindsOf(load.me), type, id)
  if (page && opensOwnPage(page, view)) redirect(`${portalPrefix(load.me.party.code)}${page}`)
  return <RecordPage type={type} id={id} />
}
