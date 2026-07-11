/**
 * FS0 — load-baseline driver (docs/factory/FS0-SPEC.md). Hits the :3199
 * verify server (NEVER :3100) with the seeded OWNER session and records
 * p50/p95/max + payload size per route: 2 warm-ups + 20 timed samples,
 * sequential; then a 10-way concurrent burst on the three hottest routes.
 * Run:  npx tsx scripts/scale/measure.ts [baseUrl]   (default http://localhost:3199)
 * Output: data/scale-baseline.json + a markdown table on stdout.
 */
import fs from "node:fs";
import path from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3199";
if (/3100/.test(BASE)) throw new Error("refusing: never measure against the Owner's :3100 server");

const dataDir = path.join(process.cwd(), "data");
const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, "scale-manifest.json"), "utf8")) as {
  sessionToken: string;
  monsterConversationId: string;
  typicalConversationId: string;
  dbSizeBytes: number;
  volumes: Record<string, number>;
};
const COOKIE = `factory_session=${manifest.sessionToken}`;

const ROUTES: { name: string; path: string }[] = [
  { name: "inbox list (open)", path: "/api/inbox?state=open" },
  { name: "inbox list + search", path: "/api/inbox?state=all&q=kangaroo" },
  { name: "inbox thread (typical)", path: `/api/inbox/${manifest.typicalConversationId}` },
  { name: "inbox thread (5k msgs)", path: `/api/inbox/${manifest.monsterConversationId}` },
  { name: "orders (all states)", path: "/api/orders?state=all" },
  { name: "orders search", path: "/api/orders?q=ORD-2" },
  { name: "production board", path: "/api/production" },
  { name: "materials stock", path: "/api/materials/stock" },
  { name: "financials", path: "/api/financials" },
  { name: "financials deposits", path: "/api/financials/deposits" },
  { name: "analytics", path: "/api/analytics" },
  { name: "analytics counters", path: "/api/analytics/counters" },
  { name: "quotes", path: "/api/quotes" },
  { name: "contacts search", path: "/api/contacts?q=Rossi" },
  { name: "shipping", path: "/api/shipping" },
  { name: "global search", path: "/api/search?q=kangaroo" },
  { name: "notifications", path: "/api/notifications" },
  { name: "users-lite", path: "/api/users-lite" },
  { name: "export orders CSV", path: "/api/exports/orders" },
];

const WARMUPS = 2;
const SAMPLES = 20;
const BURST_ROUTES = ["inbox list (open)", "production board", "materials stock"];
const BURST_CLIENTS = 10;

async function timeOne(p: string): Promise<{ ms: number; bytes: number; status: number }> {
  const t0 = performance.now();
  const res = await fetch(BASE + p, { headers: { cookie: COOKIE } });
  const body = await res.arrayBuffer();
  return { ms: performance.now() - t0, bytes: body.byteLength, status: res.status };
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function main() {
  // sanity: authenticated?
  const probe = await timeOne("/api/auth/me");
  if (probe.status !== 200) throw new Error(`auth probe failed (${probe.status}) — is :3199 running against the scale DB?`);

  const results: Record<string, { p50: number; p95: number; max: number; bytes: number; status: number }> = {};
  for (const r of ROUTES) {
    for (let i = 0; i < WARMUPS; i++) await timeOne(r.path);
    const times: number[] = [];
    let bytes = 0, status = 200;
    for (let i = 0; i < SAMPLES; i++) {
      const s = await timeOne(r.path);
      times.push(s.ms); bytes = s.bytes; status = s.status;
    }
    times.sort((a, b) => a - b);
    results[r.name] = { p50: pct(times, 50), p95: pct(times, 95), max: times[times.length - 1], bytes, status };
    console.log(`${r.name}: p50 ${results[r.name].p50.toFixed(0)}ms  p95 ${results[r.name].p95.toFixed(0)}ms  ${(bytes / 1024).toFixed(0)}KB  [${status}]`);
  }

  const bursts: Record<string, { wallMs: number; perReqP95: number }> = {};
  for (const name of BURST_ROUTES) {
    const route = ROUTES.find((r) => r.name === name)!;
    const t0 = performance.now();
    const all = await Promise.all(Array.from({ length: BURST_CLIENTS }, () => timeOne(route.path)));
    const times = all.map((a) => a.ms).sort((a, b) => a - b);
    bursts[name] = { wallMs: performance.now() - t0, perReqP95: pct(times, 95) };
    console.log(`burst×${BURST_CLIENTS} ${name}: wall ${bursts[name].wallMs.toFixed(0)}ms  per-req p95 ${bursts[name].perReqP95.toFixed(0)}ms`);
  }

  const out = { measuredAt: new Date().toISOString(), base: BASE, dbSizeBytes: manifest.dbSizeBytes, volumes: manifest.volumes, results, bursts };
  fs.writeFileSync(path.join(dataDir, "scale-baseline.json"), JSON.stringify(out, null, 2));

  // markdown table for the baseline doc
  console.log("\n| Route | p50 | p95 | max | payload |");
  console.log("|---|---|---|---|---|");
  for (const [name, r] of Object.entries(results)) {
    console.log(`| ${name} | ${r.p50.toFixed(0)} ms | ${r.p95.toFixed(0)} ms | ${r.max.toFixed(0)} ms | ${(r.bytes / 1024).toFixed(0)} KB |`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
