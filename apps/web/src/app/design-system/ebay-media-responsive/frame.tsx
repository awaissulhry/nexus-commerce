'use client'
import { useRef, useState } from 'react'
import { Button } from '@/design-system/primitives'

export function ResponsiveMediaFrame() {
  const frame = useRef<HTMLIFrameElement>(null)
  const [measurement, setMeasurement] = useState<unknown>(null)
  const measure = () => {
    const doc = frame.current?.contentDocument
    const media = doc?.querySelector<HTMLElement>('[aria-label="Media"]')
    if (!doc || !media) return
    setMeasurement({
      viewport: doc.documentElement.clientWidth, documentWidth: doc.documentElement.scrollWidth,
      mediaWidth: media.clientWidth, mediaScrollWidth: media.scrollWidth,
      theme: doc.documentElement.classList.contains('dark') ? 'dark' : 'light',
      focus: { tag: doc.activeElement?.tagName, label: doc.activeElement?.getAttribute('aria-label') || (doc.activeElement?.matches('button, summary, h2') ? doc.activeElement.textContent?.trim().slice(0, 100) : undefined) },
      regions: [...doc.querySelectorAll<HTMLElement>('[role="dialog"], [aria-label="Source images"], [aria-label="Listing photo preview"]')].map(region => ({
        label: region.getAttribute('aria-label') || doc.getElementById(region.getAttribute('aria-labelledby') ?? '')?.textContent,
        width: region.clientWidth, scrollWidth: region.scrollWidth, height: region.clientHeight, scrollHeight: region.scrollHeight,
      })),
      controls: [...media.querySelectorAll('button, select')].filter(control => control.getBoundingClientRect().height > 0).map(control => ({
        name: control.getAttribute('aria-label') || control.textContent?.trim(),
        height: control.getBoundingClientRect().height,
      })),
    })
  }
  return <section aria-label="Responsive Media verification" style={{ position: 'fixed', inset: 0, zIndex: 'var(--nds-z-overlay)', display: 'flex', alignItems: 'flex-start', gap: 'var(--nds-space-16)', padding: 'var(--nds-space-16)', overflow: 'auto', background: 'var(--nds-bg)', color: 'var(--nds-text)' }}>
    <iframe ref={frame} title="eBay Media at 390 pixels" width={390} height={844}
      style={{ border: 0, display: 'block' }}
      src="/products/p/edit/studio?scope=EBAY&market=IT&tab=images&account=b&listing=listing-b" />
    <div><Button onClick={measure}>Measure layout</Button>
      <pre aria-label="Media layout measurements">{JSON.stringify(measurement, null, 2)}</pre></div>
  </section>
}
