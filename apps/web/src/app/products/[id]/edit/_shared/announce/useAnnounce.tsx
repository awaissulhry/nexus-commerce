'use client'

// AC.13 — Cockpit-wide ARIA live announcer.
//
// Module-scope singleton (like the draft bus) so any component
// inside the cockpit can announce() without prop drilling. The
// rendered <LiveRegion /> sits once in the cockpit shell with
// aria-live="polite", aria-atomic="true". Screen readers pick up
// every message; visually it's offscreen.
//
// Politeness rationale: most cockpit announcements are status /
// confirmation copy ("Switched to DE", "Applied 3 fields") that
// shouldn't interrupt the user mid-sentence — 'polite' is correct.
// Use announceAssertive() for the rare error case that demands
// immediate read.

import { useEffect, useState } from 'react'

const listeners = new Set<(msg: { tone: 'polite' | 'assertive'; text: string; ts: number }) => void>()

function emit(tone: 'polite' | 'assertive', text: string) {
  // Trim to a sane length so the screen reader doesn't read paragraphs.
  const safe = text.length > 240 ? text.slice(0, 237) + '…' : text
  const evt = { tone, text: safe, ts: Date.now() }
  for (const fn of listeners) fn(evt)
}

export function announce(text: string): void {
  emit('polite', text)
}

export function announceAssertive(text: string): void {
  emit('assertive', text)
}

/** Mount once near the top of the cockpit. The two regions exist
 *  because some screen readers ignore changes that don't toggle the
 *  visible text — alternating between two regions per announcement
 *  guarantees Voice Over / NVDA / JAWS pick it up. */
export function LiveRegion() {
  const [polite, setPolite] = useState('')
  const [assertive, setAssertive] = useState('')
  const [bucket, setBucket] = useState<0 | 1>(0)
  const [politeAlt, setPoliteAlt] = useState('')

  useEffect(() => {
    function onMsg(m: {
      tone: 'polite' | 'assertive'
      text: string
      ts: number
    }) {
      if (m.tone === 'assertive') {
        setAssertive(m.text)
        // Clear after a tick so a re-announce of the same string
        // still triggers.
        window.setTimeout(() => setAssertive(''), 1000)
      } else {
        // Toggle bucket so consecutive identical announcements still
        // count as DOM changes for older readers.
        if (bucket === 0) {
          setPolite(m.text)
          setPoliteAlt('')
        } else {
          setPoliteAlt(m.text)
          setPolite('')
        }
        setBucket((b) => (b === 0 ? 1 : 0))
      }
    }
    listeners.add(onMsg)
    return () => {
      listeners.delete(onMsg)
    }
  }, [bucket])

  // Visually hidden but readable to screen readers.
  const srOnly: React.CSSProperties = {
    position: 'absolute',
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    border: 0,
  }

  return (
    <>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={srOnly}
      >
        {polite}
      </div>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={srOnly}
      >
        {politeAlt}
      </div>
      <div
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        style={srOnly}
      >
        {assertive}
      </div>
    </>
  )
}
