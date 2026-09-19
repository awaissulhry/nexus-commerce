/**
 * Settings › Shared products (AE.2 + AE.3 screens). Plan: docs/2026-09-16-assortment-engine-plan.md §19.
 * Thin server shell; the client component loads everything for the business in the URL.
 */
import SharingClient from './SharingClient'

export const dynamic = 'force-dynamic'

export default function SharedProductsSettingsPage() {
  return <SharingClient />
}
