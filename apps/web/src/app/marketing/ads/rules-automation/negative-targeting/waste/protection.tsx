'use client'

/**
 * Negative Targeting page, step 4 (2026-10-25) — what the Protected tile draws (words: protectionModel.ts).
 *
 *   chip    the protected term that keeps a row safe, on the row (its Term cell) and in its record: a DS DetailPopover
 *           (click, Enter, Space or a resting pointer) whose panel says each term's match, scope and why
 *   lead    the "Remove protection and stop" review's line above its table: what else each removed term keeps safe
 *   scope   where a removal lands in the review's table: the term's market (or every market) and campaign
 */
import { ShieldCheck } from 'lucide-react'
import { Pill } from '@/design-system/primitives'
import { Banner, DetailPopover } from '@/design-system/components'
import Link from '@/lib/workspaces/Link'
import {
  alsoKeepsLine, alsoKeepsTitle, protectionChipWords, protectionMatchWord, protectionScopeWords, protectionSentence,
} from './protectionModel'
import type { PreviewStep, ProtectionTerm, RowProtection } from './wasteTypes'
import styles from './protection.module.css'

const SHIELD = <ShieldCheck size={11} strokeWidth={2.5} aria-hidden className="nds-cell-glyph" />

/** One term's scope: its market and its campaign (a link). */
export function ProtectionScope({ term }: { term: Pick<ProtectionTerm, 'market' | 'campaign'> }) {
  return (
    <span className={styles.scope}>
      <span>{term.market ? `Amazon ${term.market}` : 'Every market'}</span>
      <span aria-hidden>·</span>
      {term.campaign?.href ? <Link href={term.campaign.href} className="nds-entitylink">{term.campaign.name}</Link> : <span>{term.campaign?.name ?? 'every campaign'}</span>}
    </span>
  )
}

/** The protected term on the row: a chip whose panel says each term's match, scope and why. */
export function ProtectionChip({ protection, returnFocus }: { protection: RowProtection; returnFocus?: () => void }) {
  const { label, more } = protectionChipWords(protection)
  return (
    <span data-protection-chip="" className={styles.chipWrap}>
      <DetailPopover
        trigger={(
          <Pill tone="success" size="sm" icon={SHIELD}>
            <span className={styles.chipText}>{label}</span>{more ? <span className={styles.more}>+{more}</span> : null}
          </Pill>
        )}
        triggerLabel={protectionSentence(protection)}
        triggerClassName={styles.chipButton}
        label="Protected term"
        hoverDelay={350}
        returnFocus={returnFocus}
      >
        <div className={styles.panel}>
          <div className="nds-detailpop-h">{protection.terms.length > 1 ? `${protection.terms.length} protected terms keep it safe` : 'Protected term'}</div>
          <ul className="nds-detailpop-list">
            {protection.terms.map((t) => (
              <li key={t.id} className={styles.term}>
                <span className={styles.termHead}>
                  <b className={styles.termWords}>{t.term}</b>
                  <Pill tone="neutral" size="sm">{protectionMatchWord(t.match)}</Pill>
                </span>
                <ProtectionScope term={t} />
                {t.reason ? <span className={styles.reason}>{t.reason}</span> : null}
              </li>
            ))}
          </ul>
          <p className="nds-detailpop-foot">No negative and no pause may stop it while the protection stands.</p>
        </div>
      </DetailPopover>
    </span>
  )
}

/** The review's lead: what else each removed protected term keeps safe, with the words it holds. */
export function AlsoKeepsLead({ steps }: { steps: readonly PreviewStep[] }) {
  const head = alsoKeepsTitle(steps)
  if (!head) return null
  const removing = steps.filter((s) => s.action === 'UNPROTECT' && !s.refusal && s.protection?.alsoKeeps)
  return (
    <Banner tone={head.tone} title={head.title}>
      {removing.map((s) => {
        const keeps = s.protection!.alsoKeeps!
        if (!keeps.count) return null
        return (
          <div key={s.protection!.id} className={styles.keeps}>
            <span className={styles.keepsHead}>
              <b>{s.protection!.term}</b> · {protectionMatchWord(s.protection!.match).toLowerCase()} · {protectionScopeWords(s.protection!)}
            </span>
            <ul className={styles.keepsList} aria-label={`What "${s.protection!.term}" also keeps safe`}>
              {keeps.terms.map((t) => (
                <li key={t.text}><Pill tone={t.wasting ? 'warning' : 'neutral'} size="sm">{alsoKeepsLine(t)}</Pill></li>
              ))}
              {keeps.count > keeps.terms.length && <li className={styles.moreLine}>and {keeps.count - keeps.terms.length} more</li>}
            </ul>
          </div>
        )
      })}
    </Banner>
  )
}
