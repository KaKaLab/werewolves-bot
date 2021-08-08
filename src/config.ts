import * as fs from 'fs';

const CONFIG_FILE_NAME: string = 'config.json';

type ConfigStruct = typeof BotConfig.defaultConfig & {
    [index: string]: any
};

export class BotConfig {
    public data: ConfigStruct;
    public static readonly defaultConfig = {
        version: 0,
        token: ""
    };

    constructor() {
        this.data = BotConfig.defaultConfig;
        this.load();
    }

    public load() {
        if(!fs.existsSync(CONFIG_FILE_NAME)) {
            fs.writeFileSync(CONFIG_FILE_NAME, "{}");
        }

        const config = JSON.parse(fs.readFileSync(CONFIG_FILE_NAME).toString());
        this.data = {
            ...BotConfig.defaultConfig,
            ...config
        };
        
        fs.writeFileSync(CONFIG_FILE_NAME, JSON.stringify(this.data, null, 4));
    }
    
    /**
     * Move old options to new options, or convert from old format to
     * new format, and delete unused/old options.
     */
    public upgrade() {
        
    }

    public getToken(): string {
        return this.data.token;
    }
}