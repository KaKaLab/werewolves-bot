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

    public static readonly GUILD_ID = "680280617149005836";

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
            await this.api.user?.setStatus("idle");

            await this.api.guilds.fetch(WerewolvesBot.GUILD_ID);

            // Werewolves start
            this.game = new Werewolves(this);
            await this.game.init();

            this.game.startLobby();
        });

        this.api.login(this.config.getToken());
    }

    public async acceptConsoleInput(input: string) {
        if(!this.canAcceptConsoleInput) return;

        if(input.trim() == "exit") {
            this.canAcceptConsoleInput = false;
            Logger.info("Exiting...");
            await this.game?.stopGame();
            this.api.destroy();
            process.exit(0);
        }
    }
}