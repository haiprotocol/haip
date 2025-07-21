import { HAIPTransport, HAIPTransportConfig, HAIPMessage } from "../types";
import { HAIPUtils } from "../utils";

export class HTTPStreamingTransport implements HAIPTransport {
    private config: HAIPTransportConfig;
    private connected: boolean = false;
    private messageHandler?: (message: HAIPMessage) => void;
    private binaryHandler?: (data: ArrayBuffer) => void;
    private connectHandler?: () => void;
    private disconnectHandler?: (reason: string) => void;
    private errorHandler?: (error: Error) => void;
    private abortController: AbortController | undefined;
    private heartbeatInterval: NodeJS.Timeout | undefined;
    private lastMessageTime: number = 0;
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 3;
    private reconnectDelay: number = 1000;

    constructor(config: HAIPTransportConfig) {
        this.config = config;
    }

    async connect(): Promise<void> {
        if (this.connected) {
            return;
        }

        try {
            this.abortController = new AbortController();
            await this.startStreaming();
        } catch (error) {
            this.handleError(error as Error);
            throw error;
        }
    }

    private async startStreaming(): Promise<void> {
        try {
            const url = new URL(this.config.url);
            url.searchParams.set("token", this.config.token);
            url.searchParams.set("stream", "true");

            const response = await fetch(url.toString(), {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${this.config.token}`,
                    Accept: "text/event-stream",
                    "Cache-Control": "no-cache",
                },
                signal: this.abortController?.signal || null,
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            if (!response.body) {
                throw new Error("Response body is null");
            }

            this.connected = true;
            this.reconnectAttempts = 0;
            this.lastMessageTime = Date.now();
            this.startHeartbeat();
            this.connectHandler?.();

            await this.processStream(response.body);
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                return;
            }
            throw error;
        }
    }

    private async processStream(body: ReadableStream): Promise<void> {
        const reader = body.getReader();
        const decoder = new TextDecoder();

        try {
            for (;;) {
                const { done, value } = await reader.read();

                if (done) {
                    break;
                }

                const chunk = decoder.decode(value, { stream: true });
                this.processChunk(chunk);
            }
        } catch (error) {
            this.handleError(error as Error);
        } finally {
            reader.releaseLock();
        }
    }

    private processChunk(chunk: string): void {
        const lines = chunk.split("\n");

        for (const line of lines) {
            if (line.trim() === "") {
                continue;
            }

            if (line.startsWith("data: ")) {
                const data = line.slice(6);
                this.processData(data);
            } else if (line.startsWith("event: ")) {
                const eventType = line.slice(7);
                this.processEvent(eventType);
            }
        }
    }

    private processData(data: string): void {
        try {
            if (data === "[DONE]") {
                this.disconnectHandler?.("Stream ended");
                return;
            }

            const message = JSON.parse(data);
            if (message && typeof message === "object") {
                this.lastMessageTime = Date.now();
                this.messageHandler?.(message as HAIPMessage);
            }
        } catch (error) {
            console.warn("Failed to parse streaming data:", error);
        }
    }

    private processEvent(eventType: string): void {
        this.lastMessageTime = Date.now();

        switch (eventType) {
            case "haip-message":
                break;
            case "haip-binary":
                break;
            case "haip-error":
                break;
            case "heartbeat":
                break;
            default:
                console.warn("Unknown event type:", eventType);
        }
    }

    private handleError(error: Error): void {
        this.connected = false;
        this.stopHeartbeat();
        this.errorHandler?.(error);

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.scheduleReconnection();
        } else {
            this.disconnectHandler?.("Max reconnection attempts reached");
        }
    }

    private scheduleReconnection(): void {
        const delay = HAIPUtils.calculateBackoffDelay(this.reconnectAttempts, this.reconnectDelay);

        setTimeout(() => {
            this.reconnectAttempts++;
            this.connect().catch(error => {
                console.error("Reconnection failed:", error);
            });
        }, delay);
    }

    private startHeartbeat(): void {
        this.heartbeatInterval = setInterval(() => {
            const now = Date.now();
            const timeSinceLastMessage = now - this.lastMessageTime;

            if (timeSinceLastMessage > 30000) {
                this.handleError(new Error("Heartbeat timeout"));
            }
        }, 10000);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = undefined;
        }
    }

    async disconnect(): Promise<void> {
        this.connected = false;
        this.stopHeartbeat();

        if (this.abortController) {
            this.abortController.abort();
            this.abortController = undefined;
        }

        this.disconnectHandler?.("Disconnected by client");
    }

    async send(message: HAIPMessage): Promise<void> {
        if (!this.connected) {
            throw new Error("Not connected");
        }

        try {
            const response = await fetch(this.config.url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${this.config.token}`,
                    "X-HAIP-Message": "true",
                },
                body: JSON.stringify(message),
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
        } catch (error) {
            this.handleError(error as Error);
            throw error;
        }
    }

    async sendBinary(data: ArrayBuffer): Promise<void> {
        if (!this.connected) {
            throw new Error("Not connected");
        }

        try {
            const base64Data = HAIPUtils.arrayBufferToBase64(data);
            const response = await fetch(this.config.url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/octet-stream",
                    Authorization: `Bearer ${this.config.token}`,
                    "X-HAIP-Binary": "true",
                },
                body: base64Data,
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
        } catch (error) {
            this.handleError(error as Error);
            throw error;
        }
    }

    onMessage(handler: (message: HAIPMessage) => void): void {
        this.messageHandler = handler;
    }

    onBinary(handler: (data: ArrayBuffer) => void): void {
        this.binaryHandler = handler;
    }

    onConnect(handler: () => void): void {
        this.connectHandler = handler;
    }

    onDisconnect(handler: (reason: string) => void): void {
        this.disconnectHandler = handler;
    }

    onError(handler: (error: Error) => void): void {
        this.errorHandler = handler;
    }

    isConnected(): boolean {
        return this.connected;
    }
}
