import React, { useState, useEffect } from "react";
import { 
  LayoutDashboard, 
  Search, 
  Database, 
  Network, 
  PlusCircle, 
  Settings, 
  RefreshCw,
  BrainCircuit,
  Binary,
  GraduationCap,
  Loader2,
  Calendar,
  Layers,
  History
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// --- Utilities ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const API_BASE_URL = "http://localhost:4174";

type View = "dashboard" | "search" | "truths" | "graph" | "collect" | "settings";

interface TagProgress {
  nodeId: string;
  progress: number;
  truthCount: number;
}

type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

type CollectStreamEvent =
  | {
      type: "phase";
      phase: "search" | "read" | "taxonomy" | "truths" | "classify" | "embed" | "persist";
      status: "start" | "complete";
      message: string;
      count?: number;
      provider?: "web-search-api" | "grok-search";
    }
  | {
      type: "model";
      schemaName: string;
      channel: "reasoning" | "content";
      text: string;
    }
  | {
      type: "usage";
      scope: "search" | "ai";
      schemaName?: string;
      usage: TokenUsage;
      totals?: TokenUsage;
    }
  | {
      type: "error";
      message: string;
    }
  | {
      type: "result";
      result: {
        collectionId: string;
        truthCount: number;
        sourceCount: number;
        taxonomyCount: number;
      };
      usage: TokenUsage;
    };

type CollectLogEntry = {
  id: string;
  channel: "status" | "reasoning" | "content" | "error";
  label: string;
  text: string;
};

const emptyUsage = (): TokenUsage => ({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
});

const parseSseBuffer = (buffer: string) => {
  const chunks = buffer.split(/\r?\n\r?\n/);
  const remainder = chunks.pop() ?? "";

  return {
    remainder,
    events: chunks
      .map((chunk) =>
        chunk
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n"),
      )
      .filter((chunk) => chunk.length > 0),
  };
};

const readErrorResponse = async (response: Response) => {
  const payload = await response.text();

  try {
    const parsed = JSON.parse(payload) as { message?: string };
    return parsed.message ?? payload;
  } catch {
    return payload;
  }
};

// --- Components ---

const DockItem = ({ 
  icon: Icon, 
  label, 
  active, 
  onClick 
}: { 
  icon: any, 
  label: string, 
  active: boolean, 
  onClick: () => void 
}) => (
  <button
    onClick={onClick}
    className={cn(
      "relative flex items-center px-4 py-2 text-sm font-medium transition-all duration-300 rounded-[16px] group",
      active 
        ? "bg-ink text-canvas shadow-lg" 
        : "text-ink/60 hover:bg-fog hover:text-ink"
    )}
  >
    <Icon className={cn("w-4 h-4 transition-transform group-hover:scale-110", active ? "mr-2" : "")} />
    {active && (
      <motion.span 
        initial={{ opacity: 0, width: 0 }}
        animate={{ opacity: 1, width: "auto" }}
        className="overflow-hidden whitespace-nowrap"
      >
        {label}
      </motion.span>
    )}
    {!active && (
      <div className="absolute -top-10 left-1/2 -translate-x-1/2 bg-ink text-canvas text-[10px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
        {label}
      </div>
    )}
  </button>
);

const Card = ({ children, className, title }: { children: React.ReactNode, className?: string, title?: string }) => (
  <div className={cn("bg-fog/50 border border-line rounded-2xl p-6 transition-all hover:bg-fog/80 flex flex-col", className)}>
    {title && <h3 className="text-xs font-bold text-ink/40 uppercase tracking-widest mb-4">{title}</h3>}
    {children}
  </div>
);

const StatCard = ({ label, value, sub }: { label: string, value: string | number, sub?: string }) => (
  <Card className="p-4 py-6">
    <div className="text-[10px] font-bold text-ink/30 uppercase tracking-wider mb-2">{label}</div>
    <div className="text-2xl font-bold text-ink">{value || "-"}</div>
    {sub && <div className="text-[10px] text-ink/40 mt-1">{sub}</div>}
  </Card>
);

// --- Main Views ---

const DashboardView = ({ progress }: { progress: TagProgress[] }) => {
  const totalTruths = progress.reduce((acc, p) => acc + p.truthCount, 0);
  const avgProgress = progress.length > 0 ? progress.reduce((acc, p) => acc + p.progress, 0) / progress.length : 0;
  const today = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 max-w-5xl mx-auto">
      <header className="mb-12">
        <h1 className="text-3xl font-bold text-ink tracking-tight mb-2">概览</h1>
        <div className="flex items-center space-x-4 text-ink/40 text-sm font-medium">
          <div className="flex items-center">
            <Calendar className="w-4 h-4 mr-1.5 opacity-50" />
            {today}
          </div>
          <span>•</span>
          <div className="flex items-center">
            <Layers className="w-4 h-4 mr-1.5 opacity-50" />
            {progress.length} 个知识点
          </div>
          <span>•</span>
          <div className="flex items-center">
            <History className="w-4 h-4 mr-1.5 opacity-50" />
            {totalTruths} 天记录
          </div>
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="等级进度" value="-" />
        <StatCard label="金币" value="-" />
        <StatCard label="等级/时" value="-" />
        <StatCard label="金币/时" value="-" />
      </div>

      <div className="grid grid-cols-1 gap-6">
        <Card title="等级进度" className="min-h-[280px] items-center justify-center">
          <div className="text-ink/20 text-sm font-medium">暂无数据</div>
        </Card>
        
        <Card title="金币趋势" className="min-h-[280px] items-center justify-center">
          <div className="text-ink/20 text-sm font-medium">暂无数据</div>
        </Card>
      </div>

      {/* Spacing for Dock */}
      <div className="h-32" />
    </div>
  );
};

