/* Spellbinder — Phase 1 front end.
   Vanilla JS + Supabase JS v2. All data access goes through the anon key and
   the signed-in user's session; Postgres RLS enforces who can see what. */
'use strict';

/* ---------------- helpers ---------------- */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const money = (n) => '$' + (Number(n) || 0).toFixed(2);
const initialsOf = (name) => {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
};
const DEFAULT_COLOR = '#8b7cf6';
const PALETTE = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e', '#14b8a6',
  '#06b6d4', '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#64748b'];
const LANG_NAMES = { en: 'EN', ja: 'JA', de: 'DE', fr: 'FR', es: 'ES', it: 'IT', pt: 'PT', ko: 'KO', ru: 'RU', zhs: 'ZH-S', zht: 'ZH-T', he: 'HE', la: 'LA', grc: 'GR', ar: 'AR', sa: 'SA', px: 'PX', qya: 'QYA', tlh: 'TLH' };

let noticeTimer = null;
function showNotice(msg, ms) {
  const el = $('#notice');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { el.hidden = true; }, ms || 4200);
}
function friendlyError(err) {
  if (!err) return 'Something went wrong.';
  return err.message || String(err);
}

/* ---------------- supabase client + state ---------------- */
const cfg = window.SPELLBINDER_CONFIG || {};
const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

const state = {
  user: null,
  profile: null,
  binders: [],            // my binders
  binderStats: {},        // binder_id -> {qty, distinct, value}
  currentBinder: null,    // binder row being viewed
  currentCards: [],       // cards in the viewed binder
  binderReadonly: false,
  binderBack: 'home',     // 'home' | 'member'
  memberProfile: null,    // member whose page is open
  memberBinders: [],
  allMembers: [],         // directory profiles (Phase 2)
  myWants: null,          // my want list rows (Phase 2)
  compose: null,          // active trade composer state (Phase 2)
  decks: [],              // my decks (Phase 4)
  currentDeck: null,      // deck row being viewed (Phase 4)
  deckCards: [],          // cards in the viewed deck (Phase 4)
  deckReadonly: false,
  live: null,              // live scanner session (Phase 7c)
  deckBack: 'decks',      // 'decks' | 'member'
  editingDeckId: null,
  editingBinderId: null,
  selectedColor: DEFAULT_COLOR,
  migrationChecked: false
};

/* ---------------- avatar rendering ---------------- */
function avatarHTML(profile, nameOverride) {
  const name = nameOverride || (profile && profile.display_name) || '?';
  const color = (profile && profile.profile_color) || DEFAULT_COLOR;
  const url = profile && profile.avatar_url;
  if (url) return '<img src="' + esc(url) + '" alt="">';
  return '<span style="background:' + esc(color) + ';width:100%;height:100%;display:grid;place-items:center;">' + esc(initialsOf(name)) + '</span>';
}
function paintAvatar(el, profile, nameOverride) {
  if (!el) return;
  el.innerHTML = avatarHTML(profile, nameOverride);
  el.style.borderColor = (profile && profile.profile_color) || DEFAULT_COLOR;
  el.style.background = (profile && profile.profile_color) || DEFAULT_COLOR;
}
function applyAccent() {
  const color = (state.profile && state.profile.profile_color) || DEFAULT_COLOR;
  document.documentElement.style.setProperty('--accent', color);
}

/* ---------------- auth ---------------- */
async function signInWithGoogle() {
  $('#auth-error').hidden = true;
  const redirectTo = window.location.origin + window.location.pathname;
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo }
  });
  if (error) {
    const e = $('#auth-error');
    e.textContent = 'Sign-in failed: ' + friendlyError(error);
    e.hidden = false;
  }
}

async function loadProfile() {
  // The signup trigger normally creates the profile row; poll briefly for it.
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data, error } = await sb.from('profiles')
      .select('*').eq('id', state.user.id).maybeSingle();
    if (error) throw error;
    if (data) { state.profile = data; return data; }
    await new Promise(r => setTimeout(r, 700));
  }
  // Fallback: create it ourselves from the Google account metadata.
  const meta = state.user.user_metadata || {};
  const fallback = {
    id: state.user.id,
    display_name: meta.full_name || meta.name || state.user.email || 'Collector',
    avatar_url: meta.avatar_url || meta.picture || null,
    profile_color: DEFAULT_COLOR,
    is_public: false
  };
  const { data, error } = await sb.from('profiles').insert(fallback).select().single();
  if (error) throw error;
  state.profile = data;
  return data;
}

/* ---------------- migration claim ---------------- */
async function claimMigration() {
  if (state.migrationChecked || !state.user.email) return;
  state.migrationChecked = true;
  try {
    const { data: rows, error } = await sb.from('migration_imports')
      .select('email, payload, claimed_at')
      .eq('email', state.user.email).is('claimed_at', null);
    if (error) throw error;
    if (!rows || !rows.length) return;
    const payload = rows[0].payload || {};
    const cards = Array.isArray(payload.cards) ? payload.cards : [];

    const { data: binder, error: bErr } = await sb.from('binders').insert({
      owner_id: state.user.id,
      name: 'Main Collection',
      description: '',
      kind: 'collection',
      is_main: true,
      is_public: false
    }).select().single();
    if (bErr) throw bErr;

    // Insert the imported cards in chunks.
    for (let i = 0; i < cards.length; i += 50) {
      const chunk = cards.slice(i, i + 50).map(c => ({
        binder_id: binder.id,
        owner_id: state.user.id,
        scryfall_id: c.scryfall_id,
        name: c.name,
        printed_name: c.printed_name || null,
        set_code: c.set_code || null,
        set_name: c.set_name || null,
        collector_number: c.collector_number || null,
        lang: c.lang || 'en',
        is_foil: !!c.is_foil,
        quantity: c.quantity || 1,
        rarity: c.rarity || null,
        type_line: c.type_line || null,
        image_uri: c.image_uri || null,
        price_usd: c.price_usd != null ? c.price_usd : null,
        price_usd_foil: c.price_usd_foil != null ? c.price_usd_foil : null,
        price_source: c.price_source || null,
        unit_price: c.unit_price != null ? c.unit_price : null,
        added_at: c.added_at || undefined
      }));
      const { error: cErr } = await sb.from('binder_cards').insert(chunk);
      if (cErr) throw cErr;
    }

    await sb.from('migration_imports')
      .update({ claimed_at: new Date().toISOString() })
      .eq('email', state.user.email);

    const total = payload.total_quantity || cards.reduce((s, c) => s + (c.quantity || 1), 0);
    const note = $('#import-note');
    note.innerHTML = '<p class="empty" style="border-color:var(--ok);color:var(--text);">' +
      '🎉 Your collection was imported — ' + esc(total) + ' cards are now in your Main Collection.</p>';
    showNotice('Your collection was imported — ' + total + ' cards', 6000);
  } catch (err) {
    console.warn('Migration claim failed:', err);
    showNotice('We found a collection import for you but could not finish it: ' + friendlyError(err), 7000);
  }
}

/* ---------------- navigation ---------------- */
function showPage(name) {
  ['home', 'binder', 'members', 'member', 'profile', 'trades', 'compose', 'spares', 'decks', 'deck', 'lookup'].forEach(p => {
    $('#page-' + p).hidden = p !== name;
  });
  $$('.tab').forEach(t => {
    const nav = t.getAttribute('data-nav');
    t.classList.toggle('active', nav === name || (name === 'binder' && nav === 'home') || (name === 'member' && nav === 'members') || (name === 'compose' && nav === 'trades') || (name === 'deck' && nav === 'decks'));
  });
  // The ⋯ More button lights up when one of its pages is showing.
  const moreBtn = $('#tab-more');
  if (moreBtn) moreBtn.classList.toggle('active', ['spares', 'members', 'profile'].includes(name));
  window.scrollTo({ top: 0 });
}

/* ---------------- binders (home) ---------------- */
async function loadMyBinders() {
  $('#home-loading').hidden = false;
  $('#home-error').hidden = true;
  try {
    const { data: binders, error } = await sb.from('binders')
      .select('*').eq('owner_id', state.user.id)
      .order('is_main', { ascending: false }).order('created_at', { ascending: true });
    if (error) throw error;
    state.binders = binders || [];

    // Aggregate card counts + values for all my binders in one query.
    const { data: cards, error: cErr } = await sb.from('binder_cards')
      .select('binder_id, quantity, unit_price, set_code, set_name').eq('owner_id', state.user.id);
    if (cErr) throw cErr;
    const stats = {};
    (cards || []).forEach(c => {
      const s = stats[c.binder_id] || (stats[c.binder_id] = { qty: 0, distinct: 0, value: 0 });
      s.qty += c.quantity || 0;
      s.distinct += 1;
      s.value += (Number(c.unit_price) || 0) * (c.quantity || 0);
    });
    state.binderStats = stats;
    renderBinderList($('#binder-list'), state.binders, stats, false);
    $('#home-empty').hidden = state.binders.length > 0;

    // Auto set binders: group the Main Collection's cards by set.
    const main = state.binders.find(b => b.is_main);
    const setStats = {};
    if (main) {
      (cards || []).filter(c => c.binder_id === main.id).forEach(c => {
        const code = String(c.set_code || '').toLowerCase();
        if (!code) return;
        const s = setStats[code] || (setStats[code] = { name: c.set_name || code.toUpperCase(), distinct: 0, qty: 0, value: 0 });
        if (c.set_name) s.name = c.set_name;
        s.distinct += 1;
        s.qty += c.quantity || 0;
        s.value += (Number(c.unit_price) || 0) * (c.quantity || 0);
      });
    }
    state.setStats = setStats;
    renderSetSections(main);
  } catch (err) {
    const e = $('#home-error');
    e.textContent = 'Could not load your binders: ' + friendlyError(err);
    e.hidden = false;
  } finally {
    $('#home-loading').hidden = true;
  }
}

function binderBadges(b) {
  let out = '';
  if (b.kind === 'showcase') out += ' <span class="badge badge-showcase">★ Showcase</span>';
  if (b.is_main) out += ' <span class="badge">Main</span>';
  if (b.virtual) return out + ' <span class="badge">Auto · Main mirror</span>';
  out += b.is_public
    ? ' <span class="badge badge-public">Public</span>'
    : ' <span class="badge">Private</span>';
  return out;
}

/* ---- auto set binders (virtual mirrors of Main Collection) ---- */
// Release families: sets that belong together get a combined binder too.
const SET_FAMILIES = [
  { name: 'Final Fantasy', sets: ['fin', 'fca', 'fic'] },
  { name: 'Star Trek', sets: ['trk', 'trc'] },
  { name: 'Reality Fracture', sets: ['fra'] },
  { name: 'The Hobbit', sets: ['hob'] }
];
// Printed set sizes (Scryfall card counts) for "x of N in set" completion.
const SET_TOTALS = { fin: 594, fca: 64, fic: 486, trk: 586, trc: 556, fra: 461, hob: 321 };

function renderSetSections(main) {
  const area = $('#set-area');
  const wrap = $('#set-sections');
  if (!area || !wrap) return;
  wrap.innerHTML = '';
  const stats = state.setStats || {};
  const codes = Object.keys(stats);
  if (!main || !codes.length) { area.hidden = true; return; }
  area.hidden = false;
  const used = new Set();
  SET_FAMILIES.forEach(fam => {
    const present = fam.sets.filter(c => stats[c]);
    if (!present.length) return;
    present.forEach(c => used.add(c));
    wrap.appendChild(familySection(fam.name, present, stats));
  });
  codes.filter(c => !used.has(c)).sort().forEach(code => {
    wrap.appendChild(familySection(stats[code].name, [code], stats));
  });
}

function familySection(title, present, stats) {
  const sec = document.createElement('div');
  const h = document.createElement('h3');
  h.className = 'family-title';
  h.textContent = title;
  sec.appendChild(h);
  const list = document.createElement('div');
  list.className = 'binder-list';
  if (present.length > 1) list.appendChild(setBinderCard(present, stats, title + ' — Combined'));
  present.forEach(code => list.appendChild(setBinderCard([code], stats, null)));
  sec.appendChild(list);
  return sec;
}

function setBinderCard(codes, stats, combinedName) {
  let distinct = 0, qty = 0, value = 0, total = 0, allKnown = true;
  codes.forEach(c => {
    const s = stats[c];
    distinct += s.distinct; qty += s.qty; value += s.value;
    if (SET_TOTALS[c]) total += SET_TOTALS[c]; else allKnown = false;
  });
  const name = combinedName || stats[codes[0]].name;
  const vb = {
    id: 'set:' + codes.join('+'), name: name, kind: 'set', virtual: true,
    setCodes: codes.slice(), is_main: false, is_public: false,
    setTotal: allKnown ? total : null
  };
  state.binderStats[vb.id] = { qty: qty, distinct: distinct, value: value };
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'binder-card';
  btn.innerHTML =
    '<h3>' + esc(name) + ' <span class="badge">Auto</span></h3>' +
    '<p class="stats">' + distinct + ' distinct · ' + qty + ' cards' +
      (allKnown ? ' · ' + distinct + ' of ' + total + ' in set' : '') + '</p>' +
    '<p class="value">' + money(value) + '</p>';
  btn.addEventListener('click', () => openBinder(vb, true));
  return btn;
}

function renderBinderList(container, binders, stats, readonly) {
  container.innerHTML = '';
  binders.forEach(b => {
    const s = (stats && stats[b.id]) || { qty: 0, distinct: 0, value: 0 };
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'binder-card';
    btn.innerHTML =
      '<h3>' + esc(b.name) + binderBadges(b) + '</h3>' +
      (b.description ? '<p class="stats">' + esc(b.description) + '</p>' : '') +
      '<p class="stats">' + s.distinct + ' distinct · ' + s.qty + ' cards</p>' +
      '<p class="value">' + money(s.value) + '</p>';
    btn.addEventListener('click', () => openBinder(b, readonly));
    container.appendChild(btn);
  });
}

/* ---- new / edit binder dialog ---- */
function openBinderDialog(binder) {
  state.editingBinderId = binder ? binder.id : null;
  $('#binder-dialog-title').textContent = binder ? 'Edit binder' : 'New binder';
  $('#binder-name').value = binder ? binder.name : '';
  $('#binder-kind').value = binder ? binder.kind : 'collection';
  $('#binder-desc').value = binder ? (binder.description || '') : '';
  $('#binder-public').checked = binder ? !!binder.is_public : false;
  $('#binder-form-error').hidden = true;
  $('#binder-dialog').showModal();
}

async function saveBinder(ev) {
  ev.preventDefault();
  const payload = {
    name: $('#binder-name').value.trim(),
    kind: $('#binder-kind').value,
    description: $('#binder-desc').value.trim(),
    is_public: $('#binder-public').checked
  };
  if (!payload.name) return;
  try {
    if (state.editingBinderId) {
      const { error } = await sb.from('binders').update(payload).eq('id', state.editingBinderId);
      if (error) throw error;
      if (state.currentBinder && state.currentBinder.id === state.editingBinderId) {
        Object.assign(state.currentBinder, payload);
        paintBinderHead();
      }
      showNotice('Binder updated');
    } else {
      const { error } = await sb.from('binders')
        .insert(Object.assign({ owner_id: state.user.id }, payload));
      if (error) throw error;
      showNotice('Binder created');
    }
    $('#binder-dialog').close();
    await loadMyBinders();
  } catch (err) {
    const e = $('#binder-form-error');
    e.textContent = 'Could not save: ' + friendlyError(err);
    e.hidden = false;
  }
}

async function deleteCurrentBinder() {
  const b = state.currentBinder;
  if (!b) return;
  let msg = 'Delete binder "' + b.name + '" and all its cards? This cannot be undone.';
  if (b.is_main) msg = '"' + b.name + '" is your Main Collection. ' + msg;
  if (!window.confirm(msg)) return;
  if (b.is_main && !window.confirm('Really delete your Main Collection? All its cards will be removed.')) return;
  try {
    const { error } = await sb.from('binders').delete().eq('id', b.id);
    if (error) throw error;
    showNotice('Binder deleted');
    state.currentBinder = null;
    await loadMyBinders();
    showPage('home');
  } catch (err) {
    showNotice('Could not delete: ' + friendlyError(err), 6000);
  }
}

/* ---------------- binder view ---------------- */
function openBinder(binder, readonly) {
  state.currentBinder = binder;
  state.binderReadonly = !!readonly;
  state.binderBack = binder.virtual ? 'home' : (readonly ? 'member' : 'home');
  paintBinderHead();
  $('#binder-owner-actions').hidden = !!readonly;
  $('#add-card-box').hidden = !!readonly;
  $('#search-results').innerHTML = '';
  $('#search-status').textContent = '';
  $('#pick-panel').hidden = true;
  showPage('binder');
  loadBinderCards();
}

