import { useEffect, useMemo, useRef, useState } from "react";
import { getNow } from "./dateUtils";
import YearDotsIndicator from "./YearDotsIndicator";

type Subtask = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: string;
  completedAt: string | null;
};

type Task = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: string;
  completedAt: string | null;
  subtasks?: Subtask[];
  /** When true, parent stays completed even if a subtask is unchecked. */
  manuallyCompleted?: boolean;
};

const STORAGE_KEY = "52-to-do:tasks";
const JOIN_WEEK_STORAGE_KEY = "52-to-do:joinWeek";
const LAST_SEEN_YEAR_KEY = "52-to-do:lastSeenYear";
const YEAR_SUMMARY_KEY = "52-to-do:yearSummaries";
const LAST_WEEKLY_CHECKIN_WEEK_KEY = "52-to-do:lastWeeklyCheckinWeekKey";
const APP_INSTALL_TIMESTAMP_KEY = "52-to-do:appInstallTimestamp";
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

type Theme = "light" | "dark";

/** ISO week-of-year (1–53) and ISO year. Weeks start Monday; week 1 contains Jan 4. No external deps. */
function getISOWeek(date: Date): { isoYear: number; isoWeek: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7; // 1..7 (Mon..Sun)
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Thursday of this ISO week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return { isoYear: d.getUTCFullYear(), isoWeek: weekNo };
}

/** Week key in YYYY-WW format (e.g. "2026-05") for ISO week. */
function getWeekKey(d: Date): string {
  const { isoWeek, isoYear } = getISOWeek(d);
  return `${isoYear}-${String(isoWeek).padStart(2, "0")}`;
}

type JoinWeekSnapshot = { joinWeek: number; year: number } | null;

const WEEKS_IN_GRID = 52;
const MS_PER_DAY = 86400000;
const SANITIZE_FUTURE_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

/** Start of day (local) in ms. For rolling 7-day week math only; not ISO. */
function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Real current time for task timestamps. Never use getNow()/preview for storing createdAt/completedAt. */
function realNowISO(): string {
  return new Date().toISOString();
}

/**
 * Sanitize task timestamps that are in the future (e.g. from corrupted/simulated data).
 * If createdAt or completedAt is > realNow + 5 min, clamp to realNow. Returns new array only if changed.
 */
function sanitizeTaskTimestamps(
  tasks: Task[],
  realNow: Date = new Date()
): { tasks: Task[]; changed: boolean } {
  const threshold = realNow.getTime() + SANITIZE_FUTURE_TOLERANCE_MS;
  const nowStr = realNow.toISOString();
  let changed = false;
  const out = tasks.map((t) => {
    let taskChanged = false;
    let createdAt = t.createdAt;
    if (new Date(createdAt).getTime() > threshold) {
      createdAt = nowStr;
      taskChanged = true;
    }
    let completedAt = t.completedAt;
    if (completedAt != null && new Date(completedAt).getTime() > threshold) {
      completedAt = nowStr;
      taskChanged = true;
    }
    const subs = (t.subtasks ?? []).map((s) => {
      let sCreated = s.createdAt;
      if (new Date(sCreated).getTime() > threshold) {
        sCreated = nowStr;
        taskChanged = true;
      }
      let sCompleted = s.completedAt;
      if (sCompleted != null && new Date(sCompleted).getTime() > threshold) {
        sCompleted = nowStr;
        taskChanged = true;
      }
      return { ...s, createdAt: sCreated, completedAt: sCompleted };
    });
    if (taskChanged) changed = true;
    if (!taskChanged) return t;
    return { ...t, createdAt, completedAt, subtasks: subs };
  });
  return { tasks: changed ? out : tasks, changed };
}

/**
 * Single source of truth for calendar/pace metrics. All UI (dots, weeksLeft, tasks-vs-week)
 * must read from this only.
 * Calendar (calendarWeekNow, weeksLeftCalendar, dot grid, ISO year) is ALWAYS derived from
 * real-time new Date() inside this function.
 */
