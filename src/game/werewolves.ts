import { Client, Guild, GuildChannel, GuildMember, TextChannel, KInteractionWS } from "discord.js";
import { WerewolvesBot } from "../bot";
import { BotGuildConfig } from "../guildConfig";
import { AsyncStorage } from "../utils/asyncStorage";
import { Logger } from "../utils/logger";
import { PromiseTimer } from "../utils/timeprom";
import { Player } from "./player";
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

export class Werewolves {
    public players: Player[] = []
    private votes: Player[] = []
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
    private witchAction: string | null = null;
    private voteLimit = -1;

    private voteQuote = "";
    private voteMsgId = null;

    private currentTimeout: NodeJS.Timeout | null = null;

    private daysCount = -1;

    private cancelled = false;
    public inProgress = false;
    public startTime = new Date();

    private isVoting = false;

    public get isBeta() {
        return this.config.isBetaEnabled();
    }

    private get debugVoteOnly() {
        return this.config.isDebugVoteOnly();
    }

    private witchRemainSkills = {
        kill: 1,
        save: 1
    };

    private witchAMsgId: string | null = null;

    private interactionStorage: AsyncStorage<KInteractionWS> = new AsyncStorage();

    constructor(bot: WerewolvesBot, guild: string) {
        this.bot = bot;
        this.guildId = guild;
        this.config = new BotGuildConfig(guild);
    }

    public loadConfig() {
        this.config.load();
    }

    /**
     * Setups event listeners to handle interactions sent from Discord.
     */
    public async init() {
        this.bot.api.on("interactionCreate", async (ev) => {
            if(this.bot.isBlacklisted(ev.member.user.id)) return;
            if(ev.guild_id != this.guildId) return;
            if(ev.type != 3) return;

            if(this.isVoting) {
                await this.handleVoteInteraction(ev);
            }

            this.interactionStorage.store(ev);

            Logger.log(`Interaction issuer: ${ev.member.user.username}#${ev.member.user.discriminator} (in guild ${ev.guild_id})`);

            if(this.state == GameState.READY) {
                Logger.log(`interaction (${this.guildId}) -> state: ready`);
                await this.handleLobbyInteraction(ev);
                return;
            }
        });
    }

    private get rest(): any {
        // @ts-ignore
        return this.bot.api.api;
    }

    public isMemberInGame(id: string) {
        return !!this.players.find(p => p.member.id == id);
    }

    public getWerewolves(): Player[] {
        return this.players.filter((p: Player) => {
            return p.role == Role.WEREWOLVES;
        });
    }

    public getSeers(): Player[] {
        return this.players.filter((p: Player) => {
            return p.role == Role.SEER;
        });
    }

    public getWitches(): Player[] {
        return this.players.filter((p: Player) => {
            return p.role == Role.WITCH;
        });
    }

    public getKnights(): Player[] {
        return this.players.filter((p: Player) => {
            return p.role == Role.KNIGHT;
        });
    }

    public getHunters(): Player[] {
        return this.players.filter((p: Player) => {
            return p.role == Role.HUNTER;
        });
    }

