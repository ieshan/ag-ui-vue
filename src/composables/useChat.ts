import {
	computed,
	getCurrentInstance,
	nextTick,
	onScopeDispose,
	provide,
	ref,
	shallowRef,
	type Ref,
	type ShallowRef,
	type ComputedRef,
} from "vue";
import type { AbstractAgent, RunAgentResult } from "@ag-ui/client";
import type {
	Interrupt,
	InputContent,
	Message,
	ResumeEntry,
	State,
	TokenUsage,
	Tool,
	Context,
} from "@ag-ui/client";
import { buildResumeArray, isInterruptExpired } from "@ag-ui/client";
import { useAgent, type UseAgentOptions } from "./useAgent";
import { executeToolCalls } from "../core/tool-executor";
import { toChatItems, type ChatItem } from "../core/view-model";
import {
	WILDCARD_TOOL_NAME,
	type FrontendToolRegistry,
	type ContextRegistry,
	type ConfirmationGate,
	type StepRecord,
	type SubagentRecord,
	type ToolCallTracker,
	type PendingToolCall,
} from "../core/types";
import type { AgentSource } from "../config";
import { CHAT_REGISTRIES_KEY } from "../keys";

export type ChatStatus = "ready" | "submitted" | "streaming" | "error";

export interface UseChatOptions extends UseAgentOptions {
	forwardedProps?: Record<string, unknown>;
	/**
	 * Resume automatically as soon as every open interrupt has a response.
	 * Defaults to `true`; set `false` to batch responses and call `resume()`.
	 */
	autoResumeInterrupts?: boolean;
	onError?: (error: Error) => void;
	onFinish?: (result: RunAgentResult) => void;
}

export type UseChatConfig = AgentSource & UseChatOptions;

export interface SendOptions {
	forwardedProps?: Record<string, unknown>;
}

export interface UseChatReturn {
	/** Raw protocol messages. */
	messages: ShallowRef<Message[]>;
	/**
	 * The renderer-agnostic timeline. This is the surface component adapters
	 * should build on — see `ChatItem` / `ChatPart`.
	 */
	items: ComputedRef<ChatItem[]>;
	status: Ref<ChatStatus>;
	error: ShallowRef<Error | null>;
	state: ShallowRef<State>;
	isRunning: ComputedRef<boolean>;
	isReasoning: ShallowRef<boolean>;
	threadId: ComputedRef<string>;
	steps: ShallowRef<StepRecord[]>;
	subagents: ShallowRef<Map<string, SubagentRecord>>;
	/** Token usage the most recent run reported; empty when it reported none. */
	usage: ShallowRef<TokenUsage[]>;
	toolCallTrackers: ShallowRef<Map<string, ToolCallTracker>>;
	pendingToolCalls: ComputedRef<PendingToolCall[]>;
	/**
	 * Resolves with the run result, or `null` when the run was cancelled via
	 * `stop()`. Rejects when the run genuinely failed.
	 *
	 * Pass `InputContent[]` for a multimodal turn (text plus images, audio,
	 * video or documents).
	 */
	send: (
		content: string | InputContent[],
		opts?: SendOptions,
	) => Promise<RunAgentResult | null>;
	stop: () => void;
	approve: (toolCallId: string) => void;
	reject: (toolCallId: string, reason?: string) => void;

	// --- Interrupts (the protocol's human-in-the-loop path) ---
	/** Interrupts the last run raised, all of which must be addressed to resume. */
	interrupts: ShallowRef<Interrupt[]>;
	respondToInterrupt: (interruptId: string, payload?: unknown) => void;
	cancelInterrupt: (interruptId: string) => void;
	/** Resume the paused run. Rejects if an interrupt is unaddressed or expired. */
	resume: () => Promise<RunAgentResult | null>;
	/** Abandon the open interrupts, unwedging a thread whose approval expired. */
	clearInterrupts: () => void;

	// --- Transcript management ---
	setMessages: (messages: Message[]) => void;
	appendMessage: (message: Message) => void;
	/** Empty the transcript and reset run state; keeps the same thread. */
	clear: () => void;
	/** Drop everything after the last user message and run it again. */
	reload: () => Promise<RunAgentResult | null>;

	/** Open a persistent connection, for agents that implement one. */
	connect: () => Promise<RunAgentResult | null>;
	agent: AbstractAgent;
	/** @internal Tool registry — prefer useFrontendTool() with provide/inject auto-discovery */
	toolRegistry: FrontendToolRegistry;
	/** @internal Context registry — prefer useAgentContext() with provide/inject auto-discovery */
	contextRegistry: ContextRegistry;
}

