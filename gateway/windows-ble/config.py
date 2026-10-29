"""Explicit tag identity configuration; no firmware payload is assumed."""

from dataclasses import dataclass
import json
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID


def text(value, field):
    if not isinstance(value, str) or not value.strip() or len(value) > 200:
        raise ValueError(f"{field} must be non-empty text (max 200)")
    return value.strip()


def integer(value, field, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{field} must be an integer from {minimum} to {maximum}")
    return value


def object_keys(raw, allowed, field):
    if not isinstance(raw, dict) or set(raw) - set(allowed):
        raise ValueError(f"Invalid {field} fields")


def company_id(value):
    if isinstance(value, str):
        try:
            value = int(value, 16 if value.lower().startswith("0x") else 10)
        except ValueError as error:
            raise ValueError("Invalid companyId") from error
    return integer(value, "companyId", 0, 65535)


def service_uuid(value):
    return str(UUID(text(value, "serviceUuid")))


@dataclass(frozen=True)
class DataField:
    source: str
    key: int | str
    offset: int
    prefix: bytes = b""
    length: int = 0
    byte_order: str = "little"


def data_field(raw, source, sequence=False):
    key_name = "companyId" if source == "manufacturerData" else "serviceUuid"
    allowed = (
        {key_name, "offset", "length", "byteOrder"}
        if sequence
        else {key_name, "offset", "hexPrefix"}
    )
    object_keys(raw, allowed, source)
    key = (
        company_id(raw.get(key_name))
        if source == "manufacturerData"
        else service_uuid(raw.get(key_name))
    )
    offset = integer(raw.get("offset", 0), "offset", 0, 255)
    if sequence:
        length = integer(raw.get("length"), "length", 1, 6)
        byte_order = raw.get("byteOrder", "little")
        if byte_order not in ("little", "big"):
            raise ValueError("byteOrder must be little or big")
        return DataField(source, key, offset, length=length, byte_order=byte_order)
    hex_prefix = text(raw.get("hexPrefix"), "hexPrefix")
    try:
        prefix = bytes.fromhex(hex_prefix)
    except ValueError as error:
        raise ValueError("hexPrefix must contain hexadecimal bytes") from error
    if not prefix or len(prefix) > 255:
        raise ValueError("hexPrefix must contain 1..255 bytes")
    return DataField(source, key, offset, prefix=prefix)


@dataclass(frozen=True)
class TagConfig:
    tag_id: str
    device_name: str | None
    fields: tuple[DataField, ...]
    sequence: DataField | None = None


@dataclass(frozen=True)
class GatewayConfig:
    gateway_id: str
    backend_url: str
    tags: tuple[TagConfig, ...]
    publish_interval_ms: int = 1000
    http_timeout_seconds: float = 5
    retry_initial_ms: int = 1000
    retry_max_ms: int = 30000


def parse_config(raw):
    object_keys(
        raw,
        {
            "gatewayId",
            "backendUrl",
            "tags",
            "publishIntervalMs",
            "httpTimeoutSeconds",
            "retryInitialMs",
            "retryMaxMs",
        },
        "config",
    )
    gateway_id = text(raw.get("gatewayId"), "gatewayId")
    backend_url = text(raw.get("backendUrl"), "backendUrl").rstrip("/")
    url = urlsplit(backend_url)
    if (
        url.scheme not in ("http", "https")
        or not url.hostname
        or url.username
        or url.password
        or url.path
        or url.query
        or url.fragment
    ):
        raise ValueError(
            "backendUrl must be an HTTP(S) origin without credentials, path or query"
        )
    # Accessing port also rejects malformed/non-numeric ports before scanning.
    if url.port is not None and not 1 <= url.port <= 65535:
        raise ValueError("Invalid backend port")
    publish = integer(
        raw.get("publishIntervalMs", 1000), "publishIntervalMs", 100, 3600000
    )
    retry_initial = integer(
        raw.get("retryInitialMs", 1000), "retryInitialMs", 100, 60000
    )
    retry_max = integer(
        raw.get("retryMaxMs", 30000), "retryMaxMs", retry_initial, 60000
    )
    timeout = raw.get("httpTimeoutSeconds", 5)
    if type(timeout) not in (float, int) or not 0.1 <= timeout <= 60:
        raise ValueError("httpTimeoutSeconds must be from 0.1 to 60")
    items = raw.get("tags")
    if not isinstance(items, list) or not 1 <= len(items) <= 128:
        raise ValueError("tags must contain 1..128 configured tags")
    tags, ids, rules = [], set(), set()
    for item in items:
        object_keys(item, {"tagId", "match", "sequence"}, "tag")
        tag_id = text(item.get("tagId"), "tagId")
        match = item.get("match")
        object_keys(match, {"deviceName", "manufacturerData", "serviceData"}, "match")
        if not match:
            raise ValueError("An empty match would identify every device")
        name = (
            text(match["deviceName"], "deviceName") if "deviceName" in match else None
        )
        fields = tuple(
            data_field(match[source], source)
            for source in ("manufacturerData", "serviceData")
            if source in match
        )
        sequence = None
        if "sequence" in item:
            seq = dict(item["sequence"]) if isinstance(item["sequence"], dict) else {}
            source = seq.pop("source", None)
            if source not in ("manufacturerData", "serviceData"):
                raise ValueError(
                    "sequence source must name an actual advertising data field"
                )
            sequence = data_field(seq, source, sequence=True)
        rule = (name, fields)
        if tag_id in ids or rule in rules:
            raise ValueError("Duplicate tagId or identical identity match")
        ids.add(tag_id)
        rules.add(rule)
        tags.append(TagConfig(tag_id, name, fields, sequence))
    return GatewayConfig(
        gateway_id, backend_url, tuple(tags), publish, timeout, retry_initial, retry_max
    )


def load_config(path):
    return parse_config(json.loads(Path(path).read_text(encoding="utf-8-sig")))
