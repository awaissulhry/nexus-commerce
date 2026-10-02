/**
 * P11/P12 — Claude's factory server, proven end to end on a PRIVATE SQLite file (never the factory's own database):
 * migrations applied, a small factory seeded, connections created as the OWNER would, then the real stdio server
 * (mcp/server.ts) spawned and spoken to over JSON-RPC, as Claude Code does.
 *
 *   npx tsx scripts/verify/claude-mcp.ts /path/outside/the/repo/claude-mcp-verify.db
 *
 * It checks: the server refuses to start in RBAC shadow mode and with a revoked or expired token; the OWNER's
 * read-and-draft connection is offered every tool and sees money; a WORKER's connection is offered only production,
 * materials and its drafts, and sees no money; every call is audited; a connection revoked mid-session is refused on
 * the next call; stdout carries only protocol messages. P12: drafts stay drafts and the daily cap holds.
 * Exit 0 when every check passes.
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dbPath = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || dbPath.startsWith(path.join(APP, "data")) || dbPath.startsWith(path.resolve(APP, "..", ".."))) {
  console.error("Give a private database path OUTSIDE the repository (never the factory's own data/factory.db).");
  process.exit(2);
}
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
process.env.FACTORY_DATABASE_URL = `file:${dbPath}`;
execFileSync("npx", ["prisma", "migrate", "deploy"], { cwd: APP, env: process.env, stdio: ["ignore", "ignore", "inherit"] });

const { prisma } = await import("../../src/lib/db");
const { seedSystemRoles } = await import("../../src/lib/auth/seed-roles");
const { createAccessToken, revokeAccessToken } = await import("../../src/lib/claude/tokens");

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.error(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures.push(what);
};

// ── a small factory ──────────────────────────────────────────────────────────────────────────────────
await seedSystemRoles();
const roles = Object.fromEntries((await prisma.role.findMany({ take: 10 })).map((r) => [r.key, r.id]));
const person = async (name: string, role: string) => {
  const user = await prisma.user.create({ data: { email: `${name.toLowerCase()}@example.test`, displayName: name, passwordHash: "x" } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: roles[role] } });
  return user;
};
const owner = await person("Olga Owner", "OWNER");
const worker = await person("Walter Worker", "WORKER");
const customer = await prisma.party.create({ data: { kind: "CUSTOMER", name: "Test Moto Club", currency: "EUR" } as never });
const supplier = await prisma.party.create({ data: { kind: "SUPPLIER", name: "Test Hides Srl", currency: "EUR" } as never });
const order = await prisma.order.create({
  data: { number: "ORD-T1", partyId: customer.id, state: "IN_PRODUCTION", promiseDateAt: new Date(Date.now() - 86_400_000) } as never,
});
await prisma.orderLine.create({ data: { orderId: order.id, description: "Race suit", qty: 2, netPriceCents: 123456, costCents: 65432 } as never });
const workOrder = await prisma.workOrder.create({ data: { number: "WO-T1", orderId: order.id, state: "IN_PROGRESS" } as never });
for (const [sort, stage] of ["cut", "stitch", "finish"].entries()) {
  await prisma.workOrderStage.create({ data: { workOrderId: workOrder.id, stage, sort, ...(sort === 0 ? { startedAt: new Date(), finishedAt: new Date() } : {}) } as never });
}
const material = await prisma.material.create({ data: { name: "Kangaroo hide", unit: "m2", costCents: 4321, reorderLevel: 10 } as never });
await prisma.movementLedger.create({ data: { materialId: material.id, type: "IN", qty: 4, reason: "first delivery" } as never });
await prisma.conversation.create({
  data: { channel: "GMAIL", subject: "Suit sizes", state: "OPEN", partyId: customer.id, lastMessageAt: new Date(), messages: { create: [{ direction: "INBOUND", fromAddress: "rider@example.test", snippet: "Hi, write to rider@example.test please", sentAt: new Date() }] } } as never,
});
await prisma.quote.create({ data: { number: "Q-T1", partyId: customer.id, state: "SENT", sentAt: new Date(), validityWording: "30 days" } as never });

const ownerToken = await createAccessToken({ ownerId: owner.id, userId: owner.id, label: "Owner's Claude", scopes: "read,draft", days: 30 });
const workerToken = await createAccessToken({ ownerId: owner.id, userId: worker.id, label: "Floor Claude", scopes: "read,draft", days: 30 });
const revoked = await createAccessToken({ ownerId: owner.id, userId: owner.id, label: "Old", scopes: "read", days: 30 });
await revokeAccessToken(revoked.token.id, owner.id);
const expired = await createAccessToken({ ownerId: owner.id, userId: owner.id, label: "Expired", scopes: "read", days: 1 });
await prisma.factoryAccessToken.update({ where: { id: expired.token.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
await prisma.$disconnect();

// ── the server, over stdio ───────────────────────────────────────────────────────────────────────────
type Rpc = { id?: number; result?: any; error?: { message: string } };
function startServer(env: Record<string, string>) {
  const child = spawn("npx", ["tsx", "mcp/server.ts"], { cwd: APP, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const waiting = new Map<number, (message: Rpc) => void>();
  const nonProtocol: string[] = [];
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    let newline: number;
    while ((newline = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as Rpc;
        if (message.id != null) waiting.get(message.id)?.(message);
      } catch {
        nonProtocol.push(line);
      }
    }
  });
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  let nextId = 1;
  const request = (method: string, params: unknown = {}) =>
    new Promise<Rpc>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}: ${stderr.slice(-400)}`)), 20_000);
      waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const exited = new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? -1)));
  return {
    request,
    exited,
    stderr: () => stderr,
    nonProtocol,
    async open() {
      const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-mcp-verify", version: "1" } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      return init;
    },
    async call(name: string, args: Record<string, unknown> = {}) {
      const answer = await request("tools/call", { name, arguments: args });
      const text = answer.result?.content?.[0]?.text ?? answer.error?.message ?? "";
      let data: any = null;
      try { data = JSON.parse(text); } catch { data = text; }
      return { isError: !!answer.result?.isError || !!answer.error, data, text };
    },
    close() { child.stdin.end(); child.kill(); },
  };
}

const base = { FACTORY_DATABASE_URL: `file:${dbPath}`, FACTORY_RBAC_MODE: "enforce" };

// Refusals at start.
for (const [what, env, needle] of [
  ["RBAC shadow mode", { ...base, FACTORY_RBAC_MODE: "shadow", FACTORY_MCP_TOKEN: ownerToken.raw }, "shadow mode"],
  ["a revoked token", { ...base, FACTORY_MCP_TOKEN: revoked.raw }, "revoked"],
  ["an expired token", { ...base, FACTORY_MCP_TOKEN: expired.raw }, "expired"],
  ["no token", { ...base, FACTORY_MCP_TOKEN: "" }, "FACTORY_MCP_TOKEN"],
] as const) {
  const server = startServer(env as Record<string, string>);
  const code = await server.exited;
  check(code === 1 && server.stderr().includes(needle), `refuses to start with ${what}`);
}

// The OWNER's connection.
const ownerServer = startServer({ ...base, FACTORY_MCP_TOKEN: ownerToken.raw });
await ownerServer.open();
const ownerTools = ((await ownerServer.request("tools/list")).result?.tools ?? []).map((t: { name: string }) => t.name).sort();
const ownerReads = ownerTools.filter((name: string) => !["factory-draft-quote", "factory-draft-purchase-order", "factory-add-comment", "factory-advance-work-order"].includes(name));
check(ownerReads.length === 10, `the owner is offered every read (${ownerReads.join(", ")})`);
const overview = await ownerServer.call("factory-overview");
check(!overview.isError && overview.data.orders?.lateOpen === 1 && overview.data.materials?.low === 1, "factory-overview counts orders, late ones and low materials");
const ownOrder = await ownerServer.call("factory-order", { order: "ORD-T1" });
check(!ownOrder.isError && ownOrder.data.lines?.[0]?.costCents === 65432 && ownOrder.data.lines?.[0]?.netPriceCents === 123456, "the owner sees the order's prices and costs");
check((await ownerServer.call("factory-order", { order: "ORD-NONE" })).data?.error === "Order not found", "an unknown order is not found");
const thread = await ownerServer.call("factory-inbox");
check(!thread.isError && !thread.text.includes("rider@example.test") && thread.text.includes("[e-mail]"), "the inbox shows summaries without e-mail addresses");
for (const name of ["factory-orders", "factory-quotes", "factory-production", "factory-materials", "factory-shipments", "factory-financials", "factory-analytics"]) {
  const answer = await ownerServer.call(name);
  check(!answer.isError, `${name} answers the owner`);
}
check((await ownerServer.call("factory-orders", { limit: 500 })).data?.error?.includes("called wrongly"), "a wrongly made call is refused by the tool's schema");

// The WORKER's connection: production, materials and drafts only; no money.
const workerServer = startServer({ ...base, FACTORY_MCP_TOKEN: workerToken.raw });
await workerServer.open();
const workerTools = ((await workerServer.request("tools/list")).result?.tools ?? []).map((t: { name: string }) => t.name).sort();
check(JSON.stringify(workerTools.filter((n: string) => !n.includes("draft") && !n.includes("comment") && !n.includes("advance"))) === JSON.stringify(["factory-materials", "factory-overview", "factory-production"]), `the worker is offered production, materials and the overview to read (${workerTools.join(", ")})`);
const workerMaterials = await workerServer.call("factory-materials");
check(!workerMaterials.isError && !workerMaterials.text.includes("costCents") && !workerMaterials.text.includes("4321"), "the worker sees no material cost");
const workerOverview = await workerServer.call("factory-overview");
check(!workerOverview.isError && workerOverview.data.orders === undefined && workerOverview.data.workOrders !== undefined, "the worker's overview counts only what their pages show");
const notOffered = await workerServer.call("factory-orders");
check(notOffered.isError, "a tool not offered to the worker cannot be called");
workerServer.close();

// ── P12: drafts stay drafts ───────────────────────────────────────────────────────────────────────────
const { prisma: again } = await import("../../src/lib/db");
const DRAFTS = ["factory-add-comment", "factory-advance-work-order", "factory-draft-purchase-order", "factory-draft-quote"];
check(DRAFTS.every((name) => ownerTools.includes(name)), "the owner's read-and-draft connection is offered the four drafts");
const quote = await ownerServer.call("factory-draft-quote", { customer: "test moto club", lines: [{ description: "Race suit, size 52" }, { description: "Gloves" }] });
const storedQuote = !quote.isError ? await again.quote.findUnique({ where: { id: quote.data.quote.id }, include: { lines: true } }) : null;
check(!quote.isError && storedQuote?.state === "DRAFT" && storedQuote.sentAt === null && storedQuote.lines.length === 2 && storedQuote.lines.every((l) => l.description?.startsWith("(from Claude) ")), "factory-draft-quote makes a DRAFT quote with its lines, never sent");
const po = await ownerServer.call("factory-draft-purchase-order", { supplier: "Test Hides Srl", lines: [{ material: "kangaroo hide", qty: 5, unitCostCents: 4000 }] });
const storedPo = !po.isError ? await again.purchaseOrder.findUnique({ where: { id: po.data.purchaseOrder.id } }) : null;
check(!po.isError && storedPo?.state === "DRAFT" && JSON.stringify(storedPo.lines).includes('"unit":"m2"'), "factory-draft-purchase-order makes a DRAFT purchase order in the material's unit");
check((await ownerServer.call("factory-draft-quote", { customer: "Nobody Ltd" })).data?.error?.includes("not found"), "a draft for an unknown customer is refused");
const comment = await ownerServer.call("factory-add-comment", { on: "order", ref: "ORD-T1", body: "Please check the sizes" });
const storedComment = !comment.isError ? await again.comment.findUnique({ where: { id: comment.data.comment.id } }) : null;
check(!comment.isError && storedComment?.body === "(from Claude) Please check the sizes" && storedComment.authorId === owner.id, "factory-add-comment adds an internal comment, marked as from Claude");
const started = await ownerServer.call("factory-advance-work-order", { workOrder: "WO-T1", action: "start" });
check(!started.isError && started.data.stage === "stitch", "factory-advance-work-order starts the current stage (stitch)");
const finished = await ownerServer.call("factory-advance-work-order", { workOrder: "WO-T1", action: "finish" });
check(!finished.isError && finished.data.stage === "stitch" && finished.data.workOrderDone === false, "and finishes it, forward only");
const notStarted = await ownerServer.call("factory-advance-work-order", { workOrder: "WO-T1", action: "finish" });
check(notStarted.isError && notStarted.text.includes("finish"), "finishing a stage that has not started is refused, as on the floor");
check(!(await again.quote.findFirst({ where: { sentAt: { not: null }, number: { not: "Q-T1" } } })) && (await again.purchaseOrder.count({ where: { state: { not: "DRAFT" } } })) === 0, "nothing was sent: no quote or purchase order left its draft");

// A read-only connection is offered no draft; the worker drafts comments and stage moves only.
const readOnly = await createAccessToken({ ownerId: owner.id, userId: owner.id, label: "Read only", scopes: "read", days: 7 });
const readServer = startServer({ ...base, FACTORY_MCP_TOKEN: readOnly.raw });
await readServer.open();
const readTools = ((await readServer.request("tools/list")).result?.tools ?? []).map((t: { name: string }) => t.name);
check(!readTools.some((name: string) => DRAFTS.includes(name)), "a read-only connection is offered no draft");
check((await readServer.call("factory-draft-quote", { customer: "Test Moto Club" })).isError, "and cannot call one");
readServer.close();
check(JSON.stringify(workerTools.filter((n: string) => DRAFTS.includes(n))) === JSON.stringify(["factory-add-comment", "factory-advance-work-order"]), "the worker may comment and move stages, not draft quotes or purchase orders");

// The daily cap: 100 drafts a connection a day.
await again.auditLog.createMany({ data: Array.from({ length: 100 }, () => ({ actorId: owner.id, entityType: "claude", entityId: ownerToken.token.id, action: "claude.factory-add-comment" })) });
const capped = await ownerServer.call("factory-add-comment", { on: "order", ref: "ORD-T1", body: "one more" });
check(capped.isError && capped.text.includes("drafts today"), "the 101st draft of the day is refused");
check(!(await ownerServer.call("factory-overview")).isError, "reads go on after the cap");

// Revoked mid-session: the very next call is refused.
await again.factoryAccessToken.update({ where: { id: ownerToken.token.id }, data: { revokedAt: new Date() } });
const afterRevoke = await ownerServer.call("factory-overview");
check(afterRevoke.isError && afterRevoke.text.includes("revoked"), "a connection revoked mid-session is refused on its next call");
ownerServer.close();
check(ownerServer.nonProtocol.length === 0, `stdout carries protocol messages only (${ownerServer.nonProtocol.slice(0, 2).join(" | ")})`);

const audits = await again.auditLog.count({ where: { entityType: "claude", action: { startsWith: "claude.factory-" } } });
check(audits >= 12, `every call is audited (${audits} rows)`);
await again.$disconnect();

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.error("\nall checks passed");
process.exit(0);
