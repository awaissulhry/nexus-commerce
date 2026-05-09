'use client'

import PageHeader from '@/components/layout/PageHeader'
import CronStatusPanel from './CronStatusPanel'
import StockDriftPanel from './StockDriftPanel'
import ChannelStockEventPanel from './ChannelStockEventPanel'

/**
 * Sync health dashboard. Three operationally meaningful panels:
 *
 *   - CronStatusPanel — recent CronRun executions (success/fail, duration,
 *     last-run age) reading /api/dashboard/cron-runs.
 *   - StockDriftPanel — OUTBOUND drift: channel listings whose ATP / price
 *     drifted from master, with one-click resync, reading
 *     /api/dashboard/stock-drift.
 *   - ChannelStockEventPanel — INBOUND drift (CS.4): channel-pushed stock
 *     observations awaiting operator triage, reading
 *     /api/stock/channel-events?status=OPEN.
 *
 * Three additional panels (channel health vitals, conflict resolution,
 * sync error stream) were removed in L.0c — their /api/sync-health/*
 * backend was an Express router that never mounted in the live Fastify
 * server, so every fetch silently 404'd. They will return as part of
 * the unified /sync-logs hub (Phase L2) reading typed Fastify endpoints.
 */
export default function HealthDashboardPage() {
  return (
    <div>
      <PageHeader
        title="Sync Health Dashboard"
        subtitle="Cron execution + listing drift across channels"
        breadcrumbs={[
          { label: 'Dashboard', href: '/dashboard' },
          { label: 'Health' },
        ]}
      />
      <div className="space-y-6">
        <CronStatusPanel />
        <ChannelStockEventPanel />
        <StockDriftPanel />
      </div>
    </div>
  )
}
