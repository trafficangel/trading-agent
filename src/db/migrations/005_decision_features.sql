-- Outcome enrichment: structured features extracted at decision time.
-- Enables post-hoc analysis: which confidence buckets win, which cited
-- levels predict profitable outcomes, which prompt versions performed
-- better, etc.
--
-- Single JSON column instead of separate columns so we can iterate on
-- the feature set without further migrations.

ALTER TABLE decisions ADD COLUMN features_json TEXT;

-- Index on prompt_version-like queries would require a generated column;
-- skip for now, full-table-scan is fine on a small (< 10K rows) decisions
-- table. Add proper indexes once features are stable.
