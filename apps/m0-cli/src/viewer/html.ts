import type { ViewerData } from './data';

// 单个 HTML 文件：数据以 JSON 内嵌，页面脚本负责展示。不加载任何外部资源，可离线打开。

/** 内嵌在 <script> 中的 JSON 必须转义 `<`，防止数据中的 `</script>` 提前结束脚本。 */
export const embedJson = (data: unknown) => JSON.stringify(data).replace(/</g, '\\u003c');

export function renderViewerHtml(data: ViewerData): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>推演记录 · ${escapeHtml(data.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1 id="title"></h1>
  <p id="meta" class="muted"></p>
</header>
<nav id="rounds" aria-label="回合"></nav>
<div id="tabs" role="tablist" aria-label="视角"></div>
<main id="content"></main>
<script type="application/json" id="data">${embedJson(data)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const STYLE = `
:root { --bg: #fbfaf7; --fg: #1d1c1a; --muted: #6b6760; --line: #e3dfd6; --accent: #8a3b12; --soft: #f1ede4; --warn: #9a6400; }
@media (prefers-color-scheme: dark) { :root { --bg: #181715; --fg: #ece9e2; --muted: #a29d93; --line: #34312c; --accent: #e08a5a; --soft: #23211e; --warn: #e2b04a; } }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 1100px; padding: 16px; background: var(--bg); color: var(--fg); font: 15px/1.7 system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; }
h1 { font-size: 22px; margin: 8px 0 0; } h2 { font-size: 17px; margin: 20px 0 8px; } h3 { font-size: 15px; margin: 14px 0 6px; }
.muted { color: var(--muted); font-size: 13px; }
nav, #tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
button { font: inherit; border: 1px solid var(--line); background: var(--soft); color: var(--fg); padding: 4px 10px; border-radius: 6px; cursor: pointer; }
button[aria-selected="true"] { border-color: var(--accent); color: var(--accent); font-weight: 600; }
section { border-top: 1px solid var(--line); padding-top: 6px; }
ul { padding-left: 20px; margin: 4px 0; } li { margin: 2px 0; }
.card { background: var(--soft); border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; margin: 8px 0; }
.thought { color: var(--muted); font-style: italic; }
.tag { display: inline-block; font-size: 12px; padding: 0 6px; border-radius: 4px; border: 1px solid var(--line); margin-right: 4px; }
.warn { color: var(--warn); }
table { border-collapse: collapse; width: 100%; } td, th { border-bottom: 1px solid var(--line); padding: 4px 6px; text-align: left; vertical-align: top; font-size: 14px; }
`;

const SCRIPT = `
const data = JSON.parse(document.getElementById('data').textContent);
const name = (id) => data.names[id] || id;
const el = (tag, attrs, ...children) => { const e = document.createElement(tag); Object.assign(e, attrs || {}); for (const c of children.flat()) if (c != null) e.append(c); return e; };
const KIND = { observe: '观察', move: '移动', probe: '试探', attack: '攻击', defend: '防御', use_item: '使用物品', take: '拾取', drop: '放下', speak: '说话', withdraw: '撤离', wait: '等待', other: '其他', failed_attempt: '失败的尝试', trap_triggered: '触发机关', discovered: '发现', ruled: '裁决结果', external: '外部事件' };
const MODALITY = { observed: '亲身经历', heard: '听到', inferred: '推测', claimed: '他人说法' };
const CHANNEL = { participant: '当事人', sight: '看见', sound: '听见' };
const INJURY = { none: '无伤', light: '轻伤', severe: '重伤', incapacitated: '失去行动力' };
let round = data.rounds.length ? data.rounds.length - 1 : 0;
let tab = 'global';

document.getElementById('title').textContent = data.title;
document.getElementById('meta').textContent = '运行 ' + data.runId + ' · ' + (data.protocol === 'simultaneous' ? '同时行动' : '轮流对话') + ' · ' + (data.mode === 'auto' ? '自动模式' : '交互模式') + (data.endReason ? ' · 结束：' + data.endReason : '');

function observationText(o) {
  if (!o) return '';
  if (o.channel === 'sound') return '从' + name(o.zones[0]) + '传来声响（' + (o.sound || '') + '）' + (o.item ? '，听得出是' + name(o.item) : '') + (o.speech && o.speech.clarity === 'full' ? '：“' + o.speech.sentences.join('') + '”' : '') + (o.description && o.description.sound ? '：' + o.description.sound : '');
  const who = o.actor ? name(o.actor) : '';
  const parts = [who, KIND[o.kind] || o.kind];
  if (o.item) parts.push(name(o.item));
  if (o.target) parts.push('→ ' + name(o.target));
  if (o.zones && o.zones.length) parts.push('@' + o.zones.map(name).join('→'));
  if (o.speech && o.speech.clarity === 'full') parts.push('“' + o.speech.sentences.join('') + '”');
  if (o.speech && o.speech.clarity === 'muffled') parts.push('（听不清）');
  if (o.failed) parts.push('（未成功' + (o.violation ? '：' + o.violation.code : '') + '）');
  if (o.description && o.description.visual) parts.push('：' + o.description.visual);
  return parts.join(' ');
}

function knowledgeItem(k) {
  const head = el('span', { className: 'tag' }, MODALITY[k.modality] || k.modality);
  const conf = k.confidence == null ? '未评估' : k.confidence.toFixed(2);
  const body = k.text != null ? k.text : k.claim ? name(k.claim.speaker) + '说：“' + k.claim.sentences.join('') + '”' : observationText(k.observation);
  return el('li', {}, head, (k.order === 2 ? '（关于' + name(k.concerning) + '怎么看我）' : ''), body, el('span', { className: 'muted' }, '\u3000第' + k.round + '回合 · 相信程度 ' + conf));
}

function renderGlobal(r) {
  const out = [];
  out.push(el('h2', {}, '第 ' + r.round + ' 回合：行动'));
  for (const p of r.proposals) {
    out.push(el('div', { className: 'card' },
      el('div', {}, el('strong', {}, p.actor), '\u3000', KIND[p.kind] || p.kind, p.target ? ' → ' + p.target : '', p.item ? '（' + p.item + '）' : '', p.toZone ? ' → ' + p.toZone : '', el('span', { className: 'tag' }, p.source), p.rejected ? el('span', { className: 'warn' }, ' 被拒绝：' + p.rejected) : null),
      p.sentences.length ? el('div', {}, '“' + p.sentences.join('') + '”') : null,
      p.intent ? el('div', { className: 'muted' }, '目标：' + p.intent + '\u3000依据：' + (p.rationale || '')) : null,
      p.innerThought ? el('div', { className: 'thought' }, '内心：' + p.innerThought) : null));
  }
  if (r.rulings.length) {
    out.push(el('h3', {}, '语义裁决'));
    out.push(el('ul', {}, r.rulings.map((x) => el('li', {}, x.requestId + '：' + x.rationale, x.by ? el('span', { className: 'tag' }, x.by === 'auto' ? '自动接受' : '作者确认') : null, x.needsReview ? el('span', { className: 'warn' }, ' 待复核') : null, x.uncertainties.length ? el('div', { className: 'muted' }, '待核实：' + x.uncertainties.join('；')) : null))));
  }
  out.push(el('h3', {}, '发生的事与感知'));
  out.push(el('ul', {}, r.occurrences.map((o) => el('li', {}, (o.actor ? o.actor + ' ' : '') + (KIND[o.kind] || o.kind) + (o.item ? ' ' + o.item : '') + (o.target ? ' → ' + o.target : '') + ' @' + o.zones.join('→') + (o.sentences.length ? '：“' + o.sentences.join('') + '”' : '') + (o.visual ? '：' + o.visual : '') + (o.sound ? '（' + o.sound + '）' : ''), el('div', { className: 'muted' }, o.perceivedBy.length ? '感知：' + o.perceivedBy.map((p) => p.actor + '（' + (CHANNEL[p.channel] || p.channel) + '）').join('、') : '无人察觉')))));
  out.push(el('h3', {}, '世界状态（回合结束时）'));
  out.push(el('table', {}, el('tr', {}, el('th', {}, '人物'), el('th', {}, '位置'), el('th', {}, '伤势'), el('th', {}, '状态')), r.world.actors.map((a) => el('tr', {}, el('td', {}, a.name), el('td', {}, a.zone), el('td', {}, INJURY[a.injury] || a.injury), el('td', {}, a.status === 'present' ? '在场' : '已离开')))));
  out.push(el('ul', {}, r.world.items.map((i) => el('li', {}, i.name + '：' + i.where + Object.entries(i.counters).map(([k, v]) => '（' + k + ' ' + v + '）').join(''))), r.world.mechanisms.map((m) => el('li', {}, m.name + '（' + m.zone + '）：' + (m.armed ? '未触发' : '已触发')))));
  if (r.notes.length) { out.push(el('h3', {}, '提示')); out.push(el('ul', {}, r.notes.map((n) => el('li', { className: 'warn' }, n)))); }
  return out;
}

function renderActor(r, id) {
  const v = r.views[id];
  if (!v) return [el('p', {}, '没有数据')];
  return [
    el('h2', {}, name(id) + '所见（第 ' + r.round + ' 回合结束时）'),
    el('p', {}, '在' + v.zone + '，' + (INJURY[v.injury] || v.injury) + (v.status === 'present' ? '' : '，已离开现场') + '。身上：' + (v.items.join('、') || '无')),
    el('h3', {}, '看得见的人与物'),
    el('ul', {}, v.visibleActors.map((a) => el('li', {}, a.name + '（' + a.zone + '）' + (a.holding.length ? '，手里拿着' + a.holding.join('、') : ''))), v.visibleItems.map((i) => el('li', {}, i.name + '（' + i.zone + '）')), v.mechanisms.map((m) => el('li', {}, '知道：' + m))),
    el('h3', {}, '认知（可能与事实不符）'),
    el('ul', {}, v.knowledge.map(knowledgeItem)),
  ];
}

function render() {
  const rounds = document.getElementById('rounds');
  rounds.replaceChildren(...data.rounds.map((r, i) => { const b = el('button', { textContent: '第 ' + r.round + ' 回合' }); b.setAttribute('aria-selected', String(i === round)); b.onclick = () => { round = i; render(); }; return b; }));
  const tabs = document.getElementById('tabs');
  const items = [['global', '全局局面'], ...data.actors.map((a) => [a.id, a.name + '所见'])];
  tabs.replaceChildren(...items.map(([id, label]) => { const b = el('button', { textContent: label }); b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(tab === id)); b.onclick = () => { tab = id; render(); }; return b; }));
  const r = data.rounds[round];
  const content = document.getElementById('content');
  content.replaceChildren(...(r ? (tab === 'global' ? renderGlobal(r) : renderActor(r, tab)) : [el('p', {}, '还没有完成的回合。')]));
}
render();
`;
