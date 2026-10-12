# Mitra AI

Mitra AI is an account-based AI chat assistant: guests get a limited number of free questions, signed-in users get a higher daily allowance, cloud-saved chat history and user-controlled memory.

> **Status:** the code, SQL migrations and Edge Functions are complete, but they were written in an environment with no network, Postgres, Deno or Supabase project. The pure logic is covered by automated tests; the database layer, Edge Functions, email flows and the live AI provider have **not** been run. See [Verification status](#verification-status) and follow the setup steps below before relying on it.

## Architecture

```
Browser (React 19 + Vite)                       Supabase project
┌────────────────────────────┐   HTTPS   ┌──────────────────────────────────────┐
│ Guest: chats in localStorage│──────────▶│ Edge Function chat-ticket            │
│ User : chats in Postgres    │           │   identify caller → usage → ticket   │
│ useChat → ChatController    │   WSS     ├──────────────────────────────────────┤
│   relayClient               │──────────▶│ Edge Function chat-relay (WebSocket) │──WSS──▶ AI provider
│ Supabase Auth (supabase-js) │           │   ticket → limits → context/memory   │       (existing
│ Row-level-secured tables    │◀──────────│   → stream → persist → account       │        endpoint)
└────────────────────────────┘ PostgREST └──────────────────────────────────────┘
                                          Postgres: conversations, messages,
                                          user_memories, user_settings, usage_events,
                                          guest_sessions, chat_tickets, rate_limits
```

- **Frontend:** React 19, Vite, JavaScript/JSX, `react-markdown`, `@supabase/supabase-js`. Plain CSS (light/dark).
- **Auth:** Supabase Auth (email + password, verification, password recovery). Sessions are managed by the official client; the app never stores tokens or passwords itself.
- **Data:** Postgres with row-level security on every table. Users can only read or change their own rows; ownership columns cannot be edited.
- **Protected AI path:** *every* AI request goes through the `chat-relay` Edge Function. The browser asks `chat-ticket` for a short-lived, single-use ticket (browsers cannot send headers on a WebSocket), then opens the relay with `?ticket=…`. The relay checks and reserves the allowance **before** contacting the AI provider.
- **Provider:** the existing `wss://backend.buildpicoapps.com/api/chatbot/chat` integration (`appId`, `chatId`, `systemPrompt`, `message`) is preserved and used server-side only.

### How a question flows

1. Guest or user clicks send. The controller adds the question and a pending reply locally.
2. `chat-ticket` identifies the caller (user JWT, or an anonymous guest-session token), returns usage and a ticket.
3. The relay consumes the ticket atomically, validates the payload, applies a per-minute rate limit, checks conversation ownership, and **reserves** one prompt in the database (an advisory lock serialises concurrent requests of one subject, so they cannot overspend).
4. For signed-in users the relay loads recent history and *enabled, relevant* memories from the database, plus the saved response style, and saves the user message. Guests send their own bounded recent history.
5. It builds the system prompt (versioned instructions + response style + fenced memory) and the message (recent context + the new question) and streams the provider's text back as `chunk` frames.
6. It finalises accounting and saves the reply, then sends `done` (success is only ever the explicit `done` frame, not a socket closing).

### Usage accounting

| Outcome | Allowance |
| --- | --- |
| Completed | charged |
| Failed or stopped **after** the provider started answering | charged (`partial`) |
| Failed, timed out or cancelled **before** any answer text | released, not charged |
| Rejected (empty, too long, rate-limited, over quota, bad conversation) | never reserved |
| Static welcome screen | no AI request is made at all |

Defaults: **5** questions per guest session (total, not daily), **100** per signed-in user per **UTC day** (resets at 00:00 UTC). Both are server settings (`GUEST_PROMPT_LIMIT`, `USER_DAILY_LIMIT`); the UI reads them from the server and never hard-codes them. A reservation that is never finalised (e.g. a crashed relay) stops counting after 5 minutes.

**Honest limits of guest quotas:** a guest session is tied to a browser (an opaque token in `localStorage`). Clearing site data or switching browsers/devices starts a new session. The only abuse control that does not involve fingerprinting is throttling session creation per salted, daily-rotating IP hash (default 20/day) plus a per-session request rate. The AI provider endpoint itself is publicly reachable and its `appId` is not secret, so anyone can call it directly; this app can only enforce its own limits.

### Answer quality

`supabase/functions/_shared/instructions.js` (versioned) tells the model to answer directly, use earlier messages, explain trade-offs and risks, say when it is unsure, never claim code was run, never invent APIs or URLs, and match the user's level. Users choose **Concise / Balanced / Detailed** (default Balanced); signed-in users' choice is saved to their account, guests' in the browser.

- **Conversation context:** bounded recent history (default: last 20 messages / 12,000 characters, failed or partial replies excluded) is placed in the `message`. Each request uses a **fresh `chatId`**, because whether the provider keeps conversation state could not be verified; this design is correct either way and prevents any cross-conversation or cross-user leakage.
- **Memory:** per-account notes selected by relevance (broadly useful preferences plus topical matches, bounded in count and size) and sent inside a fenced block that is declared to be data and cannot change the rules.
- **The underlying model did not change.** Only instructions, context and memory improved. The provider exposes no model, temperature or token controls, so none are offered.

### Memory

Chat history stores what was said; memory stores a few lasting notes. In **Settings → Memory** users can view, add, edit, disable, delete and clear notes, switch memory off, and switch off suggestions. Saying "remember that …" saves a note (with Undo). Apparent preferences ("I prefer …", "I'm working on …") are only *suggested* and need a click on **Save**. Obvious credentials and identifiers (keys, tokens, passwords, card/ID numbers) are refused; this check is heuristic and cannot recognise every sensitive detail.

### Guest history import

After signing in, if this browser holds guest conversations, a dialog asks **“Save your guest conversations to your account?”** — Import or Skip. Import is idempotent (conversations are keyed by `(user, import_key)`, messages by `(conversation, client_id)`), batched, shows progress, preserves order, titles and message timestamps, and leaves the guest copies untouched if anything fails. After a fully successful import the imported guest copies are removed from this browser. Imported conversations are sorted by import time in the sidebar (a database trigger sets `updated_at`).

## Setup

### Prerequisites

Node.js 20.19+ or 22.12+, npm, a Supabase project, and the [Supabase CLI](https://supabase.com/docs/guides/cli).

### 1. Install

```bash
npm install          # also updates package-lock.json for @supabase/supabase-js; commit it
```

### 2. Create and link the Supabase project

```bash
supabase login
supabase link --project-ref YOUR-PROJECT-REF
```

### 3. Apply migrations (schema, RLS policies, functions)

```bash
supabase db push
```

### 4. Configure authentication (dashboard)

- **Authentication → URL Configuration:** set **Site URL** to your deployed origin and add every origin you use under **Redirect URLs** (e.g. `http://localhost:5173`, `http://localhost:4173`, `https://your-app.example.com`). Password-recovery and confirmation links return to this origin.
- **Authentication → Sign In / Providers → Email:** keep email enabled. Leave **Confirm email** on for production (the local `config.toml` enables it). Set a minimum password length of 8 and "letters and digits".
- **Authentication → SMTP:** Supabase's built-in email sender is heavily rate-limited; configure a custom SMTP provider for real use.
- Social logins are not implemented.

### 5. Deploy the Edge Functions and set secrets

```bash
cp supabase/.env.example supabase/.env      # edit: ALLOWED_ORIGINS, IP_HASH_SALT, limits
supabase secrets set --env-file supabase/.env
supabase functions deploy chat-ticket
supabase functions deploy chat-relay
supabase functions deploy delete-account
```

`supabase/config.toml` sets `verify_jwt = false` for these three functions because they authenticate callers themselves (guests have no JWT and a browser WebSocket cannot send an `Authorization` header). `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to functions by Supabase; never place the service-role key in the frontend.

Optional housekeeping (otherwise the ticket function purges opportunistically): schedule `select public.purge_expired();` with pg_cron.

### 6. Frontend environment

```bash
cp .env.example .env.local
```

Fill `VITE_SUPABASE_URL` (Project URL) and `VITE_SUPABASE_PUBLISHABLE_KEY` (Publishable key, or the legacy anon key) from **Project Settings → API**. Without them the app shows a "backend not configured" banner and cannot send questions.

### 7. Run

```bash
npm run dev          # http://localhost:5173
npm run lint
npm test
npm run build && npm run preview
```

### Tests

```bash
npm test             # Node's built-in runner: logic, services, relay core, component rendering
supabase test db     # pgTAP: cross-account isolation, column locks, usage accounting (needs the local stack)
```

## Data handling and privacy

- **Guests:** conversations live only in the browser's `localStorage` (key `mitra-ai:history`, versioned, bounded to 50 chats / 200 messages each / ~2 MB). Delete them from the sidebar or Settings.
- **Signed-in users:** conversations, messages, memories and settings are stored in your Supabase Postgres database, protected by row-level security.
- **Questions are sent to the external AI provider** to generate answers (together with recent context and relevant memories). Deleting data here does not delete what the provider may hold. Do not enter sensitive information you would not share with it. Prompts and answers are not written to function logs.
- **Deletion:** deleting a chat, clearing a chat, deleting all chats, and deleting a memory remove the rows. **Delete account** (Settings → Your data, type `DELETE`) calls the `delete-account` function, which deletes the Auth user; `ON DELETE CASCADE` removes the account's conversations, messages, memories, settings, tickets and usage records. There is no separate retention period.
- **Logout** clears all in-memory account state; the next identity starts from a blank state and results arriving late for a previous account are discarded.
- Guest-session and ticket records store only hashes of random tokens; IP addresses are used transiently (salted hash for throttling) and never stored in clear.

## Security summary

- RLS on every table; client roles hold only the grants they need (column-level `UPDATE` grants stop `user_id` or timestamps being edited); messages additionally carry a composite foreign key to `(conversation_id, user_id)`.
- Server-only tables (`guest_sessions`, `chat_tickets`, `rate_limits`) have RLS enabled and no client grants; accounting functions are executable by `service_role` only.
- Tickets are 192-bit random, stored hashed, single-use, 60 s lifetime, consumed in one atomic statement. The relay also checks the `Origin` header against `ALLOWED_ORIGINS`.
- The relay derives identity from the ticket, never from the payload, and scopes every query to that user.
- No secrets are stored in the browser beyond Supabase's own session handling and the opaque guest token.

## Verification status

| Area | Status |
| --- | --- |
| `npm run lint` | passes |
| `npm test` | passes (130 tests: shared logic, relay core with fake sockets/repo, services against an in-memory fake, controller, relay client, component rendering) |
| Browser run (Chromium) | exercised guest → limit → sign-up → import → memory → reload → logout → second account, plus mobile layouts, **against an in-memory stand-in for `@supabase/supabase-js` and mocked network endpoints** (not included in the repo) |
| SQL migrations, RLS policies, `supabase/tests/rls.test.sql` | **written, not executed** (no Postgres available) |
| Edge Functions (`chat-ticket`, `chat-relay`, `delete-account`) | **not executed**; TypeScript syntax-checked only. Their logic lives in `_shared/*.js` and is tested through injected fakes |
| `npm run build` | **not run** in the authoring environment (native Rollup binary unavailable); verify locally |
| Live Supabase, email delivery/recovery, live AI provider, deployment | **not tested** |

## Known limitations

- The AI provider's behaviour could not be checked: whether it keeps conversation state per `chatId`, whether it accepts connections from Supabase's servers, its message-size limits, and its data retention. The relay assumes the existing protocol (JSON request; plain-text chunks; close code `1000` = finished).
- Edge Function wall-clock limits vary by plan; very long answers may be cut off (`TOTAL_TIMEOUT_MS`, default 110 s). The partial answer is kept and marked incomplete.
- No rolling conversation summary: long conversations use only the most recent messages.
- Tables, strikethrough and bare-URL auto-linking are not rendered (`remark-gfm` is not installed).
- Memory suggestion and secret detection are pattern-based heuristics.
- Conversation search uses `ILIKE` without a trigram index; fine for personal histories, slow for very large ones.
- Signed-in history is loaded on demand (and on reload); there is no live cross-device sync.
- Retrying a failed reply resends the question; if the provider had already received it, its own memory may hold it twice (each request uses a fresh `chatId`, which limits this).
- The guest response-style preference is offered for carry-over only inside the import dialog.
