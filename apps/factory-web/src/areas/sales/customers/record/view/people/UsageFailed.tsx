'use client'

import { CircleAlert } from 'lucide-react'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { Quiet } from '../../../../orders/record/view/production/Kit'
import { said } from '../../people/model'
import { sentenceOf, usePeopleSay } from './say'

/**
 * F-CA-fx4 (customer page › PEOPLE & ADDRESSES tab, lane ca-; 18-lead-settles Z25, walk W-09) — the usage read failed: ONE quiet line in
 * People and ONE in Addresses — "Couldn't read what is open on them", the read's own problem words (the kit's `problem.read.*`) and Try
 * again, which reads only the usage read again. Never a 0 and never a line per row; while the read is out nothing is said. Draws only.
 */
export function UsageFailed({ problem, onRetry }: { problem: string; onRetry?: (() => void) | undefined }) {
  const say = usePeopleSay()
  const locale = useLocale()
  return (
    <Quiet>
      <CircleAlert size={14} aria-hidden />
      <span role="status">
        {sentenceOf([say(said('used.failed'))], locale)} {say(said(`orders:${problem}`))}
        {onRetry ? (
          <>
            {' '}
            <button type="button" className="fw-pt-link" onClick={onRetry}>
              {say(said('orders:common.retry'))}
            </button>
          </>
        ) : null}
      </span>
    </Quiet>
  )
}
