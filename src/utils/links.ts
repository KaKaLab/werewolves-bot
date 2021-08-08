export class Links {
    public static twitter(id: string) {
        return `https://twitter.com/${id}`
    }
}

export class Icons {
    public static readonly twitter = "https://cdn.discordapp.com/attachments/827093892150067232/873841981447606282/124021.png";
}

class MarkdownLinkedTexts {
    public twitter(id: string) {
        return `[@${id}](${Links.twitter(id)})`;
    }
}

class MarkdownMentions {
    public channel(id: string) {
        return `<#${id}>`;
    }

    public user(id: string) {
        return `<@${id}>`;
    }

    public role(id: string) {
        return `<@&${id}>`;
    }
}

export class Markdown {
    private static _links = new MarkdownLinkedTexts();
    public static get links() {
        return Markdown._links;
    }

    private static _mentions = new MarkdownMentions();
    public static get mentions() {
        return Markdown._mentions;
    }
}