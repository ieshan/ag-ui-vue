import type { InjectionKey } from "vue";
import type { HttpAgentConfig, Middleware } from "@ag-ui/client";
import type { AgentSource } from "./config";
import type { ContextRegistry, FrontendToolRegistry } from "./core/types";

// ---------------------------------------------------------------------------
// Vue provide/inject wiring.
//
// These live outside `src/core/` on purpose: core is protocol-level and must
// stay framework-free, and an InjectionKey is a Vue concept.
// ---------------------------------------------------------------------------

export interface ChatRegistries {
	tools: FrontendToolRegistry;
	contexts: ContextRegistry;
}

export const CHAT_REGISTRIES_KEY: InjectionKey<ChatRegistries> = Symbol(
	"ag-ui-chat-registries",
);

/**
 * Defaults merged underneath every `useChat`/`useAgent` call, plus a registry
 * of named agents resolvable by `agentId`.
 */
export interface AGUIProviderState {
	defaults: AGUIDefaults;
	agents: Map<string, AgentSource>;
}

export interface AGUIDefaults {
	headers?: Record<string, string>;
	fetch?: HttpAgentConfig["fetch"];
	debug?: HttpAgentConfig["debug"];
	middleware?: Middleware[];
	/** Default update-coalescing window for every useChat()/useAgent(). */
	throttleMs?: number;
}

export const AGUI_INJECTION_KEY: InjectionKey<AGUIProviderState> =
	Symbol("@synoped/ag-ui-vue");
