import { Client, Guild, GuildChannel, GuildMember, TextChannel, KInteractionWS } from "discord.js";
import { WerewolvesBot } from "../bot";
import { BotGuildConfig } from "../guildConfig";
import { Logger } from "../utils/logger";
import { Role } from "./roles";

export enum GameState {
    READY,
    STARTED,
    WEREWOLVES,
    SEER,
    WITCH,
    DISCUSS,
    KNIGHT,
    HUNTER,
    VOTE,
    ENDED
}

type PlayableChannel = TextChannel;

export class WPlayer {
    public member: GuildMember;
    public number: number;
    public alive: boolean = true; 
    public role: Role = Role.INNOCENT;

    public choice: number = -1;
    public votes: number = 0;

    constructor(number: number, member: GuildMember) {
        this.number = number;
        this.member = member;
    }

    public kill() {
        this.alive = false;
    }

    public toString() {
        return `Player #${this.number}, alive=${this.alive}, role=${this.role}`;
    }
}

export class Werewolves {
    public players: WPlayer[] = []
    private votes: WPlayer[] = []
    public state: GameState = GameState.READY;
    private bot: WerewolvesBot;

    public guildId: string;
    public config: BotGuildConfig;

    public gameChannel: PlayableChannel | null = null;

    private threadChannel: string | null = null;
    private appId: string | null = null;
    private interactionToken: string | null = null;
    
    private hasThread = false;

    private wolvesKilled = -1;
    private witchTarget = -1;
    private votedDown = -1;
    private witchAction: string | null = null;
    private voteLimit = -1;

    private voteQuote = "";
    private voteMsgId = null;

    private hunterNext = () => {};

    private currentTimeout: NodeJS.Timeout | null = null;

    private daysCount = -1;

    public inProgress = false;
    public startTime = new Date();

    private witchRemainSkills = {
        kill: 1,
        save: 1
    };

    private witchAMsgId: string | null = null;

    constructor(bot: WerewolvesBot, guild: string) {
        this.bot = bot;
        this.guildId = guild;
        this.config = new BotGuildConfig(guild);
    }

    public loadConfig() {
        this.config.load();
    }

    public isMemberInGame(id: string) {
        return !!this.players.find(p => p.member.id == id);
    }

    /**
     * Setups event listeners to handle interactions sent from Discord.
     */
    public async init() {
        this.bot.api.on("interactionCreate", async (ev) => {
            if(this.bot.isBlacklisted(ev.member.user.id)) return;
            if(ev.guild_id != this.guildId) return;
            if(ev.type != 3) return;

            Logger.log(`Interaction issuer: ${ev.member.user.username}#${ev.member.user.discriminator} (in guild ${ev.guild_id})`);

            if(this.state == GameState.READY) {
                Logger.log(`interaction (${this.guildId}) -> state: ready`);
                await this.handleLobbyInteraction(ev);
                return;
            }

            if(this.state == GameState.WEREWOLVES) {
                Logger.log(`interaction (${this.guildId}) -> state: werewolves`);
                await this.handleWerewolvesInteraction(ev);
                return;
            }

            if(this.state == GameState.SEER) {
                Logger.log(`interaction (${this.guildId}) -> state: seer`);
                await this.handleSeerInteraction(ev);
                return;
            }

            if(this.state == GameState.WITCH) {
                if(ev.message.id == this.witchAMsgId) {
                    Logger.log(`interaction (${this.guildId}) -> state: witchA`);
                    await this.handleWitchInteractionA(ev);
                } else {
                    Logger.log(`interaction (${this.guildId}) -> state: witchB`);
                    await this.handleWitchInteractionB(ev);
                }
                return;
            }

            if(this.state == GameState.DISCUSS) {
                Logger.log(`interaction (${this.guildId}) -> state: discuss`);
                await this.handleDiscussInteraction(ev);
                return;
            }

            if(this.state == GameState.KNIGHT) {
                Logger.log(`interaction (${this.guildId}) -> state: knight`);
                await this.handleKnightInteraction(ev);
                return;
            }

            if(this.state == GameState.HUNTER) {
                Logger.log(`interaction (${this.guildId}) -> state: hunter`);
                await this.handleHunterInteraction(ev);
                return;
            }

            if(this.state == GameState.VOTE) {
                Logger.log(`interaction (${this.guildId}) -> state: vote`);
                await this.handleVoteInteraction(ev);
                return;
            }

            Logger.warn("unhandled, state == " + this.state);
        });
    }

    private async handleLobbyInteraction(ev: KInteractionWS) {
        const userId = ev.member.user.id;
        const guild = this.bot.api.guilds.cache.get(this.guildId)!!;
        const member = await guild.members.fetch(userId);

        var sendEphemeralEmbed = (desc: string) => {
            // @ts-ignore
            const api: any = this.bot.api.api;
            api.interactions(ev.id, ev.token).callback.post({
                data: {
                    type: 4,
                    data: {
                        flags: 64,
                        embeds: [
                            {
                                ...this.getEmbedBase(),
                                description: desc
                            }
                        ]
                    }
                }
            }).catch(this.bot.failedToSendMessage("lobby-ephemeral"));
        }

        switch(ev.data.custom_id) {
            case "game_join":
                if(this.players.length >= this.config.getMaxPlayers()) {
                    sendEphemeralEmbed("人數已滿，無法再加入。");
                    return;
                }

                if(!this.players.find(m => m.member.id == userId)) {
                    const p = new WPlayer(this.players.length + 1, member);
                    this.players.push(p);
                }
                break;
            case "game_leave":
                if(!this.players.find(p => p.member.id == userId)) {
                    sendEphemeralEmbed("你不在遊戲當中，無法執行該操作。");
                    return;
                }

                const index = this.players.findIndex(m => m.member.id == userId);
                if(index != -1) {
                    this.players.splice(index, 1);
                }
                break;
            case "game_start":
                if(!this.players.find(p => p.member.id == userId)) {
                    sendEphemeralEmbed("你不在遊戲當中，無法執行該操作。");
                    return;
                }
                if(this.inProgress) return;

                this.startGame(ev);  
                return;
        }

        // @ts-ignore
        const api: any = this.bot.api.api;
        api.interactions(ev.id, ev.token).callback.post({
            data: {
                type: 7,
                data: this.getLobbyMessage()
            }
        }).catch(this.bot.failedToSendMessage("lobby"));

        if(!!this.appId) {
            this.threadChannel = ev.message.id;
            this.appId = null;
            this.interactionToken = null;
        }
    }

