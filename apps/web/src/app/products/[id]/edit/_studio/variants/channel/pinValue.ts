'use client'

/**
 * VP.4 — §4.3's pin and reset, through the EXISTING channel write path. No new endpoint.
 *
 * §4.3: *"Pinned writes go through the EXISTING channel write path (`resolveWriteRouting`,
 * `marketplaceContexts`) — no new write path for values."* That path is `commitChannelRow`
 * (`_studio/sheet/channel/useChannelSheet.ts`), which sends `PATCH /api/products/bulk`. This module
 * is the ADAPTER between a projection cell and that function's request shape, and nothing else.
 *
 * 🔴 **It derives no routing.** Every field of the write — `writeField`, `writeTarget`, `writeVerb`
 * and the version the CAS guards — comes from VP.2's `values[axisKey].write`, which is the server's
 * own `resolveWriteRouting` answer shipped to the client. `commitChannelRow`'s docblock states the
 * rule: *"The write target comes from the CELL, not from this client. Re-deriving it here is exactly
 * how a channel edit silently lands on the master record."* Measured on eBay·IT:
 * `{ field: 'attr_color', target: 'channelListing', verb: 'channel', version: 35 }`.
 *
 * 🔴 **`version` is the LISTING's, not the product's.** `commitChannelRow` reads
 * `row.listing.version` for a channel-targeted write and `req.expectedVersion` for a master-targeted
 * one, so the adapter puts the server's number in whichever of the two the routing names. Pairing a
 * product version with a listing write is the defect the sheet shipped once already (#697): the CAS
 * then guards the wrong row in both directions.
 *
 * 🔴 **A reset whose landing value is unknown is REFUSED, not performed.** This lane's first version
 * promised the family's axis tuple — `sharedAxisValues[axisKey]` — and the tuple is not what a reset
 * would land on. Measured on eBay·IT 2026-09-11: the projection reports `sharedAxisValues.Colore =
 * "Nero"` on all 20 children while the MASTER sheet reports `color = null` and `axisValues = {}` on
 * the same children. All 40 axis cells are `pinned` for that reason — there is nothing to inherit.
 * A one-click reset labelled "restore Nero" would therefore have DELETED the specific from a live
 * eBay listing (item 257584954808) while telling the operator it was restoring a value. The reset
 * now waits for `cell.inheritedValue` — the server's own statement of where it would land — and says
 * why on the control until that arrives.
 */
import { commitChannelRow } from '../../sheet/channel/useChannelSheet'
import type { ChannelSheetRow, ChannelScopeChannel } from '../../sheet/channel/types'
import type { SheetWriteResult } from '@/design-system/grid'

import type { ProjectionChild, ProjectionCoordinate, ProjectionValue } from './types'

export type PinIntent = 'pin' | 'reset'

export interface PinRequest {
  child: ProjectionChild
  axisKey: string
  cell: ProjectionValue
  coordinate: ProjectionCoordinate
  /**
   * 🔴 The value the CASCADE would resolve to on a reset — `cell.inheritedValue`, NOT the family's
   * axis tuple. See `ProjectionValue.inheritedValue` for the measurement that separates them.
   */
  inheritedValue: string | null | undefined
  /** The server's sentence for why `inheritedValue` is absent, when it is. */
  inheritedValueUnknownReason?: string
}

/**
 * What the operator's ONE click will do, and whether it may happen at all.
 *
 * Pure, so the cell's tooltip, its accessible name and the write itself are all answered by the same
 * function — a label that says "pin" beside a handler that resets is the kind of disagreement only a
 * shared rule prevents.
 */
export interface PinPlan {
  intent: PinIntent
  /** Non-null = the action is HELD. Rendered as the reason; the control offers nothing. */
  heldReason: string | null
  /** The `SourceIndicator` action label — what the click does, stated before it is clicked. */
  actionLabel: string
}

