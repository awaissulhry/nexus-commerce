/**
 * FP2.2 — money & delta editing helpers. Everything stored in integer cents /
 * basis points; the UI edits in euros / percent. A DeltaInput shows the amount
 * plus a €/% mode toggle and (for percent) the resolved € effect on a base, so
 * a percentage never surprises the Owner.
 */
"use client";

import { eur } from "@/design-system/lib/format";

export type DeltaMode = "ABSOLUTE" | "PERCENT";

export const centsToEuroStr = (cents: number): string => (cents / 100).toFixed(2);
export const euroStrToCents = (s: string): number => Math.round(parseFloat(s || "0") * 100) || 0;
export const bpToPctStr = (bp: number): string => (bp / 100).toString();
export const pctStrToBp = (s: string): number => Math.round(parseFloat(s || "0") * 100) || 0;

/** Signed euro string ("+€120.00" / "−€40.00"). */
export const signedEur = (cents: number): string =>
  cents === 0 ? eur(0) : cents > 0 ? `+${eur(cents)}` : `−${eur(-cents)}`;

export function DeltaInput({
  mode,
  value, // cents when ABSOLUTE, basis points when PERCENT
  baseCents,
  onChange,
  disabled,
  ariaLabel,
}: {
  mode: DeltaMode;
  value: number;
  baseCents?: number; // to show the resolved € effect of a percent
  onChange: (next: { mode: DeltaMode; value: number }) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const display = mode === "ABSOLUTE" ? centsToEuroStr(value) : bpToPctStr(value);
  const resolvedPct = mode === "PERCENT" && baseCents != null ? Math.round((value / 10_000) * baseCents) : null;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          border: "1px solid var(--h10-border)",
          borderRadius: 7,
          background: "var(--h10-surface)",
          overflow: "hidden",
        }}
      >
        {mode === "ABSOLUTE" && <span style={{ padding: "3px 5px", fontSize: 12, color: "var(--h10-text-3)", background: "var(--h10-surface-sunken)" }}>€</span>}
        <input
          type="number"
          step={mode === "ABSOLUTE" ? "0.01" : "0.1"}
          defaultValue={display}
          key={`${mode}:${value}`}
          disabled={disabled}
          aria-label={ariaLabel}
          onBlur={(e) => {
            const next = mode === "ABSOLUTE" ? euroStrToCents(e.target.value) : pctStrToBp(e.target.value);
            if (next !== value) onChange({ mode, value: next });
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          style={{ width: 82, border: "none", outline: "none", font: "12.5px var(--font-mono), monospace", padding: "3px 5px", background: "transparent", color: "var(--h10-text)", textAlign: "right" }}
        />
        {mode === "PERCENT" && <span style={{ padding: "3px 5px", fontSize: 12, color: "var(--h10-text-3)", background: "var(--h10-surface-sunken)" }}>%</span>}
      </span>
      <button
        type="button"
        disabled={disabled}
        title="Toggle € / %"
        onClick={() => onChange({ mode: mode === "ABSOLUTE" ? "PERCENT" : "ABSOLUTE", value: 0 })}
        style={{ border: "1px solid var(--h10-border)", borderRadius: 7, background: "var(--h10-surface)", cursor: disabled ? "default" : "pointer", fontSize: 11, padding: "3px 6px", color: "var(--h10-text-2)", minWidth: 26 }}
      >
        {mode === "ABSOLUTE" ? "€" : "%"}
      </button>
      {resolvedPct != null && baseCents != null && (
        <span style={{ fontSize: 10.5, color: "var(--h10-text-3)" }}>→ {signedEur(resolvedPct)}</span>
      )}
    </span>
  );
}

export function EuroInput({
  cents,
  onCommit,
  disabled,
  ariaLabel,
  width = 90,
}: {
  cents: number;
  onCommit: (cents: number) => void;
  disabled?: boolean;
  ariaLabel?: string;
  width?: number;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", border: "1px solid var(--h10-border)", borderRadius: 7, overflow: "hidden", background: "var(--h10-surface)" }}>
      <span style={{ padding: "4px 6px", fontSize: 12, color: "var(--h10-text-3)", background: "var(--h10-surface-sunken)" }}>€</span>
      <input
        type="number"
        step="0.01"
        defaultValue={centsToEuroStr(cents)}
        key={cents}
        disabled={disabled}
        aria-label={ariaLabel}
        onBlur={(e) => {
          const next = euroStrToCents(e.target.value);
          if (next !== cents) onCommit(next);
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        style={{ width, border: "none", outline: "none", font: "12.5px var(--font-mono), monospace", padding: "4px 6px", background: "transparent", color: "var(--h10-text)", textAlign: "right" }}
      />
    </span>
  );
}
