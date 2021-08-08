import { GuildChannel, TextChannel } from 'discord.js';
import * as fs from 'fs';
import { Logger } from './utils/logger';

const CONFIG_FILE_NAME: string = 'config.json';
const GUILD_DIR_NAME: string = 'guild_data';

type ConfigStruct = typeof BotGuildConfig.defaultConfig;
type RoleMaxPlayersStruct = ConfigStruct["roleMaxPlayers"];
type ThresholdsStruct = ConfigStruct["thresholds"];

export class BotGuildConfig {
    public id: string;
    public static readonly defaultConfig = {
        gameChannel: "",
        minPlayers: 6,
        maxPlayers: 12,
        debugVoteOnly: false,
        debugShortTime: false,
        roleMaxPlayers: {
            seer: 1,
            witch: 1,
            hunter: 1,
            knight: 1,
            werewolves: 2,
        },
        thresholds: {
            knight: 7,
            couples: 7
        },
        enableBeta: false,
        version: 0
    };
    
    public get defaults() {
        return BotGuildConfig.defaultConfig;
    }

    public data: typeof BotGuildConfig.defaultConfig;

    constructor(guildId: string) {
        this.data = BotGuildConfig.defaultConfig;
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

        const config = JSON.parse(fs.readFileSync(GUILD_DIR_NAME + "/" + this.id + "/" + CONFIG_FILE_NAME).toString());
        this.data = {
            ...BotGuildConfig.defaultConfig,
            ...config
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
    
    public getThresholds(): ThresholdsStruct {
        return this.data.thresholds;
    }

    public save() {
        fs.writeFileSync(GUILD_DIR_NAME + "/" + this.id + "/" + CONFIG_FILE_NAME, JSON.stringify(this.data, null, 4));
    }

    public getGameChannel(): string {
        return this.data.gameChannel;
    }

    public getMaxPlayers(): number {
        return this.data.maxPlayers;
    }

    public getMinPlayers(): number {
        return this.data.minPlayers;
    }

    public isDebugVoteOnly(): boolean {
        return this.data.debugVoteOnly;
    }

    public isDebugShortTime(): boolean {
        return this.data.debugShortTime;
    }

    public isBetaEnabled(): boolean {
        return this.data.enableBeta;
    }
}