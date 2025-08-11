import { v4 as uuidv4 } from "uuid";
import {
    HAIPMessage,
    HAIPEventType,
    HAIPChannel,
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
} from "haip";

export class HAIPUtils {
    /**
     * Generate a UUID v4
     */
    static generateUUID(): string {
        return uuidv4();
    }

    /**
     * Generate a timestamp string
     */
    static generateTimestamp(): string {
        return Date.now().toString();
    }

    /**
     * Generate a sequence number
     */
    static generateSequenceNumber(): string {
        return Date.now().toString();
    }

    /**
     * Calculate message size for flow control
     */
    static calculateMessageSize(message: HAIPMessage): number {
        const messageStr = JSON.stringify(message);
        return messageStr.length;
    }

    /**
     * Validate HAIP message structure
     */
    static validateMessage(message: any): message is HAIPMessage {
        if (!message || typeof message !== "object") {
            return false;
        }

        const requiredFields = ["id", "session", "seq", "ts", "channel", "type", "payload"];
        for (const field of requiredFields) {
            if (!(field in message)) {
                return false;
            }
        }

        if (typeof message.id !== "string" || message.id.length === 0) {
            return false;
        }

        if (typeof message.session !== "string" || message.session.length === 0) {
            return false;
        }

        if (typeof message.seq !== "string" || message.seq.length === 0) {
            return false;
        }

        if (typeof message.ts !== "string" || message.ts.length === 0) {
            return false;
        }

        if (!this.isValidChannel(message.channel)) {
            return false;
        }

        if (!this.isValidEventType(message.type)) {
            return false;
        }

        if (!message.payload || typeof message.payload !== "object") {
            return false;
        }

        return true;
    }

    /**
     * Validate HAIP channel
     */
    static isValidChannel(channel: any): channel is HAIPChannel {
        const validChannels: HAIPChannel[] = ["USER", "AGENT", "SYSTEM", "AUDIO_IN", "AUDIO_OUT"];
        return validChannels.includes(channel);
    }

    /**
     * Validate HAIP event type
     */
    static isValidEventType(type: any): type is HAIPEventType {
        return HAIP_EVENT_TYPES.includes(type);
    }

    /**
     * Create a HAIP message
     */
    static createMessage(
        sessionId: string,
        channel: HAIPChannel,
        type: HAIPEventType,
        payload: Record<string, any>,
        options?: {
            id?: string;
            seq?: string;
            ts?: string;
            ack?: string;
            pv?: number;
            crit?: boolean;
            bin_len?: number;
            bin_mime?: string;
            run_id?: string;
            thread_id?: string;
        }
    ): HAIPMessage {
        return {
            id: options?.id || this.generateUUID(),
            session: sessionId,
            seq: options?.seq || this.generateSequenceNumber(),
            ts: options?.ts || this.generateTimestamp(),
            channel,
            type,
            payload,
            ...(options?.ack !== undefined && { ack: options.ack }),
            ...(options?.pv !== undefined && { pv: options.pv }),
            ...(options?.crit !== undefined && { crit: options.crit }),
            ...(options?.bin_len !== undefined && { bin_len: options.bin_len }),
            ...(options?.bin_mime !== undefined && { bin_mime: options.bin_mime }),
            ...(options?.run_id !== undefined && { run_id: options.run_id }),
            ...(options?.thread_id !== undefined && { thread_id: options.thread_id }),
        };
    }

    /**
     * Create a transaction start message
     */
    static createTransactionStartMessage(sessionId: string, authFn: object): HAIPMessage {
        return this.createMessage(sessionId, "SYSTEM", "TRANSACTION_START", {
            transaction_id: this.generateUUID(),
            auth: authFn,
        });
    }

    /**
     * Create a handshake message
     */
    static createHandshakeMessage(
        sessionId: string,
        authFn: object,
        acceptEvents: HAIPEventType[],
        capabilities?: Record<string, any>,
        lastRxSeq?: string
    ): HAIPMessage {
        return this.createMessage(sessionId, "SYSTEM", "HAI", {
            haip_version: "1.1.2",
            accept_major: [1],
            accept_events: acceptEvents,
            ...(capabilities && { capabilities }),
            ...(lastRxSeq && { last_rx_seq: lastRxSeq }),
            auth: authFn,
        });
    }

