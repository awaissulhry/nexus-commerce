import type { StudioPublishChange, StudioPublishValue } from '@nexus/shared/studio-publication'

export interface PublicationChangeInput {
  productId: string
  sku: string
  field: string
  label: string
  current: StudioPublishValue
  lastAccepted: StudioPublishValue
  channel: StudioPublishValue
  newListing?: boolean
  refusal?: string
  /** Provider-specific equality from the existing drift comparators; raw sent values remain intact. */
  currentMatchesChannel?: boolean
  acceptedMatchesChannel?: boolean
}

export const publicationChangeId = (productId: string, field: string): string => JSON.stringify([productId, field])

// Exact accepted-payload equality, not the provider's normalized content-drift comparison.
const canonical = (value: unknown) => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry)
const equal = (left: StudioPublishValue, right: StudioPublishValue): boolean | null => {
  if (left.state === 'unknown' || right.state === 'unknown') return null
  if (left.state !== right.state) return false
  return left.state === 'absent' || right.state === 'absent' || canonical(left.value) === canonical(right.value)
}
const changed = (value: StudioPublishValue, baseline: StudioPublishValue): boolean | null => {
  const same = equal(value, baseline)
  return same === null ? null : !same
}
const providerEqual = (left: StudioPublishValue, right: StudioPublishValue, verdict?: boolean) =>
  left.state === 'value' && right.state === 'value' && verdict !== undefined ? verdict : equal(left, right)

/** A pure review plan. Its defaults never authorize overwriting a divergent or unknown channel value. */
export function planPublicationChanges(inputs: PublicationChangeInput[]): StudioPublishChange[] {
  const ids = inputs.map(input => publicationChangeId(input.productId, input.field))
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate product/field coordinates make the publication review ambiguous.')
  return inputs.map((input, index) => {
    const { productId, sku, field, label, current, lastAccepted, channel } = input
    const localChanged = changed(current, lastAccepted)
    const sameAsAccepted = providerEqual(lastAccepted, channel, input.acceptedMatchesChannel)
    const channelChanged = sameAsAccepted === null ? null : !sameAsAccepted
    let status: StudioPublishChange['status'], reason: string
    let selectable = false, selectedByDefault = false
    if (current.state === 'unknown') {
      status = 'CANNOT_COMPARE'; reason = `Nexus could not prepare this field: ${current.reason}`
    } else if (input.newListing) {
      status = 'SEND'; selectable = selectedByDefault = true; reason = 'Include this prepared field when creating the new listing.'
    } else if (providerEqual(current, channel, input.currentMatchesChannel) === true) {
      status = 'SAME'; reason = 'This value already matches the channel; nothing will be sent.'
    } else if (lastAccepted.state === 'unknown') {
      status = channel.state === 'unknown' ? 'CANNOT_COMPARE' : 'DIFFERS'
      selectable = channel.state !== 'unknown'
      reason = channel.state === 'unknown' ? `No accepted publish record, and the channel could not be compared: ${channel.reason}`
        : 'No accepted publish record. Choose whether to replace the differing channel value.'
    } else if (channel.state === 'unknown') {
      status = 'CANNOT_COMPARE'; selectable = localChanged === true
      reason = `The channel could not be compared: ${channel.reason}`
    } else if (channelChanged) {
      status = 'DIFFERS'; selectable = true; reason = 'The channel differs from the last accepted publish. Choose whether to replace its value.'
    } else if (localChanged === true) {
      status = 'SEND'; selectable = selectedByDefault = true; reason = 'Nexus changed since the last accepted publish; the channel still matches that record.'
    } else {
      status = 'SAME'; reason = 'Nexus has not changed and the channel matches the accepted value; nothing will be sent.'
    }
    if (input.refusal !== undefined) { selectable = selectedByDefault = false; reason = input.refusal }
    return { id: ids[index], productId, sku, field, label, current, lastAccepted, channel, status, localChanged, channelChanged,
      selectable, selectedByDefault, reason, operation: current.state === 'unknown' ? null : current.state === 'absent' ? 'delete' : 'replace' }
  })
}

/** IDs are exact and case-sensitive; the provider plan retains the reviewed field order. */
export function selectPublicationChanges(changes: StudioPublishChange[], selectedIds: string[]): StudioPublishChange[] {
  const selected = new Set(selectedIds)
  if (selected.size !== selectedIds.length) throw new Error('A publication field was selected more than once.')
  const byId = new Map(changes.map(change => [change.id, change]))
  if (byId.size !== changes.length) throw new Error('Duplicate publication field IDs make this review ambiguous.')
  for (const id of selected) {
    const change = byId.get(id)
    if (!change) throw new Error('A selected field does not belong to this publication review.')
    if (!change.selectable) throw new Error(`The reviewed field ${change.label} cannot be selected: ${change.reason}`)
  }
  return changes.filter(change => selected.has(change.id))
}
