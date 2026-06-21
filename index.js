/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  回忆博物馆 Memory Museum  —  index.js                          ║
 * ║  SillyTavern 第三方扩展主入口                                    ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * 代码按「区块」组织，每个区块对应规格里的一个模块。需要自定义的地方
 * 都标了「可修改」注释，方便在 GitHub 上直接搜索修改。
 */

// ===================================================================
//  酒馆核心导入（路径与同类扩展 star 一致，请勿改动）
// ===================================================================
import {
    eventSource,
    event_types,
    messageFormatting,
    getRequestHeaders,
    saveSettingsDebounced,
} from '../../../../script.js';

import {
    getContext,
    extension_settings,
} from '../../../extensions.js';

import {
    POPUP_TYPE,
    POPUP_RESULT,
    callGenericPopup,
} from '../../../popup.js';

// ===================================================================
//  本扩展数据层
// ===================================================================
import * as DB from './js/storage.js';

// 加强版 Eruda 调试（加载完酒馆后再 init）
setTimeout(() => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/eruda';
    s.onload = () => {
        try {
            eruda.init({
                container: document.body,
                tool: ['console', 'elements', 'network']
            });
            eruda.show('console');   // 直接打开 console
            console.log('%c[Memory-Museum] Eruda 已强制启动 ✅', 'color:#8B4D3B;font-size:14px');
        } catch(e) {
            console.error('[Memory-Museum] Eruda 启动失败', e);
        }
    };
    document.head.appendChild(s);
}, 1500);   // 延迟1.5秒，等酒馆加载完

// ===================================================================
//  ★★★ 配置区 CONFIG ★★★  （素材 URL / 尺寸 / 数量，随意改）
// ===================================================================
const CONFIG = {
    // —— 素材 URL ——（换成你自己的图床链接即可）
    cdSkin: 'https://files.catbox.moe/jltrum.png',     // CD 悬浮球图片
    tonearm: 'https://files.catbox.moe/hy5ixg.png',    // 唱片机机臂（盖在悬浮球右上，固定不转）
    background: 'https://files.catbox.moe/3z3q8i.jpg', // 面板背景纹理

    // 首页装饰照片（开场散落用，可任意增删）
    decorImages: [
        'https://files.catbox.moe/hv7hlt.jpg',
        'https://files.catbox.moe/frgfxh.jpg',
        'https://files.catbox.moe/l0p4af.jpg',
        'https://files.catbox.moe/0mhkn8.jpg',
        'https://files.catbox.moe/qob7j8.jpg',
        'https://files.catbox.moe/583l9w.jpg',
        'https://files.catbox.moe/xbprxn.jpg',
    ],

    // 三个板块的 tab 图标（顺序：文段品鉴 / 回忆薄 / 故事片段，可互换）
    tabIcons: {
        quote: 'https://files.catbox.moe/oglgrr.png',  // 文段品鉴
        memory: 'https://files.catbox.moe/ubpmbz.png', // 回忆薄
        story: 'https://files.catbox.moe/iunjgv.png',  // 故事片段
    },

    // —— 尺寸 / 数量 ——
    cdSize: 64,            // 可修改：CD 悬浮球直径(px)
    tabIconSize: 30,       // 可修改：tab 图标尺寸(px)，三个图标统一这个大小
    decorOnScreen: 8,      // 可修改：开场同时出现的散落照片实例数（源图会被复用）
    maxTitlesHint: 18,     // 提示：单屏标题建议上限（超出会自动加高滚动）

    // —— 一键收藏的爱心符号 ——
    heartEmpty: '♡',       // 未收藏
    heartFull: '♥',        // 已收藏
};

const SECTIONS = {
    quote: { key: 'quote', name: '文段品鉴' },
    memory: { key: 'memory', name: '回忆薄' },
    story: { key: 'story', name: '故事片段' },
};

// ===================================================================
//  运行时 UI 状态
// ===================================================================
let panelEl = null;          // 面板根元素
let cdEl = null;             // CD 悬浮球
let audioEl = null;          // <audio>
let isPanelOpen = false;
let currentView = 'home';    // 'home' | 'collection' | 'album'
let currentCollectionId = null;
let currentTab = 'quote';
let batchMode = false;       // 当前板块是否处于批量选择模式
const selectedIds = new Set();

// 音乐三层优先级用的「上下文栈」
let musicContext = { entryId: null, collectionId: null };

// ===================================================================
//  小工具
// ===================================================================
function toast(msg, type = 'info') {
    try {
        if (typeof toastr !== 'undefined' && toastr[type]) toastr[type](msg, '', { timeOut: 1800 });
    } catch (e) { /* ignore */ }
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 解析媒体地址：兼容「酒馆返回的路径」与「base64 data URL 兜底」 */
function resolveMediaUrl(path) {
    if (!path) return '';
    if (/^(https?:|data:|blob:)/i.test(path)) return path;
    return path.startsWith('/') ? path : '/' + path; // 可修改：若你的酒馆静态路径不同，改这里
}

function getCurrentChatId() {
    try {
        const ctx = getContext();
        return String(ctx.chatId || '').replace('.jsonl', '');
    } catch (e) { return ''; }
}

/** 文件转 base64（去掉 data:...;base64, 前缀） */
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1]);
        r.onerror = reject;
        r.readAsDataURL(file);
    });
}

/** 文件转完整 data URL（兜底用） */
function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = reject;
        r.readAsDataURL(file);
    });
}

/**
 * ★ 媒体上传（方案 a：走酒馆文件接口，返回路径只存引用）★
 * 不同酒馆版本的上传端点可能不同——如果上传失败，只需要改这一个函数。
 * 图片上传失败时会兜底转成 base64 data URL（保证图片功能可用）；
 * 音乐文件较大，不做 base64 兜底，失败会直接提示。
 */
async function uploadMedia(file, { allowDataUrlFallback = false } = {}) {
    try {
        const base64 = await fileToBase64(file);
        const resp = await fetch('/api/files/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name: file.name, data: base64 }),
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        const path = data.path || data.url || data.name;
        if (!path) throw new Error('返回结果没有 path 字段');
        return path;
    } catch (err) {
        console.error('[memory-museum] 上传失败:', err);
        if (allowDataUrlFallback) {
            toast('上传接口不可用，已临时内嵌图片', 'warning');
            return await fileToDataURL(file); // 兜底：直接内嵌
        }
        throw err;
    }
}

/** 弹一个文件选择框 */
function pickFile(accept, multiple = false) {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.multiple = multiple;
        input.style.display = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', () => {
            const files = Array.from(input.files || []);
            input.remove();
            resolve(multiple ? files : files[0] || null);
        });
        input.click();
    });
}

// ===================================================================
//  ♫ 音乐播放器（顶栏 + 三层优先级）
// ===================================================================
let currentMusicId = null;

function ensureAudio() {
    if (audioEl) return audioEl;
    audioEl = document.createElement('audio');
    audioEl.id = 'mm-audio';
    audioEl.loop = true; // 可修改：单曲循环；想顺序播放改 false 并监听 ended
    document.body.appendChild(audioEl);
    audioEl.addEventListener('play', syncCdSpin);
    audioEl.addEventListener('pause', syncCdSpin);
    return audioEl;
}

