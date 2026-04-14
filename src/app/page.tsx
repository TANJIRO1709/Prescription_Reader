"use client";

import { useState, useCallback } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Flag {
  type: "danger" | "warn" | "info";
  text: string;
}

interface Results {
  drugName: string;
  stdDose: number;
  adjustedDose: number;
  dailyDose: number;
  totalCourse: number;
  freqLabel: string;
  route: string;
  duration: number;
  riskScore: number;
  riskLabel: string;
  adjustments: string[];
  flags: Flag[];
  monitoringRecommendations: string[];
  geminiReasoning: string;
  disclaimer: string;
}

interface PatientState {
  age: number; weight: number; height: number; gender: string; pregnancy: string;
  egfr: number; liver: string;
  dm: boolean; htn: boolean; chf: boolean; copd: boolean; epi: boolean; hiv: boolean;
}

interface DrugState {
  drugName: string; stdDose: number; route: string; ti: string; dosisBasis: string;
  frequency: string; duration: number; severity: string; conditionType: string;
  bioav: number; metabolism: string;
}

interface InteractionState {
  warfarin: boolean; nsaid: boolean; ssri: boolean; ace: boolean; statin: boolean;
  insulin: boolean; cyp: boolean; smoking: boolean; alcohol: boolean;
  grapefruit: boolean; fasting: boolean; allergy: boolean; tolerance: boolean;
}

// ─── Streaming API client ─────────────────────────────────────────────────────
// Uses ReadableStream + TextDecoderStream for cleaner chunk handling.
// Keeps a running line buffer to handle chunks that split across SSE boundaries.

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

async function callStreamingAPI(
  patient: PatientState,
  drug: DrugState,
  interactions: InteractionState,
  onResult: (r: Results) => void,
  onError: (msg: string) => void,
  onPing?: () => void
) {
  const payload = {
    patient: {
      age: patient.age, weight_kg: patient.weight, height_cm: patient.height,
      gender: patient.gender, pregnancy_status: patient.pregnancy,
      egfr: patient.egfr, child_pugh: patient.liver,
      diabetes: patient.dm, hypertension: patient.htn, heart_failure: patient.chf,
      copd_asthma: patient.copd, epilepsy: patient.epi, immunocompromised: patient.hiv,
    },
    drug: {
      drug_name: drug.drugName, standard_adult_dose_mg: drug.stdDose,
      route: drug.route, therapeutic_index: drug.ti, dosing_basis: drug.dosisBasis,
      frequency: drug.frequency, duration_days: drug.duration,
      severity: drug.severity, condition_type: drug.conditionType,
      bioavailability_pct: drug.bioav, metabolism: drug.metabolism,
    },
    interactions: {
      warfarin: interactions.warfarin, nsaids: interactions.nsaid, ssri: interactions.ssri,
      ace_inhibitors: interactions.ace, statins: interactions.statin, insulin: interactions.insulin,
      cyp450_inhibitors: interactions.cyp, smoking: interactions.smoking, alcohol: interactions.alcohol,
      grapefruit_risk: interactions.grapefruit, fasting: interactions.fasting,
      known_allergy: interactions.allergy, long_term_tolerance: interactions.tolerance,
    },
  };

  const freqLabelMap: Record<string, string> = {
    od: "Once daily", bd: "Twice daily", tds: "Three times daily",
    qds: "Four times daily", prn: "As needed",
  };

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/calculate/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    onError(`Network error: could not reach ${API_BASE}. Is the backend running?`);
    return;
  }

  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    onError(err.detail ?? "API request failed");
    return;
  }

  // Use TextDecoderStream for cleaner async iteration
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let eventType = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const raw = line.slice(6).trim();
        if (!raw || raw === "{}") {
          if (eventType === "ping") onPing?.();
          continue;
        }

        if (eventType === "result") {
          try {
            const data = JSON.parse(raw);
            onResult({
              drugName: data.drug_name,
              stdDose: drug.stdDose,
              adjustedDose: data.recommended_single_dose_mg,
              dailyDose: data.recommended_daily_dose_mg,
              totalCourse: data.total_course_dose_mg,
              freqLabel: data.frequency ?? freqLabelMap[drug.frequency],
              route: data.route,
              duration: data.duration_days,
              riskScore: data.risk_score,
              riskLabel: data.risk_level,
              adjustments: data.dose_adjustments ?? [],
              flags: (data.clinical_flags ?? []).map((f: { severity: string; message: string }) => ({
                type: f.severity as Flag["type"],
                text: f.message,
              })),
              monitoringRecommendations: data.monitoring_recommendations ?? [],
              geminiReasoning: data.gemini_reasoning ?? "",
              disclaimer: data.disclaimer ?? "",
            });
          } catch {
            onError("Failed to parse response from server.");
          }
        } else if (eventType === "error") {
          try {
            const err = JSON.parse(raw);
            onError(err.detail ?? "Unknown server error");
          } catch {
            onError("Unknown server error");
          }
        }
        // Reset event type after consuming data line
        eventType = "";
      } else if (line === "") {
        // blank line = end of SSE event block — reset type
        eventType = "";
      }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function calcBSA(weight: number, height: number) {
  return Math.sqrt((weight * height) / 3600);
}
function calcBMI(weight: number, height: number) {
  return weight / Math.pow(height / 100, 2);
}
function eGFRStage(v: number) {
  if (v >= 90) return { label: "Normal (G1)", color: "#22d3a0" };
  if (v >= 60) return { label: "Mildly reduced (G2)", color: "#f59e0b" };
  if (v >= 45) return { label: "Mild–moderate (G3a)", color: "#f59e0b" };
  if (v >= 30) return { label: "Moderate–severe (G3b)", color: "#f97316" };
  if (v >= 15) return { label: "Severe CKD (G4)", color: "#ef4444" };
  return { label: "Kidney failure (G5)", color: "#dc2626" };
}

