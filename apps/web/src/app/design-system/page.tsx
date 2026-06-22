/**
 * /design-system — the living catalog route.
 *
 * Thin mount: imports the token CSS layer (so `var(--h10-*)` resolves) and the
 * catalog component (which lives in the portable design-system folder). Kept
 * separate from the existing /design page (the Tailwind-era style guide) by
 * design — this is the H10 system's surface.
 */
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import { TokenCatalog } from '@/design-system/catalog'

export const metadata = { title: 'Nexus Design System — Token Catalog' }

export default function DesignSystemPage() {
  return <TokenCatalog />
}
