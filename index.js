// Swipe Mix - pick paragraphs from several swipes of one reply and save them as a new swipe.
// The existing swipes are never changed. When a translation is stored for a swipe, the picker can
// show the translation while the saved text is always built from the original paragraphs.

const MODULE = 'swipeMix';
const DEFAULTS = Object.freeze({
    profileId: 'current', // what the two "fix" helpers send their request through: 'current' = the connection in use, or a connection profile id
    view: 'tr',      // 'tr' = show the stored translation when there is one, 'src' = original text
    menuButton: true, // puzzle button in the message menu
    nearButton: true, // small puzzle button by the swipe arrows of the newest reply
});

/** Blank-line paragraph break. */
const PARA_SPLIT = /\r?\n[\t ]*\r?\n(?:[\t ]*\r?\n)*/;
const HANGUL = /[ㄱ-ㆎ가-힣]/;

const CURRENT = 'current';

const ui = {};
/** Everything about the picker that is open right now (null when closed). */
let state = null;

function ctx() {
    return SillyTavern.getContext();
}

function settings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE]) extensionSettings[MODULE] = structuredClone(DEFAULTS);
    const s = extensionSettings[MODULE];
    for (const key of Object.keys(DEFAULTS)) {
        if (s[key] === undefined) s[key] = DEFAULTS[key];
    }
    return s;
}

function save() {
    ctx().saveSettingsDebounced();
}

function make(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else node.setAttribute(key, value);
    }
    for (const child of children) node.append(child);
    return node;
}

function icon(cls) {
    return make('i', { class: `fa-fw fa-solid ${cls}` });
}

function hasHangul(text) {
    return HANGUL.test(String(text ?? ''));
}

// ---------------------------------------------------------------- reading swipes

