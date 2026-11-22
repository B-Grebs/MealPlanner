import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { Recipe } from "../api";
import { Empty, ErrorBox, Loading } from "../App";
import { useApi, useDebounced } from "../hooks";
import { minutes } from "../util";

export default function RecipesPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const tag = params.get("tag") ?? "";
  const archived = params.get("archived") === "1";
  const dq = useDebounced(q, 250);
  const qs = new URLSearchParams();
  if (dq.trim()) qs.set("q", dq.trim());
  if (tag) qs.set("tag", tag);
  if (archived) qs.set("archived", "1");
  const recipes = useApi<Recipe[]>(`/recipes?${qs}`);
  const tags = useApi<Array<{ name: string; count: number }>>("/tags");

  const setTag = (t: string) => {
    const p = new URLSearchParams(params);
    if (t && t !== tag) p.set("tag", t);
    else p.delete("tag");
    setParams(p, { replace: true });
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="grow">Recipes</h1>
        <Link className="button" to="/recipes/import">
          Import
        </Link>
        <Link className="button primary" to="/recipes/new">
          New
        </Link>
      </header>
      <input type="search" placeholder="Search by name or ingredient" value={q} onChange={(e) => setQ(e.target.value)} />
      {tags.data && tags.data.length > 0 && (
        <div className="chips">
          {tags.data.map((t) => (
            <button key={t.name} className={`chip${t.name.toLowerCase() === tag ? " on" : ""}`} onClick={() => setTag(t.name.toLowerCase())}>
              {t.name} <span className="muted">{t.count}</span>
            </button>
          ))}
        </div>
      )}
      {recipes.error && <ErrorBox error={recipes.error} retry={recipes.reload} />}
      {recipes.loading && !recipes.data && <Loading />}
      {recipes.data && recipes.data.length === 0 && (
        <Empty title={dq || tag ? "No recipes match" : archived ? "Nothing archived" : "No recipes yet"}>
          {!dq && !tag && !archived && (
            <p>
              Add one, or <Link to="/recipes/import">paste a batch</Link> to get started.
            </p>
          )}
        </Empty>
      )}
      <ul className="cards">
        {recipes.data?.map((r) => (
          <li key={r.id}>
            <Link to={`/recipes/${r.id}`} className="card recipe-card">
              <div className="row">
                <strong className="grow">
                  {r.favorite && <span className="star">★ </span>}
                  {r.title}
                </strong>
                {r.total_min != null && <span className="muted small-text">{minutes(r.total_min)}</span>}
              </div>
              {r.tags.length > 0 && <div className="muted small-text">{r.tags.join(" · ")}</div>}
            </Link>
          </li>
        ))}
      </ul>
      <p className="center">
        <button
          className="link"
          onClick={() => {
            const p = new URLSearchParams(params);
            if (archived) p.delete("archived");
            else p.set("archived", "1");
            setParams(p, { replace: true });
          }}
        >
          {archived ? "Show current recipes" : "Show archived recipes"}
        </button>
      </p>
    </div>
  );
}