function paintBinderHead() {
  const b = state.currentBinder;
  if (!b) return;
  $('#binder-title').innerHTML = esc(b.name) + binderBadges(b);
  const s = state.binderStats[b.id];
  let meta = s
    ? s.distinct + ' distinct · ' + s.qty + ' cards · ' + money(s.value)
    : '';
  if (b.virtual && b.setTotal && s) meta += ' · ' + s.distinct + ' of ' + b.setTotal + ' in set';
  $('#binder-meta').textContent = meta;
}

async function loadBinderCards() {
  const b = state.currentBinder;
  if (!b) return;
  $('#binder-loading').hidden = false;
  $('#binder-error').hidden = true;
  try {
    let data, error;
    if (b.virtual) {
      // Set binders are mirrors: read the Main Collection and filter by set.
      const main = (state.binders || []).find(x => x.is_main);
      if (!main) throw new Error('No Main Collection found to mirror.');
      const res = await sb.from('binder_cards')
        .select('*').eq('binder_id', main.id)
        .order('added_at', { ascending: false });
      data = (res.data || []).filter(c =>
        b.setCodes.includes(String(c.set_code || '').toLowerCase()));
      error = res.error;
    } else {
      const res = await sb.from('binder_cards')
        .select('*').eq('binder_id', b.id)
        .order('added_at', { ascending: false });
      data = res.data;
      error = res.error;
    }
    if (error) throw error;
    state.currentCards = data || [];
    if (b.virtual) state.currentCards.sort(collectorSort);
    // Refresh this binder's stats from the loaded cards.
    const s = { qty: 0, distinct: 0, value: 0 };
    state.currentCards.forEach(c => {
      s.qty += c.quantity || 0; s.distinct += 1;
      s.value += (Number(c.unit_price) || 0) * (c.quantity || 0);
    });
    state.binderStats[b.id] = s;
    paintBinderHead();
    renderCards();
  } catch (err) {
    const e = $('#binder-error');
    e.textContent = 'Could not load cards: ' + friendlyError(err);
    e.hidden = false;
  } finally {
    $('#binder-loading').hidden = true;
  }
}

function collectorSort(a, b2) {
  const sa = String(a.set_code || ''), sb2 = String(b2.set_code || '');
  if (sa !== sb2) return sa.localeCompare(sb2);
  const na = parseInt(String(a.collector_number || '').replace(/[^0-9]/g, ''), 10);
  const nb = parseInt(String(b2.collector_number || '').replace(/[^0-9]/g, ''), 10);
  const va = isNaN(na) ? 0 : na, vb = isNaN(nb) ? 0 : nb;
  if (va !== vb) return va - vb;
  return String(a.name).localeCompare(String(b2.name));
}

function sortedCards() {
  const mode = $('#sort-select').value;
  const cards = state.currentCards.slice();
  if (mode === 'name') cards.sort((a, b2) => String(a.name).localeCompare(String(b2.name)));
  else if (mode === 'price') cards.sort((a, b2) => (Number(b2.unit_price) || 0) - (Number(a.unit_price) || 0));
  else if (state.currentBinder && state.currentBinder.virtual) return cards; // collector order
  else cards.sort((a, b2) => new Date(b2.added_at || 0) - new Date(a.added_at || 0));
  return cards;
}

function renderCards() {
  const area = $('#card-area');
  const cards = sortedCards();
  if (!cards.length) {
    area.innerHTML = '<p class="empty">No cards in this binder yet.</p>';
    return;
  }
  if ($('#group-set-toggle').checked) {
    const groups = {};
    cards.forEach(c => {
      const key = c.set_name || c.set_code || 'Other';
      (groups[key] = groups[key] || []).push(c);
    });
    area.innerHTML = '';
    Object.keys(groups).sort().forEach(setName => {
      const h = document.createElement('h3');
      h.className = 'set-group-title';
      h.textContent = setName + ' (' + groups[setName].length + ')';
      area.appendChild(h);
      area.appendChild(cardGrid(groups[setName]));
    });
  } else {
    area.innerHTML = '';
    area.appendChild(cardGrid(cards));
  }
}

function cardGrid(cards) {
  const grid = document.createElement('div');
  grid.className = 'card-grid';
  cards.forEach(c => grid.appendChild(cardTile(c)));
  return grid;
}

function cardTile(c) {
  const tile = document.createElement('div');
  tile.className = 'card-tile';
  const displayName = c.printed_name && c.lang !== 'en' ? c.printed_name : c.name;
  const langBadge = c.lang ? '<span class="tag">' + esc(LANG_NAMES[c.lang] || c.lang.toUpperCase()) + '</span>' : '';
  const finishTag = c.is_foil ? '<span class="tag tag-foil">Foil</span>' : '<span class="tag">Non-foil</span>';
  let qtyHTML;
  if (state.binderReadonly) {
    qtyHTML = '<div class="qty-row"><span class="qty-num">×' + (c.quantity || 1) + '</span></div>';
  } else {
    qtyHTML = '<div class="qty-row">' +
      '<button type="button" class="qty-btn" data-act="dec" aria-label="Remove one">−</button>' +
      '<span class="qty-num">×' + (c.quantity || 1) + '</span>' +
      '<button type="button" class="qty-btn" data-act="inc" aria-label="Add one">+</button></div>';
  }
  tile.innerHTML =
    (c.image_uri ? '<img class="card-img" loading="lazy" src="' + esc(c.image_uri) + '" alt="' + esc(c.name) + '">' : '') +
    '<div class="card-body">' +
      '<div class="card-name">' + esc(displayName) + '</div>' +
      '<div class="card-sub">' + esc(c.set_name || '') + (c.collector_number ? ' · #' + esc(c.collector_number) : '') + '</div>' +
      '<div class="card-tags">' + finishTag + langBadge + '</div>' +
      '<div class="card-price">' + money(c.unit_price) +
        (c.price_source ? ' <span class="src">' + esc(c.price_source) + '</span>' : '') + '</div>' +
      qtyHTML +
    '</div>';
  if (!state.binderReadonly) {
    $$('.qty-btn', tile).forEach(btn => {
      btn.addEventListener('click', () => changeQuantity(c, btn.getAttribute('data-act') === 'inc' ? 1 : -1));
    });
  }
  return tile;
}

async function changeQuantity(card, delta) {
  const next = (card.quantity || 1) + delta;
  try {
    if (next <= 0) {
      if (!window.confirm('Remove "' + card.name + '" from this binder?')) return;
      const { error } = await sb.from('binder_cards').delete().eq('id', card.id);
      if (error) throw error;
    } else {
      const { error } = await sb.from('binder_cards').update({ quantity: next }).eq('id', card.id);
      if (error) throw error;
    }
    await loadBinderCards();
    loadMyBinders(); // keep home stats fresh (fire and forget)
  } catch (err) {
    showNotice('Could not update quantity: ' + friendlyError(err), 6000);
  }
}

/* ---------------- add card via Scryfall ---------------- */
async function searchScryfall(ev) {
  ev.preventDefault();
  const q = $('#search-input').value.trim();
  const box = $('#search-results');
  const status = $('#search-status');
  $('#pick-panel').hidden = true;
  if (!q) return;
  status.textContent = 'Searching Scryfall…';
  box.innerHTML = '';
  try {
    const url = 'https://api.scryfall.com/cards/search?unique=prints&order=name&q=' +
      encodeURIComponent(q);
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (res.status === 404) {
      status.textContent = 'No cards matched that search.';
      return;
    }
    if (!res.ok) throw new Error('Scryfall returned ' + res.status);
    const json = await res.json();
    const results = (json.data || []).slice(0, 30);
    status.textContent = results.length
      ? 'Tap a printing to add it (' + results.length + ' shown).'
      : 'No cards matched that search.';
    results.forEach(card => box.appendChild(searchHit(card)));
  } catch (err) {
    status.textContent = 'Search failed: ' + friendlyError(err);
  }
}

function scryImage(card) {
  if (card.image_uris) return card.image_uris.normal || card.image_uris.small;
  if (card.card_faces && card.card_faces[0] && card.card_faces[0].image_uris) {
    return card.card_faces[0].image_uris.normal || card.card_faces[0].image_uris.small;
  }
  return null;
}

function searchHit(card) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'search-hit';
  const img = scryImage(card);
  btn.innerHTML =
    (img ? '<img src="' + esc(img) + '" alt="">' : '') +
    '<span><span class="hit-name">' + esc(card.name) + '</span><br>' +
    '<span class="hit-sub">' + esc(card.set_name || '') + ' · #' + esc(card.collector_number || '') +
    ' · ' + esc(card.rarity || '') + '</span></span>';
  btn.addEventListener('click', () => showPickPanel(card));
  return btn;
}

function showPickPanel(card) {
  const panel = $('#pick-panel');
  const finishes = card.finishes || ['nonfoil'];
  const canFoil = finishes.includes('foil') || finishes.includes('etched');
  const canNonfoil = finishes.includes('nonfoil');
  const defaultFoil = canFoil && !canNonfoil;
  const prices = card.prices || {};
  panel.innerHTML =
    '<div class="pick-row">' +
      '<strong>' + esc(card.name) + '</strong>' +
      '<span class="muted">' + esc(card.set_name || '') + ' #' + esc(card.collector_number || '') + '</span>' +
      '<label>Finish ' +
        '<select id="pick-finish">' +
          (canNonfoil ? '<option value="nonfoil"' + (!defaultFoil ? ' selected' : '') + '>Non-foil' + (prices.usd ? ' · ' + money(prices.usd) : '') + '</option>' : '') +
          (canFoil ? '<option value="foil"' + (defaultFoil ? ' selected' : '') + '>Foil' + (prices.usd_foil ? ' · ' + money(prices.usd_foil) : '') + '</option>' : '') +
        '</select></label>' +
      '<button type="button" class="btn btn-accent" id="pick-add">Add to binder</button>' +
      '<button type="button" class="btn btn-ghost" id="pick-cancel">Cancel</button>' +
    '</div>';
  panel.hidden = false;
  $('#pick-cancel').addEventListener('click', () => { panel.hidden = true; });
  $('#pick-add').addEventListener('click', () => addScryfallCard(card));
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------------- price chain (client) ----------------
   The same chain as Card Binders: Scryfall first (its USD price is the
   TCGplayer market price) → Cardmarket EUR converted at the live rate →
   the same set's English printing as a stand-in for foreign printings.
   Returns { usd, usd_foil, source } with numbers or nulls. */
let fxEurUsdCache;
async function fxEurUsd() {
  if (fxEurUsdCache !== undefined) return fxEurUsdCache;
  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=EUR&to=USD');
    const j = await r.json();
    fxEurUsdCache = j && j.rates && j.rates.USD ? Number(j.rates.USD) : null;
  } catch { fxEurUsdCache = null; }
  return fxEurUsdCache;
}

async function chainPriceClient(card) {
  const p = card.prices || {};
  const usd = p.usd ? Number(p.usd) : null;
  const usdFoil = p.usd_foil ? Number(p.usd_foil) : null;
  if (usd != null || usdFoil != null) return { usd, usd_foil: usdFoil, source: 'Scryfall' };
  const r2 = (n) => Math.round(n * 100) / 100;
  const eur = p.eur ? Number(p.eur) : null;
  const eurFoil = p.eur_foil ? Number(p.eur_foil) : null;
  if (eur != null || eurFoil != null) {
    const rate = await fxEurUsd();
    if (rate) return { usd: eur != null ? r2(eur * rate) : null, usd_foil: eurFoil != null ? r2(eurFoil * rate) : null, source: 'cardmarket' };
  }
  if (card.lang && card.lang !== 'en' && card.set && card.collector_number) {
    try {
      const r = await fetch('https://api.scryfall.com/cards/' + encodeURIComponent(card.set) + '/' + encodeURIComponent(card.collector_number));
      if (r.ok) {
        const en = await r.json();
        const ep = en.prices || {};
        const eUsd = ep.usd ? Number(ep.usd) : null;
        const eFoil = ep.usd_foil ? Number(ep.usd_foil) : null;
        if (eUsd != null || eFoil != null) return { usd: eUsd, usd_foil: eFoil, source: 'english_printing' };
        const eEur = ep.eur ? Number(ep.eur) : null;
        const eEurFoil = ep.eur_foil ? Number(ep.eur_foil) : null;
        if (eEur != null || eEurFoil != null) {
          const rate = await fxEurUsd();
          if (rate) return { usd: eEur != null ? r2(eEur * rate) : null, usd_foil: eEurFoil != null ? r2(eEurFoil * rate) : null, source: 'english_printing' };
        }
      }
    } catch { /* fall through to unpriced */ }
  }
  return { usd: null, usd_foil: null, source: null };
}

/* File one copy of a Scryfall card into a binder at the chosen finish,
   chain-priced. Shared by the binder page's Add flow and the Look up page.
   Throws on failure; callers handle their own notices. */
async function fileCardIntoBinder(card, binder, isFoil) {
  const chain = await chainPriceClient(card);
  const priceUsd = chain.usd;
  const priceFoil = chain.usd_foil;
  // One row per (binder, printing, finish): increment if already present.
  const { data: existing, error: exErr } = await sb.from('binder_cards')
    .select('id, quantity')
    .eq('binder_id', binder.id).eq('scryfall_id', card.id).eq('is_foil', isFoil)
    .maybeSingle();
  if (exErr) throw exErr;
  if (existing) {
    const { error } = await sb.from('binder_cards')
      .update({ quantity: (existing.quantity || 1) + 1 }).eq('id', existing.id);
    if (error) throw error;
  } else {
    const { error } = await sb.from('binder_cards').insert({
      binder_id: binder.id,
      owner_id: state.user.id,
      scryfall_id: card.id,
      name: card.name,
      printed_name: card.printed_name || null,
      set_code: card.set || null,
      set_name: card.set_name || null,
      collector_number: card.collector_number || null,
      lang: card.lang || 'en',
      is_foil: isFoil,
      quantity: 1,
      rarity: card.rarity || null,
      type_line: card.type_line || null,
      image_uri: scryImage(card),
      price_usd: priceUsd,
      price_usd_foil: priceFoil,
      price_source: chain.source,
      unit_price: isFoil ? priceFoil : priceUsd
    });
    if (error) throw error;
  }
}

async function addScryfallCard(card) {
  const binder = state.currentBinder;
  if (!binder) return;
  const isFoil = $('#pick-finish').value === 'foil';
  try {
    await fileCardIntoBinder(card, binder, isFoil);
    $('#pick-panel').hidden = true;
    showNotice('Added ' + card.name + ' (' + (isFoil ? 'foil' : 'non-foil') + ')');
    await loadBinderCards();
    loadMyBinders();
  } catch (err) {
    showNotice('Could not add card: ' + friendlyError(err), 6000);
  }
}

/* ---------------- look up a card ----------------
   Standalone name lookup (Jakson's ask): type a name, see EVERY printing
   and art of the card, tap one, choose foil or non-foil, and add it to any
   of your binders — no need to open a binder first. The panel also says how
   many of that exact printing you already own. */
async function searchLookup(ev) {
  ev.preventDefault();
  $('#lookup-suggest').hidden = true;
  runLookupQuery($('#lookup-input').value.trim());
}

/* Live suggestions while typing (Jakson's ask): after a short pause, guess
   the cards he means from the letters so far — one row per card name, each
   with its picture — no Search button needed. Tapping a suggestion runs the
   full printings lookup for that exact name. Stale responses are dropped via
   a sequence counter so slow replies never overwrite newer guesses. */
let lookupTypeSeq = 0;
async function onLookupType() {
  const q = $('#lookup-input').value.trim();
  const box = $('#lookup-suggest');
  const my = ++lookupTypeSeq;
  if (q.length < 2) { box.hidden = true; box.innerHTML = ''; return; }
  await new Promise(r => setTimeout(r, 300));
  if (my !== lookupTypeSeq) return;
  try {
    // Scryfall's autocomplete endpoint is built for this: relevance-ranked
    // card NAMES from partial letters. (A plain search guesses far too
    // broadly — "sma" alone matches 200+ cards.) Images come from one
    // named lookup per suggestion, in parallel.
    const ac = await fetch('https://api.scryfall.com/cards/autocomplete?q=' +
      encodeURIComponent(q), { headers: { 'Accept': 'application/json' } });
    if (my !== lookupTypeSeq) return;
    if (!ac.ok) { box.hidden = true; box.innerHTML = ''; return; }
    const acJson = await ac.json();
    const names = (acJson.data || []).slice(0, 8);
    if (!names.length) { box.hidden = true; box.innerHTML = ''; return; }
    const cards = await Promise.all(names.map(async (name) => {
      try {
        const r = await fetch('https://api.scryfall.com/cards/named?exact=' +
          encodeURIComponent(name), { headers: { 'Accept': 'application/json' } });
        if (r.ok) return await r.json();
      } catch (e) { /* fall through to a name-only row */ }
      return { name };
    }));
    if (my !== lookupTypeSeq) return;
    box.innerHTML = '';
    cards.forEach(card => box.appendChild(suggestHit(card)));
    box.hidden = false;
  } catch (e) {
    box.hidden = true;
  }
}

