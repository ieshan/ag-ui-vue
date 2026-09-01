import type { ShallowRef } from "vue";
import type { State } from "@ag-ui/client";
import type { AbstractAgent } from "@ag-ui/client";

export interface UseAgentStateOptions {
	state: ShallowRef<State>;
	agent: AbstractAgent;
}

export interface UseAgentStateReturn<T> {
	state: ShallowRef<T>;
	setState: (newState: T) => void;
}

/**
 * Typed reactive access to the shared agent state.
 *
 * The `state` ref is updated automatically when the agent receives
 * STATE_SNAPSHOT or STATE_DELTA events. Call `setState()` to write through to
 * the agent (sent on the next run).
 *
 * ```ts
 * const chat = useChat({ url: "http://localhost:8000" });
 * const { state, setState } = useAgentState<{ counter: number }>({
 *   state: chat.state,
 *   agent: chat.agent,
 * });
 * setState({ counter: state.value.counter + 1 });
 * ```
 */
export function useAgentState<T = State>(
	options: UseAgentStateOptions,
): UseAgentStateReturn<T> {
	const state = options.state as ShallowRef<T>;

	function setState(newState: T) {
		// Write to the agent first and mirror what it actually holds, so a state
		// the agent normalises or rejects cannot diverge from what the UI shows.
		options.agent.setState(newState as State);
		state.value = options.agent.state as T;
	}

	return { state, setState };
}
