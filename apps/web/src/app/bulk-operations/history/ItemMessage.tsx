/**
 * A bulk job item's message (`BulkActionItem.errorMessage`), as the history page shows it.
 *
 * The field holds two different things. On a FAILED item it is the error. On a SKIPPED item it is why the row was
 * left alone, in plain words ("Not changed: 45.00 is below its pricing floor of 46.00.") — the API writes those for
 * price changes since 2026-10-01, and the rollback's skipped rows have always carried one. A reason is not an error:
 * it reads as "Reason" in neutral text, never in the red "Error" style a failure keeps.
 */
import { Banner } from '@/design-system/components'
import s from './history.module.css'

export type ItemMessageKind = 'reason' | 'error'

/** A SKIPPED item's message is its reason; any other status's message is an error, as before. */
export function itemMessageKind(status: string): ItemMessageKind {
  return status === 'SKIPPED' ? 'reason' : 'error'
}

/** The message in the items list. */
export function ItemMessageText({ status, message }: { status: string; message: string }) {
  if (itemMessageKind(status) === 'reason') {
    return (
      <span className={s.subtle}>
        <span className="nds-vh">Reason: </span>
        {message}
      </span>
    )
  }
  return <span className={s.errorText}>{message}</span>
}

/** The message in the item drawer. */
export function ItemMessageBanner({ status, message }: { status: string; message: string }) {
  if (itemMessageKind(status) === 'reason') {
    return (
      <Banner tone="neutral" title="Reason">
        {message}
      </Banner>
    )
  }
  return (
    <Banner tone="danger" title="Error">
      <pre className={s.pre}>{message}</pre>
    </Banner>
  )
}
