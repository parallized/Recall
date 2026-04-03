import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  Database,
  FolderTree,
  Layers,
  Link2,
  Loader2,
  RefreshCw,
  Search,
  Target,
  Zap,
} from "lucide-react";
import { motion } from "framer-motion";
import { clsx, type ClassValue } from "clsx";
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
};

type RepositorySnapshot = {
  summary: {
    truthCount: number;
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

const formatPercent = (value: number) => `${Math.round(value * 100)}%`;

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
    <div className="space-y-px">
      <button
        onClick={() => onSelect(node.id)}
        className={cn(
          "w-full px-4 py-2 text-left transition-all rounded-[10px] group/node relative",
          selectedTagId === node.id 
            ? "bg-white shadow-[0_4px_12px_rgba(0,0,0,0.03)] text-ink" 
            : "hover:bg-white/50 text-steel/60 hover:text-ink/80"
        )}
        style={{ paddingLeft: `${depth * 14 + 16}px` }}
      >
        {selectedTagId === node.id && (
           <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-accent rounded-full" />
        )}
        <div className="flex items-center justify-between gap-3 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
             <ChevronRight className={cn("h-3 w-3 shrink-0 opacity-20", children.length > 0 && "opacity-40", selectedTagId === node.id && "text-accent opacity-100")} />
             <span className="truncate text-[12px] font-bold tracking-tight">{node.name}</span>
          </div>
          <span className="text-[8px] font-black opacity-20 group-hover/node:opacity-40 transition-opacity uppercase tracking-widest">{node.truthCount}</span>
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
  selected,
  onSelect,
}: {
  truth: RepositoryTruth;
  selected: boolean;
  onSelect: () => void;
}) => (
  <motion.button
    layout
    onClick={onSelect}
    className={cn(
      "w-full px-5 py-4 text-left transition-all border-b border-[#efeff1] last:border-0 relative",
      selected ? "bg-accent/[0.03]" : "hover:bg-silver/10"
    )}
  >
    {selected && <div className="absolute left-0 top-0 h-full w-0.5 bg-accent" />}
    <div className="flex flex-wrap items-center gap-2 mb-2 opacity-40">
       <span className="text-[8px] font-black uppercase tracking-[0.2em]">{questionTypeLabel[truth.questionType ?? "open_ended"]}</span>
       <span className="text-[8px]">• {truth.level3TagName}</span>
    </div>
    <div className={cn("text-[14px] font-bold tracking-tight leading-snug truncate-2-lines", selected ? "text-ink" : "text-ink/80")}>
       {truth.statement}
    </div>
    <div className="mt-2 flex items-center justify-between gap-4">
       <div className="flex items-center gap-2">
         <span className="text-[8px] font-black text-accent uppercase tracking-widest px-1.5 py-0.5 bg-accent/5 rounded-[4px] border border-accent/10">CONFIDENTIAL</span>
         <span className="text-[9px] text-steel/30 font-medium tracking-tight">Confidence {Math.round(truth.confidence * 100)}%</span>
       </div>
    </div>
  </motion.button>
);

