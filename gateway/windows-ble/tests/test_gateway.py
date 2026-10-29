"""Synthetic advertisements/HTTP only: PENDING PHYSICAL WINDOWS TEST."""

import asyncio
from dataclasses import replace
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

import httpx
from config import load_config, parse_config
from gateway import run_gateway, run_scan_only
from parser import Advertisement, build_observation
from scanner import scan
from transport import ObservationPublisher

SERVICE = "12345678-1234-5678-1234-567812345678"


def raw_config(**overrides):
    return {
        "gatewayId": "WIN-GW-01",
        "backendUrl": "http://backend.invalid:4173",
        "tags": [{"tagId": "TAG001", "match": {"deviceName": "INSPECTED-TAG-1"}}],
        **overrides,
    }


def bleak_data(name="INSPECTED-TAG-1", **overrides):
    return SimpleNamespace(
        local_name=name,
        rssi=-61,
        manufacturer_data={89: b"\xaa\xbb\x34\x12"},
        service_data={SERVICE: b"\x01\x02\x03"},
        service_uuids=[SERVICE],
        **overrides,
    )


def advertisement(name="INSPECTED-TAG-1", **overrides):
    value = Advertisement.from_bleak(
        SimpleNamespace(name=None, address="ROTATING-DEBUG-ADDRESS"),
        bleak_data(name),
        "2026-10-29T10:00:00.000Z",
    )
    return replace(value, **overrides)


def observation(index=1, **overrides):
    return {
        "observationId": f"obs-{index}",
        "tagId": "TAG001",
        "readerId": "WIN-GW-01",
        "rssi": -61,
        "observedAt": "2026-10-29T10:00:00.000Z",
        "sourceType": "BLE",
        **overrides,
    }


