import { describe, it, expect } from "vitest";
import { mountComposable } from "../utils/mount-composable";
import { MockStepwiseAgent } from "../utils/mock-agent";
import {
	runErrorEvent,
	runFinishedEvent,
	runStartedEvent,
	stepFinishedEvent,
	stepStartedEvent,
	subagentErrorEvent,
	subagentFinishedEvent,
	subagentStartedEvent,
	textMessageEvents,
} from "../utils/event-factories";
import { useAgent } from "../../composables/useAgent";

async function flush(times = 4) {
	for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 5));
}

/** Drive a run to completion around the events under test. */
async function runWith(agent: MockStepwiseAgent, events: unknown[]) {
	const running = agent.runAgent({});
	await flush(2);
	agent.emitAll([
		runStartedEvent({ threadId: agent.threadId }),
		...(events as any[]),
		runFinishedEvent({ threadId: agent.threadId }),
	]);
	agent.complete();
	await running.catch(() => {});
	await flush();
}

describe("useAgent step events", () => {
	it("tracks steps in order and marks each finished", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useAgent({ agent }));

		// Every step must close before RUN_FINISHED — the SDK rejects a run that
		// ends with one still active.
		await runWith(agent, [
			stepStartedEvent("retrieve"),
			stepStartedEvent("rank"),
			stepFinishedEvent("retrieve"),
			stepFinishedEvent("rank"),
		]);

		expect(result.steps.value).toEqual([
			{ name: "retrieve", status: "finished", subagentRunId: undefined },
			{ name: "rank", status: "finished", subagentRunId: undefined },
		]);
		unmount();
	});

	it("keeps a subagent's step distinct from a root step of the same name", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useAgent({ agent }));

		await runWith(agent, [
			stepStartedEvent("fetch"),
			stepStartedEvent("fetch", "sub-1"),
			stepFinishedEvent("fetch", "sub-1"),
			stepFinishedEvent("fetch"),
		]);

		expect(result.steps.value).toEqual([
			{ name: "fetch", status: "finished", subagentRunId: undefined },
			{ name: "fetch", status: "finished", subagentRunId: "sub-1" },
		]);
		unmount();
	});

	it("resets steps at the start of the next run", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useAgent({ agent }));

		await runWith(agent, [stepStartedEvent("one"), stepFinishedEvent("one")]);
		expect(result.steps.value.map((s) => s.name)).toEqual(["one"]);

		await runWith(agent, [stepStartedEvent("two"), stepFinishedEvent("two")]);
		expect(result.steps.value.map((s) => s.name)).toEqual(["two"]);
		unmount();
	});
});

describe("useAgent subagent events", () => {
	it("records a subagent invocation and its parentage", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useAgent({ agent }));

		await runWith(agent, [
			subagentStartedEvent("sub-1", "researcher", {
				description: "Looks things up",
				parentToolCallId: "tc1",
				parentMessageId: "a1",
			}),
			subagentFinishedEvent("sub-1", { result: { found: 3 } }),
		]);

		expect(result.subagents.value.get("sub-1")).toEqual({
			subagentRunId: "sub-1",
			name: "researcher",
			description: "Looks things up",
			parentSubagentRunId: undefined,
			parentToolCallId: "tc1",
			parentMessageId: "a1",
			status: "finished",
			result: { found: 3 },
		});
		unmount();
	});

	it("distinguishes a suspended subagent from a finished one", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useAgent({ agent }));

		await runWith(agent, [
			subagentStartedEvent("sub-1", "approver"),
			subagentFinishedEvent("sub-1", { outcome: { type: "suspended" } }),
		]);

		// Suspended means paused on an interrupt, and the same id resumes later —
		// rendering it as done would be wrong.
		expect(result.subagents.value.get("sub-1")!.status).toBe("suspended");
		unmount();
	});

	it("records a subagent error with its message", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useAgent({ agent }));

		await runWith(agent, [
			subagentStartedEvent("sub-1", "flaky"),
			subagentErrorEvent("sub-1", "upstream refused"),
		]);

		expect(result.subagents.value.get("sub-1")).toMatchObject({
			status: "error",
			error: "upstream refused",
		});
		unmount();
	});
});

describe("useAgent token usage", () => {
	it("exposes the usage a run reported and resets it on the next run", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useAgent({ agent }));

		expect(result.usage.value).toEqual([]);

		const running = agent.runAgent({});
		await flush(2);
		agent.emitAll([
			runStartedEvent({ threadId: agent.threadId }),
			runFinishedEvent({
				threadId: agent.threadId,
				usage: [{ provider: "openai", model: "gpt-4o", totalTokens: 120 }],
			}),
		]);
		agent.complete();
		await running.catch(() => {});
		await flush();

		// An array because one run may invoke several models.
		expect(result.usage.value).toEqual([
			{ provider: "openai", model: "gpt-4o", totalTokens: 120 },
		]);

		// Usage is per-run, so a run that reports none must not show the last
		// run's numbers.
		await runWith(agent, []);
		expect(result.usage.value).toEqual([]);
		unmount();
	});

	it("keeps the partial usage of a run that failed", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useAgent({ agent }));

		const running = agent.runAgent({});
		await flush(2);
		agent.emitAll([
			runStartedEvent({ threadId: agent.threadId }),
			runErrorEvent("model refused", { usage: [{ inputTokens: 40 }] }),
		]);
		agent.complete();
		await running.catch(() => {});
		await flush();

		// The tokens were still billed, so the failure must not discard them.
		expect(result.usage.value).toEqual([{ inputTokens: 40 }]);
		unmount();
	});
});

describe("useAgent update coalescing", () => {
	it("collapses a burst of content deltas into one message update", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useAgent({ agent }));

		let updates = 0;
		const stop = (() => {
			// Count how many distinct values the ref takes, not how many events
			// arrived — that is what a renderer pays for.
			let last = result.messages.value;
			const interval = setInterval(() => {
				if (result.messages.value !== last) {
					last = result.messages.value;
					updates++;
				}
			}, 0);
			return () => clearInterval(interval);
		})();

		await runWith(agent, textMessageEvents("hello there, streamed", "m1"));
		stop();

		expect(result.messages.value[0]).toMatchObject({ id: "m1" });
		// Start + content + end all mutate the message list; batching collapses
		// them. Asserting an exact count would encode tick boundaries, so assert
		// the property that matters: fewer published values than events.
		expect(updates).toBeLessThan(3);
		unmount();
	});

	it("honours an explicit throttleMs window", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() =>
			useAgent({ agent, throttleMs: 50 }),
		);

		const running = agent.runAgent({});
		await flush(2);
		agent.emitAll([
			runStartedEvent({ threadId: agent.threadId }),
			...(textMessageEvents("ab", "m1") as any[]),
		]);

		// Inside the window, nothing has been published yet.
		await new Promise((r) => setTimeout(r, 10));
		expect(result.messages.value).toEqual([]);

		await new Promise((r) => setTimeout(r, 60));
		expect(result.messages.value).toHaveLength(1);

		agent.emit(runFinishedEvent({ threadId: agent.threadId }));
		agent.complete();
		await running.catch(() => {});
		unmount();
	});
});
