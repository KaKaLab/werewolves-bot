import { Client, Guild, GuildChannel, GuildMember, TextChannel, KInteractionWS } from "discord.js";
import { WerewolvesBot } from "../bot";
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
    HUNGER,
    KNIGHT,
    VOTE,
    ENDED
}

type PlayableChannel = TextChannel;

export class WPlayer {
    public member: GuildMember;
    public number: number;
    public alive: boolean = true; 
    public role: Role = Role.INNOCENT;

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
    public state: GameState = GameState.READY;
    private bot: WerewolvesBot;

    private gameChannel: PlayableChannel | null = null;
    private threadChannel: string | null = null;
    private hasThread = false;

    private static readonly MIN_PLAYERS = 3;

    private wolvesKilled = -1;
    private witchTarget = -1;
    private votedDown = -1;
    private witchAction: string | null = null;

    private witchRemainSkills = {
        kill: 1,
        save: 1
    };

    private witchAMsgId: string | null = null;

    constructor(bot: WerewolvesBot) {
        this.bot = bot;

        const api = bot.api;
        const chn = api.guilds.cache.get(WerewolvesBot.GUILD_ID)!!.channels.cache.get(this.bot.config.getGameChannel());
        if(chn instanceof TextChannel) {
            this.gameChannel = chn;
        }
    }

    public async init() {
        this.bot.api.on("interactionCreate", async (ev) => {
            if(this.state == GameState.READY) {
                Logger.info("interaction -> state: ready");
                await this.handleLobbyInteraction(ev);
                return;
            }

            if(this.state == GameState.WEREWOLVES) {
                Logger.info("interaction -> state: werewolves");
                await this.handleWerewolvesInteraction(ev);
                return;
            }

            if(this.state == GameState.SEER) {
                Logger.info("interaction -> state: seer");
                await this.handleSeerInteraction(ev);
                return;
            }

            if(this.state == GameState.WITCH) {
                if(ev.message.id == this.witchAMsgId) {
                    Logger.info("interaction -> state: witch_a");
                    await this.handleWitchInteractionA(ev);
                } else {
                    Logger.info("interaction -> state: witch_b");
                    await this.handleWitchInteractionB(ev);
                }
                return;
            }

            Logger.warn("unhandled, state == " + this.state);
        });
    }

