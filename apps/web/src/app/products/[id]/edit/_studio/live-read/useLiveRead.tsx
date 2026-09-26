'use client'

/**
 * Read live — the channel sheet's hook-up: ONE ⋯ menu item and the drawer. Everything else lives in this folder, so the channel
 * adapter needs a hook call, a menu entry and one element.
 */
import { useMemo, useState, type ReactNode } from 'react'
import type { ChannelSheetRow } from '../sheet/channel/types'
import { LiveReadDrawer, type LiveReadTarget } from './LiveReadDrawer'
import type { AxisLink, NexusVariant } from './liveReadModel'

export function useLiveRead(input: Omit<LiveReadTarget, 'accountId' | 'aliasKey'> & { accountId: string | null | undefined; aliasKey: string | null; rows: readonly ChannelSheetRow[] }): {
  menuItem: { id: string; label: string; disabled: boolean; description: string; onSelect: () => void }
  element: ReactNode
} {
  const [open, setOpen] = useState(false)
  const alias = input.aliasKey ?? ''
  const mine = useMemo(() => input.rows.filter(row => (row.aliasId ?? '') === alias), [input.rows, alias])
  const parent = mine.find(row => row.parentId === null)
  const links = useMemo<AxisLink[]>(() => {
    const cell = parent?.values?.variationTheme?.value as { axes?: Array<{ axisKey: string; familyKey: string; channelName: string; included: boolean }> } | null | undefined
    return (cell?.axes ?? []).filter(a => a.included).map(a => ({ channelName: a.channelName, familyKey: a.familyKey, axisKey: a.axisKey }))
  }, [parent])
  const nexusVariants = useMemo<NexusVariant[]>(() => mine.filter(row => row.parentId !== null).map(row => ({ sku: row.sku, values: row.axisValues ?? {} })), [mine])
  const nexusContent = useMemo<Record<string, unknown>>(() => Object.fromEntries(Object.entries(parent?.values ?? {}).map(([key, cell]) => [key, cell?.value])), [parent])
  const target = useMemo<LiveReadTarget | null>(() => input.accountId ? { productId: input.productId, channel: input.channel, channelLabel: input.channelLabel,
    marketplace: input.marketplace, accountId: input.accountId, aliasKey: alias } : null, [input.productId, input.channel, input.channelLabel, input.marketplace, input.accountId, alias])
  return {
    menuItem: { id: 'read-live', label: 'Read live…', disabled: !target,
      description: target ? 'Read what this listing shows on the channel now. Read only — nothing is changed.' : 'Choose an account to read the live listing.',
      onSelect: () => setOpen(true) },
    element: target && open ? <LiveReadDrawer open={open} onClose={() => setOpen(false)} target={target} links={links} nexusVariants={nexusVariants} nexusContent={nexusContent} /> : null,
  }
}
