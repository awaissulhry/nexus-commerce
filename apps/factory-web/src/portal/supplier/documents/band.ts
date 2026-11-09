import { formatTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import type { PortalBand } from '../../shell/frame'

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/**
 * The frame's band of the supplier's Documents (design portal.supplier.documents h: title, AsOf, "Upload a document"
 * primary, ⋯ the frame's "Ask a question"): one builder for the live page and its design cases. The page's keys (`u`
 * uploads, Enter opens) go in the shortcuts dialog.
 */
export function documentsBandOf(input: { t: Translate; locale: Locale; asOf: number | null; uploadHeld: string | null; onUpload?: () => void }): PortalBand {
  const { t, locale } = input
  return {
    title: t('documents.title'),
    status: input.asOf ? { label: t('band.updated', { time: formatTime(input.asOf, { locale }) }), tone: 'neutral' } : null,
    actions: [{ id: 'upload', label: t('documents.uploadOne'), variant: 'primary', heldReason: input.uploadHeld, ...(input.onUpload ? { onClick: input.onUpload } : {}) }],
    keys: [
      { keys: ['u'], words: t('keys.upload') },
      { keys: ['↵'], words: t('keys.open') },
    ],
  }
}
