/**
 * Meta ads step 42 (2026-10-26) — the live reads behind the business-admin guides (business-admin.ts): ONLY step 4's
 * exported reads of the chosen ad account's business portfolio (live-business.ts: its settings, people, invitations, system
 * users, owned Pages and apps), step 41's account read for Meta's access tier (live-access-change.ts) and the "taken" table.
 * Every call is a GET through the gateway; nothing here writes, stores or remembers anything (D1: the Owner makes these
 * changes in Meta's screens).
 *
 * One business at a time: when another business in Nexus uses an ad account of the chosen portfolio, no guide is given and
 * nothing is read (a change of its settings, people or system users would change that business's portfolio too). A Page
 * another business in Nexus picked is never offered as the primary Page.
 */
import { MetaReadError } from './errors.js'
import { metaChosenAccount, MetaLiveRefusal, type MetaChosenAccount } from './live.js'
import { assetsView, chosenPortfolio, portfolioShared, readBusinessSettings, readInvitations, readPortfolioPeople, readSystemUsers } from './live-business.js'
import { liveAccessState } from './live-access-change.js'
import { takenIds } from './taken.js'
import {
  peopleGuide, settingsGuide, systemUserGuide,
  type AdminGuide, type PeopleAsk, type PeopleLive, type PrimaryPageCheck, type SettingsAsk, type SettingsLive, type SystemUserAsk, type SystemUserLive,
} from './business-admin.js'

/** How many rows a guide reads of a list (step 4's cap): a target not found in a list Meta cut is refused, never guessed. */
const MAX_ROWS = 500

export const ADMIN_SHARED = 'Another business in Nexus uses an ad account of this Meta business portfolio, so Nexus gives no admin steps for it and reads nothing for them: a change of its settings, people or system users would change that business\'s portfolio too. A person with full control of the portfolio decides it in Meta Business settings.'

/** The chosen ad account and its portfolio — refused in words, before any Meta call, when another business in Nexus uses that portfolio. */
async function adminScope(connectionId: string | null | undefined): Promise<{ account: MetaChosenAccount; portfolioId: string }> {
  const account = await metaChosenAccount(connectionId)
  const portfolioId = chosenPortfolio(account)
  if (await portfolioShared(portfolioId)) throw new MetaLiveRefusal(ADMIN_SHARED)
  return { account, portfolioId }
}

const done = (out: AdminGuide | { refusal: string }): AdminGuide => {
  if ('refusal' in out) throw new MetaLiveRefusal(out.refusal)
  return out
}

/** The asked primary Page among the portfolio's owned Pages (step 4's masked list: another business's Page is its id and the flag). */
async function primaryPageCheck(account: MetaChosenAccount, pageId: string): Promise<PrimaryPageCheck> {
  const read = await assetsView({ connectionId: account.connectionId, view: 'pages', list: 'owned', maxRows: MAX_ROWS }) as {
    lists: Array<{ items: Array<Record<string, unknown>>; more: boolean }>; missing: Array<{ part: string; sentence: string }>
  }
  const owned = read.lists[0]
  if (!owned) return { kind: 'unknown', pageId, why: `Nexus could not read the Pages this business portfolio owns (${read.missing.map((m) => m.sentence).join(' ') || 'Meta gave no list'}), so it cannot check that Page ${pageId} is one: a person checks it in Meta Business settings › Accounts › Pages.` }
  const row = owned.items.find((r) => r.pageId === pageId)
  if (row) return { kind: 'owned', pageId, name: typeof row.name === 'string' ? row.name : null, taken: row.takenByAnotherBusiness === true }
  if (owned.more) return { kind: 'unknown', pageId, why: `Page ${pageId} is not among the first ${MAX_ROWS} Pages this business portfolio owns that Nexus reads, so it gives no steps to make it the primary Page.` }
  return { kind: 'not-owned', pageId }
}

/** set-meta-business-settings — BM-030, BM-031. */
export async function businessSettingsAdmin(input: { connectionId?: string | null } & SettingsAsk): Promise<AdminGuide> {
  const { account } = await adminScope(input.connectionId)
  const readAt = new Date().toISOString()
  const ask: SettingsAsk = { name: input.name, primaryPageId: input.primaryPageId, timezoneId: input.timezoneId, vertical: input.vertical, twoFactorType: input.twoFactorType }
  const settings = await readBusinessSettings(account, 'admin.settings')
  const currentPageTaken = settings.primaryPageId ? (await takenIds('PAGE', [settings.primaryPageId])).has(settings.primaryPageId) : false
  const primaryPage = ask.primaryPageId && ask.primaryPageId !== settings.primaryPageId ? await primaryPageCheck(account, ask.primaryPageId) : null
  // Only a two-factor rule that would hold people to it needs the people (who has two-factor on).
  let people: SettingsLive['people'] = null
  if (ask.twoFactorType && ask.twoFactorType !== 'none' && ask.twoFactorType !== settings.twoFactorType) {
    try {
      const read = await readPortfolioPeople(account, MAX_ROWS)
      people = { people: read.people, more: read.more, missing: read.missing }
    } catch (err) {
      if (!(err instanceof MetaReadError) && !(err instanceof MetaLiveRefusal)) throw err
      people = null
    }
  }
  return done(settingsGuide(ask, { settings, currentPageTaken, people, primaryPage, readAt }))
}

