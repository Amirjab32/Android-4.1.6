import test from "node:test";
import assert from "node:assert/strict";
import { CalendarEventStore, exportDatabase, importDatabase } from "./store";

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

test("CalendarEventStore creates, sorts chronologically, updates with reminder guard, and deletes", () => {
  (globalThis as any).localStorage = createMockLocalStorage();

  const lateSameDay = CalendarEventStore.create({
    title: "جلسه عصر",
    date: "2026-04-10",
    time: "18:30",
    reminder_enabled: true,
    reminder_sound: "work",
    color: "#6366f1",
    note: "با تیم فنی",
  });

  const allDay = CalendarEventStore.create({
    title: "تمدید دامنه",
    date: "2026-04-10",
    time: null,
    reminder_enabled: true, // Should be forced false when time is absent
    color: "#f59e0b",
  });

  const earlierDay = CalendarEventStore.create({
    title: "قرار دندانپزشکی",
    date: "2026-04-05",
    time: "09:15",
    reminder_enabled: true,
    color: "#10b981",
  });

  const morningSameDay = CalendarEventStore.create({
    title: "پیگیری مدارک",
    date: "2026-04-10",
    time: "08:00",
    reminder_enabled: false,
    color: "#0ea5e9",
  });

  assert.equal(allDay.reminder_enabled, false);

  const sortedAll = CalendarEventStore.list();
  assert.deepEqual(
    sortedAll.map((e) => e.id),
    [earlierDay.id, morningSameDay.id, lateSameDay.id, allDay.id]
  );

  const dayEvents = CalendarEventStore.listByDate("2026-04-10");
  assert.equal(dayEvents.length, 3);
  assert.equal(dayEvents[0].title, "پیگیری مدارک");
  assert.equal(dayEvents[2].title, "تمدید دامنه");

  // Updating time to null must automatically disable reminder_enabled
  const clearedTime = CalendarEventStore.update(lateSameDay.id, {
    title: "جلسه عصر (تغییر ساعت)",
    time: null,
  });
  assert.ok(clearedTime);
  assert.equal(clearedTime.title, "جلسه عصر (تغییر ساعت)");
  assert.equal(clearedTime.time, null);
  assert.equal(clearedTime.reminder_enabled, false);

  CalendarEventStore.delete(earlierDay.id);
  assert.equal(CalendarEventStore.list().length, 3);
  assert.equal(CalendarEventStore.listByDate("2026-04-05").length, 0);
});

test("exportDatabase and importDatabase preserve and override focusflow_calendar_events", () => {
  (globalThis as any).localStorage = createMockLocalStorage();

  const created = CalendarEventStore.create({
    title: "سالگرد مهم",
    date: "2026-05-01",
    time: "11:00",
    reminder_enabled: true,
    reminder_sound: "prayer",
    color: "#f43f5e",
    note: "یادآوری خرید هدیه",
  });

  const exportedJson = exportDatabase();
  const parsed = JSON.parse(exportedJson);
  assert.ok(Array.isArray(parsed.focusflow_calendar_events));
  assert.equal(parsed.focusflow_calendar_events.length, 1);
  assert.equal(parsed.focusflow_calendar_events[0].id, created.id);

  // Reset storage and restore
  (globalThis as any).localStorage = createMockLocalStorage();
  assert.equal(CalendarEventStore.list().length, 0);

  const ok = importDatabase(exportedJson, true);
  assert.equal(ok, true);
  const restored = CalendarEventStore.list();
  assert.equal(restored.length, 1);
  assert.equal(restored[0].title, "سالگرد مهم");
  assert.equal(restored[0].reminder_enabled, true);
  assert.equal(restored[0].note, "یادآوری خرید هدیه");

  // Importing a payload without focusflow_calendar_events with forceOverride clears it cleanly
  const okEmpty = importDatabase(JSON.stringify({ focusflow_tasks: [] }), true);
  assert.equal(okEmpty, true);
  assert.equal(CalendarEventStore.list().length, 0);
});
