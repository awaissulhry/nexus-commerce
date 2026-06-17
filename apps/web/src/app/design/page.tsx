'use client'

/**
 * /design — P0 living style guide (UI_REBUILD_STRATEGY.md).
 *
 * One screen to judge the new design language: the Inter font, the
 * hybrid type scale, semantic AA text colours, solid surfaces +
 * elevation, visible borders, and solid status tones — plus an
 * explicit BEFORE/AFTER of the three things the rebuild fixes
 * (thin text, translucent highlights, invisible borders).
 *
 * Every token below is written as a LITERAL class string so Tailwind's
 * JIT scanner emits it. Toggle dark mode (top-right) to see the same
 * tokens flip via the `.dark` class — the previously-missing half of
 * the dark-mode story.
 */

import { useState } from 'react'

const COMFORTABLE = [
  { token: 'text-4xl', cls: 'text-4xl', px: '32 / 38', sample: 'Display' },
  { token: 'text-3xl', cls: 'text-3xl', px: '24 / 30', sample: 'Page title' },
  { token: 'text-2xl', cls: 'text-2xl', px: '18 / 24', sample: 'Section heading' },
  { token: 'text-body-lg', cls: 'text-body-lg', px: '16 / 24', sample: 'Lead paragraph' },
  { token: 'text-body', cls: 'text-body', px: '14 / 21', sample: 'Comfortable body — dashboards, forms, prose' },
]

const COMPACT = [
  { token: 'text-lg', cls: 'text-lg', px: '14 / 20', sample: 'Table emphasis' },
  { token: 'text-md', cls: 'text-md', px: '13 / 18', sample: 'Table cell' },
  { token: 'text-base', cls: 'text-base', px: '12 / 16', sample: 'Dense table default' },
  { token: 'text-sm', cls: 'text-sm', px: '11 / 15', sample: 'Meta / caption' },
  { token: 'text-xs', cls: 'text-xs', px: '10 / 14', sample: 'Micro label' },
]

const WEIGHTS = [
  { token: 'font-body', cls: 'font-body', w: '450', sample: 'Body text reads solid, not thin' },
  { token: 'font-label', cls: 'font-label', w: '550', sample: 'Field labels and table headers' },
  { token: 'font-heading', cls: 'font-heading', w: '650', sample: 'Headings carry weight' },
  { token: 'font-bold', cls: 'font-bold', w: '700', sample: 'Strong emphasis' },
]

const TEXT_TOKENS = [
  { token: 'text-primary', cls: 'text-primary', ratio: '17.4 : 1', note: 'Headings, key values', pass: true },
  { token: 'text-secondary', cls: 'text-secondary', ratio: '7.5 : 1', note: 'Body, secondary info', pass: true },
  { token: 'text-tertiary', cls: 'text-tertiary', ratio: '4.7 : 1', note: 'Meta, captions', pass: true },
  { token: 'text-link', cls: 'text-link', ratio: '5.2 : 1', note: 'Links, interactive text', pass: true },
  { token: 'text-disabled', cls: 'text-disabled', ratio: '2.9 : 1', note: 'Disabled / decorative only', pass: false },
]

const SURFACES = [
  { token: 'bg-canvas', cls: 'bg-canvas', note: 'Page background', shadow: '' },
  { token: 'bg-card', cls: 'bg-card', note: 'Panels, cards', shadow: 'shadow-default' },
  { token: 'bg-raised', cls: 'bg-raised', note: 'Elevated / hover', shadow: 'shadow-elevated' },
  { token: 'bg-sunken', cls: 'bg-sunken', note: 'Inset wells', shadow: 'shadow-inner' },
]

const BORDERS = [
  { token: 'border-subtle', cls: 'border-subtle', note: 'Nested rules' },
  { token: 'border-default', cls: 'border-default', note: 'Grid lines, card edges' },
  { token: 'border-strong', cls: 'border-strong', note: 'Section dividers' },
]

const STATUS = [
  { label: 'Success', soft: 'bg-success-soft', strong: 'text-success-strong', line: 'border-success-line', dot: 'bg-success-strong' },
  { label: 'Warning', soft: 'bg-warning-soft', strong: 'text-warning-strong', line: 'border-warning-line', dot: 'bg-warning-strong' },
  { label: 'Danger', soft: 'bg-danger-soft', strong: 'text-danger-strong', line: 'border-danger-line', dot: 'bg-danger-strong' },
  { label: 'Info', soft: 'bg-info-soft', strong: 'text-info-strong', line: 'border-info-line', dot: 'bg-info-strong' },
]

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-subtle py-10">
      <div className="mb-5">
        <h2 className="text-2xl font-heading text-primary">{title}</h2>
        {desc && <p className="mt-1 text-body text-secondary">{desc}</p>}
      </div>
      {children}
    </section>
  )
}

