import express from "express";
import { createServer } from "http";
import WebSocket from "ws";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import { EventEmitter } from "events";
import {
    HAIPServerConfig,
    HAIPSession,
    HAIPMessage,
    HAIPChannel,
    HAIPServerStats,
    HAIPHandshakePayload,
    HAIPRun,
    HAIPToolExecution,
    HAIPTool,
    HAIPToolSchema,
    HAIPEventType,
    HAIPClient,
    HAIPSessionTransaction,
} from "haip";
import { HAIPServerUtils, HAIP_EVENT_TYPES } from "./utils";

export class HAIPServer extends EventEmitter {
    private app: express.Application;
    private server: any;
    private wss: WebSocket.Server;
    private config: HAIPServerConfig;
    private sessions: Map<string, HAIPSession> = new Map();
    private runs: Map<string, HAIPRun> = new Map();
    private tools: Map<string, HAIPTool> = new Map();
    private toolExecutions: Map<string, HAIPToolExecution> = new Map();
    private stats: HAIPServerStats;
    private startTime: number;
    private statsInterval: NodeJS.Timeout | null = null;
    private heartbeatIntervals: Map<string, NodeJS.Timeout> = new Map();
    private authFn: (req: any) => string | null;

    constructor(config: Partial<HAIPServerConfig> = {}) {
        super();

        this.startTime = Date.now();
        this.config = {
            port: 8080,
            host: "0.0.0.0",
            jwtSecret: "your-secret-key",
            jwtExpiresIn: "24h",
            maxConnections: 1000,
            heartbeatInterval: 30000,
            heartbeatTimeout: 5000,
            flowControl: {
                enabled: true,
                initialCredits: 1000,
                minCredits: 100,
                maxCredits: 10000,
                creditThreshold: 200,
                backPressureThreshold: 0.8,
                adaptiveAdjustment: true,
                initialCreditMessages: 1000,
                initialCreditBytes: 1024 * 1024,
            },
            maxConcurrentRuns: 10,
            replayWindowSize: 1000,
            replayWindowTime: 60000,
            enableCORS: true,
            enableCompression: true,
            enableLogging: true,
            ...config,
        };

        this.stats = {
            totalConnections: 0,
            activeConnections: 0,
            totalMessages: 0,
            messagesPerSecond: 0,
            averageLatency: 0,
            errorRate: 0,
            uptime: 0,
        };

        this.app = express();
        this.setupMiddleware();
        this.setupRoutes();
        this.server = createServer(this.app);
        this.wss = new WebSocket.Server({ server: this.server });
        this.setupWebSocket();
        this.setupDefaultTools();
        this.startStatsUpdate();
        this.authFn = () => {
            throw new Error("Authentication function not implemented");
        };
    }

    private setupMiddleware(): void {
        if (this.config.enableCORS) {
            this.app.use(cors());
        }

        this.app.use(helmet());

        if (this.config.enableCompression) {
            this.app.use(compression());
        }

        if (this.config.enableLogging) {
            this.app.use(morgan("combined"));
        }

        this.app.use(express.json({ limit: "10mb" }));
        this.app.use(express.urlencoded({ extended: true, limit: "10mb" }));
    }

