import EventEmitter from "events";
import { HAIPTool, HAIPToolSchema, HAIPMessage, HaipToolClient } from "haip";

export class HaipTool extends EventEmitter implements HAIPTool {
    schema(): HAIPToolSchema {
        throw new Error("Method not implemented.");
    }

    handleMessage(client: HaipToolClient, message: HAIPMessage): void {
        throw new Error("Method not implemented.");
    }

    getClients(): HaipToolClient[] {
        return [];
    }

    addClient(client: HaipToolClient) {}

    removeClient(client: HaipToolClient) {}

    sendHAIPMessage(client: HaipToolClient, message: HAIPMessage): void {
        this.emit("sendHAIPMessage", { client: client, message: message });
    }

    sendTextMessage(client: HaipToolClient, message: string): void {
        //this.emit("sendHAIPMessage", { text: message, ...req });
    }

    broadcastMessage(message: HAIPMessage): void {
        //this.emit("broadcastMessage", message);
    }
}
