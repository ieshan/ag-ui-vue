import type { AbstractAgent, RunAgentResult } from "@ag-ui/client";
import type {
	Message,
	ToolCall,
	ToolMessage,
	Tool,
	Context,
} from "@ag-ui/client";
import {
	WILDCARD_TOOL_NAME,
	type FrontendTool,
	type FrontendToolRegistry,
	type ConfirmationGate,
	type ToolCallTracker,
} from "./types";
import type { ToolCallTrackerStore } from "./tool-call-tracker";

/**
 * Depth cap on tool -> follow-up-run -> tool chains. A model that keeps
 * re-calling the same frontend tool would otherwise recurse until the tab dies.
 */
export const MAX_FOLLOW_UP_DEPTH = 100;

/**
 * Sentinel some backends use for a tool call they have deliberately handed to
 * the client. It looks like a result but is not one, so it must not suppress
 * local execution.
 */
const FORWARDED_TO_CLIENT = "Forwarded to client";

const DEFAULT_DENIAL_MESSAGE = "Tool execution denied by user.";

export interface ToolExecutorOptions {
	agent: AbstractAgent;
	tools: FrontendToolRegistry;
	trackerStore: ToolCallTrackerStore;
	getToolDefinitions: () => Tool[];
	getContexts: () => Context[];
	/** Forwarded on every follow-up run, not just the first one. */
	getForwardedProps: () => Record<string, unknown>;
	/** Generates ids for the synthetic user messages a string `followUp` adds. */
	generateId: () => string;
	onConfirmationRequired: (gate: ConfirmationGate) => void;
	onConfirmationResolved: (toolCallId: string) => void;
	onTrackersChanged: (trackers: Map<string, ToolCallTracker>) => void;
	/**
	 * Yield to the host framework's scheduler so deferred registry updates land
	 * before the follow-up run reads them. Injected by the composable layer
	 * (Vue's `nextTick`) so this module stays framework-free.
	 */
	waitForFrameworkUpdates?: () => Promise<void>;
	signal?: AbortSignal;
}

interface PendingFrontendToolCall {
	toolCall: ToolCall;
	tool: FrontendTool;
	parentMessageId: string;
}

/**
 * Resolve the handler for a tool call: an exactly-named tool first, then a
 * wildcard registration. An unavailable tool resolves to nothing, so the call
 * is left for the backend rather than executed locally.
 */
function resolveFrontendTool(
	tools: FrontendToolRegistry,
	toolName: string,
): FrontendTool | undefined {
	const exact = tools.get(toolName);
	if (exact && exact.available !== false) return exact;

	const wildcard = tools.get(WILDCARD_TOOL_NAME);
	if (wildcard && wildcard.available !== false) return wildcard;

	return undefined;
}

/** A handler may return anything; the protocol carries a string. */
function serializeToolResult(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	return JSON.stringify(value);
}

/**
 * Scan new messages from a runAgent result for tool calls that match registered
 * frontend tools. Execute them (with an optional confirmation gate), insert
 * ToolMessages next to their parent assistant message, and re-run the agent
 * when at least one call produced a usable result.
 */
