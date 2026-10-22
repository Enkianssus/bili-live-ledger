'use strict';
// 运行：npm test
// 故意用美国时区跑：时间和分月必须按北京时间算，不能跟着电脑时区走。
process.env.TZ = 'America/Los_Angeles';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const L = require('../bili-live-ledger.user.js');

const APP_SEC = '560c52ccd288fed045859ed18bffd973';
const nodeMd5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const noWait = async () => {};
const rec = (id, ts, extra = {}) => ({
  id, timestamp: ts, gift_id: 1, gift_name: '小花花', gift_num: 1, pay_coin: '100', coin: '100', ruid: 7, r_uname: '主播A', ...extra,
});

function pagedClient(pages) {
  const calls = [];
  return {
    calls,
    async getJson(url) {
      const next = new URL(url).searchParams.get('next_id') || '';
      calls.push(next);
      const page = pages[next];
      if (page instanceof Error) throw page;
      if (!page) throw new Error(`unexpected page ${next}`);
      return page;
    },
  };
}

test('md5 matches node:crypto', () => {
  const inputs = ['', 'abc', 'message digest', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), '中文签名测试🎁', '{"appId":1}'];
  for (const s of inputs) assert.equal(L.md5(s), nodeMd5(s), s);
});

test('appSignedQuery sorts params and signs with the app secret', () => {
  const [query, sign] = L.appSignedQuery({ b: '2', a: 'x y' }, 1700000000).split('&sign=');
  assert.equal(query, 'a=x%20y&appkey=1d8b6e7d45233436&b=2&ts=1700000000');
  assert.equal(sign, nodeMd5(query + APP_SEC));
});

test('payRecordUrl carries next_id and a valid sign', () => {
  const url = new URL(L.payRecordUrl('abc123', 1700000000));
  assert.equal(url.origin + url.pathname, L.API.payRecord);
  assert.equal(url.searchParams.get('next_id'), 'abc123');
  assert.equal(url.searchParams.get('coin_type'), 'gold');
  const [query, sign] = url.search.slice(1).split('&sign=');
  assert.equal(sign, nodeMd5(query + APP_SEC));
});

test('payRecordUrl can ask for a specific month and still signs it', () => {
  const url = new URL(L.payRecordUrl('', 1700000000, { month: '202509' }));
  assert.equal(url.searchParams.get('month'), '202509');
  assert.equal(url.searchParams.get('next_id'), null);
  const [query, sign] = url.search.slice(1).split('&sign=');
  assert.equal(sign, nodeMd5(query + APP_SEC));
});

test('history probe records each answer and tells a data limit from a refusal', async () => {
  const earliest = { id: '2113213508515164161', timestamp: Date.UTC(2025, 8, 30, 16, 14) / 1000 }; // 北京时间 2025-10-01 00:14
  const asked = [];
  const client = {
    async getJson(url) {
      const q = new URL(url).searchParams;
      asked.push([q.get('next_id'), q.get('month')]);
      if (q.get('month') === '202510') return { list: [{ id: '1', timestamp: earliest.timestamp + 3600 }], params: { month: '202510' } };
      if (q.get('month')) return { list: [], params: { month: q.get('month') } };
      if (q.get('next_id')) return { list: [], params: { next_id: '' } };
      return { list: [{ id: '9', timestamp: 1790000000 }], params: { next_id: '9', month: '202610' } };
    },
  };
  const results = await L.probeHistory(client, earliest, { wait: noWait });
  assert.deepEqual(asked, [[null, null], ['2113213508515164161', null], [null, '202510'], [null, '202509'], [null, '202506']]);
  assert.equal(results[0].nextIdIsLastId, true);
  const verdict = L.judgeProbe(results, earliest.timestamp);
  assert.equal(verdict.kind, 'limit');
  assert.match(verdict.text, /认得「指定月份」参数/);

  const older = { name: 'x', ok: true, count: 1, oldestTs: earliest.timestamp - 86400, newestTs: earliest.timestamp - 86400 };
  assert.equal(L.judgeProbe([older], earliest.timestamp).kind, 'found');
  assert.equal(L.judgeProbe([{ name: 'y', ok: false, code: -352, message: '风控' }], earliest.timestamp).kind, 'blocked');
  assert.equal(L.judgeProbe([{ name: 'z', ok: false, code: 412, message: '限流' }], earliest.timestamp).kind, 'blocked');

  const refused = await L.probeHistory({ getJson: async () => { throw new L.LedgerError('风控', -352); } }, earliest, { wait: noWait });
  assert.ok(refused.every((r) => r.ok === false && r.code === -352));

  const legacy = await L.probeHistory(client, { id: 2113213508515164161, timestamp: earliest.timestamp }, { wait: noWait });
  assert.ok(legacy[1].skipped, 'a rounded legacy id cannot be used to keep paging');
});

