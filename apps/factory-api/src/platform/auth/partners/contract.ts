import { z } from 'zod'
import { CAPABILITIES, PARTNER_KINDS } from '@nexus/factory-domain/auth/partners/kinds'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { LOCALES } from '@nexus/factory-domain/email/rules'
import { notMoney } from '@nexus/factory-domain/money/marked'

/**
 * Partner organisations, their people and roles (B-W2b-162). Office: a party's Portal access and the organisations list;
 * portal: the colleagues of the signed-in partner and "My access". No money anywhere: whether a role sees prices is a
 * yes/no from its template.
 */

const STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const
const capability = z.enum(CAPABILITIES)
const kind = z.enum(PARTNER_KINDS)
const roleKey = z.string().trim().regex(/^[a-z][a-z0-9_-]{1,60}$/)

const roleView = output({
  key: z.string(),
  kind: kind,
  name: z.string(),
  description: z.string(),
  /** The role sees prices (Buyer, Finance, Admin of a customer; the adviser's exports): a yes/no, never an amount. */
  seesPrices: notMoney(z.boolean()),
  /** The kind's admin: manages the organisation's colleagues. */
  admin: z.boolean(),
  /** What its holder may also do (COL-062): at most, and given by default. */
  capabilities: output({ allowed: z.array(capability), byDefault: z.array(capability) }),
  /** The organisation's portal offers it (its allowed roles; none listed: every role of the kind). */
  offered: z.boolean(),
})

const personView = output({
  id: id(),
  displayName: z.string(),
  email: z.string(),
  kind: kind.nullable(),
  status: z.enum(STATUSES),
  roleKey: z.string().nullable(),
  roleName: z.string().nullable(),
  seesPrices: notMoney(z.boolean()),
  admin: z.boolean(),
  capabilities: z.array(capability),
  /** The end of access (PLT-022); null: none. */
  accessUntil: instant().nullable(),
  /** The end of access is within 7 days ("access ends soon"). */
  accessEndsSoon: z.boolean(),
  lastSignInAt: instant().nullable(),
  /** An invited person's open invitation (null: none, or not invited). */
  invitation: output({ id: id(), expiresAt: instant() }).nullable(),
  version: z.number().int(),
})

const settingsView = output({
  portalOn: z.boolean(),
  /** Owner answer C1: production progress in this customer's portal (OFF by default; only for a customer or a brand). */
  progressShared: z.boolean(),
  maxUsers: z.number().int().nullable(),
  allowedRoleKeys: z.array(z.string()),
  /** 0: no settings row yet (everything off). */
  version: z.number().int(),
})

const partyView = output({ id: id(), code: z.string(), name: z.string(), roles: z.array(z.string()), status: z.string(), companyId: id().nullable() })

const partyParams = input({ partyId: id() })
const personParams = input({ partyId: id(), userId: id() })

export const organisationsContract = defineContract({
  response: {
    200: output({
      organisations: z.array(
        output({
          party: partyView,
          kinds: z.array(kind),
          portalOn: z.boolean(),
          progressShared: z.boolean(),
          maxUsers: z.number().int().nullable(),
          people: output({ active: z.number().int(), invited: z.number().int(), suspended: z.number().int() }),
          accessEndingSoon: z.number().int(),
        }),
      ),
      /** The audience line's "Partners (n)" and the "access ends soon" tile of Admin › Users. */
      counts: output({ organisations: z.number().int(), people: z.number().int(), accessEndingSoon: z.number().int() }),
    }),
  },
})

export const portalAccessContract = defineContract({
  params: partyParams,
  response: {
    200: output({
      party: partyView,
      kinds: z.array(kind),
      settings: settingsView,
      seats: output({ taken: z.number().int(), max: z.number().int().nullable() }),
      roles: z.array(roleView),
      people: z.array(personView),
      /** The portal terms of the party's company are published (GATE-PRIVACY: no invitation before). Null: a party of every company. */
      termsInForce: z.boolean().nullable(),
    }),
  },
})

export const settingsContract = defineContract({
  params: partyParams,
  body: input({
    portalOn: z.boolean().optional(),
    progressShared: z.boolean().optional(),
    maxUsers: z.number().int().min(1).max(1000).nullable().optional(),
    allowedRoleKeys: z.array(roleKey).max(50).optional(),
    /** The version read (0: no row yet). */
    version: z.number().int().min(0),
  }),
  response: { 200: output({ settings: settingsView, seats: output({ taken: z.number().int(), max: z.number().int().nullable() }) }) },
})

const accessUntil = instant().nullable()
const choice = {
  roleKey,
  /** What the person may also do; left out: the role's defaults. */
  capabilities: z.array(capability).max(3).optional(),
}

const invited = output({
  invitation: output({ id: id(), userId: id(), email: z.string(), expiresAt: instant(), roleKeys: z.array(z.string()), accessUntil: instant().nullable() }),
  /** `already_sent`: a repeated Idempotency-Key, answered from its receipt (no second mail). */
  delivery: z.enum(['sent', 'already_sent']),
})

