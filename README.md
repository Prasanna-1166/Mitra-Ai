# Mitra AI

Mitra AI is an account-based, production-ready AI chat assistant. Guests enjoy an instant, no-signup trial with browser-local chat persistence, while registered users unlock cloud-synced conversations, customizable response styles, long-term memory notes, higher daily limits, and a full user profile system with custom avatars.

---

## 1. Architecture and Request Flow

```
Browser (React 19 + Vite)                       Supabase Backend
┌────────────────────────────┐   HTTPS   ┌──────────────────────────────────────────┐
│ Guest: chats in localStore │──────────▶│ Edge Function: chat-ticket               │
│ User : chats in Postgres   │           │   identifies caller → usage → auth ticket│
│ useChat → ChatController   │   WSS     ├──────────────────────────────────────────┤
│   relayClient              │──────────▶│ Edge Function: chat-relay (WebSocket)    │──WSS──▶ External AI
│ useProfile → profileService│           │   ticket → rate limits → context/memory  │         (WebSocket provider)
│ Supabase Auth & Storage    │           │   → stream → persist → charge usage      │
│ RLS-guarded Postgres tables│◀──────────├──────────────────────────────────────────┤
└────────────────────────────┘ PostgREST │ Edge Function: delete-account            │
                                         │   authenticates user → cleans avatars    │
                                         │   → cascades database records deletion   │
                                         └──────────────────────────────────────────┘
                                         PostgreSQL: profiles, conversations,
                                         messages, user_memories, user_settings,
                                         usage_events, guest_sessions, chat_tickets,
                                         rate_limits; Storage: avatars
```

### Request Lifecycle
1. **Prompt Submission**: The user or guest sends a message. The local UI instantly creates a pending assistant placeholder and starts streaming indicators.
2. **Ticket Issuance**: The client requests a single-use ticket from `/functions/v1/chat-ticket`. The endpoint validates the user's Supabase JWT or guest session token, checks rate limits and quotas, and returns a cryptographically secure 192-bit ticket hash.
3. **WebSocket Upgrade & Accounting**: The browser opens a WebSocket connection to `/functions/v1/chat-relay?ticket=...`. The relay consumes the ticket atomically and reserves 1 prompt allowance under a PostgreSQL transaction advisory lock.
4. **Context & Memory Assembly**: For signed-in users, the relay retrieves verified conversation history and user-enabled memory notes directly from PostgreSQL. For guests, the browser provides bounded, sanitized history.
5. **Streaming AI Response**: The relay contacts the upstream AI provider, streaming tokens back to the browser via WebSocket frames.
6. **Persistence & Finalization**: The response is saved to the database (or browser storage for guests). If the answer completes successfully, the reservation status is finalized as `completed` (or `partial` if interrupted after text). If connection fails before text is produced, the reservation is released.

---

## 2. Capabilities & Features

### User Profile System
- **Profile Information**: Persistent display name, authenticated email address, custom profile avatar, account creation timestamp, and active status.
- **Avatar Management**: Upload custom avatars (PNG, JPG, WebP, GIF up to 2 MB) to a dedicated, private Supabase Storage bucket (`avatars`). Replaced avatar files are safely purged, and removal reverts back to the default monogram avatar.
- **Security & Privacy**: Profile storage rows and storage objects are guarded by Row Level Security (RLS). Users can only read, upload, and update their own avatars and profile data. Profile creation is automated and idempotent via a PostgreSQL trigger (`handle_new_user()`).

### Chat Workspace
- **Dual Storage Modes**: Browser-local storage for guests (zero configuration needed) and PostgreSQL for authenticated accounts.
- **Guest-to-Account Migration**: Safe, idempotent import flow that preserves timestamps, titles, and message sequence.
- **Smart Memory System**: Explicit memory recording ("remember that I work in TypeScript") and opt-in preference suggestions with undo capabilities and sensitive-data heuristics.
- **Response Styles**: Choice of Concise, Balanced, or Detailed answer depth.

