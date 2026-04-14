/**
 * Dosage Calculator — API client
 * Connects the Next.js frontend to the FastAPI + Gemini backend.
 * Place this file at: lib/api.ts  (or src/lib/api.ts)
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// ── Request types (mirror backend Pydantic models) ────────────────────────────

export interface PatientFactors {
  age: number;
  weight_kg: number;
  height_cm: number;
  gender: string;
  pregnancy_status: "none" | "pregnant" | "lactating";
  egfr: number;
  child_pugh: "A" | "B" | "C";
  diabetes: boolean;
  hypertension: boolean;
  heart_failure: boolean;
  copd_asthma: boolean;
  epilepsy: boolean;
  immunocompromised: boolean;
}

export interface DrugFactors {
  drug_name: string;
  standard_adult_dose_mg: number;
  route: "oral" | "iv" | "im" | "topical" | "sublingual";
  therapeutic_index: "wide" | "narrow";
  dosing_basis: "fixed" | "kg" | "bsa";
  frequency: "od" | "bd" | "tds" | "qds" | "prn";
  duration_days: number;
  severity: "mild" | "moderate" | "severe";
  condition_type: "acute" | "chronic";
  bioavailability_pct: number;
  metabolism: "normal" | "poor" | "ultra";
}

export interface InteractionFactors {
  warfarin: boolean;
  nsaids: boolean;
  ssri: boolean;
  ace_inhibitors: boolean;
  statins: boolean;
  insulin: boolean;
  cyp450_inhibitors: boolean;
  smoking: boolean;
  alcohol: boolean;
  grapefruit_risk: boolean;
  fasting: boolean;
  known_allergy: boolean;
  long_term_tolerance: boolean;
}

export interface DosageRequest {
  patient: PatientFactors;
  drug: DrugFactors;
  interactions: InteractionFactors;
}

// ── Response types ────────────────────────────────────────────────────────────

export interface DosageFlag {
  severity: "danger" | "warn" | "info";
  message: string;
}

export interface DosageResponse {
  drug_name: string;
  recommended_single_dose_mg: number;
  recommended_daily_dose_mg: number;
  total_course_dose_mg: number;
  frequency: string;
  route: string;
  duration_days: number;
  risk_level: "Low" | "Moderate" | "High";
  risk_score: number;
  dose_adjustments: string[];
  clinical_flags: DosageFlag[];
  monitoring_recommendations: string[];
  gemini_reasoning: string;
  disclaimer: string;
}

// ── API call ──────────────────────────────────────────────────────────────────

export async function calculateDosage(
  payload: DosageRequest
): Promise<DosageResponse> {
  const res = await fetch(`${API_BASE}/calculate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "API request failed");
  }

  return res.json() as Promise<DosageResponse>;
}

// ── Helper: map frontend state → DosageRequest ────────────────────────────────
// Use this in your page.tsx to transform the UI state before calling the API.

export function buildRequest(
  patient: {
    age: number; weight: number; height: number; gender: string;
    pregnancy: string; egfr: number; liver: string;
    dm: boolean; htn: boolean; chf: boolean; copd: boolean; epi: boolean; hiv: boolean;
  },
  drug: {
    drugName: string; stdDose: number; route: string; ti: string;
    dosisBasis: string; frequency: string; duration: number;
    severity: string; conditionType: string; bioav: number; metabolism: string;
  },
  interactions: {
    warfarin: boolean; nsaid: boolean; ssri: boolean; ace: boolean;
    statin: boolean; insulin: boolean; cyp: boolean;
    smoking: boolean; alcohol: boolean; grapefruit: boolean; fasting: boolean;
    allergy: boolean; tolerance: boolean;
  }
): DosageRequest {
  return {
    patient: {
      age: patient.age,
      weight_kg: patient.weight,
      height_cm: patient.height,
      gender: patient.gender,
      pregnancy_status: patient.pregnancy as PatientFactors["pregnancy_status"],
      egfr: patient.egfr,
      child_pugh: patient.liver as PatientFactors["child_pugh"],
      diabetes: patient.dm,
      hypertension: patient.htn,
      heart_failure: patient.chf,
      copd_asthma: patient.copd,
      epilepsy: patient.epi,
      immunocompromised: patient.hiv,
    },
    drug: {
      drug_name: drug.drugName,
      standard_adult_dose_mg: drug.stdDose,
      route: drug.route as DrugFactors["route"],
      therapeutic_index: drug.ti as DrugFactors["therapeutic_index"],
      dosing_basis: drug.dosisBasis as DrugFactors["dosing_basis"],
      frequency: drug.frequency as DrugFactors["frequency"],
      duration_days: drug.duration,
      severity: drug.severity as DrugFactors["severity"],
      condition_type: drug.conditionType as DrugFactors["condition_type"],
      bioavailability_pct: drug.bioav,
      metabolism: drug.metabolism as DrugFactors["metabolism"],
    },
    interactions: {
      warfarin: interactions.warfarin,
      nsaids: interactions.nsaid,
      ssri: interactions.ssri,
      ace_inhibitors: interactions.ace,
      statins: interactions.statin,
      insulin: interactions.insulin,
      cyp450_inhibitors: interactions.cyp,
      smoking: interactions.smoking,
      alcohol: interactions.alcohol,
      grapefruit_risk: interactions.grapefruit,
      fasting: interactions.fasting,
      known_allergy: interactions.allergy,
      long_term_tolerance: interactions.tolerance,
    },
  };
}


