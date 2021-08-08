import { WerewolvesBot } from "./bot";
import { Logger, LogLevel } from "./utils/logger";
import * as readline from "readline";

// Check version because discord.js requires Node 16.6 or higher
let supported = false;
const [major, minor] = process.versions.node.split(".").map(s => parseInt(s));
if(major >= 16) {
    if(minor >= 6) {
        supported = true;
    }
}
if(!supported) {
    Logger.fatal("This bot requires Node 16.6 or higher.");
    Logger.fatal("Please update your Node version and try again.");
    process.exit(1);
}

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