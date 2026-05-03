/**
 * Patch the systemd unit on the Pi to add RuntimeDirectory=managet,
 * restart the agent, and re-run the smoke test.
 */
import { readFileSync, existsSync } from "node:fs";
import { Client } from "ssh2";
import Database from "better-sqlite3";
import { decryptPassword } from "../src/lib/crypto";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const db = new Database("data/managet.db", { readonly: true });
const pi = db
  .prepare("SELECT host, port, username, password_encrypted FROM servers WHERE id = ?")
  .get("98ec98f1-5157-40b5-bb46-07f5b13948c0") as any;
db.close();
const piPwd = decryptPassword(pi.password_encrypted);

const NEW_UNIT = `[Unit]
Description=ManageT monitoring agent
Documentation=https://github.com/andrei/managet
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/managet-agent run
Restart=on-failure
RestartSec=5s
User=root
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/etc/managet-agent
RuntimeDirectory=managet
RuntimeDirectoryMode=0755

[Install]
WantedBy=multi-user.target
`;

function exec(c: Client, cmd: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    c.exec(cmd, (err, s) => {
      if (err) return reject(err);
      let out = "";
      let er = "";
      s.on("data", (d: Buffer) => (out += d.toString()));
      s.stderr.on("data", (d: Buffer) => (er += d.toString()));
      s.on("close", (code: number | null) => resolve({ code: code ?? -1, out, err: er }));
    });
  });
}
function sudo(c: Client, cmd: string) {
  return exec(c, `echo ${JSON.stringify(piPwd)} | sudo -S -p '' bash -c ${JSON.stringify(cmd)}`);
}
function sftpPut(c: Client, buf: Buffer, remote: string): Promise<void> {
  return new Promise((resolve, reject) => {
    c.sftp((err, sftp) => {
      if (err) return reject(err);
      const ws = sftp.createWriteStream(remote, { mode: 0o644 });
      ws.on("close", () => resolve());
      ws.on("error", reject);
      ws.end(buf);
    });
  });
}

async function main() {
  const c = new Client();
  await new Promise<void>((res, rej) => {
    c.on("ready", () => res());
    c.on("error", rej);
    c.connect({ host: pi.host, port: pi.port, username: pi.username, password: piPwd, readyTimeout: 30000 });
  });

  console.log("[1] Writing new systemd unit");
  await sftpPut(c, Buffer.from(NEW_UNIT), "/tmp/managet-agent.service.new");
  await sudo(c, "cp /tmp/managet-agent.service.new /etc/systemd/system/managet-agent.service && chmod 644 /etc/systemd/system/managet-agent.service && rm -f /tmp/managet-agent.service.new && systemctl daemon-reload && systemctl restart managet-agent");
  await new Promise((r) => setTimeout(r, 2500));

  console.log("[2] Service state");
  console.log((await sudo(c, "systemctl is-active managet-agent; ls -la /var/run/managet/")).out.trim());

  console.log("[3] managet-agent ls (as andrei)");
  console.log((await exec(c, "/usr/local/bin/managet-agent ls 2>&1")).out.trim());

  console.log("[4] managet-agent new -n smoke");
  const newSess = await exec(c, "/usr/local/bin/managet-agent new -n smoke 2>&1");
  console.log(newSess.out.trim());

  console.log("[5] managet-agent ls again");
  console.log((await exec(c, "/usr/local/bin/managet-agent ls 2>&1")).out.trim());

  console.log("[6] Recent journal");
  console.log((await sudo(c, "journalctl -u managet-agent --no-pager -n 10")).out.split("\n").slice(-12).join("\n"));

  console.log("[7] managet-agent kill smoke");
  console.log((await exec(c, "/usr/local/bin/managet-agent kill smoke 2>&1")).out.trim());

  c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