/** Splits a text into paragraphs at blank lines; a fenced code block stays in one piece. */
function splitParagraphs(text) {
    const raw = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (!raw) return [];
    const out = [];
    let open = null;
    for (const part of raw.split(PARA_SPLIT)) {
        if (open !== null) open += '\n\n' + part;
        else open = part;
        const fences = (open.match(/^\s*```/gm) || []).length;
        if (fences % 2 === 0) {
            if (open.trim()) out.push(open.replace(/\s+$/, ''));
            open = null;
        }
    }
    if (open !== null && open.trim()) out.push(open.replace(/\s+$/, ''));
    return out;
}

const HAS_TRANSLATED = /class="[^"]*\btranslated_text\b/;
const HAS_ORIGINAL = /class="[^"]*\boriginal_text\b/;
const GAP_LINE = /^<div class="[^"]*para-gap[^"]*"><\/div>$/;
const WHOLE_FOLD = /^<details class="[^"]*\bmode-(folded|original-first)\b[^"]*">\s*<summary[^>]*>([\s\S]*?)<\/summary>\s*([\s\S]*?)\s*<\/details>$/;

/** Text of a piece of markup. A <template> is inert: nothing in it runs or loads. */
function markupText(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html ?? '');
    return tpl.content.textContent ?? '';
}

/**
 * A translation can be stored together with the original, each line wrapped in markup that folds one
 * of the two away (or the whole text in one such block). This takes only the translated side out of it,
 * line for line, so it can be split into paragraphs like a plain translation. '' when the shape is unknown.
 */
function translationFromMarkup(text) {
    const whole = WHOLE_FOLD.exec(text.trim());
    if (whole && !HAS_TRANSLATED.test(text)) {
        const side = whole[1] === 'folded' ? whole[2] : whole[3];
        return markupText(side.replace(/<\/p>\s*<p>/g, '\n\n').replace(/<br\s*\/?>/g, '\n'));
    }
    const lines = text.split('\n').map((line) => {
        if (GAP_LINE.test(line.trim())) return '';
        if (!HAS_TRANSLATED.test(line)) return HAS_ORIGINAL.test(line) ? null : line;
        // heading, list and quote marks stay in front of the wrapper
        const at = line.search(/<(details|span)\b/);
        const tpl = document.createElement('template');
        tpl.innerHTML = line.slice(at);
        const node = tpl.content.querySelector('.translated_text');
        return node ? line.slice(0, at) + (node.textContent ?? '') : null;
    });
    return lines.includes(null) ? '' : lines.join('\n');
}

/** The stored translation of a swipe as plain text, or '' when there is none or it cannot be read. */
function plainTranslation(extra) {
    const text = extra?.display_text;
    if (typeof text !== 'string' || !text.trim()) return '';
    if (HAS_TRANSLATED.test(text) || HAS_ORIGINAL.test(text) || WHOLE_FOLD.test(text.trim())) return translationFromMarkup(text.replace(/\r\n?/g, '\n'));
    return text;
}

/** True when a translator that keeps its own bookkeeping for each translation has worked on this message. */
function hasManagedTranslation(message) {
    const marks = (extra) => !!extra && (extra.original_text_hash !== undefined || extra.translation_source !== undefined);
    if (marks(message.extra)) return true;
    return (Array.isArray(message.swipe_info) ? message.swipe_info : []).some(info => marks(info?.extra));
}

/** [{ index, current, paras: [{ src, tr }], translated }] for every swipe of the message. */
function readSwipes(message) {
    const texts = Array.isArray(message.swipes) && message.swipes.length ? message.swipes : [message.mes];
    const current = Number(message.swipe_id) || 0;
    return texts.map((text, index) => {
        const isCurrent = index === current;
        const source = isCurrent ? String(message.mes ?? text ?? '') : String(text ?? '');
        const extra = isCurrent ? message.extra : message.swipe_info?.[index]?.extra;
        const src = splitParagraphs(source);
        const stored = typeof extra?.display_text === 'string' && !!extra.display_text.trim();
        const tr = splitParagraphs(plainTranslation(extra));
        const same = tr.length > 0 && tr.join('\n') === src.join('\n');
        const paired = tr.length > 0 && tr.length === src.length && !same;
        // why a swipe shows its original text even though the translation view is on
        let note = '';
        if (!paired) {
            if (same) note = '원문 그대로';
            else if (stored && !tr.length) note = '번역 모양을 못 읽어 원문';
            else if (tr.length) note = '번역 문단 수가 달라 원문';
            else note = '번역 없음';
        }
        return {
            index,
            current: isCurrent,
            translated: paired,
            // a translation is there but could not be matched: always worth telling
            unread: !paired && stored && !same,
            note,
            paras: src.map((s, i) => ({ src: s, tr: paired ? tr[i] : '' })),
        };
    });
}

// ---------------------------------------------------------------- state helpers

function showTranslation() {
    return settings().view !== 'src' && state.swipes.some(s => s.translated);
}

function paraOf(pick) {
    return state.swipes[pick.s]?.paras[pick.p];
}

function shownText(para) {
    return showTranslation() && para.tr ? para.tr : para.src;
}

/** The text of a picked paragraph: the edited one when it was edited, otherwise the original. */
function pickText(pick) {
    return pick.text !== undefined ? pick.text : paraOf(pick).src;
}

function hasEdits() {
    return state.picks.some(pick => pick.text !== undefined);
}

/** The text that will be saved. */
function finalText() {
    return state.picks.map(pick => pickText(pick).trim()).filter(Boolean).join('\n\n');
}

/** 1-based paragraph numbers where the text switches to a different swipe. */
function seamNumbers() {
    const out = [];
    for (let i = 1; i < state.picks.length; i++) {
        if (state.picks[i].s !== state.picks[i - 1].s) out.push(i + 1);
    }
    return out;
}

// ---------------------------------------------------------------- picker

function buildOverlay() {
    // data-bl-native-ext-colors: some themes recolor every extension panel unless it is marked like this
    ui.overlay = make('div', { id: 'swm_overlay', class: 'swm_hidden', 'data-bl-native-ext-colors': '' });
    ui.panel = make('div', { id: 'swm_panel', role: 'dialog', 'aria-label': '스와이프 합치기' });

    ui.title = make('div', { class: 'swm_title', text: '합치기' });
    ui.viewTr = make('span', { class: 'swm_seg_btn', text: '번역' });
    ui.viewSrc = make('span', { class: 'swm_seg_btn', text: '원문' });
    ui.viewSeg = make('div', { class: 'swm_seg', title: '저장된 번역으로 보기 / 원문으로 보기' }, [ui.viewTr, ui.viewSrc]);
    ui.setBtn = make('div', { class: 'swm_iconbtn', title: '설정', tabindex: '0' }, [icon('fa-gear')]);
    ui.closeBtn = make('div', { class: 'swm_iconbtn', title: '닫기', tabindex: '0' }, [icon('fa-xmark')]);
    const head = make('div', { class: 'swm_head' }, [icon('fa-puzzle-piece'), ui.title, ui.viewSeg, ui.setBtn, ui.closeBtn]);

    ui.pager = make('div', { class: 'swm_pager' });
    ui.cols = make('div', { class: 'swm_cols' });

    ui.trayCount = make('span', { class: 'swm_tray_count', text: '합친 글' });
    ui.clearBtn = make('div', { class: 'swm_btn', tabindex: '0' }, [icon('fa-eraser'), make('span', { text: '비우기' })]);
    ui.editBtn = make('div', { class: 'swm_btn', tabindex: '0' }, [icon('fa-pen'), make('span', { text: '고치기' })]);
    ui.saveBtn = make('div', { class: 'swm_btn swm_primary', tabindex: '0' }, [icon('fa-check'), make('span', { text: '새 스와이프로 저장' })]);
    ui.trayNote = make('div', { class: 'swm_tray_note swm_hidden' });
    ui.trayList = make('div', { class: 'swm_tray_list' });
    ui.tray = make('div', { class: 'swm_tray' }, [
        make('div', { class: 'swm_tray_head' }, [ui.trayCount, ui.clearBtn, ui.editBtn, ui.saveBtn]),
        ui.trayNote,
        ui.trayList,
    ]);

    // edit sheet: lives inside the panel, which has a real size, so it can simply fill it
    ui.editList = make('div', { class: 'swm_edit_list' });
    ui.editNote = make('input', { class: 'swm_edit_note', type: 'text', placeholder: '부탁할 말 (한글로 써도 돼요)' });
    ui.toSourceBtn = make('div', { class: 'swm_btn swm_hidden', tabindex: '0', title: '한글로 쓴 줄만 이야기 원문의 언어와 말투로 바꿔요. 나머지 줄은 그대로예요.' }, [icon('fa-language'), make('span', { text: '한글 줄만 원문 언어로' })]);
    ui.smoothBtn = make('div', { class: 'swm_btn', tabindex: '0', title: '붙인 자리에서 앞뒤가 안 맞는 문장만 최소한으로 고쳐요. 부탁할 말을 쓰면 그 내용은 필요한 문단 전부에 반영해요.' }, [icon('fa-wand-magic-sparkles'), make('span', { text: '이음새 다듬기' })]);
    ui.undoBtn = make('div', { class: 'swm_btn swm_hidden', tabindex: '0' }, [icon('fa-rotate-left'), make('span', { text: '되돌리기' })]);
    ui.resetBtn = make('div', { class: 'swm_btn', tabindex: '0', title: '고친 내용을 버리고 고른 문단 그대로 되돌려요.' }, [icon('fa-arrow-rotate-left'), make('span', { text: '고른 대로' })]);
    ui.editDone = make('div', { class: 'swm_btn swm_primary', tabindex: '0' }, [icon('fa-check'), make('span', { text: '완료' })]);
    ui.editInfo = make('div', { class: 'swm_edit_info' });
    ui.profileName = make('span', { class: 'swm_profile_name' });
    ui.editSheet = make('div', { class: 'swm_sheet swm_hidden' }, [
        make('div', { class: 'swm_head' }, [icon('fa-pen'), make('div', { class: 'swm_title', text: '합친 글 고치기' }), ui.editDone]),
        ui.editList,
        ui.editInfo,
        make('div', { class: 'swm_ai' }, [
            make('div', { class: 'swm_ai_row' }, [make('span', { class: 'swm_ai_label', text: 'AI로 고치기' }), ui.profileName]),
            ui.editNote,
            make('div', { class: 'swm_ai_row swm_ai_btns' }, [ui.smoothBtn, ui.toSourceBtn, ui.undoBtn, ui.resetBtn]),
        ]),
    ]);

    buildSettingsSheet();
    // small menu for picking a run of paragraphs at once (long press on a paragraph)
    ui.rangeTitle = make('div', { class: 'swm_range_title' });
    ui.rangeBtns = make('div', { class: 'swm_range_btns' });
    ui.rangeMenu = make('div', { class: 'swm_range swm_hidden' }, [make('div', { class: 'swm_range_box' }, [ui.rangeTitle, ui.rangeBtns])]);
    ui.rangeMenu.addEventListener('click', (e) => { if (e.target === ui.rangeMenu) closeRange(); });
    ui.panel.append(head, ui.pager, ui.cols, ui.tray, ui.rangeMenu, ui.editSheet, ui.setSheet);
    ui.overlay.append(ui.panel);
    document.body.append(ui.overlay);

    ui.closeBtn.addEventListener('click', closePicker);
    ui.setBtn.addEventListener('click', openSettings);
    ui.viewTr.addEventListener('click', () => setView('tr'));
    ui.viewSrc.addEventListener('click', () => setView('src'));
    ui.clearBtn.addEventListener('click', clearPicks);
    ui.editBtn.addEventListener('click', openEdit);
    ui.saveBtn.addEventListener('click', saveMerged);
    ui.editDone.addEventListener('click', closeEdit);
    ui.smoothBtn.addEventListener('click', smoothSeams);
    ui.toSourceBtn.addEventListener('click', koreanLinesToSource);
    ui.undoBtn.addEventListener('click', undoAi);
    ui.resetBtn.addEventListener('click', resetEdit);
    ui.cols.addEventListener('scroll', debounce(markPager, 80), { passive: true });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || ui.overlay.classList.contains('swm_hidden')) return;
        if (!ui.setSheet.classList.contains('swm_hidden')) closeSettings();
        else if (!ui.rangeMenu.classList.contains('swm_hidden')) closeRange();
        else if (!ui.editSheet.classList.contains('swm_hidden')) closeEdit();
        else closePicker();
    });
}

function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

function openPicker(mesId) {
    const c = ctx();
    const message = c.chat?.[mesId];
    if (!message || message.is_user || message.is_system) return;
    const swipes = readSwipes(message);
    if (swipes.length < 2) {
        toastr.info('스와이프가 2개 이상 있는 답변에서 쓸 수 있어요.', '스와이프 합치기');
        return;
    }
    state = {
        mesId,
        message,
        chatId: c.getCurrentChatId?.(),
        swipes,
        picks: [],       // [{ s, p, text? }] text = the paragraph as edited in the edit sheet
        undo: null,
        changed: new Set(),
        busy: false,
    };
    ui.title.textContent = `합치기 #${mesId}`;
    ui.viewSeg.classList.toggle('swm_hidden', !swipes.some(s => s.translated));
    drawView();
    drawColumns();
    drawTray();
    ui.editSheet.classList.add('swm_hidden');
    ui.setSheet.classList.add('swm_hidden');
    ui.rangeMenu.classList.add('swm_hidden');
    ui.overlay.classList.remove('swm_hidden');
    // start on the swipe that is on screen
    const currentCol = ui.cols.querySelector('.swm_col.swm_current');
    if (currentCol) ui.cols.scrollLeft = currentCol.offsetLeft - ui.cols.offsetLeft;
    markPager();
}

async function closePicker() {
    if (!state) return;
    if (state.busy) return;
    if (state.picks.length) {
        const ok = await ctx().Popup.show.confirm('스와이프 합치기', '고른 문단을 저장하지 않고 닫을까요?');
        if (!ok) return;
    }
    ui.overlay.classList.add('swm_hidden');
    state = null;
}

function setView(view) {
    settings().view = view;
    save();
    drawView();
    drawColumns();
    drawTray();
}

function drawView() {
    const tr = showTranslation();
    ui.viewTr.classList.toggle('swm_on', tr);
    ui.viewSrc.classList.toggle('swm_on', !tr);
}

function drawColumns() {
    ui.pager.replaceChildren();
    ui.cols.replaceChildren();
    const total = state.swipes.length;
    for (const swipe of state.swipes) {
        const chip = make('div', { class: 'swm_page', tabindex: '0', 'data-swipe': String(swipe.index), title: `스와이프 ${swipe.index + 1}` }, [
            make('span', { text: String(swipe.index + 1) }),
            make('span', { class: 'swm_page_count swm_hidden' }),
        ]);
        chip.addEventListener('click', () => {
            const col = ui.cols.querySelector(`.swm_col[data-swipe="${swipe.index}"]`);
            if (col) ui.cols.scrollTo({ left: col.offsetLeft - ui.cols.offsetLeft, behavior: 'smooth' });
        });
        ui.pager.append(chip);

        const label = make('span', { class: 'swm_col_label', text: `스와이프 ${swipe.index + 1} / ${total}` });
        const tags = make('span', { class: 'swm_col_tags' });
        if (swipe.current) tags.append(make('span', { class: 'swm_tag swm_tag_now', text: '지금 화면' }));
        if (!swipe.translated && (swipe.unread || (showTranslation() && swipe.note))) {
            tags.append(make('span', { class: 'swm_tag', text: swipe.note, title: '이 스와이프는 원문으로 보여요.' }));
        }
        const all = make('div', { class: 'swm_btn swm_small', tabindex: '0', title: '이 스와이프의 문단을 전부 담기' }, [icon('fa-angles-down'), make('span', { text: '전부' })]);
        all.addEventListener('click', () => {
            for (let p = 0; p < swipe.paras.length; p++) {
                if (!state.picks.some(x => x.s === swipe.index && x.p === p)) addPick(swipe.index, p, true);
            }
            afterPicksChanged();
        });
        const body = make('div', { class: 'swm_col_body' });
        swipe.paras.forEach((para, p) => {
            const node = make('div', { class: 'swm_para', tabindex: '0', 'data-swipe': String(swipe.index), 'data-para': String(p) }, [
                make('span', { class: 'swm_para_no' }),
                make('span', { class: 'swm_para_text', text: shownText(para) }),
            ]);
            bindLongPress(node, () => openRange(swipe.index, p));
            node.addEventListener('click', () => togglePick(swipe.index, p));
            body.append(node);
        });
        if (!swipe.paras.length) body.append(make('div', { class: 'swm_empty', text: '빈 스와이프예요.' }));
        ui.cols.append(make('div', { class: 'swm_col' + (swipe.current ? ' swm_current' : ''), 'data-swipe': String(swipe.index) }, [
            make('div', { class: 'swm_col_head' }, [label, tags, all]),
            body,
        ]));
    }
    markPicks();
}

/** Order badges on the picked paragraphs and counts on the pager. */
function markPicks() {
    ui.cols.querySelectorAll('.swm_para').forEach((node) => {
        const s = Number(node.getAttribute('data-swipe'));
        const p = Number(node.getAttribute('data-para'));
        const at = state.picks.findIndex(x => x.s === s && x.p === p);
        node.classList.toggle('swm_picked', at !== -1);
        node.querySelector('.swm_para_no').textContent = at !== -1 ? String(at + 1) : '';
    });
    ui.pager.querySelectorAll('.swm_page').forEach((chip) => {
        const s = Number(chip.getAttribute('data-swipe'));
        const n = state.picks.filter(x => x.s === s).length;
        const badge = chip.querySelector('.swm_page_count');
        badge.textContent = String(n);
        badge.classList.toggle('swm_hidden', n === 0);
    });
}

/** Highlights the pager chip of the column that is in view. */
function markPager() {
    if (!state) return;
    const left = ui.cols.scrollLeft + ui.cols.clientWidth / 2;
    let best = null;
    ui.cols.querySelectorAll('.swm_col').forEach((col) => {
        const start = col.offsetLeft - ui.cols.offsetLeft;
        if (left >= start && left < start + col.offsetWidth) best = col.getAttribute('data-swipe');
    });
    ui.pager.querySelectorAll('.swm_page').forEach(chip => chip.classList.toggle('swm_on', chip.getAttribute('data-swipe') === best));
}

/**
 * Long press (or right-click) runs onLong and swallows the click that follows it.
 * A finger that moves is scrolling, not pressing, so it cancels the press.
 */
function bindLongPress(node, onLong) {
    let timer = null;
    let start = null;
    let fired = false;
    const cancel = () => {
        clearTimeout(timer);
        timer = null;
    };
    node.addEventListener('pointerdown', (e) => {
        fired = false;
        cancel();
        start = { x: e.clientX, y: e.clientY };
        timer = setTimeout(() => {
            timer = null;
            fired = true;
            if (navigator.vibrate) navigator.vibrate(15);
            onLong();
        }, 450);
    });
    node.addEventListener('pointermove', (e) => {
        if (timer && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 12) cancel();
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) node.addEventListener(type, cancel);
    node.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!fired) {
            fired = true;
            cancel();
            onLong();
        }
    });
    node.addEventListener('click', (e) => {
        if (!fired) return;
        fired = false;
        e.stopImmediatePropagation();
    }, true);
}

/** Menu for one paragraph: pick everything from it to the end of its swipe, or from the start up to it. */
function openRange(s, p) {
    if (!state || state.busy) return;
    const last = state.swipes[s].paras.length - 1;
    const fresh = (from, to) => {
        let n = 0;
        for (let i = from; i <= to; i++) if (!state.picks.some(x => x.s === s && x.p === i)) n++;
        return n;
    };
    const option = (label, from, to) => {
        const n = fresh(from, to);
        const btn = make('div', { class: 'swm_btn' + (n ? '' : ' swm_dim'), tabindex: '0' }, [make('span', { text: `${label} (${n}문단)` })]);
        btn.addEventListener('click', () => {
            for (let i = from; i <= to; i++) {
                if (!state.picks.some(x => x.s === s && x.p === i)) addPick(s, i, true);
            }
            closeRange();
            afterPicksChanged();
        });
        return btn;
    };
    const cancel = make('div', { class: 'swm_btn', tabindex: '0' }, [make('span', { text: '취소' })]);
    cancel.addEventListener('click', closeRange);
    ui.rangeTitle.textContent = `스와이프 ${s + 1} · ${p + 1}번째 문단`;
    ui.rangeBtns.replaceChildren(option('여기부터 끝까지 담기', p, last), option('처음부터 여기까지 담기', 0, p), cancel);
    ui.rangeMenu.classList.remove('swm_hidden');
}

function closeRange() {
    ui.rangeMenu.classList.add('swm_hidden');
}

function addPick(s, p, quiet = false) {
    state.picks.push({ s, p });
    if (!quiet) afterPicksChanged();
}

async function togglePick(s, p) {
    if (state.busy) return;
    const at = state.picks.findIndex(x => x.s === s && x.p === p);
    if (at === -1) {
        addPick(s, p);
        return;
    }
    if (state.picks[at].text !== undefined) {
        const ok = await ctx().Popup.show.confirm('스와이프 합치기', '직접 고친 문단이에요. 빼면 고친 내용도 사라져요. 뺄까요?');
        if (!ok) return;
    }
    state.picks.splice(at, 1);
    afterPicksChanged();
}

async function clearPicks() {
    if (!state.picks.length) return;
    const ok = await ctx().Popup.show.confirm('스와이프 합치기', hasEdits() ? '담은 문단을 전부 비울까요? 고친 내용도 사라져요.' : '담은 문단을 전부 비울까요?');
    if (!ok) return;
    state.picks = [];
    state.undo = null;
    afterPicksChanged();
}

/** Edits travel with their paragraph, so moving one keeps them. */
function movePick(at, by) {
    const to = at + by;
    if (to < 0 || to >= state.picks.length) return;
    [state.picks[at], state.picks[to]] = [state.picks[to], state.picks[at]];
    afterPicksChanged();
}

function afterPicksChanged() {
    markPicks();
    drawTray();
}

function drawTray() {
    const n = state.picks.length;
    ui.trayCount.textContent = n ? `합친 글 · ${n}문단` : '합친 글';
    for (const btn of [ui.clearBtn, ui.editBtn, ui.saveBtn]) btn.classList.toggle('swm_dim', !n);
    const edits = state.picks.filter(pick => pick.text !== undefined).length;
    ui.trayNote.classList.toggle('swm_hidden', !edits);
    ui.trayNote.textContent = edits ? `고친 문단이 ${edits}개 있어요. 고친 대로 저장돼요.` : '';
    ui.trayList.replaceChildren();
    if (!n) {
        ui.trayList.append(make('div', { class: 'swm_empty', text: '위에서 문단을 탭하면 순서대로 여기에 담겨요. 길게 누르면 그 문단부터 끝까지 한 번에 담을 수 있어요.' }));
        return;
    }
    state.picks.forEach((pick, at) => {
        const para = paraOf(pick);
        const seam = at > 0 && state.picks[at - 1].s !== pick.s;
        const up = make('div', { class: 'swm_iconbtn swm_small' + (at === 0 ? ' swm_dim' : ''), title: '위로', tabindex: '0' }, [icon('fa-chevron-up')]);
        const down = make('div', { class: 'swm_iconbtn swm_small' + (at === n - 1 ? ' swm_dim' : ''), title: '아래로', tabindex: '0' }, [icon('fa-chevron-down')]);
        const del = make('div', { class: 'swm_iconbtn swm_small', title: '빼기', tabindex: '0' }, [icon('fa-xmark')]);
        up.addEventListener('click', () => movePick(at, -1));
        down.addEventListener('click', () => movePick(at, 1));
        del.addEventListener('click', () => togglePick(pick.s, pick.p));
        const edited = pick.text !== undefined;
        ui.trayList.append(make('div', { class: 'swm_tray_row' + (seam ? ' swm_seam' : '') + (edited ? ' swm_edited' : '') }, [
            make('span', { class: 'swm_tray_from', text: `${pick.s + 1}`, title: `스와이프 ${pick.s + 1}` }),
            // an edited paragraph shows what it says now; its stored translation no longer matches
            make('span', { class: 'swm_tray_text', text: (edited ? pick.text : shownText(para)).replace(/\s+/g, ' ') }),
            up, down, del,
        ]));
    });
}

// ---------------------------------------------------------------- edit sheet
// One block per picked paragraph: its stored translation (when there is one) to read, and under it the
// original text to edit. Only the original text is saved.

function openEdit() {
    if (!state.picks.length) return;
    ui.editNote.value = '';
    ui.editInfo.textContent = '';
    state.undo = null;
    state.changed = new Set();
    showProfileName();
    ui.editSheet.classList.remove('swm_hidden');
    redrawEdit();
}

function closeEdit() {
    if (state?.busy) return;
    ui.editSheet.classList.add('swm_hidden');
    if (state) drawTray();
}

function fitHeight(area) {
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight + 2}px`;
}

function redrawEdit() {
    drawEditList();
    ui.editList.querySelectorAll('textarea').forEach(fitHeight);
    refreshEditButtons();
}

function drawEditList() {
    ui.editList.replaceChildren();
    state.picks.forEach((pick, at) => {
        const para = paraOf(pick);
        const seam = at > 0 && state.picks[at - 1].s !== pick.s;
        const area = make('textarea', { class: 'swm_edit_area', rows: '2', spellcheck: 'false' });
        area.value = pickText(pick);
        const mark = make('span', { class: 'swm_edit_mark' });
        const refLabel = make('span', { class: 'swm_edit_ref_label' });
        const ref = para.tr ? make('div', { class: 'swm_edit_ref' }, [refLabel, make('span', { text: para.tr })]) : null;
        const block = make('div', { class: 'swm_edit_block' + (seam ? ' swm_seam' : '') }, [
            make('div', { class: 'swm_edit_from' }, [
                make('span', { class: 'swm_tray_from', text: String(pick.s + 1), title: `스와이프 ${pick.s + 1}` }),
                make('span', { text: seam ? `${at + 1}번째 문단 · 여기서 스와이프가 바뀌어요` : `${at + 1}번째 문단` }),
                mark,
            ]),
            ...(ref ? [ref] : []),
            area,
        ]);
        const refresh = () => {
            const edited = pick.text !== undefined;
            const byAi = state.changed.has(pick);
            block.classList.toggle('swm_edited', edited);
            block.classList.toggle('swm_ai', byAi);
            mark.textContent = byAi ? 'AI가 고침' : edited ? '고침' : '';
            // the stored translation belongs to the text as it was before the edit
            refLabel.textContent = edited ? '고치기 전 번역 · ' : '';
        };
        area.addEventListener('input', () => {
            if (area.value === para.src) delete pick.text;
            else pick.text = area.value;
            state.changed.delete(pick);
            fitHeight(area);
            refresh();
            refreshEditButtons();
        });
        refresh();
        ui.editList.append(block);
    });
}

function refreshEditButtons() {
    const lines = state.picks.flatMap(pick => pickText(pick).split('\n')).filter(l => l.trim());
    const korean = lines.filter(hasHangul).length;
    // only for a story that is not written in Korean: a few Korean lines among lines in another language
    ui.toSourceBtn.classList.toggle('swm_hidden', !(korean > 0 && korean < lines.length / 2));
    ui.undoBtn.classList.toggle('swm_hidden', state.undo === null);
    ui.resetBtn.classList.toggle('swm_dim', !hasEdits());
}

/** The edits of every picked paragraph, in order (undefined = not edited). */
function snapshotEdits() {
    return state.picks.map(pick => pick.text);
}

function restoreEdits(snap) {
    state.picks.forEach((pick, i) => {
        if (snap[i] === undefined) delete pick.text;
        else pick.text = snap[i];
    });
}

function setPickText(pick, text) {
    if (text === paraOf(pick).src) delete pick.text;
    else pick.text = text;
}

function resetEdit() {
    if (state.busy || !hasEdits()) return;
    state.undo = snapshotEdits();
    state.picks.forEach((pick) => { delete pick.text; });
    state.changed.clear();
    redrawEdit();
    ui.editInfo.textContent = '고른 문단 그대로 되돌렸어요.';
}

function undoAi() {
    if (state.busy || state.undo === null) return;
    restoreEdits(state.undo);
    state.undo = null;
    state.changed.clear();
    redrawEdit();
    ui.editInfo.textContent = '되돌렸어요.';
}

/** The chosen connection profile, or null when the helpers go through the connection in use. */
function chosenProfile() {
    const id = settings().profileId;
    if (!id || id === CURRENT) return null;
    let profiles = [];
    try { profiles = ctx().ConnectionManagerRequestService?.getSupportedProfiles?.() ?? []; } catch { profiles = []; }
    // { missing: true } = a profile was chosen but is not there any more
    return profiles.find(p => p.id === id) ?? { id, missing: true };
}

/** The edit sheet only names what is in use; it is chosen in the settings. */
function showProfileName() {
    const profile = chosenProfile();
    ui.profileName.textContent = !profile
        ? '연결: 현재 연결'
        : profile.missing ? '고른 연결 프로필이 없어졌어요. 설정에서 다시 골라 주세요.' : `연결: ${profile.name}`;
    ui.profileName.classList.toggle('swm_warn', !!profile?.missing);
}

/** Fills the dropdown in the settings: the connection in use first, then the connection profiles. */
function fillProfiles(select) {
    let profiles = [];
    try { profiles = ctx().ConnectionManagerRequestService?.getSupportedProfiles?.() ?? []; } catch { profiles = []; }
    select.replaceChildren(make('option', { value: CURRENT, text: '현재 연결 (지금 쓰는 모델)' }));
    for (const p of profiles) {
        const option = make('option', { value: p.id, text: p.name });
        if (settings().profileId === p.id) option.selected = true;
        select.append(option);
    }
}

// ---------------------------------------------------------------- settings (a sheet inside the picker)

/** Which of the two buttons show is set by classes on <body>, so switching costs nothing per message. */
function applyButtonSettings() {
    const s = settings();
    document.body.classList.toggle('swm_no_menu', !s.menuButton);
    document.body.classList.toggle('swm_no_near', !s.nearButton);
}

function buildSettingsSheet() {
    const check = (key, label, other) => {
        const box = make('input', { type: 'checkbox' });
        box.addEventListener('change', () => {
            // one way in always stays
            if (!box.checked && !settings()[other]) {
                box.checked = true;
                toastr.info('버튼을 둘 다 끄면 열 방법이 없어서 하나는 켜 둬야 해요.', '스와이프 합치기');
                return;
            }
            settings()[key] = box.checked;
            save();
            applyButtonSettings();
        });
        ui.setChecks[key] = box;
        return make('label', { class: 'swm_set_check' }, [box, make('span', { text: label })]);
    };
    ui.setChecks = {};
    ui.setProfile = make('select', { class: 'swm_set_profile' });
    ui.setProfile.addEventListener('change', () => {
        settings().profileId = ui.setProfile.value;
        save();
        showProfileName();
    });
    ui.setDone = make('div', { class: 'swm_btn swm_primary', tabindex: '0' }, [icon('fa-check'), make('span', { text: '완료' })]);
    ui.setDone.addEventListener('click', closeSettings);
    ui.setSheet = make('div', { class: 'swm_sheet swm_hidden' }, [
        make('div', { class: 'swm_head' }, [icon('fa-gear'), make('div', { class: 'swm_title', text: '스와이프 합치기 설정' }), ui.setDone]),
        make('div', { class: 'swm_set_body' }, [
            make('div', { class: 'swm_set_title', text: '퍼즐 버튼 위치' }),
            check('menuButton', '메시지 메뉴(…) 안에 보이기', 'nearButton'),
            check('nearButton', '맨 아래 답변의 스와이프 번호 옆에 보이기 (스와이프가 2개 이상일 때)', 'menuButton'),
            make('div', { class: 'swm_set_title', text: 'AI로 고치기에 쓸 연결' }),
            ui.setProfile,
            make('div', { class: 'swm_set_note', text: '"이음새 다듬기"와 "한글 줄만 원문 언어로"를 누를 때만 요청을 보내요. 현재 연결은 지금 채팅에 쓰는 모델 그대로예요. 싼 모델로 돌리고 싶으면 연결 프로필을 골라요.' }),
            make('div', { class: 'swm_set_note', text: '이 설정 창은 /swipemix 명령으로도 열 수 있어요.' }),
        ]),
    ]);
}

/** Opens the settings sheet. Without a picker open (slash command) the window shows the sheet alone. */
function openSettings() {
    if (state?.busy) return;
    const s = settings();
    for (const [key, box] of Object.entries(ui.setChecks)) box.checked = !!s[key];
    fillProfiles(ui.setProfile);
    ui.setSheet.classList.remove('swm_hidden');
    ui.overlay.classList.remove('swm_hidden');
}

function closeSettings() {
    ui.setSheet.classList.add('swm_hidden');
    if (!state) ui.overlay.classList.add('swm_hidden');
}

function registerCommand() {
    const { SlashCommandParser, SlashCommand } = ctx();
    if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'swipemix',
        callback: () => {
            openSettings();
            return '';
        },
        returns: 'nothing',
        helpString: '<div>Swipe Mix(스와이프 합치기) 설정 창을 열어요.</div>',
    }));
}

function setBusy(on, btn) {
    state.busy = on;
    ui.editSheet.classList.toggle('swm_busy', on);
    btn?.classList.toggle('swm_working', on);
    ui.editList.querySelectorAll('textarea').forEach((area) => { area.readOnly = on; });
}

/** Sends one request through the connection in use or the chosen connection profile; returns the reply text. */
async function askModel(system, user, sourceLength) {
    const c = ctx();
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    const maxTokens = Math.min(16000, 800 + Math.ceil(sourceLength * 1.2));
    const profile = chosenProfile();
    if (!profile) {
        if (typeof c.generateRaw !== 'function') throw new Error('NO_PROFILE');
        return String(await c.generateRaw({ prompt: messages, responseLength: maxTokens }) ?? '');
    }
    if (profile.missing || !c.ConnectionManagerRequestService) throw new Error('NO_PROFILE');
    const res = await c.ConnectionManagerRequestService.sendRequest(
        profile.id,
        messages,
        maxTokens,
        { stream: false, extractData: true, includePreset: false, includeInstruct: false },
    );
    return String(typeof res === 'string' ? res : (res?.content ?? ''));
}

/** Reads a JSON array of exactly `count` strings out of a model reply. */
function parseStringArray(raw, count) {
    const text = String(raw ?? '').replace(/```(?:json)?/gi, '').trim();
    const match = text.match(/\[[\s\S]*\]/);
    let out = null;
    try { out = JSON.parse(match ? match[0] : text); } catch { /* handled below */ }
    if (!Array.isArray(out) || out.length !== count) throw new Error('BAD_REPLY');
    return out.map(x => String(x ?? ''));
}

