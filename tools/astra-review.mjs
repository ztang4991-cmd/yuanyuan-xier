#!/usr/bin/env node
/**
 * astra-review.mjs — GPT-6 Astra 规则层审核（reviewer 的第一道闸）
 *
 * 用法：
 *   node tools/astra-review.mjs --stage director   --episode 番外01
 *   node tools/astra-review.mjs --stage art        --episode 脚本03
 *   node tools/astra-review.mjs --stage music      --episode 脚本05
 *   node tools/astra-review.mjs --stage storyboard --episode 脚本06
 *   可选：--files a.md,b.md   覆盖默认待审文件
 *         --effort low|medium|high   推理档位（默认 medium）
 *         --dry                      只打印将投喂的文件清单，不调用 API
 *
 * 输出：outputs/<集数>/astra-review-<stage>.md  +  同名 .json（机读）
 *
 * 设计原则（见 GPT-6-Astra接入定位建议报告.md 第四节）：
 *   1. 只做规则层：违反 skill 验收清单 / 技术约束 / 合规红线 的可判定问题
 *   2. 每条问题必须带 file + quote（原文逐字短引）+ rule_source，程序回查 quote 是否存在，查不到即丢弃
 *   3. 审美/气质类判断不由本脚本签字，留给 Claude reviewer 复盘
 *   4. 密钥只从 .env.local 读取，该文件在 .gitignore 中
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const argv = parseArgs(process.argv.slice(2));
if (!argv.stage || !argv.episode) die('必须提供 --stage 与 --episode');

const STAGES = {
  director: {
    label: '阶段二 · 导演分析',
    skill: '.claude/skills/script-analysis-review-skill/SKILL.md',
    targets: (ep) => [`outputs/${ep}/01-director-analysis.md`],
    upstream: (ep) => [findScript(ep)].filter(Boolean),
  },
  art: {
    label: '阶段三 · 服化道',
    skill: '.claude/skills/art-direction-review-skill/SKILL.md',
    targets: (ep) => [
      'assets/visual/character-prompts.md', 'assets/visual/scene-prompts.md', 'assets/visual/prop-prompts.md',
      `outputs/${ep}/02-art-design-draft.md`,
    ],
    upstream: (ep) => [`outputs/${ep}/01-director-analysis.md`],
  },
  music: {
    label: '阶段四 · 音乐',
    skill: null, // CLAUDE.md：音乐阶段由 reviewer 亲自审核，无专属 skill；只用方法论 + 合规
    targets: () => ['assets/music/music-design.md', 'assets/music/music-recommendations.md', 'assets/music/lyrics-drafts.md'],
    upstream: (ep) => [`outputs/${ep}/01-director-analysis.md`],
  },
  storyboard: {
    label: '阶段五 · 分镜',
    skill: '.claude/skills/seedance-prompt-review-skill/SKILL.md',
    targets: (ep) => [`outputs/${ep}/video-prompts.md`, `outputs/${ep}/episode-master.md`],
    upstream: (ep) => [`outputs/${ep}/01-director-analysis.md`],
  },
};
const stage = STAGES[argv.stage];
if (!stage) die(`未知 stage：${argv.stage}，可选 ${Object.keys(STAGES).join('/')}`);

const ep = argv.episode;
const SHARED = [
  '.claude/skills/_shared/review-methodology.md',
  '.claude/skills/_shared/ai-generation-constraints.md',
  '.claude/skills/compliance-review-skill/SKILL.md',
  '.project-config.json',
  'assets/story/script-settings.md',
  'assets/story/creative-brief.md',
];
const targets = (argv.files ? argv.files.split(',') : stage.targets(ep)).filter(exists);
if (!targets.length) die(`找不到任何待审文件（stage=${argv.stage}, ep=${ep}）`);
const upstream = stage.upstream(ep).filter(exists);
const rules = [stage.skill, ...SHARED].filter(Boolean).filter(exists);

console.log(`\n▶ Astra 规则层审核 · ${stage.label} · ${ep}`);
listFiles('规则/约束', rules); listFiles('上游参照', upstream); listFiles('待审文件', targets);
if (argv.dry) process.exit(0);

// ---------- 组装 prompt ----------
const fileBlock = (title, files) => files.map((f) => `\n<file path="${f}" role="${title}">\n${read(f)}\n</file>`).join('\n');
const system = `你是 KAIKAI 影视流水线的「规则层审核员」。只用中文。
你的职责范围严格限定为**可判定的规则型问题**：
- 待审文件违反了规则文件（skill 验收清单 / ai-generation-constraints / compliance 红线 / .project-config.json 硬约束）中的哪一条
- 待审文件与上游参照文件之间的事实性矛盾（人名、角色数量、时间码、时长、道具状态、场景、画幅、模式）
- 遗漏：上游参照有、待审文件没覆盖的项

**不要**评价审美、气质、是否感人、方言是否地道——那不在你的职责内，另有人负责。

硬性要求：
1. 每条 issue 的 quote 必须是待审文件里**逐字连续**的原文片段（10-80 字），不能改写、不能拼接、不能只写位置。程序会回查，查不到的条目会被作废并记入你的错误率。
2. rule_source 写明违反了哪个文件的哪条规则，引用规则原文关键词。
3. severity：blocker = 会让下游生成失败或触碰合规红线；major = 与上游矛盾或漏项；minor = 表述不精确但不致错。
4. 评分按 review-methodology 的 1-10 制，对该阶段 skill 列出的每个评分维度各给一个分。合规是清单制，只给 PASS/FAIL。
5. 找问题不是确认通过。如果一条问题都没有，请在 notes 里写明你逐项核对了哪些维度。`;

const user = `# 项目硬约束（.project-config.json 已随文件附上，重点：storyboard_overrides.global、video_model_config.min_seconds/max_seconds、aspect_ratio）

# 规则与约束文件
${fileBlock('rule', rules)}

# 上游参照文件（待审文件必须与之一致）
${fileBlock('upstream', upstream)}

# 待审文件
${fileBlock('target', targets)}

请按 system 要求输出审核结果。`;

const schema = {
  type: 'object', additionalProperties: false,
  required: ['business_verdict', 'compliance_verdict', 'scores', 'issues', 'notes'],
  properties: {
    business_verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    compliance_verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    scores: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['dimension', 'score', 'basis'], properties: { dimension: { type: 'string' }, score: { type: 'integer' }, basis: { type: 'string' } } } },
    issues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind', 'file', 'quote', 'rule_source', 'severity', 'problem', 'fix'], properties: {
      kind: { type: 'string', enum: ['business', 'compliance'] },
      file: { type: 'string' }, quote: { type: 'string' }, rule_source: { type: 'string' },
      severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
      problem: { type: 'string' }, fix: { type: 'string' },
    } } },
    notes: { type: 'string' },
  },
};

// ---------- 调用 ----------
const env = loadEnv();
const body = {
  model: env.CATKING_MODEL || 'gpt-6-astra',
  reasoning_effort: argv.effort || 'medium',
  messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  response_format: { type: 'json_schema', json_schema: { name: 'astra_review', strict: true, schema } },
};
const approxTokens = Math.round((system.length + user.length) / 1.6);
console.log(`\n投喂约 ${approxTokens.toLocaleString()} token（估算），推理档位 ${body.reasoning_effort}，模型 ${body.model}`);
if (approxTokens > 250_000) console.warn('⚠ 接近 272K 价格悬崖，建议用 --files 拆分投喂');

const t0 = Date.now();
const result = await callWithRetry(env, body);
const secs = ((Date.now() - t0) / 1000).toFixed(1);
const content = result.choices?.[0]?.message?.content;
if (!content) die('模型未返回 content：' + JSON.stringify(result).slice(0, 500));
let review; try { review = JSON.parse(content); } catch (e) { die('返回不是合法 JSON：' + content.slice(0, 500)); }

// ---------- 回查 quote ----------
const cache = {};
const verified = [], dropped = [];
for (const is of review.issues) {
  const f = is.file.replace(/\\/g, '/');
  const txt = cache[f] ??= (exists(f) ? read(f) : null);
  const ok = txt !== null && normalize(txt).includes(normalize(is.quote));
  (ok ? verified : dropped).push(is);
}
// 复算 verdict：只按经回查存活的问题判定
const hasBlocker = (k) => verified.some((i) => i.kind === k && i.severity === 'blocker');
const avg = review.scores.length ? review.scores.reduce((a, s) => a + s.score, 0) / review.scores.length : null;
const minScore = review.scores.length ? Math.min(...review.scores.map((s) => s.score)) : null;
const businessVerdict = (avg !== null && (avg < 8 || minScore < 6)) || hasBlocker('business') || verified.some((i) => i.kind === 'business' && i.severity === 'major') ? 'FAIL' : 'PASS';
const complianceVerdict = verified.some((i) => i.kind === 'compliance') ? 'FAIL' : 'PASS';

// ---------- 写报告 ----------
const outDir = path.join(ROOT, 'outputs', ep); fs.mkdirSync(outDir, { recursive: true });
const base = path.join(outDir, `astra-review-${argv.stage}`);
const now = new Date();
const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())} UTC+08:00`;
const sevIcon = { blocker: '🔴', major: '🟠', minor: '🟡' };
const md = `# Astra 规则层审核 · ${stage.label} · ${ep}

> 审核时间：${stamp}　模型：${body.model}（推理 ${body.reasoning_effort}）　耗时 ${secs}s　tokens：${result.usage?.prompt_tokens ?? '?'} in / ${result.usage?.completion_tokens ?? '?'} out
> 本报告只覆盖**规则层**（技术约束 / 上游一致性 / 合规红线）。审美与气质判断由 Claude reviewer 另行复盘。
> quote 回查：${verified.length} 条通过，${dropped.length} 条因原文不存在被作废${dropped.length ? '（见文末）' : ''}。

## 结论

| 项 | 模型自报 | 回查后复算 |
|---|---|---|
| 业务审核 | ${review.business_verdict} | **${businessVerdict}** |
| 合规审核 | ${review.compliance_verdict} | **${complianceVerdict}** |

## 评分表

| 维度 | 分 | 依据 |
|---|---:|---|
${review.scores.map((s) => `| ${s.dimension} | ${s.score} | ${s.basis} |`).join('\n')}
${avg !== null ? `\n**平均分：${avg.toFixed(1)} / 10**　最低单项：${minScore}（阈值：平均 ≥ 8 且无单项 < 6）` : ''}

## 问题清单（${verified.length} 条，已通过原文回查）

${verified.length ? verified.map((i, n) => `### 问题 ${n + 1} ${sevIcon[i.severity]} ${i.severity} · ${i.kind === 'compliance' ? '合规' : '业务'}
- **文件**：${i.file}
- **原文**：「${i.quote}」
- **违反**：${i.rule_source}
- **问题**：${i.problem}
- **修改方向**：${i.fix}
`).join('\n') : '_无_'}

## 审核员备注

${review.notes}
${dropped.length ? `\n## 已作废条目（quote 在原文中找不到，不予采信）

${dropped.map((i) => `- ${i.file}：「${i.quote.slice(0, 60)}」 — ${i.problem}`).join('\n')}
` : ''}
## 待审文件

${targets.map((f) => `- ${f}`).join('\n')}
`;
fs.writeFileSync(base + '.md', md, 'utf8');
fs.writeFileSync(base + '.json', JSON.stringify({ stamp, model: body.model, effort: body.reasoning_effort, usage: result.usage, businessVerdict, complianceVerdict, scores: review.scores, verified, dropped, notes: review.notes, targets }, null, 2), 'utf8');

console.log(`\n业务：${businessVerdict}　合规：${complianceVerdict}　问题 ${verified.length} 条（作废 ${dropped.length}）　${secs}s`);
for (const i of verified) console.log(`  ${sevIcon[i.severity]} [${i.file}] ${i.problem}`);
console.log(`\n报告：${path.relative(ROOT, base)}.md`);

// ---------- helpers ----------
function parseArgs(a) { const o = {}; for (let i = 0; i < a.length; i++) { if (a[i].startsWith('--')) { const k = a[i].slice(2); const v = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true; o[k] = v; } } return o; }
function die(m) { console.error('✖ ' + m); process.exit(1); }
function abs(f) { return path.isAbsolute(f) ? f : path.join(ROOT, f); }
function exists(f) { return fs.existsSync(abs(f)); }
function read(f) { return fs.readFileSync(abs(f), 'utf8'); }
function p2(n) { return String(n).padStart(2, '0'); }
function normalize(s) { return s.replace(/\s+/g, '').replace(/[“”"]/g, '"').replace(/[‘’']/g, "'"); }
function listFiles(t, fs_) { console.log(`  ${t}：`); for (const f of fs_) console.log(`    - ${f} (${(fs.statSync(abs(f)).size / 1024).toFixed(1)} KB)`); }
function findScript(ep) {
  const dirs = ['script', 'script/10个争议脚本-30s', 'script/四川话60s短剧', 'script/番外'];
  for (const d of dirs) { if (!exists(d)) continue; const hit = fs.readdirSync(abs(d)).find((n) => n.startsWith(ep + '-') || n.startsWith(ep + '.')); if (hit) return `${d}/${hit}`; }
  return null;
}
function loadEnv() {
  const p = path.join(ROOT, '.env.local');
  if (!fs.existsSync(p)) die('缺少 .env.local（需含 CATKING_API_KEY / CATKING_BASE_URL）');
  const env = Object.fromEntries(fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  if (!env.CATKING_API_KEY || !env.CATKING_BASE_URL) die('.env.local 缺字段');
  return env;
}
async function callWithRetry(env, body, tries = 4) {
  const url = env.CATKING_BASE_URL.replace(/\/$/, '') + '/v1/chat/completions';
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + env.CATKING_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(600_000) });
      const txt = await r.text();
      if (r.ok) return JSON.parse(txt);
      last = `HTTP ${r.status} ${txt.slice(0, 200)}`;
    } catch (e) { last = e.message; }
    console.warn(`  重试 ${i + 1}/${tries}：${last}`); await new Promise((s) => setTimeout(s, 4000 * (i + 1)));
  }
  die('调用失败：' + last);
}
