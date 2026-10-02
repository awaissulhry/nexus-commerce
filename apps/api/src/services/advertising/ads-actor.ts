import type { AdsActor } from './ads-mutation.service.js'

/**
 * R2 (MCP full control, part 06 gap 11) — the one rule for the actor an ads write carries.
 *
 * `user:<id>` is a person, `automation:<engine or rule id>` a machine; every reader (the change feed's `parseActor`,
 * a rule's daily write cap, the rule list's "wrote" column, the Control Room's engine evidence) matches that string
 * exactly. Callers hand writers either shape, or a bare engine name, or nothing. Each writer used to prefix on its
 * own, and three of them prefixed `automation:` AGAIN onto an actor that already had it — auto-bid, a
 * `bid_to_target_acos` rule, an autopilot plan and a `retail_guard` rule all wrote `automation:automation:<x>`, which
 * no reader matched.
 *
 *   a person or a machine → unchanged
 *   a bare engine name    → `automation:<name>`, once
 *   nothing               → `automation:<engine>`, the writer's own name
 */
export function adsActorOf(actor: string | null | undefined, engine: string): AdsActor {
  if (!actor) return `automation:${engine}`
  if (actor.startsWith('user:') || actor.startsWith('automation:')) return actor as AdsActor
  return `automation:${actor}`
}
