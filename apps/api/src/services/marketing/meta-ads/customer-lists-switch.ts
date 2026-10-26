/**
 * Meta consent PR 2 (2026-10-26; Owner decision D8, follow-up (a) of the Meta ads build) — the business's switch "Upload
 * customer lists to Meta": OFF by default, turned on by a person in Nexus (Settings › Channels › Meta), never by Claude. A
 * copy of step 33's "Send sales to Meta" (events-switch.ts): a time and a name on the business's own settings row
 * (AccountSettings.metaCustomerListsOnAt / OnBy, row-level security per business); no row, or null, is off.
 *
 * On, it lets set-meta-audience-members ASK to add or replace the people of a customer list with the hashed e-mails of
 * the business's Shopify buyers who said yes to its e-mail marketing (audience-members.ts consentedPeople). Every upload
 * is still a change: a person approves it in Nexus — or, with the business's "Claude's changes need no approval" switch on
 * (#691), it runs about 20 s after Claude asks, in the asker's name, unless someone stops it; so this switch is the real
 * gate. Off stops it: the tool refuses, and the gateway refuses every add or replace of people too (gateway.ts), even one
 * approved earlier. Taking people out never needs it. Its history row (key meta-customer-lists) is never reverted from
 * Settings › History.
 */
import { workspaceIdForQuery } from '@nexus/database/workspace-context'
import prisma from '../../../db.js'
import { writeSettingsAudit } from '../../../utils/settings-audit.js'

export interface MetaCustomerListsSwitch { on: boolean; since: string | null; by: string | null }

/** This business's switch (off when it has no settings row yet). */
export async function metaCustomerListsSwitch(): Promise<MetaCustomerListsSwitch> {
  const row = await prisma.accountSettings.findFirst({ select: { metaCustomerListsOnAt: true, metaCustomerListsOnBy: true } })
  return { on: !!row?.metaCustomerListsOnAt, since: row?.metaCustomerListsOnAt?.toISOString() ?? null, by: row?.metaCustomerListsOnAt ? row.metaCustomerListsOnBy ?? null : null }
}

/**
 * A person turns the switch on or off (the route checks who may). The same value again changes nothing and records
 * nothing; a change is kept in the settings history (who, when, from → to).
 */
export async function setMetaCustomerListsSwitch(on: boolean, actor: { label: string }): Promise<{ switch: MetaCustomerListsSwitch; changed: boolean }> {
  const now = await metaCustomerListsSwitch()
  if (now.on === on) return { switch: now, changed: false }
  const data = { metaCustomerListsOnAt: on ? new Date() : null, metaCustomerListsOnBy: on ? actor.label.slice(0, 200) : null }
  const workspaceId = workspaceIdForQuery()
  await prisma.accountSettings.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data })
  await writeSettingsAudit({ key: 'meta-customer-lists', action: 'update', before: { metaCustomerLists: now.on }, after: { metaCustomerLists: on } })
  return { switch: await metaCustomerListsSwitch(), changed: true }
}