function suggestHit(card) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'search-hit';
  const img = scryImage(card);
  btn.innerHTML =
    (img ? '<img src="' + esc(img) + '" alt="">' : '') +
    '<span><span class="hit-name">' + esc(card.name) + '</span><br>' +
    '<span class="hit-sub">' + esc(card.set_name || '') + ' · ' + esc(card.type_line || '') + '</span></span>';
  btn.addEventListener('click', () => {
    $('#lookup-input').value = card.name;
    $('#lookup-suggest').hidden = true;
    runLookupQuery('!"' + card.name.replace(/"/g, '') + '"');
  });
  return btn;
}

async function runLookupQuery(q) {
  const box = $('#lookup-results');
  const status = $('#lookup-status');
  $('#lookup-panel').hidden = true;
  if (!q) return;
  status.textContent = 'Searching…';
  box.innerHTML = '';
  try {
    const url = 'https://api.scryfall.com/cards/search?unique=prints&order=name&q=' +
      encodeURIComponent(q);
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (res.status === 404) {
      status.textContent = 'No cards matched that search.';
      return;
    }
    if (!res.ok) throw new Error('Scryfall returned ' + res.status);
    const json = await res.json();
    const results = (json.data || []).slice(0, 60);
    status.textContent = results.length
      ? results.length + ' printings — tap the one you have.'
      : 'No cards matched that search.';
    results.forEach(card => box.appendChild(lookupHit(card)));
  } catch (err) {
    status.textContent = 'Search failed: ' + friendlyError(err);
  }
}

function lookupHit(card) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'search-hit';
  const img = scryImage(card);
  btn.innerHTML =
    (img ? '<img src="' + esc(img) + '" alt="">' : '') +
    '<span><span class="hit-name">' + esc(card.printed_name && card.lang !== 'en' ? card.printed_name : card.name) + '</span><br>' +
    '<span class="hit-sub">' + esc(card.set_name || '') + ' · #' + esc(card.collector_number || '') +
    ' · ' + esc(card.rarity || '') + (card.lang && card.lang !== 'en' ? ' · ' + esc(card.lang.toUpperCase()) : '') + '</span></span>';
  btn.addEventListener('click', () => showLookupPanel(card));
  return btn;
}

async function lookupOwnedLine(card) {
  try {
    const { data } = await sb.from('binder_cards')
      .select('quantity, is_foil')
      .eq('owner_id', state.user.id).eq('scryfall_id', card.id);
    const rows = data || [];
    if (!rows.length) return 'You don\u2019t own this printing yet.';
    const foil = rows.filter(r => r.is_foil).reduce((a, r) => a + (r.quantity || 1), 0);
    const non = rows.filter(r => !r.is_foil).reduce((a, r) => a + (r.quantity || 1), 0);
    const bits = [];
    if (non) bits.push(non + ' non-foil');
    if (foil) bits.push(foil + ' foil');
    return 'You own ' + (non + foil) + ' of this printing (' + bits.join(', ') + ').';
  } catch (e) {
    return '';
  }
}

async function showLookupPanel(card) {
  const panel = $('#lookup-panel');
  const finishes = card.finishes || ['nonfoil'];
  const canFoil = finishes.includes('foil') || finishes.includes('etched');
  const canNonfoil = finishes.includes('nonfoil');
  const defaultFoil = canFoil && !canNonfoil;
  const prices = card.prices || {};
  const img = scryImage(card);
  const { data: binders } = await sb.from('binders')
    .select('id, name, is_main').eq('owner_id', state.user.id).order('created_at');
  const binderList = binders || [];
  // A-15 (v15): the default filing binder is the is_main FLAG, never a
  // name match — renaming Main Collection must not redirect filings.
  const mainId = (binderList.find(b => b.is_main) || binderList[0] || {}).id;
  const binderOptions = binderList.map(b =>
    '<option value="' + esc(b.id) + '"' + (b.id === mainId ? ' selected' : '') + '>' + esc(b.name) + '</option>').join('');
  panel.innerHTML =
    '<div class="pick-row">' +
      (img ? '<img src="' + esc(img) + '" alt="" style="width:90px;border-radius:8px;">' : '') +
      '<strong>' + esc(card.name) + '</strong>' +
      '<span class="muted">' + esc(card.set_name || '') + ' #' + esc(card.collector_number || '') +
        ' · ' + esc(card.rarity || '') + (card.lang && card.lang !== 'en' ? ' · ' + esc(card.lang.toUpperCase()) : '') + '</span>' +
      '<span class="muted" data-lookup-owned>Checking your binders…</span>' +
      '<label>Finish ' +
        '<select id="lookup-finish">' +
          (canNonfoil ? '<option value="nonfoil"' + (!defaultFoil ? ' selected' : '') + '>Non-foil' + (prices.usd ? ' · ' + money(prices.usd) : '') + '</option>' : '') +
          (canFoil ? '<option value="foil"' + (defaultFoil ? ' selected' : '') + '>Foil' + (prices.usd_foil ? ' · ' + money(prices.usd_foil) : '') + '</option>' : '') +
        '</select></label>' +
      '<label>Add to ' +
        '<select id="lookup-binder">' + binderOptions + '</select></label>' +
      '<span class="muted" data-lookup-hint></span>' +
      '<button type="button" class="btn btn-accent" id="lookup-add">Add</button>' +
      '<button type="button" class="btn btn-ghost" id="lookup-cancel">Close</button>' +
    '</div>';
  panel.hidden = false;
  panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  const ownedEl = panel.querySelector('[data-lookup-owned]');
  ownedEl.textContent = await lookupOwnedLine(card);
  // A-21 hint (v15): signpost what the chosen binder means for Spares.
  const lookupHintEl = panel.querySelector('[data-lookup-hint]');
  const paintLookupHint = () => {
    const chosen = binderList.find(x => x.id === $('#lookup-binder').value);
    lookupHintEl.textContent = chosen && chosen.is_main
      ? 'Filed into your Main Collection, so it counts in Spares and the set binders.'
      : 'Only cards in your Main Collection count in Spares and the set binders.';
  };
  $('#lookup-binder').addEventListener('change', paintLookupHint);
  paintLookupHint();
  $('#lookup-cancel').addEventListener('click', () => { panel.hidden = true; });
  $('#lookup-add').addEventListener('click', async () => {
    const binder = binderList.find(b => b.id === $('#lookup-binder').value);
    if (!binder) { showNotice('Pick a binder first.', 4000); return; }
    const isFoil = $('#lookup-finish').value === 'foil';
    try {
      await fileCardIntoBinder(card, binder, isFoil);
      showNotice('Added ' + card.name + ' (' + (isFoil ? 'foil' : 'non-foil') + ') to ' + binder.name);
      ownedEl.textContent = await lookupOwnedLine(card);
    } catch (err) {
      showNotice('Could not add card: ' + friendlyError(err), 6000);
    }
  });
}

/* ---------------- members ---------------- */
function renderMemberList(filterText) {
  const list = $('#member-list');
  const q = String(filterText || '').trim().toLowerCase();
  list.innerHTML = '';
  (state.allMembers || [])
    .filter(p => p.id !== state.user.id)
    .filter(p => !q || String(p.display_name || '').toLowerCase().includes(q))
    .forEach(p => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'member-card';
      btn.innerHTML = '<span class="avatar"></span><span>' + esc(p.display_name || 'Member') + '</span>';
      paintAvatar($('.avatar', btn), p);
      btn.addEventListener('click', () => openMember(p));
      list.appendChild(btn);
    });
  if (!list.children.length) {
    list.innerHTML = '<p class="empty">' + (q ? 'No members match that search.' : 'No other members yet — you are the first here.') + '</p>';
  }
}

function profileById(id) {
  if (state.profile && state.profile.id === id) return state.profile;
  return (state.allMembers || []).find(p => p.id === id) || null;
}

async function ensureProfiles() {
  if (state.allMembers && state.allMembers.length) return;
  const { data } = await sb.from('profiles').select('*').order('display_name', { ascending: true });
  state.allMembers = data || [];
}

async function loadMembers() {
  $('#members-loading').hidden = false;
  $('#members-error').hidden = true;
  try {
    const { data, error } = await sb.from('profiles')
      .select('*').order('display_name', { ascending: true });
    if (error) throw error;
    state.allMembers = data || [];
    renderMemberList($('#member-search').value || '');
  } catch (err) {
    const e = $('#members-error');
    e.textContent = 'Could not load members: ' + friendlyError(err);
    e.hidden = false;
  } finally {
    $('#members-loading').hidden = true;
  }
}

async function openMember(profile) {
  state.memberProfile = profile;
  paintAvatar($('#member-avatar'), profile);
  $('#member-name').textContent = profile.display_name || 'Member';
  $('#member-loading').hidden = false;
  $('#member-empty').hidden = true;
  $('#member-binders').innerHTML = '';
  showPage('member');
  try {
    const { data: binders, error } = await sb.from('binders')
      .select('*').eq('owner_id', profile.id).eq('is_public', true)
      .order('created_at', { ascending: true });
    if (error) throw error;
    // Showcase binders first.
    const sorted = (binders || []).slice().sort((a, b2) =>
      (b2.kind === 'showcase' ? 1 : 0) - (a.kind === 'showcase' ? 1 : 0));
    state.memberBinders = sorted;

    // Stats for their public binders (RLS lets signed-in users read these cards).
    const stats = {};
    if (sorted.length) {
      const { data: cards } = await sb.from('binder_cards')
        .select('binder_id, quantity, unit_price')
        .in('binder_id', sorted.map(b => b.id));
      (cards || []).forEach(c => {
        const s = stats[c.binder_id] || (stats[c.binder_id] = { qty: 0, distinct: 0, value: 0 });
        s.qty += c.quantity || 0; s.distinct += 1;
        s.value += (Number(c.unit_price) || 0) * (c.quantity || 0);
      });
    }
    renderBinderList($('#member-binders'), sorted, stats, true);
    $('#member-empty').hidden = sorted.length > 0 || !!profile.is_public;
    if (!sorted.length && profile.is_public) {
      $('#member-empty').textContent = 'This member is public but has not made any binders public yet.';
      $('#member-empty').hidden = false;
    } else if (!sorted.length) {
      $('#member-empty').textContent = "This member hasn't made anything public yet.";
    }
    await loadMemberExtras(profile, sorted);
  } catch (err) {
    showNotice('Could not load that member: ' + friendlyError(err), 6000);
  } finally {
    $('#member-loading').hidden = true;
  }
}

/* ---------------- my profile ---------------- */
function paintProfileForm() {
  const p = state.profile;
  if (!p) return;
  paintAvatar($('#profile-avatar-preview'), p);
  $('#profile-name').value = p.display_name || '';
  $('#profile-public').checked = !!p.is_public;
  state.selectedColor = p.profile_color || DEFAULT_COLOR;
  $('#profile-color-custom').value = state.selectedColor;
  renderPalette();
}

function renderPalette() {
  const wrap = $('#color-palette');
  wrap.innerHTML = '';
  PALETTE.forEach(color => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch' + (color === state.selectedColor ? ' selected' : '');
    b.style.background = color;
    b.setAttribute('aria-label', 'Profile colour ' + color);
    b.addEventListener('click', () => {
      state.selectedColor = color;
      $('#profile-color-custom').value = color;
      renderPalette();
      previewColor();
    });
    wrap.appendChild(b);
  });
}

function previewColor() {
  document.documentElement.style.setProperty('--accent', state.selectedColor);
  const preview = Object.assign({}, state.profile, { profile_color: state.selectedColor });
  paintAvatar($('#profile-avatar-preview'), preview);
}

async function saveProfile(ev) {
  ev.preventDefault();
  $('#profile-error').hidden = true;
  const payload = {
    display_name: $('#profile-name').value.trim() || 'Collector',
    profile_color: state.selectedColor,
    is_public: $('#profile-public').checked
  };
  try {
    const { data, error } = await sb.from('profiles')
      .update(payload).eq('id', state.user.id).select().single();
    if (error) throw error;
    state.profile = data;
    paintHeader();
    applyAccent();
    paintProfileForm();
    $('#profile-status').textContent = 'Saved.';
    showNotice('Profile saved');
  } catch (err) {
    const e = $('#profile-error');
    e.textContent = 'Could not save: ' + friendlyError(err);
    e.hidden = false;
  }
}

async function uploadAvatar(file) {
  if (!file) return;
  const status = $('#avatar-status');
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = state.user.id + '/avatar.' + ext;
  status.textContent = 'Uploading…';
  try {
    const { error: upErr } = await sb.storage.from('avatars')
      .upload(path, file, { upsert: true, contentType: file.type || undefined });
    if (upErr) throw upErr;
    const { data: pub } = sb.storage.from('avatars').getPublicUrl(path);
    const url = pub.publicUrl + '?v=' + Date.now(); // cache-bust after replacement
    const { data, error } = await sb.from('profiles')
      .update({ avatar_url: url }).eq('id', state.user.id).select().single();
    if (error) throw error;
    state.profile = data;
    paintHeader();
    paintProfileForm();
    status.textContent = 'Picture updated.';
    showNotice('Profile picture updated');
  } catch (err) {
    status.textContent = 'Upload failed: ' + friendlyError(err);
  }
}

/* ---------------- install (PWA) ---------------- */
let deferredInstallPrompt = null;

function isStandalone() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
    || window.navigator.standalone === true;
}
function isIOSDevice() {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent || '');
}
function paintInstallButtons() {
  // Show the button only when an install is actually possible: Chrome's
  // deferred prompt on Android/desktop, or the Share-sheet route on iOS.
  // Never show it once the app is installed (standalone display mode).
  const show = !isStandalone() && (!!deferredInstallPrompt || isIOSDevice());
  document.querySelectorAll('.install-btn').forEach((b) => { b.hidden = !show; });
}
async function onInstallClick() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    try { await deferredInstallPrompt.userChoice; } catch (e) { /* prompt dismissed */ }
    deferredInstallPrompt = null;
    paintInstallButtons();
  } else if (isIOSDevice()) {
    showNotice('To install on iPhone/iPad: tap the Share button, then "Add to Home Screen".', 8000);
  }
}

/* Share the site link: the phone's share sheet where available
   (navigator.share), otherwise copy the link and say so on the button. */
async function shareSite(btn) {
  const url = window.location.origin + '/';
  if (navigator.share) {
    try {
      await navigator.share({
        title: 'Spellbinder',
        text: 'Spellbinder — organize your Magic: The Gathering binders, scan cards in, and trade with other members.',
        url
      });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return; // they closed the share sheet
      // any other failure falls through to copying
    }
  }
  let copied = false;
  try { await navigator.clipboard.writeText(url); copied = true; }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { copied = document.execCommand('copy'); } catch (err) { copied = false; }
    ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = copied ? '✓ Link copied' : url;
    setTimeout(() => { btn.textContent = old; }, 2500);
  }
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  paintInstallButtons();
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  paintInstallButtons();
});

/* ---------------- header / boot ---------------- */
function paintHeader() {
  paintAvatar($('#header-avatar'), state.profile);
  $('#header-name').textContent = (state.profile && state.profile.display_name) || '';
}

async function enterApp() {
  $('#view-auth').hidden = true;
  $('#view-app').hidden = false;
  try {
    await loadProfile();
  } catch (err) {
    showNotice('Could not load your profile: ' + friendlyError(err), 7000);
  }
  applyAccent();
  paintHeader();
  paintProfileForm();
  await claimMigration();
  await loadMyBinders();
  await ensureMainCollection();
  showPage('home');
}

/* New members get a Main Collection automatically (Phase 6): trades deliver
   into it, set binders mirror it, spares read from it. It used to exist only
   for imported collections, which broke trade accepts for everyone else —
   the delivery step had nowhere to put the cards. */
let mainEnsured = false;
async function ensureMainCollection() {
  if (mainEnsured || !state.user) return;
  mainEnsured = true;
  try {
    if ((state.binders || []).some(b => b.is_main)) return;
    const { error } = await sb.from('binders').insert({
      owner_id: state.user.id, name: 'Main Collection', description: '',
      kind: 'collection', is_main: true, is_public: false
    });
    if (!error) await loadMyBinders();
  } catch (e) { /* non-fatal: the trade engine creates it on delivery too */ }
}

function enterAuth() {
  state.user = null;
  state.profile = null;
  state.migrationChecked = false;
  mainEnsured = false;
  $('#view-app').hidden = true;
  $('#view-auth').hidden = false;
}

