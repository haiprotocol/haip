import { EventEmitter } from "events";
import {
    HAIPClient,
    HAIPConnectionConfig,
    HAIPConnectionState,
    HAIPEventHandlers,
    HAIPMessage,
    HAIPEventType,
    HAIPChannel,
    HAIPMessageOptions,
    HAIPRun,
    HAIPPerformanceMetrics,
    HAIPLogger,
    HAIPTransport,
    HAIPTransportType,
    HAIPTransportConfig,
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
    HAIPTransaction,
} from "haip";
import { HAIPUtils, HAIP_EVENT_TYPES } from "./utils";
import { WebSocketTransport } from "./transports/websocket";
import { SSETransport } from "./transports/sse";
import { HTTPStreamingTransport } from "./transports/http-streaming";
import { HaipTransaction } from "./transaction";

export class HAIPClientImpl extends EventEmitter implements HAIPClient {
    private config: HAIPConnectionConfig;
    private state: HAIPConnectionState;
    private transport: HAIPTransport;
    private handlers: HAIPEventHandlers = {};
    private logger: HAIPLogger;
    private heartbeatInterval: NodeJS.Timeout | undefined;
    private reconnectTimeout: NodeJS.Timeout | undefined;
    private performanceMetrics: HAIPPerformanceMetrics;
    private pendingAcks: Map<string, { timestamp: number; retries: number }> = new Map();
    private messageQueue: Map<HAIPChannel, HAIPMessage[]> = new Map();
    private runRegistry: Map<string, HAIPRun> = new Map();
    private authFn: () => Record<string, any>;
    private transactions: Map<string, HaipTransaction>;

    constructor(config: HAIPConnectionConfig) {
        super();
        this.config = {
            reconnectAttempts: 3,
            reconnectDelay: 1000,
            heartbeatInterval: 30000,
            heartbeatTimeout: 10000,
            flowControl: {
                enabled: true,
                initialCredits: 10,
                minCredits: 1,
                maxCredits: 100,
                creditThreshold: 5,
                backPressureThreshold: 0.8,
                adaptiveAdjustment: true,
            },
            maxConcurrentRuns: 5,
            replayWindowSize: 1000,
            replayWindowTime: 300000,
            ...config,
        };

        this.state = {
            connected: false,
            sessionId: config.sessionId || HAIPUtils.generateUUID(),
            handshakeCompleted: false,
            credits: new Map(),
            byteCredits: new Map(),
            pausedChannels: new Set(),
            pendingMessages: new Map(),
            lastHeartbeat: 0,
            reconnectAttempts: 0,
            lastAck: "",
            lastDeliveredSeq: "",
            //replayWindow: new Map(),
            activeRuns: new Set(),
        };

        this.performanceMetrics = {
            messagesSent: 0,
            messagesReceived: 0,
            messagesQueued: 0,
            averageLatency: 0,
            backPressureEvents: 0,
            reconnectAttempts: 0,
            lastUpdated: Date.now(),
            replayRequests: 0,
            droppedMessages: 0,
        };

        this.logger = {
            debug: (msg: string, ...args: any[]) => console.debug(`[HAIP] ${msg}`, ...args),
            info: (msg: string, ...args: any[]) => console.info(`[HAIP] ${msg}`, ...args),
            warn: (msg: string, ...args: any[]) => console.warn(`[HAIP] ${msg}`, ...args),
            error: (msg: string, ...args: any[]) => console.error(`[HAIP] ${msg}`, ...args),
        };

        this.authFn = () => {
            throw new Error("Authentication function not implemented");
        };
        this.transport = this.createTransport();
        this.setupTransportHandlers();
        this.initializeFlowControl();

        this.transactions = new Map<string, HaipTransaction>();
    }

    async startTransaction(
        toolName: string,
        toolParams?: Record<string, any>
    ): Promise<HAIPTransaction> {
        const tempTransactionId = HAIPUtils.generateUUID();

        const transactionMessage = HAIPUtils.createTransactionStartMessage(
            this.state.sessionId,
            tempTransactionId,
            toolName,
            this.authFn(),
            toolParams
        );

        const transaction = new HaipTransaction(tempTransactionId, toolName, toolParams);

        this.transactions.set(tempTransactionId, transaction);

        // Create the transaction with the server
        await this.sendMessage(transactionMessage);

        transaction.on("sendTextMessage", data => {
            const { text, options } = data;

            this.sendTextMessage(transaction.id, "USER", text);
        });

        // Wait for the response to mark the transaction as ready
        return new Promise<HaipTransaction>((resolve, reject) => {
            const onReady = () => {
                resolve(transaction);
            };
            transaction.once("started", onReady);
        });
    }

