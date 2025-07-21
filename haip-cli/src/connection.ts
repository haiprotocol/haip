import WebSocket from "ws";
import { EventEmitter } from "events";
import { HAIPCLIConfig, HAIPConnectionState, HAIPMessage, HAIPCLIStats } from "./types";
import { HAIPCLIUtils } from "./utils";

export class HAIPConnection extends EventEmitter {
  private config: HAIPCLIConfig;
  private ws?: WebSocket | undefined;
  private eventSource?: EventSource | undefined;
  private connectionState: HAIPConnectionState;
  private stats: HAIPCLIStats;
  private reconnectTimer?: NodeJS.Timeout | undefined;
  private heartbeatTimer?: NodeJS.Timeout | undefined;
  private sessionId?: string;

  constructor(config: HAIPCLIConfig) {
    super();
    this.config = config;
    this.connectionState = {
      connected: false,
      url: config.url,
      transport: config.transport || "websocket",
      lastActivity: new Date(),
      reconnectAttempts: 0
    };
    this.stats = {
      messagesSent: 0,
      messagesReceived: 0,
      bytesSent: 0,
      bytesReceived: 0,
      connectionTime: Date.now(),
      reconnectAttempts: 0,
      errors: 0
    };
  }

  async connect(): Promise<void> {
    try {
      switch (this.config.transport) {
        case "websocket":
          await this.connectWebSocket();
          break;
        case "sse":
          await this.connectSSE();
          break;
        case "http-streaming":
          await this.connectHTTPStreaming();
          break;
        default:
          await this.connectWebSocket();
      }
    } catch (error) {
      this.stats.errors++;
      this.emit("error", error);
      throw error;
    }
  }

  private async connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const url = this.config.token 
          ? `${this.config.url}?token=${this.config.token}`
          : this.config.url;

        this.ws = new WebSocket(url);

        this.ws.on("open", () => {
          this.connectionState.connected = true;
          this.connectionState.lastActivity = new Date();
          this.stats.connectionTime = Date.now();
          this.emit("connected");
          this.startHeartbeat();
          resolve();
        });

        this.ws.on("message", (data: WebSocket.Data) => {
          this.handleMessage(data);
        });

        this.ws.on("close", (code: number, reason: Buffer) => {
          this.handleDisconnect(`WebSocket closed: ${code} - ${reason.toString()}`);
        });

        this.ws.on("error", (error: Error) => {
          this.stats.errors++;
          this.emit("error", error);
          reject(error);
        });

        this.ws.on("ping", () => {
          this.connectionState.lastActivity = new Date();
          this.emit("ping");
        });

        this.ws.on("pong", () => {
          this.connectionState.lastActivity = new Date();
          this.emit("pong");
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  private async connectSSE(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const url = this.config.token 
          ? `${this.config.url}?token=${this.config.token}`
          : this.config.url;

        this.eventSource = new EventSource(url);

        this.eventSource.onopen = () => {
          this.connectionState.connected = true;
          this.connectionState.lastActivity = new Date();
          this.stats.connectionTime = Date.now();
          this.emit("connected");
          resolve();
        };

        this.eventSource.onmessage = (event: MessageEvent) => {
          this.handleMessage(event.data);
        };

        this.eventSource.onerror = (error: Event) => {
          this.stats.errors++;
          this.emit("error", error);
          reject(error);
        };

      } catch (error) {
        reject(error);
      }
    });
  }

  private async connectHTTPStreaming(): Promise<void> {
    try {
      const url = this.config.url;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream"
      };

      if (this.config.token) {
        headers["Authorization"] = `Bearer ${this.config.token}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          type: "HAI",
          payload: HAIPCLIUtils.createHandshakeMessage(this.sessionId).payload
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      this.connectionState.connected = true;
      this.connectionState.lastActivity = new Date();
      this.stats.connectionTime = Date.now();
      this.emit("connected");

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body reader available");
      }

      this.handleHTTPStream(reader);

    } catch (error) {
      this.stats.errors++;
      this.emit("error", error);
      throw error;
    }
  }

  private async handleHTTPStream(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const messages = chunk.split("\n").filter(line => line.trim());

        for (const messageStr of messages) {
          this.handleMessage(messageStr);
        }
      }
    } catch (error) {
      this.handleDisconnect(`HTTP stream error: ${error}`);
    }
  }

  private handleMessage(data: any): void {
    try {
      const message: HAIPMessage = typeof data === "string" ? JSON.parse(data) : data;
      this.stats.messagesReceived++;
      this.stats.bytesReceived += JSON.stringify(message).length;
      this.connectionState.lastActivity = new Date();

      this.emit("message", message);

      if (message.type === "HAI" && message.payload.session_id) {
        this.sessionId = message.payload.session_id;
      }

    } catch (error) {
      this.stats.errors++;
      this.emit("error", new Error(`Failed to parse message: ${error}`));
    }
  }

  private handleDisconnect(reason: string): void {
    this.connectionState.connected = false;
    this.stopHeartbeat();
    this.emit("disconnected", reason);

    if (this.config.reconnectAttempts && this.connectionState.reconnectAttempts < this.config.reconnectAttempts) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    const delay = (this.config.reconnectDelay || 1000) * Math.pow(2, this.connectionState.reconnectAttempts);
    
    this.reconnectTimer = setTimeout(async () => {
      this.connectionState.reconnectAttempts++;
      this.stats.reconnectAttempts++;
      this.emit("reconnecting", this.connectionState.reconnectAttempts);
      
      try {
        await this.connect();
        this.connectionState.reconnectAttempts = 0;
        this.emit("reconnected");
      } catch (error) {
        this.emit("reconnect_failed", error);
      }
    }, delay);
  }

  private startHeartbeat(): void {
    if (this.config.transport === "websocket") {
      this.heartbeatTimer = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          const pingMessage = HAIPCLIUtils.createPingMessage();
          this.sendMessage(pingMessage);
        }
      }, 30000);
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  sendMessage(message: HAIPMessage): void {
    if (!this.connectionState.connected) {
      throw new Error("Not connected");
    }

    const messageStr = JSON.stringify(message);
    this.stats.messagesSent++;
    this.stats.bytesSent += messageStr.length;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(messageStr);
    } else if (this.eventSource) {
      this.emit("error", new Error("Cannot send messages over SSE connection"));
    } else {
      this.emit("error", new Error("No active connection"));
    }
  }

  async disconnect(): Promise<void> {
    this.connectionState.connected = false;
    this.stopHeartbeat();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = undefined;
    }

    this.emit("disconnected", "Manual disconnect");
  }

  getConnectionState(): HAIPConnectionState {
    return { ...this.connectionState };
  }

  getStats(): HAIPCLIStats {
    return { ...this.stats };
  }

  isConnected(): boolean {
    return this.connectionState.connected;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }
} 