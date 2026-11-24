# PROJECT_NOTES.md — FocusFlow Task & Habit Manager (v4.1.1)

## 1. Overview & Tech Stack
- **Product**: Persian/RTL (`dir="rtl"`) personal productivity suite with Jalali (Shamsi) calendar, prayer times, offline-first sync, and PWA/Android support.
- **Frontend**: React 19, TypeScript (`~5.8`), Vite 6 (`vite-plugin-singlefile`), Tailwind CSS v4 (`@tailwindcss/vite`), Framer Motion (`framer-motion` / `motion`), Lucide React, Recharts, `@hello-pangea/dnd`.
- **Mobile / PWA**: Capacitor 8 (`capacitor.config.ts`, `android/`, `@capacitor/local-notifications`), `public/sw.js` (`focusflow-cache-v8`), `public/manifest.json`, `src/lib/usePWAInstall.ts`.
- **Design System**: Refer to `PROJECT_DESIGN_BLUEPRINT.md` & `CLAUDE.md` (Deep Dark `#0d0d0d`, Sidebar `#111111`, Indigo `#6366f1` accent, `toPersianDigits`, RTL-only). Note: `AppShell.tsx` footer displays `نسخه ۴.۱.۱` (matching `package.json`).

## 2. Dual-Engine Backend & Deployment
- **Local / Node Server (`server.ts`)**: Express + Vite middleware on port `3000` (`npm run dev` / `npm start`). Stores DB in `save/db.json` (atomic `.tmp` swap + empty-overwrite protection), runs 3-hour Jalali-dated backups in `save/backups/YYYY-M-D/{1..8}/db.json` (10-day retention), serves `/api/network-ips`, and handles `/api/shared-files` (multer, up to 250MB in `save/shared-files/`).
- **Cloudflare Worker (`src/worker.ts` & `wrangler.jsonc`)**: Feature parity on Edge (`npm run deploy:cf`) using `DB_KV` (DB + 3h backups), `FILES_BUCKET` (R2, optional), `ASSETS` (SPA), and Cron (`*/15 * * * *`).
- **API Routes**: `GET/POST /api/db`, `GET /api/backups`, `POST /api/backups/restore`, `GET /api/network-ips`, `GET /api/shared-files`, `POST /api/shared-files/upload`, `GET /api/shared-files/download/:filename`, `DELETE /api/shared-files/:filename`.

## 3. App Architecture & Navigation (`src/App.tsx` -> `src/components/AppShell.tsx`)
- `AppShell.tsx` wraps `ErrorBoundary` -> `ThemeProvider` -> `PullToRefresh` -> sticky `TopBar` + optional `PrayerTimelineBar` + `PlannerFloatingTimer` + `Sidebar` + active view + global modals (`BackupModal`, `DeleteConfirmationModal`, `IntroStressOverlay`).
- **11 Views (`src/lib/navigation.ts`, `src/views/*`)**:
  - `tasks` (`TaskManagerView.tsx`): Task creation (`TaskForm`), priority, `#tags`, recurring activities (`RecurringActivityStore`), interval timers, smart subtask timing (`TaskItem.tsx` + `subtaskTiming.ts`: Active focus mode, Delta fallback, manual check/uncheck rollback, inline minute edit), JSON tag-filtered import/export (`taskExchange.ts`).
  - `kanban` (`KanbanView.tsx`): Drag-and-drop columns (`todo`, `in_progress`, `done`) synced with task timers/intervals and active subtask flushes.
  - `planner` (`PlannerView.tsx`): Hourly/slot day planner with planned vs actual lanes, live slot timer (`PlannerTimerService`), presets (`PlannerPresetStore`), threshold scoring, Recharts analytics, link modal (`PlannerLinkModal`).
  - `calendar` (`CalendarView.tsx`): Monthly/yearly Jalali calendar + personal `CalendarEvent` reminders.
  - `habits` (`HabitTrackerView.tsx`): Daily habit matrix, groups (`HabitGroupStore`), streaks (`calculateHabitStreak`), pinned system habit, `HabitMonthModal`, `HabitReminderModal`.
  - `going_up` (`GoingUpView.tsx`): Anti-distraction/discipline tracker (`rope` / `no_rope` modes, WebAudio siren, cooldowns, daily violation history).
  - `srs` (`SRSView.tsx`): Spaced repetition (`StudyTopic`, intervals `[1,3,7,14,30,60]`) + SRS reminder settings.
  - `quiz` (`QuizTrackerView.tsx`): Subject/chapter test & question count tracker (`QuizSubjectStore`, `QuizEntryStore`).
  - `motivation` (`MotivationView.tsx`): Konkur / final exams countdowns & bitter memories (`MotivationStore`).
  - `notes` (`NotesView.tsx`): Fixed-viewport (`h-dvh`) categorized notes, interactive checklists (`☐`/`☑`), timestamp badges, version `history` (`NoteVersion`), auto-save with sync editing lock.
  - `settings` (`SettingsView.tsx`): Categorized settings (general, menu visibility/start view via `appSettings.ts`, theme, motivation dates, prayer city/reminders, server URL/sync/backup).