    private setupRoutes(): void {
        this.app.get("/health", (req, res) => {
            res.json({
                status: "ok",
                uptime: this.stats.uptime,
                activeConnections: this.stats.activeConnections,
                totalConnections: this.stats.totalConnections,
            });
        });

        this.app.get("/stats", (req, res) => {
            res.json(this.stats);
        });

        this.app.get("/haip/sse", (req, res) => {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Cache-Control",
            });

            const session = this.createSession();
            const sessionId = session.id;

            const handshake = this.createHandshakeResponse(sessionId);
            res.write(`data: ${JSON.stringify(handshake)}\n\n`);

            req.on("close", () => {
                this.handleDisconnect(sessionId);
            });

            session.sseResponse = res;
        });

        this.app.post("/haip/stream", (req, res) => {
            // TODO - they might be reconnecting to a session
            const session = this.createSession();
            const sessionId = session.id;
            session.req = req;
            session.httpResponse = res;

            res.writeHead(200, {
                "Content-Type": "application/json",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            });

            const handshake = this.createHandshakeResponse(sessionId);
            res.write(JSON.stringify(handshake) + "\n");

            req.on("close", () => {
                this.handleDisconnect(sessionId);
            });

            req.on("data", chunk => {
                try {
                    const messages = chunk
                        .toString()
                        .split("\n")
                        .filter((line: string) => line.trim());
                    for (const messageStr of messages) {
                        const message = JSON.parse(messageStr);
                        this.handleMessage(sessionId, message);
                    }
                } catch (error) {
                    console.error("Error parsing HTTP stream message:", error);
                }
            });
        });
    }

    private setupWebSocket(): void {
        this.wss.on("connection", (ws: WebSocket, req: any) => {
            const url = new URL(req.url, `http://${req.headers.host}`);

            const session = this.createSession();
            const sessionId = session.id;
            session.ws = ws;

            this.stats.totalConnections++;
            this.stats.activeConnections++;

            this.emit("connect", sessionId);

            const handshake = this.createHandshakeResponse(sessionId);
            ws.send(JSON.stringify(handshake));

            ws.on("message", (data: WebSocket.Data) => {
                try {
                    let messageStr: string;

                    if (typeof data === "string") {
                        messageStr = data;
                    } else if (data instanceof Buffer) {
                        messageStr = data.toString("utf8");
                    } else {
                        this.handleBinaryData(sessionId, data as Buffer);
                        return;
                    }

                    const message = JSON.parse(messageStr);
                    this.handleMessage(sessionId, message);
                } catch (error) {
                    console.error("Error handling WebSocket message:", error);
                    if (data instanceof Buffer) {
                        this.handleBinaryData(sessionId, data);
                    } else {
                        this.sendError(
                            sessionId,
                            null,
                            "INVALID_MESSAGE",
                            "Invalid message format"
                        );
                    }
                }
            });

            ws.on("close", (code: number, reason: Buffer) => {
                console.log(`WebSocket closing. Code: ${code}, Reason: ${reason.toString()}`);
                this.handleDisconnect(sessionId);
            });

            ws.on("error", error => {
                console.error("WebSocket error:", error);
                this.handleDisconnect(sessionId);
            });

            this.setupHeartbeat(sessionId);
        });
    }

    private createSession(): HAIPSession {
        const sessionId = HAIPServerUtils.generateUUID();
        const session: HAIPSession = {
            id: sessionId,
            userId: null,
            connected: true,
            handshakeCompleted: false,
            lastActivity: Date.now(),
            credits: new Map([
                ["USER", this.config.flowControl.initialCredits],
                ["AGENT", this.config.flowControl.initialCredits],
                ["SYSTEM", this.config.flowControl.initialCredits],
                ["AUDIO_IN", this.config.flowControl.initialCredits],
                ["AUDIO_OUT", this.config.flowControl.initialCredits],
            ]),
            byteCredits: new Map([
                ["USER", this.config.flowControl.initialCreditBytes || 1024 * 1024],
                ["AGENT", this.config.flowControl.initialCreditBytes || 1024 * 1024],
                ["SYSTEM", this.config.flowControl.initialCreditBytes || 1024 * 1024],
                ["AUDIO_IN", this.config.flowControl.initialCreditBytes || 1024 * 1024],
                ["AUDIO_OUT", this.config.flowControl.initialCreditBytes || 1024 * 1024],
            ]),
            lastAck: "",
            lastDeliveredSeq: "",
            activeRuns: new Set(),
            pendingMessages: new Map(),
            transactions: new Map(),
        };

        this.sessions.set(sessionId, session);
        return session;
    }

    private createHandshakeResponse(sessionId: string): HAIPMessage {
        const payload: HAIPHandshakePayload = {
            haip_version: "1.1.2",
            accept_major: [1],
            accept_events: Array.from(HAIP_EVENT_TYPES) as HAIPEventType[],
            capabilities: {
                binary_frames: true,
                flow_control: {
                    initial_credit_messages: this.config.flowControl.initialCreditMessages || 1000,
                    initial_credit_bytes: this.config.flowControl.initialCreditBytes || 1024 * 1024,
                },
                max_concurrent_runs: this.config.maxConcurrentRuns,
                signed_envelopes: false,
            },
        };

        return HAIPServerUtils.createHandshakeMessage(sessionId, payload);
    }

    private handleMessage(sessionId: string, message: any): void {
        this.handleAuthentication(sessionId, message);

        if (!HAIPServerUtils.validateMessage(message)) {
            console.log("Invalid message:", message);
            this.sendError(
                sessionId,
                message.transaction,
                "INVALID_MESSAGE",
                "Invalid message format"
            );
            return;
        }

        const session = this.sessions.get(sessionId);
        if (!session) {
            console.log("Session not found for ID:", sessionId);
            return;
        }

        session.lastActivity = Date.now();
        this.stats.totalMessages++;

        if (this.config.flowControl.enabled) {
            if (!this.checkFlowControl(sessionId, message)) {
                return;
            }
        }

        const transactionId = message.transaction || null;
        const transaction = transactionId ? session.transactions.get(transactionId) : undefined;

        if (transaction) {
            transaction.replayWindow.set(message.seq, message);
        }

        switch (message.type) {
            case "HAI":
                //console.log("Duplicate HAI:", message.type);
                //this.sendError(sessionId, "Ignoring HAI", "You have already sent HAI");
                break;
            case "TRANSACTION_START":
                this.handleTransactionStart(sessionId, message);
                break;
            case "PING":
                console.log("Routing to handlePing");
                this.handlePing(sessionId, message);
                break;
            case "PONG":
                break;
            case "REPLAY_REQUEST":
                if (!transaction || !transactionId) {
                    console.log("transaction not found for ID:", transactionId);
                    this.sendError(
                        sessionId,
                        transactionId,
                        "TRANSACTION_NOT_FOUND",
                        "Transaction not found"
                    );
                    return;
                }
                this.handleReplayRequest({ transactionId, sessionId }, message);
                break;
            case "MESSAGE_START":
            case "MESSAGE_PART":
            case "MESSAGE_END":
                if (!transaction || !transactionId) {
                    console.log("transaction not found for ID:", transactionId);
                    this.sendError(
                        sessionId,
                        transactionId,
                        "TRANSACTION_NOT_FOUND",
                        "Transaction not found"
                    );
                    return;
                }

                const tool = this.tools.get(transaction!.toolName);
                if (tool) {
                    tool.handleMessage(
                        { sessionId: sessionId, transactionId: transactionId },
                        message
                    );
                }
                break;

            case "AUDIO_CHUNK":
                if (!transaction || !transactionId) {
                    console.log("transaction not found for ID:", transactionId);
                    this.sendError(
                        sessionId,
                        transactionId,
                        "TRANSACTION_NOT_FOUND",
                        "Transaction not found"
                    );
                    return;
                }

                const tool_audio = this.tools.get(transaction!.toolName);
                if (tool_audio) {
                    tool_audio.handleAudioChunk(
                        { sessionId: sessionId, transactionId: transactionId },
                        message
                    );
                }
                break;
            case "INFO":
                console.log(
                    "INFO message received:",
                    message,
                    " - ",
                    transactionId,
                    "(",
                    sessionId,
                    ")"
                );
                break;
            case "ERROR":
                console.error(
                    "ERROR message received:",
                    message,
                    " - ",
                    transactionId,
                    "(",
                    sessionId,
                    ")"
                );
                break;
            case "TRANSACTION_END":
                if (!transaction || !transactionId) {
                    console.log("transaction not found for ID:", transactionId);
                    this.sendError(sessionId, transactionId, "ERROR", "Transaction not found");
                    return;
                }
                break;
            case "TOOL_LIST":
                const toolNames = Array.from(this.tools.values()).map(tool => ({
                    name: tool.schema().name,
                    description: tool.schema().description,
                }));
                const toolListMessage = HAIPServerUtils.createToolListMessage(
                    sessionId,
                    transactionId,
                    {
                        tools: toolNames,
                    }
                );
                this.sendMessage(sessionId, toolListMessage);
                break;
            case "TOOL_SCHEMA":
                // Optionally handle TOOL_SCHEMA messages here
                break;
            case "FLOW_UPDATE":
                // Optionally handle FLOW_UPDATE messages here
                break;
            default:
                console.warn("Unknown message type:", message.type);
                this.sendError(
                    sessionId,
                    message.transaction || null,
                    "UNSUPPORTED_TYPE",
                    `Unknown message type: ${message.type}`
                );
                break;
        }
    }

    private handleBinaryData(sessionId: string, data: Buffer): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return;
        }

        this.emit("binary", sessionId, data);
    }

    private handleAuthentication(sessionId: string, message: HAIPMessage): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            console.log("Session not found for ID:", sessionId);
            throw new Error("Session not found");
        }

        if (session.userId === null) {
            if (!HAIPServerUtils.validateMessage(message)) {
                console.log("Invalid message:", message);
                this.sendError(sessionId, null, "INVALID_MESSAGE", "Invalid message format");
                session.ws?.close(1008, "Invalid token");
                session.req?.close();
                throw new Error("Invalid Message");
            } else {
                if (message.type === "HAI") {
                    const userId = this.authFn(message.payload.auth);

                    if (userId === null) {
                        console.log("Invalid message:", message);
                        this.sendError(sessionId, null, "FAILED_AUTH", "Failed Auth");
                        session.ws?.close(1008, "Invalid token");
                        session.req?.close();
                        throw new Error("Failed Auth");
                    }

                    session.userId = userId;
                    session.handshakeCompleted = true;
                    this.emit("handshake", sessionId, message.payload);
                    // Success
                    return;
                } else {
                    this.sendError(sessionId, null, "NOT HAI", "First message needs to be HAI");
                    session.ws?.close(1008, "Invalid token");
                    session.req?.close();
                    throw new Error("Not HAI");
                }
            }
        }
    }

    private handleTransactionStart(sessionId: string, message: HAIPMessage): void {
        const session = this.sessions.get(sessionId);

        if (!session) {
            return;
        }

        const toolName = message.payload.toolName || null;

        if (!toolName) {
            this.sendError(
                sessionId,
                message.transaction,
                "MISSING_TOOL_NAME",
                "Tool name is required"
            );
            return;
        }

        const tool = this.tools.get(toolName);
        if (!tool) {
            this.sendError(
                sessionId,
                message.transaction,
                "TOOL_NOT_FOUND",
                `Tool ${toolName} not found`
            );
            return;
        }

        const referenceId = message.transaction;
        const transactionId = HAIPServerUtils.generateUUID();

        console.info(
            `Starting transaction ${transactionId} for session ${sessionId} with tool ${toolName}`
        );

        session.transactions.set(transactionId, {
            id: transactionId,
            status: "started",
            toolName: toolName,
            toolParams: message.payload.params || {},
            replayWindow: new Map(),
        });

        this.sendMessage(
            sessionId,
            HAIPServerUtils.createTransactionStartMessage(sessionId, transactionId, {
                referenceId: referenceId,
            })
        );
    }

    private handlePing(sessionId: string, message: HAIPMessage): void {
        console.log(
            "handlePing called for session:",
            sessionId,
            "with nonce:",
            message.payload.nonce
        );
        const pong = HAIPServerUtils.createPongMessage(sessionId, {
            nonce: message.payload.nonce,
        });
        console.log("Created pong message:", JSON.stringify(pong));
        this.sendMessage(sessionId, pong);
        console.log("Pong message sent");
    }

    private handleReplayRequest(client: HAIPSessionTransaction, message: HAIPMessage): void {
        const session = this.sessions.get(client.sessionId);
        if (!session) {
            return;
        }

        const transaction = session.transactions.get(message.transaction || "");

        if (!transaction) {
            this.sendError(
                client.sessionId,
                message.transaction,
                "TRANSACTION_NOT_FOUND",
                "Transaction not found"
            );
            return;
        }

        const fromSeq = message.payload.from_seq;
        const toSeq = message.payload.to_seq;

        for (const [seq, msg] of transaction.replayWindow) {
            if (seq >= fromSeq && (!toSeq || seq <= toSeq)) {
                this.sendMessage(client.sessionId, msg);
            }
        }
    }

    private checkFlowControl(sessionId: string, message: HAIPMessage): boolean {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return false;
        }

        const channel = message.channel;
        const credits = session.credits.get(channel) || 0;

        if (credits <= 0) {
            this.sendError(
                sessionId,
                message.transaction,
                "INSUFFICIENT_CREDITS",
                "Insufficient credits for channel"
            );
            return false;
        }

        session.credits.set(channel, credits - 1);
        return true;
    }

    private sendError(
        sessionId: string,
        transactionId: string | null,
        code: string,
        message: string
    ): void {
        const error = HAIPServerUtils.createErrorMessage(sessionId, transactionId, {
            code,
            message,
        });
        this.sendMessage(sessionId, error);
    }

    private setupHeartbeat(sessionId: string): void {
        const interval = setInterval(() => {
            const session = this.sessions.get(sessionId);
            if (!session || !session.connected) {
                clearInterval(interval);
                return;
            }

            const ping = HAIPServerUtils.createPingMessage(sessionId, {
                nonce: HAIPServerUtils.generateUUID(),
            });
            this.sendMessage(sessionId, ping);
        }, this.config.heartbeatInterval);
        this.heartbeatIntervals.set(sessionId, interval);
    }

    private handleDisconnect(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.connected = false;
            this.stats.activeConnections--;
        }

        this.sessions.delete(sessionId);
        this.emit("disconnect", sessionId);

        const interval = this.heartbeatIntervals.get(sessionId);
        if (interval) {
            clearInterval(interval);
            this.heartbeatIntervals.delete(sessionId);
        }
    }

    private setupDefaultTools(): void {
        /*this.registerTool({
            name: "echo",
            description: "Echo back the input",
            inputSchema: {
                type: "object",
                properties: {
                    message: { type: "string" },
                },
                required: ["message"],
            },
            outputSchema: {
                type: "object",
                properties: {
                    echoed: { type: "string" },
                },
            },
        });

        this.registerTool({
            name: "add",
            description: "Add two numbers",
            inputSchema: {
                type: "object",
                properties: {
                    a: { type: "number" },
                    b: { type: "number" },
                },
                required: ["a", "b"],
            },
            outputSchema: {
                type: "object",
                properties: {
                    result: { type: "number" },
                },
            },
        });*/
    }

    private startStatsUpdate(): void {
        this.statsInterval = setInterval(() => {
            this.stats.uptime = Date.now() - this.startTime;
            this.stats.activeConnections = this.sessions.size;

            if (this.stats.uptime > 0) {
                this.stats.messagesPerSecond =
                    this.stats.totalMessages / (this.stats.uptime / 1000);
            }
        }, 1000);
    }

    public authenticate(fn: (req: any) => string | null): void {
        this.authFn = fn;
    }

    public registerTool(tool: HAIPTool): void {
        this.tools.set(tool.schema().name, tool);

        tool.on("sendHAIPMessage", ({ client, message }) => {
            message.session = client.sessionId;
            message.transaction = client.transactionId;

            this.sendMessage(client.sessionId, message);
        });
    }

    public unregisterTool(toolName: string): void {
        this.tools.delete(toolName);
    }

    public getTools(): HAIPToolSchema[] {
        return Array.from(this.tools.values()).map(tool => tool.schema());
    }

    public getSession(sessionId: string): HAIPSession | undefined {
        return this.sessions.get(sessionId);
    }

    public getStats(): HAIPServerStats {
        const currentStats = { ...this.stats };
        currentStats.uptime = Date.now() - this.startTime;
        currentStats.activeConnections = this.sessions.size;
        return currentStats;
    }

    public broadcast(message: HAIPMessage): void {
        for (const [sessionId, session] of this.sessions.entries()) {
            if (session.connected) {
                this.sendMessage(sessionId, message);
            }
        }
    }

    public sendMessage(sessionId: string, message: HAIPMessage): void {
        const session = this.sessions.get(sessionId);
        if (!session || !session.connected) {
            console.log("Couldn't find session for ID:", sessionId);
            return;
        }

        const messageStr = JSON.stringify(message);

        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            console.log("Sending message to WebSocket:", messageStr);
            session.ws.send(messageStr);
        } else if (session.sseResponse) {
            session.sseResponse.write(`data: ${messageStr}\n\n`);
        } else if (session.httpResponse) {
            session.httpResponse.write(messageStr + "\n");
        }
    }

    public start(): void {
        this.server.listen(this.config.port, this.config.host, () => {
            if (this.config.enableLogging) {
                console.log(`HAIP Server running on ${this.config.host}:${this.config.port}`);
            }
            this.emit("started");
        });
    }

    public stop(): void {
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
            this.statsInterval = null;
        }

        this.heartbeatIntervals.forEach(interval => {
            clearInterval(interval);
        });
        this.heartbeatIntervals.clear();

        this.wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.close();
            }
        });

        this.wss.close(() => {
            this.server.close(() => {
                if (this.config.enableLogging) {
                    console.log("HAIP Server stopped");
                }
                this.emit("stopped");
            });
        });
    }

    public closeAllConnections(): void {
        this.wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.close();
            }
        });
    }
}