    authenticate(authFn: () => Record<string, any>): void {
        this.authFn = authFn;
    }

    private createTransport(): HAIPTransport {
        const transportConfig: HAIPTransportConfig = {
            type: "websocket",
            url: this.config.url,
            token: "", //this.config.token, //TODO no token here
            options: {},
        };

        switch (transportConfig.type) {
            case "websocket":
                return new WebSocketTransport(
                    transportConfig.url,
                    transportConfig.token,
                    transportConfig.options
                );
            case "sse":
                return new SSETransport(transportConfig);
            case "http-streaming":
                return new HTTPStreamingTransport(transportConfig);
            default:
                throw new Error(`Unsupported transport type: ${transportConfig.type}`);
        }
    }

    private setupTransportHandlers(): void {
        this.transport.onConnect(() => {
            this.logger.info("Transport connecting...");
            this.state.connected = true;
            this.state.reconnectAttempts = 0;
            this.emit("connect");
            this.handlers.onConnect?.();
            this.performHandshake();
        });

        this.transport.onDisconnect((reason: string) => {
            this.logger.warn("Transport disconnected:", reason);
            this.state.connected = false;
            this.state.handshakeCompleted = false;
            this.emit("disconnect", reason);
            this.handlers.onDisconnect?.(reason);
            this.handleDisconnection(reason);
        });

        this.transport.onError((error: Error) => {
            this.logger.error("Transport error:", error);
            this.emit("error", error);
            this.handlers.onError?.({ code: "TRANSPORT_ERROR", message: error.message });
        });

        this.transport.onMessage((message: HAIPMessage) => {
            this.handleMessage(message);
        });

        this.transport.onBinary((data: ArrayBuffer) => {
            this.handleBinaryData(data);
        });
    }

    private initializeFlowControl(): void {
        const channels: HAIPChannel[] = ["USER", "AGENT", "SYSTEM", "AUDIO_IN", "AUDIO_OUT"];
        channels.forEach(channel => {
            this.state.credits.set(channel, this.config.flowControl?.initialCredits || 10);
            this.state.byteCredits.set(
                channel,
                this.config.flowControl?.initialCreditBytes || 1024 * 1024
            );
            this.state.pendingMessages.set(channel, []);
        });
    }

    private async performHandshake(): Promise<void> {
        try {
            const capabilities = {
                binary_frames: true,
                flow_control: {
                    initial_credit_messages: this.config.flowControl?.initialCreditMessages || 10,
                    initial_credit_bytes:
                        this.config.flowControl?.initialCreditBytes || 1024 * 1024,
                },
                max_concurrent_runs: this.config.maxConcurrentRuns || 5,
                signed_envelopes: false,
            };

            const handshakeMessage = HAIPUtils.createHandshakeMessage(
                this.state.sessionId,
                this.authFn(),
                Array.from(HAIP_EVENT_TYPES) as HAIPEventType[],
                capabilities,
                this.state.lastAck
            );

            await this.sendMessage(handshakeMessage);
            this.logger.info("Handshake sent");
        } catch (error) {
            this.logger.error("Handshake failed:", error);
            this.emit("error", error as Error);
        }
    }

