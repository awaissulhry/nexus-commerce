import { createElement } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { GridViewsMenu } from './GridViewsMenu'
import type { GridStateApi } from '../hooks/useGridState'
it('retains a Views trigger without requiring a toast provider or fetching data', () => {
 const save = vi.fn()
 const views = { views: [], activeId: null, save } as unknown as GridStateApi<unknown>
 const html = render(createElement(GridViewsMenu, { views }))
 expect(html).toContain('nds-grid-views'); expect(html).toContain('aria-haspopup="menu"'); expect(html).toContain('Views')
 expect(save).not.toHaveBeenCalled()
})
