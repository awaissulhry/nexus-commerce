'use client'

/**
 * THE campaign-row cells every ads grid shares — **name · status · bidding strategy**, plus the
 * label maps and the strategy modal behind them.
 *
 * 🔴 **Operator instruction, 2026-08-19:** *"I want it to be the same, exactly the same. I want you
 * to use shared components, not make copies of it, and make some slight differences in it. I want
 * to maintain proper consistencies across all the design systems and each and everything."*
 *
 * That is the whole brief, and it is stricter than "looks similar". The three columns below had
 * *drifted apart in behaviour*, not just in styling — the Ad Manager could change a campaign's
 * status and bidding strategy from the grid and Apply Rules could only read them, and Apply Rules'
 * name column deliberately opted OUT of the blue link treatment. So this file owns the markup, the
 * copy, the hover affordances AND the interactions; a consumer supplies the row's values and a
 * writer, nothing else. There is no `variant` prop and no page-specific copy prop on purpose:
 * every one of those is how the two pages diverged the first time.
 *
 * ── Why no CSS shipped with this ────────────────────────────────────────────────────────────────
 * `AdsDataGrid` renders `<td className="nm fz">` inside `.h10-am-grid`, the SAME markup the Ad
 * Manager's own table uses, so `ads.css`'s `td.nm .t` / `.nmw .h10-open` / `.h10-statuscell` /
 * `.h10-statusmenu` / `.h10-modal-*` rules already apply on every consumer. Apply Rules previously
 * fought that with `.h10-ar-nm` and `.h10-ar-open` (its own comment explains the specificity
 * dodge); adopting the shared markup makes the fight unnecessary rather than winning it.
 *
 * ── One endpoint per verb, so a grid edit and a bulk edit cannot disagree ────────────────────────
 * · status           → `PATCH /advertising/campaigns/:id { status, applyImmediately, reason }`
 * · biddingStrategy  → `PATCH /advertising/campaigns/:id { biddingStrategy, applyImmediately, reason }`
 * Both are gated writes: on a live market they push to Amazon, and a refusal at the write gate is
 * the gate working. Consumers pass `onChange`/`onConfirm` and report the outcome their own way.
 */
import { useState, type ReactNode } from 'react'
import { ChevronDown, ExternalLink, Lightbulb, Pencil, X } from 'lucide-react'
import { HoverCard } from '../campaigns/FilterDropdown'

// ── the label maps, defined once ────────────────────────────────────────────────────────────────

export const STATUS_PILL: Record<string, { label: string; cls: string }> = {
  ENABLED: { label: 'Enabled', cls: 'ok' },
  PAUSED: { label: 'Paused', cls: 'warn' },
  ARCHIVED: { label: 'Archived', cls: 'arch' },
}

/** Amazon's two live values on this account, plus the legacy spelling. */
export const STRAT_LABEL: Record<string, string> = {
  LEGACY_FOR_SALES: 'Down only', AUTO_FOR_SALES: 'Up and Down', MANUAL: 'Fixed',
  legacyForSales: 'Down only', autoForSales: 'Up and Down', manual: 'Fixed',
}

export const CAMPAIGN_TYPE_LABEL: Record<string, string> = {
  SPONSORED_PRODUCTS: 'Sponsored Products', SPONSORED_BRANDS: 'Sponsored Brands',
  SPONSORED_DISPLAY: 'Sponsored Display',
  SP: 'Sponsored Products', SB: 'Sponsored Brands', SD: 'Sponsored Display',
}

/** H10's three strategies, verbatim. */
export const STRATEGY_DEFS: Array<{ value: string; title: string; desc: string }> = [
  { value: 'LEGACY_FOR_SALES', title: 'Dynamic Bids - Down only', desc: 'Amazon lowers your bids in real time when your ad may be less likely to convert to a sale.' },
  { value: 'AUTO_FOR_SALES', title: 'Dynamic Bids - Up and Down', desc: 'Amazon raises your bids (by a maximum of 100%) in real time when your ad may be more likely to convert to a sale, and lower your bids when less likely to convert to a sale.' },
  { value: 'MANUAL', title: 'Fixed Bid', desc: "Amazon uses your exact bid and any manual adjustments you set, and won't change your bids based on likelihood of a sale." },
]

/** SP / SB / SD, from whichever of the two fields a payload happens to carry. */
export const productBadge = (c: { adProduct?: string | null; type?: string | null }): string =>
  (c.adProduct === 'SPONSORED_BRANDS' || c.type === 'SB') ? 'SB'
    : (c.adProduct === 'SPONSORED_DISPLAY' || c.type === 'SD') ? 'SD' : 'SP'

/** A(uto) / M(anual) — inferred from the name, because Amazon does not return it per campaign. */
export const targetingLetter = (name: string): string => /(^|[^a-z])auto([^a-z]|$)/i.test(name) ? 'A' : 'M'

const eur = (cents: number) => `€${(cents / 100).toFixed(2)}`

// ── the cells ───────────────────────────────────────────────────────────────────────────────────

