'use client'

/**
 * ApprovalsWaiting — how many approval requests need a person, in one line, with a link to the Approvals page.
 *
 * "Other pages may show that approvals are waiting; none of them may decide one" (docs/2026-08-07-naf-aq-approvals-page.md;
 * the Owner, 2026-10-05). Settings › AI and the Fleet overview used to list the requests with Approve and Reject; they
 * show this line instead. It has no Approve, no Reject and no list: every decision is made on /fleet/approvals.
 *
 * Reads `GET /api/agent/fleet/approvals/queue/counts` every 30 s while the tab is visible (`useVisibilityPoll`).
 * Design-system parts only; the neutral Banner reads only tokens the fleet light pin covers.
 */
import { useCallback, useId, useState } from 'react'
import { AlertTriangle, CheckCircle2, Inbox } from 'lucide-react'
import { Banner } from '@/design-system/components'
import { Button, Skeleton } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import Link from '@/lib/workspaces/Link'
import { useVisibilityPoll } from './use-visibility-poll'
import {
  APPROVALS_HREF,
  OPEN_APPROVALS,
  approvalsWaitingLine,
  readWaitingCounts,
  type WaitingCounts,
  type WaitingLine,
} from './approvals-waiting-words'
import styles from './ApprovalsWaiting.module.css'

const COUNTS_PATH = '/api/agent/fleet/approvals/queue/counts'
const POLL_MS = 30_000

const ICON = {
  loading: <Inbox size={18} aria-hidden />,
  attention: <Inbox size={18} aria-hidden />,
  clear: <CheckCircle2 size={18} aria-hidden />,
  error: <AlertTriangle size={18} aria-hidden />,
} as const

export interface ApprovalsWaitingProps {
  /** A section heading above the line (Settings › AI). Without it the line stands alone. */
  heading?: string
  /** The section's id, for in-page links (Settings › AI's agents link to `#agent-approvals`). */
  id?: string
}

export function ApprovalsWaiting({ heading, id }: ApprovalsWaitingProps) {
  const [counts, setCounts] = useState<WaitingCounts | null>(null)
  const [failed, setFailed] = useState(false)

  // useVisibilityPoll's contract: `load` keeps its own error state and throws on failure.
  const load = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}${COUNTS_PATH}`, { cache: 'no-store' })
      const next = res.ok ? readWaitingCounts(await res.json().catch(() => null)) : null
      if (!next) throw new Error(`approvals count: HTTP ${res.status}`)
      setCounts(next)
      setFailed(false)
    } catch (e) {
      setFailed(true)
      throw e
    }
  }, [])
  useVisibilityPoll(load, POLL_MS)

  return <ApprovalsWaitingView line={approvalsWaitingLine({ counts, failed })} heading={heading} id={id} />
}

/** The line itself, for one state (exported for the render test). */
export function ApprovalsWaitingView({ line, heading, id }: ApprovalsWaitingProps & { line: WaitingLine }) {
  const headingId = useId()
  return (
    <section
      id={id}
      className={styles.root}
      aria-labelledby={heading ? headingId : undefined}
      aria-label={heading ? undefined : 'Approvals'}
      aria-busy={line.kind === 'loading'}
    >
      {heading ? <h2 id={headingId} className={styles.heading}>{heading}</h2> : null}
      <Banner
        tone="neutral"
        icon={ICON[line.kind]}
        title={
          line.kind === 'loading'
            ? <Skeleton className={styles.skeleton} width="16rem" height={14} />
            : <span className={styles.line}>{line.text}</span>
        }
        action={
          <Button variant="secondary" size="sm" asChild>
            <Link href={APPROVALS_HREF}>{OPEN_APPROVALS}</Link>
          </Button>
        }
      />
    </section>
  )
}
