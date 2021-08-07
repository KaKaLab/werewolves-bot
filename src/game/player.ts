import { GuildMember } from "discord.js";
import { Role } from "./roles";


export class Player {
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