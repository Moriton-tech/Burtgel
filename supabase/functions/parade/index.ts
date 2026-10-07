// =====================================================================
//  Морьтон Парад-2026 — тасалбарын API (Supabase Edge Function: "parade")
//  Нэг файл. Supabase → Edge Functions → Deploy a new function → Via Editor
//  → нэр: parade → энэ файлыг бүтнээр нь тавина → Deploy.
//  ДАРАА НЬ: функцийн тохиргоонд "Verify JWT" (Enforce JWT verification)-ийг УНТРААНА.
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2';
import nodemailer from 'npm:nodemailer@6';
import qrcode from 'npm:qrcode-generator@2.0.4';

// ---------------------------------------------------------------- тохиргоо
const env = (k: string, d = '') => (Deno.env.get(k) ?? d).trim();

function serviceKey(): string {
  try {
    const j = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}');
    const k = j.default || Object.values(j)[0];
    if (k) return String(k);
  } catch { /* хуучин түлхүүр рүү шилжинэ */ }
  return env('SUPABASE_SERVICE_ROLE_KEY');
}

const SUPABASE_URL = env('SUPABASE_URL');
const db = createClient(SUPABASE_URL, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });

const QPAY_MODE = env('QPAY_MODE', 'production').toLowerCase();               // production | sandbox
const SANDBOX = QPAY_MODE === 'sandbox';
const QPAY_BASE = env('QPAY_BASE_URL', SANDBOX ? 'https://merchant-sandbox.qpay.mn/v2' : 'https://merchant.qpay.mn/v2').replace(/\/+$/, '');
const QPAY_ID = env('QPAY_CLIENT_ID', SANDBOX ? 'TEST_MERCHANT' : '');
const QPAY_SECRET = env('QPAY_CLIENT_SECRET', SANDBOX ? '123456' : '');
const QPAY_INVOICE_CODE = env('QPAY_INVOICE_CODE', SANDBOX ? 'TEST_INVOICE' : '');
const QPAY_ON = !!(QPAY_ID && QPAY_SECRET && QPAY_INVOICE_CODE);

const FUNC_URL = env('PUBLIC_FUNCTION_URL', `${SUPABASE_URL}/functions/v1/parade`);

const SMTP_USER = env('SMTP_USER');
const SMTP_PASS = env('SMTP_PASS').replace(/\s+/g, '');                        // Gmail app password-ийн хоосон зайг авна
const SMTP_HOST = env('SMTP_HOST', 'smtp.gmail.com');
const SMTP_PORT = Number(env('SMTP_PORT', '465'));
const RESEND_KEY = env('RESEND_API_KEY');
const RESEND_URL = env('RESEND_API_URL', 'https://api.resend.com').replace(/\/+$/, '');
const MAIL_FROM = env('MAIL_FROM', SMTP_USER ? `Морьтон Парад <${SMTP_USER}>` : 'Морьтон Парад <onboarding@resend.dev>');
const MAIL_ON = !!(RESEND_KEY || (SMTP_USER && SMTP_PASS));

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// ---------------------------------------------------------------- туслахууд
class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

export const AIMAGS = ['Улаанбаатар', 'Архангай', 'Баян-Өлгий', 'Баянхонгор', 'Булган', 'Говь-Алтай', 'Говьсүмбэр', 'Дархан-Уул',
  'Дорноговь', 'Дорнод', 'Дундговь', 'Завхан', 'Орхон', 'Өвөрхангай', 'Өмнөговь', 'Сүхбаатар', 'Сэлэнгэ', 'Төв', 'Увс', 'Ховд', 'Хөвсгөл', 'Хэнтий', 'Гадаад'];
export const TITLES = ['Сонирхогч', 'Залуу уяач', 'СУА', 'ААУ', 'НАУ', 'МУАУ', 'МУМУ', 'МУТМУ'];

const DB_ERRORS: Record<string, string> = {
  SALES_CLOSED: 'Онлайн борлуулалт түр хаагдсан байна.',
  SALES_ENDED: 'Онлайн борлуулалт дууссан байна.',
  BAD_QTY: 'Тасалбарын тоо буруу байна.',
  BAD_INPUT: 'Нэр, утасны дугаараа бөглөнө үү.',
  TOO_MANY: 'Танд төлөгдөөгүй захиалга байна. Түүнийгээ төлөх эсвэл 20 минут хүлээгээд дахин оролдоно уу.',
  NOT_FOUND: 'Захиалга олдсонгүй.',
  NO_NUMBERS: 'Тасалбарын дугаар хүрэлцэхгүй байна.',
  NO_CANDIDATES: 'Сугалаанд оролцох тасалбар алга (өмнө нь бүгд хожсон эсвэл хэн ч ирээгүй).',
};
function dbError(e: { message?: string }): HttpError {
  const m = String(e?.message || e);
  const [code, arg] = m.split(':');
  if (code === 'SOLD_OUT') {
    const n = Number(arg) || 0;
    return new HttpError(409, n > 0 ? `Зөвхөн ${n} тасалбар үлдсэн байна.` : 'Уучлаарай, тасалбар дууслаа.');
  }
  if (code === 'UNDERPAID') return new HttpError(409, `Төлсөн дүн хүрэлцэхгүй байна (${arg}₮).`);
  if (DB_ERRORS[code]) return new HttpError(code === 'NOT_FOUND' ? 404 : 409, DB_ERRORS[code]);
  console.error('DB error:', m);
  return new HttpError(500, 'Өгөгдлийн сангийн алдаа: ' + m);
}

async function rpc<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(name, args);
  if (error) throw dbError(error);
  return data as T;
}
// deno-lint-ignore no-explicit-any
async function q(p: PromiseLike<{ data: any; error: any }>): Promise<any> {
  const { data, error } = await p;
  if (error) throw dbError(error);
  return data;
}

