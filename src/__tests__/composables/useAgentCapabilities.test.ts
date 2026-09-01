import { describe, it, expect, vi } from "vitest";
import type { AgentCapabilities } from "@ag-ui/client";
import { mountComposable } from "../utils/mount-composable";
import { MockStepwiseAgent } from "../utils/mock-agent";
import { useAgentCapabilities } from "../../composables/useAgentCapabilities";

const CAPABILITIES: AgentCapabilities = {
	multimodal: { input: { image: true } },
	humanInTheLoop: { interrupts: true },
};

class CapableAgent extends MockStepwiseAgent {
	getCapabilities = vi.fn(async () => CAPABILITIES);
}

async function flush() {
	await new Promise((r) => setTimeout(r, 5));
}

describe("useAgentCapabilities", () => {
	it("fetches the declared capabilities on setup", async () => {
		const agent = new CapableAgent();
		const { result, unmount } = mountComposable(() =>
			useAgentCapabilities({ agent }),
		);

		expect(result.isSupported).toBe(true);
		await flush();

		expect(result.capabilities.value).toEqual(CAPABILITIES);
		expect(result.isLoading.value).toBe(false);
		expect(result.error.value).toBeNull();
		unmount();
	});

	it("reports an agent that declares nothing as unsupported", async () => {
		// AbstractAgent leaves getCapabilities optional, so most agents have none.
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() =>
			useAgentCapabilities({ agent }),
		);

		await flush();

		expect(result.isSupported).toBe(false);
		expect(result.capabilities.value).toBeNull();
		expect(result.error.value).toBeNull();
		unmount();
	});

	it("skips the initial fetch when immediate is false", async () => {
		const agent = new CapableAgent();
		const { result, unmount } = mountComposable(() =>
			useAgentCapabilities({ agent, immediate: false }),
		);

		await flush();
		expect(agent.getCapabilities).not.toHaveBeenCalled();

		await result.refresh();
		expect(result.capabilities.value).toEqual(CAPABILITIES);
		unmount();
	});

	it("surfaces a failed fetch as an error rather than throwing", async () => {
		const agent = new MockStepwiseAgent() as MockStepwiseAgent & {
			getCapabilities: () => Promise<AgentCapabilities>;
		};
		agent.getCapabilities = async () => {
			throw new Error("capabilities endpoint down");
		};

		const { result, unmount } = mountComposable(() =>
			useAgentCapabilities({ agent }),
		);
		await flush();

		expect(result.error.value?.message).toBe("capabilities endpoint down");
		expect(result.capabilities.value).toBeNull();
		expect(result.isLoading.value).toBe(false);
		unmount();
	});
});