async function boot() {
  if ('serviceWorker' in navigator) {
    // Required for Chrome to offer installation; failure just means no prompt.
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  paintInstallButtons();
  const { data } = await sb.auth.getSession();
  if (data && data.session) {
    state.user = data.session.user;
    enterApp();
  } else {
    enterAuth();
  }
  sb.auth.onAuthStateChange((event, session) => {
    if (session && session.user) {
      const isNewUser = !state.user || state.user.id !== session.user.id;
      state.user = session.user;
      if (isNewUser) enterApp();
    } else if (event === 'SIGNED_OUT') {
      enterAuth();
    }
  });
}

/* ---------------- Phase 2: member extras, trades, spares & wants ---------------- */
function wantMatchesCard(want, card) {
  return want.scryfall_id === card.scryfall_id &&
    (want.is_foil === null || want.is_foil === undefined || want.is_foil === card.is_foil);
}

async function loadMyWants() {
  const { data } = await sb.from('wants').select('*').eq('owner_id', state.user.id)
    .order('created_at', { ascending: true });
  state.myWants = data || [];
  return state.myWants;
}

async function loadMemberExtras(profile, publicBinders) {
  // Their public decks.
  const decksBlock = $('#member-decks-block');
  decksBlock.hidden = true;
  try {
    const { data: decks } = await sb.from('decks').select('*')
      .eq('owner_id', profile.id).eq('is_public', true).order('created_at', { ascending: true });
    if (decks && decks.length) {
      const wrap = $('#member-decks');
      wrap.innerHTML = '';
      const { data: dcards } = await sb.from('deck_cards')
        .select('deck_id, quantity, unit_price').in('deck_id', decks.map(d => d.id));
      const dstats = {};
      (dcards || []).forEach(c => {
        const s = dstats[c.deck_id] || (dstats[c.deck_id] = { qty: 0, distinct: 0, value: 0 });
        s.qty += c.quantity || 1; s.distinct += 1;
        s.value += (Number(c.unit_price) || 0) * (c.quantity || 1);
      });
      decks.forEach(d => {
        const s = dstats[d.id] || { qty: 0, distinct: 0, value: 0 };
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'binder-card';
        btn.innerHTML = '<h3>' + esc(d.name) + ' <span class="badge badge-public">Public deck</span></h3>' +
          (d.format ? '<p class="stats">' + esc(d.format) + '</p>' : '') +
          '<p class="stats">' + s.distinct + ' distinct · ' + s.qty + ' cards</p>' +
          '<p class="value">' + money(s.value) + '</p>';
        btn.addEventListener('click', () => openDeck(d, true));
        wrap.appendChild(btn);
      });
      decksBlock.hidden = false;
    }
  } catch (e) {
    console.warn('Member decks failed:', e);
  }

  // Their spares: duplicate copies in their Main Collection, if it's public.
  const sparesBlock = $('#member-spares-block');
  const wantsBlock = $('#member-wants-block');
  sparesBlock.hidden = true;
  wantsBlock.hidden = true;
  try {
    const theirMain = (publicBinders || []).find(b => b.is_main);
    if (theirMain) {
      const { data: cards } = await sb.from('binder_cards')
        .select('*').eq('binder_id', theirMain.id).gt('quantity', 1)
        .order('name', { ascending: true });
      const spares = cards || [];
      if (spares.length) {
        if (!state.myWants) await loadMyWants();
        const wrap = $('#member-spares');
        wrap.innerHTML = '';
        spares.forEach(c => {
          const wanted = (state.myWants || []).some(w => wantMatchesCard(w, c));
          const row = document.createElement('div');
          row.className = 'mini-row';
          row.innerHTML =
            (c.image_uri ? '<img src="' + esc(c.image_uri) + '" alt="">' : '') +
            '<span class="grow"><span class="nm">' + (wanted ? '<span class="flag-want">★ </span>' : '') + esc(c.printed_name && c.lang !== 'en' ? c.printed_name : c.name) + '</span><br>' +
            '<span class="sub">' + esc(c.set_name || '') + (c.collector_number ? ' · #' + esc(c.collector_number) : '') + (c.is_foil ? ' · Foil' : '') + '</span></span>' +
            '<span class="sub">' + (c.quantity - 1) + ' spare · ' + money(c.unit_price) + ' ea</span>';
          wrap.appendChild(row);
        });
        sparesBlock.hidden = false;
      }
    }
    const { data: wants } = await sb.from('wants').select('*')
      .eq('owner_id', profile.id).order('created_at', { ascending: true });
    if (wants && wants.length) {
      const wrap = $('#member-wants');
      wrap.innerHTML = '';
      wants.forEach(w => {
        const row = document.createElement('div');
        row.className = 'mini-row';
        row.innerHTML =
          (w.image_uri ? '<img src="' + esc(w.image_uri) + '" alt="">' : '') +
          '<span class="grow"><span class="nm">' + esc(w.name) + '</span><br>' +
          '<span class="sub">' + esc(w.set_name || '') + (w.collector_number ? ' · #' + esc(w.collector_number) : '') +
          (w.is_foil === true ? ' · Foil' : w.is_foil === false ? ' · Non-foil' : ' · Any finish') + '</span></span>' +
          (w.note ? '<span class="sub">' + esc(w.note) + '</span>' : '');
        wrap.appendChild(row);
      });
      wantsBlock.hidden = false;
    }
  } catch (err) {
    console.warn('Member extras failed:', err);
  }
}

/* ---- trades ---- */
async function loadTrades() {
  $('#trades-loading').hidden = false;
  $('#trades-error').hidden = true;
  try {
    await ensureProfiles();
    const { data: trades, error } = await sb.from('trades')
      .select('*')
      .or('proposer_id.eq.' + state.user.id + ',partner_id.eq.' + state.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    const list = trades || [];
    let itemsByTrade = {};
    if (list.length) {
      const { data: items } = await sb.from('trade_items')
        .select('*').in('trade_id', list.map(t => t.id));
      (items || []).forEach(it => {
        (itemsByTrade[it.trade_id] = itemsByTrade[it.trade_id] || []).push(it);
      });
    }
    const open = list.filter(t => t.status === 'open');
    const closed = list.filter(t => t.status !== 'open');
    const openWrap = $('#open-trades');
    openWrap.innerHTML = '';
    // Trades waiting on YOUR decision go to the very top (Jakson's ask),
    // under their own heading; trades you proposed follow.
    const incoming = open.filter(t => t.proposer_id !== state.user.id);
    const outgoing = open.filter(t => t.proposer_id === state.user.id);
    const subHead = (text) => {
      const h = document.createElement('h4');
      h.className = 'family-title';
      h.textContent = text;
      return h;
    };
    if (incoming.length) {
      openWrap.appendChild(subHead('⏳ Waiting on you'));
      incoming.forEach(t => openWrap.appendChild(tradeCard(t, itemsByTrade[t.id] || [], true)));
      if (outgoing.length) openWrap.appendChild(subHead('Waiting on them'));
    }
    outgoing.forEach(t => openWrap.appendChild(tradeCard(t, itemsByTrade[t.id] || [], true)));
    $('#trades-empty').hidden = open.length > 0;
    const q = String($('#trade-log-search').value || '').trim().toLowerCase();
    const logWrap = $('#trade-log');
    logWrap.innerHTML = '';
    closed.filter(t => {
      if (!q) return true;
      const other = profileById(t.proposer_id === state.user.id ? t.partner_id : t.proposer_id);
      return String((other && other.display_name) || '').toLowerCase().includes(q);
    }).forEach(t => logWrap.appendChild(tradeCard(t, itemsByTrade[t.id] || [], false)));
    if (!logWrap.children.length) {
      logWrap.innerHTML = '<p class="empty">No closed trades yet.</p>';
    }
  } catch (err) {
    const e = $('#trades-error');
    e.textContent = 'Could not load trades: ' + friendlyError(err);
    e.hidden = false;
  } finally {
    $('#trades-loading').hidden = true;
  }
}

function tradeSideHTML(items, ownerId, label) {
  const mine = items.filter(i => i.side === ownerId);
  const total = mine.reduce((s, i) => s + (Number(i.unit_price) || 0) * (i.quantity || 1), 0);
  const rows = mine.length ? mine.map(i =>
    '<div class="mini-row">' +
      (i.image_uri ? '<img src="' + esc(i.image_uri) + '" alt="">' : '') +
      '<span class="grow"><span class="nm">' + esc(i.name) + '</span><br>' +
      '<span class="sub">' + esc(i.set_name || '') + (i.collector_number ? ' · #' + esc(i.collector_number) : '') + (i.is_foil ? ' · Foil' : '') + '</span></span>' +
      '<span class="sub">×' + (i.quantity || 1) + ' · ' + money((Number(i.unit_price) || 0) * (i.quantity || 1)) + '</span>' +
    '</div>').join('')
    : '<p class="muted small">Nothing</p>';
  return '<div class="trade-side"><h4>' + esc(label) + ' — ' + money(total) + '</h4>' + rows + '</div>';
}

function tradeCard(t, items, isOpen) {
  const iAmProposer = t.proposer_id === state.user.id;
  const other = profileById(iAmProposer ? t.partner_id : t.proposer_id);
  const otherName = (other && other.display_name) || 'Member';
  const card = document.createElement('div');
  card.className = 'trade-card';
  const chip = t.status === 'open'
    ? '<span class="chip chip-open">Open</span>'
    : t.status === 'completed'
      ? '<span class="chip chip-done">Completed</span>'
      : t.status === 'countered'
        ? '<span class="chip">Countered</span>'
        : '<span class="chip">Cancelled</span>';
  const when = new Date(t.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  let actions = '';
  if (isOpen) {
    if (!iAmProposer) actions = '<button type="button" class="btn btn-accent" data-act="accept">Accept — swap the cards</button> <button type="button" class="btn btn-ghost" data-act="counter">↩️ Edit / Counter</button> <button type="button" class="btn btn-danger" data-act="decline">Decline</button>';
    else actions = '<span class="muted small">Waiting for ' + esc(otherName) + '…</span> <button type="button" class="btn btn-ghost" data-act="cancel">Cancel proposal</button>';
  }
  card.innerHTML =
    '<div class="trade-head"><span class="avatar"></span><strong>' + esc(otherName) + '</strong>' + chip +
      '<span class="muted small">' + (iAmProposer ? 'You proposed' : 'They proposed') + ' · ' + when + '</span></div>' +
    // Action buttons at the TOP of the card (Jakson's ask) — no scrolling
    // past both card lists to accept. Incoming trades repeat them at the
    // bottom too, since those lists can be long.
    (actions ? '<div class="row-gap" style="margin:.6rem 0;">' + actions + '</div>' : '') +
    (t.note ? '<p class="muted">“' + esc(t.note) + '”</p>' : '') +
    '<div class="trade-sides">' +
      tradeSideHTML(items, state.user.id, 'You give') +
      tradeSideHTML(items, iAmProposer ? t.partner_id : t.proposer_id, 'You get') +
    '</div>' +
    (actions && !iAmProposer ? '<div class="row-gap" style="margin-top:.6rem;">' + actions + '</div>' : '') +
    // Per-trade chat (Phase 6): talk right on the trade while you haggle.
    '<div class="trade-chat-wrap">' +
      '<button type="button" class="btn btn-ghost" data-chat-toggle>💬 Chat</button>' +
      '<div class="trade-chat" hidden>' +
        '<div class="chat-log"><p class="muted small">Loading…</p></div>' +
        (isOpen ? '<div class="chat-form"><input type="text" maxlength="2000" placeholder="Message about this trade…"><button type="button" class="btn btn-accent" data-chat-send>Send</button></div>' : '') +
      '</div>' +
    '</div>';
  paintAvatar($('.avatar', card), other);
  $$('button[data-act]', card).forEach(btn => {
    btn.addEventListener('click', async () => {
      const act = btn.getAttribute('data-act');
      if (act === 'accept') await completeTrade(t.id);
      else if (act === 'counter') counterTrade(t, items);
      else await cancelTrade(t.id, act === 'decline' ? 'Trade declined' : 'Proposal cancelled');
    });
  });
  // Chat wiring: load the thread the first time it's opened.
  const chatPanel = $('.trade-chat', card);
  let chatLoaded = false;
  $('[data-chat-toggle]', card).addEventListener('click', async () => {
    chatPanel.hidden = !chatPanel.hidden;
    if (!chatPanel.hidden && !chatLoaded) { chatLoaded = true; await loadTradeChat(t.id, chatPanel); }
  });
  const chatSend = $('[data-chat-send]', card);
  if (chatSend) {
    const chatInput = $('input', chatPanel);
    const sendChat = async () => {
      const body = chatInput.value.trim();
      if (!body) return;
      chatSend.disabled = true;
      try {
        const { error } = await sb.from('trade_messages')
          .insert({ trade_id: t.id, sender_id: state.user.id, body });
        if (error) throw error;
        chatInput.value = '';
        await loadTradeChat(t.id, chatPanel);
      } catch (err) {
        showNotice('Could not send the message: ' + friendlyError(err), 6000);
      } finally { chatSend.disabled = false; }
    };
    chatSend.addEventListener('click', sendChat);
    chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendChat(); } });
  }
  return card;
}

/* Counter-offer entry point: stash the trade, then open the composer against
   its proposer — openCompose flips the perspective and prefills the items. */
function counterTrade(t, items) {
  const proposer = profileById(t.proposer_id);
  if (!proposer) { showNotice('Could not find that member.', 5000); return; }
  state.pendingCounter = { tradeId: t.id, note: t.note || '', items: items || [] };
  openCompose(proposer);
}

