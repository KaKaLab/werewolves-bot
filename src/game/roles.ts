export enum Role {
    SEER,
    WITCH,
    HUNTER,
    KNIGHT,
    WEREWOLVES,
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
            5: "平民"
        }[role] ?? "未知";
    }

    export const COUNT = 6;
}