import { HAIPTool, HAIPToolSchema } from "haip";

export class HaipTool implements HAIPTool {
    schema(): HAIPToolSchema {
        throw new Error("Method not implemented.");
    }

    registerListeners() {
        throw new Error("Method not implemented.");
    }

    on(event: string, listener: (...args: any[]) => void): this {
        // Implement event listener logic here
        return this;
    }
}
