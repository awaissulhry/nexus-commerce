/**
 * Which ONE rail row is the current page — moved into the design system (`@nexus/ui` patterns/shell/app-rail-active.ts)
 * with the rail on 2026-10-28. This file keeps the old import path for the web code that still uses it
 * (`components/layout/AppShell.tsx`).
 */
export { hrefMatchesPath, resolveActiveNav, type ActiveNavMatch, type ActiveNavNode } from '@/design-system/patterns/shell'
