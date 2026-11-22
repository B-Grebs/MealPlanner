import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { patch, type RecipeFull } from "../api";
import { ErrorBox, Loading, useToast } from "../App";
import { useApi } from "../hooks";
import { cap, formatAmount, minutes } from "../util";

export default function RecipePage() {
  const { id } = useParams();
  const r = useApi<RecipeFull>(`/recipes/${id}`);
  const [servings, setServings] = useState<number | null>(null);
  const toast = useToast();
  const navigate = useNavigate();

  if (r.error) return <div className="page"><ErrorBox error={r.error} retry={r.reload} /></div>;
  if (!r.data) return <div className="page"><Loading /></div>;
  const recipe = r.data;
  const s = servings ?? recipe.servings;
  const scale = s / recipe.servings;

  const toggle = async (field: "favorite" | "archived") => {
    try {
      const next = await patch<RecipeFull>(`/recipes/${recipe.id}`, { [field]: !recipe[field] });
      r.setData(next);
      if (field === "archived") toast(next.archived ? "Archived. It won't be planned anymore." : "Restored");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <button className="icon-btn" onClick={() => navigate(-1)} aria-label="Back">
          ‹
        </button>
        <h1 className="grow">{recipe.title}</h1>
        <button className={`icon-btn star-btn${recipe.favorite ? " on" : ""}`} onClick={() => toggle("favorite")} aria-label="Favourite">
          {recipe.favorite ? "★" : "☆"}
        </button>
        <Link className="button" to={`/recipes/${recipe.id}/edit`}>
          Edit
        </Link>
      </header>
      {recipe.archived && <div className="warn">This recipe is archived.</div>}
      <div className="meta row wrap">
        {recipe.prep_min != null && <span>Prep {minutes(recipe.prep_min)}</span>}
        {recipe.cook_min != null && <span>Cook {minutes(recipe.cook_min)}</span>}
        {recipe.tags.map((t) => (
          <Link key={t} className="chip" to={`/recipes?tag=${encodeURIComponent(t)}`}>
            {t}
          </Link>
        ))}
      </div>
      {recipe.description && <p>{recipe.description}</p>}
      {recipe.prep_note && <p className="hint">Ahead of time: {recipe.prep_note}</p>}

      <section className="card">
        <div className="row">
          <h2 className="grow">Ingredients</h2>
          <div className="stepper" aria-label="Servings">
            <button onClick={() => setServings(Math.max(1, s - 1))} aria-label="Fewer servings">
              −
            </button>
            <span>{s} servings</span>
            <button onClick={() => setServings(s + 1)} aria-label="More servings">
              +
            </button>
          </div>
        </div>
        <ul className="ing-list">
          {recipe.ingredients.map((i) => (
            <li key={i.id}>
              <span className="amt">{formatAmount(i.qty == null ? null : i.qty * scale, i.unit)}</span>{" "}
              <span>{cap(i.name)}</span>
              {i.note && <span className="muted">, {i.note}</span>}
            </li>
          ))}
          {!recipe.ingredients.length && <li className="muted">No ingredients yet.</li>}
        </ul>
      </section>

      {recipe.instructions_md && (
        <section className="card">
          <h2>Steps</h2>
          <div className="steps">{recipe.instructions_md}</div>
        </section>
      )}
      {recipe.source_url && (
        <p>
          <a href={recipe.source_url} target="_blank" rel="noreferrer noopener">
            Original recipe
          </a>
        </p>
      )}
      <p className="center">
        <button className="link" onClick={() => toggle("archived")}>
          {recipe.archived ? "Restore recipe" : "Archive recipe"}
        </button>
      </p>
    </div>
  );
}
