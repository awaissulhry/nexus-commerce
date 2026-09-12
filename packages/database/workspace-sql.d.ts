/** Guard application raw SQL before Prisma adds its own transaction statements. */
export declare function assertWorkspaceSql(method: string, args: unknown[]): void;
