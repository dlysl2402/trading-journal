# Running the import on a schedule

One pass is `npm run update`: fetch the account, rebuild `equity.html`, write
`data/snapshot.json`. It exits non-zero if anything failed, which is what makes
it safe to drive from a timer.

## On the droplet

```sh
sudo cp deploy/trading-journal-update.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now trading-journal-update.timer
```

Check it:

```sh
systemctl list-timers trading-journal-update   # when it next fires
journalctl -u trading-journal-update -n 20     # what the last runs said
```

Adjust `User=` and `WorkingDirectory=` in the service file to match where the
checkout lives.

## On macOS

`com.trading-journal.update.plist` is the same schedule as a LaunchAgent.
Nothing is loaded until you say so:

```sh
cp deploy/com.trading-journal.update.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.trading-journal.update.plist
```

Check it, run one pass by hand, or stop it:

```sh
launchctl list | grep trading-journal
launchctl start com.trading-journal.update
tail -f /tmp/trading-journal-update.log
launchctl unload ~/Library/LaunchAgents/com.trading-journal.update.plist
```

Check `ProgramArguments` points at your node — the file assumes Homebrew's
`/opt/homebrew/bin/node`. The plist carries no credentials by design: it sets
`WorkingDirectory`, and `update.ts` reads `.env` from there.

A LaunchAgent only runs while you are logged in, and a pass due while the Mac
is asleep fires once on wake rather than catching up on each one missed.

## Knowing when it has stopped working

A failed run is loud — non-zero exit, message on stderr, visible in
`journalctl`. A run that silently stops happening is not, and that is the
failure worth watching for: a disconnected account keeps returning the last
known history rather than an error.

`data/snapshot.json` carries `fetchedAt` for exactly this. Anything older than
about an hour means the feed has stopped, whatever the timer says:

```sh
node -e 'const t=new Date(require("./data/snapshot.json").fetchedAt);
  const mins=(Date.now()-t)/60000;
  console.log(mins.toFixed(0)+"m old");
  process.exit(mins > 60 ? 1 : 0)'
```

Note that quiet is normal outside market hours: forex closes Friday 22:00 UTC
until Sunday 22:00. Alert on the age of the last *successful fetch*, never on
an absence of new deals.
