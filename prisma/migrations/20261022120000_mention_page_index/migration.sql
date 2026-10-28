-- Without this, every SourcePage delete (cascade from SourceSite) scans the whole DomainMention table.
CREATE INDEX IF NOT EXISTS "DomainMention_sourcePageId_idx" ON "DomainMention"("sourcePageId");
