'use client'

import { SegmentedControl } from '@nexus/ui/primitives'
import { useTplWords } from '../../template-editor/view/words'
import type { MailPart } from '../replies/model'

/**
 * B-TH-279: the E-mail templates section's two parts — "Mails Nexus sends" (the templates of the mails the code sends by itself)
 * and "Saved replies" (the messages people pick, fill and send themselves). The same DS SegmentedControl as the page's list switch.
 */
export function PartSwitch({ part, onPart }: { part: MailPart; onPart?: (part: MailPart) => void }) {
  const t = useTplWords()
  return (
    <SegmentedControl
      ariaLabel={t('tpl.replies.part.label')}
      size="sm"
      value={part}
      onChange={(value) => onPart?.(value as MailPart)}
      options={[
        { value: 'templates', label: t('tpl.replies.part.templates') },
        { value: 'replies', label: t('tpl.replies.part.replies') },
      ]}
    />
  )
}
