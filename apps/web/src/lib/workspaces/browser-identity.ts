let userId: string | null = null
export function setBrowserUserId(id: string | null) { userId = id }
export function browserUserId() { return userId }