function aiErrorText(error) {
    if (error?.message === 'NO_PROFILE') return '이 연결로는 보낼 수 없어요. 설정(창 위쪽 톱니바퀴)에서 연결을 다시 골라 주세요.';
    if (error?.message === 'BAD_REPLY') return '답을 읽지 못했어요. 글은 그대로예요. 다시 시도해 주세요.';
    return `고치지 못했어요. 글은 그대로예요.${error?.message ? ` (${String(error.message).slice(0, 120)})` : ''}`;
}

/** Fixes only what does not fit at the joins between paragraphs taken from different swipes. */
async function smoothSeams() {
    if (state.busy) return;
    const paragraphs = state.picks.map(pickText);
    if (paragraphs.length < 2) {
        ui.editInfo.textContent = '문단이 2개 이상일 때 쓸 수 있어요.';
        return;
    }
    const before = snapshotEdits();
    const seams = seamNumbers();
    const note = ui.editNote.value.trim();
    const system = 'You are a careful fiction editor. You repair continuity in a passage that was assembled from paragraphs of several alternative drafts of the same scene.';
    // With a request from the user, the request is carried out wherever it applies; without one, only the joins are touched.
    const user = `The paragraphs in the JSON array below were taken from different drafts of the same scene and joined in this order.
Task: make them read as one continuous passage${note ? ", and carry out the user's request given below" : ''}.
Rules:
- Change as little as possible.
${note ? "- The user's request comes first: apply it in every paragraph where it is needed, including paragraphs far from a join. Change only what the request needs.\n" : ''}- ${note ? 'Apart from the request, edit' : 'Edit'} only sentences next to a join, and only where they contradict or repeat what the earlier paragraphs established (positions, actions, who is present, objects, time, tense, pronouns), or where the transition is abrupt.
- Keep every other sentence exactly as written, character for character.
- Keep the original language, narrative voice, tense, formatting, markdown, quotation style, and macros such as {{user}} and {{char}}.
- Do not add new events, do not summarize, and do not merge, split, drop or reorder paragraphs.
- ${seams.length ? `Joins: paragraph number(s) ${seams.join(', ')} (counting from 1) each start a part taken from a different draft than the paragraph before.` : 'All paragraphs come from the same draft, so there may be nothing to fix apart from what the user asks for.'}
- Reply with a JSON array of strings only: exactly ${paragraphs.length} items, one per paragraph, in the same order.
${note ? `\nUser's request (it may be written in Korean; follow it, but write the story text in the story's own language):\n${note}\n` : ''}
${JSON.stringify(paragraphs)}`;
    setBusy(true, ui.smoothBtn);
    ui.editInfo.textContent = '이음새를 다듬는 중…';
    try {
        const out = parseStringArray(await askModel(system, user, paragraphs.join('').length), paragraphs.length);
        const changed = out.map((text, i) => (text.trim() !== paragraphs[i].trim() ? i : -1)).filter(i => i >= 0);
        if (!changed.length) {
            ui.editInfo.textContent = '고칠 곳을 찾지 못했어요. 글은 그대로예요.';
        } else {
            state.undo = before;
            for (const i of changed) {
                setPickText(state.picks[i], out[i].trim());
                state.changed.add(state.picks[i]);
            }
            redrawEdit();
            ui.editInfo.textContent = `${changed.map(i => i + 1).join(', ')}번째 문단을 고쳤어요. 마음에 안 들면 되돌리기를 눌러요.`;
        }
    } catch (error) {
        console.warn('[SwipeMix] Seam fix failed', error);
        ui.editInfo.textContent = aiErrorText(error);
    }
    setBusy(false, ui.smoothBtn);
    refreshEditButtons();
}