test('full sync pages through next_id until the list ends', async () => {
  const client = pagedClient({
    '': { list: [rec(3, 300), rec(2, 200)], params: { next_id: 'n1' } },
    n1: { list: [rec(1, 100)], params: { next_id: '' } },
  });
  const res = await L.fetchPayRecords(client, { wait: noWait });
  assert.equal(res.complete, true);
  assert.equal(res.error, null);
  assert.deepEqual(res.records.map((r) => r.id), [3, 2, 1]);
  assert.deepEqual(client.calls, ['', 'n1']);
});

test('incremental sync stops once it passes the 7-day backtrack window', async () => {
  const day = 86400;
  const now = 1700000000;
  const client = pagedClient({
    '': { list: [rec(5, now), rec(4, now - 3 * day), rec(3, now - 9 * day)], params: { next_id: 'n1' } },
  });
  const res = await L.fetchPayRecords(client, { newestTs: now - day, wait: noWait });
  assert.equal(res.complete, true);
  assert.deepEqual(res.records.map((r) => r.id), [5, 4]);
  assert.deepEqual(client.calls, ['']);
});

test('an error mid-sync keeps the records fetched so far', async () => {
  const err = new L.LedgerError('风控', -352);
  const client = pagedClient({ '': { list: [rec(2, 200)], params: { next_id: 'n1' } }, n1: err });
  const res = await L.fetchPayRecords(client, { wait: noWait });
  assert.equal(res.complete, false);
  assert.equal(res.error, err);
  assert.deepEqual(res.records.map((r) => r.id), [2]);
});

test('a 412 rate limit waits once and retries the same page', async () => {
  let calls = 0;
  const waits = [];
  const client = {
    async getJson() {
      calls++;
      if (calls === 1) throw new L.LedgerError('limited', 412);
      return { list: [rec(1, 100)], params: {} };
    },
  };
  const res = await L.fetchPayRecords(client, { wait: async (ms) => { waits.push(ms); } });
  assert.equal(res.complete, true);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [30000]);
});

test('a repeated page stops instead of looping forever', async () => {
  const page = { list: [rec(1, 100)], params: { next_id: 'same' } };
  const res = await L.fetchPayRecords({ getJson: async () => page }, { wait: noWait });
  assert.equal(res.complete, false);
  assert.equal(res.error.code, 'loop');
  assert.equal(res.records.length, 1);
});

test('mergeRecords dedupes by id, keeps the newer copy and sorts by time', () => {
  const { records, added } = L.mergeRecords([rec(1, 100), rec(2, 200)], [rec(2, 200, { status_msg: '已退回' }), rec(3, 300)]);
  assert.equal(added, 1);
  assert.deepEqual(records.map((r) => r.id), [3, 2, 1]);
  assert.equal(records[1].status_msg, '已退回');
});

