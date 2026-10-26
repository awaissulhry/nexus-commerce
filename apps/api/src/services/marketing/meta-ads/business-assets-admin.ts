/**
 * Meta ads step 43 (2026-10-26) — the business portfolio's ASSET acts, by the Owner's decision D1 = A (2026-10-20, "yes 46
 * lanes"): bringing an ad account, a Page, an app or an asset group into the portfolio, letting an ad account advertise for
 * the Instagram account (set-meta-business-assets — AA-063, AA-064, AA-066, BM-044, BM-045, BM-055, BM-056), taking an ad
 * account, a Page or an Instagram account out of it (remove-meta-business-asset — AA-065, BM-047, BM-049), a new ad account
 * (create-meta-ad-account — AA-062) and an appeal of a restricted ad account or portfolio (create-meta-appeal — LG-015,
 * LG-016). Only an ADMIN of the portfolio may do any of them, so they stay in the Owner's hands: Nexus sends NO write to
 * Meta, and each answer is step 42's guide (business-admin.ts `guide`) built from what Meta reads now — what is asked, from →
 * to; the exact steps in Meta's screens; how to put it back (or plainly that Meta cannot); what to watch out for — and asked
 * again, the same read says what is done. Pure: the reads are live-business-assets-admin.ts (steps 2, 3 and 4's reads).
 *
 * Checked 2026-10-26 (plain curl ≥ 4 s apart, English with ?locale=en_US): the Business Asset Management guides
 * (developers.facebook.com/docs/business-management-apis/business-asset-management/{overview,guides/ad-accounts,guides/pages,
 * guides/instagram-accounts}); docs/marketing-api/reference/business/{ad_accounts,pages,owned_pages,client_pages,
 * client_ad_accounts,business_asset_groups}.md; the Instagram ads guides ig-accounts-with-business-manager and
 * pages-ig-account; Meta's Python Business SDK main (adobjects/business.py: create_owned_ad_account, create_ad_account,
 * create_owned_page, create_client_page, delete_ad_accounts, delete_pages, delete_instagram_accounts, create_owned_app,
 * create_client_app, create_ad_review_request, create_bm_review_request — no create_client_ad_account, no delete of
 * client_apps, no create of a business asset group); Meta's Business Help Center (www.facebook.com/business/help/<id>) for
 * the ids in META_ASSET_HELP:
 *   - who: "For all add and remove endpoints: Access token's user needs to be an admin of the business"; an Employee "can't
 *     make any changes, except to add Pages or ad accounts which this user is an admin of to the business". Claim an ad
 *     account: "The requester needs to be an admin of the Business claiming the ad account"; a new ad account: "You must be
 *     an admin for a business to create new ad accounts"; a Page as owner: "the access token of an Admin user or Admin system
 *     user of your business"; an ad account for an Instagram account: "You must be at least an ADMIN of the business".
 *   - ad accounts: a claim by an admin of the ad account is CONFIRMED at once, else PENDING until an admin of the ad account
 *     "accept[s] the request in Ads Manager"; "You cannot remove ad accounts from your business if you're OWNER and if the
 *     accounts are CONFIRMED" (only a PENDING request or AGENCY access is removed); client_ad_accounts: "temporarily
 *     limiting access … only apps that have successfully called this endpoint within the last 30 days" (and no SDK call).
 *     Help 915885887059947: create / claim / request steps; a new or claimed ad account "can't be deleted or transferred";
 *     "New business portfolios can only create one ad account. This goes up to 3 when a campaign delivers and a payment is
 *     made"; a prepaid ad account to be claimed "cannot have any prepaid balance". Help 190760004667059: deactivate.
 *   - Pages: a claim is immediate for a Page admin or MANAGER of more than 7 days, else not approved automatically; an owner
 *     claim without the rights fails (no request is sent); an agency request: "If a business has too many Page access requests
 *     reported as spam, we lock the Business Manager". Help 720478807965744 (add), 183277585892925 (request access; a primary
 *     Page first), 531142997352616 (remove: disconnect it from Instagram / WhatsApp first; DELETE /pages 42001).
 *   - Instagram: adding one is Meta's screens only (the account's username and password, help 620548115562686); its removal
 *     is DELETE /{business}/instagram_accounts (instagram_account) or the screens; an ad account may advertise for it only
 *     when the portfolio owns the ad account, or reaches it while the Instagram account's owner owns it.
 *   - apps: help 2199735813629697 (Connect an app ID / Request access to an app ID); asset groups: help 415764982598745 ("you'll
 *     need to create business asset groups using your business portfolio") and the BAM overview ("business asset groups that
 *     someone already created via Business Manager").
 *   - appeals: Help 530209463124901 — Business Support Home › Account status overview › the restricted account › What you can
 *     do › Request review; "To request a review, you must be an admin on the account"; "Typically, our review is completed in
 *     48 hours"; "a limited number of times"; "Once the review is completed, the decision is final"; "Any ads running before
 *     the restriction will not be automatically restarted". The API (POST /{parent_business}/ad_review_requests,
 *     bm_review_requests) is written for a parent portfolio's child accounts, with an admin token.
 * Where Meta's help names no place, the step says "if Meta offers …" (LIVE-PROBES MS43-…).
 */
import {
  AGAIN, againWithSince, guide, META_ADMIN_HELP, META_SETTINGS, openSettings, SCREEN_WORDS, sinceOf,
  type AdminGuide, type AdminItem,
} from './business-admin.js'

// ── the lists the tools take ──────────────────────────────────────────────────────────────────────────────────────

export const ASSET_ACTIONS = ['claim-ad-account', 'request-ad-account', 'link-instagram', 'claim-page', 'request-page', 'claim-app', 'request-app', 'asset-group'] as const
export type AssetAction = typeof ASSET_ACTIONS[number]
export const REMOVE_ASSETS = ['ad-account', 'page', 'instagram'] as const
export type RemoveAsset = typeof REMOVE_ASSETS[number]
export const ACCESS_LEVELS = ['partial', 'full'] as const
export type AccessLevel = typeof ACCESS_LEVELS[number]
export const APPEAL_SUBJECTS = ['ad-account', 'portfolio'] as const
export type AppealSubject = typeof APPEAL_SUBJECTS[number]

