'use client'

/**
 * VP.4 — §4.2's `Preflight` verb, in the CH.1 shape: the existing control, in a DS `Modal`.
 *
 * 🔴 Nothing here is new. `AliasPublishControl` is PES.3's, `useChannelSheet` is PES.3's, and the
 * "a DS Modal is the interim shell, the control inside is unchanged and still sends nothing" is
 * CH.1's decision, already on screen on the Information sheet. This file is one thing only: the
 * verb, mounted from the Variants toolbar, reading the coordinate the Variants page is already on.
 * A second preflight implementation would be the fork the programme exists to prevent.
 *
 * 🔴 It mounts LAZILY — nothing is fetched until the operator opens it. The Information check reads
 * field readiness, which lives in the channel SHEET payload (≈900 KB on the fixture family,
 * measured), and the projection contract deliberately does not carry it. Paying for that read on
 * every Variants page load, for a verb behind a `⋯`, would be a page slower for everyone so that a
 * menu item could be instant for one.
 *
 * It sends nothing. `AliasPublishControl` derives its problems from `row.readiness.issues` and
 * makes no request of its own — the sentence "This check sends nothing to the provider" in that
 * component is its own, and true.
 */
import { Modal, ProgressBar } from '@/design-system/components'

import { AliasPublishControl } from '../../sheet/channel/AliasPublishControl'
import { useChannelSheet } from '../../sheet/channel/useChannelSheet'
import { withRowIdentity } from '../../sheet/channel/rows'
import type { ChannelScopeChannel } from '../../sheet/channel/types'
import { wireAliasKey } from '../../sheet/channel/types'

export interface ProjectionPreflightProps {
  productId: string
  channel: string
  marketplace: string
  accountId?: string
  locale?: string
  aliasKey: string
  /** The coordinate's own words — `eBay · IT`. */
  label: string
  onClose(): void
}

export function ProjectionPreflight({ productId, channel, marketplace, accountId, locale, aliasKey, label, onClose }: ProjectionPreflightProps) {
  const sheet = useChannelSheet({ productId, channel: channel as ChannelScopeChannel, marketplace, accountId, locale })
  const rows = sheet.data ? withRowIdentity(sheet.data.rows, sheet.data.aliases) : []
  const alias = sheet.data?.aliases.find(candidate => wireAliasKey(candidate.id) === aliasKey) ?? null

  return (
    <Modal
      open
      onClose={onClose}
      title={`Information check · ${label}`}
      subtitle="What a send would carry, checked by the server. Nothing is sent from here."
      size="lg"
    >
      <>
        {sheet.loading && <ProgressBar indeterminate ariaLabel="Loading this listing's information check" />}
        {/* An honest failure, not an empty panel: a check that could not run and a check that found
            nothing look identical, and only one of them is a statement about the listing. */}
        {!sheet.loading && sheet.error && <p role="alert">The information check could not run: {sheet.error}</p>}
        {!sheet.loading && !sheet.error && !alias && <p role="status">This coordinate has no listing to check yet.</p>}
        {alias && (
          <AliasPublishControl
            alias={alias}
            rows={rows}
            channel={channel as ChannelScopeChannel}
            marketplace={marketplace}
            autoRun
          />
        )}
      </>
    </Modal>
  )
}
