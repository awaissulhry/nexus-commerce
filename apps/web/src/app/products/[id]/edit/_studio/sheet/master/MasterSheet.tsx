'use client'

import { ProductSheet } from '../ProductSheet'
import type { MasterSheetProps } from './useMasterSheetAdapter'
export type { MasterSheetProps } from './useMasterSheetAdapter'

/** Compatibility entry point for existing callers; rendering lives in ProductSheet. */
export function MasterSheet(props: MasterSheetProps) {
  return <ProductSheet scope="master" {...props} />
}
