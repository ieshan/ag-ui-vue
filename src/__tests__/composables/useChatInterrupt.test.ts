import { describe, it, expect } from "vitest";
import type { Interrupt } from "@ag-ui/client";
import { mountComposable } from "../utils/mount-composable";
import { MockStepwiseAgent } from "../utils/mock-agent";
import {
	runFinishedEvent,
	runFinishedInterruptEvent,
	runStartedEvent,
} from "../utils/event-factories";
import { useChat } from "../../composables/useChat";

async function flush(times = 4) {
	for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 5));
}

function approval(overrides: Partial<Interrupt> = {}): Interrupt {
	return {
		id: "int-1",
		reason: "approval_required",
		message: "Send the email?",
		...overrides,
	};
}

/** Run to completion, ending with the given interrupts left open. */
async function runToInterrupt(
	agent: MockStepwiseAgent,
	sent: Promise<unknown>,
	interrupts: Interrupt[],
) {
	await flush(2);
	agent.emitAll([
		runStartedEvent({ threadId: agent.threadId }),
		runFinishedInterruptEvent(interrupts, {
			threadId: agent.threadId,
		}),
	]);
	agent.complete();
	await sent.catch(() => {});
	await flush();
}

/** Let a resumed run finish cleanly, which clears the pending interrupts. */
async function completeRun(agent: MockStepwiseAgent) {
	await flush(2);
	agent.emitAll([
		runStartedEvent({ threadId: agent.threadId }),
		runFinishedEvent({ threadId: agent.threadId }),
	]);
	agent.complete();
	await flush();
}

describe("useChat interrupts", () => {
	it("resumes with the forwardedProps of the send it is continuing", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() =>
			useChat({ agent, forwardedProps: { tenantId: "default" } }),
		);

		await runToInterrupt(
			agent,
			result.send("hi", { forwardedProps: { tenantId: "acme" } }),
			[approval()],
		);

		result.respondToInterrupt("int-1", "yes");
		await completeRun(agent);

		// A resume continues that turn, so the per-send override must survive
		// rather than falling back to the config default.
		expect(agent.lastRunInput?.forwardedProps).toEqual({ tenantId: "acme" });
		unmount();
	});

	it("exposes the interrupts a run finished with", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() =>
			useChat({ agent, autoResumeInterrupts: false }),
		);

		await runToInterrupt(agent, result.send("hi"), [approval()]);

		expect(result.interrupts.value).toHaveLength(1);
		expect(result.interrupts.value[0].id).toBe("int-1");
		expect(result.interrupts.value[0].message).toBe("Send the email?");
		// Mirrored from the agent rather than tracked separately.
		expect(agent.pendingInterrupts).toHaveLength(1);
		unmount();
	});

	it("responding to every interrupt auto-resumes with a resume array", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		await runToInterrupt(agent, result.send("hi"), [approval()]);
		expect(agent.runCount).toBe(1);

		result.respondToInterrupt("int-1", { approved: true });
		await completeRun(agent);

		expect(agent.runCount).toBe(2);
		expect(agent.lastRunInput?.resume).toEqual([
			{ interruptId: "int-1", status: "resolved", payload: { approved: true } },
		]);
		unmount();
	});

	it("carries a cancellation through as status 'cancelled'", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		await runToInterrupt(agent, result.send("hi"), [approval()]);

		result.cancelInterrupt("int-1");
		await completeRun(agent);

		expect(agent.lastRunInput?.resume).toEqual([
			{ interruptId: "int-1", status: "cancelled" },
		]);
		unmount();
	});

	it("waits for every open interrupt before resuming", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		await runToInterrupt(agent, result.send("hi"), [
			approval({ id: "int-1" }),
			approval({ id: "int-2" }),
		]);

		result.respondToInterrupt("int-1", "yes");
		await flush();
		// One of two addressed: resuming now would throw inside the SDK.
		expect(agent.runCount).toBe(1);

		result.respondToInterrupt("int-2", "no");
		await completeRun(agent);

		expect(agent.runCount).toBe(2);
		expect(agent.lastRunInput?.resume).toEqual([
			{ interruptId: "int-1", status: "resolved", payload: "yes" },
			{ interruptId: "int-2", status: "resolved", payload: "no" },
		]);
		unmount();
	});

	it("rejects a response to an interrupt that is not open", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		await runToInterrupt(agent, result.send("hi"), [approval()]);

		expect(() => result.respondToInterrupt("nope", 1)).toThrow(
			/No open interrupt "nope"/,
		);
		unmount();
	});

	it("rejects resume() while an interrupt is unaddressed", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() =>
			useChat({ agent, autoResumeInterrupts: false }),
		);

		await runToInterrupt(agent, result.send("hi"), [
			approval({ id: "int-1" }),
			approval({ id: "int-2" }),
		]);

		result.respondToInterrupt("int-1", "yes");
		await expect(result.resume()).rejects.toThrow(/int-2/);
		expect(agent.runCount).toBe(1);
		unmount();
	});

	it("refuses to resume an expired interrupt and says which one", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		await runToInterrupt(agent, result.send("hi"), [
			approval({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
		]);

		result.respondToInterrupt("int-1", "yes");
		await flush();

		// The auto-resume must not have run: the SDK would throw on initialize.
		expect(agent.runCount).toBe(1);
		await expect(result.resume()).rejects.toThrow(/int-1.*expired/);
		unmount();
	});

	it("clearInterrupts() unwedges a thread so send() works again", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() =>
			useChat({ agent, autoResumeInterrupts: false }),
		);

		await runToInterrupt(agent, result.send("hi"), [
			approval({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
		]);

		// Without clearing, AbstractAgent.onInitialize throws on every later run.
		await expect(result.send("again")).rejects.toThrow(/pending interrupt/);

		result.clearInterrupts();
		expect(result.interrupts.value).toEqual([]);
		expect(agent.pendingInterrupts).toEqual([]);

		const sent = result.send("again");
		await completeRun(agent);
		await expect(sent).resolves.not.toBeNull();
		unmount();
	});

	it("clears the open interrupts once a resumed run finishes", async () => {
		const agent = new MockStepwiseAgent();
		const { result, unmount } = mountComposable(() => useChat({ agent }));

		await runToInterrupt(agent, result.send("hi"), [approval()]);
		result.respondToInterrupt("int-1", "yes");
		await completeRun(agent);

		expect(result.interrupts.value).toEqual([]);

		// And a plain send() afterwards needs no resume array at all.
		const sent = result.send("next");
		await completeRun(agent);
		await sent.catch(() => {});
		expect(agent.lastRunInput?.resume).toBeUndefined();
		unmount();
	});
});