/** The portfolio's name for the steps; a refused read leaves it out (the steps name the portfolio by its id). */
export async function portfolioName(account: MetaChosenAccount): Promise<string | null> {
  try { return (await readBusinessSettings(account, 'admin.settings')).name } catch (err) {
    if (err instanceof MetaReadError) return null
    throw err
  }
}

/**
 * set-meta-business-people — BM-032…BM-035. Review S6: each action reads only what it needs — invite the pending
 * invitations (a refusal keeps the steps: "cannot tell") and the people count; change-role and remove the people; the
 * invitation actions the invitations.
 */
export async function businessPeopleAdmin(input: { connectionId?: string | null } & PeopleAsk): Promise<AdminGuide> {
  const { account, portfolioId } = await adminScope(input.connectionId)
  const readAt = new Date().toISOString()
  const name = await portfolioName(account)
  let people: PeopleLive['people'] = null
  let peopleCount: number | null = null
  let invitations: PeopleLive['invitations'] = null
  if (input.action === 'change-role' || input.action === 'remove') {
    const read = await readPortfolioPeople(account, MAX_ROWS)
    people = { people: read.people, totalCount: read.totalCount, more: read.more, missing: read.missing }
  }
  if (input.action === 'invite') {
    try { peopleCount = (await readPortfolioPeople(account, 1)).totalCount } catch (err) { if (!(err instanceof MetaReadError)) throw err }
    try {
      const read = await readInvitations(account, MAX_ROWS)
      invitations = { invitations: read.invitations, totalCount: read.totalCount, more: read.more, missing: read.missing }
    } catch (err) {
      if (!(err instanceof MetaReadError)) throw err
      invitations = { refused: err.message }
    }
  }
  if (input.action === 'change-invitation' || input.action === 'cancel-invitation') {
    const read = await readInvitations(account, MAX_ROWS)
    invitations = { invitations: read.invitations, totalCount: read.totalCount, more: read.more, missing: read.missing }
  }
  return done(peopleGuide(
    { action: input.action, personId: input.personId, invitationId: input.invitationId, role: input.role, financeRole: input.financeRole, since: input.since },
    { portfolioId, portfolioName: name, readAt, people, peopleCount, invitations },
  ))
}

/** create-meta-system-user — BM-037, BM-061. */
export async function systemUserAdmin(input: { connectionId?: string | null } & SystemUserAsk): Promise<AdminGuide> {
  const { account, portfolioId } = await adminScope(input.connectionId)
  const readAt = new Date().toISOString()
  const name = await portfolioName(account)
  let read: SystemUserLive['read']
  try {
    const list = await readSystemUsers(account, MAX_ROWS)
    read = { systemUsers: list.systemUsers, totalCount: list.totalCount, more: list.more, missing: list.missing }
  } catch (err) {
    // Step 4's read turns Meta's permission refusal into its sentence (an Employee system user may not list them).
    if (!(err instanceof MetaLiveRefusal)) throw err
    read = { refused: err.message }
  }
  let tier: string | null = null
  let appsOwned: number | null = null
  if (input.action === 'create') {
    try { tier = (await liveAccessState(account)).tier } catch (err) { if (!(err instanceof MetaReadError)) throw err }
    try {
      const apps = await assetsView({ connectionId: account.connectionId, view: 'apps', list: 'owned', maxRows: MAX_ROWS }) as { lists: Array<{ items: unknown[]; more: boolean }> }
      const owned = apps.lists[0]
      appsOwned = !owned ? null : owned.items.length ? owned.items.length : owned.more ? null : 0
    } catch (err) {
      if (!(err instanceof MetaReadError) && !(err instanceof MetaLiveRefusal)) throw err
    }
  }
  return done(systemUserGuide(
    { action: input.action, name: input.name, role: input.role, systemUserId: input.systemUserId, since: input.since },
    { portfolioId, portfolioName: name, read, tier, appsOwned, readAt, nexusSystemUserKnown: !!account.connection.systemUser?.id },
  ))
}