    private handleMessage(message: HAIPMessage): void {
        this.logger.debug("Received message:", message.type);
        this.performanceMetrics.messagesReceived++;
        this.performanceMetrics.lastUpdated = Date.now();

        if (!HAIPUtils.validateMessage(message)) {
            this.logger.error("Invalid message received");
            return;
        }

        this.updateAcknowledgment(message);

        const transactionId = message.transaction || null;
        const transaction = transactionId ? this.transactions.get(transactionId) : undefined;

        switch (message.type) {
            case "HAI":
            case "TRANSACTION_START":
                if (transactionId) {
                    this.handleTransactionStart(message);
                } else {
                    this.logger.warn("Received HAI message without transaction ID: ", message.type);
                }
                break;
            /*case "HAI":
                this.handleHandshake(message.payload);
                break;
            case "RUN_STARTED":
                this.handleRunStarted(message.payload as HAIPRunStartedPayload, message);
                break;
            case "RUN_FINISHED":
                this.handleRunFinished(message.payload as HAIPRunFinishedPayload, message);
                break;
            case "RUN_CANCEL":
                this.handleRunCancel(message.payload as HAIPRunCancelPayload, message);
                break;
            case "RUN_ERROR":
                this.handleRunError(message.payload as HAIPRunErrorPayload, message);
                break;
                */
            case "PING":
                this.handlePing(message.payload as HAIPPingPayload, message);
                break;
            case "PONG":
                this.handlePong(message.payload as HAIPPongPayload, message);
                break;
            /*
            case "REPLAY_REQUEST":
                this.handleReplayRequest(message.payload as HAIPReplayRequestPayload, message);
                break;
                */
            case "TEXT_MESSAGE_START":
            case "TEXT_MESSAGE_PART":
            case "TEXT_MESSAGE_END":
                if (transaction) {
                    console.log("Handling message for transaction:", transaction.id);
                    transaction.handleMessage(message, this.config);
                    return;
                } else {
                    this.logger.warn(
                        "Received text message without transaction ID: ",
                        message.type
                    );
                }
                break;
            /*
            case "AUDIO_CHUNK":
                this.handleAudioChunk(message.payload as HAIPAudioChunkPayload, message);
                break;
            case "TOOL_CALL":
                this.handleToolCall(message.payload as HAIPToolCallPayload, message);
                break;
            case "TOOL_UPDATE":
                this.handleToolUpdate(message.payload as HAIPToolUpdatePayload, message);
                break;
            case "TOOL_DONE":
                this.handleToolDone(message.payload as HAIPToolDonePayload, message);
                break;
            case "TOOL_CANCEL":
                this.handleToolCancel(message.payload as HAIPToolCancelPayload, message);
                break;
            case "TOOL_LIST":
                this.handleToolList(message.payload as HAIPToolListPayload, message);
                break;
            case "TOOL_SCHEMA":
                this.handleToolSchema(message.payload as HAIPToolSchemaPayload, message);
                break;
            */
            case "ERROR":
                this.handleError(message.payload as HAIPErrorPayload, message);
                break;
            /*
            case "FLOW_UPDATE":
                this.handleFlowUpdate(message.payload as HAIPFlowUpdatePayload, message);
                break;
            case "PAUSE_CHANNEL":
                this.handleChannelPaused(message.payload as HAIPChannelControlPayload, message);
                break;
            case "RESUME_CHANNEL":
                this.handleChannelResumed(message.payload as HAIPChannelControlPayload, message);
                break;*/
            default:
                this.logger.warn("Unknown message type:", message.type);
        }

        this.emit("message", message);
        this.handlers.onMessage?.(message);
    }

    private handleBinaryData(data: ArrayBuffer): void {
        this.logger.debug("Received binary data, size:", data.byteLength);
    }

    /*
    private handleHandshake(payload: any): void {
        this.logger.info("Handshake completed");
        this.state.handshakeCompleted = true;
        this.emit("handshake", payload);
        this.handlers.onHandshake?.(payload);
        this.startHeartbeat();
    }*/

    private handleTransactionStart(message: HAIPMessage): void {
        const transaction = this.transactions.get(message.payload.referenceId);

        if (transaction == null) {
            this.logger.error("Transaction not found for ID:", message.payload.referenceId);
            return;
        }

        transaction?.setId(message.transaction);

        this.transactions.delete(message.payload.referenceId);
        this.transactions.set(message.transaction, transaction);

        this.logger.info("Transaction started:", message.transaction);
    }

