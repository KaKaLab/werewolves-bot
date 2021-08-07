import { EventEmitter } from "stream"
import { Logger } from "./logger";
import { PromiseTimer } from "./timeprom";

class NotifyingStorage<T> extends EventEmitter {
    private value: T | null = null;

    public store(item: T | null) {
        this.value = item;
        this.emit("store", item);
    }

    public get(): T | null {
        return this.value;
    }
}

export class AsyncStorage<T> extends EventEmitter {
    private storage: NotifyingStorage<T>;
    private inUse = false;
    private cancelled = false;

    constructor() {
        super();
        this.storage = new NotifyingStorage();
    }

    public isWaiting() {
        return this.inUse;
    }

    public store(item: T | null) {
        this.storage.store(item);
    }

    public get(): T | null {
        return this.storage.get();
    }

    public cancel() {
        if(this.inUse) {
            this.cancelled = true;
            this.emit("cancelled");
        }
    }

    public async waitNextConditionMeet(predicate: (item: T | null) => boolean, mismatchHandler: (item: T | null) => void = () => {}): Promise<T | null> {
        if(this.inUse) {
            throw new Error("Cannot call when this is used by others.");
        }

        this.cancelled = false;
        this.inUse = true;

        let condition = false;
        let value: T | null = null;
        let hasNewValue = false;

        let handler = (n: T) => {
            value = n;
            hasNewValue = true;
        }

        this.storage.on("store", handler);
        while(!condition) {
            await PromiseTimer.timeout(5);

            if(hasNewValue) {
                hasNewValue = false;
                condition = predicate(value);

                if(!condition) {
                    mismatchHandler(value);
                }
            }

            if(this.cancelled) {
                this.cancelled = false;
                break;
            }
        }

        this.storage.off("store", handler);
        this.inUse = false;
        this.cancelled = false;
        return value;
    }
}