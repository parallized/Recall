import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  FolderTree,
  Loader2,
  PlusCircle,
  RefreshCw,
  Search,
  Target,
  X
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { clsx, type ClassValue } from "clsx";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type RepositoryTagNode = {
  id: string;
  parentId: string | null;
  level: 1 | 2 | 3;
  name: string;
  description: string;
  progress: number;
  truthCount: number;
  unreadCount: number;
};

type RepositoryTruth = {
  id: string;
  statement: string;
  summary: string;
  questionType?: "multiple_choice" | "open_ended";
  options?: string[];
  answer?: string;
  explanation?: string;
  evidenceQuote: string;
  confidence: number;
  sourceUrl: string;
  level1TagId: string;
  level2TagId: string;
  level3TagId: string;
  level1TagName: string;
  level2TagName: string;
  level3TagName: string;
  readCount: number;
  createdAt?: string;
  lastReadAt?: string | null;
  isUnread: boolean;
};

type RepositorySnapshot = {
  summary: {
    truthCount: number;
    unreadCount: number;
    level1TagCount: number;
    level2TagCount: number;
    level3TagCount: number;
    multipleChoiceCount: number;
    openEndedCount: number;
  };
  taxonomy: RepositoryTagNode[];
  truths: RepositoryTruth[];
};

type RepositoryViewProps = {
  apiBaseUrl: string;
  refreshKey?: string | null;
  onExpandTag?: (input: { tagId: string; tagPath: string; query: string }) => Promise<void>;
  onRepositoryChanged?: () => void | Promise<void>;
};

const questionTypeLabel: Record<NonNullable<RepositoryTruth["questionType"]>, string> = {
  multiple_choice: "选择题",
  open_ended: "开放题",
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

const buildTagPath = (
  node: RepositoryTagNode | null,
  nodeById: Map<string, RepositoryTagNode>,
) => {
  if (!node) {
    return "智库仓储 / 全量题库";
  }

  const names: string[] = [];
  let current: RepositoryTagNode | null = node;

  while (current) {
    names.unshift(current.name);
    current = current.parentId ? nodeById.get(current.parentId) ?? null : null;
  }

  return names.join(" / ");
};

const buildTagExpansionQuery = (
  node: RepositoryTagNode,
  nodeById: Map<string, RepositoryTagNode>,
) => buildTagPath(node, nodeById).replaceAll(" / ", " > ");

const matchesSelectedTag = (truth: RepositoryTruth, selectedNode: RepositoryTagNode | null) => {
  if (!selectedNode) {
    return true;
  }

  if (selectedNode.level === 1) {
    return truth.level1TagId === selectedNode.id;
  }

  if (selectedNode.level === 2) {
    return truth.level2TagId === selectedNode.id;
  }

  return truth.level3TagId === selectedNode.id;
};

let mermaidInitialized = false;

const MermaidBlock = ({ chart }: { chart: string }) => {
  const [svg, setSvg] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const renderChart = async () => {
      try {
        const { default: mermaid } = await import("mermaid");

        if (!mermaidInitialized) {
          mermaid.initialize({
            startOnLoad: false,
            theme: "neutral",
            securityLevel: "loose",
          });
          mermaidInitialized = true;
        }

        const { svg: renderedSvg } = await mermaid.render(
          `repository-mermaid-${Math.random().toString(36).slice(2)}`,
          chart,
        );

        if (!cancelled) {
          setSvg(renderedSvg);
          setRenderError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setRenderError(error instanceof Error ? error.message : "Mermaid 渲染失败");
          setSvg(null);
        }
      }
    };

    void renderChart();

    return () => {
      cancelled = true;
    };
  }, [chart]);

  if (renderError) {
    return (
      <div className="repository-mermaid-fallback">
        <div className="repository-mermaid-fallback__label">Mermaid 图渲染失败，已回退为源码</div>
        <pre>
          <code>{chart}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="repository-mermaid-loading">
        <Loader2 className="h-4 w-4 animate-spin text-accent" />
        <span>Mermaid 图渲染中...</span>
      </div>
    );
  }

  return <div className="repository-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
};

