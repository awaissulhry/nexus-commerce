'use client'
import NextLink from 'next/link'
import { usePathname } from 'next/navigation'
import { forwardRef, type ComponentProps } from 'react'
import { workspaceFromPath, workspaceHref } from './paths'
const Link = forwardRef<HTMLAnchorElement, ComponentProps<typeof NextLink>>(function WorkspaceLink({ href, ...props }, ref) {
  const id = workspaceFromPath(usePathname() ?? '/')
  const scoped = typeof href === 'string' ? workspaceHref(id, href) : href.hostname || href.host || href.protocol ? href : { ...href, pathname: workspaceHref(id, href.pathname ?? '/') }
  return <NextLink {...props} ref={ref} href={scoped} />
})
export default Link
export type { LinkProps } from 'next/link'
