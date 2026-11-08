/**
 * EndState (B-W2b-155) — an entry point of its own, NOT re-exported by the components barrel (the web pulls that barrel
 * into every page's first load; this part brings its own stylesheet). Import this folder
 * (`@/design-system/components/EndState` in the web, `@nexus/ui/components/EndState/index` by package path).
 */
export { EndState, type EndStateCopy, type EndStateFact, type EndStateProps } from './EndState'
export { END_STATE_LABELS, type EndStateLabels } from './EndStateLabels'
export {
  END_STATE_TONES,
  endStateActionView,
  endStateSteps,
  mailtoOf,
  telOf,
  type EndStateAction,
  type EndStateContact,
  type EndStateTone,
} from './endStateModel'
