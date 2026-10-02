'use client'

/**
 * FX.6 — one pending approval as a decision card, built to the
 * human-in-the-loop checklist: what happens, why you're being asked,
 * the evidence chain, the expected effect (labelled an estimate),
 * reversibility, and the cost of being wrong — decidable without
 * leaving the card. Buttons name their actual effect; a reject demands
 * the one-line reason that becomes precedent.
 *
 * NAF.AP.3 rebuilds three things that were wrong:
 *
 * 1. The vocabulary was inverted. It covered the three fleet tools, which
 *    have produced ZERO approvals, and fell through to "Unknown for this
 *    action type" for the four tools behind all 18 real ones — leaving the
 *    two most decision-relevant facts blank exactly where there is history.
 * 2. Every card looked the same. Review depth now scales with consequence:
 *    a reversible bid nudge is compact, an irreversible customer message is
 *    not. An identical card for both is what trains a rubber stamp.
 * 3. The "what happens" line read `preview.effect` and fell back to
 *    `JSON.stringify(args)`. Fleet tools emit `effect`; the legacy shape is
 *    `{ note, action, changes }`, so a pre-fleet approval would have shown
 *    the operator raw JSON. It never shows raw JSON now.
 */

import { useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  History,
  RotateCcw,
  ShieldAlert,
  X,
} from 'lucide-react'
import { Button, Checkbox, Input } from '@/design-system/primitives'
import { Term } from './glossary'
import type { StoryPlan } from './PlanStory'
import { reversibilityFrom, type Reversibility } from '@/app/fleet/approvals/reversibility'

interface Approval {
  id: string
  toolName: string
  charterKey: string | null
  riskTier: string
  args: Record<string, unknown>
  preview: Record<string, unknown> | null
  requestedAt: string
  expiresAt: string | null
  /** AP.6 — why a previously-approved action came back unrun. */
  reason?: string | null
  /** AP.8 — how this worker's proposals of this kind have fared with you. */
  trackRecord?: { approved: number; rejected: number; total: number } | null
  /** C1 — how far it can be put back, as the API states it from the tool registry. */
  reversibility?: Reversibility | null
}

export interface ToolCard {
  /** Follows "wants to …" */
  wants: string
  /** Follows "asked to …" in the history list. */
  shortAsk: string
  approveLabel: string
  /**
   * The words for how it is put back. Whether it CAN be is not stated here: the API sends `reversibility` on each
   * row, from the tool registry (C1), and the card's depth and chip follow that.
   */
  reversible: string
  wrongCost: string
  /** MCP.12 — true when running it changes Nexus only: no marketplace is sent anything by it. */
  nexusOnly?: boolean
}

