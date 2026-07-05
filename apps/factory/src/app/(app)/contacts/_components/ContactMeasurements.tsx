/** FP5.1 — placeholder; the versioned measurement-profile editor lands in FP5.2. */
"use client";

import { Card } from "@/design-system/components";
import type { MeasurementProfile } from "./types";

export function ContactMeasurements({ measurements }: { contactId: string; measurements: MeasurementProfile[]; canManage: boolean; onChanged: () => void }) {
  return (
    <Card padded>
      <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 6 }}>Measurements</div>
      <div style={{ fontSize: 12.5, color: "var(--h10-text-3)" }}>
        {measurements.length ? `${measurements.length} profile version(s) on file.` : "No measurement profiles yet."} The versioned editor arrives in FP5.2.
      </div>
    </Card>
  );
}
