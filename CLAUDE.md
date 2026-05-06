# 架构说明

本文件面向开发者。终端用户文档见 [`README.md`](README.md)。

## 这个项目是什么

一个网页应用,通过编排 8 个专门的 LLM agent 和一个确定性的 Python 蒙特卡洛仿真器,帮用户思考**单个非平凡决策**。决策类型通用 —— 选 offer、择校、地点、大件采购、人生选择,任何"有限备选 + 不确定结果"的场景。

## 文件一览

| 文件 | 用途 |
|---|---|
| `index.html` | 单页前端(表单、流水线仪表盘、报告渲染、活动日志) |
| `prompts.js` | 9 次 LLM 调用对应的 8 个 prompt 构造函数 |
| `server.py` | 本地 HTTP 服务器:静态文件 + LLM API 代理 + `/api/simulate` 端点 |
| `simulator.py` | 确定性蒙特卡洛 + 敏感性引擎,纯 Python 标准库 |
| `templates/sim_spec.example.json` | LLM(MODEL-PARAMS) 与仿真器之间的契约示例 |
| `input/`, `data/`, `output/` | 运行时目录,均 gitignore |

## 流水线

```
FRAMEWORK
  ↓
ORACLE ‖ ECHO          (并行)
  ↓
MODEL-PARAMS           (LLM 输出 sim_spec)
  ↓
SIMULATE               (Python:蒙特卡洛 + 敏感性,确定性)
  ↓
MODEL-INTERPRET        (LLM 读真数字并解读)
  ↓
DEVIL ‖ SAGE           (并行)
  ↓
NEXUS                  (最终综合)
  ↓
MIRROR                 (元审查)
```

每个 LLM 步骤都是一次性 JSON 输出调用。输出会缓存到 `pipelineState`;失败的流水线可以从断点恢复。

## 仿真器边界

最重要的架构原则:

> **LLM 永远不计算数值结果。仿真器永远不编造先验。**

`MODEL-PARAMS`(LLM)输出一个 `sim_spec` JSON,包含:
- options
- scenarios(各带先验概率)
- outcomes,每个有 0–100 的 weight、方向(`higher_better` / `lower_better`)、用于归一化的 `expected_range`、以及每个(选项 × 场景)对的分布定义

仿真器严格校验该 spec(`simulator.validate`),用 stdlib `random` 抽样 N 条轨迹(默认 10,000),把每个结果归一化到 [0, 100],计算加权效用,对选项排名,然后用每个权重和场景概率 ±20% 扰动来跑敏感性。

`MODEL-INTERPRET`(LLM)再读真实的 `sim_results` 并解读 —— 它在 prompt 里被明确禁止用自己编的数字替换。

封闭分布菜单(`simulator.DISTRIBUTIONS`):
`normal · lognormal · triangular · beta · uniform · bernoulli · categorical`。
其他名字一律在校验阶段拒绝。

## 端点

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/` | 静态 index.html |
| GET | `/health` | 健康检查 + 服务器日期 |
| POST | `/save` | 保存用户输入 JSON 到 `input/` |
| GET | `/load` | 读取 `input/` 中保存的 JSON |
| POST | `/api/generate` | LLM 代理(OpenAI / DeepSeek / Gemini / Anthropic / OpenAI 兼容) |
| POST | `/api/simulate` | 运行 `simulator.simulate(spec)` |

代理会把 `[CURRENT DATE: ...]` 注入第一条 system message,防止模型用训练截止日期。同时注入语言指令,要求模型用简体中文回复。

## 加新分布

1. 把名字和必需参数加到 `simulator.DISTRIBUTIONS`。
2. 在 `simulator._sample` 加抽样分支。
3. 在 `simulator._check_dist_params` 加范围检查。
4. 更新 `prompts.js` 里 `MODEL-PARAMS` 系统 prompt 里列的菜单。
5. 形状特殊的话,在 `templates/sim_spec.example.json` 加示例。

## 加新 agent

1. 在 `prompts.js` 里加 `build<Name>Prompt` 函数,返回 `{messages, max_tokens}`。
2. 在 `index.html` `runPipeline` 里在合适位置插入调用,模仿现有的 `pipelineState` 缓存模式。
3. 加渲染函数,如果需要也更新流水线仪表盘对应阶段。

## 隐私

- `input/`、`data/`、`output/` 全部 gitignore —— 用户内容不进入仓库。
- 仓库只含框架代码:agent prompts、仿真器、契约示例。任何真实备选数据都不在版本控制里。

## 限制

- `n_iterations` 夹到 `[1000, 100_000]`,默认 10,000。
- `simulator.simulate` 的硬超时是 15 秒;敏感性循环超过后会短路。
- 未知分布名或越界参数会返回 HTTP 400 + 结构化 `errors[]`;前端应该把这些错误暴露给用户(或自动重试)以便修复 spec。

## 关于 prompts.js 的语言

agent 系统 prompt 保持英文 —— LLM 在英文 prompt 下行为最稳定。中文化通过在 `index.html` 的 `callAI()` 里向 system message 注入"用简体中文回复"实现。这样既保留了英文 prompt 的可控性,又保证报告输出是中文。

## 许可证

MIT
