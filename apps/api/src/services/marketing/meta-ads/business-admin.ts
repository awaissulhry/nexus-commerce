/**
 * Meta ads step 42 (2026-10-26) — the business portfolio's ADMIN acts: its settings (name, primary Page, time zone,
 * industry, the two-factor rule — master BM-030, BM-031), its people (invite, change a role, remove, change or cancel an
 * invitation — BM-032…BM-035) and its system users (make one — BM-037; rename or remove one — BM-061).
 *
 * Owner decision D1 = A (2026-10-20, "yes 46 lanes"): these are the rare acts with the biggest blast radius, and only an
 * ADMIN of the portfolio may do them, so they stay in the Owner's hands. Nexus holds no admin token for them and sends NO
 * write to Meta: each answer is a guide built from what Meta reads NOW — what is asked, from → to; the exact steps in Meta's
 * screens; how to put it back (or plainly that Meta cannot); what to watch out for — and asked again, the same read says
 * what is done. Pure: the live reads are marketing/meta-ads/live-business-admin.ts (step 4's reads, reused).
 *
 * Checked 2026-10-26 (plain curl ≥ 3 s apart; developers.facebook.com/documentation/ads-commerce/marketing-api/reference/
 * {business,business-user,business-role-request,system-user}.md; the System Users guides docs/marketing-api/system-users/
 * {overview,create-retrieve-update}; the Authorization guide; Meta's Python Business SDK main, adobjects/{business,
 * businessuser,systemuser,businessrolerequest}.py; Meta's Business Help Center, www.facebook.com/business/help/<id>
 * ?locale=en_US — the article text is in the page — for the ids in META_ADMIN_HELP and 1710077379203657):
 *   - POST /{business_id}: name, primary_page, timezone_id (Meta's ids 0…592), two_factor_type {admin_required,
 *     all_required, none}, vertical (SDK Business.Vertical, 23 values below), entry_point. Error 415: "Two factor
 *     authentication required".
 *   - business-user: "An Admin can control all aspects of the business including modifying or deleting the account and
 *     adding or removing people"; `role` holds base roles only; finance_permission "such as EDITOR, ANALYST"; DELETE / role
 *     update 3914 "trying to remove the last admin".
 *   - business-role-request (an invitation): POST role, tasks; DELETE; status "such as accepted, declined, expired".
 *   - System users: "You cannot delete a system user or admin system user, but you can invalidate all access tokens for
 *     that user"; a rename is POST /{business_id}/system_users with system_user_id and name; the id the API answers is
 *     APP-SCOPED ("not the canonical ID in Business Manager > System Users"); limits: Limited tier 1 system user + 1 admin
 *     system user, Full tier 10 + 1 ("Admin System User limits will stay at 1 admin"); the business must own an app.
 *   - Help Center: invite = Settings › People › Invite people › an e-mail (the Facebook account's) or a managed Meta
 *     account › Next › business portfolio permissions › Next › assets › Invite, and "If someone else with full control …
 *     needs to approve your request …, they can do this in Requests"; a person's access = their name › Manage (Business
 *     portfolio access) › Save; remove = their name › Remove › confirm (Requests again for an approval); Settings › Requests
 *     "Manage invitations you've sent"; access levels "Full access (formerly full control)", "Basic access (formerly the
 *     employee role)", finance access to "view or manage"; a person's own name and e-mail = Business portfolio info › My
 *     info › Edit; two-factor = Business portfolio info › Business options › the dropdown › Admins only / Everyone / No one
 *     (No one not offered when Meta requires it for some portfolios over 90 days old); system users = Users › System users
 *     › Add new system user › a name › Create system user (the Managed Partner Ads developer guide adds the Admin role
 *     choice); an app = Accounts › Apps › Add; the portfolio name "cannot contain special characters".
 *   - Not in Meta's help (worded "if Meta offers …", LIVE-PROBES MS42-03…05): where the name and primary Page are edited,
 *     the portfolio's own time zone and industry, changing or cancelling a pending invitation, renaming or removing a
 *     system user in the screens.
 * Meta changes the words of its screens often: every step names the place, so a label that moved is still found there.
 */
import type { MissingPart } from './live-objects.js'
import type { BusinessSettings, PortfolioInvitation, PortfolioPerson } from './live-business.js'

// ── Meta's lists (SDK main, checked 2026-10-26) ───────────────────────────────────────────────────────────────────────

/** SDK Business.Vertical — what POST /{business_id} `vertical` takes. */
export const META_BUSINESS_VERTICALS = [
  'ADVERTISING', 'AUTOMOTIVE', 'CONSUMER_PACKAGED_GOODS', 'ECOMMERCE', 'EDUCATION', 'ENERGY_AND_UTILITIES', 'ENTERTAINMENT_AND_MEDIA',
  'FINANCIAL_SERVICES', 'GAMING', 'GOVERNMENT_AND_POLITICS', 'HEALTH', 'LUXURY', 'MARKETING', 'NON_PROFIT', 'NOT_SET',
  'ORGANIZATIONS_AND_ASSOCIATIONS', 'OTHER', 'PROFESSIONAL_SERVICES', 'RESTAURANT', 'RETAIL', 'TECHNOLOGY', 'TELECOM', 'TRAVEL',
] as const
export type MetaBusinessVertical = typeof META_BUSINESS_VERTICALS[number]
/** SDK Business.TwoFactorType. */
export const META_TWO_FACTOR_TYPES = ['none', 'admin_required', 'all_required'] as const
export type MetaTwoFactorType = typeof META_TWO_FACTOR_TYPES[number]
/** Meta's time zone ids (business.md: timezone_id, the enum 0…592). */
export const META_TIMEZONE_ID_MAX = 592
/** The base roles a person or system user is given here (Meta's role enum is longer: the others are not offered). */
export const BASE_ROLES = ['admin', 'employee'] as const
export type BaseRole = typeof BASE_ROLES[number]
export const FINANCE_ROLES = ['editor', 'analyst', 'none'] as const
export type FinanceRole = typeof FINANCE_ROLES[number]

export const PEOPLE_ACTIONS = ['invite', 'change-role', 'remove', 'change-invitation', 'cancel-invitation'] as const
export type PeopleAction = typeof PEOPLE_ACTIONS[number]
export const SYSTEM_USER_ACTIONS = ['create', 'rename', 'remove'] as const
export type SystemUserAction = typeof SYSTEM_USER_ACTIONS[number]

/** Meta's Marketing API access tier names (usage headers): Full and Limited. */
const FULL_TIER = 'standard_access'
const LIMITED_TIER = 'development_access'

// ── words every guide shares ──────────────────────────────────────────────────────────────────────────────────────

/** The sentence every answer carries: D1, in plain words. */
export const D1_LINE = 'Nexus changes nothing here and sends nothing to Meta: in Meta this is an admin\'s change of the business portfolio, and the Owner\'s decision (D1) keeps it in the hands of a person with full access to the portfolio, who makes it in Meta\'s own screens. Nexus read Meta just now, shows the exact steps and how to put it back, and reads it again when asked, to say what is done.'
/** Where the admin screens are (Meta Business Suite settings). */
export const META_SETTINGS = 'Meta Business settings (business.facebook.com/settings)'
export const SCREEN_WORDS = 'Meta changes the words of its screens often: if a label differs, the place named is still where it is.'
/** Meta's Business Help Center articles the steps follow (public pages of Meta; English with ?locale=en_US). */
export const META_ADMIN_HELP = {
  addPeople: 'https://www.facebook.com/business/help/2169003770027706',
  changeAccess: 'https://www.facebook.com/business/help/299504287548592',
  removePeople: 'https://www.facebook.com/business/help/353397428740939',
  myInfo: 'https://www.facebook.com/business/help/257957338156440',
  permissions: 'https://www.facebook.com/business/help/442345745885606',
  twoFactor: 'https://www.facebook.com/business/help/280940009201586',
  settings: 'https://www.facebook.com/business/help/530540643805698',
  systemUsers: 'https://www.facebook.com/business/help/503306463479099',
  aboutSystemUsers: 'https://www.facebook.com/business/help/327596604689624',
  addApp: 'https://www.facebook.com/business/help/2199735813629697',
} as const

