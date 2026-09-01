import {
	shallowRef,
	onScopeDispose,
	toValue,
	watch,
	computed,
	type ShallowRef,
	type ComputedRef,
} from "vue";
import { HttpAgent } from "@ag-ui/client";
import type { AbstractAgent, AgentSubscriber, Interrupt } from "@ag-ui/client";
import type { Message, State, TokenUsage } from "@ag-ui/client";
// `CustomEvent` is also a DOM global, so it is aliased rather than shadowed.
import type { CustomEvent as AGUICustomEvent, RawEvent } from "@ag-ui/client";
import { useAGUI } from "../provider";
import {
	isExternalAgentSource,
	isHttpAgentSource,
	type AgentSource,
} from "../config";
import type {
	StepRecord,
	SubagentRecord,
	ToolCallTracker,
} from "../core/types";
import { type AGUIDefaults, type AGUIProviderState } from "../keys";
import {
	createToolCallTrackerStore,
	type ToolCallTrackerStore,
} from "../core/tool-call-tracker";

export interface UseAgentOptions {
	onCustomEvent?: (event: AGUICustomEvent) => void;
	onRawEvent?: (event: RawEvent) => void;
	/**
	 * Coalesce message and state updates so a fast stream causes one render per
	 * window instead of one per event. `0` (the default) still batches within a
	 * microtask; resolved as hook option ?? provider default ?? 0.
	 */
	throttleMs?: number;
}

export type UseAgentConfig = AgentSource & UseAgentOptions;

export interface UseAgentReturn {
	agent: AbstractAgent;
	messages: ShallowRef<Message[]>;
	state: ShallowRef<State>;
	/** Mirrors `agent.isRunning` rather than tracking a second copy. */
	isRunning: ComputedRef<boolean>;
	/** The agent's current thread, tracking both a run and a reactive switch. */
	threadId: ComputedRef<string>;
	isReasoning: ShallowRef<boolean>;
	toolCallTrackers: ShallowRef<Map<string, ToolCallTracker>>;
	/** Steps the current/last run announced, in the order they started. */
	steps: ShallowRef<StepRecord[]>;
	/** Subagent invocations, keyed by `subagentRunId`. */
	subagents: ShallowRef<Map<string, SubagentRecord>>;
	/** Open interrupts, mirroring `agent.pendingInterrupts`. */
	interrupts: ShallowRef<Interrupt[]>;
	/**
	 * Token usage the most recent run reported, one entry per (provider, model).
	 * Empty when the agent reported none — most do not.
	 */
	usage: ShallowRef<TokenUsage[]>;
	trackerStore: ToolCallTrackerStore;
}

/**
 * True for a getter or a ref — the forms worth watching. A plain value can
 * never change, so watching it would only add an effect that never fires.
 */
function isReactiveOption(value: unknown): boolean {
	return (
		typeof value === "function" ||
		(typeof value === "object" && value !== null && "value" in value)
	);
}

/**
 * Build (or pass through) the agent for a source, without applying middleware.
 */
function buildAgent(
	source: AgentSource,
	provider: AGUIProviderState | undefined,
	defaults: AGUIDefaults,
	depth: number,
): AbstractAgent {
	if (isExternalAgentSource(source)) return source.agent;

	if (isHttpAgentSource(source)) {
		return new HttpAgent({
			url: source.url,
			headers: toValue(source.headers) ?? defaults.headers,
			fetch: source.fetch ?? defaults.fetch,
			agentId: source.agentId,
			description: source.description,
			threadId: toValue(source.threadId),
			initialMessages: source.initialMessages,
			// @ag-ui/client types `State` as `any` — there's no narrower type to assign here.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
			initialState: source.initialState,
			debug: source.debug ?? defaults.debug,
		});
	}

	// Guards a registry entry that points at another registered id.
	if (depth > 0) {
		throw new Error(
			`[ag-ui-vue] Agent "${source.agentId}" resolves to another registered agent id; registry entries must be an agent or HTTP options.`,
		);
	}

	const registered = provider?.agents.get(source.agentId);
	if (!registered) {
		throw new Error(
			provider
				? `[ag-ui-vue] No agent registered as "${source.agentId}". Register it via createAGUI({ agents: { "${source.agentId}": ... } }) or useProvideAGUI().`
				: `[ag-ui-vue] useAgent({ agentId: "${source.agentId}" }) needs an AG-UI provider. Install the createAGUI() plugin or call useProvideAGUI() in an ancestor component.`,
		);
	}

	return buildAgent(registered, provider, defaults, depth + 1);
}

