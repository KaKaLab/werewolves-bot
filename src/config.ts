import { GuildChannel, TextChannel } from 'discord.js';
import * as fs from 'fs';

const CONFIG_FILE_NAME: string = 'config.json';

export class BotConfig {
    public data: any;

    constructor() {
        this.data = JSON.parse(fs.readFileSync(CONFIG_FILE_NAME).toString());

        if(!this.data.token || this.data.token == '') {
            throw new Error('Discord bot token is not set!');
        }
    }

    public getToken(): string {
        return this.data.token;
    }

    public getGameChannel(): string {
        return this.data.gameChannel;
    }
}