/**
 * PartnerThread (B-W2b-155) — an entry point of its own, NOT re-exported by the patterns barrel (the web pulls that
 * barrel into every page's first load; this part brings its own stylesheet). Import this folder
 * (`@/design-system/patterns/PartnerThread` in the web, `@nexus/ui/patterns/PartnerThread/index` by package path).
 */
export { PartnerThread, type PartnerAttachment, type PartnerComposer, type PartnerMessage, type PartnerThreadProps } from './PartnerThread'
export { PARTNER_THREAD_LABELS, type PartnerThreadLabels } from './PartnerThreadLabels'
export {
  PARTNER_CHANNELS,
  PARTNER_SIDES,
  partnerAuthorName,
  partnerSendHeld,
  partnerToggleFile,
  type PartnerAuthor,
  type PartnerChannel,
  type PartnerSide,
} from './partnerThreadModel'
