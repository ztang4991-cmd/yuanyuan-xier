# tools/ · 项目工具脚本

## astra-review.mjs — GPT-6 Astra 规则层预审

审核工作流的第零步。用 GPT-6 Astra（与创作 agent 不同的模型家族）先审规则型问题，再交 Claude reviewer 审审美。定位依据见根目录 `GPT-6-Astra接入定位建议报告.md`。

### 前置

- Node ≥ 20（已验证 v24.15.0），无需 npm install
- 项目根目录 `.env.local`（已在 .gitignore，绝不提交）：
  ```
  CATKING_API_KEY=sk-...
  CATKING_BASE_URL=https://www.catkingai.com
  CATKING_MODEL=gpt-6-astra   # 可选，默认即此
  ```

### 用法

```bash
node tools/astra-review.mjs --stage director   --episode 番外01
node tools/astra-review.mjs --stage art        --episode 脚本03
node tools/astra-review.mjs --stage music      --episode 脚本05
node tools/astra-review.mjs --stage storyboard --episode 脚本06

# 可选参数
--files a.md,b.md        覆盖默认待审文件（逗号分隔，相对项目根）
--effort low|medium|high 推理档位，默认 medium；纯格式校验用 low 省钱
--dry                    只列出将投喂的文件，不调用 API
```

### 每个 stage 自动投喂什么

| stage | 审核 skill | 待审文件 | 上游参照 |
|---|---|---|---|
| director | script-analysis-review-skill | outputs/<集>/01-director-analysis.md | script/ 下对应剧本（自动在四个子目录里找） |
| art | art-direction-review-skill | assets/visual/{character,scene,prop}-prompts.md + outputs/<集>/02-art-design-draft.md | 01-director-analysis.md |
| music | 无专属 skill（同 CLAUDE.md） | assets/music/ 三个文件 | 01-director-analysis.md |
| storyboard | seedance-prompt-review-skill | outputs/<集>/video-prompts.md + episode-master.md | 01-director-analysis.md |

所有 stage 都附带：review-methodology、ai-generation-constraints、compliance-review-skill、.project-config.json、script-settings、creative-brief。

### 输出

- `outputs/<集>/astra-review-<stage>.md` — 人读报告：结论表（模型自报 vs 回查后复算）、评分表、问题清单、作废条目
- `outputs/<集>/astra-review-<stage>.json` — 机读，供后续脚本或 reviewer 读取

### 防幻觉机制

每条问题的 `quote` 必须是待审文件里逐字连续的原文。脚本读原文回查（忽略空白与引号差异），查不到的条目**作废**并单列在报告末尾，不计入 verdict。verdict 由脚本按存活问题 + 评分阈值复算，不直接采信模型自报。

### 已知情况（2026-09-07 实测）

- 中转在每次请求前注入约 7K token 的系统提示，小请求也按 8K 计费
- 单次导演稿审核（约 18K 投喂）耗时约 4 分钟，19K in / 3K out
- 中转偶发 HTTP 502 "Upstream access forbidden"，脚本重试 4 次后报错；此时跳过预审，直接进 reviewer 并标注
- 模型自报知识截止 2024-06，与官方文档 2026-04 不符——不要依赖它对自身的描述
- 只能用 Node 调用（用户要求），不要改回 Python
