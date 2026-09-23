# Running the import on a schedule

One pass is `npm run update`: fetch the account, add anything new to the
record in Supabase, write `data/snapshot.json`. It exits non-zero if anything
failed, which is what makes it safe to drive from a timer. Nothing is drawn —
the page lives in `trading-journal-frontend` and reads Supabase for itself.

## Setting up Supabase (once)

1. Create a project at supabase.com. The free tier is plenty for the record.
2. In the SQL editor, paste and run `supabase/schema.sql`. It creates the
   tables, the append-only triggers and the read-only policies.
3. In Storage, create a **private** bucket named `videos`. Nothing uses it yet.
4. Under Project Settings → API, copy the project URL and the *secret* key into
   `.env` as `SUPABASE_URL` and `SUPABASE_SECRET_KEY`.

Run `npm run update` once by hand. The first pass records the whole history;
every later pass reports how many rows were new, usually zero.

### If a run says a row on record is missing or differs

The import never deletes or overwrites a broker row, and Postgres refuses to
let anyone else do so either. So the run stops and names the ids. It means one
of three things: MetaApi returned a short history (check the account is
deployed and connected), the broker pruned or amended a deal (rare, and worth
knowing about), or the account in `.env` changed. Look at the row in the table
editor next to what `data/snapshot.json` says. If the broker really did amend
it, drop the trigger in the SQL editor, fix the row by hand, and recreate the
trigger from `supabase/schema.sql`. Nothing is ever fixed silently.

There is a fourth cause, and it has happened: MetaApi restating a field that
was never settled. `openPrice` on an order read as the working price while the
position was open and as 0 once it closed, so a row recorded mid-trade stopped
every run that followed for thirteen hours. The answer was not to correct one
row but to stop recording the field — `UNSETTLED_FIELDS` in `metaapi.ts`, and
`supabase/2026-09-22-drop-open-price.sql` for the rows already stored. If a
run names a row that differs in a field nothing reads, suspect this before
suspecting the broker. It happened again on 2026-09-22 with `stopLoss` and
`takeProfit` on a closing order — fresh, it carried the position's levels;
re-read from history, neither. Only the order that opened a position keeps
them now, and `supabase/2026-09-23-drop-closing-order-levels.sql` brings the
rows already stored into line.

## On App Platform

`.do/app.yaml` describes the whole app: one scheduled job, every fifteen
minutes, no web service. Create the app from the GitHub repository and the
spec is picked up. Then, under the job's environment variables, enter the
five values from `.env.example`. They are declared in the spec as secrets
without values on purpose.

Check it from the control panel: the job's Runtime Logs show one line per
pass, the same line `npm run update` prints. Or from the CLI:

```sh
doctl apps list                                   # the app id
doctl apps logs <app-id> update --type run        # what recent passes said
```

Node is pinned to 24 or newer in `package.json` because the buildpack would
otherwise pick 22, which cannot run this code. The buildpack's newest is 25.x.

The job's disk is thrown away after each run, so `data/snapshot.json` exists
only for the seconds the pass takes. The record in Supabase is the only thing
that persists, which is the point.

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

The `accounts` table carries `fetched_at` for exactly this, and it only moves
once a pass has recorded every row, so it is readable from anywhere the UI is.
Locally, `data/snapshot.json` carries the same instant as `fetchedAt`. Anything
older than about an hour means the feed has stopped, whatever the timer says:

```sh
node -e 'const t=new Date(require("./data/snapshot.json").fetchedAt);
  const mins=(Date.now()-t)/60000;
  console.log(mins.toFixed(0)+"m old");
  process.exit(mins > 60 ? 1 : 0)'
```

Note that quiet is normal outside market hours: forex closes Friday 22:00 UTC
until Sunday 22:00. Alert on the age of the last *successful fetch*, never on
an absence of new deals.
