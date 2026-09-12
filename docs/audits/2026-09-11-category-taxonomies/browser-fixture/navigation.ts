export const usePathname = () => window.location.pathname
export const useSearchParams = () => new URLSearchParams(location.search)
export const useRouter = () => ({ push: (url: string) => location.assign(url), replace: (url: string) => location.replace(url), refresh: () => location.reload(), prefetch: () => {} })
