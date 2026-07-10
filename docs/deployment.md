# Deployment to VPS

VPS уже инициализирован (см. план). Этот документ — про деплой кода и настройку Caddy.

## Один раз

```bash
# на VPS, под пользователем trader (не root)
ssh trading-vps "su - trader -c 'mkdir -p ~/apps && cd ~/apps && git clone https://github.com/trafficangel/trading-agent.git && cd trading-agent && pnpm install && pnpm migrate'"
```

Скопировать .env (НЕ из git):

```bash
scp .env.production trading-vps:/home/trader/apps/trading-agent/.env
ssh trading-vps "chown trader:trader /home/trader/apps/trading-agent/.env && chmod 600 /home/trader/apps/trading-agent/.env"
```

## systemd unit

`/etc/systemd/system/trading-agent.service`:

```ini
[Unit]
Description=trading-agent
After=network.target

[Service]
Type=simple
User=trader
WorkingDirectory=/home/trader/apps/trading-agent
Environment=NODE_ENV=production
ExecStart=/usr/bin/node --enable-source-maps dist/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now trading-agent
sudo journalctl -u trading-agent -f
```

## SQLite backup timer

The backup job uses SQLite's online Backup API, verifies `quick_check`, copies
the result to a separate restore-drill file, verifies it again, and only then
updates `data/backups/latest.json`. It runs every six hours and retains the 12
newest successful snapshots.

```bash
sudo cp ops/systemd/trading-agent-backup.service /etc/systemd/system/
sudo cp ops/systemd/trading-agent-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now trading-agent-backup.timer
sudo systemctl start trading-agent-backup.service
sudo systemctl status trading-agent-backup.service
```

Restore is deliberately two-step and refuses to overwrite the configured live
database. Stop the service, restore to a new path, inspect it, then replace the
database while the service remains stopped:

```bash
sudo systemctl stop trading-agent
sudo -u trader node dist/ops/sqlite-restore.js data/backups/<snapshot>.sqlite data/trading.sqlite.restored
sudo -u trader sqlite3 data/trading.sqlite.restored 'PRAGMA quick_check;'
# Move the damaged DB/WAL aside, then rename trading.sqlite.restored to trading.sqlite.
sudo systemctl start trading-agent
```

## Caddy

`/etc/caddy/Caddyfile`:

```
<домен> {
  reverse_proxy 127.0.0.1:3000
  encode zstd gzip
  log {
    output file /var/log/caddy/access.log
    format console
  }
}
```

```bash
sudo systemctl reload caddy
```

Caddy сам выпишет TLS-сертификат от Let's Encrypt при первом запросе. Проверь:

```bash
curl -I https://<домен>/health
```

## Деплой обновлений

```bash
ssh trading-vps "cd /home/trader/apps/trading-agent && git pull && pnpm install --frozen-lockfile && pnpm build && pnpm migrate && sudo systemctl restart trading-agent"
```
