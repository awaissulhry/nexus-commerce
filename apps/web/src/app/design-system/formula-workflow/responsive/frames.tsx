'use client'
import { useEffect, useState } from 'react'
export function ResponsiveFrames() {
  const [measurements, setMeasurements] = useState<Record<string, unknown>>({})
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.kind !== 'formula-measurement' || !event.data.result) return
      const result = event.data.result
      setMeasurements(current => ({ ...current, [`${result.viewport}-${result.theme}`]: result }))
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [])
  return <section aria-label="Responsive formula verification">
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--nds-space-16)' }}>
      {[320, 768].flatMap(width => ['light', 'dark'].map(theme => <iframe key={`${width}-${theme}`} title={`Formula workflow at ${width} pixels in ${theme} mode`} src={`/design-system/formula-workflow?dialog=apply&theme=${theme}`} width={width} height={800} style={{ border: 0 }} />))}
    </div>
    <pre aria-label="Formula accessibility measurements" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(measurements, null, 2)}</pre>
  </section>
}
