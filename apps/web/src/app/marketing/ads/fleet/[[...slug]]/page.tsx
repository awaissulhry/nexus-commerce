/**
 * NAF.SB.7 — the old fleet URLs, kept alive as redirects.
 *
 * The Agent Fleet moved out of /marketing/ads because it is not a marketing
 * surface: its roster in docs/AGENT_FLEET.md Part 6 already reaches catalog,
 * pricing, inventory and platform-ops analysts. Only its first cohort happens
 * to be ads.
 *
 * This is an optional catch-all, so it covers BOTH /marketing/ads/fleet and
 * everything beneath it in one file. It deliberately does not touch
 * next.config.js — that file is modified by a parallel session right now, and a
 * redirect table is not worth a collision over.
 *
 * NOTE the path this does NOT catch: /marketing/ads/rules-automation/fleet/…,
 * where the components and the worker page still live. Those are a different
 * route and keep working untouched.
 */
import { permanentRedirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default async function Page({
  params,
}: {
  params: Promise<{ slug?: string[] }>
}) {
  const { slug } = await params
  const rest = slug?.length ? `/${slug.join('/')}` : ''
  permanentRedirect(`/fleet${rest}`)
}
