/**
 * Meta step 33 (lane C3, 2026-10-21; Owner decision D2) — the business's switch "Send sales to Meta (Conversions API)":
 * OFF by default, turned on by a person in Nexus (Settings › Channels › Meta), never by Claude. Like "Claude's changes need
 * no approval" (AgentAutonomy.claudeNoApprovalAt), it is a time and a name on the business's own settings row
 * (AccountSettings.metaConversionsApiOnAt / OnBy, row-level security per business): no row, or null, is off.
 *
 * On, it lets upload-meta-events ASK to send purchases (only sales taken in by hand in Nexus: change-events.ts). Every send
 * is still a change: a person approves it in Nexus — or, with the business's "Claude's changes need no approval" switch on
 * (#691), it runs 20 s after Claude asks, in the asker's name, unless someone stops it. Off stops it: the tool refuses, and
 * the gateway refuses any events call too (events-rule.ts), even one approved earlier. Its history row (key
 * meta-conversions-api) is never reverted from Settings › History (review F7).
 */
import { workspaceIdForQuery } from '@nexus/database/workspace-context'
import prisma from '../../../db.js'
import { writeSettingsAudit } from '../../../utils/settings-audit.js'

export interface MetaEventsSwitch { on: boolean; since: string | null; by: string | null }

/** The sentence every refusal of a switched-off business says. */
export const META_EVENTS_OFF = 'Sending sales to Meta (Conversions API) is switched off for this business. A person turns it on in Nexus (Settings › Channels › Meta, "Send sales to Meta"); Claude cannot.'

/** This business's switch (off when it has no settings row yet). */
export async function metaEventsSwitch(): Promise<MetaEventsSwitch> {
  const row = await prisma.accountSettings.findFirst({ select: { metaConversionsApiOnAt: true, metaConversionsApiOnBy: true } })
  return { on: !!row?.metaConversionsApiOnAt, since: row?.metaConversionsApiOnAt?.toISOString() ?? null, by: row?.metaConversionsApiOnAt ? row.metaConversionsApiOnBy ?? null : null }
}

/**
 * A person turns the switch on or off (the route checks who may). The same value again changes nothing and records
 * nothing; a change is kept in the settings history (who, when, from → to).
 */
export async function setMetaEventsSwitch(on: boolean, actor: { label: string }): Promise<{ switch: MetaEventsSwitch; changed: boolean }> {
  const now = await metaEventsSwitch()
  if (now.on === on) return { switch: now, changed: false }
  const data = { metaConversionsApiOnAt: on ? new Date() : null, metaConversionsApiOnBy: on ? actor.label.slice(0, 200) : null }
  const workspaceId = workspaceIdForQuery()
  await prisma.accountSettings.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data })
  await writeSettingsAudit({ key: 'meta-conversions-api', action: 'update', before: { metaConversionsApi: now.on }, after: { metaConversionsApi: on } })
  return { switch: await metaEventsSwitch(), changed: true }
}
