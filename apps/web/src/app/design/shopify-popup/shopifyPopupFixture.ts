/**
 * Wires the lab's stand-in Shopify store (`labStandIn.ts`) to `fetch`, for the LAB PRODUCT only. Installed once, on the lab
 * page. Every other request goes to the real API untouched. The made-up store itself is `@nexus/shared/shopify-lab-store`
 * (one copy for the lab and the Shopify tests; the repository is public, so every name and id there is invented).
 */
import { answerLab } from './labStandIn'

let installed = false
export function installLabShopify() {
  if (typeof window === 'undefined' || installed) return
  installed = true
  const real = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    let body: unknown = undefined
    try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined } catch { body = undefined }
    const answer = answerLab(method, url, body)
    if (!answer) return real(input, init)
    /* A short wait, like a real store, so loading states are seen. */
    await new Promise(resolve => setTimeout(resolve, 150))
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } })
  }
}
