// ==UserScript==
// @name         B站直播消费账本
// @namespace    bili-live-ledger
// @version      0.2.0
// @description  在 B 站自己的页面里统计你的直播送礼消费：按主播、月份、礼物汇总，可导出。没有服务器，不需要扫码，数据只存在你的浏览器里。
// @license      MIT
// @match        https://live.bilibili.com/*
// @match        https://link.bilibili.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * bili-live-ledger —— 开源、无服务器的 B 站直播消费账本。
 *
 * 安全边界（可以对照代码自己检查）：
 *   - 只请求 bilibili.com 自己的接口（见下面的 API 常量），不连接任何第三方服务器。
 *   - 不读取 document.cookie，不保存任何登录凭证；请求由浏览器自动带上你在 B 站的登录状态。
 *   - 只读：不送礼、不点赞、不发弹幕、不关注，也不碰钱包。
 *   - 记录保存在本浏览器的 IndexedDB（live.bilibili.com / link.bilibili.com 站点下）。
 *
 * 同一个文件也被静态页面 index.html 引用：在非 bilibili.com 的页面上，它只提供离线查看器
 * （window.BiliLedger），不会发起任何网络请求。
 */
(function (root) {
  'use strict';

  const VERSION = '0.2.0';

  const API = {
    nav: 'https://api.bilibili.com/x/web-interface/nav',
    payRecord: 'https://api.live.bilibili.com/xlive/revenue/v2/giftStream/payRecord',
    blindInfo: 'https://api.live.bilibili.com/xlive/general-interface/v1/blindFirstWin/getInfo',
    blindDraws: 'https://api.live.bilibili.com/xlive/general-interface/v1/blind-box/drawStream',
  };

  // 送礼记录接口是 B 站 App 的接口，需要 App 签名。这是 Android 客户端公开的 appkey / appsec
  // （见 bilibili-API-collect 的「APP 签名」文档），只用来计算 sign 参数。
  const APP_KEY = '1d8b6e7d45233436';
  const APP_SEC = '560c52ccd288fed045859ed18bffd973';

  // 统计时统一用金瓜子做单位：1 元 = 1000 金瓜子，1 电池 = 100 金瓜子。
  // 送礼记录接口给的金额是电池（心动盲盒记作 150），盲盒接口给的价格是金瓜子。
  const GOLD_PER_YUAN = 1000;
  const GOLD_PER_BATTERY = 100;

  // 已知的盲盒礼物 id；同步时还会从送礼记录里找名字带「盲盒」的礼物补充进来。
  const KNOWN_BLIND_BOXES = [32251, 35206, 35942, 36062];

  const BACKTRACK_SECONDS = 7 * 86400; // 增量同步时回看 7 天，补上状态有变化（如退回）的记录
  const PAGE_DELAY_MS = 600;           // 翻页间隔，避免请求过快
  const RATE_LIMIT_WAIT_MS = 30000;    // 遇到 412 限流时等待一次再重试
  const RECORDS_PAGE_SIZE = 100;

  class LedgerError extends Error {
    constructor(message, code) {
      super(message);
      this.code = code;
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---------------------------------------------------------------- MD5（App 签名用）

  const MD5_SHIFT = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

  function md5(text) {
    const bytes = new TextEncoder().encode(text);
    const blocks = ((bytes.length + 8) >>> 6) + 1;
    const words = new Uint32Array(blocks * 16);
    for (let i = 0; i < bytes.length; i++) words[i >>> 2] |= bytes[i] << ((i % 4) * 8);
    words[bytes.length >>> 2] |= 0x80 << ((bytes.length % 4) * 8);
    words[blocks * 16 - 2] = (bytes.length * 8) >>> 0;
    words[blocks * 16 - 1] = Math.floor(bytes.length / 0x20000000);

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let off = 0; off < words.length; off += 16) {
      let a = a0, b = b0, c = c0, d = d0;
      for (let i = 0; i < 64; i++) {
        const round = i >> 4;
        let f, g;
        if (round === 0) { f = (b & c) | (~b & d); g = i; }
        else if (round === 1) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
        else if (round === 2) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
        else { f = c ^ (b | ~d); g = (7 * i) & 15; }
        const s = MD5_SHIFT[(round << 2) | (i & 3)];
        const sum = (a + f + MD5_K[i] + words[off + g]) >>> 0;
        a = d; d = c; c = b;
        b = (b + ((sum << s) | (sum >>> (32 - s)))) >>> 0;
      }
      a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
    }
    return [a0, b0, c0, d0]
      .map((x) => [0, 8, 16, 24].map((sh) => ((x >>> sh) & 255).toString(16).padStart(2, '0')).join(''))
      .join('');
  }

  function appSignedQuery(params, ts) {
    const all = { ...params, appkey: APP_KEY, ts: String(ts ?? Math.floor(Date.now() / 1000)) };
    const query = Object.keys(all)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(all[k])}`)
      .join('&');
    return `${query}&sign=${md5(query + APP_SEC)}`;
  }

  function payRecordUrl(nextId, ts) {
    const params = {
      actionKey: 'appkey',
      build: '8870400',
      c_locale: 'zh-Hans_CN',
      channel: 'bili',
      coin_type: 'gold',
      device: 'android',
      disable_rcmd: '0',
      mobi_app: 'android',
      page_size: '50',
      platform: 'android',
      s_locale: 'zh-Hans_CN',
      statistics: JSON.stringify({ appId: 1, platform: 3, version: '8.87.0', abtest: '' }),
      version: '8.87.0',
    };
    if (nextId) params.next_id = String(nextId);
    return `${API.payRecord}?${appSignedQuery(params, ts)}`;
  }

  // ---------------------------------------------------------------- 请求 B 站接口

  function makeBiliClient(fetchImpl) {
    async function getJson(url) {
      let res;
      try {
        res = await fetchImpl(url, { credentials: 'include', cache: 'no-store' });
      } catch {
        throw new LedgerError('网络请求失败，请检查网络后重试', 'network');
      }
      if (res.status === 412) throw new LedgerError('请求太频繁，被 B 站暂时限制了（412），过几分钟再试', 412);
      if (!res.ok) throw new LedgerError(`B 站接口返回 HTTP ${res.status}`, res.status);
      const json = await res.json();
      if (json.code === -101) throw new LedgerError('还没登录 B 站，或者登录已经失效', -101);
      if (json.code === -352) throw new LedgerError('触发了 B 站的风控（-352），请稍后再试', -352);
      if (json.code !== 0) throw new LedgerError(`B 站接口返回错误 ${json.code}：${json.message || '未知原因'}`, json.code);
      return json.data;
    }
    return { getJson };
  }

  async function fetchAccount(client) {
    try {
      const nav = await client.getJson(API.nav);
      return nav && nav.isLogin ? { uid: toNum(nav.mid), uname: String(nav.uname || ''), face: String(nav.face || '') } : null;
    } catch (e) {
      if (e.code === -101) return null;
      throw e;
    }
  }

  // 按 next_id 翻页读取送礼记录（最新的在前）。newestTs 为本地最新记录的时间，传 0 表示全量。
  // 中途出错时返回已经拿到的部分，调用方可以先保存，下次再补全。
  async function fetchPayRecords(client, { newestTs = 0, onPage, wait = sleep, delayMs = PAGE_DELAY_MS, maxPages = 2000 } = {}) {
    const until = newestTs ? newestTs - BACKTRACK_SECONDS : 0;
    const seen = new Set();
    const records = [];
    let nextId = '';
    let page = 0;
    let retried = false;
    while (page < maxPages) {
      page++;
      let data;
      try {
        data = await client.getJson(payRecordUrl(nextId));
      } catch (e) {
        if (e.code === 412 && !retried) {
          retried = true;
          page--;
          onPage?.({ page, total: records.length, waitingMs: RATE_LIMIT_WAIT_MS });
          await wait(RATE_LIMIT_WAIT_MS);
          continue;
        }
        return { records, complete: false, error: e };
      }
      retried = false;
      const list = Array.isArray(data?.list) ? data.list : [];
      let fresh = 0;
      let reachedKnown = false;
      for (const r of list) {
        if (until && toNum(r.timestamp) < until) { reachedKnown = true; break; }
        const id = String(r.id);
        if (seen.has(id)) continue;
        seen.add(id);
        records.push(r);
        fresh++;
      }
      onPage?.({ page, total: records.length });
      nextId = data?.params?.next_id ?? '';
      if (reachedKnown || !list.length || !nextId) return { records, complete: true, error: null };
      if (!fresh) return { records, complete: false, error: new LedgerError('接口重复返回同一页，已停止翻页', 'loop') };
      await wait(delayMs);
    }
    return { records, complete: false, error: new LedgerError(`已达到翻页上限 ${maxPages} 页`, 'max-pages') };
  }

  function mergeRecords(existing, incoming) {
    const byId = new Map(existing.map((r) => [String(r.id), r]));
    let added = 0;
    for (const r of incoming) {
      const id = String(r.id);
      if (!byId.has(id)) added++;
      byId.set(id, r);
    }
    const records = [...byId.values()].sort((a, b) => toNum(b.timestamp) - toNum(a.timestamp));
    return { records, added };
  }

  // ---------------------------------------------------------------- 盲盒（实验性）

  async function fetchBlindInfo(client, id) {
    const d = await client.getJson(`${API.blindInfo}?gift_id=${encodeURIComponent(id)}`);
    if (!d || !Array.isArray(d.gifts) || !d.gifts.length) return null;
    return {
      id: toNum(id),
      name: String(d.blind_gift_name || `盲盒 ${id}`),
      priceGold: toNum(d.blind_price),
      gifts: d.gifts.map((g) => ({ giftId: toNum(g.gift_id), name: String(g.gift_name || ''), priceGold: toNum(g.price) })),
    };
  }

  async function fetchBlindDraws(client, id, { sinceTs = 0, onPage, wait = sleep, delayMs = PAGE_DELAY_MS, maxPages = 100 } = {}) {
    const draws = [];
    let extra = '';
    for (let page = 1; page <= maxPages; page++) {
      const d = await client.getJson(`${API.blindDraws}?gift_id=${encodeURIComponent(id)}&page_size=50${extra}`);
      const list = Array.isArray(d?.list) ? d.list : [];
      let reachedKnown = false;
      for (const r of list) {
        if (sinceTs && toNum(r.timestamp) <= sinceTs) { reachedKnown = true; break; }
        draws.push(r);
      }
      onPage?.({ page, total: draws.length });
      const params = d?.params && typeof d.params === 'object' ? d.params : {};
      const more = 'have_more' in params ? truthy(params.have_more) : truthy(d?.has_more ?? d?.isMore);
      if (reachedKnown || !list.length || !more) break;
      extra = Object.entries(params)
        .filter(([k, v]) => k !== 'have_more' && v !== undefined && v !== null)
        .map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('');
      await wait(delayMs);
    }
    return draws;
  }

  function blindBoxSummary(info, draws) {
    const prices = new Map(info.gifts.map((g) => [g.giftId, g.priceGold]));
    const outcomes = new Map();
    let boxes = 0, valueGold = 0, unknown = 0;
    for (const d of draws) {
      const n = toNum(d.gift_num) || 1;
      const price = prices.get(toNum(d.gift_id));
      boxes += n;
      if (price === undefined) unknown += n;
      else valueGold += price * n;
      const name = String(d.gift_name || '未知礼物');
      const o = outcomes.get(name) || { name, num: 0, priceGold: price ?? null };
      o.num += n;
      outcomes.set(name, o);
    }
    const costGold = boxes * info.priceGold;
    return {
      boxes,
      costGold,
      valueGold,
      profitGold: valueGold - costGold,
      unknown,
      outcomes: [...outcomes.values()].sort((a, b) => b.num - a.num),
    };
  }

  function blindBoxCandidates(rawRecords, stored) {
    const ids = new Set(KNOWN_BLIND_BOXES);
    for (const r of rawRecords) if (/盲盒/.test(String(r.gift_name || '')) && toNum(r.gift_id)) ids.add(toNum(r.gift_id));
    for (const id of Object.keys(stored || {})) ids.add(toNum(id));
    return [...ids].filter(Boolean);
  }

  // ---------------------------------------------------------------- 数据整理

  function toNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    const n = Number(String(v ?? '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  function truthy(v) {
    return v === true || v === 1 || v === '1' || v === 'true';
  }

  const present = (v) => v !== undefined && v !== null && v !== '';

  function normalize(r) {
    const bag = String(r.bag_desc || '');
    const status = String(r.status_msg || '');
    const refunded = /退/.test(status);
    const fromBag = /包裹/.test(bag);
    return {
      id: String(r.id),
      ts: toNum(r.timestamp),
      giftId: toNum(r.gift_id),
      giftName: String(r.gift_name || '未知礼物'),
      giftNum: toNum(r.gift_num) || 1,
      giftImg: String(r.gift_img || ''),
      gold: toNum(present(r.pay_coin) ? r.pay_coin : r.coin) * GOLD_PER_BATTERY,
      valueGold: toNum(present(r.coin) ? r.coin : r.pay_coin) * GOLD_PER_BATTERY,
      ruid: toNum(r.ruid),
      rname: String(r.r_uname || r.rname || (r.ruid ? `UID ${r.ruid}` : '未知主播')),
      bag,
      status,
      refunded,
      fromBag,
      paid: !refunded && !fromBag,
    };
  }

  function monthKey(ts) {
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function monthRange(first, last) {
    const out = [];
    let [y, m] = first.split('-').map(Number);
    const [ly, lm] = last.split('-').map(Number);
    while (y < ly || (y === ly && m <= lm)) {
      out.push(`${y}-${String(m).padStart(2, '0')}`);
      m++;
      if (m > 12) { m = 1; y++; }
    }
    return out;
  }

  function summarize(rawRecords) {
    const rows = rawRecords.map(normalize).sort((a, b) => b.ts - a.ts);
    const totals = { paidGold: 0, paidCount: 0, giftNum: 0, refundGold: 0, refundCount: 0, bagCount: 0, bagValueGold: 0, firstTs: 0, lastTs: 0 };
    const streamers = new Map();
    const months = new Map();
    const gifts = new Map();
    for (const r of rows) {
      if (r.ts) {
        totals.firstTs = totals.firstTs ? Math.min(totals.firstTs, r.ts) : r.ts;
        totals.lastTs = Math.max(totals.lastTs, r.ts);
      }
      if (r.refunded) { totals.refundGold += r.gold; totals.refundCount++; continue; }
      if (r.fromBag) { totals.bagCount += r.giftNum; totals.bagValueGold += r.valueGold; continue; }
      totals.paidGold += r.gold;
      totals.paidCount++;
      totals.giftNum += r.giftNum;
      // rows 按时间倒序，第一次遇到的名字就是主播最新的名字
      const s = streamers.get(r.ruid) || { ruid: r.ruid, rname: r.rname, gold: 0, count: 0, firstTs: r.ts, lastTs: r.ts };
      s.gold += r.gold;
      s.count++;
      s.firstTs = Math.min(s.firstTs, r.ts);
      s.lastTs = Math.max(s.lastTs, r.ts);
      streamers.set(r.ruid, s);
      if (r.ts) months.set(monthKey(r.ts), (months.get(monthKey(r.ts)) || 0) + r.gold);
      const key = `${r.giftId}:${r.giftName}`;
      const g = gifts.get(key) || { giftId: r.giftId, giftName: r.giftName, giftImg: r.giftImg, num: 0, gold: 0 };
      g.num += r.giftNum;
      g.gold += r.gold;
      gifts.set(key, g);
    }
    const keys = [...months.keys()].sort();
    const monthList = keys.length ? monthRange(keys[0], keys[keys.length - 1]).map((month) => ({ month, gold: months.get(month) || 0 })) : [];
    return {
      rows,
      totals,
      streamers: [...streamers.values()].sort((a, b) => b.gold - a.gold),
      months: monthList,
      gifts: [...gifts.values()].sort((a, b) => b.gold - a.gold),
    };
  }

  // ---------------------------------------------------------------- 格式化与导入导出

  const pad2 = (n) => String(n).padStart(2, '0');
  function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts * 1000);
    return `${fmtDate(ts)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  const fmtNum = (n, digits = 0) => Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: digits });
  const yuan = (gold) => `¥${fmtNum(gold / GOLD_PER_YUAN, 2)}`;
  const battery = (gold) => fmtNum(gold / GOLD_PER_BATTERY, 1);
  function shortYuan(gold) {
    const v = gold / GOLD_PER_YUAN;
    return v >= 10000 ? `${fmtNum(v / 10000, 1)}万` : fmtNum(v, v >= 100 ? 0 : 1);
  }

  function csvCell(v) {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // 防止 Excel 把名字当公式执行
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  const csvYuan = (gold) => Math.round(gold / 10) / 100;
  const csvBattery = (gold) => Math.round(gold) / 100;

  function csvTable(header, rows) {
    return String.fromCharCode(0xfeff) + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  }

  // rows 是 normalize 之后的记录，按传入的顺序输出
  function recordsCsv(rows) {
    return csvTable(['时间', '主播', '主播UID', '礼物', '数量', '元', '电池', '来源', '状态', '记录ID'],
      rows.map((r) => [fmtTime(r.ts), r.rname, r.ruid, r.giftName, r.giftNum, csvYuan(r.gold), csvBattery(r.gold), r.bag, r.status, r.id]));
  }

  function toCsv(rawRecords) {
    return recordsCsv(rawRecords.map(normalize).sort((a, b) => b.ts - a.ts));
  }

  function streamersCsv(streamers) {
    return csvTable(['主播', '主播UID', '元', '电池', '笔数', '第一次', '最近一次'],
      streamers.map((s) => [s.rname, s.ruid, csvYuan(s.gold), csvBattery(s.gold), s.count, fmtDate(s.firstTs), fmtDate(s.lastTs)]));
  }

  function giftsCsv(gifts) {
    return csvTable(['礼物', '礼物ID', '数量', '元', '电池'],
      gifts.map((g) => [g.giftName, g.giftId, g.num, csvYuan(g.gold), csvBattery(g.gold)]));
  }

  function monthsCsv(months) {
    return csvTable(['月份', '元', '电池'], months.map((m) => [m.month, csvYuan(m.gold), csvBattery(m.gold)]));
  }

  function exportJson(ledger) {
    return JSON.stringify({
      format: 'bili-live-ledger',
      version: 1,
      exportedAt: new Date().toISOString(),
      uid: ledger.uid,
      uname: ledger.uname,
      records: ledger.records,
      blind: ledger.blind || {},
    }, null, 2);
  }

  function parseImport(text) {
    let d;
    try {
      d = JSON.parse(text);
    } catch {
      throw new LedgerError('文件不是有效的 JSON', 'format');
    }
    if (!d || d.format !== 'bili-live-ledger' || !Array.isArray(d.records)) throw new LedgerError('这不是本工具导出的文件', 'format');
    return {
      uid: toNum(d.uid),
      uname: String(d.uname || ''),
      records: d.records.filter((r) => r && typeof r === 'object' && r.id != null),
      blind: d.blind && typeof d.blind === 'object' && !Array.isArray(d.blind) ? d.blind : {},
      syncedAt: 0,
      fullSyncDone: false,
    };
  }

  // ---------------------------------------------------------------- 示例数据（离线预览用，全是虚构的）

  function mulberry32(seed) {
    return function () {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function sampleLedger(now = Math.floor(Date.now() / 1000)) {
    const rand = mulberry32(20261022);
    const streamers = [
      [900001, '示例主播·星野', 5], [900002, '示例主播·阿宁', 3], [900003, '示例主播·小鹿', 2],
      [900004, '示例主播·北辰', 1.5], [900005, '示例主播·糖糖', 1], [900006, '示例主播·老周', 0.6],
    ];
    const gifts = [ // 价格单位和送礼记录接口一致：电池
      [910001, '小花花', 1, 12], [910002, '这个好诶', 10, 6], [910003, '打call', 50, 4],
      [910004, '告白气球', 520, 1.2], [910005, '星愿水晶球', 1000, 0.5], [910006, '小电视飞船', 12450, 0.08],
    ];
    const pick = (list, wi) => {
      const total = list.reduce((a, x) => a + x[wi], 0);
      let r = rand() * total;
      for (const x of list) { r -= x[wi]; if (r <= 0) return x; }
      return list[list.length - 1];
    };
    const records = [];
    for (let i = 0; i < 420; i++) {
      const [ruid, rname] = pick(streamers, 2);
      const [giftId, giftName, price] = pick(gifts, 3);
      const num = price <= 10 ? 1 + Math.floor(rand() * 10) : 1;
      const ts = now - Math.floor(rand() * 300 * 86400);
      const roll = rand();
      records.push({
        id: `demo-${i}`,
        timestamp: ts,
        gift_id: giftId,
        gift_name: giftName,
        gift_num: num,
        gift_img: '',
        pay_coin: roll < 0.06 ? '0' : String(price * num),
        coin: String(price * num),
        ruid,
        r_uname: rname,
        bag_desc: roll < 0.06 ? '包裹道具' : '',
        status_msg: roll > 0.985 ? '已退回' : '',
      });
    }
    records.sort((a, b) => b.timestamp - a.timestamp);
    const info = {
      id: 990001,
      name: '示例盲盒',
      priceGold: 15000,
      gifts: [
        { giftId: 990011, name: '小幸运', priceGold: 5000 }, { giftId: 990012, name: '心动卡', priceGold: 12000 },
        { giftId: 990013, name: '梦幻城堡', priceGold: 60000 }, { giftId: 990014, name: '星河列车', priceGold: 200000 },
      ],
    };
    const draws = [];
    for (let i = 0; i < 90; i++) {
      const r = rand();
      const g = r < 0.62 ? info.gifts[0] : r < 0.93 ? info.gifts[1] : r < 0.995 ? info.gifts[2] : info.gifts[3];
      draws.push({ gift_id: g.giftId, gift_name: g.name, gift_num: 1, timestamp: now - Math.floor(rand() * 120 * 86400) });
    }
    return {
      uid: 0,
      uname: '示例账号',
      records,
      blind: { 990001: { info, draws, syncedAt: now * 1000 } },
      syncedAt: now * 1000,
      fullSyncDone: true,
    };
  }

  const core = {
    VERSION, API, GOLD_PER_YUAN, GOLD_PER_BATTERY, KNOWN_BLIND_BOXES, LedgerError,
    md5, appSignedQuery, payRecordUrl, makeBiliClient, fetchAccount, fetchPayRecords, mergeRecords,
    fetchBlindInfo, fetchBlindDraws, blindBoxSummary, blindBoxCandidates,
    toNum, normalize, monthKey, summarize, fmtDate, fmtTime, yuan, battery, shortYuan,
    csvCell, toCsv, recordsCsv, streamersCsv, giftsCsv, monthsCsv, exportJson, parseImport, sampleLedger,
  };

  if (typeof module === 'object' && module && module.exports && typeof document === 'undefined') {
    module.exports = core;
    return;
  }

  // ---------------------------------------------------------------- 本地存储（IndexedDB）

  const DB_NAME = 'bili-live-ledger';
  const DB_STORE = 'ledgers';

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbRun(mode, fn) {
    const db = await idbOpen();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, mode);
        const req = fn(tx.objectStore(DB_STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  const storage = {
    get: (key) => idbRun('readonly', (s) => s.get(key)),
    set: (key, value) => idbRun('readwrite', (s) => s.put(value, key)),
    remove: (key) => idbRun('readwrite', (s) => s.delete(key)),
  };

  const ledgerKey = (uid) => `uid:${uid}`;

  function emptyLedger(account) {
    return { uid: account.uid, uname: account.uname, records: [], blind: {}, syncedAt: 0, fullSyncDone: false };
  }

  // ---------------------------------------------------------------- 界面

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function img(url) {
    const u = String(url || '').replace(/^http:\/\//, 'https://');
    return /^https:\/\/[^\s"'<>]+$/.test(u) ? `<img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="noimg"></span>';
  }

  function download(filename, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function pickFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = () => resolve(input.files && input.files[0] ? input.files[0] : null);
      input.click();
    });
  }

  const STYLE = `
:host { all: initial; }
.root {
  --bg: #f6f7f9; --panel: #fff; --text: #18191c; --muted: #61666d; --line: #e3e5e7; --soft: #f1f2f3;
  --accent: #fb7299; --accent-ink: #fff; --accent-weak: #fde8ef; --good: #15935a; --bad: #e0464c; --info: #2f6fde;
  --info-bg: #eaf1ff; --bad-bg: #fdecec; --good-bg: #e7f6ee;
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
  color: var(--text); -webkit-font-smoothing: antialiased;
}
@media (prefers-color-scheme: dark) {
  .root { --bg: #0f1012; --panel: #18191c; --text: #e7e8ea; --muted: #9aa0a8; --line: #2b2d32; --soft: #222428;
    --accent-weak: #3b2129; --info-bg: #16233b; --bad-bg: #3a1a1c; --good-bg: #143022; }
}
*, *::before, *::after { box-sizing: border-box; }
button, input, select { font: inherit; color: inherit; }
.launcher { position: fixed; left: 16px; bottom: 24px; z-index: 2147483000; border: 0; border-radius: 999px;
  padding: 8px 15px; background: var(--accent); color: var(--accent-ink); font-weight: 600; cursor: pointer;
  box-shadow: 0 4px 14px rgba(251, 114, 153, .45); }
.overlay { position: fixed; inset: 0; z-index: 2147483001; background: rgba(0, 0, 0, .45);
  display: flex; align-items: center; justify-content: center; padding: 24px; }
.overlay .panel { width: min(1100px, 100%); height: min(880px, 100%); box-shadow: 0 20px 60px rgba(0, 0, 0, .3); }
.panel { background: var(--bg); border-radius: 14px; overflow: hidden; display: flex; flex-direction: column; }
.mode-inline .panel { border: 1px solid var(--line); min-height: 600px; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px;
  background: var(--panel); border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.logo { width: 34px; height: 34px; border-radius: 9px; background: var(--accent); color: #fff; display: grid;
  place-items: center; font-weight: 700; flex: none; }
.title { font-weight: 700; font-size: 16px; }
.sub { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.actions { display: flex; gap: 8px; flex: none; }
.btn { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 6px 12px; cursor: pointer;
  white-space: nowrap; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; }
.btn:hover:not(:disabled) { border-color: var(--accent); }
.btn:disabled { opacity: .5; cursor: default; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.btn.danger { color: var(--bad); }
.tabs { display: flex; gap: 2px; padding: 0 12px; background: var(--panel); border-bottom: 1px solid var(--line); overflow-x: auto; }
.tab { border: 0; background: none; padding: 10px 12px; border-bottom: 2px solid transparent; color: var(--muted);
  cursor: pointer; white-space: nowrap; }
.tab.on { color: var(--text); border-bottom-color: var(--accent); font-weight: 600; }
.body { flex: 1; overflow: auto; padding: 16px 18px 28px; }
.note { padding: 8px 18px; font-size: 13px; }
.note.info { background: var(--info-bg); color: var(--info); }
.note.error { background: var(--bad-bg); color: var(--bad); }
.note.ok { background: var(--good-bg); color: var(--good); }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
.kpi { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px; min-width: 0; }
.kpi .k { color: var(--muted); font-size: 12px; }
.kpi .v { font-size: 22px; font-weight: 700; margin-top: 2px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kpi .s { color: var(--muted); font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; margin-top: 12px; }
.card h3 { margin: 0 0 10px; font-size: 15px; }
.card p { margin: 0 0 10px; }
.card-h { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.months { display: flex; align-items: flex-end; gap: 4px; overflow-x: auto; padding-bottom: 2px; }
.mcol { flex: 1 0 24px; display: flex; flex-direction: column; align-items: center; min-width: 24px; }
.mtrack { height: 180px; width: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; }
.mval { font-size: 10px; color: var(--muted); height: 16px; line-height: 16px; white-space: nowrap; }
.mbar { width: 70%; max-width: 30px; min-height: 2px; background: var(--accent); border-radius: 4px 4px 0 0; }
.mlab { font-size: 11px; color: var(--muted); margin-top: 4px; text-align: center; line-height: 1.25; height: 28px; }
.hrow { display: grid; grid-template-columns: minmax(80px, 180px) 1fr auto; align-items: center; gap: 10px; padding: 6px 4px;
  cursor: pointer; border-radius: 6px; }
.hrow:hover { background: var(--soft); }
.hname { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.htrack { height: 10px; background: var(--soft); border-radius: 5px; overflow: hidden; }
.hfill { height: 100%; background: var(--accent); border-radius: 5px; }
.hval { font-variant-numeric: tabular-nums; font-weight: 600; }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; }
.push { margin-left: auto; }
.input { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 6px 10px; min-width: 0; }
input.input { flex: 1 1 200px; max-width: 320px; }
.table-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 8px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; }
th { position: sticky; top: 0; background: var(--panel); color: var(--muted); font-weight: 500; z-index: 1; white-space: nowrap; }
tbody tr:last-child td { border-bottom: 0; }
tr.click { cursor: pointer; }
tr.click:hover td { background: var(--soft); }
tr.dim td { color: var(--muted); }
.r { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.strong { font-weight: 600; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.center { text-align: center; }
.nowrap { white-space: nowrap; }
.gift { display: flex; align-items: center; gap: 6px; }
.gift img, .noimg { width: 24px; height: 24px; object-fit: contain; flex: none; }
.chip { display: inline-flex; align-items: center; gap: 2px; padding: 3px 4px 3px 10px; border-radius: 999px; background: var(--accent-weak); }
.chip button { border: 0; background: none; cursor: pointer; padding: 0 6px; }
.pager { display: flex; align-items: center; justify-content: center; gap: 12px; margin-top: 12px; }
.empty { text-align: center; padding: 56px 16px; max-width: 540px; margin: 0 auto; }
.empty h2 { margin: 0 0 8px; font-size: 18px; }
.empty p { color: var(--muted); margin: 0 0 18px; }
.empty .btn { margin: 4px; }
.hint { color: var(--muted); font-size: 12px; margin: 10px 2px 0; }
.tag { font-size: 11px; font-weight: 500; padding: 1px 6px; border-radius: 6px; background: var(--accent-weak); color: var(--accent);
  margin-left: 6px; vertical-align: 2px; }
.good { color: var(--good); }
.bad { color: var(--bad); }
.btns { display: flex; flex-wrap: wrap; gap: 8px; }
.link { border: 0; background: none; color: var(--accent); cursor: pointer; padding: 0; }
ul { margin: 0; padding-left: 18px; }
li { margin: 4px 0; }
.spin { width: 28px; height: 28px; border: 3px solid var(--line); border-top-color: var(--accent); border-radius: 50%;
  animation: spin .8s linear infinite; margin: 72px auto; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 640px) {
  .overlay { padding: 0; }
  .overlay .panel { height: 100%; border-radius: 0; }
  .body { padding: 12px; }
  .kpi .v { font-size: 18px; }
  th, td { padding: 6px 8px; }
  .hrow { grid-template-columns: minmax(60px, 110px) 1fr auto; }
}
`;

  const TABS = [
    ['overview', '总览'], ['streamers', '主播'], ['gifts', '礼物'],
    ['records', '明细'], ['blind', '盲盒'], ['data', '数据'],
  ];

  function createApp({ mode, mount, readOnly, client, ledger }) {
    const host = document.createElement('div');
    host.setAttribute('data-bili-live-ledger', VERSION);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${STYLE}</style><div class="root mode-${mode}"></div>`;
    mount.appendChild(host);
    const rootEl = shadow.querySelector('.root');

    const state = {
      open: mode === 'inline',
      loaded: !!ledger,
      loading: false,
      account: null,
      ledger: ledger || null,
      demo: false,
      view: 'overview',
      busy: false,
      progress: '',
      error: '',
      notice: '',
      streamerQuery: '',
      giftQuery: '',
      filter: { q: '', month: '', ruid: 0 },
      page: 1,
    };

    let cache = { key: '', value: null };
    function summary() {
      const l = state.ledger;
      const key = l ? `${l.uid}:${l.records.length}:${l.syncedAt}:${state.demo}` : '';
      if (cache.key !== key || !cache.value) cache = { key, value: summarize(l ? l.records : []) };
      return cache.value;
    }

    // 表格显示和导出 CSV 共用同一套筛选
    function filteredRows(sum) {
      const f = state.filter;
      const q = f.q.trim().toLowerCase();
      return sum.rows.filter((r) => (!f.ruid || r.ruid === f.ruid)
        && (!f.month || monthKey(r.ts) === f.month)
        && (!q || r.rname.toLowerCase().includes(q) || r.giftName.toLowerCase().includes(q)));
    }

    function filteredStreamers(sum) {
      const q = state.streamerQuery.trim().toLowerCase();
      return sum.streamers.filter((s) => !q || s.rname.toLowerCase().includes(q) || String(s.ruid).includes(q));
    }

    function filteredGifts(sum) {
      const q = state.giftQuery.trim().toLowerCase();
      return sum.gifts.filter((g) => !q || g.giftName.toLowerCase().includes(q));
    }

    const exportButton = (kind, enabled) =>
      `<button class="btn push" data-action="export-view" data-kind="${kind}" ${enabled ? '' : 'disabled'}>导出 CSV</button>`;

    // ------------------------------------------------ 模板

    function html() {
      if (mode === 'inline') return panelHtml();
      const launcher = state.open ? '' : '<button class="launcher" data-action="launch" title="打开直播消费账本">账本</button>';
      return `${launcher}${state.open ? `<div class="overlay" data-action="backdrop">${panelHtml()}</div>` : ''}`;
    }

    function panelHtml() {
      const l = state.ledger;
      const who = state.demo ? '示例数据（虚构）'
        : state.account ? `${state.account.uname} · UID ${state.account.uid}`
          : l ? `${l.uname || '导入的数据'}${l.uid ? ` · UID ${l.uid}` : ''}` : '未登录';
      const canSync = !readOnly && state.account && !state.demo;
      return `
<section class="panel" role="dialog" aria-label="直播消费账本">
  <header class="top">
    <div class="brand"><span class="logo">账</span>
      <div style="min-width:0"><div class="title">直播消费账本</div><div class="sub">${esc(who)}</div></div></div>
    <div class="actions">
      ${state.demo && !readOnly ? '<button class="btn" data-action="exit-demo">退出示例</button>' : ''}
      ${canSync ? `<button class="btn primary" data-action="sync" ${state.busy ? 'disabled' : ''}>${state.busy ? '同步中…' : '同步记录'}</button>` : ''}
      ${mode === 'overlay' ? '<button class="btn" data-action="close" aria-label="关闭">✕</button>' : ''}
    </div>
  </header>
  ${state.progress ? `<div class="note info">${esc(state.progress)}</div>` : ''}
  ${state.error ? `<div class="note error">${esc(state.error)}</div>` : ''}
  ${state.notice ? `<div class="note ok">${esc(state.notice)}</div>` : ''}
  ${bodyHtml()}
</section>`;
    }

    function bodyHtml() {
      if (state.loading) return '<div class="body"><div class="spin"></div></div>';
      if (!state.ledger) return `<div class="body">${loginHtml()}</div>`;
      const tabs = TABS.map(([id, label]) => `<button class="tab ${state.view === id ? 'on' : ''}" data-action="view" data-view="${id}">${label}</button>`).join('');
      const sum = summary();
      const views = { overview: overviewHtml, streamers: streamersHtml, gifts: giftsHtml, records: recordsHtml, blind: blindHtml, data: dataHtml };
      return `<nav class="tabs">${tabs}</nav><div class="body">${(views[state.view] || overviewHtml)(sum)}</div>`;
    }

    function loginHtml() {
      return `
<div class="empty">
  <h2>先登录 B 站</h2>
  <p>账本直接用你在这个浏览器里的 B 站登录状态读取送礼记录。不需要扫码，也不会把任何东西发到 B 站以外的服务器。</p>
  <a class="btn primary" href="https://passport.bilibili.com/login" target="_blank" rel="noopener">去 B 站登录</a>
  <button class="btn" data-action="demo">先用示例数据看看</button>
</div>`;
    }

    function noRecordsHtml() {
      const canSync = !readOnly && state.account && !state.demo;
      return `
<div class="empty">
  <h2>还没有本地记录</h2>
  <p>${canSync ? '点「同步记录」，从 B 站读取你的直播送礼记录。第一次会把能拿到的记录都读一遍，可能要一两分钟。' : '这份数据里没有送礼记录。'}</p>
  ${canSync ? `<button class="btn primary" data-action="sync" ${state.busy ? 'disabled' : ''}>同步记录</button>` : ''}
</div>`;
    }

    const kpi = (k, v, s) => `<div class="kpi"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s || '')}</div></div>`;

    function overviewHtml(sum) {
      if (!sum.rows.length) return noRecordsHtml();
      const t = sum.totals;
      const top = sum.streamers.slice(0, 8);
      const maxS = top.length ? top[0].gold || 1 : 1;
      const months = sum.months.slice(-24);
      const maxM = Math.max(1, ...months.map((m) => m.gold));
      const extra = [];
      if (t.refundCount) extra.push(`${fmtNum(t.refundCount)} 笔已退回（${yuan(t.refundGold)}）`);
      if (t.bagCount) extra.push(`${fmtNum(t.bagCount)} 个包裹礼物（价值 ${yuan(t.bagValueGold)}）`);
      const bars = months.map((m) => {
        const ratio = m.gold / maxM;
        const year = m.month.endsWith('-01') || m === months[0] ? m.month.slice(0, 4) : '';
        return `<div class="mcol" title="${esc(m.month)}：${esc(yuan(m.gold))}">
  <div class="mtrack"><div class="mval">${m.gold ? esc(shortYuan(m.gold)) : ''}</div><div class="mbar" style="height:calc((100% - 16px) * ${ratio.toFixed(4)})"></div></div>
  <div class="mlab">${esc(String(Number(m.month.slice(5))))}月${year ? `<br>${esc(year)}` : ''}</div></div>`;
      }).join('');
      const topRows = top.map((s) => `<div class="hrow" data-action="filter-streamer" data-ruid="${esc(s.ruid)}" title="查看 ${esc(s.rname)} 的明细">
  <div class="hname">${esc(s.rname)}</div><div class="htrack"><div class="hfill" style="width:${((s.gold / maxS) * 100).toFixed(1)}%"></div></div>
  <div class="hval">${esc(yuan(s.gold))}</div></div>`).join('');
      return `
<div class="kpis">
  ${kpi('累计花费', yuan(t.paidGold), `${battery(t.paidGold)} 电池`)}
  ${kpi('送礼', `${fmtNum(t.paidCount)} 笔`, `共 ${fmtNum(t.giftNum)} 个礼物`)}
  ${kpi('送过的主播', `${fmtNum(sum.streamers.length)} 位`, top.length ? `最多：${top[0].rname}` : '')}
  ${kpi('记录范围', fmtDate(t.firstTs), `到 ${fmtDate(t.lastTs)}`)}
</div>
${extra.length ? `<p class="hint">另有 ${esc(extra.join('、'))}，没有算进花费。</p>` : ''}
<div class="card">
  <div class="card-h"><h3>每月花费</h3><span class="muted small">${months.length < sum.months.length ? `最近 ${months.length} 个月 · ` : ''}<button class="link" data-action="export-view" data-kind="months">导出 CSV</button></span></div>
  <div class="months">${bars}</div>
</div>
<div class="card">
  <div class="card-h"><h3>花费最多的主播</h3><button class="link" data-action="view" data-view="streamers">全部主播</button></div>
  ${topRows}
</div>`;
    }

    function streamersHtml(sum) {
      if (!sum.rows.length) return noRecordsHtml();
      const list = filteredStreamers(sum);
      const rows = list.map((s, i) => `<tr class="click" data-action="filter-streamer" data-ruid="${esc(s.ruid)}">
  <td class="muted">${i + 1}</td><td><div>${esc(s.rname)}</div><div class="muted small">UID ${esc(s.ruid)}</div></td>
  <td class="r strong">${esc(yuan(s.gold))}</td><td class="r">${esc(battery(s.gold))}</td><td class="r">${fmtNum(s.count)}</td>
  <td class="nowrap">${fmtDate(s.firstTs)}</td><td class="nowrap">${fmtDate(s.lastTs)}</td></tr>`).join('');
      return `
<div class="toolbar"><input class="input" data-input="streamerQuery" placeholder="搜索主播名或 UID" value="${esc(state.streamerQuery)}">
  <span class="muted">${fmtNum(list.length)} 位主播，点一行看明细</span>${exportButton('streamers', list.length)}</div>
<div class="table-wrap"><table>
  <thead><tr><th>#</th><th>主播</th><th class="r">花费</th><th class="r">电池</th><th class="r">笔数</th><th>第一次</th><th>最近一次</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="7" class="muted center">没有匹配的主播</td></tr>'}</tbody>
</table></div>`;
    }

    function giftsHtml(sum) {
      if (!sum.rows.length) return noRecordsHtml();
      const list = filteredGifts(sum);
      const rows = list.map((g) => `<tr><td><div class="gift">${img(g.giftImg)}<span>${esc(g.giftName)}</span></div></td>
  <td class="r">${fmtNum(g.num)}</td><td class="r strong">${esc(yuan(g.gold))}</td><td class="r">${esc(battery(g.gold))}</td></tr>`).join('');
      return `
<div class="toolbar"><input class="input" data-input="giftQuery" placeholder="搜索礼物" value="${esc(state.giftQuery)}">
  <span class="muted">${fmtNum(list.length)} 种礼物</span>${exportButton('gifts', list.length)}</div>
<div class="table-wrap"><table>
  <thead><tr><th>礼物</th><th class="r">数量</th><th class="r">花费</th><th class="r">电池</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="4" class="muted center">没有匹配的礼物</td></tr>'}</tbody>
</table></div>`;
    }

    function recordsHtml(sum) {
      if (!sum.rows.length) return noRecordsHtml();
      const f = state.filter;
      const rows = filteredRows(sum);
      const pages = Math.max(1, Math.ceil(rows.length / RECORDS_PAGE_SIZE));
      const page = Math.min(Math.max(1, state.page), pages);
      const slice = rows.slice((page - 1) * RECORDS_PAGE_SIZE, page * RECORDS_PAGE_SIZE);
      const paidGold = rows.reduce((a, r) => a + (r.paid ? r.gold : 0), 0);
      const streamer = f.ruid ? sum.streamers.find((s) => s.ruid === f.ruid) : null;
      const monthOptions = [...sum.months].reverse().filter((m) => m.gold)
        .map((m) => `<option value="${esc(m.month)}" ${m.month === f.month ? 'selected' : ''}>${esc(m.month)}</option>`).join('');
      const body = slice.map((r) => `<tr class="${r.paid ? '' : 'dim'}">
  <td class="nowrap">${fmtTime(r.ts)}</td><td>${esc(r.rname)}</td>
  <td><div class="gift">${img(r.giftImg)}<span>${esc(r.giftName)}</span></div></td>
  <td class="r">${fmtNum(r.giftNum)}</td><td class="r">${esc(yuan(r.gold))}</td>
  <td class="muted small">${esc([r.bag, r.status].filter(Boolean).join(' · '))}</td></tr>`).join('');
      return `
<div class="toolbar">
  <input class="input" data-input="filter.q" placeholder="搜索主播或礼物" value="${esc(f.q)}">
  <select class="input" data-change="filter.month"><option value="">全部月份</option>${monthOptions}</select>
  ${streamer ? `<span class="chip">${esc(streamer.rname)}<button data-action="clear-streamer" aria-label="不按主播筛选">✕</button></span>` : ''}
  <span class="muted">${fmtNum(rows.length)} 笔 · 花费 ${esc(yuan(paidGold))}</span>
  ${exportButton('records', rows.length)}
</div>
<div class="table-wrap"><table>
  <thead><tr><th>时间</th><th>主播</th><th>礼物</th><th class="r">数量</th><th class="r">金额</th><th>备注</th></tr></thead>
  <tbody>${body || '<tr><td colspan="6" class="muted center">没有符合条件的记录</td></tr>'}</tbody>
</table></div>
${pages > 1 ? `<div class="pager">
  <button class="btn" data-action="page" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>上一页</button>
  <span class="muted">${page} / ${pages}</span>
  <button class="btn" data-action="page" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>下一页</button></div>` : ''}
<p class="hint">灰色的行是包裹礼物或已退回的记录，不计入花费。</p>`;
    }

    function blindHtml() {
      const l = state.ledger;
      const canSync = !readOnly && state.account && !state.demo;
      const results = Object.values(l.blind || {})
        .filter((b) => b && b.info && Array.isArray(b.info.gifts))
        .map((b) => ({ info: b.info, s: blindBoxSummary(b.info, Array.isArray(b.draws) ? b.draws : []) }))
        .filter((x) => x.s.boxes > 0)
        .sort((a, b) => b.s.costGold - a.s.costGold);
      const rows = results.map(({ info, s }) => `<tr>
  <td>${esc(info.name)}<div class="muted small">每个 ${esc(yuan(info.priceGold))}</div></td>
  <td class="r">${fmtNum(s.boxes)}</td><td class="r">${esc(yuan(s.costGold))}</td><td class="r">${esc(yuan(s.valueGold))}</td>
  <td class="r strong ${s.profitGold >= 0 ? 'good' : 'bad'}">${s.profitGold >= 0 ? '+' : '−'}${esc(yuan(Math.abs(s.profitGold)))}</td>
  <td class="small">${esc(s.outcomes.slice(0, 4).map((o) => `${o.name}×${o.num}`).join('、'))}${s.unknown ? `<div class="muted">${fmtNum(s.unknown)} 个开出的礼物价格未知，未计入价值</div>` : ''}</td></tr>`).join('');
      return `
<div class="card">
  <div class="card-h"><h3>盲盒盈亏<span class="tag">实验性</span></h3>
    ${canSync ? `<button class="btn primary" data-action="sync-blind" ${state.busy ? 'disabled' : ''}>读取盲盒记录</button>` : ''}</div>
  <p class="muted small">按 B 站盲盒的开盒记录计算：开出礼物的价值 − 盲盒价格。这部分接口参数来自公开资料，还没有用真实账号验证过，结果仅供参考。</p>
  ${rows ? `<div class="table-wrap"><table>
    <thead><tr><th>盲盒</th><th class="r">开盒数</th><th class="r">花费</th><th class="r">开出价值</th><th class="r">盈亏</th><th>开得最多</th></tr></thead>
    <tbody>${rows}</tbody></table></div>` : `<p>${canSync ? '还没有盲盒数据，点「读取盲盒记录」试试。' : '这份数据里没有盲盒记录。'}</p>`}
</div>`;
    }

    function dataHtml() {
      const l = state.ledger;
      const count = l ? l.records.length : 0;
      const local = !readOnly && !state.demo;
      const where = state.demo ? '现在显示的是虚构的示例数据，不会保存。'
        : readOnly ? '数据来自你打开的文件，只在这个页面里显示，没有保存到任何地方。'
          : '数据只保存在这个浏览器里（IndexedDB）。换浏览器或清理网站数据会丢失，建议定期导出备份。';
      return `
<div class="card">
  <h3>本地数据</h3>
  <p>共 ${fmtNum(count)} 条送礼记录${l && l.syncedAt && !state.demo ? `，上次同步 ${esc(fmtTime(l.syncedAt / 1000))}` : ''}${local && l && l.records.length && !l.fullSyncDone ? '（上次全量同步没有完成，下次同步会继续补全）' : ''}。</p>
  <p class="muted small">${where}</p>
  <div class="btns">
    ${local && state.account ? `<button class="btn primary" data-action="sync" ${state.busy ? 'disabled' : ''}>同步记录</button>` : ''}
    <button class="btn" data-action="export-json" ${count ? '' : 'disabled'}>导出 JSON（备份）</button>
    <button class="btn" data-action="export-csv" ${count ? '' : 'disabled'}>导出全部记录 CSV</button>
    ${local && state.account ? '<button class="btn" data-action="import">导入 JSON</button>' : ''}
    ${readOnly ? '<button class="btn" data-action="open-file">打开其他文件</button>' : ''}
    ${local && state.account ? '<button class="btn danger" data-action="clear">清空本地数据</button>' : ''}
  </div>
</div>
<div class="card">
  <h3>这个工具做什么、不做什么</h3>
  <ul>
    <li>只请求 bilibili.com 自己的接口，靠浏览器自动带上你在 B 站的登录状态。</li>
    <li>不读取、不保存你的 Cookie 或任何登录凭证，不连接 B 站以外的任何服务器。</li>
    <li>只读：不会送礼、点赞、发弹幕、关注主播，也不会动你的钱包。</li>
    <li>B 站接口可能只提供一段时间内的记录；定期打开同步，本地记录就会一直累积下去。</li>
    <li>金额单位：1 元 = 10 电池。</li>
  </ul>
  <p class="muted small" style="margin:10px 0 0">版本 ${esc(VERSION)} · MIT 开源 · 非 B 站官方工具</p>
</div>`;
    }

    // ------------------------------------------------ 渲染与交互

    function render() {
      const active = shadow.activeElement;
      const key = active && active.dataset ? active.dataset.input : null;
      const pos = key && typeof active.selectionStart === 'number' ? active.selectionStart : null;
      rootEl.innerHTML = html();
      if (key) {
        const el = rootEl.querySelector(`[data-input="${key}"]`);
        if (el) {
          el.focus();
          if (pos !== null) try { el.setSelectionRange(pos, pos); } catch { /* 部分输入框不支持 */ }
        }
      }
    }

    function setPath(path, value) {
      const parts = path.split('.');
      let target = state;
      while (parts.length > 1) target = target[parts.shift()];
      target[parts[0]] = value;
    }

    function flash(kind, text) {
      state.notice = kind === 'ok' ? text : '';
      state.error = kind === 'error' ? text : '';
    }

    async function loadAccount() {
      state.loading = true;
      state.error = '';
      render();
      try {
        const account = await fetchAccount(client);
        state.account = account;
        if (account) {
          const saved = await storage.get(ledgerKey(account.uid));
          state.ledger = saved ? { ...emptyLedger(account), ...saved, uname: account.uname } : emptyLedger(account);
        } else {
          state.ledger = null;
        }
      } catch (e) {
        state.error = e.message || String(e);
      }
      state.loading = false;
      state.loaded = true;
      render();
    }

    async function saveLedger() {
      if (!readOnly && !state.demo && state.account) await storage.set(ledgerKey(state.account.uid), state.ledger);
    }

    async function sync() {
      if (state.busy || readOnly || state.demo || !state.account) return;
      state.busy = true;
      flash();
      state.progress = '正在从 B 站读取送礼记录…';
      render();
      const l = state.ledger;
      const newestTs = l.fullSyncDone ? l.records.reduce((m, r) => Math.max(m, toNum(r.timestamp)), 0) : 0;
      const result = await fetchPayRecords(client, {
        newestTs,
        onPage: ({ page, total, waitingMs }) => {
          state.progress = waitingMs
            ? `B 站提示请求太频繁，${waitingMs / 1000} 秒后自动重试（已拿到 ${total} 条）…`
            : `正在读取第 ${page} 页，已拿到 ${total} 条…`;
          render();
        },
      });
      const { records, added } = mergeRecords(l.records, result.records);
      state.ledger = { ...l, records, syncedAt: Date.now(), fullSyncDone: l.fullSyncDone || result.complete };
      try {
        await saveLedger();
        if (result.error) flash('error', `${result.error.message}。已保存拿到的 ${result.records.length} 条，稍后可以再点同步继续。`);
        else flash('ok', added ? `新增 ${added} 条记录，本地共 ${records.length} 条。` : `没有新记录，本地共 ${records.length} 条。`);
      } catch (e) {
        flash('error', `保存到本地失败：${e.message || e}`);
      }
      state.busy = false;
      state.progress = '';
      render();
    }

    async function syncBlind() {
      if (state.busy || readOnly || state.demo || !state.account) return;
      state.busy = true;
      flash();
      render();
      const blind = { ...(state.ledger.blind || {}) };
      let found = 0;
      try {
        for (const id of blindBoxCandidates(state.ledger.records, blind)) {
          state.progress = `正在读取盲盒 ${id} 的信息…`;
          render();
          let info;
          try {
            info = await fetchBlindInfo(client, id);
          } catch (e) {
            if (e.code === -101 || e.code === 412 || e.code === -352) throw e;
            continue; // 这个 id 不是盲盒或已下线，跳过
          }
          if (!info) continue;
          const prev = blind[id] && Array.isArray(blind[id].draws) ? blind[id].draws : [];
          const sinceTs = prev.reduce((m, d) => Math.max(m, toNum(d.timestamp)), 0);
          const draws = await fetchBlindDraws(client, id, {
            sinceTs,
            onPage: ({ page, total }) => { state.progress = `正在读取「${info.name}」开盒记录第 ${page} 页（${total} 条）…`; render(); },
          });
          blind[id] = { info, draws: [...draws, ...prev], syncedAt: Date.now() };
          if (blind[id].draws.length) found++;
          await sleep(PAGE_DELAY_MS);
        }
        state.ledger = { ...state.ledger, blind };
        await saveLedger();
        flash('ok', found ? `读取完成，${found} 种盲盒有开盒记录。` : '没有找到你的盲盒开盒记录。');
      } catch (e) {
        state.ledger = { ...state.ledger, blind };
        await saveLedger().catch(() => {});
        flash('error', e.message || String(e));
      }
      state.busy = false;
      state.progress = '';
      render();
    }

    function fileStem() {
      const l = state.ledger;
      const d = new Date();
      return `bili-live-ledger-${l && l.uid ? l.uid : 'data'}-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
    }

    function exportView(kind) {
      const sum = summary();
      const stem = fileStem();
      const type = 'text/csv;charset=utf-8';
      if (kind === 'records') {
        const f = state.filter;
        const filtered = f.ruid || f.month || f.q.trim();
        return download(`${stem}-records${filtered ? '-filtered' : ''}.csv`, recordsCsv(filteredRows(sum)), type);
      }
      if (kind === 'streamers') return download(`${stem}-streamers.csv`, streamersCsv(filteredStreamers(sum)), type);
      if (kind === 'gifts') return download(`${stem}-gifts.csv`, giftsCsv(filteredGifts(sum)), type);
      if (kind === 'months') return download(`${stem}-months.csv`, monthsCsv(sum.months), type);
    }

    async function importJson() {
      const file = await pickFile();
      if (!file) return;
      try {
        const data = parseImport(await file.text());
        if (data.uid && state.account && data.uid !== state.account.uid
          && !root.confirm(`这个文件属于 UID ${data.uid}，和当前登录的账号不一样。仍然合并进当前账号吗？`)) return;
        const { records, added } = mergeRecords(state.ledger.records, data.records);
        const blind = { ...data.blind, ...(state.ledger.blind || {}) };
        state.ledger = { ...state.ledger, records, blind };
        await saveLedger();
        flash('ok', `导入完成，新增 ${added} 条，本地共 ${records.length} 条。`);
      } catch (e) {
        flash('error', e.message || String(e));
      }
      render();
    }

    async function openFile() {
      const file = await pickFile();
      if (!file) return;
      try {
        setLedger(parseImport(await file.text()));
        flash('ok', `已打开 ${file.name}`);
      } catch (e) {
        flash('error', e.message || String(e));
      }
      render();
    }

    async function clearData() {
      if (!state.account || !root.confirm('确定清空这个账号保存在本浏览器里的所有记录吗？建议先导出备份。')) return;
      try {
        await storage.remove(ledgerKey(state.account.uid));
        state.ledger = emptyLedger(state.account);
        flash('ok', '本地数据已清空。');
      } catch (e) {
        flash('error', e.message || String(e));
      }
      render();
    }

    function onKey(e) {
      if (e.key === 'Escape' && state.open && mode === 'overlay') close();
    }

    function open() {
      state.open = true;
      document.addEventListener('keydown', onKey);
      if (!state.loaded && !state.loading && client) loadAccount();
      else render();
    }

    function close() {
      state.open = false;
      document.removeEventListener('keydown', onKey);
      render();
    }

    function setLedger(next) {
      state.ledger = next;
      state.loaded = true;
      state.view = 'overview';
      state.filter = { q: '', month: '', ruid: 0 };
      state.page = 1;
      cache = { key: '', value: null };
      render();
    }

    rootEl.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el || !rootEl.contains(el)) return;
      const action = el.dataset.action;
      if (action === 'backdrop' && e.target !== el) return;
      if (action === 'launch') return open();
      if (action === 'close' || action === 'backdrop') return close();
      if (action === 'view') { state.view = el.dataset.view; state.page = 1; return render(); }
      if (action === 'filter-streamer') {
        state.filter = { q: '', month: '', ruid: Number(el.dataset.ruid) };
        state.view = 'records';
        state.page = 1;
        return render();
      }
      if (action === 'clear-streamer') { state.filter.ruid = 0; state.page = 1; return render(); }
      if (action === 'page') { state.page = Number(el.dataset.page) || 1; return render(); }
      if (action === 'sync') return void sync();
      if (action === 'sync-blind') return void syncBlind();
      if (action === 'demo') { state.demo = true; state.ledger = sampleLedger(); state.view = 'overview'; flash(); return render(); }
      if (action === 'exit-demo') { state.demo = false; state.ledger = null; state.loaded = false; flash(); return void loadAccount(); }
      if (action === 'export-json') return download(`${fileStem()}.json`, exportJson(state.ledger), 'application/json');
      if (action === 'export-csv') return download(`${fileStem()}-records.csv`, toCsv(state.ledger.records), 'text/csv;charset=utf-8');
      if (action === 'export-view') return exportView(el.dataset.kind);
      if (action === 'import') return void importJson();
      if (action === 'open-file') return void openFile();
      if (action === 'clear') return void clearData();
    });

    rootEl.addEventListener('input', (e) => {
      const key = e.target.dataset && e.target.dataset.input;
      if (!key) return;
      setPath(key, e.target.value);
      state.page = 1;
      render();
    });

    rootEl.addEventListener('change', (e) => {
      const key = e.target.dataset && e.target.dataset.change;
      if (!key) return;
      setPath(key, e.target.value);
      state.page = 1;
      render();
    });

    render();
    return { open, close, setLedger, host };
  }

  // ---------------------------------------------------------------- 启动

  if (typeof document === 'undefined' || root.__biliLiveLedger) return;

  if (/(^|\.)bilibili\.com$/.test(root.location.hostname)) {
    const client = makeBiliClient((url, init) => root.fetch(url, init));
    root.__biliLiveLedger = createApp({ mode: 'overlay', mount: document.body, readOnly: false, client });
  } else {
    // 静态页面（离线查看器）：只渲染用户自己打开的文件，不发任何请求。
    root.__biliLiveLedger = true;
    root.BiliLedger = {
      version: VERSION,
      parseImport,
      sampleLedger,
      mountViewer(container, ledger) {
        return createApp({ mode: 'inline', mount: container, readOnly: true, client: null, ledger });
      },
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