export async function executeToolCalls(
	result: RunAgentResult,
	options: ToolExecutorOptions,
	depth = 0,
): Promise<void> {
	const { agent, tools, trackerStore, onTrackersChanged } = options;

	const pendingToolCalls = extractFrontendToolCalls(result.newMessages, tools);

	if (pendingToolCalls.length === 0) return;

	let succeeded = 0;
	let failed = 0;
	let inserted = 0;
	// Follow-up is a property of the tools that actually produced a result.
	const followUps: FrontendTool["followUp"][] = [];

	for (const { toolCall, tool, parentMessageId } of pendingToolCalls) {
		if (options.signal?.aborted) return;

		// The backend may already have answered this call itself. Executing the
		// local handler anyway would append a second result for the same id.
		if (hasBackendResult(agent, toolCall.id)) continue;

		let args: Record<string, unknown>;
		try {
			args = JSON.parse(toolCall.function.arguments || "{}") as Record<
				string,
				unknown
			>;
		} catch {
			args = {};
		}

		if (tool.requireConfirmation) {
			onTrackersChanged(
				trackerStore.updateState(toolCall.id, "approval-requested"),
			);

			const { approved, reason } = await waitForConfirmation(
				toolCall.id,
				options,
			);

			if (!approved) {
				onTrackersChanged(
					trackerStore.updateState(toolCall.id, "output-denied", {
						error: reason ?? DEFAULT_DENIAL_MESSAGE,
					}),
				);
				// A denial is a legitimate outcome rather than a failure, so it
				// carries no `error` field — the tracker state records it, and the
				// user's reason (when given) reaches the model as the content.
				if (
					insertToolMessage(agent, parentMessageId, {
						id: `tool-result-${toolCall.id}`,
						role: "tool",
						toolCallId: toolCall.id,
						content: reason ?? DEFAULT_DENIAL_MESSAGE,
					})
				) {
					inserted++;
				}
				continue;
			}

			onTrackersChanged(
				trackerStore.updateState(toolCall.id, "approval-responded"),
			);
		}

		if (options.signal?.aborted) return;

		try {
			const resultContent = serializeToolResult(
				await tool.handler(args, {
					toolCall,
					agent,
					signal: options.signal,
				}),
			);
			onTrackersChanged(
				trackerStore.updateState(toolCall.id, "output-available", {
					output: resultContent,
				}),
			);

			if (
				insertToolMessage(agent, parentMessageId, {
					id: `tool-result-${toolCall.id}`,
					role: "tool",
					toolCallId: toolCall.id,
					content: resultContent,
				})
			) {
				inserted++;
				succeeded++;
				followUps.push(tool.followUp);
			}
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			failed++;
			onTrackersChanged(
				trackerStore.updateState(toolCall.id, "output-error", {
					error: errorMessage,
				}),
			);

			// `error` is the protocol's own field on ToolMessage — consumers read
			// it directly instead of parsing an "Error: ..." prefix out of content.
			if (
				insertToolMessage(agent, parentMessageId, {
					id: `tool-result-${toolCall.id}`,
					role: "tool",
					toolCallId: toolCall.id,
					content: errorMessage,
					error: errorMessage,
				})
			) {
				inserted++;
			}
		}
	}

	// Follow up only when a result actually landed and nothing errored. Feeding
	// a failure straight back into another LLM turn burns tokens and usually
	// loops; a denial-only turn has nothing new for the model to act on.
	if (inserted === 0 || failed > 0 || succeeded === 0) return;

	// Every tool that produced a result opted out of continuing the turn.
	if (followUps.every((followUp) => followUp === false)) return;

	if (options.signal?.aborted) return;

	if (depth + 1 >= MAX_FOLLOW_UP_DEPTH) {
		console.warn(
			`[ag-ui-vue] Reached MAX_FOLLOW_UP_DEPTH (${MAX_FOLLOW_UP_DEPTH}) of tool follow-up runs; stopping to avoid an unbounded loop.`,
		);
		return;
	}

	// A string `followUp` is an instruction for the next turn, delivered the
	// only way the protocol has of speaking to the model outside a run.
	for (const followUp of followUps) {
		if (typeof followUp === "string" && followUp !== "generate") {
			agent.addMessage({
				id: options.generateId(),
				role: "user",
				content: followUp,
			});
		}
	}

	await options.waitForFrameworkUpdates?.();

	if (options.signal?.aborted) return;

	const followUpResult = await agent.runAgent({
		tools: options.getToolDefinitions(),
		context: options.getContexts(),
		forwardedProps: options.getForwardedProps(),
	});

	await executeToolCalls(followUpResult, options, depth + 1);
}

/**
 * True when the run already carries a real `role: "tool"` result for this call.
 * A `FORWARDED_TO_CLIENT` placeholder is explicitly not a result.
 */
function hasBackendResult(agent: AbstractAgent, toolCallId: string): boolean {
	return agent.messages.some(
		(m) =>
			m.role === "tool" &&
			m.toolCallId === toolCallId &&
			m.content.trim() !== FORWARDED_TO_CLIENT,
	);
}

/**
 * Insert a tool result directly after its parent assistant message, past any
 * results already inserted for earlier tool calls in the same batch. Some
 * providers (OpenAI) reject a transcript where a tool result does not
 * immediately follow the assistant turn that requested it.
 *
 * Returns false when the parent is gone — the thread was switched while the
 * handler ran — in which case the result is dropped rather than spliced into
 * an unrelated conversation.
 */
function insertToolMessage(
	agent: AbstractAgent,
	parentMessageId: string,
	toolMessage: ToolMessage,
): boolean {
	const parentIndex = agent.messages.findIndex((m) => m.id === parentMessageId);
	if (parentIndex === -1) return false;

	let insertAt = parentIndex + 1;
	while (
		insertAt < agent.messages.length &&
		agent.messages[insertAt]?.role === "tool"
	) {
		insertAt++;
	}

	const next = [...agent.messages];
	next.splice(insertAt, 0, toolMessage);

	// Going through setMessages rather than mutating the array in place is what
	// makes the insertion visible: AbstractAgent only notifies subscribers from
	// addMessage/addMessages/setMessages, and addMessage appends, which is the
	// order this function exists to avoid. A bare splice() left the result out
	// of every derived view until the next run — permanently, for a tool with
	// `followUp: false`.
	agent.setMessages(next);
	return true;
}

function extractFrontendToolCalls(
	newMessages: Message[],
	tools: FrontendToolRegistry,
): PendingFrontendToolCall[] {
	const results: PendingFrontendToolCall[] = [];

	for (const message of newMessages) {
		if (message.role !== "assistant" || !message.toolCalls) continue;

		for (const toolCall of message.toolCalls) {
			const tool = resolveFrontendTool(tools, toolCall.function.name);
			if (tool) {
				results.push({ toolCall, tool, parentMessageId: message.id });
			}
		}
	}

	return results;
}

function waitForConfirmation(
	toolCallId: string,
	options: ToolExecutorOptions,
): Promise<{ approved: boolean; reason?: string }> {
	return new Promise((resolve) => {
		const gate: ConfirmationGate = {
			toolCallId,
			// Both arguments are forwarded — the reason the user gave for
			// rejecting is part of the outcome, not diagnostic noise.
			resolve: (approved: boolean, reason?: string) => {
				options.onConfirmationResolved(toolCallId);
				resolve({ approved, reason });
			},
		};
		options.onConfirmationRequired(gate);
	});
}
