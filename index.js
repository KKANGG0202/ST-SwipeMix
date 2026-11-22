// Swipe Mix - pick paragraphs from several swipes of one reply and save them as a new swipe.
// The existing swipes are never changed. When a translation is stored for a swipe, the picker can
// show the translation while the saved text is always built from the original paragraphs.

const MODULE = 'swipeMix';
const DEFAULTS = Object.freeze({
    profileId: '',   // connection profile used by the two "fix" helpers
    view: 'tr',      // 'tr' = show the stored translation when there is one, 'src' = original text
    menuButton: true, // puzzle button in the message menu
    nearButton: true, // small puzzle button by the swipe arrows of the newest reply
});

/** Blank-line paragraph break. */
const PARA_SPLIT = /\r?\n[\t ]*\r?\n(?:[\t ]*\r?\n)*/;
const HANGUL = /[ㄱ-ㆎ가-힣]/;

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

function pickedText() {
    return state.picks.map(pick => paraOf(pick).src).join('\n\n');
}

/** The text that will be saved: the hand-edited one when there is one, otherwise the picked paragraphs. */
function finalText() {
    return state.edited !== null ? state.edited : pickedText();
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

    ui.title = make('div', { class: 'swm_title', text: '스와이프 합치기' });
    ui.viewTr = make('span', { class: 'swm_seg_btn', text: '번역' });
    ui.viewSrc = make('span', { class: 'swm_seg_btn', text: '원문' });
    ui.viewSeg = make('div', { class: 'swm_seg', title: '저장된 번역으로 보기 / 원문으로 보기' }, [ui.viewTr, ui.viewSrc]);
    ui.closeBtn = make('div', { class: 'swm_iconbtn', title: '닫기', tabindex: '0' }, [icon('fa-xmark')]);
    const head = make('div', { class: 'swm_head' }, [icon('fa-puzzle-piece'), ui.title, ui.viewSeg, ui.closeBtn]);

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
    ui.editText = make('textarea', { class: 'swm_edit_text', spellcheck: 'false' });
    ui.editNote = make('input', { class: 'swm_edit_note', type: 'text', placeholder: '부탁할 말 (한글로 써도 돼요). 예: 나간 사람이 다시 앉아 있지 않게' });
    ui.toSourceBtn = make('div', { class: 'swm_btn swm_hidden', tabindex: '0', title: '한글로 쓴 줄만 이야기 원문의 언어와 말투로 바꿔요. 나머지 줄은 그대로예요.' }, [icon('fa-language'), make('span', { text: '한글 줄만 원문 언어로' })]);
    ui.smoothBtn = make('div', { class: 'swm_btn', tabindex: '0', title: '붙인 자리에서 앞뒤가 안 맞는 문장만 최소한으로 고쳐요.' }, [icon('fa-wand-magic-sparkles'), make('span', { text: '이음새 다듬기' })]);
    ui.undoBtn = make('div', { class: 'swm_btn swm_hidden', tabindex: '0' }, [icon('fa-rotate-left'), make('span', { text: '되돌리기' })]);
    ui.resetBtn = make('div', { class: 'swm_btn', tabindex: '0', title: '고친 내용을 버리고 고른 문단 그대로 되돌려요.' }, [icon('fa-arrow-rotate-left'), make('span', { text: '고른 대로' })]);
    ui.editDone = make('div', { class: 'swm_btn swm_primary', tabindex: '0' }, [icon('fa-check'), make('span', { text: '완료' })]);
    ui.editInfo = make('div', { class: 'swm_edit_info' });
    ui.profileName = make('span', { class: 'swm_profile_name' });
    ui.editSheet = make('div', { class: 'swm_sheet swm_hidden' }, [
        make('div', { class: 'swm_head' }, [icon('fa-pen'), make('div', { class: 'swm_title', text: '합친 글 고치기' }), ui.editDone]),
        ui.editText,
        ui.editInfo,
        make('div', { class: 'swm_ai' }, [
            make('div', { class: 'swm_ai_row' }, [make('span', { class: 'swm_ai_label', text: 'AI로 고치기' }), ui.profileName]),
            ui.editNote,
            make('div', { class: 'swm_ai_row swm_ai_btns' }, [ui.smoothBtn, ui.toSourceBtn, ui.undoBtn, ui.resetBtn]),
        ]),
    ]);

    ui.panel.append(head, ui.pager, ui.cols, ui.tray, ui.editSheet);
    ui.overlay.append(ui.panel);
    document.body.append(ui.overlay);

    ui.closeBtn.addEventListener('click', closePicker);
    ui.viewTr.addEventListener('click', () => setView('tr'));
    ui.viewSrc.addEventListener('click', () => setView('src'));
    ui.clearBtn.addEventListener('click', clearPicks);
    ui.editBtn.addEventListener('click', openEdit);
    ui.saveBtn.addEventListener('click', saveMerged);
    ui.editDone.addEventListener('click', closeEdit);
    ui.editText.addEventListener('input', onEditInput);
    ui.smoothBtn.addEventListener('click', smoothSeams);
    ui.toSourceBtn.addEventListener('click', koreanLinesToSource);
    ui.undoBtn.addEventListener('click', undoAi);
    ui.resetBtn.addEventListener('click', resetEdit);
    ui.cols.addEventListener('scroll', debounce(markPager, 80), { passive: true });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !state) return;
        if (!ui.editSheet.classList.contains('swm_hidden')) closeEdit();
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
        picks: [],
        edited: null,
        undo: null,
        busy: false,
    };
    ui.title.textContent = `스와이프 합치기 · #${mesId}`;
    ui.viewSeg.classList.toggle('swm_hidden', !swipes.some(s => s.translated));
    drawView();
    drawColumns();
    drawTray();
    ui.editSheet.classList.add('swm_hidden');
    ui.overlay.classList.remove('swm_hidden');
    // start on the swipe that is on screen
    const currentCol = ui.cols.querySelector('.swm_col.swm_current');
    if (currentCol) ui.cols.scrollLeft = currentCol.offsetLeft - ui.cols.offsetLeft;
    markPager();
}

