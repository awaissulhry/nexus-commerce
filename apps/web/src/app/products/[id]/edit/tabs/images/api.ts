// All fetch calls in the images workspace must hit the Fastify backend
// (Railway) not the Next.js server (Vercel). Use beFetch() instead of
// fetch() for every /api/... call in this subtree.
import { getBackendUrl } from '@/lib/backend-url'

export async function beFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${getBackendUrl()}${path}`, init)
}