class ConfigAndParserTests(unittest.TestCase):
    def test_defaults_and_example(self):
        config = parse_config(raw_config())
        self.assertEqual(config.publish_interval_ms, 1000)
        self.assertEqual(config.retry_max_ms, 30000)
        self.assertIsNone(config.tags[0].sequence)
        example = load_config(Path(__file__).parent.parent / "config.example.json")
        self.assertEqual([t.tag_id for t in example.tags], ["TAG001", "TAG002"])
        self.assertIsNone(build_observation(advertisement(), example))

    def test_invalid_config_rejected_before_scanning(self):
        for fields in [
            {"backendUrl": "ws://backend.invalid"},
            {"backendUrl": "http://user:secret@backend.invalid"},
            {"backendUrl": "http://backend.invalid/api"},
            {"backendUrl": "http://backend.invalid:bad"},
            {"gatewayId": ""},
            {"publishIntervalMs": 0},
            {"publishIntervalMs": True},
            {"httpTimeoutSeconds": 0},
            {"retryInitialMs": 2000, "retryMaxMs": 1000},
            {"tags": []},
            {"tags": [{"tagId": "TAG001", "match": {}}]},
            {"tags": [{"tagId": "TAG001", "match": {"address": "MAC"}}]},
            {
                "tags": [
                    {
                        "tagId": "TAG001",
                        "match": {
                            "manufacturerData": {"companyId": 89, "hexPrefix": ""}
                        },
                    }
                ]
            },
            {
                "tags": [
                    {
                        "tagId": "TAG001",
                        "match": {
                            "serviceData": {"serviceUuid": "invalid", "hexPrefix": "01"}
                        },
                    }
                ]
            },
        ]:
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                parse_config(raw_config(**fields))
        with self.assertRaises(ValueError):
            parse_config(
                raw_config(tags=[raw_config()["tags"][0], raw_config()["tags"][0]])
            )

    def test_name_mapping_builds_domain_identity_not_mac(self):
        config = parse_config(raw_config())
        result = build_observation(
            advertisement(), config, id_factory=lambda: "unique-id"
        )
        self.assertEqual(result, observation("unique-id"))
        rotated = build_observation(
            advertisement(address="DIFFERENT-PRIVATE-ADDRESS", rssi=-88), config
        )
        self.assertEqual(rotated["tagId"], "TAG001")
        self.assertNotIn("address", rotated)
        self.assertNotIn("sequence", rotated)
        self.assertNotIn("position", rotated)
        self.assertNotIn("operationalStatus", rotated)
        self.assertIsNone(build_observation(advertisement(name="UNKNOWN"), config))

    def test_manufacturer_and_service_matching_use_real_bytes_and_offsets(self):
        for match in [
            {
                "manufacturerData": {
                    "companyId": "0x0059",
                    "offset": 1,
                    "hexPrefix": "bb34",
                }
            },
            {
                "serviceData": {
                    "serviceUuid": SERVICE.upper(),
                    "offset": 1,
                    "hexPrefix": "0203",
                }
            },
            {
                "deviceName": "INSPECTED-TAG-1",
                "manufacturerData": {"companyId": 89, "hexPrefix": "aabb"},
                "serviceData": {"serviceUuid": SERVICE, "hexPrefix": "01"},
            },
        ]:
            with self.subTest(match=match):
                config = parse_config(
                    raw_config(tags=[{"tagId": "TAG001", "match": match}])
                )
                self.assertEqual(
                    build_observation(advertisement(), config)["tagId"], "TAG001"
                )
                self.assertIsNone(
                    build_observation(
                        advertisement(manufacturer_data={}, service_data={}), config
                    )
                )

    def test_sequence_is_decoded_only_when_explicitly_configured(self):
        tag = {
            **raw_config()["tags"][0],
            "sequence": {
                "source": "manufacturerData",
                "companyId": 89,
                "offset": 2,
                "length": 2,
                "byteOrder": "little",
            },
        }
        config = parse_config(raw_config(tags=[tag]))
        self.assertEqual(build_observation(advertisement(), config)["sequence"], 0x1234)
        with self.assertRaises(ValueError):
            build_observation(advertisement(manufacturer_data={}), config)
        tag["sequence"] = {
            "source": "serviceData",
            "serviceUuid": SERVICE,
            "offset": 0,
            "length": 2,
            "byteOrder": "big",
        }
        config = parse_config(raw_config(tags=[tag]))
        self.assertEqual(build_observation(advertisement(), config)["sequence"], 0x0102)

    def test_ambiguous_matches_and_unavailable_rssi_are_not_published(self):
        config = parse_config(
            raw_config(
                tags=[
                    raw_config()["tags"][0],
                    {
                        "tagId": "TAG002",
                        "match": {
                            "manufacturerData": {"companyId": 89, "hexPrefix": "aa"}
                        },
                    },
                ]
            )
        )
        with self.assertRaisesRegex(ValueError, "Ambiguous"):
            build_observation(advertisement(), config)
        with self.assertRaises(ValueError):
            build_observation(advertisement(rssi=127), parse_config(raw_config()))

    def test_scan_diagnostic_contains_raw_data_and_timestamp(self):
        diagnostic = advertisement().diagnostic()
        self.assertEqual(diagnostic["manufacturer_data"]["0x0059"], "aabb3412")
        self.assertEqual(diagnostic["service_data"][SERVICE], "010203")
        self.assertEqual(diagnostic["service_uuids"], [SERVICE])
        self.assertEqual(diagnostic["rssi"], -61)
        self.assertEqual(diagnostic["timestamp"], "2026-10-29T10:00:00.000Z")


class PublisherTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.clock = 0.0
        self.config = parse_config(raw_config())

    def publisher(self, client, config=None):
        return ObservationPublisher(
            config or self.config, client, clock=lambda: self.clock
        )

    async def test_coalescing_and_per_tag_throttle_keep_latest_rssi(self):
        sent = []

        def handler(request):
            sent.append(json.loads(request.content))
            return httpx.Response(200, json={"accepted": True, "uldId": "AKE12345CI"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            publisher = self.publisher(client)
            publisher.offer(observation(1))
            publisher.offer(observation(2, rssi=-72))
            await publisher.flush_due()
            self.assertEqual([item["observationId"] for item in sent], ["obs-2"])
            for i in range(3, 10):
                publisher.offer(observation(i, rssi=-i))
            self.clock = 0.999
            await publisher.flush_due()
            self.assertEqual(len(sent), 1)
            self.clock = 1.0
            await publisher.flush_due()
            self.assertEqual(sent[-1]["observationId"], "obs-9")
            self.assertEqual(sent[-1]["rssi"], -9)
            self.assertEqual(len(publisher.pending), 0)
            self.assertFalse(publisher.offer(observation(tagId="UNKNOWN")))

    async def test_tags_have_independent_throttle_and_bounded_pending(self):
        config = parse_config(
            raw_config(
                tags=[
                    *raw_config()["tags"],
                    {"tagId": "TAG002", "match": {"deviceName": "SECOND"}},
                ]
            )
        )
        sent = []

        def handler(request):
            sent.append(json.loads(request.content))
            return httpx.Response(200, json={"accepted": True})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            publisher = self.publisher(client, config)
            for i in range(1000):
                publisher.offer(observation(i))
                publisher.offer(observation(i, tagId="TAG002"))
            self.assertEqual(len(publisher.pending), 2)
            await publisher.flush_due()
            self.assertEqual(len(sent), 2)

    async def test_timeout_backoff_and_recovery_never_crash_or_busy_loop(self):
        calls = []

        def handler(request):
            calls.append(json.loads(request.content))
            if len(calls) <= 2:
                raise httpx.ReadTimeout("fixture timeout", request=request)
            return httpx.Response(200, json={"accepted": True})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            publisher = self.publisher(client)
            publisher.offer(observation())
            with self.assertLogs("uld.gateway", level="WARNING"):
                await publisher.flush_due()
            self.assertEqual(publisher.next_retry, 1)
            self.clock = 0.5
            await publisher.flush_due()
            self.assertEqual(len(calls), 1)
            self.clock = 1
            with self.assertLogs("uld.gateway", level="WARNING"):
                await publisher.flush_due()
            self.assertEqual(
                calls[0]["observationId"],
                calls[1]["observationId"],
                "retry must preserve ID",
            )
            self.assertEqual(publisher.next_retry, 3)
            publisher.offer(observation(2))
            self.clock = 2
            await publisher.flush_due()
            self.assertEqual(len(calls), 2)
            self.clock = 3
            await publisher.flush_due()
            self.assertEqual(calls[-1]["observationId"], "obs-2")
            self.assertEqual(publisher.pending, {})
            self.assertEqual(publisher.failures, 0)

    async def test_backoff_is_capped(self):
        def handler(request):
            return httpx.Response(503)

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            publisher = self.publisher(client)
            publisher.offer(observation())
            delays = []
            with self.assertLogs("uld.gateway", level="WARNING"):
                for _ in range(8):
                    await publisher.flush_due()
                    delays.append(publisher.next_retry - self.clock)
                    self.clock = publisher.next_retry
            self.assertEqual(delays, [1, 2, 4, 8, 16, 30, 30, 30])

    async def test_transient_http_status_and_invalid_ack_retry_the_same_observation(
        self,
    ):
        for status in (408, 429, 500, 503, 200):
            with self.subTest(status=status):
                sent = []
                self.clock = 0.0

                def handler(request):
                    sent.append(json.loads(request.content))
                    if len(sent) == 1:
                        return httpx.Response(status, json={"accepted": False})
                    return httpx.Response(200, json={"accepted": True})

                async with httpx.AsyncClient(
                    transport=httpx.MockTransport(handler)
                ) as client:
                    publisher = self.publisher(client)
                    publisher.offer(observation())
                    with self.assertLogs("uld.gateway", level="WARNING"):
                        await publisher.flush_due()
                    self.assertEqual(len(publisher.pending), 1)
                    self.clock = 1.0
                    await publisher.flush_due()
                    self.assertEqual(sent[0]["observationId"], sent[1]["observationId"])
                    self.assertEqual(publisher.pending, {})

    async def test_new_advertisement_during_successful_post_is_retained(self):
        async def handler(request):
            publisher.offer(observation(2))
            return httpx.Response(200, json={"accepted": True})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            publisher = self.publisher(client)
            publisher.offer(observation())
            await publisher.flush_due()
            self.assertEqual(publisher.pending["TAG001"]["observationId"], "obs-2")

    async def test_real_total_timeout_even_when_transport_does_not_enforce_it(self):
        async def handler(request):
            await asyncio.sleep(1)
            return httpx.Response(200, json={"accepted": True})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            publisher = self.publisher(
                client, parse_config(raw_config(httpTimeoutSeconds=0.1))
            )
            publisher.offer(observation())
            with self.assertLogs("uld.gateway", level="WARNING"):
                await asyncio.wait_for(publisher.flush_due(), timeout=0.5)
            self.assertEqual(len(publisher.pending), 1)

    async def test_permanent_rejection_drops_bad_data_and_unmapped_success_is_not_retried(
        self,
    ):
        for status, body in [(400, {}), (200, {"accepted": True, "mapped": False})]:
            async with httpx.AsyncClient(
                transport=httpx.MockTransport(
                    lambda req: httpx.Response(status, json=body)
                )
            ) as client:
                publisher = self.publisher(client)
                publisher.offer(observation())
                with self.assertLogs("uld.gateway", level="WARNING"):
                    await publisher.flush_due()
                self.assertEqual(publisher.pending, {})

    async def test_idle_shutdown_releases_pending_buffer(self):
        stop = asyncio.Event()
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda req: httpx.Response(503))
        ) as client:
            publisher = self.publisher(client)
            stop.set()
            publisher.offer(observation())
            await publisher.run(stop)
            self.assertEqual(publisher.pending, {})


class LifetimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_bleak_advertisement_data_api_is_supported_without_scanning(
        self,
    ):
        from bleak.backends.device import BLEDevice
        from bleak.backends.scanner import AdvertisementData

        device = BLEDevice("DEBUG-ADDRESS", "CACHED-NAME", {})
        data = AdvertisementData(
            local_name="INSPECTED-TAG-1",
            manufacturer_data={89: b"\xaa\xbb"},
            service_data={},
            service_uuids=[],
            tx_power=None,
            rssi=-61,
            platform_data=(),
        )
        result = build_observation(
            Advertisement.from_bleak(device, data), parse_config(raw_config())
        )
        self.assertEqual(result["tagId"], "TAG001")
        self.assertEqual(result["rssi"], -61)
        self.assertNotIn("sequence", result)

    async def test_scanner_failure_cancels_other_tasks_and_closes_http_client(self):
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda req: httpx.Response(200))
        )

        async def failing_scanner(callback, stop_event):
            raise RuntimeError("fixture BLE adapter unavailable")

        with self.assertRaises(ExceptionGroup) as caught:
            await run_gateway(
                parse_config(raw_config()),
                asyncio.Event(),
                scanner_runner=failing_scanner,
                client_factory=lambda: client,
            )
        self.assertIsInstance(caught.exception.exceptions[0], RuntimeError)
        self.assertTrue(client.is_closed)

    async def test_scan_only_prints_actual_fields_without_http(self):
        output, stop = [], asyncio.Event()

        async def scanning(callback, stop_event):
            callback(SimpleNamespace(name=None, address="DEBUG-ONLY"), bleak_data())
            stop_event.set()

        await run_scan_only(stop, scanner_runner=scanning, emit=output.append)
        value = json.loads(output[0])
        self.assertEqual(
            set(value),
            {
                "name",
                "address",
                "rssi",
                "manufacturer_data",
                "service_data",
                "service_uuids",
                "timestamp",
            },
        )
        self.assertEqual(value["name"], "INSPECTED-TAG-1")
        self.assertEqual(value["address"], "DEBUG-ONLY")

    async def test_scanner_context_cleans_up_on_cancellation(self):
        entered, exited = asyncio.Event(), asyncio.Event()

        class FakeScanner:
            def __init__(self, detection_callback):
                self.callback = detection_callback

            async def __aenter__(self):
                entered.set()
                return self

            async def __aexit__(self, *args):
                exited.set()

        task = asyncio.create_task(
            scan(lambda *_: None, asyncio.Event(), scanner_factory=FakeScanner)
        )
        await entered.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(exited.is_set())

    async def test_gateway_publishes_then_shuts_down_scanner_and_http_client(self):
        posted, cleaned, stop = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def handler(request):
            body = json.loads(request.content)
            self.assertEqual(body["tagId"], "TAG001")
            self.assertEqual(body["sourceType"], "BLE")
            posted.set()
            return httpx.Response(200, json={"accepted": True, "mapped": True})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

        async def scanning(callback, stop_event):
            try:
                callback(
                    SimpleNamespace(name=None, address="DEBUG"), bleak_data("UNKNOWN")
                )
                callback(SimpleNamespace(name=None, address="DEBUG"), bleak_data())
                await asyncio.wait_for(posted.wait(), timeout=1)
                stop_event.set()
            finally:
                cleaned.set()

        await run_gateway(
            parse_config(raw_config()),
            stop,
            scanner_runner=scanning,
            client_factory=lambda: client,
        )
        self.assertTrue(cleaned.is_set())
        self.assertTrue(client.is_closed)

    async def test_cancellation_closes_http_client_and_scanner_without_flushing_backlog(
        self,
    ):
        started, cleaned = asyncio.Event(), asyncio.Event()
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda req: httpx.Response(200, json={"accepted": True})
            )
        )

        async def scanning(callback, stop_event):
            try:
                started.set()
                await stop_event.wait()
            finally:
                cleaned.set()

        task = asyncio.create_task(
            run_gateway(
                parse_config(raw_config()),
                asyncio.Event(),
                scanner_runner=scanning,
                client_factory=lambda: client,
            )
        )
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(cleaned.is_set())
        self.assertTrue(client.is_closed)


if __name__ == "__main__":
    unittest.main()
