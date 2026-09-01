import { getCurrentInstance, inject, provide } from "vue";
import { createProviderState, type CreateAGUIOptions } from "./plugin";
import { AGUI_INJECTION_KEY } from "./keys";
import type { AGUIProviderState } from "./keys";

/**
 * Provide AG-UI defaults and a named-agent registry to descendant components.
 * Call this in a root/layout component's `setup()` as an alternative to the
 * `createAGUI()` plugin.
 */
export function useProvideAGUI(
	options: CreateAGUIOptions = {},
): AGUIProviderState {
	const state = createProviderState(options);
	provide(AGUI_INJECTION_KEY, state);
	return state;
}

/**
 * Retrieve the AG-UI provider state injected by an ancestor `useProvideAGUI()`
 * or the `createAGUI()` plugin. Returns `undefined` when there is no provider —
 * a provider is optional, since `useChat()` accepts its configuration directly.
 */
export function useAGUI(): AGUIProviderState | undefined {
	// inject() warns when there is no component instance — inside a store or a
	// bare effectScope, for instance. There is nothing to inject there, so ask
	// only when asking is meaningful.
	if (!getCurrentInstance()) return undefined;
	return inject(AGUI_INJECTION_KEY, undefined);
}