function playMusicById(id, { autoplay = true } = {}) {
    const m = DB.getMusic(id);
    if (!m) return;
    ensureAudio();
    if (currentMusicId !== id) {
        audioEl.src = resolveMediaUrl(m.path);
        currentMusicId = id;
        m.lastPlayed = new Date().toISOString();
        DB.save();
    }
    if (autoplay) {
        const p = audioEl.play();
        if (p && p.catch) p.catch(() => {/* 浏览器可能拦截自动播放，用户手动点一下即可 */});
    }
    updatePlayerBar();
}

function togglePlay() {
    ensureAudio();
    if (!currentMusicId) {
        // 没有当前曲目就尝试播默认音乐
        if (DB.state.settings.defaultMusicId) playMusicById(DB.state.settings.defaultMusicId);
        return;
    }
    if (audioEl.paused) audioEl.play().catch(() => {});
    else audioEl.pause();
    updatePlayerBar();
}

function playNext() {
    const list = DB.state.music;
    if (!list.length) return;
    const idx = list.findIndex(m => m.id === currentMusicId);
    const next = list[(idx + 1) % list.length];
    if (next) playMusicById(next.id);
}

/** 根据当前上下文（条目 > 收藏集 > 默认）解析应播放的音乐 */
function resolveContextMusic() {
    let target = null;
    if (musicContext.entryId) {
        const e = DB.getEntry(musicContext.entryId);
        if (e && e.musicId) target = e.musicId;
    }
    if (!target && musicContext.collectionId) {
        const c = DB.getCollection(musicContext.collectionId);
        if (c && c.themeMusic) target = c.themeMusic;
    }
    if (!target) target = DB.state.settings.defaultMusicId;

    if (target && target !== currentMusicId) {
        playMusicById(target);
    } else if (!target) {
        // 没有任何可播放音乐时不报错，仅停在当前
    }
}

function updatePlayerBar() {
    if (!panelEl) return;
    const bar = panelEl.querySelector('.mm-player');
    if (!bar) return;
    const m = DB.getMusic(currentMusicId);
    const nameEl = bar.querySelector('.mm-player-name');
    const playIcon = bar.querySelector('.mm-player-play i');
    if (nameEl) nameEl.textContent = m ? m.name : '未播放';
    const playing = audioEl && !audioEl.paused && currentMusicId;
    if (playIcon) playIcon.className = playing ? 'fa-solid fa-pause' : 'fa-solid fa-play';
    bar.classList.toggle('mm-playing', !!playing);
}

function syncCdSpin() {
    if (!cdEl) return;
    const playing = audioEl && !audioEl.paused && currentMusicId;
    cdEl.classList.toggle('mm-spinning', !!playing);
    updatePlayerBar();
}

// ===================================================================
//  ◉ CD 悬浮球（入口，可拖动，播放时旋转；机臂固定不转）
// ===================================================================
function createCdBall() {
    if (cdEl) return;
    cdEl = document.createElement('div');
    cdEl.id = 'mm-cd';
    cdEl.innerHTML = `
        <div class="mm-cd-disc" style="background-image:url('${CONFIG.cdSkin}')"></div>
        <img class="mm-cd-arm" src="${CONFIG.tonearm}" alt="" draggable="false">
    `;
    document.body.appendChild(cdEl);

    // 恢复保存的位置
    const pos = DB.state.settings.cdPos;
    if (pos && typeof pos.left === 'number') {
        cdEl.style.left = pos.left + 'px';
        cdEl.style.top = pos.top + 'px';
        cdEl.style.right = 'auto';
        cdEl.style.bottom = 'auto';
    }

    // 拖动 + 点击（区分单击与拖动）
    let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0, lastUp = 0;
    const down = (e) => {
        if (Date.now() - lastUp < 500) return; // 屏蔽触摸后浏览器补发的鼠标事件，避免重复触发
        dragging = true; moved = false;
        const pt = e.touches ? e.touches[0] : e;
        sx = pt.clientX; sy = pt.clientY;
        const rect = cdEl.getBoundingClientRect();
        ox = rect.left; oy = rect.top;
        document.addEventListener('mousemove', move);
        document.addEventListener('touchmove', move, { passive: false });
        document.addEventListener('mouseup', up);
        document.addEventListener('touchend', up);
    };
    const move = (e) => {
        if (!dragging) return;
        const pt = e.touches ? e.touches[0] : e;
        const dx = pt.clientX - sx, dy = pt.clientY - sy;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
        let nl = ox + dx, nt = oy + dy;
        nl = Math.max(0, Math.min(window.innerWidth - cdEl.offsetWidth, nl));
        nt = Math.max(0, Math.min(window.innerHeight - cdEl.offsetHeight, nt));
        cdEl.style.left = nl + 'px';
        cdEl.style.top = nt + 'px';
        cdEl.style.right = 'auto';
        cdEl.style.bottom = 'auto';
        if (e.cancelable) e.preventDefault();
    };
    const up = () => {
        if (!dragging) return;
        dragging = false;
        lastUp = Date.now();
        document.removeEventListener('mousemove', move);
        document.removeEventListener('touchmove', move);
        document.removeEventListener('mouseup', up);
        document.removeEventListener('touchend', up);
        if (moved) {
            const rect = cdEl.getBoundingClientRect();
            DB.state.settings.cdPos = { left: rect.left, top: rect.top };
            DB.save();
        } else {
            togglePanel(); // 没拖动 = 单击 = 开关面板
        }
    };
    cdEl.addEventListener('mousedown', down);
    cdEl.addEventListener('touchstart', down, { passive: true });
}

