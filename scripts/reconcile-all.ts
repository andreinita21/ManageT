/** Drive reconcileServer for every managed server so stale sessions
 *  get marked closed and any new ones surface in the dashboard DB. */
import { readFileSync, existsSync } from "node:fs";
import Database from "better-sqlite3";
import { reconcileServer } from "../src/lib/ssh/session-manager";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const db = new Database("data/managet.db", { readonly: true });
const servers = db
  .prepare("SELECT id, name FROM servers")
  .all() as { id: string; name: string }[];
db.close();

(async () => {
  for (const s of servers) {
    process.stdout.write(`${s.name} … `);
    try {
      const rows = await reconcileServer(s.id);
      console.log(`${rows.length} rows (${rows.filter((r) => r.status === "active").length} active)`);
    } catch (err) {
      console.log(`fail: ${err instanceof Error ? err.message : err}`);
    }
  }
  process.exit(0);
})();
