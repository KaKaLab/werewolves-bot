class KColor {
    public r = 0;
    public g = 0;
    public b = 0;

    constructor(rgb: number);
    constructor(r: number, g: number, b: number)
    constructor(arg1: number, g?: number, b?: number) {
        if(!g && !b) {
            arg1 |= 0;
            this.r = (arg1 >> 16) & 0xff;
            this.g = (arg1 >> 8) & 0xff;
            this.b = arg1 & 0xff;
        } else {
            this.r = arg1 | 0;
            this.g = g! | 0;
            this.b = b! | 0;
        }
    }

    public static fromNormalized(red: number, green: number, blue: number): KColor {
        return new KColor(red * 255, green * 255, blue * 255);
    }

    public getRGB(): number {
        var result = this.r;
        result = result << 8 | this.g;
        result = result << 8 | this.b;
        return result;
    }

    public normalized(): [number, number, number] {
        return [this.r / 255, this.g / 255, this.b / 255];
    }

    public toHSV(): [number, number, number] {
        const [r, g, b] = this.normalized();

        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const delta = max - min;

        var hue, saturation, value;
        const d60 = 60 * Math.PI / 180;

        // Calculate the hue
        if(delta == 0) {
            hue = 0;
        } else if(max == r) {
            hue = d60 * ((g - b) / delta % 6);
        } else if(max == g) {
            hue = d60 * ((b - r) / delta + 2);
        } else if(max == b) {
            hue = d60 * ((r - g) / delta + 4);
        } else {
            throw new Error("The code flow should not reach here.");
        }

        // Calculate the saturation
        if(max == 0) {
            saturation = 0;
        } else {
            saturation = delta / max;
        }

        value = max;
        return [hue, saturation, value];
    }

    public static fromHSV(hue: number, saturation: number, value: number) {
        // Normalize the input
        if(hue < 0) {
            hue *= 1;
            hue %= Math.PI * 2;
            hue *= -1;
            hue += Math.PI * 2;
        } else {
            hue %= Math.PI * 2;
        }

        if(saturation < 0) throw new Error("Saturation cannot be negative.");
        if(value < 0) throw new Error("Saturation cannot be negative.");

        saturation = Math.min(1, saturation);
        value = Math.min(1, value);

        const d60  = 60  * Math.PI / 180;
        const d120 = 120 * Math.PI / 180;
        const d180 = Math.PI;
        const d240 = 240 * Math.PI / 180;
        const d300 = 300 * Math.PI / 180;

        const c = value * saturation;
        const x = c * (1 - Math.abs(hue / d60 % 2) - 1);
        const m = value - c;

        var r = 0, g = 0, b = 0;

        // Calculate the colors.
        if(0 <= hue && hue < d60) {
            r = c;
            g = x;
        } else if(d60 <= hue && hue < d120) {
            r = x;
            g = c;
        } else if(d120 <= hue && hue < d180) {
            g = c;
            b = x;
        } else if(d180 <= hue && hue < d240) {
            g = x;
            b = c;
        } else if(d240 <= hue && hue < d300) {
            b = c;
            r = x;
        } else {
            b = x;
            r = c;
        }

        return KColor.fromNormalized(r + m, g + m, b + m);
    }
}

type KMap<O> = {
    [index: string]: O | null;
};

class AsciiColor {
    private static byCode: KMap<AsciiColor> = {};

    public static readonly black      = new AsciiColor('0', 30);
    public static readonly darkBlue   = new AsciiColor('1', 30);
    public static readonly darkGreen  = new AsciiColor('2', 32);
    public static readonly darkAqua   = new AsciiColor('3', 36);
    public static readonly darkRed    = new AsciiColor('4', 31);
    public static readonly darkPurple = new AsciiColor('5', 31);
    public static readonly gold       = new AsciiColor('6', 33);
    public static readonly gray       = new AsciiColor('7', 37);
    public static readonly darkGray   = new AsciiColor('8', 30, true);
    public static readonly blue       = new AsciiColor('9', 30, true);
    public static readonly green      = new AsciiColor('a', 32, true);
    public static readonly aqua       = new AsciiColor('b', 36, true);
    public static readonly red        = new AsciiColor('c', 31, true);
    public static readonly purple     = new AsciiColor('d', 31, true);
    public static readonly yellow     = new AsciiColor('e', 33, true);
    public static readonly white      = new AsciiColor('f', 37, true);

    public colorCode: string;
    public color: number;
    public isBright: boolean;

    private constructor(code: string, color: number, isBright: boolean = false) {
        this.colorCode = code;
        this.color = color | 0;
        this.isBright = isBright;

        if(!AsciiColor.byCode) AsciiColor.byCode = {};
        AsciiColor.byCode[code] = this;
    }

