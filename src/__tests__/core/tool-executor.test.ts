import { describe, it, expect, vi } from "vitest";
import {
	executeToolCalls,
	MAX_FOLLOW_UP_DEPTH,
} from "../../core/tool-executor";
import { createToolCallTrackerStore } from "../../core/tool-call-tracker";
import type { ToolExecutorOptions } from "../../core/tool-executor";
import {
	WILDCARD_TOOL_NAME,
	type FrontendToolRegistry,
	type ConfirmationGate,
} from "../../core/types";
import type { RunAgentResult } from "@ag-ui/client";
import type { Message, AssistantMessage, ToolMessage } from "@ag-ui/client";

/**
 * The slice of `AbstractAgent` the executor touches, with the same semantics:
 * `addMessage` appends, and `setMessages` *replaces* the array — which is how
 * the real agent notifies its subscribers, and therefore how a spliced-in tool
 * result becomes visible to anything derived from `messages`.
 */
function makeMockAgent() {
	const agent = {
		messages: [] as Message[],
		addMessage: vi.fn((message: Message) => {
			agent.messages.push(message);
		}),
		setMessages: vi.fn((next: Message[]) => {
			agent.messages = next;
		}),
		// Annotated to `RunAgentResult` — otherwise the empty `newMessages: []`
		// literal infers as `never[]`, and every test that reassigns `runAgent`
		// with a real `Message[]` payload fails to typecheck against it.
		runAgent: vi.fn(async (): Promise<RunAgentResult> => ({
			result: undefined,
			newMessages: [],
		})),
	};
	return agent;
}

type MockAgent = ReturnType<typeof makeMockAgent>;

/**
 * Build a run result carrying an assistant turn with tool calls, and place that
 * assistant message in `agent.messages` — the client's apply layer has already
 * done so by the time executeToolCalls runs, and tool results are spliced
 * relative to it.
 */
function makeResult(
	agent: MockAgent,
	toolCalls: Array<{ id: string; name: string; args: string }>,
	messageId = "a1",
): RunAgentResult {
	const assistantMsg: AssistantMessage = {
		id: messageId,
		role: "assistant",
		toolCalls: toolCalls.map((tc) => ({
			id: tc.id,
			type: "function" as const,
			function: { name: tc.name, arguments: tc.args },
		})),
	};
	agent.messages.push(assistantMsg);
	return { result: undefined, newMessages: [assistantMsg] };
}

function baseOptions(
	agent: MockAgent,
	tools: FrontendToolRegistry,
	trackerStore: ReturnType<typeof createToolCallTrackerStore>,
	overrides: Partial<ToolExecutorOptions> = {},
): ToolExecutorOptions {
	return {
		agent: agent as any,
		tools,
		trackerStore,
		getToolDefinitions: () => [],
		getContexts: () => [],
		getForwardedProps: () => ({}),
		generateId: (() => {
			let n = 0;
			return () => `gen-${++n}`;
		})(),
		onConfirmationRequired: vi.fn(),
		onConfirmationResolved: vi.fn(),
		onTrackersChanged: vi.fn(),
		...overrides,
	};
}

function toolMessages(agent: MockAgent): ToolMessage[] {
	return agent.messages.filter((m) => m.role === "tool");
}