async function closePicker() {
    if (!state) return;
    if (state.busy) return;
    if (state.picks.length || state.edited !== null) {
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

function addPick(s, p, quiet = false) {
    state.picks.push({ s, p });
    // a hand-edited text keeps its edits: the new paragraph is added to its end
    if (state.edited !== null) {
        const add = paraOf({ s, p }).src;
        state.edited = state.edited.trim() ? `${state.edited.replace(/\s+$/, '')}\n\n${add}` : add;
    }
    if (!quiet) afterPicksChanged();
}

async function togglePick(s, p) {
    if (state.busy) return;
    const at = state.picks.findIndex(x => x.s === s && x.p === p);
    if (at === -1) {
        addPick(s, p);
        return;
    }
    if (!(await dropEditsIfAny())) return;
    state.picks.splice(at, 1);
    afterPicksChanged();
}

/** Removing or moving paragraphs cannot be applied to a hand-edited text, so the edits go first (after asking). */
async function dropEditsIfAny() {
    if (state.edited === null) return true;
    const ok = await ctx().Popup.show.confirm('스와이프 합치기', '직접 고친 내용이 있어요. 문단을 빼거나 순서를 바꾸면 고친 내용은 사라져요. 계속할까요?');
    if (!ok) return false;
    state.edited = null;
    state.undo = null;
    return true;
}

async function clearPicks() {
    if (!state.picks.length && state.edited === null) return;
    const ok = await ctx().Popup.show.confirm('스와이프 합치기', '담은 문단을 전부 비울까요?');
    if (!ok) return;
    state.picks = [];
    state.edited = null;
    state.undo = null;
    afterPicksChanged();
}

async function movePick(at, by) {
    const to = at + by;
    if (to < 0 || to >= state.picks.length) return;
    if (!(await dropEditsIfAny())) return;
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
    const empty = !n && state.edited === null;
    for (const btn of [ui.clearBtn, ui.editBtn, ui.saveBtn]) btn.classList.toggle('swm_dim', empty);
    ui.trayNote.classList.toggle('swm_hidden', state.edited === null);
    ui.trayNote.textContent = state.edited !== null ? '직접 고친 글로 저장돼요. 문단을 더 담으면 고친 글 끝에 붙어요.' : '';
    ui.trayList.replaceChildren();
    if (!n) {
        ui.trayList.append(make('div', { class: 'swm_empty', text: '위에서 문단을 탭하면 순서대로 여기에 담겨요.' }));
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
        ui.trayList.append(make('div', { class: 'swm_tray_row' + (seam ? ' swm_seam' : '') }, [
            make('span', { class: 'swm_tray_from', text: `${pick.s + 1}`, title: `스와이프 ${pick.s + 1}` }),
            make('span', { class: 'swm_tray_text', text: shownText(para).replace(/\s+/g, ' ') }),
            up, down, del,
        ]));
    });
}

// ---------------------------------------------------------------- edit sheet

function openEdit() {
    if (!state.picks.length && state.edited === null) return;
    ui.editText.value = finalText();
    ui.editNote.value = '';
    ui.editInfo.textContent = '';
    showProfileName();
    refreshEditButtons();
    ui.editSheet.classList.remove('swm_hidden');
}

function closeEdit() {
    if (state?.busy) return;
    ui.editSheet.classList.add('swm_hidden');
    if (state) drawTray();
}

function onEditInput() {
    const value = ui.editText.value;
    state.edited = value === pickedText() ? null : value;
    refreshEditButtons();
}

function refreshEditButtons() {
    const lines = ui.editText.value.split('\n').filter(l => l.trim());
    const korean = lines.filter(hasHangul).length;
    // only for a story that is not written in Korean: a few Korean lines among lines in another language
    ui.toSourceBtn.classList.toggle('swm_hidden', !(korean > 0 && korean < lines.length / 2));
    ui.undoBtn.classList.toggle('swm_hidden', state.undo === null);
    ui.resetBtn.classList.toggle('swm_dim', state.edited === null);
}

function resetEdit() {
    if (state.busy || state.edited === null) return;
    state.undo = ui.editText.value;
    ui.editText.value = pickedText();
    state.edited = null;
    ui.editInfo.textContent = '고른 문단 그대로 되돌렸어요.';
    refreshEditButtons();
}

function undoAi() {
    if (state.busy || state.undo === null) return;
    ui.editText.value = state.undo;
    state.undo = null;
    onEditInput();
    ui.editInfo.textContent = '되돌렸어요.';
}

/** The edit sheet only names the profile in use; it is chosen in the extension's settings. */
function showProfileName() {
    let name = '';
    try { name = ctx().ConnectionManagerRequestService?.getSupportedProfiles?.().find(p => p.id === settings().profileId)?.name ?? ''; } catch { name = ''; }
    ui.profileName.textContent = name ? `연결 프로필: ${name}` : '확장 설정의 Swipe Mix에서 연결 프로필을 먼저 골라 주세요.';
    ui.profileName.classList.toggle('swm_warn', !name);
}

/** Fills the profile dropdown in the settings with the current profiles. */
function fillProfiles(select) {
    let profiles = [];
    try { profiles = ctx().ConnectionManagerRequestService?.getSupportedProfiles?.() ?? []; } catch { profiles = []; }
    select.replaceChildren(make('option', { value: '', text: '연결 프로필 고르기 (싼 모델 추천)' }));
    for (const p of profiles) {
        const option = make('option', { value: p.id, text: p.name });
        if (settings().profileId === p.id) option.selected = true;
        select.append(option);
    }
}

// ---------------------------------------------------------------- settings (Extensions panel)

/** Which of the two buttons show is set by classes on <body>, so switching costs nothing per message. */
function applyButtonSettings() {
    const s = settings();
    document.body.classList.toggle('swm_no_menu', !s.menuButton);
    document.body.classList.toggle('swm_no_near', !s.nearButton);
}

function buildSettings() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || document.getElementById('swm_settings')) return;
    const s = settings();
    const check = (key, label, other) => {
        const box = make('input', { type: 'checkbox' });
        box.checked = !!s[key];
        box.addEventListener('change', () => {
            // one way in always stays
            if (!box.checked && !settings()[other]) {
                box.checked = true;
                toastr.info('버튼을 둘 다 끄면 열 방법이 없어서 하나는 켜 둬야 해요.', 'Swipe Mix');
                return;
            }
            settings()[key] = box.checked;
            save();
            applyButtonSettings();
        });
        return make('label', { class: 'checkbox_label' }, [box, make('span', { text: label })]);
    };
    const profile = make('select', { class: 'text_pole', id: 'swm_set_profile' });
    fillProfiles(profile);
    // profiles can be added or renamed at any time: read them again when the list is about to open
    for (const type of ['pointerdown', 'focus']) profile.addEventListener(type, () => fillProfiles(profile));
    profile.addEventListener('change', () => {
        settings().profileId = profile.value;
        save();
    });
    const content = make('div', { class: 'inline-drawer-content' }, [
        make('b', { text: '퍼즐 버튼 위치' }),
        check('menuButton', '메시지 메뉴(…) 안에 보이기', 'nearButton'),
        check('nearButton', '맨 아래 답변의 스와이프 번호 옆에 보이기 (스와이프가 2개 이상일 때)', 'menuButton'),
        make('label', { for: 'swm_set_profile', text: 'AI로 고치기에 쓸 연결 프로필' }),
        profile,
        make('small', { text: '"이음새 다듬기"와 "한글 줄만 원문 언어로"를 누를 때만 이 프로필로 요청을 보내요.' }),
    ]);
    host.append(make('div', { id: 'swm_settings' }, [
        make('div', { class: 'inline-drawer' }, [
            make('div', { class: 'inline-drawer-toggle inline-drawer-header' }, [
                make('b', { text: 'Swipe Mix (스와이프 합치기)' }),
                make('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' }),
            ]),
            content,
        ]),
    ]));
}

