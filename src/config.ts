import { GuildChannel, TextChannel } from 'discord.js';
import * as fs from 'fs';

const CONFIG_FILE_NAME: string = 'config.json';

export class BotConfig {
    public data: any;

    constructor() {
        this.load();

        if(!this.data.token || this.data.token == '') {
            throw new Error('Discord bot token is not set!');
        }
    }

    public load() {
        this.data = JSON.parse(fs.readFileSync(CONFIG_FILE_NAME).toString());
    }

    public getToken(): string {
        return this.data.token;
    }

    public getGameChannel(): string {
        return this.data.gameChannel;
    }

    public getGuildId(): string {
        return this.data.guildId;
    }

    public getMaxPlayers(): number {
        return this.data.maxPlayers;
    }

    public getMinPlayers(): number {
        return this.data.minPlayers;
    }
}