export function planPin(req: PinRequest): PinPlan {
  const { child, cell, coordinate, inheritedValue } = req
  const where = coordinate.label
  const intent: PinIntent = cell.source === 'pinned' ? 'reset' : 'pin'

  /* The server's own sentence wins over anything composed here. */
  if (cell.writeBlockedReason) {
    return { intent, heldReason: cell.writeBlockedReason, actionLabel: '' }
  }
  if (!cell.write) {
    return {
      intent,
      heldReason: `This value cannot be changed on ${where} — the server sent no write route for it.`,
      actionLabel: '',
    }
  }
  if (cell.write.target !== 'channelListing' || cell.write.version === null) return {
    intent, heldReason: 'This channel value has no observed listing write route. Reload before editing.', actionLabel: '',
  }
  if (intent === 'reset' && inheritedValue === undefined) {
    /* The server could not compute where a reset lands — for a MAPPED cell it deliberately declines,
       because a mapping rule sits between master and the channel and the master value is not the
       answer. Its sentence, not one composed here. */
    return {
      intent,
      heldReason: req.inheritedValueUnknownReason
        ?? `Resetting is not available on ${where} — the server has not said which value this would fall back to, and on a live listing the difference is between restoring a value and deleting one.`,
      actionLabel: '',
    }
  }
  if (intent === 'reset' && !inheritedValue) {
    /* 🔴 `null` is the server ANSWERING: a reset empties this cell. Measured on eBay·IT — every
       normal row answers null, so a reset would clear a Colore specific from live item
       257584954808. That is a real verb, not an error, but it is not "restore" and must not be
       offered under a label that says so. */
    return {
      intent,
      heldReason: `Resetting would CLEAR this ${where} value, not restore one — the shared product holds nothing for this axis. Set the value on the shared product first if you want it to fall back to something.`,
      actionLabel: '',
    }
  }
  if (intent === 'pin' && !cell.value) {
    return {
      intent,
      heldReason: 'There is no value to pin yet. Set one on the shared product, or edit this cell in Information.',
      actionLabel: '',
    }
  }
  return {
    intent,
    heldReason: null,
    actionLabel: intent === 'reset'
      ? `Reset ${child.sku} to the shared value ${inheritedValue}`
      : `Pin ${cell.value} on ${where} for ${child.sku}`,
  }
}

/**
 * Send it. The adapter builds the ONE row `commitChannelRow` needs and nothing more.
 *
 * The cast is narrow and deliberate: `ChannelSheetRow` is the channel sheet's full row type and this
 * surface holds a projection child, not a sheet row. What `commitChannelRow` actually reads from it
 * is `id`, `values[colId].{writeField,writeTarget,writeVerb,shopifyWrite}` and `listing.version` —
 * every one of which is supplied here from the server's own answer. Building a wider object would
 * mean inventing the fields it does not read, which is worse than saying plainly that this is the
 * subset it does.
 */
export async function commitPin(req: PinRequest, plan: PinPlan): Promise<SheetWriteResult> {
  const { child, axisKey, cell, coordinate } = req
  if (plan.heldReason || !cell.write) {
    return { ok: false, reason: plan.heldReason ?? 'This value cannot be changed here.' }
  }
  const { field, target, verb, version } = cell.write
  if (target !== 'channelListing' || version === null) return { ok: false, reason: 'Reload this listing before editing its channel values.' }
  const landsOnListing = target === 'channelListing'

  const row = {
    id: child.id,
    rowId: child.id,
    sku: child.sku,
    aliasId: coordinate.aliasKey || null,
    values: {
      [axisKey]: { writeField: field, writeTarget: target, writeVerb: verb },
    },
    /* `commitChannelRow` takes the CAS token for a channel write from here, and for a master write
       from `expectedVersion` below. One number, put where the routing says it belongs. */
    ...(landsOnListing ? { listing: { version } } : {}),
  } as unknown as ChannelSheetRow

  return commitChannelRow(
    {
      rowId: child.id,
      row,
      cells: [{ colId: axisKey, value: plan.intent === 'reset' ? null : cell.value, intent: plan.intent === 'reset' ? 'reset' : 'set' }],
      expectedVersion: landsOnListing ? undefined : version,
    },
    {
      channel: coordinate.channel as ChannelScopeChannel,
      marketplace: coordinate.market,
      accountId: coordinate.accountId ?? undefined,
    },
  )
}
