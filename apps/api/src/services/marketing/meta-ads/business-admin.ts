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
 * Checked 2026-10-26 (curl ≥ 3 s apart; developers.facebook.com/documentation/ads-commerce/marketing-api/reference/
 * {business,business-user,business-role-request,system-user}.md; the System Users guides docs/marketing-api/system-users/
 * {overview,create-retrieve-update}; the Authorization guide; Meta's Python Business SDK main, adobjects/{business,
 * businessuser,systemuser,businessrolerequest}.py; Meta's Business Help Center articles named in META_ADMIN_HELP, read
 * through a web search because the Help Center does not answer a plain fetch):
 *   - POST /{business_id}: name, primary_page, timezone_id (unsigned int), two_factor_type {admin_required, all_required,
 *     none}, vertical (SDK Business.Vertical, 23 values below), entry_point. Error 415: "Two factor authentication required".
 *   - business-user: "An Employee can see all of information in business settings and be assigned roles by business admins.
 *     An Admin can control all aspects of the business including modifying or deleting the account and adding or removing
 *     people"; finance_permission "such as EDITOR, ANALYST"; DELETE / role update 3914 "trying to remove the last admin".
 *   - business-role-request (an invitation): POST role, tasks; DELETE.
 *   - System users: "You cannot delete a system user or admin system user, but you can invalidate all access tokens for
 *     that user"; a rename is POST /{business_id}/system_users with system_user_id and name; the id the API answers is
 *     APP-SCOPED ("not the canonical ID in Business Manager > System Users"); limits: Limited tier 1 system user + 1 admin
 *     system user, Full tier 10 + 1 ("Admin System User limits will stay at 1 admin"); the business must own an app.
 *   - Help Center: people are invited in Settings › People › Invite people (an e-mail, or a managed Meta account picked),
 *     then the portfolio's permissions, then assets; only people with full control see People; a person's name › the three
 *     dots shows edit and remove; the two-factor rule is Settings › Business portfolio info › Business options ›
 *     Two-factor authentication (No one / Admins only / Everyone), required for some portfolios over 90 days old; system
 *     users: Settings › Users › System users › Add, a name and Admin or Employee, Create system user (the Managed Partner
 *     Ads guide on developers.facebook.com gives the same clicks). Nexus found no place in Meta's help for a portfolio's own
 *     time zone or industry, nor for changing a pending invitation's role: the steps say so.
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
export const D1_LINE = 'Nexus changes nothing here and sends nothing to Meta: in Meta this is an admin\'s change of the business portfolio, and the Owner\'s decision (D1) keeps it in the hands of a person with full control of the portfolio, who makes it in Meta\'s own screens. Nexus read Meta just now, shows the exact steps and how to put it back, and reads it again when asked, to say what is done.'
/** Where the admin screens are (Meta Business Suite settings). */
export const META_SETTINGS = 'Meta Business settings (business.facebook.com/settings)'
export const SCREEN_WORDS = 'Meta changes the words of its screens often: if a label differs, the place named is still where it is.'
/** Meta's Business Help Center articles the steps follow (public pages of Meta). */
export const META_ADMIN_HELP = {
  people: 'https://www.facebook.com/business/help/2169003770027706',
  roles: 'https://www.facebook.com/business/help/442345745885606',
  twoFactor: 'https://www.facebook.com/business/help/280940009201586',
  portfolio: 'https://www.facebook.com/business/help/1710077379203657',
  systemUsers: 'https://www.facebook.com/business/help/503306463479099',
  aboutSystemUsers: 'https://www.facebook.com/business/help/327596604689624',
} as const

export const TWO_FACTOR_SCREEN: Readonly<Record<MetaTwoFactorType, string>> = { none: 'No one', admin_required: 'Admins only', all_required: 'Everyone' }
const TWO_FACTOR_STRICTNESS: Readonly<Record<MetaTwoFactorType, number>> = { none: 0, admin_required: 1, all_required: 2 }
export const ROLE_WORDS: Readonly<Record<BaseRole, string>> = {
  admin: 'Admin — in Meta\'s screens full control of the business portfolio: everything, including adding and removing people and assets',
  employee: 'Employee — basic (partial) access: works only on what is assigned to them',
}
const ROLE_SHORT: Readonly<Record<BaseRole, string>> = { admin: 'full control (Admin)', employee: 'basic access (Employee)' }
const FINANCE_WORDS: Readonly<Record<FinanceRole, string>> = { editor: 'Finance editor', analyst: 'Finance analyst', none: 'no finance role' }

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
  `Open ${META_SETTINGS} and pick the business portfolio ${portfolio.name ? `"${portfolio.name}" ` : ''}(id ${portfolio.portfolioId}: the portfolio of the business's chosen ad account). Only a person with full control (an admin) of the portfolio sees the places below.`

