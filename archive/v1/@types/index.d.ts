import WebSocket from "ws";
import { HAIPEventType } from "./constants";

export type HAIPChannel = "USER" | "AGENT" | "SYSTEM";

export type { HAIPEventType } from "./constants";

export type HAIPSessionTransaction = {
  sessionId: string;
  transaction: HAIPTransaction;
};

export interface HAIPTool {
  schema(): HAIPToolSchema;
  handleMessage(client: HAIPSessionTransaction, message: HAIPMessage): void;
  handleAudioChunk(client: HAIPSessionTransaction, message: HAIPMessage): void;
  on(event: string, handler: (...args: any[]) => void): this;

  // Utility methods
  getClients(): HAIPSessionTransaction[];
  addClient(client: HAIPSessionTransaction): void;
  removeClient(client: HAIPSessionTransaction): void;

  sendHAIPMessage(client: HAIPSessionTransaction, message: HAIPMessage): void;
  sendTextMessage(client: HAIPSessionTransaction, message: string): void;
  broadcastMessage(message: HAIPMessage): void;
}

export interface HAIPToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  outputSchema?: Record<string, any>;
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

export interface HAIPPingPayload {
  nonce?: string;
}

export interface HAIPPongPayload {
  nonce?: string;
}

export interface HAIPToolListPayload {
  tools: Array<{
    name: string;
    description?: string;
  }>;
}

export interface HAIPFlowUpdatePayload {
  channel: string;
  add_messages?: number;
  add_bytes?: number;
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
  user: HAIPUser | null;
  connected: boolean;
  handshakeCompleted: boolean;
  lastActivity: number;
  lastAck: string;
  lastDeliveredSeq: string;
  activeRuns: Set<string>;
  pendingMessages: Map<string, HAIPMessage>;
  ws?: WebSocket;
  req?: Request<{}, any, any, QueryString.ParsedQs, Record<string, any>>;
  sseResponse?: any;
  httpResponse?: any;
  transactions: Map<string, HAIPTransaction>;
}

export interface HAIPTransactionData {
  id: string;
  status: "started" | "pending";
  toolName: string;
  toolParams?: Record<string, any>;

  replayWindow: HAIPMessage[];
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

/*
SDK
*/

export interface HAIPMessage {
  id: string;
  session: string;
  transaction: string | null;
  seq: string;
  ack?: string;
  ts: string;
  channel: HAIPChannel;
  type: HAIPEventType;
  payload: Record<string, any> | any; // TODO SHOULD THIS BE RECORD OR ANY
  pv?: number;
  crit?: boolean;
  bin_len?: number;
  bin_mime?: string;
  run_id?: string;
  thread_id?: string;
  related_id?: string;
}

export interface HAIPTransactionStartedPayload {
  referenceId: string | null;
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

export interface HAIPReplayRequestPayload {
  from_seq: string;
  to_seq?: string;
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

export interface HAIPToolSchemaPayload {
  schema: HAIPToolSchema;
}

export interface HAIPErrorPayload {
  code: string;
  message: string;
  related_id?: string;
  detail?: Record<string, any>;
}

export interface HAIPChannelControlPayload {
  channel: string;
}

export interface HAIPConnectionConfig {
  url: string;
  //token: string;
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
  onPing?: (payload: HAIPPingPayload) => void;
  onPong?: (payload: HAIPPongPayload) => void;
  onReplayRequest?: (payload: HAIPReplayRequestPayload) => void;
  onTextMessage?: (payload: HAIPMessage) => void;
  onAudioChunk?: (
    payload: HAIPAudioChunkPayload,
    binaryData?: ArrayBuffer
  ) => void;
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
  authenticate(authFn: () => Record<string, any>): void;
  on(event: string, handler: (...args: any[]) => void): this;
  startTransaction(
    toolName: string,
    params?: Record<string, any>
  ): Promise<HAIPTransaction>;
}

export interface HAIPTransaction {
  sendTextMessage(text: string, options?: HAIPMessageOptions);
  handleMessage(message: HAIPMessage): void;
  on(event: string, handler: (...args: any[]) => void): this;
  close(): Promise<void>;
  //getReplayWindow(fromSeq?: string, toSeq?: string): HAIPMessage[];
  addToReplayWindow(message: HAIPMessage, config?: HAIPConnectionConfig): void;
  getReplayWindow(
    fromSeq?: string,
    toSeq?: string
  ): Generator<HAIPMessage, void, unknown>;
  id: string;
  toolName: string;
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
  options?: Record<string, any>;
}

export interface HAIPCLIConfig {
  url: string;
  token?: string;
  transport?: HAIPTransportType;
  verbose?: boolean;
  timeout?: number;
  reconnectAttempts?: number;
  reconnectDelay?: number;
}

export interface HAIPCLIStats {
  messagesSent: number;
  messagesReceived: number;
  bytesSent: number;
  bytesReceived: number;
  connectionTime: number;
  reconnectAttempts: number;
  errors: number;
}

export interface HAIPCLIHealthCheck {
  status: "ok" | "unhealthy" | "degraded";
  uptime: number;
  activeConnections: number;
  totalConnections: number;
  errors: number;
  warnings: number;
  lastError?: string;
  lastWarning?: string;
}

export interface HAIPCLIMonitorOptions {
  showTimestamps?: boolean;
  showMetadata?: boolean;
  filterTypes?: string[];
  filterChannels?: string[];
  maxLines?: number;
  follow?: boolean;
}

export interface HAIPCLITestOptions {
  messageCount?: number;
  messageSize?: number;
  delay?: number;
  timeout?: number;
  validateResponses?: boolean;
}

export interface HAIPCLIOutput {
  type: "info" | "success" | "warning" | "error" | "debug";
  message: string;
  data?: any;
  timestamp: Date;
}

export interface HAIPUser {
  id: string;
  permissions: Map<HAIPEventType, string[]>;
  credits: number;
}
