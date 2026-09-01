import { describe, it, expect, vi } from "vitest";
import { mountComposable } from "../utils/mount-composable";
import { MockStepwiseAgent } from "../utils/mock-agent";
import {
	reasoningStartEvent,
	runErrorEvent,
	runFinishedEvent,
	runStartedEvent,
	toolCallArgsEvent,
	toolCallEndEvent,
	toolCallStartEvent,
} from "../utils/event-factories";
import { useChat } from "../../composables/useChat";

async function flush(times = 4) {
	for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 5));
}

function runStarted(agent: MockStepwiseAgent, runId = "r1") {
	return runStartedEvent({ threadId: agent.threadId, runId });
}

function runFinished(agent: MockStepwiseAgent, runId = "r1") {
	return runFinishedEvent({ threadId: agent.threadId, runId });
}

describe("useChat run lifecycle", () => {
	it("keeps status 'error' after RUN_ERROR and does not call onFinish", async () => {
		const agent = new MockStepwiseAgent();
		const onFinish = vi.fn();
		const onError = vi.fn();
		const { result, unmount } = mountComposable(() =>
			useChat({ agent, onFinish, onError }),
		);

		const sent = result.send("hi");
		await flush(2);

		// RUN_ERROR is a normal stream event, so runAgent() resolves afterwards —
		// the success path must not overwrite the error state.
		agent.emitAll([runStarted(agent), runErrorEvent("backend exploded")]);
		agent.complete();
		await sent.catch(() => {});

		expect(result.status.value).toBe("error");
		expect(result.error.value?.message).toBe("backend exploded");
		expect(onError).toHaveBeenCalled();
		expect(onFinish).not.toHaveBeenCalled();
		unmount();
	});

	it("reports 'streaming' during a reasoning-only prefix", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		const sent = result.send("hi");
		await flush(2);
		expect(result.status.value).toBe("submitted");

		agent.emitAll([runStarted(agent), reasoningStartEvent()]);
		await flush();

		// Previously stayed at "submitted" for the whole thinking phase.
		expect(result.status.value).toBe("streaming");
		expect(result.isReasoning.value).toBe(true);

		agent.emit(runFinished(agent));
		agent.complete();
		await sent.catch(() => {});
		unmount();
	});

	it("rejects a concurrent send instead of interleaving two runs", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		const first = result.send("one");
		await flush(2);

		await expect(result.send("two")).rejects.toThrow(/already in progress/);

		agent.emitAll([runStarted(agent), runFinished(agent)]);
		agent.complete();
		await first;
		expect(agent.runCount).toBe(1);
		unmount();
	});

	it("treats stop() as a cancellation, not an error", async () => {
		const agent = new MockStepwiseAgent();
		const onError = vi.fn();
		const { result, unmount } = mountComposable(() =>
			useChat({ agent, onError }),
		);

		const sent = result.send("hi");
		await flush(2);
		agent.emit(runStarted(agent));
		await flush();

		result.stop();
		await flush();

		expect(result.status.value).toBe("ready");
		expect(result.error.value).toBeNull();
		expect(onError).not.toHaveBeenCalled();

		// Let the hanging observable go so the pending send settles.
		agent.complete();
		await expect(sent).resolves.toBeNull();
		unmount();
	});

	it("unsubscribes its status subscriber on dispose", () => {
		const agent = new MockStepwiseAgent();
		const { unmount } = mountComposable(() => useChat({ agent }));

		// One from useAgent, one from useChat's status handlers.
		expect(agent.subscribers).toHaveLength(2);
		unmount();
		expect(agent.subscribers).toHaveLength(0);
	});

	it("passes forwardedProps on the first run", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() =>
			useChat({ agent, forwardedProps: { tenantId: "acme" } }),
		);

		const sent = result.send("hi");
		await flush(2);
		expect(agent.lastRunInput?.forwardedProps).toEqual({ tenantId: "acme" });

		agent.emitAll([runStarted(agent), runFinished(agent)]);
		agent.complete();
		await sent.catch(() => {});
		unmount();
	});

	it("returns the run result from send()", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		const sent = result.send("hi");
		await flush(2);
		agent.emitAll([runStarted(agent), runFinished(agent)]);
		agent.complete();

		const runResult = await sent;
		expect(runResult).not.toBeNull();
		expect(runResult!.newMessages).toBeDefined();
		unmount();
	});

	it("forwards Tool.metadata instead of stripping it", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		result.toolRegistry.set("fn", {
			name: "fn",
			description: "d",
			parameters: { type: "object" },
			handler: async () => "ok",
			metadata: { a2ui: "schema" },
		});

		const sent = result.send("hi");
		await flush(2);
		expect(agent.lastRunInput?.tools[0]).toEqual({
			name: "fn",
			description: "d",
			parameters: { type: "object" },
			metadata: { a2ui: "schema" },
		});

		agent.emitAll([runStarted(agent), runFinished(agent)]);
		agent.complete();
		await sent.catch(() => {});
		unmount();
	});

	it("allows a new send after stop(), even if the old run has not settled", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		const first = result.send("one");
		await flush(2);
		agent.emit(runStarted(agent));
		await flush();

		// AbstractAgent.abortRun() is a no-op unless the subclass overrides it,
		// so the first observable is still open here. A cancelled run must not
		// lock the caller out.
		result.stop();
		await flush();

		const second = result.send("two");
		await flush(2);
		expect(agent.runCount).toBe(2);

		agent.emitAll([runStarted(agent, "r2"), runFinished(agent, "r2")]);
		agent.complete();
		await expect(second).resolves.not.toBeNull();

		// The stale run settling later must not clobber the new run's state.
		expect(result.status.value).toBe("ready");
		expect(result.error.value).toBeNull();
		await first.catch(() => {});
		unmount();
	});
});

