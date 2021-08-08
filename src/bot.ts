import { DMChannel, Guild, Message } from 'discord.js';
import { Client, KInteractionWS } from 'discord.js';
import { BotConfig } from './config';
import { GameState, Werewolves } from './game/werewolves';
import { Logger } from './utils/logger';
import { CommandOptionType, SlashPatch } from './utils/slash';
import * as util from "util";
import { EventEmitter } from 'stream';
import { blacklist } from "./static/blacklist.json";

export class WerewolvesBot extends EventEmitter {
    public api: Client;
    public config: BotConfig;

    private canAcceptConsoleInput = true;

    private games: Werewolves[] = [];

    public static instance: WerewolvesBot;

    public get rest(): any {
        // @ts-ignore
        return this.api.api;
    }

    constructor() {
        super();

        WerewolvesBot.instance = this;
        this.config = new BotConfig();
        this.api = new Client({
            partials: ["MESSAGE", "CHANNEL"]
        });
        SlashPatch.init(this.api);

        this.api.on('ready', async () => {
            const user = this.api.user;
            Logger.info(`Discord bot logged in as ${user?.username}#${user?.discriminator}`);

            await this.api.user?.setActivity({
                name: "你們相愛相殺 <3",
                type: "WATCHING"
            });
            await this.api.user?.setStatus("dnd");
            this.emit("ready");
            
            await this.registerSlashCommands();
        });

        this.api.on("message", (msg: Message) => {
            if(this.isBlacklisted(msg.author.id)) return;
            if(msg.channel instanceof DMChannel && msg.author.id != this.api.user?.id) {
                Logger.info(msg.author.tag + ": " + msg.content);
            }
        })

        this.api.on("guildCreate", g => {
            this.registerGuildSlashCommands(g);
        });

        this.api.on("guildDelete", g => {
            Logger.log(`Removing Werewolves game in guild: ${g.name} (${g.id})`);
            const index = this.games.findIndex(game => game.guildId == g.id);
            if(index >= 0) {
                const game = this.games[index];
                game.cleanGameMessages();
                this.games.splice(index, 1);
            }
        });

        let running = false;

        this.api.on("interactionCreate", async (ev) => {
            if(this.isBlacklisted(ev.member.user.id)) return;
            if(ev.type != 2) return;
            if(running) {
                await this.respondToInteraction(ev, {
                    type: 4,
                    data: this.getCompactedMessageWithEmbed("正在進行其他指令，無法使用。", true)
                }, "cmd-other-running");
                return;
            }

            if(ev.data.name == "wolf") {
                const data = ev.data;
                const sub = data.options[0];

                if(sub.name == "summon") {
                    running = true;
                    await this.spawnLobby(ev.guild_id, ev);
                    running = false;
                    return;
                }

                if(sub.name == "credit") {
                    await this.respondToInteraction(ev, {
                        type: 4,
                        data: {
                            embeds: [
                                {
                                    ...this.getEmbedBase(),
                                    fields: [
                                        {
                                            name: "開發人員",
                                            value: "阿咔咔#7799\n<@217238973246865408>\n\n꧁༺燄༒影༻꧂#2198\n<@475927616780500992>"
                                        }
                                    ]
                                }
                            ]
                        }
                    }, "cmd-credit");
                    return;
                }

                if(sub.name == "stop-the-game-for-sure-plz") {
                    var sendEmbed = async (message: string) => {
                        await this.respondToInteraction(ev, {
                            type: 4,
                            data: this.getCompactedMessageWithEmbed(message, true)
                        }, "cmd-force-stop-result");
                    };

                    const game = this.games.find(g => g.guildId == ev.guild_id);
                    if(game && game.inProgress) {
                        const userId = ev.member.user.id;
                        if(game.players.find(p => p.member.id == userId)) {
                            game.stopGame(`<@${userId}> 強制停止了這場遊戲。`);
                            sendEmbed("你強制停止了這場遊戲。");
                            return;
                        } else {
                            sendEmbed("你並非這場遊戲的玩家。");
                            return;
                        }
                    }
                    sendEmbed("遊戲不存在。");
                    return;
                }

                if(sub.name == "settings") {
                    const action = sub.options[0];
                    const key = action.options[0];
                    const value = action.options[1];

                    let game = this.games.find(g => g.guildId == ev.guild_id);
                    if(!game) {
                        game = new Werewolves(this, ev.guild_id);
                        await game.init();
                        game.prepareLobby();
                        this.games.push(game);
                    }

                    const run = function () {
                        const type = typeof eval("this.data." + key.value);
                        const isStr = type == "string";
                        const isObj = type == "object";

                        if(action.name == "set") {
                            if(value.value.match(/[\(\)\[\]]/)) {
                                Logger.warn("Possibly malicious value in setting: " + value.value)
                                throw new Error();
                            }

                            eval(`this.data.${key.value} = ${isStr ? '"' : (isObj ? "{..." : "")}${value.value}${isStr ? '"' : (isObj ? "}" : "")};`);
                        } else if(action.name == "revert") {
                            eval(`this.data.${key.value} = ${isObj ? "{..." : ""}this.defaults.${key.value}${isObj ? "}" : ""};`);
                        }
                        return eval("this.data." + key.value);
                    };

                    try {
                        const result = run.call(game.config);
                        if(action.name != "get") {
                            game.config.save();
                        }

                        const msg = `目前 \`${key.value}\` 的值為: \`${util.inspect(result)}\`` + (action.name != "get" ? "\n該設定會在下回合生效。" : "");
                        await this.respondToInteraction(ev, {
                            type: 4,
                            data: this.getCompactedMessageWithEmbed(msg)
                        }, "cmd-settings-result");
                    } catch(ex) {
                        await this.respondToInteraction(ev, {
                            type: 4,
                            data: this.getCompactedMessageWithEmbed("設定該選項的值的時候發生錯誤。", true)
                        }, "cmd-settings-error");
                    }
                    return;
                }
                
                return;
            }
        });
    }

