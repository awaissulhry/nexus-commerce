'use client'

/**
 * CHMAP — two versions of one form, column by column: added, removed, requirement changed, decision
 * changed. The server computes the difference (`diffMappingFields`); the older version is always the
 * lower version number, whichever one the operator started from.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { MappingDiff, MappingSetSummary } from '@nexus/shared/channel-mapping'
import { Button } from '@/design-system/primitives'
import { Banner, Drawer, SummaryTable } from '@/design-system/components'
import { num } from '@/design-system/lib/format'
import { diffMappingSets, errorText } from './api'
import { formLabel, requirementWord, STATE_WORD, targetLabel } from './model'
import styles from './files.module.css'

type Decision = MappingDiff['decisionChanged'][number]['from']

export function CompareDrawer({ current, other, onClose }: { current: MappingSetSummary; other: MappingSetSummary; onClose: () => void }) {
  const [newer, older] = current.version >= other.version ? [current, other] : [other, current]
  const [diff, setDiff] = useState<MappingDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setDiff(null); setError(null)
    diffMappingSets(newer.id, older.id, controller.signal)
      .then(result => { if (!controller.signal.aborted) setDiff(result) })
      .catch(e => { if (!controller.signal.aborted) setError(errorText(e)) })
    return () => controller.abort()
  }, [newer.id, older.id, attempt])

  const decision = (d: Decision) => `${STATE_WORD[d.state]} · ${targetLabel(d, current.channel)}`
  const total = diff ? diff.added.length + diff.removed.length + diff.requirementChanged.length + diff.decisionChanged.length : 0

  return (
    <Drawer open onClose={onClose} width={720} title={`Compare v${older.version} → v${newer.version}`} subtitle={formLabel(current)}
      footer={<Button onClick={onClose}>Close</Button>}>
      <div className={styles.drawerBody}>
        {error ? (
          <Banner tone="danger" title="The comparison could not load" action={<Button size="sm" onClick={() => setAttempt(n => n + 1)}>Try again</Button>}>{error}</Banner>
        ) : !diff ? (
          <p className={styles.plain} role="status">Comparing v{older.version} with v{newer.version}…</p>
        ) : (
          <>
            <p className={styles.plain} role="status">
              {total === 0
                ? `v${older.version} and v${newer.version} have the same columns and the same decisions.`
                : `${num(diff.added.length)} added · ${num(diff.removed.length)} removed · ${num(diff.requirementChanged.length)} requirement changed · ${num(diff.decisionChanged.length)} decision changed`}
            </p>
            <Section title={`Added in v${newer.version}`} count={diff.added.length}>
              <KeyList label={`Columns added in v${newer.version}`} keys={diff.added} />
            </Section>
            <Section title={`Removed since v${older.version}`} count={diff.removed.length}>
              <KeyList label={`Columns removed since v${older.version}`} keys={diff.removed} />
            </Section>
            <Section title="Requirement changed" count={diff.requirementChanged.length}>
              <SummaryTable label="Columns whose requirement changed" columns={['Column', `v${older.version}`, `v${newer.version}`]}
                rows={diff.requirementChanged.map(c => ({ id: c.channelKey, cells: [<span key="k" className={styles.key}>{c.channelKey}</span>, requirementWord(c.from), requirementWord(c.to)] }))} />
            </Section>
            <Section title="Decision changed" count={diff.decisionChanged.length}>
              <SummaryTable label="Columns whose decision changed" columns={['Column', `v${older.version}`, `v${newer.version}`]}
                rows={diff.decisionChanged.map(c => ({ id: c.channelKey, cells: [<span key="k" className={styles.key}>{c.channelKey}</span>, decision(c.from), decision(c.to)] }))} />
            </Section>
          </>
        )}
      </div>
    </Drawer>
  )
}

/** A list of channel keys. Not a one-column SummaryTable: that component right-aligns its last column for values. */
function KeyList({ label, keys }: { label: string; keys: string[] }) {
  return <ul className={styles.keyList} aria-label={label}>{keys.map(key => <li key={key} className={styles.key}>{key}</li>)}</ul>
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>{title} ({num(count)})</h3>
      {count === 0 ? <p className={styles.plain}>None.</p> : <div className={styles.tableScroll}>{children}</div>}
    </section>
  )
}
