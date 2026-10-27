// /marketing/reviews/insights — Insights has no page of its own: it opens on Themes (next.config.js redirects the
// address first, also inside a business; this page is the fallback when the redirect does not run). The fallback keeps
// the business (`/w/<id>/…`, audit P4-4): the page's business comes on the request, as every page reads it.
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { workspaceHref } from '@/lib/workspaces/paths'

export default async function ReviewsInsightsPage() {
  const workspaceId = (await headers()).get('x-nexus-page-workspace')
  redirect(workspaceHref(workspaceId, '/marketing/reviews/insights/themes'))
}
