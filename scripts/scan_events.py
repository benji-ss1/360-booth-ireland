#!/usr/bin/env python3
"""
360 Booth Ireland — Event Lead Scanner
Scheduled script: finds upcoming Irish events and extracts organiser contacts.

Setup:
  pip install exa-py groq python-dotenv

Usage:
  python scan_events.py                  # outputs leads_output.json
  python scan_events.py --push           # also writes to Supabase (future)
  python scan_events.py --preview        # print summary to terminal only

Cron (Mac) — add via: crontab -e
  0 9 1 1,7 * /usr/bin/python3 /Users/benjisanusi/Desktop/360-booth-ireland/scripts/scan_events.py
"""

import json
import os
import re
import sys
import time
import argparse
from datetime import datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv

# Load .env.local from project root
env_path = Path(__file__).parent.parent / '.env.local'
load_dotenv(env_path)

EXA_API_KEY = os.environ.get('EXA_API_KEY')
GROQ_API_KEY = os.environ.get('GROQ_API_KEY')

if not EXA_API_KEY or not GROQ_API_KEY:
    print('ERROR: EXA_API_KEY and GROQ_API_KEY must be set in .env.local')
    sys.exit(1)

try:
    from exa_py import Exa
    from groq import Groq
except ImportError:
    print('ERROR: Run: pip install exa-py groq python-dotenv')
    sys.exit(1)

exa = Exa(api_key=EXA_API_KEY)
groq_client = Groq(api_key=GROQ_API_KEY)

QUERIES = [
    'corporate events Ireland 2026',
    'wedding reception events Dublin Cork Galway 2026',
    'birthday party events Ireland 2026 venue hire',
    'gala dinner fundraiser events Ireland 2026',
    'business networking conference events Ireland 2026',
    'product launch party events Dublin 2026',
]

EVENT_DOMAINS = [
    'eventbrite.ie',
    'eventbrite.com',
    'ticketmaster.ie',
    'meetup.com',
    'lovin.ie',
    'entertainment.ie',
]

OUTPUT_FILE = Path(__file__).parent / 'leads_output.json'


def uid():
    import random, string
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=10))


def infer_service(event_type: str) -> str:
    if not event_type:
        return '360 Booth'
    t = event_type.lower()
    if t == 'wedding':
        return 'Selfie Mirror'
    if t in ('birthday', 'party'):
        return 'Selfie Mirror'
    if t in ('corporate', 'conference'):
        return '360 Booth'
    return '360 Booth'


def extract_email_fallback(text: str):
    m = re.search(r'[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}', text)
    return m.group(0) if m else None


def extract_phone_fallback(text: str):
    m = re.search(r'(\+353|0)[\s\-]?\d[\s\-]?\d{3}[\s\-]?\d{4}', text)
    return re.sub(r'[\s\-]', '', m.group(0)) if m else None


def search_events(query: str) -> list[dict]:
    today = datetime.utcnow().strftime('%Y-%m-%d')
    next_year = (datetime.utcnow() + timedelta(days=365)).strftime('%Y-%m-%d')
    try:
        results = exa.search(
            query,
            type='auto',
            num_results=8,
            start_published_date=today,
            end_published_date=next_year,
            include_domains=EVENT_DOMAINS,
            contents={'highlights': True},
        )
        return [{'url': r.url, 'title': r.title} for r in results.results]
    except Exception as e:
        print(f'  Exa search error for "{query}": {e}')
        return []


def get_contents(urls: list[str]) -> dict:
    if not urls:
        return {}
    try:
        results = exa.get_contents(urls, text={'max_characters': 4000})
        return {r.url: r for r in results.results}
    except Exception as e:
        print(f'  Exa contents error: {e}')
        return {}


def extract_with_groq(text: str, title: str, url: str) -> dict | None:
    if not text or len(text) < 100:
        return None

    prompt = f"""You are a lead extraction agent for a photo booth hire company in Ireland.
Extract event organiser contact details from this event page content.

Return ONLY valid JSON with these exact fields (use null if not found — do not invent data):
{{
  "organizer_name": "string or null",
  "email": "string or null",
  "phone": "string or null",
  "event_name": "string",
  "event_date": "YYYY-MM-DD or null",
  "venue": "string or null",
  "event_type": "wedding|corporate|birthday|party|fundraiser|conference|other"
}}

Event page content:
{text[:3000]}"""

    try:
        response = groq_client.chat.completions.create(
            model='llama-3.3-70b-versatile',
            messages=[{'role': 'user', 'content': prompt}],
            temperature=0.1,
            max_tokens=400,
            response_format={'type': 'json_object'},
        )
        raw = response.choices[0].message.content
        parsed = json.loads(raw)
        if not parsed.get('email'):
            parsed['email'] = extract_email_fallback(text)
        if not parsed.get('phone'):
            parsed['phone'] = extract_phone_fallback(text)
        parsed['source_url'] = url
        return parsed
    except Exception as e:
        # Regex fallback
        return {
            'organizer_name': None,
            'email': extract_email_fallback(text),
            'phone': extract_phone_fallback(text),
            'event_name': title or 'Unknown Event',
            'event_date': None,
            'venue': None,
            'event_type': 'other',
            'source_url': url,
        }


