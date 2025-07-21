export interface HAIPCLIConfig {
  url: string;
  token?: string;
  transport?: "websocket" | "sse" | "http-streaming";
  verbose?: boolean;
  timeout?: number;
  reconnectAttempts?: number;
  reconnectDelay?: number;
}

export interface HAIPConnectionState {
  connected: boolean;
  url: string;
  transport: string;
  sessionId?: string;
  lastActivity: Date;
  reconnectAttempts: number;
}

export interface HAIPMessage {
  id: string;
  session?: string;
  seq: string;
  ts: string;
  channel: string;
  type: string;
  payload: any;
  bin_len?: number;
  bin_mime?: string;
}

export interface HAIPRun {
  id: string;
  threadId?: string;
  status: "RUNNING" | "FINISHED" | "CANCELLED" | "ERROR";
  metadata?: Record<string, any>;
  startTime: Date;
  endTime?: Date;
  summary?: string;
}

export interface HAIPTool {
  name: string;
  description?: string;
  inputSchema?: any;
  outputSchema?: any;
}

export interface HAIPToolCall {
  id: string;
  tool: string;
  params: Record<string, any>;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "ERROR" | "CANCELLED";
  progress?: number;
  result?: any;
  error?: string;
  startTime: Date;
  endTime?: Date;
}

export interface HAIPCLICommand {
  name: string;
  description: string;
  action: (args: any) => Promise<void>;
  options?: Array<{
    flags: string;
    description: string;
    defaultValue?: any;
  }>;
}

export interface HAIPCLIOutput {
  type: "info" | "success" | "warning" | "error" | "debug";
  message: string;
  data?: any;
  timestamp: Date;
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

export interface HAIPCLIReplayOptions {
  fromSeq?: string;
  toSeq?: string;
  includeBinary?: boolean;
  validate?: boolean;
}

export interface HAIPCLIAuthOptions {
  username?: string;
  password?: string;
  token?: string;
  audience?: string;
  issuer?: string;
  expiresIn?: string;
}

export interface HAIPCLIToolOptions {
  name: string;
  description?: string;
  inputSchema?: any;
  outputSchema?: any;
  timeout?: number;
  retries?: number;
}

export interface HAIPCLIFlowControlOptions {
  initialCredits?: number;
  initialCreditBytes?: number;
  maxCredits?: number;
  maxCreditBytes?: number;
  adaptiveAdjustment?: boolean;
}

export interface HAIPCLIHealthCheck {
  status: "healthy" | "unhealthy" | "degraded";
  uptime: number;
  activeConnections: number;
  totalConnections: number;
  errors: number;
  warnings: number;
  lastError?: string;
  lastWarning?: string;
}

export interface HAIPCLIProfile {
  name: string;
  url: string;
  token?: string;
  transport: string;
  options?: Record<string, any>;
}

export interface HAIPCLIConfigFile {
  version: string;
  profiles: Record<string, HAIPCLIProfile>;
  defaultProfile?: string;
  globalOptions?: Record<string, any>;
} 