import {
    HAIPMessage,
    HAIPChannel,
    HAIPEventType,
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
    HAIPTransactionStartedPayload,
} from "haip";
import { v4 as uuidv4 } from "uuid";

export class HAIPServerUtils {
    static generateUUID(): string {
        return uuidv4();
    }

    static generateTimestamp(): string {
        return Date.now().toString();
    }

    static generateSequenceNumber(): string {
        return Date.now().toString() + Math.random().toString(36).substr(2, 9);
    }

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

        if (!this.validateChannel(message.channel)) {
            return false;
        }

        if (!this.validateEventType(message.type)) {
            return false;
        }

        if (typeof message.payload !== "object" || message.payload === null) {
            return false;
        }

        return true;
    }

    static validateChannel(channel: any): channel is HAIPChannel {
        const validChannels: HAIPChannel[] = ["USER", "AGENT", "SYSTEM", "AUDIO_IN", "AUDIO_OUT"];
        return validChannels.includes(channel);
    }

    static validateEventType(type: any): type is HAIPEventType {
        return HAIP_EVENT_TYPES.includes(type);
    }

    static createMessage(
        sessionId: string,
        transactionId: string | null,
        channel: HAIPChannel,
        type: HAIPEventType,
        payload: Record<string, any>,
        options: {
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
        } = {}
    ): HAIPMessage {
        const message: HAIPMessage = {
            id: options?.id || this.generateUUID(),
            transaction: transactionId || "null",
            session: sessionId,
            seq: options.seq || this.generateSequenceNumber(),
            ts: options.ts || this.generateTimestamp(),
            channel,
            type,
            payload,
        };

        if (options.ack !== undefined) message.ack = options.ack;
        if (options.pv !== undefined) message.pv = options.pv;
        if (options.crit !== undefined) message.crit = options.crit;
        if (options.bin_len !== undefined) message.bin_len = options.bin_len;
        if (options.bin_mime !== undefined) message.bin_mime = options.bin_mime;
        if (options.run_id !== undefined) message.run_id = options.run_id;
        if (options.thread_id !== undefined) message.thread_id = options.thread_id;

        return message;
    }

    static createHandshakeMessage(
        sessionId: string,
        payload: HAIPHandshakePayload,
        options: { last_rx_seq?: string } = {}
    ): HAIPMessage {
        return this.createMessage(sessionId, null, "SYSTEM", "HAI", {
            ...payload,
            last_rx_seq: options.last_rx_seq,
        });
    }

    static createTransactionStartMessage(
        sessionId: string,
        transactionId: string,
        payload: HAIPTransactionStartedPayload
    ): HAIPMessage {
        return this.createMessage(sessionId, transactionId, "SYSTEM", "TRANSACTION_START", payload);
    }
    /*
    static createRunStartedMessage(
        sessionId: string,
        payload: HAIPRunStartedPayload,
        runId?: string,
        threadId?: string
    ): HAIPMessage {
        return this.createMessage(sessionId, null, "SYSTEM", "RUN_STARTED", payload, {
            run_id: runId,
            thread_id: threadId,
        });
    }

    static createRunFinishedMessage(
        sessionId: string,
        payload: HAIPRunFinishedPayload,
        runId?: string
    ): HAIPMessage {
        return this.createMessage(sessionId, null, "SYSTEM", "RUN_FINISHED", payload, {
            run_id: runId,
        });
    }

    static createRunCancelMessage(
        sessionId: string,
        payload: HAIPRunCancelPayload,
        runId?: string
    ): HAIPMessage {
        return this.createMessage(sessionId, null, "SYSTEM", "RUN_CANCEL", payload, {
            run_id: runId,
        });
    }

    static createRunErrorMessage(
        sessionId: string,
        payload: HAIPRunErrorPayload,
        runId?: string
    ): HAIPMessage {
        return this.createMessage(sessionId, null, "SYSTEM", "RUN_ERROR", payload, {
            run_id: runId,
        });
    }
*/
    static createPingMessage(sessionId: string, payload: HAIPPingPayload): HAIPMessage {
        return this.createMessage(sessionId, null, "SYSTEM", "PING", payload);
    }

    static createPongMessage(sessionId: string, payload: HAIPPongPayload): HAIPMessage {
        return this.createMessage(sessionId, null, "SYSTEM", "PONG", payload);
    }
    /*
    static createReplayRequestMessage(
        sessionId: string,
        payload: HAIPReplayRequestPayload
    ): HAIPMessage {
        return this.createMessage(sessionId, null, "SYSTEM", "REPLAY_REQUEST", payload);
    }

    static createTextMessageStart(
        sessionId: string,
        transactionId: string,
        payload: HAIPTextMessageStartPayload,
        runId?: string,
        threadId?: string
    ): HAIPMessage {
        return this.createMessage(sessionId, transactionId, "USER", "MESSAGE_START", payload, {
            run_id: runId,
            thread_id: threadId,
        });
    }

    static createTextMessagePart(
        sessionId: string,
        transactionId: string,
        payload: HAIPTextMessagePartPayload,
        runId?: string,
        threadId?: string
    ): HAIPMessage {
        return this.createMessage(sessionId, transactionId, "USER", "MESSAGE_PART", payload, {
            run_id: runId,
            thread_id: threadId,
        });
    }

    static createTextMessageEnd(
        sessionId: string,
        transactionId: string,
        payload: HAIPTextMessageEndPayload,
        runId?: string,
        threadId?: string
    ): HAIPMessage {
        return this.createMessage(sessionId, transactionId, "USER", "MESSAGE_END", payload, {
            run_id: runId,
            thread_id: threadId,
        });
    }

    static createAudioChunkMessage(
        sessionId: string,
        payload: HAIPAudioChunkPayload,
        binaryLength?: number,
        mimeType?: string,
        runId?: string,
        threadId?: string
    ): HAIPMessage {
        return this.createMessage(sessionId, null, "AUDIO_IN", "AUDIO_CHUNK", payload, {
            bin_len: binaryLength,
            bin_mime: mimeType,
            run_id: runId,
            thread_id: threadId,
        });
    }

    static createToolCallMessage(
        sessionId: string,
        payload: HAIPToolCallPayload,
        runId?: string,
        threadId?: string
    ): HAIPMessage {
        return this.createMessage(sessionId, null, "AGENT", "TOOL_CALL", payload, {
            run_id: runId,
            thread_id: threadId,
        });
    }

    static createToolUpdateMessage(
        sessionId: string,
        payload: HAIPToolUpdatePayload,
        runId?: string,
        threadId?: string
    ): HAIPMessage {
        return this.createMessage(sessionId, null, "AGENT", "TOOL_UPDATE", payload, {
            run_id: runId,
            thread_id: threadId,
        });
    }

    static createToolDoneMessage(
        sessionId: string,
        payload: HAIPToolDonePayload,
        runId?: string,
        threadId?: string
    ): HAIPMessage {
        return this.createMessage(sessionId, null, "AGENT", "TOOL_DONE", payload, {
            run_id: runId,
            thread_id: threadId,
        });
    }

    static createToolCancelMessage(
        sessionId: string,
        payload: HAIPToolCancelPayload,
        runId?: string,
        threadId?: string
    ): HAIPMessage {
        return this.createMessage(sessionId, null, "AGENT", "TOOL_CANCEL", payload, {
            run_id: runId,
            thread_id: threadId,
        });
    }
*/
    static createToolListMessage(
        sessionId: string,
        transactionId: string | null,
        payload: HAIPToolListPayload
    ): HAIPMessage {
        return this.createMessage(sessionId, transactionId, "SYSTEM", "TOOL_LIST", payload);
    }

    static createToolSchemaMessage(
        sessionId: string,
        transactionId: string | null,
        payload: HAIPToolSchemaPayload
    ): HAIPMessage {
        return this.createMessage(sessionId, transactionId, "SYSTEM", "TOOL_SCHEMA", payload);
    }

    static createErrorMessage(
        sessionId: string,
        transactionId: string | null,
        payload: HAIPErrorPayload,
        relatedId?: string
    ): HAIPMessage {
        const message = this.createMessage(sessionId, transactionId, "SYSTEM", "ERROR", payload);
        if (relatedId) {
            (message as any).related_id = relatedId;
        }
        return message;
    }
    /*
    static createFlowUpdateMessage(sessionId: string, payload: HAIPFlowUpdatePayload): HAIPMessage {
        return this.createMessage(sessionId, null, "SYSTEM", "FLOW_UPDATE", payload);
    }

    static createPauseChannelMessage(
        sessionId: string,
        payload: HAIPChannelControlPayload
    ): HAIPMessage {
        return this.createMessage(sessionId, null, "SYSTEM", "PAUSE_CHANNEL", payload);
    }

    static createResumeChannelMessage(
        sessionId: string,
        payload: HAIPChannelControlPayload
    ): HAIPMessage {
        return this.createMessage(sessionId, null, "SYSTEM", "RESUME_CHANNEL", payload);
    }

    static parseJWT(token: string): { userId: string; exp: number; iat: number } | null {
        try {
            const base64Url = token.split(".")[1];
            const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
            const jsonPayload = decodeURIComponent(
                atob(base64)
                    .split("")
                    .map(c => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
                    .join("")
            );
            return JSON.parse(jsonPayload);
        } catch (error) {
            return null;
        }
    }

    static validateJWT(token: string): boolean {
        return true;
        //const payload = this.parseJWT(token);
        //if (!payload) {
        //    return false;
        //}

        //const now = Math.floor(Date.now() / 1000);
        //return payload.exp > now;
    }

    static getUserIdFromToken(token: string): string | null {
        return "1";
        //const payload = this.parseJWT(token);
        //return payload?.userId || null;
    }

    static calculateLatency(startTime: number): number {
        return Date.now() - startTime;
    }

    static formatBytes(bytes: number): string {
        if (bytes === 0) return "0 Bytes";
        const k = 1024;
        const sizes = ["Bytes", "KB", "MB", "GB"];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
    }

    static formatDuration(ms: number): string {
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        const minutes = Math.floor(ms / 60000);
        const seconds = ((ms % 60000) / 1000).toFixed(1);
        return `${minutes}m ${seconds}s`;
    }
        */
}

export const HAIP_EVENT_TYPES = [
    "HAI",
    "PING",
    "PONG",
    "ERROR",
    "FLOW_UPDATE",
    "TRANSACTION_START",
    "TRANSACTION_END",
    "REPLAY_REQUEST",
    "MESSAGE_START",
    "MESSAGE_PART",
    "MESSAGE_END",
    "AUDIO_CHUNK",
    "INFO",
    "TOOL_LIST",
    "TOOL_SCHEMA",
    //"PAUSE_CHANNEL",
    //"RESUME_CHANNEL"
] as const;
