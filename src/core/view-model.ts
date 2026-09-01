import type {
	InputContent,
	InputContentSource,
	Message,
	Role,
	ToolCall,
	ToolMessage,
	UserMessage,
} from "@ag-ui/client";
import type { ToolCallState, ToolCallTracker } from "./types";

// ---------------------------------------------------------------------------
// A renderer-agnostic timeline.
//
// This is the library's public view contract: no component library's shapes
// appear here, and every field maps to something the AG-UI protocol actually
// carries. Write an adapter for whichever component library you use on top of
// `ChatItem` — do not reach past it into `Message[]` unless you specifically
// need the raw protocol.
// ---------------------------------------------------------------------------

export type FileKind = "image" | "audio" | "video" | "document";

export type ChatPart =
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
			/** Parsed arguments; `{}` when the JSON is still partial or invalid. */
			args: Record<string, unknown>;
			/** The raw argument JSON, which may be mid-stream. */
			argsRaw: string;
			status: ToolCallState;
			output?: string;
			error?: string;
			/** Opaque provider signature for the call, when one was streamed. */
			encryptedValue?: string;
			metadata?: Record<string, unknown>;
	  }
	| {
			type: "activity";
			activityType: string;
			value: Record<string, unknown>;
	  }
	| {
			type: "file";
			kind: FileKind;
			mimeType?: string;
			filename?: string;
			/**
			 * Absent only for a legacy `binary` part that carries just an `id`,
			 * whose bytes live server-side and have to be resolved out of band.
			 */
			source?: InputContentSource;
			/** The legacy `binary` reference id, when that is all there is. */
			id?: string;
	  };

export interface ChatItem {
	id: string;
	role: Role;
	parts: ChatPart[];
	subagentRunId?: string;
	metadata?: Record<string, unknown>;
}

function parseArgs(raw: string): Record<string, unknown> {
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		// Arguments stream in as deltas, so partial JSON is normal mid-run.
		return {};
	}
}

function toolCallPart(
	toolCall: ToolCall,
	tracker: ToolCallTracker | undefined,
): Extract<ChatPart, { type: "tool-call" }> {
	const argsRaw = tracker?.args ?? toolCall.function.arguments ?? "";
	return {
		type: "tool-call",
		toolCallId: toolCall.id,
		toolName: toolCall.function.name,
		args: parseArgs(argsRaw),
		argsRaw,
		// The tracker owns the states the protocol has no message for
		// (approval-requested, output-denied); absent one, the call has at least
		// finished streaming its arguments.
		status: tracker?.state ?? "input-available",
		output: tracker?.output,
		error: tracker?.error,
		encryptedValue: toolCall.encryptedValue,
		metadata: toolCall.metadata as Record<string, unknown> | undefined,
	};
}

const FILE_KINDS: Record<string, FileKind> = {
	image: "image",
	audio: "audio",
	video: "video",
	document: "document",
};

/** The legacy `binary` part names no modality, so derive one from its MIME type. */
function kindFromMimeType(mimeType: string): FileKind {
	const [top] = mimeType.split("/");
	return FILE_KINDS[top ?? ""] ?? "document";
}

function userContentParts(content: UserMessage["content"]): ChatPart[] {
	if (typeof content === "string") {
		return content ? [{ type: "text", text: content }] : [];
	}

	const parts: ChatPart[] = [];
	for (const item of content as InputContent[]) {
		if (item.type === "text") {
			parts.push({ type: "text", text: item.text });
			continue;
		}

		if (item.type === "binary") {
			// Pre-0.0.59 shape: one `binary` arm instead of image/audio/video/
			// document, with the payload inline rather than under `source`.
			const binary = item as {
				mimeType: string;
				id?: string;
				url?: string;
				data?: string;
				filename?: string;
			};
			const source: InputContentSource | undefined = binary.url
				? { type: "url", value: binary.url, mimeType: binary.mimeType }
				: binary.data
					? { type: "data", value: binary.data, mimeType: binary.mimeType }
					: undefined;
			parts.push({
				type: "file",
				kind: kindFromMimeType(binary.mimeType),
				mimeType: binary.mimeType,
				filename: binary.filename,
				source,
				id: source ? undefined : binary.id,
			});
			continue;
		}

		const kind = FILE_KINDS[item.type];
		if (!kind) continue;
		const source = (item as { source: InputContentSource }).source;
		parts.push({
			type: "file",
			kind,
			// The modern shape carries the MIME type on the source, not the part.
			mimeType: source.mimeType,
			source,
		});
	}
	return parts;
}

