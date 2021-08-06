import { GuildChannel, TextChannel } from 'discord.js';
import * as fs from 'fs';
import { Logger } from './utils/logger';

const CONFIG_FILE_NAME: string = 'config.json';
const GUILD_DIR_NAME: string = 'guild_data';

type RoleMaxPlayersStruct = {
    seer: number,
    witch: number,
    hunter: number,
    knight: number,
    werewolves: number
};

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
            roleMaxPlayers: {
                seer: 1,
                witch: 1,
                hunter: 1,
                knight: 1,
                werewolves: 2,
            },
            knightThreshold: 6,
            version: 0,
            ...this.data
        };
        
        this.upgrade();
        this.save();
    }

    public upgrade() {
        
    }

    public getRoleMaxPlayers(): RoleMaxPlayersStruct {
        return {
            ...this.data.roleMaxPlayers
        };
    }

    public getKnightThreshold(): number {
        return this.data.knightThreshold;
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