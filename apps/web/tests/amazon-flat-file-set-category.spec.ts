/**
 * BN.2.2 — "Set category" toolbar action regression guard.
 *
 * Post-merge guard only — do NOT run against local dev; prod URL is required.
 * Asserts that selecting rows reveals a "Set category" button which opens
 * a dialog containing the "Browse node" picker.
 */
import { test, expect } from '@playwright/test'

test('amazon flat-file: Set category button is visible when rows are selected and opens the category dialog', async ({ page }) => {
  await page.goto('/products/amazon-flat-file?marketplace=IT&productType=COAT', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  })

  // Wait for the grid to render rows (at least the select-all checkbox in thead).
  const selectAllCheckbox = page.locator('thead input[type="checkbox"]').first()
  await expect(selectAllCheckbox).toBeVisible({ timeout: 20_000 })

  // "Set category" should NOT be visible before any row is selected.
  await expect(page.getByRole('button', { name: /Set category/ })).toBeHidden()

  // Select all rows via the header checkbox.
  await selectAllCheckbox.click()

  // "Set category (N)" button should now appear in Bar-3.
  const setCategoryBtn = page.getByRole('button', { name: /Set category/ })
  await expect(setCategoryBtn).toBeVisible({ timeout: 5_000 })

  // Clicking the button opens the modal dialog.
  await setCategoryBtn.click()

  // The dialog must contain the "Browse node" label.
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 })
  await expect(page.getByText('Browse node')).toBeVisible()

  // The dialog should also have a "Product type" label.
  await expect(page.getByText('Product type')).toBeVisible()

  // Cancel closes the dialog without applying.
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 5_000 })
})
