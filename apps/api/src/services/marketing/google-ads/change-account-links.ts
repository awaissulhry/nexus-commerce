/**
 * Google Ads programme 2, G8b (2026-10-15) — the account's links: a Merchant Center account (link directly, accept or
 * reject the request Merchant Center sent, remove a request, unlink) and YouTube videos (ask a creator to link a video,
 * take the request back, accept or reject a creator's request, remove a linked video). ONE call of ProductLinkService,
 * ProductLinkInvitationService or DataLinkService (gateway/google-account-calls.ts). Only RemoveProductLink has
 * validate_only (Google checks an unlink first); the others are built on the live account and sent after approval.
 *
 * Checked 2026-10-15 (v25 protos and reference/rpc/v25 pages, curl; docs/shopping-ads/merchant-center,
 * docs/account-management/linking-product-accounts and linking-youtube):
 *   Merchant Center   a direct link from Google Ads is ProductLinkService.CreateProductLink with
 *                     product_link.merchant_center.merchant_center_id, "if you have administrative access to both the
 *                     Google Ads account and the Merchant Center account"; otherwise Merchant Center sends a link request
 *                     and Google Ads accepts it: UpdateProductLinkInvitation status ACCEPTED (or REJECTED: "it cannot be
 *                     subsequently accepted"). Google Ads cannot SEND a Merchant Center request (ProductLinkInvitation
 *                     .merchant_center is OUTPUT_ONLY). Unlink: RemoveProductLink ("prevents active Shopping campaigns
 *                     linked to that Merchant Center account from serving product ads"). Links Business Manager made
 *                     cannot be changed through the API (Google refuses; the answer says so).
 *   YouTube           CreateDataLink { youtube_video { channel_id "UC…", video_id (11 characters) } } → REQUESTED; the
 *                     creator accepts. UpdateDataLink REQUESTED → REVOKED (take it back); a creator's request
 *                     PENDING_APPROVAL → ENABLED (accept) or REJECTED. RemoveDataLink removes a linked video. DataLinkType
 *                     has VIDEO only.
 *   Google Analytics  the Google Ads API cannot link GA4: ProductLink / LinkedProductType v25 has DATA_PARTNER,
 *                     GOOGLE_ADS, HOTEL_CENTER, MERCHANT_CENTER, ADVERTISING_PARTNER — no Analytics. A GA4 link is the
 *                     Analytics Admin API (googleAdsLinks.create) with the analytics.edit scope; Nexus holds
 *                     analytics.readonly only.
 *   YouTube channel   not a link the API makes either: ProductLink v25 (linked_product: advertising_partner, data_partner,
 *                     google_ads, merchant_center) has no YouTube channel; DataLink (DataLinkType VIDEO only) links
 *                     single videos — what this file does.
 *   Business Profile  no ProductLink either: the API links a Business Profile only as a location asset set
 *                     (reference/rpc/v25/BusinessProfileLocationSet: email_address and http_authorization_token both
 *                     "Required. Immutable."; docs/assets/location-assets: the token "must be obtained with the
 *                     https://www.googleapis.com/auth/business.manage scope"). Nexus's Google sign-in holds adwords,
 *                     content and analytics.readonly, not business.manage, so it cannot make that link (checked
 *                     2026-10-15, curl).
 *
 * Ids never cross businesses (Owner's rule): a Merchant Center account is linked or accepted only when it is the one THIS
 * business chose in Nexus (GoogleAccountLink product MERCHANT; the global unique index on (product, externalId) means no
 * other business holds it). The chosen ids are in the facts the run re-checks.
 *
 * Money: linking or accepting a Merchant Center account can make enabled Shopping and Performance Max campaigns that use
 * it serve product ads again — SPENDS MONEY, always said. Unlinking stops product ads (a warning, and confirmUnlink).
 */
import { YOUTUBE_CHANNEL_RE, YOUTUBE_VIDEO_RE } from '../../gateway/google-account-calls.js'
import { changeLines, type GoogleChangeDraft } from './change-draft.js'
import { ACCOUNT_CALL } from './account-client.js'
import type { LiveLinkState } from './live-account-admin.js'

