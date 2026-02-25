import { useEffect, useMemo, useState } from "react";

type Task = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: string;
  completedAt: string | null;
};

const STORAGE_KEY = "52-to-do:tasks";
const THEME_STORAGE_KEY = "theme";
type Theme = "light" | "dark";
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
      completedAt: t.completedAt ?? null
    }));
  } catch {
    return [];
  }
}

function saveTasks(tasks: Task[]) {
  if (typeof window === "undefined") return;
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
  return getWeekFromDate(new Date());
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

function getStoredTheme(): Theme | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(THEME_STORAGE_KEY);
  return value === "light" || value === "dark" ? value : null;
}

function getSystemTheme(): Theme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
}

function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [input, setInput] = useState("");
  const [theme, setTheme] = useState<Theme>("dark");
  const [isPaceCelebrationActive, setIsPaceCelebrationActive] =
    useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  useEffect(() => {
    setTasks(loadTasks());
  }, []);

  useEffect(() => {
    saveTasks(tasks);
  }, [tasks]);

  useEffect(() => {
    const stored = getStoredTheme();
    const initial = stored ?? "dark";
    setTheme(initial);
    applyTheme(initial);
  }, []);

  const {
    tasksCompleted,
    weeksCompleted,
    tasksPercentage,
    weeksPercentage,
    currentWeek,
    tasksVsWeekLabel,
    paceStatus
  } = useMemo(() => {
    const now = new Date();
    const year = now.getFullYear();

    const completedThisYear = tasks.filter((task) => {
      if (!task.completed || !task.completedAt) return false;
      const d = new Date(task.completedAt);
      return !Number.isNaN(d.getTime()) && d.getFullYear() === year;
    });

    const tasksCompletedCount = completedThisYear.length;

    const weeks = new Set<number>();
    for (const task of completedThisYear) {
      if (!task.completedAt) continue;
      const d = new Date(task.completedAt);
      if (Number.isNaN(d.getTime())) continue;
      weeks.add(getWeekFromDate(d));
    }

    const currentW = getCurrentWeek();
    const percentageRaw = (tasksCompletedCount / 52) * 100;
    const weeksPercentageRaw = (weeks.size / 52) * 100;

    let status: PaceStatus;
    if (tasksCompletedCount < currentW) {
      status = "behind";
    } else if (tasksCompletedCount === currentW) {
      status = "onTrack";
    } else {
      status = "ahead";
    }

    return {
      tasksCompleted: tasksCompletedCount,
      weeksCompleted: weeks.size,
      tasksPercentage: Math.min(
        100,
        Math.max(0, Number.isFinite(percentageRaw) ? percentageRaw : 0)
      ),
      weeksPercentage: Math.min(
        100,
        Math.max(0, Number.isFinite(weeksPercentageRaw) ? weeksPercentageRaw : 0)
      ),
      currentWeek: currentW,
      tasksVsWeekLabel: `${tasksCompletedCount}/${currentW}`,
      paceStatus: status
    };
  }, [tasks]);

  function handleAddTask(e: React.FormEvent) {
    e.preventDefault();
    const title = input.trim();
    if (!title) return;

    const now = new Date().toISOString();
    const newTask: Task = {
      id: crypto.randomUUID(),
      title,
      completed: false,
      createdAt: now,
      completedAt: null
    };
    setTasks((prev) => [newTask, ...prev]);
    setInput("");
  }

  function handleToggleCompleted(taskId: string) {
    const target = tasks.find((task) => task.id === taskId);
    if (!target) return;

    const willComplete = !target.completed;
    const prevTasksCompleted = tasksCompleted;
    const prevStatus = paceStatus;
    const currentW = currentWeek;
    const nextTasksCompleted = prevTasksCompleted + (willComplete ? 1 : -1);

    let nextStatus: PaceStatus;
    if (nextTasksCompleted < currentW) {
      nextStatus = "behind";
    } else if (nextTasksCompleted === currentW) {
      nextStatus = "onTrack";
    } else {
      nextStatus = "ahead";
    }

    setTasks((prev) =>
      prev.map((task) => {
        if (task.id !== taskId) return task;
        const nextCompleted = !task.completed;
        return {
          ...task,
          completed: nextCompleted,
          completedAt: nextCompleted ? new Date().toISOString() : null
        };
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

  function handleDelete(taskId: string) {
    setTasks((prev) => prev.filter((task) => task.id !== taskId));
  }

  const completedLabel = `${tasksCompleted}/52`;
  const completedPercentLabel = `${tasksPercentage.toFixed(1)}%`;
  const weeksCompletedLabel = `${weeksCompleted}/52`;
  const weeksPercentLabel = `${weeksPercentage.toFixed(1)}%`;

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

  function handleToggleTheme() {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      applyTheme(next);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
      }
      return next;
    });
  }

  return (
    <div className="app">
      <main className="app-shell">
        <div className="top-bar">
          <button
            type="button"
            className="theme-toggle"
            onClick={handleToggleTheme}
          >
            {theme === "dark" ? "Dark mode" : "Light mode"}
          </button>
        </div>
        {toastMessage && (
          <div className="toast-wrapper">
            <div className="toast" role="status" aria-live="polite">
              {toastMessage}
            </div>
          </div>
        )}
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
          </article>

          <article className="stat-card">
            <div className="stat-label">Weeks completed</div>
            <div className="stat-primary">
              <div className="stat-value">{weeksCompletedLabel}</div>
              <div className="stat-secondary">{weeksPercentLabel}</div>
            </div>
            <div className="progress-track" aria-hidden="true">
              <div
                className="progress-bar"
                style={{ width: `${weeksPercentage}%` }}
              />
            </div>
          </article>

          <article
            className={
              "stat-card" +
              (isPaceCelebrationActive ? " stat-card-pulse" : "")
            }
          >
            <div className="stat-label">Tasks vs. week</div>
            <div className="stat-primary">
              <div
                className={
                  "stat-large " +
                  (tasksCompleted < currentWeek
                    ? "ratio-below"
                    : tasksCompleted === currentWeek
                    ? "ratio-equal"
                    : "ratio-above")
                }
              >
                {tasksVsWeekLabel}
              </div>
            </div>
            <div className="stat-secondary">
              Completed tasks this year vs current week ({currentWeek}).
            </div>
          </article>
        </section>

        <section aria-label="Tasks">
          <div className="todo-section-header">
            <h2 className="todo-section-title">Tasks</h2>
            <span className="todo-count">
              {tasks.length === 0
                ? "No tasks yet"
                : `${tasks.length} tasks total`}
            </span>
          </div>

          <form onSubmit={handleAddTask} className="todo-input-row">
            <input
              className="todo-input"
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

          {tasks.length === 0 ? null : (
            <ul className="todo-list">
              {tasks.map((task) => {
                const isCompleted = task.completed;

                return (
                  <li
                    key={task.id}
                    className={
                      "todo-item" + (isCompleted ? " todo-item-completed" : "")
                    }
                  >
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
                      <div
                        className={
                          "todo-title" +
                          (isCompleted ? " todo-title-completed" : "")
                        }
                      >
                        {task.title}
                      </div>
                    </div>

                    <button
                      type="button"
                      className="todo-delete-btn"
                      onClick={() => handleDelete(task.id)}
                    >
                      Delete
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;

