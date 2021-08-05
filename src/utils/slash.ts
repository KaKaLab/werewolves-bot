import { Client } from "discord.js";

export class SlashPatch {
    static init(bot: Client) {
        bot.ws.on("INTERACTION_CREATE", async (interaction) => {
            bot.emit("interactionCreate", interaction);
        });
    }
}