    /*

    private handleRunStarted(payload: HAIPRunStartedPayload, message: HAIPMessage): void {
        const runId = payload.run_id || message.run_id || HAIPUtils.generateUUID();
        const run: HAIPRun = {
            runId,
            threadId: payload.thread_id || message.thread_id,
            status: "active",
            startTime: Date.now(),
            metadata: payload.metadata,
            endTime: undefined,
            summary: undefined,
            error: undefined,
        };

        this.runRegistry.set(runId, run);
        this.state.activeRuns.add(runId);

        this.emit("runStarted", payload);
        this.handlers.onRunStarted?.(payload);
    }

    private handleRunFinished(payload: HAIPRunFinishedPayload, message: HAIPMessage): void {
        const runId = payload.run_id || message.run_id;
        if (runId) {
            const run = this.runRegistry.get(runId);
            if (run) {
                run.status =
                    payload.status === "OK"
                        ? "finished"
                        : payload.status === "CANCELLED"
                          ? "cancelled"
                          : "error";
                run.endTime = Date.now();
                run.summary = payload.summary;
                this.state.activeRuns.delete(runId);
            }
        }

        this.emit("runFinished", payload);
        this.handlers.onRunFinished?.(payload);
    }

    private handleRunCancel(payload: HAIPRunCancelPayload, message: HAIPMessage): void {
        const runId = payload.run_id;
        if (runId) {
            const run = this.runRegistry.get(runId);
            if (run) {
                run.status = "cancelled";
                run.endTime = Date.now();
                this.state.activeRuns.delete(runId);
            }
        }

        this.emit("runCancel", payload);
        this.handlers.onRunCancel?.(payload);
    }

    private handleRunError(payload: HAIPRunErrorPayload, message: HAIPMessage): void {
        const runId = payload.run_id || message.run_id;
        if (runId) {
            const run = this.runRegistry.get(runId);
            if (run) {
                run.status = "error";
                run.endTime = Date.now();
                run.error = payload.message;
                this.state.activeRuns.delete(runId);
            }
        }

        this.emit("runError", payload);
        this.handlers.onRunError?.(payload);
    }
*/
    private handlePing(payload: HAIPPingPayload, message: HAIPMessage): void {
        this.emit("ping", payload);
        this.handlers.onPing?.(payload);

        const pongMessage = HAIPUtils.createPongMessage(this.state.sessionId, payload.nonce);
        this.sendMessage(pongMessage).catch(error => {
            this.logger.error("Failed to send pong:", error);
        });
    }

    private handlePong(payload: HAIPPongPayload, message: HAIPMessage): void {
        const latency = Date.now() - this.state.lastHeartbeat;
        this.performanceMetrics.averageLatency =
            (this.performanceMetrics.averageLatency + latency) / 2;

        this.emit("pong", payload);
        this.handlers.onPong?.(payload);
        this.emit("heartbeat", latency);
        this.handlers.onHeartbeat?.(latency);
    }
    /*
    private handleReplayRequest(payload: HAIPReplayRequestPayload, message: HAIPMessage): void {
        this.performanceMetrics.replayRequests++;
        this.emit("replayRequest", payload);
        this.handlers.onReplayRequest?.(payload);

        this.sendReplayMessages(payload.from_seq, payload.to_seq);
    }

    private handleTextMessage(payload: any, message: HAIPMessage): void {
        this.emit("textMessage", payload);
        this.handlers.onTextMessage?.(payload);
    }

    private handleAudioChunk(payload: HAIPAudioChunkPayload, message: HAIPMessage): void {
        this.emit("audioChunk", payload);
        this.handlers.onAudioChunk?.(payload);
    }

    private handleToolCall(payload: HAIPToolCallPayload, message: HAIPMessage): void {
        this.emit("toolCall", payload);
        this.handlers.onToolCall?.(payload);
    }

    private handleToolUpdate(payload: HAIPToolUpdatePayload, message: HAIPMessage): void {
        this.emit("toolUpdate", payload);
        this.handlers.onToolUpdate?.(payload);
    }

    private handleToolDone(payload: HAIPToolDonePayload, message: HAIPMessage): void {
        this.emit("toolDone", payload);
        this.handlers.onToolDone?.(payload);
    }

    private handleToolCancel(payload: HAIPToolCancelPayload, message: HAIPMessage): void {
        this.emit("toolCancel", payload);
        this.handlers.onToolCancel?.(payload);
    }

    private handleToolList(payload: HAIPToolListPayload, message: HAIPMessage): void {
        this.emit("toolList", payload);
        this.handlers.onToolList?.(payload);
    }

    private handleToolSchema(payload: HAIPToolSchemaPayload, message: HAIPMessage): void {
        this.emit("toolSchema", payload);
        this.handlers.onToolSchema?.(payload);
    }
        */

    private handleError(payload: HAIPErrorPayload, message: HAIPMessage): void {
        this.logger.error("Protocol error:", payload);
        this.emit("error", payload);
        this.handlers.onError?.(payload);
    }