// ===================================================================
//  ▢ 面板外壳（开 / 关 / 顶栏 / 底部胶片条）
// ===================================================================
function buildPanel() {
    if (panelEl) return;
    panelEl = document.createElement('div');
    panelEl.id = 'mm-panel';
    panelEl.style.setProperty('--mm-cd-size', CONFIG.cdSize + 'px');
    panelEl.style.setProperty('--mm-tab-icon', CONFIG.tabIconSize + 'px');
    panelEl.innerHTML = `
        <div class="mm-dialog" style="background-image:url('${CONFIG.background}')">
            <div class="mm-bg-overlay"></div>

            <!-- 顶栏：Album 音乐播放器 -->
            <div class="mm-player">
                <div class="mm-player-disc"></div>
                <div class="mm-player-name">未播放</div>
                <div class="mm-player-ctrl">
                    <div class="mm-player-play mm-icon-btn" title="播放/暂停"><i class="fa-solid fa-play"></i></div>
                    <div class="mm-player-next mm-icon-btn" title="下一首"><i class="fa-solid fa-forward-step"></i></div>
                    <div class="mm-player-album mm-icon-btn" title="打开 Album"><i class="fa-solid fa-compact-disc"></i></div>
                </div>
                <div class="mm-close mm-icon-btn" title="关闭"><i class="fa-solid fa-xmark"></i></div>
            </div>

            <!-- 内容舞台 -->
            <div class="mm-stage"></div>

            <!-- 底部胶片条 -->
            <div class="mm-filmstrip">
                <div class="mm-film-perf mm-film-perf-top"></div>
                <div class="mm-film-cells">
                    <div class="mm-film-cell" data-action="new-collection" title="新建收藏集">
                        <i class="fa-solid fa-plus"></i><span>新建</span>
                    </div>
                    <div class="mm-film-cell" data-action="album" title="音乐 Album">
                        <i class="fa-solid fa-compact-disc"></i><span>Album</span>
                    </div>
                    <div class="mm-film-cell" data-action="home" title="回到首页">
                        <i class="fa-solid fa-house"></i><span>首页</span>
                    </div>
                </div>
                <div class="mm-film-perf mm-film-perf-bottom"></div>
            </div>
        </div>
    `;
    document.body.appendChild(panelEl);

    // —— 事件绑定 ——
    panelEl.querySelector('.mm-close').addEventListener('click', closePanel);
    panelEl.querySelector('.mm-player-play').addEventListener('click', togglePlay);
    panelEl.querySelector('.mm-player-next').addEventListener('click', playNext);
    panelEl.querySelector('.mm-player-album').addEventListener('click', () => renderAlbum());
    // 点击半透明遮罩空白处关闭
    panelEl.addEventListener('click', (e) => { if (e.target === panelEl) closePanel(); });

    panelEl.querySelector('.mm-filmstrip').addEventListener('click', (e) => {
        const cell = e.target.closest('.mm-film-cell');
        if (!cell) return;
        const act = cell.dataset.action;
        if (act === 'new-collection') openCollectionForm();
        else if (act === 'album') renderAlbum();
        else if (act === 'home') renderHome();
    });
}

function togglePanel() {
    if (isPanelOpen) closePanel();
    else openPanel();
}

function openPanel() {
    buildPanel();
    ensureAudio();
    isPanelOpen = true;
    panelEl.classList.add('mm-open');
    renderHome(true); // 带入场动画
    // 默认音乐自动播放
    musicContext = { entryId: null, collectionId: null };
    if (DB.state.settings.defaultMusicId) {
        playMusicById(DB.state.settings.defaultMusicId);
    }
    updatePlayerBar();
}

function closePanel() {
    if (!panelEl) return;
    isPanelOpen = false;
    panelEl.classList.remove('mm-open');
    // 关闭面板 → 停止播放（符合规格：默认音乐在关闭面板时停止）
    if (audioEl) audioEl.pause();
    syncCdSpin();
}

function getStage() { return panelEl ? panelEl.querySelector('.mm-stage') : null; }

// ===================================================================
//  🏠 首页（散落的收藏集标题 + 装饰照片）
// ===================================================================
function renderHome(withEntrance = false) {
    currentView = 'home';
    currentCollectionId = null;
    musicContext = { entryId: null, collectionId: null };
    resolveContextMusic();

    const stage = getStage();
    if (!stage) return;

    const cols = DB.state.collections;
    // 标题多了就加高舞台以便滚动（可修改：拥挤时每多一个标题增加的高度 px）
    const extraPx = Math.max(0, cols.length - CONFIG.maxTitlesHint) * 48;
    let html = `<div class="mm-home" style="min-height:calc(100% + ${extraPx}px)">`;

    // 装饰照片（错乱重叠、随机淡化、可溢出面板边缘）
    html += renderDecorLayer();

    // 收藏集标题
    if (cols.length === 0) {
        html += `<div class="mm-empty-home">还没有收藏集。点底部胶片条的「新建」开始吧。</div>`;
    } else {
        cols.forEach(c => {
            const p = c.position || DB.generateScatterPosition();
            const delay = (Math.random() * 0.9).toFixed(2); // 入场错峰
            // 卡片只负责居中 + 透明度；旋转/缩放放 inner；呼吸放 text，三者互不打架
            const cardStyle = `left:${(p.x * 100).toFixed(2)}%;top:${(p.y * 100).toFixed(2)}%;` +
                `--mm-op:${p.opacity.toFixed(2)};--mm-delay:${delay}s;`;
            const innerStyle = `transform:rotate(${p.rotation.toFixed(1)}deg) scale(${p.scale.toFixed(2)});`;
            html += `<div class="mm-title-card" data-col="${c.id}" style="${cardStyle}">
                        <div class="mm-title-inner" style="${innerStyle}">
                            <span class="mm-title-text">${escapeHtml(c.title)}</span>
                        </div>
                     </div>`;
        });
    }
    html += `</div>`;
    stage.innerHTML = html;
    stage.classList.toggle('mm-entrance', withEntrance);

    // 标题点击 → 进入收藏集；长按 → 编辑/删除菜单
    stage.querySelectorAll('.mm-title-card').forEach(card => {
        let lpTimer, isLong = false;
        const start = () => { clearTimeout(lpTimer); isLong = false; lpTimer = setTimeout(() => { isLong = true; openCollectionMenu(card.dataset.col); }, 600); };
        const end = () => clearTimeout(lpTimer);
        card.addEventListener('mousedown', start);
        card.addEventListener('touchstart', start, { passive: true });
        card.addEventListener('mouseup', end);
        card.addEventListener('mouseleave', end);
        card.addEventListener('touchend', end);
        card.addEventListener('click', () => { if (!isLong) renderCollection(card.dataset.col); });
    });

    if (withEntrance) runEntranceAnimation(stage);
}

/** 装饰照片图层：源图复用，每个实例随机位置/角度/缩放/透明度，允许溢出 */
function renderDecorLayer() {
    const imgs = CONFIG.decorImages;
    if (!imgs.length) return '';
    let html = `<div class="mm-decor-layer">`;
    for (let i = 0; i < CONFIG.decorOnScreen; i++) {
        const src = imgs[i % imgs.length];
        // 可修改：装饰照片的随机分布范围（含负值 = 溢出面板边缘）
        const left = (-8 + Math.random() * 108).toFixed(1);
        const top = (-6 + Math.random() * 110).toFixed(1);
        const rot = (Math.random() * 50 - 25).toFixed(1);      // ±25°
        const w = (60 + Math.random() * 70).toFixed(0);        // 60–130px
        const op = (0.14 + Math.random() * 0.42).toFixed(2);   // 0.14–0.56 毫无规律的淡化
        const delay = (Math.random() * 1.2).toFixed(2);        // 入场错峰
        html += `<img class="mm-decor" src="${src}" alt="" draggable="false"
                    style="left:${left}%;top:${top}%;width:${w}px;
                    --mm-rot:${rot}deg;--mm-op:${op};--mm-delay:${delay}s;">`;
    }
    html += `</div>`;
    return html;
}

