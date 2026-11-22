import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { get, post, put, type Ingredient, type RecipeFull } from "../api";
import { ErrorBox, Loading, useToast } from "../App";
import { useDebounced } from "../hooks";

interface Row {
  key: number;
  ingredient_id: number | null;
  name: string;
  qty: string;
  unit: string;
  note: string;
}

let rowKey = 1;
const blankRow = (): Row => ({ key: rowKey++, ingredient_id: null, name: "", qty: "", unit: "", note: "" });
const UNITS = ["", "tsp", "tbsp", "cup", "fl oz", "oz", "lb", "g", "kg", "ml", "l", "can", "jar", "clove", "bunch", "head", "packet", "package", "bag", "slice", "stick", "pinch"];

function parseQty(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const mixed = t.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = t.match(/^(\d+)\/(\d+)$/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export default function RecipeEdit() {
  const { id } = useParams();
  const editing = !!id;
  const navigate = useNavigate();
  const toast = useToast();
  const [loaded, setLoaded] = useState(!editing);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [servings, setServings] = useState("4");
  const [prep, setPrep] = useState("");
  const [cook, setCook] = useState("");
  const [tags, setTags] = useState("");
  const [source, setSource] = useState("");
  const [prepNote, setPrepNote] = useState("");
  const [favorite, setFavorite] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [rows, setRows] = useState<Row[]>([blankRow()]);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [paste, setPaste] = useState("");

  useEffect(() => {
    if (!editing) return;
    get<RecipeFull>(`/recipes/${id}`)
      .then((r) => {
        setTitle(r.title);
        setDescription(r.description ?? "");
        setServings(String(r.servings));
        setPrep(r.prep_min?.toString() ?? "");
        setCook(r.cook_min?.toString() ?? "");
        setTags(r.tags.join(", "));
        setSource(r.source_url ?? "");
        setPrepNote(r.prep_note ?? "");
        setFavorite(r.favorite);
        setInstructions(r.instructions_md ?? "");
        setRows(
          r.ingredients.length
            ? r.ingredients.map((i) => ({
                key: rowKey++,
                ingredient_id: i.ingredient_id,
                name: i.name,
                qty: i.qty == null ? "" : String(Math.round(i.qty * 1000) / 1000),
                unit: i.unit,
                note: i.note ?? "",
              }))
            : [blankRow()],
        );
        setLoaded(true);
      })
      .catch((e) => setError(e.message));
  }, [id, editing]);

  const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const remove = (key: number) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.key !== key) : [blankRow()]));
  const move = (key: number, d: -1 | 1) =>
    setRows((rs) => {
      const i = rs.findIndex((r) => r.key === key);
      const j = i + d;
      if (j < 0 || j >= rs.length) return rs;
      const copy = [...rs];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });

  /** Parse pasted ingredient lines with the server's import parser (dry run). */
  const applyPaste = async () => {
    try {
      const res = await post<{ recipes: Array<{ ingredients: Array<{ name: string; qty: number | null; unit: string; note: string | null }> }> }>(
        "/import/recipes?dryRun=1",
        { text: `# x\n## Ingredients\n${paste}` },
      );
      const parsed = res.recipes[0]?.ingredients ?? [];
      const newRows = parsed.map((i) => ({
        key: rowKey++,
        ingredient_id: null,
        name: i.name,
        qty: i.qty == null ? "" : String(Math.round(i.qty * 1000) / 1000),
        unit: i.unit ?? "",
        note: i.note ?? "",
      }));
      setRows((rs) => [...rs.filter((r) => r.name.trim()), ...newRows]);
      setPaste("");
      setPasteOpen(false);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const save = async () => {
    if (!title.trim()) return toast("Give the recipe a name", "error");
    setSaving(true);
    const body = {
      title: title.trim(),
      description: description.trim() || null,
      servings: Number(servings) || 4,
      prep_min: prep ? Number(prep) : null,
      cook_min: cook ? Number(cook) : null,
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      source_url: source.trim() || null,
      prep_note: prepNote.trim() || null,
      favorite,
      instructions_md: instructions.trim() || null,
      ingredients: rows
        .filter((r) => r.name.trim())
        .map((r) => ({ name: r.name.trim(), qty: parseQty(r.qty), unit: r.unit, note: r.note.trim() || null })),
    };
    try {
      const saved = editing ? await put<RecipeFull>(`/recipes/${id}`, body) : await post<RecipeFull>("/recipes", body);
      toast("Saved");
      navigate(`/recipes/${saved.id}`, { replace: true });
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!loaded) return <div className="page"><Loading /></div>;

  return (
    <div className="page">
      <header className="page-head">
        <button className="icon-btn" onClick={() => navigate(-1)} aria-label="Back">
          ‹
        </button>
        <h1 className="grow">{editing ? "Edit recipe" : "New recipe"}</h1>
        <button className="primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </button>
      </header>
      <div className="stack">
        <label>
          Name
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Chicken tacos" />
        </label>
        <div className="grid3">
          <label>
            Servings
            <input inputMode="numeric" value={servings} onChange={(e) => setServings(e.target.value.replace(/\D/g, ""))} />
          </label>
          <label>
            Prep (min)
            <input inputMode="numeric" value={prep} onChange={(e) => setPrep(e.target.value.replace(/\D/g, ""))} />
          </label>
          <label>
            Cook (min)
            <input inputMode="numeric" value={cook} onChange={(e) => setCook(e.target.value.replace(/\D/g, ""))} />
          </label>
        </div>
        <label>
          Tags <span className="muted">(comma separated: tacos, quick, kid-fave, fish)</span>
          <input value={tags} onChange={(e) => setTags(e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={favorite} onChange={(e) => setFavorite(e.target.checked)} /> Favourite (planned more often)
        </label>

        <section className="card">
          <div className="row">
            <h2 className="grow">Ingredients</h2>
            <button className="small" onClick={() => setPasteOpen((o) => !o)}>
              Paste lines
            </button>
          </div>
          {pasteOpen && (
            <div className="stack">
              <textarea rows={6} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={"1 lb ground beef\n1 packet taco seasoning\n2 cups shredded cheddar"} />
              <button disabled={!paste.trim()} onClick={applyPaste}>
                Add these
              </button>
            </div>
          )}
          <div className="ing-rows">
            {rows.map((r, i) => (
              <IngredientRow key={r.key} row={r} first={i === 0} last={i === rows.length - 1} onChange={(p) => update(r.key, p)} onRemove={() => remove(r.key)} onMove={(d) => move(r.key, d)} />
            ))}
          </div>
          <button onClick={() => setRows((rs) => [...rs, blankRow()])}>Add ingredient</button>
        </section>

        <label>
          Steps
          <textarea rows={8} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder={"1. Brown the beef.\n2. …"} />
        </label>
        <label>
          Ahead-of-time note <span className="muted">(Home Assistant can remind the night before)</span>
          <input value={prepNote} onChange={(e) => setPrepNote(e.target.value)} placeholder="Thaw the chicken" />
        </label>
        <label>
          Description
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          Source link
          <input type="url" value={source} onChange={(e) => setSource(e.target.value)} placeholder="https://…" />
        </label>
        <button className="primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save recipe"}
        </button>
      </div>
    </div>
  );
}

function IngredientRow({
  row,
  first,
  last,
  onChange,
  onRemove,
  onMove,
}: {
  row: Row;
  first: boolean;
  last: boolean;
  onChange: (p: Partial<Row>) => void;
  onRemove: () => void;
  onMove: (d: -1 | 1) => void;
}) {
  const [focus, setFocus] = useState(false);
  const dq = useDebounced(row.name, 150);
  const [suggestions, setSuggestions] = useState<Ingredient[]>([]);
  useEffect(() => {
    if (!focus || dq.trim().length < 2) return setSuggestions([]);
    let live = true;
    get<Ingredient[]>(`/ingredients?q=${encodeURIComponent(dq.trim())}`)
      .then((s) => live && setSuggestions(s.filter((x) => x.name !== dq.trim().toLowerCase()).slice(0, 6)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [dq, focus]);

  return (
    <div className="ing-row">
      <input className="qty" inputMode="decimal" placeholder="Qty" value={row.qty} onChange={(e) => onChange({ qty: e.target.value })} aria-label="Quantity" />
      <select className="unit" value={UNITS.includes(row.unit) ? row.unit : "__other"} onChange={(e) => onChange({ unit: e.target.value === "__other" ? row.unit : e.target.value })} aria-label="Unit">
        {UNITS.map((u) => (
          <option key={u} value={u}>
            {u || "each"}
          </option>
        ))}
        {!UNITS.includes(row.unit) && <option value="__other">{row.unit}</option>}
      </select>
      <div className="name-wrap">
        <input
          placeholder="Ingredient"
          value={row.name}
          onChange={(e) => onChange({ name: e.target.value, ingredient_id: null })}
          onFocus={() => setFocus(true)}
          onBlur={() => setTimeout(() => setFocus(false), 150)}
          aria-label="Ingredient"
        />
        {focus && suggestions.length > 0 && (
          <div className="suggest">
            {suggestions.map((s) => (
              <button key={s.id} onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange({ name: s.name, ingredient_id: s.id }); setSuggestions([]); }}>
                {s.name}
                {s.aisle && <span className="muted"> · {s.aisle}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <input className="note" placeholder="Note (diced)" value={row.note} onChange={(e) => onChange({ note: e.target.value })} aria-label="Note" />
      <div className="row-actions">
        <button className="icon-btn" disabled={first} onClick={() => onMove(-1)} aria-label="Move up">↑</button>
        <button className="icon-btn" disabled={last} onClick={() => onMove(1)} aria-label="Move down">↓</button>
        <button className="icon-btn" onClick={onRemove} aria-label="Remove">✕</button>
      </div>
    </div>
  );
}
