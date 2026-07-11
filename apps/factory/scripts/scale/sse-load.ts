/**
 * FS2 — SSE load + resume probe (FS2-SPEC test plan). Against :3199 + the
 * scale DB (NEVER :3100):
 *   1. opens N SSE clients, injects M outbox rows straight into the DB
 *      (worker-style cross-process publish), asserts EVERY client receives
 *      EVERY event, reports delivery-latency p50/p95;
 *   2. probes an API route mid-storm (server responsiveness under fan-out);
 *   3. offline-resume: disconnects a client, injects rows, reconnects with
 *      ?sinceId= and asserts the gap replays completely (the pre-FS2 design
 *      lost worker events across disconnects — the whole point).
 * Run: FACTORY_DATABASE_URL="file:$(pwd)/data/scale.db" npx tsx scripts/scale/sse-load.ts [clients] [events]
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../../src/lib/db";

const BASE = "http://localhost:3199";
const N_CLIENTS = Number(process.argv[2] ?? 50);
const N_EVENTS = Number(process.argv[3] ?? 20);

const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "scale-manifest.json"), "utf8")) as { sessionToken: string };
const COOKIE = `factory_session=${manifest.sessionToken}`;

type Client = {
  idx: number;
  received: Map<number, number>; // outboxId → receivedAt ms
  abort: AbortController;
  lastId: number;
  done: Promise<void>;
};

function openClient(idx: number, sinceId = 0): Client {
  const abort = new AbortController();
  const client: Client = { idx, received: new Map(), abort, lastId: sinceId, done: Promise.resolve() };
  client.done = (async () => {
    const res = await fetch(`${BASE}/api/events?sinceId=${sinceId}`, { headers: { cookie: COOKIE }, signal: abort.signal });
    if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const idLine = frame.split("\n").find((l) => l.startsWith("id: "));
        if (idLine) {
          const id = Number(idLine.slice(4));
          if (id > 0 && !client.received.has(id)) {
            client.received.set(id, performance.now());
            client.lastId = Math.max(client.lastId, id);
          }
        }
      }
    }
  })().catch((e) => {
    if (!abort.signal.aborted) throw e;
  });
  return client;
}

async function injectEvents(count: number, tag: string): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const row = await prisma.factoryEventOutbox.create({ data: { type: "order.updated", payload: { probe: tag, i } } });
    ids.push(row.id);
    await new Promise((r) => setTimeout(r, 50)); // spread over ~1s+ (realistic burst)
  }
  return ids;
}

const pct = (xs: number[], p: number) => xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

async function main() {
  console.log(`FS2 sse-load: ${N_CLIENTS} clients × ${N_EVENTS} events → ${BASE}`);

  // 1. fan-out storm
  const clients = Array.from({ length: N_CLIENTS }, (_, i) => openClient(i));
  await new Promise((r) => setTimeout(r, 2_500)); // all connected + poller warm

  const t0 = performance.now();
  const ids = await injectEvents(N_EVENTS, "storm");
  const deadline = performance.now() + 15_000;
  for (;;) {
    const complete = clients.every((c) => ids.every((id) => c.received.has(id)));
    if (complete || performance.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const missing = clients.reduce((s, c) => s + ids.filter((id) => !c.received.has(id)).length, 0);
  const latencies: number[] = [];
  const injectedAt = new Map(ids.map((id, i) => [id, t0 + i * 50]));
  for (const c of clients) for (const [id, at] of c.received) if (injectedAt.has(id)) latencies.push(at - injectedAt.get(id)!);
  console.log(`fan-out: ${N_CLIENTS * ids.length - missing}/${N_CLIENTS * ids.length} deliveries · latency p50 ${pct(latencies, 50).toFixed(0)}ms p95 ${pct(latencies, 95).toFixed(0)}ms`);

  // 2. responsiveness probe mid-storm
  const probeT = performance.now();
  const probe = await fetch(`${BASE}/api/notifications?limit=1`, { headers: { cookie: COOKIE } });
  console.log(`mid-storm API probe: ${probe.status} in ${(performance.now() - probeT).toFixed(0)}ms`);

  // 3. offline-resume (gap-free replay of cross-process events)
  const offline = clients[0];
  const resumeFrom = offline.lastId;
  offline.abort.abort();
  await new Promise((r) => setTimeout(r, 300));
  const gapIds = await injectEvents(5, "offline-gap");
  const resumed = openClient(0, resumeFrom);
  const rDeadline = performance.now() + 10_000;
  for (;;) {
    if (gapIds.every((id) => resumed.received.has(id)) || performance.now() > rDeadline) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const gapMissing = gapIds.filter((id) => !resumed.received.has(id));
  console.log(`offline-resume: replayed ${gapIds.length - gapMissing.length}/${gapIds.length} gap events${gapMissing.length ? " — MISSING " + gapMissing.join(",") : ""}`);

  for (const c of [...clients, resumed]) c.abort.abort();
  const ok = missing === 0 && gapMissing.length === 0 && probe.status === 200;
  console.log(ok ? "\nFS2 sse-load: PASS" : "\nFS2 sse-load: FAIL");
  await prisma.$disconnect();
  process.exit(ok ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