    public getWerewolves(): WPlayer[] {
        return this.players.filter((p: WPlayer) => {
            return p.role == Role.WEREWOLVES;
        });
    }

    public getSeers(): WPlayer[] {
        return this.players.filter((p: WPlayer) => {
            return p.role == Role.SEER;
        });
    }

    public getWitches(): WPlayer[] {
        return this.players.filter((p: WPlayer) => {
            return p.role == Role.WITCH;
        });
    }

    public getKnights(): WPlayer[] {
        return this.players.filter((p: WPlayer) => {
            return p.role == Role.KNIGHT;
        });
    }

    public getHunters(): WPlayer[] {
        return this.players.filter((p: WPlayer) => {
            return p.role == Role.HUNTER;
        });
    }

    public refreshVotes() {
        this.players.forEach(v => {
            v.votes = 0;
        });

        this.players.forEach(v => {
            if(v.choice >= 0) {
                this.votes[v.choice].votes++;
            }
        });
    }

    private getPlayerDeadInvalidMessage() {
        return {
            embeds: [
                {
                    ...this.getEmbedBase(),
                    description: "你已經死亡，無法執行該操作。"
                }
            ],
            flags: 64
        };
    }

    private async handleWerewolvesInteraction(ev: KInteractionWS) {
        if(ev.data.custom_id != "werewolves_kill") return;

        const userId = ev.member.user.id;
        const guild = this.bot.api.guilds.cache.get(this.guildId)!!;
        const member = await guild.members.fetch(userId);

        // @ts-ignore
        var rest: any = this.bot.api.api;

        const player = this.getWerewolves().find(p => {
            return p.member.id == userId
        });
        if(!player) {
            rest.interactions(ev.id, ev.token).callback.post({
                data: {
                    type: 4,
                    data: this.getRoleMismatchMessage(Role.WEREWOLVES)
                }
            }).catch(this.bot.failedToSendMessage("not-werewolves"));
            return;
        }
        if(!player.alive) {
            rest.interactions(ev.id, ev.token).callback.post({
                data: {
                    type: 4,
                    data: this.getPlayerDeadInvalidMessage()
                }
            }).catch(this.bot.failedToSendMessage("werewolves-dead"));
            return;
        }
        
        const opt: string = ev.data.values[0];
        if(!opt.startsWith("player_")) {
            return;
        }

        this.wolvesKilled = parseInt(opt.substring(7));
        const killed = this.players.find(p => p.number == this.wolvesKilled);

        await rest.interactions(ev.id, ev.token).callback.post({
            data: {
                type: 4,
                data: {
                    flags: 64,
                    embeds: [
                        {
                            ...this.getEmbedBase(),
                            description: `你殺掉了 <@${killed!!.member.id}>。`
                        }
                    ]
                }
            }
        }).catch(this.bot.failedToSendMessage("werewolves-killed"));

        // @ts-ignore
        rest = this.bot.api.api;
        await rest.channels(this.threadChannel!!).messages(ev.message.id).delete().catch(this.bot.failedToDeleteMessage("werewolves-source"));

        await this.turnOfSeer();    
    }

    private async handleSeerInteraction(ev: KInteractionWS) {
        if(ev.data.custom_id != "seer_inspect") {
            Logger.warn("Not seer_inspect, but get " + ev.data.custom_id);
            return;
        }

        const userId = ev.member.user.id;
        const guild = this.bot.api.guilds.cache.get(this.guildId)!!;
        const member = await guild.members.fetch(userId);

        // @ts-ignore
        var rest: any = this.bot.api.api;

        const player = this.getSeers().find(p => {
            return p.member.id == userId
        });
        if(!player) {
            rest.interactions(ev.id, ev.token).callback.post({
                data: {
                    type: 4,
                    data: this.getRoleMismatchMessage(Role.SEER)
                }
            }).catch(this.bot.failedToSendMessage("not-seer"));
            return;
        }
        if(!player.alive) {
            rest.interactions(ev.id, ev.token).callback.post({
                data: {
                    type: 4,
                    data: this.getPlayerDeadInvalidMessage()
                }
            }).catch(this.bot.failedToSendMessage("seer-dead"));
            return;
        }
        
        const opt: string = ev.data.values[0];
        if(!opt.startsWith("player_")) {
            Logger.warn("Not started with player_, but get " + opt);
            return;
        }

        const n = parseInt(opt.substring(7));
        const p = this.players.find(p => p.number == n)!!;
        const isWolf = p.role == Role.WEREWOLVES;

        await rest.interactions(ev.id, ev.token).callback.post({
            data: {
                type: 4,
                data: {
                    flags: 64,
                    embeds: [
                        {
                            ...this.getEmbedBase(),
                            description: `<@${p.member.id}> 是${isWolf ? "狼人" : "好人"}。`
                        }
                    ]
                }
            }
        }).catch(this.bot.failedToSendMessage("seer-inspected"));

        // @ts-ignore
        rest = this.bot.api.api;
        await rest.channels(this.threadChannel!!).messages(ev.message.id).delete().catch(this.bot.failedToDeleteMessage("seer-source"));

        this.turnOfWitchA();    
    }

