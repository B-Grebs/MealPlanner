import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { del, patch, post, type ListItem, type ShoppingList } from "../api";
import { ErrorBox, Loading, useToast } from "../App";
import { useApi } from "../hooks";
import { cap, formatAmount, shortDate } from "../util";

export default function ListPage() {
  const { id } = useParams();
  const list = useApi<ShoppingList>(`/lists/${id}`);
  const [text, setText] = useState("");
  const [hideChecked, setHideChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();

  const groups = useMemo(() => {
    if (!list.data) return [];
    const order = list.data.aisle_order;
    const by = new Map<string, ListItem[]>();
    for (const it of list.data.items) {
      if (hideChecked && it.checked) continue;
      const a = it.aisle ?? "Other";
      by.set(a, [...(by.get(a) ?? []), it]);
    }
    const rank = (a: string) => {
      const i = order.indexOf(a);
      return i < 0 ? (a === "Other" ? 10_001 : 10_000) : i;
    };
    return [...by.entries()]
      .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
      .map(([aisle, items]) => ({
        aisle,
        items: [...items].sort((x, y) => Number(x.checked) - Number(y.checked) || x.text.localeCompare(y.text)),
      }));
  }, [list.data, hideChecked]);

  if (list.error && !list.data) return <div className="page"><ErrorBox error={list.error} retry={list.reload} /></div>;
  if (!list.data) return <div className="page"><Loading /></div>;
  const l = list.data;
  const total = l.items.length;
  const checked = l.items.filter((i) => i.checked).length;

  const toggle = async (item: ListItem) => {
    // Optimistic: flip locally, then sync.
    list.setData({ ...l, items: l.items.map((i) => (i.id === item.id ? { ...i, checked: !i.checked } : i)) });
    try {
      await patch(`/lists/${l.id}/items/${item.id}`, { checked: !item.checked });
    } catch (e) {
      toast((e as Error).message, "error");
      void list.reload();
    }
  };
  const add = async () => {
    if (!text.trim()) return;
    try {
      list.setData(await post<ShoppingList>(`/lists/${l.id}/items`, { text: text.trim() }));
      setText("");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const remove = async (item: ListItem) => {
    try {
      list.setData(await del<ShoppingList>(`/lists/${l.id}/items/${item.id}`));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const regenerate = async () => {
    if (!confirm("Rebuild this list from the current plan? Manual items and matching checks are kept.")) return;
    setBusy(true);
    try {
      list.setData(await post<ShoppingList>(`/lists/${l.id}/regenerate`));
      toast("List rebuilt from the plan");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const setStatus = async (status: "open" | "done") => {
    try {
      list.setData(await patch<ShoppingList>(`/lists/${l.id}`, { status }));
      if (status === "done") toast("Marked done");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const deleteList = async () => {
    if (!confirm(`Delete "${l.name}"?`)) return;
    try {
      await del(`/lists/${l.id}`);
      navigate("/lists", { replace: true });
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <div className="page list-page">
      <header className="page-head">
        <button className="icon-btn" onClick={() => navigate("/lists")} aria-label="Back">
          ‹
        </button>
        <h1 className="grow">{l.name}</h1>
        <span className="progress-text">
          {checked}/{total}
        </span>
      </header>
      <div className="progress" aria-hidden="true">
        <div style={{ width: total ? `${(checked / total) * 100}%` : 0 }} />
      </div>
      {list.error && <div className="warn">Showing the last saved copy: {list.error}</div>}
      <form
        className="row add-row"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input className="grow" placeholder="Add an item (paper towels)" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="primary" disabled={!text.trim()}>
          Add
        </button>
      </form>

      {groups.map((g) => (
        <section key={g.aisle} className="aisle">
          <h2 className="aisle-name">{g.aisle}</h2>
          <ul className="items">
            {g.items.map((it) => (
              <li key={it.id} className={it.checked ? "checked" : ""}>
                <label className="item">
                  <input type="checkbox" checked={it.checked} onChange={() => toggle(it)} />
                  <span className="item-text">
                    {cap(it.text)}
                    {(it.qty != null || it.unit) && <span className="item-amt"> {formatAmount(it.qty, it.unit)}</span>}
                  </span>
                </label>
                {it.manual && (
                  <button className="icon-btn subtle" onClick={() => remove(it)} aria-label={`Remove ${it.text}`}>
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {!total && <p className="muted center">Nothing on this list. Plan some dinners, or add items above.</p>}

      <div className="toolbar bottom">
        <label className="check">
          <input type="checkbox" checked={hideChecked} onChange={(e) => setHideChecked(e.target.checked)} /> Hide checked
        </label>
        <button disabled={busy} onClick={regenerate}>
          Regenerate
        </button>
        {l.status === "open" ? <button onClick={() => setStatus("done")}>Mark done</button> : <button onClick={() => setStatus("open")}>Reopen</button>}
        <button className="danger" onClick={deleteList}>
          Delete
        </button>
      </div>
      <p className="hint center">
        From the plan for {shortDate(l.start_date)}
        {l.end_date !== l.start_date ? ` – ${shortDate(l.end_date)}` : ""}
        {l.include_staples ? ", staples included" : ", staples left off"}.
      </p>
    </div>
  );
}
