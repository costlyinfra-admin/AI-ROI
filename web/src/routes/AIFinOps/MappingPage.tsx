import { useState } from "react";
import { api, type FinopsFeature } from "../../lib/api";

interface UnmappedSignal {
  signal_id:   string;
  source:      string;
  external_ref: string | null;
  actor:       string | null;
  occurred_at: string;
  signal_kind: string;
}

export function MappingPage() {
  const [features, setFeatures] = useState<FinopsFeature[] | null>(null);
  const [unmapped, setUnmapped] = useState<UnmappedSignal[] | null>(null);
  const [tab, setTab] = useState<"rules" | "unmapped">("unmapped");
  const [assigning, setAssigning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load on mount
  useState(() => {
    api.listFinopsFeatures()
       .then((r) => setFeatures(r.features))
       .catch((e: Error) => setError(e.message));
    // Unmapped signals come from the costs API; for now show placeholder
    setUnmapped([]);
  });

  async function assign(signal: UnmappedSignal, featureId: string) {
    setAssigning(signal.signal_id);
    try {
      await api.mapFinopsSignal(featureId, signal.signal_id);
      setUnmapped((prev) => (prev ?? []).filter((s) => s.signal_id !== signal.signal_id));
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setAssigning(null);
    }
  }

  return (
    <div className="max-w-4xl">
      <h1 className="text-3xl font-bold tracking-tight" style={{ marginBottom: 8 }}>Mapping</h1>
      <p style={{ color: "#7A7268", fontSize: 14, marginBottom: 20 }}>
        Manage feature-mapping rules and assign unmapped signals to features.
      </p>

      <div style={{ display: "flex", gap: 0, marginBottom: 20,
                    borderBottom: "2px solid #E8E4DC" }}>
        {(["unmapped", "rules"] as const).map((t) => (
          <button key={t}
            onClick={() => setTab(t)}
            style={{ padding: "8px 18px", fontSize: 14, fontWeight: tab === t ? 600 : 400,
                     background: "none", border: "none", cursor: "pointer",
                     borderBottom: tab === t ? "2px solid #1E3A5F" : "none",
                     marginBottom: -2, color: tab === t ? "#1E3A5F" : "#7A7268" }}>
            {t === "unmapped" ? `Unmapped (${unmapped?.length ?? "…"})` : "Rules"}
          </button>
        ))}
      </div>

      {error && (
        <div style={{ padding: "10px 14px", background: "#FEF2F2",
                      border: "1px solid #FCA5A5", borderRadius: 6,
                      color: "#991B1B", fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {tab === "unmapped" && (
        <>
          {unmapped === null && <div style={{ color: "#7A7268" }}>Loading…</div>}
          {unmapped !== null && unmapped.length === 0 && (
            <div style={{ color: "#7A7268", marginTop: 40, textAlign: "center" }}>
              No unmapped signals — all events have been attributed to a feature.
            </div>
          )}
          {(unmapped ?? []).map((s) => (
            <div key={s.signal_id}
                 style={{ border: "1px solid #E8E4DC", borderRadius: 8,
                          padding: "14px 16px", marginBottom: 10,
                          display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 500 }}>
                  {s.signal_kind} · {s.source}
                  {s.external_ref && ` #${s.external_ref}`}
                </div>
                <div style={{ fontSize: 12, color: "#7A7268" }}>
                  {s.actor} · {new Date(s.occurred_at).toLocaleDateString()}
                </div>
              </div>
              <select
                disabled={assigning === s.signal_id}
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) assign(s, e.target.value);
                }}
                style={{ padding: "5px 10px", fontSize: 13, borderRadius: 6,
                         border: "1px solid #D6CFC4", background: "#FAF8F3" }}>
                <option value="">Assign to feature…</option>
                {(features ?? []).map((f) => (
                  <option key={f.feature_id} value={f.feature_id}>{f.name}</option>
                ))}
              </select>
            </div>
          ))}
        </>
      )}

      {tab === "rules" && (
        <div>
          {features === null && <div style={{ color: "#7A7268" }}>Loading…</div>}
          {(features ?? []).map((f) => (
            <div key={f.feature_id}
                 style={{ border: "1px solid #E8E4DC", borderRadius: 8,
                          padding: "14px 16px", marginBottom: 10 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>{f.name}</div>
              <div style={{ fontSize: 12, color: "#7A7268", display: "flex", flexWrap: "wrap", gap: 8 }}>
                {f.github_branch_re && (
                  <span style={{ background: "#F0F7FF", borderRadius: 4,
                                 padding: "2px 8px", border: "1px solid #BAD4F7" }}>
                    branch: {f.github_branch_re}
                  </span>
                )}
                {f.github_pr_labels.map((l) => (
                  <span key={l} style={{ background: "#F0FAF4", borderRadius: 4,
                                         padding: "2px 8px", border: "1px solid #BBF7D0" }}>
                    label: {l}
                  </span>
                ))}
                {f.sdk_tags.map((t) => (
                  <span key={t} style={{ background: "#FDF4FF", borderRadius: 4,
                                         padding: "2px 8px", border: "1px solid #E9D5FF" }}>
                    sdk: {t}
                  </span>
                ))}
                {f.github_pr_labels.length === 0 && !f.github_branch_re && f.sdk_tags.length === 0 && (
                  <span style={{ color: "#9CA3AF" }}>No mapping rules — signals will not auto-assign.</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
