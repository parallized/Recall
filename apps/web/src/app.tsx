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
  Zap,
  FileText,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  MoreHorizontal
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import RepositoryView from "./repository-view";

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
type CapturePendingItemStatus =
  | "discovering_sources"
  | "waiting_to_read"
  | "reading_source"
  | "waiting_to_extract"
  | "extracting_questions"
  | "waiting_for_classify"
  | "waiting_for_finalize"
  | "planning_taxonomy"
  | "classifying_question"
  | "classified_waiting_for_embed"
  | "embedding_question"
  | "embedded_waiting_for_persist"
  | "persisting_question"
  | "blocked_after_failure"
  | "failed_read"
  | "failed_extract";

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

type CapturePendingItem = {
  id: string;
  kind: "source" | "truth";
  position: number;
  title: string;
  subtitle: string;
  status: CapturePendingItemStatus;
  sourceUrl: string | null;
  sourceTitle: string | null;
  error: string | null;
};

type CaptureActiveOperation = {
  itemId: string | null;
  kind: "source" | "truth" | "job";
  status: CapturePendingItemStatus;
  title: string;
  subtitle: string;
  detail: string;
  progressCurrent: number | null;
  progressTotal: number | null;
  startedAt: string;
};

type CaptureJobDetail = {
  job: CaptureJob;
  sources: CaptureSource[];
  events: CaptureEvent[];
  pendingItems: CapturePendingItem[];
  activeOperation: CaptureActiveOperation | null;
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

const pendingItemStatusLabel: Record<CapturePendingItemStatus, string> = {
  discovering_sources: "检索信源",
  waiting_to_read: "待读取",
  reading_source: "读取中",
  waiting_to_extract: "待抽题",
  extracting_questions: "抽题中",
  waiting_for_classify: "等待题目绑定",
  waiting_for_finalize: "等待入库前处理",
  planning_taxonomy: "规划分类",
  classifying_question: "题目绑定中",
  classified_waiting_for_embed: "已绑定，待向量化",
  embedding_question: "向量化中",
  embedded_waiting_for_persist: "已向量化，待入库",
  persisting_question: "入库中",
  blocked_after_failure: "流程中断",
  failed_read: "读取失败",
  failed_extract: "抽题失败",
};

const sourceStatusLabel: Record<CaptureSourceStatus, string> = {
  pending_read: "等待读取",
  reading: "正文读取中",
  pending_extract: "等待分析",
  extracting: "深度分析中",
  completed: "采集完成",
  failed: "采集失败",
};

const formatTokens = (tokens: number) => {
  if (tokens >= 100000000) {
    return (tokens / 100000000).toFixed(2) + "亿";
  }
  if (tokens >= 10000) {
    return (tokens / 10000).toFixed(1) + "万";
  }
  return tokens.toString();
};

type PendingStageKey =
  | "source_read"
  | "question_extract"
  | "question_bind"
  | "embedding"
  | "persist"
  | "failed";

const pendingStageLabel: Record<PendingStageKey, string> = {
  source_read: "信源读取",
  question_extract: "题目抽取",
  question_bind: "题目绑定",
  embedding: "等待向量化",
  persist: "等待入库",
  failed: "失败/阻塞",
};

const pendingStageByStatus: Record<CapturePendingItemStatus, PendingStageKey> = {
  discovering_sources: "source_read",
  waiting_to_read: "source_read",
  reading_source: "source_read",
  waiting_to_extract: "question_extract",
  extracting_questions: "question_extract",
  waiting_for_classify: "question_bind",
  waiting_for_finalize: "question_bind",
  planning_taxonomy: "question_bind",
  classifying_question: "question_bind",
  classified_waiting_for_embed: "embedding",
  embedding_question: "embedding",
  embedded_waiting_for_persist: "persist",
  persisting_question: "persist",
  blocked_after_failure: "failed",
  failed_read: "failed",
  failed_extract: "failed",
};

const pendingStageRank: Record<PendingStageKey, number> = {
  source_read: 0,
  question_extract: 1,
  question_bind: 2,
  embedding: 3,
  persist: 4,
  failed: 5,
};

const primaryPendingStageOrder: Array<Exclude<PendingStageKey, "failed">> = [
  "source_read",
  "question_extract",
  "question_bind",
  "embedding",
  "persist",
];

const activePendingStatuses = new Set<CapturePendingItemStatus>([
  "reading_source",
  "extracting_questions",
  "planning_taxonomy",
  "classifying_question",
  "embedding_question",
  "persisting_question",
]);

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
  <div className="flex items-baseline gap-2.5 px-1 py-1 group/stat">
    <span className="text-[10px] font-black text-steel/30 uppercase tracking-[0.25em] whitespace-nowrap">{label}</span>
    <span className="text-[15px] font-bold text-ink/80 tracking-tight">{value}</span>
  </div>
);

