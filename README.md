# @synoped/ag-ui-vue

Vue 3 composables for the [AG-UI](https://docs.ag-ui.com) protocol. Connect your Vue app to any AG-UI compatible AI agent with reactive messages, streaming, frontend tool execution, and human-in-the-loop confirmation.

## Install

```bash
npm install @synoped/ag-ui-vue vue
```

`vue` >= 3.5 is a peer dependency.

## Quick Start

The fastest way to get a chat working:

```vue
<script setup lang="ts">
import { ref } from "vue";
import { useChat } from "@synoped/ag-ui-vue";

const { items, status, send } = useChat({
	url: "http://localhost:8000",
});

const input = ref("");

async function handleSend() {
	const text = input.value.trim();
	if (!text) return;
	input.value = "";
	await send(text);
}
</script>

<template>
	<div v-for="item in items" :key="item.id">
		<strong>{{ item.role }}:</strong>
		<template v-for="(part, i) in item.parts" :key="i">
			<span v-if="part.type === 'text'">{{ part.text }}</span>
		</template>
	</div>
	<input v-model="input" @keydown.enter="handleSend" />
	<button @click="handleSend" :disabled="status !== 'ready'">Send</button>
</template>
```

That's it. `useChat` handles the connection, message state, and streaming for
you. `items` is the timeline to render; `messages` is there too if you want the
raw protocol messages.

---

## API

### `useChat` — High-Level Chat

The main composable. Manages messages, status, tool execution, and confirmation in one call.

```ts
const {
	// Reading the conversation
	messages, // ShallowRef<Message[]> — raw protocol messages
	items, // ComputedRef<ChatItem[]> — the timeline you render
	status, // Ref<'ready' | 'submitted' | 'streaming' | 'error'>
	error, // ShallowRef<Error | null>
	state, // ShallowRef<State> — shared agent state
	isRunning, // ComputedRef<boolean> — mirrors agent.isRunning
	isReasoning, // ShallowRef<boolean> — model is thinking
	threadId, // ComputedRef<string>
	steps, // ShallowRef<StepRecord[]> — progress within the run
	subagents, // ShallowRef<Map<string, SubagentRecord>>
	usage, // ShallowRef<TokenUsage[]> — what the last run cost

	// Running a turn
	send, // (content, opts?) => Promise<RunAgentResult | null>
	stop, // () => void — cancel the current run
	connect, // () => Promise<RunAgentResult | null>

	// Frontend tool confirmation (this library's own gate)
	toolCallTrackers, // ShallowRef<Map<string, ToolCallTracker>>
	pendingToolCalls, // ComputedRef<PendingToolCall[]>
	approve, // (toolCallId: string) => void
	reject, // (toolCallId: string, reason?: string) => void

	// Interrupts (the protocol's own human-in-the-loop path)
	interrupts, // ShallowRef<Interrupt[]>
	respondToInterrupt, // (interruptId: string, payload?: unknown) => void
	cancelInterrupt, // (interruptId: string) => void
	resume, // () => Promise<RunAgentResult | null>
	clearInterrupts, // () => void

	// Transcript management
	setMessages, // (messages: Message[]) => void
	appendMessage, // (message: Message) => void
	clear, // () => void
	reload, // () => Promise<RunAgentResult | null>

	agent, // the underlying AbstractAgent instance
} = useChat(options);
```

`send()` resolves with the run result, `null` if you cancelled it via `stop()`, and rejects if the
run genuinely failed — so you can `await` it and `catch` it. Calling `send()` while a run is in
flight rejects rather than interleaving two runs.

#### Options

`useChat` needs to know which agent to talk to. There are three ways to say it, and they are
mutually exclusive.

**Bring your own agent** — any `AbstractAgent`. This is how you use a LangGraph, Mastra, Pydantic AI,
CrewAI, ADK or A2A integration, a custom transport, or a test double:

```ts
import { HttpAgent } from "@ag-ui/client";

const agent = new MyLangGraphAgent({ ... });
useChat({ agent });
```

**Let the library build an `HttpAgent`** for a plain AG-UI HTTP endpoint:

```ts
useChat({
	url: "http://localhost:8000", // required for this form
	headers: { Authorization: "..." }, // optional — plain, ref, or getter
	fetch: myFetch, // optional — custom fetch (auth refresh, retries)
	threadId: "thread-123", // optional — resume a conversation
	agentId: "support", // optional — agent identity
	description: "Support agent", // optional
	initialMessages: [], // optional — seed messages
	initialState: {}, // optional — seed state
	debug: true, // optional — boolean or { events, lifecycle, verbose }
});
```

**Resolve a named agent from the provider** (see [Plugin / Provider](#plugin--provider--app-level-defaults)):

```ts
useChat({ agentId: "support" });
```

Any form also accepts:

```ts
useChat({
	/* one of the three forms above */
	middleware: [myMiddleware], // optional — AG-UI client middleware
	forwardedProps: { userId: "abc" }, // optional — extra data sent on every run,
	//            including tool follow-up runs
	throttleMs: 50, // optional — coalesce stream updates
	autoResumeInterrupts: true, // optional — default; see Interrupts
	onError: (err) => {}, // optional — error callback
	onFinish: (result) => {}, // optional — run complete callback
	onCustomEvent: (event) => {}, // optional — custom event handler
	onRawEvent: (event) => {}, // optional — raw event handler
});
```

#### Reactive connection options

`headers` and `threadId` accept a ref or a getter. When one changes the same
agent instance is reconfigured — it is not rebuilt, so subscribers and the
transcript survive:

```ts
const token = ref(await getToken());
const threadId = ref(route.params.threadId as string);

const chat = useChat({
	url: "http://localhost:8000",
	headers: () => ({ Authorization: `Bearer ${token.value}` }),
	threadId,
});

// Switching threads deliberately leaves the transcript alone. Empty it yourself
// if that is what you want:
watch(threadId, () => chat.clear());

// `chat.threadId` follows the switch immediately, so it is safe to key a
// component off it.
```

#### Stream update coalescing

A streaming run emits an event per token. `throttleMs` collapses those into one
update per window; the default (`0`) still batches within a microtask, so you
never render once per token. Set a provider-wide default with
`createAGUI({ defaults: { throttleMs: 50 } })`.

#### Status Lifecycle

```
ready → submitted → streaming → ready
                  ↘ error
```

- **ready** — idle, can send a message
- **submitted** — message sent, waiting for the first response
- **streaming** — receiving text, reasoning, or tool call data
- **error** — something went wrong (check `error.value`)

A `RUN_ERROR` from the backend leaves `status` at `error` and does not call `onFinish`. Cancelling
with `stop()` returns to `ready` — a deliberate cancellation is not an error.

---

### `useAgent` — Low-Level Agent Access

If you need full control over the agent without the chat layer:

```ts
import { useAgent } from "@synoped/ag-ui-vue";

const {
	agent, // AbstractAgent — call agent.runAgent() yourself
	messages, // ShallowRef<Message[]>
	state, // ShallowRef<State>
	isRunning, // ComputedRef<boolean>
	threadId, // ComputedRef<string>
	isReasoning, // ShallowRef<boolean>
	toolCallTrackers, // ShallowRef<Map<string, ToolCallTracker>>
	steps, // ShallowRef<StepRecord[]>
	subagents, // ShallowRef<Map<string, SubagentRecord>>
	interrupts, // ShallowRef<Interrupt[]>
	usage, // ShallowRef<TokenUsage[]>
	trackerStore, // tool-call tracker store
} = useAgent({ url: "http://localhost:8000" });
// ...or useAgent({ agent }) / useAgent({ agentId: "support" })

// Run manually
await agent.runAgent({
	tools: [{ name: "search", description: "Search the web", parameters: {} }],
	context: [],
});
```

---

### `useFrontendTool` — Register Browser-Side Tools

Let the agent call functions that run in the browser. Registered tools are
automatically included in every run and cleaned up when the scope is disposed.

```vue
<script setup lang="ts">
import { useChat, useFrontendTool } from "@synoped/ag-ui-vue";

const chat = useChat({ url: "http://localhost:8000" });

useFrontendTool({
	tool: {
		name: "get_location",
		description: "Get the user's current city",
		parameters: {
			type: "object",
			properties: {
				format: { type: "string", enum: ["city", "full"] },
			},
		},
		// Return any serialisable value — objects are JSON-encoded for you.
		handler: async () => ({ city: "Toronto", country: "Canada" }),
	},
	chat,
});
</script>
```

When the agent calls `get_location`, the handler runs locally, the result is
inserted directly after the assistant message that requested it, and the agent
runs again with it.

Only `name` and `handler` are required. `description` and `parameters` are
optional — a no-argument tool needs neither.

#### The handler's second argument

```ts
handler: async (args, { toolCall, agent, signal }) => {
	// toolCall — the call being handled, including its id and raw argument JSON
	// agent    — the AbstractAgent running this turn
	// signal   — aborted when stop() is called, so a slow handler can bail out
	const res = await fetch("/api/search", {
		signal,
		body: JSON.stringify(args),
	});
	return res.json();
};
```

#### Controlling the follow-up run

By default a successful handler triggers another agent run so the model can use
the result. `followUp` changes that:

```ts
useFrontendTool({
	tool: {
		name: "highlight_row",
		handler: (args) => highlight(args.id as string),
		// The tool changed the UI; there is nothing for the model to say about it.
		followUp: false,
	},
	chat,
});

useFrontendTool({
	tool: {
		name: "fetch_document",
		handler: async (args) => loadDocument(args.id as string),
		// Insert this as a user message, then run again.
		followUp: "Summarise the document in one sentence.",
	},
	chat,
});
```

A run where a handler **threw**, or where every call was **denied**, never
follows up.

#### Reactive tools

Pass a getter to keep the registration in sync with component state. Anything
the getter reads is tracked: a schema built from props, a handler closing over a
ref, or `available` gating whether the agent is told about the tool at all.

```vue
<script setup lang="ts">
import { ref } from "vue";
import { useChat, useFrontendTool } from "@synoped/ag-ui-vue";

const chat = useChat({ url: "http://localhost:8000" });
const canEdit = ref(false);
const documentId = ref("doc-1");

useFrontendTool({
	tool: () => ({
		name: "save_document",
		description: `Save document ${documentId.value}`,
		handler: async (args) => save(documentId.value, args),
		// While false, the tool is neither advertised nor executed.
		available: canEdit.value,
	}),
	chat,
});
</script>
```

#### A catch-all tool

Registering the name `"*"` handles every call no other tool matches — useful for
generative UI, where the backend names tools the frontend has never heard of. A
wildcard is never advertised to the agent.

```ts
import { WILDCARD_TOOL_NAME } from "@synoped/ag-ui-vue";

useFrontendTool({
	tool: {
		name: WILDCARD_TOOL_NAME,
		handler: (args, { toolCall }) => {
			renderGenerativeComponent(toolCall.function.name, args);
			return "rendered";
		},
		followUp: false,
	},
	chat,
});
```

#### Tools with confirmation

Add `requireConfirmation: true` to pause and ask the user before executing:

```vue
<script setup lang="ts">
import { useChat, useFrontendTool } from "@synoped/ag-ui-vue";

const chat = useChat({ url: "http://localhost:8000" });
const { pendingToolCalls, approve, reject } = chat;

useFrontendTool({
	tool: {
		name: "delete_file",
		description: "Delete a file from the user's workspace",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
		},
		requireConfirmation: true,
		handler: async (args) => {
			// only runs after the user approves
			await deleteFile(args.path as string);
			return "File deleted";
		},
	},
	chat,
});
</script>

<template>
	<div v-for="tc in pendingToolCalls" :key="tc.toolCallId">
		<p>
			Agent wants to run <strong>{{ tc.toolName }}</strong>
		</p>
		<pre>{{ JSON.stringify(tc.args, null, 2) }}</pre>
		<button @click="approve(tc.toolCallId)">Allow</button>
		<button @click="reject(tc.toolCallId, 'Not allowed')">Deny</button>
	</div>
</template>
```

The reason you pass to `reject()` is what the model is told. This gate is
client-side; for approvals the _backend_ asks for, see
[Interrupts](#interrupts--the-protocols-human-in-the-loop-path).

---

### `useAgentContext` — Send Context to the Agent

Provide extra context that gets included with every agent run. Cleaned up when
the scope is disposed.

```vue
<script setup lang="ts">
import { useChat, useAgentContext } from "@synoped/ag-ui-vue";

const chat = useChat({ url: "http://localhost:8000" });

useAgentContext({
	context: {
		description: "Current page info",
		value: JSON.stringify({ route: "/dashboard" }),
	},
	chat,
});
</script>
```

Pass a getter to keep it in sync with the UI. The entry is updated in place, so
a changing value never accumulates duplicates:

```vue
<script setup lang="ts">
import { ref } from "vue";
import { useChat, useAgentContext } from "@synoped/ag-ui-vue";

const chat = useChat({ url: "http://localhost:8000" });
const selectedIds = ref<number[]>([]);

useAgentContext({
	context: () => ({
		description: "Rows the user has selected",
		value: JSON.stringify(selectedIds.value),
	}),
	chat,
});
</script>
```

---

### `useAgentState` — Typed Shared State

Read and write shared state between your app and the agent with type safety:

```vue
<script setup lang="ts">
import { useChat, useAgentState } from "@synoped/ag-ui-vue";

interface AppState {
	counter: number;
	theme: "light" | "dark";
}

const chat = useChat({
	url: "http://localhost:8000",
	initialState: { counter: 0, theme: "light" },
});

const { state, setState } = useAgentState<AppState>({
	state: chat.state,
	agent: chat.agent,
});

function increment() {
	setState({ ...state.value, counter: state.value.counter + 1 });
}
</script>

<template>
	<p>Counter: {{ state.counter }}</p>
	<button @click="increment">+1</button>
</template>
```

The agent can also update this state from its side. Changes flow both ways.

---

### Interrupts — the Protocol's Human-in-the-Loop Path

An AG-UI agent can end a run _paused_, asking the client a question. Until every
open interrupt is answered the agent refuses to start another run, so handling
them is not optional: a thread with an unaddressed interrupt is stuck.

```vue
<script setup lang="ts">
import { useChat } from "@synoped/ag-ui-vue";

const { items, interrupts, respondToInterrupt, cancelInterrupt, send } =
	useChat({ url: "http://localhost:8000" });
</script>

<template>
	<div v-for="interrupt in interrupts" :key="interrupt.id" class="interrupt">
		<p>{{ interrupt.message ?? interrupt.reason }}</p>
		<button @click="respondToInterrupt(interrupt.id, { approved: true })">
			Approve
		</button>
		<button @click="respondToInterrupt(interrupt.id, { approved: false })">
			Decline
		</button>
		<button @click="cancelInterrupt(interrupt.id)">Cancel</button>
	</div>
</template>
```

Once every open interrupt has a response, the run resumes automatically. To
batch the responses and resume yourself, pass
`autoResumeInterrupts: false` and call `resume()`:

```ts
const chat = useChat({ url: "...", autoResumeInterrupts: false });

chat.respondToInterrupt("int-1", { approved: true });
chat.respondToInterrupt("int-2", { approved: true });
await chat.resume();
```

`resume()` rejects if an interrupt is still unaddressed, or if one carried an
`expiresAt` that has passed. An expired approval cannot be answered at all, and
the agent will refuse every future run — `clearInterrupts()` abandons them so
the thread becomes usable again:

```ts
try {
	await chat.resume();
} catch (err) {
	chat.clearInterrupts(); // give up on the paused run
	await chat.send("Let's try that again.");
}
```

Each `Interrupt` carries `id`, `reason`, and optionally `message`,
`responseSchema` (JSON Schema for what the agent expects back), `expiresAt`,
`toolCallId` and `subagentRunId` — enough to render an approval dialog without
knowing anything about the specific agent.

**Interrupts vs. `requireConfirmation`.** Interrupts are the _backend_ asking;
`requireConfirmation` is _this library_ gating a frontend tool before it runs.
Use interrupts when the agent decides an approval is needed, and
`requireConfirmation` when the browser-side action itself is the risk.

---

### Transcript Management

```ts
const { setMessages, appendMessage, clear, reload } = useChat({ url: "..." });

setMessages(await loadThreadFromDatabase(id)); // rehydrate a saved thread
appendMessage({ id: crypto.randomUUID(), role: "assistant", content: "Hi!" });
clear(); // empty it, keep the thread
await reload(); // regenerate the last answer
```

`reload()` drops everything after the last user message — the assistant turn,
its tool results, its reasoning — and runs that message again. It rejects if the
transcript has no user message to re-run.

---

### Multimodal Input

`send()` takes protocol `InputContent[]` as well as a string:

```vue
<script setup lang="ts">
import { ref } from "vue";
import { useChat, type InputContent } from "@synoped/ag-ui-vue";

const { send, items } = useChat({ url: "http://localhost:8000" });
const text = ref("");
const file = ref<File | null>(null);

async function toDataUrl(f: File): Promise<string> {
	return new Promise((resolve) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.readAsDataURL(f);
	});
}

async function handleSend() {
	const content: InputContent[] = [{ type: "text", text: text.value }];

	if (file.value) {
		content.push({
			type: "image",
			source: {
				type: "data",
				value: await toDataUrl(file.value),
				mimeType: file.value.type,
			},
		});
	}

	text.value = "";
	file.value = null;
	await send(content);
}
</script>

<template>
	<input v-model="text" />
	<input
		type="file"
		@change="file = ($event.target as HTMLInputElement).files?.[0] ?? null"
	/>
	<button @click="handleSend">Send</button>
</template>
```

Those parts come back out as `file` parts on `items` (see below), so the
attachment renders in the transcript alongside the text.

---

### Steps and Subagents

Steps and subagents are the one part of the protocol with no message to live on,
so they are exposed as their own reactive state:

```vue
<script setup lang="ts">
import { useChat } from "@synoped/ag-ui-vue";

const { steps, subagents, items } = useChat({ url: "http://localhost:8000" });
</script>

<template>
	<ol class="progress">
		<li v-for="(step, i) in steps" :key="i">
			{{ step.name }} — {{ step.status }}
		</li>
	</ol>

	<ul class="subagents">
		<li v-for="[id, sub] of subagents" :key="id">
			{{ sub.name }} — {{ sub.status }}
		</li>
	</ul>

	<!-- Group the timeline by subagent: reasoning, activity and tool messages
       all carry the subagentRunId that produced them. -->
	<div v-for="item in items" :key="item.id" :data-subagent="item.subagentRunId">
		<!-- ... -->
	</div>
</template>
```

`steps` resets at the start of each run. A subagent's status distinguishes
`running`, `finished`, `error`, and `suspended` — suspended means it paused on an
interrupt and the same id will resume later, so it must not be rendered as done.
A suspended record also carries `interruptIds`, naming which of `interrupts` it
is waiting on (absent when it suspended because a _descendant_ interrupted), and
an errored one carries the agent's `errorCode` alongside `error`.

---

### Token Usage

A run may report what it cost, per `(provider, model)` pair — an array, because
one run can invoke several models:

```vue
<script setup lang="ts">
import { computed } from "vue";
import { useChat } from "@synoped/ag-ui-vue";

const { usage } = useChat({ url: "http://localhost:8000" });

const totalTokens = computed(() =>
	usage.value.reduce((sum, u) => sum + (u.totalTokens ?? 0), 0),
);
</script>

<template>
	<p v-if="usage.length">Last turn: {{ totalTokens }} tokens</p>
</template>
```

Scoped to the **most recent run**, not the whole thread: it resets when the next
run starts, so accumulate it yourself if you want a per-thread total. A run that
_failed_ still reports the tokens it had already spent, and most agents report
nothing at all — an empty array means "not reported", never "free".

---

### `useAgentCapabilities` — Feature Detection

```vue
<script setup lang="ts">
import { useChat, useAgentCapabilities } from "@synoped/ag-ui-vue";

const chat = useChat({ url: "http://localhost:8000" });
const { capabilities, isSupported } = useAgentCapabilities({
	agent: chat.agent,
});
</script>

<template>
	<input v-if="capabilities?.multimodal?.input?.image" type="file" />
</template>
```

Every field is optional in the protocol, and an omitted one means _undeclared_,
not unsupported — so treat a missing capability as unknown rather than hiding a
feature the agent may well have. `isSupported` is `false` when the agent does not
implement `getCapabilities()` at all, which is the common case.

---

### Rendering — the `ChatItem` Timeline

This library is headless: it ships no components and no component library's data shapes. What it
gives you instead is `items` — a flat, renderer-agnostic timeline you can map onto whatever
components you already use.

```ts
const { items } = useChat({ url: "http://localhost:8000" });
```

Each `ChatItem` is `{ id, role, parts, subagentRunId?, metadata? }`, where `role` is the protocol's
own role (`user | assistant | system | developer | tool | activity | reasoning`) and `parts` is an
ordered list:

```ts
type ChatPart =
	| { type: "text"; text: string }
	| {
			type: "reasoning";
			id: string;
			text: string;
			encryptedValue?: string;
			streaming: boolean;
	  }
	| {
			type: "tool-call";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			argsRaw: string;
			status: ToolCallState;
			output?: string;
			error?: string;
			encryptedValue?: string;
			metadata?: Record<string, unknown>;
	  }
	| { type: "activity"; activityType: string; value: Record<string, unknown> }
	| {
			type: "file";
			kind: "image" | "audio" | "video" | "document";
			mimeType?: string;
			filename?: string;
			source?: InputContentSource;
			id?: string;
	  };
```

Two things worth knowing:

- **Tool results are folded into the `tool-call` part that requested them.** You never have to
  correlate an orphan `role: "tool"` message with its parent yourself, and a failure arrives as a
  structured `error` field — never as an `"Error: ..."` string you have to parse.
- **`items` is a pure projection of `messages`.** `toChatItems(messages, trackers)` is exported if
  you would rather call it yourself, memoize differently, or run it outside a component.
- **A `file` part's `source` is only absent** for a legacy `binary` part carrying
  nothing but an `id`, whose bytes have to be resolved server-side.

```vue
<script setup lang="ts">
import { useChat } from "@synoped/ag-ui-vue";

const { items } = useChat({ url: "http://localhost:8000" });
</script>

<template>
	<div v-for="item in items" :key="item.id" :class="item.role">
		<template v-for="(part, i) in item.parts" :key="i">
			<p v-if="part.type === 'text'">{{ part.text }}</p>

			<details v-else-if="part.type === 'reasoning'">
				<summary>Thinking</summary>
				<pre>{{ part.text }}</pre>
			</details>

			<figure v-else-if="part.type === 'tool-call'">
				<figcaption>{{ part.toolName }} — {{ part.status }}</figcaption>
				<pre>{{ JSON.stringify(part.args, null, 2) }}</pre>
				<p v-if="part.error" class="error">{{ part.error }}</p>
				<pre v-else-if="part.output">{{ part.output }}</pre>
			</figure>

			<pre v-else-if="part.type === 'activity'"
				>{{ part.activityType }}: {{ JSON.stringify(part.value) }}</pre>

			<img
				v-else-if="part.type === 'file' && part.kind === 'image' && part.source"
				:src="part.source.value"
				:alt="part.filename ?? ''"
			/>
		</template>
	</div>
</template>
```

That is the whole rendering contract — no component library involved. Swap the
plain elements for your own components when you want to.

#### Writing an adapter for your component library

An adapter is a plain function from `ChatItem[]` to whatever your components want. Nothing in this
package needs to know about it. For example, to feed components that expect Vercel AI SDK
`UIMessage` shapes (ai-elements-vue and friends), roughly 40 lines does it:

```ts
import type { ChatItem } from "@synoped/ag-ui-vue";

// Shape the components you use expect — define it in your app, not here.
interface UIMessage {
	id: string;
	role: "user" | "assistant" | "system" | "data";
	content: string;
	parts: Array<Record<string, unknown>>;
}

const ROLE_MAP: Record<string, UIMessage["role"]> = {
	user: "user",
	assistant: "assistant",
	reasoning: "assistant",
	system: "system",
	developer: "system",
	activity: "data",
	tool: "data",
};

export function toUIMessages(items: ChatItem[]): UIMessage[] {
	return items.map((item) => ({
		id: item.id,
		role: ROLE_MAP[item.role] ?? "data",
		content: item.parts
			.filter((p) => p.type === "text")
			.map((p) => (p as { text: string }).text)
			.join(""),
		parts: item.parts.map((part) => {
			switch (part.type) {
				case "text":
					return { type: "text", text: part.text };
				case "reasoning":
					return { type: "reasoning", reasoning: part.text };
				case "tool-call":
					return {
						type: "tool-invocation",
						toolInvocation: {
							toolCallId: part.toolCallId,
							toolName: part.toolName,
							state: part.status,
							args: part.args,
							result: part.output,
							error: part.error,
						},
					};
				default:
					return { type: "data", data: part };
			}
		}),
	}));
}
```

Then in your component:

```ts
const chat = useChat({ url: "http://localhost:8000" });
const uiMessages = computed(() => toUIMessages(chat.items.value));
```

The same pattern works for PrimeVue, Nuxt UI, shadcn-vue, or your own components — map the parts you
care about and ignore the rest.

---

### Plugin / Provider — App-Level Defaults

The provider does two things: it holds options merged underneath every `useChat`/`useAgent` call, and
it holds a registry of named agents you can resolve by id. It is entirely optional — `useChat` takes
its configuration directly.

#### Option A: Vue plugin

```ts
// main.ts
import { createApp } from "vue";
import { createAGUI } from "@synoped/ag-ui-vue";
import App from "./App.vue";

createApp(App)
	.use(
		createAGUI({
			defaults: {
				headers: { Authorization: `Bearer ${token}` },
				fetch: myFetch,
				debug: import.meta.env.DEV,
				middleware: [myMiddleware],
			},
			agents: {
				support: { url: "http://localhost:8000" },
				research: { agent: myLangGraphAgent },
			},
		}),
	)
	.mount("#app");
```

#### Option B: Composable provider

```ts
// App.vue
import { useProvideAGUI } from "@synoped/ag-ui-vue";

useProvideAGUI({
	defaults: { headers: { Authorization: `Bearer ${token}` } },
	agents: { support: { url: "http://localhost:8000" } },
});
```

Either way, descendants resolve an agent by name and inherit the defaults:

```ts
const chat = useChat({ agentId: "support" });
```

An explicit local option always wins over a provider default, so
`useChat({ url: "...", headers: { ... } })` overrides `defaults.headers` rather than merging into it.
`useAGUI()` returns the provider state, or `undefined` when there is no provider.

---

## Full Example: Plain Vue 3

One `<script setup>` component, no component library, no build-time helpers —
tools, confirmation, interrupts and the rendered timeline.

```vue
<script setup lang="ts">
import { ref } from "vue";
import { useChat, useFrontendTool, useAgentContext } from "@synoped/ag-ui-vue";

const chat = useChat({ url: "http://localhost:8000" });
const {
	items,
	status,
	error,
	send,
	stop,
	pendingToolCalls,
	approve,
	reject,
	interrupts,
	respondToInterrupt,
} = chat;

const input = ref("");

// A tool that runs in the browser. Return a value — no JSON.stringify needed.
useFrontendTool({
	tool: {
		name: "get_weather",
		description: "Get current weather for a city",
		parameters: {
			type: "object",
			properties: { city: { type: "string" } },
			required: ["city"],
		},
		handler: async (args, { signal }) => {
			const res = await fetch(`/api/weather?city=${args.city}`, { signal });
			return res.json();
		},
	},
	chat,
});

// A tool the user must approve first.
useFrontendTool({
	tool: {
		name: "send_email",
		description: "Send an email",
		parameters: {
			type: "object",
			properties: {
				to: { type: "string" },
				subject: { type: "string" },
				body: { type: "string" },
			},
		},
		requireConfirmation: true,
		handler: async (args) => {
			await api.sendEmail(args);
			return "Email sent";
		},
	},
	chat,
});

// Context that follows the UI.
useAgentContext({
	context: () => ({
		description: "Signed-in user",
		value: JSON.stringify({ name: "Alice", plan: "pro" }),
	}),
	chat,
});

async function handleSend() {
	const text = input.value.trim();
	if (!text) return;
	input.value = "";
	// Resolves with the run result, or null if you called stop().
	await send(text);
}
</script>

<template>
	<div class="chat">
		<!-- The timeline -->
		<div v-for="item in items" :key="item.id" :class="item.role">
			<template v-for="(part, i) in item.parts" :key="i">
				<p v-if="part.type === 'text'">{{ part.text }}</p>

				<details v-else-if="part.type === 'reasoning'">
					<summary>Thinking</summary>
					<pre>{{ part.text }}</pre>
				</details>

				<figure v-else-if="part.type === 'tool-call'">
					<figcaption>{{ part.toolName }} — {{ part.status }}</figcaption>
					<p v-if="part.error" class="error">{{ part.error }}</p>
					<pre v-else-if="part.output">{{ part.output }}</pre>
				</figure>
			</template>
		</div>

		<!-- Frontend tools awaiting approval -->
		<div
			v-for="tc in pendingToolCalls"
			:key="tc.toolCallId"
			class="confirmation"
		>
			<p>
				Agent wants to call <strong>{{ tc.toolName }}</strong>
			</p>
			<pre>{{ JSON.stringify(tc.args, null, 2) }}</pre>
			<button @click="approve(tc.toolCallId)">Approve</button>
			<button @click="reject(tc.toolCallId, 'Not this time')">Reject</button>
		</div>

		<!-- Approvals the backend asked for -->
		<div
			v-for="interrupt in interrupts"
			:key="interrupt.id"
			class="confirmation"
		>
			<p>{{ interrupt.message ?? interrupt.reason }}</p>
			<button @click="respondToInterrupt(interrupt.id, { approved: true })">
				Yes
			</button>
			<button @click="respondToInterrupt(interrupt.id, { approved: false })">
				No
			</button>
		</div>

		<p v-if="error" class="error">{{ error.message }}</p>

		<div class="input-row">
			<input
				v-model="input"
				@keydown.enter="handleSend"
				placeholder="Type a message..."
				:disabled="status !== 'ready'"
			/>
			<button v-if="status === 'ready'" @click="handleSend">Send</button>
			<button v-else @click="stop()">Stop</button>
		</div>
	</div>
</template>
```

---

## How Tool Execution Works

When you register a frontend tool and the agent decides to call it, this happens automatically:

1. **Agent requests tool call** — the backend streams a tool call event
2. **Args stream in** — tracked in `toolCallTrackers` with state `input-streaming` → `input-available`
3. **Handler resolved** — the exactly-named tool, else a `"*"` wildcard. A tool with
   `available: false` resolves to nothing, and the call is left for the backend
4. **Confirmation check** — if `requireConfirmation` is set, execution pauses. The tool appears in `pendingToolCalls`. Your UI calls `approve()` or `reject()`
5. **Handler runs** — in the browser, receiving `(args, { toolCall, agent, signal })`.
   Whatever it returns is serialised; a non-string is JSON-encoded
6. **Result inserted** — a tool message is placed directly after the assistant message that
   requested it (and after any results already inserted for earlier calls in the same batch), which
   is the ordering providers such as OpenAI require. A failure sets the protocol's
   `ToolMessage.error` field rather than encoding it in the text
7. **Follow-up run** — the agent re-runs with the result, carrying the same `forwardedProps` as the
   original `send()`. A run where a handler threw, or where every call was denied, does **not**
   follow up, and neither does one where every successful tool set `followUp: false`. A string
   `followUp` is inserted as a user message first
8. **Repeat** — the cycle continues until no more frontend tools are needed, capped at
   `MAX_FOLLOW_UP_DEPTH` (100) so a model that keeps re-calling the same tool cannot loop forever

A tool call the backend already answered itself is not re-executed locally.

---

## Types

```ts
interface FrontendTool {
	name: string; // "*" registers a catch-all
	description?: string;
	parameters?: Record<string, unknown>; // JSON Schema
	handler: (
		args: Record<string, unknown>,
		context: FrontendToolHandlerContext,
	) => unknown; // non-strings are JSON-encoded
	requireConfirmation?: boolean;
	followUp?: false | "generate" | string; // default "generate"
	available?: boolean; // default true
	metadata?: Record<string, unknown>; // forwarded as Tool.metadata
}

interface FrontendToolHandlerContext {
	toolCall: ToolCall;
	agent: AbstractAgent;
	signal?: AbortSignal; // aborted by stop()
}

type ToolCallState =
	| "input-streaming" // args are being received
	| "input-available" // args complete, ready to execute
	| "approval-requested" // waiting for user confirmation
	| "approval-responded" // user responded, executing
	| "output-available" // handler returned successfully
	| "output-error" // handler threw an error
	| "output-denied"; // user rejected the tool call

interface ToolCallTracker {
	toolCallId: string;
	toolName: string;
	args: string; // raw JSON string
	state: ToolCallState;
	output?: string;
	error?: string;
}

interface PendingToolCall {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>; // parsed
	state: ToolCallState;
}

// How you name the agent — exactly one of the three forms.
type AgentSource =
	ExternalAgentSource | HttpAgentSource | RegisteredAgentSource;

interface ExternalAgentSource {
	agent: AbstractAgent;
	middleware?: Middleware[];
}

interface HttpAgentSource {
	url: string;
	headers?: MaybeRefOrGetter<Record<string, string> | undefined>;
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	agentId?: string;
	description?: string;
	threadId?: MaybeRefOrGetter<string | undefined>;
	initialMessages?: Message[];
	initialState?: State;
	debug?:
		boolean | { events?: boolean; lifecycle?: boolean; verbose?: boolean };
	middleware?: Middleware[];
}

interface RegisteredAgentSource {
	agentId: string; // resolved from the provider
	middleware?: Middleware[];
}

interface StepRecord {
	name: string;
	status: "running" | "finished";
	subagentRunId?: string;
}

interface SubagentRecord {
	subagentRunId: string;
	name: string;
	description?: string;
	parentSubagentRunId?: string;
	parentToolCallId?: string;
	parentMessageId?: string;
	status: "running" | "finished" | "suspended" | "error";
	result?: unknown;
	interruptIds?: string[]; // set when suspended on its own interrupt
	error?: string;
	errorCode?: string;
}

interface ChatItem {
	id: string;
	role: Role; // the protocol's own role union
	parts: ChatPart[];
	subagentRunId?: string;
	metadata?: Record<string, unknown>;
}
```

---

## Example Backend (Python)

The repo includes a minimal Python backend using Google ADK + AG-UI:

```python
# examples/backend/main.py
from google.adk.agents import Agent
from ag_ui_adk import ADKAgent, create_adk_app
from fastapi.middleware.cors import CORSMiddleware

adk_agent = Agent(
    name="assistant",
    model="gemini-2.0-flash",
    instruction="You are a helpful assistant.",
)

agent = ADKAgent(adk_agent=adk_agent, app_name="my-app", user_id="default-user")
app = create_adk_app(agent)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
```

```bash
# Install deps
pip install google-adk ag-ui-adk fastapi uvicorn

# Set your API key
export GOOGLE_API_KEY=your-key-here

# Run
uvicorn main:app --host 0.0.0.0 --port 8000
```

Or use Docker Compose:

```bash
docker compose --profile example up -d
```

---

## Migrating from 0.1.x

0.2.0 is a forward-facing rewrite of the public surface: removed APIs are gone rather than
deprecated, and this table is the only compatibility artifact.

| 0.1.x                                                                                | 0.2.0                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toUIMessages(messages, trackers)`                                                   | `chat.items` (or `toChatItems(messages, trackers)`). The ai-elements/Vercel shape is no longer built in — copy the ~40-line adapter from [Writing an adapter](#writing-an-adapter-for-your-component-library) |
| `toChatStatus(status)`                                                               | `chat.status` directly — it is already `ready \| submitted \| streaming \| error`                                                                                                                             |
| `toToolUIParts(toolCalls, trackers)`                                                 | the `tool-call` parts on `chat.items`, which already carry merged results                                                                                                                                     |
| `AdaptedUIMessage`, `AdaptedPart`, `AdaptedToolInvocation`                           | `ChatItem`, `ChatPart`                                                                                                                                                                                        |
| `useToolConfirmation(chat)`                                                          | `chat.pendingToolCalls` / `chat.approve` / `chat.reject` directly                                                                                                                                             |
| `chat.reasoning` (`{ isActive, content }`)                                           | `chat.isReasoning` for the indicator; reasoning text arrives as `reasoning` parts on `chat.items`, one per reasoning message                                                                                  |
| `useAgent(...).isRunning` as a `Ref`                                                 | a `ComputedRef` mirroring `agent.isRunning`                                                                                                                                                                   |
| `send()` returning `Promise<void>`, swallowing errors                                | `Promise<RunAgentResult \| null>` — `null` when cancelled, rejects on failure                                                                                                                                 |
| `AGUIConfig`                                                                         | `AgentSource` — `{ agent }`, `{ url, ... }`, or `{ agentId }`                                                                                                                                                 |
| `createAGUI({ url, ... })`                                                           | `createAGUI({ defaults, agents })`                                                                                                                                                                            |
| `useProvideAGUI({ url, ... })`                                                       | `useProvideAGUI({ defaults, agents })`                                                                                                                                                                        |
| `useAGUI()` throwing outside a provider                                              | returns `undefined`; a provider is optional                                                                                                                                                                   |
| `AGUIProviderState.{config,tools,contexts,confirmationGates,toolCallTrackers,agent}` | `AGUIProviderState.{defaults,agents}` — the removed fields were never read                                                                                                                                    |
| Tool failure encoded as `content: "Error: ..."`                                      | the protocol's `ToolMessage.error` field, surfaced as `part.error`                                                                                                                                            |
| `handler: (args) => Promise<string>`                                                 | `handler: (args, ctx) => unknown` — a second `{ toolCall, agent, signal }` argument, and any serialisable return value                                                                                        |
| `description` / `parameters` required on a tool                                      | both optional                                                                                                                                                                                                 |
| `useFrontendTool({ tool: {...} })` only                                              | `tool` also accepts a ref or getter, which re-registers reactively (this replaces the need for a `deps` option)                                                                                               |
| `useAgentContext({ context: {...} })` only                                           | `context` also accepts a ref or getter                                                                                                                                                                        |
| `chat.confirmationGates`                                                             | `chat.pendingToolCalls` with `approve`/`reject` — the gates exposed raw resolvers for the same decision                                                                                                       |
| `resolveAgent(source, provider)`                                                     | no longer exported; pass the source to `useAgent`/`useChat`, which resolves it                                                                                                                                |
| `trackerStore.snapshot()`                                                            | read `toolCallTrackers.value`, or the map every mutation returns                                                                                                                                              |
| `@ag-ui/core` in your `dependencies` alongside this package                          | only `@ag-ui/client` is needed; it re-exports all of `@ag-ui/core`                                                                                                                                            |

Behavioural changes with no API rename:

- Cleanup moved from `onUnmounted` to `onScopeDispose`, so the composables now work inside a Pinia
  store or a bare `effectScope()`. If you relied on them being no-ops outside a component, they are
  no longer.
- A tool follow-up run no longer happens when a handler threw or when every call was denied.
- Tool results are spliced after their parent assistant message instead of appended.
- `forwardedProps` now reach follow-up runs, not just the first run.
- Concurrent `send()` calls reject instead of interleaving.
- Contexts are keyed internally by a generated id rather than by `description`, so two contexts
  sharing a description no longer evict each other.
- `stop()` now calls `agent.detachActiveRun()` as well as `agent.abortRun()`, so it cancels any
  agent rather than only an `HttpAgent`. A run that never completes its stream now settles instead
  of hanging.
- A locally executed tool result is now published to `messages`/`items` as soon as it lands.
  Previously the executor spliced it into the agent's array without announcing it, so it stayed
  invisible until the next run — permanently, for a tool with `followUp: false`.
- Message and state updates are coalesced (a microtask by default, `throttleMs` for a wider
  window), so `messages.value` no longer changes identity once per streamed token.

---

## Development

This project uses Docker Compose for development:

```bash
# Start dev container
docker compose up -d ag-ui-vue

# Run tests
docker compose exec ag-ui-vue npx vitest run

# Run tests in watch mode
docker compose exec ag-ui-vue npx vitest

# Type check
docker compose exec ag-ui-vue npx vue-tsc --noEmit

# Build
docker compose exec ag-ui-vue npx vite build

# Format (prettier is the only style gate; `--check` runs in verification)
docker compose exec ag-ui-vue npx prettier --write src/
```
