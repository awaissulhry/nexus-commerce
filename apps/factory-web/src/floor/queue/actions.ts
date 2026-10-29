import { FLOOR_SYNC_KINDS, QUEUED_ACTIONS } from '@nexus/factory-domain/floor-sync/kinds'
import type { ScanIdKind } from '@nexus/factory-domain/numbering/kinds'
import type { FloorMode } from '../model'

/**
 * Which floor actions queue and which wait for the network, as the tablet needs it (factory-domain floor-sync kinds:
 * the one list the API applies too). Queued: operation scans (report, undo, ask a correction), cut log entries and
 * remnants, making a bundle (its ticket numbered from the tablet's own BUNDLE block). Held while offline: goods receipts
 * and their lots, inspections, releases, garment serials (their numbers come from the office at once).
 */

/** The label kinds this person's tablet numbers offline: a queued kind that prints a label, under a permission they hold. */
export function numberKindsOf(permissions: readonly string[]): ScanIdKind[] {
  const held = new Set(permissions)
  const kinds = new Set<ScanIdKind>()
  for (const kind of FLOOR_SYNC_KINDS) {
    const action = QUEUED_ACTIONS[kind]
    if (action.numbers && held.has(action.permission)) kinds.add(action.numbers)
  }
  return [...kinds]
}

/** What waits for the network at a station of this mode (Home says it while offline), or null when all its work queues. */
export function heldWorkOf(mode: FloorMode | null): 'receive' | 'inspect' | 'serials' | null {
  switch (mode) {
    case 'warehouse':
      return 'receive'
    case 'inspection':
      return 'inspect'
    case 'packing':
      return 'serials'
    default:
      return null
  }
}

/** The short key of a queued kind in the screen's words (`sync.what.<key>`). */
export const WHAT_KEY = {
  'production.scan.report': 'report',
  'production.scan.undo': 'undo',
  'production.scan.ask': 'ask',
  'production.cut.log': 'cut',
  'production.cut.remnant': 'remnant',
  'production.bundles.make': 'bundle',
} as const

export type WhatKey = (typeof WHAT_KEY)[keyof typeof WHAT_KEY]
export const WHAT_KEYS = Object.values(WHAT_KEY) as readonly WhatKey[]

export const whatKeyOf = (kind: string): WhatKey | 'other' => (kind in WHAT_KEY ? WHAT_KEY[kind as keyof typeof WHAT_KEY] : 'other')
