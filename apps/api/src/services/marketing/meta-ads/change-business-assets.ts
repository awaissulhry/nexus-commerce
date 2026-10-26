/**
 * Meta ads step 43 (2026-10-26) — the two business-asset changes Nexus's OWN token may make (D1 keeps the admin-only acts in
 * the Owner's hands: business-assets-admin.ts). Pure: the drafts from the request and the live state the tools read
 * (live-business-assets-change.ts). Each is a Nexus change (meta-ads-kit.ts): preview → approvalId → a person approves →
 * it runs as that person; undo or "no undo" with the reason.
 *
 *   create-meta-backed-account  a Page-backed Instagram account for the chosen Page (BM-051), an Instagram-backed Threads
 *                               account for the chosen Instagram account (CR-228), a Page-backed Threads account for the
 *                               chosen Page (CR-230) — identities ads may use; nobody can log in to them; no delete.
 *   set-meta-billing            the invoice groups of the business portfolio's OWN Meta credit line (BM-903 … BM-907): make
 *                               one, rename one, put the chosen ad account in one or take it out, delete an empty one.
 *
 * Checked 2026-10-26 (plain curl ≥ 4 s apart; Meta's Python Business SDK main):
 *   - documentation/ads-commerce/instagram/ads-api/guides/pages-ig-account.md: POST /<PAGE_ID>/page_backed_instagram_accounts
 *     (no parameters) "returns an Instagram account ID on success. If a page already has a PBIA, the call returns the existing
 *     PBIA ID"; "you need to have at least an ADVERTISER role on this page. MANAGER or CONTENT_CREATOR also work"; read GET
 *     …/page_backed_instagram_accounts (empty when none); "You cannot login to this Instagram account to manage posts"; same
 *     name and picture as the Page, kept in step. No delete is documented.
 *   - documentation/ads-commerce/marketing-api/ad-creative/threads-ads.md: POST /<IG_USER_ID>/instagram_backed_threads_user
 *     and POST /<PAGE_ID>/page_backed_threads_accounts (no parameters), each returning the existing one if there is one; read
 *     GET /<IG_USER_ID>/instagram_backed_threads_user (threads_user_id) and GET /<PAGE_ID>?fields=page_backed_threads_account_id;
 *     the Page-backed one needs an ADVERTISER (MANAGER, CONTENT_CREATOR) role on the Page; "You should only use a Page-backed
 *     Threads account when you are using a Page-backed Instagram account for Instagram ads"; one of each per Instagram
 *     account / Page; no delete documented.
 *   - docs/marketing-api/reference/extended-credit-invoice-group/ (+ /ad_accounts) and extended-credit/
 *     extended_credit_invoice_groups/; SDK extendedcredit.py create_extended_credit_invoice_group (emails list<string>, name),
 *     extendedcreditinvoicegroup.py api_update (emails, name), api_delete, create_ad_account and delete_ad_accounts
 *     (ad_account_id string): POST /<group> name ("read-after-write"), DELETE /<group> → {success}, DELETE
 *     /<group>/ad_accounts ad_account_id [required] → {success} (49002 "Cannot delete the ad account from the invoice group").
 *     The Creating sections of the groups edge and of /<group>/ad_accounts say "can't perform": the create and the add are
 *     Meta's SDK only (RECHECK BM-903 / BM-905) — built, Meta's answer decides (LIVE-PROBES MS43-…). Who may change invoice
 *     groups is not on Meta's pages: its refusal is passed on in its words.
 *   - an invoice group's `emails` are the people its invoices go to: Nexus never takes or reads them (step 3's reads leave
 *     them out too) — a person adds or changes them in Meta Business settings › Billing & payments.
 */