async function loadTradeChat(tradeId, panel) {
  const log = $('.chat-log', panel);
  try {
    const { data, error } = await sb.from('trade_messages').select('*')
      .eq('trade_id', tradeId).order('created_at', { ascending: true }).limit(200);
    if (error) throw error;
    if (!data || !data.length) {
      log.innerHTML = '<p class="muted small">No messages yet — say hi and haggle.</p>';
      return;
    }
    log.innerHTML = data.map(m => {
      const mine = m.sender_id === state.user.id;
      const who = mine ? 'You' : ((profileById(m.sender_id) || {}).display_name || 'Member');
      const when = new Date(m.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      return '<div class="chat-msg' + (mine ? ' chat-mine' : '') + '"><div class="chat-meta">' +
        esc(who) + ' · ' + esc(when) + '</div><div>' + esc(m.body) + '</div></div>';
    }).join('');
    log.scrollTop = log.scrollHeight;
  } catch (err) {
    log.innerHTML = '<p class="error">Could not load messages: ' + esc(friendlyError(err)) + '</p>';
  }
}

async function completeTrade(tradeId) {
  try {
    const { error } = await sb.rpc('complete_trade', { p_trade_id: tradeId });
    if (error) throw error;
    showNotice('Trade completed — the cards have swapped Main Collections.');
    await loadTrades();
    loadMyBinders();
  } catch (err) {
    showNotice('Could not complete the trade: ' + friendlyError(err), 7000);
  }
}

async function cancelTrade(tradeId, doneMsg) {
  try {
    const { error } = await sb.from('trades')
      .update({ status: 'cancelled', closed_at: new Date().toISOString() })
      .eq('id', tradeId).eq('status', 'open');
    if (error) throw error;
    showNotice(doneMsg);
    await loadTrades();
  } catch (err) {
    showNotice('Could not update the trade: ' + friendlyError(err), 6000);
  }
}

/* ---- trade composer ---- */
async function openCompose(partner) {
  if (!partner || partner.id === state.user.id) return;
  // Counter mode (Phase 6): state.pendingCounter carries the trade being
  // answered; the composer opens prefilled with its items from the other
  // side's point of view, and sending supersedes the original trade.
  const counter = state.pendingCounter || null;
  state.pendingCounter = null;
  state.compose = { partner: partner, give: new Map(), get: new Map(), myCards: [], theirCards: [], counterOf: counter ? counter.tradeId : null };
  $('#compose-title').textContent = (counter ? 'Counter-offer to ' : 'Propose a trade with ') + (partner.display_name || 'Member');
  $('#compose-note').value = counter ? (counter.note || '') : '';
  $('#compose-send').textContent = counter ? 'Send counter-offer' : 'Send proposal';
  $('#compose-status').textContent = '';
  showPage('compose');
  try {
    // My cards across all my binders, minus copies already promised in my open trades.
    const { data: myCards, error } = await sb.from('binder_cards')
      .select('*').eq('owner_id', state.user.id).order('name', { ascending: true });
    if (error) throw error;
    const reserved = {};
    const { data: myOpen } = await sb.from('trades').select('id')
      .eq('status', 'open')
      .or('proposer_id.eq.' + state.user.id + ',partner_id.eq.' + state.user.id);
    const openForReserved = (myOpen || []).filter(t => !counter || t.id !== counter.tradeId);
    if (openForReserved.length) {
      const { data: promised } = await sb.from('trade_items')
        .select('binder_card_id, quantity').eq('side', state.user.id)
        .in('trade_id', openForReserved.map(t => t.id));
      (promised || []).forEach(p => {
        if (p.binder_card_id) reserved[p.binder_card_id] = (reserved[p.binder_card_id] || 0) + (p.quantity || 1);
      });
    }
    state.compose.myCards = (myCards || []).map(c => Object.assign({}, c, {
      available: Math.max(0, (c.quantity || 1) - (reserved[c.id] || 0))
    })).filter(c => c.available > 0);

    // Their cards: only what I can see — their public binders.
    const { data: theirBinders } = await sb.from('binders')
      .select('id').eq('owner_id', partner.id).eq('is_public', true);
    state.compose.theirBinderIds = (theirBinders || []).map(b => b.id);
    if (state.compose.theirBinderIds.length) {
      const { data: theirCards } = await sb.from('binder_cards')
        .select('*').in('binder_id', state.compose.theirBinderIds).order('name', { ascending: true });
      state.compose.theirCards = (theirCards || []).map(c => Object.assign({}, c, { available: c.quantity || 1 }));
    }
    if (counter) {
      // Prefill both sides from the original trade. Cards that aren't in the
      // loaded lists (e.g. their binder isn't public) are synthesized from
      // the trade's own snapshots so the offer can be edited as-is.
      (counter.items || []).forEach(item => {
        if (!item.binder_card_id) return;
        const mine = item.side === state.user.id;
        const list = mine ? state.compose.myCards : state.compose.theirCards;
        let row = list.find(x => x.id === item.binder_card_id);
        if (!row) {
          row = {
            id: item.binder_card_id, binder_id: null, owner_id: item.side,
            scryfall_id: item.scryfall_id, name: item.name, printed_name: item.printed_name,
            set_code: item.set_code, set_name: item.set_name, collector_number: item.collector_number,
            lang: item.lang || 'en', is_foil: !!item.is_foil, rarity: item.rarity,
            type_line: item.type_line, image_uri: item.image_uri,
            unit_price: item.unit_price, price_source: item.price_source,
            available: item.quantity || 1
          };
          list.push(row);
        }
        const qty = Math.max(0, Math.min(item.quantity || 1, row.available || 0));
        if (qty > 0) (mine ? state.compose.give : state.compose.get).set(item.binder_card_id, qty);
      });
    }
    renderComposeLists();
  } catch (err) {
    showNotice('Could not open the trade composer: ' + friendlyError(err), 7000);
  }
}

function composePickRow(card, side) {
  const picks = state.compose[side];
  const qty = picks.get(card.id) || 0;
  const row = document.createElement('div');
  row.className = 'pick-item' + (qty > 0 ? ' picked' : '');
  const binderName = side === 'give'
    ? ((state.binders.find(b => b.id === card.binder_id) || {}).name || '')
    : '';
  row.innerHTML =
    (card.image_uri ? '<img src="' + esc(card.image_uri) + '" alt="">' : '') +
    '<span class="grow"><span class="nm">' + esc(card.printed_name && card.lang !== 'en' ? card.printed_name : card.name) + '</span><br>' +
    '<span class="sub">' + esc(card.set_name || '') + (card.collector_number ? ' · #' + esc(card.collector_number) : '') +
      (card.is_foil ? ' · Foil' : '') + (binderName ? ' · ' + esc(binderName) : '') + ' · ' + money(card.unit_price) + ' · ' + card.available + ' available</span></span>' +
    '<span class="qty-row"><button type="button" class="qty-btn" data-d="-1">−</button>' +
    '<span class="qty-num">×' + qty + '</span>' +
    '<button type="button" class="qty-btn" data-d="1">+</button></span>';
  $$('.qty-btn', row).forEach(btn => {
    btn.addEventListener('click', () => {
      const next = Math.min(card.available, Math.max(0, qty + Number(btn.getAttribute('data-d'))));
      if (next <= 0) picks.delete(card.id); else picks.set(card.id, next);
      renderComposeLists();
    });
  });
  return row;
}

function renderComposeLists() {
  if (!state.compose) return;
  const giveQ = String($('#compose-give-search').value || '').toLowerCase();
  const getQ = String($('#compose-get-search').value || '').toLowerCase();
  const giveWrap = $('#compose-give');
  const getWrap = $('#compose-get');
  giveWrap.innerHTML = '';
  getWrap.innerHTML = '';
  state.compose.myCards
    .filter(c => !giveQ || String(c.name).toLowerCase().includes(giveQ))
    .forEach(c => giveWrap.appendChild(composePickRow(c, 'give')));
  if (!giveWrap.children.length) giveWrap.innerHTML = '<p class="muted small">No cards available to offer.</p>';
  state.compose.theirCards
    .filter(c => !getQ || String(c.name).toLowerCase().includes(getQ))
    .forEach(c => getWrap.appendChild(composePickRow(c, 'get')));
  if (!getWrap.children.length) {
    getWrap.innerHTML = '<p class="muted small">' +
      (state.compose.theirBinderIds && state.compose.theirBinderIds.length
        ? 'No cards match.'
        : 'This member has no public binders, so there are no cards to ask for. You can still offer cards one-way.') + '</p>';
  }
  paintComposeBalance();
}

function composeTotals() {
  const sum = (cards, picks) => {
    let total = 0, count = 0;
    picks.forEach((qty, id) => {
      const c = cards.find(x => x.id === id);
      if (c) { total += (Number(c.unit_price) || 0) * qty; count += qty; }
    });
    return { total: total, count: count };
  };
  return {
    give: sum(state.compose.myCards, state.compose.give),
    get: sum(state.compose.theirCards, state.compose.get)
  };
}

function paintComposeBalance() {
  const t = composeTotals();
  const gap = t.get.total - t.give.total;
  let text = 'You give ' + t.give.count + ' cards (' + money(t.give.total) + ') · You get ' +
    t.get.count + ' cards (' + money(t.get.total) + ')';
  if (t.give.count || t.get.count) {
    if (Math.abs(gap) < 0.005) text += ' · Perfectly even';
    else if (gap > 0) text += ' · ' + money(gap) + ' in your favour';
    else text += ' · ' + money(-gap) + ' in their favour';
  }
  $('#compose-balance').textContent = text;
}

function tradeItemSnapshot(card, qty, sideOwner) {
  return {
    side: sideOwner,
    binder_card_id: card.id,
    scryfall_id: card.scryfall_id,
    name: card.name,
    printed_name: card.printed_name || null,
    set_code: card.set_code || null,
    set_name: card.set_name || null,
    collector_number: card.collector_number || null,
    lang: card.lang || 'en',
    is_foil: !!card.is_foil,
    quantity: qty,
    unit_price: card.unit_price != null ? card.unit_price : null,
    price_source: card.price_source || null,
    image_uri: card.image_uri || null,
    rarity: card.rarity || null,
    type_line: card.type_line || null
  };
}

async function sendProposal() {
  const c = state.compose;
  if (!c) return;
  const t = composeTotals();
  if (!t.give.count && !t.get.count) {
    $('#compose-status').textContent = 'Pick at least one card on either side first.';
    return;
  }
  $('#compose-status').textContent = 'Sending…';
  try {
    const { data: trade, error } = await sb.from('trades')
      .insert({ proposer_id: state.user.id, partner_id: c.partner.id, note: $('#compose-note').value.trim() })
      .select().single();
    if (error) throw error;
    const items = [];
    c.give.forEach((qty, id) => {
      const card = c.myCards.find(x => x.id === id);
      if (card) items.push(Object.assign({ trade_id: trade.id }, tradeItemSnapshot(card, qty, state.user.id)));
    });
    c.get.forEach((qty, id) => {
      const card = c.theirCards.find(x => x.id === id);
      if (card) items.push(Object.assign({ trade_id: trade.id }, tradeItemSnapshot(card, qty, c.partner.id)));
    });
    const { error: iErr } = await sb.from('trade_items').insert(items);
    if (iErr) {
      await sb.from('trades').delete().eq('id', trade.id);
      throw iErr;
    }
    if (c.counterOf) {
      // The counter supersedes the original trade (Phase 6).
      await sb.from('trades')
        .update({ status: 'countered', closed_at: new Date().toISOString() })
        .eq('id', c.counterOf);
      showNotice('Counter-offer sent to ' + (c.partner.display_name || 'them') + ' — your edited trade is now waiting on them.');
    } else {
      showNotice('Trade proposal sent to ' + (c.partner.display_name || 'them') + '.');
    }
    state.compose = null;
    await loadTrades();
    showPage('trades');
  } catch (err) {
    $('#compose-status').textContent = 'Could not send: ' + friendlyError(err);
  }
}

/* ---- spares & wants ---- */
async function loadSpares() {
  $('#spares-loading').hidden = false;
  $('#spares-error').hidden = true;
  try {
    await ensureProfiles();
    await loadMyWants();
    const aim = $('#spares-aim');
    if (aim.options.length <= 1) {
      (state.allMembers || []).filter(p => p.id !== state.user.id).forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.display_name || 'Member';
        aim.appendChild(opt);
      });
    }
    await renderMySpares();
    renderMyWants();
  } catch (err) {
    const e = $('#spares-error');
    e.textContent = 'Could not load spares: ' + friendlyError(err);
    e.hidden = false;
  } finally {
    $('#spares-loading').hidden = true;
  }
}

async function renderMySpares() {
  const wrap = $('#my-spares');
  wrap.innerHTML = '';
  const main = state.binders.find(b => b.is_main);
  let spares = [];
  if (main) {
    const { data } = await sb.from('binder_cards')
      .select('*').eq('binder_id', main.id).gt('quantity', 1).order('name', { ascending: true });
    spares = data || [];
  }
  let aimWants = [];
  const aimId = $('#spares-aim').value;
  if (aimId) {
    const { data } = await sb.from('wants').select('*').eq('owner_id', aimId);
    aimWants = data || [];
  }
  const aimName = aimId ? ((profileById(aimId) || {}).display_name || 'them') : '';
  const scored = spares.map(c => ({ card: c, wanted: aimWants.some(w => wantMatchesCard(w, c)) }));
  scored.sort((a, b2) => (b2.wanted ? 1 : 0) - (a.wanted ? 1 : 0));
  scored.forEach(({ card: c, wanted }) => {
    const row = document.createElement('div');
    row.className = 'mini-row';
    row.innerHTML =
      (c.image_uri ? '<img src="' + esc(c.image_uri) + '" alt="">' : '') +
      '<span class="grow"><span class="nm">' + (wanted ? '<span class="flag-want">★ Wanted by ' + esc(aimName) + ' — </span>' : '') +
        esc(c.printed_name && c.lang !== 'en' ? c.printed_name : c.name) + '</span><br>' +
      '<span class="sub">' + esc(c.set_name || '') + (c.collector_number ? ' · #' + esc(c.collector_number) : '') + (c.is_foil ? ' · Foil' : '') + '</span></span>' +
      '<span class="sub">' + (c.quantity - 1) + ' spare · ' + money(c.unit_price) + ' ea</span>';
    wrap.appendChild(row);
  });
  $('#spares-empty').hidden = spares.length > 0;
}

function renderMyWants() {
  const wrap = $('#my-wants');
  wrap.innerHTML = '';
  (state.myWants || []).forEach(w => {
    const row = document.createElement('div');
    row.className = 'mini-row';
    row.innerHTML =
      (w.image_uri ? '<img src="' + esc(w.image_uri) + '" alt="">' : '') +
      '<span class="grow"><span class="nm">' + esc(w.name) + '</span><br>' +
      '<span class="sub">' + esc(w.set_name || '') + (w.collector_number ? ' · #' + esc(w.collector_number) : '') +
      (w.is_foil === true ? ' · Foil' : w.is_foil === false ? ' · Non-foil' : ' · Any finish') + '</span></span>' +
      '<button type="button" class="btn btn-ghost">Remove</button>';
    $('button', row).addEventListener('click', async () => {
      const { error } = await sb.from('wants').delete().eq('id', w.id);
      if (error) { showNotice('Could not remove: ' + friendlyError(error), 6000); return; }
      await loadMyWants();
      renderMyWants();
    });
    wrap.appendChild(row);
  });
  if (!wrap.children.length) {
    wrap.innerHTML = '<p class="muted small">Your want list is empty — search above to add cards you are hunting for.</p>';
  }
}

async function searchWants(ev) {
  ev.preventDefault();
  const q = $('#want-search-input').value.trim();
  const box = $('#want-search-results');
  const status = $('#want-search-status');
  if (!q) return;
  status.textContent = 'Searching Scryfall…';
  box.innerHTML = '';
  try {
    const res = await fetch('https://api.scryfall.com/cards/search?unique=prints&order=name&q=' + encodeURIComponent(q),
      { headers: { 'Accept': 'application/json' } });
    if (res.status === 404) { status.textContent = 'No cards matched that search.'; return; }
    if (!res.ok) throw new Error('Scryfall returned ' + res.status);
    const json = await res.json();
    const results = (json.data || []).slice(0, 20);
    status.textContent = results.length ? 'Tap ＋ Want to add a printing to your list.' : 'No cards matched that search.';
    results.forEach(card => {
      const row = document.createElement('div');
      row.className = 'mini-row';
      const img = scryImage(card);
      row.innerHTML =
        (img ? '<img src="' + esc(img) + '" alt="">' : '') +
        '<span class="grow"><span class="nm">' + esc(card.name) + '</span><br>' +
        '<span class="sub">' + esc(card.set_name || '') + ' · #' + esc(card.collector_number || '') + '</span></span>' +
        '<button type="button" class="btn btn-accent">＋ Want</button>';
      $('button', row).addEventListener('click', async () => {
        const { error } = await sb.from('wants').insert({
          owner_id: state.user.id,
          scryfall_id: card.id,
          name: card.name,
          printed_name: card.printed_name || null,
          set_code: card.set || null,
          set_name: card.set_name || null,
          collector_number: card.collector_number || null,
          lang: card.lang || 'en',
          is_foil: null,
          image_uri: scryImage(card)
        });
        if (error) { showNotice('Could not add want: ' + friendlyError(error), 6000); return; }
        showNotice('Added to your want list: ' + card.name);
        await loadMyWants();
        renderMyWants();
      });
      box.appendChild(row);
    });
  } catch (err) {
    status.textContent = 'Search failed: ' + friendlyError(err);
  }
}

/* ---------------- Phase 4: decks ---------------- */
async function loadDecks() {
  $('#decks-loading').hidden = false;
  $('#decks-error').hidden = true;
  try {
    const { data: decks, error } = await sb.from('decks')
      .select('*').eq('owner_id', state.user.id).order('created_at', { ascending: true });
    if (error) throw error;
    state.decks = decks || [];
    const stats = {};
    if (state.decks.length) {
      const { data: dcards } = await sb.from('deck_cards')
        .select('deck_id, quantity, unit_price').eq('owner_id', state.user.id);
      (dcards || []).forEach(c => {
        const s = stats[c.deck_id] || (stats[c.deck_id] = { qty: 0, distinct: 0, value: 0 });
        s.qty += c.quantity || 1; s.distinct += 1;
        s.value += (Number(c.unit_price) || 0) * (c.quantity || 1);
      });
    }
    const wrap = $('#deck-list');
    wrap.innerHTML = '';
    state.decks.forEach(d => {
      const s = stats[d.id] || { qty: 0, distinct: 0, value: 0 };
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'binder-card';
      btn.innerHTML = '<h3>' + esc(d.name) +
        (d.is_public ? ' <span class="badge badge-public">Public</span>' : ' <span class="badge">Private</span>') + '</h3>' +
        (d.format ? '<p class="stats">' + esc(d.format) + '</p>' : '') +
        '<p class="stats">' + s.distinct + ' distinct · ' + s.qty + ' cards</p>' +
        '<p class="value">' + money(s.value) + '</p>';
      btn.addEventListener('click', () => openDeck(d, false));
      wrap.appendChild(btn);
    });
    $('#decks-empty').hidden = state.decks.length > 0;
  } catch (err) {
    const e = $('#decks-error');
    e.textContent = 'Could not load decks: ' + friendlyError(err);
    e.hidden = false;
  } finally {
    $('#decks-loading').hidden = true;
  }
}

function openDeckDialog(deck) {
  state.editingDeckId = deck ? deck.id : null;
  $('#deck-dialog-title').textContent = deck ? 'Edit deck' : 'New deck';
  $('#deckf-name').value = deck ? deck.name : '';
  $('#deckf-format').value = deck ? (deck.format || '') : '';
  $('#deckf-notes').value = deck ? (deck.notes || '') : '';
  $('#deckf-public').checked = deck ? !!deck.is_public : false;
  $('#deck-form-error').hidden = true;
  $('#deck-dialog').showModal();
}

