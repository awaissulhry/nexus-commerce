'use client'

/**
 * Reviews Overview — the setup banner: only problems a person can fix (review-sources.service.ts), in plain words,
 * with the button that opens the place that fixes them. × hides a problem for this viewer until it changes (its
 * fingerprint); that memory is this browser's only and the page works without it.
 */
import { useCallback, useEffect, useState } from 'react'
import { Banner } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import Link from '@/lib/workspaces/Link'
import { visibleSetup, type SetupProblem } from './overviewModel'
import { SectionError } from './SectionError'
import s from './overview.module.css'

const STORAGE_KEY = 'nexus.reviews.overview.hiddenSetup'

function readHidden(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeHidden(hidden: Set<string>): void {
  try {
    // Keep the newest 50: an old fingerprint never comes back once its problem changed.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...hidden].slice(-50)))
  } catch {
    /* private window or blocked storage: the banner simply shows again next time */
  }
}

export interface SetupBannerProps {
  problems: SetupProblem[] | null
  error: string | null
  loading: boolean
  onRetry: () => void
}

export function SetupBanner({ problems, error, loading, onRetry }: SetupBannerProps) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  useEffect(() => setHidden(readHidden()), [])
  const hide = useCallback((fingerprint: string) => {
    setHidden((prev) => {
      const next = new Set(prev)
      next.add(fingerprint)
      writeHidden(next)
      return next
    })
  }, [])

  if (error) return <div className={s.banner}><SectionError error={error} onRetry={onRetry} busy={loading} /></div>
  const shown = problems ? visibleSetup(problems, hidden) : []
  if (shown.length === 0) return null
  return (
    <div className={s.banners}>
      {shown.map((p) => (
        <Banner
          key={p.fingerprint}
          tone="warning"
          title={p.title}
          onDismiss={() => hide(p.fingerprint)}
          action={
            <Button asChild size="sm">
              <Link href={p.href}>{p.actionLabel}</Link>
            </Button>
          }
        >
          {p.words}
        </Banner>
      ))}
    </div>
  )
}
