/**
 * FP8 — labels live on disk beside the SQLite DB ($0 infra — no object store).
 * The buy route writes the carrier's label bytes here; the `/label` route streams
 * them behind `guarded()` (never a public URL). `labelRef` stored on the Shipment
 * is a repo-relative-ish key we re-resolve, and every read is path-traversal
 * guarded so a crafted ref can't escape the labels dir.
 */
import fs from "node:fs";
import path from "node:path";
import { factoryDbUrl } from "../db";
import type { LabelFormat } from "../carriers/types";

const EXT: Record<LabelFormat, string> = { PDF_A4: "pdf", PDF_A6: "pdf", ZPL: "zpl" };

export function labelsDir(): string {
  const dbFile = factoryDbUrl().replace(/^file:/, "");
  return path.join(path.dirname(dbFile), "labels");
}

/** Persist a base64 label; returns the `labelRef` to store on the Shipment. */
export function saveLabel(shipmentId: string, base64: string, format: LabelFormat): string {
  const dir = labelsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = `${sanitizeId(shipmentId)}.${EXT[format] ?? "pdf"}`;
  fs.writeFileSync(path.join(dir, file), Buffer.from(base64, "base64"));
  return `labels/${file}`;
}

export function readLabel(labelRef: string): { buffer: Buffer; contentType: string } | null {
  const dir = labelsDir();
  const file = path.basename(labelRef); // strip any path — only a bare filename is ever valid
  const full = path.join(dir, file);
  if (path.dirname(full) !== dir || !fs.existsSync(full)) return null; // traversal guard
  const buffer = fs.readFileSync(full);
  const contentType = full.endsWith(".zpl") ? "text/plain" : "application/pdf";
  return { buffer, contentType };
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}
