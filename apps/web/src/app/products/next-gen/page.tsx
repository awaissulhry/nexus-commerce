/**
 * LF.1 — `/products/next-gen`, the local-first sibling of `/products/next`.
 *
 * Sibling-route strategy: this page exists BESIDE the SSRM one, shares no code path with it, and
 * can be deleted without touching production. Nothing here imports a production API route or a
 * server action, and no existing file was modified to make it render.
 *
 * 🔴 `AppShell`'s `NO_RAIL_PREFIXES` contains `/products/next`, and the match is `startsWith` —
 * so this route inherits that branch for free: the app-wide top bar, no app rail, and the route
 * owning its own layout. That is the intended shape here, but it is inheritance rather than a
 * decision, so if `/products/next` ever leaves that list this page's chrome changes with it.
 *
 * The client component is where everything happens — PGlite is WASM and must never be pulled
 * into the server bundle, so this file does no data work at all.
 */

import './next-gen.css'
import { NextGenClient } from './NextGenClient'

export const dynamic = 'force-dynamic'

export default function ProductsNextGenPage() {
  return <NextGenClient />
}