async function saveDeck(ev) {
  ev.preventDefault();
  const payload = {
    name: $('#deckf-name').value.trim(),
    format: $('#deckf-format').value.trim(),
    notes: $('#deckf-notes').value.trim(),
    is_public: $('#deckf-public').checked
  };
  if (!payload.name) return;
  try {
    if (state.editingDeckId) {
      const { error } = await sb.from('decks').update(payload).eq('id', state.editingDeckId);
      if (error) throw error;
      if (state.currentDeck && state.currentDeck.id === state.editingDeckId) {
        Object.assign(state.currentDeck, payload);
        // A-8 (v15): repaint from the loaded cards — painting an empty
        // totals object here rendered "undefined cards · $NaN" until
        // the deck was re-opened.
        renderDeck();
      }
      showNotice('Deck updated');
    } else {
      const { error } = await sb.from('decks')
        .insert(Object.assign({ owner_id: state.user.id }, payload));
      if (error) throw error;
      showNotice('Deck created');
    }
    $('#deck-dialog').close();
    await loadDecks();
  } catch (err) {
    const e = $('#deck-form-error');
    e.textContent = 'Could not save: ' + friendlyError(err);
    e.hidden = false;
  }
}

async function deleteCurrentDeck() {
  const d = state.currentDeck;
  if (!d || state.deckReadonly) return;
  if (!window.confirm('Delete deck "' + d.name + '"? The deck list goes away; your cards stay in your binders.')) return;
  try {
    const { error } = await sb.from('decks').delete().eq('id', d.id);
    if (error) throw error;
    showNotice('Deck deleted');
    state.currentDeck = null;
    await loadDecks();
    showPage('decks');
  } catch (err) {
    showNotice('Could not delete: ' + friendlyError(err), 6000);
  }
}

function openDeck(deck, readonly) {
  state.currentDeck = deck;
  state.deckReadonly = !!readonly;
  state.deckBack = readonly ? 'member' : 'decks';
  $('#deck-owner-actions').hidden = !!readonly;
  $('#deck-add-box').hidden = !!readonly;
  $('#deck-search-results').innerHTML = '';
  $('#deck-search-status').textContent = '';
  showPage('deck');
  loadDeckCards();
}

async function myOwnedMap() {
  const { data } = await sb.from('binder_cards')
    .select('scryfall_id, is_foil, quantity').eq('owner_id', state.user.id);
  const map = {};
  (data || []).forEach(c => {
    const key = c.scryfall_id + '|' + (c.is_foil ? 'f' : 'n');
    map[key] = (map[key] || 0) + (c.quantity || 1);
  });
  return map;
}

async function livePricesFor(ids) {
  const map = {};
  const unique = Array.from(new Set(ids));
  for (let i = 0; i < unique.length; i += 75) {
    const chunk = unique.slice(i, i + 75);
    try {
      const res = await fetch('https://api.scryfall.com/cards/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ identifiers: chunk.map(id => ({ id: id })) })
      });
      if (!res.ok) continue;
      const json = await res.json();
      (json.data || []).forEach(c => { map[c.id] = c.prices || {}; });
    } catch (e) { /* fall back to snapshot prices */ }
  }
  return map;
}

function deckCardPrice(c, live) {
  const p = live && live[c.scryfall_id];
  if (p) {
    const v = c.is_foil ? (p.usd_foil != null ? p.usd_foil : p.usd) : p.usd;
    if (v != null) return Number(v);
  }
  return Number(c.unit_price) || 0;
}

async function loadDeckCards() {
  const d = state.currentDeck;
  if (!d) return;
  $('#deck-loading').hidden = false;
  $('#deck-error').hidden = true;
  try {
    const { data, error } = await sb.from('deck_cards')
      .select('*').eq('deck_id', d.id)
      .order('board', { ascending: true }).order('name', { ascending: true });
    if (error) throw error;
    state.deckCards = data || [];
    state.deckOwned = await myOwnedMap();
    state.deckLive = await livePricesFor(state.deckCards.map(c => c.scryfall_id));
    renderDeck();
  } catch (err) {
    const e = $('#deck-error');
    e.textContent = 'Could not load this deck: ' + friendlyError(err);
    e.hidden = false;
  } finally {
    $('#deck-loading').hidden = true;
  }
}

function paintDeckHead(totals) {
  const d = state.currentDeck;
  if (!d) return;
  $('#deck-title').innerHTML = esc(d.name) +
    (d.format ? ' <span class="chip">' + esc(d.format) + '</span>' : '') +
    (d.is_public ? ' <span class="badge badge-public">Public</span>' : ' <span class="badge">Private</span>');
  $('#deck-notes').textContent = d.notes || '';
  $('#deck-meta').textContent =
    totals.count + ' cards · ' + totals.distinct + ' distinct · Full deck cost ' + money(totals.full) +
    ' · ' + (state.deckReadonly ? "You'd still need " : 'Still need ') + money(totals.need);
}

function renderDeck() {
  const d = state.currentDeck;
  const live = state.deckLive || {};
  const owned = state.deckOwned || {};
  let full = 0, need = 0, count = 0;
  state.deckCards.forEach(c => {
    const price = deckCardPrice(c, live);
    const qty = c.quantity || 1;
    const have = owned[c.scryfall_id + '|' + (c.is_foil ? 'f' : 'n')] || 0;
    full += price * qty;
    need += price * Math.max(0, qty - have);
    count += qty;
  });
  paintDeckHead({ full: full, need: need, count: count, distinct: state.deckCards.length });

  const wrap = $('#deck-boards');
  wrap.innerHTML = '';
  [['commander', 'Commander'], ['main', 'Main deck'], ['sideboard', 'Sideboard']].forEach(([board, label]) => {
    const cards = state.deckCards.filter(c => c.board === board);
    if (!cards.length) return;
    const h = document.createElement('h3');
    h.className = 'family-title';
    const boardCount = cards.reduce((s, c) => s + (c.quantity || 1), 0);
    h.textContent = label + ' (' + boardCount + ')';
    wrap.appendChild(h);
    const list = document.createElement('div');
    list.className = 'mini-list';
    cards.forEach(c => list.appendChild(deckCardRow(c, live, owned)));
    wrap.appendChild(list);
  });
  if (!state.deckCards.length) {
    wrap.innerHTML = '<p class="empty">No cards in this deck yet.' + (state.deckReadonly ? '' : ' Add some with the search above, or import a list.') + '</p>';
  }
}

function deckCardRow(c, live, owned) {
  const price = deckCardPrice(c, live);
  const qty = c.quantity || 1;
  const have = owned[c.scryfall_id + '|' + (c.is_foil ? 'f' : 'n')] || 0;
  const missing = Math.max(0, qty - have);
  const ownLine = have >= qty
    ? '<span style="color:var(--ok);">In your binders (' + have + ')</span>'
    : have > 0
      ? 'Own ' + have + ' · need ' + missing + ' more'
      : 'Not owned · need ' + missing;
  const row = document.createElement('div');
  row.className = 'mini-row';
  let controls;
  if (state.deckReadonly) {
    controls = '<span class="qty-num">×' + qty + '</span>';
  } else {
    controls = '<span class="qty-row">' +
      '<button type="button" class="qty-btn" data-d="-1">−</button>' +
      '<span class="qty-num">×' + qty + '</span>' +
      '<button type="button" class="qty-btn" data-d="1">+</button></span>' +
      '<button type="button" class="btn btn-ghost" data-rm="1">Remove</button>';
  }
  row.innerHTML =
    (c.image_uri ? '<img src="' + esc(c.image_uri) + '" alt="">' : '') +
    '<span class="grow"><span class="nm">' + esc(c.printed_name && c.lang !== 'en' ? c.printed_name : c.name) + '</span><br>' +
    '<span class="sub">' + esc(c.set_name || '') + (c.collector_number ? ' · #' + esc(c.collector_number) : '') +
      (c.is_foil ? ' · Foil' : '') + ' · ' + money(price) + ' ea · ' + ownLine + '</span></span>' + controls;
  if (!state.deckReadonly) {
    $$('.qty-btn', row).forEach(btn => {
      btn.addEventListener('click', () => changeDeckQty(c, Number(btn.getAttribute('data-d'))));
    });
    $('[data-rm]', row).addEventListener('click', () => removeDeckCard(c));
  }
  return row;
}

async function changeDeckQty(c, delta) {
  const next = (c.quantity || 1) + delta;
  try {
    if (next <= 0) {
      const { error } = await sb.from('deck_cards').delete().eq('id', c.id);
      if (error) throw error;
    } else {
      const { error } = await sb.from('deck_cards').update({ quantity: next }).eq('id', c.id);
      if (error) throw error;
    }
    await loadDeckCards();
  } catch (err) {
    showNotice('Could not update: ' + friendlyError(err), 6000);
  }
}

async function removeDeckCard(c) {
  try {
    const { error } = await sb.from('deck_cards').delete().eq('id', c.id);
    if (error) throw error;
    await loadDeckCards();
  } catch (err) {
    showNotice('Could not remove: ' + friendlyError(err), 6000);
  }
}

function deckSnapshotFromScryfall(card, isFoil) {
  const prices = card.prices || {};
  return {
    scryfall_id: card.id,
    name: card.name,
    printed_name: card.printed_name || null,
    set_code: card.set || null,
    set_name: card.set_name || null,
    collector_number: card.collector_number || null,
    lang: card.lang || 'en',
    is_foil: !!isFoil,
    unit_price: (isFoil ? prices.usd_foil : prices.usd) != null
      ? Number(isFoil ? prices.usd_foil : prices.usd) : null,
    price_source: 'Scryfall',
    image_uri: scryImage(card),
    rarity: card.rarity || null,
    type_line: card.type_line || null
  };
}

async function addDeckSnapshot(snap, board, qty) {
  const d = state.currentDeck;
  const { error } = await sb.from('deck_cards').insert(Object.assign(
    { deck_id: d.id, owner_id: state.user.id, board: board, quantity: qty || 1 }, snap));
  if (error) {
    // Already in the deck on that board: just add the copies.
    if (error.code === '23505' || /duplicate|unique/i.test(error.message || '')) {
      const { data: existing } = await sb.from('deck_cards')
        .select('*').eq('deck_id', d.id).eq('scryfall_id', snap.scryfall_id)
        .eq('is_foil', snap.is_foil).eq('board', board).single();
      if (existing) {
        const { error: uErr } = await sb.from('deck_cards')
          .update({ quantity: (existing.quantity || 1) + (qty || 1) }).eq('id', existing.id);
        if (uErr) throw uErr;
        return;
      }
    }
    throw error;
  }
}

async function searchDeckCards(ev) {
  ev.preventDefault();
  const q = $('#deck-search-input').value.trim();
  const box = $('#deck-search-results');
  const status = $('#deck-search-status');
  if (!q) return;
  status.textContent = 'Searching Scryfall…';
  box.innerHTML = '';
  try {
    const res = await fetch('https://api.scryfall.com/cards/search?unique=prints&order=name&q=' + encodeURIComponent(q),
      { headers: { 'Accept': 'application/json' } });
    if (res.status === 404) { status.textContent = 'No cards matched that search.'; return; }
    if (!res.ok) throw new Error('Scryfall returned ' + res.status);
    const json = await res.json();
    const results = (json.data || []).slice(0, 20);
    status.textContent = results.length ? 'Pick a board and finish, then Add.' : 'No cards matched that search.';
    results.forEach(card => {
      const row = document.createElement('div');
      row.className = 'mini-row';
      const img = scryImage(card);
      // A-11 (v15): offer only the finishes this printing actually has,
      // built from card.finishes like the binder panel — a foil-only
      // printing gets foil alone (locked in), a nonfoil-only printing
      // gets no foil option, both finishes keep the normal choice.
      const finishes = card.finishes || ['nonfoil'];
      const canFoil = finishes.includes('foil') || finishes.includes('etched');
      const canNonfoil = finishes.includes('nonfoil');
      const defaultFoil = canFoil && !canNonfoil;
      row.innerHTML =
        (img ? '<img src="' + esc(img) + '" alt="">' : '') +
        '<span class="grow"><span class="nm">' + esc(card.name) + '</span><br>' +
        '<span class="sub">' + esc(card.set_name || '') + ' · #' + esc(card.collector_number || '') + '</span></span>' +
        '<select class="deck-add-board"><option value="main">Main</option><option value="commander">Commander</option><option value="sideboard">Sideboard</option></select>' +
        '<select class="deck-add-finish">' +
          (canNonfoil ? '<option value="n"' + (!defaultFoil ? ' selected' : '') + '>Non-foil</option>' : '') +
          (canFoil ? '<option value="f"' + (defaultFoil ? ' selected' : '') + '>Foil</option>' : '') +
        '</select>' +
        (canFoil && canNonfoil ? '' : '<span class="sub">' + (defaultFoil ? 'Foil only' : 'Non-foil only') + '</span>') +
        '<button type="button" class="btn btn-accent">Add</button>';
      $('button', row).addEventListener('click', async () => {
        try {
          const board = $('.deck-add-board', row).value;
          const isFoil = $('.deck-add-finish', row).value === 'f';
          await addDeckSnapshot(deckSnapshotFromScryfall(card, isFoil), board, 1);
          showNotice('Added to deck: ' + card.name);
          await loadDeckCards();
        } catch (err) {
          showNotice('Could not add: ' + friendlyError(err), 6000);
        }
      });
      box.appendChild(row);
    });
  } catch (err) {
    status.textContent = 'Search failed: ' + friendlyError(err);
  }
}

function parseDecklist(text) {
  const entries = [];
  let board = 'main';
  String(text || '').split(/\r?\n/).forEach(raw => {
    let line = raw.trim();
    if (!line) return;
    if (/^commander\b/i.test(line)) { board = 'commander'; line = line.replace(/^commander\s*:?\s*/i, ''); if (!line) return; }
    else if (/^sideboard\b/i.test(line)) { board = 'sideboard'; line = line.replace(/^sideboard\s*:?\s*/i, ''); if (!line) return; }
    else if (/^deck\b/i.test(line) || /^mainboard\b/i.test(line)) { board = 'main'; line = line.replace(/^(deck|mainboard)\s*:?\s*/i, ''); if (!line) return; }
    let thisBoard = board;
    if (/^sb\s*:/i.test(line)) { thisBoard = 'sideboard'; line = line.replace(/^sb\s*:\s*/i, ''); }
    let qty = 1;
    const qm = line.match(/^(\d+)\s*[xX]?\s+/);
    if (qm) { qty = parseInt(qm[1], 10) || 1; line = line.slice(qm[0].length); }
    // Strip trailing (SET) 123 collector info and foil markers.
    line = line.replace(/\s*\([A-Za-z0-9]{2,6}\)\s*[A-Za-z0-9★*-]*\s*$/, '').replace(/\s*\*F\*\s*$/i, '').trim();
    if (line) entries.push({ qty: qty, name: line, board: thisBoard });
  });
  return entries;
}