export const TWO_FACTOR_SCREEN: Readonly<Record<MetaTwoFactorType, string>> = { none: 'No one', admin_required: 'Admins only', all_required: 'Everyone' }
const TWO_FACTOR_STRICTNESS: Readonly<Record<MetaTwoFactorType, number>> = { none: 0, admin_required: 1, all_required: 2 }
/** Meta's current screen words for the base roles (help 442345745885606), with the API's role. */
export const ROLE_SHORT: Readonly<Record<BaseRole, string>> = { admin: 'Full access (formerly full control: the Admin role)', employee: 'Basic access (formerly the Employee role)' }
const FINANCE_WORDS: Readonly<Record<FinanceRole, string>> = { editor: 'finance access to manage (Finance editor)', analyst: 'finance access to view (Finance analyst)', none: 'no finance access' }
const REQUESTS = 'If another person with full access to the portfolio must approve it, they do it in Settings › Requests (Meta\'s help).'

// ── reading Meta's words ──────────────────────────────────────────────────────────────────────────────────────────

/** A base role as Meta reads it (Admin / Employee in any case), or null for any other word (kept as Meta's). */
export function baseRoleOf(read: string | null): BaseRole | null {
  const v = (read ?? '').trim().toUpperCase()
  return v === 'ADMIN' ? 'admin' : v === 'EMPLOYEE' ? 'employee' : null
}
/**
 * A finance role as Meta reads it ("such as EDITOR, ANALYST"; the role enum spells FINANCE_EDITOR, FINANCE_EDIT,
 * FINANCE_ANALYST, FINANCE_VIEW): none when Meta read none, null when it is a word Nexus does not know.
 */
export function financeRoleOf(read: string | null): FinanceRole | null {
  const v = (read ?? '').trim().toUpperCase()
  if (!v || v === 'NONE') return 'none'
  if (/^(FINANCE_)?EDIT(OR)?$/.test(v)) return 'editor'
  if (/^(FINANCE_)?(ANALYST|VIEW)$/.test(v)) return 'analyst'
  return null
}
/**
 * An invitation's state as Meta reads its status ("such as accepted, declined, expired and so on"): the pending_users
 * edge lists invitations, so no status is pending; a word Nexus does not know is unknown.
 */
