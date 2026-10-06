'use client'

/**
 * 3A (Owner decided 2026-10-06) — the one "Send anyway" dialog of the ads screens (see sendAnyway.ts).
 *
 * A person's own write past one of his own limits waits here: the dialog names every limit it goes past, in the
 * server's words, and the change goes only when he chooses "Send anyway". Cancel sends nothing. Mounted once, in the
 * ads layout, so every screen that writes through `adsWrite` / `adsAdd` (and the Bid, Budget Manager and Bulk pages)
 * gets the same question.
 */
import { useEffect, useRef, useState } from 'react'
import { Modal } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { setSendAnywayAsker, type SendAnywayAsk } from './sendAnyway'

export function SendAnywayHost() {
  const [ask, setAsk] = useState<SendAnywayAsk | null>(null)
  const answer = useRef<((yes: boolean) => void) | null>(null)

  useEffect(() => {
    setSendAnywayAsker((next) => new Promise<boolean>((resolve) => {
      answer.current = resolve
      setAsk(next)
    }))
    return () => setSendAnywayAsker(null)
  }, [])

  const close = (yes: boolean) => {
    answer.current?.(yes)
    answer.current = null
    setAsk(null)
  }

  return (
    <Modal
      open={ask != null}
      onClose={() => close(false)}
      size="sm"
      title="This goes past your own limits"
      footer={<>
        <Button onClick={() => close(false)}>Cancel</Button>
        <Button variant="primary" onClick={() => close(true)}>Send anyway</Button>
      </>}
    >
      {ask && (
        <>
          <p>
            {ask.changes === 1 ? 'This change goes' : `${ask.changes} changes go`} past limits you set yourself. They are
            your limits, so you can send {ask.changes === 1 ? 'it' : 'them'} anyway; Amazon&apos;s own limits still apply.
          </p>
          <ul>{ask.limits.map((l) => <li key={l.reason}>{l.reason}</li>)}</ul>
        </>
      )}
    </Modal>
  )
}
