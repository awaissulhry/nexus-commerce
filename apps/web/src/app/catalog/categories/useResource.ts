'use client'
import { useEffect, useState } from 'react'
import { request } from './api'

/** Results belong to their exact scope; an old response can never populate a new selection. */
export function useResource<T>(path: string | null, revision = 0, debounce = 0) {
  const key = `${path}:${revision}`
  const [result, setResult] = useState<{ key: string; path?: string; data?: T; error?: string }>({ key: '' })
  useEffect(() => {
    if (!path) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void request<T>(path, { signal: controller.signal }).then(data => {
        if (!controller.signal.aborted) setResult({ key, path, data })
      }).catch(error => {
        if (!controller.signal.aborted) setResult({ key, path, error: error instanceof Error ? error.message : 'Could not load categories.' })
      })
    }, debounce)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [path, key, debounce])
  return { data: result.path === path ? result.data : undefined, error: result.key === key ? result.error : undefined, loading: !!path && result.key !== key }
}