function getYearMetrics(
  joinWeekSnapshot: JoinWeekSnapshot,
  tasks: Task[]
): {
  now: Date;
  isoYearNow: number;
  calendarWeekNow: number;
  joinWeek: number | null;
  paceWeeks: number;
  weeksLeftCalendar: number;
  tasksCompleted: number;
  tasksCompletedSinceJoin: number;
  targetTasksThisYear: number;
  onPace: boolean;
  currentWeek: number;
  paceStatus: PaceStatus;
  tasksPercentage: number;
} {
  const realNow = new Date();
  const { isoYear: isoYearNow, isoWeek: calendarWeekNow } = getISOWeek(realNow);
  const weeksLeftCalendar = Math.max(
    0,
    WEEKS_IN_GRID - Math.min(WEEKS_IN_GRID, calendarWeekNow)
  );
  const year = realNow.getFullYear();

  const completedThisYear = tasks.filter((t) => {
    if (!t.completed || !t.completedAt) return false;
    const d = new Date(t.completedAt);
    return !Number.isNaN(d.getTime()) && d.getFullYear() === year;
  });

  /** First task created in current calendar year (earliest createdAt). Used for Tasks Completed denominator. */
  const tasksInCurrentYear = tasks.filter(
    (t) => new Date(t.createdAt).getFullYear() === year
  );
  const firstTaskAtForYear =
    tasksInCurrentYear.length > 0
      ? tasksInCurrentYear.reduce((min, t) =>
          t.createdAt < min ? t.createdAt : min
        , tasksInCurrentYear[0].createdAt)
      : null;

  let targetTasksThisYear: number;
  let tasksCompleted: number;
  if (firstTaskAtForYear == null) {
    targetTasksThisYear = 52;
    tasksCompleted = 0;
  } else {
    const joinWeekForDenom = getISOWeek(new Date(firstTaskAtForYear)).isoWeek;
    targetTasksThisYear = Math.min(
      52,
      Math.max(1, 52 - joinWeekForDenom + 1)
    );
    tasksCompleted = tasks.filter(
      (t) =>
        t.completed &&
        t.completedAt &&
        t.createdAt >= firstTaskAtForYear
    ).length;
  }

  /** Tasks vs. Week: rolling 7-day windows from first task this year. No ISO. */
  const startDate = firstTaskAtForYear;
  const weeksElapsed = startDate
    ? Math.max(
        1,
        Math.floor(
          (startOfDay(realNow) - startOfDay(new Date(startDate))) /
            (7 * MS_PER_DAY)
        ) + 1
      )
    : 0;
  const tasksCompletedSinceStart = tasks.filter(
    (t) =>
      t.completed === true &&
      t.completedAt != null &&
      startDate != null &&
      t.completedAt >= startDate
  ).length;

  const paceWeeks = weeksElapsed;
  const tasksCompletedSinceJoin = tasksCompletedSinceStart;
  const onPace =
    weeksElapsed > 0 && tasksCompletedSinceStart >= weeksElapsed;

  let paceStatus: PaceStatus;
  if (!onPace && weeksElapsed > 0) paceStatus = "behind";
  else if (onPace && weeksElapsed > 0) paceStatus = "onTrack";
  else paceStatus = "behind";

  /** joinWeek for dot grid only (prejoin styling); derived from first task this year. */
  const joinWeek =
    firstTaskAtForYear != null
      ? getISOWeek(new Date(firstTaskAtForYear)).isoWeek
      : null;

  const tasksPercentage =
    targetTasksThisYear > 0
      ? Math.min(100, Math.max(0, (tasksCompleted / targetTasksThisYear) * 100))
      : 0;

  return {
    now: realNow,
    isoYearNow,
    calendarWeekNow,
    joinWeek,
    paceWeeks,
    weeksLeftCalendar,
    tasksCompleted,
    tasksCompletedSinceJoin,
    targetTasksThisYear,
    onPace,
    currentWeek: calendarWeekNow > 52 ? 52 : calendarWeekNow,
    paceStatus,
    tasksPercentage
  };
}

function getLastWeeklyCheckinWeekKey(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(LAST_WEEKLY_CHECKIN_WEEK_KEY);
}

function setLastWeeklyCheckinWeekKey(key: string) {
  if (typeof window === "undefined") return;
  if (__isPreview) return;
  try {
    window.localStorage.setItem(LAST_WEEKLY_CHECKIN_WEEK_KEY, key);
  } catch {
    // ignore
  }
}

function getAppInstallTimestamp(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(APP_INSTALL_TIMESTAMP_KEY);
    if (raw === null) return null;
    const ts = parseInt(raw, 10);
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

function setAppInstallTimestamp(ts: number) {
  if (typeof window === "undefined") return;
  if (__isPreview) return;
  try {
    window.localStorage.setItem(APP_INSTALL_TIMESTAMP_KEY, String(ts));
  } catch {
    // ignore
  }
}

/** True if at least 24h have passed since install (or no timestamp yet). If no timestamp, sets it to now and returns false. */
function isPastInstallCooldown(): boolean {
  if (typeof window === "undefined") return false;
  let ts = getAppInstallTimestamp();
  if (ts === null) {
    ts = Date.now();
    setAppInstallTimestamp(ts);
    return false;
  }
  return Date.now() - ts >= COOLDOWN_MS;
}

type YearSummary = {
  year: number;
  tasksCompleted: number;
  streakWeeks: number;
  paceWeeks: number;
};
type PaceStatus = "behind" | "onTrack" | "ahead";

function loadTasks(): Task[] {
  if (typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Task[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((t) => ({
      ...t,
      completedAt: t.completedAt ?? null,
      subtasks: (t.subtasks ?? []).map((s: Subtask) => ({
        ...s,
        completedAt: s.completedAt ?? null
      })),
      manuallyCompleted: t.manuallyCompleted ?? false
    }));
  } catch {
    return [];
  }
}

let __isPreview = false;
function setPreviewActive(active: boolean) {
  __isPreview = active;
}

function saveTasks(tasks: Task[]) {
  if (typeof window === "undefined") return;
  if (__isPreview) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch {
    // ignore
  }
}

function getDayOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 1);
  const diff = date.getTime() - start.getTime();
  const oneDayMs = 24 * 60 * 60 * 1000;
  return Math.floor(diff / oneDayMs) + 1;
}

