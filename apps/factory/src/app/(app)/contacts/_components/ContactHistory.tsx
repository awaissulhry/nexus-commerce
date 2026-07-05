/** FP5.1 — placeholder; the aggregated history tabs land in FP5.3. */
"use client";

import { Card } from "@/design-system/components";

export function ContactHistory({ contactId: _contactId }: { contactId: string }) {
  return (
    <Card padded>
      <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 6 }}>History</div>
      <div style={{ fontSize: 12.5, color: "var(--h10-text-3)" }}>Conversations, quotes, orders and reviews for this contact arrive in FP5.3.</div>
    </Card>
  );
}
