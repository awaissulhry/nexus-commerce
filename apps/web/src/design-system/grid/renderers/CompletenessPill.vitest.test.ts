// @vitest-environment node
/**
 * LX.F P3-22b — this file was `CompletenessPill.vitest.test.tsx` and therefore NEVER
 * RAN: `apps/web/vitest.config.ts:30` collects only files whose name ends `.vitest.test.ts`, and the
 * config's own header warns that a test that cannot run is worse than no test. It was
 * the ONE `.tsx` test in the repo and it was LX-era. Renamed rather than widening the
 * glob — widening would admit a future `.tsx` test that DOES assume a DOM, which is
 * what this node-only config exists to prevent — and the JSX became `createElement`,
 * the convention `ProjectionCell.vitest.test.ts` documents for the same situation.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { CompletenessPill } from './CompletenessPill'
it('renders an explicit unknown score, without a fabricated percentage or bar', () => {
  const html = renderToStaticMarkup(createElement(CompletenessPill, { pct: null, state: 'errors', tip: 'OUTERWEAR contract not loaded' }))
  expect(html).toContain('—')
  expect(html).toContain('aria-label="OUTERWEAR contract not loaded"')
  expect(html).not.toContain('%')
  expect(html).not.toContain('nds-readypill-track')
})
it('retains a measured zero and the independent error tone', () => {
  const html = renderToStaticMarkup(createElement(CompletenessPill, { pct: 0, state: 'errors' }))
  expect(html).toContain('0%')
  expect(html).toContain('nds-readypill-danger')
})