describe("tool-executor", () => {
	it("executes matching frontend tool", async () => {
		const agent = makeMockAgent();
		const tools: FrontendToolRegistry = new Map();
		tools.set("greet", {
			name: "greet",
			description: "Greet",
			parameters: {},
			handler: vi.fn(async () => "Hello!"),
		});

		const trackerStore = createToolCallTrackerStore();
		trackerStore.trackStart("tc1", "greet");
		trackerStore.updateState("tc1", "input-available");

		const result = makeResult(agent, [
			{ id: "tc1", name: "greet", args: "{}" },
		]);
		await executeToolCalls(result, baseOptions(agent, tools, trackerStore));

		expect(tools.get("greet")!.handler).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				toolCall: expect.objectContaining({ id: "tc1" }),
				agent,
			}),
		);
		const [toolMsg] = toolMessages(agent);
		expect(toolMsg).toBeDefined();
		expect(toolMsg.content).toBe("Hello!");
		expect(toolMsg.toolCallId).toBe("tc1");
	});

	it("skips tool calls not in registry", async () => {
		const agent = makeMockAgent();
		const tools: FrontendToolRegistry = new Map();
		const trackerStore = createToolCallTrackerStore();

		const result = makeResult(agent, [
			{ id: "tc1", name: "unknown", args: "{}" },
		]);
		await executeToolCalls(result, baseOptions(agent, tools, trackerStore));

		expect(toolMessages(agent)).toHaveLength(0);
		expect(agent.runAgent).not.toHaveBeenCalled();
	});

	it("records handler failure on ToolMessage.error, not an 'Error:' content prefix", async () => {
		const agent = makeMockAgent();
		const tools: FrontendToolRegistry = new Map();
		tools.set("fail", {
			name: "fail",
			description: "Fail",
			parameters: {},
			handler: vi.fn(async () => {
				throw new Error("boom");
			}),
		});

		const trackerStore = createToolCallTrackerStore();
		trackerStore.trackStart("tc1", "fail");

		const onTrackersChanged = vi.fn();
		const result = makeResult(agent, [{ id: "tc1", name: "fail", args: "{}" }]);
		await executeToolCalls(
			result,
			baseOptions(agent, tools, trackerStore, { onTrackersChanged }),
		);

		const [toolMsg] = toolMessages(agent);
		expect(toolMsg.error).toBe("boom");
		expect(toolMsg.content).toBe("boom");
		expect(toolMsg.content.startsWith("Error:")).toBe(false);

		const errorCall = onTrackersChanged.mock.calls.find(
			([m]) => m.get("tc1")?.state === "output-error",
		);
		expect(errorCall).toBeDefined();
	});

	it("does not follow up when a handler threw", async () => {
		const agent = makeMockAgent();
		const tools: FrontendToolRegistry = new Map();
		tools.set("fail", {
			name: "fail",
			description: "Fail",
			parameters: {},
			handler: async () => {
				throw new Error("boom");
			},
		});

		const trackerStore = createToolCallTrackerStore();
		const result = makeResult(agent, [{ id: "tc1", name: "fail", args: "{}" }]);
		await executeToolCalls(result, baseOptions(agent, tools, trackerStore));

		expect(agent.runAgent).not.toHaveBeenCalled();
	});

	it("pauses on requireConfirmation and resumes on approve", async () => {
		const agent = makeMockAgent();
		const tools: FrontendToolRegistry = new Map();
		tools.set("dangerous", {
			name: "dangerous",
			description: "Dangerous op",
			parameters: {},
			handler: vi.fn(async () => "done"),
			requireConfirmation: true,
		});

		const trackerStore = createToolCallTrackerStore();
		trackerStore.trackStart("tc1", "dangerous");
		trackerStore.updateState("tc1", "input-available");

		let capturedGate: ConfirmationGate | null = null;

		const result = makeResult(agent, [
			{ id: "tc1", name: "dangerous", args: "{}" },
		]);
		const promise = executeToolCalls(
			result,
			baseOptions(agent, tools, trackerStore, {
				onConfirmationRequired: (gate) => {
					capturedGate = gate;
				},
			}),
		);

		await new Promise((r) => setTimeout(r, 10));
		expect(capturedGate).not.toBeNull();
		expect(capturedGate!.toolCallId).toBe("tc1");

		capturedGate!.resolve(true);
		await promise;

		expect(tools.get("dangerous")!.handler).toHaveBeenCalled();
	});

	it("carries the rejection reason into the tool message", async () => {
		const agent = makeMockAgent();
		const tools: FrontendToolRegistry = new Map();
		const handler = vi.fn(async () => "done");
		tools.set("dangerous", {
			name: "dangerous",
			description: "Dangerous",
			parameters: {},
			handler,
			requireConfirmation: true,
		});

		const trackerStore = createToolCallTrackerStore();
		trackerStore.trackStart("tc1", "dangerous");

		let capturedGate: ConfirmationGate | null = null;
		const onTrackersChanged = vi.fn();

		const result = makeResult(agent, [
			{ id: "tc1", name: "dangerous", args: "{}" },
		]);
		const promise = executeToolCalls(
			result,
			baseOptions(agent, tools, trackerStore, {
				onConfirmationRequired: (gate) => {
					capturedGate = gate;
				},
				onTrackersChanged,
			}),
		);

		await new Promise((r) => setTimeout(r, 10));
		capturedGate!.resolve(false, "That folder is shared with the client.");
		await promise;

		expect(handler).not.toHaveBeenCalled();
		const [toolMsg] = toolMessages(agent);
		expect(toolMsg.content).toBe("That folder is shared with the client.");

		const deniedCall = onTrackersChanged.mock.calls.find(
			([m]) => m.get("tc1")?.state === "output-denied",
		);
		expect(deniedCall).toBeDefined();
	});

	it("falls back to a default message when no rejection reason is given", async () => {
		const agent = makeMockAgent();
		const tools: FrontendToolRegistry = new Map();
		tools.set("dangerous", {
			name: "dangerous",
			description: "Dangerous",
			parameters: {},
			handler: vi.fn(async () => "done"),
			requireConfirmation: true,
		});

		const trackerStore = createToolCallTrackerStore();
		let capturedGate: ConfirmationGate | null = null;

		const result = makeResult(agent, [
			{ id: "tc1", name: "dangerous", args: "{}" },
		]);
		const promise = executeToolCalls(
			result,
			baseOptions(agent, tools, trackerStore, {
				onConfirmationRequired: (gate) => {
					capturedGate = gate;
				},
			}),
		);

		await new Promise((r) => setTimeout(r, 10));
		capturedGate!.resolve(false);
		await promise;

		expect(toolMessages(agent)[0].content).toContain("denied");
	});

	it("does not follow up on a denial-only turn", async () => {
		const agent = makeMockAgent();
		const tools: FrontendToolRegistry = new Map();
		tools.set("dangerous", {
			name: "dangerous",
			description: "Dangerous",
			parameters: {},
			handler: vi.fn(async () => "done"),
			requireConfirmation: true,
		});

		const trackerStore = createToolCallTrackerStore();
		let capturedGate: ConfirmationGate | null = null;

		const result = makeResult(agent, [
			{ id: "tc1", name: "dangerous", args: "{}" },
		]);
		const promise = executeToolCalls(
			result,
			baseOptions(agent, tools, trackerStore, {
				onConfirmationRequired: (gate) => {
					capturedGate = gate;
				},
			}),
		);
		await new Promise((r) => setTimeout(r, 10));
		capturedGate!.resolve(false);
		await promise;

		expect(agent.runAgent).not.toHaveBeenCalled();
	});

	it("calls runAgent after executing tools", async () => {
		const agent = makeMockAgent();
		const tools: FrontendToolRegistry = new Map();
		tools.set("fn", {
			name: "fn",
			description: "fn",
			parameters: {},
			handler: async () => "ok",
		});

		const trackerStore = createToolCallTrackerStore();
		const result = makeResult(agent, [{ id: "tc1", name: "fn", args: "{}" }]);
		await executeToolCalls(result, baseOptions(agent, tools, trackerStore));

		expect(agent.runAgent).toHaveBeenCalledTimes(1);
	});

	it("forwards forwardedProps into the follow-up run", async () => {
		const agent = makeMockAgent();
		const tools: FrontendToolRegistry = new Map();
		tools.set("fn", {
			name: "fn",
			description: "fn",
			parameters: {},
			handler: async () => "ok",
		});

		const trackerStore = createToolCallTrackerStore();
		const forwardedProps = { tenantId: "acme", authToken: "t0ken" };

		const result = makeResult(agent, [{ id: "tc1", name: "fn", args: "{}" }]);
		await executeToolCalls(
			result,
			baseOptions(agent, tools, trackerStore, {
				getForwardedProps: () => forwardedProps,
			}),
		);

		expect(agent.runAgent).toHaveBeenCalledWith(
			expect.objectContaining({ forwardedProps }),
		);
	});

	it("orders results after their parent assistant message and by tool-call order", async () => {
		const agent = makeMockAgent();
		// A message that arrived before the assistant turn, plus one after it —
		// a plain push would put the results at the very end.
		agent.messages.push({ id: "u1", role: "user", content: "hi" });

		const tools: FrontendToolRegistry = new Map();
		tools.set("fn1", {
			name: "fn1",
			description: "",
			parameters: {},
			handler: async () => "result1",
		});
		tools.set("fn2", {
			name: "fn2",
			description: "",
			parameters: {},
			handler: async () => "result2",
		});

		const trackerStore = createToolCallTrackerStore();
		const result = makeResult(agent, [
			{ id: "tc1", name: "fn1", args: "{}" },
			{ id: "tc2", name: "fn2", args: "{}" },
		]);
		agent.messages.push({ id: "z1", role: "assistant", content: "trailing" });

		await executeToolCalls(result, baseOptions(agent, tools, trackerStore));

		expect(agent.messages.map((m) => m.id)).toEqual([
			"u1",
			"a1",
			"tool-result-tc1",
			"tool-result-tc2",
			"z1",
		]);
	});

	it("drops the result when the parent message is gone", async () => {
		const agent = makeMockAgent();
		const tools: FrontendToolRegistry = new Map();
		tools.set("fn", {
			name: "fn",
			description: "",
			parameters: {},
			handler: async () => "ok",
		});

		const trackerStore = createToolCallTrackerStore();
		const result = makeResult(agent, [{ id: "tc1", name: "fn", args: "{}" }]);
		// Simulate a thread switch while the handler was in flight.
		agent.messages.length = 0;

		await executeToolCalls(result, baseOptions(agent, tools, trackerStore));

		expect(toolMessages(agent)).toHaveLength(0);
		expect(agent.runAgent).not.toHaveBeenCalled();
	});

	it("skips a tool the backend already answered", async () => {
		const agent = makeMockAgent();
		const handler = vi.fn(async () => "local");
		const tools: FrontendToolRegistry = new Map();
		tools.set("fn", {
			name: "fn",
			description: "",
			parameters: {},
			handler,
		});

		const trackerStore = createToolCallTrackerStore();
		const result = makeResult(agent, [{ id: "tc1", name: "fn", args: "{}" }]);
		agent.messages.push({
			id: "backend-result",
			role: "tool",
			toolCallId: "tc1",
			content: "from the backend",
		});

		await executeToolCalls(result, baseOptions(agent, tools, trackerStore));

		expect(handler).not.toHaveBeenCalled();
		expect(toolMessages(agent)).toHaveLength(1);
	});

	it("still executes when the only existing result is a forwarded-to-client placeholder", async () => {
		const agent = makeMockAgent();
		const handler = vi.fn(async () => "local");
		const tools: FrontendToolRegistry = new Map();
		tools.set("fn", {
			name: "fn",
			description: "",
			parameters: {},
			handler,
		});

		const trackerStore = createToolCallTrackerStore();
		const result = makeResult(agent, [{ id: "tc1", name: "fn", args: "{}" }]);
		agent.messages.push({
			id: "placeholder",
			role: "tool",
			toolCallId: "tc1",
			content: "Forwarded to client",
		});

		await executeToolCalls(result, baseOptions(agent, tools, trackerStore));

		expect(handler).toHaveBeenCalled();
	});

	it("caps follow-up recursion", async () => {
		const agent = makeMockAgent();
		const tools: FrontendToolRegistry = new Map();
		tools.set("fn", {
			name: "fn",
			description: "",
			parameters: {},
			handler: async () => "ok",
		});

		// Every follow-up run emits the same tool call again, so only the depth
		// cap can end this.
		let counter = 0;
		agent.runAgent = vi.fn(async () => {
			counter++;
			const msg: AssistantMessage = {
				id: `a-${counter}`,
				role: "assistant",
				toolCalls: [
					{
						id: `tc-${counter}`,
						type: "function" as const,
						function: { name: "fn", arguments: "{}" },
					},
				],
			};
			agent.messages.push(msg);
			return { result: undefined, newMessages: [msg] };
		});

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const trackerStore = createToolCallTrackerStore();
		const result = makeResult(agent, [{ id: "tc0", name: "fn", args: "{}" }]);

		await executeToolCalls(result, baseOptions(agent, tools, trackerStore));

		expect(agent.runAgent).toHaveBeenCalledTimes(MAX_FOLLOW_UP_DEPTH - 1);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("MAX_FOLLOW_UP_DEPTH"),
		);
		warn.mockRestore();
	});

	it("stops before the follow-up run when aborted", async () => {
		const agent = makeMockAgent();
		const controller = new AbortController();
		const tools: FrontendToolRegistry = new Map();
		tools.set("fn", {
			name: "fn",
			description: "",
			parameters: {},
			handler: async () => {
				controller.abort();
				return "ok";
			},
		});

		const trackerStore = createToolCallTrackerStore();
		const result = makeResult(agent, [{ id: "tc1", name: "fn", args: "{}" }]);

		await executeToolCalls(
			result,
			baseOptions(agent, tools, trackerStore, { signal: controller.signal }),
		);

		expect(agent.runAgent).not.toHaveBeenCalled();
	});

	it("yields to the host framework before following up", async () => {
		const agent = makeMockAgent();
		const tools: FrontendToolRegistry = new Map();
		tools.set("fn", {
			name: "fn",
			description: "",
			parameters: {},
			handler: async () => "ok",
		});

		const waitForFrameworkUpdates = vi.fn(async () => {});
		const trackerStore = createToolCallTrackerStore();
		const result = makeResult(agent, [{ id: "tc1", name: "fn", args: "{}" }]);

		await executeToolCalls(
			result,
			baseOptions(agent, tools, trackerStore, { waitForFrameworkUpdates }),
		);

		expect(waitForFrameworkUpdates).toHaveBeenCalled();
	});

	it("handles multiple tool calls in one message", async () => {
		const agent = makeMockAgent();
		const tools: FrontendToolRegistry = new Map();
		const handler1 = vi.fn(async () => "result1");
		const handler2 = vi.fn(async () => "result2");
		tools.set("fn1", {
			name: "fn1",
			description: "",
			parameters: {},
			handler: handler1,
		});
		tools.set("fn2", {
			name: "fn2",
			description: "",
			parameters: {},
			handler: handler2,
		});

		const trackerStore = createToolCallTrackerStore();
		const result = makeResult(agent, [
			{ id: "tc1", name: "fn1", args: "{}" },
			{ id: "tc2", name: "fn2", args: "{}" },
		]);
		await executeToolCalls(result, baseOptions(agent, tools, trackerStore));

		expect(handler1).toHaveBeenCalled();
		expect(handler2).toHaveBeenCalled();
		expect(toolMessages(agent)).toHaveLength(2);
	});
});

