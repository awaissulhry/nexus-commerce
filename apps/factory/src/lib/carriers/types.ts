/**
 * F1 — the CarrierAdapter contract (F0-ARCHITECTURE, verbatim from the FD6
 * research). F1 ships connect/validate + the capability probe; label
 * purchase, tracking polls and pickups land in FP8 (Shipping).
 */

export type LabelFormat = "PDF_A4" | "PDF_A6" | "ZPL";

export type CarrierCaps = {
  supportsPickup: boolean;
  supportsPollingTracking: boolean; // REQUIRED true for local-first v1
  supportsWebhookTracking: boolean;
  supportsServicePoints: boolean;
  supportsOwnContract: boolean;
  supportsMulticollo: boolean;
  labelFormats: LabelFormat[];
};

export type ProbeResult = {
  ok: boolean;
  accountLabel?: string;
  checks: { name: string; ok: boolean; detail: string }[];
  caps: CarrierCaps;
};

export interface CarrierConnector {
  readonly id: string; // "sendcloud"
  readonly name: string;
  /** Validate credentials + empirically probe what the plan tier unlocks. */
  validateAndProbe(credentials: Record<string, string>): Promise<ProbeResult>;
}
