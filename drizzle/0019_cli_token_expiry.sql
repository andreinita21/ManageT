-- 0019_cli_token_expiry: add an absolute expiry to CLI tokens.
--
-- Existing rows keep expires_at = NULL, which getUserIdForCliToken treats as
-- "no expiry" (legacy, still honored). New tokens minted by createCliToken set
-- it to now + 90 days. Safe to re-apply: the column add is guarded by hand.

ALTER TABLE user_cli_tokens ADD COLUMN expires_at integer;
