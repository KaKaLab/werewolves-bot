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
        if(!fs.existsSync(CONFIG_FILE_NAME)) {
            fs.writeFileSync(CONFIG_FILE_NAME, "{}");
        }

        this.data = JSON.parse(fs.readFileSync(CONFIG_FILE_NAME).toString());
        this.data = {
            token: "",
            ...this.data
        };
        
        fs.writeFileSync(CONFIG_FILE_NAME, JSON.stringify(this.data, null, 4));
    }

    public getToken(): string {
        return this.data.token;
    }
}