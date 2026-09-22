# Editing the schedule from a Google Sheet

Set times change on site. This lets you change them without a redeploy.

The live sheet is **Noc Valley Schedule + Announcements** in your *Noc Valley*
Drive folder:
`https://docs.google.com/spreadsheets/d/12ejn4glVJzReUPuUHynot28ashmALTlNKS1RSatr0hY/edit`
Three tabs: **Events** (all 83 sets from the posters), **Announcements**, and
**Changes**. Delete the two earlier half-built sheets in that folder.

## The sheet

The **first tab** is read, whatever it is named, with this header row — exactly these column names,
in any order, extra columns ignored:

| id | title | track | day | start | end | note |
|----|-------|-------|-----|-------|-----|------|
| a-gjones | G Jones | astral | fri | 20:00 | 22:00 | |
| n-peekaboo | PEEKABOO b2b LYNY | nocturnal | thu | 20:00 | 21:30 | back to back |

Trailing blank cells are fine — a row can stop after `title` and the rest
reads as "to be announced".

## Setup — service-account key (private sheet, works anywhere)

Use this when the platform will not hand the server a token. The server signs
its own assertion with the key and trades it for one, so no metadata server is
involved and nothing is published.

1. `gcloud services enable sheets.googleapis.com`
2. Make a key for a service account:
   ```
   gcloud iam service-accounts create sheets-reader
   gcloud iam service-accounts keys create key.json \
     --iam-account=sheets-reader@PROJECT_ID.iam.gserviceaccount.com
   ```
3. Share the sheet with `sheets-reader@PROJECT_ID.iam.gserviceaccount.com` as
   **Viewer**.
4. Put the whole contents of `key.json` in `SCHEDULE_SA_KEY`. Base64 is
   accepted too (`base64 -w0 key.json`) if the newlines give the console
   trouble. Secret Manager is a better home for it than a plain env var.

`SCHEDULE_SA_KEY` takes precedence over the metadata server, so setting it
ends the question of whether the platform will cooperate.

## Setup — published CSV (no credentials at all)

Fewest moving parts, and the one to use unless the sheet holds something you
would not put on a public page. The URL is readable by anyone who has it; a
set-time grid is not a secret.

**File → Share → Publish to web** → the **Events** tab → **Comma-separated
values (.csv)** → Publish. Put that URL in `SCHEDULE_EVENTS_CSV_URL` and leave
`SCHEDULE_SHEET_ID` unset (it wins if both are set).
`SCHEDULE_TRACKS_CSV_URL` does the same for the stage list.

## Setup — private sheet via the service account

The sheet stays private. Nothing is published, no API key or JSON credential
file exists anywhere: Cloud Run mints a token for its own service account at
request time.

1. **Enable the Sheets API** once for the project:
   `gcloud services enable sheets.googleapis.com`

2. **Find the service account** the service runs as:
   ```
   gcloud run services describe nocturnal-valley-festival-app \
     --region us-central1 --format='value(spec.template.spec.serviceAccountName)'
   ```
   If that comes back empty the service is on the Compute Engine default
   account, `PROJECT_NUMBER-compute@developer.gserviceaccount.com` — here that
   is `47119367007-compute@developer.gserviceaccount.com`.

3. **Share the sheet** with that address as **Viewer**, the same way you would
   share with a person.

4. **Set `SCHEDULE_SHEET_ID`** in Cloud Run → Edit & Deploy → Variables, to the
   id from the sheet URL — the part between `/d/` and `/edit`:
   `https://docs.google.com/spreadsheets/d/`**`1AbC...xyz`**`/edit`

   Optional: `SCHEDULE_EVENTS_TAB` to read a tab other than the first one,
   and `SCHEDULE_TRACKS_TAB` to drive the stage list from a second tab
   (`id,name,kind,sound,color`).

Deploy once. From then on, editing the sheet is all it takes.

### If it does not work

The Sync button shows the reason verbatim:

- *"The service account cannot read this sheet"* — step 3 was missed, or the
  Sheets API is not enabled. Sharing with the wrong address looks identical,
  so check it against step 2.
- *"No sheet with id …"* — `SCHEDULE_SHEET_ID` is wrong.
- *"Row … start: … is not a time"* — a cell in start/end is not `HH:MM`.
- *"Could not get a service-account token"* — only Cloud Run can mint one;
  this is expected if you are running the service locally.

## When the service-account route will not start