/** Meta's Business Help Center articles the steps follow (public pages of Meta; English with ?locale=en_US). */
export const META_ASSET_HELP = {
  adAccounts: 'https://www.facebook.com/business/help/915885887059947',
  adAccountLimits: 'https://www.facebook.com/business/help/1026272311098874',
  adAccountTroubleshoot: 'https://www.facebook.com/business/help/443041549525801',
  deactivateAdAccount: 'https://www.facebook.com/business/help/190760004667059',
  addPage: 'https://www.facebook.com/business/help/720478807965744',
  requestPage: 'https://www.facebook.com/business/help/183277585892925',
  removePage: 'https://www.facebook.com/business/help/531142997352616',
  instagram: 'https://www.facebook.com/business/help/620548115562686',
  portfolioSettings: 'https://www.facebook.com/business/help/194409588912570',
  apps: META_ADMIN_HELP.addApp,
  assetGroup: 'https://www.facebook.com/business/help/415764982598745',
  aboutAssetGroups: 'https://www.facebook.com/business/help/1604287853035214',
  requestReview: 'https://www.facebook.com/business/help/530209463124901',
  restrictedAccount: 'https://www.facebook.com/business/help/422289316306981',
} as const

/** The sentence every asset answer carries: D1, in plain words, with Meta's own rule. */
export const D1_ASSET_LINE = 'Nexus changes nothing here and sends nothing to Meta: in Meta this is an admin\'s act on the business portfolio (Meta: "For all add and remove endpoints: Access token\'s user needs to be an admin of the business"), and the Owner\'s decision (D1) keeps it in the hands of a person with full access to the portfolio, who makes it in Meta\'s own screens. Nexus read Meta just now, shows the exact steps and how to put it back, and reads it again when asked, to say what is done.'
/** An appeal's rule line: it is made by an admin of the restricted account (Meta's help). */
export const D1_APPEAL_LINE = 'Nexus changes nothing here and sends nothing to Meta: an appeal is made by an admin of the restricted account in Meta\'s own screens (Meta: "To request a review, you must be an admin on the account"), and the Owner\'s decision (D1) keeps it in his hands — Meta\'s appeal API is written for a parent portfolio\'s child accounts with an admin token, which Nexus does not hold. Nexus read Meta just now, shows the exact steps, and reads the account again when asked.'

const ACCOUNTS_PLACE = `${META_SETTINGS} › Accounts`
const act = (id: string) => `act_${id}`

// ── what the reads hand over ───────────────────────────────────────────────────────────────────────────────────────

/**
 * One asset as one of the portfolio's lists holds it. `seen` is step 4's rule (seenAs): named — Nexus may name it (the asset
 * chosen here, one the unshared portfolio owns, or one whose owner portfolio Meta names and no other business in Nexus uses);
 * taken — another business in Nexus picked it or uses its owner portfolio; unknown — Nexus cannot tell whose it is.
 */
export interface ListedAsset { id: string; list: string; name: string | null; seen: 'named' | 'taken' | 'unknown'; requestId?: string | null; chosenHere?: boolean }
/** A kind's lists as read: every row, whether a list was cut (more rows than Nexus reads) and Meta's words for a list not read. */
export interface AssetLists { rows: ListedAsset[]; cut: boolean; unread: string[] }

const findIn = (lists: AssetLists, id: string, ...names: string[]) => lists.rows.find((r) => r.id === id && (!names.length || names.includes(r.list))) ?? null
/** Why Nexus cannot be sure an asset is in none of the lists: a list was cut or not read. */
const notSure = (lists: AssetLists): string | null => [
  lists.cut ? 'the portfolio has more of them than Nexus reads (500 a list)' : null,
  ...lists.unread.map((u) => `Meta did not answer one list (${u})`),
].filter(Boolean).join('; ') || null

const TAKEN = (what: string, id: string) => `Another business in Nexus uses ${what} ${id} (or the business portfolio that owns it), so Nexus gives no steps for it here: it would change that business's asset too.`
const UNKNOWN_OWNER = (what: string, id: string) => `Meta does not name whose ${what} ${id} is (it could be another business's in Nexus), so Nexus gives no steps for it: a person with full access to the portfolio decides it in ${META_SETTINGS}.`

// ── set-meta-business-assets (AA-063, AA-064, AA-066, BM-044, BM-045, BM-055, BM-056) ───────────────────────────────

export interface AssetAsk {
  action: AssetAction
  adAccountId?: string
  pageId?: string
  appId?: string
  name?: string
  access?: AccessLevel
}
export interface AssetLive {
  portfolioId: string
  portfolioName: string | null
  /** The business's chosen ad account, Page and Instagram account, and the Meta app Nexus uses (connection). */
  chosen: { adAccountId: string; pageId: string | null; instagramId: string | null; instagramName: string | null; appId: string | null }
  /** The lists of the asked kind (ad accounts, Pages, apps, asset groups); null for link-instagram. */
  lists: AssetLists | null
  /** The asked ad account or Page is another business's in Nexus (nexus_meta_links_taken). */
  taken: boolean
  /** link-instagram: the ad accounts of this portfolio allowed to advertise for the chosen Instagram account (null: not read). */
  authorized?: { adAccountIds: string[]; more: boolean } | { refused: string } | null
  readAt: string
}

const base = (live: { portfolioId: string; readAt: string }) => ({ portfolioId: live.portfolioId, readAt: live.readAt, rule: D1_ASSET_LINE })

export function assetGuide(ask: AssetAsk, live: AssetLive): AdminGuide | { refusal: string } {
  const portfolio = { portfolioId: live.portfolioId, name: live.portfolioName }
  switch (ask.action) {
    case 'claim-ad-account':
    case 'request-ad-account': return adAccountGuide(ask, live, portfolio)
    case 'link-instagram': return linkInstagramGuide(ask, live, portfolio)
    case 'claim-page':
    case 'request-page': return pageGuide(ask, live, portfolio)
    case 'claim-app':
    case 'request-app': return appGuide(ask, live, portfolio)
    case 'asset-group': return assetGroupGuide(ask, live, portfolio)
  }
  return { refusal: `Unknown action "${String(ask.action)}".` }
}

type Portfolio = { portfolioId: string; name: string | null }

const NEXUS_USES_CHOSEN = 'Nexus works only in the business\'s chosen ad account, Page and Instagram account: a new one in the portfolio changes nothing Nexus does until a person chooses it (set-meta-connection asks for it), and Nexus\'s system user reaches it only once it is assigned to it (Settings › Users › System users › Assign assets).'

