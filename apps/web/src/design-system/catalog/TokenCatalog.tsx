'use client'

/**
 * The living catalog — one screen that renders every design token, driven by the
 * actual token objects (`@/design-system/tokens`) so it can never drift from the
 * source of truth. Components are added here as Phases 3–5 land.
 *
 * Chrome uses `var(--h10-*)` (so the dark toggle exercises the CSS layer +
 * dark-readiness); swatches show the literal primitive/semantic values. This is
 * both the documentation surface and the screenshot-diff harness target
 * (.analysis/ds-catalog-verify.mjs captures it @2x).
 */

import { useState, type ReactNode } from 'react'
import { Search } from 'lucide-react'
import {
  palette,
  color,
  fontSize,
  fontWeight,
  letterSpacing,
  space,
  size,
  radius,
  shadow,
  focusRing,
  duration,
  zIndex,
  breakpoint,
} from '@/design-system/tokens'
import {
  Button,
  Pill,
  Badge,
  Input,
  Select,
  Checkbox,
  Toggle,
  Radio,
  RadioCard,
  Tooltip,
  Spinner,
  Skeleton,
  Kbd,
  Divider,
} from '@/design-system/primitives'

const ramps: Array<[string, Record<string, string>]> = [
  ['Blue', palette.blue],
  ['Grey', palette.grey],
  ['Green', palette.green],
  ['Red', palette.red],
  ['Amber', palette.amber],
  ['Purple', palette.purple],
  ['Cyan', palette.cyan],
]

const mono = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace"

function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 40 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 2px', letterSpacing: '-0.01em' }}>{title}</h2>
      {desc && <p style={{ fontSize: 13, color: 'var(--h10-text-3)', margin: '0 0 14px' }}>{desc}</p>}
      <div style={{ marginTop: desc ? 0 : 12 }}>{children}</div>
    </section>
  )
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--h10-surface)',
        border: '1px solid var(--h10-border-subtle)',
        borderRadius: 12,
        padding: 18,
        boxShadow: 'var(--h10-shadow-card)',
      }}
    >
      {children}
    </div>
  )
}

function Swatch({ name, value }: { name: string; value: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          height: 52,
          borderRadius: 8,
          background: value,
          border: '1px solid var(--h10-border-subtle)',
        }}
      />
      <div style={{ fontSize: 12, fontWeight: 600, marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
      <div style={{ fontSize: 11, fontFamily: mono, color: 'var(--h10-text-3)' }}>{value}</div>
    </div>
  )
}

function SwatchGrid({ children }: { children: ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(108px, 1fr))', gap: 12 }}>{children}</div>
}

