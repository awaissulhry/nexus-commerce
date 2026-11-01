/**
 * PrivacyNote (B-W2b-28) — an entry point of its own, NOT re-exported by the components barrel (the web pulls that
 * barrel into every page's first load; this part brings its own stylesheet). Import this folder
 * (`@/design-system/components/PrivacyNote` in the web, `@nexus/ui/components/PrivacyNote/index` by package path).
 */
export { PrivacyNote, type PrivacyNoteProps } from './PrivacyNote'
export { PRIVACY_NOTE_LABELS, type PrivacyNoteLabels } from './PrivacyNoteLabels'
export { PRIVACY_LEVELS, privacyNoteText, privacyTone, type PrivacyLevel, type PrivacyTone } from './privacyNoteModel'