function AaPill({ pass }: { pass: boolean }) {
  return pass ? (
    <span className="inline-flex items-center gap-1 rounded-md bg-success-soft px-2 py-0.5 text-xs font-label text-success-strong">
      AA ✓
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-md bg-warning-soft px-2 py-0.5 text-xs font-label text-warning-strong">
      decorative
    </span>
  )
}

export default function DesignSystemPage() {
  const [dark, setDark] = useState(false)

  return (
    <div className={dark ? 'dark' : ''}>
      <div className="min-h-screen bg-canvas">
        <div className="mx-auto max-w-5xl px-8 py-10">
          {/* Header */}
          <header className="flex items-start justify-between gap-4 border-b border-default pb-6">
            <div>
              <h1 className="text-4xl font-heading text-primary">Design language</h1>
              <p className="mt-2 max-w-2xl text-body-lg text-secondary">
                P0 of the UI rebuild. Inter, a hybrid type scale, AA-contrast semantic
                colours, solid surfaces, and visible borders — the foundation every
                page sweeps onto next.
              </p>
            </div>
            <button
              onClick={() => setDark((d) => !d)}
              className="shrink-0 rounded-lg border border-default bg-card px-4 py-2 text-md font-label text-primary shadow-subtle transition-colors hover:bg-raised"
            >
              {dark ? '☀ Light' : '☾ Dark'}
            </button>
          </header>

          {/* Typography */}
          <Section
            title="Typography"
            desc="Inter (variable). Comfortable scale for dashboards & prose; compact scale retained for dense tables — the hybrid you chose."
          >
            <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
              <div className="rounded-xl border border-default bg-card p-6 shadow-default">
                <p className="mb-4 text-sm font-label uppercase tracking-wide text-tertiary">Comfortable · dashboards</p>
                <div className="space-y-3">
                  {COMFORTABLE.map((t) => (
                    <div key={t.token} className="flex items-baseline justify-between gap-4">
                      <span className={`${t.cls} font-heading text-primary truncate`}>{t.sample}</span>
                      <span className="shrink-0 font-mono text-xs text-tertiary">
                        {t.token} · {t.px}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-xl border border-default bg-card p-6 shadow-default">
                <p className="mb-4 text-sm font-label uppercase tracking-wide text-tertiary">Compact · work tables</p>
                <div className="space-y-3">
                  {COMPACT.map((t) => (
                    <div key={t.token} className="flex items-baseline justify-between gap-4">
                      <span className={`${t.cls} text-primary truncate`}>{t.sample}</span>
                      <span className="shrink-0 font-mono text-xs text-tertiary">
                        {t.token} · {t.px}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-6 rounded-xl border border-default bg-card p-6 shadow-default">
              <p className="mb-4 text-sm font-label uppercase tracking-wide text-tertiary">Weights</p>
              <div className="space-y-2">
                {WEIGHTS.map((w) => (
                  <div key={w.token} className="flex items-baseline justify-between gap-4">
                    <span className={`${w.cls} text-body-lg text-primary`}>{w.sample}</span>
                    <span className="shrink-0 font-mono text-xs text-tertiary">
                      {w.token} · {w.w}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Section>

          {/* Text colour */}
          <Section
            title="Text colour"
            desc="Every body token passes WCAG AA (≥4.5:1). Replaces 6,485 raw text-slate-400 (4.2:1, fails). Ratios shown for light mode."
          >
            <div className="overflow-hidden rounded-xl border border-default bg-card shadow-default">
              {TEXT_TOKENS.map((t, i) => (
                <div
                  key={t.token}
                  className={`flex items-center justify-between gap-4 px-6 py-4 ${i > 0 ? 'border-t border-subtle' : ''}`}
                >
                  <span className={`${t.cls} text-body-lg font-label`}>
                    The quick brown fox · €1,284.50 net margin
                  </span>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="font-mono text-xs text-tertiary">{t.note}</span>
                    <span className="w-24 text-right font-mono text-sm text-secondary">{t.ratio}</span>
                    <AaPill pass={t.pass} />
                    <span className="w-28 text-right font-mono text-xs text-tertiary">{t.token}</span>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {/* Surfaces + elevation */}
          <Section
            title="Surfaces & elevation"
            desc="Solid surfaces with shadow-based hierarchy — no translucent tints. Toggle dark to see them flip."
          >
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {SURFACES.map((s) => (
                <div key={s.token} className="rounded-xl border border-default bg-card p-2 shadow-default">
                  <div className={`${s.cls} ${s.shadow} flex h-24 items-center justify-center rounded-lg border border-subtle`}>
                    <span className="font-mono text-xs text-tertiary">{s.token}</span>
                  </div>
                  <p className="mt-2 px-1 text-sm text-secondary">{s.note}</p>
                </div>
              ))}
            </div>
          </Section>

          {/* Borders */}
          <Section
            title="Borders"
            desc="Default is slate-300 (visible), not the old slate-200 (~1.4:1, invisible). Grids and cards now anchor the eye."
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {BORDERS.map((b) => (
                <div key={b.token} className="rounded-xl bg-card p-2">
                  <div className={`flex h-20 items-center justify-center rounded-lg border-2 bg-canvas ${b.cls}`}>
                    <span className="font-mono text-xs text-tertiary">{b.token}</span>
                  </div>
                  <p className="mt-2 px-1 text-sm text-secondary">{b.note}</p>
                </div>
              ))}
            </div>
          </Section>

          {/* Status */}
          <Section
            title="Status tones"
            desc="Solid soft / line / strong triples. The replacement for bg-*-950/40 translucent tints that washed out over tables."
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {STATUS.map((s) => (
                <div key={s.label} className={`rounded-xl border ${s.line} ${s.soft} p-4`}>
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${s.dot}`} />
                    <span className={`text-md font-heading ${s.strong}`}>{s.label}</span>
                  </div>
                  <p className={`mt-2 text-sm ${s.strong}`}>
                    Solid fill, defined edge, AA text — legible over any surface.
                  </p>
                </div>
              ))}
            </div>
          </Section>

          {/* Before / After */}
          <Section
            title="Before → after"
            desc="The three measured problems, side by side. Left = what's in the app today; right = the new tokens."
          >
            <div className="space-y-6">
              {/* Thin text */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-default bg-card p-5 shadow-default">
                  <p className="mb-3 text-xs font-label uppercase tracking-wide text-tertiary">Before · text-slate-400</p>
                  <p className="text-slate-400">
                    Net profit after Amazon fees and COGS for the trailing 30 days,
                    blended across all EU marketplaces.
                  </p>
                </div>
                <div className="rounded-xl border border-default bg-card p-5 shadow-default">
                  <p className="mb-3 text-xs font-label uppercase tracking-wide text-tertiary">After · text-secondary</p>
                  <p className="text-secondary">
                    Net profit after Amazon fees and COGS for the trailing 30 days,
                    blended across all EU marketplaces.
                  </p>
                </div>
              </div>

              {/* Translucent highlight */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-default bg-slate-900 p-5">
                  <p className="mb-3 text-xs font-label uppercase tracking-wide text-slate-400">Before · bg-rose-950/40</p>
                  <div className="rounded-lg border border-rose-900/40 bg-rose-950/40 px-4 py-3">
                    <span className="text-sm text-rose-300">Buy Box lost on 3 ASINs — washed out over the panel.</span>
                  </div>
                </div>
                <div className="rounded-xl border border-default bg-slate-900 p-5">
                  <p className="mb-3 text-xs font-label uppercase tracking-wide text-slate-400">After · bg-danger-soft</p>
                  <div className="dark rounded-lg border border-danger-line bg-danger-soft px-4 py-3">
                    <span className="text-sm font-label text-danger-strong">Buy Box lost on 3 ASINs — solid, unmistakable.</span>
                  </div>
                </div>
              </div>

              {/* Faint border */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-default bg-card p-5 shadow-default">
                  <p className="mb-3 text-xs font-label uppercase tracking-wide text-tertiary">Before · border-slate-200</p>
                  <table className="w-full text-md text-primary">
                    <tbody>
                      {['XAV-001', 'XAV-002', 'XAV-003'].map((s, i) => (
                        <tr key={s} className={i > 0 ? 'border-t border-slate-200' : ''}>
                          <td className="py-2">{s}</td>
                          <td className="py-2 text-right text-slate-400">in stock</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="rounded-xl border border-default bg-card p-5 shadow-default">
                  <p className="mb-3 text-xs font-label uppercase tracking-wide text-tertiary">After · border-default</p>
                  <table className="w-full text-md text-primary">
                    <tbody>
                      {['XAV-001', 'XAV-002', 'XAV-003'].map((s, i) => (
                        <tr key={s} className={i > 0 ? 'border-t border-default' : ''}>
                          <td className="py-2">{s}</td>
                          <td className="py-2 text-right text-secondary">in stock</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </Section>

          <footer className="py-10">
            <p className="text-sm text-tertiary">
              P0 · design tokens. Additive — existing pages are unchanged until the P3 sweep adopts these tokens.
            </p>
          </footer>
        </div>
      </div>
    </div>
  )
}