describe("tool-executor tool resolution", () => {
	it("routes an unmatched call to a wildcard tool", async () => {
		const agent = makeMockAgent();
		const tools: FrontendToolRegistry = new Map();
		let seenName: string | undefined;
		const handler = vi.fn((_args, ctx) => {
			seenName = ctx.toolCall.function.name;
			return "handled";
		});
		tools.set(WILDCARD_TOOL_NAME, { name: WILDCARD_TOOL_NAME, handler });

		const trackerStore = createToolCallTrackerStore();
		const result = makeResult(agent, [
			{ id: "tc1", name: "something_the_backend_named", args: "{}" },
		]);
		await executeToolCalls(result, baseOptions(agent, tools, trackerStore));

		expect(handler).toHaveBeenCalledTimes(1);
		// The wildcard is told which tool was actually called.
		expect(seenName).toBe("something_the_backend_named");
		expect(toolMessages(agent)[0].content).toBe("handled");
	});

	it("prefers an exactly-named tool over the wildcard", async () => {
		const agent = makeMockAgent();
		const tools: FrontendToolRegistry = new Map();
		const exact = vi.fn(async () => "exact");
		const wildcard = vi.fn(async () => "wildcard");
		tools.set("greet", { name: "greet", handler: exact });
		tools.set(WILDCARD_TOOL_NAME, {
			name: WILDCARD_TOOL_NAME,
			handler: wildcard,
		});

		const trackerStore = createToolCallTrackerStore();
		await executeToolCalls(
			makeResult(agent, [{ id: "tc1", name: "greet", args: "{}" }]),
			baseOptions(agent, tools, trackerStore),
		);

		expect(exact).toHaveBeenCalledTimes(1);
		expect(wildcard).not.toHaveBeenCalled();
	});

	it("does not execute a tool marked unavailable", async () => {
		const agent = makeMockAgent();
		const tools: FrontendToolRegistry = new Map();
		const handler = vi.fn(async () => "should not run");
		tools.set("greet", { name: "greet", handler, available: false });

		const trackerStore = createToolCallTrackerStore();
		await executeToolCalls(
			makeResult(agent, [{ id: "tc1", name: "greet", args: "{}" }]),
			baseOptions(agent, tools, trackerStore),
		);

		// The call is left for the backend rather than answered locally.
		expect(handler).not.toHaveBeenCalled();
		expect(toolMessages(agent)).toHaveLength(0);
		expect(agent.runAgent).not.toHaveBeenCalled();
	});

	it("falls back to the wildcard when the named tool is unavailable", async () => {
		const agent = makeMockAgent();
		const tools: FrontendToolRegistry = new Map();
		const wildcard = vi.fn(async () => "wildcard");
		tools.set("greet", {
			name: "greet",
			handler: vi.fn(),
			available: false,
		});
		tools.set(WILDCARD_TOOL_NAME, {
			name: WILDCARD_TOOL_NAME,
			handler: wildcard,
		});

		const trackerStore = createToolCallTrackerStore();
		await executeToolCalls(
			makeResult(agent, [{ id: "tc1", name: "greet", args: "{}" }]),
			baseOptions(agent, tools, trackerStore),
		);

		expect(wildcard).toHaveBeenCalledTimes(1);
	});
});

