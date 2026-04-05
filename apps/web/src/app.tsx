import React, { useEffect, useMemo, useState } from "react";
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
  MoreHorizontal,
  ArrowUpRight,
  FolderTree
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import {
  getOutputLanguageLabel,
  OUTPUT_LANGUAGE_OPTIONS,
  OUTPUT_LANGUAGE_STORAGE_KEY,
  readStoredOutputLanguage,
  type OutputLanguage,
} from "./output-language";
import RepositoryView from "./repository-view";

// --- Utilities ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const API_BASE_URL = "http://localhost:4174";
const SEARCH_LIMIT_STORAGE_KEY = "recall.collect-search-limit";
const READ_CONCURRENCY_STORAGE_KEY = "recall.collect-read-concurrency";
const AI_CONCURRENCY_STORAGE_KEY = "recall.collect-ai-concurrency";
const DEFAULT_COLLECT_SEARCH_LIMIT = 100;
const DEFAULT_COLLECT_READ_CONCURRENCY = 3;
const DEFAULT_COLLECT_AI_CONCURRENCY = 3;

const clampNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const readStoredNumberSetting = (key: string, fallback: number, min: number, max: number) => {
  if (typeof window === "undefined") {
    return fallback;
  }

  const rawValue = window.localStorage.getItem(key);
  const parsed = Number(rawValue);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return clampNumber(Math.round(parsed), min, max);
};

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
  preferredOutputLanguage: string;
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
  readAttemptCount: number;
  extractAttemptCount: number;
  fetchedAt: string | null;
  extractedAt: string | null;
  error: string | null;
  failureKind?: "sensitive_content" | "jina_reader" | "generic" | null;
  failureLabel?: string | null;
  skipped?: boolean;
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
  failureKind?: "sensitive_content" | "jina_reader" | "generic" | null;
  failureLabel?: string | null;
  skipped?: boolean;
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

const buildStagePercentages = (counts: Record<PendingStageKey, number>) => {
  const order: Array<Exclude<PendingStageKey, "failed">> = [
    "source_read",
    "question_extract",
    "question_bind",
    "embedding",
    "persist",
  ];
  
  const total = order.reduce((sum, stage) => sum + counts[stage], 0);

  if (total === 0) {
    return order.map((stage) => ({
      stage,
      count: 0,
      percent: 0,
    }));
  }

  return order.map((stage) => ({
    stage,
    count: counts[stage],
    percent: Math.round((counts[stage] / total) * 100),
  }));
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
      "relative flex items-center px-5 py-2.5 text-sm font-bold transition-all duration-500 rounded-full group active:scale-95",
      active 
        ? "bg-black text-white" 
        : "text-ink/30 hover:bg-black/[0.03] hover:text-ink"
    )}
  >
    <Icon className={cn("w-4 h-4 transition-transform group-hover:scale-110", active ? "mr-3" : "")} />
    {active && (
      <motion.span 
        initial={{ opacity: 0, width: 0 }}
        animate={{ opacity: 1, width: "auto" }}
        transition={{ duration: 0.4, ease: "circOut" }}
        className="overflow-hidden whitespace-nowrap uppercase tracking-widest text-[11px]"
      >
        {label}
      </motion.span>
    )}
  </button>
);

const Card = ({ children, className, title, extra, compact }: { children: React.ReactNode, className?: string, title?: string, extra?: React.ReactNode, compact?: boolean }) => (
  <div className={cn("bg-white border border-black/[0.05] rounded-none transition-all flex flex-col", compact ? "p-4" : "p-8", className)}>
    {(title || extra) && (
      <div className={cn("flex items-center justify-between", compact ? "mb-4" : "mb-8")}>
        {title && <h3 className="text-[10px] font-black text-ink/20 uppercase tracking-[0.4em]">{title}</h3>}
        {extra}
      </div>
    )}
    {children}
  </div>
);

