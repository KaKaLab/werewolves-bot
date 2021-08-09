import {
    ButtonInteraction,
    Client, CommandInteraction, Guild, GuildChannel, GuildMember,
    Interaction, Message, MessageActionRowOptions, MessageComponentInteraction, TextChannel, ThreadChannel
} from "discord.js";
import { WerewolvesBot } from "../bot";
import { BotGuildConfig } from "../guildConfig";
import { AsyncStorage } from "../utils/asyncStorage";
import { Logger } from "../utils/logger";
import { PromiseTimer } from "../utils/promise";
import { Player } from "./player";
import { Role } from "./roles";
import { blacklist } from "../static/blacklist.json";
import { Failed } from "../utils/errors";

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

export enum GameEndReason {
    COUPLE_WIN, WOLF_WIN, GREAT_WIN, CUSTOM
}

type PlayableChannel = TextChannel;

type WitchActions = {
    kill: "投毒",
    save: "解藥"
};

type WitchActionKeys = keyof WitchActions;

export class Werewolves {
    public players: Player[] = []
    private votes: Player[] = []
    public state: GameState = GameState.READY;
    private bot: WerewolvesBot;

    public guildId: string;
    public config: BotGuildConfig;

    public gameChannel: PlayableChannel | null = null;

    private threadChannel: ThreadChannel | null = null;
    private lobbyMessage: Message | null = null;
    // private appId: string | null = null;
    // private interactionToken: string | null = null;
    private interaction: Interaction | null = null;
    
    private hasThread = false;

    private wolvesKilled = -1;
    private witchTarget = -1;
    private witchAction: "kill" | "save" | null = null;
    private voteLimit = -1;

    private voteQuote = "";
    private voteMsgId: string | null = null;

    private currentTimeout: NodeJS.Timeout | null = null;

    private daysCount = -1;

    private cancelled = false;
    public inProgress = false;
    public startTime = new Date();

    private isVoting = false;
    private endReason: GameEndReason = GameEndReason.CUSTOM;

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

