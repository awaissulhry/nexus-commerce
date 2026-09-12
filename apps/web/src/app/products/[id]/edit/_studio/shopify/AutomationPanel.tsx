'use client'
import { Activity, Pause, Play, ShieldCheck } from 'lucide-react'
import type { ShopifyLinkedWorkspace } from '@nexus/shared/shopify-linked-products'
import { Card } from '@/design-system/components'
import { Button, Pill } from '@/design-system/primitives'
import styles from './linked.module.css'

export function AutomationPanel({ workspace, disabled, dirty, canPublish, onReview, onMode, onCheck }: {
  workspace: ShopifyLinkedWorkspace; disabled: boolean; dirty: boolean; canPublish: boolean; onReview(): void; onCheck(): void
  onMode(mode: 'PAUSED' | 'MONITOR'): void
}) {
  const automation = workspace.automation, mode = automation?.mode ?? 'PAUSED'
  const attention = ['NEEDS_REVIEW', 'ERROR'].includes(automation?.status ?? '')
  return <Card header="Automation" description="Set the rules once. Review the exceptions." headerAction={<Pill dot tone={attention ? 'warning' : mode === 'AUTOMATIC' ? 'success' : 'neutral'}>{mode === 'AUTOMATIC' ? 'Automatic' : mode === 'MONITOR' ? 'Monitor only' : 'Paused'}</Pill>}>
    <div className={styles.stack}>
      <div className={styles.automationStep}><Activity size={18} aria-hidden /><div><strong>Check every five minutes</strong><p className={styles.hint}>Family links and shared content are checked even when this page is closed.</p></div></div>
      <div className={styles.automationStep}><ShieldCheck size={18} aria-hidden /><div><strong>Keep individual control</strong><p className={styles.hint}>Product overrides stay independent. Conflicting Shopify edits stop for review.</p></div></div>
      {automation?.message && <p className={attention ? styles.validation : styles.hint} role="status">{automation.message}</p>}
      {automation?.lastCheckedAt && <p className={styles.hint}>Last checked <time dateTime={automation.lastCheckedAt}>{new Date(automation.lastCheckedAt).toLocaleString()}</time>{automation.changes > 0 && ` · ${automation.changes} pending changes`}</p>}
      <div className={styles.toolbar}>
        {mode !== 'AUTOMATIC' && <Button size="sm" variant="primary" disabled={disabled || !canPublish || !workspace.draft.members.length} onClick={onReview}><Play size={14} aria-hidden />Review & enable</Button>}
        {mode === 'PAUSED' ? <Button size="sm" disabled={disabled || dirty || !canPublish || !workspace.draft.members.length} onClick={() => onMode('MONITOR')}>Monitor only</Button>
          : <><Button size="sm" disabled={disabled || dirty || !canPublish} onClick={onCheck}>Check now</Button><Button size="sm" disabled={disabled || !canPublish} onClick={() => onMode('PAUSED')}><Pause size={14} aria-hidden />Pause</Button></>}
      </div>
      <p className={styles.hint}>Saving new rules pauses automation until you review them.</p>
    </div>
  </Card>
}