test('summarize leaves refunds and bag gifts out of spending', () => {
  // 送礼记录的金额单位是电池；统计结果统一用金瓜子（1 电池 = 100 金瓜子）
  const s = L.summarize([
    rec(1, 1696089600, { pay_coin: '10' }), // 2023-10-01 00:00 (+08)
    rec(2, 1698768000, { pay_coin: '520', gift_id: 2, gift_name: '告白气球', ruid: 8, r_uname: '主播B' }), // 2023-11-01
    rec(3, 1698768100, { pay_coin: '50', status_msg: '已退回' }),
    rec(4, 1698768200, { pay_coin: '0', coin: '1', bag_desc: '包裹道具' }),
    rec(5, 1704067200, { pay_coin: '1', r_uname: '主播A改名' }), // 2024-01-01
  ]);
  assert.equal(s.totals.paidGold, 53100);
  assert.equal(s.totals.paidCount, 3);
  assert.equal(s.totals.refundGold, 5000);
  assert.equal(s.totals.bagCount, 1);
  assert.equal(s.totals.bagValueGold, 100);
  assert.deepEqual(s.streamers.map((x) => [x.ruid, x.gold, x.rname]), [[8, 52000, '主播B'], [7, 1100, '主播A改名']]);
  assert.deepEqual(s.months.map((m) => [m.month, m.gold]), [['2023-10', 1000], ['2023-11', 52000], ['2023-12', 0], ['2024-01', 100]]);
  assert.equal(L.yuan(s.totals.paidGold), '¥53.1');
  assert.equal(L.battery(s.totals.paidGold), '531');
});

test('pay_coin falls back to coin only when it is missing', () => {
  assert.equal(L.normalize(rec(1, 1, { pay_coin: '', coin: '300' })).gold, 30000);
  assert.equal(L.normalize(rec(1, 1, { pay_coin: '0', coin: '300' })).gold, 0);
});

test('pay record amounts are in batteries (real records reported by a user)', () => {
  const box = L.normalize(rec(1, 1, { gift_name: '心动盲盒', pay_coin: '150' }));
  assert.equal(L.yuan(box.gold), '¥15');
  assert.equal(L.battery(box.gold), '150');
  const admiral = L.normalize(rec(2, 1, { gift_name: '提督', pay_coin: '15980' }));
  assert.equal(L.yuan(admiral.gold), '¥1,598');
  assert.equal(L.battery(admiral.gold), '15,980');
  const csv = L.toCsv([rec(3, 1698768000, { gift_name: '心动盲盒', pay_coin: '150' })]).split('\r\n');
  assert.equal(csv[0].replace(String.fromCharCode(0xfeff), ''), '时间,主播,主播UID,礼物,数量,元,电池,来源,状态,记录ID');
  assert.ok(csv[1].includes(',心动盲盒,1,15,150,'), csv[1]);
});

test('summary tables export as CSV in yuan and batteries', () => {
  const s = L.summarize([
    rec(1, 1696089600, { pay_coin: '150', gift_id: 32251, gift_name: '心动盲盒' }), // 2023-10-01
    rec(2, 1698768000, { pay_coin: '15980', gift_id: 10003, gift_name: '提督', ruid: 8, r_uname: '主播B' }), // 2023-11-01
  ]);
  const lines = (csv) => csv.replace(String.fromCharCode(0xfeff), '').split('\r\n');
  assert.deepEqual(lines(L.streamersCsv(s.streamers)), [
    '主播,主播UID,元,电池,笔数,第一次,最近一次',
    '主播B,8,1598,15980,1,2023-11-01,2023-11-01',
    '主播A,7,15,150,1,2023-10-01,2023-10-01',
  ]);
  assert.deepEqual(lines(L.giftsCsv(s.gifts)), ['礼物,礼物ID,数量,元,电池', '提督,10003,1,1598,15980', '心动盲盒,32251,1,15,150']);
  assert.deepEqual(lines(L.monthsCsv(s.months)), ['月份,元,电池', '2023-10,15,150', '2023-11,1598,15980']);
  const onlyB = lines(L.recordsCsv(s.rows.filter((r) => r.ruid === 8)));
  assert.equal(onlyB.length, 2);
  assert.ok(onlyB[1].startsWith('2023-11-01 00:00,主播B,8,提督,1,1598,15980,'), onlyB[1]);
});

