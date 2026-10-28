/**
 * /design-system — the living catalog route.
 *
 * Thin mount: imports the token CSS layer (so `var(--nds-*)` resolves) and the
 * catalog component (which lives beside this page, in `_catalog/`). Kept
 * separate from the existing /design page (the Tailwind-era style guide) by
 * design — this is the H10 system's surface.
 */
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'
import '@/design-system/styles/a11y.css'
import { TokenCatalog } from './_catalog'

export const metadata = { title: 'Nexus Design System — Token Catalog' }

export default function DesignSystemPage() {
  return <TokenCatalog />
}