describe("tool-executor handler results", () => {
	it("JSON-encodes a non-string return value", async () => {
		const agent = makeMockAgent();
		const tools: FrontendToolRegistry = new Map();
		tools.set("lookup", {
			name: "lookup",
			handler: async () => ({ city: "Toronto", temp: 22 }),
		});

		const trackerStore = createToolCallTrackerStore();
		trackerStore.trackStart("tc1", "lookup");
		await executeToolCalls(
			makeResult(agent, [{ id: "tc1", name: "lookup", args: "{}" }]),
			baseOptions(agent, tools, trackerStore),
		);

		expect(toolMessages(agent)[0].content).toBe(
			JSON.stringify({ city: "Toronto", temp: 22 }),
		);
		expect(trackerStore.getTracker("tc1")!.output).toBe(
			JSON.stringify({ city: "Toronto", temp: 22 }),
		);
	});

	it("accepts a synchronous handler and an empty return", async () => {
		const agent = makeMockAgent();
		const tools: FrontendToolRegistry = new Map();
		tools.set("noop", {
			name: "noop",
			handler: () => undefined,
		});

		const trackerStore = createToolCallTrackerStore();
		await executeToolCalls(
			makeResult(agent, [{ id: "tc1", name: "noop", args: "{}" }]),
			baseOptions(agent, tools, trackerStore),
		);

		expect(toolMessages(agent)[0].content).toBe("");
	});

	it("passes the abort signal through to the handler", async () => {
		const agent = makeMockAgent();
		const controller = new AbortController();
		const tools: FrontendToolRegistry = new Map();
		let seenSignal: AbortSignal | undefined;
		tools.set("slow", {
			name: "slow",
			handler: (_args, ctx) => {
				seenSignal = ctx.signal;
				return "done";
			},
		});

		const trackerStore = createToolCallTrackerStore();
		await executeToolCalls(
			makeResult(agent, [{ id: "tc1", name: "slow", args: "{}" }]),
			baseOptions(agent, tools, trackerStore, { signal: controller.signal }),
		);

		expect(seenSignal).toBe(controller.signal);
	});
});

