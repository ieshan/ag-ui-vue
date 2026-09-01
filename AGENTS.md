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

A task is complete when ALL pass:

1. `docker compose exec ag-ui-vue npx vitest run` exits 0
2. `docker compose exec ag-ui-vue npx vue-tsc --noEmit` exits 0
3. `docker compose exec ag-ui-vue npx eslint .` exits 0
4. `docker compose exec ag-ui-vue npx prettier --check .` exits 0

## Project Structure

```
src/
├── index.ts              # Barrel exports (public API)
├── plugin.ts             # createAGUI() Vue plugin
├── provider.ts           # useProvideAGUI / useAGUI
├── composables/          # useAgent, useChat, useAgentState, useFrontendTool,
│                         #   useAgentContext, useAgentCapabilities
├── keys.ts               # typed InjectionKeys + provider state (Vue layer)
├── config.ts             # AgentSource union + guards (reactive, so not core/)
├── core/                 # types.ts, tool-executor.ts, tool-call-tracker.ts,
│                         #   view-model.ts (ChatItem timeline) — framework-free
└── __tests__/            # Tests mirroring src/ tree; utils/ has test helpers
examples/backend/         # Python FastAPI + Google ADK example server
```

## When Writing Code

- Use tabs for indentation. NEVER spaces. Enforced by `.prettierrc` (`"useTabs": true`), surfaced as ESLint errors via `eslint-plugin-prettier` (`eslint.config.js`).
- Use double quotes for strings (`"singleQuote": false`), same enforcement path as above.
- Use `import type` for type-only imports.
- Prefer `interface` over `type` for exported shapes.
- Composition API only — no Options API. All logic lives in `useX()` composables.
- Use `shallowRef` for complex/nested structures (messages, maps). Use `ref` for scalars.
- Use `provide`/`inject` with typed `InjectionKey` symbols. NEVER string injection keys.
- Prefix error messages with `[ag-ui-vue]`.
- Clean up side effects in `onScopeDispose` (never `onUnmounted`) so composables work inside an `effectScope` or Pinia store.
- Composable files: `useChat.ts` (camelCase, `use` prefix).
- Option types: `UseChatOptions`. Return types: `UseChatReturn`.
- New composable → export from `src/index.ts`.

## When Writing Tests

- Tests live in `src/__tests__/` mirroring the source tree. File naming: `*.test.ts`.
- Use the `mountComposable()` helper from `src/__tests__/utils/mount-composable.ts`.
- Explicitly import `describe`, `it`, `expect`, `vi` from `vitest`.
- Runner: Vitest with `happy-dom` environment.

## Key Patterns

- `useChat` composes `useAgent` — higher-level composables build on lower-level ones.
- Per-chat tool/context registries shared via `provide`/`inject` (`CHAT_REGISTRIES_KEY`).
- `createAGUI()` plugin provides global config; `useProvideAGUI()`/`useAGUI()` at component level.
- No component-library coupling in core. Consumers render from the `ChatItem`/`ChatPart` timeline in `src/core/view-model.ts`; adapters belong in the host app.

## When Blocked

- If tests fail after 2 fix attempts: stop and report the failing test with full output.
- If a type error is unclear: read the relevant source in `src/core/types.ts`.
- `agent.pendingInterrupts` is set after subscribers run — read interrupt outcomes from `onRunFinishedEvent`'s params instead.
- Test event streams must be protocol-legal: close every step before `RUN_FINISHED`, and never start the same step name twice for one owner.
- `agent.messages.splice()` does not notify subscribers — only `addMessage`/`addMessages`/`setMessages` do.
- Subscriber callback params are fully typed; do not cast `event` to `any`.
- NEVER delete test files or skip tests to resolve errors.
- NEVER run commands on the host machine outside Docker.
- NEVER install global packages inside the container.
