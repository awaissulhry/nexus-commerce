'use client'

import { useStudioScope } from '../../contracts'
import { ProductSheetTab, type ProductSheetTabProps } from '../ProductSheetTab'
export type ChannelScopeTabProps = ProductSheetTabProps

/** Compatibility entry point for channel-only previews. */
export function ChannelScopeTab(props: ChannelScopeTabProps = {}) {
  const { scope } = useStudioScope()
  return scope === 'master' ? null : <ProductSheetTab {...props} />
}