export const TOOL_CARDS: Record<string, ToolCard> = {
  /* ── the fleet's own propose-tools ─────────────────────────────────── */
  'create-negative-keyword': {
    wants: 'wants to add a negative keyword',
    shortAsk: 'stop ads showing for a search term',
    approveLabel: 'Add this negative keyword',
    reversible: 'Yes — a negative keyword can be removed at any time and ads resume.',
    wrongCost:
      'If this is wrong, you stop showing ads on a search that was actually converting — sales from that search stop until you remove it.',
  },
  'graduate-keyword': {
    wants: 'wants to promote a search term to its own keyword',
    shortAsk: 'promote a search term to its own keyword',
    approveLabel: 'Create this keyword',
    reversible: 'Yes — the new keyword can be paused or archived at any time.',
    wrongCost:
      'If this is wrong, you spend on a keyword that does not convert — bounded by its bid and visible within days.',
  },
  'set-target-bid': {
    wants: 'wants to change a bid',
    shortAsk: "change a keyword's bid",
    approveLabel: 'Set this bid',
    reversible: 'Yes — the previous bid is recorded and can be restored.',
    wrongCost:
      'If this is wrong, you pay more per click (or lose visibility) on one keyword until the bid is corrected.',
  },

  /* ── MCP full control C6 — a change plan: one approval for many changes ── */
  'submit-change-plan': {
    wants: 'wants to run a change plan',
    shortAsk: 'run the change plan, step by step',
    approveLabel: 'Approve the plan',
    reversible: 'Each change is recorded; undo asks for one plan that puts every change back.',
    wrongCost:
      'If this is wrong, every change in it lands — each step is checked again before it runs, and one whose facts moved is skipped.',
  },

  /* ── MCP full control A6–A10, A12 · the Amazon ad changes Claude asks for ── */
  'set-campaign-budget': {
    wants: "wants to change a campaign's daily budget",
    shortAsk: 'change a campaign budget',
    approveLabel: 'Set this budget',
    reversible: 'Yes — the previous budget is recorded; undo sets it back.',
    wrongCost:
      'If this is wrong, the campaign may spend up to the new daily budget (or loses reach at a lower one) until it is changed back.',
  },
  'set-placement-multipliers': {
    wants: "wants to change a campaign's placement adjustments",
    shortAsk: 'change placement adjustments',
    approveLabel: 'Set these adjustments',
    reversible: 'Yes — the previous adjustments are recorded; undo sets them back.',
    wrongCost:
      'If this is wrong, bids on top of search, product pages or the rest of search are raised or lowered by the wrong share until changed back.',
  },
  'bulk-ad-bid-change': {
    wants: 'wants to change many bids at once',
    shortAsk: 'change bids in bulk',
    approveLabel: 'Set these bids',
    reversible: 'Yes — every bid is recorded in one change set; undo puts them all back in one step.',
    wrongCost:
      'If this is wrong, you pay more per click (or lose visibility) on every keyword in the request until it is undone.',
  },
  'suppress-campaign': {
    wants: "wants to lower a campaign's bids to the floor (never a pause)",
    shortAsk: 'lower a campaign to the floor',
    approveLabel: 'Lower the bids to the floor',
    reversible: 'Yes — every bid is remembered; restore-campaign puts them back.',
    wrongCost:
      'If this is wrong, the campaign gets next to no impressions or sales until its bids are restored.',
  },
  'restore-campaign': {
    wants: "wants to put a suppressed campaign's bids back",
    shortAsk: 'restore a suppressed campaign',
    approveLabel: 'Restore these bids',
    reversible: 'Yes — suppress-campaign lowers them to the floor again.',
    wrongCost:
      'If this is wrong, the campaign spends again at its earlier bids until it is lowered again.',
  },
  'set-campaign-live-writes': {
    wants: 'wants to change whether a campaign takes live writes',
    shortAsk: "change a campaign's live-write switch",
    approveLabel: 'Apply this switch',
    reversible: 'Yes — the switch can be flipped back.',
    wrongCost:
      'If this is wrong, approved changes, rules and schedules reach this campaign at Amazon (or stop reaching it) until it is switched back.',
    nexusOnly: true,
  },
  'undo-ad-change': {
    wants: 'wants to undo an ad change',
    shortAsk: 'undo an ad change',
    approveLabel: 'Undo this change',
    reversible: 'No — an undo is not undone in turn; the original change can be asked for again.',
    wrongCost:
      'If this is wrong, bids, budgets or placements go back to their earlier values (and negative keywords it created are removed at Amazon) until they are changed again.',
  },

  /* ── MCP full control A11 · a new Amazon campaign Claude asks for ───── */
  'create-ad-campaign': {
    wants: 'wants to create a new Amazon campaign',
    shortAsk: 'create an Amazon campaign',
    approveLabel: 'Create this campaign',
    reversible:
      'No — Nexus never deletes, archives or pauses a campaign. It is born with every bid at the 2-cent floor and off the live-write allowlist, so it spends next to nothing until a person approves restore-campaign.',
    wrongCost:
      'If this is wrong, a campaign you did not want exists: it serves at the 2-cent floor, next to no spend, for as long as nobody restores its bids.',
  },

  /* ── MCP full control A14/A15 · the eBay ad changes Claude asks for ──── */
  'set-ebay-ad-rates': {
    wants: 'wants to change eBay ad rates',
    shortAsk: 'change eBay ad rates',
    approveLabel: 'Set these rates',
    reversible: 'Yes — the previous rates are recorded; undo sets them back. A rate above break-even is never set.',
    wrongCost:
      'If this is wrong, you pay a higher (or get less visibility at a lower) share of each sale on these listings until changed back. eBay writes have no cancel window.',
  },
  'promote-ebay-listings': {
    wants: 'wants to promote listings on eBay',
    shortAsk: 'promote eBay listings',
    approveLabel: 'Promote these listings',
    reversible: "Partly — Nexus never removes an ad; undo lowers each promoted listing to eBay's 2% minimum rate.",
    wrongCost:
      'If this is wrong, you pay the ad rate on sales of listings you did not mean to promote until their rate is lowered.',
  },
  'set-ebay-campaign-budget': {
    wants: "wants to change an eBay campaign's daily budget",
    shortAsk: 'change an eBay campaign budget',
    approveLabel: 'Set this budget',
    reversible: 'Yes — the previous budget is recorded; undo sets it back (eBay allows 15 budget changes a day).',
    wrongCost:
      'If this is wrong, the campaign may spend up to the new daily budget on clicks (or loses reach at a lower one) until changed back.',
  },
  'ebay-keywords-change': {
    wants: 'wants to change eBay keywords',
    shortAsk: 'change eBay keywords',
    approveLabel: 'Apply these keyword changes',
    reversible: 'Partly — old bids go back and added keywords drop to the 2-cent floor; added negative keywords stay.',
    wrongCost:
      'If this is wrong, you pay more per click (or lose visibility) on these keywords until changed back. A keyword is never paused here.',
  },
  'create-ebay-campaign': {
    wants: 'wants to create a new eBay campaign',
    shortAsk: 'create an eBay campaign',
    approveLabel: 'Create this campaign',
    reversible: 'No — Nexus never ends or deletes a campaign. It starts as low as eBay allows and spends nothing until listings are promoted in it.',
    wrongCost:
      'If this is wrong, an empty campaign you did not want exists: it spends nothing while no listing is promoted in it.',
  },

  /* ── the tools that have actually produced every approval so far ───── */
  'apply-content': {
    wants: "wants to change a listing's content",
    shortAsk: 'change listing content',
    approveLabel: 'Apply this content change',
    reversible: 'Yes — the previous content is stored and can be restored.',
    wrongCost:
      'If this is wrong, the listing shows incorrect copy until you revert it, and Amazon may take time to re-index the correction.',
  },
  'set-price': {
    wants: 'wants to change a price',
    shortAsk: 'change a price',
    approveLabel: 'Set this price',
    reversible: 'Yes — the previous price is recorded and can be restored.',
    wrongCost:
      'If this is wrong, you sell at the wrong price until it is corrected — and any orders placed in the meantime stand at that price.',
  },
  'publish-listing': {
    wants: 'wants to publish a listing',
    shortAsk: 'publish a listing',
    approveLabel: 'Publish this listing',
    reversible:
      'Partly — the listing can be taken down, but it may already have been indexed and seen by shoppers.',
    wrongCost:
      'If this is wrong, an incomplete or incorrect listing is publicly visible until you pull it.',
  },
  /* ── MCP.12 · the bulk changes a person asks for through Claude ─────── */
  'bulk-price-change': {
    // Count-neutral: one bulk request can name a single product.
    wants: 'wants to change master prices',
    shortAsk: 'change master prices',
    approveLabel: 'Apply these prices',
    // C1 — undo now puts every price back in one step (a new request of the same kind, approved like this one).
    reversible:
      'Yes — each previous master price is recorded and Undo sets them back, sending the old prices to the marketplaces again; orders placed at the new price in the meantime stand.',
    wrongCost:
      'If this is wrong, every listing that follows the master price sells at the wrong price on its marketplace until it is corrected — and orders placed in the meantime stand at that price.',
  },
  /* ── C2 · what Undo of a bulk price change asks for ─────────────────── */
  'set-master-prices': {
    wants: 'wants to set master prices, each to its own value',
    shortAsk: 'set master prices one by one',
    approveLabel: 'Apply these prices',
    reversible:
      'Yes — each previous master price is recorded and Undo sets them back, sending the old prices to the marketplaces again; orders placed at the new price in the meantime stand.',
    wrongCost:
      'If this is wrong, every listing that follows the master price sells at the wrong price on its marketplace until it is corrected — and orders placed in the meantime stand at that price.',
  },
  'bulk-attribute-change': {
    wants: 'wants to change product attributes',
    shortAsk: 'change product attributes, in Nexus only',
    approveLabel: 'Apply these values',
    reversible:
      'Yes — it changes Nexus only, and each previous value is recorded, so another change can put them back before anything is published.',
    wrongCost:
      'If this is wrong, Nexus holds wrong values until they are corrected. No marketplace changes until someone publishes from Nexus — and then the wrong values go with it.',
    nexusOnly: true,
  },
  /* ── MCP full control, section 03 · product text, in Nexus only (d7), approved = reviewed (d8) ── */
  'set-content': {
    wants: "wants to change a product's text",
    shortAsk: "change a product's text, in Nexus only",
    approveLabel: 'Apply this text',
    reversible:
      'Yes — it changes Nexus only, and the text it replaces is recorded, so Undo can put it back before anything is published.',
    wrongCost:
      'If this is wrong, every listing that follows this text shows it once the listings are published from Nexus — read the English meaning beside each new text. Approving it counts as its review. No marketplace changes until someone publishes.',
    nexusOnly: true,
  },
  'set-listing-content': {
    wants: "wants to change one listing's own text",
    shortAsk: "change one listing's own text, in Nexus only",
    approveLabel: 'Apply this listing text',
    reversible:
      'Yes — it changes Nexus only, and what the listing held before is recorded, so Undo can put it back before anything is published.',
    wrongCost:
      'If this is wrong, this one listing shows the wrong text once it is published from Nexus. The shared text and the other listings do not change. Approving it counts as its review.',
    nexusOnly: true,
  },
  'set-shopify-content': {
    wants: "wants to change a Shopify listing's store fields",
    shortAsk: "change a Shopify listing's store fields, in its Nexus draft",
    approveLabel: 'Apply these store fields',
    reversible:
      'Yes — it changes the listing\'s Nexus draft only, and what the draft held before is recorded, so Undo can put it back before the listing is synchronized.',
    wrongCost:
      'If this is wrong, the Shopify listing gets the wrong values once its draft is synchronized from Nexus. Its automation waits for a review first. Approving it counts as its review.',
    nexusOnly: true,
  },
  'bulk-content-change': {
    wants: 'wants to change the text of several products',
    shortAsk: 'change the text of several products, in Nexus only',
    approveLabel: 'Apply these texts',
    reversible:
      'Yes — it changes Nexus only, and every text it replaces is recorded, so Undo can put them back before anything is published.',
    wrongCost:
      'If this is wrong, every listing that follows these texts shows them once the listings are published from Nexus — read the English meaning beside each new text. Approving it counts as their review. No marketplace changes until someone publishes.',
    nexusOnly: true,
  },
  /* ── I10 · identity fixes: Nexus only ─────────────────────────────── */
  'set-product-sku': {
    wants: "wants to rename a product's SKU",
    shortAsk: 'rename a product SKU, in Nexus only',
    approveLabel: 'Rename this SKU',
    reversible: 'Yes — it changes Nexus only, and the old SKU is recorded, so Undo renames it back.',
    wrongCost:
      'If this is wrong, imports, files and orders that use the old SKU no longer find the product until it is renamed back. A product live on a channel is never renamed.',
    nexusOnly: true,
  },
  'set-gtin': {
    wants: 'wants to set a barcode',
    shortAsk: 'set a GTIN, EAN or UPC, in Nexus only',
    approveLabel: 'Set this barcode',
    reversible: 'Yes — it changes Nexus only, and the old barcode is recorded, so Undo puts it back.',
    wrongCost:
      'If this is wrong, the next publish sends a wrong barcode, and a channel may match the listing to another catalogue item.',
    nexusOnly: true,
  },
  'set-brand': {
    wants: 'wants to set product brands',
    shortAsk: 'set brands, in Nexus only',
    approveLabel: 'Set these brands',
    reversible: 'Yes — it changes Nexus only, and each old brand is recorded, so Undo puts each one back.',
    wrongCost:
      'If this is wrong, Nexus holds the wrong brand until it is corrected, and the next publish sends it.',
    nexusOnly: true,
  },
  'set-listing-sku': {
    wants: "wants to record an extra listing's SKU",
    shortAsk: "record an extra listing's SKU, in Nexus only",
    approveLabel: 'Record this SKU',
    reversible: 'Yes — it changes Nexus only, and the old value is recorded, so Undo puts it back.',
    wrongCost:
      'If this is wrong, imports and files that name the listing by its SKU find the wrong one. Nothing changes on the channel.',
    nexusOnly: true,
  },
  /* ── I9 · channel ids ───────────────────────────────────────────────── */
  'unlink-channel-id': {
    wants: 'wants to unlink a channel id from a listing',
    shortAsk: 'stop Nexus driving a channel item',
    approveLabel: 'Unlink this id',
    reversible: 'Mostly — Undo links the id again after checking it on the channel; the listing stays paused until you resume it.',
    wrongCost:
      'If this is wrong, the item stays live on the channel with the stock it last showed and Nexus no longer updates it, so it can oversell until it is linked again.',
    nexusOnly: true,
  },
  'link-channel-id': {
    wants: 'wants to link a listing to a channel item',
    shortAsk: 'link a listing to a channel item',
    approveLabel: 'Link this item',
    reversible: 'Yes — Undo unlinks it again.',
    wrongCost:
      'If this is wrong, Nexus would drive another item once you resume pushes: the channel was checked (the seller and the SKUs), but read the proof before you approve.',
  },
  /* ── I11 · families and duplicates: Nexus only ─────────────────────── */
  'fix-parent': {
    wants: "wants to fix a product's family",
    shortAsk: 'change which parent a product belongs to, in Nexus only',
    approveLabel: 'Fix this family',
    reversible: 'Mostly — Undo puts the product back under its old parent when that parent is still a live parent; marking a parent is undone in Nexus.',
    wrongCost:
      'If this is wrong, the variation shows under the wrong family in Nexus until it is moved back. Its listings keep their channel ids.',
    nexusOnly: true,
  },
  'merge-duplicate-products': {
    wants: 'wants to merge a duplicate product',
    shortAsk: 'merge a duplicate product, in Nexus only',
    approveLabel: 'Merge this duplicate',
    reversible: 'Partly — the duplicate goes to the trash, never deleted: restore it there, and move an adopted listing back, in Nexus.',
    wrongCost:
      'If this is wrong, a product disappears from the catalogue until it is restored from the trash. Only a duplicate holding no stock, orders, listings, shared links or ads is merged.',
    nexusOnly: true,
  },
  'send-customer-message': {
    wants: 'wants to send a message to a customer',
    shortAsk: 'send a message to a customer',
    approveLabel: 'Send this message',
    reversible: 'No — a sent message cannot be recalled.',
    wrongCost:
      'If this is wrong, a real customer receives incorrect or unwanted contact, which can count against your Amazon account health.',
  },
}

