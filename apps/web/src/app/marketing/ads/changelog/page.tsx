/**
 * HX.5 — the account-wide Amazon Change Log.
 *
 * This route already existed as a stub ("This screen is being rebuilt to match Adtomic"); filling
 * it is an extension, not a new page, and it deliberately gains NO sidebar entry. It is reached
 * from contextual "View all changes →" links in the surfaces that show a narrower slice of the same
 * feed, each opening in a new tab.
 */
import { ChangeLogClient } from './ChangeLogClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return <ChangeLogClient />
}
