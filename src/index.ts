// Plugin & Provider
export { createAGUI } from "./plugin";
export type { CreateAGUIOptions } from "./plugin";
export { useProvideAGUI, useAGUI } from "./provider";

// Composables
export { useAgent } from "./composables/useAgent";
export { useChat } from "./composables/useChat";
export { useAgentState } from "./composables/useAgentState";
export { useFrontendTool } from "./composables/useFrontendTool";
export { useAgentContext } from "./composables/useAgentContext";
export { useAgentCapabilities } from "./composables/useAgentCapabilities";

// Vue provide/inject wiring
export { CHAT_REGISTRIES_KEY, AGUI_INJECTION_KEY } from "./keys";
export type { ChatRegistries, AGUIDefaults, AGUIProviderState } from "./keys";

// How a composable is told which agent to talk to
export { isExternalAgentSource, isHttpAgentSource } from "./config";
export type {
	AgentSource,
	ExternalAgentSource,
	HttpAgentSource,
	RegisteredAgentSource,
} from "./config";

// Types
export type {
	FrontendTool,
	FrontendToolFollowUp,
	FrontendToolHandlerContext,
	FrontendToolRegistry,
	ContextRegistry,
	ToolCallState,
	ToolCallTracker,
	PendingToolCall,
	StepRecord,
	SubagentRecord,
} from "./core/types";

export { WILDCARD_TOOL_NAME } from "./core/types";

export type {
	ChatStatus,
	SendOptions,
	UseChatConfig,
	UseChatOptions,
	UseChatReturn,
} from "./composables/useChat";
export type {
	UseAgentConfig,
	UseAgentOptions,
	UseAgentReturn,
} from "./composables/useAgent";
export type {
	UseAgentStateOptions,
	UseAgentStateReturn,
} from "./composables/useAgentState";
export type {
	UseFrontendToolOptions,
	UseFrontendToolReturn,
} from "./composables/useFrontendTool";
export type {
	UseAgentContextOptions,
	UseAgentContextReturn,
} from "./composables/useAgentContext";
export type {
	UseAgentCapabilitiesOptions,
	UseAgentCapabilitiesReturn,
} from "./composables/useAgentCapabilities";

export { MAX_FOLLOW_UP_DEPTH } from "./core/tool-executor";

// Renderer-agnostic view model — the contract component adapters build on
export { toChatItems } from "./core/view-model";
export type { ChatItem, ChatPart, FileKind } from "./core/view-model";

// Re-export commonly used AG-UI protocol types. Everything comes from
// @ag-ui/client, which re-exports all of @ag-ui/core — importing from both
// risks two copies of EventType and failing instanceof checks.
export type {
	Message,
	AssistantMessage,
	UserMessage,
	ToolMessage,
	ActivityMessage,
	ReasoningMessage,
	Role,
	ToolCall,
	Tool,
	Context,
	RunAgentInput,
	State,
	InputContent,
	InputContentSource,
	Interrupt,
	ResumeEntry,
	AgentCapabilities,
	RunFinishedOutcome,
	TokenUsage,
} from "@ag-ui/client";

// Protocol helpers for interrupts, re-exported so a consumer building its own
// resume flow does not need a second import path.
export {
	buildResumeArray,
	isInterruptExpired,
	getRunOutcome,
} from "@ag-ui/client";

export { EventType } from "@ag-ui/client";
export { HttpAgent, AbstractAgent } from "@ag-ui/client";
export type {
	RunAgentResult,
	AgentSubscriber,
	AgentDebugConfig,
	Middleware,
} from "@ag-ui/client";
