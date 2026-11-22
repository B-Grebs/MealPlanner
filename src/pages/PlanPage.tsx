import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { del, post, put, type Plan, type PlanEntry, type Recipe } from "../api";
import { ErrorBox, Loading, Sheet, useToast } from "../App";
import { useApi } from "../hooks";
import { addDays, localToday, monthDates, monthLabel, shiftMonth, shortDate, weekday, WEEKDAYS, WEEKDAYS_LONG } from "../util";

export default function PlanPage() {
  const [params, setParams] = useSearchParams();
  const today = localToday();
  const month = params.get("m") ?? today.slice(0, 7);
  const toast = useToast();
  const navigate = useNavigate();

  const plans = useApi<Plan[]>(`/plans?month=${month}`);
  const prevPlans = useApi<Plan[]>(`/plans?month=${shiftMonth(month, -1)}`);
  const [planId, setPlanId] = useState<number | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [editDate, setEditDate] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  // Pick the active plan (or the newest) when the month's plans load.
  useEffect(() => {
    if (!plans.data) return;
    const pick = plans.data.find((p) => p.id === planId) ?? plans.data.find((p) => p.status === "active") ?? plans.data[0];
    setPlanId(pick?.id ?? null);
    if (!pick) setPlan(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plans.data]);

  const planData = useApi<Plan>(planId ? `/plans/${planId}` : null);
  useEffect(() => {
    if (planData.data) setPlan(planData.data);
  }, [planData.data]);
  useEffect(() => setWarnings([]), [planId]);

  const setMonth = (m: string) => {
    setPlanId(null);
    setPlan(null);
    setParams(m === today.slice(0, 7) ? {} : { m });
  };

  async function run<T>(fn: () => Promise<T>, done?: (r: T) => void) {
    setBusy(true);
    try {
      const r = await fn();
      done?.(r);
      return r;
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  const prevActive = prevPlans.data?.find((p) => p.status === "active") ?? prevPlans.data?.[0];
  const entries = useMemo(() => new Map((plan?.entries ?? []).filter((e) => e.slot === "dinner").map((e) => [e.date, e])), [plan]);
  const dates = monthDates(month);
  const lead = weekday(dates[0]);

  const applyPlan = (p: Plan) => {
    setPlan(p);
    if (p.id !== planId) setPlanId(p.id);
  };

  const createEmpty = () =>
    run(() => post<Plan>("/plans", { month }), (p) => {
      applyPlan(p);
      void plans.reload();
    });
  const copyPrev = () =>
    prevActive &&
    run(() => post<Plan>(`/plans/${prevActive.id}/copy`, { targetMonth: month }), (p) => {
      applyPlan(p);
      void plans.reload();
      toast(`Copied ${monthLabel(prevActive.month)}`);
    });
  const generate = (createFirst = false) =>
    run(async () => {
      let id = plan?.id;
      if (!id || createFirst) {
        const p = await post<Plan>("/plans", { month });
        id = p.id;
      }
      return post<Plan>(`/plans/${id}/generate`, {});
    }, (p) => {
      applyPlan(p);
      setWarnings(p.warnings ?? []);
      void plans.reload();
    });
  const activate = () => plan && run(() => post<Plan>(`/plans/${plan.id}/activate`), (p) => {
    applyPlan(p);
    void plans.reload();
    toast("This plan is now the active one");
  });
  const clearUnlocked = () =>
    plan && confirm("Clear every day that isn't locked?") && run(() => post<Plan>(`/plans/${plan.id}/clear`), applyPlan);
  const copyToNext = () =>
    plan &&
    run(() => post<Plan>(`/plans/${plan.id}/copy`, { targetMonth: shiftMonth(month, 1) }), () => {
      toast(`Copied to ${monthLabel(shiftMonth(month, 1))}`);
      setMonth(shiftMonth(month, 1));
    });
  const deletePlan = () =>
    plan &&
    confirm(`Delete "${plan.name}"? This can't be undone.`) &&
    run(() => del(`/plans/${plan.id}`), () => {
      setPlanId(null);
      setPlan(null);
      void plans.reload();
    });
  const makeList = () =>
    run(() => post<{ id: number }>("/lists", { start: today, end: addDays(today, 6) }), (l) => navigate(`/lists/${l.id}`));
  const toggleLock = (e: PlanEntry | undefined, date: string) =>
    plan && run(() => put<Plan>(`/plans/${plan.id}/entries`, { date, locked: !e?.locked }), applyPlan);

  return (
    <div className="page">
      <header className="page-head">
        <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">
          ‹
        </button>
        <h1 className="grow center">{monthLabel(month)}</h1>
        <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">
          ›
        </button>
      </header>

      {plans.error && <ErrorBox error={plans.error} retry={plans.reload} />}
      {plans.loading && !plans.data && <Loading />}

      {plans.data && !plan && !planData.loading && (
        <div className="card stack">
          <p>No plan for {monthLabel(month)} yet.</p>
          <div className="row wrap">
            <button className="primary" disabled={busy} onClick={() => generate(true)}>
              Fill with recipes
            </button>
            {prevActive && (
              <button disabled={busy} onClick={copyPrev}>
                Copy {monthLabel(prevActive.month)}
              </button>
            )}
            <button disabled={busy} onClick={createEmpty}>
              Start empty
            </button>
          </div>
        </div>
      )}

      {plan && (
        <>
          <div className="plan-bar">
            {plans.data && plans.data.length > 1 ? (
              <select value={plan.id} onChange={(e) => setPlanId(Number(e.target.value))} aria-label="Plan">
                {plans.data.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} {p.status === "active" ? "· active" : "· draft"}
                  </option>
                ))}
              </select>
            ) : (
              <span className="muted">{plan.name}</span>
            )}
            <span className={`badge ${plan.status}`}>{plan.status === "active" ? "Active" : "Draft"}</span>
            {plan.status === "draft" && (
              <button className="small" disabled={busy} onClick={activate}>
                Make active
              </button>
            )}
          </div>

          <div className="toolbar">
            <button className="primary" disabled={busy} onClick={() => generate()}>
              {busy ? "Working…" : "Regenerate unlocked"}
            </button>
            <button disabled={busy} onClick={makeList}>
              List for next 7 days
            </button>
            <details className="more">
              <summary>More</summary>
              <div className="menu">
                <button onClick={copyToNext}>Copy to {monthLabel(shiftMonth(month, 1))}</button>
                <button onClick={() => generate(true)}>New draft from rules</button>
                {prevActive && <button onClick={copyPrev}>New copy of {monthLabel(prevActive.month)}</button>}
                <button onClick={clearUnlocked}>Clear unlocked days</button>
                <button className="danger" onClick={deletePlan}>
                  Delete this plan
                </button>
              </div>
            </details>
          </div>
          {plan.status === "draft" && (
            <p className="hint">Drafts don't feed shopping lists or Home Assistant until you make them active.</p>
          )}
          {warnings.length > 0 && (
            <div className="warn">
              {warnings.map((w) => (
                <div key={w}>{w}</div>
              ))}
            </div>
          )}

          <div className="calendar">
            {WEEKDAYS.map((d) => (
              <div key={d} className="cal-head">
                {d}
              </div>
            ))}
            {Array.from({ length: lead }, (_, i) => (
              <div key={`b${i}`} className="cal-blank" />
            ))}
            {dates.map((date) => {
              const e = entries.get(date);
              const title = e?.recipe_title ?? e?.freeform_text;
              return (
                <div key={date} className={`day${date === today ? " today" : ""}${e?.locked ? " locked" : ""}${date < today ? " past" : ""}`}>
                  <button className="day-main" onClick={() => setEditDate(date)}>
                    <span className="day-date">
                      <span className="day-wd">{WEEKDAYS[weekday(date)]}</span> {Number(date.slice(8))}
                    </span>
                    <span className={title ? "day-meal" : "day-meal none"}>{title ?? "—"}</span>
                    {e?.notes && <span className="day-note">{e.notes}</span>}
                  </button>
                  <button
                    className={`lock${e?.locked ? " on" : ""}`}
                    onClick={() => toggleLock(e, date)}
                    aria-label={e?.locked ? "Unlock" : "Lock"}
                    title={e?.locked ? "Locked: regenerate keeps this day" : "Lock this day"}
                  >
                    {e?.locked ? "🔒" : "🔓"}
                  </button>
                </div>
              );
            })}
          </div>
          {plan.last_seed != null && <p className="hint">Last generated with seed {plan.last_seed}.</p>}
        </>
      )}

      {plan && editDate && (
        <DayEditor plan={plan} date={editDate} entry={entries.get(editDate)} onClose={() => setEditDate(null)} onSaved={applyPlan} />
      )}
    </div>
  );
}

