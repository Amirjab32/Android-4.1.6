import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Trash2, Check, Clock, Loader2, MessageSquare, Play, Pause,
  FileText, ChevronDown, Copy, CheckSquare, Square, Pencil, Target,
} from "lucide-react";
import { Task, RecurringActivity, TaskStore } from "@/lib/store";
import { toShamsiShort, getGregorianToday, dayDiff, toPersianDigits } from "@/lib/shamsi";
import { useThemeStyles } from "@/lib/useThemeStyles";
import {
  parseDescriptionLines,
  activateSubtask,
  toggleSubtaskCompletion,
  updateSubtaskManualMinutes,
  reconcileEditedDescriptionSubtasks,
  getSubtaskLiveSeconds,
  isMainTimerRunning,
  parseFlexibleNumberInput,
} from "@/lib/subtaskTiming";

interface Props {
  task: Task;
  onStatusChange: (task: Task, status: "todo" | "in_progress" | "done") => void;
  onDelete: (id: string) => void;
  activities?: RecurringActivity[];
  showTimer?: boolean;
}

const PRIORITY_COLORS: Record<string, string> = {
  low: "#10b981",
  medium: "#f59e0b",
  high: "#f43f5e",
};

const PRIORITY_LABELS: Record<string, string> = {
  low: "کم",
  medium: "متوسط",
  high: "زیاد",
};

const STATUS_CONFIG = {
  todo: {
    borderColor: "rgba(148,163,184,0.35)",
    bgAccent: "rgba(148,163,184,0.06)",
    badgeBg: "rgba(148,163,184,0.15)",
    badgeColor: "#94a3b8",
    badgeLabel: "در انتظار",
    icon: Clock,
    iconColor: "#94a3b8",
    leftBarColor: "#94a3b8",
  },
  in_progress: {
    borderColor: "rgba(251,191,36,0.45)",
    bgAccent: "rgba(251,191,36,0.07)",
    badgeBg: "rgba(251,191,36,0.15)",
    badgeColor: "#fbbf24",
    badgeLabel: "در حال انجام",
    icon: Loader2,
    iconColor: "#fbbf24",
    leftBarColor: "#fbbf24",
  },
  done: {
    borderColor: "rgba(52,211,153,0.4)",
    bgAccent: "rgba(52,211,153,0.07)",
    badgeBg: "rgba(52,211,153,0.15)",
    badgeColor: "#34d399",
    badgeLabel: "انجام شد",
    icon: Check,
    iconColor: "#34d399",
    leftBarColor: "#34d399",
  },
};

