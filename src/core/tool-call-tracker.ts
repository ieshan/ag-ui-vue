import type { ToolCallState, ToolCallTracker } from "./types";

/**
 * Tracks the lifecycle of each streamed tool call.
 *
 * Every mutation returns a brand-new Map rather than editing in place, so a
 * consumer holding the previous one can detect the change by identity alone —
 * which is what a shallow reactive reference needs.
 */
export function createToolCallTrackerStore() {
	let trackers = new Map<string, ToolCallTracker>();

	function trackStart(
		toolCallId: string,
		toolName: string,
	): Map<string, ToolCallTracker> {
		trackers = new Map(trackers);
		trackers.set(toolCallId, {
			toolCallId,
			toolName,
			args: "",
			state: "input-streaming",
		});
		return trackers;
	}

	function appendArgs(
		toolCallId: string,
		delta: string,
	): Map<string, ToolCallTracker> {
		const entry = trackers.get(toolCallId);
		if (!entry) return trackers;

		trackers = new Map(trackers);
		trackers.set(toolCallId, { ...entry, args: entry.args + delta });
		return trackers;
	}

	function updateState(
		toolCallId: string,
		state: ToolCallState,
		extra?: { output?: string; error?: string },
	): Map<string, ToolCallTracker> {
		const entry = trackers.get(toolCallId);
		if (!entry) return trackers;

		trackers = new Map(trackers);
		trackers.set(toolCallId, { ...entry, state, ...extra });
		return trackers;
	}

	/** Drop every tracker — the transcript they described is gone. */
	function reset(): Map<string, ToolCallTracker> {
		trackers = new Map();
		return trackers;
	}

	function getTracker(toolCallId: string): ToolCallTracker | undefined {
		return trackers.get(toolCallId);
	}

	return { trackStart, appendArgs, updateState, reset, getTracker };
}

export type ToolCallTrackerStore = ReturnType<
	typeof createToolCallTrackerStore
>;
