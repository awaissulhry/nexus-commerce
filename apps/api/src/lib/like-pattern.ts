/**
 * MCP.12 — text a caller typed, as the literal part of a LIKE pattern.
 *
 * In a SQL LIKE (and in Prisma's `contains` / `startsWith` / `endsWith`, which build one and do not escape it) `_`
 * matches any one character and `%` any run of them, so a SKU such as `A_B` also found `AXB`, and a search for `%`
 * found every product. Escaped here with PostgreSQL's default escape character, so each one stands for itself.
 * Moved from channel.tools.ts, where it was written for the listing tools, so every tool uses the one rule.
 */
export const likeEscaped = (text: string) => text.replace(/[\\%_]/g, '\\$&')