/**
 * Resolve the agent from the source, in precedence order: an agent the host
 * supplied, an HttpAgent built from connection options, or a named agent
 * registered on the provider.
 *
 * Provider `defaults` fill in only what the source left unset, so an explicit
 * local option always wins. Middleware is applied exactly once, at the outer
 * source, so resolving through the registry cannot double-register it.
 */
function resolveAgent(
	source: AgentSource,
	provider?: AGUIProviderState,
): AbstractAgent {
	const defaults: AGUIDefaults = provider?.defaults ?? {};
	const agent = buildAgent(source, provider, defaults, 0);

	const registered =
		!isExternalAgentSource(source) && !isHttpAgentSource(source)
			? provider?.agents.get(source.agentId)
			: undefined;

	const middleware =
		source.middleware ?? registered?.middleware ?? defaults.middleware;

	if (middleware?.length) {
		agent.use(...middleware);
	}

	return agent;
}

export function useAgent(config: UseAgentConfig): UseAgentReturn {
	const provider = useAGUI();
	const agent = resolveAgent(config, provider);

	const messages = shallowRef<Message[]>(
		agent.messages ? [...agent.messages] : [],
	);
	const state = shallowRef<State>(agent.state ?? {});
	const runCounter = shallowRef(0);
	// `agent.threadId` is a plain field. Both a run (which can adopt the id the
	// backend assigns) and a reactive `threadId` option change it, so reads are
	// made reactive by bumping a version rather than mirroring the value twice.
	const threadIdVersion = shallowRef(0);
	const isReasoning = shallowRef(false);
	const steps = shallowRef<StepRecord[]>([]);
	const subagents = shallowRef<Map<string, SubagentRecord>>(new Map());
	const interrupts = shallowRef<Interrupt[]>([...agent.pendingInterrupts]);
	const usage = shallowRef<TokenUsage[]>([]);

	// `agent.isRunning` is the source of truth (AbstractAgent maintains it);
	// runCounter exists only to make reads of it reactive.
	const isRunning = computed(() => {
		void runCounter.value;
		return agent.isRunning;
	});

	const threadId = computed(() => {
		void threadIdVersion.value;
		return agent.threadId;
	});

	const trackerStore = createToolCallTrackerStore();
	const toolCallTrackers = shallowRef<Map<string, ToolCallTracker>>(new Map());

	// Reactive connection options are re-applied rather than rebuilding the
	// agent, so an auth-token refresh or a thread switch keeps the same
	// instance (and therefore the same subscribers) alive. Switching threadId
	// deliberately does NOT clear the transcript — call `clear()` for that.
	if (isHttpAgentSource(config)) {
		const httpAgent = agent as HttpAgent;
		const { headers, threadId: configThreadId } = config;
		// `flush: "sync"`, for the same reason the registries use it: connection
		// options are read when a run starts, which can be in the same tick as
		// the change. A refreshed token must not miss the very request it was
		// fetched for.
		if (isReactiveOption(headers)) {
			watch(
				() => toValue(headers),
				(next) => {
					if (next) httpAgent.headers = next;
				},
				{ flush: "sync" },
			);
		}
		if (isReactiveOption(configThreadId)) {
			watch(
				() => toValue(configThreadId),
				(next) => {
					if (!next) return;
					httpAgent.threadId = next;
					threadIdVersion.value++;
				},
				{ flush: "sync" },
			);
		}
	}

	// ---------------------------------------------------------------------
	// Update coalescing.
	//
	// A streaming run emits one event per token, each of which would otherwise
	// trigger a render. Deltas are collapsed into the newest value and flushed
	// once per window.
	// ---------------------------------------------------------------------
	const throttleMs = config.throttleMs ?? provider?.defaults.throttleMs ?? 0;
	let pendingMessages: Message[] | undefined;
	// `State` resolves to `any` in @ag-ui/client, so `| undefined` here would be redundant.
	let pendingState: State;
	let hasPendingState = false;
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	let flushScheduled = false;

	function flush() {
		flushScheduled = false;
		flushTimer = undefined;
		if (pendingMessages) {
			messages.value = pendingMessages;
			pendingMessages = undefined;
		}
		if (hasPendingState) {
			// `State` (from @ag-ui/client) is `any` — there's no narrower type to assign here.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
			state.value = pendingState;
			hasPendingState = false;
			pendingState = undefined;
		}
	}

	function scheduleFlush() {
		if (flushScheduled) return;
		flushScheduled = true;
		if (throttleMs > 0) {
			flushTimer = setTimeout(flush, throttleMs);
		} else {
			// Still batched: several events in one tick produce one update.
			queueMicrotask(flush);
		}
	}

	const subscriber: AgentSubscriber = {
		onMessagesChanged({ messages: m }) {
			pendingMessages = [...m];
			scheduleFlush();
		},

		onStateChanged({ state: s }) {
			// The client already hands us a defensive copy; cloning again is
			// O(state) work per state event.
			pendingState = s;
			hasPendingState = true;
			scheduleFlush();
		},

		onRunStartedEvent() {
			runCounter.value++;
			// A run may have adopted a thread id the backend assigned.
			threadIdVersion.value++;
			steps.value = [];
			usage.value = [];
		},

		onRunFinishedEvent(params) {
			runCounter.value++;
			usage.value = params.event.usage ?? [];
			// Read the outcome from the callback, not `agent.pendingInterrupts`:
			// the client writes that field *after* subscribers run
			// (apply/default.ts), so reading it here is always one run stale.
			interrupts.value =
				params.outcome === "interrupt" ? [...params.interrupts] : [];
		},

		onRunErrorEvent({ event }) {
			runCounter.value++;
			// A run can fail after one or more model calls have already been paid
			// for, so a failed run still reports what it used.
			usage.value = event.usage ?? [];
		},

		onStepStartedEvent({ event }) {
			steps.value = [
				...steps.value,
				{
					name: event.stepName,
					status: "running",
					subagentRunId: event.subagentRunId,
				},
			];
		},

		onStepFinishedEvent({ event }) {
			// A name can only be active once per owner — the SDK rejects a second
			// STEP_STARTED for it — so there is exactly one candidate to close.
			steps.value = steps.value.map((step) =>
				step.status === "running" &&
				step.name === event.stepName &&
				step.subagentRunId === event.subagentRunId
					? { ...step, status: "finished" as const }
					: step,
			);
		},

		onSubagentStartedEvent({ event }) {
			const next = new Map(subagents.value);
			next.set(event.subagentRunId, {
				subagentRunId: event.subagentRunId,
				name: event.name,
				description: event.description,
				parentSubagentRunId: event.parentSubagentRunId,
				parentToolCallId: event.parentToolCallId,
				parentMessageId: event.parentMessageId,
				status: "running",
			});
			subagents.value = next;
		},

		onSubagentFinishedEvent({ event }) {
			const existing = subagents.value.get(event.subagentRunId);
			if (!existing) return;
			const outcome = event.outcome;
			const next = new Map(subagents.value);
			next.set(event.subagentRunId, {
				...existing,
				// An omitted outcome means success; "suspended" means the run
				// paused on an interrupt and the same id resumes later.
				status: outcome?.type === "suspended" ? "suspended" : "finished",
				result: event.result,
				// Which open interrupts this subagent is waiting on. Absent when it
				// suspended because a descendant interrupted rather than itself.
				interruptIds:
					outcome?.type === "suspended" ? outcome.interruptIds : undefined,
			});
			subagents.value = next;
		},

		onSubagentErrorEvent({ event }) {
			const existing = subagents.value.get(event.subagentRunId);
			if (!existing) return;
			const next = new Map(subagents.value);
			next.set(event.subagentRunId, {
				...existing,
				status: "error",
				error: event.message,
				errorCode: event.code,
			});
			subagents.value = next;
		},

		onToolCallStartEvent({ event }) {
			toolCallTrackers.value = trackerStore.trackStart(
				event.toolCallId,
				event.toolCallName,
			);
		},

		onToolCallArgsEvent({ event }) {
			toolCallTrackers.value = trackerStore.appendArgs(
				event.toolCallId,
				event.delta,
			);
		},

		onToolCallEndEvent({ event }) {
			toolCallTrackers.value = trackerStore.updateState(
				event.toolCallId,
				"input-available",
			);
		},

		// A tool call the backend executed itself. Without this the tracker sits
		// at "input-available" forever and the UI never shows a result.
		onToolCallResultEvent({ event }) {
			toolCallTrackers.value = trackerStore.updateState(
				event.toolCallId,
				"output-available",
				{ output: event.content },
			);
		},

		onReasoningStartEvent() {
			isReasoning.value = true;
		},

		onReasoningEndEvent() {
			isReasoning.value = false;
		},

		onCustomEvent({ event }) {
			config.onCustomEvent?.(event);
		},

		onRawEvent({ event }) {
			config.onRawEvent?.(event);
		},
	};

	const subscription = agent.subscribe(subscriber);

	// onScopeDispose (not onUnmounted) so the composable also cleans up inside a
	// Pinia store or a bare effectScope().
	onScopeDispose(() => {
		subscription.unsubscribe();
		if (flushTimer !== undefined) clearTimeout(flushTimer);
		flushScheduled = false;
	});

	return {
		agent,
		messages,
		state,
		isRunning,
		threadId,
		isReasoning,
		toolCallTrackers,
		steps,
		subagents,
		interrupts,
		usage,
		trackerStore,
	};
}
