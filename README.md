<div align="center">

# ✨ Recall Station

**基于 MCP 的全网原子事实提炼与知识闭环工作站**
</br>
<em>A Closed-Loop Knowledge Station Combining Anki, Perplexity, NotebookLM, and Obsidian</em>

[![Bun](https://img.shields.io/badge/Bun-Runtime-black?style=flat-square&logo=bun)](https://bun.sh/)
[![React](https://img.shields.io/badge/React-Frontend-61DAFB?style=flat-square&logo=react&logoColor=black)](https://reactjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>


**Recall** 是一个由 Bun monorepo 驱动的新一代智能知识工作站。它彻底摒弃了传统笔记软件的被动收藏模式，将任何领域的全网碎片知识深度重构提炼为**原子事实（Truth）**。通过自动化构建的三级分类路标与主动图谱推荐，Recall 旨在为你提供一个“不需要整理的第二大脑”，帮助你在 80 天内把任意领域的掌握度无痛从 0 拉升到 80。

> 💡 **你需要做的**：输入任意感兴趣的研究课题（如："Vite 底层原理" 或 "宏观经济学框架"）。</br>
> 🧠 **Recall 给你的**：经过自动化深度检索、AI 脱水提纯的系统性“事实清单”，以及为你量身动态生成的知识索引树与复习排序。

通过无缝整合 Web Search、局部向量提取（RAG）、AI 内容清洗与个性化学习间隔（Spaced Repetition），实现了**搜集、理解、反刍、内化**的全景式知识流闭环。

---

## 📸 沉浸式流体界面

<div align="center">
<table>
<tr>
<td><img src="https://via.placeholder.com/600x380/F5F5F5/1A1A1A?text=STATION:+Knowledge+Pipeline" alt="Station View" width="100%"/></td>
<td><img src="https://via.placeholder.com/600x380/0A0A0A/E5E5E5?text=REPOSITORY:+Dynamic+Taxonomy" alt="Taxonomy View" width="100%"/></td>
</tr>
<tr>
<td align="center"><b>采集调度中枢</b>: 动态掌控全网提取进度</td>
<td align="center"><b>归因拓扑与图谱</b>: 全局概念网络与事实检索</td>
</tr>
</table>
</div>

## ⚙️ 核心技术引擎

### 1. Truth 纯化与采集流水线
1. 🕸 **信息捕获**：通过 `web-search-api` 或 `grok-search` 进行实时搜索。
2. 📖 **正文提纯**：利用 `Readability` + `linkedom` 剥离广告噪音，抽出沉浸式主内容。
3. 🔬 **降维裂变**：将页面文本送入 LLM 执行大刀阔斧的“脱水”，抽取成独立完整的 `Truth`（事实）原子。
4. ⚔️ **去重对抗**：将新知识与已有知识碰撞比对，只留存证据链最强、最丰满的版本。
5. 🏷️ **归档上架**：运用三级 Taxonomy 算法为每一个原子事实寻找坐标，存埋入 SQLite。
6. 🌌 **向量激活**：本地运行 `Xenova` 模型计算高维映射，引爆后续所有的语义查询和 RAG 生成。

### 2. 动态生长式三级标签 (Taxonomy)
我们拒绝死板写死的根目录模式：
- **AI 战略规划**：给定输入，LLM 自动推演拆解 1级体系 -> 2级分支 -> 3级落脚点。
- **混合向量召回**：本地并行 Embedding（`Xenova/paraphrase-multilingual-MiniLM-L12-v2`）抹平多语种与同义词差异，精准吸纳。
- **LLM 再平衡**：Top 碰撞集交由 LLM 精排决策，把事实挂靠到分类树上最严丝合缝的树冠。

### 3. 主动推荐与遗忘曲线
- **Tag 刻度**：每个标签领域的进度由其下属所有 Truth 掌握度的分形递归计算得出。
- **推荐排序法则**：智能综合评估 Tag 知识缺口、单点 Truth 掌握度以及触发复习记忆时点。
- 不用去搜索知识，让知识主动寻找你。

---

## 🏗 Monorepo 库结构

系统底层基于干净利落的领域驱动设计（DDD）：

| 包名 | 职责栈 |
|------|-------------|
| `apps/web` | **前端触点**：React + UnoCSS 驱动，Noir/Luxury 极简风格呈现的高频动态交互壳 |
| `apps/api` | **后端引擎**：Elysia + SQLite 驱动，跑通所有的 truth 洗筹、标签拆解、RAG 检索请求 |
| `apps/mcp-server` | **协议代理**：基于官方 MCP TypeScript SDK，原生暴露 Recall 的所有底层资产给外部大模型环境 |
| `packages/domain` | **神经中枢**：高度可复用的核心算法（去重矩阵、路径规划策略、记忆热度衰减公式等） |

---

## 🔌 拓扑 Provider 协议

**1. 一次配置，终身适用 AI Chat Gateway**  
完全兼容标准 OpenAI 的 `/chat/completions` API，用于各类大体量提纯（Planning、Extraction、Rerank）。

**2. 本地原生 Embeddings**  
系统不仅是为了保护隐私，也是为了保持本地分类决策的高频极速调用能力，内嵌原生模型而非强依赖外部网关。

**3. Grok Search / Web API**  
基于 `grok-4.20-beta` （或常规代理）深度约束模型幻觉，强制输出结构化 `{"results":[...]}` 信息流，严格摒弃冗长空泛的内容。

---

## 🚀 启动向导 (Quick Start)

### 环境配置

参考项目内的 `.env.example` 标准：
- `apps/api/.env`
- `apps/web/.env`
- `apps/mcp-server/.env`

### 安装部署

```bash
# 安装所有的依附依赖
bun install

# 执行严格的数据层校验与逻辑跑通
bun test

# 前后端联合类型自检
bun run typecheck
```

### 一键拉起

```bash
# 全功能联动：一键并发启动 apps/web 与 apps/api
bun dev
```

> **注意针对 MCP 服务开发**：  
> MCP server 基于 Stdio transport 设计协议通道，不要连带进入 `bun dev` 的 HTTP 流内。  
> 必须单独拉起被客户端接托管：`bun run dev:mcp`

---

## 🤖 MCP 赋能
系统现已基于最新的 Model Context Protocol (MCP)，将这套精妙的引擎直接作为工具抛给未来所有兼容的智体使用：
- `knowledge.collect`  *(搜集清洗代理)*
- `truth.search` *(高维向量唤醒)*
- `tag.progress` *(刻度查询接口)*
