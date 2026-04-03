# Recall

Recall 是一个基于 Bun monorepo 的知识闭环系统，定位为 Anki + Perplexity + NotebookLM + Obsidian 的融合体。

系统目标：

- 把全网知识封装成 `truth`，也就是原子事实，作为最小知识单元。
- 通过 Web Search + RAG + AI + 个性化推荐算法形成知识闭环。
- 用图谱进度和 AI 主动推荐帮助用户在 80 天内把任意领域掌握度从 0 拉到 80。

## Monorepo 结构

- `apps/web`: React + UnoCSS 前端。全部使用 UnoCSS attributify，不走 `style.css`。
- `apps/api`: Elysia + SQLite 后端，负责 truth 采集、标签分类、RAG 搜索、推荐与图谱接口。
- `apps/mcp-server`: 官方 MCP TypeScript SDK 的 stdio server，原生暴露 Recall 的知识工具。
- `packages/domain`: 核心领域模型与可测试算法，包括去重、三级标签路径选择、图谱进度与推荐排序。

## 核心技术方案

### Truth 采集流水线

1. 通过 `web-search-api` 或 `grok-search` 获取搜索结果。
2. 对命中的网页执行正文提取，使用 `Readability + linkedom` 抽出主内容。
3. 把页面文本送入兼容 OpenAI 的 Chat API，抽取 `truth list`。
4. 对 truth 去重，保留证据更强、置信度更高的版本。
5. 用三级 taxonomy 给每条 truth 打标签。
6. 将 truth、tag、学习信号落进 SQLite。
7. 使用本地 embedding 模型构建 truth 向量，驱动语义搜索和 RAG 检索。

### 三级标签分类算法

这里没有做 fallback。

分类算法是三段式：

1. `AI taxonomy planning`
   给定用户输入领域，LLM 先生成 1 级大方向、2 级细分领域、3 级可执行方向的 taxonomy 树。
2. `Embedding retrieval`
   使用本地多语种 embedding 模型，把 truth 和 taxonomy 节点全部向量化，先做候选路径召回。
3. `LLM rerank`
   把 top 路径集交给 LLM 精排，只允许从候选集合中选一个最终路径。

这套设计的好处是：

- taxonomy 不是硬编码死目录，能随领域动态扩展。
- 召回靠 embedding，解决同义表达和跨语种问题。
- 精排靠 LLM，解决纯向量相似度不够细的问题。

### 推荐与进度

- tag 进度来自该 tag 覆盖 truth 的平均掌握度。
- 推荐排序综合考虑：
  - tag 缺口
  - 当前 truth 的掌握缺口
  - 是否到达复习时点
- 前端会把所有现存 tag 的进度绘制出来，并且在推荐页允许直接记录学习信号。

## Provider 约定

### AI Chat Gateway

后端使用兼容 OpenAI 的 `/chat/completions` 接口做：

- taxonomy planning
- truth extraction
- taxonomy rerank

你给的网关可以直接用在这里。

### Embedding

embedding 不依赖你给的网关，而是本地跑 `Xenova/paraphrase-multilingual-MiniLM-L12-v2`。

这是刻意的架构选择，不是 fallback。
原因是当前提供的模型列表没有直接暴露 embedding 模型，但系统又必须原生支持语义搜索与 embedding 分类。

### Web Search API

`web-search-api` provider 约定请求/响应为：

请求：

```json
{
  "query": "React hooks",
  "limit": 5
}
```

响应：

```json
{
  "results": [
    {
      "title": "Title",
      "url": "https://example.com",
      "snippet": "Summary"
    }
  ]
}
```

### Grok Search

`grok-search` 现在走兼容 OpenAI 的 Chat Completions 网关，默认指向 `https://ai.huan666.de/v1`，并使用 `grok-4.20-beta` 通过提示词执行实时联网搜索。模型被强约束为只返回 `{"results":[...]}` 这种原始 JSON，服务端会做严格解析，拒绝散文式输出。

## 环境变量

参考：

- [apps/api/.env.example](/E:/Codespace/Recall/apps/api/.env.example)
- [apps/web/.env.example](/E:/Codespace/Recall/apps/web/.env.example)
- [apps/mcp-server/.env.example](/E:/Codespace/Recall/apps/mcp-server/.env.example)

## 启动

安装依赖：

```bash
bun install
```

运行测试：

```bash
bun test
```

类型检查：

```bash
bun run typecheck
```

构建：

```bash
bun run build
```

启动 API：

```bash
bun run dev:api
```

启动前端：

```bash
bun run dev:web
```

一键启动完整开发环境：

```bash
bun dev
```

这会并发启动：

- `apps/web`
- `apps/api`

启动 MCP Server：

```bash
bun run dev:mcp
```

`dev:mcp` 不并入 `bun dev`，因为当前 MCP server 走的是 stdio transport，而不是 HTTP transport。它需要被 MCP client 进程接管标准输入输出，作为独立进程使用才是正确形态。

## MCP 工具

当前 MCP server 暴露三个原生工具：

- `knowledge.collect`
- `truth.search`
- `tag.progress`

它们与 API 共用同一套 SQLite 数据和 truth pipeline。