test('blindBoxSummary computes profit and flags unknown prices', () => {
  const info = { id: 1, name: '盲盒', priceGold: 15000, gifts: [{ giftId: 11, name: 'A', priceGold: 5000 }, { giftId: 12, name: 'B', priceGold: 60000 }] };
  const s = L.blindBoxSummary(info, [
    { gift_id: 11, gift_name: 'A', gift_num: 2 },
    { gift_id: 12, gift_name: 'B', gift_num: 1 },
    { gift_id: 99, gift_name: 'X', gift_num: 1 },
  ]);
  assert.equal(s.boxes, 4);
  assert.equal(s.costGold, 60000);
  assert.equal(s.valueGold, 70000);
  assert.equal(s.profitGold, 10000);
  assert.equal(s.unknown, 1);
});

test('fetchBlindDraws follows params pagination and stops at known draws', async () => {
  const cursors = [];
  const client = {
    async getJson(url) {
      const cursor = new URL(url).searchParams.get('cursor');
      cursors.push(cursor);
      return cursor
        ? { list: [{ timestamp: 200 }, { timestamp: 100 }], params: { cursor: 'c3', have_more: 1 } }
        : { list: [{ timestamp: 300 }, { timestamp: 250 }], params: { cursor: 'c2', have_more: 1 } };
    },
  };
  const draws = await L.fetchBlindDraws(client, 32251, { sinceTs: 150, wait: noWait });
  assert.deepEqual(draws.map((d) => d.timestamp), [300, 250, 200]);
  assert.deepEqual(cursors, [null, 'c2']);
});

test('blindBoxCandidates adds blind boxes found in the records', () => {
  const ids = L.blindBoxCandidates([rec(1, 1, { gift_id: 777, gift_name: '新年盲盒' }), rec(2, 1)], { 888: {} });
  for (const id of [...L.KNOWN_BLIND_BOXES, 777, 888]) assert.ok(ids.includes(id), String(id));
  assert.ok(!ids.includes(1));
});

