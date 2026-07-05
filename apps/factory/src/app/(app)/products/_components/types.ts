/** FP2 — shared client types for the Products workspace (mirror the API). */

export type DeltaMode = "ABSOLUTE" | "PERCENT";

export type TemplateRow = {
  id: string;
  name: string;
  description: string | null;
  baseCostCents: number;
  basePriceCents: number;
  archivedAt: string | null;
  groupCount: number;
  optionCount: number;
  constraintCount: number;
  bomCount: number;
  certStatus: "none" | "ok" | "expiring" | "expired";
  certClasses: string[];
  updatedAt: string;
};

export type Option = {
  id: string;
  groupId: string;
  name: string;
  costDeltaMode: DeltaMode;
  costDelta: number;
  priceDeltaMode: DeltaMode;
  priceDelta: number;
  materialDraws: { materialId: string; qty: number; unit: string }[] | null;
  sort: number;
};

export type Group = {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  sort: number;
  options: Option[];
};

export type Constraint = {
  id: string;
  type: "REQUIRES" | "EXCLUDES";
  severity: "BLOCK" | "WARN";
  ifOptionId: string;
  thenOptionId: string;
  message: string;
};

export type BomLine = {
  id: string;
  materialId: string;
  qty: number;
  unit: string;
  perOption: boolean;
  material: { name: string; unit: string };
};

export type Certificate = {
  id: string;
  standard: string;
  class: string;
  certNumber: string;
  notifiedBody: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  fileRef: string | null;
};

export type CertCoverage = { id: string; certificateId: string; coveredSizes: unknown; certificate: Certificate };

export type TemplateDetail = {
  id: string;
  name: string;
  description: string | null;
  baseCostCents: number;
  basePriceCents: number;
  archivedAt: string | null;
  optionGroups: Group[];
  constraints: Constraint[];
  bomLines: BomLine[];
  certCoverage: CertCoverage[];
};

export type MaterialRow = {
  id: string;
  name: string;
  unit: string;
  costCents: number;
  reorderLevel: number | null;
  notes: string | null;
  usedByTemplates: number;
  archivedAt: string | null;
};

export type PriceListRow = {
  id: string;
  kind: "DEFAULT" | "PARTY_TIER";
  name: string;
  notes: string | null;
  entryCount: number;
  partyCount: number;
};

export const CERT_TONE: Record<TemplateRow["certStatus"], "success" | "warning" | "danger" | "neutral"> = {
  ok: "success",
  expiring: "warning",
  expired: "danger",
  none: "neutral",
};

export const optionLabel = (groups: Group[], id: string): string => {
  for (const g of groups) {
    const o = g.options.find((x) => x.id === id);
    if (o) return `${g.name}: ${o.name}`;
  }
  return "(removed option)";
};
