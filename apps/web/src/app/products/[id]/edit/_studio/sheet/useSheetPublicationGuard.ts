'use client'

import { useEffect } from 'react'
import { usePublicationBarrier, useStudioScope } from '../contracts'

/** Drain committed cells; keep open editors and unconfirmed writes available for review. */
export function useSheetPublicationGuard(
  writer: { flush(): Promise<void>; readonly pending: number; readonly unknownCount: number },
  tracker: { readonly hasUnconfirmedChanges: boolean },
  getGridApi: () => { getEditingCells(): unknown[] } | null | undefined,
) {
  // P2 — the barrier only: reading the whole save state re-rendered the sheet on every save state change.
  const registerPublicationBarrier = usePublicationBarrier()
  const { registerScopeChangeGuard } = useStudioScope()
  useEffect(() => {
    const blocker = () => (getGridApi()?.getEditingCells().length ?? 0) > 0
      ? 'Apply or cancel the open cell before publishing.'
      : writer.pending > 0 || writer.unknownCount > 0 || tracker.hasUnconfirmedChanges
        ? 'Wait for the sheet to save and resolve any highlighted changes before publishing.' : null
    const unregisterPublication = registerPublicationBarrier({ flush: () => writer.flush(), blocker })
    const unregisterScope = registerScopeChangeGuard(() => (getGridApi()?.getEditingCells().length ?? 0) === 0 && writer.pending === 0 && writer.unknownCount === 0 && !tracker.hasUnconfirmedChanges)
    return () => { unregisterPublication(); unregisterScope() }
  }, [writer, tracker, getGridApi, registerPublicationBarrier, registerScopeChangeGuard])
}
