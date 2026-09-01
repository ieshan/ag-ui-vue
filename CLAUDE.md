# ag-ui-vue

Vue 3 library (`@ag-ui-vue/core`) — AG-UI protocol integration via composables.

## Commands

IMPORTANT: All commands run inside Docker. NEVER run npm/npx on the host.

```sh
docker compose up -d ag-ui-vue              # Start dev container
docker compose exec ag-ui-vue npx vitest run          # Test
docker compose exec ag-ui-vue npx vitest              # Test (watch)
docker compose exec ag-ui-vue npx vue-tsc --noEmit    # Type check
docker compose exec ag-ui-vue npx vite build          # Build
docker compose exec ag-ui-vue npx eslint .            # Lint
docker compose exec ag-ui-vue npx eslint . --fix      # Lint (autofix)
docker compose exec ag-ui-vue npx prettier --write .  # Format
docker compose exec ag-ui-vue npm install             # Install deps
docker compose exec ag-ui-vue sh                      # Shell
docker compose --profile example up -d                # Example backend
```

## Verification

After making changes, always run:

1. `docker compose exec ag-ui-vue npx vitest run` — exits 0
2. `docker compose exec ag-ui-vue npx vue-tsc --noEmit` — exits 0
3. `docker compose exec ag-ui-vue npx eslint .` — exits 0
4. `docker compose exec ag-ui-vue npx prettier --check .` — exits 0

## Project Structure

- `src/index.ts` — Barrel exports (public API surface)
- `src/plugin.ts` — `createAGUI()` Vue plugin
- `src/provider.ts` — `useProvideAGUI` / `useAGUI` (provide/inject wiring)
- `src/keys.ts` — typed `InjectionKey`s and provider state (Vue-layer, deliberately outside `core/`)
- `src/config.ts` — the `AgentSource` union and its guards. Vue-layer, not `core/`, because the options are reactive (`MaybeRefOrGetter`).
- `src/composables/` — `useAgent`, `useChat`, `useAgentState`, `useFrontendTool`, `useAgentContext`, `useAgentCapabilities`
- `src/core/` — `types.ts`, `tool-executor.ts`, `tool-call-tracker.ts`, `view-model.ts` (the renderer-agnostic `ChatItem` timeline — the public rendering contract)
- `src/__tests__/` — Tests mirroring src/ tree; `utils/` has `mountComposable`, `mockAgent`, event factories
- `examples/backend/` — Python FastAPI + Google ADK example server

## Code Conventions

- Tabs for indentation. NEVER spaces. Enforced by `.prettierrc` (`"useTabs": true`), surfaced as ESLint errors via `eslint-plugin-prettier` (`eslint.config.js`).
- Double quotes for strings (`"singleQuote": false`), same enforcement path as above.
- `import type` for type-only imports.
- `interface` over `type` for exported shapes.
- Composition API only — no Options API. Logic lives in `useX()` composables.
- `shallowRef` for complex/nested structures. `ref` for scalars.
- `provide`/`inject` with typed `InjectionKey` symbols. NEVER string keys.
- Error messages prefixed with `[ag-ui-vue]`.
- Clean up in `onScopeDispose` — NEVER `onUnmounted`, so composables work inside an `effectScope`/Pinia store.
- Composable naming: `useChat.ts`, options `UseChatOptions`, returns `UseChatReturn`.
- New composables must be exported from `src/index.ts`.
- Reactive options take `MaybeRefOrGetter<T>` and are read with `toValue()`. Registry writes use `watchEffect(..., { flush: "sync" })` — the registries are read by the next run, which can be in the same tick, not at render time.

## Testing

- Tests in `src/__tests__/`, mirroring src/ tree. File pattern: `*.test.ts`.
- Use `mountComposable()` from `src/__tests__/utils/mount-composable.ts`.
- Explicitly import `describe`, `it`, `expect`, `vi` from `vitest`.
- Vitest with `happy-dom` environment.

## Protocol notes (verified against @ag-ui/client 0.0.59)

- `agent.pendingInterrupts` is written **after** subscribers run, so read the outcome from `onRunFinishedEvent`'s params, never from that field inside the callback.
- A run must not end with a step still active, and a step name cannot be started twice for the same owner — `verifyEvents` errors the stream. Test streams must be protocol-legal.
- `THINKING_*` events exist in `EventType` but have no subscriber callbacks. They are legacy — do NOT implement them; `REASONING_*` is the live surface.
- `AbstractAgent.abortRun()` is an empty method. Cancellation needs `detachActiveRun()` plus our own `AbortController` for handler signals.
- The client's apply layer materialises activity, reasoning, `encryptedValue` and tool results into `agent.messages`, which is why `toChatItems()` can be pure. Do not rebuild the timeline from events.
- `InputContent` carries `mimeType` on `source`, not on the part.
- `agent.messages.splice()` is invisible to subscribers: `AbstractAgent` only notifies from
  `addMessage`/`addMessages`/`setMessages`. Insert at a position by building the array and calling
  `setMessages`, or the change never reaches anything derived from it.
- Every `AgentSubscriber` callback is fully typed, including the `outcome` discriminant on
  `onRunFinishedEvent` — event fields need no casts.

## Architecture

- `useChat` composes `useAgent` — higher-level composables build on lower-level ones.
- Per-chat tool/context registries via `provide`/`inject` (`CHAT_REGISTRIES_KEY`).
- `createAGUI()` plugin for global config; `useProvideAGUI()`/`useAGUI()` at component level.
- NEVER couple core to a component library. Consumers render from `ChatItem`/`ChatPart` (`src/core/view-model.ts`); adapters live in the host app.

## Boundaries

- NEVER import from `vue` inside `src/core/` — it must stay framework-free. Inject scheduler hooks (e.g. `waitForFrameworkUpdates`) from the composable layer instead.
- NEVER run commands on the host — always inside Docker.
- NEVER delete tests or skip tests to fix errors.
- NEVER install global packages in the container.
- If tests fail after 2 fix attempts: stop, report the failure with full output.
- If a type is unclear: read `src/core/types.ts` before guessing.