async function importDecklist() {
  const d = state.currentDeck;
  if (!d) return;
  const entries = parseDecklist($('#import-text').value);
  const status = $('#import-status');
  if (!entries.length) { status.textContent = 'Nothing to import — paste a decklist first.'; return; }
  status.textContent = 'Importing…';
  const cache = {};
  let added = 0;
  const failed = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    status.textContent = 'Importing ' + (i + 1) + ' of ' + entries.length + ' — ' + e.name;
    try {
      const key = e.name.toLowerCase();
      if (!cache[key]) {
        const res = await fetch('https://api.scryfall.com/cards/search?unique=prints&order=usd&order_direction=asc&q=' +
          encodeURIComponent('!"' + e.name.replace(/"/g, '') + '"'), { headers: { 'Accept': 'application/json' } });
        if (!res.ok) throw new Error('not found');
        const json = await res.json();
        const first = (json.data || [])[0];
        if (!first) throw new Error('not found');
        cache[key] = first;
      }
      await addDeckSnapshot(deckSnapshotFromScryfall(cache[key], false), e.board, e.qty);
      added++;
    } catch (err) {
      failed.push(e.name);
    }
  }
  status.textContent = 'Imported ' + added + ' of ' + entries.length + ' lines.' +
    (failed.length ? ' Could not match: ' + failed.join(', ') : '');
  if (added) {
    showNotice('Decklist imported — ' + added + ' lines added');
    await loadDeckCards();
  }
}

/* ---------------- event wiring ---------------- */
/* ---------------- scanner — fully on-device ----------------
   Identification never leaves the phone and never calls a website:
   camera frames and photos are hashed locally (fingerprint.js, the
   Phase 7a-validated port of the pack builder) and matched against
   fingerprint-pack.bin + fingerprint-meta.json on this device.
   - Live scan: point the camera at ONE card. Each hash comes from a
     burst of 3 consecutive guide-crop frames pixel-averaged together
     (temporal denoise — per-frame sensor grain cancels in the
     average). A printing is presented only when it is the UNIQUE
     best match, wins a 3-of-5 multi-frame consensus, and holds a
     3-sample stability streak — or when the member taps a candidate.
   - Photo: one card per photo; the same hash + pack scan on a still.
   A presented match is filed straight from its panel (finish, qty,
   binder) — no review flow, nothing uploaded. Prices arrive from
   the nightly refresh; filing never waits on a live source. Foil is
   invisible to fingerprints, so the finish pick stays manual (the
   pack meta carries no finish list, so both finishes are offered).
   Card art is display only: Scryfall's CDN serves every printing's
   image at a deterministic id-based address — the same URLs the
   rest of the app stores as image_uri. */

const FP_STRONG_D = 10;
const FP_WEAK_D = 26;
const FP_SAMPLE_MS = 300;
const FP_BURST = 3;          // frames averaged into one hash

// Match-strength wording (v15, finalize Q3): members decide from a
// word, not a raw Hamming distance — Strong / Close / Weak mapped
// from the same thresholds the presentation logic already uses, with
// the number kept alongside in small print. The tie line mirrors the
// Muse app's honesty rule: when printings tie at the best distance,
// say so and let the member pick — never declare a winner.
function fpStrengthWord(d) {
  if (d <= FP_STRONG_D) return 'Strong';
  if (d <= FP_WEAK_D) return 'Close';
  return 'Weak';
}
function fpTieLine(source, d) {
  const n = source === 'live' ? live.tieCount : photoTieCount;
  const td = source === 'live' ? live.tieD : photoTieD;
  if (!n || n < 2 || td !== d) return '';
  return n + ' printings tie at distance ' + td + ' — pick the one that matches';
}

const live = {
  pack: null, packPromise: null,      // { view, count, meta } once loaded
  stream: null, timer: null,
  busy: false,
  canvas: null,
  burst: null,                        // { sum: Float32Array, n, w }
  recent: [],                         // last ≤5 samples' best printing ids
  stableId: '', stableN: 0,           // stability streak
  suppressId: '',                     // presented printing, until it leaves the frame
  candidates: [],                     // latest top matches [{ i, d }]
  tieCount: 0, tieD: 0,               // printings tied at the best distance (whole pack)
  torchOn: false
};

let photoCandidates = [];             // photo path's latest top matches
let photoTieCount = 0, photoTieD = 0; // printings tied at the best distance (whole pack)
// The one presentation on screen (from either source), or null:
// { source: 'live' | 'photo', i, d, filed }
let fpPresent = null;

function liveSetStatus(msg) {
  const el = $('#live-status');
  if (el) el.textContent = msg || '';
}

function photoSetStatus(msg) {
  const el = $('#photo-status');
  if (!el) return;
  el.hidden = !msg;
  el.textContent = msg || '';
}

function fpImageUri(id) {
  return 'https://cards.scryfall.io/normal/front/' + id.charAt(0) + '/' + id.charAt(1) + '/' + id + '.jpg';
}

// Streamed fetch with progress where the browser supports it (the pack is
// ~15 MB once; the service worker keeps it cached after the first load).
async function fetchPackFile(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not download the card library (' + res.status + ').');
  if (!res.body || !res.body.getReader) return res.arrayBuffer();
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (onProgress && total) onProgress(got / total);
  }
  const buf = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return buf.buffer;
}

async function loadFingerprintPack() {
  if (live.pack) return live.pack;
  if (live.packPromise) return live.packPromise;
  live.packPromise = (async () => {
    liveSetStatus('Preparing card library… one-time ~15 MB download.');
    const binBuf = await fetchPackFile('fingerprint-pack.bin', (f) => {
      liveSetStatus('Preparing card library… ' + Math.round(f * 18) + '% (one-time ~15 MB download)');
    });
    const metaBuf = await fetchPackFile('fingerprint-meta.json', (f) => {
      liveSetStatus('Preparing card library… ' + (18 + Math.round(f * 82)) + '% (one-time ~15 MB download)');
    });
    const meta = JSON.parse(new TextDecoder().decode(metaBuf));
    const view = new DataView(binBuf);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    const count = view.getUint32(8, true);
    if (magic !== 'SBPK' || count !== meta.length) {
      throw new Error('The card library looks damaged — reload the page to fetch a clean copy.');
    }
    live.pack = { view, count, meta };
    return live.pack;
  })();
  try { return await live.packPromise; }
  catch (e) { live.packPromise = null; throw e; }
}

const FP_PCT = (() => {
  const t = new Uint8Array(256);
  for (let i = 1; i < 256; i++) t[i] = t[i >> 1] + (i & 1);
  return t;
})();
function fpPopcount(x) {
  return FP_PCT[x & 255] + FP_PCT[(x >>> 8) & 255] + FP_PCT[(x >>> 16) & 255] + FP_PCT[x >>> 24];
}

// Top-k matches for a query hash, ascending by Hamming distance, plus
// the number of printings tied at the best distance across the whole
// pack. A linear scan of all 120,045 entries measured ~5 ms in
// validation — no index structure needed.
function fpSearch(hi, lo, k) {
  const { view, count } = live.pack;
  const top = [];
  let bestD = Infinity, tieCount = 0;
  for (let i = 0; i < count; i++) {
    const off = 12 + i * 24 + 16;
    const d = fpPopcount((view.getUint32(off, false) ^ hi) >>> 0) +
              fpPopcount((view.getUint32(off + 4, false) ^ lo) >>> 0);
    if (d < bestD) { bestD = d; tieCount = 1; }
    else if (d === bestD) tieCount++;
    if (top.length < k || d < top[top.length - 1].d) {
      top.push({ i, d });
      top.sort((a, b) => a.d - b.d);
      if (top.length > k) top.pop();
    }
  }
  return { top, tieCount };
}

// The sampled crop is MEASURED, not assumed (ported from the Muse
// app's field-proven sampler): the guide overlay's real on-screen
// rect is mapped back into the video's own pixels through the
// object-fit: cover transform, so the pixels hashed are exactly the
// ones the member framed — whatever the layout, the stream's
// orientation, or the browser does to the preview. Sampling is at
// the stream's native resolution, never the displayed size. (The
// earlier version computed an idealised guide rect from the stream
// dimensions and downscaled it to a fixed 336px canvas; the hash is
// so sensitive to a few-% window shift that any divergence between
// the assumed rect and the visible guide presented wrong cards.)
function liveGuideCrop(video, guide) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const vr = video.getBoundingClientRect();
  const gr = guide.getBoundingClientRect();
  if (!vr.width || !vr.height || !gr.width || !gr.height) return null;
  const scale = Math.max(vr.width / vw, vr.height / vh);
  const offX = (vr.width - vw * scale) / 2;
  const offY = (vr.height - vh * scale) / 2;
  const sx = Math.max(0, Math.min(vw - 1, (gr.left - vr.left - offX) / scale));
  const sy = Math.max(0, Math.min(vh - 1, (gr.top - vr.top - offY) / scale));
  const sw = Math.max(2, Math.min(vw - sx, gr.width / scale));
  const sh = Math.max(2, Math.min(vh - sy, gr.height / scale));
  return { sx, sy, sw, sh };
}

/* ----- camera opening: primary rear lens, clean 1080p, continuous
   focus/exposure/white-balance where offered. Every capability step
   is feature-detected and failure-proof — a device that exposes less
   silently keeps the plain facingMode behaviour. ----- */
function scannerTrackCaps(track) {
  try {
    if (!track || typeof track.getCapabilities !== 'function') return {};
    return track.getCapabilities() || {};
  } catch (e) { return {}; }
}

function applyContinuousCameraModes(stream) {
  try {
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const caps = scannerTrackCaps(track);
    const advanced = [];
    if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) advanced.push({ focusMode: 'continuous' });
    if (Array.isArray(caps.exposureMode) && caps.exposureMode.includes('continuous')) advanced.push({ exposureMode: 'continuous' });
    if (Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.includes('continuous')) advanced.push({ whiteBalanceMode: 'continuous' });
    if (!advanced.length) return;
    const p = track.applyConstraints({ advanced });
    if (p && p.catch) p.catch(() => { /* a refused mode keeps the plain stream */ });
  } catch (e) { /* capability handling must never break the camera */ }
}

// Labels are only visible after a permission grant and often say
// nothing useful, so this returns a deviceId only on a confident
// pick: exactly one rear camera left after ultra-wide/macro/depth/
// tof/tele lenses are excluded, or one actually labelled main/back.
async function pickMainRearCameraId() {
  try {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') return null;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'videoinput');
    if (!inputs.length) return null;
    if (inputs.length === 1) return inputs[0].deviceId || null;
    if (inputs.every((d) => !d.label)) return null;
    const rear = inputs.filter((d) => !/front|user|face/i.test(d.label));
    if (!rear.length) return null;
    const main = rear.filter((d) => !/ultra|macro|depth|tof|time.of.flight|tele/i.test(d.label));
    if (main.length === 1) return main[0].deviceId || null;
    const labelled = main.find((d) => /main|back|rear|wide/i.test(d.label));
    return (labelled && labelled.deviceId) || null;
  } catch (e) { return null; }
}

async function openScannerCamera() {
  // A clean 1920×1080 stream, as ideals: a device that offers less
  // settles at its own maximum. (Forcing 4K on the Muse app picked
  // noisier sensor modes on multi-lens phones; 1080p is plenty for
  // the guide-sized fingerprint crop.)
  const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  const deviceId = await pickMainRearCameraId();
  if (deviceId) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: Object.assign({ deviceId: { exact: deviceId } }, size), audio: false
      });
      applyContinuousCameraModes(stream);
      return stream;
    } catch (e) { /* the picked lens refused — fall through to facingMode */ }
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: Object.assign({ facingMode: 'environment' }, size), audio: false
    });
    applyContinuousCameraModes(stream);
    return stream;
  } catch (e) {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    applyContinuousCameraModes(stream);
    return stream;
  }
}

// Tap-to-focus: where the track supports points of interest, focus
// on the tapped point (0–1 within the video), preferring single-shot
// when offered. Unsupported: the tap does nothing.
function focusCameraAtPoint(stream, x, y) {
  try {
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const caps = scannerTrackCaps(track);
    if (!('pointsOfInterest' in caps)) return;
    const constraint = {
      pointsOfInterest: [{ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }]
    };
    if (Array.isArray(caps.focusMode) && caps.focusMode.includes('single-shot')) constraint.focusMode = 'single-shot';
    const p = track.applyConstraints({ advanced: [constraint] });
    if (p && p.catch) p.catch(() => { /* refusing a focus point is not an error */ });
  } catch (e) { /* progressive enhancement only */ }
}

async function toggleLiveTorch() {
  const track = live.stream && live.stream.getVideoTracks()[0];
  if (!track) return;
  const next = !live.torchOn;
  try {
    await track.applyConstraints({ advanced: [{ torch: next }] });
    live.torchOn = next;
    const btn = $('#live-torch');
    if (btn) btn.textContent = next ? '🔦 Light on' : '🔦 Light';
  } catch (e) { /* a refused torch leaves the toggle where it was */ }
}

async function startLive() {
  $('#live-panel').hidden = false;
  $('#live-toggle').disabled = true;
  dismissFpPresent('photo');
  if (!window.Fingerprint) {
    liveSetStatus('The fingerprint reader did not load — reload the page, or use Photo below.');
    $('#live-toggle').disabled = false;
    return;
  }
  try {
    await loadFingerprintPack();
  } catch (e) {
    liveSetStatus(e.message || String(e));
    $('#live-toggle').disabled = false;
    return;
  }
  // The member may have tapped away while the library downloaded.
  if ($('#page-lookup').hidden) { $('#live-toggle').disabled = false; return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    liveSetStatus('This browser cannot open the camera here — Photo below still works.');
    $('#live-toggle').disabled = false;
    return;
  }
  let stream;
  try {
    stream = await openScannerCamera();
  } catch (e) {
    liveSetStatus('Camera unavailable — check the camera permission for this site, or use Photo below.');
    $('#live-toggle').disabled = false;
    return;
  }
  // …or while the camera permission was being answered.
  if ($('#page-lookup').hidden) {
    stream.getTracks().forEach(t => t.stop());
    $('#live-toggle').disabled = false;
    return;
  }
  live.stream = stream;
  live.burst = null;
  live.recent = [];
  live.stableId = ''; live.stableN = 0;
  live.suppressId = '';
  live.candidates = [];
  paintFpCandidates('live');
  live.torchOn = false;
  const video = $('#live-video');
  video.srcObject = stream;
  try { await video.play(); } catch (e) { /* muted + playsinline should satisfy autoplay rules */ }
  $('#live-stage').hidden = false;
  $('#live-stop').hidden = false;
  // Torch toggle only when the running track reports the capability.
  const track = stream.getVideoTracks()[0];
  const torchBtn = $('#live-torch');
  if (torchBtn) {
    torchBtn.hidden = !(track && scannerTrackCaps(track).torch === true);
    torchBtn.textContent = '🔦 Light';
  }
  // The guide overlay is pure CSS now (centred, card aspect, 86% of
  // the preview height — the Muse app's layout), and the sampler
  // measures its real on-screen rect on every sample, so there is
  // no guide geometry left to paint or keep in sync here.
  liveSetStatus('Point at one card — hold it in the frame…');
  live.timer = setInterval(sampleLiveFrame, FP_SAMPLE_MS);
}

function stopLive() {
  if (live.timer) { clearInterval(live.timer); live.timer = null; }
  if (live.stream) { live.stream.getTracks().forEach(t => t.stop()); live.stream = null; }
  live.torchOn = false;
  live.burst = null;
  const video = $('#live-video');
  if (video) video.srcObject = null;
  const stage = $('#live-stage'); if (stage) stage.hidden = true;
  const stop = $('#live-stop'); if (stop) stop.hidden = true;
  const torch = $('#live-torch'); if (torch) torch.hidden = true;
  const tog = $('#live-toggle'); if (tog) tog.disabled = false;
  if (fpPresent && fpPresent.source === 'live') dismissFpPresent('live');
  liveSetStatus('');
}

function sampleLiveFrame() {
  if (live.busy || !live.pack || !live.stream) return;
  if (fpPresent && fpPresent.source === 'live') return; // a presentation is up — the sampler idles
  const video = $('#live-video');
  if (!video.videoWidth || video.readyState < 2) return;
  const guide = $('#live-guide');
  if (!guide) return;
  live.busy = true;
  try {
    const crop = liveGuideCrop(video, guide);
    if (!crop) { live.busy = false; return; }
    if (!live.canvas) live.canvas = document.createElement('canvas');
    const c = live.canvas;
    const W = Math.round(crop.sw), H = Math.round(crop.sh);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; live.burst = null; }
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, W, H);
    const img = ctx.getImageData(0, 0, W, H);
    // Temporal denoise: accumulate FP_BURST consecutive crops and
    // hash their pixel average — sensor grain is per-frame noise, so
    // it cancels while the held-still card does not.
    if (!live.burst || live.burst.w !== W || live.burst.h !== H) {
      live.burst = { sum: new Float32Array(img.data.length), n: 0, w: W, h: H };
    }
    const sum = live.burst.sum, px = img.data;
    for (let j = 0; j < px.length; j++) sum[j] += px[j];
    live.burst.n++;
    if (live.burst.n < FP_BURST) { live.busy = false; return; }
    const avg = new Uint8ClampedArray(sum.length);
    for (let j = 0; j < sum.length; j++) avg[j] = sum[j] / live.burst.n;
    live.burst = null;
    const h = window.Fingerprint.hashCardImage(avg, W, H);
    handleLiveSample(fpSearch(h.hi, h.lo, 10));
  } catch (e) { /* one bad frame must never kill the loop */ }
  live.busy = false;
}