    /**
     * Create a run started message
     */
    static createRunStartedMessage(
        sessionId: string,
        runId: string,
        threadId?: string,
        metadata?: Record<string, any>
    ): HAIPMessage {
        return this.createMessage(
            sessionId,
            "SYSTEM",
            "RUN_STARTED",
            {
                run_id: runId,
                ...(threadId && { thread_id: threadId }),
                ...(metadata && { metadata }),
            },
            {
                run_id: runId,
                ...(threadId && { thread_id: threadId }),
            }
        );
    }

    /**
     * Create a run finished message
     */
    static createRunFinishedMessage(
        sessionId: string,
        runId: string,
        status?: "OK" | "CANCELLED" | "ERROR",
        summary?: string
    ): HAIPMessage {
        return this.createMessage(
            sessionId,
            "SYSTEM",
            "RUN_FINISHED",
            {
                run_id: runId,
                ...(status && { status }),
                ...(summary && { summary }),
            },
            { run_id: runId }
        );
    }

    /**
     * Create a run cancel message
     */
    static createRunCancelMessage(sessionId: string, runId: string): HAIPMessage {
        return this.createMessage(
            sessionId,
            "SYSTEM",
            "RUN_CANCEL",
            {
                run_id: runId,
            },
            { run_id: runId }
        );
    }

    /**
     * Create a run error message
     */
    static createRunErrorMessage(
        sessionId: string,
        runId: string,
        code: string,
        message: string,
        relatedId?: string,
        detail?: Record<string, any>
    ): HAIPMessage {
        return this.createMessage(
            sessionId,
            "SYSTEM",
            "RUN_ERROR",
            {
                run_id: runId,
                code,
                message,
                ...(relatedId && { related_id: relatedId }),
                ...(detail && { detail }),
            },
            { run_id: runId }
        );
    }

    /**
     * Create a ping message
     */
    static createPingMessage(sessionId: string, nonce?: string): HAIPMessage {
        return this.createMessage(sessionId, "SYSTEM", "PING", {
            ...(nonce && { nonce }),
        });
    }

    /**
     * Create a pong message
     */
    static createPongMessage(sessionId: string, nonce?: string): HAIPMessage {
        return this.createMessage(sessionId, "SYSTEM", "PONG", {
            ...(nonce && { nonce }),
        });
    }

    /**
     * Create a replay request message
     */
    static createReplayRequestMessage(
        sessionId: string,
        fromSeq: string,
        toSeq?: string
    ): HAIPMessage {
        return this.createMessage(sessionId, "SYSTEM", "REPLAY_REQUEST", {
            from_seq: fromSeq,
            ...(toSeq && { to_seq: toSeq }),
        });
    }

    /**
     * Create a text message start
     */
    static createTextMessageStartMessage(
        sessionId: string,
        channel: HAIPChannel,
        messageId: string,
        author?: string,
        text?: string
    ): HAIPMessage {
        return this.createMessage(sessionId, channel, "TEXT_MESSAGE_START", {
            message_id: messageId,
            ...(author && { author }),
            ...(text && { text }),
        });
    }

    /**
     * Create a text message part
     */
    static createTextMessagePartMessage(
        sessionId: string,
        channel: HAIPChannel,
        messageId: string,
        text: string
    ): HAIPMessage {
        return this.createMessage(sessionId, channel, "TEXT_MESSAGE_PART", {
            message_id: messageId,
            text,
        });
    }

    /**
     * Create a text message end
     */
    static createTextMessageEndMessage(
        sessionId: string,
        channel: HAIPChannel,
        messageId: string,
        tokens?: string
    ): HAIPMessage {
        return this.createMessage(sessionId, channel, "TEXT_MESSAGE_END", {
            message_id: messageId,
            ...(tokens && { tokens }),
        });
    }

    /**
     * Create an audio chunk message
     */
    static createAudioChunkMessage(
        sessionId: string,
        channel: HAIPChannel,
        messageId: string,
        mime: string,
        data?: string,
        durationMs?: string
    ): HAIPMessage {
        return this.createMessage(sessionId, channel, "AUDIO_CHUNK", {
            message_id: messageId,
            mime,
            ...(data && { data }),
            ...(durationMs && { duration_ms: durationMs }),
        });
    }