function formatTimer(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${toPersianDigits(h)}:${toPersianDigits(pad(m))}:${toPersianDigits(pad(s))}`;
  return `${toPersianDigits(pad(m))}:${toPersianDigits(pad(s))}`;
}

function formatSubtaskDuration(seconds: number): string {
  if (seconds < 60) {
    return `${toPersianDigits(seconds)}s`;
  }
  const roundedMins = Math.round(seconds / 60);
  if (roundedMins >= 60) {
    const h = Math.floor(roundedMins / 60);
    const m = roundedMins % 60;
    if (m > 0) {
      return `${toPersianDigits(h)}h ${toPersianDigits(m)}m`;
    }
    return `${toPersianDigits(h)}h`;
  }
  return `${toPersianDigits(roundedMins)}m`;
}

export default function TaskItem({ task, onStatusChange, onDelete, activities = [], showTimer = true }: Props) {
  const { fg, fgMuted, cardBg } = useThemeStyles();
  const [hovered, setHovered] = useState(false);
  const [displaySeconds, setDisplaySeconds] = useState(task.elapsed_seconds || 0);
  const [showDescription, setShowDescription] = useState(false);
  const [copiedDesc, setCopiedDesc] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const today = getGregorianToday();
  const isOverdue =
    task.status !== "done" && task.scheduled_date && task.scheduled_date < today;
  const overdueDays = isOverdue ? Math.abs(dayDiff(task.scheduled_date!, today)) : 0;
  const status: "todo" | "in_progress" | "done" =
    task.status === "in_progress" || task.status === "done" ? task.status : "todo";
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.todo;
  const StatusIcon = cfg.icon;
  const iconClass =
    status === "in_progress" ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5";
  const activity = activities.find((a) => a.id === task.activity_id);

  const [isEditingDesc, setIsEditingDesc] = useState(false);
  const [editDescText, setEditDescText] = useState(task.description || "");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [editingSubtaskKey, setEditingSubtaskKey] = useState<string | null>(null);
  const [editMinutesValue, setEditMinutesValue] = useState("");
  const [holdingSubtaskKey, setHoldingSubtaskKey] = useState<string | null>(null);
  const holdStateRef = useRef<{
    key: string;
    pointerId: number;
    startX: number;
    startY: number;
    timerId: ReturnType<typeof setTimeout>;
  } | null>(null);
  const suppressContextUntilRef = useRef<number>(0);
  const hasDescription = Boolean(task.description && task.description.trim().length > 0);
  const mainTimerRunning = isMainTimerRunning(task);

  useEffect(() => {
    setEditDescText(task.description || "");
  }, [task.description]);

  useEffect(() => {
    if (status === "in_progress" && task.timer_started_at) {
      const base = task.elapsed_seconds || 0;
      const startedAt = task.timer_started_at;
      const tick = () => {
        const now = Date.now();
        const elapsed = Math.floor((now - startedAt) / 1000);
        setDisplaySeconds(base + elapsed);
        setNowMs(now);
      };
      tick();
      intervalRef.current = setInterval(tick, 1000);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
      setDisplaySeconds(task.elapsed_seconds || 0);
      setNowMs(Date.now());
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [status, task.timer_started_at, task.elapsed_seconds]);

  const parsedLines = parseDescriptionLines(task.description || "");
  const checkableCount = parsedLines.filter((l) => l.isCheckable).length;
  const checkedCount = parsedLines.filter((l) => l.isCheckable && l.isChecked).length;
  const activeLine = task.active_subtask_key
    ? parsedLines.find((l) => l.isCheckable && l.subtaskKey === task.active_subtask_key)
    : undefined;

  const cancelSubtaskHold = () => {
    if (holdStateRef.current) {
      clearTimeout(holdStateRef.current.timerId);
      holdStateRef.current = null;
    }
    setHoldingSubtaskKey(null);
  };

  useEffect(() => {
    return () => {
      if (holdStateRef.current) {
        clearTimeout(holdStateRef.current.timerId);
        holdStateRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!showDescription || isEditingDesc) {
      cancelSubtaskHold();
    }
  }, [showDescription, isEditingDesc]);

  const handleToggleChecklist = (lineIndex: number) => {
    const patch = toggleSubtaskCompletion(task, lineIndex, Date.now());
    if (!patch) return;
    TaskStore.update(task.id, patch);
  };

  const handleActivateSubtask = (subtaskKey: string, subtaskText: string) => {
    const patch = activateSubtask(task, subtaskKey, subtaskText, Date.now());
    TaskStore.update(task.id, patch);
  };

  const startSubtaskHold = (
    e: React.PointerEvent<HTMLDivElement>,
    subtaskKey: string,
    subtaskText: string,
    isChecked: boolean
  ) => {
    if (status === "done" || isChecked || editingSubtaskKey === subtaskKey) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;

    cancelSubtaskHold();

    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    setHoldingSubtaskKey(subtaskKey);

    const timerId = setTimeout(() => {
      if (!holdStateRef.current || holdStateRef.current.key !== subtaskKey) return;
      holdStateRef.current = null;
      setHoldingSubtaskKey(null);
      suppressContextUntilRef.current = Date.now() + 500;
      try {
        if (typeof navigator !== "undefined" && navigator.vibrate) {
          navigator.vibrate(15);
        }
      } catch {
        // Ignore vibration errors on unsupported browsers
      }
      handleActivateSubtask(subtaskKey, subtaskText);
    }, 500);

    holdStateRef.current = {
      key: subtaskKey,
      pointerId,
      startX,
      startY,
      timerId,
    };
  };

  const moveSubtaskHold = (e: React.PointerEvent<HTMLDivElement>) => {
    const current = holdStateRef.current;
    if (!current || current.pointerId !== e.pointerId) return;
    const dx = e.clientX - current.startX;
    const dy = e.clientY - current.startY;
    if (Math.hypot(dx, dy) > 8) {
      cancelSubtaskHold();
    }
  };

  const endSubtaskHold = (e: React.PointerEvent<HTMLDivElement>) => {
    const current = holdStateRef.current;
    if (current && current.pointerId === e.pointerId) {
      cancelSubtaskHold();
    }
  };

  const startEditingMinutes = (subtaskKey: string, currentSeconds: number | null) => {
    const initialMins =
      currentSeconds !== null && currentSeconds > 0
        ? String(Math.round(currentSeconds / 60))
        : "0";
    setEditingSubtaskKey(subtaskKey);
    setEditMinutesValue(initialMins);
  };

  const commitEditingMinutes = (subtaskKey: string, subtaskText: string, isChecked: boolean) => {
    const parsed = parseFlexibleNumberInput(editMinutesValue);
    if (parsed !== null) {
      const patch = updateSubtaskManualMinutes(
        task,
        subtaskKey,
        subtaskText,
        isChecked,
        parsed,
        Date.now()
      );
      TaskStore.update(task.id, patch);
    }
    setEditingSubtaskKey(null);
    setEditMinutesValue("");
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -30 }}
      onClick={() => setShowDescription((prev) => !prev)}
      className="relative flex flex-col overflow-hidden rounded-xl px-4 py-3 transition-colors cursor-pointer select-none"
      style={{
        border: `1px solid ${activity ? `${activity.color}40` : isOverdue ? "rgba(244,63,94,0.4)" : showDescription ? "rgba(129,140,248,0.5)" : cfg.borderColor}`,
        backgroundColor: showDescription
          ? "rgba(99,102,241,0.06)"
          : hovered
            ? cfg.bgAccent
            : status === "todo" && !isOverdue
              ? cardBg
              : cfg.bgAccent,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className="absolute right-0 top-0 h-full w-1 rounded-r-xl"
        style={{ backgroundColor: activity ? activity.color : isOverdue ? "#f43f5e" : cfg.leftBarColor }}
      />
      <div className="flex items-center gap-3 w-full">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onStatusChange(task, status === "done" ? "todo" : "done");
          }}
          className="group flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border-2 transition-all hover:scale-110 cursor-pointer"
          style={{
            borderColor: status === "done"
              ? "#10b981"
              : activity
                ? activity.color
                : isOverdue
                  ? "#f43f5e"
                  : "rgba(148,163,184,0.5)",
            backgroundColor: status === "done" ? "#10b981" : "transparent",
          }}
        >
          {status === "done" ? (
            <Check className="h-3.5 w-3.5 text-white stroke-[3px]" />
          ) : (
            <Check className="h-3 w-3 text-emerald-500 opacity-0 group-hover:opacity-100 transition-opacity stroke-[3px]" />
          )}
        </button>
        <span
          className="h-2 w-2 flex-shrink-0 rounded-full"
          style={{ backgroundColor: PRIORITY_COLORS[task.priority] }}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className="truncate text-sm font-medium"
            style={{
              color: status === "done" ? fgMuted : fg,
              textDecoration: status === "done" ? "line-through" : "none",
              opacity: status === "done" ? 0.6 : 1,
            }}
          >
            {task.title}
            {activity && (
              <span className="mr-1 text-xs opacity-70" style={{ color: activity.color }}>
                [{activity.name}]
              </span>
            )}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium"
              style={{
                backgroundColor: isOverdue ? "rgba(244,63,94,0.12)" : cfg.badgeBg,
                color: isOverdue ? "#f87171" : cfg.badgeColor,
              }}
            >
              <StatusIcon className={iconClass} />
              {isOverdue ? `${toPersianDigits(overdueDays)} روز تأخیر` : cfg.badgeLabel}
            </span>
            {task.scheduled_date && (
              <span className="text-xs" style={{ color: fgMuted }}>
                {toShamsiShort(task.scheduled_date)}
              </span>
            )}
            <span
              className="rounded-md px-1.5 py-0.5 text-[11px] font-medium"
              style={{
                backgroundColor: `${PRIORITY_COLORS[task.priority]}18`,
                color: PRIORITY_COLORS[task.priority],
              }}
            >
              {PRIORITY_LABELS[task.priority]}
            </span>
            {showTimer && status !== "done" && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onStatusChange(task, status === "in_progress" ? "todo" : "in_progress");
                }}
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium transition-all hover:bg-amber-500/15 cursor-pointer"
                style={{
                  backgroundColor: status === "in_progress" ? "rgba(251,191,36,0.15)" : "rgba(128,128,128,0.08)",
                  color: status === "in_progress" ? "#fbbf24" : fgMuted,
                  border: status === "in_progress" ? "1px solid rgba(251,191,36,0.3)" : "1px solid transparent",
                }}
                title={status === "in_progress" ? "توقف تایمر" : "شروع تایمر"}
              >
                {status === "in_progress" ? (
                  <>
                    <Pause className="h-3 w-3 animate-pulse text-amber-400" />
                    <span>درحال انجام ({formatTimer(displaySeconds)})</span>
                  </>
                ) : (
                  <>
                    <Play className="h-3 w-3 text-indigo-400" />
                    <span>شروع کار {displaySeconds > 0 ? `(${formatTimer(displaySeconds)})` : ""}</span>
                  </>
                )}
              </button>
            )}
            {showTimer && status === "done" && displaySeconds > 0 && (
              <span
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-mono font-medium"
                style={{
                  backgroundColor: "rgba(128,128,128,0.1)",
                  color: fgMuted,
                }}
              >
                ⏱ {formatTimer(displaySeconds)}
              </span>
            )}
            {task.tags && task.tags.length > 0 && task.tags.map((t) => (
              <span
                key={t}
                className="rounded-md px-1.5 py-0.5 text-[11px] font-medium"
                style={{ backgroundColor: "rgba(99,102,241,0.12)", color: "#818cf8" }}
              >
                #{t}
              </span>
            ))}
            {task.comment && (
              <span className="text-[11px]" style={{ color: fgMuted }} title={task.comment}>
                <MessageSquare className="inline h-3 w-3 mr-0.5" />
                {task.comment.length > 20 ? task.comment.slice(0, 20) + "..." : task.comment}
              </span>
            )}
            {hasDescription && (
              <span
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium"
                style={{
                  backgroundColor: showDescription ? "rgba(99,102,241,0.22)" : "rgba(99,102,241,0.09)",
                  color: showDescription ? "#a5b4fc" : "#818cf8",
                  border: showDescription ? "1px solid rgba(129,140,248,0.35)" : "1px solid transparent",
                }}
              >
                <FileText className="h-3 w-3" />
                <span>توضیحات</span>
                {checkableCount > 0 && (
                  <span className="text-[10px] opacity-80 mr-0.5">
                    ({toPersianDigits(checkedCount)}/{toPersianDigits(checkableCount)})
                  </span>
                )}
              </span>
            )}
            {activeLine && (
              <span
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium max-w-[180px]"
                style={{
                  backgroundColor: mainTimerRunning ? "rgba(251,191,36,0.16)" : "rgba(99,102,241,0.14)",
                  color: mainTimerRunning ? "#fbbf24" : "#a5b4fc",
                  border: mainTimerRunning ? "1px solid rgba(251,191,36,0.3)" : "1px solid rgba(129,140,248,0.25)",
                }}
                title={`تمرکز فعال: ${activeLine.text}`}
              >
                <Target className={`h-3 w-3 flex-shrink-0 ${mainTimerRunning ? "animate-pulse" : ""}`} />
                <span className="truncate">{activeLine.text}</span>
                {activeLine.subtaskKey && (
                  <span className="font-mono text-[10px] flex-shrink-0">
                    ({formatTimer(getSubtaskLiveSeconds(task, activeLine.subtaskKey, nowMs) ?? 0)})
                  </span>
                )}
              </span>
            )}
          </div>
        </div>

        {/* Action Buttons in Corner */}
        <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => setShowDescription((prev) => !prev)}
            className="flex h-8 w-8 items-center justify-center rounded-lg transition-all cursor-pointer hover:bg-white/10"
            style={{
              backgroundColor: showDescription
                ? "rgba(99,102,241,0.2)"
                : hasDescription
                  ? "rgba(99,102,241,0.12)"
                  : "rgba(255,255,255,0.04)",
              color: showDescription
                ? "#a5b4fc"
                : hasDescription
                  ? "#818cf8"
                  : fgMuted,
            }}
            title={showDescription ? "بستن توضیحات" : hasDescription ? "مشاهده توضیحات و تمرین‌ها" : "افزودن توضیحات"}
          >
            <ChevronDown
              className={`h-4.5 w-4.5 transition-transform duration-300 ease-in-out ${
                showDescription ? "rotate-180 text-indigo-400" : ""
              }`}
            />
          </button>
          
          <button
            onClick={() => onDelete(task.id)}
            className="flex h-8 w-8 items-center justify-center rounded-lg transition-all cursor-pointer"
            style={{ opacity: hovered ? 1 : 0.65, color: fgMuted }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.backgroundColor = "rgba(244,63,94,0.12)";
              (e.currentTarget as HTMLElement).style.color = "#f87171";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
              (e.currentTarget as HTMLElement).style.color = fgMuted;
            }}
            title="حذف تسک"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {showDescription && (
          <motion.div
            initial={{ opacity: 0, height: 0, marginTop: 0 }}
            animate={{ opacity: 1, height: "auto", marginTop: 10 }}
            exit={{ opacity: 0, height: 0, marginTop: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
            className="w-full overflow-hidden rounded-xl p-3 text-xs leading-relaxed"
            style={{
              backgroundColor: "rgba(0,0,0,0.28)",
              border: "1px solid rgba(255,255,255,0.09)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-2 mb-2 border-b border-white/10 text-[11px] font-medium">
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 text-indigo-400">
                  <FileText className="h-3.5 w-3.5" />
                  <span>توضیحات و تمرین‌های تسک</span>
                </span>
                {checkableCount > 0 && (
                  <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    {toPersianDigits(checkedCount)} از {toPersianDigits(checkableCount)} تمرین انجام شد
                  </span>
                )}
              </div>
              
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setIsEditingDesc((prev) => !prev)}
                  className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-white transition-colors px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 cursor-pointer"
                  title="ویرایش متن توضیحات"
                >
                  <Pencil className="h-3 w-3 text-indigo-400" />
                  <span>{isEditingDesc ? "مشاهده" : "ویرایش"}</span>
                </button>
                {hasDescription && (
                  <button
                    type="button"
                    onClick={() => {
                      if (task.description) {
                        navigator.clipboard.writeText(task.description);
                        setCopiedDesc(true);
                        setTimeout(() => setCopiedDesc(false), 2000);
                      }
                    }}
                    className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-white transition-colors px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 cursor-pointer"
                  >
                    {copiedDesc ? (
                      <>
                        <Check className="h-3 w-3 text-emerald-400" />
                        <span className="text-emerald-400">کپی شد</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" />
                        <span>کپی متن</span>
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>

            {isEditingDesc ? (
              <div className="space-y-2 pt-1" dir="rtl">
                <textarea
                  value={editDescText}
                  onChange={(e) => setEditDescText(e.target.value)}
                  placeholder="توضیحات، ویدیوها و تمرین‌ها را بنویسید (خطوط با • به چک‌لیست تبدیل می‌شوند)..."
                  rows={4}
                  className="w-full rounded-lg border border-white/10 bg-black/30 p-2.5 text-xs text-right leading-relaxed focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  style={{ color: fg }}
                />
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setEditDescText(task.description || "");
                      setIsEditingDesc(false);
                    }}
                    className="px-2.5 py-1 text-[11px] rounded bg-white/5 hover:bg-white/10 text-gray-400"
                  >
                    انصراف
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const patch = reconcileEditedDescriptionSubtasks(task, editDescText, Date.now());
                      TaskStore.update(task.id, patch);
                      setIsEditingDesc(false);
                    }}
                    className="px-3 py-1 text-[11px] font-semibold rounded bg-indigo-600 hover:bg-indigo-700 text-white shadow"
                  >
                    ذخیره توضیحات
                  </button>
                </div>
              </div>
            ) : hasDescription ? (
              <div className="text-right font-sans select-text text-xs leading-6 space-y-0.5" dir="rtl">
                {parsedLines.map((line) => {
                  if (line.isCheckable && line.subtaskKey) {
                    const key = line.subtaskKey;
                    const isActive = task.active_subtask_key === key;
                    const liveSeconds = getSubtaskLiveSeconds(task, key, nowMs);
                    const isEditingMins = editingSubtaskKey === key;
                    const hasSavedOrLiveTime = liveSeconds !== null && liveSeconds > 0;
                    const isHolding = holdingSubtaskKey === key;

                    return (
                      <div
                        key={`${line.originalIndex}-${key}`}
                        onPointerDown={(e) => startSubtaskHold(e, key, line.text, line.isChecked)}
                        onPointerMove={moveSubtaskHold}
                        onPointerUp={endSubtaskHold}
                        onPointerCancel={endSubtaskHold}
                        onPointerLeave={endSubtaskHold}
                        onContextMenu={(e) => {
                          if (
                            (!line.isChecked && status !== "done") ||
                            isHolding ||
                            Date.now() < suppressContextUntilRef.current
                          ) {
                            e.preventDefault();
                          }
                        }}
                        className={`group relative overflow-hidden flex items-start gap-2 py-1 px-2 rounded-lg transition-colors select-none touch-pan-y ${
                          isActive
                            ? mainTimerRunning
                              ? "bg-amber-500/[0.06]"
                              : "bg-indigo-500/[0.06]"
                            : "hover:bg-white/[0.04]"
                        }`}
                        style={{
                          WebkitTouchCallout: "none",
                          WebkitUserSelect: "none",
                          userSelect: "none",
                        }}
                      >
                        {isActive && (
                          <span
                            aria-hidden="true"
                            className={`pointer-events-none absolute right-0 top-1 bottom-1 w-[2px] rounded-full ${
                              mainTimerRunning ? "bg-amber-400" : "bg-indigo-400"
                            }`}
                          />
                        )}
                        {isHolding && (
                          <motion.span
                            aria-hidden="true"
                            initial={{ scaleX: 0 }}
                            animate={{ scaleX: 1 }}
                            transition={{ duration: 0.5, ease: "linear" }}
                            className={`pointer-events-none absolute inset-0 origin-right ${
                              isActive ? "bg-white/[0.08]" : "bg-amber-400/[0.12]"
                            }`}
                          />
                        )}

                        <button
                          type="button"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            cancelSubtaskHold();
                            handleToggleChecklist(line.originalIndex);
                          }}
                          aria-label={
                            line.isChecked
                              ? `برداشتن تیک ${line.text}`
                              : `تکمیل ${line.text}`
                          }
                          className="relative z-10 mt-0.5 flex-shrink-0 cursor-pointer select-none"
                        >
                          {line.isChecked ? (
                            <CheckSquare className="h-4 w-4 text-emerald-400 fill-emerald-500/20" />
                          ) : (
                            <Square className="h-4 w-4 text-gray-500 group-hover:text-gray-300" />
                          )}
                        </button>

                        <span
                          className={`relative z-10 flex-1 min-w-0 text-xs leading-5 transition-all ${
                            line.isChecked
                              ? "line-through opacity-60 text-emerald-200/70"
                              : ""
                          }`}
                          style={{ color: line.isChecked ? fgMuted : fg }}
                        >
                          {line.text}
                        </span>

                        {(isEditingMins || isActive || hasSavedOrLiveTime) && (
                          <div
                            className="relative z-10 flex items-center flex-shrink-0 self-center"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {isEditingMins ? (
                              <form
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  commitEditingMinutes(key, line.text, line.isChecked);
                                }}
                                className="flex items-center gap-1"
                              >
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  dir="ltr"
                                  value={editMinutesValue}
                                  onChange={(e) => setEditMinutesValue(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Escape") {
                                      setEditingSubtaskKey(null);
                                      setEditMinutesValue("");
                                    }
                                  }}
                                  onBlur={() => commitEditingMinutes(key, line.text, line.isChecked)}
                                  autoFocus
                                  aria-label={`ویرایش دقیقه ${line.text}`}
                                  className="w-11 rounded border border-indigo-400/50 bg-black/40 px-1 py-0.5 text-center font-mono text-[11px] outline-none focus:ring-1 focus:ring-indigo-400"
                                  style={{ color: fg }}
                                />
                                <span className="text-[10px]" style={{ color: fgMuted }}>
                                  دقیقه
                                </span>
                              </form>
                            ) : isActive && mainTimerRunning ? (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  startEditingMinutes(key, liveSeconds);
                                }}
                                aria-label={`زمان زنده ${line.text}، کلیک برای ویرایش دقیقه`}
                                title="کلیک برای ویرایش دستی (به دقیقه)"
                                className="font-mono text-[11px] font-medium tabular-nums text-amber-300/95 hover:text-amber-200 transition-colors cursor-pointer px-1"
                              >
                                {formatTimer(liveSeconds ?? 0)}
                              </button>
                            ) : isActive ? (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  startEditingMinutes(key, liveSeconds);
                                }}
                                aria-label={`زمان ${line.text}، کلیک برای ویرایش دقیقه`}
                                title="کلیک برای ویرایش دستی (به دقیقه)"
                                className="font-mono text-[11px] font-medium tabular-nums text-indigo-300/90 hover:text-indigo-200 transition-colors cursor-pointer px-1"
                              >
                                {formatSubtaskDuration(liveSeconds ?? 0)}
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  startEditingMinutes(key, liveSeconds);
                                }}
                                aria-label={`زمان ${line.text}، کلیک برای ویرایش دقیقه`}
                                title="کلیک برای ویرایش دستی (به دقیقه)"
                                className="font-mono text-[10px] font-normal tabular-nums opacity-50 hover:opacity-90 transition-opacity cursor-pointer px-0.5"
                                style={{ color: fgMuted }}
                              >
                                {formatSubtaskDuration(liveSeconds ?? 0)}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  }

                  if (!line.raw.trim()) {
                    return <div key={line.originalIndex} className="h-1.5" />;
                  }

                  const isHeader =
                    line.raw.trim().endsWith(":") ||
                    line.raw.trim().startsWith("📁") ||
                    line.raw.trim().startsWith("🎸") ||
                    line.raw.trim().startsWith("🎵") ||
                    line.raw.trim().startsWith("📄");

                  return (
                    <div
                      key={line.originalIndex}
                      className={`px-1 ${
                        isHeader
                          ? "font-bold text-indigo-300 pt-2 pb-0.5 text-[11px]"
                          : "py-0.5 text-xs opacity-90"
                      }`}
                      style={{ color: isHeader ? "#a5b4fc" : fg }}
                    >
                      {line.raw}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex items-center justify-between text-xs py-2 px-1 text-gray-400">
                <span>هنوز توضیح یا تمرینی برای این تسک ثبت نشده است.</span>
                <button
                  type="button"
                  onClick={() => setIsEditingDesc(true)}
                  className="text-indigo-400 hover:text-indigo-300 text-[11px] font-semibold underline cursor-pointer"
                >
                  + افزودن توضیحات
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
