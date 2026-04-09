/**
 * Built-in pattern definitions for command classification.
 * These patterns are used as Tier 2 (built-in rules) in the classification pipeline.
 */

/**
 * Glob patterns for commands that are safe to automatically restart.
 * These are typically long-running, idempotent processes (dev servers, watchers, daemons).
 */
export const SAFE_PATTERNS: string[] = [
  // Node.js / JavaScript
  "npm run dev*",
  "npm start",
  "yarn dev*",
  "yarn start",
  "pnpm dev*",
  "pnpm start",
  "node *server*",
  "node *app*",
  "nodemon *",
  "ts-node *",
  "tsx *",

  // Frontend frameworks
  "next dev",
  "next start",
  "vite",
  "vite dev",
  "vite preview",
  "nuxt dev",

  // Python
  "python -m http.server*",
  "python *manage.py runserver*",
  "flask run*",
  "uvicorn *",
  "gunicorn *",

  // Rust
  "cargo run*",
  "cargo watch*",

  // Go
  "go run *",
  "air",

  // Java / JVM
  "java -jar *",
  "mvn spring-boot:run*",
  "gradle bootRun*",

  // PHP
  "php artisan serve*",

  // Ruby
  "rails server*",
  "rails s*",
  "bundle exec *server*",

  // Reverse proxies / containers
  "nginx -g 'daemon off;'*",
  "docker compose up*",
  "docker-compose up*",
  "docker run *",

  // Log / monitoring
  "tail -f *",
  "journalctl -f*",
  "watch *",
  "htop",
  "top",
  "btop",
  "less +F *",
  "ping *",
  "tcpdump *",
  "strace -p *",

  // Build watchers
  "npm run watch*",
  "npm run serve*",
  "webpack serve*",
  "webpack --watch*",
  "tsc --watch*",
  "tsc -w*",
  "jest --watch*",
  "vitest*",
  "pytest-watch*",
  "inotifywait *",
  "fswatch *",

  // Databases / services
  "redis-server*",
  "mongod*",
  "mysqld*",
  "postgres*",
  "caddy run*",
  "traefik*",
  "consul agent*",
  "vault server*",
];

/**
 * Glob patterns for commands that are dangerous and should never be auto-restarted.
 * These are destructive, non-idempotent, or state-mutating operations.
 */
export const DANGEROUS_PATTERNS: string[] = [
  // File system destructive
  "rm *",
  "rmdir *",
  "mv *",
  "cp *",
  "dd *",
  "mkfs*",
  "fdisk*",
  "parted*",
  "shred *",
  "truncate *",

  // HTTP mutating requests
  "curl -X POST *",
  "curl -X PUT *",
  "curl -X DELETE *",
  "curl -X PATCH *",
  "curl -d *",
  "curl --data *",
  "wget --post*",
  "http POST *",
  "http PUT *",
  "http DELETE *",

  // Git mutating
  "git push*",
  "git merge*",
  "git rebase*",
  "git reset*",
  "git checkout *",
  "git clean*",

  // Package publishing
  "npm publish*",
  "npm unpublish*",
  "yarn publish*",

  // Package management
  "pip install*",
  "pip uninstall*",
  "apt install*",
  "apt remove*",
  "apt purge*",
  "apt-get install*",
  "apt-get remove*",
  "yum install*",
  "yum remove*",
  "dnf install*",
  "dpkg *",
  "rpm *",

  // Docker destructive
  "docker rm *",
  "docker rmi *",
  "docker system prune*",
  "docker volume rm*",

  // Kubernetes / IaC
  "kubectl delete*",
  "kubectl apply*",
  "kubectl create*",
  "terraform apply*",
  "terraform destroy*",
  "ansible-playbook*",

  // Database commands
  "mysql -e *",
  "psql -c *",
  "mongo --eval*",
  "redis-cli FLUSHALL*",
  "redis-cli FLUSHDB*",
  "*DROP TABLE*",
  "*DROP DATABASE*",
  "*DELETE FROM*",
  "*TRUNCATE*",

  // Migrations
  "*migrate*",
  "alembic *",
  "prisma migrate*",
  "drizzle-kit push*",
  "knex migrate*",
  "rake db:*",

  // Permissions / users
  "chmod *",
  "chown *",
  "chgrp *",
  "useradd*",
  "userdel*",
  "passwd*",
  "visudo*",

  // Firewall / network
  "iptables*",
  "ufw *",
  "firewall-cmd*",

  // Systemd / services
  "systemctl start*",
  "systemctl stop*",
  "systemctl restart*",
  "systemctl enable*",
  "systemctl disable*",
  "service * start",
  "service * stop",
  "service * restart",

  // System control
  "reboot",
  "shutdown*",
  "poweroff",
  "init *",

  // Process management
  "kill *",
  "killall *",
  "pkill *",

  // Remote operations
  "ssh *",
  "scp *",
  "rsync *",
  "sftp *",

  // Scheduling
  "crontab *",
  "at *",

  // Build / deploy
  "make install*",
  "make deploy*",
  "make clean*",
  "npm run build*",
  "npm run deploy*",
  "yarn build*",
  "yarn deploy*",
  "cargo build --release*",
];
