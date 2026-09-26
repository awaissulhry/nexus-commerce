'use client'
import { useEffect, useState } from 'react'
import { JobProgress } from '../components/JobProgress'
import { Button } from '../primitives/Button'

const TOTAL = 400

export function JobProgressExample() {
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [done, setDone] = useState(0)
  const [readingSince] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt == null) return
    const id = setInterval(() => setDone((d) => Math.min(TOTAL, d + 17)), 700)
    return () => clearInterval(id)
  }, [startedAt])
  return <section id="job-progress-example"><h3>JobProgress</h3>
    <p>A background job in a dialog. The count is a polite live region and uses tabular numerals, so the line does not move as it changes; the elapsed time ticks each second and is not announced.</p>
    <Button onClick={() => { setDone(0); setStartedAt(Date.now()) }}>{startedAt == null ? 'Start example job' : 'Restart example job'}</Button>
    {startedAt != null && <JobProgress label="Saving changes" value={done} max={TOTAL} detail={`${done} of ${TOTAL} records`} startedAt={startedAt}
      note="You can close this window. The job continues in Nexus." />}
    <p>When the size is unknown, the bar moves without a count.</p>
    <JobProgress label="Reading file" startedAt={readingSince} />
  </section>
}
