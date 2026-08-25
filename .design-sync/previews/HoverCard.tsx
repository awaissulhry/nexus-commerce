import { useEffect, useRef, type ReactNode } from 'react'
import { Badge, HoverCard, Pill, Tag } from '@nexus/design-system'



/**
 * Preview harness — NOT part of the component API.
 *
 * The panel is revealed by `.nds-hovercard:hover` OR `:focus-within`, and
 * the wrapper the DS renders already carries `tabIndex={0}`. Focusing it on
 * mount therefore lights the real rule — the same one hover uses — instead of
 * faking an open panel. `room` is the vertical space the card needs: it sits
 * ABOVE the trigger, so the cell must reserve height over it.
 */
const Revealed = ({ room, children }: { room: number; children: ReactNode }) => {
  const host = useRef<HTMLDivElement>(null)
  const fired = useRef(false)
  useEffect(() => {
    if (fired.current) return
    fired.current = true
    host.current?.querySelector<HTMLElement>('.nds-hovercard')?.focus()
  }, [])
  return (
    <div ref={host} style={{ paddingTop: room, display: 'flex', justifyContent: 'center' }}>
      {children}
    </div>
  )
}

const link: React.CSSProperties = {
  color: 'var(--color-primary)',
  fontWeight: 600,
  borderBottom: '1px dashed var(--border-strong)',
  cursor: 'default',
}

const cardTitle: React.CSSProperties = { fontWeight: 700, fontSize: 13, marginBottom: 4 }
const cardMuted: React.CSSProperties = { fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.45 }

const CAMPAIGN_CARD = (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    <div>
      <div style={cardTitle}>Helmets · Auto</div>
      <div style={cardMuted}>Created 12 Mar 2026 · 3 ad groups · Amazon Germany</div>
    </div>
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      <Badge program="sp">SP</Badge>
      <Pill tone="success">Active</Pill>
      <Tag tone="neutral">Down only</Tag>
    </div>
    <div style={{ display: 'flex', gap: 16, fontSize: 12 }}>
      <span>
        <span style={{ color: 'var(--text-tertiary)' }}>Spend </span>
        <strong>€1,284</strong>
      </span>
      <span>
        <span style={{ color: 'var(--text-tertiary)' }}>Sales </span>
        <strong>€8,640</strong>
      </span>
      <span>
        <span style={{ color: 'var(--text-tertiary)' }}>ACOS </span>
        <strong>14.9%</strong>
      </span>
    </div>
  </div>
)

const ACOS_CARD = (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <div style={cardTitle}>ACOS</div>
    <div style={cardMuted}>Advertising cost of sale — ad spend divided by the ad sales it is credited with.</div>
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--text-primary)',
        background: 'var(--surface-sunken)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 6,
        padding: '6px 8px',
      }}
    >
      spend ÷ sales(14d) × 100
    </div>
    <div style={cardMuted}>Amazon's 14-day attribution window. Last synced 12:40 UTC.</div>
  </div>
)

/** Resting: the panel is at opacity 0, so a HoverCard costs a row nothing until it is pointed at. */
export const Trigger = () => (
  <p style={{ margin: 0, fontSize: 13, lineHeight: 1.9, color: 'var(--text-secondary)', maxWidth: 380 }}>
    Yesterday{' '}
    <HoverCard card={CAMPAIGN_CARD}>
      <span style={link}>Helmets · Auto</span>
    </HoverCard>{' '}
    spent €1,284 at an{' '}
    <HoverCard card={ACOS_CARD}>
      <span style={link}>ACOS</span>
    </HoverCard>{' '}
    of 14.9%.
  </p>
)

/** The panel: a light surface card above the trigger, 280px max, carrying real components — Badge, Pill, Tag, figures. */
export const CampaignSummary = () => (
  <Revealed room={170}>
    <HoverCard card={CAMPAIGN_CARD}>
      <span style={link}>Helmets · Auto</span>
    </HoverCard>
  </Revealed>
)

/** The other job: a column header that explains its own metric — definition, formula, and where the number came from. */
export const MetricDefinition = () => (
  <Revealed room={165}>
    <HoverCard card={ACOS_CARD}>
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: 'var(--text-secondary)',
          borderBottom: '1px dashed var(--border-strong)',
        }}
      >
        ACOS
      </span>
    </HoverCard>
  </Revealed>
)
