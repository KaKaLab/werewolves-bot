import { DMChannel, Guild, Message } from 'discord.js';
import { Client } from 'discord.js';
import { BotConfig } from './config';
import { Werewolves } from './game/werewolves';
import { Logger } from './utils/logger';
import { CommandOptionType, SlashPatch } from './utils/slash';

export class WerewolvesBot {
    public api: Client;
    public config: BotConfig;

    private canAcceptConsoleInput = true;

    private games: Werewolves[] = [];

    constructor() {
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

        this.api.on("interactionCreate", async (ev) => {
            if(ev.type != 2) return;
            if(ev.data.name == "wolf") {
                const data = ev.data;
                if(data.options[0].name == "summon") {
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
                        api.interactions(ev.id, ev.token).callback.post({
                            type: 4,
                            data: {
                                embeds: [
                                    {
                                        ...this.getEmbedBase(),
                                        description: "遊戲正在進行中，無法使用。"
                                    }
                                ]
                            }
                        });
                    } else {
                        game.cleanGameMessages();
                        game.showLobby(ev);
                    }
                }
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

        if(input.trim() == "reload") {
            Logger.info("Reloading...");
            this.reload();
        }

        if(input.trim() == "exit") {
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