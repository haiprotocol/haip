import EventEmitter from "events";
import { HAIPTool, HAIPToolSchema, HAIPMessage } from "haip";

export class HaipTool extends EventEmitter implements HAIPTool {
    schema(): HAIPToolSchema {
        throw new Error("Method not implemented.");
    }

    handleMessage(message: HAIPMessage): void {
        throw new Error("Method not implemented.");
    }
}
