// Морьтон Парад-2026 — нийтлэг туслах функцууд
import { CONFIG } from './config.js';
import qrcode from './vendor/qrcode.mjs';

export const configured = !/YOUR-PROJECT|YOUR-PUBLISHABLE/.test(CONFIG.SUPABASE_URL + CONFIG.SUPABASE_KEY);
const BASE = String(CONFIG.SUPABASE_URL || '').replace(/\/+$/, '');
export const FN_URL = CONFIG.FUNCTION_URL || BASE + '/functions/v1/parade';

export async function api(action, body = {}, token) {
  if (!configured) throw new Error('Сайтын тохиргоо (js/config.js) хийгдээгүй байна.');
  let r;
  try {
    r = await fetch(FN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', apikey: CONFIG.SUPABASE_KEY,
        // админ бол хэрэглэгчийн токен; эс бөгөөс хуучин anon (JWT) түлхүүр байвал түүнийг дамжуулна
        ...(token ? { Authorization: 'Bearer ' + token } : String(CONFIG.SUPABASE_KEY).split('.').length === 3 ? { Authorization: 'Bearer ' + CONFIG.SUPABASE_KEY } : {}),
      },
      body: JSON.stringify({ action, ...body }),
    });
  } catch (e) {
    throw new Error('Сервертэй холбогдож чадсангүй. Интернэтээ шалгаад дахин оролдоно уу.');
  }
  let j = {};
  try { j = await r.json(); } catch { /* хоосон */ }
  if (!r.ok) { const e = new Error(j.error || `Алдаа (${r.status})`); e.status = r.status; throw e; }
  return j;
}

