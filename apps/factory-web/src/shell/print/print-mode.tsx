'use client'

import { createContext, useContext, type ReactNode } from 'react'

/**
 * B-W2b-05 (PLT-171): the page is drawn for paper — the Office shell's print view (`?print=1`, opened in a new tab from
 * the band's Print). A list frame draws ALL its loaded rows without its controls, the record panels draw every panel
 * at once; anything else prints as it is.
 */
const PrintModeContext = createContext(false)

export function PrintModeProvider({ printing, children }: { printing: boolean; children?: ReactNode }) {
  return <PrintModeContext.Provider value={printing}>{children}</PrintModeContext.Provider>
}

/** Whether this page is the print view. */
export function usePrintMode(): boolean {
  return useContext(PrintModeContext)
}
