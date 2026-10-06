'use client'

/**
 * CR rebuild 4 — Limits › Set on the server: what only a deploy changes, in plain words — the emergency switch, where
 * changes go (live or Amazon's test account), the most one change may be worth, and each engine's changes-per-hour
 * limit. Read-only on purpose: a control here would be a fake switch. The technical names stay under a Disclosure for
 * whoever changes them.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/design-system/primitives'
import { Banner, Card, Disclosure, KeyValue, SummaryTable } from '@/design-system/components'
import { getBackendUrl } from '@/lib/backend-url'
import { serverFacts, type EngineLimit, type Guardrails } from './limitsWords'
import styles from './limits.module.css'

export function ServerSettings() {
  const [g, setG] = useState<Guardrails | null>(null)
  const [gErr, setGErr] = useState<string | null>(null)
  const [limits, setLimits] = useState<EngineLimit[] | null>(null)
  const [limitsErr, setLimitsErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    // Two reads; one failing leaves the other on screen.
    void fetch(`${getBackendUrl()}/api/advertising/automation/state`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`The engine limits could not be read (${r.status}).`)
        const j = (await r.json()) as { engineLimits?: EngineLimit[] }
        if (!Array.isArray(j.engineLimits)) throw new Error('The server sent no engine limits.')
        setLimits(j.engineLimits); setLimitsErr(null)
      })
      .catch((e: unknown) => setLimitsErr((e as Error).message))
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/control-room/guardrails`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`The server settings could not be read (${r.status}).`)
      setG((await r.json()) as Guardrails); setGErr(null)
    } catch (e) { setGErr((e as Error).message) }
  }, [])
  useEffect(() => { void load() }, [load])

  const retry = <Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>
  const facts = g ? serverFacts(g) : null

  return (
    <div className={styles.stack}>
      <Banner tone="info" title="Only a deploy changes these">
        They are set on the server for every business. They are shown here so every limit is in one place.
      </Banner>

      <Card header="The server’s switches">
        {facts
          ? <KeyValue columns={3} items={facts.map((f) => ({ label: f.label, value: f.value, hint: f.hint }))} />
          : gErr
            ? <Banner tone="danger" title="Not read" action={retry}>{gErr}</Banner>
            : <span className={styles.muted}>Reading…</span>}
      </Card>

      <Card
        header="Each engine’s changes per hour"
        description="When one engine makes more changes than its limit within 60 minutes, Nexus stops all ads automation, as Stop now does."
      >
        {limits
          ? <SummaryTable
            label="Each engine’s changes per hour"
            columns={['Engine', 'Most changes per hour']}
            rows={limits.map((l) => ({ id: l.key, cells: [l.label, l.breakerPerHour.toLocaleString('en-GB')] }))}
          />
          : limitsErr
            ? <Banner tone="danger" title="Not read" action={retry}>{limitsErr}</Banner>
            : <span className={styles.muted}>Reading…</span>}
      </Card>

      <Disclosure summary="Technical details">
        <KeyValue
          items={[
            ...(facts ?? []).map((f) => ({ label: f.label, value: f.technical })),
            { label: 'Each engine’s changes per hour', value: 'NEXUS_ADS_ENGINE_CAPS, or the code’s defaults' },
          ]}
        />
      </Disclosure>
    </div>
  )
}