    /*
    private handleFlowUpdate(payload: HAIPFlowUpdatePayload, message: HAIPMessage): void {
        const channel = payload.channel as HAIPChannel;
        if (this.state.credits.has(channel)) {
            const currentCredits = this.state.credits.get(channel) || 0;
            const currentByteCredits = this.state.byteCredits.get(channel) || 0;

            this.state.credits.set(channel, currentCredits + (payload.add_messages || 0));
            this.state.byteCredits.set(channel, currentByteCredits + (payload.add_bytes || 0));

            this.processPendingMessages(channel);
        }

        this.emit("flowUpdate", payload);
        this.handlers.onFlowUpdate?.(payload);
    }

    private handleChannelPaused(payload: HAIPChannelControlPayload, message: HAIPMessage): void {
        const channel = payload.channel as HAIPChannel;
        this.state.pausedChannels.add(channel);
        this.emit("channelPaused", channel);
        this.handlers.onChannelPaused?.(channel);
    }

    private handleChannelResumed(payload: HAIPChannelControlPayload, message: HAIPMessage): void {
        const channel = payload.channel as HAIPChannel;
        this.state.pausedChannels.delete(channel);
        this.emit("channelResumed", channel);
        this.handlers.onChannelResumed?.(channel);
        this.processPendingMessages(channel);
    }*/

    private updateAcknowledgment(message: HAIPMessage): void {
        if (message.ack) {
            this.state.lastAck = message.ack;
            this.pendingAcks.delete(message.ack);
        }

        this.state.lastDeliveredSeq = message.seq;
    }

    private handleDisconnection(reason: string): void {
        this.stopHeartbeat();
        this.clearReconnectTimeout();

        if (this.state.reconnectAttempts < (this.config.reconnectAttempts || 3)) {
            this.scheduleReconnection();
        } else {
            this.logger.error("Max reconnection attempts reached");
            this.emit("maxReconnectAttemptsReached");
        }
    }

    private scheduleReconnection(): void {
        const delay = HAIPUtils.calculateBackoffDelay(
            this.state.reconnectAttempts,
            this.config.reconnectDelay || 1000
        );

        this.logger.info(
            `Scheduling reconnection in ${delay}ms (attempt ${this.state.reconnectAttempts + 1})`
        );

        this.reconnectTimeout = setTimeout(() => {
            this.state.reconnectAttempts++;
            this.performanceMetrics.reconnectAttempts++;
            this.connect();
        }, delay);
    }

