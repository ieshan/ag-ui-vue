import type { AbstractAgent, Context, ToolCall } from "@ag-ui/client";

// ---------------------------------------------------------------------------
// Frontend Tool
// ---------------------------------------------------------------------------

/**
 * Registered under this name, a tool handles any tool call no registered tool
 * matches — including tools the backend defines and executes nowhere else.
 * A wildcard tool is never advertised in `RunAgentInput.tools`, since `"*"` is
 * not a name a model can call.
 */
export const WILDCARD_TOOL_NAME = "*";

export interface FrontendToolHandlerContext {
	/** The call being handled, including its `id` and raw argument JSON. */
	toolCall: ToolCall;
	agent: AbstractAgent;
	/** Aborted when `stop()` is called, so a long handler can bail out. */
	signal?: AbortSignal;
}

/**
 * What should happen after a handler returns.
 *
 * - `"generate"` (the default) — run the agent again with the result.
 * - `false` — do not run again; the result is the end of the turn.
 * - any other string — insert it as a user message, then run again.
 */
// The `"generate"` literal is structurally redundant with `string`, but TS
// keeps it in autocomplete — that's the whole point of the union.
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
export type FrontendToolFollowUp = false | "generate" | string;

export interface FrontendTool {
	/** `"*"` registers a catch-all — see {@link WILDCARD_TOOL_NAME}. */
	name: string;
	/** Optional: a tool the backend already describes needs no description here. */
	description?: string;
	/** JSON Schema. Optional for a no-argument tool. */
	parameters?: Record<string, unknown>;
	/**
	 * Return anything serialisable — a non-string is JSON-encoded for you.
	 * Throwing marks the call failed and suppresses the follow-up run.
	 */
	handler: (
		args: Record<string, unknown>,
		context: FrontendToolHandlerContext,
	) => unknown;
	requireConfirmation?: boolean;
	followUp?: FrontendToolFollowUp;
	/**
	 * When `false` the tool is neither advertised to the agent nor executed.
	 * Defaults to `true`.
	 */
	available?: boolean;
	/** Forwarded as `Tool.metadata` (e.g. an a2ui schema) rather than stripped. */
	metadata?: Record<string, unknown>;
}

export type FrontendToolRegistry = Map<string, FrontendTool>;
export type ContextRegistry = Map<string, Context>;

// ---------------------------------------------------------------------------
// Tool Call Tracking
// ---------------------------------------------------------------------------

export type ToolCallState =
	| "input-streaming"
	| "input-available"
	| "approval-requested"
	| "approval-responded"
	| "output-available"
	| "output-error"
	| "output-denied";

export interface ToolCallTracker {
	toolCallId: string;
	toolName: string;
	args: string;
	state: ToolCallState;
	output?: string;
	error?: string;
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

export interface PendingToolCall {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	state: ToolCallState;
}

export interface ConfirmationGate {
	toolCallId: string;
	resolve: (approved: boolean, reason?: string) => void;
}

// ---------------------------------------------------------------------------
// Steps & subagents
//
// Neither has a message to live on, so unlike the timeline these are the one
// kind of event state the library has to accumulate itself.
// ---------------------------------------------------------------------------

export interface StepRecord {
	name: string;
	status: "running" | "finished";
	subagentRunId?: string;
}

export interface SubagentRecord {
	subagentRunId: string;
	name: string;
	description?: string;
	parentSubagentRunId?: string;
	parentToolCallId?: string;
	parentMessageId?: string;
	status: "running" | "finished" | "suspended" | "error";
	result?: unknown;
	/**
	 * The open interrupts this subagent is waiting on, when it suspended because
	 * it raised one itself. Absent when a descendant interrupted instead.
	 */
	interruptIds?: string[];
	error?: string;
	/** The machine-readable code from SUBAGENT_ERROR, when the agent sent one. */
	errorCode?: string;
}