    private interactionStorage: AsyncStorage<MessageComponentInteraction> = new AsyncStorage();

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
        this.bot.api.on("interactionCreate", async (interaction) => {
            if(!interaction.isMessageComponent()) return;
            if(!interaction.member) return;
            if(interaction.guildId != this.guildId) return;
            if(this.bot.isBlacklisted(interaction.member.user.id)) {
                const data = blacklist.find(item => item.id == interaction.member!!.user.id)!!.reason;
                const buff = Buffer.from(data, "base64");
                const text = buff.toString("utf-8");

                this.bot.respondToInteraction(interaction, {
                    type: 4,
                    data: this.bot.getCompactedMessageWithEmbed(text, true)
                }, "banned");
                return;
            }

            if(this.isVoting) {
                await this.handleVoteInteraction(interaction);
            }
            this.interactionStorage.store(interaction);

            Logger.log(`Interaction issuer: ${interaction.member.user.username}#${interaction.member.user.discriminator} (in guild ${interaction.guildId})`);

            if(this.state == GameState.READY) {
                Logger.log(`interaction (${this.guildId}) -> state: ready`);
                await this.handleLobbyInteraction(interaction);
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
                this.votes[v.choice].votes += (v.isSheriff ? 2 : 1);
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

    public getPlayerFromInteraction(interaction: Interaction) {
        const userId = interaction.user.id;
        if(!this.isMemberInGame(userId)) return null;

        return this.players.find(p => {
            return p.member.id == userId
        });
    }

    private async waitNextPlayerInteraction(aliveOnly = true) {
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

    private async waitNextRoleInteraction(role: Role, aliveOnly = true) {
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
        const c = this.getCouples().filter(p => p.alive).length;

        if(c > 0 && b <= 3) {
            this.endReason = GameEndReason.COUPLE_WIN;
            return true;
        }

        if(w == 0) {
            this.endReason = GameEndReason.GREAT_WIN;
            return true;
        } else if(b - w <= 1) {
            this.endReason = GameEndReason.WOLF_WIN;
            return true;
        } else {
            return false;
        }
    }

    private async runGameLoop() {
        let ended = this.isGameEnded();
        this.daysCount = -1;
        this.cancelled = false;

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

            if(this.daysCount == 1) {
                const sheriff = this.players.find(p => p.isSheriff);
                if(sheriff) {
                    await this.threadChannel?.send(this.bot.getCompactedMessageWithEmbed(`<@${sheriff.member.id}> 是警長。`));
                    if(this.cancelled) return;
                }
            }

            await this.turnOfHunter(quote);
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

                await this.turnOfHunter(quote);
                if(this.cancelled) return;

                if(this.isGameEnded()) break;
            }
        }

        let gameMsg = "遊戲結束。";
        switch(this.endReason) {
            case GameEndReason.COUPLE_WIN:
                gameMsg = "特殊結局，CP 勝利。";
                break;
            case GameEndReason.GREAT_WIN:
                gameMsg = "遊戲結束，好人勝利。";
                break;
            case GameEndReason.WOLF_WIN:
                gameMsg = "遊戲結束，狼人勝利。";
                break;
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

        this.threadChannel?.send(this.getWerewolvesMessage()).catch(Failed.toSendMessageIn(this.threadChannel, "werewolves-action"));
        while(true) {
            const interaction = await this.waitNextRoleInteraction(Role.WEREWOLVES);
            if(cancelled || !interaction) {
                this.interactionStorage.off("cancelled", handler);
                return;
            }
            if(interaction.customId != "werewolves_kill") continue;
            if(!interaction.isSelectMenu()) continue;

            const opt = interaction.values[0];
            if(!opt.startsWith("player_")) {
                continue;
            }

            this.wolvesKilled = parseInt(opt.substring(7));
            const killed = this.players.find(p => p.number == this.wolvesKilled);

            await this.bot.respondToInteraction(interaction, {
                type: 4,
                data: this.bot.getCompactedMessageWithEmbed(`你殺掉了 <@${killed!!.member.id}>。`, true)
            }, "werewolves-killed");
            if(interaction.message instanceof Message) {
                await interaction.message.delete().catch(Failed.toDeleteMessage("werewolve-source"));
            }
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

            this.threadChannel?.send(this.getSeerMessage()).catch(Failed.toSendMessageIn(this.threadChannel, "seer-turn"));
            while(true) {
                const interaction = await this.waitNextRoleInteraction(Role.SEER);
                if(cancelled || !interaction) {
                    this.interactionStorage.off("cancelled", handler);
                    return;
                }
    
                if(interaction.customId != "seer_inspect") {
                    Logger.warn("Not seer_inspect, but get " + interaction.customId);
                    continue;
                }
                if(!interaction.isSelectMenu()) continue;

                const opt = interaction.values[0];
                if(!opt.startsWith("player_")) {
                    Logger.warn("Not started with player_, but get " + opt);
                    continue;
                }

                const n = parseInt(opt.substring(7));
                const p = this.players.find(p => p.number == n)!!;
                const isWolf = p.role == Role.WEREWOLVES;

                await this.bot.respondToInteraction(interaction, {
                    type: 4,
                    data: this.bot.getCompactedMessageWithEmbed(`<@${p.member.id}> 是${isWolf ? "狼人" : "好人"}。`, true)
                }, "seer-inspected");
                if(interaction.message instanceof Message) {
                    await interaction.message.delete().catch(Failed.toDeleteMessage("seer-source"));
                }
                break; 
            }
        }
    }

    private async turnOfWitch(): Promise<string> {
        if(this.debugVoteOnly) return "已啟用僅投票模式。";
        
        this.witchTarget = -1;
        this.witchAction = null;
        if(this.getWitches().find(p => p.alive)) {
            const prefix = this.state == GameState.WEREWOLVES ? "狼人請閉眼，" : "預言家請閉眼，";
            this.state = GameState.WITCH;
            Logger.log("state (" + this.guildId + ") -> witch");

            const r: any = await this.threadChannel?.send(this.getWitchMessageA(prefix)).catch(Failed.toSendMessageIn(this.threadChannel, "witch-turn-a"));
            this.witchAMsgId = r.id;
            Logger.info("WitchA msg id -> " + this.witchAMsgId);

            let cancelled = false;
            let handler = () => {
                cancelled = true;
            };
            this.interactionStorage.on("cancelled", handler);

            while(true) {
                let toSkip = false;
                const interaction = await this.waitNextRoleInteraction(Role.WITCH);
                if(cancelled || !interaction) {
                    this.interactionStorage.off("cancelled", handler);
                    return "";
                }
    
                if(interaction.message.id == this.witchAMsgId) {
                    Logger.log(`interaction (${this.guildId}) -> state: witchA`);
                    toSkip = await this.processWitchInteractionA(interaction);
                } else {
                    Logger.log(`interaction (${this.guildId}) -> state: witchB`);
                    toSkip = await this.processWitchInteractionB(interaction);
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

    private async processWitchInteractionA(interaction: MessageComponentInteraction): Promise<boolean> {
        if(!interaction.customId.startsWith("witch_")) return false;

        const key = interaction.customId.substring(6);
        if(key == "inspect") {
            const wolvesKilled = this.players.find(p => p.number == this.wolvesKilled);
            this.bot.respondToInteraction(interaction, {
                type: 4,
                data: this.bot.getCompactedMessageWithEmbed(`本回合狼人殺了 <@${wolvesKilled?.member.id}>。`, true)
            }, "witch-inspect-killer");
            return false;
        }
        else if(key == "skip") {
            this.bot.respondToInteraction(interaction, {
                type: 4,
                data: this.bot.getCompactedMessageWithEmbed("你選擇跳過本回合。", true)
            }, "witch-skip");
            await this.threadChannel?.messages.delete(this.witchAMsgId!!).catch(Failed.toDeleteMessage("witch-source"));
            return true;
        } else if(key == "kill") {
            const remains = this.witchRemainSkills[key];
            if(remains <= 0) {
                this.bot.respondToInteraction(interaction, {
                    type: 4,
                    data: this.bot.getCompactedMessageWithEmbed((key == "kill" ? "毒藥" : "解藥") + "已用完。", true)
                });
                return false;
            }
            this.witchRemainSkills[key]--;

            const type = ({
                kill: "投毒",
                save: "解藥"
            } as WitchActions)[key];
            this.witchAction = key;

            this.bot.respondToInteraction(interaction, {
                type: 4,
                data: {
                    ...this.getWitchMessageB(type),
                    flags: 64
                }
            }, "witchB");
            return false;
        }
        return false;
    }

    private async processWitchInteractionB(interaction: MessageComponentInteraction): Promise<boolean> {
        if(!interaction.customId.startsWith("witch_")) return false;
        if(!interaction.isSelectMenu()) return false;

        const opt = interaction.values[0];
        if(!opt.startsWith("player_")) {
            Logger.warn("Not started with player_, but get " + opt);
            return false;
        }

        const n = parseInt(opt.substring(7));
        const p = this.players.find(p => p.number == n)!!;
        this.witchTarget = p.number;
        
        const type = {
            kill: "投毒",
            save: "解藥"
        }[this.witchAction!!];

        this.bot.respondToInteraction(interaction, {
            type: 4,
            data: this.bot.getCompactedMessageWithEmbed(`你選擇對 <@${p.member.id}> ${type}。`, true)
        }, "witch-action");
        await this.threadChannel?.messages.delete(this.witchAMsgId!!).catch(Failed.toDeleteMessage("witch-msg-a"));
        return true;
    }

    private async turnOfDaylight(prefix: string): Promise<string> {
        if(this.debugVoteOnly) return "已啟用僅投票模式。";

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

            this.threadChannel?.send({
                embeds: [
                    {
                        ...this.getGameEmbed(),
                        description: quote + `\n<@${hunter.member.id}> 是獵人，請選擇要帶走的對象:`
                    }
                ],
                components: this.getHunterComponents()
            }).catch(Failed.toSendMessageIn(this.threadChannel, "hunter-turn"));

            while(true) {
                const interaction = await this.waitNextRoleInteraction(Role.HUNTER, false);
                if(cancelled || !interaction) {
                    this.interactionStorage.off("cancelled", handler);
                    return false;
                }
                if(interaction.customId != "hunter_target") continue;
                if(!interaction.isSelectMenu()) continue;
                
                const opt: string = interaction.values[0];
                if(!opt.startsWith("player_")) {
                    continue;
                }

                const hunted = parseInt(opt.substring(7));
                const killed = this.players.find(p => p.number == hunted);
                killed?.kill();

                await interaction.reply(this.bot.getCompactedMessageWithEmbed(`獵人帶走了 <@${killed!!.member.id}>。`))
                    .catch(Failed.toReplyInteraction("hunter-killed"));
                await this.threadChannel?.messages.delete(interaction.message.id)
                    .catch(Failed.toDeleteMessageIn(this.threadChannel, "hunter-source"));
                break;
            }
        }
        return !!hunter;
    }

    private async turnOfDiscuss(quote: string): Promise<boolean> {
        this.state = GameState.DISCUSS;
        Logger.log("state (" + this.guildId + ") -> discuss");

        this.voteLimit = this.players.length;
        this.votes = [];
        Array.prototype.push.apply(this.votes, this.players);

        const discussTime = this.config.isDebugShortTime() ? 15 : 120;

        const r = await this.threadChannel?.send({
            embeds: [
                {
                    ...this.getGameEmbed(),
                    description: quote + ((quote && quote.trim() != "") ? "\n" : "") +`請玩家發言，${discussTime} 秒後開放投票。`
                }
            ],
            components: this.getDiscussComponents()
        }).catch(Failed.toSendMessageIn(this.threadChannel, "discuss-turn"));

        this.currentTimeout = setTimeout(() => {
            r?.edit({
                components: this.getDiscussComponents(true)
            }).catch(Failed.toEditMessageIn(r.channel, "discuss-enable-vote"));
        }, discussTime * 1000);

        let cancelled = false;
        let handler = () => {
            cancelled = true;
        };
        this.interactionStorage.on("cancelled", handler);

        while(true) {
            const interaction = await this.waitNextPlayerInteraction();
            if(cancelled || !interaction) {
                this.interactionStorage.off("cancelled", handler);
                return true;
            }

            if(!interaction.customId.startsWith("discuss")) {
                Logger.warn("Not discuss, but get " + interaction.customId);
                continue;
            }

            const key = interaction.customId.substring(8);
            switch(key) {
                case "vote":
                    if(interaction.message instanceof Message) {
                        interaction.message.delete().catch(Failed.toDeleteMessage("discuss-source-a"));
                    }
                    this.voteLimit = this.players.length;
                    this.votes = [];
                    Array.prototype.push.apply(this.votes, this.players);
                    return false;
                case "knight":
                    const player = this.getPlayerFromInteraction(interaction);
                    if(player!!.role != Role.KNIGHT) {
                        this.bot.respondToInteraction(interaction, {
                            type: 4,
                            data: this.getRoleMismatchMessage(Role.KNIGHT)
                        }, "discuss-not-knight");
                        continue;
                    }
                    
                    const msg = interaction.message;
                    if(msg instanceof Message) {
                        msg.delete().catch(Failed.toDeleteMessageIn(msg.channel, "discuss-source-b"));
                    }
                    interaction.reply(this.getKnightMessage()).catch(Failed.toReplyInteraction("discuss-knight"));

                    this.state = GameState.KNIGHT;
                    Logger.log("state (" + this.guildId + ") -> knight");
                    return true;
            }
        }
    }

    private async turnOfKnight() {
        let cancelled = false;
        let handler = () => {
            cancelled = true;
        };
        this.interactionStorage.on("cancelled", handler);

        while(true) {
            const interaction = await this.waitNextRoleInteraction(Role.KNIGHT);
            if(cancelled || !interaction) {
                this.interactionStorage.off("cancelled", handler);
                continue;
            }
            if(interaction.customId != "knight_inspect") {
                Logger.warn("Not knight_inspect, but get " + interaction.customId);
                continue;
            }
            if(!interaction.isSelectMenu()) continue;
            
            const player = this.getPlayerFromInteraction(interaction)!!;
            const opt = interaction.values[0];
            if(!opt.startsWith("player_")) {
                Logger.warn("Not started with player_, but get " + opt);
                continue;
            }
    
            const n = parseInt(opt.substring(7));
            const p = this.players.find(p => p.number == n)!!;
            const isWolf = p.role == Role.WEREWOLVES;
    
            (isWolf ? p : player).kill();
    
            await this.bot.respondToInteraction(interaction, {
                type: 4,
                data: this.bot.getCompactedMessageWithEmbed( `<@${p.member.id}> 是${isWolf ? "狼人，狼人死亡" : "好人，騎士以死謝罪"}。`)
            }, "knight-result");
    
            const msg = interaction.message;
            if(msg instanceof Message) {
                msg.delete().catch(Failed.toDeleteMessageIn(msg.channel, "knight-source"));
            }
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

        try {
            const r = await this.threadChannel?.send(this.getVoteMessage(appendEmbeds));
            this.voteMsgId = r!!.id;

            this.currentTimeout = setTimeout(() => {
                this.endOfVote();
            }, voteTime * 1000);
        } catch(ex) {
            Failed.toSendMessageIn(this.threadChannel!!, "vote-turn")(null);
        }
    }

    private async endOfVote() {
        Logger.log("endOfVote() called");
        await this.threadChannel?.messages.delete(this.voteMsgId!!).catch(Failed.toDeleteMessageIn(this.threadChannel, "vote-msg"));

        this.votes.sort((a, b) => {
            return b.votes - a.votes;
        });

        if(this.votes[0].votes == 0) {
            await this.threadChannel?.send(this.bot.getCompactedMessageWithEmbed("無人投票，進入下一晚..."))
                .catch(Failed.toSendMessageIn(this.threadChannel, "vote-transition-night"));
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

        await this.threadChannel?.send(this.bot.getCompactedMessageWithEmbed(`最高票為 <@${this.votes[0].member.id}>`))
            .catch(Failed.toSendMessageIn(this.threadChannel, "vote-down-max"));
        this.votes[0].kill();
        this.isVoting = false;
    }

    // --------------==================================-------------- //

    private stopFromError() {
        if(this.inProgress) {
            this.endReason = GameEndReason.CUSTOM;
            this.stopGame("因為遊戲內部錯誤，遊戲已結束。造成不便請見諒！");
        }
    }

    private async sendMemberNotPlayerInteraction(ev: CommandInteraction | MessageComponentInteraction) {
        await this.bot.respondToInteraction(ev, {
            type: 4,
            data: this.bot.getCompactedMessageWithEmbed("你不在遊戲當中，無法執行該操作。", true)
        }, "member-not-player");
    }

    private async sendPlayerDeadInteraction(ev: CommandInteraction | MessageComponentInteraction) {
        await this.bot.respondToInteraction(ev, {
            type: 4,
            data: this.getPlayerDeadInvalidMessage()
        }, "player-dead");
    }

    private async sendPlayerRoleMismatchInteraction(ev: CommandInteraction | MessageComponentInteraction, role: Role) {
        await this.bot.respondToInteraction(ev, {
            type: 4,
            data: this.getRoleMismatchMessage(role)
        }, "not-target-role");
    }

    private async handleLobbyInteraction(interaction: MessageComponentInteraction) {
        if(!interaction.member) return;
        const userId = interaction.member.user.id;
        const guild = this.bot.api.guilds.cache.get(this.guildId)!!;
        const member = await guild.members.fetch(userId);

        var sendEphemeralEmbed = (desc: string) => {
            this.bot.respondToInteraction(interaction, {
                type: 4,
                data: this.bot.getCompactedMessageWithEmbed(desc, true)
            }, "lobby-ephemeral");
        }

        switch(interaction.customId) {
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

                this.startGame(interaction);  
                return;
        }

        this.bot.respondToInteraction(interaction, {type: 7,
            data: this.getLobbyMessage()
        }, "lobby");

        if(this.interaction != null) {
            if(interaction.message instanceof Message) {
                const chn = interaction.message.channel;
                if(chn instanceof TextChannel) {
                    this.gameChannel = chn;
                    this.interaction = null;
                }
            }
        }
    }
    
    private async handleVoteInteraction(ev: MessageComponentInteraction) {
        if(!ev.isSelectMenu()) return;
        if(ev.customId != "vote") {
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

        const opt: string = ev.values[0];
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

        const features = this.config.getFeatures();
        const {
            knight: knightThreshold,
            couples: couplesThreshold,
            sheriff: sheriffThreshold
        } = this.config.getThresholds();

        let maxRole = seerCount;
        maxRole += witchCount;
        maxRole += hunterCount;
        maxRole += werewolvesCount;
        if(b >= knightThreshold) maxRole += knightCount;
        
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

        // -- Game features

        if(features.hasCouples && b >= couplesThreshold) {
            const indices: number[] = [];
            for(let i=0; i<b; i++) {
                indices.push(i);
            }
            indices.sort(() => Math.random() - 0.5);
            
            const x = this.players[indices.shift()!!];
            const y = this.players[indices.shift()!!];
            x.couple = y;
        }

        if(features.hasSheriff && b >= sheriffThreshold) {
            const indices: number[] = [];
            for(let i=0; i<b; i++) {
                indices.push(i);
            }
            indices.sort(() => Math.random() - 0.5);
            
            const x = this.players[indices.shift()!!];
            x.isSheriff = true;
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

    private getWitchMessageB(type: WitchActions[WitchActionKeys]): any {
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

    private getLobbyComponents(): MessageActionRowOptions[] {
        return [
            {
                type: 1,
                components: [
                    {
                        type: 2,
                        customId: "game_join",
                        style: 2,
                        label: "加入"
                    },
                    {
                        type: 2,
                        customId: "game_leave",
                        style: 2,
                        label: "離開"
                    },
                    {
                        type: 2,
                        customId: "game_start",
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

    public prepareLobby() {
        Logger.log("state (" + this.guildId + ") -> ready");

        Logger.info("Lobby started!");

        this.loadConfig();
    }

    public async showLobby(interaction: CommandInteraction | null = null) {
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
            const r = await this.gameChannel?.send(this.getLobbyMessage()).catch(Failed.toSendMessageIn(this.gameChannel!!, "lobby-renew-game"));
            this.lobbyMessage = r ?? null;
            this.interaction = null;
        } else {
            if(!interaction.guildId) return;

            Logger.log("Send ready message by interaction respond");
            await this.bot.respondToInteraction(interaction, {
                type: 4,
                data: this.getLobbyMessage()
            }, "lobby-cmd-interaction");

            this.lobbyMessage = null;
            this.interaction = interaction;

            const bot = this.bot.api;
            const chn = bot.guilds.cache.get(interaction.guildId)!!.channels.cache.get(interaction.channelId);
            if(chn instanceof TextChannel) {
                this.gameChannel = chn;
                this.config.data.gameChannel = chn.id;
                this.config.save();
            }
        }
    }

    public async startGame(ev: MessageComponentInteraction) {
        this.inProgress = true;
        this.startTime = new Date();
        const msgId = ev.message.id;

        this.assignRoles();

        this.players.forEach(p => {
            let suffix = "";
            if(p.role == Role.WEREWOLVES) {
                suffix += "\n狼人: " + this.getWerewolves().map(p => p.member.user.tag).join("、");
            }

            if(!!p.couple) {
                suffix += "\n**你和 " + p.couple.member.user.tag + " 是 CP。**";
            }

            p.member.send({
                embeds: [
                    {
                        ...this.getEmbedBase(),
                        description: `你的身分是: **${Role.getName(p.role)}。**` + suffix
                    }
                ]
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
                                customId: "game_join",
                                style: 2,
                                label: "加入",
                                disabled: true
                            },
                            {
                                type: 2,
                                customId: "game_leave",
                                style: 2,
                                label: "離開",
                                disabled: true
                            },
                            {
                                type: 2,
                                customId: "game_start",
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
        try {
            if(ev.message instanceof Message) {
                const r = await ev.message.startThread({
                    name: "狼人殺遊戲",
                    autoArchiveDuration: 60,
                    reason: "建立狼人殺機器人的遊戲環境"
                })!!;
                this.hasThread = true;
                
                for(var i=0; i<this.players.length; i++) {
                    const p = this.players[i].member;
                    r.members.add(p).catch(Failed.toAddThreadMemberIn(r, "game-thread-member"));
                }

                this.threadChannel = r;
                this.daysCount = 0;

                this.currentTimeout = setTimeout(() => {
                    this.runGameLoop();
                }, 10000);
            }
        } catch(ex) {
            Logger.error("Failed to create a thread channel for the game.");
            Logger.error(ex.toString());
        }
    }

    public async cleanGameMessages() {
        if(this.threadChannel != null) {
            if(this.hasThread) {
                await this.threadChannel?.delete().catch(Failed.toDeleteChannel("clean-thread"));
            }

            await this.lobbyMessage?.delete().catch(Failed.toDeleteMessageIn(this.gameChannel!!, "clean-game-message"));
            this.threadChannel = null;
            this.interaction = null;
        }

        if(this.interaction != null) {
            if(this.interaction.isCommand()) {
                await this.interaction.webhook.deleteMessage("@original");
            }
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
        this.inProgress = false;

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

        const threadChannel = this.threadChannel;
        await threadChannel?.send(data.data).catch(Failed.toSendMessageIn(threadChannel, "end-game-in-thread"));

        const dateStr = new Date().toISOString().replace(/(?=.*?)T/, " ").replace(/(?=.*?)\..*/, "").replace(/:/g, "-");
        await threadChannel?.edit({
            name: "狼人殺遊戲紀錄：" + dateStr,
            archived: true,
            locked: true
        });
        setTimeout( () => {
            threadChannel?.delete("清除已結束的狼人殺討論串");
        }, 20000);
        await this.gameChannel?.messages.edit(threadChannel!!.id, data.data).catch(Failed.toEditMessageIn(this.gameChannel, "end-game-in-history"));

        this.interactionStorage.cancel();
        this.cancel();

        this.threadChannel = null;
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