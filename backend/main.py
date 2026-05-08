import os
import io
import json
import csv
import uuid
from datetime import datetime
from typing import List, Optional

import httpx
import PyPDF2
import anthropic
from docx import Document
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse

load_dotenv()

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
META_APP_ID = os.getenv("META_APP_ID", "")
META_APP_SECRET = os.getenv("META_APP_SECRET", "")
BASE_URL = os.getenv("BASE_URL", "http://localhost:8000")
REDIRECT_URI = f"{BASE_URL}/auth/meta/callback"

app = FastAPI(title="Performance Creative Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

# In-memory session store (fine for hackathon)
sessions: dict = {}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def new_session() -> tuple[str, dict]:
    sid = str(uuid.uuid4())
    sessions[sid] = {
        "id": sid,
        "brief": None,
        "brand_docs": [],
        "meta_data": None,
        "google_data": None,
        "ga4_data": None,
        "meta_token": None,
        "generated": None,
        "config": {},
        "created_at": datetime.utcnow().isoformat(),
    }
    return sid, sessions[sid]


def require_session(session_id: str) -> dict:
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found — start a new session.")
    return sessions[session_id]


def extract_text(content: bytes, filename: str) -> str:
    name = filename.lower()
    if name.endswith(".pdf"):
        reader = PyPDF2.PdfReader(io.BytesIO(content))
        return "\n".join(p.extract_text() or "" for p in reader.pages)
    elif name.endswith(".docx"):
        doc = Document(io.BytesIO(content))
        return "\n".join(p.text for p in doc.paragraphs)
    else:
        return content.decode("utf-8", errors="ignore")


# ---------------------------------------------------------------------------
# Session endpoints
# ---------------------------------------------------------------------------

@app.post("/api/sessions")
def create_session():
    sid, _ = new_session()
    return {"session_id": sid}


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str):
    s = require_session(session_id)
    return {
        "id": session_id,
        "has_brief": s["brief"] is not None,
        "brand_doc_count": len(s["brand_docs"]),
        "has_meta_data": s["meta_data"] is not None,
        "has_google_data": s["google_data"] is not None,
        "has_ga4_data": s["ga4_data"] is not None,
        "meta_connected": s["meta_token"] is not None,
        "has_generated": s["generated"] is not None,
    }


# ---------------------------------------------------------------------------
# Upload endpoints
# ---------------------------------------------------------------------------

@app.post("/api/upload/brief")
async def upload_brief(session_id: str = Form(...), file: UploadFile = File(...)):
    s = require_session(session_id)
    content = await file.read()
    s["brief"] = {"filename": file.filename, "content": extract_text(content, file.filename)}
    return {"success": True, "filename": file.filename}


@app.post("/api/upload/brand")
async def upload_brand(session_id: str = Form(...), files: List[UploadFile] = File(...)):
    s = require_session(session_id)
    added = []
    for f in files:
        content = await f.read()
        s["brand_docs"].append({"filename": f.filename, "content": extract_text(content, f.filename)})
        added.append(f.filename)
    return {"success": True, "added": added, "total": len(s["brand_docs"])}


@app.post("/api/upload/meta-data")
async def upload_meta_data(session_id: str = Form(...), file: UploadFile = File(...)):
    s = require_session(session_id)
    content = await file.read()
    s["meta_data"] = {"filename": file.filename, "content": extract_text(content, file.filename), "source": "upload"}
    return {"success": True, "filename": file.filename}


@app.post("/api/upload/google-data")
async def upload_google_data(session_id: str = Form(...), file: UploadFile = File(...)):
    s = require_session(session_id)
    content = await file.read()
    s["google_data"] = {"filename": file.filename, "content": extract_text(content, file.filename), "source": "upload"}
    return {"success": True, "filename": file.filename}


@app.post("/api/upload/ga4-data")
async def upload_ga4_data(session_id: str = Form(...), file: UploadFile = File(...)):
    s = require_session(session_id)
    content = await file.read()
    s["ga4_data"] = {"filename": file.filename, "content": extract_text(content, file.filename), "source": "upload"}
    return {"success": True, "filename": file.filename}


# ---------------------------------------------------------------------------
# Meta OAuth
# ---------------------------------------------------------------------------

@app.get("/auth/meta")
def meta_auth_start(session_id: str):
    if not META_APP_ID:
        raise HTTPException(status_code=400, detail="Meta app not configured — add META_APP_ID to .env")
    state = f"{session_id}:{uuid.uuid4()}"
    url = (
        f"https://www.facebook.com/v19.0/dialog/oauth"
        f"?client_id={META_APP_ID}"
        f"&redirect_uri={REDIRECT_URI}"
        f"&state={state}"
        f"&scope=ads_read,ads_management,business_management,read_insights"
    )
    return RedirectResponse(url)


