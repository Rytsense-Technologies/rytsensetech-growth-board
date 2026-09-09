# Rytsensetech Growth Board

A public, always-current SEO & marketing dashboard for **rytsensetech.com**.
A scheduled GitHub Actions job pulls fresh data from Search Console, GA4 and
Clarity every day, commits it as `data/latest.json`, and Vercel redeploys the
static site automatically. No login required to view — share the URL with
anyone on the team.

The dashboard already ships with real data (from 2026-09-09) so it works the
moment it's deployed, before you've wired up the automated refresh.

## How it works

```
GitHub Actions (cron, daily)
  -> scripts/fetch-data.mjs
     -> Search Console API   (service account)
     -> GA4 Data API         (service account)
     -> Clarity Data Export  (API token, optional)
  -> writes data/latest.json
  -> commits + pushes
       -> Vercel auto-redeploys (it watches the repo)
            -> index.html fetches data/latest.json, renders the dashboard
```

There's no database and no server — `index.html` is a static file that reads
a JSON file sitting next to it. That's the whole system.

## One-time setup

### 1. Push this to GitHub

Create a new repository (e.g. `rytsensetech-growth-board`) and push this
folder to it.

### 2. Create a Google Cloud service account

This is a robot credential — not your personal Google login — so the
scheduled job can read Search Console and GA4 without anyone's password.

1. Go to [console.cloud.google.com](https://console.cloud.google.com), create
   or pick a project.
2. **APIs & Services > Library** — enable **Google Search Console API** and
   **Google Analytics Data API**.
3. **APIs & Services > Credentials > Create Credentials > Service account** —
   give it any name (e.g. `growth-board`). No roles needed at the project
   level.
4. Open the new service account > **Keys > Add key > Create new key > JSON**.
   This downloads a `.json` file — keep it private, you'll paste its full
   contents into a GitHub secret in step 5.
5. Copy the service account's email address (looks like
   `growth-board@your-project.iam.gserviceaccount.com`).

### 3. Grant that service account access to your data

- **Search Console**: [search.google.com/search-console](https://search.google.com/search-console)
  → Settings → Users and permissions → Add user → paste the service account
  email → **Full** (or Restricted) permission.
- **GA4**: Admin → Property Access Management (on the *Rytsensetech*
  property) → `+` → paste the service account email → role **Viewer**.

### 4. (Optional) Get a Clarity API token

[clarity.microsoft.com](https://clarity.microsoft.com) → your project →
Settings → Data Export → API tokens → generate one. Skip this if you'd
rather leave the Clarity card showing "not reporting" for now — everything
else still works.

### 5. Add GitHub Actions secrets

In your repo: **Settings → Secrets and variables → Actions → New repository
secret**. Add:

| Secret name | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the *entire contents* of the JSON key file from step 2.4 |
| `GSC_SITE_URL` | `https://rytsensetech.com/` (must match exactly how it's listed in Search Console) |
| `GA4_PROPERTY_ID` | `423166919` |
| `CLARITY_API_TOKEN` | the token from step 4 (optional — leave unset to skip) |

### 6. Run the refresh once

**Actions** tab → "Refresh dashboard data" → **Run workflow**. Check it goes
green and that `data/latest.json` in the repo got a new `updatedAt` commit.
After this it runs automatically every day at 08:00 IST — trigger it early
any time from the same **Run workflow** button if you want fresher numbers
before the next scheduled run.

### 7. Deploy to Vercel

1. [vercel.com](https://vercel.com) → **Add New... > Project** → import this
   GitHub repo.
2. No configuration needed — it's a static site, Vercel detects that
   automatically. Click **Deploy**.
3. You'll get a URL like `rytsensetech-growth-board.vercel.app`. Share that
   with the team — it's public and needs no sign-in. Add a custom domain
   under Vercel's Project Settings if you'd rather use something like
   `growth.rytsensetech.com`.

Every time the Actions job commits fresh data, Vercel picks up the push and
redeploys within a minute or two — the dashboard just stays current.

## Changing the schedule

Edit the `cron` line in `.github/workflows/refresh.yml`
(`30 2 * * *` = 02:30 UTC = 08:00 IST daily). GitHub Actions cron runs in
UTC. You can also just click **Run workflow** manually whenever you want an
immediate refresh.

## Notes on the data

- **GSC "opportunity" score** on the near-miss keyword table is this repo's
  own estimate (impression volume weighted by ranking position and CTR
  headroom) — Search Console doesn't expose an official "opportunity"
  metric, so treat it as directional.
- **Clarity** card only populates once `CLARITY_API_TOKEN` is set and the
  Clarity Data Export API responds; the exact fields it returns aren't
  fixed into the dashboard yet — extend `renderClarity()` in `index.html`
  and the `fetchClarity()` function in `scripts/fetch-data.mjs` once you
  know which Clarity metrics you want surfaced.
- All numbers are pulled directly from Google's and Microsoft's APIs — no
  Claude involvement at runtime, so this keeps working whether or not any
  Claude session is active.