describe("useChat tool advertisement", () => {
	it("omits a wildcard tool and any unavailable tool from RunAgentInput", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		result.toolRegistry.set("visible", {
			name: "visible",
			handler: async () => "ok",
		});
		result.toolRegistry.set("hidden", {
			name: "hidden",
			handler: async () => "ok",
			available: false,
		});
		result.toolRegistry.set("*", {
			name: "*",
			handler: async () => "ok",
		});

		const sent = result.send("hi");
		await flush(2);

		// "*" is not a name a model can call, and an unavailable tool is one the
		// agent should not know exists.
		expect(agent.lastRunInput?.tools.map((t) => t.name)).toEqual(["visible"]);
		// An omitted description/parameters still has to satisfy the protocol.
		expect(agent.lastRunInput?.tools[0]).toEqual({
			name: "visible",
			description: "",
			parameters: { type: "object", properties: {} },
		});

		agent.emitAll([runStarted(agent), runFinished(agent)]);
		agent.complete();
		await sent.catch(() => {});
		unmount();
	});
});

describe("useChat frontend tool results", () => {
	it("publishes a locally executed tool result to the transcript", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		result.toolRegistry.set("highlight_row", {
			name: "highlight_row",
			handler: () => "highlighted",
			// Nothing for the model to say about a UI change, so no follow-up run
			// arrives later to publish the result for us.
			followUp: false,
		});

		const sent = result.send("highlight row 3");
		await flush(2);
		agent.emitAll([
			runStarted(agent),
			toolCallStartEvent("tc1", "highlight_row"),
			toolCallArgsEvent("tc1", '{"id":"3"}'),
			toolCallEndEvent("tc1"),
			runFinished(agent),
		]);
		agent.complete();
		await sent;
		await flush();

		// The executor splices the result in to keep it next to its parent
		// assistant message; going through the agent is what announces it.
		expect(
			result.messages.value.some(
				(m) => m.role === "tool" && m.toolCallId === "tc1",
			),
		).toBe(true);

		const toolPart = result.items.value
			.flatMap((i) => i.parts)
			.find((p) => p.type === "tool-call");
		expect(toolPart).toMatchObject({
			toolName: "highlight_row",
			status: "output-available",
			output: "highlighted",
		});
		unmount();
	});
});

describe("useChat stop()", () => {
	it("settles a hanging run by detaching from it", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		const sent = result.send("hi");
		await flush(2);
		agent.emit(runStarted(agent));
		await flush();

		// The observable is never completed. abortRun() is a no-op on
		// AbstractAgent, so detaching is the only thing that can end this run —
		// without it the promise (and the UI) would hang forever.
		result.stop();

		await expect(sent).resolves.toBeNull();
		expect(result.status.value).toBe("ready");
		expect(result.error.value).toBeNull();
		unmount();
	});
});
