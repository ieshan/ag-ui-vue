import type { MaybeRefOrGetter } from "vue";
import type { AbstractAgent, HttpAgentConfig, Middleware } from "@ag-ui/client";

// ---------------------------------------------------------------------------
// How a composable is told which agent to talk to.
//
// This lives outside `src/core/` because the options are reactive — a Vue
// concept — while `core/` is protocol-level and stays framework-free.
//
// A composable either receives an agent the host built (any AbstractAgent
// subclass — the ag-ui integrations, a custom transport, a test double) or the
// configuration to build an HttpAgent as a convenience. `agent?: never` /
// `url?: never` make the union discriminate on presence, so passing both is a
// type error rather than a silent precedence rule.
// ---------------------------------------------------------------------------

export interface ExternalAgentSource {
	agent: AbstractAgent;
	middleware?: Middleware[];
	url?: never;
}

export interface HttpAgentSource extends Omit<
	HttpAgentConfig,
	"headers" | "threadId"
> {
	/** Re-applied to the agent when it changes — e.g. a refreshed auth token. */
	headers?: MaybeRefOrGetter<Record<string, string> | undefined>;
	/**
	 * Re-applied to the agent when it changes, which switches thread without
	 * rebuilding it. The transcript is deliberately left alone; call
	 * `useChat().clear()` if a switch should also empty it.
	 */
	threadId?: MaybeRefOrGetter<string | undefined>;
	middleware?: Middleware[];
	agent?: never;
}

/** Resolve an agent registered on the provider under this id. */
export interface RegisteredAgentSource {
	agentId: string;
	middleware?: Middleware[];
	agent?: never;
	url?: never;
}

export type AgentSource =
	ExternalAgentSource | HttpAgentSource | RegisteredAgentSource;

export function isExternalAgentSource(
	source: AgentSource,
): source is ExternalAgentSource {
	return (source as ExternalAgentSource).agent !== undefined;
}

export function isHttpAgentSource(
	source: AgentSource,
): source is HttpAgentSource {
	return typeof (source as HttpAgentSource).url === "string";
}
