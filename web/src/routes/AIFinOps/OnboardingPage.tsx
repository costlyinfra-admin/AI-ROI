import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type FinopsDiscoveredFeature } from "../../lib/api";

type Step = "connect" | "discover" | "review" | "done";

export function OnboardingPage() {
  const nav = useNavigate();
  const [step, setStep] = useState<Step>("connect");
  const [discovering, setDiscovering] = useState(false);
  const [features, setFeatures] = useState<FinopsDiscoveredFeature[]>([]);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runDiscover() {
    setDiscovering(true);
    setError(null);
    try {
      const r = await api.discoverFinopsFeatures();
      if (r.status === "too_sparse") {
        setError("Fewer than 5 PRs in 90 days — your repository history is too sparse for auto-discovery. Define features manually from the Features page.");
        return;
      }
      setFeatures(r.features);
      setStep("review");
    } catch (e: unknown) {
      setError("Discovery failed: " + (e as Error).message);
    } finally {
      setDiscovering(false);
    }
  }

  async function confirmAll() {
    setConfirming(true);
    setError(null);
    try {
      const toConfirm = features.filter((_, i) => !deleted.has(i));
      await Promise.all(toConfirm.map((f, i) =>
        api.createFinopsFeature({
          name:             edits[i] ?? f.name,
          description:      f.description,
          github_pr_labels: f.pr_label_match,
          github_branch_re: f.branch_pattern,
          sdk_tags:         [],
        })
      ));
      setStep("done");
    } catch (e: unknown) {
      setError("Confirm failed: " + (e as Error).message);
    } finally {
      setConfirming(false);
    }
  }

  const STEPS: { key: Step; label: string }[] = [
    { key: "connect",  label: "1. Connect GitHub" },
    { key: "discover", label: "2. Run auto-discovery" },
    { key: "review",   label: "3. Review & confirm" },
  ];

  return (
    <div className="max-w-2xl">
      <h1 className="text-3xl font-bold tracking-tight" style={{ marginBottom: 4 }}>
        AI FinOps — Onboarding
      </h1>
      <p style={{ color: "#7A7268", fontSize: 14, marginBottom: 24 }}>
        Connect GitHub and let AI infer your feature list from PR history — then confirm to start tracking costs.
      </p>

      {/* Step indicator */}
      <div style={{ display: "flex", gap: 0, marginBottom: 28 }}>
        {STEPS.map((s, idx) => {
          const active  = step === s.key || (step === "done" && idx < 3);
          const current = step === s.key;
          return (
            <div key={s.key} style={{ display: "flex", alignItems: "center" }}>
              <div style={{ padding: "6px 14px", fontSize: 13, borderRadius: 6,
                            background: current ? "#1E3A5F" : active ? "#E8EEF5" : "#F4F1EA",
                            color: current ? "#fff" : active ? "#1E3A5F" : "#9CA3AF",
                            fontWeight: current ? 600 : 400 }}>
                {s.label}
              </div>
              {idx < STEPS.length - 1 && (
                <div style={{ width: 20, height: 1, background: "#D6CFC4", margin: "0 2px" }} />
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <div style={{ padding: "10px 14px", background: "#FEF2F2",
                      border: "1px solid #FCA5A5", borderRadius: 6,
                      color: "#991B1B", fontSize: 13, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {step === "connect" && (
        <div style={{ border: "1px solid #E8E4DC", borderRadius: 10, padding: 24 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Connect GitHub</h2>
          <p style={{ fontSize: 14, color: "#7A7268", marginBottom: 20 }}>
            Auto-discovery needs access to your merged PRs (last 90 days).
            If you've already connected GitHub via the AI connector, you're ready.
          </p>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={() => setStep("discover")}
              style={{ padding: "8px 18px", fontSize: 14, fontWeight: 600,
                       background: "#1E3A5F", color: "#fff", border: "none",
                       borderRadius: 7, cursor: "pointer" }}>
              GitHub is connected — continue
            </button>
            <button
              onClick={() => nav("/ai")}
              style={{ padding: "8px 18px", fontSize: 14,
                       background: "#F4F1EA", border: "1px solid #D6CFC4",
                       borderRadius: 7, cursor: "pointer" }}>
              Connect GitHub first
            </button>
          </div>
        </div>
      )}

      {step === "discover" && (
        <div style={{ border: "1px solid #E8E4DC", borderRadius: 10, padding: 24 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Auto-discover features</h2>
          <p style={{ fontSize: 14, color: "#7A7268", marginBottom: 20 }}>
            Annapurna will fetch the last 90 days of merged PRs from GitHub and
            use Claude to group them into product features. You'll review and
            edit the draft before confirming.
          </p>
          <button
            onClick={runDiscover}
            disabled={discovering}
            style={{ padding: "8px 18px", fontSize: 14, fontWeight: 600,
                     background: "#1E3A5F", color: "#fff", border: "none",
                     borderRadius: 7, cursor: discovering ? "not-allowed" : "pointer",
                     opacity: discovering ? 0.7 : 1 }}>
            {discovering ? "Discovering…" : "Run auto-discovery"}
          </button>
        </div>
      )}

      {step === "review" && (
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>Review draft features</h2>
          <p style={{ fontSize: 14, color: "#7A7268", marginBottom: 16 }}>
            Claude found {features.length} features. Rename, edit, or delete — then confirm to persist.
          </p>
          {features.map((f, i) => (
            !deleted.has(i) && (
              <div key={i} style={{ border: "1px solid #E8E4DC", borderRadius: 8,
                                    padding: "14px 16px", marginBottom: 10,
                                    background: "#FDFCFA" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                  <input
                    value={edits[i] ?? f.name}
                    onChange={(e) => setEdits((prev) => ({ ...prev, [i]: e.target.value }))}
                    style={{ flex: 1, fontSize: 14, fontWeight: 600, padding: "4px 8px",
                             border: "1px solid #D6CFC4", borderRadius: 5,
                             background: "#FAF8F3" }}
                  />
                  <span style={{ fontSize: 12, color: f.confidence === "high" ? "#16a34a" : f.confidence === "med" ? "#ca8a04" : "#dc2626",
                                 background: f.confidence === "high" ? "#dcfce7" : f.confidence === "med" ? "#fef9c3" : "#fee2e2",
                                 borderRadius: 4, padding: "2px 7px", fontWeight: 600 }}>
                    {f.confidence}
                  </span>
                  <button
                    onClick={() => setDeleted((prev) => new Set([...prev, i]))}
                    style={{ fontSize: 18, color: "#DC2626", background: "none",
                             border: "none", cursor: "pointer", lineHeight: 1 }}>
                    ×
                  </button>
                </div>
                <div style={{ fontSize: 12, color: "#7A7268" }}>{f.description}</div>
                <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 4 }}>
                  {f.pr_numbers.length} PRs · branch: {f.branch_pattern || "any"}
                </div>
              </div>
            )
          ))}
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button
              onClick={confirmAll}
              disabled={confirming}
              style={{ padding: "9px 20px", fontSize: 14, fontWeight: 600,
                       background: "#1E3A5F", color: "#fff", border: "none",
                       borderRadius: 7, cursor: confirming ? "not-allowed" : "pointer",
                       opacity: confirming ? 0.7 : 1 }}>
              {confirming ? "Confirming…" : `Confirm ${features.length - deleted.size} features`}
            </button>
            <button
              onClick={() => setStep("discover")}
              style={{ padding: "9px 20px", fontSize: 14,
                       background: "#F4F1EA", border: "1px solid #D6CFC4",
                       borderRadius: 7, cursor: "pointer" }}>
              Re-run discovery
            </button>
          </div>
        </div>
      )}

      {step === "done" && (
        <div style={{ border: "1px solid #BBF7D0", borderRadius: 10, padding: 28,
                      background: "#F0FAF4", textAlign: "center" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>✓</div>
          <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Features confirmed</h2>
          <p style={{ fontSize: 14, color: "#166534", marginBottom: 20 }}>
            Build costs will start attributing to your features within the next 6 hours
            as the ingest workers run.
          </p>
          <button
            onClick={() => nav("/ai-finops")}
            style={{ padding: "9px 20px", fontSize: 14, fontWeight: 600,
                     background: "#1E3A5F", color: "#fff", border: "none",
                     borderRadius: 7, cursor: "pointer" }}>
            View dashboard
          </button>
        </div>
      )}
    </div>
  );
}