@app.get("/auth/meta/callback")
async def meta_auth_callback(code: str, state: str):
    session_id = state.split(":")[0]
    s = require_session(session_id)

    async with httpx.AsyncClient() as http:
        resp = await http.get(
            "https://graph.facebook.com/v19.0/oauth/access_token",
            params={
                "client_id": META_APP_ID,
                "client_secret": META_APP_SECRET,
                "redirect_uri": REDIRECT_URI,
                "code": code,
            },
        )
    data = resp.json()
    if "access_token" not in data:
        raise HTTPException(status_code=400, detail=f"Meta auth failed: {data}")

    s["meta_token"] = data["access_token"]
    return RedirectResponse(f"/?session_id={session_id}&meta_connected=1")


@app.post("/api/fetch/meta")
async def fetch_meta_data(req: Request):
    body = await req.json()
    session_id = body.get("session_id", "")
    s = require_session(session_id)
    token = s.get("meta_token")
    if not token:
        raise HTTPException(status_code=401, detail="Meta not connected")

    date_preset = body.get("date_range", "last_30d")

    async with httpx.AsyncClient() as http:
        accounts_resp = await http.get(
            "https://graph.facebook.com/v19.0/me/adaccounts",
            params={"access_token": token, "fields": "id,name"},
        )
        accounts = accounts_resp.json().get("data", [])
        if not accounts:
            raise HTTPException(status_code=400, detail="No ad accounts found")

        account_id = accounts[0]["id"]
        insights_resp = await http.get(
            f"https://graph.facebook.com/v19.0/{account_id}/insights",
            params={
                "access_token": token,
                "level": "ad",
                "fields": "ad_name,campaign_name,adset_name,impressions,clicks,spend,ctr,actions",
                "date_preset": date_preset,
                "sort": "spend_descending",
                "limit": 50,
            },
        )
        data = insights_resp.json().get("data", [])

    s["meta_data"] = {
        "content": json.dumps(data, indent=2),
        "source": "api",
        "account_id": account_id,
        "filename": f"{accounts[0].get('name', account_id)} — Meta insights",
    }
    return {"success": True, "ads_fetched": len(data), "account": accounts[0].get("name")}


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------

GENERATION_PROMPT = """You are an expert performance marketer and paid social copywriter specializing in Meta advertising.

Analyze all provided data and generate high-converting Meta ad creative.

## CREATIVE BRIEF
{brief}

## BRAND GUIDELINES
{brand}

## HISTORICAL META AD PERFORMANCE DATA
{meta}

## TOP GOOGLE ADS KEYWORDS & COPY PATTERNS
{google}

## TOP LANDING PAGES (GA4 DATA)
{ga4}

## GENERATION REQUIREMENTS
- Target Placements: {placements}
- Funnel Stage: {funnel_stage}
- Variants per placement: {num_variants}
- Campaign: {campaign_name}

## INSTRUCTIONS
First, analyze the historical data to identify:
1. Winning creative themes and hook patterns
2. CTAs with the strongest conversion signals
3. Emotional triggers that resonate with this audience
4. Message frameworks from top performers
5. Keywords and phrases that appear in top Google Ads

Then generate new ad copy for each placement that:
- Directly addresses the campaign goals in the brief
- Reflects the brand voice (from guidelines if provided)
- Leverages proven patterns from historical data
- Is length-optimized per placement (Reels/Stories: punchy 1-2 lines; Feed: fuller narrative)
- Uses platform-appropriate tone

For each ad, specify the CTA as one of: LEARN_MORE, SHOP_NOW, GET_STARTED, SIGN_UP, BOOK_NOW, CONTACT_US, DOWNLOAD, GET_QUOTE, APPLY_NOW

Return ONLY valid JSON — no markdown, no explanation — using exactly this structure:
{{
  "analysis": {{
    "winning_themes": ["theme 1", "theme 2", "theme 3"],
    "top_hooks": ["hook 1", "hook 2", "hook 3"],
    "top_ctas": ["CTA 1", "CTA 2"],
    "emotional_triggers": ["trigger 1", "trigger 2", "trigger 3"],
    "key_insights": "2-3 sentence summary of what the performance data reveals about what works for this audience."
  }},
  "ads": [
    {{
      "placement": "Facebook Feed",
      "variant": 1,
      "ad_name": "Descriptive ad name for internal reference",
      "hook": "The opening hook line",
      "primary_text": "Full primary text body copy (can be multi-paragraph for Feed)",
      "headline": "Headline text (short, punchy)",
      "description": "Link description (1 sentence)",
      "cta": "LEARN_MORE",
      "emotional_angle": "e.g. Social proof / Aspiration / FOMO / Problem-solution",
      "rationale": "1-2 sentences: why this angle, grounded in the data"
    }}
  ]
}}"""


