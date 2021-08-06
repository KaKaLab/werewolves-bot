import { GuildChannel, TextChannel } from 'discord.js';
import * as fs from 'fs';
import { Logger } from './utils/logger';

const CONFIG_FILE_NAME: string = 'config.json';
const GUILD_DIR_NAME: string = 'guild_data';

export class BotGuildConfig {
    public data: any;
    public id: string;

    constructor(guildId: string) {
        this.id = guildId;
        this.load();
    }

    public load() {
        Logger.log("Loading config for guild: " + this.id)

        if(!fs.existsSync(GUILD_DIR_NAME)) {
            fs.mkdirSync(GUILD_DIR_NAME);
        }

        if(!fs.existsSync(GUILD_DIR_NAME + "/" + this.id)) {
            fs.mkdirSync(GUILD_DIR_NAME + "/" + this.id);
        }

        if(!fs.existsSync(GUILD_DIR_NAME + "/" + this.id + "/" + CONFIG_FILE_NAME)) {
            fs.writeFileSync(GUILD_DIR_NAME + "/" + this.id + "/" + CONFIG_FILE_NAME, "{}");
        }

        this.data = JSON.parse(fs.readFileSync(GUILD_DIR_NAME + "/" + this.id + "/" + CONFIG_FILE_NAME).toString());
        this.data = {
            gameChannel: "",
            minPlayers: 6,
            maxPlayers: 12,
            debugShortTime: false,
            ...this.data
        };
        
        this.save();
    }

    public save() {
        fs.writeFileSync(GUILD_DIR_NAME + "/" + this.id + "/" + CONFIG_FILE_NAME, JSON.stringify(this.data, null, 4));
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

    public isDebugShortTime(): boolean {
        return this.data.debugShortTime;
    }
}