const MarkdownContent = ({ content }: { content: string }) => (
  <div className="markdown-body">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        code: (props) => {
          const { className, children, ...rest } = props;
          const inline = (props as { inline?: boolean }).inline ?? false;
          const language = /language-(\w+)/.exec(className ?? "")?.[1];
          const code = String(children).replace(/\n$/, "");

          if (!inline && language === "mermaid") {
            return <MermaidBlock chart={code} />;
          }

          if (inline) {
            return (
              <code className="markdown-inline-code" {...rest}>
                {children}
              </code>
            );
          }

          return (
            <pre className="markdown-pre">
              <code className={className} {...rest}>
                {code}
              </code>
            </pre>
          );
        },
        table: ({ children }) => (
          <div className="markdown-table-wrapper">
            <table>{children}</table>
          </div>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  </div>
);

const UnreadBadge = ({ count }: { count: number }) => {
  if (count <= 0) {
    return null;
  }

  return (
    <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-accent px-1.5 py-0.5 text-[9px] font-black text-white tabular-nums">
      {count}
    </span>
  );
};

const RepositoryTreeNode = ({
  childrenByParentId,
  depth,
  node,
  selectedTagId,
  onSelect,
}: {
  childrenByParentId: Map<string, RepositoryTagNode[]>;
  depth: number;
  node: RepositoryTagNode;
  selectedTagId: string | null;
  onSelect: (tagId: string) => void;
}) => {
  const children = childrenByParentId.get(node.id) ?? [];

  return (
    <div className="space-y-[2px]">
      <button
        onClick={() => onSelect(node.id)}
        className={cn(
          "w-full px-4 py-1.5 text-left transition-all rounded-lg group/node relative",
          selectedTagId === node.id 
            ? "bg-white ring-1 ring-line/60 text-ink" 
            : "hover:bg-white/40 text-ink/40 hover:text-ink/80"
        )}
        style={{ paddingLeft: `${depth * 12 + 16}px` }}
      >
        {selectedTagId === node.id && (
           <div className="absolute left-1 top-1/2 -translate-y-1/2 w-0.5 h-3.5 bg-accent rounded-full" />
        )}
        <div className="flex items-center justify-between gap-3 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
             <ChevronRight className={cn("h-3 w-3 shrink-0 opacity-10 transition-transform", children.length > 0 && "opacity-30", selectedTagId === node.id && "text-accent opacity-100 rotate-90")} />
             <span className="truncate text-[12.5px] font-bold tracking-tight">{node.name}</span>
             <UnreadBadge count={node.unreadCount} />
          </div>
          <span className="text-[8px] font-black opacity-10 group-hover/node:opacity-30 transition-opacity uppercase tracking-widest tabular-nums">{node.truthCount}</span>
        </div>
      </button>

      {children.length > 0 && (
        <div className="space-y-px mt-px">
          {children.map((child) => (
            <RepositoryTreeNode
              key={child.id}
              childrenByParentId={childrenByParentId}
              depth={depth + 1}
              node={child}
              selectedTagId={selectedTagId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const RepositoryTruthCard = ({
  truth,
  onSelect,
}: {
  truth: RepositoryTruth;
  onSelect: () => void;
}) => (
  <motion.button
    layout
    onClick={onSelect}
    className="w-full px-5 py-2.5 text-left transition-all border-b border-line/10 relative group hover:bg-silver/5"
  >
    <div className="flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 opacity-20 group-hover:opacity-40 transition-opacity">
           <span className="text-[8px] font-black uppercase tracking-[0.2em] tabular-nums">{questionTypeLabel[truth.questionType ?? "open_ended"]}</span>
           <span className="text-[8px] font-bold">•</span>
           <span className="text-[8px] font-bold uppercase tracking-widest">{truth.level3TagName}</span>
           <span
             className={cn(
               "rounded-full px-2 py-0.5 text-[8px] font-black tracking-[0.16em]",
               truth.isUnread ? "bg-accent/[0.08] text-accent" : "bg-black/[0.04] text-ink/45",
             )}
           >
             {truth.isUnread ? "未读" : `已读 ${truth.readCount}`}
           </span>
        </div>
        <div className="text-[13.5px] font-bold tracking-tight leading-snug truncate text-ink">
           {truth.statement}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0 opacity-0 group-hover:opacity-100 transition-all">
         <span className="text-[9px] text-ink/20 font-black tabular-nums">{Math.round(truth.confidence * 100)}%</span>
         <ChevronRight className="w-3 h-3 text-ink/20" />
      </div>
    </div>
  </motion.button>
);

const RepositoryDetailModal = ({ 
  truth, 
  isOpen, 
  onClose,
  onMarkRead,
  onDestroy,
  markingRead,
  destroying,
  actionError,
}: { 
  truth: RepositoryTruth | null; 
  isOpen: boolean; 
  onClose: () => void;
  onMarkRead: (truth: RepositoryTruth) => Promise<void>;
  onDestroy: (truth: RepositoryTruth) => Promise<void>;
  markingRead: boolean;
  destroying: boolean;
  actionError: string | null;
}) => (
  <AnimatePresence>
    {isOpen && (
      <>
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 bg-white/20 backdrop-blur-sm z-[60] cursor-zoom-out"
        />

        {/* Modal Content */}
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 10 }}
          transition={{ duration: 0.15, ease: [0.23, 1, 0.32, 1] }}
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[90%] max-w-2xl max-h-[85vh] z-[70] will-change-[transform,opacity] isolate"
        >
          <div className="bg-white/80 backdrop-blur-xl border border-[#efeff1] shadow-[0_30px_90px_rgba(0,0,0,0.12)] rounded-[32px] flex flex-col h-full ring-1 ring-black/5 overflow-hidden transform-gpu" style={{ transform: 'translateZ(0)' }}>
             {/* Header with Close Button */}
             <div className="flex justify-end p-6 pb-0 shrink-0">
                <button 
                  onClick={onClose}
                  className="p-2 rounded-full hover:bg-black/5 text-ink/20 hover:text-ink transition-all active:scale-90"
                >
                  <X className="w-5 h-5" />
                </button>
             </div>

             {/* Detail Panel Wrapper */}
             <div className="flex-1 overflow-y-auto custom-scrollbar px-10 pb-16 pt-2">
                <RepositoryDetailPanel
                  truth={truth}
                  onMarkRead={onMarkRead}
                  onDestroy={onDestroy}
                  markingRead={markingRead}
                  destroying={destroying}
                  actionError={actionError}
                />
             </div>
          </div>
        </motion.div>
      </>
    )}
  </AnimatePresence>
);

const RepositoryDetailPanel = ({
  truth,
  onMarkRead,
  onDestroy,
  markingRead,
  destroying,
  actionError,
}: {
  truth: RepositoryTruth | null;
  onMarkRead: (truth: RepositoryTruth) => Promise<void>;
  onDestroy: (truth: RepositoryTruth) => Promise<void>;
  markingRead: boolean;
  destroying: boolean;
  actionError: string | null;
}) => {
  if (!truth) {
    return (
      <div className="h-full flex flex-col items-center justify-center space-y-8 animate-in fade-in duration-1000">
        <div className="w-20 h-20 rounded-[40px] bg-[#f9f9f9] border border-line flex items-center justify-center">
            <BookOpen className="h-7 w-7 text-ink/10" />
        </div>
        <div className="text-center space-y-2">
            <div className="text-[14px] font-bold text-ink">知识详情</div>
            <p className="text-[12px] text-ink/40 max-w-[240px] mx-auto leading-relaxed font-medium">从左侧筛选知识点并选择具体的智库条目来查看详细的标准答案与证据链。</p>
        </div>
      </div>
    );
  }

  const highlightedAnswer = truth.answer?.trim();

  return (
    <div className="h-full animate-in fade-in slide-in-from-right-8 duration-700 space-y-10">
      <header className="space-y-4">
         <div className="flex items-center gap-3 text-ink/20 text-[9px] font-black tracking-widest uppercase">
            <span className="text-accent">{questionTypeLabel[truth.questionType ?? "open_ended"]}</span>
            <span>/</span>
            <span>{truth.level1TagName}</span>
            <span>/</span>
            <span>{truth.level3TagName}</span>
         </div>
         <h1 className="text-[28px] font-bold text-ink tracking-tight leading-tight">{truth.statement}</h1>
      </header>

      <div className="space-y-10">
        {/* Standard Answer Section */}
        <section className="space-y-4">
           <div className="flex items-center gap-3">
              <div className="h-px bg-line/40 flex-1" />
              <h4 className="text-[10px] font-black uppercase tracking-[0.4em] text-ink/20 shrink-0">标准答案</h4>
              <div className="h-px bg-line/40 flex-1" />
           </div>
           <div className="text-[15.5px] leading-relaxed text-ink/80 font-medium">
              <MarkdownContent content={truth.answer ?? truth.summary} />
           </div>
        </section>

        {truth.options && truth.options.length > 0 && (
          <section className="space-y-4">
             <h4 className="text-[10px] font-black uppercase tracking-[0.4em] text-ink/20">备选项</h4>
             <div className="grid gap-2">
                {truth.options.map((option, index) => {
                  const isAnswer = highlightedAnswer && option.trim() === highlightedAnswer;
                  return (
                    <div key={`${truth.id}-${option}`} className={cn(
                      "px-5 py-3 rounded-lg border transition-all text-[13px] flex items-center gap-4",
                      isAnswer ? "bg-accent/[0.03] border-accent/20 text-accent font-bold" : "bg-white border-line/60 text-ink/70"
                    )}>
                      <span className={cn("text-[10px] font-black opacity-30", isAnswer && "opacity-100")}>{String.fromCharCode(65 + index)}</span>
                      <span className="flex-1 font-medium">{option}</span>
                    </div>
                  );
                })}
             </div>
          </section>
        )}

        {truth.explanation && (
          <section className="space-y-4 bg-[#f9f9f9] rounded-lg p-6 border border-line/40">
             <h4 className="text-[10px] font-black uppercase tracking-[0.4em] text-ink/20">延伸说明</h4>
             <div className="text-[13px] leading-relaxed text-ink/60 font-medium">
               <MarkdownContent content={truth.explanation} />
             </div>
          </section>
        )}

        <section className="space-y-4 py-6 border-t border-line/40">
           <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 text-ink/30">
                 <Target className="w-3.5 h-3.5" />
                 <span className="text-[10px] font-bold">可信度 {Math.round(truth.confidence * 100)}%</span>
              </div>
              <a href={truth.sourceUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-ink/60 hover:text-accent transition-colors">
                 <span>查看信源</span>
                 <ArrowUpRight className="w-3.5 h-3.5" />
              </a>
           </div>

           <div className="flex items-center justify-between gap-4 border-t border-line/40 pt-4">
              <div className="text-[11px] font-bold tracking-tight text-ink/45">
                 {truth.isUnread ? "未读" : `已读 ${truth.readCount} 次`}
              </div>
              <div className="flex items-center gap-5">
                 <button
                   onClick={() => void onDestroy(truth)}
                   disabled={destroying || markingRead}
                   className="text-[12px] font-bold text-ember/80 transition-colors hover:text-ember disabled:cursor-not-allowed disabled:opacity-40"
                 >
                   {destroying ? "销毁中..." : "销毁"}
                 </button>
                 <button
                   onClick={() => void onMarkRead(truth)}
                   disabled={destroying || markingRead}
                   className="text-[12px] font-bold text-accent transition-colors hover:text-accent/80 disabled:cursor-not-allowed disabled:opacity-40"
                 >
                   {markingRead ? "标记中..." : "已读"}
                 </button>
              </div>
           </div>

           {actionError && <div className="text-[11px] font-medium text-ember">{actionError}</div>}
        </section>
      </div>
    </div>
  );
};

const StatItem = ({ label, value }: { label: string, value: string | number }) => (
  <div className="flex items-baseline gap-2">
    <span className="text-[9px] font-black text-ink/15 uppercase tracking-[0.2em]">{label}</span>
    <span className="text-base font-bold text-ink">{value}</span>
  </div>
);

export const RepositoryView = ({
  apiBaseUrl,
  refreshKey,
  onExpandTag,
  onRepositoryChanged,
}: RepositoryViewProps) => {
  const [snapshot, setSnapshot] = useState<RepositorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [selectedTruthId, setSelectedTruthId] = useState<string | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [truthActionError, setTruthActionError] = useState<string | null>(null);
  const [markingReadTruthId, setMarkingReadTruthId] = useState<string | null>(null);
  const [destroyingTruthId, setDestroyingTruthId] = useState<string | null>(null);
  const [expandingTagId, setExpandingTagId] = useState<string | null>(null);
  const [expandError, setExpandError] = useState<string | null>(null);

  const fetchRepository = async (silent = false) => {
    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const response = await fetch(`${apiBaseUrl}/repository`);

      if (!response.ok) {
        throw new Error(await readErrorResponse(response));
      }

      const data = (await response.json()) as RepositorySnapshot;
      setSnapshot(data);
      setError(null);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "无法加载知识仓库");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void fetchRepository();
  }, [apiBaseUrl, refreshKey]);

  const nodeById = useMemo(
    () => new Map((snapshot?.taxonomy ?? []).map((node) => [node.id, node])),
    [snapshot?.taxonomy],
  );

  useEffect(() => {
    if (selectedTagId && !nodeById.has(selectedTagId)) {
      setSelectedTagId(null);
    }
  }, [nodeById, selectedTagId]);

  const childrenByParentId = useMemo(() => {
    const next = new Map<string, RepositoryTagNode[]>();

    for (const node of snapshot?.taxonomy ?? []) {
      if (!node.parentId) {
        continue;
      }

      const siblings = next.get(node.parentId) ?? [];
      siblings.push(node);
      next.set(node.parentId, siblings);
    }

    for (const siblings of next.values()) {
      siblings.sort(
        (left, right) =>
          right.truthCount - left.truthCount || left.name.localeCompare(right.name, "zh-CN"),
      );
    }

    return next;
  }, [snapshot?.taxonomy]);

  const level1Nodes = useMemo(
    () =>
      (snapshot?.taxonomy ?? [])
        .filter((node) => node.level === 1)
        .sort(
          (left, right) =>
            right.truthCount - left.truthCount || left.name.localeCompare(right.name, "zh-CN"),
        ),
    [snapshot?.taxonomy],
  );

  const selectedTag = selectedTagId ? nodeById.get(selectedTagId) ?? null : null;

  const filteredTruths = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLowerCase();

    return (snapshot?.truths ?? []).filter((truth) => {
      if (!matchesSelectedTag(truth, selectedTag)) {
        return false;
      }

      if (!normalizedSearch) {
        return true;
      }

      const haystack = [
        truth.statement,
        truth.summary,
        truth.answer ?? "",
        truth.explanation ?? "",
        truth.level1TagName,
        truth.level2TagName,
        truth.level3TagName,
      ]
        .join("\n")
        .toLowerCase();

      return haystack.includes(normalizedSearch);
    });
  }, [searchQuery, selectedTag, snapshot?.truths]);

  const selectedTruth = (snapshot?.truths ?? []).find((truth) => truth.id === selectedTruthId) ?? null;
  const repositoryTitle = buildTagPath(selectedTag, nodeById);
  const visibleMultipleChoiceCount = filteredTruths.filter(
    (truth) => truth.questionType === "multiple_choice",
  ).length;
  const visibleOpenEndedCount = filteredTruths.length - visibleMultipleChoiceCount;
  const visibleUnreadCount = filteredTruths.filter((truth) => truth.isUnread).length;

  useEffect(() => {
    if (selectedTruthId && !selectedTruth) {
      setSelectedTruthId(null);
      setIsDetailOpen(false);
    }
  }, [selectedTruth, selectedTruthId]);

  const handleMarkRead = async (truth: RepositoryTruth) => {
    setTruthActionError(null);
    setMarkingReadTruthId(truth.id);

    try {
      const response = await fetch(`${apiBaseUrl}/truths/${truth.id}/read`, {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(await readErrorResponse(response));
      }

      await fetchRepository(true);
      await onRepositoryChanged?.();
    } catch (actionError) {
      setTruthActionError(actionError instanceof Error ? actionError.message : "无法标记为已读");
    } finally {
      setMarkingReadTruthId(null);
    }
  };

  const handleDestroy = async (truth: RepositoryTruth) => {
    const confirmed = window.confirm("确认彻底销毁这张知识卡片吗？销毁后无法恢复。");

    if (!confirmed) {
      return;
    }

    setTruthActionError(null);
    setDestroyingTruthId(truth.id);

    try {
      const response = await fetch(`${apiBaseUrl}/truths/${truth.id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error(await readErrorResponse(response));
      }

      setSelectedTruthId(null);
      setIsDetailOpen(false);
      await fetchRepository(true);
      await onRepositoryChanged?.();
    } catch (actionError) {
      setTruthActionError(actionError instanceof Error ? actionError.message : "无法销毁知识卡片");
    } finally {
      setDestroyingTruthId(null);
    }
  };

  const handleExpandSelectedTag = async () => {
    if (!selectedTag || !onExpandTag) {
      return;
    }

    setExpandError(null);
    setExpandingTagId(selectedTag.id);

    try {
      await onExpandTag({
        tagId: selectedTag.id,
        tagPath: repositoryTitle,
        query: buildTagExpansionQuery(selectedTag, nodeById),
      });
    } catch (actionError) {
      setExpandError(actionError instanceof Error ? actionError.message : "无法加入扩充题库策略");
    } finally {
      setExpandingTagId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="space-y-4 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[32px] bg-ink/5 border border-line shadow-sm">
            <Loader2 className="h-6 w-6 animate-spin text-accent" />
          </div>
          <div className="text-[10px] font-black uppercase tracking-[0.4em] text-ink/20 animate-pulse">正在构建知识仓库</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-xl mx-auto rounded-2xl border border-ember/10 bg-ember/[0.02] p-10 text-center space-y-6">
        <div className="text-[20px] font-bold text-ink tracking-tight">知识仓库暂不可用</div>
        <div className="text-[13px] leading-relaxed text-ink/60">{error}</div>
        <button
          onClick={() => void fetchRepository()}
          className="inline-flex items-center gap-3 rounded-lg bg-ink text-white px-6 py-2.5 text-[11px] font-bold transition-all hover:scale-[1.05]"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          重新连接
        </button>
      </div>
    );
  }

  if (!snapshot || snapshot.summary.truthCount === 0) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="max-w-md rounded-[40px] border border-dashed border-line/40 bg-[#f9f9f9] p-12 text-center space-y-8">
          <div className="mx-auto w-24 h-24 rounded-[40px] bg-white border border-line flex items-center justify-center">
            <FolderTree className="h-8 w-8 text-ink/10" />
          </div>
          <div className="space-y-3">
             <div className="text-[22px] font-bold text-ink tracking-tighter">知识仓库为空</div>
             <p className="text-[12px] leading-relaxed text-ink/40 font-medium">请先在采集视图发起知识流。通过校验的知识卡片会自动进入这里的分类树。</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-white overflow-hidden flex flex-col relative animate-in fade-in duration-700">
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Taxonomy Sidebar Style */}
        <aside className="w-[320px] bg-[#f9f9f9] border-r border-line flex flex-col shrink-0 overflow-hidden">
          <header className="px-8 pt-10 pb-4">
             <div className="flex items-center gap-2 text-[9px] font-black uppercase tracking-[0.2em] text-ink/20">
               <span>仓库</span>
               <span>/</span>
               <span>Taxonomy</span>
             </div>
             <h1 className="text-[22px] font-bold text-ink tracking-tight mt-1">智库仓储</h1>
             <p className="text-ink/40 text-[11px] mt-1 font-bold leading-relaxed tracking-widest">知识仓库</p>
          </header>

          <div className="flex-1 flex flex-col min-h-0">
             <div className="px-8 pb-3 flex items-center justify-between">
                <h3 className="text-[9px] font-black text-ink/20 uppercase tracking-[0.2em]">全部标签</h3>
                <div className="text-[9px] font-black text-ink/10">{snapshot.taxonomy.length}</div>
             </div>
             
             <div className="flex-1 overflow-y-auto custom-scrollbar px-3 pb-8">
                <div className="space-y-1">
                  <button
                    onClick={() => setSelectedTagId(null)}
                    className={cn(
                      "w-full text-left px-4 py-2.5 rounded-lg transition-all relative group mb-1",
                      selectedTagId === null ? "bg-white ring-1 ring-line/60 shadow-sm" : "hover:bg-white/40"
                    )}
                  >
                    {selectedTagId === null && <div className="absolute left-1 top-1/2 -translate-y-1/2 w-0.5 h-3.5 bg-accent rounded-full" />}
                    <div className="flex items-center justify-between gap-3">
                       <div className="flex min-w-0 items-center gap-2">
                         <span className={cn("text-[13px] font-bold tracking-tight", selectedTagId === null ? "text-ink" : "text-ink/40")}>全部知识</span>
                         <UnreadBadge count={snapshot.summary.unreadCount} />
                       </div>
                       <span className="text-[8px] font-black opacity-10 group-hover:opacity-30 transition-opacity uppercase tracking-widest tabular-nums">{snapshot.summary.truthCount}</span>
                    </div>
                  </button>
                  <div className="h-px bg-line/40 mx-4 my-2" />
                  {level1Nodes.map((node) => (
                    <RepositoryTreeNode
                      key={node.id}
                      childrenByParentId={childrenByParentId}
                      depth={0}
                      node={node}
                      selectedTagId={selectedTagId}
                      onSelect={setSelectedTagId}
                    />
                  ))}
                </div>
             </div>
          </div>
        </aside>

        {/* Center Pillar: Question Feed (Pane 2) */}
        <div className="flex-1 flex flex-col h-screen max-h-screen border-r border-line bg-white">
          <header className="px-10 pt-16 pb-8 border-b border-line/40">
             <div className="flex items-start justify-between gap-6">
                <div className="space-y-4 min-w-0">
                   <h2 className="text-[32px] font-bold text-ink leading-tight tracking-tight truncate">{repositoryTitle}</h2>
                   <div className="flex flex-wrap items-center gap-8">
                      <StatItem label="卡片数" value={selectedTag ? selectedTag.truthCount : snapshot.summary.truthCount} />
                      <StatItem label="未读" value={selectedTag ? selectedTag.unreadCount : snapshot.summary.unreadCount} />
                      <StatItem label="题型比" value={`${visibleMultipleChoiceCount}:${visibleOpenEndedCount}`} />
                   </div>
                </div>

                <div className="flex items-center gap-3 pt-1 shrink-0">
                   <button
                     onClick={() => void fetchRepository(true)}
                     disabled={refreshing}
                     className="inline-flex items-center gap-2 rounded-full border border-line/60 px-4 py-2 text-[11px] font-bold text-ink/65 transition-all hover:border-line hover:bg-silver/20 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                   >
                     {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                     刷新
                   </button>
                   <button
                     onClick={() => void handleExpandSelectedTag()}
                     disabled={!selectedTag || !onExpandTag || expandingTagId !== null}
                     className="inline-flex items-center gap-2 rounded-full bg-ink px-4 py-2 text-[11px] font-bold text-white transition-all hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-45"
                   >
                     {expandingTagId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlusCircle className="h-3.5 w-3.5" />}
                     扩充题库
                   </button>
                </div>
             </div>

             <div className="relative mt-8">
                <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink/20" />
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="在知识仓库中检索相关事实..."
                  className="w-full h-10 rounded-lg border border-line/60 bg-[#fcfcfc] py-3 pl-11 pr-4 text-[13px] text-ink outline-none transition-all placeholder:text-ink/10 focus:bg-white focus:border-accent/40"
                />
             </div>

             {selectedTag === null && (
               <div className="mt-3 text-[11px] font-medium text-ink/35">先从左侧选择一个标签，再为它扩充题库。</div>
             )}
             {expandError && <div className="mt-3 text-[11px] font-medium text-ember">{expandError}</div>}
             {!expandError && visibleUnreadCount > 0 && (
               <div className="mt-3 text-[11px] font-medium text-ink/35">当前视图还有 {visibleUnreadCount} 张未读卡片。</div>
             )}
          </header>

          <div className="flex-1 overflow-y-auto custom-scrollbar">
             <div className="pb-40">
              {filteredTruths.length === 0 ? (
                <div className="py-24 text-center">
                   <div className="text-[10px] font-black text-ink/10 uppercase tracking-[1em]">暂无匹配结果</div>
                </div>
              ) : (
                filteredTruths.map((truth) => (
                  <RepositoryTruthCard
                    key={truth.id}
                    truth={truth}
                    onSelect={() => {
                      setSelectedTruthId(truth.id);
                      setTruthActionError(null);
                      setIsDetailOpen(true);
                    }}
                  />
                ))
              )}
             </div>
          </div>
        </div>

      </div>

      {/* Floating Detail Modal */}
      <RepositoryDetailModal
        truth={selectedTruth}
        isOpen={isDetailOpen}
        onClose={() => {
          setIsDetailOpen(false);
          setTruthActionError(null);
        }}
        onMarkRead={handleMarkRead}
        onDestroy={handleDestroy}
        markingRead={selectedTruthId !== null && markingReadTruthId === selectedTruthId}
        destroying={selectedTruthId !== null && destroyingTruthId === selectedTruthId}
        actionError={truthActionError}
      />
    </div>
  );
};

export default RepositoryView;
