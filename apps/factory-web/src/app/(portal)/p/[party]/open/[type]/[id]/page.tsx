import { notFound, redirect } from 'next/navigation'
import { kindsOf, portalPrefix } from '../../../../../../../portal/shell/model'
import { recordPageOf } from '../../../../../../../portal/shell/nav/portal-nav'
import { RecordPage } from '../../../../../../../portal/shell/record/RecordPage'
import { loadPortalSession } from '../../../../../../../portal/shell/server'

/**
 * `/p/<party>/open/<type>/<id>` — where the API's links point (notifications, tasks, mails; factory-domain portal/home/links):
 * the record's own page for the person's kind once built (RECORD_PAGES), else the frame's record page with its Messages. The
 * anchor (`#task:<id>`) stays with the browser through the redirect.
 */
export default async function OpenRecordPage({ params }: { params: Promise<{ type: string; id: string }> }) {
  const { type, id } = await params
  if (!/^[A-Z][A-Za-z0-9]{0,63}$/.test(type) || !/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const load = await loadPortalSession()
  // The layout already sent a person without a session to sign in.
  if (load.kind !== 'signed_in') return null
  const page = recordPageOf(kindsOf(load.me), type, id)
  if (page) redirect(`${portalPrefix(load.me.party.code)}${page}`)
  return <RecordPage type={type} id={id} />
}
