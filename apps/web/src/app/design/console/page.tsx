'use client'

/**
 * /design/console — P0-FC futuristic "Console" preview
 * (UI_REBUILD_STRATEGY.md).
 *
 * A faux operator dashboard rendered entirely in the chosen language:
 * dark-first canvas + atmosphere, Quantum (indigo→cyan) accent with
 * glow, BALANCED glass (frosted chrome/cards, SOLID dense table),
 * Space Grotesk display + JetBrains Mono numerals, neon sparklines.
 *
 * SCOPED — the whole page is wrapped in `.dark .theme-console`, so it
 * previews the look without flipping the live app. Nothing here changes
 * any real page; it's the artifact to judge the direction.
 */

import { useState } from 'react'

// ── Neon sparkline (gradient stroke + soft area) ────────────────────
function Sparkline({ id, points, dir }: { id: string; points: number[]; dir: 'up' | 'down' }) {
  const w = 132
  const h = 40
  const max = Math.max(...points)
  const min = Math.min(...points)
  const norm = (v: number) => h - 5 - ((v - min) / (max - min || 1)) * (h - 12)
  const step = w / (points.length - 1)
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(1)} ${norm(p).toFixed(1)}`).join(' ')
  const area = `${line} L ${w} ${h} L 0 ${h} Z`
  const down = dir === 'down'
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={down ? 'rgb(251 113 133)' : 'rgb(99 102 241)'} />
          <stop offset="100%" stopColor={down ? 'rgb(244 63 94)' : 'rgb(34 211 238)'} />
        </linearGradient>
        <linearGradient id={`${id}-f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={down ? 'rgb(244 63 94 / 0.24)' : 'rgb(34 211 238 / 0.22)'} />
          <stop offset="100%" stopColor="transparent" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id}-f)`} />
      <path
        d={line}
        fill="none"
        stroke={`url(#${id})`}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function Delta({ dir, children }: { dir: 'up' | 'down'; children: React.ReactNode }) {
  const up = dir === 'up'
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-mono font-semibold ${
        up ? 'bg-success-soft text-success-strong' : 'bg-danger-soft text-danger-strong'
      }`}
    >
      {up ? '▲' : '▼'} {children}
    </span>
  )
}

function StatCard({
  label, sub, value, dir, delta, spark, id,
}: {
  label: string; sub: string; value: string; dir: 'up' | 'down'; delta: string; spark: number[]; id: string
}) {
  return (
    <div className="glass rounded-2xl p-5 transition-transform duration-base ease-out hover:-translate-y-0.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-label uppercase tracking-wider text-tertiary">{label}</span>
        <span className="text-xs font-mono text-tertiary">{sub}</span>
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          <div className="font-display text-3xl font-semibold tabular-nums text-primary">{value}</div>
          <div className="mt-2">
            <Delta dir={dir}>{delta}</Delta>
          </div>
        </div>
        <Sparkline id={id} points={spark} dir={dir} />
      </div>
    </div>
  )
}

const KPIS = [
  { id: 's1', label: 'Net Profit', sub: '30d', value: '€4,182.50', dir: 'up' as const, delta: '13.3%', spark: [30, 34, 31, 38, 44, 42, 52, 58] },
  { id: 's2', label: 'Orders', sub: 'today', value: '42', dir: 'up' as const, delta: '8', spark: [12, 18, 15, 22, 26, 24, 33, 38] },
  { id: 's3', label: 'Buy Box', sub: 'live', value: '87%', dir: 'down' as const, delta: '4%', spark: [70, 72, 68, 66, 60, 58, 55, 52] },
  { id: 's4', label: 'Units Sold', sub: '30d', value: '1,284', dir: 'up' as const, delta: '6.1%', spark: [40, 42, 46, 44, 50, 55, 53, 61] },
]

function Channel({ c }: { c: 'AMAZON' | 'EBAY' | 'SHOPIFY' }) {
  const dot = c === 'AMAZON' ? 'bg-amber-400' : c === 'EBAY' ? 'bg-sky-400' : 'bg-emerald-400'
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs text-secondary">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {c}
    </span>
  )
}

function Status({ kind }: { kind: 'active' | 'low' | 'out' }) {
  const map = {
    active: ['bg-success-soft', 'text-success-strong', 'border-success-line', 'Active'],
    low: ['bg-warning-soft', 'text-warning-strong', 'border-warning-line', 'Low stock'],
    out: ['bg-danger-soft', 'text-danger-strong', 'border-danger-line', 'Out of stock'],
  } as const
  const [bg, txt, bd, label] = map[kind]
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-label ${bg} ${txt} ${bd}`}>
      {label}
    </span>
  )
}

