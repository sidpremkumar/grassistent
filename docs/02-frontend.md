# 02 — Frontend

React 19 + `@grafana/ui` 13, bundled by webpack to an AMD `module.js`. Framework
packages (`react`, `react-dom`, `react-dom/client`, `@grafana/*`, `@emotion/css`)
are webpack `externals` provided by the Grafana host at runtime.

## Registration & global mount — `src/module.tsx`

```tsx
export const plugin = new AppPlugin<{}>()
  .setRootPage(App)                       // pages/App.tsx -> AppPage
  .addConfigPage({ title: 'Configuration', icon: 'cog', body: ConfigPage, id: 'configuration' });

mountFloatingChat();                      // creates a <div> in <body>, renders <FloatingChat/>
```

- **Root page**: `pages/App.tsx` renders `AppPage` (nav item "MCP Agent").
- **Config page**: `pages/ConfigPage.tsx` (admin only). See [08-config.md](./08-config.md).
- **Global chat**: `module.tsx` runs on **every page** because `plugin.json` sets
  `"preload": true`. It mounts `FloatingChat` into a body-attached root via
  `createRoot`, guarded against double-mounting.

### Why not an extension point?

Grafana 13 hardcodes the top-bar (`nav-right-button/v1`, `singletopbar/action`)
and `extension-sidebar/v0-alpha` slots to an internal plugin allow-list
(`renderLimitedComponents(..., SETUPGUIDE_PLUGIN_ID)`), so a third-party plugin's
registered component/link never renders there. Hence the DOM-injection approach
below. `plugin.json` `extensions.addedLinks`/`addedComponents` are left empty.

## Global entry — `components/FloatingChat.tsx`

Responsibilities:

1. **Top-bar trigger injection.** A `MutationObserver` on `document.body` finds
   the top-bar search control (tries `data-testid`, `aria-label`, placeholder
   selectors) and inserts a gradient button just before that cluster, so it sits
   next to Search / Sign in. Re-runs on Grafana's chrome re-renders. Clicking it
   dispatches a `mcpagent:toggle` window event.
2. **Docked panel that pushes the page.** When open, it sets
   `padding-right: <PANEL_WIDTH>px` on `.grafana-app` (with a slide transition),
   shrinking the app content, and renders the chat as a `position: fixed` right
   column. **No backdrop** — the page stays fully interactive so the agent can
   help edit panels/queries. Restores padding on close/unmount.
3. **Fallback FAB.** If the search anchor can't be found, a floating action
   button is rendered instead so the chat is always reachable.
4. `Esc` closes the panel.

## Chat surface — `components/ChatPanel.tsx`

The reusable chat surface. Responsibilities:

- **Sessions / history**: reads/writes `lib/chat-store.ts`. Header has a history
  toggle (browse/resume/delete prior threads), a new-chat button, and (in drawer
  mode) a close button via the optional `onClose` prop. Titles auto-derive from
  the first user message. The active conversation is persisted to localStorage
  whenever messages settle.
- On mount: `extractPageContext()` with a 3×700ms retry (Scenes hydrates async),
  re-extracted on every URL change (`locationService.getHistory().listen`).
  `buildPrefill(ctx)` feeds a tappable **suggestion chip** above the composer —
  the input is never pre-seeded; tapping the chip fills it.
- **Interaction chips**: when a browser tool needs the human (`ask_user`
  question options, or the Allow / Always allow / Deny confirmation gate for
  mutating tools), `useAgentChat.interaction` renders as an inline card above
  the composer (`styles.interaction`); answers resume the paused agent loop.
  See [11](./11-browser-tools.md).
- Renders the **context disclosure** (`ContextDisclosure`), message list, and
  input row.
- **Context disclosure** ("what the agent can see"): a collapsible header at the
  top of the panel showing whether context was captured — `Agent sees N queries`
  / `Agent sees this page` when present, or `Agent has no page context` when
  empty. Expanding it lists the exact Dashboard / Datasource / Time range and the
  captured queries (as `<code>` rows), so the agent's awareness is legible and an
  empty context is obvious rather than silent.
- **Typewriter answer**: assistant text renders in place as `content` deltas
  arrive, with a blinking caret while `streaming`. There is deliberately **no
  `layout` animation** on the growing bubble (it caused reflow "squish").
- `Enter` sends, `Shift+Enter` newlines.
- Delegates conversation state to `useAgentChat`; delegates the reasoning/tool
  trace to `ThinkingBlock`.

## Session persistence — `lib/chat-store.ts`

- Single JSON blob under `mcpagent.chat.v1` in `localStorage`.
- `ChatSession = { id, title, createdAt, updatedAt, messages }`.
- `loadStore` / `saveStore` (trims to 50 most-recent), `newSession`,
  `deriveTitle`. All best-effort and corruption-tolerant.

## State machine — `components/use-agent-chat.ts`

`useAgentChat(sessionId, initialMessages?)` returns
`{ messages, busy, send, cancel, reset, load }`. `load(msgs)` swaps the
conversation when switching sessions.

`ChatMessage` shape:

```ts
type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning: string;           // streamed reasoning shown in ThinkingBlock
  toolCalls: ChatToolCall[];   // { id, server, name, status, preview?, error? }
  status?: string;
  streaming: boolean;
};
```

`send(text, pageContext)`:
1. Snapshots prior non-empty messages as `history`.
2. Pushes a user message + a streaming assistant placeholder.
3. Opens the SSE stream via `streamChat()` and patches the assistant message on
   each `AgentEvent`: `content` → append, `reasoning` → append, `status` → set,
   `tool_call` → push running call, `tool_result` → update matching call,
   `done` → finalize, `error` → error text.
4. `onDone`/`onError` clear `busy` and the abort ref.

`cancel()` aborts the in-flight fetch; `reset()` clears; `load()` replaces.

> `history` is sent to the backend, which is otherwise stateless per turn — there
> is no server-side session store. Persistence is purely client-side.

## Streaming client — `lib/chat-stream.ts`

`streamChat(request, handlers, signal)`:
- `POST /api/plugins/mcpagent-app/resources/chat` with `Accept: text/event-stream`.
- Reads `response.body` with a `TextDecoder`, splits on `\n\n`, parses the
  `data:` line via `parseAgentEvent`.
- Same-origin; relies on the Grafana session (no explicit auth header).

## Animation system — `lib/motion.ts`

Centralized framer-motion tokens for a cohesive feel:
- `spring` / `springFast`: spring transitions (no linear tweens).
- `messageVariants`, `chipVariants`, `contextVariants`, `pageVariants`,
  `drawerVariants`, `backdropVariants`, `fabVariants`, `popoverVariants`,
  `thinkingPulse`.
- All animated components honor `useReducedMotion()`.

## Conventions enforced

- No barrel/`index.ts` files.
- No dynamic imports (all imports top-of-file).
- No `any` in TS.
- `function(args: {...})` object-arg style where a function takes options.
- Docstrings via `/* ... */`.
