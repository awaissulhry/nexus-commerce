import React, { forwardRef } from 'react'
export default forwardRef<HTMLAnchorElement, any>(function Link({ href, prefetch, ...props }, ref) { return <a {...props} ref={ref} href={href} /> })
