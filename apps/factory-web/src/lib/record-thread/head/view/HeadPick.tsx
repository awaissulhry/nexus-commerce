'use client'

import { createContext, useContext, type ReactNode } from 'react'

/**
 * tw- W2.1 (Z4, P0-B4; 10-design §8): the dock's pick goes INTO the head's title — ONE menu, one label per thread — instead of a band of
 * its own above the head. The card around a thread (RecordThread, DockColumn) hands the pick its host gave it (`slots.top`, `top`)
 * down to whichever head it draws; the head draws it as its title (else the record's own label). Null: nothing to pick.
 */
const HeadPickContext = createContext<ReactNode>(null)

export function HeadPickProvider({ pick, children }: { pick: ReactNode; children?: ReactNode }) {
  return <HeadPickContext.Provider value={pick ?? null}>{children}</HeadPickContext.Provider>
}

/** The pick for the head's title (null: none — the head shows the record's own label). */
export function useHeadPick(): ReactNode {
  return useContext(HeadPickContext)
}

/**
 * tw- fx2 (walk G-21; 10-design § 8): the head's title is the CURRENT thread's record label ("SO-2026-0142", "Seed Racing (general)"),
 * the pick's menu keeps the long labels. The thread's head hands its record label to the pick it draws; All of's head hands none (its
 * title is the pick's own "All of …").
 */
const HeadTitleContext = createContext<string | null>(null)

export function HeadTitleProvider({ title, children }: { title: string | null; children?: ReactNode }) {
  return <HeadTitleContext.Provider value={title}>{children}</HeadTitleContext.Provider>
}

export function useHeadTitle(): string | null {
  return useContext(HeadTitleContext)
}
