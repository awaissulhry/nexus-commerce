'use client'

/**
 * Reviews › Settings › Emails & unsubscribes — our review e-mails to eBay and Shopify buyers (Amazon sends its own and
 * keeps its own opt-out list).
 *
 * The sender name, address and reply-to are the business identity every buyer e-mail carries (build spec ruling 4):
 * shown read-only here, changed in Settings › Company only ("Change in Settings › Company", a new tab), so
 * there is one edit path. The review button of each e-mail goes to the buyer's own eBay site or this business's own
 * shop (review-links.service.ts); a business with no shop sends Shopify buyers no button, and this page says so. The unsubscribe link is always on (no control: every marketing e-mail must let the buyer opt
 * out). Then the unsubscribe list (UnsubscribeList.tsx).
 */
import { ExternalLink } from 'lucide-react'
import { Banner, Card, KeyValue } from '@/design-system/components'
import { Button, Pill, Skeleton } from '@/design-system/primitives'
import Link from '@/lib/workspaces/Link'
import { ReadFailed } from './ReadFailed'
import type { SenderView } from './settingsForm'
import type { SuppressionRow } from './settingsModel'
import { UnsubscribeList } from './UnsubscribeList'
import type { SettingsRead } from './useSettingsRead'
import s from './settings.module.css'

export interface EmailsSectionProps {
  sender: SenderView | null
  senderError: string | null
  onRetrySender: () => void
  /** null = the person may not see the unsubscribe list. */
  suppressions: SettingsRead<{ rows: SuppressionRow[] }> | null
}

export function EmailsSection({ sender, senderError, onRetrySender, suppressions }: EmailsSectionProps) {
  return (
    <div className={s.section}>
      <p className={s.lead}>Our review e-mails to eBay and Shopify buyers. Amazon sends its own and keeps its own opt-out list.</p>

      <Card header="Sender" headingLevel={3} description="Who our review e-mails come from, and where replies go.">
        {senderError && !sender ? (
          <ReadFailed error={senderError} onRetry={onRetrySender} />
        ) : !sender ? (
          <Skeleton height={96} />
        ) : (
          <>
            {sender.problem && <Banner tone="warning" title="Buyers get no review e-mail from this business yet.">{sender.problem}</Banner>}
            {sender.shopReviewHeld && <Banner tone="info" title="No review button for Shopify buyers.">{sender.shopReviewHeld}</Banner>}
            <KeyValue
              columns={3}
              labelCase="sentence"
              items={[
                { label: 'Sender name', value: sender.name ?? '—' },
                { label: 'Sender address', value: sender.address ?? '—' },
                { label: 'Replies go to', value: sender.replyTo ?? '—' },
                { label: 'Review button (Shopify)', value: sender.shopReviewPage ?? 'None' },
                { label: 'Review button (eBay)', value: 'The buyer’s own eBay site' },
              ]}
            />
            <div className={s.senderFoot}>
              <span className={s.hint}>From Settings › Company. The sender is changed there only, for every e-mail of this business.</span>
              <Button size="sm" asChild>
                <Link href={sender.editHref} target="_blank" rel="noopener noreferrer">
                  Change in Settings › Company <ExternalLink size={13} aria-hidden focusable={false} />
                </Link>
              </Button>
            </div>
          </>
        )}
      </Card>

      <Card header="Unsubscribe link" headingLevel={3}>
        <div className={s.alwaysOn}>
          <Pill tone="success" dot>Always on</Pill>
          <span className={s.hint}>Every review e-mail carries an unsubscribe link. Every marketing e-mail must let the buyer opt out, so it cannot be turned off.</span>
        </div>
      </Card>

      <UnsubscribeList read={suppressions} />
    </div>
  )
}
