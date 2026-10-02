'use client'

/**
 * NAF.AQ.3 — the decision card, rebuilt in this directory.
 *
 * The shipped `DecisionCard` (AP.3/AP.6/AP.8) got the hard parts right and is
 * the ancestor of this: risk-shaped depth, an honest fallback, the track
 * record, the read-and-understood gate. What it could not do, because a panel
 * had no room for it, is say **what the action touches and what it changes**.
 *
 * Four things are new here, each from the study's S6:
 *
 * 1. **Names, not ids.** `/agent/fleet/approvals` has always returned a
 *    `labels` map resolving campaign and target ids to names — and every
 *    client destructured it away, so no card has ever said WHICH campaign.
 * 2. **Before → after.** "bid €0.84" is unjudgeable; "€0.31 → €0.84 (+171%)"
 *    is. Every tool's preview already carries the starting value; nothing
 *    rendered it.
 * 3. **Reversibility as one class, stated once.** It used to be asserted in
 *    two places that could drift — a chip and a sentence. One source now.
 * 4. **The expiry clock**, which is stored on every row and was rendered
 *    nowhere, and an on-demand "is this still true?" that runs the same
 *    re-check the commit path runs.
 *
 * The tool VOCABULARY is still imported from the old card rather than copied.
 * Copying it would create two dictionaries that drift, which is the defect
 * AP.3 was written to fix. It moves here when the Overview stops rendering
 * the old card, and not before.
 */

import { useId, useState } from 'react'
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  Pencil,
  RotateCcw,
  X,
} from 'lucide-react'
import { Banner, KeyValue } from '@/design-system/components'
import { TOOL_CARDS, toolCardFor, type ToolCard } from '@/app/marketing/ads/rules-automation/fleet/DecisionCard'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import {
  approveLabelFor,
  channelEffectOf,
  CONTENT_PREVIEWS,
  contentDiffOf,
  moreThanShown,
  NOT_SET,
  plainValue,
  previewSummary,
  previewTotals,
  previewWarnings,
  productEntityOf,
  type ChannelEffect,
  type ContentDiff,
  type ContentValue,
  type Delta,
} from './approval-words'
import { reversibilityFrom, type Reversibility } from './reversibility'

export interface FleetLabels {
  campaigns: Record<string, { name: string; marketplace: string | null }>
  targets: Record<
    string,
    { text: string; matchType: string; campaignName: string; marketplace: string | null }
  >
}

export interface CardApproval {
  id: string
  toolName: string
  charterKey: string | null
  riskTier: string
  status: string
  args: Record<string, unknown>
  preview: Record<string, unknown> | null
  requestedAt: string
  expiresAt: string | null
  reason?: string | null
  trackRecord?: { approved: number; rejected: number; total: number } | null
  /**
   * Why the person looking at the page may NOT approve this — the approve's own refusal, from the API — or
   * null/absent when they may. Apply is then disabled and the reason shown, never a click that can only fail.
   */
  cannotApprove?: string | null
  /** C1 — how far it can be put back, as the API states it from the tool registry (reversibility.ts). */
  reversibility?: Reversibility | null
  /** C9 — the tool's own title (the registry's), for a tool with no card of its own. */
  title?: string | null
  /** C9 — it reaches a marketplace or a buyer (the registry's openWorld). Absent = not stated. */
  openWorld?: boolean
  /** C9 — the business the change is in, as the page names it. */
  business?: string | null
}

/**
 * C9 — the words for a tool with no card of its own (TOOL_CARDS): its own title, never its id, and where its change
 * lands; whether it can be put back is the reversibility sentence beside it.
 */
function genericCardFor(approval: Pick<CardApproval, 'toolName' | 'title' | 'openWorld'>): ToolCard {
  const title = approval.title?.trim()
  if (!title) return toolCardFor(approval.toolName)
  return {
    wants: `asks for: ${title}`,
    shortAsk: title,
    approveLabel: `Approve: ${title}`,
    reversible: '',
    wrongCost:
      approval.openWorld === true
        ? 'It reaches a marketplace or a buyer.'
        : approval.openWorld === false
          ? 'It changes Nexus only.'
          : 'Where it lands is not recorded — read the details before approving.',
  }
}

/* ── reversibility, as ONE class ───────────────────────────────────────── */

/**
 * Three classes, and the wording is deliberate. "Reversible" on its own is
 * how an operator ends up believing a spend can be un-spent.
 */
type ReversibilityClass = 'restore' | 'compensate' | 'never'

/*
 * S6.c — the `chip` field is gone. S6.a promoted the reversibility SENTENCE
 * into the always-visible consequence line, which left the chip saying the same
 * thing more briefly a few pixels away. Two statements of one fact is exactly
 * what this map was created to prevent, so the shorter one went rather than
 * being restyled.
 */
const REVERSIBILITY: Record<ReversibilityClass, { sentence: string }> = {
  restore: {
    sentence: 'We can put this back the way it was — the previous value is recorded.',
  },
  compensate: {
    sentence:
      'This cannot be undone, only compensated for. The change can be reversed going forward, but whatever it already did — money spent, a listing seen — has happened.',
  },
  never: {
    sentence: 'This cannot be taken back once it runs, by any means.',
  },
}

/**
 * C1 — from the row the API sent (the tool registry's `reversibility`), never from a copy kept here. `none`, and
 * anything the page cannot read, land on `never`: an unrecorded consequence is treated as irreversible, which is
 * the safe direction to be wrong in.
 */
function reversibilityOf(approval: Pick<CardApproval, 'reversibility'>): ReversibilityClass {
  const stated = reversibilityFrom(approval.reversibility)
  if (stated === 'full') return 'restore'
  if (stated === 'partial') return 'compensate'
  return 'never'
}

/* ── AQ.4 · coded reasons, per action type ─────────────────────────────── */

/**
 * Why coded rather than free text, and why per-tool rather than one dropdown.
 *
 * The CPOE/CDS research is unusually specific here: coded override reasons
 * matched the reviewer's actual free-text reasoning in only 46% of 15,636
 * alerts, and free text alone is unanalysable — one study found 209 distinct
 * spellings of "will monitor as recommended". A randomised crossover trial
 * found a CUSTOMISED per-context list produced significantly more appropriate
 * reasons than a generic one (p < 0.001).
 *
 * So: a short list shaped to the action, plus an optional note. And every list
 * carries **"the suggestion itself is wrong"** — the option generic lists
 * suppress and free text reveals, and the highest-value signal for tuning a
 * worker, because it says the reasoning was bad rather than the timing.
 */
const DEFAULT_REJECT_CODES = [
  'Not worth doing',
  'Wrong number, right idea',
  'I will handle this myself',
  'The suggestion itself is wrong',
]

