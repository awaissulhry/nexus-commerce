import { redirect } from 'next/navigation'

// TECH_DEBT #3 — /monitoring/sync was mentioned in the original spec
// as a planned home for Sync Health, but never landed. The sidebar
// treats /dashboard/health as the canonical sync health surface
// (CronStatusPanel + StockDriftPanel + ConflictsSection +
// HealthVitalsSection + SystemLogsSection live there). We redirect
// here so any external link that still points at /monitoring/sync
// reaches the live page.
export default function MonitoringSyncRedirect() {
  redirect('/dashboard/health')
}
