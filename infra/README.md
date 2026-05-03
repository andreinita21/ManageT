# Infra

## managet systemd unit

Run the dashboard as a long-lived service:

```bash
sudo cp infra/managet.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now managet
```

Tail logs:

```bash
journalctl -u managet -f
```

The unit assumes the project lives at `/home/andrei/managet` and runs as the
`andrei` user. The dashboard listens on the port set in `.env.local`
(`PORT=3000` by default) and reads its other env from the same file.
