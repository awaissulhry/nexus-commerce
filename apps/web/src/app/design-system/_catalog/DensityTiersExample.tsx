'use client'

import { Package } from 'lucide-react'

import { DensityProvider, useDensityTokens } from '@/design-system/lib/density'
import { DENSITIES, DENSITY_TOKENS, densityCss, type DensityName, type DensityTokenKey } from '@/design-system/tokens/density'

/*
 * 2026-10-28 — the page density tiers (`tokens/density.ts`). Each card is its own `DensityProvider`, so everything inside
 * it reads that tier's `--nds-density-*` tokens; the dashed boxes are MEASUREMENTS of those tokens, not controls (no DS
 * control reads them yet — a component opts in). Verify, light and dark, 1440 and 390 px: standard shows the console's
 * sizes (30 px control, 13 px body, 22 px figure); comfortable 44 px controls and a 16 px body; floor 56 px controls,
 * a 64 px primary, an 18 px body and a 40 px figure, with 48 px between separate targets. The icon is drawn at the TS
 * number (`useDensityTokens().icon`) inside a box drawn at the CSS token, so the two must line up.
 */
const USE: { readonly [D in DensityName]: string } = {
  standard: 'The office console, every existing page. The default.',
  comfortable: 'Portal and link pages, phone first.',
  floor: 'Tablets on the factory floor, gloved hands.',
}

const mono = 'var(--nds-font-mono)'
const keys = Object.keys(DENSITY_TOKENS) as DensityTokenKey[]
const short = (k: DensityTokenKey) => DENSITY_TOKENS[k].css.replace('--nds-density-', '')
/** The existing token a value is written as (`space-48`), or nothing for a px literal. */
const source = (css: string) => /^var\(--nds-(.+)\)$/.exec(css)?.[1]

const NOTE = { fontSize: 'var(--nds-font-size-xs)', fontFamily: mono, color: 'var(--nds-text-3)' } as const
const EYEBROW = { fontSize: 'var(--nds-font-size-xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--nds-text-3)' } as const

/** A box drawn at a height token, labelled with what it measures. */
function Measure({ label, height, primary = false }: { label: string; height: string; primary?: boolean }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height,
        padding: '0 var(--nds-density-pad-x)',
        borderRadius: 'var(--nds-density-radius)',
        border: `1px dashed ${primary ? 'var(--nds-primary)' : 'var(--nds-border-strong)'}`,
        background: primary ? 'var(--nds-wash-primary)' : 'var(--nds-surface-raised)',
        color: primary ? 'var(--nds-text-link)' : 'var(--nds-text-2)',
        fontSize: 'var(--nds-density-font-label)',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </div>
  )
}

function TierCard({ density }: { density: DensityName }) {
  const t = useDensityTokens()
  return (
    <div
      id={`density-${density}`}
      style={{
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--nds-space-14)',
        padding: 'var(--nds-space-16)',
        background: 'var(--nds-surface)',
        border: '1px solid var(--nds-border-subtle)',
        borderRadius: 'var(--nds-radius-2xl)',
      }}
    >
      <div>
        <div style={{ fontSize: 'var(--nds-font-size-md)', fontWeight: 700, color: 'var(--nds-text)' }}>{t.density}</div>
        <div style={{ fontSize: 'var(--nds-font-size-sm)', color: 'var(--nds-text-2)' }}>{USE[density]}</div>
      </div>

      <div style={EYEBROW}>Targets</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 'var(--nds-density-gap)' }}>
        <Measure label={`target ${t.targetMin}`} height="var(--nds-density-target-min)" />
        <Measure label={`small ${t.controlHSm}`} height="var(--nds-density-control-h-sm)" />
        <Measure label={`control ${t.controlH}`} height="var(--nds-density-control-h)" />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--nds-density-target-gap)' }}>
        <Measure label={`primary ${t.controlHPrimary}`} height="var(--nds-density-control-h-primary)" primary />
        <Measure label="next target" height="var(--nds-density-control-h-primary)" primary />
      </div>
      <span style={NOTE}>
        gap in a group {t.gap} · between separate targets {t.targetGap}
      </span>

      <div style={EYEBROW}>Type</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--nds-space-4)' }}>
        <span style={{ fontSize: 'var(--nds-density-font-label)', fontWeight: 600, color: 'var(--nds-text-2)' }}>Pieces counted · label {t.fontLabel}</span>
        <span style={{ fontSize: 'var(--nds-density-font-body)', color: 'var(--nds-text)', lineHeight: 1.4 }}>Scan the bundle, then count each size. · body {t.fontBody}</span>
        <span style={{ fontSize: 'var(--nds-density-font-numeral)', fontWeight: 800, lineHeight: 1.1, color: 'var(--nds-text)', fontVariantNumeric: 'tabular-nums' }}>1 248</span>
        <span style={NOTE}>numeral {t.fontNumeral}</span>
      </div>

      <div style={EYEBROW}>Icon and focus</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--nds-space-16)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--nds-space-8)' }}>
          <span style={{ display: 'inline-flex', width: 'var(--nds-density-icon)', height: 'var(--nds-density-icon)', outline: '1px dashed var(--nds-border-strong)', color: 'var(--nds-text)' }}>
            <Package size={t.icon} aria-hidden />
          </span>
          <span style={NOTE}>icon {t.icon}</span>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--nds-space-8)' }}>
          <span
            style={{
              display: 'inline-block',
              width: 'var(--nds-space-40)',
              height: 'var(--nds-space-24)',
              borderRadius: 'var(--nds-density-radius)',
              border: '1px solid var(--nds-primary)',
              background: 'var(--nds-surface)',
              outline: 'var(--nds-density-focus-w) solid var(--nds-text)',
              outlineOffset: 'var(--nds-density-focus-offset)',
            }}
          />
          <span style={NOTE}>
            focus {t.focusW} · offset {t.focusOffset}
          </span>
        </span>
      </div>

      <div style={EYEBROW}>Tokens (px · the existing token it is written as)</div>
      <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(0, auto) minmax(0, 1fr)', columnGap: 'var(--nds-space-10)', rowGap: 'var(--nds-space-2)', margin: 0, ...NOTE }}>
        {keys.map((k) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{short(k)}</dt>
            <dd style={{ margin: 0, color: 'var(--nds-text-2)', overflowWrap: 'break-word' }}>
              {t[k]}
              {source(densityCss[density][k]) && <span style={{ color: 'var(--nds-text-3)' }}> · {source(densityCss[density][k])}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export function DensityTiersExample() {
  return (
    <section id="density-tiers-example" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--nds-space-12)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: 'var(--nds-space-16)', alignItems: 'start' }}>
        {DENSITIES.map((d) => (
          <DensityProvider key={d} value={d}>
            <TierCard density={d} />
          </DensityProvider>
        ))}
      </div>
      <p style={{ margin: 0, fontSize: 'var(--nds-font-size-sm)', color: 'var(--nds-text-2)' }}>
        A subtree switches with <code style={{ fontFamily: mono }}>{'<DensityProvider value="floor">'}</code> (or{' '}
        <code style={{ fontFamily: mono }}>data-density=&quot;floor&quot;</code> on a screen&rsquo;s root, so pop-ups follow). Tokens only:
        no control reads <code style={{ fontFamily: mono }}>--nds-density-*</code> yet, so nothing that exists changes size.
      </p>
    </section>
  )
}
