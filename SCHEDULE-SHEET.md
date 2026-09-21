# Editing the schedule from a Google Sheet

Set times change on site. This lets you change them without a redeploy.

## One-time setup

1. Make a Google Sheet with this header row, exactly these column names
   (order does not matter, extra columns are ignored):

   | id | title | track | day | start | end | note |
   |----|-------|-------|-----|-------|-----|------|
   | a-gjones | G Jones | astral | fri | 20:00 | 22:00 | |
   | n-peekaboo | PEEKABOO b2b LYNY | nocturnal | thu | 20:00 | 21:30 | back to back |

2. **File → Share → Publish to web**, choose the sheet, pick **Comma-separated
   values (.csv)**, publish, copy the URL. It looks like
   `https://docs.google.com/spreadsheets/d/e/2PACX-.../pub?gid=0&single=true&output=csv`

3. In Cloud Run → Edit & Deploy → Variables, set `SCHEDULE_EVENTS_CSV_URL` to
   that URL. Deploy once. After this, sheet edits need no deploy at all.

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

If the URL is not set, `/api/schedule` answers 503 and the app quietly uses
the schedule that shipped with the build. If the sheet is not actually
published, the fetch returns HTML and the error says so.