export const inviteContract = defineContract({
  params: partyParams,
  body: input({
    email: z.string().trim().min(3).max(320),
    displayName: z.string().trim().min(1).max(120),
    locale: z.enum(LOCALES).optional(),
    /** Which portal; left out: the only one the organisation's roles give. */
    kind: kind.optional(),
    ...choice,
    accessUntil: accessUntil.optional(),
    /** The company whose portal it is; left out: the organisation's company (or the screen's, for one of every company). */
    companyId: id().optional(),
  }),
  response: { 200: invited },
})

export const resendContract = defineContract({
  params: personParams,
  body: input({ companyId: id().optional() }),
  response: { 200: invited },
})

const changed = output({ id: id(), status: z.enum(STATUSES), version: z.number().int() })

export const revokeContract = defineContract({ params: personParams, body: input({ version: z.number().int().min(1) }), response: { 200: changed } })

export const changeContract = defineContract({
  params: personParams,
  body: input({
    roleKey: roleKey.optional(),
    capabilities: z.array(capability).max(3).optional(),
    /** null: no end (not for an adviser). */
    accessUntil: accessUntil.optional(),
    version: z.number().int().min(1),
  }),
  response: { 200: output({ id: id(), roleKeys: z.array(z.string()), accessUntil: instant().nullable() }) },
})

export const statusContract = defineContract({
  params: personParams,
  body: input({ version: z.number().int().min(1), reason: z.string().trim().min(1).max(500).optional() }),
  response: { 200: changed.extend({ sessionsEnded: z.number().int() }) },
})

export const previewContract = defineContract({
  params: partyParams,
  body: input({ companyId: id().optional() }),
  response: {
    200: output({
      /** The CSRF double-submit token of the browser (kept). */
      csrfToken: z.string(),
      party: output({ id: id(), name: z.string() }),
      company: output({ id: id(), code: z.string(), name: z.string() }),
      /** The preview ends then at the latest (an hour). */
      expiresAt: instant(),
    }),
  },
})

// --- the portal's own (the signed-in partner) ----------------------------------------------------------------------------

const colleagueView = output({
  id: id(),
  displayName: z.string(),
  /** Only for the organisation's admins (names and roles for everyone else). */
  email: z.string().nullable(),
  status: z.enum(STATUSES),
  roleKey: z.string().nullable(),
  roleName: z.string().nullable(),
  seesPrices: notMoney(z.boolean()),
  admin: z.boolean(),
  capabilities: z.array(capability),
  lastSignInAt: instant().nullable(),
  invitationExpiresAt: instant().nullable(),
  version: z.number().int(),
})

const adminView = output({ id: id(), displayName: z.string(), email: z.string() })

export const colleaguesContract = defineContract({
  response: {
    200: output({
      me: id(),
      /** The person may invite, change roles and deactivate (the kind's Admin; step-up first). */
      canManage: z.boolean(),
      /** "Your admin is …". */
      admins: z.array(adminView),
      people: z.array(colleagueView),
      /** For an admin: the roles the organisation's portal offers, and the seats. */
      roles: z.array(roleView),
      seats: output({ taken: z.number().int(), max: z.number().int().nullable() }).nullable(),
    }),
  },
})

export const myAccessContract = defineContract({
  response: {
    200: output({
      kind: kind.nullable(),
      role: output({ key: z.string(), name: z.string(), description: z.string(), seesPrices: notMoney(z.boolean()), admin: z.boolean() }).nullable(),
      capabilities: z.array(capability),
      /** What the session may do now, in words (nothing before the first visit). */
      allows: z.array(output({ permission: z.string(), description: z.string() })),
      accessUntil: instant().nullable(),
      accessEndsSoon: z.boolean(),
      admins: z.array(adminView),
      preview: z.boolean(),
    }),
  },
})

export const colleagueInviteContract = defineContract({
  body: input({ email: z.string().trim().min(3).max(320), displayName: z.string().trim().min(1).max(120), locale: z.enum(LOCALES).optional(), ...choice }),
  response: { 200: invited },
})

export const colleagueChangeContract = defineContract({
  params: input({ userId: id() }),
  body: input({ roleKey: roleKey.optional(), capabilities: z.array(capability).max(3).optional(), version: z.number().int().min(1) }),
  response: { 200: output({ id: id(), roleKeys: z.array(z.string()), accessUntil: instant().nullable() }) },
})

export const colleagueDeactivateContract = defineContract({
  params: input({ userId: id() }),
  body: input({ version: z.number().int().min(1) }),
  response: { 200: changed.extend({ sessionsEnded: z.number().int() }) },
})

export type InviteBody = z.infer<typeof inviteContract.body>
export type SettingsBody = z.infer<typeof settingsContract.body>
export type ChangeBody = z.infer<typeof changeContract.body>
export type StatusBody = z.infer<typeof statusContract.body>
export type ColleagueInviteBody = z.infer<typeof colleagueInviteContract.body>
export type ColleagueChangeBody = z.infer<typeof colleagueChangeContract.body>
