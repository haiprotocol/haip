// Main client
export { HAIPClientImpl } from "./client";
export type { HAIPClient } from "./types";

// Types
export type {
  HAIPChannel,
  HAIPEventType,
  HAIPMessage,
  HAIPConnectionConfig,
  HAIPConnectionState,
  HAIPEventHandlers,
  HAIPMessageOptions,
  HAIPRun,
  HAIPPerformanceMetrics,
  HAIPLogger,
  HAIPTransport,
  HAIPTransportType,
  HAIPTransportConfig,
  HAIPHandshakePayload,
  HAIPRunStartedPayload,
  HAIPRunFinishedPayload,
  HAIPRunCancelPayload,
  HAIPRunErrorPayload,
  HAIPPingPayload,
  HAIPPongPayload,
  HAIPReplayRequestPayload,
  HAIPTextMessageStartPayload,
  HAIPTextMessagePartPayload,
  HAIPTextMessageEndPayload,
  HAIPAudioChunkPayload,
  HAIPToolCallPayload,
  HAIPToolUpdatePayload,
  HAIPToolDonePayload,
  HAIPToolCancelPayload,
  HAIPToolListPayload,
  HAIPToolSchemaPayload,
  HAIPErrorPayload,
  HAIPFlowUpdatePayload,
  HAIPChannelControlPayload,
  FlowControlConfig,
  PendingMessage,
  HAIPToolDefinition,
  HAIPToolExecution
} from "./types";

// Utilities
export { HAIPUtils } from "./utils";

// Transports
export { WebSocketTransport } from "./transports/websocket";
export { SSETransport } from "./transports/sse";
export { HTTPStreamingTransport } from "./transports/http-streaming";

// Convenience function to create client
export function createHAIPClient(config: import("./types").HAIPConnectionConfig): import("./types").HAIPClient {
  const { HAIPClientImpl } = require("./client");
  return new HAIPClientImpl(config);
} 