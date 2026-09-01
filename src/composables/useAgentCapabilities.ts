import {
	onScopeDispose,
	ref,
	shallowRef,
	type Ref,
	type ShallowRef,
} from "vue";
import type { AbstractAgent, AgentCapabilities } from "@ag-ui/client";

export interface UseAgentCapabilitiesOptions {
	agent: AbstractAgent;
	/** Fetch on setup. Defaults to `true`. */
	immediate?: boolean;
}

export interface UseAgentCapabilitiesReturn {
	/** `null` until fetched, and whenever the agent declares nothing. */
	capabilities: ShallowRef<AgentCapabilities | null>;
	isLoading: Ref<boolean>;
	error: ShallowRef<Error | null>;
	/** False when the agent does not implement `getCapabilities()` at all. */
	isSupported: boolean;
	refresh: () => Promise<AgentCapabilities | null>;
}

/**
 * Read an agent's declared capabilities, for conditionally rendering features
 * it may not have — file upload, interrupts, encrypted reasoning.
 *
 * Every field is optional in the protocol, and an omitted one means
 * "undeclared", not "unsupported": treat a missing capability as unknown rather
 * than hiding a feature the agent might well support.
 *
 * ```ts
 * const chat = useChat({ url: "http://localhost:8000" });
 * const { capabilities } = useAgentCapabilities({ agent: chat.agent });
 * // v-if="capabilities?.multimodal?.input?.images"
 * ```
 */
export function useAgentCapabilities(
	options: UseAgentCapabilitiesOptions,
): UseAgentCapabilitiesReturn {
	const { agent } = options;
	const capabilities = shallowRef<AgentCapabilities | null>(null);
	const isLoading = ref(false);
	const error = shallowRef<Error | null>(null);
	const isSupported = typeof agent.getCapabilities === "function";

	let disposed = false;
	onScopeDispose(() => {
		disposed = true;
	});

	async function refresh(): Promise<AgentCapabilities | null> {
		if (!isSupported) return null;

		isLoading.value = true;
		error.value = null;
		try {
			const result = (await agent.getCapabilities!()) ?? null;
			// The scope may have gone away while the request was in flight.
			if (!disposed) capabilities.value = result;
			return result;
		} catch (err) {
			const e = err instanceof Error ? err : new Error(String(err));
			if (!disposed) error.value = e;
			return null;
		} finally {
			if (!disposed) isLoading.value = false;
		}
	}

	if (options.immediate !== false) void refresh();

	return { capabilities, isLoading, error, isSupported, refresh };
}
