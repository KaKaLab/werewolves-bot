import { WebSocketManager } from "discord.js";
import { EventEmitter } from "events";

declare module "discord.js" {
    export class KInteractionWS {
        public version: number;
        public type: number;
        public token: string;
        public member: KMemberWS;
        public id: string;
        public guild_id: string;
        public data: any;
        public channel_id: string;
        public application_id: string;
        public message: any?
    }

    export class KMemberWS {
        public user: KUserWS;
        public roles: string[];
        public premium_since: string;
        public permissions: string;
        public pending: boolean;
        public nick: string;
        public mute: boolean;
        public joined_at: string;
        public is_pending: boolean;
        public deaf: boolean;
    }

    export class KUserWS {
        public username: string;
        public public_flags: number;
        public id: string;
        public discriminator: string;
        public avatar: string;
    }

    interface WebSocketManager extends EventEmitter {
        public on(event: "INTERACTION_CREATE", listener: (interaction: KInteractionWS, shardID: number) => Promise): this;
    }

    interface ClientEvents {
        interactionCreate: [KInteractionWS]
    }
}