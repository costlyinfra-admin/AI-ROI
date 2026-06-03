import { useEffect, useState } from "react";
import { api, type FinopsFeature, type FinopsCostRow, type FinopsConfidence } from "../../lib/api";

const CONFIDENCE_BADGE: Record<FinopsConfidence, { label: string; color: string }> = {
  high: { label: "High",   color: "#16a34a" },
  med:  { label: "Med",    color: "#ca8a04" },
  low:  { label: "Low",    color: "#dc2626" },
};

function ConfidenceBadge({ value }: { value: FinopsConfidence }) {
  const b = CONFIDENCE_BADGE[value] ?? CONFIDENCE_BADGE.low;
  return (
    <span style={{ fontSize: 12, fontWeight: 600, color: b.color,
                   background: b.color + "18", borderRadius: 4,
                   padding: "2px 7px" }}>
      {b.label}
    </span>
  );
}

export function FeaturesPage() {
  const [features, setFeatures] = useState<FinopsFeature[] | null>(null);
  const [costs,    setCosts]    = useState<FinopsCostRow[]>([]);
  const [error,    setError]    = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryResult, setDiscoveryResult] = useState<string | null>(null);
  const [phaseFilter, setPhaseFilter] = useState<"" | "build" | "runtime">("");
  const [confFilter,  setConfFilter]  = useState<"" | FinopsConfidence>("");

  useEffect(() => {
    Promise.all([
      api.listFinopsFeatures(),
      api.listFinopsCosts(30),
    ]).then(([fr, cr]) => {
      setFeatures(fr.features);
      setCosts(cr.costs);
    }).catch((e: Error) => setError(e.message));
  }, []);

  function costForFeature(featureId: string): number {
    return costs
      .filter((c) => c.feature_id === featureId &&
                     (phaseFilter === "" || c.phase === phaseFilter))
      .reduce((s, c) => s + c.total_cost, 0);
  }

  function confidenceForFeature(featureId: string): FinopsConfidence {
    const rows = costs.filter((c) => c.feature_id === featureId);
    if (rows.some((r) => r.confidence === "low"))  return "low";
    if (rows.some((r) => r.confidence === "med"))  return "med";
    if (rows.length > 0)                           return "high";
    return "low";
  }

  async function runDiscover() {
    setDiscovering(true);
    setDiscoveryResult(null);
    try {
      const r = await api.discoverFinopsFeatures();
      if (r.status === "too_sparse") {
        setDiscoveryResult("Too few PRs in the last 90 days — define features manually.");
      } else {
        setDiscoveryResult(`Auto-discovery found ${r.features.length} draft features. Go to Onboarding to review them.`);
      }
    } catch (e: unknown) {
      setDiscoveryResult("Discovery failed: " + (e as Error).message);
    } finally {
      setDiscovering(false);
    }
  }

  const displayFeatures = (features ?? []).filter((f) => {
    if (confFilter === "") return true;
    return confidenceForFeature(f.feature_id) === confFilter;
  });

  const sorted = [...displayFeatures].sort(
    (a, b) => costForFeature(b.feature_id) - costForFeature(a.feature_id)
  );

  return (
    <div className="max-w-5xl">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <h1 className="text-3xl font-bold tracking-tight" style={{ flex: 1 }}>AI Features</h1>
        <button
          onClick={runDiscover}
          disabled={discovering}
          style={{ padding: "6px 14px", fontSize: 13, borderRadius: 6,
                   background: "#F4F1EA", border: "1px solid #D6CFC4",
                   cursor: discovering ? "not-allowed" : "pointer" }}
        >
          {discovering ? "Discovering…" : "Auto-discover"}
        </button>
        <button
          style={{ padding: "6px 14px", fontSize: 13, borderRadius: 6,
                   background: "#1E3A5F", color: "#fff", border: "none", cursor: "pointer" }}
          onClick={() => {
            const name = window.prompt("Feature name:");
            if (!name) return;
            api.createFinopsFeature({ name }).then(() => {
              api.listFinopsFeatures().then((r) => setFeatures(r.features));
            });
          }}
        >
          + Add feature
        </button>
      </div>

      {discoveryResult && (
        <div style={{ marginBottom: 12, padding: "8px 14px", background: "#F0F7FF",
                      border: "1px solid #BAD4F7", borderRadius: 6, fontSize: 13 }}>
          {discoveryResult}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {(["", "build", "runtime"] as const).map((v) => (
          <button key={v}
            onClick={() => setPhaseFilter(v)}
            style={{ padding: "4px 12px", fontSize: 12, borderRadius: 20,
                     background: phaseFilter === v ? "#1E3A5F" : "#F4F1EA",
                     color: phaseFilter === v ? "#fff" : "#3A342B",
                     border: "1px solid " + (phaseFilter === v ? "#1E3A5F" : "#D6CFC4"),
                     cursor: "pointer" }}>
            {v === "" ? "All phases" : v}
          </button>
        ))}
        {(["", "high", "med", "low"] as const).map((v) => (
          <button key={v}
            onClick={() => setConfFilter(v)}
            style={{ padding: "4px 12px", fontSize: 12, borderRadius: 20,
                     background: confFilter === v ? "#1E3A5F" : "#F4F1EA",
                     color: confFilter === v ? "#fff" : "#3A342B",
                     border: "1px solid " + (confFilter === v ? "#1E3A5F" : "#D6CFC4"),
                     cursor: "pointer" }}>
            {v === "" ? "All confidence" : v + " confidence"}
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

      {features === null && <div style={{ color: "#7A7268", marginTop: 40 }}>Loading…</div>}

      {features !== null && sorted.length === 0 && (
        <div style={{ color: "#7A7268", marginTop: 40 }}>
          No features yet. Click "Auto-discover" to infer features from your GitHub history, or "Add feature" to create one manually.
        </div>
      )}

      {sorted.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #E8E4DC", textAlign: "left" }}>
              <th style={{ padding: "8px 12px", fontWeight: 600 }}>Feature</th>
              <th style={{ padding: "8px 12px", fontWeight: 600 }}>Status</th>
              <th style={{ padding: "8px 12px", fontWeight: 600, textAlign: "right" }}>Build cost (30d)</th>
              <th style={{ padding: "8px 12px", fontWeight: 600, textAlign: "right" }}># calls</th>
              <th style={{ padding: "8px 12px", fontWeight: 600 }}>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((f) => {
              const cost  = costForFeature(f.feature_id);
              const conf  = confidenceForFeature(f.feature_id);
              const calls = costs.filter((c) => c.feature_id === f.feature_id)
                                 .reduce((s, c) => s + c.call_count, 0);
              return (
                <tr key={f.feature_id}
                    style={{ borderBottom: "1px solid #F0EDE6",
                             background: "transparent" }}>
                  <td style={{ padding: "10px 12px" }}>
                    <div style={{ fontWeight: 500 }}>{f.name}</div>
                    {f.description && (
                      <div style={{ fontSize: 12, color: "#7A7268", marginTop: 2 }}>{f.description}</div>
                    )}
                  </td>
                  <td style={{ padding: "10px 12px" }}>
                    <span style={{ fontSize: 12, color: "#7A7268",
                                   background: "#F4F1EA", borderRadius: 4,
                                   padding: "2px 7px" }}>
                      {f.status}
                    </span>
                  </td>
                  <td style={{ padding: "10px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {cost > 0 ? `$${cost.toFixed(2)}` : "—"}
                  </td>
                  <td style={{ padding: "10px 12px", textAlign: "right" }}>
                    {calls > 0 ? calls : "—"}
                  </td>
                  <td style={{ padding: "10px 12px" }}>
                    <ConfidenceBadge value={conf} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