    private async handleWitchInteractionA(ev: KInteractionWS) {
        if(!ev.data.custom_id.startsWith("witch_")) return;

        const userId = ev.member.user.id;
        const guild = this.bot.api.guilds.cache.get(this.guildId)!!;
        const member = await guild.members.fetch(userId);

        // @ts-ignore
        var rest: any = this.bot.api.api;

        const player = this.getWitches().find(p => {
            return p.member.id == userId
        });
        if(!player) {
            rest.interactions(ev.id, ev.token).callback.post({
                data: {
                    type: 4,
                    data: this.getRoleMismatchMessage(Role.WITCH)
                }
            }).catch(this.bot.failedToSendMessage("not-witch"));
            return;
        }
        if(!player.alive) {
            rest.interactions(ev.id, ev.token).callback.post({
                data: {
                    type: 4,
                    data: this.getPlayerDeadInvalidMessage()
                }
            }).catch(this.bot.failedToSendMessage("witch-dead"));
            return;
        }

        const key = ev.data.custom_id.substring(6);
        if(key == "inspect") {
            const wolvesKilled = this.players.find(p => p.number == this.wolvesKilled);
            rest.interactions(ev.id, ev.token).callback.post({
                data: {
                    type: 4,
                    data: {
                        embeds: [
                            {
                                ...this.getEmbedBase(),
                                description: `本回合狼人殺了 <@${wolvesKilled?.member.id}>。`
                            }
                        ],
                        flags: 64
                    }
                }
            }).catch(this.bot.failedToSendMessage("witch-inspect-killer"));

            return;
        }
        else if(key == "skip") {
            rest.interactions(ev.id, ev.token).callback.post({
                data: {
                    type: 4,
                    data: {
                        embeds: [
                            {
                                ...this.getEmbedBase(),
                                description: "你選擇跳過本回合。"
                            }
                        ],
                        flags: 64
                    }
                }
            }).catch(this.bot.failedToSendMessage("witch-skip"));

            // @ts-ignore
            rest = this.bot.api.api;
            await rest.channels(this.threadChannel!!).messages(this.witchAMsgId).delete().catch(this.bot.failedToDeleteMessage("witch-source"));

            this.turnOfDaylight("女巫請閉眼。");
        } else {
            // @ts-ignore
            const remains: number = this.witchRemainSkills[key];
            if(remains <= 0) {
                rest.interactions(ev.id, ev.token).callback.post({
                    data: {
                        type: 4,
                        data: {
                            flags: 64,
                            embeds: [
                                {
                                    ...this.getEmbedBase(),
                                    description: (key == "kill" ? "毒藥" : "解藥") + "已用完。"
                                }
                            ]
                        }
                    }
                }).catch(this.bot.failedToSendMessage("witch-skill-exhaust"));
                return;
            }

            // @ts-ignore
            this.witchRemainSkills[key]--;

            // @ts-ignore
            const type: "投毒" | "解藥" = {
                kill: "投毒",
                save: "解藥"
            }[key];
            this.witchAction = key;

            rest.interactions(ev.id, ev.token).callback.post({
                data: {
                    type: 4,
                    data: {
                        ...this.getWitchMessageB(type),
                        flags: 64
                    }
                }
            }).catch(this.bot.failedToSendMessage("witchB"));
        }
    }

    private async handleWitchInteractionB(ev: KInteractionWS) {
        if(!ev.data.custom_id.startsWith("witch_")) return;

        const userId = ev.member.user.id;
        const guild = this.bot.api.guilds.cache.get(this.guildId)!!;
        const member = await guild.members.fetch(userId);

        // @ts-ignore
        var rest: any = this.bot.api.api;

        const player = this.getWitches().find(p => {
            return p.member.id == userId
        });
        if(!player) {
            rest.interactions(ev.id, ev.token).callback.post({
                data: {
                    type: 4,
                    data: this.getRoleMismatchMessage(Role.WITCH)
                }
            }).catch(this.bot.failedToSendMessage("not-witch"));
            return;
        }
        if(!player.alive) {
            rest.interactions(ev.id, ev.token).callback.post({
                data: {
                    type: 4,
                    data: this.getPlayerDeadInvalidMessage()
                }
            }).catch(this.bot.failedToSendMessage("witch-dead"));
            return;
        }

        const opt: string = ev.data.values[0];
        if(!opt.startsWith("player_")) {
            Logger.warn("Not started with player_, but get " + opt);
            return;
        }

        const n = parseInt(opt.substring(7));
        const p = this.players.find(p => p.number == n)!!;
        this.witchTarget = p.number;
        
        // @ts-ignore
        const type: "投毒" | "解藥" = {
            kill: "投毒",
            save: "解藥"
        }[this.witchAction!!];

        rest.interactions(ev.id, ev.token).callback.post({
            data: {
                type: 4,
                data: {
                    flags: 64,
                    embeds: [
                        {
                            ...this.getEmbedBase(),
                            description: `你選擇對 <@${p.member.id}> ${type}。`
                        }
                    ]
                }
            }
        }).catch(this.bot.failedToSendMessage("witch-action"));

        // @ts-ignore
        rest = this.bot.api.api;
        await rest.channels(this.threadChannel!!).messages(this.witchAMsgId).delete().catch(this.bot.failedToDeleteMessage("witch-msg-a"));

        this.turnOfDaylight("女巫請閉眼。");
    }

    private async handleDiscussInteraction(ev: KInteractionWS) {
        if(!ev.data.custom_id.startsWith("discuss")) {
            Logger.warn("Not discuss, but get " + ev.data.custom_id);
            return;
        }

        const userId = ev.member.user.id;
        // const guild = this.bot.api.guilds.cache.get(WerewolvesBot.GUILD_ID)!!;
        // const member = await guild.members.fetch(userId);

        var sendEphemeralEmbed = (desc: string) => {
            // @ts-ignore
            const api: any = this.bot.api.api;
            api.interactions(ev.id, ev.token).callback.post({
                data: {
                    type: 4,
                    data: {
                        flags: 64,
                        embeds: [
                            {
                                ...this.getEmbedBase(),
                                description: desc
                            }
                        ]
                    }
                }
            }).catch(this.bot.failedToSendMessage("discuss-ephemeral"));
        }
        const player = this.players.find(p => p.member.id == userId);
        if(!player) {
            sendEphemeralEmbed("你不在遊戲當中，無法執行該操作。");
            return;
        }
        if(!player?.alive) {
            rest.interactions(ev.id, ev.token).callback.post({
                data: {
                    type: 4,
                    data: this.getPlayerDeadInvalidMessage()
                }
            }).catch(this.bot.failedToSendMessage("discuss-dead"));
            return;
        }

        // @ts-ignore
        var rest: any = this.bot.api.api;
        const key = ev.data.custom_id.substring(8);
        
        switch(key) {
            case "vote":
                rest.channels(this.threadChannel!!).messages(ev.message.id).delete().catch(this.bot.failedToDeleteMessage("discuss-source-a"));
                this.voteLimit = this.players.length;
                this.votes = [];
                Array.prototype.push.apply(this.votes, this.players);
                this.turnOfVote();
                break;
            case "knight":
                const player = this.getKnights().find(p => {
                    return p.member.id == userId
                });
                if(!player) {
                    rest.interactions(ev.id, ev.token).callback.post({
                        data: {
                            type: 4,
                            data: this.getRoleMismatchMessage(Role.KNIGHT)
                        }
                    }).catch(this.bot.failedToSendMessage("discuss-not-knight"));
                    return;
                }

                rest.channels(this.threadChannel!!).messages(ev.message.id).delete().catch(this.bot.failedToDeleteMessage("discuss-source-b"));
                
                // @ts-ignore
                rest = this.bot.api.api;
                rest.interactions(ev.id, ev.token).callback.post({
                    data: {
                        type: 4,
                        data: this.getKnightMessage()
                    }
                }).catch(this.bot.failedToSendMessage("discuss-knight"));

                this.state = GameState.KNIGHT;
                Logger.log("state (" + this.guildId + ") -> knight");
                return;
        }
    }

