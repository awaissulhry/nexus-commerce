import { expect } from '@playwright/test'
import { keyPaths } from './_harness/checks'
import { defineStage } from './_harness/stages'

export default defineStage({
  proves: 'cost sheet: material by size + labour from minutes (finance sees the figures, complete; the production manager sees quantities and minutes, never a cost)',
  async run(flow) {
    const styleId = flow.state.style.id as string
    const revisionId = flow.state.style.revisionId as string
    const sheetPath = `/costing/styles/${styleId}/revisions/${revisionId}/cost-sheet`

    await flow.step('finance opens the Cost tab: a cost per garment, every input known', async () => {
      const finance = await flow.desk('finance')
      await finance.go(`/products/styles/${styleId}?tab=cost`)
      await expect(finance.page.getByText(/^Cost per garment/).first()).toBeVisible()
      await expect(finance.page.getByText('Every input known').first()).toBeVisible()
      await expect(finance.page.getByText(/€\s?\d/).first()).toBeVisible()
      await flow.shot(finance.page, 'cost-finance')
      const sheet = (await flow.read(finance.page, `${sheetPath}?companyId=${flow.companyId}`)).sheet
      expect(sheet).toMatchObject({ complete: true, estimate: false, currency: 'EUR', missing: [] })
      expect(sheet.cells.length).toBe(3)
    })

    await flow.step('the production manager opens the same tab: no cost figure, said in words', async () => {
      const manager = await flow.desk('manager')
      await manager.go(`/products/styles/${styleId}?tab=cost`)
      await expect(manager.page.getByText('Cost figures are not in your role: the sheet shows quantities, minutes and what is missing.').first()).toBeVisible()
      await expect(manager.page.getByText(/€\s?\d/)).toHaveCount(0)
      await flow.shot(manager.page, 'cost-manager')
      const blind = (await flow.read(manager.page, `${sheetPath}?companyId=${flow.companyId}`)).sheet
      expect(keyPaths(blind, /cost|total|amount/i).filter((path) => !/missing|complete/i.test(path))).toEqual([])
    })
  },
})
