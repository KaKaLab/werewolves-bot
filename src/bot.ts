import { DMChannel, Message } from 'discord.js';
import { Client } from 'discord.js';
import { BotConfig } from './config';
import { Werewolves } from './game/werewolves';
import { Logger } from './utils/logger';
import { SlashPatch } from './utils/slash';

export class WerewolvesBot {
    public api: Client;
    public config: BotConfig;

    private canAcceptConsoleInput = true;

    private game: Werewolves | null = null;

    public static GUILD_ID: string;

    constructor() {
        this.config = new BotConfig();
        this.api = new Client({
            partials: ["MESSAGE"]
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

            WerewolvesBot.GUILD_ID = this.config.getGuildId();
            await this.api.guilds.fetch(WerewolvesBot.GUILD_ID);

            // Werewolves start
            this.game = new Werewolves(this);
            await this.game.init();

            this.game.startLobby();
        });

        this.api.on("message", (msg: Message) => {
            if(msg.channel instanceof DMChannel && msg.author.id != this.api.user?.id) {
                Logger.info(msg.author.tag + ": " + msg.content);
            }
        })

        this.api.login(this.config.getToken());
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
        this.game?.loadConfig();
    }

    public loadConfig() {
        this.config.load();
        WerewolvesBot.GUILD_ID = this.config.getGuildId();
    }

    public async exit() {
        this.canAcceptConsoleInput = false;
        Logger.info("Exiting...");
        await this.game?.cleanGame();
        this.api.destroy();
        process.exit(0);
    }
}