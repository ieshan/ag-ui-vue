import { describe, it, expect, vi } from "vitest";
import { ref } from "vue";
import { mountComposable } from "../utils/mount-composable";
import { useFrontendTool } from "../../composables/useFrontendTool";
import { CHAT_REGISTRIES_KEY } from "../../keys";
import type { FrontendToolRegistry } from "../../core/types";
import type { UseChatReturn } from "../../composables/useChat";

function mockChat(
	toolRegistry?: FrontendToolRegistry,
): Pick<UseChatReturn, "toolRegistry"> {
	return { toolRegistry: toolRegistry ?? new Map() };
}

describe("useFrontendTool", () => {
	it("registers tool via explicit chat option", () => {
		const chat = mockChat();
		const { unmount } = mountComposable(() =>
			useFrontendTool({
				tool: {
					name: "get_weather",
					description: "Get weather",
					parameters: {},
					handler: async () => "sunny",
				},
				chat: chat as UseChatReturn,
			}),
		);

		expect(chat.toolRegistry.has("get_weather")).toBe(true);
		expect(chat.toolRegistry.get("get_weather")!.description).toBe(
			"Get weather",
		);
		unmount();
	});

	it("registers tool via provide/inject auto-discovery", () => {
		const registry: FrontendToolRegistry = new Map();
		const { unmount } = mountComposable(
			() =>
				useFrontendTool({
					tool: {
						name: "get_weather",
						description: "Get weather",
						parameters: {},
						handler: async () => "sunny",
					},
				}),
			{
				provide: [
					[CHAT_REGISTRIES_KEY, { tools: registry, contexts: new Map() }],
				],
			},
		);

		expect(registry.has("get_weather")).toBe(true);
		unmount();
	});

	it("throws when no registry is available", () => {
		expect(() =>
			mountComposable(() =>
				useFrontendTool({
					tool: {
						name: "get_weather",
						description: "Get weather",
						parameters: {},
						handler: async () => "sunny",
					},
				}),
			),
		).toThrow("[ag-ui-vue] useFrontendTool()");
	});

	it("unregisters tool on unmount", () => {
		const chat = mockChat();
		const { unmount } = mountComposable(() =>
			useFrontendTool({
				tool: {
					name: "get_weather",
					description: "Get weather",
					parameters: {},
					handler: async () => "sunny",
				},
				chat: chat as UseChatReturn,
			}),
		);

		expect(chat.toolRegistry.has("get_weather")).toBe(true);
		unmount();
		expect(chat.toolRegistry.has("get_weather")).toBe(false);
	});

	it("multiple tools coexist", () => {
		const chat = mockChat();

		const { unmount: u1 } = mountComposable(() =>
			useFrontendTool({
				tool: {
					name: "fn1",
					description: "d1",
					parameters: {},
					handler: async () => "a",
				},
				chat: chat as UseChatReturn,
			}),
		);

		const { unmount: u2 } = mountComposable(() =>
			useFrontendTool({
				tool: {
					name: "fn2",
					description: "d2",
					parameters: {},
					handler: async () => "b",
				},
				chat: chat as UseChatReturn,
			}),
		);

		expect(chat.toolRegistry.size).toBe(2);
		expect(chat.toolRegistry.has("fn1")).toBe(true);
		expect(chat.toolRegistry.has("fn2")).toBe(true);

		u1();
		expect(chat.toolRegistry.size).toBe(1);
		expect(chat.toolRegistry.has("fn1")).toBe(false);
		expect(chat.toolRegistry.has("fn2")).toBe(true);

		u2();
		expect(chat.toolRegistry.size).toBe(0);
	});

	it("handler is callable from registry", async () => {
		const chat = mockChat();
		const handler = vi.fn(async () => "result");
		const { unmount } = mountComposable(() =>
			useFrontendTool({
				tool: {
					name: "fn",
					description: "fn",
					parameters: {},
					handler,
				},
				chat: chat as UseChatReturn,
			}),
		);

		// The registry hands the executor the very handler that was registered,
		// rather than a wrapper that could drop the context argument.
		expect(chat.toolRegistry.get("fn")!.handler).toBe(handler);
		unmount();
	});
});

describe("useFrontendTool reactivity", () => {
	it("re-registers when a value the tool getter reads changes", () => {
		const chat = mockChat();
		const city = ref("Toronto");
		const { unmount } = mountComposable(() =>
			useFrontendTool({
				tool: () => ({
					name: "get_weather",
					description: `Weather in ${city.value}`,
					handler: async () => city.value,
				}),
				chat: chat as UseChatReturn,
			}),
		);

		expect(chat.toolRegistry.get("get_weather")!.description).toBe(
			"Weather in Toronto",
		);

		city.value = "Ottawa";
		// flush: "sync" — the registry must be current for a send() in this tick.
		expect(chat.toolRegistry.get("get_weather")!.description).toBe(
			"Weather in Ottawa",
		);
		unmount();
	});

	it("moves the registration when the tool's name changes", () => {
		const chat = mockChat();
		const name = ref("old_name");
		const { unmount } = mountComposable(() =>
			useFrontendTool({
				tool: () => ({ name: name.value, handler: async () => "ok" }),
				chat: chat as UseChatReturn,
			}),
		);

		name.value = "new_name";

		// A rename must not leave the old entry behind as a phantom tool.
		expect(chat.toolRegistry.has("old_name")).toBe(false);
		expect(chat.toolRegistry.has("new_name")).toBe(true);
		unmount();
		expect(chat.toolRegistry.size).toBe(0);
	});

	it("reflects a toggled `available` flag without re-registering by hand", () => {
		const chat = mockChat();
		const canEdit = ref(true);
		const { unmount } = mountComposable(() =>
			useFrontendTool({
				tool: () => ({
					name: "save",
					handler: async () => "saved",
					available: canEdit.value,
				}),
				chat: chat as UseChatReturn,
			}),
		);

		expect(chat.toolRegistry.get("save")!.available).toBe(true);
		canEdit.value = false;
		expect(chat.toolRegistry.get("save")!.available).toBe(false);
		unmount();
	});

	it("stops re-registering after unregister()", () => {
		const chat = mockChat();
		const label = ref("a");
		const { unmount } = mountComposable(() => {
			const handle = useFrontendTool({
				tool: () => ({
					name: "fn",
					description: label.value,
					handler: async () => "ok",
				}),
				chat: chat as UseChatReturn,
			});
			handle.unregister();
			return handle;
		});

		expect(chat.toolRegistry.has("fn")).toBe(false);
		label.value = "b";
		// A stopped watcher must not resurrect the tool.
		expect(chat.toolRegistry.has("fn")).toBe(false);
		unmount();
	});
});
