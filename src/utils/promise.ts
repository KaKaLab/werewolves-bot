export class PromiseTimer {
    public static timeout(millis: number): Promise<void> {
        return new Promise((resolve, _) => {
            setTimeout(() => {
                resolve();
            }, millis);
        });
    }

    public static async waitUntil(predicate: () => boolean): Promise<void> {
        while(!predicate()) {
            await PromiseTimer.timeout(16);
        }
    }
}

export class PromiseUtil {
    public static noop(): Promise<void> {
        return new Promise((resolve, _) => { resolve(); });
    }
}