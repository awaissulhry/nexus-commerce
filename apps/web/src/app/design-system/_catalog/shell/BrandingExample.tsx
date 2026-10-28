'use client'

// The branding stylesheet is the app's to load (tokens/branding.ts); the catalog loads it where it shows a brand.
import '@/design-system/styles/branding.css'
import { useMemo, useState, type CSSProperties } from 'react'
import { Button } from '@/design-system/primitives/Button'
import { Input } from '@/design-system/primitives/Input'
import { Field } from '@/design-system/components/Field'
import { KeyValue } from '@/design-system/components/KeyValue'
import { BRAND_CONTRAST, brandingAttrs, checkBranding, type BrandThemeVerdict, type BrandingTokens } from '@/design-system/tokens'

/*
 * 2026-10-28 — G20, tenant branding tokens. Pick a fictional brand or type colours: the preview is a `[data-brand]`
 * subtree, so the primary button, the accent text and the rule under the header take the colour only where it passed.
 * Verify, light AND dark (switch the page theme), 390 and 1440 px: Navy is the fill and the rule in both themes (its
 * dark colour is the light blue); Rosso is only the rule, in light; Pale is refused in light and used in dark; an
 * invalid colour is said so and changes nothing.
 */

/** A small geometric logo, as an inline image (a tenant's logo is a file address or an inline image). */
const MONOGRAM = `data:image/svg+xml;base64,${typeof btoa === 'function' ? btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1d3557"/><path d="M16 6l10 10-10 10L6 16z" fill="#a8c5ff"/><circle cx="16" cy="16" r="3.5" fill="#1d3557"/></svg>') : ''}`

const PRESETS: Array<{ id: string; label: string; brand: BrandingTokens }> = [
  { id: 'navy', label: 'Navy', brand: { name: 'Atelier Example', logoUrl: MONOGRAM, accent: '#1d3557', accentDark: '#a8c5ff' } },
  { id: 'rosso', label: 'Rosso', brand: { name: 'Rosso Example', accent: '#c0392b' } },
  { id: 'pale', label: 'Pale', brand: { name: 'Pale Example', accent: '#9ecbff' } },
  { id: 'none', label: 'No colour', brand: { name: 'Plain Example' } },
]

const HEAD: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '3px solid var(--nds-brand-accent, var(--nds-primary))', background: 'var(--nds-surface)' }

function Verdict({ verdict }: { verdict: BrandThemeVerdict }) {
  const weakest = verdict.pairs[0]
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 'var(--nds-font-size-xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--nds-text-3)', marginBottom: 6 }}>
        {verdict.theme}
      </div>
      <KeyValue
        dense
        labelCase="sentence"
        items={[
          { label: 'Colour', value: verdict.colour ?? (verdict.invalid ? 'Not a colour — ignored' : 'None given') },
          { label: `Button fill and accent text (${BRAND_CONTRAST.primary}:1)`, value: verdict.primary ? 'Used' : 'Design-system colour' },
          { label: `Decoration (${BRAND_CONTRAST.accent}:1)`, value: verdict.accent ? 'Used' : 'Design-system colour' },
          { label: 'Weakest pair', value: weakest ? `${weakest.pair}: ${weakest.ratio}:1` : '—' },
        ]}
      />
    </div>
  )
}

export function BrandingExample() {
  const [preset, setPreset] = useState('navy')
  const base = PRESETS.find((p) => p.id === preset)!.brand
  const [accent, setAccent] = useState<string | null>(null)
  const [accentDark, setAccentDark] = useState<string | null>(null)
  const brand: BrandingTokens = { ...base, accent: accent ?? base.accent, accentDark: accentDark ?? base.accentDark }
  const check = useMemo(() => checkBranding(brand), [brand.name, brand.logoUrl, brand.accent, brand.accentDark])
  const pick = (id: string) => {
    setPreset(id)
    setAccent(null)
    setAccentDark(null)
  }
  return (
    <section id="branding-example">
      <h3>Branding · a tenant&apos;s logo, name and accent</h3>
      <p>
        <code>brandingAttrs(branding)</code> on a subtree&apos;s root sets <code>data-brand</code> and the{' '}
        <code>--nds-brand-*</code> properties; <code>styles/branding.css</code> (loaded by the app that shows branded pages)
        maps them onto <code>--nds-primary</code>,{' '}
        <code>--nds-primary-hover</code> and <code>--nds-brand-accent</code> there. Per theme, the colour is the button
        fill and accent text only when it clears the seven pairs <code>check-nds-contrast</code> holds the primary to
        (7:1), and decoration only when it clears 3:1 on the surfaces. Otherwise that role keeps the design-system colour.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }} role="group" aria-label="Example brands">
        {PRESETS.map((p) => (
          <Button key={p.id} size="sm" active={preset === p.id} aria-pressed={preset === p.id} onClick={() => pick(p.id)}>
            {p.label}
          </Button>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <Field label="Accent (light)" hint="#rrggbb">
          <Input value={accent ?? base.accent ?? ''} onChange={(e) => setAccent(e.target.value)} style={{ width: 140 }} />
        </Field>
        <Field label="Accent (dark)" hint="Empty: the light one is tried">
          <Input value={accentDark ?? base.accentDark ?? ''} onChange={(e) => setAccentDark(e.target.value)} style={{ width: 140 }} />
        </Field>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20, alignItems: 'start' }}>
        <div {...brandingAttrs(check)} style={{ ...brandingAttrs(check).style, border: '1px solid var(--nds-border)', borderRadius: 'var(--nds-radius-xl)', overflow: 'hidden', background: 'var(--nds-bg)' }}>
          <div style={HEAD}>
            {/* The name is written beside the logo, so the logo is decorative here (alt=""); alone, it would carry the name. */}
            {check.logoUrl ? <img src={check.logoUrl} alt="" width={32} height={32} /> : null}
            <strong style={{ fontSize: 'var(--nds-font-size-md)' }}>{check.name}</strong>
          </div>
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
            <span style={{ color: 'var(--nds-text-2)' }}>Quote Q-0001 · valid until 30 November</span>
            <span style={{ color: 'var(--nds-primary)', fontWeight: 600 }}>Accent text: 2 documents need your answer</span>
            <Button variant="primary">Accept the quote</Button>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
          <Verdict verdict={check.light} />
          <Verdict verdict={check.dark} />
        </div>
      </div>
    </section>
  )
}
