import WebSocket from "ws";
import { EventEmitter } from "events";
import { HAIPTransport, HAIPMessage } from "../types";
import { HAIPUtils } from "../utils";

export class WebSocketTransport extends EventEmitter implements HAIPTransport {
  private ws: WebSocket | null = null;
  private url: string;
  private token: string;
  private options: Record<string, any>;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private heartbeatTimeout: NodeJS.Timeout | null = null;
  private heartbeatIntervalMs = 30000;
  private heartbeatTimeoutMs = 5000;

  constructor(url: string, token: string, options: Record<string, any> = {}) {
    super();
    this.url = url;
    this.token = token;
    this.options = options;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const wsUrl = `${this.url}?token=${encodeURIComponent(this.token)}`;
        this.ws = new WebSocket(wsUrl, this.options);

        this.ws.on("open", () => {
          this.reconnectAttempts = 0;
          this.startHeartbeat();
          this.emit("connect");
          resolve();
        });

        this.ws.on("message", (data: WebSocket.Data) => {
          try {
            if (typeof data === "string") {
              const message = JSON.parse(data);
              if (HAIPUtils.validateMessage(message)) {
                this.emit("message", message);
              } else {
                this.emit("error", new Error("Invalid message format"));
              }
            } else if (data instanceof Buffer) {
              this.emit("binary", data);
            } else if (data instanceof ArrayBuffer) {
              this.emit("binary", Buffer.from(data));
            }
          } catch (error) {
            this.emit("error", error as Error);
          }
        });

        this.ws.on("close", (code: number, reason: Buffer) => {
          this.stopHeartbeat();
          const reasonStr = reason.toString();
          this.emit("disconnect", reasonStr);
          
          if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.scheduleReconnect();
          }
        });

        this.ws.on("error", (error: Error) => {
          this.emit("error", error);
          reject(error);
        });

        this.ws.on("ping", () => {
          this.ws?.pong();
        });

        this.ws.on("pong", () => {
          // Reset heartbeat timeout
          if (this.heartbeatTimeout) {
            clearTimeout(this.heartbeatTimeout);
            this.heartbeatTimeout = null;
          }
        });

      } catch (error) {
        reject(error as Error);
      }
    });
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      this.stopHeartbeat();
      
      if (this.ws) {
        this.ws.once("close", () => {
          this.ws = null;
          resolve();
        });
        this.ws.close(1000, "Normal closure");
      } else {
        resolve();
      }
    });
  }

  async send(message: HAIPMessage): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }

    return new Promise((resolve, reject) => {
      try {
        const messageStr = JSON.stringify(message);
        this.ws!.send(messageStr, (error: Error | undefined) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      } catch (error) {
        reject(error as Error);
      }
    });
  }

  async sendBinary(data: ArrayBuffer): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }

    return new Promise((resolve, reject) => {
      try {
        this.ws!.send(data, (error: Error | undefined) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      } catch (error) {
        reject(error as Error);
      }
    });
  }

  onMessage(handler: (message: HAIPMessage) => void): void {
    this.on("message", handler);
  }

  onBinary(handler: (data: ArrayBuffer) => void): void {
    this.on("binary", handler);
  }

  onConnect(handler: () => void): void {
    this.on("connect", handler);
  }

  onDisconnect(handler: (reason: string) => void): void {
    this.on("disconnect", handler);
  }

  onError(handler: (error: Error) => void): void {
    this.on("error", handler);
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
        
        // Set timeout for pong response
        this.heartbeatTimeout = setTimeout(() => {
          this.emit("error", new Error("Heartbeat timeout"));
          this.ws?.terminate();
        }, this.heartbeatTimeoutMs);
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = HAIPUtils.calculateBackoffDelay(this.reconnectAttempts, this.reconnectDelay);
    
    setTimeout(() => {
      this.connect().catch((error) => {
        this.emit("error", error);
      });
    }, delay);
  }

  setReconnectConfig(maxAttempts: number, delay: number): void {
    this.maxReconnectAttempts = maxAttempts;
    this.reconnectDelay = delay;
  }

  setHeartbeatConfig(interval: number, timeout: number): void {
    this.heartbeatIntervalMs = interval;
    this.heartbeatTimeoutMs = timeout;
  }
} 