import { KTextBase, KTextColor, LiteralText, TranslateText } from "./texts";

enum LogLevel {
    verbose,
    log,
    info,
    warn,
    error,
    fatal 
}

export class Logger {
    constructor() {
        
    }

    public static level = LogLevel.info;

    public static readonly prefixFormat = TranslateText.of("%3$s - %1$s %2$s");

    private static getCallSourceName(): string {
        const r = new Error().stack?.split('\n')[3]?.trim()?.split(' ')[1]?.split('.')[0] ?? '<unknown>';
        return r == 'Object' ? 'Werewolves' : r;
    }

    private static _log(level: LogLevel, t: KTextBase, color: KTextColor, name?: string) {
        if (Logger.level > level) return;
        const f = this.prefixFormat.clone();
        const tag = LiteralText.of(`[${name}]`).setColor(color);
        process.stdout.cursorTo(0);
        process.stdout.write(f.addWith(
            tag, t, 
            LiteralText.of(new Date().toISOString()).setColor(KTextColor.darkGray)
        ).toAscii() + '\n');
    }

    public static log(t: string, name?: string): void;
    public static log(t: KTextBase, name?: string): void;
    public static log(t: KTextBase | string, name?: string): void {
        name = name ?? Logger.getCallSourceName();
        if (typeof t == "string") {
            t.split('\n').forEach(l => {
                Logger._log(LogLevel.log, LiteralText.of(l), KTextColor.darkGray, name);
            });
        } else {
            Logger._log(LogLevel.log, t, KTextColor.darkGray, name);
        }
    }

    public static verbose(t: string, name?: string): void;
    public static verbose(t: KTextBase, name?: string): void;
    public static verbose(t: KTextBase | string, name?: string): void {
        name = name ?? Logger.getCallSourceName();
        if (typeof t == "string") {
            t.split('\n').forEach(l => {
                Logger._log(LogLevel.verbose, LiteralText.of(l), KTextColor.darkGray, name);
            });
        } else {
            Logger._log(LogLevel.verbose, t, KTextColor.darkGray, name);
        }
    }

    public static info(t: string, name?: string): void;
    public static info(t: KTextBase, name?: string): void;
    public static info(t: KTextBase | string, name?: string): void {
        name = name ?? Logger.getCallSourceName();
        if (typeof t == "string") {
            t.split('\n').forEach(l => {
                Logger._log(LogLevel.info, LiteralText.of(l), KTextColor.green, name);
            });
        } else {
            Logger._log(LogLevel.info, t, KTextColor.green, name);
        }
    }

    public static warn(t: string, name?: string): void;
    public static warn(t: KTextBase, name?: string): void;
    public static warn(t: KTextBase | string, name?: string): void {
        name = name ?? Logger.getCallSourceName();
        if (typeof t == "string") {
            t.split('\n').forEach(l => {
                Logger._log(LogLevel.warn, LiteralText.of(l), KTextColor.red, name);
            });
        } else {
            Logger._log(LogLevel.warn, t, KTextColor.gold, name);
        }
    }

    public static error(t: string, name?: string): void;
    public static error(t: KTextBase, name?: string): void;
    public static error(t: KTextBase | string, name?: string): void {
        name = name ?? Logger.getCallSourceName();
        if (typeof t == "string") {
            t.split('\n').forEach(l => {
                Logger._log(LogLevel.error, LiteralText.of(l), KTextColor.red, name);
            });
        } else {
            Logger._log(LogLevel.error, t, KTextColor.red, name);
        }
    }

    public static fatal(t: string, name?: string): void;
    public static fatal(t: KTextBase, name?: string): void;
    public static fatal(t: KTextBase | string, name?: string): void {
        name = name ?? Logger.getCallSourceName();
        if (typeof t == "string") {
            t.split('\n').forEach(l => {
                Logger._log(LogLevel.fatal, LiteralText.of(l), KTextColor.red, name);
            });
        } else {
            Logger._log(LogLevel.fatal, t, KTextColor.red, name);
        }
    }
}