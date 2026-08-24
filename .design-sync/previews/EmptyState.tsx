import { AlertTriangle, FileSpreadsheet, Inbox, SearchX, ShieldCheck } from 'lucide-react'
import { Button, Card, EmptyState } from '@nexus/design-system'

/** The full form — icon, title, description and a CTA in `action`. */
export const NoData = () => (
  <Card padded>
    <EmptyState
      icon={<Inbox size={22} />}
      title="No campaigns yet"
      description="Create your first campaign to start advertising on Amazon DE."
      action={
        <Button variant="primary" size="sm">
          New campaign
        </Button>
      }
    />
  </Card>
)

/** The filtered-to-nothing case — the CTA clears the filter rather than creating anything. */
export const NoResults = () => (
  <Card padded>
    <EmptyState
      icon={<SearchX size={22} />}
      title="No listings match these filters"
      description="4 filters are active: Amazon DE, FBA, ACOS > 30%, suppressed only."
      action={<Button size="sm">Clear filters</Button>}
    />
  </Card>
)

/** The failure case — the same component carries the error, tone set by the icon and the copy. */
export const LoadFailed = () => (
  <Card padded>
    <EmptyState
      icon={<AlertTriangle size={22} />}
      title="Budget schedules could not be loaded."
      description="The request failed and returned no message. Failing since 06:15 CET."
      action={<Button size="sm">Retry</Button>}
    />
  </Card>
)

/** Ran-and-matched-nothing — an empty result that is a real answer, not a missing one. */
export const NothingToChange = () => (
  <Card padded>
    <EmptyState
      icon={<ShieldCheck size={22} />}
      title="Ran at 08:00 CET. Nothing to change."
      description="All 51 bid rules were evaluated against 1,204 targets and none of them matched."
    />
  </Card>
)

/** Title only — the most compact form, for an inline panel that already has its own heading. */
export const TitleOnly = () => (
  <Card padded>
    <EmptyState icon={<FileSpreadsheet size={22} />} title="No imports yet" />
  </Card>
)
