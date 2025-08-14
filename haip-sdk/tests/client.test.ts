import { HAIPClientImpl } from "../src/client";
import { HAIPUtils } from "../src/utils";
import {
    HAIPConnectionConfig,
    HAIPMessage,
    HAIPEventType,
    HAIPChannel,
    HAIPRun,
    HAIPEventHandlers,
} from "../src/types";

// Mock transport
class MockTransport {
    private connected = false;
    private messageHandler?: (message: HAIPMessage) => void;
    private binaryHandler?: (data: ArrayBuffer) => void;
    private connectHandler?: () => void;
    private disconnectHandler?: (reason: string) => void;
    private errorHandler?: (error: Error) => void;
    private sentMessages: HAIPMessage[] = [];
    private sentBinary: ArrayBuffer[] = [];

    async connect(): Promise<void> {
        this.connected = true;
        this.connectHandler?.();
    }

    async disconnect(): Promise<void> {
        this.connected = false;
        this.disconnectHandler?.("Disconnected");
    }

    async send(message: HAIPMessage): Promise<void> {
        this.sentMessages.push(message);
    }

    async sendBinary(data: ArrayBuffer): Promise<void> {
        this.sentBinary.push(data);
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

    // Test helpers
    getSentMessages(): HAIPMessage[] {
        return this.sentMessages;
    }

    getSentBinary(): ArrayBuffer[] {
        return this.sentBinary;
    }

    clearSent(): void {
        this.sentMessages = [];
        this.sentBinary = [];
    }

    simulateMessage(message: HAIPMessage): void {
        this.messageHandler?.(message);
    }

    simulateBinary(data: ArrayBuffer): void {
        this.binaryHandler?.(data);
    }

    simulateError(error: Error): void {
        this.errorHandler?.(error);
    }

    simulateDisconnect(reason: string): void {
        this.disconnectHandler?.(reason);
    }
}

describe("HAIPClient", () => {
    let client: HAIPClientImpl;
    let mockTransport: MockTransport;
    let config: HAIPConnectionConfig;

    beforeEach(() => {
        config = {
            url: "ws://localhost:8080",
            token: "test-token",
            sessionId: "test-session",
        };

        // Create client with mocked transport
        client = new HAIPClientImpl(config);
        mockTransport = new MockTransport();

        // Replace the transport with our mock
        (client as any).transport = mockTransport;
        (client as any).setupTransportHandlers();

        // Disable logging during tests
        (client as any).logger = {
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: () => {},
        };
    });

    afterEach(async () => {
        await client.disconnect();
        globalThis.clearAllTimers?.();

        // Wait a bit for any remaining async operations to complete
        await new Promise(resolve => setTimeout(resolve, 10));
    });

    describe("Connection Management", () => {
        test("should connect successfully", async () => {
            const connectPromise = client.connect();

            // Simulate transport connection
            await mockTransport.connect();

            await connectPromise;

            expect(client.isConnected()).toBe(true);
        });

        test("should handle disconnection", async () => {
            await client.connect();

            const disconnectPromise = new Promise<void>(resolve => {
                client.on("disconnect", () => resolve());
            });

            mockTransport.simulateDisconnect("Test disconnect");

            await disconnectPromise;

            expect(client.isConnected()).toBe(false);
        });

        test("should handle connection errors", async () => {
            const errorPromise = new Promise<Error>(resolve => {
                client.on("error", error => resolve(error));
            });

            mockTransport.simulateError(new Error("Connection failed"));

            const error = await errorPromise;
            expect(error.message).toBe("Connection failed");
        });
    });

    describe("Handshake", () => {
        test("should send handshake message on connection", async () => {
            await client.connect();

            const sentMessages = mockTransport.getSentMessages();
            expect(sentMessages.length).toBe(1);
            expect(sentMessages[0].type).toBe("HAI");
            expect(sentMessages[0].channel).toBe("SYSTEM");
        });

        test("should complete handshake on response", async () => {
            await client.connect();

            const handshakePromise = new Promise<any>(resolve => {
                client.on("handshake", payload => resolve(payload));
            });

            const handshakeResponse = HAIPUtils.createMessage("test-session", "SYSTEM", "HAI", {
                haip_version: "1.1.2",
                accept_major: [1],
                accept_events: ["HAI"],
            });

            mockTransport.simulateMessage(handshakeResponse);

            const payload = await handshakePromise;
            expect(payload.haip_version).toBe("1.1.2");
        });
    });

    describe("Run Lifecycle", () => {
        test("should start a run", async () => {
            await client.connect();

            const runId = await client.startRun("test-thread", { test: "metadata" });

            expect(runId).toBeDefined();

            const sentMessages = mockTransport.getSentMessages();
            const runStartedMessage = sentMessages.find(m => m.type === "RUN_STARTED");
            expect(runStartedMessage).toBeDefined();
            expect(runStartedMessage?.payload.run_id).toBe(runId);
        });

        test("should handle run started event", async () => {
            await client.connect();

            const runStartedPromise = new Promise<any>(resolve => {
                client.on("runStarted", payload => resolve(payload));
            });

            const runId = HAIPUtils.generateUUID();
            const runStartedMessage = HAIPUtils.createRunStartedMessage(
                "test-session",
                runId,
                "test-thread",
                { test: "metadata" }
            );

            mockTransport.simulateMessage(runStartedMessage);

            const payload = await runStartedPromise;
            expect(payload.run_id).toBe(runId);

            const run = client.getRun(runId);
            expect(run).toBeDefined();
            expect(run?.status).toBe("active");
        });

        test("should finish a run", async () => {
            await client.connect();

            const runId = await client.startRun();
            await client.finishRun(runId, "OK", "Run completed successfully");

            const sentMessages = mockTransport.getSentMessages();
            const runFinishedMessage = sentMessages.find(m => m.type === "RUN_FINISHED");
            expect(runFinishedMessage).toBeDefined();
            expect(runFinishedMessage?.payload.run_id).toBe(runId);
            expect(runFinishedMessage?.payload.status).toBe("OK");
        });

        test("should handle run finished event", async () => {
            await client.connect();

            const runId = HAIPUtils.generateUUID();
            await client.startRun();

            const runFinishedPromise = new Promise<any>(resolve => {
                client.on("runFinished", payload => resolve(payload));
            });

            const runFinishedMessage = HAIPUtils.createRunFinishedMessage(
                "test-session",
                runId,
                "OK",
                "Run completed"
            );

            mockTransport.simulateMessage(runFinishedMessage);

            const payload = await runFinishedPromise;
            expect(payload.run_id).toBe(runId);

            const run = client.getRun(runId);
            expect(run?.status).toBe("finished");
        });

        test("should cancel a run", async () => {
            await client.connect();

            const runId = await client.startRun();
            await client.cancelRun(runId);

            const sentMessages = mockTransport.getSentMessages();
            const runCancelMessage = sentMessages.find(m => m.type === "RUN_CANCEL");
            expect(runCancelMessage).toBeDefined();
            expect(runCancelMessage?.payload.run_id).toBe(runId);
        });
    });

    describe("Text Messaging", () => {
        test("should send text message", async () => {
            await client.connect();

            const messageId = await client.sendTextMessage("USER", "Hello, world!", "user");

            expect(messageId).toBeDefined();

            const sentMessages = mockTransport.getSentMessages();
            const startMessage = sentMessages.find(m => m.type === "MESSAGE_START");
            const partMessage = sentMessages.find(m => m.type === "MESSAGE_PART");
            const endMessage = sentMessages.find(m => m.type === "MESSAGE_END");

            expect(startMessage).toBeDefined();
            expect(partMessage).toBeDefined();
            expect(endMessage).toBeDefined();
            expect(startMessage?.payload.message_id).toBe(messageId);
        });

        test("should handle text message events", async () => {
            await client.connect();

            const textMessagePromise = new Promise<any>(resolve => {
                client.on("textMessage", payload => resolve(payload));
            });

            const messageId = HAIPUtils.generateUUID();
            const textMessage = HAIPUtils.createTextMessageStartMessage(
                "test-session",
                "USER",
                messageId,
                "user",
                "Hello"
            );

            mockTransport.simulateMessage(textMessage);

            const payload = await textMessagePromise;
            expect(payload.message_id).toBe(messageId);
        });
    });

    describe("Audio Streaming", () => {
        test("should send audio chunk", async () => {
            await client.connect();

            const messageId = HAIPUtils.generateUUID();
            const audioData = new ArrayBuffer(1024);

            await client.sendAudioChunk("AUDIO_IN", messageId, "audio/wav", audioData, 1000);

            const sentMessages = mockTransport.getSentMessages();
            const audioMessage = sentMessages.find(m => m.type === "AUDIO_CHUNK");

            expect(audioMessage).toBeDefined();
            expect(audioMessage?.payload.message_id).toBe(messageId);
            expect(audioMessage?.payload.mime).toBe("audio/wav");
        });

        test("should handle audio chunk events", async () => {
            await client.connect();

            const audioChunkPromise = new Promise<any>(resolve => {
                client.on("audioChunk", payload => resolve(payload));
            });

            const messageId = HAIPUtils.generateUUID();
            const audioMessage = HAIPUtils.createAudioChunkMessage(
                "test-session",
                "AUDIO_IN",
                messageId,
                "audio/wav",
                "base64data",
                "1000"
            );

            mockTransport.simulateMessage(audioMessage);

            const payload = await audioChunkPromise;
            expect(payload.message_id).toBe(messageId);
            expect(payload.mime).toBe("audio/wav");
        });
    });

    describe("Tool Integration", () => {
        test("should call tool", async () => {
            await client.connect();

            const callId = await client.callTool("AGENT", "test_tool", { param: "value" });

            expect(callId).toBeDefined();

            const sentMessages = mockTransport.getSentMessages();
            const toolCallMessage = sentMessages.find(m => m.type === "TOOL_CALL");

            expect(toolCallMessage).toBeDefined();
            expect(toolCallMessage?.payload.call_id).toBe(callId);
            expect(toolCallMessage?.payload.tool).toBe("test_tool");
        });

        test("should update tool status", async () => {
            await client.connect();

            const callId = HAIPUtils.generateUUID();
            await client.updateTool("AGENT", callId, "RUNNING", 50);

            const sentMessages = mockTransport.getSentMessages();
            const toolUpdateMessage = sentMessages.find(m => m.type === "TOOL_UPDATE");

            expect(toolUpdateMessage).toBeDefined();
            expect(toolUpdateMessage?.payload.call_id).toBe(callId);
            expect(toolUpdateMessage?.payload.status).toBe("RUNNING");
            expect(toolUpdateMessage?.payload.progress).toBe(50);
        });

        test("should complete tool", async () => {
            await client.connect();

            const callId = HAIPUtils.generateUUID();
            await client.completeTool("AGENT", callId, "OK", { result: "success" });

            const sentMessages = mockTransport.getSentMessages();
            const toolDoneMessage = sentMessages.find(m => m.type === "TOOL_DONE");

            expect(toolDoneMessage).toBeDefined();
            expect(toolDoneMessage?.payload.call_id).toBe(callId);
            expect(toolDoneMessage?.payload.status).toBe("OK");
            expect(toolDoneMessage?.payload.result).toEqual({ result: "success" });
        });

        test("should handle tool events", async () => {
            await client.connect();

            const toolCallPromise = new Promise<any>(resolve => {
                client.on("toolCall", payload => resolve(payload));
            });

            const callId = HAIPUtils.generateUUID();
            const toolCallMessage = HAIPUtils.createToolCallMessage(
                "test-session",
                "AGENT",
                callId,
                "test_tool",
                { param: "value" }
            );

            mockTransport.simulateMessage(toolCallMessage);

            const payload = await toolCallPromise;
            expect(payload.call_id).toBe(callId);
            expect(payload.tool).toBe("test_tool");
        });
    });

    describe("Flow Control", () => {
        test("should handle flow update", async () => {
            await client.connect();

            const flowUpdatePromise = new Promise<any>(resolve => {
                client.on("flowUpdate", payload => resolve(payload));
            });

            const flowUpdateMessage = HAIPUtils.createFlowUpdateMessage(
                "test-session",
                "USER",
                10,
                1024
            );

            mockTransport.simulateMessage(flowUpdateMessage);

            const payload = await flowUpdatePromise;
            expect(payload.channel).toBe("USER");
            expect(payload.add_messages).toBe(10);
            expect(payload.add_bytes).toBe(1024);
        });

        test("should pause and resume channel", async () => {
            await client.connect();

            await client.pauseChannel("USER");

            const sentMessages = mockTransport.getSentMessages();
            const pauseMessage = sentMessages.find(m => m.type === "PAUSE_CHANNEL");
            expect(pauseMessage).toBeDefined();
            expect(pauseMessage?.payload.channel).toBe("USER");

            await client.resumeChannel("USER");

            const resumeMessage = sentMessages.find(m => m.type === "RESUME_CHANNEL");
            expect(resumeMessage).toBeDefined();
            expect(resumeMessage?.payload.channel).toBe("USER");
        });
    });

    describe("Replay and Sequencing", () => {
        test("should request replay", async () => {
            await client.connect();

            await client.requestReplay("100", "200");

            const sentMessages = mockTransport.getSentMessages();
            const replayMessage = sentMessages.find(m => m.type === "REPLAY_REQUEST");
            expect(replayMessage).toBeDefined();
            expect(replayMessage?.payload.from_seq).toBe("100");
            expect(replayMessage?.payload.to_seq).toBe("200");
        });

        test("should handle replay request", async () => {
            await client.connect();

            const replayRequestPromise = new Promise<any>(resolve => {
                client.on("replayRequest", payload => resolve(payload));
            });

            const replayMessage = HAIPUtils.createReplayRequestMessage(
                "test-session",
                "100",
                "200"
            );

            mockTransport.simulateMessage(replayMessage);

            const payload = await replayRequestPromise;
            expect(payload.from_seq).toBe("100");
            expect(payload.to_seq).toBe("200");
        });
    });

    describe("Heartbeat", () => {
        test("should send heartbeat", async () => {
            await client.connect();

            // Simulate handshake completion to start heartbeat
            const handshakeResponse = HAIPUtils.createMessage("test-session", "SYSTEM", "HAI", {
                haip_version: "1.1.2",
                accept_major: [1],
                accept_events: ["HAI"],
            });

            mockTransport.simulateMessage(handshakeResponse);

            // Wait for heartbeat
            await new Promise(resolve => setTimeout(resolve, 100));

            const sentMessages = mockTransport.getSentMessages();
            const pingMessage = sentMessages.find(m => m.type === "PING");
            expect(pingMessage).toBeDefined();
        });

        test("should handle pong", async () => {
            await client.connect();

            const pongPromise = new Promise<any>(resolve => {
                client.on("pong", payload => resolve(payload));
            });

            const pongMessage = HAIPUtils.createPongMessage("test-session", "test-nonce");
            mockTransport.simulateMessage(pongMessage);

            const payload = await pongPromise;
            expect(payload.nonce).toBe("test-nonce");
        });
    });

    describe("Error Handling", () => {
        test("should handle error messages", async () => {
            await client.connect();

            const errorPromise = new Promise<any>(resolve => {
                client.on("error", payload => resolve(payload));
            });

            const errorMessage = HAIPUtils.createErrorMessage(
                "test-session",
                "TEST_ERROR",
                "Test error message"
            );

            mockTransport.simulateMessage(errorMessage);

            const payload = await errorPromise;
            expect(payload.code).toBe("TEST_ERROR");
            expect(payload.message).toBe("Test error message");
        });
    });

    describe("Performance Metrics", () => {
        test("should track performance metrics", async () => {
            await client.connect();

            // Send some messages
            await client.sendTextMessage("USER", "Test message");

            const metrics = client.getPerformanceMetrics();
            expect(metrics.messagesSent).toBeGreaterThan(0);
            expect(metrics.lastUpdated).toBeGreaterThan(0);
        });
    });

    describe("Connection State", () => {
        test("should return connection state", async () => {
            await client.connect();

            const state = client.getConnectionState();
            expect(state.connected).toBe(true);
            expect(state.sessionId).toBe("test-session");
            expect(state.handshakeCompleted).toBe(false);
        });
    });

    describe("Event Handlers", () => {
        test("should set event handlers", async () => {
            const handlers: HAIPEventHandlers = {
                onConnect: jest.fn(),
                onDisconnect: jest.fn(),
                onError: jest.fn(),
            };

            client.setHandlers(handlers);

            await client.connect();
            expect(handlers.onConnect).toHaveBeenCalled();
        });
    });
});
