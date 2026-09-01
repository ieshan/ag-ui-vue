import {
	getCurrentInstance,
	inject,
	onScopeDispose,
	toValue,
	watchEffect,
} from "vue";
import type { MaybeRefOrGetter } from "vue";
import type { Context } from "@ag-ui/client";
import { CHAT_REGISTRIES_KEY } from "../keys";
import type { ContextRegistry } from "../core/types";
import type { UseChatReturn } from "./useChat";

export interface UseAgentContextOptions {
	/**
	 * Pass a getter (or a ref) to keep the context in sync with component
	 * state — the current route, the selected rows, the open document.
	 */
	context: MaybeRefOrGetter<Context>;
	/** Pass the useChat() return to resolve the registry explicitly instead of via provide/inject. */
	chat?: UseChatReturn;
}

export interface UseAgentContextReturn {
	/** Remove the context from the registry before the scope is disposed. */
	unregister: () => void;
}

let contextIdCounter = 0;

/**
 * Register a context entry to be sent with every agent run.
 *
 * The context is added to the registry on setup and removed when the scope is
 * disposed. All registered contexts are included in `RunAgentInput.context` on
 * each run.
 *
 * The registry is resolved automatically via provide/inject when called
 * inside a descendant of the component that called `useChat()`.
 * Alternatively, pass the `chat` return object explicitly.
 *
 * Usage (reactive):
 * ```ts
 * useAgentContext({
 *   context: () => ({
 *     description: 'Current selection',
 *     value: JSON.stringify(selectedIds.value),
 *   }),
 * })
 * ```
 */
export function useAgentContext(
	options: UseAgentContextOptions,
): UseAgentContextReturn {
	const { chat } = options;

	const registry: ContextRegistry | undefined = chat
		? chat.contextRegistry
		: // inject() only works — and only stops warning — with a component
			// instance; without one the explicit `chat` option is the way in.
			getCurrentInstance()
			? inject(CHAT_REGISTRIES_KEY)?.contexts
			: undefined;

	if (!registry) {
		throw new Error(
			"[ag-ui-vue] useAgentContext() could not find a context registry. " +
				"Either call it inside a component that is a descendant of useChat(), " +
				"or pass the chat return object explicitly: useAgentContext({ context, chat }).",
		);
	}

	// Keyed by a generated id, not by `description` — two contexts sharing a
	// description are two contexts, and either unmounting must not evict the
	// other. A stable key also means a reactive update replaces in place.
	const key = `ctx-${++contextIdCounter}`;

	// `flush: "sync"`: the registry is read by the next run, which may be in
	// this same tick, so it must not lag a render behind.
	const stopWatching = watchEffect(
		() => {
			registry.set(key, toValue(options.context));
		},
		{ flush: "sync" },
	);

	function unregister() {
		stopWatching();
		registry!.delete(key);
	}

	onScopeDispose(unregister);

	return { unregister };
}