function DayEditor({
  plan,
  date,
  entry,
  onClose,
  onSaved,
}: {
  plan: Plan;
  date: string;
  entry: PlanEntry | undefined;
  onClose: () => void;
  onSaved: (p: Plan) => void;
}) {
  const toast = useToast();
  const recipes = useApi<Recipe[]>("/recipes");
  const [q, setQ] = useState("");
  const [freeform, setFreeform] = useState(entry?.freeform_text ?? "");
  const [notes, setNotes] = useState(entry?.notes ?? "");
  const [servings, setServings] = useState(entry?.servings_override?.toString() ?? "");
  const [swapWith, setSwapWith] = useState("");

  const save = async (body: Record<string, unknown>, close = true) => {
    try {
      const p = await put<Plan>(`/plans/${plan.id}/entries`, { date, ...body });
      onSaved(p);
      if (close) onClose();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const swap = async () => {
    if (!swapWith) return;
    try {
      onSaved(await post<Plan>(`/plans/${plan.id}/swap`, { a: date, b: swapWith }));
      onClose();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const filtered = (recipes.data ?? []).filter((r) => {
    if (!q.trim()) return true;
    const s = q.toLowerCase();
    return r.title.toLowerCase().includes(s) || r.tags.some((t) => t.includes(s));
  });
  const title = `${WEEKDAYS_LONG[weekday(date)]}, ${shortDate(date)}`;

  return (
    <Sheet open onClose={onClose} title={title}>
      <div className="stack">
        {entry?.recipe_id && (
          <div className="row">
            <span className="grow">
              <strong>{entry.recipe_title}</strong>
            </span>
            <Link to={`/recipes/${entry.recipe_id}`}>Open recipe</Link>
          </div>
        )}
        <div className="row wrap">
          {["Leftovers", "Eat out", "Pizza night", "Fend for yourself"].map((t) => (
            <button key={t} className="chip" onClick={() => save({ freeform_text: t })}>
              {t}
            </button>
          ))}
        </div>
        <div className="row">
          <input className="grow" placeholder="Something else…" value={freeform} onChange={(e) => setFreeform(e.target.value)} />
          <button disabled={!freeform.trim()} onClick={() => save({ freeform_text: freeform.trim() })}>
            Set
          </button>
        </div>

        <input type="search" placeholder="Search recipes or tags" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <div className="pick-list">
          {recipes.loading && <Loading />}
          {filtered.map((r) => (
            <button key={r.id} className={`pick${entry?.recipe_id === r.id ? " selected" : ""}`} onClick={() => save({ recipe_id: r.id })}>
              <span className="grow">
                {r.favorite && "★ "}
                {r.title}
              </span>
              <span className="muted small-text">{r.total_min ? `${r.total_min} min` : ""}</span>
            </button>
          ))}
          {recipes.data && !filtered.length && <p className="muted">No matching recipes.</p>}
        </div>

        <div className="grid2">
          <label>
            Servings
            <input inputMode="numeric" placeholder="Recipe default" value={servings} onChange={(e) => setServings(e.target.value.replace(/\D/g, ""))} />
          </label>
          <label>
            Note
            <input placeholder="e.g. Grandma visiting" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </div>
        <div className="row wrap">
          <button onClick={() => save({ servings_override: servings ? Number(servings) : null, notes: notes.trim() || null })}>Save servings and note</button>
          <button onClick={() => save({ locked: !entry?.locked }, false)}>{entry?.locked ? "Unlock" : "Lock"}</button>
          {entry && (
            <button className="danger" onClick={() => save({ recipe_id: null, freeform_text: null, locked: false, notes: null, servings_override: null })}>
              Clear day
            </button>
          )}
        </div>
        <div className="row">
          <select className="grow" value={swapWith} onChange={(e) => setSwapWith(e.target.value)} aria-label="Swap with">
            <option value="">Swap with another day…</option>
            {monthDates(plan.month)
              .filter((d) => d !== date)
              .map((d) => (
                <option key={d} value={d}>
                  {WEEKDAYS[weekday(d)]} {shortDate(d)}
                </option>
              ))}
          </select>
          <button disabled={!swapWith} onClick={swap}>
            Swap
          </button>
        </div>
      </div>
    </Sheet>
  );
}
