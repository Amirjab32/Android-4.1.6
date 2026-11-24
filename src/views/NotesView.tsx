import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import {
  Notebook,
  Plus,
  Trash2,
  Search,
  Pin,
  Copy,
  Check,
  Calendar,
  X,
  ChevronLeft,
  Bold,
  Clock,
  ListTodo,
  CheckSquare,
  Edit3,
  Maximize2,
  Minimize2,
  History,
  RotateCcw,
  Save,
  Lock
} from "lucide-react";
import { Note, NoteStore, NoteVersion } from "@/lib/store";
import { syncManager } from "@/lib/sync";
import { toShamsiShort, toPersianDigits, todayShamsiShort } from "@/lib/shamsi";
import { useThemeStyles } from "@/lib/useThemeStyles";

interface Props {
  notes: Note[];
  onAdd: (data: { title: string; content: string; folder: string; tags: string[] }) => void;
  onUpdate: (id: string, data: Partial<Note>) => void;
  onDelete: (id: string) => void;
}

type SaveStatus = "saved" | "typing" | "saving";

const AUTO_SAVE_DELAY_MS = 650;
const UNLOCK_DELAY_MS = 1200;

// Calculate checklist counts
function getChecklistStats(content: string) {
  const lines = (content || "").split("\n");
  let total = 0;
  let done = 0;
  for (const line of lines) {
    const match = line.match(/^\s*(☐|☑|\[ \]|\[x\]|- \[ \]| - \[x\])/i);
    if (match) {
      total++;
      if (match[1] === "☑" || match[1].toLowerCase().includes("x")) {
        done++;
      }
    }
  }
  return { total, done, hasChecklist: total > 0 };
}

