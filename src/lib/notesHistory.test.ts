import test from "node:test";
import assert from "node:assert/strict";
import { NoteStore } from "./store";
import { syncManager } from "./sync";

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

test("NoteStore auto-snapshots on significant edit, manual snapshot deduplicates, and restoreVersion keeps active draft", () => {
  const mockStorage = createMockLocalStorage();
  (globalThis as any).localStorage = mockStorage;

  const note = NoteStore.create({
    title: "یادداشت آزمایشی",
    content: "متن اولیه کوتاه برای شروع تست تاریخچه.",
    folder: "all",
    tags: [],
  });

  // Small edit (<60 chars, <45s) creates initial snapshot when history is empty
  const afterSmall = NoteStore.update(note.id, {
    content: "متن اولیه کوتاه برای شروع تست تاریخچه و ادامه.",
  });
  assert.ok(afterSmall);
  assert.equal(afterSmall.history?.length, 1);
  assert.equal(afterSmall.history?.[0].content, "متن اولیه کوتاه برای شروع تست تاریخچه.");

  // Another tiny edit immediately after should NOT create a noisy duplicate snapshot
  const afterTiny = NoteStore.update(note.id, {
    content: "متن اولیه کوتاه برای شروع تست تاریخچه و ادامه ی کوتاه",
  });
  assert.ok(afterTiny);
  assert.equal(afterTiny.history?.length, 1);

  // Manual snapshot saves current text and deduplicates identical second call
  const afterManual1 = NoteStore.saveSnapshot(note.id, "یادداشت آزمایشی", "نسخه میانی دستی برای آزمایش");
  assert.ok(afterManual1);
  assert.equal(afterManual1.history?.length, 2);

  const afterManual2 = NoteStore.saveSnapshot(note.id, "یادداشت آزمایشی", "نسخه میانی دستی برای آزمایش");
  assert.ok(afterManual2);
  assert.equal(afterManual2.history?.length, 2);

  // Significant growth (>60 char delta) triggers another auto-snapshot on subsequent edit of prev
  const longText = "متن بسیار طولانی ".repeat(12);
  NoteStore.update(note.id, { content: longText });
  const afterLongEdit = NoteStore.update(note.id, { content: `${longText} و ادامه` });
  assert.ok(afterLongEdit);
  assert.equal(afterLongEdit.history?.length, 3);
  assert.equal(afterLongEdit.history?.[0].content, longText);

  // Restore original snapshot while preserving the active unsaved draft in history
  const firstSnapshot = afterLongEdit.history![afterLongEdit.history!.length - 1];
  const restored = NoteStore.restoreVersion(
    note.id,
    firstSnapshot.id,
    "عنوان پیش‌نویس جاری",
    "محتوای فعلی پیش از بازگردانی"
  );
  assert.ok(restored);
  assert.equal(restored.title, firstSnapshot.title);
  assert.equal(restored.content, firstSnapshot.content);
  assert.equal(restored.history?.[0].title, "عنوان پیش‌نویس جاری");
  assert.equal(restored.history?.[0].content, "محتوای فعلی پیش از بازگردانی");
});

test("syncManager editing lock blocks reconcileWithServer while typing", async () => {
  syncManager.setEditingLock("notes", false);
  assert.equal(syncManager.isEditingLocked(), false);

  syncManager.setEditingLock("notes", true);
  assert.equal(syncManager.isEditingLocked(), true);

  const resultWhileLocked = await syncManager.reconcileWithServer();
  assert.equal(resultWhileLocked, false);

  syncManager.setEditingLock("notes", false);
  assert.equal(syncManager.isEditingLocked(), false);
});