/** Rewrites only the lines typed in Korean into the language and voice of the rest of the text. */
async function koreanLinesToSource() {
    if (state.busy) return;
    const blocks = state.picks.map(pick => pickText(pick).split('\n'));
    const spots = [];
    blocks.forEach((lines, b) => lines.forEach((line, l) => { if (hasHangul(line)) spots.push([b, l]); }));
    if (!spots.length) return;
    const before = snapshotEdits();
    const context = blocks.flat().filter(l => l.trim() && !hasHangul(l)).join('\n').slice(0, 6000);
    const system = 'You are a translator for roleplay and fiction. You translate faithfully and naturally, matching the voice of the surrounding text.';
    const user = `Each item of the JSON array below is a line written in Korean that belongs inside the story text shown under "Story text".
Rewrite each item in the language of the story text, matching its narrative voice, person, tense and quotation style.
Rules:
- Keep macros such as {{user}} and {{char}}, names, markdown and punctuation style.
- Do not add, drop, explain or merge anything.
- Reply with a JSON array of strings only: exactly ${spots.length} item(s), in the same order.

Story text (for reference only, do not repeat it):
${context}

Lines to rewrite:
${JSON.stringify(spots.map(([b, l]) => blocks[b][l]))}`;
    setBusy(true, ui.toSourceBtn);
    ui.editInfo.textContent = '한글 줄을 바꾸는 중…';
    try {
        const out = parseStringArray(await askModel(system, user, spots.reduce((n, [b, l]) => n + blocks[b][l].length, 0) * 3), spots.length);
        state.undo = before;
        spots.forEach(([b, l], k) => { blocks[b][l] = out[k]; });
        for (const b of new Set(spots.map(([x]) => x))) {
            setPickText(state.picks[b], blocks[b].join('\n'));
            state.changed.add(state.picks[b]);
        }
        redrawEdit();
        ui.editInfo.textContent = `한글 ${spots.length}줄을 바꿨어요. 마음에 안 들면 되돌리기를 눌러요.`;
    } catch (error) {
        console.warn('[SwipeMix] Line rewrite failed', error);
        ui.editInfo.textContent = aiErrorText(error);
    }
    setBusy(false, ui.toSourceBtn);
    refreshEditButtons();
}

