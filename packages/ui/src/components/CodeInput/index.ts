/**
 * CodeInput (B-W2b-155) — an entry point of its own, NOT re-exported by the components barrel (the web pulls that barrel
 * into every page's first load; this part brings its own stylesheet). Import this folder
 * (`@/design-system/components/CodeInput` in the web, `@nexus/ui/components/CodeInput/index` by package path).
 */
export { CodeInput, type CodeInputProps, type CodeInputResend } from './CodeInput'
export { CODE_INPUT_LABELS, type CodeInputLabels } from './CodeInputLabels'
export { CODE_LENGTH, codeCells, codeCompletes, codeFromText, codeGapAfter, resendReady, type CodeCell } from './codeInputModel'
