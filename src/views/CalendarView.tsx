import { useState, useMemo, useEffect } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Plus,
  Bell,
  BellOff,
  Clock,
  Edit3,
  Trash2,
  Search,
  X,
  LayoutGrid,
  Calendar as CalendarIcon,
} from "lucide-react";
import { CalendarEvent, CalendarEventInput } from "@/lib/store";
import {
  MONTH_NAMES,
  daysInJalaliMonth,
  firstDayWeekday,
  jalaliToGregorian,
  gregorianToJalali,
  getGregorianToday,
  getTodayJalali,
  toShamsi,
  toShamsiShort,
  toPersianDigits,
} from "@/lib/shamsi";
import {
  SOUND_PRESETS,
  getNotificationPermission,
  requestNotificationPermission,
} from "@/lib/notifications";
import { useThemeStyles } from "@/lib/useThemeStyles";
import ShamsiDatePicker from "@/components/shared/ShamsiDatePicker";

interface Props {
  events: CalendarEvent[];
  onAdd: (data: CalendarEventInput) => void;
  onUpdate: (id: string, data: Partial<CalendarEvent>) => void;
  onDelete: (id: string) => void;
}

type CalendarMode = "month" | "year";

const WEEK_DAYS_FULL = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه"];
const WEEK_DAYS_SHORT = ["ش", "ی", "د", "س", "چ", "پ", "ج"];

const EVENT_COLORS = [
  { hex: "#6366f1", label: "نیلی" },
  { hex: "#f59e0b", label: "کهربایی" },
  { hex: "#10b981", label: "سبز" },
  { hex: "#f43f5e", label: "قرمز" },
  { hex: "#0ea5e9", label: "آبی" },
  { hex: "#8b5cf6", label: "بنفش" },
];

