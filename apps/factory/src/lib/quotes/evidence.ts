/**
 * EPQ.5 — the acceptance evidence bundle (CAD art. 20 probative criteria),
 * written ONCE on the QuoteVersion whose accept token was used: SHA-256 of the
 * exact frozen PDF the customer saw, the CGV version shown (from the frozen
 * snapshot), the typed-name confirmation (SES practice), server timestamp,
 * hashed IP + user agent, and the send/view event trail refs. The reject path
 * stores note+evidence in the same shape. Builder is PURE (shape unit-pinned);
 * the file hash is the one impure helper.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";

export type EvidenceInput = {
  kind: "accept" | "reject";
  /** typed "Nome e cognome" — required on accept, optional on reject */
  typedName: string | null;
  note: string | null;
  atISO: string;
  ipHash: string | null;
  ua: string | null;
  /** sha256 hex of the frozen pdfRef file (null when the file is gone) */
  pdfSha256: string | null;
  /** CGV version the frozen snapshot referenced (null when CGV unset at send) */
  cgvVersion: string | null;
  /** which send this token belonged to + when it went out */
  tokenVersion: number;
  sentAtISO: string | null;
  /** QuoteViewEvent ids — the open/view trail for this quote (bounded) */
  viewEventIds: string[];
};

export type EvidenceBundle = {
  v: 1;
  kind: "accept" | "reject";
  at: string;
  typedName: string | null;
  note: string | null;
  ipHash: string | null;
  ua: string | null;
  pdfSha256: string | null;
  cgvVersion: string | null;
  tokenVersion: number;
  sentAt: string | null;
  viewEventIds: string[];
};

export function buildEvidenceBundle(input: EvidenceInput): EvidenceBundle {
  return {
    v: 1,
    kind: input.kind,
    at: input.atISO,
    typedName: input.typedName?.trim() || null,
    note: input.note?.trim() || null,
    ipHash: input.ipHash,
    ua: input.ua ? input.ua.slice(0, 300) : null,
    pdfSha256: input.pdfSha256,
    cgvVersion: input.cgvVersion,
    tokenVersion: input.tokenVersion,
    sentAt: input.sentAtISO,
    viewEventIds: input.viewEventIds,
  };
}

/** sha256 of a file on disk — null when missing/unreadable (evidence still lands). */
export function sha256FileOrNull(filePath: string | null): string | null {
  if (!filePath) return null;
  try {
    return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}
