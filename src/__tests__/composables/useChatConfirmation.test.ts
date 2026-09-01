import { describe, it, expect, vi } from "vitest";
import { mountComposable } from "../utils/mount-composable";
import { MockStepwiseAgent } from "../utils/mock-agent";
import {
	runFinishedEvent,
	runStartedEvent,
	toolCallArgsEvent,
	toolCallEndEvent,
	toolCallStartEvent,
} from "../utils/event-factories";
import { useChat } from "../../composables/useChat";
import type { ToolMessage } from "@ag-ui/client";

/**
 * Confirmation-gate behaviour, exercised through `useChat` — the surface a host
 * app actually uses. (These cases previously went through the pass-through
 * `useToolConfirmation` composable, which added no behaviour of its own.)
 */
function setup(handler = vi.fn(async () => "done")) {
	const agent = new MockStepwiseAgent();
	const mounted = mountComposable(() => useChat({ agent }));
	mounted.result.toolRegistry.set("dangerous", {
		name: "dangerous",
		description: "Dangerous op",
		parameters: {},
		handler,
		requireConfirmation: true,
	});
	return { agent, handler, ...mounted };
}

/** Emit a bare run that starts and finishes with no content. */
function emitEmptyRun(agent: MockStepwiseAgent, runId: string) {
	agent.emitAll([
		runStartedEvent({ threadId: agent.threadId, runId }),
		runFinishedEvent({ threadId: agent.threadId, runId }),
	]);
	agent.complete();
}

/** Drive one run that asks for a single `dangerous` tool call. */
function emitToolCallRun(agent: MockStepwiseAgent) {
	agent.emitAll([
		runStartedEvent({ threadId: agent.threadId, runId: "r1" }),
		toolCallStartEvent("tc1", "dangerous"),
		toolCallArgsEvent("tc1", "{}"),
		toolCallEndEvent("tc1"),
		runFinishedEvent({ threadId: agent.threadId, runId: "r1" }),
	]);
	agent.complete();
}

async function flush(times = 6) {
	for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 5));
}

describe("useChat confirmation gates", () => {
	it("has no pending tool calls initially", () => {
		const { result, unmount } = setup();
		expect(result.pendingToolCalls.value).toEqual([]);
		unmount();
	});

	it("surfaces a pending tool call and runs the handler on approve", async () => {
		const { agent, handler, result, unmount } = setup();

		const sent = result.send("do it");
		await flush(2);
		emitToolCallRun(agent);
		await flush();

		expect(result.pendingToolCalls.value).toHaveLength(1);
		expect(result.pendingToolCalls.value[0].toolCallId).toBe("tc1");

		result.approve("tc1");
		await flush();
		expect(handler).toHaveBeenCalled();
		// The call has left the pending list, so no dialog lingers.
		expect(result.pendingToolCalls.value).toEqual([]);

		// An approved tool produces a result, so the executor issues a follow-up
		// run; let it finish so send() can resolve.
		emitEmptyRun(agent, "r2");
		await expect(sent).resolves.not.toBeNull();
		unmount();
	});

	it("skips the handler and records the reason on reject", async () => {
		const { agent, handler, result, unmount } = setup();

		const sent = result.send("do it");
		await flush(2);
		emitToolCallRun(agent);
		await flush();

		result.reject("tc1", "not allowed");
		await flush();

		expect(handler).not.toHaveBeenCalled();
		const toolMsg = agent.messages.find(
			(m) => m.role === "tool",
		) as ToolMessage;
		expect(toolMsg?.content).toBe("not allowed");

		// A denial-only turn does not follow up, so the send settles on its own.
		await sent;
		unmount();
	});

	it("settles open gates when the scope is disposed", async () => {
		const { agent, handler, result, unmount } = setup();

		const sent = result.send("do it");
		await flush(2);
		emitToolCallRun(agent);
		await flush();
		expect(result.pendingToolCalls.value).toHaveLength(1);

		// Unmounting with a dialog still open must not leave executeToolCalls
		// awaiting a promise that can never resolve.
		unmount();
		await flush();

		expect(handler).not.toHaveBeenCalled();
		await expect(
			Promise.race([
				sent.catch(() => "settled"),
				new Promise((r) => setTimeout(() => r("hung"), 200)),
			]),
		).resolves.not.toBe("hung");
	});

	it("ignores approve/reject for an unknown tool call id", () => {
		const { result, unmount } = setup();
		expect(() => result.approve("nope")).not.toThrow();
		expect(() => result.reject("nope", "why")).not.toThrow();
		unmount();
	});
});
