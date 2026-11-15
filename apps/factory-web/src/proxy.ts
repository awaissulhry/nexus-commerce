import { NextResponse, type NextRequest } from 'next/server'
import { withReceivedForwardedForAside } from './lib/api/forwarded'

/**
 * B-W2b-F57 (Next.js "proxy", the former middleware): on every request, before any route handler or server component, the
 * X-Forwarded-For this web received is moved aside (lib/api/forwarded.ts), so the `x-forwarded-for` Next.js then writes
 * is this request's TCP peer. Only lib/api/forwarded.ts decides what of the received chain travels on to the API (only
 * from a trusted edge). Every path but Next's own static files: a page's server render calls the API as well.
 */
export function proxy(request: NextRequest): NextResponse {
  return NextResponse.next({ request: { headers: withReceivedForwardedForAside(request.headers) } })
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
}
