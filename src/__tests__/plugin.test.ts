import { describe, it, expect } from "vitest";
import { createApp, defineComponent, h, inject } from "vue";
import { HttpAgent } from "@ag-ui/client";
import { createAGUI } from "../plugin";
import { useProvideAGUI, useAGUI } from "../provider";
import { AGUI_INJECTION_KEY } from "../keys";
import type { AGUIProviderState } from "../keys";
import { useChat } from "../composables/useChat";
import { MockStepwiseAgent } from "./utils/mock-agent";

function mountWithProvider<T>(
	setupChild: () => T,
	installProvider: () => void,
): { value: T; unmount: () => void } {
	let value!: T;

	const Child = defineComponent({
		setup() {
			value = setupChild();
			return () => h("div");
		},
	});

	const app = createApp(
		defineComponent({
			setup() {
				installProvider();
				return () => h(Child);
			},
		}),
	);

	app.mount(document.createElement("div"));
	return { value, unmount: () => app.unmount() };
}

describe("createAGUI plugin", () => {
	it("installs provider defaults and the agent registry", () => {
		let injected: AGUIProviderState | undefined;

		const app = createApp(
			defineComponent({
				setup() {
					injected = inject(AGUI_INJECTION_KEY);
					return () => h("div");
				},
			}),
		);

		app.use(
			createAGUI({
				defaults: { headers: { Authorization: "Bearer t" } },
				agents: { support: { url: "http://test-plugin" } },
			}),
		);
		app.mount(document.createElement("div"));

		expect(injected).toBeDefined();
		expect(injected!.defaults.headers).toEqual({ Authorization: "Bearer t" });
		expect(injected!.agents.get("support")).toEqual({
			url: "http://test-plugin",
		});
		app.unmount();
	});

	it("works with no options at all", () => {
		const app = createApp(
			defineComponent({
				setup: () => () => h("div"),
			}),
		);
		expect(() => app.use(createAGUI())).not.toThrow();
		app.mount(document.createElement("div"));
		app.unmount();
	});
});

describe("useProvideAGUI / useAGUI", () => {
	it("useAGUI retrieves the injected state", () => {
		const { value, unmount } = mountWithProvider(
			() => useAGUI(),
			() =>
				useProvideAGUI({ agents: { main: { url: "http://provide-test" } } }),
		);

		expect(value).toBeDefined();
		expect(value!.agents.get("main")).toEqual({ url: "http://provide-test" });
		unmount();
	});

	it("useAGUI returns undefined outside a provider — a provider is optional", () => {
		let state: AGUIProviderState | undefined = {} as AGUIProviderState;
		const app = createApp(
			defineComponent({
				setup() {
					state = useAGUI();
					return () => h("div");
				},
			}),
		);
		app.mount(document.createElement("div"));
		expect(state).toBeUndefined();
		app.unmount();
	});
});

describe("provider wiring", () => {
	it("resolves a named agent registered on the provider", () => {
		const registered = new MockStepwiseAgent();
		const { value, unmount } = mountWithProvider(
			() => useChat({ agentId: "support" }),
			() => useProvideAGUI({ agents: { support: { agent: registered } } }),
		);

		expect(value.agent).toBe(registered);
		unmount();
	});

	it("applies provider defaults to an HttpAgent it builds", () => {
		const { value, unmount } = mountWithProvider(
			() => useChat({ url: "http://test" }),
			() => useProvideAGUI({ defaults: { headers: { "X-Tenant": "acme" } } }),
		);

		expect((value.agent as HttpAgent).headers).toEqual({ "X-Tenant": "acme" });
		unmount();
	});

	it("lets an explicit local option win over a provider default", () => {
		const { value, unmount } = mountWithProvider(
			() => useChat({ url: "http://test", headers: { "X-Tenant": "local" } }),
			() => useProvideAGUI({ defaults: { headers: { "X-Tenant": "acme" } } }),
		);

		expect((value.agent as HttpAgent).headers).toEqual({ "X-Tenant": "local" });
		unmount();
	});

	it("throws a directed error for an unregistered agentId", () => {
		expect(() =>
			mountWithProvider(
				() => useChat({ agentId: "missing" }),
				() => useProvideAGUI({ agents: {} }),
			),
		).toThrow(/No agent registered as "missing"/);
	});

	it("throws a directed error when agentId is used with no provider", () => {
		expect(() =>
			mountWithProvider(
				() => useChat({ agentId: "support" }),
				() => {},
			),
		).toThrow(/needs an AG-UI provider/);
	});
});
