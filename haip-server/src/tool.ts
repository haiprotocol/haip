import EventEmitter from "events";
import { HAIPTool, HAIPToolSchema, HAIPMessage, HAIPSessionTransaction } from "haip";
import { HAIPServerUtils } from "./utils";

export class HaipTool extends EventEmitter implements HAIPTool {
    handleAudioChunk(client: HAIPSessionTransaction, message: HAIPMessage): void {
        throw new Error("Method not implemented.");
        //this.emit("audioChunk", sessionId, message);
    }

    schema(): HAIPToolSchema {
        throw new Error("Method not implemented.");
    }

    handleMessage(client: HAIPSessionTransaction, message: HAIPMessage): void {
        throw new Error("Method not implemented.");
    }

    getClients(): HAIPSessionTransaction[] {
        return [];
    }

    addClient(client: HAIPSessionTransaction) {}

    removeClient(client: HAIPSessionTransaction) {}

    sendHAIPMessage(client: HAIPSessionTransaction, message: HAIPMessage): void {
        this.emit("sendHAIPMessage", { client: client, message: message });
    }

    async sendTextMessage(client: HAIPSessionTransaction, message: string): Promise<void> {
        const messages = await HAIPServerUtils.sendTextMessage(
            client.sessionId,
            client.transaction.id,
            "AGENT",
            message
        );
        for (const msg of messages) {
            client.transaction.addToReplayWindow(msg);
            this.emit("sendHAIPMessage", { client: client, message: msg });
        }
    }

    broadcastMessage(message: HAIPMessage): void {
        //this.emit("broadcastMessage", message);
    }
}
