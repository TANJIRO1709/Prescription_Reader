"""
Dosage Calculator API
FastAPI + Google Gemini — optimised for low latency via async streaming SSE.
Uses google-generativeai (existing package) with asyncio.to_thread to avoid
blocking the event loop during synchronous Gemini streaming.
"""

import os
import json
import re
import math
import asyncio
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
import google.generativeai as genai
from dotenv import load_dotenv

load_dotenv()

# ── Gemini setup ──────────────────────────────────────────────────────────────

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY not set in .env")

genai.configure(api_key=GEMINI_API_KEY)
model = genai.GenerativeModel("gemini-2.0-flash-lite")

MODEL = "gemini-flash-latest"

# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="Dosage Calculator API",
    description="AI dosage recommendations via Google Gemini (async streaming)",
    version="3.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    max_age=600,  # cache CORS preflight for 10 min — removes per-request OPTIONS round trip
)

# ── Schemas ───────────────────────────────────────────────────────────────────

class PatientFactors(BaseModel):
    age: int = Field(..., ge=0, le=120)
    weight_kg: float = Field(..., gt=0, le=500)
    height_cm: float = Field(..., gt=0, le=300)
    gender: str
    pregnancy_status: str = "none"
    egfr: float = Field(..., ge=5, le=120)
    child_pugh: str = "A"
    diabetes: bool = False
    hypertension: bool = False
    heart_failure: bool = False
    copd_asthma: bool = False
    epilepsy: bool = False
    immunocompromised: bool = False

class DrugFactors(BaseModel):
    drug_name: str
    standard_adult_dose_mg: float = Field(..., gt=0)
    route: str
    therapeutic_index: str = "wide"
    dosing_basis: str = "fixed"
    frequency: str = "od"
    duration_days: int = Field(default=7, ge=1)
    severity: str = "moderate"
    condition_type: str = "acute"
    bioavailability_pct: float = Field(default=80, ge=1, le=100)
    metabolism: str = "normal"

class InteractionFactors(BaseModel):
    warfarin: bool = False
    nsaids: bool = False
    ssri: bool = False
    ace_inhibitors: bool = False
    statins: bool = False
    insulin: bool = False
    cyp450_inhibitors: bool = False
    smoking: bool = False
    alcohol: bool = False
    grapefruit_risk: bool = False
    fasting: bool = False
    known_allergy: bool = False
    long_term_tolerance: bool = False

class DosageRequest(BaseModel):
    patient: PatientFactors
    drug: DrugFactors
    interactions: InteractionFactors

class DosageFlag(BaseModel):
    severity: str
    message: str

class DosageResponse(BaseModel):
    drug_name: str
    recommended_single_dose_mg: float
    recommended_daily_dose_mg: float
    total_course_dose_mg: float
    frequency: str
    route: str
    duration_days: int
    risk_level: str
    risk_score: int
    dose_adjustments: list[str]
    clinical_flags: list[DosageFlag]
    monitoring_recommendations: list[str]
    gemini_reasoning: str
    disclaimer: str

# ── Prompt builder ────────────────────────────────────────────────────────────

def build_prompt(req: DosageRequest) -> str:
    p, d, i = req.patient, req.drug, req.interactions

    bmi = round(p.weight_kg / ((p.height_cm / 100) ** 2), 1)
    bsa = round(math.sqrt((p.weight_kg * p.height_cm) / 3600), 2)

    kidney = (
        "Normal" if p.egfr >= 90 else
        "Mild↓" if p.egfr >= 60 else
        "Mild-mod↓" if p.egfr >= 45 else
        "Mod-severe↓" if p.egfr >= 30 else
        "Severe CKD" if p.egfr >= 15 else
        "Failure"
    )

    flags_on = [k for k, v in {
        "warfarin": i.warfarin, "NSAIDs": i.nsaids, "SSRI": i.ssri,
        "ACEi/ARB": i.ace_inhibitors, "statin": i.statins, "insulin": i.insulin,
        "CYP450-inhibitor": i.cyp450_inhibitors, "smoking": i.smoking,
        "alcohol": i.alcohol, "grapefruit": i.grapefruit_risk,
        "fasting": i.fasting, "allergy": i.known_allergy, "tolerance": i.long_term_tolerance,
    }.items() if v]

    comorbid = [k for k, v in {
        "DM": p.diabetes, "HTN": p.hypertension, "HF": p.heart_failure,
        "COPD": p.copd_asthma, "epilepsy": p.epilepsy, "immunocompromised": p.immunocompromised,
    }.items() if v]

    age_tag = "PEDIATRIC" if p.age < 18 else "GERIATRIC" if p.age >= 65 else ""

    return f"""Clinical pharmacology task. Return ONLY valid JSON, no markdown.

PATIENT: age={p.age}{f" [{age_tag}]" if age_tag else ""} wt={p.weight_kg}kg ht={p.height_cm}cm BMI={bmi} BSA={bsa}m² sex={p.gender} pregnancy={p.pregnancy_status}
ORGANS: eGFR={p.egfr}({kidney}) liver=Child-Pugh-{p.child_pugh}
COMORBID: {", ".join(comorbid) or "none"}
DRUG: {d.drug_name} std={d.standard_adult_dose_mg}mg route={d.route} basis={d.dosing_basis} freq={d.frequency} dur={d.duration_days}d TI={d.therapeutic_index} severity={d.severity} bioav={d.bioavailability_pct}% CYP={d.metabolism}
INTERACTIONS: {", ".join(flags_on) or "none"}

Respond with this exact JSON structure:
{{"recommended_single_dose_mg":number,"recommended_daily_dose_mg":number,"total_course_dose_mg":number,"frequency_label":"string","risk_level":"Low|Moderate|High","risk_score":0-100,"dose_adjustments":["string"],"clinical_flags":[{{"severity":"danger|warn|info","message":"string"}}],"monitoring_recommendations":["string"],"gemini_reasoning":"1-2 sentence rationale"}}"""