---

## 3. Database Schema & Migrations

The database migrations are located in `supabase/migrations/`:
1. `20261011000001_schema.sql`: Core tables (`conversations`, `messages`, `user_memories`, `user_settings`, `guest_sessions`, `chat_tickets`, `usage_events`, `rate_limits`).
2. `20261011000002_security.sql`: Row Level Security policies, narrow grants, and column-level update locks.
3. `20261011000003_functions.sql`: Stored procedures for atomic usage reservation (`reserve_usage`), rate limiting (`rate_limit_hit`), and conversation search (`search_conversations`).
4. `20261012000001_profiles.sql`: User profiles table (`public.profiles`), owner guard triggers, automatic user profile creation trigger (`handle_new_user`), backfill, and private `avatars` storage bucket with folder-scoped RLS policies.

---

## 4. Environment Variables

### Frontend (`.env.local` or hosting environment)
All browser-visible variables must be prefixed with `VITE_`. **Never place service-role keys or private secrets in frontend files.**

| Variable | Required | Purpose | Visible In Browser |
| --- | --- | --- | --- |
| `VITE_SUPABASE_URL` | **Yes** | Supabase project URL (`https://<project-ref>.supabase.co`) | Yes |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | **Yes** | Supabase publishable key (`sb_publishable_...` or anon key) | Yes |
| `VITE_CONNECT_TIMEOUT_MS` | No | WebSocket connect timeout (default: 12000) | Yes |
| `VITE_IDLE_TIMEOUT_MS` | No | WebSocket inactivity timeout (default: 60000) | Yes |
| `VITE_MAX_MESSAGE_CHARS` | No | Client input character cap (default: 8000) | Yes |
| `VITE_GUEST_CONTEXT_MESSAGES` | No | Max historical messages sent by guests (default: 20) | Yes |

### Edge Functions (`supabase/.env` via `supabase secrets set`)
Injected server-side into Edge Functions.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GUEST_PROMPT_LIMIT` | `5` | Total free questions permitted per guest session |
| `USER_DAILY_LIMIT` | `100` | Daily prompt limit per signed-in user (UTC day) |
| `GUEST_SESSION_DAYS` | `30` | Expiration window for inactive guest sessions |
| `REQUESTS_PER_MINUTE` | `8` | Maximum requests per minute per subject |
| `GUEST_SESSIONS_PER_IP_PER_DAY` | `20` | Max guest sessions created per hashed IP daily |
| `ALLOWED_ORIGINS` | `http://localhost:5173,...` | Comma-separated list of allowed browser origins |
| `IP_HASH_SALT` | Random string | Salt for non-reversible IP hashing |
| `AI_UPSTREAM_WS_URL` | Provider URL | Upstream WebSocket endpoint |
| `AI_UPSTREAM_APP_ID` | `college-wife` | Application identifier for the AI provider |

---

## 5. Local Setup & Development

### Prerequisites
- Node.js 20.19+ or 22.12+
- npm 10+
- Supabase CLI installed (`npm install -g supabase` or via package manager)

### Installation
```bash
# Clone and enter workspace
git clone <repo-url>
cd <repo-folder>

# Install dependencies cleanly using lockfile
npm ci
```

### Environment Setup
```bash
# Frontend environment
cp .env.example .env.local
# Edit .env.local with your Supabase URL and Publishable Key

# Backend secrets
cp supabase/.env.example supabase/.env
# Edit supabase/.env with your production origins and IP salt
```

### Run Locally
```bash
# Start frontend development server
npm run dev
# Accessible at http://localhost:5173
```

---

## 6. Automated Testing & Verification

The test suite runs with Node.js's built-in test runner, verifying all components, services, controllers, storage engines, relay protocols, and isolation rules without external network dependencies:

```bash
# Run automated test suite (151 unit & integration tests)
npm test

# Run ESLint check
npm run lint

# Build production bundle with optimized chunking
npm run build

# Preview production build locally
npm run preview
```