// ---------------------------------------------------------------- saving

/**
 * The translation to store with the new swipe, or '' to leave translating to the translator.
 * Reused only when the text is exactly the picked paragraphs and each of them has a translation.
 */
function translationForNewSwipe() {
    if (hasEdits() || !state.picks.length) return '';
    if (hasManagedTranslation(state.message)) return '';
    const parts = state.picks.map(pick => paraOf(pick).tr);
    return parts.every(Boolean) ? parts.join('\n\n') : '';
}

async function saveMerged() {
    if (!state || state.busy) return;
    const text = finalText().trim();
    if (!text) return;
    const c = ctx();
    const { mesId, message } = state;
    if (c.getCurrentChatId?.() !== state.chatId || c.chat?.[mesId] !== message) {
        toastr.error('채팅이 바뀌어서 저장하지 못했어요. 다시 열어 주세요.', '스와이프 합치기');
        return;
    }
    if (c.streamingProcessor || (c.swipe?.state && c.swipe.state() !== 'none')) {
        toastr.warning('답변을 만드는 중이거나 스와이프가 넘어가는 중이에요. 끝난 뒤에 다시 저장해 주세요.', '스와이프 합치기');
        return;
    }
    state.busy = true;
    ui.saveBtn.classList.add('swm_working');
    try {
        const translation = translationForNewSwipe();
        if (!Array.isArray(message.swipes) || !message.swipes.length) {
            message.swipes = [message.mes];
            message.swipe_id = 0;
        }
        if (!Array.isArray(message.swipe_info)) message.swipe_info = [];
        while (message.swipe_info.length < message.swipes.length) message.swipe_info.push({});
        const extra = { api: 'manual', model: 'swipe mix', gen_id: Date.now() };
        if (translation) extra.display_text = translation;
        message.swipes.push(text);
        message.swipe_info.push({
            send_date: typeof c.humanizedDateTime === 'function' ? c.humanizedDateTime() : message.send_date,
            gen_started: null,
            gen_finished: null,
            extra,
        });
        const newId = message.swipes.length - 1;

        // show the new swipe; without the message on screen (or on an older version) it is only added
        const onScreen = !!document.querySelector(`#chat .mes[mesid="${mesId}"] .mes_text`);
        let switched = false;
        if (onScreen && typeof c.swipe?.to === 'function') {
            try {
                await c.swipe.to(null, 'right', { source: 'slash_command', repeated: false, forceMesId: mesId, forceSwipeId: newId });
                switched = Number(message.swipe_id) === newId && message.mes === text;
            } catch (error) {
                console.warn('[SwipeMix] Switching to the new swipe failed', error);
            }
        }
        if (!switched) c.swipe?.refresh?.(true);
        await c.saveChat();
        toastr.success(
            switched ? `스와이프 ${newId + 1}번으로 저장하고 그 스와이프로 넘겼어요.` : `스와이프 ${newId + 1}번으로 저장했어요. 스와이프를 넘기면 보여요.`,
            '스와이프 합치기',
        );
        ui.overlay.classList.add('swm_hidden');
        state = null;
    } catch (error) {
        console.error('[SwipeMix] Saving failed', error);
        toastr.error('저장하지 못했어요.', '스와이프 합치기');
        if (state) state.busy = false;
    }
    ui.saveBtn.classList.remove('swm_working');
}

