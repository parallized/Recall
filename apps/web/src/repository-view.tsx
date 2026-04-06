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
    return "全量仓储 / 全部";
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
        <div className="repository-mermaid-fallback__label">图谱渲染失败，已回退为源码</div>
        <pre>
          <code>{chart}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="repository-mermaid-loading">
        <Loader2 className="h-4 w-4 animate-spin text-ink/20" />
        <span>正在加载图谱...</span>
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
    <span className="inline-flex min-w-4 items-center justify-center rounded-sm bg-ink/[0.08] px-1 py-0.5 text-[8px] font-black text-ink/50 tabular-nums">
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
  const hasChildren = children.length > 0;
  const [isExpanded, setIsExpanded] = useState(depth === 0);

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsExpanded(!isExpanded);
  };

  const isSelected = selectedTagId === node.id;

  return (
    <div className="space-y-[1px]">
      <div 
        className={cn(
          "group/node relative flex items-center gap-0.5 transition-all duration-500",
          isSelected 
            ? "bg-reverse/[0.03]" 
            : "hover:bg-reverse/[0.015]"
        )}
        style={{ marginLeft: `${depth > 0 ? 12 : 0}px` }}
      >
        {isSelected && (
           <motion.div 
             layoutId="sidebar-active-pill"
             className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-4 bg-reverse z-10 rounded-full" 
           />
        )}

        <button
          onClick={handleToggle}
          disabled={!hasChildren}
          className={cn(
            "flex items-center justify-center w-7 h-7 transition-all",
            !hasChildren && "opacity-0 pointer-events-none",
            hasChildren && "text-reverse/10 hover:text-reverse/60"
          )}
        >
          <ChevronRight 
            className={cn(
              "h-3 w-3 transition-transform duration-500 ease-out", 
              isExpanded && "rotate-90 text-reverse"
            )} 
          />
        </button>

        <button
          onClick={() => onSelect(node.id)}
          className="flex-1 flex items-center justify-between gap-3 min-w-0 py-2 pr-4 text-left"
        >
          <div className="flex items-center gap-2 min-w-0">
             <span className={cn(
               "truncate text-[12px] font-bold tracking-tight transition-all duration-500",
               isSelected ? "text-ink translate-x-0.5" : "text-ink/40 group-hover/node:text-ink/70"
             )}>
               {node.name}
             </span>
             <UnreadBadge count={node.unreadCount} />
          </div>
          <span className="text-[9px] font-black opacity-30 group-hover/node:opacity-50 transition-all uppercase tracking-widest tabular-nums">
            {node.truthCount}
          </span>
        </button>
      </div>

      <AnimatePresence initial={false}>
        {hasChildren && isExpanded && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden relative ml-3.5"
          >
            <div className="absolute left-0 top-0 bottom-2 w-px bg-reverse/[0.03]" />
            
            <div className="space-y-px pl-0.5">
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
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const RepositoryTruthCard = ({
  truth,
  index,
  onSelect,
}: {
  truth: RepositoryTruth;
  index: number;
  onSelect: () => void;
}) => (
  <motion.button
    initial={{ opacity: 0, y: 25 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ delay: index * 0.05, duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    onClick={onSelect}
    className="w-full px-16 py-4 text-left transition-colors border-b border-reverse/[0.03] relative group hover:bg-reverse/[0.01]"
  >
    <div className="flex items-center gap-4">
      <div className="flex-1 min-w-0 flex items-center gap-3">
        {truth.isUnread && (
          <div className="w-1.5 h-1.5 rounded-full bg-reverse shrink-0" title="未读" />
        )}
        <div className={cn(
          "text-[13px] font-bold tracking-tight leading-tight transition-all duration-500 truncate",
          truth.isUnread ? "text-ink" : "text-ink/40 group-hover:text-ink/70"
        )}>
           {truth.statement}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0 opacity-0 group-hover:opacity-40 transition-all">
         <span className="text-[9px] text-ink font-black tabular-nums">{Math.round(truth.confidence * 100)}%</span>
         <ArrowUpRight className="w-3.5 h-3.5 text-reverse" />
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
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, pointerEvents: "auto" }}
          exit={{ opacity: 0, pointerEvents: "none" }}
          onClick={onClose}
          className="fixed inset-0 bg-canvas/60 backdrop-blur-md z-[60] cursor-zoom-out"
        />

        <motion.div
          initial={{ opacity: 0, y: 50 }}
          animate={{ opacity: 1, y: 0, pointerEvents: "auto" }}
          exit={{ opacity: 0, y: 50, pointerEvents: "none" }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="fixed left-1/2 bottom-0 -translate-x-1/2 w-[95%] max-w-3xl max-h-[95vh] z-[70] isolate flex flex-col"
        >
          <div className="bg-canvas border border-reverse/[0.05] border-b-0 shadow-[0_-20px_100px_rgba(0,0,0,0.1)] rounded-t-2xl flex flex-col h-full transform-gpu relative">
             <div className="flex justify-end p-8 pb-0 shrink-0">
                <button 
                  onClick={onClose}
                  className="p-2 text-ink/20 hover:text-ink transition-all active:scale-90"
                >
                  <X className="w-6 h-6" />
                </button>
             </div>

             <div className="flex-1 overflow-y-auto custom-scrollbar min-h-0 px-16 pb-32 pt-4">
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
      <div className="h-full flex flex-col items-center justify-center space-y-10 animate-in fade-in duration-1000">
        <div className="w-24 h-24 bg-reverse/[0.02] flex items-center justify-center border border-reverse/[0.03]">
            <BookOpen className="h-8 w-8 text-ink/10" />
        </div>
        <div className="text-center space-y-3">
            <div className="text-[16px] font-bold uppercase tracking-[0.4em] text-ink">知识详情</div>
            <p className="text-[11px] text-ink/30 max-w-[280px] mx-auto leading-relaxed font-bold tracking-widest">请从左侧分类树中选择条目以查看标准证据。</p>
        </div>
      </div>
    );
  }

  const highlightedAnswer = truth.answer?.trim();

  return (
    <div className="h-full animate-in fade-in duration-800 space-y-14">
      <header className="space-y-6">
         <div className="flex items-center gap-4 text-ink/30 text-[9px] font-black tracking-[0.3em] uppercase">
            <span className="text-reverse">{questionTypeLabel[truth.questionType ?? "open_ended"]}</span>
            <span className="text-ink/10">|</span>
            <span>{truth.level1TagName}</span>
            <span className="text-ink/10">/</span>
            <span>{truth.level3TagName}</span>
         </div>
         <h1 className="text-[36px] font-bold text-ink tracking-tight leading-[1.1]">{truth.statement}</h1>
      </header>

      <div className="space-y-14">
        <section className="space-y-6">
           <div className="flex items-center gap-4">
              <h4 className="text-[10px] font-black uppercase tracking-[0.5em] text-ink/20 shrink-0">标准定义</h4>
              <div className="h-px bg-reverse/[0.05] flex-1" />
           </div>
           <div className="text-[17px] leading-relaxed text-ink/80 font-medium tracking-tight">
              <MarkdownContent content={truth.answer ?? truth.summary} />
           </div>
        </section>

        {truth.options && truth.options.length > 0 && (
          <section className="space-y-6">
             <h4 className="text-[10px] font-black uppercase tracking-[0.5em] text-ink/20">语境选项</h4>
             <div className="grid gap-3">
                {truth.options.map((option, index) => {
                  const isAnswer = highlightedAnswer && option.trim() === highlightedAnswer;
                  return (
                    <div key={`${truth.id}-${option}`} className={cn(
                      "px-6 py-4 border rounded-sm transition-all text-[14px] flex items-center gap-5",
                      isAnswer ? "bg-reverse text-reverse-text border-reverse" : "bg-canvas border-reverse/[0.06] text-ink/60"
                    )}>
                      <span className={cn("text-[10px] font-black opacity-30", isAnswer && "opacity-100")}>{String.fromCharCode(65 + index)}</span>
                      <span className="flex-1 font-bold tracking-tight">{option}</span>
                    </div>
                  );
                })}
             </div>
          </section>
        )}

        {truth.explanation && (
          <section className="space-y-6 bg-reverse/[0.015] p-8 border border-reverse/[0.03] rounded-xl">
             <h4 className="text-[10px] font-black uppercase tracking-[0.5em] text-ink/40">延伸洞察</h4>
             <div className="text-[14px] leading-relaxed text-ink/60 font-medium">
               <MarkdownContent content={truth.explanation} />
             </div>
          </section>
        )}

        <section className="space-y-6 py-8 border-t border-reverse/[0.05]">
           <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-4 text-ink/40">
                 <Target className="w-4 h-4" />
                 <span className="text-[11px] font-black tracking-widest uppercase">置信度 {Math.round(truth.confidence * 100)}%</span>
              </div>
              <a href={truth.sourceUrl} target="_blank" rel="noreferrer" className="flex items-center gap-3 text-[11px] font-black uppercase tracking-[0.3em] text-ink/45 hover:text-reverse transition-colors">
                 <span>信源链接</span>
                 <ArrowUpRight className="w-4 h-4" />
              </a>
           </div>

           <div className="flex items-center justify-between gap-4 border-t border-reverse/[0.05] pt-6">
              <div className="text-[11px] font-black tracking-[0.2em] text-ink/40 uppercase">
                 {truth.isUnread ? "未读状态" : `已读计数 / ${truth.readCount}`}
              </div>
              <div className="flex items-center gap-8">
                 <button
                   onClick={() => void onDestroy(truth)}
                   disabled={destroying || markingRead}
                   className="text-[12px] font-black tracking-widest uppercase text-ember/60 transition-colors hover:text-ember"
                 >
                   {destroying ? "正在销毁" : "销毁条目"}
                 </button>
                 <button
                   onClick={() => void onMarkRead(truth)}
                   disabled={destroying || markingRead}
                   className="text-[12px] font-black tracking-widest uppercase text-ink/60 hover:text-reverse"
                 >
                   {markingRead ? "同步中" : "验证为已读"}
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
  <div className="flex flex-col gap-1">
    <span className="text-[9px] font-black text-ink/40 uppercase tracking-[0.3em]">{label}</span>
    <span className="text-xl font-bold text-ink tracking-tighter">{value}</span>
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
        <div className="space-y-6 text-center">
          <div className="mx-auto flex h-20 w-20 items-center justify-center bg-reverse/[0.02] border border-reverse/[0.05]">
            <Loader2 className="h-6 w-6 animate-spin text-reverse/10" />
          </div>
          <div className="text-[10px] font-black uppercase tracking-[0.5em] text-ink/20 animate-pulse">正在构建智库...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-xl mx-auto border border-reverse/[0.05] bg-canvas p-16 text-center space-y-8">
        <div className="text-[24px] font-bold text-ink tracking-tight uppercase">连接断开</div>
        <div className="text-[11px] leading-relaxed text-ink/30 font-bold uppercase tracking-widest">{error}</div>
        <button
          onClick={() => void fetchRepository()}
          className="inline-flex items-center gap-4 border border-reverse px-10 py-3 text-[11px] font-black uppercase tracking-widest transition-all hover:bg-reverse hover:text-reverse-text"
        >
          <RefreshCw className="h-4 w-4" />
          尝试重连
        </button>
      </div>
    );
  }

  if (!snapshot || snapshot.summary.truthCount === 0) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center bg-canvas">
        <div className="max-w-md border border-reverse/[0.05] bg-canvas p-20 text-center space-y-10 group">
          <div className="mx-auto w-24 h-24 bg-reverse/[0.01] border border-reverse/[0.03] flex items-center justify-center group-hover:scale-110 transition-transform duration-700">
            <FolderTree className="h-8 w-8 text-ink/5" />
          </div>
          <div className="space-y-4">
             <div className="text-[20px] font-bold text-ink tracking-[0.2em] uppercase">档案库空</div>
             <p className="text-[11px] leading-relaxed text-ink/20 font-bold tracking-widest uppercase">请在采集视图发起知识流以填充分类体系。</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-canvas overflow-hidden flex flex-col relative animate-in fade-in duration-1000">
      <div className="flex-1 flex overflow-hidden">
        <aside className="w-[320px] bg-canvas border-r border-reverse/[0.05] flex flex-col shrink-0 overflow-hidden relative">
          <header className="px-10 pt-10 pb-6 relative">
             <div className="flex items-center gap-3 text-[9px] font-black uppercase tracking-[0.4em] text-ink/45">
               <span>智库</span>
               <span className="text-ink/10">|</span>
               <span>分类体系</span>
             </div>
             <h1 className="text-[28px] font-bold text-ink tracking-tighter mt-3 uppercase">全量仓储</h1>
             <p className="text-ink/40 text-[10px] mt-2 font-black leading-relaxed tracking-[0.3em] uppercase">知识仓库 • REPOSITORY</p>
          </header>

          <div className="flex-1 flex flex-col min-h-0 px-4">
             <div className="px-6 pb-4 flex items-center justify-between border-b border-reverse/[0.03] mb-4">
                <h3 className="text-[10px] font-black text-ink/40 uppercase tracking-[0.4em]">索引节点</h3>
                <div className="text-[10px] font-black text-ink/20 tabular-nums">{snapshot.taxonomy.length}</div>
             </div>
             
             <div className="flex-1 overflow-y-auto custom-scrollbar px-2 pb-10">
                <div className="space-y-1">
                  <button
                    onClick={() => setSelectedTagId(null)}
                    className={cn(
                      "w-full text-left px-5 py-3 transition-all relative group mb-2 rounded-xl",
                      selectedTagId === null ? "bg-reverse/[0.03]" : "hover:bg-reverse/[0.015]"
                    )}
                  >
                    {selectedTagId === null && (
                      <motion.div 
                        layoutId="sidebar-active-pill"
                        className="absolute left-1.5 top-1/2 -translate-y-1/2 w-[2px] h-4 bg-reverse z-10 rounded-full" 
                      />
                    )}
                    <div className="flex items-center justify-between gap-3">
                       <div className="flex min-w-0 items-center gap-3 pl-6">
                         <span className={cn("text-[12px] font-bold tracking-widest uppercase", selectedTagId === null ? "text-ink" : "text-ink/45")}>全量索引</span>
                         <UnreadBadge count={snapshot.summary.unreadCount} />
                       </div>
                       <span className="text-[8px] font-black opacity-30 group-hover:opacity-60 transition-opacity tabular-nums">{snapshot.summary.truthCount}</span>
                    </div>
                  </button>
                  <div className="h-px bg-reverse/[0.03] mx-5 my-4" />
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

        <div className="flex-1 flex flex-col h-screen max-h-screen border-r border-reverse/[0.05] bg-canvas relative">
          <header className="px-16 pt-10 pb-6">
             <div className="flex items-start justify-between gap-10">
                <div className="space-y-4 min-w-0">
                   <h2 className="text-[32px] font-bold text-ink leading-none tracking-tight truncate uppercase">{repositoryTitle}</h2>
                   <div className="flex flex-wrap items-center gap-12">
                      <StatItem label="事实条目" value={selectedTag ? selectedTag.truthCount : snapshot.summary.truthCount} />
                      <StatItem label="待读项" value={selectedTag ? selectedTag.unreadCount : snapshot.summary.unreadCount} />
                      <StatItem label="拓扑分布" value={`${visibleMultipleChoiceCount}:${visibleOpenEndedCount}`} />
                   </div>
                </div>

                <div className="flex items-center gap-6 pt-2 shrink-0">
                   <button
                     onClick={() => void fetchRepository(true)}
                     disabled={refreshing}
                     className="p-3 border border-reverse/[0.08] text-ink/45 hover:text-reverse transition-all hover:bg-reverse/[0.02] rounded-xl"
                   >
                     <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
                   </button>
                   <button
                     onClick={() => void handleExpandSelectedTag()}
                     disabled={!selectedTag || !onExpandTag || expandingTagId !== null}
                     className="px-8 py-3 bg-reverse text-reverse-text text-[11px] font-black uppercase tracking-[0.4em] transition-all hover:translate-y-[-2px] hover:shadow-[0_10px_30px_rgba(0,0,0,0.15)] disabled:opacity-20 rounded-xl"
                   >
                     扩充题库
                   </button>
                </div>
             </div>

             <div className="relative mt-6 group">
                <Search className="pointer-events-none absolute left-0 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/35 transition-colors group-focus-within:text-ink/60" />
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="检索知识引擎中的事实细则..."
                  className="w-full h-12 bg-transparent border-b border-reverse/[0.05] py-4 pl-8 pr-4 text-[13px] text-ink outline-none transition-all placeholder:text-ink/20 focus:border-reverse tracking-widest uppercase font-bold"
                />
             </div>

             {selectedTag === null && (
               <div className="mt-4 text-[9px] font-black uppercase tracking-[0.3em] text-ink/35">请先在左侧选择分类节点以发起扩充协议。</div>
             )}
             {expandError && <div className="mt-4 text-[10px] font-bold text-ember uppercase">{expandError}</div>}
             {!expandError && visibleUnreadCount > 0 && (
               <div className="mt-4 text-[10px] font-black uppercase tracking-[0.4em] text-ink/45">待处理条目 / {visibleUnreadCount}</div>
             )}
          </header>

          <div className="flex-1 overflow-y-auto custom-scrollbar no-scrollbar-at-start">
             <div key={selectedTagId ?? "root"} className="pb-60">
              {filteredTruths.length === 0 ? (
                <div className="py-40 text-center">
                   <div className="text-[11px] font-black text-ink/5 uppercase tracking-[1.5em]">当前拓扑结构下暂无匹配结果</div>
                </div>
              ) : (
                filteredTruths.map((truth, index) => (
                  <RepositoryTruthCard
                    key={truth.id}
                    truth={truth}
                    index={index}
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
