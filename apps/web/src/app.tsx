import React, { useState, useEffect } from "react";
import { 
  LayoutDashboard, 
  Search, 
  Database, 
  PlusCircle, 
  Settings, 
  RefreshCw,
  BrainCircuit,
  Loader2,
  Calendar,
  Layers,
  History,
  Zap
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

type CaptureJobStatus = "queued_search" | "searching" | "ready_to_read" | "processing" | "completed" | "failed";
type CaptureJobPhase = "idle" | "search" | "read" | "truths" | "taxonomy" | "classify" | "embed" | "persist";
type CaptureSourceStatus = "pending_read" | "reading" | "pending_extract" | "extracting" | "completed" | "failed";

type CaptureJob = {
  id: string;
  query: string;
  provider: "web-search-api" | "grok-search";
  status: CaptureJobStatus;
  phase: CaptureJobPhase;
  searchLimit: number;
  readConcurrency: number;
  aiConcurrency: number;
  discoveredSourceCount: number;
  pendingReadCount: number;
  readingCount: number;
  pendingExtractCount: number;
  extractingCount: number;
  completedSourceCount: number;
  failedSourceCount: number;
  truthDraftCount: number;
  truthCount: number;
  taxonomyCount: number;
  usage: TokenUsage;
  collectionId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

type CaptureSource = {
  id: string;
  jobId: string;
  position: number;
  url: string;
  title: string;
  snippet: string;
  status: CaptureSourceStatus;
  contentCached: boolean;
  truthDraftCount: number;
  fetchedAt: string | null;
  extractedAt: string | null;
  error: string | null;
};

type CaptureEvent = {
  id: number;
  jobId: string;
  createdAt: string;
  channel: "status" | "error";
  label: string;
  text: string;
};

type CaptureJobDetail = {
  job: CaptureJob;
  sources: CaptureSource[];
  events: CaptureEvent[];
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

const captureStatusLabel: Record<CaptureJobStatus, string> = {
  queued_search: "等待检索",
  searching: "检索中",
  ready_to_read: "待读取",
  processing: "处理中",
  completed: "已完成",
  failed: "失败",
};

const capturePhaseLabel: Record<CaptureJobPhase, string> = {
  idle: "等待中",
  search: "信源检索",
  read: "正文读取",
  truths: "题目抽取",
  taxonomy: "分类规划",
  classify: "题目绑定",
  embed: "向量化",
  persist: "持久化",
};

const captureSourceStatusLabel: Record<CaptureSourceStatus, string> = {
  pending_read: "待读取",
  reading: "读取中",
  pending_extract: "待抽取",
  extracting: "抽取中",
  completed: "已完成",
  failed: "失败",
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
      "relative flex items-center px-4 py-2 text-sm font-medium transition-all duration-500 rounded-[16px] group active:scale-95",
      active 
        ? "bg-ink text-canvas shadow-xl shadow-ink/10" 
        : "text-steel hover:bg-silver hover:text-ink"
    )}
  >
    <Icon className={cn("w-4 h-4 transition-transform group-hover:scale-110", active ? "mr-2.5" : "")} />
    {active && (
      <motion.span 
        initial={{ opacity: 0, width: 0 }}
        animate={{ opacity: 1, width: "auto" }}
        transition={{ duration: 0.4, ease: "circOut" }}
        className="overflow-hidden whitespace-nowrap"
      >
        {label}
      </motion.span>
    )}
    {!active && (
      <div className="absolute -top-12 left-1/2 -translate-x-1/2 bg-ink text-canvas text-[10px] px-3 py-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-all transform translate-y-2 group-hover:translate-y-0 pointer-events-none whitespace-nowrap font-bold tracking-widest shadow-lg">
        {label}
      </div>
    )}
  </button>
);

const Card = ({ children, className, title, extra, compact }: { children: React.ReactNode, className?: string, title?: string, extra?: React.ReactNode, compact?: boolean }) => (
  <div className={cn("bg-canvas border border-line rounded-[24px] transition-all hover:border-line/80 flex flex-col group/card notion-shadow", compact ? "p-4" : "p-6", className)}>
    {(title || extra) && (
      <div className={cn("flex items-center justify-between", compact ? "mb-3" : "mb-5")}>
        {title && <h3 className="text-[10px] font-black text-steel uppercase tracking-[0.2em]">{title}</h3>}
        {extra}
      </div>
    )}
    {children}
  </div>
);

const StatCard = ({ label, value, sub, color = "accent", compact }: { label: string, value: string | number, sub?: string, color?: string, compact?: boolean }) => (
  <Card compact={compact} className={cn("hover:bg-fog/50 transition-colors", compact ? "py-4 px-4" : "py-7 px-5")}>
    <div className={cn("font-black text-steel uppercase tracking-[0.2em]", compact ? "text-[9px] mb-1.5" : "text-[10px] mb-3")}>{label}</div>
    <div className={cn("font-bold text-ink tracking-tight", compact ? "text-xl" : "text-3xl")}>{value || "-"}</div>
    {sub && <div className={cn("text-steel font-medium", compact ? "text-[9px] mt-1" : "text-[10px] mt-2")}>{sub}</div>}
  </Card>
);

const StatItem = ({ label, value }: { label: string, value: string | number }) => (
  <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-silver/10 border border-line/5 transition-all">
    <span className="text-[8px] font-black text-steel/40 uppercase tracking-[0.2em]">{label}</span>
    <span className="text-[12px] font-bold text-ink/80">{value}</span>
  </div>
);

const SourceItem = ({ source }: { source: CaptureSource }) => (
  <div className="group/source flex items-center justify-between gap-4 px-4 py-2.5 rounded-[12px] hover:bg-silver/15 transition-all cursor-default border-b border-[#efeff1]/50 last:border-0 ml-0.5">
    <div className="min-w-0 flex-1 space-y-0.5">
      <div className="text-[13px] font-medium text-ink/90 truncate group-hover/source:text-accent transition-colors leading-tight font-sans">{source.title || "Untitled Intelligence"}</div>
      <div className="text-[9px] text-steel/30 truncate tracking-tight">{source.url}</div>
    </div>
    <div className="flex items-center gap-3">
       <span className={cn(
        "text-[8px] font-black uppercase tracking-[0.2em] whitespace-nowrap px-2 py-0.5 rounded-full border border-line/10",
        source.status === 'completed' ? "bg-accent/5 text-accent border-accent/20" : "bg-silver/20 text-steel/40"
      )}>
        {captureSourceStatusLabel[source.status]}
      </span>
    </div>
  </div>
);

// --- Main Views ---

const DashboardView = ({ progress }: { progress: TagProgress[] }) => {
  const totalTruths = progress.reduce((acc, p) => acc + p.truthCount, 0);
  const today = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-6 duration-1000 ease-out max-w-5xl mx-auto py-4">
      <header className="mb-6">
        <h1 className="text-3xl font-bold text-ink tracking-tight mb-3">概览</h1>
        <div className="flex flex-wrap items-center gap-5 text-steel text-[12px] font-medium opacity-60">
           <div className="flex items-center">
            <Calendar className="w-3.5 h-3.5 mr-2 opacity-40" />
            {today}
          </div>
          <div className="flex items-center">
            <Layers className="w-3.5 h-3.5 mr-2 opacity-40" />
            {progress.length} 个知识点
          </div>
          <div className="flex items-center">
            <History className="w-3.5 h-3.5 mr-2 opacity-40" />
            {totalTruths} 条记录
          </div>
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard compact label="学习进展" value="-" />
        <StatCard compact label="知识密度" value="-" />
        <StatCard compact label="检索权重" value="-" />
        <StatCard compact label="语义关联" value="-" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 border-t border-[#efeff1] pt-10">
        <div className="space-y-6">
          <div className="flex items-center gap-3 px-2">
             <div className="h-px bg-[#efeff1] flex-1" />
             <h3 className="text-[10px] font-black text-steel/40 uppercase tracking-[0.3em]">掌握度分布</h3>
             <div className="h-px bg-[#efeff1] flex-1" />
          </div>
          <div className="h-[280px] bg-[#f8f9fa] rounded-[32px] border border-[#efeff1]/60 flex items-center justify-center">
             <div className="text-steel/10 text-[10px] font-black tracking-[0.6em] uppercase">SYSTEM_IDLE</div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="flex items-center gap-3 px-2">
             <div className="h-px bg-[#efeff1] flex-1" />
             <h3 className="text-[10px] font-black text-steel/40 uppercase tracking-[0.3em]">采集活跃度</h3>
             <div className="h-px bg-[#efeff1] flex-1" />
          </div>
          <div className="h-[280px] bg-[#f8f9fa] rounded-[32px] border border-[#efeff1]/60 flex items-center justify-center">
             <div className="text-steel/10 text-[10px] font-black tracking-[0.6em] uppercase">SYSTEM_IDLE</div>
          </div>
        </div>
      </div>
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
    <div className="max-w-3xl mx-auto py-8 animate-in fade-in slide-in-from-bottom-8 duration-1000 ease-out">
      <div className="relative group/search">
        <div className="absolute inset-y-0 left-6 flex items-center pointer-events-none text-steel/30 group-focus-within/search:text-accent transition-colors duration-500">
          <Search className="w-6 h-6" />
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder="搜索知识语义链..."
          className="w-full bg-silver/30 border border-line focus:ring-[12px] focus:ring-accent/5 focus:border-accent/30 rounded-[28px] pl-16 pr-8 py-6 text-ink placeholder:text-steel/20 transition-all duration-500 outline-none text-xl font-medium"
        />
        {loading && (
          <div className="absolute inset-y-0 right-6 flex items-center">
            <Loader2 className="w-6 h-6 text-accent animate-spin" />
          </div>
        )}
      </div>

      <div className="mt-10 space-y-4">
        {results.map((result, i) => (
          <motion.div
            initial={{ opacity: 0, scale: 0.98, y: 30 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ delay: i * 0.08, duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
            key={i}
          >
            <div className="bg-canvas border border-line rounded-[24px] p-7 group hover:border-accent/20 hover:bg-fog transition-all duration-700 cursor-pointer notion-shadow overflow-hidden relative">
              <div className="absolute top-0 left-0 w-1.5 h-full bg-accent opacity-0 group-hover:opacity-10 transition-all" />
              <div className="text-lg text-ink/80 leading-relaxed font-semibold">
                {result.statement || "未发现结果"}
              </div>
              <div className="mt-5 flex flex-wrap gap-2.5">
                {result.tags?.map((t: string) => (
                  <span key={t} className="text-[10px] uppercase tracking-widest font-black text-steel bg-silver px-3 py-1.5 rounded-full border border-line/50 transition-colors group-hover:bg-accent/5 group-hover:text-accent group-hover:border-accent/10">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          </motion.div>
        ))}
      </div>
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
  const [collectSearchLimit, setCollectSearchLimit] = useState(100);
  const [collectReadConcurrency, setCollectReadConcurrency] = useState(3);
  const [captureJobs, setCaptureJobs] = useState<CaptureJob[]>([]);
  const [selectedCaptureJobId, setSelectedCaptureJobId] = useState<string | null>(null);
  const [selectedCaptureJob, setSelectedCaptureJob] = useState<CaptureJobDetail | null>(null);
  const [creatingCaptureJob, setCreatingCaptureJob] = useState(false);
  const [startingCaptureProcessing, setStartingCaptureProcessing] = useState(false);
  const [refreshingCaptureJobs, setRefreshingCaptureJobs] = useState(false);
  const [collectError, setCollectError] = useState<string | null>(null);

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

  const fetchCaptureJobs = async (preferredJobId?: string, silent = false) => {
    if (!silent) {
      setRefreshingCaptureJobs(true);
    }

    try {
      const response = await fetch(`${API_BASE_URL}/capture/jobs`);

      if (!response.ok) {
        throw new Error(await readErrorResponse(response));
      }

      const jobs = (await response.json()) as CaptureJob[];
      setCaptureJobs(jobs);

      const nextJobId =
        preferredJobId ??
        (selectedCaptureJobId && jobs.some((job) => job.id === selectedCaptureJobId) ? selectedCaptureJobId : jobs[0]?.id ?? null);

      setSelectedCaptureJobId(nextJobId);

      if (!nextJobId) {
        setSelectedCaptureJob(null);
        return;
      }

      const detailResponse = await fetch(`${API_BASE_URL}/capture/jobs/${nextJobId}`);

      if (!detailResponse.ok) {
        throw new Error(await readErrorResponse(detailResponse));
      }

      setSelectedCaptureJob((await detailResponse.json()) as CaptureJobDetail);
    } catch (e) {
      console.error(e);
      setCollectError(e instanceof Error ? e.message : "无法刷新采集任务");
    } finally {
      if (!silent) {
        setRefreshingCaptureJobs(false);
      }
    }
  };

  const handleCollect = async () => {
    if (!collectQuery.trim() || creatingCaptureJob) return;

    setCreatingCaptureJob(true);
    setCollectError(null);

    try {
      const response = await fetch(`${API_BASE_URL}/capture/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: collectQuery.trim(),
          provider: collectProvider,
          searchLimit: collectSearchLimit,
          readConcurrency: collectReadConcurrency,
        }),
      });

      if (!response.ok) {
        throw new Error(await readErrorResponse(response));
      }

      const detail = (await response.json()) as CaptureJobDetail;
      setCollectQuery("");
      setSelectedCaptureJobId(detail.job.id);
      setSelectedCaptureJob(detail);
      await fetchCaptureJobs(detail.job.id, true);
    } catch (e) {
      console.error(e);
      setCollectError(e instanceof Error ? e.message : "无法创建采集任务");
    } finally {
      setCreatingCaptureJob(false);
    }
  };

  const handleStartReading = async () => {
    if (!selectedCaptureJobId || startingCaptureProcessing) return;

    setStartingCaptureProcessing(true);
    setCollectError(null);

    try {
      const response = await fetch(`${API_BASE_URL}/capture/jobs/${selectedCaptureJobId}/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          readConcurrency: collectReadConcurrency,
        }),
      });

      if (!response.ok) {
        throw new Error(await readErrorResponse(response));
      }

      const detail = (await response.json()) as CaptureJobDetail;
      setSelectedCaptureJob(detail);
      await fetchCaptureJobs(detail.job.id, true);
    } catch (e) {
      console.error(e);
      setCollectError(e instanceof Error ? e.message : "无法启动读取任务");
    } finally {
      setStartingCaptureProcessing(false);
    }
  };

  useEffect(() => {
    fetchProgress();
  }, []);

  useEffect(() => {
    if (view !== "collect") {
      return;
    }

    void fetchCaptureJobs(undefined, true);
    const timer = window.setInterval(() => {
      void fetchCaptureJobs(undefined, true);
    }, 4000);

    return () => window.clearInterval(timer);
  }, [view, selectedCaptureJobId]);

  useEffect(() => {
    if (selectedCaptureJob?.job.collectionId) {
      void fetchProgress();
    }
  }, [selectedCaptureJob?.job.collectionId]);

  const selectedJob = selectedCaptureJob?.job ?? null;
  const canStartReading = Boolean(
    selectedJob &&
      selectedJob.discoveredSourceCount > 0 &&
      (selectedJob.status === "ready_to_read" || selectedJob.status === "failed"),
  );

  return (
    <div className="min-h-screen bg-canvas text-ink selection:bg-accent/20 selection:text-ink font-sans antialiased">
      {/* Dynamic View Header (Minimalist) */}
      <div className="fixed top-0 left-0 right-0 h-2 px-8 flex items-center justify-end z-50">
      </div>

      {/* Main Content Area */}
      <main className="pt-4 px-8 w-full max-w-7xl mx-auto">
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
                <div className="min-h-screen bg-white animate-in fade-in duration-700">
                  <div className="grid lg:grid-cols-[320px_minmax(0,1fr)] min-h-screen">
                    {/* Left: Heptabase Sidebar Style */}
                    <div className="bg-[#f8f9fa] border-r border-[#efeff1] px-8 pt-8 pb-32 space-y-10 overflow-hidden">
                      <header>
                        <h1 className="text-2xl font-bold text-ink tracking-tighter mb-1">知识采集</h1>
                        <p className="text-steel/50 text-[11px] font-medium leading-tight">异步检索、读取与抽取全网事实</p>
                      </header>

                      {collectError && (
                        <div className="text-[11px] font-bold text-ember bg-ember/5 border border-ember/20 rounded-[14px] px-4 py-3 animate-in fade-in zoom-in">
                          {collectError}
                        </div>
                      )}

                      <div className="space-y-6">
                        <div className="space-y-4">
                          <h3 className="text-[10px] font-black text-steel/30 uppercase tracking-[0.2em] px-1">NEW_COLLECTION</h3>
                          <div className="space-y-3">
                             <input
                              value={collectQuery}
                              onChange={(e) => setCollectQuery(e.target.value)}
                              onKeyDown={(e) => e.key === "Enter" && handleCollect()}
                              className="w-full bg-white border border-[#efeff1] focus:ring-4 focus:ring-accent/5 focus:border-accent/40 rounded-[14px] px-4 py-3 text-[13px] font-medium transition-all outline-none placeholder:text-steel/20 shadow-sm"
                              placeholder="Search anything..."
                            />
                            <div className="flex gap-2">
                               <select
                                  value={collectProvider}
                                  onChange={(e) => setCollectProvider(e.target.value as "web-search-api" | "grok-search")}
                                  className="flex-1 bg-white border border-[#efeff1] rounded-[12px] px-3 py-2 text-[10px] font-bold outline-none cursor-pointer hover:border-accent/20 transition-colors shadow-sm"
                                >
                                  <option value="grok-search">Grok Enterprise</option>
                                  <option value="web-search-api">Web Research</option>
                                </select>
                                <button
                                  disabled={creatingCaptureJob || !collectQuery.trim()}
                                  onClick={handleCollect}
                                  className="bg-ink text-white px-5 py-2 rounded-[12px] text-[10px] font-black hover:opacity-90 active:scale-95 transition-all disabled:opacity-20 flex items-center justify-center shadow-lg shadow-black/5"
                                >
                                  {creatingCaptureJob ? <Loader2 className="w-3 h-3 animate-spin"/> : <Search className="w-3.5 h-3.5"/>}
                                </button>
                            </div>
                          </div>
                        </div>

                        <div className="space-y-4 pt-2 border-t border-[#efeff1]">
                          <h3 className="text-[10px] font-black text-steel/30 uppercase tracking-[0.2em] px-1">ACTIVE_TOPICS</h3>
                          <div className="relative overflow-hidden group/list">
                            <div className="space-y-0.5 max-h-[460px] pb-10">
                              {captureJobs.filter(j => j.status !== 'completed').length === 0 ? (
                                <div className="py-20 text-center text-[10px] text-steel/10 font-bold uppercase tracking-[0.5em] border-2 border-dashed border-[#efeff1] rounded-[24px]">
                                   EMPTY_POOL
                                </div>
                              ) : (
                                captureJobs.filter(j => j.status !== 'completed').slice(0, 10).map((job) => (
                                  <button
                                    key={job.id}
                                    onClick={() => {
                                      setSelectedCaptureJobId(job.id);
                                      void fetchCaptureJobs(job.id, true);
                                    }}
                                    className={cn(
                                      "w-full text-left px-4 py-3.5 transition-all relative overflow-hidden group/item rounded-[12px]",
                                      selectedCaptureJobId === job.id
                                        ? "bg-white shadow-[0_4px_20px_rgba(0,0,0,0.04)] scale-[1.02]"
                                        : "hover:bg-white/50",
                                    )}
                                  >
                                    {selectedCaptureJobId === job.id && (
                                      <div className="absolute top-0 left-0 w-0.5 h-full bg-accent" />
                                    )}
                                    <div className="flex items-center justify-between gap-3">
                                      <div className="min-w-0">
                                        <div className={cn("text-[13px] font-bold transition-colors truncate", selectedCaptureJobId === job.id ? "text-ink" : "text-ink/60")}>{job.query}</div>
                                        <div className="flex items-center gap-2 mt-1">
                                          <span className="text-[8px] font-black uppercase tracking-wider text-accent">{captureStatusLabel[job.status]}</span>
                                          <span className="text-[8px] text-steel/40 leading-none">/ {job.provider.split('-')[0].toUpperCase()}</span>
                                        </div>
                                      </div>
                                      {job.status === 'processing' && <Loader2 className="w-3 h-3 animate-spin text-accent/20" />}
                                    </div>
                                  </button>
                                ))
                              )}
                            </div>
                            {captureJobs.filter(j => j.status !== 'completed').length > 10 && (
                              <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-[#f8f9fa] to-transparent pointer-events-none z-10" />
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Right: Heptabase Main Workspace Style */}
                    <div className="bg-white px-12 pt-8 pb-32 overflow-hidden">
                      {selectedCaptureJob ? (
                        <div className="animate-in fade-in duration-500 space-y-10 max-w-5xl">
                          {/* Workspace Header */}
                          <div className="flex flex-wrap items-end justify-between gap-8 pb-8 border-b border-[#efeff1]/60">
                            <div className="space-y-4">
                               <div className="flex items-center gap-2 text-steel/40 text-[10px] font-black tracking-widest uppercase mb-2">
                                  <span>Action_Context</span>
                                  <span>/</span>
                                  <span className="text-accent">{selectedCaptureJob.job.provider.toUpperCase()}</span>
                               </div>
                               <h2 className="text-[32px] font-bold text-ink tracking-tighter leading-none">{selectedCaptureJob.job.query}</h2>
                               <div className="flex flex-wrap items-center gap-3 pt-2">
                                 <StatItem label="Found" value={selectedCaptureJob.job.discoveredSourceCount} />
                                 <StatItem label="Tokens" value={`${Math.round(selectedCaptureJob.job.usage.totalTokens / 1000)}k`} />
                                 <div className="inline-flex items-center px-2 py-1 rounded bg-accent/5 border border-accent/10">
                                    <span className="text-[8px] font-black text-accent uppercase tracking-[0.2em]">{captureStatusLabel[selectedCaptureJob.job.status]}</span>
                                 </div>
                               </div>
                            </div>
                            
                            <div className="flex items-center gap-3">
                               <button
                                  disabled={!canStartReading || startingCaptureProcessing}
                                  onClick={handleStartReading}
                                  className="bg-accent text-white px-8 py-3 rounded-full text-[12px] font-bold hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-20 flex items-center gap-3 shadow-[0_10px_30px_rgba(var(--accent-rgb),0.2)]"
                                >
                                  {startingCaptureProcessing ? <Loader2 className="w-4 h-4 animate-spin"/> : <Zap className="w-4 h-4 fill-white"/>}
                                  <span>Start Question Flow</span>
                                </button>
                            </div>
                          </div>

                          <div className="space-y-8">
                             <div className="flex items-center justify-between px-2">
                                <h3 className="text-[10px] font-black text-steel/20 uppercase tracking-[0.5em]">Active_Action_Queue</h3>
                                <div className="flex items-center gap-3">
                                   <span className="text-[10px] font-bold text-ink/30 italic">{selectedCaptureJob.sources.filter(s => s.status !== 'completed').length} pending</span>
                                </div>
                             </div>

                             <div className="relative overflow-hidden border border-[#efeff1]/50 rounded-[24px] bg-[#fcfcfc]/50 p-2">
                               <div className="space-y-px pb-20">
                                 {selectedCaptureJob.sources.filter(s => s.status !== 'completed').length === 0 ? (
                                    <div className="py-32 text-center text-[10px] text-steel/10 font-bold uppercase tracking-[1em]">SYSTEM_STABLE</div>
                                 ) : (
                                   selectedCaptureJob.sources
                                      .filter(s => s.status !== 'completed')
                                      .sort((a, b) => {
                                        const aActive = a.status === 'reading' || a.status === 'extracting';
                                        const bActive = b.status === 'reading' || b.status === 'extracting';
                                        if (aActive && !bActive) return -1;
                                        if (!aActive && bActive) return 1;
                                        return 0;
                                      })
                                      .slice(0, 10)
                                      .map((source) => (
                                      <SourceItem key={source.id} source={source} />
                                    ))
                                 )}
                               </div>
                               {selectedCaptureJob.sources.filter(s => s.status !== 'completed').length > 10 && (
                                  <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-white to-transparent pointer-events-none z-10 flex items-end justify-center pb-8">
                                     <span className="text-[9px] font-black text-steel/20 tracking-[1em] uppercase">Deep_Processing</span>
                                  </div>
                               )}
                             </div>
                          </div>
                        </div>
                      ) : (
                        <div className="h-[70vh] flex flex-col items-center justify-center space-y-10 group">
                           <div className="w-24 h-24 rounded-[40px] bg-[#f8f9fa] border border-[#efeff1] flex items-center justify-center group-hover:scale-110 transition-transform duration-700">
                             <Search className="w-8 h-8 text-steel/10" />
                           </div>
                           <div className="text-center space-y-3">
                             <h3 className="text-xl font-bold text-ink tracking-tight">Select active intelligence</h3>
                             <p className="text-steel/40 text-[12px] max-w-[240px] mx-auto leading-relaxed">Choose a topic from the sidebar to begin question-bank capture, source reading, and study-card generation.</p>
                           </div>
                        </div>
                      )}
                    </div>
                  </div>
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

      {/* Floating Bottom Dock - Premium Glassmorphism */}
      <div className="fixed bottom-10 left-1/2 -translate-x-1/2 z-50">
        <div className="flex items-center bg-white/60 backdrop-blur-3xl border border-[#efeff1] p-1.5 rounded-full shadow-[0_20px_50px_rgba(0,0,0,0.08)] gap-1">
          <DockItem 
            icon={LayoutDashboard} 
            label="Overview" 
            active={view === "dashboard"} 
            onClick={() => setView("dashboard")} 
          />
          <DockItem 
            icon={Search} 
            label="Explore" 
            active={view === "search"} 
            onClick={() => setView("search")} 
          />
          <DockItem 
            icon={Database} 
            label="Repository" 
            active={view === "truths"} 
            onClick={() => setView("truths")} 
          />
          <DockItem 
            icon={Zap} 
            label="Collect" 
            active={view === "collect"} 
            onClick={() => setView("collect")} 
          />
          <div className="w-px h-6 bg-[#efeff1] mx-2" />
          <DockItem 
            icon={Settings} 
            label="System" 
            active={view === "settings"} 
            onClick={() => setView("settings")} 
          />
        </div>
      </div>
    </div>
  );
};
