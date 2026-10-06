'use client'

/**
 * CR rebuild 1 — the side panel behind the Waiting for you and Problems tiles.
 *
 * Waiting for you lists every queue that holds a decision for a person, with the way to it: Approvals (Claude's
 * requests and strategy raises) and the rules' suggestions. Problems lists the Today board's live conditions (the old
 * Today tab): each row is true when it was checked, and leaves on the next check once it is fixed.
 */
import { Banner, Drawer } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import Link from '@/lib/workspaces/Link'
import { headlineAmount, money, rowAmounts } from './todayAmounts'
import { waitingSince, type Board, type Exception, type Severity } from './todayBoard'
import { problemHint, problemRows, suggestionsWaiting } from './roomCounts'
import { readTab, ROOM_PATH, ROOM_TABS } from './roomTabs'
import styles from './room.module.css'

export type NeedsYouView = 'waiting' | 'problems'

const TONE: Record<Severity, 'danger' | 'warning' | 'info'> = { critical: 'danger', warning: 'warning', info: 'info' }

/**
 * A board link into this page names a tab that no longer exists ("Open Levers", `?tab=levers`): say the tab it opens now,
 * and close the panel on the click (the page does not reload, so the panel would stay over the tab it opened).
 */
export function actionTarget(action: { label: string; href: string }): { label: string; here: boolean } {
  const url = new URL(action.href, 'https://nexus.local')
  if (!url.pathname.endsWith(ROOM_PATH)) return { label: action.label, here: false }
  const { tab } = readTab(url.searchParams.get('tab'), url.searchParams.get('view'))
  return { label: `Open ${ROOM_TABS.find((t) => t.id === tab)?.label ?? 'the Control Room'}`, here: true }
}

function ExceptionBanner({ e, onLeave }: { e: Exception; onLeave: () => void }) {
  const amounts = rowAmounts(e)
  const age = waitingSince(e.since)
  const target = e.action ? actionTarget(e.action) : null
  return (
    <Banner
      tone={TONE[e.severity]}
      title={e.title}
      action={e.action && target && (
        <Button asChild size="sm" variant="secondary">
          <Link href={e.action.href} onClick={target.here ? onLeave : undefined}>{target.label}</Link>
        </Button>
      )}
    >
      <p className={styles.para}>{e.detail}</p>
      <p className={styles.para}>
        {amounts.length > 0 ? `${amounts.map(money).join(' · ')} — ${e.amountNote}` : e.amountNote}
        {age ? ` · Oldest: ${age}.` : ''}
      </p>
    </Banner>
  )
}

export function NeedsYouDrawer({ view, onClose, board, boardError, needsYou }: {
  view: NeedsYouView | null
  onClose: () => void
  board: Board | null
  boardError: string | null
  /** Approvals' "needs you" count; null = it could not be read. */
  needsYou: number | null
}) {
  const problems = problemRows(board?.exceptions ?? null)
  const suggestions = suggestionsWaiting(board?.exceptions ?? null)
  const suggestionRow = board?.exceptions.find((e) => e.key === 'decisions-waiting') ?? null
  const checked = board
    ? `Checked at ${new Date(board.generatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.`
    : null

  return (
    <Drawer
      open={view !== null}
      onClose={onClose}
      width={560}
      title={view === 'problems' ? 'Problems' : 'Waiting for you'}
      subtitle={view === 'problems'
        ? (problems ? problemHint(problems) : 'Could not be read')
        : 'Decisions only a person can make'}
      footer={checked && <span className={styles.muted}>{checked} Nothing here is listed from memory.</span>}
    >
      <div className={styles.stack}>
        {boardError && <Banner tone="danger" title="The checks could not be read">{boardError}</Banner>}

        {view === 'waiting' && <>
          <Banner
            tone={needsYou ? 'info' : needsYou === 0 ? 'success' : 'warning'}
            title={needsYou == null ? 'Approvals could not be read' : `${needsYou} waiting in Approvals`}
            action={(
              <Button asChild size="sm" variant="secondary">
                <Link href="/fleet/approvals">Open Approvals</Link>
              </Button>
            )}
          >
            Requests from Claude and from other parts of Nexus wait there for a person — ads and everything else.
          </Banner>
          {suggestionRow
            ? <ExceptionBanner e={suggestionRow} onLeave={onClose} />
            : (
              <Banner tone={suggestions === 0 ? 'success' : 'warning'} title={suggestions === 0 ? 'No rule suggestions waiting' : 'Rule suggestions could not be read'}>
                Rules set to Ask me queue their changes here for you to accept or decline.
              </Banner>
            )}
        </>}

        {view === 'problems' && board && <>
          <div>
            <p className={styles.para}>
              Spend with no sales, last 30 settled days: <strong>{headlineAmount(board.headline)}</strong>
              {board.headline.wastedTargets > 0 ? ` across ${board.headline.wastedTargets} targets` : ''}
            </p>
            <p className={`${styles.para} ${styles.muted}`}>{board.headline.note}</p>
          </div>
          {problems && problems.length > 0
            ? problems.map((e) => <ExceptionBanner key={e.key} e={e} onLeave={onClose} />)
            : <Banner tone="success" title="Nothing needs you right now">The checks found no problem to look at.</Banner>}
        </>}
      </div>
    </Drawer>
  )
}