// ── set-meta-business-settings (BM-030, BM-031) ───────────────────────────────────────────────────────────────────

export interface SettingsAsk {
  name?: string
  primaryPageId?: string
  timezoneId?: number
  vertical?: MetaBusinessVertical
  twoFactorType?: MetaTwoFactorType
}
/** The primary Page asked, as the portfolio's owned Pages read it: owned and free, owned by this portfolio but another business in Nexus uses it, not owned, or not found in a list Meta cut. */
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

const NOT_IN_HELP = (what: string) => `Nexus found no place in Meta's help for the portfolio's own ${what} (Meta's help names an ad account's time zone, which is set once): if Business portfolio info shows it, set it there; if Meta's screens have none, it stays as it is — Meta's API takes it only from an admin's token, which D1 keeps out of Nexus.`

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
      steps.push(`Business portfolio info: change the business portfolio name from ${quoted(s.name)} to "${ask.name}" and save. Meta's help: it should match the business's public name (it is shown across Meta) and it cannot contain special characters.`)
      back.push(`Business portfolio info: change the name back to ${quoted(s.name)} (exactly as Meta keeps it now) and save.`)
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
      steps.push(`Business portfolio info: set the primary Page to ${check.name ? `"${check.name}" ` : ''}(Page id ${check.pageId}, a Page this portfolio owns) and save. If Meta shows no primary Page there, it is in the portfolio's info (older screens: Business info › Primary Page › Edit).`)
      back.push(s.primaryPageId && !live.currentPageTaken ? `Set the primary Page back to Page id ${s.primaryPageId}.` : 'Set the primary Page back to the one it was (Nexus read none, or one another business in Nexus uses: its id only).')
      items.push({ what: 'primaryPage', now: nowPage, asked: { pageId: check.pageId, name: check.name }, done })
    } else items.push({ what: 'primaryPage', now: nowPage, asked: { pageId: ask.primaryPageId }, done })
  }

  if (ask.timezoneId !== undefined) {
    const done = s.timezoneId === ask.timezoneId
    items.push({ what: 'timeZone', now: s.timezoneId, asked: ask.timezoneId, done, ...(done ? {} : { sentence: 'Meta\'s time zone ids (timezone_id) are its own numbers; meta-business shows the one it reads now.' }) })
    if (!done) {
      steps.push(`Time zone (Meta's id ${ask.timezoneId}): ${NOT_IN_HELP('time zone')}`)
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
      steps.push(`Business portfolio info › Business options › Two-factor authentication: choose "${TWO_FACTOR_SCREEN[ask.twoFactorType]}" (Meta's ${ask.twoFactorType}).`)
      back.push(now ? `Business portfolio info › Business options › Two-factor authentication: choose "${TWO_FACTOR_SCREEN[now]}" again.` : `Two-factor authentication: back to Meta's ${quoted(s.twoFactorType)}.`)
      if (now === null) {
        warnings.push(`Meta reads the two-factor rule as ${quoted(s.twoFactorType)}, a word Nexus does not know: it cannot say whether this tightens or loosens it.`)
        if (ask.twoFactorType !== 'none') warnings.push(...twoFactorWarnings(ask.twoFactorType, live.people))
      } else if (TWO_FACTOR_STRICTNESS[ask.twoFactorType] > TWO_FACTOR_STRICTNESS[now]) {
        warnings.push(...twoFactorWarnings(ask.twoFactorType as Exclude<MetaTwoFactorType, 'none'>, live.people))
        // Its way back loosens the rule, which Meta may refuse.
        partlyBack = true
        warnings.push('Putting it back loosens the rule: Meta requires two-factor authentication for some business portfolios over 90 days old, and then does not let it be loosened.')
      } else {
        warnings.push('Meta\'s help asks for two-factor authentication for everyone with access, and Meta requires it for some business portfolios over 90 days old: Meta may not let this one be loosened. Putting it back holds every person without two-factor to it again at once.')
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
    help: ask.twoFactorType !== undefined ? [META_ADMIN_HELP.twoFactor, META_ADMIN_HELP.portfolio] : [META_ADMIN_HELP.portfolio],
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
      ? `Turning it on holds ${rule === 'all_required' ? 'everyone' : 'every admin'} to it: Meta does not read two-factor as enabled for ${who.join(', ')}; ${held.length === 1 ? 'that person needs' : 'they need'} it on (their own Meta account's security settings) before working in the portfolio again.`
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
  /** invite, change-invitation: an invitation made at or after this time is the result. */
  since?: string
}
export interface PeopleLive {
  portfolioId: string
  portfolioName: string | null
  people: { people: PortfolioPerson[]; totalCount: number | null; more: boolean; missing: MissingPart[] }
  invitations: { invitations: PortfolioInvitation[]; totalCount: number | null; more: boolean; missing: MissingPart[] }
  readAt: string
}

const PEOPLE_PLACE = `${META_SETTINGS} › Users › People`
const NO_EMAIL = 'Nexus never takes or reads anyone\'s e-mail address: the Owner types it in Meta\'s screen.'
const accessWords = (role: BaseRole | null | undefined, finance: FinanceRole | null | undefined) =>
  [role ? ROLE_SHORT[role] : null, finance && finance !== 'none' ? FINANCE_WORDS[finance] : finance === 'none' ? 'no finance role' : null].filter(Boolean).join(', ')
const personLabel = (p: PortfolioPerson) => `"${p.name ?? 'the person'}" (Nexus's id ${p.personId})`
const invitationLabel = (inv: PortfolioInvitation) => `the invitation made ${inv.createdTime ?? 'at a time Meta did not give'}${inv.role ? ` with role ${inv.role}` : ''}${inv.expires ? `, expiring ${inv.expires}` : ''} (Nexus's id ${inv.invitationId})`
const adminsOf = (people: PortfolioPerson[]) => people.filter((p) => baseRoleOf(p.role) === 'admin').length

export function peopleGuide(ask: PeopleAsk, live: PeopleLive): AdminGuide | { refusal: string } {
  const portfolio = { portfolioId: live.portfolioId, name: live.portfolioName }
  const missing = [...live.people.missing, ...live.invitations.missing]
  const base = { portfolioId: live.portfolioId, readAt: live.readAt, missing }
  switch (ask.action) {
    case 'invite': return inviteGuide(ask, live, portfolio, base)
    case 'change-role': return changeRoleGuide(ask, live, portfolio, base)
    case 'remove': return removeGuide(ask, live, portfolio, base)
    case 'change-invitation':
    case 'cancel-invitation': return invitationGuide(ask, live, portfolio, base)
  }
  return { refusal: `Unknown action "${String(ask.action)}".` }
}

type Base = { portfolioId: string; readAt: string; missing: MissingPart[] }
type Portfolio = { portfolioId: string; name: string | null }

function inviteGuide(ask: PeopleAsk, live: PeopleLive, portfolio: Portfolio, base: Base): AdminGuide | { refusal: string } {
  if (!ask.role) return { refusal: 'Name the role of the person to invite: role admin or employee (Meta recommends employee: they work only on what they are given).' }
  if (ask.personId || ask.invitationId) return { refusal: 'An invitation names no person or invitation id: the Owner types the person\'s e-mail address in Meta\'s screen.' }
  const since = ask.since ? timeOf(ask.since) : null
  if (ask.since && since === null) return { refusal: 'since must be a time (ISO 8601, e.g. the readAt of the first answer).' }
  const finance = ask.financeRole && ask.financeRole !== 'none' ? ask.financeRole : null
  const made = since === null ? [] : live.invitations.invitations.filter((inv) => {
    const at = timeOf(inv.createdTime)
    return at !== null && at >= since && baseRoleOf(inv.role) === ask.role && (!finance || financeRoleOf(inv.financeRole) === finance)
  })
  const item: AdminItem = since === null
    ? { what: 'invitation', now: { pendingInvitations: live.invitations.totalCount ?? live.invitations.invitations.length, people: live.people.totalCount ?? live.people.people.length }, asked: { role: ask.role, financeRole: ask.financeRole ?? 'none' }, done: false, sentence: 'Not sent yet as far as Nexus knows: after sending, ask again with since = this answer\'s readAt.' }
    : made.length
      ? { what: 'invitation', now: made.map((inv) => ({ invitationId: inv.invitationId, role: inv.role, financeRole: inv.financeRole, status: inv.status, createdTime: inv.createdTime, expires: inv.expires })), asked: { role: ask.role, financeRole: ask.financeRole ?? 'none' }, done: true, sentence: `Meta lists ${made.length === 1 ? 'an invitation' : `${made.length} invitations`} with that role made since ${ask.since}: sent; it waits for the person to accept it (from Meta's e-mail).` }
      : { what: 'invitation', now: { pendingInvitations: live.invitations.totalCount ?? live.invitations.invitations.length, people: live.people.totalCount ?? live.people.people.length }, asked: { role: ask.role, financeRole: ask.financeRole ?? 'none' }, done: live.invitations.more ? null : false, sentence: live.invitations.more ? 'The portfolio has more pending invitations than Nexus reads (500): it cannot tell.' : `Meta lists no invitation with that role made since ${ask.since}: not sent yet — or already accepted (then the person is in meta-business-people view people, and the people count here grew).` }
  const warnings = [
    ...(ask.role === 'admin' ? [`An admin gets full control of the business portfolio: Meta says an Admin "can control all aspects of the business including modifying or deleting the account and adding or removing people" — and could take Nexus's access away. Employee is Meta's recommended choice.`] : []),
    ...(finance === 'editor' ? ['A finance editor can change the portfolio\'s payment methods and see its invoices.'] : []),
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
      `Users › People › Invite people (older screens: Add): enter the person's e-mail address — for a Facebook account the one that account uses; a managed Meta account is searched and picked instead.`,
      `Business portfolio access: give ${ROLE_SHORT[ask.role]}${finance ? `, and under finance the ${FINANCE_WORDS[finance]} role` : ', no finance role'}.`,
      'Assets: give none here, or only what the person needs (after they joined, set-meta-user-access gives tasks on the chosen ad account, Page and Instagram account).',
      'Send the invitation. The person accepts it from Meta\'s e-mail; Meta says some features can take a few days to reach them.',
      `Then ask again with action invite, the same role and since "${live.readAt}": Nexus reads the pending invitations and says whether it is there.`,
    ],
    putBack: { possible: 'partly', sentence: 'Until it is accepted the invitation can be cancelled (action cancel-invitation, with the id Nexus lists); the e-mail already sent stays sent. Once accepted, the person is removed instead (action remove).', steps: [`${PEOPLE_PLACE}: open the pending invitation › Cancel invitation (or, once accepted, the person › the three dots › Remove from business portfolio).`] },
    warnings,
    afterwards: `Ask again with action invite, role ${ask.role} and since "${live.readAt}".`,
    help: [META_ADMIN_HELP.people, META_ADMIN_HELP.roles],
  })
}

