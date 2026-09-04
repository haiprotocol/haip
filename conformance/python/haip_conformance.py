#!/usr/bin/env python3
"""Internally authored Python checks for the HAIP 2 draft HTTP and signed-record contracts."""

from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import json
import math
import os
import secrets
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Sequence, Tuple


PROTOCOL_REVISION = "2.0.0-draft.3"
MAX_SAFE_INTEGER = 9007199254740991
FIELD = 2**255 - 19
ORDER = 2**252 + 27742317777372353535851937790883648493
CURVE_D = (-121665 * pow(121666, FIELD - 2, FIELD)) % FIELD
SQRT_M1 = pow(2, (FIELD - 1) // 4, FIELD)
IDENTITY = (0, 1, 1, 0)
Point = Tuple[int, int, int, int]


class ConformanceError(Exception):
    """A protocol value or response failed a conformance check."""


def _valid_string(value: str) -> None:
    if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
        raise ConformanceError("Invalid Unicode")


def _number(value: float) -> str:
    if not math.isfinite(value):
        raise ConformanceError("Non-finite number")
    if value.is_integer() and abs(value) > MAX_SAFE_INTEGER:
        raise ConformanceError("Unsafe integer")
    if value == 0:
        return "0"
    negative = value < 0
    raw = repr(abs(value)).lower()
    mantissa, marker, exponent_text = raw.partition("e")
    exponent = int(exponent_text) if marker else 0
    whole, dot, fraction = mantissa.partition(".")
    digits = (whole + (fraction if dot else "")).lstrip("0")
    decimal_exponent = exponent - len(fraction)
    while len(digits) > 1 and digits.endswith("0"):
        digits = digits[:-1]
        decimal_exponent += 1
    position = len(digits) + decimal_exponent
    if 1e-6 <= abs(value) < 1e21:
        if position <= 0:
            rendered = "0." + "0" * (-position) + digits
        elif position >= len(digits):
            rendered = digits + "0" * (position - len(digits))
        else:
            rendered = digits[:position] + "." + digits[position:]
    else:
        coefficient = digits[0] + (("." + digits[1:]) if len(digits) > 1 else "")
        scientific_exponent = position - 1
        rendered = coefficient + "e" + ("+" if scientific_exponent >= 0 else "") + str(scientific_exponent)
    return ("-" if negative else "") + rendered


def canonicalise(value: Any) -> str:
    """Return RFC 8785 JSON for the value types used by HAIP signed records."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        _valid_string(value)
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise ConformanceError("Unsafe integer")
        return str(value)
    if isinstance(value, float):
        return _number(value)
    if isinstance(value, list):
        return "[" + ",".join(canonicalise(item) for item in value) + "]"
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise ConformanceError("JSON object keys must be strings")
        keys = sorted(value, key=lambda key: key.encode("utf-16-be"))
        return "{" + ",".join(canonicalise(key) + ":" + canonicalise(value[key]) for key in keys) + "}"
    raise ConformanceError("Unsupported JSON value")


def digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(canonicalise(value).encode("utf-8")).hexdigest()


def digest_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _decimal_form(value: str) -> str:
    mantissa, marker, exponent_text = value.lower().partition("e")
    exponent = int(exponent_text) if marker else 0
    negative = mantissa.startswith("-")
    unsigned = mantissa[1:] if negative else mantissa
    whole, dot, fraction = unsigned.partition(".")
    digits = (whole + (fraction if dot else "")).lstrip("0")
    exponent -= len(fraction)
    while digits.endswith("0"):
        digits = digits[:-1]
        exponent += 1
    return (("-" if negative else "") + digits + "e" + str(exponent)) if digits else "0"


def _parse_float(raw: str) -> float:
    value = float(raw)
    if not math.isfinite(value) or _decimal_form(raw) != _decimal_form(_number(value)):
        raise ConformanceError("Unsupported number precision")
    return value


def _parse_int(raw: str) -> int:
    value = int(raw)
    if abs(value) > MAX_SAFE_INTEGER:
        raise ConformanceError("Unsafe integer")
    return value


def _object(pairs: Sequence[Tuple[str, Any]]) -> Dict[str, Any]:
    value: Dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ConformanceError("Duplicate JSON key")
        value[key] = item
    return value


def _walk_strings(value: Any) -> None:
    if isinstance(value, str):
        _valid_string(value)
    elif isinstance(value, list):
        for item in value:
            _walk_strings(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            _valid_string(key)
            _walk_strings(item)


def parse_json(text: str) -> Any:
    try:
        value = json.loads(
            text,
            object_pairs_hook=_object,
            parse_float=_parse_float,
            parse_int=_parse_int,
            parse_constant=lambda _: (_ for _ in ()).throw(ConformanceError("Non-finite number")),
        )
    except (json.JSONDecodeError, UnicodeError, ValueError) as error:
        if isinstance(error, ConformanceError):
            raise
        raise ConformanceError("Invalid JSON") from error
    _walk_strings(value)
    return value


def _point_add(first: Point, second: Point) -> Point:
    x1, y1, z1, t1 = first
    x2, y2, z2, t2 = second
    a = ((y1 - x1) * (y2 - x2)) % FIELD
    b = ((y1 + x1) * (y2 + x2)) % FIELD
    c = (2 * CURVE_D * t1 * t2) % FIELD
    d = (2 * z1 * z2) % FIELD
    e = b - a
    f = d - c
    g = d + c
    h = b + a
    return ((e * f) % FIELD, (g * h) % FIELD, (f * g) % FIELD, (e * h) % FIELD)


def _scalar_multiply(point: Point, scalar: int) -> Point:
    result = IDENTITY
    addend = point
    while scalar:
        if scalar & 1:
            result = _point_add(result, addend)
        addend = _point_add(addend, addend)
        scalar >>= 1
    return result


def _recover_x(y: int) -> int:
    xx = ((y * y - 1) * pow(CURVE_D * y * y + 1, FIELD - 2, FIELD)) % FIELD
    x = pow(xx, (FIELD + 3) // 8, FIELD)
    if (x * x - xx) % FIELD:
        x = (x * SQRT_M1) % FIELD
    if (x * x - xx) % FIELD:
        raise ConformanceError("Invalid Ed25519 point")
    return x


BASE_Y = (4 * pow(5, FIELD - 2, FIELD)) % FIELD
BASE_X = _recover_x(BASE_Y)
if BASE_X & 1:
    BASE_X = FIELD - BASE_X
BASE = (BASE_X, BASE_Y, 1, (BASE_X * BASE_Y) % FIELD)


def _decode_point(encoded: bytes) -> Point:
    if len(encoded) != 32:
        raise ConformanceError("Invalid Ed25519 point length")
    integer = int.from_bytes(encoded, "little")
    y = integer & ((1 << 255) - 1)
    if y >= FIELD:
        raise ConformanceError("Non-canonical Ed25519 point")
    x = _recover_x(y)
    if (x & 1) != (integer >> 255):
        x = FIELD - x
    if x == 0 and integer >> 255:
        raise ConformanceError("Non-canonical Ed25519 point")
    point = (x, y, 1, (x * y) % FIELD)
    if not _equal_points(_scalar_multiply(point, ORDER), IDENTITY) or _equal_points(point, IDENTITY):
        raise ConformanceError("Ed25519 point outside the prime-order subgroup")
    return point


def _equal_points(first: Point, second: Point) -> bool:
    return (first[0] * second[2] - second[0] * first[2]) % FIELD == 0 and (first[1] * second[2] - second[1] * first[2]) % FIELD == 0


def _public_key_from_pem(pem: str) -> bytes:
    lines = [line for line in pem.strip().splitlines() if not line.startswith("-----")]
    try:
        der = base64.b64decode("".join(lines), validate=True)
    except ValueError as error:
        raise ConformanceError("Invalid public key PEM") from error
    prefix = bytes.fromhex("302a300506032b6570032100")
    if len(der) != len(prefix) + 32 or not der.startswith(prefix):
        raise ConformanceError("Ed25519 SPKI public key required")
    return der[len(prefix) :]


def verify_ed25519(public_key: bytes, message: bytes, signature: bytes) -> None:
    if len(signature) != 64:
        raise ConformanceError("Invalid Ed25519 signature length")
    public = _decode_point(public_key)
    encoded_r = signature[:32]
    r = _decode_point(encoded_r)
    scalar = int.from_bytes(signature[32:], "little")
    if scalar >= ORDER:
        raise ConformanceError("Non-canonical Ed25519 scalar")
    challenge = int.from_bytes(hashlib.sha512(encoded_r + public_key + message).digest(), "little") % ORDER
    if not _equal_points(_scalar_multiply(BASE, scalar), _point_add(r, _scalar_multiply(public, challenge))):
        raise ConformanceError("Invalid Ed25519 signature")


def _time(value: str) -> datetime:
    if not isinstance(value, str):
        raise ConformanceError("Invalid signed-record time")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError) as error:
        raise ConformanceError("Invalid signed-record time") from error
    if parsed.tzinfo is None:
        raise ConformanceError("Signed-record time needs an offset")
    return parsed.astimezone(timezone.utc)


def _decode_signature(value: str) -> bytes:
    if len(value) != 86 or any(char not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-" for char in value):
        raise ConformanceError("Invalid base64url signature")
    try:
        return base64.b64decode(value + "==", altchars=b"-_", validate=True)
    except ValueError as error:
        raise ConformanceError("Invalid base64url signature") from error


def verify_record(record: Mapping[str, Any], trust: Mapping[str, Any], expected: Mapping[str, str], at: Optional[datetime] = None) -> None:
    if set(record) != {"protected", "payload", "signature"} or not isinstance(record["protected"], dict):
        raise ConformanceError("Invalid signed-record envelope")
    header = record["protected"]
    if set(header) != {"type", "protocol_revision", "purpose", "profiles", "issuer", "audience", "tenant", "key_id", "issued_at"} or not isinstance(header["profiles"], dict):
        raise ConformanceError("Invalid protected header")
    for field in ("issuer", "audience", "type", "tenant", "purpose"):
        if field in expected and header.get(field) != expected[field]:
            raise ConformanceError("Signing identity or purpose mismatch")
    if trust.get("issuer") != expected.get("issuer") or trust.get("protocol_revision") != PROTOCOL_REVISION or header.get("protocol_revision") != PROTOCOL_REVISION:
        raise ConformanceError("Signing identity or protocol mismatch")
    trust_keys = trust.get("keys")
    if not isinstance(trust_keys, list):
        raise ConformanceError("Invalid trust manifest")
    keys = [key for key in trust_keys if isinstance(key, dict) and key.get("key_id") == header.get("key_id")]
    if len(keys) != 1 or keys[0].get("algorithm") != "Ed25519":
        raise ConformanceError("Untrusted signing key")
    key = keys[0]
    issued = _time(header.get("issued_at"))
    if issued < _time(key.get("not_before")) or issued >= _time(key.get("not_after")):
        raise ConformanceError("Signing key outside its validity interval")
    if "revoked_at" in key:
        revoked = _time(key["revoked_at"])
        if issued >= revoked:
            raise ConformanceError("Signing key was revoked")
    now = at or datetime.now(timezone.utc)
    if issued.timestamp() > now.timestamp() + 30:
        raise ConformanceError("Signed record is from the future")
    message = canonicalise({"protected": header, "payload": record["payload"]}).encode("utf-8")
    verify_ed25519(_public_key_from_pem(key.get("public_key", "")), message, _decode_signature(record["signature"]))


def verify_candidate(candidate: Mapping[str, Any]) -> None:
    response_canonical = canonicalise(candidate.get("response"))
    if candidate.get("response_canonical") != response_canonical or candidate.get("response_digest") != digest(candidate.get("response")):
        raise ConformanceError("Candidate response commitment mismatch")


def _replace(value: Any, path: Sequence[Any], replacement: Any) -> Any:
    changed = copy.deepcopy(value)
    target = changed
    for part in path[:-1]:
        target = target[part]
    target[path[-1]] = replacement
    return changed


def verify_vectors(path: Path) -> Dict[str, Any]:
    fixture = parse_json(path.read_text(encoding="utf-8"))
    if fixture.get("protocol_revision") != PROTOCOL_REVISION or fixture.get("status") != "frozen":
        raise ConformanceError("Vector set is not the frozen draft-3 set")
    by_name = {vector["name"]: vector for vector in fixture["vectors"]}
    rfc8032 = fixture["rfc8032"]
    if rfc8032 != {
        "public_key_hex": "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
        "message_hex": "",
        "signature_hex": "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    }:
        raise ConformanceError("RFC 8032 vector 1 changed")
    verify_ed25519(bytes.fromhex(rfc8032["public_key_hex"]), bytes.fromhex(rfc8032["message_hex"]), bytes.fromhex(rfc8032["signature_hex"]))
    for vector in fixture["vectors"]:
        if canonicalise(vector["value"]) != vector["canonical"] or digest(vector["value"]) != vector["digest"]:
            raise ConformanceError("Canonical value or digest mismatch for " + vector["name"])
        if vector["name"] == "candidate":
            verify_candidate(vector["value"])
        if "expected" in vector:
            verify_record(vector["value"], fixture["trust"], vector["expected"], datetime(2026, 9, 4, tzinfo=timezone.utc))
    request = by_name["request"]["value"]
    candidate = by_name["candidate"]["value"]
    receipt = by_name["receipt"]["value"]
    claim = by_name["claim"]["value"]
    admission = by_name["admission"]["value"]
    if candidate["request_digest"] != digest(request) or receipt["payload"]["request_digest"] != digest(request) or receipt["payload"]["candidate_digest"] != digest(candidate):
        raise ConformanceError("Decision commitment chain mismatch")
    if claim["payload"]["receipt_digest"] != digest(receipt) or admission["payload"]["claim_digest"] != digest(claim):
        raise ConformanceError("Execution commitment chain mismatch")
    rejected = 0
    for case in fixture["tamper_cases"]:
        vector = by_name[case["vector"]]
        changed = _replace(vector["value"], case["path"], case["replacement"])
        try:
            if vector["name"] == "candidate":
                verify_candidate(changed)
            else:
                verify_record(changed, fixture["trust"], vector["expected"], datetime(2026, 9, 4, tzinfo=timezone.utc))
        except ConformanceError:
            rejected += 1
        else:
            raise ConformanceError("Tamper case was accepted: " + case["name"])
    return {"result": "passed", "vectors": len(fixture["vectors"]), "tamper_cases": rejected, "protocol_revision": PROTOCOL_REVISION}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request: Any, file_pointer: Any, code: int, message: str, headers: Any, new_url: str) -> None:
        return None


class HaipClient:
    def __init__(self, origin: str, token: str):
        try:
            parsed = urllib.parse.urlsplit(origin)
            host = parsed.hostname
            parsed.port
        except ValueError as error:
            raise ConformanceError("Invalid HAIP origin") from error
        if parsed.scheme not in ("http", "https") or not parsed.netloc or not host or parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.password:
            raise ConformanceError("Origin must be an absolute origin without a trailing slash")
        if parsed.scheme == "http" and host not in ("localhost", "127.0.0.1", "::1"):
            raise ConformanceError("HAIP requires HTTPS outside exact loopback hosts")
        if not isinstance(token, str) or not token:
            raise ConformanceError("Bearer credential is required")
        self.origin = origin
        self.host = host
        self.token = token
        self.opener = urllib.request.build_opener(_NoRedirect())

    def call(self, path: str, body: Any = None, idempotency: Optional[str] = None) -> Tuple[int, Any]:
        if not path.startswith("/") or path.startswith("//"):
            raise ConformanceError("HTTP path must stay within the configured origin")
        headers = {"Authorization": "Bearer " + self.token, "Accept": "application/json"}
        data = None
        method = "GET"
        if body is not None:
            method = "POST"
            data = canonicalise(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
            headers["Idempotency-Key"] = idempotency or secrets.token_urlsafe(24)
        request = urllib.request.Request(self.origin + path, data=data, headers=headers, method=method)
        try:
            response = self.opener.open(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read(32 * 1024 * 1024 + 1)
            if len(raw) > 32 * 1024 * 1024:
                raise ConformanceError("HTTP response exceeded the fixture limit")
            return response.status, parse_json(raw.decode("utf-8"))


def _request_path(request_id: str, suffix: str = "") -> str:
    if not isinstance(request_id, str) or not 1 <= len(request_id) <= 160 or any(char not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.:@/-" for char in request_id):
        raise ConformanceError("Invalid request identifier")
    return "/v2/requests/" + urllib.parse.quote(request_id, safe="") + suffix


def _created_request(origin: str, created: Mapping[str, Any], submitted: Mapping[str, Any]) -> Mapping[str, Any]:
    request = created.get("request")
    if not isinstance(request, dict):
        raise ConformanceError("Creation response omitted the request")
    request_id = request.get("id")
    request_path = _request_path(request_id)
    review_path = "/review/" + urllib.parse.quote(request_id, safe="")
    if created.get("request_digest") != digest(request) or created.get("review_link") != origin + review_path or created.get("polling_link") != origin + request_path:
        raise ConformanceError("Creation response binding mismatch")
    for field in ("protocol_revision", "purpose", "profiles", "route", "summary"):
        if request.get(field) != submitted.get(field):
            raise ConformanceError("Accepted request differs from the submitted review")
    if request.get("metadata") != submitted.get("metadata", {}) or request.get("execution") != submitted.get("execution"):
        raise ConformanceError("Accepted request differs from the submitted review")
    review = request.get("review")
    artefact = submitted.get("artefact")
    if not isinstance(review, dict) or not isinstance(artefact, dict) or "bundle" in review:
        raise ConformanceError("Accepted review commitment is invalid")
    if review.get("artefact_digest") != artefact.get("digest") or review.get("representation") != artefact.get("representation") or review.get("digest_rules") != artefact.get("digest_rules") or review.get("payload_digest") != digest(submitted.get("payload")) or review.get("response_schema_digest") != digest(submitted.get("response_schema")) or review.get("document_digest") != digest_bytes(submitted.get("review_document", "").encode("utf-8")):
        raise ConformanceError("Accepted review commitment differs from the submission")
    return request


def review_start(config: Mapping[str, Any]) -> Dict[str, Any]:
    client = HaipClient(config["origin"], config["producer_token"])
    status, discovery = client.call("/.well-known/haip")
    if status != 200 or PROTOCOL_REVISION not in discovery.get("revisions", []):
        raise ConformanceError("Service does not advertise draft 3")
    payload = {"fixture": "python-black-box", "question": "Choose one response"}
    request = {
        "protocol_revision": PROTOCOL_REVISION,
        "purpose": "review",
        "profiles": {},
        "route": config["route"],
        "summary": "Python black-box review fixture",
        "artefact": {"digest": digest(payload), "representation": "application/json", "digest_rules": "rfc8785-sha256"},
        "payload": payload,
        "response_schema": {"type": "object", "properties": {"choice": {"enum": ["accept", "decline"]}}, "required": ["choice"], "additionalProperties": False},
        "review_document": "Choose accept or decline. This fixture grants no execution authority.",
        "metadata": {"fixture": "python-black-box", "run": secrets.token_hex(8)},
    }
    unsupported = copy.deepcopy(request)
    unsupported["profiles"] = {"unsupported.example": "1"}
    if client.call("/v2/requests", unsupported)[0] != 422:
        raise ConformanceError("Unsupported profile was accepted")
    key = secrets.token_urlsafe(24)
    created_status, created = client.call("/v2/requests", request, key)
    if created_status != 201:
        raise ConformanceError("Review request was not created")
    if client.call("/v2/requests", request, key) != (created_status, created):
        raise ConformanceError("Identical idempotent retry changed its result")
    created_request = _created_request(client.origin, created, request)
    changed = copy.deepcopy(request)
    changed["summary"] = "Changed Python black-box fixture"
    if client.call("/v2/requests", changed, key)[0] != 409:
        raise ConformanceError("Changed idempotent retry did not conflict")
    return {"result": "ready", "request_id": created_request["id"], "review_link": created["review_link"], "request_digest": digest(created_request)}


def review_finish(config: Mapping[str, Any]) -> Dict[str, Any]:
    client = HaipClient(config["origin"], config["producer_token"])
    request_id = config["request_id"]
    request_path = _request_path(request_id)
    status_code, status = client.call(request_path)
    if status_code != 200 or status.get("decision_state") != "confirmed" or status.get("grant_state") != "not_applicable" or status.get("execution_state") != "not_applicable":
        raise ConformanceError("Review did not reach its non-executing confirmed state")
    request = status.get("request")
    if not isinstance(request, dict) or request.get("id") != request_id or request.get("purpose") != "review" or request.get("protocol_revision") != PROTOCOL_REVISION or request.get("tenant") != config["tenant"] or request.get("producer") != config["producer"] or "execution" in request or status.get("request_digest") != digest(request):
        raise ConformanceError("Review request binding mismatch")
    receipt = status.get("receipt")
    verify_record(receipt, config["trust"], {"issuer": config["origin"], "audience": config["producer"], "tenant": config["tenant"], "type": "DecisionReceipt", "purpose": "review"})
    _same(receipt["protected"]["profiles"], request["profiles"], "Signed review profile selection mismatch")
    if receipt["payload"].get("request_id") != request_id or receipt["payload"].get("request_digest") != digest(request) or receipt["payload"].get("purpose") != "review" or receipt["payload"].get("decision") != "answer" or receipt["payload"].get("requester") != request["requester"]["subject"]:
        raise ConformanceError("Receipt request commitment mismatch")
    export_status, exported = client.call(request_path + "/export")
    if export_status != 200 or exported.get("request_digest") != digest(request):
        raise ConformanceError("Review export was unavailable")
    _same(exported.get("request"), request, "Review export request mismatch")
    _signed_in_export(exported, receipt, "DecisionReceipt")
    candidate = exported["material"]["candidate"]
    verify_candidate(candidate)
    if candidate.get("request_id") != request_id or candidate.get("request_digest") != digest(request) or candidate.get("reviewer") != receipt["payload"].get("reviewer") or candidate.get("decision") != receipt["payload"].get("decision") or receipt["payload"].get("candidate_id") != candidate.get("id") or receipt["payload"].get("candidate_digest") != digest(candidate) or receipt["payload"].get("response_digest") != digest(candidate["response"]):
        raise ConformanceError("Receipt response commitment mismatch")
    _same(candidate.get("response"), {"choice": "accept"}, "Unexpected review response")
    material = exported["material"]
    if digest(material.get("payload")) != request["review"]["payload_digest"] or digest(material.get("response_schema")) != request["review"]["response_schema_digest"] or digest_bytes(material.get("review_document", "").encode("utf-8")) != request["review"]["document_digest"]:
        raise ConformanceError("Retained review material mismatch")
    refused_status, _ = client.call(request_path + "/claims", {"execution_identity": "python-fixture", "execution_binding_digest": digest({})})
    if refused_status != 409:
        raise ConformanceError("Review-purpose request accepted an execution claim")
    cursor = 0
    found = False
    for _ in range(100):
        event_status, page = client.call("/v2/events?after=" + str(cursor))
        if event_status != 200:
            raise ConformanceError("Producer event page was unavailable")
        for event in page["items"]:
            if event["payload"].get("request_id") == request_id and event["payload"].get("reason") == "decision":
                verify_record(event, config["trust"], {"issuer": config["origin"], "audience": config["producer"], "tenant": config["tenant"], "type": "RequestChangedEvent", "purpose": "review"})
                found = True
        if found or not page["items"] or page["next"] == cursor:
            break
        cursor = page["next"]
    if not found:
        raise ConformanceError("Confirmed decision was missing from producer events")
    return {"result": "passed", "request_id": request_id, "purpose": "review", "execution_authority": False}


def _iso_after(seconds: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def execution_start(config: Mapping[str, Any]) -> Dict[str, Any]:
    client = HaipClient(config["origin"], config["producer_token"])
    status, discovery = client.call("/.well-known/haip")
    if status != 200 or discovery.get("profiles", {}).get("haip.execution") != "1-draft.1":
        raise ConformanceError("Service does not advertise the draft execution profile")
    proposal = {"action": "counter.increment", "amount": 1}
    execution = {
        "action_occurrence_id": "python-" + secrets.token_hex(16),
        "proposal_digest": digest(proposal),
        "proposal_format": "mock-counter-v1",
        "context_digest": digest({"counter": "python-test"}),
        "context_format": "mock-context-v1",
        "policy": {"source": "operator", "revision": "1", "digest": digest({"allow": "counter.increment"})},
        "mode": "fixed_mock",
        "valid_until": _iso_after(3600),
        "execution_seconds": 60,
        "provenance": {"profile": "haip.execution", "version": "1-draft.1", "references": {"fixture": "python-sqlite-counter"}},
    }
    request = {
        "protocol_revision": PROTOCOL_REVISION,
        "purpose": "authorise_execution",
        "profiles": {"haip.execution": "1-draft.1"},
        "route": config["route"],
        "summary": "Authorise one Python SQLite counter increment",
        "artefact": {"digest": digest(proposal), "representation": "application/json", "digest_rules": "rfc8785-sha256"},
        "payload": proposal,
        "response_schema": {"type": "object", "properties": {"choice": {"enum": ["authorise", "refuse"]}}, "required": ["choice"], "additionalProperties": False},
        "review_document": "Authorise or refuse one bounded increment of the local conformance counter.",
        "execution": execution,
        "metadata": {"fixture": "python-sqlite-counter", "run": secrets.token_hex(8)},
    }
    key = secrets.token_urlsafe(24)
    created_status, created = client.call("/v2/requests", request, key)
    if created_status != 201:
        raise ConformanceError("Execution request was not created")
    if client.call("/v2/requests", request, key) != (created_status, created):
        raise ConformanceError("Execution request idempotency changed")
    created_request = _created_request(client.origin, created, request)
    return {
        "result": "ready",
        "request_id": created_request["id"],
        "review_link": created["review_link"],
        "request_digest": digest(created_request),
        "execution_binding_digest": digest(created_request["execution"]),
    }


def _same(first: Any, second: Any, error: str) -> None:
    if canonicalise(first) != canonicalise(second):
        raise ConformanceError(error)


def _verify_execution_request(config: Mapping[str, Any], request: Mapping[str, Any]) -> Mapping[str, Any]:
    execution = request.get("execution")
    fixed_proposal = {"action": "counter.increment", "amount": 1}
    if request.get("id") != config["request_id"] or request.get("protocol_revision") != PROTOCOL_REVISION or request.get("purpose") != "authorise_execution" or request.get("profiles") != {"haip.execution": "1-draft.1"} or request.get("tenant") != config["tenant"] or request.get("producer") != config["producer"] or not isinstance(execution, dict):
        raise ConformanceError("Execution request binding mismatch")
    if execution.get("proposal_digest") != digest(fixed_proposal) or execution.get("proposal_format") != "mock-counter-v1" or execution.get("context_digest") != digest({"counter": "python-test"}) or execution.get("context_format") != "mock-context-v1" or execution.get("policy") != {"source": "operator", "revision": "1", "digest": digest({"allow": "counter.increment"})} or execution.get("mode") != "fixed_mock":
        raise ConformanceError("Only the fixed Python counter binding is supported")
    if execution.get("provenance", {}).get("profile") != "haip.execution" or execution.get("provenance", {}).get("version") != "1-draft.1":
        raise ConformanceError("Unsupported execution provenance")
    return execution


def _signed_in_export(exported: Mapping[str, Any], record: Mapping[str, Any], name: str) -> None:
    if not any(digest(item) == digest(record) for item in exported.get("records", [])):
        raise ConformanceError(name + " is missing from the export")


def _verify_anchor(anchor: Mapping[str, Any], receipt: Mapping[str, Any], trust: Mapping[str, Any], config: Mapping[str, Any]) -> None:
    if not isinstance(anchor, dict) or not isinstance(anchor.get("checkpoint"), dict) or not isinstance(anchor.get("acceptance"), dict) or not isinstance(anchor.get("proof"), list) or not anchor["proof"]:
        raise ConformanceError("Missing checkpoint proof")
    checkpoint = anchor["checkpoint"]
    checkpoint_payload = checkpoint.get("payload", {})
    if not isinstance(checkpoint_payload, dict) or type(checkpoint_payload.get("sequence")) is not int or not 0 <= checkpoint_payload["sequence"] <= MAX_SAFE_INTEGER:
        raise ConformanceError("Invalid checkpoint sequence")
    verify_record(
        checkpoint,
        trust,
        {
            "issuer": config["origin"],
            "audience": "haip.audit",
            "tenant": checkpoint_payload.get("ledger_id"),
            "type": "AuditCheckpoint",
            "purpose": "service",
        },
    )
    if anchor["proof"][0].get("record_digest") != digest(receipt):
        raise ConformanceError("Checkpoint proof does not start with the receipt")
    previous = None
    sequence = None
    for node in anchor["proof"]:
        if not isinstance(node, dict) or set(node) != {"sequence", "previous_head", "record_digest", "head"} or type(node.get("sequence")) is not int or not 0 <= node["sequence"] <= MAX_SAFE_INTEGER:
            raise ConformanceError("Invalid checkpoint sequence")
        expected_head = digest({"previous": node.get("previous_head"), "sequence": node["sequence"], "record_digest": node.get("record_digest")})
        if node.get("head") != expected_head or (previous is not None and node.get("previous_head") != previous) or (sequence is not None and node["sequence"] != sequence + 1):
            raise ConformanceError("Invalid checkpoint chain")
        previous = node["head"]
        sequence = node["sequence"]
    if previous != checkpoint_payload.get("head") or sequence != checkpoint_payload.get("sequence"):
        raise ConformanceError("Checkpoint prefix mismatch")
    acceptance = anchor["acceptance"]
    checkpoint_bytes = canonicalise(checkpoint).encode("utf-8")
    if acceptance.get("digest") != digest_bytes(checkpoint_bytes):
        raise ConformanceError("Anchor acceptance digest mismatch")
    retained_until = _time(acceptance.get("retained_until"))
    if retained_until < _time(checkpoint["protected"]["issued_at"]) + timedelta(days=90):
        raise ConformanceError("Anchor retention is shorter than 90 days")
    record_path = config.get("anchor_record_path")
    if record_path is None and config.get("allow_test_filesystem_anchor") is True:
        host = urllib.parse.urlsplit(config["origin"]).hostname
        if acceptance.get("backend") != "test_filesystem" or host not in ("localhost", "127.0.0.1", "::1"):
            raise ConformanceError("Test filesystem anchoring is limited to a loopback service")
        record_path = acceptance.get("key")
        if acceptance.get("version_id") != acceptance.get("digest"):
            raise ConformanceError("Test anchor version mismatch")
    if not isinstance(record_path, str):
        raise ConformanceError("An independently obtained anchor record path is required")
    try:
        stored = Path(record_path).read_bytes()
    except OSError as error:
        raise ConformanceError("Anchor record could not be read") from error
    if stored != checkpoint_bytes:
        raise ConformanceError("Stored anchor record mismatch")


def _verify_execution_chain(
    config: Mapping[str, Any],
    exported: Mapping[str, Any],
    receipt: Mapping[str, Any],
    claim: Mapping[str, Any],
    admission: Mapping[str, Any],
    timing: Optional[Mapping[str, float]] = None,
) -> Dict[str, float]:
    request = exported.get("request")
    material = exported.get("material")
    if not isinstance(request, dict) or not isinstance(material, dict) or not isinstance(material.get("candidate"), dict):
        raise ConformanceError("Retained execution material is required")
    candidate = material["candidate"]
    execution = _verify_execution_request(config, request)
    fixed_proposal = {"action": "counter.increment", "amount": 1}
    if exported.get("request_digest") != digest(request):
        raise ConformanceError("Exported request digest mismatch")
    expected = {"issuer": config["origin"], "audience": config["producer"], "tenant": config["tenant"], "purpose": "authorise_execution"}
    for record, type_name in ((receipt, "DecisionReceipt"), (claim, "ExecutionClaim"), (admission, "AdmissionStatus")):
        verify_record(record, config["trust"], {**expected, "type": type_name})
        _same(record["protected"]["profiles"], request["profiles"], "Signed profile selection mismatch")
        _signed_in_export(exported, record, type_name)
    verify_candidate(candidate)
    _same(material.get("payload"), fixed_proposal, "Counter proposal material mismatch")
    _same(candidate.get("response"), {"choice": "authorise"}, "Counter authorisation response mismatch")
    receipt_payload = receipt["payload"]
    claim_payload = claim["payload"]
    admission_payload = admission["payload"]
    if receipt_payload.get("request_id") != request["id"] or receipt_payload.get("request_digest") != digest(request) or receipt_payload.get("purpose") != request["purpose"] or receipt_payload.get("decision") != "authorise":
        raise ConformanceError("Decision does not authorise this request")
    if receipt_payload.get("candidate_id") != candidate["id"] or receipt_payload.get("candidate_digest") != digest(candidate) or candidate.get("request_id") != request["id"] or candidate.get("request_digest") != digest(request) or candidate.get("reviewer") != receipt_payload.get("reviewer") or candidate.get("decision") != "authorise":
        raise ConformanceError("Candidate binding mismatch")
    if receipt_payload.get("requester") != request["requester"]["subject"] or receipt_payload.get("response_digest") != candidate.get("response_digest"):
        raise ConformanceError("Response binding mismatch")
    if request["review"].get("artefact_digest") != digest(fixed_proposal) or request["review"].get("representation") != "application/json" or request["review"].get("digest_rules") != "rfc8785-sha256" or digest(material.get("payload")) != request["review"]["payload_digest"] or digest(material.get("response_schema")) != request["review"]["response_schema_digest"] or digest_bytes(material.get("review_document", "").encode("utf-8")) != request["review"]["document_digest"]:
        raise ConformanceError("Retained review material mismatch")
    execution_digest = digest(execution)
    identity = config["execution_identity"]
    if claim_payload.get("request_id") != request["id"] or claim_payload.get("request_digest") != digest(request) or claim_payload.get("receipt_digest") != digest(receipt) or claim_payload.get("execution_identity") != identity or claim_payload.get("execution_binding_digest") != execution_digest or claim_payload.get("action_occurrence_id") != execution.get("action_occurrence_id"):
        raise ConformanceError("Execution claim binding mismatch")
    if admission_payload.get("claim_id") != claim_payload.get("id") or admission_payload.get("claim_digest") != digest(claim) or admission_payload.get("request_id") != request["id"] or admission_payload.get("execution_identity") != identity or admission_payload.get("execution_binding_digest") != execution_digest or admission_payload.get("dispatch_before") != claim_payload.get("dispatch_before") or admission_payload.get("dispatch_before") != receipt_payload.get("grant_deadline") or admission_payload.get("execution_seconds") != execution.get("execution_seconds"):
        raise ConformanceError("Admission binding mismatch")
    if receipt["protected"]["issued_at"] != receipt_payload.get("confirmed_at") or claim["protected"]["issued_at"] != claim_payload.get("claimed_at") or admission["protected"]["issued_at"] != admission_payload.get("checked_at"):
        raise ConformanceError("Protected timestamp mismatch")
    accepted = _time(request["accepted_at"])
    candidate_time = _time(candidate["created_at"])
    confirmed = _time(receipt_payload["confirmed_at"])
    claimed = _time(claim_payload["claimed_at"])
    checked = _time(admission_payload["checked_at"])
    dispatch = _time(admission_payload["dispatch_before"])
    if not (accepted <= candidate_time <= confirmed < _time(request["review_deadline"]) and confirmed <= claimed <= checked < dispatch <= _time(execution["valid_until"])):
        raise ConformanceError("Invalid authority timeline")
    if dispatch > confirmed + timedelta(seconds=request["limits"]["grant_seconds"]) or not 0 < admission_payload["execution_seconds"] <= request["limits"]["execution_seconds"] or claim_payload.get("execution_seconds") != admission_payload["execution_seconds"]:
        raise ConformanceError("Invalid execution bound")
    anchor = admission_payload.get("anchor")
    _same(anchor, exported.get("anchor"), "Admission anchor differs from the export")
    _verify_anchor(anchor, receipt, config["trust"], config)
    result = {"execution_seconds": float(admission_payload["execution_seconds"])}
    if timing is not None:
        elapsed_mono = timing["received_mono"] - timing["started_mono"]
        elapsed_wall = timing["received_wall"] - timing["started_wall"]
        checked_seconds = checked.timestamp()
        if elapsed_mono < 0 or abs(elapsed_mono - elapsed_wall) >= 1 or checked_seconds - timing["received_wall"] < -30 or checked_seconds - timing["started_wall"] > 30:
            raise ConformanceError("Local clock health check failed")
        result["deadline_mono"] = timing["started_mono"] + (dispatch.timestamp() - checked_seconds)
        result["started_mono"] = timing["started_mono"]
        result["started_wall"] = timing["started_wall"]
    return result


def _verify_persisted_execution_chain(
    config: Mapping[str, Any],
    evidence: Mapping[str, Any],
    saved_request_digest: str,
    saved_execution_digest: str,
) -> Mapping[str, Any]:
    """Verify signed authority retained for reporting an effect that already committed."""
    if set(evidence) != {"request", "receipt", "claim", "admission"}:
        raise ConformanceError("Invalid persisted counter evidence")
    request = evidence.get("request")
    receipt = evidence.get("receipt")
    claim = evidence.get("claim")
    admission = evidence.get("admission")
    if not all(isinstance(value, dict) for value in (request, receipt, claim, admission)):
        raise ConformanceError("Invalid persisted counter evidence")
    execution = _verify_execution_request(config, request)
    if saved_request_digest != digest(request) or saved_execution_digest != digest(execution):
        raise ConformanceError("Saved counter fence belongs to different authority")
    review = request.get("review")
    proposal_digest = digest({"action": "counter.increment", "amount": 1})
    if not isinstance(review, dict) or review.get("artefact_digest") != proposal_digest or review.get("payload_digest") != proposal_digest or review.get("representation") != "application/json" or review.get("digest_rules") != "rfc8785-sha256":
        raise ConformanceError("Persisted review commitment mismatch")
    expected = {"issuer": config["origin"], "audience": config["producer"], "tenant": config["tenant"], "purpose": "authorise_execution"}
    for record, type_name in ((receipt, "DecisionReceipt"), (claim, "ExecutionClaim"), (admission, "AdmissionStatus")):
        verify_record(record, config["trust"], {**expected, "type": type_name})
        _same(record["protected"]["profiles"], request["profiles"], "Persisted profile selection mismatch")
    receipt_payload = receipt["payload"]
    claim_payload = claim["payload"]
    admission_payload = admission["payload"]
    if receipt_payload.get("request_id") != request["id"] or receipt_payload.get("request_digest") != digest(request) or receipt_payload.get("purpose") != request["purpose"] or receipt_payload.get("decision") != "authorise" or receipt_payload.get("requester") != request["requester"]["subject"]:
        raise ConformanceError("Persisted decision does not authorise this request")
    if claim_payload.get("request_id") != request["id"] or claim_payload.get("request_digest") != digest(request) or claim_payload.get("receipt_digest") != digest(receipt) or claim_payload.get("execution_identity") != config["execution_identity"] or claim_payload.get("execution_binding_digest") != digest(execution) or claim_payload.get("action_occurrence_id") != execution.get("action_occurrence_id"):
        raise ConformanceError("Persisted execution claim binding mismatch")
    if admission_payload.get("claim_id") != claim_payload.get("id") or admission_payload.get("claim_digest") != digest(claim) or admission_payload.get("request_id") != request["id"] or admission_payload.get("execution_identity") != config["execution_identity"] or admission_payload.get("execution_binding_digest") != digest(execution) or admission_payload.get("dispatch_before") != claim_payload.get("dispatch_before") or admission_payload.get("dispatch_before") != receipt_payload.get("grant_deadline") or admission_payload.get("execution_seconds") != execution.get("execution_seconds"):
        raise ConformanceError("Persisted admission binding mismatch")
    if receipt["protected"]["issued_at"] != receipt_payload.get("confirmed_at") or claim["protected"]["issued_at"] != claim_payload.get("claimed_at") or admission["protected"]["issued_at"] != admission_payload.get("checked_at"):
        raise ConformanceError("Persisted protected timestamp mismatch")
    accepted = _time(request["accepted_at"])
    confirmed = _time(receipt_payload["confirmed_at"])
    claimed = _time(claim_payload["claimed_at"])
    checked = _time(admission_payload["checked_at"])
    dispatch = _time(admission_payload["dispatch_before"])
    if not (accepted <= confirmed < _time(request["review_deadline"]) and confirmed <= claimed <= checked < dispatch <= _time(execution["valid_until"])):
        raise ConformanceError("Invalid persisted authority timeline")
    if dispatch > confirmed + timedelta(seconds=request["limits"]["grant_seconds"]) or not 0 < admission_payload["execution_seconds"] <= request["limits"]["execution_seconds"] or claim_payload.get("execution_seconds") != admission_payload["execution_seconds"]:
        raise ConformanceError("Invalid persisted execution bound")
    _verify_anchor(admission_payload.get("anchor"), receipt, config["trust"], config)
    return claim


def _stable_key(label: str, request_id: str) -> str:
    return "python-" + label + "-" + hashlib.sha256(request_id.encode("utf-8")).hexdigest()


def _open_counter(path: str) -> sqlite3.Connection:
    database = Path(path)
    if not database.is_absolute() or not database.parent.is_dir():
        raise ConformanceError("Counter database must have an existing absolute parent directory")
    old_mask = os.umask(0o077)
    connection = None
    try:
        connection = sqlite3.connect(str(database), timeout=15, isolation_level=None)
        database.chmod(0o600)
        if connection.execute("PRAGMA journal_mode=WAL").fetchone()[0].lower() != "wal":
            raise ConformanceError("SQLite WAL mode is required")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL CHECK(value >= 0))")
        connection.execute("CREATE TABLE IF NOT EXISTS execution_fences (request_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, execution_digest TEXT NOT NULL, evidence TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('launched','completed')), result_count INTEGER, outcome_digest TEXT)")
        connection.execute("INSERT OR IGNORE INTO counters(name,value) VALUES('default',0)")
    except Exception:
        if connection is not None:
            connection.close()
        raise
    finally:
        os.umask(old_mask)
    if connection is None:
        raise ConformanceError("SQLite connection was not created")
    return connection


def _saved_fence(connection: sqlite3.Connection, request_id: str) -> Optional[Tuple[Any, ...]]:
    return connection.execute("SELECT request_digest,execution_digest,evidence,state,result_count,outcome_digest FROM execution_fences WHERE request_id=?", (request_id,)).fetchone()


def _outcome(client: HaipClient, config: Mapping[str, Any], claim: Mapping[str, Any], count: int) -> Mapping[str, Any]:
    body = {"execution_identity": config["execution_identity"], "status": "completed", "details": {"counter": count, "fixture": "python-sqlite-counter"}}
    status, record = client.call(_request_path(config["request_id"], "/outcomes"), body, _stable_key("outcome", config["request_id"]))
    if status != 200:
        raise ConformanceError("Execution outcome was not accepted")
    verify_record(record, config["trust"], {"issuer": config["origin"], "audience": config["producer"], "tenant": config["tenant"], "type": "ExecutionOutcome", "purpose": "authorise_execution"})
    payload = record.get("payload", {})
    _same(record["protected"]["profiles"], claim["protected"]["profiles"], "Outcome profile selection mismatch")
    if payload.get("request_id") != config["request_id"] or payload.get("claim_digest") != digest(claim) or payload.get("recorded_at") != record["protected"]["issued_at"] or payload.get("recorded_by") != {"kind": "producer", "subject": config["producer"]}:
        raise ConformanceError("Execution outcome binding mismatch")
    _same(payload.get("outcome"), body, "Execution outcome body mismatch")
    return record


def _check_before_dispatch(authority: Mapping[str, float]) -> None:
    current_mono = time.monotonic()
    if abs(time.time() - authority["started_wall"] - (current_mono - authority["started_mono"])) >= 1:
        raise ConformanceError("Local clock changed during admission")
    if current_mono >= authority["deadline_mono"]:
        raise ConformanceError("Admission expired before the local dispatch")


def execution_finish(config: Mapping[str, Any]) -> Dict[str, Any]:
    client = HaipClient(config["origin"], config["producer_token"])
    request_id = config["request_id"]
    execution_identity = "python-counter:" + request_id
    runtime_config = {**config, "execution_identity": execution_identity}
    request_path = _request_path(request_id)
    stop_after_effect = config.get("test_stop_after_effect_commit") is True
    if stop_after_effect and client.host not in ("localhost", "127.0.0.1", "::1"):
        raise ConformanceError("The post-effect test stop is limited to exact loopback hosts")
    connection = _open_counter(config["database"])
    try:
        saved = _saved_fence(connection, request_id)
        replay = saved is not None
        if saved is not None:
            request_digest, execution_digest, evidence_text, state, count, previous_outcome = saved
            if state != "completed" or not isinstance(count, int):
                raise ConformanceError("Incomplete counter fence requires reconciliation")
            evidence = parse_json(evidence_text)
            if not isinstance(evidence, dict):
                raise ConformanceError("Invalid persisted counter evidence")
            claim = _verify_persisted_execution_chain(runtime_config, evidence, request_digest, execution_digest)
        else:
            status_code, status = client.call(request_path)
            export_code, exported = client.call(request_path + "/export")
            if status_code != 200 or export_code != 200 or status.get("decision_state") != "confirmed" or status.get("audit_state") != "anchored":
                raise ConformanceError("Execution decision is not confirmed and anchored")
            receipt = status.get("receipt")
            request = exported.get("request", {})
            if status.get("grant_state") != "available" or not isinstance(request, dict):
                raise ConformanceError("Execution grant is unavailable")
            execution = _verify_execution_request(runtime_config, request)
            claim_input = {"execution_identity": execution_identity, "execution_binding_digest": digest(execution)}
            claim_status, claim = client.call(request_path + "/claims", claim_input, _stable_key("claim", request_id))
            if claim_status != 201:
                raise ConformanceError("Execution claim was not accepted")
            nonce = secrets.token_urlsafe(24)
            started_mono = time.monotonic()
            started_wall = time.time()
            admission_status, admission = client.call(request_path + "/admission", {"claim_id": claim["payload"]["id"], "nonce": nonce, "execution_identity": execution_identity})
            received_wall = time.time()
            received_mono = time.monotonic()
            if admission_status != 200 or admission.get("payload", {}).get("nonce") != nonce:
                raise ConformanceError("Fresh execution admission was not accepted")
            export_code, exported = client.call(request_path + "/export")
            if export_code != 200:
                raise ConformanceError("Execution export was unavailable after admission")
            authority = _verify_execution_chain(
                runtime_config,
                exported,
                receipt,
                claim,
                admission,
                {"started_mono": started_mono, "received_mono": received_mono, "started_wall": started_wall, "received_wall": received_wall},
            )
            evidence_text = canonicalise({"request": exported["request"], "receipt": receipt, "claim": claim, "admission": admission})
            connection.execute("BEGIN IMMEDIATE")
            try:
                concurrent = _saved_fence(connection, request_id)
                if concurrent is not None:
                    connection.execute("COMMIT")
                    request_digest, execution_digest, evidence_text, state, count, previous_outcome = concurrent
                    if state != "completed" or not isinstance(count, int):
                        raise ConformanceError("Concurrent counter fence requires reconciliation")
                    evidence = parse_json(evidence_text)
                    if not isinstance(evidence, dict):
                        raise ConformanceError("Invalid persisted counter evidence")
                    claim = _verify_persisted_execution_chain(runtime_config, evidence, request_digest, execution_digest)
                    replay = True
                else:
                    _check_before_dispatch(authority)
                    current = connection.execute("SELECT value FROM counters WHERE name='default'").fetchone()[0]
                    if not isinstance(current, int) or current < 0 or current >= MAX_SAFE_INTEGER:
                        raise ConformanceError("Invalid local counter state")
                    launch_mono = time.monotonic()
                    connection.execute("INSERT INTO execution_fences(request_id,request_digest,execution_digest,evidence,state) VALUES(?,?,?,?, 'launched')", (request_id, digest(exported["request"]), digest(exported["request"]["execution"]), evidence_text))
                    _check_before_dispatch(authority)
                    if time.monotonic() - launch_mono >= authority["execution_seconds"]:
                        raise ConformanceError("Execution window expired before the local effect")
                    count = current + 1
                    connection.execute("UPDATE counters SET value=? WHERE name='default'", (count,))
                    connection.execute("UPDATE execution_fences SET state='completed',result_count=? WHERE request_id=?", (count, request_id))
                    _check_before_dispatch(authority)
                    if time.monotonic() - launch_mono >= authority["execution_seconds"]:
                        raise ConformanceError("Execution window expired during the local effect")
                    connection.execute("COMMIT")
                    if stop_after_effect:
                        raise ConformanceError("Stopped after the committed counter effect for a loopback replay test")
                    previous_outcome = None
            except Exception:
                if connection.in_transaction:
                    connection.execute("ROLLBACK")
                raise
        outcome = _outcome(client, runtime_config, claim, count)
        outcome_digest = digest(outcome)
        if previous_outcome is not None and previous_outcome != outcome_digest:
            raise ConformanceError("Outcome retry returned a different signed record")
        connection.execute("UPDATE execution_fences SET outcome_digest=? WHERE request_id=?", (outcome_digest, request_id))
        final_code, final_export = client.call(request_path + "/export")
        if final_code != 200:
            raise ConformanceError("Final execution export was unavailable")
        _signed_in_export(final_export, outcome, "ExecutionOutcome")
        return {"result": "passed", "request_id": request_id, "count": count, "replayed": replay, "outcome_digest": outcome_digest}
    finally:
        connection.close()


def _read_input() -> Mapping[str, Any]:
    value = parse_json(sys.stdin.read())
    if not isinstance(value, dict):
        raise ConformanceError("Command input must be a JSON object")
    return value


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the internally authored HAIP Python conformance checks.")
    parser.add_argument("command", choices=["vectors", "digest", "review-start", "review-finish", "execution-start", "execution-finish"])
    parser.add_argument("path", nargs="?")
    args = parser.parse_args()
    if args.command == "vectors":
        path = Path(args.path) if args.path else Path(__file__).with_name("draft-3-vectors.json")
        result = verify_vectors(path)
    elif args.command == "digest":
        result = {"digest": digest(_read_input())}
    elif args.command == "review-start":
        result = review_start(_read_input())
    elif args.command == "review-finish":
        result = review_finish(_read_input())
    elif args.command == "execution-start":
        result = execution_start(_read_input())
    else:
        result = execution_finish(_read_input())
    print(canonicalise(result))


if __name__ == "__main__":
    try:
        main()
    except (ConformanceError, KeyError, TypeError) as error:
        print(canonicalise({"error": str(error)}), file=sys.stderr)
        raise SystemExit(1) from error