describe("tool-executor followUp", () => {
	it("does not re-run the agent when followUp is false", async () => {
		const agent = makeMockAgent();
		const tools: FrontendToolRegistry = new Map();
		tools.set("record", {
			name: "record",
			handler: async () => "saved",
			followUp: false,
		});

		const trackerStore = createToolCallTrackerStore();
		await executeToolCalls(
			makeResult(agent, [{ id: "tc1", name: "record", args: "{}" }]),
			baseOptions(agent, tools, trackerStore),
		);

		expect(toolMessages(agent)).toHaveLength(1);
		expect(agent.runAgent).not.toHaveBeenCalled();
	});

	it("re-runs when any successful tool still wants a follow-up", async () => {
		const agent = makeMockAgent();
		const tools: FrontendToolRegistry = new Map();
		tools.set("quiet", {
			name: "quiet",
			handler: async () => "saved",
			followUp: false,
		});
		tools.set("chatty", { name: "chatty", handler: async () => "and?" });

		const trackerStore = createToolCallTrackerStore();
		await executeToolCalls(
			makeResult(agent, [
				{ id: "tc1", name: "quiet", args: "{}" },
				{ id: "tc2", name: "chatty", args: "{}" },
			]),
			baseOptions(agent, tools, trackerStore),
		);

		expect(agent.runAgent).toHaveBeenCalledTimes(1);
	});

	it("inserts a string followUp as a user message before re-running", async () => {
		const agent = makeMockAgent();
		const tools: FrontendToolRegistry = new Map();
		tools.set("fetch_doc", {
			name: "fetch_doc",
			handler: async () => "the document text",
			followUp: "Summarise the document in one sentence.",
		});

		const trackerStore = createToolCallTrackerStore();
		await executeToolCalls(
			makeResult(agent, [{ id: "tc1", name: "fetch_doc", args: "{}" }]),
			baseOptions(agent, tools, trackerStore),
		);

		const userMessages = agent.messages.filter((m) => m.role === "user");
		expect(userMessages).toHaveLength(1);
		expect(userMessages[0].content).toBe(
			"Summarise the document in one sentence.",
		);
		expect(agent.runAgent).toHaveBeenCalledTimes(1);
		// Ordering matters: the instruction must precede the run that reads it.
		const runOrder = agent.messages.map((m) => m.role);
		expect(runOrder[runOrder.length - 1]).toBe("user");
	});

	it('treats followUp "generate" as the default re-run', async () => {
		const agent = makeMockAgent();
		const tools: FrontendToolRegistry = new Map();
		tools.set("go", {
			name: "go",
			handler: async () => "ok",
			followUp: "generate",
		});

		const trackerStore = createToolCallTrackerStore();
		await executeToolCalls(
			makeResult(agent, [{ id: "tc1", name: "go", args: "{}" }]),
			baseOptions(agent, tools, trackerStore),
		);

		// No synthetic user message, but the run happens.
		expect(agent.messages.some((m) => m.role === "user")).toBe(false);
		expect(agent.runAgent).toHaveBeenCalledTimes(1);
	});
});
