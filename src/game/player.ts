import { GuildMember } from "discord.js";
import { EventEmitter } from "stream";
import { Role } from "./roles";

export class Player extends EventEmitter {
    public member: GuildMember;
    public number: number;
    public alive: boolean = true; 
    public role: Role = Role.INNOCENT;

    public choice: number = -1;
    public votes: number = 0;

    public couple: Player | null = null;
    public isSheriff = false;
    public isThief = false;

    constructor(number: number, member: GuildMember) {
        super();
        this.number = number;
        this.member = member;
    }

    public kill() {
        this.alive = false;
        this.emit("killed");

        if(this.couple && this.couple.alive) {
            this.couple.kill();
        }
    }
}