    private async handleKnightInteraction(ev: KInteractionWS) {
        if(ev.data.custom_id != "knight_inspect") {
            Logger.warn("Not knight_inspect, but get " + ev.data.custom_id);
            return;
        }

        const userId = ev.member.user.id;
        const guild = this.bot.api.guilds.cache.get(this.guildId)!!;
        const member = await guild.members.fetch(userId);

        // @ts-ignore
        var rest: any = this.bot.api.api;

        const player = this.getKnights().find(p => {
            return p.member.id == userId
        });
        if(!player) {
            rest.interactions(ev.id, ev.token).callback.post({
                data: {
                    type: 4,
                    data: this.getRoleMismatchMessage(Role.KNIGHT)
                }
            }).catch(this.bot.failedToSendMessage("not-knight"));
            return;
        }
        if(!player.alive) {
            rest.interactions(ev.id, ev.token).callback.post({
                data: {
                    type: 4,
                    data: this.getPlayerDeadInvalidMessage()
                }
            }).catch(this.bot.failedToSendMessage("knight-dead"));
            return;
        }
        
        const opt: string = ev.data.values[0];
        if(!opt.startsWith("player_")) {
            Logger.warn("Not started with player_, but get " + opt);
            return;
        }

        const n = parseInt(opt.substring(7));
        const p = this.players.find(p => p.number == n)!!;
        const isWolf = p.role == Role.WEREWOLVES;

        (isWolf ? p : player).kill();

        await rest.interactions(ev.id, ev.token).callback.post({
            data: {
                type: 4,
                data: {
                    embeds: [
                        {
                            ...this.getEmbedBase(),
                            description: `<@${p.member.id}> 是${isWolf ? "狼人，狼人死亡" : "好人，騎士以死謝罪"}。`
                        }
                    ]
                }
            }
        }).catch(this.bot.failedToSendMessage("knight-result"));

        // @ts-ignore
        rest = this.bot.api.api;
        rest.channels(this.threadChannel!!).messages(ev.message.id).delete().catch(this.bot.failedToDeleteMessage("knight-source"));

        this.turnOfWerewolves();    
    }

    private async handleHunterInteraction(ev: KInteractionWS) {
        if(ev.data.custom_id != "hunter_target") return;

        const userId = ev.member.user.id;
        const guild = this.bot.api.guilds.cache.get(this.guildId)!!;
        const member = await guild.members.fetch(userId);

        // @ts-ignore
        var rest: any = this.bot.api.api;

        const player = this.getHunters().find(p => {
            return p.member.id == userId
        });
        if(!player) {
            rest.interactions(ev.id, ev.token).callback.post({
                data: {
                    type: 4,
                    data: this.getRoleMismatchMessage(Role.HUNTER)
                }
            }).catch(this.bot.failedToSendMessage("not-hunter"));
            return;
        }
        
        const opt: string = ev.data.values[0];
        if(!opt.startsWith("player_")) {
            return;
        }

        const hunted = parseInt(opt.substring(7));
        const killed = this.players.find(p => p.number == hunted);
        killed?.kill();

        await rest.interactions(ev.id, ev.token).callback.post({
            data: {
                type: 4,
                data: {
                    embeds: [
                        {
                            ...this.getEmbedBase(),
                            description: `獵人帶走了 <@${killed!!.member.id}>。`
                        }
                    ]
                }
            }
        }).catch(this.bot.failedToSendMessage("hunter-killed"));

        // @ts-ignore
        rest = this.bot.api.api;
        await rest.channels(this.threadChannel!!).messages(ev.message.id).delete().catch(this.bot.failedToDeleteMessage("hunter-source"));

        await this.checkEndOrNext(() => {
            this.hunterNext();
        });  
    }

    private async handleVoteInteraction(ev: KInteractionWS) {
        if(ev.data.custom_id != "vote") {
            return;
        }

        const userId = ev.member.user.id;
        // const guild = this.bot.api.guilds.cache.get(WerewolvesBot.GUILD_ID)!!;
        // const member = await guild.members.fetch(userId);

        var sendEphemeralEmbed = (desc: string) => {
            // @ts-ignore
            const api: any = this.bot.api.api;
            api.interactions(ev.id, ev.token).callback.post({
                data: {
                    type: 4,
                    data: {
                        flags: 64,
                        embeds: [
                            {
                                ...this.getEmbedBase(),
                                description: desc
                            }
                        ]
                    }
                }
            }).catch(this.bot.failedToSendMessage("vote-ephemeral"));
        }

        const player = this.players.find(p => p.member.id == userId);
        if(!player) {
            sendEphemeralEmbed("你不在遊戲當中，無法執行該操作。");
            return;
        }
        if(!player?.alive) {
            rest.interactions(ev.id, ev.token).callback.post({
                data: {
                    type: 4,
                    data: this.getPlayerDeadInvalidMessage()
                }
            }).catch(this.bot.failedToSendMessage("vote-dead"));
            return;
        }

        // @ts-ignore
        var rest: any = this.bot.api.api;
        const opt: string = ev.data.values[0];
        if(!opt.startsWith("vote_")) {
            Logger.warn("Not started with vote_, but get " + opt);
            return;
        }

        const n = parseInt(opt.substring(5));
        const p = this.players.find(p => p.member.id == userId)!!;
        p.choice = p.alive ? n : -1;
        this.refreshVotes();

        await rest.interactions(ev.id, ev.token).callback.post({
            data: {
                type: 7,
                data: this.getVoteMessage()
            }
        }).catch(this.bot.failedToEditMessage("vote-result"));
    }

    private getRoleMismatchMessage(role: Role) {
        return {
            flags: 64,
            embeds: [
                {
                    ...this.getEmbedBase(),
                    description: `你的身分不是${Role.getName(role)}，無法執行這個操作。`
                }
            ]
        };
    }

    private async turnOfWerewolves() {
        this.state = GameState.WEREWOLVES;
        Logger.log("state (" + this.guildId + ") -> werewolves");

        // @ts-ignore
        const rest: any = this.bot.api.api;
        await rest.channels(this.threadChannel!!).messages.post({
            data: this.getWerewolvesMessage()
        }).catch(this.bot.failedToSendMessage("werewolves-action"));
    }