// ─── Design tokens ────────────────────────────────────────────────────────────

const inputCls =
  "bg-[#0f1923] border border-[#1e3a2f] rounded-lg px-3 h-9 text-sm text-[#e2e8f0] focus:outline-none focus:border-[#4ade80]/50 transition-colors placeholder-[#334155]";
const selectCls =
  "bg-[#0f1923] border border-[#1e3a2f] rounded-lg px-3 h-9 text-sm text-[#e2e8f0] focus:outline-none focus:border-[#4ade80]/50 transition-colors cursor-pointer";

// ─── Reusable components ──────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold tracking-[0.12em] uppercase text-[#4ade80]/60 mb-3 mt-6 first:mt-0">
      {children}
    </p>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[11px] text-[#94a3b8]">{label}</label>
      {children}
    </div>
  );
}

function CheckRow({ id, label, checked, onChange }: {
  id: string; label: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex items-center gap-3 text-sm text-[#cbd5e1] cursor-pointer group">
      <div
        className={`w-4 h-4 rounded border flex items-center justify-center transition-all ${checked ? "bg-[#4ade80] border-[#4ade80]" : "border-[#1e3a2f] group-hover:border-[#4ade80]/40"}`}
        onClick={() => onChange(!checked)}
      >
        {checked && (
          <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
            <path d="M1 4L3.5 6.5L9 1" stroke="#0a0f14" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
      <input id={id} type="checkbox" className="sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function SliderField({ label, id, min, max, step, value, displayValue, onChange, barColor, subLabel }: {
  label: string; id: string; min: number; max: number; step: number;
  value: number; displayValue: string; onChange: (v: number) => void;
  barColor?: string; subLabel?: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[11px] text-[#94a3b8]">{label}</label>
      <div className="flex items-center gap-3">
        <div className="relative flex-1 h-5 flex items-center">
          <div className="absolute inset-x-0 h-1.5 bg-[#1e3a2f] rounded-full" />
          <div className="absolute left-0 h-1.5 rounded-full transition-all"
            style={{ width: `${pct}%`, background: barColor ?? "#4ade80" }} />
          <input id={id} type="range" min={min} max={max} step={step} value={value}
            onChange={(e) => onChange(Number(e.target.value))}
            className="absolute inset-0 w-full opacity-0 cursor-pointer h-5" />
          <div className="absolute w-4 h-4 rounded-full border-2 border-[#0a0f14] shadow-lg pointer-events-none transition-all"
            style={{ left: `calc(${pct}% - 8px)`, background: barColor ?? "#4ade80" }} />
        </div>
        <span className="text-sm font-semibold text-[#e2e8f0] min-w-[52px] text-right tabular-nums">{displayValue}</span>
      </div>
      {subLabel && <p className="text-[11px]" style={{ color: barColor ?? "#4ade80" }}>{subLabel}</p>}
    </div>
  );
}

// ─── Loading overlay ──────────────────────────────────────────────────────────
// Steps now advance on ping events (real server progress) rather than a fixed timer.

const LOADING_STEPS = [
  "Sending patient profile…",
  "Gemini analysing pharmacokinetics…",
  "Calculating organ-adjusted dose…",
  "Screening for interactions…",
  "Finalising recommendation…",
];

function LoadingOverlay({ step }: { step: number }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-6">
      <div className="relative w-16 h-16">
        <div className="absolute inset-0 rounded-full border-2 border-[#4ade80]/10 animate-ping" />
        <div className="absolute inset-2 rounded-full border-2 border-[#4ade80]/20 animate-ping"
          style={{ animationDelay: "0.2s" }} />
        <div className="absolute inset-0 rounded-full border-2 border-t-[#4ade80] border-[#1e3a2f] animate-spin" />
        <div className="absolute inset-0 flex items-center justify-center">
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
            <path d="M8 2v12M2 8h12" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>
      </div>
      <div className="text-center space-y-2">
        <p className="text-sm font-medium text-[#e2e8f0]">Analysing</p>
        <p className="text-xs text-[#475569] transition-all duration-500">{LOADING_STEPS[step % LOADING_STEPS.length]}</p>
        <div className="flex gap-1.5 justify-center mt-1">
          {LOADING_STEPS.map((_, i) => (
            <div key={i} className={`h-1 rounded-full transition-all duration-300 ${
              i <= step ? "w-4 bg-[#4ade80]" : "w-1.5 bg-[#1e3a2f]"
            }`} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="flex items-start gap-3 bg-[#1a0a0a] border border-[#ef444430] rounded-xl px-4 py-3 mt-4">
      <span className="text-[#ef4444] font-bold shrink-0 mt-0.5">⚠</span>
      <div className="flex-1">
        <p className="text-xs font-semibold text-[#fca5a5] mb-0.5">API Error</p>
        <p className="text-xs text-[#f87171]/70 leading-relaxed">{message}</p>
      </div>
      <button onClick={onDismiss} className="text-[#475569] hover:text-[#94a3b8] text-sm shrink-0">✕</button>
    </div>
  );
}

// ─── Tab panels ───────────────────────────────────────────────────────────────

function PatientPanel({ state, set }: {
  state: PatientState;
  set: (k: keyof PatientState, v: PatientState[keyof PatientState]) => void;
}) {
  const bsa = calcBSA(state.weight, state.height).toFixed(2);
  const bmi = calcBMI(state.weight, state.height).toFixed(1);
  const egfrInfo = eGFRStage(state.egfr);
  const ageTag = state.age < 18 ? "Pediatric" : state.age >= 65 ? "Geriatric" : null;
  const bmiNum = parseFloat(bmi);
  const bmiTag = bmiNum < 18.5 ? "Underweight" : bmiNum >= 30 ? "Obese" : null;

  return (
    <div>
      <SectionLabel>Basic demographics</SectionLabel>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Age (years)">
          <input type="number" className={inputCls} min={0} max={120} value={state.age}
            onChange={(e) => set("age", Number(e.target.value))} />
        </Field>
        <Field label="Weight (kg)">
          <input type="number" className={inputCls} min={1} max={300} value={state.weight}
            onChange={(e) => set("weight", Number(e.target.value))} />
        </Field>
        <Field label="Height (cm)">
          <input type="number" className={inputCls} min={30} max={250} value={state.height}
            onChange={(e) => set("height", Number(e.target.value))} />
        </Field>
      </div>
      <div className="flex gap-2 mt-3 flex-wrap">
        <span className="text-[11px] px-2.5 py-1 rounded-full border border-[#1e3a2f] text-[#4ade80]/70">BSA {bsa} m²</span>
        <span className="text-[11px] px-2.5 py-1 rounded-full border border-[#1e3a2f] text-[#4ade80]/70">BMI {bmi}</span>
        {ageTag && <span className="text-[11px] px-2.5 py-1 rounded-full border border-[#f59e0b]/40 text-[#f59e0b]">{ageTag}</span>}
        {bmiTag && <span className="text-[11px] px-2.5 py-1 rounded-full border border-[#f97316]/40 text-[#f97316]">{bmiTag}</span>}
      </div>
      <div className="grid grid-cols-2 gap-3 mt-4">
        <Field label="Gender">
          <select className={selectCls} value={state.gender} onChange={(e) => set("gender", e.target.value)}>
            <option value="male">Male</option>
            <option value="female">Female</option>
            <option value="other">Other / non-binary</option>
          </select>
        </Field>
        <Field label="Pregnancy / lactation">
          <select className={selectCls} value={state.pregnancy} onChange={(e) => set("pregnancy", e.target.value)}>
            <option value="none">Not applicable</option>
            <option value="pregnant">Pregnant</option>
            <option value="lactating">Lactating</option>
          </select>
        </Field>
      </div>
      <SectionLabel>Organ function</SectionLabel>
      <div className="grid grid-cols-1 gap-5">
        <SliderField label="eGFR — kidney function (mL/min/1.73m²)" id="egfr" min={5} max={120} step={1}
          value={state.egfr} displayValue={String(state.egfr)} onChange={(v) => set("egfr", v)}
          barColor={egfrInfo.color} subLabel={egfrInfo.label} />
        <Field label="Child-Pugh score — liver function">
          <select className={selectCls} value={state.liver} onChange={(e) => set("liver", e.target.value)}>
            <option value="A">Class A — mild (5–6)</option>
            <option value="B">Class B — moderate (7–9)</option>
            <option value="C">Class C — severe (10–15)</option>
          </select>
        </Field>
      </div>
      <SectionLabel>Co-morbidities</SectionLabel>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        {([
          ["dm","Diabetes mellitus"],["htn","Hypertension"],["chf","Heart failure"],
          ["copd","COPD / asthma"],["epi","Epilepsy"],["hiv","Immunocompromised"],
        ] as [keyof PatientState, string][]).map(([k, lbl]) => (
          <CheckRow key={k} id={k} label={lbl} checked={state[k] as boolean} onChange={(v) => set(k, v)} />
        ))}
      </div>
    </div>
  );
}

function DrugPanel({ state, set }: {
  state: DrugState;
  set: (k: keyof DrugState, v: DrugState[keyof DrugState]) => void;
}) {
  return (
    <div>
      <SectionLabel>Drug details</SectionLabel>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Drug name">
          <input type="text" className={inputCls} placeholder="e.g. Amoxicillin" value={state.drugName}
            onChange={(e) => set("drugName", e.target.value)} />
        </Field>
        <Field label="Standard adult dose (mg)">
          <input type="number" className={inputCls} min={0} value={state.stdDose}
            onChange={(e) => set("stdDose", Number(e.target.value))} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3 mt-3">
        <Field label="Route of administration">
          <select className={selectCls} value={state.route} onChange={(e) => set("route", e.target.value)}>
            <option value="oral">Oral</option>
            <option value="iv">Intravenous (IV)</option>
            <option value="im">Intramuscular (IM)</option>
            <option value="topical">Topical</option>
            <option value="sublingual">Sublingual</option>
          </select>
        </Field>
        <Field label="Therapeutic index">
          <select className={selectCls} value={state.ti} onChange={(e) => set("ti", e.target.value)}>
            <option value="wide">Wide</option>
            <option value="narrow">Narrow (requires TDM)</option>
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-3 mt-3">
        <Field label="Dosing basis">
          <select className={selectCls} value={state.dosisBasis} onChange={(e) => set("dosisBasis", e.target.value)}>
            <option value="fixed">Fixed dose</option>
            <option value="kg">Per kg body weight</option>
            <option value="bsa">Per m² BSA</option>
          </select>
        </Field>
        <Field label="Frequency">
          <select className={selectCls} value={state.frequency} onChange={(e) => set("frequency", e.target.value)}>
            <option value="od">Once daily (OD)</option>
            <option value="bd">Twice daily (BD)</option>
            <option value="tds">Three times daily (TDS)</option>
            <option value="qds">Four times daily (QDS)</option>
            <option value="prn">As needed (PRN)</option>
          </select>
        </Field>
        <Field label="Duration (days)">
          <input type="number" className={inputCls} min={1} value={state.duration}
            onChange={(e) => set("duration", Number(e.target.value))} />
        </Field>
      </div>
      <SectionLabel>Clinical context</SectionLabel>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Severity of illness">
          <select className={selectCls} value={state.severity} onChange={(e) => set("severity", e.target.value)}>
            <option value="mild">Mild</option>
            <option value="moderate">Moderate</option>
            <option value="severe">Severe</option>
          </select>
        </Field>
        <Field label="Condition type">
          <select className={selectCls} value={state.conditionType} onChange={(e) => set("conditionType", e.target.value)}>
            <option value="acute">Acute</option>
            <option value="chronic">Chronic</option>
          </select>
        </Field>
      </div>
      <SectionLabel>Pharmacokinetics</SectionLabel>
      <div className="grid grid-cols-1 gap-4">
        <SliderField label="Oral bioavailability (%)" id="bioav" min={5} max={100} step={1}
          value={state.bioav} displayValue={`${state.bioav}%`} onChange={(v) => set("bioav", v)} />
        <Field label="CYP450 metabolizer status">
          <select className={selectCls} value={state.metabolism} onChange={(e) => set("metabolism", e.target.value)}>
            <option value="normal">Normal metabolizer</option>
            <option value="poor">Poor metabolizer</option>
            <option value="ultra">Ultra-rapid metabolizer</option>
          </select>
        </Field>
      </div>
    </div>
  );
}

function InteractionsPanel({ state, set }: {
  state: InteractionState;
  set: (k: keyof InteractionState, v: InteractionState[keyof InteractionState]) => void;
}) {
  return (
    <div>
      <SectionLabel>Concomitant medications</SectionLabel>
      <div className="flex flex-col gap-3">
        {([
          ["warfarin","Warfarin / anticoagulants"],["nsaid","NSAIDs (aspirin, ibuprofen)"],
          ["ssri","SSRIs / antidepressants"],["ace","ACE inhibitors / ARBs"],
          ["statin","Statins"],["insulin","Insulin / sulfonylureas"],
          ["cyp","CYP450 inhibitors (fluconazole, ritonavir)"],
        ] as [keyof InteractionState, string][]).map(([k, lbl]) => (
          <CheckRow key={k} id={`int-${k}`} label={lbl} checked={state[k] as boolean} onChange={(v) => set(k, v)} />
        ))}
      </div>
      <SectionLabel>Lifestyle & dietary factors</SectionLabel>
      <div className="flex flex-col gap-3">
        {([
          ["smoking","Smoker (active)"],["alcohol","Regular alcohol use"],
          ["grapefruit","Grapefruit / citrus interaction risk"],["fasting","Fasting / poor nutritional status"],
        ] as [keyof InteractionState, string][]).map(([k, lbl]) => (
          <CheckRow key={k} id={`lf-${k}`} label={lbl} checked={state[k] as boolean} onChange={(v) => set(k, v)} />
        ))}
      </div>
      <SectionLabel>Allergy & history</SectionLabel>
      <div className="flex flex-col gap-3">
        <CheckRow id="allergy" label="Known drug allergies or hypersensitivity" checked={state.allergy} onChange={(v) => set("allergy", v)} />
        <CheckRow id="tolerance" label="Long-term use — possible tolerance / dependence" checked={state.tolerance} onChange={(v) => set("tolerance", v)} />
      </div>
    </div>
  );
}

function ResultsPanel({ results, loading, loadingStep }: {
  results: Results | null; loading: boolean; loadingStep: number;
}) {
  if (loading) return <LoadingOverlay step={loadingStep} />;

  if (!results) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4">
        <div className="w-16 h-16 rounded-2xl border border-[#1e3a2f] flex items-center justify-center">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" className="text-[#4ade80]/30">
            <circle cx="14" cy="14" r="11" stroke="currentColor" strokeWidth="1.5" />
            <path d="M14 9v6M14 18v1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
        <p className="text-sm text-[#475569] text-center">
          Complete the patient and drug parameters,<br />
          then click <span className="text-[#4ade80]/60">Calculate dosage</span> below.
        </p>
      </div>
    );
  }

  const { riskScore, riskLabel } = results;
  const riskColor = riskScore < 30 ? "#22d3a0" : riskScore < 60 ? "#f59e0b" : "#ef4444";

  return (
    <div className="space-y-5">
      {results.geminiReasoning && (
        <div className="flex items-start gap-3 bg-[#0a1a14] border border-[#4ade80]/20 rounded-xl px-4 py-3">
          <div className="w-5 h-5 rounded-md bg-gradient-to-br from-[#4ade80] to-[#22d3a0] flex items-center justify-center shrink-0 mt-0.5">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2 5h6M5 2v6" stroke="#040810" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
          <div>
            <p className="text-[10px] font-semibold tracking-[0.1em] uppercase text-[#4ade80]/60 mb-1">Gemini reasoning</p>
            <p className="text-xs text-[#94a3b8] leading-relaxed">{results.geminiReasoning}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {[
          { label: "Single dose", value: `${Math.round(results.adjustedDose)} mg` },
          { label: "Daily dose", value: `${Math.round(results.dailyDose)} mg` },
          { label: "Frequency", value: results.freqLabel },
          { label: "Course total", value: `${(results.totalCourse / 1000).toFixed(1)} g` },
        ].map((c) => (
          <div key={c.label} className="bg-[#0a0f14] border border-[#1e3a2f] rounded-xl p-4">
            <p className="text-[11px] text-[#475569] mb-1">{c.label}</p>
            <p className="text-xl font-semibold text-[#e2e8f0] tabular-nums leading-none">{c.value}</p>
          </div>
        ))}
      </div>

      <div className="bg-[#0a0f14] border border-[#1e3a2f] rounded-xl p-4">
        <div className="flex justify-between items-center mb-2">
          <p className="text-[11px] text-[#475569]">Overall risk score</p>
          <span className="text-xs font-semibold px-2.5 py-1 rounded-full"
            style={{ color: riskColor, background: riskColor + "22", border: `1px solid ${riskColor}44` }}>
            {riskLabel} · {riskScore}/100
          </span>
        </div>
        <div className="h-2 bg-[#1e3a2f] rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all duration-700" style={{ width: `${riskScore}%`, background: riskColor }} />
        </div>
      </div>

      <div className="bg-[#0a0f14] border border-[#1e3a2f] rounded-xl divide-y divide-[#1e3a2f]">
        {[
          ["Drug", results.drugName],
          ["Standard reference dose", `${results.stdDose} mg`],
          ["Route", results.route.toUpperCase() + " · " + results.duration + " days"],
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between items-center px-4 py-3">
            <span className="text-xs text-[#475569]">{k}</span>
            <span className="text-sm font-medium text-[#e2e8f0]">{v}</span>
          </div>
        ))}
      </div>

      {results.adjustments.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold tracking-[0.12em] uppercase text-[#4ade80]/60 mb-2">Adjustments applied</p>
          <div className="flex flex-col gap-1.5">
            {results.adjustments.map((a, i) => (
              <div key={i} className="flex items-start gap-2 text-xs text-[#64748b] py-2 border-b border-[#1e3a2f] last:border-0">
                <span className="text-[#4ade80]/40 mt-0.5">→</span>{a}
              </div>
            ))}
          </div>
        </div>
      )}

      {results.flags.length > 0 && (
        <div className="flex flex-col gap-2">
          {results.flags.map((f, i) => {
            const c = {
              danger: { bg:"#1a0a0a", border:"#ef444430", text:"#fca5a5", icon:"⚠" },
              warn:   { bg:"#1a1200", border:"#f59e0b30", text:"#fcd34d", icon:"!" },
              info:   { bg:"#0a1020", border:"#3b82f630", text:"#93c5fd", icon:"i" },
            }[f.type];
            return (
              <div key={i} className="flex items-start gap-3 rounded-lg px-3 py-2.5 text-xs"
                style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.text }}>
                <span className="font-bold text-[13px] leading-none mt-0.5 shrink-0">{c.icon}</span>
                {f.text}
              </div>
            );
          })}
        </div>
      )}

      {results.monitoringRecommendations.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold tracking-[0.12em] uppercase text-[#4ade80]/60 mb-2">Monitoring recommendations</p>
          <div className="flex flex-col gap-1.5">
            {results.monitoringRecommendations.map((r, i) => (
              <div key={i} className="flex items-start gap-2 text-xs text-[#64748b] py-2 border-b border-[#1e3a2f] last:border-0">
                <span className="text-[#22d3a0]/50 mt-0.5">◈</span>{r}
              </div>
            ))}
          </div>
        </div>
      )}

      {results.disclaimer && (
        <p className="text-[10px] text-[#334155] leading-relaxed border-t border-[#1e3a2f] pt-4">{results.disclaimer}</p>
      )}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const TABS = ["Patient", "Drug & Clinical", "Interactions", "Results"] as const;
type TabName = (typeof TABS)[number];

export default function Home() {
  const [activeTab, setActiveTab] = useState<TabName>("Patient");
  const [results, setResults] = useState<Results | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);
  const [pingCount, setPingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [patient, setPatientRaw] = useState<PatientState>({
    age: 35, weight: 70, height: 170, gender: "male", pregnancy: "none",
    egfr: 90, liver: "A",
    dm: false, htn: false, chf: false, copd: false, epi: false, hiv: false,
  });
  const [drug, setDrugRaw] = useState<DrugState>({
    drugName: "Amoxicillin", stdDose: 500, route: "oral", ti: "wide",
    dosisBasis: "fixed", frequency: "tds", duration: 7,
    severity: "moderate", conditionType: "acute", bioav: 80, metabolism: "normal",
  });
  const [interactions, setInteractionsRaw] = useState<InteractionState>({
    warfarin: false, nsaid: false, ssri: false, ace: false, statin: false,
    insulin: false, cyp: false, smoking: false, alcohol: false,
    grapefruit: false, fasting: false, allergy: false, tolerance: false,
  });

  const setPatient = useCallback((k: keyof PatientState, v: PatientState[keyof PatientState]) =>
    setPatientRaw((p) => ({ ...p, [k]: v })), []);
  const setDrug = useCallback((k: keyof DrugState, v: DrugState[keyof DrugState]) =>
    setDrugRaw((p) => ({ ...p, [k]: v })), []);
  const setInteractions = useCallback((k: keyof InteractionState, v: InteractionState[keyof InteractionState]) =>
    setInteractionsRaw((p) => ({ ...p, [k]: v })), []);

  const calculate = async () => {
    setLoading(true);
    setLoadingStep(0);
    setPingCount(0);
    setError(null);
    setResults(null);
    setActiveTab("Results");

    let pings = 0;

    await callStreamingAPI(
      patient, drug, interactions,
      (r) => {
        setResults(r);
        setLoading(false);
      },
      (msg) => {
        setError(msg);
        setLoading(false);
      },
      // onPing — advance loading step based on actual server progress
      // We get ~1 ping per Gemini chunk; step through 5 phases as they accumulate
      () => {
        pings++;
        // Advance a step roughly every 3 pings, capped at last step
        setLoadingStep(Math.min(Math.floor(pings / 3), LOADING_STEPS.length - 1));
      },
    );
  };

  const tabIdx = TABS.indexOf(activeTab);

  return (
    <main className="min-h-screen bg-[#040810] text-[#e2e8f0]" style={{ fontFamily: "'DM Sans', 'Syne', sans-serif" }}>
      <div className="fixed inset-0 pointer-events-none" style={{
        backgroundImage: `linear-gradient(rgba(74,222,128,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(74,222,128,0.03) 1px, transparent 1px)`,
        backgroundSize: "40px 40px",
      }} />
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] pointer-events-none"
        style={{ background: "radial-gradient(ellipse at center top, rgba(74,222,128,0.07) 0%, transparent 70%)" }} />

      <div className="relative max-w-2xl mx-auto px-4 py-10">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: "linear-gradient(135deg, #4ade80 0%, #22d3a0 100%)" }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 2v12M2 8h12" stroke="#040810" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </div>
            <span className="text-[11px] tracking-[0.15em] uppercase text-[#4ade80]/60 font-medium">
              Clinical decision support · Powered by NITR
            </span>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-white mb-1.5">Dosage Calculator</h1>
          <p className="text-sm text-[#475569] leading-relaxed">
            Patient-adjusted dosing with pharmacokinetic modelling, organ function correction, and interaction screening.
          </p>
        </div>

        {/* Progress steps */}
        <div className="flex items-center gap-0 mb-6">
          {TABS.map((tab, i) => (
            <div key={tab} className="flex items-center flex-1 last:flex-none">
              <button onClick={() => setActiveTab(tab)} className="flex flex-col items-center gap-1.5 group">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition-all ${
                  activeTab === tab ? "bg-[#4ade80] text-[#040810]"
                    : i < tabIdx ? "bg-[#1e3a2f] text-[#4ade80]"
                    : "bg-[#0f1923] border border-[#1e3a2f] text-[#334155] group-hover:border-[#4ade80]/30"
                }`}>
                  {tab === "Results" && loading ? (
                    <div className="w-3 h-3 border-2 border-[#4ade80]/40 border-t-[#4ade80] rounded-full animate-spin" />
                  ) : i < tabIdx ? (
                    <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                      <path d="M1 4L3.5 6.5L9 1" stroke="#4ade80" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : i + 1}
                </div>
                <span className={`text-[10px] whitespace-nowrap transition-colors ${
                  activeTab === tab ? "text-[#4ade80]" : "text-[#334155] group-hover:text-[#64748b]"
                }`}>{tab}</span>
              </button>
              {i < TABS.length - 1 && (
                <div className={`flex-1 h-px mx-2 mb-4 transition-colors ${i < tabIdx ? "bg-[#4ade80]/30" : "bg-[#1e3a2f]"}`} />
              )}
            </div>
          ))}
        </div>

        <div className="bg-[#080e17] border border-[#1e3a2f] rounded-2xl p-6 min-h-[400px]">
          {activeTab === "Patient" && <PatientPanel state={patient} set={setPatient} />}
          {activeTab === "Drug & Clinical" && <DrugPanel state={drug} set={setDrug} />}
          {activeTab === "Interactions" && <InteractionsPanel state={interactions} set={setInteractions} />}
          {activeTab === "Results" && <ResultsPanel results={results} loading={loading} loadingStep={loadingStep} />}
        </div>

        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

        <div className="flex gap-3 mt-4">
          {activeTab !== "Patient" && (
            <button onClick={() => setActiveTab(TABS[tabIdx - 1])}
              className="px-5 py-2.5 text-sm border border-[#1e3a2f] rounded-xl text-[#64748b] hover:text-[#e2e8f0] hover:border-[#4ade80]/30 transition-all">
              ← Back
            </button>
          )}
          <div className="flex-1" />
          {activeTab !== "Interactions" && activeTab !== "Results" && (
            <button onClick={() => setActiveTab(TABS[tabIdx + 1])}
              className="px-5 py-2.5 text-sm rounded-xl text-[#040810] font-semibold transition-all hover:opacity-90 active:scale-[0.98]"
              style={{ background: "linear-gradient(135deg, #4ade80 0%, #22d3a0 100%)" }}>
              Next →
            </button>
          )}
          {(activeTab === "Interactions" || activeTab === "Results") && (
            <button onClick={calculate} disabled={loading}
              className="px-6 py-2.5 text-sm rounded-xl text-[#040810] font-semibold transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              style={{ background: "linear-gradient(135deg, #4ade80 0%, #22d3a0 100%)" }}>
              {loading && <div className="w-3.5 h-3.5 border-2 border-[#040810]/40 border-t-[#040810] rounded-full animate-spin" />}
              {loading ? "Analysing…" : "Calculate dosage"}
            </button>
          )}
        </div>

        <p className="text-[11px] text-[#1e3a2f] text-center mt-5 leading-relaxed">
          For clinical decision support only. Always verify with current formulary guidelines. Not a substitute for professional medical advice.
        </p>
      </div>
    </main>
  );
}