const NO_PERSON = 'Name the person (personId: meta-business-people view people lists them).'
const personOf = (ask: PeopleAsk, live: PeopleLive): PortfolioPerson | null => live.people.people.find((p) => p.personId === ask.personId) ?? null
const NOT_A_PERSON = (live: PeopleLive, id: string) => (live.people.more
  ? `Person ${id} is not among the first 500 people Nexus reads of this business portfolio, so it gives no steps for them: a person sees them in ${PEOPLE_PLACE}.`
  : `Person ${id} is not a person of this business portfolio (meta-business-people view people lists them).`)

function changeRoleGuide(ask: PeopleAsk, live: PeopleLive, portfolio: Portfolio, base: Base): AdminGuide | { refusal: string } {
  if (!ask.personId) return { refusal: NO_PERSON }
  const found = personOf(ask, live)
  if (!found) return { refusal: NOT_A_PERSON(live, ask.personId!) }
  if (!ask.role && !ask.financeRole) return { refusal: 'Name what to change: role (admin | employee) and/or financeRole (editor | analyst | none).' }
  const nowRole = baseRoleOf(found.role)
  const nowFinance = financeRoleOf(found.financeRole)
  if (ask.role === 'employee' && nowRole === 'admin') {
    const admins = adminsOf(live.people.people)
    if (admins <= 1 && !live.people.more) return { refusal: `${personLabel(found)} is the portfolio's only admin, and Meta keeps at least one (3914: "trying to remove the last admin"): make another person admin first.` }
  }
  const items: AdminItem[] = []
  const back: string[] = []
  if (ask.role) {
    items.push({ what: 'role', now: found.role, asked: ask.role, done: nowRole === null ? null : nowRole === ask.role, ...(nowRole === null ? { sentence: `Meta reads the role as ${quoted(found.role)}: not Admin or Employee, so Nexus cannot tell.` } : {}) })
    if (nowRole !== ask.role) back.push(nowRole ? `Business portfolio access back to ${ROLE_SHORT[nowRole]}.` : `Business portfolio access back to Meta's ${quoted(found.role)}.`)
  }
  if (ask.financeRole) {
    items.push({ what: 'financeRole', now: found.financeRole, asked: ask.financeRole, done: nowFinance === null ? null : nowFinance === ask.financeRole, ...(nowFinance === null ? { sentence: `Meta reads the finance role as ${quoted(found.financeRole)}, a word Nexus does not know.` } : {}) })
    if (nowFinance !== ask.financeRole) back.push(nowFinance ? `Finance role back to ${FINANCE_WORDS[nowFinance]}.` : `Finance role back to Meta's ${quoted(found.financeRole)}.`)
  }
  const warnings = [
    ...(ask.role === 'admin' && nowRole !== 'admin' ? ['An admin gets full control of the business portfolio, including adding and removing people and assets — and Nexus\'s access.'] : []),
    ...(ask.role === 'employee' && nowRole === 'admin' && live.people.more ? ['The portfolio has more people than Nexus reads (500): Nexus cannot count every admin; Meta refuses to take the last admin\'s role (3914).'] : []),
    ...(found.markedForRemoval ? ['Meta already marks this person for removal from the portfolio.'] : []),
    'A person\'s name and work e-mail in the portfolio are their own: each person changes them in their own Meta settings (Nexus never takes or reads e-mail addresses).',
    'Tasks on the chosen ad account, Page or Instagram account: set-meta-user-access.',
    SCREEN_WORDS,
  ]
  return guide({
    ...base,
    action: 'change-role',
    items,
    ownerSteps: [
      openSettings(portfolio),
      `Users › People: click ${personLabel(found)}, then the three dots (or Edit / Manage) to change their access.`,
      `Set ${accessWords(ask.role, ask.financeRole)} and save.`,
      AGAIN,
    ],
    putBack: { possible: 'yes', sentence: 'The same place gives the old access back; these are the values Meta reads now.', steps: back.length ? [`${PEOPLE_PLACE}: ${personLabel(found)} › the three dots: ${back.join(' ')}`] : [] },
    warnings,
    help: [META_ADMIN_HELP.people, META_ADMIN_HELP.roles],
  })
}

