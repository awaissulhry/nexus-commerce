/**
 * Read-aloud (B-W2b-28, D27) — an entry point of its own, NOT re-exported by the floor barrel (`floor/`): no Commerce
 * page and no existing floor screen carries it until it imports this folder (`@/design-system/floor/ReadAloud` in the
 * web, `@nexus/ui/floor/ReadAloud/index` by package path). Its stylesheet comes with the component.
 */
export { ReadAloudButton, useSpeechVoice, type ReadAloudButtonProps } from './ReadAloudButton'
export { READ_ALOUD_LABELS, type ReadAloudLabels } from './ReadAloudLabels'
export { pickVoice, speechChunks, voiceLangScore, type SpeechVoiceLike } from './readAloudModel'