/** 收藏集长按菜单：编辑标题 / 绑定主题曲 / 删除 */
async function openCollectionMenu(colId) {
    const col = DB.getCollection(colId);
    if (!col) return;
    const choice = await pickFromList('收藏集操作', [
        { id: 'edit', label: '编辑标题', icon: 'fa-pen' },
        { id: 'music', label: '绑定主题曲', icon: 'fa-music' },
        { id: 'reshuffle', label: '重新散落位置', icon: 'fa-shuffle' },
        { id: 'delete', label: '删除收藏集', icon: 'fa-trash', danger: true },
    ]);
    if (!choice) return;
    if (choice === 'edit') openCollectionForm(colId);
    else if (choice === 'music') await bindCollectionMusic(colId);
    else if (choice === 'reshuffle') { DB.updateCollection(colId, { position: DB.generateScatterPosition() }); renderHome(); }
    else if (choice === 'delete') {
        const ok = await callGenericPopup(`删除收藏集「${escapeHtml(col.title)}」？<br>其下所有条目都会一并删除，无法恢复。`, POPUP_TYPE.CONFIRM);
        if (ok === POPUP_RESULT.AFFIRMATIVE) { DB.deleteCollection(colId); toast('已删除', 'success'); renderHome(); }
    }
}

/** 新建 / 编辑收藏集 */
function openCollectionForm(colId = null) {
    const col = colId ? DB.getCollection(colId) : null;
    openFormModal({
        title: col ? '编辑收藏集' : '新建收藏集',
        fields: [{ key: 'title', label: '收藏集标题', type: 'text', value: col ? col.title : '', placeholder: '比如：骗人，你分明舍不得我' }],
        onSubmit: (vals) => {
            const t = (vals.title || '').trim();
            if (!t) { toast('标题不能为空', 'warning'); return false; }
            if (col) { DB.updateCollection(colId, { title: t }); }
            else { DB.createCollection(t); }
            renderHome();
            return true;
        },
    });
}

async function bindCollectionMusic(colId) {
    const id = await pickMusic('选择收藏集主题曲（进入时自动播放）');
    if (id === undefined) return; // 取消
    DB.updateCollection(colId, { themeMusic: id });
    toast(id ? '已绑定主题曲' : '已取消绑定', 'success');
}

// ===================================================================
//  📂 收藏集内部（左侧 tab + 右侧内容）
// ===================================================================
function renderCollection(colId) {
    const col = DB.getCollection(colId);
    if (!col) { renderHome(); return; }
    currentView = 'collection';
    currentCollectionId = colId;
    currentTab = currentTab || 'quote';
    batchMode = false; selectedIds.clear();

    // 进入收藏集 → 切换主题曲
    musicContext = { entryId: null, collectionId: colId };
    resolveContextMusic();

    const stage = getStage();
    if (!stage) return;
    stage.classList.remove('mm-entrance');

    stage.innerHTML = `
        <div class="mm-collection">
            <div class="mm-tabbar">
                <div class="mm-back mm-icon-btn" title="返回首页"><i class="fa-solid fa-arrow-left"></i></div>
                ${Object.values(SECTIONS).map(s => `
                    <div class="mm-tab ${s.key === currentTab ? 'active' : ''}" data-tab="${s.key}" title="${s.name}">
                        <img src="${CONFIG.tabIcons[s.key]}" alt="${s.name}">
                    </div>`).join('')}
            </div>
            <div class="mm-content">
                <div class="mm-col-title">${escapeHtml(col.title)}</div>
                <div class="mm-section"></div>
            </div>
        </div>`;

    stage.querySelector('.mm-back').addEventListener('click', () => renderHome());
    stage.querySelectorAll('.mm-tab').forEach(t => {
        t.addEventListener('click', () => {
            currentTab = t.dataset.tab;
            batchMode = false; selectedIds.clear();
            renderCollection(colId); // 重渲染切 tab（带轻过渡）
        });
    });

    renderSection();
}

/** 渲染当前板块的内容列表 + 工具条 */
function renderSection() {
    const stage = getStage();
    if (!stage) return;
    const container = stage.querySelector('.mm-section');
    if (!container) return;
    const sec = SECTIONS[currentTab];
    const list = DB.getEntriesOf(currentCollectionId, currentTab);

    // 工具条：新增 / 刷新 / 批量
    let html = `
        <div class="mm-toolbar">
            <div class="mm-tool-left">${sec.name}<span class="mm-count">${list.length}</span></div>
            <div class="mm-tool-right">
                <div class="mm-tool-btn" data-act="add" title="新增"><i class="fa-solid fa-plus"></i></div>
                <div class="mm-tool-btn" data-act="refresh" title="刷新"><i class="fa-solid fa-rotate"></i></div>
                <div class="mm-tool-btn ${batchMode ? 'active' : ''}" data-act="batch" title="批量管理"><i class="fa-solid fa-list-check"></i></div>
            </div>
        </div>`;

    if (batchMode) {
        html += `<div class="mm-batch-bar">
            <label class="mm-batch-all"><input type="checkbox" class="mm-check-all"> 全选</label>
            <div class="mm-batch-del mm-tool-btn danger"><i class="fa-solid fa-trash"></i> 删除所选 (<span class="mm-sel-count">0</span>)</div>
        </div>`;
    }

    html += `<div class="mm-entry-list">`;
    if (list.length === 0) {
        html += `<div class="mm-empty">这里还空着。点右上角的 + 添加第一条${sec.name === '故事片段' ? '（也可以在聊天里点 ♡ 一键收藏）' : ''}。</div>`;
    } else {
        list.forEach(e => html += renderEntryCard(e));
    }
    html += `</div>`;
    container.innerHTML = html;

    // 工具条事件
    container.querySelector('[data-act="add"]').addEventListener('click', () => openEntryForm(currentTab, currentCollectionId));
    container.querySelector('[data-act="refresh"]').addEventListener('click', () => { renderSection(); toast('已刷新', 'success'); });
    container.querySelector('[data-act="batch"]').addEventListener('click', () => { batchMode = !batchMode; selectedIds.clear(); renderSection(); });

    if (batchMode) {
        const allCb = container.querySelector('.mm-check-all');
        allCb.addEventListener('change', () => {
            container.querySelectorAll('.mm-entry-check').forEach(cb => {
                cb.checked = allCb.checked;
                const id = cb.closest('.mm-entry-card').dataset.id;
                if (allCb.checked) selectedIds.add(id); else selectedIds.delete(id);
            });
            updateSelCount();
        });
        container.querySelector('.mm-batch-del').addEventListener('click', batchDelete);
    }

    // 渲染条目内部的富文本 iframe（保留正则美化）
    bindEntryCardEvents(container);
    // story 类型用 messageFormatting 渲染
    container.querySelectorAll('.mm-entry-body[data-format="story"]').forEach(renderStoryBody);
}

