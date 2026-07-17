/**
 * EPQ.5 — Italy/EU compliance pass: per-mode tax rendering (pure snapshot-
 * builder outputs), VIES gate logic + SOAP parse, deposit-kind wording,
 * validity wording, CGV empty-safety, evidence-bundle shape, gross-total
 * math, and the Stripe webhook signature check. Parity is pinned explicitly:
 * IT_B2B keeps its net figures (the display gains the IVA line), while B2C
 * documents CHANGE to gross-first — that is the bug fix, stated, not hidden.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildTaxBreakdown,
  defaultTaxModeForKind,
  depositBaseCents,
  effectiveTaxMode,
  grossCents,
  naturaForMode,
  resolveTaxMode,
  viesOk,
} from "../quotes/tax";
import {
  CAPARRA_B2C_SYMMETRIC_CLAUSE,
  B2C_BESPOKE_CLAUSE,
  cgvIsSet,
  cgvLine,
  depositClauseLines,
  depositPdfLabel,
  normalizeDepositKind,
  normalizeValidityWording,
  validityLine,
  withCgvDefaults,
} from "../quotes/legal";
import { buildEvidenceBundle } from "../quotes/evidence";
import { shapeSnapshotCompliance } from "../quotes/build-snapshot";
import { buildCheckVatApproxEnvelope, parseViesResponse, splitVat } from "../vies";
import { parseStripeSignature, verifyStripeSignature } from "../stripe";

// ── tax modes ────────────────────────────────────────────────────

describe("resolveTaxMode", () => {
  it("defaults CUSTOMER to IT_B2C and BRAND to IT_B2B (party-kind parity rule)", () => {
    expect(defaultTaxModeForKind("CUSTOMER")).toBe("IT_B2C");
    expect(defaultTaxModeForKind("BRAND")).toBe("IT_B2B");
    expect(resolveTaxMode(null, "CUSTOMER")).toBe("IT_B2C");
    expect(resolveTaxMode(undefined, "BRAND")).toBe("IT_B2B");
  });
  it("a stored mode wins over the kind default; junk falls back", () => {
    expect(resolveTaxMode("EXTRA_EU", "CUSTOMER")).toBe("EXTRA_EU");
    expect(resolveTaxMode("EU_B2B", "BRAND")).toBe("EU_B2B");
    expect(resolveTaxMode("NOT_A_MODE", "CUSTOMER")).toBe("IT_B2C");
  });
  it("natura codes: N3.2 for art. 41, N3.1 for art. 8, none domestically", () => {
    expect(naturaForMode("EU_B2B")).toBe("N3.2");
    expect(naturaForMode("EXTRA_EU")).toBe("N3.1");
    expect(naturaForMode("IT_B2C")).toBeNull();
    expect(naturaForMode("IT_B2B")).toBeNull();
  });
});

describe("buildTaxBreakdown", () => {
  const lines = [{ unitNetCents: 54000, qty: 2 }, { unitNetCents: 10000, qty: 1 }]; // net 118000

  it("IT_B2C is GROSS-FIRST: headline includes IVA, per-unit rounding sums exactly", () => {
    const t = buildTaxBreakdown(lines, "IT_B2C", 22, false);
    expect(t.grossFirst).toBe(true);
    expect(t.imponibileCents).toBe(118000);
    expect(t.unitGrossCents).toEqual([65880, 12200]); // round(unit × 1.22)
    expect(t.lineGrossCents).toEqual([131760, 12200]); // unit gross × qty — recomputable by the customer
    expect(t.totaleCents).toBe(143960); // Σ line gross
    expect(t.ivaCents).toBe(143960 - 118000); // derived, so everything sums
    expect(t.natura).toBeNull();
  });
  it("IT_B2C per-unit rounding stays consistent on awkward rates", () => {
    const t = buildTaxBreakdown([{ unitNetCents: 3333, qty: 3 }], "IT_B2C", 22, false);
    expect(grossCents(3333, 22)).toBe(4066); // 4066.26 → 4066
    expect(t.lineGrossCents).toEqual([4066 * 3]);
    expect(t.totaleCents).toBe(12198);
    expect(t.ivaCents).toBe(12198 - 9999);
  });
  it("IT_B2B keeps net figures and adds the explicit IVA line + gross total", () => {
    const t = buildTaxBreakdown(lines, "IT_B2B", 22, false);
    expect(t.grossFirst).toBe(false);
    expect(t.imponibileCents).toBe(118000); // net UNCHANGED — B2B parity
    expect(t.ivaCents).toBe(25960); // 22% on the base
    expect(t.totaleCents).toBe(143960);
    expect(t.note).toBeNull();
  });
  it("EU_B2B with a valid VIES proof is non-imponibile art. 41 with natura N3.2", () => {
    const t = buildTaxBreakdown(lines, "EU_B2B", 22, true);
    expect(t.ivaCents).toBe(0);
    expect(t.totaleCents).toBe(118000);
    expect(t.note).toContain("art. 41");
    expect(t.natura).toBe("N3.2");
    expect(t.viesFallback).toBe(false);
  });
  it("EU_B2B WITHOUT a VIES proof falls back to IT_B2B rendering, flagged", () => {
    const t = buildTaxBreakdown(lines, "EU_B2B", 22, false);
    expect(t.mode).toBe("IT_B2B");
    expect(t.viesFallback).toBe(true);
    expect(t.ivaCents).toBe(25960);
    expect(t.note).toBeNull();
    expect(t.natura).toBeNull();
  });
  it("EXTRA_EU is non-imponibile art. 8 with natura N3.1, no VIES needed", () => {
    const t = buildTaxBreakdown(lines, "EXTRA_EU", 22, false);
    expect(t.ivaCents).toBe(0);
    expect(t.note).toContain("art. 8");
    expect(t.natura).toBe("N3.1");
  });
  it("deposit base: gross for B2C (the fix), net for everyone else (unchanged)", () => {
    expect(depositBaseCents(buildTaxBreakdown(lines, "IT_B2C", 22, false))).toBe(143960);
    expect(depositBaseCents(buildTaxBreakdown(lines, "IT_B2B", 22, false))).toBe(118000);
    expect(depositBaseCents(buildTaxBreakdown(lines, "EXTRA_EU", 22, false))).toBe(118000);
  });
});

// ── VIES gate ────────────────────────────────────────────────────

describe("VIES gate", () => {
  it("viesOk needs vat number + requestIdentifier + timestamp, all three", () => {
    expect(viesOk({ vatNumber: "DE123456789", viesRequestId: "WAPIAAAAY", viesCheckedAt: new Date() })).toBe(true);
    expect(viesOk({ vatNumber: "DE123456789", viesRequestId: null, viesCheckedAt: new Date() })).toBe(false);
    expect(viesOk({ vatNumber: null, viesRequestId: "WAPIAAAAY", viesCheckedAt: new Date() })).toBe(false);
    expect(viesOk({ vatNumber: "DE123456789", viesRequestId: "WAPIAAAAY", viesCheckedAt: null })).toBe(false);
  });
  it("effectiveTaxMode only downgrades EU_B2B, and only without the proof", () => {
    expect(effectiveTaxMode("EU_B2B", true)).toEqual({ mode: "EU_B2B", viesFallback: false });
    expect(effectiveTaxMode("EU_B2B", false)).toEqual({ mode: "IT_B2B", viesFallback: true });
    expect(effectiveTaxMode("IT_B2C", false)).toEqual({ mode: "IT_B2C", viesFallback: false });
  });
  it("splitVat parses country-prefixed numbers and rejects junk", () => {
    expect(splitVat(" it 01234567890 ")).toEqual({ country: "IT", number: "01234567890" });
    expect(splitVat("DE123456789")).toEqual({ country: "DE", number: "123456789" });
    expect(splitVat("12345")).toBeNull();
    expect(splitVat("")).toBeNull();
  });
  it("checkVatApprox envelope carries both parties and escapes XML", () => {
    const xml = buildCheckVatApproxEnvelope({ country: "DE", number: "123<456", requesterCountry: "IT", requesterNumber: "01234567890" });
    expect(xml).toContain("<urn:countryCode>DE</urn:countryCode>");
    expect(xml).toContain("123&lt;456");
    expect(xml).toContain("<urn:requesterVatNumber>01234567890</urn:requesterVatNumber>");
  });
  it("parses a valid response (requestIdentifier is the audit proof)", () => {
    const r = parseViesResponse(
      `<soap:Envelope xmlns:soap="x"><soap:Body><checkVatApproxResponse><valid>true</valid><traderName>ACME &amp; CO GMBH</traderName><requestIdentifier>WAPIAAAAYQ</requestIdentifier></checkVatApproxResponse></soap:Body></soap:Envelope>`,
    );
    expect(r).toEqual({ valid: true, requestIdentifier: "WAPIAAAAYQ", traderName: "ACME & CO GMBH", fault: null });
  });
  it("parses invalid + fault responses without throwing", () => {
    expect(parseViesResponse("<x><valid>false</valid><traderName>---</traderName></x>")).toMatchObject({ valid: false, requestIdentifier: null, traderName: null });
    expect(parseViesResponse("<x><faultstring>MS_MAX_CONCURRENT_REQ</faultstring></x>").fault).toBe("MS_MAX_CONCURRENT_REQ");
  });
});

// ── deposit legal enum + validity wording ────────────────────────

describe("deposit wording", () => {
  it("acconto and caparra never share a label", () => {
    const acconto = depositPdfLabel("ACCONTO", 30);
    const caparra = depositPdfLabel("CAPARRA_CONFIRMATORIA", 30);
    expect(acconto).toBe("Acconto (30%)");
    expect(caparra).toBe("Caparra confirmatoria (30%) — art. 1385 c.c.");
    expect(acconto.toLowerCase()).not.toContain("caparra");
    expect(caparra.toLowerCase()).not.toContain("acconto");
  });
  it("normalize defaults to ACCONTO (silence legally means acconto)", () => {
    expect(normalizeDepositKind(null)).toBe("ACCONTO");
    expect(normalizeDepositKind("junk")).toBe("ACCONTO");
    expect(normalizeDepositKind("CAPARRA_CONFIRMATORIA")).toBe("CAPARRA_CONFIRMATORIA");
  });
  it("B2C caparra carries the symmetric clause; acconto and B2B caparra do not", () => {
    expect(depositClauseLines("CAPARRA_CONFIRMATORIA", true, 30000)).toEqual([CAPARRA_B2C_SYMMETRIC_CLAUSE]);
    expect(depositClauseLines("CAPARRA_CONFIRMATORIA", false, 30000)).toEqual([]);
    expect(depositClauseLines("ACCONTO", true, 30000)).toEqual([]);
    expect(depositClauseLines("CAPARRA_CONFIRMATORIA", true, 0)).toEqual([]); // no deposit → no clause
  });
  it("the symmetric clause states BOTH directions of art. 1385", () => {
    expect(CAPARRA_B2C_SYMMETRIC_CLAUSE).toContain("trattenuta");
    expect(CAPARRA_B2C_SYMMETRIC_CLAUSE).toContain("doppio");
  });
});

describe("validity wording", () => {
  it("revocable default vs express irrevocable commitment (art. 1329)", () => {
    expect(normalizeValidityWording(null)).toBe("REVOCABLE");
    expect(validityLine("REVOCABLE", "31/12/2026")).toBe("Offerta valida fino al 31/12/2026");
    expect(validityLine("IRREVOCABLE", "31/12/2026")).toBe("Ci impegniamo a mantenere ferma l'offerta fino al 31/12/2026");
  });
});

// ── CGV ──────────────────────────────────────────────────────────

describe("CGV empty-safety", () => {
  it("unset CGV renders nothing (line omitted)", () => {
    expect(cgvIsSet({ version: "1.0", url: "", text: "" })).toBe(false);
    expect(cgvLine({ version: "1.0", url: "", text: "" })).toBeNull();
  });
  it("url OR text makes them referenced, with the version", () => {
    expect(cgvLine({ version: "2.1", url: "https://x.it/cgv", text: "" })).toBe("Condizioni generali di vendita v2.1");
    expect(cgvIsSet({ version: "1.0", url: "", text: "Testo…" })).toBe(true);
  });
  it("withCgvDefaults survives junk rows", () => {
    expect(withCgvDefaults(null)).toEqual({ version: "1.0", url: "", text: "" });
    expect(withCgvDefaults({ version: 3 })).toEqual({ version: "1.0", url: "", text: "" });
  });
});

// ── evidence bundle ──────────────────────────────────────────────

describe("evidence bundle", () => {
  it("acceptance evidence carries every probative element", () => {
    const e = buildEvidenceBundle({
      kind: "accept", typedName: "  Mario Rossi ", note: null, atISO: "2026-07-17T10:00:00.000Z",
      ipHash: "abc123", ua: "Mozilla/5.0", pdfSha256: "deadbeef", cgvVersion: "1.0",
      tokenVersion: 2, sentAtISO: "2026-07-16T09:00:00.000Z", viewEventIds: ["v1", "v2"],
    });
    expect(e).toEqual({
      v: 1, kind: "accept", at: "2026-07-17T10:00:00.000Z", typedName: "Mario Rossi", note: null,
      ipHash: "abc123", ua: "Mozilla/5.0", pdfSha256: "deadbeef", cgvVersion: "1.0",
      tokenVersion: 2, sentAt: "2026-07-16T09:00:00.000Z", viewEventIds: ["v1", "v2"],
    });
  });
  it("reject evidence keeps the note; blanks collapse to null; UA is capped", () => {
    const e = buildEvidenceBundle({
      kind: "reject", typedName: "   ", note: "troppo caro", atISO: "2026-07-17T10:00:00.000Z",
      ipHash: null, ua: "x".repeat(500), pdfSha256: null, cgvVersion: null,
      tokenVersion: 1, sentAtISO: null, viewEventIds: [],
    });
    expect(e.kind).toBe("reject");
    expect(e.typedName).toBeNull();
    expect(e.note).toBe("troppo caro");
    expect(e.ua!.length).toBe(300);
    expect(e.pdfSha256).toBeNull();
  });
});

// ── snapshot compliance assembly (pure builder outputs) ──────────

describe("shapeSnapshotCompliance", () => {
  const base = {
    lines: [{ unitNetCents: 100000, qty: 1 }],
    vatRatePct: 22,
    viesIsOk: false,
    depositPct: 30,
    depositKind: "ACCONTO" as const,
    validityWording: "REVOCABLE" as const,
    anyBespokeLine: true,
    cgv: { version: "1.0", url: "", text: "" },
  };

  it("IT_B2C: gross-first block, deposit on the GROSS total, bespoke clause present", () => {
    const c = shapeSnapshotCompliance({ ...base, mode: "IT_B2C" });
    expect(c.tax.grossFirst).toBe(true);
    expect(c.tax.totaleCents).toBe(122000);
    expect(c.depositCents).toBe(36600); // 30% of GROSS — the fix
    expect(c.clauses).toContain(B2C_BESPOKE_CLAUSE);
    expect(c.cgv).toBeNull(); // empty-safe
  });
  it("IT_B2B: net + IVA + totale, deposit stays on NET (parity), no consumer clauses", () => {
    const c = shapeSnapshotCompliance({ ...base, mode: "IT_B2B" });
    expect(c.tax).toMatchObject({ grossFirst: false, imponibileCents: 100000, ivaCents: 22000, totaleCents: 122000 });
    expect(c.depositCents).toBe(30000); // 30% of net — unchanged pre-EPQ.5 math
    expect(c.clauses).toEqual([]);
  });
  it("B2C standard-size (bespoke=false) omits the withdrawal exclusion", () => {
    const c = shapeSnapshotCompliance({ ...base, mode: "IT_B2C", anyBespokeLine: false });
    expect(c.clauses).not.toContain(B2C_BESPOKE_CLAUSE);
  });
  it("B2C caparra: symmetric clause AND bespoke clause, never a double label", () => {
    const c = shapeSnapshotCompliance({ ...base, mode: "IT_B2C", depositKind: "CAPARRA_CONFIRMATORIA" });
    expect(c.clauses).toEqual([CAPARRA_B2C_SYMMETRIC_CLAUSE, B2C_BESPOKE_CLAUSE]);
  });
  it("EU_B2B without VIES falls back to IT_B2B figures in the frozen block", () => {
    const c = shapeSnapshotCompliance({ ...base, mode: "EU_B2B" });
    expect(c.tax.mode).toBe("IT_B2B");
    expect(c.tax.ivaCents).toBe(22000);
    expect(c.breakdown.viesFallback).toBe(true);
  });
  it("EU_B2B with VIES freezes the art. 41 note + natura; CGV lands when set", () => {
    const c = shapeSnapshotCompliance({ ...base, mode: "EU_B2B", viesIsOk: true, cgv: { version: "2.0", url: "https://x.it/cgv", text: "" } });
    expect(c.tax.note).toContain("art. 41");
    expect(c.tax.natura).toBe("N3.2");
    expect(c.tax.ivaCents).toBe(0);
    expect(c.cgv).toEqual({ version: "2.0", url: "https://x.it/cgv" });
  });
  it("never leaks cost/margin keys (customer-document guarantee)", () => {
    const json = JSON.stringify(shapeSnapshotCompliance({ ...base, mode: "IT_B2C" }));
    expect(json).not.toMatch(/cost/i);
    expect(json).not.toMatch(/margin/i);
  });
});

// ── Stripe webhook signature ─────────────────────────────────────

describe("stripe signature", () => {
  const secret = "whsec_test";
  const body = '{"type":"checkout.session.completed"}';
  const sign = (t: number) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

  it("accepts a fresh, correctly signed payload", () => {
    const t = 1_700_000_000;
    expect(verifyStripeSignature(body, sign(t), secret, t + 10)).toBe(true);
  });
  it("rejects a bad signature, a tampered body, and a stale timestamp", () => {
    const t = 1_700_000_000;
    expect(verifyStripeSignature(body, `t=${t},v1=deadbeef`, secret, t + 10)).toBe(false);
    expect(verifyStripeSignature(body + " ", sign(t), secret, t + 10)).toBe(false);
    expect(verifyStripeSignature(body, sign(t), secret, t + 301)).toBe(false); // >5 min
  });
  it("parses multi-v1 headers and rejects malformed ones", () => {
    expect(parseStripeSignature("t=123,v1=aa,v1=bb")).toEqual({ t: 123, v1: ["aa", "bb"] });
    expect(parseStripeSignature("v1=aa")).toBeNull();
    expect(parseStripeSignature(null)).toBeNull();
  });
});