// ---- Supabase нэвтрэлт (админ) — номын сангүйгээр
export const auth = {
  key: 'parade_admin_session',
  get() { try { return JSON.parse(localStorage.getItem(this.key) || 'null'); } catch { return this._mem || null; } },
  set(s) { this._mem = s; try { s ? localStorage.setItem(this.key, JSON.stringify(s)) : localStorage.removeItem(this.key); } catch { /* хувийн цонх */ } },
  async call(grant, body) {
    const r = await fetch(`${BASE}/auth/v1/token?grant_type=${grant}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CONFIG.SUPABASE_KEY }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(/invalid/i.test(j.error_description || j.msg || '') ? 'Имэйл эсвэл нууц үг буруу байна.' : (j.error_description || j.msg || 'Нэвтэрч чадсангүй'));
    const s = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: (j.expires_at || (Date.now() / 1000 + (j.expires_in || 3600))), email: j.user?.email };
    this.set(s);
    return s;
  },
  login(email, password) { return this.call('password', { email, password }); },
  async token() {
    const s = this.get();
    if (!s) return null;
    if (s.expires_at * 1000 - Date.now() > 60_000) return s.access_token;
    try { return (await this.call('refresh_token', { refresh_token: s.refresh_token })).access_token; }
    catch { this.set(null); return null; }
  },
  logout() { this.set(null); },
};

// ---- форматлах
export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = n => Number(n || 0).toLocaleString('en-US') + '₮';
const p2 = n => String(n).padStart(2, '0');
export const WD = ['Ням', 'Даваа', 'Мягмар', 'Лхагва', 'Пүрэв', 'Баасан', 'Бямба'];
// Улаанбаатарын цагаар (UTC+8)
const ub = v => { const d = new Date(v); return new Date(d.getTime() + 8 * 3600_000); };
export const fmtDT = v => { if (!v) return ''; const d = ub(v); return `${d.getUTCFullYear()}.${p2(d.getUTCMonth() + 1)}.${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };
export const fmtTime = v => { if (!v) return ''; const d = ub(v); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };
export const fmtDay = v => { const d = ub(v); return `${d.getUTCFullYear()}.${p2(d.getUTCMonth() + 1)}.${p2(d.getUTCDate())}`; };
export const fmtWeekday = v => WD[ub(v).getUTCDay()] + ' гараг';
export const param = k => new URLSearchParams(location.search).get(k);
export const siteBase = () => location.origin + location.pathname.replace(/[^/]*$/, '');
export const ticketLink = token => siteBase() + 'ticket.html?t=' + token;

// ---- QR (SVG)
export function qrSvg(text, { margin = 2, ecl = 'M', dark = '#04202a' } = {}) {
  const qr = qrcode(0, ecl);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), size = n + margin * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR код"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="${dark}"/></svg>`;
}

// ---- тоолуур
export function startCountdown(el, targetIso, serverNow, { compact = false, onLive } = {}) {
  const offset = serverNow ? new Date(serverNow).getTime() - Date.now() : 0;
  const target = new Date(targetIso).getTime();
  const box = (v, l) => `<div class="cd-box"><b>${v}</b><small>${l}</small></div>`;
  let timer;
  const tick = () => {
    const ms = target - (Date.now() + offset);
    if (ms <= 0) {
      el.innerHTML = `<div class="cd-live">Парад эхэллээ!</div>`;
      clearInterval(timer); onLive && onLive();
      return;
    }
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    el.innerHTML = (compact ? '' : '<div class="label">Парад эхлэхэд</div>') +
      box(d, 'өдөр') + box(p2(h), 'цаг') + box(p2(m), 'минут') + box(p2(sec), 'секунд');
  };
  tick();
  timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
}

// ---- жижиг туслахууд
export function toast(msg, ms = 2600) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms);
}
export const store = {
  get(k, d = null) { try { return JSON.parse(localStorage.getItem('parade_' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('parade_' + k, JSON.stringify(v)); } catch { /* */ } },
};
export function rememberOrder(code, key) {
  const list = store.get('orders', []).filter(o => o.code !== code);
  list.unshift({ code, key, at: Date.now() });
  store.set('orders', list.slice(0, 10));
}

export const ICONS = {
  cal: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  pin: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  phone: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>',
  clock: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  check: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  ticket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9a3 3 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a3 3 0 0 1 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1z"/><path d="M14 5v2M14 11v2M14 17v2"/></svg>',
  gift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/></svg>',
  food: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2M7 2v20M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7"/></svg>',
  drink: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h14l-1.6 16.2A2 2 0 0 1 15.4 21H8.6a2 2 0 0 1-2-1.8z"/><path d="M5.5 8h13"/></svg>',
  okBig: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
};

export function renderChrome(info) {
  const h = document.getElementById('site-header');
  if (h) h.innerHTML = `<div class="container">
    <a class="brand" href="index.html"><span class="mark" aria-hidden="true"></span><span><b>МОРЬТОН</b><small>Адуу үржүүлгийн газар</small></span></a>
    <nav class="nav"><a href="index.html#lookup" class="hide-sm" data-lookup>Миний тасалбар</a><a href="index.html#buy" class="cta">Тасалбар авах</a></nav></div>`;
  const f = document.getElementById('site-footer');
  if (f) f.innerHTML = `<div class="container">
    <div><b>Морьтон адуу үржүүлгийн газар</b><br>${esc(info?.location || 'Хүй долоон худаг')} · Утас: <a href="tel:${esc((info?.phone || '7732-0404').replace(/\D/g, ''))}">${esc(info?.phone || '7732-0404')}</a></div>
    <div>${esc(info?.event_name || 'Морьтон Парад-2026')}<br><a href="index.html#lookup" data-lookup>Тасалбараа дахин авах</a></div></div>`;
  if (!configured && !document.querySelector('.cfg-warn')) document.body.insertAdjacentHTML('afterbegin', '<div class="cfg-warn"><b>Тохиргоо дутуу:</b> js/config.js файлд Supabase-ийн URL, түлхүүрийг оруулна уу (README-г үзнэ үү).</div>');
}