function renderEntryCard(e) {
    const checkHtml = batchMode
        ? `<input type="checkbox" class="mm-entry-check" ${selectedIds.has(e.id) ? 'checked' : ''}>`
        : '';
    const titleHtml = e.title ? `<div class="mm-entry-title">${escapeHtml(e.title)}</div>` : '';
    const dateStr = formatDate(e.date);
    const music = e.musicId ? DB.getMusic(e.musicId) : null;
    const musicHtml = music ? `<span class="mm-entry-music" title="绑定：${escapeHtml(music.name)}"><i class="fa-solid fa-music"></i></span>` : '';

    // 图片缩略图
    let imgsHtml = '';
    if (e.images && e.images.length) {
        imgsHtml = `<div class="mm-entry-imgs">` +
            e.images.map(p => `<img class="mm-thumb" src="${resolveMediaUrl(p)}" alt="" loading="lazy">`).join('') +
            `</div>`;
    }

    // 正文：story 走 messageFormatting，其余转义 + 换行
    let bodyHtml;
    if (e.type === 'story') {
        bodyHtml = `<div class="mm-entry-body" data-format="story" data-raw="${encodeURIComponent(e.content)}" data-sender="${escapeHtml(e.meta?.senderName || '')}"></div>`;
    } else {
        bodyHtml = `<div class="mm-entry-body">${escapeHtml(e.content).replace(/\n/g, '<br>')}</div>`;
    }

    return `
        <div class="mm-entry-card ${e.type}" data-id="${e.id}">
            <div class="mm-entry-head">
                ${checkHtml}
                <div class="mm-entry-meta">
                    ${titleHtml}
                    <span class="mm-entry-date">${dateStr}</span>
                    ${musicHtml}
                </div>
                <div class="mm-entry-actions">
                    <i class="fa-solid fa-pen mm-act-edit" title="编辑"></i>
                    <i class="fa-solid fa-trash mm-act-del" title="删除"></i>
                </div>
            </div>
            ${bodyHtml}
            ${imgsHtml}
        </div>`;
}

function renderStoryBody(el) {
    const raw = decodeURIComponent(el.dataset.raw || '');
    const sender = el.dataset.sender || '';
    try {
        // messageFormatting(mes, name, isSystem, isUser, messageId, sanitizerOverrides, isReasoning)
        el.innerHTML = messageFormatting(raw, sender, false, false, null, {}, false);
    } catch (err) {
        el.innerHTML = escapeHtml(raw).replace(/\n/g, '<br>');
    }
    renderIframesInElement(el);
}

function bindEntryCardEvents(container) {
    container.querySelectorAll('.mm-entry-card').forEach(card => {
        const id = card.dataset.id;
        const edit = card.querySelector('.mm-act-edit');
        const del = card.querySelector('.mm-act-del');
        const check = card.querySelector('.mm-entry-check');
        if (edit) edit.addEventListener('click', (ev) => { ev.stopPropagation(); openEntryForm(currentTab, currentCollectionId, id); });
        if (del) del.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const ok = await callGenericPopup('删除这条收藏？', POPUP_TYPE.CONFIRM);
            if (ok === POPUP_RESULT.AFFIRMATIVE) { DB.deleteEntry(id); refreshFavoriteHearts(); renderSection(); toast('已删除', 'success'); }
        });
        if (check) check.addEventListener('change', () => {
            if (check.checked) selectedIds.add(id); else selectedIds.delete(id);
            updateSelCount();
        });
        // 点卡片正文 → 打开详情（播放条目绑定音乐）
        const body = card.querySelector('.mm-entry-body');
        if (body) body.addEventListener('click', () => { if (!batchMode) openEntryDetail(id); });
        // 缩略图点击放大
        card.querySelectorAll('.mm-thumb').forEach(t => t.addEventListener('click', (ev) => { ev.stopPropagation(); openLightbox(t.src); }));
    });
}

function updateSelCount() {
    const stage = getStage();
    if (!stage) return;
    const c = stage.querySelector('.mm-sel-count');
    if (c) c.textContent = selectedIds.size;
}

async function batchDelete() {
    if (selectedIds.size === 0) { toast('还没选中任何条目', 'warning'); return; }
    const ok = await callGenericPopup(`删除选中的 ${selectedIds.size} 条收藏？`, POPUP_TYPE.CONFIRM);
    if (ok === POPUP_RESULT.AFFIRMATIVE) {
        DB.deleteEntries(Array.from(selectedIds));
        selectedIds.clear();
        batchMode = false;
        refreshFavoriteHearts();
        renderSection();
        toast('已批量删除', 'success');
    }
}

// ===================================================================
//  📝 条目新增 / 编辑 / 详情
// ===================================================================
function openEntryForm(type, colId, entryId = null) {
    const entry = entryId ? DB.getEntry(entryId) : null;
    // 临时图片数组（编辑时拷贝一份）
    let images = entry ? [...(entry.images || [])] : [];
    let musicId = entry ? entry.musicId : null;

    openFormModal({
        title: (entry ? '编辑' : '新增') + SECTIONS[type].name,
        fields: [
            { key: 'title', label: '标题（可选）', type: 'text', value: entry ? entry.title : '', placeholder: '不填会留空' },
            { key: 'content', label: '内容', type: 'textarea', value: entry ? entry.content : '', placeholder: type === 'quote' ? '收藏的句子 / 对话…' : type === 'memory' ? '写下你们的纪念…' : '剧情正文…' },
        ],
        // 额外区：图片 + 音乐绑定
        extraRender: (wrap) => {
            const extra = document.createElement('div');
            extra.className = 'mm-form-extra';
            extra.innerHTML = `
                <div class="mm-form-label">图片</div>
                <div class="mm-form-imgs"></div>
                <div class="mm-form-addimg mm-tool-btn"><i class="fa-solid fa-image"></i> 添加图片</div>
                <div class="mm-form-label">绑定音乐（可选）</div>
                <div class="mm-form-music mm-tool-btn"><i class="fa-solid fa-music"></i> <span class="mm-form-music-name">未绑定</span></div>
            `;
            wrap.appendChild(extra);
            const imgsBox = extra.querySelector('.mm-form-imgs');
            const musicName = extra.querySelector('.mm-form-music-name');

            const drawImgs = () => {
                imgsBox.innerHTML = images.map((p, i) =>
                    `<div class="mm-form-img"><img src="${resolveMediaUrl(p)}"><span class="mm-form-img-del" data-i="${i}">×</span></div>`
                ).join('');
                imgsBox.querySelectorAll('.mm-form-img-del').forEach(b =>
                    b.addEventListener('click', () => { images.splice(+b.dataset.i, 1); drawImgs(); }));
            };
            const drawMusic = () => { const m = musicId ? DB.getMusic(musicId) : null; musicName.textContent = m ? m.name : '未绑定'; };
            drawImgs(); drawMusic();

            extra.querySelector('.mm-form-addimg').addEventListener('click', async () => {
                const files = await pickFile('image/png,image/jpeg,image/webp,image/gif', true);
                const arr = Array.isArray(files) ? files : (files ? [files] : []);
                for (const f of arr) {
                    try { const path = await uploadMedia(f, { allowDataUrlFallback: true }); images.push(path); }
                    catch (e) { toast('图片添加失败', 'error'); }
                }
                drawImgs();
            });
            extra.querySelector('.mm-form-music').addEventListener('click', async () => {
                const id = await pickMusic('为这条内容绑定音乐');
                if (id !== undefined) { musicId = id; drawMusic(); }
            });
        },
        onSubmit: (vals) => {
            const fields = { title: (vals.title || '').trim(), content: vals.content || '', images, musicId };
            if (!fields.content.trim() && images.length === 0) { toast('内容和图片至少要有一个', 'warning'); return false; }
            if (entry) DB.updateEntry(entryId, fields);
            else DB.createEntry(type, colId, fields);
            renderSection();
            return true;
        },
    });
}