const REJECT_CODES: Record<string, string[]> = {
  'set-target-bid': [
    'Wrong number, right idea',
    'Leave this bid alone',
    'Not worth the spend',
    'The suggestion itself is wrong',
  ],
  'create-negative-keyword': [
    'This term still converts',
    'Too broad — it would block good traffic',
    'I want to watch it longer',
    'The suggestion itself is wrong',
  ],
  'graduate-keyword': [
    'Not enough evidence yet',
    'Wrong bid for it',
    'Belongs in a different campaign',
    'The suggestion itself is wrong',
  ],
  'set-price': [
    'Margin does not work',
    'Wrong price',
    'Not now — bad timing',
    'The suggestion itself is wrong',
  ],
  'apply-content': [
    'Copy is wrong',
    'Not ready to change this listing',
    'I will edit it myself',
    'The suggestion itself is wrong',
  ],
  'publish-listing': [
    'Listing is not ready',
    'Wrong channel',
    'Not now — bad timing',
    'The suggestion itself is wrong',
  ],
  // Section 03 — the text, its English meaning, or where it goes can be what is wrong.
  'set-content': [
    'The text is wrong',
    'The English meaning does not match the text',
    'It should not reach every listing that follows it',
    'The suggestion itself is wrong',
  ],
  'set-listing-content': [
    'The text is wrong',
    'The English meaning does not match the text',
    'This listing should follow the shared text',
    'The suggestion itself is wrong',
  ],
  'set-shopify-content': [
    'A value is wrong',
    'The English meaning does not match the text',
    'Leave the store\'s own value',
    'The suggestion itself is wrong',
  ],
  'bulk-content-change': [
    'Some of the texts are wrong',
    'The English meaning does not match the text',
    'Too many products in one change',
    'The suggestion itself is wrong',
  ],
  'send-customer-message': [
    'Do not contact this customer',
    'Wrong message',
    'I will reply myself',
    'The suggestion itself is wrong',
  ],
}

export const rejectCodesFor = (toolName: string) => REJECT_CODES[toolName] ?? DEFAULT_REJECT_CODES

/* ── AQ.8 · what the operator may edit ─────────────────────────────────── */

/**
 * The editable field per action, declared rather than inferred.
 *
 * Deliberately NOT a generic "edit the args as JSON" box. The reference
 * implementation everyone copies renders one free-text textarea per argument
 * and stringifies every value — its own README admits the values come back as
 * strings — which over a money field is a hole straight through the bid rails:
 * an operator typing 4.2 for 0.42 gets a ten-times bid with nothing in the way.
 *
 * So each entry says what the field IS, and the input is typed to match. The
 * bound here is a courtesy that catches a typo before the round trip; the
 * REAL check is the server re-running the tool's own handler, which owns the
 * bid floor, the authority pins and the protected terms. This list can never
 * be more permissive than that — only kinder about saying so early.
 */
interface Editable {
  /** The key in `args` the server will patch. */
  arg: string
  label: string
  /** Money is entered in euros and sent in cents. */
  unit: 'euro-cents'
  min: number
  max: number
  /** Where to read the current proposal from, so the input starts populated. */
  fromPreview: string
}

const EDITABLE: Record<string, Editable> = {
  'set-target-bid': {
    arg: 'proposedBidCents',
    label: 'bid',
    unit: 'euro-cents',
    // 5c is BID_FLOOR_CENTS in the tool itself; the ceiling is a sanity bound
    // on a typo, not a policy — policy lives at the write gate.
    min: 5,
    max: 1000,
    fromPreview: 'proposedBidCents',
  },
  'graduate-keyword': {
    arg: 'bidCents',
    label: 'starting bid',
    unit: 'euro-cents',
    min: 5,
    max: 1000,
    fromPreview: 'suggestedBidCents',
  },
}

/* ── what it touches, and what it changes ──────────────────────────────── */

interface Described {
  /** The thing being acted on, named. Null when we genuinely cannot say. */
  entity: string | null
  marketplace: string | null
  deltas: Delta[]
  /** Named, decision-relevant signals — never a bare confidence score. */
  evidence: Array<{ label: string; value: string }>
}

/** MCP.12 — how a changes map shows a value that is not set. */
export const EMPTY_VALUE = '(empty)'

const euro = (cents: unknown) =>
  typeof cents === 'number' ? `€${(cents / 100).toFixed(2)}` : null

/**
 * MCP full control A4 — an ad amount in its campaign's OWN currency (the preview names it), never converted. A row
 * written before ad previews carried a currency is in euros, as everything was then.
 */
const adMoney = (cents: unknown, currency: unknown) =>
  typeof cents !== 'number' ? null : typeof currency === 'string' && currency !== 'EUR' ? `${currency} ${(cents / 100).toFixed(2)}` : euro(cents)

/**
 * MCP full control A4 — what every executable ad change states before it is approved: where it lands (live at
 * Amazon on which profile, or sandbox), any clamp the campaign applies, and the automations that may change it again.
 */
function adEvidence(p: Record<string, any>, out: Described) {
  if (typeof p.reachNote === 'string') out.evidence.push({ label: 'where it lands', value: p.reachNote })
  if (typeof p.clampedBy === 'string') out.evidence.push({ label: 'clamped by', value: p.clampedBy })
  if (typeof p.alsoChangedByNote === 'string') out.evidence.push({ label: 'may change it again', value: p.alsoChangedByNote })
}

/** C9 — a value in words, never raw JSON (approval-words.ts plainValue). */
const plain = (v: unknown): string => plainValue(v)

/**
 * Pull the human facts out of a preview. Per-tool because the previews are
 * per-tool — a generic renderer here would produce exactly the JSON dump the
 * card exists to avoid.
 */