// One denoised sample: refresh the candidate picks, run the
// suppression check, the 3-of-5 consensus window, and the stability
// streak. A printing auto-presents only when it is the unique best,
// is the window's consensus winner, and holds the streak — a single
// frame's fluke can no longer present the wrong card.
function handleLiveSample(res) {
  const meta = live.pack.meta;
  const best = res.top[0] || null;
  const bestId = best ? meta[best.i].id : '';
  // A presented/filed printing is suppressed until it leaves the
  // frame (stops being the best match).
  if (live.suppressId && bestId !== live.suppressId) live.suppressId = '';
  live.recent.push(bestId);
  if (live.recent.length > 5) live.recent.shift();
  const counts = {};
  for (const id of live.recent) { if (id) counts[id] = (counts[id] || 0) + 1; }
  let consensusId = '';
  for (const id in counts) { if (counts[id] >= 3) { consensusId = id; break; } }
  if (!best || best.d > FP_WEAK_D) {
    live.stableId = ''; live.stableN = 0;
    live.candidates = [];
    live.tieCount = 0; live.tieD = 0;
    paintFpCandidates('live');
    liveSetStatus('Looking… fill the frame with one card, flat and out of glare.');
    return;
  }
  if (bestId === live.suppressId) {
    live.stableId = ''; live.stableN = 0;
    live.candidates = [];
    live.tieCount = 0; live.tieD = 0;
    paintFpCandidates('live');
    liveSetStatus('Move the card away to scan the next one.');
    return;
  }
  live.candidates = res.top.slice(0, 5);
  live.tieCount = res.tieCount; live.tieD = best.d;
  paintFpCandidates('live');
  if (res.tieCount === 1 && consensusId === bestId) {
    if (live.stableId === bestId) live.stableN++;
    else { live.stableId = bestId; live.stableN = 1; }
    liveSetStatus('Seeing ' + meta[best.i].name + ' — hold steady…');
    if (live.stableN >= 3) {
      live.stableId = ''; live.stableN = 0; live.recent = [];
      presentFpMatch({ i: best.i, d: best.d }, 'live');
    }
  } else {
    live.stableId = ''; live.stableN = 0;
    liveSetStatus('Close match — tap your printing below.');
  }
}

/* ----- candidate picks + the in-panel presentation (both sources) ----- */

function paintFpCandidates(source) {
  const wrap = source === 'live' ? $('#live-candidates') : $('#photo-candidates');
  if (!wrap) return;
  const list = source === 'live' ? live.candidates : photoCandidates;
  const meta = live.pack ? live.pack.meta : [];
  wrap.innerHTML = '';
  list.forEach((entry) => {
    const m = meta[entry.i];
    if (!m) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'search-hit';
    b.innerHTML = '<img src="' + esc(fpImageUri(m.id)) + '" alt="" onerror="this.style.display=\'none\'">' +
      '<span><span class="hit-name">' + esc(m.name) + '</span>' +
      '<span class="hit-sub" style="display:block">' + esc(String(m.set).toUpperCase()) + ' · #' + esc(m.cn) +
      (m.lang && m.lang !== 'en' ? ' · ' + esc(String(m.lang).toUpperCase()) : '') +
      ' · ' + fpStrengthWord(entry.d) + ' match · distance ' + entry.d + '</span></span>';
    b.addEventListener('click', () => presentFpMatch(entry, source));
    wrap.appendChild(b);
  });
  const bestEntry = list[0];
  const tie = bestEntry ? fpTieLine(source, bestEntry.d) : '';
  if (tie) {
    const note = document.createElement('div');
    note.className = 'muted small';
    note.textContent = tie;
    wrap.appendChild(note);
  }
}

async function presentFpMatch(entry, source) {
  const m = live.pack.meta[entry.i];
  fpPresent = { source, i: entry.i, d: entry.d, filed: false };
  // From the camera, a presented printing is suppressed until it
  // leaves the frame — filed or dismissed alike.
  if (source === 'live') live.suppressId = m.id;
  if (!state.binders.length) { try { await loadMyBinders(); } catch (e) { /* the panel explains instead */ } }
  renderFpPresent();
}

function fpPresentWrap() {
  if (!fpPresent) return null;
  return fpPresent.source === 'live' ? $('#live-present') : $('#photo-present');
}

function renderFpPresent() {
  const wrap = fpPresentWrap();
  if (!wrap || !fpPresent) return;
  const m = live.pack.meta[fpPresent.i];
  wrap.hidden = false;
  const binderOpts = state.binders.map((b) =>
    '<option value="' + esc(b.id) + '"' + (b.is_main ? ' selected' : '') + '>' + esc(b.name) + '</option>').join('');
  wrap.innerHTML =
    '<div class="pick-panel">' +
      '<div class="pick-row">' +
        '<img class="fp-art" src="' + esc(fpImageUri(m.id)) + '" alt="" onerror="this.style.display=\'none\'">' +
        '<div>' +
          '<div class="hit-name">' + esc(m.name) + '</div>' +
          '<div class="muted small">' + esc(String(m.set).toUpperCase()) + ' · #' + esc(m.cn) +
            (m.lang && m.lang !== 'en' ? ' · ' + esc(String(m.lang).toUpperCase()) : '') +
            ' · ' + fpStrengthWord(fpPresent.d) + ' match · distance ' + fpPresent.d + '</div>' +
          '<div class="muted small">On-device match — no internet used</div>' +
          (fpTieLine(fpPresent.source, fpPresent.d)
            ? '<div class="muted small">' + esc(fpTieLine(fpPresent.source, fpPresent.d)) + '</div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="row wrap gap" style="margin-top:.6rem">' +
        '<label class="field inline"><span>Finish</span><select data-fp-finish>' +
          '<option value="nonfoil">Non-foil</option><option value="foil">Foil</option>' +
        '</select></label>' +
        '<label class="field inline"><span>Qty</span><input type="number" min="1" max="99" value="1" data-fp-qty style="width:70px"></label>' +
        '<label class="field inline"><span>Binder</span><select data-fp-binder>' + binderOpts + '</select></label>' +
      '</div>' +
      '<p class="muted small" data-fp-hint style="margin:.45rem 0 0"></p>' +
      '<div class="row wrap gap" style="margin-top:.6rem">' +
        (fpPresent.filed
          ? '<span class="saved-note">Filed ✓</span>'
          : '<button type="button" class="btn btn-accent" data-fp-file>File</button>') +
        '<button type="button" class="btn btn-ghost" data-fp-dismiss>Dismiss</button>' +
      '</div>' +
      (state.binders.length ? '' : '<p class="muted small">You have no binder yet — create one on the home page first.</p>') +
      '<p class="error" data-fp-error hidden></p>' +
    '</div>';
  const fileBtn = wrap.querySelector('[data-fp-file]');
  if (fileBtn) fileBtn.addEventListener('click', fileFpMatch);
  wrap.querySelector('[data-fp-dismiss]').addEventListener('click', () => dismissFpPresent(fpPresent.source));
  // A-21 hint (v15): signpost what the chosen binder means for Spares.
  const fpBinderSel = wrap.querySelector('[data-fp-binder]');
  const fpHintEl = wrap.querySelector('[data-fp-hint]');
  const paintFpHint = () => {
    if (!fpBinderSel || !fpHintEl) return;
    const chosen = state.binders.find((b) => b.id === fpBinderSel.value);
    fpHintEl.textContent = chosen && chosen.is_main
      ? 'Filed into your Main Collection, so it counts in Spares and the set binders.'
      : 'Only cards in your Main Collection count in Spares and the set binders.';
  };
  if (fpBinderSel) fpBinderSel.addEventListener('change', paintFpHint);
  paintFpHint();
}

function dismissFpPresent(source) {
  if (!fpPresent || fpPresent.source !== source) return;
  fpPresent = null;
  const wrap = source === 'live' ? $('#live-present') : $('#photo-present');
  if (wrap) { wrap.innerHTML = ''; wrap.hidden = true; }
}

// File the presented printing into the chosen binder, from local
// data only: the row carries the pack's identity (name/set/number/
// language) and the deterministic art address; prices stay null and
// the nightly refresh fills them in — filing never waits on a source.
async function fileFpMatch() {
  const wrap = fpPresentWrap();
  if (!wrap || !fpPresent || fpPresent.filed) return;
  const m = live.pack.meta[fpPresent.i];
  const errEl = wrap.querySelector('[data-fp-error]');
  const showErr = (msg) => { if (errEl) { errEl.hidden = !msg; errEl.textContent = msg || ''; } };
  const binderSel = wrap.querySelector('[data-fp-binder]');
  const binder = state.binders.find((b) => b.id === (binderSel && binderSel.value)) ||
    state.binders.find((b) => b.is_main) || state.binders[0];
  if (!binder) { showErr('You have no binder yet — create one on the home page first.'); return; }
  const finishSel = wrap.querySelector('[data-fp-finish]');
  const qtyEl = wrap.querySelector('[data-fp-qty]');
  const isFoil = finishSel ? finishSel.value === 'foil' : false;
  const qty = Math.max(1, Math.min(99, Number(qtyEl && qtyEl.value) || 1));
  try {
    const { data: existing, error: exErr } = await sb.from('binder_cards')
      .select('id, quantity')
      .eq('binder_id', binder.id).eq('scryfall_id', m.id).eq('is_foil', isFoil)
      .maybeSingle();
    if (exErr) throw exErr;
    if (existing) {
      const { error } = await sb.from('binder_cards')
        .update({ quantity: (existing.quantity || 1) + qty }).eq('id', existing.id);
      if (error) throw error;
    } else {
      const { error } = await sb.from('binder_cards').insert({
        binder_id: binder.id,
        owner_id: state.user.id,
        scryfall_id: m.id,
        name: m.name,
        printed_name: null,
        set_code: m.set || null,
        set_name: null,
        collector_number: m.cn || null,
        lang: m.lang || 'en',
        is_foil: isFoil,
        quantity: qty,
        rarity: null,
        type_line: null,
        image_uri: fpImageUri(m.id),
        price_usd: null,
        price_usd_foil: null,
        price_source: null,
        unit_price: null
      });
      if (error) throw error;
    }
    fpPresent.filed = true;
    renderFpPresent();
    if (fpPresent.source === 'live') liveSetStatus('Filed ✓ — move the card away to scan the next one.');
    else photoSetStatus('Filed ✓');
  } catch (e) {
    showErr('Filing failed: ' + (e.message || String(e)));
  }
}

/* ----- Photo: the same local match on a still image ----- */

// Load a photo file into an image element (object URL — works in
// every browser the app supports, Safari included).
function loadPhotoImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That photo could not be read.')); };
    img.src = url;
  });
}

// One card per photo: the whole photo is treated as the card frame,
// exactly like the Muse app's proven local photo path.
async function onPhotoFile(file) {
  if (!file) return;
  dismissFpPresent('photo');
  if (live.stream) stopLive();
  if (!window.Fingerprint) { photoSetStatus('The fingerprint reader did not load — reload the page.'); return; }
  photoSetStatus('Preparing the on-device card library…');
  try {
    await loadFingerprintPack();
  } catch (e) {
    photoSetStatus(e.message || String(e));
    return;
  }
  photoSetStatus('Matching on this device…');
  try {
    const { img, url } = await loadPhotoImage(file);
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const prev = $('#photo-preview');
    prev.src = canvas.toDataURL('image/jpeg', 0.85);
    prev.hidden = false;
    URL.revokeObjectURL(url);
    const data = ctx.getImageData(0, 0, w, h);
    const hash = window.Fingerprint.hashCardImage(data.data, w, h);
    const res = fpSearch(hash.hi, hash.lo, 10);
    const best = res.top[0];
    if (!best || best.d > FP_WEAK_D) {
      photoCandidates = [];
      photoTieCount = 0; photoTieD = 0;
      paintFpCandidates('photo');
      photoSetStatus('No match — one card, closer and flatter, less glare.');
      return;
    }
    photoCandidates = res.top.slice(0, 5);
    photoTieCount = res.tieCount; photoTieD = best.d;
    paintFpCandidates('photo');
    photoSetStatus('On-device match — no internet used. Tap your printing.');
  } catch (e) {
    photoSetStatus((e && e.message) || 'That photo could not be read.');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('#btn-google').addEventListener('click', signInWithGoogle);
  $$('.install-btn').forEach(b => b.addEventListener('click', onInstallClick));
  $$('.share-btn').forEach(b => b.addEventListener('click', () => shareSite(b)));
  $('#btn-signout').addEventListener('click', async () => { await sb.auth.signOut(); enterAuth(); });
  $('#brand-home').addEventListener('click', () => { loadMyBinders(); showPage('home'); });

  $$('.tab').forEach(t => t.addEventListener('click', () => {
    const nav = t.getAttribute('data-nav');
    if (nav !== 'lookup') stopLive();
    if (nav === 'home') { loadMyBinders(); showPage('home'); }
    if (nav === 'members') { loadMembers(); showPage('members'); }
    if (nav === 'trades') { loadTrades(); showPage('trades'); }
    if (nav === 'decks') { loadDecks(); showPage('decks'); }
    if (nav === 'lookup') { showPage('lookup'); }
    if (nav === 'spares') { loadSpares(); showPage('spares'); }
    if (nav === 'profile') { paintProfileForm(); showPage('profile'); }
  }));

  // ⋯ More menu: opens/closes the dropdown; picking a page closes it;
  // tapping anywhere outside closes it too.
  const tabMenu = $('#tab-menu');
  $('#tab-more').addEventListener('click', (e) => { e.stopPropagation(); tabMenu.hidden = !tabMenu.hidden; });
  document.addEventListener('click', (e) => {
    if (!tabMenu.hidden && !e.target.closest('.tab-menu-wrap')) tabMenu.hidden = true;
  });
  $$('.tab-menu-item').forEach(b => b.addEventListener('click', () => { tabMenu.hidden = true; }));

  /* Phase 2 wiring */
  $('#member-search').addEventListener('input', (e) => renderMemberList(e.target.value));
  $('#btn-propose-trade').addEventListener('click', () => openCompose(state.memberProfile));
  $('#compose-back').addEventListener('click', () => { state.compose = null; showPage('member'); });
  const onPhotoInput = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // let the same photo be picked again later
    if (file) onPhotoFile(file);
  };
  $('#photo-file-cam').addEventListener('change', onPhotoInput);
  $('#photo-file-pick').addEventListener('change', onPhotoInput);
  $('#live-torch').addEventListener('click', toggleLiveTorch);
  $('#live-stage').addEventListener('click', (e) => {
    if (!live.stream) return;
    const v = $('#live-video');
    const r = v.getBoundingClientRect();
    if (!r.width || !r.height) return;
    focusCameraAtPoint(live.stream, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  });
  $('#live-toggle').addEventListener('click', startLive);
  $('#live-stop').addEventListener('click', stopLive);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopLive(); });
  $('#lookup-form').addEventListener('submit', searchLookup);
  $('#lookup-input').addEventListener('input', onLookupType);
  $('#compose-send').addEventListener('click', sendProposal);
  $('#compose-give-search').addEventListener('input', renderComposeLists);
  $('#compose-get-search').addEventListener('input', renderComposeLists);
  $('#trade-log-search').addEventListener('input', () => loadTrades());
  $('#spares-aim').addEventListener('change', renderMySpares);
  $('#want-search-form').addEventListener('submit', searchWants);

  /* Phase 4 wiring — decks */
  $('#btn-new-deck').addEventListener('click', () => openDeckDialog(null));
  $('#deck-form').addEventListener('submit', saveDeck);
  $('#deck-cancel').addEventListener('click', () => $('#deck-dialog').close());
  $('#btn-edit-deck').addEventListener('click', () => openDeckDialog(state.currentDeck));
  $('#btn-delete-deck').addEventListener('click', deleteCurrentDeck);
  $('#btn-import-deck').addEventListener('click', () => {
    $('#import-status').textContent = '';
    $('#import-dialog').showModal();
  });
  $('#import-cancel').addEventListener('click', () => $('#import-dialog').close());
  $('#import-go').addEventListener('click', importDecklist);
  $('#deck-back').addEventListener('click', () => {
    if (state.deckBack === 'member' && state.memberProfile) showPage('member');
    else { loadDecks(); showPage('decks'); }
  });
  $('#deck-search-form').addEventListener('submit', searchDeckCards);

  $('#btn-new-binder').addEventListener('click', () => openBinderDialog(null));
  $('#binder-form').addEventListener('submit', saveBinder);
  $('#binder-cancel').addEventListener('click', () => $('#binder-dialog').close());
  $('#btn-edit-binder').addEventListener('click', () => openBinderDialog(state.currentBinder));
  $('#btn-delete-binder').addEventListener('click', deleteCurrentBinder);

  $('#binder-back').addEventListener('click', () => {
    if (state.binderBack === 'member' && state.memberProfile) showPage('member');
    else { loadMyBinders(); showPage('home'); }
  });
  $('#member-back').addEventListener('click', () => { loadMembers(); showPage('members'); });

  $('#sort-select').addEventListener('change', renderCards);
  $('#group-set-toggle').addEventListener('change', renderCards);
  $('#search-form').addEventListener('submit', searchScryfall);

  $('#profile-form').addEventListener('submit', saveProfile);
  $('#avatar-input').addEventListener('change', (e) => uploadAvatar(e.target.files[0]));
  $('#profile-color-custom').addEventListener('input', (e) => {
    state.selectedColor = e.target.value;
    renderPalette();
    previewColor();
  });

  boot();
});