/**
 * Project the protocol's message list onto a flat, renderer-agnostic timeline.
 *
 * Pure: the same inputs always produce the same output and neither argument is
 * mutated. That is possible because the AG-UI client already materialises
 * activity, reasoning and tool-result messages into `agent.messages` — there is
 * no streaming state to accumulate here.
 *
 * Tool results are folded into the `tool-call` part that requested them, so a
 * consumer never has to correlate an orphan `role: "tool"` entry itself.
 */
export function toChatItems(
	messages: Message[],
	trackers?: Map<string, ToolCallTracker>,
): ChatItem[] {
	// Index tool results by call id so each can be merged into its parent part.
	const resultsByToolCallId = new Map<string, ToolMessage>();
	for (const message of messages) {
		if (message.role === "tool") {
			resultsByToolCallId.set(message.toolCallId, message);
		}
	}

	const items: ChatItem[] = [];

	for (const message of messages) {
		// `Message` is a discriminated union on `role`, so each arm below is
		// narrowed by the switch itself — no casts needed.
		switch (message.role) {
			case "tool":
				// Rendered as part of its parent assistant item.
				break;

			case "assistant": {
				const parts: ChatPart[] = [];

				if (message.content) {
					parts.push({ type: "text", text: message.content });
				}

				for (const toolCall of message.toolCalls ?? []) {
					const part = toolCallPart(toolCall, trackers?.get(toolCall.id));
					const result = resultsByToolCallId.get(toolCall.id);

					if (result) {
						// A result the backend produced has no tracker entry, so the
						// message is the only evidence the call finished.
						part.output = result.error ? part.output : result.content;
						part.error = result.error ?? part.error;
						part.encryptedValue = result.encryptedValue ?? part.encryptedValue;
						if (part.status === "input-available") {
							part.status = result.error ? "output-error" : "output-available";
						}
					}

					parts.push(part);
				}

				items.push({
					id: message.id,
					role: "assistant",
					parts,
					subagentRunId: message.subagentRunId,
					metadata: message.metadata as ChatItem["metadata"],
				});
				break;
			}

			case "user":
				items.push({
					id: message.id,
					role: "user",
					parts: userContentParts(message.content),
					subagentRunId: message.subagentRunId,
					metadata: message.metadata as ChatItem["metadata"],
				});
				break;

			case "reasoning":
				items.push({
					id: message.id,
					role: "reasoning",
					parts: [
						{
							type: "reasoning",
							id: message.id,
							text: message.content,
							encryptedValue: message.encryptedValue,
							// A materialised reasoning message is complete; live
							// streaming is signalled by `useChat().isReasoning`.
							streaming: false,
						},
					],
					subagentRunId: message.subagentRunId,
					metadata: message.metadata as ChatItem["metadata"],
				});
				break;

			case "activity":
				items.push({
					id: message.id,
					role: "activity",
					parts: [
						{
							type: "activity",
							activityType: message.activityType,
							value: (message.content ?? {}) as Record<string, unknown>,
						},
					],
					subagentRunId: message.subagentRunId,
					metadata: message.metadata as ChatItem["metadata"],
				});
				break;

			default:
				// developer / system — plain text, kept in the timeline so hosts can
				// choose to show or hide them rather than having them dropped here.
				items.push({
					id: message.id,
					role: message.role,
					parts: message.content
						? [{ type: "text", text: message.content }]
						: [],
					subagentRunId: message.subagentRunId,
					metadata: message.metadata as ChatItem["metadata"],
				});
				break;
		}
	}

	return items;
}