    public static of(c: string): AsciiColor {
        const result = AsciiColor.byCode[c];
        if(!result) {
            throw new Error(`Color of '${c}' is not defined.`);
        }
        return result;
    }

    public static fromTextColor(color: KTextColor): AsciiColor {
        const closest = color.toNearestPredefinedColor();
        const code = closest.toString().substring(1, 2);
        return AsciiColor.of(code);
    }

    public toAsciiCode(): string {
        const prefix = this.isBright ? '1;' : '';
        return `\u001b[${prefix}${this.color}m`;
    }

    public toMcCode(): string {
        return `\u00a7${this.colorCode.toLowerCase()}`;
    }
}

export class KTextColor {
    public static readonly COLOR_CHAR = '\u00a7';

    private static byChar: KMap<KTextColor> = {};
    private static byName: KMap<KTextColor> = {};

    public static readonly black      = new KTextColor('0', 'black',       new KColor(0));
    public static readonly darkBlue   = new KTextColor('1', 'dark_blue',   new KColor(0xaa));
    public static readonly darkGreen  = new KTextColor('2', 'dark_green',  new KColor(0xaa00));
    public static readonly darkAqua   = new KTextColor('3', 'dark_aqua',   new KColor(0xaaaa));
    public static readonly darkRed    = new KTextColor('4', 'dark_red',    new KColor(0xaa0000));
    public static readonly darkPurple = new KTextColor('5', 'dark_purple', new KColor(0xaa00aa));
    public static readonly gold       = new KTextColor('6', 'gold',        new KColor(0xffaa00));
    public static readonly gray       = new KTextColor('7', 'gray',        new KColor(0xaaaaaa));
    public static readonly darkGray   = new KTextColor('8', 'dark_gray',   new KColor(0x555555));
    public static readonly blue       = new KTextColor('9', 'blue',        new KColor(0x5555ff));
    public static readonly green      = new KTextColor('a', 'green',       new KColor(0x55ff55));
    public static readonly aqua       = new KTextColor('b', 'aqua',        new KColor(0x55ffff));
    public static readonly red        = new KTextColor('c', 'red',         new KColor(0xff5555));
    public static readonly purple     = new KTextColor('d', 'purple',      new KColor(0xff55ff));
    public static readonly yellow     = new KTextColor('e', 'yellow',      new KColor(0xffff55));
    public static readonly white      = new KTextColor('f', 'white',       new KColor(0xffffff));

    private name: string;
    private ordinal: number;
    private toStr: string;
    private color: KColor;

    private static count = 0;

    constructor(code: string, name: string, color: KColor) {
        this.name = name;
        this.toStr = KTextColor.COLOR_CHAR + code;
        this.ordinal = KTextColor.count++;
        this.color = color;

        KTextColor.byChar[code] = this;
        KTextColor.byName[name] = this;
    }

    public toString(): string {
        return this.toStr;
    }

    public static of(hex: number): KTextColor;
    public static of(color: KColor): KTextColor;
    public static of(name: string): KTextColor;
    public static of(name: string | KColor | number): KTextColor {
        if(typeof name == 'number') {
            name = new KColor(name);
        }

        if(name instanceof KColor) {
            name = '#' + name.getRGB().toString(16);
        }

        if(name == null) {
            throw new Error('The given argument cannot be null.');
        }

        if(name.startsWith('#') && name.length == 7) {
            const rgb = parseInt(name.substring(1), 16);
            if(isNaN(rgb)) {
                throw new Error('Illegal hex string ' + name);
            }

            var magic = KTextColor.COLOR_CHAR + 'x';
            name.substring(1).split('').forEach(c => {
                magic += KTextColor.COLOR_CHAR + c;
            });

            return new KTextColor(name, magic, new KColor(rgb));
        }

        const result = KTextColor.byName[name];
        if(result) {
            return result;
        }

        throw new Error('Could not parse KTextColor ' + name);
    }

    public toNearestPredefinedColor(): KTextColor {
        const c = this.toStr[1];
        if(c != 'x') return this;

        var closest: KTextColor | null = null;
        var cl = this.color;

        const defined = [
            KTextColor.black,
            KTextColor.darkBlue,
            KTextColor.darkGreen,
            KTextColor.darkAqua,
            KTextColor.darkRed,
            KTextColor.darkPurple,
            KTextColor.gold,
            KTextColor.gray,
            KTextColor.darkGray,
            KTextColor.blue,
            KTextColor.green,
            KTextColor.aqua,
            KTextColor.red,
            KTextColor.purple,
            KTextColor.yellow,
            KTextColor.white
        ];

        var smallestDiff = 0;
        defined.forEach(tc => {
            const rAverage = (tc.color.r + cl.r) / 2;
            const rDiff = tc.color.r - cl.r;
            const gDiff = tc.color.g - cl.g;
            const bDiff = tc.color.b - cl.b;

            const diff = ((2 + (rAverage >> 8)) * rDiff * rDiff)
                + (4 * gDiff * gDiff)
                + ((2 + ((255 - rAverage) >> 8)) * bDiff * bDiff);

            if(closest == null || diff < smallestDiff) {
                closest = tc;
                smallestDiff = diff;
            }
        });

        return closest!;
    }

