import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./theme.css";

/** Last line of defense: if the app itself throws outside any widget
    boundary, show a recovery screen instead of a blank page. Telemetry on
    disk is safe either way (crash-safe checkpointing). */
class RootBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ display: "grid", placeItems: "center", height: "100vh", background: "#04060c", color: "#d9e3f7", fontFamily: "system-ui", textAlign: "center", padding: 24 }}>
          <div>
            <div style={{ color: "#ff3b47", fontWeight: 800, letterSpacing: "0.16em", fontSize: 18, marginBottom: 12 }}>GROUND STATION FAULT</div>
            <div style={{ fontFamily: "monospace", fontSize: 13, color: "#7e8db0", maxWidth: 560, margin: "0 auto 20px", overflowWrap: "anywhere" }}>
              {String(this.state.error?.message || this.state.error)}
            </div>
            <div style={{ fontSize: 13, color: "#7e8db0", marginBottom: 20 }}>
              Recorded telemetry is safe — the live session checkpoints to disk and will be recovered from the Flight Log.
            </div>
            <button
              onClick={() => window.location.reload()}
              style={{ padding: "12px 28px", fontSize: 14, fontWeight: 700, background: "rgba(31,157,255,0.2)", color: "#57c1ff", border: "1px solid rgba(31,157,255,0.5)", borderRadius: 4, cursor: "pointer", letterSpacing: "0.08em" }}
            >
              RESTART CONSOLE
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <RootBoundary>
    <App />
  </RootBoundary>
);