function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}

type InterruptResponse =
	{ status: "resolved"; payload?: unknown } | { status: "cancelled" };

export function useChat(config: UseChatConfig): UseChatReturn {
	const {
		agent,
		messages,
		state,
		isRunning,
		threadId,
		isReasoning,
		steps,
		subagents,
		interrupts,
		usage,
		toolCallTrackers,
		trackerStore,
	} = useAgent(config);

	const items = computed(() =>
		toChatItems(messages.value, toolCallTrackers.value),
	);

	const status = ref<ChatStatus>("ready");
	const error = shallowRef<Error | null>(null);
	const confirmationGates = shallowRef<ConfirmationGate[]>([]);

	// Cancels both the agent run and any in-flight tool handler. Needed because
	// AbstractAgent.abortRun() is a no-op unless the subclass overrides it, so a
	// host-supplied agent would otherwise ignore stop() entirely.
	let abortController = new AbortController();
	let inFlight = false;
	// The props the current turn started with. A resume or a reload continues
	// that turn, so it must carry the same auth/tenant data rather than falling
	// back to the config and silently dropping a per-send override.
	let turnForwardedProps: Record<string, unknown> = config.forwardedProps ?? {};

	const toolRegistry: FrontendToolRegistry = new Map();
	const contextRegistry: ContextRegistry = new Map();

	// provide() needs a component instance. Inside a store or a bare
	// effectScope there is none, and calling it anyway only logs a warning —
	// so skip it and let those callers pass `chat` to useFrontendTool()
	// explicitly, which is the documented alternative to auto-discovery.
	if (getCurrentInstance()) {
		provide(CHAT_REGISTRIES_KEY, {
			tools: toolRegistry,
			contexts: contextRegistry,
		});
	}

	const hasReceivedContent = ref(false);

	function markStreaming() {
		if (!hasReceivedContent.value) {
			hasReceivedContent.value = true;
			status.value = "streaming";
		}
	}

	const statusSubscription = agent.subscribe({
		onTextMessageContentEvent: markStreaming,
		onToolCallStartEvent: markStreaming,
		// A reasoning-only prefix is streaming too; without this the UI shows
		// "sending" for as long as the model thinks.
		onReasoningStartEvent: markStreaming,
		onReasoningMessageContentEvent: markStreaming,
		onRunErrorEvent({ event }) {
			const err = new Error(event.message || "Agent run failed");
			error.value = err;
			status.value = "error";
			config.onError?.(err);
		},
	});

	onScopeDispose(() => {
		statusSubscription.unsubscribe();
		abortController.abort();
		// Settle every open gate, otherwise executeToolCalls awaits a promise
		// that can never resolve and status stays stuck at "submitted".
		const open = confirmationGates.value;
		confirmationGates.value = [];
		for (const gate of open) {
			gate.resolve(false, "Chat was disposed before the tool was approved.");
		}
	});

	function getToolDefinitions(): Tool[] {
		return (
			Array.from(toolRegistry.values())
				// A wildcard has no name a model could call, and an unavailable tool
				// is one the agent should not know about at all.
				.filter((t) => t.name !== WILDCARD_TOOL_NAME && t.available !== false)
				.map((t) => ({
					name: t.name,
					description: t.description ?? "",
					parameters: t.parameters ?? { type: "object", properties: {} },
					...(t.metadata ? { metadata: t.metadata } : {}),
				}))
		);
	}

	function getContexts(): Context[] {
		return Array.from(contextRegistry.values());
	}

	const pendingToolCalls = computed<PendingToolCall[]>(() => {
		const result: PendingToolCall[] = [];
		for (const [, tracker] of toolCallTrackers.value) {
			if (tracker.state === "approval-requested") {
				let args: Record<string, unknown>;
				try {
					args = JSON.parse(tracker.args || "{}") as Record<string, unknown>;
				} catch {
					args = {};
				}
				result.push({
					toolCallId: tracker.toolCallId,
					toolName: tracker.toolName,
					args,
					state: tracker.state,
				});
			}
		}
		return result;
	});

	function settleGate(toolCallId: string, approved: boolean, reason?: string) {
		const gates = confirmationGates.value;
		const gate = gates.find((g) => g.toolCallId === toolCallId);
		if (!gate) return;
		confirmationGates.value = gates.filter((g) => g.toolCallId !== toolCallId);
		gate.resolve(approved, reason);
	}

	function approve(toolCallId: string) {
		settleGate(toolCallId, true);
	}

	function reject(toolCallId: string, reason?: string) {
		settleGate(toolCallId, false, reason);
	}

	/**
	 * One turn: start a run, execute any frontend tool calls it produced, and
	 * map the outcome onto `status`/`error`. Shared by send(), resume() and
	 * reload() so all three cancel, guard and report identically.
	 */
	async function runTurn(
		forwardedProps: Record<string, unknown>,
		resume?: ResumeEntry[],
	): Promise<RunAgentResult | null> {
		// Two concurrent runs would interleave two runs' events into one message
		// array; AbstractAgent tracks isRunning but does not guard on it.
		// Guarding on `status` alone is not enough: stop() returns status to
		// "ready" while the previous promise may still be settling. An already
		// cancelled run is not a reason to refuse — otherwise an agent whose
		// abortRun() is a no-op would lock the caller out permanently.
		if (inFlight && !abortController.signal.aborted) {
			throw new Error(
				"[ag-ui-vue] A run is already in progress. Await the pending send()/resume()/reload(), or call stop() first.",
			);
		}

		turnForwardedProps = forwardedProps;
		error.value = null;
		hasReceivedContent.value = false;
		status.value = "submitted";
		const controller = new AbortController();
		abortController = controller;
		inFlight = true;

		try {
			const result = await agent.runAgent({
				tools: getToolDefinitions(),
				context: getContexts(),
				forwardedProps,
				...(resume ? { resume } : {}),
			});

			await executeToolCalls(result, {
				agent,
				tools: toolRegistry,
				trackerStore,
				getToolDefinitions,
				getContexts,
				// Read on every follow-up run, so this turn's auth/tenant props
				// survive past run 1 instead of being dropped.
				getForwardedProps: () => forwardedProps,
				generateId: () => crypto.randomUUID(),
				waitForFrameworkUpdates: () => nextTick(),
				signal: controller.signal,
				onConfirmationRequired(gate) {
					confirmationGates.value = [...confirmationGates.value, gate];
				},
				onConfirmationResolved(toolCallId) {
					confirmationGates.value = confirmationGates.value.filter(
						(g) => g.toolCallId !== toolCallId,
					);
				},
				onTrackersChanged(trackers) {
					toolCallTrackers.value = trackers;
				},
			});

			// Responses only apply to the interrupts they addressed; whatever the
			// run raised next is a fresh question.
			pruneInterruptResponses();

			// RUN_ERROR is a normal stream event, so runAgent() resolves after one.
			// Without this guard a failed run reports success.
			if (error.value !== null) return null;

			// stop() during the run: the observable may still complete normally,
			// but the caller cancelled, so this is not a finished turn.
			if (controller.signal.aborted) {
				status.value = "ready";
				return null;
			}

			status.value = "ready";
			config.onFinish?.(result);
			return result;
		} catch (err) {
			if (isAbortError(err) || controller.signal.aborted) {
				// A deliberate cancellation is not a failure.
				status.value = "ready";
				return null;
			}
			const e = err instanceof Error ? err : new Error(String(err));
			error.value = e;
			status.value = "error";
			config.onError?.(e);
			throw e;
		} finally {
			// Only the newest run clears the flag; a stale aborted run settling
			// later must not unlock a send that is already in progress.
			if (abortController === controller) inFlight = false;
		}
	}

	async function send(
		content: string | InputContent[],
		opts?: SendOptions,
	): Promise<RunAgentResult | null> {
		const forwardedProps = opts?.forwardedProps ?? config.forwardedProps ?? {};

		agent.addMessage({
			id: crypto.randomUUID(),
			role: "user",
			content,
		});

		return runTurn(forwardedProps);
	}

	// -----------------------------------------------------------------------
	// Interrupts.
	//
	// A run that ends with an interrupt outcome leaves the agent unable to run
	// at all — AbstractAgent.onInitialize throws until every open interrupt is
	// addressed by a resume entry — so this is not optional sugar.
	// -----------------------------------------------------------------------
	const interruptResponses = new Map<string, InterruptResponse>();

	function pruneInterruptResponses() {
		const open = new Set(interrupts.value.map((i) => i.id));
		for (const id of [...interruptResponses.keys()]) {
			if (!open.has(id)) interruptResponses.delete(id);
		}
	}

	function recordInterruptResponse(
		interruptId: string,
		response: InterruptResponse,
	) {
		if (!interrupts.value.some((i) => i.id === interruptId)) {
			throw new Error(
				`[ag-ui-vue] No open interrupt "${interruptId}". Open interrupts: ${
					interrupts.value.map((i) => i.id).join(", ") || "(none)"
				}.`,
			);
		}
		interruptResponses.set(interruptId, response);

		const allAddressed = interrupts.value.every((i) =>
			interruptResponses.has(i.id),
		);
		if (allAddressed && config.autoResumeInterrupts !== false) {
			// Fire and forget: the promise is available via resume() for callers
			// that want it, and failures already land on `error`/`onError`.
			void resume().catch(() => {});
		}
	}

	function respondToInterrupt(interruptId: string, payload?: unknown) {
		recordInterruptResponse(interruptId, { status: "resolved", payload });
	}

	function cancelInterrupt(interruptId: string) {
		recordInterruptResponse(interruptId, { status: "cancelled" });
	}

	async function resume(): Promise<RunAgentResult | null> {
		const open = interrupts.value;
		if (open.length === 0) {
			throw new Error(
				"[ag-ui-vue] resume() called with no open interrupts. Only a run that finished with an interrupt outcome can be resumed.",
			);
		}

		const expired = open.filter((i) => isInterruptExpired(i));
		if (expired.length > 0) {
			// The agent would throw on the next run either way; failing here says
			// which interrupt expired, and clearInterrupts() is the way out.
			throw new Error(
				`[ag-ui-vue] Interrupt(s) ${expired
					.map((i) => i.id)
					.join(
						", ",
					)} expired and can no longer be resumed. Call clearInterrupts() to abandon them.`,
			);
		}

		// Throws a directed message when an id is unaddressed or unknown.
		const resumeEntries = buildResumeArray(
			open,
			Object.fromEntries(interruptResponses),
		);

		return runTurn(turnForwardedProps, resumeEntries);
	}

	function clearInterrupts() {
		// Writing the agent's own field is what actually unblocks it; a local
		// reset alone would leave onInitialize throwing.
		agent.pendingInterrupts = [];
		interrupts.value = [];
		interruptResponses.clear();
	}

	// -----------------------------------------------------------------------
	// Transcript management
	// -----------------------------------------------------------------------
	function setMessages(next: Message[]) {
		agent.setMessages(next);
	}

	function appendMessage(message: Message) {
		agent.addMessage(message);
	}

	function clear() {
		agent.setMessages([]);
		messages.value = [];
		toolCallTrackers.value = trackerStore.reset();
		clearInterrupts();
		error.value = null;
		status.value = "ready";
	}

	async function reload(): Promise<RunAgentResult | null> {
		let lastUserIndex = -1;
		for (let i = agent.messages.length - 1; i >= 0; i--) {
			if (agent.messages[i]?.role === "user") {
				lastUserIndex = i;
				break;
			}
		}
		if (lastUserIndex === -1) {
			throw new Error(
				"[ag-ui-vue] reload() needs a user message to run again; the transcript has none.",
			);
		}

		const kept = agent.messages.slice(0, lastUserIndex + 1);
		const dropped = agent.messages.length - kept.length;
		agent.setMessages(kept);
		messages.value = [...agent.messages];

		// The regenerated turn will produce its own tool calls; trackers for the
		// discarded ones would otherwise linger as orphan UI state.
		if (dropped > 0) {
			toolCallTrackers.value = trackerStore.reset();
		}

		return runTurn(turnForwardedProps);
	}

	async function connect(): Promise<RunAgentResult | null> {
		return agent.connectAgent({
			tools: getToolDefinitions(),
			context: getContexts(),
			forwardedProps: turnForwardedProps,
		});
	}

	function stop() {
		abortController.abort();
		// abortRun() is a no-op on AbstractAgent, so detaching from the active
		// run is what actually stops a non-HTTP agent — and it lets the pending
		// runAgent() promise settle instead of hanging.
		agent.abortRun();
		void agent.detachActiveRun().catch(() => {});
		if (status.value === "submitted" || status.value === "streaming") {
			status.value = "ready";
		}
	}

	return {
		messages,
		items,
		status,
		error,
		state,
		isRunning,
		isReasoning,
		threadId,
		steps,
		subagents,
		usage,
		toolCallTrackers,
		pendingToolCalls,
		send,
		stop,
		approve,
		reject,
		interrupts,
		respondToInterrupt,
		cancelInterrupt,
		resume,
		clearInterrupts,
		setMessages,
		appendMessage,
		clear,
		reload,
		connect,
		agent,
		toolRegistry,
		contextRegistry,
	};
}
