'use client'

import { CheckList, type CheckItem } from '@nexus/ui/patterns/checklist/index'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import type { WarrantyCheck } from '../api'
import { warrantyLines, type CheckState } from '../model'
import { useWords } from '../parts'

const DS_STATE: Record<CheckState, CheckItem['state']> = { OK: 'pass', OPEN: 'fail', NOT_NEEDED: 'skipped', UNKNOWN: 'unknown', WARNING: 'warning' }

/**
 * The warranty check as a gate in words (design case.warranty "GateChecklist (new)" = the DS CheckList, B-W2b-18, with this
 * page's own state words: Applies · No longer · Does not apply · Unknown · Check — never colour alone): the delivery day, who
 * the customer is to the guarantee, the legal guarantee, the consumer's first-year presumption and the factory guarantee, each
 * with a sentence of ours (never the API's English).
 */
export function WarrantyLines({ check, label }: { check: WarrantyCheck; label: string }) {
  const { t, say } = useWords()
  const ds = useDsWords()
  const checks: CheckItem[] = warrantyLines(check).map((line) => ({
    id: line.id,
    state: DS_STATE[line.state],
    name: say(line.name) ?? '',
    detail: line.more ? `${say(line.text)} · ${say(line.more)}` : (say(line.text) ?? ''),
    ...(line.fix ? { fix: say(line.fix) ?? '' } : {}),
  }))
  const states = { ...ds.checkList.states, pass: t('checkState.pass'), fail: t('checkState.fail'), skipped: t('checkState.skipped'), unknown: t('checkState.unknown'), warning: t('checkState.warning') }
  return <CheckList label={label} checks={checks} summary={false} labels={{ ...ds.checkList, states }} />
}
