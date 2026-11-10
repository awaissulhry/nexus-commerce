import type { CheckResult, GateTarget } from '@nexus/factory-domain/compliance/gates/gate'
import { plugCheckSpec, type CheckSpec, type RequirementRow } from '@nexus/factory-domain/compliance/requirements/rules'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { Reader } from '../register-of-rules/common'
import type { GateStyle } from './facts'

/**
 * Checks a later step plugs into the one gate BY NAME (B-W2b-254; the hook for B-W2b-253's label rules `label.ceMarking`,
 * `label.classWarnings`, `label.gloveMarking`, `label.qrCode` — and any later `area.check` key). A requirement whose
 * checkKey names a plugged key is computed by the plug; until a key is plugged it is MANUAL (shown on the checklist,
 * never a refusal). A plugged key wins over a built-in one of the same name (253 computes `gpsr.contact` its own way).
 *
 *   plugGateCheck(['label.ceMarking', …], { kinds: ['LABEL'], market: false, who: 'COMPLIANCE', fix: 'labels' }, async (context) => {
 *     // read once for the question: context.db (the gate's reader — a command's transaction, or the tenant's system
 *     // client on the floor: every table is readable), context.style, context.labelTemplateId, context.subject, context.day
 *     // and every target (colourway, size, market) …
 *     return (requirement, key, target) => ({ state: 'PRESENT' | 'MISSING' | …, message, fix, facts, evidence })
 *   })
 *
 * Call it once when the plugging module loads (its routes.ts is loaded at boot by the app, as every module's), or add the
 * call to `GATE_PLUGS_LOADED` below at merge. `office` is true: the gate never reads with the floor role.
 */

export interface GateCheckContext {
  readonly db: Reader
  readonly style: GateStyle
  /** The label template the label checks read (a released work order's frozen one, else the style's released revision's). */
  readonly labelTemplateId: string | null
  readonly day: BusinessDate
  readonly targets: readonly GateTarget[]
  /** The record the gate stands before (null: the status board's style × market cell). */
  readonly subject: { readonly type: 'WorkOrder' | 'Shipment'; readonly id: string } | null
  /** Always true: the gate reads with an office or system client, never the floor role. */
  readonly office: true
}

export type GateCheck = (requirement: RequirementRow, key: string, target: GateTarget) => CheckResult
export type GateCheckPlug = (context: GateCheckContext) => Promise<GateCheck>

const PLUGS = new Map<string, GateCheckPlug>()

/** Plugs a check into the gate by name: its spec (kinds, market, who, fix) and its computation. */
export function plugGateCheck(keys: readonly string[], spec: CheckSpec, plug: GateCheckPlug): void {
  for (const key of keys) {
    plugCheckSpec(key, spec)
    PLUGS.set(key, plug)
  }
}

/** The plug of a key (null: none). */
export const gatePlugOf = (key: string): GateCheckPlug | null => PLUGS.get(key) ?? null

/** Test only: forget a plug. */
export function unplugGateCheck(key: string): void {
  PLUGS.delete(key)
}