const money = (n: number) => Number(n || 0).toLocaleString('en-US').replace(/,/g, ',') + '₮';
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const WD = ['Ням', 'Даваа', 'Мягмар', 'Лхагва', 'Пүрэв', 'Баасан', 'Бямба'];
function fmtEvent(iso: string) {
  const d = new Date(new Date(iso).getTime() + 8 * 3600_000);                    // Улаанбаатар UTC+8
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())} (${WD[d.getUTCDay()]} гараг) ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
function safeEq(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const clientIp = (req: Request) =>
  (req.headers.get('x-forwarded-for') || req.headers.get('cf-connecting-ip') || '').split(',')[0].trim() || null;

function siteBase(settings: any): string {
  let u = String(settings?.site_url || env('SITE_URL') || '').trim();
  if (u && !u.endsWith('/')) u += '/';
  return u;
}
const ticketUrl = (base: string, token: string) => (base ? `${base}ticket.html?t=${token}` : token);

function qrGif(text: string, cell = 6) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(cell, 3).replace(/^data:image\/gif;base64,/, '');
}

async function getSettings() {
  return await q(db.from('parade_settings').select('*').eq('id', 1).single());
}

// ---------------------------------------------------------------- QPay
let qpTok: { token: string; exp: number } | null = null;
async function qpayToken(force = false): Promise<string> {
  if (!force && qpTok && qpTok.exp > Date.now() + 60_000) return qpTok.token;
  const r = await fetch(`${QPAY_BASE}/auth/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${QPAY_ID}:${QPAY_SECRET}`) },
    signal: AbortSignal.timeout(15_000),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`QPay нэвтрэлт амжилтгүй (${r.status}): ${j.message || j.error || ''}`);
  let exp = Number(j.expires_in) || 0;
  exp = exp > 1e12 ? exp : exp > 1e9 ? exp * 1000 : Date.now() + (exp || 600) * 1000;
  qpTok = { token: j.access_token, exp: Math.min(exp, Date.now() + 50 * 60_000) };
  return qpTok.token;
}
async function qpay(path: string, method = 'GET', body?: unknown): Promise<any> {
  const go = async (tok: string) => fetch(QPAY_BASE + path, {
    method,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  let r = await go(await qpayToken());
  if (r.status === 401) r = await go(await qpayToken(true));
  const txt = await r.text();
  let j: any;
  try { j = txt ? JSON.parse(txt) : {}; } catch { j = { raw: txt }; }
  if (!r.ok) throw new Error(`QPay ${r.status}: ${j.message || j.error || txt.slice(0, 200)}`);
  return j;
}
async function qpayCreateInvoice(o: any, s: any) {
  const j = await qpay('/invoice', 'POST', {
    invoice_code: QPAY_INVOICE_CODE,
    sender_invoice_no: o.code,
    invoice_receiver_code: o.phone || 'terminal',
    invoice_description: `${s.event_name} тасалбар x${o.qty} (${o.code})`,
    amount: o.amount,
    callback_url: `${FUNC_URL}?action=callback&code=${encodeURIComponent(o.code)}`,
  });
  if (!j.invoice_id) throw new Error('QPay нэхэмжлэх үүсээгүй: ' + JSON.stringify(j).slice(0, 200));
  return {
    invoice_id: String(j.invoice_id),
    invoice_qr_text: j.qr_text || null,
    invoice_qr_image: j.qr_image || null,
    invoice_short_url: j.qPay_shortUrl || j.qpay_short_url || j.qPay_shortURL || null,
    invoice_urls: Array.isArray(j.urls) ? j.urls.map((u: any) => ({ name: u.name, description: u.description, logo: u.logo, link: u.link })) : [],
  };
}
async function qpayCheck(invoiceId: string): Promise<{ paid: boolean; amount: number; paymentId: string | null }> {
  const j = await qpay('/payment/check', 'POST', { object_type: 'INVOICE', object_id: invoiceId, offset: { page_number: 1, page_limit: 100 } });
  const rows: any[] = Array.isArray(j.rows) ? j.rows : [];
  const paidRows = rows.filter(r => String(r.payment_status || '').toUpperCase() === 'PAID');
  const sum = paidRows.reduce((a, r) => a + Number(r.payment_amount || 0), 0) || (paidRows.length ? Number(j.paid_amount || 0) : 0);
  return { paid: paidRows.length > 0, amount: sum, paymentId: paidRows[0] ? String(paidRows[0].payment_id) : null };
}

// Захиалгын төлбөрийг QPay-ээс шалгаад төлөгдсөн бол тасалбар олгоно
async function syncOrder(o: any, actor = 'system'): Promise<any> {
  if (!o || !QPAY_ON || !o.invoice_id || o.pay_method !== 'qpay') return o;
  if (!['pending', 'expired', 'cancelled'].includes(o.status)) return o;
  if (Date.now() - new Date(o.created_at).getTime() > 3 * 24 * 3600_000) return o;   // 3 хоногоос хуучныг шалгахгүй
  let chk;
  try { chk = await qpayCheck(o.invoice_id); } catch (e) { console.error('QPay check', o.code, e); return o; }
  if (!chk.paid) return o;
  const r = await rpc('parade_finalize_order', {
    p_order_id: o.id, p_payment_id: chk.paymentId, p_paid_amount: Math.round(chk.amount) || null, p_method: 'qpay', p_actor: actor,
  });
  if (r.ok && !r.already) background(sendOrderEmails(o.id));
  if (!r.ok && r.reason) background(notifyProblem(r.order, r.reason));
  return r.order;
}

// ---------------------------------------------------------------- имэйл
let smtp: any = null;
function mailErr(e: unknown): Error {
  const m = String((e as Error)?.message || e);
  if (/535|Invalid login|Username and Password not accepted|BadCredentials/i.test(m))
    return new Error('Имэйлийн нэвтрэлт амжилтгүй — SMTP_USER болон Gmail App password-оо шалгана уу. (' + m.slice(0, 120) + ')');
  if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|timeout|Greeting never received/i.test(m))
    return new Error('Имэйлийн сервертэй холбогдож чадсангүй (' + m.slice(0, 120) + ')');
  return e instanceof Error ? e : new Error(m);
}
async function sendMail(m: Parameters<typeof sendMailRaw>[0]) {
  try { await sendMailRaw(m); } catch (e) { throw mailErr(e); }
}
async function sendMailRaw(m: { to: string[]; subject: string; html: string; text: string; attachments?: { filename: string; content: string; cid: string }[] }) {
  const to = m.to.map(s => s.trim()).filter(Boolean);
  if (!to.length) return;
  if (RESEND_KEY) {
    const r = await fetch(`${RESEND_URL}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: MAIL_FROM, to, subject: m.subject, html: m.html, text: m.text,
        attachments: (m.attachments || []).map(a => ({ filename: a.filename, content: a.content, content_id: a.cid, content_type: 'image/gif' })),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return;
  }
  if (SMTP_USER && SMTP_PASS) {
    smtp ??= nodemailer.createTransport({
      host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 20_000,
    });
    await smtp.sendMail({
      from: MAIL_FROM, to: to.join(', '), subject: m.subject, html: m.html, text: m.text,
      attachments: (m.attachments || []).map(a => ({ filename: a.filename, content: a.content, encoding: 'base64', cid: a.cid, contentType: 'image/gif' })),
    });
    return;
  }
  throw new Error('Имэйл тохиргоо хийгдээгүй (SMTP_USER/SMTP_PASS эсвэл RESEND_API_KEY)');
}

const NAVY = '#0b3a48', NAVY_D = '#072a35', GOLD = '#c9a24a', CREAM = '#f4f2ec';

function ticketEmail(o: any, tickets: any[], s: any) {
  const base = siteBase(s);
  const att = tickets.map(t => ({ filename: `tasalbar-${t.number}.gif`, content: qrGif(ticketUrl(base, t.token), 6), cid: `qr${t.number}@parade` }));
  const nums = tickets.map(t => '№' + t.number).join(', ');
  const cards = tickets.map(t => `
    <tr><td style="padding:0 0 16px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${NAVY};border-radius:14px;overflow:hidden">
        <tr>
          <td style="padding:18px 20px;color:#fff;font-family:Arial,sans-serif;vertical-align:middle">
            <div style="font-size:11px;letter-spacing:2px;color:${GOLD};font-weight:bold">ТАСАЛБАР</div>
            <div style="font-size:30px;font-weight:bold;color:${GOLD};letter-spacing:2px;margin:4px 0">№${t.number}</div>
            <div style="font-size:13px;opacity:.9">${esc(o.name)}</div>
            <div style="font-size:12px;opacity:.75;margin-top:8px">Сугалаа · Хоол · Ус, ундаа</div>
            ${base ? `<a href="${ticketUrl(base, t.token)}" style="display:inline-block;margin-top:12px;background:${GOLD};color:${NAVY_D};text-decoration:none;font-weight:bold;font-size:13px;padding:8px 14px;border-radius:8px">Тасалбар нээх →</a>` : ''}
          </td>
          <td width="170" style="padding:14px;background:#fff;text-align:center;vertical-align:middle">
            <img src="cid:qr${t.number}@parade" width="150" height="150" alt="QR ${t.number}" style="display:block;margin:0 auto">
            <div style="font-family:Arial,sans-serif;font-size:10px;color:#666;margin-top:4px">Үүдэнд уншуулна</div>
          </td>
        </tr>
      </table>
    </td></tr>`).join('');
  const html = `<!doctype html><html><body style="margin:0;background:${CREAM};padding:20px 0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:16px;overflow:hidden;font-family:Arial,sans-serif;color:#1b211f">
    <tr><td style="background:${NAVY_D};padding:22px 24px;border-bottom:3px solid ${GOLD}">
      <div style="color:${GOLD};font-size:20px;font-weight:bold;letter-spacing:1px">МОРЬТОН</div>
      <div style="color:#e9e4d4;font-size:12px">Адуу үржүүлгийн газар</div>
    </td></tr>
    <tr><td style="padding:24px">
      <h1 style="margin:0 0 6px;font-size:22px;color:${NAVY}">${esc(s.event_name)} — таны тасалбар</h1>
      <p style="margin:0 0 16px;font-size:14px;color:#555">Сайн байна уу, ${esc(o.name)}! Төлбөр амжилттай баталгаажлаа. Үүдэн дээр доорх QR кодыг уншуулж орно. Тасалбар бүр нэг хүнд.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM};border-radius:10px;margin-bottom:18px;font-size:14px">
        <tr><td style="padding:12px 14px">
          <b>Огноо:</b> ${esc(fmtEvent(s.event_at))}<br>
          <b>Байршил:</b> ${esc(s.location)}<br>
          <b>Захиалга:</b> ${esc(o.code)} · ${o.qty} ширхэг · ${money(o.paid_amount ?? o.amount)}<br>
          <b>Тасалбарын дугаар:</b> ${nums}
        </td></tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cards}</table>
      <p style="font-size:13px;color:#555;margin:6px 0 0"><b>Тасалбарт багтсан:</b> сугалаа (25% эр сарваа, TRM брэнд 10 бүтээгдэхүүн, Морьтон Үндэсний Адууны эмнэлгээр үйлчлүүлэх 10 эрх), хоол, ус ундаа. Тасалбарын дугаар нь сугалааны дугаар болно.</p>
      <p style="font-size:13px;color:#555">Асуух зүйл байвал: <b>${esc(s.phone)}</b></p>
    </td></tr>
    <tr><td style="background:${NAVY_D};color:#cfd8d6;font-size:12px;padding:14px 24px">Морьтон адуу үржүүлгийн газар · ${esc(s.location)} · ${esc(s.phone)}</td></tr>
  </table></td></tr></table></body></html>`;
  const text = `${s.event_name} — таны тасалбар\n\n${o.name}, төлбөр баталгаажлаа.\nОгноо: ${fmtEvent(s.event_at)}\nБайршил: ${s.location}\nЗахиалга: ${o.code}\nТасалбар: ${nums}\n\n` +
    tickets.map(t => `№${t.number}: ${ticketUrl(base, t.token)}`).join('\n') + `\n\nУтас: ${s.phone}`;
  return { subject: `${s.event_name} — таны тасалбар ${nums}`, html, text, attachments: att };
}

function adminEmail(o: any, tickets: any[], s: any, title?: string) {
  const base = siteBase(s);
  const nums = tickets.map(t => t.number).join(', ');
  const rows = [
    ['Захиалга', o.code], ['Нэр', o.name], ['Утас', [o.phone, o.phone2].filter(Boolean).join(', ')], ['Имэйл', o.email || '—'],
    ['Аймаг, сум', [o.aimag, o.sum].filter(Boolean).join(', ') || '—'], ['Цол', o.title || '—'],
    ['Тоо', `${o.qty} ширхэг`], ['Дүн', money(o.paid_amount ?? o.amount)], ['Төлбөр', o.pay_method],
    ['Төлөв', o.status], ['Дугаар', nums || '—'], ['Эх сурвалж', o.source === 'manual' ? `Гараар (${o.created_by || ''})` : 'Онлайн'],
  ];
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1b211f">
    <h2 style="color:${NAVY};margin:0 0 10px">${esc(title || `Шинэ тасалбар: ${o.name} — ${o.qty} ш`)}</h2>
    <table cellpadding="6" style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="color:#777">${k}</td><td><b>${esc(v)}</b></td></tr>`).join('')}</table>
    ${base ? `<p><a href="${base}admin.html">Админ хэсэг нээх →</a></p>` : ''}</div>`;
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n');
  return { subject: title || `🎟 Шинэ тасалбар: ${o.name} — ${o.qty} ш (${money(o.paid_amount ?? o.amount)})`, html, text };
}

const notifyList = (s: any) => String(s.notify_email || '').split(/[,;\s]+/).filter(x => x.includes('@'));

async function loadOrderFull(orderId: string) {
  const o = await q(db.from('parade_orders').select('*').eq('id', orderId).single());
  const tickets = await q(db.from('parade_tickets').select('number,token,status').eq('order_id', orderId).eq('status', 'valid').order('number'));
  return { o, tickets };
}

// Төлбөр баталгаажсаны дараах имэйлүүд (худалдан авагч + админ мэдэгдэл). force=true бол дахин илгээнэ.
async function sendOrderEmails(orderId: string, opts: { force?: boolean; notify?: boolean } = {}): Promise<{ sent: boolean; error: string | null }> {
  if (!opts.force) {
    const claimed = await q(db.from('parade_orders').update({ email_sent_at: new Date().toISOString() })
      .eq('id', orderId).is('email_sent_at', null).select('id'));
    if (!claimed?.length) return { sent: false, error: null };
  }
  const s = await getSettings();
  const { o, tickets } = await loadOrderFull(orderId);
  const errors: string[] = [];
  if (o.email && tickets.length) {
    try { await sendMail({ to: [o.email], ...ticketEmail(o, tickets, s) }); }
    catch (e) { errors.push('Худалдан авагч: ' + (e as Error).message); }
  }
  if (opts.notify !== false && !opts.force && notifyList(s).length) {
    try { await sendMail({ to: notifyList(s), ...adminEmail(o, tickets, s) }); }
    catch (e) { errors.push('Админ мэдэгдэл: ' + (e as Error).message); }
  }
  const error = errors.join(' | ') || null;
  await db.from('parade_orders').update({ email_sent_at: new Date().toISOString(), email_error: error }).eq('id', orderId);
  if (error) console.error('Email', o.code, error);
  return { sent: !!o.email && !errors.some(x => x.startsWith('Худалдан')), error };
}

async function notifyProblem(o: any, reason: string) {
  try {
    const s = await getSettings();
    const t = reason === 'SOLD_OUT_REFUND' ? `⚠ Буцаалт хэрэгтэй: тасалбар дууссаны дараа төлсөн (${o.code})`
      : `⚠ Буцаалт хэрэгтэй: цуцлагдсан захиалга төлөгдсөн (${o.code})`;
    if (notifyList(s).length) await sendMail({ to: notifyList(s), ...adminEmail(o, [], s, t) });
  } catch (e) { console.error('notifyProblem', e); }
}

function background(p: Promise<unknown>) {
  const safe = p.catch(e => console.error('background', e));
  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  if (er?.waitUntil) er.waitUntil(safe);
  return safe;
}

// ---------------------------------------------------------------- нийтийн үйлдлүүд
function publicOrder(o: any, tickets: any[] = [], info?: any) {
  return {
    code: o.code, name: o.name, phone: o.phone, email: o.email, aimag: o.aimag, sum: o.sum, title: o.title, qty: o.qty, amount: o.amount,
    status: o.status, pay_method: o.pay_method, expires_at: o.expires_at, paid_at: o.paid_at, created_at: o.created_at,
    email_sent: !!o.email_sent_at && !o.email_error,
    qpay: o.status === 'pending' && o.pay_method === 'qpay' ? {
      qr_image: o.invoice_qr_image, qr_text: o.invoice_qr_text, short_url: o.invoice_short_url, urls: o.invoice_urls || [],
    } : null,
    bank_info: o.pay_method === 'transfer' ? info?.bank_info || '' : undefined,
    tickets: tickets.map(t => ({ number: t.number, token: t.token })),
  };
}

async function actInfo() {
  const info = await rpc('parade_public_info');
  return { ...info, pay_mode: QPAY_ON ? 'qpay' : (info.bank_info ? 'transfer' : 'none'), qpay_sandbox: QPAY_ON && SANDBOX };
}

async function actCreate(b: any, req: Request) {
  if (b.website) throw new HttpError(400, 'Алдаа');                                      // honeypot
  const name = String(b.name || '').trim().replace(/\s+/g, ' ');
  const phone = String(b.phone || '').replace(/[^\d+]/g, '');
  const email = String(b.email || '').trim().toLowerCase();
  const phone2 = String(b.phone2 || '').replace(/[^\d+]/g, '');
  const aimag = String(b.aimag || '').trim();
  const sum = String(b.sum || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const title = String(b.title || '').trim();
  const qty = Math.floor(Number(b.qty));
  if (name.length < 2 || name.length > 80) throw new HttpError(400, 'Нэрээ зөв оруулна уу.');
  if (!/^\+?\d{8,15}$/.test(phone)) throw new HttpError(400, 'Утасны дугаараа зөв оруулна уу (8 оронтой).');
  if (phone2 && !/^\+?\d{8,15}$/.test(phone2)) throw new HttpError(400, 'Нэмэлт утасны дугаараа зөв оруулна уу.');
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120)) throw new HttpError(400, 'Имэйл хаягаа зөв оруулна уу.');
  if (!AIMAGS.includes(aimag)) throw new HttpError(400, 'Аймгаа сонгоно уу.');
  if (sum.length < 2) throw new HttpError(400, 'Сум / дүүргээ бичнэ үү.');
  if (!TITLES.includes(title)) throw new HttpError(400, 'Цолоо сонгоно уу.');
  if (!Number.isFinite(qty) || qty < 1) throw new HttpError(400, 'Тасалбарын тоог сонгоно уу.');

  const s = await getSettings();
  const method = QPAY_ON ? 'qpay' : (s.bank_info ? 'transfer' : '');
  if (!method) throw new HttpError(503, 'Төлбөрийн систем тохируулагдаагүй байна. Түр хүлээнэ үү.');

  // Сайтын хаяг тохируулагдаагүй бол (имэйл дэх холбоосонд) хөтчийн хаягийг ашиглана
  if (!s.site_url && typeof b.site === 'string' && /^https:\/\/[^/]+\//.test(b.site)) {
    const origin = req.headers.get('origin') || '';
    if (origin && b.site.startsWith(origin + '/')) await db.from('parade_settings').update({ site_url: b.site }).eq('id', 1);
  }

  let o = await rpc('parade_create_order', { p_name: name, p_phone: phone, p_email: email, p_qty: qty, p_method: method, p_ip: clientIp(req) });
  try {
    o = await q(db.from('parade_orders').update({ phone2: phone2 || null, aimag, sum, title }).eq('id', o.id).select('*').single());
  } catch (e) {
    await db.from('parade_orders').update({ status: 'cancelled', note: 'Бүртгэл хадгалагдсангүй' }).eq('id', o.id);
    throw e;
  }
  if (method === 'qpay') {
    try {
      const inv = await qpayCreateInvoice(o, s);
      o = await q(db.from('parade_orders').update({ ...inv, updated_at: new Date().toISOString() }).eq('id', o.id).select('*').single());
    } catch (e) {
      console.error('QPay invoice', o.code, e);
      await db.from('parade_orders').update({ status: 'cancelled', note: 'QPay алдаа: ' + (e as Error).message }).eq('id', o.id);
      throw new HttpError(502, 'QPay нэхэмжлэх үүсгэж чадсангүй. Түр хүлээгээд дахин оролдоно уу.');
    }
  }
  return { code: o.code, key: o.access_key };
}

async function orderByCode(code: string) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^MP-[A-Z0-9]{6}$/.test(c)) throw new HttpError(404, 'Захиалга олдсонгүй.');
  const o = await q(db.from('parade_orders').select('*').eq('code', c).maybeSingle());
  if (!o) throw new HttpError(404, 'Захиалга олдсонгүй.');
  return o;
}

async function actStatus(b: any) {
  let o = await orderByCode(b.code);
  if (!safeEq(String(b.key || ''), o.access_key)) throw new HttpError(404, 'Захиалга олдсонгүй.');
  o = await syncOrder(o, 'status');
  if (o.status === 'pending' && new Date(o.expires_at).getTime() < Date.now()) {
    o = await q(db.from('parade_orders').update({ status: 'expired', updated_at: new Date().toISOString() })
      .eq('id', o.id).eq('status', 'pending').select('*').maybeSingle()) || o;
  }
  const tickets = o.status === 'paid'
    ? await q(db.from('parade_tickets').select('number,token').eq('order_id', o.id).eq('status', 'valid').order('number')) : [];
  const info = await rpc('parade_public_info');
  return { order: publicOrder(o, tickets, info), event: info };
}

async function actTicket(b: any) {
  const t = String(b.t || '').trim().toLowerCase();
  if (!/^[a-f0-9]{16,40}$/.test(t)) throw new HttpError(404, 'Тасалбар олдсонгүй.');
  const tk = await q(db.from('parade_tickets').select('number,token,status,holder_name,entry_at,food_at,drink_at,order_id').eq('token', t).maybeSingle());
  if (!tk) throw new HttpError(404, 'Тасалбар олдсонгүй.');
  const o = await q(db.from('parade_orders').select('code,name,status').eq('id', tk.order_id).single());
  const info = await rpc('parade_public_info');
  const { order_id: _x, ...ticket } = tk;
  return { ticket: { ...ticket, holder_name: tk.holder_name || o.name, order_code: o.code }, event: info };
}

async function actCallback(url: URL) {
  try {
    const o = await orderByCode(url.searchParams.get('code') || '');
    await syncOrder(o, 'qpay-callback');
  } catch (e) { console.error('callback', e); }
  return new Response('SUCCESS', { status: 200, headers: CORS });
}

async function actLookup(b: any) {
  const c = String(b.contact || '').trim().toLowerCase();
  const generic = { ok: true, message: 'Хэрэв энэ мэдээллээр төлөгдсөн захиалга байвал тасалбарыг таны имэйл рүү дахин илгээлээ. Имэйлээ (Spam хавтсыг ч) шалгана уу.' };
  let query = db.from('parade_orders').select('id,email,email_sent_at').eq('status', 'paid').limit(5);
  if (c.includes('@')) query = query.eq('email', c);
  else {
    const p = c.replace(/[^\d+]/g, '');
    if (p.length < 8) throw new HttpError(400, 'Утас эсвэл имэйлээ зөв оруулна уу.');
    query = query.eq('phone', p);
  }
  const orders = await q(query);
  for (const o of orders || []) {
    if (!o.email) continue;
    if (o.email_sent_at && Date.now() - new Date(o.email_sent_at).getTime() < 2 * 60_000) continue;  // 2 минутын хязгаар
    await db.from('parade_orders').update({ email_sent_at: new Date().toISOString() }).eq('id', o.id);
    background(sendOrderEmails(o.id, { force: true }));
  }
  return generic;
}

// ---------------------------------------------------------------- админ
async function staffFrom(req: Request, need: 'admin' | 'staff') {
  const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!tok || tok.split('.').length !== 3) throw new HttpError(401, 'Нэвтэрнэ үү.');
  const { data, error } = await db.auth.getUser(tok);
  if (error || !data?.user?.email) throw new HttpError(401, 'Нэвтрэх хугацаа дууссан. Дахин нэвтэрнэ үү.');
  const email = data.user.email.toLowerCase();
  const st = await q(db.from('parade_staff').select('email,role').eq('email', email).maybeSingle());
  if (!st) throw new HttpError(403, `${email} хэрэглэгч энэ системд эрхгүй байна.`);
  if (need === 'admin' && st.role !== 'admin') throw new HttpError(403, 'Энэ үйлдэлд админ эрх хэрэгтэй.');
  return st as { email: string; role: string };
}
const log = (actor: string, action: string, detail: unknown) =>
  db.from('parade_log').insert({ actor, action, detail }).then(() => {}, () => {});

const ORDER_COLS = 'id,code,name,phone,phone2,aimag,sum,title,email,qty,unit_price,amount,status,source,pay_method,invoice_id,payment_id,paid_amount,paid_at,expires_at,email_sent_at,email_error,note,created_by,created_at,updated_at';

const SETTING_KEYS = ['event_name', 'event_at', 'sales_until', 'location', 'phone', 'price', 'start_no', 'total', 'max_per_order',
  'hold_minutes', 'transfer_hold_hours', 'sales_open', 'bank_info', 'notify_email', 'site_url'];

async function admin(action: string, b: any, req: Request) {
  const staffOnly = ['admin_me', 'admin_stats', 'admin_scan', 'admin_find'];
  const me = await staffFrom(req, staffOnly.includes(action) ? 'staff' : 'admin');

  switch (action) {
    case 'admin_me':
      return { email: me.email, role: me.role, qpay: QPAY_ON, qpay_mode: QPAY_ON ? QPAY_MODE : 'off', mail: MAIL_ON, mail_via: RESEND_KEY ? 'resend' : (SMTP_USER ? 'smtp' : 'off') };

    case 'admin_stats':
      return await rpc('parade_stats');

    case 'admin_orders': {
      const rows = await q(db.from('parade_orders')
        .select(ORDER_COLS + ',parade_tickets(id,number,token,status,entry_at,food_at,drink_at)')
        .order('created_at', { ascending: false }).limit(3000));
      return { orders: rows };
    }

    case 'admin_order_check': {
      const o = await q(db.from('parade_orders').select('*').eq('id', b.id).single());
      if (!o.invoice_id) throw new HttpError(400, 'Энэ захиалга QPay нэхэмжлэхгүй.');
      const before = o.status;
      const after = await syncOrder(o, me.email);
      let qpayInfo = null;
      try { qpayInfo = await qpayCheck(o.invoice_id); } catch (e) { qpayInfo = { error: (e as Error).message }; }
      return { before, after: after.status, qpay: qpayInfo };
    }

    case 'admin_order_confirm': {                    // данс/бэлнээр төлсөн гэж гараар баталгаажуулах
      const method = ['qpay', 'transfer', 'cash', 'card', 'free'].includes(b.method) ? b.method : null;
      const cur = await q(db.from('parade_orders').select('status').eq('id', b.id).single());
      if (!['pending', 'expired'].includes(cur.status)) throw new HttpError(409, 'Зөвхөн хүлээгдэж буй эсвэл хугацаа дууссан захиалгыг баталгаажуулна.');
      const r = await rpc('parade_finalize_order', { p_order_id: b.id, p_payment_id: null, p_paid_amount: null, p_method: method, p_actor: me.email });
      if (!r.ok) throw new HttpError(409, r.reason === 'SOLD_OUT_REFUND' ? 'Тасалбар хүрэлцэхгүй байна — захиалгыг «буцаалт» төлөвт орууллаа.' : 'Цуцлагдсан захиалгыг баталгаажуулах боломжгүй.');
      if (!r.already) background(sendOrderEmails(b.id));
      log(me.email, 'confirm', { id: b.id, method });
      return r;
    }

    case 'admin_order_cancel': {
      const o = await q(db.from('parade_orders').select('*').eq('id', b.id).single());
      if (o.status === 'pending' && o.invoice_id && QPAY_ON) {
        const synced = await syncOrder(o, me.email);                                     // цуцлахаас өмнө төлсөн эсэхийг шалгана
        if (synced.status === 'paid') throw new HttpError(409, 'Энэ захиалга дөнгөж төлөгдсөн байна. Хуудсаа шинэчилнэ үү.');
        try { await qpay(`/invoice/${o.invoice_id}`, 'DELETE'); } catch (e) { console.error('cancel invoice', e); }
      }
      await q(db.from('parade_tickets').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('order_id', o.id).eq('status', 'valid'));
      const note = [o.note, b.reason ? `Цуцалсан: ${b.reason}` : 'Цуцалсан', me.email].filter(Boolean).join(' · ');
      await q(db.from('parade_orders').update({ status: o.status === 'refund' ? 'refund' : 'cancelled', note, updated_at: new Date().toISOString() }).eq('id', o.id));
      log(me.email, 'cancel_order', { code: o.code, status: o.status });
      return { ok: true };
    }

    case 'admin_order_refunded': {                   // буцаалт хийгдсэн гэж тэмдэглэх
      const o = await q(db.from('parade_orders').select('note').eq('id', b.id).single());
      await q(db.from('parade_orders').update({ status: 'cancelled', note: [o.note, `Мөнгө буцаасан · ${me.email}`].filter(Boolean).join(' · ') }).eq('id', b.id).eq('status', 'refund'));
      log(me.email, 'refunded', { id: b.id });
      return { ok: true };
    }

    case 'admin_order_update': {
      const patch: any = { updated_at: new Date().toISOString() };
      if (b.name) patch.name = String(b.name).trim();
      if (b.phone !== undefined) patch.phone = String(b.phone).replace(/[^\d+]/g, '');
      if (b.email !== undefined) patch.email = String(b.email).trim().toLowerCase() || null;
      if (b.phone2 !== undefined) patch.phone2 = String(b.phone2).replace(/[^\d+]/g, '') || null;
      if (b.aimag !== undefined) patch.aimag = String(b.aimag).trim() || null;
      if (b.sum !== undefined) patch.sum = String(b.sum).trim() || null;
      if (b.title !== undefined) patch.title = String(b.title).trim() || null;
      if (b.note !== undefined) patch.note = String(b.note);
      await q(db.from('parade_orders').update(patch).eq('id', b.id));
      if (patch.name) await q(db.from('parade_tickets').update({ holder_name: patch.name }).eq('order_id', b.id));
      log(me.email, 'update_order', { id: b.id, ...patch });
      return { ok: true };
    }

    case 'admin_resend': {
      const o = await q(db.from('parade_orders').select('id,status,email').eq('id', b.id).single());
      if (o.status !== 'paid') throw new HttpError(400, 'Зөвхөн төлөгдсөн захиалгад илгээнэ.');
      if (!o.email) throw new HttpError(400, 'Имэйл хаяг алга. Эхлээд имэйл нэмнэ үү.');
      const r = await sendOrderEmails(o.id, { force: true });
      if (r.error) throw new HttpError(502, r.error);
      return { ok: true };
    }

    case 'admin_resend_failed': {                   // имэйл очоогүй бүх төлөгдсөн захиалгад дахин илгээх (нэг удаад 15)
      if (!MAIL_ON) throw new HttpError(400, 'Имэйл тохиргоо (SMTP_USER/SMTP_PASS) хийгдээгүй байна.');
      const rows = await q(db.from('parade_orders').select('id,code,email,email_error,email_sent_at')
        .eq('status', 'paid').not('email', 'is', null)
        .or('email_error.not.is.null,email_sent_at.is.null').order('created_at').limit(15));
      const results: { code: string; ok: boolean; error: string | null }[] = [];
      for (const o of rows || []) {
        const r = await sendOrderEmails(o.id, { force: true });
        results.push({ code: o.code, ok: !r.error, error: r.error });
      }
      const left = await q(db.from('parade_orders').select('id', { count: 'exact', head: true })
        .eq('status', 'paid').not('email', 'is', null).or('email_error.not.is.null,email_sent_at.is.null'));
      log(me.email, 'resend_failed', { sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length });
      return { results, sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length };
    }

    case 'admin_tickets': {
      const rows = await q(db.from('parade_tickets')
        .select('id,number,token,status,holder_name,entry_at,entry_by,food_at,food_by,drink_at,drink_by,cancelled_at,created_at,parade_orders(id,code,name,phone,phone2,aimag,sum,title,email,pay_method,source)')
        .order('number').limit(5000));
      return { tickets: rows };
    }

    case 'admin_ticket_cancel': {
      await q(db.from('parade_tickets').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', b.id));
      log(me.email, 'cancel_ticket', { id: b.id });
      return { ok: true };
    }

    case 'admin_ticket_reset': {                     // уншуулсныг буцаах
      const col = ({ entry: 'entry', food: 'food', drink: 'drink' } as any)[b.mode];
      if (!col) throw new HttpError(400, 'mode буруу');
      await q(db.from('parade_tickets').update({ [`${col}_at`]: null, [`${col}_by`]: null }).eq('id', b.id));
      log(me.email, 'reset_scan', { id: b.id, mode: col });
      return { ok: true };
    }

    case 'admin_scan': {
      const mode = ['entry', 'food', 'drink', 'info'].includes(b.mode) ? b.mode : 'entry';
      return await rpc('parade_scan', { p_code: String(b.code || ''), p_mode: mode, p_actor: me.email });
    }

    case 'admin_issue': {
      const method = ['cash', 'transfer', 'card', 'qpay', 'free'].includes(b.method) ? b.method : 'cash';
      const qty = Math.floor(Number(b.qty));
      const amount = b.amount === '' || b.amount == null ? null : Math.max(0, Math.round(Number(b.amount)));
      const r = await rpc('parade_issue_manual', {
        p_name: String(b.name || '').trim(), p_phone: String(b.phone || '').replace(/[^\d+]/g, ''),
        p_email: String(b.email || '').trim().toLowerCase(), p_qty: qty, p_method: method,
        p_amount: amount, p_note: b.note ? String(b.note) : null, p_actor: me.email,
      });
      const extra: any = {};
      if (b.phone2) extra.phone2 = String(b.phone2).replace(/[^\d+]/g, '');
      if (b.aimag) extra.aimag = String(b.aimag).trim();
      if (b.sum) extra.sum = String(b.sum).trim();
      if (b.title) extra.title = String(b.title).trim();
      if (r.ok && Object.keys(extra).length) await db.from('parade_orders').update(extra).eq('id', r.order.id);
      if (r.ok) background(sendOrderEmails(r.order.id));
      log(me.email, 'issue', { code: r.order?.code, qty, method });
      return r;
    }

    case 'admin_draw': {
      const r = await rpc('parade_draw', { p_prize: String(b.prize || ''), p_pool: b.pool === 'entered' ? 'entered' : 'all', p_actor: me.email });
      log(me.email, 'draw', r);
      return r;
    }
    case 'admin_draws':
      return { draws: await q(db.from('parade_draws').select('*').order('id', { ascending: false }).limit(500)) };
    case 'admin_draw_void': {
      await q(db.from('parade_draws').update({ voided: true }).eq('id', b.id));
      log(me.email, 'draw_void', { id: b.id });
      return { ok: true };
    }

    case 'admin_settings_get':
      return { settings: await getSettings() };
    case 'admin_settings_save': {
      const patch: any = { updated_at: new Date().toISOString() };
      for (const k of SETTING_KEYS) if (b.settings && k in b.settings) patch[k] = b.settings[k] === '' && ['sales_until'].includes(k) ? null : b.settings[k];
      for (const k of ['price', 'start_no', 'total', 'max_per_order', 'hold_minutes', 'transfer_hold_hours']) if (k in patch) patch[k] = Math.round(Number(patch[k]));
      if ('sales_open' in patch) patch.sales_open = !!patch.sales_open;
      if ('total' in patch) {
        const sold = (await rpc('parade_stats')).sold;
        if (patch.total < sold) throw new HttpError(400, `Нийт тоо борлогдсон (${sold})-оос бага байж болохгүй.`);
      }
      const s = await q(db.from('parade_settings').update(patch).eq('id', 1).select('*').single());
      log(me.email, 'settings', patch);
      return { settings: s };
    }

    case 'admin_staff_list':
      return { staff: await q(db.from('parade_staff').select('*').order('created_at')) };
    case 'admin_staff_add': {
      const email = String(b.email || '').trim().toLowerCase();
      const role = b.role === 'admin' ? 'admin' : 'staff';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Имэйл буруу.');
      let note = '';
      if (b.password) {
        if (String(b.password).length < 6) throw new HttpError(400, 'Нууц үг дор хаяж 6 тэмдэгт.');
        const { error } = await db.auth.admin.createUser({ email, password: String(b.password), email_confirm: true });
        if (error) note = /already|registered|exists/i.test(error.message) ? 'Хэрэглэгч өмнө нь бүртгэлтэй байсан — нууц үг өөрчлөгдөөгүй.' : 'Хэрэглэгч үүсгэхэд алдаа: ' + error.message;
      }
      await q(db.from('parade_staff').upsert({ email, role }));
      log(me.email, 'staff_add', { email, role });
      return { ok: true, note };
    }
    case 'admin_staff_remove': {
      const email = String(b.email || '').toLowerCase();
      if (email === me.email) throw new HttpError(400, 'Өөрийгөө хасах боломжгүй.');
      await q(db.from('parade_staff').delete().eq('email', email));
      log(me.email, 'staff_remove', { email });
      return { ok: true };
    }

    case 'admin_test_email': {
      const to = String(b.to || '').trim() || me.email;
      const s = await getSettings();
      const qr = qrGif(siteBase(s) || 'https://example.com', 5);
      await sendMail({
        to: [to], subject: `${s.event_name} — туршилтын имэйл`,
        html: `<div style="font-family:Arial,sans-serif"><h2 style="color:${NAVY}">Имэйл ажиллаж байна ✓</h2><p>Энэ бол тасалбарын системийн туршилтын имэйл. Доорх QR зураг харагдаж байвал тасалбарын QR ч харагдана.</p><img src="cid:test@parade" width="140" height="140" alt="QR"></div>`,
        text: 'Имэйл ажиллаж байна.', attachments: [{ filename: 'qr.gif', content: qr, cid: 'test@parade' }],
      });
      return { ok: true, to };
    }

    case 'admin_test_qpay': {
      if (!QPAY_ON) return { ok: false, message: 'QPay тохиргоо (QPAY_CLIENT_ID, QPAY_CLIENT_SECRET, QPAY_INVOICE_CODE) хийгдээгүй.' };
      await qpayToken(true);
      return { ok: true, message: `QPay холболт амжилттай (${SANDBOX ? 'туршилтын sandbox' : 'жинхэнэ'} горим).` };
    }

    case 'admin_log':
      return { log: await q(db.from('parade_log').select('*').order('id', { ascending: false }).limit(300)) };
  }
  throw new HttpError(400, 'Үл мэдэгдэх үйлдэл: ' + action);
}

// ---------------------------------------------------------------- серверийн гол хэсэг
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const url = new URL(req.url);
  let body: any = {};
  if (req.method === 'POST') {
    const txt = await req.text();
    try { body = txt ? JSON.parse(txt) : {}; } catch { body = {}; }
  }
  const action = String(url.searchParams.get('action') || body.action || 'info');
  try {
    switch (action) {
      case 'info': return json(await actInfo());
      case 'create': return json(await actCreate(body, req));
      case 'status': return json(await actStatus(body));
      case 'ticket': return json(await actTicket(body.t ? body : { t: url.searchParams.get('t') }));
      case 'lookup': return json(await actLookup(body));
      case 'callback': return await actCallback(url);
    }
    if (action.startsWith('admin_')) return json(await admin(action, body, req));
    throw new HttpError(400, 'Үл мэдэгдэх үйлдэл');
  } catch (e) {
    const err = e instanceof HttpError ? e : new HttpError(500, (e as Error)?.message || 'Алдаа гарлаа');
    if (err.status >= 500) console.error(action, e);
    return json({ error: err.message }, err.status);
  }
});
