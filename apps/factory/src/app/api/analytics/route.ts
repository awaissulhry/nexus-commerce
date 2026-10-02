/**
 * FP10 — the analytics dashboard data: every panel folded server-side from
 * records that already exist. Throughput + lead-time from work-order stages,
 * on-time from shipments vs promise, margin (by customer/month/product) reusing
 * the FP9 rollup, win/loss from quotes. Money grain-stripped at the edge. The
 * date range (FP10.4) scopes the order-derived panels. P11: the folding lives in src/lib/analytics/dashboard.ts
 * (Claude's factory-analytics reads it too).
 */
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { loadAnalyticsDashboard } from "@/lib/analytics/dashboard";

export const permission = PAGES.analytics;

export const GET = guarded(PAGES.analytics, async (req, { resolved }) => {
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const range = from || to ? { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } : undefined;
  return jsonStripped(await loadAnalyticsDashboard(range), resolved);
});