    private async turnOfSeer() {
        if(this.getSeers().find(p => p.alive)) {
            this.state = GameState.SEER;
            Logger.log("state (" + this.guildId + ") -> seer");

            // @ts-ignore
            const api: any = this.bot.api.api;
            api.channels(this.threadChannel!!).messages.post({
                data: this.getSeerMessage()
            }).catch(this.bot.failedToSendMessage("seer-turn"));
        } else {
            this.turnOfWitchA();
        }
    }

    private async turnOfWitchA() {
        this.witchTarget = -1;
        this.witchAction = null;
        if(this.getWitches().find(p => p.alive)) {
            // @ts-ignore
            const api: any = this.bot.api.api;
            const prefix = this.state == GameState.WEREWOLVES ? "狼人請閉眼，" : "預言家請閉眼，";

            this.state = GameState.WITCH;
            Logger.log("state (" + this.guildId + ") -> witch");

            const r = await api.channels(this.threadChannel!!).messages.post({
                data: this.getWitchMessageA(prefix)
            }).catch(this.bot.failedToSendMessage("witch-turn-a"));
            this.witchAMsgId = r.id;
            Logger.info("WitchA msg id -> " + this.witchAMsgId);
        } else {
            this.turnOfDaylight(GameState.WEREWOLVES ? "狼人請閉眼。" : "預言家請閉眼。");
        }
    }

    private async turnOfDaylight(prefix: string) {
        this.votes = [];
        const wolvesKilled = this.players.find(p => p.number == this.wolvesKilled);
        const witchTarget = this.players.find(p => p.number == this.witchTarget);

        let saved = true;
        if(!(this.witchAction == "save" && this.witchTarget == this.wolvesKilled)) {
            const killed = wolvesKilled;
            killed?.kill();
            saved = false;
        }

        if(this.witchAction == "kill") {
            const killed = witchTarget;
            killed?.kill();
        }

        this.daysCount++;

        const quote = saved ?
            `${prefix}天亮了。昨晚是平安夜。` :
            (this.witchAction == "kill" && this.witchTarget != this.wolvesKilled ?
                `${prefix}天亮了。昨晚死亡的是 <@${wolvesKilled?.member.id}>、<@${witchTarget?.member.id}>。` :
                `${prefix}天亮了。昨晚死亡的是 <@${wolvesKilled?.member.id}>。`);

        this.turnOfHunter(quote, () => {
            this.turnOfDiscuss(quote);
        });
    }

    private async turnOfHunter(quote: string, next: () => void) {
        const wolvesKilled = this.players.find(p => p.number == this.wolvesKilled);
        const votedDown = this.votes[0];

        let hunter: WPlayer | null = null;
        if(wolvesKilled?.role == Role.HUNTER) hunter = wolvesKilled;
        if(votedDown?.role == Role.HUNTER) hunter = votedDown;

        if(hunter) {
            this.state = GameState.HUNTER;
            Logger.log("state (" + this.guildId + ") -> hunter");

            // @ts-ignore
            const api: any = this.bot.api.api;
            api.channels(this.threadChannel!!).messages.post({
                data: {
                    embeds: [
                        {
                            ...this.getGameEmbed(),
                            description: quote + `\n<@${hunter.member.id}> 是獵人，請選擇要帶走的對象:`
                        }
                    ],
                    components: this.getHunterComponents()
                }
            }).catch(this.bot.failedToSendMessage("hunter-turn"));
            this.hunterNext = next;
        } else {
            this.checkEndOrNext(next);
        }
    }

    private async turnOfDiscuss(quote: string) {
        this.state = GameState.DISCUSS;
        Logger.log("state (" + this.guildId + ") -> discuss");

        // @ts-ignore
        const api: any = this.bot.api.api;

        this.voteLimit = this.players.length;
        this.votes = [];
        Array.prototype.push.apply(this.votes, this.players);

        const discussTime = this.config.isDebugShortTime() ? 15 : 120;

        const r = await api.channels(this.threadChannel!!).messages.post({
            data: {
                embeds: [
                    {
                        ...this.getGameEmbed(),
                        description: quote + ((quote && quote.trim() != "") ? "\n" : "") +`請玩家發言，${discussTime} 秒後開放投票。`
                    }
                ],
                components: this.getDiscussComponents()
            }
        }).catch(this.bot.failedToSendMessage("discuss-turn"));

        this.currentTimeout = setTimeout(() => {
            // @ts-ignore
            const api: any = this.bot.api.api;
            api.channels(this.threadChannel!!).messages(r.id).patch({
                data: {
                    components: this.getDiscussComponents(true)
                }
            }).catch(this.bot.failedToEditMessage("discuss-enable-vote"));
        }, discussTime * 1000);
    }

    private async turnOfVote(appendEmbeds: any[] = []) {
        this.state = GameState.VOTE;
        Logger.log("state (" + this.guildId + ") -> vote");

        // @ts-ignore
        const api: any = this.bot.api.api;

        const voteTime = this.config.isDebugShortTime() ? 10 : 30;
        this.voteQuote = `請開始投票，${voteTime} 秒後結束投票。`;
        
        while(this.voteLimit < this.votes.length) {
            this.votes.pop();
        }

        this.players.forEach(v => {
            v.choice = -1;
        });
        this.refreshVotes();

        const r = await api.channels(this.threadChannel!!).messages.post({
            data: this.getVoteMessage(appendEmbeds)
        }).catch(this.bot.failedToSendMessage("vote-turn"));
        this.voteMsgId = r.id;

        this.currentTimeout = setTimeout(() => {
            this.endOfVote();
        }, voteTime * 1000);
    }

    private async endOfVote() {
        // @ts-ignore
        let api: any = this.bot.api.api;
        Logger.log("endOfVote() called");

        await api.channels(this.threadChannel!!).messages(this.voteMsgId).delete().catch(this.bot.failedToDeleteMessage("vote-msg"));

        this.votes.sort((a, b) => {
            return b.votes - a.votes;
        });

        if(this.votes[0].votes == 0) {
            // @ts-ignore
            api = this.bot.api.api;
            await api.channels(this.threadChannel!!).messages.post({
                data: {
                    embeds: [
                        {
                            ...this.getEmbedBase(),
                            description: `無人投票，進入下一晚...`
                        }
                    ]
                }
            }).catch(this.bot.failedToSendMessage("vote-transition-night"));
            this.turnOfWerewolves();
            return;
        }

        let t = 0;
        this.votes.forEach(v => {
            if(this.votes[0].votes == v.votes) {
                t++;
            }
        });

        if(t > 1) {
            this.voteLimit = t;
            this.turnOfVote([
                {
                    ...this.getEmbedBase(),
                    description: `有 ${t} 個人同票，需要重新投票！`
                }
            ]);
            return;
        }

        // @ts-ignore
        api = this.bot.api.api;
        await api.channels(this.threadChannel!!).messages.post({
            data: {
                embeds: [
                    {
                        ...this.getEmbedBase(),
                        description: `最高票為 <@${this.votes[0].member.id}>`
                    }
                ]
            }
        }).catch(this.bot.failedToSendMessage("vote-down-max"));
        this.votes[0].kill();

        this.turnOfHunter("", () => {
            this.turnOfWerewolves();
        });
    }

