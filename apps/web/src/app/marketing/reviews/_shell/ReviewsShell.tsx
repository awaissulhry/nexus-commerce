'use client'

/**
 * The Reviews area shell (Owner 2026-10-26, build spec §8 rulings 1 and 9): the app rail keeps ONE "Reviews" row, and
 * the Reviews pages live in the Reviews sub-sidebar — DS WorkspaceSubheader `pinned`: a 224 px column beside the app
 * rail from 1024 px (Collapse folds it to a 48 px strip), a drawer below 1024 px opened by the "Reviews" button each
 * page puts in its PageHeader actions (`ReviewsMenuButton`). There is no header band: every page renders its own
 * PageHeader with `reviewsCrumbs(pathname)` as its eyebrow (reviews-crumbs.tsx).
 */
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
// The address WITH its /w/<business> prefix: the sub-sidebar's native links must keep the business when copied or
// opened in a new tab (the same source as the Settings shell's links). Everything else uses @/lib/workspaces/*.
import { usePathname as useAddressPathname } from 'next/navigation'
import { PanelLeftOpen } from 'lucide-react'
import { WorkspaceSubheader, type WorkspaceNavItem, type WorkspaceSubheaderProps } from '@/design-system/patterns'
import { Button } from '@/design-system/primitives'
import { useAuth } from '@/lib/auth/AuthProvider'
import { useRouter } from '@/lib/workspaces/navigation'
import { buildReviewsNavigation } from './reviews-navigation'
import { useReviewsChannelMarkets } from './useReviewsChannelMarkets'
import { useReviewsCounts } from './useReviewsCounts'
import styles from './reviews-shell.module.css'

interface ReviewsNavigationControl {
  open: boolean
  setOpen: (open: boolean) => void
  navigationId: string
}

const ReviewsNavigationContext = createContext<ReviewsNavigationControl | null>(null)

export function ReviewsShell({ children }: { children: ReactNode }) {
  const pathname = useAddressPathname() ?? '/marketing/reviews'
  const router = useRouter()
  const { status, has } = useAuth()
  const counts = useReviewsCounts()
  const markets = useReviewsChannelMarkets()
  const navigationId = `reviews-navigation-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const [chrome, setChrome] = useState<WorkspaceSubheaderProps['chrome']>()

  useEffect(() => {
    setChrome({
      header: document.querySelector<HTMLElement>('.nds-topbar'),
      primaryNavigation: root.current?.closest('.app-rail-host')?.querySelector<HTMLElement>('.h10-rail') ?? null,
    })
  }, [])

  // A plain click stays in the app; a modified click (new tab, new window) follows the native link.
  const navigate = (event: MouseEvent<HTMLAnchorElement>, destination: WorkspaceNavItem) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    router.push(destination.href)
  }

  const control = useMemo(() => ({ open, setOpen, navigationId }), [open, navigationId])

  return (
    <ReviewsNavigationContext.Provider value={control}>
      <div ref={root} className={styles.shell}>
        <WorkspaceSubheader
          pinned
          chrome={chrome}
          navigationLabel="Reviews navigation"
          title="Reviews"
          subtitle="All channels"
          groups={buildReviewsNavigation(pathname, status === 'authed' ? has : undefined, counts, markets)}
          onNavigate={navigate}
          navigationOpen={open}
          onNavigationOpenChange={setOpen}
          navigationId={navigationId}
        />
        <div className={styles.content}>{children}</div>
      </div>
    </ReviewsNavigationContext.Provider>
  )
}

/**
 * The "Reviews" button for a Reviews page's PageHeader actions: below 1024 px it opens the Reviews sub-sidebar as a
 * drawer (Esc, a click outside or picking a page closes it). From 1024 px the column is on screen and the button is
 * not shown. Renders nothing outside the Reviews area.
 */
export function ReviewsMenuButton() {
  const control = useContext(ReviewsNavigationContext)
  if (!control) return null
  return (
    <span className={styles.menuButton}>
      <Button
        size="sm"
        aria-label="Reviews menu"
        aria-haspopup="dialog"
        aria-expanded={control.open}
        aria-controls={control.navigationId}
        onClick={() => control.setOpen(!control.open)}
      >
        <PanelLeftOpen size={13} aria-hidden /> Reviews
      </Button>
    </span>
  )
}