### Database pgTAP Verification
If running the local Supabase stack (`supabase start`):
```bash
supabase test db
```

---

## 7. Production Deployment Guide

### Step 1: Deploy Supabase Database & Migrations
1. Log in and link your project:
   ```bash
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   ```
2. Apply all migrations in sequence:
   ```bash
   supabase db push
   ```

### Step 2: Configure Supabase Authentication & Storage
1. **Dashboard → Authentication → URL Configuration**:
   - Set **Site URL** to your production domain (e.g., `https://mitra.example.com`).
   - Add all active domains to **Redirect URLs** (e.g., `https://mitra.example.com/**`, `http://localhost:5173`).
2. **Dashboard → Authentication → Providers → Email**:
   - Ensure Email provider is enabled.
   - For production, turn on **Confirm email** and configure custom SMTP (Settings → SMTP) to bypass Supabase's default rate limits.
3. **Storage**:
   - The `avatars` bucket and folder-scoped RLS policies are created automatically by migration `20261012000001_profiles.sql`.

### Step 3: Set Secrets & Deploy Edge Functions
1. Set server-side environment secrets:
   ```bash
   supabase secrets set --env-file supabase/.env
   ```
2. Deploy the Edge Functions:
   ```bash
   supabase functions deploy chat-ticket
   supabase functions deploy chat-relay
   supabase functions deploy delete-account
   ```

### Step 4: Deploy Frontend (Vercel, Cloudflare Pages, Netlify, or AWS S3/CloudFront)
1. Configure Environment Variables in your hosting dashboard:
   - `VITE_SUPABASE_URL`: `https://YOUR_PROJECT_REF.supabase.co`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`: `sb_publishable_...`
2. Set Build Command: `npm run build`
3. Set Output Directory: `dist`
4. **SPA Fallback Routing**: Ensure all routes rewrite to `/index.html` (e.g., via `_redirects` for Netlify, `vercel.json` for Vercel, or custom 404 handler).

---

## 8. Security & Privacy Guarantees

1. **Row Level Security**: Every user-owned table (`profiles`, `conversations`, `messages`, `user_memories`, `user_settings`) enforces `auth.uid()` checks. Column grants prevent editing `id`, `user_id`, or timestamps.
2. **Isolated Storage**: Avatars are stored in a private bucket (`avatars`). Storage RLS policies ensure users can only list, view, upload, or delete files in their own folder (`avatars/<user_id>/...`).
3. **Single-Use Signed Relay Tickets**: Browsers cannot connect directly to the WebSocket relay without a cryptographically generated, single-use ticket consumed within 60 seconds.
4. **Account Lifecycle & Cascading Deletion**: Account deletion invokes `/functions/v1/delete-account`, which deletes all user avatar objects from storage before deleting the Supabase Auth user. PostgreSQL foreign keys with `ON DELETE CASCADE` automatically purge all conversations, messages, memories, and usage logs.
5. **In-Memory Hygiene**: Logging out or switching accounts immediately flushes and purges all active session memory, user profile data, and conversation history, preventing cross-user data leakage.
6. **No Secret Leakage**: Service role keys, provider tokens, and upstream credentials are never committed, bundled, or exposed to client JavaScript.

---

## 9. Verification Status

| Check | Command | Status | Notes |
| --- | --- | --- | --- |
| Linter | `npm run lint` | **PASSED** | 0 errors, 0 warnings across all files |
| Unit & Integration Tests | `npm test` | **PASSED** | 151 / 151 tests passing |
| Production Build | `npm run build` | **PASSED** | Optimized code splitting, all chunks < 300 kB |
| Database Schema & RLS | `supabase db push` | **READY** | 4 additive, idempotent migrations |
| Edge Functions | `supabase functions deploy` | **READY** | `chat-ticket`, `chat-relay`, `delete-account` |
| Avatar Storage | `storage.buckets` | **READY** | Configured in `20261012000001_profiles.sql` |
