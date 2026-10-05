'use client'

import { ProductSheet } from '../ProductSheet'
import type { ChannelSheetProps } from './useChannelSheetAdapter'
export type { ChannelSheetProps } from './useChannelSheetAdapter'

/** Compatibility entry point for existing callers; rendering lives in ProductSheet. */
export function ChannelSheet(props: ChannelSheetProps) {
  return <ProductSheet scope="channel" {...props} />
}