## 4. Core State, Sync & Services (`src/lib/*`)
- **State (`src/lib/store.ts`)**: `localStorage`-backed stores (`TaskStore`, `RecurringActivityStore`, `HabitStore`, `HabitGroupStore`, `TopicStore`, `SrsReminderStore`, `QuizSubjectStore`, `QuizEntryStore`, `TimelineEntryStore`, `NoteStore`, `PlannerStore`, `PlannerPresetStore`, `MotivationStore`, `CalendarEventStore`). Mutations call `markLocalModified()` and dispatch `focusflow-data-changed`. Unified `exportDatabase()` / `importDatabase()` cover all `BACKUP_KEYS` + preferences + custom audio + active timer. Optional `Task` fields (`active_subtask_key`, `active_subtask_started_at`, `last_subtask_checkpoint_seconds`, `subtask_timings`) are stored additively only when tracked and preserved across `exportTasksJSON()` / `importTasksJSON()` and sync/backup.
- **Sync (`src/lib/sync.ts`)**: `syncManager` polls/pushes to `getApiBaseUrl()` (`DEFAULT_CLOUDFLARE_URL` on Capacitor native, `""` relative on web, or `focusflow_server_url`). Includes `isLocalDrasticallyDepleted()` guard, `setEditingLock()` (used by Notes), `HAS_UNPUSHED_CHANGES_KEY`, `FORCE_PUSH_PENDING_KEY`, and `focusflow-db-synced` / `focusflow-sync-status-changed` events.
- **Offline & Snapshots**: `offlineQueue.ts` (IndexedDB `focusflow_offline_queue_db`), `localSnapshots.ts` (IndexedDB `focusflow_snapshots_db`, max 20 snapshots).
- **Date, Time & Prayer**: `shamsi.ts` (Gregorian <-> Jalali conversion, `toPersianDigits`, `toShamsi`), `prayerTimes.ts` (offline Tehran Geophysics formula + `IRAN_CITIES`), `timeCheck.ts` (HEAD `/api/db` clock-drift check).
- **Audio & Notifications**: `notifications.ts` (browser `Notification` + Capacitor `LocalNotifications`, presets & custom sounds, reminder scheduler), `audioStorage.ts` (IndexedDB custom MP3 storage synced via base64 in `focusflow_custom_audio_sounds`).
- **Intro & Safety**: `introTiming.ts` (3-hour check + mid-flow session resume for `IntroStressOverlay`), `confirmAndDelete()` (`request-delete` event gated by `focusflow_safe_mode`).

## 5. Key UI Components (`src/components/*`)
- **Layout**: `TopBar.tsx` (Jalali/Gregorian date, drift alert, PWA install, sync pill, alarm guide trigger, `ThemeToggle`), `Sidebar.tsx` (RTL drawer, visible nav items, safe-mode toggle, backup modal trigger, 5s-countdown full wipe).
- **Shared**: `BackupModal.tsx` (JSON export/import, local snapshots, server 3h backups, LAN file transfer), `JalaliCalendar.tsx`, `ShamsiDatePicker.tsx`, `DelayedTagDelete.tsx`, `AlarmPermissionGuideModal.tsx`, `DeleteConfirmationModal.tsx`.

## 6. Scripts, Tests & Conventions
- **Scripts**: `npm run dev` (`tsx server.ts`), `npm run build` (`vite build`), `npm run lint` (`tsc --noEmit`), `npm run deploy:cf`.
- **Unit Tests**: `src/lib/*.test.ts` (`appSettings`, `calendarEvents`, `introTiming`, `manualBackup`, `notesHistory`, `prayerTimes`, `shamsi`, `subtaskTiming`, `taskExchange`).
- **Conventions**: Preserve `#0d0d0d` dark palette & RTL Persian UI; route deletions through `confirmAndDelete()`; keep `PROJECT_NOTES.md` synced on architectural/schema/route/file changes.