/** 条目详情（全文 + 大图 + 播放绑定音乐） */
function openEntryDetail(entryId) {
    const e = DB.getEntry(entryId);
    if (!e) return;

    // 条目级音乐：打开详情时切换（优先级最高）
    const prevContext = { ...musicContext };
    musicContext = { entryId: e.id, collectionId: currentCollectionId };
    resolveContextMusic();

    const overlay = document.createElement('div');
    overlay.className = 'mm-overlay mm-detail-overlay';

    let bodyHtml;
    if (e.type === 'story') bodyHtml = `<div class="mm-detail-body" data-format="story"></div>`;
    else bodyHtml = `<div class="mm-detail-body">${escapeHtml(e.content).replace(/\n/g, '<br>')}</div>`;

    const imgsHtml = (e.images && e.images.length)
        ? `<div class="mm-detail-imgs">${e.images.map(p => `<img src="${resolveMediaUrl(p)}" class="mm-thumb">`).join('')}</div>` : '';

    overlay.innerHTML = `
        <div class="mm-detail">
            <div class="mm-detail-head">
                <div class="mm-detail-title">${escapeHtml(e.title || SECTIONS[e.type].name)}</div>
                <div class="mm-detail-close mm-icon-btn"><i class="fa-solid fa-xmark"></i></div>
            </div>
            <div class="mm-detail-scroll">
                <div class="mm-detail-date">${formatDate(e.date)}</div>
                ${bodyHtml}
                ${imgsHtml}
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const storyBody = overlay.querySelector('.mm-detail-body[data-format="story"]');
    if (storyBody) {
        try { storyBody.innerHTML = messageFormatting(e.content, e.meta?.senderName || '', false, false, null, {}, false); }
        catch (err) { storyBody.innerHTML = escapeHtml(e.content).replace(/\n/g, '<br>'); }
        renderIframesInElement(storyBody);
    }
    overlay.querySelectorAll('.mm-thumb').forEach(t => t.addEventListener('click', () => openLightbox(t.src)));

    const close = () => {
        overlay.remove();
        // 退出详情 → 恢复收藏集音乐
        musicContext = prevContext;
        resolveContextMusic();
    };
    overlay.querySelector('.mm-detail-close').addEventListener('click', close);
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
}

// ===================================================================
//  💿 Album（全局音乐 + 跨收藏集关联聚合）
// ===================================================================
function renderAlbum() {
    currentView = 'album';
    const stage = getStage();
    if (!stage) return;
    stage.classList.remove('mm-entrance');

    const music = DB.state.music;
    let html = `
        <div class="mm-album">
            <div class="mm-album-head">
                <div class="mm-back mm-icon-btn" title="返回首页"><i class="fa-solid fa-arrow-left"></i></div>
                <div class="mm-album-title">Album</div>
                <div class="mm-album-add mm-tool-btn" title="导入音乐"><i class="fa-solid fa-plus"></i> 导入</div>
            </div>
            <div class="mm-album-list">`;
    if (music.length === 0) {
        html += `<div class="mm-empty">音乐库是空的。点右上角「导入」添加 mp3 / wav / ogg / flac。</div>`;
    } else {
        music.forEach(m => {
            const isDefault = DB.state.settings.defaultMusicId === m.id;
            const cnt = DB.getMusicBindCount(m.id);
            const playing = currentMusicId === m.id && audioEl && !audioEl.paused;
            html += `
                <div class="mm-music-row ${m.id === currentMusicId ? 'current' : ''}" data-id="${m.id}">
                    <div class="mm-music-play mm-icon-btn"><i class="fa-solid ${playing ? 'fa-pause' : 'fa-play'}"></i></div>
                    <div class="mm-music-info">
                        <div class="mm-music-name">${escapeHtml(m.name)} ${isDefault ? '<span class="mm-default-tag">默认</span>' : ''}</div>
                        <div class="mm-music-sub">关联 ${cnt} 条</div>
                    </div>
                    <div class="mm-music-acts">
                        <i class="fa-solid fa-link mm-music-assoc" title="查看关联内容"></i>
                        <i class="fa-solid fa-star mm-music-default" title="设为默认音乐"></i>
                        <i class="fa-solid fa-trash mm-music-del" title="删除"></i>
                    </div>
                </div>
                <div class="mm-music-assoc-panel" data-for="${m.id}" style="display:none"></div>`;
        });
    }
    html += `</div></div>`;
    stage.innerHTML = html;

    stage.querySelector('.mm-back').addEventListener('click', () => renderHome());
    stage.querySelector('.mm-album-add').addEventListener('click', importMusic);

    stage.querySelectorAll('.mm-music-row').forEach(row => {
        const id = row.dataset.id;
        row.querySelector('.mm-music-play').addEventListener('click', () => {
            if (currentMusicId === id && audioEl && !audioEl.paused) { audioEl.pause(); updatePlayerBar(); renderAlbumPlayIcons(); }
            else { playMusicById(id); renderAlbumPlayIcons(); }
        });
        row.querySelector('.mm-music-default').addEventListener('click', () => {
            DB.setDefaultMusic(DB.state.settings.defaultMusicId === id ? null : id);
            renderAlbum();
        });
        row.querySelector('.mm-music-del').addEventListener('click', async () => {
            const m = DB.getMusic(id);
            const ok = await callGenericPopup(`删除音乐「${escapeHtml(m?.name || '')}」？所有绑定会被解除。`, POPUP_TYPE.CONFIRM);
            if (ok === POPUP_RESULT.AFFIRMATIVE) {
                if (currentMusicId === id && audioEl) { audioEl.pause(); currentMusicId = null; }
                DB.deleteMusic(id); renderAlbum();
            }
        });
        row.querySelector('.mm-music-assoc').addEventListener('click', () => toggleAssocPanel(id));
    });
}

function renderAlbumPlayIcons() {
    const stage = getStage();
    if (!stage) return;
    stage.querySelectorAll('.mm-music-row').forEach(row => {
        const id = row.dataset.id;
        const icon = row.querySelector('.mm-music-play i');
        const playing = currentMusicId === id && audioEl && !audioEl.paused;
        if (icon) icon.className = 'fa-solid ' + (playing ? 'fa-pause' : 'fa-play');
        row.classList.toggle('current', id === currentMusicId);
    });
}

/** 展开/收起某首歌的关联内容（按收藏集分组，可点跳转） */
function toggleAssocPanel(musicId) {
    const stage = getStage();
    const panel = stage.querySelector(`.mm-music-assoc-panel[data-for="${musicId}"]`);
    if (!panel) return;
    if (panel.style.display !== 'none') { panel.style.display = 'none'; panel.innerHTML = ''; return; }

    const entries = DB.getEntriesByMusic(musicId);
    if (entries.length === 0) { panel.innerHTML = `<div class="mm-empty mm-small">还没有内容绑定这首歌。</div>`; panel.style.display = 'block'; return; }

    // 按收藏集分组
    const groups = {};
    entries.forEach(e => { (groups[e.collectionId] = groups[e.collectionId] || []).push(e); });
    let html = '';
    Object.keys(groups).forEach(colId => {
        const col = DB.getCollection(colId);
        html += `<div class="mm-assoc-group">
            <div class="mm-assoc-col" data-col="${colId}">📁 ${escapeHtml(col ? col.title : '已删除的收藏集')}</div>`;
        groups[colId].forEach(e => {
            const preview = (e.title || e.content || '').slice(0, 40);
            html += `<div class="mm-assoc-item" data-col="${colId}" data-tab="${e.type}">
                        <span class="mm-assoc-sec">${SECTIONS[e.type].name}</span> ${escapeHtml(preview)}
                     </div>`;
        });
        html += `</div>`;
    });
    panel.innerHTML = html;
    panel.style.display = 'block';

    // 点击关联项 → 跳转到对应收藏集 + 板块
    panel.querySelectorAll('.mm-assoc-col, .mm-assoc-item').forEach(it => {
        it.addEventListener('click', () => {
            const colId = it.dataset.col;
            if (!DB.getCollection(colId)) { toast('该收藏集已被删除', 'warning'); return; }
            if (it.dataset.tab) currentTab = it.dataset.tab;
            renderCollection(colId);
        });
    });
}

async function importMusic() {
    const file = await pickFile('audio/mpeg,audio/wav,audio/ogg,audio/flac,.mp3,.wav,.ogg,.flac');
    if (!file) return;
    toast('正在导入音乐…', 'info');
    try {
        const path = await uploadMedia(file, { allowDataUrlFallback: false });
        const name = file.name.replace(/\.[^.]+$/, '');
        DB.addMusic(name, path);
        toast('已导入', 'success');
        renderAlbum();
    } catch (e) {
        toast('音乐导入失败：上传接口不可用（见控制台）', 'error');
    }
}

// ===================================================================
//  🎞 入场动画（简化版，确保稳定）
// ===================================================================
function runEntranceAnimation(stage) {
    // 元素初始为模糊/低透明，下一帧加 .mm-in 触发过渡（错峰由 --mm-delay 控制）
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            stage.querySelectorAll('.mm-decor, .mm-title-card').forEach(el => el.classList.add('mm-in'));
        });
    });
    // 动画结束后移除入场标记，保留呼吸感
    setTimeout(() => { stage.classList.remove('mm-entrance'); }, 3200); // 可修改：入场总时长
}

// ===================================================================
//  通用 UI：表单弹窗 / 列表选择 / 音乐选择 / 大图 / iframe 渲染
// ===================================================================
function openFormModal({ title, fields, onSubmit, extraRender }) {
    const overlay = document.createElement('div');
    overlay.className = 'mm-overlay mm-form-overlay';
    overlay.innerHTML = `
        <div class="mm-form">
            <div class="mm-form-head">
                <div class="mm-form-title">${escapeHtml(title)}</div>
                <div class="mm-form-close mm-icon-btn"><i class="fa-solid fa-xmark"></i></div>
            </div>
            <div class="mm-form-body"></div>
            <div class="mm-form-foot">
                <button class="mm-btn mm-btn-cancel">取消</button>
                <button class="mm-btn mm-btn-ok">保存</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    const body = overlay.querySelector('.mm-form-body');

    const inputs = {};
    fields.forEach(f => {
        const row = document.createElement('div');
        row.className = 'mm-form-row';
        if (f.type === 'textarea') {
            row.innerHTML = `<div class="mm-form-label">${escapeHtml(f.label)}</div>
                <textarea class="mm-input mm-textarea" placeholder="${escapeHtml(f.placeholder || '')}"></textarea>`;
        } else {
            row.innerHTML = `<div class="mm-form-label">${escapeHtml(f.label)}</div>
                <input type="text" class="mm-input" placeholder="${escapeHtml(f.placeholder || '')}">`;
        }
        body.appendChild(row);
        const inp = row.querySelector('.mm-input');
        inp.value = f.value || '';
        inputs[f.key] = inp;
    });
    if (extraRender) extraRender(body);

    const close = () => overlay.remove();
    const submit = () => {
        const vals = {};
        Object.keys(inputs).forEach(k => vals[k] = inputs[k].value);
        const result = onSubmit(vals);
        if (result !== false) close();
    };
    overlay.querySelector('.mm-form-close').addEventListener('click', close);
    overlay.querySelector('.mm-btn-cancel').addEventListener('click', close);
    overlay.querySelector('.mm-btn-ok').addEventListener('click', submit);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    const first = body.querySelector('.mm-input');
    if (first) setTimeout(() => first.focus(), 50);
}

