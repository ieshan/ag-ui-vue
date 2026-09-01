import { describe, it, expect, vi } from "vitest";
import { shallowRef } from "vue";
import { useAgentState } from "../../composables/useAgentState";

/**
 * A stand-in for AbstractAgent's own behaviour: setState stores the value and
 * `state` is readable afterwards. useAgentState mirrors what the agent actually
 * holds, so a mock that silently drops the write would not represent reality.
 */
function makeAgent(normalize: (s: any) => any = (s) => s) {
	const agent: any = {
		state: undefined,
		setState: vi.fn((next: any) => {
			agent.state = normalize(next);
		}),
	};
	return agent;
}

describe("useAgentState", () => {
	it("types the shared ref without copying it", () => {
		const stateRef = shallowRef({ user: { name: "Alice" } });
		const { state } = useAgentState<{ user: { name: string } }>({
			state: stateRef,
			agent: makeAgent(),
		});

		expect(state.value.user.name).toBe("Alice");

		// The same ref the agent's STATE_SNAPSHOT/STATE_DELTA handling writes to,
		// so an external update is visible here with no extra wiring.
		stateRef.value = { user: { name: "Bob" } };
		expect(state.value.user.name).toBe("Bob");
	});

	it("writes through to the agent and shows what the agent kept", () => {
		const agent = makeAgent();
		const { state, setState } = useAgentState<{ count: number }>({
			state: shallowRef({ count: 0 }),
			agent,
		});

		setState({ count: 99 });

		expect(agent.setState).toHaveBeenCalledWith({ count: 99 });
		expect(state.value.count).toBe(99);
	});

	it("reflects a state the agent normalised rather than the value written", () => {
		// An agent that clamps the value — the UI must show the clamped result,
		// not the rejected input.
		const agent = makeAgent((s: { count: number }) => ({
			count: Math.min(s.count, 5),
		}));
		const { state, setState } = useAgentState<{ count: number }>({
			state: shallowRef({ count: 0 }),
			agent,
		});

		setState({ count: 10 });
		expect(state.value.count).toBe(5);
	});
});
