import { TextBasedChannels, ThreadChannel } from "discord.js";
import { Logger } from "./logger"

type OptionalNameTextChannel = TextBasedChannels & { name?: string }

export class Failed {
    public static toCreateThread(name: string) {
        return (ex: any) => {
            Logger.error(`Failed to create a thread: ${name}`);
            Logger.error(ex.toString());
        }
    }

    public static toSendMessageIn(channel: OptionalNameTextChannel, name: string) {
        return (ex: any) => {
            Logger.error(`Failed to send message: ${name} in channel: ${channel.name ?? channel.id}`);
            Logger.error(ex.toString());
        }
    }

    public static toEditMessageIn(channel: OptionalNameTextChannel, name: string) {
        return (ex: any) => {
            Logger.error(`Failed to edit message: ${name} in channel: ${channel.name}`);
            Logger.error(ex.toString());
        }
    }

    public static toReplyInteraction(name: string) {
        return (ex: any) => {
            Logger.error(`Failed to reply interaction: ${name}`);
            Logger.error(ex.toString());
        }
    }

    public static toDeleteChannel(name: string) {
        return (ex: any) => {
            Logger.error(`Failed to delete channel: ${name}`);
            Logger.error(ex.toString());
        }
    }

    public static toDeleteMessage(name: string) {
        return (ex: any) => {
            Logger.error(`Failed to delete message: ${name}`);
            Logger.error(ex.toString());
        }
    }

    public static toDeleteMessageIn(channel: OptionalNameTextChannel, name: string) {
        return (ex: any) => {
            Logger.error(`Failed to delete message: ${name} in channel: ${channel.name}`);
            Logger.error(ex.toString());
        }
    }
    
    public static toAddThreadMemberIn(channel: ThreadChannel, name: string) {
        return (ex: any) => {
            Logger.error(`Failed to add thread member: ${name} in thread: ${channel.name}`);
            Logger.error(ex.toString());
        }
    }
}