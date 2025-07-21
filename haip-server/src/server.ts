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
    HAIPToolDefinition,
    HAIPToolExecution,
} from "./types";
import { HAIPServerUtils } from "./utils";

export class HAIPServer extends EventEmitter {
    private app: express.Application;
    private server: any;
    private wss: WebSocket.Server;
    private config: HAIPServerConfig;
    private sessions: Map<string, HAIPSession> = new Map();
    private runs: Map<string, HAIPRun> = new Map();
    private tools: Map<string, HAIPToolDefinition> = new Map();
    private toolExecutions: Map<string, HAIPToolExecution> = new Map();
    private stats: HAIPServerStats;
    private startTime: number;
    private statsInterval: NodeJS.Timeout | null = null;
    private heartbeatIntervals: Map<string, NodeJS.Timeout> = new Map();

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
            const token = req.query.token as string;
            if (!token || !HAIPServerUtils.validateJWT(token)) {
                res.status(401).json({ error: "Invalid token" });
                return;
            }

            const userId = HAIPServerUtils.getUserIdFromToken(token);
            if (!userId) {
                res.status(401).json({ error: "Invalid token" });
                return;
            }

            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Cache-Control",
            });

            const sessionId = this.createSession(userId);
            const session = this.sessions.get(sessionId)!;

            const handshake = this.createHandshakeResponse(sessionId);
            res.write(`data: ${JSON.stringify(handshake)}\n\n`);

            req.on("close", () => {
                this.handleDisconnect(sessionId);
            });

            session.sseResponse = res;
        });

        this.app.post("/haip/stream", (req, res) => {
            const token = req.headers.authorization?.replace("Bearer ", "");
            if (!token || !HAIPServerUtils.validateJWT(token)) {
                res.status(401).json({ error: "Invalid token" });
                return;
            }

            const userId = HAIPServerUtils.getUserIdFromToken(token);
            if (!userId) {
                res.status(401).json({ error: "Invalid token" });
                return;
            }

            const sessionId = this.createSession(userId);
            const session = this.sessions.get(sessionId)!;

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

            session.httpResponse = res;

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
            const token = url.searchParams.get("token");

            if (!token || !HAIPServerUtils.validateJWT(token)) {
                ws.close(1008, "Invalid token");
                return;
            }

            const userId = HAIPServerUtils.getUserIdFromToken(token);
            if (!userId) {
                ws.close(1008, "Invalid token");
                return;
            }

            const sessionId = this.createSession(userId);
            const session = this.sessions.get(sessionId)!;
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
                        this.sendError(sessionId, "INVALID_MESSAGE", "Invalid message format");
                    }
                }
            });

            ws.on("close", () => {
                this.handleDisconnect(sessionId);
            });

            ws.on("error", error => {
                console.error("WebSocket error:", error);
                this.handleDisconnect(sessionId);
            });

            this.setupHeartbeat(sessionId);
        });
    }

    private createSession(userId: string): string {
        const sessionId = HAIPServerUtils.generateUUID();
        const session: HAIPSession = {
            id: sessionId,
            userId,
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
            pausedChannels: new Set(),
            lastAck: "",
            lastDeliveredSeq: "",
            replayWindow: new Map(),
            activeRuns: new Set(),
            pendingMessages: new Map(),
        };

        this.sessions.set(sessionId, session);
        return sessionId;
    }

    private createHandshakeResponse(sessionId: string): HAIPMessage {
        const payload: HAIPHandshakePayload = {
            haip_version: "1.1.2",
            accept_major: [1],
            accept_events: [
                "HAI",
                "RUN_STARTED",
                "RUN_FINISHED",
                "RUN_CANCEL",
                "RUN_ERROR",
                "PING",
                "PONG",
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
                "ERROR",
                "FLOW_UPDATE",
                "PAUSE_CHANNEL",
                "RESUME_CHANNEL",
            ],
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
        const session = this.sessions.get(sessionId);
        if (!session) {
            console.log("Session not found for ID:", sessionId);
            return;
        }

        if (!HAIPServerUtils.validateMessage(message)) {
            console.log("Invalid message:", message);
            this.sendError(sessionId, "INVALID_MESSAGE", "Invalid message format");
            return;
        }

        console.log("Handling message type:", message.type, "for session:", sessionId);

        session.lastActivity = Date.now();
        this.stats.totalMessages++;

        if (this.config.flowControl.enabled) {
            if (!this.checkFlowControl(sessionId, message)) {
                return;
            }
        }

        session.replayWindow.set(message.seq, message);

        switch (message.type) {
            case "HAI":
                console.log("Routing to handleHandshake");
                this.handleHandshake(sessionId, message);
                break;
            case "RUN_STARTED":
                this.handleRunStarted(sessionId, message);
                break;
            case "RUN_FINISHED":
                this.handleRunFinished(sessionId, message);
                break;
            case "RUN_CANCEL":
                this.handleRunCancel(sessionId, message);
                break;
            case "PING":
                console.log("Routing to handlePing");
                this.handlePing(sessionId, message);
                break;
            case "REPLAY_REQUEST":
                this.handleReplayRequest(sessionId, message);
                break;
            case "TEXT_MESSAGE_START":
            case "TEXT_MESSAGE_PART":
            case "TEXT_MESSAGE_END":
                this.handleTextMessage(sessionId, message);
                break;
            case "AUDIO_CHUNK":
                this.handleAudioChunk(sessionId, message);
                break;
            case "TOOL_CALL":
                this.handleToolCall(sessionId, message);
                break;
            case "TOOL_UPDATE":
                this.handleToolUpdate(sessionId, message);
                break;
            case "TOOL_DONE":
                this.handleToolDone(sessionId, message);
                break;
            case "TOOL_CANCEL":
                this.handleToolCancel(sessionId, message);
                break;
            case "PAUSE_CHANNEL":
                this.handlePauseChannel(sessionId, message);
                break;
            case "RESUME_CHANNEL":
                this.handleResumeChannel(sessionId, message);
                break;
            default:
                console.log("Unknown message type:", message.type);
                this.sendError(
                    sessionId,
                    "UNSUPPORTED_TYPE",
                    `Unknown message type: ${message.type}`
                );
        }
    }

    private handleBinaryData(sessionId: string, data: Buffer): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return;
        }

        this.emit("binary", sessionId, data);
    }

    private handleHandshake(sessionId: string, message: HAIPMessage): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return;
        }

        session.handshakeCompleted = true;
        this.emit("handshake", sessionId, message.payload);
    }

    private handleRunStarted(sessionId: string, message: HAIPMessage): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return;
        }

        const runId = message.payload.run_id || HAIPServerUtils.generateUUID();
        const run: HAIPRun = {
            runId,
            threadId: message.payload.thread_id,
            status: "active",
            startTime: Date.now(),
            endTime: undefined,
            metadata: message.payload.metadata,
            summary: undefined,
            error: undefined,
        };

        this.runs.set(runId, run);
        session.activeRuns.add(runId);

        this.emit("runStarted", sessionId, run);
    }

    private handleRunFinished(sessionId: string, message: HAIPMessage): void {
        const runId = message.payload.run_id;
        if (!runId) {
            this.sendError(sessionId, "MISSING_RUN_ID", "Run ID is required");
            return;
        }

        const run = this.runs.get(runId);
        if (!run) {
            this.sendError(sessionId, "RUN_NOT_FOUND", "Run not found");
            return;
        }

        run.status = message.payload.status || "finished";
        run.endTime = Date.now();
        run.summary = message.payload.summary;

        const session = this.sessions.get(sessionId);
        if (session) {
            session.activeRuns.delete(runId);
        }

        this.emit("runFinished", sessionId, run);
    }

    private handleRunCancel(sessionId: string, message: HAIPMessage): void {
        const runId = message.payload.run_id;
        if (!runId) {
            this.sendError(sessionId, "MISSING_RUN_ID", "Run ID is required");
            return;
        }

        const run = this.runs.get(runId);
        if (!run) {
            this.sendError(sessionId, "RUN_NOT_FOUND", "Run not found");
            return;
        }

        run.status = "cancelled";
        run.endTime = Date.now();

        const session = this.sessions.get(sessionId);
        if (session) {
            session.activeRuns.delete(runId);
        }

        this.emit("runCancelled", sessionId, run);
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

    private handleReplayRequest(sessionId: string, message: HAIPMessage): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return;
        }

        const fromSeq = message.payload.from_seq;
        const toSeq = message.payload.to_seq;

        for (const [seq, msg] of session.replayWindow) {
            if (seq >= fromSeq && (!toSeq || seq <= toSeq)) {
                this.sendMessage(sessionId, msg);
            }
        }
    }

    private handleTextMessage(sessionId: string, message: HAIPMessage): void {
        this.emit("textMessage", sessionId, message);
    }

    private handleAudioChunk(sessionId: string, message: HAIPMessage): void {
        this.emit("audioChunk", sessionId, message);
    }

    private handleToolCall(sessionId: string, message: HAIPMessage): void {
        const callId = message.payload.call_id;
        const toolName = message.payload.tool;
        const params = message.payload.params;

        const tool = this.tools.get(toolName);
        if (!tool) {
            this.sendError(sessionId, "TOOL_NOT_FOUND", `Tool ${toolName} not found`);
            return;
        }

        const execution: HAIPToolExecution = {
            callId,
            toolName,
            arguments: params || {},
            status: "pending",
            startTime: Date.now(),
        };

        this.toolExecutions.set(callId, execution);

        setTimeout(() => {
            execution.status = "running";
            this.sendToolUpdate(sessionId, callId, "RUNNING", 50);

            setTimeout(() => {
                execution.status = "completed";
                execution.endTime = Date.now();

                let result: any;

                switch (toolName) {
                    case "echo":
                        result = { echoed: params?.message || "No message provided" };
                        break;
                    case "add": {
                        const a = params?.a || 0;
                        const b = params?.b || 0;
                        result = { result: a + b };
                        break;
                    }
                    case "weather":
                        result = {
                            temperature: "22°C",
                            condition: "Sunny",
                            location: params?.location || "Unknown",
                        };
                        break;
                    default:
                        result = { success: true, data: "Tool execution completed" };
                }

                execution.result = result;
                this.sendToolDone(sessionId, callId, "OK", result);
            }, 100);
        }, 50);

        this.emit("toolCall", sessionId, execution);
    }

    private handleToolUpdate(sessionId: string, message: HAIPMessage): void {
        const callId = message.payload.call_id;
        const execution = this.toolExecutions.get(callId);
        if (execution) {
            execution.status = message.payload.status;
            execution.progress = message.payload.progress;
            execution.partial = message.payload.partial;
        }
    }

    private handleToolDone(sessionId: string, message: HAIPMessage): void {
        const callId = message.payload.call_id;
        const execution = this.toolExecutions.get(callId);
        if (execution) {
            execution.status = message.payload.status || "completed";
            execution.endTime = Date.now();
            execution.result = message.payload.result;
        }
    }

    private handleToolCancel(sessionId: string, message: HAIPMessage): void {
        const callId = message.payload.call_id;
        const execution = this.toolExecutions.get(callId);
        if (execution) {
            execution.status = "cancelled";
            execution.endTime = Date.now();
        }
    }

    private handlePauseChannel(sessionId: string, message: HAIPMessage): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return;
        }

        const channel = message.payload.channel;
        session.pausedChannels.add(channel as HAIPChannel);
    }

    private handleResumeChannel(sessionId: string, message: HAIPMessage): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return;
        }

        const channel = message.payload.channel;
        session.pausedChannels.delete(channel as HAIPChannel);
    }

    private checkFlowControl(sessionId: string, message: HAIPMessage): boolean {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return false;
        }

        const channel = message.channel;
        const credits = session.credits.get(channel) || 0;

        if (credits <= 0) {
            this.sendError(sessionId, "INSUFFICIENT_CREDITS", "Insufficient credits for channel");
            return false;
        }

        session.credits.set(channel, credits - 1);
        return true;
    }

    private sendError(sessionId: string, code: string, message: string): void {
        const error = HAIPServerUtils.createErrorMessage(sessionId, {
            code,
            message,
        });
        this.sendMessage(sessionId, error);
    }

    private sendToolUpdate(
        sessionId: string,
        callId: string,
        status: string,
        progress?: number
    ): void {
        const update = HAIPServerUtils.createToolUpdateMessage(sessionId, {
            call_id: callId,
            status: status as any,
            progress,
        });
        this.sendMessage(sessionId, update);
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
        this.registerTool({
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
        });
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

    public registerTool(tool: HAIPToolDefinition): void {
        this.tools.set(tool.name, tool);
    }

    public unregisterTool(toolName: string): void {
        this.tools.delete(toolName);
    }

    public getTools(): HAIPToolDefinition[] {
        return Array.from(this.tools.values());
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
            return;
        }

        const messageStr = JSON.stringify(message);

        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(messageStr);
        } else if (session.sseResponse) {
            session.sseResponse.write(`data: ${messageStr}\n\n`);
        } else if (session.httpResponse) {
            session.httpResponse.write(messageStr + "\n");
        }
    }

    public sendToolDone(sessionId: string, callId: string, status: string, result?: any): void {
        const done = HAIPServerUtils.createToolDoneMessage(sessionId, {
            call_id: callId,
            status: status as any,
            result,
        });
        this.sendMessage(sessionId, done);
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
