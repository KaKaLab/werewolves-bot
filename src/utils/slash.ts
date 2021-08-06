import { Client } from "discord.js";

export class SlashPatch {
    static init(bot: Client) {
        bot.ws.on("INTERACTION_CREATE", async (interaction) => {
            bot.emit("interactionCreate", interaction);
        });
    }
}

export enum CommandOptionType {
    SUB_COMMAND = 1,
    SUB_COMMAND_GROUP,
    STRING,
    INTEGER,
    BOOLEAN,
    USER,
    CHANNEL,
    ROLE,
    MENTIONABLE,
    NUMBER
}