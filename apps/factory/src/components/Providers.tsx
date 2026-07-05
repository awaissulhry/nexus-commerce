/**
 * F1 — client boundary for providers. The DS component barrel includes hooks
 * without 'use client' directives (fine inside client trees, fatal when a
 * SERVER layout imports the barrel) — so the root layout mounts THIS client
 * component instead of importing the DS directly. Keeps the DS copy
 * byte-identical to canonical (PROVENANCE rule 2).
 */
"use client";

import { ToastProvider } from "@/design-system/components";
import { AuthProvider } from "@/lib/auth/client";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <AuthProvider>{children}</AuthProvider>
    </ToastProvider>
  );
}