/**
 * The first column: pacing bulb · targeting + product badges (both with hover cards) · the name in
 * link blue · market chip · **Open** (new tab, revealed on row hover) · **Assign**.
 *
 * 🔴 Apply Rules used to render a dark name and a plain "Open" text link, with a source comment
 * arguing that *"a blue name that does nothing when clicked is a promise the page cannot keep"*.
 * That reasoning was sound about the colour and wrong about the fix: the Ad Manager's name is blue
 * and also not itself a link — the promise is kept by the **Open** pill next to it, which is the
 * control H10 puts there. Diverging one grid from the other to solve it made the two pages behave
 * differently on the row every operator looks at first.
 */
export function CampaignNameCell({
  id, name, marketplace, status, dailyBudgetCents, type, adProduct, extra,
}: {
  id: string
  name: string
  marketplace?: string | null
  status: string
  /** null when the consumer does not carry it — the hover card says "—" rather than inventing 0 */
  dailyBudgetCents?: number | null
  type?: string | null
  adProduct?: string | null
  /** anything the consuming page needs AFTER the Open pill (the Ad Manager's Assign link) */
  extra?: ReactNode
}) {
  const letter = targetingLetter(name)
  return (
    <div className="nmw">
      {/* Budget Manager Auto Pacing status. Its own hover card, because it answers a different
          question from the badges beside it. */}
      <HoverCard placement="below" text="This campaign is not managed by Budget Manager Auto Pacing">
        <span className="bulb"><Lightbulb size={12} aria-hidden /></span>
      </HoverCard>
      <HoverCard rows={[
        ['Status', STATUS_PILL[status]?.label ?? status],
        ['Daily Budget', dailyBudgetCents != null ? eur(dailyBudgetCents) : '—'],
        ['Targeting Type', letter === 'A' ? 'Auto' : 'Manual'],
        ['Campaign Type', CAMPAIGN_TYPE_LABEL[type ?? adProduct ?? ''] ?? 'Sponsored Products'],
      ]}>
        <span className="tg" data-t={letter}>{letter}</span>
        <span className="pb" data-p={productBadge({ type, adProduct })}>{productBadge({ type, adProduct })}</span>
      </HoverCard>
      <span className="t" title={name}>{name}</span>
      {marketplace && <span className="mk">{marketplace}</span>}
      <a className="h10-open" href={`/marketing/ads/campaigns/${id}`} target="_blank" rel="noreferrer"
        title={`Open ${name} in the Ad Manager — performance, structure and its ~45 columns`}
        onClick={(e) => e.stopPropagation()}><ExternalLink size={11} aria-hidden /> Open</a>
      {/* AFTER Open, never before: Open is the primary action and H10 puts it first. */}
      {extra}
    </div>
  )
}

/**
 * Status: the pill, plus the chevron that opens **Archive / Pause / Enable**.
 *
 * The chevron is the only way to change a campaign's state from a grid, and it was on the Ad
 * Manager alone. `onChange` is async so the caller can await the gated PATCH and report a refusal.
 */
