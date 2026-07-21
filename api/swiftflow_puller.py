"""Pull newly registered domains, enrich them, and send leads to SwiftFlow."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import hmac
import json
import os
import time
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

USER_AGENT = "LeadsDB-SwiftFlow/1.0"


def _request_json(url: str, *, method: str = "GET", body: bytes | None = None,
                  headers: dict[str, str] | None = None, timeout: int = 30) -> Any:
    request = Request(url, data=body, method=method, headers={
        "Accept": "application/json", "User-Agent": USER_AGENT, **(headers or {})
    })
    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def read_domains(folder: Path) -> list[str]:
    """Read, normalize, and deduplicate domains from all .gz files in a folder."""
    domains: set[str] = set()
    for source in sorted(folder.glob("*.gz")):
        with gzip.open(source, "rt", encoding="utf-8", errors="ignore") as stream:
            for line in stream:
                domain = line.strip().lower().rstrip(".")
                if domain and "." in domain and " " not in domain:
                    domains.add(domain)
    return sorted(domains)


def enrich(domain: str, api_url: str, api_key: str, timeout: int = 30) -> dict[str, Any] | None:
    result = _request_json(f"{api_url.rstrip('/')}?{urlencode({'api_key': api_key, 'domain': domain})}", timeout=timeout)
    return result if isinstance(result, dict) and (result.get("name") or result.get("domain")) else None


def normalize_lead(company: dict[str, Any], source_domain: str) -> dict[str, Any]:
    domain = str(company.get("domain") or source_domain).lower()
    return {
        "id": hashlib.sha256(domain.encode()).hexdigest()[:24],
        "company_name": company.get("name"),
        "domain": domain,
        "website": company.get("website") or f"https://{domain}",
        "industry": company.get("industry"),
        "employee_count": company.get("employees_count") or company.get("employee_count"),
        "year_founded": company.get("year_founded"),
        "country": company.get("country") or company.get("country_code"),
        "city": company.get("locality") or company.get("city"),
        "linkedin_url": company.get("linkedin_url"),
        "source": "leads-db",
        "source_data": company,
    }


def matches(lead: dict[str, Any], industries: set[str], countries: set[str],
            min_employees: int | None, max_employees: int | None) -> bool:
    industry = str(lead.get("industry") or "").lower()
    country = str(lead.get("country") or "").lower()
    if industries and not any(value in industry for value in industries):
        return False
    if countries and country not in countries:
        return False
    try:
        employees = int(lead["employee_count"]) if lead.get("employee_count") is not None else None
    except (TypeError, ValueError):
        employees = None
    return not ((min_employees is not None and (employees is None or employees < min_employees)) or
                (max_employees is not None and (employees is None or employees > max_employees)))


def load_seen(path: Path) -> set[str]:
    if not path.exists():
        return set()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return set(data if isinstance(data, list) else [])
    except (OSError, json.JSONDecodeError):
        return set()


def save_seen(path: Path, seen: set[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(sorted(seen), indent=2), encoding="utf-8")
    temp.replace(path)


def deliver(webhook_url: str, leads: list[dict[str, Any]], secret: str = "",
            retries: int = 3, timeout: int = 30) -> Any:
    body = json.dumps({"event": "leads.created", "leads": leads}, separators=(",", ":")).encode()
    headers = {"Content-Type": "application/json", "Idempotency-Key": hashlib.sha256(body).hexdigest()}
    if secret:
        headers["X-SwiftFlow-Signature"] = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    for attempt in range(retries):
        try:
            return _request_json(webhook_url, method="POST", body=body, headers=headers, timeout=timeout)
        except (HTTPError, URLError, TimeoutError):
            if attempt + 1 == retries:
                raise
            time.sleep(2 ** attempt)


def batched(items: list[dict[str, Any]], size: int) -> Iterable[list[dict[str, Any]]]:
    for offset in range(0, len(items), size):
        yield items[offset:offset + size]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Pull LeadsDB leads into SwiftFlow")
    parser.add_argument("--data-dir", type=Path, default=Path("data/daily"))
    parser.add_argument("--state-file", type=Path, default=Path(".swiftflow/seen.json"))
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--batch-size", type=int, default=25)
    parser.add_argument("--industry", action="append", default=[])
    parser.add_argument("--country", action="append", default=[])
    parser.add_argument("--min-employees", type=int)
    parser.add_argument("--max-employees", type=int)
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    api_key = os.getenv("ABSTRACT_API_COMPANY_ENRICHMENT_API_KEY", "")
    api_url = os.getenv("ABSTRACT_API_COMPANY_ENRICHMENT_API_URL", "https://companyenrichment.abstractapi.com/v1/")
    webhook = os.getenv("SWIFTFLOW_WEBHOOK_URL", "")
    if not api_key:
        raise SystemExit("ABSTRACT_API_COMPANY_ENRICHMENT_API_KEY is required")
    if not webhook and not args.dry_run:
        raise SystemExit("SWIFTFLOW_WEBHOOK_URL is required unless --dry-run is used")
    seen, leads = load_seen(args.state_file), []
    industries, countries = {x.lower() for x in args.industry}, {x.lower() for x in args.country}
    for domain in read_domains(args.data_dir):
        if hashlib.sha256(domain.encode()).hexdigest()[:24] in seen:
            continue
        try:
            company = enrich(domain, api_url, api_key)
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as error:
            print(json.dumps({"level": "warning", "domain": domain, "error": str(error)}))
            continue
        if company:
            lead = normalize_lead(company, domain)
            if matches(lead, industries, countries, args.min_employees, args.max_employees):
                leads.append(lead)
        if len(leads) >= args.limit:
            break
    if args.dry_run:
        print(json.dumps({"event": "leads.created", "leads": leads}, indent=2))
        return 0
    for batch in batched(leads, max(1, args.batch_size)):
        deliver(webhook, batch, os.getenv("SWIFTFLOW_WEBHOOK_SECRET", ""))
        seen.update(lead["id"] for lead in batch)
        save_seen(args.state_file, seen)
    print(json.dumps({"status": "ok", "delivered": len(leads)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
