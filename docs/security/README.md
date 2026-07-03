# Nexus Commerce — Security Workstream (Auth + RBAC)

Enterprise access control: hardened auth, role-based access control with page/feature/field permissions, an Owner-managed Team & Access console. Phases **S0–S5** (prefixed **S** to avoid collision with the product roadmap's Phase 2/Phase 4).

## Phase status

| Phase | Title | Status |
|---|---|---|
| **S0** | Discovery & architecture (read-only) | ✅ Complete ([report](./S0-AUDIT.md)) |
| **S1** | Authentication core | ✅ Complete + deployed ([report](./S1-REPORT.md)) |
| **S2** | RBAC engine (server-side enforcement) | ✅ Complete + deployed in shadow mode ([report](./S2-REPORT.md)) |
| **S3** | Frontend enforcement & UX (+ flip RBAC to enforce) | 🟡 Machinery built + deployed (shadow); go-live gated on owner password + enforce flip ([report](./S3-REPORT.md)) |
| S4 | Admin console (Settings › Team & Access) | — |
| S5 | MFA & hardening | — |

## S0 documents

| Document | What it contains |
|---|---|
| **[S0-AUDIT.md](./S0-AUDIT.md)** | **Start here.** Current-state truth, domain/cookie decision, session strategy, email/Redis verdicts, design-system summary, auth-library recommendation, and the **decisions needed at the gate**. |
| [S0-PERMISSION-REGISTRY.md](./S0-PERMISSION-REGISTRY.md) | Proposed permission registry (24 page + ~90 feature + 8 field perms), default 6-role matrix, channel-scoping design, and financial borderline calls needing a ruling. |
| [S0-SCHEMA.md](./S0-SCHEMA.md) | Proposed Prisma diff (Role/UserRole/Invitation/PasswordResetToken + extensions), staged reversible migration plan with rollback commands. |
| [S0-FINDINGS.md](./S0-FINDINGS.md) | Risk register — 4 critical, 5 high/med, 4 low. F1–F4 are internet-exposed today. |
| [S0-ENUMERATION-PAGES.md](./S0-ENUMERATION-PAGES.md) | All 310 web pages + 18 route handlers + nav architecture + public/admin flags. |
| [S0-ENUMERATION-ENDPOINTS.md](./S0-ENUMERATION-ENDPOINTS.md) | All 2,028 API endpoints, mount map, and special classes (webhooks/OAuth/SSE/downloads/admin). |
| [S0-ENUMERATION-FINANCIAL-FIELDS.md](./S0-ENUMERATION-FINANCIAL-FIELDS.md) | 327 models, existing auth models quoted, 191 restricted-financial fields classified. |
| [S0-DESIGN-SYSTEM.md](./S0-DESIGN-SYSTEM.md) | Design-system inventory for the Team & Access console (53 exports, 5 gaps, matrix precedents). |

## Non-negotiables (carried through every phase)

The server is the security boundary · deny by default · field-level security = server-side response filtering · Owner supremacy with guardrails · immediate propagation · least privilege · no hand-rolled crypto · everything auditable · server-side sessions · no secrets in the client bundle.
