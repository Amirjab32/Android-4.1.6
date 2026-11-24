export type SubtaskTimingMode = "active" | "delta" | "manual";

export interface SubtaskTimingEntry {
  text: string;
  spent_seconds: number | null;
  completed: boolean;
  completed_at: number | null;
  mode: SubtaskTimingMode;
  timer_was_running?: boolean;
  previous_checkpoint_seconds?: number;
  applied_checkpoint_seconds?: number;
  pre_delta_spent_seconds?: number | null;
}

export interface TaskSubtaskTimingShape {
  description?: string;
  status: "todo" | "in_progress" | "done";
  elapsed_seconds: number;
  timer_started_at?: number | null;
  active_subtask_key?: string | null;
  active_subtask_started_at?: number | null;
  last_subtask_checkpoint_seconds?: number;
  subtask_timings?: Record<string, SubtaskTimingEntry>;
}

export interface ParsedDescriptionLine {
  originalIndex: number;
  raw: string;
  isCheckable: boolean;
  isChecked: boolean;
  text: string;
  subtaskKey?: string;
}

export function normalizeSubtaskText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function parseDescriptionLines(desc: string): ParsedDescriptionLine[] {
  if (!desc) return [];
  const lines = desc.split("\n");
  const occurrenceCounts = new Map<string, number>();

  const nextKeyFor = (text: string, lineIdx: number): string => {
    const normalized = normalizeSubtaskText(text);
    const base = normalized || `__empty_${lineIdx}`;
    const count = (occurrenceCounts.get(base) || 0) + 1;
    occurrenceCounts.set(base, count);
    return count === 1 ? base : `${base}#${count}`;
  };

  return lines.map((line, idx) => {
    const trimmed = line.trim();
    if (/^(\[x\]|- \[x\]|\[X\]|- \[X\]|✓)\s*/.test(trimmed)) {
      const text = trimmed.replace(/^(\[x\]|- \[x\]|\[X\]|- \[X\]|✓)\s*/, "");
      return {
        originalIndex: idx,
        raw: line,
        isCheckable: true,
        isChecked: true,
        text,
        subtaskKey: nextKeyFor(text, idx),
      };
    }
    if (/^(\[ \]|-\s*\[ \])\s*/.test(trimmed)) {
      const text = trimmed.replace(/^(\[ \]|-\s*\[ \])\s*/, "");
      return {
        originalIndex: idx,
        raw: line,
        isCheckable: true,
        isChecked: false,
        text,
        subtaskKey: nextKeyFor(text, idx),
      };
    }
    if (/^[•\-\*]\s+/.test(trimmed)) {
      const text = trimmed.replace(/^[•\-\*]\s+/, "");
      return {
        originalIndex: idx,
        raw: line,
        isCheckable: true,
        isChecked: false,
        text,
        subtaskKey: nextKeyFor(text, idx),
      };
    }
    return {
      originalIndex: idx,
      raw: line,
      isCheckable: false,
      isChecked: false,
      text: line,
    };
  });
}

export function toggleChecklistLineRaw(line: string): string {
  const trimmed = line.trim();
  if (/^(\[x\]|- \[x\]|\[X\]|- \[X\]|✓)\s*/.test(trimmed)) {
    const text = trimmed.replace(/^(\[x\]|- \[x\]|\[X\]|- \[X\]|✓)\s*/, "");
    return `[ ] ${text}`;
  }
  if (/^(\[ \]|-\s*\[ \])\s*/.test(trimmed)) {
    const text = trimmed.replace(/^(\[ \]|-\s*\[ \])\s*/, "");
    return `[x] ${text}`;
  }
  if (/^[•\-\*]\s+/.test(trimmed)) {
    const text = trimmed.replace(/^[•\-\*]\s+/, "");
    return `[x] ${text}`;
  }
  return line;
}

export function isMainTimerRunning(task: Pick<TaskSubtaskTimingShape, "status" | "timer_started_at">): boolean {
  return (
    task.status !== "done" &&
    typeof task.timer_started_at === "number" &&
    Number.isFinite(task.timer_started_at)
  );
}

export function getTaskCurrentTotalElapsedSeconds(
  task: Pick<TaskSubtaskTimingShape, "status" | "elapsed_seconds" | "timer_started_at">,
  now: number
): number {
  const base =
    typeof task.elapsed_seconds === "number" && Number.isFinite(task.elapsed_seconds)
      ? Math.max(0, task.elapsed_seconds)
      : 0;
  if (isMainTimerRunning(task)) {
    const running = Math.max(0, Math.floor((now - task.timer_started_at!) / 1000));
    return base + running;
  }
  return base;
}

export function getActiveSubtaskSessionSeconds(
  task: Pick<TaskSubtaskTimingShape, "status" | "timer_started_at" | "active_subtask_key" | "active_subtask_started_at">,
  now: number
): number {
  if (!task.active_subtask_key || !isMainTimerRunning(task)) return 0;
  const startedAt =
    typeof task.active_subtask_started_at === "number" && Number.isFinite(task.active_subtask_started_at)
      ? Math.max(task.active_subtask_started_at, task.timer_started_at!)
      : task.timer_started_at!;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

export function getSubtaskLiveSeconds(
  task: TaskSubtaskTimingShape,
  subtaskKey: string,
  now: number
): number | null {
  const entry = task.subtask_timings?.[subtaskKey];
  const saved = entry?.spent_seconds ?? null;
  if (task.active_subtask_key === subtaskKey && isMainTimerRunning(task)) {
    return (saved ?? 0) + getActiveSubtaskSessionSeconds(task, now);
  }
  return saved;
}

function cloneTimings(
  timings?: Record<string, SubtaskTimingEntry>
): Record<string, SubtaskTimingEntry> {
  if (!timings || typeof timings !== "object") return {};
  const copy: Record<string, SubtaskTimingEntry> = {};
  for (const [k, v] of Object.entries(timings)) {
    if (v && typeof v === "object") {
      copy[k] = { ...v };
    }
  }
  return copy;
}

function findLineTextByKey(description: string | undefined, key: string): string {
  const lines = parseDescriptionLines(description || "");
  const found = lines.find((l) => l.isCheckable && l.subtaskKey === key);
  return normalizeSubtaskText(found?.text || key);
}

export function activateSubtask(
  task: TaskSubtaskTimingShape,
  subtaskKey: string,
  subtaskText: string,
  now: number
): Partial<TaskSubtaskTimingShape> {
  const timings = cloneTimings(task.subtask_timings);
  const running = isMainTimerRunning(task);
  const currentTotal = getTaskCurrentTotalElapsedSeconds(task, now);
  let checkpoint =
    typeof task.last_subtask_checkpoint_seconds === "number" &&
    Number.isFinite(task.last_subtask_checkpoint_seconds)
      ? Math.max(0, task.last_subtask_checkpoint_seconds)
      : 0;

  // Flush any currently active subtask before switching or deactivating
  if (task.active_subtask_key) {
    const prevKey = task.active_subtask_key;
    const activeDelta = getActiveSubtaskSessionSeconds(task, now);
    const prevEntry = timings[prevKey];
    const prevText = prevEntry?.text || findLineTextByKey(task.description, prevKey);
    timings[prevKey] = {
      text: prevText,
      spent_seconds: (prevEntry?.spent_seconds ?? 0) + activeDelta,
      completed: prevEntry?.completed ?? false,
      completed_at: prevEntry?.completed_at ?? null,
      mode: prevEntry?.mode === "manual" ? "active" : (prevEntry?.mode ?? "active"),
      timer_was_running: prevEntry?.timer_was_running ?? running,
    };
    if (running) {
      checkpoint = Math.max(checkpoint, currentTotal);
    }

    // Clicking the currently active subtask toggles it off (pauses focus on it)
    if (prevKey === subtaskKey) {
      return {
        active_subtask_key: null,
        active_subtask_started_at: null,
        last_subtask_checkpoint_seconds: checkpoint,
        subtask_timings: timings,
      };
    }
  }

  // Starting or switching into a new subtask mid-way must advance checkpoint to currentTotal
  // so earlier unattributed main-timer seconds do not leak into future delta subtasks.
  if (running) {
    checkpoint = Math.max(checkpoint, currentTotal);
  }

  const normalizedText = normalizeSubtaskText(subtaskText);
  const existing = timings[subtaskKey];
  timings[subtaskKey] = {
    text: normalizedText,
    spent_seconds: existing?.spent_seconds ?? 0,
    completed: existing?.completed ?? false,
    completed_at: existing?.completed_at ?? null,
    mode: "active",
    timer_was_running: running || existing?.timer_was_running,
  };

  return {
    active_subtask_key: subtaskKey,
    active_subtask_started_at: running ? now : null,
    last_subtask_checkpoint_seconds: checkpoint,
    subtask_timings: timings,
  };
}

export function flushActiveSubtaskOnTaskTransition(
  task: TaskSubtaskTimingShape,
  nextStatus: "todo" | "in_progress" | "done",
  now: number
): Partial<TaskSubtaskTimingShape> {
  const hasAnySubtaskState =
    Boolean(task.active_subtask_key) ||
    typeof task.active_subtask_started_at === "number";

  if (!hasAnySubtaskState) {
    return {};
  }

  if (nextStatus === "in_progress") {
    if (task.active_subtask_key) {
      return {
        active_subtask_started_at: now,
      };
    }
    return {};
  }

  // Pausing (in_progress -> todo) or completing (in_progress/todo -> done)
  if (task.active_subtask_key) {
    const key = task.active_subtask_key;
    const running = isMainTimerRunning(task);
    const activeDelta = running ? getActiveSubtaskSessionSeconds(task, now) : 0;
    const currentTotal = getTaskCurrentTotalElapsedSeconds(task, now);
    const prevCheckpoint =
      typeof task.last_subtask_checkpoint_seconds === "number" &&
      Number.isFinite(task.last_subtask_checkpoint_seconds)
        ? Math.max(0, task.last_subtask_checkpoint_seconds)
        : 0;

    const timings = cloneTimings(task.subtask_timings);
    const existing = timings[key];
    const text = existing?.text || findLineTextByKey(task.description, key);

    if (activeDelta > 0 || existing) {
      timings[key] = {
        text,
        spent_seconds: (existing?.spent_seconds ?? 0) + activeDelta,
        completed: existing?.completed ?? false,
        completed_at: existing?.completed_at ?? null,
        mode: existing?.mode ?? "active",
        timer_was_running: running || existing?.timer_was_running,
      };
    }

    const patch: Partial<TaskSubtaskTimingShape> = {
      active_subtask_started_at: null,
      last_subtask_checkpoint_seconds: running
        ? Math.max(prevCheckpoint, currentTotal)
        : prevCheckpoint,
      subtask_timings: timings,
    };

    if (nextStatus === "done") {
      patch.active_subtask_key = null;
    }

    return patch;
  }

  return {
    active_subtask_started_at: null,
  };
}

export function toggleSubtaskCompletion(
  task: TaskSubtaskTimingShape,
  lineIndex: number,
  now: number
): Partial<TaskSubtaskTimingShape> | null {
  if (!task.description) return null;
  const lines = task.description.split("\n");
  if (lineIndex < 0 || lineIndex >= lines.length) return null;

  const parsed = parseDescriptionLines(task.description);
  const target = parsed[lineIndex];
  if (!target || !target.isCheckable || !target.subtaskKey) return null;

  lines[lineIndex] = toggleChecklistLineRaw(lines[lineIndex]);
  const updatedDescription = lines.join("\n");
  const key = target.subtaskKey;
  const normalizedText = normalizeSubtaskText(target.text);
  const running = isMainTimerRunning(task);
  const currentTotal = getTaskCurrentTotalElapsedSeconds(task, now);
  let checkpoint =
    typeof task.last_subtask_checkpoint_seconds === "number" &&
    Number.isFinite(task.last_subtask_checkpoint_seconds)
      ? Math.max(0, task.last_subtask_checkpoint_seconds)
      : 0;

  const hasExistingTimings =
    task.subtask_timings !== undefined ||
    task.active_subtask_key !== undefined ||
    task.last_subtask_checkpoint_seconds !== undefined;

  const timings = cloneTimings(task.subtask_timings);
  const existing = timings[key];

  // Unchecking
  if (target.isChecked) {
    if (!hasExistingTimings && !existing) {
      return { description: updatedDescription };
    }

    if (existing) {
      const isLastDelta =
        existing.mode === "delta" &&
        typeof existing.applied_checkpoint_seconds === "number" &&
        checkpoint === existing.applied_checkpoint_seconds;

      if (isLastDelta) {
        checkpoint = existing.previous_checkpoint_seconds ?? 0;
        const restoredSpent = existing.pre_delta_spent_seconds ?? null;
        timings[key] = {
          text: normalizedText,
          spent_seconds: restoredSpent,
          completed: false,
          completed_at: null,
          mode: restoredSpent && restoredSpent > 0 ? "active" : "manual",
          timer_was_running: existing.timer_was_running,
        };
      } else {
        timings[key] = {
          ...existing,
          text: normalizedText,
          completed: false,
          completed_at: null,
        };
      }
    }

    return {
      description: updatedDescription,
      last_subtask_checkpoint_seconds: checkpoint,
      subtask_timings: timings,
    };
  }

  // Checking (!target.isChecked -> checked)
  const patch: Partial<TaskSubtaskTimingShape> = {
    description: updatedDescription,
  };

  // Case 1: Checking the currently Active subtask
  if (task.active_subtask_key === key) {
    const activeDelta = running ? getActiveSubtaskSessionSeconds(task, now) : 0;
    const prevSpent = existing?.spent_seconds ?? 0;
    const totalSpent = prevSpent + activeDelta;

    if (running) {
      checkpoint = Math.max(checkpoint, currentTotal);
      timings[key] = {
        text: normalizedText,
        spent_seconds: totalSpent,
        completed: true,
        completed_at: now,
        mode: "active",
        timer_was_running: true,
      };
    } else if (prevSpent > 0) {
      timings[key] = {
        text: normalizedText,
        spent_seconds: prevSpent,
        completed: true,
        completed_at: now,
        mode: existing?.mode ?? "active",
        timer_was_running: false,
      };
    } else {
      timings[key] = {
        text: normalizedText,
        spent_seconds: null,
        completed: true,
        completed_at: now,
        mode: "manual",
        timer_was_running: false,
      };
    }

    patch.active_subtask_key = null;
    patch.active_subtask_started_at = null;
    patch.last_subtask_checkpoint_seconds = checkpoint;
    patch.subtask_timings = timings;
    return patch;
  }

  // Case 2: Another subtask is currently Active while main timer is running
  if (task.active_subtask_key && running) {
    const activeKey = task.active_subtask_key;
    const activeDelta = getActiveSubtaskSessionSeconds(task, now);
    const activeExisting = timings[activeKey];
    const activeText =
      activeExisting?.text || findLineTextByKey(task.description, activeKey);

    timings[activeKey] = {
      text: activeText,
      spent_seconds: (activeExisting?.spent_seconds ?? 0) + activeDelta,
      completed: activeExisting?.completed ?? false,
      completed_at: activeExisting?.completed_at ?? null,
      mode: "active",
      timer_was_running: true,
    };

    checkpoint = Math.max(checkpoint, currentTotal);
    patch.active_subtask_started_at = now;
    patch.last_subtask_checkpoint_seconds = checkpoint;

    if (existing && typeof existing.spent_seconds === "number" && existing.spent_seconds > 0) {
      timings[key] = {
        ...existing,
        text: normalizedText,
        completed: true,
        completed_at: now,
      };
    } else {
      timings[key] = {
        text: normalizedText,
        spent_seconds: null,
        completed: true,
        completed_at: now,
        mode: "manual",
        timer_was_running: false,
      };
    }
    patch.subtask_timings = timings;
    return patch;
  }

  // Case 3: No active subtask, main timer IS running -> Delta mode
  if (running) {
    const delta = Math.max(0, currentTotal - checkpoint);
    const preDeltaSpent =
      existing && typeof existing.spent_seconds === "number"
        ? existing.spent_seconds
        : null;
    const nextSpent = (preDeltaSpent ?? 0) + delta;

    timings[key] = {
      text: normalizedText,
      spent_seconds: nextSpent,
      completed: true,
      completed_at: now,
      mode: "delta",
      timer_was_running: true,
      previous_checkpoint_seconds: checkpoint,
      applied_checkpoint_seconds: currentTotal,
      pre_delta_spent_seconds: preDeltaSpent,
    };

    patch.last_subtask_checkpoint_seconds = Math.max(checkpoint, currentTotal);
    patch.subtask_timings = timings;
    return patch;
  }

  // Case 4: Main timer is OFF (timer_started_at === null)
  if (existing && typeof existing.spent_seconds === "number" && existing.spent_seconds > 0) {
    timings[key] = {
      ...existing,
      text: normalizedText,
      completed: true,
      completed_at: now,
      timer_was_running: false,
    };
  } else {
    timings[key] = {
      text: normalizedText,
      spent_seconds: null,
      completed: true,
      completed_at: now,
      mode: "manual",
      timer_was_running: false,
    };
  }

  patch.subtask_timings = timings;
  if (task.last_subtask_checkpoint_seconds !== undefined) {
    patch.last_subtask_checkpoint_seconds = checkpoint;
  }
  return patch;
}

export function parseFlexibleNumberInput(raw: string): number | null {
  const normalized = raw
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/٫/g, ".")
    .trim();
  if (!normalized) return null;
  const val = Number(normalized);
  if (!Number.isFinite(val) || val < 0) return null;
  return val;
}

export function updateSubtaskManualMinutes(
  task: TaskSubtaskTimingShape,
  subtaskKey: string,
  subtaskText: string,
  isChecked: boolean,
  minutes: number,
  now: number
): Partial<TaskSubtaskTimingShape> {
  const safeMinutes = Number.isFinite(minutes) && minutes >= 0 ? minutes : 0;
  const newSeconds = Math.round(safeMinutes * 60);
  const timings = cloneTimings(task.subtask_timings);
  const existing = timings[subtaskKey];
  const isActive = task.active_subtask_key === subtaskKey;
  const running = isMainTimerRunning(task);

  timings[subtaskKey] = {
    text: normalizeSubtaskText(subtaskText),
    spent_seconds: newSeconds,
    completed: existing?.completed ?? isChecked,
    completed_at: existing?.completed_at ?? (isChecked ? now : null),
    mode: isActive ? "active" : "manual",
    timer_was_running: existing?.timer_was_running ?? (isActive && running),
  };

  const patch: Partial<TaskSubtaskTimingShape> = {
    subtask_timings: timings,
  };

  // If user edits the currently active subtask while running, reset active session start
  // to now so the edited value becomes the clean baseline without re-adding prior seconds.
  if (isActive && running) {
    const currentTotal = getTaskCurrentTotalElapsedSeconds(task, now);
    const prevCheckpoint =
      typeof task.last_subtask_checkpoint_seconds === "number" &&
      Number.isFinite(task.last_subtask_checkpoint_seconds)
        ? Math.max(0, task.last_subtask_checkpoint_seconds)
        : 0;
    patch.active_subtask_started_at = now;
    patch.last_subtask_checkpoint_seconds = Math.max(prevCheckpoint, currentTotal);
  }

  return patch;
}

export function reconcileEditedDescriptionSubtasks(
  task: TaskSubtaskTimingShape,
  newDescription: string,
  now: number
): Partial<TaskSubtaskTimingShape> {
  const hasTimingData =
    Boolean(task.active_subtask_key) ||
    typeof task.active_subtask_started_at === "number" ||
    task.subtask_timings !== undefined ||
    task.last_subtask_checkpoint_seconds !== undefined;

  if (!hasTimingData) {
    return { description: newDescription };
  }

  const parsed = parseDescriptionLines(newDescription);
  const validKeys = new Set(
    parsed.filter((l) => l.isCheckable && l.subtaskKey).map((l) => l.subtaskKey!)
  );

  if (task.active_subtask_key && !validKeys.has(task.active_subtask_key)) {
    const flushed = flushActiveSubtaskOnTaskTransition(task, "done", now);
    return {
      ...flushed,
      description: newDescription,
      active_subtask_key: null,
      active_subtask_started_at: null,
    };
  }

  return { description: newDescription };
}

export function sanitizeImportedSubtaskTimings(
  raw: unknown
): Record<string, SubtaskTimingEntry> | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const result: Record<string, SubtaskTimingEntry> = {};

  const sanitizeEntry = (item: any, fallbackKey?: string): [string, SubtaskTimingEntry] | null => {
    if (!item || typeof item !== "object") return null;
    const rawText = typeof item.text === "string" ? item.text : fallbackKey || "";
    const text = normalizeSubtaskText(rawText);
    const key = fallbackKey && fallbackKey.trim() ? fallbackKey : text;
    if (!key) return null;

    const spent =
      item.spent_seconds === null
        ? null
        : typeof item.spent_seconds === "number" && Number.isFinite(item.spent_seconds)
          ? Math.max(0, Math.round(item.spent_seconds))
          : null;

    const mode: SubtaskTimingMode =
      item.mode === "active" || item.mode === "delta" || item.mode === "manual"
        ? item.mode
        : "manual";

    const entry: SubtaskTimingEntry = {
      text: text || key,
      spent_seconds: spent,
      completed: Boolean(item.completed),
      completed_at:
        typeof item.completed_at === "number" && Number.isFinite(item.completed_at)
          ? item.completed_at
          : null,
      mode,
    };

    if (typeof item.timer_was_running === "boolean") {
      entry.timer_was_running = item.timer_was_running;
    }
    if (
      typeof item.previous_checkpoint_seconds === "number" &&
      Number.isFinite(item.previous_checkpoint_seconds)
    ) {
      entry.previous_checkpoint_seconds = Math.max(0, item.previous_checkpoint_seconds);
    }
    if (
      typeof item.applied_checkpoint_seconds === "number" &&
      Number.isFinite(item.applied_checkpoint_seconds)
    ) {
      entry.applied_checkpoint_seconds = Math.max(0, item.applied_checkpoint_seconds);
    }
    if (
      item.pre_delta_spent_seconds === null ||
      (typeof item.pre_delta_spent_seconds === "number" &&
        Number.isFinite(item.pre_delta_spent_seconds))
    ) {
      entry.pre_delta_spent_seconds = item.pre_delta_spent_seconds;
    }

    return [key, entry];
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      const pair = sanitizeEntry(item, typeof item?.key === "string" ? item.key : undefined);
      if (pair) {
        result[pair[0]] = pair[1];
      }
    }
  } else {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const pair = sanitizeEntry(v, k);
      if (pair) {
        result[pair[0]] = pair[1];
      }
    }
  }

  return result;
}
