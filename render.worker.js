importScripts('./pdf-lib.min.js');
importScripts('./fontkit.umd.min.js');

const { PDFDocument, rgb, StandardFonts, degrees } = PDFLib;

const MM_TO_PT = 72 / 25.4;
// 单页框架：左右页版框靠内一侧相对版心边线（版心为 0 时为中心线）额外内缩的距离
// = 框距 + frameOffset（外线中心到内线中心），使内框内沿再向内退 offset，与外侧对称
function getSingleFrameInset(config) {
    if (!config?.page?.singleFrame) return 0;
    const gap = Math.max(0, Number(config.page.singleFrameGap) || 0);
    return gap + (Number(config.page.frameOffset) || 0);
}
const BODY_VARIABLE_IDS = Object.freeze({
    title: 'a', book: 'b', author: 'c', tanghao: 'd', volume: 'e', vol_name: 'f',
    vol_num: 'g', vol: 'h', page_num: 'i', page: 'j', pageL: 'k', pageR: 'l'
});
const BODY_VARIABLE_NAMES = Object.freeze(Object.fromEntries(
    Object.entries(BODY_VARIABLE_IDS).map(([name, id]) => [id, name])
));
const mmToPt = (value, fallbackMm = 0) => {
    const n = Number(value);
    return (Number.isFinite(n) ? n : fallbackMm) * MM_TO_PT;
};

const PUNCT_RULES = {
    CORNER: /[，。、,\.．]/,
    ROTATE: /[（）《》「」『』【】〈〉［］｛｝〖〗〘〙〚〛—…\-\[\]\(\)\{\}<>_~～“”‘’"'＂＇]/,
    ROTATE_90: /[：；;:！？]/,
    CENTER: /[！？!\?·•‧]/,
    OPEN_BRACKETS: /[（《「『【〈［｛〖〘〚“‘\[\(\{<"']/,
    CLOSE_BRACKETS: /[）》」』】〉］｝〗〙〛”’\]\)\}>"']/,
    FORBIDDEN_START: /^[，。、！?？!\.,．:：;；·•‧”’"'＂＇）》」』】〉］｝〗〙〛\]\)\}>…—\-_~～]/
};

// 标点标准化开启时，普通正文只允许这组中文出版标点；ASCII 标点
// 因为同时承担排版语法含义，始终原样保留。私有区占位符也要留给后续解析。
const STANDARD_PUNCTUATION = new Set(Array.from('，。、；：！？（）〔〕【】「」『』《》〈〉——……·'));

/**
 * Worker 端字体 buffer 持久缓存（#1）。
 * 主线程在 fontsData.dict 里发送 { __ref: true, sig } 占位；Worker 用 sig 命中缓存，
 * 未命中则抛出 NEED_FONTS 让主线程补发真实 buffer，避免每次生成都克隆十几 MB 字体。
 */
class FontBufferStore {
    static buffers = new Map();   // sig -> buffer
    static parsed = new Map();    // sig -> fontkit font（#3）
    static bySig = new WeakMap(); // buffer -> sig
    static MAX = 24;

    static put(sig, buffer) {
        if (!sig || !buffer) return;
        if (this.buffers.has(sig)) this.buffers.delete(sig);
        this.buffers.set(sig, buffer);
        this.bySig.set(buffer, sig);
        while (this.buffers.size > this.MAX) {
            const oldest = this.buffers.keys().next().value;
            this.buffers.delete(oldest); this.parsed.delete(oldest);
        }
    }
    static get(sig) { return this.buffers.get(sig) || null; }

    /** 解析 dict 中的引用占位 / 带签名 buffer；返回缺失的 sig 列表 */
    static resolveDict(dict) {
        const missing = [];
        for (const [key, value] of Object.entries(dict || {})) {
            if (!value || typeof value !== 'object') continue;
            if (value.__ref) {
                const hit = this.get(value.sig);
                if (hit) dict[key] = hit; else missing.push({ key, sig: value.sig });
            } else if (value.__sig && (value.buffer instanceof ArrayBuffer || ArrayBuffer.isView(value.buffer))) {
                this.put(value.__sig, value.buffer);
                dict[key] = value.buffer;
            }
        }
        return missing;
    }

    static getParsed(buffer) {
        if (!buffer || !self.fontkit) return null;
        const sig = this.bySig.get(buffer);
        if (!sig) return null;
        if (!this.parsed.has(sig)) {
            try { this.parsed.set(sig, self.fontkit.create(Utils.getFontView(buffer))); } catch (e) { this.parsed.set(sig, null); }
        }
        return this.parsed.get(sig);
    }
}

class WorkerRuntime {
    static queue = Promise.resolve();
    static activeRequestId = null;

    static enqueue(envelope) {
        this.queue = this.queue.then(
            () => this.execute(envelope),
            () => this.execute(envelope)
        );
        return this.queue;
    }

    static async execute(envelope) {
        this.activeRequestId = envelope.requestId;
        try {
            await WorkerCommands.dispatch(envelope);
        } catch (error) {
            this.post('ERROR', { message: error?.message || String(error) });
        } finally {
            this.activeRequestId = null;
        }
    }

    static post(type, payload = {}, transferables = []) {
        self.postMessage(
            { requestId: this.activeRequestId, type, ...payload },
            transferables
        );
    }
}

class RenderJobContext {
    constructor({ domValues = {}, imagesData = {}, customStyles = {}, customCover = null, fonts = null } = {}) {
        this.domValues = domValues || {};
        this.images = imagesData || {};
        // 图片自定义别名 -> 真实 id（不区分大小写）
        this.imageAliasMap = {};
        Object.entries(this.images).forEach(([id, im]) => {
            const alias = im && typeof im.alias === 'string' ? im.alias.trim() : '';
            if (alias) this.imageAliasMap[alias.toLowerCase()] = id;
        });
        this.styles = customStyles || {};
        // 样式自定义名称 -> 数字 id 的映射（名称不区分大小写）
        this.styleNameMap = {};
        Object.entries(this.styles).forEach(([id, st]) => {
            const name = st && typeof st.name === 'string' ? st.name.trim() : '';
            if (name) this.styleNameMap[name.toLowerCase()] = id;
        });
        this.customCover = customCover;
        this.fonts = fonts;
        this.paragraphCache = new Map();
        this.punctMetricsCache = new Map();
        this.disposed = false;
    }

    getNumber(id, fallback = 0) {
        const value = Number.parseFloat(this.domValues[id]);
        return Number.isFinite(value) ? value : fallback;
    }

    getBoolean(id) {
        return !!this.domValues[id];
    }

    getString(id, fallback = '') {
        const value = this.domValues[id];
        return value === undefined || value === null ? fallback : String(value);
    }

    getTextStyle(styleId, config = null) {
        if (!styleId || styleId === 'undefined' || styleId === 'null') return null;
        const key = String(styleId).trim();
        // #7：同一任务内 config 固定，按 styleId 缓存解析结果
        if (!this._styleCache) this._styleCache = new Map();
        const cacheKey = key + '|' + (config ? config.fonts?.main?.size : '');
        if (this._styleCache.has(cacheKey)) return this._styleCache.get(cacheKey);
        const resolved = this._resolveTextStyle(key, config);
        this._styleCache.set(cacheKey, resolved);
        return resolved;
    }
    _resolveTextStyle(key, config) {
        let style = this.styles[key];
        if (!style) {
            const mappedId = this.styleNameMap?.[key.toLowerCase()];
            if (mappedId !== undefined) style = this.styles[mappedId];
        }
        if (!style) return null;

        const maxFontSize = style?.allowLarge ? Infinity : (config ? config.fonts.main.size * 1.5 : Infinity);
        const toNum = value => {
            if (value === '' || value === null || value === undefined) return null;
            const number = Number.parseFloat(value);
            return Number.isFinite(number) ? number : null;
        };
        const fontSize = toNum(style.fontSize);
        const hCharSpacing = toNum(style.hCharSpacing);
        return {
            color: style.color || '',
            fontName: style.fontName || '',
            fontSize: fontSize ? Math.min(Math.max(1, fontSize), maxFontSize) : null,
            charSpacing: toNum(style.charSpacing),
            // A non-positive multiplier cannot describe a usable horizontal
            // column distance; treat it as unset so it never inverts or
            // collapses a merged flow during rendering.
            hCharSpacing: hCharSpacing !== null && hCharSpacing > 0 ? hCharSpacing : null,
            horizontalAlign: ['left', 'center', 'right'].includes(style.horizontalAlign) ? style.horizontalAlign : 'center',
            verticalAlign: ['top', 'center', 'bottom'].includes(style.verticalAlign) ? style.verticalAlign : 'center'
        };
    }

    getImage(id) {
        const key = ImageManager.isUrlImageId(id) ? ImageManager.normalizeUrlImageId(id) : id;
        const direct = this.images[key];
        if (direct) return direct;
        const aliasId = this.imageAliasMap?.[String(key ?? '').trim().toLowerCase()];
        return aliasId !== undefined ? this.images[aliasId] : undefined;
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.paragraphCache.clear();
        this.punctMetricsCache.clear();
        this.domValues = {};
        this.images = {};
        this.imageAliasMap = {};
        this.styles = {};
        this.styleNameMap = {};
        this._styleCache = null;
        this.customCover = null;
        this.fonts = null;
    }
}

class Utils {
    static isLatinDigit = char => /[A-Za-z0-9]/.test(char);
    static _fontEncodeWrappers = new WeakSet();
    static _fontEncodeRecords = new Set();

    static getFontView(buffer) {
        if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
        if (ArrayBuffer.isView(buffer)) return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        return null;
    }

    static getProbeCharacters(text) {
        const source = String(text || '');
        const chars = [];
        const seen = new Set();
        const add = value => {
            for (const char of Array.from(value)) {
                if (!seen.has(char)) {
                    seen.add(char);
                    chars.push(char);
                }
            }
        };
        // Probe only source strings that can actually be rendered. The result
        // is a unique character list, so an unused character is never added
        // merely to make a font subset serializable.
        add(source);
        return chars;
    }

    /** Return a code point that the font can encode from the current document. */
    static findUsableGlyphInBuffer(buffer, text = '') {
        const bytes = this.getFontView(buffer);
        if (!bytes || !self.fontkit || typeof self.fontkit.create !== 'function') return undefined;
        try {
            // #3：优先复用缓存的解析结果，避免同一字体被 fontkit 解析两次
            const font = FontBufferStore.getParsed(buffer) || self.fontkit.create(bytes);
            if (!font || typeof font.hasGlyphForCodePoint !== 'function') return null;
            for (const char of this.getProbeCharacters(text)) {
                const codePoint = char.codePointAt(0);
                if (font.hasGlyphForCodePoint(codePoint)) return codePoint;
            }
        } catch (error) {
            // Let pdf-lib report a normal font parsing error and use its normal
            // fallback path; do not make font probing fatal.
            return undefined;
        }
        return null;
    }

    static _glyphCache = new WeakMap();
    /** #6：字形覆盖结果按字体+码点缓存 */
    static hasGlyph(font, codePoint) {
        if (!font || !Number.isFinite(codePoint)) return false;
        let cache = this._glyphCache.get(font);
        if (!cache) { cache = new Map(); this._glyphCache.set(font, cache); }
        const cached = cache.get(codePoint);
        if (cached !== undefined) return cached;
        const result = this._hasGlyphUncached(font, codePoint);
        cache.set(codePoint, result);
        return result;
    }
    static _hasGlyphUncached(font, codePoint) {
        try {
            const parsedFont = font.embedder?.font;
            if (parsedFont && typeof parsedFont.hasGlyphForCodePoint === 'function') {
                return parsedFont.hasGlyphForCodePoint(codePoint);
            }
            // Standard PDF fonts expose no fontkit coverage API. Their
            // encoder is the authoritative WinAnsi/Symbol coverage check.
            const encoding = font.embedder?.encoding;
            if (encoding && typeof encoding.canEncodeUnicodeCodePoint === 'function') {
                return encoding.canEncodeUnicodeCodePoint(codePoint);
            }
            if (typeof font.encodeText === 'function') {
                font.encodeText(String.fromCodePoint(codePoint));
                return true;
            }
            return false;
        } catch (error) {
            return false;
        }
    }

    static fontCoversText(font, value) {
        const text = String(value ?? '');
        if (!text) return true;
        for (const char of Array.from(text)) {
            if (!this.hasGlyph(font, char.codePointAt(0))) return false;
        }
        return true;
    }

    static primeFontSubset(font, text = '一') {
        if (!font || typeof font.encodeText !== 'function') return;
        try {
            // A subset containing only .notdef can crash fontkit's CFF writer.
            // Seed one glyph that this font actually supports. The glyph is
            // harmless if it is outside the rendered page range.
            const candidates = this.getProbeCharacters(text);
            for (const char of candidates) {
                if (this.hasGlyph(font, char.codePointAt(0))) {
                    font.encodeText(char);
                    return;
                }
            }
        } catch (error) {
            // Standard PDF fonts do not encode CJK; they remain valid fallbacks.
        }
    }

    static pickFallbackFont(primaryFont, requestedFallback, page, value = '') {
        const candidates = [];
        const add = candidate => {
            if (Array.isArray(candidate)) { candidate.forEach(add); return; }
            if (candidate && candidate !== primaryFont && !candidates.includes(candidate)) candidates.push(candidate);
        };
        // requestedFallback 可为单个字体或按优先级排列的字体数组（降级链）
        add(requestedFallback);
        add(page?.__fallbackFont);
        if (!candidates.length) return null;
        return candidates.find(candidate => this.fontCoversText(candidate, value)) || candidates[0];
    }

    /** 输出字体编码失败的具体字符，便于定位损坏字形或异常字体。 */
    static logFontEncodingFailure(font, value, error, stage = 'primary', encoder = null) {
        const text = String(value ?? '');
        const fontName = String(font?.name || font?.postscriptName || font?.family || '(embedded font)');
        const chars = Array.from(text);
        const badChars = [];
        const encode = encoder || font?.encodeText;
        if (typeof encode === 'function') {
            for (const ch of chars) {
                try {
                    encode.call(font, ch);
                } catch (charError) {
                    const codePoints = Array.from(ch)
                        .map(c => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
                        .join(' ');
                    badChars.push({ char: ch, codePoints, error: charError?.message || String(charError) });
                }
            }
        }
        const details = {
            stage,
            font: fontName,
            text: text.length > 120 ? `${text.slice(0, 120)}...` : text,
            error: error?.message || String(error),
            badChars
        };
        if (badChars.length) {
            console.warn('[字体编码失败] 检测到异常字符:', details);
        } else {
            console.warn('[字体编码失败] 未能定位单个异常字符，完整文本如下:', details);
        }
    }

    /**
     * 监控 fontkit 的底层编码调用。部分 RangeError 会在 PDFDocument.save()
     * 写入字体子集时才发生，无法由 page.drawText() 的 try/catch 捕获。
     */
    static instrumentFont(font, label = '') {
        if (!font || typeof font.encodeText !== 'function' || this._fontEncodeWrappers.has(font)) return font;
        const original = font.encodeText;
        const record = { font, label, encoder: original, values: [] };
        this._fontEncodeRecords.add(record);
        try {
            font.encodeText = function (value) {
                try {
                    if (record.values.length < 200) record.values.push(String(value ?? ''));
                    return original.call(this, value);
                } catch (error) {
                    Utils.logFontEncodingFailure(this, value, error, `encodeText${label ? `:${label}` : ''}`, original);
                    throw error;
                }
            };
            this._fontEncodeWrappers.add(font);
        } catch (error) {
            // 某些 PDF-lib 字体对象可能不可写，保持原行为即可。
        }
        return font;
    }

    /** 记录 doc 中每个已嵌入字体当前引用的子对象（DescendantFonts / FontDescriptor / FontFile / ToUnicode）。 */
    static collectFontSubObjectRefs(doc) {
        const { PDFName, PDFDict, PDFArray, PDFRef } = PDFLib;
        const out = [];
        try {
            for (const font of doc.fonts || []) {
                if (!font.modified) continue; // 未改动的字体不会被重嵌入
                const fontDict = doc.context.lookup(font.ref);
                if (!(fontDict instanceof PDFDict)) continue;
                const refs = [];
                const push = v => { if (v instanceof PDFRef) refs.push(v); };
                push(fontDict.get(PDFName.of('ToUnicode')));
                const desc = fontDict.get(PDFName.of('DescendantFonts'));
                const descArr = desc instanceof PDFRef ? doc.context.lookup(desc) : desc;
                push(desc);
                if (descArr instanceof PDFArray) {
                    for (let i = 0; i < descArr.size(); i++) {
                        const cidRef = descArr.get(i); push(cidRef);
                        const cid = cidRef instanceof PDFRef ? doc.context.lookup(cidRef) : cidRef;
                        if (!(cid instanceof PDFDict)) continue;
                        const fdRef = cid.get(PDFName.of('FontDescriptor')); push(fdRef);
                        const fd = fdRef instanceof PDFRef ? doc.context.lookup(fdRef) : fdRef;
                        if (fd instanceof PDFDict) ['FontFile', 'FontFile2', 'FontFile3'].forEach(k => push(fd.get(PDFName.of(k))));
                    }
                }
                if (refs.length) out.push({ font, refs });
            }
        } catch (e) { console.warn('[字体对象回收] 收集失败:', e?.message || e); }
        return out;
    }

    /** flush 之后，删除被重嵌入字体遗留下来的旧子对象（仅当字体字典已改指向新对象时）。 */
    static deleteStaleFontSubObjects(doc, stale) {
        const { PDFName, PDFDict, PDFRef } = PDFLib;
        try {
            for (const { font, refs } of stale) {
                const fontDict = doc.context.lookup(font.ref);
                if (!(fontDict instanceof PDFDict)) continue;
                const nowDesc = fontDict.get(PDFName.of('DescendantFonts'));
                if (nowDesc instanceof PDFRef && refs.some(r => r === nowDesc)) continue; // 未重嵌入，保留
                refs.forEach(r => doc.context.delete(r));
            }
        } catch (e) { console.warn('[字体对象回收] 删除失败:', e?.message || e); }
    }

    /** PDF 保存时字体子集序列化可能再次触发 fontkit 异常，此时输出此前的编码记录。 */
    static logDocumentSaveFontFailure(error) {
        const records = [...this._fontEncodeRecords].filter(record => record.values.length);
        if (!records.length) {
            console.warn('[字体编码失败] PDF 保存阶段发生异常，但没有可用的字体编码记录:', error?.message || String(error));
            return;
        }
        console.warn('[字体编码失败] PDF 保存/字体子集阶段异常，相关字体编码记录如下:', {
            error: error?.message || String(error),
            fonts: records.map(record => ({
                label: record.label || '(font)',
                values: record.values.slice(-40)
            }))
        });
        for (const record of records) {
            const lastValue = record.values[record.values.length - 1];
            this.logFontEncodingFailure(record.font, lastValue, error, `document.save:${record.label || 'font'}`, record.encoder);
        }
    }

    static hexToRgbPdf(hex) {
        if (!hex) hex = '#000000';
        hex = hex.replace('#', '');
        return rgb(parseInt(hex.substring(0, 2), 16) / 255, parseInt(hex.substring(2, 4), 16) / 255, parseInt(hex.substring(4, 6), 16) / 255);
    }


    static safeDrawText(page, text, options = {}, fallbackFont = null) {
        const value = String(text ?? '');
        if (!value || !page?.drawText) return false;
        let primaryFont = options.font || null;
        // #6 快速路径：主字体覆盖全部字符时直接绘制，不再枚举降级字体
        if (primaryFont && this.fontCoversText(primaryFont, value)) {
            try { page.drawText(value, options); return true; } catch (e) { /* 落入常规路径 */ }
        }
        const secondaryFont = this.pickFallbackFont(primaryFont, fallbackFont, page, value);
        const drawMissingGlyphBox = () => {
            try {
                const size = Math.max(2, Number(options.size) || 10);
                const x = Number.isFinite(Number(options.x)) ? Number(options.x) : 0;
                const y = Number.isFinite(Number(options.y)) ? Number(options.y) : 0;
                const color = options.color || rgb(0, 0, 0);
                page.drawRectangle({
                    x, y,
                    width: size * 0.82,
                    height: size * 0.82,
                    borderColor: color,
                    borderWidth: Math.max(0.35, size * 0.045),
                    opacity: options.opacity,
                    borderOpacity: options.opacity,
                    rotate: options.rotate
                });
                return true;
            } catch (boxError) {
                return false;
            }
        };

        if (!primaryFont && secondaryFont) {
            if (this.fontCoversText(secondaryFont, value)) {
                primaryFont = secondaryFont;
                options = { ...options, font: secondaryFont };
            } else {
                return drawMissingGlyphBox();
            }
        } else if (primaryFont && !this.fontCoversText(primaryFont, value)) {
            if (secondaryFont && secondaryFont !== primaryFont && this.fontCoversText(secondaryFont, value)) {
                primaryFont = secondaryFont;
                options = { ...options, font: secondaryFont };
            } else {
                return drawMissingGlyphBox();
            }
        }

        try {
            page.drawText(value, options);
            return true;
        } catch (primaryError) {
            this.logFontEncodingFailure(primaryFont, value, primaryError, 'primary');
            if (secondaryFont && secondaryFont !== primaryFont && this.fontCoversText(secondaryFont, value)) {
                try {
                    page.drawText(value, { ...options, font: secondaryFont });
                    return true;
                } catch (fallbackError) {
                    this.logFontEncodingFailure(secondaryFont, value, fallbackError, 'fallback');
                }
            }
            return drawMissingGlyphBox();
        }
    }

    /** Embed a font as a subset only when it contains at least one probed glyph. */
    static async embedSubsetFont(doc, buffer, probeText = '', label = '') {
        if (!doc || !buffer) return null;
        const seed = this.findUsableGlyphInBuffer(buffer, probeText);
        if (seed == null) return null;
        const font = await doc.embedFont(buffer, { subset: true });
        this.primeFontSubset(font, String.fromCodePoint(seed));
        this.instrumentFont(font, label);
        return font;
    }

    static toChineseNumeral(num) {
        if (num === 0) return '零';
        const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'], units = ['', '十', '百', '千', '万'];
        let str = num.toString(), res = '', zeroFlag = false;
        for (let i = 0; i < str.length; i++) {
            const n = parseInt(str[i], 10), unit = units[str.length - 1 - i];
            if (n === 0) zeroFlag = true;
            else {
                if (zeroFlag) { res += '零'; zeroFlag = false; }
                res += digits[n] + unit;
            }
        }
        return res.startsWith('一十') ? res.substring(1) : res;
    }
}

class EventBus {
    static emit(event, payload) {
        if (event === 'progress') {
            WorkerRuntime.post('PROGRESS', payload);
        }
    }
}

class ImageManager {
    static isUrlImageId(id) {
        const text = String(id || '').trim();
        if (!text) return false;
        if (text.startsWith(':')) return true;
        return /^(https?:|data:image\/|blob:|\/|\.\/|\.\.\/)/i.test(text);
    }
    static normalizeUrlImageId(id) {
        const text = String(id || '').trim();
        return text.startsWith(':') ? text.slice(1) : text;
    }
}

class TextParser {
    static processPunctuation(text, config) {
        if (config.format.noComma) {
            return text.replace(/(?![_〔〕|\\/$§@{}+\-&#!！=≈≡^%~`*\[\]︹︺<>\uE000-\uE0FF])[\p{P}\p{S}]/gu, '');
        }
        if (config.format.onlyPeriod) {
            const syntaxGuards = [];
            const guardSyntax = value => {
                const index = syntaxGuards.push(value) - 1;
                return `\uE0F0${index}\uE0F1`;
            };
            const protectSyntax = (pattern, replacer = null) => {
                text = text.replace(pattern, replacer || (match => guardSyntax(match)));
            };
            // These constructs are parsed later as layout syntax. Protect them
            // while filtering ordinary punctuation, then restore them verbatim.
            protectSyntax(/<STYLE:[^>]+>[\s\S]*?<\/STYLE:?>/gi);
            protectSyntax(/<IMG:[^>]*>/gi);
            protectSyntax(/\\[^\\]*\\/g);
            protectSyntax(/\|([^|]*)\|/g, (match, body) => `${guardSyntax('|')}${body}${guardSyntax('|')}`);
            protectSyntax(/>([^<>]*)</g, (match, body) => `${guardSyntax('>')}${body}${guardSyntax('<')}`);
            protectSyntax(/<([^<>]*)</g, (match, body) => `${guardSyntax('<')}${body}${guardSyntax('<')}`);
            protectSyntax(/>([^<>]*)>/g, (match, body) => `${guardSyntax('>')}${body}${guardSyntax('>')}`);
            protectSyntax(/\/([^/]*)\//g, (match, body) => `${guardSyntax('/')}${body}${guardSyntax('/')}`);
            protectSyntax(/(?:^|\n)[#$§&+\-:%~`*@^]+/g);
            protectSyntax(/[!！]?[+\-:]?[=≈≡]+&*[+\-:]?/g);

            const normalized = text
                .replace(/…+/g, '……')
                .replace(/—+/g, '——')
                .replace(/[・･]/g, '·');
            return Array.from(normalized).filter(char => {
                if (STANDARD_PUNCTUATION.has(char)) return true;
                // ASCII punctuation is deliberately kept verbatim: several
                // characters are also part of the layout markup grammar.
                if (/^[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]$/.test(char)) return true;
                if (/^[\p{L}\p{N}\p{M}\s]$/u.test(char)) return true;
                if (/^[\uE000-\uF8FF]$/.test(char)) return true;
                return false;
            }).join('').replace(/\uE0F0(\d+)\uE0F1/g, (match, index) => syntaxGuards[Number(index)] ?? match);
        }
        return text;
    }

    static parseInlineImageSpec(spec) {
        const tokens = String(spec || '').split(',').map(s => s.trim()).filter(Boolean);
        const idParts = [];
        const params = {};
        for (const token of tokens) {
            const match = token.match(/^([A-Z]{2})\s*:\s*(.+)$/i);
            if (match && ['PX', 'PY', 'PT', 'PB', 'PL', 'PR'].includes(match[1].toUpperCase())) {
                const val = parseFloat(match[2]);
                if (Number.isFinite(val)) params[match[1].toUpperCase()] = val;
            } else {
                idParts.push(token);
            }
        }
        return { id: idParts.join(',').trim(), params };
    }

    static parseOverlayImageSpec(spec) {
        const tokens = String(spec || '').split(',').map(s => s.trim()).filter(Boolean);
        const idParts = [];
        const params = {};
        for (const token of tokens) {
            const match = token.match(/^([XYLWHRTP])\s*:\s*(.+)$/i);
            if (match && idParts.length > 0) {
                params[match[1].toUpperCase()] = match[2].trim();
            } else {
                idParts.push(token);
            }
        }
        const id = idParts.join(',').trim();
        if (!id) return null;
        const num = key => {
            if (params[key] === undefined || params[key] === '') return null;
            const value = parseFloat(params[key]);
            return Number.isFinite(value) ? value : null;
        };
        return {
            id,
            x: num('X'),
            y: num('Y'),
            layer: num('L') === 1 ? 1 : 0,
            w: num('W'),
            h: num('H'),
            r: num('R') || 0,
            opacity: Math.max(0, Math.min(1, num('T') ?? 1)),
            page: num('P')
        };
    }

    static parseStyledChars(text, state) {
        let chars = [];
        let i = 0;
        while (i < text.length) {
            if (text.startsWith('\uE010', i)) { state.proper = true; i++; continue; }
            if (text.startsWith('\uE011', i)) { state.proper = false; i++; continue; }
            if (text.startsWith('\uE012', i)) { state.circ = true; i++; continue; }
            if (text.startsWith('\uE013', i)) { state.circ = false; i++; continue; }
            if (text.startsWith('\uE014', i)) { state.cornerCircle = true; i++; continue; }
            if (text.startsWith('\uE015', i)) { state.cornerCircle = false; i++; continue; }
            if (text.startsWith('\uE016', i)) { state.cornerDunhao = true; i++; continue; }
            if (text.startsWith('\uE017', i)) { state.cornerDunhao = false; i++; continue; }
            if (text.startsWith('\uE018', i)) { state.yinke = true; i++; continue; }
            if (text.startsWith('\uE019', i)) { state.yinke = false; i++; continue; }

            if (text.startsWith('\uE01A', i)) {
                let end = text.indexOf('\uE01B', i);
                if (end !== -1) { state.styleId = text.substring(i + 1, end); i = end + 1; continue; }
            }
            if (text.startsWith('\uE01C', i)) { state.styleId = null; i++; continue; }
            if (text.startsWith('\uE01D', i)) {
                chars.push({ c: '', isStyleLineBreak: true, circ: state.circ, isYinke: state.yinke, isProper: state.proper, styleId: state.styleId, isCornerCircle: state.cornerCircle, isCornerDunhao: state.cornerDunhao });
                i++;
                continue;
            }

            // 按码点取字：扩展区罕见字（U+10000 以上）为代理对，占 2 个 UTF-16 单元，
            // 若按下标逐单元切分会被拆成两个无效字符而显示两个方框。
            const cp = text.codePointAt(i);
            let c = String.fromCodePoint(cp);
            if (c === '{') c = '︹';
            if (c === '}') c = '︺';

            chars.push({
                c: c, circ: state.circ, isYinke: state.yinke, isProper: state.proper, styleId: state.styleId,
                isCornerCircle: state.cornerCircle, isCornerDunhao: state.cornerDunhao
            });
            i += c.length;
        }
        return chars;
    }

    static consumeControlPrefix(text, allowed = null) {
        const can = key => !allowed || allowed.has(key);
        const controls = {
            text,
            indentCount: 0,
            hangingIndentCount: 0,
            mergeCols: 0,
            align: 'top',
            alignChanged: false,
            isTitle: false,
            isHalfPage: false,
            halfRatio: 0,
            pageBreak: null,
            pageBreakCount: 0,
            pageBreaks: [],
            flowControls: []
        };

        while (controls.text.length > 0) {
            if (can('title') && controls.text.startsWith('#')) {
                controls.isTitle = true;
                controls.text = controls.text.slice(1).replace(/^\s*/, '');
            } else if (can('indent') && controls.text.startsWith('$') && !controls.text.startsWith('${')) {
                controls.indentCount++;
                controls.text = controls.text.slice(1);
            } else if (can('hanging') && controls.text.startsWith('§')) {
                controls.hangingIndentCount++;
                controls.text = controls.text.slice(1);
            } else if (can('merge') && controls.text.startsWith('&')) {
                controls.mergeCols++;
                controls.text = controls.text.slice(1);
            } else if (can('align') && controls.text.startsWith('+')) {
                controls.align = 'center';
                controls.alignChanged = true;
                controls.text = controls.text.slice(1);
            } else if (can('align') && controls.text.startsWith('-')) {
                controls.align = 'bottom';
                controls.alignChanged = true;
                controls.text = controls.text.slice(1);
            } else if (can('align') && controls.text.startsWith(':')) {
                controls.align = 'justify';
                controls.alignChanged = true;
                controls.text = controls.text.slice(1);
            } else if (can('pageBreak') && controls.text.startsWith('%')) {
                controls.pageBreakCount = controls.pageBreak === '%' ? controls.pageBreakCount + 1 : 1;
                controls.pageBreak = '%';
                controls.pageBreaks.push('%');
                controls.text = controls.text.slice(1);
            } else if (can('pageBreak') && controls.text.startsWith('~')) {
                controls.pageBreak = '~';
                controls.pageBreakCount = 1;
                controls.pageBreaks.push('~');
                controls.text = controls.text.slice(1);
            } else if (can('pageBreak') && controls.text.startsWith('`')) {
                controls.pageBreak = '`';
                controls.pageBreakCount = 1;
                controls.pageBreaks.push('`');
                controls.text = controls.text.slice(1);
            } else if (can('flowControl') && (controls.text.startsWith('@') || controls.text.startsWith('^'))) {
                controls.flowControls.push(controls.text[0]);
                controls.text = controls.text.slice(1);
            } else if (can('half') && controls.text.startsWith('*')) {
                controls.isHalfPage = true;
                controls.halfRatio++;
                controls.text = controls.text.slice(1);
            } else {
                break;
            }
        }
        return controls;
    }

    static parseVolumeOverrideLine(text) {
        const rawLine = String(text || '');
        const shortMatch = rawLine.match(/^\s*!([#]{1,2})([^!]*?)!\s*$/);
        if (shortMatch) {
            const value = shortMatch[2].trim();
            if (!value) throw new Error('卷名覆盖标记必须填写卷名');
            return {
                type: 'volume_override',
                scope: shortMatch[1] === '##' ? 'page' : 'chapter',
                text: value
            };
        }

        return null;
    }

    static parseCommentLine(text) {
        return /^\s*![^!]+!\s*$/.test(String(text || '')) ? { type: 'comment' } : null;
    }

    static stripInlineComments(text) {
        return String(text || '').replace(/\\[^\\]*\\|!(?![=≈≡])[^!\r\n]+!/g, match =>
            match.startsWith('\\') ? match : '');
    }

    static extractTitleVolume(text) {
        let value = String(text || '').trim();
        const wrappers = [
            /^\{([^{}]*)\}/,
            /^_([^_]*)_/,
            /^\(([^()]*)\)/,
            /^\[([^\]]*)\]/,
            /^\.([^.]*)\./,
            /^,([^,]*),/,
            /^\|([^|]*)\|/,
            /^>([^<>]*)</,
            /^<([^<>]*)</,
            /^>([^<>]*)>/,
            /^\/([^/]*)\//
        ];
        let hasWrapper = false;

        for (let depth = 0; depth < 8; depth++) {
            const match = wrappers.map(pattern => value.match(pattern)).find(Boolean);
            if (!match) break;
            hasWrapper = true;
            value = match[1].trim();
        }

        return hasWrapper ? value : value.replace(/[{}@^]/g, '');
    }

    static parseSinglePara(pText, config) {
        const volumeOverride = this.parseVolumeOverrideLine(pText);
        if (volumeOverride) {
            return {
                indentCount: 0, hangingIndentCount: 0, mergeCols: 0, align: 'top',
                pageBreak: null, isHalfPage: false, halfRatio: 1, halfLowerRatio: 1,
                runs: [volumeOverride]
            };
        }

        const comment = this.parseCommentLine(pText);
        if (comment) {
            return {
                indentCount: 0, hangingIndentCount: 0, mergeCols: 0, align: 'top',
                pageBreak: null, isHalfPage: false, halfRatio: 1, halfLowerRatio: 1,
                runs: [comment]
            };
        }

        let protectedItems = [];
        let sourceText = this.stripInlineComments(pText);

        sourceText = sourceText.replace(/\\([^\\]*)\\/g, (match, p1) => {
            protectedItems.push({ type: 'raw', text: p1 });
            return `\uE002${protectedItems.length - 1}\uE003`;
        });

        sourceText = sourceText.replace(
            /\$\{([A-Za-z][A-Za-z0-9_]*)\}/g,
            (match, name) => BODY_VARIABLE_IDS[name]
                ? `\uE006${BODY_VARIABLE_IDS[name]}\uE007`
                : match
        );

        sourceText = sourceText.replace(/<STYLE:([^>]+)>([\s\S]*?)<\/STYLE:?>/gi, (match, id, body) =>
            `<STYLE:${id}>${body.replace(/(?:\\n|\/n)/g, '\uE01D')}</STYLE>`);

        const sourceControls = this.consumeControlPrefix(sourceText);
        let text = sourceText;

        text = text.replace(/#([^#\r\n]*)#/g, (match, body) => {
            const chapterTitle = body.trim();
            if (!chapterTitle) return match;
            protectedItems.push({ type: 'chapter_marker', text: body, chapterTitle });
            return `\uE004${protectedItems.length - 1}\uE005`;
        });

        text = text.replace(/([^#$§&+\-:%~`*@^])#([^#\r\n]+)$/g, (match, prefix, body) => {
            const chapterTitle = body.trim();
            if (!chapterTitle) return match;
            protectedItems.push({ type: 'chapter_marker', text: body, chapterTitle });
            return prefix + `\uE004${protectedItems.length - 1}\uE005`;
        });

        text = text.replace(/@<IMG:([^>]+)>/gi, (match, id) => {
            const overlay = this.parseOverlayImageSpec(id);
            protectedItems.push({ type: 'overlay_image', overlay, text: id });
            return `\uE004${protectedItems.length - 1}\uE005`;
        });

        text = text.replace(/([`~*^]?)<IMG:([^>]+)>/gi, (match, prefix, spec) => {
            const imageMode = prefix === '`' ? 'full-blank' : prefix;
            const parsed = this.parseInlineImageSpec(spec);
            protectedItems.push({ type: 'image', prefix: imageMode, text: parsed.id, imgParams: parsed.params });
            return `\uE004${protectedItems.length - 1}\uE005`;
        });

        text = text.replace(/_([^_]*)_/g, '\uE010$1\uE011');
        text = text.replace(/\(([^)]*)\)/g, '\uE012$1\uE013');
        text = text.replace(/\.([^.]*)\./g, '\uE014$1\uE015');
        text = text.replace(/,([^,]*),/g, '\uE016$1\uE017');

        text = text.replace(/\[C(\d+)\]/gi, '\uE01A$1\uE01B');
        text = text.replace(/\[\/C\]/gi, '\uE01C');
        text = text.replace(/\[([^\]]*)\]/g, '\uE018$1\uE019');

        text = text.replace(/<STYLE:([^>]+)>/gi, '\uE01A$1\uE01B');
        text = text.replace(/<\/STYLE>/gi, '\uE01C');
        const punctuationGuards = [];
        const guardPunctuationMarker = value => {
            const index = punctuationGuards.push(value) - 1;
            return `\uE020${String.fromCharCode(0xE100 + index)}\uE021`;
        };
        const guardInlineMarkerDelimiters = (open, body, close) =>
            `${guardPunctuationMarker(open)}${body}${guardPunctuationMarker(close)}`;

        text = text.replace(/>([^<>]*)</g, (match, body) => guardInlineMarkerDelimiters('>', body, '<'));
        text = text.replace(/<([^<>]*)</g, (match, body) => guardInlineMarkerDelimiters('<', body, '<'));
        text = text.replace(/>([^<>]*)>/g, (match, body) => guardInlineMarkerDelimiters('>', body, '>'));
        text = text.replace(/;/g, () => guardPunctuationMarker(';'));
        text = text.replace(/^([#$§&+\-:%~`*]+)/, match =>
            [...match].map(char => char === ':' ? guardPunctuationMarker(':') : char).join(''));
        text = text.replace(/(\uE004\d+\uE005)([*+\-:]+)/g, (match, marker, controls) =>
            marker + [...controls].map(char => char === ':' ? guardPunctuationMarker(':') : char).join(''));
        text = text.replace(/([+\-:])(?=[=≈≡])|(?<=[=≈≡])([+\-:])/g, match =>
            match === ':' ? guardPunctuationMarker(':') : match);

        const parts = text.split(/(\uE002\d+\uE003|\uE004\d+\uE005|\uE006[a-z]\uE007)/);
        for (let i = 0; i < parts.length; i++) {
            if (!parts[i].startsWith('\uE002') && !parts[i].startsWith('\uE004') && !parts[i].startsWith('\uE006')) {
                if (config.format.onlyPeriod) parts[i] = parts[i].replace(/\d+/g, m => Utils.toChineseNumeral(parseInt(m, 10)));
                parts[i] = this.processPunctuation(parts[i], config);
            }
        }
        text = parts.join('');
        text = text.replace(/\uE020([\uE100-\uF8FF])\uE021/g, (match, guard) =>
            punctuationGuards[guard.charCodeAt(0) - 0xE100] ?? match);

        const controls = this.consumeControlPrefix(text);
        text = controls.text;
        if (controls.pageBreak === '%' && !text.trim()) text = '';
        let {
            indentCount,
            hangingIndentCount,
            mergeCols,
            align,
            isTitle,
            isHalfPage,
            halfRatio,
            pageBreak,
            pageBreakCount
        } = controls;
        let halfLowerRatio = 1;

        let runs = [], lastIdx = 0, match;
        const runRegex = /(\|[^|]*\||>[^<>]*<|<[^<>]*<|>[^<>]*>|\/[^/]*\/|[!！]?[+\-:]?[=≈≡]+&*[+\-:]?|-(?=[^\s])|;|\uE004\d+\uE005|\uE002\d+\uE003)/g;
        runRegex.lastIndex = 0;

        while ((match = runRegex.exec(text)) !== null) {
            if (match.index > lastIdx) runs.push({ type: isTitle ? 'title' : 'normal', text: text.substring(lastIdx, match.index) });
            const t = match[0];
            if (t.startsWith('|') && t.endsWith('|')) {
                const noteText = t.slice(1, -1);
                const hangingMatch = noteText.match(/^(§+)/);
                runs.push({
                    type: 'note',
                    text: hangingMatch ? noteText.slice(hangingMatch[1].length) : noteText,
                    hangingIndentCount: hangingMatch ? hangingMatch[1].length : 0
                });
            }
            else if (t.startsWith('>') && t.endsWith('<')) runs.push({ type: 'small_center', text: t.slice(1, -1) });
            else if (t.startsWith('<') && t.endsWith('<')) runs.push({ type: 'small_left', text: t.slice(1, -1) });
            else if (t.startsWith('>') && t.endsWith('>')) runs.push({ type: 'small_right', text: t.slice(1, -1) });
            else if (t.startsWith('/') && t.endsWith('/')) runs.push({ type: 'book_ear', text: t.slice(1, -1) });
            else if (t === ';') runs.push({ type: 'sep', text: '' });
            else if (t === '-') runs.push({ type: 'v_split', align: 'bottom', implicit: true, mergeCols: 0, autoHeight: false, balanceText: false, text: '' });
            else if (/[=≈≡]/.test(t) && !t.includes('\uE004') && !t.includes('\uE002')) {
                const hideLineBefore = /^[!！]/.test(t);
                const marker = hideLineBefore ? t.slice(1) : t;
                let markerMergeCols = (marker.match(/&/g) || []).length;
                let splitAlign = align;
                const alignMatch = marker.match(/([+\-:])?[=≈≡]+&*([+\-:])?/);
                if (alignMatch) {
                    const m = alignMatch[1] || alignMatch[2];
                    if (m === '+') splitAlign = 'center';
                    else if (m === '-') splitAlign = 'bottom';
                    else if (m === ':') splitAlign = 'justify';
                }

                const autoHeight = marker.includes('≈');
                const balanceText = marker.includes('≈') || marker.includes('≡');
                const splitWeight = Math.max(1, (marker.match(/=/g) || []).length);
                if (runs.length === 0 && match.index === 0) {
                    runs.push({ type: 'v_align_first', align: splitAlign, implicit: false, hideLineBefore, mergeCols: markerMergeCols, autoHeight, balanceText, splitWeight, text: '' });
                } else {
                    runs.push({ type: 'v_split', align: splitAlign, implicit: false, hideLineBefore, mergeCols: markerMergeCols, autoHeight, balanceText, splitWeight, text: '' });
                }
            }
            else if (t.startsWith('\uE004')) {
                let imgData = protectedItems[parseInt(t.slice(1, -1), 10)];
                if (imgData.type === 'overlay_image') runs.push({ type: 'overlay_image', text: imgData.text, overlay: imgData.overlay });
                else if (imgData.type === 'chapter_marker') runs.push({ type: 'chapter_marker', text: imgData.text, chapterTitle: imgData.chapterTitle, isRaw: true });
                else runs.push({ type: 'image', prefix: imgData.prefix, text: imgData.text, imgParams: imgData.imgParams });
            }
            else if (t.startsWith('\uE002')) {
                let rawData = protectedItems[parseInt(t.slice(1, -1), 10)];
                runs.push({ type: isTitle ? 'title' : 'normal', text: rawData.text, isRaw: true });
            }
            lastIdx = runRegex.lastIndex;
        }
        if (lastIdx < text.length) runs.push({ type: isTitle ? 'title' : 'normal', text: text.substring(lastIdx) });

        runs = runs.flatMap(run => {
            if (!['normal', 'title'].includes(run.type) || !/\uE006[a-z]\uE007/.test(String(run.text || ''))) return [run];
            return String(run.text).split(/(\uE006[a-z]\uE007)/).filter(part => part !== '').map(part => {
                const match = part.match(/^\uE006([a-z])\uE007$/);
                return match
                    ? { type: run.type, text: '', variableName: BODY_VARIABLE_NAMES[match[1]] || '' }
                    : { ...run, text: part };
            });
        });

        if (runs[0]?.type === 'image' && runs[0]?.prefix === '*') {
            isHalfPage = true;
            halfRatio++;
            for (let i = 1; i < runs.length; i++) {
                if (runs[i].type !== 'normal' && runs[i].type !== 'title') continue;
                const lowerControls = this.consumeControlPrefix(String(runs[i].text || ''), new Set(['half', 'align']));
                if (lowerControls.isHalfPage) halfLowerRatio = Math.max(1, lowerControls.halfRatio);
                if (lowerControls.alignChanged) align = lowerControls.align;
                runs[i].text = lowerControls.text;
                if (!runs[i].text) runs.splice(i, 1);
                break;
            }
        }

        if (controls.flowControls.length) {
            const firstTextRun = runs.find(run => run.type === 'normal' || run.type === 'title');
            if (firstTextRun) firstTextRun.leadingFlowControls = controls.flowControls;
            else runs.unshift({ type: 'flow_controls', text: controls.flowControls.join('') });
        }

        const titleVolume = isTitle ? this.extractTitleVolume(sourceControls.text) : null;

        const hasImplicitSplit = runs.some(run => run.type === 'v_split' && run.implicit);
        const hasExplicitSplit = runs.some(run => (run.type === 'v_split' || run.type === 'v_align_first') && !run.implicit);
        return { indentCount, hangingIndentCount, mergeCols, align, pageBreak, pageBreakCount, pageBreaks: controls.pageBreaks, titleVolume, isHalfPage, halfRatio: Math.max(1, halfRatio), halfLowerRatio, suppressSectionLines: hasImplicitSplit && !hasExplicitSplit, runs };
    }

    static tokenize(rawText, config, context) {
        // Keep literal \n and /n distinct until the surrounding paragraph is
        // known. In ordinary text they are paragraph returns; inside a split
        // table they are in-cell column breaks.
        const inlineBreakToken = '\uE01F';
        let cleanText = String(rawText ?? '')
            .replace(/\r\n?/g, '\n')
            .replace(/[\f\v\b\u200B\u200C\u200D\uFEFF]/g, '')
            .replace(/(?:\\n|\/n)/g, inlineBreakToken);
        cleanText = cleanText.replace(/<STYLE:([^>]+)>([\s\S]*?)<\/STYLE:?>/gi, (match, id, body) =>
            `<STYLE:${id}>${body.replace(new RegExp(`[\\n${inlineBreakToken}]`, 'g'), '\uE01D')}</STYLE>`);
        const hasGridSplitSyntax = text => /[!！]?[+\-:]?[=≈≡]+&*[+\-:]?/.test(text);
        const lines = cleanText.split('\n').flatMap(line => {
            if (!line.includes(inlineBreakToken)) return [line];
            // A split table is one paragraph. Its explicit line break changes
            // to the next vertical grid column while remaining in this cell.
            if (hasGridSplitSyntax(line)) return [line.replaceAll(inlineBreakToken, '\uE01D')];
            return line.split(inlineBreakToken);
        });

        const parsedParas = [];
        const paragraphCache = context?.paragraphCache || new Map();
        let blankLineRun = 0;
        let hasContent = false;
        const pushEmptyParagraph = () => parsedParas.push({
            indentCount: 0, hangingIndentCount: 0, mergeCols: 0, align: 'top',
            pageBreak: null, isHalfPage: false, halfRatio: 1, halfLowerRatio: 1,
            runs: [{ type: 'empty' }]
        });

        const configKey = `${config.format.noComma ? 1 : 0}_${config.format.onlyPeriod ? 1 : 0}`;
        const isPageBreakParagraph = para => !!para && (
            !!para.pageBreak ||
            para.pageBreaks?.length > 0 ||
            para.runs?.some(run => run.type === 'image' && (run.prefix === '~' || run.prefix === 'full-blank'))
        );
        let lastParsedPara = null;

        for (let i = 0; i < lines.length; i++) {
            let p = lines[i];

            if (!p.trim()) {
                blankLineRun++;
                continue;
            }

            if (hasContent) {
                const separatorLines = isPageBreakParagraph(lastParsedPara)
                    ? Math.max(0, blankLineRun - 1)
                    : blankLineRun;
                for (let blankIndex = 0; blankIndex < separatorLines; blankIndex++) {
                    pushEmptyParagraph();
                }
            } else {
                // Leading line breaks used to be discarded unconditionally.
                // Treat them exactly like separators: N line breaks create
                // N-1 empty paragraphs, so a single initial newline has no
                // visible effect while two initial newlines create one blank
                // column before the first paragraph.
                const leadingEmptyCount = Math.max(0, blankLineRun - 1);
                for (let blankIndex = 0; blankIndex < leadingEmptyCount; blankIndex++) {
                    pushEmptyParagraph();
                }
                blankLineRun = 0;
            }
            hasContent = true;

            const cacheKey = configKey + '_' + p;

            if (paragraphCache.has(cacheKey)) {
                lastParsedPara = paragraphCache.get(cacheKey);
            } else {
                const parsed = this.parseSinglePara(p, config);
                paragraphCache.set(cacheKey, parsed);
                lastParsedPara = parsed;
            }
            parsedParas.push(lastParsedPara);
            blankLineRun = 0;
        }

        if (hasContent) {
            const trailingSeparators = isPageBreakParagraph(lastParsedPara)
                ? Math.max(0, blankLineRun - 1)
                : blankLineRun;
            if (trailingSeparators > 1) {
                for (let i = 1; i < trailingSeparators; i++) pushEmptyParagraph();
            }
        }

        return parsedParas;
    }
}

class PageDesignRenderer {
    static parseExcludePages(str) {
        const set = new Set();
        if (!str || typeof str !== 'string') return set;
        str.split(/[,，\s]+/).forEach(token => {
            token = token.trim();
            if (!token) return;
            const rangeMatch = token.match(/^(\d+)\s*[-–]\s*(\d+)$/);
            if (rangeMatch) {
                const a = parseInt(rangeMatch[1], 10), b = parseInt(rangeMatch[2], 10);
                const lo = Math.min(a, b), hi = Math.max(a, b);
                for (let i = lo; i <= hi; i++) set.add(i);
            } else {
                const n = parseInt(token, 10);
                if (Number.isFinite(n)) set.add(n);
            }
        });
        return set;
    }

    static parseColorPdf(val, fallback = undefined) {
        if (!val || val === 'transparent') return fallback;
        if (val.startsWith('#')) return Utils.hexToRgbPdf(val);
        const m = String(val).match(/rgba?\(([^)]+)\)/i);
        if (m) {
            const p = m[1].split(',').map(v => parseFloat(v.trim()));
            if (p.length >= 3) {
                if (p.length >= 4 && p[3] === 0) return fallback;
                return rgb((p[0] || 0) / 255, (p[1] || 0) / 255, (p[2] || 0) / 255);
            }
        }
        return fallback;
    }

    static drawScaledTextGlyph(page, font, text, options) {
        const { x, y, size, color, opacity, blendMode, angle = 0, horizontalScale = 1 } = options;
        const fallbackFont = Utils.pickFallbackFont(font, options.fallbackFont, page, text)
            || options.fallbackFont
            || page?.__fallbackFont
            || null;
        if (font && !Utils.fontCoversText(font, text)) {
            return Utils.safeDrawText(page, text, {
                x, y, size, color, opacity, blendMode,
                rotate: PDFLib.degrees(angle),
                font: fallbackFont !== font ? fallbackFont : null 
            }, fallbackFont);
        }

        try {
            return this._drawScaledTextGlyphUnsafe(page, font, text, options);
        } catch (error) {
            return Utils.safeDrawText(page, text, {
                x, y, size, color, opacity, blendMode,
                rotate: PDFLib.degrees(angle),
                font: fallbackFont !== font ? fallbackFont : null
            }, fallbackFont);
        }
    }

    static _drawScaledTextGlyphUnsafe(page, font, text, options) {
        const { x, y, size, color, opacity, blendMode, angle = 0, horizontalScale = 1 } = options;
        if (!this._fontResourceKeys) this._fontResourceKeys = new WeakMap();
        let fontKeys = this._fontResourceKeys.get(page);
        if (!fontKeys) {
            fontKeys = new Map();
            this._fontResourceKeys.set(page, fontKeys);
        }
        let fontKey = fontKeys.get(font);
        if (!fontKey) {
            fontKey = page.node.newFontDictionary('Font', font.ref);
            fontKeys.set(font, fontKey);
        }

        const graphicsState = page.maybeEmbedGraphicsState({ opacity, blendMode });
        const stream = page.getContentStream();
        stream.push(
            PDFLib.pushGraphicsState(),
            ...(graphicsState ? [PDFLib.setGraphicsState(graphicsState)] : []),
            PDFLib.beginText(),
            PDFLib.setFillingColor(color),
            PDFLib.setFontAndSize(fontKey, size),
            PDFLib.setCharacterSqueeze(horizontalScale * 100),
            PDFLib.rotateAndSkewTextDegreesAndTranslate(angle, 0, 0, x, y),
            PDFLib.showText(font.encodeText(text)),
            PDFLib.endText(),
            PDFLib.popGraphicsState()
        );
    }

    static regularPolygonPoints(sides, w, h, startAngle = -90) {
        const cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2;
        const pts = [];
        for (let i = 0; i < sides; i++) {
            const a = (startAngle + i * 360 / sides) * Math.PI / 180;
            pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
        }
        return pts;
    }

    static starPoints(w, h, points = 5, innerRatio = 0.42) {
        const cx = w / 2, cy = h / 2;
        const outerX = w / 2, outerY = h / 2, innerX = outerX * innerRatio, innerY = outerY * innerRatio;
        const pts = [];
        for (let i = 0; i < points * 2; i++) {
            const outer = i % 2 === 0;
            const a = (-90 + i * 180 / points) * Math.PI / 180;
            pts.push({ x: cx + Math.cos(a) * (outer ? outerX : innerX), y: cy + Math.sin(a) * (outer ? outerY : innerY) });
        }
        return pts;
    }

    static shapePoints(kind, w, h, options = {}) {
        switch (kind) {
            case 'triangle': return [{ x: w / 2, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
            case 'diamond': return [{ x: w / 2, y: 0 }, { x: w, y: h / 2 }, { x: w / 2, y: h }, { x: 0, y: h / 2 }];
            case 'trapezoid': {
                const rawSlope = Number(options.shapeTrapezoidSlope);
                const slope = Math.min(0.48, Math.max(0, Number.isFinite(rawSlope) ? rawSlope : 0.22));
                return [{ x: w * slope, y: 0 }, { x: w * (1 - slope), y: 0 }, { x: w, y: h }, { x: 0, y: h }];
            }
            case 'polygon':
            case 'pentagon':
            case 'hexagon':
                return this.regularPolygonPoints(options.shapeSides || (kind === 'hexagon' ? 6 : 5), w, h);
            case 'star':
                return this.starPoints(w, h, options.shapeStarPoints || 5, options.shapeStarInnerRatio || 0.42);
            case 'arrow': {
                const headLen = options.shapeArrowLength ?? 0.38;
                const headWid = options.shapeArrowWidth ?? 1.0;
                const shaftThick = options.shapeArrowShaftThickness ?? 0.36;
                const headL = w * headLen;
                const shaftW = w - headL;
                const shaftT = h * shaftThick;
                const headW = h * headWid;
                return [
                    { x: 0, y: (h - shaftT) / 2 }, { x: shaftW, y: (h - shaftT) / 2 },
                    { x: shaftW, y: (h - headW) / 2 }, { x: w, y: h / 2 },
                    { x: shaftW, y: h - (h - headW) / 2 }, { x: shaftW, y: h - (h - shaftT) / 2 },
                    { x: 0, y: h - (h - shaftT) / 2 }
                ];
            }
            case 'rect':
            default: return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
        }
    }

    static buildSplitPageMap(pages, config, options = {}) {
        const map = [];
        const hasCover = config.cover && config.cover.mode !== 'none';
        const sourceStartPdfPage = Math.max(1, Math.trunc(Number(options.sourceStartPdfPage) || 1));
        const sourceTotalPdfPages = Math.max(
            sourceStartPdfPage + pages.length - 1,
            Math.trunc(Number(options.sourceTotalPdfPages) || 0),
            pages.length
        );
        const getMetrics = (page) => {
            const { width, height } = page.getSize();
            let singleW = Number(config.page.w);
            let centerW = Number(config.page.centerW ?? 0);
            if (!Number.isFinite(singleW) || singleW <= 0) singleW = width / 2;
            if (!Number.isFinite(centerW) || centerW < 0) centerW = 0;
            if (singleW * 2 + centerW > width + 1) {
                centerW = Math.max(0, width - singleW * 2);
                if (singleW * 2 > width + 1) singleW = width / 2;
            }
            const rightX = Math.min(width, singleW + centerW);
            return {
                height, leftX: 0, leftW: Math.max(1, Math.min(singleW, width)),
                rightX, rightW: Math.max(1, Math.min(singleW, width - rightX))
            };
        };
        pages.forEach((page, i) => {
            const m = getMetrics(page);
            const sourcePdfPage = sourceStartPdfPage + i;
            if (sourcePdfPage === 1 && hasCover) {
                map.push({ pageNumber: 1, pdfPageIndex: i, side: 'left', x: m.leftX, width: m.leftW, height: m.height });
            } else {
                const spreadIndex = hasCover ? sourcePdfPage - 2 : sourcePdfPage - 1;
                const rightPageNumber = hasCover ? spreadIndex * 2 + 2 : spreadIndex * 2 + 1;
                map.push({ pageNumber: rightPageNumber, pdfPageIndex: i, side: 'right', x: m.rightX, width: m.rightW, height: m.height });
                map.push({ pageNumber: rightPageNumber + 1, pdfPageIndex: i, side: 'left', x: m.leftX, width: m.leftW, height: m.height });
            }
        });
        if (hasCover && sourceStartPdfPage <= 1 && sourceStartPdfPage + pages.length > 1) {
            const coverLocalIndex = 1 - sourceStartPdfPage;
            const coverPage = pages[coverLocalIndex];
            const m = coverPage ? getMetrics(coverPage) : null;
            if (m) map.push({ pageNumber: sourceTotalPdfPages * 2, pdfPageIndex: coverLocalIndex, side: 'right', x: m.rightX, width: m.rightW, height: m.height });
        }
        return map;
    }

    static buildCenterCutSplitMap(pages, config) {
        const map = [];
        const hasCover = config.cover && config.cover.mode !== 'none';
        const getMetrics = (page) => {
            const { width, height } = page.getSize();
            const half = width / 2;
            return { height, leftX: 0, leftW: half, rightX: half, rightW: width - half };
        };
        pages.forEach((page, i) => {
            const m = getMetrics(page);
            if (i === 0 && hasCover) {
                map.push({ pageNumber: map.length + 1, pdfPageIndex: i, side: 'left', x: m.leftX, width: m.leftW, height: m.height });
            } else {
                map.push({ pageNumber: map.length + 1, pdfPageIndex: i, side: 'right', x: m.rightX, width: m.rightW, height: m.height });
                map.push({ pageNumber: map.length + 1, pdfPageIndex: i, side: 'left', x: m.leftX, width: m.leftW, height: m.height });
            }
        });
        if (hasCover && pages[0]) {
            const m = getMetrics(pages[0]);
            map.push({ pageNumber: map.length + 1, pdfPageIndex: 0, side: 'right', x: m.rightX, width: m.rightW, height: m.height });
        }
        return map;
    }

    static async embedDesignFonts(doc, fontsData) {
        const { dict: fontBufferDict, map: fontsMap } = fontsData;
        const probeText = String(fontsData.probeText || '');
        let fallbackFont = await doc.embedFont(StandardFonts.Helvetica);
        // Page designs are rendered in a second PDF pass, so give them the
        // same Chinese-capable fallback as the main renderer when available.
        const fallbackKey = fontsMap.fallbackF || 'defaultMainFont';
        const fallbackBuffer = fontBufferDict[fallbackKey];
        let fallbackSubsetEmbedded = false;
        if (fallbackBuffer) {
            try {
                const embedded = await Utils.embedSubsetFont(doc, fallbackBuffer, probeText, 'design-default');
                if (embedded) {
                    fallbackFont = embedded;
                    fallbackSubsetEmbedded = true;
                }
            } catch (error) {
                console.warn('页面设计中文字回退字体加载失败，继续使用 Helvetica:', error?.message || error);
            }
        }
        if (!fallbackSubsetEmbedded) {
            Utils.primeFontSubset(fallbackFont, probeText);
            Utils.instrumentFont(fallbackFont, 'design-default');
        }
        const fonts = { styleFonts: {}, _fallbackF: fallbackFont };
        for (const [sKey, fKey] of Object.entries(fontsMap.styleFonts || {})) {
            if (fKey && fontBufferDict[fKey]) {
                try {
                    const buffer = fontBufferDict[fKey];
                    const candidate = await Utils.embedSubsetFont(doc, buffer, probeText, `design:${sKey}`);
                    if (!candidate) {
                        fonts.styleFonts[sKey] = fallbackFont;
                        continue;
                    }
                    // 不能用正文字符探测字体覆盖率；缺字属于正常情况，应在绘制单字时回退。
                    fonts.styleFonts[sKey] = candidate;
                } catch (error) {
                    fonts.styleFonts[sKey] = fallbackFont;
                    console.warn('页面设计字体加载失败，已回退默认字体:', sKey, error?.message || error);
                }
            }
        }
        if (fontsMap.mainF && fontBufferDict[fontsMap.mainF]) {
            try {
                const buffer = fontBufferDict[fontsMap.mainF];
                const candidate = await Utils.embedSubsetFont(doc, buffer, probeText, 'design-main');
                if (!candidate) {
                    fonts.mainF = fallbackFont;
                    return fonts;
                }
                fonts.mainF = candidate;
            } catch (error) {
                fonts.mainF = fallbackFont;
                console.warn('页面设计默认字体加载失败，已回退 Helvetica:', error?.message || error);
            }
        } else {
            fonts.mainF = fallbackFont;
        }

        return fonts;
    }

    static async applyDesignsToDoc(doc, config, pageDesigns, fonts, imageCache, imagesData, layoutData, options = {}) {
        if (!pageDesigns || Object.keys(pageDesigns).length === 0) return;
        const pages = doc.getPages();
        const map = this.buildSplitPageMap(pages, config, options);
        const fallbackFont = fonts.mainF || fonts._fallbackF;
        const fontCache = fonts.styleFonts || {};

        // Semantic bindings use layout-side offsets so generated directory
        // pages cannot shift designs onto unrelated content.
        const hasCover = !!(config.cover && config.cover.mode !== 'none');
        const sourceStartPdfPage = Math.max(1, Math.trunc(Number(options.sourceStartPdfPage) || 1));
        const getLayoutSideIndex = info => {
            const sourcePdfPage = sourceStartPdfPage + info.pdfPageIndex;
            if (hasCover && sourcePdfPage === 1) return null;
            const spreadIndex = hasCover ? sourcePdfPage - 2 : sourcePdfPage - 1;
            return spreadIndex < 0 ? null : spreadIndex * 2 + (info.side === 'left' ? 1 : 0);
        };
        const rawBodyStartSide = layoutData?.bodyStartSide;
        const bodyStartSide = rawBodyStartSide === null || rawBodyStartSide === undefined
            ? null
            : Number(rawBodyStartSide);
        const rawTocStartSide = layoutData?.tocStartSide;
        const tocStartSide = rawTocStartSide === null || rawTocStartSide === undefined
            ? null
            : Number(rawTocStartSide);
        const boundDesigns = new Map();
        for (const design of Object.values(pageDesigns)) {
            const binding = design?.pageBinding;
            const startSide = binding?.kind === 'body-side'
                ? bodyStartSide
                : (binding?.kind === 'toc-side' ? tocStartSide : null);

            const sideOffset = Math.trunc(Number(binding.sideOffset));
            if (!Number.isFinite(sideOffset) || sideOffset < 0) continue;
            // 目录/牌记/刊署可插入正文中段，正文与目录的版面不再连续：
            // 优先用 sideIndices 按“第 k 个正文/目录面”解析，旧数据回退 startSide + offset。
            const sideIndices = binding?.kind === 'body-side'
                ? layoutData?.bodySideIndices
                : (binding?.kind === 'toc-side' ? layoutData?.tocSideIndices : null);
            const targetSide = Array.isArray(sideIndices) && Number.isFinite(sideIndices[sideOffset])
                ? sideIndices[sideOffset]
                : (Number.isFinite(startSide) ? startSide + sideOffset : NaN);
            if (!Number.isFinite(targetSide)) continue;
            const targetInfo = map.find(info => getLayoutSideIndex(info) === targetSide);
            if (!targetInfo) continue;
            const designs = boundDesigns.get(targetInfo.pageNumber) || [];
            designs.push({ design, sourceSide: binding.side || '' });
            boundDesigns.set(targetInfo.pageNumber, designs);
        }

        const masterLeft = pageDesigns['master-left']?.vectorObjects || [];
        const masterRight = pageDesigns['master-right']?.vectorObjects || [];
        const globalExclude = new Set([
            ...this.parseExcludePages(pageDesigns['master-left']?.excludePages),
            ...this.parseExcludePages(pageDesigns['master-right']?.excludePages)
        ]);

        for (const info of map) {
            const directDesign = pageDesigns[info.pageNumber];
            const pageDesign = directDesign?.pageBinding
                ? []
                : (directDesign?.vectorObjects || []);
            const boundPageDesign = (boundDesigns.get(info.pageNumber) || [])
                .flatMap(({ design, sourceSide }) => (design.vectorObjects || [])
                    .map(obj => design?.pageBinding?.coordinateSpace === 'content-frame-x-v1'
                        ? this.resolveDesignObjectFromContentFrame(obj, config, info.side, info.width)
                        : this.transformDesignObjectX(obj, config, sourceSide, info.side, info.width)));
            const isLeft = info.side === 'left';
            const activeMaster = isLeft ? masterLeft : masterRight;
            const masterForPage = globalExclude.has(info.pageNumber) ? [] : activeMaster;
            const combinedObjects = [...masterForPage, ...pageDesign, ...boundPageDesign];

            if (combinedObjects.length === 0) continue;

            const page = pages[info.pdfPageIndex];
            // 若 doc 已 save 过（同 doc 叠加设计的路径），旧内容流已被 pdf-lib 缓存编码，
            // 必须新开一个内容流，否则后续绘制会被静默丢弃。
            if (options.freshContentStream && typeof page.getContentStream === 'function') page.getContentStream(false);
            page.__fallbackFont = fonts._fallbackF || fallbackFont || null;
            for (const obj of combinedObjects) {
                const normalized = this.normalizeDesignObject(obj, info);
                await this.drawSingleVectorObject(page, doc, normalized, info, fallbackFont, fontCache, imageCache, imagesData, config, layoutData);
                this.addLinkAnnotation(page, doc, normalized, info);
            }
        }
    }

    static normalizeDesignObject(obj, info) {
        if (!obj || !info) return obj;
        const designWidth = Number(obj.designWidth);
        const designHeight = Number(obj.designHeight);
        if (!Number.isFinite(designWidth) || !Number.isFinite(designHeight) || designWidth <= 0 || designHeight <= 0) return obj;
        const sx = Number(info.width) / designWidth;
        const sy = Number(info.height) / designHeight;
        if (Math.abs(sx - 1) < 0.0001 && Math.abs(sy - 1) < 0.0001) return obj;

        const next = { ...obj };
        next.left = (Number(obj.left) || 0) * sx;
        next.top = (Number(obj.top) || 0) * sy;
        next.width = (Number(obj.width) || 0) * sx;
        next.height = (Number(obj.height) || 0) * sy;
        next.strokeWidth = (Number(obj.strokeWidth) || 0) * Math.sqrt(Math.abs(sx * sy));
        if (Array.isArray(obj.strokeDashArray)) {
            next.strokeDashArray = obj.strokeDashArray.map(value => (Number(value) || 0) * Math.sqrt(Math.abs(sx * sy)));
        }
        if (next.type === 'text' || next.type === 'i-text' || next.type === 'textbox' || next.type === 'vertical-textbox') {
            next.fontSize = (Number(obj.fontSize) || 0) * sy;
            next.charSpacing = (Number(obj.charSpacing) || 0) * sx;
        }
        if (next.type === 'circle') next.radius = (Number(obj.radius) || 0) * Math.min(sx, sy);
        if (next.type === 'ellipse') {
            next.rx = (Number(obj.rx) || 0) * sx;
            next.ry = (Number(obj.ry) || 0) * sy;
        }
        if (next.shapeBaseWidth != null) next.shapeBaseWidth = Number(obj.shapeBaseWidth || 0) * sx;
        if (next.shapeBaseHeight != null) next.shapeBaseHeight = Number(obj.shapeBaseHeight || 0) * sy;
        if (next.shapeCornerSize != null) next.shapeCornerSize = Number(obj.shapeCornerSize || 0) * Math.min(sx, sy);
        if (Array.isArray(obj.penPoints)) {
            next.penPoints = obj.penPoints.map(point => ({
                ...point,
                x: (Number(point.x) || 0) * sx,
                y: (Number(point.y) || 0) * sy,
                in: point.in ? { x: (Number(point.in.x) || 0) * sx, y: (Number(point.in.y) || 0) * sy } : null,
                out: point.out ? { x: (Number(point.out.x) || 0) * sx, y: (Number(point.out.y) || 0) * sy } : null
            }));
        }
        if (next.type === 'line') {
            next.x1 = (Number(obj.x1) || 0) * sx;
            next.x2 = (Number(obj.x2) || 0) * sx;
            next.y1 = (Number(obj.y1) || 0) * sy;
            next.y2 = (Number(obj.y2) || 0) * sy;
        }
        if (Array.isArray(obj.tableColWidths)) next.tableColWidths = obj.tableColWidths.map(value => (Number(value) || 0) * sx);
        if (Array.isArray(obj.tableRowHeights)) next.tableRowHeights = obj.tableRowHeights.map(value => (Number(value) || 0) * sy);
        if (Array.isArray(obj.tableCells)) {
            next.tableCells = obj.tableCells.map(row => Array.isArray(row) ? row.map(cell => {
                if (!cell) return cell;
                return {
                    ...cell,
                    fontSize: (Number(cell.fontSize) || 0) * sy,
                    charSpacing: (Number(cell.charSpacing) || 0) * sx,
                    strokeWidth: (Number(cell.strokeWidth) || 0) * Math.sqrt(Math.abs(sx * sy))
                };
            }) : row);
        }
        return next;
    }

     static getSideFrame(config, side, width) {
        const w = Math.max(1, Number(width) || Number(config?.page?.w) || 1);
        const marginL = Math.max(0, Number(config?.page?.margin?.l) || 0);
        const marginR = Math.max(0, Number(config?.page?.margin?.r) || 0);
        const left = side === 'left' ? marginL : 0;
        const right = side === 'left' ? w : w - marginR;
        return { left, right, width: Math.max(0.001, right - left) };
    }

    static resolveDesignObjectFromContentFrame(obj, config, side, targetWidth) {
        if (!obj || typeof obj !== 'object' || !side) return obj;
        const width = Math.max(1, Number(targetWidth) || Number(config?.page?.w) || 1);
        const frame = this.getSideFrame(config, side, width);
        return {
            ...obj,
            designWidth: width,
            left: frame.left + (Number(obj.left) || 0) * frame.width
        };
    }

    static transformDesignObjectX(obj, config, sourceSide, targetSide, targetWidth) {
        if (!obj || typeof obj !== 'object') return obj;
        if (!sourceSide || !targetSide || sourceSide === targetSide) return obj;
        const sourceWidth = Number(obj.designWidth) || Number(config?.page?.w) || 1;
        const sourceFrame = this.getSideFrame(config, sourceSide, sourceWidth);
        const targetFrame = this.getSideFrame(config, targetSide, targetWidth);
        const sx = targetFrame.width / sourceFrame.width;
        const tx = targetFrame.left - sourceFrame.left * sx;
        const width = Math.max(0, Number(obj.width) || 0);
        const origin = obj.originX === 'center' ? 0.5 : (obj.originX === 'right' ? 1 : 0);
        const visualLeft = (Number(obj.left) || 0) - width * origin;
        const next = { ...obj, designWidth: Number(targetWidth) || sourceWidth, left: visualLeft * sx + tx + width * sx * origin, width: width * sx };
        if (Array.isArray(obj.penPoints)) {
            next.penPoints = obj.penPoints.map(point => ({
                ...point,
                x: (Number(point.x) || 0) * sx,
                in: point.in ? { ...point.in, x: (Number(point.in.x) || 0) * sx } : null,
                out: point.out ? { ...point.out, x: (Number(point.out.x) || 0) * sx } : null
            }));
        }
        if (Array.isArray(obj.tableColWidths)) next.tableColWidths = obj.tableColWidths.map(value => (Number(value) || 0) * sx);
        return next;
    }

    static normalizeLinkUrl(value) {
        let url = String(value || '').trim();
        if (!url) return '';
        if (!/^[a-z][a-z\d+.-]*:/i.test(url)) url = `https://${url}`;
        try {
            const parsed = new URL(url);
            return ['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol) ? parsed.href : '';
        } catch (e) {
            return '';
        }
    }

    static addLinkAnnotation(page, pdfDoc, obj, info) {
        const url = this.normalizeLinkUrl(obj?.linkUrl);
        if (!url || !page || !pdfDoc || !obj) return;

        const width = Math.max(1, Number(obj.width) || 0);
        const height = Math.max(1, Number(obj.height) || 0);
        const angle = (Number(obj.angle) || 0) * Math.PI / 180;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        let anchorX = 0, anchorY = 0;
        if (obj.originX === 'center') anchorX = width / 2;
        else if (obj.originX === 'right') anchorX = width;
        if (obj.originY === 'center') anchorY = height / 2;
        else if (obj.originY === 'bottom') anchorY = height;

        const skewX = Math.tan((Number(obj.skewX) || 0) * Math.PI / 180);
        const skewY = Math.tan((Number(obj.skewY) || 0) * Math.PI / 180);
        const rawScaleX = Number(obj.scaleX), rawScaleY = Number(obj.scaleY);
        const scaleX = (obj.flipX ? -1 : 1) * (Number.isFinite(rawScaleX) ? rawScaleX : 1);
        const scaleY = (obj.flipY ? -1 : 1) * (Number.isFinite(rawScaleY) ? rawScaleY : 1);
        const corners = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }].map(point => {
            const dx = (point.x - anchorX) * scaleX;
            const dy = (point.y - anchorY) * scaleY;
            const sx = dx + dy * skewX;
            const sy = dy + dx * skewY;
            return {
                x: info.x + (Number(obj.left) || 0) + sx * cos - sy * sin,
                y: info.height - ((Number(obj.top) || 0) + sx * sin + sy * cos)
            };
        });
        const xs = corners.map(point => point.x), ys = corners.map(point => point.y);
        const left = Math.min(...xs), right = Math.max(...xs);
        const bottom = Math.min(...ys), top = Math.max(...ys);
        if (![left, right, bottom, top].every(Number.isFinite) || right <= left || top <= bottom) return;

        const { PDFName, PDFArray, PDFDict, PDFNumber, PDFString } = PDFLib;
        const context = pdfDoc.context;
        const rect = PDFArray.withContext(context);
        [left, bottom, right, top].forEach(value => rect.push(PDFNumber.of(value)));
        const border = PDFArray.withContext(context);
        [0, 0, 0].forEach(value => border.push(PDFNumber.of(value)));
        const action = PDFDict.withContext(context);
        action.set(PDFName.of('S'), PDFName.of('URI'));
        action.set(PDFName.of('URI'), PDFString.of(url));
        const annotation = PDFDict.withContext(context);
        annotation.set(PDFName.of('Type'), PDFName.of('Annot'));
        annotation.set(PDFName.of('Subtype'), PDFName.of('Link'));
        annotation.set(PDFName.of('Rect'), rect);
        annotation.set(PDFName.of('Border'), border);
        annotation.set(PDFName.of('A'), action);
        page.node.addAnnot(context.register(annotation));
    }

    static async drawSingleVectorObject(page, pdfDoc, obj, info, fallbackFont, fontCache, imageCache, imagesData, config, layoutData) {
        if (!obj || obj.opacity === 0) return;

        const opacity = obj.opacity ?? 1;
        const angle = obj.angle || 0;

        const _blendMap = {
            'multiply': PDFLib.BlendMode.Multiply, 'screen': PDFLib.BlendMode.Screen,
            'overlay': PDFLib.BlendMode.Overlay, 'darken': PDFLib.BlendMode.Darken,
            'lighten': PDFLib.BlendMode.Lighten, 'color-dodge': PDFLib.BlendMode.ColorDodge,
            'color-burn': PDFLib.BlendMode.ColorBurn, 'hard-light': PDFLib.BlendMode.HardLight,
            'soft-light': PDFLib.BlendMode.SoftLight, 'difference': PDFLib.BlendMode.Difference,
            'exclusion': PDFLib.BlendMode.Exclusion, 'hue': PDFLib.BlendMode.Hue,
            'saturation': PDFLib.BlendMode.Saturation, 'color': PDFLib.BlendMode.Color,
            'luminosity': PDFLib.BlendMode.Luminosity,
        };
        const blendMode = (obj.blendMode && obj.blendMode !== 'normal') ? _blendMap[obj.blendMode] : undefined;
        const strokeDashArray = Array.isArray(obj.strokeDashArray) && obj.strokeDashArray.length >= 2
            ? obj.strokeDashArray.map(value => Math.max(0, Number(value) || 0))
            : undefined;

        const getTransformedLocalPoint = (lx, ly) => {
            const w = obj.width || 0, h = obj.height || 0;
            let ax = 0, ay = 0;
            if (obj.originX === 'center') ax = w / 2;
            else if (obj.originX === 'right') ax = w;
            if (obj.originY === 'center') ay = h / 2;
            else if (obj.originY === 'bottom') ay = h;
            let dx = lx - ax, dy = ly - ay;
            dx *= (obj.flipX ? -1 : 1) * (obj.scaleX ?? 1);
            dy *= (obj.flipY ? -1 : 1) * (obj.scaleY ?? 1);
            const rSkewX = (obj.skewX || 0) * Math.PI / 180, rSkewY = (obj.skewY || 0) * Math.PI / 180;
            const sx = dx + dy * Math.tan(rSkewX), sy = dy + dx * Math.tan(rSkewY);
            const rAngle = angle * Math.PI / 180, cos = Math.cos(rAngle), sin = Math.sin(rAngle);
            const rx = sx * cos - sy * sin, ry = sx * sin + sy * cos;
            return { x: (obj.left || 0) + rx, y: (obj.top || 0) + ry };
        };

        const drawTransformedPath = (localPts, closed = true) => {
            let path = '';
            localPts.forEach((p, i) => {
                const tp = getTransformedLocalPoint(p.x, p.y);
                path += `${i === 0 ? 'M' : 'L'} ${(info.x + tp.x).toFixed(2)} ${tp.y.toFixed(2)} `;
            });
            if (closed) path += 'Z';
            const fill = this.parseColorPdf(obj.fill), stroke = this.parseColorPdf(obj.stroke);
            page.drawSvgPath(path, { x: 0, y: info.height, color: fill, borderColor: stroke, borderWidth: stroke ? (Number.isFinite(obj.strokeWidth) ? obj.strokeWidth : 1) : 0, borderDashArray: strokeDashArray, opacity, borderOpacity: opacity, blendMode });
        };

        if (obj.tableKind === 'table') {
            const colWidths = Array.isArray(obj.tableColWidths) ? obj.tableColWidths : [];
            const rowHeights = Array.isArray(obj.tableRowHeights) ? obj.tableRowHeights : [];
            const rows = Math.max(1, Number(obj.tableRows) || rowHeights.length || 1), cols = Math.max(1, Number(obj.tableCols) || colWidths.length || 1);
            const cells = Array.isArray(obj.tableCells) ? obj.tableCells : [];
            const defaults = obj.tableDefaultStyles || {};
            const spanSum = (arr, start, count, fallback) => { let sum = 0; for (let i = 0; i < count; i++) sum += Number(arr[start + i]) || fallback; return sum; };
            const offsetSum = (arr, count, fallback) => spanSum(arr, 0, count, fallback);

            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const cell = cells[r]?.[c];
                    if (!cell || cell.hidden) continue;

                    const x = offsetSum(colWidths, c, 72), y = offsetSum(rowHeights, r, 34);
                    const w = spanSum(colWidths, c, Math.max(1, Number(cell.colspan) || 1), 72);
                    const h = spanSum(rowHeights, r, Math.max(1, Number(cell.rowspan) || 1), 34);
                    const fill = this.parseColorPdf(cell.fill);
                    const stroke = this.parseColorPdf(cell.stroke || defaults.stroke || config.theme?.secondaryColor || '#A23722');
                    const strokeWidth = Number(cell.strokeWidth ?? defaults.strokeWidth ?? 0.8) || 0;

                    let path = '';
                    [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }].forEach((p, i) => {
                        const tp = getTransformedLocalPoint(p.x, p.y);
                        path += `${i === 0 ? 'M' : 'L'} ${(info.x + tp.x).toFixed(2)} ${tp.y.toFixed(2)} `;
                    });
                    path += 'Z';
                    page.drawSvgPath(path, { x: 0, y: info.height, color: fill, borderColor: stroke, borderWidth: stroke ? strokeWidth : 0, opacity, borderOpacity: opacity, blendMode });

                    const text = String(cell.text || '').replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, '');
                    if (!text) continue;

                    const fontSize = Number(cell.fontSize || defaults.fontSize) || 14;
                    const color = this.parseColorPdf(cell.textFill || defaults.textFill || config.theme?.primaryColor || '#1a1a1a', PDFLib.rgb(0, 0, 0));
                    let font = fallbackFont;
                    const family = String(cell.fontFamily || defaults.fontFamily || '').split(',')[0].replace(/["']/g, '').trim();
                    if (family && family !== 'SimSun' && family !== 'STSong' && family !== 'serif') {
                        font = fontCache[family] || fallbackFont;
                    }

                    const lines = text.split(/\r?\n/);
                    const fabricFontSizeMult = 1.13;
                    const lineHeight = fontSize * (Number(cell.lineHeight || defaults.lineHeight) || 1.16) * fabricFontSizeMult;
                    const charSpacing = (Number(cell.charSpacing ?? defaults.charSpacing ?? 0) || 0) / 1000 * fontSize;
                    const cellPadding = Math.min(8, Math.max(4, w * 0.08));
                    const placementLineHeight = fontSize * (Number(cell.lineHeight || defaults.lineHeight) || 1.16);
                    const textBlockH = lines.length > 0
                        ? lines.length * placementLineHeight
                        : 0;
                    const vAlign = cell.verticalAlign || defaults.verticalAlign || 'middle';
                    let textTop = y + Math.max(0, (h - textBlockH) / 2);
                    if (vAlign === 'top') textTop = y + 4;
                    if (vAlign === 'bottom') textTop = y + Math.max(0, h - textBlockH - 4);
                    const fabricBaselineOffset = fontSize * fabricFontSizeMult * (1 - 0.222);
                    let currentY = textTop + fabricBaselineOffset;

                    for (const line of lines) {
                        let textWidth = 0;
                        try { textWidth = font.widthOfTextAtSize(line, fontSize); } catch (e) { textWidth = line.length * fontSize; }
                        if (line.length > 1) textWidth += charSpacing * (line.length - 1);
                        let startX = x + cellPadding;
                        if (cell.textAlign === 'center') startX = x + (w - textWidth) / 2;
                        if (cell.textAlign === 'right') startX = x + w - textWidth - cellPadding;

                        let currentX = startX;
                        for (const char of line) {
                            let charWidth = fontSize;
                            try { charWidth = font.widthOfTextAtSize(char, fontSize); } catch (e) { }
                            const pt = getTransformedLocalPoint(currentX, currentY);
                            Utils.safeDrawText(page, char, { x: info.x + pt.x, y: info.height - pt.y, size: fontSize, font, color, opacity, blendMode, rotate: PDFLib.degrees(-angle) }, fallbackFont);
                            currentX += charWidth + charSpacing;
                        }
                        if (cell.underline) {
                            const p1 = getTransformedLocalPoint(startX, currentY + fontSize * 0.42), p2 = getTransformedLocalPoint(startX + textWidth, currentY + fontSize * 0.42);
                            page.drawLine({ start: { x: info.x + p1.x, y: info.height - p1.y }, end: { x: info.x + p2.x, y: info.height - p2.y }, thickness: Math.max(0.4, fontSize * 0.05), color, opacity });
                        }
                        currentY += lineHeight;
                    }
                }
            }
        } else if (obj.type.includes('text')) {
            let text = String(obj.text || '').replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, '');
            if (!text) return;

            if (text.includes('${')) {
                let spreadIdx = config.cover && config.cover.mode !== 'none' ? (info.pageNumber === 1 ? -1 : Math.floor((info.pageNumber - 2) / 2)) : Math.floor((info.pageNumber - 1) / 2);
                text = PDFRenderer.parseCenterContentTags(text, config, layoutData, spreadIdx, info.side === 'left' ? 'L' : 'R');
            }

            const fontSize = obj.fontSize || 24;
            const color = this.parseColorPdf(obj.fill, Utils.hexToRgbPdf(config.theme?.primaryColor || '#1a1a1a'));

            let font = fallbackFont;
            const family = String(obj.fontFamily || '').split(',')[0].replace(/["']/g, '').trim();
            if (family && family !== 'SimSun' && family !== 'STSong' && family !== 'serif') font = fontCache[family] || fallbackFont;

            const fabricFontSizeMult = 1.13;
            const lineHeight = (obj.lineHeight || 1.16) * fontSize * fabricFontSizeMult;
            const lines = text.split(/\r?\n/);
            const vw = obj.width || 0;
            const charSpacing = (Number(obj.charSpacing) || 0) / 1000 * fontSize;
            const scaleX = Math.max(0.001, Math.abs(Number(obj.scaleX ?? 1)));
            const scaleY = Math.max(0.001, Math.abs(Number(obj.scaleY ?? 1)));
            const scaledFontSize = fontSize * scaleY;
            const horizontalScale = scaleX / scaleY;
            const verticalCjkPattern = /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/;
            const fabricBaselineOffset = fontSize * fabricFontSizeMult * (1 - 0.222);
            let currentY = 0;
            for (const line of lines) {
                let lineX = 0;
                if (obj.textAlign === 'center' || obj.textAlign === 'right') {
                    let textWidth = 0;
                    try { textWidth = font.widthOfTextAtSize(line, fontSize); } catch (e) { textWidth = line.length * fontSize; }
                    if (line.length > 1) textWidth += charSpacing * (line.length - 1);
                    if (obj.textAlign === 'center') lineX = (vw - textWidth) / 2;
                    if (obj.textAlign === 'right') lineX = vw - textWidth;
                }

                let currentLeft = 0;
                const chars = Array.from(line);
                for (let i = 0; i < chars.length; i++) {
                    const char = chars[i];
                    let charWidth = fontSize;
                    try { charWidth = font.widthOfTextAtSize(char, fontSize); } catch (e) { }

                    const isVertical = obj.type === 'vertical-textbox';
                    const isUprightVerticalChar = isVertical && verticalCjkPattern.test(char);
                    let localX = lineX + currentLeft;
                    let localY = currentY + fabricBaselineOffset;
                    let glyphSize = scaledFontSize;
                    let glyphHorizontalScale = horizontalScale;
                    let glyphAngle = -angle;

                    if (isUprightVerticalChar) {
                        localX += charWidth / 2 + fontSize * 0.35;
                        localY += charWidth / 2 - fontSize * 0.35;
                        glyphSize = fontSize * scaleX;
                        glyphHorizontalScale = scaleY / scaleX;
                        glyphAngle = -(angle - 90);
                    }

                    const baseline = getTransformedLocalPoint(localX, localY);
                    this.drawScaledTextGlyph(page, font, char, {
                        x: info.x + baseline.x,
                        y: info.height - baseline.y,
                        size: glyphSize,
                        color,
                        opacity,
                        blendMode,
                        fallbackFont,
                        angle: glyphAngle,
                        horizontalScale: glyphHorizontalScale
                    });
                    currentLeft += charWidth + charSpacing;
                }
                currentY += lineHeight;
            }
        } else if (obj.type === 'rect') {
            const w = obj.width || 0, h = obj.height || 0;
            drawTransformedPath([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]);
        } else if (obj.type === 'line') {
            const w = obj.width || 0, h = obj.height || 0;
            const lx1 = (obj.x1 <= obj.x2) ? 0 : w, ly1 = (obj.y1 <= obj.y2) ? 0 : h;
            const lx2 = (obj.x1 <= obj.x2) ? w : 0, ly2 = (obj.y1 <= obj.y2) ? h : 0;
            drawTransformedPath([{ x: lx1, y: ly1 }, { x: lx2, y: ly2 }], false);
        } else if (obj.type === 'circle' || obj.type === 'ellipse') {
            const rx = obj.radius || obj.rx || (obj.width / 2) || 0, ry = obj.radius || obj.ry || (obj.height / 2) || 0;
            const sx = obj.scaleX ?? 1, sy = obj.scaleY ?? 1;
            const c = getTransformedLocalPoint(rx, ry);
            const fill = this.parseColorPdf(obj.fill), stroke = this.parseColorPdf(obj.stroke);
            page.drawEllipse({
                x: info.x + c.x, y: info.height - c.y,
                xScale: rx * sx * (obj.flipX ? -1 : 1), yScale: ry * sy * (obj.flipY ? -1 : 1),
                color: fill, borderColor: stroke, borderWidth: stroke ? (Number.isFinite(obj.strokeWidth) ? obj.strokeWidth : 1) : 0,
                borderDashArray: strokeDashArray, borderOpacity: opacity, opacity, blendMode, rotate: PDFLib.degrees(-(angle || 0))
            });
        } else if (obj.type === 'path' && obj.penPath && Array.isArray(obj.penPoints)) {
            const points = obj.penPoints;
            if (points.length < 2) return;
            const tp = point => {
                const transformed = getTransformedLocalPoint(point.x, point.y);
                return `${(info.x + transformed.x).toFixed(2)} ${transformed.y.toFixed(2)}`;
            };
            let path = `M ${tp(points[0])}`;
            const segments = [];
            for (let i = 1; i < points.length; i++) segments.push({ from: i - 1, to: i });
            if (obj.penClosed && points.length > 2) segments.push({ from: points.length - 1, to: 0 });
            segments.forEach(({ from, to }) => {
                const start = points[from], end = points[to];
                const hasCurve = start.out || end.in;
                if (hasCurve) {
                    path += ` C ${tp(start.out || start)} ${tp(end.in || end)} ${tp(end)}`;
                } else {
                    path += ` L ${tp(end)}`;
                }
            });
            if (obj.penClosed) path += ' Z';
            const fill = this.parseColorPdf(obj.fill), stroke = this.parseColorPdf(obj.stroke);
            page.drawSvgPath(path, {
                x: 0,
                y: info.height,
                color: fill,
                borderColor: stroke,
                borderWidth: stroke ? (Number.isFinite(obj.strokeWidth) ? obj.strokeWidth : 1) : 0,
                borderDashArray: strokeDashArray,
                opacity,
                borderOpacity: opacity,
                blendMode
            });
        } else if (obj.type === 'path' && obj.shapeKind) {
            const w = obj.shapeBaseWidth || obj.width || 0, h = obj.shapeBaseHeight || obj.height || 0;
            const pts = this.shapePoints(obj.shapeKind, w, h, obj);
            const style = obj.shapeCornerStyle || obj.cornerStyle || 'none';
            const size = Math.max(0, Number(obj.shapeCornerSize || obj.cornerSize) || 0);

            const tp = (p) => {
                const t = getTransformedLocalPoint(p.x, p.y);
                return `${(info.x + t.x).toFixed(2)} ${t.y.toFixed(2)}`;
            };

            let path = '';
            if (style === 'none' || size <= 0 || pts.length < 3) {
                path = pts.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${tp(p)}`).join(' ') + ' Z';
            } else {
                const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
                const along = (from, to, dist) => {
                    const len = Math.max(0.001, distance(from, to)), d = Math.min(dist, len * 0.45);
                    return { x: from.x + (to.x - from.x) * d / len, y: from.y + (to.y - from.y) * d / len };
                };
                pts.forEach((p, i) => {
                    const prev = pts[(i - 1 + pts.length) % pts.length], next = pts[(i + 1) % pts.length];
                    path += `${i === 0 ? 'M' : 'L'} ${tp(along(p, prev, size))} `;
                    path += style === 'round' ? `Q ${tp(p)} ${tp(along(p, next, size))} ` : `L ${tp(along(p, next, size))} `;
                });
                path += 'Z';
            }
            const fill = this.parseColorPdf(obj.fill), stroke = this.parseColorPdf(obj.stroke);
            page.drawSvgPath(path, { x: 0, y: info.height, color: fill, borderColor: stroke, borderWidth: stroke ? (Number.isFinite(obj.strokeWidth) ? obj.strokeWidth : 1) : 0, borderDashArray: strokeDashArray, opacity, borderOpacity: opacity, blendMode });
        } else if (obj.type === 'image') {
            try {
                let img = null;
                const imgKey = obj.imageId || obj.src;
                if (imgKey && imageCache[imgKey]) {
                    img = imageCache[imgKey];
                } else {
                    let bytes = null, isPng = false, mem = null;
                    if (obj.imageId) {
                        const rawId = String(obj.imageId).trim().startsWith(':') ? String(obj.imageId).trim().slice(1) : String(obj.imageId).trim();
                        mem = imagesData[rawId] || imagesData[obj.imageId];
                        if (!mem) {
                            const want = rawId.toLowerCase();
                            const hit = Object.values(imagesData).find(im => im && typeof im.alias === 'string' && im.alias.trim().toLowerCase() === want);
                            if (hit) mem = hit;
                        }
                    }
                    if (mem) { bytes = new Uint8Array(mem.bytes); isPng = mem.type && mem.type.includes('png'); }
                    if (bytes) {
                        img = isPng ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
                        if (imgKey) imageCache[imgKey] = img;
                    }
                }

                if (img) {
                    const w = obj.width || 0, h = obj.height || 0;
                    const drawW = w * (obj.scaleX ?? 1), drawH = h * (obj.scaleY ?? 1);
                    const pt = getTransformedLocalPoint(w / 2, h / 2);
                    const rRad = -angle * Math.PI / 180, dx = -drawW / 2, dy = -drawH / 2;
                    const offX = dx * Math.cos(rRad) - dy * Math.sin(rRad), offY = dx * Math.sin(rRad) + dy * Math.cos(rRad);

                    page.drawImage(img, {
                        x: info.x + pt.x + offX, y: info.height - pt.y + offY, width: drawW, height: drawH,
                        opacity, blendMode: blendMode || this.imageBlendMode(config), rotate: PDFLib.degrees(-angle)
                    });
                }
            } catch (e) {
                console.warn("Worker 渲染页面设计器图片失败", e);
            }
        }
    }
}

class LayoutEngine {
    constructor(config, context = null) {
        this.config = config;
        this.context = context || new RenderJobContext();
        const offset = config.page.frameOffset;
        let rawTop = config.page.margin.t + offset + config.page.padding.t, rawBottom = config.page.h - config.page.margin.b - offset - config.page.padding.b, availableH = rawBottom - rawTop;
        let deltaY = 0, F = config.fonts.main.size, spacing = (config.page.charSpacing - 1) * F, gridRows = 0;
        if (F > 0 && availableH >= F) {
            const requestedStep = Math.max(0.01, F + spacing);
            const N = Math.max(1, Math.floor((availableH + spacing + 0.001) / requestedStep));
            if (N > 1) spacing = (availableH - N * F) / (N - 1);
            else if (N === 1) deltaY = availableH - F;
            gridRows = N;
        }
        const cx = config.page.w;
        const sfInset = getSingleFrameInset(config);
        this.frame = {
            top: rawTop + deltaY / 2, bottom: rawBottom - deltaY / 2, mid: (rawTop + rawBottom) / 2,
            colWRight: (cx - config.page.margin.r - offset - sfInset) / config.page.cols,
            colWLeft: (cx - config.page.margin.l - offset - sfInset) / config.page.cols,
            colsPerSpread: config.page.cols * 2,
            rightBlockRightEdge: config.page.spreadW - config.page.margin.r - offset,
            leftBlockRightEdge: cx - sfInset
        };
        this.actualSpacing = spacing;
        this.gridRows = gridRows;
        this.gridCellHeight = F;
        this.gridStep = Math.max(0.01, F + this.actualSpacing);
        this.layoutTolerance = 0.5;
        this.halfSplitRatios = new Map();
        this.halfSplitWeights = new Map();

        // 牌记/刊署不再固定占据最前的版面：由排版计划（flowPlan.insertions）
        // 在指定的正文位置插入，见 allocateSpecialSide()。无插入计划时
        // （如正文探测排版）一切从第 0 面开始流动。
        this.cursor = { side: 0, colInSide: 0, layer: 'FULL', y: this.frame.top };
        this.output = {
            texts: [], lines: [], hLines: [], spreads: [], sides: {}, chapters: [], images: [], sideImages: {},
            merges: [], halfSides: new Set(), halfSplitRatios: {}, halfPageImages: [], overlayImages: [], frame: this.frame, paraStarts: [], pageBreaks: [], specialSides: {}, ears: {}, sideVolumes: {}, actualSpacing: this.actualSpacing, gridRows: this.gridRows, gridStep: this.gridStep,
            sideRegions: {},
            getColGeometry: (col) => this.getColGeometry(col)
        };
        this.currentVolume = '';
        this.currentVolumeNumber = 0;
        this.currentChapterStartSpread = null;
        this.currentChapterVolumeOverride = null;
        this.currentTocVolumeOverride = null;
        this.activeMerge = null;
    }

    getColGeometry(absoluteCol) {
        const colInSpread = absoluteCol % this.frame.colsPerSpread;
        const isRightSide = colInSpread < this.config.page.cols;
        const colW = isRightSide ? this.frame.colWRight : this.frame.colWLeft;
        const baseX = isRightSide
            ? this.frame.rightBlockRightEdge - (colInSpread + 1) * colW
            : this.frame.leftBlockRightEdge - (colInSpread - this.config.page.cols + 1) * colW;
        return { colW, baseX, isRightSide, colInSpread, spreadIdx: Math.floor(absoluteCol / this.frame.colsPerSpread) };
    }

    get absoluteCol() { return this.cursor.side * this.config.page.cols + this.cursor.colInSide; }
    setHalfSplitWeights(side, upperWeight = 1, lowerWeight = 1) {
        const upper = Math.max(0.001, Number(upperWeight) || 1);
        const lower = Math.max(0.001, Number(lowerWeight) || 1);
        const ratio = upper / lower;
        this.halfSplitWeights.set(side, { upper, lower });
        this.halfSplitRatios.set(side, ratio);
        this.output.halfSplitRatios[side] = ratio;
    }

    setHalfSplitRatio(side, ratio) {
        this.setHalfSplitWeights(side, ratio, 1);
    }

    setHalfLowerRatio(side, lowerWeight) {
        const current = this.halfSplitWeights.get(side) || { upper: 1, lower: 1 };
        this.setHalfSplitWeights(side, current.upper, lowerWeight);
    }

    getHalfSplitY(side = this.cursor.side) {
        const weights = this.halfSplitWeights.get(side) || { upper: 1, lower: 1 };
        return this.frame.top + (this.frame.bottom - this.frame.top) * weights.upper / (weights.upper + weights.lower);
    }

    getLayerTop() { return this.cursor.layer === 'LOWER' ? this.getHalfSplitY() : this.frame.top; }
    getLayerBottom() { return this.cursor.layer === 'UPPER' ? this.getHalfSplitY() : this.frame.bottom; }

    advanceCol() {
        this.cursor.colInSide++;
        if (this.cursor.colInSide >= this.config.page.cols) {
            this.cursor.colInSide = 0;
            if (this.cursor.layer === 'UPPER') this.cursor.layer = 'LOWER';
            else if (this.cursor.layer === 'LOWER') { this.cursor.side++; this.cursor.layer = 'FULL'; }
            else this.cursor.side++;
        }
        if (this.cursor.layer !== 'FULL') this.output.halfSides.add(this.cursor.side);
        this.cursor.y = this.getLayerTop();
        if (this.activeMerge) {
            this.activeMerge.usedCols++;
            if (this.activeMerge.usedCols > this.activeMerge.span) this.activeMerge = null;
        }
        this.ensureSideMeta();
    }

    ensureSideMeta(sideIdx = this.cursor.side) {
        if (!this.output.sideVolumes[sideIdx]) {
            this.output.sideVolumes[sideIdx] = {
                volume: this.currentVolume,
                volumeNumber: this.currentVolumeNumber
            };
        }
        const side = this.output.sideVolumes[sideIdx];
        if (this.currentTocVolumeOverride !== null && !Object.hasOwn(side, 'volumeOverride')) {
            side.volumeOverride = this.currentTocVolumeOverride;
            side.volumeOverrideScope = 'toc';
        } else if (this.currentChapterVolumeOverride !== null && !Object.hasOwn(side, 'volumeOverride')) {
            side.volumeOverride = this.currentChapterVolumeOverride;
            side.volumeOverrideScope = 'chapter';
        }
        return side;
    }

    clearSideChapterOverride(side, preserveTocOverride = false) {
        const scope = side?.volumeOverrideScope;
        if (scope !== 'chapter' && !(scope === 'toc' && !preserveTocOverride)) return;
        delete side.volumeOverride;
        side.volumeOverrideScope = 'cleared';
    }

    beginChapter(title, side = this.ensureSideMeta()) {
        this.currentVolume = title;
        this.currentVolumeNumber++;
        this.currentChapterVolumeOverride = null;
        this.currentChapterStartSpread = Math.floor(this.absoluteCol / this.frame.colsPerSpread);
        this.clearSideChapterOverride(side, this.currentTocVolumeOverride !== null);
        side.volume = this.currentVolume;
        side.volumeNumber = this.currentVolumeNumber;
        side.hasLocalVolumeDefinition = true;
        this.output.chapters.push({ title, col: this.absoluteCol });
        return side;
    }

    ensureSpreadMeta() {
        this.ensureSideMeta();
        const sIdx = Math.floor(this.absoluteCol / this.frame.colsPerSpread);
        if (!this.output.spreads[sIdx]) this.output.spreads[sIdx] = { volume: this.currentVolume };
        const spread = this.output.spreads[sIdx];
        if (this.currentChapterVolumeOverride !== null && !Object.hasOwn(spread, 'volumeOverride')) {
            spread.volumeOverride = this.currentChapterVolumeOverride;
            spread.volumeOverrideScope = 'chapter';
        }
        return sIdx;
    }

    applyVolumeOverride(run) {
        const spreadIdx = this.ensureSpreadMeta();
        const side = this.ensureSideMeta();
        const isRightSide = this.cursor.side % 2 === 0;
        if (run.scope === 'page') {
            side.volumeOverride = run.text;
            side.volumeOverrideScope = 'page';
            side.hasLocalVolumeDefinition = true;
            if (isRightSide) {
                this.output.spreads[spreadIdx].volumeOverride = run.text;
                this.output.spreads[spreadIdx].volumeOverrideScope = 'page';
            }
            return;
        }

        this.currentChapterVolumeOverride = run.text;
        side.volumeOverride = run.text;
        side.volumeOverrideScope = 'chapter';
        side.hasLocalVolumeDefinition = true;
        if (isRightSide) {
            this.output.spreads[spreadIdx].volumeOverride = run.text;
            this.output.spreads[spreadIdx].volumeOverrideScope = 'chapter';
        }
        this.currentVolumeNumber++;
        side.volumeNumber = this.currentVolumeNumber;
        this.output.chapters.push({ title: run.text, col: this.absoluteCol });
    }

    getPunctMetrics(char, fontSize, spaceScale = 1.0, font = null, spacingOverride = null) {
        const r = PUNCT_RULES, fmt = this.config.format;
        const pAdvRatio = this.config.page.punctAdvanceRatio;
        const sp = (spacingOverride !== null && spacingOverride !== undefined) ? spacingOverride : ((this.actualSpacing !== undefined) ? this.actualSpacing : this.config.page.charSpacing);
        const fontKey = font?.embedder?.font?.familyName || 'default';

        const punctMetricsCache = this.context.punctMetricsCache;
        // #9：先用轻量 key 查缓存，命中则跳过 6 个正则与后续计算
        const quickKey = `${char}_${fontSize}_${this.config.page.punctScale}_${pAdvRatio}_${spaceScale}_${sp}_${fmt.rotatePunct ? 1 : 0}_${fmt.rotateEn ? 1 : 0}_${fontKey}`;
        const quickHit = punctMetricsCache.get(quickKey);
        if (quickHit) return quickHit;
        const isCorner = r.CORNER.test(char), isRot = r.ROTATE.test(char) && fmt.rotatePunct,
            isRot90 = r.ROTATE_90.test(char) && fmt.rotatePunct, isCen = r.CENTER.test(char),
            isEnRot = Utils.isLatinDigit(char) && fmt.rotateEn, isQuote = /[“‘”’"']/.test(char),
            isBracket = r.OPEN_BRACKETS.test(char) || r.CLOSE_BRACKETS.test(char);
        // 缩放比例只作用于角标逗号/句号；普通标点保持原字号和占位。
        const rawPScale = Number(this.config.page.punctScale);
        const pScale = isCorner && Number.isFinite(rawPScale) && rawPScale > 0 ? rawPScale : 1;
        const cacheKey = `${char}_${fontSize}_${pScale}_${pAdvRatio}_${spaceScale}_${sp}_${fmt.rotatePunct ? 1 : 0}_${fmt.rotateEn ? 1 : 0}_${fontKey}`;
        if (punctMetricsCache.has(cacheKey)) {
            return punctMetricsCache.get(cacheKey);
        }

        let preY = 0, inkW = fontSize, inkH = fontSize, inkCX = fontSize / 2, inkCY = fontSize / 2;

        if (font && font.embedder && font.embedder.font) {
            try {
                const run = font.embedder.font.layout(char);
                if (run && run.glyphs && run.glyphs[0] && run.glyphs[0].bbox) {
                    const bbox = run.glyphs[0].bbox, scale = fontSize / (font.embedder.font.unitsPerEm || 1000);
                    inkW = (bbox.maxX - bbox.minX) * scale; inkH = (bbox.maxY - bbox.minY) * scale;
                    inkCX = (bbox.maxX + bbox.minX) / 2 * scale; inkCY = (bbox.maxY + bbox.minY) / 2 * scale;
                }
            } catch (e) { }
        }

        let originalInkAdvance;
        if (isCorner) { originalInkAdvance = fontSize * 0.35; }
        else if (isRot || isRot90 || isEnRot) { originalInkAdvance = Math.min(Math.max(inkW, fontSize * 0.1) + fontSize * 0.15, fontSize * 0.9); }
        else if (isQuote || isBracket || isCen) { originalInkAdvance = Math.min(Math.max(inkH, fontSize * 0.1) + fontSize * 0.15, fontSize * 0.9); }
        else { originalInkAdvance = fontSize; }

        const explicitCornerAdvanceRatio = (isCorner && Number.isFinite(pAdvRatio)) ? Math.max(0, pAdvRatio) : null;
        let advanceY;
        if (explicitCornerAdvanceRatio !== null) {
            advanceY = fontSize * explicitCornerAdvanceRatio;
        } else {
            advanceY = originalInkAdvance + sp * spaceScale;
        }

        inkW *= pScale; inkH *= pScale; inkCX *= pScale; inkCY *= pScale;
        let scaledInkAdvance = originalInkAdvance * pScale;
        let renderSize = fontSize * pScale;
        if (isCorner) renderSize *= 1.15;

        const result = {
            isCorner, isRot, isRot90, isEnRot, isCen, preY,
            advanceY, inkAdvance: scaledInkAdvance,
            inkW, inkH, inkCX, inkCY,
            offsetX: this.config.page.punctOffsetX, offsetY: this.config.page.punctOffsetY, renderSize,
            explicitCornerAdvanceRatio
        };

        if (punctMetricsCache.size >= 12000) {
            punctMetricsCache.clear();
        }
        punctMetricsCache.set(cacheKey, result);
        punctMetricsCache.set(quickKey, result);
        return result;
    }

    getBodyGridMetrics(metrics, breaksGrid = false) {
        const ratio = metrics.explicitCornerAdvanceRatio;
        if (ratio !== null && Math.abs(ratio) < 0.000001) {
            return {
                ...metrics,
                advanceY: 0,
                cellHeight: 0,
                breaksGrid: false,
                noGridAdvance: true
            };
        }
        if (breaksGrid || (ratio !== null && Math.abs(ratio - 1) > 0.000001)) {
            return {
                ...metrics,
                cellHeight: Math.max(metrics.inkH || 0, metrics.renderSize || this.gridCellHeight),
                breaksGrid: true
            };
        }
        return { ...metrics, advanceY: this.gridStep, cellHeight: this.gridCellHeight, breaksGrid: false };
    }

    hasForcedCornerAdvance() {
        const ratio = this.config.page.punctAdvanceRatio;
        return Number.isFinite(ratio) && Math.abs(ratio - 1) > 0.000001;
    }

    getCurrentParagraphIndentH() {
        const baseIndentH = this.currentIndentH || 0;
        const continuationIndentH = this.isParagraphFirstColumn === false
            ? (this.currentContinuationIndentH || 0)
            : 0;
        return baseIndentH + continuationIndentH;
    }

    // 把当前光标推进到一个新的整面起点（若已在面首则原地不动）。
    // 用于目录段落、插入的特殊页等必须独占整面的边界。
    ensureFreshSide() {
        const indentH = this.getCurrentParagraphIndentH();
        const isAtSideStart = (this.cursor.colInSide === 0 && this.cursor.y <= this.getLayerTop() + indentH + 1);
        if (!isAtSideStart || this.cursor.layer !== 'FULL') this.cursor.side++;
        this.cursor.colInSide = 0;
        this.cursor.layer = 'FULL';
        this.cursor.y = this.getLayerTop();
        this.ensureSideMeta();
    }

    // 分配一个特殊面（牌记/刊署），可出现在正文任意指定位置而非仅限最前。
    allocateSpecialSide(type) {
        const side = this.cursor.side;
        this.output.sides[side] = 'framed-blank';
        this.output.specialSides[side] = type;
        this.output.sideRegions[side] = 'special';
        this.cursor.side++;
        this.cursor.colInSide = 0;
        this.cursor.layer = 'FULL';
        this.cursor.y = this.getLayerTop();
        this.ensureSideMeta();
        return side;
    }

    markSideRegion(fromSide, toSide, region) {
        if (!region || !Number.isFinite(fromSide)) return;
        const last = Number.isFinite(toSide) ? toSide : fromSide;
        for (let s = Math.min(fromSide, last); s <= Math.max(fromSide, last); s++) {
            if (s < 0 || this.output.specialSides[s]) continue;
            this.output.sideRegions[s] = region;
        }
    }

    breakToNewSide(type, forceNextSide = false) {
        const indentH = this.getCurrentParagraphIndentH();
        const isAtSideStart = (this.cursor.colInSide === 0 && this.cursor.y <= this.getLayerTop() + indentH + 1);
        if (forceNextSide || !isAtSideStart) this.cursor.side++;
        let blankSide = null;
        if (type === '~' || type === 'full-blank') {
            this.output.sides[this.cursor.side] = type === '~' ? 'framed-blank' : 'full-blank';
            this.pendingBlankSide = this.cursor.side;
            blankSide = this.cursor.side;
            this.cursor.side++;
        }
        this.cursor.colInSide = 0;
        this.cursor.layer = 'FULL';
        this.cursor.y = this.getLayerTop() + indentH;
        this.ensureSideMeta();
        return blankSide;
    }

    calculate(parsedParas, previewRender = null, flowPlan = null) {
        // flowPlan：拼装后的段落流计划（目录可位于正文中间，牌记/刊署可插入任意位置）
        //   tocRange: { start, end } | null  —— 目录段落在 paras 数组中的区间
        //   insertions: Map<number, string[]> —— 在第 n 个段落前插入的特殊面 'paiji' | 'kanshu'
        //   bodyIndexOfPara: number[]        —— 每个段落对应的正文段落序号（<0 或缺省 = 非正文）
        // 兼容旧调用：第三个参数传数字表示“目录段落位于最前，共 n 段”。
        if (Number.isFinite(flowPlan)) {
            const n = Math.max(0, Math.trunc(Number(flowPlan) || 0));
            flowPlan = n > 0 ? { tocRange: { start: 0, end: n }, insertions: null, bodyIndexOfPara: null } : null;
        }
        const tocRange = flowPlan?.tocRange || null;
        const insertions = flowPlan?.insertions || null;
        const bodyIndexOfPara = flowPlan?.bodyIndexOfPara || null;
        const tocStartIdx = tocRange ? Math.max(0, Number(tocRange.start) || 0) : -1;
        const tocEndIdx = tocRange ? Math.max(tocStartIdx, Number(tocRange.end) || 0) : -1;
        const isTocParaIdx = idx => tocRange ? (idx >= tocStartIdx && idx < tocEndIdx) : false;
        const bodyIndexOf = idx => {
            if (bodyIndexOfPara) return Number.isFinite(bodyIndexOfPara[idx]) ? bodyIndexOfPara[idx] : -1;
            if (!tocRange) return idx;
            return idx >= tocEndIdx ? idx - tocEndIdx : -1;
        };
        const F = this.config.fonts.main.size;
        this.pendingBlankSide = null;
        let targetStopCol = Infinity;
        const styleState = { circ: false, yinke: false, proper: false, styleId: null, cornerCircle: false, cornerDunhao: false, gridBreakPending: false };
        let activeProperLine = null;
        const hiddenHLineSegments = [];

        const closeProperLine = () => {
            if (activeProperLine) {
                this.output.lines.push(activeProperLine);
                activeProperLine = null;
            }
        };

        const updateProperLine = (yStart, yEnd, col, sectionIdx, lineXOffset, textType, hCharSpacing, mergeRef, flowCenterX = null, lineOffsetFromCenter = 0) => {
            if (!activeProperLine || activeProperLine.col !== col || activeProperLine.lineXOffset !== lineXOffset || activeProperLine.flowCenterX !== flowCenterX) {
                closeProperLine();
                activeProperLine = { type: 'proper', col, startY: yStart, endY: yEnd, sectionIdx, lineXOffset, textType, hCharSpacing, mergeRef, flowCenterX, lineOffsetFromCenter };
            } else {
                activeProperLine.endY = yEnd;
            }
        };

        const splitParaIntoSections = (para) => {
            const sections = [{ align: para.align, mergeCols: 0, autoHeight: false, balanceText: false, splitWeight: 1, table: false, hideTopLine: false, runs: [] }];
            let idx = 0;
            for (const run of para.runs) {
                if (run.type === 'v_align_first') {
                    sections[idx].align = run.align || para.align;
                    sections[idx].mergeCols = run.mergeCols || 0;
                    sections[idx].autoHeight = !!run.autoHeight;
                    sections[idx].balanceText = !!run.balanceText;
                    sections[idx].splitWeight = Math.max(1, Number(run.splitWeight) || 1);
                    sections[idx].table = true;
                    sections[idx].hideTopLine = !!run.hideLineBefore;
                } else if (run.type === 'v_split') {
                    sections.push({ align: run.align || para.align, mergeCols: run.mergeCols || 0, autoHeight: !!run.autoHeight, balanceText: !!run.balanceText, splitWeight: Math.max(1, Number(run.splitWeight) || 1), table: true, hideTopLine: !!run.hideLineBefore, runs: [] });
                    idx = sections.length - 1;
                } else {
                    sections[idx].runs.push(run);
                }
            }
            return sections;
        };

        const resolveBodyVariable = (name, predictNextColumn = false) => {
            const currentSideIdx = this.cursor.side;
            const sideIdx = currentSideIdx + (
                predictNextColumn && this.cursor.y + F > this.getLayerBottom() + this.layoutTolerance ? 1 : 0
            );
            const spreadIdx = Math.floor(sideIdx / 2);
            const side = sideIdx === currentSideIdx
                ? this.ensureSideMeta()
                : (this.output.sideVolumes[sideIdx] || { volume: this.currentVolume, volumeNumber: this.currentVolumeNumber });
            const spread = this.output.spreads[spreadIdx] || {};
            const sourceVolume = side?.volume ?? this.currentVolume ?? '';
            const displayVolume = side && Object.hasOwn(side, 'volumeOverride')
                ? side.volumeOverride
                : (side?.volumeOverrideScope === 'cleared'
                    ? sourceVolume
                    : (Object.hasOwn(spread, 'volumeOverride') ? spread.volumeOverride : sourceVolume));
            const pageRNumber = PDFRenderer.getAdjustedPageNumber(spreadIdx * 2 + 1, this.config);
            const pageLNumber = PDFRenderer.getAdjustedPageNumber(spreadIdx * 2 + 2, this.config);
            const pageSingleNumber = PDFRenderer.getAdjustedPageNumber(spreadIdx + 1, this.config);
            const pageNumber = this.config.page.outerPage
                ? (sideIdx % 2 === 0 ? pageRNumber : pageLNumber)
                : pageSingleNumber;
            const volumeNumber = Number.isFinite(side?.volumeNumber) && side.volumeNumber > 0
                ? side.volumeNumber
                : (this.currentVolumeNumber > 0 ? this.currentVolumeNumber : null);
            const vars = {
                title: this.config.book.title || '',
                book: this.config.book.title || '',
                author: this.config.book.author || '',
                tanghao: this.config.book.tanghao || '',
                volume: displayVolume,
                vol_name: displayVolume,
                vol_num: volumeNumber === null ? '' : String(volumeNumber),
                vol: volumeNumber === null ? '' : Utils.toChineseNumeral(volumeNumber),
                page_num: pageNumber === null ? '' : String(pageNumber),
                page: pageNumber === null ? '' : Utils.toChineseNumeral(pageNumber),
                pageL: pageLNumber === null ? '' : Utils.toChineseNumeral(pageLNumber),
                pageR: pageRNumber === null ? '' : Utils.toChineseNumeral(pageRNumber)
            };
            return Object.hasOwn(vars, name) ? String(vars[name] ?? '') : `\${${name}}`;
        };
        const resolveBodyVariables = text => String(text || '').replace(
            /\uE006([a-z])\uE007|\$\{([A-Za-z][A-Za-z0-9_]*)\}/g,
            (match, id, name) => resolveBodyVariable(BODY_VARIABLE_NAMES[id] || name || '')
        );

        const isZeroAdvancePunctuation = char => {
            const rawRatio = this.config.page.punctAdvanceRatio;
            if (rawRatio === null || rawRatio === undefined || rawRatio === '') return false;
            const ratio = Number(rawRatio);
            return PUNCT_RULES.CORNER.test(String(char || '')) && Number.isFinite(ratio) && Math.abs(ratio) < 0.000001;
        };

        const countLayoutChars = (run, fontSize) => {
            if (!run) return 0;
            const runText = run.variableName ? resolveBodyVariable(run.variableName) : resolveBodyVariables(run.text);
            if (!runText) return 0;
            if (run.type === 'image' || run.type === 'overlay_image') return 0;
            if (run.type === 'note') return Math.ceil(runText.length / 2);
            if (run.type && run.type.startsWith('small_')) return runText.length;
            let count = 0;
            for (const ch of runText) {
                if (ch === '\uE01D') continue;
                if (isZeroAdvancePunctuation(ch)) continue;
                if (ch === ' ' || ch === '\t') count += 0.5;
                else if (ch === '　' || ch === '@' || ch === '$') count += 1;
                else count++;
            }
            return count;
        };

        const getLayoutUnit = (char) => {
            if (isZeroAdvancePunctuation(char)) return 0;
            if (char === ' ' || char === '\t') return 0.5;
            if (char === '　' || char === '@' || char === '$') return 1;
            return 1;
        };

        const getItemStyle = (item) => this.context.getTextStyle(item?.styleId, this.config) || null;
        const getStyledSize = (item, fallbackSize) => {
            const style = getItemStyle(item);
            return style?.fontSize || fallbackSize;
        };
        const getStyledSpacing = (item, fallbackSpacing) => {
            const style = getItemStyle(item);
            if (!style) return fallbackSpacing;
            // Styled text has its own vertical rhythm.  When no explicit
            // vertical multiplier is configured, the default is 1x the
            // effective glyph size (zero extra spacing), rather than the
            // body grid's advance based on the main font size.
            return style.charSpacing !== null && style.charSpacing !== undefined
                ? (style.charSpacing - 1) * (style.fontSize || F)
                : 0;
        };
        // Vertical and horizontal style spacing serve different layout
        // systems. `charSpacing` changes the vertical advance of glyphs;
        // `hCharSpacing` is only consumed by horizontal arrangements (merged
        // style flows and double-column small notes). A horizontal value must
        // never make ordinary body text leave the grid.
        // Every styled glyph uses its own vertical advance.  Explicit
        // charSpacing changes that advance; an omitted value means the
        // default multiplier 1 (one effective font size).
        const hasVerticalStyleSpacing = style => !!style;
        const hasHorizontalStyleSpacing = style => style && (
            style.hCharSpacing !== null && style.hCharSpacing !== undefined
        );
        const getStyledFont = (item, fallbackFont) => {
            const style = getItemStyle(item);
            return style?.fontName && this.config.fontsObj?.styleFonts?.[style.fontName] ? this.config.fontsObj.styleFonts[style.fontName] : fallbackFont;
        };
        const applyTextStyle = (obj, item) => {
            obj.styleId = item?.styleId || null;
            return obj;
        };

        const makeBalancedQuotas = (total, span) => {
            const quotas = [];
            let remaining = Math.max(0, total);
            for (let i = 0; i < span; i++) {
                const q = Math.ceil(remaining / Math.max(1, span - i));
                quotas.push(q);
                remaining -= q;
            }
            return quotas;
        };

        let tableSpanForCurrentParagraph = 1;
        const getExplicitSectionSpan = (section, para, baseCol = this.absoluteCol) => {
            const sideRemaining = this.config.page.cols - (baseCol % this.config.page.cols);
            if (section.mergeCols > 0) return Math.min(sideRemaining, section.mergeCols + 1);
            if (para.mergeCols > 0) return Math.min(sideRemaining, para.mergeCols + 1);
            return 1;
        };
        const getSectionSpan = (section, para, baseCol = this.absoluteCol) => {
            const explicitSpan = getExplicitSectionSpan(section, para, baseCol);
            // A row without an & marker belongs to the same table width as a
            // sibling merged row. It is still drawn as individual cells, but
            // text may continue through those cells before it is clipped.
            if (explicitSpan > 1 || tableSpanForCurrentParagraph <= 1) return explicitSpan;
            const sideRemaining = this.config.page.cols - (baseCol % this.config.page.cols);
            return Math.min(sideRemaining, tableSpanForCurrentParagraph);
        };

        const estimateAutoSectionHeight = (section, para, baseCol) => {
            const span = getSectionSpan(section, para, baseCol);
            const { colW } = this.getColGeometry(baseCol);
            let maxH = 0, textCount = 0;
            for (const run of section.runs) {
                if (run.type === 'image') {
                    const imgMem = this.context.getImage(run.text);
                    if (!imgMem) continue;
                    let iw = imgMem.w || 100, ih = imgMem.h || 100, aspect = iw / ih;
                    if (isNaN(aspect) || !isFinite(aspect) || aspect <= 0) aspect = 1;
                    const drawW = span * colW * 0.92;
                    maxH = Math.max(maxH, drawW / aspect);
                } else if (run.type === 'overlay_image') {
                    continue;
                } else {
                    textCount += countLayoutChars(run, F);
                }
            }
            if (textCount > 0) {
                const measureCols = section.balanceText ? Math.max(1, Math.min(span, Math.ceil(textCount))) : span;
                const quotas = makeBalancedQuotas(textCount, measureCols);
                const Q = Math.max(...quotas);
                const exactTextH = Q * F + Math.max(0, Q - 1) * this.actualSpacing;
                maxH = Math.max(maxH, exactTextH);
            }
            return Math.max(F, maxH);
        };

        const setAbsoluteCol = (absCol) => {
            this.cursor.side = Math.floor(absCol / this.config.page.cols);
            this.cursor.colInSide = absCol % this.config.page.cols;
        };

        // 预览窗口起点按正文段落序号计，换算到拼装后的流内序号。
        let previewStartParaIdx = Infinity;
        if (previewRender && previewRender.enabled) {
            const cursorBodyIdx = Math.max(0, Number.parseInt(previewRender.cursorParaIdx, 10) || 0);
            for (let i = 0; i < parsedParas.length; i++) {
                if (bodyIndexOf(i) === cursorBodyIdx) { previewStartParaIdx = i; break; }
            }
        }
        const applyInsertionsAt = (idx) => {
            const list = insertions?.get ? insertions.get(idx) : null;
            if (!list || !list.length) return;
            this.ensureFreshSide();
            for (const type of list) this.allocateSpecialSide(type);
        };
        const paraRegionOf = idx => bodyIndexOf(idx) >= 0 ? 'body' : (isTocParaIdx(idx) ? 'toc' : null);
        // 段落内容的版面归属在下一轮循环开头结算（见 prevParaMark），
        // 使纯分页标记段（如 %）不会把后续正文面误标为目录面。
        let prevParaMark = null;

        for (let paraIdx = 0; paraIdx <= parsedParas.length; paraIdx++) {
            if (prevParaMark) {
                const moved = this.cursor.side !== prevParaMark.startSide
                    || this.cursor.colInSide !== prevParaMark.startColInSide
                    || Math.abs(this.cursor.y - prevParaMark.startY) > 0.001;
                if (moved) this.markSideRegion(prevParaMark.fromSide, this.cursor.side, prevParaMark.region);
                prevParaMark = null;
            }
            applyInsertionsAt(paraIdx);
            if (paraIdx === parsedParas.length) break;
            if (paraIdx === tocStartIdx && tocStartIdx < tocEndIdx) this.ensureFreshSide();
            if (paraIdx === tocEndIdx) this.currentTocVolumeOverride = null;
            if (previewRender && previewRender.enabled && paraIdx >= previewStartParaIdx) {
                if (targetStopCol === Infinity) {
                    targetStopCol = this.absoluteCol + ((previewRender.after + 1) * this.config.page.cols * 2);
                }
            }
            if (this.absoluteCol > targetStopCol) {
                break;
            }

            const para = parsedParas[paraIdx];
            let prevTextObj = null;

            if (para.pageBreak || para.pageBreaks?.length) {
                const pageBreaks = Array.isArray(para.pageBreaks) && para.pageBreaks.length > 0
                    ? para.pageBreaks
                    : Array(Math.max(1, Number(para.pageBreakCount) || 1)).fill(para.pageBreak);
                for (const marker of pageBreaks) {
                    const breakType = marker === '`' ? 'full-blank' : marker;
                    const blankSide = this.breakToNewSide(breakType, breakType === '%');
                    if (blankSide !== null) {
                        this.output.pageBreaks.push({
                            paraIndex: paraIdx,
                            bodyIndex: bodyIndexOf(paraIdx),
                            marker,
                            side: blankSide,
                            type: breakType === '~' ? 'framed-blank' : 'full-blank'
                        });
                        this.markSideRegion(blankSide, blankSide, paraRegionOf(paraIdx));
                    }
                }
            }

            prevParaMark = {
                fromSide: this.cursor.side,
                region: paraRegionOf(paraIdx),
                startSide: this.cursor.side,
                startColInSide: this.cursor.colInSide,
                startY: this.cursor.y
            };

            if (para.isHalfPage) {
                let hasContent = this.cursor.colInSide > 0 || this.cursor.y > this.getLayerTop();
                let beginsHalfSide = false;
                if (this.cursor.layer === 'FULL') {
                    if (hasContent) { this.cursor.side++; this.cursor.colInSide = 0; }
                    this.cursor.layer = 'UPPER';
                    beginsHalfSide = true;
                } else if (hasContent) {
                    if (this.cursor.layer === 'UPPER') this.cursor.layer = 'LOWER';
                    else { this.cursor.side++; this.cursor.layer = 'UPPER'; beginsHalfSide = true; }
                    this.cursor.colInSide = 0;
                }
                if (beginsHalfSide) this.setHalfSplitWeights(this.cursor.side, para.halfRatio, para.halfLowerRatio || 1);
                else if (!hasContent && this.cursor.layer === 'LOWER') this.setHalfLowerRatio(this.cursor.side, para.halfRatio);
                this.cursor.y = this.getLayerTop();
                this.output.halfSides.add(this.cursor.side);
            }

            if (this.activeMerge) {
                this.cursor.colInSide = (this.activeMerge.startCol % this.config.page.cols) + this.activeMerge.span - 1;
                this.cursor.y = this.getLayerTop();
                this.activeMerge = null;
                this.advanceCol();
            }

            if (para.runs.length === 1 && para.runs[0].type === 'volume_override') {
                if (this.cursor.y > this.getLayerTop()) this.advanceCol();
                this.output.paraStarts.push({ col: this.absoluteCol });
                const override = {
                    ...para.runs[0],
                    text: resolveBodyVariables(para.runs[0].text)
                };
                this.applyVolumeOverride(override);
                if (isTocParaIdx(paraIdx) && override.scope === 'chapter') {
                    this.currentTocVolumeOverride = override.text;
                    const side = this.ensureSideMeta();
                    side.volumeOverride = override.text;
                    side.volumeOverrideScope = 'toc';
                    this.currentChapterVolumeOverride = null;
                }
                continue;
            }

            if (para.runs.length === 1 && para.runs[0].type === 'comment') {
                this.output.paraStarts.push({ col: this.absoluteCol });
                continue;
            }

            if (para.runs.length === 1 && para.runs[0].type === 'empty') {
                this.output.paraStarts.push({ col: this.absoluteCol });
                if (this.cursor.y > this.getLayerTop()) {
                    this.advanceCol();
                } else {
                    this.advanceCol();
                }
                continue;
            }

            if (this.cursor.y > this.getLayerTop()) {
                this.advanceCol();
            }

            this.currentIndentH = para.indentCount * (F + this.actualSpacing);
            this.currentContinuationIndentH = (para.hangingIndentCount || 0) * (F + this.actualSpacing);
            this.isParagraphFirstColumn = true;
            const sections = splitParaIntoSections(para);

            this.output.paraStarts.push({ col: this.absoluteCol });

            if (para.mergeCols > 0) {
                const firstFragmentSpan = Math.min(para.mergeCols + 1, this.config.page.cols - this.cursor.colInSide);
                this.activeMerge = { startCol: this.absoluteCol, span: firstFragmentSpan, usedCols: 1 };
                this.output.merges.push(this.activeMerge);
            }

            this.cursor.y = this.getLayerTop() + this.getCurrentParagraphIndentH();

            if (para.titleVolume !== null && para.titleVolume !== undefined) {
                const titleSpread = this.output.spreads[this.ensureSpreadMeta()];
                const titleSide = this.ensureSideMeta();
                this.beginChapter(resolveBodyVariables(para.titleVolume), titleSide);
                if (this.cursor.side % 2 === 0) {
                    if (titleSpread.volumeOverrideScope === 'chapter') {
                        delete titleSpread.volumeOverride;
                        delete titleSpread.volumeOverrideScope;
                    }
                    titleSpread.volume = this.currentVolume;
                }
            }

            let gridFlowStep = this.gridStep;
            const nextColWithIndent = () => {
                this.advanceCol();
                this.isParagraphFirstColumn = false;
                this.cursor.y = this.getLayerTop() + this.getCurrentParagraphIndentH();
                gridFlowStep = this.gridStep;
            };
            const startState = { textIdx: this.output.texts.length, lineIdx: this.output.lines.length, imgIdx: this.output.images.length };

            const splitsCount = sections.length - 1;
            const hasTableSections = splitsCount > 0 || para.mergeCols > 0 || sections.some(section => section.mergeCols > 0 || section.autoHeight || section.table);
            const splitStartY = this.cursor.y;
            const splitBottomY = this.getLayerBottom();
            const baseColForSections = this.absoluteCol;
            tableSpanForCurrentParagraph = Math.max(
                1,
                ...sections.map(section => getExplicitSectionSpan(section, para, baseColForSections))
            );

            const padT = this.config.page.padding.t || 0;
            const padB = this.config.page.padding.b || 0;

            const isAtTop = Math.abs(splitStartY - (this.getLayerTop() + this.currentIndentH)) < 0.1;
            const gridStartY = splitStartY - (isAtTop ? padT : 0);
            const gridBottomY = splitBottomY + padB;

            const getSectionPadding = (sIdx) => ({ top: padT, bottom: padB });

            const sectionAutoHeights = sections.map((section, sIdx) => {
                if (!section.autoHeight) return 0;
                const pad = getSectionPadding(sIdx);
                return estimateAutoSectionHeight(section, para, baseColForSections) + pad.top + pad.bottom;
            });
            const autoSectionsHeight = sectionAutoHeights.reduce((sum, h) => sum + h, 0);
            const fixedSections = sections.filter(section => !section.autoHeight);
            const fixedSectionCount = fixedSections.length;
            const fixedSectionMinHeight = F + this.actualSpacing + padT + padB;
            const fixedAvailableHeight = gridBottomY - gridStartY - autoSectionsHeight;
            const fixedWeightTotal = fixedSections.reduce((sum, section) => sum + Math.max(1, Number(section.splitWeight) || 1), 0);
            const hasRoomForWeightedSplit = fixedAvailableHeight >= fixedSectionMinHeight * fixedSectionCount;
            const getFixedSectionHeight = section => {
                if (!fixedSectionCount) return 0;
                if (!hasRoomForWeightedSplit) return fixedSectionMinHeight;
                return fixedAvailableHeight * Math.max(1, Number(section.splitWeight) || 1) / fixedWeightTotal;
            };

            const sectionBounds = [];
            let sectionTopCursor = gridStartY;
            for (const section of sections) {
                const h = section.autoHeight ? sectionAutoHeights[sectionBounds.length] : getFixedSectionHeight(section);
                const top = sectionTopCursor;
                const bottom = Math.min(gridBottomY, top + h);
                sectionBounds.push({ top, bottom });
                sectionTopCursor = bottom;
            }

            const sectionAligns = sections.map(section => section.align);
            const sectionSpans = sections.map(section => getSectionSpan(section, para, baseColForSections));
            const splitSpanAtSideBoundaries = (startCol, span) => {
                const pieces = [];
                let col = Math.max(0, Math.floor(Number(startCol) || 0));
                let remaining = Math.max(0, Math.floor(Number(span) || 0));
                const colsPerSide = Math.max(1, this.config.page.cols);
                while (remaining > 0) {
                    const sideOffset = ((col % colsPerSide) + colsPerSide) % colsPerSide;
                    const pieceSpan = Math.min(remaining, colsPerSide - sideOffset);
                    if (pieceSpan <= 0) break;
                    pieces.push({ startCol: col, span: pieceSpan });
                    col += pieceSpan;
                    remaining -= pieceSpan;
                }
                return pieces;
            };
            const addHLine = (startCol, span, y) => {
                if (!span || span <= 0 || !isFinite(y)) return;
                if (this.config.page.hideOuterGridLines) {
                    if (Math.abs(y - (this.getLayerTop() - padT)) < 0.1 || Math.abs(y - (this.getLayerBottom() + padB)) < 0.1) return;
                }
                // A merge can be requested while the cursor is at the last
                // column of the right side. Never let its horizontal rule
                // continue through the center/版心 into the left side; keep
                // one independent segment per physical page side.
                for (const piece of splitSpanAtSideBoundaries(startCol, span)) {
                    if (this.output.hLines.some(line => line.startCol === piece.startCol && line.span === piece.span && Math.abs(line.y - y) < 0.01)) continue;
                    this.output.hLines.push({ ...piece, y });
                }
            };

            let currentSectionIndex = 0;
            let sectionTopY = splitStartY;
            let sectionBottomY = splitBottomY;
            let sectionSpan = para.mergeCols > 0 ? para.mergeCols + 1 : 1;
            let sectionMergeRef = this.activeMerge;
            let sectionBaseCol = baseColForSections;
            let sectionOverflowClip = false;
            let sectionAutoHeight = false;
            let sectionContentTopY = splitStartY;
            let sectionContentBottomY = splitBottomY;
            let sectionTextQuotas = null;
            let sectionTextColCounts = [];
            let sectionTextColsLimit = 1;
            let sectionHasTextContent = false;
            let sectionBalanceText = false;
            let sectionMergeCols = 0;
            let sectionExtraIndentH = 0;
            let continuedSectionEndCol = null;
            let containerImageEndCol = null;
            let detachedAfterContainerImage = false;
            let implicitSplitLastCol = baseColForSections;

            const makeSectionMerge = (section, sIdx) => {
                const span = getSectionSpan(section, para, baseColForSections);
                const edgeOffset = this.config.page.outerLineW / 2 + this.config.page.lineGap + this.config.page.innerLineW / 2;
                const edgeTopY = this.config.page.margin.t + edgeOffset;
                const edgeBottomY = this.config.page.h - this.config.page.margin.b - edgeOffset;
                let topY = sectionBounds[sIdx].top;
                let bottomY = sectionBounds[sIdx].bottom;
                if (Math.abs(topY - (this.frame.top - padT)) < F * 0.5) topY = edgeTopY;
                if (Math.abs(bottomY - (this.frame.bottom + padB)) < F * 0.5) bottomY = edgeBottomY;

                const isLocalMerge = section.mergeCols > 0 || (para.mergeCols > 0 && hasTableSections);
                let mergeRef;
                if (isLocalMerge) {
                    mergeRef = { startCol: baseColForSections, span, usedCols: 1, local: true, sectionIdx: sIdx, topY, bottomY };
                    this.output.merges.push(mergeRef);
                } else mergeRef = this.activeMerge;
                return mergeRef;
            };

            const moveTextWithinSectionSpan = (quotaMove = false) => {
                if (!sectionOverflowClip || sectionSpan <= 1) return false;
                if (sectionAutoHeight && !quotaMove) return false;
                const currentLocal = this.absoluteCol - sectionBaseCol;
                if (currentLocal + 1 >= sectionTextColsLimit) return false;
                setAbsoluteCol(this.absoluteCol + 1);
                this.isParagraphFirstColumn = false;
                this.cursor.y = sectionContentTopY + (this.currentContinuationIndentH || 0);
                gridFlowStep = this.gridStep;
                return true;
            };

            const getCrossPageMergeFragments = (startCol, totalSpan) => {
                const fragments = [];
                let remaining = Math.max(1, totalSpan);
                let col = startCol;
                while (remaining > 0) {
                    const colInSide = col % this.config.page.cols;
                    const span = Math.min(remaining, this.config.page.cols - colInSide);
                    const { colW } = this.getColGeometry(col);
                    fragments.push({ startCol: col, span, width: span * colW });
                    col += span;
                    remaining -= span;
                }
                const totalWidth = fragments.reduce((sum, fragment) => sum + fragment.width, 0);
                let offset = 0;
                fragments.forEach(fragment => {
                    fragment.sourceOffset = offset;
                    fragment.totalWidth = totalWidth;
                    offset += fragment.width;
                });
                return fragments;
            };

            const enterSection = (sIdx) => {
                currentSectionIndex = sIdx;
                containerImageEndCol = null;
                const section = sections[sIdx];
                const bounds = sectionBounds[sIdx];
                sectionTopY = bounds.top;
                sectionBottomY = bounds.bottom;
                const pad = getSectionPadding(sIdx);
                sectionContentTopY = Math.min(sectionBottomY, sectionTopY + pad.top);
                sectionContentBottomY = Math.max(sectionContentTopY, sectionBottomY - pad.bottom);
                const sectionStartCol = para.suppressSectionLines && sIdx > 0
                    ? implicitSplitLastCol
                    : baseColForSections;
                sectionBaseCol = sectionStartCol;
                setAbsoluteCol(sectionStartCol);
                sectionSpan = getSectionSpan(section, para, sectionBaseCol);
                sectionMergeCols = section.mergeCols || 0;
                sectionMergeRef = makeSectionMerge(section, sIdx);
                sectionOverflowClip = hasTableSections && !para.suppressSectionLines && (splitsCount > 0 || para.mergeCols > 0 || section.mergeCols > 0 || section.autoHeight);
                sectionAutoHeight = !!section.autoHeight;
                sectionBalanceText = !!section.balanceText;
                sectionExtraIndentH = 0;
                const textCount = section.runs.reduce((sum, run) => sum + countLayoutChars(run, F), 0);
                sectionHasTextContent = textCount > 0;
                sectionTextColsLimit = sectionBalanceText && textCount > 0 ? Math.min(sectionSpan, Math.ceil(textCount)) : sectionSpan;
                sectionTextQuotas = sectionBalanceText && sectionTextColsLimit > 1 && textCount > 0 ? makeBalancedQuotas(textCount, sectionTextColsLimit) : null;
                sectionTextColCounts = Array(sectionTextColsLimit).fill(0);
                // Each split section starts at its own first column. Once
                // text advances within that section, the continuation indent
                // is applied by moveTextWithinSectionSpan().
                this.isParagraphFirstColumn = true;
                this.cursor.y = sectionContentTopY;
                gridFlowStep = this.gridStep;
            };

            const finalizeSectionTextCentering = () => {
                if (!sectionMergeRef || !sectionMergeRef.local || !sectionHasTextContent || !sectionTextColCounts.length) return;
                const usedCols = sectionTextColCounts.filter(count => count > 0).length || 1;
                sectionMergeRef.usedCols = Math.min(sectionMergeRef.span, usedCols);
                sectionMergeRef.centerUsedCols = true;
            };

            for (let sIdx = 0; sIdx < sections.length; sIdx++) {
                enterSection(sIdx);

                if (hasTableSections && !para.suppressSectionLines) {
                    const boundarySpan = sIdx === 0
                        ? sectionSpans[0]
                        : Math.max(sectionSpans[sIdx - 1], sectionSpans[sIdx]);
                    if (sections[sIdx].hideTopLine) {
                        for (const piece of splitSpanAtSideBoundaries(sectionBaseCol, boundarySpan)) {
                            hiddenHLineSegments.push({ ...piece, y: sectionTopY });
                        }
                    } else addHLine(sectionBaseCol, boundarySpan, sectionTopY);
                    if (sIdx === sections.length - 1) addHLine(sectionBaseCol, sectionSpans[sIdx], sectionBottomY);
                } else if (sIdx > 0 && !para.suppressSectionLines) {
                    const boundarySpan = Math.max(sectionSpans[sIdx - 1], sectionSpans[sIdx]);
                    if (sections[sIdx].hideTopLine) {
                        for (const piece of splitSpanAtSideBoundaries(sectionBaseCol, boundarySpan)) {
                            hiddenHLineSegments.push({ ...piece, y: sectionTopY });
                        }
                    }
                    else addHLine(sectionBaseCol, boundarySpan, sectionTopY);
                }

                const getRunLeadingForbiddenCount = run => {
                    if (!run || !['normal', 'title'].includes(run.type)) return 0;
                    const text = run.variableName
                        ? resolveBodyVariable(run.variableName)
                        : resolveBodyVariables(run.text);
                    if (!text) return 0;
                    const chars = run.isRaw
                        ? Array.from(String(text)).map(c => ({ c, isStyleLineBreak: c === '\uE01D' }))
                        : TextParser.parseStyledChars(String(text), { ...styleState });
                    let count = 0;
                    for (const item of chars) {
                        if (item.isStyleLineBreak) break;
                        const c = item.c;
                        if (isZeroAdvancePunctuation(c)) continue;
                        if (this.config.format.onlyPeriod && !this.hasForcedCornerAdvance() && /^[，。、,\.．！?？!;；:：]$/.test(c)) break;
                        if (!PUNCT_RULES.FORBIDDEN_START.test(c)) break;
                        count++;
                    }
                    return count;
                };
                const getFollowingRunForbiddenPrefix = runIndex => {
                    for (let i = runIndex + 1; i < sections[sIdx].runs.length; i++) {
                        const candidate = sections[sIdx].runs[i];
                        if (!candidate || !['normal', 'title'].includes(candidate.type)) return 0;
                        const candidateText = candidate.variableName
                            ? resolveBodyVariable(candidate.variableName)
                            : resolveBodyVariables(candidate.text);
                        if (!candidateText) continue;
                        return getRunLeadingForbiddenCount(candidate);
                    }
                    return 0;
                };

                for (let runIndex = 0; runIndex < sections[sIdx].runs.length; runIndex++) {
                    const run = sections[sIdx].runs[runIndex];
                    const nextRunForbiddenPrefix = getFollowingRunForbiddenPrefix(runIndex);
                    this.ensureSpreadMeta();
                    let { colW } = this.getColGeometry(this.absoluteCol);

                    if (containerImageEndCol !== null && !['sep', 'book_ear', 'overlay_image'].includes(run.type)) {
                        setAbsoluteCol(containerImageEndCol);
                        nextColWithIndent();
                        sectionBaseCol = this.absoluteCol;
                        sectionSpan = 1;
                        sectionMergeRef = null;
                        sectionOverflowClip = false;
                        sectionTextColsLimit = 1;
                        sectionTextQuotas = null;
                        sectionTextColCounts = [0];
                        containerImageEndCol = null;
                        detachedAfterContainerImage = true;
                        ({ colW } = this.getColGeometry(this.absoluteCol));
                    }

                    if (run.type === 'sep') { this.output.texts.push({ type: 'sep', col: this.absoluteCol, size: 0, y: this.cursor.y, char: '', mergeRef: sectionMergeRef, sectionIdx: currentSectionIndex }); continue; }

                    if (run.type === 'book_ear') { this.output.ears[this.cursor.side] = resolveBodyVariables(run.text); continue; }
                    if (run.type === 'chapter_marker') {
                        const chapterSpread = this.output.spreads[this.ensureSpreadMeta()];
                        const chapterSide = this.ensureSideMeta();
                        this.beginChapter(resolveBodyVariables(run.chapterTitle), chapterSide);
                        if (this.cursor.side % 2 === 0) {
                            if (chapterSpread.volumeOverrideScope === 'chapter') {
                                delete chapterSpread.volumeOverride;
                                delete chapterSpread.volumeOverrideScope;
                            }
                            chapterSpread.volume = this.currentVolume;
                        }
                    }
                    if (run.type === 'overlay_image') {
                        if (run.overlay) {
                            let targetSpreadIdx = Math.floor(this.cursor.side / 2);
                            let targetSide = this.cursor.side;
                            let isCover = false;
                            if (run.overlay.page != null && run.overlay.page > 0) {
                                const hasCover = this.config.cover && this.config.cover.mode !== 'none';
                                const pVal = Math.floor(run.overlay.page);
                                if (hasCover) {
                                    if (pVal === 1) {
                                        isCover = true;
                                        targetSpreadIdx = -1;
                                        targetSide = -1;
                                    } else {
                                        targetSide = pVal - 2;
                                        targetSpreadIdx = Math.floor(targetSide / 2);
                                    }
                                } else {
                                    targetSide = pVal - 1;
                                    targetSpreadIdx = Math.floor(targetSide / 2);
                                }
                            }
                            this.output.overlayImages.push({ ...run.overlay, side: targetSide, spreadIdx: targetSpreadIdx, isCover });
                        }
                        continue;
                    }

                    if (run.type === 'image') {
                        let prefix = run.prefix || '';
                        if (para.isHalfPage && !prefix) prefix = '*';
                        if (prefix === 'full-blank' || prefix === '~') { this.breakToNewSide(prefix); this.output.sideImages[this.cursor.side - 1] = run.text; continue; }

                        const isContainerStretchImage = prefix === '^';

                        if (prefix === '*') {
                            let hasContent = this.cursor.colInSide > 0 || this.cursor.y > this.getLayerTop() + this.currentIndentH;
                            if (hasContent) {
                                if (this.cursor.layer === 'UPPER') this.cursor.layer = 'LOWER';
                                else { this.cursor.side++; this.cursor.layer = 'UPPER'; }
                                this.cursor.colInSide = 0;
                                this.cursor.y = this.getLayerTop();
                                this.output.halfSides.add(this.cursor.side);
                            } else if (this.cursor.layer === 'FULL') {
                                this.cursor.layer = 'UPPER';
                                this.output.halfSides.add(this.cursor.side);
                            }

                            this.output.halfPageImages.push({ id: run.text, side: this.cursor.side, layer: this.cursor.layer, stretch: false, imgParams: run.imgParams });

                            if (this.cursor.layer === 'UPPER') this.cursor.layer = 'LOWER';
                            else { this.cursor.side++; this.cursor.layer = 'FULL'; }
                            this.cursor.colInSide = 0;
                            this.cursor.y = this.getLayerTop();
                            continue;
                        }

                        if (this.pendingBlankSide !== null) { this.output.sideImages[this.pendingBlankSide] = run.text; this.pendingBlankSide = null; continue; }
                        const imgMem = this.context.getImage(run.text);
                        if (!imgMem) continue;

                        const globalPadT = this.config.page.padding.t || 0;
                        const globalPadB = this.config.page.padding.b || 0;
                        const lineSafeInset = Math.max(0, Number(this.config.page.innerLineW) || 0);

                        const ip = run.imgParams || {};
                        const hasPT = ip.PT !== undefined || ip.PY !== undefined;
                        const hasPB = ip.PB !== undefined || ip.PY !== undefined;
                        const hasPL = ip.PL !== undefined || ip.PX !== undefined;
                        const hasPR = ip.PR !== undefined || ip.PX !== undefined;

                        const pt = (hasPT ? (ip.PT !== undefined ? ip.PT : ip.PY) * MM_TO_PT : 0);
                        const pb = (hasPB ? (ip.PB !== undefined ? ip.PB : ip.PY) * MM_TO_PT : 0);
                        const pl = (hasPL ? (ip.PL !== undefined ? ip.PL : ip.PX) * MM_TO_PT : 0);
                        const pr = (hasPR ? (ip.PR !== undefined ? ip.PR : ip.PX) * MM_TO_PT : 0);

                        const span = sectionSpan, availableW = span * colW;
                        const rawImageW = Number(imgMem.w);
                        const rawImageH = Number(imgMem.h);
                        const imageW = Number.isFinite(rawImageW) && rawImageW > 0 ? rawImageW : 100;
                        const imageH = Number.isFinite(rawImageH) && rawImageH > 0 ? rawImageH : 100;
                        const imageAspect = imageW / imageH;

                        if (isContainerStretchImage) {
                            const cellTop = sectionOverflowClip ? sectionTopY : this.cursor.y;
                            const cellBottom = sectionOverflowClip ? sectionBottomY : this.getLayerBottom();
                            const insetT = Math.max(hasPT ? pt : globalPadT, lineSafeInset);
                            const insetB = Math.max(hasPB ? pb : globalPadB, lineSafeInset);
                            const insetL = Math.max(hasPL ? pl : 0, lineSafeInset);
                            const insetR = Math.max(hasPR ? pr : 0, lineSafeInset);

                            const requestedImageSpan = sectionMergeCols > 0
                                ? sectionMergeCols + 1
                                : (para.mergeCols > 0 ? para.mergeCols + 1 : span);
                            const fragments = getCrossPageMergeFragments(this.absoluteCol, requestedImageSpan);
                            const cellH = Math.max(0, cellBottom - cellTop);
                            const drawH = Math.max(1, cellH - insetT - insetB);

                            if (cellH > insetT + insetB) {
                                const drawableFragments = fragments.map(fragment => ({
                                    ...fragment,
                                    drawW: Math.max(1, fragment.width - insetL - insetR)
                                }));
                                const totalDrawableWidth = drawableFragments.reduce((sum, fragment) => sum + fragment.drawW, 0);
                                let drawableOffset = 0;

                                drawableFragments.forEach((fragment, fragmentIndex) => {
                                    this.output.images.push({
                                        id: run.text, startCol: fragment.startCol, span: fragment.span,
                                        spreadIdx: Math.floor(fragment.startCol / this.frame.colsPerSpread), y: cellTop + insetT,
                                        w: fragment.drawW, h: drawH, sectionIdx: currentSectionIndex, stretch: true,
                                        insetLeft: insetL, cropSourceOffset: drawableOffset,
                                        cropSourceTotalWidth: totalDrawableWidth
                                    });
                                    drawableOffset += fragment.drawW;

                                    if (fragmentIndex > 0) {
                                        this.output.merges.push({
                                            startCol: fragment.startCol, span: fragment.span, usedCols: fragment.span,
                                            local: true, sectionIdx: currentSectionIndex,
                                            topY: sectionMergeRef?.topY ?? cellTop,
                                            bottomY: sectionMergeRef?.bottomY ?? cellBottom
                                        });
                                    }
                                });

                                const lastFragment = fragments[fragments.length - 1];
                                continuedSectionEndCol = lastFragment.startCol + lastFragment.span - 1;
                                containerImageEndCol = continuedSectionEndCol;
                                setAbsoluteCol(continuedSectionEndCol);
                                this.cursor.y = cellBottom;
                                this.activeMerge = null;
                            }
                            continue;
                        }

                        let aspect = imageAspect;
                        if (isNaN(aspect) || !isFinite(aspect) || aspect <= 0) aspect = 1;

                        const imageInsetT = Math.max(hasPT ? pt : 0, lineSafeInset);
                        const imageInsetB = Math.max(hasPB ? pb : 0, lineSafeInset);
                        const imageInsetL = Math.max(hasPL ? pl : 0, lineSafeInset);
                        const imageInsetR = Math.max(hasPR ? pr : 0, lineSafeInset);
                        let hasHorizontalPadding = hasPL || hasPR;
                        let actualW = hasHorizontalPadding ? (availableW - imageInsetL - imageInsetR) : Math.min(availableW * 0.92, availableW - imageInsetL - imageInsetR);
                        if (actualW <= 0) actualW = 1;

                        let drawW = actualW, drawH = drawW / aspect;

                        if (sectionOverflowClip && Math.abs(this.cursor.y - sectionContentTopY) < 0.1) {
                            this.cursor.y = sectionTopY + imageInsetT;
                        } else if (!sectionOverflowClip && Math.abs(this.cursor.y - (this.getLayerTop() + this.currentIndentH)) < 0.1) {
                            this.cursor.y = this.getLayerTop() + this.currentIndentH + imageInsetT;
                        } else {
                            this.cursor.y += imageInsetT;
                        }

                        let customBottomLimit = (sectionOverflowClip ? sectionContentBottomY : this.getLayerBottom()) - imageInsetB;
                        let maxDrawH = customBottomLimit - this.cursor.y;
                        const minImageHeight = Math.max(4, F * 0.25);
                        let imageEscapedSection = false;

                        if (maxDrawH < minImageHeight && this.cursor.y > this.getLayerTop() + this.currentIndentH) {
                            if (this.activeMerge) this.cursor.colInSide = (this.activeMerge.startCol % this.config.page.cols) + this.activeMerge.span - 1;
                            nextColWithIndent();
                            imageEscapedSection = sectionOverflowClip;
                            this.cursor.y += imageInsetT;
                            customBottomLimit = this.getLayerBottom() - imageInsetB;
                            maxDrawH = customBottomLimit - this.cursor.y;
                        }

                        if (drawH > maxDrawH) {
                            drawH = Math.max(1, maxDrawH * (hasHorizontalPadding ? 1 : 0.98));
                            drawW = drawH * aspect;
                        }

                        if (!sectionOverflowClip && this.cursor.y > this.getLayerTop() + this.currentIndentH && this.cursor.y + drawH > this.getLayerBottom()) {
                            if (this.activeMerge) this.cursor.colInSide = (this.activeMerge.startCol % this.config.page.cols) + this.activeMerge.span - 1;
                            nextColWithIndent();
                            this.cursor.y += imageInsetT;
                            customBottomLimit = this.getLayerBottom() - imageInsetB;
                            maxDrawH = customBottomLimit - this.cursor.y;
                            if (drawH > maxDrawH) {
                                drawH = Math.max(1, maxDrawH * (hasHorizontalPadding ? 1 : 0.98));
                                drawW = drawH * aspect;
                            }
                        }

                        if (!sectionOverflowClip || this.cursor.y < customBottomLimit) {
                            this.output.images.push({
                                id: run.text, startCol: imageEscapedSection ? this.absoluteCol : (sectionMergeRef ? sectionMergeRef.startCol : this.absoluteCol), span: imageEscapedSection ? 1 : span,
                                spreadIdx: this.ensureSpreadMeta(), y: this.cursor.y, w: drawW,
                                h: sectionOverflowClip && !sectionAutoHeight ? Math.min(drawH, Math.max(0, customBottomLimit - this.cursor.y)) : drawH,
                                sectionIdx: currentSectionIndex, clipBottomY: sectionOverflowClip && !sectionAutoHeight ? customBottomLimit : null,
                                offsetX: hasHorizontalPadding ? imageInsetL : null
                            });
                        }
                        this.cursor.y += drawH + imageInsetB + this.actualSpacing;
                        continue;
                    }

                    const leadingFlowControls = Array.isArray(run.leadingFlowControls) ? run.leadingFlowControls : [];
                    const isLiteralRawRun = run.isRaw && run.type !== 'chapter_marker';
                    const resolvedRunText = isLiteralRawRun
                        ? String(run.text || '')
                        : (run.variableName
                            ? resolveBodyVariable(run.variableName, true)
                            : resolveBodyVariables(run.text));
                    let runChars = run.isRaw
                        ? Array.from(resolvedRunText).map(c => c === '\uE01D'
                            ? { c: '', isStyleLineBreak: true, circ: styleState.circ, isYinke: styleState.yinke, isProper: styleState.proper, styleId: styleState.styleId, isCornerCircle: styleState.cornerCircle, isCornerDunhao: styleState.cornerDunhao, isLiteralRaw: isLiteralRawRun }
                            : { c, circ: styleState.circ, isYinke: styleState.yinke, isProper: styleState.proper, styleId: styleState.styleId, isCornerCircle: styleState.cornerCircle, isCornerDunhao: styleState.cornerDunhao, isLiteralRaw: isLiteralRawRun })
                        : TextParser.parseStyledChars(resolvedRunText, styleState);
                    if (run.type === 'normal' && leadingFlowControls.length) {
                        runChars = [
                            ...leadingFlowControls.map(c => ({ c, circ: styleState.circ, isYinke: styleState.yinke, isProper: styleState.proper, styleId: styleState.styleId, isCornerCircle: styleState.cornerCircle, isCornerDunhao: styleState.cornerDunhao })),
                            ...runChars
                        ];
                    }

                    if (run.type === 'title') {
                        const titleF = this.config.fonts.title.size;
                        let lineXOffset = colW - (colW - titleF) / 2 + 2;
                        for (const control of leadingFlowControls) {
                            if (control === '@') this.cursor.y += titleF + this.actualSpacing;
                        }
                        runChars.forEach(item => {
                            const itemStyle = getItemStyle(item);
                            const itemF = getStyledSize(item, titleF);
                            const itemSpacing = getStyledSpacing(item, this.actualSpacing);
                            const itemFont = getStyledFont(item, this.config.fontsObj?.titleF);
                            if (item.c === '^' && !item.isLiteralRaw) return;
                            if ([' ', '　', '\t'].includes(item.c)) { this.cursor.y += itemF * 0.5; return; }
                            if ((item.c === '@' || item.c === '$') && !item.isLiteralRaw) { this.cursor.y += itemF + itemSpacing; return; }
                            if (item.c === '︹') {
                                this.output.texts.push(applyTextStyle({
                                    col: this.absoluteCol,
                                    y: this.cursor.y,
                                    char: item.c,
                                    size: itemF,
                                    type: 'draw_kuo',
                                    renderYOffset: -0.04 * itemF,
                                    mergeRef: sectionMergeRef,
                                    sectionIdx: currentSectionIndex,
                                    fontName: itemStyle?.fontName || ''
                                }, item));
                                return;
                            }
                            if (item.c === '︺') {
                                this.output.texts.push(applyTextStyle({
                                    col: this.absoluteCol,
                                    y: this.cursor.y,
                                    char: item.c,
                                    size: itemF,
                                    type: 'draw_kuo',
                                    renderYOffset: -itemSpacing + 0.04 * itemF,
                                    mergeRef: sectionMergeRef,
                                    sectionIdx: currentSectionIndex,
                                    fontName: itemStyle?.fontName || ''
                                }, item));
                                return;
                            }

                            const m = this.getPunctMetrics(item.c, itemF, 1.0, itemFont, itemSpacing);
                            let charStartY = Math.max(this.getLayerTop(), this.cursor.y + m.preY);
                            this.cursor.y = charStartY;

                            if (this.cursor.y + itemF > this.getLayerBottom() + this.layoutTolerance) {
                                closeProperLine();
                                nextColWithIndent();
                                let { colW: newColW } = this.getColGeometry(this.absoluteCol);
                                lineXOffset = newColW - (newColW - itemF) / 2 + 2;
                                charStartY = Math.max(this.getLayerTop(), this.cursor.y + m.preY);
                                this.cursor.y = charStartY;
                            }

                            const hCharSpacing = itemStyle?.hCharSpacing ?? null;

                            this.output.texts.push(applyTextStyle({
                                col: this.absoluteCol, y: this.cursor.y, char: item.c, size: m ? m.renderSize : itemF,
                                type: (m.isCorner || m.isRot || m.isRot90 || m.isCen) ? 'punctuation' : 'title',
                                isYinke: item.isYinke, fontName: itemStyle?.fontName || '', hCharSpacing: hCharSpacing,
                                isCornerCircle: item.isCornerCircle, isCornerDunhao: item.isCornerDunhao,
                                m: m, isCorner: m.isCorner, isRotate: m.isRot, isRotate90: m.isRot90, isCenter: m.isCen,
                                mergeRef: sectionMergeRef, sectionIdx: currentSectionIndex, isCircled: item.circ && !m.isCorner && !m.isRot && !m.isRot90 && !m.isCen
                            }, item));

                            if (item.isProper) updateProperLine(charStartY, this.cursor.y + m.advanceY, this.absoluteCol, currentSectionIndex, lineXOffset, 'title', hCharSpacing, sectionMergeRef);
                            else closeProperLine();

                            this.cursor.y += m.advanceY;
                        });
                        closeProperLine();

                    } else if (run.type === 'note' || run.type.startsWith('small_')) {
                        if (this.config.format.onlyPeriod && !this.hasForcedCornerAdvance()) {
                            let folded = [];
                            for (let item of runChars) {
                                // 冒号不是角标点：标准化后仍按正常正文字符绘制。
                                if (/^[，。、,\.．！?？!\;；]$/.test(item.c)) {
                                    if (folded.length > 0) {
                                        let prev = folded[folded.length - 1];
                                        if (/^[。\.．！?？!]$/.test(item.c)) prev.isCornerCircle = true;
                                        else prev.isCornerDunhao = true;
                                    }
                                } else folded.push(item);
                            }
                            runChars = folded;
                        }

                        const noteF = Math.max(10, F * (this.config.page.noteFontSizeRatio || 0.55));
                        const getSmallMetrics = item => {
                            if (item._m) return item._m; // #10：同一小字在试算/绘制阶段只度量一次
                            const itemStyle = getItemStyle(item);
                            const itemF = getStyledSize(item, noteF);
                            const itemSpacing = getStyledSpacing(item, this.actualSpacing);
                            const itemFont = getStyledFont(item, this.config.fontsObj?.noteF || this.config.fontsObj?.mainF);
                            const raw = this.getPunctMetrics(item.c, itemF, 0.25, itemFont, itemSpacing);
                            item._m = this.getBodyGridMetrics(raw, hasVerticalStyleSpacing(itemStyle));
                            return item._m;
                        };

                        let colCenterX = run.type === 'small_left' ? (2 + noteF / 2) : (run.type === 'small_right' ? (colW - 2 - noteF / 2) : (colW / 2));

                        if (run.type === 'note') {
                            const configuredNoteSpacing = Number(this.config.page.noteColSpacing);
                            const noteSpacing = Number.isFinite(configuredNoteSpacing) ? configuredNoteSpacing : 0;
                            // A style's horizontal spacing is meaningful for
                            // the two side-by-side note columns. Do not feed it
                            // into the normal body grid; here it controls the
                            // center-to-center distance of the note columns.
                            const noteStyleItem = runChars.find(item => hasHorizontalStyleSpacing(getItemStyle(item)));
                            const noteHorizontalRatio = noteStyleItem
                                ? Number(getItemStyle(noteStyleItem)?.hCharSpacing)
                                : NaN;
                            const noteColumnDistance = Number.isFinite(noteHorizontalRatio) && noteHorizontalRatio > 0
                                ? noteF * noteHorizontalRatio
                                : noteF + noteSpacing;
                            const centerRight = colW / 2 + noteColumnDistance / 2;
                            const centerLeft = colW / 2 - noteColumnDistance / 2;
                            let noteIdx = 0, noteContinuationIndent = 0;
                            let isFirstNoteColumn = true;
                            const noteHangingIndent = run.hangingIndentCount || 0;
                            while (noteIdx < runChars.length) {
                                if (this.cursor.y + noteContinuationIndent * this.gridStep + this.gridCellHeight > this.getLayerBottom() + this.layoutTolerance) nextColWithIndent();
                                const getCharsToFit = (startIdx, indentCells) => {
                                    let y = this.cursor.y + indentCells * this.gridStep, count = 0, i = startIdx;
                                    let nextIndentCells = indentCells, hasContent = false;
                                    while (i < runChars.length) {
                                        let item = runChars[i], itemF = getStyledSize(item, noteF), itemSpacing = getStyledSpacing(item, this.actualSpacing), itemFont = getStyledFont(item, this.config.fontsObj?.mainF);
                                        if (item.c === '$') {
                                            nextIndentCells++;
                                            if (!hasContent) y += this.gridStep;
                                            i++;
                                            continue;
                                        }
                                        const isGridSpace = item.c === '@';
                                        let m = isGridSpace ? null : getSmallMetrics(item);
                                        let testY = isGridSpace ? y + this.gridStep : Math.max(this.getLayerTop(), y + m.preY) + m.advanceY;
                                        if ((isGridSpace ? y + this.gridCellHeight : Math.max(this.getLayerTop(), y + m.preY) + m.cellHeight) > this.getLayerBottom() + this.layoutTolerance && !PUNCT_RULES.FORBIDDEN_START.test(item.c)) break;
                                        y = testY; hasContent = true; if (!PUNCT_RULES.CORNER.test(item.c)) count++; i++;
                                    }
                                    return { items: runChars.slice(startIdx, i), nextIdx: i, count, nextIndentCells };
                                };
                                let rightTest = getCharsToFit(noteIdx, noteContinuationIndent), leftTest = getCharsToFit(rightTest.nextIdx, rightTest.nextIndentCells), remTotal = 0;
                                for (let k = noteIdx; k < runChars.length; k++) if (runChars[k].c !== '$' && !PUNCT_RULES.CORNER.test(runChars[k].c)) remTotal++;
                                let rightChars = [], leftChars = [];

                                if (remTotal > 0 && remTotal <= rightTest.count + leftTest.count) {
                                    let takeRight = Math.min(Math.ceil(remTotal / 2), rightTest.count);
                                    const takeWords = (sIdx, wCount) => {
                                        let res = [], i = sIdx, w = 0;
                                        while (i < runChars.length) {
                                            if (w >= wCount && runChars[i].c !== '$' && !PUNCT_RULES.CORNER.test(runChars[i].c)) break;
                                            res.push(runChars[i]); if (runChars[i].c !== '$' && !PUNCT_RULES.CORNER.test(runChars[i].c)) w++; i++;
                                        }
                                        return { items: res, nextIdx: i };
                                    };
                                    let r = takeWords(noteIdx, takeRight), l = takeWords(r.nextIdx, remTotal - takeRight);
                                    rightChars = r.items; leftChars = l.items; noteIdx = l.nextIdx;
                                } else { rightChars = rightTest.items; leftChars = leftTest.items; noteIdx = leftTest.nextIdx; }

                                const drawSubCol = (subItems, subColCenterX, indentCells) => {
                                    let curY = this.cursor.y + indentCells * this.gridStep;
                                    let lineXOffset = subColCenterX + noteF / 2 + 1.5;
                                    let nextIndentCells = indentCells, hasContent = false;
                                    subItems.forEach(item => {
                                        const itemStyle = getItemStyle(item);
                                        const itemF = getStyledSize(item, noteF);
                                        const itemSpacing = getStyledSpacing(item, this.actualSpacing);
                                        const itemFont = getStyledFont(item, this.config.fontsObj?.mainF);

                                        if (item.c === '$') {
                                            nextIndentCells++;
                                            if (!hasContent) curY += this.gridStep;
                                            return;
                                        }
                                        if (item.c === '@') {
                                            curY += this.gridStep;
                                            hasContent = true;
                                            return;
                                        }

                                        const m = getSmallMetrics(item);
                                        let charStartY = Math.max(this.getLayerTop(), curY + m.preY);
                                        curY = charStartY;

                                        const hCharSpacing = itemStyle?.hCharSpacing ?? null;

                                        this.output.texts.push(applyTextStyle({
                                            col: this.absoluteCol, y: curY, char: item.c, size: m ? m.renderSize : noteF, baseSize: noteF, type: run.type, offsetX: subColCenterX,
                                            isYinke: item.isYinke, fontName: itemStyle?.fontName || '', hCharSpacing: hCharSpacing,
                                            m: m, isCorner: m.isCorner, isRotate: m.isRot, isRotate90: m.isRot90, isCenter: m.isCen,
                                            mergeRef: sectionMergeRef, sectionIdx: currentSectionIndex, isCircled: item.circ && !m.isCorner && !m.isRot && !m.isRot90 && !m.isCen,
                                            isCornerCircle: item.isCornerCircle, isCornerDunhao: item.isCornerDunhao
                                        }, item));

                                        if (item.isProper) updateProperLine(charStartY, curY + m.advanceY, this.absoluteCol, currentSectionIndex, lineXOffset, run.type, hCharSpacing, sectionMergeRef);
                                        else closeProperLine();

                                        curY += m.advanceY;
                                        hasContent = true;
                                    });
                                    closeProperLine();
                                    return { y: curY, nextIndentCells };
                                };
                                const rightDraw = drawSubCol(rightChars, centerRight, noteContinuationIndent);
                                const leftDraw = drawSubCol(leftChars, centerLeft, rightDraw.nextIndentCells);
                                this.cursor.y = Math.max(rightDraw.y, leftDraw.y);
                                noteContinuationIndent = leftDraw.nextIndentCells;
                                if (noteIdx < runChars.length) {
                                    if (isFirstNoteColumn) noteContinuationIndent += noteHangingIndent;
                                    isFirstNoteColumn = false;
                                    nextColWithIndent();
                                }
                            }
                        } else {
                            let lineXOffset = colCenterX + noteF / 2 + 1.5;
                            runChars.forEach(item => {
                                const itemStyle = getItemStyle(item);
                                const itemF = getStyledSize(item, noteF);
                                const itemSpacing = getStyledSpacing(item, this.actualSpacing);
                                const itemFont = getStyledFont(item, this.config.fontsObj?.mainF);

                                if (item.c === '@' || item.c === '$') {
                                    if (this.cursor.y + this.gridCellHeight > this.getLayerBottom() + this.layoutTolerance) {
                                        closeProperLine();
                                        nextColWithIndent();
                                    }
                                    this.cursor.y += this.gridStep;
                                    return;
                                }

                                const m = getSmallMetrics(item);
                                let charStartY = Math.max(this.getLayerTop(), this.cursor.y + m.preY);
                                this.cursor.y = charStartY;

                                if (this.cursor.y + m.cellHeight > this.getLayerBottom() + this.layoutTolerance) {
                                    closeProperLine();
                                    nextColWithIndent();
                                    charStartY = Math.max(this.getLayerTop(), this.cursor.y + m.preY);
                                    this.cursor.y = charStartY;
                                }

                                const hCharSpacing = itemStyle?.hCharSpacing ?? null;

                                this.output.texts.push(applyTextStyle({
                                    col: this.absoluteCol, y: this.cursor.y, char: item.c, size: m ? m.renderSize : noteF, baseSize: noteF, type: run.type, offsetX: colCenterX,
                                    isYinke: item.isYinke, fontName: itemStyle?.fontName || '', hCharSpacing: hCharSpacing,
                                    m: m, isCorner: m.isCorner, isRotate: m.isRot, isRotate90: m.isRot90, isCenter: m.isCen,
                                    mergeRef: sectionMergeRef, sectionIdx: currentSectionIndex, isCircled: item.circ && !m.isCorner && !m.isRot && !m.isRot90 && !m.isCen,
                                    isCornerCircle: item.isCornerCircle, isCornerDunhao: item.isCornerDunhao
                                }, item));

                                if (item.isProper) updateProperLine(charStartY, this.cursor.y + m.advanceY, this.absoluteCol, currentSectionIndex, lineXOffset, run.type, hCharSpacing, sectionMergeRef);
                                else closeProperLine();

                                this.cursor.y += m.advanceY;
                            });
                            closeProperLine();
                        }

                    } else {
                        let lineXOffset = colW - (colW - F) / 2 + 2;
                        let ungridStyleActive = !!styleState.gridBreakPending;
                        let mergedStyleFlow = null;
                        const getGridBottom = () => sectionOverflowClip ? sectionContentBottomY : this.getLayerBottom();
                        const getFlowGridTop = () => {
                            // The grid origin is the actual start of the
                            // current column. Using the layer top here loses
                            // both paragraph and hanging indents when the
                            // column is compressed for punctuation avoidance.
                            if (sectionOverflowClip) {
                                return sectionContentTopY + sectionExtraIndentH + (this.isParagraphFirstColumn ? 0 : (this.currentContinuationIndentH || 0));
                            }
                            return this.getLayerTop() + this.getCurrentParagraphIndentH();
                        };
                        const getGridTop = getFlowGridTop;
                        const getRemainingGridCells = () => {
                            if (gridFlowStep <= 0) return 0;
                            const origin = getFlowGridTop();
                            const cursorY = Math.max(this.cursor.y, origin);
                            const drawable = getGridBottom() - cursorY;
                            if (drawable + this.layoutTolerance < this.gridCellHeight) return 0;
                            return Math.floor((drawable - this.gridCellHeight + this.layoutTolerance) / gridFlowStep) + 1;
                        };
                        const moveToNextGridColumn = () => {
                            closeProperLine();
                            if (sectionOverflowClip) {
                                if (mergedStyleFlow) {
                                    if (mergedStyleFlow.columnIndex + 1 >= mergedStyleFlow.maxColumns) return false;
                                    mergedStyleFlow.columnIndex++;
                                    this.isParagraphFirstColumn = false;
                                    this.cursor.y = getFlowGridTop();
                                    gridFlowStep = this.gridStep;
                                    return true;
                                }
                                if (!moveTextWithinSectionSpan()) return false;
                                const movedGeo = this.getColGeometry(this.absoluteCol);
                                lineXOffset = movedGeo.colW - (movedGeo.colW - F) / 2 + 2;
                                return true;
                            }
                            nextColWithIndent();
                            const movedGeo = this.getColGeometry(this.absoluteCol);
                            lineXOffset = movedGeo.colW - (movedGeo.colW - F) / 2 + 2;
                            return true;
                        };
                        const snapToNextGridAfterStyle = () => {
                            const gridTop = getGridTop();
                            const gridBottom = getGridBottom();
                            const relativeY = Math.max(0, this.cursor.y - gridTop);
                            const nextGridY = gridTop + Math.ceil((relativeY - 0.0001) / gridFlowStep) * gridFlowStep;

                            if (nextGridY + this.gridCellHeight > gridBottom + this.layoutTolerance) {
                                if (!moveToNextGridColumn()) return false;
                            } else {
                                this.cursor.y = nextGridY;
                            }
                            ungridStyleActive = false;
                            styleState.gridBreakPending = false;
                            return true;
                        };
                        const getMergedStyleFlow = (item, itemStyle) => {
                            // A style's horizontal/vertical alignment belongs
                            // to a bounded merged-cell flow.  Previously a
                            // flow was created only when hCharSpacing was
                            // present, so choosing a non-default alignment
                            // alone had no observable effect.  Use the
                            // physical column width as the default step; an
                            // explicit hCharSpacing still replaces it for the
                            // horizontal arrangement.
                            if (!sectionOverflowClip || !sectionMergeRef || !itemStyle) {
                                mergedStyleFlow = null;
                                return null;
                            }

                            const rawSpacing = Number(itemStyle.hCharSpacing);
                            const hasHorizontalSpacing = Number.isFinite(rawSpacing) && rawSpacing > 0;
                            const needsAlignmentFlow = itemStyle.horizontalAlign !== 'center' || itemStyle.verticalAlign !== 'center';
                            // A plain color/font style must keep the normal
                            // balancing quotas of a split table.  The default
                            // center/center alignment is already provided by
                            // the merge centering pass, so only an explicit
                            // horizontal spacing or a non-default alignment
                            // opts that run into the virtual style flow.
                            if (!hasHorizontalSpacing && !needsAlignmentFlow) {
                                mergedStyleFlow = null;
                                return null;
                            }
                            const baseGeo = this.getColGeometry(sectionBaseCol);
                            const lastGeo = this.getColGeometry(sectionBaseCol + sectionSpan - 1);
                            const step = hasHorizontalSpacing
                                ? F * rawSpacing
                                : baseGeo.colW;
                            const startCenterX = baseGeo.baseX + baseGeo.colW / 2;
                            const minCenterX = lastGeo.baseX + F / 2;
                            // With the physical column step there is exactly
                            // one style-flow slot per merged column.  Do not
                            // derive that count from glyph width (which would
                            // under-count whenever a column is wider than the
                            // font).  Explicit hCharSpacing keeps the packed
                            // width calculation used by the horizontal flow.
                            const maxColumns = hasHorizontalSpacing
                                ? Math.max(1, Math.floor((startCenterX - minCenterX + 0.001) / step) + 1)
                                : Math.max(1, sectionSpan);
                            const styleKey = String(item?.styleId || 'inline');
                            if (!mergedStyleFlow || mergedStyleFlow.styleKey !== styleKey || Math.abs(mergedStyleFlow.step - step) > 0.001) {
                                mergedStyleFlow = {
                                    id: `${currentSectionIndex}:${this.output.texts.length}`,
                                    styleKey,
                                    step,
                                    maxColumns,
                                    columnIndex: 0,
                                    startCenterX
                                };
                            }
                            return mergedStyleFlow;
                        };
                        const getCustomFlowCenterX = (item, itemStyle) => {
                            const mergedFlow = getMergedStyleFlow(item, itemStyle);
                            if (mergedFlow) return mergedFlow.startCenterX - mergedFlow.columnIndex * mergedFlow.step;
                            // hCharSpacing is deliberately ignored by ordinary
                            // one-character-per-grid body text.  It is consumed
                            // only by the merged flow above (and by the
                            // dedicated double-column small-note layout).
                            return null;
                        };
                        const forceNextGridColumnWithIndent = () => {
                            this.currentIndentH += gridFlowStep;
                            if (sectionOverflowClip) sectionExtraIndentH += gridFlowStep;
                            if (!moveToNextGridColumn()) return false;
                            return true;
                        };
                        // Return the complete forbidden-start run after the
                        // current item, including punctuation at the start of
                        // adjacent style/variable runs. This keeps the
                        // decision independent of parser run boundaries.
                        const getFollowingForbiddenStartCount = (startIdx) => {
                            if (!this.config.format.punctAvoidHeadTail) return 0;
                            let count = 0;
                            for (let i = startIdx; i < runChars.length; i++) {
                                if (runChars[i].isStyleLineBreak) return count;
                                const nextChar = runChars[i].c;
                                if (isZeroAdvancePunctuation(nextChar)) continue;
                                if (this.config.format.onlyPeriod && !this.hasForcedCornerAdvance() && /^[，。、,\.．！?？!;；:：]$/.test(nextChar)) return count;
                                if (!PUNCT_RULES.FORBIDDEN_START.test(nextChar)) return count;
                                count++;
                            }
                            return count + nextRunForbiddenPrefix;
                        };
                        const squeezeGridColumnForTrailingPunctuation = (cellsNeeded) => {
                            if (!this.config.format.punctAvoidHeadTail || cellsNeeded <= 0 || gridFlowStep <= 0) return false;
                            const gridTop = getFlowGridTop();
                            const gridBottom = getGridBottom();
                            const maxStartY = gridBottom - this.gridCellHeight;
                            const currentSlot = Math.max(0, (this.cursor.y - gridTop) / gridFlowStep);
                            const lastRequiredSlot = currentSlot + cellsNeeded - 1;
                            if (lastRequiredSlot <= 0 || maxStartY <= gridTop) return false;

                            const squeezedStep = (maxStartY - gridTop) / lastRequiredSlot;
                            if (!Number.isFinite(squeezedStep) || squeezedStep <= 0 || squeezedStep >= gridFlowStep - 0.0001) return false;

                            const scale = squeezedStep / gridFlowStep;
                            const remapY = y => gridTop + (y - gridTop) * scale;
                            for (let index = startState.textIdx; index < this.output.texts.length; index++) {
                                const text = this.output.texts[index];
                                if (
                                    text.col === this.absoluteCol &&
                                    text.sectionIdx === currentSectionIndex &&
                                    !text.styleBreaksGrid &&
                                    Number.isFinite(text.y) &&
                                    text.y >= gridTop - this.layoutTolerance &&
                                    text.y <= this.cursor.y + this.layoutTolerance
                                ) text.y = remapY(text.y);
                            }
                            for (let index = startState.lineIdx; index < this.output.lines.length; index++) {
                                const line = this.output.lines[index];
                                if (line.col !== this.absoluteCol || line.sectionIdx !== currentSectionIndex || line.textType !== 'normal') continue;
                                line.startY = remapY(line.startY);
                                line.endY = remapY(line.endY);
                            }
                            if (activeProperLine?.col === this.absoluteCol && activeProperLine.sectionIdx === currentSectionIndex) {
                                activeProperLine.startY = remapY(activeProperLine.startY);
                                activeProperLine.endY = remapY(activeProperLine.endY);
                            }

                            this.cursor.y = remapY(this.cursor.y);
                            gridFlowStep = squeezedStep;
                            return true;
                        };
                        const hasGridContentInCurrentColumn = () => {
                            const origin = getFlowGridTop();
                            return this.output.texts.slice(startState.textIdx).some(text =>
                                text.col === this.absoluteCol &&
                                text.sectionIdx === currentSectionIndex &&
                                !text.styleBreaksGrid &&
                                text.char !== '' &&
                                Number.isFinite(text.y) &&
                                text.y >= origin - this.layoutTolerance
                            );
                        };
                        const prepareGridPlacement = (itemIdx, char, options = {}) => {
                            const { styleBreaksGrid = false, noGridAdvance = false, baseCells = 1 } = options;
                            if (styleBreaksGrid || noGridAdvance) return { ok: true, trailingForbidden: 0, squeezed: false };

                            const trailingForbidden = getFollowingForbiddenStartCount(itemIdx + 1);
                            const reservedCells = this.config.format.punctAvoidHeadTail ? trailingForbidden : 0;
                            const cellsNeeded = Math.max(0, baseCells + reservedCells);
                            if (getRemainingGridCells() >= cellsNeeded) {
                                return { ok: true, trailingForbidden, squeezed: false };
                            }

                            // Compression is only meaningful after the column
                            // has content. At the true column origin, move to
                            // the next column when even the first cell cannot
                            // fit, preserving normal grid flow.
                            const currentForbiddenStart = PUNCT_RULES.FORBIDDEN_START.test(String(char || ''));
                            if ((trailingForbidden > 0 || currentForbiddenStart) && hasGridContentInCurrentColumn() && this.cursor.y > getFlowGridTop() + 0.001 && squeezeGridColumnForTrailingPunctuation(cellsNeeded)) {
                                return { ok: true, trailingForbidden, squeezed: true };
                            }
                            if (!moveToNextGridColumn()) return { ok: false, trailingForbidden, squeezed: false };
                            return { ok: true, trailingForbidden, squeezed: false, moved: true };
                        };
                        const advanceFlowSpace = (advance, itemF, itemSpacing, unit) => {
                            if (sectionOverflowClip) {
                                const localColIdx = Math.max(0, Math.min(sectionTextColsLimit - 1, this.absoluteCol - sectionBaseCol));
                                if (!mergedStyleFlow && sectionTextQuotas && sectionTextColCounts[localColIdx] > 0 && sectionTextColCounts[localColIdx] + unit > sectionTextQuotas[localColIdx] + 0.001) {
                                    if (moveTextWithinSectionSpan(true)) {
                                        const movedGeo = this.getColGeometry(this.absoluteCol);
                                        lineXOffset = movedGeo.colW - (movedGeo.colW - itemF) / 2 + 2;
                                    } else return false;
                                } else if (!sectionAutoHeight && this.cursor.y + this.gridCellHeight > sectionContentBottomY + this.layoutTolerance) {
                                    if (moveToNextGridColumn()) {
                                        const movedGeo = this.getColGeometry(this.absoluteCol);
                                        lineXOffset = movedGeo.colW - (movedGeo.colW - itemF) / 2 + 2;
                                    } else return false;
                                }
                                const placedLocalColIdx = Math.max(0, Math.min(sectionTextColsLimit - 1, this.absoluteCol - sectionBaseCol));
                                sectionTextColCounts[placedLocalColIdx] += unit;
                            } else if (this.cursor.y + this.gridCellHeight > this.getLayerBottom() + this.layoutTolerance) {
                                closeProperLine();
                                nextColWithIndent();
                                let { colW: newColW } = this.getColGeometry(this.absoluteCol);
                                lineXOffset = newColW - (newColW - itemF) / 2 + 2;
                            }
                            this.cursor.y += advance;
                            return true;
                        };
                        runChars.forEach((item, itemIdx) => {
                            let char = item.c;
                            const itemStyle = getItemStyle(item);
                            const itemF = getStyledSize(item, F);
                            const itemSpacing = getStyledSpacing(item, this.actualSpacing);
                            const itemFont = getStyledFont(item, this.config.fontsObj?.mainF);
                            const styleBreaksGrid = hasVerticalStyleSpacing(itemStyle);
                            getMergedStyleFlow(item, itemStyle);
                            if (!styleBreaksGrid && (ungridStyleActive || prevTextObj?.styleBreaksGrid)) {
                                if (!snapToNextGridAfterStyle()) return;
                            }
                            if (char === '^' && !item.isLiteralRaw) {
                                this.currentVolume = '';
                                this.currentChapterVolumeOverride = null;
                                this.currentChapterStartSpread = null;
                                const sIdx = Math.floor(this.absoluteCol / this.frame.colsPerSpread);
                                if (!this.output.spreads[sIdx]) this.output.spreads[sIdx] = {};
                                const side = this.ensureSideMeta();
                                side.volume = '';
                                delete side.volumeOverride;
                                side.volumeOverrideScope = 'cleared';
                                side.hasLocalVolumeDefinition = true;
                                if (this.cursor.side % 2 === 0) {
                                    this.output.spreads[sIdx].volume = '';
                                    delete this.output.spreads[sIdx].volumeOverride;
                                    delete this.output.spreads[sIdx].volumeOverrideScope;
                                }
                                return;
                            }
                            if (item.isStyleLineBreak) {
                                moveToNextGridColumn();
                                return;
                            }
                            if (['%', '~'].includes(char) && !item.isLiteralRaw) { this.breakToNewSide(char); return; }
                            if (char === '$' && !item.isLiteralRaw) {
                                forceNextGridColumnWithIndent();
                                return;
                            }
                            if (char === ' ' || char === '\t' || char === '　' || (char === '@' && !item.isLiteralRaw)) {
                                if (styleBreaksGrid) {
                                    const advance = Math.max(0.01, itemF + itemSpacing);
                                    if (this.cursor.y + itemF > getGridBottom() + this.layoutTolerance && !moveToNextGridColumn()) return;
                                    const spaceStartY = this.cursor.y;
                                    this.cursor.y += advance;
                                    this.output.texts.push({
                                        type: 'space', char: '', col: this.absoluteCol,
                                        y: spaceStartY, size: advance,
                                        mergeRef: sectionMergeRef, sectionIdx: currentSectionIndex
                                    });
                                    ungridStyleActive = true;
                                    styleState.gridBreakPending = true;
                                    return;
                                }
                                if (!prepareGridPlacement(itemIdx, char, { baseCells: 1 }).ok) return;
                                const spaceAdvance = gridFlowStep;
                                if (advanceFlowSpace(spaceAdvance, itemF, itemSpacing, 1) === false) return;
                                // 空格没有字形可绘制，但仍然是一个真实的网格单元。
                                // 保留一个不可见占位，供后续的居中/沉底对齐计算内容边界，
                                // 尤其是分格末尾的 `@`（例如 `==上文=-下文@`）。
                                this.output.texts.push({
                                    type: 'space', char: '', col: this.absoluteCol,
                                    y: this.cursor.y - spaceAdvance, size: spaceAdvance,
                                    mergeRef: sectionMergeRef, sectionIdx: currentSectionIndex
                                });
                                return;
                            }
                        if (char === '︹') {
                                this.output.texts.push(applyTextStyle({ 
                                    col: this.absoluteCol, 
                                    y: this.cursor.y, 
                                    char, 
                                    size: itemF, 
                                    type: 'draw_kuo', 
                                    renderYOffset: -0.04 * itemF, 
                                    mergeRef: sectionMergeRef, 
                                    sectionIdx: currentSectionIndex, 
                                    fontName: itemStyle?.fontName || '' 
                                }, item));
                                return;
                            }
                            if (char === '︺') {
                                this.output.texts.push(applyTextStyle({ 
                                    col: this.absoluteCol, 
                                    y: this.cursor.y, 
                                    char, 
                                    size: itemF, 
                                    type: 'draw_kuo', 
                                    renderYOffset: -itemSpacing + 0.04 * itemF, 
                                    mergeRef: sectionMergeRef, 
                                    sectionIdx: currentSectionIndex, 
                                    fontName: itemStyle?.fontName || '' 
                                }, item));
                                return; 
                            }
                            // 冒号不是角标点，不能像逗号/句号一样从正文流中吞掉。
                            if (this.config.format.onlyPeriod && !this.hasForcedCornerAdvance() && /^[，。、,\.．！?？!\;；]$/.test(char)) {
                                if (prevTextObj) {
                                    if (/^[。\.．！?？!]$/.test(char)) prevTextObj.isCornerCircle = true;
                                    else prevTextObj.isCornerDunhao = true;
                                }
                                return;
                            }
                            this.pendingBlankSide = null;

                            const rawMetrics = this.getPunctMetrics(char, itemF, 1.0, itemFont, itemSpacing);
                            const m = this.getBodyGridMetrics(rawMetrics, styleBreaksGrid);
                            const noGridAdvance = !!m.noGridAdvance;

                            const placement = prepareGridPlacement(itemIdx, char, {
                                styleBreaksGrid,
                                noGridAdvance,
                                baseCells: this.config.format.punctAvoidHeadTail && PUNCT_RULES.OPEN_BRACKETS.test(char) ? 2 : 1
                            });
                            if (!placement.ok) return;
                            if (!noGridAdvance && !styleBreaksGrid && !m.breaksGrid) m.advanceY = gridFlowStep;

                            const flowCursorY = this.cursor.y;
                            let charStartY = Math.max(getGridTop(), flowCursorY + m.preY);
                            if (noGridAdvance) {
                                // A zero-advance mark is painted in the last
                                // available cell when the flow cursor has
                                // already reached the section bottom. It does
                                // not create a new row or leak into the next
                                // split section.
                                const lastCellTop = Math.max(getGridTop(), getGridBottom() - this.gridCellHeight);
                                charStartY = Math.min(charStartY, lastCellTop);
                            }
                            this.cursor.y = noGridAdvance ? flowCursorY : charStartY;

                            const localColIdx = Math.max(0, Math.min(sectionTextColsLimit - 1, this.absoluteCol - sectionBaseCol));
                            const layoutUnit = getLayoutUnit(char);
                            if (!mergedStyleFlow && sectionTextQuotas && sectionTextColCounts[localColIdx] > 0 && sectionTextColCounts[localColIdx] + layoutUnit > sectionTextQuotas[localColIdx] + 0.001) {
                                if (moveTextWithinSectionSpan(true)) {
                                    const movedGeo = this.getColGeometry(this.absoluteCol);
                                    lineXOffset = movedGeo.colW - (movedGeo.colW - itemF) / 2 + 2;
                                    charStartY = Math.max(sectionContentTopY, this.cursor.y + m.preY);
                                    this.cursor.y = charStartY;
                                } else if (sectionOverflowClip) return;
                            }
                            const renderCellHeight = noGridAdvance ? 0 : (m.cellHeight || itemF);
                            if (!noGridAdvance && !sectionAutoHeight && sectionOverflowClip && this.cursor.y + renderCellHeight > sectionContentBottomY + this.layoutTolerance) {
                                if (moveToNextGridColumn()) {
                                    const movedGeo = this.getColGeometry(this.absoluteCol);
                                    lineXOffset = movedGeo.colW - (movedGeo.colW - itemF) / 2 + 2;
                                    charStartY = Math.max(sectionContentTopY, this.cursor.y + m.preY);
                                    this.cursor.y = charStartY;
                                } else return;
                            } else if (!noGridAdvance && !sectionOverflowClip && this.cursor.y + renderCellHeight > this.getLayerBottom() + this.layoutTolerance) {
                                if (!moveToNextGridColumn()) return;
                                charStartY = Math.max(this.getLayerTop(), this.cursor.y + m.preY);
                                this.cursor.y = charStartY;
                            }

                            const hCharSpacing = itemStyle?.hCharSpacing ?? null;
                            const flowCenterX = getCustomFlowCenterX(item, itemStyle);
                            const mergedFlowId = mergedStyleFlow?.id || null;
                            const renderY = noGridAdvance ? charStartY : this.cursor.y;

                              let currentTextObj = applyTextStyle({
                                col: this.absoluteCol, y: renderY, char, size: m ? m.renderSize : itemF,
                                type: (m.isCorner || m.isRot || m.isRot90 || m.isCen) ? 'punctuation' : (run.type || 'normal'),
                                isYinke: item.isYinke, fontName: itemStyle?.fontName || '', hCharSpacing: hCharSpacing,
                                flowCenterX, styleBreaksGrid,
                                mergedFlowId,
                                styleHorizontalAlign: mergedFlowId ? itemStyle?.horizontalAlign : null,
                                styleVerticalAlign: mergedFlowId ? itemStyle?.verticalAlign : null,
                                styleContainerLeft: mergedFlowId ? this.getColGeometry(sectionBaseCol + sectionSpan - 1).baseX : null,
                                styleContainerRight: mergedFlowId ? this.getColGeometry(sectionBaseCol).baseX + this.getColGeometry(sectionBaseCol).colW : null,
                                styleContainerTop: mergedFlowId ? sectionContentTopY : null,
                                styleContainerBottom: mergedFlowId ? sectionContentBottomY : null,
                                isCornerCircle: item.isCornerCircle, isCornerDunhao: item.isCornerDunhao,
                                m: m, isCorner: m.isCorner, isRotate: m.isRot, isRotate90: m.isRot90, isCenter: m.isCen,
                                mergeRef: sectionMergeRef, sectionIdx: currentSectionIndex, isCircled: item.circ && !m.isCorner && !m.isRot && !m.isRot90 && !m.isCen
                            }, item);
                            this.output.texts.push(currentTextObj); prevTextObj = currentTextObj;
                            const placedLocalColIdx = Math.max(0, Math.min(sectionTextColsLimit - 1, this.absoluteCol - sectionBaseCol));
                            sectionTextColCounts[placedLocalColIdx] += layoutUnit;

                            if (item.isProper) updateProperLine(renderY, renderY + m.advanceY, this.absoluteCol, currentSectionIndex, lineXOffset, 'normal', hCharSpacing, sectionMergeRef, flowCenterX, itemF / 2 + 2);
                            else closeProperLine();

                            this.cursor.y += m.advanceY;
                            if (styleBreaksGrid) {
                                ungridStyleActive = true;
                                styleState.gridBreakPending = true;
                            }
                        });
                        closeProperLine();
                    }
                }
                finalizeSectionTextCentering();
                if (para.suppressSectionLines) {
                    const nextSegmentCol = this.cursor.y + F > this.getLayerBottom() + this.layoutTolerance
                        ? this.absoluteCol + 1
                        : this.absoluteCol;
                    implicitSplitLastCol = Math.max(implicitSplitLastCol, nextSegmentCol);
                }
            }

            if (hasTableSections) {
                if (detachedAfterContainerImage) {
                } else if (continuedSectionEndCol !== null) {
                    setAbsoluteCol(continuedSectionEndCol);
                } else if (para.suppressSectionLines) {
                    setAbsoluteCol(implicitSplitLastCol);
                } else {
                    const maxSectionSpan = sections.reduce((max, section) => Math.max(max, getSectionSpan(section, para, baseColForSections)), 1);
                    setAbsoluteCol(baseColForSections + maxSectionSpan - 1);
                }
                this.cursor.y = sectionBounds.length ? sectionBounds[sectionBounds.length - 1].bottom : this.cursor.y;
            }

            if (sectionAligns.some(a => ['center', 'bottom', 'justify'].includes(a))) {
                // Build the alignment index once. The previous implementation
                // rescanned every text/line/image for every column, which made
                // a long centered or justified paragraph approach O(n^2).
                const alignmentBuckets = new Map();
                const getAlignmentBucket = col => {
                    let bucket = alignmentBuckets.get(col);
                    if (!bucket) {
                        bucket = {
                            active: false,
                            sections: new Map(),
                            unsectioned: { texts: [], lines: [], images: [], minY: Infinity, maxY: -Infinity }
                        };
                        alignmentBuckets.set(col, bucket);
                    }
                    return bucket;
                };
                const getSectionBucket = (bucket, item) => {
                    if (item.sectionIdx === undefined) return bucket.unsectioned;
                    let section = bucket.sections.get(item.sectionIdx);
                    if (!section) {
                        section = { texts: [], lines: [], images: [], minY: Infinity, maxY: -Infinity };
                        bucket.sections.set(item.sectionIdx, section);
                    }
                    return section;
                };
                const addAlignmentItem = (kind, col, item, activatesColumn = false) => {
                    const bucket = getAlignmentBucket(col);
                    const section = getSectionBucket(bucket, item);
                    section[kind].push(item);
                    if (activatesColumn) bucket.active = true;
                    let minY = Infinity, maxY = -Infinity;
                    if (kind === 'texts') {
                        minY = item.y;
                        maxY = item.y + (item.size || 0);
                    } else if (kind === 'lines') {
                        minY = item.startY;
                        maxY = item.endY;
                    } else if (kind === 'images') {
                        minY = item.y;
                        maxY = item.y + item.h;
                    }
                    section.minY = Math.min(section.minY, minY);
                    section.maxY = Math.max(section.maxY, maxY);
                };
                for (let i = startState.textIdx; i < this.output.texts.length; i++) {
                    const item = this.output.texts[i];
                    addAlignmentItem('texts', item.col, item, true);
                }
                for (let i = startState.lineIdx; i < this.output.lines.length; i++) {
                    const item = this.output.lines[i];
                    addAlignmentItem('lines', item.col, item);
                }
                for (let i = startState.imgIdx; i < this.output.images.length; i++) {
                    const item = this.output.images[i];
                    if (!item.stretch) addAlignmentItem('images', item.startCol, item, true);
                }

                const collectAlignmentItems = (sectionItems, unsectionedItems) => {
                    if (!unsectionedItems.length || !sectionItems.length) return sectionItems.length ? sectionItems : unsectionedItems;
                    // Unsectioned entries are layout placeholders (for
                    // example spaces), so their relative order has no effect
                    // on painted glyphs or alignment bounds.
                    return sectionItems.concat(unsectionedItems);
                };

                alignmentBuckets.forEach((bucket, col) => {
                    if (!bucket.active) return;
                    const colsToShift = bucket;
                    const maxSections = splitsCount > 0 ? (splitsCount + 1) : 1;
                    for (let sIdx = 0; sIdx < maxSections; sIdx++) {
                        const currentAlign = sectionAligns[sIdx] || 'top';
                        if (!['center', 'bottom', 'justify'].includes(currentAlign)) continue;

                        const sectionItems = colsToShift.sections.get(sIdx) || { texts: [], lines: [], images: [], minY: Infinity, maxY: -Infinity };
                        const unsectionedItems = colsToShift.unsectioned;
                        const items = {
                            texts: collectAlignmentItems(sectionItems.texts, unsectionedItems.texts),
                            lines: collectAlignmentItems(sectionItems.lines, unsectionedItems.lines),
                            images: collectAlignmentItems(sectionItems.images, unsectionedItems.images)
                        };
                        const maxY = Math.max(sectionItems.maxY, unsectionedItems.maxY);
                        if (items.texts.length === 0 && items.images.length === 0) continue;

                        // Text/image bounds already describe the painted
                        // content. The flow cursor is an advance position
                        // (one grid step past the last glyph), so including it
                        // here makes the final forced-break column appear
                        // slightly higher than sibling columns when centered.

                        const side = Math.floor(col / this.config.page.cols);
                        const halfSplitY = this.getHalfSplitY(side);
                        let baseBottom = this.output.halfSides.has(side) ? (maxY <= halfSplitY ? halfSplitY : this.frame.bottom) : this.frame.bottom;
                        let sectionBottom = splitsCount > 0 ? sectionBounds[sIdx].bottom : baseBottom;

                        if (currentAlign === 'justify') {
                            let sepIdx = items.texts.findIndex(t => t.type === 'sep');
                            if (sepIdx !== -1) {
                                let sepY = items.texts[sepIdx].y;
                                let bottomTexts = items.texts.slice(sepIdx + 1);
                                let bottomImages = items.images.filter(img => img.y >= sepY);

                                if (bottomTexts.length > 0 || bottomImages.length > 0) {
                                    let bottomMaxY = -Infinity;
                                    if (bottomTexts.length > 0) bottomMaxY = Math.max(bottomMaxY, ...bottomTexts.map(t => t.y + (t.size || 0)));
                                    if (bottomImages.length > 0) bottomMaxY = Math.max(bottomMaxY, ...bottomImages.map(img => img.y + img.h));

                                    let shift = sectionBottom - bottomMaxY;
                                    if (shift > 0) {
                                        bottomTexts.forEach(t => t.y += shift);
                                        bottomImages.forEach(img => img.y += shift);
                                    }
                                }
                            }
                        } else {
                            if (splitsCount > 0) {
                                let sectionTop = sectionBounds[sIdx].top;
                                let minY = Math.min(sectionItems.minY, unsectionedItems.minY);
                                let contentHeight = maxY - minY;
                                let desiredTop = currentAlign === 'bottom'
                                    ? sectionBottom - contentHeight
                                    : sectionTop + (sectionBottom - sectionTop - contentHeight) / 2;
                                const shift = desiredTop - minY;
                                items.texts.forEach(t => t.y += shift);
                                items.lines.forEach(l => { l.startY += shift; l.endY += shift; });
                                items.images.forEach(img => img.y += shift);
                                if (col === this.absoluteCol && sIdx === maxSections - 1) this.cursor.y += shift;
                            } else {
                                let targetBottom = sectionBottom;
                                const shift = targetBottom - Math.max(0, maxY);
                                if (shift > 0) {
                                    const offsetAlign = currentAlign === 'bottom' ? shift : shift / 2;
                                    items.texts.forEach(t => t.y += offsetAlign);
                                    items.lines.forEach(l => { l.startY += offsetAlign; l.endY += offsetAlign; });
                                    items.images.forEach(img => img.y += offsetAlign);
                                    if (col === this.absoluteCol && sIdx === maxSections - 1) this.cursor.y += offsetAlign;
                                }
                            }
                        }
                    }
                });
            }

            const mergedStyleGroups = new Map();
            for (let i = startState.textIdx; i < this.output.texts.length; i++) {
                const text = this.output.texts[i];
                if (!text.mergedFlowId || !Number.isFinite(text.flowCenterX)) continue;
                if (!mergedStyleGroups.has(text.mergedFlowId)) mergedStyleGroups.set(text.mergedFlowId, []);
                mergedStyleGroups.get(text.mergedFlowId).push(text);
            }
            mergedStyleGroups.forEach(items => {
                const first = items[0];
                const left = first.styleContainerLeft;
                const right = first.styleContainerRight;
                const top = first.styleContainerTop;
                const bottom = first.styleContainerBottom;
                if (![left, right, top, bottom].every(Number.isFinite)) return;

                const minX = Math.min(...items.map(item => item.flowCenterX - item.size / 2));
                const maxX = Math.max(...items.map(item => item.flowCenterX + item.size / 2));
                let horizontalShift = 0;
                if (first.styleHorizontalAlign === 'left') horizontalShift = left - minX;
                else if (first.styleHorizontalAlign === 'center') horizontalShift = (left + right - minX - maxX) / 2;
                else horizontalShift = right - maxX;
                items.forEach(item => { item.flowCenterX += horizontalShift; });

                const minY = Math.min(...items.map(item => item.y));
                const maxY = Math.max(...items.map(item => item.y + item.size));
                let verticalShift = 0;
                if (first.styleVerticalAlign === 'center') verticalShift = (top + bottom - minY - maxY) / 2;
                else if (first.styleVerticalAlign === 'bottom') verticalShift = bottom - maxY;
                else verticalShift = top - minY;
                items.forEach(item => { item.y += verticalShift; });
            });
            if (para.isHalfPage) {
                let hasContent = this.cursor.colInSide > 0 || this.cursor.y > this.getLayerTop() + this.currentIndentH;
                if (hasContent) {
                    if (this.cursor.layer === 'UPPER') {
                        this.cursor.layer = 'LOWER';
                    } else if (this.cursor.layer === 'LOWER') {
                        this.cursor.side++;
                        this.cursor.layer = 'FULL';
                    }
                    this.cursor.colInSide = 0;
                    this.cursor.y = this.getLayerTop();
                }
            }
        }

        closeProperLine();
        if (hiddenHLineSegments.length && this.output.hLines?.length) {
            const visibleLines = [];
            for (const line of this.output.hLines) {
                let pieces = [{ ...line }];
                for (const hidden of hiddenHLineSegments) {
                    if (Math.floor(line.startCol / this.frame.colsPerSpread) !== Math.floor(hidden.startCol / this.frame.colsPerSpread) || Math.abs(line.y - hidden.y) >= 0.01) continue;
                    const nextPieces = [];
                    for (const piece of pieces) {
                        const pieceStart = piece.startCol;
                        const pieceEnd = piece.startCol + piece.span;
                        const hiddenStart = hidden.startCol;
                        const hiddenEnd = hidden.startCol + hidden.span;
                        const overlapStart = Math.max(pieceStart, hiddenStart);
                        const overlapEnd = Math.min(pieceEnd, hiddenEnd);
                        if (overlapEnd <= overlapStart) {
                            nextPieces.push(piece);
                            continue;
                        }
                        if (pieceStart < overlapStart) nextPieces.push({ ...piece, span: overlapStart - pieceStart });
                        if (overlapEnd < pieceEnd) nextPieces.push({ ...piece, startCol: overlapEnd, span: pieceEnd - overlapEnd });
                    }
                    pieces = nextPieces;
                    if (!pieces.length) break;
                }
                visibleLines.push(...pieces.filter(piece => piece.span > 0));
            }
            this.output.hLines = visibleLines;
        }
        if (this.output.hLines?.length) {
            const groups = new Map();
            for (const line of this.output.hLines) {
                const key = `${Math.floor(line.startCol / this.frame.colsPerSpread)}:${line.y.toFixed(3)}`;
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push({ ...line });
            }
            const merged = [];
            groups.forEach(lines => {
                lines.sort((a, b) => a.startCol - b.startCol);
                for (const line of lines) {
                    const last = merged[merged.length - 1];
                    if (
                        last &&
                        Math.floor(last.startCol / this.frame.colsPerSpread) === Math.floor(line.startCol / this.frame.colsPerSpread) &&
                        Math.floor(last.startCol / this.config.page.cols) === Math.floor(line.startCol / this.config.page.cols) &&
                        Math.abs(last.y - line.y) < 0.01 &&
                        line.startCol <= last.startCol + last.span
                    ) {
                        const endCol = Math.max(last.startCol + last.span, line.startCol + line.span);
                        last.span = endCol - last.startCol;
                    } else {
                        merged.push(line);
                    }
                }
            });
            this.output.hLines = merged;
        }

        const colsPerSide = Math.max(1, Number(this.config.page.cols) || 1);
        // 未被任何段落触及的面（如 % 强制换面产生的空白面）沿用前一面的归属，
        // 与旧版“正文起点之后皆属正文”的页面设计绑定语义保持一致。
        let maxSide = -1;
        for (const k of Object.keys(this.output.sides)) maxSide = Math.max(maxSide, Number(k));
        for (const k of Object.keys(this.output.specialSides)) maxSide = Math.max(maxSide, Number(k));
        for (const k of Object.keys(this.output.sideRegions)) maxSide = Math.max(maxSide, Number(k));
        for (const entry of this.output.paraStarts) maxSide = Math.max(maxSide, Math.floor((Number(entry.col) || 0) / colsPerSide));
        let prevRegion = 'body';
        for (let s = 0; s <= maxSide; s++) {
            if (this.output.specialSides[s]) continue;
            const r = this.output.sideRegions[s];
            if (r) { prevRegion = r; continue; }
            this.output.sideRegions[s] = prevRegion;
        }

        this.output.bodyParaStarts = [];
        this.output.bodySideIndices = [];
        this.output.tocSideIndices = [];
        let firstTocSide = null;
        let firstBodySide = null;
        for (let i = 0; i < this.output.paraStarts.length; i++) {
            const entry = this.output.paraStarts[i];
            const entrySide = Math.floor((Number(entry.col) || 0) / colsPerSide);
            const bIdx = bodyIndexOf(i);
            if (bIdx >= 0) {
                entry.bodyIndex = bIdx;
                this.output.bodyParaStarts[bIdx] = entry;
                if (firstBodySide === null || entrySide < firstBodySide) firstBodySide = entrySide;
            } else if (isTocParaIdx(i)) {
                if (firstTocSide === null || entrySide < firstTocSide) firstTocSide = entrySide;
            }
        }
        for (let s = 0; s <= maxSide; s++) {
            const r = this.output.sideRegions[s];
            if (r === 'body') this.output.bodySideIndices.push(s);
            else if (r === 'toc') this.output.tocSideIndices.push(s);
        }
        this.output.tocStartSide = firstTocSide;
        this.output.bodyStartSide = firstBodySide;
        return this.output;
    }
}

class PDFRenderer {
    /** #12：共享度量引擎，避免每个跨页/内容块 new LayoutEngine 只为借用 getPunctMetrics */
    static _measureEngines = new WeakMap();
    static getMeasureEngine(config, rotatePunct = true) {
        let byMode = this._measureEngines.get(config);
        if (!byMode) { byMode = {}; this._measureEngines.set(config, byMode); }
        const k = rotatePunct ? 'rot' : 'plain';
        if (!byMode[k]) {
            byMode[k] = rotatePunct
                ? new LayoutEngine({ ...config, format: { ...config.format, rotatePunct: true } })
                : new LayoutEngine(config);
        }
        return byMode[k];
    }

    static getMaxSpreadIdx(layoutData, config) {
        let maxCol = -1;
        if (layoutData.texts && layoutData.texts.length > 0) {
            for (let i = 0; i < layoutData.texts.length; i++) {
                if (layoutData.texts[i].col > maxCol) maxCol = layoutData.texts[i].col;
            }
        }
        if (layoutData.images && layoutData.images.length > 0) {
            for (let i = 0; i < layoutData.images.length; i++) {
                const image = layoutData.images[i];
                const spreadIdx = Number.isFinite(image.spreadIdx)
                    ? image.spreadIdx
                    : Math.floor((Number(image.startCol) || 0) / (config.page.cols * 2));
                const col = Math.max(0, spreadIdx) * config.page.cols * 2;
                if (col > maxCol) maxCol = col;
            }
        }
        if (layoutData.overlayImages && layoutData.overlayImages.length > 0) {
            for (let i = 0; i < layoutData.overlayImages.length; i++) {
                const c = layoutData.overlayImages[i].side * config.page.cols;
                if (c > maxCol) maxCol = c;
            }
        }
        if (layoutData.sides) {
            for (const k in layoutData.sides) {
                const c = Number(k) * config.page.cols;
                if (c > maxCol) maxCol = c;
            }
        }

        return Math.floor(maxCol / (config.page.cols * 2));
    }

    static async render(layoutData, config, colors, doc, fonts, options = {}) {
        const { mainF, titleF, volF, pageF, coverF, paijiTitleF, paijiRightF, paijiLeftF, kanshuF, tanghaoF } = fonts;
        let maxSpreadIdx = this.getMaxSpreadIdx(layoutData, config);
        const cx = config.page.w, cw = config.page.centerW;
        const context = options.context || new RenderJobContext();
        const docImageCache = { bg: null, items: {}, job: context };
        const pageRange = options.pageRange || null;
        const shouldRenderPdfPage = (pageNo) => !pageRange || (pageNo >= pageRange.startPage && pageNo <= pageRange.endPage);

        // #11：图片/叠加图按跨页分桶一次，避免每跨页 filter 全量数组
        const bucket = (arr, keyFn) => {
            const m = new Map();
            for (const it of arr || []) { const k = keyFn(it); if (!m.has(k)) m.set(k, []); m.get(k).push(it); }
            return m;
        };
        layoutData.__imagesBySpread = bucket(layoutData.images, im => im.spreadIdx);
        layoutData.__halfBySpread = bucket(layoutData.halfPageImages, im => Math.floor(im.side / 2));
        layoutData.__overlaysBySpread = bucket((layoutData.overlayImages || []).filter(im => !im.isCover), im => `${im.spreadIdx}_${im.layer}`);

        const spreadDataMap = new Map();
        for (let i = 0; i < (layoutData.texts || []).length; i++) {
            const t = layoutData.texts[i];
            const sIdx = Math.floor(t.col / (config.page.cols * 2));
            if (!spreadDataMap.has(sIdx)) spreadDataMap.set(sIdx, { texts: [], lines: [], hLines: [] });
            spreadDataMap.get(sIdx).texts.push(t);
        }
        for (let i = 0; i < (layoutData.lines || []).length; i++) {
            const l = layoutData.lines[i];
            const sIdx = Math.floor(l.col / (config.page.cols * 2));
            if (!spreadDataMap.has(sIdx)) spreadDataMap.set(sIdx, { texts: [], lines: [], hLines: [] });
            spreadDataMap.get(sIdx).lines.push(l);
        }
        for (let i = 0; i < (layoutData.hLines || []).length; i++) {
            const hl = layoutData.hLines[i];
            const sIdx = Math.floor(hl.startCol / (config.page.cols * 2));
            if (!spreadDataMap.has(sIdx)) spreadDataMap.set(sIdx, { texts: [], lines: [], hLines: [] });
            spreadDataMap.get(sIdx).hLines.push(hl);
        }

        if (config.cover.mode !== 'none' && shouldRenderPdfPage(1)) await this.drawCover(doc, config, colors, coverF, docImageCache, layoutData);

        for (let s = 0; s <= maxSpreadIdx; s++) {
            const actualPdfPage = (config.cover.mode !== 'none' ? 2 : 1) + s;
            if (!shouldRenderPdfPage(actualPdfPage)) continue;

            EventBus.emit('progress', { text: pageRange ? '绘制局部内页...' : '绘制内页...', percent: 60 + (s / (maxSpreadIdx || 1)) * 35, detail: `第 ${s + 1}/${maxSpreadIdx + 1} 个跨页` });

            const page = doc.addPage([config.page.spreadW, config.page.h]);
            page.__fallbackFont = fonts._fallbackF || mainF || null;
            page.drawRectangle({ x: 0, y: 0, width: config.page.spreadW, height: config.page.h, color: colors.bg });
            await this.drawBackground(page, config, doc, docImageCache);
            await this.drawOverlayImages(page, s, layoutData, config, doc, docImageCache, 1);

            const typeR = layoutData.sides[s * 2] || 'normal', typeL = layoutData.sides[s * 2 + 1] || 'normal';
            const hasSpreadOverlays = layoutData.overlayImages?.some(im => im.spreadIdx === s);
            if (typeR === 'full-blank' && typeL === 'full-blank' && !layoutData.sideImages[s * 2] && !layoutData.sideImages[s * 2 + 1] && !hasSpreadOverlays) continue;

            this.drawFramework(page, config, colors, typeR, typeL, 0, s, layoutData, 0);
            if (config.page.singleFrame) {
                // 单页框架：版心自带内外框，版心元素绘制在版心内框以内（水平方向内缩 offset）
                const cOff = config.page.frameOffset;
                await this.drawCenterElements(page, config, colors, cx + cOff, Math.max(0, cw - cOff * 2), s, typeR, typeL, layoutData, mainF, doc, docImageCache);
            } else {
                await this.drawCenterElements(page, config, colors, cx, cw, s, typeR, typeL, layoutData, mainF, doc, docImageCache);
            }

            if (layoutData.specialSides) {
                if (layoutData.specialSides[s * 2]) await this.drawSpecialSide(page, config, colors, fonts, layoutData.specialSides[s * 2], 0, doc, docImageCache);
                if (layoutData.specialSides[s * 2 + 1]) await this.drawSpecialSide(page, config, colors, fonts, layoutData.specialSides[s * 2 + 1], 1, doc, docImageCache);
            }

            this.drawTextsAndLines(page, s, spreadDataMap.get(s) || { texts: [], lines: [], hLines: [] }, layoutData, config, colors, mainF, context);
            await this.drawLayoutImages(page, s, layoutData, config, doc, docImageCache);
            if (layoutData.ears) {
                if (layoutData.ears[s * 2]) this.drawBookEar(page, config, colors, layoutData.ears[s * 2], 0, mainF);
                if (layoutData.ears[s * 2 + 1]) this.drawBookEar(page, config, colors, layoutData.ears[s * 2 + 1], 1, mainF);
            }
            await this.drawSideImages(page, s, layoutData, config, doc, docImageCache);
            await this.drawHalfPageImages(page, s, layoutData, config, doc, docImageCache);
            await this.drawOverlayImages(page, s, layoutData, config, doc, docImageCache, 0);
        }

        if (!pageRange) {
            const _pageOff = config.cover.mode !== 'none' ? 1 : 0;
            const outlineItems = this.getSpreadOutlineItems(layoutData.chapters, _pageOff, config.page.cols * 2);
            this.buildPdfOutlines(doc, outlineItems);
        }

        try {
            return await doc.save();
        } catch (error) {
            Utils.logDocumentSaveFontFailure(error);
            throw error;
        }
    }

    static buildPdfOutlines(doc, items) {
        if (!items || !items.length) return;
        const { PDFName, PDFHexString, PDFNumber, PDFArray, PDFDict } = PDFLib;
        const context = doc.context, pages = doc.getPages(), valid = items.filter(it => it.pageIndex >= 0 && it.pageIndex < pages.length);
        if (!valid.length) return;
        const rootRef = context.nextRef(), refs = valid.map(() => context.nextRef());
        valid.forEach((item, i) => {
            const dest = PDFArray.withContext(context); dest.push(pages[item.pageIndex].ref); dest.push(PDFName.of('Fit'));
            const d = PDFDict.withContext(context);
            d.set(PDFName.of('Title'), PDFHexString.fromText(item.title));
            d.set(PDFName.of('Parent'), rootRef); d.set(PDFName.of('Dest'), dest);
            if (i > 0) d.set(PDFName.of('Prev'), refs[i - 1]);
            if (i < refs.length - 1) d.set(PDFName.of('Next'), refs[i + 1]);
            context.assign(refs[i], d);
        });
        const root = PDFDict.withContext(context);
        root.set(PDFName.of('Type'), PDFName.of('Outlines')); root.set(PDFName.of('First'), refs[0]);
        root.set(PDFName.of('Last'), refs[refs.length - 1]); root.set(PDFName.of('Count'), PDFNumber.of(valid.length));
        context.assign(rootRef, root);
        doc.catalog.set(PDFName.of('Outlines'), rootRef); doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
    }

    static getSpreadOutlineItems(chapters, pageOffset, colsPerSpread) {
        return (chapters || []).map(ch => ({ title: ch.title, pageIndex: pageOffset + Math.floor(ch.col / colsPerSpread) }));
    }

    static getSplitOutlineItems(chapters, pageOffset, colsPerSpread, cols, hasCover, splitTotal) {
        return (chapters || []).map(ch => {
            const spreadIdx = Math.floor(ch.col / colsPerSpread), mainPage = pageOffset + spreadIdx, isRight = (ch.col % colsPerSpread) < cols;
            let splitPage;
            if (!hasCover) splitPage = isRight ? 2 * mainPage : 2 * mainPage + 1;
            else if (mainPage === 0) splitPage = isRight ? splitTotal - 1 : 0;
            else splitPage = isRight ? 2 * (mainPage - 1) + 1 : 2 * (mainPage - 1) + 2;
            return { title: ch.title, pageIndex: splitPage };
        });
    }

    static async drawBackground(page, config, doc, cache) {
        const bgImgData = cache.job.getImage('bgImage');
        if (!cache.job.getBoolean('clr_bgImage') || !bgImgData?.bytes) return;
        try {
            if (!cache.bg) cache.bg = bgImgData.type === 'image/png' ? await doc.embedPng(bgImgData.bytes) : await doc.embedJpg(bgImgData.bytes);
            const bgImg = cache.bg, opacity = cache.job.getNumber('bgImageOpacity', 30) / 100, mode = cache.job.getString('bgImageMode', 'stretch');
            const sw = config.page.spreadW, sh = config.page.h, iw = bgImg.width, ih = bgImg.height;

            if (mode === 'stretch') page.drawImage(bgImg, { x: 0, y: 0, width: sw, height: sh, opacity });
            else if (mode === 'center') {
                const scale = Math.max(sw / iw, sh / ih);
                page.drawImage(bgImg, { x: (sw - iw * scale) / 2, y: (sh - ih * scale) / 2, width: iw * scale, height: ih * scale, opacity });
            } else {
                const scale = Math.min(sw / iw, sh / ih, 1), tw = Math.max(iw * scale, 80), th = Math.max(ih * scale, 80);
                for (let ty = 0; ty < sh; ty += th)
                    for (let tx = 0; tx < sw; tx += tw) page.drawImage(bgImg, { x: tx, y: ty, width: Math.min(tw, sw - tx), height: Math.min(th, sh - ty), opacity });
            }
        } catch (e) { }
    }

    static getCharRenderParams(char, centerX, y, size, pageH, m) {
        if (!m) return { x: centerX - size / 2, y: pageH - y - size, rot: 0 };
        if (m.isCorner) {
            let ox = m.offsetX || 0;
            let oy = m.offsetY || 0;
            return {
                x: centerX + size * 0.15 + ox,
                y: pageH - y - size * 0.18 - oy,
                rot: 0
            };
        }
        const isQuote = /[“‘”’"']/.test(char);
        const isNonCornerPunctuation = !m.isCorner && /^[\p{P}\p{S}]$/u.test(char);
        const TargetY = pageH - y - (m.cellHeight ? m.cellHeight / 2 : Math.min(m.inkAdvance, size) / 2);
        let TargetX = centerX, X, Y, rotateAngle = 0;

        if (!m.isRot && !m.isRot90 && !m.isEnRot) {
            if (isNonCornerPunctuation) {
                // 非旋转标点靠右对齐字格；按实际字形宽度补偿字体左右留白。
                X = TargetX + (size - m.inkW) / 2 - m.inkCX;
            } else {
                X = (!m.isCen && !m.isCorner) ? TargetX - size / 2 : TargetX - m.inkCX;
            }
            Y = TargetY - m.inkCY;
            if (/[！？!\?；：;:]/.test(char)) Y += size * 0.1;
        } else {
            rotateAngle = -90; if (isQuote) TargetX = centerX + size * 0.2;
            X = TargetX - m.inkCY; Y = TargetY + m.inkCX;
            if (/[「『]/.test(char)) { X += size * 0.2; Y -= size * 0.3; }
            else if (/[」』]/.test(char)) { X -= size * 0.2; Y += size * 0.1; }
            else if (/[“‘"']/.test(char)) Y -= size * 0.1;
            else if (/[”’]/.test(char)) Y += size * 0.1;
        }
        if (isNaN(X)) X = centerX - size / 2;
        if (isNaN(Y)) Y = TargetY - size / 2;
        return { x: X, y: Y, rot: rotateAngle };
    }

    static drawTextsAndLines(page, spreadIdx, spreadData, layoutData, config, colors, mainF, context) {
        const invertY = y => config.page.h - y;
        const renderYOf = t => t.y + (t.renderYOffset || 0);
        let yinkeBlocks = [], currentBlock = null, F = config.fonts.main.size;

        const currentSpreadTexts = [];
        const colStartTextMap = new Map();

        const texts = spreadData.texts || [];
        for (let i = 0; i < texts.length; i++) {
            const t = texts[i];
            // `space` 是仅用于对齐边界的不可见网格占位，不应进入 PDF 绘制流程。
            if (t.type === 'sep' || t.type === 'space') continue;

            currentSpreadTexts.push(t);

            const lookupKey = `${t.col}_${t.y.toFixed(3)}`;
            if (!colStartTextMap.has(lookupKey)) {
                colStartTextMap.set(lookupKey, t);
            }

            const tRenderY = renderYOf(t);
            if (t.isYinke) {
                // 字格的实际占高：优先用排版时的 cellHeight（注解小字/标点的格高与 size 不同），否则退回 size
                // 注解小字的字格高度是正文格高（cellHeight），字形在格内垂直居中；
                // 原逻辑用 y ~ y+size 作块范围，导致色块相对小字整体上移 (cellH - size)/2。
                const cellH = (t.m && Number.isFinite(t.m.cellHeight) && t.m.cellHeight > 0) ? t.m.cellHeight : (t.baseSize || t.size);
                const blockSize = t.baseSize || t.size;
                const glyphTop = tRenderY + Math.max(0, (cellH - blockSize) / 2);
                const glyphBottom = glyphTop + blockSize;
                if (!currentBlock || currentBlock.col !== t.col || currentBlock.offsetX !== t.offsetX || currentBlock.flowCenterX !== t.flowCenterX || Math.abs(currentBlock.lastY - tRenderY) > F * 2) {
                    if (currentBlock) yinkeBlocks.push(currentBlock);
                    currentBlock = { col: t.col, offsetX: t.offsetX, startY: glyphTop, endY: glyphBottom, size: blockSize, mergeRef: t.mergeRef, textType: t.type, hCharSpacing: t.hCharSpacing, flowCenterX: t.flowCenterX, styleId: t.styleId, firstY: tRenderY };
                } else {
                    currentBlock.endY = Math.max(currentBlock.endY, glyphBottom);
                }
                currentBlock.lastY = tRenderY;
            } else if (currentBlock) { yinkeBlocks.push(currentBlock); currentBlock = null; }
        }
        if (currentBlock) yinkeBlocks.push(currentBlock);

        const getMergeCenterShift = (mergeRef, colW, targetColStep = null) => {
            if (!mergeRef) return 0;
            const usedCols = Math.min(mergeRef.span, mergeRef.usedCols || mergeRef.span);
            if (targetColStep !== null) {
                const spanCenter = -(mergeRef.span - 1) * colW / 2;
                const groupCenter = -(usedCols - 1) * targetColStep / 2;
                return spanCenter - groupCenter;
            }
            return -(mergeRef.span - usedCols) * colW / 2;
        };

        yinkeBlocks.forEach(b => {
            const { baseX, colW } = layoutData.getColGeometry(b.col);
            let shiftX = 0, hOffset = 0;
            if (b.hCharSpacing !== null && b.hCharSpacing !== undefined && b.mergeRef) {
                const targetColStep = F * b.hCharSpacing;
                shiftX = getMergeCenterShift(b.mergeRef, colW, targetColStep);
                const currentRelativeCol = b.col - b.mergeRef.startCol;
                hOffset = currentRelativeCol * (colW - targetColStep);
            } else {
                shiftX = getMergeCenterShift(b.mergeRef, colW);
            }

            let centerX = Number.isFinite(b.flowCenterX)
                ? b.flowCenterX
                : baseX + (b.textType === 'note' || b.textType?.startsWith('small_') ? b.offsetX : colW / 2) + shiftX + hOffset;
            let currentSpacing = layoutData.actualSpacing || 0;

            const firstText = colStartTextMap.get(`${b.col}_${(b.firstY ?? b.startY).toFixed(3)}`);
            const styleIdForBlock = b.styleId || firstText?.styleId;
            if (styleIdForBlock) {
                const style = context.getTextStyle(styleIdForBlock, config);
                if (style && style.charSpacing !== null && style.charSpacing !== undefined) {
                    currentSpacing = (style.charSpacing - 1) * (style.fontSize || config.fonts.main.size);
                }
            }

            let targetPadding = b.size * ((config.aux.yinkeWidthRatio || 1.35) - 1) / 2;
            let padding = Math.min(targetPadding, Math.max(0, currentSpacing * 0.45));
            let w = b.size + padding * 2;
            let x = centerX - w / 2;
            let h = (b.endY - b.startY) + padding * 2;
            let pdfBottom = invertY(b.endY + padding);
            let r = w * (config.aux.yinkeCornerRadius || 0.15);
            r = Math.min(r, h / 2.1);

            page.drawRectangle({ x: x + r, y: pdfBottom, width: w - 2 * r, height: h, color: colors.yinkeBg });
            page.drawRectangle({ x: x, y: pdfBottom + r, width: w, height: h - 2 * r, color: colors.yinkeBg });
            [[x + r, pdfBottom + r], [x + w - r, pdfBottom + r], [x + r, pdfBottom + h - r], [x + w - r, pdfBottom + h - r]].forEach(([cx, cy]) => page.drawCircle({ x: cx, y: cy, size: r, color: colors.yinkeBg }));
        });

        // #8：按 (col, mergeRef, hCharSpacing) 记忆列几何与合并偏移
        const geoMemo = new Map();
        const getTextGeo = (t) => {
            const isSmall = t.type === 'note' || (typeof t.type === 'string' && t.type.startsWith('small_'));
            const useH = !isSmall && t.hCharSpacing !== null && t.hCharSpacing !== undefined && !!t.mergeRef;
            const key = `${t.col}|${t.mergeRef ? `${t.mergeRef.startCol}_${t.mergeRef.span}_${t.mergeRef.usedCols ?? ''}` : ''}|${useH ? t.hCharSpacing : ''}`;
            let g = geoMemo.get(key);
            if (g) return g;
            const { baseX, colW } = layoutData.getColGeometry(t.col);
            let shiftX = 0, hOffset = 0;
            if (useH) {
                const targetColStep = F * t.hCharSpacing;
                shiftX = getMergeCenterShift(t.mergeRef, colW, targetColStep);
                hOffset = (t.col - t.mergeRef.startCol) * (colW - targetColStep);
            } else {
                shiftX = getMergeCenterShift(t.mergeRef, colW);
            }
            g = { baseX, colW, shiftX, hOffset };
            geoMemo.set(key, g);
            return g;
        };
        currentSpreadTexts.forEach(t => {
            const { baseX, colW, shiftX, hOffset } = getTextGeo(t);

            let centerX = Number.isFinite(t.flowCenterX)
                ? t.flowCenterX
                : baseX + (t.type === 'note' || t.type?.startsWith('small_') ? t.offsetX : colW / 2) + shiftX + hOffset;
            const renderY = renderYOf(t);

            const rp = this.getCharRenderParams(t.char, centerX, renderY, t.size, config.page.h, t.m);

            if (t.isCircled) {
                const baseD = Math.max(t.size, rp.inkW || 0, rp.inkH || 0) || t.size;
                const circleScale = config.page.circleScale ?? 1;
                const thickness = config.page.circleThickness || 1;
                const radius = (baseD / 2) * circleScale + (thickness / 2);
                page.drawCircle({
                    x: centerX,
                    y: invertY(renderY + t.size / 2),
                    size: radius,
                    borderColor: colors.circle || colors.punct,
                    borderWidth: thickness
                });
            }

            let charColor = t.isYinke ? colors.yinkeText : (t.isCorner ? colors.punct : colors.text);
            const textStyle = context.getTextStyle(t.styleId, config);
            if (textStyle?.color) charColor = Utils.hexToRgbPdf(textStyle.color);
            const isNoteText = t.type === 'note' || (typeof t.type === 'string' && t.type.startsWith('small_'));
            const baseFont = isNoteText ? (config.fontsObj?.noteF || mainF) : mainF;
            const drawFont = textStyle?.fontName && config.fontsObj?.styleFonts?.[textStyle.fontName] ? config.fontsObj.styleFonts[textStyle.fontName] : baseFont;
            // 降级链：夹注 -> 夹注降级字体 -> 内置默认；正文 -> 降级字体 -> 内置默认
            const fallbackChain = isNoteText
                ? [config.fontsObj?.noteFallbackF, config.fontsObj?._fallbackF]
                : [config.fontsObj?.mainFallbackF, config.fontsObj?._fallbackF];
            const iconF = config.fontsObj && config.fontsObj.iconF ? config.fontsObj.iconF : mainF;

            if (t.type === 'draw_kuo') {
                const L = baseX + shiftX + hOffset;
                const C = colW * 0.15;
                const lineW = config.page.braceThickness ?? config.page.innerLineW * 1.5;
                const H = t.size * 0.15;
                const pdfY = invertY(renderY);

                 if (t.char === '︹') {
                    page.drawSvgPath(`M 0,${H} L ${C},0 L ${colW - C},0 L ${colW},${H}`, { x: L, y: pdfY, borderColor: charColor, borderWidth: lineW });
                } else {
                    page.drawSvgPath(`M 0,${-H} L ${C},0 L ${colW - C},0 L ${colW},${-H}`, { x: L, y: pdfY, borderColor: charColor, borderWidth: lineW });
                }
            } else {
                        Utils.safeDrawText(page, t.char, { x: rp.x, y: rp.y, size: t.size, font: drawFont, color: charColor, rotate: degrees(rp.rot) }, fallbackChain);
            }

            const ox = config.page.punctOffsetX || 0, oy = config.page.punctOffsetY || 0;
            const rawPunctScale = Number(config.page.punctScale);
            const cornerScale = Number.isFinite(rawPunctScale) && rawPunctScale > 0 ? rawPunctScale : 1;
            if (t.isCornerCircle) Utils.safeDrawText(page, '\ue612', { x: centerX + t.size * 0.5 + ox, y: rp.y - t.size * 0.1 - oy, size: t.size * 0.3 * cornerScale, font: iconF, color: colors.punct }, mainF || config.fontsObj?._fallbackF);
            if (t.isCornerDunhao) Utils.safeDrawText(page, '\ue616', { x: centerX + t.size * 0.5 + ox, y: rp.y - t.size * 0.1 - oy, size: t.size * 0.3 * cornerScale, font: iconF, color: colors.punct }, mainF || config.fontsObj?._fallbackF);
        });

        (spreadData.lines || []).forEach(l => {
            const { baseX, colW } = layoutData.getColGeometry(l.col);
            let shiftX = 0, hOffset = 0;
            if (l.hCharSpacing !== null && l.hCharSpacing !== undefined && l.mergeRef) {
                const targetColStep = F * l.hCharSpacing;
                shiftX = getMergeCenterShift(l.mergeRef, colW, targetColStep);
                const currentRelativeCol = l.col - l.mergeRef.startCol;
                hOffset = currentRelativeCol * (colW - targetColStep);
            } else {
                shiftX = getMergeCenterShift(l.mergeRef, colW);
            }

            const lineX = Number.isFinite(l.flowCenterX)
                ? l.flowCenterX + (l.lineOffsetFromCenter || 0)
                : baseX + (l.lineXOffset || 0) + shiftX + hOffset;
            page.drawLine({ start: { x: lineX, y: invertY(l.startY) }, end: { x: lineX, y: invertY(l.endY) }, thickness: 1.3, color: colors.mark });
        });

        if (Number(config.page.innerLineW) > 0 && spreadData.hLines) spreadData.hLines.forEach(hl => {
            const { baseX, colW } = layoutData.getColGeometry(hl.startCol);
            page.drawLine({ start: { x: baseX + colW, y: invertY(hl.y) }, end: { x: baseX + colW - (colW * hl.span), y: invertY(hl.y) }, thickness: config.page.innerLineW, color: colors.line });
        });
    }

    static drawFramework(page, config, colors, typeR, typeL, marginY, s = 0, layoutData = {}, thH = 0) {
        const oW = Math.max(0, Number(config.page.outerLineW) || 0);
        const iW = Math.max(0, Number(config.page.innerLineW) || 0);
        const offset = config.page.frameOffset;
        const frameH = config.page.h - config.page.margin.t - config.page.margin.b, unifiedW = config.page.spreadW - config.page.margin.l - config.page.margin.r;
        const innerY = config.page.margin.b + offset, innerTopY = config.page.h - config.page.margin.t - offset;
        const cx = config.page.w, cw = config.page.centerW, wHalf = (unifiedW + cw) / 2;
        const sfInset = getSingleFrameInset(config);
        const singleFrame = !!config.page.singleFrame;

        const drawRects = (x, w) => {
            if (oW > 0) {
                page.drawRectangle({ x, y: config.page.margin.b, width: w, height: frameH, borderColor: colors.line, borderWidth: oW });
            }
            if (iW > 0) {
                page.drawRectangle({ x: x + offset, y: innerY, width: w - offset * 2, height: frameH - offset * 2, borderColor: colors.line, borderWidth: iW });
            }
        };

        // 单页为纯白全屏图时：另一页的外/内框只画到版心边线为止（三边开口框），
        // 靠内一侧不画外边线，避免框线穿过版心区域、与版心元素重叠。
        const drawOpenRects = (isRightPage) => {
            // 横线一直延伸到贴近全屏图那一侧的版心边线，保证版心区域上下闭合；
            // 靠内一侧不画竖外边线，仅由后续的版心边线（内框线宽）收口。
            const farEdgeX = isRightPage ? cx : cx + cw;
            const oBottom = config.page.margin.b, oTop = config.page.margin.b + frameH;
            const oOuterX = isRightPage ? config.page.spreadW - config.page.margin.r : config.page.margin.l;
            const line = (x1, y1, x2, y2, t) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: t, color: colors.line });
            if (oW > 0) {
                const half = oW / 2;
                line(farEdgeX, oBottom, oOuterX, oBottom, oW);
                line(farEdgeX, oTop, oOuterX, oTop, oW);
                line(oOuterX, oBottom - half, oOuterX, oTop + half, oW);
                // 靠内一侧（紧邻全屏图的版心边线处）不绘制竖外边线
            }
            if (iW > 0) {
                const iOuterX = isRightPage ? oOuterX - offset : oOuterX + offset;
                const half = iW / 2;
                line(farEdgeX, innerY, iOuterX, innerY, iW);
                line(farEdgeX, innerTopY, iOuterX, innerTopY, iW);
                line(iOuterX, innerY - half, iOuterX, innerTopY + half, iW);
            }
        };

        if (singleFrame) {
            // 单页框架：左右页与版心各自独立绘制内外框
            const gap = Math.max(0, Number(config.page.singleFrameGap) || 0);
            if (typeR !== 'full-blank') {
                const xR = cx + cw + gap;
                drawRects(xR, config.page.spreadW - config.page.margin.r - xR);
            }
            if (typeL !== 'full-blank') {
                drawRects(config.page.margin.l, cx - gap - config.page.margin.l);
            }
            const showCenterBorder = config.page.singleFrameCenterBorder !== false;
            if (cw > 0 && showCenterBorder) drawRects(cx, cw);
            if (iW <= 0) return;
            if (thH > 0 && cw > 0 && showCenterBorder) {
                page.drawLine({ start: { x: cx + offset, y: innerY + thH }, end: { x: cx + cw - offset, y: innerY + thH }, thickness: iW, color: colors.line });
            }
        } else if (typeL !== 'full-blank' && typeR !== 'full-blank') drawRects(config.page.margin.l, unifiedW);
        else if (typeL === 'full-blank' && typeR === 'full-blank') {
            // 两侧都是纯白全屏图：仅在版心区域（cx ~ cx + cw）绘制上下的外框、内框横线，使版心闭合
            const oBottom = config.page.margin.b, oTop = config.page.margin.b + frameH;
            const line = (x1, y1, x2, y2, t) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: t, color: colors.line });
            // 起止点各向外延伸半个自身线宽，确保与两侧版心竖边线搭接闭合
            if (oW > 0) {
                const h = oW / 2;
                line(cx - h, oBottom, cx + cw + h, oBottom, oW);
                line(cx - h, oTop, cx + cw + h, oTop, oW);
            }
            if (iW > 0) {
                const h = iW / 2;
                line(cx - h, innerY, cx + cw + h, innerY, iW);
                line(cx - h, innerTopY, cx + cw + h, innerTopY, iW);
            }
        } else {
            if (typeR !== 'full-blank') drawOpenRects(true);
            if (typeL !== 'full-blank') drawOpenRects(false);
        }

        if (iW <= 0) return;

        if (!singleFrame) {
            page.drawLine({ start: { x: cx, y: innerY }, end: { x: cx, y: innerTopY }, thickness: iW, color: colors.line });
            page.drawLine({ start: { x: cx + cw, y: innerY }, end: { x: cx + cw, y: innerTopY }, thickness: iW, color: colors.line });

            if (thH > 0) {
                page.drawLine({ start: { x: cx, y: innerY + thH }, end: { x: cx + cw, y: innerY + thH }, thickness: iW, color: colors.line });
            }
        }

        // #14：merges 按列建索引一次，跨页复用
        if (!layoutData.__mergeIndex && layoutData.merges) {
            const idx = new Map();
            for (const m of layoutData.merges) {
                for (let c = m.startCol; c + 1 < m.startCol + m.span; c++) {
                    if (!idx.has(c)) idx.set(c, { full: false, local: [] });
                    const e = idx.get(c);
                    if (!m.local) e.full = true; else e.local.push({ startY: m.topY, endY: m.bottomY });
                }
            }
            layoutData.__mergeIndex = idx;
        }
        const getLineHiddenSegments = (col) => {
            const e = layoutData.__mergeIndex?.get(col);
            if (!e) return [];
            if (e.full) return [{ full: true }];
            return e.local;
        };
        const drawSegmentedVerticalLine = (x, y0, y1, hiddenSegments) => {
            if (!hiddenSegments?.length) {
                page.drawLine({ start: { x, y: y0 }, end: { x, y: y1 }, thickness: iW, color: colors.line });
                return;
            }
            if (hiddenSegments.some(seg => seg.full)) return;
            const cuts = hiddenSegments.map(seg => ({
                a: config.page.h - seg.endY,
                b: config.page.h - seg.startY
            })).sort((a, b) => a.a - b.a);
            let cur = y0;
            for (const cut of cuts) {
                const a = Math.max(y0, Math.min(y1, cut.a));
                const b = Math.max(y0, Math.min(y1, cut.b));
                if (a > cur + 0.1) page.drawLine({ start: { x, y: cur }, end: { x, y: a }, thickness: iW, color: colors.line });
                cur = Math.max(cur, b);
            }
            if (cur < y1 - 0.1) page.drawLine({ start: { x, y: cur }, end: { x, y: y1 }, thickness: iW, color: colors.line });
        };

        const getHalfSplitYRender = (sideIdx) => {
            const frame = layoutData.frame;
            if (!frame) return config.page.h / 2;
            const rawRatio = Number(layoutData.halfSplitRatios?.[sideIdx]);
            const ratio = Number.isFinite(rawRatio) && rawRatio > 0 ? rawRatio : 1;
            const splitY = frame.top + (frame.bottom - frame.top) * ratio / (ratio + 1);
            return config.page.h - splitY;
        };
        const rightEdge = config.page.spreadW - config.page.margin.r - offset;
        const leftEdge = cx - sfInset;
        const colWRight = (cx - config.page.margin.r - offset - sfInset) / config.page.cols;
        const colWLeft = (cx - config.page.margin.l - offset - sfInset) / config.page.cols;
        const hasHalfImg = (sideIdx, layer) => layoutData.halfPageImages?.some(img => img.side === sideIdx && img.layer === layer);

        const drawSeparators = (isLeft, type, sideIdx, bEdge, cW) => {
            if (type !== 'normal') return;
            if (!config.page.showInnerLines) return;
            for (let i = 1; i < config.page.cols; i++) {
                const colIdx = s * config.page.cols * 2 + (isLeft ? config.page.cols : 0) + i - 1;
                const hiddenSegments = getLineHiddenSegments(colIdx);
                const x = bEdge - i * cW;
                if (layoutData.halfSides?.has(sideIdx)) {
                    const splitYRender = getHalfSplitYRender(sideIdx);
                    if (!hasHalfImg(sideIdx, 'UPPER')) drawSegmentedVerticalLine(x, splitYRender, innerTopY, hiddenSegments);
                    if (!hasHalfImg(sideIdx, 'LOWER')) drawSegmentedVerticalLine(x, innerY, splitYRender, hiddenSegments);
                } else drawSegmentedVerticalLine(x, innerY, innerTopY, hiddenSegments);
            }
        };
        drawSeparators(false, typeR, s * 2, rightEdge, colWRight);
        drawSeparators(true, typeL, s * 2 + 1, leftEdge, colWLeft);

        if (layoutData.halfSides) {
            if (layoutData.halfSides.has(s * 2)) {
                const splitYRender = getHalfSplitYRender(s * 2);
                page.drawLine({ start: { x: cx + cw + sfInset, y: splitYRender }, end: { x: rightEdge, y: splitYRender }, thickness: iW, color: colors.line });
            }
            if (layoutData.halfSides.has(s * 2 + 1)) {
                const splitYRender = getHalfSplitYRender(s * 2 + 1);
                page.drawLine({ start: { x: config.page.margin.l + offset, y: splitYRender }, end: { x: leftEdge, y: splitYRender }, thickness: iW, color: colors.line });
            }
        }
    }

    static _centerPlanCache = new WeakMap();
    static async drawCenterElements(page, config, colors, cx, cw, spreadIdx, typeR, typeL, layoutData, mainF, doc, cache) {
        const elements = config.page.centerElements || [];
        if (!elements.length) return;
        // 版心宽度为 0（或无效）时没有版心区域，不绘制任何版心元素
        if (!(Number(cw) > 0)) return;
        const offset = config.page.frameOffset;
        const innerY = config.page.margin.b + offset;
        const innerTopY = config.page.h - config.page.margin.t - offset;
        const availableH = innerTopY - innerY;
        // #13：fixedH / totalRatio 与配置有关、与页无关，按 config 缓存一次
        let plan = this._centerPlanCache.get(config);
        // tailLine 是旧工程字段；新工程可分别控制直线与 V 线。
        // 未出现新字段时，两种线均继承旧开关，确保旧工程外观不变。
        const getTailLineConfig = (el) => {
            const legacyEnabled = el.tailLine !== false;
            const showStraight = el.tailStraightEnabled === undefined
                ? legacyEnabled : el.tailStraightEnabled !== false;
            const showV = el.tailVEnabled === undefined
                ? legacyEnabled : el.tailVEnabled !== false;
            const legacyOffset = Number(el.tailLineOffset);
            const legacyOffsetMm = Number.isFinite(legacyOffset) ? legacyOffset : 2;
            const legacyWidthMm = Number.isFinite(Number(el.tailLineW)) ? Number(el.tailLineW) : 1;
            const getOffset = value => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : legacyOffsetMm) * MM_TO_PT;
            const getWidth = value => Math.max(mmToPt(Number.isFinite(Number(value)) ? Number(value) : legacyWidthMm, 1), 0.3);
            const straightOffset = getOffset(el.tailStraightOffset);
            const straightWidth = getWidth(el.tailStraightW);
            const vOffset = getOffset(el.tailVOffset);
            const vWidth = getWidth(el.tailVW);
            const straightSpan = straightOffset + straightWidth;
            const vSpan = vOffset + vWidth;
            const lineCount = (showStraight ? 1 : 0) + (showV ? 1 : 0);
            const lineSpace = (showStraight ? straightSpan : 0) + (showV ? vSpan : 0);
            return { showStraight, showV, straightOffset, straightWidth, straightSpan, vOffset, vWidth, vSpan, lineSpace, lineCount };
        };
        if (!plan) {
            let fixedH = 0, totalRatio = 0;
            for (const el of elements) {
                fixedH += ((Number(el.gapTop) || 0) + (Number(el.gapBottom) || 0)) * MM_TO_PT;
                if (el.type === 'topTail' || el.type === 'bottomTail') {
                    fixedH += (Number(el.height) || 10) * MM_TO_PT;
                    const isCustom = el.styleMode === 'custom' && el.svgData;
                    if (!isCustom) fixedH += getTailLineConfig(el).lineSpace;
                }
                else if (el.type === 'singleLine') fixedH += Math.max(mmToPt(el.lineWidth, 0.35), 0.5) + 1;
                else if (el.type === 'doubleLine') fixedH += Math.max(mmToPt(el.lineWidth, 0.35), 0.5) * 2 + 3;
                else if (el.type === 'elephantTrunk') fixedH += (Number(el.height) || 20) * MM_TO_PT;
                else if (el.type === 'contentBlock') totalRatio += Number(el.heightRatio) || 10;
            }
            plan = { fixedH, totalRatio };
            this._centerPlanCache.set(config, plan);
        }
        const { fixedH, totalRatio } = plan;
        const remainingH = Math.max(0, availableH - fixedH);
        let currentY = innerTopY;
        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            currentY -= (Number(el.gapTop) || 0) * MM_TO_PT;
            let elH = 0;
            const isTail = el.type === 'topTail' || el.type === 'bottomTail';
            // 鱼尾未设置覆盖颜色时继承主色；其他框线元素仍沿用框线颜色。
            const inheritedColor = isTail && config.theme?.primaryColor
                ? Utils.hexToRgbPdf(config.theme.primaryColor)
                : colors.line;
            const elColor = el.lineColor ? Utils.hexToRgbPdf(el.lineColor) : inheritedColor;
            if (isTail) {
                let baseH = (Number(el.height) || 10) * MM_TO_PT;
                const isCustom = el.styleMode === 'custom' && el.svgData;
                const tailLines = getTailLineConfig(el);
                let yOffset = 0;
                if (!isCustom && tailLines.lineCount) {
                    elH = baseH + tailLines.lineSpace;
                    // 上鱼尾外侧是直线，下鱼尾外侧是 V 线；上下方向相反。
                    yOffset = el.type === 'topTail'
                        ? (tailLines.showStraight ? -tailLines.straightSpan : 0)
                        : (tailLines.showV ? -tailLines.vSpan : 0);
                } else {
                    elH = baseH;
                }
                if (isCustom) {
                    if (el._pngBuffer) {
                        try {
                            const embSvg = await doc.embedPng(el._pngBuffer);
                            page.drawImage(embSvg, { x: cx, y: currentY - baseH, width: cw, height: baseH });
                        } catch (e) {
                            console.warn("Worker 嵌入 PNG 失败", e);
                        }
                    }
                } else {
                    const notch = baseH * 0.4;
                    const isWhiteTail = el.styleMode === 'white';
                    const shapeStyle = isWhiteTail
                        ? { borderColor: elColor, borderWidth: Math.max(mmToPt(el.lineWidth, 0.35), 0.5) }
                        : { color: elColor };
                    if (el.type === 'topTail') {
                        // 上鱼尾的 V 尖端朝下；复线位于鱼尾两侧。
                        const path = isWhiteTail
                            ? `M 0,0 L ${cw},0 M ${cw},${baseH} L ${cw / 2},${baseH - notch} L 0,${baseH}`
                            : `M 0,0 L ${cw},0 L ${cw},${baseH} L ${cw / 2},${baseH - notch} L 0,${baseH} Z`;

                        page.drawSvgPath(path, {
                            x: cx,
                            y: currentY + yOffset,
                            ...shapeStyle
                        });
                        if (tailLines.showStraight) {
                            const { straightOffset: off, straightWidth: tlw } = tailLines;
                            page.drawLine({
                                start: { x: cx, y: currentY + off + tlw / 2 + yOffset },
                                end: { x: cx + cw, y: currentY + off + tlw / 2 + yOffset },
                                thickness: tlw,
                                color: elColor
                            });
                        }
                        if (tailLines.showV) {
                            const { vOffset: off, vWidth: tlw } = tailLines;
                            page.drawSvgPath(`M 0,${baseH} L ${cw / 2},${baseH - notch} L ${cw},${baseH}`, {
                                x: cx,
                                y: currentY - off - tlw + yOffset,
                                borderColor: elColor,
                                borderWidth: tlw
                            });
                        }
                    } else {
                        // 下鱼尾方向与上鱼尾相反，V 尖端朝上，偏移符号也相反。
                        const path = isWhiteTail
                            ? `M 0,0 L ${cw / 2},${notch} L ${cw},0 M ${cw},${baseH} L 0,${baseH}`
                            : `M 0,0 L ${cw / 2},${notch} L ${cw},0 L ${cw},${baseH} L 0,${baseH} Z`;

                        page.drawSvgPath(path, {
                            x: cx,
                            y: currentY + yOffset,
                            ...shapeStyle
                        });
                        if (tailLines.showStraight) {
                            const { straightOffset: off, straightWidth: tlw } = tailLines;
                            page.drawLine({
                                start: { x: cx, y: currentY - baseH - off - tlw / 2 + yOffset },
                                end: { x: cx + cw, y: currentY - baseH - off - tlw / 2 + yOffset },
                                thickness: tlw,
                                color: elColor
                            });
                        }
                        if (tailLines.showV) {
                            const { vOffset: off, vWidth: tlw } = tailLines;
                            page.drawSvgPath(`M 0,0 L ${cw / 2},${notch} L ${cw},0`, {
                                x: cx,
                                y: currentY + off + tlw + yOffset,
                                borderColor: elColor,
                                borderWidth: tlw
                            });
                        }
                    }
                }
            } else if (el.type === 'singleLine') {
                const lw = Math.max(mmToPt(el.lineWidth, 0.35), 0.5);
                elH = lw + 1;
                page.drawLine({
                    start: { x: cx, y: currentY - lw / 2 },
                    end: { x: cx + cw, y: currentY - lw / 2 },
                    thickness: lw,
                    color: elColor
                });
            } else if (el.type === 'doubleLine') {
                const lw = Math.max(mmToPt(el.lineWidth, 0.35), 0.5);
                const lineGap = 3;
                elH = lw * 2 + lineGap;
                page.drawLine({
                    start: { x: cx, y: currentY - lw / 2 },
                    end: { x: cx + cw, y: currentY - lw / 2 },
                    thickness: lw,
                    color: elColor
                });
                page.drawLine({
                    start: { x: cx, y: currentY - lw - lineGap - lw / 2 },
                    end: { x: cx + cw, y: currentY - lw - lineGap - lw / 2 },
                    thickness: lw,
                    color: elColor
                });
            } else if (el.type === 'elephantTrunk') {
                elH = (Number(el.height) || 20) * MM_TO_PT;
                const lw = Math.max(mmToPt(el.lineWidth, 0.35), 0.5);
                page.drawLine({
                    start: { x: cx + cw / 2, y: currentY },
                    end: { x: cx + cw / 2, y: currentY - elH },
                    thickness: lw,
                    color: elColor
                });
            } else if (el.type === 'contentBlock') {
                elH = totalRatio > 0 ? remainingH * ((Number(el.heightRatio) || 10) / totalRatio) : 0;
                const prevEl = i > 0 ? elements[i - 1] : null;
                const nextEl = i < elements.length - 1 ? elements[i + 1] : null;
                const extraTop = prevEl ? (Number(prevEl.gapBottom) || 0) * MM_TO_PT : 0;
                const extraBottom = nextEl ? (Number(nextEl.gapTop) || 0) * MM_TO_PT : 0;
                await this.drawCenterContentBlock(page, config, colors, cx, cw, currentY, elH, el, spreadIdx, typeR, typeL, layoutData, mainF, doc, cache, innerTopY, innerY, extraTop, extraBottom);
            }
            currentY -= elH;
            currentY -= (Number(el.gapBottom) || 0) * MM_TO_PT;
        }
    }

    static async drawCenterContentBlock(page, config, colors, cx, cw, topY, blockH, el, spreadIdx, typeR, typeL, layoutData, mainF, doc, cache, innerTopY, innerY, extraTop = 0, extraBottom = 0) {
        if (blockH <= 0) return;
        const textFor = side => this.parseCenterContentTags(el.text || '', config, layoutData, spreadIdx, side);
        const size = Math.max(2, Number(el.fontSize) || 16);
        const fontColor = Utils.hexToRgbPdf(el.fontColor || config.theme?.primaryColor || '#1a1a1a');
        const blockFont = (el.fontName && config.fontsObj?.centerContentFonts?.[el.fontName]) || mainF;
        const align = el.align || 'center';
        const vAlign = el.vAlign || 'center';

        if (align === 'doubleColumn') {
            const halfW = cw / 2;
            if (typeL !== 'full-blank') await this.renderCenterVerticalText(page, textFor('L'), cx, halfW, topY, topY - blockH, size, fontColor, blockFont, config, doc, cache, 'center', vAlign, el.charSpacing);
            if (typeR !== 'full-blank') await this.renderCenterVerticalText(page, textFor('R'), cx + halfW, halfW, topY, topY - blockH, size, fontColor, blockFont, config, doc, cache, 'center', vAlign, el.charSpacing);

            if (el.showDivider) {
                const gapTop = (Number(el.gapTop) || 0) * MM_TO_PT;
                const gapBottom = (Number(el.gapBottom) || 0) * MM_TO_PT;

                let lineTop = topY + gapTop + extraTop;
                let lineBot = topY - blockH - gapBottom - extraBottom;

                if (innerTopY !== undefined) lineTop = Math.min(lineTop, innerTopY);
                if (innerY !== undefined) lineBot = Math.max(lineBot, innerY);

                const lw = Math.max(mmToPt(el.dividerWidth ?? 0.35, 0.35), 0.5);
                page.drawLine({
                    start: { x: cx + halfW, y: lineTop },
                    end: { x: cx + halfW, y: lineBot },
                    thickness: lw,
                    color: colors.line
                });
            }
        } else {
            await this.renderCenterVerticalText(page, textFor('C'), cx, cw, topY, topY - blockH, size, fontColor, blockFont, config, doc, cache, align, vAlign, el.charSpacing);
        }
    }

    static parseStaticBookTags(text, config) {
        return String(text || '')
            .replace(/\$\{title\}/g, config.book.title || '')
            .replace(/\$\{book\}/g, config.book.title || '')
            .replace(/\$\{author\}/g, config.book.author || '')
            .replace(/\$\{tanghao\}/g, config.book.tanghao || '');
    }

    static parseCoverContentLines(text, config, layoutData = null) {
        // 题签内容块也使用完整的动态变量解析；封面没有独立页码时，按正文第一页上下文解析。
        const resolved = this.parseCenterContentTags(text, config, layoutData || {}, 0, 'R');
        const marker = />([^<>]*)>|<([^<>]*)<|>([^<>]*)</g;
        const lines = [];
        for (const raw of resolved.split(/\r?\n/)) {
            // 内容块行首的 + / - 可覆盖该竖列的垂直对齐方式：+ 居中，- 沉底。
            // 只在行首识别，避免影响正文中的普通加减号。
            const vAlignMatch = raw.match(/^\s*([+-])\s*/);
            const vAlignOverride = vAlignMatch ? (vAlignMatch[1] === '+' ? 'center' : 'bottom') : null;
            const value = (vAlignMatch ? raw.slice(vAlignMatch[0].length) : raw).trimEnd();
            const justifyMatch = value.match(/^\s*:\s*([\s\S]*?)[;；]([\s\S]*)$/);
            if (justifyMatch) {
                // 记录两端对齐原文，测量时去掉控制符，绘制时交给统一的内容块渲染器处理。
                lines.push({
                    text: `${justifyMatch[1]}${justifyMatch[2]}`,
                    renderText: value,
                    align: 'center',
                    vAlignOverride: null,
                    justify: true
                });
                continue;
            }
            let last = 0;
            let match;
            let found = false;
            marker.lastIndex = 0;
            while ((match = marker.exec(value)) !== null) {
                found = true;
                const plain = value.slice(last, match.index);
                if (plain) lines.push({ text: plain, align: 'center', vAlignOverride });
                const token = match[0];
                const open = token[0];
                const close = token[token.length - 1];
                lines.push({
                    text: match[1] ?? match[2] ?? match[3] ?? '',
                    align: open === '>' && close === '<' ? 'center' : (open === '<' ? 'left' : 'right'),
                    vAlignOverride
                });
                last = match.index + token.length;
            }
            if (found) {
                const plain = value.slice(last);
                if (plain) lines.push({ text: plain, align: 'center', vAlignOverride });
            } else {
                lines.push({ text: value, align: 'center', vAlignOverride });
            }
        }
        return lines;
    }

    static getAdjustedPageNumber(pageNum, config) {
        if (!Number.isFinite(pageNum) || pageNum <= 0) return null;
        const offset = Math.trunc(Number(config?.page?.pageNumberOffset) || 0);
        const adjusted = pageNum - offset;
        return adjusted > 0 ? adjusted : null;
    }

    static parseCenterContentTags(text, config, layoutData, spreadIdx, side) {
        const spread = layoutData?.spreads?.[spreadIdx] || {};
        const sideIdx = side === 'L' ? spreadIdx * 2 + 1 : spreadIdx * 2;
        let sideMeta = layoutData?.sideVolumes?.[sideIdx] || null;
        if (sideIdx % 2 === 0 && !sideMeta?.hasLocalVolumeDefinition) {
            const leftSideMeta = layoutData?.sideVolumes?.[sideIdx + 1] || null;
            if (leftSideMeta?.hasLocalVolumeDefinition) sideMeta = leftSideMeta;
        }
        const sourceVolume = sideMeta?.volume ?? spread.volume ?? '';
        const displayVolume = sideMeta && Object.hasOwn(sideMeta, 'volumeOverride')
            ? sideMeta.volumeOverride
            : (sideMeta?.volumeOverrideScope === 'cleared'
                ? sourceVolume
                : (Object.hasOwn(spread, 'volumeOverride') ? spread.volumeOverride : sourceVolume));
        const colsPerSide = Math.max(1, Number(config?.page?.cols) || 1);
        const sideEndCol = (sideIdx + 1) * colsPerSide - 1;
        let chapterIdx = Number.isFinite(sideMeta?.volumeNumber) ? sideMeta.volumeNumber - 1 : -1;
        if (chapterIdx < 0) {
            for (let index = 0; index < (layoutData?.chapters || []).length; index++) {
                if (Number(layoutData.chapters[index].col) <= sideEndCol) chapterIdx = index;
                else break;
            }
        }
        const pageLNum = this.getAdjustedPageNumber(spreadIdx * 2 + 2, config);
        const pageRNum = this.getAdjustedPageNumber(spreadIdx * 2 + 1, config);
        const pageSingleNum = this.getAdjustedPageNumber(spreadIdx + 1, config);
        const pageNumCurrent = side === 'L' ? pageLNum : (side === 'R' ? pageRNum : (config.page.outerPage ? pageRNum : pageSingleNum));
        const pageL = pageLNum === null ? '' : Utils.toChineseNumeral(pageLNum);
        const pageR = pageRNum === null ? '' : Utils.toChineseNumeral(pageRNum);
        const pageCurrent = pageNumCurrent === null ? '' : Utils.toChineseNumeral(pageNumCurrent);
        const volumeNum = chapterIdx >= 0 ? chapterIdx + 1 : '';
        return String(text || '')
            .replace(/\$\{title\}/g, config.book.title || '')
            .replace(/\$\{book\}/g, config.book.title || '')
            .replace(/\$\{volume\}/g, displayVolume)
            .replace(/\$\{vol_name\}/g, displayVolume)
            .replace(/\$\{vol_num\}/g, String(volumeNum))
            .replace(/\$\{vol\}/g, volumeNum ? Utils.toChineseNumeral(volumeNum) : '')
            .replace(/\$\{author\}/g, config.book.author || '')
            .replace(/\$\{tanghao\}/g, config.book.tanghao || '')
            .replace(/\$\{page_num\}/g, pageNumCurrent === null ? '' : String(pageNumCurrent))
            .replace(/\$\{pageL\}/g, pageL)
            .replace(/\$\{pageR\}/g, pageR)
            .replace(/\$\{page\}/g, pageCurrent);
    }

    static parseCenterInlineTokens(text) {
        text = String(text || '').replace(/\r\n?/g, '\n');
        let vAlignOverride = null;
        const vAlignMatch = text.match(/^\s*([+-])\s*/);
        if (vAlignMatch) {
            vAlignOverride = vAlignMatch[1] === '+' ? 'center' : 'bottom';
            text = text.slice(vAlignMatch[0].length);
        }
        const alignMatch = text.match(/^\s*<<\s*(center|left|right)\s*\n?/i);
        let alignOverride = null;
        if (alignMatch) {
            alignOverride = alignMatch[1].toLowerCase();
            text = text.slice(alignMatch[0].length);
        }
        const tokens = [];
        const imgRegex = /<(?:IMG:|图)([^>]*)>/gi;
        let last = 0;
        let match;
        while ((match = imgRegex.exec(text)) !== null) {
            for (const ch of text.slice(last, match.index)) tokens.push({ type: 'char', value: ch });
            tokens.push({ type: 'img', value: match[1].trim().replace(/^:/, '') });
            last = match.index + match[0].length;
        }
        for (const ch of text.slice(last)) tokens.push({ type: 'char', value: ch });
        return { tokens, alignOverride, vAlignOverride };
    }

    static async renderCenterVerticalText(page, text, cx, cw, topY, botY, fontSize, color, font, config, doc, cache, alignMode = 'center', vAlign = 'center', charSpacing = 0) {
        if (!text) return;

        // 内容块沿用正文的两端对齐语法：:上文;下文。
        // 两段分别从内容块顶部和底部开始排版，避免把分号误当成普通竖排文字。
        const justifyMatch = String(text).match(/^\s*:\s*([\s\S]*?)[;；]([\s\S]*)$/);
        if (justifyMatch) {
            const topText = justifyMatch[1];
            const bottomText = justifyMatch[2];
            if (topText) await this.renderCenterVerticalText(page, topText, cx, cw, topY, botY, fontSize, color, font, config, doc, cache, alignMode, 'top', charSpacing);
            if (bottomText) await this.renderCenterVerticalText(page, bottomText, cx, cw, topY, botY, fontSize, color, font, config, doc, cache, alignMode, 'bottom', charSpacing);
            return;
        }

        const parsed = this.parseCenterInlineTokens(text);
        const tokens = parsed.tokens;
        if (!tokens.length) return;
        if (parsed.alignOverride) alignMode = parsed.alignOverride;
        if (parsed.vAlignOverride) vAlign = parsed.vAlignOverride;

        const blockH = topY - botY;
        const centerX = cx + cw / 2;
        const tempEngine = this.getMeasureEngine(config, true);
        const verticalSpacing = Number.isFinite(Number(charSpacing)) ? Number(charSpacing) : 0;
        const spacingCount = Math.max(0, tokens.length - 1);
        const tokenHeight = (tk, sz) => {
            if (tk.type === 'img') return sz;
            if (tk.value === ' ') return sz * 0.5;
            if (tk.value === '\n') return sz;
            return tempEngine.getPunctMetrics(tk.value, sz, 0, font).advanceY;
        };

        let totalH = tokens.reduce((sum, tk) => sum + tokenHeight(tk, fontSize), 0) + verticalSpacing * spacingCount;
        let actualSize = fontSize;
        if (totalH > blockH && totalH > 0) {
            actualSize = Math.max(2, fontSize * blockH / totalH);
            const scaledSpacing = verticalSpacing * (actualSize / Math.max(1, fontSize));
            totalH = tokens.reduce((sum, tk) => sum + tokenHeight(tk, actualSize), 0) + scaledSpacing * spacingCount;
        }
        const actualSpacing = verticalSpacing * (actualSize / Math.max(1, fontSize));

        let currentY;
        if (vAlign === 'top') currentY = topY;
        else if (vAlign === 'bottom') currentY = topY - (blockH - totalH);
        else currentY = topY - (blockH - totalH) / 2;

        for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
            const tk = tokens[tokenIndex];
            const isLastToken = tokenIndex === tokens.length - 1;
            if (tk.type === 'img') {
                const emb = await this._embedImage(doc, tk.value, cache);
                const imgH = actualSize;
                if (emb) {
                    const scale = imgH / emb.height;
                    const imgW = emb.width * scale;
                    const drawX = alignMode === 'left' ? cx + cw * 0.3 - imgW / 2 : (alignMode === 'right' ? cx + cw * 0.7 - imgW / 2 : centerX - imgW / 2);
                    this.drawContentImage(page, emb, { x: drawX, y: currentY - imgH, width: imgW, height: imgH }, config);
                }
                currentY -= imgH;
                if (!isLastToken) currentY -= actualSpacing;
                continue;
            }

            const ch = tk.value;
            const stepH = tokenHeight(tk, actualSize);
            if (ch === ' ' || ch === '\n' || ch === '\r') {
                currentY -= stepH;
                if (!isLastToken) currentY -= actualSpacing;
                continue;
            }
            const m = tempEngine.getPunctMetrics(ch, actualSize, 0, font);
            const targetCenterY = currentY - stepH / 2;
            const alignX = alignMode === 'left' ? cx + cw * 0.3 : (alignMode === 'right' ? cx + cw * 0.7 : centerX);
            let drawX, drawY, rot = 0;
            if (m && (m.isRot || m.isRot90 || m.isEnRot)) {
                rot = -90; drawX = alignX - m.inkCY; drawY = targetCenterY + m.inkCX;
            } else if (m) {
                drawX = alignX - m.inkCX; drawY = targetCenterY - m.inkCY;
            } else {
                drawX = alignX - actualSize / 2; drawY = targetCenterY - actualSize / 2;
            }
            try {
                Utils.safeDrawText(page, ch, { x: drawX, y: drawY, size: m ? m.renderSize : actualSize, font, color, rotate: degrees(rot) }, config.fontsObj?.mainF || config.fontsObj?._fallbackF || font);
            } catch (e) { }
            currentY -= stepH;
            if (!isLastToken) currentY -= actualSpacing;
        }
    }

    static async _embedImage(doc, imgId, cache) {
        if (cache && cache.items[imgId]) return cache.items[imgId];
        let mem = cache?.job?.getImage(imgId);
        if (!mem) return null;
        try {
            const emb = mem.type === 'image/png' ? await doc.embedPng(mem.bytes) : await doc.embedJpg(mem.bytes);
            if (cache) cache.items[imgId] = emb; return emb;
        } catch (e) { return null; }
    }

    static imageBlendMode(config) {
        return config?.page?.blendImages ? PDFLib.BlendMode.Multiply : undefined;
    }

    static drawContentImage(page, image, options, config) {
        const blendMode = this.imageBlendMode(config);
        page.drawImage(image, blendMode ? { ...options, blendMode } : options);
    }

    static async drawHalfPageImages(page, spreadIdx, layoutData, config, doc, cache) {
        const imgs = layoutData.__halfBySpread ? layoutData.__halfBySpread.get(spreadIdx) : layoutData.halfPageImages?.filter(im => Math.floor(im.side / 2) === spreadIdx);
        if (!imgs?.length) return;

        const cx = config.page.w;
        const offset = config.page.frameOffset;

        for (const im of imgs) {
            const embImg = await this._embedImage(doc, im.id, cache);
            if (!embImg) continue;

            const isRightSide = (im.side % 2 === 0);
            const sfInset = getSingleFrameInset(config);
            const w = isRightSide ? (cx - config.page.margin.r - offset - sfInset) : (cx - config.page.margin.l - offset - sfInset);
            const startX = isRightSide ? (config.page.spreadW - config.page.margin.r - offset - w) : (config.page.margin.l + offset);

            const rawRatio = Number(layoutData.halfSplitRatios?.[im.side]);
            const ratio = Number.isFinite(rawRatio) && rawRatio > 0 ? rawRatio : 1;
            const splitY = layoutData.frame.top + (layoutData.frame.bottom - layoutData.frame.top) * ratio / (ratio + 1);
            const splitYRender = config.page.h - splitY;
            const innerTopY = config.page.h - config.page.margin.t - offset;
            const innerBottomY = config.page.margin.b + offset;

            let boxY, boxH;
            if (im.layer === 'UPPER') {
                boxY = splitYRender;
                boxH = innerTopY - splitYRender;
            } else {
                boxY = innerBottomY;
                boxH = splitYRender - innerBottomY;
            }

            const globalPadT = config.page.padding.t || 0;
            const globalPadB = config.page.padding.b || 0;
            const lineSafeInset = Math.max(0, Number(config.page.innerLineW) || 0);
            const ip = im.imgParams || {};
            const hasPT = ip.PT !== undefined || ip.PY !== undefined;
            const hasPB = ip.PB !== undefined || ip.PY !== undefined;
            const hasPL = ip.PL !== undefined || ip.PX !== undefined;
            const hasPR = ip.PR !== undefined || ip.PX !== undefined;
            const pt = hasPT ? (ip.PT !== undefined ? ip.PT : ip.PY) * MM_TO_PT : globalPadT;
            const pb = hasPB ? (ip.PB !== undefined ? ip.PB : ip.PY) * MM_TO_PT : globalPadB;
            const pl = hasPL ? (ip.PL !== undefined ? ip.PL : ip.PX) * MM_TO_PT : 0;
            const pr = hasPR ? (ip.PR !== undefined ? ip.PR : ip.PX) * MM_TO_PT : 0;

            if (im.stretch) {
                const padT = Math.max(hasPT ? pt : globalPadT, lineSafeInset);
                const padB = Math.max(hasPB ? pb : globalPadB, lineSafeInset);
                const padL = Math.max(hasPL ? pl : 0, lineSafeInset);
                const padR = Math.max(hasPR ? pr : 0, lineSafeInset);
                this.drawContentImage(page, embImg, {
                    x: startX + padL, y: boxY + padB,
                    width: Math.max(1, w - padL - padR), height: Math.max(1, boxH - padT - padB)
                }, config);
                continue;
            }

            const padT = Math.max(hasPT ? pt : Math.max(8, globalPadT), lineSafeInset);
            const padB = Math.max(hasPB ? pb : Math.max(8, globalPadB), lineSafeInset);
            const padL = Math.max(hasPL ? pl : 8, lineSafeInset);
            const padR = Math.max(hasPR ? pr : 8, lineSafeInset);

            const scale = Math.min((w - padL - padR) / embImg.width, (boxH - padT - padB) / embImg.height);
            const drawW = embImg.width * scale;
            const drawH = embImg.height * scale;
            const availW = w - padL - padR;
            const availH = boxH - padT - padB;

            this.drawContentImage(page, embImg, {
                x: startX + padL + (availW - drawW) / 2,
                y: boxY + padB + (availH - drawH) / 2,
                width: drawW, height: drawH
            }, config);
        }
    }

    static async drawLayoutImages(page, spreadIdx, layoutData, config, doc, cache) {
        const imgs = layoutData.__imagesBySpread ? layoutData.__imagesBySpread.get(spreadIdx) : layoutData.images?.filter(im => im.spreadIdx === spreadIdx);
        if (!imgs?.length) return;
        for (const im of imgs) {
            const embImg = await this._embedImage(doc, im.id, cache);
            if (!embImg) continue;
            const startMetrics = layoutData.getColGeometry(im.startCol);
            const endMetrics = layoutData.getColGeometry(im.startCol + im.span - 1);
            let blockRight = startMetrics.baseX + startMetrics.colW;
            let blockLeft = endMetrics.baseX;

            let x;
            if (im.stretch) {
                x = blockLeft + (im.insetLeft !== undefined ? im.insetLeft : (im.inset || 0));
            } else {
                if (im.offsetX !== null && im.offsetX !== undefined) {
                    x = blockLeft + im.offsetX;
                } else {
                    x = blockLeft + (blockRight - blockLeft - im.w) / 2;
                }
            }
            const y = config.page.h - (im.y + im.h);
            if (im.fitContain && im.fitContainerTotalWidth > 0 && typeof page.pushOperators === 'function') {
                const containerWidth = Math.max(1, Number(im.fitContainerTotalWidth) || im.w);
                const fitWidth = Math.max(1, Number(im.fitWidth) || im.w);
                const fitHeight = Math.max(1, Number(im.fitHeight) || im.h);
                const fragmentOffset = Math.max(0, Number(im.fitContainerOffset) || 0);
                const fragmentStart = containerWidth - fragmentOffset - im.w;
                const imageX = x - fragmentStart + (containerWidth - fitWidth) / 2;
                const imageY = y + (im.h - fitHeight) / 2;
                page.pushOperators(
                    PDFLib.pushGraphicsState(),
                    PDFLib.rectangle(x, y, im.w, im.h),
                    PDFLib.clip(),
                    PDFLib.endPath()
                );
                this.drawContentImage(page, embImg, { x: imageX, y: imageY, width: fitWidth, height: fitHeight }, config);
                page.pushOperators(PDFLib.popGraphicsState());
            } else if (im.cropSourceTotalWidth > 0 && typeof page.pushOperators === 'function') {
                const sourceX = x - (im.cropSourceTotalWidth - (im.cropSourceOffset || 0) - im.w);
                page.pushOperators(
                    PDFLib.pushGraphicsState(),
                    PDFLib.rectangle(x, y, im.w, im.h),
                    PDFLib.clip(),
                    PDFLib.endPath()
                );
                this.drawContentImage(page, embImg, { x: sourceX, y, width: im.cropSourceTotalWidth, height: im.h }, config);
                page.pushOperators(PDFLib.popGraphicsState());
            } else {
                this.drawContentImage(page, embImg, { x, y, width: im.w, height: im.h }, config);
            }
        }
    }

    static async drawOverlayImages(page, spreadIdx, layoutData, config, doc, cache, layer) {
        const overlays = layoutData.__overlaysBySpread ? layoutData.__overlaysBySpread.get(`${spreadIdx}_${layer}`) : layoutData.overlayImages?.filter(im => !im.isCover && im.spreadIdx === spreadIdx && im.layer === layer);
        if (!overlays?.length) return;

        for (const im of overlays) {
            const embImg = await this._embedImage(doc, im.id, cache);
            if (!embImg) continue;

            const sideOff = im.side % 2;
            const sideLeftX = sideOff === 0 ? config.page.w + config.page.centerW : 0;
            const sideRightX = sideOff === 0 ? config.page.spreadW : config.page.w;
            const frameLeftX = sideOff === 0 ? sideLeftX : config.page.margin.l;
            const frameRightX = sideOff === 0 ? sideRightX - config.page.margin.r : sideRightX;
            const frameTopY = config.page.h - config.page.margin.t;
            const frameBottomY = config.page.margin.b;
            let drawW = im.w !== null && im.w !== undefined ? im.w * MM_TO_PT : null;
            let drawH = im.h !== null && im.h !== undefined ? im.h * MM_TO_PT : null;

            if (drawW && !drawH) drawH = drawW * (embImg.height / embImg.width);
            else if (!drawW && drawH) drawW = drawH * (embImg.width / embImg.height);
            else if (!drawW && !drawH) {
                const fitScale = Math.min(
                    1,
                    Math.max(1, frameRightX - frameLeftX) / embImg.width,
                    Math.max(1, frameTopY - frameBottomY) / embImg.height
                );
                drawW = embImg.width * fitScale;
                drawH = embImg.height * fitScale;
            }

            const x = im.x !== null && im.x !== undefined
                ? sideRightX - im.x * MM_TO_PT - drawW
                : frameLeftX + (frameRightX - frameLeftX - drawW) / 2;
            const y = im.y !== null && im.y !== undefined
                ? config.page.h - im.y * MM_TO_PT - drawH
                : frameBottomY + (frameTopY - frameBottomY - drawH) / 2;
            const opts = { x, y, width: drawW, height: drawH, opacity: im.opacity ?? 1 };
            if (im.r) {
                const rad = im.r * Math.PI / 180;
                const cos = Math.cos(rad), sin = Math.sin(rad);
                const cx = x + drawW / 2, cy = y + drawH / 2;
                opts.rotate = degrees(im.r);
                opts.x = cx - (cos * drawW / 2 - sin * drawH / 2);
                opts.y = cy - (sin * drawW / 2 + cos * drawH / 2);
            }
            this.drawContentImage(page, embImg, opts, config);
        }
    }

    static async drawSideImages(page, spreadIdx, layoutData, config, doc, cache) {
        if (!layoutData.sideImages) return;
        const cx = config.page.w, ph = config.page.h, cw = config.page.centerW, contentH = ph - config.page.margin.t - config.page.margin.b, contentY = config.page.margin.b;
        for (let sideOff of [0, 1]) {
            const sideIdx = spreadIdx * 2 + sideOff, imgId = layoutData.sideImages[sideIdx], sideType = layoutData.sides[sideIdx];
            if (!imgId || !sideType) continue;
            const embImg = await this._embedImage(doc, imgId, cache);
            if (!embImg) continue;
            const contentW = sideOff === 0 ? cx - config.page.margin.r : cx - config.page.margin.l, bX = sideOff === 0 ? cx + cw : config.page.margin.l;

            if (sideType === 'full-blank') {
                // 全页图：不保持比例，直接拉伸填满。
                // 上下：与外边框上下位置对齐，并各向外扩半个外边框线宽；
                // 左右：靠外一侧从外边框开始，靠内一侧到版心边线结束，整体向外侧平移半个外边框线宽。
                const halfOuter = Math.max(0, Number(config.page.outerLineW) || 0) / 2;
                const outerBottomY = config.page.margin.b - halfOuter;
                const outerH = config.page.h - config.page.margin.t - config.page.margin.b + halfOuter * 2;
                // sideOff 0 = 右页：外侧为右外边框，内侧为版心右边线（cx + cw），整体右移半个线宽
                // sideOff 1 = 左页：外侧为左外边框，内侧为版心左边线（cx），整体左移半个线宽
                // 靠内一侧贴到版心边线（内框线宽）的外沿，靠外一侧贴到外边框的外沿
                const halfInner = Math.max(0, Number(config.page.innerLineW) || 0) / 2;
                const innerEdgeX = sideOff === 0 ? cx + cw + halfInner : cx - halfInner;
                const outerEdgeX = sideOff === 0 ? config.page.spreadW - config.page.margin.r + halfOuter : config.page.margin.l - halfOuter;
                const imgX = Math.min(innerEdgeX, outerEdgeX);
                const imgW = Math.abs(outerEdgeX - innerEdgeX);
                this.drawContentImage(page, embImg, {
                    x: imgX, y: outerBottomY,
                    width: Math.max(1, imgW), height: Math.max(1, outerH)
                }, config);
            } else if (sideType === 'framed-blank') {
                const offset = config.page.frameOffset;
                const innerY = config.page.margin.b + offset, frameH = config.page.h - config.page.margin.t - config.page.margin.b - offset * 2;
                const sfInset = getSingleFrameInset(config);
                const frameX = sideOff === 0 ? cx + cw + sfInset : config.page.margin.l + offset;
                const frameW = sideOff === 0 ? config.page.spreadW - config.page.margin.r - offset - frameX : cx - sfInset - frameX;
                const lineSafeInset = Math.max(0, Number(config.page.innerLineW) || 0);
                this.drawContentImage(page, embImg, {
                    x: frameX + lineSafeInset, y: innerY + lineSafeInset,
                    width: Math.max(1, frameW - lineSafeInset * 2), height: Math.max(1, frameH - lineSafeInset * 2)
                }, config);
            }
        }
    }

    static parsePaijiFlowText(textStr) {
        let text = String(textStr || '').replace(/[\r\n]+/g, '');
        let align = 'top';
        let indent = '';

        while (text.length > 0) {
            const ch = text[0];
            if (ch === '+') { align = 'center'; text = text.slice(1); }
            else if (ch === '-') { align = 'bottom'; text = text.slice(1); }
            else if (ch === ':') { align = 'justify'; text = text.slice(1); }
            else if (ch === '$' || ch === '@') { indent += '　'; text = text.slice(1); }
            else break;
        }

        text = indent + text;
        text = text.replace(/[@$]/g, '　');
        text = text.replace(/\|([^|]*)\|/g, '〔$1〕');
        return { text, align };
    }

    static drawPaijiFlowText(page, textStr, topY, bottomY, centerX, font, size, color, config, lineGap = size * 0.1) {
        const parsed = this.parsePaijiFlowText(textStr);
        if (!parsed.text) return;

        if (parsed.align === 'justify') {
            const sepIdx = parsed.text.indexOf(';');
            if (sepIdx !== -1) {
                const topText = parsed.text.slice(0, sepIdx);
                const bottomText = parsed.text.slice(sepIdx + 1);
                if (topText) this.drawVerticalText(page, topText, topY, 'top', font, size, color, centerX, config, lineGap);
                if (bottomText) this.drawVerticalText(page, bottomText, bottomY, 'bottom', font, size, color, centerX, config, lineGap);
            } else {
                this.drawVerticalText(page, parsed.text, topY, 'top', font, size, color, centerX, config, lineGap);
            }
            return;
        }

        const refY = parsed.align === 'center' ? (topY + bottomY) / 2 : (parsed.align === 'bottom' ? bottomY : topY);
        this.drawVerticalText(page, parsed.text, refY, parsed.align, font, size, color, centerX, config, lineGap);
    }

    static async drawSpecialSide(page, config, colors, fonts, type, sideOff, doc, cache) {
        const { paijiTitleF, paijiSideF, kanshuF, paijiRightF, paijiLeftF } = fonts;
        const innerLineW = Math.max(0, Number(config.page.innerLineW) || 0);
        const offset = config.page.frameOffset;
        const innerY = config.page.margin.b + offset, innerTopY = config.page.h - config.page.margin.t - offset;
        const cx = config.page.w, cw = config.page.centerW, frameH = config.page.h - config.page.margin.t - config.page.margin.b;
        const sfInset = getSingleFrameInset(config);
        const startX = sideOff === 0 ? cx + cw + sfInset : config.page.margin.l + offset;
        const width = (sideOff === 0 ? config.page.spreadW - config.page.margin.r - offset : cx - sfInset) - startX;

        if (type === 'paiji') {
            const col3W = width * 0.18, col2W = width * 0.64, col1W = width * 0.18;
            if (innerLineW > 0) {
                page.drawLine({ start: { x: startX + col3W, y: innerY }, end: { x: startX + col3W, y: innerTopY }, thickness: innerLineW, color: colors.line });
                page.drawLine({ start: { x: startX + col3W + col2W, y: innerY }, end: { x: startX + col3W + col2W, y: innerTopY }, thickness: innerLineW, color: colors.line });
            }

            const pTitleSize = config.fonts.paijiTitle.size;
            const pRightSize = config.fonts.paijiRight.size;
            const pLeftSize = config.fonts.paijiLeft.size;
            const paijiTitleText = this.parseStaticBookTags(config.aux.paijiTitleText || '${title}', config);
            this.drawVerticalText(page, paijiTitleText, innerY + frameH / 2, 'center', paijiTitleF, pTitleSize, colors.paijiTitle, startX + col3W + col2W / 2, config);
            if (config.aux.paijiTR) {
                const trText = this.parseStaticBookTags(config.aux.paijiTR, config);
                this.drawPaijiFlowText(page, trText, innerTopY - config.page.padding.t, innerY + config.page.padding.b, (startX + width) - col1W / 2, paijiRightF, pRightSize, colors.paijiRight, config, pRightSize * 0.1);
            }
            const blText = this.parseStaticBookTags(config.aux.paijiBL, config);
            if (blText) {
                this.drawPaijiFlowText(page, blText, innerTopY - config.page.padding.t, innerY + config.page.padding.b, startX + col3W / 2, paijiLeftF, pLeftSize, colors.paijiLeft, config, pLeftSize * 0.1);
            }
        } else if (type === 'kanshu') {
            const KH = innerTopY - innerY, centerLeftX = startX + width / 2, centerLeftY = innerY + KH / 2;
            if (config.aux.kanshuUseImage && config.aux.kanshuImgId) {
                const embImg = await this._embedImage(doc, config.aux.kanshuImgId, cache);
                if (embImg) this.drawContentImage(page, embImg, { x: startX + innerLineW, y: innerY + innerLineW, width: width - innerLineW * 2, height: KH - innerLineW * 2 }, config);
            } else {
                const kanshuRawText = this.parseStaticBookTags(config.aux.kanshuText, config);
                const lines = kanshuRawText.split('\n').filter(l => l.trim().length > 0);
                if (lines.length > 0) {
                    let kSize = config.fonts.kanshu.size, lineGap = kSize * 0.5;
                    const tempEngine = this.getMeasureEngine(config, true);

                    const getStrH = (str, sz, gap) => {
                        let h = 0;
                        for (let c of str) {
                            if (c === ' ') h += sz * 0.5;
                            else if (c === '　') h += sz;
                            else h += tempEngine.getPunctMetrics(c, sz, 0, kanshuF).advanceY;
                        }
                        return h + Math.max(0, str.length - 1) * gap;
                    };

                    let maxTextH = Math.max(...lines.map(l => getStrH(l, kSize, kSize * 0.1)));
                    let maxTextW = lines.length * kSize + (lines.length - 1) * lineGap;

                    if (maxTextH > KH * 0.8 || maxTextW > width * 0.8) {
                        let scale = Math.min((KH * 0.8) / maxTextH, (width * 0.8) / maxTextW);
                        kSize *= scale; lineGap = kSize * 0.5;
                        maxTextH *= scale; maxTextW = lines.length * kSize + (lines.length - 1) * lineGap;
                    }

                    const boxW = maxTextW + kSize * 1.6, boxH = maxTextH + kSize * 2.4;
                    if (config.aux.kanshuOuterBorder && innerLineW > 0) page.drawRectangle({ x: centerLeftX - boxW / 2, y: centerLeftY - boxH / 2, width: boxW, height: boxH, borderColor: colors.line, borderWidth: innerLineW * 1.5 });

                    let currentCenterX = centerLeftX + maxTextW / 2 - kSize / 2;
                    lines.forEach(lineStr => {
                        if (lineStr.length === 0) { currentCenterX -= (kSize + lineGap); return; }
                        this.drawVerticalText(page, lineStr, centerLeftY, 'center', kanshuF, kSize, colors.kanshuText, currentCenterX, config, kSize * 0.1);
                        currentCenterX -= (kSize + lineGap);
                    });
                }
            }
        }
    }

    static async drawCoverOverlayImages(page, config, doc, cache, layoutData, layer) {
        const overlays = layoutData?.overlayImages?.filter(im => im.isCover && im.layer === layer);
        if (!overlays?.length) return;

        for (const im of overlays) {
            const embImg = await this._embedImage(doc, im.id, cache);
            if (!embImg) continue;

            let drawW = im.w != null ? im.w * MM_TO_PT : null;
            let drawH = im.h != null ? im.h * MM_TO_PT : null;
            if (drawW && !drawH) drawH = drawW * (embImg.height / embImg.width);
            else if (!drawW && drawH) drawW = drawH * (embImg.width / embImg.height);
            else if (!drawW && !drawH) {
                const fitW = Math.max(1, config.page.spreadW - config.page.margin.l - config.page.margin.r);
                const fitH = Math.max(1, config.page.h - config.page.margin.t - config.page.margin.b);
                const fitScale = Math.min(1, fitW / embImg.width, fitH / embImg.height);
                drawW = embImg.width * fitScale;
                drawH = embImg.height * fitScale;
            }

            const x = im.x != null ? config.page.spreadW - im.x * MM_TO_PT - drawW : (config.page.spreadW - drawW) / 2;
            const y = im.y != null ? config.page.h - im.y * MM_TO_PT - drawH : (config.page.h - drawH) / 2;
            const opts = { x, y, width: drawW, height: drawH, opacity: im.opacity ?? 1 };
            if (im.r) {
                const rad = im.r * Math.PI / 180;
                const cos = Math.cos(rad), sin = Math.sin(rad);
                const cx = x + drawW / 2, cy = y + drawH / 2;
                opts.rotate = degrees(im.r);
                opts.x = cx - (cos * drawW / 2 - sin * drawH / 2);
                opts.y = cy - (sin * drawW / 2 + cos * drawH / 2);
            }
            this.drawContentImage(page, embImg, opts, config);
        }
    }

    static async drawCover(doc, config, colors, coverF, cache, layoutData) {
        EventBus.emit('progress', { text: '生成封面...', percent: 55, detail: '绘制跨页封面' });
        const page = doc.addPage([config.page.spreadW, config.page.h]);
        page.__fallbackFont = config.fontsObj?._fallbackF || coverF || null;

        if (config.cover.mode === 'custom' && cache.job.customCover?.bytes) {
            const img = cache.job.customCover.type === 'image/png' ? await doc.embedPng(cache.job.customCover.bytes) : await doc.embedJpg(cache.job.customCover.bytes);
            page.drawImage(img, { x: 0, y: 0, width: config.page.spreadW, height: config.page.h });
        } else if (config.cover.mode === 'auto') {
            page.drawRectangle({ x: 0, y: 0, width: config.page.spreadW, height: config.page.h, color: Utils.hexToRgbPdf(config.cover.bgColor || '#1a2b4c') });

            if (cache.job.getBoolean('ifBindingThread')) {
                const cx = config.page.w, cw = config.page.centerW;
                // 默认书脊跟随版心；单独设置时仍以版心中心为基准，避免左右偏移。
                const configuredSpineW = Number(config.cover.spineW);
                const requestedSpineW = Number.isFinite(configuredSpineW) && configuredSpineW > 0 ? configuredSpineW : cw;
                const spineW = Math.min(Math.max(0, requestedSpineW), config.page.spreadW);
                const spineX = cx + (cw - spineW) / 2;
                page.drawRectangle({ x: spineX, y: 0, width: spineW, height: config.page.h, color: rgb(0, 0, 0), opacity: 0.12 });
                const holes = [0.15, 0.383, 0.617, 0.85];
                [spineX, spineX + spineW].forEach(lx => {
                    page.drawLine({ start: { x: lx, y: config.page.h * holes[0] }, end: { x: lx, y: config.page.h * holes[3] }, thickness: 1.5, color: colors.thread, opacity: 0.85 });
                    holes.forEach(pct => {
                        const y = config.page.h * pct;
                        page.drawLine({ start: { x: spineX, y }, end: { x: spineX + spineW, y }, thickness: 1.5, color: colors.thread, opacity: 0.85 });
                        if (pct === holes[0] || pct === holes[3]) page.drawLine({ start: { x: lx, y }, end: { x: lx, y: pct === holes[0] ? 0 : config.page.h }, thickness: 1.5, color: colors.thread, opacity: 0.85 });
                    });
                });
            }

            const elements = config.cover.elements || [];
            const tempEngine = this.getMeasureEngine(config, false);

            let scale = 1;
            let pX = config.cover.padX, pY = config.cover.padY;
            let mX = config.cover.marginX, mY = config.cover.marginY;
            let cOW = Math.max(0, Number(config.cover.outerLineW) || 0);
            let cIW = Math.max(0, Number(config.cover.innerLineW) || 0);
            let cGap = Math.max(0, Number(config.cover.lineGap) || 0);
            const getFont = (fName) => (fName && config.fontsObj?.styleFonts?.[fName]) ? config.fontsObj.styleFonts[fName] : coverF;

            const measureElements = (currentScale) => {
                let totalH = 0;
                let maxContentW = 0;
                const metrics = [];

                for (const el of elements) {
                    let h = 0, w = 0;
                    const gapTop = (Number(el.gapTop) || 0) * currentScale;
                    const gapBottom = (Number(el.gapBottom) || 0) * currentScale;

                    if (el.type === 'bookTitle') {
                        const size = (Number(el.fontSize) || 68) * currentScale;
                        const spacing = (Number(el.charSpacing) || 0) * currentScale;
                        const text = config.book.title || '';
                        const list = [];
                        for (let ch of text) {
                            let chH = size, m = null;
                            if (ch === ' ' || ch === '\t' || ch === '　') chH = size;
                            else { m = tempEngine.getPunctMetrics(ch, size, 0, getFont(el.fontName)); chH = m.advanceY; }
                            list.push({ ch, h: chH, m });
                            h += chH;
                        }
                        h += Math.max(0, list.length - 1) * spacing;
                        w = size;
                        metrics.push({ el, h, w, gapTop, gapBottom, size, spacing, list });
                    } else if (el.type === 'contentBlock') {
                        const size = (Number(el.fontSize) || 14) * currentScale;
                        const charSp = (Number(el.charSpacing) || 0) * currentScale;
                        const lineSp = (Number(el.lineSpacing) || 0) * currentScale;
                        const lines = this.parseCoverContentLines(el.text || '', config, layoutData);
                        let maxLineH = 0;
                        const linesData = lines.map(line => {
                            const lineStr = line.text;
                            let lineH = 0;
                            const chars = [];
                            for (let ch of lineStr) {
                                let chH = size, m = null;
                                if (ch === ' ' || ch === '\t' || ch === '　') chH = size;
                                else { m = tempEngine.getPunctMetrics(ch, size, 0, getFont(el.fontName)); chH = m.advanceY; }
                                lineH += chH;
                                chars.push({ ch, h: chH, m });
                            }
                            lineH = chars.length > 0
                                ? lineH + Math.max(0, chars.length - 1) * charSp
                                : size;
                            if (lineH > maxLineH) maxLineH = lineH;
                            return {
                                chars,
                                lineH,
                                align: line.align,
                                vAlignOverride: line.vAlignOverride,
                                justify: line.justify === true,
                                renderText: line.renderText || null
                            };
                        });
                        h = maxLineH;
                        w = lines.length > 0 ? (lines.length * size + (lines.length - 1) * lineSp) : 0;
                        metrics.push({ el, h, w, gapTop, gapBottom, size, charSp, lineSp, linesData });
                    } else if (el.type === 'horizontalLine') {
                        h = (Number(el.lineWidth) || 0.35) * currentScale;
                        metrics.push({ el, h, w: 0, gapTop, gapBottom });
                    } else if (el.type === 'image') {
                        metrics.push({ el, h: 0, w: 0, gapTop, gapBottom, pendingImage: true });
                    }

                    if (w > maxContentW) maxContentW = w;
                    if (!el.pendingImage) totalH += (h + gapTop + gapBottom);
                }
                return { totalH, maxContentW, metrics };
            };

            let result = measureElements(scale);
            let sideExtraX = pX + cIW + cGap + cOW + mX;
            let sideExtraY = pY + cIW + cGap + cOW + mY;
            let innerW = result.maxContentW + 2 * pX;

            for (const m of result.metrics) {
                if (m.pendingImage && m.el.imageId) {
                    const mem = cache.job.getImage(m.el.imageId);
                    if (mem) {
                        const aspect = (mem.w && mem.h) ? mem.w / mem.h : 1;
                        const imgDrawW = innerW * (Number(m.el.scale) || 1);
                        m.h = imgDrawW / aspect;
                        m.imgDrawW = imgDrawW;
                        result.totalH += (m.h + m.gapTop + m.gapBottom);
                    }
                }
            }

            let lblH = result.totalH + sideExtraY * 2;
            let lblW = result.maxContentW + sideExtraX * 2;
            let maxH = config.page.h - config.cover.offsetY - 10;

            if (lblH > maxH && lblH > 0) {
                scale = maxH / lblH;
                pX *= scale; pY *= scale; mX *= scale; mY *= scale; cOW *= scale; cIW *= scale; cGap *= scale;
                result = measureElements(scale);
                sideExtraX = pX + cIW + cGap + cOW + mX;
                sideExtraY = pY + cIW + cGap + cOW + mY;
                innerW = result.maxContentW + 2 * pX;
                for (const m of result.metrics) {
                    if (m.pendingImage && m.el.imageId) {
                        const mem = cache.job.getImage(m.el.imageId);
                        if (mem) {
                            const aspect = (mem.w && mem.h) ? mem.w / mem.h : 1;
                            m.imgDrawW = innerW * (Number(m.el.scale) || 1);
                            m.h = m.imgDrawW / aspect;
                            result.totalH += (m.h + m.gapTop + m.gapBottom);
                        }
                    }
                }
                lblH = result.totalH + sideExtraY * 2;
                lblW = result.maxContentW + sideExtraX * 2;
            }

            const lblX = config.cover.offsetX;
            const lblY = config.page.h - config.cover.offsetY - lblH;
            const centerX = lblX + sideExtraX + result.maxContentW / 2;

            const innerX = lblX + mX + cOW + cGap + cIW / 2;
            const innerBoxW = lblW - 2 * (mX + cOW + cGap) - cIW;
            const innerBoxH = lblH - 2 * (mY + cOW + cGap) - cIW;

            if (cache.job.getBoolean('ifCoverTitleVisible')) {
                if (config.cover.ifTitleBg) page.drawRectangle({ x: lblX, y: lblY, width: lblW, height: lblH, color: Utils.hexToRgbPdf(config.cover.titleBgColor || '#ffffff') });
                if (cOW > 0) {
                    page.drawRectangle({ x: lblX + mX + cOW / 2, y: lblY + mY + cOW / 2, width: lblW - 2 * mX - cOW, height: lblH - 2 * mY - cOW, borderColor: colors.coverBorder, borderWidth: cOW });
                }
                if (cIW > 0) {
                    page.drawRectangle({ x: innerX, y: lblY + mY + cOW + cGap + cIW / 2, width: innerBoxW, height: innerBoxH, borderColor: colors.coverBorder, borderWidth: cIW });
                }
            }

            await this.drawCoverOverlayImages(page, config, doc, cache, layoutData, 1);

            if (cache.job.getBoolean('ifCoverTitleVisible')) {
                let currentY = lblY + lblH - sideExtraY;
                for (const m of result.metrics) {
                    currentY -= m.gapTop;
                    const el = m.el;
                    const color = Utils.hexToRgbPdf(el.fontColor || '#1a1a1a');

                    if (el.type === 'bookTitle') {
                        const font = getFont(el.fontName);
                        for (let i = 0; i < m.list.length; i++) {
                            const tk = m.list[i];
                            if (i > 0) currentY -= m.spacing;
                            if (tk.ch === ' ' || tk.ch === '　') { currentY -= tk.h; continue; }
                            const rp = this.getCharRenderParams(tk.ch, centerX, config.page.h - currentY + (tk.m ? tk.m.preY : 0), m.size, config.page.h, tk.m);
                        Utils.safeDrawText(page, tk.ch, { x: rp.x, y: rp.y, font, size: tk.m ? tk.m.renderSize : m.size, color, rotate: degrees(rp.rot) }, coverF);
                            currentY -= tk.h;
                        }
                    } else if (el.type === 'contentBlock') {
                        const font = getFont(el.fontName);
                        const blockTopY = currentY;
                        const lineStep = m.size + m.lineSp;
                        const contentLeft = innerX + pX;
                        const contentRight = innerX + innerBoxW - pX;
                        const minCenterX = contentLeft + m.size / 2;
                        const maxCenterX = Math.max(minCenterX, contentRight - m.size / 2);
                        for (let lineIndex = 0; lineIndex < m.linesData.length; lineIndex++) {
                            const line = m.linesData[lineIndex];
                            const defaultX = centerX + m.w / 2 - m.size / 2 - lineIndex * lineStep;
                            const lineX = line.align === 'left'
                                ? minCenterX + lineIndex * lineStep
                                : (line.align === 'right'
                                    ? maxCenterX - lineIndex * lineStep
                                    : defaultX);
                            const currentX = Math.max(minCenterX, Math.min(maxCenterX, lineX));
                            if (line.justify) {
                                await this.renderCenterVerticalText(page, line.renderText || line.text, currentX - m.size / 2, m.size, blockTopY, blockTopY - m.h, m.size, color, font, config, doc, cache, 'center', 'top', m.charSp);
                                continue;
                            }
                            const lineVAlign = line.vAlignOverride || m.el.vAlign || 'top';
                            const freeH = Math.max(0, m.h - line.lineH);
                            const lineOffset = lineVAlign === 'bottom'
                                ? freeH
                                : (lineVAlign === 'center' ? freeH / 2 : 0);
                            let y = blockTopY - lineOffset;
                            for (let tokenIndex = 0; tokenIndex < line.chars.length; tokenIndex++) {
                                const tk = line.chars[tokenIndex];
                                if (tk.ch === ' ' || tk.ch === '\t' || tk.ch === '　') {
                                    y -= tk.h;
                                    if (tokenIndex < line.chars.length - 1) y -= m.charSp;
                                    continue;
                                }
                                const rp = this.getCharRenderParams(tk.ch, currentX, config.page.h - y + (tk.m ? tk.m.preY : 0), m.size, config.page.h, tk.m);
                                Utils.safeDrawText(page, tk.ch, { x: rp.x, y: rp.y, font, size: tk.m ? tk.m.renderSize : m.size, color, rotate: degrees(rp.rot) }, coverF);
                                y -= tk.h;
                                if (tokenIndex < line.chars.length - 1) y -= m.charSp;
                            }
                        }
                        currentY -= m.h;
                    } else if (el.type === 'horizontalLine') {
                        const lColor = Utils.hexToRgbPdf(el.lineColor || '#1a1a1a');
                        page.drawLine({ start: { x: innerX, y: currentY - m.h / 2 }, end: { x: innerX + innerBoxW, y: currentY - m.h / 2 }, thickness: m.h, color: lColor });
                        currentY -= m.h;
                    } else if (el.type === 'image' && el.imageId) {
                        const emb = await this._embedImage(doc, el.imageId, cache);
                        if (emb) {
                            this.drawContentImage(page, emb, { x: centerX - m.imgDrawW / 2, y: currentY - m.h, width: m.imgDrawW, height: m.h }, config);
                        }
                        currentY -= m.h;
                    }
                    currentY -= m.gapBottom;
                }
            }
        }

        if (config.cover.mode !== 'auto') {
            await this.drawCoverOverlayImages(page, config, doc, cache, layoutData, 1);
        }

        await this.drawCoverOverlayImages(page, config, doc, cache, layoutData, 0);
    }

    static drawVerticalText(page, textStr, refY, align, font, size, color, centerX, config, lineGap = 0) {
        if (!textStr) return 0;
        const tempEngine = this.getMeasureEngine(config, true);
        let totalH = 0, tokens = [];

        const parts = textStr.split(/(〔.*?〕)/);
        for (let part of parts) {
            if (!part) continue;
            if (part.startsWith('〔') && part.endsWith('〕')) {
                let innerText = part.slice(1, -1);
                if (!innerText) continue;

                let noteF = size * (config.page.noteFontSizeRatio || 0.7);
                let noteGap = config.page.noteColSpacing || 0;
                let chars = [...innerText];

                let remTotal = 0;
                for (let c of chars) if (!/^[，。、,\.．！?？!\;:：；\]\)\}>”’》」』】〉］｝〗〙〛]/.test(c)) remTotal++;
                let takeRight = Math.ceil(remTotal / 2);
                let rCount = 0, splitIdx = 0;
                for (let i = 0; i < chars.length; i++) {
                    if (!/^[，。、,\.．！?？!\;:：；\]\)\}>”’》」』】〉］｝〗〙〛]/.test(chars[i])) rCount++;
                    splitIdx = i + 1;
                    if (rCount >= takeRight) {
                        while (splitIdx < chars.length && /^[，。、,\.．！?？!\;:：；\]\)\}>”’》」』】〉］｝〗〙〛]/.test(chars[splitIdx])) {
                            splitIdx++;
                        }
                        break;
                    }
                }

                let rightChars = chars.slice(0, splitIdx);
                let leftChars = chars.slice(splitIdx);

                const calcH = (arr) => {
                    let h = 0, ms = [];
                    for (let c of arr) {
                        let tk = { char: c, h: 0, m: null };
                        if (c === ' ') tk.h = noteF * 0.5;
                        else if (c === '　') tk.h = noteF;
                        else {
                            let m = tempEngine.getPunctMetrics(c, noteF, 0.25, font);
                            tk.h = m.advanceY; tk.m = m;
                        }
                        ms.push(tk); h += tk.h;
                    }
                    return { h, ms };
                };

                let rightData = calcH(rightChars);
                let leftData = calcH(leftChars);
                let blockH = Math.max(rightData.h, leftData.h);

                tokens.push({ isNote: true, h: blockH, rightData, leftData, noteF, noteGap });
                totalH += blockH;
            } else {
                for (let char of part) {
                    if (char === ' ') { tokens.push({ char, h: size * 0.5, m: null }); totalH += size * 0.5; }
                    else if (char === '　') { tokens.push({ char, h: size, m: null }); totalH += size; }
                    else {
                        const m = tempEngine.getPunctMetrics(char, size, 0, font);
                        tokens.push({ char, h: m.advanceY, m });
                        totalH += m.advanceY;
                    }
                }
            }
        }

        const totalGap = Math.max(0, tokens.length - 1) * lineGap;
        const fullH = totalH + totalGap;

        let currentPdfY;
        if (align === 'center') currentPdfY = refY + fullH / 2;
        else if (align === 'top') currentPdfY = refY;
        else if (align === 'bottom') currentPdfY = refY + fullH;

        for (let tk of tokens) {
            if (tk.isNote) {
                let rightCX = centerX + (tk.noteF + tk.noteGap) / 2;
                let leftCX = centerX - (tk.noteF + tk.noteGap) / 2;

                const drawSubCol = (data, cx) => {
                    let y = currentPdfY;
                    for (let item of data.ms) {
                        if (item.char === ' ' || item.char === '　') { y -= item.h; continue; }
                        let drawX, drawY, rot = 0;
                        const m = item.m, targetCenterY = y - item.h / 2;

                        if (m && (m.isRot || m.isRot90 || m.isEnRot)) {
                            rot = -90; drawX = cx - m.inkCY; drawY = targetCenterY + m.inkCX;
                            if (/[「『]/.test(item.char)) { drawX += tk.noteF * 0.2; drawY -= tk.noteF * 0.3; }
                            else if (/[」』]/.test(item.char)) { drawX -= tk.noteF * 0.2; drawY += tk.noteF * 0.1; }
                        } else {
                            drawX = m ? cx - m.inkCX : cx - tk.noteF / 2;
                            drawY = m ? targetCenterY - m.inkCY : targetCenterY - tk.noteF / 2;
                            if (m && /[！？!\?；：;:]/.test(item.char)) drawY += tk.noteF * 0.1;
                        }
                        Utils.safeDrawText(page, item.char, { x: drawX, y: drawY, size: m ? m.renderSize : tk.noteF, font, color, rotate: degrees(rot) }, font);
                        y -= item.h;
                    }
                };

                drawSubCol(tk.rightData, rightCX);
                drawSubCol(tk.leftData, leftCX);
                currentPdfY -= (tk.h + lineGap);

            } else {
                if (tk.char === ' ' || tk.char === '　') { currentPdfY -= (tk.h + lineGap); continue; }
                let drawX, drawY, rot = 0; const m = tk.m, targetCenterY = currentPdfY - tk.h / 2;

                if (m && (m.isRot || m.isRot90 || m.isEnRot)) {
                    rot = -90; drawX = centerX - m.inkCY; drawY = targetCenterY + m.inkCX;
                    if (/[「『]/.test(tk.char)) { drawX += size * 0.2; drawY -= size * 0.3; }
                    else if (/[」』]/.test(tk.char)) { drawX -= size * 0.2; drawY += size * 0.1; }
                } else {
                    drawX = m ? centerX - m.inkCX : centerX - size / 2;
                    drawY = m ? targetCenterY - m.inkCY : targetCenterY - size / 2;
                    if (m && /[！？!\?；：;:]/.test(tk.char)) drawY += size * 0.1;
                }
                Utils.safeDrawText(page, tk.char, { x: drawX, y: drawY, size: m ? m.renderSize : size, font, color, rotate: degrees(rot) }, font);
                currentPdfY -= (tk.h + lineGap);
            }
        }
        return fullH;
    }

    static drawBookEar(page, config, colors, textStr, sideOff, font) {
        if (!textStr) return;
        const earF = config.fonts.main.size * (config.page.earFontSizeRatio || 0.8);
        const padY = earF * (config.page.earPadY || 1.2);
        const padX = earF * (config.page.earPadX || 0.4);

        const tempEngine = this.getMeasureEngine(config, true);
        let totalH = 0;
        for (let char of textStr) {
            totalH += tempEngine.getPunctMetrics(char, earF, 0, font).advanceY;
        }

        const oW = Math.max(0, Number(config.page.outerLineW) || 0);
        const iW = Math.max(0, Number(config.page.innerLineW) || 0);
        const off = config.page.frameOffset;

        const earW = earF + padX * 2 + off;
        const earH = totalH + padY * 2 + off;

        const topY = config.page.h - config.page.margin.t;
        const bottomY = topY - earH;
        const lineCol = colors.line;

        let x0, x1, iX1, textCX;

        if (sideOff === 0) {
            x0 = config.page.spreadW - config.page.margin.r;
            x1 = x0 + earW;
            iX1 = x1 - off;
            textCX = x0 + padX + earF / 2;
        } else {
            x0 = config.page.margin.l;
            x1 = x0 - earW;
            iX1 = x1 + off;
            textCX = x0 - padX - earF / 2;
        }
        if (config.page.showEarOuterBorder && oW > 0) {
            page.drawLine({ start: { x: x0, y: topY }, end: { x: x1, y: topY }, thickness: oW, color: lineCol });
            page.drawLine({ start: { x: x0, y: bottomY }, end: { x: x1, y: bottomY }, thickness: oW, color: lineCol });
            page.drawLine({ start: { x: x1, y: topY }, end: { x: x1, y: bottomY }, thickness: oW, color: lineCol });
        }

        const iTopY = topY - off;
        const iBotY = bottomY + off;
        if (iW > 0) {
            page.drawLine({ start: { x: x0, y: iTopY }, end: { x: iX1, y: iTopY }, thickness: iW, color: lineCol });
            page.drawLine({ start: { x: x0, y: iBotY }, end: { x: iX1, y: iBotY }, thickness: iW, color: lineCol });
            page.drawLine({ start: { x: iX1, y: iTopY }, end: { x: iX1, y: iBotY }, thickness: iW, color: lineCol });
        }

        this.drawVerticalText(page, textStr, topY - padY, 'top', font, earF, colors.text, textCX, config);
    }
}

class RenderPipeline {
    static _tocPreviewCache = null;

    static getTocStructureKey(rawText = '') {
        // Chapter headings and explicit page breaks determine the directory
        // structure. Body-only edits keep this key stable, allowing a local
        // editor preview to reuse the last known directory page values.
        return String(rawText ?? '')
            .replace(/\r\n?/g, '\n')
            .split('\n')
            .filter(line => line.includes('#') || /^\s*[%~`]/.test(line))
            .join('\n');
    }

    static getTocCacheKey(rawText, config, context) {
        const page = config.page || {};
        const pageKey = {
            w: page.w, h: page.h, spreadW: page.spreadW, cols: page.cols, centerW: page.centerW,
            margin: page.margin, padding: page.padding, frameOffset: page.frameOffset,
            tailH: page.tailH, charSpacing: page.charSpacing, noteColSpacing: page.noteColSpacing,
            noteFontSizeRatio: page.noteFontSizeRatio, punctOffsetX: page.punctOffsetX,
            punctOffsetY: page.punctOffsetY, punctScale: page.punctScale,
            punctAdvanceRatio: page.punctAdvanceRatio, outerPage: page.outerPage,
            singleFrame: page.singleFrame, singleFrameGap: page.singleFrameGap
        };
        const aux = config.aux || {};
        const auxKey = {
            tocPrefix: aux.tocPrefix, tocFormat: aux.tocFormat,
            tocSinglePageNumber: aux.tocSinglePageNumber,
            tocFontName: aux.tocFontName, tocFontSize: aux.tocFontSize,
            tocFontColor: aux.tocFontColor,
            paiji: aux.paiji, paijiTitleText: aux.paijiTitleText,
            kanshu: aux.kanshu, kanshuText: aux.kanshuText,
            kanshuUseImage: aux.kanshuUseImage, kanshuImgId: aux.kanshuImgId,
            tocInsertAfter: aux.tocInsertAfter, paijiInsertAfter: aux.paijiInsertAfter, kanshuInsertAfter: aux.kanshuInsertAfter
        };
        const styles = Object.fromEntries(Object.entries(context?.styles || {}).map(([id, style]) => [id, {
            name: style?.name, color: style?.color, fontName: style?.fontName,
            fontSize: style?.fontSize, charSpacing: style?.charSpacing,
            hCharSpacing: style?.hCharSpacing, horizontalAlign: style?.horizontalAlign,
            verticalAlign: style?.verticalAlign, allowLarge: style?.allowLarge
        }]));
        return JSON.stringify({
            structure: this.getTocStructureKey(rawText),
            book: config.book,
            page: pageKey,
            fonts: config.fonts,
            format: config.format,
            aux: auxKey,
            styles
        });
    }

    static getTocPreviewKey(previewRender) {
        if (!previewRender?.enabled) return '';
        return JSON.stringify({
            cursorParaIdx: Math.max(0, Number.parseInt(previewRender.cursorParaIdx, 10) || 0),
            before: Math.max(0, Number.parseInt(previewRender.before, 10) || 0),
            after: Math.max(0, Number.parseInt(previewRender.after, 10) || 0)
        });
    }

    static async runStage(name, operation) {
        try {
            return await operation();
        } catch (error) {
            const stageError = error instanceof Error ? error : new Error(String(error));
            stageError.renderStage = name;
            throw stageError;
        }
    }

    static getErrorMessage(error) {
        const message = error?.message || String(error);
        return error?.renderStage ? `${error.renderStage}失败：${message}` : message;
    }

    static validateInput(payload) {
        if (!payload || typeof payload !== 'object') throw new Error('缺少生成参数');
        if (typeof payload.rawText !== 'string') throw new Error('正文必须是文本');
        if (!payload.config?.page || !payload.config?.fonts || !payload.config?.book || !payload.config?.aux || !payload.config?.cover || !payload.config?.format) {
            throw new Error('排版配置不完整');
        }
        if (!payload.colors || typeof payload.colors !== 'object') throw new Error('颜色配置不完整');
        if (!payload.fontsData?.dict || !payload.fontsData?.map) throw new Error('字体资源配置不完整');
        this.resolveFontRefs(payload.fontsData);
        return {
            ...payload,
            tocPrependStr: typeof payload.tocPrependStr === 'string' ? payload.tocPrependStr : '',
            domValues: payload.domValues || {},
            imagesData: payload.imagesData || {},
            customStyles: payload.customStyles || {},
            customCover: payload.customCover || null,
            previewRender: payload.previewRender || { enabled: false },
            pageDesigns: payload.pageDesigns || {}
        };
    }

    static isBinary(value) {
        return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
    }

    /** #1：把 fontsData.dict 中的缓存引用还原为真实 buffer；缺失时抛 NEED_FONTS 让主线程补发 */
    static resolveFontRefs(fontsData) {
        const missing = FontBufferStore.resolveDict(fontsData.dict);
        if (missing.length) {
            const err = new Error('NEED_FONTS');
            err.code = 'NEED_FONTS';
            err.missing = missing;
            throw err;
        }
    }

    static validatePageDesignInput(payload) {
        if (!payload || typeof payload !== 'object') throw new Error('缺少页面设计参数');
        if (!this.isBinary(payload.baseBytes)) throw new Error('基础 PDF 数据无效');
        if (!payload.config?.page || !payload.fontsData?.dict || !payload.fontsData?.map) throw new Error('页面设计资源配置不完整');
        this.resolveFontRefs(payload.fontsData);
        return {
            ...payload,
            pageDesigns: payload.pageDesigns || {},
            imagesData: payload.imagesData || {},
            layoutData: payload.layoutData || {}
        };
    }

    static validateSplitExportInput(payload) {
        if (!payload || typeof payload !== 'object') throw new Error('缺少单页导出参数');
        if (!this.isBinary(payload.pdfBytes)) throw new Error('待拆分 PDF 数据无效');
        if (!payload.config?.page) throw new Error('拆分页面配置不完整');
        return { ...payload, meta: payload.meta || null };
    }

    static createContext(payload) {
        const context = new RenderJobContext({
            domValues: payload.domValues,
            imagesData: payload.imagesData,
            customStyles: payload.customStyles,
            customCover: payload.customCover
        });
        const rawTocFontSize = payload.config?.aux?.tocFontSize;
        const tocFontSize = rawTocFontSize === null || rawTocFontSize === undefined || rawTocFontSize === ''
            ? null
            : Number(rawTocFontSize);
        const tocFontColor = String(payload.config?.aux?.tocFontColor || '');
        const tocFontName = String(payload.config?.aux?.tocFontName || '');
        if (tocFontName || Number.isFinite(tocFontSize) || tocFontColor) {
            // Keep the internal TOC style id free of layout syntax characters.
            // Underscores are parsed as emphasis markers inside directory text,
            // so an id such as "__toc" cannot round-trip through TextParser.
            context.styles.tocStyle = {
                name: 'tocStyle',
                color: tocFontColor,
                fontName: tocFontName,
                fontSize: Number.isFinite(tocFontSize) ? Math.max(1, tocFontSize) : null,
                charSpacing: null,
                hCharSpacing: null,
                horizontalAlign: 'center',
                verticalAlign: 'center',
                allowLarge: true
            };
        }
        return context;
    }

    static async createSession(payload, context = this.createContext(payload)) {
        const doc = await PDFDocument.create();
        doc.registerFontkit(self.fontkit);
        doc.setTitle(payload.config.book.title || '');
        doc.setAuthor(payload.config.book.author || '');
        doc.setCreator('易籍 古籍工具 (Worker)');
        const probeText = String(payload.fontsData?.probeText || '');
        const fonts = await this.embedFonts(doc, payload.fontsData, probeText);
        const renderConfig = { ...payload.config, fontsObj: fonts };
        context.fonts = fonts;
        return { context, doc, fonts, renderConfig };
    }

    static async embedFonts(doc, fontsData, probeText = '') {
        const fontBufferDict = fontsData.dict || {};
        const fontsMap = fontsData.map || {};
        let fallbackFont;
        const fallbackKey = fontsMap.fallbackF || 'defaultMainFont';
        const fallbackBuffer = fontBufferDict[fallbackKey];
        let fallbackSubsetEmbedded = false;
        if (fallbackBuffer) {
            try {
                fallbackFont = await Utils.embedSubsetFont(doc, fallbackBuffer, probeText, 'default');
                fallbackSubsetEmbedded = !!fallbackFont;
            } catch (error) {
                console.warn('默认中文字库加载失败，回退标准字体:', error?.message || error);
            }
        }
        if (!fallbackFont) {
            try {
                fallbackFont = await doc.embedFont(StandardFonts.Helvetica);
            } catch (error) {
                try {
                    fallbackFont = await doc.embedFont(StandardFonts.TimesRoman);
                } catch (fallbackError) {
                    fallbackFont = await doc.embedFont(StandardFonts.Courier);
                }
            }
        }
        if (!fallbackSubsetEmbedded) {
            Utils.primeFontSubset(fallbackFont, probeText);
            Utils.instrumentFont(fallbackFont, 'default');
        }
        const fonts = { _fallbackF: fallbackFont };
        const embeddedFontCache = new Map();
        if (fallbackBuffer && fallbackKey) embeddedFontCache.set(fallbackKey, fallbackFont);
        const getProbeTextForFont = fontKey => fontKey === fontsMap.iconF
            ? `${probeText}\uE612\uE616`
            : probeText;

        const getEmbeddedFont = async fontKey => {
            if (!fontKey) return fallbackFont;
            if (!embeddedFontCache.has(fontKey)) {
                const buffer = fontBufferDict[fontKey];
                if (!buffer) return fallbackFont;
                try {
                    const fontProbeText = getProbeTextForFont(fontKey);
                    const candidate = await Utils.embedSubsetFont(doc, buffer, fontProbeText, fontKey);
                    if (!candidate) {
                        embeddedFontCache.set(fontKey, fallbackFont);
                        return fallbackFont;
                    }
                    embeddedFontCache.set(fontKey, candidate);
                } catch (error) {
                    embeddedFontCache.set(fontKey, fallbackFont);
                    console.warn('字体加载失败，已回退默认字体:', fontKey, error?.message || error);
                }
            }
            return embeddedFontCache.get(fontKey);
        };

        for (const [key, fontKeyOrMap] of Object.entries(fontsMap)) {
            if (key === 'styleFonts' || key === 'centerContentFonts') {
                fonts[key] = {};
                for (const [name, fontKey] of Object.entries(fontKeyOrMap || {})) {
                    if (fontKey) fonts[key][name] = await getEmbeddedFont(fontKey);
                }
            } else {
                fonts[key] = await getEmbeddedFont(fontKeyOrMap);
            }
        }
        return fonts;
    }

    static resolveTocTemplate(template, config, values = {}) {
        const pageNumber = Number.isFinite(values.pageNumber) ? values.pageNumber : null;
        const pageLNumber = Number.isFinite(values.pageLNumber) ? values.pageLNumber : null;
        const pageRNumber = Number.isFinite(values.pageRNumber) ? values.pageRNumber : null;
        const volumeNumber = Number.isFinite(values.volumeNumber) ? values.volumeNumber : null;
        const volume = values.volume ?? '';
        const vars = {
            title: config.book.title || '',
            book: config.book.title || '',
            author: config.book.author || '',
            tanghao: config.book.tanghao || '',
            volume,
            vol_name: volume,
            vol_num: volumeNumber === null ? '' : String(volumeNumber),
            vol: volumeNumber === null ? '' : Utils.toChineseNumeral(volumeNumber),
            page_num: pageNumber === null ? '' : String(pageNumber),
            page: pageNumber === null ? '' : Utils.toChineseNumeral(pageNumber),
            pageL: pageLNumber === null ? '' : Utils.toChineseNumeral(pageLNumber),
            pageR: pageRNumber === null ? '' : Utils.toChineseNumeral(pageRNumber)
        };
        return String(template ?? '').replace(/\$\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key) =>
            Object.hasOwn(vars, key) ? String(vars[key] ?? '') : match
        );
    }

    static getTocPageValues(col, config, specialSides, volumeNumber) {
        const cols = Math.max(1, Number(config.page.cols) || 1);
        // 目录页码引用沿用“内容页”口径：牌记/刊署等特殊面不计入页码。
        // 特殊面可能插入正文中段，因此只扣除位于该章节之前的特殊面。
        let specialBefore = 0;
        if (specialSides && typeof specialSides === 'object') {
            const sideIdx = Math.floor((Number(col) || 0) / cols);
            for (const k of Object.keys(specialSides)) {
                if (Number(k) < sideIdx) specialBefore++;
            }
        } else {
            specialBefore = Math.max(0, Number(specialSides) || 0);
        }
        const contentCol = Math.max(0, Number(col) - specialBefore * cols);
        const spreadIdx = Math.floor(contentCol / (cols * 2));
        const pageRNumber = PDFRenderer.getAdjustedPageNumber(spreadIdx * 2 + 1, config);
        const pageLNumber = PDFRenderer.getAdjustedPageNumber(spreadIdx * 2 + 2, config);
        const tocSinglePageNumber = !!config.aux?.tocSinglePageNumber;
        const pageNumber = PDFRenderer.getAdjustedPageNumber(
            tocSinglePageNumber ? Math.floor(contentCol / cols) + 1 : spreadIdx + 1,
            config
        );
        return { pageNumber, pageLNumber, pageRNumber, volumeNumber };
    }

    // 正文连续排版（不含目录/牌记/刊署）：用于提取章节与计算插入切点。
    // 同一任务内缓存于 context，避免目录探测与布局计算重复排版。
    static getBodyFlow(rawText, config, context) {
        if (context && context._bodyFlow && context._bodyFlow.rawText === rawText) {
            return context._bodyFlow;
        }
        const bodyParas = TextParser.tokenize(rawText, config, context);
        const layout = new LayoutEngine(config, context).calculate(bodyParas, null, null);
        const flow = { rawText, bodyParas, layout };
        if (context) context._bodyFlow = flow;
        return flow;
    }

    // “第 N 页后”的插入切点：返回正文段落序号，特殊页插在该段落之前。
    // 页位置按正文连续排版计算（不含封面/牌记/刊署/目录）：
    // 段落起排面落在第 N+1 页（第 N 面）时切分；跨页段落整体留在切点之前。
    static findBodyCut(bodyLayout, bodyParas, n, cols) {
        const target = Math.max(0, Math.trunc(Number(n) || 0)) * cols;
        const starts = bodyLayout?.paraStarts || [];
        const flowStartCol = starts.map(entry => Number(entry.col) || 0);
        for (const b of bodyLayout?.pageBreaks || []) {
            const idx = Number(b.paraIndex);
            if (!Number.isInteger(idx) || idx < 0 || idx >= flowStartCol.length) continue;
            const blankCol = (Number(b.side) || 0) * cols;
            if (blankCol < flowStartCol[idx]) flowStartCol[idx] = blankCol;
        }
        const isPureEmpty = para => para?.runs?.length === 1 && para.runs[0]?.type === 'empty';
        for (let i = 0; i < flowStartCol.length; i++) {
            if (flowStartCol[i] < target) continue;
            if (isPureEmpty(bodyParas?.[i])) continue; // 空段跟随前面内容，不作为切点
            return i;
        }
        return flowStartCol.length;
    }

    // 根据目录/牌记/刊署的“插入位置（第 N 页后）”生成排版流插入计划。
    // 同一切点内的多个特殊页按 牌记 → 刊署 → 目录 的固定顺序排列。
    static computeInsertionPlan(config, rawText, context, hasToc) {
        const cols = Math.max(1, Number(config.page.cols) || 1);
        const aux = config.aux || {};
        const items = [];
        if (aux.paiji) items.push({ block: 'paiji', n: Math.max(0, Math.trunc(Number(aux.paijiInsertAfter) || 0)), order: 0 });
        if (aux.kanshu) items.push({ block: 'kanshu', n: Math.max(0, Math.trunc(Number(aux.kanshuInsertAfter) || 0)), order: 1 });
        if (hasToc) items.push({ block: 'toc', n: Math.max(0, Math.trunc(Number(aux.tocInsertAfter) || 0)), order: 2 });
        if (!items.length) return { cuts: [] };
        const needBodyLayout = items.some(it => it.n > 0);
        const bodyFlow = needBodyLayout ? this.getBodyFlow(rawText, config, context) : null;
        const cutOf = new Map();
        for (const it of items) {
            const cut = it.n > 0 ? this.findBodyCut(bodyFlow.layout, bodyFlow.bodyParas, it.n, cols) : 0;
            if (!cutOf.has(cut)) cutOf.set(cut, []);
            cutOf.get(cut).push(it);
        }
        const cuts = [...cutOf.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([bodyCut, list]) => ({
                bodyCut,
                blocks: list.slice().sort((a, b) => a.order - b.order).map(it => it.block)
            }));
        return { cuts };
    }

    // 把正文段落按插入计划拼装成排版流：
    // [正文 0..c1)[特殊面/目录][正文 c1..c2)…，并产出 LayoutEngine 所需的 flowPlan。
    static assembleFlow(bodyParas, tocParas, plan) {
        const paras = [];
        const bodyIndexOfPara = [];
        const insertions = new Map();
        let tocRange = null;
        let bodyIdx = 0;
        const pushBodyUntil = cut => {
            while (bodyIdx < cut && bodyIdx < bodyParas.length) {
                bodyIndexOfPara.push(bodyIdx);
                paras.push(bodyParas[bodyIdx]);
                bodyIdx++;
            }
        };
        for (const cut of plan?.cuts || []) {
            pushBodyUntil(cut.bodyCut);
            const at = paras.length;
            const sides = [];
            let hasToc = false;
            for (const block of cut.blocks) {
                if (block === 'toc') hasToc = true;
                else sides.push(block);
            }
            if (sides.length) insertions.set(at, sides);
            if (hasToc && tocParas.length) {
                const start = paras.length;
                for (const p of tocParas) {
                    bodyIndexOfPara.push(-1);
                    paras.push(p);
                }
                tocRange = { start, end: paras.length };
            }
        }
        pushBodyUntil(bodyParas.length);
        return { paras, flowPlan: { tocRange, insertions, bodyIndexOfPara } };
    }

    static buildTocPrefix(rawText, config, context, tocPrependStr = '', previewRender = null) {
        if (!config.aux.toc) {
            this._tocPreviewCache = null;
            return tocPrependStr;
        }

        const previewKey = this.getTocPreviewKey(previewRender);
        const cacheKey = this.getTocCacheKey(rawText, config, context);
        const cachedPreview = previewRender?.enabled && this._tocPreviewCache?.key === cacheKey
            ? this._tocPreviewCache
            : null;
        let chapters;
        if (cachedPreview && Array.isArray(cachedPreview.chapters)) {
            chapters = cachedPreview.chapters.map(chapter => ({ title: chapter.title }));
        } else {
            // A cache miss is deliberately calculated in full. This keeps the
            // first preview, and previews after structural/config changes,
            // correct; repeated body edits take the bounded fast path below.
            chapters = this.getBodyFlow(rawText, config, context).layout.chapters || [];
        }
        context._tocReuse = null;
        const prefixTemplate = Object.hasOwn(config.aux, 'tocPrefix')
            ? config.aux.tocPrefix
            : '#目录\n\n#${title}\n\n';
        const formatTemplate = config.aux.tocFormat || '=@${volume}!=第${page}页@';
        const staticPrefix = `!#目录!\n${this.resolveTocTemplate(prefixTemplate, config)}`;
        const rawTocFontSize = config.aux.tocFontSize;
        const tocFontSize = rawTocFontSize === null || rawTocFontSize === undefined || rawTocFontSize === ''
            ? null
            : Number(rawTocFontSize);
        const hasTocStyle = !!config.aux.tocFontName || Number.isFinite(tocFontSize) || !!config.aux.tocFontColor;
        const styleTocEntry = value => {
            if (!hasTocStyle) return String(value || '');
            const line = String(value || '');
            const controls = TextParser.consumeControlPrefix(line);
            let prefixLength = line.length - controls.text.length;
            const marker = controls.text.match(/^([!！]?[+\-:]?[=≈≡]+&*[+\-:]?)/);
            if (marker) prefixLength += marker[1].length;
            const prefix = line.slice(0, prefixLength);
            const body = line.slice(prefixLength);
            return body ? `${prefix}<STYLE:tocStyle>${body}</STYLE>` : line;
        };
        const styleTocEntries = entries => String(entries || '').split('\n').map(styleTocEntry).join('\n');
        const joinPrefixAndEntries = (prefix, entries) => {
            if (!prefix) return entries;
            if (!entries) return prefix;
            return prefix.endsWith('\n') ? prefix + entries : `${prefix}\n${entries}`;
        };
        const appendDirectoryBreak = value => {
            const text = String(value || '');
            return /(?:^|\n)%[ \t]*$/.test(text)
                ? text
                : `${text}${text.endsWith('\n') ? '' : '\n'}%`;
        };

        let pageValues = chapters.map((chapter, index) => {
            const cachedValues = cachedPreview?.pageValues?.[index];
            return {
                volume: chapter.title,
                volumeNumber: index + 1,
                pageNumber: Number.isFinite(cachedValues?.pageNumber) ? cachedValues.pageNumber : 1,
                pageLNumber: Number.isFinite(cachedValues?.pageLNumber) ? cachedValues.pageLNumber : 1,
                pageRNumber: Number.isFinite(cachedValues?.pageRNumber) ? cachedValues.pageRNumber : 1
            };
        });
        let renderedToc = staticPrefix;

        // On a repeated editor preview, probe only through the requested page
        // window and reuse the probe layout for the final calculation. A full
        // generation or cache miss retains the original four-pass convergence.
        const probePreview = cachedPreview ? previewRender : null;
        const maxPasses = cachedPreview ? 2 : 4;
        for (let pass = 0; pass < maxPasses; pass++) {
            const entries = chapters.map((chapter, index) => {
                const values = pageValues[index] || { volume: chapter.title, volumeNumber: index + 1 };
                return this.resolveTocTemplate(formatTemplate, config, {
                    ...values,
                    volume: chapter.title,
                    volumeNumber: index + 1
                });
            }).join('\n');
            renderedToc = appendDirectoryBreak(joinPrefixAndEntries(staticPrefix, styleTocEntries(entries)));

            if (!chapters.length) break;
            const prefixParas = TextParser.tokenize(renderedToc, config, context);
            // 排版流拼装：目录可按“插入位置”排在正文第 N 页之后，
            // 牌记/刊署也可插入正文任意位置（见 computeInsertionPlan/assembleFlow）。
            const insertPlan = this.computeInsertionPlan(config, rawText, context, prefixParas.length > 0);
            const probeFlow = this.assembleFlow(this.getBodyFlow(rawText, config, context).bodyParas, prefixParas, insertPlan);
            // 拼装后的排版与最终排版完全一致（便于 #2 复用）
            const probeLayout = new LayoutEngine(config, context).calculate(probeFlow.paras, probePreview, probeFlow.flowPlan);
            // #2：记录本轮探测；若最终目录与之一致，可直接复用为最终布局。
            context._tocReuse = {
                toc: renderedToc,
                layout: probeLayout,
                tocParas: prefixParas.length,
                previewKey
            };
            // 只统计正文章节（目录自身的标题段落排在 toc 侧，不参与目录条目）
            const rawChapters = (probeLayout.chapters || []).filter(chapter => {
                const sideIdx = Math.floor((Number(chapter.col) || 0) / Math.max(1, Number(config.page.cols) || 1));
                return probeLayout.sideRegions?.[sideIdx] !== 'toc';
            });
            const nextValues = chapters.map((chapter, index) => {
                const measured = rawChapters[index];
                return measured
                    ? { volume: chapter.title, ...this.getTocPageValues(measured.col, config, probeLayout.specialSides, index + 1) }
                    : pageValues[index];
            });
            const stable = nextValues.every((next, index) => {
                const prev = pageValues[index] || {};
                return next.pageNumber === prev.pageNumber && next.pageLNumber === prev.pageLNumber && next.pageRNumber === prev.pageRNumber;
            });
            pageValues = nextValues;
            if (stable) break;
        }

        if (chapters.length) {
            const entries = chapters.map((chapter, index) => this.resolveTocTemplate(
                formatTemplate,
                config,
                { ...(pageValues[index] || {}), volume: chapter.title, volumeNumber: index + 1 }
            )).join('\n');
            renderedToc = appendDirectoryBreak(joinPrefixAndEntries(staticPrefix, styleTocEntries(entries)));
        }

        this._tocPreviewCache = {
            key: cacheKey,
            chapters: chapters.map(chapter => ({ title: chapter.title })),
            pageValues: pageValues.map(values => ({
                pageNumber: values.pageNumber,
                pageLNumber: values.pageLNumber,
                pageRNumber: values.pageRNumber
            }))
        };

        return renderedToc ? `${renderedToc}${renderedToc.endsWith('\n') ? '' : '\n'}` : '';
    }

    static calculateLayout(rawText, tocPrefix, config, context, previewRender) {
        const reuse = context?._tocReuse;
        const normalizedPrefix = tocPrefix || '';
        if (context) context._tocReuse = null;
        // #2：目录探测最后一轮已经是"最终目录 + 正文"的排版结果，直接复用。
        if (reuse && reuse.layout && reuse.previewKey === this.getTocPreviewKey(previewRender) &&
            `${reuse.toc}${reuse.toc.endsWith('\n') ? '' : '\n'}` === normalizedPrefix) {
            return { layoutData: reuse.layout, currentTocParasCount: reuse.tocParas };
        }
        const tocParas = normalizedPrefix ? TextParser.tokenize(normalizedPrefix, config, context) : [];
        const insertPlan = this.computeInsertionPlan(config, rawText, context, tocParas.length > 0);
        // computeInsertionPlan 仅在存在 N>0 的插入位置时才做正文完整排版；
        // 其余情况只需一次分词即可拼装排版流。
        const bodyParas = context?._bodyFlow?.rawText === rawText
            ? context._bodyFlow.bodyParas
            : TextParser.tokenize(rawText, config, context);
        const assembled = this.assembleFlow(bodyParas, tocParas, insertPlan);
        const layoutData = new LayoutEngine(config, context).calculate(assembled.paras, previewRender, assembled.flowPlan);
        return { layoutData, currentTocParasCount: tocParas.length };
    }

    static buildPreviewPlan(layoutData, config, previewRender) {
        const pageOffset = config.cover.mode !== 'none' ? 1 : 0;
        const totalPdfPages = pageOffset + Math.max(0, PDFRenderer.getMaxSpreadIdx(layoutData, config) + 1);
        let pageRange = null;
        let previewMeta = { partial: false, totalPages: totalPdfPages, targetPage: null, startPage: 1, endPage: totalPdfPages };

        if (previewRender?.enabled && totalPdfPages > 0) {
            const before = Math.max(0, Math.min(50, Number.parseInt(previewRender.before, 10) || 0));
            const after = Math.max(0, Math.min(50, Number.parseInt(previewRender.after, 10) || 0));
            const cursorParaIdx = Math.max(0, Number.parseInt(previewRender.cursorParaIdx, 10) || 0);
            const bodyParaStarts = layoutData.bodyParaStarts || [];
            const paraStarts = layoutData.paraStarts || [];
            const paraInfo = bodyParaStarts[cursorParaIdx] || paraStarts[paraStarts.length - 1];
            let targetPage = paraInfo ? Math.floor(paraInfo.col / (config.page.cols * 2)) + pageOffset + 1 : 1;
            targetPage = Math.max(1, Math.min(totalPdfPages, targetPage));
            const startPage = Math.max(1, targetPage - before);
            const endPage = Math.min(totalPdfPages, targetPage + after);
            pageRange = { startPage, endPage };
            previewMeta = { partial: true, totalPages: totalPdfPages, targetPage, startPage, endPage };
        }
        return { pageRange, previewMeta };
    }

    static async applyPageDesigns(basePdfBytes, config, pageDesigns, fontsData, imagesData, layoutData, context, options = {}) {
        if (!pageDesigns || Object.keys(pageDesigns).length === 0) return basePdfBytes;
        const designDoc = await PDFDocument.load(basePdfBytes);
        designDoc.registerFontkit(self.fontkit);
        const designFonts = await PageDesignRenderer.embedDesignFonts(designDoc, fontsData);
        await PageDesignRenderer.applyDesignsToDoc(
            designDoc,
            config,
            pageDesigns,
            designFonts,
            { items: {}, job: context },
            imagesData,
            layoutData,
            options
        );
        try {
            return await designDoc.save();
        } catch (error) {
            Utils.logDocumentSaveFontFailure(error);
            throw error;
        }
    }
}

class WorkerCommands {
    static async dispatch({ type, payload }) {
        switch (type) {
            case 'GENERATE':
                await this.generate(payload);
                return;
            case 'APPLY_DESIGNS':
                await this.applyDesigns(payload);
                return;
            case 'SPLIT_EXPORT':
                await this.splitExport(payload);
                return;
            default:
                throw new Error(`不支持的 Worker 命令：${type || '(empty)'}`);
        }
    }

    static async applyDesigns(payload) {
        try {
            const input = await RenderPipeline.runStage('页面设计请求校验', () => RenderPipeline.validatePageDesignInput(payload));
            const { baseBytes, pageDesigns, config, fontsData, imagesData, layoutData } = input;
            EventBus.emit('progress', { text: '合成页面设计...', percent: 85, detail: '附加自定义页面设计' });
            const finalPdfBytes = await RenderPipeline.runStage('页面设计合成', async () => {
                const doc = await PDFDocument.load(baseBytes);
                doc.registerFontkit(self.fontkit);
                const fonts = await PageDesignRenderer.embedDesignFonts(doc, fontsData);
                await PageDesignRenderer.applyDesignsToDoc(
                    doc,
                    config,
                    pageDesigns,
                    fonts,
                    { items: {} },
                    imagesData,
                    layoutData,
                    {
                        sourceStartPdfPage: input.sourceStartPdfPage,
                        sourceTotalPdfPages: input.sourceTotalPdfPages
                    }
                );
                try {
                    return await doc.save();
                } catch (error) {
                    Utils.logDocumentSaveFontFailure(error);
                    throw error;
                }
            });
            WorkerRuntime.post('APPLY_DESIGNS_SUCCESS', { pdfBytes: finalPdfBytes }, [finalPdfBytes.buffer]);
        } catch (error) {
            if (error?.code === 'NEED_FONTS') { WorkerRuntime.post('NEED_FONTS', { missing: error.missing }); return; }
            WorkerRuntime.post('ERROR', { message: RenderPipeline.getErrorMessage(error) });
        }
    }

    static async splitExport(payload) {
        try {
            const input = await RenderPipeline.runStage('单页导出请求校验', () => RenderPipeline.validateSplitExportInput(payload));
            const { pdfBytes, config, meta } = input;
            const finalPdfBytes = await RenderPipeline.runStage('单页 PDF 拆分', async () => {
                const origPdf = await PDFDocument.load(pdfBytes);
                const newPdf = await PDFDocument.create();
                const pages = origPdf.getPages();
                const map = PageDesignRenderer.buildCenterCutSplitMap(pages, config);

                for (let i = 0; i < map.length; i++) {
                    const info = map[i];
                    const page = pages[info.pdfPageIndex];
                    const embeddedPage = await newPdf.embedPage(page);
                    newPdf.addPage([info.width, info.height]).drawPage(embeddedPage, {
                        x: info.side === 'right' ? -info.x : 0,
                        y: 0,
                        width: page.getWidth(),
                        height: page.getHeight()
                    });
                    if (i % 5 === 0) {
                        EventBus.emit('progress', { text: '正在拆分页面...', percent: 10 + Math.floor((i / Math.max(1, map.length)) * 80), detail: `第 ${i + 1}/${map.length} 个单页` });
                    }
                }

                if (meta?.chapters?.length) {
                    const items = PDFRenderer.getSplitOutlineItems(meta.chapters, meta.pageOffset, meta.colsPerSpread, meta.cols, meta.hasCover, newPdf.getPageCount());
                    PDFRenderer.buildPdfOutlines(newPdf, items);
                }

                EventBus.emit('progress', { text: '打包单页 PDF...', percent: 95, detail: '即将开始下载' });
                return newPdf.save();
            });
            WorkerRuntime.post('SPLIT_EXPORT_SUCCESS', { pdfBytes: finalPdfBytes }, [finalPdfBytes.buffer]);
        } catch (error) {
            WorkerRuntime.post('ERROR', { message: RenderPipeline.getErrorMessage(error) });
        }
    }

    static async generate(payload) {
    let context = null;
    try {
        const input = await RenderPipeline.runStage('请求校验', () => RenderPipeline.validateInput(payload));
        const { rawText, colors, tocPrependStr, fontsData, imagesData, previewRender, pageDesigns } = input;
        WorkerRuntime.post('PROGRESS', { percent: 15, text: '处理字体...', detail: '解析字库数据' });
        context = RenderPipeline.createContext(input);
        const { doc, fonts, renderConfig } = await RenderPipeline.runStage(
            '字体与文档初始化',
            () => RenderPipeline.createSession(input, context)
        );

        let finalTocPrependStr = tocPrependStr;
        if (renderConfig.aux.toc) {
            WorkerRuntime.post('PROGRESS', { percent: 25, text: '分析文章结构...', detail: '正在模拟排版以提取章节与页码' });
            finalTocPrependStr = await RenderPipeline.runStage(
                '目录预分析',
                () => RenderPipeline.buildTocPrefix(rawText, renderConfig, context, tocPrependStr, previewRender)
            );
        }

        WorkerRuntime.post('PROGRESS', { percent: 40, text: '生成排版网格...', detail: '正在生成直排网格参数' });
        const { layoutData, currentTocParasCount } = await RenderPipeline.runStage(
            '正文布局计算',
            () => RenderPipeline.calculateLayout(rawText, finalTocPrependStr, renderConfig, context, previewRender)
        );
        const { pageRange, previewMeta } = await RenderPipeline.runStage(
            '预览范围计算',
            () => RenderPipeline.buildPreviewPlan(layoutData, renderConfig, { ...previewRender, currentTocParasCount })
        );

        const pdfBytes = await RenderPipeline.runStage(
            '基础 PDF 绘制',
            () => PDFRenderer.render(layoutData, renderConfig, colors, doc, fonts, { pageRange, context })
        );
        delete layoutData.getColGeometry;
        delete layoutData.__imagesBySpread; delete layoutData.__halfBySpread; delete layoutData.__overlaysBySpread; delete layoutData.__mergeIndex;

        const basePdfBytes = pdfBytes;
        let finalPdfBytes = basePdfBytes;

        if (pageDesigns && Object.keys(pageDesigns).length > 0) {
            EventBus.emit('progress', { text: '合成页面设计...', percent: 85, detail: '附加自定义页面设计' });
            // #4：直接在同一个 doc 上叠加页面设计，复用已嵌入字体，不再 load+重新嵌入字体+二次 save
            finalPdfBytes = await RenderPipeline.runStage(
                '页面设计合成',
                async () => {
                    await PageDesignRenderer.applyDesignsToDoc(
                        doc, renderConfig, pageDesigns, fonts, { items: {}, job: context }, imagesData, layoutData,
                        { sourceStartPdfPage: pageRange?.startPage || 1, sourceTotalPdfPages: previewMeta?.totalPages, freshContentStream: true }
                    );
                    // 二次 save 时 pdf-lib 会为“已修改”的子集字体重新注册 CIDFont/FontDescriptor/FontFile 对象，
                    // 旧对象会成为孤儿仍被写入文件（体积膨胀）。这里先记录旧引用，flush 后删除再 save。
                    const stale = Utils.collectFontSubObjectRefs(doc);
                    try {
                        await doc.flush();                      // 先重嵌入被改动的字体子集
                        Utils.deleteStaleFontSubObjects(doc, stale); // 再移除旧子对象，避免孤儿对象写入文件
                        return await doc.save();
                    } catch (error) { Utils.logDocumentSaveFontFailure(error); throw error; }
                }
            );
        }

        const transferables = [finalPdfBytes.buffer];
        if (finalPdfBytes !== basePdfBytes) transferables.push(basePdfBytes.buffer);

        WorkerRuntime.post(
            'SUCCESS',
            { pdfBytes: finalPdfBytes, basePdfBytes, layoutData, currentTocParasCount, previewMeta },
            transferables
        );

    } catch (error) {
        if (error?.code === 'NEED_FONTS') { WorkerRuntime.post('NEED_FONTS', { missing: error.missing }); return; }
        WorkerRuntime.post('ERROR', { message: RenderPipeline.getErrorMessage(error) });
    } finally {
        context?.dispose();
    }
    }
}

self.onmessage = event => {
    const envelope = event.data || {};
    const requestId = envelope.requestId || `legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    WorkerRuntime.enqueue({ requestId, type: envelope.type, payload: envelope.payload || {} });
};
