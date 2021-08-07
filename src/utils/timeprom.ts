export class PromiseTimer {
    public static timeout(millis: number): Promise<void> {
        return new Promise((resolve, _) => {
            setTimeout(() => {
                resolve();
            }, millis);
        });
    }
}