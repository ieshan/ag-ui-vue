import { describe, it, expect } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import { MockStepwiseAgent } from "../utils/mock-agent";
import { mountComposable } from "../utils/mount-composable";
import { useAgent } from "../../composables/useAgent";

// Construction and option plumbing. The event-driven surface (steps,
// subagents, usage, coalescing) is covered in useAgentEvents.test.ts.

describe("useAgent", () => {
	it("starts with an empty, idle reactive surface", () => {
		const { result, unmount } = mountComposable(() =>
			useAgent({ url: "http://test" }),
		);

		expect(result.messages.value).toEqual([]);
		expect(result.state.value).toEqual({});
		expect(result.isRunning.value).toBe(false);
		expect(result.isReasoning.value).toBe(false);
		expect(result.toolCallTrackers.value.size).toBe(0);
		expect(result.steps.value).toEqual([]);
		expect(result.subagents.value.size).toBe(0);
		expect(result.interrupts.value).toEqual([]);
		unmount();
	});

	it("builds an HttpAgent from url, initialMessages and initialState", () => {
		const msgs = [{ id: "u1", role: "user" as const, content: "hello" }];
		const { result, unmount } = mountComposable(() =>
			useAgent({
				url: "http://localhost:8000",
				initialMessages: msgs,
				initialState: { count: 5 },
			}),
		);

		expect((result.agent as any).url).toBe("http://localhost:8000");
		expect(result.agent.messages.map((m) => m.id)).toEqual(["u1"]);
		expect(result.agent.state).toEqual({ count: 5 });
		// The mirrored ref is seeded from the agent, not left empty.
		expect(result.messages.value.map((m) => m.id)).toEqual(["u1"]);
		unmount();
	});

	it("uses a host-supplied agent instead of constructing an HttpAgent", () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useAgent({ agent }));

		expect(result.agent).toBe(agent);
		expect((result.agent as any).url).toBeUndefined();
		unmount();
	});

	it("passes fetch, agentId and description through to the HttpAgent", () => {
		const fetchFn = async () => new Response("");
		const { result, unmount } = mountComposable(() =>
			useAgent({
				url: "http://test",
				fetch: fetchFn,
				agentId: "a-1",
				description: "test agent",
			}),
		);

		expect((result.agent as any).fetch).toBe(fetchFn);
		expect(result.agent.agentId).toBe("a-1");
		expect(result.agent.description).toBe("test agent");
		unmount();
	});

	it("cleans up inside a bare effectScope, with no component instance", () => {
		const agent = new MockStepwiseAgent();
		const scope = effectScope();

		scope.run(() => useAgent({ agent }));
		expect(agent.subscribers).toHaveLength(1);

		// onScopeDispose (not onUnmounted) is what makes this work outside setup().
		scope.stop();
		expect(agent.subscribers).toHaveLength(0);
	});
});

describe("useAgent reactive connection options", () => {
	it("re-applies headers to the same agent when the source changes", async () => {
		const token = ref("t1");
		const { result, unmount } = mountComposable(() =>
			useAgent({
				url: "http://test",
				headers: () => ({ Authorization: `Bearer ${token.value}` }),
			}),
		);

		const agent = result.agent as any;
		expect(agent.headers).toEqual({ Authorization: "Bearer t1" });

		token.value = "t2";
		await nextTick();

		// The same instance is reconfigured — rebuilding it would drop every
		// subscriber and the transcript with them.
		expect(result.agent).toBe(agent);
		expect(agent.headers).toEqual({ Authorization: "Bearer t2" });
		unmount();
	});

	it("switches threadId without rebuilding the agent", async () => {
		const threadId = ref("thread-a");
		const { result, unmount } = mountComposable(() =>
			useAgent({ url: "http://test", threadId }),
		);

		const agent = result.agent as any;
		expect(agent.threadId).toBe("thread-a");

		threadId.value = "thread-b";
		await nextTick();

		expect(agent.threadId).toBe("thread-b");
		expect(result.agent).toBe(agent);
		unmount();
	});

	it("keeps threadId in sync with a reactive switch, not just with a run", () => {
		const threadId = ref("thread-a");
		const { result, unmount } = mountComposable(() =>
			useAgent({ url: "http://test", threadId }),
		);

		expect(result.threadId.value).toBe("thread-a");

		threadId.value = "thread-b";
		// `agent.threadId` is a plain field, so a switch that never starts a run
		// still has to be visible to the UI.
		expect(result.threadId.value).toBe("thread-b");
		unmount();
	});

	it("accepts a plain (non-reactive) header object", () => {
		const { result, unmount } = mountComposable(() =>
			useAgent({ url: "http://test", headers: { "X-Tenant": "acme" } }),
		);
		expect((result.agent as any).headers).toEqual({ "X-Tenant": "acme" });
		unmount();
	});
});