function adAccountGuide(ask: AssetAsk, live: AssetLive, portfolio: Portfolio): AdminGuide | { refusal: string } {
  const claim = ask.action === 'claim-ad-account'
  const id = ask.adAccountId
  if (!id) return { refusal: `Name the ad account (adAccountId, its digits: ${claim ? 'the one to claim into this portfolio' : 'the other portfolio\'s ad account to ask access to'}).` }
  if (ask.pageId || ask.appId || ask.name) return { refusal: `action ${ask.action} takes adAccountId${claim ? '' : ' and access'} only.` }
  if (claim && ask.access) return { refusal: 'access is for request-ad-account (a claim moves the ad account into this portfolio).' }
  if (live.taken) return { refusal: TAKEN('ad account', act(id)) }
  const lists = live.lists ?? { rows: [], cut: false, unread: [] }
  const row = findIn(lists, id)
  if (row?.seen === 'taken') return { refusal: TAKEN('ad account', act(id)) }
  const asked = claim ? { adAccountId: act(id), owner: 'this portfolio' } : { adAccountId: act(id), sharedWithThisPortfolio: true, access: ask.access ?? 'partial' }
  const unsure = notSure(lists)
  let item: AdminItem
  const steps: string[] = [openSettings(portfolio)]
  if (row?.list === 'owned') {
    if (!claim) return { refusal: `Ad account ${act(id)} is this portfolio's own: there is no access to ask for.` }
    item = { what: 'adAccount', now: { adAccountId: act(id), list: 'owned', name: row.name }, asked, done: true, sentence: 'Meta lists it among this portfolio\'s own ad accounts.' }
  } else if (row?.list === 'client') {
    if (claim) return { refusal: `Ad account ${act(id)} is in another business portfolio (this one has partner access to it), and Meta keeps an ad account in one portfolio only (Meta's help: "An ad account can only be in one business portfolio. You can request access to that ad account instead."): its owner keeps it.` }
    item = { what: 'adAccount', now: { adAccountId: act(id), list: 'client', name: row.seen === 'named' ? row.name : null }, asked, done: true, sentence: 'Meta lists it among the ad accounts this portfolio has partner access to.' }
  } else if (row && row.list.startsWith('pending')) {
    const claimWaits = row.list === 'pending-owned'
    if (claim !== claimWaits) return { refusal: `Meta lists a ${claimWaits ? 'claim' : 'request for partner access'} of ad account ${act(id)} waiting already (request ${row.requestId ?? 'id not given'}): wait for it, or take it back first (remove-meta-business-asset asset ad-account).` }
    item = { what: 'adAccount', now: { adAccountId: act(id), list: row.list, requestId: row.requestId ?? null }, asked, done: false, sentence: claimWaits ? 'Meta lists the claim as waiting: an admin of the ad account accepts it in Ads Manager (Meta: "To accept an ownership request, you must be an ad account admin, and you should log in and accept the request in Ads Manager").' : 'Meta lists the request as waiting: the ad account\'s owner, or a person with full control of the portfolio it is in, approves it.' }
    steps.length = 0
    steps.push(claimWaits ? `An admin of ad account ${act(id)} signs in to Meta Ads Manager and accepts the ownership request there.` : `The owner of ad account ${act(id)} (or a person with full control of its business portfolio) approves the request; Meta then lists it among this portfolio's ad accounts.`)
  } else {
    item = { what: 'adAccount', now: null, asked, done: unsure ? null : false, sentence: unsure ? `Nexus does not find it in this portfolio's ad account lists, but ${unsure}: it cannot tell for sure.` : 'Not in this portfolio\'s ad account lists yet.' }
  }
  if (claim && !row) {
    steps.push(
      'Accounts › Ad accounts › Add an ad account (Meta\'s help: claim an existing ad account).',
      `Enter the ad account ID ${id}, confirm that you want to claim it into the portfolio shown, tick that you agree to Meta's Terms of Service and Advertising Standards for the portfolio, and click Claim ad account. If another person owns the ad account, they approve the request first (Meta's help).`,
    )
  }
  if (!claim && !row) {
    steps.push(
      'Accounts › Ad accounts › + Add › Request access to an ad account in another business portfolio.',
      `Enter the ad account ID ${id}; choose ${ask.access === 'full' ? 'full control' : 'partial access and the tasks this portfolio needs'}; Confirm. The ad account's owner, or a person with full control of the portfolio it is in, approves it; or they share it themselves (their Ad accounts › Assign partner with this portfolio's id, ${live.portfolioId}).`,
    )
  }
  const warnings = claim
    ? [
        'A claim moves the ad account into this portfolio for good: Meta\'s help says a claimed ad account "can\'t be deleted or transferred to another portfolio", and its people are then given access only through this portfolio.',
        'A prepaid ad account can be claimed only with no prepaid balance left (Meta\'s help); the portfolio\'s ad account limit counts it (it grows with spend: Meta\'s help).',
        NEXUS_USES_CHOSEN,
      ]
    : [
        'Meta\'s API for this request (POST /{business}/client_ad_accounts) is limited to apps that called it within the last 30 days, and Meta\'s SDK has no such call: Nexus could not send it even with an admin\'s token.',
        'With access, people of this portfolio may run ads on that ad account — its spend is paid by the ad account\'s own payment method, its owner\'s money.',
        NEXUS_USES_CHOSEN,
      ]
  return guide({
    ...base(live),
    action: ask.action,
    items: [item],
    ownerSteps: [...steps, AGAIN],
    putBack: claim
      ? { possible: 'partly', sentence: 'A claim still waiting can be taken back (remove-meta-business-asset asset ad-account gives the steps); once Meta confirms it, the ad account stays in this portfolio for good (Meta: an owner\'s CONFIRMED ad account cannot be removed).', steps: [] }
      : { possible: 'yes', sentence: 'Partner access to another portfolio\'s ad account is taken off the same way it came (remove-meta-business-asset asset ad-account gives the steps); asking again needs the owner\'s approval again.', steps: [] },
    warnings: [...warnings, SCREEN_WORDS],
    help: [META_ASSET_HELP.adAccounts, META_ASSET_HELP.adAccountLimits],
  })
}

