import WebSocket from "ws";

export type HAIPChannel = "USER" | "AGENT" | "SYSTEM" | "AUDIO_IN" | "AUDIO_OUT";

export type HAIPEventType =
    | "HAI"
    | "RUN_STARTED"
    | "RUN_FINISHED"
    | "RUN_CANCEL"
    | "RUN_ERROR"
    | "PING"
    | "PONG"
    | "REPLAY_REQUEST"
    | "TEXT_MESSAGE_START"
    | "TEXT_MESSAGE_PART"
    | "TEXT_MESSAGE_END"
    | "AUDIO_CHUNK"
    | "TOOL_CALL"
    | "TOOL_UPDATE"
    | "TOOL_DONE"
    | "TOOL_CANCEL"
    | "TOOL_LIST"
    | "TOOL_SCHEMA"
    | "ERROR"
    | "FLOW_UPDATE"
    | "PAUSE_CHANNEL"
    | "RESUME_CHANNEL";

export interface HAIPMessage {
    id: string;
    session: string;
    seq: string;
    ts: string;
    channel: HAIPChannel;
    type: HAIPEventType;
    payload: any;
    ack?: string;
    pv?: number;
    crit?: boolean;
    bin_len?: number;
    bin_mime?: string;
    run_id?: string;
    thread_id?: string;
    related_id?: string;
}

export interface HAIPHandshakePayload {
    haip_version: string;
    accept_major: number[];
    accept_events: HAIPEventType[];
    capabilities?: {
        binary_frames?: boolean;
        flow_control?: {
            initial_credit_messages: number;
            initial_credit_bytes: number;
        };
        max_concurrent_runs?: number;
        signed_envelopes?: boolean;
    };
    last_rx_seq?: string;
}

export interface HAIPRunStartedPayload {
    run_id?: string;
    thread_id?: string;
    metadata?: Record<string, any>;
}

export interface HAIPRunFinishedPayload {
    run_id?: string;
    status?: "OK" | "CANCELLED" | "ERROR";
    summary?: string;
}

export interface HAIPRunCancelPayload {
    run_id: string;
}

export interface HAIPRunErrorPayload {
    run_id?: string;
    code: string;
    message: string;
    related_id?: string;
    detail?: Record<string, any>;
}

export interface HAIPPingPayload {
    nonce?: string;
}

export interface HAIPPongPayload {
    nonce?: string;
}

export interface HAIPReplayRequestPayload {
    from_seq: string;
    to_seq?: string;
}

export interface HAIPTextMessageStartPayload {
    message_id: string;
    author?: string;
    text?: string;
}

export interface HAIPTextMessagePartPayload {
    message_id: string;
    text: string;
}

export interface HAIPTextMessageEndPayload {
    message_id: string;
    tokens?: string;
}

export interface HAIPAudioChunkPayload {
    message_id: string;
    mime: string;
    data?: string;
    duration_ms?: string;
}

export interface HAIPToolCallPayload {
    call_id: string;
    tool: string;
    params?: Record<string, any>;
}

export interface HAIPToolUpdatePayload {
    call_id: string;
    status: "QUEUED" | "RUNNING" | "CANCELLING";
    progress?: number;
    partial?: any;
}

export interface HAIPToolDonePayload {
    call_id: string;
    status?: "OK" | "CANCELLED" | "ERROR";
    result?: any;
}

export interface HAIPToolCancelPayload {
    call_id: string;
    reason?: string;
}

export interface HAIPToolListPayload {
    tools: Array<{
        name: string;
        description?: string;
    }>;
}

export interface HAIPToolSchemaPayload {
    tool: string;
    schema: Record<string, any>;
}

export interface HAIPErrorPayload {
    code: string;
    message: string;
    related_id?: string;
    detail?: Record<string, any>;
}

export interface HAIPFlowUpdatePayload {
    channel: string;
    add_messages?: number;
    add_bytes?: number;
}

export interface HAIPChannelControlPayload {
    channel: string;
}

export interface HAIPConnectionState {
    connected: boolean;
    handshakeCompleted: boolean;
    credits: Map<HAIPChannel, number>;
    byteCredits: Map<HAIPChannel, number>;
    pausedChannels: Set<HAIPChannel>;
    pendingMessages: Map<HAIPChannel, PendingMessage[]>;
    lastHeartbeat: number;
    reconnectAttempts: number;
    lastAck: string;
    lastDeliveredSeq: string;
    replayWindow: Map<string, HAIPMessage>;
    activeRuns: Set<string>;
}

export interface PendingMessage {
    message: HAIPMessage;
    timestamp: number;
    retries: number;
}

export interface HAIPRun {
    runId: string;
    threadId: string | undefined;
    status: "active" | "finished" | "cancelled" | "error";
    startTime: number;
    endTime: number | undefined;
    metadata: Record<string, any> | undefined;
    summary: string | undefined;
    error: string | undefined;
}

export interface HAIPToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, any>;
    outputSchema?: Record<string, any>;
}

export interface HAIPToolExecution {
    callId: string;
    toolName: string;
    arguments: Record<string, any>;
    status: "pending" | "running" | "completed" | "error" | "cancelled";
    startTime: number;
    endTime?: number;
    result?: Record<string, any>;
    error?: string;
    progress?: number;
    partial?: any;
}

export interface HAIPServerConfig {
    port: number;
    host: string;
    jwtSecret: string;
    jwtExpiresIn: string;
    maxConnections: number;
    heartbeatInterval: number;
    heartbeatTimeout: number;
    flowControl: FlowControlConfig;
    maxConcurrentRuns: number;
    replayWindowSize: number;
    replayWindowTime: number;
    enableCORS: boolean;
    enableCompression: boolean;
    enableLogging: boolean;
}

export interface FlowControlConfig {
    enabled: boolean;
    initialCredits: number;
    minCredits: number;
    maxCredits: number;
    creditThreshold: number;
    backPressureThreshold: number;
    adaptiveAdjustment: boolean;
    initialCreditMessages?: number;
    initialCreditBytes?: number;
}

export interface HAIPSession {
    id: string;
    userId: string;
    connected: boolean;
    handshakeCompleted: boolean;
    lastActivity: number;
    credits: Map<HAIPChannel, number>;
    byteCredits: Map<HAIPChannel, number>;
    pausedChannels: Set<HAIPChannel>;
    lastAck: string;
    lastDeliveredSeq: string;
    replayWindow: Map<string, HAIPMessage>;
    activeRuns: Set<string>;
    pendingMessages: Map<string, HAIPMessage>;
    ws?: WebSocket;
    sseResponse?: any;
    httpResponse?: any;
}

export interface HAIPServerStats {
    totalConnections: number;
    activeConnections: number;
    totalMessages: number;
    messagesPerSecond: number;
    averageLatency: number;
    errorRate: number;
    uptime: number;
}