export type InvitationState = 'pending' | 'accepted' | 'declined' | 'expired' | 'unknown'
export function invitationStateOf(status: string | null): InvitationState {
  const v = (status ?? '').trim().toLowerCase()
  if (!v || v === 'pending') return 'pending'
  return v === 'accepted' || v === 'declined' || v === 'expired' ? v : 'unknown'
}
/** Two-factor on, as Meta reads a person's two_fac_status (its words are not documented: only "enabled" counts as on). */
const twoFactorOn = (status: string | null) => (status ?? '').trim().toLowerCase() === 'enabled'
/** A Meta time (2026-10-26T10:00:00+0000) or an ISO time, in ms; null when it is neither. */
export function timeOf(v: string | null | undefined): number | null {
  if (!v) return null
  const ms = Date.parse(v.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  return Number.isFinite(ms) ? ms : null
}
const quoted = (s: string | null) => (s === null ? 'none' : `"${s}"`)

// ── the guide ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** One thing asked: what Meta reads now, what is asked, and whether it is so already (null: Nexus cannot tell). */
export interface AdminItem { what: string; now: unknown; asked: unknown; done: boolean | null; sentence?: string }
export type AdminState = 'to-do' | 'done' | 'partly-done' | 'cannot-tell'

/** What every one of the three tools answers. */
export interface AdminGuide {
  portfolioId: string
  action: string
  /** Always nothing: D1. */
  nexusSends: 'nothing'
  state: AdminState
  stateText: string
  items: AdminItem[]
  /** The Owner's steps in Meta's screens, in order (empty when nothing is left to do). */
  ownerSteps: string[]
  /** Putting it back: possible in Meta's screens fully, partly or not at all, and how. */
  putBack: { possible: 'yes' | 'partly' | 'no'; sentence: string; steps: string[] }
  warnings: string[]
  /** How Nexus reads the result. */
  afterwards: string
  readAt: string
  rule: string
  help: string[]
  missing?: MissingPart[]
}

function stateOf(items: AdminItem[]): AdminState {
  if (items.every((i) => i.done === true)) return 'done'
  if (!items.some((i) => i.done === false)) return 'cannot-tell'
  return items.some((i) => i.done === true) ? 'partly-done' : 'to-do'
}
const STATE_TEXT: Readonly<Record<AdminState, string>> = {
  done: 'Meta reads it as asked: nothing is left to do.',
  'to-do': 'Not done yet: the Owner\'s steps below make it.',
  'partly-done': 'Part of it is done; the Owner\'s steps below are for the rest.',
  'cannot-tell': 'Nexus cannot tell from Meta\'s answer whether it is done (each item says why).',
}

const AGAIN = 'When the Owner has done it, ask again with the same arguments: Nexus reads Meta again and says what is done.'
const againWithSince = (what: string, readAt: string) => `Then ask again with ${what} and since "${readAt}" (this answer's readAt): Nexus reads Meta again and says whether it is done.`

function guide(base: Omit<AdminGuide, 'nexusSends' | 'state' | 'stateText' | 'rule' | 'afterwards'> & { afterwards?: string; stateText?: string }): AdminGuide {
  const state = stateOf(base.items)
  const left = state !== 'done'
  return {
    portfolioId: base.portfolioId,
    action: base.action,
    nexusSends: 'nothing',
    state,
    stateText: base.stateText ?? STATE_TEXT[state],
    items: base.items,
    ownerSteps: left ? base.ownerSteps : [],
    putBack: base.putBack,
    warnings: base.warnings,
    afterwards: base.afterwards ?? AGAIN,
    readAt: base.readAt,
    rule: D1_LINE,
    help: base.help,
    ...(base.missing?.length ? { missing: base.missing } : {}),
  }
}

const openSettings = (portfolio: { portfolioId: string; name: string | null }) =>
  `Open ${META_SETTINGS} and pick the business portfolio ${portfolio.name ? `"${portfolio.name}" ` : ''}(id ${portfolio.portfolioId}: the portfolio of the business's chosen ad account). Only a person with full access to the portfolio sees the places below.`

/** `since` as a time (ms; null when not given), or a refusal when it is not a time. */
function sinceOf(since: string | undefined): { ms: number | null } | { refusal: string } {
  if (!since) return { ms: null }
  const ms = timeOf(since)
  return ms === null ? { refusal: 'since must be a time (ISO 8601, e.g. the readAt of the first answer).' } : { ms }
}
/** Meta's refusal of the invitations read, or null. */
const refusedOf = (read: PeopleLive['invitations']): string | null => (read && 'refused' in read ? read.refused : null)
/** The invitations Meta answered, or null (not read, or refused). */
const invitationsOf = (read: PeopleLive['invitations']): InvitationsRead | null => (read && !('refused' in read) ? read : null)

// ── set-meta-business-settings (BM-030, BM-031) ───────────────────────────────────────────────────────────────────

export interface SettingsAsk {
  name?: string
  primaryPageId?: string
  timezoneId?: number
  vertical?: MetaBusinessVertical
  twoFactorType?: MetaTwoFactorType
}
/** The primary Page asked, as the portfolio's owned Pages read it: owned (and whether another business in Nexus uses it), not owned, or not found in a list Meta cut. */
export type PrimaryPageCheck = { kind: 'owned'; pageId: string; name: string | null; taken: boolean } | { kind: 'not-owned'; pageId: string } | { kind: 'unknown'; pageId: string; why: string }
export interface SettingsLive {
  settings: BusinessSettings
  /** The current primary Page: whether another business in Nexus picked it (then it is its id and the flag only). */
  currentPageTaken: boolean
  /** Read only when the two-factor rule is asked stricter: the people it would hold to it. */
  people: { people: PortfolioPerson[]; more: boolean; missing: MissingPart[] } | null
  primaryPage: PrimaryPageCheck | null
  readAt: string
}

const NOT_IN_HELP = (what: string, note = '') => `Nexus found no place in Meta's help for the portfolio's own ${what}${note}: if Business info (Business portfolio info) shows it, set it there; if Meta's screens have none, it stays as it is — Meta's API takes it only from an admin's token, which D1 keeps out of Nexus.`
const INFO = 'Business info (Meta also calls it Business portfolio info)'

export function settingsGuide(ask: SettingsAsk, live: SettingsLive): AdminGuide | { refusal: string } {
  const s = live.settings
  const asked = Object.entries(ask).filter(([, v]) => v !== undefined)
  if (!asked.length) return { refusal: 'Name what to change: name, primaryPageId, timezoneId, vertical or twoFactorType.' }
  const portfolio = { portfolioId: s.portfolioId, name: s.name }
  const items: AdminItem[] = []
  const steps: string[] = [openSettings(portfolio)]
  const back: string[] = []
  const warnings: string[] = []
  let partlyBack = false

  if (ask.name !== undefined) {
    const done = s.name === ask.name
    items.push({ what: 'name', now: s.name, asked: ask.name, done })
    if (!done) {
      steps.push(`${INFO}: if Meta offers to edit the business portfolio name there, change it from ${quoted(s.name)} to "${ask.name}" and save (Nexus found no edit step in Meta's help). Meta's rule: the name should match the business's public name, as it is visible across Meta, and it cannot contain special characters.`)
      back.push(`${INFO}: the name back to ${quoted(s.name)} (exactly as Meta keeps it now).`)
    }
  }

  if (ask.primaryPageId !== undefined) {
    const nowPage = s.primaryPageId ? (live.currentPageTaken ? { pageId: s.primaryPageId, takenByAnotherBusiness: true } : { pageId: s.primaryPageId }) : null
    const done = s.primaryPageId === ask.primaryPageId
    if (!done) {
      const check = live.primaryPage
      if (!check || check.kind === 'not-owned') return { refusal: `Page ${ask.primaryPageId} is not a Page this business portfolio owns, and Meta takes only an owned Page as the primary Page (#3918: "already owned by another Business Manager"). meta-business-assets view pages lists the owned ones.` }
      if (check.kind === 'unknown') return { refusal: check.why }
      if (check.taken) return { refusal: `Another business in Nexus uses Page ${ask.primaryPageId}, so Nexus gives no steps to make it this portfolio's primary Page.` }
      steps.push(`${INFO}: if Meta offers a primary Page there, set it to ${check.name ? `"${check.name}" ` : ''}(Page id ${check.pageId}, a Page this portfolio owns) and save. Nexus found no step for it in Meta's help.`)
      back.push(s.primaryPageId && !live.currentPageTaken ? `The primary Page back to Page id ${s.primaryPageId}.` : 'The primary Page back to the one it was (Nexus read none, or one another business in Nexus uses: its id only).')
      items.push({ what: 'primaryPage', now: nowPage, asked: { pageId: check.pageId, name: check.name }, done })
    } else items.push({ what: 'primaryPage', now: nowPage, asked: { pageId: ask.primaryPageId }, done })
  }

  if (ask.timezoneId !== undefined) {
    const done = s.timezoneId === ask.timezoneId
    items.push({ what: 'timeZone', now: s.timezoneId, asked: ask.timezoneId, done, ...(done ? {} : { sentence: 'Meta\'s time zone ids (timezone_id, 0…592) are its own numbers; meta-business shows the one it reads now.' }) })
    if (!done) {
      steps.push(`Time zone (Meta's id ${ask.timezoneId}): ${NOT_IN_HELP('time zone', ' (Meta\'s help names an ad account\'s time zone, which is set once)')}`)
      back.push(`Time zone: back to Meta's id ${s.timezoneId ?? 'none'} where it was changed.`)
    }
  }

  if (ask.vertical !== undefined) {
    const nowUpper = s.vertical?.trim().toUpperCase() ?? null
    const known = !!nowUpper && (META_BUSINESS_VERTICALS as readonly string[]).includes(nowUpper)
    // Step 4 note — Meta READS `vertical` as a string it does not define further; the POST takes the enum: compared only
    // when the read is one of the enum's values (LIVE-PROBES BM-002 settles the format).
    const done = known ? nowUpper === ask.vertical : null
    items.push({ what: 'industry', now: s.vertical, asked: ask.vertical, done, ...(done === null ? { sentence: `Meta reads the industry as ${quoted(s.vertical)}, which is not one of the values it takes (${META_BUSINESS_VERTICALS.length}): Nexus cannot tell whether it is ${ask.vertical}.` } : {}) })
    if (done !== true) {
      steps.push(`Industry (Meta's value ${ask.vertical}): ${NOT_IN_HELP('industry')}`)
      back.push(`Industry: back to ${quoted(s.vertical)} where it was changed.`)
    }
  }

  if (ask.twoFactorType !== undefined) {
    const now = (META_TWO_FACTOR_TYPES as readonly string[]).includes(s.twoFactorType ?? '') ? s.twoFactorType as MetaTwoFactorType : null
    const done = s.twoFactorType === ask.twoFactorType
    items.push({ what: 'twoFactor', now: s.twoFactorType, asked: ask.twoFactorType, done })
    if (!done) {
      steps.push(`Business portfolio info › Business options › the dropdown next to Two-factor authentication: choose "${TWO_FACTOR_SCREEN[ask.twoFactorType]}" (Meta's ${ask.twoFactorType}) and confirm. It takes effect at once.${ask.twoFactorType === 'none' ? ' Meta does not offer "No one" when it requires two-factor authentication for the portfolio.' : ''}`)
      back.push(now ? `Business portfolio info › Business options › Two-factor authentication: "${TWO_FACTOR_SCREEN[now]}" again.` : `Two-factor authentication: back to Meta's ${quoted(s.twoFactorType)}.`)
      if (now === null) {
        warnings.push(`Meta reads the two-factor rule as ${quoted(s.twoFactorType)}, a word Nexus does not know: it cannot say whether this tightens or loosens it.`)
        if (ask.twoFactorType !== 'none') warnings.push(...twoFactorWarnings(ask.twoFactorType, live.people))
      } else if (TWO_FACTOR_STRICTNESS[ask.twoFactorType] > TWO_FACTOR_STRICTNESS[now]) {
        warnings.push(...twoFactorWarnings(ask.twoFactorType as Exclude<MetaTwoFactorType, 'none'>, live.people))
        // Its way back loosens the rule, which Meta may refuse.
        partlyBack = true
        warnings.push('Putting it back loosens the rule: Meta requires two-factor authentication for some business portfolios over 90 days old, and then does not let it be turned off ("No one" is not offered).')
      } else {
        warnings.push('Meta requires two-factor authentication for some business portfolios over 90 days old and then does not let it be turned off ("No one" is not offered), and its help suggests keeping it ("Consider enabling two-factor authentication"). Putting it back holds every person without two-factor to it again at once.')
      }
    }
  }

  return guide({
    portfolioId: s.portfolioId,
    action: 'settings',
    items,
    ownerSteps: [...steps, AGAIN],
    putBack: back.length
      ? { possible: partlyBack ? 'partly' : 'yes', sentence: partlyBack ? 'Meta\'s screens take each value back the same way (these are the values Meta reads now), but a two-factor rule Meta requires may not be loosened again.' : 'Meta\'s screens take each value back the same way; these are the values Meta reads now.', steps: back }
      : { possible: 'yes', sentence: 'Nothing to put back: Meta reads it as asked.', steps: [] },
    warnings: [...warnings, SCREEN_WORDS],
    readAt: live.readAt,
    help: ask.twoFactorType !== undefined ? [META_ADMIN_HELP.twoFactor, META_ADMIN_HELP.settings] : [META_ADMIN_HELP.settings],
    missing: live.people?.missing,
  })
}

/** Who a stricter two-factor rule holds to it at once (people whose two-factor Meta does not read as enabled). */
function twoFactorWarnings(rule: Exclude<MetaTwoFactorType, 'none'>, people: SettingsLive['people']): string[] {
  const out: string[] = []
  if (!people) out.push('Nexus could not read the portfolio\'s people, so it cannot say who has no two-factor authentication yet.')
  else {
    const held = people.people.filter((p) => (rule === 'all_required' || baseRoleOf(p.role) === 'admin') && !twoFactorOn(p.twoFactor))
    const who = held.map((p) => `${p.name ?? 'a person'} (${p.personId ?? 'no id'}: Meta reads ${quoted(p.twoFactor)})`)
    out.push(held.length
      ? `Turning it on holds ${rule === 'all_required' ? 'everyone' : 'every admin'} to it at once (Meta's help: people without it are asked to set it up the next time they open the portfolio): Meta does not read two-factor as enabled for ${who.join(', ')}; ${held.length === 1 ? 'that person needs' : 'they need'} it on their own Facebook account before working in the portfolio again.`
      : `Meta reads two-factor as enabled for ${rule === 'all_required' ? 'everyone' : 'every admin'} it lists, so nobody it lists is held up.`)
    if (people.more) out.push('The portfolio has more people than Nexus reads (500): the list above may miss some.')
  }
  out.push('Nexus calls Meta as its system user, which signs in with no code; Meta answers 415 ("Two factor authentication required") when a call needs one: if Nexus\'s Meta reads start answering 415 after this, put the rule back.')
  return out
}

// ── set-meta-business-people (BM-032…BM-035) ─────────────────────────────────────────────────────────────────────

export interface PeopleAsk {
  action: PeopleAction
  personId?: string
  invitationId?: string
  role?: BaseRole
  financeRole?: FinanceRole
  /**
   * Asked again after the Owner acted: the readAt of the first answer. invite: an invitation made since is the result;
   * remove, cancel-invitation: a person or invitation Meta no longer lists is the result (review S1: only then).
   */
  since?: string
}
export interface PeopleRead { people: PortfolioPerson[]; totalCount: number | null; more: boolean; missing: MissingPart[] }
export interface InvitationsRead { invitations: PortfolioInvitation[]; totalCount: number | null; more: boolean; missing: MissingPart[] }
/** Review S6 — each action reads only what it needs: people (change-role, remove), their count (invite), invitations. */
export interface PeopleLive {
  portfolioId: string
  portfolioName: string | null
  people: PeopleRead | null
  peopleCount: number | null
  /** invite: Meta's refusal is kept (the steps still come, the result "cannot tell"). */
  invitations: InvitationsRead | { refused: string } | null
  readAt: string
}

const PEOPLE_PLACE = `${META_SETTINGS} › Users › People`
const NO_EMAIL = 'Nexus never takes or reads anyone\'s e-mail address: the Owner types it in Meta\'s screen.'
const accessWords = (role: BaseRole | null | undefined, finance: FinanceRole | null | undefined) =>
  [role ? ROLE_SHORT[role] : null, finance ? FINANCE_WORDS[finance] : null].filter(Boolean).join(', ')
const personLabel = (p: PortfolioPerson) => `"${p.name ?? 'the person'}" (Nexus's id ${p.personId})`
const invitationLabel = (inv: PortfolioInvitation) => `the invitation made ${inv.createdTime ?? 'at a time Meta did not give'}${inv.role ? ` with role ${inv.role}` : ''}${inv.expires ? `, expiring ${inv.expires}` : ''} (Nexus's id ${inv.invitationId})`
const otherAdmins = (people: PortfolioPerson[], personId: string | null) => people.filter((p) => p.personId !== personId && baseRoleOf(p.role) === 'admin').length

type Base = { portfolioId: string; readAt: string; missing: MissingPart[] }
type Portfolio = { portfolioId: string; name: string | null }

export function peopleGuide(ask: PeopleAsk, live: PeopleLive): AdminGuide | { refusal: string } {
  const portfolio = { portfolioId: live.portfolioId, name: live.portfolioName }
  const base = { portfolioId: live.portfolioId, readAt: live.readAt, missing: [...(live.people?.missing ?? []), ...(invitationsOf(live.invitations)?.missing ?? [])] }
  const given = sinceOf(ask.since)
  if ('refusal' in given) return given
  const since = given.ms
  switch (ask.action) {
    case 'invite': return inviteGuide(ask, since, live, portfolio, base)
    case 'change-role': return changeRoleGuide(ask, live, portfolio, base)
    case 'remove': return removeGuide(ask, since, live, portfolio, base)
    case 'change-invitation':
    case 'cancel-invitation': return invitationGuide(ask, since, live, portfolio, base)
  }
  return { refusal: `Unknown action "${String(ask.action)}".` }
}

const NOT_READ = (what: string) => ({ refusal: `Nexus could not read the portfolio's ${what}, so it gives no steps for this.` })

function inviteGuide(ask: PeopleAsk, since: number | null, live: PeopleLive, portfolio: Portfolio, base: Base): AdminGuide | { refusal: string } {
  if (!ask.role) return { refusal: 'Name the role of the person to invite: role admin (Full access) or employee (Basic access, Meta\'s default: they work only on what they are given).' }
  if (ask.personId || ask.invitationId) return { refusal: 'An invitation names no person or invitation id: the Owner types the person\'s e-mail address in Meta\'s screen.' }
  const finance = ask.financeRole && ask.financeRole !== 'none' ? ask.financeRole : null
  const askedAccess = { role: ask.role, financeRole: ask.financeRole ?? 'none' }
  const read = invitationsOf(live.invitations)
  let item: AdminItem
  if (!read) {
    // Review S6 — the steps do not need the invitations; only the result does.
    const refused = refusedOf(live.invitations)
    item = { what: 'invitation', now: null, asked: askedAccess, done: null, sentence: `Nexus cannot read the pending invitations${refused ? ` (${refused})` : ''}, so it cannot tell whether it was sent: Settings › Requests in Meta shows the invitations sent.` }
  } else if (since === null) {
    item = { what: 'invitation', now: { pendingInvitations: read.totalCount ?? read.invitations.length, people: live.peopleCount }, asked: askedAccess, done: false, sentence: 'Not sent yet as far as Nexus knows: after sending, ask again with since = this answer\'s readAt.' }
  } else {
    const made = read.invitations.filter((inv) => {
      const at = timeOf(inv.createdTime)
      return at !== null && at >= since && baseRoleOf(inv.role) === ask.role && (!finance || financeRoleOf(inv.financeRole) === finance)
    })
    // N6 — the invitation's status decides: pending or accepted is sent; declined or expired is not a live invitation.
    const sent = made.filter((inv) => ['pending', 'accepted'].includes(invitationStateOf(inv.status)))
    const unknown = made.filter((inv) => invitationStateOf(inv.status) === 'unknown')
    const shown = made.map((inv) => ({ invitationId: inv.invitationId, role: inv.role, financeRole: inv.financeRole, status: inv.status, createdTime: inv.createdTime, expires: inv.expires }))
    item = sent.length
      ? { what: 'invitation', now: shown, asked: askedAccess, done: true, sentence: `Meta lists ${sent.length === 1 ? 'an invitation' : `${sent.length} invitations`} with that access made since ${ask.since} (status ${sent.map((inv) => inv.status ?? 'pending').join(', ')}): sent; a pending one waits for the person to accept it from Meta's e-mail.` }
      : made.length
        ? { what: 'invitation', now: shown, asked: askedAccess, done: unknown.length ? null : false, sentence: unknown.length ? `Meta reads the invitation made since ${ask.since} with a status Nexus does not know: it cannot tell.` : `Meta reads the invitation made since ${ask.since} as ${made.map((inv) => inv.status).join(', ')}: it is not a live invitation; invite the person again.` }
        : { what: 'invitation', now: { pendingInvitations: read.totalCount ?? read.invitations.length, people: live.peopleCount }, asked: askedAccess, done: read.more ? null : false, sentence: read.more ? 'The portfolio has more pending invitations than Nexus reads (500): it cannot tell.' : `Meta lists no invitation with that access made since ${ask.since}: not sent yet — or already accepted (then the person is in meta-business-people view people, and the people count here grew).` }
  }
  const warnings = [
    ...(ask.role === 'admin' ? ['Full access lets the person manage everything in the portfolio — settings, people, tools and assets — claim or remove assets or people, and delete the portfolio (Meta\'s help); they could take Nexus\'s access away. Meta gives Basic access by default.'] : []),
    ...(finance === 'editor' ? ['Finance access to manage lets the person change the portfolio\'s payment methods and see its invoices and spend.'] : []),
    'The e-mail Meta sends cannot be taken back: an invitation can be cancelled only until it is accepted.',
    NO_EMAIL,
    SCREEN_WORDS,
  ]
  return guide({
    ...base,
    action: 'invite',
    items: [item],
    ownerSteps: [
      openSettings(portfolio),
      'Users › People › Invite people (top right): for a Facebook account enter the person\'s e-mail address (it must be the one their Facebook account uses); a managed Meta account is searched and picked instead. Next.',
      `Business portfolio permissions: ${ROLE_SHORT[ask.role]}${finance ? `; under the advanced options, ${FINANCE_WORDS[finance]}` : ', no finance access'}. Next.`,
      'Business assets: none, or only what the person needs (once they joined, set-meta-user-access gives tasks on the chosen ad account, Page and Instagram account). Invite.',
      `${REQUESTS} The person accepts from Meta's e-mail; Meta says it can take a few days before every feature reaches them.`,
      againWithSince(`action invite, role ${ask.role}`, live.readAt),
    ],
    putBack: {
      possible: 'partly',
      sentence: 'Until it is accepted the invitation can be cancelled where Meta offers it (action cancel-invitation gives the steps, with the id Nexus lists); the e-mail already sent stays sent. Once accepted, the person is removed instead (action remove).',
      steps: [`${META_SETTINGS} › Requests (Meta: "Manage invitations you've sent"): if Meta offers to cancel it there, cancel it. Once accepted: Users › People › the person's name › Remove, and confirm.`],
    },
    warnings,
    afterwards: `Ask again with action invite, role ${ask.role} and since "${live.readAt}".`,
    help: [META_ADMIN_HELP.addPeople, META_ADMIN_HELP.permissions],
  })
}

const NOT_A_PERSON = (read: PeopleRead, id: string) => (read.more
  ? `Person ${id} is not among the first 500 people Nexus reads of this business portfolio, so it gives no steps for them: a person sees them in ${PEOPLE_PLACE}.`
  : `Person ${id} is not a person of this business portfolio (meta-business-people view people lists them).`)

/**
 * Review S4 — the only-admin floor fails closed: a target Meta does not read as Employee counts as an admin; when no OTHER
 * person reads as Admin in a list Meta did not cut, the step is refused (Meta keeps at least one admin: 3914).
 */
function onlyAdminFloor(read: PeopleRead, found: PortfolioPerson, what: string): { refusal: string } | { warning: string } | null {
  const role = baseRoleOf(found.role)
  if (role === 'employee' || otherAdmins(read.people, found.personId) > 0) return null
  if (read.more) return { warning: 'The portfolio has more people than Nexus reads (500) and none of those it read is another admin: Nexus cannot count every admin; Meta refuses to take the last admin away (3914).' }
  return { refusal: role === 'admin'
    ? `${personLabel(found)} is the portfolio's only admin, and Meta keeps at least one (3914: "trying to remove the last admin"): give another person Full access first, then ${what}.`
    : `Meta reads the role of ${personLabel(found)} as ${quoted(found.role)}, a word Nexus does not know, and no other person reads as Admin: Nexus cannot tell whether they are the portfolio's only admin, and Meta keeps at least one (3914). Give another person Full access first, then ${what}.` }
}

function changeRoleGuide(ask: PeopleAsk, live: PeopleLive, portfolio: Portfolio, base: Base): AdminGuide | { refusal: string } {
  if (!ask.personId) return { refusal: 'Name the person (personId: meta-business-people view people lists them).' }
  const read = live.people
  if (!read) return NOT_READ('people')
  const found = read.people.find((p) => p.personId === ask.personId) ?? null
  if (!found) return { refusal: NOT_A_PERSON(read, ask.personId) }
  if (!ask.role && !ask.financeRole) return { refusal: 'Name what to change: role (admin | employee) and/or financeRole (editor | analyst | none).' }
  const nowRole = baseRoleOf(found.role)
  const nowFinance = financeRoleOf(found.financeRole)
  const floor = ask.role === 'employee' ? onlyAdminFloor(read, found, 'change this person\'s access') : null
  if (floor && 'refusal' in floor) return floor
  const items: AdminItem[] = []
  const back: string[] = []
  if (ask.role) {
    items.push({ what: 'role', now: found.role, asked: ask.role, done: nowRole === null ? null : nowRole === ask.role, ...(nowRole === null ? { sentence: `Meta reads the role as ${quoted(found.role)}: not Admin or Employee, so Nexus cannot tell.` } : {}) })
    if (nowRole !== ask.role) back.push(nowRole ? `${ROLE_SHORT[nowRole]} again.` : `Meta's ${quoted(found.role)} again.`)
  }
  if (ask.financeRole) {
    items.push({ what: 'financeRole', now: found.financeRole, asked: ask.financeRole, done: nowFinance === null ? null : nowFinance === ask.financeRole, ...(nowFinance === null ? { sentence: `Meta reads the finance role as ${quoted(found.financeRole)}, a word Nexus does not know.` } : {}) })
    if (nowFinance !== ask.financeRole) back.push(nowFinance ? `${FINANCE_WORDS[nowFinance]} again.` : `Meta's finance role ${quoted(found.financeRole)} again.`)
  }
  const warnings = [
    ...(ask.role === 'admin' && nowRole !== 'admin' ? ['Full access lets the person manage everything in the portfolio, including people and assets — and Nexus\'s access (Meta\'s help).'] : []),
    ...(floor && 'warning' in floor ? [floor.warning] : []),
    ...(found.markedForRemoval ? ['Meta already marks this person for removal from the portfolio.'] : []),
    'A person\'s name and work e-mail in the portfolio are their own: each person changes them in Business portfolio info › My info › Edit (Meta\'s help; Nexus never reads e-mail addresses).',
    'Tasks on the chosen ad account, Page or Instagram account: set-meta-user-access.',
    SCREEN_WORDS,
  ]
  return guide({
    ...base,
    action: 'change-role',
    items,
    ownerSteps: [
      openSettings(portfolio),
      `Users › People: click ${personLabel(found)}.`,
      `In Business portfolio access click Manage, set ${accessWords(ask.role, ask.financeRole)} (finance access is among the advanced options), then Save.`,
      AGAIN,
    ],
    putBack: { possible: 'yes', sentence: 'The same place gives the old access back; these are the values Meta reads now.', steps: back.length ? [`${PEOPLE_PLACE}: ${personLabel(found)} › Business portfolio access › Manage: ${back.join(' ')} Save.`] : [] },
    warnings,
    help: [META_ADMIN_HELP.changeAccess, META_ADMIN_HELP.permissions, META_ADMIN_HELP.myInfo],
  })
}

function removeGuide(ask: PeopleAsk, since: number | null, live: PeopleLive, portfolio: Portfolio, base: Base): AdminGuide | { refusal: string } {
  if (!ask.personId) return { refusal: 'Name the person (personId: meta-business-people view people lists them).' }
  const read = live.people
  if (!read) return NOT_READ('people')
  const found = read.people.find((p) => p.personId === ask.personId) ?? null
  if (!found) {
    // Review S1 — absence is the result only when asked again (since); on a first ask the id is refused, never "done".
    if (since === null) return { refusal: NOT_A_PERSON(read, ask.personId) }
    const item: AdminItem = read.more
      ? { what: 'person', now: null, asked: { personId: ask.personId, removed: true }, done: null, sentence: `Person ${ask.personId} is not among the first 500 people Nexus reads: it cannot tell whether they were removed.` }
      : { what: 'person', now: null, asked: { personId: ask.personId, removed: true }, done: true, sentence: `Meta no longer lists ${ask.personId} among the portfolio's ${read.totalCount ?? read.people.length} people: removed.` }
    return guide({ ...base, action: 'remove', items: [item], ownerSteps: [], putBack: { possible: 'partly', sentence: 'Only by a new invitation the person accepts; their assets and tasks are given again one by one.', steps: [] }, warnings: [], help: [META_ADMIN_HELP.removePeople] })
  }
  const floor = onlyAdminFloor(read, found, 'remove them')
  if (floor && 'refusal' in floor) return floor
  return guide({
    ...base,
    action: 'remove',
    items: [{ what: 'person', now: { personId: found.personId, name: found.name, role: found.role, financeRole: found.financeRole }, asked: { personId: found.personId, removed: true }, done: false }],
    ownerSteps: [
      openSettings(portfolio),
      `Users › People: click ${personLabel(found)}, then Remove, and confirm.`,
      REQUESTS,
      againWithSince(`action remove, personId ${found.personId}`, live.readAt),
    ],
    putBack: {
      possible: 'partly',
      sentence: 'Meta has no undo for a removal: the person comes back only by a new invitation they accept, and their assets and tasks are given again one by one. Note them first: meta-account-access view by-person with this personId shows what they reach now.',
      steps: [`${PEOPLE_PLACE} › Invite people: the same person's e-mail, ${accessWords(baseRoleOf(found.role), financeRoleOf(found.financeRole)) || `Meta's role ${quoted(found.role)}`}; then their assets again.`],
    },
    warnings: [
      'Removing a person ends their access to the portfolio and to every asset of it at once (Meta\'s help).',
      ...(baseRoleOf(found.role) === 'admin' ? ['They have Full access to the portfolio.'] : []),
      ...(floor && 'warning' in floor ? [floor.warning] : []),
      ...(found.markedForRemoval ? ['Meta already marks this person for removal from the portfolio.'] : []),
      SCREEN_WORDS,
    ],
    afterwards: `Ask again with action remove, personId ${found.personId} and since "${live.readAt}".`,
    help: [META_ADMIN_HELP.removePeople, META_ADMIN_HELP.addPeople],
  })
}

const NOT_AN_INVITATION = (read: InvitationsRead, id: string) => (read.more
  ? `Invitation ${id} is not among the first 500 pending invitations Nexus reads, so it gives no steps for it.`
  : `Invitation ${id} is not a pending invitation of this business portfolio (meta-business-people view invitations lists them).`)

function invitationGuide(ask: PeopleAsk, since: number | null, live: PeopleLive, portfolio: Portfolio, base: Base): AdminGuide | { refusal: string } {
  const cancel = ask.action === 'cancel-invitation'
  if (!ask.invitationId) return { refusal: 'Name the invitation (invitationId: meta-business-people view invitations lists them).' }
  if (!cancel && !ask.role && !ask.financeRole) return { refusal: 'Name the access the invitation should give: role (admin | employee) and/or financeRole (editor | analyst | none).' }
  const read = invitationsOf(live.invitations)
  if (!read) {
    const refused = refusedOf(live.invitations)
    return { refusal: `Nexus could not read the portfolio's pending invitations${refused ? ` (${refused})` : ''}, so it gives no steps for this.` }
  }
  const inv = read.invitations.find((i) => i.invitationId === ask.invitationId)
  if (!inv) {
    // Review S1 — absence is the result only when asked again (since).
    if (since === null) return { refusal: NOT_AN_INVITATION(read, ask.invitationId) }
    const item: AdminItem = read.more
      ? { what: 'invitation', now: null, asked: { invitationId: ask.invitationId, ...(cancel ? { cancelled: true } : { role: ask.role, financeRole: ask.financeRole }) }, done: null, sentence: `Invitation ${ask.invitationId} is not among the first 500 pending invitations Nexus reads: it cannot tell.` }
      : cancel
        ? { what: 'invitation', now: null, asked: { invitationId: ask.invitationId, cancelled: true }, done: true, sentence: `Meta no longer lists invitation ${ask.invitationId}: cancelled, accepted or expired (meta-business-people view people shows who joined).` }
        : { what: 'invitation', now: null, asked: { invitationId: ask.invitationId, role: ask.role, financeRole: ask.financeRole }, done: null, sentence: `Meta no longer lists invitation ${ask.invitationId}: accepted, cancelled or expired. If it was cancelled to invite the person again with the new access, ask with action invite and since.` }
    return guide({ ...base, action: ask.action, items: [item], ownerSteps: [], putBack: { possible: cancel ? 'partly' : 'yes', sentence: cancel ? 'Only by a new invitation (a new e-mail from Meta).' : 'Change it back the same way.', steps: [] }, warnings: [], help: [META_ADMIN_HELP.addPeople] })
  }
  // N6 — an invitation that is not pending any more is not cancelled or changed.
  const state = invitationStateOf(inv.status)
  const nowShown = { invitationId: inv.invitationId, role: inv.role, financeRole: inv.financeRole, status: inv.status, createdTime: inv.createdTime, expires: inv.expires }
  if (state === 'accepted' || state === 'declined' || state === 'expired') {
    if (!cancel) return { refusal: `Meta reads invitation ${inv.invitationId} as ${inv.status}: only a pending invitation can be changed (invite the person again: action invite).` }
    const item: AdminItem = { what: 'invitation', now: nowShown, asked: { invitationId: inv.invitationId, cancelled: true }, done: true, sentence: state === 'accepted' ? 'Meta reads it as accepted: the person joined, so there is nothing to cancel (action remove takes them out).' : `Meta reads it as ${inv.status}: there is nothing to cancel.` }
    return guide({ ...base, action: 'cancel-invitation', items: [item], ownerSteps: [], putBack: { possible: 'partly', sentence: 'Only by a new invitation (a new e-mail from Meta).', steps: [] }, warnings: [], help: [META_ADMIN_HELP.addPeople] })
  }
  const unknownStatus = state === 'unknown' ? [`Meta reads its status as ${quoted(inv.status)}, a word Nexus does not know.`] : []
  if (cancel) {
    return guide({
      ...base,
      action: 'cancel-invitation',
      items: [{ what: 'invitation', now: nowShown, asked: { invitationId: inv.invitationId, cancelled: true }, done: false }],
      ownerSteps: [
        openSettings(portfolio),
        `Requests (Meta: "Manage invitations you've sent"): find ${invitationLabel(inv)} — Meta shows the invited e-mail address there, which Nexus does not read. If Meta offers to cancel it there (or on the invited person in Users › People), cancel it. Nexus found no cancel step in Meta's help.`,
        againWithSince(`action cancel-invitation, invitationId ${inv.invitationId}`, live.readAt),
      ],
      putBack: { possible: 'partly', sentence: 'A cancelled invitation does not come back: the Owner invites the person again (a new e-mail from Meta; action invite).', steps: [`${PEOPLE_PLACE} › Invite people: the same e-mail, ${accessWords(baseRoleOf(inv.role), financeRoleOf(inv.financeRole)) || `Meta's role ${quoted(inv.role)}`}.`] },
      warnings: [...unknownStatus, 'The e-mail Meta already sent stays sent.', SCREEN_WORDS],
      afterwards: `Ask again with action cancel-invitation, invitationId ${inv.invitationId} and since "${live.readAt}".`,
      help: [META_ADMIN_HELP.settings, META_ADMIN_HELP.addPeople],
    })
  }
  const nowRole = baseRoleOf(inv.role)
  const nowFinance = financeRoleOf(inv.financeRole)
  const items: AdminItem[] = []
  if (ask.role) items.push({ what: 'role', now: inv.role, asked: ask.role, done: nowRole === null ? null : nowRole === ask.role })
  if (ask.financeRole) items.push({ what: 'financeRole', now: inv.financeRole, asked: ask.financeRole, done: nowFinance === null ? null : nowFinance === ask.financeRole })
  return guide({
    ...base,
    action: 'change-invitation',
    items,
    ownerSteps: [
      openSettings(portfolio),
      `Requests (or the invited person in Users › People): open ${invitationLabel(inv)} (Meta shows the invited e-mail address, which Nexus does not read).`,
      `If Meta offers to change its access there, set ${accessWords(ask.role, ask.financeRole)} and save. Nexus found no such step in Meta's help: if it is not offered, cancel the invitation and invite the person again with that access (a new e-mail; action invite with since tells when it is there).`,
      AGAIN,
    ],
    putBack: { possible: 'yes', sentence: 'The same place sets the old access again, while the invitation is pending.', steps: [`The same invitation: ${accessWords(nowRole, nowFinance) || `Meta's role ${quoted(inv.role)}`}.`] },
    warnings: [...unknownStatus, ...(ask.role === 'admin' ? ['Full access lets the person manage everything in the portfolio once the invitation is accepted.'] : []), SCREEN_WORDS],
    help: [META_ADMIN_HELP.settings, META_ADMIN_HELP.permissions],
  })
}

// ── create-meta-system-user (BM-037, BM-061) ─────────────────────────────────────────────────────────────────────

export interface SystemUserAsk {
  action: SystemUserAction
  name?: string
  role?: BaseRole
  systemUserId?: string
  /** create: a system user made at or after this time is the result; remove: one Meta no longer lists is (review S1). */
  since?: string
}
export interface SystemUserRow { systemUserId: string | null; name: string | null; role: string | null; createdTime: string | null; nexusSystemUser: boolean }
export interface SystemUserLive {
  portfolioId: string
  portfolioName: string | null
  /** The system users as Meta lists them, or Meta's refusal (it lists them only to an admin token). */
  read: { systemUsers: SystemUserRow[]; totalCount: number | null; more: boolean; missing: MissingPart[] } | { refused: string }
  /** Review S5 — whether this connection names the system user Nexus works as (null on the connection: unknown). */
  nexusSystemUserKnown: boolean
  /** Meta's Marketing API access tier on the read just made (standard_access = Full, development_access = Limited), or null. */
  tier: string | null
  /** How many apps the portfolio owns (Meta needs one to make system users, #104001); null: not known. */
  appsOwned: number | null
  readAt: string
}

const SYSTEM_USERS_PLACE = `${META_SETTINGS} › Users › System users`
const APP_SCOPED = 'Meta\'s screens show a system user\'s canonical id, while Nexus reads the app-scoped id Meta\'s API answers (Meta: "not the canonical ID"): pick it by its name.'
const TOKEN_WORDS = 'A system user\'s token is a password: never paste it into a chat. Nexus takes one only in Settings › Channels › Meta, where a person types it.'
const NO_DELETE = 'Meta\'s developer guide: "You cannot delete a system user or admin system user, but you can invalidate all access tokens for that user."'
/** Review S5 — another business in Nexus may connect with a system user of this portfolio; Nexus can tell only its own. */
const OTHER_BUSINESS_RENAME = 'Nexus can tell only the system user it works as for this business (Meta\'s ids are per app): if another business in Nexus connects to Meta with this one (its Settings › Channels › Meta), a new name changes nothing of what it may do.'
const OTHER_BUSINESS_REMOVE = 'Check first that no business in Nexus connects to Meta with this system user (each business\'s Settings › Channels › Meta names its system user): Nexus can tell only its own (Meta\'s ids are per app), and removing it, or revoking its tokens, cuts that business off at once.'

export function systemUserGuide(ask: SystemUserAsk, live: SystemUserLive): AdminGuide | { refusal: string } {
  const portfolio = { portfolioId: live.portfolioId, name: live.portfolioName }
  const base = { portfolioId: live.portfolioId, readAt: live.readAt, missing: 'refused' in live.read ? [] : live.read.missing }
  const given = sinceOf(ask.since)
  if ('refusal' in given) return given
  const since = given.ms
  if (ask.action === 'create') return createGuide(ask, since, live, portfolio, base)
  if (!ask.systemUserId) return { refusal: 'Name the system user (systemUserId: meta-business-people view system-users lists them).' }
  // Review S5 — without knowing its own system user, Nexus could guide the removal of the one it works as.
  if (ask.action === 'remove' && !live.nexusSystemUserKnown) return { refusal: 'Nexus does not know which system user it works as for this business (its Meta connection names none), so it gives no steps to remove one: removing the wrong one would cut Nexus off. A person checks Settings › Channels › Meta first.' }
  if ('refused' in live.read) return { refusal: `Nexus cannot read the portfolio's system users, so it cannot name the one to ${ask.action}: ${live.read.refused}` }
  const read = live.read
  const found = read.systemUsers.find((s) => s.systemUserId === ask.systemUserId) ?? null
  const notOne = read.more ? `System user ${ask.systemUserId} is not among the first 500 system users Nexus reads.` : `System user ${ask.systemUserId} is not a system user of this business portfolio (meta-business-people view system-users lists them).`
  if (ask.action === 'rename') {
    if (ask.name === undefined) return { refusal: 'Name the new name (name).' }
    if (!found) return { refusal: notOne }
    const done = found.name === ask.name
    return guide({
      ...base,
      action: 'rename',
      items: [{ what: 'name', now: found.name, asked: ask.name, done }],
      ownerSteps: [
        openSettings(portfolio),
        `Users › System users: click ${quoted(found.name)}. If Meta offers to edit its name there, change it to "${ask.name}" and save (Meta's API documents a rename; Nexus found no rename step in Meta's help).`,
        AGAIN,
      ],
      putBack: { possible: 'yes', sentence: 'The same place renames it back; this is its name exactly as Meta keeps it now.', steps: done ? [] : [`${SYSTEM_USERS_PLACE}: ${quoted(ask.name)} › its name back to ${quoted(found.name)}.`] },
      warnings: [
        APP_SCOPED,
        found.nexusSystemUser ? 'It is the system user Nexus works as: a new name changes nothing in what Nexus may do.' : OTHER_BUSINESS_RENAME,
        'Meta documents a rename only: no role change and no delete of a system user by its API.',
        SCREEN_WORDS,
      ],
      help: [META_ADMIN_HELP.systemUsers],
    })
  }
  // remove
  if (!found) {
    // Review S1 — absence is the result only when asked again (since).
    if (since === null) return { refusal: notOne }
    const item: AdminItem = read.more
      ? { what: 'systemUser', now: null, asked: { systemUserId: ask.systemUserId, removed: true }, done: null, sentence: `System user ${ask.systemUserId} is not among the first 500 Nexus reads: it cannot tell.` }
      : { what: 'systemUser', now: null, asked: { systemUserId: ask.systemUserId, removed: true }, done: true, sentence: `Meta no longer lists system user ${ask.systemUserId}: removed.` }
    return guide({ ...base, action: 'remove', items: [item], ownerSteps: [], putBack: { possible: 'no', sentence: 'A removed system user does not come back: a new one is a new system user, with a new id and new tokens.', steps: [] }, warnings: [], help: [META_ADMIN_HELP.systemUsers] })
  }
  if (found.nexusSystemUser) return { refusal: 'That is the system user Nexus works as for this business: removing it, or ending its tokens, cuts Nexus off from Meta. To stop Nexus, a person disconnects Meta in Settings › Channels › Meta first.' }
  return guide({
    ...base,
    action: 'remove',
    items: [{ what: 'systemUser', now: { systemUserId: found.systemUserId, name: found.name, role: found.role }, asked: { systemUserId: found.systemUserId, removed: true }, done: false }],
    ownerSteps: [
      openSettings(portfolio),
      `Users › System users: click ${quoted(found.name)}. If Meta offers Remove there, remove it and confirm. If it does not (${NO_DELETE}), revoke its tokens where Meta offers it and take every asset off it, so it can do nothing. Nexus found no remove step in Meta's help.`,
      againWithSince(`action remove, systemUserId ${found.systemUserId}`, live.readAt),
    ],
    putBack: { possible: 'no', sentence: 'A removed system user does not come back, and an ended token does not work again: a new system user (action create) has a new id and needs new tokens and assets.', steps: [] },
    warnings: [
      OTHER_BUSINESS_REMOVE,
      'Everything that uses this system user\'s token stops at once (an app, a server, a partner\'s tool).',
      ...(baseRoleOf(found.role) === 'admin' ? ['It is the portfolio\'s admin system user (Meta allows one).'] : []),
      APP_SCOPED,
      SCREEN_WORDS,
    ],
    afterwards: `Ask again with action remove, systemUserId ${found.systemUserId} and since "${live.readAt}".`,
    help: [META_ADMIN_HELP.systemUsers, META_ADMIN_HELP.aboutSystemUsers],
  })
}

function createGuide(ask: SystemUserAsk, since: number | null, live: SystemUserLive, portfolio: Portfolio, base: Base): AdminGuide | { refusal: string } {
  if (ask.name === undefined) return { refusal: 'Name the new system user (name).' }
  if (ask.systemUserId) return { refusal: 'A new system user has no id yet: drop systemUserId (it is for rename and remove).' }
  const role: BaseRole = ask.role ?? 'employee'
  const warnings: string[] = []
  let item: AdminItem
  if ('refused' in live.read) {
    item = { what: 'systemUser', now: null, asked: { name: ask.name, role }, done: null, sentence: `Nexus cannot read the portfolio's system users: ${live.read.refused}` }
  } else {
    const list = live.read.systemUsers
    const same = list.filter((s) => s.name === ask.name && baseRoleOf(s.role) === role && (since === null || ((t) => t !== null && t >= since)(timeOf(s.createdTime))))
    item = same.length
      ? { what: 'systemUser', now: same.map((s) => ({ systemUserId: s.systemUserId, name: s.name, role: s.role, createdTime: s.createdTime })), asked: { name: ask.name, role }, done: true, sentence: since === null ? `Meta already lists a system user named "${ask.name}" with that role: if it is the one meant, nothing is left to do.` : `Meta lists a system user named "${ask.name}" with that role made since ${ask.since}.` }
      : { what: 'systemUser', now: { systemUsers: live.read.totalCount ?? list.length }, asked: { name: ask.name, role }, done: live.read.more ? null : false, ...(live.read.more ? { sentence: 'The portfolio has more system users than Nexus reads (500): it cannot tell.' } : {}) }
    const admins = list.filter((s) => baseRoleOf(s.role) === 'admin').length
    const others = list.length - admins
    const cap = live.tier === FULL_TIER ? 10 : live.tier === LIMITED_TIER ? 1 : null
    const tierWords = live.tier === FULL_TIER ? 'Full' : live.tier === LIMITED_TIER ? 'Limited' : null
    if (item.done !== true) {
      if (role === 'admin' && admins >= 1) warnings.push(`The portfolio already has ${admins === 1 ? 'an admin system user' : `${admins} admin system users`}, and Meta allows one ("Admin System User limits will stay at 1 admin"; 3965): Meta will refuse a second.`)
      // N4 — the limit follows the tier of the app the PORTFOLIO owns; Nexus read its own app's tier.
      if (role === 'employee' && cap !== null && others >= cap) warnings.push(`The portfolio has ${others} system user${others === 1 ? '' : 's'} besides admins; at the ${tierWords} access tier Meta allows ${cap} (3949), so Meta may refuse another${cap === 1 ? ' until the app has the Full tier (10)' : ''} — the limit follows the tier of the app this portfolio owns, and Nexus read its own app's tier.`)
      if (role === 'employee' && cap === null) warnings.push(`Meta allows 1 system user and 1 admin system user at the Limited access tier, 10 and 1 at the Full tier (the tier of the app the portfolio owns); Meta did not name the app's tier on the read just made (the portfolio has ${others} besides admins now).`)
    }
  }
  if (live.appsOwned === 0) warnings.push('Meta reads no app this portfolio owns, and it makes system users only for a portfolio that owns one (104001: "an app must be part of the business"): the Owner adds the business\'s Meta app first — Settings › Accounts › Apps › Add (Meta\'s help).')
  if (role === 'admin') warnings.push('An admin system user can create system users, add accounts and assign permissions (Meta\'s help). Meta advises using it only for administrative actions such as assigning permissions, and guarding its token; D1 keeps its token out of Nexus.')
  warnings.push(TOKEN_WORDS, SCREEN_WORDS)
  return guide({
    ...base,
    action: 'create',
    items: [item],
    ownerSteps: [
      openSettings(portfolio),
      `Users › System users › Add new system user: name it "${ask.name}"; if Meta asks for a role, choose ${role === 'admin' ? 'Admin' : 'Employee'} (Meta's developer guide for an admin system user shows the choice; its help names none). Then Create system user.`,
      'Then only what it is for: Assign assets (only what it needs) and, for the app it serves, Generate new token (the app and its permissions, Generate token). Meta shows a token once.',
      againWithSince(`action create, the same name and role${role === 'admin' ? ' (admin)' : ''}`, live.readAt),
    ],
    putBack: { possible: 'no', sentence: `${NO_DELETE} If Meta's screens offer Remove on the new system user (${SYSTEM_USERS_PLACE}), that removes it; otherwise it stays: revoke its tokens and assign it nothing (action remove gives the steps).`, steps: [] },
    warnings,
    afterwards: `Ask again with action create, name "${ask.name}", role ${role} and since "${live.readAt}".`,
    help: [META_ADMIN_HELP.systemUsers, META_ADMIN_HELP.aboutSystemUsers, ...(live.appsOwned === 0 ? [META_ADMIN_HELP.addApp] : [])],
  })
}
