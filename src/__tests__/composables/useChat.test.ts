import { describe, it, expect } from "vitest";
import { effectScope } from "vue";
import { mountComposable } from "../utils/mount-composable";
import { MockStepwiseAgent } from "../utils/mock-agent";
import { useChat } from "../../composables/useChat";

// Setup and option plumbing only. Behaviour lives in the focused suites:
// useChatRun (status/cancellation), useChatStream (events), useChatConfirmation
// (approve/reject), useChatInterrupt, useChatTranscript.

describe("useChat setup", () => {
	it("starts idle, with nothing in the conversation", () => {
		const { result, unmount } = mountComposable(() =>
			useChat({ url: "http://test" }),
		);

		expect(result.status.value).toBe("ready");
		expect(result.error.value).toBeNull();
		expect(result.messages.value).toEqual([]);
		expect(result.items.value).toEqual([]);
		expect(result.state.value).toEqual({});
		expect(result.isRunning.value).toBe(false);
		expect(result.isReasoning.value).toBe(false);
		expect(result.pendingToolCalls.value).toEqual([]);
		expect(result.interrupts.value).toEqual([]);
		expect(result.steps.value).toEqual([]);
		expect(result.subagents.value.size).toBe(0);
		expect(result.toolCallTrackers.value.size).toBe(0);
		unmount();
	});

	it("seeds the agent from initialState and threadId", () => {
		const { result, unmount } = mountComposable(() =>
			useChat({
				url: "http://test",
				initialState: { x: 1 },
				threadId: "thread-123",
			}),
		);

		expect(result.agent.state).toEqual({ x: 1 });
		expect(result.agent.threadId).toBe("thread-123");
		// threadId is also exposed reactively for the UI.
		expect(result.threadId.value).toBe("thread-123");
		unmount();
	});

	it("owns the registries that useFrontendTool/useAgentContext write into", () => {
		const { result, unmount } = mountComposable(() =>
			useChat({ url: "http://test" }),
		);

		// Each chat gets its own pair, so two chats in one component tree cannot
		// see each other's tools.
		expect(result.toolRegistry.size).toBe(0);
		expect(result.contextRegistry.size).toBe(0);

		const other = mountComposable(() => useChat({ url: "http://test" }));
		expect(other.result.toolRegistry).not.toBe(result.toolRegistry);
		other.unmount();
		unmount();
	});

	it("works inside a bare effectScope, with no component instance", () => {
		// The shape a Pinia store has. provide() needs an instance, so it is
		// skipped here rather than warning; the registry is still reachable by
		// passing `chat` to useFrontendTool().
		const agent = new MockStepwiseAgent();
		const scope = effectScope();
		const chat = scope.run(() => useChat({ agent }))!;

		expect(chat.toolRegistry.size).toBe(0);
		expect(agent.subscribers).toHaveLength(2);

		scope.stop();
		expect(agent.subscribers).toHaveLength(0);
	});
});
