import { HAIPMessageOptions, HAIPTransaction } from "haip";

export class HaipTransaction implements HAIPTransaction {
    on(event: string, handler: (...args: any[]) => void): this {
        //throw new Error("Method not implemented.");
        return this;
    }
    sendTextMessage(text: string, options?: HAIPMessageOptions): Promise<void> {
        //throw new Error("Method not implemented.");
        return Promise.resolve();
    }
}
