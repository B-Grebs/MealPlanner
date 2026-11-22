import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { post } from "../api";
import { useToast } from "../App";
import { formatAmount } from "../util";

interface Preview {
  title: string;
  servings?: number;
  tags?: string[];
  duplicate: boolean;
  ingredients?: Array<{ name: string; qty: number | null; unit: string; note: string | null }>;
}
interface ImportResult {
  recipes: Preview[];
  warnings: string[];
  created: Array<{ id: number; title: string }>;
}

const EXAMPLE = `# Chicken Tacos
servings: 4
prep: 10
cook: 20
tags: tacos, quick, kid-fave
note: thaw the chicken the night before

## Ingredients
- 1 lb chicken thighs, diced
- 1 packet taco seasoning
- 8 small tortillas
- 1 cup shredded cheddar

## Steps
1. Brown the chicken.
2. Add seasoning and 2/3 cup water.

---

# Spaghetti and Meatballs
servings: 6
tags: pasta, kid-fave
- 1 lb spaghetti
- 1 jar marinara
- 1 lb frozen meatballs
Heat the sauce and meatballs, boil the pasta.`;

/** Split on recipe separators so big pastes go up in batches the API accepts. */
function batches(text: string, size = 40): string[] {
  const blocks = text.split(/^\s*-{3,}\s*$/m).filter((b) => b.trim());
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i += size) out.push(blocks.slice(i, i + size).join("\n---\n"));
  return out;
}

export default function ImportPage() {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();

  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const all: ImportResult = { recipes: [], warnings: [], created: [] };
      for (const part of batches(text)) {
        const r = await post<ImportResult>(`/import/recipes${dryRun ? "?dryRun=1" : ""}`, { text: part });
        all.recipes.push(...r.recipes);
        all.warnings.push(...r.warnings);
        all.created.push(...r.created);
      }
      if (dryRun) setPreview(all);
      else {
        toast(`Imported ${all.created.length} recipe${all.created.length === 1 ? "" : "s"}`);
        navigate("/recipes");
      }
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const newCount = preview?.recipes.filter((r) => !r.duplicate).length ?? 0;

  return (
    <div className="page">
      <header className="page-head">
        <Link className="icon-btn" to="/recipes" aria-label="Back">
          ‹
        </Link>
        <h1 className="grow">Import recipes</h1>
      </header>
      <p className="hint">
        Paste one or many recipes. Start each with a title line, separate recipes with a line of <code>---</code>, and put
        ingredients on lines starting with <code>-</code>. Recipes whose names already exist are skipped.
      </p>
      <textarea
        rows={14}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setPreview(null);
        }}
        placeholder={EXAMPLE}
        className="mono"
      />
      <div className="row wrap">
        <button className="primary" disabled={busy || !text.trim()} onClick={() => run(true)}>
          {busy ? "Reading…" : "Preview"}
        </button>
        {!text && <button onClick={() => setText(EXAMPLE)}>Use the example</button>}
      </div>

      {preview && (
        <div className="stack">
          {preview.warnings.length > 0 && (
            <div className="warn">
              {preview.warnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          )}
          {preview.recipes.map((r, i) => (
            <div key={i} className={`card${r.duplicate ? " dim" : ""}`}>
              <div className="row">
                <strong className="grow">{r.title}</strong>
                {r.duplicate && <span className="badge">Already have it</span>}
              </div>
              <div className="muted small-text">
                {r.servings} servings{r.tags?.length ? ` · ${r.tags.join(", ")}` : ""}
              </div>
              <ul className="ing-list compact">
                {r.ingredients?.map((i, k) => (
                  <li key={k}>
                    <span className="amt">{formatAmount(i.qty, i.unit)}</span> {i.name}
                    {i.note && <span className="muted">, {i.note}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <button className="primary" disabled={busy || newCount === 0} onClick={() => run(false)}>
            {newCount ? `Import ${newCount} recipe${newCount === 1 ? "" : "s"}` : "Nothing new to import"}
          </button>
        </div>
      )}
    </div>
  );
}
