'use client'

import { createContext, useContext, type ReactNode } from 'react'
import type { ReadPictures } from '../record-picture/cache'
import type { PictureSource } from '../record-picture/model'

/**
 * owb-of3 — how the sheet draws an order's picture. The part has no fetch of its own: each door gives its batch reader and the
 * picture source of a record here (office: `order` / `portalOrder` through `pictureReader(api)`; the portal: its own). Without a
 * provider the part draws the placeholder mark (never a broken image). Kept out of `OrdersSheetProps` (FIXED) on purpose.
 */
export interface SheetPictures {
  readonly read: ReadPictures | null
  readonly sourceOf: (record: { readonly kind: 'ORDER' | 'REQUEST' }) => PictureSource
}

const NO_PICTURES: SheetPictures = Object.freeze({ read: null, sourceOf: () => 'order' as const })

const SheetPicturesContext = createContext<SheetPictures>(NO_PICTURES)

export function SheetPicturesProvider({ value, children }: { value: SheetPictures; children?: ReactNode }) {
  return <SheetPicturesContext.Provider value={value}>{children}</SheetPicturesContext.Provider>
}

export const useSheetPictures = (): SheetPictures => useContext(SheetPicturesContext)
