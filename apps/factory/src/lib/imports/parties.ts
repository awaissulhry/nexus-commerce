/**
 * F1 — the reference implementation of the import framework (parse-pure →
 * diff → apply-valid-rows; one endpoint with a dryRun flag; per-row
 * from/to/note/error — the proven eBay-ads CSV idiom generalized). Entity:
 * Party (+ its matching email). Template: GET /api/imports/parties/template.
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEvent } from "@/lib/events";
import { rowsToObjects, toCsv } from "@/lib/csv";

export const PARTY_CSV_HEADERS = ["kind", "name", "email", "currency", "payment_terms", "notes"] as const;
const KINDS = new Set(["BRAND", "CUSTOMER", "SUPPLIER"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type PartyOp = {
  row: number;
  kind: string;
  name: string;
  email: string;
  currency: string;
  paymentTerms?: string;
  notes?: string;
};

export type ParseResult = { ops: PartyOp[]; errors: { row: number; error: string }[] };

/** PURE — unit-tested. Row numbers are 1-based data rows (header excluded). */
export function parsePartiesCsv(csv: string): ParseResult {
  const ops: PartyOp[] = [];
  const errors: { row: number; error: string }[] = [];
  const seen = new Set<string>();
  rowsToObjects(csv).forEach((obj, idx) => {
    const row = idx + 1;
    const kind = (obj["kind"] ?? "").toUpperCase();
    const name = obj["name"] ?? "";
    const email = (obj["email"] ?? "").toLowerCase();
    if (!KINDS.has(kind)) return errors.push({ row, error: `kind must be BRAND|CUSTOMER|SUPPLIER (got "${obj["kind"]}")` });
    if (!name) return errors.push({ row, error: "name is required" });
    if (email && !EMAIL_RE.test(email)) return errors.push({ row, error: `invalid email "${email}"` });
    if (email && seen.has(email)) return errors.push({ row, error: `duplicate email in file: ${email}` });
    if (email) seen.add(email);
    ops.push({
      row,
      kind,
      name,
      email,
      currency: (obj["currency"] || "EUR").toUpperCase(),
      paymentTerms: obj["payment_terms"] || undefined,
      notes: obj["notes"] || undefined,
    });
  });
  return { ops, errors };
}

export type DiffRow = {
  row: number;
  action: "CREATE" | "UPDATE" | "SKIP";
  target: string;
  from?: string;
  to?: string;
  note?: string;
  error?: string;
};

export async function diffParties(ops: PartyOp[]): Promise<DiffRow[]> {
  const emails = ops.map((o) => o.email).filter(Boolean);
  const existing = await prisma.partyEmail.findMany({
    where: { email: { in: emails } },
    include: { party: true },
  });
  const byEmail = new Map(existing.map((e) => [e.email, e.party]));
  return ops.map((op) => {
    const found = op.email ? byEmail.get(op.email) : undefined;
    if (!found) {
      return {
        row: op.row,
        action: "CREATE" as const,
        target: `${op.kind} · ${op.name}`,
        to: op.email || "(no email)",
        note: op.email ? undefined : "no email — Inbox sender-matching will not find this party",
      };
    }
    if (found.name === op.name && found.kind === op.kind) {
      return { row: op.row, action: "SKIP" as const, target: op.name, note: "already exists, unchanged" };
    }
    if (found.kind !== op.kind) {
      return {
        row: op.row,
        action: "UPDATE" as const,
        target: op.name,
        from: `${found.kind} · ${found.name}`,
        to: `${op.kind} · ${op.name}`,
        error: "kind change requires manual review — will not apply",
      };
    }
    return {
      row: op.row,
      action: "UPDATE" as const,
      target: op.name,
      from: found.name,
      to: op.name,
    };
  });
}

export async function applyParties(ops: PartyOp[], diff: DiffRow[], actorId: string) {
  const valid = new Map(diff.filter((d) => !d.error).map((d) => [d.row, d]));
  const results: { row: number; ok: boolean; detail: string }[] = [];
  for (const op of ops) {
    const d = valid.get(op.row);
    if (!d) {
      results.push({ row: op.row, ok: false, detail: "skipped (error row)" });
      continue;
    }
    try {
      if (d.action === "SKIP") {
        results.push({ row: op.row, ok: true, detail: "unchanged" });
        continue;
      }
      if (d.action === "CREATE") {
        const party = await prisma.party.create({
          data: {
            kind: op.kind as never,
            name: op.name,
            currency: op.currency,
            paymentTerms: op.paymentTerms,
            notes: op.notes,
            emails: op.email ? { create: { email: op.email } } : undefined,
          },
        });
        void audit({ actorId, entityType: "party", entityId: party.id, action: "created", after: { via: "import" } });
        results.push({ row: op.row, ok: true, detail: `created ${op.name}` });
      } else {
        const link = await prisma.partyEmail.findUnique({ where: { email: op.email }, include: { party: true } });
        if (!link) throw new Error("row vanished between diff and apply");
        const before = { name: link.party.name };
        await prisma.party.update({
          where: { id: link.partyId },
          data: { name: op.name, paymentTerms: op.paymentTerms ?? link.party.paymentTerms, notes: op.notes ?? link.party.notes },
        });
        void audit({ actorId, entityType: "party", entityId: link.partyId, action: "updated", before, after: { name: op.name, via: "import" } });
        results.push({ row: op.row, ok: true, detail: `updated ${op.name}` });
      }
    } catch (err) {
      results.push({ row: op.row, ok: false, detail: (err as Error).message.slice(0, 200) });
    }
  }
  publishEvent("import.finished", { entity: "party" });
  return results;
}

export function partiesTemplateCsv(): string {
  return toCsv([...PARTY_CSV_HEADERS], [
    ["CUSTOMER", "Mario Rossi", "mario.rossi@example.com", "EUR", "", "Made-to-measure customer"],
    ["BRAND", "Moto Brand SRL", "orders@example-brand.it", "EUR", "30 days", "B2B — size runs"],
    ["SUPPLIER", "Conceria Example", "sales@example-leather.it", "EUR", "60 days", "Cowhide supplier"],
  ]);
}
