/**
 * EPF1.4 (D-11-defect) — the payment body schema, shared and testable. REFUND
 * is a runtime-enforced kind (SQLite enums carry no CHECK): its amount MUST be
 * negative and a note explaining why is mandatory; every other kind stays
 * strictly positive. Folds already sum signed values, so a refund flows
 * through balances/tiles correctly. Formal credit notes remain EPF.4.
 */
import { z } from "zod";

export const PAYMENT_KINDS = ["DEPOSIT", "BALANCE", "OTHER", "REFUND"] as const;
export type PaymentKindInput = (typeof PAYMENT_KINDS)[number];

export const PaymentBody = z
  .object({
    kind: z.enum(PAYMENT_KINDS).default("DEPOSIT"),
    amountCents: z.number().int(),
    method: z.string().trim().max(80).optional(),
    notes: z.string().trim().max(500).optional(),
    // EPF2 (P2: PaymentModal had no date field) — the payment's value date as a
    // Rome-local `YYYY-MM-DD`; stored UTC-midnight (same convention as the
    // bank import's parseBankDate). Absent ⇒ the DB default (now).
    receivedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD").optional(),
    /** EPF1.3 — explicit escape hatch for the Σ ≤ net overpay guard (409 otherwise). */
    allowOverpay: z.boolean().optional(),
    // EPO1.3 (C4) — minted once when the payment modal opens; retries and
    // double-clicks reuse it, so the money can only land once.
    idempotencyKey: z.string().trim().min(8).max(80).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.kind === "REFUND") {
      if (val.amountCents >= 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amountCents"], message: "A refund's amount must be negative" });
      }
      if (!val.notes) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["notes"], message: "A refund requires a note explaining why" });
      }
    } else if (val.amountCents <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amountCents"], message: "Amount must be positive" });
    }
  });

export type PaymentBodyInput = z.infer<typeof PaymentBody>;
