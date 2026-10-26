/**
 * Meta ads changes, step 43 (2026-10-26) — the two business-asset changes Nexus's OWN token may make (the admin-only acts
 * of this step are the Owner's steps in Meta's screens: meta-ads-business-assets.tools.ts, D1):
 *   create-meta-backed-account  a Page-backed Instagram account for the chosen Page (BM-051), an Instagram-backed Threads
 *                               account for the chosen Instagram account (CR-228) or a Page-backed Threads account for the
 *                               chosen Page (CR-230): Meta's "shadow" identities ads may use (a Page role ADVERTISER,
 *                               MANAGER or CONTENT_CREATOR is enough; Standard access). No delete: no undo.
 *   set-meta-billing            the invoice groups of the business portfolio's OWN Meta credit line (BM-903 … BM-907): make
 *                               one, rename one, bill the chosen ad account on one or take it out, delete an empty one
 *                               (explicit ask: confirmDelete). Which invoice an ad account's spend lands on is money: said
 *                               plainly in every preview; never in a bulk approve.
 * Each a Nexus change like set-meta-status (meta-ads-kit.ts): a preview from the live state, an approvalId, a person
 * approves it, it runs as that person, and undo puts back what it changed (or the preview says it has none). The floors are
 * refused before Meta is called (change-business-assets.ts), and again by the gateway with its own reads
 * (gateway/meta-business-asset-owner.ts): only the chosen Page / Instagram account; only a credit line the chosen ad
 * account's portfolio owns, never one another business in Nexus shares; never a group that bills another business's ad
 * account; only the chosen ad account moved; only an empty group deleted. Meta's own MCP has no tool for these.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, recordAccount, runMetaChange, type MetaDraftBuilder } from './meta-ads-kit.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { MetaReadError } from '../../marketing/meta-ads/errors.js'
import type { MetaChangeDraft, MetaChangeRequest } from '../../marketing/meta-ads/change-draft.js'
import { createdIdOf, type MetaChangeResult } from '../../marketing/meta-ads/write-client.js'
import { accessAccount } from '../../marketing/meta-ads/live-access-change.js'
import { billingScope, liveBacked, liveBilling } from '../../marketing/meta-ads/live-business-assets-change.js'
import {
  BACKED, BACKED_KINDS, BACKED_NO_UNDO, BILLING_ACTIONS, backedDraft, billingDraft, madeIdOf,
  type BackedKind, type BillingAction, type BillingRecord,
} from '../../marketing/meta-ads/change-business-assets.js'
import { META_NAME_TEXT } from '../../gateway/meta-write-text.js'

type Args = Record<string, unknown>
type Done = Array<{ request: MetaChangeRequest; result: MetaChangeResult; notAsAsked?: string }>

const common = {
  category: 'advertising',
  riskTier: 'high' as const,
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  maxClaudeTrust: 'ask' as const,
}

/** A builder that turns a refusal of the live reads into words. */
const guarded = (build: MetaDraftBuilder): MetaDraftBuilder => async (account) => {
  try {
    return await build(account)
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    throw err
  }
}

// ── create-meta-backed-account ──────────────────────────────────────────────────────────────────────────────────────

const buildBacked = (args: Args): MetaDraftBuilder => guarded(async (account) => backedDraft(await liveBacked(await accessAccount(account.target), args.kind as BackedKind)))

function backedFinish(draft: MetaChangeDraft, done: Done) {
  const madeId = done.length ? madeIdOf(done[0].result) : null
  const after: Record<string, unknown> = { ...(draft.after as Record<string, unknown>), madeId }
  return { data: { kind: after.kind, objectId: after.objectId, madeId }, before: draft.before, after, noUndo: BACKED_NO_UNDO }
}

