import {
	getCurrentInstance,
	inject,
	onScopeDispose,
	toValue,
	watchEffect,
} from "vue";
import type { MaybeRefOrGetter } from "vue";
import { CHAT_REGISTRIES_KEY } from "../keys";
import type { FrontendTool, FrontendToolRegistry } from "../core/types";
import type { UseChatReturn } from "./useChat";

export interface UseFrontendToolOptions {
	/**
	 * Pass a getter (or a ref) to make the registration reactive: whenever a
	 * value it reads changes, the tool is re-registered. That covers a schema
	 * built from component state, a `handler` closing over changing props, and
	 * flipping `available` to hide the tool from the agent.
	 */
	tool: MaybeRefOrGetter<FrontendTool>;
	/** Pass the useChat() return to resolve the registry explicitly instead of via provide/inject. */
	chat?: UseChatReturn;
}

export interface UseFrontendToolReturn {
	/** Remove the tool from the registry before the scope is disposed. */
	unregister: () => void;
}

/**
 * Register a frontend tool that the agent can call.
 *
 * The tool is added to the registry on setup and removed when the scope is
 * disposed. Registered tools are included in `RunAgentInput.tools` on every
 * run — except a wildcard `"*"` tool, which handles calls no other tool
 * matches and is never advertised.
 *
 * The registry is resolved automatically via provide/inject when called
 * inside a descendant of the component that called `useChat()`.
 * Alternatively, pass the `chat` return object explicitly.
 *
 * Usage (auto-discovery):
 * ```ts
 * useFrontendTool({
 *   tool: {
 *     name: 'get_weather',
 *     description: 'Get weather for a location',
 *     parameters: { type: 'object', properties: { city: { type: 'string' } } },
 *     handler: async (args) => fetchWeather(args.city),
 *   },
 * })
 * ```
 *
 * Usage (reactive):
 * ```ts
 * useFrontendTool({
 *   tool: () => ({
 *     name: 'save_draft',
 *     handler: async () => save(draft.value),
 *     available: canEdit.value,
 *   }),
 * })
 * ```
 */
export function useFrontendTool(
	options: UseFrontendToolOptions,
): UseFrontendToolReturn {
	const { chat } = options;

	const registry: FrontendToolRegistry | undefined = chat
		? chat.toolRegistry
		: // inject() only works — and only stops warning — with a component
			// instance; without one the explicit `chat` option is the way in.
			getCurrentInstance()
			? inject(CHAT_REGISTRIES_KEY)?.tools
			: undefined;

	if (!registry) {
		throw new Error(
			"[ag-ui-vue] useFrontendTool() could not find a tool registry. " +
				"Either call it inside a component that is a descendant of useChat(), " +
				"or pass the chat return object explicitly: useFrontendTool({ tool, chat }).",
		);
	}

	let registeredName: string | undefined;
	let registeredTool: FrontendTool | undefined;

	function removeRegistration() {
		// Only delete if we still own the entry — a later registration of the
		// same name must not be removed by our cleanup.
		if (
			registeredName !== undefined &&
			registry!.get(registeredName) === registeredTool
		) {
			registry!.delete(registeredName);
		}
		registeredName = undefined;
		registeredTool = undefined;
	}

	// `flush: "sync"` because the registry is not render state: a tool the
	// consumer just changed must be in place before the next send(), which can
	// happen in the same tick.
	const stopWatching = watchEffect(
		() => {
			const tool = toValue(options.tool);
			removeRegistration();

			if (registry.has(tool.name)) {
				console.warn(
					`[ag-ui-vue] A frontend tool named "${tool.name}" is already registered on this chat. The previous registration has been replaced, and unregistering either one will remove the tool.`,
				);
			}

			registry.set(tool.name, tool);
			registeredName = tool.name;
			registeredTool = tool;
		},
		{ flush: "sync" },
	);

	function unregister() {
		stopWatching();
		removeRegistration();
	}

	onScopeDispose(unregister);

	return { unregister };
}
