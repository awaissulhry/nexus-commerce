import type { Page } from '@playwright/test'

/** Use the real page's installed auth fetch wrapper, including its CSRF token. No app guard is bypassed. */
export async function browserMutation<T>(page: Page, workspace: string, path: string, method: 'POST' | 'PATCH' | 'PUT', data: unknown): Promise<{ status: number; body: T }> {
  if (!path.startsWith('/backend/api/products/')) throw new Error('Only the current local product API may be mutated')
  return page.evaluate(async ({ workspace, path, method, data }) => {
    const response = await window.fetch(path, { method, credentials: 'include', redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-nexus-workspace-id': workspace }, body: JSON.stringify(data) })
    return { status: response.status, body: await response.json() }
  }, { workspace, path, method, data })
}
