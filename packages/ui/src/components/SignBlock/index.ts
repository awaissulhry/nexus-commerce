/**
 * The sign / accept block (gap G12) — an entry point of its own, NOT re-exported by the components barrel (the web pulls
 * that barrel into every page's first load, and this part brings the floor kit's `FloorButton` and its stylesheet).
 * Import this folder (`@/design-system/components/SignBlock` in the web, `@nexus/ui/components/SignBlock/index` by
 * package path).
 */
export { SignBlock, type SignAcceptance, type SignAcknowledgement, type SignBlockProps, type SignBlockState, type SignEmailCheck } from './SignBlock'
export {
  emailLooksValid,
  emailMatches,
  nameMatches,
  nameWords,
  signCanAccept,
  signProblems,
  type SignInput,
  type SignProblems,
  type SignRules,
} from './signBlockModel'
