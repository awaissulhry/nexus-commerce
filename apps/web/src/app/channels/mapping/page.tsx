/**
 * PES.6 — the Global Mapping Engine.
 *
 * The Rithum model: per channel × market, a template that says how OUR data becomes the
 * channel's fields — category mapping on one side, per-field rules with a formula engine on the
 * other, and a Preview SKU that resolves every field live so "what you see" is what a publish
 * would send.
 *
 * A new top-level route by design (layout doc §4 names it as the designated global area): the
 * mapping is not per product, so it does not belong in the product studio; the per-product
 * Mapping tab only SHOWS this engine's results.
 *
 * Client-only data: the API session cookie is cross-site, so a server fetch cannot authenticate.
 */
import { MappingClient } from './MappingClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export const metadata = { title: 'Channel mapping · Nexus' }

export default function ChannelMappingPage() {
  return <MappingClient />
}
