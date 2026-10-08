// The old FBA inbound wizard (F.5) lived here; its server routes are retired (they answer 410). FBA shipments have their
// own page since 2026-10-08 (Owner): Fulfillment › Outbound › FBA shipments. Bookmarks land there.
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { workspaceHref } from '@/lib/workspaces/paths'

export const dynamic = 'force-dynamic'

export default async function OldFbaInboundWizardPage() {
  const workspaceId = (await headers()).get('x-nexus-page-workspace')
  redirect(workspaceHref(workspaceId, '/fulfillment/outbound/fba'))
}
