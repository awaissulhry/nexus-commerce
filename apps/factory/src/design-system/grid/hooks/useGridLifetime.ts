'use client'

import { useCallback, useRef, useState } from 'react'

/** A grid can be replaced while its React host (and pending saves) stays mounted. */
export function useGridLifetime<T extends { isDestroyed(): boolean }>() {
  const apiRef = useRef<T | null>(null)
  const [gridApi, setGridApi] = useState<T | null>(null)
  const getApi = useCallback(() => {
    const api = apiRef.current
    return api && !api.isDestroyed() ? api : null
  }, [])
  const bind = useCallback((api: T) => {
    apiRef.current = api
    setGridApi(api)
  }, [])
  const onGridPreDestroyed = useCallback(({ api }: { api: T }) => {
    // A late teardown from the previous instance must not disconnect its replacement.
    if (apiRef.current !== api) return
    apiRef.current = null
    setGridApi(current => current === api ? null : current)
  }, [])
  return { apiRef, gridApi, getApi, bind, onGridPreDestroyed }
}