function linkInstagramGuide(ask: AssetAsk, live: AssetLive, portfolio: Portfolio): AdminGuide | { refusal: string } {
  if (ask.adAccountId || ask.pageId || ask.appId || ask.name || ask.access) return { refusal: 'action link-instagram takes no ids: it is always the business\'s chosen ad account and its chosen Instagram account.' }
  const ig = live.chosen.instagramId
  if (!ig) return { refusal: 'This business has chosen no Instagram account (set-meta-connection asks for one), so there is nothing to link the ad account to.' }
  const account = act(live.chosen.adAccountId)
  const read = live.authorized ?? null
  let item: AdminItem
  if (!read || 'refused' in read) {
    item = { what: 'instagramAdAccount', now: null, asked: { instagramId: ig, adAccountId: account, mayAdvertise: true }, done: null, sentence: `Nexus could not read which of this portfolio's ad accounts may advertise for the Instagram account${read && 'refused' in read ? ` (${read.refused})` : ''}: it cannot tell.` }
  } else {
    const done = read.adAccountIds.includes(live.chosen.adAccountId)
    item = { what: 'instagramAdAccount', now: { instagramId: ig, authorizedAdAccounts: read.adAccountIds.length, chosenAdAccountListed: done }, asked: { instagramId: ig, adAccountId: account, mayAdvertise: true }, done: done ? true : read.more ? null : false, ...(done || !read.more ? {} : { sentence: 'Meta lists more ad accounts than Nexus reads: it cannot tell.' }) }
  }
  return guide({
    ...base(live),
    action: 'link-instagram',
    items: [item],
    ownerSteps: [
      openSettings(portfolio),
      `Accounts › Instagram accounts: click the business's Instagram account ${live.chosen.instagramName ? `"${live.chosen.instagramName}" ` : ''}(id ${ig}).`,
      `If Meta offers its connected assets there (Meta's developer guide: "select your Instagram account, click on Add Assets, and select the ad accounts"), add the ad account ${account} and save. Nexus found no such step in Meta's help.`,
      AGAIN,
    ],
    putBack: { possible: 'partly', sentence: 'Meta documents no way to take it back by its API; if Meta\'s screens offer to remove the ad account from the Instagram account\'s connected assets, it is taken back there.', steps: [`${ACCOUNTS_PLACE} › Instagram accounts › the account: remove ${account} from its connected assets, if Meta offers it.`] },
    warnings: [
      'Meta: the ad account must be owned by this portfolio, or reached by it while it is owned by the portfolio that owns the Instagram account; an ad account of one client cannot advertise for another business\'s Instagram account.',
      'Meta: "After assigning an ad account, all users of the business who can run ads for that account can run ads on the associated Instagram account."',
      SCREEN_WORDS,
    ],
    help: [META_ASSET_HELP.instagram, META_ASSET_HELP.portfolioSettings],
  })
}

function pageGuide(ask: AssetAsk, live: AssetLive, portfolio: Portfolio): AdminGuide | { refusal: string } {
  const claim = ask.action === 'claim-page'
  const id = ask.pageId
  if (!id) return { refusal: `Name the Page (pageId: ${claim ? 'a Page to bring into this portfolio as its owner' : 'another portfolio\'s or person\'s Page to ask access to'}).` }
  if (ask.adAccountId || ask.appId || ask.name) return { refusal: `action ${ask.action} takes pageId${claim ? '' : ' and access'} only.` }
  if (claim && ask.access) return { refusal: 'access is for request-page (a claim makes this portfolio the Page\'s owner).' }
  if (live.taken) return { refusal: TAKEN('Page', id) }
  const lists = live.lists ?? { rows: [], cut: false, unread: [] }
  const row = findIn(lists, id)
  if (row?.seen === 'taken') return { refusal: TAKEN('Page', id) }
  const asked = claim ? { pageId: id, owner: 'this portfolio' } : { pageId: id, sharedWithThisPortfolio: true, access: ask.access ?? 'partial' }
  const unsure = notSure(lists)
  const steps: string[] = [openSettings(portfolio)]
  let item: AdminItem
  if (row?.list === 'owned') {
    if (!claim) return { refusal: `Page ${id} is this portfolio's own: there is no access to ask for.` }
    item = { what: 'page', now: { pageId: id, list: 'owned', name: row.name }, asked, done: true, sentence: 'Meta lists it among this portfolio\'s own Pages.' }
  } else if (row?.list === 'client') {
    if (claim) return { refusal: `Page ${id} is another portfolio's or person's (this portfolio has partner access to it): Meta's help says the Page's owner must first remove it from their business portfolio before another can add it.` }
    item = { what: 'page', now: { pageId: id, list: 'client', name: row.seen === 'named' ? row.name : null }, asked, done: true, sentence: 'Meta lists it among the Pages this portfolio has partner access to.' }
  } else if (row && row.list.startsWith('pending')) {
    const claimWaits = row.list === 'pending-owned'
    if (claim !== claimWaits) return { refusal: `Meta lists a ${claimWaits ? 'claim' : 'request for access'} of Page ${id} waiting already (request ${row.requestId ?? 'id not given'}): wait for it, or take it back first (remove-meta-business-asset asset page).` }
    item = { what: 'page', now: { pageId: id, list: row.list, requestId: row.requestId ?? null }, asked, done: false, sentence: 'Meta lists the request as waiting for the Page\'s owner (a person with full control of the Page, or of the portfolio it is in).' }
    steps.length = 0
    steps.push(`A person with full control of Page ${id} (or of the business portfolio it is in) approves the request; Meta then lists it among this portfolio's Pages.`)
  } else {
    item = { what: 'page', now: null, asked, done: unsure ? null : false, sentence: unsure ? `Nexus does not find it in this portfolio's Page lists, but ${unsure}: it cannot tell for sure.` : 'Not in this portfolio\'s Page lists yet.' }
  }
  if (!row) {
    steps.push(claim
      ? 'Accounts › Pages › + Add › Add an existing Facebook Page; enter the Page\'s name or URL; Next; review the request and terms, tick the box; Add Page; Done (Meta\'s help).'
      : `Accounts › Pages › + Add › Request shared access to a Facebook Page; enter the Page's name or URL and pick it; choose ${ask.access === 'full' ? 'full control' : 'partial access and the tasks this portfolio needs'}; Confirm (Meta's help). Meta needs a primary Page set on the portfolio before it sends a request.`)
  }
  const warnings = claim
    ? [
        'Meta makes the portfolio the Page\'s owner at once only when the person claiming has been an admin (or manager) of the Page for more than 7 days; otherwise the claim is not approved automatically — and an owner claim without those rights fails (no request is sent to the Page\'s admins).',
        'If the Page is linked to an Instagram account, Meta\'s help says to add that Instagram account to the portfolio too. People who had access to the Page before keep it.',
        NEXUS_USES_CHOSEN,
      ]
    : [
        'Meta locks the business portfolio when too many of its Page access requests are reported as spam ("If a business has too many Page access requests reported as spam, we lock the Business Manager"): ask only for Pages whose owner expects it.',
        'With access this portfolio can run ads for the Page through its ad accounts (Meta); it cannot share the Page on to another portfolio.',
        NEXUS_USES_CHOSEN,
      ]
  return guide({
    ...base(live),
    action: ask.action,
    items: [item],
    ownerSteps: [...steps, AGAIN],
    putBack: { possible: 'yes', sentence: claim ? 'Meta\'s help: "You can always remove a Facebook Page from your business portfolio at any time" (remove-meta-business-asset asset page gives the steps); claiming it again needs a Page admin of more than 7 days.' : 'Partner access to a Page is taken off the same way (remove-meta-business-asset asset page); asking again needs the owner\'s approval again.', steps: [] },
    warnings: [...warnings, SCREEN_WORDS],
    help: claim ? [META_ASSET_HELP.addPage] : [META_ASSET_HELP.requestPage],
  })
}

