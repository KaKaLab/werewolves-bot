import { Client, Guild, GuildChannel, GuildMember, TextChannel, KInteractionWS } from "discord.js";
import { WerewolvesBot } from "../bot";
import { BotGuildConfig } from "../guildConfig";
import { Logger } from "../utils/logger";

export enum Role {
    SEER,
    WITCH,
    HUNTER,
    KNIGHT,
    WEREWOLVES,
    INNOCENT
}

export namespace Role {
    export function getName(role: Role) {
        return {
            0: "預言家",
            1: "女巫",
            2: "獵人",
            3: "騎士",
            4: "狼人",
            5: "平民"
        }[role] ?? "未知";
    }

    export const COUNT = 6;
}

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
    private players: WPlayer[] = []
    private votes: WPlayer[] = []
    public state: GameState = GameState.READY;
    private bot: WerewolvesBot;

    public guildId: string;
    private config: BotGuildConfig;

    private gameChannel: PlayableChannel | null = null;

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
    private discussMsgId = null;
    private voteMsgId = null;

    private hunterNext = () => {};

    private currentTimeout: NodeJS.Timeout | null = null;

    private daysCount = -1;

    private readonly debugVoteOnly = false;
    private readonly debugShortTime = true;

    public inProgress = false;

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

    public async init() {
        this.bot.api.on("interactionCreate", async (ev) => {
            if(ev.guild_id != this.guildId) return;
            if(ev.type != 3) return;

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
            });
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

                const msgId = ev.message.id;
                const api = this.bot.api;
                const chn = api.guilds.cache.get(this.guildId)!!.channels.cache.get(this.config.getGameChannel()) as PlayableChannel;
                const msg = await chn.messages.fetch(msgId);

                this.assignRoles();

                console.log(this.players.map(p => {
                    return {
                        number: p.number,
                        alive: p.alive,
                        tag: p.member.user.username + "#" + p.member.user.discriminator,
                        role: Role.getName(p.role)
                    };
                }));

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
                });

                // Create a thread from the lobby message
                // @ts-ignore
                rest = api.api;
                const r = await rest.channels(this.gameChannel!!.id).messages(msgId).threads.post({
                    data: {
                        name: "狼人殺遊戲",
                        auto_archive_duration: 60
                    }
                });
                this.hasThread = true;
                
                for(var i=0; i<this.players.length; i++) {
                    // @ts-ignore
                    rest = api.api;
                    const p = this.players[i].member.id;
                    rest.channels(r.id, "thread-members", p).put();
                }

                this.threadChannel = r.id;
                this.daysCount = 0;

                this.currentTimeout = setTimeout(() => {
                    if(this.debugVoteOnly) {
                        this.voteLimit = this.players.length;
                        this.votes = [];
                        Array.prototype.push.apply(this.votes, this.players);
                        this.turnOfVote();
                    } else {
                        this.turnOfWerewolves();
                    }
                }, 10000);

                this.inProgress = true;

                break;
        }

        // @ts-ignore
        const api: any = this.bot.api.api;
        api.interactions(ev.id, ev.token).callback.post({
            data: {
                type: 7,
                data: this.getLobbyMessage()
            }
        });

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
            });
            return;
        }
        if(!player.alive) {
            rest.interactions(ev.id, ev.token).callback.post({
                data: {
                    type: 4,
                    data: this.getPlayerDeadInvalidMessage()
                }
            });
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
        });

        // @ts-ignore
        rest = this.bot.api.api;
        await rest.channels(this.threadChannel!!).messages(ev.message.id).delete();

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
            });
            return;
        }
        if(!player.alive) {
            rest.interactions(ev.id, ev.token).callback.post({
                data: {
                    type: 4,
                    data: this.getPlayerDeadInvalidMessage()
                }
            });
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
        });

        // @ts-ignore
        rest = this.bot.api.api;
        await rest.channels(this.threadChannel!!).messages(ev.message.id).delete();

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
            });
            return;
        }
        if(!player.alive) {
            rest.interactions(ev.id, ev.token).callback.post({
                data: {
                    type: 4,
                    data: this.getPlayerDeadInvalidMessage()
                }
            });
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
            });

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
            });

            // @ts-ignore
            rest = this.bot.api.api;
            await rest.channels(this.threadChannel!!).messages(this.witchAMsgId).delete();

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
                });
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
            });
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
            });
            return;
        }
        if(!player.alive) {
            rest.interactions(ev.id, ev.token).callback.post({
                data: {
                    type: 4,
                    data: this.getPlayerDeadInvalidMessage()
                }
            });
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
                    embed: [
                        {
                            ...this.getEmbedBase(),
                            description: `你選擇對 <@${p.member.id}> ${type}。`
                        }
                    ]
                }
            }
        });

        // @ts-ignore
        rest = this.bot.api.api;
        await rest.channels(this.threadChannel!!).messages(this.witchAMsgId).delete();

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
            });
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
            });
            return;
        }

        // @ts-ignore
        var rest: any = this.bot.api.api;
        const key = ev.data.custom_id.substring(8);
        
        switch(key) {
            case "vote":
                rest.channels(this.threadChannel!!).messages(ev.message.id).delete();
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
                    });
                    return;
                }

                rest.channels(this.threadChannel!!).messages(ev.message.id).delete();
                
                // @ts-ignore
                rest = this.bot.api.api;
                rest.interactions(ev.id, ev.token).callback.post({
                    data: {
                        type: 4,
                        data: this.getKnightMessage()
                    }
                });

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
            });
            return;
        }
        if(!player.alive) {
            rest.interactions(ev.id, ev.token).callback.post({
                data: {
                    type: 4,
                    data: this.getPlayerDeadInvalidMessage()
                }
            });
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
        });

        // @ts-ignore
        rest = this.bot.api.api;
        rest.channels(this.threadChannel!!).messages(ev.message.id).delete();

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
            });
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
        });

        // @ts-ignore
        rest = this.bot.api.api;
        await rest.channels(this.threadChannel!!).messages(ev.message.id).delete();

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
            });
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
            });
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
        });
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
        });
    }

    private async turnOfSeer() {
        if(this.getSeers().find(p => p.alive)) {
            this.state = GameState.SEER;
            Logger.log("state (" + this.guildId + ") -> seer");

            // @ts-ignore
            const api: any = this.bot.api.api;
            api.channels(this.threadChannel!!).messages.post({
                data: this.getSeerMessage()
            });
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
            });
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
            });
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

        const discussTime = this.debugShortTime ? 15 : 120;

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
        });

        this.currentTimeout = setTimeout(() => {
            // @ts-ignore
            const api: any = this.bot.api.api;
            api.channels(this.threadChannel!!).messages(r.id).patch({
                data: {
                    components: this.getDiscussComponents(true)
                }
            });
        }, discussTime * 1000);
    }

    private async turnOfVote(appendEmbeds: any[] = []) {
        this.state = GameState.VOTE;
        Logger.log("state (" + this.guildId + ") -> vote");

        // @ts-ignore
        const api: any = this.bot.api.api;

        const voteTime = this.debugShortTime ? 10 : 30;
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
        });
        this.voteMsgId = r.id;

        this.currentTimeout = setTimeout(() => {
            this.endOfVote();
        }, voteTime * 1000);
    }

    private async endOfVote() {
        // @ts-ignore
        let api: any = this.bot.api.api;
        Logger.log("endOfVote() called");

        await api.channels(this.threadChannel!!).messages(this.voteMsgId).delete();

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
            });
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
        });
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

        const seerCount = 1;
        const witchCount = 1;
        const hunterCount = 1;
        const werewolvesCount = ((b / 3) | 0);

        let maxRole = seerCount;
        maxRole += witchCount;
        maxRole += hunterCount;
        maxRole += werewolvesCount;
        if(b > 6) maxRole++;

        var failSafe = 0;

        var failSafeCall = () => {
            failSafe++;
            if(failSafe >= 400) {
                console.log("b:", b);
                console.log("maxRole:", maxRole);
                console.log("roleCount:", roleCount);
                return false;
            }
            return true;
        }
        
        while (counter < b) {
            const r = Math.floor(Role.COUNT * Math.random());
            const e = Math.floor(Math.random() * b);
            const p = this.players[e];
            var role = Role.INNOCENT;

            if(p.role != Role.INNOCENT) {
                if(!failSafeCall()) {
                    break;   
                }
                continue;
            }

            if(r == Role.SEER && roleCount[Role.SEER] < seerCount) {
                role = Role.SEER;
            } else if(r == Role.WITCH && roleCount[Role.WITCH] < witchCount) {
                role = Role.WITCH;
            } else if(r == Role.HUNTER && roleCount[Role.HUNTER] < hunterCount) {
                role = Role.HUNTER;
            } else if(r == Role.KNIGHT && b > 6 && roleCount[Role.KNIGHT] < 1) {
                role = Role.KNIGHT;
            } else if(r == Role.WEREWOLVES && roleCount[Role.WEREWOLVES] < werewolvesCount) {
                role = Role.WEREWOLVES;
            } else if(r == Role.INNOCENT && roleCount[Role.INNOCENT] < b - maxRole) {
                role = Role.INNOCENT;
            } else {
                if(!failSafeCall()) {
                    break;   
                }
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
        this.state = GameState.READY;
        Logger.log("state (" + this.guildId + ") -> ready");

        Logger.info("Lobby started!");

        this.players = [];
    }

    public async showLobby(interaction: KInteractionWS | null = null) {
        // @ts-ignore
        const api: any = this.bot.api.api;

        if(!interaction) {
            Logger.log("Send ready message to channel " + (this.gameChannel?.name ?? "<null>"));
            const r = await api.channels(this.gameChannel!!.id).messages.post({
                data: this.getLobbyMessage()
            });
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
            });
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

    public startGame() {

    }

    public async cleanGameMessages() {
        // @ts-ignore
        let api: any = this.bot.api.api;
        if(this.threadChannel != null) {
            if(this.hasThread) {
                await api.channels(this.threadChannel).delete();
            }

            // @ts-ignore
            api = this.bot.api.api;
            await api.channels(this.gameChannel!!.id).messages(this.threadChannel).delete();

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
        this.inProgress = false;
    }

    public async checkEndOrNext(next: () => void) {
        Logger.log("checkEndOrNext() called");

        let gameMsg = "";
        const b = this.players.filter(p => p.alive).length;
        const w = this.getWerewolves().filter(p => p.alive).length;

        if(w == 0) {
            gameMsg = "遊戲結束，好人勝利。";
        } else if(b - w <= 1) {
            gameMsg = "遊戲結束，狼人勝利。";
        } else {
            Logger.log("Game is not ended, continue...");
            next();
            return;
        }

        this.daysCount = -1;
        // @ts-ignore
        let api: any = this.bot.api.api;

        const data = {
            data: {
                embeds: [
                    {
                        ...this.getEndGameEmbed(),
                        description: gameMsg
                    }
                ]
            }
        };
        api.channels(this.threadChannel!!).messages.post(data);
        api.channels(this.gameChannel!!.id).messages(this.threadChannel!!).patch(data);
        this.threadChannel = null;

        this.startLobby();
    }
}