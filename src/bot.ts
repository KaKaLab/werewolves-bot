import { DMChannel, Guild, Message } from 'discord.js';
import { Client } from 'discord.js';
import { BotConfig } from './config';
import { Werewolves } from './game/werewolves';
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
                if(data.options[0].name == "summon") {
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

                if(data.options[0].name == "credit") {
                    // @ts-ignore
                    const api: any = this.api.api;
                    await api.interactions(ev.id, ev.token).callback.post({
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
                    }).catch(this.failedToSendMessage("cmd-credit"));
                    return;
                }
            }
        });

        this.api.login(this.config.getToken());
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

    public async registerSlashCommands() {
        await Promise.all(this.api.guilds.cache.map(async (g) => {
            await this.registerGuildSlashCommands(g);
        }));
    }

    public async registerGuildSlashCommands(guild: Guild) {
        Logger.log(`Registering command for guild: ${guild.name} (${guild.id})`);
        const commands: any = [
            {
                name: "wolf",
                description: "狼人殺指令操作。",
                options: [
                    {
                        name: "summon",
                        description: "在當前頻道開始一場狼人殺遊戲。",
                        type: CommandOptionType.SUB_COMMAND
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
            let objs = input.trim().split(" ", 3);
            if(objs.length < 3) return;

            try {
                const depth = parseInt(objs[1]);
                if(isNaN(depth)) throw new Error();
                
                let obj = objs[2];
                if(!obj) return;

                if(!obj.startsWith("$")) return;
                if(obj.length > 1 && obj[1] != ".") return;
                obj = obj.substring(1);
    
                try {
                    const target = eval("WerewolvesBot.instance" + obj);
                    Logger.info(util.inspect(target, false, depth, true));
                } catch(ex) {
                    Logger.error("Failed to dump");
                }
            } catch(ex) {
                Logger.error(`depth "${objs[0]}" is not a number`);
            }
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
}