function appGuide(ask: AssetAsk, live: AssetLive, portfolio: Portfolio): AdminGuide | { refusal: string } {
  const claim = ask.action === 'claim-app'
  const id = ask.appId
  if (!id) return { refusal: `Name the Meta app (appId: the App ID on its App Dashboard's Basic settings page).` }
  if (ask.adAccountId || ask.pageId || ask.name || ask.access) return { refusal: `action ${ask.action} takes appId only.` }
  const lists = live.lists ?? { rows: [], cut: false, unread: [] }
  const row = findIn(lists, id)
  if (row?.seen === 'taken') return { refusal: TAKEN('app', id) }
  const nexusApp = !!live.chosen.appId && live.chosen.appId === id
  const asked = claim ? { appId: id, owner: 'this portfolio' } : { appId: id, sharedWithThisPortfolio: true }
  const unsure = notSure(lists)
  let item: AdminItem
  const steps: string[] = [openSettings(portfolio)]
  if (row?.list === 'owned') {
    if (!claim) return { refusal: `App ${id} is this portfolio's own: there is no access to ask for.` }
    item = { what: 'app', now: { appId: id, list: 'owned', name: row.name }, asked, done: true, sentence: 'Meta lists it among this portfolio\'s own apps.' }
  } else if (row?.list === 'client') {
    if (claim) return { refusal: `App ${id} is another portfolio's (this portfolio has access to it): its owner keeps it unless they move it.` }
    item = { what: 'app', now: { appId: id, list: 'client', name: row.seen === 'named' ? row.name : null }, asked, done: true, sentence: 'Meta lists it among the apps this portfolio has access to.' }
  } else if (row?.list === 'pending') {
    item = { what: 'app', now: { appId: id, list: 'pending', requestId: row.requestId ?? null }, asked, done: false, sentence: 'Meta lists a request for it as waiting for the app\'s owner.' }
    steps.length = 0
    steps.push(`The owner of app ${id} accepts the request (Meta: "a request will be sent to the app owner to give your business portfolio ownership or access").`)
  } else {
    item = { what: 'app', now: null, asked, done: unsure ? null : false, sentence: unsure ? `Nexus does not find it in this portfolio's app lists, but ${unsure}: it cannot tell for sure.` : 'Not in this portfolio\'s app lists yet.' }
  }
  if (!row) {
    steps.push(claim
      ? `Accounts › Apps › Add › Connect an app ID: enter the App ID ${id} and click Add app (Meta's help; Meta sends the app's owner a request to give this portfolio ownership).`
      : `Accounts › Apps › Add › Request access to an app ID: enter the App ID ${id} and click Request app (Meta's help; the app's owner approves it).`)
  }
  return guide({
    ...base(live),
    action: ask.action,
    items: [item],
    ownerSteps: [...steps, AGAIN],
    putBack: { possible: 'partly', sentence: 'Meta documents no way by API to take an app back out of a portfolio (its SDK has no delete of client_apps); if Meta\'s screens offer Remove on the app (Accounts › Apps › the app), it is taken back there.', steps: [] },
    warnings: [
      ...(nexusApp ? [`This is the business's own Meta app that Nexus uses: Meta makes system users only for a portfolio that owns its app (104001), so ${claim ? 'claiming it here is what that needs' : 'this portfolio should own it rather than borrow it'}.`] : ['Nexus keeps no list of the other businesses\' Meta apps, so it cannot tell whether another business in Nexus uses this app: check before claiming it.']),
      SCREEN_WORDS,
    ],
    help: [META_ASSET_HELP.apps],
  })
}

/** BM-056 — Meta cannot make an asset group by API: the Owner makes it in the screens; Nexus reads it by its name. */
export const ASSET_GROUP_NO_API = 'Meta cannot make a business asset group by its API: its help says "you\'ll need to create business asset groups using your business portfolio", its developer guide manages only groups "someone already created via Business Manager", its reference has no create, and its SDK only lists them. So this is the Owner\'s step in Meta\'s screens in any case.'

function assetGroupGuide(ask: AssetAsk, live: AssetLive, portfolio: Portfolio): AdminGuide | { refusal: string } {
  const name = ask.name
  if (name === undefined) return { refusal: 'Name the new business asset group (name).' }
  if (ask.adAccountId || ask.pageId || ask.appId || ask.access) return { refusal: 'action asset-group takes name only.' }
  const lists = live.lists ?? { rows: [], cut: false, unread: [] }
  const same = lists.rows.filter((r) => r.list === 'owned' && r.name === name)
  const unsure = notSure(lists)
  const item: AdminItem = same.length
    ? { what: 'assetGroup', now: same.map((r) => ({ assetGroupId: r.id, name: r.name })), asked: { name }, done: true, sentence: `Meta lists a business asset group named "${name}" in this portfolio: if it is the one meant, nothing is left to do.` }
    : { what: 'assetGroup', now: { assetGroups: lists.rows.filter((r) => r.list === 'owned').length }, asked: { name }, done: unsure ? null : false, sentence: unsure ? `Nexus finds no group with that name, but ${unsure}: it cannot tell for sure.` : 'No business asset group with that name yet.' }
  return guide({
    ...base(live),
    action: 'asset-group',
    items: [item],
    ownerSteps: [
      openSettings(portfolio),
      `Accounts › Business asset groups › Create business asset group; decide how to organise the assets (by brand, line, region …); enter the name "${name}" and click Create (Meta's help).`,
      'Select the assets to include and click Add assets; optionally pick the people who work on them and set their permissions with the toggles; Done.',
      AGAIN,
    ],
    putBack: { possible: 'partly', sentence: 'Meta\'s API can rename or delete a group someone made (its asset-group guide), Nexus does not: if Meta\'s screens offer to delete the group (Business asset groups › the group), it is taken back there; the assets themselves stay in the portfolio.', steps: [] },
    warnings: [
      ASSET_GROUP_NO_API,
      'Everyone given the group reaches every asset added to it later too, with the permissions set for the group (Meta\'s help).',
      SCREEN_WORDS,
    ],
    help: [META_ASSET_HELP.assetGroup, META_ASSET_HELP.aboutAssetGroups],
  })
}

