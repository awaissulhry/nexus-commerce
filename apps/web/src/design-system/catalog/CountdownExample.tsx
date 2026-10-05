'use client'

import { useState } from 'react'

import { Button } from '../primitives/Button'
import { Countdown } from '../components/Countdown'

/*
 * 2026-10-05 — approvals grid G7: a live countdown. Verify: "Runs in 14 s" counts every second and turns to
 * "Starting…" at zero, which bumps "Done" by exactly one; the 3-minute and 3-hour rows step every 30 s; all four share
 * one timer; switching tab and back catches up at once. A screen reader hears 10 s and the end, not every second.
 */
const ROW = { display: 'grid', gridTemplateColumns: '170px auto', gap: 'var(--nds-space-10)', alignItems: 'baseline', fontSize: 'var(--nds-font-size-base)', color: 'var(--nds-text)' } as const
const NOTE = { color: 'var(--nds-text-muted)', fontSize: 'var(--nds-font-size-sm)' } as const

export function CountdownExample() {
  const [start, setStart] = useState(() => Date.now())
  const [done, setDone] = useState(0)
  return <section id="countdown-example" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--nds-space-8)', maxWidth: 480 }}>
    <div style={ROW}><span style={NOTE}>stop window</span><Countdown to={start + 14_000} label={(t) => `Runs in ${t}`} doneLabel="Starting…" onDone={() => setDone((n) => n + 1)} /></div>
    <div style={ROW}><span style={NOTE}>minutes</span><Countdown to={start + 3 * 60_000} label={(t) => `Runs in ${t}`} /></div>
    <div style={ROW}><span style={NOTE}>expiry</span><Countdown to={start + 3 * 3_600_000} label={(t) => `Expires in ${t}`} /></div>
    <div style={ROW}><span style={NOTE}>already past</span><Countdown to={start - 5_000} doneLabel="Ran" /></div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--nds-space-10)' }}>
      <Button size="sm" onClick={() => setStart(Date.now())}>Restart</Button>
      <span style={NOTE}>Done: {done}</span>
    </div>
  </section>
}