    public isBlacklisted(id: string): boolean {
        const result = !!blacklist.find(s => s.id == id);
        if(result) {
            Logger.warn(`User ID ${id} is banned from this bot`);
        }
        return result;
    }

    public getCompactedMessageWithEmbed(message: string, ephemeral = false) {
        return {
            flags: ephemeral ? 64 : 0,
            embeds: [
                {
                    ...this.getEmbedBase(),
                    description: message
                }
            ]
        };
    }

    public async respondToInteraction(ev: KInteractionWS, data: any, name = "general-respond-interaction") {
        return await this.rest.interactions(ev.id, ev.token).callback.post({ data })
            .catch(this.failedToSendMessage(name));
    }

    public async sendMessage(channelId: string, data: any, name = "general-msg-post") {
        return await this.rest.channels(channelId).messages.post({
            data
        }).catch(this.failedToSendMessage(name));
    }

    public async editMessage(channelId: string, messageId: string, data: any, name = "general-msg-patch") {
        return await this.rest.channels(channelId).messages(messageId).patch({
            data
        }).catch(this.failedToEditMessage(name));
    }

    public async deleteMessage(channelId: string, messageId: string, name = "general-delete-msg") {
        return await this.rest.channels(channelId).messages(messageId).delete().catch(this.failedToDeleteMessage(name));
    }

    public async spawnLobby(guildId: string, ev: KInteractionWS | null = null) {
        let game = this.games.find(g => g.guildId == guildId);
        if(!game) {
            Logger.info("Game not exist for guild " + guildId + ", creating it...");
            game = new Werewolves(this, guildId);
            await game.init();
            game.prepareLobby();
            this.games.push(game);
        }

        if(game.inProgress) {
            if(ev) {
                await this.respondToInteraction(ev, {
                    type: 4,
                    data: this.getCompactedMessageWithEmbed("遊戲正在進行中，無法使用。")
                }, "cmd-game-in-progress");
            }
        } else {
            await game.cleanGameMessages();
            await game.showLobby(ev);
        }
    }

    public async login() {
        const token = this.config.getToken();
        if(!token || token == '') {
            throw new Error('Discord bot token is not set!');
        }

        await this.api.login(token);
    }

    public async registerSlashCommands() {
        await Promise.all(this.api.guilds.cache.map(async (g) => {
            await this.registerGuildSlashCommands(g);
        }));
    }

