/**
 * Meta ads step 42 (2026-10-26) — the business portfolio's admin acts, by the Owner's decision D1 = A: the Owner (a person
 * with full control of the portfolio) makes them in Meta's own screens; Nexus shows the exact steps, how to put it back and
 * what to watch out for, from what Meta reads now, and reads the result when asked again. Nexus sends NOTHING to Meta here
 * (no admin token, no write, no approval: nothing changes, so there is nothing to approve).
 *
 *   set-meta-business-settings  the portfolio's name, primary Page, time zone, industry, two-factor rule — BM-030, BM-031
 *   set-meta-business-people    invite a person, change a person's role, remove a person, change or cancel an invitation —
 *                               BM-032, BM-033, BM-034, BM-035
 *   create-meta-system-user     make a system user; rename or remove one — BM-037, BM-061
 * The reads are step 4's (marketing/meta-ads/live-business.ts), reused through live-business-admin.ts; the guides are pure
 * (business-admin.ts).
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolResult } from '../tool-types.js'
import {
  BASE_ROLES, FINANCE_ROLES, META_BUSINESS_VERTICALS, META_TIMEZONE_ID_MAX, META_TWO_FACTOR_TYPES, PEOPLE_ACTIONS, SYSTEM_USER_ACTIONS,
  type BaseRole, type FinanceRole, type MetaBusinessVertical, type MetaTwoFactorType, type PeopleAction, type SystemUserAction,
} from '../../marketing/meta-ads/business-admin.js'
import { businessPeopleAdmin, businessSettingsAdmin, systemUserAdmin } from '../../marketing/meta-ads/live-business-admin.js'
import { META_NAME_TEXT } from '../../gateway/meta-write-text.js'
import { connectionArg, guarded, lower, metaIdArg } from './meta-ads-read.tools.js'

const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const opt = <T>(v: unknown): T | undefined => (v === undefined || v === null ? undefined : v as T)
const nameArg = (what: string) => z.string().trim().min(1).max(200).regex(META_NAME_TEXT, 'plain text only (no control characters)').optional().describe(what)
const sinceArg = (what: string) => z.string().trim().datetime({ offset: true }).optional().describe(what)

/** The line every description ends with (D1, in plain words). */
const D1_TOOL_LINE = 'Nexus changes NOTHING and sends nothing to Meta with this tool (Owner decision D1: the business portfolio\'s admin acts stay in the hands of a person with full access to it, who makes them in Meta\'s own screens). It reads Meta now — only the business portfolio of the business\'s chosen ad account, and nothing at all when another business in Nexus uses that portfolio — and answers what is asked from → to, the exact steps in Meta Business settings, how to put it back (or plainly that Meta cannot) and what to watch out for; asked again with the same arguments, it reads the result and says what is done (state). Never an e-mail address, an invitation link or a token.'

// ── set-meta-business-settings ──────────────────────────────────────────────────────────────────────────────────────

const setMetaBusinessSettings: AgentTool = {
  name: 'set-meta-business-settings',
  title: 'Meta business settings (Owner steps)',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  input: z.object({
    name: nameArg('the business portfolio\'s new name (Meta shows it across Meta: the business\'s public name, no special characters)'),
    primaryPageId: metaIdArg('a Page this portfolio owns, to be its primary Page (meta-business-assets view pages lists the owned ones)'),
    timezoneId: z.number().int().min(0).max(META_TIMEZONE_ID_MAX).optional().describe(`the portfolio's time zone, as Meta's own time zone id (0…${META_TIMEZONE_ID_MAX}; meta-business shows the one it reads now)`),
    vertical: z.preprocess(upper, z.enum(META_BUSINESS_VERTICALS)).optional().describe(`the industry, as Meta names it (${META_BUSINESS_VERTICALS.join(', ')})`),
    twoFactorType: z.preprocess(lower, z.enum(META_TWO_FACTOR_TYPES)).optional()
      .describe('who must use two-factor authentication: none (Meta\'s screens: No one) | admin_required (Admins only) | all_required (Everyone)'),
    connectionId: connectionArg,
  }),
  description:
    'The business portfolio\'s settings — its name, primary Page, time zone, industry and two-factor rule — as the Owner '
    + 'changes them in Meta Business settings › Business portfolio info. Name what to change (at least one). The answer: '
    + 'each setting now → asked (done or not), the Owner\'s steps, the old values to put back, and warnings: who a stricter '
    + 'two-factor rule holds to it at once (people Meta does not read as having two-factor on), that Meta requires two-factor '
    + 'for some portfolios over 90 days old (it may not be loosened again), that only a Page the portfolio owns can be its '
    + 'primary Page (refused otherwise, and a Page another business in Nexus uses is never offered). Nexus found no place in '
    + 'Meta\'s help for a portfolio\'s own time zone or industry: the steps say so. The legal name, address, phone and website '
    + 'are Meta Business settings only (no API field). ' + D1_TOOL_LINE,
  async handler(args): Promise<ToolResult> {
    return guarded(() => businessSettingsAdmin({
      connectionId: str(args.connectionId), name: opt<string>(args.name), primaryPageId: opt<string>(args.primaryPageId), timezoneId: opt<number>(args.timezoneId),
      vertical: opt<MetaBusinessVertical>(args.vertical), twoFactorType: opt<MetaTwoFactorType>(args.twoFactorType),
    }))
  },
}

// ── set-meta-business-people ────────────────────────────────────────────────────────────────────────────────────────

