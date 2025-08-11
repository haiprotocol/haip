import EventEmitter from "events";
import { HAIPMessageOptions, HAIPTransaction } from "haip";

export class HaipTransaction extends EventEmitter implements HAIPTransaction {
    id: string;
    isReady: boolean;

    constructor(id: string) {
        super();
        // On construction we are setting a temporary ID.
        // This ID will be replaced with the actual transaction ID once the transaction starts.
        this.id = id;
        this.isReady = false;
    }

    // Allow reseting the ID when we have the actual transaction ID.
    setId(id: string): void {
        if (!this.isReady) {
            this.id = id;
            this.isReady = true;
            this.emit("ready", this);
        }
    }

    handleMessage(message: any): void {
        this.emit("message", message);
    }

    sendTextMessage(text: string, options?: HAIPMessageOptions) {
        this.emit("sendTextMessage", {
            text: text,
            options: options || {},
        });
    }
}