const createMetaBackedAccount: AgentTool = {
  ...common,
  name: 'create-meta-backed-account',
  requires: [F.adsCampaignsManage],
  title: 'Make a Page- or Instagram-backed account for Meta ads',
  reversibility: 'none',
  input: z.object({
    connectionId: metaConnectionArg,
    kind: z.enum(BACKED_KINDS).describe(`${BACKED_KINDS.join(' | ')}: ${BACKED_KINDS.map((k) => `${k} — ${BACKED[k].what} (${BACKED[k].on === 'page' ? 'the chosen Page' : 'the chosen Instagram account'})`).join('; ')}`),
    why: metaWhyArg,
  }),
  description:
    'Make one of Meta\'s "backed" identities for ads, for the business\'s CHOSEN Page or Instagram account only: kind '
    + 'instagram-for-page — a Page-backed Instagram account (ads run on Instagram as the Page, with no Instagram account of '
    + 'its own); threads-for-instagram — an Instagram-backed Threads account; threads-for-page — a Page-backed Threads account '
    + '(Meta: use it only with a Page-backed Instagram account). Meta makes ONE per Page or Instagram account and answers the '
    + 'existing one: Nexus reads first and refuses when one exists (its id is in the answer) or when it cannot tell. Nobody can '
    + 'log in to such an account, post or comment with it; it takes the Page\'s (or account\'s) name and picture. Nothing '
    + 'spends: it is an identity ads may use. NO undo: Meta documents no delete — it stays. Meta needs the system user to '
    + 'hold the Advertise (or Create content, or Manage) task on the chosen Page; Meta has no check for it.'
    + META_CHANGE_RULES,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildBacked(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildBacked(args), (draft, done) => backedFinish(draft, done)),
}

// ── set-meta-billing ────────────────────────────────────────────────────────────────────────────────────────────────

const buildBilling = (args: Args): MetaDraftBuilder => guarded(async (account) => {
  const scope = await billingScope(account.target)
  if ('refusal' in scope) return scope
  const live = await liveBilling(scope.chosen, scope.portfolioId)
  return billingDraft({
    action: args.action as BillingAction,
    creditLineId: args.creditLineId as string | undefined,
    invoiceGroupId: args.invoiceGroupId as string | undefined,
    name: args.name as string | undefined,
    confirmDelete: args.confirmDelete as boolean | undefined,
  }, live)
})

/** The record: a new group's id from Meta's answer (its undo deletes exactly that group). */
function billingFinish(draft: MetaChangeDraft, done: Done) {
  const after = { ...(draft.after as BillingRecord) }
  if (after.op === 'create-group' && done.length) after.groupId = createdIdOf(done[0].result.node)
  return {
    data: { action: after.op, creditLineId: after.creditLineId, invoiceGroupId: after.groupId, name: after.name, ...(after.adAccountId ? { adAccountId: `act_${after.adAccountId}`, inGroup: after.inGroup } : {}) },
    before: draft.before,
    after,
    ...(after.op === 'delete-group' ? { noUndo: 'Deleting an invoice group has no undo: a group made again is a new group with a new id.' } : {}),
  }
}

const head = (record: { accountId?: string } | undefined, why: string) => ({ ...(record?.accountId ? { connectionId: record.accountId } : {}), why })

const billingUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as BillingRecord & { accountId?: string }
    if (after.op === 'delete-group' || !after.groupId) return null
    const account = await recordAccount(after)
    if (!account) return null
    try {
      const scope = await billingScope(account.target)
      if ('refusal' in scope) return null
      const live = await liveBilling(scope.chosen, scope.portfolioId)
      const group = live.groups.find((g) => g.groupId === after.groupId) ?? null
      if (after.op === 'create-group') return { ...after, exists: !!group, name: group ? group.name : null }
      if (after.op === 'rename-group') return { ...after, name: group ? group.name : null }
      // add-account / remove-account: whether the group bills the chosen ad account now (null: not read).
      return { ...after, inGroup: group?.adAccountIds && !group.accountsMore ? group.adAccountIds.includes(after.adAccountId ?? '') : null }
    } catch (err) {
      if (err instanceof MetaLiveRefusal || err instanceof MetaReadError) return null
      throw err
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as BillingRecord
    const after = (change.after ?? {}) as BillingRecord & { accountId?: string }
    const h = head(after, 'undo of an earlier Meta invoice-group change')
    switch (after.op) {
      case 'create-group':
        return after.groupId
          ? { tool: 'set-meta-billing', args: { ...h, action: 'delete-group', invoiceGroupId: after.groupId, confirmDelete: true } }
          : { refusal: 'Meta did not answer the new invoice group\'s id, so Nexus cannot name it to delete: a person deletes it in Meta Business settings › Billing & payments.' }
      case 'rename-group':
        return before.name
          ? { tool: 'set-meta-billing', args: { ...h, action: 'rename-group', invoiceGroupId: after.groupId, name: before.name } }
          : { refusal: 'The invoice group had no name Meta read before, so there is no name to put back.' }
      case 'add-account':
        return after.previousGroupId
          ? { tool: 'set-meta-billing', args: { ...h, action: 'add-account', invoiceGroupId: after.previousGroupId } }
          : { tool: 'set-meta-billing', args: { ...h, action: 'remove-account', invoiceGroupId: after.groupId } }
      case 'remove-account':
        return { tool: 'set-meta-billing', args: { ...h, action: 'add-account', invoiceGroupId: after.groupId } }
      case 'delete-group':
        return { refusal: 'Deleting an invoice group has no undo: a group made again (action create-group) is a new group with a new id.' }
    }
    return { refusal: 'Nexus does not know this invoice-group change.' }
  },
}

