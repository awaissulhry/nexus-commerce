'use client'

/**
 * VT.2c — the sheet's host for VT.4's dry-run plan modal (`ThemeChangePlanModal`).
 *
 * Design §3.5's locked-commit rule, end to end: the operator changes the axis SET (or the theme) on a
 * LIVE coordinate in the sheet's variation-theme cell → `variationThemeWrite` returns `send: false`
 * with a `plan` → `commitVariationTheme` writes NOTHING and asks for the plan → this component fetches
 * it with `dryRun: true` and opens the modal.
 *
 * 🔴 It is mounted by `ProductSheet`'s CHANNEL adapter (`ListingAdapter`) and by nothing else, because
 * MASTER has no locked coordinate to plan for: `variation-rules.service.ts` returns `locked: null` for
 * the master scope, so a plan can only be reached from a channel sheet. A second mount would open two
 * modals for one commit — and `ChannelSheet.tsx`, which looks like the channel sheet's entry point, is
 * a compatibility wrapper the studio does not use (measured: the first mount there was never reached).
 *
 * 🔴 Zero writes, by construction: `fetchThemeChangePlan` sends `dryRun: true` as a literal and the
 * route accepts no other value (VT.4's `themeChangePlan.vitest.test.ts` asserts it on the captured
 * body). This component adds no other call.
 */
import { useEffect, useState } from 'react'

import { ThemeChangePlanModal, fetchThemeChangePlan, type ThemeChangePlan } from './ThemeChangePlanModal'
import { onThemeChangePlanAsked } from './themePlanAsk'

export function ThemeChangePlanHost() {
  const [open, setOpen] = useState(false)
  const [plan, setPlan] = useState<ThemeChangePlan | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() =>
    onThemeChangePlanAsked((ask) => {
      /* Open FIRST, with `plan: null` — the modal's own loading state. Waiting for the fetch would
         leave a commit that visibly did nothing for as long as the round trip takes, which is the
         "did my change save?" gap this whole path exists to close. */
      setPlan(null)
      setError(null)
      setOpen(true)
      void (async () => {
        try {
          setPlan(await fetchThemeChangePlan(ask.request))
        } catch (e) {
          /* The server's sentence, verbatim; if there is none, the lock sentence that refused the
             write — never an empty modal, which would read as "nothing happened". */
          setError(e instanceof Error ? e.message : String(e) || ask.reason)
        }
      })()
    }),
  [])

  return <ThemeChangePlanModal open={open} onClose={() => setOpen(false)} plan={plan} error={error} />
}
