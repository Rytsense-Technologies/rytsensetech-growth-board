# Cloudflare Access for the Growth Board

## Why

The board URL is posted to a Slack channel every day. Knowing a URL was never
access control — until this change, six write endpoints were reachable by anyone
who had seen that message, and the one shared token everybody pasted could not
answer "who changed this?". Every activity and history entry recorded the actor as
the literal string `dashboard`.

Cloudflare Access puts the identity provider in front of the Pages domain. The
five humans sign in; Cloudflare stamps each request with a signed JWT carrying
their email; `functions/_lib/auth.js` verifies that JWT against the team's public
keys and records the email as the actor.

The publisher CLI and the scheduled jobs are unchanged: they keep sending
`X-Board-Token: <BOARD_PUBLISH_TOKEN>` and are recorded as `service:publisher`.

## What the operator does in Cloudflare

### 1. Create the Access application

Zero Trust dashboard → **Access → Applications → Add an application →
Self-hosted**.

- **Application name**: `Growth Board`
- **Session duration**: 24 hours is a reasonable default for a daily-use board
- **Application domain**: `rytsensetech-growth-board.pages.dev` — leave the path
  empty so the whole board is covered, dashboards and API alike

If preview deploys should also be protected, add a second domain entry with the
wildcard `*.rytsensetech-growth-board.pages.dev`.

### 2. Add a policy for the team

On the application, **Policies → Add a policy**:

- **Policy name**: `Growth board team`
- **Action**: Allow
- **Include** → **Emails** → the five addresses, one per line

Use *Emails*, not *Emails ending in*. A domain rule lets every future address at
that domain in; this board has five named humans, and the list should be a list.

### 3. Copy the two values this code needs

- **AUD tag** — on the application's **Overview** tab, labelled
  "Application Audience (AUD) Tag". A 64-character hex string. This is what
  `ACCESS_AUD` must equal; it is what stops a token minted for some *other*
  Access application in the same account from working here.
- **Team domain** — Zero Trust → **Settings → Custom Pages** (or the URL of the
  Zero Trust dashboard itself): `<team>.cloudflareaccess.com`. This is
  `ACCESS_TEAM_DOMAIN`; it fixes both the `iss` claim we require and the
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` endpoint we fetch the
  signing keys from.

### 4. Set the two variables on the Pages project

Pages → `rytsensetech-growth-board` → **Settings → Environment variables →
Production** (and Preview, if previews are protected):

| Variable | Kind | Value |
| --- | --- | --- |
| `ACCESS_TEAM_DOMAIN` | plain text | `<team>.cloudflareaccess.com` |
| `ACCESS_AUD` | plain text | the 64-character AUD tag |
| `BOARD_PUBLISH_TOKEN` | **secret** (encrypted) | the existing publish token |

Neither Access value is a secret — the AUD tag is not a credential, and the team
domain is public — but `BOARD_PUBLISH_TOKEN` is, and stays encrypted.

Or from the CLI:

```bash
wrangler pages project env add ACCESS_TEAM_DOMAIN --project-name rytsensetech-growth-board
wrangler pages project env add ACCESS_AUD --project-name rytsensetech-growth-board
wrangler pages secret put BOARD_PUBLISH_TOKEN --project-name rytsensetech-growth-board
```

**Redeploy after setting them.** Pages environment variables are bound at deploy
time, so an existing deployment will not see them.

## Verifying it actually refuses

From a machine that is **not** signed in (or a private window):

```bash
# 1. The board itself should bounce to the Access login page, not render.
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  https://rytsensetech-growth-board.pages.dev/

# 2. A write with no credential must be refused. 302 to the Access login means
#    Access blocked it at the edge; 401 means it reached the Function and the
#    Function refused. Either is a pass. A 200 is a failure.
curl -sS -i -X POST https://rytsensetech-growth-board.pages.dev/api/team \
  -H 'Content-Type: application/json' -d '{"action":"replace","team":[]}'