test('CSV export neutralises formulas and quotes commas', () => {
  const csv = L.toCsv([rec(1, 1698768000, { r_uname: '=HYPERLINK("x")', gift_name: '花,花' })]);
  assert.ok(csv.startsWith(String.fromCharCode(0xfeff) + '时间,主播'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(csv.includes('"花,花"'));
});

test('export and import round-trip, and foreign files are rejected', () => {
  const ledger = { uid: 42, uname: '我', records: [rec(1, 100)], blind: {} };
  const back = L.parseImport(L.exportJson(ledger));
  assert.equal(back.uid, 42);
  assert.deepEqual(back.records, ledger.records);
  assert.throws(() => L.parseImport('{"format":"other","records":[]}'), /不是本工具导出的文件/);
  assert.throws(() => L.parseImport('not json'), /不是有效的 JSON/);
});

const reply = (body, status = 200) => ({ ok: status === 200, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('makeBiliClient sends credentials and maps Bilibili error codes', async () => {
  const loggedOut = L.makeBiliClient(async () => reply({ code: -101, message: '账号未登录' }));
  await assert.rejects(loggedOut.getJson('https://api.bilibili.com/x'), (e) => e.code === -101);
  assert.equal(await L.fetchAccount(loggedOut), null);
  const limited = L.makeBiliClient(async () => reply({}, 412));
  await assert.rejects(limited.getJson('https://api.bilibili.com/x'), (e) => e.code === 412);
  const ok = L.makeBiliClient(async (url, init) => {
    assert.equal(init.credentials, 'include');
    return reply({ code: 0, data: { isLogin: true, mid: 5, uname: 'u' } });
  });
  assert.deepEqual(await L.fetchAccount(ok), { uid: 5, uname: 'u', face: '' });
});

test('record ids and next_id beyond 2^53 keep every digit', async () => {
  const raw = '{"code":0,"data":{"list":[{"id":2113213508515164161,"timestamp":1760528274,"gift_id":32251,"ruid":3632315829848934},'
    + '{"id":2113213508515164170,"timestamp":1760528274}],"params":{"next_id":2113213508515164170,"month":"202510"}}}';
  const data = await L.makeBiliClient(async () => reply(raw)).getJson('https://api.live.bilibili.com/x');
  assert.deepEqual(data.list.map((r) => r.id), ['2113213508515164161', '2113213508515164170']);
  assert.equal(data.params.next_id, '2113213508515164170');
  assert.equal(data.list[0].ruid, 3632315829848934); // 安全范围内的数字保持不变
  assert.equal(data.list[0].timestamp, 1760528274);
  assert.equal(L.parseBiliJson('{"msg":"\\"id\\":12345678901234567"}').msg, '"id":12345678901234567'); // 字符串里的内容不动
});

test('legacy rounded ids are replaced instead of duplicated', () => {
  const legacy = { id: 2113213508515164161, timestamp: 1760528274, gift_id: 32251, ruid: 7 }; // 旧版本存下的不精确 id
  assert.equal(legacy.id, 2113213508515164200);
  const exact = { ...legacy, id: '2113213508515164161' };
  const sameMs = { ...legacy, id: '2113213508515164170' }; // 同一毫秒的另一条，旧版本里被当成重复丢掉了
  const synced = L.mergeRecords([legacy, rec(1, 100)], [exact, sameMs]);
  assert.equal(synced.added, 1);
  assert.deepEqual(synced.records.map((r) => r.id), ['2113213508515164161', '2113213508515164170', 1]);
  const imported = L.mergeRecords(synced.records, [legacy]); // 再导入旧版本的备份
  assert.equal(imported.added, 0);
  assert.equal(imported.records.length, 3);
});

test('times and months are in Beijing time whatever the computer time zone', () => {
  const ts = Date.UTC(2025, 9, 15, 11, 37, 54) / 1000; // 北京时间 2025-10-15 19:37:54
  assert.equal(L.fmtTime(ts), '2025-10-15 19:37');
  assert.equal(L.fmtDate(ts), '2025-10-15');
  const firstOfMonth = Date.UTC(2025, 8, 30, 16, 14) / 1000; // 北京时间 2025-10-01 00:14，洛杉矶还是 9 月 30 日
  assert.equal(L.monthKey(firstOfMonth), '2025-10');
  assert.equal(L.summarize([rec(1, firstOfMonth)]).months[0].month, '2025-10');
});

test('the script only references bilibili.com hosts and never touches cookies', () => {
  const src = fs.readFileSync(require.resolve('../bili-live-ledger.user.js'), 'utf8');
  const hosts = [...src.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase());
  assert.ok(hosts.length > 0);
  for (const h of hosts) assert.ok(h === 'bilibili.com' || h.endsWith('.bilibili.com'), `unexpected host ${h}`);
  assert.ok(!/document\.cookie/.test(src.replace('不读取 document.cookie', '')));
  assert.ok(!/GM_xmlhttpRequest|@connect|@require/.test(src));
});

test('the sample ledger is self-consistent', () => {
  const l = L.sampleLedger(1700000000);
  const s = L.summarize(l.records);
  assert.equal(l.records.length, 420);
  assert.ok(s.totals.paidGold > 0);
  assert.ok(s.streamers.length >= 5);
  const box = Object.values(l.blind)[0];
  assert.equal(L.blindBoxSummary(box.info, box.draws).boxes, 90);
});
