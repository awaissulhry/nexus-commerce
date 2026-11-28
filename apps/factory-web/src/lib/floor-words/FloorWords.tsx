'use client'

import { useMemo, type ReactNode } from 'react'
import { catalogueFor, createTranslator, type Params } from '../i18n/messages'
import { useT } from '../i18n/provider'
import { useFloorLanguage } from './provider'
import './floor-words.css'

/**
 * owb-fl7 step 3 (design § 5zg D1: "a floor window reads right to left, the Urdu word stands above its small English word"; P/floor.js
 * FL) — the two-line label of a floor window's tile and a floor button: in Urdu, the Urdu word, and under it its small English word (a
 * worker who reads a little English, a leader from the office); in Italian and English the one word as before. A part of factory-web
 * (packages/ui is frozen), sized in `em` so it fits the floor's 48 / 56 / 64 px controls.
 */
export function FloorWords({ words, english }: { readonly words: string; readonly english?: string | null }) {
  if (!english || english === words) return <>{words}</>
  return (
    <span className="fw-fwords">
      <span className="fw-fwords-main" lang="ur" dir="rtl">
        {words}
      </span>
      <span className="fw-fwords-sub" lang="en" dir="ltr">
        {english}
      </span>
    </span>
  )
}

/** A floor translator whose words come as the two-line label in Urdu (Urdu over its English word), as plain words elsewhere. */
export function useFloorWords(namespace: string): (key: string, params?: Params) => ReactNode {
  const t = useT(namespace)
  const language = useFloorLanguage()
  const english = useMemo(() => (language === 'ur' ? createTranslator('en', catalogueFor('en', namespace, 'office')) : null), [language, namespace])
  return (key, params) => {
    const words = t(key, params)
    return english ? <FloorWords words={words} english={english(key, params)} /> : words
  }
}
