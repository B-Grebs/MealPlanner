import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { post, type ListSummary } from "../api";
import { Empty, ErrorBox, Loading, useToast } from "../App";
import { useApi } from "../hooks";
import { addDays, localToday, shortDate } from "../util";

export default function ListsPage() {
  const lists = useApi<ListSummary[]>("/lists");
  const today = localToday();
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(addDays(today, 6));
  const [staples, setStaples] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();

  const create = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const l = await post<{ id: number }>("/lists", body);
      navigate(`/lists/${l.id}`);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const open = lists.data?.filter((l) => l.status === "open") ?? [];
  const done = lists.data?.filter((l) => l.status === "done") ?? [];

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="grow">Shopping lists</h1>
      </header>
      <section className="card stack">
        <h2>New list from the plan</h2>
        <div className="grid2">
          <label>
            From
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={staples} onChange={(e) => setStaples(e.target.checked)} /> Include staples (salt, oil…)
        </label>
        <div className="row wrap">
          <button className="primary" disabled={busy || end < start} onClick={() => create({ start, end, includeStaples: staples })}>
            Make list
          </button>
          <button disabled={busy} onClick={() => create({ start: today, end: today, includeStaples: staples })}>
            Just today
          </button>
        </div>
        <p className="hint">Lists read the active plan for each month. Generated lists don't change when you edit the plan; use Regenerate on the list.</p>
      </section>

      {lists.error && <ErrorBox error={lists.error} retry={lists.reload} />}
      {lists.loading && !lists.data && <Loading />}
      {lists.data && !lists.data.length && <Empty title="No lists yet" />}
      {open.length > 0 && <ListGroup title="Open" lists={open} />}
      {done.length > 0 && <ListGroup title="Done" lists={done} />}
    </div>
  );
}

function ListGroup({ title, lists }: { title: string; lists: ListSummary[] }) {
  return (
    <>
      <h2 className="section-title">{title}</h2>
      <ul className="cards">
        {lists.map((l) => (
          <li key={l.id}>
            <Link to={`/lists/${l.id}`} className="card row">
              <span className="grow">
                <strong>{l.name}</strong>
                <span className="muted small-text block">
                  {shortDate(l.start_date)}
                  {l.end_date !== l.start_date ? ` – ${shortDate(l.end_date)}` : ""}
                </span>
              </span>
              <span className="progress-text">
                {l.checked}/{l.total}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