// ---------------------------------------------------------------- message button

/** The button in the message menu; `near` makes the small one that sits by the swipe arrows. */
function makeButton(near = false) {
    return make('div', {
        class: near ? 'swm_open swm_near fa-solid fa-puzzle-piece' : 'mes_button swm_open fa-solid fa-puzzle-piece',
        title: '스와이프 합치기',
        tabindex: '0',
    });
}

// Where the small button goes: next to ST's own swipe counter, and, when another extension shows the
// swipe arrows as a row of buttons under the message instead, at the end of that row.
const NEAR_SPOTS = '.swipeRightBlock, .stqa_footer_swipe';

function addButtons(root) {
    root?.querySelectorAll?.('.extraMesButtons').forEach((box) => {
        if (!box.querySelector('.swm_open')) box.prepend(makeButton());
    });
    root?.querySelectorAll?.(NEAR_SPOTS).forEach((box) => {
        if (!box.querySelector(':scope > .swm_near')) box.append(makeButton(true));
    });
}

/**
 * The small button only shows on a reply that has something to mix (two or more swipes).
 * Also adds it to the newest message again, in case its swipe row was built after ours.
 */
function refreshNear() {
    const last = document.querySelector('#chat .mes.last_mes');
    if (!last) return;
    addButtons(document.getElementById('message_template'));
    addButtons(last);
    const message = ctx().chat?.[Number(last.getAttribute('mesid'))];
    const multi = !!message && !message.is_user && !message.is_system && Array.isArray(message.swipes) && message.swipes.length > 1;
    last.classList.toggle('swm_multi', multi);
}
const refreshNearSoon = debounce(refreshNear, 150);

