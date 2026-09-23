# trading-journal

The record. A scheduled job that reads an MT5 account through MetaApi every
fifteen minutes and appends whatever is new to Supabase.

It draws nothing and interprets nothing. Every deal and order is stored exactly
as the broker booked it, and never edited or removed — a row already on record
that goes missing from the feed, or comes back different, stops the run with
the ids named, because either the broker has amended history or the fetch is
broken and both deserve a person rather than a sync.

## The other half

The page you look at is **trading-journal-frontend**: a static site on Vercel that
signs in to Supabase, reads this record in the browser, groups the deals into
round trips and works every figure out from them. It never talks to MetaApi and
never writes a broker row.

It does write two tables: `annotations`, the note, grade and tags you put
against a trade, and `tags`, the vocabulary those tags are chosen from. Those
are the only rows in Supabase neither the broker nor this job authored, which
is why they are the only ones with columns of their own and the only ones a
signed-in user is allowed to change. A project that ran `schema.sql` before
those tables existed brings itself up to date with
`supabase/2026-09-21-tags-and-grade.sql`. One that recorded orders before
2026-09-22 also needs `supabase/2026-09-22-drop-open-price.sql`, which drops a
field the import no longer keeps, and one that recorded a closing order before
2026-09-23 needs `supabase/2026-09-23-drop-closing-order-levels.sql` for the
same reason.

The third thing of yours is the tape: a clip you recorded of a trade. It goes in
the private Storage bucket `videos`, in a folder named by the MetaApi account id
and then the position id — `{account_id}/{position_id}/clip.mp4` — put there
from the trade's own tab on the page and streamed back from it. No table lists
them, because the bucket already knows which trades have one. The page can add
a clip but never replace or remove one; that is done in the dashboard. A
project set up before 2026-09-23 adds the bucket with
`supabase/2026-09-23-videos.sql` and the page's right to add to it with
`supabase/2026-09-23-videos-from-the-page.sql`, and every project raises the
upload limit under Project Settings → Storage, which starts at 50 MB. Export as
MP4, H.264 with AAC, with faststart on, so playback begins before the download
ends.

```
MetaApi ──▶ trading-journal ──▶ Supabase ──▶ trading-journal-frontend
            (fetch, append)     (the record) (read, rebuild, draw)
```

`supabase/schema.sql` is where the two meet. The same row shapes are declared
in the web repository's `src/rows.ts`; adding a field is safe from either side,
renaming or removing one needs both at once.

## The modules

| | |
|---|---|
| `src/metaapi.ts` | three GETs against MetaApi's REST API — no SDK |
| `src/supabase.ts` | three verbs against PostgREST — no SDK |
| `src/ledger.ts` | what the feed has that the record does not; refuses to shrink or change it |
| `src/update.ts` | one pass: fetch, append, log, exit |

## Running it

```sh
cp .env.example .env    # then fill it in
npm install
npm run update          # one pass
npm test
npm run typecheck
```

The MetaApi account must hold the MT5 **investor** password, which cannot
trade. `npm run update` warns on every run if MetaApi reports it is holding the
master password instead.

`SUPABASE_SECRET_KEY` bypasses row-level security, which is what lets this job
write the broker tables the web app may only read. It never leaves `.env` and
the server's environment.

## Deploying

DigitalOcean App Platform, as a scheduled job — `.do/app.yaml` is the spec, and
the five secrets are entered in the control panel rather than written into it.
There is no web service because nothing listens on a port. `deploy/` has
systemd and launchd units for running it on a machine you own instead.

Each run writes `data/snapshot.json`, the raw response, so a parsing question
can be re-asked offline. It carries the account holder's name and account
number, so `data/` stays out of git — and copying it into the web repository is
what makes that repository's one real-data test run.
