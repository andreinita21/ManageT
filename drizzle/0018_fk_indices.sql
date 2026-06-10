-- 0018_fk_indices: index hot foreign-key columns.
--
-- SQLite does not auto-index FK columns. With foreign_keys=ON (enabled in
-- src/lib/db/index.ts) every parent delete scans children, and the app's
-- frequent lookups by these columns (sessions by server/stack/group, command
-- history, alerts, CLI tokens) were doing full table scans. All are created
-- IF NOT EXISTS so this is safe to (re)apply by hand.

CREATE INDEX IF NOT EXISTS sessions_server_id_idx ON sessions (server_id);
CREATE INDEX IF NOT EXISTS sessions_stack_id_idx ON sessions (stack_id);
CREATE INDEX IF NOT EXISTS sessions_group_id_idx ON sessions (group_id);

CREATE INDEX IF NOT EXISTS command_history_session_id_idx ON command_history (session_id);
CREATE INDEX IF NOT EXISTS command_history_server_id_idx ON command_history (server_id);

CREATE INDEX IF NOT EXISTS alerts_server_id_idx ON alerts (server_id);

CREATE INDEX IF NOT EXISTS user_cli_tokens_user_id_idx ON user_cli_tokens (user_id);

CREATE INDEX IF NOT EXISTS stack_services_stack_id_idx ON stack_services (stack_id);
CREATE INDEX IF NOT EXISTS stack_services_server_id_idx ON stack_services (server_id);