    private async handleLobbyInteraction(ev: KInteractionWS) {
        const userId = ev.member.user.id;
        const guild = this.bot.api.guilds.cache.get(WerewolvesBot.GUILD_ID)!!;
        const member = await guild.members.fetch(userId);

        switch(ev.data.custom_id) {
            case "game_join":
                if(!this.players.find(m => m.member.id == userId)) {
                    const p = new WPlayer(this.players.length + 1, member);
                    this.players.push(p);
                }
                break;
            case "game_leave":
                const index = this.players.findIndex(m => m.member.id == userId);
                if(index != -1) {
                    this.players.splice(index, 1);
                }
                break;
            case "game_start":
                const msgId = ev.message.id;
                const api = this.bot.api;
                const chn = api.guilds.cache.get(WerewolvesBot.GUILD_ID)!!.channels.cache.get(this.bot.config.getGameChannel()) as PlayableChannel;
                const msg = await chn.messages.fetch(msgId);
                this.state = GameState.WEREWOLVES;
                Logger.info("state -> werewolves");

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
                    p.member.send(`你的身分是: **${Role.getName(p.role)}。**`);
                })

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
                    await rest.channels(r.id, "thread-members", p).put();
                }

                this.threadChannel = r.id;
                this.turnOfWerewolves();
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

    private async handleWerewolvesInteraction(ev: KInteractionWS) {
        if(ev.data.custom_id != "werewolves_kill") return;

        const userId = ev.member.user.id;
        const guild = this.bot.api.guilds.cache.get(WerewolvesBot.GUILD_ID)!!;
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
        const guild = this.bot.api.guilds.cache.get(WerewolvesBot.GUILD_ID)!!;
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
        const guild = this.bot.api.guilds.cache.get(WerewolvesBot.GUILD_ID)!!;
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

            this.turnOfPriorPriest("女巫請閉眼。");
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

            this.turnOfWitchB();
        }
    }

    private async handleWitchInteractionB(ev: KInteractionWS) {
        if(!ev.data.custom_id.startsWith("witch_")) return;

        const userId = ev.member.user.id;
        const guild = this.bot.api.guilds.cache.get(WerewolvesBot.GUILD_ID)!!;
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

        this.turnOfPriorPriest("女巫請閉眼。");
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
        // @ts-ignore
        const rest: any = this.bot.api.api;
        await rest.channels(this.threadChannel!!).messages.post({
            data: this.getWerewolvesMessage()
        });
    }

    private async turnOfSeer() {
        if(this.getSeers().find(p => p.alive)) {
            this.state = GameState.SEER;
            Logger.info("state -> seer");

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
        if(this.getWitches().find(p => p.alive)) {
            // @ts-ignore
            const api: any = this.bot.api.api;
            const prefix = this.state == GameState.WEREWOLVES ? "狼人請閉眼，" : "預言家請閉眼，";

            this.state = GameState.WITCH;
            Logger.info("state -> witch");

            const r = await api.channels(this.threadChannel!!).messages.post({
                data: this.getWitchMessageA(prefix)
            });
            this.witchAMsgId = r.id;
            Logger.info("WitchA msg id -> " + this.witchAMsgId);
        } else {
            this.turnOfPriorPriest(GameState.WEREWOLVES ? "狼人請閉眼。" : "預言家請閉眼。");
        }
    }

    private async turnOfWitchB() {
        // ?
    }

    private async turnOfPriorPriest(prefix: string) {
        this.state = GameState.VOTE;
        Logger.info("state -> vote");

        // @ts-ignore
        const api: any = this.bot.api.api;

        const wolvesKilled = this.players.find(p => p.number == this.wolvesKilled);
        const witchTarget = this.players.find(p => p.number == this.witchTarget);

        let saved = true;
        if(!(this.witchAction == "save" && this.witchTarget == this.wolvesKilled)) {
            const killed = wolvesKilled;
            killed?.kill();
            saved = false;
        }

        const quote = saved ?
            `${prefix}天亮了。昨晚是平安夜。` :
            (this.witchAction == "kill" && this.witchTarget == this.wolvesKilled ?
                `${prefix}天亮了。昨晚死亡的是 <@${wolvesKilled?.member.id}>、<@${witchTarget?.member.id}>。` :
                `${prefix}天亮了。昨晚死亡的是 <@${wolvesKilled?.member.id}>。`);

        api.channels(this.threadChannel!!).messages.post({
            data: {
                embeds: [
                    {
                        ...this.getGameEmbed(),
                        description: quote
                    }
                ]
            }
        });
    }

    public assignRoles() {
        const roleCount = [];
        for(var i=0; i<Role.COUNT; i++) {
            roleCount.push(0);
        }

        const b = this.players.length;
        var mod = (b + 1) % 3;
        var priestCount = ((b + 1) / 9) | 0;
        var counter = 0;
        
        while (counter < b) {
            const r = Math.floor((Role.COUNT - 1) * Math.random());
            const e = Math.floor(Math.random() * b);
            const p = this.players[e];
            var role = Role.INNOCENT;

            if(p.role != Role.INNOCENT) continue;

            if(r == Role.SEER && roleCount[Role.SEER] < Math.max(priestCount + (mod >= 1 ? 1 : 0), 1)) {
                role = Role.SEER;
            } else if(r == Role.WITCH && roleCount[Role.WITCH] < Math.max(priestCount + (mod >= 2 ? 1 : 0), 1)) {
                role = Role.WITCH;
            } else if(false && r == Role.HUNTER && roleCount[Role.HUNTER] < Math.max(priestCount, 1)) {
                role = Role.HUNTER;
            } else if(false && r == Role.KNIGHT && b > 6 && roleCount[Role.KNIGHT] < 1) {
                role = Role.KNIGHT;
            } else if(r == Role.WEREWOLVES && roleCount[Role.WEREWOLVES] < ((b / 3) | 0)) {
                role = Role.WEREWOLVES;
            } else if(false && r == Role.INNOCENT && roleCount[Role.INNOCENT] < ((b / 3) | 0)) {
                role = Role.INNOCENT;
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

    private getEmbedBase(): any {
        return {
            color: 0xffa970,
            author: {
                name: this.bot.api.user?.username,
                icon_url: this.bot.api.user?.avatarURL()
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
                    value: `${this.players.length} / ${Werewolves.MIN_PLAYERS}`,
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
                        disabled: this.players.length < Werewolves.MIN_PLAYERS
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

    public async startLobby() {
        Logger.info("Lobby started!");
        Logger.info("Send ready message to channel " + (this.gameChannel?.name ?? "<null>"));

        // @ts-ignore
        const api: any = this.bot.api.api;
        const r = await api.channels(this.gameChannel!!.id).messages.post({
            data: this.getLobbyMessage()
        });
        this.threadChannel = r.id;
    }

    public startGame() {

    }

    public async stopGame() {
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
        }
    }
}