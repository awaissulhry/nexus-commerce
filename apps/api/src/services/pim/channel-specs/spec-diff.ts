/**
 * P4 (docs/attributes/PLAN.md §4.2) — what changed between two versions of a channel's rules, for ANY channel.
 *
 * It compares the adapters' output (`ChannelSpec`), never the raw provider document, so eBay and Etsy get the same
 * change log Amazon has had since ALA Phase 5 (`schema-sync.service.ts` `detectAndLogChanges`), from the one reader
 * per channel. Pure.
 */
import type { ChannelFieldSpec, ChannelSpec } from './types.js'

export type SpecChangeType = 'FIELD_ADDED' | 'FIELD_REMOVED' | 'REQUIRED_CHANGED' | 'ENUM_REMOVED'

export interface SpecChange {
  changeType: SpecChangeType
  fieldId: string
  oldValue?: Record<string, unknown>
  newValue?: Record<string, unknown>
}

/** Change types that can move a product's readiness, so the affected families are rebuilt. */
export const READINESS_CHANGES: ReadonlySet<string> = new Set(['FIELD_REMOVED', 'REQUIRED_CHANGED', 'ENUM_REMOVED', 'FIELD_TYPE_CHANGED'])

const required = (field: ChannelFieldSpec) => field.requirement === 'required'
const strictOptions = (field: ChannelFieldSpec) => (field.mode === 'strict' && field.options?.length ? field.options : null)

export function diffChannelSpecs(before: ChannelSpec, after: ChannelSpec): SpecChange[] {
  const old = new Map(before.fields.map(field => [field.key, field]))
  const next = new Map(after.fields.map(field => [field.key, field]))
  const changes: SpecChange[] = []
  for (const [key, field] of next) {
    const previous = old.get(key)
    if (!previous) {
      changes.push({ changeType: 'FIELD_ADDED', fieldId: key, newValue: { requirement: field.requirement } })
      // A field that arrives required is a new requirement, so readiness must see it.
      if (required(field)) changes.push({ changeType: 'REQUIRED_CHANGED', fieldId: key, oldValue: { required: false }, newValue: { required: true } })
      continue
    }
    if (required(previous) !== required(field)) {
      changes.push({ changeType: 'REQUIRED_CHANGED', fieldId: key, oldValue: { required: required(previous) }, newValue: { required: required(field) } })
    }
    const before = strictOptions(previous)
    const now = strictOptions(field)
    if (before && now) {
      const removed = before.filter(option => !now.includes(option))
      if (removed.length) changes.push({ changeType: 'ENUM_REMOVED', fieldId: key, oldValue: { values: removed } })
    }
  }
  for (const key of old.keys()) if (!next.has(key)) changes.push({ changeType: 'FIELD_REMOVED', fieldId: key, oldValue: { requirement: old.get(key)!.requirement } })
  return changes
}