    private clearReconnectTimeout(): void {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }
    }
    /*
    private startHeartbeat(): void {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }

        const interval = this.config.heartbeatInterval || 30000;
        this.heartbeatInterval = setInterval(() => {
            this.sendHeartbeat();
        }, interval);
    }
*/
    private stopHeartbeat(): void {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = undefined;
        }
    }
    /*
    private async sendHeartbeat(): Promise<void> {
        if (!this.state.connected) {
            return;
        }

        try {
            const nonce = HAIPUtils.randomString(8);
            const pingMessage = HAIPUtils.createPingMessage(this.state.sessionId, nonce);
            this.state.lastHeartbeat = Date.now();
            await this.sendMessage(pingMessage);
        } catch (error) {
            this.logger.error("Failed to send heartbeat:", error);
        }
    }

    private processPendingMessages(channel: HAIPChannel): void {
        if (this.state.pausedChannels.has(channel)) {
            return;
        }

        const pending = this.state.pendingMessages.get(channel) || [];
        const credits = this.state.credits.get(channel) || 0;
        const byteCredits = this.state.byteCredits.get(channel) || 0;

        while (pending.length > 0 && credits > 0) {
            const pendingMsg = pending.shift()!;
            const messageSize = HAIPUtils.calculateMessageSize(pendingMsg.message);

            if (messageSize <= byteCredits) {
                this.sendMessage(pendingMsg.message).catch(error => {
                    this.logger.error("Failed to send pending message:", error);
                });

                this.state.credits.set(channel, credits - 1);
                this.state.byteCredits.set(channel, byteCredits - messageSize);
            } else {
                pending.unshift(pendingMsg);
                break;
            }
        }
    }*/

    async connect(): Promise<void> {
        if (this.state.connected) {
            return;
        }

        try {
            await this.transport.connect();
        } catch (error) {
            this.logger.error("Connection failed:", error);
            throw error;
        }
    }

    async disconnect(): Promise<void> {
        this.stopHeartbeat();
        this.clearReconnectTimeout();
        this.state.connected = false;
        this.state.handshakeCompleted = false;

        this.state.reconnectAttempts = (this.config.reconnectAttempts || 3) + 1;

        try {
            await this.transport.disconnect();
        } catch (error) {
            this.logger.error("Disconnect error:", error);
        }
    }

    async sendMessage(message: HAIPMessage, options?: HAIPMessageOptions): Promise<void> {
        if (!this.state.connected) {
            throw new Error("Not connected");
        }

        const channel = message.channel;
        const messageSize = HAIPUtils.calculateMessageSize(message);
        const credits = this.state.credits.get(channel) || 0;
        const byteCredits = this.state.byteCredits.get(channel) || 0;

        if (this.state.pausedChannels.has(channel)) {
            this.state.pendingMessages.get(channel)?.push({
                message,
                timestamp: Date.now(),
                retries: 0,
            });
            this.performanceMetrics.messagesQueued++;
            return;
        }

        if (credits <= 0 || messageSize > byteCredits) {
            this.state.pendingMessages.get(channel)?.push({
                message,
                timestamp: Date.now(),
                retries: 0,
            });
            this.performanceMetrics.messagesQueued++;
            this.performanceMetrics.backPressureEvents++;
            return;
        }

        try {
            await this.transport.send(message);
            this.performanceMetrics.messagesSent++;

            this.state.credits.set(channel, credits - 1);
            this.state.byteCredits.set(channel, byteCredits - messageSize);
        } catch (error) {
            this.logger.error("Failed to send message:", error);
            throw error;
        }
    }
    /*
    async sendBinary(data: ArrayBuffer): Promise<void> {
        if (!this.state.connected) {
            throw new Error("Not connected");
        }

        try {
            await this.transport.sendBinary(data);
        } catch (error) {
            this.logger.error("Failed to send binary data:", error);
            throw error;
        }
    }

    async startRun(threadId?: string, metadata?: Record<string, any>): Promise<string> {
        const runId = HAIPUtils.generateUUID();
        const message = HAIPUtils.createRunStartedMessage(
            this.state.sessionId,
            runId,
            threadId,
            metadata
        );

        await this.sendMessage(message);
        return runId;
    }

    async finishRun(
        runId: string,
        status?: "OK" | "CANCELLED" | "ERROR",
        summary?: string
    ): Promise<void> {
        const message = HAIPUtils.createRunFinishedMessage(
            this.state.sessionId,
            runId,
            status,
            summary
        );

        await this.sendMessage(message);
    }

    async cancelRun(runId: string): Promise<void> {
        const message = HAIPUtils.createRunCancelMessage(this.state.sessionId, runId);

        await this.sendMessage(message);
    }

    */
    async sendTextMessage(
        transactionId: string,
        channel: HAIPChannel,
        text: string,
        author?: string,
        runId?: string,
        threadId?: string
    ): Promise<string> {
        const messageId = HAIPUtils.generateUUID();

        const startMessage = HAIPUtils.createTextMessageStartMessage(
            this.state.sessionId,
            transactionId,
            channel,
            messageId,
            author
        );

        if (runId) startMessage.run_id = runId;
        if (threadId) startMessage.thread_id = threadId;

        await this.sendMessage(startMessage);

        const chunks = this.chunkText(text, 1000);
        for (const chunk of chunks) {
            const partMessage = HAIPUtils.createTextMessagePartMessage(
                this.state.sessionId,
                transactionId,
                channel,
                messageId,
                chunk
            );

            if (runId) partMessage.run_id = runId;
            if (threadId) partMessage.thread_id = threadId;

            await this.sendMessage(partMessage);
        }

        const endMessage = HAIPUtils.createTextMessageEndMessage(
            this.state.sessionId,
            transactionId,
            channel,
            messageId
        );

        if (runId) endMessage.run_id = runId;
        if (threadId) endMessage.thread_id = threadId;

        await this.sendMessage(endMessage);

        return messageId;
    }
    /*
    async sendAudioChunk(
        channel: HAIPChannel,
        messageId: string,
        mime: string,
        data: ArrayBuffer,
        durationMs?: number,
        runId?: string,
        threadId?: string
    ): Promise<void> {
        const base64Data = HAIPUtils.arrayBufferToBase64(data);
        const message = HAIPUtils.createAudioChunkMessage(
            this.state.sessionId,
            channel,
            messageId,
            mime,
            base64Data,
            durationMs?.toString()
        );

        if (runId) message.run_id = runId;
        if (threadId) message.thread_id = threadId;
        message.bin_len = data.byteLength;
        message.bin_mime = mime;

        await this.sendMessage(message);
    }

    async callTool(
        channel: HAIPChannel,
        tool: string,
        params?: Record<string, any>,
        runId?: string,
        threadId?: string
    ): Promise<string> {
        const callId = HAIPUtils.generateUUID();
        const message = HAIPUtils.createToolCallMessage(
            this.state.sessionId,
            channel,
            callId,
            tool,
            params
        );

        if (runId) message.run_id = runId;
        if (threadId) message.thread_id = threadId;

        await this.sendMessage(message);
        return callId;
    }

    async updateTool(
        channel: HAIPChannel,
        callId: string,
        status: "QUEUED" | "RUNNING" | "CANCELLING",
        progress?: number,
        partial?: any,
        runId?: string,
        threadId?: string
    ): Promise<void> {
        const message = HAIPUtils.createToolUpdateMessage(
            this.state.sessionId,
            channel,
            callId,
            status,
            progress,
            partial
        );

        if (runId) message.run_id = runId;
        if (threadId) message.thread_id = threadId;

        await this.sendMessage(message);
    }

    async completeTool(
        channel: HAIPChannel,
        callId: string,
        status?: "OK" | "CANCELLED" | "ERROR",
        result?: any,
        runId?: string,
        threadId?: string
    ): Promise<void> {
        const message = HAIPUtils.createToolDoneMessage(
            this.state.sessionId,
            channel,
            callId,
            status,
            result
        );

        if (runId) message.run_id = runId;
        if (threadId) message.thread_id = threadId;

        await this.sendMessage(message);
    }

    async cancelTool(
        channel: HAIPChannel,
        callId: string,
        reason?: string,
        runId?: string,
        threadId?: string
    ): Promise<void> {
        const message = HAIPUtils.createToolCancelMessage(
            this.state.sessionId,
            channel,
            callId,
            reason
        );

        if (runId) message.run_id = runId;
        if (threadId) message.thread_id = threadId;

        await this.sendMessage(message);
    }

    async listTools(
        channel: HAIPChannel,
        tools: Array<{ name: string; description?: string }>
    ): Promise<void> {
        const message = HAIPUtils.createToolListMessage(this.state.sessionId, channel, tools);

        await this.sendMessage(message);
    }

    async sendToolSchema(
        channel: HAIPChannel,
        tool: string,
        schema: Record<string, any>
    ): Promise<void> {
        const message = HAIPUtils.createToolSchemaMessage(
            this.state.sessionId,
            channel,
            tool,
            schema
        );

        await this.sendMessage(message);
    }

    async requestReplay(fromSeq: string, toSeq?: string): Promise<void> {
        const message = HAIPUtils.createReplayRequestMessage(this.state.sessionId, fromSeq, toSeq);

        await this.sendMessage(message);
    }

    async pauseChannel(channel: string): Promise<void> {
        const message = HAIPUtils.createPauseChannelMessage(this.state.sessionId, channel);

        await this.sendMessage(message);
    }

    async resumeChannel(channel: string): Promise<void> {
        const message = HAIPUtils.createResumeChannelMessage(this.state.sessionId, channel);

        await this.sendMessage(message);
    }

    async sendFlowUpdate(channel: string, addMessages?: number, addBytes?: number): Promise<void> {
        const message = HAIPUtils.createFlowUpdateMessage(
            this.state.sessionId,
            channel,
            addMessages,
            addBytes
        );

        await this.sendMessage(message);
    }

    override on(event: string, handler: (...args: any[]) => void): this {
        super.on(event, handler);
        return this;
    }

    setHandlers(handlers: HAIPEventHandlers): void {
        this.handlers = { ...this.handlers, ...handlers };
    }

    getConnectionState(): HAIPConnectionState {
        return HAIPUtils.deepClone(this.state);
    }

    getPerformanceMetrics(): HAIPPerformanceMetrics {
        return HAIPUtils.deepClone(this.performanceMetrics);
    }

    getActiveRuns(): HAIPRun[] {
        return Array.from(this.runRegistry.values()).filter(run => run.status === "active");
    }

    getRun(runId: string): HAIPRun | undefined {
        return this.runRegistry.get(runId);
    }

    isConnected(): boolean {
        return this.state.connected && this.state.handshakeCompleted;
    }
*/
    private chunkText(text: string, maxChunkSize: number): string[] {
        const chunks: string[] = [];
        for (let i = 0; i < text.length; i += maxChunkSize) {
            chunks.push(text.slice(i, i + maxChunkSize));
        }
        return chunks;
    }
}
