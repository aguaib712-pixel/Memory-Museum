/**
 * Memory Museum - 数据层 (storage.js)
 * ------------------------------------------------------------
 * 这是纯数据模块，本身不直接 import 酒馆核心，避免深层相对路径出错。
 * 由 index.js 在初始化时通过 initStorage() 把 extension_settings 和
 * saveSettingsDebounced 注入进来。所有数据存在 extension_settings['memory-museum']，
 * 跟随酒馆设置体系自动保存（全局，不绑定角色 / 聊天）。
 * ------------------------------------------------------------
 */

const NS = 'memory-museum'; // 存储命名空间，一般不需要改

let _root = null;       // extension_settings 引用
let _saveFn = () => {}; // saveSettingsDebounced 引用

// 全局运行时状态（单一数据源）
export const state = {
    collections: [], // 收藏集
    entries: [],     // 内容条目（三个板块共用，用 type 区分）
    music: [],       // 音乐库（全局）
    settings: {      // 全局设置
        defaultMusicId: null, // 默认音乐
        cdPos: null,          // CD 悬浮球位置 {left, top}
    },
};

/** 生成简单 uuid（不依赖酒馆 utils，降低耦合） */
export function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

/** 初始化：注入依赖并从设置中载入数据 */
export function initStorage(extensionSettings, saveFn) {
    _root = extensionSettings;
    _saveFn = saveFn || (() => {});
    if (!_root[NS]) _root[NS] = {};
    const data = _root[NS];

    state.collections = Array.isArray(data.collections) ? data.collections : [];
    state.entries = Array.isArray(data.entries) ? data.entries : [];
    state.music = Array.isArray(data.music) ? data.music : [];
    state.settings = Object.assign({ defaultMusicId: null, cdPos: null }, data.settings || {});

    // 把引用写回，保证后续 save() 持久化的是同一批数组
    data.collections = state.collections;
    data.entries = state.entries;
    data.music = state.music;
    data.settings = state.settings;
}

/** 持久化到 extension_settings */
export function save() {
    if (_root && _root[NS]) {
        _root[NS].collections = state.collections;
        _root[NS].entries = state.entries;
        _root[NS].music = state.music;
        _root[NS].settings = state.settings;
    }
    try { _saveFn(); } catch (e) { console.error('[memory-museum] save failed:', e); }
}

/* ============================ 收藏集 ============================ */

/** 生成一个随机散落位置（百分比定位 0-1） */
export function generateScatterPosition() {
    return {
        // 可修改：标题在首页的随机分布范围
        x: 0.08 + Math.random() * 0.72,        // 横向 8%–80%
        y: 0.06 + Math.random() * 0.82,        // 纵向 6%–88%
        rotation: (Math.random() * 2 - 1) * 6, // 可修改：旋转角度 ±6°
        scale: 0.85 + Math.random() * 0.45,    // 可修改：缩放 0.85–1.30（模拟有的清晰有的模糊）
        opacity: 0.55 + Math.random() * 0.45,  // 可修改：透明度 0.55–1.0
    };
}

export function createCollection(title, themeMusic = null) {
    const col = {
        id: uuid(),
        title: title || '未命名收藏集',
        themeMusic: themeMusic,
        createdAt: new Date().toISOString(),
        position: generateScatterPosition(),
    };
    state.collections.push(col);
    save();
    return col;
}

export function updateCollection(id, patch) {
    const col = state.collections.find(c => c.id === id);
    if (!col) return null;
    Object.assign(col, patch);
    save();
    return col;
}

/** 删除收藏集，并级联删除其下所有条目 */
export function deleteCollection(id) {
    state.collections = state.collections.filter(c => c.id !== id);
    state.entries = state.entries.filter(e => e.collectionId !== id);
    save();
}

export function getCollection(id) {
    return state.collections.find(c => c.id === id) || null;
}

/* ============================ 内容条目 ============================ */

/**
 * 创建条目
 * @param {'quote'|'memory'|'story'} type
 */
export function createEntry(type, collectionId, fields = {}) {
    const entry = {
        id: uuid(),
        type,
        collectionId,
        title: fields.title || '',
        content: fields.content || '',
        date: new Date().toISOString(),
        images: Array.isArray(fields.images) ? fields.images : [],
        musicId: fields.musicId || null,
        tags: [], // 预留：标签筛选（第一阶段不实现）
        meta: fields.meta || { senderName: '', isUser: false, chatId: '', messageId: '' },
    };
    state.entries.push(entry);
    save();
    return entry;
}

export function updateEntry(id, patch) {
    const entry = state.entries.find(e => e.id === id);
    if (!entry) return null;
    Object.assign(entry, patch);
    save();
    return entry;
}

export function deleteEntry(id) {
    state.entries = state.entries.filter(e => e.id !== id);
    save();
}

/** 批量删除 */
export function deleteEntries(ids) {
    const set = new Set(ids);
    state.entries = state.entries.filter(e => !set.has(e.id));
    save();
}

export function getEntry(id) {
    return state.entries.find(e => e.id === id) || null;
}

/** 取某收藏集下某板块的条目（按时间倒序，新的在前） */
export function getEntriesOf(collectionId, type) {
    return state.entries
        .filter(e => e.collectionId === collectionId && e.type === type)
        .sort((a, b) => new Date(b.date) - new Date(a.date));
}

/** 判断某条聊天消息是否已被收藏（一键收藏「收过一次就不再收」用） */
export function findStoryByMessage(chatId, messageId) {
    return state.entries.find(e =>
        e.type === 'story' &&
        e.meta && String(e.meta.chatId) === String(chatId) &&
        String(e.meta.messageId) === String(messageId)
    ) || null;
}

/* ============================ 音乐 ============================ */

export function addMusic(name, path) {
    const m = { id: uuid(), name: name || '未命名音乐', path, bindCount: 0, lastPlayed: null };
    state.music.push(m);
    save();
    return m;
}

export function deleteMusic(id) {
    state.music = state.music.filter(m => m.id !== id);
    // 解除所有引用
    state.collections.forEach(c => { if (c.themeMusic === id) c.themeMusic = null; });
    state.entries.forEach(e => { if (e.musicId === id) e.musicId = null; });
    if (state.settings.defaultMusicId === id) state.settings.defaultMusicId = null;
    save();
}

export function getMusic(id) {
    return state.music.find(m => m.id === id) || null;
}

/** 动态统计某音乐被绑定的次数（收藏集主题曲 + 条目绑定） */
export function getMusicBindCount(musicId) {
    let n = 0;
    state.collections.forEach(c => { if (c.themeMusic === musicId) n++; });
    state.entries.forEach(e => { if (e.musicId === musicId) n++; });
    return n;
}

/** 取某音乐关联的所有条目（跨收藏集，Album 聚合视图用） */
export function getEntriesByMusic(musicId) {
    return state.entries.filter(e => e.musicId === musicId);
}

export function setDefaultMusic(id) {
    state.settings.defaultMusicId = id;
    save();
}
