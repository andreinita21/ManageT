-- 0020_host_key_fingerprint: store the SSH host key fingerprint per server.
--
-- Learned on first connect (trust-on-first-use) and verified on every
-- subsequent connect by connection-pool.ts. Existing servers have NULL and
-- will learn their fingerprint on the next connection.

ALTER TABLE servers ADD COLUMN host_key_fingerprint text;
