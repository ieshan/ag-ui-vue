import type { App, Plugin } from "vue";
import { AGUI_INJECTION_KEY } from "./keys";
import type { AgentSource } from "./config";
import type { AGUIDefaults, AGUIProviderState } from "./keys";

export interface CreateAGUIOptions {
	/** Merged underneath every useChat()/useAgent() call. */
	defaults?: AGUIDefaults;
	/** Named agents resolvable by `useChat({ agentId })`. */
	agents?: Record<string, AgentSource>;
}

/**
 * Create a Vue plugin that installs app-level AG-UI defaults and a named-agent
 * registry.
 *
 * ```ts
 * const app = createApp(App)
 * app.use(createAGUI({
 *   defaults: { headers: { Authorization: token } },
 *   agents: { support: { url: "http://localhost:8000" } },
 * }))
 * ```
 */
export function createAGUI(options: CreateAGUIOptions = {}): Plugin {
	return {
		install(app: App) {
			app.provide(AGUI_INJECTION_KEY, createProviderState(options));
		},
	};
}

export function createProviderState(
	options: CreateAGUIOptions,
): AGUIProviderState {
	return {
		defaults: { ...options.defaults },
		agents: new Map(Object.entries(options.agents ?? {})),
	};
}
