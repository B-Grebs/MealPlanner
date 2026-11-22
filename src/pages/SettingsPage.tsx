import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { del, get, post, put, type Aisle, type Ingredient, type Rule } from "../api";
import { ErrorBox, Loading, useToast } from "../App";
import { useApi } from "../hooks";
import { WEEKDAYS, WEEKDAYS_LONG } from "../util";

export default function SettingsPage() {
  const me = useApi<{ kind: string; email?: string }>("/me");
  return (
    <div className="page">
      <header className="page-head">
        <h1 className="grow">Settings</h1>
      </header>
      <nav className="subtabs">
        <NavLink to="/settings" end>Rules</NavLink>
        <NavLink to="/settings/ingredients">Ingredients</NavLink>
        <NavLink to="/settings/aisles">Aisles</NavLink>
        <NavLink to="/settings/integrations">Home Assistant</NavLink>
        <NavLink to="/settings/store">Store data</NavLink>
      </nav>
      <Routes>
        <Route index element={<Rules />} />
        <Route path="ingredients" element={<Ingredients />} />
        <Route path="aisles" element={<Aisles />} />
        <Route path="integrations" element={<Integrations />} />
        <Route path="store" element={<StoreData />} />
      </Routes>
      {me.data?.email && <p className="hint center">Signed in as {me.data.email}</p>}
    </div>
  );
}

// ------------------------------------------------------------ rules

const KINDS: Record<string, string> = {
  no_repeat_within: "Don't repeat a recipe within N days",
  weekday_theme: "Theme a weekday with a tag",
  fixed_freeform: "Fixed text on a weekday",
  tag_quota: "At least N per week with a tag",
  weekday_max_time: "Max cooking time on some weekdays",
};

function describe(r: Pick<Rule, "kind" | "config">): string {
  const c = r.config;
  switch (r.kind) {
    case "no_repeat_within":
      return `No repeats within ${c.days} days`;
    case "weekday_theme":
      return `${WEEKDAYS_LONG[c.weekday]}: recipes tagged "${c.tag}"`;
    case "fixed_freeform":
      return `${WEEKDAYS_LONG[c.weekday]}: "${c.text}"`;
    case "tag_quota":
      return `${c.per_week}× "${c.tag}" per week`;
    case "weekday_max_time":
      return `${(c.weekdays ?? []).map((d: number) => WEEKDAYS[d]).join(", ")}: ${c.max_total_min} min or less`;
    default:
      return r.kind;
  }
}

