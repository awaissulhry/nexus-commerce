'use client'

/**
 * Reviews › Settings — one section's read: the answer, a failed read in words (shown in that section only, never as
 * zeros), and `reload()` (a newer read replaces an older one; a failed re-read keeps what is on screen). `enabled`
 * false reads nothing (a list the person may not see).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { reviewsGet } from '../../_lib/reviewsFetch'

export interface SettingsRead<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => Promise<void>
}

export function useSettingsRead<T>(path: string, enabled = true): SettingsRead<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(enabled)
  const abort = useRef<AbortController | null>(null)

  const reload = useCallback(async () => {
    if (!enabled) return
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setLoading(true)
    try {
      const res = await reviewsGet<T>(path, undefined, { signal: controller.signal })
      if (controller.signal.aborted) return
      if (res.data) {
        setData(res.data)
        setError(null)
      } else {
        setError(res.error)
      }
    } catch {
      return // aborted: a newer read is on its way
    } finally {
      if (abort.current === controller) setLoading(false)
    }
  }, [path, enabled])

  useEffect(() => {
    void reload()
    return () => abort.current?.abort()
  }, [reload])

  return { data, error, loading, reload }
}
