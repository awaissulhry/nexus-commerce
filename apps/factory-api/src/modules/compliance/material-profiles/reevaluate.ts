import { newId } from '@nexus/factory-domain/core/ids'
import type { FactoryDatabase } from '@nexus/factory-db'
import { callerFor, runCommand, type CommandCaller, type CommandTools } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { activeTenants, systemContext } from '../../../platform/outbox/system'
import { substancesGuarded, substancesSettings } from '../substances/common'
import { EVALUATE_LIMIT, writeProfilesInCommand } from '../substances/evaluation'
import { MATERIAL_SELECT } from '../substances/store'
import { PROFILE_RECORD_TYPE } from './facts'

/**
 * Evaluating the materials again (B-W2b-256; B-W2b-250's gap "nothing re-evaluates profiles automatically"). The evaluator
 * owns a profile's state (modules/compliance/substances/evaluation.ts writeProfilesInCommand); this file only says WHEN it
 * runs, through that one writer:
 *
 *   in the command   a declaration accepted or refused, a lab result recorded, a profile confirmed (`reevaluateInCommand`)
 *   on an event      a substance rule changed or switched, a substance added or changed (a group's members), a Candidate
 *                    List version added: every material that has a profile; W1's chromium VI result of a lot, a file on a
 *                    profile: that material (`reevaluateHandlers`, apps/factory-api/src/background.ts)
 *   every night      every material that has a profile (03:50 Europe/Rome): a declaration whose validity ended, a style that
 *                    now uses the material, a market switched on (`profilesNightlyCron`)
 *
 * A job runs as the system in batches of 100 materials, one command each (Idempotency-Key per event or night and batch).
 */

/** The materials (not finished garments) among these ids, evaluated again inside the caller's command. How many. */
export async function reevaluateInCommand(tools: Pick<CommandTools, 'tx' | 'now' | 'audit' | 'emit'>, itemIds: readonly string[], createdById: string | null): Promise<number> {
  const ids = [...new Set(itemIds)]
  if (ids.length === 0) return 0
  const materials = (await tools.tx.item.findMany({ where: { id: { in: ids } }, select: MATERIAL_SELECT })).filter((material) => material.kind !== 'FINISHED')
  for (let at = 0; at < materials.length; at += EVALUATE_LIMIT) await writeProfilesInCommand(tools, materials.slice(at, at + EVALUATE_LIMIT), createdById)
  return materials.length
}

/** Every material that has a profile, in id order. */
async function profiledMaterials(caller: CommandCaller): Promise<string[]> {
  return caller.withClient(async (client) => (await client.materialComplianceProfile.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map((row) => row.id))
}

/** Evaluates these materials again as the system, one command per batch of 100 (`key`: the Idempotency-Key's stem). How many. */
export async function reevaluateAsSystem(caller: CommandCaller, itemIds: readonly string[], key: string, causationId?: string): Promise<number> {
  const ids = [...new Set(itemIds)].sort()
  let done = 0
  for (let at = 0, batch = 0; at < ids.length; at += EVALUATE_LIMIT, batch += 1) {
    const slice = ids.slice(at, at + EVALUATE_LIMIT)
    const { result } = await substancesGuarded(() =>
      runCommand(
        caller,
        { name: 'compliance.materialProfiles.reevaluate', idempotencyKey: `${key}:${batch}`.slice(0, 200), input: { itemIds: slice }, ...(causationId ? { causationId } : {}) },
        async (tools) => {
          const count = await reevaluateInCommand(tools, slice, null)
          if (count === 0) tools.audit({ action: 'compliance.materialProfiles.reevaluate', recordType: 'MaterialComplianceProfile', recordId: slice[0]!, after: { skipped: true } })
          return count
        },
        substancesSettings(),
      ),
    )
    done += result
  }
  return done
}

/** The events that change what the evaluator says of every profiled material. */
const EVERY_PROFILE_EVENTS = ['compliance_substances.rule_changed', 'compliance_substances.substance_changed', 'compliance_substances.svhc_version_added'] as const

/** The worker's handlers (background.ts W2B_256_HANDLERS). */
export function reevaluateHandlers(): EventHandler[] {
  return [
    defineHandler({
      name: 'materialProfiles.reevaluateAll',
      events: [...EVERY_PROFILE_EVENTS],
      async handle(event, { caller }) {
        // A burst (the starter list, an import: one event per row) is evaluated once: a later run covers the others.
        const occurredAt = new Date(event.occurredAt)
        const stale = await caller.withClient((client) => client.materialComplianceProfile.count({ where: { OR: [{ evaluatedAt: null }, { evaluatedAt: { lt: occurredAt } }] } }))
        if (stale === 0) return
        await reevaluateAsSystem(caller, await profiledMaterials(caller), `profiles-again-${event.eventId}`, event.eventId)
      },
    }),
    defineHandler({
      name: 'materialProfiles.reevaluateOne',
      events: ['lot.test_recorded', 'file.available'],
      async handle(event, { caller }) {
        let itemId: string | null = null
        if (event.type === 'lot.test_recorded') {
          const { lotId } = event.payload as { lotId: string }
          itemId = (await caller.withClient((client) => client.lot.findUnique({ where: { id: lotId }, select: { itemId: true } })))?.itemId ?? null
        } else {
          const { recordType, recordId } = event.payload as { recordType: string; recordId: string }
          if (recordType === PROFILE_RECORD_TYPE) itemId = recordId
        }
        if (!itemId) return
        // Only a material that has a profile (a W1 lot of a material nobody profiled stays as it is).
        const profiled = await caller.withClient((client) => client.materialComplianceProfile.findUnique({ where: { id: itemId! }, select: { id: true } }))
        if (!profiled) return
        await reevaluateAsSystem(caller, [itemId], `profile-again-${event.eventId}`, event.eventId)
      },
    }),
  ]
}

export interface NightlyOptions {
  readonly database: FactoryDatabase
  readonly log: Log
}

/** One night over every active tenant (the cron's; tests call it). How many materials were evaluated. */
export async function reevaluateEveryProfile(options: NightlyOptions, now: Date = new Date()): Promise<number> {
  const night = now.toISOString().slice(0, 10)
  const requestId = `profiles-nightly-${newId()}`
  let done = 0
  for (const tenantId of await activeTenants(options.database)) {
    try {
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      done += await reevaluateAsSystem(caller, await profiledMaterials(caller), `profiles-nightly-${night}`)
    } catch (error) {
      options.log.error({ err: error, tenantId }, 'the material profiles of a tenant could not be evaluated again')
    }
  }
  if (done > 0) options.log.info({ materials: done }, 'material profiles evaluated again')
  return done
}

/** The scheduler's cron: every night at 03:50 (Europe/Rome). */
export function profilesNightlyCron(options: NightlyOptions): CronJob {
  return defineCron({
    name: 'compliance.profilesNightly',
    schedule: '50 3 * * *',
    lockTtlMs: 1_800_000,
    async run() {
      await reevaluateEveryProfile(options)
    },
  })
}