    public assignRoles() {
        const roleCount: number[] = [];
        for(var i=0; i<Role.COUNT; i++) {
            roleCount.push(0);
        }

        const b = this.players.length;
        var mod = (b + 1) % 3;
        var priestCount = ((b + 1) / 9) | 0;
        var counter = 0;

        const settings = this.config.getRoleMaxPlayers();
        const seerCount = settings.seer;
        const witchCount = settings.witch;
        const hunterCount = settings.hunter;
        const knightCount = settings.knight;
        const werewolvesCount = settings.werewolves;
        const knightThreshold = this.config.getKnightThreshold();

        let maxRole = seerCount;
        maxRole += witchCount;
        maxRole += hunterCount;
        maxRole += werewolvesCount;
        if(b > knightThreshold) maxRole += knightCount;
        
        while (counter < maxRole) {
            const innocents = this.players.filter(p => p.role == Role.INNOCENT);
            const r = Math.floor((Role.COUNT - 1) * Math.random());
            const e = Math.floor(Math.random() * innocents.length);
            const p = innocents[e];
            if(!p) break;

            var role = Role.INNOCENT;

            if(r == Role.SEER && roleCount[Role.SEER] < seerCount) {
                role = Role.SEER;
            } else if(r == Role.WITCH && roleCount[Role.WITCH] < witchCount) {
                role = Role.WITCH;
            } else if(r == Role.HUNTER && roleCount[Role.HUNTER] < hunterCount) {
                role = Role.HUNTER;
            } else if(r == Role.KNIGHT && b > knightThreshold && roleCount[Role.KNIGHT] < knightCount) {
                role = Role.KNIGHT;
            } else if(r == Role.WEREWOLVES && roleCount[Role.WEREWOLVES] < werewolvesCount) {
                role = Role.WEREWOLVES;
            } else {
                continue;
            }

            roleCount[role]++;
            p.role = role;
            counter++;
        }
    }

    public getAliveCount() {
        var count = 0;
        this.players.forEach(p => {
            if(p.alive) count++;
        });
        return count;
    }

    private getWerewolvesMessage(): any {
        var options = this.players.flatMap(m => {
            const name = (m.member.nickname ?? m.member.user.username) + "#" + m.member.user.discriminator;
            return m.alive ? [
                {
                    label: name,
                    value: "player_" + m.number
                }
            ] : [];
        });
        console.log(options);

        if(options.length == 0) {
            options = [
                {
                    label: "大家都死掉了",
                    value: "everyone_dead"
                }
            ];
        }

        return {
            embeds: [
                {
                    ...this.getGameEmbed(),
                    description: "天黑請閉眼，狼人請睜眼。請選擇要殺掉的對象:\n(請一個狼人選擇)"
                }
            ],
            components: [
                {
                    type: 1,
                    components: [
                        {
                            type: 3,
                            custom_id: "werewolves_kill",
                            options
                        }
                    ]
                }
            ]
        };
    }

    private getSeerMessage(): any {
        var options = this.players.flatMap(m => {
            const name = (m.member.nickname ?? m.member.user.username) + "#" + m.member.user.discriminator;
            return m.alive ? [
                {
                    label: name,
                    value: "player_" + m.number
                }
            ] : [];
        });

        if(options.length == 0) {
            options = [
                {
                    label: "大家都死掉了",
                    value: "everyone_dead"
                }
            ];
        }

        return {
            embeds: [
                {
                    ...this.getGameEmbed(),
                    description: "狼人請閉眼，預言家請睜眼。請選擇要查驗的對象:\n(請一個預言家選擇)"
                }
            ],
            components: [
                {
                    type: 1,
                    components: [
                        {
                            type: 3,
                            custom_id: "seer_inspect",
                            options
                        }
                    ]
                }
            ]
        };
    }

    private getKnightMessage(): any {
        var options = this.players.flatMap(m => {
            const name = (m.member.nickname ?? m.member.user.username) + "#" + m.member.user.discriminator;
            return m.alive ? [
                {
                    label: name,
                    value: "player_" + m.number
                }
            ] : [];
        });

        if(options.length == 0) {
            options = [
                {
                    label: "大家都死掉了",
                    value: "everyone_dead"
                }
            ];
        }

        return {
            embeds: [
                {
                    ...this.getGameEmbed(),
                    description: "騎士選擇發動技能，請選擇對象:"
                }
            ],
            components: [
                {
                    type: 1,
                    components: [
                        {
                            type: 3,
                            custom_id: "knight_inspect",
                            options
                        }
                    ]
                }
            ]
        };
    }

    private getWitchMessageA(prefix: string): any {
        return {
            embeds: [
                {
                    ...this.getGameEmbed(),
                    description: prefix + "女巫請睜眼。請選擇要投毒還是解藥:\n(請一個女巫選擇)"
                }
            ],
            components: [
                {
                    type: 1,
                    components: [
                        {
                            type: 2,
                            style: 2,
                            custom_id: "witch_kill",
                            label: "投毒"
                        },
                        {
                            type: 2,
                            style: 2,
                            custom_id: "witch_save",
                            label: "解藥"
                        },
                        {
                            type: 2,
                            style: 2,
                            custom_id: "witch_skip",
                            label: "跳過"
                        },
                        {
                            type: 2,
                            style: 1,
                            custom_id: "witch_inspect",
                            label: "死亡筆記本"
                        }
                    ]
                }
            ]
        };
    }

    private getWitchMessageB(type: "投毒" | "解藥"): any {
        var options = this.players.flatMap(m => {
            const name = (m.member.nickname ?? m.member.user.username) + "#" + m.member.user.discriminator;
            return m.alive ? [
                {
                    label: name,
                    value: "player_" + m.number
                }
            ] : [];
        });

        if(options.length == 0) {
            options = [
                {
                    label: "大家都死掉了",
                    value: "everyone_dead"
                }
            ];
        }

        return {
            embeds: [
                {
                    ...this.getGameEmbed(),
                    description: `你選擇${type}。請選擇對象:\n(請一個女巫選擇)`
                }
            ],
            components: [
                {
                    type: 1,
                    components: [
                        {
                            type: 3,
                            custom_id: "witch_obj",
                            options
                        }
                    ]
                }
            ]
        };
    }