export const LINK_ACTIONS = [
  'link-merchant-center', 'accept-merchant-request', 'reject-merchant-request', 'remove-merchant-request', 'unlink-merchant-center',
  'request-video-link', 'revoke-video-request', 'accept-video-link', 'reject-video-link', 'remove-video-link',
  'request-merchant-link', 'link-ga4', 'link-youtube-channel', 'link-business-profile',
] as const
export type LinkAction = typeof LINK_ACTIONS[number]

export interface LinkRequest {
  action: LinkAction
  merchantCenterId?: string
  invitationId?: string
  confirmUnlink?: boolean
  channelId?: string
  videoId?: string
  /** A video link: `{product_link_id}~{data_link_id}` (google-ads-live view links). */
  videoLinkId?: string
}

export interface LinkRecord {
  action: LinkAction
  merchantCenterId?: string | null
  invitationId?: string | null
  videoLinkId?: string | null
  channelId?: string | null
  videoId?: string | null
  /** The link's (or request's) state: 'linked', 'requested', 'pending', 'none', or Google's status. */
  state: string
}

/** Answers that need no Google call: what the Google Ads API cannot do, in words. */
export const CANNOT: Partial<Record<LinkAction, string>> = {
  'link-ga4': 'The Google Ads API cannot link Google Analytics 4: its links (v25 ProductLink) cover Merchant Center, Google Ads, Hotel Center, data and '
    + 'advertising partners only. A GA4 link is made with the Google Analytics Admin API (googleAdsLinks.create) and needs the analytics.edit '
    + 'permission, which Nexus does not have (it reads Analytics only): link it in Google Analytics › Admin › Product links › Google Ads, or in '
    + 'Google Ads › Tools › Data manager. Nexus can show the GA4 properties the account\'s conversions come from (google-ads-live view links).',
  'request-merchant-link': 'Google Ads cannot send a link request to a Merchant Center account (v25: the Merchant Center part of a link invitation is '
    + 'output only; "new link requests must be initiated using the Merchant Center interface or the Merchant API"). Either link it directly '
    + '(link-merchant-center: the Google login Nexus uses must be an administrator of both accounts), or send the request from Merchant Center '
    + '(Settings › Linked services › Google Ads) and accept it here (accept-merchant-request).',
  'link-youtube-channel': 'The Google Ads API cannot link a YouTube channel: its links (v25 ProductLink) have no YouTube channel. Link the channel in '
    + 'Google Ads › Tools › Data manager › YouTube (the channel owner confirms it). Through the API Nexus links single videos: request-video-link '
    + '(the creator accepts it in YouTube Studio).',
  'link-business-profile': 'Nexus cannot link a Google Business Profile: the Google Ads API links one only as a location asset set, which needs a '
    + 'sign-in token of the profile\'s owner (or manager) with the business.manage permission (Google\'s rule), and Nexus\'s Google sign-in does not '
    + 'have that permission (it would need a new sign-in that grants it). Link it in Google Ads › Assets › Locations (or Tools › Data manager › '
    + 'Google Business Profile).',
}

export const NOT_CHECKED_LINKS = 'Google cannot check this link change first (its method has no validate_only): the preview is built from the live '
  + 'account, and the change is sent only after a person approves it.'

const call = (path: string, body: Record<string, unknown>) => [{ [ACCOUNT_CALL]: { path, body } }]

function draftOf(summary: string, line: [string, unknown, unknown], operations: GoogleChangeDraft['operations'], stands: unknown, before: LinkRecord, after: LinkRecord, warnings: string[] = [], spendsMoney: string[] = []): GoogleChangeDraft {
  const { changes } = changeLines([line])
  return { summary, changes, totals: { links: 1 }, warnings, spendsMoney, skipped: [], operations, stands, before, after }
}

/** Why a Merchant Center account may not be linked to this business's Google Ads account, or null (it is the one chosen). */
function notChosen(id: string, live: LiveLinkState): string | null {
  if (live.chosenMerchantCenterIds.includes(id)) return null
  if (!live.chosenMerchantCenterIds.length) {
    return `This business has not chosen a Merchant Center account in Nexus: choose it first (Settings › Channels › Google › Choose accounts), then link it. Nothing was changed.`
  }
  return `Merchant Center ${id} is not the Merchant Center account this business chose in Nexus (${live.chosenMerchantCenterIds.join(', ')}): Nexus links only that one, so ids never cross businesses. Nothing was changed.`
}

