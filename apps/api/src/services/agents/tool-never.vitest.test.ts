/**
 * MCP full control P1 — what is never for Claude (plan section 09 §2), held for every registered tool.
 *
 *   · no CHANGE tool may need a "never" permission: sign-in, people, roles, sessions, security, keys, webhooks,
 *     privacy, integrations, connecting or disconnecting channels and ads, admin repair / purge / restore, jobs;
 *   · NO tool at all — not even a read — may need the four settings.{security,apikeys,webhooks,privacy}.manage.
 *
 * A tool that needs one of these would hand Claude the safety system itself (its own access, secrets, a way to send
 * business data out) or something with no undo. Such a feature stays a person's click in Nexus.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { FEATURES as F, isValidPermission } from '@nexus/shared/permissions'
import { listTools } from './tool-registry.js'
import type { AgentTool } from './tool-types.js'

/** 09 §2: a change tool never requires one of these. */
export const NEVER_FOR_CHANGES = [
  F.usersManage,
  F.rolesManage,
  F.invitationsManage,
  F.sessionsManage,
  F.settingsSecurityManage,
  F.settingsApikeysManage,
  F.settingsWebhooksManage,
  F.settingsPrivacyManage,
  F.settingsIntegrationsManage,
  F.channelsConnect,
  F.channelsDisconnect,
  F.adsConnect,
  F.adminRepair,
  F.adminPurge,
  F.adminRestore,
  F.jobsManage,
] as const

/**
 * The Owner's narrow exceptions (2026-10-15, "Allow them for Google Ads"; 2026-10-20, "yes 1" for Meta; 2026-10-26, option 1
 * for Meta step 41): these change tools may need exactly these "never" permissions — who may use the business's Google Ads
 * account, its links to Merchant Center and YouTube, which Meta ad account, Page and Instagram account the business uses,
 * and who (people, partner portfolios, a dataset's server-event businesses) may use its Meta ad account, Page, Instagram
 * account and datasets. Each must always wait for a person's approval in Nexus (alwaysAsk, ask at most, never by rule).
 * Nothing else.
 */
export const NEVER_EXCEPTIONS: Readonly<Record<string, readonly string[]>> = {
  'set-google-user-access': [F.usersManage, F.adsConnect],
  'set-google-account-links': [F.adsConnect],
  // Owner 2026-10-20 "yes 1", like #653: Claude asks to choose the business's Meta ad account, Page and Instagram account
  // (never a secret or a token, never a renewal or a revoke). ads.connect only — NOT settings.integrations.manage.
  'set-meta-connection': [F.adsConnect],
  // Owner 2026-10-26, option 1 (Meta step 41, review A-MF3): exactly as set-google-user-access — people and connections.
  'set-meta-user-access': [F.usersManage, F.adsConnect],
  'set-meta-partner-access': [F.usersManage, F.adsConnect],
}

/** 09 §2: no tool at all, read or change, requires one of these. */
export const NEVER_FOR_ANY = [F.settingsSecurityManage, F.settingsApikeysManage, F.settingsWebhooksManage, F.settingsPrivacyManage] as const

function neverProblems(tool: Pick<AgentTool, 'name' | 'readOnly' | 'requires'>): string[] {
  const problems: string[] = []
  for (const permission of tool.requires) {
    if ((NEVER_FOR_ANY as readonly string[]).includes(permission)) problems.push(`${tool.name} requires ${permission}: no tool may`)
    else if (!tool.readOnly && (NEVER_FOR_CHANGES as readonly string[]).includes(permission) && !NEVER_EXCEPTIONS[tool.name]?.includes(permission)) {
      problems.push(`${tool.name} changes something and requires ${permission}: never for Claude`)
    }
  }
  return problems
}

describe('P1 — never for Claude', () => {
  it('the lists name real permissions, exactly the ones section 09 §2 names', () => {
    expect([...NEVER_FOR_CHANGES].every(isValidPermission)).toBe(true)
    expect([...NEVER_FOR_CHANGES].sort()).toEqual([
      'admin.purge', 'admin.repair', 'admin.restore', 'ads.connect', 'channels.connect', 'channels.disconnect',
      'invitations.manage', 'jobs.manage', 'roles.manage', 'sessions.manage', 'settings.apikeys.manage',
      'settings.integrations.manage', 'settings.privacy.manage', 'settings.security.manage', 'settings.webhooks.manage',
      'users.manage',
    ])
    expect([...NEVER_FOR_ANY].sort()).toEqual([
      'settings.apikeys.manage', 'settings.privacy.manage', 'settings.security.manage', 'settings.webhooks.manage',
    ])
  })

  it('no registered tool breaks it', () => {
    expect(listTools().length).toBeGreaterThan(20)
    expect(listTools().flatMap(neverProblems)).toEqual([])
  })

  it('the Owner\'s Google Ads and Meta exceptions are exactly five tools, each a change a person always approves', () => {
    expect(Object.keys(NEVER_EXCEPTIONS).sort()).toEqual(['set-google-account-links', 'set-google-user-access', 'set-meta-connection', 'set-meta-partner-access', 'set-meta-user-access'])
    for (const name of Object.keys(NEVER_EXCEPTIONS)) {
      const tool = listTools().find((t) => t.name === name)
      expect(tool, name).toBeDefined()
      expect(tool).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', requiresApprovalDefault: true })
      // Never one of the four no-tool-at-all permissions.
      expect(NEVER_EXCEPTIONS[name].some((p) => (NEVER_FOR_ANY as readonly string[]).includes(p))).toBe(false)
    }
    // Another tool needing the same permission is still refused.
    expect(neverProblems({ name: 'probe-tool', readOnly: false, requires: [F.usersManage] } as unknown as AgentTool)).toHaveLength(1)
  })

  it('the check can fail: a change tool needing a never permission, and any tool needing a security one', () => {
    const tool = (readOnly: boolean, requires: string[]) =>
      ({ name: 'probe-tool', readOnly, requires, input: z.object({}) }) as unknown as AgentTool
    expect(neverProblems(tool(false, [F.productsEdit, F.usersManage]))).toEqual([
      'probe-tool changes something and requires users.manage: never for Claude',
    ])
    expect(neverProblems(tool(false, [F.jobsManage]))).toHaveLength(1)
    // A read of what the "never" areas hold may exist (team access, channel connections, read only) …
    expect(neverProblems(tool(true, [F.usersManage]))).toEqual([])
    // … but not one that needs the security, keys, webhooks or privacy permission, even to read.
    expect(neverProblems(tool(true, [F.settingsApikeysManage]))).toEqual(['probe-tool requires settings.apikeys.manage: no tool may'])
  })
})