const ROWS = [
  { sku: 'XAV-J100-BK-M', name: 'Giacca Tponis Pro', ch: 'AMAZON' as const, stock: 142, margin: '31.2%', st: 'active' as const },
  { sku: 'XAV-G220-RD-L', name: 'Guanti Corsa GP', ch: 'EBAY' as const, stock: 38, margin: '27.8%', st: 'active' as const },
  { sku: 'XAV-H050-WT-XL', name: 'Casco Veloce X', ch: 'AMAZON' as const, stock: 7, margin: '22.1%', st: 'low' as const },
  { sku: 'XAV-B330-BK-S', name: 'Stivali Adventure', ch: 'SHOPIFY' as const, stock: 0, margin: '19.5%', st: 'out' as const },
  { sku: 'XAV-J140-GY-M', name: 'Giubbotto Urban', ch: 'AMAZON' as const, stock: 96, margin: '34.0%', st: 'active' as const },
  { sku: 'XAV-P070-BK-L', name: 'Paraschiena Lvl 2', ch: 'EBAY' as const, stock: 54, margin: '41.2%', st: 'active' as const },
]

const FEED = [
  { t: 'Order #IT-4821', d: 'Amazon.it · €128.40', ago: '2m' },
  { t: 'Buy Box regained', d: 'XAV-H050 · DE', ago: '5m' },
  { t: 'Stock synced', d: '12 SKUs · eBay', ago: '8m' },
  { t: 'Repricing applied', d: '4 SKUs adjusted', ago: '14m' },
  { t: 'Return resolved', d: 'XAV-G220 · refund', ago: '21m' },
]

