import type { PortalBand } from '../../../shell/frame'
import type { Translate } from '../../../../lib/i18n/messages'
import type { Repair } from './api'
import { LIMITS, repairHref, stageTone, type RepairTab } from './model'

/**
 * The frame's band of a repair's page (SCR-358; design portal.customer.returns rec "Return", the same for a repair): the
 * title, the stage, "Add photos" while the work has not started (held with why), the link tabs Status · Request (its
 * photos counted). One builder for the live page and its design cases.
 */
export function repairBandOf(input: { t: Translate; listTitle: string; repair: Repair; tab: RepairTab; prefix: string; photosHeld: string | null; onPhotos?: () => void }): PortalBand {
  const { t, repair } = input
  const takes = repair.actions.addPhotos !== 'STAGE'
  return {
    title: t('portal.record.title', { number: repair.number, kind: t(`common.kind.${repair.kind}`) }),
    back: { href: `${input.prefix}/returns`, label: input.listTitle },
    status: { label: t(`common.stage.${repair.stage}`), tone: stageTone(repair) },
    actions: takes ? [{ id: 'photos', label: t('portal.request.addPhotos'), variant: repair.estimate?.status === 'SENT' ? 'secondary' : 'primary', heldReason: input.photosHeld ? t(input.photosHeld, { max: LIMITS.photos }) : null, onClick: () => input.onPhotos?.() }] : [],
    more: [],
    tabs: {
      label: t('portal.record.tabs'),
      active: input.tab,
      items: [
        { id: 'status', label: t('portal.record.status'), href: repairHref(input.prefix, repair.id, 'status') },
        { id: 'request', label: t('portal.record.request'), href: repairHref(input.prefix, repair.id, 'request'), ...(repair.photos.length > 0 ? { count: repair.photos.length } : {}) },
      ],
    },
    keys: [
      { keys: ['←', '→'], words: t('portal.keys.tabs') },
      { keys: ['Esc'], words: t('portal.keys.close') },
    ],
  }
}