    public static mcCodes(): string[] {
        return '0123456789abcdef'.split('');
    }

    public toAsciiCode(): string {
        return AsciiColor.fromTextColor(this).toAsciiCode();
    }
}

export abstract class KTextBase {
    public extra: KTextBase[] = [];
    public parent: KTextBase | null = null;
    public color: KTextColor | null = null;

    // Text attributes
    public isBold = false;
    public isItalic = false;
    public isObfuscated = false;
    public isUnderlined = false;
    public isStrikethrough = false;
    public isReset = false;

    public getParentColor(): KTextColor {
        if(!this.parent) return KTextColor.gray;
        return this.parent.color ?? this.parent.getParentColor();
    }

    public toAscii(): string {
        var extra = '';
        this.extra.forEach(e => {
            extra += e.toAscii() + (this.color ?? this.getParentColor()).toAsciiCode();
        });
        return extra;
    }

    public toPlainText(): string {
        var extra = '';
        this.extra.forEach(e => {
            extra += e.toPlainText();
        });
        return extra;
    }
}

export abstract class KText<S extends KText<S>> extends KTextBase {
    protected abstract resolveThis(): S;
    public abstract clone(): S;

    public addExtra(...texts: KTextBase[]): S {
        const t = this.resolveThis();
        texts.forEach(text => {
            this.extra.push(text);
            text.parent = t;
        });
        return t;
    }

    public setColor(color: KTextColor): S {
        const t = this.resolveThis();
        this.color = color;
        return t;
    }
}

export class LiteralText extends KText<LiteralText> {
    public text = "";

    public static of(text: string): LiteralText {
        const result = new LiteralText();
        result.text = text;
        return result;
    }

    protected resolveThis(): LiteralText {
        return this;
    }

    public clone(): LiteralText {
        const result = LiteralText.of(this.text);
        result.addExtra(...this.extra);
        return result;
    }

    public toAscii(): string {
        const extra = super.toAscii();
        const color = (this.color ?? this.getParentColor()).toAsciiCode();
        return color + this.text + extra;
    }

    public toPlainText(): string {
        const extra = super.toPlainText();
        var result = '';

        const b = this.text;
        for(var i=0; i<b.length; i++) {
            if(b[i] == KTextColor.COLOR_CHAR && KTextColor.mcCodes().includes(b[i + 1])) {
                i += 2;
            } else {
                result += b[i];
            }
        }

        return result + extra;
    }
}

export class TranslateText extends KText<TranslateText> {
    public translate = '';
    public with: KTextBase[] = [];

    public constructor(translate: string, ...texts: KTextBase[]) {
        super();
        this.translate = translate;
        texts.forEach(t => {
            this.with.push(t);
        });
    }

    public addWith(...texts: KTextBase[]): TranslateText {
        texts.forEach(t => {
            this.with.push(t);
        });
        return this;
    }

    public static of(format: string, ...texts: KTextBase[]): TranslateText {
        return new TranslateText(format, ...texts);
    }

    protected resolveThis(): TranslateText {
        return this;
    }

    public clone(): TranslateText {
        const result = TranslateText.of(this.translate, ...this.with);
        result.addExtra(...this.extra);
        return result;
    }
    
    private _format(fmt: string, ...obj: any[]): string {
        var offset = 0;
        var counter = 0;
        var matches = fmt.matchAll(/%(?:(?:(\d*?)\$)?)s/g);

        var m = matches.next();
        while(m.value != undefined) {
            const value = m.value;
            const c = (value[1] ?? ++counter) - 1;

            const val = obj[c].toString();
            fmt = fmt.substring(0, value.index + offset) + val + fmt.substring(value.index + offset + value[0].length);
            offset += val.length - value[0].length;
            m = matches.next();
        }

        return fmt;
    }

    public toAscii(): string {
        const extra = super.toAscii();
        const color = (this.color ?? this.getParentColor()).toAsciiCode();
        const withAscii = this.with.map(t => t.toAscii() + color);
        return color + this._format(this.translate, ...withAscii) + extra;
    }

    public toPlainText(): string {
        const extra = super.toPlainText();
        var result = '';

        const b = this.translate;
        for(var i=0; i<b.length; i++) {
            if(b[i] == KTextColor.COLOR_CHAR && KTextColor.mcCodes().includes(b[i + 1])) {
                i += 2;
            } else {
                result += b[i];
            }
        }

        const withPlain = this.with.map(t => t.toPlainText());
        return this._format(result, ...withPlain) + extra;
    }
}