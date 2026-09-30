-- Approvals: the person who decided, not only the name shown. An approve from the Approvals page waits out the undo
-- window and is committed later by the page or the maintenance sweep; the commit re-checks THIS person's permissions
-- in the approval's business, so it needs their id. `decidedBy` stays the display name.
-- Additive only: one nullable column on an existing business-owned table. No policy change (the table's row-level
-- security covers every column); nothing existing is modified or read differently.

-- AlterTable
ALTER TABLE "AgentApproval" ADD COLUMN     "decidedByUserId" TEXT;