    private getHunterComponents(): any {
        var options = this.players.flatMap(m => {
            const name = (m.member.nickname ?? m.member.user.username) + "#" + m.member.user.discriminator;
            return m.alive ? [
                {
                    label: name,
                    value: "player_" + m.number
                }
            ] : [];
        });

        if(options.length == 0) {
            options = [
                {
                    label: "大家都死掉了",
                    value: "everyone_dead"
                }
            ];
        }

        return [
            {
                type: 1,
                components: [
                    {
                        type: 3,
                        custom_id: "hunter_target",
                        options
                    }
                ]
            }
        ];
    }

    private getDiscussComponents(voteEnabled = false): any {
        return [
            {
                type: 1,
                components: [
                    {
                        type: 2,
                        custom_id: "discuss_vote",
                        style: 2,
                        label: "開始投票",
                        disabled: !voteEnabled
                    },
                    {
                        type: 2,
                        custom_id: "discuss_knight",
                        style: 1,
                        label: "騎士發動技能",
                        disabled: this.getKnights().filter(p => p.alive).length == 0
                    }
                ]
            }
        ]
    }

    private getVoteMessage(appendEmbeds: any[] = []): any {
        return {
            embeds: [
                ...appendEmbeds,
                {
                    ...this.getVoteEmbed(),
                    description: this.voteQuote
                }
            ],
            components: this.getVoteComponents()
        };
    }

    private getVoteComponents(): any {
        var options = this.votes.flatMap((m, i) => {
            const name = (m.member.nickname ?? m.member.user.username) + "#" + m.member.user.discriminator;
            return this.voteLimit >= i + 1 && m.alive ? [
                {
                    label: name,
                    value: "vote_" + i
                }
            ] : [];
        });

        if(options.length == 0) {
            options = [
                {
                    label: "大家都死掉了",
                    value: "everyone_dead"
                }
            ];
        }

        return [
            {
                type: 1,
                components: [
                    {
                        type: 3,
                        custom_id: "vote",
                        options
                    }
                ]
            }
        ]
    }

    private getEmbedBase(): any {
        const base = this.bot.getEmbedBase();

        const guild = this.bot.api.guilds.cache.get(this.guildId)!!;
        const member = guild.members.cache.get(this.bot.api.user?.id!!);

        const dayStr = this.daysCount >= 0 ? `第 ${this.daysCount} 天` : (member?.nickname ?? this.bot.api.user?.username);

        return {
            ...base,
            author: {
                ...base.author,
                name: dayStr
            }
        };
    }

    private getLobbyEmbed(): any {
        var players = this.players.map((m: WPlayer, i: number) => {
            return `${i+1}. <@${m.member.id}>`;
        }).join("\n");

        if(players == "") {
            players = "<空>";
        }

        return {
            ...this.getEmbedBase(),
            fields: [
                {
                    name: "目前玩家",
                    value: players,
                    inline: true
                },
                {
                    name: "人數",
                    value: `${this.players.length} / ${this.config.getMaxPlayers()}\n達到 ${this.config.getMinPlayers()} 人可開始`,
                    inline: true
                }
            ]
        };
    }

    private getLobbyComponents(): any {
        return [
            {
                type: 1,
                components: [
                    {
                        type: 2,
                        custom_id: "game_join",
                        style: 2,
                        label: "加入"
                    },
                    {
                        type: 2,
                        custom_id: "game_leave",
                        style: 2,
                        label: "離開"
                    },
                    {
                        type: 2,
                        custom_id: "game_start",
                        style: 2,
                        label: "開始遊戲",
                        disabled: this.players.length < this.config.getMinPlayers()
                    }
                ]
            }
        ];
    }

    private getLobbyMessage(): any {
        return {
            embeds: [
                this.getLobbyEmbed()
            ],
            components: this.getLobbyComponents()
        };
    }

    private getGameEmbed(): any {
        var players = this.players.map((m: WPlayer, i: number) => {
            const f = m.alive ? "" : "~~";
            return `${i+1}. ${f}<@${m.member.id}>${f}${!m.alive ? " (死亡)" : ""}`;
        }).join("\n");

        if(players == "") {
            players = "<空>";
        }

        const count = this.getAliveCount();

        return {
            ...this.getEmbedBase(),
            fields: [
                {
                    name: "目前玩家",
                    value: players,
                    inline: true
                },
                {
                    name: "存活人數",
                    value: `${count} / ${this.players.length}`,
                    inline: true
                }
            ]
        };
    }

    private getEndGameEmbed(): any {
        var players = this.players.map((m: WPlayer, i: number) => {
            const f = m.alive ? "" : "~~";
            return `${i+1}. ${f}${Role.getName(m.role)}: <@${m.member.id}>${f}${!m.alive ? " (死亡)" : ""}`;
        }).join("\n");

        if(players == "") {
            players = "<空>";
        }

        const count = this.getAliveCount();

        return {
            ...this.getEmbedBase(),
            fields: [
                {
                    name: "目前玩家",
                    value: players,
                    inline: true
                },
                {
                    name: "存活人數",
                    value: `${count} / ${this.players.length}`,
                    inline: true
                }
            ]
        };
    }

    private getVoteEmbed(): any {
        var players = this.votes.map((m: WPlayer, i: number) => {
            const f = m.alive ? "" : "~~";
            return `${i+1}. ${f}<@${m.member.id}>${f}${!m.alive ? " (死亡)" : ` (${m.votes} 票)`}`;
        }).join("\n");

        if(players == "") {
            players = "<空>";
        }

        const count = this.getAliveCount();

        return {
            ...this.getEmbedBase(),
            fields: [
                {
                    name: "投票選項",
                    value: players,
                    inline: true
                }
            ]
        };
    }

    public async startLobby(interaction: KInteractionWS | null = null) {
        this.prepareLobby();
        await this.showLobby(interaction);
    }

    public prepareLobby() {
        Logger.log("state (" + this.guildId + ") -> ready");

        Logger.info("Lobby started!");

        this.loadConfig();
    }