function getWeekFromDate(date: Date): number {
  const dayOfYear = getDayOfYear(date);
  const week = Math.ceil(dayOfYear / 7);
  return Math.min(52, Math.max(1, week));
}

function getCurrentWeek(): number {
  return getWeekFromDate(getNow());
}

function getStoredJoinWeek(): { joinWeek: number; year: number } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(JOIN_WEEK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { joinWeek: number; year: number };
    const now = getNow();
    if (parsed.year !== now.getFullYear()) return null;
    const w = Number(parsed.joinWeek);
    if (!Number.isInteger(w) || w < 1 || w > 52) return null;
    return { joinWeek: w, year: parsed.year };
  } catch {
    return null;
  }
}

function saveJoinWeek(joinWeek: number, year: number) {
  if (typeof window === "undefined") return;
  if (__isPreview) return;
  try {
    window.localStorage.setItem(
      JOIN_WEEK_STORAGE_KEY,
      JSON.stringify({ joinWeek, year })
    );
  } catch {
    // ignore
  }
}

function getLastSeenYear(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_SEEN_YEAR_KEY);
    if (raw === null) return null;
    const y = parseInt(raw, 10);
    return Number.isInteger(y) ? y : null;
  } catch {
    return null;
  }
}

function setLastSeenYear(year: number) {
  if (typeof window === "undefined") return;
  if (__isPreview) return;
  try {
    window.localStorage.setItem(LAST_SEEN_YEAR_KEY, String(year));
  } catch {
    // ignore
  }
}

function loadYearSummaries(): YearSummary[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(YEAR_SUMMARY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((s: Record<string, unknown>) => ({
      year: Number(s.year),
      tasksCompleted: Number(s.tasksCompleted),
      streakWeeks: Number(s.streakWeeks),
      paceWeeks: Number(s.paceWeeks ?? s.totalWeeksTracked ?? 52)
    }));
  } catch {
    return [];
  }
}

function appendYearSummary(summary: YearSummary) {
  if (typeof window === "undefined") return;
  if (__isPreview) return;
  try {
    const list = loadYearSummaries();
    list.push(summary);
    window.localStorage.setItem(YEAR_SUMMARY_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}

/** Longest consecutive weeks (1–52) with at least one task completed in the given year. */
function getLongestStreak(tasks: Task[], year: number): number {
  const weeks = new Set<number>();
  for (const task of tasks) {
    if (!task.completed || !task.completedAt) continue;
    const d = new Date(task.completedAt);
    if (Number.isNaN(d.getTime()) || d.getFullYear() !== year) continue;
    weeks.add(getWeekFromDate(d));
  }
  if (weeks.size === 0) return 0;
  const sorted = Array.from(weeks).sort((a, b) => a - b);
  let max = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1] + 1) run++;
    else run = 1;
    if (run > max) max = run;
  }
  return max;
}

/**
 * True when the task has at least one subtask and every subtask is completed.
 * Used to auto-complete parent when the last subtask is checked.
 */
function areAllSubtasksCompleted(task: Task): boolean {
  const subs = task.subtasks ?? [];
  return subs.length > 0 && subs.every((s) => s.completed);
}

/**
 * If all subtasks are completed, returns parent with completed=true and completedAt set.
 * Otherwise returns the task unchanged. Does not set manuallyCompleted (parent remains
 * auto-completed, so unchecking a subtask will uncomplete the parent unless it was manually completed).
 */
function syncParentCompletionFromSubtasks(task: Task): Task {
  if (!areAllSubtasksCompleted(task)) return task;
  return {
    ...task,
    completed: true,
    completedAt: task.completedAt ?? realNowISO()
  };
}

function formatDateTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  });
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
}

