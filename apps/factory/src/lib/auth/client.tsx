/**
 * F1 — client auth context (S3 pattern, single-origin simplified): one
 * /api/auth/me round-trip powers all client gating. Anonymous users on
 * protected routes are redirected to /login; a no-flash splash covers the
 * resolving state. usePermission/<Can> gate UI; the server remains the boundary.
 */
"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { apiJson, ensureCsrf } from "@/lib/api-client";

type MeResponse = {
  user: { id: string; email: string; displayName: string; roleKeys: string[] } | null;
  isOwner?: boolean;
  permissions?: string[];
};

type AuthState = {
  status: "loading" | "authed" | "anon";
  user: MeResponse["user"];
  isOwner: boolean;
  permissions: Set<string>;
  has: (permission: string) => boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

const PUBLIC_PREFIXES = ["/login"];
const isPublicPath = (p: string) => PUBLIC_PREFIXES.some((pre) => p === pre || p.startsWith(pre + "/"));

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [me, setMe] = useState<MeResponse>({ user: null });
  const pathname = usePathname();
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      await ensureCsrf();
      const data = await apiJson<MeResponse>("/api/auth/me");
      setMe(data);
      setStatus(data.user ? "authed" : "anon");
    } catch {
      setMe({ user: null });
      setStatus("anon");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (status === "anon" && !isPublicPath(pathname)) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [status, pathname, router]);

  const value = useMemo<AuthState>(() => {
    const permissions = new Set(me.permissions ?? []);
    const isOwner = !!me.isOwner || permissions.has("*");
    return {
      status,
      user: me.user,
      isOwner,
      permissions,
      has: (p) => isOwner || permissions.has(p),
      refresh: load,
      logout: async () => {
        const { apiFetch } = await import("@/lib/api-client");
        await apiFetch("/api/auth/logout", { method: "POST" });
        setMe({ user: null });
        setStatus("anon");
      },
    };
  }, [status, me, load]);

  if (status === "loading" && !isPublicPath(pathname)) {
    return <div aria-busy="true" style={{ minHeight: "100dvh", background: "var(--h10-bg)" }} />;
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

export const usePermission = (permission: string): boolean => useAuth().has(permission);

export function Can({
  permission,
  fallback = null,
  children,
}: {
  permission: string;
  fallback?: React.ReactNode;
  children: React.ReactNode;
}) {
  return usePermission(permission) ? <>{children}</> : <>{fallback}</>;
}
