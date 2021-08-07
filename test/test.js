const assert = require("assert");
const { LiteralText, KTextColor } = require("../build/utils/texts");
const { token } = require("../config.json");

const { WerewolvesBot } = require("../build/bot");
const { PromiseTimer } = require("../build/utils/timeprom");
const { Logger, LogLevel } = require("../build/utils/logger");

describe("KText", function() {
    describe(".toPlainText", function() {
        it("converts Text instances with colors to plain-text string", function() {
            const text = LiteralText.of("Black").setColor(KTextColor.black).addExtra(
                LiteralText.of("Gold").setColor(KTextColor.gold)
            );
            assert.equal(text.toPlainText(), "BlackGold");
        });
    });
});

describe("Bot functions", function() {
    let bot = new WerewolvesBot();
    let loggedIn = false;
    let isReady = false;

    describe("begin", function() {
        it("set logger to be silent", function() {
            Logger.level = LogLevel.silent;
        });

        it("login to Discord API", async function() {
            if(token == "") {
                assert.fail("token is empty");
            }
    
            try {
                bot.on("ready", () => {
                    isReady = true;
                });
                await bot.login();
    
                loggedIn = true;
                return;
            } catch(ex) {
                if(ex instanceof Error || typeof ex == "string") {
                    assert.fail(ex);
                } else {
                    let l = "";
                    l += ex.toString();
                    assert.fail(l);
                }
            }
        });
    });

    describe("Werewolves bot", function() {
        if(loggedIn) {
            this.skip();
        }

        it("waits for the API to be ready", async function() {
            while(!isReady) {
                await PromiseTimer.timeout(5);
            }
        });

        it("set status to maintainance mode", async function() {
            await bot.api.user.setStatus("dnd");
            await bot.api.user.setActivity({
                name: "機器人測試中",
                type: "PLAYING"
            });
        });

        it("starts a lobby in KakaLab guild", async function() {
            const guildId = "827088377613910016";
            await bot.spawnLobby(guildId);
        });

        it("test for interactions for 10 seconds...", async function() {
            this.timeout(10000);
            
            let hasInteraction = false;
            let handler = ev => {
                hasInteraction = true;
            };
            bot.api.on("interactionCreate", handler);

            while(!hasInteraction) {
                await PromiseTimer.timeout(16);
            }
            bot.api.off("interactionCreate", handler);
        });

        it("waits for 1 second", async function() {
            await PromiseTimer.timeout(1000);
        });
    });

    describe("close", function() {
        it("closes the bot", function() {
            bot.api.destroy();
        });
    });
});