export function TokenCatalog() {
  const [dark, setDark] = useState(false)
  return (
    <div
      className={dark ? 'dark' : undefined}
      style={{
        background: 'var(--h10-bg)',
        color: 'var(--h10-text)',
        minHeight: '100vh',
        fontFamily: 'var(--h10-font-sans)',
        WebkitFontSmoothing: 'auto',
        padding: '32px 36px 64px',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--h10-text-3)' }}>Nexus Design System · H10</div>
          <h1 style={{ fontSize: 27, fontWeight: 800, letterSpacing: '-0.02em', margin: '2px 0 0' }}>Token Catalog</h1>
          <p style={{ fontSize: 13, color: 'var(--h10-text-2)', margin: '4px 0 0' }}>
            Phase 2 — the living style guide + verify harness target. Every value below is driven by{' '}
            <code style={{ fontFamily: mono }}>@/design-system/tokens</code>.
          </p>
        </div>
        <button
          onClick={() => setDark((d) => !d)}
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--h10-text)',
            background: 'var(--h10-surface)',
            border: '1px solid var(--h10-border)',
            borderRadius: 8,
            padding: '8px 13px',
            cursor: 'pointer',
          }}
        >
          {dark ? '☀ Light' : '☾ Dark'}
        </button>
      </header>

      <Section title="Color — primitive ramps" desc="The raw scale. Components never consume these directly.">
        <Card>
          {ramps.map(([label, ramp]) => (
            <div key={label} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', marginBottom: 8 }}>
                {label}
              </div>
              <SwatchGrid>
                {Object.entries(ramp).map(([k, v]) => (
                  <Swatch key={k} name={k} value={v} />
                ))}
              </SwatchGrid>
            </div>
          ))}
          <SwatchGrid>
            <Swatch name="white" value={palette.white} />
            <Swatch name="railBg" value={palette.railBg} />
            <Swatch name="railBorder" value={palette.railBorder} />
            <Swatch name="amazon" value={palette.amazon} />
          </SwatchGrid>
        </Card>
      </Section>

      <Section title="Color — semantic roles" desc="What components consume (text / surface / border / primary / status).">
        <Card>
          <SwatchGrid>
            {Object.entries(color).map(([k, v]) => (
              <Swatch key={k} name={k} value={v} />
            ))}
          </SwatchGrid>
        </Card>
      </Section>

      <section data-cat="primitives" style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 2px', letterSpacing: '-0.01em' }}>
          Primitives <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--h10-text-3)' }}>· Phase 3 · Wave 1</span>
        </h2>
        <p style={{ fontSize: 13, color: 'var(--h10-text-3)', margin: '0 0 14px' }}>
          Real components from <code style={{ fontFamily: mono }}>@/design-system/primitives</code>, tokenized to the H10 spec.
        </p>
        <Card>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', marginBottom: 10 }}>Button</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            <Button variant="primary">Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="primary" size="sm">Small</Button>
            <Button variant="secondary" size="sm">Small</Button>
            <Button variant="primary" disabled>Disabled</Button>
            <Button variant="secondary" disabled>Disabled</Button>
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Status pill</div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Pill status="ok">Active</Pill>
            <Pill status="warn">Paused</Pill>
            <Pill status="arch">Archived</Pill>
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Program / targeting badge</div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Badge tone="sp">SP</Badge>
            <Badge tone="sd">SD</Badge>
            <Badge tone="sb">SB</Badge>
            <Badge tone="auto">A</Badge>
            <Badge tone="manual">M</Badge>
          </div>
        </Card>

        <Card>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', marginBottom: 10 }}>Input</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            <Input placeholder="Plain input" />
            <Input leadingIcon={<Search size={15} />} placeholder="Search campaigns" />
            <Input prefix="€" placeholder="0.00" size={6} />
            <Input suffix="%" placeholder="0" size={4} />
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Select</div>
          <Select defaultValue="all">
            <option value="all">All campaigns</option>
            <option value="sp">Sponsored Products</option>
            <option value="sb">Sponsored Brands</option>
          </Select>

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Checkbox</div>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <Checkbox defaultChecked label="Checked" />
            <Checkbox label="Unchecked" />
            <Checkbox disabled label="Disabled" />
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Toggle</div>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <Toggle checked />
            <Toggle checked={false} />
            <Toggle checked={false} disabled />
          </div>
        </Card>

        <Card>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', marginBottom: 10 }}>Radio</div>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <Radio name="opt" defaultChecked label="Option A" />
            <Radio name="opt" label="Option B" />
            <Radio name="opt" disabled label="Disabled" />
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Radio card</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <RadioCard name="tgt" defaultChecked selected title="Automatic" description="Amazon targets relevant searches" />
            <RadioCard name="tgt" title="Manual" description="You choose keywords & products" />
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Tooltip</div>
          <Tooltip label="Helpful hint shown on hover">
            <Button size="sm">Hover me</Button>
          </Tooltip>

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Spinner</div>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <Spinner />
            <Spinner size={22} />
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Skeleton</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 240 }}>
            <Skeleton width={200} height={12} />
            <Skeleton width={140} height={12} />
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Kbd</div>
          <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)', margin: '18px 0 10px' }}>Divider</div>
          <Divider />
        </Card>
      </section>

      <Section title="Typography" desc="Inter via --font-sans, rendered with H10's heavier (auto) smoothing.">
        <Card>
          {Object.entries(fontSize).map(([k, v]) => (
            <div key={k} style={{ display: 'flex', alignItems: 'baseline', gap: 16, padding: '5px 0', borderBottom: '1px solid var(--h10-border-subtle)' }}>
              <code style={{ fontFamily: mono, fontSize: 12, color: 'var(--h10-text-3)', width: 120, flexShrink: 0 }}>
                {k} · {v}
              </code>
              <span style={{ fontSize: v, fontWeight: fontWeight.semibold }}>The quick brown fox</span>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 18, marginTop: 12, flexWrap: 'wrap' }}>
            {Object.entries(fontWeight).map(([k, v]) => (
              <span key={k} style={{ fontSize: 15, fontWeight: v }}>
                {k} {v}
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 18, marginTop: 10, flexWrap: 'wrap', fontSize: 12, color: 'var(--h10-text-3)', fontFamily: mono }}>
            {Object.entries(letterSpacing).map(([k, v]) => (
              <span key={k}>
                {k}: {v}
              </span>
            ))}
          </div>
        </Card>
      </Section>

      <Section title="Spacing">
        <Card>
          {Object.entries(space).map(([k, v]) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '3px 0' }}>
              <code style={{ fontFamily: mono, fontSize: 12, color: 'var(--h10-text-3)', width: 90, flexShrink: 0 }}>
                {k} · {v}
              </code>
              <div style={{ height: 12, width: v, background: 'var(--h10-primary)', borderRadius: 3 }} />
            </div>
          ))}
          <div style={{ fontSize: 12, color: 'var(--h10-text-3)', fontFamily: mono, marginTop: 10 }}>
            structural: rail {size.railCollapsed}→{size.railExpanded} · nav row {size.rowNav} · icon zone {size.iconZone}
          </div>
        </Card>
      </Section>

      <Section title="Radius">
        <Card>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18 }}>
            {Object.entries(radius).map(([k, v]) => (
              <div key={k} style={{ textAlign: 'center' }}>
                <div style={{ width: 64, height: 64, background: 'var(--h10-wash-primary)', border: '1px solid var(--h10-primary-ghost-border)', borderRadius: v === '999px' ? '999px' : v }} />
                <div style={{ fontSize: 11, fontFamily: mono, color: 'var(--h10-text-3)', marginTop: 6 }}>
                  {k}·{v}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </Section>

      <Section title="Elevation & focus">
        <Card>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 26 }}>
            {Object.entries(shadow).map(([k, v]) => (
              <div key={k} style={{ textAlign: 'center' }}>
                <div style={{ width: 132, height: 64, background: 'var(--h10-surface)', borderRadius: 10, boxShadow: v }} />
                <div style={{ fontSize: 11, fontFamily: mono, color: 'var(--h10-text-3)', marginTop: 10 }}>{k}</div>
              </div>
            ))}
            <div style={{ textAlign: 'center' }}>
              <div style={{ width: 132, height: 64, background: 'var(--h10-surface)', borderRadius: 8, boxShadow: focusRing, border: '1px solid var(--h10-primary)' }} />
              <div style={{ fontSize: 11, fontFamily: mono, color: 'var(--h10-text-3)', marginTop: 10 }}>focus ring</div>
            </div>
          </div>
        </Card>
      </Section>

      <Section title="Motion · z-index · breakpoints">
        <Card>
          <div style={{ fontFamily: mono, fontSize: 12, color: 'var(--h10-text-2)', lineHeight: 1.9 }}>
            <div>motion: {Object.entries(duration).map(([k, v]) => `${k} ${v}`).join(' · ')}</div>
            <div>z-index: {Object.entries(zIndex).map(([k, v]) => `${k} ${v}`).join(' · ')}</div>
            <div>breakpoints: {Object.entries(breakpoint).map(([k, v]) => `${k} ${v}`).join(' · ')}</div>
          </div>
        </Card>
      </Section>
    </div>
  )
}
