import { describe, it, expect } from "vitest";
import { ref } from "vue";
import { mountComposable } from "../utils/mount-composable";
import { useAgentContext } from "../../composables/useAgentContext";
import { CHAT_REGISTRIES_KEY } from "../../keys";
import type { ContextRegistry } from "../../core/types";
import type { UseChatReturn } from "../../composables/useChat";

function mockChat(
	contextRegistry?: ContextRegistry,
): Pick<UseChatReturn, "contextRegistry"> {
	return { contextRegistry: contextRegistry ?? new Map() };
}

describe("useAgentContext", () => {
	it("registers context via explicit chat option", () => {
		const chat = mockChat();
		const { unmount } = mountComposable(() =>
			useAgentContext({
				context: { description: "User prefs", value: '{"theme":"dark"}' },
				chat: chat as UseChatReturn,
			}),
		);

		expect(chat.contextRegistry.size).toBe(1);
		expect([...chat.contextRegistry.values()][0]).toEqual({
			description: "User prefs",
			value: '{"theme":"dark"}',
		});
		unmount();
	});

	it("registers context via provide/inject auto-discovery", () => {
		const registry: ContextRegistry = new Map();
		const { unmount } = mountComposable(
			() =>
				useAgentContext({
					context: { description: "User prefs", value: '{"theme":"dark"}' },
				}),
			{
				provide: [
					[CHAT_REGISTRIES_KEY, { tools: new Map(), contexts: registry }],
				],
			},
		);

		expect(registry.size).toBe(1);
		expect([...registry.values()][0]).toEqual({
			description: "User prefs",
			value: '{"theme":"dark"}',
		});
		unmount();
	});

	it("throws when no registry is available", () => {
		expect(() =>
			mountComposable(() =>
				useAgentContext({
					context: { description: "test", value: "x" },
				}),
			),
		).toThrow("[ag-ui-vue] useAgentContext()");
	});

	it("cleanup on unmount removes context", () => {
		const chat = mockChat();
		const { unmount } = mountComposable(() =>
			useAgentContext({
				context: { description: "temp", value: "x" },
				chat: chat as UseChatReturn,
			}),
		);

		expect(chat.contextRegistry.size).toBe(1);
		unmount();
		expect(chat.contextRegistry.size).toBe(0);
	});

	it("keeps two contexts that share a description", () => {
		// Keyed by a generated id, not by description — otherwise one silently
		// evicts the other, and either unmounting removes both.
		const chat = mockChat();
		const a = mountComposable(() =>
			useAgentContext({
				context: { description: "same", value: "first" },
				chat: chat as any,
			}),
		);
		const b = mountComposable(() =>
			useAgentContext({
				context: { description: "same", value: "second" },
				chat: chat as any,
			}),
		);

		expect(chat.contextRegistry.size).toBe(2);

		a.unmount();
		expect(chat.contextRegistry.size).toBe(1);
		expect([...chat.contextRegistry.values()][0].value).toBe("second");
		b.unmount();
	});

	it("returns an unregister handle for manual removal", () => {
		const chat = mockChat();
		const { result, unmount } = mountComposable(() =>
			useAgentContext({
				context: { description: "manual", value: "v" },
				chat: chat as any,
			}),
		);

		expect(chat.contextRegistry.size).toBe(1);
		result.unregister();
		expect(chat.contextRegistry.size).toBe(0);
		// Idempotent — the scope hook runs it again on unmount.
		expect(() => result.unregister()).not.toThrow();
		unmount();
	});
});

describe("useAgentContext reactivity", () => {
	it("updates the registered context in place when its source changes", () => {
		const chat = mockChat();
		const route = ref("/dashboard");
		const { unmount } = mountComposable(() =>
			useAgentContext({
				context: () => ({
					description: "Current route",
					value: route.value,
				}),
				chat: chat as UseChatReturn,
			}),
		);

		expect([...chat.contextRegistry.values()][0].value).toBe("/dashboard");

		route.value = "/settings";

		// Same key, new value — an update must not accumulate stale entries.
		expect(chat.contextRegistry.size).toBe(1);
		expect([...chat.contextRegistry.values()][0].value).toBe("/settings");
		unmount();
		expect(chat.contextRegistry.size).toBe(0);
	});
});
