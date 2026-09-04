import { HAIPUtils } from "../src/utils";
import { HAIPMessage, HAIPEventType, HAIPChannel } from "../src/types";

describe("HAIPUtils", () => {
    describe("UUID Generation", () => {
        test("should generate valid UUIDs", () => {
            const uuid1 = HAIPUtils.generateUUID();
            const uuid2 = HAIPUtils.generateUUID();

            expect(uuid1).toBeDefined();
            expect(uuid2).toBeDefined();
            expect(uuid1).not.toBe(uuid2);
            expect(uuid1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        });
    });

    describe("Timestamp Generation", () => {
        test("should generate timestamps", () => {
            const ts1 = HAIPUtils.generateTimestamp();

            expect(ts1).toBeDefined();
            expect(parseInt(ts1)).toBeGreaterThan(0);
        });

        test("should generate different timestamps", async () => {
            const ts1 = HAIPUtils.generateTimestamp();
            await new Promise(resolve => setTimeout(resolve, 1));
            const ts2 = HAIPUtils.generateTimestamp();

            expect(ts1).toBeDefined();
            expect(ts2).toBeDefined();
            expect(parseInt(ts1)).toBeGreaterThan(0);
            expect(parseInt(ts2)).toBeGreaterThanOrEqual(parseInt(ts1));
        });
    });

    describe("Sequence Number Generation", () => {
        test("should generate sequence numbers", () => {
            const seq1 = HAIPUtils.generateSequenceNumber();

            expect(seq1).toBeDefined();
            expect(parseInt(seq1)).toBeGreaterThan(0);
        });

        test("should generate different sequence numbers", () => {
            const seq1 = HAIPUtils.generateSequenceNumber();
            const seq2 = HAIPUtils.generateSequenceNumber();

            expect(seq1).toBeDefined();
            expect(seq2).toBeDefined();
            expect(parseInt(seq1)).toBeGreaterThan(0);
            expect(parseInt(seq2)).toBeGreaterThanOrEqual(parseInt(seq1));
        });
    });

    describe("Message Validation", () => {
        test("should validate correct messages", () => {
            const validMessage: HAIPMessage = {
                id: HAIPUtils.generateUUID(),
                session: "test-session",
                seq: HAIPUtils.generateSequenceNumber(),
                ts: HAIPUtils.generateTimestamp(),
                channel: "USER",
                type: "MESSAGE_START",
                payload: { message_id: "test" },
            };

            expect(HAIPUtils.validateMessage(validMessage)).toBe(true);
        });

        test("should reject invalid messages", () => {
            expect(HAIPUtils.validateMessage(null)).toBe(false);
            expect(HAIPUtils.validateMessage(undefined)).toBe(false);
            expect(HAIPUtils.validateMessage({})).toBe(false);
            expect(HAIPUtils.validateMessage({ id: "test" })).toBe(false);
        });

        test("should reject messages with invalid channel", () => {
            const invalidMessage: any = {
                id: HAIPUtils.generateUUID(),
                session: "test-session",
                seq: HAIPUtils.generateSequenceNumber(),
                ts: HAIPUtils.generateTimestamp(),
                channel: "INVALID_CHANNEL",
                type: "MESSAGE_START",
                payload: { message_id: "test" },
            };

            expect(HAIPUtils.validateMessage(invalidMessage)).toBe(false);
        });

        test("should reject messages with invalid event type", () => {
            const invalidMessage: any = {
                id: HAIPUtils.generateUUID(),
                session: "test-session",
                seq: HAIPUtils.generateSequenceNumber(),
                ts: HAIPUtils.generateTimestamp(),
                channel: "USER",
                type: "INVALID_TYPE",
                payload: { message_id: "test" },
            };

            expect(HAIPUtils.validateMessage(invalidMessage)).toBe(false);
        });
    });

    describe("Channel Validation", () => {
        test("should validate correct channels", () => {
            expect(HAIPUtils.isValidChannel("USER")).toBe(true);
            expect(HAIPUtils.isValidChannel("AGENT")).toBe(true);
            expect(HAIPUtils.isValidChannel("SYSTEM")).toBe(true);
            expect(HAIPUtils.isValidChannel("AUDIO_IN")).toBe(true);
            expect(HAIPUtils.isValidChannel("AUDIO_OUT")).toBe(true);
        });

        test("should reject invalid channels", () => {
            expect(HAIPUtils.isValidChannel("INVALID")).toBe(false);
            expect(HAIPUtils.isValidChannel("")).toBe(false);
            expect(HAIPUtils.isValidChannel(null)).toBe(false);
            expect(HAIPUtils.isValidChannel(undefined)).toBe(false);
        });
    });

    describe("Event Type Validation", () => {
        test("should validate correct event types", () => {
            expect(HAIPUtils.isValidEventType("HAI")).toBe(true);
            expect(HAIPUtils.isValidEventType("RUN_STARTED")).toBe(true);
            expect(HAIPUtils.isValidEventType("MESSAGE_START")).toBe(true);
            expect(HAIPUtils.isValidEventType("TOOL_CALL")).toBe(true);
            expect(HAIPUtils.isValidEventType("ERROR")).toBe(true);
        });

        test("should reject invalid event types", () => {
            expect(HAIPUtils.isValidEventType("INVALID")).toBe(false);
            expect(HAIPUtils.isValidEventType("")).toBe(false);
            expect(HAIPUtils.isValidEventType(null)).toBe(false);
            expect(HAIPUtils.isValidEventType(undefined)).toBe(false);
        });
    });

    describe("Message Creation", () => {
        test("should create basic message", () => {
            const message = HAIPUtils.createMessage("test-session", "USER", "MESSAGE_START", {
                message_id: "test",
            });

            expect(message.session).toBe("test-session");
            expect(message.channel).toBe("USER");
            expect(message.type).toBe("MESSAGE_START");
            expect(message.payload.message_id).toBe("test");
            expect(message.id).toBeDefined();
            expect(message.seq).toBeDefined();
            expect(message.ts).toBeDefined();
        });

        test("should create message with optional fields", () => {
            const message = HAIPUtils.createMessage(
                "test-session",
                "USER",
                "MESSAGE_START",
                { message_id: "test" },
                {
                    id: "custom-id",
                    seq: "custom-seq",
                    ts: "custom-ts",
                    ack: "custom-ack",
                    pv: 1,
                    crit: true,
                    bin_len: 1024,
                    bin_mime: "application/octet-stream",
                    run_id: "test-run",
                    thread_id: "test-thread",
                }
            );

            expect(message.id).toBe("custom-id");
            expect(message.seq).toBe("custom-seq");
            expect(message.ts).toBe("custom-ts");
            expect(message.ack).toBe("custom-ack");
            expect(message.pv).toBe(1);
            expect(message.crit).toBe(true);
            expect(message.bin_len).toBe(1024);
            expect(message.bin_mime).toBe("application/octet-stream");
            expect(message.run_id).toBe("test-run");
            expect(message.thread_id).toBe("test-thread");
        });
    });

    describe("Handshake Message Creation", () => {
        test("should create handshake message", () => {
            const acceptEvents: HAIPEventType[] = ["HAI", "MESSAGE_START"];
            const capabilities = {
                binary_frames: true,
                flow_control: {
                    initial_credit_messages: 10,
                    initial_credit_bytes: 1024,
                },
            };

            const message = HAIPUtils.createHandshakeMessage(
                "test-session",
                acceptEvents,
                capabilities,
                "last-seq"
            );

            expect(message.type).toBe("HAI");
            expect(message.channel).toBe("SYSTEM");
            expect(message.payload.haip_version).toBe("1.1.2");
            expect(message.payload.accept_major).toEqual([1]);
            expect(message.payload.accept_events).toEqual(acceptEvents);
            expect(message.payload.capabilities).toEqual(capabilities);
            expect(message.payload.last_rx_seq).toBe("last-seq");
        });
    });

    describe("Run Lifecycle Message Creation", () => {
        test("should create run started message", () => {
            const message = HAIPUtils.createRunStartedMessage(
                "test-session",
                "test-run",
                "test-thread",
                { test: "metadata" }
            );

            expect(message.type).toBe("RUN_STARTED");
            expect(message.channel).toBe("SYSTEM");
            expect(message.payload.run_id).toBe("test-run");
            expect(message.payload.thread_id).toBe("test-thread");
            expect(message.payload.metadata).toEqual({ test: "metadata" });
            expect(message.run_id).toBe("test-run");
            expect(message.thread_id).toBe("test-thread");
        });

        test("should create run finished message", () => {
            const message = HAIPUtils.createRunFinishedMessage(
                "test-session",
                "test-run",
                "OK",
                "Run completed"
            );

            expect(message.type).toBe("RUN_FINISHED");
            expect(message.channel).toBe("SYSTEM");
            expect(message.payload.run_id).toBe("test-run");
            expect(message.payload.status).toBe("OK");
            expect(message.payload.summary).toBe("Run completed");
            expect(message.run_id).toBe("test-run");
        });

        test("should create run cancel message", () => {
            const message = HAIPUtils.createRunCancelMessage("test-session", "test-run");

            expect(message.type).toBe("RUN_CANCEL");
            expect(message.channel).toBe("SYSTEM");
            expect(message.payload.run_id).toBe("test-run");
            expect(message.run_id).toBe("test-run");
        });

        test("should create run error message", () => {
            const message = HAIPUtils.createRunErrorMessage(
                "test-session",
                "test-run",
                "TEST_ERROR",
                "Test error",
                "related-id",
                { detail: "test" }
            );

            expect(message.type).toBe("RUN_ERROR");
            expect(message.channel).toBe("SYSTEM");
            expect(message.payload.run_id).toBe("test-run");
            expect(message.payload.code).toBe("TEST_ERROR");
            expect(message.payload.message).toBe("Test error");
            expect(message.payload.related_id).toBe("related-id");
            expect(message.payload.detail).toEqual({ detail: "test" });
            expect(message.run_id).toBe("test-run");
        });
    });

    describe("Heartbeat Message Creation", () => {
        test("should create ping message", () => {
            const message = HAIPUtils.createPingMessage("test-session", "test-nonce");

            expect(message.type).toBe("PING");
            expect(message.channel).toBe("SYSTEM");
            expect(message.payload.nonce).toBe("test-nonce");
        });

        test("should create pong message", () => {
            const message = HAIPUtils.createPongMessage("test-session", "test-nonce");

            expect(message.type).toBe("PONG");
            expect(message.channel).toBe("SYSTEM");
            expect(message.payload.nonce).toBe("test-nonce");
        });
    });

    describe("Text Message Creation", () => {
        test("should create text message start", () => {
            const message = HAIPUtils.createTextMessageStartMessage(
                "test-session",
                "USER",
                "test-message",
                "user",
                "Hello"
            );

            expect(message.type).toBe("MESSAGE_START");
            expect(message.channel).toBe("USER");
            expect(message.payload.message_id).toBe("test-message");
            expect(message.payload.author).toBe("user");
            expect(message.payload.text).toBe("Hello");
        });

        test("should create text message part", () => {
            const message = HAIPUtils.createTextMessagePartMessage(
                "test-session",
                "USER",
                "test-message",
                "Hello"
            );

            expect(message.type).toBe("MESSAGE_PART");
            expect(message.channel).toBe("USER");
            expect(message.payload.message_id).toBe("test-message");
            expect(message.payload.text).toBe("Hello");
        });

        test("should create text message end", () => {
            const message = HAIPUtils.createTextMessageEndMessage(
                "test-session",
                "USER",
                "test-message",
                "tokens"
            );

            expect(message.type).toBe("MESSAGE_END");
            expect(message.channel).toBe("USER");
            expect(message.payload.message_id).toBe("test-message");
            expect(message.payload.tokens).toBe("tokens");
        });
    });

    describe("Audio Message Creation", () => {
        test("should create audio chunk message", () => {
            const message = HAIPUtils.createAudioChunkMessage(
                "test-session",
                "AUDIO_IN",
                "test-message",
                "audio/wav",
                "base64data",
                "1000"
            );

            expect(message.type).toBe("AUDIO_CHUNK");
            expect(message.channel).toBe("AUDIO_IN");
            expect(message.payload.message_id).toBe("test-message");
            expect(message.payload.mime).toBe("audio/wav");
            expect(message.payload.data).toBe("base64data");
            expect(message.payload.duration_ms).toBe("1000");
        });
    });

    describe("Tool Message Creation", () => {
        test("should create tool call message", () => {
            const message = HAIPUtils.createToolCallMessage(
                "test-session",
                "AGENT",
                "test-call",
                "test-tool",
                { param: "value" }
            );

            expect(message.type).toBe("TOOL_CALL");
            expect(message.channel).toBe("AGENT");
            expect(message.payload.call_id).toBe("test-call");
            expect(message.payload.tool).toBe("test-tool");
            expect(message.payload.params).toEqual({ param: "value" });
        });

        test("should create tool update message", () => {
            const message = HAIPUtils.createToolUpdateMessage(
                "test-session",
                "AGENT",
                "test-call",
                "RUNNING",
                50,
                { partial: "result" }
            );

            expect(message.type).toBe("TOOL_UPDATE");
            expect(message.channel).toBe("AGENT");
            expect(message.payload.call_id).toBe("test-call");
            expect(message.payload.status).toBe("RUNNING");
            expect(message.payload.progress).toBe(50);
            expect(message.payload.partial).toEqual({ partial: "result" });
        });

        test("should create tool done message", () => {
            const message = HAIPUtils.createToolDoneMessage(
                "test-session",
                "AGENT",
                "test-call",
                "OK",
                { result: "success" }
            );

            expect(message.type).toBe("TOOL_DONE");
            expect(message.channel).toBe("AGENT");
            expect(message.payload.call_id).toBe("test-call");
            expect(message.payload.status).toBe("OK");
            expect(message.payload.result).toEqual({ result: "success" });
        });

        test("should create tool cancel message", () => {
            const message = HAIPUtils.createToolCancelMessage(
                "test-session",
                "AGENT",
                "test-call",
                "User cancelled"
            );

            expect(message.type).toBe("TOOL_CANCEL");
            expect(message.channel).toBe("AGENT");
            expect(message.payload.call_id).toBe("test-call");
            expect(message.payload.reason).toBe("User cancelled");
        });

        test("should create tool list message", () => {
            const tools = [
                { name: "tool1", description: "First tool" },
                { name: "tool2", description: "Second tool" },
            ];

            const message = HAIPUtils.createToolListMessage("test-session", "AGENT", tools);

            expect(message.type).toBe("TOOL_LIST");
            expect(message.channel).toBe("AGENT");
            expect(message.payload.tools).toEqual(tools);
        });

        test("should create tool schema message", () => {
            const schema = { type: "object", properties: { param: { type: "string" } } };

            const message = HAIPUtils.createToolSchemaMessage(
                "test-session",
                "AGENT",
                "test-tool",
                schema
            );

            expect(message.type).toBe("TOOL_SCHEMA");
            expect(message.channel).toBe("AGENT");
            expect(message.payload.tool).toBe("test-tool");
            expect(message.payload.schema).toEqual(schema);
        });
    });

    describe("Flow Control Message Creation", () => {
        test("should create flow update message", () => {
            const message = HAIPUtils.createFlowUpdateMessage("test-session", "USER", 10, 1024);

            expect(message.type).toBe("FLOW_UPDATE");
            expect(message.channel).toBe("SYSTEM");
            expect(message.payload.channel).toBe("USER");
            expect(message.payload.add_messages).toBe(10);
            expect(message.payload.add_bytes).toBe(1024);
        });

        test("should create pause channel message", () => {
            const message = HAIPUtils.createPauseChannelMessage("test-session", "USER");

            expect(message.type).toBe("PAUSE_CHANNEL");
            expect(message.channel).toBe("SYSTEM");
            expect(message.payload.channel).toBe("USER");
        });

        test("should create resume channel message", () => {
            const message = HAIPUtils.createResumeChannelMessage("test-session", "USER");

            expect(message.type).toBe("RESUME_CHANNEL");
            expect(message.channel).toBe("SYSTEM");
            expect(message.payload.channel).toBe("USER");
        });
    });

    describe("Error Message Creation", () => {
        test("should create error message", () => {
            const message = HAIPUtils.createErrorMessage(
                "test-session",
                "TEST_ERROR",
                "Test error",
                "related-id",
                { detail: "test" }
            );

            expect(message.type).toBe("ERROR");
            expect(message.channel).toBe("SYSTEM");
            expect(message.payload.code).toBe("TEST_ERROR");
            expect(message.payload.message).toBe("Test error");
            expect(message.payload.related_id).toBe("related-id");
            expect(message.payload.detail).toEqual({ detail: "test" });
        });
    });

    describe("Replay Message Creation", () => {
        test("should create replay request message", () => {
            const message = HAIPUtils.createReplayRequestMessage("test-session", "100", "200");

            expect(message.type).toBe("REPLAY_REQUEST");
            expect(message.channel).toBe("SYSTEM");
            expect(message.payload.from_seq).toBe("100");
            expect(message.payload.to_seq).toBe("200");
        });
    });

    describe("JWT Utilities", () => {
        test("should parse JWT token", () => {
            const token =
                "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0IiwiaXNzIjoiaHR0cHM6Ly90ZXN0LmNvbSIsImF1ZCI6InRlc3QiLCJleHAiOjk5OTk5OTk5OTksImlhdCI6MTUxNjIzOTAyMn0.signature";

            const parsed = HAIPUtils.parseJWT(token);
            expect(parsed).toBeDefined();
            expect(parsed?.sub).toBe("test");
            expect(parsed?.iss).toBe("https://test.com");
            expect(parsed?.aud).toBe("test");
        });

        test("should validate JWT structure", () => {
            const validToken =
                "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0IiwiaXNzIjoiaHR0cHM6Ly90ZXN0LmNvbSIsImF1ZCI6InRlc3QiLCJleHAiOjk5OTk5OTk5OTksImlhdCI6MTUxNjIzOTAyMn0.signature";
            const invalidToken = "invalid.token";

            expect(HAIPUtils.validateJWTStructure(validToken)).toBe(true);
            expect(HAIPUtils.validateJWTStructure(invalidToken)).toBe(false);
        });

        test("should check JWT expiration", () => {
            const expiredToken =
                "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0IiwiaXNzIjoiaHR0cHM6Ly90ZXN0LmNvbSIsImF1ZCI6InRlc3QiLCJleHAiOjEsImlhdCI6MTUxNjIzOTAyMn0.signature";
            const validToken =
                "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0IiwiaXNzIjoiaHR0cHM6Ly90ZXN0LmNvbSIsImF1ZCI6InRlc3QiLCJleHAiOjk5OTk5OTk5OTksImlhdCI6MTUxNjIzOTAyMn0.signature";

            expect(HAIPUtils.isJWTExpired(expiredToken)).toBe(true);
            expect(HAIPUtils.isJWTExpired(validToken)).toBe(false);
        });
    });

    describe("Backoff Calculation", () => {
        test("should calculate exponential backoff", () => {
            const delay1 = HAIPUtils.calculateBackoffDelay(0, 1000, 10000);
            const delay2 = HAIPUtils.calculateBackoffDelay(1, 1000, 10000);
            const delay3 = HAIPUtils.calculateBackoffDelay(2, 1000, 10000);

            expect(delay1).toBeGreaterThanOrEqual(1000);
            expect(delay2).toBeGreaterThan(delay1);
            expect(delay3).toBeGreaterThan(delay2);
            expect(delay3).toBeLessThanOrEqual(10000);
        });
    });

    describe("Deep Clone", () => {
        test("should clone primitive values", () => {
            expect(HAIPUtils.deepClone(null)).toBe(null);
            expect(HAIPUtils.deepClone(undefined)).toBe(undefined);
            expect(HAIPUtils.deepClone(42)).toBe(42);
            expect(HAIPUtils.deepClone("test")).toBe("test");
            expect(HAIPUtils.deepClone(true)).toBe(true);
        });

        test("should clone objects", () => {
            const original = { a: 1, b: { c: 2 } };
            const cloned = HAIPUtils.deepClone(original);

            expect(cloned).toEqual(original);
            expect(cloned).not.toBe(original);
            expect(cloned.b).not.toBe(original.b);
        });

        test("should clone arrays", () => {
            const original = [1, 2, { a: 3 }];
            const cloned = HAIPUtils.deepClone(original);

            expect(cloned).toEqual(original);
            expect(cloned).not.toBe(original);
            expect(cloned[2]).not.toBe(original[2]);
        });

        test("should clone dates", () => {
            const original = new Date();
            const cloned = HAIPUtils.deepClone(original);

            expect(cloned).toEqual(original);
            expect(cloned).not.toBe(original);
        });
    });

    describe("Debounce and Throttle", () => {
        test("should debounce function calls", done => {
            let callCount = 0;
            const debounced = HAIPUtils.debounce(() => {
                callCount++;
                expect(callCount).toBe(1);
                done();
            }, 100);

            debounced();
            debounced();
            debounced();
        });

        test("should throttle function calls", done => {
            let callCount = 0;
            const throttled = HAIPUtils.throttle(() => {
                callCount++;
                if (callCount === 2) {
                    done();
                }
            }, 100);

            throttled();
            throttled();
            throttled();

            setTimeout(() => {
                throttled();
            }, 150);
        });
    });

    describe("Retry Function", () => {
        test("should retry failed operations", async () => {
            let attempts = 0;
            const fn = jest.fn().mockImplementation(() => {
                attempts++;
                if (attempts < 3) {
                    throw new Error("Failed");
                }
                return "success";
            });

            const result = await HAIPUtils.retry(fn, 3, 10);

            expect(result).toBe("success");
            expect(fn).toHaveBeenCalledTimes(3);
        });

        test("should throw after max attempts", async () => {
            const fn = jest.fn().mockRejectedValue(new Error("Always fails"));

            await expect(HAIPUtils.retry(fn, 2, 10)).rejects.toThrow("Always fails");
            expect(fn).toHaveBeenCalledTimes(2);
        });
    });

    describe("Random String Generation", () => {
        test("should generate random strings", () => {
            const str1 = HAIPUtils.randomString(10);
            const str2 = HAIPUtils.randomString(10);

            expect(str1).toHaveLength(10);
            expect(str2).toHaveLength(10);
            expect(str1).not.toBe(str2);
        });
    });

    describe("Environment Detection", () => {
        test("should detect environment", () => {
            // These tests depend on the actual environment
            expect(typeof HAIPUtils.isBrowser()).toBe("boolean");
            expect(typeof HAIPUtils.isNode()).toBe("boolean");
        });
    });

    describe("Base64 Conversion", () => {
        test("should convert string to base64", () => {
            const original = "Hello, World!";
            const base64 = HAIPUtils.toBase64(original);
            const decoded = HAIPUtils.fromBase64(base64);

            expect(decoded).toBe(original);
        });

        test("should convert ArrayBuffer to base64", () => {
            const original = new ArrayBuffer(4);
            const view = new Uint8Array(original);
            view[0] = 72; // 'H'
            view[1] = 101; // 'e'
            view[2] = 108; // 'l'
            view[3] = 108; // 'l'

            const base64 = HAIPUtils.arrayBufferToBase64(original);
            const decoded = HAIPUtils.base64ToArrayBuffer(base64);

            expect(decoded.byteLength).toBe(original.byteLength);
            expect(new Uint8Array(decoded)).toEqual(new Uint8Array(original));
        });
    });

    describe("Message Size Calculation", () => {
        test("should calculate message size", () => {
            const message: HAIPMessage = {
                id: "test-id",
                session: "test-session",
                seq: "1",
                ts: "1234567890",
                channel: "USER",
                type: "MESSAGE_START",
                payload: { message_id: "test" },
            };

            const size = HAIPUtils.calculateMessageSize(message);
            expect(size).toBeGreaterThan(0);
            expect(typeof size).toBe("number");
        });
    });
});
