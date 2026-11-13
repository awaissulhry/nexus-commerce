'use client'

import { Globe } from 'lucide-react'
import { Button, Tag } from '@nexus/ui/primitives'
import { FollowupsMessages, useFollowupsWords } from '../../../../lib/options-followups/words'

/**
 * An order line's artwork file in the customer's portal (B-W2b-374; XF3:04): "In the portal" when it is shown, and the
 * button that shows it there or takes it out (held with why for a person who does not manage the order). A view: the
 * configurator's container sends the change (PUT …/artwork/:fileId/portal) and reads the line again.
 */
export function PortalShare({ shown, may, onShare }: { shown: boolean; may: boolean; onShare?: (shown: boolean) => void }) {
  return (
    <FollowupsMessages>
      <Share shown={shown} may={may} onShare={onShare} />
    </FollowupsMessages>
  )
}

function Share({ shown, may, onShare }: { shown: boolean; may: boolean; onShare?: (shown: boolean) => void }) {
  const { t } = useFollowupsWords()
  return (
    <>
      {shown && (
        <Tag tone="info">
          <Globe size={12} aria-hidden /> {t('share.shown')}
        </Tag>
      )}
      <Button size="sm" variant="ghost" heldReason={may ? null : t('share.held')} onClick={() => onShare?.(!shown)}>
        {t(shown ? 'share.hide' : 'share.show')}
      </Button>
    </>
  )
}