export function StatusCell({ status, name, onChange }: {
  status: string
  name: string
  /** omit to render the pill read-only — used for aggregate rows, which are not campaigns */
  onChange?: (next: 'ENABLED' | 'PAUSED' | 'ARCHIVED') => void
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const sp = STATUS_PILL[status] ?? { label: status, cls: '' }
  if (!onChange) return <span className={`h10-pill ${sp.cls}`}>{sp.label}</span>
  return (
    <span className="h10-statuscell">
      <span className={`h10-pill ${sp.cls}`}>{sp.label}</span>
      <button
        type="button" className="ch" aria-label={`Change status for ${name}`} aria-expanded={menu != null}
        onClick={(ev) => { const r = ev.currentTarget.getBoundingClientRect(); setMenu({ x: Math.max(8, r.right - 156), y: r.bottom + 5 }) }}
      ><ChevronDown size={13} aria-hidden /></button>
      {menu && (
        <>
          <button type="button" className="h10-menu-back" aria-label="Close" onClick={() => setMenu(null)} />
          <div className="h10-statusmenu" style={{ position: 'fixed', left: menu.x, top: menu.y }} role="menu">
            {(['ARCHIVED', 'PAUSED', 'ENABLED'] as const).map((s) => (
              <button key={s} type="button" role="menuitem" onClick={() => { setMenu(null); onChange(s) }}>
                {s === 'ARCHIVED' ? 'Archive' : s === 'PAUSED' ? 'Pause' : 'Enable'}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  )
}

/** Bidding strategy: the label, plus the hover pencil that opens `StrategyModal`. */
/**
 * ── C2 (2026-08-20) — ONE Automation cell, on both grids ────────────────────────────────────────
 *
 * The write gate (`liveBidWritesEnabled`) had two renderings under two names for one fact:
 *   Ad Manager  → column **"Automation"**  — Managed / Off-limits + pin badges + a bound count + a
 *                 suppression arrow, with a five-line tooltip.
 *   Apply Rules → column **"Automations"** — a pill reading `Managed · 2 bound` / `Off-limits`.
 * Same endpoint, same row, same boolean. The Ad Manager's is the richer one and is the one that
 * survives; Apply Rules' extra fact (it renders `unknown` when the guardrail grid has no row for a
 * campaign) survives too, as `missing`, because that is a distinction the Ad Manager silently
 * collapsed into an em dash.
 *
 * Takes primitives, like every other shared cell — the two grids carry different row types, and a
 * cell that took a row would force one of them to adopt the other's.
 */
export function AutomationCell({ managed, missing, pins, boundRuleNames, accountWideRules, suppressedAt, suppressedBy, minCents, maxCents }: {
  managed?: boolean
  /** true when the guardrail grid returned no row for this campaign — authority unknown, not open. */
  missing?: boolean
  pins?: { placement?: boolean; bids?: boolean; budget?: boolean } | null
  boundRuleNames?: string[]
  accountWideRules?: number
  suppressedAt?: string | null
  suppressedBy?: string | null
  minCents?: number | null
  maxCents?: number | null
}) {
  if (missing) {
    return <span className="h10-auto-cell"><span className="h10-rc-unknown" title="The guardrail grid returned no row for this campaign, so its authority is unknown — which is not the same as the gate being open.">unknown</span></span>
  }
  const shown = ([['placement', 'Plc'], ['bids', 'Bid'], ['budget', 'Bgt']] as const).filter(([k]) => pins?.[k])
  const bound = boundRuleNames ?? []
  const eur = (c: number) => `€${(c / 100).toFixed(2)}`
  const tip = [
    managed
      ? 'Managed: automation may write to this campaign.'
      : 'Not managed: every automated write here is refused at the gate (default-deny). Re-enabling a paused campaign does not re-allowlist it.',
    shown.length ? `Hands off: ${shown.map(([, s]) => s).join(', ')}` : 'No dimension is pinned.',
    bound.length ? `Bound rules: ${bound.join(', ')}` : 'No rule is bound to this campaign.',
    accountWideRules ? `${accountWideRules} enabled rule(s) govern every campaign because nothing narrows them.` : '',
    suppressedAt ? `Bids suppressed by ${suppressedBy?.replace('automation:', '') ?? 'an unknown owner'}.` : '',
    minCents != null || maxCents != null
      ? `Bid bounds: ${minCents != null ? eur(minCents) : '—'} – ${maxCents != null ? eur(maxCents) : '—'}`
      : 'No bid bounds set.',
  ].filter(Boolean).join('\n')
  return (
    <span className="h10-auto-cell" title={tip}>
      {/* Own class rather than `h10-pill bad`: that modifier is used by the delivery column but has
          never been defined in ads.css, so it renders uncoloured. */}
      <span className={`h10-auto-state ${managed ? 'on' : 'off'}`}>{managed ? 'Managed' : 'Off-limits'}</span>
      {shown.map(([k, s]) => <span key={k} className="h10-auto-pin">{s}</span>)}
      {bound.length > 0 && <span className="h10-auto-rules">{bound.length}</span>}
      {suppressedAt && <span className="h10-auto-sup" aria-label="bids suppressed">↓</span>}
    </span>
  )
}

export function BiddingStrategyCell({ strategy, onEdit }: { strategy?: string | null; onEdit?: () => void }) {
  const label = strategy ? (STRAT_LABEL[strategy] ?? strategy) : '—'
  if (!onEdit) return <span>{label}</span>
  return (
    <span className="h10-edcell">
      {label}
      <button type="button" className="h10-editpen" aria-label="Edit bidding strategy" onClick={onEdit}>
        <Pencil size={11} aria-hidden />
      </button>
    </span>
  )
}

/** H10's "Campaign Bidding Strategy" modal, verbatim. Confirm → the gated campaign PATCH. */
export function StrategyModal({ strategy, busy, error, onConfirm, onClose }: {
  strategy?: string | null
  busy?: boolean
  error?: string | null
  onConfirm: (v: string) => void
  onClose: () => void
}) {
  const [v, setV] = useState(strategy ?? 'LEGACY_FOR_SALES')
  return (
    <div className="h10-modal-backdrop" onClick={() => { if (!busy) onClose() }}>
      <div className="h10-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Campaign Bidding Strategy">
        <div className="h10-modal-h"><b>Campaign Bidding Strategy</b><button type="button" className="h10-modal-x" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        <div className="h10-modal-sub">Select a strategy to optimize your campaign bidding performance</div>
        <div className="h10-modal-b">
          {STRATEGY_DEFS.map((s) => (
            <label className={`h10-radio-card ${v === s.value ? 'on' : ''}`} key={s.value}>
              <input type="radio" name="bidstrat" checked={v === s.value} onChange={() => setV(s.value)} />
              <span className="rc-b"><span className="rc-t">{s.title}</span><span className="rc-d">{s.desc}</span></span>
            </label>
          ))}
          {error && <p className="h10-modal-err" role="alert">{error}</p>}
        </div>
        <div className="h10-modal-f"><button type="button" className="h10-am-btn" onClick={onClose} disabled={busy}>Cancel</button><span className="grow" /><button type="button" className="h10-am-btn primary" onClick={() => onConfirm(v)} disabled={busy}>{busy ? 'Saving…' : 'Confirm'}</button></div>
      </div>
    </div>
  )
}