const setMetaBilling: AgentTool = {
  ...common,
  name: 'set-meta-billing',
  requires: [F.adsBudgetsEdit, FIELDS.financialsAdspendView],
  title: 'Change the invoice groups of a Meta credit line',
  // A rename and a move are put back; a new group is deleted while it bills nothing; a delete has none.
  reversibility: 'partial',
  consequencesFor: (args) => (args.action === 'delete-group' ? { reversibility: 'none' } : args.action === 'create-group' ? { reversibility: 'partial' } : { reversibility: 'full' }),
  input: z.object({
    connectionId: metaConnectionArg,
    action: z.enum(BILLING_ACTIONS).describe('create-group: a new invoice group on the portfolio\'s own credit line (name) · rename-group (invoiceGroupId, name) · add-account: bill the CHOSEN ad account on this group (invoiceGroupId) · remove-account: take the chosen ad account out of it (invoiceGroupId) · delete-group: delete an EMPTY group (invoiceGroupId, confirmDelete: true; no undo)'),
    creditLineId: metaIdArg('create-group: the portfolio\'s own credit line (meta-billing view credit-lines; default: its only one)').optional(),
    invoiceGroupId: metaIdArg('rename-group, add-account, remove-account, delete-group: an invoice group of the portfolio\'s own credit line (meta-billing view invoice-groups)').optional(),
    name: z.string().trim().min(1).max(100).regex(META_NAME_TEXT, 'plain text only (no control characters)').optional().describe('create-group, rename-group: the group\'s name'),
    confirmDelete: z.literal(true).optional().describe('delete-group: must be true, asked by the person (no undo)'),
    why: metaWhyArg,
  }),
  description:
    'The invoice groups of the business portfolio\'s OWN Meta credit line (monthly invoicing: each group gets one '
    + 'consolidated invoice for the ad accounts it bills): make one, rename one, bill the business\'s CHOSEN ad account on one '
    + '(it moves there from the group that billed it) or take it out, or delete an EMPTY group on the person\'s explicit ask '
    + '(confirmDelete: true; no undo). Which invoice the account\'s spend lands on is MONEY — the preview says from which '
    + 'group to which, plainly (the same credit line pays; nothing spends more). Refused: a portfolio with no credit line of '
    + 'its own, a credit line another portfolio shares in, a portfolio another business in Nexus uses, a group that bills '
    + 'another business\'s ad account, any ad account but the chosen one, a group Nexus cannot read in full. Nexus never '
    + 'takes or reads the invoice e-mail addresses (a person sets them in Billing & payments). The create and the add are '
    + 'Meta\'s SDK only (its reference page says they cannot): Meta\'s answer decides; who may change invoice groups is not on '
    + 'Meta\'s pages — a refusal is passed on. Never in a bulk approve. Undo renames back, moves the account back, or '
    + 'deletes a group it made while the group bills nothing.'
    + META_CHANGE_RULES,
  undo: billingUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildBilling(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildBilling(args), (draft, done) => billingFinish(draft, done)),
}

export const META_ADS_BUSINESS_ASSET_CHANGE_TOOLS: AgentTool[] = [createMetaBackedAccount, setMetaBilling]
