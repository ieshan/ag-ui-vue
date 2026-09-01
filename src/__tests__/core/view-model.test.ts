import { describe, it, expect } from "vitest";
import { toChatItems, type ChatPart } from "../../core/view-model";
import type { Message } from "@ag-ui/client";
import type { ToolCallState, ToolCallTracker } from "../../core/types";

function tracker(
	toolCallId: string,
	state: ToolCallState,
	extra: Partial<ToolCallTracker> = {},
): Map<string, ToolCallTracker> {
	return new Map([
		[
			toolCallId,
			{
				toolCallId,
				toolName: extra.toolName ?? "fn",
				args: extra.args ?? "{}",
				state,
				...extra,
			},
		],
	]);
}

function assistantWithToolCall(
	name = "get_weather",
	args = "{}",
	id = "tc1",
): Message {
	return {
		id: "a1",
		role: "assistant",
		toolCalls: [
			{ id, type: "function" as const, function: { name, arguments: args } },
		],
	};
}

function toolCallParts(parts: ChatPart[]) {
	return parts.filter(
		(p): p is Extract<ChatPart, { type: "tool-call" }> =>
			p.type === "tool-call",
	);
}

describe("toChatItems", () => {
	it("handles an empty array", () => {
		expect(toChatItems([])).toEqual([]);
	});

	it("is pure — it does not mutate its inputs", () => {
		const messages: Message[] = [
			{ id: "u1", role: "user", content: "hello" },
			assistantWithToolCall(),
			{ id: "t1", role: "tool", toolCallId: "tc1", content: "ok" },
		];
		const snapshot = JSON.parse(JSON.stringify(messages));
		const trackers = tracker("tc1", "output-available", { output: "ok" });
		const trackerSnapshot = JSON.parse(
			JSON.stringify(Array.from(trackers.entries())),
		);

		const first = toChatItems(messages, trackers);
		const second = toChatItems(messages, trackers);

		expect(messages).toEqual(snapshot);
		expect(Array.from(trackers.entries())).toEqual(trackerSnapshot);
		expect(first).toEqual(second);
	});

	it("maps a user message to a text part", () => {
		const items = toChatItems([{ id: "u1", role: "user", content: "hello" }]);
		expect(items).toHaveLength(1);
		expect(items[0].role).toBe("user");
		expect(items[0].parts).toEqual([{ type: "text", text: "hello" }]);
	});

	it("maps an assistant message with text", () => {
		const items = toChatItems([
			{ id: "a1", role: "assistant", content: "Hi there!" },
		]);
		expect(items[0].role).toBe("assistant");
		expect(items[0].parts).toEqual([{ type: "text", text: "Hi there!" }]);
	});

	it("maps an assistant message with tool calls", () => {
		const items = toChatItems([
			assistantWithToolCall("get_weather", '{"city":"NYC"}'),
		]);
		const [part] = toolCallParts(items[0].parts);
		expect(part.toolName).toBe("get_weather");
		expect(part.args).toEqual({ city: "NYC" });
		expect(part.argsRaw).toBe('{"city":"NYC"}');
	});

	it("merges a tool result into its parent tool-call part", () => {
		const items = toChatItems([
			assistantWithToolCall(),
			{ id: "t1", role: "tool", toolCallId: "tc1", content: '{"temp": 72}' },
		]);

		// The tool message is not a separate item — consumers never see an orphan.
		expect(items).toHaveLength(1);
		const [part] = toolCallParts(items[0].parts);
		expect(part.output).toBe('{"temp": 72}');
		expect(part.status).toBe("output-available");
	});

	it("reads failure from ToolMessage.error rather than an 'Error:' prefix", () => {
		const items = toChatItems([
			assistantWithToolCall(),
			{
				id: "t1",
				role: "tool",
				toolCallId: "tc1",
				content: "boom",
				error: "boom",
			},
		]);

		const [part] = toolCallParts(items[0].parts);
		expect(part.error).toBe("boom");
		expect(part.status).toBe("output-error");
	});

	it("keeps a denial's tracker state and reason", () => {
		const items = toChatItems(
			[
				assistantWithToolCall(),
				{ id: "t1", role: "tool", toolCallId: "tc1", content: "not allowed" },
			],
			tracker("tc1", "output-denied", { error: "not allowed" }),
		);

		const [part] = toolCallParts(items[0].parts);
		expect(part.status).toBe("output-denied");
		expect(part.error).toBe("not allowed");
	});

	it("maps a reasoning message to a reasoning part", () => {
		const items = toChatItems([
			{ id: "r1", role: "reasoning", content: "Thinking about it..." },
		]);
		expect(items[0].role).toBe("reasoning");
		expect(items[0].parts).toEqual([
			{
				type: "reasoning",
				id: "r1",
				text: "Thinking about it...",
				encryptedValue: undefined,
				streaming: false,
			},
		]);
	});

	it("carries encryptedValue and subagentRunId on reasoning", () => {
		const items = toChatItems([
			{
				id: "r1",
				role: "reasoning",
				content: "",
				encryptedValue: "opaque",
				subagentRunId: "sub-1",
			},
		]);
		const part = items[0].parts[0] as Extract<ChatPart, { type: "reasoning" }>;
		expect(part.encryptedValue).toBe("opaque");
		expect(items[0].subagentRunId).toBe("sub-1");
	});

	it("maps an activity message to a structured activity part", () => {
		const items = toChatItems([
			{
				id: "act1",
				role: "activity",
				activityType: "progress",
				content: { step: 1, total: 3 },
				subagentRunId: "sub-1",
			},
		]);

		expect(items[0].role).toBe("activity");
		// activityType and structure survive — no JSON.stringify, no role: "data".
		expect(items[0].parts).toEqual([
			{
				type: "activity",
				activityType: "progress",
				value: { step: 1, total: 3 },
			},
		]);
		expect(items[0].subagentRunId).toBe("sub-1");
	});

	it("maps multimodal user content to file parts", () => {
		const items = toChatItems([
			{
				id: "u1",
				role: "user",
				content: [
					{ type: "text", text: "what is this?" },
					{
						type: "image",
						// The protocol carries the MIME type on the source, not the part.
						source: {
							type: "url",
							value: "https://example.com/a.png",
							mimeType: "image/png",
						},
					},
				],
			},
		]);

		expect(items[0].parts).toEqual([
			{ type: "text", text: "what is this?" },
			{
				type: "file",
				kind: "image",
				mimeType: "image/png",
				source: {
					type: "url",
					value: "https://example.com/a.png",
					mimeType: "image/png",
				},
			},
		]);
	});

	it("keeps developer and system messages in the timeline", () => {
		const items = toChatItems([
			{ id: "d1", role: "developer", content: "dev note" },
			{ id: "s1", role: "system", content: "you are helpful" },
		]);
		expect(items.map((i) => i.role)).toEqual(["developer", "system"]);
		expect(items[1].parts).toEqual([{ type: "text", text: "you are helpful" }]);
	});

	it("carries subagentRunId on every role that can report one", () => {
		// It lives on the base message schema, so an assistant turn produced
		// inside a subagent has it too — without which grouping the timeline by
		// subagent would silently drop the subagent's own answer.
		const items = toChatItems([
			{ id: "u1", role: "user", content: "hi", subagentRunId: "sub-1" },
			{ id: "a1", role: "assistant", content: "hello", subagentRunId: "sub-1" },
			{ id: "s1", role: "system", content: "rules", subagentRunId: "sub-1" },
		]);

		expect(items.map((i) => i.subagentRunId)).toEqual([
			"sub-1",
			"sub-1",
			"sub-1",
		]);
	});

	it("preserves message metadata", () => {
		const items = toChatItems([
			{
				id: "a1",
				role: "assistant",
				content: "hi",
				metadata: { usage: { totalTokens: 12 } },
			},
		]);
		expect(items[0].metadata).toEqual({ usage: { totalTokens: 12 } });
	});

	it("handles a mixed message sequence in order", () => {
		const items = toChatItems([
			{ id: "u1", role: "user", content: "hi" },
			{ id: "a1", role: "assistant", content: "hello" },
			{ id: "r1", role: "reasoning", content: "thinking" },
		]);
		expect(items.map((i) => i.role)).toEqual([
			"user",
			"assistant",
			"reasoning",
		]);
	});

	describe("tool-call status", () => {
		it("surfaces whatever state the tracker is in", () => {
			// Every state is passed straight through, including the three the
			// protocol has no message for (approval-requested/-responded,
			// output-denied) — which is why the tracker exists at all.
			const states: ToolCallState[] = [
				"input-streaming",
				"input-available",
				"approval-requested",
				"approval-responded",
				"output-available",
				"output-error",
				"output-denied",
			];

			for (const state of states) {
				const items = toChatItems(
					[assistantWithToolCall()],
					tracker("tc1", state),
				);
				expect(toolCallParts(items[0].parts)[0].status).toBe(state);
			}
		});

		it("exposes the tracker output and error", () => {
			const items = toChatItems(
				[assistantWithToolCall()],
				tracker("tc1", "output-available", { output: "done" }),
			);
			expect(toolCallParts(items[0].parts)[0].output).toBe("done");
		});

		it("defaults to input-available when there is no tracker", () => {
			const items = toChatItems([assistantWithToolCall("fn", '{"x":1}')]);
			const [part] = toolCallParts(items[0].parts);
			expect(part.status).toBe("input-available");
			expect(part.args).toEqual({ x: 1 });
		});

		it("prefers the tracker's streamed args over the message snapshot", () => {
			const items = toChatItems(
				[assistantWithToolCall("fn", "{}")],
				tracker("tc1", "input-streaming", { args: '{"partial' }),
			);
			const [part] = toolCallParts(items[0].parts);
			expect(part.argsRaw).toBe('{"partial');
			// Partial JSON is normal mid-stream and must not throw.
			expect(part.args).toEqual({});
		});

		it("handles multiple tool calls with different states", () => {
			const trackers = new Map<string, ToolCallTracker>([
				...tracker("tc1", "input-streaming", { toolName: "fn1" }),
				...tracker("tc2", "output-available", {
					toolName: "fn2",
					output: "ok",
				}),
			]);
			const items = toChatItems(
				[
					{
						id: "a1",
						role: "assistant",
						toolCalls: [
							{
								id: "tc1",
								type: "function" as const,
								function: { name: "fn1", arguments: "{}" },
							},
							{
								id: "tc2",
								type: "function" as const,
								function: { name: "fn2", arguments: "{}" },
							},
						],
					},
				],
				trackers,
			);

			const parts = toolCallParts(items[0].parts);
			expect(parts).toHaveLength(2);
			expect(parts[0].status).toBe("input-streaming");
			expect(parts[1].status).toBe("output-available");
		});
	});
});