const humanize = (s: string) => s.replace(/[_-]+/g, ' ').trim()

/**
 * The honest fallback. "Unknown for this action type" told the operator
 * nothing and read as reassurance; an unrecorded consequence is treated as
 * an irreversible one, which is the safe direction to be wrong in.
 */
export function toolCardFor(toolName: string): ToolCard {
  return (
    TOOL_CARDS[toolName] ?? {
      wants: `proposes to run ${humanize(toolName)}`,
      shortAsk: humanize(toolName),
      approveLabel: `Run ${humanize(toolName)}`,
      reversible:
        'Not recorded for this action — treat it as something that cannot be undone until someone confirms otherwise.',
      wrongCost:
        'Not recorded for this action. Because the consequence is unknown, read the details below before approving.',
    }
  )
}

const ago = (iso: string) => {
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000)
  if (h < 1) return 'just now'
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const UNDO_WORD: Record<Reversibility, string> = {
  full: 'can be undone',
  partial: 'only partly undoable',
  none: 'cannot be undone',
}
/** The chip's class, unchanged from when the card kept its own copy (u-yes / u-partial / u-no). */
const UNDO_CLASS: Record<Reversibility, string> = { full: 'yes', partial: 'partial', none: 'no' }

/**
 * What this action will do, in a sentence. Fleet tools give us `effect`;
 * the legacy shape gives `note` plus a `changes` map. Raw JSON is never a
 * headline — if we have nothing readable we say so and let the disclosure
 * carry the detail.
 */