function removeGuide(ask: PeopleAsk, live: PeopleLive, portfolio: Portfolio, base: Base): AdminGuide | { refusal: string } {
  if (!ask.personId) return { refusal: NO_PERSON }
  const found = personOf(ask, live)
  if (!found) {
    // Asked again after the Owner removed them: absence IS the result (Meta lists everyone when its list was not cut).
    const item: AdminItem = live.people.more
      ? { what: 'person', now: null, asked: { personId: ask.personId, removed: true }, done: null, sentence: `Person ${ask.personId} is not among the first 500 people Nexus reads: it cannot tell whether they were removed.` }
      : { what: 'person', now: null, asked: { personId: ask.personId, removed: true }, done: true, sentence: `Meta no longer lists ${ask.personId} among the portfolio's ${live.people.totalCount ?? live.people.people.length} people: removed (or never one).` }
    return guide({ ...base, action: 'remove', items: [item], ownerSteps: [], putBack: { possible: 'partly', sentence: 'Only by a new invitation the person accepts; their assets and tasks are given again one by one.', steps: [] }, warnings: [], help: [META_ADMIN_HELP.people] })
  }
  if (baseRoleOf(found.role) === 'admin' && adminsOf(live.people.people) <= 1 && !live.people.more) {
    return { refusal: `${personLabel(found)} is the portfolio's only admin, and Meta keeps at least one (3914: "trying to remove the last admin"): make another person admin first.` }
  }
  return guide({
    ...base,
    action: 'remove',
    items: [{ what: 'person', now: { personId: found.personId, name: found.name, role: found.role, financeRole: found.financeRole }, asked: { personId: found.personId, removed: true }, done: false }],
    ownerSteps: [
      openSettings(portfolio),
      `Users › People: click ${personLabel(found)}, then the three dots › Remove from business portfolio, and confirm.`,
      AGAIN,
    ],
    putBack: {
      possible: 'partly',
      sentence: 'Meta has no undo for a removal: the person comes back only by a new invitation they accept, and their assets and tasks are given again one by one. Note them first: meta-account-access view by-person with this personId shows what they reach now.',
      steps: [`${PEOPLE_PLACE} › Invite people: the same person's e-mail, ${accessWords(baseRoleOf(found.role), financeRoleOf(found.financeRole)) || `Meta's role ${quoted(found.role)}`}; then their assets again.`],
    },
    warnings: [
      'Removing a person ends their access to the portfolio and to every asset of it at once.',
      ...(baseRoleOf(found.role) === 'admin' ? ['They are an admin of the portfolio.'] : []),
      ...(baseRoleOf(found.role) === 'admin' && live.people.more ? ['The portfolio has more people than Nexus reads (500): Nexus cannot count every admin; Meta refuses to remove the last one (3914).'] : []),
      ...(found.markedForRemoval ? ['Meta already marks this person for removal from the portfolio.'] : []),
      SCREEN_WORDS,
    ],
    help: [META_ADMIN_HELP.people],
  })
}

function invitationGuide(ask: PeopleAsk, live: PeopleLive, portfolio: Portfolio, base: Base): AdminGuide | { refusal: string } {
  const cancel = ask.action === 'cancel-invitation'
  if (!ask.invitationId) return { refusal: 'Name the invitation (invitationId: meta-business-people view invitations lists them).' }
  if (!cancel && !ask.role && !ask.financeRole) return { refusal: 'Name the role the invitation should give: role (admin | employee) and/or financeRole (editor | analyst | none).' }
  const inv = live.invitations.invitations.find((i) => i.invitationId === ask.invitationId)
  if (!inv) {
    const item: AdminItem = live.invitations.more
      ? { what: 'invitation', now: null, asked: { invitationId: ask.invitationId, ...(cancel ? { cancelled: true } : { role: ask.role, financeRole: ask.financeRole }) }, done: null, sentence: `Invitation ${ask.invitationId} is not among the first 500 pending invitations Nexus reads: it cannot tell.` }
      : cancel
        ? { what: 'invitation', now: null, asked: { invitationId: ask.invitationId, cancelled: true }, done: true, sentence: `Meta no longer lists invitation ${ask.invitationId} as pending: cancelled, accepted or expired (meta-business-people view people shows who joined).` }
        : { what: 'invitation', now: null, asked: { invitationId: ask.invitationId, role: ask.role, financeRole: ask.financeRole }, done: null, sentence: `Meta no longer lists invitation ${ask.invitationId} as pending: accepted, cancelled or expired. If it was cancelled to invite the person again with the new role, ask with action invite and since.` }
    return guide({ ...base, action: ask.action, items: [item], ownerSteps: [], putBack: { possible: cancel ? 'partly' : 'yes', sentence: cancel ? 'Only by a new invitation (a new e-mail from Meta).' : 'Change it back the same way.', steps: [] }, warnings: [], help: [META_ADMIN_HELP.people] })
  }
  if (cancel) {
    return guide({
      ...base,
      action: 'cancel-invitation',
      items: [{ what: 'invitation', now: { invitationId: inv.invitationId, role: inv.role, financeRole: inv.financeRole, status: inv.status, createdTime: inv.createdTime, expires: inv.expires }, asked: { invitationId: inv.invitationId, cancelled: true }, done: false }],
      ownerSteps: [
        openSettings(portfolio),
        `Users › People: open ${invitationLabel(inv)} — Meta shows it with the invited e-mail address, which Nexus does not read — then the three dots › Cancel invitation.`,
        AGAIN,
      ],
      putBack: { possible: 'partly', sentence: 'A cancelled invitation does not come back: the Owner invites the person again (a new e-mail from Meta; action invite).', steps: [`${PEOPLE_PLACE} › Invite people: the same e-mail, ${accessWords(baseRoleOf(inv.role), financeRoleOf(inv.financeRole)) || `Meta's role ${quoted(inv.role)}`}.`] },
      warnings: ['The e-mail Meta already sent stays sent; its link stops working once the invitation is cancelled.', SCREEN_WORDS],
      help: [META_ADMIN_HELP.people],
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
      `Users › People: open ${invitationLabel(inv)} (Meta shows the invited e-mail address, which Nexus does not read).`,
      `If Meta offers to change its access there, set ${accessWords(ask.role, ask.financeRole)} and save. Nexus found no such step in Meta's help: if it is not offered, cancel the invitation and invite the person again with that access (a new e-mail; action invite with since tells when it is there).`,
      AGAIN,
    ],
    putBack: { possible: 'yes', sentence: 'The same place sets the old access again, while the invitation is pending.', steps: [`${PEOPLE_PLACE}: the same invitation: ${accessWords(nowRole, nowFinance) || `Meta's role ${quoted(inv.role)}`}.`] },
    warnings: [...(ask.role === 'admin' ? ['An admin gets full control of the business portfolio once the invitation is accepted.'] : []), SCREEN_WORDS],
    help: [META_ADMIN_HELP.people, META_ADMIN_HELP.roles],
  })
}

// ── create-meta-system-user (BM-037, BM-061) ─────────────────────────────────────────────────────────────────────

export interface SystemUserAsk {
  action: SystemUserAction
  name?: string
  role?: BaseRole
  systemUserId?: string
  /** create: a system user made at or after this time is the result. */
  since?: string
}
export interface SystemUserRow { systemUserId: string | null; name: string | null; role: string | null; createdTime: string | null; nexusSystemUser: boolean }
export interface SystemUserLive {
  portfolioId: string
  portfolioName: string | null
  /** The system users as Meta lists them, or Meta's refusal (it lists them only to an admin token). */
  read: { systemUsers: SystemUserRow[]; totalCount: number | null; more: boolean; missing: MissingPart[] } | { refused: string }
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

export function systemUserGuide(ask: SystemUserAsk, live: SystemUserLive): AdminGuide | { refusal: string } {
  const portfolio = { portfolioId: live.portfolioId, name: live.portfolioName }
  const base = { portfolioId: live.portfolioId, readAt: live.readAt, missing: 'refused' in live.read ? [] : live.read.missing }
  if (ask.action === 'create') return createGuide(ask, live, portfolio, base)
  if (!ask.systemUserId) return { refusal: 'Name the system user (systemUserId: meta-business-people view system-users lists them).' }
  if ('refused' in live.read) return { refusal: `Nexus cannot read the portfolio's system users, so it cannot name the one to ${ask.action}: ${live.read.refused}` }
  const read = live.read
  const found = read.systemUsers.find((s) => s.systemUserId === ask.systemUserId) ?? null
  if (ask.action === 'rename') {
    if (ask.name === undefined) return { refusal: 'Name the new name (name).' }
    if (!found) return { refusal: read.more ? `System user ${ask.systemUserId} is not among the first 500 system users Nexus reads.` : `System user ${ask.systemUserId} is not a system user of this business portfolio (meta-business-people view system-users lists them).` }
    const done = found.name === ask.name
    return guide({
      ...base,
      action: 'rename',
      items: [{ what: 'name', now: found.name, asked: ask.name, done }],
      ownerSteps: [
        openSettings(portfolio),
        `Users › System users: click ${quoted(found.name)}, then Edit (the pencil by its name), type "${ask.name}" and save.`,
        AGAIN,
      ],
      putBack: { possible: 'yes', sentence: 'The same place renames it back; this is its name exactly as Meta keeps it now.', steps: done ? [] : [`${SYSTEM_USERS_PLACE}: ${quoted(ask.name)} › Edit › ${quoted(found.name)}.`] },
      warnings: [
        APP_SCOPED,
        ...(found.nexusSystemUser ? ['It is the system user Nexus works as: a new name changes nothing in what Nexus may do.'] : []),
        'Meta documents a rename only: no role change and no delete of a system user by its API.',
        SCREEN_WORDS,
      ],
      help: [META_ADMIN_HELP.systemUsers],
    })
  }
  // remove
  if (!found) {
    const item: AdminItem = read.more
      ? { what: 'systemUser', now: null, asked: { systemUserId: ask.systemUserId, removed: true }, done: null, sentence: `System user ${ask.systemUserId} is not among the first 500 Nexus reads: it cannot tell.` }
      : { what: 'systemUser', now: null, asked: { systemUserId: ask.systemUserId, removed: true }, done: true, sentence: `Meta no longer lists system user ${ask.systemUserId}: removed (or never one of this portfolio).` }
    return guide({ ...base, action: 'remove', items: [item], ownerSteps: [], putBack: { possible: 'no', sentence: 'A removed system user does not come back: a new one is a new system user, with a new id and new tokens.', steps: [] }, warnings: [], help: [META_ADMIN_HELP.systemUsers] })
  }
  if (found.nexusSystemUser) return { refusal: 'That is the system user Nexus works as for this business: removing it, or ending its tokens, cuts Nexus off from Meta. To stop Nexus, a person disconnects Meta in Settings › Channels › Meta first.' }
  return guide({
    ...base,
    action: 'remove',
    items: [{ what: 'systemUser', now: { systemUserId: found.systemUserId, name: found.name, role: found.role }, asked: { systemUserId: found.systemUserId, removed: true }, done: false }],
    ownerSteps: [
      openSettings(portfolio),
      `Users › System users: click ${quoted(found.name)}. If Meta offers Remove there, remove it and confirm. If it does not (${NO_DELETE}), revoke its tokens there and take every asset off it, so it can do nothing.`,
      AGAIN,
    ],
    putBack: { possible: 'no', sentence: 'A removed system user does not come back, and an ended token does not work again: a new system user (action create) has a new id and needs new tokens and assets.', steps: [] },
    warnings: [
      'Everything that uses this system user\'s token stops at once (an app, a server, a partner\'s tool).',
      ...(baseRoleOf(found.role) === 'admin' ? ['It is the portfolio\'s admin system user (Meta allows one).'] : []),
      APP_SCOPED,
      SCREEN_WORDS,
    ],
    help: [META_ADMIN_HELP.systemUsers, META_ADMIN_HELP.aboutSystemUsers],
  })
}

function createGuide(ask: SystemUserAsk, live: SystemUserLive, portfolio: Portfolio, base: Base): AdminGuide | { refusal: string } {
  if (ask.name === undefined) return { refusal: 'Name the new system user (name).' }
  if (ask.systemUserId) return { refusal: 'A new system user has no id yet: drop systemUserId (it is for rename and remove).' }
  const role: BaseRole = ask.role ?? 'employee'
  const since = ask.since ? timeOf(ask.since) : null
  if (ask.since && since === null) return { refusal: 'since must be a time (ISO 8601, e.g. the readAt of the first answer).' }
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
      if (role === 'employee' && cap !== null && others >= cap) warnings.push(`The portfolio has ${others} system user${others === 1 ? '' : 's'} besides admins, and at the ${tierWords} access tier Meta allows ${cap} (3949): Meta will refuse another${cap === 1 ? ' until the app has the Full tier (10)' : ''}.`)
      if (role === 'employee' && cap === null) warnings.push(`Meta allows 1 system user and 1 admin system user at the Limited access tier, 10 and 1 at the Full tier; Meta did not name the app's tier on the read just made (the portfolio has ${others} besides admins now).`)
    }
  }
  if (live.appsOwned === 0) warnings.push('Meta reads no app this portfolio owns, and it makes system users only for a portfolio that owns one (104001: "an app must be part of the business"): the Owner adds the business\'s Meta app to the portfolio first (Settings › Accounts › Apps).')
  if (role === 'admin') warnings.push('An admin system user reaches every asset of the portfolio and can make system users and give access (Meta). Meta advises using it only to manage access, never for everyday work; D1 keeps its token out of Nexus.')
  warnings.push(TOKEN_WORDS, SCREEN_WORDS)
  return guide({
    ...base,
    action: 'create',
    items: [item],
    ownerSteps: [
      openSettings(portfolio),
      `Users › System users › Add: name it "${ask.name}", choose the role ${role === 'admin' ? 'Admin' : 'Employee'}, then Create system user.`,
      'Then only what it is for: Assign assets (only what it needs, with the tasks it needs) and, for the app it serves, Generate new token.',
      `Then ask again with action create, the same name and role and since "${live.readAt}".`,
    ],
    putBack: { possible: 'no', sentence: `${NO_DELETE} If Meta's screens offer Remove on the new system user (${SYSTEM_USERS_PLACE}), that removes it; otherwise it stays: revoke its tokens and assign it nothing (action remove gives the steps).`, steps: [] },
    warnings,
    afterwards: `Ask again with action create, name "${ask.name}", role ${role} and since "${live.readAt}".`,
    help: [META_ADMIN_HELP.systemUsers, META_ADMIN_HELP.aboutSystemUsers],
  })
}