function init() {
    buildOverlay();
    applyButtonSettings();
    registerCommand();
    // new messages are cloned from the template, the ones already on screen get the button directly
    addButtons(document.getElementById('message_template'));
    addButtons(document.getElementById('chat'));
    document.addEventListener('click', (e) => {
        const btn = e.target instanceof Element ? e.target.closest('.swm_open') : null;
        if (!btn) return;
        const mesId = Number(btn.closest('.mes')?.getAttribute('mesid'));
        if (!isNaN(mesId)) openPicker(mesId);
    });
    const { eventSource, event_types } = ctx();
    // a chat switch leaves nothing to save into
    eventSource.on(event_types.CHAT_CHANGED, () => {
        if (!state) return;
        ui.overlay.classList.add('swm_hidden');
        ui.setSheet.classList.add('swm_hidden');
        state = null;
    });
    for (const name of ['APP_READY', 'CHAT_CHANGED', 'MESSAGE_SWIPED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPE_DELETED', 'GENERATION_ENDED']) {
        if (event_types[name]) eventSource.on(event_types[name], refreshNearSoon);
    }
    // only the chat's own children are watched (messages added or removed), so streaming text costs nothing
    const chat = document.getElementById('chat');
    if (chat) new MutationObserver(refreshNearSoon).observe(chat, { childList: true });
    refreshNearSoon();
}

try {
    init();
} catch (error) {
    console.error('[SwipeMix] init failed', error);
}
