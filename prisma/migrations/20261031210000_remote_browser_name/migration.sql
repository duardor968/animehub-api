-- What the PC lists for each linked browser ("Chrome en Windows"); older links have none.
ALTER TABLE "RemoteLink" ADD COLUMN "browserName" TEXT;