def map_to_lead(extracted: dict) -> dict | None:
    if not extracted:
        return None
    today = datetime.utcnow().strftime('%Y-%m-%d')
    parts = []
    if extracted.get('event_name'):
        parts.append(f"Event: {extracted['event_name']}")
    if extracted.get('event_date'):
        parts.append(f"Date: {extracted['event_date']}")
    if extracted.get('venue'):
        parts.append(f"Venue: {extracted['venue']}")
    if extracted.get('source_url'):
        parts.append(f"Source: {extracted['source_url']}")
    return {
        'id': uid(),
        'name': extracted.get('organizer_name') or f"{extracted.get('event_name', 'Event')} Organiser",
        'email': extracted.get('email') or '',
        'phone': extracted.get('phone') or '',
        'source': 'Event Scrape',
        'service': infer_service(extracted.get('event_type', '')),
        'status': 'New',
        'date': today,
        'notes': ' | '.join(parts),
        'createdAt': int(time.time() * 1000),
    }


def run(preview_only=False):
    print(f'\n360 Booth Ireland — Event Lead Scanner')
    print(f'Started: {datetime.now().strftime("%Y-%m-%d %H:%M")}')
    print('━' * 50)

    # Step 1: Collect URLs from all queries
    all_results = []
    for q in QUERIES:
        print(f'  Searching: {q}')
        results = search_events(q)
        all_results.extend(results)
        time.sleep(0.3)  # gentle rate limiting

    # Deduplicate URLs, cap at 30
    seen = set()
    unique_results = []
    for r in all_results:
        if r['url'] not in seen:
            seen.add(r['url'])
            unique_results.append(r)
        if len(unique_results) >= 30:
            break

    print(f'\n  Found {len(unique_results)} unique event URLs')

    if not unique_results:
        print('  No results — check your EXA_API_KEY or try broadening queries')
        return

    # Step 2: Fetch page content
    print('  Fetching page content…')
    urls = [r['url'] for r in unique_results]
    content_map = get_contents(urls)

    # Step 3: Extract leads with Groq
    print('  Extracting organiser contacts with Groq…')
    leads = []
    for i, r in enumerate(unique_results):
        content = content_map.get(r['url'])
        text = getattr(content, 'text', '') or ''
        extracted = extract_with_groq(text, r.get('title', ''), r['url'])
        lead = map_to_lead(extracted)
        # Only keep leads with at least an email or phone
        if lead and (lead['email'] or lead['phone']):
            leads.append(lead)
            print(f'    ✓ {lead["name"]} | {lead["email"] or lead["phone"]}')
        if (i + 1) % 5 == 0:
            time.sleep(0.5)  # rate limiting

    print(f'\n━' * 50)
    print(f'  Found {len(leads)} leads with contact details')

    if preview_only:
        print('\nPreview (not saved):')
        for l in leads:
            print(f'  • {l["name"]} | {l["email"] or "—"} | {l["phone"] or "—"}')
            print(f'    {l["notes"][:120]}')
        return

    # Step 4: Write output JSON
    output = {
        'scannedAt': datetime.utcnow().isoformat(),
        'count': len(leads),
        'leads': leads,
    }
    OUTPUT_FILE.write_text(json.dumps(output, indent=2))
    print(f'\n  ✅ Saved to: {OUTPUT_FILE}')
    print(f'\nTo import: open the 360 dashboard → Lead Gen → "Scan Events" button')
    print(f'Or manually copy leads from {OUTPUT_FILE.name} into the dashboard.\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='360 Booth Ireland — Event Lead Scanner')
    parser.add_argument('--preview', action='store_true', help='Print results without saving')
    parser.add_argument('--push', action='store_true', help='Push to Supabase (future)')
    args = parser.parse_args()
    run(preview_only=args.preview)