function App() {
  /** Canonical list: all tasks (todo + completed). Single source of truth for list and metrics. */
  const [tasks, setTasks] = useState<Task[]>([]);
  const [input, setInput] = useState("");
  const [isPaceCelebrationActive, setIsPaceCelebrationActive] =
    useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  /** When true, metrics may use preview data; canonical tasks are never written. Persistence is disabled. */
  const [isPreview, setIsPreview] = useState(false);
  const [taskSegment, setTaskSegment] = useState<"todo" | "completed">("todo");
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [subtaskInput, setSubtaskInput] = useState("");
  const addSubtaskInputRef = useRef<HTMLInputElement>(null);
  const [joinWeekSnapshot, setJoinWeekSnapshot] = useState<{
    joinWeek: number;
    year: number;
  } | null>(getStoredJoinWeek);
  const [yearEndModal, setYearEndModal] = useState<{
    previousYear: number;
    tasksCompleted: number;
    streakWeeks: number;
    paceWeeks: number;
    achieved: boolean;
  } | null>(null);
  const hasCheckedYearRef = useRef(false);
  const hasCheckedCheckinRef = useRef(false);

  const { weekKey, completedThisWeekCount } = useMemo(() => {
    const now = getNow();
    const key = getWeekKey(now);
    let count = 0;
    for (const t of tasks) {
      if (!t.completed || !t.completedAt) continue;
      const d = new Date(t.completedAt);
      if (Number.isNaN(d.getTime())) continue;
      if (getWeekKey(d) === key) count++;
    }
    return { weekKey: key, completedThisWeekCount: count };
  }, [tasks]);

  const [checkinModal, setCheckinModal] = useState<{ source: "real" | "simulate" } | null>(null);

  useEffect(() => {
    setPreviewActive(isPreview);
    return () => setPreviewActive(false);
  }, [isPreview]);

  useEffect(() => {
    const raw = loadTasks();
    const { tasks: sanitized, changed } = sanitizeTaskTimestamps(raw);
    setTasks(changed ? sanitized : raw);
  }, []);

  useEffect(() => {
    if (hasCheckedYearRef.current) return;
    const currentYear = getNow().getFullYear();
    const lastSeen = getLastSeenYear();
    if (lastSeen === null) {
      setLastSeenYear(currentYear);
      hasCheckedYearRef.current = true;
      return;
    }
    if (lastSeen < currentYear) {
      const tasksForYear = tasks.filter((t) => {
        if (!t.completed || !t.completedAt) return false;
        const d = new Date(t.completedAt);
        return !Number.isNaN(d.getTime()) && d.getFullYear() === lastSeen;
      });
      const count = tasksForYear.length;
      const streakWeeks = getLongestStreak(tasks, lastSeen);
      const paceWeeksForYear =
        joinWeekSnapshot && joinWeekSnapshot.year === lastSeen
          ? Math.min(52, Math.max(1, 52 - joinWeekSnapshot.joinWeek + 1))
          : 52;
      const achieved = paceWeeksForYear > 0 && count / paceWeeksForYear >= 1;
      setYearEndModal({
        previousYear: lastSeen,
        tasksCompleted: count,
        streakWeeks,
        paceWeeks: paceWeeksForYear,
        achieved
      });
      hasCheckedYearRef.current = true;
    } else {
      hasCheckedYearRef.current = true;
    }
  }, [tasks]);

  useEffect(() => {
    saveTasks(tasks);
  }, [tasks]);

  useEffect(() => {
    applyTheme("dark");
  }, []);

  useEffect(() => {
    if (!hasCheckedYearRef.current) return;
    if (yearEndModal != null) return;
    if (hasCheckedCheckinRef.current) return;
    if (import.meta.env.DEV && typeof window !== "undefined") {
      const q = new URLSearchParams(window.location.search).get("checkin");
      if (q === "1") {
        hasCheckedCheckinRef.current = true;
        setCheckinModal({ source: "simulate" });
        return;
      }
    }
    const last = getLastWeeklyCheckinWeekKey();
    if (weekKey === last) {
      hasCheckedCheckinRef.current = true;
      return;
    }
    setLastWeeklyCheckinWeekKey(weekKey);
    hasCheckedCheckinRef.current = true;
    if (completedThisWeekCount > 0) return;
    if (!isPastInstallCooldown()) return;
    setCheckinModal({ source: "real" });
  }, [tasks, yearEndModal, weekKey, completedThisWeekCount]);

  /** Metrics from canonical task list only (single source of truth). */
  const yearMetrics = useMemo(
    () => getYearMetrics(joinWeekSnapshot, tasks),
    [joinWeekSnapshot, tasks]
  );

  const {
    tasksCompleted,
    tasksCompletedSinceJoin,
    targetTasksThisYear,
    tasksPercentage,
    currentWeek,
    paceWeeks,
    paceStatus,
    onPace
  } = yearMetrics;
  const weeksLeft = yearMetrics.weeksLeftCalendar;

  function handleAddTask(e: React.FormEvent) {
    e.preventDefault();
    const title = input.trim();
    if (!title) return;

    const nowDate = getNow();
    const year = nowDate.getFullYear();
    const alreadyHaveJoinForThisYear =
      joinWeekSnapshot != null && joinWeekSnapshot.year === year;
    if (!alreadyHaveJoinForThisYear) {
      const week = getISOWeek(nowDate).isoWeek;
      saveJoinWeek(Math.min(52, week), year);
      setJoinWeekSnapshot({ joinWeek: Math.min(52, week), year });
    }
    const newTask: Task = {
      id: crypto.randomUUID(),
      title,
      completed: false,
      createdAt: realNowISO(),
      completedAt: null,
      subtasks: [],
      manuallyCompleted: false
    };
    setTasks((prev) => [newTask, ...prev]);
    setInput("");
  }

  function handleToggleCompleted(taskId: string) {
    const target = tasks.find((task) => task.id === taskId);
    if (!target) return;

    const willComplete = !target.completed;
    const prevSinceJoin = tasksCompletedSinceJoin;
    const prevStatus = paceStatus;
    const paceW = paceWeeks;
    const nextSinceJoin = prevSinceJoin + (willComplete ? 1 : -1);

    let nextStatus: PaceStatus;
    if (nextSinceJoin < paceW) {
      nextStatus = "behind";
    } else if (nextSinceJoin === paceW) {
      nextStatus = "onTrack";
    } else {
      nextStatus = "ahead";
    }

    setTasks((prev) =>
      prev.map((t) => {
        if (t.id !== taskId) return t;
        const nextCompleted = !t.completed;
        if (nextCompleted) {
          return {
            ...t,
            completed: true,
            completedAt: realNowISO(),
            manuallyCompleted: true
          };
        }
        const updated: Task = {
          ...t,
          completed: false,
          completedAt: null,
          manuallyCompleted: false
        };
        return syncParentCompletionFromSubtasks(updated);
      })
    );

    if (
      willComplete &&
      prevStatus === "behind" &&
      (nextStatus === "onTrack" || nextStatus === "ahead")
    ) {
      triggerPaceCelebration(nextStatus);
    }
  }

  function handleToggleSubtask(parentId: string, subtaskId: string) {
    setTasks((prev) =>
      prev.map((task) => {
        if (task.id !== parentId) return task;
        const subs = task.subtasks ?? [];
        const updatedSubs = subs.map((s) =>
          s.id === subtaskId
            ? {
                ...s,
                completed: !s.completed,
                completedAt: !s.completed ? realNowISO() : null
              }
            : s
        );
        let updated: Task = { ...task, subtasks: updatedSubs };
        const allComplete =
          updatedSubs.length > 0 && updatedSubs.every((s) => s.completed);
        if (allComplete) {
          return syncParentCompletionFromSubtasks(updated);
        }
        if (!task.manuallyCompleted) {
          updated = { ...updated, completed: false, completedAt: null };
        }
        return updated;
      })
    );
  }

  function handleAddSubtask(parentId: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) return;
    const newSub: Subtask = {
      id: crypto.randomUUID(),
      title: trimmed,
      completed: false,
      createdAt: realNowISO(),
      completedAt: null
    };
    setTasks((prev) =>
      prev.map((task) => {
        if (task.id !== parentId) return task;
        const subs = task.subtasks ?? [];
        return { ...task, subtasks: [...subs, newSub] };
      })
    );
  }

  function handleDeleteSubtask(parentId: string, subtaskId: string) {
    setTasks((prev) =>
      prev.map((task) => {
        if (task.id !== parentId) return task;
        const subs = (task.subtasks ?? []).filter((s) => s.id !== subtaskId);
        let updated: Task = { ...task, subtasks: subs };
        if (areAllSubtasksCompleted(updated)) {
          return syncParentCompletionFromSubtasks(updated);
        }
        if (!task.manuallyCompleted && subs.length > 0) {
          const allComplete = subs.every((s) => s.completed);
          if (!allComplete) {
            updated = { ...updated, completed: false, completedAt: null };
          }
        }
        return updated;
      })
    );
  }

  function handleDelete(taskId: string) {
    setTasks((prev) => prev.filter((task) => task.id !== taskId));
  }

  const completedLabel = `${tasksCompleted}/${targetTasksThisYear}`;
  const completedPercentLabel = `${tasksPercentage.toFixed(1)}%`;

  /** Derived views from canonical tasks (single source of truth). */
  const todoView = useMemo(
    () => tasks.filter((t) => !t.completed),
    [tasks]
  );
  const completedView = useMemo(
    () =>
      tasks
        .filter((t) => t.completed && t.completedAt)
        .sort((a, b) =>
          (b.completedAt ?? "").localeCompare(a.completedAt ?? "")
        ),
    [tasks]
  );
  const visibleTasks = taskSegment === "todo" ? todoView : completedView;
  const segmentCount =
    taskSegment === "todo" ? todoView.length : completedView.length;
  const segmentCountLabel =
    taskSegment === "todo"
      ? segmentCount === 0
        ? "No tasks yet"
        : `${segmentCount} to do`
      : `${segmentCount} completed`;

  function triggerPaceCelebration(targetStatus: Exclude<PaceStatus, "behind">) {
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!prefersReducedMotion) {
      setIsPaceCelebrationActive(true);
      window.setTimeout(() => {
        setIsPaceCelebrationActive(false);
      }, 1800);
    }

    const message =
      targetStatus === "ahead" ? "You're ahead." : "You're on pace.";
    setToastMessage(message);
    window.setTimeout(() => {
      setToastMessage((current) => (current === message ? null : current));
    }, 4000);
  }

  function closeYearEndModal(option: "close" | "startNewYear" | "carryForward" | "startFresh") {
    if (!yearEndModal) return;

    const isMutating = option === "carryForward" || option === "startFresh" || option === "startNewYear";
    if (isMutating && import.meta.env.DEV && !window.confirm("This will modify your local tasks. Continue?")) {
      return;
    }

    const currentYear = getNow().getFullYear();
    const { previousYear, tasksCompleted: count, streakWeeks, paceWeeks } = yearEndModal;

    if (option !== "close") {
      appendYearSummary({
        year: previousYear,
        tasksCompleted: count,
        streakWeeks,
        paceWeeks
      });
      if (option === "carryForward") {
        setTasks((prev) => prev.filter((t) => !t.completed));
      } else if (option === "startFresh" || option === "startNewYear") {
        setTasks([]);
      }
      saveJoinWeek(1, currentYear);
      setJoinWeekSnapshot({ joinWeek: 1, year: currentYear });
    }

    setLastSeenYear(currentYear);
    setYearEndModal(null);
  }

  return (
    <div className="app">
      {yearEndModal && (() => {
        const { tasksCompleted: tc, streakWeeks: sw, paceWeeks: pw } = yearEndModal;
        const paceWeeksSafe = Math.max(1, pw);
        const completionRate = tc / paceWeeksSafe;
        const achieved = completionRate >= 1;
        let title: string;
        if (achieved) {
          title = "🎉 You stayed on pace this year!";
        } else if (completionRate >= 0.85) {
          title = "🔥 So close.";
        } else if (completionRate >= 0.5) {
          title = "📈 Solid momentum.";
        } else {
          title = "🌱 A new year starts now.";
        }
        const subtitle = `You completed ${tc} tasks in ${pw} weeks.`;
        const showGoalReachedButtons = achieved;
        return (
          <div className="year-end-overlay" role="dialog" aria-modal="true" aria-labelledby="year-end-title">
            <div className="year-end-modal">
              <h2 id="year-end-title" className="year-end-title">
                {title}
              </h2>
              <p className="year-end-subtitle">
                {subtitle}
              </p>
              <p className="year-end-stats">
                Your longest streak was {sw} {sw === 1 ? "week" : "weeks"}.
              </p>
              <div className="year-end-actions">
                {showGoalReachedButtons ? (
                  <>
                    <button
                      type="button"
                      className="year-end-btn year-end-btn-primary"
                      onClick={() => closeYearEndModal("startNewYear")}
                    >
                      Start new year
                    </button>
                    <button
                      type="button"
                      className="year-end-btn year-end-btn-secondary"
                      onClick={() => closeYearEndModal("close")}
                    >
                      Close
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="year-end-btn year-end-btn-primary"
                      onClick={() => closeYearEndModal("carryForward")}
                    >
                      Carry unfinished tasks forward
                    </button>
                    <button
                      type="button"
                      className="year-end-btn year-end-btn-secondary"
                      onClick={() => closeYearEndModal("startFresh")}
                    >
                      Start fresh
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })()}
      {!yearEndModal && checkinModal && (() => {
        const onPace = tasksCompletedSinceJoin >= paceWeeks;
        const phase =
          paceWeeks <= 4 ? "early" : paceWeeks <= 26 ? "mid" : "late";
        let title: string;
        let body: string;
        if (onPace) {
          if (phase === "early") {
            title = "New week. Still on pace.";
            body = "Keep it simple and keep moving.";
          } else if (phase === "mid") {
            title = "You're on pace.";
            body = "Stay steady this week.";
          } else {
            title = "On pace — finish strong.";
            body = "Keep the momentum going.";
          }
        } else {
          if (phase === "early") {
            title = "New week, fresh start.";
            body = "Get one small win on the board.";
          } else if (phase === "mid") {
            title = "A little behind.";
            body = "This week is a chance to close the gap.";
          } else {
            title = "Final stretch.";
            body = "Any progress this week helps.";
          }
        }
        return (
          <div
            className="year-end-overlay checkin-modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="checkin-modal-title"
          >
            <div className="year-end-modal checkin-modal">
              <h2 id="checkin-modal-title" className="year-end-title">
                {title}
              </h2>
              <p className="year-end-subtitle">{body}</p>
              <div className="year-end-actions">
                <button
                  type="button"
                  className="year-end-btn year-end-btn-primary"
                  onClick={() => setCheckinModal(null)}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}
      <main className="app-shell">
        {toastMessage && (
          <div className="toast-wrapper">
            <div className="toast" role="status" aria-live="polite">
              {toastMessage}
            </div>
          </div>
        )}
        <YearDotsIndicator
          currentWeek={currentWeek}
          tasksCompleted={tasksCompletedSinceJoin}
          paceWeeks={paceWeeks}
          weeksLeft={weeksLeft}
          joinWeek={yearMetrics.joinWeek}
        />
        <section className="dashboard" aria-label="Progress overview">
          <article className="stat-card">
            <div className="stat-label">Tasks completed</div>
            <div className="stat-primary">
              <div className="stat-value">{completedLabel}</div>
              <div className="stat-secondary">{completedPercentLabel}</div>
            </div>
            <div className="progress-track" aria-hidden="true">
              <div
                className="progress-bar"
                style={{ width: `${tasksPercentage}%` }}
              />
            </div>
            <div className="stat-helper">
              {tasksCompleted === 0
                ? "One task a week is 52 by year's end."
                : "The total tasks you can complete from when you started until year-end."}
            </div>
          </article>

          <article
            className={
              "stat-card stat-card-ratio" +
              (isPaceCelebrationActive ? " stat-card-pulse" : "")
            }
          >
            <div className="stat-label">Your progress</div>
            <div className="stat-primary">
              {paceWeeks === 0 ? (
                <div className="stat-value stat-ratio-sentence">
                  Not started yet
                </div>
              ) : (
                <div
                  className={
                    "stat-value stat-ratio-sentence " +
                    (tasksCompletedSinceJoin >= paceWeeks ? "ratio-above" : "ratio-below")
                  }
                >
                  <span>{tasksCompletedSinceJoin}</span>
                  <span> {tasksCompletedSinceJoin === 1 ? "task" : "tasks"} in </span>
                  <span>{paceWeeks}</span>
                  <span> {paceWeeks === 1 ? "week" : "weeks"}</span>
                </div>
              )}
            </div>
            <div className="stat-secondary">
              {paceWeeks === 0
                ? "Your year starts with the first task."
                : onPace
                  ? "Momentum is on your side."
                  : "A focused week puts you back on track."}
            </div>
          </article>
        </section>

        <section aria-label="Tasks" className="todo-section">
          <div className="todo-section-inner">
            <div className="todo-section-header">
              <h2 className="todo-section-title">Tasks</h2>
              <span className="todo-count">{segmentCountLabel}</span>
            </div>

            <form onSubmit={handleAddTask} className="todo-input-row">
            <input
              className="todo-input"
              style={{ fontSize: 16 }}
              placeholder="Add a new task…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <button
              type="submit"
              className="todo-add-btn"
              disabled={!input.trim()}
            >
              Add
            </button>
          </form>

          <div
            className="segment-control"
            role="tablist"
            aria-label="Task filter"
          >
            <div className="segment-control-inner">
              <button
                type="button"
                role="tab"
                aria-selected={taskSegment === "todo"}
                className={
                  "segment-option" + (taskSegment === "todo" ? " segment-option-active" : "")
                }
                onClick={() => setTaskSegment("todo")}
              >
                To Do
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={taskSegment === "completed"}
                className={
                  "segment-option" +
                  (taskSegment === "completed" ? " segment-option-active" : "")
                }
                onClick={() => setTaskSegment("completed")}
              >
                Completed
              </button>
            </div>
          </div>

            {visibleTasks.length === 0 ? null : (
              <ul className="todo-list">
              {visibleTasks.map((task) => {
                const isCompleted = task.completed;
                const subtasks = task.subtasks ?? [];
                const isExpanded = expandedTaskId === task.id;

                return (
                  <li
                    key={task.id}
                    className={
                      "todo-item" +
                      (isCompleted ? " todo-item-completed" : "") +
                      (subtasks.length > 0 ? " todo-item-has-subtasks" : "")
                    }
                  >
                    {subtasks.length > 0 ? (
                      <button
                        type="button"
                        className="todo-expand-btn"
                        aria-expanded={isExpanded}
                        aria-label={isExpanded ? "Collapse subtasks" : "Expand subtasks"}
                        onClick={() => {
                          setExpandedTaskId((id) => (id === task.id ? null : task.id));
                          if (expandedTaskId !== task.id) setSubtaskInput("");
                        }}
                      >
                        <span className={"todo-chevron" + (isExpanded ? " todo-chevron-open" : "")}>▸</span>
                      </button>
                    ) : (
                      <span className="todo-chevron-slot" aria-hidden />
                    )}
                    <button
                      type="button"
                      className="todo-checkbox"
                      aria-pressed={isCompleted}
                      onClick={() => handleToggleCompleted(task.id)}
                    >
                      <span
                        className={
                          "todo-checkbox-visual" +
                          (isCompleted ? " todo-checkbox-visual-completed" : "")
                        }
                      >
                        {isCompleted && (
                          <span className="todo-checkbox-check">✓</span>
                        )}
                      </span>
                    </button>

                    <div className="todo-content">
                      <div className="todo-title-row">
                        <div
                          className={
                            "todo-title" +
                            (isCompleted ? " todo-title-completed" : "")
                          }
                        >
                          {task.title}
                        </div>
                        {subtasks.length > 0 && (
                          <span className="subtask-fraction" aria-hidden>
                            {subtasks.filter((s) => s.completed).length}/{subtasks.length}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="todo-actions">
                      <button
                        type="button"
                        className="todo-add-subtask-inline"
                        onClick={() => {
                          const wasExpanded = isExpanded;
                          if (!wasExpanded) setExpandedTaskId(task.id);
                          setSubtaskInput("");
                          const focusInput = () => addSubtaskInputRef.current?.focus();
                          if (wasExpanded) focusInput();
                          else requestAnimationFrame(() => setTimeout(focusInput, 0));
                        }}
                      >
                        Add subtask
                      </button>
                      <button
                        type="button"
                        className="todo-delete-btn"
                        onClick={() => handleDelete(task.id)}
                      >
                        Delete
                      </button>
                    </div>

                    {isExpanded && (
                      <div className="todo-subtasks" style={{ width: "100%" }}>
                        <ul className="todo-sublist">
                          {subtasks.map((sub) => (
                            <li
                              key={sub.id}
                              className={
                                "todo-item todo-subtask-item" +
                                (sub.completed ? " todo-item-completed" : "")
                              }
                            >
                              <span className="todo-chevron-slot" aria-hidden />
                              <div className="todo-subtask-main">
                                <button
                                  type="button"
                                  className="todo-checkbox"
                                  aria-pressed={sub.completed}
                                  onClick={() => handleToggleSubtask(task.id, sub.id)}
                                >
                                  <span
                                    className={
                                      "todo-checkbox-visual" +
                                      (sub.completed ? " todo-checkbox-visual-completed" : "")
                                    }
                                  >
                                    {sub.completed && (
                                      <span className="todo-checkbox-check">✓</span>
                                    )}
                                  </span>
                                </button>
                                <div className="todo-content">
                                  <div
                                    className={
                                      "todo-title" +
                                      (sub.completed ? " todo-title-completed" : "")
                                    }
                                  >
                                    {sub.title}
                                  </div>
                                </div>
                              </div>
                              <div className="todo-actions">
                                <button
                                  type="button"
                                  className="todo-delete-subtask-btn"
                                  onClick={() => handleDeleteSubtask(task.id, sub.id)}
                                  aria-label="Delete subtask"
                                >
                                  <svg className="todo-delete-subtask-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                    <path d="M3 6h18" />
                                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                                    <line x1="10" y1="11" x2="10" y2="17" />
                                    <line x1="14" y1="11" x2="14" y2="17" />
                                  </svg>
                                </button>
                              </div>
                            </li>
                          ))}
                        </ul>
                        <form
                          className="todo-subtask-form"
                          onSubmit={(e) => {
                            e.preventDefault();
                            handleAddSubtask(task.id, subtaskInput);
                            setSubtaskInput("");
                          }}
                        >
                          <span className="todo-chevron-slot" aria-hidden />
                          <div className="todo-subtask-input-cell">
                            <input
                              ref={expandedTaskId === task.id ? addSubtaskInputRef : undefined}
                              className="todo-input todo-subtask-input"
                              placeholder="Add subtask…"
                              value={subtaskInput}
                              onChange={(e) => setSubtaskInput(e.target.value)}
                            />
                          </div>
                          <button
                            type="submit"
                            className="todo-add-btn todo-add-subtask-btn todo-add-subtask-btn-small"
                            disabled={!subtaskInput.trim()}
                          >
                            Add
                          </button>
                        </form>
                      </div>
                    )}
                  </li>
                );
              })}
              </ul>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;