    public getCouples(): Player[] {
        return this.players.filter((p: Player) => {
            return !!p.couple;
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

    public getPlayerFromInteraction(interaction: KInteractionWS) {
        const userId = interaction.member.user.id;
        if(!this.isMemberInGame(userId)) return null;

        return this.players.find(p => {
            return p.member.id == userId
        });
    }

    private async waitNextPlayerInteraction(aliveOnly = true): Promise<KInteractionWS> {
        const val = await this.interactionStorage.waitNextConditionMeet(ev => {
            if(!ev) return false;
            const player = this.getPlayerFromInteraction(ev);
            if(!player) return false;
            return (aliveOnly ? player.alive : true);
        }, async ev => {
            if(ev) {
                const player = this.getPlayerFromInteraction(ev);
                if(player) {
                    if(!player.alive) {
                        await this.sendPlayerDeadInteraction(ev);
                        return;
                    }
                } else {
                    await this.sendMemberNotPlayerInteraction(ev);
                }
            }
        });
        return val!!;
    }

    private async waitNextRoleInteraction(role: Role, aliveOnly = true): Promise<KInteractionWS> {
        const val = await this.interactionStorage.waitNextConditionMeet(ev => {
            if(!ev) return false;
            const player = this.getPlayerFromInteraction(ev);
            if(!player) return false;
            return player.role == role && (aliveOnly ? player.alive : true);
        }, async ev => {
            if(ev) {
                const player = this.getPlayerFromInteraction(ev);
                if(player) {
                    if(player.role != role) {
                        await this.sendPlayerRoleMismatchInteraction(ev, role);
                    } else if(!player.alive) {
                        await this.sendPlayerDeadInteraction(ev);
                        return;
                    }
                } else {
                    await this.sendMemberNotPlayerInteraction(ev);
                }
            }
        });
        return val!!;
    }

    public isGameEnded() {
        if(this.debugVoteOnly) return false;

        const b = this.players.filter(p => p.alive).length;
        const w = this.getWerewolves().filter(p => p.alive).length;

        if(w == 0) {
            return true;
        } else if(b - w <= 1) {
            return true;
        } else {
            return false;
        }
    }

    private async runGameLoop() {
        let ended = this.isGameEnded();
        this.daysCount = -1;

        while(!ended) {
            this.daysCount++;

            await this.turnOfWerewolves();
            if(this.cancelled) return;

            await this.turnOfSeer();
            if(this.cancelled) return;

            const daylightPrefix = await this.turnOfWitch();
            if(this.cancelled) return;

            const quote = await this.turnOfDaylight(daylightPrefix);
            if(this.cancelled) return;

            this.turnOfHunter(quote);
            if(this.cancelled) return;

            if(this.isGameEnded()) break;

            const hasKnight = await this.turnOfDiscuss(quote);
            if(this.cancelled) return;

            if(hasKnight) {
                await this.turnOfKnight();
                if(this.cancelled) return;

                continue;
            } else {
                this.isVoting = true;
                await this.turnOfVote();
                if(this.cancelled) return;

                await PromiseTimer.waitUntil(() => {
                    if(this.cancelled) return true;
                    return this.isVoting == false;
                });
                if(this.cancelled) return;

                this.turnOfHunter(quote);
                if(this.cancelled) return;

                if(this.isGameEnded()) break;
            }
        }

        let gameMsg = "";
        const b = this.players.filter(p => p.alive).length;
        const w = this.getWerewolves().filter(p => p.alive).length;

        if(w == 0) {
            gameMsg = "遊戲結束，好人勝利。";
        } else if(b - w <= 1) {
            gameMsg = "遊戲結束，狼人勝利。";
        }

        if(this.cancelled) return;
        await this.stopGame(gameMsg);
    }

    private async turnOfWerewolves() {
        if(this.debugVoteOnly) return;

        this.state = GameState.WEREWOLVES;
        Logger.log("state (" + this.guildId + ") -> werewolves");

        let cancelled = false;
        let handler = () => {
            cancelled = true;
        };
        this.interactionStorage.on("cancelled", handler);

        this.bot.sendMessage(this.threadChannel!!, this.getWerewolvesMessage(), "werewolves-action");
        while(true) {
            const ev = await this.waitNextRoleInteraction(Role.WEREWOLVES);
            if(cancelled || !ev) {
                this.interactionStorage.off("cancelled", handler);
                return;
            }

            if(ev.data.custom_id != "werewolves_kill") continue;

            const opt: string = ev.data.values[0];
            if(!opt.startsWith("player_")) {
                continue;
            }

            this.wolvesKilled = parseInt(opt.substring(7));
            const killed = this.players.find(p => p.number == this.wolvesKilled);

            await this.bot.respondToInteraction(ev, {
                type: 4,
                data: this.bot.getCompactedMessageWithEmbed(`你殺掉了 <@${killed!!.member.id}>。`, true)
            }, "werewolves-killed");
            await this.bot.deleteMessage(this.threadChannel!!, ev.message.id, "werewolve-source");
            break;
        }
    }

    private async turnOfSeer() {
        if(this.debugVoteOnly) return;
        
        if(this.getSeers().find(p => p.alive)) {
            this.state = GameState.SEER;
            Logger.log("state (" + this.guildId + ") -> seer");

            let cancelled = false;
            let handler = () => {
                cancelled = true;
            };
            this.interactionStorage.on("cancelled", handler);

            this.bot.sendMessage(this.threadChannel!!, this.getSeerMessage(), "seer-turn");
            while(true) {
                const ev = await this.waitNextRoleInteraction(Role.SEER);
                if(cancelled || !ev) {
                    this.interactionStorage.off("cancelled", handler);
                    return;
                }
    
                if(ev.data.custom_id != "seer_inspect") {
                    Logger.warn("Not seer_inspect, but get " + ev.data.custom_id);
                    continue;
                }

                const opt: string = ev.data.values[0];
                if(!opt.startsWith("player_")) {
                    Logger.warn("Not started with player_, but get " + opt);
                    continue;
                }

                const n = parseInt(opt.substring(7));
                const p = this.players.find(p => p.number == n)!!;
                const isWolf = p.role == Role.WEREWOLVES;

                await this.bot.respondToInteraction(ev, {
                    type: 4,
                    data: this.bot.getCompactedMessageWithEmbed(`<@${p.member.id}> 是${isWolf ? "狼人" : "好人"}。`, true)
                }, "seer-inspected");
                await this.bot.deleteMessage(this.threadChannel!!, ev.message.id, "seer-source");
                break; 
            }
        }
    }

    private async turnOfWitch(): Promise<string> {
        if(this.debugVoteOnly) return "VoteOnly";
        
        this.witchTarget = -1;
        this.witchAction = null;
        if(this.getWitches().find(p => p.alive)) {
            const prefix = this.state == GameState.WEREWOLVES ? "狼人請閉眼，" : "預言家請閉眼，";
            this.state = GameState.WITCH;
            Logger.log("state (" + this.guildId + ") -> witch");

            const r = await this.bot.sendMessage(this.threadChannel!!, this.getWitchMessageA(prefix), "witch-turn-a");
            this.witchAMsgId = r.id;
            Logger.info("WitchA msg id -> " + this.witchAMsgId);

            let cancelled = false;
            let handler = () => {
                cancelled = true;
            };
            this.interactionStorage.on("cancelled", handler);

            while(true) {
                let toSkip = false;
                const ev = await this.waitNextRoleInteraction(Role.WITCH);
                if(cancelled || !ev) {
                    this.interactionStorage.off("cancelled", handler);
                    return "";
                }
    
                if(ev.message.id == this.witchAMsgId) {
                    Logger.log(`interaction (${this.guildId}) -> state: witchA`);
                    toSkip = await this.processWitchInteractionA(ev);
                } else {
                    Logger.log(`interaction (${this.guildId}) -> state: witchB`);
                    toSkip = await this.processWitchInteractionB(ev);
                }

                if(toSkip) {
                    break;
                } else {
                    continue;
                }
            }
            return "女巫請閉眼。";
        } else {
            return GameState.WEREWOLVES ? "狼人請閉眼。" : "預言家請閉眼。";
        }
    }

    private async processWitchInteractionA(ev: KInteractionWS): Promise<boolean> {
        if(!ev.data.custom_id.startsWith("witch_")) return false;

        const key = ev.data.custom_id.substring(6);
        if(key == "inspect") {
            const wolvesKilled = this.players.find(p => p.number == this.wolvesKilled);
            this.bot.respondToInteraction(ev, {
                type: 4,
                data: this.bot.getCompactedMessageWithEmbed(`本回合狼人殺了 <@${wolvesKilled?.member.id}>。`, true)
            }, "witch-inspect-killer");
            return false;
        }
        else if(key == "skip") {
            this.bot.respondToInteraction(ev, {
                type: 4,
                data: this.bot.getCompactedMessageWithEmbed("你選擇跳過本回合。", true)
            }, "witch-skip");

            await this.bot.deleteMessage(this.threadChannel!!, this.witchAMsgId!!, "witch-source");
            return true;
        } else {
            // @ts-ignore
            const remains: number = this.witchRemainSkills[key];
            if(remains <= 0) {
                this.bot.respondToInteraction(ev, {
                    type: 4,
                    data: this.bot.getCompactedMessageWithEmbed((key == "kill" ? "毒藥" : "解藥") + "已用完。", true)
                });
                return false;
            }

            // @ts-ignore
            this.witchRemainSkills[key]--;

            // @ts-ignore
            const type: "投毒" | "解藥" = {
                kill: "投毒",
                save: "解藥"
            }[key];
            this.witchAction = key;

            this.bot.respondToInteraction(ev, {
                type: 4,
                data: {
                    ...this.getWitchMessageB(type),
                    flags: 64
                }
            }, "witchB");
            return false;
        }
    }

    private async processWitchInteractionB(ev: KInteractionWS): Promise<boolean> {
        if(!ev.data.custom_id.startsWith("witch_")) return false;

        const opt: string = ev.data.values[0];
        if(!opt.startsWith("player_")) {
            Logger.warn("Not started with player_, but get " + opt);
            return false;
        }

        const n = parseInt(opt.substring(7));
        const p = this.players.find(p => p.number == n)!!;
        this.witchTarget = p.number;
        
        // @ts-ignore
        const type: "投毒" | "解藥" = {
            kill: "投毒",
            save: "解藥"
        }[this.witchAction!!];

        this.bot.respondToInteraction(ev, {
            type: 4,
            data: this.bot.getCompactedMessageWithEmbed(`你選擇對 <@${p.member.id}> ${type}。`, true)
        }, "witch-action");
        await this.bot.deleteMessage(this.threadChannel!!, this.witchAMsgId!!, "witch-msg-a");
        return true;
    }

    private async turnOfDaylight(prefix: string): Promise<string> {
        if(this.debugVoteOnly) return "VoteOnly";

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
        return saved ?
            `${prefix}天亮了。昨晚是平安夜。` :
            (this.witchAction == "kill" && this.witchTarget != this.wolvesKilled ?
                `${prefix}天亮了。昨晚死亡的是 <@${wolvesKilled?.member.id}>、<@${witchTarget?.member.id}>。` :
                `${prefix}天亮了。昨晚死亡的是 <@${wolvesKilled?.member.id}>。`);
    }

    private async turnOfHunter(quote: string): Promise<boolean> {
        if(this.debugVoteOnly) return false;

        const wolvesKilled = this.players.find(p => p.number == this.wolvesKilled);
        const votedDown = this.votes[0];

        let hunter: Player | null = null;
        if(wolvesKilled?.role == Role.HUNTER) hunter = wolvesKilled;
        if(votedDown?.role == Role.HUNTER) hunter = votedDown;

        if(hunter) {
            this.state = GameState.HUNTER;
            Logger.log("state (" + this.guildId + ") -> hunter");

            let cancelled = false;
            let handler = () => {
                cancelled = true;
            };
            this.interactionStorage.on("cancelled", handler);

            this.bot.sendMessage(this.threadChannel!!, {
                embeds: [
                    {
                        ...this.getGameEmbed(),
                        description: quote + `\n<@${hunter.member.id}> 是獵人，請選擇要帶走的對象:`
                    }
                ],
                components: this.getHunterComponents()
            }, "hunter-turn");

            while(true) {
                const ev = await this.waitNextRoleInteraction(Role.HUNTER, false);
                if(cancelled || !ev) {
                    this.interactionStorage.off("cancelled", handler);
                    return false;
                }

                if(ev.data.custom_id != "hunter_target") continue;
                
                const opt: string = ev.data.values[0];
                if(!opt.startsWith("player_")) {
                    continue;
                }

                const hunted = parseInt(opt.substring(7));
                const killed = this.players.find(p => p.number == hunted);
                killed?.kill();

                await this.bot.respondToInteraction(ev, {
                    type: 4,
                    data: this.bot.getCompactedMessageWithEmbed(`獵人帶走了 <@${killed!!.member.id}>。`)
                }, "hunter-killed");
                await this.bot.deleteMessage(this.threadChannel!!, ev.message.id, "hunter-source");
                break;
            }
        }
        return !!hunter;
    }

    private async turnOfDiscuss(quote: string): Promise<boolean> {
        this.state = GameState.DISCUSS;
        Logger.log("state (" + this.guildId + ") -> discuss");

        // @ts-ignore
        const api: any = this.bot.api.api;

        this.voteLimit = this.players.length;
        this.votes = [];
        Array.prototype.push.apply(this.votes, this.players);

        const discussTime = this.config.isDebugShortTime() ? 15 : 120;

        const r = await this.bot.sendMessage(this.threadChannel!!, {
            embeds: [
                {
                    ...this.getGameEmbed(),
                    description: quote + ((quote && quote.trim() != "") ? "\n" : "") +`請玩家發言，${discussTime} 秒後開放投票。`
                }
            ],
            components: this.getDiscussComponents()
        }, "discuss-turn");

        this.currentTimeout = setTimeout(() => {
            this.bot.editMessage(this.threadChannel!!, r.id, {
                components: this.getDiscussComponents(true)
            }, "discuss-enable-vote");
        }, discussTime * 1000);

        let cancelled = false;
        let handler = () => {
            cancelled = true;
        };
        this.interactionStorage.on("cancelled", handler);

        while(true) {
            const ev = await this.waitNextPlayerInteraction();
            if(cancelled || !ev) {
                this.interactionStorage.off("cancelled", handler);
                return true;
            }

            if(!ev.data.custom_id.startsWith("discuss")) {
                Logger.warn("Not discuss, but get " + ev.data.custom_id);
                continue;
            }

            const key = ev.data.custom_id.substring(8);
            switch(key) {
                case "vote":
                    this.bot.deleteMessage(this.threadChannel!!, ev.message.id, "discuss-source-a");
                    this.voteLimit = this.players.length;
                    this.votes = [];
                    Array.prototype.push.apply(this.votes, this.players);
                    return false;
                case "knight":
                    const player = this.getPlayerFromInteraction(ev);
                    if(player!!.role != Role.KNIGHT) {
                        this.bot.respondToInteraction(ev, {
                            type: 4,
                            data: this.getRoleMismatchMessage(Role.KNIGHT)
                        }, "discuss-not-knight");
                        continue;
                    }
                    
                    this.bot.deleteMessage(this.threadChannel!!, ev.message.id, "discuss-source-b");
                    this.bot.respondToInteraction(ev, {
                        type: 4,
                        data: this.getKnightMessage()
                    }, "discuss-knight");

                    this.state = GameState.KNIGHT;
                    Logger.log("state (" + this.guildId + ") -> knight");
                    return true;
            }
        }
    }

    private async turnOfKnight() {
        if(this.debugVoteOnly) return;

        let cancelled = false;
        let handler = () => {
            cancelled = true;
        };
        this.interactionStorage.on("cancelled", handler);

        while(true) {
            const ev = await this.waitNextRoleInteraction(Role.KNIGHT);
            if(cancelled || !ev) {
                this.interactionStorage.off("cancelled", handler);
                return;
            }

            if(ev.data.custom_id != "knight_inspect") {
                Logger.warn("Not knight_inspect, but get " + ev.data.custom_id);
                continue;
            }
            
            const player = this.getPlayerFromInteraction(ev)!!;
            const opt: string = ev.data.values[0];
            if(!opt.startsWith("player_")) {
                Logger.warn("Not started with player_, but get " + opt);
                continue;
            }
    
            const n = parseInt(opt.substring(7));
            const p = this.players.find(p => p.number == n)!!;
            const isWolf = p.role == Role.WEREWOLVES;
    
            (isWolf ? p : player).kill();
    
            await this.bot.respondToInteraction(ev, {
                type: 4,
                data: this.bot.getCompactedMessageWithEmbed( `<@${p.member.id}> 是${isWolf ? "狼人，狼人死亡" : "好人，騎士以死謝罪"}。`)
            }, "knight-result");
    
            this.bot.deleteMessage(this.threadChannel!!, ev.message.id, "knight-source");
            return;
        }
    }

    private async turnOfVote(appendEmbeds: any[] = []) {
        this.state = GameState.VOTE;
        Logger.log("state (" + this.guildId + ") -> vote");

        const voteTime = this.config.isDebugShortTime() ? 10 : 30;
        this.voteQuote = `請開始投票，${voteTime} 秒後結束投票。`;
        
        while(this.voteLimit < this.votes.length) {
            this.votes.pop();
        }

        this.players.forEach(v => {
            v.choice = -1;
        });
        this.refreshVotes();

        const r = await this.bot.sendMessage(this.threadChannel!!, this.getVoteMessage(appendEmbeds), "vote-turn");
        this.voteMsgId = r.id;

        this.currentTimeout = setTimeout(() => {
            this.endOfVote();
        }, voteTime * 1000);
    }

    private async endOfVote() {
        Logger.log("endOfVote() called");
        await this.bot.deleteMessage(this.threadChannel!!, this.voteMsgId!!, "vote-msg");

        this.votes.sort((a, b) => {
            return b.votes - a.votes;
        });

        if(this.votes[0].votes == 0) {
            await this.bot.sendMessage(this.threadChannel!!, this.bot.getCompactedMessageWithEmbed("無人投票，進入下一晚..."), "vote-transition-night");
            this.isVoting = false;
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

        await this.bot.sendMessage(this.threadChannel!!, this.bot.getCompactedMessageWithEmbed(`最高票為 <@${this.votes[0].member.id}>`), "vote-down-max");
        this.votes[0].kill();
        this.isVoting = false;
    }

    // --------------==================================-------------- //

    private async sendMemberNotPlayerInteraction(ev: KInteractionWS) {
        // @ts-ignore
        let rest: any = this.bot.api.api;
        await rest.interactions(ev.id, ev.token).callback.post({
            data: {
                type: 4,
                data: this.bot.getCompactedMessageWithEmbed("你不在遊戲當中，無法執行該操作。", true)
            }
        }).catch(this.bot.failedToSendMessage("member-not-player"));
    }

    private async sendPlayerDeadInteraction(ev: KInteractionWS) {
        // @ts-ignore
        let rest: any = this.bot.api.api;
        await rest.interactions(ev.id, ev.token).callback.post({
            data: {
                type: 4,
                data: this.getPlayerDeadInvalidMessage()
            }
        }).catch(this.bot.failedToSendMessage("player-dead"));
    }

    private async sendPlayerRoleMismatchInteraction(ev: KInteractionWS, role: Role) {
        // @ts-ignore
        let rest: any = this.bot.api.api;
        rest.interactions(ev.id, ev.token).callback.post({
            data: {
                type: 4,
                data: this.getRoleMismatchMessage(role)
            }
        }).catch(this.bot.failedToSendMessage("not-target-role"));
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
                    const p = new Player(this.players.length + 1, member);
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
    
    private async handleVoteInteraction(ev: KInteractionWS) {
        if(ev.data.custom_id != "vote") {
            return;
        }
        const player = this.getPlayerFromInteraction(ev);
        if(!player) {
            this.bot.respondToInteraction(ev, {
                type: 4,
                data: this.bot.getCompactedMessageWithEmbed("你不在遊戲當中，無法執行該操作。", true)
            }, "vote-ephemeral");
            return;
        }
        if(!player?.alive) {
            this.bot.respondToInteraction(ev, {
                type: 4,
                data: this.getPlayerDeadInvalidMessage()
            }, "vote-dead");
            return;
        }

        const opt: string = ev.data.values[0];
        if(!opt.startsWith("vote_")) {
            Logger.warn("Not started with vote_, but get " + opt);
            return;
        }

        const n = parseInt(opt.substring(5));
        player.choice = player.alive ? n : -1;
        this.refreshVotes();

        await this.bot.respondToInteraction(ev, {
            type: 7,
            data: this.getVoteMessage()
        }, "vote-result");
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
        var players = this.players.map((m: Player, i: number) => {
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
        var players = this.players.map((m: Player, i: number) => {
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
        var players = this.players.map((m: Player, i: number) => {
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
        var players = this.votes.map((m: Player, i: number) => {
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

        this.bot.respondToInteraction(ev, {
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
        }, "lobby-patch-playing");

        // Create a thread from the lobby message
        const r = await this.rest.channels(this.gameChannel!!.id).messages(msgId).threads.post({
            data: {
                name: "狼人殺遊戲",
                auto_archive_duration: 60
            }
        }).catch(this.bot.failedToCreateThread("game-thread"));
        this.hasThread = true;
        
        for(var i=0; i<this.players.length; i++) {
            const p = this.players[i].member.id;
            this.rest.channels(r.id, "thread-members", p).put().catch(this.bot.failedToAddThreadMember("game-thread-member"));
        }

        this.threadChannel = r.id;
        this.daysCount = 0;

        this.currentTimeout = setTimeout(() => {
            this.runGameLoop();
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

    private cancel() {
        this.cancelled = true;
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
        const threadChannel = this.threadChannel!!;
        await this.bot.sendMessage(threadChannel, data.data, "end-game-in-thread");
        
        const dateStr = new Date().toISOString().replace(/(?=.*?)T/, " ").replace(/(?=.*?)\..*/, "").replace(/:/g, "-");
        await this.rest.channels(threadChannel).patch({
            data: {
                name: "狼人殺遊戲紀錄：" + dateStr,
                archived: true,
                locked: true
            }
        });
        setTimeout( () => {
            this.rest.channels(threadChannel).delete().catch(() => {});
        }, 20000);
        await this.rest.channels(this.gameChannel!!.id).messages(threadChannel).patch(data).catch(this.bot.failedToSendMessage("end-game-in-history"));

        this.interactionStorage.cancel();
        this.cancel();

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