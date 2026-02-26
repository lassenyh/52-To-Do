import { memo, useEffect, useMemo, useRef, useState } from "react";

const TOTAL_WEEKS = 52;
const PULSE_DURATION_MS = 500;
const INTRO_TOTAL_MS = 2400;
const INTRO_SLOWDOWN_FACTOR = 1.5;
const INTRO_PULSE_SEQUENCE_MS = 1050;

/** Fixed list of calendar weeks 1..52. Never slice or filter this. */
const WEEKS_1_TO_52 = Array.from({ length: TOTAL_WEEKS }, (_, i) => i + 1);

type YearDotsIndicatorProps = {
  /** Calendar week (1–52) from today's date (ISO). Used for dot state and grid only. */
  currentWeek: number;
  tasksCompleted: number;
  paceWeeks: number;
  /** Weeks left in the year: 52 - calendarWeekNow. Not derived from joinWeek/paceWeeks. */
  weeksLeft: number;
  joinWeek: number | null;
};

/**
 * Visual state for a dot. Styling only — does NOT affect which dots exist.
 * prejoin: week < joinWeek. past: joinWeek <= week < currentWeek. current: week === currentWeek. future: week > currentWeek.
 */
function getDotState(
  week: number,
  currentWeek: number,
  joinWeek: number | null
): "prejoin" | "past" | "current" | "future" {
  if (joinWeek != null && week < joinWeek) return "prejoin";
  if (week < currentWeek) return "past";
  if (week > currentWeek) return "future";
  return "current";
}

function YearDotsIndicator({
  currentWeek,
  tasksCompleted,
  paceWeeks,
  weeksLeft,
  joinWeek
}: YearDotsIndicatorProps) {
  const onPace = useMemo(
    () => tasksCompleted >= paceWeeks,
    [tasksCompleted, paceWeeks]
  );

  const prevOnPaceRef = useRef<boolean | undefined>(undefined);
  const [pulseActive, setPulseActive] = useState(false);

  const [introProgressWeek, setIntroProgressWeek] = useState(0);
  const [introDone, setIntroDone] = useState(false);
  const [introPulseActive, setIntroPulseActive] = useState(false);

  useEffect(() => {
    if (prevOnPaceRef.current !== undefined && prevOnPaceRef.current !== onPace) {
      setPulseActive(true);
      const t = window.setTimeout(() => setPulseActive(false), PULSE_DURATION_MS);
      return () => window.clearTimeout(t);
    }
    prevOnPaceRef.current = onPace;
  }, [onPace]);

  useEffect(() => {
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      setIntroDone(true);
      return;
    }
    const target = Math.max(1, Math.min(TOTAL_WEEKS, currentWeek));
    const baseStepMs = Math.max(25, Math.min(40, INTRO_TOTAL_MS / target));
    const stepMs = Math.round(baseStepMs * INTRO_SLOWDOWN_FACTOR);
    let step = 0;
    const id = window.setInterval(() => {
      step += 1;
      if (step >= target) {
        window.clearInterval(id);
        setIntroProgressWeek(target);
        setIntroPulseActive(true);
        window.setTimeout(() => {
          setIntroDone(true);
          setIntroPulseActive(false);
        }, INTRO_PULSE_SEQUENCE_MS);
        return;
      }
      setIntroProgressWeek(step);
    }, stepMs);
    return () => window.clearInterval(id);
  }, [currentWeek]);

  const dots = useMemo(() => {
    const useIntro = !introDone;
    return WEEKS_1_TO_52.map((week) => {
      let state: "prejoin" | "past" | "current" | "future";
      if (useIntro) {
        if (week < introProgressWeek) state = "past";
        else if (week === introProgressWeek && introProgressWeek === currentWeek) state = "current";
        else if (week === introProgressWeek) state = "past";
        else state = "future";
      } else {
        state = getDotState(week, currentWeek, joinWeek);
      }
      const isCurrent = state === "current";
      const showPulse = isCurrent && (introPulseActive || pulseActive);
      const useIntroPulse = isCurrent && introPulseActive;
      return (
        <span
          key={week}
          className={
            "year-dot year-dots-dot year-dots-dot-" +
            state +
            (isCurrent
              ? (onPace ? " year-dots-dot-current-on-pace" : " year-dots-dot-current-behind") +
                (showPulse ? " year-dots-dot-current-pulse" : "") +
                (useIntroPulse ? " year-dots-dot-intro-pulse" : "")
              : "")
          }
          aria-hidden
          title={`Week ${week}`}
        />
      );
    });
  }, [
    currentWeek,
    joinWeek,
    onPace,
    pulseActive,
    introDone,
    introProgressWeek,
    introPulseActive
  ]);

  useEffect(() => {
    if (import.meta.env.DEV && typeof document !== "undefined") {
      const count = document.querySelectorAll(".year-dot").length;
      if (count !== 52) console.warn("DOT_COUNT sanity: expected 52, got", count);
    }
  }, []);

  return (
    <section className="year-dots" aria-label="52-week year progress">
      <div className="year-dots-grid" role="img" aria-label={`Week ${currentWeek} of 52. ${onPace ? "On pace" : "Behind pace"}. ${weeksLeft} weeks left.`}>
        {dots}
      </div>
      <span className="year-dots-weeks-left">
        {weeksLeft} {weeksLeft === 1 ? "week" : "weeks"} left
      </span>
    </section>
  );
}

export default memo(YearDotsIndicator);