function describe(a: CardApproval, labels: FleetLabels): Described {
  const p = (a.preview ?? {}) as Record<string, any>
  const out: Described = { entity: null, marketplace: null, deltas: [], evidence: [] }

  // A `{field: {from, to}}` map — set-price and apply-content both use it. A content change has its own table
  // (ContentDiffView): a whole description does not fit a delta line, and its English meaning belongs beside it.
  const changes = p.changes as Record<string, { from: unknown; to: unknown }> | undefined
  if (CONTENT_PREVIEWS.has(a.toolName)) {
    out.entity = typeof p.listing === 'string' ? p.listing
      : typeof p.sku === 'string' ? `SKU ${p.sku}`
      : typeof p.totals?.products === 'number' ? `${p.totals.products} product${p.totals.products === 1 ? '' : 's'}` : null
  } else if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
    for (const [field, ch] of Object.entries(changes)) {
      if (ch && typeof ch === 'object' && ('from' in ch || 'to' in ch)) {
        /* A money field arrives as a BARE NUMBER — mutate.tools.ts writes
           `'base price': { from: 49, to: 39 }` — and "49 → 39" reads as a
           quantity or a percentage just as easily as a price. Measured on a
           rendered card, not reasoned about. The card names the unit the tool
           omitted; every other field keeps its value verbatim. */
        const money = /price|cost|fee/i.test(field)
        /* MCP.12 — a value that is not there reads as a word. `plain(null)` is
           "—", and "number_of_pockets — → 4" put a dash where the old value
           goes, which reads as a typo rather than as "nothing was set". */
        const fmt = (v: unknown) =>
          v == null || v === '' || (Array.isArray(v) && v.length === 0)
            ? EMPTY_VALUE
            : money && typeof v === 'number' && Number.isFinite(v)
              ? `€${v.toFixed(2)}`
              : plain(v)
        out.deltas.push({ field, from: fmt(ch.from), to: fmt(ch.to) })
      }
    }
  }

  switch (a.toolName) {
    case 'set-target-bid': {
      const t = p.target ?? {}
      const resolved = typeof a.args.targetId === 'string' ? labels.targets[a.args.targetId] : null
      out.entity = resolved
        ? `“${resolved.text}” (${resolved.matchType}) in ${resolved.campaignName}`
        : t.expression
          ? `“${t.expression}” (${t.matchType ?? '—'}) in ${p.campaign?.name ?? 'an unnamed campaign'}`
          : null
      out.marketplace = resolved?.marketplace ?? p.campaign?.marketplace ?? null
      if (typeof p.currentBidCents === 'number' && typeof p.proposedBidCents === 'number') {
        out.deltas.push({
          field: 'bid',
          from: adMoney(p.currentBidCents, p.currency),
          // A4 — the bid that lands, after the campaign's CPC ceiling and max-change guardrail.
          to: adMoney(typeof p.effectiveBidCents === 'number' ? p.effectiveBidCents : p.proposedBidCents, p.currency) ?? '—',
        })
      }
      adEvidence(p, out)
      break
    }
    case 'create-negative-keyword': {
      const camp =
        (typeof a.args.externalCampaignId === 'string'
          ? labels.campaigns[a.args.externalCampaignId]
          : null) ?? null
      // A5 — the ad group it goes into, when the preview names one.
      out.entity = `${camp?.name ?? p.campaign?.name ?? 'an unnamed campaign'}${p.adGroup?.name ? ` › ${p.adGroup.name}` : ''}`
      out.marketplace = camp?.marketplace ?? p.campaign?.marketplace ?? null
      out.deltas.push({
        field: `negative keyword (${plain(p.matchType)}, ${plain(p.scope)})`,
        from: null,
        to: `“${plain(p.term)}”`,
      })
      if (p.metrics) {
        out.evidence.push({
          label: `spend on this term, last ${plain(p.metrics.windowDays)} days`,
          value: `${adMoney(p.metrics.costCents, p.currency) ?? '—'} for ${plain(p.metrics.orders)} orders`,
        })
      }
      adEvidence(p, out)
      break
    }
    case 'graduate-keyword': {
      out.entity = p.destination?.name ? `${plain(p.destination.name)}${p.destinationAdGroup?.name ? ` › ${p.destinationAdGroup.name}` : ''}` : null
      out.deltas.push({
        field: 'new exact keyword',
        from: null,
        to: `“${plain(p.query)}” at ${adMoney(p.suggestedBidCents, p.currency) ?? '—'}`,
      })
      if (p.metrics) {
        out.evidence.push({
          label: `the term's own record, last ${plain(p.metrics.windowDays)} days`,
          value: `${plain(p.metrics.clicks)} clicks, ${plain(p.metrics.orders)} orders, ${adMoney(p.metrics.costCents, p.currency) ?? '—'} spent`,
        })
      }
      if (typeof p.destinationAdGroup?.why === 'string') out.evidence.push({ label: 'why this ad group', value: p.destinationAdGroup.why })
      adEvidence(p, out)
      break
    }
    case 'set-campaign-budget': {
      // A6 — a daily budget in the campaign's own currency.
      out.entity = p.campaign?.name ?? null
      out.marketplace = p.campaign?.marketplace ?? null
      if (typeof p.currentBudgetCents === 'number' && typeof p.proposedBudgetCents === 'number') {
        out.deltas.push({ field: 'daily budget', from: adMoney(p.currentBudgetCents, p.currency), to: adMoney(p.proposedBudgetCents, p.currency) ?? '—' })
      }
      adEvidence(p, out)
      break
    }
    case 'set-placement-multipliers': {
      // A6 — each placement adjustment it changes, in percent.
      out.entity = p.campaign?.name ?? null
      out.marketplace = p.campaign?.marketplace ?? null
      const names: Record<string, string> = { topOfSearchPct: 'top of search', productPagesPct: 'product pages', restOfSearchPct: 'rest of search' }
      for (const [key, label] of Object.entries(names)) {
        const from = p.current?.[key] ?? 0
        const to = p.proposed?.[key] ?? 0
        if (from !== to) out.deltas.push({ field: `${label} adjustment`, from: `${from}%`, to: `${to}%` })
      }
      adEvidence(p, out)
      break
    }
    case 'bulk-ad-bid-change': {
      // A7 — the first changes, what is left alone and why, the per-click total per currency.
      const changes = Array.isArray(p.changes) ? (p.changes as Array<Record<string, any>>) : []
      out.entity = `${plain(p.totals?.changing)} bid${p.totals?.changing === 1 ? '' : 's'}${typeof p.percent === 'number' ? ` (${p.percent > 0 ? '+' : ''}${p.percent}%)` : ''}`
      for (const c of changes.slice(0, 5)) {
        out.deltas.push({ field: `“${plain(c.text)}” · ${plain(c.campaignName)}`, from: adMoney(c.fromCents, c.currency), to: adMoney(c.toCents, c.currency) ?? '—' })
      }
      const more = changes.length - 5 + (typeof p.moreChanges === 'number' ? p.moreChanges : 0)
      if (more > 0) out.evidence.push({ label: 'and', value: `${more} more bid changes` })
      for (const [cur, v] of Object.entries((p.byCurrency ?? {}) as Record<string, { targets: number; deltaCents: number }>)) {
        out.evidence.push({ label: `per click in ${cur}`, value: `${v.deltaCents >= 0 ? '+' : '−'}${adMoney(Math.abs(v.deltaCents), cur)} in total on ${v.targets}` })
      }
      const left = Object.values((p.totals?.excluded ?? {}) as Record<string, number>).reduce((a, n) => a + n, 0)
      if (left > 0) out.evidence.push({ label: 'left as they are', value: `${left} (see the request for why)` })
      adEvidence(p, out)
      break
    }
    case 'suppress-campaign': {
      // A8 — the no-pause stop: what goes to the floor.
      out.entity = p.campaign?.name ?? null
      out.marketplace = p.campaign?.marketplace ?? null
      out.deltas.push({ field: 'bids', from: `${plain(p.moves?.targets)} targets, ${plain(p.moves?.adGroups)} ad group defaults`, to: 'the 2-cent floor (remembered; never paused)' })
      adEvidence(p, out)
      break
    }
    case 'restore-campaign': {
      // A8 — the remembered bids it puts back, and whose suppression it lifts.
      out.entity = p.campaign?.name ?? null
      out.marketplace = p.campaign?.marketplace ?? null
      for (const b of (Array.isArray(p.bids) ? (p.bids as Array<Record<string, any>>) : []).slice(0, 5)) {
        out.deltas.push({ field: `“${plain(b.text)}”`, from: adMoney(b.fromCents, p.currency), to: adMoney(b.toCents, p.currency) ?? '—' })
      }
      out.evidence.push({ label: 'restores', value: `${plain(p.restores?.targets)} targets and ${plain(p.restores?.adGroups)} ad group defaults` })
      if (typeof p.suppressedBy === 'string') out.evidence.push({ label: 'suppressed by', value: p.suppressedBy })
      adEvidence(p, out)
      break
    }
    case 'set-campaign-live-writes': {
      // A12 — the allowlist switch: what it lets through, and whether the connection would today.
      out.entity = p.campaign?.name ?? null
      out.marketplace = p.campaign?.marketplace ?? null
      const word = (on: unknown) => (on ? 'on the live-write allowlist' : 'off the allowlist')
      out.deltas.push({ field: 'live writes', from: word(p.liveWrites?.from), to: word(p.liveWrites?.to) })
      if (p.connection) out.evidence.push({ label: 'Amazon Ads connection', value: `${plain(p.connection.mode)}, writes ${p.connection.writesEnabled ? 'enabled' : 'not enabled'}` })
      adEvidence(p, out)
      break
    }
    case 'create-ad-campaign': {
      // A11 — the plan, from nothing: budget, bids (born at the floor), what it advertises and how it targets; then the
      // negatives, the market's spend ceiling, the allowlist and where it lands.
      const plan = (p.plan ?? {}) as Record<string, any>
      const list = (v: unknown) => (Array.isArray(v) ? (v as Array<Record<string, any>>) : [])
      const some = (items: string[]) => `${items.slice(0, 5).join(', ')}${items.length > 5 ? ', …' : ''}`
      out.entity = typeof plan.name === 'string' ? `new campaign “${plan.name}”` : null
      out.marketplace = plan.market ?? null
      out.deltas.push({ field: 'daily budget', from: EMPTY_VALUE, to: adMoney(plan.dailyBudgetCents, plan.currency) ?? '—' })
      out.deltas.push({ field: 'bids', from: EMPTY_VALUE, to: `the 2-cent floor; restore-campaign puts the planned bids back (default ${adMoney(plan.adGroup?.defaultBidCents, plan.currency) ?? '—'})` })
      const products = list(plan.products)
      out.deltas.push({ field: 'advertises', from: EMPTY_VALUE, to: `${products.length} product${products.length === 1 ? '' : 's'}: ${some(products.map((x) => plain(x.sku)))}` })
      const keywords = list(plan.keywords)
      const targets = list(plan.productTargets)
      out.deltas.push(keywords.length
        ? { field: 'keywords', from: EMPTY_VALUE, to: `${keywords.length}: ${some(keywords.map((k) => `“${plain(k.text)}” ${plain(k.matchType)} ${adMoney(k.bidCents, plan.currency) ?? ''}`.trim()))}` }
        : { field: 'product targets', from: EMPTY_VALUE, to: `${targets.length}: ${some(targets.map((t) => plain(t.asin)))}` })
      const negatives = list(plan.negativeKeywords)
      if (negatives.length) out.evidence.push({ label: 'never shows on', value: some(negatives.map((n) => `“${plain(n.text)}”`)) })
      if (p.ceiling) out.evidence.push({ label: 'spend ceiling', value: `${plain(p.ceiling.label)}: ${adMoney(p.ceiling.dailyCapCents, plan.currency) ?? '—'} a day` })
      out.evidence.push({ label: 'live writes', value: 'off the allowlist until a person approves set-campaign-live-writes' })
      adEvidence(p, out)
      break
    }
    case 'set-ebay-ad-rates': {
      // A14 — each rate now and after (a percent of the sale, no currency), what is left alone, where it lands.
      out.entity = p.campaign?.name ?? null
      out.marketplace = p.campaign?.marketplace ?? null
      const changes = Array.isArray(p.changes) ? (p.changes as Array<Record<string, any>>) : []
      for (const c of changes.slice(0, 5)) out.deltas.push({ field: `ad rate · item ${plain(c.itemId)}`, from: c.fromPct == null ? EMPTY_VALUE : `${c.fromPct}%`, to: `${c.toPct}%` })
      if (changes.length > 5) out.evidence.push({ label: 'and', value: `${changes.length - 5} more rate changes` })
      const above = Array.isArray(p.left?.aboveBreakEven) ? p.left.aboveBreakEven.length : 0
      if (above) out.evidence.push({ label: 'not set (above break-even)', value: String(above) })
      adEvidence(p, out)
      break
    }
    case 'promote-ebay-listings': {
      // A14 — the listings it promotes and at what rate; what it leaves out and why.
      out.entity = p.campaign?.name ?? null
      out.marketplace = p.campaign?.marketplace ?? null
      const adds = Array.isArray(p.adds) ? (p.adds as Array<Record<string, any>>) : []
      for (const a of adds.slice(0, 5)) out.deltas.push({ field: `item ${plain(a.itemId)}${a.sku ? ` (${a.sku})` : ''}`, from: EMPTY_VALUE, to: a.ratePct == null ? 'promoted' : `promoted at ${a.ratePct}%` })
      if (adds.length > 5) out.evidence.push({ label: 'and', value: `${adds.length - 5} more listings` })
      const leftOut = Object.values((p.left ?? {}) as Record<string, unknown[]>).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0)
      if (leftOut) out.evidence.push({ label: 'left out', value: `${leftOut} (see the request for why)` })
      adEvidence(p, out)
      break
    }
    case 'set-ebay-campaign-budget': {
      out.entity = p.campaign?.name ?? null
      out.marketplace = p.campaign?.marketplace ?? null
      out.deltas.push({ field: 'daily budget', from: adMoney(p.currentBudgetCents, p.currency), to: adMoney(p.proposedBudgetCents, p.currency) ?? '—' })
      if (typeof p.budgetChangesToday === 'number') out.evidence.push({ label: 'budget changes today', value: `${p.budgetChangesToday} of 15 (eBay's limit)` })
      adEvidence(p, out)
      break
    }
    case 'ebay-keywords-change': {
      // A14 — bids (never a status), new keywords, new negatives.
      out.entity = p.campaign?.name ?? null
      out.marketplace = p.campaign?.marketplace ?? null
      const bids = Array.isArray(p.bidChanges) ? (p.bidChanges as Array<Record<string, any>>) : []
      const adds = Array.isArray(p.adds) ? (p.adds as Array<Record<string, any>>) : []
      for (const b of bids.slice(0, 5)) out.deltas.push({ field: `“${plain(b.text)}” ${plain(b.matchType)}`, from: adMoney(b.fromCents, p.currency), to: adMoney(b.toCents, p.currency) ?? '—' })
      for (const a of adds.slice(0, 5)) out.deltas.push({ field: `new “${plain(a.text)}” ${plain(a.matchType)}`, from: EMPTY_VALUE, to: adMoney(a.bidCents, p.currency) ?? '—' })
      const negatives = Array.isArray(p.negatives) ? (p.negatives as Array<Record<string, any>>) : []
      if (negatives.length) out.evidence.push({ label: 'never shows on', value: negatives.slice(0, 5).map((n) => `“${plain(n.text)}”`).join(', ') })
      if (bids.length + adds.length > 10) out.evidence.push({ label: 'and', value: `${bids.length + adds.length - 10} more keyword changes` })
      adEvidence(p, out)
      break
    }
    case 'create-ebay-campaign': {
      // A15 — as low as eBay allows: a General campaign at 2% with no listings, or a Priority one inside a spend ceiling.
      const plan = (p.plan ?? {}) as Record<string, any>
      out.entity = typeof plan.name === 'string' ? `new eBay campaign “${plan.name}”` : null
      out.marketplace = plan.market ?? null
      if (plan.fundingModel === 'COST_PER_CLICK') out.deltas.push({ field: 'daily budget', from: EMPTY_VALUE, to: adMoney(plan.dailyBudgetCents, plan.currency) ?? '—' })
      else out.deltas.push({ field: 'ad rate', from: EMPTY_VALUE, to: `${plain(plan.ratePct)}% (eBay's minimum), no listings yet` })
      if (p.account) out.evidence.push({ label: 'eBay account', value: plain(p.account.name ?? p.account.connectionId) })
      if (p.ceiling) out.evidence.push({ label: 'eBay spend ceiling', value: `${adMoney(p.ceiling.monthlyCapCents, p.ceiling.currency) ?? '—'} a month` })
      adEvidence(p, out)
      break
    }
    case 'undo-ad-change': {
      // A10 — what it puts back: each write and the value it restores, and the negatives it retires.
      const rows = Array.isArray(p.rows) ? (p.rows as Array<Record<string, any>>) : []
      out.entity = p.source?.changeSetId ? `the ad changes of request ${p.source.changeSetId}` : p.source?.actionLogId ? 'one recorded ad change' : null
      for (const r of rows.slice(0, 5)) {
        const field = r.entityType === 'CAMPAIGN' && r.restores?.dailyBudget != null ? 'daily budget' : r.actionType === 'update_placement_bidding' ? 'placements' : 'bid'
        const shown = (v: Record<string, any> | undefined) =>
          field === 'daily budget' ? plain(v?.dailyBudget) : field === 'placements' ? `${Array.isArray(v?.adjustments) ? v!.adjustments.length : 0} placements` : adMoney(v?.bidCents, null) ?? '—'
        out.deltas.push({ field: `${field} (${plain(r.entityId)})`, from: shown(r.wrote), to: shown(r.restores) })
      }
      if (rows.length > 5 || typeof p.moreRows === 'number') {
        out.evidence.push({ label: 'also restores', value: `${rows.length - 5 + (p.moreRows ?? 0)} more` })
      }
      if (Array.isArray(p.negatives) && p.negatives.length) {
        // Owner decision (2026-10-02): said as what it does at Amazon — the block is removed, no ad is stopped.
        out.evidence.push({
          label: p.negatives.length === 1 ? 'removes the negative keyword at Amazon' : 'removes these negative keywords at Amazon',
          value: p.negatives.map((n: Record<string, any>) => `“${plain(n.keywordText)}”`).join(', '),
        })
      }
      adEvidence(p, out)
      break
    }
    case 'set-price': {
      out.entity = p.sku ? `SKU ${p.sku}` : null
      if (typeof p.deltaPct === 'number') {
        out.evidence.push({ label: 'change', value: `${p.deltaPct > 0 ? '+' : ''}${p.deltaPct}%` })
      }
      break
    }
    case 'publish-listing': {
      out.entity = p.title ? `${p.title} (${plain(p.channel)})` : plain(p.channel)
      out.deltas.push({
        field: 'published',
        from: p.currentlyPublished ? 'yes' : 'no',
        to: 'yes',
      })
      out.evidence.push({ label: 'publish mode for this channel', value: plain(p.publishMode) })
      break
    }
    case 'send-customer-message': {
      out.entity = p.to ? `${p.to} (${plain(p.marketplace)})` : null
      out.deltas.push({ field: 'message', from: null, to: plain(p.message) })
      out.evidence.push({
        label: 'has opted out of contact',
        value: p.suppressed ? 'YES — this will not be sent' : 'no',
      })
      break
    }
    default:
      // C9 — a tool with no case of its own names the product from its preview (sku, product name), when it gives one.
      out.entity = productEntityOf(p)
      break
  }
  return out
}