import { changeLines, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import type { MetaChangeResult } from './write-client.js'

// ── create-meta-backed-account (BM-051, CR-228, CR-230) ────────────────────────────────────────────────────────────

export const BACKED_KINDS = ['instagram-for-page', 'threads-for-instagram', 'threads-for-page'] as const
export type BackedKind = typeof BACKED_KINDS[number]

/** Where each kind is made and what it is called (its edge is spelled once, in backedDraft's request). */
export const BACKED: Readonly<Record<BackedKind, { on: 'page' | 'instagram'; what: string; row: string }>> = {
  'instagram-for-page': { on: 'page', what: 'a Page-backed Instagram account', row: 'BM-051' },
  'threads-for-instagram': { on: 'instagram', what: 'an Instagram-backed Threads account', row: 'CR-228' },
  'threads-for-page': { on: 'page', what: 'a Page-backed Threads account', row: 'CR-230' },
}

/** What the reads found for a backed account (live-business-assets-change.ts liveBacked). */
export interface BackedLive {
  kind: BackedKind
  /** The chosen Page or Instagram account it is made for (null: none chosen). */
  objectId: string | null
  /** The one that exists already (Meta makes one per Page / Instagram account), or Meta's refusal of the read. */
  existing: { id: string | null } | { refused: string }
  /** threads-for-page: the Page's Page-backed Instagram account (null: none; undefined: not read). */
  pageBackedInstagram?: string | null
  /** threads-for-instagram: a real Threads account linked to the Instagram account (null: none; undefined: not read). */
  linkedThreads?: string | null
}

export const BACKED_NO_UNDO = 'Meta documents no delete of a Page-backed Instagram account or of an Instagram- or Page-backed Threads account: once made it stays (nobody can log in to it, post or comment with it; it takes the Page\'s or account\'s name and picture).'
const BACKED_EXPLAIN: Readonly<Record<string, string>> = {
  10: 'Meta needs the system user to hold the Advertise task (or Create content, or Manage) on the chosen Page — Meta Business settings › Users › System users › Assign assets.',
  200: 'Meta needs the system user to hold the Advertise task (or Create content, or Manage) on the chosen Page — Meta Business settings › Users › System users › Assign assets.',
}

export function backedDraft(live: BackedLive): MetaChangeDraft | { refusal: string } {
  const spec = BACKED[live.kind]
  const where = spec.on === 'page' ? 'Page' : 'Instagram account'
  if (!live.objectId) return { refusal: `This business has chosen no ${spec.on === 'page' ? 'Facebook Page' : 'Instagram account'} (set-meta-connection asks for one), so there is nothing to make ${spec.what} for.` }
  if ('refused' in live.existing) return { refusal: `Nexus could not read whether the chosen ${where} has ${spec.what} already (${live.existing.refused}): Meta makes one only once and answers the existing one, so Nexus asks for nothing it cannot check.` }
  if (live.existing.id) return { refusal: `The chosen ${where} ${live.objectId} has ${spec.what} already (id ${live.existing.id}): Meta makes one per ${where} and would only answer that one, so there is nothing to make. Ads use it by that id.` }
  const warnings: string[] = [BACKED_NO_UNDO, 'Meta has no check for this change (validate_only is documented on campaign changes and creates of the ad account only).']
  if (live.kind === 'instagram-for-page') warnings.push('Meta: ads use it as instagram_user_id with the chosen Page as page_id; any ad account Nexus reaches may use it, and a person with the Advertise task on the Page manages its ad comments in Ads Manager (it cannot post).')
  if (live.kind === 'threads-for-page') {
    warnings.push('Meta: "You should only use a Page-backed Threads account when you are using a Page-backed Instagram account for Instagram ads", and Threads ads of it run only while that Page-backed Instagram account can run Instagram ads.')
    if (live.pageBackedInstagram === null) warnings.push('The chosen Page has no Page-backed Instagram account yet: make that one first (kind instagram-for-page).')
  }
  if (live.kind === 'threads-for-instagram') {
    warnings.push('Meta: Threads ads of it run only while the Instagram account can run Instagram ads.')
    if (live.linkedThreads) warnings.push(`The Instagram account already has a linked Threads account (${live.linkedThreads}): Threads ads can use that one instead.`)
  }
  const label = `Make ${spec.what} for the chosen ${where} ${live.objectId}`
  const common = {
    step: 1, label, objectId: live.objectId, params: {},
    check: 'none' as const, raisesSpend: false, readBackInPost: false, budget: false, undoable: false,
    operation: `assets.backed.${live.kind}`,
    // Meta's answer is the new account's id: nothing of it is read back (it has no status to read).
    skipReadBack: true as const,
    doneSentence: (result: MetaChangeResult) => `${label}: Meta made it${madeIdOf(result) ? ` (id ${madeIdOf(result)})` : ''}.`,
    explain: BACKED_EXPLAIN,
  }
  // Each edge spelled as itself (a request builder never computes its edge: meta-labels-writes test).
  const request: MetaChangeRequest = live.kind === 'instagram-for-page' ? { ...common, objectKind: 'backedpage', edge: 'page_backed_instagram_accounts' }
    : live.kind === 'threads-for-instagram' ? { ...common, objectKind: 'backedinstagram', edge: 'instagram_backed_threads_user' }
      : { ...common, objectKind: 'backedpage', edge: 'page_backed_threads_accounts' }
  const lines = changeLines([[spec.what, 'none', 'made by Meta (its id in the answer)']])
  return {
    summary: `${label[0].toUpperCase()}${label.slice(1)} (${spec.row}). Nothing spends: it is an identity ads may use.`,
    changes: lines.changes, totals: { made: 1 }, warnings, spendsMoney: [], skipped: [],
    requests: [request],
    stands: { kind: live.kind, objectId: live.objectId, existing: null, pageBackedInstagram: live.pageBackedInstagram ?? null, linkedThreads: live.linkedThreads ?? null },
    before: { kind: live.kind, objectId: live.objectId, madeId: null },
    after: { kind: live.kind, objectId: live.objectId, madeId: null },
  }
}

/** The id Meta answered for what it made (an id, or a Threads account's threads_user_id), digits only. */
export function madeIdOf(result: Pick<MetaChangeResult, 'node'>): string | null {
  const node = result.node ?? {}
  for (const key of ['id', 'threads_user_id']) {
    const v = node[key]
    if ((typeof v === 'string' || typeof v === 'number') && /^\d{1,25}$/.test(String(v))) return String(v)
  }
  return null
}

// ── set-meta-billing (BM-903 … BM-907) ─────────────────────────────────────────────────────────────────────────────

export const BILLING_ACTIONS = ['create-group', 'rename-group', 'add-account', 'remove-account', 'delete-group'] as const
export type BillingAction = typeof BILLING_ACTIONS[number]

/** One invoice group of the portfolio's own credit line, as read now. */
export interface InvoiceGroupNow {
  groupId: string
  creditLineId: string
  name: string | null
  /** The ad accounts it bills (digits), or null when Meta did not answer the list; `accountsMore`: more than Nexus reads. */
  adAccountIds: string[] | null
  accountsMore: boolean
  /** Its ad accounts another business in Nexus picked. */
  takenAccounts: string[]
}
export interface BillingLive {
  portfolioId: string
  /** The business's chosen ad account (digits). */
  adAccountId: string
  /** The credit lines the portfolio OWNS (a line another portfolio shares in is not changed here). */
  creditLines: string[]
  foreignLines: number
  groups: InvoiceGroupNow[]
  /** A line's group list Meta did not answer, or more groups than Nexus reads: where an ad account sits cannot be told. */
  groupsUnsure: string | null
}
export interface BillingAsk { action: BillingAction; creditLineId?: string; invoiceGroupId?: string; name?: string; confirmDelete?: boolean }

/** What a billing change replaced and wrote (undo reads it). */
export interface BillingRecord {
  op: BillingAction
  creditLineId: string
  groupId: string | null
  name: string | null
  /** add-account / remove-account: the chosen ad account (digits) and whether the group bills it. */
  adAccountId?: string
  inGroup?: boolean
  /** add-account: the group of the same credit line that billed it before (null: none). */
  previousGroupId?: string | null
  /** create-group / delete-group: whether the group exists. */
  exists?: boolean
}

export const NO_CREDIT_LINE = 'The business portfolio has no Meta credit line of its own (monthly invoicing): a card- or PayPal-paid account has no invoice groups, so there is nothing to change. A credit line is a person\'s application in Meta Business settings › Billing & payments.'
export const INVOICE_EMAILS = 'Nexus never takes or reads an invoice group\'s e-mail addresses (the people its invoices go to): a person adds or changes them in Meta Business settings › Billing & payments.'
const WHO_MAY = 'Meta\'s pages do not say who may change invoice groups (a finance role on the portfolio is likely): if Meta refuses it, its words are passed on.'
const NO_CHECK = 'Meta has no check for this change (validate_only is documented on campaign changes and creates of the ad account only).'

const act = (id: string) => `act_${id}`
const groupLabel = (g: InvoiceGroupNow) => `invoice group ${g.name ? `"${g.name}" ` : ''}(${g.groupId})`
const listed = (node: Record<string, unknown>, adAccountId: string): boolean | null => {
  const rows = Array.isArray(node.data) ? node.data : null
  if (!rows) return null
  return rows.some((r) => r && typeof r === 'object' && String((r as Record<string, unknown>).account_id ?? (r as Record<string, unknown>).id ?? '').replace(/^act_/, '') === adAccountId)
}

function groupOf(ask: BillingAsk, live: BillingLive): InvoiceGroupNow | { refusal: string } {
  if (!ask.invoiceGroupId) return { refusal: 'Name the invoice group (invoiceGroupId: meta-billing view invoice-groups lists them).' }
  const group = live.groups.find((g) => g.groupId === ask.invoiceGroupId)
  if (group) return group
  return { refusal: live.groupsUnsure
    ? `Invoice group ${ask.invoiceGroupId} is not among what Nexus reads of the portfolio's own credit line (${live.groupsUnsure}), so it changes nothing.`
    : `Invoice group ${ask.invoiceGroupId} is not an invoice group of the business portfolio's own credit line (meta-billing view invoice-groups lists them).` }
}

/** A group whose ad accounts Nexus cannot read in full, or that bills another business's ad account, is not changed here. */
function groupFloor(group: InvoiceGroupNow): { refusal: string } | null {
  if (group.adAccountIds === null || group.accountsMore) return { refusal: `Nexus could not read every ad account ${groupLabel(group)} bills, so it changes nothing of it (an invoice group may bill another business's ad accounts).` }
  if (group.takenAccounts.length) return { refusal: `${groupLabel(group)} bills an ad account another business in Nexus uses (${group.takenAccounts.map(act).join(', ')}), so Nexus changes nothing of it: it is that business's billing too.` }
  return null
}

const request = (r: Omit<MetaChangeRequest, 'check' | 'raisesSpend' | 'readBackInPost' | 'budget'>): MetaChangeRequest => ({ check: 'none', raisesSpend: false, readBackInPost: false, budget: false, ...r })

export function billingDraft(ask: BillingAsk, live: BillingLive): MetaChangeDraft | { refusal: string } {
  if (!live.creditLines.length) return { refusal: live.foreignLines ? `${NO_CREDIT_LINE} (A credit line another business portfolio shares into this one is that portfolio's: its invoice groups are not changed here.)` : NO_CREDIT_LINE }
  const extra = (allowed: string[]) => {
    const named = Object.entries({ creditLineId: ask.creditLineId, invoiceGroupId: ask.invoiceGroupId, name: ask.name, confirmDelete: ask.confirmDelete }).filter(([, v]) => v !== undefined).map(([k]) => k)
    const stray = named.filter((k) => !allowed.includes(k))
    return stray.length ? { refusal: `${stray.join(', ')} ${stray.length === 1 ? 'is' : 'are'} not an argument of action ${ask.action} (it takes ${allowed.join(', ') || 'nothing more'}).` } : null
  }
  const common = [NO_CHECK, WHO_MAY]
  switch (ask.action) {
    case 'create-group': {
      const stray = extra(['creditLineId', 'name'])
      if (stray) return stray
      if (!ask.name) return { refusal: 'Name the new invoice group (name).' }
      const line = ask.creditLineId ?? (live.creditLines.length === 1 ? live.creditLines[0] : null)
      if (!line) return { refusal: `The business portfolio has ${live.creditLines.length} credit lines of its own: name the one (creditLineId: meta-billing view credit-lines lists them).` }
      if (!live.creditLines.includes(line)) return { refusal: `Credit line ${line} is not one the business portfolio owns (meta-billing view credit-lines lists them).` }
      if (live.groupsUnsure) return { refusal: `Nexus could not read the credit line's invoice groups in full (${live.groupsUnsure}), so it makes none: it could not tell a group with that name is not there.` }
      const same = live.groups.find((g) => g.creditLineId === line && g.name === ask.name)
      if (same) return { refusal: `The credit line has an invoice group named "${ask.name}" already (${same.groupId}): give the new one another name, or rename that one.` }
      const lines = changeLines([['invoice group', 'none', `"${ask.name}" on credit line ${line}`]])
      return {
        summary: `Make invoice group "${ask.name}" on the business portfolio's credit line ${line} (BM-903). It moves no ad account and spends nothing.`,
        changes: lines.changes, totals: { groups: 1 }, spendsMoney: [], skipped: [],
        warnings: [
          'Meta\'s SDK makes invoice groups (its reference page says it cannot): Meta\'s answer decides.',
          INVOICE_EMAILS + ' Meta may refuse a group without them: its words are passed on.',
          'A new group bills nothing until an ad account is put in it (action add-account).',
          ...common,
          'Its undo deletes the group it made, only while it bills no ad account.',
        ],
        requests: [request({
          step: 1, label: `Make invoice group "${ask.name}" on credit line ${line}`, objectId: line, objectKind: 'creditline', edge: 'extended_credit_invoice_groups',
          params: { name: ask.name }, operation: 'billing.invoiceGroup.create', expect: { name: ask.name }, readBackFields: 'id,name', recordEvenIfNotAsAsked: true, undoable: true,
        })],
        stands: { creditLineId: line, names: live.groups.filter((g) => g.creditLineId === line).map((g) => g.name).sort() },
        before: { op: 'create-group', creditLineId: line, groupId: null, name: ask.name, exists: false } satisfies BillingRecord,
        after: { op: 'create-group', creditLineId: line, groupId: null, name: ask.name, exists: true } satisfies BillingRecord,
      }
    }
    case 'rename-group': {
      const stray = extra(['invoiceGroupId', 'name'])
      if (stray) return stray
      if (!ask.name) return { refusal: 'Name the invoice group\'s new name (name).' }
      const group = groupOf(ask, live)
      if ('refusal' in group) return group
      const floor = groupFloor(group)
      if (floor) return floor
      if (group.name === ask.name) return { refusal: `${groupLabel(group)} is named "${ask.name}" already: there is nothing to change.` }
      const lines = changeLines([['name', group.name, ask.name]])
      return {
        summary: `Rename ${groupLabel(group)} to "${ask.name}" (BM-904). Its ad accounts, addresses and e-mails stay as they are.`,
        changes: lines.changes, totals: { groups: 1 }, spendsMoney: [], skipped: [],
        warnings: [INVOICE_EMAILS, ...common, `Its undo renames it back to ${group.name === null ? 'no name' : `"${group.name}"`}, exactly as Meta keeps it now.`],
        requests: [request({
          step: 1, label: `Rename ${groupLabel(group)} to "${ask.name}"`, objectId: group.groupId, objectKind: 'invoicegroup',
          params: { name: ask.name }, operation: 'billing.invoiceGroup.rename', expect: { name: ask.name }, readBackFields: 'id,name', undoable: true,
        })],
        stands: { groupId: group.groupId, name: group.name, adAccountIds: [...group.adAccountIds!].sort() },
        before: { op: 'rename-group', creditLineId: group.creditLineId, groupId: group.groupId, name: group.name } satisfies BillingRecord,
        after: { op: 'rename-group', creditLineId: group.creditLineId, groupId: group.groupId, name: ask.name } satisfies BillingRecord,
      }
    }
    case 'add-account':
    case 'remove-account': {
      const add = ask.action === 'add-account'
      const stray = extra(['invoiceGroupId'])
      if (stray) return stray
      const group = groupOf(ask, live)
      if ('refusal' in group) return group
      const floor = groupFloor(group)
      if (floor) return floor
      const account = live.adAccountId
      const inIt = group.adAccountIds!.includes(account)
      if (add && inIt) return { refusal: `${groupLabel(group)} bills the chosen ad account ${act(account)} already: there is nothing to change.` }
      if (!add && !inIt) return { refusal: `${groupLabel(group)} does not bill the chosen ad account ${act(account)}: there is nothing to take out.` }
      // Where it is billed now, for the preview and the undo: every group of the portfolio's own lines read in full.
      if (add && (live.groupsUnsure || live.groups.some((g) => g.adAccountIds === null || g.accountsMore))) {
        return { refusal: `Nexus could not read every invoice group of the credit line in full (${live.groupsUnsure ?? 'a group\'s ad accounts were not answered'}), so it cannot tell where ${act(account)} is billed now — and its undo could not put it back: it changes nothing.` }
      }
      const previous = add ? live.groups.find((g) => g.groupId !== group.groupId && g.adAccountIds!.includes(account)) ?? null : null
      const lines = changeLines([['invoice group of ' + act(account), add ? (previous ? groupLabel(previous) : 'none of this credit line') : groupLabel(group), add ? groupLabel(group) : 'none (taken out)']])
      const money = add
        ? `BILLING (money, your decision): from now on the spend of ad account ${act(account)} is billed on the monthly invoice of ${groupLabel(group)} — its bill-to address and invoice e-mails — instead of ${previous ? groupLabel(previous) : 'no invoice group of this credit line'}. The same credit line pays; nothing spends more.`
        : `BILLING (money, your decision): ad account ${act(account)}'s spend is no longer billed on ${groupLabel(group)}'s invoice. Meta's pages do not say which invoice of the credit line takes it then (it may be the line's default group); the credit line still pays.`
      return {
        summary: add ? `Bill the chosen ad account ${act(account)} on ${groupLabel(group)} (BM-905).` : `Take the chosen ad account ${act(account)} out of ${groupLabel(group)} (BM-906).`,
        changes: lines.changes, totals: { adAccounts: 1 }, spendsMoney: [], skipped: [],
        warnings: [
          money,
          ...(add ? ['Meta\'s SDK puts an ad account in an invoice group (its reference page says it cannot): Meta\'s answer decides; Meta\'s pages do not say whether it leaves its earlier group by itself — Nexus reads the group right after.'] : ['Meta answers 49002 ("Cannot delete the ad account from the invoice group") when it keeps it there: then nothing changed.']),
          ...common,
          add ? (previous ? `Its undo puts ${act(account)} back in ${groupLabel(previous)}.` : `Its undo takes ${act(account)} out of ${groupLabel(group)} again.`) : `Its undo puts ${act(account)} back in ${groupLabel(group)}.`,
        ],
        requests: [request({
          step: 1, label: add ? `Put ad account ${act(account)} in ${groupLabel(group)}` : `Take ad account ${act(account)} out of ${groupLabel(group)}`,
          objectId: group.groupId, objectKind: 'invoicegroup', edge: 'ad_accounts', ...(add ? {} : { method: 'DELETE' as const }),
          params: { ad_account_id: act(account) }, operation: add ? 'billing.invoiceGroup.addAccount' : 'billing.invoiceGroup.removeAccount', undoable: true,
          // Read back: the group's ad accounts (its first page; Meta lists 25 a page) — listed after an add, gone after a removal.
          readBackOf: `${group.groupId}/ad_accounts`, readBackFields: 'account_id',
          judge: (node) => {
            const now = listed(node, account)
            if (now === null) return { moved: ['ad_accounts'], reads: 'a list Nexus could not read' }
            return { moved: now === add ? [] : ['ad_accounts'], reads: now ? `${act(account)} in ${groupLabel(group)}` : `${act(account)} not in ${groupLabel(group)}` }
          },
          explain: { 49002: 'Meta keeps the ad account in this invoice group (49002): nothing changed.' },
        })],
        stands: { groups: live.groups.map((g) => ({ groupId: g.groupId, adAccountIds: g.adAccountIds ? [...g.adAccountIds].sort() : null })) },
        before: { op: ask.action, creditLineId: group.creditLineId, groupId: group.groupId, name: group.name, adAccountId: account, inGroup: !add, ...(add ? { previousGroupId: previous?.groupId ?? null } : {}) } satisfies BillingRecord,
        after: { op: ask.action, creditLineId: group.creditLineId, groupId: group.groupId, name: group.name, adAccountId: account, inGroup: add, ...(add ? { previousGroupId: previous?.groupId ?? null } : {}) } satisfies BillingRecord,
      }
    }
    case 'delete-group': {
      const stray = extra(['invoiceGroupId', 'confirmDelete'])
      if (stray) return stray
      if (ask.confirmDelete !== true) return { refusal: 'Deleting an invoice group takes confirmDelete: true, asked by the person (it has no undo: a new group gets a new id).' }
      const group = groupOf(ask, live)
      if ('refusal' in group) return group
      const floor = groupFloor(group)
      if (floor) return floor
      if (group.adAccountIds!.length) return { refusal: `${groupLabel(group)} still bills ${group.adAccountIds!.length} ad account${group.adAccountIds!.length === 1 ? '' : 's'} (${group.adAccountIds!.map(act).join(', ')}): Nexus deletes only an empty invoice group. Take them out first (action remove-account for the chosen one; any other in Meta Business settings › Billing & payments).` }
      const lines = changeLines([['invoice group', groupLabel(group), 'deleted']])
      return {
        summary: `Delete the empty ${groupLabel(group)} of credit line ${group.creditLineId} (BM-907). No undo.`,
        changes: lines.changes, totals: { groups: 1 }, spendsMoney: [], skipped: [],
        warnings: ['No undo: a group made again is a new group with a new id (action create-group).', ...common],
        requests: [request({
          step: 1, label: `Delete ${groupLabel(group)}`, objectId: group.groupId, objectKind: 'invoicegroup', method: 'DELETE',
          params: {}, operation: 'billing.invoiceGroup.delete', undoable: false,
        })],
        stands: { groupId: group.groupId, name: group.name, adAccountIds: [] },
        before: { op: 'delete-group', creditLineId: group.creditLineId, groupId: group.groupId, name: group.name, exists: true } satisfies BillingRecord,
        after: { op: 'delete-group', creditLineId: group.creditLineId, groupId: group.groupId, name: group.name, exists: false } satisfies BillingRecord,
      }
    }
  }
  return { refusal: `Unknown action "${String(ask.action)}".` }
}
