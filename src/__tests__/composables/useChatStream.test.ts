import { describe, it, expect, vi } from "vitest";
import { mountComposable } from "../utils/mount-composable";
import { MockStepwiseAgent } from "../utils/mock-agent";
import {
	activityDeltaEvent,
	activitySnapshotEvent,
	customEvent,
	messagesSnapshotEvent,
	rawEvent,
	reasoningEvents,
	runFinishedEvent,
	runStartedEvent,
	stateDeltaEvent,
	stateSnapshotEvent,
	stepFinishedEvent,
	stepStartedEvent,
	textMessageEvents,
	toolCallEvents,
	toolCallResultEvent,
} from "../utils/event-factories";
import { useChat } from "../../composables/useChat";
import type { ChatPart } from "../../core/view-model";

async function flush(times = 4) {
	for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 5));
}

function partsOfType<T extends ChatPart["type"]>(
	items: { parts: ChatPart[] }[],
	type: T,
): Extract<ChatPart, { type: T }>[] {
	return items
		.flatMap((i) => i.parts)
		.filter((p): p is Extract<ChatPart, { type: T }> => p.type === type);
}

/**
 * Streams a realistic run through the real subscriber chain and asserts on the
 * `items` timeline — the surface a host app renders.
 */
describe("useChat streaming into the items timeline", () => {
	it("projects text, reasoning, tool calls and activity in order", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		const sent = result.send("what is the weather?");
		await flush(2);

		agent.emitAll([
			runStartedEvent({ threadId: agent.threadId, runId: "r1" }),
			stepStartedEvent("plan"),
			...reasoningEvents("Checking the forecast", "reason-1"),
			...textMessageEvents("Let me look that up.", "msg-1"),
			activitySnapshotEvent("act-1", "progress", { step: 1, total: 2 }),
			...toolCallEvents("get_weather", { city: "NYC" }, "tc1", "msg-2"),
			toolCallResultEvent("tc1", '{"temp":72}', "msg-3"),
			stepFinishedEvent("plan"),
			runFinishedEvent({ threadId: agent.threadId, runId: "r1" }),
		]);
		agent.complete();
		await sent;
		await flush();

		const items = result.items.value;

		// A user turn plus everything the run produced.
		expect(items[0].role).toBe("user");
		expect(items.map((i) => i.role)).toContain("reasoning");
		expect(items.map((i) => i.role)).toContain("activity");

		expect(partsOfType(items, "text").map((p) => p.text)).toContain(
			"Let me look that up.",
		);
		expect(partsOfType(items, "reasoning")[0].text).toBe(
			"Checking the forecast",
		);

		const activity = partsOfType(items, "activity")[0];
		expect(activity.activityType).toBe("progress");
		expect(activity.value).toEqual({ step: 1, total: 2 });

		// A backend-executed tool call carries its result, merged into the part.
		const toolCall = partsOfType(items, "tool-call")[0];
		expect(toolCall.toolName).toBe("get_weather");
		expect(toolCall.args).toEqual({ city: "NYC" });
		expect(toolCall.status).toBe("output-available");
		expect(toolCall.output).toBe('{"temp":72}');

		// No orphan tool item in the timeline.
		expect(items.some((i) => i.role === "tool")).toBe(false);

		expect(result.status.value).toBe("ready");
		expect(result.isReasoning.value).toBe(false);
		unmount();
	});

	it("advances a backend-executed tool call past input-available", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		const sent = result.send("go");
		await flush(2);

		agent.emitAll([
			runStartedEvent({ threadId: agent.threadId, runId: "r1" }),
			...toolCallEvents("server_side", {}, "tc1", "msg-1"),
		]);
		await flush();
		// Before the result arrives the tracker sits at input-available.
		expect(result.toolCallTrackers.value.get("tc1")?.state).toBe(
			"input-available",
		);

		agent.emitAll([
			toolCallResultEvent("tc1", "done", "msg-2"),
			runFinishedEvent({ threadId: agent.threadId, runId: "r1" }),
		]);
		agent.complete();
		await sent;
		await flush();

		// Previously it stayed at input-available forever.
		expect(result.toolCallTrackers.value.get("tc1")?.state).toBe(
			"output-available",
		);
		expect(result.toolCallTrackers.value.get("tc1")?.output).toBe("done");
		unmount();
	});

	it("tracks shared state through snapshot and delta events", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		const sent = result.send("go");
		await flush(2);

		agent.emitAll([
			runStartedEvent({ threadId: agent.threadId, runId: "r1" }),
			stateSnapshotEvent({ counter: 1 }),
		]);
		await flush();
		expect(result.state.value).toEqual({ counter: 1 });

		agent.emitAll([
			stateDeltaEvent([{ op: "replace", path: "/counter", value: 5 }]),
			runFinishedEvent({ threadId: agent.threadId, runId: "r1" }),
		]);
		agent.complete();
		await sent;
		await flush();

		expect(result.state.value).toEqual({ counter: 5 });
		unmount();
	});

	it("applies an activity delta on top of its snapshot", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		const sent = result.send("go");
		await flush(2);

		agent.emitAll([
			runStartedEvent({ threadId: agent.threadId, runId: "r1" }),
			activitySnapshotEvent("act-1", "progress", { done: 0 }),
			activityDeltaEvent("act-1", "progress", [
				{ op: "replace", path: "/done", value: 1 },
			]),
			runFinishedEvent({ threadId: agent.threadId, runId: "r1" }),
		]);
		agent.complete();
		await sent;
		await flush();

		const activity = partsOfType(result.items.value, "activity")[0];
		expect(activity.value).toEqual({ done: 1 });
		unmount();
	});

	it("replaces the transcript on a messages snapshot", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		const sent = result.send("go");
		await flush(2);

		agent.emitAll([
			runStartedEvent({ threadId: agent.threadId, runId: "r1" }),
			messagesSnapshotEvent([
				{ id: "s1", role: "user", content: "replaced" },
				{ id: "s2", role: "assistant", content: "from the server" },
			]),
			runFinishedEvent({ threadId: agent.threadId, runId: "r1" }),
		]);
		agent.complete();
		await sent;
		await flush();

		expect(result.messages.value.map((m) => m.id)).toEqual(["s1", "s2"]);
		expect(result.items.value.map((i) => i.role)).toEqual([
			"user",
			"assistant",
		]);
		unmount();
	});

	it("forwards custom and raw events to the callbacks", async () => {
		const agent = new MockStepwiseAgent();
		const onCustomEvent = vi.fn();
		const onRawEvent = vi.fn();
		const { result, unmount } = mountComposable(() =>
			useChat({ agent, onCustomEvent, onRawEvent }),
		);

		const sent = result.send("go");
		await flush(2);
		agent.emitAll([
			runStartedEvent({ threadId: agent.threadId, runId: "r1" }),
			customEvent("my_event", { a: 1 }),
			rawEvent({ anything: true }),
			runFinishedEvent({ threadId: agent.threadId, runId: "r1" }),
		]);
		agent.complete();
		await sent;
		await flush();

		expect(onCustomEvent).toHaveBeenCalled();
		expect(onRawEvent).toHaveBeenCalled();
		unmount();
	});
});
