/**
 * FP6 — the EN 17092 certificate gate (FD14). A garment can't be finished into
 * Packing unless its template has a covering certificate that is not expired.
 * `certStatus` is the pure decision; the async helper resolves a Work Order's
 * template (via its order line's selections) and its coverages. No covering
 * cert ⇒ "missing"; all covering certs expired ⇒ "expired"; else "ok". A WO with
 * no resolvable template ⇒ "no_template" (the route lets it pass — flagged).
 */
import { prisma } from "@/lib/db";

export type CertStatus = "ok" | "missing" | "expired" | "no_template";

export function certStatus(coverages: { expiresAt: Date | string | null }[], nowMs: number): CertStatus {
  if (coverages.length === 0) return "missing";
  const anyValid = coverages.some((c) => c.expiresAt == null || new Date(c.expiresAt).getTime() >= nowMs);
  return anyValid ? "ok" : "expired";
}

export async function woTemplateId(woId: string): Promise<string | null> {
  const wo = await prisma.workOrder.findUnique({ where: { id: woId }, select: { orderLineId: true } });
  if (!wo?.orderLineId) return null;
  const line = await prisma.orderLine.findUnique({ where: { id: wo.orderLineId }, select: { selections: true } });
  const sels = (line?.selections as string[] | null) ?? [];
  if (!sels.length) return null;
  const opt = await prisma.option.findUnique({ where: { id: sels[0] }, select: { group: { select: { templateId: true } } } });
  return opt?.group.templateId ?? null;
}

export async function certGateForWorkOrder(woId: string, nowMs: number): Promise<CertStatus> {
  const templateId = await woTemplateId(woId);
  if (!templateId) return "no_template";
  const coverages = await prisma.certificateCoverage.findMany({ where: { templateId }, select: { certificate: { select: { expiresAt: true } } } });
  return certStatus(coverages.map((c) => ({ expiresAt: c.certificate.expiresAt })), nowMs);
}

export const CERT_BLOCK_MESSAGE: Record<Exclude<CertStatus, "ok" | "no_template">, string> = {
  missing: "No EN 17092 certificate covers this garment — it can't be packed",
  expired: "The EN 17092 certificate for this garment has expired — it can't be packed",
};