    /**
     * Create a tool call message
     */
    static createToolCallMessage(
        sessionId: string,
        channel: HAIPChannel,
        callId: string,
        tool: string,
        params?: Record<string, any>
    ): HAIPMessage {
        return this.createMessage(sessionId, channel, "TOOL_CALL", {
            call_id: callId,
            tool,
            ...(params && { params }),
        });
    }

    /**
     * Create a tool update message
     */
    static createToolUpdateMessage(
        sessionId: string,
        channel: HAIPChannel,
        callId: string,
        status: "QUEUED" | "RUNNING" | "CANCELLING",
        progress?: number,
        partial?: any
    ): HAIPMessage {
        return this.createMessage(sessionId, channel, "TOOL_UPDATE", {
            call_id: callId,
            status,
            ...(progress !== undefined && { progress: progress }),
            ...(partial !== undefined && { partial }),
        });
    }

    /**
     * Create a tool done message
     */
    static createToolDoneMessage(
        sessionId: string,
        channel: HAIPChannel,
        callId: string,
        status?: "OK" | "CANCELLED" | "ERROR",
        result?: any
    ): HAIPMessage {
        return this.createMessage(sessionId, channel, "TOOL_DONE", {
            call_id: callId,
            ...(status && { status }),
            ...(result !== undefined && { result }),
        });
    }

    /**
     * Create a tool cancel message
     */
    static createToolCancelMessage(
        sessionId: string,
        channel: HAIPChannel,
        callId: string,
        reason?: string
    ): HAIPMessage {
        return this.createMessage(sessionId, channel, "TOOL_CANCEL", {
            call_id: callId,
            ...(reason && { reason }),
        });
    }

    /**
     * Create a tool list message
     */
    static createToolListMessage(
        sessionId: string,
        channel: HAIPChannel,
        tools: Array<{ name: string; description?: string }>
    ): HAIPMessage {
        return this.createMessage(sessionId, channel, "TOOL_LIST", {
            tools,
        });
    }

    /**
     * Create a tool schema message
     */
    static createToolSchemaMessage(
        sessionId: string,
        channel: HAIPChannel,
        tool: string,
        schema: Record<string, any>
    ): HAIPMessage {
        return this.createMessage(sessionId, channel, "TOOL_SCHEMA", {
            tool,
            schema,
        });
    }

    /**
     * Create a flow update message
     */
    static createFlowUpdateMessage(
        sessionId: string,
        channel: string,
        addMessages?: number,
        addBytes?: number
    ): HAIPMessage {
        return this.createMessage(sessionId, "SYSTEM", "FLOW_UPDATE", {
            channel,
            ...(addMessages !== undefined && { add_messages: addMessages }),
            ...(addBytes !== undefined && { add_bytes: addBytes }),
        });
    }

    /**
     * Create a pause channel message
     */
    static createPauseChannelMessage(sessionId: string, channel: string): HAIPMessage {
        return this.createMessage(sessionId, "SYSTEM", "PAUSE_CHANNEL", {
            channel,
        });
    }

    /**
     * Create a resume channel message
     */
    static createResumeChannelMessage(sessionId: string, channel: string): HAIPMessage {
        return this.createMessage(sessionId, "SYSTEM", "RESUME_CHANNEL", {
            channel,
        });
    }

    /**
     * Create an error message
     */
    static createErrorMessage(
        sessionId: string,
        code: string,
        message: string,
        relatedId?: string,
        detail?: Record<string, any>
    ): HAIPMessage {
        return this.createMessage(sessionId, "SYSTEM", "ERROR", {
            code,
            message,
            ...(relatedId && { related_id: relatedId }),
            ...(detail && { detail }),
        });
    }

    /**
     * Parse JWT token without verification
     */
    static parseJWT(token: string): Record<string, any> | null {
        try {
            const parts = token.split(".");
            if (parts.length !== 3) {
                return null;
            }
            const payload = parts[1];
            if (!payload) {
                return null;
            }
            const decoded = Buffer.from(payload, "base64").toString("utf-8");
            return JSON.parse(decoded);
        } catch {
            return null;
        }
    }

    /**
     * Validate JWT token structure
     */
    static validateJWTStructure(token: string): boolean {
        const parsed = this.parseJWT(token);
        if (!parsed) {
            return false;
        }

        const requiredClaims = ["sub", "iss", "aud", "exp", "iat"];
        for (const claim of requiredClaims) {
            if (!(claim in parsed)) {
                return false;
            }
        }

        return true;
    }

