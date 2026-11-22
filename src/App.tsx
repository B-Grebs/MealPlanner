import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { onSessionExpired } from "./api";
import PlanPage from "./pages/PlanPage";
import RecipesPage from "./pages/RecipesPage";
import RecipePage from "./pages/RecipePage";
import RecipeEdit from "./pages/RecipeEdit";
import ImportPage from "./pages/ImportPage";
import ListsPage from "./pages/ListsPage";
import ListPage from "./pages/ListPage";
import SettingsPage from "./pages/SettingsPage";

type Toast = { id: number; text: string; kind: "info" | "error" };
const ToastCtx = createContext<(text: string, kind?: Toast["kind"]) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

const NAV = [
  { to: "/", label: "Plan", d: "M4 5h16v15H4zM4 10h16M9 3v4M15 3v4", end: true },
  { to: "/recipes", label: "Recipes", d: "M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11M9 8h6" },
  { to: "/lists", label: "Lists", d: "M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" },
  { to: "/settings", label: "Settings", d: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" },
];

export default function App() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [expired, setExpired] = useState(false);
  const toast = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 3000);
  }, []);
  useEffect(() => {
    const off = onSessionExpired(() => setExpired(true));
    return () => {
      off();
    };
  }, []);

  return (
    <ToastCtx.Provider value={toast}>
      <div className="app">
        <nav className="tabs" aria-label="Main">
          <div className="brand">Greb Meals</div>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? "tab active" : "tab")}>
              <Icon d={n.d} />
              <span>{n.label}</span>
            </NavLink>
          ))}
        </nav>
        <main className="content">
          {expired && (
            <div className="banner">
              Your sign-in has expired. <button onClick={() => location.reload()}>Reload</button>
            </div>
          )}
          <Routes>
            <Route path="/" element={<PlanPage />} />
            <Route path="/recipes" element={<RecipesPage />} />
            <Route path="/recipes/new" element={<RecipeEdit />} />
            <Route path="/recipes/import" element={<ImportPage />} />
            <Route path="/recipes/:id" element={<RecipePage />} />
            <Route path="/recipes/:id/edit" element={<RecipeEdit />} />
            <Route path="/lists" element={<ListsPage />} />
            <Route path="/lists/:id" element={<ListPage />} />
            <Route path="/settings/*" element={<SettingsPage />} />
            <Route path="*" element={<Empty title="Page not found" />} />
          </Routes>
        </main>
        <div className="toasts" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>
              {t.text}
            </div>
          ))}
        </div>
      </div>
    </ToastCtx.Provider>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

export function Loading() {
  return <div className="loading">Loading…</div>;
}

export function ErrorBox({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="error-box">
      {error} {retry && <button onClick={retry}>Try again</button>}
    </div>
  );
}
