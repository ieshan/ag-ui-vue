import { EventType } from "@ag-ui/client";
import type { BaseEvent, Interrupt, Message } from "@ag-ui/client";

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

export function runStartedEvent(overrides?: Partial<BaseEvent>): BaseEvent {
	return {
		type: EventType.RUN_STARTED,
		runId: crypto.randomUUID(),
		threadId: crypto.randomUUID(),
		...overrides,
	};
}

export function runFinishedEvent(overrides?: Partial<BaseEvent>): BaseEvent {
	return {
		type: EventType.RUN_FINISHED,
		runId: crypto.randomUUID(),
		threadId: crypto.randomUUID(),
		...overrides,
	};
}

export function runErrorEvent(
	message: string,
	overrides?: Partial<BaseEvent>,
): BaseEvent {
	return {
		type: EventType.RUN_ERROR,
		message,
		code: "AGENT_ERROR",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Text message flow
// ---------------------------------------------------------------------------

export function textMessageStartEvent(
	messageId?: string,
	overrides?: Record<string, unknown>,
): BaseEvent {
	return {
		type: EventType.TEXT_MESSAGE_START,
		messageId: messageId ?? crypto.randomUUID(),
		role: "assistant",
		...overrides,
	};
}

export function textMessageContentEvent(
	messageId: string,
	delta: string,
): BaseEvent {
	return {
		type: EventType.TEXT_MESSAGE_CONTENT,
		messageId,
		delta,
	};
}

export function textMessageEndEvent(messageId: string): BaseEvent {
	return {
		type: EventType.TEXT_MESSAGE_END,
		messageId,
	};
}

/** Emit a complete text message sequence. */
export function textMessageEvents(
	content: string,
	messageId?: string,
): BaseEvent[] {
	const id = messageId ?? crypto.randomUUID();
	return [
		textMessageStartEvent(id),
		textMessageContentEvent(id, content),
		textMessageEndEvent(id),
	];
}

// ---------------------------------------------------------------------------
// Tool call flow
// ---------------------------------------------------------------------------

export function toolCallStartEvent(
	toolCallId: string,
	toolCallName: string,
	parentMessageId?: string,
): BaseEvent {
	return {
		type: EventType.TOOL_CALL_START,
		toolCallId,
		toolCallName,
		parentMessageId: parentMessageId ?? crypto.randomUUID(),
	};
}

export function toolCallArgsEvent(
	toolCallId: string,
	delta: string,
): BaseEvent {
	return {
		type: EventType.TOOL_CALL_ARGS,
		toolCallId,
		delta,
	};
}

export function toolCallEndEvent(toolCallId: string): BaseEvent {
	return {
		type: EventType.TOOL_CALL_END,
		toolCallId,
	};
}

export function toolCallResultEvent(
	toolCallId: string,
	content: string,
	messageId?: string,
): BaseEvent {
	return {
		type: EventType.TOOL_CALL_RESULT,
		toolCallId,
		content,
		messageId: messageId ?? crypto.randomUUID(),
	};
}

/** Emit a complete tool call sequence. */
export function toolCallEvents(
	toolName: string,
	args: Record<string, unknown>,
	toolCallId?: string,
	parentMessageId?: string,
): BaseEvent[] {
	const id = toolCallId ?? crypto.randomUUID();
	const parentId = parentMessageId ?? crypto.randomUUID();
	return [
		toolCallStartEvent(id, toolName, parentId),
		toolCallArgsEvent(id, JSON.stringify(args)),
		toolCallEndEvent(id),
	];
}

// ---------------------------------------------------------------------------
// State events
// ---------------------------------------------------------------------------

export function stateSnapshotEvent(
	snapshot: Record<string, unknown>,
): BaseEvent {
	return {
		type: EventType.STATE_SNAPSHOT,
		snapshot,
	};
}

export function stateDeltaEvent(delta: unknown[]): BaseEvent {
	return {
		type: EventType.STATE_DELTA,
		delta,
	};
}

// ---------------------------------------------------------------------------
// Reasoning flow
// ---------------------------------------------------------------------------

export function reasoningStartEvent(): BaseEvent {
	return { type: EventType.REASONING_START };
}

export function reasoningMessageStartEvent(messageId?: string): BaseEvent {
	return {
		type: EventType.REASONING_MESSAGE_START,
		messageId: messageId ?? crypto.randomUUID(),
	};
}

export function reasoningMessageContentEvent(
	messageId: string,
	delta: string,
): BaseEvent {
	return {
		type: EventType.REASONING_MESSAGE_CONTENT,
		messageId,
		delta,
	};
}

export function reasoningMessageEndEvent(messageId: string): BaseEvent {
	return {
		type: EventType.REASONING_MESSAGE_END,
		messageId,
	};
}

export function reasoningEndEvent(): BaseEvent {
	return { type: EventType.REASONING_END };
}

/** Emit a complete reasoning sequence. */
export function reasoningEvents(
	content: string,
	messageId?: string,
): BaseEvent[] {
	const id = messageId ?? crypto.randomUUID();
	return [
		reasoningStartEvent(),
		reasoningMessageStartEvent(id),
		reasoningMessageContentEvent(id, content),
		reasoningMessageEndEvent(id),
		reasoningEndEvent(),
	];
}

// ---------------------------------------------------------------------------
// Activity events
// ---------------------------------------------------------------------------

export function activitySnapshotEvent(
	messageId: string,
	activityType: string,
	content: Record<string, unknown>,
): BaseEvent {
	return {
		type: EventType.ACTIVITY_SNAPSHOT,
		messageId,
		activityType,
		content,
	};
}

export function activityDeltaEvent(
	messageId: string,
	activityType: string,
	patch: unknown[],
): BaseEvent {
	return {
		type: EventType.ACTIVITY_DELTA,
		messageId,
		activityType,
		patch,
	};
}

// ---------------------------------------------------------------------------
// Messages snapshot
// ---------------------------------------------------------------------------

export function messagesSnapshotEvent(messages: Message[]): BaseEvent {
	return {
		type: EventType.MESSAGES_SNAPSHOT,
		messages,
	};
}

// ---------------------------------------------------------------------------
// Extension events
// ---------------------------------------------------------------------------

export function customEvent(name: string, value: unknown): BaseEvent {
	return {
		type: EventType.CUSTOM,
		name,
		value,
	};
}

export function rawEvent(payload: unknown): BaseEvent {
	return {
		type: EventType.RAW,
		payload,
	};
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export function stepStartedEvent(
	stepName?: string,
	subagentRunId?: string,
): BaseEvent {
	return {
		type: EventType.STEP_STARTED,
		stepName: stepName ?? "step-1",
		...(subagentRunId ? { subagentRunId } : {}),
	};
}

export function stepFinishedEvent(
	stepName?: string,
	subagentRunId?: string,
): BaseEvent {
	return {
		type: EventType.STEP_FINISHED,
		stepName: stepName ?? "step-1",
		...(subagentRunId ? { subagentRunId } : {}),
	};
}

// ---------------------------------------------------------------------------
// Interrupts
// ---------------------------------------------------------------------------

/**
 * A run that ends paused, awaiting the client's answer. The client writes
 * `agent.pendingInterrupts` from this outcome, and refuses to start another run
 * until every id is addressed by a resume entry.
 */
export function runFinishedInterruptEvent(
	interrupts: Interrupt[],
	overrides?: Partial<BaseEvent>,
): BaseEvent {
	return {
		type: EventType.RUN_FINISHED,
		runId: crypto.randomUUID(),
		threadId: crypto.randomUUID(),
		outcome: { type: "interrupt", interrupts },
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

export function subagentStartedEvent(
	subagentRunId: string,
	name: string,
	overrides?: Record<string, unknown>,
): BaseEvent {
	return {
		type: EventType.SUBAGENT_STARTED,
		subagentRunId,
		name,
		...overrides,
	};
}

export function subagentFinishedEvent(
	subagentRunId: string,
	overrides?: Record<string, unknown>,
): BaseEvent {
	return {
		type: EventType.SUBAGENT_FINISHED,
		subagentRunId,
		...overrides,
	};
}

export function subagentErrorEvent(
	subagentRunId: string,
	message: string,
): BaseEvent {
	return {
		type: EventType.SUBAGENT_ERROR,
		subagentRunId,
		message,
	};
}
