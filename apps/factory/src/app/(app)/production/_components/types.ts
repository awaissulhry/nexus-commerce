/** FP6 — production board shapes (est cost optional: stripped for cost-blind callers). */
export type StageStatus = "not_started" | "running" | "paused" | "done";

export type CurrentStage = {
  id: string;
  stage: string;
  status: StageStatus;
  startedAt: string | null;
  pausedMs: number;
  pausedAt: string | null;
  assignee: { id: string; displayName: string } | null;
};

export type WOCard = {
  id: string;
  number: string;
  label: string | null;
  orderNumber: string;
  party: string;
  priority: number;
  promiseDateAt: string | null;
  state: string;
  blockedReason: string | null;
  estCostCents?: number;
  stageCount: number;
  doneCount: number;
  column: string; // current stage key, or "DONE"
  current: CurrentStage | null;
  coverage?: "OK" | "PARTIAL" | "SHORT"; // FP6.3
  shortMaterials?: string[]; // FP6.3
};

export type ProductionResponse = {
  pipeline: string[];
  workOrders: WOCard[];
  workers: { id: string; displayName: string }[];
  worker: boolean;
  nowIso: string;
};

const STAGE_ACRONYMS: Record<string, string> = { QC: "QC" };
export const STAGE_LABEL = (s: string) => STAGE_ACRONYMS[s] ?? s.charAt(0) + s.slice(1).toLowerCase();