    public async showLobby(interaction: KInteractionWS | null = null) {
        // @ts-ignore
        const api: any = this.bot.api.api;

        if(!interaction) {
            const chn = this.config.getGameChannel();
            if(chn && chn != "") {
                const bot = this.bot.api;
                let t = bot.guilds.cache.get(this.guildId)!!.channels.cache.get(chn);
                if(t instanceof TextChannel) {
                    this.gameChannel = t;
                }
            } else {
                // Invalid
                return;
            }

            Logger.log("Send ready message to channel " + (this.gameChannel?.name ?? "<null>"));
            const r = await api.channels(this.gameChannel!!.id).messages.post({
                data: this.getLobbyMessage()
            }).catch(this.bot.failedToSendMessage("lobby-renew-game"));
            this.threadChannel = r.id;
            this.appId = null;
            this.interactionToken = null;
        } else {
            Logger.log("Send ready message by interaction respond");
            await api.interactions(interaction.id, interaction.token).callback.post({
                data: {
                    type: 4,
                    data: this.getLobbyMessage()
                }
            }).catch(this.bot.failedToSendMessage("lobby-cmd-interaction"));
            this.threadChannel = null;
            this.appId = interaction.application_id;
            this.interactionToken = interaction.token;

            const bot = this.bot.api;
            const chn = bot.guilds.cache.get(interaction.guild_id)!!.channels.cache.get(interaction.channel_id);
            if(chn instanceof TextChannel) {
                this.gameChannel = chn;
                this.config.data.gameChannel = chn.id;
                this.config.save();
            }
        }
    }

    public async startGame(ev: KInteractionWS) {
        this.inProgress = true;
        this.startTime = new Date();

        const msgId = ev.message.id;
        const api = this.bot.api;
        const chn = api.guilds.cache.get(this.guildId)!!.channels.cache.get(this.config.getGameChannel()) as PlayableChannel;
        const msg = await chn.messages.fetch(msgId);

        this.assignRoles();

        this.players.forEach(p => {
            let suffix = "";
            if(p.role == Role.WEREWOLVES) {
                suffix += "\n狼人: " + this.getWerewolves().map(p => p.member.user.tag).join("、");
            }

            p.member.send({
                embed: {
                    ...this.getEmbedBase(),
                    description: `你的身分是: **${Role.getName(p.role)}。**` + suffix
                }
            });
        });

        // @ts-ignore
        let rest: any = api.api;
        rest.interactions(ev.id, ev.token).callback.post({
            data: {
                type: 7,
                data: {
                    components: [
                        {
                            type: 1,
                            components: [
                                {
                                    type: 2,
                                    custom_id: "game_join",
                                    style: 2,
                                    label: "加入",
                                    disabled: true
                                },
                                {
                                    type: 2,
                                    custom_id: "game_leave",
                                    style: 2,
                                    label: "離開",
                                    disabled: true
                                },
                                {
                                    type: 2,
                                    custom_id: "game_start",
                                    style: 2,
                                    label: "遊戲進行中",
                                    disabled: true
                                }
                            ]
                        }
                    ]
                }
            }
        }).catch(this.bot.failedToEditMessage("lobby-patch-playing"));

        // Create a thread from the lobby message
        // @ts-ignore
        rest = api.api;
        const r = await rest.channels(this.gameChannel!!.id).messages(msgId).threads.post({
            data: {
                name: "狼人殺遊戲",
                auto_archive_duration: 60
            }
        }).catch(this.bot.failedToCreateThread("game-thread"));
        this.hasThread = true;
        
        for(var i=0; i<this.players.length; i++) {
            // @ts-ignore
            rest = api.api;
            const p = this.players[i].member.id;
            rest.channels(r.id, "thread-members", p).put().catch(this.bot.failedToAddThreadMember("game-thread-member"));
        }

        this.threadChannel = r.id;
        this.daysCount = 0;

        this.currentTimeout = setTimeout(() => {
            this.checkEndOrNext(() => {
                this.turnOfWerewolves();
            });
        }, 10000);
    }

    public async cleanGameMessages() {
        // @ts-ignore
        let api: any = this.bot.api.api;
        if(this.threadChannel != null) {
            if(this.hasThread) {
                await api.channels(this.threadChannel).delete().catch(this.bot.failedToDeleteChannel("clean-thread"));
            }

            // @ts-ignore
            api = this.bot.api.api;
            await api.channels(this.gameChannel!!.id).messages(this.threadChannel).delete().catch(this.bot.failedToDeleteMessage("clean-game-message"));

            this.threadChannel = null;
            this.appId = null;
            this.interactionToken = null;
        }

        if(this.appId != null && this.interactionToken != null) {
            // @ts-ignore
            api = this.bot.api.api;
            await api.webhooks(this.appId, this.interactionToken).messages("@original").delete();

            this.threadChannel = null;
            this.appId = null;
            this.interactionToken = null;
        }

        this.hasThread = false;
    }

    public async checkEndOrNext(next: () => void) {
        let gameMsg = "";
        const b = this.players.filter(p => p.alive).length;
        const w = this.getWerewolves().filter(p => p.alive).length;

        if(w == 0) {
            gameMsg = "遊戲結束，好人勝利。";
        } else if(b - w <= 1) {
            gameMsg = "遊戲結束，狼人勝利。";
        } else {
            next();
            return;
        }

        await this.stopGame(gameMsg);
    }

    public async stopGame(message: string) {
        if(this.currentTimeout) {
            clearTimeout(this.currentTimeout);
        }

        this.daysCount = -1;

        const data = {
            data: {
                embeds: [
                    {
                        ...this.getEndGameEmbed(),
                        description: message
                    }
                ],
                components: []
            }
        };
        // @ts-ignore
        let api: any = this.bot.api.api;
        api.channels(this.threadChannel!!).messages.post(data).catch(this.bot.failedToSendMessage("end-game-in-thread"));
        
        const dateStr = new Date().toISOString().replace(/(?=.*?)T/, " ").replace(/(?=.*?)\..*/, "").replace(/:/g, "-");
        // @ts-ignore
        api = this.bot.api.api;
        api.channels(this.threadChannel!!).patch({
            data: {
                name: "狼人殺遊戲紀錄：" + dateStr,
                archived: true,
                locked: true
            }
        })
        
        // @ts-ignore
        api = this.bot.api.api;
        api.channels(this.gameChannel!!.id).messages(this.threadChannel!!).patch(data).catch(this.bot.failedToSendMessage("end-game-in-history"));
        this.threadChannel = null;
        this.inProgress = false;
        this.players = [];
        this.state = GameState.READY;

        // Users likely don't expect the bot to start again automatically,
        // so we don't do that from now
    }

    // -- Dump --
    public dumpPlayers(): any[] {
        return this.players.map(v => {
            return {
                ...v,
                member: v.member.user?.tag,
                role: Role.getName(v.role)
            };
        });
    }
}