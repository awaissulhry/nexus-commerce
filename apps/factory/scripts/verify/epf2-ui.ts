/**
 * EPF2 — headless UI verification for /financials (PLAYBOOK §10: never :3100;
 * the Owner must never catch a visual defect). Self-contained:
 *   1. builds a SCRATCH SQLite fixture DB (refuses any path without
 *      "epf2-scratch"): 3 named orders (deposit-gated + blocked WO, cancelled
 *      with money, invoiced + part-paid) + 240 bulk orders across 14 months
 *      (20 OUTSIDE the 12-month default window) + an OWNER session minted the
 *      seed-scale way (raw token → sha256 Session row);
 *   2. starts the .next-verify build on :3199 against it;
 *   3. drives Playwright (apps/web createRequire trick) at 1512/1728/1920:
 *      no horizontal overflow · tiles/tabs/grids render fixture data · ?o=
 *      deep link opens the drawer · date/party/month/All-time round-trip the
 *      URL · skeleton (never the false empty state) under a throttled first
 *      load · keyboard map (1-4, /) · Back closes the drawer — and
 *      screenshots EVERY surface (tabs, drawers, all modals, import diff);
 *   4. kills the server and deletes the scratch DB. No live sends, no writes
 *      confirmed through any money dialog.
 *
 * Run (from apps/factory):  npx tsx scripts/verify/epf2-ui.ts [shotsDir]
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = process.cwd();
if (!fs.existsSync(path.join(ROOT, "next.config.js")) || !/apps\/factory$/.test(ROOT.replace(/\\/g, "/"))) {
  throw new Error(`run from apps/factory (cwd=${ROOT})`);
}
const SHOTS = path.resolve(process.argv[2] ?? path.join(ROOT, "data", "epf2-shots"));
const DB_FILE = path.join(ROOT, "data", "epf2-scratch.db");
const DB_URL = `file:${DB_FILE}`;
if (!DB_FILE.includes("epf2-scratch")) throw new Error("refusing: scratch DB path must contain epf2-scratch");
const BASE = "http://localhost:3199";
const DAY = 86_400_000;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const results: string[] = [];
const failures: string[] = [];
function ok(name: string, cond: unknown, extra = "") {
  if (cond) results.push(`PASS  ${name}`);
  else failures.push(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
}

function rmScratch() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = DB_FILE + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

async function seed(): Promise<string> {
  rmScratch();
  execSync("npx prisma migrate deploy", { cwd: ROOT, env: { ...process.env, FACTORY_DATABASE_URL: DB_URL }, stdio: "pipe" });
  process.env.FACTORY_DATABASE_URL = DB_URL;
  const { prisma, factoryDbUrl } = await import("../../src/lib/db");
  if (!factoryDbUrl().includes("epf2-scratch")) throw new Error(`refusing to seed ${factoryDbUrl()}`);
  const { seedSystemRoles } = await import("../../src/lib/auth/seed-roles");
  await seedSystemRoles({ bumpVersions: false });
  const ownerRole = (await prisma.role.findFirst({ where: { key: "OWNER" } }))!;

  const now = Date.now();
  await prisma.user.create({ data: { id: "eu-owner", email: "epf2-verify@factory.test", displayName: "EPF2 Verify Owner", passwordHash: "x-unused", status: "active" } });
  await prisma.userRole.create({ data: { id: "eur-owner", userId: "eu-owner", roleId: ownerRole.id } });
  const token = randomBytes(24).toString("hex");
  await prisma.session.create({ data: { userId: "eu-owner", tokenHash: sha256(token), idleExpiry: new Date(now + 7 * DAY), absoluteExpiry: new Date(now + 7 * DAY) } });

  await prisma.appSetting.upsert({ where: { key: "financials.defaults" }, create: { key: "financials.defaults", value: { vatRatePct: 22 } }, update: { value: { vatRatePct: 22 } } });
  await prisma.appSetting.upsert({ where: { key: "factory.name" }, create: { key: "factory.name", value: { name: "Nexus Factory (verify)" } }, update: {} });
  await prisma.priceList.upsert({ where: { id: "epl-default" }, create: { id: "epl-default", kind: "DEFAULT", name: "Listino base" }, update: {} });

  await prisma.party.createMany({
    data: [
      { id: "ep-awa", kind: "BRAND", name: "AWA Racing", priceListId: "epl-default" },
      { id: "ep-brembo", kind: "BRAND", name: "Brembo Leathers", priceListId: "epl-default" },
      { id: "ep-rossi", kind: "CUSTOMER", name: "Rossi Custom", priceListId: "epl-default" },
    ],
  });

  // A — deposit-gated (FD13): 30% of €1000 owed, WO BLOCKED awaiting it
  await prisma.quote.create({ data: { id: "eq-dep", number: "Q-9001", partyId: "ep-awa", state: "ACCEPTED", depositPct: 30 } });
  await prisma.order.create({ data: { id: "eo-dep", number: "ORD-9001", partyId: "ep-awa", bornFromQuoteId: "eq-dep", state: "CONFIRMED", createdAt: new Date(now - 20 * DAY) } });
  await prisma.orderLine.create({ data: { id: "eol-dep", orderId: "eo-dep", description: "Kangaroo Suit size 52", qty: 1, netPriceCents: 100_000, costCents: 40_000 } });
  await prisma.workOrder.create({ data: { id: "ewo-dep", number: "ORD-9001/1", orderId: "eo-dep", orderLineId: "eol-dep", state: "BLOCKED", blockedReason: "awaiting deposit" } });

  // B — cancelled WITH money (D-04 bucket): €240 deposit stranded
  await prisma.order.create({ data: { id: "eo-cxl", number: "ORD-9002", partyId: "ep-brembo", state: "CANCELLED", createdAt: new Date(now - 60 * DAY) } });
  await prisma.orderLine.create({ data: { id: "eol-cxl", orderId: "eo-cxl", description: "Gp Jacket size 50", qty: 1, netPriceCents: 80_000, costCents: 30_000 } });
  await prisma.payment.create({ data: { id: "epay-cxl", orderId: "eo-cxl", kind: "DEPOSIT", amountCents: 24_000, method: "bank", receivedAt: new Date(now - 55 * DAY) } });

  // C — invoiced + part-paid: net 1500, invoice 1500 sent, paid 450+500 → balance 550;
  // Mark-paid of the full invoice must 409 with overpayCents (450+500+1500 − 1500)
  await prisma.order.create({ data: { id: "eo-main", number: "ORD-9003", partyId: "ep-rossi", state: "DELIVERED", createdAt: new Date(now - 10 * DAY) } });
  await prisma.orderLine.create({ data: { id: "eol-main", orderId: "eo-main", description: "Airbag Suit size 54", qty: 1, netPriceCents: 150_000, costCents: 60_000 } });
  await prisma.invoice.create({ data: { id: "ei-main", orderId: "eo-main", number: "INV-2026-901", amountCents: 150_000, sentAt: new Date(now - 5 * DAY), createdAt: new Date(now - 6 * DAY) } });
  await prisma.payment.createMany({
    data: [
      { id: "epay-m1", orderId: "eo-main", kind: "DEPOSIT", amountCents: 45_000, method: "bank", receivedAt: new Date(now - 8 * DAY) },
      { id: "epay-m2", orderId: "eo-main", kind: "BALANCE", amountCents: 50_000, method: "bank", receivedAt: new Date(now) }, // this Rome month → "Paid this month" > 0
    ],
  });

  // bulk — 220 inside the 12-month window (Load-more crosses the 200-row page)
  // + 20 outside it (visible only under All time). Parties: brembo/rossi only,
  // so ?party=ep-awa isolates ORD-9001 exactly.
  const states = ["CONFIRMED", "IN_PRODUCTION", "SHIPPED", "DELIVERED", "CLOSED"];
  const orders: object[] = [];
  const lines: object[] = [];
  const invoices: object[] = [];
  const payments: object[] = [];
  for (let i = 0; i < 240; i++) {
    const inside = i < 220;
    const createdAt = new Date(now - (inside ? (i + 2) * 1.5 * DAY : (400 + (i - 220)) * DAY));
    const id = `eo-b${i}`;
    const net = 30_000 + i * 10;
    orders.push({ id, number: `ORD-8${String(i).padStart(3, "0")}`, partyId: i % 2 === 0 ? "ep-brembo" : "ep-rossi", state: states[i % states.length], createdAt });
    lines.push({ id: `eol-b${i}`, orderId: id, description: `Rain Jacket ${i}`, qty: 1, netPriceCents: net, costCents: 12_000 });
    if (i % 5 === 0) invoices.push({ id: `ei-b${i}`, orderId: id, number: `INV-2026-1${String(i).padStart(3, "0")}`, amountCents: net, createdAt: new Date(createdAt.getTime() + DAY) });
    if (i % 3 === 0) payments.push({ id: `epay-b${i}`, orderId: id, kind: "BALANCE", amountCents: Math.floor(net / 2), method: "bank", receivedAt: new Date(createdAt.getTime() + 2 * DAY) });
  }
  await prisma.order.createMany({ data: orders as never });
  await prisma.orderLine.createMany({ data: lines as never });
  await prisma.invoice.createMany({ data: invoices as never });
  await prisma.payment.createMany({ data: payments as never });
  await prisma.$disconnect();
  return token;
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${BASE}/api/auth/csrf`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server on :3199 never became ready");
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  try { execSync("lsof -ti :3199 | xargs kill -9", { stdio: "ignore" }); } catch { /* port already free */ }

  console.log("[epf2-ui] seeding scratch DB…");
  const token = await seed();

  console.log("[epf2-ui] starting :3199 (.next-verify)…");
  const server: ChildProcess = spawn("npx", ["next", "start", "-p", "3199"], {
    cwd: ROOT,
    env: { ...process.env, FACTORY_BUILD_DIR: ".next-verify", FACTORY_DATABASE_URL: DB_URL },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout?.on("data", (d) => { serverLog += String(d); });
  server.stderr?.on("data", (d) => { serverLog += String(d); });

  // Playwright lives in apps/web (PLAYBOOK trap 12) — createRequire trick
  const require2 = createRequire(path.join(ROOT, "..", "web", "package.json"));
  const { chromium } = require2("@playwright/test");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- playwright is untyped here by design (apps/web owns the dep)
  let browser: any = null;

  try {
    await waitForServer();
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1728, height: 1000 } });
    await context.addCookies([
      { name: "factory_session", value: token, url: BASE },
      { name: "factory_csrf", value: "epf2-verify-csrf", url: BASE },
    ]);
    const page = await context.newPage();
    // drawers/modals slide in over 0.18s — screenshots must show the SETTLED UI
    const settle = async () => {
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".h10-ds-drawer, .h10-ds-modal")].every((el) => el.getAnimations().every((a) => a.playState !== "running")),
      );
      await page.waitForTimeout(60);
    };
    const shot = async (name: string, fullPage = false) => { await settle(); await page.screenshot({ path: path.join(SHOTS, name), fullPage }); };
    const search = () => page.evaluate(() => window.location.search);

    // ── widths: overflow + render at 1512 / 1728 / 1920 ────────────
    for (const width of [1512, 1728, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${BASE}/financials`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".h10-ds-grid tbody tr", { timeout: 20_000 });
      const m = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        iw: window.innerWidth,
        metrics: document.querySelectorAll(".h10-ds-metric").length,
        tabs: document.querySelectorAll("[role='tab']").length,
        rows: document.querySelectorAll(".h10-ds-grid tbody tr").length,
      }));
      ok(`no horizontal overflow @${width}`, m.sw <= m.iw, `scrollWidth ${m.sw} > innerWidth ${m.iw}`);
      ok(`tiles render @${width} (5th cancelled tile expected)`, m.metrics === 5, `metrics=${m.metrics}`);
      ok(`tablist ARIA @${width}`, m.tabs === 4, `tabs=${m.tabs}`);
      ok(`orders grid rows @${width}`, m.rows > 10, `rows=${m.rows}`);
      await shot(`orders-tab-${width}.png`);
    }
    await page.setViewportSize({ width: 1728, height: 1000 });

    // ── freshness + keyboard "/" ───────────────────────────────────
    ok("freshness line", await page.locator("[data-testid=freshness]").count() === 1);
    await page.keyboard.press("/");
    ok("/ focuses the customer picker", await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Filter by customer"));
    await page.keyboard.press("Escape");

    // ── cancelled-money tile → drawer ──────────────────────────────
    await page.click('[title="See the cancelled orders still carrying money"]');
    await page.waitForSelector(".h10-ds-drawer");
    ok("cancelled bucket drawer", await page.getByText("Cancelled orders with money").count() >= 1);
    ok("cancelled bucket lists ORD-9002", await page.getByText("ORD-9002").count() >= 1);
    await shot("cancelled-drawer.png");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".h10-ds-drawer", { state: "detached" });

    // ── keyboard tabs + by-customer + drill-through ────────────────
    await page.keyboard.press("2");
    await page.waitForFunction(() => window.location.search.includes("tab=party"));
    await page.waitForSelector(".h10-ds-grid tbody tr");
    ok("by-customer renders", await page.getByText("AWA Racing").count() >= 1);
    await shot("party-tab.png");
    await page.getByRole("button", { name: "Rossi Custom" }).first().click();
    await page.waitForFunction(() => window.location.search.includes("party=ep-rossi") && !window.location.search.includes("tab="));
    await page.waitForSelector(".h10-ds-grid tbody tr");
    ok("customer row drills to filtered orders", (await search()).includes("party=ep-rossi"));
    ok("party filter excludes other customers", (await page.getByText("ORD-9001").count()) === 0);
    await shot("party-drill-orders.png");
    await page.click('[title="Clear customer filter"]');
    await page.waitForFunction(() => !window.location.search.includes("party="));

    // ── by-month + month drill (URL date round-trip) ───────────────
    await page.keyboard.press("3");
    await page.waitForFunction(() => window.location.search.includes("tab=month"));
    await page.waitForSelector(".h10-ds-grid tbody tr");
    await shot("month-tab.png");
    await page.locator(".h10-ds-grid tbody tr td button").first().click();
    await page.waitForFunction(() => /from=\d{4}-\d{2}-01/.test(window.location.search) && /to=\d{4}-\d{2}-\d{2}/.test(window.location.search));
    ok("month row drills to a from/to window", true);
    await page.getByRole("button", { name: "Last 12 months" }).click();
    await page.waitForFunction(() => !window.location.search.includes("from="));

    // ── deposits tab + production deep link ────────────────────────
    await page.keyboard.press("4");
    await page.waitForFunction(() => window.location.search.includes("tab=deposits"));
    await page.waitForSelector(".h10-ds-grid tbody tr");
    ok("deposits row (FD13)", await page.getByText("ORD-9001").count() >= 1);
    ok("blocked pill deep-links /production?wo=", await page.locator('a[href*="/production?wo="]').count() >= 1);
    await shot("deposits-tab.png");
    await page.keyboard.press("1");
    await page.waitForFunction(() => !window.location.search.includes("tab="));

    // ── All-time toggle + Load-more (cursor) ───────────────────────
    const countBefore = await page.locator(".h10-ds-toolbar .cnt").innerText();
    ok("default window bounds the fold (222 in 12mo)", countBefore.includes("222"), countBefore);
    await page.getByRole("button", { name: "All time" }).click();
    await page.waitForFunction(() => window.location.search.includes("range=all"));
    await page.waitForFunction(() => (document.querySelector(".h10-ds-toolbar .cnt") as HTMLElement | null)?.innerText.includes("242") ?? false, undefined, { timeout: 15_000 });
    ok("All-time widens the window (242 orders)", true);
    await shot("alltime-orders.png");
    const loadMore = page.locator("button", { hasText: "Load more orders" });
    ok("Load more control present", (await loadMore.count()) === 1);
    await loadMore.click();
    // the count line is the honest assert — the DOM itself stays windowed (FS3)
    await page.waitForFunction(() => /1–242/.test((document.querySelector(".h10-ds-toolbar .cnt") as HTMLElement | null)?.innerText ?? ""), undefined, { timeout: 15_000 });
    ok("cursor page appended (1–242 of 242)", true);
    await page.getByRole("button", { name: "Last 12 months" }).click();
    await page.waitForFunction(() => !window.location.search.includes("range=all"));

    // ── DateField writes the URL ───────────────────────────────────
    await page.locator(".h10-ds-datefield").first().locator("button").first().click();
    await page.waitForSelector(".h10-ds-dp-pop");
    await page.locator("button.h10-ds-dp-day", { hasText: /^15$/ }).first().click();
    await page.waitForFunction(() => /from=\d{4}-\d{2}-15/.test(window.location.search));
    ok("date picker round-trips the URL (?from=…-15)", true);
    await page.getByRole("button", { name: "Last 12 months" }).click();

    // ── ?o= deep link + drawer + VAT line ──────────────────────────
    await page.goto(`${BASE}/financials?o=eo-main`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".h10-ds-drawer");
    await page.waitForSelector("[data-testid=vat-line]");
    ok("?o= deep link opens the drawer", await page.getByText("Money · ORD-9003").count() >= 1);
    ok("VAT/gross display line", (await page.locator("[data-testid=vat-line]").innerText()).includes("22%"));
    ok("all-figures-EUR caption", await page.getByText("All figures EUR").count() >= 1);
    await shot("money-drawer.png");

    // ── New invoice consequence modal (no write) ───────────────────
    await page.getByRole("button", { name: "New invoice" }).click();
    await page.waitForSelector(".h10-ds-modal");
    ok("invoice modal previews INV-2026-…", await page.getByText("INV-2026-…").count() >= 1);
    const amountVal = await page.locator(".h10-ds-modal input").first().inputValue();
    ok("invoice default = net − paid (550.00)", amountVal === "550.00", `got ${amountVal}`);
    await shot("invoice-confirm.png");
    await page.locator(".h10-ds-modal").getByRole("button", { name: "Cancel" }).click();
    await page.waitForSelector(".h10-ds-modal", { state: "detached" });

    // ── Mark paid → consequence → 409 overpay escalation (no write) ─
    await page.locator(".h10-ds-drawer").getByRole("button", { name: "Mark paid" }).first().click();
    await page.waitForSelector(".h10-ds-modal");
    ok("mark-paid states the BALANCE payment", await page.getByText(/Records a/).count() >= 1);
    await shot("markpaid-confirm.png");
    await page.locator(".h10-ds-modal").getByRole("button", { name: "Mark paid" }).click();
    await page.waitForSelector("[data-testid=overpay-confirm]");
    ok("409 escalates to the explicit overpay confirm", await page.getByText("Record overpayment").count() >= 1);
    await shot("markpaid-overpay.png");
    await page.locator(".h10-ds-modal").getByRole("button", { name: "Cancel" }).click();
    await page.waitForSelector(".h10-ds-modal", { state: "detached" });

    // ── Payment modal: BALANCE default here, REFUND state (no write)
    await page.getByRole("button", { name: "Record payment" }).click();
    await page.waitForSelector(".h10-ds-modal");
    ok("kind defaults BALANCE (no gate on ORD-9003)", await page.locator(".h10-ds-modal").getByText("Balance", { exact: true }).count() >= 1);
    await shot("payment-modal.png");
    await page.locator(".h10-ds-modal .h10-ds-listbox-btn").first().click();
    await page.getByRole("option", { name: "Refund (money back)" }).click();
    await page.locator(".h10-ds-modal textarea").waitFor();
    ok("REFUND shows its consequence + note field", (await page.locator("[data-testid=payment-consequence]").innerText()).includes("REFUND"));
    await shot("payment-modal-refund.png");
    await page.locator(".h10-ds-modal").getByRole("button", { name: "Cancel" }).click();
    await page.waitForSelector(".h10-ds-modal", { state: "detached" });

    // ── FD13: kind defaults DEPOSIT while the gate is open ─────────
    await page.goto(`${BASE}/financials?o=eo-dep`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".h10-ds-drawer");
    await page.waitForSelector("[data-testid=vat-line]");
    await page.getByRole("button", { name: "Record payment" }).click();
    await page.waitForSelector(".h10-ds-modal");
    // the default lands via a post-mount effect — wait for the trigger to read "Deposit"
    const sawDeposit = await page.locator(".h10-ds-modal .h10-ds-listbox-btn").getByText("Deposit", { exact: true }).waitFor({ timeout: 3_000 }).then(() => true).catch(() => false);
    ok("kind defaults DEPOSIT while the FD13 gate is open", sawDeposit);
    await shot("payment-modal-deposit.png");
    await page.locator(".h10-ds-modal").getByRole("button", { name: "Cancel" }).click();
    await page.waitForSelector(".h10-ds-modal", { state: "detached" });
    await page.keyboard.press("Escape");

    // ── Back closes the drawer (pushState idiom) ───────────────────
    await page.goto(`${BASE}/financials`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".h10-ds-grid tbody tr");
    await page.getByRole("button", { name: "ORD-9003" }).first().click();
    await page.waitForSelector(".h10-ds-drawer");
    await page.goBack();
    await page.waitForSelector(".h10-ds-drawer", { state: "detached" });
    ok("browser Back closes the drawer", !(await search()).includes("o="));

    // ── Import: dropzone + paste → diff → apply-confirm (no write) ─
    await page.getByRole("button", { name: "Import bank CSV" }).click();
    await page.waitForSelector(".h10-ds-modal");
    ok("import offers a FileDropzone", await page.locator(".h10-ds-modal .h10-ds-dropzone").count() >= 1);
    await shot("import-dropzone.png");
    await page.locator(".h10-ds-modal textarea").fill("date,amount,description\n2026-07-10,550.00,Bonifico ORD-9003\n2026-07-11,123.00,Unknown transfer");
    await page.locator(".h10-ds-modal").getByRole("button", { name: "Match" }).click();
    await page.waitForSelector(".h10-ds-modal input[type=checkbox]");
    ok("dry-run matches ORD-9003 high", await page.locator(".h10-ds-modal").getByText("ORD-9003").count() >= 1);
    ok("fingerprint note shown", await page.locator(".h10-ds-modal").getByText(/fingerprinted/).count() >= 1);
    await shot("import-diff.png");
    await page.locator(".h10-ds-modal").getByRole("button", { name: /Apply 1 selected/ }).click();
    await page.waitForSelector("[data-testid=import-confirm]");
    await shot("import-apply-confirm.png");
    await page.locator(".h10-ds-modal").getByRole("button", { name: "Back" }).click(); // review
    await page.locator(".h10-ds-modal").getByRole("button", { name: "Back" }).click(); // input
    await page.locator(".h10-ds-modal").getByRole("button", { name: "Cancel" }).click();
    await page.waitForSelector(".h10-ds-modal", { state: "detached" });

    // ── Export confirm states the current view ─────────────────────
    await page.getByRole("button", { name: "Export period" }).click();
    await page.waitForSelector("[data-testid=export-confirm]");
    ok("export confirm names the window", (await page.locator("[data-testid=export-confirm]").innerText()).includes("Last 12 months"));
    await shot("export-confirm.png");
    await page.locator(".h10-ds-modal").getByRole("button", { name: "Cancel" }).click();

    // ── throttled first load: SKELETON, never the false empty state ─
    const page2 = await context.newPage();
    await page2.route("**/api/financials**", async (route: { continue: () => Promise<void> }) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });
    await page2.goto(`${BASE}/financials`, { waitUntil: "domcontentloaded" });
    await page2.waitForSelector("[data-testid=grid-skeleton]", { timeout: 2_400 });
    const bodyText = await page2.evaluate(() => document.body.innerText);
    ok("throttled load shows skeleton (D-08)", true);
    ok("no false empty-state during load", !bodyText.includes("No orders in this window"));
    await page2.screenshot({ path: path.join(SHOTS, "skeleton-throttled.png") });
    await page2.waitForSelector(".h10-ds-grid tbody tr", { timeout: 20_000 });
    await page2.close();
  } finally {
    await browser?.close().catch(() => {});
    server.kill("SIGTERM");
    try { execSync("lsof -ti :3199 | xargs kill -9", { stdio: "ignore" }); } catch { /* gone */ }
    rmScratch();
    if (failures.length > 0) {
      console.error("\n----- server log tail -----\n" + serverLog.split("\n").slice(-30).join("\n"));
    }
  }

  console.log(`\n[epf2-ui] screenshots → ${SHOTS}`);
  for (const r of results) console.log(r);
  for (const f of failures) console.error(f);
  console.log(`\n[epf2-ui] ${results.length} passed · ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  try { execSync("lsof -ti :3199 | xargs kill -9", { stdio: "ignore" }); } catch { /* gone */ }
  rmScratch();
  process.exit(1);
});
