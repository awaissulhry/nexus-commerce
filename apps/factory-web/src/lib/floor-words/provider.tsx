'use client'

import { createContext, useContext, type ReactNode } from 'react'
import type { FloorLocale } from '../i18n/locales'

/**
 * owb-fl7 (pick J) — the floor's own language for the parts below the floor app (the floor app's I18nProvider speaks the words' BASE:
 * Urdu's words are Urdu over English, so its page language is English for plurals, numbers and dates). Null: not on the floor.
 */
const FloorLanguage = createContext<FloorLocale | null>(null)

export function FloorWordsProvider({ locale, children }: { readonly locale: FloorLocale; readonly children?: ReactNode }) {
  return <FloorLanguage.Provider value={locale}>{children}</FloorLanguage.Provider>
}

/** The floor's language now, or null off the floor (the office, the portal, a design case). */
export function useFloorLanguage(): FloorLocale | null {
  return useContext(FloorLanguage)
}
