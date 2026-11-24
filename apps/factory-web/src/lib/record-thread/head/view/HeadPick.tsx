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
