import { createPermissionMap, HAIPServer, HAIPTool } from "@haip/server";
import {
  HAIPEventType,
  HAIPMessage,
  HAIPSessionTransaction,
  HAIPToolSchema,
} from "haip";
import OpenAI from "openai";

const server = new HAIPServer({
  port: 8080,
  host: "0.0.0.0",
  jwtSecret: "CHANGE_THIS_TO_A_SECRET_STRING",
  enableCORS: true,
  enableLogging: true,
  flowControl: {
    enabled: true,
    minCredits: 100,
    maxCredits: 10000,
    creditThreshold: 200,
    backPressureThreshold: 0.8,
    adaptiveAdjustment: true,
  },
});

server.authenticate((req) => {
  // Here you should validate your with your auth system
  // Hardcoded check here
  if (req.token === "Bearer TOKEN") {
    return {
      id: "user123",
      permissions: createPermissionMap({ MESSAGE: ["*"] }),
      credits: 1000,
    };
  }
  return null;
});

class LLMTool extends HAIPTool {
  private openai: OpenAI;

  constructor() {
    super();
    this.openai = new OpenAI({
      apiKey: process.env["OPENAI_API_KEY"],
    });
  }

  schema(): HAIPToolSchema {
    return {
      name: "llm",
      description: "Interact with a large language model",
      inputSchema: {
        type: "string",
      },
      outputSchema: {
        type: "string",
      },
    };
  }

  async handleMessage(client: HAIPSessionTransaction, message: HAIPMessage) {
    if (message.payload.length > 0) {
      let input = "";

      const transaction = client.transaction.getReplayWindow();
      for (const msg of transaction) {
        if (msg.type === "MESSAGE") {
          if (msg.channel === "AGENT") {
            input += `You: ${msg.payload}\n\n`;
          } else if (msg.channel === "USER") {
            input += `User: ${msg.payload}\n\n`;
          }
        }
      }

      input += "User: " + message.payload;

      console.log("Input to LLM:", input);

      const response = await this.openai.responses.create({
        model: "gpt-4o",
        instructions: "You talk like a piarate.",
        input: input,
      });

      this.sendTextMessage(
        client,
        response.output_text || "No response from LLM"
      );
    }
  }
}

server.registerTool(new LLMTool());

server.start();

server.on("connect", (sessionId) => {
  console.log(`🔗 Client connected: ${sessionId}`);
});

server.on("disconnect", (sessionId) => {
  console.log(`🔌 Client disconnected: ${sessionId}`);
});

server.on("handshake", (sessionId, payload) => {
  console.log(`🤝 Handshake completed: ${sessionId}`, payload);
});