@app.post("/api/generate")
async def generate_ads(req: Request):
    body = await req.json()
    session_id = body.get("session_id", "")
    config = body.get("config", {})
    s = require_session(session_id)

    if not s.get("brief"):
        raise HTTPException(status_code=400, detail="A creative brief is required before generating.")

    brief_text = s["brief"]["content"]
    brand_text = (
        "\n\n---\n\n".join(f"[{d['filename']}]\n{d['content']}" for d in s["brand_docs"])
        if s["brand_docs"]
        else "No brand guidelines provided. Use a professional, clear, results-focused tone."
    )
    meta_text = s["meta_data"]["content"] if s.get("meta_data") else "No Meta data provided."
    google_text = s["google_data"]["content"] if s.get("google_data") else "No Google Ads data provided."
    ga4_text = s["ga4_data"]["content"] if s.get("ga4_data") else "No GA4 data provided."

    placements = config.get("placements", ["Facebook Feed", "Instagram Feed", "Reels", "Stories", "Advantage+"])
    funnel_stage = config.get("funnel_stage", "Consideration")
    num_variants = config.get("num_variants", 3)
    campaign_name = config.get("campaign_name", "Performance Creative Engine")

    prompt = GENERATION_PROMPT.format(
        brief=brief_text,
        brand=brand_text,
        meta=meta_text,
        google=google_text,
        ga4=ga4_text,
        placements=", ".join(placements),
        funnel_stage=funnel_stage,
        num_variants=num_variants,
        campaign_name=campaign_name,
    )

    message = client.messages.create(
        model="claude-opus-4-7",
        max_tokens=8192,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = message.content[0].text
    start, end = raw.find("{"), raw.rfind("}") + 1
    if start == -1:
        raise HTTPException(status_code=500, detail="AI returned unparseable response.")

    try:
        result = json.loads(raw[start:end])
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=500, detail=f"JSON parse error: {e}")

    s["generated"] = result
    s["config"] = config
    return result


# ---------------------------------------------------------------------------
# CSV Export
# ---------------------------------------------------------------------------

VALID_CTAS = {
    "LEARN_MORE", "SHOP_NOW", "GET_STARTED", "SIGN_UP",
    "BOOK_NOW", "CONTACT_US", "DOWNLOAD", "GET_QUOTE", "APPLY_NOW",
}


@app.get("/api/export/{session_id}")
def export_csv(session_id: str):
    s = require_session(session_id)
    if not s.get("generated"):
        raise HTTPException(status_code=400, detail="No generated ads to export.")

    ads = s["generated"].get("ads", [])
    config = s.get("config", {})
    campaign_name = config.get("campaign_name", "Performance Creative Engine")
    funnel_stage = config.get("funnel_stage", "Consideration")

    buf = io.StringIO()
    fields = [
        "Campaign name",
        "Ad set name",
        "Ad name",
        "Ad type",
        "Placement",
        "Primary text",
        "Headline",
        "Description",
        "Call to action type",
        "Hook",
        "Emotional angle",
        "Funnel stage",
        "Variant",
    ]
    writer = csv.DictWriter(buf, fieldnames=fields)
    writer.writeheader()

    for ad in ads:
        placement = ad.get("placement", "Facebook Feed")
        cta = ad.get("cta", "LEARN_MORE")
        if cta not in VALID_CTAS:
            cta = "LEARN_MORE"

        if "Advantage" in placement:
            ad_type = "ADVANTAGE_PLUS_CREATIVE"
        elif any(k in placement for k in ["Reel", "Stor"]):
            ad_type = "VIDEO_AD"
        else:
            ad_type = "LINK_AD"

        writer.writerow({
            "Campaign name": campaign_name,
            "Ad set name": f"{placement} | {funnel_stage} | Var {ad.get('variant', 1)}",
            "Ad name": ad.get("ad_name", ""),
            "Ad type": ad_type,
            "Placement": placement.upper().replace(" ", "_").replace("+", "PLUS"),
            "Primary text": ad.get("primary_text", ""),
            "Headline": ad.get("headline", ""),
            "Description": ad.get("description", ""),
            "Call to action type": cta,
            "Hook": ad.get("hook", ""),
            "Emotional angle": ad.get("emotional_angle", ""),
            "Funnel stage": funnel_stage,
            "Variant": ad.get("variant", 1),
        })

    csv_bytes = buf.getvalue().encode("utf-8-sig")  # BOM for Excel compatibility
    return StreamingResponse(
        io.BytesIO(csv_bytes),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="meta-ads-{session_id[:8]}.csv"'},
    )


# ---------------------------------------------------------------------------
# Static file serving
# ---------------------------------------------------------------------------

STATIC_ROOT = os.path.join(os.path.dirname(__file__), "..")


@app.get("/styles.css")
def serve_css():
    return FileResponse(os.path.join(STATIC_ROOT, "styles.css"), media_type="text/css")


@app.get("/app.js")
def serve_js():
    return FileResponse(os.path.join(STATIC_ROOT, "app.js"), media_type="application/javascript")


@app.get("/{full_path:path}")
@app.get("/")
def serve_frontend():
    return FileResponse(os.path.join(STATIC_ROOT, "index.html"), media_type="text/html")