`/api/diag` prints what every metadata attempt returned, which env vars are
set (never their values), and whether `K_SERVICE` says this is Cloud Run at
all. If a token cannot be minted there, use the published-CSV route above
rather than fighting it -- it reaches the same sheet by a different door.

## The columns

- **id** — any stable string, unique per row. Keep it the same when you edit a
  row: it is what ties a phone's starred sets and local corrections to the act.
  Changing an id orphans both.
- **title** — what shows on the card.
- **track** — a track id from `public/schedule.json`: `astral`, `nocturnal`,
  `forest`, `renegade`, `workshops`, `art`, `wellness`. Blank means "stage to
  be announced" and the act is listed below the grid.
- **day** — `wed`, `thu`, `fri`, `sat`. Blank means time to be announced.
- **start** / **end** — 24-hour `HH:MM`. **After midnight counts on from the
  day the night started**: a 1:30am finish on Friday night is `25:30`, not
  `01:30`. Blank both for an act with no time yet.

  Sheets treats anything past 24:00 as a duration and stores it as
  `25:30:00`. That is read correctly — no need to fight it. A value that is
  not a time at all fails loudly and names the row.
- **note** — optional line under the title ("2-hour reverse journey set").

Stages themselves come from the bundled `schedule.json`. To edit those from a
sheet too, publish a second one with `id,name,kind,sound,color` and set
`SCHEDULE_TRACKS_CSV_URL`.

## How phones get it

Nothing is pushed. A phone with signal sees "A newer schedule is published"
on the Schedule tab and pulls it with **Sync**. The pulled copy is stored on
the device, so it stays put once the signal goes. The server re-reads the
sheet at most once a minute.

**Anyone's own corrections survive a sync.** Edits are patches keyed by event
id, applied over whatever the published schedule says, so a sync updates
everything a person has not personally touched and leaves what they have.
That is also why ids need to stay stable.

If neither is set, `/api/schedule` answers 503 and the app uses the schedule
that shipped with the build. On the CSV path, a sheet you meant to publish
but did not returns HTML instead of CSV, and the error says exactly that.


---

# Announcements and change history

The **Announcements** and **Changes** tabs are where an automation — or a
person — records what the organisers posted and what it did about it. The app
shows these behind the bell in the top right.

## Announcements

| column | what goes in it |
|--------|-----------------|
| `id` | stable, unique, e.g. `ann-0007`. Reused when revising the same news. |
| `at` | ISO timestamp, `2026-09-25T19:30:00Z`. Sorting is newest first. |
| `kind` | `change`, `lineup`, `weather` or `announcement`. `example` is never shown. |
| `title` | one line, shown in bold |
| `body` | a sentence or two |
| `url` | link to the original post — the app links straight out to it |
| `status` | `active`, or `reverted` once undone |
| `revision` | starts at 1; bump it when the same post is corrected |

Bumping `revision` re-lights the bell for everyone, even for people who
already read revision 1. That is the mechanism for "they posted it, then
changed their mind".

## Changes

One row per field actually altered, so every edit can be undone.

| column | what goes in it |
|--------|-----------------|
| `id` | unique, e.g. `chg-0021` |
| `announcementId` | the `id` of the announcement that caused it |
| `eventId` | the `id` from the Events tab |
| `field` | `start`, `end`, `track`, `day`, `title` or `note` |
| `oldValue` | **what it was before** — this is what makes an undo possible |
| `newValue` | what it was changed to |
| `at` | ISO timestamp |
| `status` | `applied`, or `reverted` |

## Reverting

1. Put every `oldValue` back into the matching Events cell.
2. Set those Changes rows to `status = reverted`.
3. Set the announcement to `status = reverted`.

The post stays visible in the app, greyed out and marked *reverted*, with its
changes no longer listed — so people who acted on the old information can see
it was taken back rather than having it silently vanish.

Nothing in the app writes to the sheet. The server only reads, so a bug on a
phone can never corrupt the source of truth.

## For the automation

Write to the sheet with the Sheets API. Give the automation's own account
**Editor** on the sheet; the Cloud Run service account stays **Viewer**.

- Never change an `id` in the Events tab. Starred sets and people's own
  corrections are keyed to it.
- Always write the `oldValue` before overwriting a cell.
- Post the announcement row and the change rows in the same run, so the app
  never shows a change with no explanation.
- Announcements are part of the version hash, so posting one is itself enough
  to tell phones there is something to sync.