function Rules() {
  const rules = useApi<Rule[]>("/rules");
  const toast = useToast();
  const [kind, setKind] = useState("weekday_theme");
  const [wd, setWd] = useState(2);
  const [tag, setTag] = useState("");
  const [text, setText] = useState("");
  const [num, setNum] = useState(14);
  const [days, setDays] = useState<number[]>([1, 2, 3, 4]);

  const save = async (r: Rule, patch: Partial<Rule>) => {
    try {
      await put(`/rules/${r.id}`, { ...r, ...patch });
      void rules.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const remove = async (r: Rule) => {
    if (!confirm(`Delete the rule "${r.name}"?`)) return;
    await del(`/rules/${r.id}`).catch((e) => toast(e.message, "error"));
    void rules.reload();
  };
  const add = async () => {
    const config =
      kind === "no_repeat_within" ? { days: num } :
      kind === "weekday_theme" ? { weekday: wd, tag } :
      kind === "fixed_freeform" ? { weekday: wd, text } :
      kind === "tag_quota" ? { tag, per_week: num } :
      { weekdays: days, max_total_min: num };
    try {
      await post("/rules", { kind, config, name: describe({ kind, config }) });
      setTag("");
      setText("");
      void rules.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <div className="stack">
      <p className="hint">Rules shape "Regenerate unlocked". Locked days are never changed.</p>
      {rules.error && <ErrorBox error={rules.error} retry={rules.reload} />}
      {rules.loading && !rules.data && <Loading />}
      <ul className="cards">
        {rules.data?.map((r) => (
          <li key={r.id} className="card row">
            <label className="check grow">
              <input type="checkbox" checked={r.active} onChange={() => save(r, { active: !r.active })} />
              <span>
                {r.name}
                <span className="muted small-text block">{describe(r)}</span>
              </span>
            </label>
            <button className="icon-btn subtle" onClick={() => remove(r)} aria-label="Delete rule">✕</button>
          </li>
        ))}
      </ul>
      <section className="card stack">
        <h2>Add a rule</h2>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {Object.entries(KINDS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        {(kind === "weekday_theme" || kind === "fixed_freeform") && (
          <select value={wd} onChange={(e) => setWd(Number(e.target.value))}>
            {WEEKDAYS_LONG.map((d, i) => <option key={d} value={i}>{d}</option>)}
          </select>
        )}
        {(kind === "weekday_theme" || kind === "tag_quota") && <input placeholder="Tag (e.g. tacos, fish)" value={tag} onChange={(e) => setTag(e.target.value)} />}
        {kind === "fixed_freeform" && <input placeholder="Text (e.g. Pizza night)" value={text} onChange={(e) => setText(e.target.value)} />}
        {(kind === "no_repeat_within" || kind === "tag_quota" || kind === "weekday_max_time") && (
          <label>
            {kind === "no_repeat_within" ? "Days" : kind === "tag_quota" ? "Per week" : "Max minutes"}
            <input type="number" min={1} value={num} onChange={(e) => setNum(Number(e.target.value))} />
          </label>
        )}
        {kind === "weekday_max_time" && (
          <div className="row wrap">
            {WEEKDAYS.map((d, i) => (
              <button key={d} className={`chip${days.includes(i) ? " on" : ""}`} onClick={() => setDays((ds) => (ds.includes(i) ? ds.filter((x) => x !== i) : [...ds, i].sort()))}>
                {d}
              </button>
            ))}
          </div>
        )}
        <button className="primary" onClick={add}>Add rule</button>
      </section>
    </div>
  );
}

// ------------------------------------------------------------ ingredients

function Ingredients() {
  const ings = useApi<Ingredient[]>("/ingredients");
  const aisles = useApi<Aisle[]>("/aisles");
  const toast = useToast();
  const [filter, setFilter] = useState("");
  const [onlyNoAisle, setOnlyNoAisle] = useState(false);
  const [mergeFrom, setMergeFrom] = useState<Ingredient | null>(null);
  const [mergeInto, setMergeInto] = useState("");

  const update = async (i: Ingredient, body: Record<string, unknown>) => {
    try {
      const next = await put<Ingredient>(`/ingredients/${i.id}`, body);
      ings.setData((ings.data ?? []).map((x) => (x.id === i.id ? { ...x, ...next } : x)));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const merge = async () => {
    const target = ings.data?.find((x) => x.name === mergeInto.trim().toLowerCase());
    if (!mergeFrom || !target) return toast("Pick an existing ingredient to merge into", "error");
    try {
      await post(`/ingredients/${mergeFrom.id}/merge-into/${target.id}`);
      toast(`Merged "${mergeFrom.name}" into "${target.name}"`);
      setMergeFrom(null);
      setMergeInto("");
      void ings.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const shown = (ings.data ?? []).filter((i) => (!filter || i.name.includes(filter.toLowerCase())) && (!onlyNoAisle || !i.aisle_id));
  const noAisle = (ings.data ?? []).filter((i) => !i.aisle_id).length;

  return (
    <div className="stack">
      <p className="hint">Aisles group the shopping list. Staples are left off lists unless you ask for them.</p>
      <div className="row wrap">
        <input type="search" className="grow" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={onlyNoAisle} onChange={(e) => setOnlyNoAisle(e.target.checked)} /> No aisle yet ({noAisle})
        </label>
      </div>
      {ings.loading && !ings.data && <Loading />}
      {ings.error && <ErrorBox error={ings.error} retry={ings.reload} />}
      <div className="ing-table">
        {shown.map((i) => (
          <div key={i.id} className="ing-line">
            <span className="grow">
              {i.name} <span className="muted small-text">{i.uses ? `${i.uses} recipe${i.uses === 1 ? "" : "s"}` : "unused"}</span>
            </span>
            <select value={i.aisle_id ?? ""} onChange={(e) => update(i, { aisle_id: e.target.value ? Number(e.target.value) : null })} aria-label={`Aisle for ${i.name}`}>
              <option value="">No aisle</option>
              {aisles.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <label className="check">
              <input type="checkbox" checked={i.is_staple} onChange={() => update(i, { is_staple: !i.is_staple })} /> Staple
            </label>
            <button className="small" onClick={() => setMergeFrom(i)}>Merge</button>
          </div>
        ))}
      </div>
      {mergeFrom && (
        <section className="card stack">
          <h2>Merge "{mergeFrom.name}" into…</h2>
          <input list="ing-names" value={mergeInto} onChange={(e) => setMergeInto(e.target.value)} placeholder="yellow onion" />
          <datalist id="ing-names">
            {ings.data?.filter((x) => x.id !== mergeFrom.id).map((x) => <option key={x.id} value={x.name} />)}
          </datalist>
          <p className="hint">Every recipe using "{mergeFrom.name}" will use the other one instead, then "{mergeFrom.name}" is removed.</p>
          <div className="row">
            <button className="primary" onClick={merge}>Merge</button>
            <button onClick={() => setMergeFrom(null)}>Cancel</button>
          </div>
        </section>
      )}
    </div>
  );
}

// ------------------------------------------------------------ aisles

function Aisles() {
  const aisles = useApi<Aisle[]>("/aisles");
  const [rows, setRows] = useState<Array<{ id?: number; name: string }>>([]);
  const [dirty, setDirty] = useState(false);
  const toast = useToast();
  useEffect(() => {
    if (aisles.data) setRows(aisles.data.map((a) => ({ id: a.id, name: a.name })));
  }, [aisles.data]);
  const change = (fn: (r: typeof rows) => typeof rows) => {
    setRows(fn);
    setDirty(true);
  };
  const move = (i: number, d: number) =>
    change((r) => {
      const j = i + d;
      if (j < 0 || j >= r.length) return r;
      const c = [...r];
      [c[i], c[j]] = [c[j], c[i]];
      return c;
    });
  const save = async () => {
    try {
      await put("/aisles", rows.filter((r) => r.name.trim()));
      setDirty(false);
      toast("Aisle order saved");
      void aisles.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <div className="stack">
      <p className="hint">Put these in the order you walk your store. Lists follow this order.</p>
      {aisles.loading && !aisles.data && <Loading />}
      {rows.map((r, i) => (
        <div key={r.id ?? `new${i}`} className="row">
          <input className="grow" value={r.name} onChange={(e) => change((rs) => rs.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
          <button className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Up">↑</button>
          <button className="icon-btn" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label="Down">↓</button>
          <button className="icon-btn subtle" onClick={() => change((rs) => rs.filter((_, k) => k !== i))} aria-label="Remove">✕</button>
        </div>
      ))}
      <div className="row">
        <button onClick={() => change((r) => [...r, { name: "" }])}>Add aisle</button>
        <button className="primary" disabled={!dirty} onClick={save}>Save order</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ integrations

interface Client { id: number; name: string; client_id: string; scopes: string[]; active: boolean; last_seen_at: string | null }
interface FeedToken { id: number; name: string; created_at: string; last_used_at: string | null; revoked: boolean }

function Integrations() {
  const clients = useApi<Client[]>("/clients");
  const feeds = useApi<FeedToken[]>("/feed-tokens");
  const toast = useToast();
  const [name, setName] = useState("Home Assistant");
  const [clientId, setClientId] = useState("");
  const [scopes, setScopes] = useState<string[]>(["ha"]);
  const [newFeed, setNewFeed] = useState<{ url: string } | null>(null);
  const origin = location.origin;

  const addClient = async () => {
    try {
      await post("/clients", { name, client_id: clientId.trim(), scopes });
      setClientId("");
      void clients.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const toggleClient = async (c: Client) => {
    await put(`/clients/${c.id}`, { active: !c.active }).catch((e) => toast(e.message, "error"));
    void clients.reload();
  };
  const removeClient = async (c: Client) => {
    if (!confirm(`Remove ${c.name}? Its service token stops working here.`)) return;
    await del(`/clients/${c.id}`).catch((e) => toast(e.message, "error"));
    void clients.reload();
  };
  const createFeed = async () => {
    try {
      setNewFeed(await post<{ url: string }>("/feed-tokens", { name: "Calendar" }));
      void feeds.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const revoke = async (f: FeedToken) => {
    if (!confirm("Revoke this calendar link? Calendars using it stop updating.")) return;
    await del(`/feed-tokens/${f.id}`).catch((e) => toast(e.message, "error"));
    void feeds.reload();
  };

  const yaml = `rest:
  - resource: ${origin}/api/ha/today
    headers:
      CF-Access-Client-Id: !secret meals_client_id
      CF-Access-Client-Secret: !secret meals_client_secret
    scan_interval: 900
    sensor:
      - name: Dinner tonight
        unique_id: meals_dinner_tonight
        value_template: "{{ value_json.dinner or 'Nothing planned' }}"
        json_attributes: [date, recipe_id, prep_note, tomorrow]`;

  return (
    <div className="stack">
      <section className="card stack">
        <h2>Calendar feed</h2>
        <p className="hint">A private link with the active plan's dinners, for Home Assistant's Remote Calendar, Google Calendar or DAKboard. Anyone with the link can see dinner names, so treat it like a password.</p>
        {newFeed && (
          <div className="warn">
            Copy this now; it won't be shown again:
            <input readOnly value={newFeed.url} onFocus={(e) => e.target.select()} className="mono" />
          </div>
        )}
        <ul className="plain">
          {feeds.data?.filter((f) => !f.revoked).map((f) => (
            <li key={f.id} className="row">
              <span className="grow">
                {f.name} <span className="muted small-text">{f.last_used_at ? `last read ${new Date(f.last_used_at).toLocaleString()}` : "never read"}</span>
              </span>
              <button className="small danger" onClick={() => revoke(f)}>Revoke</button>
            </li>
          ))}
        </ul>
        <button onClick={createFeed}>Create calendar link</button>
      </section>

      <section className="card stack">
        <h2>Service tokens</h2>
        <p className="hint">
          Create a service token in Cloudflare Zero Trust (Access → Service auth), allow it in the Greb Meals Access app, then register its Client ID here. "ha" reads tonight's dinner,
          "ingest" lets a feeder push store prices and orders, "read" can read recipes and plans.
        </p>
        {clients.error && <ErrorBox error={clients.error} />}
        <ul className="plain">
          {clients.data?.map((c) => (
            <li key={c.id} className="row">
              <span className="grow">
                <strong>{c.name}</strong> <span className="muted small-text">{c.scopes.join(", ")}</span>
                <span className="muted small-text block mono">{c.client_id}</span>
                <span className="muted small-text block">{c.last_seen_at ? `last seen ${new Date(c.last_seen_at).toLocaleString()}` : "not seen yet"}</span>
              </span>
              <button className="small" onClick={() => toggleClient(c)}>{c.active ? "Disable" : "Enable"}</button>
              <button className="small danger" onClick={() => removeClient(c)}>Remove</button>
            </li>
          ))}
        </ul>
        <div className="grid2">
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="Client ID (….access)" value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </div>
        <div className="row wrap">
          {["ha", "ingest", "read"].map((s) => (
            <button key={s} className={`chip${scopes.includes(s) ? " on" : ""}`} onClick={() => setScopes((x) => (x.includes(s) ? x.filter((y) => y !== s) : [...x, s]))}>
              {s}
            </button>
          ))}
          <button className="primary" disabled={!name.trim() || !clientId.trim() || !scopes.length} onClick={addClient}>
            Register
          </button>
        </div>
      </section>

      <section className="card stack">
        <h2>Home Assistant sensor</h2>
        <p className="hint">Add to configuration.yaml, with the token's ID and secret in secrets.yaml.</p>
        <pre className="code">{yaml}</pre>
      </section>
    </div>
  );
}

// ------------------------------------------------------------ store data

interface Retailer { id: number; slug: string; name: string; products: number; purchases: number }
interface Run { id: number; kind: string; received: number; inserted: number; updated: number; skipped: number; errors: unknown[]; at: string }
interface Product { id: number; retailer: string; external_id: string; name: string; brand: string | null; size_text: string | null; price_cents: number | null; price_observed_at: string | null }

function StoreData() {
  const retailers = useApi<Retailer[]>("/retailers");
  const runs = useApi<Run[]>("/ingest/runs");
  const [q, setQ] = useState("");
  const [products, setProducts] = useState<Product[] | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      get<Product[]>(`/store-products${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`).then((p) => live && setProducts(p)).catch(() => undefined);
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  return (
    <div className="stack">
      <p className="hint">
        Store products, prices and order history arrive from feeders (for example an agent on the rig) through the ingest API with a service token. Nothing here scrapes
        a store. See ARCHITECTURE.md §7.
      </p>
      <div className="grid3">
        {retailers.data?.map((r) => (
          <div key={r.id} className="card">
            <strong>{r.name}</strong>
            <div className="muted small-text">
              {r.products} products · {r.purchases} orders
            </div>
          </div>
        ))}
      </div>
      <section className="card stack">
        <h2>Products</h2>
        <input type="search" placeholder="Search products" value={q} onChange={(e) => setQ(e.target.value)} />
        {products && !products.length && <p className="muted">No products yet.</p>}
        <ul className="plain">
          {products?.map((p) => (
            <li key={p.id} className="row">
              <span className="grow">
                {p.name} <span className="muted small-text">{[p.brand, p.size_text].filter(Boolean).join(" · ")}</span>
              </span>
              <span className="muted small-text">{p.retailer}</span>
              <span>{p.price_cents != null ? `$${(p.price_cents / 100).toFixed(2)}` : ""}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="card stack">
        <h2>Recent feeds</h2>
        {runs.data && !runs.data.length && <p className="muted">No feeder has sent anything yet.</p>}
        <ul className="plain">
          {runs.data?.map((r) => (
            <li key={r.id} className="row">
              <span className="grow">
                {r.kind} <span className="muted small-text">{new Date(r.at).toLocaleString()}</span>
              </span>
              <span className="small-text">
                {r.received} in · {r.inserted} new · {r.updated} updated{r.errors.length ? ` · ${r.errors.length} errors` : ""}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