const SearchView = () => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const handleSearch = async () => {
    if (!query) return;
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/search/semantic?q=${encodeURIComponent(query)}`);
      const data = await response.json();
      setResults(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto py-12 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <div className="relative group">
        <div className="absolute inset-y-0 left-5 flex items-center pointer-events-none text-ink/30 group-focus-within:text-accent transition-colors">
          <Search className="w-5 h-5" />
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder="搜索知识库..."
          className="w-full bg-fog border border-line focus:ring-4 focus:ring-accent/10 rounded-2xl pl-14 pr-6 py-5 text-ink placeholder:text-ink/20 transition-all outline-none text-xl"
        />
        {loading && (
          <div className="absolute inset-y-0 right-6 flex items-center">
            <Loader2 className="w-5 h-5 text-accent animate-spin" />
          </div>
        )}
      </div>

      <div className="mt-16 space-y-4">
        {results.map((result, i) => (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05, duration: 0.5 }}
            key={i}
          >
            <div className="bg-canvas border border-line rounded-2xl p-5 hover:border-accent/40 hover:shadow-xl hover:shadow-accent/5 transition-all cursor-pointer group">
              <div className="text-base text-ink leading-relaxed font-medium">
                {result.statement || "未发现结果"}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {result.tags?.map((t: string) => (
                  <span key={t} className="text-[10px] uppercase tracking-widest font-bold text-accent/60 bg-accent/5 px-2.5 py-1 rounded-full border border-accent/10">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          </motion.div>
        ))}
      </div>
      <div className="h-32" />
    </div>
  );
};

// --- App Root ---

export const App = () => {
  const [view, setView] = useState<View>("dashboard");
  const [progress, setProgress] = useState<TagProgress[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Knowledge Collection State
  const [collectQuery, setCollectQuery] = useState("");
  const [collectProvider, setCollectProvider] = useState<"web-search-api" | "grok-search">("grok-search");
  const [collecting, setCollecting] = useState(false);
  const [collectPhase, setCollectPhase] = useState("等待启动");
  const [collectUsage, setCollectUsage] = useState<TokenUsage>(emptyUsage);
  const [collectLogs, setCollectLogs] = useState<CollectLogEntry[]>([]);
  const [collectError, setCollectError] = useState<string | null>(null);
  const [collectSummary, setCollectSummary] = useState<{
    collectionId: string;
    truthCount: number;
    sourceCount: number;
    taxonomyCount: number;
  } | null>(null);

  const fetchProgress = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/tags/progress`);
      const data = await response.json();
      if (Array.isArray(data)) {
        setProgress(data);
      }
    } catch (e) {
      console.error("Failed to fetch progress", e);
    } finally {
      setLoading(false);
    }
  };

  const handleCollect = async () => {
    if (!collectQuery.trim() || collecting) return;
    
    setCollecting(true);
    setCollectError(null);
    setCollectSummary(null);
    setCollectUsage(emptyUsage());
    setCollectPhase("准备建立采集流");
    setCollectLogs([
      {
        id: crypto.randomUUID(),
        channel: "status",
        label: "COLLECT",
        text: `准备采集：${collectQuery.trim()}`,
      },
    ]);

    const pushLog = (channel: CollectLogEntry["channel"], label: string, text: string) => {
      setCollectLogs((current) => {
        if (text.length === 0) {
          return current;
        }

        const last = current[current.length - 1];

        if (last && last.channel === channel && last.label === label) {
          return [
            ...current.slice(0, -1),
            {
              ...last,
              text: `${last.text}${text}`,
            },
          ];
        }

        return [
          ...current,
          {
            id: crypto.randomUUID(),
            channel,
            label,
            text,
          },
        ];
      });
    };

    try {
      let streamCompleted = false;
      const response = await fetch(`${API_BASE_URL}/knowledge/collect/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: collectQuery,
          provider: collectProvider,
        }),
      });

      if (!response.ok) {
        throw new Error(await readErrorResponse(response));
      }

      if (!response.body) {
        throw new Error("服务器没有返回可读取的流式内容。");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseBuffer(buffer);
        buffer = parsed.remainder;

        for (const rawEvent of parsed.events) {
          const event = JSON.parse(rawEvent) as CollectStreamEvent;

          if (event.type === "phase") {
            setCollectPhase(event.message);
            pushLog("status", `${event.phase.toUpperCase()} ${event.status.toUpperCase()}`, `${event.message}\n`);
            continue;
          }

          if (event.type === "model") {
            pushLog(event.channel, event.schemaName, event.text);
            continue;
          }

          if (event.type === "usage") {
            setCollectUsage(event.totals ?? event.usage);
            pushLog(
              "status",
              `TOKENS ${event.schemaName ?? event.scope.toUpperCase()}`,
              ` +${event.usage.totalTokens} tokens\n`,
            );
            continue;
          }

          if (event.type === "error") {
            streamCompleted = true;
            setCollectError(event.message);
            setCollectPhase("采集中断");
            pushLog("error", "ERROR", `${event.message}\n`);
            continue;
          }

          streamCompleted = true;
          setCollectSummary(event.result);
          setCollectUsage(event.usage);
          setCollectPhase("采集完成");
          setCollectQuery("");
          pushLog(
            "status",
            "RESULT",
            `完成：${event.result.truthCount} truths / ${event.result.taxonomyCount} tags / ${event.result.sourceCount} sources\n`,
          );
          await fetchProgress();
        }
      }

      if (!streamCompleted) {
        throw new Error("采集流在返回最终结果之前就关闭了。");
      }
    } catch (e) {
      console.error(e);
      const message = e instanceof Error ? e.message : "无法连接到服务器";
      setCollectError(message);
      setCollectPhase("采集失败");
      pushLog("error", "ERROR", `${message}\n`);
    } finally {
      setCollecting(false);
    }
  };

  useEffect(() => {
    fetchProgress();
  }, []);

  return (
    <div className="min-h-screen bg-canvas text-ink selection:bg-accent/20 selection:text-ink font-sans antialiased">
      {/* Dynamic View Header (Minimalist) */}
      <div className="fixed top-0 left-0 right-0 h-2 px-8 flex items-center justify-end z-50">
        <button 
          onClick={fetchProgress}
          className="p-4 mt-8 mr-4 bg-canvas/30 backdrop-blur-sm border border-line/30 rounded-full hover:bg-fog transition-all group shadow-sm active:scale-95"
        >
          <RefreshCw className={cn("w-4 h-4 text-ink/20 group-hover:text-accent transition-all", loading ? "animate-spin text-accent" : "")} />
        </button>
      </div>

      {/* Main Content Area */}
      <main className="pt-20 px-8 w-full max-w-7xl mx-auto">
        {loading && progress.length === 0 ? (
          <div className="h-[60vh] flex flex-col items-center justify-center space-y-4">
            <Loader2 className="w-10 h-10 text-accent animate-spin opacity-40" />
            <p className="text-ink/30 font-medium tracking-widest uppercase text-xs">正在连接知识引擎...</p>
          </div>
        ) : (
          <AnimatePresence mode="wait">
            <motion.div
              key={view}
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
              className="h-full"
            >
              {view === "dashboard" && <DashboardView progress={progress} />}
              {view === "search" && <SearchView />}
              {view === "truths" && (
                <div className="flex flex-col items-center justify-center h-[60vh] text-ink/20 space-y-4 animate-in fade-in duration-700">
                  <Database className="w-16 h-16 opacity-10" />
                  <p className="font-bold tracking-widest uppercase text-xs">知识库视图构建中</p>
                </div>
              )}
              {view === "collect" && (
                <div className="max-w-xl mx-auto space-y-12 pt-12 animate-in fade-in slide-in-from-bottom-4 duration-700">
                   <div className="space-y-3">
                     <h1 className="text-3xl font-extrabold text-ink tracking-tight">知识采集</h1>
                     <p className="text-ink/40 text-base">流式显示搜索、思考、抽取、分类和 token 进度，避免长时间无反馈。</p>
                   </div>
                    <div className="space-y-6">
                     <div className="space-y-2">
                       <label className="text-[10px] font-black text-ink/30 uppercase tracking-[0.2em] ml-1">检索关键词</label>
                       <input 
                         value={collectQuery}
                         onChange={(e) => setCollectQuery(e.target.value)}
                         className="w-full bg-fog border border-line rounded-2xl px-6 py-4 focus:ring-4 focus:ring-accent/10 outline-none transition-all text-lg font-medium" 
                         placeholder="例如：罗马史专题" 
                       />
                     </div>
                     <div className="space-y-2">
                       <label className="text-[10px] font-black text-ink/30 uppercase tracking-[0.2em] ml-1">检索渠道</label>
                       <select 
                         value={collectProvider}
                         onChange={(e) => setCollectProvider(e.target.value as any)}
                         className="w-full bg-fog border border-line rounded-2xl px-6 py-4 focus:ring-4 focus:ring-accent/10 focus:bg-canvas outline-none transition-all appearance-none cursor-pointer font-medium"
                       >
                          <option value="grok-search">Grok Search Bridge</option>
                          <option value="web-search-api">Web Search API</option>
                       </select>
                     </div>
                     <button 
                       disabled={collecting || !collectQuery.trim()}
                       onClick={handleCollect}
                       className="w-full bg-ink text-canvas font-bold py-5 rounded-2xl shadow-2xl shadow-ink/20 hover:scale-[1.01] active:scale-[0.99] transition-all text-lg flex items-center justify-center space-x-3 disabled:opacity-50 disabled:cursor-not-allowed"
                     >
                        {collecting ? (
                          <Loader2 className="w-5 h-5 animate-spin" />
                        ) : (
                          <PlusCircle className="w-5 h-5" />
                        )}
                        <span>{collecting ? "正在流式采集中..." : "启动知识捕获"}</span>
                     </button>

                     <div className="grid grid-cols-3 gap-3">
                       <StatCard label="Prompt Tokens" value={collectUsage.promptTokens} />
                       <StatCard label="Output Tokens" value={collectUsage.completionTokens} />
                       <StatCard label="Total Tokens" value={collectUsage.totalTokens} />
                     </div>

                     <Card title="当前阶段" className="space-y-3">
                       <div className="text-lg font-bold text-ink">{collectPhase}</div>
                       {collectSummary && (
                         <div className="text-sm text-ink/50">
                           collection {collectSummary.collectionId} · {collectSummary.truthCount} truths · {collectSummary.taxonomyCount} tags · {collectSummary.sourceCount} sources
                         </div>
                       )}
                       {collectError && (
                         <div className="text-sm font-medium text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">
                           {collectError}
                         </div>
                       )}
                     </Card>

                     <Card title="流式输出" className="space-y-4">
                       <div className="max-h-[360px] overflow-y-auto rounded-2xl bg-canvas border border-line/70 p-4 space-y-3">
                         {collectLogs.length === 0 ? (
                           <div className="text-sm text-ink/30">还没有开始采集。</div>
                         ) : (
                           collectLogs.map((entry) => (
                             <div key={entry.id} className="space-y-1">
                               <div className="text-[10px] font-black uppercase tracking-[0.18em] text-ink/30">
                                 {entry.label}
                               </div>
                               <pre
                                 className={cn(
                                   "whitespace-pre-wrap break-words text-sm leading-6 font-mono",
                                   entry.channel === "reasoning" && "text-amber-700",
                                   entry.channel === "content" && "text-emerald-700",
                                   entry.channel === "error" && "text-rose-600",
                                   entry.channel === "status" && "text-ink/60",
                                 )}
                               >
                                 {entry.text}
                               </pre>
                             </div>
                           ))
                         )}
                       </div>
                     </Card>
                   </div>
                   <div className="h-32" />
                </div>
              )}
              {view === "settings" && (
                <div className="flex flex-col items-center justify-center h-[60vh] text-ink/20 space-y-4 animate-in fade-in duration-700">
                  <Settings className="w-16 h-16 opacity-10" />
                  <p className="font-bold tracking-widest uppercase text-xs">偏好设置配置中</p>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        )}
      </main>

      {/* Floating Bottom Dock */}
      <div className="fixed bottom-10 left-1/2 -translate-x-1/2 z-50">
        <div className="flex items-center bg-canvas/60 backdrop-blur-2xl border border-line/50 p-2 rounded-[24px] shadow-[0_20px_50px_rgba(0,0,0,0.1)] gap-1">
          <DockItem 
            icon={LayoutDashboard} 
            label="概览" 
            active={view === "dashboard"} 
            onClick={() => setView("dashboard")} 
          />
          <DockItem 
            icon={Search} 
            label="搜索" 
            active={view === "search"} 
            onClick={() => setView("search")} 
          />
          <DockItem 
            icon={Database} 
            label="事实" 
            active={view === "truths"} 
            onClick={() => setView("truths")} 
          />
          <DockItem 
            icon={PlusCircle} 
            label="采集" 
            active={view === "collect"} 
            onClick={() => setView("collect")} 
          />
          <div className="w-px h-6 bg-line/50 mx-1" />
          <DockItem 
            icon={Settings} 
            label="设置" 
            active={view === "settings"} 
            onClick={() => setView("settings")} 
          />
        </div>
      </div>
    </div>
  );
};
