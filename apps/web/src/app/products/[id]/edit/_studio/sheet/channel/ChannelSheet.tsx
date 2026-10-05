'use client'

import { ProductSheet } from '../ProductSheet'
import { ChannelIdControlProvider } from './channelIdControl'
import type { ChannelSheetProps } from './useChannelSheetAdapter'
export type { ChannelSheetProps } from './useChannelSheetAdapter'

/**
 * Compatibility entry point for existing callers; rendering lives in ProductSheet. The Item ID control (step I1) is
 * mounted here once: the sheet's eBay Item ID cells open it (`ListingIdCell.tsx`).
 */
export function ChannelSheet(props: ChannelSheetProps) {
  return (
    <ChannelIdControlProvider channel={props.channel} marketplace={props.marketplace}>
      <ProductSheet scope="channel" {...props} />
    </ChannelIdControlProvider>
  )
}