const RepositoryDetailPanel = ({ truth }: { truth: RepositoryTruth | null }) => {
  if (!truth) {
    return (
      <div className="h-full flex flex-col items-center justify-center space-y-8 animate-in fade-in duration-1000">
        <div className="w-20 h-20 rounded-[40px] bg-[#f8f9fa] border border-[#efeff1] flex items-center justify-center">
            <BookOpen className="h-7 w-7 text-steel/10" />
        </div>
        <div className="text-center space-y-2">
            <div className="text-[14px] font-bold text-ink">Intelligence Details</div>
            <p className="text-[12px] text-steel/40 max-w-[240px] mx-auto leading-relaxed italic font-serif">Choose a piece of managed knowledge to analyze its standard answer and evidence flow.</p>
        </div>
      </div>
    );
  }

  const highlightedAnswer = truth.answer?.trim();

  return (
    <div className="h-full animate-in fade-in slide-in-from-right-8 duration-700 space-y-10">
      <header className="space-y-4">
         <div className="flex items-center gap-3 text-steel/40 text-[9px] font-black tracking-widest uppercase">
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
        <section className="space-y-4 prose prose-neutral prose-sm max-w-none">
           <div className="flex items-center gap-3">
              <div className="h-px bg-[#efeff1] flex-1" />
              <h4 className="text-[10px] font-black uppercase tracking-[0.4em] text-steel/30 shrink-0">STANDARD_ANSWER</h4>
              <div className="h-px bg-[#efeff1] flex-1" />
           </div>
           <div className="text-[15px] leading-relaxed text-ink/80 font-serif">
              {truth.answer ?? truth.summary}
           </div>
        </section>

        {truth.options && truth.options.length > 0 && (
          <section className="space-y-4">
             <h4 className="text-[10px] font-black uppercase tracking-[0.4em] text-steel/30">AVAILABLE_OPTIONS</h4>
             <div className="grid gap-2">
                {truth.options.map((option, index) => {
                  const isAnswer = highlightedAnswer && option.trim() === highlightedAnswer;
                  return (
                    <div key={`${truth.id}-${option}`} className={cn(
                      "px-5 py-4 rounded-[14px] border transition-all text-[13px] flex items-center gap-4",
                      isAnswer ? "bg-accent/[0.03] border-accent/20 text-accent" : "bg-white border-[#efeff1] text-ink/70"
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
          <section className="space-y-4 bg-[#f8f9fa] rounded-[24px] p-6 border border-[#efeff1]">
             <h4 className="text-[10px] font-black uppercase tracking-[0.4em] text-steel/30">INTELLIGENCE_CONTEXT</h4>
             <p className="text-[13px] leading-relaxed text-steel/80 italic font-serif">{truth.explanation}</p>
          </section>
        )}

        <section className="space-y-4 py-6 border-t border-[#efeff1]">
           <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 text-steel/40">
                 <Target className="w-3 h-3" />
                 <span className="text-[10px] font-bold">Confidence {Math.round(truth.confidence * 100)}%</span>
              </div>
              <a href={truth.sourceUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-[#23434f] hover:text-accent transition-colors">
                 <span>Explore Origin</span>
                 <ArrowUpRight className="w-3 h-3" />
              </a>
           </div>
        </section>
      </div>
    </div>
  );
};

const StatItem = ({ label, value }: { label: string, value: string | number }) => (
  <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-silver/10 border border-line/5 transition-all">
    <span className="text-[8px] font-black text-steel/30 uppercase tracking-[0.2em]">{label}</span>
    <span className="text-[12px] font-bold text-ink/80">{value}</span>
  </div>
);

export const RepositoryView = ({ apiBaseUrl, refreshKey }: RepositoryViewProps) => {
  const [snapshot, setSnapshot] = useState<RepositorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [selectedTruthId, setSelectedTruthId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

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

  useEffect(() => {
    if (filteredTruths.length === 0) {
      setSelectedTruthId(null);
      return;
    }

    if (!selectedTruthId || !filteredTruths.some((truth) => truth.id === selectedTruthId)) {
      setSelectedTruthId(filteredTruths[0]!.id);
    }
  }, [filteredTruths, selectedTruthId]);

  const selectedTruth = filteredTruths.find((truth) => truth.id === selectedTruthId) ?? null;
  const repositoryTitle = buildTagPath(selectedTag, nodeById);

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="space-y-4 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[32px] bg-ink/5 border border-[#efeff1] shadow-sm">
            <Loader2 className="h-6 w-6 animate-spin text-accent" />
          </div>
          <div className="text-[10px] font-black uppercase tracking-[0.4em] text-steel/20 animate-pulse">Building Intelligence Repository</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-xl mx-auto rounded-[32px] border border-ember/10 bg-ember/[0.02] p-10 text-center space-y-6">
        <div className="text-[20px] font-bold text-ink tracking-tight">Repository Unavailable</div>
        <div className="text-[13px] leading-relaxed text-steel/60">{error}</div>
        <button
          onClick={() => void fetchRepository()}
          className="inline-flex items-center gap-3 rounded-full bg-ink text-white px-6 py-2.5 text-[11px] font-bold transition-all hover:scale-[1.05]"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Attempt Reconnect
        </button>
      </div>
    );
  }

  if (!snapshot || snapshot.summary.truthCount === 0) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="max-w-md rounded-[40px] border border-dashed border-[#efeff1] bg-[#fcfcfc] p-12 text-center space-y-8">
          <div className="mx-auto w-24 h-24 rounded-[40px] bg-[#f8f9fa] border border-[#efeff1] flex items-center justify-center">
            <FolderTree className="h-8 w-8 text-steel/10" />
          </div>
          <div className="space-y-3">
             <div className="text-[22px] font-bold text-ink tracking-tighter">Repository Empty</div>
             <p className="text-[12px] leading-relaxed text-steel/40 font-medium">Please initiate a Question Flow in the Collection view. Validated intelligence will automatically populate this taxonomy map.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white animate-in fade-in duration-700">
      <div className="grid lg:grid-cols-[320px_minmax(0,1fr)] min-h-screen">
        {/* Left: Heptabase Sidebar Style */}
        <div className="bg-[#f8f9fa] border-r border-[#efeff1] px-8 pt-8 pb-32 space-y-10 overflow-hidden flex flex-col">
          <header className="space-y-4">
             <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.3em] text-steel/30">
               <span>Repository</span>
               <span>/</span>
               <span>Taxonomy</span>
             </div>
             <h1 className="text-2xl font-bold text-ink tracking-tighter mb-1">智库仓储</h1>
             <p className="text-steel/50 text-[11px] font-medium leading-relaxed">基于三级标签树管理的结构化事实库</p>
          </header>

          <div className="flex-1 space-y-8 overflow-hidden flex flex-col min-h-0">
             <div className="space-y-4 flex flex-col min-h-0">
                <div className="flex items-center justify-between px-1">
                   <h3 className="text-[10px] font-black text-steel/20 uppercase tracking-[0.2em]">INTELLIGENCE_MAP</h3>
                </div>
                <div className="flex-1 overflow-y-auto space-y-0.5 pr-2 scrollbar-hide">
                  <button
                    onClick={() => setSelectedTagId(null)}
                    className={cn(
                      "w-full text-left px-4 py-3 rounded-[12px] transition-all relative group",
                      selectedTagId === null ? "bg-white shadow-sm" : "hover:bg-white/40"
                    )}
                  >
                    {selectedTagId === null && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-accent" />}
                    <div className="flex items-center justify-between gap-3">
                       <span className={cn("text-[13px] font-bold", selectedTagId === null ? "text-ink" : "text-ink/40")}>全部知识</span>
                       <span className="text-[8px] font-black opacity-20 uppercase tracking-widest">{snapshot.summary.truthCount}</span>
                    </div>
                  </button>
                  <div className="h-px bg-[#efeff1] mx-4 my-2" />
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
        </div>

        {/* Right: Heptabase Workspace Style */}
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_480px] min-h-screen bg-white">
           {/* Center Pane: List Feed */}
           <div className="border-r border-[#efeff1] flex flex-col h-screen max-h-screen">
              <header className="px-10 pt-10 pb-6 space-y-8 border-b border-[#efeff1]/60">
                 <div className="space-y-1">
                    <h2 className="text-[32px] font-bold text-ink tracking-tighter leading-tight truncate">{repositoryTitle}</h2>
                    <div className="flex items-center gap-4 pt-2">
                       <StatItem label="TOTAL_CARDS" value={snapshot.summary.truthCount} />
                       <StatItem label="TAGS" value={snapshot.summary.level3TagCount} />
                       <StatItem label="QTYPE" value={`${snapshot.summary.multipleChoiceCount}/${snapshot.summary.openEndedCount}`} />
                    </div>
                 </div>

                 <div className="relative">
                    <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-steel/30" />
                    <input
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      placeholder="Filter managed knowledge..."
                      className="w-full rounded-[16px] border border-[#efeff1] bg-[#fcfcfc] py-3 pl-11 pr-4 text-[13px] text-ink outline-none transition-all placeholder:text-steel/20 focus:bg-white focus:shadow-sm"
                    />
                 </div>
              </header>

              <div className="flex-1 overflow-y-auto scrollbar-hide">
                 <div className="pb-40">
                  {filteredTruths.length === 0 ? (
                    <div className="py-24 text-center space-y-4">
                       <div className="text-[10px] font-black text-steel/10 uppercase tracking-[1em]">NO_DATA_MATCHED</div>
                    </div>
                  ) : (
                    filteredTruths.map((truth) => (
                      <RepositoryTruthCard
                        key={truth.id}
                        truth={truth}
                        selected={truth.id === selectedTruthId}
                        onSelect={() => setSelectedTruthId(truth.id)}
                      />
                    ))
                  )}
                 </div>
              </div>
           </div>

           {/* Right Pane: Reading Viewer */}
           <div className="bg-[#fcfcfc]/30 h-screen max-h-screen overflow-y-auto overflow-x-hidden scrollbar-hide hidden xl:block">
              <div className="p-12 pb-40">
                 <RepositoryDetailPanel truth={selectedTruth} />
              </div>
           </div>
        </div>
      </div>
    </div>
  );
};

export default RepositoryView;