function whatHappens(preview: Record<string, unknown> | null): string | null {
  if (!preview) return null
  const effect = preview.effect
  if (typeof effect === 'string' && effect.trim()) return effect
  const note = preview.note
  if (typeof note === 'string' && note.trim()) return note
  const changes = preview.changes
  if (changes && typeof changes === 'object') {
    const fields = Object.keys(changes as Record<string, unknown>)
    if (fields.length > 0) {
      return `Changes ${fields.length === 1 ? 'one field' : `${fields.length} fields`}: ${fields.join(', ')}.`
    }
  }
  return null
}

export function DecisionCard({
  approval,
  workerName,
  plans,
  busy,
  onDecide,
  onOpenPlan,
}: {
  approval: Approval
  workerName: string
  plans: StoryPlan[]
  busy: boolean
  onDecide: (id: string, decision: 'approve' | 'reject', reason?: string) => void
  onOpenPlan: (planId: string) => void
}) {
  const card = toolCardFor(approval.toolName)
  // C1 — from the row (the tool registry, through the API); what the page cannot read counts as `none`.
  const undo = reversibilityFrom(approval.reversibility)

  // AP.3 — review depth scales with consequence. High risk, or anything we
  // cannot promise is undoable, gets the full card open from the start.
  const heavy = approval.riskTier === 'high' || undo === 'none'
  const [showDetail, setShowDetail] = useState(heavy)

  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  // AP.8 — the Article 14 gate. For a high-risk or irreversible action,
  // approving takes a deliberate act, not a reflex. Everything is still
  // SHOWN (AP.3's promise); what changes is that the button waits for a
  // person to say they have read it. Applied here only — blanket friction
  // is what trains the click-through it exists to prevent.
  // The gate applies exactly where the card is already heavy. An
  // unrecorded consequence is described to the operator as "treat it as
  // something that cannot be undone" — gating it too is the only way the
  // words and the behaviour agree. In practice this is high risk and
  // irreversible actions only; every fleet tool is mapped, so it does not
  // become the blanket friction that breeds click-through.
  const needsAck = heavy
  const [acknowledged, setAcknowledged] = useState(false)
  const approveBlocked = needsAck && !acknowledged

  // Evidence chain: the plan that queued this approval, and its matching item.
  const plan = plans.find((p) => p.approvalIds?.includes(approval.id))
  const item = plan?.items.find(
    (i) => i.tool === approval.toolName && JSON.stringify(i.args) === JSON.stringify(approval.args),
  )
  const summary = whatHappens(approval.preview)

  return (
    <div className={`acr-fl-dcard ap-card r-${approval.riskTier}${heavy ? ' heavy' : ''}`}>
      <div className="acr-fl-dcard-head">
        <strong>{workerName}</strong> {card.wants}
        <span className="ap-chips">
          <Term k="risk-tier">
            <span className={`dt-risk r-${approval.riskTier}`}>{approval.riskTier} risk</span>
          </Term>
          <span className={`ap-undo u-${UNDO_CLASS[undo]}`}>{UNDO_WORD[undo]}</span>
        </span>
        <span className="acr-fl-sub">{ago(approval.requestedAt)}</span>
      </div>

      <p className="acr-fl-dcard-what">
        {summary ?? 'This action did not describe itself — read the details below before deciding.'}
      </p>

      {/* AP.8 — automation bias is the named failure mode. A worker whose
          last suggestions of this exact kind you rejected deserves a slower
          read, so its record sits next to the ask rather than buried. */}
      {approval.trackRecord && approval.trackRecord.total > 0 ? (
        <p
          className={`ap-record${
            approval.trackRecord.rejected > approval.trackRecord.approved ? ' doubted' : ''
          }`}
        >
          <History size={12} aria-hidden />
          You have answered {approval.trackRecord.total} of these from this worker before —{' '}
          {approval.trackRecord.approved} approved, {approval.trackRecord.rejected} rejected.
          {approval.trackRecord.rejected > approval.trackRecord.approved
            ? ' You have said no more often than yes.'
            : ''}
        </p>
      ) : null}

      {/* AP.6 — this was approved once and refused at run time because the
          facts had moved. Handing it back silently would be the worst of
          both worlds, so the card says what happened. */}
      {approval.reason?.startsWith('not run —') ? (
        <p className="ap-cameback">
          <RotateCcw size={12} aria-hidden />
          <span>
            <strong>You approved this before, and it did not run.</strong>{' '}
            {approval.reason.replace(/^not run — /, '')} — it is back here so you can decide
            again with the facts as they are now.
          </span>
        </p>
      ) : null}

      {heavy ? (
        <p className="ap-heavy-note">
          <ShieldAlert size={12} aria-hidden />
          {undo === 'none'
            ? 'This one cannot be taken back once it runs. Everything is shown in full below.'
            : 'High risk, so nothing is hidden — every fact is shown below.'}
        </p>
      ) : null}

      {/* Low-risk reversible actions keep the facts one click away; heavy
          ones never hide them. */}
      {!heavy ? (
        <Button
          variant="quiet" size="xs" inline
          className="acr-fl-checkstoggle"
          aria-expanded={showDetail}
          onClick={() => setShowDetail(!showDetail)}
        >
          {showDetail ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {showDetail ? 'Hide the details' : 'Show what this means, and what it costs to be wrong'}
        </Button>
      ) : null}

      {showDetail ? (
        <dl className="acr-fl-dcard-facts">
          <div>
            <dt>Why you&apos;re being asked</dt>
            <dd>
              This worker is at <Term k="propose">PROPOSE</Term> — nothing it suggests happens
              without your yes, and this card is the only gate left before Amazon.
            </dd>
          </div>
          {item?.expectedEffect ? (
            <div>
              <dt>Expected effect (the worker&apos;s estimate)</dt>
              <dd>
                {item.expectedEffect.metric} {item.expectedEffect.direction} ~
                {item.expectedEffect.magnitudePct}% over {item.expectedEffect.horizonDays} days
                {item.expectedEffect.basis ? ` — based on: ${item.expectedEffect.basis}` : ''}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Can it be undone?</dt>
            <dd>{card.reversible}</dd>
          </div>
          <div>
            <dt>If it turns out wrong</dt>
            <dd>{card.wrongCost}</dd>
          </div>
        </dl>
      ) : null}

      {plan ? (
        <Button variant="link" inline  className="acr-fl-dcard-plan" onClick={() => onOpenPlan(plan.id)}>
          <FileText size={12} /> From the plan “{plan.headline}” — see the full story and the
          critic&apos;s review
        </Button>
      ) : null}

      {needsAck ? (
        <label className="ap-ack">
          {/* `tone="warning"` rather than the default blue: this tick authorises a write to
              Amazon, and the DS added the prop for exactly this call site — `.ap-ack` had been
              re-declaring `accent-color: #8a6320` because the primitive knew one colour. */}
          <Checkbox
            tone="warning"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>
            I have read what this does
            {undo === 'none' ? ' — and that it cannot be undone' : ''}.
          </span>
        </label>
      ) : null}

      <div className="acr-fl-apactions">
        <Button
          variant="success" size="sm"
          disabled={busy || approveBlocked}
          title={
            approveBlocked
              ? 'Tick the box above first — this one is high risk or cannot be undone.'
              : undefined
          }
          onClick={() => onDecide(approval.id, 'approve')}
        >
          <Check size={13} /> {card.approveLabel}
        </Button>
        {rejecting ? (
          <span className="acr-fl-rejectrow">
            <Input
              autoFocus
              fieldClassName="acr-fl-reasonfield"
              placeholder="one-line reason — this teaches the fleet"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <Button
              variant="quiet" size="sm"
              disabled={busy || !reason.trim()}
              onClick={() => onDecide(approval.id, 'reject', reason.trim())}
            >
              Confirm rejection
            </Button>
            <Button variant="quiet" size="sm" disabled={busy} onClick={() => setRejecting(false)}>
              Cancel
            </Button>
          </span>
        ) : (
          <Button variant="quiet" size="sm" disabled={busy} onClick={() => setRejecting(true)}>
            <X size={13} /> Reject, with a reason
          </Button>
        )}
      </div>
      <p className="acr-fl-dcard-teach">
        Your decision — and especially a reject reason — becomes{' '}
        <Term k="exemplar">precedent</Term> the workers read on their next run. It is recorded
        against your name, and approving gives you an{' '}
        <Term k="undo-window">undo window</Term> before anything happens.
      </p>
    </div>
  )
}
