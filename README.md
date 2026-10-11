# Mitra AI

Mitra AI is a browser-based AI chat assistant. It streams answers from an external AI service, renders them as Markdown (with copyable code blocks), and keeps your conversation history in the browser so it survives a refresh.

## Tech stack

- React 19 with Vite 7 (JavaScript / JSX)
- `react-markdown` for rendering replies (raw HTML is not rendered)
- `prop-types`, ESLint
- Plain CSS in `src/index.css` (design tokens, light and dark themes)
- Tests with Node's built-in test runner (no extra test dependencies)

There is no backend, no accounts and no cloud storage in this project.

## Requirements

Node.js 20.19+ or 22.12+ (required by Vite 7) and npm.

## Getting started

```bash
npm install
npm run dev        # development server with hot reload
npm run build      # production build into dist/
npm run preview    # serve the production build locally
npm run lint       # ESLint
npm test           # automated tests
```

## Configuration

All settings are optional. Copy `.env.example` to `.env` to override the defaults:

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_AI_WS_URL` | `wss://backend.buildpicoapps.com/api/chatbot/chat` | AI WebSocket endpoint |
| `VITE_AI_APP_ID` | `college-wife` | Application identifier sent with each request |
| `VITE_AI_SYSTEM_PROMPT` | built-in Mitra AI prompt | System prompt sent with each request |
| `VITE_AI_CONNECT_TIMEOUT_MS` | `10000` | Give up if the socket does not open in this time |
| `VITE_AI_IDLE_TIMEOUT_MS` | `45000` | Give up if the service is silent this long (reset by each chunk) |

**`VITE_*` variables are bundled into the public JavaScript.** Never put secrets in them. If a provider ever needs a private key, call it through a server-side proxy instead of from the browser.

## How the AI connection works

Each message opens one WebSocket to the configured endpoint, sends a single JSON message `{ chatId, appId, systemPrompt, message }`, and receives the answer as plain-text chunks. The service closes the connection with code `1000` when the answer is complete. This protocol is the one the project already used; it is unchanged.

- `chatId` identifies the conversation on the provider side, which is how the provider keeps context between messages. Clearing a conversation gives it a new `chatId`.
- Only one generation runs at a time. Switching chats, starting a new chat, clearing or deleting the active chat stops the running generation first; any text received so far is kept and marked as stopped.
- Every request has its own socket and handlers, so a late event from an old socket can never affect a newer request.
- Failures are shown in the conversation: connection failure, connection timeout, a silent service, a dropped connection, an empty answer and an unexpected response format. Partial text is kept and clearly marked as incomplete. **Retry** is offered for failed replies.

## Chat history and privacy

- Conversations are stored in this browser's `localStorage` (key `mitra-ai:history`, versioned format). They are not synced between devices or browsers, and they stay on the device until you delete them.
- Retention: the 50 most recently updated chats are kept, up to the newest 200 messages per chat, and the saved data is kept under about 2 MB (oldest chats are dropped first).
- Corrupted or incompatible saved data is ignored and replaced; it never crashes the app.
- Use **Delete all chats** in the sidebar (or delete a single chat) to remove saved history. The theme choice is stored under `mitra-ai:theme`.
- **Your prompts are sent to the external AI service** configured above in order to generate replies. Mitra AI cannot control how that provider handles or retains them, and deleting local history does not delete anything the provider may hold. Do not enter sensitive information you would not share with that service.
- No API keys or other secrets are stored by the app.

## Features

New chat, switch / rename / delete chats, search across titles and message text, clear a conversation, delete all history, stop generation, retry a failed reply, copy a reply or a single code block, export the current chat as Markdown, light/dark theme, keyboard-accessible controls, responsive layout with a slide-in history drawer on small screens.

Enter sends a message; Shift+Enter inserts a new line.

## Project layout

```
src/App.jsx                    application shell, dialogs, layout
src/components/                ChatContainer, InputArea, MessageBubble, Sidebar, ConfirmDialog, Icon, BrandMark
src/hooks/                     useChat, useTheme, useMediaQuery, useCopy
src/lib/chatClient.js          one streaming WebSocket request (timeouts, errors, cancel)
src/lib/chatController.js      sessions, the active request, persistence scheduling
src/lib/storage.js             versioned, bounded localStorage persistence
src/lib/chatState.js           titles, search, relative dates, Markdown export
src/config.js                  environment-based settings
tests/                         unit and rendering tests (fake WebSocket, no live provider)
```

## Tests

`npm test` runs the tests with `node --test`. They use a controllable fake WebSocket and in-memory storage, so they never contact the live AI service. They cover initial session creation (including React StrictMode), streaming, completion, cancellation, failures and timeouts, overlapping and stale requests, deleting or switching chats during generation, persistence and corrupted storage, Markdown/code rendering, accessible names, and the Enter / Shift+Enter and scrolling helpers. Rendering tests bundle components with `esbuild` (already installed as a Vite dependency) and render them to static markup; there is no DOM-based interaction test suite.

## Deployment

`npm run build` produces a static site in `dist/`. Host it on any static host (Netlify, Vercel, GitHub Pages, S3 + CDN, nginx). Set any `VITE_*` variables at build time. The page needs to be able to open a WebSocket to the configured AI endpoint.

## Known limitations

- Tables, strikethrough and bare-URL auto-linking are not rendered, because `remark-gfm` is not installed. To add it: `npm install remark-gfm`, then pass `remarkPlugins={[remarkGfm]}` to `<Markdown>` in `src/components/MessageBubble.jsx` and add table styles.
- Retrying a reply resends the same message with the same `chatId`. If the failure happened after the provider had already received the message, the provider's own memory of the conversation may contain that message twice. The provider's behaviour here could not be verified.
- The provider protocol (chunk format, close code `1000` meaning "finished") is taken from the existing integration; it could not be checked against the live service from the build environment.
- Two browser tabs share one saved history; the last tab to save wins.
- A response that is interrupted by closing the page is restored as incomplete, not as finished.
