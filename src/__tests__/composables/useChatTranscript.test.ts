import { describe, it, expect } from "vitest";
import type { Message } from "@ag-ui/client";
import { mountComposable } from "../utils/mount-composable";
import { MockStepwiseAgent } from "../utils/mock-agent";
import { runFinishedEvent, runStartedEvent } from "../utils/event-factories";
import { useChat } from "../../composables/useChat";

async function flush(times = 4) {
	for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 5));
}

async function completeRun(agent: MockStepwiseAgent) {
	await flush(2);
	agent.emitAll([
		runStartedEvent({ threadId: agent.threadId }),
		runFinishedEvent({ threadId: agent.threadId }),
	]);
	agent.complete();
	await flush();
}

const TRANSCRIPT: Message[] = [
	{ id: "u1", role: "user", content: "hello" },
	{ id: "a1", role: "assistant", content: "hi there" },
];

describe("useChat transcript management", () => {
	it("setMessages replaces the transcript", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		result.setMessages(TRANSCRIPT);
		await flush();

		expect(result.messages.value.map((m) => m.id)).toEqual(["u1", "a1"]);
		expect(result.items.value.map((i) => i.role)).toEqual([
			"user",
			"assistant",
		]);
		unmount();
	});

	it("appendMessage adds to the end", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		result.setMessages(TRANSCRIPT);
		await flush();
		result.appendMessage({ id: "u2", role: "user", content: "and again" });
		await flush();

		expect(result.messages.value.map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
		unmount();
	});

	it("clear() empties the transcript and resets run state", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		result.setMessages(TRANSCRIPT);
		result.toolCallTrackers.value = new Map([
			[
				"tc1",
				{
					toolCallId: "tc1",
					toolName: "fn",
					args: "{}",
					state: "output-available" as const,
				},
			],
		]);
		await flush();

		result.clear();
		await flush();

		expect(result.messages.value).toEqual([]);
		expect(agent.messages).toEqual([]);
		// Trackers described the transcript that just went away.
		expect(result.toolCallTrackers.value.size).toBe(0);
		expect(result.status.value).toBe("ready");
		expect(result.error.value).toBeNull();
		unmount();
	});

	it("reload() drops everything after the last user message and re-runs", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		result.setMessages([
			{ id: "u1", role: "user", content: "first" },
			{ id: "a1", role: "assistant", content: "first answer" },
			{ id: "u2", role: "user", content: "second" },
			{ id: "a2", role: "assistant", content: "a bad answer" },
			{ id: "t1", role: "tool", toolCallId: "tc1", content: "{}" },
		]);
		await flush();

		const reloaded = result.reload();
		await completeRun(agent);
		await reloaded.catch(() => {});

		expect(agent.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
		expect(agent.runCount).toBe(1);
		unmount();
	});

	it("reload() rejects when there is no user message to re-run", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		result.setMessages([{ id: "s1", role: "system", content: "be helpful" }]);
		await flush();

		await expect(result.reload()).rejects.toThrow(/needs a user message/);
		expect(agent.runCount).toBe(0);
		unmount();
	});

	it("send() accepts multimodal content and renders it as file parts", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		const sent = result.send([
			{ type: "text", text: "what is in this picture?" },
			{
				type: "image",
				source: {
					type: "url",
					value: "https://example.com/cat.png",
					mimeType: "image/png",
				},
			},
		]);
		await completeRun(agent);
		await sent.catch(() => {});

		const [userMessage] = agent.messages;
		expect(Array.isArray(userMessage.content)).toBe(true);

		const parts = result.items.value[0].parts;
		expect(parts).toEqual([
			{ type: "text", text: "what is in this picture?" },
			{
				type: "file",
				kind: "image",
				mimeType: "image/png",
				source: {
					type: "url",
					value: "https://example.com/cat.png",
					mimeType: "image/png",
				},
			},
		]);
		unmount();
	});
});