/** 通用列表选择，返回选中的 id（取消返回 null） */
function pickFromList(title, items) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'mm-overlay mm-pick-overlay';
        overlay.innerHTML = `
            <div class="mm-pick">
                <div class="mm-pick-head">${escapeHtml(title)}</div>
                <div class="mm-pick-list">
                    ${items.map(it => `<div class="mm-pick-item ${it.danger ? 'danger' : ''}" data-id="${it.id}">
                        ${it.icon ? `<i class="fa-solid ${it.icon}"></i>` : ''}<span>${escapeHtml(it.label)}</span></div>`).join('')}
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const done = (v) => { overlay.remove(); resolve(v); };
        overlay.querySelectorAll('.mm-pick-item').forEach(it =>
            it.addEventListener('click', () => done(it.dataset.id)));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    });
}

/**
 * 音乐选择器。返回：音乐 id / null(取消绑定) / undefined(取消操作)
 */
function pickMusic(title) {
    return new Promise(resolve => {
        const music = DB.state.music;
        const overlay = document.createElement('div');
        overlay.className = 'mm-overlay mm-pick-overlay';
        overlay.innerHTML = `
            <div class="mm-pick">
                <div class="mm-pick-head">${escapeHtml(title)}</div>
                <div class="mm-pick-list">
                    <div class="mm-pick-item" data-id="__none__"><i class="fa-solid fa-ban"></i><span>不绑定 / 取消绑定</span></div>
                    ${music.length === 0 ? '<div class="mm-empty mm-small">音乐库为空，先去 Album 导入。</div>' :
                        music.map(m => `<div class="mm-pick-item" data-id="${m.id}"><i class="fa-solid fa-music"></i><span>${escapeHtml(m.name)}</span></div>`).join('')}
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const done = (v) => { overlay.remove(); resolve(v); };
        overlay.querySelectorAll('.mm-pick-item').forEach(it =>
            it.addEventListener('click', () => done(it.dataset.id === '__none__' ? null : it.dataset.id)));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) done(undefined); });
    });
}