function setBusy(on, btn) {
    state.busy = on;
    ui.editSheet.classList.toggle('swm_busy', on);
    btn?.classList.toggle('swm_working', on);
    ui.editText.readOnly = on;
}

/** Sends one request through the chosen connection profile and returns the reply text. */
async function askModel(system, user, sourceLength) {
    const c = ctx();
    const profileId = settings().profileId;
    if (!profileId || !c.ConnectionManagerRequestService) throw new Error('NO_PROFILE');
    const maxTokens = Math.min(16000, 800 + Math.ceil(sourceLength * 1.2));
    const res = await c.ConnectionManagerRequestService.sendRequest(
        profileId,
        [{ role: 'system', content: system }, { role: 'user', content: user }],
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
    if (error?.message === 'NO_PROFILE') return 'AI로 고치려면 확장 설정의 Swipe Mix에서 연결 프로필을 먼저 골라 주세요.';
    if (error?.message === 'BAD_REPLY') return '답을 읽지 못했어요. 글은 그대로예요. 다시 시도해 주세요.';
    return `고치지 못했어요. 글은 그대로예요.${error?.message ? ` (${String(error.message).slice(0, 120)})` : ''}`;
}

/** Fixes only what does not fit at the joins between paragraphs taken from different swipes. */
async function smoothSeams() {
    if (state.busy) return;
    const before = ui.editText.value;
    const paragraphs = splitParagraphs(before);
    if (paragraphs.length < 2) {
        ui.editInfo.textContent = '문단이 2개 이상일 때 쓸 수 있어요.';
        return;
    }
    // the join positions are only known while the text still has the picked paragraphs, one for one
    const seams = paragraphs.length === state.picks.length ? seamNumbers() : [];
    const note = ui.editNote.value.trim();
    const system = 'You are a careful fiction editor. You repair continuity in a passage that was assembled from paragraphs of several alternative drafts of the same scene.';
    const user = `The paragraphs in the JSON array below were taken from different drafts of the same scene and joined in this order.
Task: make them read as one continuous passage.
Rules:
- Change as little as possible. Edit only sentences next to a join, and only where they contradict or repeat what the earlier paragraphs established (positions, actions, who is present, objects, time, tense, pronouns), or where the transition is abrupt.
- Keep every other sentence exactly as written, character for character.
- Keep the original language, narrative voice, tense, formatting, markdown, quotation style, and macros such as {{user}} and {{char}}.
- Do not add new events, do not summarize, and do not merge, split, drop or reorder paragraphs.
- ${seams.length ? `Joins: paragraph number(s) ${seams.join(', ')} (counting from 1) each start a part taken from a different draft than the paragraph before.` : 'The join positions are not known: check every paragraph boundary.'}
${note ? `- The user asks for this in particular (the request may be written in Korean; follow it, but write the story text in the story's own language): ${note}\n` : ''}- Reply with a JSON array of strings only: exactly ${paragraphs.length} items, one per paragraph, in the same order.

${JSON.stringify(paragraphs)}`;
    setBusy(true, ui.smoothBtn);
    ui.editInfo.textContent = '이음새를 다듬는 중…';
    try {
        const out = parseStringArray(await askModel(system, user, before.length), paragraphs.length);
        const changed = out.map((text, i) => (text.trim() !== paragraphs[i].trim() ? i + 1 : 0)).filter(Boolean);
        if (ui.editText.value !== before) throw new Error('BAD_REPLY');
        if (!changed.length) {
            ui.editInfo.textContent = '고칠 곳을 찾지 못했어요. 글은 그대로예요.';
        } else {
            state.undo = before;
            ui.editText.value = out.map(x => x.trim()).join('\n\n');
            onEditInput();
            ui.editInfo.textContent = `${changed.join(', ')}번째 문단을 고쳤어요. 마음에 안 들면 되돌리기를 눌러요.`;
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
    const before = ui.editText.value;
    const lines = before.split('\n');
    const idx = lines.map((l, i) => (hasHangul(l) ? i : -1)).filter(i => i >= 0);
    if (!idx.length) return;
    const context = lines.filter(l => l.trim() && !hasHangul(l)).join('\n').slice(0, 6000);
    const system = 'You are a translator for roleplay and fiction. You translate faithfully and naturally, matching the voice of the surrounding text.';
    const user = `Each item of the JSON array below is a line written in Korean that belongs inside the story text shown under "Story text".
Rewrite each item in the language of the story text, matching its narrative voice, person, tense and quotation style.
Rules:
- Keep macros such as {{user}} and {{char}}, names, markdown and punctuation style.
- Do not add, drop, explain or merge anything.
- Reply with a JSON array of strings only: exactly ${idx.length} item(s), in the same order.

Story text (for reference only, do not repeat it):
${context}

Lines to rewrite:
${JSON.stringify(idx.map(i => lines[i]))}`;
    setBusy(true, ui.toSourceBtn);
    ui.editInfo.textContent = '한글 줄을 바꾸는 중…';
    try {
        const out = parseStringArray(await askModel(system, user, idx.reduce((n, i) => n + lines[i].length, 0) * 3), idx.length);
        if (ui.editText.value !== before) throw new Error('BAD_REPLY');
        idx.forEach((lineNo, k) => { lines[lineNo] = out[k]; });
        state.undo = before;
        ui.editText.value = lines.join('\n');
        onEditInput();
        ui.editInfo.textContent = `한글 ${idx.length}줄을 바꿨어요. 마음에 안 들면 되돌리기를 눌러요.`;
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
    if (state.edited !== null || !state.picks.length) return '';
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
    buildSettings();
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
        state = null;
    });
    // the Extensions panel may not be there yet while extensions load
    if (event_types.APP_READY) eventSource.on(event_types.APP_READY, buildSettings);
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
