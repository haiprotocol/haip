export { HAIPClientImpl } from "./client";
export type { HAIPClient } from "haip";

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
    HAIPToolExecution,
} from "haip";

export { HAIPUtils } from "./utils";

export { WebSocketTransport } from "./transports/websocket";
export { SSETransport } from "./transports/sse";
export { HTTPStreamingTransport } from "./transports/http-streaming";

export function createHAIPClient(
    config: import("haip").HAIPConnectionConfig
): import("haip").HAIPClient {
    const { HAIPClientImpl } = require("./client");
    return new HAIPClientImpl(config);
}