export default function NotesView({ notes, onAdd, onUpdate, onDelete }: Props) {
  const { fg, fgMuted, cardBorder, inputBg, bg } = useThemeStyles();

  // States
  const [searchQuery, setSearchQuery] = useState("");
  const [activeNoteId, setActiveNoteId] = useState<string | null>(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem("focusflow_active_note_id") : null;
    if (saved && notes.some((n) => n.id === saved)) {
      return saved;
    }
    return notes.length > 0 ? notes[0].id : null;
  });
  const [showMobileEditor, setShowMobileEditor] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [interactiveMode, setInteractiveMode] = useState<boolean>(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem("focusflow_active_note_id") : null;
    const target = (saved && notes.find((n) => n.id === saved)) || (notes.length > 0 ? notes[0] : null);
    return target ? getChecklistStats(target.content).hasChecklist : false;
  });

  // Fullscreen & History states
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);

  const activeNote = notes.find((n) => n.id === activeNoteId) || null;

  // Local draft state (decouples typing from server polling & full-store re-renders)
  const [draftTitle, setDraftTitle] = useState(() => activeNote?.title ?? "");
  const [draftContent, setDraftContent] = useState(() => activeNote?.content ?? "");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");

  // Refs for reliable async / lifecycle flushing & DOM measurement
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const editorCanvasRef = useRef<HTMLDivElement>(null);

  const activeNoteIdRef = useRef<string | null>(activeNoteId);
  const loadedNoteIdRef = useRef<string | null>(activeNote?.id ?? null);
  const draftTitleRef = useRef(draftTitle);
  const draftContentRef = useRef(draftContent);
  const isDirtyRef = useRef(false);
  const pendingSelectNewestRef = useRef(false);
  const prevNoteIdsRef = useRef<string[]>(notes.map((n) => n.id));
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldFollowCaretRef = useRef(false);
  const pendingCaretPosRef = useRef<number | null>(null);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  activeNoteIdRef.current = activeNoteId;

  const clearTimers = useCallback(() => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    if (unlockTimerRef.current) {
      clearTimeout(unlockTimerRef.current);
      unlockTimerRef.current = null;
    }
  }, []);

  const acquireTypingLock = useCallback(() => {
    if (unlockTimerRef.current) {
      clearTimeout(unlockTimerRef.current);
      unlockTimerRef.current = null;
    }
    syncManager.setEditingLock("notes", true);
  }, []);

  const scheduleUnlockLock = useCallback(() => {
    if (unlockTimerRef.current) {
      clearTimeout(unlockTimerRef.current);
    }
    unlockTimerRef.current = setTimeout(() => {
      unlockTimerRef.current = null;
      if (!isDirtyRef.current) {
        syncManager.setEditingLock("notes", false);
      }
    }, UNLOCK_DELAY_MS);
  }, []);

  const flushDraft = useCallback(
    (releaseLockImmediately: boolean = false) => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }

      const targetId = activeNoteIdRef.current;
      if (!isDirtyRef.current || !targetId) {
        if (releaseLockImmediately) {
          if (unlockTimerRef.current) {
            clearTimeout(unlockTimerRef.current);
            unlockTimerRef.current = null;
          }
          syncManager.setEditingLock("notes", false);
        }
        return;
      }

      const titleToSave = draftTitleRef.current;
      const contentToSave = draftContentRef.current;
      isDirtyRef.current = false;
      setSaveStatus("saving");

      onUpdateRef.current(targetId, {
        title: titleToSave,
        content: contentToSave,
      });

      setSaveStatus("saved");

      if (releaseLockImmediately) {
        if (unlockTimerRef.current) {
          clearTimeout(unlockTimerRef.current);
          unlockTimerRef.current = null;
        }
        syncManager.setEditingLock("notes", false);
      } else {
        scheduleUnlockLock();
      }
    },
    [scheduleUnlockLock]
  );

  const scheduleAutoSave = useCallback(() => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }
    autoSaveTimerRef.current = setTimeout(() => {
      autoSaveTimerRef.current = null;
      flushDraft(false);
    }, AUTO_SAVE_DELAY_MS);
  }, [flushDraft]);

  const updateDraftTitle = useCallback(
    (nextTitle: string) => {
      draftTitleRef.current = nextTitle;
      setDraftTitle(nextTitle);
      isDirtyRef.current = true;
      setSaveStatus("typing");
      acquireTypingLock();
      scheduleAutoSave();
    },
    [acquireTypingLock, scheduleAutoSave]
  );

  const updateDraftContent = useCallback(
    (nextContent: string) => {
      draftContentRef.current = nextContent;
      setDraftContent(nextContent);
      isDirtyRef.current = true;
      setSaveStatus("typing");
      acquireTypingLock();
      scheduleAutoSave();
    },
    [acquireTypingLock, scheduleAutoSave]
  );

  // Auto-grow textarea height while strictly preserving scroll position
  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    const container = editorCanvasRef.current;
    if (!textarea) return;

    const prevScrollTop = container ? container.scrollTop : 0;
    textarea.style.height = "auto";
    const minHeight = isFullscreen ? 380 : 260;
    const nextHeight = Math.max(textarea.scrollHeight, minHeight);
    textarea.style.height = `${nextHeight}px`;

    if (container && container.scrollTop !== prevScrollTop) {
      container.scrollTop = prevScrollTop;
    }
  }, [isFullscreen]);

  // Measure actual wrapped RTL caret coordinates via mirror element and scroll parent container minimally
  const scrollCursorIntoView = useCallback((targetPos?: number) => {
    const textarea = textareaRef.current;
    const mirror = mirrorRef.current;
    const container = editorCanvasRef.current;
    if (!textarea || !container) return;

    const pos = targetPos !== undefined ? targetPos : (textarea.selectionStart ?? textarea.value.length);
    const computed = window.getComputedStyle(textarea);
    const lineHeight = parseFloat(computed.lineHeight) || 24;

    let caretTopOffset = 0;
    let caretHeight = lineHeight;

    if (mirror) {
      mirror.style.width = `${textarea.clientWidth}px`;
      mirror.style.font = computed.font;
      mirror.style.lineHeight = computed.lineHeight;
      mirror.style.letterSpacing = computed.letterSpacing;
      mirror.style.wordSpacing = computed.wordSpacing;
      mirror.style.paddingTop = computed.paddingTop;
      mirror.style.paddingRight = computed.paddingRight;
      mirror.style.paddingBottom = computed.paddingBottom;
      mirror.style.paddingLeft = computed.paddingLeft;
      mirror.style.direction = computed.direction;

      const value = textarea.value;
      const beforeText = value.substring(0, pos);
      const afterText = value.substring(pos);

      const caretMarker = document.createElement("span");
      caretMarker.setAttribute("data-caret", "true");
      caretMarker.textContent = "\u200b";

      mirror.replaceChildren(
        document.createTextNode(beforeText),
        caretMarker,
        document.createTextNode(afterText.length > 0 ? afterText : " ")
      );

      const mirrorRect = mirror.getBoundingClientRect();
      const markerRect = caretMarker.getBoundingClientRect();
      caretTopOffset = markerRect.top - mirrorRect.top;
      caretHeight = markerRect.height || lineHeight;
    } else {
      const textBefore = textarea.value.substring(0, pos);
      const lineCount = textBefore.split("\n").length;
      caretTopOffset = Math.max(0, (lineCount - 1) * lineHeight);
    }

    const textareaRect = textarea.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    const caretTopInContainer = textareaRect.top - containerRect.top + caretTopOffset;
    const caretBottomInContainer = caretTopInContainer + caretHeight;

    // Respect virtual keyboard height on mobile devices via visualViewport
    let effectiveVisibleHeight = container.clientHeight;
    if (typeof window !== "undefined" && window.visualViewport) {
      const vvBottom = window.visualViewport.offsetTop + window.visualViewport.height;
      const visibleBelowContainerTop = vvBottom - containerRect.top;
      if (visibleBelowContainerTop > 60 && visibleBelowContainerTop < effectiveVisibleHeight) {
        effectiveVisibleHeight = visibleBelowContainerTop;
      }
    }

    const bottomMargin = 28;
    const topMargin = 16;

    if (caretBottomInContainer > effectiveVisibleHeight - bottomMargin) {
      container.scrollTop += caretBottomInContainer - (effectiveVisibleHeight - bottomMargin);
    } else if (caretTopInContainer < topMargin) {
      container.scrollTop = Math.max(0, container.scrollTop + (caretTopInContainer - topMargin));
    }
  }, []);

  // Synchronously resize textarea whenever content, note, mode, or fullscreen changes
  useLayoutEffect(() => {
    if (interactiveMode || !activeNote) return;

    resizeTextarea();

    if (pendingCaretPosRef.current !== null) {
      const targetPos = pendingCaretPosRef.current;
      pendingCaretPosRef.current = null;
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.focus({ preventScroll: true });
        textarea.setSelectionRange(targetPos, targetPos);
        scrollCursorIntoView(targetPos);
      }
    } else if (shouldFollowCaretRef.current) {
      shouldFollowCaretRef.current = false;
      scrollCursorIntoView();
    }
  }, [draftContent, activeNote?.id, activeNote?.is_bold, interactiveMode, isFullscreen, resizeTextarea, scrollCursorIntoView]);

  // Recalculate textarea height on window/visualViewport resize (e.g. mobile keyboard open)
  useEffect(() => {
    const handleViewportChange = () => {
      if (!interactiveMode && activeNote) {
        resizeTextarea();
        if (document.activeElement === textareaRef.current) {
          requestAnimationFrame(() => scrollCursorIntoView());
        }
      }
    };

    window.addEventListener("resize", handleViewportChange);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", handleViewportChange);

    return () => {
      window.removeEventListener("resize", handleViewportChange);
      vv?.removeEventListener("resize", handleViewportChange);
    };
  }, [interactiveMode, activeNote, resizeTextarea, scrollCursorIntoView]);

  // Sync draft with incoming activeNote changes ONLY when not actively dirty
  useEffect(() => {
    if (!activeNote) {
      loadedNoteIdRef.current = null;
      draftTitleRef.current = "";
      draftContentRef.current = "";
      setDraftTitle("");
      setDraftContent("");
      isDirtyRef.current = false;
      setSaveStatus("saved");
      return;
    }

    const switchedNote = loadedNoteIdRef.current !== activeNote.id;
    if (switchedNote) {
      loadedNoteIdRef.current = activeNote.id;
      draftTitleRef.current = activeNote.title;
      draftContentRef.current = activeNote.content;
      setDraftTitle(activeNote.title);
      setDraftContent(activeNote.content);
      isDirtyRef.current = false;
      setSaveStatus("saved");
    } else if (!isDirtyRef.current) {
      if (draftTitleRef.current !== activeNote.title) {
        draftTitleRef.current = activeNote.title;
        setDraftTitle(activeNote.title);
      }
      if (draftContentRef.current !== activeNote.content) {
        draftContentRef.current = activeNote.content;
        setDraftContent(activeNote.content);
      }
    }
  }, [activeNote]);

  // Select newest created note or fallback if active note was deleted
  useEffect(() => {
    const prevIds = prevNoteIdsRef.current;
    const currentIds = notes.map((n) => n.id);
    prevNoteIdsRef.current = currentIds;

    if (pendingSelectNewestRef.current) {
      const newlyAdded = notes.find((n) => !prevIds.includes(n.id)) || notes[0];
      if (newlyAdded) {
        pendingSelectNewestRef.current = false;
        setActiveNoteId(newlyAdded.id);
        setShowMobileEditor(true);
        setInteractiveMode(false);
        return;
      }
    }

    if (notes.length > 0) {
      const activeExists = notes.some((n) => n.id === activeNoteId);
      if (!activeExists) {
        isDirtyRef.current = false;
        clearTimers();
        syncManager.setEditingLock("notes", false);
        const nextId = notes[0].id;
        setActiveNoteId(nextId);
        setShowMobileEditor(false);
        setInteractiveMode(getChecklistStats(notes[0].content).hasChecklist);
      }
    } else {
      isDirtyRef.current = false;
      clearTimers();
      syncManager.setEditingLock("notes", false);
      setActiveNoteId(null);
      setShowMobileEditor(false);
      setInteractiveMode(false);
      setIsFullscreen(false);
    }
  }, [notes, activeNoteId, clearTimers]);

  // Persist active note id and default checklist interactive mode on note switch
  useEffect(() => {
    if (activeNoteId) {
      if (typeof window !== "undefined") {
        localStorage.setItem("focusflow_active_note_id", activeNoteId);
      }
      const note = notes.find((n) => n.id === activeNoteId);
      if (note && getChecklistStats(note.content).hasChecklist) {
        setInteractiveMode(true);
        return;
      }
    }
    setInteractiveMode(false);
  }, [activeNoteId]);

  // Flush pending draft on visibility change, page unload, and unmount; always release sync lock on unmount
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushDraft(true);
      }
    };
    const handleBeforeUnload = () => {
      flushDraft(true);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      flushDraft(true);
      clearTimers();
      syncManager.setEditingLock("notes", false);
    };
  }, [flushDraft, clearTimers]);

  // Escape key handler for Fullscreen Focus Mode / History modal
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isHistoryOpen) {
          setIsHistoryOpen(false);
        } else if (isFullscreen) {
          setIsFullscreen(false);
        }
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [isFullscreen, isHistoryOpen]);

  const checklistStats = activeNote
    ? getChecklistStats(draftContent)
    : { total: 0, done: 0, hasChecklist: false };

  // Switch active note safely after flushing current edits
  const selectNote = (note: Note) => {
    if (note.id === activeNoteId) {
      setShowMobileEditor(true);
      return;
    }
    flushDraft(true);
    setActiveNoteId(note.id);
    setShowMobileEditor(true);
    setInteractiveMode(getChecklistStats(note.content).hasChecklist);
  };

  // Helper to insert text at textarea cursor without scroll jumps
  const insertAtCursor = (textToInsert: string) => {
    if (!activeNote) return;
    if (interactiveMode) {
      setInteractiveMode(false);
    }

    const textarea = textareaRef.current;
    const currentContent = draftContentRef.current;
    if (!textarea) {
      const appended = currentContent ? `${currentContent}\n${textToInsert}` : textToInsert;
      updateDraftContent(appended);
      return;
    }

    const start = textarea.selectionStart ?? currentContent.length;
    const end = textarea.selectionEnd ?? currentContent.length;
    const before = currentContent.substring(0, start);
    const after = currentContent.substring(end);

    const needsNewlineBefore = start > 0 && before[before.length - 1] !== "\n";
    const formattedInsert = (needsNewlineBefore ? "\n" : "") + textToInsert;

    const newContent = before + formattedInsert + after;
    const newPos = start + formattedInsert.length;

    pendingCaretPosRef.current = newPos;
    updateDraftContent(newContent);
  };

  // Insert current timestamp
  const handleInsertTimestamp = () => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const timeStr = toPersianDigits(`${pad(now.getHours())}:${pad(now.getMinutes())}`);
    const dateStr = todayShamsiShort();
    const stamp = `🕒 [${dateStr} | ${timeStr}] `;
    insertAtCursor(stamp);
  };

  // Insert checklist item
  const handleInsertChecklist = () => {
    insertAtCursor("☐ ");
  };

  // Auto-continue checklist on Enter, divider on -+-, and smooth downward cursor tracking
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const textarea = textareaRef.current;
      if (!textarea || !activeNote) return;
      const pos = textarea.selectionStart;
      const content = draftContentRef.current;

      const lastNewline = content.lastIndexOf("\n", pos - 1);
      const lineStart = lastNewline === -1 ? 0 : lastNewline + 1;
      const currentLine = content.substring(lineStart, pos);

      // ۱. تبدیل خودکار "-+-" به خط جداکننده سرتاسری و رفتن به سطر بعدی
      if (currentLine.trim() === "-+-") {
        e.preventDefault();
        const divider = "────────────────────────────────────────";
        const beforeLine = content.substring(0, lineStart);
        const afterPos = content.substring(pos);
        const newContent = `${beforeLine}${divider}\n${afterPos}`;
        const newPos = lineStart + divider.length + 1;
        pendingCaretPosRef.current = newPos;
        updateDraftContent(newContent);
        return;
      }

      // ۲. ادامه خودکار چک‌لیست در صورت بودن در سطر چک‌لیست
      const match = currentLine.match(/^(\s*)(☐|☑|\[ \]|\[x\]|- \[ \]| - \[x\])\s*(.*)$/i);
      if (match) {
        e.preventDefault();
        const indent = match[1];
        const rest = match[3];

        if (!rest.trim()) {
          const beforeLine = content.substring(0, lineStart);
          const afterPos = content.substring(pos);
          const newContent = beforeLine + afterPos;
          pendingCaretPosRef.current = lineStart;
          updateDraftContent(newContent);
          return;
        }

        const prefix = `${indent}☐ `;
        const before = content.substring(0, pos);
        const after = content.substring(pos);
        const newContent = `${before}\n${prefix}${after}`;
        const newPos = pos + 1 + prefix.length;
        pendingCaretPosRef.current = newPos;
        updateDraftContent(newContent);
        return;
      }

      // ۳. اینتر معمولی: پس از به‌روزرسانی ارتفاع در useLayoutEffect، اسکرول مکان‌نما را دنبال می‌کند
      shouldFollowCaretRef.current = true;
    }
  };

  // Toggle checklist item in interactive mode
  const toggleChecklistLine = (lineIndex: number) => {
    if (!activeNote) return;
    const lines = draftContentRef.current.split("\n");
    if (lineIndex < 0 || lineIndex >= lines.length) return;

    const line = lines[lineIndex];
    const match = line.match(/^(\s*)(☐|☑|\[ \]|\[x\]|- \[ \]| - \[x\])\s*(.*)$/i);
    if (!match) return;

    const indent = match[1];
    const marker = match[2];
    const rest = match[3];

    const isChecked = marker === "☑" || marker.toLowerCase().includes("x");
    const newMarker = isChecked ? "☐" : "☑";
    lines[lineIndex] = `${indent}${newMarker} ${rest}`;

    const nextContent = lines.join("\n");
    draftContentRef.current = nextContent;
    setDraftContent(nextContent);
    isDirtyRef.current = false;
    onUpdate(activeNote.id, { title: draftTitleRef.current, content: nextContent });
    setSaveStatus("saved");
  };

  // Render text line with timestamps as graphical badges
  const renderLineWithBadges = (text: string) => {
    const timestampRegex = /(?:🕒\s*)?\[\s*([۰-۹\d]{4}\/[۰-۹\d]{1,2}\/[۰-۹\d]{1,2})\s*[\|\-،]\s*([۰-۹\d]{1,2}:[۰-۹\d]{1,2}(?:\s*(?:صبح|عصر|ق\.ظ|ب\.ظ))?)\s*\]/g;
    const elements = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = timestampRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        elements.push(text.substring(lastIndex, match.index));
      }
      const datePart = match[1];
      const timePart = match[2];
      elements.push(
        <span
          key={match.index}
          className="inline-flex items-center gap-1 px-2 py-0.5 mx-1 rounded-md bg-amber-500/10 text-amber-500 border border-amber-500/25 text-[11px] font-medium align-middle select-none shadow-xs"
        >
          <Clock className="h-3 w-3 text-amber-500 shrink-0" />
          <span>{datePart}</span>
          <span className="opacity-40">|</span>
          <span>{timePart}</span>
        </span>
      );
      lastIndex = timestampRegex.lastIndex;
    }

    if (lastIndex < text.length) {
      elements.push(text.substring(lastIndex));
    }

    return elements.length > 0 ? elements : text;
  };

  // Handle note creation
  const handleCreateNote = () => {
    flushDraft(true);
    setInteractiveMode(false);
    pendingSelectNewestRef.current = true;
    onAdd({
      title: "یادداشت جدید",
      content: "",
      folder: "all",
      tags: [],
    });
  };

  // Version History actions
  const handleOpenHistory = () => {
    if (!activeNote) return;
    flushDraft(true);
    const historyList = activeNote.history || [];
    setSelectedVersionId(historyList[0]?.id ?? null);
    setHistoryNotice(null);
    setIsHistoryOpen(true);
  };

  const handleSaveSnapshotNow = () => {
    if (!activeNote) return;
    flushDraft(true);
    const updated = NoteStore.saveSnapshot(
      activeNote.id,
      draftTitleRef.current,
      draftContentRef.current
    );
    if (updated && updated.history && updated.history.length > 0) {
      setSelectedVersionId(updated.history[0].id);
      setHistoryNotice("نسخه فعلی با موفقیت ذخیره شد.");
      setTimeout(() => setHistoryNotice(null), 2200);
    }
  };

  const handleRestoreVersion = (version: NoteVersion) => {
    if (!activeNote) return;
    clearTimers();
    const restored = NoteStore.restoreVersion(
      activeNote.id,
      version.id,
      draftTitleRef.current,
      draftContentRef.current
    );
    if (restored) {
      draftTitleRef.current = restored.title;
      draftContentRef.current = restored.content;
      setDraftTitle(restored.title);
      setDraftContent(restored.content);
      isDirtyRef.current = false;
      setSaveStatus("saved");
      syncManager.setEditingLock("notes", false);
      setIsHistoryOpen(false);
      requestAnimationFrame(() => resizeTextarea());
    }
  };

  // Filter notes by search query
  const filteredNotes = notes.filter((note) => {
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const titleToMatch = note.id === activeNoteId ? draftTitle : note.title;
      const contentToMatch = note.id === activeNoteId ? draftContent : note.content;
      const matchTitle = titleToMatch.toLowerCase().includes(q);
      const matchContent = contentToMatch.toLowerCase().includes(q);
      return matchTitle || matchContent;
    }
    return true;
  });

  // Copy note helper
  const handleCopyNote = () => {
    if (!activeNote) return;
    const fullText = `${draftTitleRef.current}\n\n${draftContentRef.current}`;
    navigator.clipboard.writeText(fullText).then(() => {
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 1500);
    });
  };

  const getWordCount = (str: string) => {
    const clean = str.trim();
    return clean ? clean.split(/\s+/).length : 0;
  };

  const historyVersions = activeNote?.history ?? [];
  const selectedVersion =
    historyVersions.find((v) => v.id === selectedVersionId) || historyVersions[0] || null;

  return (
    <div className="mx-auto max-w-4xl w-full flex-1 min-h-0 flex flex-col" dir="rtl">
      <div
        className="grid grid-cols-1 md:grid-cols-12 overflow-hidden rounded-2xl border flex-1 min-h-0"
        style={{ borderColor: cardBorder, backgroundColor: bg }}
      >
        {/* COLUMN 1: MINIMALIST SIDEBAR (Notes List) */}
        <div
          className={`md:col-span-4 border-l flex flex-col h-full min-h-0 overflow-hidden ${showMobileEditor ? "hidden md:flex" : "flex"}`}
          style={{ borderColor: cardBorder }}
        >
          {/* Header & Quick Search */}
          <div className="p-4 space-y-3 border-b" style={{ borderColor: cardBorder }}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold tracking-wide uppercase opacity-75" style={{ color: fgMuted }}>
                یادداشت‌ها
              </span>
              <button
                onClick={handleCreateNote}
                className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500 hover:bg-amber-600 text-white transition-colors cursor-pointer shadow-sm"
                title="یادداشت جدید"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>

            {/* Apple Notes style minimalist search input */}
            <div
              className="flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs border"
              style={{ backgroundColor: inputBg, borderColor: cardBorder }}
            >
              <Search className="h-3.5 w-3.5 opacity-60" style={{ color: fgMuted }} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="جستجو..."
                className="w-full bg-transparent outline-none text-xs"
                style={{ color: fg }}
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery("")} className="text-gray-400 hover:text-white cursor-pointer">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Minimalist Cards List */}
          <div className="flex-1 min-h-0 overflow-y-auto divide-y" style={{ borderColor: cardBorder }}>
            {filteredNotes.length === 0 ? (
              <div className="py-16 text-center text-xs opacity-60" style={{ color: fgMuted }}>
                یادداشتی وجود ندارد
              </div>
            ) : (
              filteredNotes.map((note) => {
                const isActive = note.id === activeNoteId;
                const displayTitle = isActive ? draftTitle : note.title;
                const displayContent = isActive ? draftContent : note.content;
                const stats = getChecklistStats(displayContent);
                const previewText = displayContent.trim()
                  ? displayContent.trim().substring(0, 40) + (displayContent.length > 40 ? "..." : "")
                  : "بدون متن";

                return (
                  <div
                    key={note.id}
                    onClick={() => selectNote(note)}
                    className="w-full text-right p-3.5 transition-all cursor-pointer relative group block border-r-2"
                    style={{
                      borderRightColor: isActive ? "#f59e0b" : "transparent",
                      backgroundColor: isActive ? "rgba(245,158,11,0.04)" : "transparent",
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h4
                        className="text-xs font-bold truncate flex-1"
                        style={{ color: isActive ? "#f59e0b" : fg }}
                      >
                        {displayTitle || "بدون عنوان"}
                      </h4>
                      <div className="flex items-center gap-1 shrink-0 text-[10px] opacity-60" style={{ color: fgMuted }}>
                        {note.is_pinned && <Pin className="h-3 w-3 text-amber-500 fill-amber-500" />}
                        <span>{toPersianDigits(toShamsiShort(note.created_date))}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 mt-1">
                      {stats.hasChecklist && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] font-mono text-amber-500 bg-amber-500/10 px-1.5 py-0.2 rounded border border-amber-500/20 shrink-0">
                          <CheckSquare className="h-2.5 w-2.5" />
                          <span>
                            {toPersianDigits(stats.done)}/{toPersianDigits(stats.total)}
                          </span>
                        </span>
                      )}
                      <p
                        className={`text-[11px] truncate opacity-70 flex-1 ${note.is_bold ? "font-bold text-amber-500/90" : ""}`}
                        style={{ color: note.is_bold ? undefined : fgMuted }}
                      >
                        {previewText}
                      </p>
                    </div>

                    {/* Minimalist delete on hover */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        flushDraft(true);
                        onDelete(note.id);
                      }}
                      className="absolute left-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-1 rounded-md bg-rose-500/10 hover:bg-rose-500 text-rose-400 hover:text-white transition-all cursor-pointer"
                      title="حذف یادداشت"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* COLUMN 2: ZEN EDITOR WORKSPACE (supports seamless fullscreen focus mode without unmounting textarea) */}
        <div
          className={
            isFullscreen
              ? "fixed inset-0 z-[45] flex flex-col overflow-hidden"
              : `md:col-span-8 flex flex-col h-full min-h-0 overflow-hidden ${showMobileEditor ? "flex" : "hidden md:flex"}`
          }
          style={isFullscreen ? { backgroundColor: bg } : undefined}
        >
          {activeNote ? (
            <>
              {/* Workspace Top Bar */}
              <div
                className="px-4 py-3 flex items-center justify-between border-b shrink-0"
                style={{ borderColor: cardBorder }}
              >
                {/* Back to list on mobile (hidden in fullscreen) */}
                {!isFullscreen && (
                  <button
                    onClick={() => {
                      flushDraft(true);
                      setShowMobileEditor(false);
                    }}
                    className="md:hidden flex items-center gap-1 text-xs font-bold"
                    style={{ color: fg }}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    <span>یادداشت‌ها</span>
                  </button>
                )}

                {isFullscreen && (
                  <div className="flex items-center gap-2 text-xs font-semibold" style={{ color: fgMuted }}>
                    <Notebook className="h-4 w-4 text-amber-500 shrink-0" />
                    <span className="truncate max-w-[160px] sm:max-w-xs" style={{ color: fg }}>
                      {draftTitle || "بدون عنوان"}
                    </span>
                  </div>
                )}

                {/* Left Side utilities */}
                <div className="flex items-center gap-1 sm:gap-1.5 mr-auto flex-wrap">
                  {/* دکمه درج تاریخ و ساعت جاری */}
                  <button
                    onClick={handleInsertTimestamp}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all hover:bg-amber-500/15 text-amber-500 cursor-pointer border border-amber-500/30 shadow-xs"
                    title="درج تاریخ و ساعت فعلی در موقعیت مکان‌نما"
                  >
                    <Clock className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline text-[11px]">زمان فعلی</span>
                  </button>

                  {/* دکمه درج چک‌لیست */}
                  <button
                    onClick={handleInsertChecklist}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all hover:bg-amber-500/15 text-amber-500 cursor-pointer border border-amber-500/30 shadow-xs"
                    title="درج سطر چک‌لیست جدید"
                  >
                    <ListTodo className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline text-[11px]">چک‌لیست</span>
                  </button>

                  {/* دکمه حالت تعاملی و تیک‌زدن */}
                  <button
                    onClick={() => {
                      flushDraft(true);
                      setInteractiveMode(!interactiveMode);
                    }}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer border ${
                      interactiveMode
                        ? "bg-amber-500 text-white border-amber-500 shadow-sm"
                        : "hover:bg-white/5 border-white/10 text-amber-400"
                    }`}
                    title={interactiveMode ? "بازگشت به ویرایشگر متنی" : "حالت مطالعه و تیک‌زدن چک‌لیست"}
                  >
                    {interactiveMode ? <Edit3 className="h-3.5 w-3.5" /> : <CheckSquare className="h-3.5 w-3.5" />}
                    <span className="hidden sm:inline text-[11px]">{interactiveMode ? "ویرایش" : "تیک‌زدن"}</span>
                  </button>

                  <div className="h-4 w-[1px] bg-white/10 mx-0.5" />

                  {/* دکمه تاریخچه تغییرات یادداشت */}
                  <button
                    onClick={handleOpenHistory}
                    className="relative p-1.5 rounded-lg transition-colors cursor-pointer hover:bg-white/5 flex items-center gap-1"
                    style={{ color: historyVersions.length > 0 ? "#f59e0b" : fgMuted }}
                    title="تاریخچه تغییرات و بازگردانی نسخه‌ها"
                  >
                    <History className="h-4 w-4" />
                    {historyVersions.length > 0 && (
                      <span className="text-[10px] font-bold px-1 rounded bg-amber-500/15 text-amber-500">
                        {toPersianDigits(historyVersions.length)}
                      </span>
                    )}
                  </button>

                  {/* دکمه حالت تمرکز تمام‌صفحه */}
                  <button
                    onClick={() => setIsFullscreen((prev) => !prev)}
                    className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                      isFullscreen ? "bg-amber-500/15 text-amber-500" : "hover:bg-white/5"
                    }`}
                    style={{ color: isFullscreen ? "#f59e0b" : fgMuted }}
                    title={isFullscreen ? "خروج از حالت تمام‌صفحه" : "حالت تمرکز تمام‌صفحه"}
                  >
                    {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                  </button>

                  <button
                    onClick={() => {
                      flushDraft(true);
                      onUpdate(activeNote.id, { is_bold: !activeNote.is_bold });
                    }}
                    className="p-1.5 rounded-lg transition-colors cursor-pointer hover:bg-white/5"
                    style={{ color: activeNote.is_bold ? "#f59e0b" : fgMuted }}
                    title={activeNote.is_bold ? "حذف حالت بولد" : "حالت بولد یادداشت"}
                  >
                    <Bold className={`h-4 w-4 ${activeNote.is_bold ? "text-amber-500 font-bold" : ""}`} />
                  </button>

                  <button
                    onClick={() => {
                      flushDraft(true);
                      onUpdate(activeNote.id, { is_pinned: !activeNote.is_pinned });
                    }}
                    className="p-1.5 rounded-lg transition-colors cursor-pointer hover:bg-white/5"
                    style={{ color: activeNote.is_pinned ? "#f59e0b" : fgMuted }}
                    title={activeNote.is_pinned ? "برداشتن پین" : "پین کردن یادداشت"}
                  >
                    <Pin className={`h-4 w-4 ${activeNote.is_pinned ? "fill-amber-500 text-amber-500" : ""}`} />
                  </button>

                  <button
                    onClick={handleCopyNote}
                    className="p-1.5 rounded-lg hover:bg-white/5 transition-colors cursor-pointer"
                    style={{ color: copySuccess ? "#10b981" : fgMuted }}
                    title="کپی متن"
                  >
                    {copySuccess ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                  </button>

                  <button
                    onClick={() => {
                      flushDraft(true);
                      onDelete(activeNote.id);
                    }}
                    className="p-1.5 rounded-lg hover:bg-rose-500/10 text-rose-400 transition-colors cursor-pointer"
                    title="حذف یادداشت"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Pure Elegant Zen Canvas */}
              <div
                ref={editorCanvasRef}
                className={`flex-1 min-h-0 overflow-y-auto ${isFullscreen ? "px-5 py-6 sm:px-10 sm:py-8" : "p-6"}`}
              >
                <div className={isFullscreen ? "max-w-3xl mx-auto w-full flex flex-col space-y-4 pb-16" : "flex flex-col space-y-4 pb-10"}>
                  <input
                    type="text"
                    value={draftTitle}
                    onChange={(e) => updateDraftTitle(e.target.value)}
                    onBlur={() => flushDraft(false)}
                    placeholder="عنوان یادداشت..."
                    className={`w-full bg-transparent font-bold outline-none border-b pb-2 tracking-tight ${
                      isFullscreen ? "text-xl" : "text-lg"
                    }`}
                    style={{ color: fg, borderColor: `${cardBorder}33` }}
                  />

                  {!interactiveMode ? (
                    <>
                      {/* Minimal banner when checklist exists */}
                      {checklistStats.hasChecklist && (
                        <div
                          onClick={() => {
                            flushDraft(true);
                            setInteractiveMode(true);
                          }}
                          className="flex items-center justify-between px-3.5 py-1.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs cursor-pointer hover:bg-amber-500/15 transition-colors"
                        >
                          <div className="flex items-center gap-2">
                            <CheckSquare className="h-4 w-4 text-amber-500" />
                            <span className="font-semibold text-amber-500">
                              چک‌لیست: {toPersianDigits(checklistStats.done)} از {toPersianDigits(checklistStats.total)} مورد تیک خورده است
                            </span>
                          </div>
                          <span className="text-[11px] text-amber-500 font-bold underline">
                            ورود به حالت تیک‌زدن ←
                          </span>
                        </div>
                      )}

                      {/* Auto-growing textarea + invisible mirror for exact RTL wrapped caret position */}
                      <div className="relative w-full shrink-0">
                        <div
                          ref={mirrorRef}
                          aria-hidden="true"
                          dir="rtl"
                          className={`pointer-events-none invisible absolute inset-x-0 top-0 -z-10 whitespace-pre-wrap break-words text-sm leading-relaxed ${
                            activeNote.is_bold ? "font-bold" : ""
                          }`}
                        />
                        <textarea
                          ref={textareaRef}
                          value={draftContent}
                          onChange={(e) => {
                            shouldFollowCaretRef.current = true;
                            updateDraftContent(e.target.value);
                          }}
                          onBlur={() => flushDraft(false)}
                          onKeyDown={handleKeyDown}
                          placeholder="شروع به تایپ کنید..."
                          rows={8}
                          className={`w-full block bg-transparent resize-none outline-none overflow-hidden text-sm leading-relaxed ${
                            isFullscreen ? "min-h-[380px]" : "min-h-[260px]"
                          } ${activeNote.is_bold ? "font-bold" : ""}`}
                          style={{ color: fg }}
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      {/* Interactive Banner */}
                      <div className="flex items-center justify-between px-3.5 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs">
                        <div className="flex items-center gap-2">
                          <CheckSquare className="h-4 w-4 text-amber-500" />
                          <span className="font-semibold text-amber-500">
                            {checklistStats.hasChecklist
                              ? `پیشرفت چک‌لیست: ${toPersianDigits(checklistStats.done)} از ${toPersianDigits(checklistStats.total)} (${toPersianDigits(
                                  Math.round((checklistStats.done / (checklistStats.total || 1)) * 100)
                                )}٪)`
                              : "حالت مطالعه تعاملی و نمایش گرافیکی تاریخ‌ها"}
                          </span>
                        </div>
                        <button
                          onClick={() => setInteractiveMode(false)}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-500 text-white font-bold text-[11px] transition-colors shadow-xs hover:bg-amber-600 cursor-pointer"
                        >
                          <Edit3 className="h-3 w-3" />
                          <span>ویرایش متن</span>
                        </button>
                      </div>

                      {/* Interactive lines list */}
                      <div
                        className={`flex-1 space-y-1.5 leading-relaxed text-sm ${activeNote.is_bold ? "font-bold" : ""}`}
                        style={{ color: fg }}
                      >
                        {draftContent.split("\n").map((line, idx) => {
                          const match = line.match(/^(\s*)(☐|☑|\[ \]|\[x\]|- \[ \]| - \[x\])\s*(.*)$/i);
                          if (match) {
                            const isChecked = match[2] === "☑" || match[2].toLowerCase().includes("x");
                            const text = match[3];
                            return (
                              <div
                                key={idx}
                                className="flex items-start gap-2.5 group py-1 px-2 rounded-lg hover:bg-white/5 transition-colors cursor-pointer select-none"
                                onClick={() => toggleChecklistLine(idx)}
                              >
                                <button
                                  type="button"
                                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-all cursor-pointer ${
                                    isChecked
                                      ? "bg-amber-500 border-amber-500 text-white"
                                      : "border-gray-400/50 hover:border-amber-500"
                                  }`}
                                >
                                  {isChecked && <Check className="h-3 w-3 stroke-[3]" />}
                                </button>
                                <div className={`flex-1 ${isChecked ? "line-through opacity-50" : ""}`}>
                                  {renderLineWithBadges(text)}
                                </div>
                              </div>
                            );
                          }

                          // خط جداکننده سرتاسری
                          if (line.trim() === "-+-" || /^[-─—_]{3,}$/.test(line.trim())) {
                            return (
                              <div key={idx} className="my-2.5 flex items-center py-1">
                                <div className="w-full border-t border-amber-500/30" />
                              </div>
                            );
                          }

                          if (!line.trim()) {
                            return <div key={idx} className="h-3" />;
                          }

                          return (
                            <div key={idx} className="py-0.5 px-2">
                              {renderLineWithBadges(line)}
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Status footer bar */}
              <div
                className="px-5 py-2.5 border-t flex items-center justify-between text-[10px] shrink-0 gap-2"
                style={{ borderColor: cardBorder, backgroundColor: "rgba(128,128,128,0.01)" }}
              >
                <div className="flex items-center gap-3">
                  <span style={{ color: fgMuted }}>{toPersianDigits(getWordCount(draftContent))} کلمه</span>
                  {saveStatus === "typing" ? (
                    <span className="inline-flex items-center gap-1 text-amber-500 font-medium">
                      <Lock className="h-3 w-3" />
                      <span>در حال نوشتن • همگام‌سازی قفل</span>
                    </span>
                  ) : saveStatus === "saving" ? (
                    <span className="text-amber-500 font-medium">در حال ذخیره...</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-emerald-500/80 font-medium">
                      <Check className="h-3 w-3" />
                      <span>ذخیره شد</span>
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1 opacity-70" style={{ color: fgMuted }}>
                  <Calendar className="h-3 w-3" />
                  <span>
                    آخرین ویرایش:{" "}
                    {toPersianDigits(
                      new Date(activeNote.updated_at).toLocaleTimeString("fa-IR", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    )}
                  </span>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-8 space-y-3">
              <Notebook className="h-10 w-10 opacity-20" />
              <p className="text-xs opacity-60" style={{ color: fgMuted }}>
                هیچ یادداشتی باز نیست
              </p>
              <button
                onClick={handleCreateNote}
                className="rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-bold text-white hover:bg-amber-600 transition-colors shadow-sm cursor-pointer"
              >
                ایجاد یادداشت جدید
              </button>
            </div>
          )}
        </div>
      </div>

      {/* VERSION HISTORY PREVIEW & RESTORE MODAL */}
      {isHistoryOpen && activeNote && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs"
          dir="rtl"
          onClick={() => setIsHistoryOpen(false)}
        >
          <div
            className="w-full max-w-3xl max-h-[85vh] rounded-2xl border shadow-2xl flex flex-col overflow-hidden"
            style={{ backgroundColor: bg, borderColor: cardBorder }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div
              className="px-5 py-3.5 border-b flex items-center justify-between gap-3"
              style={{ borderColor: cardBorder }}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="h-8 w-8 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-500 shrink-0">
                  <History className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-bold truncate" style={{ color: fg }}>
                    تاریخچه تغییرات یادداشت
                  </h3>
                  <p className="text-[11px] truncate opacity-70" style={{ color: fgMuted }}>
                    {draftTitle || "بدون عنوان"}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={handleSaveSnapshotNow}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 text-amber-500 border border-amber-500/30 text-xs font-semibold transition-colors cursor-pointer"
                >
                  <Save className="h-3.5 w-3.5" />
                  <span>ذخیره نسخه الان</span>
                </button>
                <button
                  onClick={() => setIsHistoryOpen(false)}
                  className="p-1.5 rounded-lg hover:bg-white/10 transition-colors cursor-pointer"
                  style={{ color: fgMuted }}
                  title="بستن"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {historyNotice && (
              <div className="px-5 py-2 bg-emerald-500/10 border-b border-emerald-500/20 text-emerald-400 text-xs font-medium">
                {historyNotice}
              </div>
            )}

            {/* Modal Content */}
            {historyVersions.length === 0 ? (
              <div className="p-10 flex flex-col items-center justify-center text-center space-y-3">
                <History className="h-10 w-10 opacity-25" style={{ color: fgMuted }} />
                <p className="text-sm font-semibold" style={{ color: fg }}>
                  هنوز نسخه‌ای در تاریخچه ثبت نشده است
                </p>
                <p className="text-xs max-w-md leading-relaxed opacity-75" style={{ color: fgMuted }}>
                  هنگام ویرایش‌های مداوم به صورت خودکار نسخه پشتیبان ثبت می‌شود. همچنین می‌توانید همین الان یک نسخه از وضعیت فعلی ذخیره کنید.
                </p>
              </div>
            ) : (
              <div className="flex-1 grid grid-cols-1 md:grid-cols-12 min-h-[340px] overflow-hidden">
                {/* Snapshots List */}
                <div
                  className="md:col-span-4 border-b md:border-b-0 md:border-l overflow-y-auto divide-y max-h-48 md:max-h-full"
                  style={{ borderColor: cardBorder }}
                >
                  {historyVersions.map((version, index) => {
                    const isSelected = selectedVersion?.id === version.id;
                    const dateStr = toPersianDigits(toShamsiShort(new Date(version.saved_at)));
                    const timeStr = toPersianDigits(
                      new Date(version.saved_at).toLocaleTimeString("fa-IR", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    );
                    const wordsCount = toPersianDigits(getWordCount(version.content));
                    const snippet = version.content.trim()
                      ? version.content.trim().substring(0, 48) + (version.content.length > 48 ? "..." : "")
                      : "بدون متن";

                    return (
                      <button
                        key={version.id}
                        type="button"
                        onClick={() => setSelectedVersionId(version.id)}
                        className="w-full text-right p-3.5 transition-colors cursor-pointer block border-r-2"
                        style={{
                          borderRightColor: isSelected ? "#f59e0b" : "transparent",
                          backgroundColor: isSelected ? "rgba(245,158,11,0.08)" : "transparent",
                        }}
                      >
                        <div className="flex items-center justify-between gap-2 text-[11px]">
                          <span className="font-bold" style={{ color: isSelected ? "#f59e0b" : fg }}>
                            {index === 0 ? "آخرین نسخه ثبت‌شده" : `نسخه ${toPersianDigits(historyVersions.length - index)}`}
                          </span>
                          <span className="opacity-70" style={{ color: fgMuted }}>
                            {timeStr}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2 mt-1 text-[10px] opacity-65" style={{ color: fgMuted }}>
                          <span>{dateStr}</span>
                          <span>{wordsCount} کلمه</span>
                        </div>
                        <p className="text-[11px] truncate mt-1.5 opacity-75" style={{ color: fgMuted }}>
                          {snippet}
                        </p>
                      </button>
                    );
                  })}
                </div>

                {/* Preview Pane */}
                <div className="md:col-span-8 flex flex-col overflow-hidden">
                  {selectedVersion && (
                    <>
                      <div
                        className="px-5 py-3 border-b flex items-center justify-between gap-3"
                        style={{ borderColor: cardBorder }}
                      >
                        <div className="min-w-0">
                          <h4 className="text-sm font-bold truncate" style={{ color: fg }}>
                            {selectedVersion.title || "بدون عنوان"}
                          </h4>
                          <span className="text-[11px] opacity-70" style={{ color: fgMuted }}>
                            {toPersianDigits(toShamsiShort(new Date(selectedVersion.saved_at)))} •{" "}
                            {toPersianDigits(
                              new Date(selectedVersion.saved_at).toLocaleTimeString("fa-IR", {
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            )}{" "}
                            • {toPersianDigits(getWordCount(selectedVersion.content))} کلمه
                          </span>
                        </div>

                        <button
                          onClick={() => handleRestoreVersion(selectedVersion)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold transition-colors shadow-sm cursor-pointer shrink-0"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          <span>بازگردانی این نسخه</span>
                        </button>
                      </div>

                      <div className="flex-1 overflow-y-auto p-5 space-y-1.5 text-sm leading-relaxed" style={{ color: fg }}>
                        {selectedVersion.content ? (
                          selectedVersion.content.split("\n").map((line, idx) => {
                            const match = line.match(/^(\s*)(☐|☑|\[ \]|\[x\]|- \[ \]| - \[x\])\s*(.*)$/i);
                            if (match) {
                              const isChecked = match[2] === "☑" || match[2].toLowerCase().includes("x");
                              return (
                                <div key={idx} className="flex items-start gap-2 py-0.5">
                                  <span
                                    className={`mt-1 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[10px] ${
                                      isChecked
                                        ? "bg-amber-500 border-amber-500 text-white"
                                        : "border-gray-400/50"
                                    }`}
                                  >
                                    {isChecked && <Check className="h-2.5 w-2.5 stroke-[3]" />}
                                  </span>
                                  <span className={isChecked ? "line-through opacity-50" : ""}>
                                    {renderLineWithBadges(match[3])}
                                  </span>
                                </div>
                              );
                            }
                            if (line.trim() === "-+-" || /^[-─—_]{3,}$/.test(line.trim())) {
                              return (
                                <div key={idx} className="my-2 flex items-center py-0.5">
                                  <div className="w-full border-t border-amber-500/30" />
                                </div>
                              );
                            }
                            if (!line.trim()) {
                              return <div key={idx} className="h-3" />;
                            }
                            return <div key={idx}>{renderLineWithBadges(line)}</div>;
                          })
                        ) : (
                          <p className="text-xs opacity-60" style={{ color: fgMuted }}>
                            این نسخه بدون متن است.
                          </p>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