function openLightbox(src) {
    const overlay = document.createElement('div');
    overlay.className = 'mm-overlay mm-lightbox';
    overlay.innerHTML = `<img src="${src}" alt=""><div class="mm-lightbox-close mm-icon-btn"><i class="fa-solid fa-xmark"></i></div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', close);
}

/** 渲染条目正文里的 HTML 代码块为 iframe（沿用 star 的桥接思路，保留美化效果） */
function renderIframesInElement(el) {
    if (!el) return;
    el.querySelectorAll('pre').forEach(pre => {
        const code = pre.textContent || '';
        if (code.includes('<body') && code.includes('</body>')) {
            const iframe = document.createElement('iframe');
            iframe.style.cssText = 'width:100%;border:none;margin:5px 0;display:block;overflow:hidden;';
            iframe.setAttribute('srcdoc', code);
            iframe.addEventListener('load', () => {
                try {
                    const b = iframe.contentWindow.document.body;
                    if (b) {
                        const fix = () => { iframe.style.height = b.scrollHeight + 'px'; };
                        new ResizeObserver(fix).observe(b);
                        fix();
                    }
                } catch (e) { /* ignore */ }
            });
            pre.replaceWith(iframe);
        }
    });
}

function formatDate(iso) {
    try {
        const d = new Date(iso);
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    } catch (e) { return ''; }
}

// ===================================================================
//  ♡ 一键收藏（聊天界面，AI 回复，收过一次就不再收）
// ===================================================================
const HEART_CLASS = 'mm-fav-toggle';
const heartButtonHtml = `
    <div class="mes_button ${HEART_CLASS} interactable" title="收藏到回忆博物馆" tabindex="0">
        <span class="mm-heart">${CONFIG.heartEmpty}</span>
    </div>`;

function injectHeartIcons() {
    // 只给 AI 回复加 ♡
    document.querySelectorAll('#chat .mes').forEach(mes => {
        if (mes.getAttribute('is_user') === 'true') return; // 跳过用户消息
        const btns = mes.querySelector('.mes_block .ch_name .mes_buttons') || mes.querySelector('.mes_buttons');
        if (!btns || btns.querySelector('.' + HEART_CLASS)) return;
        btns.insertAdjacentHTML('afterbegin', heartButtonHtml);
    });
    refreshFavoriteHearts();
}

function refreshFavoriteHearts() {
    const chatId = getCurrentChatId();
    document.querySelectorAll('#chat .mes').forEach(mes => {
        const heart = mes.querySelector('.' + HEART_CLASS + ' .mm-heart');
        if (!heart) return;
        const mid = mes.getAttribute('mesid');
        const fav = DB.findStoryByMessage(chatId, mid);
        heart.textContent = fav ? CONFIG.heartFull : CONFIG.heartEmpty;
        heart.parentElement.classList.toggle('mm-faved', !!fav);
    });
}

async function onHeartClick(heartBtn) {
    const mes = heartBtn.closest('.mes');
    if (!mes) return;
    const mid = mes.getAttribute('mesid');
    const chatId = getCurrentChatId();
    const existing = DB.findStoryByMessage(chatId, mid);

    if (existing) {
        // 已收藏 → 取消收藏
        const ok = await callGenericPopup('这条已经收藏过了，取消收藏吗？', POPUP_TYPE.CONFIRM);
        if (ok === POPUP_RESULT.AFFIRMATIVE) {
            DB.deleteEntry(existing.id);
            refreshFavoriteHearts();
            if (isPanelOpen && currentView === 'collection') renderSection();
            toast('已取消收藏', 'success');
        }
        return;
    }

    // 未收藏 → 选择收藏集
    const cols = DB.state.collections;
    if (cols.length === 0) {
        const create = await callGenericPopup('还没有收藏集，先创建一个吗？', POPUP_TYPE.CONFIRM);
        if (create !== POPUP_RESULT.AFFIRMATIVE) return;
        const name = await callGenericPopup('收藏集标题：', POPUP_TYPE.INPUT, '');
        if (!name) return;
        DB.createCollection(String(name).trim() || '未命名收藏集');
    }

    const items = DB.state.collections.map(c => ({ id: c.id, label: c.title, icon: 'fa-folder' }));
    const colId = await pickFromList('收藏到哪个收藏集？', items);
    if (!colId) return;

    // 取消息原文与元信息
    let mes_text = '', senderName = '';
    try {
        const ctx = getContext();
        const idx = parseInt(mid, 10);
        const msg = ctx.chat?.[idx];
        if (msg) { mes_text = msg.mes || ''; senderName = msg.name || ''; }
    } catch (e) { /* ignore */ }
    if (!mes_text) {
        // 兜底：从 DOM 抓取
        const mtext = mes.querySelector('.mes_text');
        mes_text = mtext ? mtext.textContent : '';
    }

    DB.createEntry('story', colId, {
        content: mes_text,
        meta: { senderName, isUser: false, chatId, messageId: mid },
    });
    refreshFavoriteHearts();
    if (isPanelOpen && currentView === 'collection' && currentCollectionId === colId && currentTab === 'story') renderSection();
    const col = DB.getCollection(colId);
    toast(`已收藏至「${col ? col.title : ''}」`, 'success');
}

// ===================================================================
//  🚀 初始化
// ===================================================================
jQuery(async () => {
    try {
        // 1. 数据层
        if (!extension_settings[PLUGIN]) extension_settings[PLUGIN] = {};
        DB.initStorage(extension_settings, saveSettingsDebounced);

        // 2. CD 悬浮球 + 音频
        createCdBall();
        ensureAudio();

        // 3. 在魔杖菜单加一个入口（防止悬浮球被拖到角落找不到）
        try {
            const btn = `<div id="mm-wand-btn" class="list-group-item flex-container flexGap5 interactable" title="回忆博物馆">
                <i class="fa-solid fa-compact-disc"></i><span>回忆博物馆</span></div>`;
            const container = document.getElementById('extensionsMenu') || document.getElementById('data_bank_wand_container');
            if (container) {
                container.insertAdjacentHTML('beforeend', btn);
                document.getElementById('mm-wand-btn')?.addEventListener('click', openPanel);
            }
        } catch (e) { /* 菜单容器可能因版本不同而缺失，忽略 */ }

        // 4. 一键收藏：注入 ♡ + 事件委托
        injectHeartIcons();
        document.addEventListener('click', (e) => {
            const heart = e.target.closest('.' + HEART_CLASS);
            if (heart) { e.preventDefault(); e.stopPropagation(); onHeartClick(heart); }
        });

        // 5. 监听聊天事件，保持 ♡ 状态同步
        const reinject = () => setTimeout(() => { injectHeartIcons(); }, 150);
        const onEvent = (name, fn) => { if (name) eventSource.on(name, fn); };
        onEvent(event_types.CHAT_CHANGED, reinject);
        onEvent(event_types.MESSAGE_RECEIVED, reinject);
        onEvent(event_types.MESSAGE_SENT, reinject);
        onEvent(event_types.MESSAGE_SWIPED, reinject);
        onEvent(event_types.MESSAGE_UPDATED, reinject);
        onEvent(event_types.MORE_MESSAGES_LOADED, reinject);

        // 6. 聊天 DOM 变化时补注入（新消息流式渲染）
        const chatEl = document.getElementById('chat');
        if (chatEl) {
            const obs = new MutationObserver(muts => {
                if (muts.some(m => m.addedNodes.length > 0)) requestAnimationFrame(injectHeartIcons);
            });
            obs.observe(chatEl, { childList: true });
        }

        console.log('[memory-museum] 回忆博物馆已加载');
    } catch (err) {
        console.error('[memory-museum] 初始化失败:', err);
    }
});