/* ── why a request came back ───────────────────────────────────────────── */

interface Comeback {
  headline: string
  detail: string
  tail: string
  /** True when it reached Amazon and failed, rather than never being tried. */
  attempted: boolean
}

/**
 * `reason` carries the prefix the server wrote. Three shapes exist today, and
 * conflating them is what made a failed execution indistinguishable from a
 * fresh proposal:
 *
 *   `not run — …`         AP.6 staleness. Nothing was attempted.
 *   `execution failed: …` the tool ran and returned an error.
 *   `execution error: …`  the tool threw.
 */
function classifyComeback(reason: string | null | undefined): Comeback | null {
  if (!reason) return null
  if (reason.startsWith('not run —')) {
    return {
      headline: 'You approved this before, and it did not run.',
      detail: reason.replace(/^not run — /, ''),
      tail: '— it is back here so you can decide again with the facts as they are now.',
      attempted: false,
    }
  }
  const failed = /^execution (failed|error):\s*/.exec(reason)
  if (failed) {
    return {
      headline: 'You approved this, it was attempted, and it failed.',
      detail: reason.replace(/^execution (failed|error):\s*/, ''),
      // The distinction that matters: something was actually sent. Whether it
      // half-landed is not knowable from here, which is worth saying rather
      // than implying a clean no-op.
      tail:
        '— nothing here can tell you whether any part of it took effect, so check before deciding again.',
      attempted: true,
    }
  }
  return null
}

