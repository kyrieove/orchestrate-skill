#!/usr/bin/env node
// 会话账单核算 —— 从 Claude Code transcript 直接算 effective token 去向。
//   node cost.mjs [transcript.jsonl]
// 不带参数：取 ~/.claude/projects/ 下最近修改的那个。
//
// effective = input×1 + cache_creation×1.25 + cache_read×0.1 + output×5
// （Anthropic 相对 base input 的计价倍率）
import fs from 'fs';
import path from 'path';
import os from 'os';

const W = { inp: 1, cc: 1.25, cr: 0.1, out: 5 };
const eff = r => r.inp * W.inp + r.cc * W.cc + r.cr * W.cr + r.out * W.out;
const M = n => (Math.round(n / 1e4) / 100) + 'M';
const K = n => Math.round(n / 1e3) + 'k';

function latestTranscript() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(root)) return null;
  let best = null;
  for (const d of fs.readdirSync(root)) {
    const dir = path.join(root, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(dir, f), m = fs.statSync(p).mtimeMs;
      if (!best || m > best.m) best = { p, m };
    }
  }
  return best?.p;
}

const file = process.argv[2] || latestTranscript();
if (!file || !fs.existsSync(file)) {
  console.error('找不到 transcript。用法: node cost.mjs [transcript.jsonl]');
  process.exit(1);
}

const seen = new Set();
const rows = [];
let prompts = 0;
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line) continue;
  let o; try { o = JSON.parse(line) } catch { continue }
  // 真人提问：非 sidechain、content 是纯字符串（工具结果是数组）
  if (o.type === 'user' && !o.isSidechain && typeof o.message?.content === 'string') prompts++;
  const u = o.message?.usage;
  if (!u) continue;
  const id = o.message.id || o.requestId || o.uuid;
  if (seen.has(id)) continue;          // 同一次调用会写多行，去重
  seen.add(id);
  rows.push({
    ts: o.timestamp || '',
    inp: u.input_tokens || 0,
    cc: u.cache_creation_input_tokens || 0,
    cr: u.cache_read_input_tokens || 0,
    out: u.output_tokens || 0,
    get ctx() { return this.inp + this.cc + this.cr },
  });
}
if (!rows.length) { console.error('这个 transcript 里没有 usage 记录。'); process.exit(1); }

const total = rows.reduce((a, r) => a + eff(r), 0);
const sum = k => rows.reduce((a, r) => a + r[k], 0);

console.log('\n' + path.basename(file));
console.log('='.repeat(60));
console.log('API 调用      ', rows.length);
console.log('真人提问      ', prompts, prompts ? `(每个提问 ${(rows.length / prompts).toFixed(1)} 次调用)` : '');
console.log('总 effective  ', M(total), `(每次调用 ${K(total / rows.length)})`);
console.log('cache_read 占 ', (sum('cr') * W.cr / total * 100).toFixed(1) + '%   ← 重读旧上下文');
console.log('output 占     ', (sum('out') * W.out / total * 100).toFixed(1) + '%');
console.log('上下文        ', K(rows[0].ctx), '→', K(rows[rows.length - 1].ctx));

console.log('\n账单按上下文长度归属');
console.log('-'.repeat(60));
const bands = [[0, 150e3], [150e3, 200e3], [200e3, 300e3], [300e3, 400e3], [400e3, Infinity]];
for (const [lo, hi] of bands) {
  const rs = rows.filter(r => r.ctx >= lo && r.ctx < hi);
  if (!rs.length) continue;
  const e = rs.reduce((a, r) => a + eff(r), 0);
  const pct = e / total * 100;
  const label = (hi === Infinity ? '>' + K(lo) : K(lo) + '-' + K(hi)).padEnd(12);
  console.log(label, String(rs.length).padStart(4), '次  ', M(e).padStart(7),
    ' ', pct.toFixed(1).padStart(5) + '%', ' ' + '#'.repeat(Math.round(pct / 2)));
}

console.log('\n反事实：中途重置上下文能省多少');
console.log('-'.repeat(60));
for (const cap of [150e3, 200e3, 300e3]) {
  const over = rows.filter(r => r.ctx > cap);
  if (!over.length) { console.log('超过 ' + K(cap) + ' 的调用：0 次 —— 这个会话很干净'); continue; }
  const now = over.reduce((a, r) => a + eff(r), 0);
  // 重置后这些调用仍要付各自的新增部分，但 cache_read 封顶在 cap
  const capped = over.reduce((a, r) => a + (r.inp * W.inp + r.cc * W.cc + Math.min(r.cr, cap) * W.cr + r.out * W.out), 0);
  const saved = (now - capped) / total * 100;
  console.log('在 ' + K(cap) + ' 处重置：', String(over.length).padStart(4), '次调用超标  ',
    M(total), '→', M(total - now + capped), ' 省 ' + saved.toFixed(0) + '%');
}

const late = rows.filter(r => r.ctx > 200e3).reduce((a, r) => a + eff(r), 0) / total * 100;
console.log('\n' + (late > 50
  ? `⚠️  ${late.toFixed(0)}% 的钱花在上下文 >200k 之后。该拆会话了 —— 见 CLAUDE.md「上下文预算」。`
  : `上下文 >200k 的部分只占 ${late.toFixed(0)}%，这个会话不用拆。`) + '\n');
