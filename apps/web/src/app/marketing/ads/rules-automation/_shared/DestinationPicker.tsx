'use client'

/**
 * DestinationPicker — where a harvested term goes (Keyword Harvest page F2, 2026-10-10).
 *
 * One DS `Listbox`, grouped by portfolio, one option per "Campaign › Ad group" with its match as a chip; "Suggested"
 * first; search (always on); a place the server holds stays in the list with its reason on a line under the label and
 * cannot be picked; under the list the action rows "New campaign…" and "New portfolio…" (DS H1 — buttons, not
 * options). The value is the harvest
 * preview's `to` (`{ adGroupId }` or `{ newCampaign: key }`). Rules: `destinationOptions.ts`. Data: `GET
 * /api/advertising/harvest/destinations` (lane HCORE). Reusable by the Negatives page and the playbook.
 */
import { useMemo } from 'react'
import { Plus } from 'lucide-react'

import { Listbox, type ListboxPanelAction, type ListboxPanelOption } from '@/design-system/components'
import { Tag } from '@/design-system/primitives'
import {
  destinationOptions, fromValue, toValue,
  type HarvestDestinations, type HarvestTo, type PlannedCampaign,
} from './destinationOptions'

export interface DestinationPickerProps {
  /** The `/destinations` answer; null while it is read (the list is empty, the actions stay). */
  destinations: HarvestDestinations | null
  value: HarvestTo | null
  onChange: (to: HarvestTo) => void
  /** "New campaign…" — the page opens its new-campaign fields. No handler = no row. */
  onNewCampaign?: () => void
  /** "New portfolio…". No handler = no row. */
  onNewPortfolio?: () => void
  /** Why a new portfolio cannot be made here (shown, never silent). */
  newPortfolioHeld?: string | null
  /** New campaigns already planned in this window, listed as places. */
  planned?: readonly PlannedCampaign[]
  /** The key the server's suggested new campaign gets when picked. Default `'new'`. */
  newCampaignKey?: string
  id?: string
  ariaLabel?: string
  'aria-describedby'?: string
  placeholder?: string
  size?: 'xs' | 'sm' | 'md'
  width?: number | string
}

export function DestinationPicker({
  destinations, value, onChange, onNewCampaign, onNewPortfolio, newPortfolioHeld, planned, newCampaignKey,
  id, ariaLabel = 'Destination', 'aria-describedby': describedBy, placeholder, size, width = '100%',
}: DestinationPickerProps) {
  const options = useMemo<ListboxPanelOption[]>(
    () => destinationOptions(destinations, { planned, newCampaignKey }).map((o) => ({
      value: o.value,
      label: o.label,
      group: o.group,
      searchText: o.searchText,
      leading: o.match ? <Tag>{o.match}</Tag> : undefined,
      // A held place says why on a line of its own under the label (never a word squeezed in at the right: at 390 px
      // it crowded the label, lead review 2026-10-11). The short `heldLabel` stays in the data for other views.
      heldReason: o.heldReason,
      note: o.heldReason,
    })),
    [destinations, planned, newCampaignKey],
  )
  const campaignHeld = destinations?.newCampaign.held?.reason
  const actions = useMemo<ListboxPanelAction[]>(() => [
    ...(onNewCampaign ? [{ id: 'new-campaign', label: 'New campaign…', icon: <Plus />, onSelect: onNewCampaign, heldReason: campaignHeld }] : []),
    ...(onNewPortfolio ? [{ id: 'new-portfolio', label: 'New portfolio…', icon: <Plus />, onSelect: onNewPortfolio, heldReason: newPortfolioHeld ?? undefined }] : []),
  ], [onNewCampaign, onNewPortfolio, campaignHeld, newPortfolioHeld])

  return (
    <Listbox
      id={id}
      aria-describedby={describedBy}
      ariaLabel={ariaLabel}
      size={size}
      width={width}
      options={options}
      value={value ? toValue(value) : undefined}
      onChange={(v) => { const to = fromValue(v); if (to) onChange(to) }}
      placeholder={placeholder ?? (destinations ? 'Choose where it goes' : 'Reading…')}
      searchable
      searchPlaceholder="Search campaigns…"
      actions={actions}
    />
  )
}