/* ── the clock ─────────────────────────────────────────────────────────── */

function timeLeft(iso: string | null): { text: string; urgent: boolean } | null {
  if (!iso) return null
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return { text: 'out of time', urgent: true }
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return { text: `${mins} min left`, urgent: true }
  const hrs = Math.round(mins / 60)
  return { text: `${hrs}h left`, urgent: hrs <= 2 }
}

const ago = (iso: string) => {
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000)
  if (h < 1) return 'just now'
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/* ── MCP.12 · what each marketplace gets ───────────────────────────────── */

/**
 * The listing side of a bulk price change, as its preview states it: the listing lines the tool kept (at most 20,
 * the rest counted) and one clause per count — sent, paused, own price, another currency, already there. The card
 * used to show the master prices only, so an approver could not see what "eBay IT" would be sent.
 */
export function ChannelEffectDetail({ effect }: { effect: ChannelEffect }) {
  return (
    <>
      {effect.lines.length > 0 ? (
        <ul className="aq-channels">
          {effect.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
          {effect.more > 0 ? (
            <li className="aq-channelsmore">
              and {effect.more} more listing{effect.more === 1 ? '' : 's'}
            </li>
          ) : null}
        </ul>
      ) : null}
      <p className="aq-channelcounts">{sentenceOf(effect.counts)}</p>
    </>
  )
}

const sentenceOf = (clauses: string[]) => {
  const text = clauses.join('; ')
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`
}

/* ── Section 03 · a content change, field by field ─────────────────────── */

function ContentText({ value }: { value: ContentValue }) {
  if (Array.isArray(value)) {
    return (
      <ul className="aq-contentlist">
        {value.map((item, i) => (
          <li key={i} className="aq-contenttext">{item}</li>
        ))}
      </ul>
    )
  }
  return <span className={value === NOT_SET ? 'aq-contentempty' : 'aq-contenttext'}>{value}</span>
}

/**
 * The text a content change writes, per field: what it says now, the new text, and what the new text says in English
 * (the approver reads English; the approval is the text's review, d8). Then where it shows — the listings that follow
 * it and those that keep their own — and the glossary's and the writer's warnings. KeyValue's three columns become one
 * on a phone, so a long description stays readable.
 */
export function ContentDiffView({ diff, more }: { diff: ContentDiff; more: string | null }) {
  const newLabel = diff.language ? `New (${diff.language})` : 'New'
  return (
    <div className="aq-content">
      {diff.rows.map((row) => (
        <section key={row.key} className="aq-contentrow" aria-label={`${row.product ? `${row.product} ` : ''}${row.field}`}>
          <p className="aq-contentfield">
            {row.product ? <span className="aq-contentsku">{row.product} · </span> : null}
            {row.field}
          </p>
          <KeyValue
            columns={3}
            dense
            items={[
              { label: 'Now', value: <ContentText value={row.now} /> },
              { label: newLabel, value: <ContentText value={row.next} /> },
              {
                label: 'English meaning',
                value: row.english ?? (diff.language === 'English' ? 'The text is in English.' : 'No new text to translate.'),
              },
            ]}
          />
          {row.note ? <p className="aq-contentnote">{row.note}</p> : null}
        </section>
      ))}
      {more ? <p className="aq-contentnote">{more}</p> : null}
      {diff.reach.length ? (
        <ul className="aq-contentreach" aria-label="Where the new text shows">
          {diff.reach.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {diff.glossary.length ? (
        <Banner tone="warning" title="The glossary says otherwise" className="aq-contentbanner">
          <ul className="aq-contentlist">
            {diff.glossary.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {diff.warnings.length ? (
        <Banner tone="warning" title="Saved with a warning" className="aq-contentbanner">
          <ul className="aq-contentlist">
            {diff.warnings.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
    </div>
  )
}

/* ── the card ──────────────────────────────────────────────────────────── */

export function ApprovalCard({
  approval,
  labels,
  workerName,
  busy,
  canExecute,
  onDecide,
  onRecheck,
  onAmend,
  onSnooze,
}: {
  approval: CardApproval
  labels: FleetLabels
  workerName: string
  busy: boolean
  /** False for the fleet's preview-only tools — a yes changes nothing. */
  canExecute: boolean
  onDecide: (id: string, decision: 'approve' | 'reject', reason?: string) => void
  onRecheck: (id: string) => Promise<{ stale: boolean; why: string | null }>
  /** AQ.8 — supersede this proposal with the operator's own number. */
  onAmend: (id: string, args: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>
  /** NAF.AQ — "not now". Null `until` brings it straight back. */
  onSnooze: (id: string, until: Date | null) => void
}) {
  // C9 — a tool with no card of its own is named by its own title, never its id (genericCardFor).
  const generic = !TOOL_CARDS[approval.toolName]
  const vocab = generic ? genericCardFor(approval) : toolCardFor(approval.toolName)
  const summary = previewSummary(approval.preview)
  const totals = previewTotals(approval.preview)
  const warnings = previewWarnings(approval.preview)
  const rev = reversibilityOf(approval)
  const d = describe(approval, labels)
  const left = timeLeft(approval.expiresAt)
  const comeback = classifyComeback(approval.reason)

  // Depth scales with CONSEQUENCE, not with riskTier alone. Every fleet tool
  // is riskTier 'high', so a tier-only rule made 100% of cards heavy and the
  // ack gate blanket friction — precisely what AP.8 said it was avoiding.
  const heavy = rev !== 'restore' || approval.riskTier === 'high'
  // Default CLOSED: the facts that decide the decision are always visible now,
  // so this holds only the supporting detail.
  const [showWhy, setShowWhy] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const [acked, setAcked] = useState(false)
  const [recheck, setRecheck] = useState<{ stale: boolean; why: string | null } | null>(null)
  const [rechecking, setRechecking] = useState(false)

  // AQ.8 — editing. `editable` is null for actions with no safe numeric field;
  // the affordance simply does not appear rather than offering a box that
  // cannot be validated.
  const editable = EDITABLE[approval.toolName] ?? null
  const proposedNow =
    editable && typeof (approval.preview as any)?.[editable.fromPreview] === 'number'
      ? ((approval.preview as any)[editable.fromPreview] as number)
      : null
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>(
    proposedNow != null ? (proposedNow / 100).toFixed(2) : '',
  )
  const [amendErr, setAmendErr] = useState<string | null>(null)
  const [amending, setAmending] = useState(false)

  const draftCents = Math.round(Number(draft) * 100)
  const draftValid =
    Number.isFinite(draftCents) &&
    editable != null &&
    draftCents >= editable.min &&
    draftCents <= editable.max &&
    draftCents !== proposedNow

  const needsAck = heavy && canExecute
  const approveBlocked = needsAck && !acked
  // Not this viewer's to approve (they lack the tool's permission — perhaps taken away while their own approval
  // waited). Apply is disabled and the reason is written out; Reject stays.
  const notYours = approval.cannotApprove ?? null
  const notYoursId = useId()

  /**
   * The button states the CONSEQUENCE, not the verb. "Approve" tells a
   * first-time operator nothing; "Apply — bid €0.31 → €0.84" is a decision
   * they can make from the button alone, and it makes a screenshot
   * self-documenting. Falls back to the tool vocabulary when there is no
   * delta worth naming.
   */
  /**
   * Snooze presets, and every one is checked against the expiry.
   *
   * A request lives 24 hours. Offering "next week" would be offering to hide
   * something until well after it has been refused — the operator would come
   * back to an empty queue believing they had deferred a decision when they had
   * actually forfeited it. So the options are filtered, and if none survive the
   * control does not render at all.
   */
  const snoozeOptions = (() => {
    const expiry = approval.expiresAt ? new Date(approval.expiresAt).getTime() : Infinity
    const now = Date.now()
    return [
      { label: '2 hours', ms: 2 * 3600_000 },
      { label: '6 hours', ms: 6 * 3600_000 },
      { label: 'tomorrow morning', ms: 16 * 3600_000 },
    ].filter((o) => now + o.ms < expiry - 5 * 60_000)
  })()

  /* MCP.12 — one change keeps its own wording; several say what the whole request does. The label used to name
     `d.deltas[0]` only, so a 3-product price change read as a change to its first product. */
  const approveLabel = approveLabelFor(approval.toolName, d.deltas, approval.preview, vocab.approveLabel)
  const more = moreThanShown(approval.toolName, approval.preview)
  const channels = channelEffectOf(approval.toolName, approval.preview)
  const content = contentDiffOf(approval.toolName, approval.preview)

  return (
    /*
     * S5.2 — `can-run` is the class that carries the page's danger signal, and
     * it is the ONLY thing that does.
     *
     * Measured on prod with the outside queue seeded: the S4 example card,
     * whose own body text reads "changes nothing on Amazon", and a real
     * `set-price` row that can reprice a live SKU rendered BYTE-IDENTICAL —
     * `aq-card r-high heavy`, background rgb(255,253,249), border-left 3px
     * rgb(197,48,48). The border keyed off `riskTier`, and §1.2 established
     * that 100% of fleet approvals are high, so the strongest signal on the
     * page was on every card and therefore carried no information.
     *
     * It was worse than uninformative. The `apply-content` row in the same
     * seeded set — which can rewrite live listing content — is riskTier
     * 'medium', so it rendered as the CALMEST card on screen: plain white, 1px
     * grey. Risk tier and consequence are not weakly correlated here, they are
     * inverted.
     *
     * `canExecute` is the honest axis, the card already receives it, and it
     * already drives `needsAck`. Now it drives what the eye sees too. Colour is
     * never the sole carrier (WCAG 1.4.1): the consequence sentence and the
     * ack tick say the same thing in words on the same card.
     */
    <div
      className={`aq-card r-${approval.riskTier}${heavy ? ' heavy' : ''}${
        canExecute ? ' can-run' : ''
      }`}
    >
      {/*
        S6.c — the context row. Was three CHIPS (risk · reversibility · clock)
        at one size and one weight, mixing a policy tier, a consequence class
        and a deadline, plus eight colour combinations between them. That is the
        defect S2 had with its four tiles: three semantics, one visual weight.

        They are words now, one size down, out of the way of the delta.

        The REVERSIBILITY chip is DELETED rather than restyled: S6.a promoted
        the reversibility sentence into the always-visible consequence line, so
        the chip had become a second, shorter statement of the same fact — and
        two places that can drift is what `reversibilityOf` exists to prevent.
      */}
      <div className="aq-cardhead">
        <span className="aq-who">
          <strong>{workerName}</strong> {vocab.wants}
          {approval.business ? <> in <strong>{approval.business}</strong></> : null}
        </span>
        <span className="aq-meta">
          <Term k="risk-tier">{approval.riskTier} risk</Term>
          {left ? (
            <>
              {' · '}
              <span className={left.urgent ? 'aq-clock urgent' : undefined}>{left.text}</span>
            </>
          ) : null}
          {' · '}
          {ago(approval.requestedAt)}
        </span>
      </div>

      {/*
        S6.a (study Part 15) — THE READING ORDER.
        1 the delta · 2 what it acts on · 3 what it costs if wrong · 4 the verbs
        · 5 everything else. Measured before the change: ten blocks spanning a
        1.8x visual-weight range, with the ENTITY heaviest, the "changes nothing
        on Amazon" notice second, and the delta — the decision — only third.
        `aq-facts` was 212px of a 671px card while the delta got 43px.
      */}

      {/* A request that came back sits ABOVE the delta: it changes how the
          number below should be read, so it cannot come after it. */}
      {/* MCP.12 — the DS Banner, whose layout puts the icon beside the text: the
          page's own <p> had colours but no layout, so the icon sat on a line of
          its own above the sentence. Warning when it did not run; danger when it
          was attempted and failed (something was sent). */}
      {comeback ? (
        <Banner
          tone={comeback.attempted ? 'danger' : 'warning'}
          icon={<RotateCcw size={16} aria-hidden />}
          className="aq-cameback"
        >
          <span className="aq-camebacktext">
            <strong>{comeback.headline}</strong> {comeback.detail} {comeback.tail} Its waiting time restarted when it
            came back: handing it back asks the question again, so the full time to decide starts over.
          </span>
        </Banner>
      ) : null}

      {/* 1 — THE DELTA. First, and the only large type on the card.
          (f) While editing, the EDITOR takes this slot: the number being
          changed belongs where the number was, not in a panel further down. */}
      {editing && editable && proposedNow != null ? (
        <div className="aq-edit">
          <label className="aq-editrow">
            <span>Your {editable.label}</span>
            <span className="aq-editeuro">
              €
              <input
                autoFocus
                inputMode="decimal"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value)
                  setAmendErr(null)
                }}
              />
            </span>
            <span className="aq-editwas">the worker proposed €{(proposedNow / 100).toFixed(2)}</span>
          </label>
          <p className="aq-editnote">
            Between €{(editable.min / 100).toFixed(2)} and €{(editable.max / 100).toFixed(2)}. Your
            number is re-checked against the same rules the worker had to pass — the bid floor, the
            pins, the protected terms — and the worker&apos;s original proposal is kept on the
            record beside yours.
          </p>
          {amendErr ? <p className="aq-editerr">{amendErr}</p> : null}
          <div className="aq-editactions">
            {/* `.acr-btn go` — and still only ONE primary in the group, because
                the verb row is not rendered while this panel is open. Primer's
                rule is one primary per group, not one green button per card;
                the earlier reading kept Apply green while it promised a number
                the operator had just replaced, which is the worse failure. */}
            <button
              className="acr-btn go"
              disabled={busy || amending || !draftValid}
              onClick={async () => {
                setAmending(true)
                setAmendErr(null)
                try {
                  const r = await onAmend(approval.id, { [editable.arg]: draftCents })
                  if (!r.ok) setAmendErr(r.error ?? 'that change was refused')
                  else setEditing(false)
                } finally {
                  setAmending(false)
                }
              }}
            >
              {amending ? 'Checking…' : `Use €${(Number(draft) || 0).toFixed(2)} instead`}
            </button>
            <button className="acr-btn" disabled={busy || amending} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : content && content.rows.length > 0 ? (
        <ContentDiffView diff={content} more={more} />
      ) : d.deltas.length > 0 ? (
        <>
        {/* C9 — the one plain line of what it does, above its before → after table. */}
        {summary ? <p className="aq-entity">{summary}</p> : null}
        <ul className="aq-deltas">
          {d.deltas.map((x, i) => (
            <li key={i}>
              <span className="aq-dfield">{x.field}</span>
              {x.from != null ? (
                <>
                  <span className={x.from === EMPTY_VALUE ? 'aq-dfrom aq-dempty' : 'aq-dfrom'}>{x.from}</span>
                  <ArrowRight size={14} aria-hidden />
                </>
              ) : (
                <span className="aq-dnew">new</span>
              )}
              <span className="aq-dto">{x.to}</span>
            </li>
          ))}
          {/* MCP.12 — a bulk preview keeps 20 lines; the rest are counted, and the card says so. */}
          {more ? <li className="aq-dmore">{more}</li> : null}
        </ul>
        </>
      ) : (
        /* (h) the honest fallback — it takes the DELTA slot, at delta size,
           because an action that cannot describe itself is the most important
           fact on the card, not a footnote to it. */
        <p className="aq-nodelta">
          {summary ?? 'This action did not describe itself.'}
        </p>
      )}

      {/* C9 — its counts and its warnings, in words (the preview convention: totals, warning / warnings). */}
      {totals.length > 0 ? <KeyValue dense columns={2} items={totals.map((t) => ({ label: t.label, value: t.value }))} /> : null}
      {warnings.length > 0 ? (
        <Banner tone="warning" title={warnings.length === 1 ? 'Read this before approving' : `${warnings.length} things to read before approving`}>
          {warnings.length === 1 ? warnings[0] : <ul className="aq-evidence">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
        </Banner>
      ) : null}

      {/* 2 — what it acts on, beneath the number rather than above it */}
      {d.entity ? (
        <p className="aq-entity">
          on <strong>{d.entity}</strong>
          {d.marketplace ? ` · ${d.marketplace}` : ''}
        </p>
      ) : null}

      {/*
        3 — WHAT IT COSTS IF WRONG, and whether it can be undone.

        Two of the three questions this card exists to answer, promoted out of a
        collapsed 212px <dl> where they were the 2nd and 3rd items. The 72px
        "changes nothing on Amazon" banner collapses INTO this slot rather than
        competing with it: it IS a consequence statement. One slot, one voice,
        whether the action can execute or not — which is also the ONLY place an
        S5 card (one that can really reach Amazon) differs from a fleet one.
      */}
      <p className={`aq-consequence${!canExecute ? ' inert' : ''}`}>
        {!canExecute ? (
          <>
            Approving records your decision and teaches the fleet — it{' '}
            <strong>changes nothing on Amazon</strong>, because this action has no way to run
            yet.
          </>
        ) : (
          <>
            {vocab.wrongCost} {REVERSIBILITY[rev].sentence}
          </>
        )}
      </p>

      {/*
        5 — everything else, behind ONE control. Stripe Radar's "Show all
        insights": a few named signals, the rest one click away rather than
        fifteen blocks down. The dead `!heavy` toggle is gone — `heavy` was true
        for every fleet tool, so the compact lane never rendered, and Pajamas'
        lowest tier says the answer is NO friction rather than hidden content.
      */}
      <button
        className="aq-why"
        aria-expanded={showWhy}
        onClick={() => setShowWhy(!showWhy)}
      >
        {showWhy ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {showWhy ? 'Hide the detail' : 'Why this was proposed'}
      </button>

      {showWhy ? (
        <dl className="aq-facts">
          {d.deltas.length > 0 && typeof approval.preview?.effect === 'string' ? (
            <div>
              <dt>What it does</dt>
              <dd>{approval.preview.effect as string}</dd>
            </div>
          ) : null}
          {channels ? (
            <div>
              <dt>What each marketplace gets</dt>
              <dd>
                <ChannelEffectDetail effect={channels} />
              </dd>
            </div>
          ) : null}
          {d.evidence.length > 0 ? (
            <div>
              <dt>What it is going on</dt>
              <dd>
                <ul className="aq-evidence">
                  {d.evidence.map((e, i) => (
                    <li key={i}>
                      <span>{e.label}</span>
                      <strong>{e.value}</strong>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
          {approval.trackRecord && approval.trackRecord.total > 0 ? (
            <div>
              <dt>How this worker has fared with you</dt>
              <dd>
                You have answered {approval.trackRecord.total} of these before —{' '}
                {approval.trackRecord.approved} approved, {approval.trackRecord.rejected}{' '}
                rejected.
                {approval.trackRecord.rejected > approval.trackRecord.approved
                  ? ' You have said no more often than yes.'
                  : ''}
              </dd>
            </div>
          ) : null}
          {approval.expiresAt ? (
            <div>
              <dt>If you do nothing</dt>
              <dd>
                It expires {new Date(approval.expiresAt).toLocaleString()} and is recorded as
                refused. Expiry never means approved.
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {/*
        S6.b (study Part 15.4) — THE ACTION AREA.

        Four things were wrong with it and all four were structural:
        · the optional NOTE rendered BELOW the buttons that consume it, so
          annotating a decision meant scrolling past it, typing, and coming back;
        · TWO `.acr-btn.go` primaries rendered at once when the editor was open,
          which Primer forbids outright;
        · the recheck button — a rare, tertiary control — sat ABOVE the primary
          action;
        · the reject codes STACKED BELOW the verb row, so the card briefly
          showed two competing action areas.

        Order now: the gate, the input, the verbs, then the rare controls.
      */}

      {/* The only friction on this card, and only where a yes is irreversible
          and can actually run (Pajamas' high tier). Immediately above the verb
          it gates — a checkbox that gates a button two blocks away is a puzzle. */}
      {needsAck ? (
        <label className="aq-ack">
          <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} />
          <span>
            I have read what this does
            {rev === 'never' ? ' — and that it cannot be undone' : ''}.
          </span>
        </label>
      ) : null}

      {/* An INPUT to the decision, so it precedes the decision. */}
      <label className="aq-notewrap">
        <span className="aq-notelabel">Note (optional)</span>
        <input
          className="aq-note"
          placeholder="Recorded either way — it is what teaches the fleet"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>

      {/* The verbs. When rejecting, the coded reasons REPLACE this row rather
          than appearing beneath it, so there is never more than one action area.

          Editing replaces it for the same reason, and for a sharper one. Typing
          a corrected number does not change what Apply promises: with "0.60" in
          the box the primary still read "Apply — bid €0.31 → €0.84", so the one
          obviously-clickable button applied the number the operator had just
          overridden and threw the edit away. Found by typing into the deployed
          card — nothing static could see it. Mid-edit the only ways forward are
          "Use €X instead" and Cancel, and the edit-submit is now the primary. */}
      {editing && editable && proposedNow != null ? null : rejecting ? (
        <div className="aq-reject">
          <p className="aq-rejectq">
            Why not? One click — this is what teaches the fleet.
            <button className="aq-rejectcancel" disabled={busy} onClick={() => setRejecting(false)}>
              Cancel
            </button>
          </p>
          <div className="aq-codes">
            {rejectCodesFor(approval.toolName).map((code) => (
              <button
                key={code}
                className="aq-code"
                disabled={busy}
                onClick={() =>
                  onDecide(approval.id, 'reject', note.trim() ? `${code} — ${note.trim()}` : code)
                }
              >
                {code}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
        <div className="aq-actions">
          {/* The card's ONE primary. It states the consequence, not the verb. */}
          <button
            className="acr-btn go"
            disabled={busy || approveBlocked || notYours !== null}
            title={notYours ?? (approveBlocked ? 'Tick the box above first.' : undefined)}
            aria-describedby={notYours ? notYoursId : undefined}
            onClick={() => onDecide(approval.id, 'approve', note.trim() || undefined)}
          >
            <Check size={13} /> {approveLabel}
          </button>
          <button className="acr-btn" disabled={busy} onClick={() => setRejecting(true)}>
            <X size={13} /> Reject
          </button>

          {/* "Not now" — quiet and last. An escape, not a verb. */}
          {snoozeOptions.length > 0 ? (
            <span className="aq-snooze">
              <Clock size={12} aria-hidden /> Not now —
              {snoozeOptions.map((o) => (
                <button
                  key={o.label}
                  className="aq-snoozeopt"
                  disabled={busy}
                  onClick={() => onSnooze(approval.id, new Date(Date.now() + o.ms))}
                >
                  {o.label}
                </button>
              ))}
            </span>
          ) : null}
        </div>
        {/* Written out, not only a tooltip: a disabled button's tooltip is not reachable by keyboard. */}
        {notYours ? (
          <p className="aq-editnote" id={notYoursId}>
            You cannot apply this: {notYours} You can still reject it.
          </p>
        ) : null}
        </>
      )}

      {/* The rare controls, BELOW the verbs and visibly lighter. Neither is
          part of deciding; both were competing with it. */}
      <div className="aq-tertiary">
        <button
          className="aq-tlink"
          disabled={busy || rechecking}
          onClick={async () => {
            setRechecking(true)
            try {
              setRecheck(await onRecheck(approval.id))
            } finally {
              setRechecking(false)
            }
          }}
        >
          <FileText size={12} /> {rechecking ? 'Checking…' : 'Check this is still true'}
        </button>
        {editable && proposedNow != null && !editing ? (
          <button className="aq-tlink" disabled={busy} onClick={() => setEditing(true)}>
            <Pencil size={12} /> Right idea, wrong number?
          </button>
        ) : null}
        {recheck ? (
          <span className={recheck.stale ? 'aq-rc-stale' : 'aq-rc-ok'}>
            {recheck.stale
              ? `The facts have moved — ${recheck.why ?? 'this no longer applies'}`
              : 'Still true as of just now.'}
          </span>
        ) : null}
      </div>
    </div>
  )
}
