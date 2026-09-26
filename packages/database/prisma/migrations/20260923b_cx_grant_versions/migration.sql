ALTER TABLE "ChannelConnection" ADD COLUMN "grantVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ChannelConnection" ADD CONSTRAINT "ChannelConnection_grant_version_check"
  CHECK ("grantVersion" >= 0);