# ── Sync Gemini call (runs in a thread so it doesn't block the event loop) ────

def _collect_gemini_chunks(prompt: str) -> list[str]:
    """
    Runs synchronous Gemini streaming in a thread pool worker.
    Called via asyncio.to_thread() so the event loop stays free.
    """
    response = model.generate_content(
        prompt,
        generation_config=genai.types.GenerationConfig(
            temperature=0.1,
            max_output_tokens=400,
        ),
        stream=True,
    )
    chunks = []
    for chunk in response:
        if chunk.text:
            chunks.append(chunk.text)
    return chunks


# ── Streaming endpoint ────────────────────────────────────────────────────────

async def gemini_stream(req: DosageRequest):
    """
    Async SSE generator.
    Gemini call runs in a thread via asyncio.to_thread — the event loop is never
    blocked, so other requests are handled concurrently while Gemini thinks.
    """
    prompt = build_prompt(req)

    # Immediate heartbeat so the client spinner starts right away
    yield "event: ping\ndata: {}\n\n"

    try:
        chunks = await asyncio.to_thread(_collect_gemini_chunks, prompt)
    except Exception as e:
        yield f"event: error\ndata: {json.dumps({'detail': str(e)})}\n\n"
        return

    # Second ping so the frontend advances its loading step after generation
    yield "event: ping\ndata: {}\n\n"

    raw = "".join(chunks).strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        yield f"event: error\ndata: {json.dumps({'detail': f'JSON parse error: {e}. Raw: {raw[:200]}'})}\n\n"
        return

    flags = [{"severity": f["severity"], "message": f["message"]} for f in data.get("clinical_flags", [])]

    result = {
        "drug_name": req.drug.drug_name,
        "recommended_single_dose_mg": round(data["recommended_single_dose_mg"], 2),
        "recommended_daily_dose_mg": round(data["recommended_daily_dose_mg"], 2),
        "total_course_dose_mg": round(data["total_course_dose_mg"], 2),
        "frequency": data.get("frequency_label", req.drug.frequency),
        "route": req.drug.route,
        "duration_days": req.drug.duration_days,
        "risk_level": data.get("risk_level", "Unknown"),
        "risk_score": int(data.get("risk_score", 0)),
        "dose_adjustments": data.get("dose_adjustments", []),
        "clinical_flags": flags,
        "monitoring_recommendations": data.get("monitoring_recommendations", []),
        "gemini_reasoning": data.get("gemini_reasoning", ""),
        "disclaimer": (
            "AI-generated clinical decision support only. "
            "Verify with current formulary guidelines. Not a substitute for professional medical advice."
        ),
    }

    yield f"event: result\ndata: {json.dumps(result)}\n\n"


@app.post("/calculate/stream")
async def calculate_stream(req: DosageRequest):
    return StreamingResponse(
        gemini_stream(req),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ── Non-streaming fallback ────────────────────────────────────────────────────

@app.post("/calculate", response_model=DosageResponse)
async def calculate_dosage(req: DosageRequest):
    prompt = build_prompt(req)
    try:
        chunks = await asyncio.to_thread(_collect_gemini_chunks, prompt)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Gemini API error: {str(e)}")

    raw = "".join(chunks).strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=500, detail=f"JSON parse error: {e}. Raw: {raw[:300]}")

    flags = [DosageFlag(severity=f["severity"], message=f["message"]) for f in data.get("clinical_flags", [])]

    return DosageResponse(
        drug_name=req.drug.drug_name,
        recommended_single_dose_mg=round(data["recommended_single_dose_mg"], 2),
        recommended_daily_dose_mg=round(data["recommended_daily_dose_mg"], 2),
        total_course_dose_mg=round(data["total_course_dose_mg"], 2),
        frequency=data.get("frequency_label", req.drug.frequency),
        route=req.drug.route,
        duration_days=req.drug.duration_days,
        risk_level=data.get("risk_level", "Unknown"),
        risk_score=int(data.get("risk_score", 0)),
        dose_adjustments=data.get("dose_adjustments", []),
        clinical_flags=flags,
        monitoring_recommendations=data.get("monitoring_recommendations", []),
        gemini_reasoning=data.get("gemini_reasoning", ""),
        disclaimer=(
            "AI-generated clinical decision support only. "
            "Verify with current formulary guidelines. Not a substitute for professional medical advice."
        ),
    )


# ── Health / info ─────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {"service": "Dosage Calculator API", "version": "3.0.0", "model": MODEL}

@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL}