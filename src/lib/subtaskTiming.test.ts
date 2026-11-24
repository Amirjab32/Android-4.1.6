import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDescriptionLines,
  activateSubtask,
  flushActiveSubtaskOnTaskTransition,
  toggleSubtaskCompletion,
  updateSubtaskManualMinutes,
  getSubtaskLiveSeconds,
  parseFlexibleNumberInput,
  TaskSubtaskTimingShape,
} from "./subtaskTiming";
import {
  Task,
  TaskStore,
  exportTasksJSON,
  importTasksJSON,
  exportDatabase,
  importDatabase,
} from "./store";

function createMockLocalStorage() {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}

function makeBaseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t-1",
    title: "تمرین گیتار",
    description: "[ ] تمرین ۱\n[ ] تمرین ۲\n[ ] تمرین ۳",
    status: "todo",
    priority: "medium",
    kanban_column: "todo",
    created_date: "2026-11-24",
    elapsed_seconds: 0,
    timer_started_at: null,
    intervals: [],
    tags: ["گیتار"],
    ...overrides,
  };
}

function applyPatch<T extends object>(base: T, patch: Partial<T> | null): T {
  if (!patch) return base;
  return { ...base, ...patch };
}

test("mid-way Active start does not absorb earlier main-timer seconds", () => {
  const T0 = 1_700_000_000_000;
  // Main timer started at T0, now 10 minutes (600s) have elapsed
  let task: TaskSubtaskTimingShape = makeBaseTask({
    status: "in_progress",
    timer_started_at: T0,
    elapsed_seconds: 0,
  });

  const atMin10 = T0 + 600_000;
  task = applyPatch(task, activateSubtask(task, "تمرین ۱", "تمرین ۱", atMin10));

  assert.equal(task.active_subtask_key, "تمرین ۱");
  assert.equal(task.active_subtask_started_at, atMin10);
  assert.equal(task.last_subtask_checkpoint_seconds, 600);
  assert.equal(getSubtaskLiveSeconds(task, "تمرین ۱", atMin10), 0);

  // 5 minutes later (minute 15 total), Subtask 1 has exactly 300s (5m)
  const atMin15 = T0 + 900_000;
  assert.equal(getSubtaskLiveSeconds(task, "تمرین ۱", atMin15), 300);

  // Now deactivate Subtask 1, let timer run until minute 25 (1500s), and check Subtask 2 (Delta)
  task = applyPatch(task, activateSubtask(task, "تمرین ۱", "تمرین ۱", atMin15));
  assert.equal(task.active_subtask_key, null);
  assert.equal(task.subtask_timings?.["تمرین ۱"]?.spent_seconds, 300);
  assert.equal(task.last_subtask_checkpoint_seconds, 900);

  const atMin25 = T0 + 1_500_000;
  task = applyPatch(task, toggleSubtaskCompletion(task, 1, atMin25));
  // Subtask 2 gets only 1500 - 900 = 600s (10m), NOT the initial 10m nor Subtask 1's 5m!
  assert.equal(task.subtask_timings?.["تمرین ۲"]?.spent_seconds, 600);
  assert.equal(task.subtask_timings?.["تمرین ۲"]?.mode, "delta");
});

test("direct switch between Active subtasks flushes previous and starts next immediately", () => {
  const T0 = 1_700_000_000_000;
  let task: TaskSubtaskTimingShape = makeBaseTask({
    status: "in_progress",
    timer_started_at: T0,
    elapsed_seconds: 0,
  });

  // Activate Subtask 1 at T0
  task = applyPatch(task, activateSubtask(task, "تمرین ۱", "تمرین ۱", T0));
  // Direct switch to Subtask 2 at +5m (300s) without pausing main timer
  const at5m = T0 + 300_000;
  task = applyPatch(task, activateSubtask(task, "تمرین ۲", "تمرین ۲", at5m));

  assert.equal(task.subtask_timings?.["تمرین ۱"]?.spent_seconds, 300);
  assert.equal(task.subtask_timings?.["تمرین ۱"]?.completed, false);
  assert.equal(task.active_subtask_key, "تمرین ۲");
  assert.equal(task.active_subtask_started_at, at5m);
  assert.equal(getSubtaskLiveSeconds(task, "تمرین ۲", at5m), 0);

  // Run Subtask 2 for 4m (240s), then pause main timer
  const at9m = T0 + 540_000;
  const pausePatch = flushActiveSubtaskOnTaskTransition(task, "todo", at9m);
  task = applyPatch(task, {
    ...pausePatch,
    status: "todo",
    elapsed_seconds: 540,
    timer_started_at: null,
  });

  assert.equal(task.subtask_timings?.["تمرین ۲"]?.spent_seconds, 240);
  assert.equal(task.active_subtask_key, "تمرین ۲");
  assert.equal(task.active_subtask_started_at, null);

  // Resume later at T1 and run 1m (60s), then check off Subtask 2
  const T1 = T0 + 1_000_000;
  const resumePatch = flushActiveSubtaskOnTaskTransition(task, "in_progress", T1);
  task = applyPatch(task, {
    ...resumePatch,
    status: "in_progress",
    timer_started_at: T1,
  });

  const T1Plus60 = T1 + 60_000;
  task = applyPatch(task, toggleSubtaskCompletion(task, 1, T1Plus60));
  assert.equal(task.subtask_timings?.["تمرین ۲"]?.spent_seconds, 300);
  assert.equal(task.subtask_timings?.["تمرین ۲"]?.completed, true);
  assert.equal(task.subtask_timings?.["تمرین ۲"]?.mode, "active");
  assert.equal(task.active_subtask_key, null);
});

test("Delta fallback handles Pause/Resume accurately and prevents double-counting with Active", () => {
  const T0 = 1_700_000_000_000;
  // Session 1 ran 12m (720s) and paused; Session 2 resumed at T0 and ran 8m (480s) -> total 20m (1200s)
  let task: TaskSubtaskTimingShape = makeBaseTask({
    status: "in_progress",
    elapsed_seconds: 720,
    timer_started_at: T0,
  });

  const at20mTotal = T0 + 480_000;
  task = applyPatch(task, toggleSubtaskCompletion(task, 2, at20mTotal));
  assert.equal(task.subtask_timings?.["تمرین ۳"]?.spent_seconds, 1200);
  assert.equal(task.subtask_timings?.["تمرین ۳"]?.mode, "delta");
  assert.equal(task.last_subtask_checkpoint_seconds, 1200);

  // Continue running to total 50m (3000s), check Subtask 2 -> 3000 - 1200 = 1800s (30m)
  const at50mTotal = T0 + 2_280_000;
  task = applyPatch(task, toggleSubtaskCompletion(task, 1, at50mTotal));
  assert.equal(task.subtask_timings?.["تمرین ۲"]?.spent_seconds, 1800);
  assert.equal(task.last_subtask_checkpoint_seconds, 3000);
});

test("checking another subtask while an Active subtask is running does not steal Active time", () => {
  const T0 = 1_700_000_000_000;
  let task: TaskSubtaskTimingShape = makeBaseTask({
    status: "in_progress",
    elapsed_seconds: 0,
    timer_started_at: T0,
  });

  task = applyPatch(task, activateSubtask(task, "تمرین ۱", "تمرین ۱", T0));
  const at10m = T0 + 600_000;
  // User checks Subtask 2 while Subtask 1 is still active
  task = applyPatch(task, toggleSubtaskCompletion(task, 1, at10m));

  assert.equal(task.subtask_timings?.["تمرین ۱"]?.spent_seconds, 600);
  assert.equal(task.active_subtask_key, "تمرین ۱");
  assert.equal(task.active_subtask_started_at, at10m);
  assert.equal(task.subtask_timings?.["تمرین ۲"]?.spent_seconds, null);
  assert.equal(task.subtask_timings?.["تمرین ۲"]?.mode, "manual");
  assert.equal(task.last_subtask_checkpoint_seconds, 600);
});

test("checking subtask while main timer is OFF logs manual without stealing previous session elapsed time", () => {
  const T0 = 1_700_000_000_000;
  let task: TaskSubtaskTimingShape = makeBaseTask({
    status: "todo",
    elapsed_seconds: 1800,
    timer_started_at: null,
  });

  task = applyPatch(task, toggleSubtaskCompletion(task, 0, T0));
  assert.equal(task.subtask_timings?.["تمرین ۱"]?.mode, "manual");
  assert.equal(task.subtask_timings?.["تمرین ۱"]?.spent_seconds, null);
  assert.equal(task.subtask_timings?.["تمرین ۱"]?.timer_was_running, false);

  // If subtask had prior Active time, checking while timer is OFF preserves that time
  let taskWithActive: TaskSubtaskTimingShape = makeBaseTask({
    status: "todo",
    elapsed_seconds: 1800,
    timer_started_at: null,
    subtask_timings: {
      "تمرین ۱": {
        text: "تمرین ۱",
        spent_seconds: 420,
        completed: false,
        completed_at: null,
        mode: "active",
      },
    },
  });
  taskWithActive = applyPatch(taskWithActive, toggleSubtaskCompletion(taskWithActive, 0, T0));
  assert.equal(taskWithActive.subtask_timings?.["تمرین ۱"]?.spent_seconds, 420);
  assert.equal(taskWithActive.subtask_timings?.["تمرین ۱"]?.completed, true);
});

test("unchecking reverts last Delta checkpoint cleanly while preserving non-last / Active times", () => {
  const T0 = 1_700_000_000_000;
  let task: TaskSubtaskTimingShape = makeBaseTask({
    status: "in_progress",
    elapsed_seconds: 0,
    timer_started_at: T0,
  });

  // Check Subtask 3 at 20m (Delta)
  const at20m = T0 + 1_200_000;
  task = applyPatch(task, toggleSubtaskCompletion(task, 2, at20m));
  assert.equal(task.last_subtask_checkpoint_seconds, 1200);
  assert.equal(task.subtask_timings?.["تمرین ۳"]?.spent_seconds, 1200);

  // Uncheck Subtask 3 (was last Delta) -> checkpoint reverts to 0
  const at21m = T0 + 1_260_000;
  task = applyPatch(task, toggleSubtaskCompletion(task, 2, at21m));
  assert.equal(task.last_subtask_checkpoint_seconds, 0);
  assert.equal(task.subtask_timings?.["تمرین ۳"]?.completed, false);

  // Check Subtask 1 at 25m -> gets full 25m (1500s)
  const at25m = T0 + 1_500_000;
  task = applyPatch(task, toggleSubtaskCompletion(task, 0, at25m));
  assert.equal(task.subtask_timings?.["تمرین ۱"]?.spent_seconds, 1500);

  // Check Subtask 2 at 35m -> gets 10m (600s)
  const at35m = T0 + 2_100_000;
  task = applyPatch(task, toggleSubtaskCompletion(task, 1, at35m));
  assert.equal(task.subtask_timings?.["تمرین ۲"]?.spent_seconds, 600);

  // Now uncheck Subtask 1 (NOT the last Delta): its 1500s is preserved and checkpoint stays 2100!
  task = applyPatch(task, toggleSubtaskCompletion(task, 0, at35m + 5000));
  assert.equal(task.subtask_timings?.["تمرین ۱"]?.spent_seconds, 1500);
  assert.equal(task.subtask_timings?.["تمرین ۱"]?.completed, false);
  assert.equal(task.last_subtask_checkpoint_seconds, 2100);
});

test("quick manual minute edit parses Persian digits and updates spent_seconds without modifying description", () => {
  const T0 = 1_700_000_000_000;
  assert.equal(parseFlexibleNumberInput("۲۵"), 25);
  assert.equal(parseFlexibleNumberInput("12.5"), 12.5);
  assert.equal(parseFlexibleNumberInput("-3"), null);

  let task: TaskSubtaskTimingShape = makeBaseTask();
  const originalDesc = task.description;
  task = applyPatch(
    task,
    updateSubtaskManualMinutes(task, "تمرین ۱", "تمرین ۱", false, 20, T0)
  );
  assert.equal(task.description, originalDesc);
  assert.equal(task.subtask_timings?.["تمرین ۱"]?.spent_seconds, 1200);
  assert.equal(task.subtask_timings?.["تمرین ۱"]?.mode, "manual");
});

test("subtask keys stay resilient when description lines are reordered", () => {
  const linesBefore = parseDescriptionLines("[ ] آکورد لامینور\n[ ] گام دو ماژور");
  const linesAfter = parseDescriptionLines("[ ] گام دو ماژور\n[ ] آکورد لامینور");
  assert.equal(linesBefore[0].subtaskKey, linesAfter[1].subtaskKey);
  assert.equal(linesBefore[1].subtaskKey, linesAfter[0].subtaskKey);
});

test("exportTasksJSON, importTasksJSON, exportDatabase, and importDatabase preserve both legacy and new subtask timing schemas", () => {
  const mockStorage = createMockLocalStorage();
  (globalThis as any).localStorage = mockStorage;

  const legacyTask = {
    id: "legacy-1",
    title: "تسک قدیمی",
    description: "[ ] مورد الف\n[x] مورد ب",
    priority: "high",
    scheduled_date: "2026-11-20",
    status: "todo",
    kanban_column: "todo",
    created_date: "2026-11-20",
    elapsed_seconds: 600,
    timer_started_at: null,
    intervals: [],
    tags: ["قدیمی"],
  };

  const smartTask: Task = makeBaseTask({
    id: "smart-1",
    active_subtask_key: "تمرین ۱",
    active_subtask_started_at: 1700000100000,
    last_subtask_checkpoint_seconds: 1200,
    subtask_timings: {
      "تمرین ۱": {
        text: "تمرین ۱",
        spent_seconds: 300,
        completed: false,
        completed_at: null,
        mode: "active",
      },
      "تمرین ۲": {
        text: "تمرین ۲",
        spent_seconds: 1200,
        completed: true,
        completed_at: 1700000050000,
        mode: "delta",
      },
    },
  });

  // Import mixed legacy + smart tasks JSON
  const importRes = importTasksJSON(
    JSON.stringify({ focusflow_tasks: [legacyTask, smartTask] }),
    "replace"
  );
  assert.equal(importRes.success, true);
  assert.equal(importRes.count, 2);

  const listed = TaskStore.list();
  const importedLegacy = listed.find((t) => t.id === "legacy-1")!;
  const importedSmart = listed.find((t) => t.id === "smart-1")!;

  // Legacy task must NOT gain new optional fields
  assert.equal("subtask_timings" in importedLegacy, false);
  assert.equal("active_subtask_key" in importedLegacy, false);
  assert.equal("last_subtask_checkpoint_seconds" in importedLegacy, false);
  assert.equal(importedLegacy.elapsed_seconds, 600);

  // Smart task must retain all timing fields
  assert.equal(importedSmart.active_subtask_key, "تمرین ۱");
  assert.equal(importedSmart.active_subtask_started_at, 1700000100000);
  assert.equal(importedSmart.last_subtask_checkpoint_seconds, 1200);
  assert.equal(importedSmart.subtask_timings?.["تمرین ۲"]?.spent_seconds, 1200);
  assert.equal(importedSmart.subtask_timings?.["تمرین ۲"]?.mode, "delta");

  // Round-trip through exportTasksJSON
  const exportedTasks = JSON.parse(exportTasksJSON());
  assert.equal(exportedTasks.focusflow_tasks.length, 2);
  const exportedSmart = exportedTasks.focusflow_tasks.find((t: Task) => t.id === "smart-1");
  assert.equal(exportedSmart.subtask_timings["تمرین ۱"].spent_seconds, 300);

  // Round-trip through full exportDatabase / importDatabase (used by Sync & Backup)
  const dbDump = exportDatabase();
  mockStorage.clear();
  assert.equal(importDatabase(dbDump, true), true);
  const afterDbRestore = TaskStore.list().find((t) => t.id === "smart-1")!;
  assert.equal(afterDbRestore.subtask_timings?.["تمرین ۲"]?.completed, true);
  assert.equal(afterDbRestore.last_subtask_checkpoint_seconds, 1200);
});
