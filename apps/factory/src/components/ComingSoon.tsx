/**
 * F1 — the designed empty state (master prompt: "no dead links, no lorem
 * ipsum"): page header + purpose line + what the page will do + which FP
 * cycle delivers it. Content comes from the F0-IA registry in src/lib/nav.ts.
 */
"use client";

import { PageHeader } from "@/design-system/patterns";
import { Card } from "@/design-system/components";
import { FACTORY_PAGES } from "@/lib/nav";

export function ComingSoon({ pageId }: { pageId: string }) {
  const page = FACTORY_PAGES.find((p) => p.id === pageId);
  if (!page) return null;
  return (
    <div className="factory-coming">
      <PageHeader eyebrow="Factory OS" title={page.label} subtitle={page.purpose} />
      <Card padded>
        <span className="fp-chip">Arrives in {page.fp} — spec first, then build</span>
        <div style={{ fontSize: 13, color: "var(--h10-text)" }}>What this page will do:</div>
        <ul>
          {page.bullets.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
        <div className="golden">
          Every page cycle is double-gated: written spec → Owner approval → build → click-through
          verification → Owner approval. Verdicts and layout are already specified in{" "}
          <code>docs/factory/F0-IA.md</code> and <code>docs/factory/F0-TEARDOWN.md</code>.
        </div>
      </Card>
    </div>
  );
}