/** The SPENDS MONEY line of a Merchant Center link (or an accepted request). */
const productAdsServe = (id: string) => `Linking Merchant Center ${id} lets enabled Shopping and Performance Max campaigns that use it show product ads (again): they can spend.`

export function linkDraft(customer: string, request: LinkRequest, live: LiveLinkState): GoogleChangeDraft | { refusal: string } {
  const cannot = CANNOT[request.action]
  if (cannot) return { refusal: cannot }
  const mcInvitations = live.invitations.filter((i) => i.type === 'MERCHANT_CENTER')
  switch (request.action) {
    case 'link-merchant-center': {
      const id = (request.merchantCenterId ?? '').trim()
      if (!/^\d{1,20}$/.test(id)) return { refusal: 'Give the Merchant Center account id (digits only).' }
      if (live.merchantLinks.some((l) => l.merchantCenterId === id)) return { refusal: `Merchant Center ${id} is already linked to this account.` }
      const open = mcInvitations.find((i) => i.merchantCenterId === id && (i.status === 'PENDING_APPROVAL' || i.status === 'REQUESTED'))
      if (open) return { refusal: `Merchant Center ${id} already sent a link request (${open.invitationId}, ${open.status}): accept it (accept-merchant-request).` }
      const chosen = notChosen(id, live)
      if (chosen) return { refusal: chosen }
      return draftOf(
        `Link Merchant Center account ${id} to the Google Ads account (a direct link).`,
        [`Merchant Center ${id}`, '(not linked)', 'linked'],
        call('productLinks:create', { productLink: { merchantCenter: { merchantCenterId: id } } }),
        { merchantCenterId: id, linked: false, chosen: live.chosenMerchantCenterIds },
        { action: 'link-merchant-center', merchantCenterId: id, state: 'none' },
        { action: 'link-merchant-center', merchantCenterId: id, state: 'linked' },
        ['A direct link needs the Google login Nexus uses to be an administrator of BOTH accounts; otherwise Google refuses it: send the request from Merchant Center and accept it here (accept-merchant-request).'],
        [productAdsServe(id)],
      )
    }
    case 'accept-merchant-request':
    case 'reject-merchant-request':
    case 'remove-merchant-request': {
      const id = (request.invitationId ?? '').trim()
      const invitation = mcInvitations.find((i) => i.invitationId === id)
      if (!invitation) return { refusal: `Link request ${id || '(none given)'} is not a Merchant Center request of this account (google-ads-live view links lists them).` }
      const mc = invitation.merchantCenterId ?? '?'
      if (request.action === 'remove-merchant-request') {
        if (invitation.status === 'ACCEPTED') return { refusal: `Request ${id} was accepted: the link is there; unlink it with unlink-merchant-center.` }
        return draftOf(
          `Remove the Merchant Center link request ${id} (Merchant Center ${mc}, ${invitation.status ?? 'unknown status'}).`,
          [`Link request ${id} (Merchant Center ${mc})`, invitation.status, '(removed)'],
          call('productLinkInvitations:remove', { resourceName: `${customer}/productLinkInvitations/${id}` }),
          { invitationId: id, status: invitation.status },
          { action: request.action, invitationId: id, merchantCenterId: mc, state: invitation.status ?? 'unknown' },
          { action: request.action, invitationId: id, merchantCenterId: mc, state: 'none' },
        )
      }
      if (invitation.status !== 'PENDING_APPROVAL') return { refusal: `Request ${id} from Merchant Center ${mc} is ${invitation.status ?? 'not waiting'}: only a request waiting for this account (PENDING_APPROVAL) is accepted or rejected.` }
      const accept = request.action === 'accept-merchant-request'
      // Accepting links it: only the Merchant Center this business chose (rejecting another one's request is always allowed).
      const chosen = accept ? notChosen(mc, live) : null
      if (chosen) return { refusal: chosen }
      return draftOf(
        `${accept ? 'Accept' : 'Reject'} the link request of Merchant Center account ${mc}.`,
        [`Link request ${id} (Merchant Center ${mc})`, 'waiting', accept ? 'accepted (linked)' : 'rejected'],
        call('productLinkInvitations:update', { resourceName: `${customer}/productLinkInvitations/${id}`, productLinkInvitationStatus: accept ? 'ACCEPTED' : 'REJECTED' }),
        { invitationId: id, status: invitation.status, ...(accept ? { chosen: live.chosenMerchantCenterIds } : {}) },
        { action: request.action, invitationId: id, merchantCenterId: mc, state: 'pending' },
        { action: request.action, invitationId: id, merchantCenterId: mc, state: accept ? 'linked' : 'rejected' },
        accept ? [] : ['A rejected request cannot be accepted later (Google\'s rule): Merchant Center has to send a new one.'],
        accept ? [productAdsServe(mc)] : [],
      )
    }
    case 'unlink-merchant-center': {
      const id = (request.merchantCenterId ?? '').trim()
      const link = live.merchantLinks.find((l) => l.merchantCenterId === id)
      if (!link) return { refusal: `Merchant Center ${id || '(none given)'} is not linked to this account (google-ads-live view links lists the links).` }
      if (request.confirmUnlink !== true) return { refusal: `Unlinking Merchant Center ${id} needs confirmUnlink: true: Shopping and Performance Max campaigns that use it stop showing product ads.` }
      return draftOf(
        `Unlink Merchant Center account ${id} from the Google Ads account.`,
        [`Merchant Center ${id}`, 'linked', '(unlinked)'],
        call('productLinks:remove', { resourceName: `${customer}/productLinks/${link.linkId}` }),
        { merchantCenterId: id, linkId: link.linkId },
        { action: 'unlink-merchant-center', merchantCenterId: id, state: 'linked' },
        { action: 'unlink-merchant-center', merchantCenterId: id, state: 'none' },
        [`Shopping and Performance Max campaigns that use Merchant Center ${id} stop showing product ads. Undo links it again directly (the Google login must be an administrator of both accounts).`],
      )
    }
    case 'request-video-link': {
      const channelId = (request.channelId ?? '').trim()
      const videoId = (request.videoId ?? '').trim()
      if (!YOUTUBE_CHANNEL_RE.test(channelId)) return { refusal: 'Give the YouTube channel id of the video (it starts with "UC" and has 24 characters).' }
      if (!YOUTUBE_VIDEO_RE.test(videoId)) return { refusal: 'Give the YouTube video id (the 11 characters after "watch?v=" in its address).' }
      const there = live.videos.find((v) => v.videoId === videoId && v.status !== 'REVOKED' && v.status !== 'REJECTED' && v.status !== 'DISABLED')
      if (there) return { refusal: `Video ${videoId} already has a link (${there.linkId}, ${there.status}).` }
      return draftOf(
        `Ask the YouTube channel ${channelId} to link its video ${videoId} to the Google Ads account.`,
        [`YouTube video ${videoId}`, '(not linked)', 'requested'],
        call('dataLinks:create', { dataLink: { youtubeVideo: { channelId, videoId } } }),
        { videoId, linked: false },
        { action: 'request-video-link', channelId, videoId, videoLinkId: null, state: 'none' },
        { action: 'request-video-link', channelId, videoId, videoLinkId: null, state: 'REQUESTED' },
        ['Google shares this Google Ads account\'s name and id with the channel; the creator accepts the request in YouTube Studio.'],
      )
    }
    case 'revoke-video-request':
    case 'accept-video-link':
    case 'reject-video-link':
    case 'remove-video-link': {
      const id = (request.videoLinkId ?? '').trim()
      const link = live.videos.find((v) => v.linkId === id)
      if (!link) return { refusal: `Video link ${id || '(none given)'} is not in this account (google-ads-live view links lists them as productLinkId~dataLinkId).` }
      const video = link.videoId ?? id
      const name = `${customer}/dataLinks/${id}`
      const base = { videoLinkId: id, channelId: link.channelId, videoId: link.videoId }
      const stands = { videoLinkId: id, status: link.status }
      if (request.action === 'remove-video-link') {
        if (link.status !== 'ENABLED') return { refusal: `Video ${video} is ${link.status ?? 'not linked'}: only a linked video (ENABLED) is removed (a request is taken back with revoke-video-request).` }
        return draftOf(`Remove the link of YouTube video ${video} from the Google Ads account.`, [`YouTube video ${video}`, 'linked', '(removed)'],
          call('dataLinks:remove', { resourceName: name }), stands,
          { action: request.action, ...base, state: 'ENABLED' }, { action: request.action, ...base, state: 'none' },
          ['Ads can no longer use the video\'s engagement through this link. Undo asks the creator again.'])
      }
      if (request.action === 'revoke-video-request') {
        if (link.status !== 'REQUESTED') return { refusal: `Video ${video} is ${link.status ?? 'unknown'}: only a request this account sent (REQUESTED) is taken back.` }
        return draftOf(`Take back the request to link YouTube video ${video}.`, [`YouTube video ${video}`, 'requested', 'revoked'],
          call('dataLinks:update', { resourceName: name, dataLinkStatus: 'REVOKED' }), stands,
          { action: request.action, ...base, state: 'REQUESTED' }, { action: request.action, ...base, state: 'REVOKED' })
      }
      if (link.status !== 'PENDING_APPROVAL') return { refusal: `Video ${video} is ${link.status ?? 'unknown'}: only a creator's request waiting for this account (PENDING_APPROVAL) is accepted or rejected.` }
      const accept = request.action === 'accept-video-link'
      return draftOf(`${accept ? 'Accept' : 'Reject'} the creator's request to link YouTube video ${video}.`, [`YouTube video ${video}`, 'waiting', accept ? 'linked' : 'rejected'],
        call('dataLinks:update', { resourceName: name, dataLinkStatus: accept ? 'ENABLED' : 'REJECTED' }), stands,
        { action: request.action, ...base, state: 'PENDING_APPROVAL' }, { action: request.action, ...base, state: accept ? 'ENABLED' : 'REJECTED' })
    }
    default:
      return { refusal: `Unknown link action ${String(request.action)}.` }
  }
}