export default function CalendarView({ events, onAdd, onUpdate, onDelete }: Props) {
  const { bg, fg, fgMuted, cardBg, cardBorder, inputBg, isDark } = useThemeStyles();

  const todayGreg = getGregorianToday();
  const [todayJy, todayJm] = getTodayJalali();

  const [mode, setMode] = useState<CalendarMode>("month");
  const [viewJy, setViewJy] = useState<number>(todayJy);
  const [viewJm, setViewJm] = useState<number>(todayJm);
  const [selectedGreg, setSelectedGreg] = useState<string>(todayGreg);
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Event Add / Edit Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [formTitle, setFormTitle] = useState("");
  const [formDate, setFormDate] = useState(todayGreg);
  const [formTime, setFormTime] = useState("");
  const [formReminderEnabled, setFormReminderEnabled] = useState(false);
  const [formReminderSound, setFormReminderSound] = useState("work");
  const [formColor, setFormColor] = useState(EVENT_COLORS[0].hex);
  const [formNote, setFormNote] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [notifPermission, setNotifPermission] = useState(() => getNotificationPermission());

  useEffect(() => {
    if (isModalOpen) {
      setNotifPermission(getNotificationPermission());
    }
  }, [isModalOpen]);

  // Index events by Gregorian YYYY-MM-DD date for O(1) lookup across grids
  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const ev of events) {
      const existing = map.get(ev.date);
      if (existing) {
        existing.push(ev);
      } else {
        map.set(ev.date, [ev]);
      }
    }
    return map;
  }, [events]);

  // Index events count by Shamsi "YYYY-MM" for quick year-view month summary
  const monthEventCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const ev of events) {
      const parts = ev.date.split("-").map(Number);
      if (parts.length !== 3 || parts.some(isNaN)) continue;
      const [jy, jm] = gregorianToJalali(parts[0], parts[1], parts[2]);
      const key = `${jy}-${jm}`;
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  }, [events]);

  const selectedDayEvents = useMemo(() => {
    return eventsByDate.get(selectedGreg) ?? [];
  }, [eventsByDate, selectedGreg]);

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return events.filter(
      (ev) =>
        ev.title.toLowerCase().includes(q) ||
        (ev.note && ev.note.toLowerCase().includes(q)) ||
        toShamsiShort(ev.date).includes(q)
    );
  }, [events, searchQuery]);

  // Navigation helpers
  const goToPrev = () => {
    if (mode === "year") {
      setViewJy((y) => y - 1);
      return;
    }
    if (viewJm === 1) {
      setViewJy((y) => y - 1);
      setViewJm(12);
    } else {
      setViewJm((m) => m - 1);
    }
  };

  const goToNext = () => {
    if (mode === "year") {
      setViewJy((y) => y + 1);
      return;
    }
    if (viewJm === 12) {
      setViewJy((y) => y + 1);
      setViewJm(1);
    } else {
      setViewJm((m) => m + 1);
    }
  };

  const goToToday = () => {
    const freshToday = getGregorianToday();
    const [ty, tm] = getTodayJalali();
    setViewJy(ty);
    setViewJm(tm);
    setSelectedGreg(freshToday);
  };

  const openMonthFromYear = (month: number, gregDate?: string) => {
    setViewJm(month);
    if (gregDate) {
      setSelectedGreg(gregDate);
    }
    setMode("month");
  };

  const jumpToEvent = (ev: CalendarEvent) => {
    const parts = ev.date.split("-").map(Number);
    if (parts.length === 3 && !parts.some(isNaN)) {
      const [jy, jm] = gregorianToJalali(parts[0], parts[1], parts[2]);
      setViewJy(jy);
      setViewJm(jm);
    }
    setSelectedGreg(ev.date);
    setMode("month");
    setSearchQuery("");
  };

  // Modal helpers
  const openCreateModal = (dateOverride?: string) => {
    setEditingEvent(null);
    setFormTitle("");
    setFormDate(dateOverride || selectedGreg);
    setFormTime("");
    setFormReminderEnabled(false);
    setFormReminderSound("work");
    setFormColor(EVENT_COLORS[0].hex);
    setFormNote("");
    setFormError(null);
    setIsModalOpen(true);
  };

  const openEditModal = (ev: CalendarEvent) => {
    setEditingEvent(ev);
    setFormTitle(ev.title);
    setFormDate(ev.date);
    setFormTime(ev.time || "");
    setFormReminderEnabled(Boolean(ev.reminder_enabled && ev.time));
    setFormReminderSound(ev.reminder_sound || "work");
    setFormColor(ev.color || EVENT_COLORS[0].hex);
    setFormNote(ev.note || "");
    setFormError(null);
    setIsModalOpen(true);
  };

  const handleSaveEvent = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedTitle = formTitle.trim();
    if (!trimmedTitle) {
      setFormError("لطفاً عنوان رویداد را وارد کنید.");
      return;
    }
    if (formReminderEnabled && !formTime) {
      setFormError("برای فعال‌سازی یادآور، ساعت رویداد را مشخص کنید.");
      return;
    }

    const payload: CalendarEventInput = {
      title: trimmedTitle,
      date: formDate,
      time: formTime || null,
      reminder_enabled: Boolean(formReminderEnabled && formTime),
      reminder_sound: formReminderSound,
      reminder_vibration: "heartbeat",
      color: formColor,
      note: formNote.trim(),
    };

    if (editingEvent) {
      onUpdate(editingEvent.id, payload);
    } else {
      onAdd(payload);
    }

    // Keep view synced to saved event date
    const parts = formDate.split("-").map(Number);
    if (parts.length === 3 && !parts.some(isNaN)) {
      const [jy, jm] = gregorianToJalali(parts[0], parts[1], parts[2]);
      setViewJy(jy);
      setViewJm(jm);
    }
    setSelectedGreg(formDate);
    setIsModalOpen(false);
  };

  const handleToggleEventReminder = (ev: CalendarEvent) => {
    if (!ev.time) {
      openEditModal({ ...ev, reminder_enabled: true });
      return;
    }
    onUpdate(ev.id, { reminder_enabled: !ev.reminder_enabled });
  };

  const handleEnableBrowserNotifications = async () => {
    const granted = await requestNotificationPermission();
    setNotifPermission(granted ? "granted" : getNotificationPermission());
  };

  // Monthly grid cells
  const monthTotalDays = daysInJalaliMonth(viewJy, viewJm);
  const monthFirstWeekday = firstDayWeekday(viewJy, viewJm);
  const monthCells = useMemo(() => {
    const totalSlots = Math.ceil((monthFirstWeekday + monthTotalDays) / 7) * 7;
    const cells: (number | null)[] = Array(totalSlots).fill(null);
    for (let d = 1; d <= monthTotalDays; d++) {
      cells[monthFirstWeekday + d - 1] = d;
    }
    return cells;
  }, [monthFirstWeekday, monthTotalDays]);

  const monthEventsTotal = monthEventCounts.get(`${viewJy}-${viewJm}`) || 0;
  const yearEventsTotal = useMemo(() => {
    let total = 0;
    for (let m = 1; m <= 12; m++) {
      total += monthEventCounts.get(`${viewJy}-${m}`) || 0;
    }
    return total;
  }, [monthEventCounts, viewJy]);

  return (
    <div className="space-y-4" dir="rtl">
      {/* Top Toolbar */}
      <div
        className="rounded-2xl border p-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between"
        style={{ backgroundColor: cardBg, borderColor: cardBorder }}
      >
        {/* Right side: View mode segmented control + Date navigator */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Segmented View Switcher */}
          <div
            className="inline-flex items-center p-1 rounded-xl border"
            style={{ backgroundColor: inputBg, borderColor: cardBorder }}
          >
            <button
              type="button"
              onClick={() => setMode("month")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                mode === "month"
                  ? "bg-indigo-500 text-white shadow-xs"
                  : "hover:bg-white/5"
              }`}
              style={mode === "month" ? undefined : { color: fgMuted }}
            >
              <CalendarIcon className="h-3.5 w-3.5" />
              <span>نمای ماهانه</span>
            </button>
            <button
              type="button"
              onClick={() => setMode("year")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                mode === "year"
                  ? "bg-indigo-500 text-white shadow-xs"
                  : "hover:bg-white/5"
              }`}
              style={mode === "year" ? undefined : { color: fgMuted }}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              <span>نمای سالانه</span>
            </button>
          </div>

          {/* Period Navigation */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={goToPrev}
              className="flex h-8 w-8 items-center justify-center rounded-lg border transition-colors hover:bg-white/10 cursor-pointer"
              style={{ borderColor: cardBorder, color: fgMuted }}
              title={mode === "month" ? "ماه قبل" : "سال قبل"}
            >
              <ChevronRight className="h-4 w-4" />
            </button>

            <div className="min-w-[130px] text-center px-2">
              <span className="text-sm font-bold tabular-nums" style={{ color: fg }}>
                {mode === "month"
                  ? `${MONTH_NAMES[viewJm - 1]} ${toPersianDigits(viewJy)}`
                  : `سال ${toPersianDigits(viewJy)}`}
              </span>
            </div>

            <button
              type="button"
              onClick={goToNext}
              className="flex h-8 w-8 items-center justify-center rounded-lg border transition-colors hover:bg-white/10 cursor-pointer"
              style={{ borderColor: cardBorder, color: fgMuted }}
              title={mode === "month" ? "ماه بعد" : "سال بعد"}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={goToToday}
              className="px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors hover:bg-white/10 whitespace-nowrap shrink-0 cursor-pointer"
              style={{ borderColor: cardBorder, color: fg }}
            >
              امروز
            </button>
          </div>
        </div>

        {/* Left side: Search + Primary CTA */}
        <div className="flex items-center gap-2.5 flex-wrap sm:flex-nowrap">
          <div
            className="flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs border flex-1 sm:w-56"
            style={{ backgroundColor: inputBg, borderColor: cardBorder }}
          >
            <Search className="h-3.5 w-3.5 shrink-0 opacity-60" style={{ color: fgMuted }} />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="جستجو در رویدادها..."
              className="w-full bg-transparent outline-none text-xs"
              style={{ color: fg }}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="opacity-60 hover:opacity-100 cursor-pointer"
                style={{ color: fgMuted }}
                title="پاک کردن جستجو"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => openCreateModal(selectedGreg)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white text-xs font-bold transition-colors whitespace-nowrap shrink-0 cursor-pointer shadow-xs"
          >
            <Plus className="h-4 w-4" />
            <span>افزودن رویداد</span>
          </button>
        </div>
      </div>

      {/* Live Search Results Panel */}
      {searchQuery.trim() && (
        <div
          className="rounded-2xl border p-4 space-y-2"
          style={{ backgroundColor: cardBg, borderColor: cardBorder }}
        >
          <div className="flex items-center justify-between text-xs" style={{ color: fgMuted }}>
            <span>
              نتایج جستجو · {toPersianDigits(searchResults.length)} رویداد
            </span>
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="hover:underline cursor-pointer"
            >
              بستن
            </button>
          </div>
          {searchResults.length === 0 ? (
            <p className="py-4 text-center text-xs" style={{ color: fgMuted }}>
              رویدادی مطابق با جستجوی شما یافت نشد.
            </p>
          ) : (
            <div className="divide-y" style={{ borderColor: cardBorder }}>
              {searchResults.map((ev) => (
                <button
                  key={ev.id}
                  type="button"
                  onClick={() => jumpToEvent(ev)}
                  className="w-full text-right py-2.5 px-2 flex items-center justify-between gap-3 hover:bg-white/5 rounded-lg transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className="h-2.5 w-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: ev.color || "#6366f1" }}
                    />
                    <span className="text-xs font-semibold truncate" style={{ color: fg }}>
                      {ev.title}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[11px] shrink-0 tabular-nums" style={{ color: fgMuted }}>
                    <span>{toShamsiShort(ev.date)}</span>
                    {ev.time && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{toPersianDigits(ev.time)}</span>
                      </>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* MONTHLY VIEW */}
      {mode === "month" ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
          {/* Calendar Month Grid */}
          <div
            className="lg:col-span-7 rounded-2xl border p-4 sm:p-5"
            style={{ backgroundColor: cardBg, borderColor: cardBorder }}
          >
            <div className="mb-4 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs" style={{ color: fgMuted }}>
                <span className="font-semibold" style={{ color: fg }}>
                  {MONTH_NAMES[viewJm - 1]} {toPersianDigits(viewJy)}
                </span>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">
                  {monthEventsTotal > 0
                    ? `${toPersianDigits(monthEventsTotal)} رویداد ثبت‌شده`
                    : "بدون رویداد"}
                </span>
              </div>

              {/* Quick month selector inside current year */}
              <select
                value={viewJm}
                onChange={(e) => setViewJm(Number(e.target.value))}
                aria-label="انتخاب ماه"
                className="rounded-lg border px-2.5 py-1 text-xs outline-none cursor-pointer"
                style={{ backgroundColor: inputBg, borderColor: cardBorder, color: fg }}
              >
                {MONTH_NAMES.map((name, idx) => (
                  <option key={name} value={idx + 1} style={{ backgroundColor: bg, color: fg }}>
                    {name}
                  </option>
                ))}
              </select>
            </div>

            {/* Weekday Header */}
            <div className="grid grid-cols-7 gap-1.5 mb-2">
              {WEEK_DAYS_FULL.map((dayName, idx) => (
                <div
                  key={dayName}
                  className="py-1.5 text-center text-[11px] font-semibold"
                  style={{ color: idx === 6 ? "#f87171" : fgMuted }}
                >
                  <span className="hidden sm:inline">{dayName}</span>
                  <span className="sm:hidden">{WEEK_DAYS_SHORT[idx]}</span>
                </div>
              ))}
            </div>

            {/* Days Grid */}
            <div className="grid grid-cols-7 gap-1.5">
              {monthCells.map((day, idx) => {
                if (day === null) {
                  return <div key={`empty-${idx}`} className="min-h-[54px] sm:min-h-[68px]" />;
                }

                const gregDate = jalaliToGregorian(viewJy, viewJm, day);
                const isToday = gregDate === todayGreg;
                const isSelected = gregDate === selectedGreg;
                const isFriday = idx % 7 === 6;
                const dayEvents = eventsByDate.get(gregDate) ?? [];
                const hasReminder = dayEvents.some((ev) => ev.reminder_enabled && ev.time);

                return (
                  <button
                    key={gregDate}
                    type="button"
                    onClick={() => setSelectedGreg(gregDate)}
                    className="min-h-[54px] sm:min-h-[68px] p-1.5 rounded-xl border flex flex-col items-center justify-between transition-all cursor-pointer relative"
                    style={{
                      backgroundColor: isSelected
                        ? "rgba(99,102,241,0.16)"
                        : isToday
                          ? "rgba(245,158,11,0.10)"
                          : isDark
                            ? "rgba(255,255,255,0.015)"
                            : "rgba(0,0,0,0.015)",
                      borderColor: isSelected
                        ? "#6366f1"
                        : isToday
                          ? "rgba(245,158,11,0.55)"
                          : cardBorder,
                    }}
                    aria-label={`${toPersianDigits(day)} ${MONTH_NAMES[viewJm - 1]}`}
                  >
                    <div className="w-full flex items-center justify-between">
                      <span
                        className="text-xs sm:text-sm font-bold tabular-nums leading-none"
                        style={{
                          color: isSelected
                            ? isDark ? "#c7d2fe" : "#4338ca"
                            : isToday
                              ? "#f59e0b"
                              : isFriday
                                ? "#f87171"
                                : fg,
                        }}
                      >
                        {toPersianDigits(day)}
                      </span>
                      {hasReminder && (
                        <Bell className="h-2.5 w-2.5 text-amber-500 shrink-0" />
                      )}
                    </div>

                    {/* Event Dots */}
                    <div className="w-full flex items-center justify-center gap-1 min-h-[10px]">
                      {dayEvents.slice(0, 3).map((ev) => (
                        <span
                          key={ev.id}
                          className="h-1.5 w-1.5 rounded-full shrink-0"
                          style={{ backgroundColor: ev.color || "#6366f1" }}
                        />
                      ))}
                      {dayEvents.length > 3 && (
                        <span className="text-[9px] font-bold tabular-nums" style={{ color: fgMuted }}>
                          +{toPersianDigits(dayEvents.length - 3)}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Selected Day Personal Events Panel */}
          <div
            className="lg:col-span-5 rounded-2xl border p-4 sm:p-5 flex flex-col"
            style={{ backgroundColor: cardBg, borderColor: cardBorder }}
          >
            <div
              className="pb-3.5 mb-3.5 border-b flex items-center justify-between gap-2"
              style={{ borderColor: cardBorder }}
            >
              <div className="min-w-0">
                <h2 className="text-sm font-bold truncate" style={{ color: fg }}>
                  {toShamsi(selectedGreg)}
                </h2>
                <p className="text-xs mt-0.5 tabular-nums" style={{ color: fgMuted }}>
                  {selectedGreg === todayGreg ? "امروز · " : ""}
                  {selectedDayEvents.length > 0
                    ? `${toPersianDigits(selectedDayEvents.length)} رویداد شخصی`
                    : "رویدادی ثبت نشده"}
                </p>
              </div>

              <button
                type="button"
                onClick={() => openCreateModal(selectedGreg)}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors hover:bg-white/5 whitespace-nowrap shrink-0 cursor-pointer"
                style={{ borderColor: cardBorder, color: fg }}
              >
                <Plus className="h-3.5 w-3.5 text-indigo-400" />
                <span>ثبت رویداد</span>
              </button>
            </div>

            {selectedDayEvents.length === 0 ? (
              <div className="py-12 px-4 flex flex-col items-center justify-center text-center space-y-3">
                <CalendarDays className="h-9 w-9 opacity-25" style={{ color: fgMuted }} />
                <div className="space-y-1">
                  <p className="text-xs font-semibold" style={{ color: fg }}>
                    این روز خالی است
                  </p>
                  <p className="text-[11px] opacity-75" style={{ color: fgMuted }}>
                    می‌توانید قرارها، مناسبت‌های شخصی یا یادآورهای خود را برای این روز ثبت کنید.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => openCreateModal(selectedGreg)}
                  className="px-4 py-2 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white text-xs font-semibold transition-colors cursor-pointer"
                >
                  افزودن رویداد برای این روز
                </button>
              </div>
            ) : (
              <div className="divide-y" style={{ borderColor: cardBorder }}>
                {selectedDayEvents.map((ev) => (
                  <div
                    key={ev.id}
                    className="py-3 first:pt-0 last:pb-0 flex items-start justify-between gap-3"
                  >
                    <div className="flex items-start gap-2.5 min-w-0 flex-1">
                      <span
                        className="mt-1.5 h-2.5 w-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: ev.color || "#6366f1" }}
                      />
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-xs sm:text-sm font-semibold break-words" style={{ color: fg }}>
                          {ev.title}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 text-[11px] tabular-nums" style={{ color: fgMuted }}>
                          {ev.time ? (
                            <span className="inline-flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              <span>{toPersianDigits(ev.time)}</span>
                            </span>
                          ) : (
                            <span>تمام روز</span>
                          )}
                          {ev.time && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className={ev.reminder_enabled ? "text-amber-500 font-medium" : ""}>
                                {ev.reminder_enabled ? "یادآور فعال" : "بدون یادآور"}
                              </span>
                            </>
                          )}
                        </div>
                        {ev.note && (
                          <p className="text-[11px] leading-relaxed opacity-80 break-words" style={{ color: fgMuted }}>
                            {ev.note}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleToggleEventReminder(ev)}
                        className="p-1.5 rounded-lg hover:bg-white/10 transition-colors cursor-pointer"
                        style={{ color: ev.reminder_enabled ? "#f59e0b" : fgMuted }}
                        title={ev.reminder_enabled ? "خاموش کردن یادآور" : "تنظیم یادآور"}
                      >
                        {ev.reminder_enabled ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => openEditModal(ev)}
                        className="p-1.5 rounded-lg hover:bg-white/10 transition-colors cursor-pointer"
                        style={{ color: fgMuted }}
                        title="ویرایش رویداد"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(ev.id)}
                        className="p-1.5 rounded-lg hover:bg-rose-500/10 text-rose-400 transition-colors cursor-pointer"
                        title="حذف رویداد"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* YEARLY VIEW: All 12 Shamsi Months */
        <div className="space-y-4">
          <div className="flex items-center justify-between px-1 text-xs" style={{ color: fgMuted }}>
            <span>
              مرور سال {toPersianDigits(viewJy)} ·{" "}
              <span className="tabular-nums">
                {yearEventsTotal > 0
                  ? `${toPersianDigits(yearEventsTotal)} رویداد در کل سال`
                  : "بدون رویداد در این سال"}
              </span>
            </span>
            <span>برای ورود به جزئیات، روی ماه یا روز کلیک کنید</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {MONTH_NAMES.map((monthName, monthIdx) => {
              const jm = monthIdx + 1;
              const daysCount = daysInJalaliMonth(viewJy, jm);
              const firstOffset = firstDayWeekday(viewJy, jm);
              const cells: (number | null)[] = Array(42).fill(null);
              for (let d = 1; d <= daysCount; d++) {
                cells[firstOffset + d - 1] = d;
              }
              const monthCount = monthEventCounts.get(`${viewJy}-${jm}`) || 0;
              const isCurrentMonth = viewJy === todayJy && jm === todayJm;

              return (
                <div
                  key={monthName}
                  className="rounded-2xl border p-3.5 flex flex-col"
                  style={{
                    backgroundColor: cardBg,
                    borderColor: isCurrentMonth ? "rgba(99,102,241,0.55)" : cardBorder,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => openMonthFromYear(jm)}
                    className="mb-2.5 pb-2 border-b flex items-center justify-between text-right hover:opacity-85 transition-opacity cursor-pointer"
                    style={{ borderColor: cardBorder }}
                  >
                    <span
                      className="text-xs font-bold"
                      style={{ color: isCurrentMonth ? "#818cf8" : fg }}
                    >
                      {monthName}
                    </span>
                    <span className="text-[10px] tabular-nums" style={{ color: monthCount > 0 ? "#f59e0b" : fgMuted }}>
                      {monthCount > 0 ? `${toPersianDigits(monthCount)} رویداد` : toPersianDigits(viewJy)}
                    </span>
                  </button>

                  {/* Mini Weekdays */}
                  <div className="grid grid-cols-7 gap-0.5 mb-1">
                    {WEEK_DAYS_SHORT.map((wd, wIdx) => (
                      <div
                        key={wd + wIdx}
                        className="text-center text-[10px] font-medium py-0.5"
                        style={{ color: wIdx === 6 ? "#f87171" : fgMuted }}
                      >
                        {wd}
                      </div>
                    ))}
                  </div>

                  {/* Mini Month Days */}
                  <div className="grid grid-cols-7 gap-0.5">
                    {cells.map((day, cellIdx) => {
                      if (day === null) {
                        return <div key={`m-${jm}-empty-${cellIdx}`} className="h-7" />;
                      }
                      const gregDate = jalaliToGregorian(viewJy, jm, day);
                      const isToday = gregDate === todayGreg;
                      const isSelected = gregDate === selectedGreg;
                      const isFriday = cellIdx % 7 === 6;
                      const dayEvents = eventsByDate.get(gregDate) ?? [];
                      const firstColor = dayEvents[0]?.color;
                      const tooltipText =
                        dayEvents.length > 0
                          ? dayEvents.map((ev) => ev.title).join("، ")
                          : undefined;

                      return (
                        <button
                          key={gregDate}
                          type="button"
                          onClick={() => openMonthFromYear(jm, gregDate)}
                          title={tooltipText}
                          className="h-7 rounded-md flex flex-col items-center justify-center relative text-[11px] tabular-nums font-medium transition-colors hover:bg-white/10 cursor-pointer"
                          style={{
                            backgroundColor: isToday
                              ? "#f59e0b"
                              : isSelected
                                ? "rgba(99,102,241,0.22)"
                                : "transparent",
                            color: isToday
                              ? "#ffffff"
                              : isFriday
                                ? "#f87171"
                                : fg,
                          }}
                        >
                          <span className="leading-none">{toPersianDigits(day)}</span>
                          {dayEvents.length > 0 && (
                            <span
                              className="h-1 w-1 rounded-full mt-0.5"
                              style={{ backgroundColor: isToday ? "#ffffff" : firstColor || "#6366f1" }}
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ADD / EDIT PERSONAL EVENT MODAL */}
      {isModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs"
          dir="rtl"
          onClick={() => setIsModalOpen(false)}
        >
          <form
            onSubmit={handleSaveEvent}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
            style={{ backgroundColor: bg, borderColor: cardBorder }}
          >
            <div
              className="px-5 py-3.5 border-b flex items-center justify-between"
              style={{ borderColor: cardBorder }}
            >
              <h3 className="text-sm font-bold" style={{ color: fg }}>
                {editingEvent ? "ویرایش رویداد تقویم" : "ثبت رویداد جدید"}
              </h3>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="p-1.5 rounded-lg hover:bg-white/10 transition-colors cursor-pointer"
                style={{ color: fgMuted }}
                aria-label="بستن"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 overflow-y-auto">
              {formError && (
                <div className="px-3 py-2 rounded-xl bg-rose-500/10 border border-rose-500/25 text-rose-400 text-xs">
                  {formError}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: fgMuted }}>
                  عنوان رویداد *
                </label>
                <input
                  type="text"
                  value={formTitle}
                  onChange={(e) => {
                    setFormTitle(e.target.value);
                    if (formError) setFormError(null);
                  }}
                  placeholder="مثلاً: قرار ملاقات، تمدید اشتراک، تولد..."
                  autoFocus
                  className="w-full rounded-xl px-3.5 py-2.5 text-sm border outline-none focus:ring-2 focus:ring-indigo-500"
                  style={{ backgroundColor: inputBg, borderColor: cardBorder, color: fg }}
                />
              </div>

              <ShamsiDatePicker
                value={formDate}
                onChange={(d) => setFormDate(d)}
                accentColorClass="indigo"
                label="تاریخ رویداد (شمسی)"
              />

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1.5" style={{ color: fgMuted }}>
                    ساعت (اختیاری)
                  </label>
                  <input
                    type="time"
                    value={formTime}
                    onChange={(e) => {
                      setFormTime(e.target.value);
                      if (formError) setFormError(null);
                    }}
                    className="w-full rounded-xl px-3 py-2 text-sm border outline-none focus:ring-2 focus:ring-indigo-500"
                    style={{ backgroundColor: inputBg, borderColor: cardBorder, color: fg }}
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium mb-1.5" style={{ color: fgMuted }}>
                    رنگ نشانگر
                  </label>
                  <div className="flex items-center gap-2 h-[38px]">
                    {EVENT_COLORS.map((c) => (
                      <button
                        key={c.hex}
                        type="button"
                        onClick={() => setFormColor(c.hex)}
                        aria-label={c.label}
                        className="h-6 w-6 rounded-full transition-transform cursor-pointer"
                        style={{
                          backgroundColor: c.hex,
                          transform: formColor === c.hex ? "scale(1.18)" : "scale(1)",
                          outline: formColor === c.hex ? `2px solid ${fg}` : "none",
                          outlineOffset: "2px",
                        }}
                      />
                    ))}
                  </div>
                </div>
              </div>

              {/* Reminder Toggle & Sound */}
              <div
                className="rounded-xl border p-3.5 space-y-3"
                style={{ borderColor: cardBorder, backgroundColor: cardBg }}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Bell className="h-4 w-4 text-amber-500 shrink-0" />
                    <div>
                      <p className="text-xs font-semibold" style={{ color: fg }}>
                        یادآور در ساعت مشخص
                      </p>
                      <p className="text-[10px]" style={{ color: fgMuted }}>
                        ارسال اعلان و زنگ هشدار در زمان رویداد
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={formReminderEnabled}
                    onClick={() => {
                      setFormReminderEnabled((v) => !v);
                      if (formError) setFormError(null);
                    }}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors cursor-pointer ${
                      formReminderEnabled ? "bg-indigo-500" : "bg-zinc-600/50"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        formReminderEnabled ? "-translate-x-6" : "-translate-x-1"
                      }`}
                    />
                  </button>
                </div>

                {formReminderEnabled && (
                  <div className="space-y-2.5 pt-2 border-t" style={{ borderColor: cardBorder }}>
                    <div>
                      <label className="block text-[11px] font-medium mb-1" style={{ color: fgMuted }}>
                        صدای یادآور
                      </label>
                      <select
                        value={formReminderSound}
                        onChange={(e) => setFormReminderSound(e.target.value)}
                        className="w-full rounded-lg border px-2.5 py-1.5 text-xs outline-none"
                        style={{ backgroundColor: inputBg, borderColor: cardBorder, color: fg }}
                      >
                        {SOUND_PRESETS.map((preset) => (
                          <option key={preset.id} value={preset.id} style={{ backgroundColor: bg, color: fg }}>
                            {preset.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    {notifPermission !== "granted" && notifPermission !== "unsupported" && (
                      <button
                        type="button"
                        onClick={handleEnableBrowserNotifications}
                        className="w-full py-1.5 px-3 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-500 text-[11px] font-semibold hover:bg-amber-500/20 transition-colors cursor-pointer"
                      >
                        فعال‌سازی مجوز اعلان مرورگر
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: fgMuted }}>
                  توضیحات (اختیاری)
                </label>
                <textarea
                  rows={2}
                  value={formNote}
                  onChange={(e) => setFormNote(e.target.value)}
                  placeholder="جزئیات یا یادداشت کوتاه..."
                  className="w-full rounded-xl px-3.5 py-2 text-xs border outline-none resize-none focus:ring-2 focus:ring-indigo-500"
                  style={{ backgroundColor: inputBg, borderColor: cardBorder, color: fg }}
                />
              </div>
            </div>

            <div
              className="px-5 py-3.5 border-t flex items-center justify-end gap-2"
              style={{ borderColor: cardBorder }}
            >
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="px-4 py-2 rounded-xl border text-xs font-semibold hover:bg-white/5 transition-colors cursor-pointer"
                style={{ borderColor: cardBorder, color: fgMuted }}
              >
                انصراف
              </button>
              <button
                type="submit"
                className="px-5 py-2 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white text-xs font-bold transition-colors cursor-pointer shadow-xs"
              >
                {editingEvent ? "ذخیره تغییرات" : "ثبت رویداد"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
