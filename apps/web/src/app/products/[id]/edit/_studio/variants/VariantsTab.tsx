'use client'

/**
 * VP.1 — where `tab=variants` mounts. A SWITCH, and nothing else.
 *
 * 🔴 ONE Variants page, re-projected by the scope bar (variants spec §1.1). Family STRUCTURE — the axes, which
 * children exist, each child's axis values — is defined once on the shared product; a channel's PROJECTION —
 * theme/specifics mapping, per-variant inclusion, listing split, pinned values — is the SAME page read at that
 * coordinate. That is the studio's founding rule applied to variations, and it is why there is no per-channel
 * Variants item in the navigation (§1.2).
 *
 * This file owns the branch and nothing inside either surface:
 *   master scope  → VP.3's `FamilyVariants`   (`./family`, spec §3)
 *   channel scope → VP.4's `ChannelProjection` (`./channel`, spec §4)
 *
 * Both are LIVE as of 2026-09-11. Neither takes a prop: each reads the coordinate from `useStudioScope()`
 * itself and says so on screen when the frame has not resolved one yet, so there is nothing here to guard.
 * A branch whose lane has not exported yet mounts the studio's standard placeholder, never an empty box —
 * swapping one in is ONE import and ONE identifier in this file.
 *
 * The URL contract is untouched by this page: `tab`, `scope`, `market`, `account` and `chip` keep their
 * meaning and their readers. The coordinate arrives through `useStudioScope()`, never through props.
 */

import { useStudioScope } from '../contracts'
import { MASTER_SCOPE } from '../types'
import { FamilyVariants } from './family'
import { ChannelProjection } from './channel'

export function VariantsTab() {
  const { scope } = useStudioScope()
  return scope === MASTER_SCOPE ? <FamilyVariants /> : <ChannelProjection />
}
