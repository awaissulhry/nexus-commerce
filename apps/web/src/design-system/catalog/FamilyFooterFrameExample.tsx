'use client'
import { ExternalLink } from 'lucide-react'
import { Button } from '../primitives/Button'
import { FamilyFooterFrame } from '../grid/toolbars/FamilyFooterFrame'

/**
 * The row under an open family (2026-10-23) — Products and Listing readiness draw it with `FamilyFooterFrame`. Shown
 * here on the family's tint and at the grid's footer row height. Verify in light and dark, at 1280 and 390 px: the
 * count in small muted type with bold numbers, the optional second line beside it, the action at the end of the line.
 * Keyboard: Tab reaches the action, Enter follows it.
 */
const CASES = [
  { shown: 10, total: 40, extra: 'Variation mapping · 26 derived · 1 overridden' },
  { shown: 3, total: 3, extra: undefined },
]

export function FamilyFooterFrameExample() {
  return (
    <div id="family-footer-frame-example" style={{ display: 'grid', gap: 'var(--nds-space-8)', maxWidth: 720, marginBottom: 'var(--nds-space-18)' }}>
      {CASES.map(({ shown, total, extra }) => (
        <div key={total} style={{ minHeight: 'var(--nds-grid-footer-row-h)', background: 'var(--nds-grid-child-bg)', border: '1px solid var(--nds-border-subtle)', borderRadius: 'var(--nds-radius-lg)' }}>
          <FamilyFooterFrame
            shown={shown}
            total={total}
            extra={extra}
            action={
              <Button asChild size="sm" variant="secondary">
                <a href="#family-footer-frame-example">{total > shown ? `View all ${total}` : 'Open family'} <ExternalLink size={13} /></a>
              </Button>
            }
          />
        </div>
      ))}
    </div>
  )
}