    public async registerGuildSlashCommands(guild: Guild) {
        Logger.log(`Registering command for guild: ${guild.name} (${guild.id})`);
        const settingOptions = [
            "roleMaxPlayers.seer",
            "roleMaxPlayers.witch",
            "roleMaxPlayers.hunter",
            "roleMaxPlayers.knight",
            "roleMaxPlayers.werewolves",
            "thresholds.knight",
            "thresholds.couples",
            "thresholds.sheriff",
            "features.beta",
            "features.hasCouples",
            "features.hasSheriff",
            "maxPlayers", "minPlayers",
            "debugShortTime", "debugVoteOnly"
        ].map(v => {
            return {
                name: v,
                value: v
            };
        });

        const settingOptionsAddition = [
            "roleMaxPlayers",
            "thresholds",
            "features"
        ].map(v => {
            return {
                name: v,
                value: v
            };
        });

        const commands: any = [
            {
                name: "wolf",
                description: "狼人殺指令操作。",
                options: [
                    {
                        name: "summon",
                        description: "在當前頻道開始一場狼人殺遊戲。",
                        type: CommandOptionType.SUB_COMMAND
                    },
                    {
                        name: "credit",
                        description: "想了解那些辛苦對抗各種 Bug 的開發人員嗎！！！！",
                        type: CommandOptionType.SUB_COMMAND
                    },
                    {
                        name: "stop-the-game-for-sure-plz",
                        description: "超長的指令，如果有特殊原因需要關閉遊戲，你會需要它。",
                        type: CommandOptionType.SUB_COMMAND
                    },
                    {
                        name: "settings",
                        description: "設定相關的指令。",
                        type: CommandOptionType.SUB_COMMAND_GROUP,
                        options: [
                            {
                                name: "set",
                                description: "設定選項的值。",
                                type: CommandOptionType.SUB_COMMAND,
                                options: [
                                    {
                                        name: "key",
                                        description: "設定的選項名稱。",
                                        type: CommandOptionType.STRING,
                                        choices: settingOptions,
                                        required: true
                                    },
                                    {
                                        name: "value",
                                        description: "選項的值。",
                                        type: CommandOptionType.STRING,
                                        required: true
                                    }
                                ]
                            },
                            {
                                name: "get",
                                description: "取得選項的值。",
                                type: CommandOptionType.SUB_COMMAND,
                                options: [
                                    {
                                        name: "key",
                                        description: "設定的選項名稱。",
                                        type: CommandOptionType.STRING,
                                        choices: [
                                            ...settingOptionsAddition,
                                            ...settingOptions
                                        ],
                                        required: true
                                    }
                                ]
                            },
                            {
                                name: "revert",
                                description: "將選項恢復為預設值。",
                                type: CommandOptionType.SUB_COMMAND,
                                options: [
                                    {
                                        name: "key",
                                        description: "設定的選項名稱。",
                                        type: CommandOptionType.STRING,
                                        choices: [
                                            ...settingOptionsAddition,
                                            ...settingOptions
                                        ],
                                        required: true
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }
        ];
        const app = await this.api.fetchApplication();

        await Promise.all(commands.map(async(cmd: any) => {
            // @ts-ignore
            const api: any = this.api.api;
            await api.applications(app.id).guilds(guild.id).commands.post({
                data: cmd
            });
        }));
    }

    public async acceptConsoleInput(input: string) {
        if(!this.canAcceptConsoleInput) return;

        if(input.trim().split(" ")[0] == "reload") {
            Logger.info("Reloading...");
            this.reload();
            return;
        }

        if(input.trim().split(" ")[0] == "dump" && input.length >= 6) {
            let objs = input.trim().split(" ");
            if(objs.length < 3) return;

            try {
                const depth = parseInt(objs[1]);
                if(isNaN(depth)) throw new Error();

                objs.shift();
                objs.shift();

                let obj = objs.join(" ");
                if(objs.length == 0) return;

                if(!obj.startsWith("$")) return;
                if(obj.length > 1 && obj[1] != ".") return;
                obj = obj.substring(1);
    
                try {
                    const target = eval("WerewolvesBot.instance" + obj);
                    Logger.info(util.inspect(target, false, depth, true));
                } catch(ex) {
                    Logger.error("Failed to dump");
                    Logger.error(ex.toString());
                }
            } catch(ex) {
                Logger.error(`depth "${objs[0]}" is not a number`);
            }
            return;
        }

        if(input.trim().split(" ")[0] == "announce") {
            const objs = input.trim().split(" ");
            objs.shift();

            let msg = objs.join(" ");
            if(msg.trim() == "") msg = "狼人殺機器人將重啟進行更新！造成不便請見諒QQ";
            
            this.games.forEach(game => {
                game.gameChannel?.send({
                    embed: {
                        ...this.getEmbedBase(),
                        description: msg
                    }
                });
            });

            Logger.info("Announced message: " + msg);
            return;
        }

        if(input.trim().split(" ")[0] == "exit") {
            await this.exit();
        }
    }

    public reload() {
        this.loadConfig();
        this.games.forEach(g => {
            g.loadConfig();
        });
    }

    public loadConfig() {
        this.config.load();
    }

    public getEmbedBase(): any {
        return {
            color: 0xffa970,
            author: {
                name: this.api.user?.username,
                icon_url: this.api.user?.avatarURL()
            }
        };
    }

    public async exit() {
        this.canAcceptConsoleInput = false;
        Logger.info("Exiting...");
        for(var i=0; i<this.games.length; i++) {
            await this.games[i].cleanGameMessages();
        }
        this.api.destroy();
        process.exit(0);
    }

    public failedToSendMessage(name: string) {
        return (ex: any) => {
            Logger.error("Failed to send " + name + " message");
            console.log(ex);
        };
    }

    public failedToEditMessage(name: string) {
        return (ex: any) => {
            Logger.error("Failed to edit " + name + " message");
            console.log(ex);
        };
    }

    public failedToDeleteMessage(name: string) {
        return (ex: any) => {
            Logger.error("Failed to delete " + name + " message");
            console.log(ex);
        };
    }

    public failedToDeleteChannel(name: string) {
        return (ex: any) => {
            Logger.error("Failed to delete " + name + " channel");
            console.log(ex);
        };
    }

    public failedToCreateThread(name: string) {
        return (ex: any) => {
            Logger.error("Failed to create " + name + " thread");
            console.log(ex);
        };
    }

    public failedToAddThreadMember(name: string) {
        return (ex: any) => {
            Logger.error("Failed to sadd " + name + " thread member");
            console.log(ex);
        };
    }
}