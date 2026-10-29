"""Map inspected advertising fields to domain tagIds, never MAC identities."""

from dataclasses import dataclass
from datetime import datetime, timezone
import uuid


def utc_now():
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


@dataclass(frozen=True)
class Advertisement:
    name: str | None
    address: str
    rssi: int
    manufacturer_data: dict
    service_data: dict
    service_uuids: tuple[str, ...]
    timestamp: str

    @classmethod
    def from_bleak(cls, device, data, timestamp=None):
        return cls(
            data.local_name or device.name,
            device.address,
            data.rssi,
            dict(data.manufacturer_data),
            {key.lower(): value for key, value in data.service_data.items()},
            tuple(data.service_uuids),
            timestamp or utc_now(),
        )

    def diagnostic(self):
        return {
            "name": self.name,
            "address": self.address,
            "rssi": self.rssi,
            "manufacturer_data": {
                f"0x{key:04x}": value.hex()
                for key, value in self.manufacturer_data.items()
            },
            "service_data": {
                key: value.hex() for key, value in self.service_data.items()
            },
            "service_uuids": list(self.service_uuids),
            "timestamp": self.timestamp,
        }


def field_bytes(advertisement, field):
    values = (
        advertisement.manufacturer_data
        if field.source == "manufacturerData"
        else advertisement.service_data
    )
    return values.get(field.key, b"")


def matches(advertisement, tag):
    if tag.device_name is not None and advertisement.name != tag.device_name:
        return False
    return all(
        field_bytes(advertisement, field)[
            field.offset : field.offset + len(field.prefix)
        ]
        == field.prefix
        for field in tag.fields
    )


def build_observation(advertisement, config, id_factory=uuid.uuid4):
    matched = [tag for tag in config.tags if matches(advertisement, tag)]
    if not matched:
        return None
    if len(matched) != 1:
        raise ValueError(
            "Ambiguous advertisement matched multiple tagIds; refine config"
        )
    if type(advertisement.rssi) is not int or not -127 <= advertisement.rssi <= 20:
        raise ValueError("Advertisement RSSI is unavailable or outside -127..20 dBm")
    tag = matched[0]
    result = {
        "observationId": f"obs-{id_factory()}",
        "tagId": tag.tag_id,
        "readerId": config.gateway_id,
        "rssi": advertisement.rssi,
        "observedAt": advertisement.timestamp,
        "sourceType": "BLE",
    }
    if tag.sequence is not None:
        field = tag.sequence
        payload = field_bytes(advertisement, field)
        if len(payload) < field.offset + field.length:
            raise ValueError(
                "Configured device sequence bytes are absent; no sequence invented"
            )
        result["sequence"] = int.from_bytes(
            payload[field.offset : field.offset + field.length], field.byte_order
        )
    return result