const setMetaBusinessPeople: AgentTool = {
  name: 'set-meta-business-people',
  title: 'Meta business people (Owner steps)',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  input: z.object({
    action: z.preprocess(lower, z.enum(PEOPLE_ACTIONS)).describe('invite | change-role | remove | change-invitation | cancel-invitation'),
    personId: metaIdArg('change-role, remove: a person of the portfolio (meta-business-people view people lists them)'),
    invitationId: metaIdArg('change-invitation, cancel-invitation: a pending invitation (meta-business-people view invitations lists them)'),
    role: z.preprocess(lower, z.enum(BASE_ROLES)).optional()
      .describe('invite (required), change-role, change-invitation: admin (Meta\'s screens: Full access to the portfolio) | employee (Basic access, Meta\'s default: works only on what is assigned)'),
    financeRole: z.preprocess(lower, z.enum(FINANCE_ROLES)).optional().describe('invite, change-role, change-invitation: editor (finance access to manage) | analyst (finance access to view) | none'),
    since: sinceArg('asked again after the Owner acted: the readAt of the first answer — invite: an invitation made since is the result; remove, cancel-invitation: a person or invitation Meta no longer lists is the result (without since, an id Nexus cannot find is refused)'),
    connectionId: connectionArg,
  }),
  description:
    'The people of the business portfolio, as the Owner changes them in Meta Business settings › Users › People. action '
    + 'invite (role, financeRole; Nexus takes no e-mail address: the Owner types it in Meta\'s screen; asked again with since = '
    + 'the first answer\'s readAt, Nexus finds the invitation by its role and time), change-role (personId; role and/or '
    + 'financeRole), remove (personId), change-invitation (invitationId; role and/or financeRole — Nexus found no such step in '
    + 'Meta\'s help: if Meta does not offer it, cancel and invite again), cancel-invitation (invitationId). Refused: taking the '
    + 'role of, or removing, the portfolio\'s only admin (Meta keeps one: 3914; a role Meta reads in words Nexus does not know '
    + 'counts as admin), and a person or invitation Nexus cannot find (it reads at most 500; asked again with since after a '
    + 'removal or a cancel, absence is the result). Each action reads only what it needs. Putting it back: a role change '
    + 'yes; a removal or a cancelled invitation only by a new invitation the person accepts (their assets are given again); '
    + 'an e-mail Meta sent stays sent. Tasks on the chosen ad account, Page or Instagram account: set-meta-user-access. '
    + D1_TOOL_LINE,
  async handler(args): Promise<ToolResult> {
    return guarded(() => businessPeopleAdmin({
      connectionId: str(args.connectionId), action: args.action as PeopleAction, personId: opt<string>(args.personId), invitationId: opt<string>(args.invitationId),
      role: opt<BaseRole>(args.role), financeRole: opt<FinanceRole>(args.financeRole), since: opt<string>(args.since),
    }))
  },
}

// ── create-meta-system-user ─────────────────────────────────────────────────────────────────────────────────────────

const createMetaSystemUser: AgentTool = {
  name: 'create-meta-system-user',
  title: 'Meta system users (Owner steps)',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  input: z.object({
    action: z.preprocess(lower, z.enum(SYSTEM_USER_ACTIONS)).default('create').describe('create (default) | rename | remove'),
    name: nameArg('create: the new system user\'s name; rename: its new name'),
    role: z.preprocess(lower, z.enum(BASE_ROLES)).optional().describe('create: employee (default: reaches only what is assigned) | admin (reaches every asset; Meta allows one)'),
    systemUserId: metaIdArg('rename, remove: a system user of the portfolio (meta-business-people view system-users lists them)'),
    since: sinceArg('asked again after the Owner acted: the readAt of the first answer — create: a system user made since is the result; remove: one Meta no longer lists is the result (without since, an id Nexus cannot find is refused)'),
    connectionId: connectionArg,
  }),
  description:
    'The business portfolio\'s system users (machine logins), as the Owner makes them in Meta Business settings › Users › '
    + 'System users. action create (name, role): Meta\'s limits from the live list and the app\'s access tier (Limited: 1 '
    + 'system user and 1 admin system user; Full: 10 and 1), the app the portfolio must own (104001); no way back by Meta\'s '
    + 'API ("You cannot delete a system user or admin system user, but you can invalidate all access tokens"). rename '
    + '(systemUserId, name): put back by renaming to the exact old name. remove (systemUserId): only if Meta\'s screens offer '
    + 'it, else its tokens are revoked and its assets taken off; refused for the system user Nexus works as (it would cut '
    + 'Nexus off) and when the connection names none; Nexus can tell only its own, so the answer warns that another business '
    + 'in Nexus may connect with the one named. Meta lists system users only to an admin token: when Nexus\'s system user is an Employee, the answer says it '
    + 'cannot read them (create still gives the steps). Meta documents no role change of a system user. A system user\'s token '
    + 'is never pasted into a chat. ' + D1_TOOL_LINE,
  async handler(args): Promise<ToolResult> {
    return guarded(() => systemUserAdmin({
      connectionId: str(args.connectionId), action: (args.action ?? 'create') as SystemUserAction, name: opt<string>(args.name),
      role: opt<BaseRole>(args.role), systemUserId: opt<string>(args.systemUserId), since: opt<string>(args.since),
    }))
  },
}

export const META_ADS_BUSINESS_ADMIN_TOOLS: AgentTool[] = [setMetaBusinessSettings, setMetaBusinessPeople, createMetaSystemUser]
