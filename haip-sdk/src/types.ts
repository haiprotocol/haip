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
  ack?: string;
  ts: string;
  channel: HAIPChannel;
  type: HAIPEventType;
  payload: Record<string, any>;
  pv?: number;
  crit?: boolean;
  bin_len?: number;
  bin_mime?: string;
  run_id?: string;
  thread_id?: string;
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

export interface HAIPConnectionConfig {
  url: string;
  token: string;
  sessionId?: string;
  reconnectAttempts?: number;
  reconnectDelay?: number;
  heartbeatInterval?: number;
  heartbeatTimeout?: number;
  flowControl?: FlowControlConfig;
  maxConcurrentRuns?: number;
  replayWindowSize?: number;
  replayWindowTime?: number;
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

export interface HAIPConnectionState {
  connected: boolean;
  sessionId: string;
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

export interface HAIPEventHandlers {
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
  onError?: (error: HAIPErrorPayload) => void;
  onHandshake?: (payload: HAIPHandshakePayload) => void;
  onRunStarted?: (payload: HAIPRunStartedPayload) => void;
  onRunFinished?: (payload: HAIPRunFinishedPayload) => void;
  onRunCancel?: (payload: HAIPRunCancelPayload) => void;
  onRunError?: (payload: HAIPRunErrorPayload) => void;
  onPing?: (payload: HAIPPingPayload) => void;
  onPong?: (payload: HAIPPongPayload) => void;
  onReplayRequest?: (payload: HAIPReplayRequestPayload) => void;
  onTextMessage?: (payload: HAIPTextMessageStartPayload | HAIPTextMessagePartPayload | HAIPTextMessageEndPayload) => void;
  onAudioChunk?: (payload: HAIPAudioChunkPayload, binaryData?: ArrayBuffer) => void;
  onToolCall?: (payload: HAIPToolCallPayload) => void;
  onToolUpdate?: (payload: HAIPToolUpdatePayload) => void;
  onToolDone?: (payload: HAIPToolDonePayload) => void;
  onToolCancel?: (payload: HAIPToolCancelPayload) => void;
  onToolList?: (payload: HAIPToolListPayload) => void;
  onToolSchema?: (payload: HAIPToolSchemaPayload) => void;
  onFlowUpdate?: (payload: HAIPFlowUpdatePayload) => void;
  onChannelPaused?: (channel: HAIPChannel, reason?: string) => void;
  onChannelResumed?: (channel: HAIPChannel) => void;
  onHeartbeat?: (latency: number) => void;
  onMessage?: (message: HAIPMessage) => void;
}

export interface HAIPMessageOptions {
  priority?: number;
  timeout?: number;
  retries?: number;
  bin_len?: number;
  bin_mime?: string;
  pv?: number;
  crit?: boolean;
  runId?: string;
  threadId?: string;
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

export interface HAIPPerformanceMetrics {
  messagesSent: number;
  messagesReceived: number;
  messagesQueued: number;
  averageLatency: number;
  backPressureEvents: number;
  reconnectAttempts: number;
  lastUpdated: number;
  replayRequests: number;
  droppedMessages: number;
}

export interface HAIPLogger {
  debug: (message: string, ...args: any[]) => void;
  info: (message: string, ...args: any[]) => void;
  warn: (message: string, ...args: any[]) => void;
  error: (message: string, ...args: any[]) => void;
}

export interface HAIPClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(message: HAIPMessage, options?: HAIPMessageOptions): Promise<void>;
  sendBinary(data: ArrayBuffer): Promise<void>;
  startRun(threadId?: string, metadata?: Record<string, any>): Promise<string>;
  finishRun(runId: string, status?: "OK" | "CANCELLED" | "ERROR", summary?: string): Promise<void>;
  cancelRun(runId: string): Promise<void>;
  sendTextMessage(channel: HAIPChannel, text: string, author?: string, runId?: string, threadId?: string): Promise<string>;
  sendAudioChunk(channel: HAIPChannel, messageId: string, mime: string, data: ArrayBuffer, durationMs?: number, runId?: string, threadId?: string): Promise<void>;
  callTool(channel: HAIPChannel, tool: string, params?: Record<string, any>, runId?: string, threadId?: string): Promise<string>;
  updateTool(channel: HAIPChannel, callId: string, status: "QUEUED" | "RUNNING" | "CANCELLING", progress?: number, partial?: any, runId?: string, threadId?: string): Promise<void>;
  completeTool(channel: HAIPChannel, callId: string, status?: "OK" | "CANCELLED" | "ERROR", result?: any, runId?: string, threadId?: string): Promise<void>;
  cancelTool(channel: HAIPChannel, callId: string, reason?: string, runId?: string, threadId?: string): Promise<void>;
  listTools(channel: HAIPChannel, tools: Array<{ name: string; description?: string }>): Promise<void>;
  sendToolSchema(channel: HAIPChannel, tool: string, schema: Record<string, any>): Promise<void>;
  requestReplay(fromSeq: string, toSeq?: string): Promise<void>;
  pauseChannel(channel: string): Promise<void>;
  resumeChannel(channel: string): Promise<void>;
  sendFlowUpdate(channel: string, addMessages?: number, addBytes?: number): Promise<void>;
  setHandlers(handlers: HAIPEventHandlers): void;
  getConnectionState(): HAIPConnectionState;
  getPerformanceMetrics(): HAIPPerformanceMetrics;
  getActiveRuns(): HAIPRun[];
  getRun(runId: string): HAIPRun | undefined;
  isConnected(): boolean;
  on(event: string, handler: (...args: any[]) => void): this;
}

export interface HAIPTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: HAIPMessage): Promise<void>;
  sendBinary(data: ArrayBuffer): Promise<void>;
  onMessage(handler: (message: HAIPMessage) => void): void;
  onBinary(handler: (data: ArrayBuffer) => void): void;
  onConnect(handler: () => void): void;
  onDisconnect(handler: (reason: string) => void): void;
  onError(handler: (error: Error) => void): void;
  isConnected(): boolean;
}

export type HAIPTransportType = "websocket" | "sse" | "http-streaming";

export interface HAIPTransportConfig {
  type: HAIPTransportType;
  url: string;
  token: string;
  options?: Record<string, any>;
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