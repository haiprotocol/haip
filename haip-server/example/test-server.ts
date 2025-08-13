import { HAIPServer } from "../src/server";
import { HAIPMessage, HAIPSessionTransaction, HAIPToolSchema } from "haip";
import { HaipTool } from "../src/tool";

const server = new HAIPServer({
    port: 8080,
    host: "0.0.0.0",
    jwtSecret: "CHANGE_THIS_TO_A_SECRET_STRING",
    enableCORS: true,
    enableLogging: true,
    flowControl: {
        enabled: true,
        initialCredits: 1000,
        minCredits: 100,
        maxCredits: 10000,
        creditThreshold: 200,
        backPressureThreshold: 0.8,
        adaptiveAdjustment: true,
    },
});

server.authenticate(req => {
    // Here you should validate your with your auth system
    if (req.token === "Bearer TOKEN") {
        return "userid";
    }
    return null;
});

class EchoTool extends HaipTool {
    schema(): HAIPToolSchema {
        return {
            name: "echo",
            description: "Echo back the input message",
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
                    timestamp: { type: "string" },
                },
            },
        };
    }

    handleMessage(client: HAIPSessionTransaction, message: HAIPMessage) {
        this.sendHAIPMessage(client, message);
    }
}

class LLMTool extends HaipTool {
    schema(): HAIPToolSchema {
        return {
            name: "llm",
            description: "Interact with a large language model",
            inputSchema: {
                type: "object",
                properties: {
                    prompt: { type: "string" },
                },
                required: ["prompt"],
            },
            outputSchema: {
                type: "object",
                properties: {
                    response: { type: "string" },
                },
            },
        };
    }

    handleMessage(client: HAIPSessionTransaction, message: HAIPMessage) {
        this.sendHAIPMessage(client, message);
    }
}

server.registerTool(new LLMTool());
server.registerTool(new EchoTool());

server.start();

server.on("connect", sessionId => {
    console.log(`🔗 Client connected: ${sessionId}`);
});

server.on("disconnect", sessionId => {
    console.log(`🔌 Client disconnected: ${sessionId}`);
});

server.on("handshake", (sessionId, payload) => {
    console.log(`🤝 Handshake completed: ${sessionId}`, payload);
});
