import { describe, it, expect } from "vitest";
import { createToolCallTrackerStore } from "../../core/tool-call-tracker";
import type { ToolCallState } from "../../core/types";

describe("tool-call-tracker", () => {
	it("starts a tracker in input-streaming and accumulates arg deltas", () => {
		const store = createToolCallTrackerStore();

		expect(store.trackStart("tc1", "get_weather").get("tc1")).toEqual({
			toolCallId: "tc1",
			toolName: "get_weather",
			args: "",
			state: "input-streaming",
		});

		store.appendArgs("tc1", '{"cit');
		const trackers = store.appendArgs("tc1", 'y":"NYC"}');
		expect(trackers.get("tc1")!.args).toBe('{"city":"NYC"}');
	});

	it("moves to any state without disturbing the args it already has", () => {
		// The store is a plain record, not a state machine: it accepts whichever
		// state its caller reached, so the states are exercised together rather
		// than one test each.
		const states: ToolCallState[] = [
			"input-available",
			"approval-requested",
			"approval-responded",
			"output-denied",
		];
		const store = createToolCallTrackerStore();
		store.trackStart("tc1", "fn");
		store.appendArgs("tc1", "{}");

		for (const state of states) {
			const trackers = store.updateState("tc1", state);
			expect(trackers.get("tc1")).toMatchObject({ state, args: "{}" });
		}
	});

	it("carries the output or the error alongside the terminal state", () => {
		const store = createToolCallTrackerStore();
		store.trackStart("tc1", "fn");
		store.trackStart("tc2", "fn");

		expect(
			store
				.updateState("tc1", "output-available", { output: "data" })
				.get("tc1"),
		).toMatchObject({ state: "output-available", output: "data" });

		expect(
			store.updateState("tc2", "output-error", { error: "boom" }).get("tc2"),
		).toMatchObject({ state: "output-error", error: "boom" });
	});

	it("ignores an update for a tool call it never saw start", () => {
		const store = createToolCallTrackerStore();
		expect(store.updateState("unknown", "input-available").size).toBe(0);
	});

	it("tracks multiple tool calls independently", () => {
		const store = createToolCallTrackerStore();
		store.trackStart("tc1", "fn1");
		store.trackStart("tc2", "fn2");
		store.updateState("tc1", "output-available", { output: "a" });
		const trackers = store.updateState("tc2", "input-available");

		expect(trackers.get("tc1")!.state).toBe("output-available");
		expect(trackers.get("tc2")!.state).toBe("input-available");
	});

	it("publishes a new map on every mutation, so a change is visible by identity", () => {
		// This is the whole reason the store copies instead of mutating: a shallow
		// reactive reference only re-renders when the value's identity changes.
		const store = createToolCallTrackerStore();
		const afterStart = store.trackStart("tc1", "fn");
		const afterArgs = store.appendArgs("tc1", "{}");
		const afterState = store.updateState("tc1", "input-available");

		expect(afterArgs).not.toBe(afterStart);
		expect(afterState).not.toBe(afterArgs);
	});

	it("reset drops every tracker and returns the new map", () => {
		const store = createToolCallTrackerStore();
		store.trackStart("tc1", "fn");
		store.trackStart("tc2", "fn2");

		expect(store.reset().size).toBe(0);
		// The store itself is empty too, not just the returned copy.
		expect(store.getTracker("tc1")).toBeUndefined();
	});
});
