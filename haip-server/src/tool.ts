import EventEmitter from "events";
import { HAIPTool, HAIPToolSchema, HAIPMessage, HAIPSessionTransaction } from "haip";

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

    sendTextMessage(client: HAIPSessionTransaction, message: string): void {
        //this.emit("sendHAIPMessage", { text: message, ...req });
    }

    broadcastMessage(message: HAIPMessage): void {
        //this.emit("broadcastMessage", message);
    }
}