# 3. A forged Access header must NOT work — the signature is checked.
curl -sS -i -X POST https://rytsensetech-growth-board.pages.dev/api/team \
  -H 'Cf-Access-Jwt-Assertion: eyJhbGciOiJub25lIn0.eyJlbWFpbCI6ImF0dGFja2VyQGV4YW1wbGUuY29tIn0.' \
  -H 'Content-Type: application/json' -d '{"action":"replace","team":[]}'
```

Then, signed in as a team member, make any change on the board and check
`/api/activity`: the new entry's `who` should be your email, not `dashboard`.

The verifier itself is exercised offline, with locally minted RSA keys and no
network:

```bash
node scripts/dev/access-auth-harness.mjs
```

## Keeping the automated backup working

`/api/export` is called on a schedule to take a full backup. Do **not** widen the
Access policy to accommodate it — a bypass rule for a path or a user agent is a
hole that anybody can drive through, and it is exactly the "knows the URL" problem
again.

Two options, in order of preference:

**A. Service token (recommended).** Zero Trust → **Access → Service Auth → Create
Service Token**. Name it `growth-board-backup`, copy the Client ID and Client
Secret once. Then add a *second* policy on the application:

- **Policy name**: `Backup service token`
- **Action**: **Service Auth** (not Allow)
- **Include** → **Service Token** → `growth-board-backup`

The backup job then sends three headers:

```
CF-Access-Client-Id: <client-id>
CF-Access-Client-Secret: <client-secret>
X-Board-Token: <BOARD_PUBLISH_TOKEN>
```

The first two get it past Access at the edge; the third is what
`functions/_lib/auth.js` authenticates, and it is recorded as `service:publisher`.
A Service Auth policy issues no identity JWT, which is precisely why the board
token is still required — Access proves the caller is the backup job, the board
token proves it to the Function.

**B. Bypass on the one path.** A policy with action **Bypass** scoped to
`rytsensetech-growth-board.pages.dev/api/export` leaves that path protected only by
`BOARD_PUBLISH_TOKEN`. That is the same protection it had before Access, so it is
not a regression — but it is strictly weaker than (A), and it is one typo away
from bypassing more than one path. Prefer the service token.

Rotating either credential is independent: rotate the service token in Zero Trust,
rotate `BOARD_PUBLISH_TOKEN` with `wrangler pages secret put`.

## Local development

`wrangler pages dev` has no Access in front of it, so `ACCESS_TEAM_DOMAIN` and
`ACCESS_AUD` are normally unset locally. That does **not** mean auth is skipped:

- the Access credential is simply **unavailable** — any `Cf-Access-Jwt-Assertion`
  is refused with `ACCESS_NOT_CONFIGURED`, because there is nothing to verify it
  against;
- the `X-Board-Token` path works exactly as it does in production, and writes are
  still refused when `BOARD_PUBLISH_TOKEN` is unset.

Put the token in `.dev.vars` (git-ignored) for local work.

## 401 reasons you may see

| `reason` | Meaning |
| --- | --- |
| `SECRET_UNSET` | `BOARD_PUBLISH_TOKEN` is not set on the deployment |
| `BAD_TOKEN` | Missing or wrong `X-Board-Token` |
| `ACCESS_NOT_CONFIGURED` | `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` unset — Access path unavailable |
| `ACCESS_MALFORMED` | Not three base64url segments, or not JSON |
| `ACCESS_BAD_ALG` | Header did not say RS256, or carried no `kid` |
| `ACCESS_KEYS_UNAVAILABLE` | The certs endpoint could not be reached — **denied, never allowed** |
| `ACCESS_UNKNOWN_KID` | No matching signing key even after a re-fetch |
| `ACCESS_BAD_SIGNATURE` | Signature did not verify |
| `ACCESS_BAD_ISSUER` | `iss` was not `https://<ACCESS_TEAM_DOMAIN>` |
| `ACCESS_BAD_AUDIENCE` | `aud` did not contain `ACCESS_AUD` — token was for another app |
| `ACCESS_EXPIRED` / `ACCESS_NOT_YET_VALID` | Outside `exp`/`nbf`, allowing 60s of skew |
| `ACCESS_NO_IDENTITY` | Verified, but carried no `email` claim |
