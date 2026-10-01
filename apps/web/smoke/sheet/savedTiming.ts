import { expect, type Locator, type Page } from '@playwright/test'

interface Snapshot { start: number | null; pending: number | null; saved: number | null; failed: string | null }

// Keep the browser probe self-contained, like the existing render counter. Standalone TS loaders must not
// introduce module-local callback helpers into a function serialized for page.evaluate.
const ARM = `(() => {
  window.__sheetSavedTiming?.stop();
  const footer = document.querySelector('.nds-grid-sheet-status');
  if (!footer) throw new Error('The actual sheet save status is not mounted');
  const state = { start: null, pending: null, saved: null, failed: null };
  const inspect = () => {
    if (state.start === null || state.saved !== null || state.failed) return;
    const refusal = footer.querySelector('.nds-grid-sheet-status-refused, .nds-grid-sheet-note.refusal, .nds-grid-sheet-note.offline');
    if (refusal) { state.failed = refusal.textContent?.trim() || 'Save refused or unconfirmed'; return; }
    if (footer.querySelector('.nds-grid-sheet-status-pending')) { state.pending ??= performance.now(); return; }
    if (state.pending !== null && [...footer.children].some(node => node.matches('span.nds-cell-muted') && /^Saved [0-9]{2}:[0-9]{2}/.test(node.textContent?.trim() ?? ''))) state.saved = performance.now();
  };
  const key = event => {
    if (state.start !== null || event.key !== 'Enter' || event.isComposing) return;
    if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) || !event.target.closest('.ag-popup-editor')) return;
    state.start = performance.now();
    inspect();
  };
  const observer = new MutationObserver(inspect);
  const probe = { snapshot: () => ({ ...state }), stop: () => {
    observer.disconnect();
    document.removeEventListener('keydown', key, true);
    if (window.__sheetSavedTiming === probe) delete window.__sheetSavedTiming;
  } };
  window.__sheetSavedTiming = probe;
  observer.observe(footer, { subtree: true, childList: true, characterData: true });
  document.addEventListener('keydown', key, true);
})()`

/** Observe the footer only. Never replace a listener or change application state. */
export async function armSavedTiming(page: Page): Promise<void> {
  await page.evaluate(ARM)
}

export async function readSavedTiming(page: Page, timeout = 15_000): Promise<{ pendingMs: number; savedMs: number }> {
  try {
    await page.waitForFunction(`(() => { const state = window.__sheetSavedTiming?.snapshot(); return !!state && (state.saved !== null || state.failed !== null); })()`, null, { timeout })
  } catch (error) {
    throw new Error(`The edit did not show a fresh Saving-to-Saved confirmation: ${String(error)}`)
  }
  const state = await page.evaluate('window.__sheetSavedTiming?.snapshot()') as Snapshot | undefined
  if (!state) throw new Error('Save timing was disposed before confirmation')
  if (state.failed) throw new Error(`Save refused or unconfirmed: ${state.failed}`)
  if (state.start === null || state.pending === null || state.saved === null) throw new Error('Missing real Saving-to-Saved timestamps')
  return { pendingMs: state.pending - state.start, savedMs: state.saved - state.start }
}

export async function stopSavedTiming(page: Page): Promise<void> {
  await page.evaluate('window.__sheetSavedTiming?.stop()')
}

/** Caller supplies a visible writable scalar cell. A rendered row alone is not this witness. */
export async function firstEditableScalarMs(page: Page, cell: Locator, timeout = 15_000): Promise<number> {
  await cell.focus()
  await page.keyboard.press('Enter')
  const input = page.locator('.ag-popup-editor input, .ag-popup-editor textarea').first()
  try {
    await expect(input).toBeFocused({ timeout })
    await expect(input).toBeEditable({ timeout })
    return await page.evaluate(() => performance.now())
  } finally {
    await page.keyboard.press('Escape')
    await expect(page.locator('.ag-popup-editor')).toBeHidden({ timeout })
  }
}
