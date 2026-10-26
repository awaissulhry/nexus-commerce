/**
 * Meta ads changes, step 43 (2026-10-26) — the one business-asset change Nexus's OWN token may make (the admin-only acts of
 * this step, invoice groups included, are the Owner's steps in Meta's screens: meta-ads-business-assets.tools.ts, D1):
 *   create-meta-backed-account  a Page-backed Instagram account for the chosen Page (BM-051), an Instagram-backed Threads
 *                               account for the chosen Instagram account (CR-228) or a Page-backed Threads account for the
 *                               chosen Page (CR-230): Meta's "shadow" identities ads may use (a Page role ADVERTISER,
 *                               MANAGER or CONTENT_CREATOR is enough; Standard access). No delete: no undo.
 * A Nexus change like set-meta-status (meta-ads-kit.ts): a preview from the live state, an approvalId, a person approves it,
 * it runs as that person. The floors are refused before Meta is called (change-business-assets.ts) and again by the gateway
 * (gateway/meta-business-asset-owner.ts): only the chosen Page / Instagram account. Meta's own MCP has no tool for it.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaWhyArg, META_CHANGE_RULES, runMetaChange, type MetaDraftBuilder } from './meta-ads-kit.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import type { MetaChangeDraft, MetaChangeRequest } from '../../marketing/meta-ads/change-draft.js'
import type { MetaChangeResult } from '../../marketing/meta-ads/write-client.js'
import { accessAccount } from '../../marketing/meta-ads/live-access-change.js'
import { liveBacked } from '../../marketing/meta-ads/live-business-assets-change.js'
import { BACKED, BACKED_KINDS, BACKED_NO_UNDO, backedDraft, madeIdOf, type BackedKind } from '../../marketing/meta-ads/change-business-assets.js'

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
  title: 'Make a Page- or IG-backed Meta account',
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
    + 'log in to such an account, post or comment with it; it takes the Page\'s (or account\'s) name and picture. A Page-backed '
    + 'Threads account is refused while the Page has no Page-backed Instagram account, or Nexus cannot tell (Meta: no Threads '
    + 'ads without it), and its ads need the pages_read_engagement permission on the app. Nothing '
    + 'spends: it is an identity ads may use. NO undo: Meta documents no delete — it stays. Meta needs the system user to '
    + 'hold the Advertise (or Create content, or Manage) task on the chosen Page; Meta has no check for it.'
    + META_CHANGE_RULES,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildBacked(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildBacked(args), (draft, done) => backedFinish(draft, done)),
}

export const META_ADS_BUSINESS_ASSET_CHANGE_TOOLS: AgentTool[] = [createMetaBackedAccount]