const StatCard = ({ label, value, sub, compact }: { label: string, value: string | number, sub?: string, compact?: boolean }) => (
  <Card compact={compact} className={cn("hover:bg-black/[0.01] transition-colors")}>
    <div className={cn("font-black text-ink/20 uppercase tracking-[0.4em]", compact ? "text-[9px] mb-2" : "text-[10px] mb-4")}>{label}</div>
    <div className={cn("font-bold text-ink tracking-tighter leading-none", compact ? "text-2xl" : "text-4xl")}>{value || "-"}</div>
    {sub && <div className={cn("text-ink/30 font-bold uppercase tracking-widest", compact ? "text-[8px] mt-2" : "text-[10px] mt-4")}>{sub}</div>}
  </Card>
);

const StatItem = ({ label, value }: { label: string, value: string | number }) => (
  <div className="flex flex-col gap-1 px-1">
    <span className="text-[9px] font-black text-ink/20 uppercase tracking-[0.3em]">{label}</span>
    <span className="text-xl font-bold text-ink tracking-tighter">{value}</span>
  </div>
);

// --- Main Views ---

const DashboardView = ({ progress }: { progress: TagProgress[] }) => {
  const totalTruths = progress.reduce((acc, p) => acc + p.truthCount, 0);
  const today = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });

  return (
    <div className="space-y-10 animate-in fade-in duration-1000 ease-out py-10">
      <header className="flex items-end justify-between border-b border-black/[0.05] pb-10">
        <div className="space-y-4">
           <div className="text-[10px] font-black text-ink/20 uppercase tracking-[0.5em]">SYSTEM OVERVIEW</div>
           <h1 className="text-[42px] font-bold text-ink leading-none tracking-tighter uppercase">仪表盘概览</h1>
           <div className="flex items-center gap-8 text-ink/30 text-[11px] font-bold uppercase tracking-widest">
              <div className="flex items-center gap-3"><Calendar className="w-4 h-4 opacity-30" />{today}</div>
              <div className="flex items-center gap-3"><Layers className="w-4 h-4 opacity-30" />{progress.length} 知识节点</div>
              <div className="flex items-center gap-3"><History className="w-4 h-4 opacity-30" />{totalTruths} 事实记录</div>
           </div>
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
        <StatCard compact label="学习程度" value="-" />
        <StatCard compact label="知识密度" value="-" />
        <StatCard compact label="检索权重" value="-" />
        <StatCard compact label="语义关联" value="-" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-10 border-t border-black/[0.05] pt-12">
        <div className="space-y-8">
           <div className="flex items-center gap-4 text-ink/20">
              <h3 className="text-[10px] font-black uppercase tracking-[0.4em]">掌握度分布</h3>
              <div className="h-px bg-black/[0.05] flex-1" />
           </div>
           <div className="h-[320px] bg-black/[0.01] border border-black/[0.04] flex items-center justify-center">
              <div className="text-ink/5 text-[10px] font-black tracking-[0.6em] uppercase">SYSTEM_IDLE</div>
           </div>
        </div>

        <div className="space-y-8">
           <div className="flex items-center gap-4 text-ink/20">
              <h3 className="text-[10px] font-black uppercase tracking-[0.4em]">采集活跃度</h3>
              <div className="h-px bg-black/[0.05] flex-1" />
           </div>
           <div className="h-[320px] bg-black/[0.01] border border-black/[0.04] flex items-center justify-center">
              <div className="text-ink/5 text-[10px] font-black tracking-[0.6em] uppercase">SYSTEM_IDLE</div>
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
    <div className="py-12 animate-in fade-in duration-1000 ease-out max-w-4xl mx-auto">
      <div className="relative group">
        <div className="absolute inset-y-0 left-8 flex items-center pointer-events-none text-ink/10 group-focus-within:text-ink/60 transition-colors duration-500">
          <Search className="w-6 h-6" />
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder="检索知识语义链条..."
          className="w-full bg-black/[0.01] border border-black/[0.05] focus:border-black rounded-none pl-20 pr-8 py-8 text-ink placeholder:text-ink/10 transition-all duration-500 outline-none text-2xl font-bold tracking-tight uppercase"
        />
        {loading && (
          <div className="absolute inset-y-0 right-8 flex items-center">
            <Loader2 className="w-6 h-6 text-black/20 animate-spin" />
          </div>
        )}
      </div>

      <div className="mt-16 space-y-6">
        {results.map((result, i) => (
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05, duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
            key={i}
          >
            <div className="bg-white border-b border-black/[0.05] p-10 group hover:bg-black/[0.01] transition-all duration-500 cursor-pointer overflow-hidden relative">
              <div className="text-[17px] text-ink leading-relaxed font-bold tracking-tight">
                {result.statement}
              </div>
              <div className="mt-6 flex flex-wrap gap-3">
                {result.tags?.map((t: string) => (
                  <span key={t} className="text-[10px] uppercase tracking-[0.3em] font-black text-ink/20 border border-black/[0.05] px-4 py-1.5 transition-colors group-hover:text-ink/40 group-hover:border-black/10">
                    {t}
                  </span>
                ))}
              </div>
              <div className="absolute right-10 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-40 transition-all">
                 <ArrowUpRight className="w-6 h-6" />
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
  const [collectSearchLimit, setCollectSearchLimit] = useState(() =>
    readStoredNumberSetting(SEARCH_LIMIT_STORAGE_KEY, DEFAULT_COLLECT_SEARCH_LIMIT, 1, 100),
  );
  const [collectReadConcurrency, setCollectReadConcurrency] = useState(() =>
    readStoredNumberSetting(READ_CONCURRENCY_STORAGE_KEY, DEFAULT_COLLECT_READ_CONCURRENCY, 1, 8),
  );
  const [collectAiConcurrency, setCollectAiConcurrency] = useState(() =>
    readStoredNumberSetting(AI_CONCURRENCY_STORAGE_KEY, DEFAULT_COLLECT_AI_CONCURRENCY, 1, 8),
  );
  const [preferredOutputLanguage, setPreferredOutputLanguage] = useState<OutputLanguage>(readStoredOutputLanguage);
  const [captureJobs, setCaptureJobs] = useState<CaptureJob[]>([]);
  const [selectedCaptureJobId, setSelectedCaptureJobId] = useState<string | null>(null);
  const [selectedCaptureJob, setSelectedCaptureJob] = useState<CaptureJobDetail | null>(null);
  const [creatingCaptureJob, setCreatingCaptureJob] = useState(false);
  const [startingCaptureProcessing, setStartingCaptureProcessing] = useState(false);
  const [refreshingCaptureJobs, setRefreshingCaptureJobs] = useState(false);
  const [collectError, setCollectError] = useState<string | null>(null);

  useEffect(() => {
    window.localStorage.setItem(OUTPUT_LANGUAGE_STORAGE_KEY, preferredOutputLanguage);
  }, [preferredOutputLanguage]);

  useEffect(() => {
    window.localStorage.setItem(SEARCH_LIMIT_STORAGE_KEY, String(collectSearchLimit));
  }, [collectSearchLimit]);

  useEffect(() => {
    window.localStorage.setItem(READ_CONCURRENCY_STORAGE_KEY, String(collectReadConcurrency));
  }, [collectReadConcurrency]);

  useEffect(() => {
    window.localStorage.setItem(AI_CONCURRENCY_STORAGE_KEY, String(collectAiConcurrency));
  }, [collectAiConcurrency]);

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
          aiConcurrency: collectAiConcurrency,
          preferredOutputLanguage,
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

  const handleExpandTag = async (input: { query: string; tagPath: string }) => {
    if (creatingCaptureJob) {
      throw new Error("当前已有采集任务正在创建，请稍后再试。");
    }

    setCreatingCaptureJob(true);
    setCollectError(null);

    try {
      const response = await fetch(`${API_BASE_URL}/capture/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: input.query,
          provider: collectProvider,
          searchLimit: collectSearchLimit,
          readConcurrency: collectReadConcurrency,
          aiConcurrency: collectAiConcurrency,
          preferredOutputLanguage,
        }),
      });

      if (!response.ok) {
        throw new Error(await readErrorResponse(response));
      }

      const detail = (await response.json()) as CaptureJobDetail;
      setSelectedCaptureJobId(detail.job.id);
      setSelectedCaptureJob(detail);
      setView("collect");
      await fetchCaptureJobs(detail.job.id, true);
    } catch (e) {
      const message = e instanceof Error ? e.message : `无法为标签「${input.tagPath}」创建扩充任务`;
      setCollectError(message);
      throw new Error(message);
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
          aiConcurrency: collectAiConcurrency,
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
  const unifiedDisplayItems = useMemo(
    () =>
      [
        ...sources.map((source) => ({
          id: source.id,
          title: source.title,
          sourceUrl: source.url,
          status: source.status,
          error: source.error,
          skipped: source.skipped ?? false,
          kind: "source" as const,
          position: source.position,
        })),
        ...pendingItems
          .filter((item) => item.kind === "truth")
          .map((item) => ({
            id: item.id,
            title: item.title || "生成知识条目...",
            sourceUrl: item.sourceUrl,
            status: item.status,
            error: item.error,
            skipped: item.skipped ?? false,
            kind: "truth" as const,
            position: item.position + 1000,
          })),
      ].sort((left, right) => left.position - right.position),
    [pendingItems, sources],
  );

  const stageBreakdown = useMemo(() => {
    const counts: Record<PendingStageKey, number> = {
      source_read: 0,
      question_extract: 0,
      question_bind: 0,
      embedding: 0,
      persist: 0,
      failed: 0,
    };

    for (const item of pendingItems) {
      counts[pendingStageByStatus[item.status]] += 1;
    }

    return {
      stages: buildStagePercentages(counts),
      failedCount: counts.failed,
    };
  }, [pendingItems]);

  const updateCollectSearchLimit = (value: number) => {
    if (!Number.isFinite(value)) return;
    setCollectSearchLimit(clampNumber(Math.round(value), 1, 100));
  };

  const updateCollectReadConcurrency = (value: number) => {
    if (!Number.isFinite(value)) return;
    setCollectReadConcurrency(clampNumber(Math.round(value), 1, 8));
  };

  const updateCollectAiConcurrency = (value: number) => {
    if (!Number.isFinite(value)) return;
    setCollectAiConcurrency(clampNumber(Math.round(value), 1, 8));
  };

  return (
    <div className="min-h-screen bg-white text-ink font-sans antialiased">
      <main className="flex-1 h-screen relative overflow-hidden">
        {loading && progress.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center space-y-6">
            <div className="w-16 h-16 border border-black/[0.05] bg-black/[0.01] flex items-center justify-center animate-pulse">
               <Loader2 className="w-6 h-6 text-black/10 animate-spin" />
            </div>
            <p className="text-[10px] font-black tracking-[0.5em] text-ink/20 uppercase">建立知识引擎连接...</p>
          </div>
        ) : (
          <AnimatePresence mode="wait">
            <motion.div
              key={view}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              className="h-full"
            >
              {view === "dashboard" && (
                <div className="h-full overflow-y-auto custom-scrollbar px-16">
                  <DashboardView progress={progress} />
                </div>
              )}
              {view === "search" && (
                <div className="h-full overflow-y-auto custom-scrollbar px-16">
                  <SearchView />
                </div>
              )}
              {view === "truths" && (
                <div className="h-full">
                  <RepositoryView
                    apiBaseUrl={API_BASE_URL}
                    refreshKey={selectedCaptureJob?.job.collectionId ?? null}
                    onExpandTag={handleExpandTag}
                    onRepositoryChanged={() => void fetchProgress()}
                  />
                </div>
              )}
              {view === "collect" && (
                <div className="flex h-screen bg-white overflow-hidden">
                  {/* Left: Noir Aside */}
                  <aside className="w-[320px] bg-white border-r border-black/[0.05] flex flex-col shrink-0">
                    <header className="px-10 pt-10 pb-6">
                       <div className="flex items-center gap-3 text-[9px] font-black uppercase tracking-[0.4em] text-ink/20">
                         <span>采集工程</span>
                         <span className="text-ink/10">|</span>
                         <span>STATION</span>
                       </div>
                       <h1 className="text-[28px] font-bold text-ink tracking-tighter mt-3 uppercase">知识搜集</h1>
                    </header>

                    {/* New Task Command */}
                    <div className="px-8 pb-8 space-y-5 border-b border-black/[0.03] mb-6">
                      <div className="space-y-4">
                        <div className="px-1">
                          <label className="text-[9px] font-black text-ink/20 uppercase tracking-[0.3em]">发起新课题</label>
                        </div>
                        <div className="relative group">
                          <input
                            value={collectQuery}
                            onChange={(e) => setCollectQuery(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleCollect()}
                            className="w-full h-10 bg-black/[0.01] border-b border-black/10 focus:border-black py-2 pl-1 pr-4 text-[13px] font-bold transition-all outline-none placeholder:text-ink/5 tracking-tight uppercase"
                            placeholder="输入研究课题关键词..."
                          />
                        </div>
                        <div className="flex gap-2">
                          <select
                            value={collectProvider}
                            onChange={(e) => setCollectProvider(e.target.value as "web-search-api" | "grok-search")}
                            className="flex-1 h-9 bg-transparent border border-black/10 text-[10px] font-black uppercase tracking-widest px-3 outline-none cursor-pointer hover:bg-black/[0.02] transition-all appearance-none"
                          >
                            <option value="grok-search">Grok 智搜引擎</option>
                            <option value="web-search-api">全网研究接口</option>
                          </select>
                          <button
                            disabled={creatingCaptureJob || !collectQuery.trim()}
                            onClick={handleCollect}
                            className="h-9 w-9 bg-black text-white flex items-center justify-center transition-all active:scale-90 disabled:opacity-20"
                          >
                            {creatingCaptureJob ? <Loader2 className="w-4 h-4 animate-spin"/> : <PlusCircle className="w-4 h-4"/>}
                          </button>
                        </div>
                        
                        <div className="bg-black/[0.015] border border-black/[0.03] p-4 space-y-3">
                           <div className="flex items-center justify-between">
                              <span className="text-[9px] font-black text-ink/20 uppercase tracking-[0.2em]">当前配置</span>
                              <Settings className="w-3 h-3 text-ink/10" />
                           </div>
                           <div className="text-[12px] font-bold text-ink/80 flex items-center justify-between">
                              <span>输出语言</span>
                              <span>{getOutputLanguageLabel(preferredOutputLanguage)}</span>
                           </div>
                           <div className="text-[10px] font-bold text-ink/40 leading-relaxed">
                              搜索优先匹配英文高质量信源。
                           </div>
                        </div>
                      </div>
                    </div>

                    {/* History Feed */}
                    <div className="flex-1 overflow-hidden flex flex-col">
                      <div className="px-10 pb-4 flex items-center justify-between">
                        <h3 className="text-[9px] font-black text-ink/10 uppercase tracking-[0.4em]">采集队列 / HIST</h3>
                        <div className="text-[9px] font-black text-ink/5 tabular-nums">{captureJobs.length}</div>
                      </div>
                      
                      <div className="flex-1 overflow-y-auto no-scrollbar px-4 pb-10">
                        <div className="space-y-px">
                          {captureJobs.length === 0 ? (
                            <div className="py-20 text-center opacity-10">
                              <p className="text-[10px] font-bold uppercase tracking-widest">暂无记录</p>
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
                                  "w-full text-left px-6 py-4 transition-all relative group mb-0.5",
                                  selectedCaptureJobId === job.id ? "bg-black/[0.03]" : "hover:bg-black/[0.015]"
                                )}
                              >
                                {selectedCaptureJobId === job.id && (
                                  <motion.div layoutId="job-pill" className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-6 bg-black z-10" />
                                )}
                                <div className="flex items-center justify-between gap-3">
                                  <div className="min-w-0">
                                    <h4 className={cn(
                                      "text-[13px] font-bold truncate tracking-tight uppercase",
                                      selectedCaptureJobId === job.id ? "text-ink" : "text-ink/40 hover:text-ink/70"
                                    )}>
                                      {job.query}
                                    </h4>
                                    <div className="flex items-center gap-3 mt-2 font-black text-[9px] tracking-widest text-ink/10 uppercase">
                                      <span>{captureStatusLabel[job.status]}</span>
                                      <span>•</span>
                                      <span>{job.provider.split('-')[0]}</span>
                                    </div>
                                  </div>
                                  {job.status === 'processing' && <Loader2 className="w-3 h-3 animate-spin text-ink/20" />}
                                </div>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  </aside>

                  {/* Center: Command Center */}
                  <main className="flex-1 bg-white overflow-y-auto relative custom-scrollbar">
                    {selectedCaptureJob ? (
                      <div className="px-16 pt-12 pb-40">
                        <header className="flex items-end justify-between gap-12 pb-10 border-b border-black/[0.05] mb-12">
                          <div className="space-y-6 min-w-0">
                             <div className="text-[10px] font-black text-ink/20 uppercase tracking-[0.5em]">ACTIVE RESEARCH JOB</div>
                             <h2 className="text-[36px] font-bold text-ink leading-tight tracking-tight uppercase">
                               {selectedCaptureJob.job.query}
                             </h2>
                             <div className="flex items-center gap-12">
                                <StatItem label="已发现信源" value={selectedCaptureJob.job.discoveredSourceCount} />
                                <StatItem label="消耗算力" value={formatTokens(selectedCaptureJob.job.usage.totalTokens)} />
                                <StatItem label="AI 并发" value={selectedCaptureJob.job.aiConcurrency} />
                             </div>
                          </div>

                          <div className="flex flex-col items-end gap-4 shrink-0">
                             <button
                                disabled={!canStartReading || startingCaptureProcessing}
                                onClick={handleStartReading}
                                className="px-10 py-3 bg-black text-white text-[11px] font-black uppercase tracking-[0.4em] transition-all hover:translate-y-[-2px] hover:shadow-[0_10px_30px_rgba(0,0,0,0.15)] disabled:opacity-10"
                              >
                                {startingCaptureProcessing ? <Loader2 className="w-4 h-4 animate-spin"/> : "启动知识流引擎"}
                              </button>

                              {activeOperation && (
                                <div className="flex items-center gap-3 text-right">
                                  <Loader2 className="w-3.5 h-3.5 animate-spin text-black/40" />
                                  <div className="text-[10px] font-black text-ink/30 tracking-[0.2em] uppercase">
                                    {activeOperation.detail}
                                  </div>
                                </div>
                              )}
                          </div>
                        </header>

                        <section className="space-y-12">
                          {/* Stages Analysis */}
                          <div className="grid grid-cols-1 xl:grid-cols-[1fr_280px] gap-8">
                             <div className="bg-black/[0.015] border border-black/[0.03] p-8">
                                <div className="text-[10px] font-black uppercase tracking-[0.4em] text-ink/20 mb-8">流水线阶段分布</div>
                                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                                  {stageBreakdown.stages.map((stage) => (
                                    <div key={stage.stage} className="space-y-3">
                                      <div className="text-[9px] font-black uppercase tracking-[0.2em] text-ink/15 truncate">
                                        {pendingStageLabel[stage.stage]}
                                      </div>
                                      <div className="text-[28px] font-bold text-ink tracking-tighter tabular-nums flex items-baseline">
                                        {stage.percent}<span className="text-[11px] font-black text-ink/10 ml-0.5">%</span>
                                      </div>
                                      <div className="text-[9px] font-black text-ink/20 uppercase tracking-widest">{stage.count} 条记录</div>
                                    </div>
                                  ))}
                                </div>
                             </div>

                             <div className="border border-black/[0.05] p-8 flex flex-col justify-between">
                                <div>
                                   <div className="text-[10px] font-black uppercase tracking-[0.4em] text-ink/20 mb-4">异常/阻塞节点</div>
                                   <div className="text-[32px] font-bold text-ink/80 tracking-tighter tabular-nums">
                                      {sources.filter(s => s.skipped).length + stageBreakdown.failedCount}
                                   </div>
                                </div>
                                <p className="text-[10px] leading-relaxed text-ink/30 font-bold uppercase tracking-widest">跳过的低质或敏感信源不会再次进入执行循环。</p>
                             </div>
                          </div>

                          {/* Task Table */}
                          <div className="space-y-6">
                            <div className="flex items-center justify-between px-2">
                               <h3 className="text-[10px] font-black text-ink/20 uppercase tracking-[0.5em]">采集研究详细清单</h3>
                               <div className="text-[10px] font-black text-ink/10 uppercase tracking-widest">{unifiedDisplayItems.length} ITEMS</div>
                            </div>

                            <div className="border border-black/[0.05]">
                               <header className="grid grid-cols-[60px_2fr_100px_1fr] items-center gap-6 px-10 h-10 border-b border-black/[0.05] text-[9px] font-black text-ink/20 uppercase tracking-[0.3em]">
                                 <div className="text-center">状态</div>
                                 <div>实体 / 来源详情</div>
                                 <div className="text-center">链接</div>
                                 <div>反馈说明</div>
                               </header>

                               <div className="bg-white">
                                  {unifiedDisplayItems.length === 0 ? (
                                    <div className="py-32 text-center opacity-5">
                                       <FolderTree className="w-12 h-12 mx-auto mb-4" />
                                       <div className="text-[11px] font-black uppercase tracking-[1em]">IDLE</div>
                                    </div>
                                  ) : (
                                    unifiedDisplayItems.map((item) => (
                                      <div key={item.id} className="grid grid-cols-[60px_2fr_100px_1fr] items-center gap-6 px-10 min-h-[44px] border-b border-black/[0.02] last:border-0 hover:bg-black/[0.015] transition-colors group">
                                         <div className="flex justify-center">
                                            {item.skipped ? (
                                               <MoreHorizontal className="w-4 h-4 text-ink/10" />
                                            ) : item.error ? (
                                               <div className="w-1.5 h-1.5 rounded-full bg-ember" />
                                            ) : item.status === "reading" || item.status === "extracting" || activeOperation?.itemId === item.id ? (
                                               <Loader2 className="w-3.5 h-3.5 animate-spin text-ink/40" />
                                            ) : item.status === "completed" ? (
                                               <CheckCircle2 className="w-3.5 h-3.5 text-black" />
                                            ) : (
                                               <div className="w-1 h-1 rounded-full bg-black/10 transition-transform group-hover:scale-150" />
                                            )}
                                         </div>

                                         <div className="min-w-0">
                                            <div className={cn(
                                              "text-[13.5px] font-bold truncate tracking-tight transition-colors",
                                              item.skipped ? "text-ink/10" : activeOperation?.itemId === item.id ? "text-ink" : "text-ink/60 group-hover:text-ink"
                                            )}>
                                              {item.kind === 'truth' ? (item.title || "正在处理事实条目...") : (item.title || "研读文档内容...")}
                                            </div>
                                         </div>

                                         <div className="flex justify-center">
                                            {item.sourceUrl ? (
                                              <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="p-2 border border-transparent hover:border-black/10 hover:bg-white text-ink/10 hover:text-black transition-all">
                                                 <ArrowUpRight className="w-3.5 h-3.5" />
                                              </a>
                                            ) : <span className="text-[9px] font-black text-ink/5">--</span>}
                                         </div>

                                         <div className="text-[11px] font-bold tracking-tight text-ink/30 truncate">
                                            {item.error ? "执行异常" : (item.kind === "source" ? sourceStatusLabel[item.status as CaptureSourceStatus] : pendingItemStatusLabel[item.status as CapturePendingItemStatus])}
                                         </div>
                                      </div>
                                    ))
                                  )}
                               </div>
                            </div>
                          </div>
                        </section>
                      </div>
                    ) : (
                      <div className="h-full flex flex-col items-center justify-center p-20 animate-in fade-in duration-1000">
                        <div className="w-24 h-24 border border-black/[0.05] bg-black/[0.01] flex items-center justify-center mb-10">
                           <Zap className="w-8 h-8 text-ink/5" />
                        </div>
                        <h3 className="text-[20px] font-bold text-ink tracking-tight">未选择采集任务</h3>
                        <p className="text-ink/20 text-[11px] mt-4 font-black uppercase tracking-[0.4em]">请在左侧列表选择研究课题以查看流水线进度</p>
                      </div>
                    )}
                  </main>
                </div>
              )}
              {view === "settings" && (
                <div className="h-full overflow-y-auto custom-scrollbar px-16 py-12 max-w-4xl mx-auto">
                  <header className="space-y-6 pb-12 border-b border-black/[0.05]">
                    <div className="text-[10px] font-black uppercase tracking-[0.5em] text-ink/20">System Preferences</div>
                    <h1 className="text-[42px] font-bold tracking-tighter text-ink uppercase leading-none">系统偏好设置</h1>
                    <p className="text-[13px] leading-relaxed text-ink/40 font-medium">定制 AI 的行为逻辑、输出语言规范以及采集引擎的并发负载分布。</p>
                  </header>

                  <div className="mt-12 space-y-12">
                     <section className="space-y-8">
                        <div className="text-[10px] font-black uppercase tracking-[0.4em] text-ink/20">语言治理</div>
                        <div className="grid gap-4">
                          {OUTPUT_LANGUAGE_OPTIONS.map((option) => (
                            <button
                              key={option.value}
                              onClick={() => setPreferredOutputLanguage(option.value)}
                              className={cn(
                                "flex items-start gap-6 p-8 border transition-all text-left group",
                                preferredOutputLanguage === option.value
                                  ? "bg-black border-black text-white"
                                  : "bg-white border-black/[0.05] hover:bg-black/[0.01] text-ink"
                              )}
                            >
                               <div className={cn("w-5 h-5 rounded-full border flex items-center justify-center mt-1 shrink-0", 
                                 preferredOutputLanguage === option.value ? "border-white" : "border-black/20")}>
                                  {preferredOutputLanguage === option.value && <div className="w-2 h-2 bg-white rounded-full" />}
                               </div>
                               <div className="space-y-2">
                                  <div className="text-[16px] font-bold uppercase tracking-tight">{option.label}</div>
                                  <div className={cn("text-[11px] leading-relaxed font-medium uppercase tracking-widest", 
                                    preferredOutputLanguage === option.value ? "text-white/40" : "text-ink/30")}>
                                    {option.description}
                                  </div>
                               </div>
                            </button>
                          ))}
                        </div>
                     </section>

                     <section className="space-y-8">
                        <div className="text-[10px] font-black uppercase tracking-[0.4em] text-ink/20">平衡引擎配置 / LOAD BALANCING</div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                           <div className="border border-black/[0.05] p-8 space-y-6">
                              <div className="text-[11px] font-black uppercase tracking-[0.3em] text-ink/30">信源检索上限</div>
                              <div className="text-[42px] font-bold text-ink tracking-tighter">{collectSearchLimit}</div>
                              <input
                                type="range" min={1} max={100} value={collectSearchLimit}
                                onChange={(e) => updateCollectSearchLimit(Number(e.target.value))}
                                className="w-full accent-black h-1"
                              />
                           </div>
                           <div className="border border-black/[0.05] p-8 space-y-6">
                              <div className="text-[11px] font-black uppercase tracking-[0.3em] text-ink/30">AI 算力并发控制</div>
                              <div className="text-[42px] font-bold text-ink tracking-tighter">{collectAiConcurrency}</div>
                              <input
                                type="range" min={1} max={8} value={collectAiConcurrency}
                                onChange={(e) => updateCollectAiConcurrency(Number(e.target.value))}
                                className="w-full accent-black h-1"
                              />
                           </div>
                        </div>
                     </section>
                  </div>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        )}
      </main>

      {/* Floating Dock - Monochrome Edition */}
      <div className="fixed bottom-12 left-1/2 -translate-x-1/2 z-[100]">
        <div className="flex items-center bg-white border border-black/10 p-1.5 rounded-full shadow-[0_20px_50px_rgba(0,0,0,0.1)] gap-1">
          <DockItem 
            icon={LayoutDashboard} label="概览" 
            active={view === "dashboard"} onClick={() => setView("dashboard")} 
          />
          <DockItem 
            icon={Search} label="探索" 
            active={view === "search"} onClick={() => setView("search")} 
          />
          <DockItem 
            icon={Database} label="智库" 
            active={view === "truths"} onClick={() => setView("truths")} 
          />
          <DockItem 
            icon={Zap} label="采集" 
            active={view === "collect"} onClick={() => setView("collect")} 
          />
          <div className="w-px h-6 bg-black/5 mx-2" />
          <DockItem 
            icon={Settings} label="系统" 
            active={view === "settings"} onClick={() => setView("settings")} 
          />
        </div>
      </div>
    </div>
  );
};

export default App;