    /**
     * Check if JWT token is expired
     */
    static isJWTExpired(token: string): boolean {
        const parsed = this.parseJWT(token);
        if (!parsed || !parsed["exp"]) {
            return true;
        }

        const now = Math.floor(Date.now() / 1000);
        return parsed["exp"] < now;
    }

    /**
     * Calculate exponential backoff delay
     */
    static calculateBackoffDelay(
        attempt: number,
        baseDelay: number = 1000,
        maxDelay: number = 30000
    ): number {
        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        return delay + Math.random() * 1000; // Add jitter
    }

    /**
     * Deep clone an object
     */
    static deepClone<T>(obj: T): T {
        if (obj === null || typeof obj !== "object") {
            return obj;
        }

        if (obj instanceof Date) {
            return new Date(obj.getTime()) as T;
        }

        if (obj instanceof Array) {
            return obj.map(item => this.deepClone(item)) as T;
        }

        if (typeof obj === "object") {
            const cloned = {} as T;
            for (const key in obj) {
                if (obj.hasOwnProperty(key)) {
                    cloned[key] = this.deepClone(obj[key]);
                }
            }
            return cloned;
        }

        return obj;
    }

    /**
     * Debounce function
     */
    static debounce<T extends (...args: any[]) => any>(
        func: T,
        wait: number
    ): (...args: Parameters<T>) => void {
        let timeout: NodeJS.Timeout;
        return (...args: Parameters<T>) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => func(...args), wait);
        };
    }

    /**
     * Throttle function
     */
    static throttle<T extends (...args: any[]) => any>(
        func: T,
        limit: number
    ): (...args: Parameters<T>) => void {
        let inThrottle: boolean;
        return (...args: Parameters<T>) => {
            if (!inThrottle) {
                func(...args);
                inThrottle = true;
                setTimeout(() => (inThrottle = false), limit);
            }
        };
    }

    /**
     * Retry function with exponential backoff
     */
    static async retry<T>(
        fn: () => Promise<T>,
        maxAttempts: number = 3,
        baseDelay: number = 1000
    ): Promise<T> {
        let lastError: Error;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error as Error;
                if (attempt === maxAttempts - 1) {
                    throw lastError;
                }
                const delay = this.calculateBackoffDelay(attempt, baseDelay);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        throw lastError!;
    }

    /**
     * Generate a random string
     */
    static randomString(length: number): string {
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        let result = "";
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    /**
     * Check if running in browser environment
     */
    static isBrowser(): boolean {
        return (
            typeof (globalThis as any).window !== "undefined" &&
            typeof (globalThis as any).window?.document !== "undefined"
        );
    }

    /**
     * Check if running in Node.js environment
     */
    static isNode(): boolean {
        return typeof process !== "undefined" && process.versions && !!process.versions.node;
    }

    /**
     * Convert string to base64
     */
    static toBase64(str: string): string {
        return Buffer.from(str, "utf-8").toString("base64");
    }

    /**
     * Convert base64 to string
     */
    static fromBase64(base64: string): string {
        return Buffer.from(base64, "base64").toString("utf-8");
    }

    /**
     * Convert ArrayBuffer to base64
     */
    static arrayBufferToBase64(buffer: ArrayBuffer): string {
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    /**
     * Convert base64 to ArrayBuffer
     */
    static base64ToArrayBuffer(base64: string): ArrayBuffer {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    }
}

export const HAIP_EVENT_TYPES = [
  "HAI",
  "PING",
  "PONG",
  "ERROR",
  "FLOW_UPDATE",
  "TRANSACTION_START",
  "TRANSACTION_END",
  // MAYBE GET RID OF?
  "RUN_STARTED",
  "RUN_FINISHED",
  "RUN_CANCEL",
  "RUN_ERROR",
  "REPLAY_REQUEST",
  "TEXT_MESSAGE_START",
  "TEXT_MESSAGE_PART",
  "TEXT_MESSAGE_END",
  "AUDIO_CHUNK",
  "TOOL_CALL",
  "TOOL_UPDATE",
  "TOOL_DONE",
  "TOOL_CANCEL",
  "TOOL_LIST",
  "TOOL_SCHEMA",
  "PAUSE_CHANNEL",
  "RESUME_CHANNEL"
] as const;