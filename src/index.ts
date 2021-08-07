import { WerewolvesBot } from "./bot";
import { Logger, LogLevel } from "./utils/logger";
import * as readline from "readline";

process.setUncaughtExceptionCaptureCallback(err => {
    try {
        Logger.error(err.toString());
        Logger.error("Exiting...");
    } catch(ex) {
        console.error(err.toString());
        console.error("Exiting...");
    }
    process.exit(0);
});

Logger.level = LogLevel.log;

Logger.info("Hello world!");
Logger.info("Starting WerewolvesBot...");

// Prompt input
var io = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

var bot = new WerewolvesBot();
bot.login();

function kPrompt() {
    io.question("> ", ans => {
        bot.acceptConsoleInput(ans);
        kPrompt();
    });
    io.prompt()
}
kPrompt();