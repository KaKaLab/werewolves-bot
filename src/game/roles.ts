export enum Role {
    SEER,
    WITCH,
    HUNTER,
    KNIGHT,
    WEREWOLVES,
    THIEF,
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
            5: "盜賊",
            6: "平民"
        }[role] ?? "未知";
    }

    export const COUNT = 7;
}