/** Whether Google can check this link change first (RemoveProductLink has validate_only). */
export const linkCheckable = (action: LinkAction | undefined): boolean => action === 'unlink-merchant-center'

/** What is there now, in the shape of the change's `after` (undo's "current"). */
export function linkNow(after: LinkRecord, live: LiveLinkState): LinkRecord {
  if (after.merchantCenterId !== undefined && after.videoId === undefined) {
    const linked = live.merchantLinks.some((l) => l.merchantCenterId === after.merchantCenterId)
    if (after.state === 'linked' || after.state === 'none') return { ...after, state: linked ? 'linked' : 'none' }
    return after
  }
  const link = after.videoLinkId
    ? live.videos.find((v) => v.linkId === after.videoLinkId)
    : live.videos.find((v) => v.videoId === after.videoId && v.status === 'REQUESTED')
  return { ...after, ...(link ? { videoLinkId: link.linkId } : {}), state: link?.status ?? 'none' }
}

/** The request that puts the link back as it was, or why it cannot. */
export function linkUndo(before: LinkRecord, after: LinkRecord): { args: Record<string, unknown> } | { refusal: string } {
  switch (after.action) {
    case 'link-merchant-center':
    case 'accept-merchant-request':
      return after.merchantCenterId && after.merchantCenterId !== '?'
        ? { args: { action: 'unlink-merchant-center', merchantCenterId: after.merchantCenterId, confirmUnlink: true } }
        : { refusal: 'This change does not record the Merchant Center account it linked.' }
    case 'unlink-merchant-center':
      return before.merchantCenterId ? { args: { action: 'link-merchant-center', merchantCenterId: before.merchantCenterId } } : { refusal: 'This change does not record the Merchant Center account it unlinked.' }
    case 'reject-merchant-request':
    case 'remove-merchant-request':
      return { refusal: 'A Merchant Center link request that was rejected or removed cannot come back (Google\'s rule): Merchant Center sends a new one, or link it directly (link-merchant-center).' }
    case 'request-video-link':
      return after.videoLinkId ? { args: { action: 'revoke-video-request', videoLinkId: after.videoLinkId } } : { refusal: 'This change does not record the video link Google made.' }
    case 'revoke-video-request':
    case 'remove-video-link':
      return before.channelId && before.videoId ? { args: { action: 'request-video-link', channelId: before.channelId, videoId: before.videoId } } : { refusal: 'This change does not record the channel and video it unlinked.' }
    case 'accept-video-link':
      return after.videoLinkId ? { args: { action: 'remove-video-link', videoLinkId: after.videoLinkId } } : { refusal: 'This change does not record the video link.' }
    case 'reject-video-link':
      return { refusal: 'A rejected video request cannot be accepted later: ask the creator again (request-video-link).' }
    default:
      return { refusal: 'This link change cannot be put back.' }
  }
}
