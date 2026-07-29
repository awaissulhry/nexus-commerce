/**
 * AX3.5 — Blueprints moved into the Campaign Builder as "Replicate Structure".
 *
 * Replication is a way of creating campaigns, so it belongs with the other
 * builder types rather than in the nav rail. This route stays as a permanent
 * redirect: the operator runbook, and any bookmark, still work.
 */
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'
export default function BlueprintsPage() {
  redirect('/marketing/ads/campaign-builder/replicate')
}