const PendingItem = ({ item, active }: { item: CapturePendingItem; active?: boolean }) => {
  const getStatusIcon = () => {
    if (item.error) return <AlertCircle className="w-4 h-4 text-ember" />;
    if (active) return <Loader2 className="w-4 h-4 text-accent animate-spin" />;
    if (item.status === "failed_read" || item.status === "failed_extract") 
      return <AlertCircle className="w-4 h-4 text-ember" />;
    
    // Simplistically assuming non-active/non-error are 'completed' or 'pending'
    const isCompleted = !active && !item.error; 
    if (isCompleted) return <CheckCircle2 className="w-4 h-4 text-accent" />;
    
    return <div className="w-2 h-2 rounded-full bg-steel/30" />;
  };

  return (
    <div className={cn(
      "grid grid-cols-[48px_1fr_120px_1fr] items-center gap-4 px-4 py-3 border-b border-line/40 hover:bg-silver/10 transition-colors group/row",
      active && "bg-accent/[0.03]"
    )}>
      {/* Col 1: Status Icon */}
      <div className="flex justify-center">
        {getStatusIcon()}
      </div>

      {/* Col 2: Title */}
      <div className="min-w-0">
        <div className={cn(
          "text-[13px] font-bold truncate tracking-tight transition-colors",
          active ? "text-accent" : "text-ink"
        )}>
          {item.title || "记录已就绪"}
        </div>
      </div>

      {/* Col 3: Link */}
      <div className="flex items-center justify-center">
        {item.sourceUrl ? (
          <a 
            href={item.sourceUrl} 
            target="_blank" 
            rel="noopener noreferrer"
            className="p-1.5 rounded hover:bg-accent/5 text-steel/40 hover:text-accent transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        ) : (
          <span className="text-[10px] text-steel/20">--</span>
        )}
      </div>

      {/* Col 4: Info */}
      <div className="min-w-0">
        <div className={cn(
          "text-[11px] truncate font-medium",
          item.error ? "text-ember font-bold" : "text-steel/60"
        )}>
          {item.error || item.subtitle || pendingItemStatusLabel[item.status]}
        </div>
      </div>
    </div>
  );
};

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
  const pendingItems = selectedCaptureJob?.pendingItems ?? [];
  const sources = selectedCaptureJob?.sources ?? [];
  const activeOperation = selectedCaptureJob?.activeOperation ?? null;

  // Unified items list: combine sources (all found) and pendingItems (current tasks)
  const unifiedDisplayItems = [
    ...sources.map(s => ({
      id: s.id,
      title: s.title,
      sourceUrl: s.url,
      status: s.status, // "pending_read" | "reading" | "pending_extract" | "extracting" | "completed" | "failed"
      error: s.error,
      kind: "source" as const,
      position: s.position
    })),
    ...pendingItems.filter(p => p.kind === "truth").map(p => ({
      id: p.id,
      title: p.title || "生成知识条目...",
      sourceUrl: p.sourceUrl,
      status: p.status,
      error: p.error,
      kind: "truth" as const,
      position: p.position + 1000 // Ensure truths come after sources
    }))
  ].sort((a, b) => {
    // 1. Error items first
    if (a.error && !b.error) return -1;
    if (!a.error && b.error) return 1;

    // 2. Currently active items
    const aActive = activeOperation?.itemId === a.id;
    const bActive = activeOperation?.itemId === b.id;
    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;

    // 3. Processing items
    const isAProcessing = a.status === "reading" || a.status === "extracting" || a.status.includes("ing_");
    const isBProcessing = b.status === "reading" || b.status === "extracting" || b.status.includes("ing_");
    if (isAProcessing && !isBProcessing) return -1;
    if (!isAProcessing && isBProcessing) return 1;

    return a.position - b.position;
  });
  const activeProgressLabel =
    activeOperation?.progressCurrent && activeOperation?.progressTotal
      ? `${activeOperation.progressCurrent} / ${activeOperation.progressTotal}`
      : null;

  return (
    <div className="min-h-screen bg-canvas text-ink selection:bg-accent/20 selection:text-ink font-sans antialiased">
      {/* Dynamic View Header (Minimalist) */}
      <div className="fixed top-0 left-0 right-0 h-2 px-8 flex items-center justify-end z-50">
      </div>

      {/* Main Content Area */}
      <main className={cn(
        "w-full mx-auto transition-all duration-500",
        view === "collect" ? "h-screen pt-0" : "px-8 max-w-7xl pt-4"
      )}>
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
                <RepositoryView
                  apiBaseUrl={API_BASE_URL}
                  refreshKey={selectedCaptureJob?.job.collectionId ?? null}
                />
              )}
              {view === "collect" && (
                <div className="flex bg-white h-screen overflow-hidden animate-in fade-in duration-700">
                  {/* Left: Organized Sidebar */}
                  <aside className="w-[320px] bg-[#f9f9f9] border-r border-line flex flex-col shrink-0">
                    <header className="px-8 pt-10 pb-4">
                      <h1 className="text-[22px] font-bold text-ink tracking-tight">知识采集</h1>
                      <p className="text-ink/40 text-[11px] mt-1 font-bold leading-relaxed uppercase tracking-widest">Research Station</p>
                    </header>

                    {/* New Task Input */}
                    <div className="px-7 pb-6 space-y-4 border-b border-line/40 mb-6 transition-all">
                      <div className="space-y-2.5">
                        <div className="px-1 flex items-center justify-between">
                          <label className="text-[9px] font-black text-ink/20 uppercase tracking-[0.2em]">New Capture</label>
                        </div>
                        <div className="relative group">
                          <input
                            value={collectQuery}
                            onChange={(e) => setCollectQuery(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleCollect()}
                            className="w-full h-9 bg-white border border-line/60 focus:ring-0 focus:border-accent/40 rounded-lg px-3.5 text-[12px] font-medium transition-all outline-none placeholder:text-ink/5"
                            placeholder="输入研究课题..."
                          />
                        </div>
                        <div className="flex gap-2">
                          <select
                            value={collectProvider}
                            onChange={(e) => setCollectProvider(e.target.value as "web-search-api" | "grok-search")}
                            className="flex-1 h-8 bg-white border border-line/60 rounded-lg px-3 text-[10px] font-bold outline-none cursor-pointer hover:border-accent/30 transition-all appearance-none"
                          >
                            <option value="grok-search">Grok 智搜</option>
                            <option value="web-search-api">全网研究</option>
                          </select>
                          <button
                            disabled={creatingCaptureJob || !collectQuery.trim()}
                            onClick={handleCollect}
                            className="h-8 bg-ink text-white px-4 rounded-lg transition-all active:scale-95 disabled:opacity-20 flex items-center justify-center shrink-0"
                          >
                            {creatingCaptureJob ? <Loader2 className="w-3.5 h-3.5 animate-spin"/> : <PlusCircle className="w-3.5 h-3.5"/>}
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Task List */}
                    <div className="flex-1 overflow-hidden flex flex-col">
                      <div className="px-8 pb-3 flex items-center justify-between">
                        <h3 className="text-[9px] font-black text-ink/20 uppercase tracking-[0.2em]">All Jobs</h3>
                        <div className="text-[9px] font-black text-ink/10">{captureJobs.length}</div>
                      </div>
                      
                      <div className="flex-1 overflow-y-auto custom-scrollbar px-3 pb-8">
                        <div className="space-y-1">
                          {captureJobs.length === 0 ? (
                            <div className="py-20 text-center border border-dashed border-line/50 rounded-2xl mx-4">
                              <p className="text-[10px] text-ink/20 font-bold uppercase tracking-widest">暂无采集历史</p>
                            </div>
                          ) : (
                            captureJobs.map((job) => (
                              <button
                                key={job.id}
                                onClick={() => {
                                  setSelectedCaptureJobId(job.id);
                                  void fetchCaptureJobs(job.id, true);
                                }}
                                className={cn(
                                  "w-full text-left px-4 py-2.5 rounded-lg transition-all relative group/item mb-1",
                                  selectedCaptureJobId === job.id
                                    ? "bg-white shadow-sm ring-1 ring-line/60"
                                    : "hover:bg-white/40"
                                )}
                              >
                                {selectedCaptureJobId === job.id && (
                                  <div className="absolute left-1 top-1/2 -translate-y-1/2 w-1 h-1/2 bg-accent rounded-full" />
                                )}
                                <div className="flex items-center justify-between gap-3">
                                  <div className="min-w-0">
                                    <h4 className={cn(
                                      "text-[13px] font-bold truncate leading-snug tracking-tight",
                                      selectedCaptureJobId === job.id ? "text-ink" : "text-ink/70"
                                    )}>
                                      {job.query}
                                    </h4>
                                    <div className="flex items-center gap-2 mt-1.5 font-bold uppercase text-[9px] tracking-widest">
                                      <span className={cn(
                                        job.status === "completed" ? "text-accent" : "text-ink/40"
                                      )}>
                                        {captureStatusLabel[job.status]}
                                      </span>
                                      <span className="w-1 h-1 rounded-full bg-line" />
                                      <span className="text-ink/30 tabular-nums">{job.provider.split('-')[0]}</span>
                                    </div>
                                  </div>
                                  {job.status === 'processing' && <Loader2 className="w-3.5 h-3.5 animate-spin text-accent/40" />}
                                  {job.status === 'completed' && <CheckCircle2 className="w-3.5 h-3.5 text-accent/20" />}
                                </div>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  </aside>

                  {/* Right: Focused Content */}
                  <main className="flex-1 bg-white overflow-y-auto relative custom-scrollbar">
                    {selectedCaptureJob ? (
                      <div className="max-w-5xl mx-auto px-12 pt-16 pb-32 animate-in fade-in slide-in-from-right-4 duration-700">
                        {/* Header Section */}
                        <header className="flex items-end justify-between gap-8 pb-8 border-b border-line/60 mb-8">
                          <div className="space-y-3">
                            <h2 className="text-[32px] font-bold text-ink leading-tight tracking-tight">
                              {selectedCaptureJob.job.query}
                            </h2>
                            <div className="flex items-center gap-8">
                              <div className="flex items-baseline gap-2">
                                <span className="text-[9px] font-black text-ink/15 uppercase tracking-[0.2em]">发现信源 / Sources</span>
                                <span className="text-base font-bold text-ink">{selectedCaptureJob.job.discoveredSourceCount}</span>
                              </div>
                              <div className="flex items-baseline gap-2">
                                <span className="text-[9px] font-black text-ink/15 uppercase tracking-[0.2em]">消耗 / Tokens</span>
                                <span className="text-base font-bold text-ink">{formatTokens(selectedCaptureJob.job.usage.totalTokens)}</span>
                              </div>
                            </div>
                          </div>

                          <div className="flex flex-col items-end gap-2.5 shrink-0 pb-1">
                             <button
                                disabled={!canStartReading || startingCaptureProcessing}
                                onClick={handleStartReading}
                                className="h-9 bg-ink text-white px-5 rounded-lg text-[11px] font-bold flex items-center gap-2 shadow hover:-translate-y-0.5 active:scale-95 transition-all disabled:opacity-10"
                              >
                                {startingCaptureProcessing ? <Loader2 className="w-3.5 h-3.5 animate-spin"/> : <Zap className="w-3.5 h-3.5 fill-white stroke-none"/>}
                                <span>启动智搜知识流</span>
                              </button>

                              {activeOperation && (
                                <div className="flex items-center gap-2 text-right animate-in fade-in slide-in-from-top-1 duration-500">
                                  <Loader2 className="w-3 h-3 animate-spin text-accent" />
                                  <div className="text-[11px] font-bold text-ink/40 tracking-tight">
                                    {activeOperation.detail}
                                  </div>
                                </div>
                              )}
                          </div>
                        </header>

                        {/* Notion-Style Table */}
                        <section>
                          <div className="flex items-center justify-between px-4 mb-4">
                            <h3 className="text-[11px] font-black text-ink/60 uppercase tracking-[0.2em]">采集与研究任务流</h3>
                            <div className="text-[10px] font-bold text-ink/30 uppercase tracking-widest">{unifiedDisplayItems.length} ITEMS</div>
                          </div>

                          <div className="overflow-hidden">
                            {/* Table Header */}
                            <div className="grid grid-cols-[60px_2fr_100px_1fr] items-center gap-4 px-6 h-[32px] bg-transparent border-b border-line/30 text-[9px] font-black text-ink/20 uppercase tracking-widest">
                              <div className="text-center">执行状态</div>
                              <div>项目名称 内容</div>
                              <div className="text-center">跳转</div>
                              <div>反馈详情</div>
                            </div>

                            {/* Table Rows */}
                            <div className="bg-white min-h-[400px]">
                              {unifiedDisplayItems.length === 0 ? (
                                <div className="h-[400px] flex flex-col items-center justify-center space-y-4">
                                   <div className="w-12 h-12 rounded-full bg-[#f9f9f9] border border-line flex items-center justify-center">
                                      <ShieldCheck className="w-6 h-6 text-ink/10" />
                                   </div>
                                   <p className="text-[11px] text-ink/20 font-bold uppercase tracking-[1em] ml-4">队列清空</p>
                                </div>
                              ) : (
                                unifiedDisplayItems.map((item) => (
                                  <div 
                                    key={item.id}
                                    className={cn(
                                      "grid grid-cols-[60px_2fr_100px_1fr] items-center gap-4 px-6 min-h-[36px] border-b border-line/10 last:border-0 hover:bg-[#f9f9f9] transition-colors group",
                                      activeOperation?.itemId === item.id && "bg-accent/[0.02]"
                                    )}
                                  >
                                    {/* Icon Col */}
                                    <div className="flex justify-center">
                                      {item.error ? (
                                        <AlertCircle className="w-4 h-4 text-ember" />
                                      ) : activeOperation?.itemId === item.id || item.status === "reading" || item.status === "extracting" ? (
                                        <Loader2 className="w-4 h-4 text-accent animate-spin" />
                                      ) : item.status === "completed" ? (
                                        <CheckCircle2 className="w-4 h-4 text-accent/60" />
                                      ) : (
                                        <div className="w-1.5 h-1.5 rounded-full bg-line group-hover:scale-125 transition-transform" />
                                      )}
                                    </div>

                                    {/* Title Col */}
                                    <div className="min-w-0">
                                      <div className={cn(
                                        "text-[13.5px] font-bold truncate tracking-tight transition-colors",
                                        activeOperation?.itemId === item.id ? "text-accent" : "text-ink"
                                      )}>
                                        {item.title || "正在研读文档内容..."}
                                      </div>
                                    </div>

                                    {/* Link Col */}
                                    <div className="flex justify-center">
                                      {item.sourceUrl ? (
                                        <a 
                                          href={item.sourceUrl} 
                                          target="_blank" 
                                          rel="noopener noreferrer"
                                          className="p-1.5 rounded-lg border border-transparent hover:border-line hover:bg-white text-ink/30 hover:text-ink transition-all transform active:scale-90"
                                        >
                                          <ExternalLink className="w-3.5 h-3.5" />
                                        </a>
                                      ) : (
                                        <span className="text-ink/10 font-mono text-[9px]">--</span>
                                      )}
                                    </div>

                                    {/* Info Col */}
                                    <div className="min-w-0">
                                      <div className={cn(
                                        "text-[11px] font-bold tracking-tight truncate whitespace-nowrap",
                                        item.error ? "text-ember" : "text-ink/40"
                                      )}>
                                        {item.error || (item.kind === "source" ? sourceStatusLabel[item.status as CaptureSourceStatus] : pendingItemStatusLabel[item.status as CapturePendingItemStatus])}
                                      </div>
                                    </div>
                                  </div>
                                ))
                              )}
                            </div>
                          </div>
                        </section>
                      </div>
                    ) : (
                      <div className="h-full flex flex-col items-center justify-center p-20 text-center">
                        <div className="w-24 h-24 rounded-[40px] bg-[#f9f9f9] border border-line flex items-center justify-center mb-8">
                           <Zap className="w-8 h-8 text-ink/10" />
                        </div>
                        <h3 className="text-xl font-bold text-ink">尚未选择采集项</h3>
                        <p className="text-ink/40 text-sm mt-3 max-w-sm leading-relaxed">请从左侧列表选择一个研究课题，或者发起一个新的采集任务来开始知识流。</p>
                      </div>
                    )}
                  </main>
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