export default function ConsolePreviewPage() {
  const [toggle, setToggle] = useState(true)

  return (
    <div className="dark theme-console">
      <div className="console-atmosphere min-h-screen">
        <div className="console-grid relative">
          <div className="mx-auto max-w-6xl px-6 py-6">
            {/* Top bar — glass chrome */}
            <header className="glass-strong sticky top-4 z-20 flex items-center justify-between rounded-2xl px-5 py-3">
              <div className="flex items-center gap-3">
                <span className="text-accent-bright">◆</span>
                <span className="font-display text-xl font-bold text-gradient-accent">NEXUS</span>
                <span className="rounded-md border border-accent/30 bg-accent/10 px-2 py-0.5 text-xs font-label text-accent-bright">
                  Console preview
                </span>
              </div>
              <div className="hidden items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-tertiary md:flex">
                <span>Search products, orders, SKUs…</span>
                <kbd className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 font-mono text-xs text-secondary">⌘K</kbd>
              </div>
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-label text-secondary">
                  <span className="console-pulse h-2 w-2 rounded-full bg-accent" />
                  Live
                </span>
                <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-accent-from to-accent-to font-display text-sm font-bold text-white">
                  X
                </span>
              </div>
            </header>

            {/* Hero line */}
            <div className="mt-8 flex items-end justify-between">
              <div>
                <p className="font-mono text-xs uppercase tracking-widest text-accent-bright">Operations · Xavia</p>
                <h1 className="mt-1 font-display text-4xl font-bold text-primary">Good evening.</h1>
                <p className="mt-1 text-body text-secondary">Here's where your catalogue stands across all EU markets.</p>
              </div>
              <button className="rounded-xl bg-gradient-to-r from-accent-from to-accent-to px-4 py-2.5 text-md font-label text-white shadow-glow transition-transform duration-fast hover:scale-[1.02]">
                + New campaign
              </button>
            </div>

            {/* KPI cards — glass */}
            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {KPIS.map((k) => (
                <StatCard key={k.id} {...k} />
              ))}
            </div>

            {/* Main + side */}
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
              {/* Data table — SOLID surface (balanced glass principle) */}
              <div className="rounded-2xl border border-subtle bg-card shadow-glow-card lg:col-span-2">
                <div className="flex items-center justify-between border-b border-subtle px-5 py-3.5">
                  <h2 className="font-display text-body-lg font-semibold text-primary">Top SKUs</h2>
                  <span className="font-mono text-xs text-tertiary">solid surface · dense</span>
                </div>
                <table className="w-full text-md">
                  <thead>
                    <tr className="text-left font-label text-xs uppercase tracking-wider text-tertiary">
                      <th className="px-5 py-2.5 font-label">SKU</th>
                      <th className="px-3 py-2.5 font-label">Product</th>
                      <th className="px-3 py-2.5 font-label">Channel</th>
                      <th className="px-3 py-2.5 text-right font-label">Stock</th>
                      <th className="px-3 py-2.5 text-right font-label">Margin</th>
                      <th className="px-5 py-2.5 font-label">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ROWS.map((r) => (
                      <tr key={r.sku} className="border-t border-subtle transition-colors duration-fast hover:bg-raised">
                        <td className="px-5 py-3 font-mono text-sm text-secondary">{r.sku}</td>
                        <td className="px-3 py-3 text-primary">{r.name}</td>
                        <td className="px-3 py-3"><Channel c={r.ch} /></td>
                        <td className={`px-3 py-3 text-right font-mono tabular-nums ${r.stock === 0 ? 'text-danger-strong' : r.stock < 10 ? 'text-warning-strong' : 'text-secondary'}`}>{r.stock}</td>
                        <td className="px-3 py-3 text-right font-mono tabular-nums text-primary">{r.margin}</td>
                        <td className="px-5 py-3"><Status kind={r.st} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Live activity — glass */}
              <div className="glass rounded-2xl p-5">
                <div className="flex items-center justify-between">
                  <h2 className="font-display text-body-lg font-semibold text-primary">Live activity</h2>
                  <span className="console-pulse h-2 w-2 rounded-full bg-accent" />
                </div>
                <ul className="mt-4 space-y-4">
                  {FEED.map((f, i) => (
                    <li key={i} className="flex items-start gap-3">
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent shadow-glow-sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-md font-label text-primary">{f.t}</p>
                        <p className="truncate text-sm text-tertiary">{f.d}</p>
                      </div>
                      <span className="font-mono text-xs text-tertiary">{f.ago}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* Component strip */}
            <div className="mt-4 rounded-2xl border border-subtle bg-card p-5 shadow-glow-card">
              <h2 className="mb-4 font-display text-body-lg font-semibold text-primary">Components</h2>
              <div className="flex flex-wrap items-center gap-6">
                {/* Buttons */}
                <div className="flex items-center gap-3">
                  <button className="rounded-lg bg-gradient-to-r from-accent-from to-accent-to px-4 py-2 text-md font-label text-white shadow-glow transition-transform duration-fast hover:scale-[1.02]">
                    Primary
                  </button>
                  <button className="glass rounded-lg px-4 py-2 text-md font-label text-primary transition-colors hover:bg-white/10">
                    Secondary
                  </button>
                  <button className="rounded-lg px-4 py-2 text-md font-label text-secondary transition-colors hover:text-primary">
                    Ghost
                  </button>
                </div>
                {/* Chips */}
                <div className="flex items-center gap-2">
                  <Status kind="active" />
                  <Status kind="low" />
                  <Status kind="out" />
                  <span className="inline-flex items-center rounded-md border border-info-line bg-info-soft px-2 py-0.5 text-xs font-label text-info-strong">Synced</span>
                </div>
                {/* Input with accent focus ring */}
                <input
                  defaultValue="XAV-J100-BK-M"
                  className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-mono text-sm text-primary outline-none transition-shadow placeholder:text-tertiary focus:border-accent/50 focus:shadow-glow"
                />
                {/* Toggle */}
                <button
                  onClick={() => setToggle((t) => !t)}
                  className={`relative h-6 w-11 rounded-full transition-colors duration-base ${toggle ? 'bg-gradient-to-r from-accent-from to-accent-to shadow-glow-sm' : 'bg-white/15'}`}
                  aria-pressed={toggle}
                >
                  <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-base ${toggle ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
              </div>
            </div>

            {/* Footer */}
            <footer className="flex items-center justify-between py-8">
              <p className="text-sm text-tertiary">
                Futuristic console preview · dark-first · Quantum accent · balanced glass.
              </p>
              <a href="/design" className="text-sm font-label text-accent-bright hover:underline">
                ← Clean P0 system
              </a>
            </footer>
          </div>
        </div>
      </div>
    </div>
  )
}
