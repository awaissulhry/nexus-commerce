import { Pool, type PoolClient } from 'pg';
/** Inspect the LOGIN identity, even if this connection is already SET ROLE'd. */
export declare function auditRuntimeRole(client: Pick<PoolClient, 'query'>): Promise<void>;
type ConnectCallback = (error: Error | undefined, client: PoolClient | undefined, done: (error?: Error | boolean) => void) => void;
/** Verify each physical connection before either pg or Prisma can borrow it. */
export declare class RuntimePool extends Pool {
    private readonly verified;
    connect(): Promise<PoolClient>;
    connect(callback: ConnectCallback): void;
}
export {};