// ── remove-meta-business-asset (AA-065, BM-047, BM-049) ────────────────────────────────────────────────────────────

export interface RemoveAsk { asset: RemoveAsset; id: string; since?: string }
export interface RemoveLive {
  portfolioId: string
  portfolioName: string | null
  chosen: { adAccountId: string; pageId: string | null; instagramId: string | null }
  lists: AssetLists
  taken: boolean
  readAt: string
}

const WORDS: Readonly<Record<RemoveAsset, { what: string; place: string; label: (id: string) => string }>> = {
  'ad-account': { what: 'ad account', place: 'Ad accounts', label: act },
  page: { what: 'Page', place: 'Pages', label: (id) => id },
  instagram: { what: 'Instagram account', place: 'Instagram accounts', label: (id) => id },
}

/** What taking the business's CHOSEN asset out of the portfolio stops in Nexus. */
const CHOSEN_STOPS: Readonly<Record<RemoveAsset, string>> = {
  'ad-account': 'every Meta read and change Nexus makes for this business (its campaigns, ad sets, ads, numbers)',
  page: 'Nexus\'s Page posts, comments, messages, lead forms and the ads made with the Page',
  instagram: 'Nexus\'s Instagram posts, comments, product tags and the ads made with the account',
}

export function removeGuide(ask: RemoveAsk, live: RemoveLive): AdminGuide | { refusal: string } {
  const portfolio = { portfolioId: live.portfolioId, name: live.portfolioName }
  const w = WORDS[ask.asset]
  const label = w.label(ask.id)
  const given = sinceOf(ask.since)
  if ('refusal' in given) return given
  if (live.taken) return { refusal: TAKEN(w.what, label) }
  const row = findIn(live.lists, ask.id)
  const unsure = notSure(live.lists)
  if (!row) {
    // Step 42 review S1 — absence is the result only when asked again (since); on a first ask the id is refused, never "done".
    if (given.ms === null) return { refusal: unsure ? `${w.what[0].toUpperCase()}${w.what.slice(1)} ${label} is not among what Nexus reads of this portfolio (${unsure}), so it gives no steps for it.` : `${w.what[0].toUpperCase()}${w.what.slice(1)} ${label} is not in this business portfolio (meta-business-assets${ask.asset === 'ad-account' ? ' / meta-ad-accounts' : ''} lists what is), so there is nothing to remove.` }
    const item: AdminItem = unsure
      ? { what: ask.asset, now: null, asked: { id: label, removed: true }, done: null, sentence: `Nexus does not find it, but ${unsure}: it cannot tell whether it was removed.` }
      : { what: ask.asset, now: null, asked: { id: label, removed: true }, done: true, sentence: `Meta no longer lists ${w.what} ${label} in this portfolio: removed.` }
    return guide({ ...base(live), action: ask.asset, items: [item], ownerSteps: [], putBack: { possible: 'partly', sentence: 'Only by bringing it in again (set-meta-business-assets), as the first time.', steps: [] }, warnings: [], help: [] })
  }
  if (row.seen === 'taken') return { refusal: TAKEN(w.what, label) }
  // The gate: Nexus guides a removal only of what it may name (step 4's seenAs): the asset chosen here, one the unshared
  // portfolio owns, or a partner's asset whose owner portfolio Meta names and no other business in Nexus uses.
  if (row.seen !== 'named') return { refusal: UNKNOWN_OWNER(w.what, label) }
  const chosen = row.chosenHere === true
    || (ask.asset === 'ad-account' && ask.id === live.chosen.adAccountId) || (ask.asset === 'page' && ask.id === live.chosen.pageId) || (ask.asset === 'instagram' && ask.id === live.chosen.instagramId)
  if (ask.asset === 'ad-account' && row.list === 'owned') {
    return { refusal: `Meta does not let a portfolio remove an ad account it owns: "You cannot remove ad accounts from your business if you're OWNER and if the accounts are CONFIRMED" (only a waiting request or partner access is removed), and its help says a claimed or new ad account "can't be deleted or transferred". To stop using ${label}, a person with full access deactivates it instead (${ACCOUNTS_PLACE} › Ad accounts › the account › Deactivate; its balance is paid first, it takes a few days, and Meta may not reactivate it — help 190760004667059)${chosen ? '; it is the ad account Nexus works in for this business' : ''}.` }
  }
  const pending = row.list.startsWith('pending')
  const steps = [openSettings(portfolio)]
  if (pending) {
    steps.push(`The request for ${w.what} ${label} (Meta's request id ${row.requestId ?? 'not given'}) is still waiting: if Meta offers to cancel it there (Settings › Requests, or ${w.place} under Accounts), cancel it. Nexus found no cancel step in Meta's help.`)
  } else if (ask.asset === 'page') {
    steps.push(
      `First disconnect the Page from the business's other assets (its Instagram account, a WhatsApp account): Meta refuses to remove a Page still linked to an Instagram business profile (42001).`,
      `Accounts › Pages: click ${row.name ? `"${row.name}" ` : ''}(Page ${label}), then Remove; review the information and click Remove Page from business portfolio (Meta's help).`,
    )
  } else {
    steps.push(`Accounts › ${w.place}: click ${row.name ? `"${row.name}" ` : ''}(${w.what} ${label}), then Remove and confirm — Meta's help shows Remove on the asset (or under its three dots). If Meta does not offer it there, the asset is not removed by this portfolio.`)
  }
  const back = row.list === 'owned'
    ? ask.asset === 'page'
      ? { possible: 'partly' as const, sentence: 'Only by claiming it again (set-meta-business-assets claim-page): Meta takes it at once only from a Page admin of more than 7 days; meanwhile another portfolio may add it (Meta\'s help).', steps: [] }
      : { possible: 'partly' as const, sentence: 'Only by adding it again in Meta\'s screens, with the Instagram account\'s username and password (Meta\'s help); its people and partners are given access again one by one.', steps: [] }
    : pending
      ? { possible: 'yes' as const, sentence: 'A cancelled request is asked again the same way (set-meta-business-assets).', steps: [] }
      : { possible: 'partly' as const, sentence: 'Partner access comes back only when the owner shares it again or approves a new request (set-meta-business-assets request-…).', steps: [] }
  return guide({
    ...base(live),
    action: ask.asset,
    items: [{ what: ask.asset, now: { id: label, list: row.list, name: row.name, ...(row.requestId ? { requestId: row.requestId } : {}) }, asked: { id: label, removed: true }, done: false }],
    ownerSteps: [...steps, againWithSince(`asset ${ask.asset}, id ${ask.id}`, live.readAt)],
    putBack: back,
    warnings: [
      ...(chosen ? [`This is the ${w.what} Nexus works with for this business: taking it out of the portfolio ends the portfolio's — and Nexus's system user's — access to it at once, and with it ${CHOSEN_STOPS[ask.asset]}. Choose another one first (set-meta-connection) if Nexus should go on.`] : []),
      `Removing it ends the access of every person and partner of this portfolio to it at once (Meta's help: "After removal, people in the business portfolio will no longer have access").`,
      ...(row.list === 'owned' ? [`Once removed, another business portfolio can add it (Meta's help).`] : []),
      SCREEN_WORDS,
    ],
    afterwards: `Ask again with asset ${ask.asset}, id ${ask.id} and since "${live.readAt}".`,
    help: ask.asset === 'page' ? [META_ASSET_HELP.removePage] : ask.asset === 'instagram' ? [META_ASSET_HELP.instagram, META_ASSET_HELP.portfolioSettings] : [META_ASSET_HELP.portfolioSettings, META_ASSET_HELP.adAccounts],
  })
}

