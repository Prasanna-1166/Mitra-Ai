# Mitra AI

Mitra AI is an account-based AI chat assistant. Guests get a limited number of free questions; signed-in users get a higher daily allowance, cloud-saved chat history, a profile with an optional photo, user-controlled memory, and a response-style setting.

> **Read first — verification status.** The code, SQL migrations and Edge Functions are written and the pure logic is covered by automated tests, but this repository was prepared in an environment with **no network, Postgres, Deno, Docker or Supabase project**. The SQL migrations, RLS policies, pgTAP tests, Edge Functions, email flows, avatar storage policies, the production `vite build` and the live AI provider have **not been executed**. Section [Verification status](#verification-status) lists exactly what was and was not run, and [Production smoke test](#production-smoke-test-checklist) is how you close the gap. Do not call the deployment production-ready until that checklist passes.

## Contents

1. [Capabilities](#capabilities) · 2. [Architecture](#architecture) · 3. [Setup from a clean checkout](#setup-from-a-clean-checkout) · 4. [Environment variables](#environment-variables) · 5. [Supabase configuration](#supabase-configuration) · 6. [Deploying the frontend](#deploying-the-frontend) · 7. [Production smoke test](#production-smoke-test-checklist) · 8. [Rollback](#rollback) · 9. [Tests](#tests) · 10. [Profiles and avatars](#profiles-and-avatars) · 11. [Usage accounting](#usage-accounting) · 12. [Data handling and privacy](#data-handling-and-privacy) · 13. [Security summary](#security-summary) · 14. [Verification status](#verification-status) · 15. [Known limitations](#known-limitations) · 16. [Troubleshooting](#troubleshooting)

## Capabilities

- **Guests:** 5 free questions per guest session, enforced on the server; chats stay in the browser (`localStorage`); sign-in/registration prompt when the allowance is used (nothing is deleted).
- **Accounts:** email + password sign-up, email confirmation, sign-in, sign-out, password recovery, session persistence/refresh, account deletion — all through Supabase Auth.
- **Profile:** display name and optional avatar, editable in **Account menu → Profile**; stored in Postgres + a private storage bucket.
- **Chats:** cloud history for signed-in users (paged loading, search by title and message text, rename, delete, clear, export to Markdown), stop generation, retry a failed reply, **regenerate** the latest reply (uses one question), copy replies and code blocks.
- **Guest-history import:** after signing in, an explicit Import/Skip choice; idempotent; guest copies are removed only after a fully successful import.
- **Memory:** per-account notes (view, add, edit, disable, delete, clear), "remember that …", confirmable suggestions, memory on/off, suggestions on/off.
- **Response style:** Concise / Balanced / Detailed.
- **Themes:** light/dark (Settings → Appearance), persisted.

## Architecture

```
Browser (React 19 + Vite)                       Supabase project
┌─────────────────────────────┐   HTTPS   ┌───────────────────────────────────────┐
│ Guest : chats in localStorage│──────────▶│ Edge Function  chat-ticket            │
│ User  : chats in Postgres    │           │   identify caller → usage → ticket    │
│ ChatController → relayClient │   WSS     ├───────────────────────────────────────┤
│ Supabase Auth (supabase-js)  │──────────▶│ Edge Function  chat-relay (WebSocket) │──WSS──▶ AI provider
│ ProfileManager               │           │   ticket → limits → context/memory    │   (existing endpoint)
│ RLS-protected tables         │◀──────────│   → stream → persist → account        │
│ Private avatar bucket        │ PostgREST ├───────────────────────────────────────┤
└─────────────────────────────┘  / Storage │ Edge Function  delete-account         │
                                           └───────────────────────────────────────┘
                                           Postgres: conversations, messages, user_memories,
                                           user_settings, profiles, usage_events, guest_sessions,
                                           chat_tickets, rate_limits   ·   Storage: avatars
```

- **Frontend:** React 19, Vite, JavaScript/JSX, plain CSS, `react-markdown`, `@supabase/supabase-js`. No application server is needed: the only server-side code is the three Supabase Edge Functions.
- **Every AI request** goes through `chat-relay`. The browser asks `chat-ticket` for a short-lived, single-use ticket (a browser WebSocket cannot send an `Authorization` header), then opens the relay with `?ticket=…`. The relay checks and reserves the allowance **before** contacting the provider.
- **Provider:** the existing `wss://backend.buildpicoapps.com/api/chatbot/chat` integration (`appId`, `chatId`, `systemPrompt`, `message`) is preserved and used server-side only.
- **Source of truth for user data:** *identity* (email, confirmation, created date) lives in Supabase Auth (`auth.users`) and is read from the session; *profile* (display name, avatar) lives in `public.profiles`; *application preferences* (response style, memory switches) live in `public.user_settings`. Nothing is duplicated between them. The optional display name typed at sign-up is passed as auth metadata once and copied into `profiles` by the sign-up trigger; after that only `profiles` is used.

### Request flow

1. The user sends a question; the controller adds it and a pending reply locally.
2. `chat-ticket` identifies the caller (user JWT, or an anonymous guest-session token) and returns usage plus a ticket.
3. `chat-relay` consumes the ticket atomically, validates the origin and payload, applies a per-minute rate limit, checks conversation ownership, and **reserves** one prompt (an advisory lock serialises concurrent requests of one subject).
4. For signed-in users the relay loads recent history, the saved response style and *enabled, relevant* memories from the database and saves the question. Guests send their own bounded history.
5. It builds the system prompt (versioned instructions + response style + fenced memory) and the message (recent context + the new question), streams the provider's text as `chunk` frames, finalises accounting, saves the reply and sends `done`. Success is only ever the explicit `done` frame, never a socket closing.

The underlying AI model is unchanged; only instructions, context and memory are improved. The provider exposes no model, temperature or token controls, so none are offered.

## Setup from a clean checkout

Prerequisites: **Node.js 20.19+ or 22.12+**, npm, a free [Supabase](https://supabase.com) account, and (for deploying) a static host. Commands below work in **PowerShell**, macOS and Linux unless noted.

```bash
git clone <your-repo-url> mitra-ai && cd mitra-ai     # or unzip the project
npm install                                           # use `npm ci` once package-lock.json has been committed
```

> `package.json` declares `@supabase/supabase-js`. If `package-lock.json` does not yet contain it, `npm install` updates the lockfile — commit that change, then use `npm ci` in CI and for reproducible installs.

Local development (needs the Supabase project from the next section):

```bash
cp .env.example .env.local          # PowerShell: Copy-Item .env.example .env.local
# edit .env.local — see "Environment variables"
npm run dev                         # http://localhost:5173
```

Other commands: `npm run lint`, `npm test`, `npm run build`, `npm run preview` (serves `dist/` on http://localhost:4173).

### Supabase CLI on Windows (and everywhere)

`npm install -g supabase` is **not** supported. Use one of:

```powershell
npx supabase --version              # no install: npx fetches the CLI on first use (recommended)
# or install globally with Scoop:
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
```

Every `supabase …` command below can be written as `npx supabase …` if you did not install it globally.

## Supabase configuration

Follow in order. Values in CAPITALS are things you must replace; **`YOUR-PROJECT-REF` is a placeholder, not a literal** — the app and CLI will reject it.

### 1. Create the project
In the Supabase dashboard create a project. Note its **Reference ID** (Project Settings → General) and the **database password** you chose.

### 2. Link and apply migrations
```bash
npx supabase login
npx supabase link --project-ref YOUR-PROJECT-REF      # asks for the database password
npx supabase db push                                   # applies supabase/migrations in order
```
Migrations (applied in filename order, all additive):

| File | Purpose |
| --- | --- |
| `20261011000001_schema.sql` | conversations, messages, memories, settings, guest/ticket/usage/rate-limit tables |
| `20261011000002_security.sql` | RLS enabled everywhere, narrow grants, owner-only policies |
| `20261011000003_functions.sql` | usage accounting, rate limiting, search, housekeeping (service-role only) |
| `20261012000001_profiles_avatars.sql` | `profiles` table, sign-up trigger, backfill, **private `avatars` bucket** and its storage policies |

Existing accounts and conversations are untouched; existing users get a profile row via the backfill (and the app creates one on demand if it is ever missing).

### 3. Authentication (dashboard)
- **Authentication → URL Configuration:** set **Site URL** to your production origin and add every origin you use to **Redirect URLs** (`http://localhost:5173`, `http://localhost:4173`, `https://your-app.example.com`). Confirmation and recovery links return here.
- **Authentication → Providers → Email:** enabled; keep **Confirm email** on for production; minimum password length 8 with letters and digits (the UI enforces the same rule).
- **Authentication → SMTP Settings:** Supabase's built-in sender is for testing and is heavily rate-limited; configure a custom SMTP provider before real users sign up, then check the confirmation and recovery emails arrive.
- Social login is not implemented.

### 4. Edge Function secrets and deployment
```bash
cp supabase/.env.example supabase/.env       # PowerShell: Copy-Item supabase\.env.example supabase\.env
# edit supabase/.env: ALLOWED_ORIGINS (REQUIRED in production), IP_HASH_SALT (long random string), limits
npx supabase secrets set --env-file supabase/.env
npx supabase functions deploy chat-ticket
npx supabase functions deploy chat-relay
npx supabase functions deploy delete-account
```
If the CLI asks for Docker and you do not have it, check the current CLI docs for server-side bundling (`--use-api`). `supabase/config.toml` sets `verify_jwt = false` for the three functions because they authenticate callers themselves (guests have no JWT; a browser WebSocket cannot send headers). `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected into functions by Supabase — **never** copy the service-role key anywhere else.

**`ALLOWED_ORIGINS` must list your real site origin(s)** (exact match, e.g. `https://your-app.example.com,http://localhost:5173`). With an empty list the functions skip Origin checks (development convenience only).

### 5. Avatar storage
Created by the migration: bucket `avatars`, **private**, 2 MB limit, PNG/JPEG/WebP only, objects at `<user-id>/<uuid>.<ext>`, policies restrict every operation to the owner's own folder. Verify in **Storage → Policies** that four `avatars_*_own` policies exist and that the bucket is not public. The app shows photos through one-hour signed URLs.

### 6. Optional housekeeping
Expired tickets, guest sessions and rate-limit rows are purged opportunistically. To schedule it: `select public.purge_expired();` with pg_cron.

## Environment variables

| Variable | Where | Visibility | Purpose |
| --- | --- | --- | --- |
| `VITE_SUPABASE_URL` | `.env.local`, host build settings | **public** (bundled) | Project URL, `https://<ref>.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `.env.local`, host build settings | **public** (bundled) | Publishable key (`sb_publishable_…`) or legacy anon key. Safe only because RLS protects every table |
| `VITE_CONNECT_TIMEOUT_MS`, `VITE_IDLE_TIMEOUT_MS`, `VITE_MAX_MESSAGE_CHARS`, `VITE_GUEST_CONTEXT_MESSAGES` | optional | public | UX tuning; the server enforces its own limits |
| `GUEST_PROMPT_LIMIT` (5), `USER_DAILY_LIMIT` (100), `GUEST_SESSION_DAYS` (30), `REQUESTS_PER_MINUTE` (8), `GUEST_SESSIONS_PER_IP_PER_DAY` (20) | `supabase/.env` → `secrets set` | **server only** | Usage policy |
| `MAX_MESSAGE_CHARS`, `CONTEXT_MAX_MESSAGES`, `CONTEXT_MAX_CHARS`, `MEMORY_MAX_ITEMS`, `MEMORY_MAX_CHARS` | same | server only | Request / context bounds |
| `AI_UPSTREAM_WS_URL`, `AI_UPSTREAM_APP_ID`, `UPSTREAM_CONNECT_TIMEOUT_MS`, `UPSTREAM_IDLE_TIMEOUT_MS`, `TOTAL_TIMEOUT_MS` | same | server only | Existing provider integration |
| `ALLOWED_ORIGINS` | same | server only | Origins allowed to call the functions / open the relay |
| `IP_HASH_SALT` | same | server only | Salt for hashing IPs used in guest-session throttling |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | injected by Supabase | **server only, secret** | Never put these in a `VITE_*` variable or a committed file |

**Early validation:** at startup the app checks the two public variables. A missing value, a leftover `YOUR-PROJECT-REF` placeholder, a production build pointing at localhost/http, or a **secret / service-role key placed in `VITE_SUPABASE_PUBLISHABLE_KEY`** (detected and refused, never echoed) produces a banner naming the problem. If you ever see the secret-key warning, rotate that key in the dashboard — it has been exposed to your build tooling.

## Deploying the frontend

The app is a static single-page build. No application server is required.

```bash
npm run build          # outputs dist/
```

**Recommended host: Vercel** (`vercel.json` included) — import the repository, framework preset *Vite*, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` under Environment Variables (Production), deploy. `vercel.json` provides the SPA fallback rewrite, security headers (CSP, `X-Content-Type-Options`, HSTS, referrer and permissions policies) and immutable caching for `/assets`. **Netlify / Cloudflare Pages** also work: `public/_redirects` (SPA fallback) and `public/_headers` (same headers) are included and copied into `dist/`.

Then: add the deployed origin to Supabase **Redirect URLs** and **Site URL**, add it to `ALLOWED_ORIGINS` and re-run `supabase secrets set`, and redeploy the functions if you changed secrets that the code reads at start-up (secrets apply to subsequent invocations).

The CSP allows `https://*.supabase.co` and `wss://*.supabase.co` (hosted projects). If you use a custom Supabase domain, edit the `connect-src`/`img-src` entries in `vercel.json` and `public/_headers`. The inline theme script in `index.html` is permitted by its SHA-256 hash; if you edit that script, regenerate the hash.

**Costs and services:** Supabase (free tier exists; free projects pause after inactivity, and the built-in email sender is rate-limited — configure SMTP), a static host (Vercel's free Hobby plan is for non-commercial use; check current terms), and the third-party AI provider whose pricing, availability and data policy are outside this project.

## Production smoke test checklist

Run against the deployed site with a throw-away account. Mark each item only after you have seen it work.

1. Open the site in a private window: no banner about configuration; guest badge shows `5 of 5 free questions left`.
2. Direct-load a deep path (`/anything`) and refresh: the app loads (SPA fallback).
3. Ask a question as a guest: an answer streams in; the badge decrements. Ask five; the sixth opens the limit dialog and nothing is lost.
4. Create an account (with a display name). Confirm the **verification email arrives** and the link returns to your site signed in.
5. Import dialog appears if guest chats exist; Import works; guest copies disappear only after success.
6. Ask a question signed in; reload the page: the chat is still there. Open the site on a second device/browser, sign in: same chats.
7. **Profile:** change the display name → persists after reload. Upload a PNG → header shows it; replace it; remove it. Try a `.gif` and a renamed text file → clear error, nothing changes.
8. **Isolation:** sign in as a second account → none of the first account's chats, memories, profile or photo are visible; sign out/in as the first → still there.
9. Memory: "Remember that I use Vite" → saved; Settings → Memory shows it; delete it.
10. Password recovery: request a reset email, follow the link, set a new password, sign in with it.
11. Stop a generation mid-stream; retry a failed reply; regenerate a reply.
12. Dashboard checks: **Storage → avatars** shows only `<user-id>/…` objects and is private; **Table editor** shows RLS enabled on every table; **Edge Functions → Logs** contain no prompts, answers or tokens.
13. Delete the throw-away account (Settings → Delete account): in the dashboard the Auth user, its rows in every table **and its avatar objects** are gone.
14. Browser console shows no errors and no CSP violations.

## Rollback

- **Frontend:** redeploy the previous build (Vercel/Netlify keep previous deployments; promote one). The frontend is stateless.
- **Edge Functions:** redeploy the previous commit's functions (`supabase functions deploy <name>`); secrets are independent of code.
- **Database:** migrations are additive, so rolling the app back does not require a database change — older frontends simply ignore the `profiles` table. Take a backup (Dashboard → Database → Backups, or `supabase db dump`) before `db push` on a production project. To undo the profile migration entirely, empty the `avatars` bucket first (Postgres cannot delete stored files) and then run `supabase/rollback/20261012000001_profiles_avatars.down.sql` manually; display names and avatar references are lost, nothing else is. There are no down-migrations for the three earlier files; restoring from backup is the rollback for those.

## Tests

```bash
npm run lint
npm test                  # Node's built-in runner: 165 tests, no network, no live services
npx supabase start        # needs Docker; starts the local stack
npx supabase test db      # pgTAP: supabase/tests/rls.test.sql (63 assertions) — NOT yet run
```

`npm test` covers: shared server logic (instructions, memory selection and secret detection, context building, config), the relay core against a fake provider socket and an in-memory repo (limits, release/charge accounting, cancellation, timeouts, partial replies, ownership), the account-deletion core (token verification, ordering, cleanup-failure behaviour), Origin validation, services against an in-memory fake of Supabase (conversations, import idempotency, memory, ticket client, **profiles and avatar storage including cross-account denial**), the chat controller and profile manager (account switching, stale async results, rollback on quota), the relay client, frontend configuration validation, and server-side rendering of every dialog/menu for accessible names and states. The in-memory fake emulates ownership, unique keys, column grants and the storage policy rules; it is **not Supabase**, and real RLS is covered only by the pgTAP file.

## Profiles and avatars

- **Table `public.profiles`:** `user_id` (PK, FK → `auth.users` ON DELETE CASCADE), `display_name` (1–50 chars, no control characters, or null), `avatar_path` (null or exactly `<user_id>/<uuid>.(png|jpg|webp)` — an external URL is rejected by a CHECK constraint), timestamps. RLS: owner-only select/insert/update; clients cannot delete rows; column-level grants stop `user_id` being changed.
- **Creation:** a `SECURITY DEFINER` trigger on `auth.users` inserts the profile idempotently (`ON CONFLICT DO NOTHING`) and **never blocks sign-up** (failures become warnings). Existing users are backfilled by the migration. If a row is ever missing the app creates it itself (RLS permits exactly that) and shows a Retry if loading fails.
- **Avatar upload:** the browser validates type and size (≤ 5 MB input), decodes the image (non-images are rejected), crops to a centred square, resizes to 256×256 and re-encodes (WebP, JPEG fallback) — which strips EXIF metadata — then uploads under a **new unique name**, points the profile at it and deletes the previous object. If any step fails the previous avatar stays and no orphan object is left; if deleting the old object fails the file is merely unreferenced. Removing a photo clears the reference first, then deletes the object. The bucket independently enforces 2 MB and PNG/JPEG/WebP.
- **Display:** a private bucket means no public URLs; the app requests one-hour signed URLs and falls back to the initial if an image fails to load.
- **Account deletion:** `delete-account` verifies the caller's JWT and deletes **only that user** (an id in the request body is never used). It removes every object in `avatars/<user-id>/` first; if that fails the account is **kept** and the user can retry (so no personal image is orphaned by a deleted account). Then it deletes the Auth user, and foreign-key cascades remove the profile, conversations, messages, memories, settings, tickets and usage records. Storage and Postgres cannot share a transaction, which is why cleanup comes first and is retry-safe; a crash between the two steps just leaves a retryable state.
- **Not collected:** phone, date of birth, gender, address.

## Usage accounting

| Outcome | Allowance |
| --- | --- |
| Completed | charged |
| Failed or stopped **after** the provider started answering | charged (`partial`) |
| Failed, timed out or cancelled **before** any answer text | released, not charged |
| Rejected (empty, too long, rate-limited, over quota, bad conversation) | never reserved |
| Regenerate / retry | a new request: reserves and charges like any other |
| Welcome screen, suggestions, profile edits | no AI request, no allowance |

Defaults: **5** per guest session (total), **100** per signed-in user per **UTC day**. A reservation that is never finalised stops counting after 5 minutes. **Honest limits:** a guest session is tied to a browser; clearing site data starts a new one. The only abuse controls that avoid fingerprinting are a per-session request rate and throttling of session creation by salted, daily-rotating IP hash. The provider endpoint is publicly reachable and its `appId` is not secret, so anyone can call it directly; this app can only enforce its own limits.

## Data handling and privacy

- **Guests:** conversations live only in `localStorage` (`mitra-ai:history`, bounded to 50 chats / 200 messages each / ~2 MB), plus the opaque guest-session token and theme/response-style preferences.
- **Signed-in users:** conversations, messages, memories, settings and profile are stored in your Supabase project, protected by row-level security; avatars in a private bucket.
- **Questions are sent to the external AI provider** with recent context and relevant memories. Deleting data here does not delete anything the provider may hold; its retention is outside this project's control. Prompts and answers are never written to function logs.
- **Deletion:** chats, memories and photos can be deleted individually or in bulk; *Delete account* removes everything as described above. Logout clears all in-memory account state, and results that arrive late for a previous account are discarded.
- No promises are made about regulatory compliance or provider-side encryption.

## Security summary

- RLS on every table; client roles hold only the grants they need; messages carry a composite foreign key to `(conversation_id, user_id)`; server-only tables have no client grants and accounting functions are executable by `service_role` only; `SECURITY DEFINER` functions pin `search_path = ''` and are revoked from client roles.
- Tickets: 192-bit random, stored hashed, single-use, 60 s, consumed in one atomic statement. The relay requires an allow-listed `Origin`; `chat-ticket` and `delete-account` refuse disallowed origins server-side (CORS headers alone only instruct browsers).
- Identity is derived from the verified ticket or JWT, never from the payload; every query is scoped to it.
- The app refuses to start with a secret key in a `VITE_*` variable; the browser stores no tokens beyond Supabase's own session handling and the opaque guest token. Passwords are handled only by Supabase Auth.
- Security headers and a CSP are shipped in `vercel.json` / `public/_headers`; the CSP was tested in a real browser against the built app shell (no violations for load, guest chat over WebSocket and settings).
- Dependencies: run `npm audit --omit=dev` yourself — it could not be run without network access.

## Verification status

| Area | Status |
| --- | --- |
| `npm run lint` | passes (exit 0) |
| `npm test` | passes: **165 / 165** |
| `npm run build` (Vite production build) | **not run** here (native Rollup binary unavailable on the authoring machine). Run it locally; CI (`.github/workflows/ci.yml`) also runs it |
| Browser run (Chromium) | exercised guest limit → sign-up → import → memory → reload → logout → second account; profile name edit, **real avatar processing (300×200 PNG → 256×256 WebP)**, replace/remove/failure handling, reload persistence, account-switch isolation, regenerate, keyboard menu navigation, desktop/tablet/mobile layouts and dark theme — **against an in-memory stand-in for `@supabase/supabase-js` and mocked network endpoints** (not part of the repository) |
| CSP / SPA fallback | exercised in Chromium against a local static server sending the shipped CSP |
| SQL migrations, RLS policies, storage policies, sign-up trigger, `supabase/tests/rls.test.sql` | **written, not executed** (no Postgres) |
| Edge Functions | **not executed**; TypeScript syntax-checked only; their logic lives in `_shared/*.js` and is tested through injected fakes |
| Live Supabase project, email delivery/recovery, avatar bucket behaviour, live AI provider, deployment | **not tested** |

## Known limitations

- The AI provider could not be checked: whether it keeps per-`chatId` state (each request uses a fresh `chatId`, so correctness does not depend on it), whether it accepts connections from Supabase's servers, its size limits and retention.
- Edge Function wall-clock limits vary by plan; very long answers may be cut off (`TOTAL_TIMEOUT_MS`, default 110 s); the partial answer is kept and marked incomplete.
- No rolling conversation summary; long chats use the most recent messages only.
- Tables, strikethrough and bare-URL auto-linking are not rendered (`remark-gfm` not installed).
- Memory suggestions and secret detection are pattern-based heuristics.
- Conversation search uses `ILIKE` without a trigram index.
- No live cross-device sync: history loads on demand and on reload.
- Avatar changes save immediately on selection (the name field uses Save/Cancel).
- The CSP assumes a hosted `*.supabase.co` project.
- Guest-session quotas are per browser and resettable (see above).

## Troubleshooting

- **`supabase` is not recognized (Windows):** use `npx supabase …` or install via Scoop (see above); global `npm install -g supabase` is unsupported.
- **Banner "Mitra AI is not set up yet":** the message names the missing/invalid `VITE_*` variable; restart `npm run dev` after editing `.env.local` (Vite reads it at start).
- **Sign-up works but no email arrives:** the built-in sender is rate-limited; configure SMTP; check spam; confirm the Site URL / Redirect URLs.
- **Recovery link opens the site but nothing happens:** the origin must be in Redirect URLs.
- **"Couldn't connect to Mitra AI":** check that all three functions are deployed, `ALLOWED_ORIGINS` contains the exact origin (scheme + host + port, no trailing slash), and the function logs.
- **Profile says "couldn't be loaded":** the `profiles` migration has not been applied (`supabase db push`), or the user is signed out; use Retry.
- **Photo upload fails:** confirm the `avatars` bucket and its four policies exist; only PNG/JPEG/WebP up to 5 MB are accepted.
- **Database permission errors:** re-run `supabase db push`; check RLS is enabled and no policy was edited manually.
