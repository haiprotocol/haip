import { HAIPTransport, HAIPTransportConfig, HAIPMessage } from "haip";
import { HAIPUtils } from "../utils";

export class SSETransport implements HAIPTransport {
    private config: HAIPTransportConfig;
    private eventSource: EventSource | undefined;
    private connected: boolean = false;
    private messageHandler?: (message: HAIPMessage) => void;
    private binaryHandler?: (data: ArrayBuffer) => void;
    private connectHandler?: () => void;
    private disconnectHandler?: (reason: string) => void;
    private errorHandler?: (error: Error) => void;
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 3;
    private reconnectDelay: number = 1000;
    private heartbeatInterval: NodeJS.Timeout | undefined;
    private lastMessageTime: number = 0;

    constructor(config: HAIPTransportConfig) {
        this.config = config;
    }

    async connect(): Promise<void> {
        if (this.connected) {
            return;
        }

        try {
            const url = new URL(this.config.url);
            url.searchParams.set("token", this.config.token);

            if (HAIPUtils.isBrowser()) {
                this.eventSource = new EventSource(url.toString());
                this.setupEventSourceHandlers();
            } else {
                throw new Error("SSE transport is only supported in browser environments");
            }
        } catch (error) {
            this.handleError(error as Error);
            throw error;
        }
    }

    private setupEventSourceHandlers(): void {
        if (!this.eventSource) {
            return;
        }

        this.eventSource.onopen = () => {
            this.connected = true;
            this.reconnectAttempts = 0;
            this.lastMessageTime = Date.now();
            this.startHeartbeat();
            this.connectHandler?.();
        };

        this.eventSource.onmessage = event => {
            this.lastMessageTime = Date.now();
            this.handleMessage(event);
        };

        this.eventSource.onerror = () => {
            this.handleError(new Error("SSE connection error"));
        };

        this.eventSource.addEventListener("haip-message", event => {
            this.lastMessageTime = Date.now();
            this.handleHAIPMessage(event);
        });

        this.eventSource.addEventListener("haip-binary", event => {
            this.lastMessageTime = Date.now();
            this.handleBinaryMessage(event);
        });

        this.eventSource.addEventListener("haip-error", event => {
            this.lastMessageTime = Date.now();
            this.handleHAIPError(event);
        });
    }

    private handleMessage(event: MessageEvent): void {
        try {
            const data = JSON.parse(event.data);
            if (data && typeof data === "object") {
                this.messageHandler?.(data as HAIPMessage);
            }
        } catch (error) {
            console.warn("Failed to parse SSE message:", error);
        }
    }

    private handleHAIPMessage(event: Event): void {
        try {
            const customEvent = event as CustomEvent;
            const message = customEvent.detail as HAIPMessage;
            if (message && HAIPUtils.validateMessage(message)) {
                this.messageHandler?.(message);
            }
        } catch (error) {
            console.warn("Failed to handle HAIP message:", error);
        }
    }

    private handleBinaryMessage(event: Event): void {
        try {
            const customEvent = event as CustomEvent;
            const base64Data = customEvent.detail as string;
            if (base64Data) {
                const arrayBuffer = HAIPUtils.base64ToArrayBuffer(base64Data);
                this.binaryHandler?.(arrayBuffer);
            }
        } catch (error) {
            console.warn("Failed to handle binary message:", error);
        }
    }

    private handleHAIPError(event: Event): void {
        try {
            const customEvent = event as CustomEvent;
            const errorData = customEvent.detail as { code: string; message: string };
            this.errorHandler?.(new Error(`${errorData.code}: ${errorData.message}`));
        } catch (error) {
            console.warn("Failed to handle HAIP error:", error);
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

        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = undefined;
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