// ── create-meta-ad-account (AA-062) ─────────────────────────────────────────────────────────────────────────────────

export interface NewAdAccountAsk { name: string; currency?: string; timeZone?: string; since?: string }
export interface NewAdAccountLive {
  portfolioId: string
  portfolioName: string | null
  /** The chosen ad account's currency and time zone (the defaults offered). */
  chosen: { adAccountId: string; currency: string | null; timeZone: string | null }
  owned: { accounts: Array<{ adAccountId: string; name: string | null; currency: string | null; timeZone: string | null }>; more: boolean } | { refused: string }
  readAt: string
}

/** What a new ad account can make the business spend, in plain words (money is always said). */
export const NEW_ACCOUNT_MONEY = 'MONEY: a new ad account spends nothing until it has a payment method (or the portfolio\'s Meta credit line pays it) and an ad runs in it; adding payment info is the last of these steps (Meta: Add payment info, or later in Billing & payments). From then on every ad in it spends that payment method\'s money.'

export function newAdAccountGuide(ask: NewAdAccountAsk, live: NewAdAccountLive): AdminGuide | { refusal: string } {
  const portfolio = { portfolioId: live.portfolioId, name: live.portfolioName }
  const given = sinceOf(ask.since)
  if ('refusal' in given) return given
  const currency = ask.currency ?? live.chosen.currency
  const timeZone = ask.timeZone ?? live.chosen.timeZone
  const asked = { name: ask.name, currency, timeZone }
  let item: AdminItem
  let count: number | null = null
  if ('refused' in live.owned) {
    item = { what: 'adAccount', now: null, asked, done: null, sentence: `Nexus cannot read this portfolio's own ad accounts (${live.owned.refused}): it cannot tell whether it is made.` }
  } else {
    const same = live.owned.accounts.filter((a) => a.name === ask.name)
    count = live.owned.accounts.length
    item = same.length
      ? { what: 'adAccount', now: same.map((a) => ({ adAccountId: act(a.adAccountId), name: a.name, currency: a.currency, timeZone: a.timeZone })), asked, done: true, sentence: given.ms === null ? `Meta already lists an ad account named "${ask.name}" in this portfolio: if it is the one meant, nothing is left to do.` : `Meta lists an ad account named "${ask.name}" in this portfolio: made.` }
      : { what: 'adAccount', now: { ownedAdAccounts: count }, asked, done: live.owned.more ? null : false, ...(live.owned.more ? { sentence: 'The portfolio has more ad accounts than Nexus reads (500): it cannot tell.' } : {}) }
  }
  return guide({
    ...base(live),
    action: 'create',
    items: [item],
    ownerSteps: [
      openSettings(portfolio),
      'Accounts › Ad accounts › + Add › Create a new ad account (Meta\'s help).',
      `Enter the ad account's name "${ask.name}", its time zone ${timeZone ? `(${timeZone}${ask.timeZone ? '' : ', as the business\'s chosen ad account'})` : ''} and its currency ${currency ? `(${currency}${ask.currency ? '' : ', as the business\'s chosen ad account'})` : ''}; Next.`,
      'Choose this business portfolio and My business (the ad account is for the business itself); confirm, tick that you agree to Meta\'s Terms of Service and Advertising Standards for the portfolio, and click Create ad account.',
      'Add payment info now, or Done to add it later in Billing & payments (Payment methods) — see the MONEY line.',
      againWithSince(`name "${ask.name}"`, live.readAt),
    ],
    putBack: { possible: 'no', sentence: 'Meta\'s help: a new ad account in a business portfolio "will permanently be a part of that portfolio … can\'t be deleted or transferred". It can only be deactivated (Accounts › Ad accounts › the account › Deactivate — help 190760004667059), and a closed ad account still counts toward the portfolio\'s ad account limit.', steps: [] },
    warnings: [
      NEW_ACCOUNT_MONEY,
      'The currency and the time zone are set once: Meta takes no change of them later (a new ad account is the way).',
      'Meta makes no new ad account while any ad account of the portfolio is in bad standing or in review (3980: "All of your accounts must be in good standing in order to create new ad accounts"), nor with an incomplete ad account or a Page Meta unpublished (its developer guide).',
      `Meta's limit: a new business portfolio can make one ad account, up to 3 once a campaign delivered and a payment was made, more as the portfolio spends (Meta's help: ad account limits)${count !== null ? `; this portfolio has ${count} of its own now` : ''}. Meta's API alone stops at 5 — the screens follow the portfolio's own limit.`,
      NEXUS_USES_CHOSEN,
      SCREEN_WORDS,
    ],
    afterwards: `Ask again with name "${ask.name}" and since "${live.readAt}".`,
    help: [META_ASSET_HELP.adAccounts, META_ASSET_HELP.adAccountLimits, META_ASSET_HELP.adAccountTroubleshoot],
  })
}

