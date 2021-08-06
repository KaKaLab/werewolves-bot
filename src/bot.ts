import { DMChannel, Guild, Message } from 'discord.js';
import { Client } from 'discord.js';
import { BotConfig } from './config';
import { GameState, Werewolves } from './game/werewolves';
import { Logger } from './utils/logger';
import { CommandOptionType, SlashPatch } from './utils/slash';
import * as util from "util";

export class WerewolvesBot {
    public api: Client;
    public config: BotConfig;

    private canAcceptConsoleInput = true;

    private games: Werewolves[] = [];

    public static instance: WerewolvesBot;

    constructor() {
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
            
            await this.registerSlashCommands();
        });

        this.api.on("message", (msg: Message) => {
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
            if(ev.type != 2) return;
            if(running) {
                // @ts-ignore
                const api: any = this.api.api;
                await api.interactions(ev.id, ev.token).callback.post({
                    data: {
                        type: 4,
                        data: {
                            flags: 64,
                            embeds: [
                                {
                                    ...this.getEmbedBase(),
                                    description: "正在進行其他指令，無法使用。"
                                }
                            ]
                        }
                    }
                }).catch(this.failedToSendMessage("cmd-other-running"));
                return;
            }

            if(ev.data.name == "wolf") {
                const data = ev.data;
                const sub = data.options[0];

                if(sub.name == "summon") {
                    running = true;
                    let game = this.games.find(g => g.guildId == ev.guild_id);
                    if(!game) {
                        Logger.info("Game not exist for guild " + ev.guild_id + ", creating it...");
                        game = new Werewolves(this, ev.guild_id);
                        await game.init();
                        game.prepareLobby();
                        this.games.push(game);
                    }

                    if(game.inProgress) {
                        // @ts-ignore
                        const api: any = this.api.api;
                        await api.interactions(ev.id, ev.token).callback.post({
                            type: 4,
                            data: {
                                embeds: [
                                    {
                                        ...this.getEmbedBase(),
                                        description: "遊戲正在進行中，無法使用。"
                                    }
                                ]
                            }
                        }).catch(this.failedToSendMessage("cmd-game-in-progress"));
                    } else {
                        await game.cleanGameMessages();
                        await game.showLobby(ev);
                    }
                    running = false;
                    return;
                }

                if(sub.name == "credit") {
                    // @ts-ignore
                    const api: any = this.api.api;
                    await api.interactions(ev.id, ev.token).callback.post({
                        data: {
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
                        }
                    }).catch(this.failedToSendMessage("cmd-credit"));
                    return;
                }

                if(sub.name == "stop-the-game-for-sure-plz") {
                    var sendEmbed = async (message: string) => {
                        // @ts-ignore
                        const api: any = this.api.api;
                        await api.interactions(ev.id, ev.token).callback.post({
                            data: {
                                type: 4,
                                data: {
                                    flags: 64,
                                    embeds: [
                                        {
                                            ...this.getEmbedBase(),
                                            description: message
                                        }
                                    ]
                                }
                            }
                        }).catch(this.failedToSendMessage("cmd-force-stop-result"));
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
                        const isStr = typeof eval("this." + key.value) == "string";
                        if(action.name == "set") {
                            if(value.value.match(/[\(\)\[\]]/)) {
                                Logger.warn("Possibly malicious value in setting: " + value.value)
                                throw new Error();
                            }

                            eval(`this.${key.value} = ${isStr ? '"' : ""}${value.value}${isStr ? '"' : ""};`);
                        }
                        return eval("this." + key.value);
                    };
                    try {
                        const result = run.call(game.config.data);
                        if(action.name == "set") {
                            game.config.save();
                        }

                        // @ts-ignore
                        const api: any = this.api.api;
                        await api.interactions(ev.id, ev.token).callback.post({
                            data: {
                                type: 4,
                                data: {
                                    embeds: [
                                        {
                                            ...this.getEmbedBase(),
                                            description: `目前 \`${key.value}\` 的值為: \`${util.inspect(result)}\`` + (action.name == "set" ? "\n該設定會在下回合生效。" : "")
                                        }
                                    ]
                                }
                            }
                        }).catch(this.failedToSendMessage("cmd-settings-result"));
                    } catch(ex) {
                        // @ts-ignore
                        const api: any = this.api.api;
                        await api.interactions(ev.id, ev.token).callback.post({
                            data: {
                                type: 4,
                                data: {
                                    flags: 64,
                                    embeds: [
                                        {
                                            ...this.getEmbedBase(),
                                            description: "設定該選項的值的時候發生錯誤。"
                                        }
                                    ]
                                }
                            }
                        }).catch(this.failedToSendMessage("cmd-settings-error"));
                    }
                    return;
                }

                console.log(ev.data.options[0]);
                return;
            }
        });

        this.api.login(this.config.getToken());
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
            "maxPlayers", "minPlayers", "knightThreshold",
            "debugShortTime"
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
                        description: "超長的指令，如果有特殊原因需要重開遊戲，你會需要它。",
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
                                        choices: settingOptions,
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