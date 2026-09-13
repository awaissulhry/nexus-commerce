import { useMemo } from 'react'
import { useRegisterViewChip } from '../contracts'
import { languageChips } from './languageChips'

export function useLanguageChips(rows: Parameters<typeof languageChips>[0], columns: Parameters<typeof languageChips>[1], registerAi = true) {
  const chips = useMemo(() => languageChips(rows, columns), [rows, columns])
  useRegisterViewChip('needs-translation', chips[0])
  // The master's AI overlay combines this fact with pending proposals in its existing registry slot.
  useRegisterViewChip(registerAi ? 'ai-drafts' : 'language-ai-unused', registerAi ? chips[1] : null)
  useRegisterViewChip('out-of-date', chips[2])
  return chips[1]
}
