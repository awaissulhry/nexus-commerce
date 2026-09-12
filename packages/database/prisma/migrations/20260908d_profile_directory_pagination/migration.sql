CREATE INDEX IF NOT EXISTS "WorkspaceMembership_profile_page_idx"
  ON "WorkspaceMembership" ("userId", status, "createdAt", id);
