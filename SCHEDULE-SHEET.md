# Editing the schedule from a Google Sheet

Set times change on site. This lets you change them without a redeploy.

The live sheet is **Noc Valley Schedule** in your *Noc Valley* Drive folder:
`https://docs.google.com/spreadsheets/d/1QLeHwH0sGYN4pHWGYwHMfYu7mEcgreYNuxulXg-Vn7I/edit`
It already holds all 83 sets from the Thursday/Friday/Saturday posters.

## The sheet

The **first tab** is read, whatever it is named, with this header row — exactly these column names,
in any order, extra columns ignored:

| id | title | track | day | start | end | note |
|----|-------|-------|-----|-------|-----|------|
| a-gjones | G Jones | astral | fri | 20:00 | 22:00 | |
| n-peekaboo | PEEKABOO b2b LYNY | nocturnal | thu | 20:00 | 21:30 | back to back |

Trailing blank cells are fine — a row can stop after `title` and the rest
reads as "to be announced".

## Setup — private sheet (preferred)

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

## Setup — published CSV (fallback)

Simpler, but **the CSV URL is readable by anyone who gets hold of it**, so do
not use it for anything you would not put on a public page.

**File → Share → Publish to web** → the sheet → **Comma-separated values
(.csv)** → publish, then set `SCHEDULE_EVENTS_CSV_URL` to the URL
(`https://docs.google.com/spreadsheets/d/e/2PACX-.../pub?gid=0&single=true&output=csv`).
`SCHEDULE_TRACKS_CSV_URL` does the same for stages.

`SCHEDULE_SHEET_ID` wins if both are set.

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