// ── create-meta-appeal (LG-015, LG-016) ─────────────────────────────────────────────────────────────────────────────

export interface AppealAsk { subject: AppealSubject; since?: string }
export interface AppealLive {
  portfolioId: string
  /** The chosen ad account's status as Meta reads it now (account_status, disable_reason), or Meta's refusal. */
  account: { adAccountId: string; name: string | null; status: number | null; disableReason: number | null } | { refused: string }
  statusWords: Readonly<Record<number, string>>
  reasonWords: Readonly<Record<number, string>>
  readAt: string
}

const REVIEW_PLACE = 'Meta Business Support Home (business.facebook.com/business-support-home)'

export function appealGuide(ask: AppealAsk, live: AppealLive): AdminGuide | { refusal: string } {
  const given = sinceOf(ask.since)
  if ('refusal' in given) return given
  const steps = (which: string) => [
    `Open ${REVIEW_PLACE} with a person who is an admin of ${which} (Meta: "To request a review, you must be an admin on the account").`,
    `Account status overview (left menu): click ${which}.`,
    'In What you can do, choose Request review and complete the steps on screen (Meta may first ask to secure the account or confirm an identity there).',
    ...(given.ms === null ? [againWithSince(`subject ${ask.subject}`, live.readAt)] : []),
  ]
  const warnings = [
    'Meta allows a limited number of review requests, and "Once the review is completed, the decision is final"; Meta usually decides within 48 hours (its help).',
    'Ads that ran before the restriction do NOT start again by themselves once Meta lifts it: switching them on again is set-meta-status — SPENDS MONEY, a person\'s decision.',
    SCREEN_WORDS,
  ]
  const back = { possible: 'no' as const, sentence: 'An appeal cannot be withdrawn once it is sent (Meta documents no way); Meta\'s decision on it is final.', steps: [] }
  if (ask.subject === 'portfolio') {
    // LG-016 — no documented Business field says a portfolio is restricted (step 4 note): Nexus cannot tell, either way.
    return guide({
      ...base(live), rule: D1_APPEAL_LINE,
      action: 'appeal-portfolio',
      items: [{ what: 'portfolioRestriction', now: null, asked: { portfolioId: live.portfolioId, reviewRequested: true }, done: null, sentence: 'Meta documents no field that says whether a business portfolio is restricted, nor one that shows a review request: Nexus cannot tell. Account status overview in Business Support Home shows both.' }],
      ownerSteps: steps(`the business portfolio (id ${live.portfolioId})`),
      putBack: back,
      warnings,
      help: [META_ASSET_HELP.requestReview, META_ASSET_HELP.restrictedAccount],
    })
  }
  if ('refused' in live.account) return { refusal: `Nexus cannot read the chosen ad account's status (${live.account.refused}), so it gives no appeal steps: Business Support Home › Account status overview shows it.` }
  const a = live.account
  const label = `${a.name ? `"${a.name}" ` : ''}(${act(a.adAccountId)})`
  const status = a.status === null ? 'no status' : live.statusWords[a.status] ?? `status ${a.status}`
  const reason = a.disableReason && a.disableReason > 0 ? live.reasonWords[a.disableReason] ?? `reason ${a.disableReason}` : null
  const now = { adAccountId: act(a.adAccountId), status, ...(reason ? { disableReason: reason } : {}) }
  const asked = { adAccountId: act(a.adAccountId), active: true }
  if (a.status === 1) {
    return guide({
      ...base(live), rule: D1_APPEAL_LINE,
      action: 'appeal-ad-account',
      items: [{ what: 'adAccountStatus', now, asked, done: true, sentence: given.ms === null ? 'Meta reads the ad account as Active: there is nothing to appeal.' : 'Meta reads the ad account as Active again: Meta lifted the restriction.' }],
      ownerSteps: [], putBack: back,
      warnings: given.ms === null ? [] : [warnings[1]],
      help: [META_ASSET_HELP.requestReview],
    })
  }
  if (a.status === 100 || a.status === 101) return { refusal: `Meta reads ad account ${label} as ${status}: it is closed (or closing), not restricted, so there is nothing to appeal — reactivating a closed ad account is its own step in Meta's screens (Meta's help: make a closed ad account active).` }
  if (a.status === 3 || a.status === 8 || a.status === 9) return { refusal: `Meta reads ad account ${label} as ${status}: that is a payment matter, not a restriction to appeal — paying the balance due in Billing & payments settles it (Meta's help on a disabled ad account due to payment failure).` }
  if (a.status === 7) return { refusal: `Meta reads ad account ${label} as ${status}: Meta is reviewing it already, so there is nothing to appeal now; Business Support Home › Account status overview shows how it stands.` }
  if (a.status !== 2) return { refusal: `Meta reads ad account ${label} with ${status}, which Nexus does not know as a restriction: Business Support Home › Account status overview shows what Meta offers.` }
  return guide({
    ...base(live), rule: D1_APPEAL_LINE,
    action: 'appeal-ad-account',
    items: [{ what: 'adAccountStatus', now, asked, done: given.ms === null ? false : null, ...(given.ms === null ? {} : { sentence: 'Meta still reads the ad account as Disabled. Meta\'s API shows no review request or its outcome: Business Support Home shows whether the review was asked and how it stands.' }) }],
    ownerSteps: steps(`the ad account ${label}`),
    putBack: back,
    warnings: [
      ...(a.disableReason === 15 ? ['Meta reads it as a compromised ad account: Meta first asks to secure the account (its help: Secure your account) before a review.'] : []),
      ...warnings,
    ],
    afterwards: `Ask again with subject ad-account and since "${live.readAt}": Nexus reads the ad account's status again.`,
    help: [META_ASSET_HELP.requestReview, META_ASSET_HELP.restrictedAccount],
  })
}
